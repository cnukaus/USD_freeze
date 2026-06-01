// Alert payload sent to the email API. Schema is stable; transport/auth is configurable
// because the API contract is still TBD (see .env.example EMAIL_API_* vars).
export interface FreezeAlert {
  event: string; // e.g. "AddedBlackList", "UnBlacklisted"
  action: "freeze" | "unfreeze";
  token: string; // "USDC" | "USDT"
  chain: string; // human key, e.g. "ethereum"
  address: string; // the blacklisted/unblacklisted account
  txHash: string;
  blockNumber: string; // bigint serialized
  timestamp: string; // ISO 8601
  explorerUrl: string;
  // Best-guess project/author for the frozen address (best-effort; absent if attribution
  // is disabled or failed). See src/attribute.ts.
  attribution?: {
    label: string; // e.g. "Tornado.Cash: Router", "unattributed"
    confidence: "high" | "medium" | "low" | "none";
    reason: string; // which signal produced it
    addressType: "contract" | "eoa";
    isProxy: boolean;
    implementation?: string;
    deployer?: string;
  };
}

interface AlertConfig {
  url: string;
  apiKey: string;
  authMode: "bearer" | "header" | "body";
  authHeader: string; // used when authMode === "header"
  maxAttempts: number;
}

export function loadAlertConfig(): AlertConfig | null {
  const url = process.env.EMAIL_API_URL;
  if (!url) return null; // not configured yet → caller falls back to console
  return {
    url,
    apiKey: process.env.EMAIL_API_KEY ?? "",
    authMode: (process.env.EMAIL_API_AUTH_MODE as AlertConfig["authMode"]) ?? "bearer",
    authHeader: process.env.EMAIL_API_AUTH_HEADER ?? "x-api-key",
    maxAttempts: Number(process.env.EMAIL_MAX_ATTEMPTS ?? 4),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Returns true on success. Retries on 5xx / network errors with exponential backoff.
// 4xx (except 429) is treated as permanent and not retried.
export async function sendAlert(alert: FreezeAlert, cfg: AlertConfig): Promise<boolean> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const body: Record<string, unknown> = { ...alert };

  if (cfg.authMode === "bearer") headers["authorization"] = `Bearer ${cfg.apiKey}`;
  else if (cfg.authMode === "header") headers[cfg.authHeader] = cfg.apiKey;
  else if (cfg.authMode === "body") body.apiKey = cfg.apiKey;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (res.ok) return true;
      const retryable = res.status >= 500 || res.status === 429;
      if (!retryable) {
        console.error(`[alert] permanent failure ${res.status} for ${alert.txHash}`);
        return false;
      }
      console.warn(`[alert] attempt ${attempt} got ${res.status}, retrying`);
    } catch (err) {
      console.warn(`[alert] attempt ${attempt} network error:`, err);
    }
    if (attempt < cfg.maxAttempts) await sleep(500 * 2 ** (attempt - 1));
  }
  console.error(`[alert] gave up after ${cfg.maxAttempts} attempts for ${alert.txHash}`);
  return false;
}
