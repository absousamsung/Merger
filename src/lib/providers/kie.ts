// providers/kie.ts — primary provider adapter (kie.ai Jobs API).
// Shapes VERIFIED against the live API on 2026-11-11:
//   POST /api/v1/jobs/createTask  {"model","input"} -> {"code":200,"data":{"taskId"}}
//   GET  /api/v1/jobs/recordInfo?taskId= -> {"code":200,"data":{"state":"success",
//         "resultJson":"{\"resultUrls\":[...]}" (JSON STRING — needs 2nd parse),
//         "failMsg":"", "response":{"resultUrls":[...]}}}
// A non-200 `code` in the body is an error even when HTTP is 200.
import { ProviderError, fetchJson, bearer, type ProviderAdapter, type CheckResult } from "./types";

const BASE = "https://api.kie.ai/api/v1/jobs";

function extractUrls(data: Record<string, unknown>): string[] {
  // resultJson is a JSON-encoded string; response.resultUrls is a direct fallback.
  const resultJson = data.resultJson;
  if (typeof resultJson === "string") {
    try {
      const parsed = JSON.parse(resultJson) as { resultUrls?: string[] };
      if (Array.isArray(parsed.resultUrls) && parsed.resultUrls.length) return parsed.resultUrls;
    } catch {
      /* fall through */
    }
  }
  const response = data.response as { resultUrls?: string[] } | undefined;
  if (response && Array.isArray(response.resultUrls) && response.resultUrls.length) return response.resultUrls;
  const direct = (data as { resultUrls?: string[] }).resultUrls;
  if (Array.isArray(direct) && direct.length) return direct;
  return [];
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key, model, input) {
    const { httpStatus, body } = await fetchJson(
      `${BASE}/createTask`,
      { method: "POST", headers: bearer(key), body: JSON.stringify({ model, input }) },
      15000
    );
    const b = body as { code?: number; msg?: string; data?: { taskId?: string } } | null;
    if (b && typeof b.code === "number" && b.code !== 200) {
      throw new ProviderError(b.code, b.msg || "kie.ai request failed");
    }
    if (!b || !b.data || !b.data.taskId) {
      throw new ProviderError(httpStatus === 200 ? 500 : httpStatus, "unexpected kie.ai response shape");
    }
    return { providerTaskId: String(b.data.taskId) };
  },

  async checkTask(key, providerTaskId): Promise<CheckResult> {
    const { httpStatus, body } = await fetchJson(
      `${BASE}/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      { method: "GET", headers: bearer(key) },
      10000
    );
    const b = body as {
      code?: number;
      msg?: string;
      data?: { state?: string; resultJson?: string; failMsg?: string; failCode?: string; response?: { resultUrls?: string[] } };
    } | null;
    if (b && typeof b.code === "number" && b.code !== 200) {
      throw new ProviderError(b.code, b.msg || "kie.ai recordInfo failed");
    }
    if (!b || !b.data) {
      throw new ProviderError(httpStatus === 200 ? 500 : httpStatus, "unexpected kie.ai recordInfo shape");
    }
    const state = String(b.data.state || "");
    if (state === "success" || state === "succeed" || state === "completed") {
      const urls = extractUrls(b.data as unknown as Record<string, unknown>);
      if (!urls.length) throw new ProviderError(500, "kie.ai finished without result URLs");
      return { status: "completed", urls };
    }
    if (state === "fail" || state === "failed" || state === "error") {
      return { status: "failed", error: b.data.failMsg || "kie.ai generation failed" };
    }
    // waiting | queuing | generating (and anything unknown) keep polling
    return { status: "processing" };
  },

  async testKey(key) {
    // A valid key gets a non-auth error for a dummy task id; an invalid key gets 401.
    const { httpStatus, body } = await fetchJson(
      `${BASE}/recordInfo?taskId=0`,
      { method: "GET", headers: bearer(key) },
      10000
    );
    const b = body as { code?: number; msg?: string } | null;
    if (httpStatus === 401 || httpStatus === 403) return { ok: false, status: httpStatus, error: b?.msg || "invalid key" };
    // code 422 "recordInfo is null" = authenticated, task not found => key works
    return { ok: true, status: httpStatus };
  },
};
