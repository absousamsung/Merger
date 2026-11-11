// /api/health — public; exposes no secrets. Reflects DB, merger, models, auth mode.
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerHealthy, mergerConfigured } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = await dbHealthy();
  const merger = { base: process.env.MERGER_API_BASE || "", healthy: mergerConfigured() ? await mergerHealthy() : false };
  return NextResponse.json({
    ok: db,
    database: db ? "turso-connected" : "unavailable",
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
    merger,
    authRequired: !!process.env.MCP_ACCESS_TOKEN,
  });
}
