// dev-server.js — emulates Vercel Serverless routing for local development:
// loads .env manually, parses dynamic paths into req.query (like rewrites),
// pre-parses bodies (JSON -> object, octet-stream -> Buffer) and serves the UI.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { applyCors, send, newRequestId, logLine } = require('../lib/util');

const PORT = Number(process.env.PORT || 3001);
const ROOT = path.join(__dirname, '..');

// Exact routes (path -> allowed methods), mirroring vercel.json deployments.
const EXACT = {
  '/api/jobs': { methods: ['POST'], load: () => require('../api/jobs') },
  '/api/upload': { methods: ['POST'], load: () => require('../api/upload') },
  '/api/config': { methods: ['GET'], load: () => require('../api/config') },
  '/api/cron': { methods: ['GET'], load: () => require('../api/cron') },
};
const DYNAMIC = [
  { re: /^\/api\/jobs\/([^/]+)\/process$/, module: '../api/job-process', param: 'id' },
  { re: /^\/api\/jobs\/([^/]+)\/video$/, module: '../api/job-video', param: 'id' },
  { re: /^\/api\/jobs\/([^/]+)$/, module: '../api/job', param: 'id' },
];

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  applyCors(res);
  const urlPath = (req.url || '/').split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // Static UI
  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  if (req.method === 'GET' && urlPath === '/favicon.ico') { res.writeHead(204); return res.end(); }

  // req.query: searchParams always, plus dynamic capture (rewrite emulation).
  const query = {};
  const qs = req.url && req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
  for (const [k, v] of new URLSearchParams(qs)) query[k] = v;

  const dynamic = DYNAMIC.find((d) => d.re.test(urlPath));
  const exact = EXACT[urlPath];
  if (!exact && !dynamic) return send(res, 404, { error: 'المسار غير موجود' });
  if (exact && !exact.methods.includes(req.method)) return send(res, 405, { error: 'الطريقة غير مسموحة' });

  const body = await readBody(req);
  const contentType = String(req.headers['content-type'] || '');
  if (contentType.includes('application/json')) {
    if (body.length) {
      try { req.body = JSON.parse(body.toString('utf8')); }
      catch (_) { return send(res, 400, { error: 'طلب غير صالح: تنسيق JSON غير صحيح' }); }
    } else req.body = {};
  } else {
    req.body = body; // Buffer for binary (mirrors Vercel octet-stream behavior)
  }

  let handler;
  if (dynamic) {
    query[dynamic.param] = decodeURIComponent(dynamic.re.exec(urlPath)[1]);
    handler = require(dynamic.module);
  } else {
    handler = exact.load();
  }
  req.query = query;
  const requestId = newRequestId();
  const start = Date.now();
  try {
    await handler(req, res);
  } catch (err) {
    logLine(requestId, 'unhandled handler error', { error: err.message, path: urlPath });
    if (!res.headersSent) send(res, 500, { error: 'خطأ داخلي غير متوقع' });
    else try { res.end(); } catch (_) {}
  } finally {
    logLine(requestId, 'request done', { method: req.method, path: urlPath, ms: Date.now() - start });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    logLine('dev', 'request pipeline error', { error: err.message });
    if (!res.headersSent) send(res, 500, { error: 'خطأ داخلي غير متوقع' });
    else try { res.end(); } catch (_) {}
  });
});

server.listen(PORT, () => {
  logLine('dev', 'merger dev server listening', { port: PORT });
});

process.on('unhandledRejection', (err) => logLine('dev', 'unhandledRejection', { error: String(err && err.message) }));
