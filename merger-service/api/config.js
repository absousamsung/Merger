// config.js — GET /api/config: public limits + version (no secrets).
'use strict';

const { LIMITS, send } = require('../lib/util');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'الطريقة غير مسموحة' });
  return send(res, 200, {
    version: '1.0.0',
    maxSources: LIMITS.maxSources,
    sourceMaxMb: Math.floor(LIMITS.sourceMaxBytes / (1024 * 1024)),
    outputMaxMb: Math.floor(LIMITS.outputMaxBytes / (1024 * 1024)),
    maxTotalSourcesMb: Math.floor(LIMITS.maxTotalSourcesBytes / (1024 * 1024)),
    maxTotalDurationSec: LIMITS.maxTotalDurationSec,
    uploadChunkBytes: LIMITS.uploadChunkBytes,
  });
};
