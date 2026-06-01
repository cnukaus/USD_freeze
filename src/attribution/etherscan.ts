// Etherscan v2 multichain API (one key, all chains via chainid param).
// Free tier covers getsourcecode (verified ContractName + proxy/implementation) and
// getcontractcreation (deployer). NOTE: the public "Name Tag" shown on the website is NOT
// available on the free API — for real name tags use a local labels dataset (see labels.ts)
// or an Etherscan Pro key. ContractName from verified source is the free signal.
const BASE = "https://api.etherscan.io/v2/api";

function key(): string {
  return process.env.ETHERSCAN_API_KEY ?? "";
}

export interface SourceInfo {
  verified: boolean;
  contractName?: string;
  isProxy: boolean;
  implementation?: string;
}

const isAddr = (s: unknown): s is string =>
  typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s) && s !== "0x" + "0".repeat(40);

export async function getSource(address: string, chainId = 1): Promise<SourceInfo | null> {
  if (!key()) return null;
  const url = `${BASE}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${key()}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = (await res.json()) as { result?: Array<Record<string, string>> };
    const r = j.result?.[0];
    if (!r) return null;
    const verified = !!r.ABI && r.ABI !== "Contract source code not verified";
    return {
      verified,
      contractName: r.ContractName || undefined,
      isProxy: r.Proxy === "1",
      implementation: isAddr(r.Implementation) ? r.Implementation : undefined,
    };
  } catch {
    return null;
  }
}

export async function getDeployer(
  address: string,
  chainId = 1,
): Promise<{ deployer?: string; txHash?: string } | null> {
  if (!key()) return null;
  const url = `${BASE}?chainid=${chainId}&module=contract&action=getcontractcreation&contractaddresses=${address}&apikey=${key()}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = (await res.json()) as { result?: Array<Record<string, string>> };
    const r = j.result?.[0];
    if (!r) return null;
    return { deployer: isAddr(r.contractCreator) ? r.contractCreator : undefined, txHash: r.txHash };
  } catch {
    return null;
  }
}
