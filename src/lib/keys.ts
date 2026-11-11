// keys.ts — the sequential key pool (THE core feature) + key CRUD.
// Pool order is strictly insertion order (created_at ASC, id ASC) — first key
// added is tried first, then the next. Exhausted keys STAY in the pool and are
// still retried (a recharged key recovers automatically on success); only
// manual `disabled` removes a key from rotation.
import { randomUUID } from "node:crypto";
import { q, nowIso } from "./turso";
import { encryptSecret, decryptSecret, maskKey, fingerprint } from "./crypto";
import type { ProviderId } from "./models";
import type { ErrorClass } from "./classify";

export interface PoolKey {
  id: string;
  provider: ProviderId;
  label: string;
  status: string;
  plain: string; // decrypted — never leave this module except into provider adapters
}

export interface KeyView {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: string;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export async function getKeyPool(providers: ProviderId[]): Promise<PoolKey[]> {
  const placeholders = providers.map(() => "?").join(", ");
  const res = await q(
    `SELECT * FROM api_keys WHERE status != 'disabled' AND provider IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
    providers
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    provider: String(r.provider) as ProviderId,
    label: String(r.label || ""),
    status: String(r.status || "active"),
    plain: decryptSecret(String(r.api_key)),
  }));
}

function rowToView(r: Record<string, unknown>): KeyView {
  return {
    id: String(r.id),
    provider: String(r.provider),
    label: String(r.label || ""),
    masked: String(r.key_mask || "••••"),
    status: String(r.status || "active"),
    usageCount: Number(r.usage_count || 0),
    successCount: Number(r.success_count || 0),
    failCount: Number(r.fail_count || 0),
    lastUsedAt: (r.last_used_at as string) || null,
    lastCheckedAt: (r.last_checked_at as string) || null,
    lastError: (r.last_error as string) || null,
    createdAt: String(r.created_at),
  };
}

export async function listKeys(): Promise<KeyView[]> {
  const res = await q("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return res.rows.map((r) => rowToView(r as unknown as Record<string, unknown>));
}

export async function addKey(provider: ProviderId, apiKey: string, label?: string): Promise<KeyView> {
  const fp = fingerprint(apiKey);
  const dup = await q("SELECT id FROM api_keys WHERE provider = ? AND key_fp = ?", [provider, fp]);
  if (dup.rows.length) throw new Error("هذا المفتاح مضاف مسبقًا لنفس المزود");
  const id = randomUUID();
  const now = nowIso();
  await q(
    `INSERT INTO api_keys (id, provider, label, api_key, key_mask, key_fp, status, usage_count, success_count, fail_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 0, 0, 0, ?)`,
    [id, provider, label || "", encryptSecret(apiKey), maskKey(apiKey), fp, now]
  );
  const row = await q("SELECT * FROM api_keys WHERE id = ?", [id]);
  return rowToView(row.rows[0] as unknown as Record<string, unknown>);
}

export async function updateKey(id: string, patch: { status?: "active" | "disabled" | "exhausted"; label?: string }): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.label !== undefined) { sets.push("label = ?"); args.push(patch.label); }
  if (!sets.length) return;
  args.push(id);
  await q(`UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, args);
}

export async function deleteKey(id: string): Promise<void> {
  await q("DELETE FROM api_keys WHERE id = ?", [id]);
}

export async function recordKeySuccess(keyId: string): Promise<void> {
  await q(
    `UPDATE api_keys SET usage_count = usage_count + 1, success_count = success_count + 1,
       last_used_at = ?, last_error = NULL, status = CASE WHEN status = 'exhausted' THEN 'active' ELSE status END
     WHERE id = ?`,
    [nowIso(), keyId]
  );
}

// Every attempt (ok or fail) updates counters; disabled/exhausted classes flip status.
export async function recordKeyFailure(keyId: string, cls: ErrorClass, error: string): Promise<void> {
  const newStatus = cls === "disabled" ? "disabled" : cls === "exhausted" ? "exhausted" : null;
  if (newStatus) {
    await q(
      `UPDATE api_keys SET usage_count = usage_count + 1, fail_count = fail_count + 1, last_used_at = ?, last_error = ?, status = ? WHERE id = ?`,
      [nowIso(), error.slice(0, 300), newStatus, keyId]
    );
  } else {
    // temporary/provider classes leave the key healthy
    await q(
      `UPDATE api_keys SET usage_count = usage_count + 1, fail_count = fail_count + 1, last_used_at = ?, last_error = ? WHERE id = ?`,
      [nowIso(), error.slice(0, 300), keyId]
    );
  }
}

export async function markKeyChecked(id: string, ok: boolean, error?: string): Promise<void> {
  await q(
    `UPDATE api_keys SET last_checked_at = ?, last_error = ?, status = CASE WHEN ? THEN status ELSE 'disabled' END WHERE id = ?`,
    [nowIso(), ok ? null : (error || "auth check failed").slice(0, 300), ok ? 1 : 0, id]
  );
}
