# USD Freeze Monitor

Watches USDC + USDT blacklist (freeze/unfreeze) events across Ethereum + EVM L2s and emails
an alert on each new event. Node.js + viem, polling `eth_getLogs`. Stateful, reorg-safe,
idempotent.

## How it works
- Per chain, polls `getLogs` for the blacklist events from the last saved block up to
  `head − confirmations` (reorg safety), in capped block-range chunks.
- Persists `lastProcessedBlock` per `(chain, token)` and a dedup set of `(chain, tx, logIndex)`,
  so restarts resume cleanly and no event is emailed twice.
- A failed email holds the cursor back so the event retries on the next run.

Events: USDT `AddedBlackList` / `DestroyedBlackList` / `RemovedBlackList`, USDC
`Blacklisted` / `UnBlacklisted`.

## Two ways to run

### A. Long-running process (VPS, Pi, Fly.io)
```bash
cp .env.example .env   # fill in RPC_* and EMAIL_API_*
npm install
npm run dev            # or: npm run build && npm start

(RPC_ETHEREUM="https://ethereum-rpc.publicnode.com" LATEST_LOOKBACK="200000" npm run latest -- 10 > /tmp/latest.out 2>&1; echo "EXIT=$?"; echo "=== OUTPUT ==

```

 It works — here are the 10 most recent real blacklistings on Ethereum (newest first), live from chain:

  2026-05-30T16:12:47Z  USDT  freeze  0x0E4AE4482Bd57a14dD8ab3ABaE16bd5a5B21275d
  2026-05-30T07:47:23Z  USDT  freeze  0x4280926BD82cab3Dd90AD637AF9A1Ad7cF4d5cD8
  2026-05-30T01:08:11Z  USDC  freeze  0xe978F22157048E5DB8E5d07971376e86671672B2
  2026-05-29T14:34:47Z  USDT  freeze  0x452D50E7508aF8285f9c145E11f825ee22d95927
  2026-05-29T14:34:47Z  USDT  freeze  0x0aa1eF24958f30583Dca65e3CCeCCB91a96aA282
  2026-05-26T16:17:35Z  USDC  freeze  0x552aCF535b735662959563d36D80405e7aE745EF
  ... (+4 more, each with etherscan tx link)

  How you query it

  RPC_ETHEREUM="https://..." npm run latest          # last 20 freeze events
  RPC_ETHEREUM="https://..." npm run latest -- 50     # last 50
  LATEST_INCLUDE_UNFREEZE=1 npm run latest            # include unblacklistings too
  LATEST_LOOKBACK=1000000 npm run latest              # scan a deeper window

  It scans every chain whose RPC_* is set (so add L2 RPCs to query them too), merges results newest-first, and prints time · token · chain · action · address · tx link. Stateless — it asks the chain directly, so it works whether or not the monitor has ever run.

  Important distinction

  - npm run latest = on-demand "who's been frozen recently" — what you just asked for.
  - The monitor (tick/cron) = real-time alerts on new freezes, but it does not keep a queryable history. Its state.json has tx hashes for dedup, not addresses.

  So if you want a persistent, growing list you can query offline (e.g. "all addresses ever blacklisted," filter/search, feed a dashboard), the latest command isn't that — it re-scans the chain each time and is bounded by LATEST_LOOKBACK. For that you'd want the monitor to append
  each event to events.jsonl or SQLite as it detects them.

  Want me to add that persistence to the watcher (append-only events.jsonl + a query command over it)? It's a small addition and would give you both real-time alerts and a queryable local history.

### B. Free GitHub Actions cron (~5 min cadence)
The workflow `.github/workflows/monitor.yml` runs `npm run tick` every 5 minutes and commits
the updated `state.json` back to the repo to persist the cursor between runs.

Setup:
1. Push this repo to GitHub.
2. Add **repository secrets** (Settings → Secrets and variables → Actions → Secrets):
   `RPC_ETHEREUM`, `RPC_BASE`, `RPC_ARBITRUM`, `RPC_OPTIMISM`, `RPC_POLYGON`,
   `EMAIL_API_URL`, `EMAIL_API_KEY`.
3. Add **repository variables** (same page → Variables): `EMAIL_API_AUTH_MODE`
   (`bearer` | `header` | `body`) and, if `header`, `EMAIL_API_AUTH_HEADER`.
4. Enable Actions. The cron starts automatically; trigger once manually via
   *Actions → blacklist-monitor → Run workflow* to seed `state.json`.

Notes:
- Scheduled Actions can be delayed under load — actual cadence is *~5 min*, matching the
  accepted tolerance. Not for sub-minute needs.
- `state.json` is committed every run it changes (`[skip ci]`). To keep this noise off your
  main branch, point `STATE_FILE` at a path on a dedicated `state` branch or swap in a KV
  `StateBackend` (see `src/state.ts`).

## Before trusting L2 USDT
Bridged tokens (`USDC.e`, most bridged USDT) do **not** implement the blacklist. Run:
```bash
npm run verify
```
It probes each configured `(chain, token)` for real blacklist events. Only flip
`enabled: true` in `src/config.ts` for pairs that PASS. Native USDC + Ethereum USDT are
enabled by default; L2 USDT ships disabled pending verification.

## Local dev tip
Set `STATE_FILE=./state.local.json` (gitignored) so dev runs don't dirty the tracked
`state.json`.

## Security
- All secrets via env / GitHub Actions secrets — never committed.
- `state.json` holds only block numbers and tx hashes (no secrets).
- No file deletion or absolute-path operations anywhere in the runtime.
