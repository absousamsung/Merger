// fetcher.js — SSRF-guarded downloader with redirect re-validation, byte counting and limits.
'use strict';

const fs = require('fs');
const { pipeline } = require('stream/promises');
const { assertPublicHttpUrl, SsrfError } = require('./ssrf');
const { LIMITS, strEnv } = require('./util');

const MAX_REDIRECTS = 3;

// Downloads `url` to destPath enforcing: public host (re-checked after every
// redirect), total timeout, and a hard byte cap enforced DURING the stream.
async function guardedDownload(rawUrl, destPath, opts) {
  const maxBytes = (opts && opts.maxBytes) || LIMITS.sourceMaxBytes;
  const timeoutMs = (opts && opts.timeoutMs) || LIMITS.sourceTimeoutMs;
  const onBytes = (opts && opts.onBytes) || null;

  let current = await assertPublicHttpUrl(rawUrl); // throws SsrfError when not public
  for (let redirects = 0; ; redirects++) {
    if (redirects > MAX_REDIRECTS) {
      throw new SsrfError('عدد كبير من عمليات إعادة التوجيه');
    }
    let res;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'merger-service/1.0 (+video fetch)' },
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error('انتهت المهلة أثناء تنزيل المصدر');
      }
      throw new Error('فشل الاتصال بمصدر الفيديو');
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('رد غير صالح من مصدر الفيديو');
      // Re-validate EVERY redirect hop: the new target must also be public.
      const next = new URL(loc, current);
      res.body && res.body.cancel && res.body.cancel().catch(() => {});
      current = await assertPublicHttpUrl(next.toString());
      continue;
    }
    if (!res.ok) {
      throw new Error(`فشل تنزيل المصدر (HTTP ${res.status})`);
    }
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) {
      throw new Error(`حجم المصدر يتجاوز الحد المسموح (${Math.floor(maxBytes / (1024 * 1024))} MB)`);
    }
    let received = 0;
    const out = fs.createWriteStream(destPath);
    try {
      for await (const chunk of res.body) {
        received += chunk.length;
        if (received > maxBytes) {
          out.destroy();
          throw new Error(`حجم المصدر يتجاوز الحد المسموح (${Math.floor(maxBytes / (1024 * 1024))} MB)`);
        }
        if (onBytes) onBytes(received);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
      await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });
    } catch (err) {
      out.destroy();
      fs.unlink(destPath, () => {});
      throw err;
    }
    return { bytes: received };
  }
}

module.exports = { guardedDownload, SsrfError };
