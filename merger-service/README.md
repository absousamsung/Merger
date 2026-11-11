# خدمة دمج الفيديوهات (المرحلة الأولى)

موقع عام + واجهة REST تدمج حتى **10 مقاطع فيديو** (من روابط و/أو ملفات مرفوعة) في ملف **MP4 واحد عالي الجودة** (H.264 + AAC)، ويُخزَّن الناتج في قاعدة بيانات **Turso** لمدة **24 ساعة** ثم يُحذف تلقائيًا.

- الكود: Node.js 20 (CommonJS) بدون إطار عمل — جاهز لدوال Vercel الخادمية.
- محرك الدمج: FFmpeg بنمر one-pass مع `filter_complex` (توحيد الدقة + الدمج)، جودة CRF 18.
- التخزين: أجزاء BLOB بحجم 2 MB لكل صف عبر `@libsql/client` (HTTP)، مع بث مُقسّم لطلبات Range.
- الواجهة: ملف واحد `public/index.html` عربي RTL بثيم داكن مع تدرجات سماوي/بنفسجي.

## المعمارية

```
المتصفح ──▶ /api/jobs (إنشاء مهمة: روابط و/أو بيانات ملفات)
        └─▶ /api/upload  (رفع الملفات على أجزاء 4 MB مع إعادة محاولة)
        └─▶ /api/jobs/<id>/process  (مزامنة: تنزيل المصادر → ffprobe → ffmpeg concat → تخزين)
        └─▶ /api/jobs/<id>          (الحالة والتقدم 0-100)
        └─▶ /api/jobs/<id>/video    (بث الناتج مع دعم Range و ?download=1)
        └─ DELETE /api/jobs/<id>    (حذف فوري لكل بيانات المهمة)
قاعدة Turso: jobs, sources, source_chunks (أجزاء الرفع), output_chunks (الناتج), rate_limits
حذف تلقائي: expires_at = الإنشاء + 24 ساعة — تنظيف فوري عند كل استدعاء + cron يومي
```

## واجهة API (عامة بدون مصادقة)

استبدل `BASE` بعنوان النشر، و`JOB_ID` بمعرف المهمة.

**1) إنشاء مهمة من روابط**
```bash
curl -X POST BASE/api/jobs -H "Content-Type: application/json" \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'
# 201 → {"jobId","status":"queued","statusUrl","processUrl","expiresAt"}
```

**2) إنشاء مهمة مع ملفات (رفع على أجزاء)**
```bash
curl -X POST BASE/api/jobs -H "Content-Type: application/json" \
  -d '{"sources":[{"kind":"url","url":"https://example.com/a.mp4"},{"kind":"file","name":"b.mp4","size":123456,"mime":"video/mp4"}]}'
# 201 → يحتوي uploads[] و uploadChunkBytes، ثم لكل جزء:
curl -X POST "BASE/api/upload?job=JOB_ID&seq=1&chunk=0" -H "Content-Type: application/octet-stream" --data-binary @part0
```

**3) تشغيل الدمج (متزامن — يستغرق ثوانٍ إلى دقائق)**
```bash
curl -X POST BASE/api/jobs/JOB_ID/process
# 200 → {"status":"done","videoUrl","downloadUrl","size","duration","resolution","expiresAt"}
# 202 → المهمة قيد المعالجة بالفعل    500 → {"error":"رسالة بالعربية"}
```

**4) متابعة الحالة**
```bash
curl BASE/api/jobs/JOB_ID
# {"status":"queued|uploading|processing|done|failed","progress":0-100,...}
```

**5) بث/تنزيل الناتج مع دعم Range**
```bash
curl -H "Range: bytes=0-1023" -o part.bin BASE/api/jobs/JOB_ID/video   # 206 + Content-Range
curl -OJ "BASE/api/jobs/JOB_ID/video?download=1"                        # تنزيل إجباري
```

**6) حذف كل بيانات المهمة فورًا**
```bash
curl -X DELETE BASE/api/jobs/JOB_ID
```

**7) الحدود العامة + التنظيف**
```bash
curl BASE/api/config     # الحدود والاصدار
curl BASE/api/cron       # حذف المهام المنتهية (محمي بـ CRON_SECRET إن وُجد)
```

**رموز الحالة:** 400 إدخال غير صالح، 404 غير موجود، 405 طريقة خاطئة، 409 حالة غير صالحة/رفع ناقص، 413 تجاوز الحجم، 429 تجاوز حد الطلبات أو انشغال الخدمة، 500 فشل معالجة. كل الأخطاء بالعربية بصيغة `{"error":"..."}`.

## المتغيرات البيئية

| المتغير | مطلوب | الافتراضي | الوصف |
|---|---|---|---|
| `TURSO_DATABASE_URL` | نعم | — | رابط قاعدة Turso (`libsql://...`) |
| `TURSO_AUTH_TOKEN` | نعم | — | رمز الوصول للقاعدة |
| `MAX_SOURCES` | لا | 10 | أقصى عدد مقاطع لكل مهمة |
| `SOURCE_MAX_MB` | لا | 100 | أقصى حجم لكل مصدر (انظر ملاحظة /tmp) |
| `OUTPUT_MAX_MB` | لا | 150 | أقصى حجم للناتج |
| `MAX_TOTAL_SOURCES_MB` | لا | 300 | أقصى مجموع أحجام المصادر المرفوعة |
| `MAX_TOTAL_DURATION_SEC` | لا | 600 | أقصى مدة إجمالية للناتج |
| `FFMPEG_PRESET` | لا | (تلقائي) | x264 preset؛ إذا تُرك فارغًا يُستخدم `faster` تلقائيًا للمدد > 240 ثانية وإلا `medium` |
| `MAX_CONCURRENT_PROCESSES` | لا | 2 | سقف المهام قيد المعالجة عالميًا |
| `RATE_LIMIT_JOBS_PER_HOUR` | لا | 30 | حد إنشاء المهام لكل IP في الساعة |
| `RATE_LIMIT_UPLOADS_PER_HOUR` | لا | 600 | حد أجزاء الرفع لكل IP في الساعة |
| `SOURCE_TIMEOUT_SEC` | لا | 180 | مهلة تنزيل المصدر |
| `CRON_SECRET` | لا | — | يحمي `/api/cron` عند ضبطه |

## النشر على Vercel خطوة بخطوة

1. **أنشئ قاعدة Turso**: `turso db create merger` ثم `turso db show merger --url` (الرابط) و `turso db tokens create merger` (الرمز).
2. **اربط المستودع بـ Vercel**: New Project → اختر المستودع → في إعدادات البناء اضبط **Root Directory = `merger-service`** (المشروع في مجلد فرعي).
3. **أضف متغيرات البيئة** أعلاه (Settings → Environment Variables) — المطلوب حتمًا: `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN`.
4. **انشر** — ملف `vercel.json` يضبط `maxDuration = 300` لكل الدوال، و `rewrites` للمسارات الديناميكية، و cron يومي على `/api/cron` (03:00 UTC).
5. **اختبر بعد النشر**: `curl https://YOUR-APP.vercel.app/api/config` ثم أنشئ مهمة من روابط وشغّلها كما في الأمثلة أعلاه.

## فحوصات واقعية المنصة (تحقق من خطتك الحالية)

| البند | القيمة | الأثر على هذه الخدمة |
|---|---|---|
| مدة الدالة على Vercel | Hobby حتى 300 ثانية (مع Fluid compute) / خطط أعلى حتى 800 ثانية | سقف 300 ثانية في `vercel.json` يغطي الدمج النموذجي؛ أسوأ حالة (600 ثانية فيديو) قد تتجاوزه على Hobby — يخففها الـ preset الأسرع تلقائيًا بعد 240 ثانية أو تخفيض `MAX_TOTAL_DURATION_SEC`. تحقق من حصتك في لوحة Vercel. |
| الذاكرة | افتراضي ~1 GB (Fluid) | ترميز 1080p بمساحة ذاكرة معقولة؛ لخطط أعلى يمكن رفعها. |
| حجم `/tmp` | ≈ 512 MB | لذلك الافتراضيات: 100 MB/مصدر، 300 MB مجموع، 150 MB ناتج — الأسوأ النظري (10×200 MB) غير ممكن على Vercel، والتجاوز يُرفض برسالة واضحة قبل العمل وليس انهيارًا. |
| حد حجم جسم الطلب | ≈ 4.5 MB | الرفع على أجزاء 4 MB مع إعادة محاولة تلقائية (3) لكل جزء. |
| Turso المجاني | تخزين محدود (راجع docs.turso.io للحدود الحالية) وحجم صف عبر HTTP | أجزاء 2 MB لكل صف وبث بصفحات 8 صفوف؛ الناتج يُحذف بعد 24 ساعة فلا تتراكم البيانات. |
| سقف 300 ثانية مقابل 600 ثانية فيديو | انظر أعلاه | للمدد الطويلة: preset أسرع تلقائيًا، أو خفّض الحدود، أو انشر على خطة بمدة أعلى. |

## الأمان

- **SSRF**: روابط المصادر تُقبل فقط عبر http/https، مع فحص كل عنوان DNS محلول (loopback/خاص/link-local/CGNAT/metadata)، وإعادة فحص بعد كل إعادة توجيه (بحد أقصى 3)، ورفض الروابط التي تحوي بيانات دخول.
- **تحقق من نوع الملف فعليًا** عبر ffprobe لا الامتداد.
- **حدود معدل الطلبات** لكل IP في قاعدة البيانات + سقف معالجة متزامنة عالمي.
- **روابط نتائج غير قابلة للتخمين** (12 حرفًا عشوائيًا) ولا تكشف أي نطاقات داخلية.
- لا تُسجَّل أي أسرار في السجلات أو الردود.

## الاختبارات محليًا

```bash
npm install
npm run test        # وحدات (9 اختبارات) + HTTP (29 حالة) ضد خادم تطوير على 3101
npm run dev         # خادم التطوير على 3001 + الواجهة على http://localhost:3001
```

> الاختبارات تكتب وتحذف بياناتها في قاعدة Turso الحقيقية — تأكد من ضبط `.env` أولًا.
