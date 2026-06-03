import { readFile, writeFile, rename } from "node:fs/promises";

// Persistent, incremental cursor + dedup memory.
// Shape: { cursors: { "<chainId>:<token>": lastProcessedBlock }, seen: [...], events: [...] }
interface StateShape {
  cursors: Record<string, string>; // bigint serialized as string
  seen: string[];
  events?: StoredEvent[];
}

export interface StoredEvent {
  ts: string;        // ISO 8601
  action: "freeze" | "unfreeze";
  token: string;
  chain: string;
  address: string;
  txHash: string;
  label?: string;    // attribution label if available
}

const SEEN_CAP = 5000; // ring buffer; far larger than one confirmation window

// Pluggable persistence. Long-running deploys use a local file; ephemeral/serverless
// deploys (e.g. GitHub Actions cron) can swap in a backend backed by a durable store.
// State only knows how to (de)serialize a single blob — the backend owns durability.
export interface StateBackend {
  read(): Promise<string | null>;
  write(data: string): Promise<void>;
}

export class FileStateBackend implements StateBackend {
  constructor(private readonly file: string) {}

  async read(): Promise<string | null> {
    try {
      return await readFile(this.file, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  // Atomic write (temp file + rename) so a crash mid-write can't corrupt state.
  async write(data: string): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

export class State {
  private cursors = new Map<string, bigint>();
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private events: StoredEvent[] = [];
  private dirty = false;

  constructor(private readonly backend: StateBackend) {}

  static cursorKey(chainId: number, token: string): string {
    return `${chainId}:${token}`;
  }
  static seenKey(chainId: number, txHash: string, logIndex: number): string {
    return `${chainId}:${txHash}:${logIndex}`;
  }

  async load(): Promise<void> {
    const raw = await this.backend.read();
    if (raw == null) return; // first run: no state yet
    const parsed = JSON.parse(raw) as StateShape;
    for (const [k, v] of Object.entries(parsed.cursors ?? {})) {
      this.cursors.set(k, BigInt(v));
    }
    for (const s of parsed.seen ?? []) {
      this.seen.add(s);
      this.seenOrder.push(s);
    }
    for (const e of parsed.events ?? []) {
      this.events.push(e);
    }
  }

  getCursor(key: string): bigint | undefined {
    return this.cursors.get(key);
  }

  setCursor(key: string, block: bigint): void {
    if (this.cursors.get(key) === block) return;
    this.cursors.set(key, block);
    this.dirty = true;
  }

  hasSeen(key: string): boolean {
    return this.seen.has(key);
  }

  markSeen(key: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > SEEN_CAP) {
      const evicted = this.seenOrder.shift();
      if (evicted) this.seen.delete(evicted);
    }
    this.dirty = true;
  }

  addEvent(e: StoredEvent): void {
    this.events.push(e);
    this.dirty = true;
  }

  recentEvents(maxAgeDays: number): StoredEvent[] {
    const cutoff = Date.now() - maxAgeDays * 86400_000;
    return this.events.filter((e) => new Date(e.ts).getTime() >= cutoff);
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    // Prune events to last 30 days and cap at 1000 to keep state.json small.
    const eventCutoff = Date.now() - 30 * 86400_000;
    this.events = this.events
      .filter((e) => new Date(e.ts).getTime() >= eventCutoff)
      .slice(-1000);
    const shape: StateShape = {
      cursors: Object.fromEntries(
        [...this.cursors].map(([k, v]) => [k, v.toString()]),
      ),
      seen: this.seenOrder,
      events: this.events,
    };
    await this.backend.write(JSON.stringify(shape, null, 2));
    this.dirty = false;
  }
}
