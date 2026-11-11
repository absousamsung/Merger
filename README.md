# منصة توليد الوسائط بالذكاء الاصطناعي — مشروعَان في مستودع واحد

هذا المستودع يحتوي على **المرحلتين** اللتين تعملان معًا:

| المجلد | المشروع | الوصف |
|---|---|---|
| `/` (الجذر) | **المرحلة 2 — mcp-media-generator** | تطبيق Next.js يعرض **سيرفر MCP على `/mcp`** بخمس أدوات (توليد صور، توليد فيديو بصوت متزامن، دمج مقاطع، متابعة المهام، سجل الوسائط) + **لوحة إدارة عربية RTL** لإدارة مفاتيح API ومتابعة المهام الحية ونسخ إعدادات الربط الجاهزة. |
| `/merger-service` | **المرحلة 1 — Video Merger Service** | موقع عام + REST API يدمج حتى 10 مقاطع (روابط و/أو ملفات مرفوعة) في MP4 واحد عالي الجودة (H.264+AAC، CRF 18)، يُخزَّن في Turso لمدة 24 ساعة ثم يُحذف تلقائيًا. |

- المزودون: **kie.ai** (أساسي) و **CometAPI** (احتياطي) — التجربة **تسلسلية حسب ترتيب إضافة المفاتيح** مع تبديل فوري عند أي خطأ أو نفاد رصيد، دون توقف المهمة ولا ظهور أي إشارة للمفاتيح/الرصيد للعميل.
- قاعدة البيانات: **Turso** (`@libsql/client` عبر HTTP) — بلا ملفات محلية، جاهز للعمل على Vercel.

النماذج المدمجة:
- صور: `gpt-image-2-6/flare-text-to-image`
- فيديو: `grok-imagine-video-1-5-preview` (صوت متزامن أصلي + إمكانية image-to-video)

---

## النشر على Vercel (مشروعان منفصلان من نفس المستودع)

> انشر **المرحلة 1 أولًا**، ثم استخدم رابطها كـ `MERGER_API_BASE` للمرحلة 2.

### 1) قاعدة Turso (مرة واحدة)
```bash
turso db create absdb
turso db show absdb --url          # → TURSO_DATABASE_URL (libsql://...)
turso db tokens create absdb       # → TURSO_AUTH_TOKEN
```

### 2) المرحلة 1 — خدمة الدمج
1. Vercel → **Add New → Project** → اختر هذا المستودع.
2. **Settings → General → Root Directory = `merger-service`**.
3. **Settings → Environment Variables** — أضف:
   | المتغير | مطلوب |
   |---|---|
   | `TURSO_DATABASE_URL` | نعم |
   | `TURSO_AUTH_TOKEN` | نعم |
   | `MAX_SOURCES` / `SOURCE_MAX_MB` / `OUTPUT_MAX_MB` / `MAX_TOTAL_SOURCES_MB` / `MAX_TOTAL_DURATION_SEC` / `FFMPEG_PRESET` / `CRON_SECRET` | اختياري (انظر `merger-service/README.md`) |
4. Deploy — `vercel.json` يضبط `maxDuration=300` لكل الدوال و cron يومي على `/api/cron`.
5. تحقق: `curl https://<merger>.vercel.app/api/config`

### 3) المرحلة 2 — مولّد الوسائط (MCP)
1. Vercel → **Add New → Project** → نفس المستودع مرة أخرى.
2. **Root Directory = `/`** (اتركه فارغًا — الجذر هو تطبيق Next.js).
3. **Environment Variables**:
   | المتغير | مطلوب | ملاحظة |
   |---|---|---|
   | `TURSO_DATABASE_URL` | نعم | نفس قاعدة المرحلة 1 |
   | `TURSO_AUTH_TOKEN` | نعم | |
   | `MERGER_API_BASE` | نعم | `https://<merger>.vercel.app` (رابط المرحلة 1) |
   | `ADMIN_PASSWORD` | نعم | يحمي لوحة الإدارة و`/api/keys*` و`/api/tasks*` |
   | `MCP_ACCESS_TOKEN` | يُنصح بشدة | يحمي `/mcp` — بدونه يستطيع أي شخص إنفاق رصيدك |
   | `ENCRYPTION_KEY` | اختياري | 32 بايت base64 — تشفير المفاتيح في القاعدة (أضفه ثم أعد إضافة المفاتيح لتشفيرها) |
   | `STUCK_TASK_MAX_MINUTES` | اختياري | افتراضي 60 |
   | `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` / `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | اختياري | تجاوز معرفات النماذج |
4. Deploy، ثم افتح `https://<app>.vercel.app` → سجّل دخول لوحة الإدارة → أضف مفتاح kie.ai.
5. تحقق: `curl https://<app>.vercel.app/api/health`

---

## ربط تطبيقات الدردشة بسيرفر MCP

- الرابط: `https://<app>.vercel.app/mcp` (وضع عديم الحالة — لا يحتاج جلسات).
- إن ضبطت `MCP_ACCESS_TOKEN`: أضف الترويسة `Authorization: Bearer <القيمة>`.

**ChatGPT / GPT Agents**: Settings → Connectors → Create → Custom MCP server → Server URL، وإعدادات JSON:
```json
{ "mcpServers": { "media-generator": { "url": "https://<app>.vercel.app/mcp" } } }
```
**Claude Desktop** (mcp.json):
```json
{ "mcpServers": { "media-generator": { "type": "http", "url": "https://<app>.vercel.app/mcp" } } }
```
**Cursor / Windsurf / Cline**: نفس الصيغة أعلاه داخل `mcp.json`.

تظهر لوحة الإدارة هذه الإعدادات جاهزة للنسخ مع الرابط الفعلي.

## اختبار سريع بعد النشر (curl)

```bash
APP=https://<app>.vercel.app
# فحص الصحة
curl $APP/api/health
# قائمة الأدوات (وضع عديم الحالة — لا حاجة لمعرف جلسة)
curl -s -X POST $APP/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
curl -s -X POST $APP/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
# توليد صورة حقيقية (بعد إضافة مفتاح صالح من اللوحة)
curl -s -X POST $APP/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"قطة صغيرة ترتدي قبعة، رسم مسطح","wait_seconds":90}}}'
```

## حدود الاستضافة المجانية المهمة

- **Vercel**: مدة الدالة حتى 300 ثانية (Fluid) — ملاحظة: أسوأ حالة دمج (600 ثانية فيديو) قد تحتاج preset أسرع (تلقائي بعد 240 ثانية) أو خطة أطول. حد `/tmp` ≈512 MB — لذلك حدود خدمة الدمج الافتراضية: 100 MB/مصدر، 300 MB مجموع، 150 MB ناتج. حد جسم الطلب ≈4.5 MB — الرفع على أجزاء 4 MB.
- **Turso**: الخطة المجانية محدودة التخزين والقراءة/الكتابة (راجع docs.turso.io) — أجزاء BLOB بحجم 2 MB لكل صف، والحذف التلقائي بعد 24 ساعة يمنع التراكم.

## الاختبارات

```bash
# المرحلة 1
cd merger-service && npm install && npm test          # 9 وحدات + 29 HTTP
# المرحلة 2
npm install && npm run typecheck && npm run build     # tsc نظيف + بناء ناجح
```

تفاصيل القرارات الهندسية: `DECISIONS.md` (المرحلة 2) و `merger-service/DECISIONS.md` (المرحلة 1).
