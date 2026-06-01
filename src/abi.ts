import { parseAbiItem } from "viem";

// Human-readable event fragments. viem derives topic0 from these — never hardcode hashes.
// USDT (TetherToken) and USDC (FiatToken) blacklist lifecycle events.
export const USDT_EVENTS = {
  AddedBlackList: parseAbiItem("event AddedBlackList(address _user)"),
  RemovedBlackList: parseAbiItem("event RemovedBlackList(address _user)"),
  DestroyedBlackList: parseAbiItem("event DestroyedBlackList(address _blackListedUser)"),
} as const;

export const USDC_EVENTS = {
  Blacklisted: parseAbiItem("event Blacklisted(address indexed _account)"),
  UnBlacklisted: parseAbiItem("event UnBlacklisted(address indexed _account)"),
} as const;

export type TokenSymbol = "USDT" | "USDC";

// Whether an event represents a freeze (true) or an unfreeze (false).
export const FREEZE_EVENTS = new Set<string>([
  "AddedBlackList",
  "DestroyedBlackList",
  "Blacklisted",
]);

// All event ABI items for a given token, used as the getLogs `events` filter.
export function eventsFor(token: TokenSymbol) {
  return token === "USDT" ? Object.values(USDT_EVENTS) : Object.values(USDC_EVENTS);
}

// The single `address` argument is named differently per event; normalize extraction here.
export function extractAddress(args: Record<string, unknown>): string | undefined {
  const v = args._user ?? args._account ?? args._blackListedUser;
  return typeof v === "string" ? v : undefined;
}
