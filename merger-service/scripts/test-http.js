// test-http.js — full HTTP flow against the dev server (spawns it on port 3101).
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;
const { ffmpegPath } = require('../lib/probe');
const { query } = require('../lib/db');

// The suite re-runs within one hour window; clear its own per-IP counter so the
// public rate limit (30 jobs/h) doesn't fail repeated runs.
async function clearTestRateLimit() {
  await query(`DELETE FROM rate_limits WHERE ip IN ('127.0.0.1', '::ffff:127.0.0.1', '::1', 'test')`);
}

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

function makeClip(out, videoSrc, duration, withAudio) {
  const args = ['-hide_banner', '-y', '-f', 'lavfi', '-i', videoSrc];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=330:duration=${duration}`);
  args.push('-t', String(duration), '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac', '-shortest');
  const r = spawnSync(ffmpegPath(), args.concat([out]), { stdio: 'pipe' });
  if (r.status !== 0) throw new Error('clip generation failed');
  return out;
}

async function jfetch(pathname, opts) {
  const res = await fetch(BASE + pathname, opts);
  let body = {};
  const text = await res.text();
  try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { raw: text }; }
  return { status: res.status, body, headers: res.headers };
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/config');
      if (r.ok) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const server = spawn('node', [path.join(__dirname, 'dev-server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const cleanupJobs = [];
  const untrack = (id) => { const i = cleanupJobs.indexOf(id); if (i >= 0) cleanupJobs.splice(i, 1); };
  try {
    await clearTestRateLimit();
    ok('dev server ready', await waitForServer());

    // 1) config
    {
      const r = await jfetch('/api/config');
      ok('GET /api/config 200', r.status === 200 && r.body.maxSources === 10 && r.body.uploadChunkBytes === 4 * 1024 * 1024, JSON.stringify(r.body));
    }

    // 2) URL job: create -> process -> done
    let urlJobId = null;
    {
      const create = await jfetch('/api/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videos: ['https://www.w3schools.com/html/mov_bbb.mp4', 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4'] }),
      });
      ok('POST /api/jobs (urls) 201', create.status === 201 && create.body.jobId && create.body.status === 'queued', JSON.stringify(create.body));
      urlJobId = create.body.jobId;
      cleanupJobs.push(urlJobId);
      const proc = await jfetch(`/api/jobs/${urlJobId}/process`, { method: 'POST' });
      ok('POST process (urls) 200 done', proc.status === 200 && proc.body.status === 'done' && proc.body.videoUrl, JSON.stringify(proc.body).slice(0, 300));
      const st = await jfetch(`/api/jobs/${urlJobId}`);
      ok('GET job done with links', st.status === 200 && st.body.status === 'done' && typeof st.body.progress === 'number' && st.body.videoUrl.includes('/video'), JSON.stringify(st.body).slice(0, 300));
    }

    // 3) Range request
    {
      const r = await fetch(`${BASE}/api/jobs/${urlJobId}/video`, { headers: { Range: 'bytes=0-99' } });
      const buf = Buffer.from(await r.arrayBuffer());
      ok('Range 206 + Content-Range', r.status === 206 && String(r.headers.get('content-range')).startsWith('bytes 0-99/') && buf.length === 100, `status=${r.status} cr=${r.headers.get('content-range')} len=${buf.length}`);
      const d = await fetch(`${BASE}/api/jobs/${urlJobId}/video?download=1`);
      ok('download=1 forces attachment', d.status === 200 && String(d.headers.get('content-disposition') || '').includes('attachment'), `cd=${d.headers.get('content-disposition')}`);
      const full = await fetch(`${BASE}/api/jobs/${urlJobId}/video`);
      ok('full stream 200 with Accept-Ranges', full.status === 200 && full.headers.get('accept-ranges') === 'bytes');
      const bad = await fetch(`${BASE}/api/jobs/${urlJobId}/video`, { headers: { Range: 'bytes=999999999-' } });
      ok('unsatisfiable range 416', bad.status === 416 && String(bad.headers.get('content-range') || '').startsWith('bytes */'));
    }

    // 4) Mixed job: URL + uploaded file
    {
      const clip = makeClip(path.join(os.tmpdir(), `p1http-${process.pid}.mp4`), 'testsrc2=size=320x240:rate=30:duration=2', 2, true);
      const create = await jfetch('/api/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: [
          { kind: 'url', url: 'https://www.w3schools.com/html/mov_bbb.mp4' },
          { kind: 'file', name: 'clip.mp4', size: fs.statSync(clip).size, mime: 'video/mp4' },
        ] }),
      });
      ok('POST /api/jobs (mixed) 201 with uploads[]', create.status === 201 && create.body.status === 'uploading' && Array.isArray(create.body.uploads) && create.body.uploads.length === 1, JSON.stringify(create.body).slice(0, 200));
      const jobId = create.body.jobId;
      cleanupJobs.push(jobId);
      // chunked upload
      const data = fs.readFileSync(clip);
      const C = 4 * 1024 * 1024;
      let uploadOk = true;
      for (let c = 0; c * C < data.length; c++) {
        const slice = data.subarray(c * C, Math.min((c + 1) * C, data.length));
        const up = await fetch(`${BASE}/api/upload?job=${jobId}&seq=1&chunk=${c}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: slice,
        });
        if (!up.ok) { uploadOk = false; break; }
      }
      ok('chunked upload ok', uploadOk);
      const proc = await jfetch(`/api/jobs/${jobId}/process`, { method: 'POST' });
      ok('POST process (mixed) 200 done', proc.status === 200 && proc.body.status === 'done', JSON.stringify(proc.body).slice(0, 300));
      fs.existsSync(clip) && fs.unlinkSync(clip);
    }

    // 5) delete -> 404
    {
      const del = await jfetch(`/api/jobs/${urlJobId}`, { method: 'DELETE' });
      const st = await jfetch(`/api/jobs/${urlJobId}`);
      const vid = await fetch(`${BASE}/api/jobs/${urlJobId}/video`);
      untrack(urlJobId);
      ok('DELETE 200 then 404s', del.status === 200 && st.status === 404 && vid.status === 404, `del=${del.status} st=${st.status} vid=${vid.status}`);
    }

    // 6) malformed / empty / too many / bad scheme
    {
      const malformed = await fetch(BASE + '/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
      ok('malformed JSON 400', malformed.status === 400);
      const empty = await jfetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videos: [] }) });
      ok('empty list 400', empty.status === 400 && /مطلوبة|أقصى/.test(empty.body.error || ''));
      const tooMany = await jfetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videos: Array.from({ length: 11 }, (_, i) => `https://example.com/v${i}.mp4`) }) });
      ok('11 sources 400', tooMany.status === 400);
      const ftp = await jfetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videos: ['ftp://example.com/x.mp4'] }) });
      ok('ftp scheme 400', ftp.status === 400);
      const wrong = await jfetch('/api/config', { method: 'POST' });
      ok('wrong method 405', wrong.status === 405);
    }

    // 7) SSRF rejections
    {
      const cases = [
        ['loopback', 'http://127.0.0.1/x.mp4'],
        ['metadata', 'http://169.254.169.254/latest/meta-data'],
        ['dns-to-private (localtest.me)', 'http://localtest.me/x.mp4'],
        ['credentials', 'http://user:pass@example.com/x.mp4'],
      ];
      for (const [name, url] of cases) {
        const r = await jfetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videos: [url] }) });
        ok(`SSRF rejected: ${name}`, r.status === 400, `status=${r.status} body=${JSON.stringify(r.body)}`);
      }
      // redirect-to-private: both httpbin/httpbingo now refuse private targets
      // (their own SSRF protection), so build the scenario with a fresh
      // tinyurl short link pointing at a private address. Skip gracefully if
      // tinyurl is unreachable.
      let redirectUrl = null;
      try {
        const api = await fetch('https://tinyurl.com/api-create.php?url=' + encodeURIComponent('http://127.0.0.1/x.mp4'), { signal: AbortSignal.timeout(10000) });
        const short = (await api.text()).trim();
        if (api.ok && /^https:\/\/tinyurl\.com\//.test(short)) {
          const probe = await fetch(short, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
          if (probe.status >= 300 && probe.status < 400) redirectUrl = short;
        }
      } catch (_) {}
      if (redirectUrl) {
        // The redirector host itself is public, so creation succeeds; the private
        // redirect hop must be rejected during the guarded fetch (process step).
        const r = await jfetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videos: [redirectUrl] }) });
        ok('redirect-to-private: public host accepted at create', r.status === 201, `status=${r.status}`);
        if (r.body.jobId) {
          cleanupJobs.push(r.body.jobId);
          const proc = await jfetch(`/api/jobs/${r.body.jobId}/process`, { method: 'POST' });
          ok('SSRF rejected: redirect to private at fetch time', proc.status === 500 && String(proc.body.error || '').includes('غير مسموح'), `status=${proc.status} body=${JSON.stringify(proc.body)}`);
        }
      } else {
        console.log('SKIP  SSRF redirect-to-private (tinyurl unreachable)');
      }
    }

    // 8) concurrent process on one job encodes only once
    {
      const create = await jfetch('/api/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videos: ['https://www.w3schools.com/html/mov_bbb.mp4'] }),
      });
      const jobId = create.body.jobId;
      cleanupJobs.push(jobId);
      const [a, b] = await Promise.all([
        jfetch(`/api/jobs/${jobId}/process`, { method: 'POST' }),
        jfetch(`/api/jobs/${jobId}/process`, { method: 'POST' }),
      ]);
      const codes = [a.status, b.status].sort();
      ok('concurrent process: exactly one encodes', (codes[0] === 200 && codes[1] === 202) || (codes[0] === 200 && codes[1] === 409), `codes=${codes}`);
      const final = await jfetch(`/api/jobs/${jobId}`);
      ok('job ends done exactly once', final.body.status === 'done');
    }

    // 9) cron endpoint
    {
      const r = await jfetch('/api/cron');
      ok('GET /api/cron 200 with purged count', r.status === 200 && typeof r.body.purged === 'number', JSON.stringify(r.body));
    }

    // 10) upload guards
    {
      const create = await jfetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sources: [{ kind: 'file', name: 'big.mp4', size: 10 * 1024 * 1024, mime: 'video/mp4' }] }) });
      const jobId = create.body.jobId;
      cleanupJobs.push(jobId);
      const big = await fetch(`${BASE}/api/upload?job=${jobId}&seq=0&chunk=0`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(5 * 1024 * 1024) });
      ok('5MB chunk 413', big.status === 413, `status=${big.status}`);
      const unknown = await fetch(`${BASE}/api/upload?job=nonexistent00&seq=0&chunk=0`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(1024) });
      ok('unknown job upload 404', unknown.status === 404, `status=${unknown.status}`);
    }
  } finally {
    server.kill('SIGTERM');
    // Clean up every job the suite created.
    for (const id of cleanupJobs) {
      try { await fetch(`${BASE}/api/jobs/${id}`, { method: 'DELETE' }); } catch (_) {}
    }
  }
  console.log(`\nHTTP tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('suite error:', err); process.exit(1); });
