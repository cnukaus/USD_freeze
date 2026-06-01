import { readFile } from "node:fs/promises";

// Optional local name-tag dataset: a JSON object mapping lowercased address -> label,
// e.g. { "0xd90e2...": "Tornado.Cash: Router" }. This is the free way to get real
// Etherscan-style public name tags offline — populate it from a community labels dump
// (e.g. the brianleect/etherscan-labels datasets). Set LABELS_FILE to its path.
let cache: Record<string, string> | null = null;

export async function getLabel(address: string): Promise<string | undefined> {
  const file = process.env.LABELS_FILE;
  if (!file) return undefined;
  if (!cache) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
      cache = Object.fromEntries(
        Object.entries(parsed).map(([k, v]) => [k.toLowerCase(), v]),
      );
    } catch {
      cache = {};
    }
  }
  return cache[address.toLowerCase()];
}
