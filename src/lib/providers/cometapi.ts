// providers/cometapi.ts — secondary provider adapter (OpenAI-compatible images +
// async video tasks). Implemented per CometAPI's current documented shapes.
// NOTE: no CometAPI key was available during the build, so these shapes are
// documented-but-untested end-to-end (flagged in DECISIONS.md).
import { ProviderError, fetchJson, bearer, type ProviderAdapter, type CheckResult } from "./types";
import { kieAdapter } from "./kie";

const BASE = "https://api.cometapi.com";

// aspect_ratio + resolution -> OpenAI-style size for gpt-image models
function mapSize(aspectRatio?: string, resolution?: string): string | undefined {
  if (!aspectRatio || aspectRatio === "auto") return undefined;
  const landscape = "1536x1024";
  const portrait = "1024x1536";
  switch (aspectRatio) {
    case "1:1": return resolution === "1K" ? "1024x1024" : undefined;
    case "16:9":
    case "3:2":
    case "5:4":
    case "21:9":
    case "3:1":
    case "2:1": return resolution === "1K" ? landscape : undefined;
    case "9:16":
    case "2:3":
    case "3:4":
    case "4:5":
    case "9:21":
    case "1:3":
    case "1:2": return resolution === "1K" ? portrait : undefined;
    default: return undefined;
  }
}

function asObj(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
}

export const cometApiAdapter: ProviderAdapter = {
  // Images are synchronous: data[0].url (hosted) or b64_json.
  async createImageSync(key, model, input) {
    const payload: Record<string, unknown> = {
      model,
      prompt: String(input.prompt || ""),
      n: 1,
    };
    const size = mapSize(input.aspect_ratio as string | undefined, input.resolution as string | undefined);
    if (size) payload.size = size;
    const { httpStatus, body } = await fetchJson(
      `${BASE}/v1/images/generations`,
      { method: "POST", headers: bearer(key), body: JSON.stringify(payload) },
      120000
    );
    const b = asObj(body);
    if (httpStatus !== 200 || !b) {
      const errObj = b && (b.error as { message?: string } | undefined);
      const msg = errObj?.message || `CometAPI images failed (HTTP ${httpStatus})`;
      throw new ProviderError(httpStatus || 500, typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    const arr = (b.data as Array<{ url?: string; b64_json?: string }>) || [];
    const first = arr[0];
    if (first?.url) return { urls: [first.url] };
    if (first?.b64_json) {
      // We must not host binaries: treat as unsupported and fail over to the next key/provider.
      throw new ProviderError(422, "provider returned b64_json without hosted url — unsupported model output", "provider");
    }
    throw new ProviderError(500, "CometAPI images returned no data");
  },

  async createTask(key, model, input) {
    const payload: Record<string, unknown> = {
      model,
      prompt: String(input.prompt || ""),
    };
    for (const field of ["image_url", "aspect_ratio", "resolution", "duration"] as const) {
      if (input[field] !== undefined) payload[field] = input[field];
    }
    const { httpStatus, body } = await fetchJson(
      `${BASE}/v1/video/tasks`,
      { method: "POST", headers: bearer(key), body: JSON.stringify(payload) },
      15000
    );
    const b = asObj(body);
    const dataObj = b && (b.data as Record<string, unknown> | undefined);
    const taskId =
      (b && ((b.task_id as string) || (b.id as string))) ||
      (dataObj && ((dataObj.task_id as string) || (dataObj.id as string))) ||
      null;
    if (httpStatus !== 200 || !taskId) {
      const errObj = b && (b.error as { message?: string } | undefined);
      const msg = errObj?.message || (b && (b.message as string)) || `CometAPI video task failed (HTTP ${httpStatus})`;
      throw new ProviderError(httpStatus || 500, typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key, providerTaskId): Promise<CheckResult> {
    const { httpStatus, body } = await fetchJson(
      `${BASE}/v1/video/tasks/${encodeURIComponent(providerTaskId)}`,
      { method: "GET", headers: bearer(key) },
      10000
    );
    const b = asObj(body);
    if (httpStatus !== 200 || !b) {
      const errObj = b && (b.error as { message?: string } | undefined);
      const msg = errObj?.message || `CometAPI task status failed (HTTP ${httpStatus})`;
      throw new ProviderError(httpStatus || 500, typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    const data = (b.data as Record<string, unknown>) || b;
    const status = String(data.status || b.status || "").toLowerCase();
    const outs = (data.outputs as Array<{ url?: string }>) || [];
    const urls = outs.map((o) => o.url).filter(Boolean) as string[];
    if (["completed", "succeeded", "success", "finished"].includes(status)) {
      if (!urls.length) throw new ProviderError(500, "CometAPI finished without URLs");
      return { status: "completed", urls };
    }
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      return { status: "failed", error: String(data.error || data.failure_reason || "CometAPI generation failed") };
    }
    const progress = Number(data.progress);
    return { status: "processing", progress: Number.isFinite(progress) ? progress : undefined };
  },

  async testKey(key) {
    const { httpStatus } = await fetchJson(`${BASE}/v1/models`, { method: "GET", headers: bearer(key) }, 10000);
    if (httpStatus === 401 || httpStatus === 403) return { ok: false, status: httpStatus, error: "invalid key" };
    return { ok: true, status: httpStatus };
  },
};

export function getAdapter(provider: "kie" | "cometapi"): ProviderAdapter {
  return provider === "kie" ? kieAdapter : cometApiAdapter;
}
