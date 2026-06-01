import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// OFAC SDN sanctioned-address membership check. Uses the community-maintained,
// machine-readable mirror of the Treasury SDN crypto addresses. Stateful/incremental
// per project rules: fetch once, cache to disk, only refresh when stale.
const SOURCE =
  "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.json";
const CACHE = process.env.OFAC_CACHE ?? "./data/ofac_eth.json";
const MAX_AGE_MS = Number(process.env.OFAC_MAX_AGE_MS ?? 7 * 24 * 3600 * 1000);

interface CacheShape {
  fetchedAt: number;
  addresses: string[];
}

let mem: Set<string> | null = null;

export async function loadOfac(): Promise<Set<string>> {
  if (mem) return mem;

  let cache: CacheShape | null = null;
  try {
    cache = JSON.parse(await readFile(CACHE, "utf8")) as CacheShape;
  } catch {
    /* no cache yet */
  }

  const stale = !cache || Date.now() - cache.fetchedAt > MAX_AGE_MS;
  if (stale) {
    try {
      const res = await fetch(SOURCE);
      if (res.ok) {
        const arr = (await res.json()) as string[];
        cache = { fetchedAt: Date.now(), addresses: arr.map((a) => a.toLowerCase()) };
        await mkdir(dirname(CACHE), { recursive: true });
        await writeFile(CACHE, JSON.stringify(cache));
      }
    } catch {
      // Network failure → fall back to whatever (possibly stale) cache we have.
    }
  }

  mem = new Set(cache?.addresses ?? []);
  return mem;
}

export async function isSanctioned(address: string): Promise<boolean> {
  return (await loadOfac()).has(address.toLowerCase());
}
