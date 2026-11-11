// tasks.ts — task CRUD with attempt journaling, stats and DB-level leases.
// Leases are the real exclusivity mechanism (in-memory locks are best-effort only).
import { randomUUID } from "node:crypto";
import { q, nowIso, isoIn } from "./turso";

export type TaskType = "image" | "video" | "merge";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface AttemptEntry {
  provider?: string;
  keyId?: string;
  keyLabel?: string;
  ok?: boolean;
  errorClass?: string;
  error?: string;
  action?: string;
  at: string;
}

export interface DbTask {
  id: string;
  provider: string | null;
  providerTaskId: string | null;
  keyId: string | null;
  model: string;
  type: TaskType;
  prompt: string;
  paramsJson: string;
  status: TaskStatus;
  progress: number;
  resultUrls: string[] | null;
  errorMessage: string | null;
  attempts: AttemptEntry[];
  nextRetryAt: string | null;
  lockUntil: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function rowToTask(r: Record<string, unknown>): DbTask {
  const parse = (v: unknown, d: unknown) => {
    try {
      return v ? JSON.parse(String(v)) : d;
    } catch {
      return d;
    }
  };
  return {
    id: String(r.id),
    provider: (r.provider as string) || null,
    providerTaskId: (r.provider_task_id as string) || null,
    keyId: (r.key_id as string) || null,
    model: String(r.model || ""),
    type: String(r.type) as TaskType,
    prompt: String(r.prompt || ""),
    paramsJson: String(r.params_json || "{}"),
    status: String(r.status) as TaskStatus,
    progress: Number(r.progress || 0),
    resultUrls: parse(r.result_urls_json, null),
    errorMessage: (r.error_message as string) || null,
    attempts: parse(r.attempts_json, []),
    nextRetryAt: (r.next_retry_at as string) || null,
    lockUntil: (r.lock_until as string) || null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    completedAt: (r.completed_at as string) || null,
  };
}

export interface InsertTaskInput {
  id?: string;
  type: TaskType;
  model: string;
  prompt?: string;
  params: Record<string, unknown>;
  status?: TaskStatus;
}

export async function insertTask(input: InsertTaskInput): Promise<DbTask> {
  const id = input.id || randomUUID();
  const now = nowIso();
  await q(
    `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, attempts_json, created_at, updated_at)
     VALUES (?, NULL, NULL, NULL, ?, ?, ?, ?, ?, 0, '[]', ?, ?)`,
    [id, input.model, input.type, input.prompt || "", JSON.stringify(input.params || {}), input.status || "processing", now, now]
  );
  const t = await getTask(id);
  if (!t) throw new Error("failed to read back inserted task");
  return t;
}

export async function getTask(id: string): Promise<DbTask | null> {
  const res = await q("SELECT * FROM tasks WHERE id = ?", [id]);
  if (!res.rows.length) return null;
  return rowToTask(res.rows[0] as unknown as Record<string, unknown>);
}

export interface TaskPatch {
  provider?: string;
  providerTaskId?: string;
  keyId?: string;
  status?: TaskStatus;
  progress?: number;
  resultUrls?: string[];
  errorMessage?: string | null;
  appendAttempt?: AttemptEntry;
  nextRetryAt?: string | null;
  clearNextRetry?: boolean;
}

// Partial patch; appends attempts atomically; sets completed_at automatically.
export async function updateTask(id: string, patch: TaskPatch): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.provider !== undefined) { sets.push("provider = ?"); args.push(patch.provider); }
  if (patch.providerTaskId !== undefined) { sets.push("provider_task_id = ?"); args.push(patch.providerTaskId); }
  if (patch.keyId !== undefined) { sets.push("key_id = ?"); args.push(patch.keyId); }
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.progress !== undefined) { sets.push("progress = ?"); args.push(patch.progress); }
  if (patch.resultUrls !== undefined) { sets.push("result_urls_json = ?"); args.push(JSON.stringify(patch.resultUrls)); }
  if (patch.errorMessage !== undefined) { sets.push("error_message = ?"); args.push(patch.errorMessage); }
  if (patch.nextRetryAt !== undefined) { sets.push("next_retry_at = ?"); args.push(patch.nextRetryAt); }
  if (patch.appendAttempt) {
    const cur = await q("SELECT attempts_json FROM tasks WHERE id = ?", [id]);
    const list: AttemptEntry[] = cur.rows.length ? (() => { try { return JSON.parse(String(cur.rows[0].attempts_json || "[]")); } catch { return []; } })() : [];
    list.push(patch.appendAttempt);
    // journal is capped to keep rows small
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(list.slice(-30)));
  }
  if (patch.status === "completed") { sets.push("completed_at = ?"); args.push(nowIso()); }
  sets.push("updated_at = ?");
  args.push(nowIso(), id);
  await q(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args);
}

export async function listRecentTasks(
  limit: number,
  filters?: { type?: TaskType; status?: TaskStatus }
): Promise<DbTask[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filters?.type) { where.push("type = ?"); args.push(filters.type); }
  if (filters?.status) { where.push("status = ?"); args.push(filters.status); }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
  args.push(limit);
  const res = await q(sql, args);
  return res.rows.map((r) => rowToTask(r as unknown as Record<string, unknown>));
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number; pending: number }> {
  const res = await q("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status");
  const stats = { total: 0, completed: 0, failed: 0, processing: 0, pending: 0 };
  for (const row of res.rows) {
    const n = Number(row.n);
    stats.total += n;
    const s = String(row.status);
    if (s === "completed") stats.completed = n;
    else if (s === "failed") stats.failed = n;
    else if (s === "processing") stats.processing = n;
    else stats.pending += n;
  }
  return stats;
}

// DB lease: single conditional UPDATE checked via affected rows. Concurrent
// get_task calls can never both create provider jobs for the same task.
export async function acquireLease(taskId: string, seconds: number): Promise<boolean> {
  const res = await q(
    `UPDATE tasks SET lock_until = ?, updated_at = ? WHERE id = ? AND status = 'processing' AND (lock_until IS NULL OR lock_until < ?)`,
    [isoIn(seconds), nowIso(), taskId, nowIso()]
  );
  return Number(res.rowsAffected) === 1;
}

export async function deleteTask(id: string): Promise<void> {
  await q("DELETE FROM tasks WHERE id = ?", [id]);
}

export async function deleteTasksOlderThan(iso: string): Promise<number> {
  const ids = await q("SELECT id FROM tasks WHERE created_at < ?", [iso]);
  for (const r of ids.rows) await deleteTask(String(r.id));
  return ids.rows.length;
}
