# USDC/USDT Blacklist Monitor — Implementation Plan

Watch USDC + USDT freeze/unfreeze events across Ethereum + EVM L2s and email an alert
on each new event. Node.js + viem. Polling `getLogs`, stateful/resumable, idempotent.

## Stage 2:
 Tier 1 — Label/attribution APIs (highest signal, least work)

  Give an address, get back a project/entity name. This is what you actually want.

  - Etherscan/Blockscout "Name Tag" + verified ContractName — getsourcecode returns the verified contract's name (e.g. UniswapV2Router, GnosisSafeProxy) and public name tags ("Tornado.Cash: Router"). The single best free starting point. ~5 req/s free key.
  - Arkham Intelligence API — purpose-built entity attribution ("this address belongs to X protocol/person"). Closest to "author."
  - Nansen / 0xScope / MistTrack (SlowMist) — wallet & contract labels, entity clusters. MistTrack has a usable free tier and is strong on illicit-actor attribution.
  - OFAC SDN crypto list (free, downloadable) — many USDC/USDT freezes mirror sanctions; this maps an address directly to a named entity (Lazarus, Tornado Cash, etc.).

  Tier 2 — On-chain attribution (free, no third party)

  Works when labels don't exist yet.

  - Verified source / contract name (via explorer) → resolve proxy → name of the implementation (the proxy itself is anonymous; the impl is where the project identity lives).
  - Deployer address (getcontractcreation) → then label the deployer. A project's deployer EOA is usually reused and often already labeled — this is frequently how you find the "author."
  - Bytecode fingerprinting — hash/selector-match the implementation against known contracts (it's a Safe, a Uniswap pool, a specific router, a known drainer template). Catches reused/forked code.

  Tier 3 — Graph heuristics (when 1 & 2 fail)

  - Funding source & counterparties — who funded it, where funds flow (known mixer in, known CEX deposit out). Tools: Arkham, MetaSleuth, Breadcrumbs. This is how you attribute when there's no label and no verified source — but it's fuzzy and often the honest answer is "unknown."

  Recommended automated pipeline

  For each blacklisted contract (you already gate on eth_getCode ≠ empty):
  1. Resolve proxy → implementation.
  2. Explorer lookup on impl + proxy: verified name + name tags. → most hits stop here.
  3. Deployer lookup → label the deployer.
  4. Cross-reference OFAC SDN + a label dataset.
  5. Fallback: Arkham/MistTrack entity API.
  6. Else → unattributed.

  Reality check: a large share of blacklisted addresses are EOAs (scam/sanctioned wallets), not contracts — your contract-only filter drops those. Of the contracts, many are thin proxies or fresh drainer deployments with no verified source and no label yet → genuinely
  unattributable by automation. Expect maybe 40–70% attributable, the rest unknown.


 It works — here are the 10 most recent real blacklistings on Ethereum (newest first), live from chain:

  2026-05-30T16:12:47Z  USDT  freeze  0x0E4AE4482Bd57a14dD8ab3ABaE16bd5a5B21275d
  2026-05-30T07:47:23Z  USDT  freeze  0x4280926BD82cab3Dd90AD637AF9A1Ad7cF4d5cD8
  2026-05-30T01:08:11Z  USDC  freeze  0xe978F22157048E5DB8E5d07971376e86671672B2
  2026-05-29T14:34:47Z  USDT  freeze  0x452D50E7508aF8285f9c145E11f825ee22d95927
  2026-05-29T14:34:47Z  USDT  freeze  0x0aa1eF24958f30583Dca65e3CCeCCB91a96aA282
  2026-05-26T16:17:35Z  USDC  freeze  0x552aCF535b735662959563d36D80405e7aE745EF
  ... (+4 more, each with etherscan tx link)

## Design invariants (do not violate)
- **Incremental**: persist `lastProcessedBlock` per `(chain, token)`; never re-read full history.
- **Reorg-safe**: only process logs up to `head − confirmations`.
- **Idempotent**: dedup by `(chainId, txHash, logIndex)`; an alert is sent at most once.
- **Bridged-token trap**: only monitor *native* USDC (not `USDC.e`) and deployments that
  actually implement the blacklist. Verify each `(chain, token)` emits events before enabling.
- **OPSEC**: RPC + email secrets only in `.env`/secret store; `state.json` restrictive perms.
  No deletes, no absolute paths in any runtime code.

## Events monitored
| Token | Event | Meaning |
|---|---|---|
| USDT | `AddedBlackList(address)` | freeze |
| USDT | `DestroyedBlackList(address)` | freeze + burn |
| USDT | `RemovedBlackList(address)` | unfreeze |
| USDC | `Blacklisted(address indexed)` | freeze |
| USDC | `UnBlacklisted(address indexed)` | unfreeze |

---

## Stage 1: Config + ABI + skeleton
**Goal**: Typed config for chains/tokens, event ABI fragments, and an `index.ts` that
boots one watcher per chain (no network calls yet).
**Success Criteria**: `npm run build` compiles; `npm start` logs the resolved config and
exits cleanly when no RPC URLs are set.
**Tests**: config loader rejects a chain with a missing RPC env var; ABI exports decode a
known sample log into the right event name + address.
**Status**: Complete — config.ts/abi.ts/index.ts; topic encoding verified live.

## Stage 2: Stateful poll loop (read-only)
**Goal**: Per-chain loop that calls `getLogs(from, to)` in capped block ranges, decodes
events, and advances `lastProcessedBlock`. Alerts stubbed to `console.log`.
**Success Criteria**: Run against Ethereum, backfill a historical range containing a known
`AddedBlackList`, and see it printed exactly once. Restart resumes from saved block.
**Tests**: range chunking splits a >cap span correctly; confirmations subtract from head;
dedup set suppresses a duplicate `(txHash, logIndex)`.
**Status**: Complete — watcher.ts/state.ts; live tick advanced ETH cursors + persisted state.
Cursor-held-back-on-send-failure bug found and fixed.

## Stage 3: Alerting
**Goal**: `alert.ts` POSTs the payload to the email API with retry/backoff. Auth shape
configurable via env (bearer / header / body field) since the API contract is TBD.
**Success Criteria**: With a mock HTTP server, a detected event produces exactly one POST
with the documented JSON payload; a 5xx triggers retry then surfaces a logged error.
**Tests**: payload shape matches schema; retry stops after N attempts; a failed send does
NOT advance state for that log (so it retries next tick) — or is queued, decide in stage.
**Status**: In Progress — alert.ts implemented (retry/backoff, pluggable auth) and wired;
failed-send holds cursor back. BLOCKED on real email API contract before final wiring/test.

## Stage 4: Per-deployment verification + enablement
**Goal**: A one-off `verify` script that confirms each `(chain, token)` address actually
emits the expected events (probe historical logs / check bytecode for selectors). Enable
only verified pairs in config.
**Success Criteria**: Script prints a PASS/FAIL table; bridged USDT/USDC.e deployments are
flagged FAIL and left disabled.
**Tests**: known-good (Ethereum USDT/USDC) → PASS; a plain ERC-20 address → FAIL.
**Status**: In Progress — verify.ts done, chunks getLogs, short-circuits on first hit.
Ethereum USDC + USDT both PASS live. L2 USDT pairs still disabled pending RPC + verify run.

## Stage 5: Hardening / ops
**Goal**: Structured logging, health heartbeat, RPC failover (multiple URLs per chain),
graceful shutdown persisting state, and a dead-simple run-as-service doc.
**Success Criteria**: Kill -TERM mid-loop persists state; primary RPC failure fails over to
secondary; no event lost across a forced restart during backfill.
**Tests**: shutdown flushes state; failover switches transport on simulated RPC error.
**Status**: In Progress — graceful SIGINT/SIGTERM flush done; run-once `tick.ts` + GitHub
Actions cron (commit-back state persistence) + pluggable `StateBackend` shipped. Still TODO:
multi-URL RPC failover, structured logging, health heartbeat.

---

## Stage 6: Address attribution (`npm run attribute`)
**Goal**: Given a blacklisted address, name the project/author. Layers in order:
Etherscan (name tag via LABELS_FILE → verified ContractName) → Arkham entity → OFAC SDN.
Handles EOAs; for contracts resolves EIP-1967 proxy → implementation and looks up the
deployer (and labels the deployer).
**Success Criteria**: prints type, proxy impl, deployer, per-source signals, and a single
best-guess attribution + confidence.
**Tests**: contract vs EOA detection; proxy impl resolved; OFAC membership hit/miss.
**Status**: Complete (pipeline) — live on example: contract→proxy detected, impl resolved,
OFAC fetched/cached (93 addrs). Etherscan/Arkham/Dune layers need API keys to produce names.
Dune layer added (dune/label_query.sql + src/attribution/dune.ts, execute→poll→results).
Wired into the watcher: alert emails now carry an `attribution` block (verified live via
backfill tick over a real Blacklisted event). Best-effort; ATTRIBUTION=off disables.

## Open items (need input)
- **Email API contract**: endpoint URL, auth (bearer vs custom header vs body), expected
  request body fields, success status code. Blocks Stage 3 wiring.
- **L2 USDT reality**: confirm which L2 USDT deployments carry the blacklist (Stage 4).

## Canonical addresses to verify (native deployments)
| Chain | USDC (native) | USDT |
|---|---|---|
| Ethereum | 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 | 0xdAC17F958D2ee523a2206206994597C13D831ec7 |
| Base | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 | (no native USDT) |
| Arbitrum | 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 | 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9 |
| Optimism | 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85 | 0x94b008aA00579c1307B0EF2c499aD98a8ce58e58 |
| Polygon | 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 | 0xc2132D05D31c914a87C6611C10748AEb04B58e8F |
