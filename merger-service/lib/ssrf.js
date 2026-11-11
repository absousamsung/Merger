// ssrf.js — block SSRF targets before any outbound fetch.
// Only public http/https hosts allowed; every resolved address must be public.
'use strict';

const dns = require('dns').promises;

const SSRF_MESSAGE = 'رابط المصدر غير مسموح';

class SsrfError extends Error {
  constructor(msg) { super(msg || SSRF_MESSAGE); this.name = 'SsrfError'; }
}

function isPrivateIPv4(ip) {
  const p = ip.split('.').map((n) => parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // unparseable => reject
  const [a, b] = p;
  if (a === 0) return true;                    // 0.0.0.0/8
  if (a === 10) return true;                   // 10/8
  if (a === 127) return true;                  // loopback
  if (a === 169 && b === 254) return true;     // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;       // 192.0.0/24 + 192.0.2/24 test-net
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
  if (a >= 224) return true;                   // multicast + reserved + broadcast
  return false;
}

function expandIPv6(ip) {
  // Minimal parser: returns array of 8 hextets or null if malformed.
  if (!ip.includes(':')) return null;
  let addr = ip.toLowerCase();
  if (addr.includes('%')) addr = addr.split('%')[0]; // drop zone id
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const groups = new Array(8).fill(0);
  for (let i = 0; i < head.length; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(head[i])) return null;
    groups[i] = parseInt(head[i], 16);
  }
  const tailStart = 8 - tail.length;
  if (tailStart < head.length) return null;
  for (let i = 0; i < tail.length; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(tail[i])) return null;
    groups[tailStart + i] = parseInt(tail[i], 16);
  }
  return groups;
}

function isPrivateIPv6(ip) {
  const g = expandIPv6(ip);
  if (!g) return true; // unparseable => reject
  const [a, b] = g;
  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96): apply IPv4 rules to embedded address
  if (a === 0 && b === 0) {
    if (g[6] === 0 && g[7] === 1) return true;                       // ::1
    if (g[6] === 0 && g[7] === 0) return true;                       // :: (unspecified)
    if (g[5] === 0xffff) {                                           // ::ffff:x.y.z.w
      const v4 = `${(g[6] >> 8) & 255}.${g[6] & 255}.${(g[7] >> 8) & 255}.${g[7] & 255}`;
      return isPrivateIPv4(v4);
    }
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0) return true; // ::/96 leftovers
    return false;
  }
  if (a === 0x64 && b === 0xff9b) {                                  // NAT64
    const v4 = `${(g[6] >> 8) & 255}.${g[6] & 255}.${(g[7] >> 8) & 255}.${g[7] & 255}`;
    return isPrivateIPv4(v4);
  }
  if ((a & 0xfe00) === 0xfc00) return true;                          // fc00::/7 ULA
  if ((a & 0xffc0) === 0xfe80) return true;                          // fe80::/10 link-local
  if (a === 0xff00) return true;                                     // multicast
  return false;
}

function isPrivateIp(ip) {
  return ip.includes(':') ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

// Validate a URL string for merge use. Throws SsrfError when not allowed.
async function assertPublicHttpUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    throw new SsrfError('رابط المصدر غير صالح');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SsrfError();
  if (u.username || u.password) throw new SsrfError();
  const host = u.hostname;
  // Literal IP in the host: reject private directly.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    if (isPrivateIp(host.replace(/^\[|\]$/g, ''))) throw new SsrfError();
    return u;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new SsrfError();
  }
  // DNS resolution: EVERY address must be public (defends against DNS names pointing at private ranges).
  let resolved;
  try {
    resolved = await dns.lookup(host, { all: true, verbatim: true });
  } catch (_) {
    throw new SsrfError('تعذر تحويل اسم نطاق المصدر');
  }
  if (!resolved || !resolved.length) throw new SsrfError();
  for (const r of resolved) {
    if (isPrivateIp(r.address)) throw new SsrfError();
  }
  return u;
}

module.exports = { assertPublicHttpUrl, isPrivateIp, SsrfError, SSRF_MESSAGE };
