// mcpServer.ts — the 5 tools, English descriptions, Arabic results (spec 7.x).
// A fresh McpServer is created per request (serverless stateless mode).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runGeneration, refreshTask, type ProgressCb } from "./orchestrator";
import { runMerge, validateMergeInputs, MERGE_NEEDS_TWO, MERGE_MAX_TEN } from "./merger";
import { listRecentTasks, getTask, type DbTask } from "./tasks";
import { sanitizeForClient } from "./sanitize";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";

export const SERVER_INFO = { name: "media-generator-mcp", version: "2.0.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

export const KNOWN_TOOLS = ["generate_image", "generate_video", "merge_videos", "get_task", "list_media"] as const;

export const UNKNOWN_TOOL_MSG = (name: string) =>
  `❌ أداة غير معروفة: ${name}. المتاح: ${KNOWN_TOOLS.join(", ")}`;

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// Progress notifications (best-effort): only when the client supplied a token.
function makeProgressSender(extra: Extra): ProgressCb | undefined {
  const meta = (extra as unknown as { _meta?: { progressToken?: string | number } })._meta;
  const token = meta?.progressToken;
  if (token === undefined) return undefined;
  return async (progress, total, message) => {
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total, message },
      } as unknown as ServerNotification);
    } catch {
      /* notifications are best-effort; polling always works */
    }
  };
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

function fmtRunning(taskId: string): string {
  return `⏳ المهمة قيد المعالجة — task_id: ${taskId}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

function fmtTaskResult(task: DbTask, opts?: { merge?: boolean }): string {
  if (task.status === "completed") {
    const urls = task.resultUrls || [];
    if (task.type === "image") {
      const url = urls[0] || "";
      return `✅ تم توليد الصورة بنجاح\n![image](${url})\nالرابط المباشر: ${url}`;
    }
    if (task.type === "merge") {
      const links = urls.map((u) => `- ${u}`).join("\n");
      return `✅ تم دمج المقاطع بنجاح\n${links}\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
    }
    const links = urls.map((u) => `- ${u}`).join("\n");
    return `✅ تم توليد الفيديو بنجاح\nالروابط:\n${links}`;
  }
  if (task.status === "failed") {
    const internal = task.errorMessage || "";
    const reason = internal.startsWith("internal:")
      ? sanitizeForClient(internal.slice("internal:".length).trim())
      : sanitizeForClient(internal);
    const suffix = opts?.merge ? "\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا." : "";
    return `❌ فشلت المهمة: ${reason}${suffix}`;
  }
  return fmtRunning(task.id);
}

function fmtTaskListItem(task: DbTask): string {
  const status =
    task.status === "completed" ? "✅" : task.status === "failed" ? "❌" : "⏳";
  const urls = task.resultUrls && task.resultUrls.length ? ` — ${task.resultUrls[0]}` : "";
  const when = (task.completedAt || task.createdAt || "").slice(0, 19).replace("T", " ");
  return `- ${status} [${task.type}] ${task.model}${urls} (${when} UTC)`;
}

export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active keys). Returns the image URL if finished within the wait window; otherwise returns a task_id; call get_task every ~10 s until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const onProgress = makeProgressSender(extra);
      const res = await runGeneration({
        type: "image",
        model: args.model,
        params: {
          prompt: args.prompt,
          aspect_ratio: args.aspect_ratio,
          resolution: args.resolution,
          background: args.background,
          output_format: args.output_format,
        },
        waitSeconds: args.wait_seconds,
        onProgress,
      });
      if (!res.taskId && res.error) return textResult(res.error, true);
      if (res.status === "completed") {
        const task = await getTask(res.taskId);
        return textResult(task ? fmtTaskResult(task) : "✅ تم توليد الصورة بنجاح", false);
      }
      if (res.status === "failed") return textResult(`❌ فشلت المهمة: ${res.error || sanitizeForClient(null)}`, true);
      return textResult(fmtRunning(res.taskId));
    }
  );

  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synced audio; optional image-to-video). Videos take minutes: short wait with live progress, then a task_id; follow with get_task every ~10 s until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL used as the first frame (image-to-video)."),
        model: z.enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"]).default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const onProgress = makeProgressSender(extra);
      const res = await runGeneration({
        type: "video",
        model: args.model,
        params: {
          prompt: args.prompt,
          image_url: args.image_url,
          aspect_ratio: args.aspect_ratio,
          resolution: args.resolution,
          enable_audio: args.enable_audio,
          duration: args.duration,
        },
        waitSeconds: args.wait_seconds,
        onProgress,
      });
      if (!res.taskId && res.error) return textResult(res.error, true);
      if (res.status === "completed") {
        const task = await getTask(res.taskId);
        return textResult(task ? fmtTaskResult(task) : "✅ تم توليد الفيديو بنجاح", false);
      }
      if (res.status === "failed") return textResult(`❌ فشلت المهمة: ${res.error || sanitizeForClient(null)}`, true);
      return textResult(fmtRunning(res.taskId));
    }
  );

  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Merge several clips into ONE final video, in the given order. Pass urls (public direct video links, e.g. from generate_video) or task_ids (COMPLETED video tasks, resolved from the database in order). Merging is usually fast: short wait with progress, then a task_id to follow via get_task. IMPORTANT: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z.array(z.string())
          .min(2, MERGE_NEEDS_TWO)
          .max(10, MERGE_MAX_TEN)
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z.array(z.string())
          .min(2, MERGE_NEEDS_TWO)
          .max(10, MERGE_MAX_TEN)
          .optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks, merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      const onProgress = makeProgressSender(extra);
      const directUrls = (args.urls || []).map((u) => String(u).trim()).filter(Boolean);
      // Order: resolved task_ids first, then direct urls, each in given order.
      const resolved: string[] = [];
      const failedIds: Array<{ id: string; reason: string }> = [];
      for (const tid of args.task_ids || []) {
        const t = await getTask(String(tid).trim());
        if (!t) failedIds.push({ id: tid, reason: "المهمة غير موجودة" });
        else if (t.type !== "video") failedIds.push({ id: tid, reason: "المهمة ليست مهمة فيديو" });
        else if (t.status !== "completed" || !t.resultUrls?.length) failedIds.push({ id: tid, reason: "المهمة غير مكتملة بعد — تابعها بـ get_task أولًا" });
        else resolved.push(t.resultUrls[0]);
      }
      if (failedIds.length) {
        const details = failedIds.map((f) => `- ${f.id}: ${f.reason}`).join("\n");
        return textResult(`❌ تعذر ترتيب المقاطع المطلوبة:\n${details}\n\n${MERGE_NEEDS_TWO}`, true);
      }
      const all = [...resolved, ...directUrls];
      if (all.length < 2) return textResult(MERGE_NEEDS_TWO, true);
      if (all.length > 10) return textResult(MERGE_MAX_TEN, true);
      const invalid = validateMergeInputs(all);
      if (invalid) return textResult(invalid, true);

      const res = await runMerge({ urls: all, waitSeconds: args.wait_seconds, onProgress });
      if (!res.taskId && res.error) return textResult(res.error, true);
      if (res.status === "completed") {
        const task = await getTask(res.taskId);
        return textResult(task ? fmtTaskResult(task, { merge: true }) : "✅ تم دمج المقاطع بنجاح", false);
      }
      if (res.status === "failed") return textResult(`❌ فشلت المهمة: ${res.error || sanitizeForClient(null)}`, true);
      return textResult(fmtRunning(res.taskId));
    }
  );

  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task (image, video, merge) by id; refreshes live from the provider/merger if still running. Poll every ~10 s; at completed show the result URLs and stop polling.",
      inputSchema: {
        task_id: z.string().describe("The task_id returned by a generation tool."),
      },
    },
    async (args) => {
      const task = await refreshTask(String(args.task_id).trim());
      if (!task) {
        return textResult(`❌ لا توجد مهمة بهذا المعرف: ${args.task_id}`, true);
      }
      return textResult(fmtTaskResult(task, { merge: task.type === "merge" }), task.status === "failed");
    }
  );

  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "List the latest stored images/videos/merges with URLs, newest first, no regeneration.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const tasks = await listRecentTasks(args.limit, {
        type: args.type,
        status: args.status,
      });
      if (!tasks.length) {
        return textResult("لا توجد وسائط محفوظة بعد. استخدم generate_image أو generate_video أولًا.");
      }
      const body = tasks.map(fmtTaskListItem).join("\n");
      return textResult(`أحدث الوسائط (${tasks.length}):\n${body}`);
    }
  );

  return server;
}
