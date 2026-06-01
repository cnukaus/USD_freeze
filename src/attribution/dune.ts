// Dune Analytics label lookup. Dune has no generic "label for address" REST endpoint, so
// you create a parameterized SQL query on dune.com (see dune/label_query.sql) that takes
// `address` + `blockchain` text params and returns rows from Dune's label tables. We then
// drive it via the Query API: execute → poll status → read results.
//
// Requires DUNE_API_KEY and DUNE_LABEL_QUERY_ID. Each run costs Dune credits and takes a
// few seconds (polling), so this is best-effort and only run on the primary address.
const BASE = process.env.DUNE_API_BASE ?? "https://api.dune.com/api/v1";

export interface DuneLabel {
  name?: string;
  category?: string;
  source?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getDuneLabel(
  address: string,
  blockchain = "ethereum",
): Promise<DuneLabel | null> {
  const key = process.env.DUNE_API_KEY;
  const queryId = process.env.DUNE_LABEL_QUERY_ID;
  if (!key || !queryId) return null;

  const headers = { "X-Dune-API-Key": key, "content-type": "application/json" };
  try {
    // 1. Execute the parameterized query.
    const exec = await fetch(`${BASE}/query/${queryId}/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query_parameters: { address, blockchain } }),
    });
    if (!exec.ok) return null;
    const execId = ((await exec.json()) as { execution_id?: string }).execution_id;
    if (!execId) return null;

    // 2. Poll until complete (bounded).
    const deadline = Date.now() + Number(process.env.DUNE_TIMEOUT_MS ?? 60_000);
    let state = "";
    while (Date.now() < deadline) {
      const st = await fetch(`${BASE}/execution/${execId}/status`, { headers });
      if (!st.ok) return null;
      state = ((await st.json()) as { state?: string }).state ?? "";
      if (state === "QUERY_STATE_COMPLETED") break;
      if (state === "QUERY_STATE_FAILED" || state === "QUERY_STATE_CANCELLED") return null;
      await sleep(2000);
    }
    if (state !== "QUERY_STATE_COMPLETED") return null;

    // 3. Read results; take the first row's label-ish columns.
    const res = await fetch(`${BASE}/execution/${execId}/results`, { headers });
    if (!res.ok) return null;
    const rows =
      ((await res.json()) as { result?: { rows?: Array<Record<string, unknown>> } }).result
        ?.rows ?? [];
    if (rows.length === 0) return {}; // queried successfully, no label found
    const r = rows[0];
    const pick = (...keys: string[]) => {
      for (const k of keys) if (typeof r[k] === "string" && r[k]) return r[k] as string;
      return undefined;
    };
    return {
      name: pick("name", "label", "entity", "namespace"),
      category: pick("category"),
      source: pick("source"),
    };
  } catch {
    return null;
  }
}
