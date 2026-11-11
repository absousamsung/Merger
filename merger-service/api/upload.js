// upload.js — POST /api/upload?job=<id>&seq=<n>&chunk=<k> (binary octet-stream <= 4 MB).
'use strict';

const { query, batch, nowIso } = require('../lib/db');
const { writeSourceChunk, sourceChunksInfo, countChunks } = require('../lib/storage');
const { LIMITS, send, newRequestId, logLine, clientIp } = require('../lib/util');
const { checkRateLimit } = require('../lib/ratelimit');

function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'binary');
  if (body && body instanceof Uint8Array) return Buffer.from(body);
  return null;
}

module.exports = async (req, res) => {
  const requestId = newRequestId();
  if (req.method !== 'POST') return send(res, 405, { error: 'الطريقة غير مسموحة' });
  try {
    const q = req.query || {};
    const jobId = String(q.job || '');
    const seq = Number(q.seq);
    const chunk = Number(q.chunk);
    if (!jobId || !Number.isInteger(seq) || seq < 0 || !Number.isInteger(chunk) || chunk < 0) {
      return send(res, 400, { error: 'طلب غير صالح: معاملات الرفع ناقصة أو خاطئة' });
    }
    const rl = await checkRateLimit(clientIp(req), 'upload');
    if (!rl.allowed) return send(res, 429, { error: 'تم تجاوز الحد المسموح من الطلبات، حاول لاحقًا' });

    const buf = toBuffer(req.body);
    if (!buf || !buf.length) return send(res, 400, { error: 'طلب غير صالح: محتوى المقطع مفقود' });
    if (buf.length > LIMITS.uploadChunkBytes) return send(res, 413, { error: 'حجم المقطع يتجاوز الحد المسموح (4 MB)' });

    const srcRes = await query('SELECT seq, kind, size, received_bytes FROM sources WHERE job_id = ? AND seq = ?', [jobId, seq]);
    if (!srcRes.rows.length) return send(res, 404, { error: 'المهمة أو المصدر غير موجود' });
    const source = srcRes.rows[0];
    if (source.kind !== 'file') return send(res, 409, { error: 'هذا المصدر ليس ملفًا مرفوعًا' });

    const jobRes = await query('SELECT status FROM jobs WHERE id = ?', [jobId]);
    if (!jobRes.rows.length) return send(res, 404, { error: 'المهمة غير موجودة' });
    const status = jobRes.rows[0].status;
    if (status !== 'queued' && status !== 'uploading') {
      return send(res, 409, { error: 'حالة المهمة لا تسمح بهذه العملية' });
    }

    const size = Number(source.size || 0);
    const offset = chunk * LIMITS.uploadChunkBytes;
    const newEnd = offset + buf.length;
    if (size > 0 && newEnd > size) return send(res, 413, { error: 'حجم الملف يتجاوز الحد المسموح' });

    await writeSourceChunk(jobId, seq, chunk, buf);
    const received = Math.max(Number(source.received_bytes || 0), newEnd);
    await batch([
      { sql: 'UPDATE sources SET received_bytes = ? WHERE job_id = ? AND seq = ?', args: [received, jobId, seq] },
      ...(status === 'queued' ? [{ sql: `UPDATE jobs SET status = 'uploading', updated_at = ? WHERE id = ?`, args: [nowIso(), jobId] }] : []),
    ]);
    logLine(requestId, 'chunk stored', { jobId, seq, chunk, bytes: buf.length });
    return send(res, 200, { ok: true, jobId, seq, chunk, bytes: buf.length, receivedBytes: received });
  } catch (err) {
    logLine(requestId, 'upload error', { error: err.message });
    return send(res, 500, { error: 'خطأ داخلي غير متوقع' });
  }
};
