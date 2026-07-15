// lib/agentic-os/connection-impact.ts
//
// CONNECTION IMPACT (agenticapi model, tenant-facing) — the missing half of
// the connectivity fabric: the connectivity-agent + healer already track and
// self-heal every api/oauth/mcp connector, but that lives on SUPERADMIN
// surfaces. The brokerage owner who connected THEIR Gmail/Meta/Dotloop has no
// view of "your Instagram token expired 3 days ago — that's why your listing
// posts stopped going out." This pure layer translates the raw connector
// health into BUSINESS-IMPACT the agent understands, so no connection dies
// silently and the owner knows exactly what breaks and how to fix it.
//
// Pure — consumes a ConnectivityReport (from scanConnectivity), emits ranked,
// plain-language impact lines. No I/O, fully testable.

import type { ConnectivityStatus } from "@/lib/agentic-os/connectivity-agent"

/** What business flow each connectable provider powers — the agent's language, not the connector's. */
export const PROVIDER_IMPACT: Record<string, string> = {
  gmail: "email to your clients from your own inbox",
  outlook: "email to your clients from your own inbox",
  nylas: "email + calendar sync",
  google_calendar: "calendar sync and showing scheduling",
  meta: "your Facebook + Instagram listing posts",
  facebook: "your Facebook listing posts",
  instagram: "your Instagram listing posts",
  linkedin: "your LinkedIn posts",
  twitter: "your X/Twitter posts",
  tiktok: "your TikTok posts",
  youtube: "your YouTube uploads",
  pinterest: "your Pinterest posts",
  buffer: "your scheduled social posts",
  dotloop: "sending documents out for signature",
  docusign: "sending documents out for signature",
  skyslope: "your transaction forms",
  authentisign: "sending documents out for signature",
  gohighlevel: "syncing contacts to your other CRM",
  followupboss: "syncing contacts to your other CRM",
  hubspot: "syncing contacts to your other CRM",
  idxbroker: "your IDX property search feed",
}

export type ImpactSeverity = "broken" | "expiring" | "ok"

export interface ConnectionImpactLine {
  provider: string
  status: ConnectivityStatus
  severity: ImpactSeverity
  line: string
}

export interface ConnectionImpactRead {
  broken: ConnectionImpactLine[]
  expiring: ConnectionImpactLine[]
  /** True when at least one connection needs the owner's attention. */
  needsAttention: boolean
}

interface ReportLike {
  connectors: Array<{ provider: string; status: ConnectivityStatus; expiresAt: string | null; actionRequired: boolean }>
}

/** PURE: turn connector health into ranked, business-impact lines the owner acts on. */
export function composeConnectionImpact(report: ReportLike): ConnectionImpactRead {
  const broken: ConnectionImpactLine[] = []
  const expiring: ConnectionImpactLine[] = []

  for (const c of report.connectors) {
    if (!c.actionRequired) continue // connected + healthy, or platform-managed — nothing for the owner
    const impact = PROVIDER_IMPACT[c.provider] ?? `your ${c.provider} connection`
    if (c.status === "disconnected" || c.status === "expired") {
      broken.push({
        provider: c.provider, status: c.status, severity: "broken",
        line: c.status === "expired"
          ? `Your ${c.provider} sign-in expired — ${impact} has stopped until you reconnect.`
          : `${c.provider} isn't connected — ${impact} won't run until you connect it.`,
      })
    } else if (c.status === "expiring_soon") {
      const when = c.expiresAt ? ` (expires ${new Date(c.expiresAt).toLocaleDateString()})` : ""
      expiring.push({
        provider: c.provider, status: c.status, severity: "expiring",
        line: `Reconnect ${c.provider} soon${when} — ${impact} will pause when it lapses. Fixing it now avoids the gap.`,
      })
    }
  }

  // Broken first, then expiring; within each, alphabetical for stable rendering.
  broken.sort((a, b) => a.provider.localeCompare(b.provider))
  expiring.sort((a, b) => a.provider.localeCompare(b.provider))
  return { broken, expiring, needsAttention: broken.length > 0 || expiring.length > 0 }
}

/** PURE: the one-line summary for a nudge / notification (empty when all healthy). */
export function composeConnectionHeadline(read: ConnectionImpactRead): string {
  if (read.broken.length > 0) {
    const first = read.broken[0]
    const more = read.broken.length - 1
    return `${first.line}${more > 0 ? ` (+${more} more connection${more === 1 ? "" : "s"} need attention)` : ""}`
  }
  if (read.expiring.length > 0) {
    return `${read.expiring.length} connection${read.expiring.length === 1 ? "" : "s"} will expire soon — reconnect to avoid a gap in your marketing.`
  }
  return ""
}
