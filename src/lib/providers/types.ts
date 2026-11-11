// providers/types.ts — adapter contract + shared HTTP helper with timeouts.
import type { ErrorClass } from "../classify";

export class ProviderError extends Error {
  status: number | undefined;
  hint?: ErrorClass;
  constructor(status: number | undefined, message: string, hint?: ErrorClass) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.hint = hint;
  }
}

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  // Async job creation (video, and kie images)
  createTask(key: string, model: string, input: Record<string, unknown>): Promise<{ providerTaskId: string }>;
  // Optional synchronous image generation (CometAPI images may return immediately)
  createImageSync?(key: string, model: string, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  checkTask(key: string, providerTaskId: string): Promise<CheckResult>;
  // Cheap auth probe used by the dashboard "re-test" action
  testKey(key: string): Promise<{ ok: boolean; status?: number; error?: string }>;
}

// fetch JSON with per-request timeout; network failures become ProviderError(undefined)
// so the classifier treats them as temporary.
export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ httpStatus: number; body: unknown; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { httpStatus: res.status, body, text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProviderError(undefined, `network error: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

export function bearer(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}
