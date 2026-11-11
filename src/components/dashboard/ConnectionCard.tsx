"use client";

// ConnectionCard — absolute MCP URL + copy-ready configs for the 3 client
// families + tool chips + the amber video-wait note (spec 9C).
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { Health } from "./Dashboard";

const TOOLS: Array<{ name: string; desc: string }> = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي مع تبديل مفاتيح تلقائي" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن (وصف أو صورة كبداية)" },
  { name: "merge_videos", desc: "دمج عدة مقاطع فيديو في ملف واحد بالترتيب" },
  { name: "get_task", desc: "متابعة حالة أي مهمة عبر task_id" },
  { name: "list_media", desc: "استعراض أحدث الوسائط المولّدة" },
];

function CopyBox({ title, content }: { title: string; content: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = content;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm text-slate-300">{title}</span>
        <Button size="sm" variant="outline" onClick={copy}>{copied ? "تم النسخ" : "نسخ"}</Button>
      </div>
      <pre dir="ltr" className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs leading-relaxed text-slate-300">
        {content}
      </pre>
    </div>
  );
}

export default function ConnectionCard({ health }: { health: Health | null }) {
  const [origin, setOrigin] = useState("");
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const mcpUrl = useMemo(() => `${origin}/mcp`, [origin]);
  const authHeader = health?.authRequired
    ? '\n      "headers": { "Authorization": "Bearer <ضع قيمة MCP_ACCESS_TOKEN من متغيرات البيئة>" }'
    : "";

  const configs = {
    chatgpt: `{
  "mcpServers": {
    "media-generator": {
      "url": "${mcpUrl}"${health?.authRequired ? "," : ""}
      ${authHeader ? ` ${authHeader.replace(/^\n\s*/, "").trim()}` : ""}
    }
  }
}
// الإعداد: Settings → Connectors → Create → Custom MCP server → Server URL`,
    claude: `{
  "mcpServers": {
    "media-generator": {
      "type": "http",
      "url": "${mcpUrl}"${health?.authRequired ? "," : ""}
      ${authHeader ? ` ${authHeader.replace(/^\n\s*/, "").trim()}` : ""}
    }
  }
}`,
    cursor: `{
  "mcpServers": {
    "media-generator": {
      "url": "${mcpUrl}"${health?.authRequired ? "," : ""}
      ${authHeader ? ` ${authHeader.replace(/^\n\s*/, "").trim()}` : ""}
    }
  }
}
// ملف mcp.json في إعدادات Cursor / Windsurf / Cline`,
  };

  return (
    <Card className="border-slate-800 bg-slate-900/60">
      <CardHeader>
        <CardTitle className="text-lg">ربط السيرفر بالتطبيقات</CardTitle>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <code dir="ltr" className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-cyan-300">{mcpUrl || "/mcp"}</code>
          <span className={`rounded-full border px-2 py-0.5 text-xs ${health?.authRequired ? "border-amber-500/30 text-amber-400" : "border-green-500/30 text-green-400"}`}>
            {health?.authRequired ? "محصي بـ MCP_ACCESS_TOKEN" : "مفتوح (بدون توكن)"}
          </span>
          <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-400">
            خدمة الدمج: {health?.merger?.healthy ? "جاهزة" : "غير متاحة"}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-1.5">
          {([
            ["chatgpt", "ChatGPT / GPT Agents"],
            ["claude", "Claude Desktop"],
            ["cursor", "Cursor / Windsurf / Cline"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-lg px-3 py-1.5 text-sm ${tab === key ? "bg-cyan-500/15 text-cyan-300 border border-cyan-500/30" : "text-slate-400 hover:text-slate-200"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <CopyBox title="الإعداد جاهز للنسخ:" content={configs[tab]} />

        <div className="flex flex-wrap gap-2">
          {TOOLS.map((t) => (
            <span key={t.name} className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-xs" title={t.desc}>
              <code dir="ltr" className="text-violet-300">{t.name}</code> — {t.desc}
            </span>
          ))}
        </div>

        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
          الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
        </div>
      </CardContent>
    </Card>
  );
}
