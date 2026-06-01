import nodemailer from "nodemailer";

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
  attribution?: {
    label: string;
    confidence: "high" | "medium" | "low" | "none";
    reason: string;
    addressType: "contract" | "eoa";
    isProxy: boolean;
    implementation?: string;
    deployer?: string;
  };
}

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string[]; // one or more recipients
  maxAttempts: number;
}

export function loadAlertConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  return {
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
    from: process.env.SMTP_FROM ?? `"USD Freeze Monitor" <${process.env.SMTP_USER ?? "monitor@localhost"}>`,
    to: (process.env.SMTP_TO ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    maxAttempts: Number(process.env.EMAIL_MAX_ATTEMPTS ?? 4),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildSubject(alert: FreezeAlert): string {
  const emoji = alert.action === "freeze" ? "🚨" : "✅";
  return `${emoji} ${alert.token} ${alert.action === "freeze" ? "Freeze" : "Unfreeze"} on ${alert.chain} — ${alert.address.slice(0, 8)}…`;
}

function buildHtml(alert: FreezeAlert): string {
  const actionColor = alert.action === "freeze" ? "#c0392b" : "#27ae60";
  const actionLabel = alert.action === "freeze" ? "FREEZE" : "UNFREEZE";
  const attr = alert.attribution;

  const attributionRows = attr
    ? `
      <tr><td><b>Label</b></td><td>${esc(attr.label)}</td></tr>
      <tr><td><b>Confidence</b></td><td>${esc(attr.confidence)}</td></tr>
      <tr><td><b>Address type</b></td><td>${esc(attr.addressType)}${attr.isProxy ? " (proxy)" : ""}</td></tr>
      ${attr.implementation ? `<tr><td><b>Implementation</b></td><td><code>${esc(attr.implementation)}</code></td></tr>` : ""}
      ${attr.deployer ? `<tr><td><b>Deployer</b></td><td><code>${esc(attr.deployer)}</code></td></tr>` : ""}
      <tr><td><b>Source</b></td><td>${esc(attr.reason)}</td></tr>`
    : "";

  return `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#222;max-width:640px;margin:0 auto">
<h2 style="background:${actionColor};color:#fff;padding:12px 16px;border-radius:6px;margin:0 0 16px">
  ${actionLabel}: ${esc(alert.token)} on ${esc(alert.chain)}
</h2>
<table style="border-collapse:collapse;width:100%">
  <tr><td style="padding:6px 8px;width:140px"><b>Address</b></td>
      <td style="padding:6px 8px;font-family:monospace">${esc(alert.address)}</td></tr>
  <tr style="background:#f5f5f5"><td style="padding:6px 8px"><b>Event</b></td>
      <td style="padding:6px 8px">${esc(alert.event)}</td></tr>
  <tr><td style="padding:6px 8px"><b>Block</b></td>
      <td style="padding:6px 8px">${esc(alert.blockNumber)}</td></tr>
  <tr style="background:#f5f5f5"><td style="padding:6px 8px"><b>Timestamp</b></td>
      <td style="padding:6px 8px">${esc(alert.timestamp)}</td></tr>
  <tr><td style="padding:6px 8px"><b>Tx Hash</b></td>
      <td style="padding:6px 8px;font-family:monospace">${esc(alert.txHash)}</td></tr>
  ${attributionRows}
</table>
<p style="margin-top:16px">
  <a href="${esc(alert.explorerUrl)}" style="background:#2980b9;color:#fff;padding:8px 14px;border-radius:4px;text-decoration:none">
    View on Explorer
  </a>
</p>
</body></html>`;
}

function buildText(alert: FreezeAlert): string {
  const lines = [
    `${alert.token} ${alert.action.toUpperCase()} on ${alert.chain}`,
    `Address:  ${alert.address}`,
    `Event:    ${alert.event}`,
    `Block:    ${alert.blockNumber}`,
    `Time:     ${alert.timestamp}`,
    `Tx:       ${alert.txHash}`,
    `Explorer: ${alert.explorerUrl}`,
  ];
  if (alert.attribution) {
    const a = alert.attribution;
    lines.push(`Label:    ${a.label} (${a.confidence} confidence, ${a.reason})`);
  }
  return lines.join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendAlert(alert: FreezeAlert, cfg: SmtpConfig): Promise<boolean> {
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      await transporter.sendMail({
        from: cfg.from,
        to: cfg.to.join(", "),
        subject: buildSubject(alert),
        text: buildText(alert),
        html: buildHtml(alert),
      });
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[alert] attempt ${attempt} SMTP error: ${msg}`);
      if (attempt < cfg.maxAttempts) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  console.error(`[alert] gave up after ${cfg.maxAttempts} attempts for ${alert.txHash}`);
  return false;
}
