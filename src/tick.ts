import "./env.js"; // load .env before anything reads process.env
import { activeChains, loadRuntimeConfig } from "./config.js";
import { State, FileStateBackend } from "./state.js";
import { ChainWatcher } from "./watcher.js";
import { loadAlertConfig } from "./alert.js";

// Single-pass entrypoint for cron/serverless (e.g. GitHub Actions every ~5 min).
// Runs exactly one catch-up tick per chain (ChainWatcher.tick already chunks from the
// saved cursor up to head-confirmations), flushes state, and exits. State durability is
// the host's job — the workflow commits state.json back to the repo between runs.
async function main(): Promise<void> {
  const runtime = loadRuntimeConfig();
  const chains = activeChains();

  if (chains.length === 0) {
    console.error(
      "No active chains. Set at least one RPC_* env var (see .env.example) with an enabled token.",
    );
    process.exit(1);
  }

  if (!loadAlertConfig()) {
    console.warn("EMAIL_API_URL not set — alerts will be printed to console only.");
  }

  const state = new State(new FileStateBackend(runtime.stateFile));
  await state.load();

  let hadError = false;
  for (const { cfg, rpcUrl } of chains) {
    const watcher = new ChainWatcher(cfg, rpcUrl, runtime, state);
    try {
      await watcher.tick();
    } catch (err) {
      // One chain failing must not abort the others or lose their progress.
      hadError = true;
      console.error(`[${cfg.key}] tick failed:`, err);
    }
  }

  await state.flush();
  // Non-zero exit on partial failure so the CI run is visibly red, but state already
  // persisted for the chains that succeeded.
  process.exit(hadError ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
