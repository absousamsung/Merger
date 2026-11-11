# DECISIONS.md — Phase 1 (Video Merger Service)

Format: decision — reason (alternative rejected).

1. Single-pass `filter_complex` normalize+concat per spec — one encode guarantees perfect A/V sync and matches the mandated quality recipe; segmented TS intermediates rejected (double latency, concat-copy edge cases).
2. Added pre-flight budget check `MAX_TOTAL_SOURCES_MB=300` and lowered `SOURCE_MAX_MB` default 200→100 — Vercel `/tmp` ≈512 MB makes the spec's 10×200 MB worst case physically impossible; graceful Arabic failure beats a crash (rejected: keeping spec defaults and letting `/tmp` fill).
3. Adaptive x264 preset: `faster` automatically for >240 s total duration when `FFMPEG_PRESET` unset — keeps worst cases inside the 300 s function ceiling (rejected: fixed `medium` everywhere, risking timeouts).
4. Dynamic routes implemented as `vercel.json` rewrites with query-param injection, plus `req.url` path parsing fallback in handlers — rewrite param delivery as query params is not contractually guaranteed across runtimes (rejected: relying on query params only).
5. 4 MB octet-stream upload chunks relying on Vercel's `req.body` Buffer for binary bodies — stays under the ≈4.5 MB body cap (rejected: base64-in-JSON, inflating size ~33%).
6. Output stored as 2 MB BLOB rows, streamed back in 8-row pages — safe for Turso HTTP transport limits and enables true Range streaming without loading the whole blob (rejected: single giant row).
7. `expires_at = created_at + 24 h` (not completion time) — literal spec compliance; simpler retention accounting.
8. Atomic claim via conditional `UPDATE ... WHERE status IN ('queued','uploading')` checked by `rowsAffected` — two simultaneous `process` calls can never encode twice; stale jobs stuck `processing` >10 min are reclaimable via a timestamp compare-and-swap (crash recovery).
9. In-DB fixed-window (1 h) rate limiting per IP + best-effort global processing cap — spec explicitly allows in-DB counters since serverless instances share no memory (rejected: in-memory counters, they reset per instance).
10. SSRF: validate URL at creation AND re-validate every redirect hop (max 3) during download; every DNS-resolved address must be public; literal IPs, credential URLs, and non-http(s) schemes rejected outright (rejected: single check at creation only — DNS rebinding/redirect hops bypass it).
11. Job IDs: 12-char lowercase alphanumeric from `crypto.randomBytes` — unguessable result links per spec (rejected: sequential IDs).
12. node:test built-in runner and a hand-written `.env` parser — zero extra dependencies for a serverless bundle (rejected: adding jest/dotenv).
13. Lazy purge on create/process/status calls plus a daily cron at 03:00 UTC — expired rows never accumulate even if the cron is missed.
14. `anullsrc` silent track generation per silent source (with `-t duration`) — a source without audio must never fail the merge (spec mandate).
15. Turbo compatibility: handlers speak plain `res.writeHead/write/end` (no framework response helpers) so the same file runs on Vercel and the local dev server unchanged.
16. Public redirectors (httpbin/httpbingo) now block redirect-to-private targets themselves, so the e2e SSRF redirect test creates a fresh tinyurl short link pointing at 127.0.0.1 — deterministic real-world validation of hop re-validation.
17. Local `.env` is loaded only by the dev server with existing env vars taking precedence — Vercel-injected env can never be shadowed by a stale file.
