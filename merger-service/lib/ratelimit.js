// ratelimit.js — in-DB fixed-window rate limiting + global concurrency cap.
// Serverless instances share no memory, so counters live in Turso (spec allows).
'use strict';

const { query } = require('./db');
const { LIMITS, nowIso } = require('./util');

function currentWindowStart() {
  // Fixed 1-hour UTC window, e.g. 2026-11-11T11:00:00Z
  return new Date().toISOString().slice(0, 13) + ':00:00Z';
}

// kind: 'jobs' | 'upload'. Returns { allowed, count, limit }.
async function checkRateLimit(ip, kind) {
  const win = currentWindowStart();
  const incJobs = kind === 'jobs' ? 1 : 0;
  const incUpload = kind === 'upload' ? 1 : 0;
  // Upsert with window reset: when the stored window differs, restart from this request.
  await query(
    `INSERT INTO rate_limits (ip, window_start, jobs_count, upload_count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET
       window_start = excluded.window_start,
       jobs_count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.jobs_count + excluded.jobs_count ELSE excluded.jobs_count END,
       upload_count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.upload_count + excluded.upload_count ELSE excluded.upload_count END`,
    [ip, win, incJobs, incUpload]
  );
  const res = await query('SELECT window_start, jobs_count, upload_count FROM rate_limits WHERE ip = ?', [ip]);
  const row = res.rows[0] || { window_start: win, jobs_count: 0, upload_count: 0 };
  const count = Number(kind === 'jobs' ? row.jobs_count : row.upload_count);
  const limit = kind === 'jobs' ? LIMITS.rateJobsPerHour : LIMITS.rateUploadsPerHour;
  // row.window_start !== win can only happen right after a concurrent reset; treat as allowed.
  const allowed = row.window_start !== win ? true : count <= limit;
  return { allowed, count, limit };
}

async function countProcessing() {
  const res = await query(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'processing'`);
  return Number(res.rows[0].n);
}

async function concurrencySlotAvailable() {
  return (await countProcessing()) < LIMITS.maxConcurrentProcesses;
}

module.exports = { checkRateLimit, countProcessing, concurrencySlotAvailable };
