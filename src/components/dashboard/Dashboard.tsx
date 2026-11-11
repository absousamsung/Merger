"use client";

// Dashboard — header health, key manager, task board, server connection card.
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import KeyManager from "./KeyManager";
import TaskBoard from "./TaskBoard";
import ConnectionCard from "./ConnectionCard";

export interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: Array<{ canonical: string; type: string; providers: string[] }>;
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      setHealth(await res.json());
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    loadHealth();
    const t = setInterval(loadHealth, 10000);
    return () => clearInterval(t);
  }, [loadHealth]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-8 space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold bg-gradient-to-l from-cyan-400 to-violet-400 bg-clip-text text-transparent">
              مولّد الوسائط — لوحة الإدارة
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              توليد صور وفيديو عبر MCP مع تبديل مفاتيح تسلسلي تلقائي، ودمج مقاطع عبر خدمة الدمج.
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm rounded-full border border-slate-700 px-3 py-1.5 bg-slate-900/60">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${health?.ok ? "bg-green-500" : "bg-red-500"}`}
              aria-hidden
            />
            <span>{health?.ok ? "Turso متصل" : "غير متصل"}</span>
          </div>
        </header>

        <KeyManager />
        <TaskBoard />
        <ConnectionCard health={health} />
      </div>
    </main>
  );
}
