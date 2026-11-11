// /api/keys — admin-protected key management. The full key is NEVER returned;
// every response carries the pre-computed mask only.
import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/turso";
import { requireAdmin, ADMIN_COOKIE } from "@/lib/auth";
import { listKeys, addKey } from "@/lib/keys";
import type { ProviderId } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS: ProviderId[] = ["kie", "cometapi"];

export async function GET(req: NextRequest) {
  if (!requireAdmin(req.cookies.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }
  await ensureSchema();
  return NextResponse.json({ keys: await listKeys() });
}

export async function POST(req: NextRequest) {
  if (!requireAdmin(req.cookies.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }
  await ensureSchema();
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "طلب غير صالح" }, { status: 400 });
  }
  const provider = body.provider as ProviderId;
  const apiKey = (body.api_key || "").trim();
  if (!PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: "المزود غير معروف — استخدم kie أو cometapi" }, { status: 400 });
  }
  if (!apiKey) {
    return NextResponse.json({ error: "قيمة المفتاح مطلوبة" }, { status: 400 });
  }
  try {
    const created = await addKey(provider, apiKey, body.label);
    return NextResponse.json({ key: created }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
