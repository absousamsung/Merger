// /api/keys/[id] — PATCH (enable/disable/status) and DELETE for one key.
import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/turso";
import { requireAdmin, ADMIN_COOKIE } from "@/lib/auth";
import { updateKey, deleteKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!requireAdmin(req.cookies.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }
  await ensureSchema();
  const { id } = await params;
  let body: { status?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "طلب غير صالح" }, { status: 400 });
  }
  const status = body.status as "active" | "disabled" | "exhausted" | undefined;
  if (status !== undefined && !["active", "disabled", "exhausted"].includes(status)) {
    return NextResponse.json({ error: "حالة غير صالحة" }, { status: 400 });
  }
  await updateKey(id, { status, label: body.label });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!requireAdmin(req.cookies.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }
  await ensureSchema();
  const { id } = await params;
  await deleteKey(id);
  return NextResponse.json({ ok: true });
}
