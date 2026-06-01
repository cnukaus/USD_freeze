import "./env.js"; // load .env before anything reads process.env
import { createPublicClient, http } from "viem";
import { activeChains } from "./config.js";
import { eventsFor, extractAddress, FREEZE_EVENTS } from "./abi.js";

// Read-only query: "what are the latest blacklisted addresses?"
// Scans each active chain/token backwards from head in chunks and prints the most recent
// freeze events (newest first). Stateless — does not touch state.json or the monitor.
//
// Usage:
//   npm run latest            # last 20 freeze events across active chains
//   npm run latest -- 50      # last 50
//   LATEST_INCLUDE_UNFREEZE=1 npm run latest   # also show unblacklist events
const COUNT = Number(process.argv[2] ?? process.env.LATEST_COUNT ?? 20);
const LOOKBACK = BigInt(process.env.LATEST_LOOKBACK ?? 500_000);
const CHUNK = BigInt(process.env.LATEST_CHUNK ?? 45_000); // under common 50k RPC cap
const INCLUDE_UNFREEZE = process.env.LATEST_INCLUDE_UNFREEZE === "1";

interface Row {
  ts: number;
  iso: string;
  chain: string;
  token: string;
  action: string;
  event: string;
  address: string;
  txUrl: string;
}

async function main(): Promise<void> {
  const chains = activeChains();
  if (chains.length === 0) {
    console.error("No active chains. Set at least one RPC_* env var (see .env.example).");
    process.exit(1);
  }

  const rows: Row[] = [];

  for (const { cfg, rpcUrl } of chains) {
    const client = createPublicClient({ chain: cfg.chain, transport: http(rpcUrl) });
    const head = await client.getBlockNumber();
    const start = head > LOOKBACK ? head - LOOKBACK : 0n;

    for (const token of cfg.tokens) {
      const collected: typeof rows = [];
      // Walk backwards in chunks until we have enough for this token or run out of window.
      for (let to = head; to >= start && collected.length < COUNT; ) {
        const from = to - CHUNK + 1n > start ? to - CHUNK + 1n : start;
        const logs = await client.getLogs({
          address: token.address,
          events: eventsFor(token.symbol),
          fromBlock: from,
          toBlock: to,
        });
        // newest first within the chunk
        for (const log of logs.reverse()) {
          const ev = (log as { eventName?: string }).eventName ?? "unknown";
          const isFreeze = FREEZE_EVENTS.has(ev);
          if (!isFreeze && !INCLUDE_UNFREEZE) continue;
          const address = extractAddress((log as { args?: Record<string, unknown> }).args ?? {}) ?? "unknown";
          let ts = 0;
          if (log.blockNumber != null) {
            const block = await client.getBlock({ blockNumber: log.blockNumber });
            ts = Number(block.timestamp);
          }
          collected.push({
            ts,
            iso: ts ? new Date(ts * 1000).toISOString() : "?",
            chain: cfg.chain.name,
            token: token.symbol,
            action: isFreeze ? "freeze" : "unfreeze",
            event: ev,
            address,
            txUrl: log.transactionHash ? cfg.explorerTx(log.transactionHash) : "?",
          });
          if (collected.length >= COUNT) break;
        }
        if (from === start) break;
        to = from - 1n;
      }
      rows.push(...collected);
    }
  }

  // Merge across chains/tokens, newest first, cap at COUNT.
  rows.sort((a, b) => b.ts - a.ts);
  const top = rows.slice(0, COUNT);

  if (top.length === 0) {
    console.log(`No freeze events found in the last ${LOOKBACK} blocks.`);
    return;
  }
  for (const r of top) {
    console.log(
      `${r.iso}  ${r.token.padEnd(4)} ${r.chain.padEnd(12)} ${r.action.padEnd(8)} ${r.address}  ${r.txUrl}`,
    );
  }
}

main().catch((err) => {
  console.error("latest failed:", err);
  process.exit(1);
});
