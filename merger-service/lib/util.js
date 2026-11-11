// util.js — env loading, response helpers, ids, logging. CommonJS, no deps.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

// Tiny .env loader (no dotenv dependency). Existing process env wins so Vercel
// env vars are never shadowed by a stale local file.
function loadEnvFile(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (_) { /* no .env file — fine (Vercel injects env) */ }
}

loadEnvFile(path.join(ROOT, '.env'));

function strEnv(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function numEnv(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const LIMITS = {
  maxSources: numEnv('MAX_SOURCES', 10),
  sourceMaxBytes: numEnv('SOURCE_MAX_MB', 100) * 1024 * 1024,
  outputMaxBytes: numEnv('OUTPUT_MAX_MB', 150) * 1024 * 1024,
  maxTotalSourcesBytes: numEnv('MAX_TOTAL_SOURCES_MB', 300) * 1024 * 1024,
  maxTotalDurationSec: numEnv('MAX_TOTAL_DURATION_SEC', 600),
  uploadChunkBytes: 4 * 1024 * 1024, // stays under Vercel's ~4.5 MB body cap
  maxConcurrentProcesses: numEnv('MAX_CONCURRENT_PROCESSES', 2),
  rateJobsPerHour: numEnv('RATE_LIMIT_JOBS_PER_HOUR', 30),
  rateUploadsPerHour: numEnv('RATE_LIMIT_UPLOADS_PER_HOUR', 600),
  sourceTimeoutMs: numEnv('SOURCE_TIMEOUT_SEC', 180) * 1000,
  ffmpegPreset: strEnv('FFMPEG_PRESET', ''),
};

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// 12-char lowercase alphanumeric — unguessable enough for public result links.
function newJobId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function newRequestId() {
  return crypto.randomBytes(4).toString('hex');
}

function logLine(requestId, message, extra) {
  const entry = { ts: nowIso(), requestId, message, ...(extra || {}) };
  // Single JSON line; secrets are never passed in `extra`.
  console.log(JSON.stringify(entry));
}

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function send(res, status, obj, extraHeaders) {
  applyCors(res);
  const body = obj === undefined ? '' : JSON.stringify(obj);
  const headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders || {});
  res.statusCode = status;
  res.writeHead(status, headers);
  res.end(body);
}

function methodNotAllowed(res) {
  send(res, 405, { error: 'الطريقة غير مسموحة' });
}

// Dynamic path ids may arrive via rewrite-injected query params OR the raw URL.
function extractId(req, query) {
  if (query && typeof query.id === 'string' && query.id) return query.id;
  const m = /\/api\/jobs\/([^/]+)(\/(process|video))?$/.exec((req.url || '').split('?')[0]);
  return m ? decodeURIComponent(m[1]) : null;
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function publicBase(req) {
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http'));
  const host = String(req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost');
  return `${proto}://${host}`;
}

module.exports = {
  LIMITS, loadEnvFile, strEnv, numEnv, nowIso, newJobId, newRequestId,
  logLine, applyCors, send, methodNotAllowed, extractId, clientIp, publicBase, ROOT,
};
