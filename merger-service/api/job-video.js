// job-video.js — GET /api/jobs/:id/video with HTTP Range support (206 + Content-Range),
// streaming 2 MB rows in 8-row pages; ?download=1 forces attachment.
'use strict';

const { query } = require('../lib/db');
const storage = require('../lib/storage');
const { send, extractId, newRequestId, logLine } = require('../lib/util');

function parseRange(header, total) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { invalid: true };
  const [, a, b] = m;
  let start;
  let end;
  if (a === '' && b === '') return { invalid: true };
  if (a === '') {
    // suffix range: last N bytes
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return { invalid: true };
    if (n >= total) return { start: 0, end: total - 1 };
    start = total - n;
    end = total - 1;
  } else {
    start = Number(a);
    if (!Number.isFinite(start) || start >= total) return { unsatisfiable: true };
    end = b === '' ? total - 1 : Math.min(Number(b), total - 1);
    if (Number.isFinite(Number(b)) && Number(b) < start) return { invalid: true };
  }
  return { start, end };
}

async function streamRange(res, jobId, start, end, headers) {
  res.writeHead(206, headers);
  for await (const piece of storage.readOutputRange(jobId, start, end)) {
    if (!res.write(piece)) await new Promise((r) => res.once('drain', r));
  }
  res.end();
}

module.exports = async (req, res) => {
  const requestId = newRequestId();
  const jobId = extractId(req, req.query);
  if (!jobId) return send(res, 404, { error: 'المهمة غير موجودة' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'الطريقة غير مسموحة' });

  try {
    const jobRes = await query('SELECT status, output_size FROM jobs WHERE id = ?', [jobId]);
    if (!jobRes.rows.length) return send(res, 404, { error: 'المهمة غير موجودة' });
    if (jobRes.rows[0].status !== 'done') return send(res, 409, { error: 'الفيديو غير جاهز بعد' });
    const meta = await storage.outputMeta(jobId);
    if (!meta.chunks) return send(res, 404, { error: 'المهمة غير موجودة' });
    const total = meta.bytes;

    const download = req.query && req.query.download === '1';
    const headers = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="merged-${jobId}.mp4"`,
    };

    if (req.method === 'HEAD') {
      headers['Content-Length'] = String(total);
      res.writeHead(200, headers);
      return res.end();
    }

    const range = parseRange(req.headers.range, total);
    logLine(requestId, 'video stream', { jobId, range: req.headers.range || 'full' });
    if (range && range.invalid) return send(res, 400, { error: 'نطاق بايتات غير صالح' });
    if (range && range.unsatisfiable) {
      return send(res, 416, { error: 'النطاق المطلوب غير متاح' }, { 'Content-Range': `bytes */${total}` });
    }
    if (!range) {
      headers['Content-Length'] = String(total);
      res.writeHead(200, headers);
      for await (const piece of storage.readOutputRange(jobId, 0, total - 1)) {
        if (!res.write(piece)) await new Promise((r) => res.once('drain', r));
      }
      return res.end();
    }
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${total}`;
    headers['Content-Length'] = String(range.end - range.start + 1);
    return await streamRange(res, jobId, range.start, range.end, headers);
  } catch (err) {
    logLine(requestId, 'video stream error', { jobId, error: err.message });
    if (!res.headersSent) return send(res, 500, { error: 'خطأ داخلي غير متوقع' });
    try { res.end(); } catch (_) {}
  }
};
