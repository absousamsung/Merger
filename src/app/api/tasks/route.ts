// /api/tasks — admin task board feed: recent tasks + stats (auto-refreshed by UI).
import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/turso";
import { requireAdmin, ADMIN_COOKIE } from "@/lib/auth";
import { listRecentTasks, taskStats, type TaskType, type TaskStatus } from "@/lib/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!requireAdmin(req.cookies.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }
  await ensureSchema();
  const type = req.nextUrl.searchParams.get("type") as TaskType | null;
  const status = req.nextUrl.searchParams.get("status") as TaskStatus | null;
  const limit = Math.min(50, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 50));
  const [tasks, stats] = await Promise.all([
    listRecentTasks(limit, { type: type || undefined, status: status || undefined }),
    taskStats(),
  ]);
  return NextResponse.json({
    stats,
    tasks: tasks.map((t) => ({
      id: t.id,
      type: t.type,
      model: t.model,
      provider: t.provider,
      status: t.status,
      progress: t.progress,
      prompt: t.prompt.slice(0, 120),
      resultUrls: t.resultUrls,
      error: t.errorMessage?.startsWith("internal:")
        ? t.errorMessage.slice(9).trim().slice(0, 200)
        : t.errorMessage,
      attempts: t.attempts.length,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    })),
  });
}
