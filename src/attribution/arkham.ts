// Arkham Intelligence entity attribution. Requires ARKHAM_API_KEY (granted/paid plan).
// The response schema varies by plan/endpoint, so we parse defensively: pull an entity
// name and a label name from the most common field shapes and ignore the rest. Adjust
// `pickEntity`/`pickLabel` if your plan returns a different shape (set ARKHAM_DEBUG=1 to
// dump the raw JSON once and see the actual fields).
const BASE = process.env.ARKHAM_API_BASE ?? "https://api.arkhamintelligence.com";

export interface ArkhamInfo {
  entity?: string;
  label?: string;
}

function pickEntity(j: any): string | undefined {
  return (
    j?.arkhamEntity?.name ??
    j?.entity?.name ??
    j?.entity ??
    undefined
  );
}

function pickLabel(j: any): string | undefined {
  return j?.arkhamLabel?.name ?? j?.label?.name ?? j?.label ?? undefined;
}

export async function getArkham(
  address: string,
  chain = "ethereum",
): Promise<ArkhamInfo | null> {
  const apiKey = process.env.ARKHAM_API_KEY;
  if (!apiKey) return null;
  const url = `${BASE}/intelligence/address/${address}?chain=${chain}`;
  try {
    const res = await fetch(url, { headers: { "API-Key": apiKey } });
    if (!res.ok) return null;
    const j = await res.json();
    if (process.env.ARKHAM_DEBUG === "1") console.error("[arkham raw]", JSON.stringify(j));
    const entity = pickEntity(j);
    const label = pickLabel(j);
    return { entity: typeof entity === "string" ? entity : undefined, label: typeof label === "string" ? label : undefined };
  } catch {
    return null;
  }
}
