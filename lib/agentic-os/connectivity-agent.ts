// lib/agentic-os/connectivity-agent.ts
// The CONNECTIVITY API AGENT (agenticapi.com model). An agentic API needs an agent that
// "keeps up with the connectivity of all api/mcp/oauth" — so the planner never invokes a
// capability whose underlying connector is dark. This module is the PURE core: it maps
// each connector to its transport, derives a connection's health from its live credential
// posture (active flag + OAuth token expiry), and summarizes a fleet of connectors into
// an at-a-glance health report.
//
// Three transports the agent tracks:
//   • api_key          — static key/secret (IDX, SendGrid, Twilio, ShowingTime…). Up while
//                        the credential row is active.
//   • oauth            — token + refresh with an expiry (Gmail/Outlook, social, Nylas,
//                        QuickBooks, Stripe Connect, GoHighLevel…). Degrades as the token
//                        nears/passes expiry → the agent flags a reconnect.
//   • platform_managed — the PLATFORM holds the key (scrapers, AVM, voice, video, Lob).
//                        Always up from the brokerage's view; not the brokerage's to connect.
//   • mcp              — a Model Context Protocol server endpoint (future external tool bus).
//
// Pure — no I/O — so status derivation + summarization are unit-tested deterministically.
// The live credential read lives in resolve-connectivity.ts (server).

export type Transport = "api_key" | "oauth" | "platform_managed" | "mcp"

export type ConnectivityStatus =
  | "connected"        // live and healthy
  | "expiring_soon"    // OAuth token expires within EXPIRY_WARNING_DAYS — reconnect soon
  | "expired"          // OAuth token already lapsed — reconnect required
  | "disconnected"     // no active credential
  | "platform_managed" // platform owns the key — nothing for the brokerage to do

/** OAuth tokens within this window of expiry are flagged for proactive reconnect. */
export const EXPIRY_WARNING_DAYS = 7

/** EXPECTED transport per canonical provider — how a brokerage connects it. The live scan
 *  refines this from the actual credential row (an expiry present ⇒ treat as oauth). */
export const CONNECTOR_TRANSPORT: Record<string, Transport> = {
  // OAuth (token + refresh + expiry)
  gmail: "oauth", outlook: "oauth", nylas: "oauth", google_calendar: "oauth",
  gohighlevel: "oauth",
  meta: "oauth", facebook: "oauth", instagram: "oauth", linkedin: "oauth",
  twitter: "oauth", tiktok: "oauth", youtube: "oauth", pinterest: "oauth", buffer: "oauth",
  dotloop: "oauth", docusign: "oauth",
  // API key / secret
  idxbroker: "api_key", sendgrid: "api_key", resend: "api_key", postmark: "api_key",
  mailgun: "api_key", twilio: "api_key", telnyx: "api_key", bandwidth: "api_key",
  plivo: "api_key", sinch: "api_key",
  lofty: "api_key", followupboss: "api_key", hubspot: "api_key", // CRM sync-out
  skyslope: "api_key", authentisign: "api_key", brokermint: "api_key",
  formsimplicity: "api_key", showingtime: "api_key", podcast_syndicator: "api_key",
}

export function transportFor(provider: string): Transport {
  return CONNECTOR_TRANSPORT[provider] ?? "api_key"
}

export interface CredentialHealthInput {
  /** A live, non-revoked credential exists for this connector. */
  connected: boolean
  transport: Transport
  /** The credential row's active flag (false = explicitly deactivated). */
  isActive?: boolean
  /** OAuth token expiry (ISO-8601), when the transport is oauth. */
  tokenExpiresAt?: string | null
}

/**
 * Pure: derive a connector's connectivity status from its live posture. Never throws —
 * unparseable expiry reads as "connected" (we have a token, just no usable expiry signal).
 */
export function deriveConnectivityStatus(input: CredentialHealthInput, now: Date = new Date()): ConnectivityStatus {
  if (input.transport === "platform_managed") return "platform_managed"
  if (!input.connected || input.isActive === false) return "disconnected"
  if (input.transport === "oauth" && input.tokenExpiresAt) {
    const exp = Date.parse(input.tokenExpiresAt)
    if (!Number.isNaN(exp)) {
      if (exp <= now.getTime()) return "expired"
      if (exp <= now.getTime() + EXPIRY_WARNING_DAYS * 86_400_000) return "expiring_soon"
    }
  }
  return "connected"
}

/** True when the connector needs operator action (token lapsed or lapsing). Disconnected
 *  is informational (may be intentionally unconnected), so it is NOT action-required here. */
export function needsAttention(status: ConnectivityStatus): boolean {
  return status === "expired" || status === "expiring_soon"
}

export interface ConnectorHealth {
  provider: string
  transport: Transport
  status: ConnectivityStatus
  expiresAt: string | null
  /** Which credential store the live connection came from, when connected. */
  source: string | null
  actionRequired: boolean
}

export interface ConnectivitySummary {
  total: number
  connected: number
  disconnected: number
  expiringSoon: number
  expired: number
  platformManaged: number
  /** Providers needing operator action (expired/expiring), for proactive surfacing. */
  attention: string[]
}

/** Pure: fold a fleet of connector-health records into headline counts + an attention list. */
export function summarizeConnectivity(items: ConnectorHealth[]): ConnectivitySummary {
  const s: ConnectivitySummary = {
    total: items.length, connected: 0, disconnected: 0, expiringSoon: 0, expired: 0,
    platformManaged: 0, attention: [],
  }
  for (const it of items) {
    switch (it.status) {
      case "connected": s.connected++; break
      case "disconnected": s.disconnected++; break
      case "expiring_soon": s.expiringSoon++; break
      case "expired": s.expired++; break
      case "platform_managed": s.platformManaged++; break
    }
    if (it.actionRequired) s.attention.push(it.provider)
  }
  return s
}
