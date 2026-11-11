// orchestrator.ts — runGeneration / refreshTask with sequential multi-key
// failover. The task NEVER stops on key/balance failures: the same task_id is
// retried on the next key; the client only ever sees sanitized Arabic output.
import { isoIn, nowIso } from "./turso";
import { getAdapter } from "./providers/cometapi";
import { ProviderError, type ProviderAdapter, type CheckResult } from "./providers/types";
import { classifyProviderError, type ErrorClass } from "./classify";
import { getKeyPool, recordKeySuccess, recordKeyFailure } from "./keys";
import { acquireLease, getTask, insertTask, updateTask, type DbTask, type TaskStatus } from "./tasks";
import { defaultModelFor, modelForCanonical, normalizeModel, type ModelDef, type ProviderId } from "./models";
import { sanitizeForClient } from "./sanitize";

export interface ProgressCb {
  (progress: number, total: number, message: string): Promise<void> | void;
}

export interface GenResult {
  taskId: string;
  status: TaskStatus;
  urls?: string[];
  error?: string;
}

const NO_KEYS_MSG = (model: string) =>
  `❌ لا توجد مفاتيح نشطة لخدمة ${model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`;

const PROGRESS_MSG = (p: number) => `قيد التوليد… ${p}%`;

function stuckMinutes(): number {
  const v = Number(process.env.STUCK_TASK_MAX_MINUTES);
  return Number.isFinite(v) && v > 0 ? v : 60;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Bound {
  keyId: string;
  provider: ProviderId;
  plain: string;
  adapter: ProviderAdapter;
  providerTaskId: string;
}

// Per-provider provider-native input construction (verified against live kie.ai).
function buildInput(def: ModelDef, params: Record<string, unknown>, provider: ProviderId): Record<string, unknown> {
  const out: Record<string, unknown> = { prompt: String(params.prompt || "") };
  if (def.type === "image") {
    if (params.aspect_ratio !== undefined) out.aspect_ratio = params.aspect_ratio;
    if (params.resolution !== undefined) out.resolution = params.resolution;
    // background only applies at 1K on this model
    if (params.background !== undefined && params.resolution === "1K") out.background = params.background;
    if (params.output_format !== undefined) out.output_format = params.output_format;
  } else {
    if (params.image_url !== undefined) out.image_url = params.image_url;
    if (params.aspect_ratio !== undefined) out.aspect_ratio = params.aspect_ratio;
    if (params.resolution !== undefined) out.resolution = params.resolution;
    if (params.enable_audio !== undefined) out.enable_audio = params.enable_audio;
    if (params.duration !== undefined) out.duration = params.duration;
  }
  void provider;
  return out;
}

interface CreationOutcome {
  bound?: Bound;
  sync?: { provider: ProviderId; keyId: string; urls: string[] };
  paramError?: string;
  allFailed?: string;
}

// Tries every candidate key in strict pool order. First success binds the task.
async function attemptCreation(
  taskId: string,
  def: ModelDef,
  params: Record<string, unknown>
): Promise<CreationOutcome> {
  const pool = await getKeyPool(def.providers);
  let lastErr = "";
  for (const key of pool) {
    const adapter = getAdapter(key.provider);
    const input = buildInput(def, params, key.provider);
    try {
      if (def.type === "image" && key.provider === "cometapi" && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(key.plain, def.providerModel[key.provider], input);
        await recordKeySuccess(key.id);
        await updateTask(taskId, {
          provider: key.provider,
          keyId: key.id,
          appendAttempt: { provider: key.provider, keyId: key.id, keyLabel: key.label, ok: true, at: nowIso() },
        });
        return { sync: { provider: key.provider, keyId: key.id, urls } };
      }
      const { providerTaskId } = await adapter.createTask(key.plain, def.providerModel[key.provider], input);
      await recordKeySuccess(key.id);
      await updateTask(taskId, {
        provider: key.provider,
        providerTaskId,
        keyId: key.id,
        progress: 5,
        appendAttempt: { provider: key.provider, keyId: key.id, keyLabel: key.label, ok: true, at: nowIso() },
      });
      return { bound: { keyId: key.id, provider: key.provider, plain: key.plain, adapter, providerTaskId } };
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError(undefined, (err as Error).message);
      const cls = classifyProviderError(pe.status, pe.message, pe.hint);
      await recordKeyFailure(key.id, cls, pe.message);
      await updateTask(taskId, {
        appendAttempt: {
          provider: key.provider,
          keyId: key.id,
          keyLabel: key.label,
          ok: false,
          errorClass: cls,
          error: pe.message.slice(0, 200),
          at: nowIso(),
        },
      });
      if (cls === "params") return { paramError: sanitizeForClient(pe.message) };
      lastErr = `${cls}: ${pe.message}`;
      // disabled/exhausted/provider/temporary all move on to the next candidate
    }
  }
  return { allFailed: lastErr };
}

interface CheckOutcome {
  completed?: boolean;
  failed?: boolean;
  processing?: boolean;
  cooldown?: boolean;
  urls?: string[];
  error?: string;
  progress?: number;
  bound?: Bound;
}

// Checks the bound provider task; on key-class failures, re-checks the SAME
// provider_task_id with other keys of the same provider (checking is read-only
// and never duplicates paid jobs — idempotency rule 5.3.6).
async function checkWithFailover(taskId: string, def: ModelDef, bound: Bound): Promise<CheckOutcome> {
  try {
    const r = await bound.adapter.checkTask(bound.plain, bound.providerTaskId);
    if (r.status === "completed") return { completed: true, urls: r.urls };
    if (r.status === "failed") return { failed: true, error: r.error || "provider reported failure" };
    return { processing: true, progress: r.progress };
  } catch (err) {
    const pe = err instanceof ProviderError ? err : new ProviderError(undefined, (err as Error).message);
    const cls = classifyProviderError(pe.status, pe.message, pe.hint);
    if (cls === "params") return { failed: true, error: pe.message };
    if (cls === "disabled" || cls === "exhausted") {
      await recordKeyFailure(bound.keyId, cls, pe.message);
      const pool = await getKeyPool([bound.provider]);
      for (const candidate of pool) {
        if (candidate.id === bound.keyId) continue;
        try {
          let r: CheckResult;
          if (candidate.plain) {
            r = await getAdapter(candidate.provider).checkTask(candidate.plain, bound.providerTaskId);
          } else {
            r = { status: "processing" };
          }
          if (r.status === "completed") {
            await recordKeySuccess(candidate.id);
            const newBound: Bound = { keyId: candidate.id, provider: candidate.provider, plain: candidate.plain, adapter: getAdapter(candidate.provider), providerTaskId: bound.providerTaskId };
            await updateTask(taskId, { keyId: candidate.id });
            return { completed: true, urls: r.urls, bound: newBound };
          }
          if (r.status === "failed") {
            await recordKeySuccess(candidate.id);
            return { failed: true, error: r.error || "provider reported failure" };
          }
          // successful check with the fallback key: rebind silently
          await recordKeySuccess(candidate.id);
          await updateTask(taskId, { keyId: candidate.id });
          return { processing: true, progress: r.progress, bound: { keyId: candidate.id, provider: candidate.provider, plain: candidate.plain, adapter: getAdapter(candidate.provider), providerTaskId: bound.providerTaskId } };
        } catch {
          continue;
        }
      }
      // No usable key to even CHECK: cooldown, keep processing (never failed).
      await updateTask(taskId, { nextRetryAt: isoIn(45), errorMessage: `internal: check blocked by key loss: ${pe.message.slice(0, 200)}` });
      return { processing: true, cooldown: true };
    }
    // temporary/provider during check: keep polling, key stays healthy
    return { processing: true };
  }
}

async function applyOutcome(taskId: string, outcome: CheckOutcome): Promise<void> {
  if (outcome.completed) {
    await updateTask(taskId, { status: "completed", progress: 100, resultUrls: outcome.urls || [] });
  } else if (outcome.failed) {
    await updateTask(taskId, { status: "failed", errorMessage: `internal: ${outcome.error || "unknown"}` });
  }
}

function parseParams(paramsJson: string): Record<string, unknown> {
  try {
    const v = JSON.parse(paramsJson || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// The bounded wait window: poll every 3s, emit progress notifications, persist.
async function waitWindow(
  taskId: string,
  def: ModelDef,
  bound: Bound,
  waitSeconds: number,
  onProgress?: ProgressCb
): Promise<GenResult> {
  const windowMs = Math.min(Math.max(0, waitSeconds), 240) * 1000;
  const deadline = Date.now() + windowMs;
  let progress = 5;
  let polls = 0;
  let current = bound;
  while (Date.now() < deadline) {
    await sleep(3000);
    const outcome = await checkWithFailover(taskId, def, current);
    if (outcome.bound) current = outcome.bound;
    if (outcome.completed) {
      await applyOutcome(taskId, outcome);
      try { await onProgress?.(100, 100, "اكتمل التوليد"); } catch { /* best-effort */ }
      return { taskId, status: "completed", urls: outcome.urls };
    }
    if (outcome.failed) {
      await applyOutcome(taskId, outcome);
      return { taskId, status: "failed", error: sanitizeForClient(outcome.error) };
    }
    polls++;
    const next = Math.max(progress, Math.min(95, outcome.progress ?? Math.min(95, 10 + polls * 3)));
    if (next !== progress) {
      progress = next;
      await updateTask(taskId, { progress });
    }
    try { await onProgress?.(progress, 100, PROGRESS_MSG(progress)); } catch { /* best-effort */ }
  }
  return { taskId, status: "processing" };
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function runGeneration(opts: {
  type: "image" | "video";
  model?: string;
  params: Record<string, unknown>;
  waitSeconds: number;
  onProgress?: ProgressCb;
}): Promise<GenResult> {
  const def = opts.model ? normalizeModel(opts.model) : defaultModelFor(opts.type);
  if (!def) {
    return {
      taskId: "",
      status: "failed",
      error: `❌ نموذج غير معروف: ${opts.model}. المتاح: gpt-image-2-6/flare-text-to-image، grok-imagine-video-1-5-preview`,
    };
  }
  // Pool check BEFORE insert: nothing trackable exists without any key.
  const pool = await getKeyPool(def.providers);
  if (!pool.length) {
    return { taskId: "", status: "failed", error: NO_KEYS_MSG(def.canonical) };
  }
  // Insert the task before ANY external call so it stays traceable even if the
  // connection drops mid-flight.
  const task = await insertTask({
    type: opts.type,
    model: def.canonical,
    prompt: String(opts.params.prompt || ""),
    params: { ...opts.params, model: def.canonical },
  });
  const taskId = task.id;

  const created = await attemptCreation(taskId, def, opts.params);
  if (created.sync) {
    await updateTask(taskId, {
      provider: created.sync.provider,
      status: "completed",
      progress: 100,
      resultUrls: created.sync.urls,
    });
    return { taskId, status: "completed", urls: created.sync.urls };
  }
  if (created.paramError) {
    await updateTask(taskId, { status: "failed", errorMessage: `internal: ${created.paramError}` });
    return { taskId, status: "failed", error: created.paramError };
  }
  if (!created.bound) {
    // ALL keys failed at creation: the task stays processing (never failed) and
    // every get_task retries automatically after the ~45s cooldown.
    await updateTask(taskId, {
      status: "processing",
      nextRetryAt: isoIn(45),
      errorMessage: `internal: all keys failed at creation: ${created.allFailed || "unknown"}`,
    });
    return { taskId, status: "processing" };
  }
  return waitWindow(taskId, def, created.bound, opts.waitSeconds, opts.onProgress);
}

// get_task: live-refresh a running task with the same failover logic (lease-guarded).
export async function refreshTask(taskId: string): Promise<DbTask | null> {
  let task = await getTask(taskId);
  if (!task) return null;
  if (task.status !== "processing") return task;
  // DB lease: two concurrent get_task calls can never both refresh/recreate.
  if (!(await acquireLease(taskId, 45))) return task;
  task = (await getTask(taskId))!;
  if (task.status !== "processing") return task;

  if (task.provider === "merger") {
    const { refreshMergeTask } = await import("./merger");
    return refreshMergeTask(task);
  }

  const def = modelForCanonical(task.model) || (task.type === "image" || task.type === "video" ? defaultModelFor(task.type) : null);
  if (!def) {
    await updateTask(taskId, { status: "failed", errorMessage: "internal: unknown model" });
    return getTask(taskId);
  }

  if (!task.providerTaskId) {
    // Creation never succeeded on any key: stuck valve + cooldown + auto-retry.
    const ageMs = Date.now() - new Date(task.createdAt).getTime();
    if (ageMs > stuckMinutes() * 60000) {
      await updateTask(taskId, { status: "failed", errorMessage: "internal: stuck without provider job beyond STUCK_TASK_MAX_MINUTES" });
      return getTask(taskId);
    }
    if (task.nextRetryAt && new Date(task.nextRetryAt).getTime() > Date.now()) {
      return task; // still cooling down
    }
    const created = await attemptCreation(taskId, def, parseParams(task.paramsJson));
    if (created.sync) {
      await updateTask(taskId, { provider: created.sync.provider, status: "completed", progress: 100, resultUrls: created.sync.urls });
      return getTask(taskId);
    }
    if (created.paramError) {
      await updateTask(taskId, { status: "failed", errorMessage: `internal: ${created.paramError}` });
      return getTask(taskId);
    }
    if (!created.bound) {
      await updateTask(taskId, { nextRetryAt: isoIn(45) });
      return getTask(taskId);
    }
    const outcome = await checkWithFailover(taskId, def, created.bound);
    await applyOutcome(taskId, outcome);
    return getTask(taskId);
  }

  // Provider job exists: check it (rebinding to another same-provider key if the
  // original key died mid-task).
  const pool = await getKeyPool(def.providers);
  const preferred = pool.find((k) => k.id === task!.keyId) || pool.find((k) => k.provider === task!.provider);
  if (!preferred) {
    const ageMs = Date.now() - new Date(task.createdAt).getTime();
    if (ageMs > stuckMinutes() * 60000) {
      await updateTask(taskId, { status: "failed", errorMessage: "internal: stuck without usable key beyond STUCK_TASK_MAX_MINUTES" });
    } else {
      await updateTask(taskId, { nextRetryAt: isoIn(45), errorMessage: "internal: no usable key to check provider job" });
    }
    return getTask(taskId);
  }
  const bound: Bound = {
    keyId: preferred.id,
    provider: preferred.provider,
    plain: preferred.plain,
    adapter: getAdapter(preferred.provider),
    providerTaskId: task.providerTaskId,
  };
  const outcome = await checkWithFailover(taskId, def, bound);
  await applyOutcome(taskId, outcome);
  return getTask(taskId);
}
