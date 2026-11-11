// instrumentation.ts — sandbox convenience ONLY (env-gated via MERGER_AUTO_START):
// keeps a local instance of the Phase 1 merge service alive for the live preview.
// Never active in production deploys (flag unset) — no-op there.
export async function register() {
  if (process.env.MERGER_AUTO_START !== "1") return;
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startLocalMerger } = await import("./instrumentation/node-only");
  await startLocalMerger();
}
