// /api/keys/[id]/test — dashboard "re-test" action: cheap provider auth probe.
// A transient 401/403 flips the key to disabled (reversible from the dashboard).
import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/turso";
import { requireAdmin, ADMIN_COOKIE } from "@/lib/auth";
import { getAdapter } from "@/lib/providers/cometapi";
import { markKeyChecked } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!requireAdmin(req.cookies.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }
  await ensureSchema();
  const { id } = await params;
  const { q } = await import("@/lib/turso");
  const res = await q("SELECT id, provider, api_key FROM api_keys WHERE id = ?", [id]);
  if (!res.rows.length) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  const row = res.rows[0];
  const provider = String(row.provider) as "kie" | "cometapi";
  const adapter = getAdapter(provider);
  try {
    const result = await adapter.testKey(String(row.api_key));
    await markKeyChecked(id, result.ok, result.error);
    return NextResponse.json({ ok: result.ok, status: result.status ?? null, error: result.error ?? null });
  } catch (err) {
    await markKeyChecked(id, false, (err as Error).message);
    return NextResponse.json({ ok: false, error: (err as Error).message });
  }
}
