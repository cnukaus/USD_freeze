import { createPublicClient, http, type PublicClient, type Log } from "viem";
import type { ChainConfig, RuntimeConfig } from "./config.js";
import { eventsFor, extractAddress, FREEZE_EVENTS, type TokenSymbol } from "./abi.js";
import { State } from "./state.js";
import { loadAlertConfig, sendAlert, type FreezeAlert } from "./alert.js";
import { attribute } from "./attribute.js";

const alertCfg = loadAlertConfig();
// Attribution is best-effort enrichment; set ATTRIBUTION=off to skip it entirely.
const attributionEnabled = process.env.ATTRIBUTION !== "off";

// One watcher per chain. Polls getLogs in capped ranges, decodes, dedups, alerts,
// and only advances the cursor past blocks it has fully processed.
export class ChainWatcher {
  private client: PublicClient;
  private stopped = false;

  constructor(
    private readonly cfg: ChainConfig,
    private readonly rpcUrl: string,
    private readonly runtime: RuntimeConfig,
    private readonly state: State,
  ) {
    this.client = createPublicClient({
      chain: cfg.chain,
      transport: http(rpcUrl),
    });
  }

  stop(): void {
    this.stopped = true;
  }

  async runForever(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (err) {
        console.error(`[${this.cfg.key}] tick error:`, err);
      }
      await this.delay(this.runtime.pollIntervalMs);
    }
  }

  // Process [cursor+1 .. head-confirmations] for every enabled token, chunked by max range.
  async tick(): Promise<void> {
    const head = await this.client.getBlockNumber();
    const safeHead = head - this.cfg.confirmations;
    if (safeHead <= 0n) return;

    for (const token of this.cfg.tokens) {
      const cursorKey = State.cursorKey(this.cfg.chain.id, token.symbol);
      // First run for this pair: start at safe head (don't backfill all history by default).
      let from = (this.state.getCursor(cursorKey) ?? safeHead - 1n) + 1n;
      if (from > safeHead) continue;

      while (from <= safeHead && !this.stopped) {
        const to =
          from + this.runtime.getLogsMaxRange - 1n > safeHead
            ? safeHead
            : from + this.runtime.getLogsMaxRange - 1n;

        const logs = await this.client.getLogs({
          address: token.address,
          events: eventsFor(token.symbol),
          fromBlock: from,
          toBlock: to,
        });

        // Track the earliest block whose alert failed to deliver; the cursor must not
        // advance past it, or that event is lost forever. Delivered logs are in the
        // seen-set, so re-scanning the range next tick won't re-send them.
        let firstUndelivered: bigint | undefined;
        for (const log of logs) {
          const ok = await this.handleLog(token.symbol, log);
          if (!ok && log.blockNumber != null) {
            firstUndelivered =
              firstUndelivered == null
                ? log.blockNumber
                : log.blockNumber < firstUndelivered
                  ? log.blockNumber
                  : firstUndelivered;
          }
        }

        const newCursor = firstUndelivered != null ? firstUndelivered - 1n : to;
        this.state.setCursor(cursorKey, newCursor);
        await this.state.flush();
        if (firstUndelivered != null) break; // retry from here on the next tick
        from = to + 1n;
      }
    }
  }

  // Returns true if the log was handled (delivered or already seen), false if a send
  // failed and the event still needs to be retried.
  private async handleLog(
    token: TokenSymbol,
    // viem decodes eventName + args onto the log when `events` is supplied
    log: Log & { eventName?: string; args?: Record<string, unknown> },
  ): Promise<boolean> {
    if (log.transactionHash == null || log.logIndex == null) return true;

    const seenKey = State.seenKey(this.cfg.chain.id, log.transactionHash, log.logIndex);
    if (this.state.hasSeen(seenKey)) return true;

    const eventName = log.eventName ?? "unknown";
    const address = extractAddress(log.args ?? {}) ?? "unknown";

    let timestamp = new Date().toISOString();
    try {
      if (log.blockNumber != null) {
        const block = await this.client.getBlock({ blockNumber: log.blockNumber });
        timestamp = new Date(Number(block.timestamp) * 1000).toISOString();
      }
    } catch {
      /* fall back to now() */
    }

    // Best-effort project/author attribution. Must never block or drop the alert.
    let attribution: FreezeAlert["attribution"];
    if (attributionEnabled && address !== "unknown") {
      try {
        const a = await attribute(address, this.cfg.key);
        attribution = {
          label: a.attribution,
          confidence: a.confidence,
          reason: a.reason,
          addressType: a.type,
          isProxy: a.isProxy,
          implementation: a.implementation,
          deployer: a.deployer,
        };
      } catch (err) {
        console.warn(`[${this.cfg.key}] attribution failed for ${address}:`, err);
      }
    }

    const alert: FreezeAlert = {
      event: eventName,
      action: FREEZE_EVENTS.has(eventName) ? "freeze" : "unfreeze",
      token,
      chain: this.cfg.chain.name,
      address,
      txHash: log.transactionHash,
      blockNumber: (log.blockNumber ?? 0n).toString(),
      timestamp,
      explorerUrl: this.cfg.explorerTx(log.transactionHash),
      attribution,
    };

    let delivered = true;
    if (alertCfg) {
      const history = alertCfg.includeHistory ? this.state.recentEvents(30) : undefined;
      delivered = await sendAlert(alert, alertCfg, history);
    } else {
      console.log("[alert:console]", JSON.stringify(alert));
    }

    // Mark seen only once handled (delivered or logged) so a send failure can retry
    // on the next tick rather than being silently dropped.
    if (delivered) {
      this.state.markSeen(seenKey);
      this.state.addEvent({
        ts: alert.timestamp,
        action: alert.action,
        token: alert.token,
        chain: alert.chain,
        address: alert.address,
        txHash: alert.txHash,
        label: alert.attribution?.label,
      });
    }
    return delivered;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
