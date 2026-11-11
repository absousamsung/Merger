// job-process.js — POST /api/jobs/:id/process. Synchronous: claim -> fetch/assemble
// sources -> probe -> encode (CRF 18) -> store output chunks -> respond.
// Two simultaneous calls can never encode twice: the atomic claim UPDATE decides.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { query, batch, nowIso } = require('../lib/db');
const storage = require('../lib/storage');
const { guardedDownload } = require('../lib/fetcher');
const { runMergeEngine } = require('../lib/merge');
const { LIMITS, send, extractId, logLine, newRequestId, publicBase } = require('../lib/util');
const { concurrencySlotAvailable } = require('../lib/ratelimit');
const { SsrfError } = require('../lib/ssrf');

const CLAIM_GRACE_MS = 10 * 60 * 1000; // allow takeover of a stale crashed run

async function setProgress(jobId, progress) {
  await query('UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?', [progress, nowIso(), jobId]);
}

async function setFailed(jobId, message) {
  await query(`UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, [message, nowIso(), jobId]);
}

async function claimJob(jobId) {
  // Atomic claim — the conditional UPDATE decides ownership via affected rows,
  // so two simultaneous calls can never both encode the same job.
  const claim = await query(
    `UPDATE jobs SET status = 'processing', progress = 5, updated_at = ?
     WHERE id = ? AND status IN ('queued','uploading')`,
    [nowIso(), jobId]
  );
  if (Number(claim.rowsAffected) === 1) return { ok: true };

  const res = await query('SELECT status, updated_at FROM jobs WHERE id = ?', [jobId]);
  if (!res.rows.length) return { ok: false, code: 404 };
  const row = res.rows[0];
  if (row.status === 'processing') {
    // Stale takeover (a previous serverless run crashed mid-encode): compare-and-swap
    // on the exact stale timestamp so only one reclaiming call wins.
    const age = Date.now() - new Date(row.updated_at || 0).getTime();
    if (age > CLAIM_GRACE_MS) {
      const reclaim = await query(
        `UPDATE jobs SET updated_at = ? WHERE id = ? AND status = 'processing' AND updated_at = ?`,
        [nowIso(), jobId, row.updated_at]
      );
      if (Number(reclaim.rowsAffected) === 1) return { ok: true, reclaimed: true };
    }
    return { ok: false, code: 202 };
  }
  return { ok: false, code: 409 };
}

async function loadSources(jobId) {
  const res = await query('SELECT seq, kind, url, name, mime, size, received_bytes FROM sources WHERE job_id = ? ORDER BY seq', [jobId]);
  return res.rows.map((r) => ({
    seq: Number(r.seq),
    kind: r.kind,
    url: r.url,
    name: r.name,
    size: Number(r.size || 0),
    receivedBytes: Number(r.received_bytes || 0),
  }));
}

module.exports = async (req, res) => {
  const requestId = newRequestId();
  const jobId = extractId(req, req.query);
  if (!jobId) return send(res, 404, { error: 'المهمة غير موجودة' });
  if (req.method !== 'POST') return send(res, 405, { error: 'الطريقة غير مسموحة' });

  try {
    await storage.purgeExpired(nowIso());

    if (!(await concurrencySlotAvailable())) {
      return send(res, 429, { error: 'الخدمة مشغولة حاليًا، حاول بعد لحظات' });
    }

    const claim = await claimJob(jobId);
    if (!claim.ok) {
      if (claim.code === 404) return send(res, 404, { error: 'المهمة غير موجودة' });
      if (claim.code === 202) {
        const cur = await query('SELECT progress FROM jobs WHERE id = ?', [jobId]);
        return send(res, 202, { status: 'processing', progress: cur.rows.length ? Number(cur.rows[0].progress) : 0 });
      }
      return send(res, 409, { error: 'حالة المهمة لا تسمح بهذه العملية' });
    }

    const sources = await loadSources(jobId);
    if (!sources.length) throw new Error('لا توجد مصادر لهذه المهمة');

    // Upload completeness (declared-size files must be fully received).
    let declaredTotal = 0;
    for (const s of sources) {
      if (s.kind === 'file') {
        if (s.size > 0 && s.receivedBytes !== s.size) throw new Error('الرفع غير مكتمل بعد');
        if (s.size === 0 && s.receivedBytes === 0) throw new Error('الرفع غير مكتمل بعد');
        declaredTotal += s.size > 0 ? s.size : s.receivedBytes;
      }
    }
    if (declaredTotal > LIMITS.maxTotalSourcesBytes) {
      throw new Error(`مجموع أحجام المصادر كبير جدًا للمعالجة (الحد ${Math.floor(LIMITS.maxTotalSourcesBytes / (1024 * 1024))} MB)`);
    }

    // Prepare sources in /tmp, one at a time; progress 0-40 across all sources.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `merge-${jobId}-`));
    const localFiles = [];
    let tmpFileWritten = false;
    try {
      const fetchUnit = 40 / sources.length;
      for (let i = 0; i < sources.length; i++) {
        const s = sources[i];
        const dest = path.join(tmpDir, `src-${s.seq}`);
        const baseProgress = Math.floor(fetchUnit * i);
        const within = (frac) => setProgress(jobId, Math.min(39, baseProgress + Math.floor(fetchUnit * frac)));
        if (s.kind === 'url') {
          await guardedDownload(s.url, dest, {
            maxBytes: LIMITS.sourceMaxBytes,
            onBytes: (bytes) => {
              // Throttle DB writes: only report at ~10% granularity per source.
              const frac = s.size > 0 ? Math.min(1, bytes / s.size) : (bytes % (5 * 1024 * 1024) < 65536 ? 0.5 : undefined);
              if (frac !== undefined) within(frac);
            },
          });
          within(1);
        } else {
          await storage.assembleSourceToTmp(jobId, s.seq);
          fs.renameSync(path.join(os.tmpdir(), `merge-${jobId}-src-${s.seq}`), dest);
          within(1);
        }
        localFiles.push(dest);
        tmpFileWritten = true;
      }

      // Encode: engine reports 40-90.
      const result = await runMergeEngine({
        files: localFiles,
        onProgress: (p) => setProgress(jobId, p),
      });

      // Persist output as 2 MB rows, then only the output is needed.
      const outBuffer = fs.readFileSync(result.outPath);
      await storage.writeOutput(jobId, outBuffer);
      await batch([
        { sql: `UPDATE jobs SET status = 'done', progress = 100, output_size = ?, output_duration = ?, output_resolution = ?, error = NULL, updated_at = ? WHERE id = ?`, args: [result.size, result.duration, result.resolution, nowIso(), jobId] },
        { sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [jobId] },
      ]);
      fs.unlinkSync(result.outPath);

      const base = publicBase(req);
      logLine(requestId, 'merge done', { jobId, size: result.size, resolution: result.resolution });
      return send(res, 200, {
        status: 'done',
        videoUrl: `${base}/api/jobs/${jobId}/video`,
        downloadUrl: `${base}/api/jobs/${jobId}/video?download=1`,
        size: result.size,
        duration: result.duration,
        resolution: result.resolution,
      });
    } finally {
      // Always clean /tmp (serverless-safe), even on failure paths.
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      void tmpFileWritten;
    }
  } catch (err) {
    const msg = err instanceof SsrfError || (err && err.name === 'SsrfError')
      ? err.message
      : (err && err.message) || 'خطأ داخلي غير متوقع';
    logLine(requestId, 'merge failed', { jobId, error: msg });
    try { await setFailed(jobId, msg); } catch (_) { /* keep responding even if DB write fails */ }
    return send(res, 500, { error: msg });
  }
};
