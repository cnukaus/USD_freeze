import {
  mainnet,
  base,
  arbitrum,
  optimism,
  polygon,
  type Chain,
} from "viem/chains";
import type { Address } from "viem";
import type { TokenSymbol } from "./abi.js";

export interface TokenConfig {
  symbol: TokenSymbol;
  address: Address;
  // Set false until verified to actually emit blacklist events on this chain
  // (bridged USDC.e / bridged USDT do NOT). See `npm run verify`.
  enabled: boolean;
}

export interface ChainConfig {
  key: string; // env suffix, e.g. "ETHEREUM"
  chain: Chain;
  rpcEnv: string; // env var holding the RPC URL
  confirmations: bigint; // blocks behind head before a log is final enough to alert
  explorerTx: (hash: string) => string;
  tokens: TokenConfig[];
}

// Canonical *native* deployments. `enabled` reflects what reliably carries the blacklist;
// flip on after `npm run verify` passes for that pair.
export const CHAINS: ChainConfig[] = [
  {
    key: "ETHEREUM",
    chain: mainnet,
    rpcEnv: "RPC_ETHEREUM",
    confirmations: 12n,
    explorerTx: (h) => `https://etherscan.io/tx/${h}`,
    tokens: [
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", enabled: true },
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", enabled: true },
    ],
  },
  {
    key: "BASE",
    chain: base,
    rpcEnv: "RPC_BASE",
    confirmations: 30n,
    explorerTx: (h) => `https://basescan.org/tx/${h}`,
    tokens: [
      { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", enabled: true },
      // No canonical native USDT on Base.
    ],
  },
  {
    key: "ARBITRUM",
    chain: arbitrum,
    rpcEnv: "RPC_ARBITRUM",
    confirmations: 30n,
    explorerTx: (h) => `https://arbiscan.io/tx/${h}`,
    tokens: [
      { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", enabled: true },
      { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", enabled: false }, // verify
    ],
  },
  {
    key: "OPTIMISM",
    chain: optimism,
    rpcEnv: "RPC_OPTIMISM",
    confirmations: 30n,
    explorerTx: (h) => `https://optimistic.etherscan.io/tx/${h}`,
    tokens: [
      { symbol: "USDC", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", enabled: true },
      { symbol: "USDT", address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", enabled: false }, // verify
    ],
  },
  {
    key: "POLYGON",
    chain: polygon,
    rpcEnv: "RPC_POLYGON",
    confirmations: 50n,
    explorerTx: (h) => `https://polygonscan.com/tx/${h}`,
    tokens: [
      { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", enabled: true },
      { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", enabled: false }, // verify
    ],
  },
];

export interface RuntimeConfig {
  pollIntervalMs: number;
  getLogsMaxRange: bigint;
  stateFile: string;
}

export function loadRuntimeConfig(): RuntimeConfig {
  return {
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 15000),
    getLogsMaxRange: BigInt(process.env.GETLOGS_MAX_RANGE ?? 2000),
    stateFile: process.env.STATE_FILE ?? "./state.json",
  };
}

// Returns only chains whose RPC URL is configured, with only enabled tokens.
export function activeChains(): { cfg: ChainConfig; rpcUrl: string }[] {
  const out: { cfg: ChainConfig; rpcUrl: string }[] = [];
  for (const cfg of CHAINS) {
    const rpcUrl = process.env[cfg.rpcEnv];
    if (!rpcUrl) continue;
    const tokens = cfg.tokens.filter((t) => t.enabled);
    if (tokens.length === 0) continue;
    out.push({ cfg: { ...cfg, tokens }, rpcUrl });
  }
  return out;
}
