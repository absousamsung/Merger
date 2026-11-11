// merger.ts — client for the Phase 1 merge service + merge task orchestration.
// Output: MP4 (H.264+AAC) up to 1080p CRF 18; NO resolution/fps parameters.
// Limits: 10 clips, 200 MB/source, 150 MB output, 600 s total; files auto-delete
// after 24 h — result text must always carry that warning.
import { nowIso } from "./turso";
import { fetchJson } from "./providers/types";
import { acquireLease, getTask, insertTask, updateTask, type DbTask } from "./tasks";
import { MERGER_MODEL } from "./models";
import { sanitizeForClient } from "./sanitize";
import type { GenResult, ProgressCb } from "./orchestrator";

function base(): string {
  return (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");
}
function publicBase(): string {
  const pb = (process.env.MERGER_PUBLIC_BASE || "").replace(/\/+$/, "");
  return pb || base();
}
export function mergerConfigured(): boolean {
  return !!base();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const DONE_RE = /done|completed|complete|success|succeeded|finished/i;
const FAILED_RE = /error|failed|failure|cancelled|canceled/i;

// Defensive status parsing: tolerant status strings, fraction progress, and
// result-link priority videoUrl -> downloadUrl -> /api/jobs/{id}/video.
export interface MergeStatus {
  state: "done" | "failed" | "processing" | "unknown";
  progress: number;
  videoUrl?: string;
  error?: string;
  size?: number;
  duration?: number;
  resolution?: string;
}

function parseJobStatus(jobId: string, payload: Record<string, unknown>): MergeStatus {
  const rawStatus = String(payload.status || "");
  let progress = Number(payload.progress);
  if (!Number.isFinite(progress)) progress = 0;
  if (progress > 0 && progress <= 1) progress = Math.round(progress * 100);
  progress = Math.max(0, Math.min(100, Math.round(progress)));
  const error = payload.error ? String(payload.error) : undefined;
  const hasErrorBody = Boolean(payload.error) && !rawStatus;

  let state: MergeStatus["state"] = "unknown";
  if (DONE_RE.test(rawStatus)) state = "done";
  else if (FAILED_RE.test(rawStatus) || hasErrorBody) state = "failed";
  else if (/queued|processing|uploading|pending|running|working/i.test(rawStatus)) state = "processing";

  const videoUrl =
    (typeof payload.videoUrl === "string" && payload.videoUrl) ||
    (typeof payload.downloadUrl === "string" && payload.downloadUrl) ||
    `${publicBase()}/api/jobs/${jobId}/video`;

  return {
    state,
    progress,
    videoUrl,
    error,
    size: Number(payload.size) || undefined,
    duration: Number(payload.duration) || undefined,
    resolution: payload.resolution ? String(payload.resolution) : undefined,
  };
}

async function createMergeJob(urls: string[]): Promise<{ jobId: string }> {
  const { httpStatus, body } = await fetchJson(
    `${base()}/api/jobs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: urls }),
    },
    20000
  );
  const b = (body && typeof body === "object" ? body : {}) as { jobId?: string; error?: string };
  if (httpStatus < 200 || httpStatus >= 300 || !b.jobId) {
    // A failure the service itself declared is deterministic: do not retry.
    throw new Error(b.error || `merge service create failed (HTTP ${httpStatus})`);
  }
  return { jobId: b.jobId };
}

async function postProcess(jobId: string): Promise<{ declared: boolean; error?: string }> {
  const { httpStatus, body } = await fetchJson(
    `${base()}/api/jobs/${encodeURIComponent(jobId)}/process`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    280000
  );
  const b = (body && typeof body === "object" ? body : {}) as { status?: string; error?: string };
  if (httpStatus >= 400) {
    return { declared: true, error: b.error || `process failed (HTTP ${httpStatus})` };
  }
  return { declared: b.status === "done", error: b.status === "failed" ? b.error : undefined };
}

async function getMergeStatus(jobId: string): Promise<MergeStatus> {
  const { httpStatus, body } = await fetchJson(
    `${base()}/api/jobs/${encodeURIComponent(jobId)}`,
    { method: "GET", headers: { "Content-Type": "application/json" } },
    15000
  );
  if (httpStatus === 404) {
    const err = new Error("MERGER_JOB_NOT_FOUND");
    (err as Error & { merger404?: boolean }).merger404 = true;
    throw err;
  }
  if (httpStatus >= 500) {
    // Our own network/transport trouble at the merger is temporary: keep polling.
    throw new Error(`merge status HTTP ${httpStatus}`);
  }
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return parseJobStatus(jobId, b);
}

export function mergerHealthy(): Promise<boolean> {
  return (async () => {
    if (!base()) return false;
    try {
      const { httpStatus } = await fetchJson(`${base()}/api/config`, { method: "GET" }, 4000);
      return httpStatus === 200;
    } catch {
      return false;
    }
  })();
}

// Fire process exactly once per job: DB lease + attempts journal + in-memory set.
const inFlightProcess = new Set<string>();
async function fireProcessOnce(taskId: string, jobId: string, holdsLease = false): Promise<void> {
  if (inFlightProcess.has(jobId)) return;
  const task = await getTask(taskId);
  if (task?.attempts.some((a) => a.action === "merge-process-fired")) return;
  if (!holdsLease && !(await acquireLease(taskId, 20))) return;
  inFlightProcess.add(jobId);
  void (async () => {
    try {
      const res = await postProcess(jobId);
      // Any HTTP response (success or declared failure) counts as "ran exactly once".
      await updateTask(taskId, {
        appendAttempt: { action: "merge-process-fired", ok: res.declared, error: res.error, at: nowIso() },
      });
    } catch {
      // Network-level failure: NOT recorded, so a later refresh may re-fire safely.
    } finally {
      inFlightProcess.delete(jobId);
    }
  })();
}

export async function runMerge(opts: { urls: string[]; waitSeconds: number; onProgress?: ProgressCb }): Promise<GenResult> {
  if (!mergerConfigured()) {
    return { taskId: "", status: "failed", error: "خدمة الدمج غير مهيأة — MERGER_API_BASE غير مضبوط على السيرفر" };
  }
  const task = await insertTask({ type: "merge", model: MERGER_MODEL, prompt: "", params: { urls: opts.urls } });
  const taskId = task.id;
  try {
    const job = await createMergeJob(opts.urls);
    await updateTask(taskId, { provider: "merger", providerTaskId: job.jobId });
    void fireProcessOnce(taskId, job.jobId);
    return await mergeWaitWindow(taskId, job.jobId, opts.waitSeconds, opts.onProgress);
  } catch (err) {
    const msg = (err as Error & { merger404?: boolean }).merger404
      ? "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)"
      : (err as Error).message;
    await updateTask(taskId, { status: "failed", errorMessage: `internal: ${msg}` });
    return { taskId, status: "failed", error: sanitizeForClient(msg) };
  }
}

async function mergeWaitWindow(
  taskId: string,
  jobId: string,
  waitSeconds: number,
  onProgress?: ProgressCb
): Promise<GenResult> {
  const windowMs = Math.min(Math.max(0, waitSeconds), 240) * 1000;
  const deadline = Date.now() + windowMs;
  let lastProgress = 5;
  while (Date.now() < deadline) {
    await sleep(3000);
    let st: MergeStatus;
    try {
      st = await getMergeStatus(jobId);
    } catch (err) {
      if ((err as Error & { merger404?: boolean }).merger404) {
        await updateTask(taskId, {
          status: "failed",
          errorMessage: "internal: مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
        });
        return { taskId, status: "failed", error: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" };
      }
      continue; // transient network hiccup: keep polling
    }
    if (st.state === "done") {
      await updateTask(taskId, { status: "completed", progress: 100, resultUrls: [st.videoUrl!] });
      try { await onProgress?.(100, 100, "اكتمل الدمج"); } catch { /* best-effort */ }
      return { taskId, status: "completed", urls: [st.videoUrl!] };
    }
    if (st.state === "failed") {
      await updateTask(taskId, { status: "failed", errorMessage: `internal: ${st.error || "merge failed"}` });
      return { taskId, status: "failed", error: sanitizeForClient(st.error) };
    }
    if (st.progress > lastProgress) {
      lastProgress = st.progress;
      await updateTask(taskId, { progress: st.progress });
    }
    try { await onProgress?.(lastProgress, 100, `جارٍ الدمج… ${lastProgress}%`); } catch { /* best-effort */ }
  }
  return { taskId, status: "processing" };
}

// get_task refresh for merge tasks: re-poll status, re-fire process if it never
// ran, and fail finally on 404 (job expired on the merge service).
export async function refreshMergeTask(task: DbTask): Promise<DbTask> {
  const taskId = task.id;
  const jobId = task.providerTaskId;
  if (!jobId) {
    await updateTask(taskId, { status: "failed", errorMessage: "internal: merge task without jobId" });
    return (await getTask(taskId))!;
  }
  let st: MergeStatus;
  try {
    st = await getMergeStatus(jobId);
  } catch (err) {
    if ((err as Error & { merger404?: boolean }).merger404) {
      await updateTask(taskId, {
        status: "failed",
        errorMessage: "internal: مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
      });
      return (await getTask(taskId))!;
    }
    return task; // transient error: report current stored state
  }
  if (st.state === "done") {
    await updateTask(taskId, { status: "completed", progress: 100, resultUrls: [st.videoUrl!] });
  } else if (st.state === "failed") {
    await updateTask(taskId, { status: "failed", errorMessage: `internal: ${st.error || "merge failed"}` });
  } else {
    if (st.progress > (task.progress || 0)) await updateTask(taskId, { progress: st.progress });
    await fireProcessOnce(taskId, jobId, true); // refresh holds the lease already
  }
  return (await getTask(taskId))!;
}

// Validation shared with the merge_videos tool (Arabic messages verbatim per spec).
export const MERGE_NEEDS_TWO = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
export const MERGE_MAX_TEN = "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).";

export function validateMergeInputs(resolvedUrls: string[]): string | null {
  if (resolvedUrls.length < 2) return MERGE_NEEDS_TWO;
  if (resolvedUrls.length > 10) return MERGE_MAX_TEN;
  return null;
}
