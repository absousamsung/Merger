// db.js — single Turso client, idempotent schema bootstrap, small query helpers.
'use strict';

const { createClient } = require('@libsql/client');
const { strEnv, nowIso } = require('./util');

let client = null;
let schemaPromise = null;

function getClient() {
  if (!client) {
    const url = strEnv('TURSO_DATABASE_URL', '');
    const authToken = strEnv('TURSO_AUTH_TOKEN', '');
    if (!url || !authToken) {
      throw new Error('TURSO_DATABASE_URL / TURSO_AUTH_TOKEN غير مهيأة');
    }
    client = createClient({ url, authToken });
  }
  return client;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    output_size INTEGER,
    output_duration REAL,
    output_resolution TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sources (
    job_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    url TEXT,
    name TEXT,
    mime TEXT,
    size INTEGER DEFAULT 0,
    received_bytes INTEGER DEFAULT 0,
    PRIMARY KEY (job_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS source_chunks (
    job_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (job_id, seq, chunk_index)
  )`,
  `CREATE TABLE IF NOT EXISTS output_chunks (
    job_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (job_id, chunk_index)
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    ip TEXT PRIMARY KEY,
    window_start TEXT NOT NULL,
    jobs_count INTEGER DEFAULT 0,
    upload_count INTEGER DEFAULT 0
  )`,
];

function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const c = getClient();
      for (const stmt of SCHEMA) await c.execute(stmt);
    })().catch((err) => { schemaPromise = null; throw err; });
  }
  return schemaPromise;
}

async function query(sql, args) {
  await ensureSchema();
  return getClient().execute({ sql, args: args || [] });
}

// Multi-statement write (libsql batch is atomic on the server).
async function batch(statements) {
  await ensureSchema();
  return getClient().batch(statements.map((s) => ({ sql: s.sql, args: s.args || [] })), 'write');
}

function expiresAtIso(fromIso) {
  const t = new Date(fromIso || nowIso()).getTime() + 24 * 3600 * 1000;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

module.exports = { getClient, ensureSchema, query, batch, expiresAtIso, nowIso };
