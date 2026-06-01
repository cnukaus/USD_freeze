import "./env.js"; // load .env before anything reads process.env
import { createPublicClient, http } from "viem";
import { CHAINS } from "./config.js";
import { eventsFor } from "./abi.js";

// One-off probe: for each configured (chain, token), look back a window of blocks for ANY
// blacklist event. A native USDC / blacklisting USDT will usually have some; a bridged
// USDC.e / bridged USDT will have none and should stay disabled.
//
// Absence of recent events is not definitive proof (low activity), but presence is a
// strong PASS signal. For a hard check, inspect bytecode for the function selectors.
//
// Scans in chunks because public RPCs cap getLogs ranges (commonly 10k–50k blocks), and
// stops at the first event found so a PASS returns fast.
const LOOKBACK = BigInt(process.env.VERIFY_LOOKBACK ?? 500_000);
const CHUNK = BigInt(process.env.VERIFY_CHUNK ?? 45_000); // under the common 50k cap

async function main(): Promise<void> {
  console.log("token   chain        address                                      result");
  for (const cfg of CHAINS) {
    const rpcUrl = process.env[cfg.rpcEnv];
    if (!rpcUrl) {
      for (const t of cfg.tokens) {
        console.log(
          `${t.symbol.padEnd(7)} ${cfg.chain.name.padEnd(12)} ${t.address}  SKIP (no ${cfg.rpcEnv})`,
        );
      }
      continue;
    }
    const client = createPublicClient({ chain: cfg.chain, transport: http(rpcUrl) });
    const head = await client.getBlockNumber();
    const start = head > LOOKBACK ? head - LOOKBACK : 0n;

    for (const t of cfg.tokens) {
      try {
        let found = 0;
        let scannedTo = head;
        // Walk backwards from head in chunks; stop as soon as we see an event.
        for (let to = head; to >= start && found === 0; to = scannedTo - 1n) {
          const from = to - CHUNK + 1n > start ? to - CHUNK + 1n : start;
          const logs = await client.getLogs({
            address: t.address,
            events: eventsFor(t.symbol),
            fromBlock: from,
            toBlock: to,
          });
          found = logs.length;
          scannedTo = from;
          if (from === start) break;
        }
        const verdict =
          found > 0
            ? `PASS (event found)`
            : `NONE in last ${LOOKBACK} blocks`;
        console.log(
          `${t.symbol.padEnd(7)} ${cfg.chain.name.padEnd(12)} ${t.address}  ${verdict}`,
        );
      } catch (err) {
        console.log(
          `${t.symbol.padEnd(7)} ${cfg.chain.name.padEnd(12)} ${t.address}  ERROR ${(err as Error).message}`,
        );
      }
    }
  }
}

main().catch((err) => {
  console.error("verify failed:", err);
  process.exit(1);
});
