// storage.js — Turso-backed blob storage: 2 MB rows (HTTP transport limit),
// streamed back in 8-row pages so Range requests never load the whole blob.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { query, batch } = require('./db');

const CHUNK = 2 * 1024 * 1024;      // rows are 2 MB
const READ_PAGE = 8;                // 8 rows (16 MB) per read

function countChunks(size) { return Math.max(1, Math.ceil(size / CHUNK)); }

async function writeOutput(jobId, buffer) {
  const stmts = [];
  for (let i = 0, idx = 0; i < buffer.length; i += CHUNK, idx++) {
    stmts.push({ sql: 'INSERT OR REPLACE INTO output_chunks (job_id, chunk_index, data) VALUES (?, ?, ?)', args: [jobId, idx, buffer.subarray(i, Math.min(i + CHUNK, buffer.length))] });
  }
  await batch(stmts);
}

async function readOutputBuffer(jobId) {
  const rows = [];
  let after = -1;
  for (;;) {
    const res = await query(
      'SELECT chunk_index, data FROM output_chunks WHERE job_id = ? AND chunk_index > ? ORDER BY chunk_index LIMIT ?',
      [jobId, after, READ_PAGE]
    );
    for (const row of res.rows) {
      after = Number(row.chunk_index);
      rows.push(Buffer.from(row.data));
    }
    if (res.rows.length < READ_PAGE) break;
  }
  return Buffer.concat(rows);
}

// Async generator over the byte range [start, end] inclusive; trims first/last
// pages so HTTP Range streaming never touches bytes outside the request.
async function* readOutputRange(jobId, start, end) {
  const firstChunk = Math.floor(start / CHUNK);
  const lastChunk = Math.floor(end / CHUNK);
  let pending = null;
  for (let c = firstChunk; c <= lastChunk; ) {
    const upto = Math.min(lastChunk, c + READ_PAGE - 1);
    const res = await query(
      'SELECT chunk_index, data FROM output_chunks WHERE job_id = ? AND chunk_index >= ? AND chunk_index <= ? ORDER BY chunk_index',
      [jobId, c, upto]
    );
    const byIndex = new Map(res.rows.map((r) => [Number(r.chunk_index), Buffer.from(r.data)]));
    for (let idx = c; idx <= upto; idx++) {
      const buf = byIndex.get(idx);
      if (!buf) throw new Error('بيانات المخرجات غير مكتملة');
      let piece = buf;
      if (idx === firstChunk && start % CHUNK !== 0) piece = piece.subarray(start % CHUNK);
      if (idx === lastChunk) piece = piece.subarray(0, end - idx * CHUNK + 1 - (idx === firstChunk && start % CHUNK !== 0 ? start % CHUNK : 0));
      if (piece.length) yield piece;
    }
    c = upto + 1;
  }
  void pending;
}

async function outputMeta(jobId) {
  const res = await query(
    'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM output_chunks WHERE job_id = ?',
    [jobId]
  );
  const row = res.rows[0];
  return { chunks: Number(row.n), bytes: Number(row.bytes) };
}

async function writeSourceChunk(jobId, seq, chunkIndex, buffer) {
  await query(
    'INSERT OR REPLACE INTO source_chunks (job_id, seq, chunk_index, data) VALUES (?, ?, ?, ?)',
    [jobId, seq, chunkIndex, buffer]
  );
}

async function sourceChunksInfo(jobId, seq) {
  const res = await query(
    'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)),0) AS bytes, COALESCE(MAX(chunk_index), -1) AS max_idx FROM source_chunks WHERE job_id = ? AND seq = ?',
    [jobId, seq]
  );
  const row = res.rows[0];
  return { chunks: Number(row.n), bytes: Number(row.bytes), maxIdx: Number(row.max_idx) };
}

// Reassembles an uploaded file source into /tmp (used by the merge engine).
async function assembleSourceToTmp(jobId, seq) {
  const tmp = path.join(os.tmpdir(), `merge-${jobId}-src-${seq}`);
  const out = fs.createWriteStream(tmp);
  let after = -1;
  for (;;) {
    const res = await query(
      'SELECT chunk_index, data FROM source_chunks WHERE job_id = ? AND seq = ? AND chunk_index > ? ORDER BY chunk_index LIMIT ?',
      [jobId, seq, after, READ_PAGE]
    );
    for (const row of res.rows) {
      after = Number(row.chunk_index);
      if (!out.write(Buffer.from(row.data))) await new Promise((r) => out.once('drain', r));
    }
    if (res.rows.length < READ_PAGE) break;
  }
  await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });
  return tmp;
}

// Deletes every row of the job across all tables in one batch.
async function deleteJobRows(jobId) {
  await batch([
    { sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [jobId] },
    { sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [jobId] },
    { sql: 'DELETE FROM sources WHERE job_id = ?', args: [jobId] },
    { sql: 'DELETE FROM jobs WHERE id = ?', args: [jobId] },
  ]);
}

// Lazy purge: jobs whose 24h window elapsed. Returns number purged.
async function purgeExpired(nowIsoStr) {
  const res = await query('SELECT id FROM jobs WHERE expires_at < ?', [nowIsoStr]);
  const ids = res.rows.map((r) => r.id);
  for (const id of ids) await deleteJobRows(id);
  return ids.length;
}

module.exports = {
  CHUNK, READ_PAGE, countChunks,
  writeOutput, readOutputBuffer, readOutputRange, outputMeta,
  writeSourceChunk, sourceChunksInfo, assembleSourceToTmp,
  deleteJobRows, purgeExpired,
};
