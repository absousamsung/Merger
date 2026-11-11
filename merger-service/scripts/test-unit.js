// test-unit.js — layer-by-layer unit tests (no HTTP): storage, merge engine, limits, purge.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { ensureSchema, query } = require('../lib/db');
const storage = require('../lib/storage');
const { probeFile, ffmpegPath } = require('../lib/probe');
const { runMergeEngine } = require('../lib/merge');
const { guardedDownload } = require('../lib/fetcher');
const { checkRateLimit } = require('../lib/ratelimit');
const { assertPublicHttpUrl, isPrivateIp, SsrfError } = require('../lib/ssrf');

function tmpFile(name) { return path.join(os.tmpdir(), `p1unit-${process.pid}-${name}`); }

function makeClip(out, videoSrc, duration, withAudio) {
  const args = ['-hide_banner', '-y', '-f', 'lavfi', '-i', videoSrc];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`);
  args.push('-t', String(duration), '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac', '-shortest');
  const r = spawnSync(ffmpegPath(), args.concat([out]), { stdio: 'pipe' });
  if (r.status !== 0) throw new Error('clip generation failed: ' + r.stderr.toString().slice(-300));
  return out;
}

test('turso connectivity', async () => {
  await ensureSchema();
  const res = await query('SELECT 1 AS ok');
  assert.strictEqual(Number(res.rows[0].ok), 1);
});

test('ssrf validator rejects private targets and accepts public urls', async () => {
  for (const bad of [
    'http://127.0.0.1/x.mp4',
    'http://10.0.0.5/x.mp4',
    'http://169.254.169.254/meta',
    'http://192.168.1.10/x.mp4',
    'http://172.16.5.5/x.mp4',
    'http://100.64.1.1/x.mp4',
    'ftp://example.com/x.mp4',
    'http://user:pass@example.com/x.mp4',
    'http://[::1]/x.mp4',
    'http://[fc00::1]/x.mp4',
  ]) {
    await assert.rejects(() => assertPublicHttpUrl(bad), SsrfError);
  }
  assert.strictEqual(isPrivateIp('127.0.0.1'), true);
  assert.strictEqual(isPrivateIp('8.8.8.8'), false);
  assert.strictEqual(isPrivateIp('::ffff:127.0.0.1'), true);
  assert.strictEqual(isPrivateIp('2606:4700::1111'), false);
  await assertPublicHttpUrl('https://example.com/video.mp4'); // must not throw
});

test('storage round-trip: write/read/range with matching sha256', async () => {
  await ensureSchema();
  const id = crypto.randomBytes(6).toString('hex') + 'rt';
  try {
    const buf = crypto.randomBytes(5 * 1024 * 1024 + 555 * 1024); // > 2 rows
    await storage.writeOutput(id, buf);
    const back = await storage.readOutputBuffer(id);
    const h1 = crypto.createHash('sha256').update(buf).digest('hex');
    const h2 = crypto.createHash('sha256').update(back).digest('hex');
    assert.strictEqual(h1, h2);
    // middle range slice must match
    let slice = Buffer.alloc(0);
    for await (const piece of storage.readOutputRange(id, 1000, 5000)) slice = Buffer.concat([slice, piece]);
    assert.ok(slice.equals(buf.subarray(1000, 5001)));
    const meta = await storage.outputMeta(id);
    assert.strictEqual(meta.bytes, buf.length);
  } finally {
    await storage.deleteJobRows(id);
  }
});

test('chunk-upload path: 3 chunks reassemble exactly', async () => {
  await ensureSchema();
  const id = crypto.randomBytes(6).toString('hex') + 'cu';
  try {
    await query(`INSERT INTO jobs (id, status, created_at, expires_at) VALUES (?, 'uploading', ?, ?)`, [id, new Date().toISOString(), new Date(Date.now() + 3600e3).toISOString()]);
    await query(`INSERT INTO sources (job_id, seq, kind, name, size) VALUES (?, 0, 'file', 'test.mp4', ?)`, [id, 9 * 1024 * 1024 + 123]);
    const buf = crypto.randomBytes(9 * 1024 * 1024 + 123);
    const C = 4 * 1024 * 1024;
    await storage.writeSourceChunk(id, 0, 0, buf.subarray(0, C));
    await storage.writeSourceChunk(id, 0, 1, buf.subarray(C, 2 * C));
    await storage.writeSourceChunk(id, 0, 2, buf.subarray(2 * C));
    const info = await storage.sourceChunksInfo(id, 0);
    assert.strictEqual(info.chunks, 3);
    assert.strictEqual(info.bytes, buf.length);
    const assembled = await storage.assembleSourceToTmp(id, 0);
    const read = fs.readFileSync(assembled);
    assert.ok(buf.equals(read));
    fs.unlinkSync(assembled);
  } finally {
    await storage.deleteJobRows(id);
  }
});

test('merge engine: different resolutions -> largest, duration sum, silent source gets audio', async () => {
  const clipA = makeClip(tmpFile('a.mp4'), 'testsrc2=size=640x360:rate=30:duration=2', 2, true);
  const clipB = makeClip(tmpFile('b.mp4'), 'smptebars=size=1280x720:rate=30:duration=3', 3, false);
  try {
    const result = await runMergeEngine({ files: [clipA, clipB] });
    assert.strictEqual(result.resolution, '1280x720');
    assert.ok(Math.abs(result.duration - 5) <= 1.2, 'duration ~5s, got ' + result.duration);
    const probed = await probeFile(result.outPath);
    assert.strictEqual(probed.hasAudio, true, 'silent source must still yield an audio track');
    assert.strictEqual(probed.hasVideo, true);
    fs.unlinkSync(result.outPath);
  } finally {
    fs.existsSync(clipA) && fs.unlinkSync(clipA);
    fs.existsSync(clipB) && fs.unlinkSync(clipB);
  }
});

test('size-limit enforcement: guarded download over tiny cap fails with Arabic message', async () => {
  // Both public clips are >= ~1 MB; a 10 KB cap must trigger the limit error.
  await assert.rejects(
    () => guardedDownload('https://www.w3schools.com/html/mov_bbb.mp4', tmpFile('cap.mp4'), { maxBytes: 10 * 1024 }),
    (err) => err.message.includes('يتجاوز الحد')
  );
});

test('cascade delete removes everything for the job', async () => {
  await ensureSchema();
  const id = crypto.randomBytes(6).toString('hex') + 'cd';
  await query(`INSERT INTO jobs (id, status, created_at, expires_at) VALUES (?, 'done', ?, ?)`, [id, new Date().toISOString(), new Date(Date.now() + 3600e3).toISOString()]);
  await query(`INSERT INTO sources (job_id, seq, kind) VALUES (?, 0, 'url')`, [id]);
  await query(`INSERT INTO source_chunks (job_id, seq, chunk_index, data) VALUES (?, 0, 0, ?)`, [id, crypto.randomBytes(1024)]);
  await query(`INSERT INTO output_chunks (job_id, chunk_index, data) VALUES (?, 0, ?)`, [id, crypto.randomBytes(1024)]);
  await storage.deleteJobRows(id);
  for (const [table, col] of [['jobs', 'id'], ['sources', 'job_id'], ['source_chunks', 'job_id'], ['output_chunks', 'job_id']]) {
    const res = await query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, [id]);
    assert.strictEqual(Number(res.rows[0].n), 0, `${table} must be empty after cascade delete`);
  }
});

test('purgeExpired removes only expired jobs', async () => {
  await ensureSchema();
  const expired = crypto.randomBytes(6).toString('hex') + 'ex';
  const alive = crypto.randomBytes(6).toString('hex') + 'al';
  await query(`INSERT INTO jobs (id, status, created_at, expires_at) VALUES (?, 'queued', ?, ?)`, [expired, new Date().toISOString(), new Date(Date.now() - 1000).toISOString()]);
  await query(`INSERT INTO jobs (id, status, created_at, expires_at) VALUES (?, 'queued', ?, ?)`, [alive, new Date().toISOString(), new Date(Date.now() + 24 * 3600e3).toISOString()]);
  await query(`INSERT INTO output_chunks (job_id, chunk_index, data) VALUES (?, 0, ?)`, [expired, crypto.randomBytes(64)]);
  const n = await storage.purgeExpired(new Date().toISOString());
  assert.ok(n >= 1, 'at least the expired job is purged');
  const gone = await query('SELECT id FROM jobs WHERE id = ?', [expired]);
  assert.strictEqual(gone.rows.length, 0);
  const kept = await query('SELECT id FROM jobs WHERE id = ?', [alive]);
  assert.strictEqual(kept.rows.length, 1);
  await storage.deleteJobRows(alive);
});

test('rate limiter counts and allows within limits', async () => {
  await ensureSchema();
  const ip = 'test-' + crypto.randomBytes(4).toString('hex');
  try {
    await checkRateLimit(ip, 'jobs');
    await checkRateLimit(ip, 'jobs');
    const res = await query('SELECT jobs_count FROM rate_limits WHERE ip = ?', [ip]);
    assert.strictEqual(Number(res.rows[0].jobs_count), 2);
  } finally {
    await query('DELETE FROM rate_limits WHERE ip = ?', [ip]);
  }
});
