"use client";

// KeyManager — add form + masked list with status badges, counters, actions.
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface KeyView {
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

const STATUS_STYLE: Record<string, string> = {
  active: "bg-green-500/15 text-green-400 border-green-500/30",
  exhausted: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  disabled: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};
const STATUS_LABEL: Record<string, string> = {
  active: "نشط",
  exhausted: "منتهي الرصيد",
  disabled: "معطّل",
};

export default function KeyManager() {
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [provider, setProvider] = useState("kie");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/keys", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setKeys(data.keys || []);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey, label }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(data.error || "تعذر إضافة المفتاح");
        return;
      }
      setApiKey("");
      setLabel("");
      setMsg("تمت إضافة المفتاح بنجاح");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, status: "active" | "disabled") {
    await fetch(`/api/keys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await load();
  }

  async function remove(id: string) {
    await fetch(`/api/keys/${id}`, { method: "DELETE" });
    await load();
  }

  async function retest(id: string) {
    setMsg("جارٍ اختبار المفتاح…");
    const res = await fetch(`/api/keys/${id}/test`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setMsg(data.ok ? "اختبار المفتاح: صالح" : `اختبار المفتاح: غير صالح${data.error ? ` — ${data.error}` : ""}`);
    await load();
  }

  return (
    <Card className="border-slate-800 bg-slate-900/60">
      <CardHeader>
        <CardTitle className="text-lg">إدارة المفاتيح</CardTitle>
        <p className="text-sm text-slate-400">
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={add} className="grid gap-2 sm:grid-cols-[130px_1fr_150px_auto]">
          <select
            aria-label="المزود"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="h-9 rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
          >
            <option value="kie">kie.ai</option>
            <option value="cometapi">CometAPI</option>
          </select>
          <Input
            dir="ltr"
            placeholder="API key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            aria-label="المفتاح"
          />
          <Input
            placeholder="اسم اختياري"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="اسم المفتاح"
          />
          <Button type="submit" disabled={busy || !apiKey}>
            {busy ? "…" : "إضافة"}
          </Button>
        </form>
        {msg && <p className="text-sm text-slate-300">{msg}</p>}

        {keys.length === 0 ? (
          <p className="text-sm text-slate-500">لا توجد مفاتيح بعد — أضف مفتاحًا واحدًا على الأقل لتشغيل التوليد.</p>
        ) : (
          <div className="space-y-2">
            {keys.map((k) => (
              <div
                key={k.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm"
              >
                <span className="font-semibold text-slate-200">{k.provider === "kie" ? "kie.ai" : "CometAPI"}</span>
                <code dir="ltr" className="rounded bg-slate-900 px-2 py-0.5 text-xs text-cyan-300">{k.masked}</code>
                <span className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_STYLE[k.status] || ""}`}>
                  {STATUS_LABEL[k.status] || k.status}
                </span>
                {k.label && <span className="text-slate-400">{k.label}</span>}
                <span className="text-xs text-slate-500">
                  استخدام {k.usageCount} · نجاح {k.successCount} · فشل {k.failCount}
                </span>
                {k.lastError && (
                  <span className="w-full text-xs text-red-400" dir="ltr">
                    آخر خطأ: {k.lastError}
                  </span>
                )}
                <div className="ms-auto flex gap-1.5">
                  {k.status === "disabled" ? (
                    <Button size="sm" variant="outline" onClick={() => patch(k.id, "active")}>تفعيل</Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => patch(k.id, "disabled")}>تعطيل</Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => retest(k.id)}>إعادة اختبار</Button>
                  <Button size="sm" variant="destructive" onClick={() => remove(k.id)}>حذف</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
