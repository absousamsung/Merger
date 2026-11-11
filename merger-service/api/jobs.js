// jobs.js — POST /api/jobs: create a merge job from URLs and/or file sources.
'use strict';

const { query, batch, expiresAtIso, nowIso } = require('../lib/db');
const { purgeExpired, sourceChunksInfo } = require('../lib/storage');
const { LIMITS, send, newJobId, logLine, newRequestId, clientIp, publicBase } = require('../lib/util');
const { checkRateLimit } = require('../lib/ratelimit');
const { assertPublicHttpUrl } = require('../lib/ssrf');

const ALLOWED_EXT = /\.(mp4|mov|webm|mkv|avi|m4v|mpg|3gp)$/i;

// Normalizes the request body into a validated sources array.
async function parseSources(body) {
  const list = [];
  if (body && Array.isArray(body.videos)) {
    for (const v of body.videos) list.push({ kind: 'url', url: String(v || '') });
  } else if (body && Array.isArray(body.sources)) {
    for (const s of body.sources) {
      if (!s || typeof s !== 'object') throw new Error('مصدر غير صالح');
      if (s.kind === 'url') list.push({ kind: 'url', url: String(s.url || '') });
      else if (s.kind === 'file') {
        list.push({
          kind: 'file',
          name: String(s.name || 'file').slice(0, 200),
          mime: String(s.mime || 'application/octet-stream').slice(0, 100),
          size: Number(s.size) || 0,
        });
      } else throw new Error('نوع المصدر غير معروف');
    }
  }
  if (!list.length) throw new Error('قائمة الفيديوهات مطلوبة (رابط واحد على الأقل أو ملف)');
  if (list.length > LIMITS.maxSources) throw new Error(`أقصى عدد مقاطع هو ${LIMITS.maxSources}`);
  let declaredTotal = 0;
  for (const s of list) {
    if (s.kind === 'url') {
      await assertPublicHttpUrl(s.url); // SSRF gate at creation time (fetch re-validates later)
    } else {
      if (!ALLOWED_EXT.test(s.name) && s.mime && !/^video\//.test(s.mime)) {
        throw new Error('نوع الملف غير مدعوم');
      }
      if (s.size > LIMITS.sourceMaxBytes) {
        throw new Error(`حجم المصدر يتجاوز الحد المسموح (${Math.floor(LIMITS.sourceMaxBytes / (1024 * 1024))} MB)`);
      }
      declaredTotal += s.size;
    }
  }
  if (declaredTotal > LIMITS.maxTotalSourcesBytes) {
    throw new Error(`مجموع أحجام المصادر كبير جدًا للمعالجة (الحد ${Math.floor(LIMITS.maxTotalSourcesBytes / (1024 * 1024))} MB)`);
  }
  return list;
}

module.exports = async (req, res) => {
  const requestId = newRequestId();
  if (req.method !== 'POST') return send(res, 405, { error: 'الطريقة غير مسموحة' });
  try {
    await purgeExpired(nowIso());
    const ip = clientIp(req);
    const rl = await checkRateLimit(ip, 'jobs');
    if (!rl.allowed) return send(res, 429, { error: 'تم تجاوز الحد المسموح من الطلبات، حاول لاحقًا' });

    const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
      ? req.body
      : {};
    const sources = await parseSources(body);
    const jobId = newJobId();
    const created = nowIso();
    const expires = expiresAtIso(created);
    const hasFiles = sources.some((s) => s.kind === 'file');

    await batch([
      { sql: 'INSERT INTO jobs (id, status, progress, created_at, expires_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)', args: [jobId, hasFiles ? 'uploading' : 'queued', created, expires, created] },
      ...sources.map((s, seq) => ({
        sql: 'INSERT INTO sources (job_id, seq, kind, url, name, mime, size, received_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
        args: [jobId, seq, s.kind, s.url || null, s.name || null, s.mime || null, s.size || 0],
      })),
    ]);

    const base = publicBase(req);
    const payload = {
      jobId,
      status: hasFiles ? 'uploading' : 'queued',
      statusUrl: `${base}/api/jobs/${jobId}`,
      processUrl: `${base}/api/jobs/${jobId}/process`,
      expiresAt: expires,
    };
    if (hasFiles) {
      payload.uploadChunkBytes = LIMITS.uploadChunkBytes;
      payload.uploads = [];
      for (let seq = 0; seq < sources.length; seq++) {
        if (sources[seq].kind !== 'file') continue;
        const info = await sourceChunksInfo(jobId, seq);
        payload.uploads.push({
          seq,
          name: sources[seq].name,
          url: `${base}/api/upload?job=${jobId}&seq=${seq}&chunk=`,
          uploadedBytes: info.bytes,
        });
      }
    }
    logLine(requestId, 'job created', { jobId, sources: sources.length, hasFiles });
    return send(res, 201, payload);
  } catch (err) {
    const msg = err && err.name === 'SsrfError' ? err.message : `طلب غير صالح: ${err.message}`;
    logLine(requestId, 'create failed', { error: msg });
    return send(res, 400, { error: msg });
  }
};
