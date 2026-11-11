"use client";

// LoginGate — password form → signed httpOnly cookie.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginGate({ passwordConfigured }: { passwordConfigured: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "تعذر تسجيل الدخول");
        return;
      }
      router.refresh();
    } catch {
      setError("تعذر الاتصال بالسيرفر");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center text-lg">لوحة إدارة مولّد الوسائط</CardTitle>
        </CardHeader>
        <CardContent>
          {!passwordConfigured ? (
            <p className="text-sm text-muted-foreground text-center">
              لم يُضبط ADMIN_PASSWORD على السيرفر — لا يمكن تسجيل الدخول حتى يُضاف إلى متغيرات البيئة.
            </p>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <Input
                type="password"
                dir="ltr"
                placeholder="كلمة مرور المدير"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-label="كلمة مرور المدير"
              />
              {error && <p className="text-sm text-red-500">{error}</p>}
              <Button type="submit" className="w-full" disabled={busy || !password}>
                {busy ? "جارٍ التحقق…" : "دخول"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
