// Node-only side of instrumentation: spawn the local merge service when absent.
// Loaded exclusively from register() when NEXT_RUNTIME === "nodejs".
import { spawn } from "node:child_process";
import path from "node:path";

export async function startLocalMerger(): Promise<void> {
  try {
    const res = await fetch("http://127.0.0.1:3001/api/config", { signal: AbortSignal.timeout(1500) });
    if (res.ok) return; // already running
  } catch {
    /* not running — spawn below */
  }
  try {
    const child = spawn(
      process.execPath,
      [path.join(process.cwd(), "merger-service", "scripts", "dev-server.js")],
      { detached: true, stdio: "ignore", env: { ...process.env, MERGER_AUTO_START: undefined, PORT: "3001" } }
    );
    child.unref();
    console.log(JSON.stringify({ ts: new Date().toISOString(), scope: "instrumentation", message: "spawned merger dev server on 3001" }));
  } catch (err) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), scope: "instrumentation", error: String((err as Error).message) }));
  }
}
