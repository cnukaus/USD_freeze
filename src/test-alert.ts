import "./env.js";
import { loadAlertConfig, sendAlert, type FreezeAlert } from "./alert.js";
import { State, FileStateBackend, type StoredEvent } from "./state.js";
import { loadRuntimeConfig } from "./config.js";

// Usage: tsx src/test-alert.ts [--history]
//   --history  include last 30 days of real events from state.json (or dummy rows if none)
const includeHistory = process.argv.includes("--history");

const fakeAlert: FreezeAlert = {
  event: "AddedBlackList",
  action: "freeze",
  token: "USDT",
  chain: "Ethereum",
  address: "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF",
  txHash: "0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1",
  blockNumber: "19999999",
  timestamp: new Date().toISOString(),
  explorerUrl: "https://etherscan.io/tx/0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1",
  attribution: {
    label: "Binance Hot Wallet",
    confidence: "high",
    reason: "etherscan-tag",
    addressType: "eoa",
    isProxy: false,
  },
};

const cfg = loadAlertConfig();
if (!cfg) {
  console.error("SMTP_HOST not set — cannot send test email. Check your .env or environment variables.");
  process.exit(1);
}

let history: StoredEvent[] | undefined;
if (includeHistory) {
  const runtime = loadRuntimeConfig();
  const state = new State(new FileStateBackend(runtime.stateFile));
  await state.load();
  history = state.recentEvents(30);

  if (history.length === 0) {
    // Provide dummy rows so the history section renders something useful in the preview.
    history = [
      {
        ts: new Date(Date.now() - 1 * 86400_000).toISOString(),
        action: "freeze",
        token: "USDC",
        chain: "Base",
        address: "0x1234567890abcdef1234567890abcdef12345678",
        txHash: "0x111",
        label: "Coinbase",
      },
      {
        ts: new Date(Date.now() - 3 * 86400_000).toISOString(),
        action: "unfreeze",
        token: "USDT",
        chain: "Ethereum",
        address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        txHash: "0x222",
      },
      {
        ts: new Date(Date.now() - 7 * 86400_000).toISOString(),
        action: "freeze",
        token: "USDT",
        chain: "Arbitrum",
        address: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        txHash: "0x333",
        label: "Unknown CEX",
      },
    ];
    console.log("[test-alert] No recent events in state.json — using 3 dummy history rows.");
  } else {
    console.log(`[test-alert] Loaded ${history.length} real event(s) from state.json.`);
  }
}

console.log(`Sending test alert to: ${cfg.to.join(", ")}`);
const ok = await sendAlert(fakeAlert, cfg, history);
if (ok) {
  console.log("Sent successfully.");
} else {
  console.error(`Failed after ${cfg.maxAttempts} attempts.`);
  process.exit(1);
}
