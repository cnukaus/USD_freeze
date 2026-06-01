import "./env.js"; // load .env before anything reads process.env
import { createPublicClient, http, type Address } from "viem";
import { CHAINS } from "./config.js";
import { getSource, getDeployer, type SourceInfo } from "./attribution/etherscan.js";
import { getArkham, type ArkhamInfo } from "./attribution/arkham.js";
import { isSanctioned } from "./attribution/ofac.js";
import { getLabel } from "./attribution/labels.js";
import { getDuneLabel, type DuneLabel } from "./attribution/dune.js";

// EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1
const EIP1967_IMPL =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

export interface AddressSignals {
  label?: string; // local labels-file name tag (Etherscan-style)
  source?: SourceInfo | null; // verified ContractName / proxy info
  arkham?: ArkhamInfo | null;
  dune?: DuneLabel | null; // Dune labels.all
  sanctioned?: boolean; // OFAC SDN
}

export interface Attribution {
  address: string;
  type: "contract" | "eoa";
  isProxy: boolean;
  implementation?: string;
  deployer?: string;
  primary: AddressSignals;
  implSignals?: AddressSignals; // signals for the implementation (proxies)
  deployerSignals?: AddressSignals; // signals for the deployer (contracts)
  attribution: string;
  confidence: "high" | "medium" | "low" | "none";
  reason: string;
}

function resolveChain(key: string) {
  const cfg = CHAINS.find((c) => c.key === key.toUpperCase());
  if (!cfg) throw new Error(`Unknown chain key '${key}'. Known: ${CHAINS.map((c) => c.key).join(", ")}`);
  const rpcUrl = process.env[cfg.rpcEnv];
  if (!rpcUrl) throw new Error(`Set ${cfg.rpcEnv} to a ${cfg.chain.name} RPC URL.`);
  return { cfg, rpcUrl };
}

// Gather the label layers for one address: Etherscan, Arkham, (optional) Dune, OFAC.
// Dune costs credits + polling latency, so it's only enabled for the primary address.
async function gather(
  address: string,
  chainId: number,
  arkhamChain: string,
  opts: { dune: boolean } = { dune: false },
): Promise<AddressSignals> {
  const [label, source, arkham, dune, sanctioned] = await Promise.all([
    getLabel(address),
    getSource(address, chainId),
    getArkham(address, arkhamChain),
    opts.dune ? getDuneLabel(address, arkhamChain) : Promise.resolve(null),
    isSanctioned(address),
  ]);
  return { label, source, arkham, dune, sanctioned };
}

// Priority per request: Etherscan (name tag → verified name) → Arkham → OFAC, then deployer.
function decide(a: Omit<Attribution, "attribution" | "confidence" | "reason">): {
  attribution: string;
  confidence: Attribution["confidence"];
  reason: string;
} {
  const p = a.primary;
  const impl = a.implSignals;
  const dep = a.deployerSignals;

  // 1. Etherscan name tag (local labels file) on the address itself
  if (p.label) return { attribution: p.label, confidence: "high", reason: "Etherscan name tag" };

  // 2. Verified contract name — prefer the implementation's name for proxies
  if (impl?.source?.verified && impl.source.contractName)
    return { attribution: impl.source.contractName, confidence: "medium", reason: "verified implementation contract name" };
  if (p.source?.verified && p.source.contractName)
    return { attribution: p.source.contractName, confidence: "medium", reason: "verified contract name" };

  // 3. Arkham entity/label (address, then implementation)
  const ark = p.arkham?.entity || p.arkham?.label || impl?.arkham?.entity || impl?.arkham?.label;
  if (ark) return { attribution: ark, confidence: "high", reason: "Arkham entity" };

  // 4. Dune label (primary address only)
  if (p.dune?.name) return { attribution: p.dune.name, confidence: "high", reason: "Dune label" };

  // 5. OFAC
  if (p.sanctioned || impl?.sanctioned)
    return { attribution: "OFAC SDN sanctioned entity", confidence: "high", reason: "OFAC SDN list" };

  // 6. Deployer attribution (contracts only)
  if (dep?.label) return { attribution: `deployer: ${dep.label}`, confidence: "medium", reason: "Etherscan name tag (deployer)" };
  const depArk = dep?.arkham?.entity || dep?.arkham?.label;
  if (depArk) return { attribution: `deployer: ${depArk}`, confidence: "medium", reason: "Arkham entity (deployer)" };
  if (dep?.sanctioned) return { attribution: "deployer: OFAC SDN sanctioned", confidence: "medium", reason: "OFAC SDN list (deployer)" };

  return { attribution: "unattributed", confidence: "none", reason: "no label, verified source, Arkham entity, or OFAC match" };
}

export async function attribute(address: string, chainKey = "ETHEREUM"): Promise<Attribution> {
  const { cfg, rpcUrl } = resolveChain(chainKey);
  const client = createPublicClient({ chain: cfg.chain, transport: http(rpcUrl) });
  const chainId = cfg.chain.id;
  const arkhamChain = cfg.chain.name.toLowerCase().split(" ")[0];

  const code = await client.getCode({ address: address as Address });
  const isContract = !!code && code !== "0x";

  // Proxy resolution via EIP-1967 slot (covers the common transparent/UUPS proxies).
  let implementation: string | undefined;
  if (isContract) {
    try {
      const raw = await client.getStorageAt({ address: address as Address, slot: EIP1967_IMPL });
      if (raw && /[1-9a-f]/i.test(raw.slice(26))) implementation = "0x" + raw.slice(26);
    } catch {
      /* not a 1967 proxy */
    }
  }

  const primary = await gather(address, chainId, arkhamChain, { dune: true });

  let implSignals: AddressSignals | undefined;
  if (implementation) implSignals = await gather(implementation, chainId, arkhamChain);

  let deployer: string | undefined;
  let deployerSignals: AddressSignals | undefined;
  if (isContract) {
    const dep = await getDeployer(address, chainId);
    deployer = dep?.deployer;
    if (deployer) deployerSignals = await gather(deployer, chainId, arkhamChain);
  }

  const base = {
    address,
    type: (isContract ? "contract" : "eoa") as Attribution["type"],
    isProxy: !!implementation,
    implementation,
    deployer,
    primary,
    implSignals,
    deployerSignals,
  };
  return { ...base, ...decide(base) };
}

// ---- CLI ----
async function main(): Promise<void> {
  const address = process.argv[2];
  const chainKey = process.argv[3] ?? "ETHEREUM";
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    console.error("Usage: npm run attribute -- <0xADDRESS> [CHAIN_KEY]");
    process.exit(1);
  }

  const r = await attribute(address, chainKey);
  const tag = (s?: AddressSignals) =>
    s
      ? [
          s.label && `tag=${s.label}`,
          s.source?.verified && `name=${s.source.contractName}`,
          (s.arkham?.entity || s.arkham?.label) && `arkham=${s.arkham?.entity ?? s.arkham?.label}`,
          s.dune?.name && `dune=${s.dune.name}`,
          s.sanctioned && "OFAC=SANCTIONED",
        ]
          .filter(Boolean)
          .join("  ") || "(no signals)"
      : "(n/a)";

  console.log(`\nAddress:        ${r.address}`);
  console.log(`Type:           ${r.type}${r.isProxy ? " (proxy)" : ""}`);
  if (r.implementation) console.log(`Implementation: ${r.implementation}  ->  ${tag(r.implSignals)}`);
  if (r.deployer) console.log(`Deployer:       ${r.deployer}  ->  ${tag(r.deployerSignals)}`);
  console.log(`Address signals:${" "}${tag(r.primary)}`);
  console.log(`\n=> Attribution: ${r.attribution}  [${r.confidence}]  (${r.reason})\n`);
}

// Run as CLI only when invoked directly (tsx runs .ts, build runs .js).
if (process.argv[1] && /attribute\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error("attribute failed:", err);
    process.exit(1);
  });
}
