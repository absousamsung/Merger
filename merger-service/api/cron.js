// cron.js — GET /api/cron: purge expired jobs (daily via vercel.json crons).
// Protected with CRON_SECRET when configured.
'use strict';

const { strEnv, send, newRequestId, logLine } = require('../lib/util');
const { purgeExpired } = require('../lib/storage');
const { nowIso } = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'الطريقة غير مسموحة' });
  const requestId = newRequestId();
  const secret = strEnv('CRON_SECRET', '');
  if (secret) {
    const url = new URL(req.url, 'http://x');
    const provided = url.searchParams.get('secret') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (provided !== secret) return send(res, 401, { error: 'غير مصرح' });
  }
  const purged = await purgeExpired(nowIso());
  logLine(requestId, 'cron purge', { purged });
  return send(res, 200, { purged });
};
