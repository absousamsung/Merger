"use client";

// TaskBoard — stat chips + auto-refreshing task list (~5s) with progress bars.
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface TaskRow {
  id: string;
  type: string;
  model: string;
  provider: string | null;
  status: string;
  progress: number;
  prompt: string;
  resultUrls: string[] | null;
  error: string | null;
  attempts: number;
  createdAt: string;
}

const STATUS_LABEL: Record<string, string> = {
  completed: "مكتملة",
  failed: "فاشلة",
  processing: "جارية",
  pending: "بالانتظار",
};
const STATUS_STYLE: Record<string, string> = {
  completed: "bg-green-500/15 text-green-400 border-green-500/30",
  failed: "bg-red-500/15 text-red-400 border-red-500/30",
  processing: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
  pending: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};
const TYPE_LABEL: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };

function fmtWhen(iso: string): string {
  return (iso || "").slice(0, 19).replace("T", " ");
}

export default function TaskBoard() {
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0, pending: 0 });
  const [tasks, setTasks] = useState<TaskRow[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks?limit=50", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setStats(data.stats);
      setTasks(data.tasks || []);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const chips = [
    { label: "الإجمالي", value: stats.total, cls: "text-slate-200" },
    { label: "مكتملة", value: stats.completed, cls: "text-green-400" },
    { label: "فاشلة", value: stats.failed, cls: "text-red-400" },
    { label: "جارية", value: stats.processing, cls: "text-cyan-400" },
  ];

  return (
    <Card className="border-slate-800 bg-slate-900/60">
      <CardHeader>
        <CardTitle className="text-lg">لوحة المهام</CardTitle>
        <div className="flex flex-wrap gap-2 text-sm">
          {chips.map((c) => (
            <span key={c.label} className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1">
              {c.label}: <b className={c.cls}>{c.value}</b>
            </span>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {tasks.length === 0 ? (
          <p className="text-sm text-slate-500">لا توجد مهام بعد.</p>
        ) : (
          <div className="max-h-96 space-y-2 overflow-y-auto pr-1 [scrollbar-width:thin]">
            {tasks.map((t) => (
              <div key={t.id} className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_STYLE[t.status] || ""}`}>
                    {STATUS_LABEL[t.status] || t.status}
                  </span>
                  <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-300">
                    {TYPE_LABEL[t.type] || t.type}
                  </span>
                  <code dir="ltr" className="text-xs text-slate-400">{t.model}</code>
                  <code dir="ltr" className="text-xs text-slate-600">{t.id.slice(0, 8)}…</code>
                  <span className="text-xs text-slate-500">محاولات: {t.attempts}</span>
                  <span className="ms-auto text-xs text-slate-500">{fmtWhen(t.createdAt)}</span>
                </div>
                {t.prompt && <p className="truncate text-xs text-slate-400">{t.prompt}</p>}
                {(t.status === "processing" || t.status === "pending") && (
                  <div className="h-1.5 w-full rounded-full bg-slate-800">
                    <div
                      className="h-1.5 rounded-full bg-gradient-to-l from-cyan-400 to-violet-400"
                      style={{ width: `${t.progress}%` }}
                    />
                  </div>
                )}
                {t.error && <p className="text-xs text-red-400">خطأ: {t.error}</p>}
                {t.resultUrls && t.resultUrls.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {t.resultUrls.map((u) => (
                      <a
                        key={u}
                        href={u}
                        target="_blank"
                        rel="noreferrer"
                        dir="ltr"
                        className="rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-xs text-cyan-300 hover:underline"
                      >
                        {u.length > 60 ? u.slice(0, 60) + "…" : u}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
