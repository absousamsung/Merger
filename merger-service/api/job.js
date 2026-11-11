// job.js — GET /api/jobs/:id (status) and DELETE /api/jobs/:id (full cascade).
'use strict';

const { query, nowIso } = require('../lib/db');
const { purgeExpired, deleteJobRows } = require('../lib/storage');
const { send, methodNotAllowed, extractId, logLine, newRequestId, publicBase } = require('../lib/util');

async function loadJobWithSources(id) {
  const jobRes = await query('SELECT * FROM jobs WHERE id = ?', [id]);
  if (!jobRes.rows.length) return null;
  const srcRes = await query('SELECT seq, kind, url, name, mime, size, received_bytes FROM sources WHERE job_id = ? ORDER BY seq', [id]);
  const job = jobRes.rows[0];
  return {
    jobId: job.id,
    status: job.status,
    progress: Number(job.progress),
    error: job.error || undefined,
    size: job.output_size != null ? Number(job.output_size) : undefined,
    duration: job.output_duration != null ? Number(job.output_duration) : undefined,
    resolution: job.output_resolution || undefined,
    createdAt: job.created_at,
    expiresAt: job.expires_at,
    sources: srcRes.rows.map((r) => ({
      seq: Number(r.seq),
      kind: r.kind,
      name: r.name || undefined,
      url: r.kind === 'url' ? r.url : undefined,
      size: Number(r.size || 0),
      receivedBytes: Number(r.received_bytes || 0),
    })),
    raw: job,
  };
}

function buildLinks(base, id, job) {
  if (job.status !== 'done') return job;
  job.videoUrl = `${base}/api/jobs/${id}/video`;
  job.downloadUrl = `${base}/api/jobs/${id}/video?download=1`;
  return job;
}

module.exports = async (req, res) => {
  const requestId = newRequestId();
  try {
    const id = extractId(req, req.query);
    if (!id) return send(res, 404, { error: 'المهمة غير موجودة' });
    if (req.method === 'GET') {
      await purgeExpired(nowIso());
      const job = await loadJobWithSources(id);
      if (!job) return send(res, 404, { error: 'المهمة غير موجودة' });
      delete job.raw;
      const withLinks = buildLinks(publicBase(req), id, job);
      logLine(requestId, 'job status', { jobId: id, status: job.status, progress: job.progress });
      return send(res, 200, withLinks);
    }
    if (req.method === 'DELETE') {
      const job = await query('SELECT id FROM jobs WHERE id = ?', [id]);
      if (!job.rows.length) return send(res, 404, { error: 'المهمة غير موجودة' });
      await deleteJobRows(id);
      logLine(requestId, 'job deleted', { jobId: id });
      return send(res, 200, { ok: true });
    }
    return methodNotAllowed(res);
  } catch (err) {
    logLine(requestId, 'job endpoint error', { error: err.message });
    return send(res, 500, { error: 'خطأ داخلي غير متوقع' });
  }
};
