import "./env.js"; // load .env before anything reads process.env
import { activeChains, loadRuntimeConfig } from "./config.js";
import { State, FileStateBackend } from "./state.js";
import { ChainWatcher } from "./watcher.js";
import { loadAlertConfig } from "./alert.js";

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

  const watchers = chains.map(
    ({ cfg, rpcUrl }) => new ChainWatcher(cfg, rpcUrl, runtime, state),
  );

  console.log(
    `Monitoring: ${chains
      .map(({ cfg }) => `${cfg.chain.name}[${cfg.tokens.map((t) => t.symbol).join(",")}]`)
      .join(", ")}`,
  );

  // Persist state and exit cleanly on signals (flush in-flight cursor/seen-set).
  const shutdown = async (sig: string) => {
    console.log(`\n${sig} received — stopping watchers and flushing state.`);
    for (const w of watchers) w.stop();
    await state.flush();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await Promise.all(watchers.map((w) => w.runForever()));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
