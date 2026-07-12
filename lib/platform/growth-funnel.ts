// lib/platform/growth-funnel.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM SELF-MARKETING — the platform markets VIP Agents ITSELF (the AI OS
// transforming real estate) to prospective customers. Distinct from tenant
// marketing (which markets a brokerage's LISTINGS to its clients): here the
// "product" is the OS and the "prospects" are brokerages / teams / agents who
// might sign up. Pure funnel math + the platform's own pitch composer; the DB
// writes live in app/actions/superadmin/platform-growth.ts.

export const PROSPECT_STATUSES = ["new", "contacted", "trial", "converted", "lost"] as const
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number]

export const PROSPECT_ROLES = ["solo_agent", "team", "brokerage", "multi_location", "unknown"] as const
export type ProspectRole = (typeof PROSPECT_ROLES)[number]

export interface ProspectInput {
  name?: string | null
  email: string
  company?: string | null
  roleInterest?: string | null
  source?: string | null
  interestNote?: string | null
}

export interface NormalizedProspect {
  name: string | null
  email: string
  company: string | null
  roleInterest: string
  source: string
  interestNote: string | null
}

export type ProspectValidation = { ok: true; value: NormalizedProspect } | { ok: false; error: string }

function validEmail(e: string): boolean { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) }

/** PURE: validate + normalize a captured prospect. */
export function validateProspectInput(input: ProspectInput): ProspectValidation {
  const email = (input.email ?? "").trim().toLowerCase()
  if (!validEmail(email)) return { ok: false, error: "A valid email is required" }
  const role = (input.roleInterest ?? "unknown").trim()
  return {
    ok: true,
    value: {
      name: (input.name ?? "").trim() || null,
      email,
      company: (input.company ?? "").trim() || null,
      roleInterest: (PROSPECT_ROLES as readonly string[]).includes(role) ? role : "unknown",
      source: (input.source ?? "organic").trim() || "organic",
      interestNote: (input.interestNote ?? "").trim() || null,
    },
  }
}

export interface GrowthFunnel {
  total: number
  byStatus: Record<ProspectStatus, number>
  /** converted / (total − lost), 0..1 — the product's win rate on real interest. */
  conversionRate: number
  /** trial + converted over total — how many prospects reach hands-on. */
  activationRate: number
}

/** PURE: roll a prospect list up to the self-marketing funnel. */
export function rollupGrowthFunnel(prospects: Array<{ status: string | null }>): GrowthFunnel {
  const byStatus: Record<ProspectStatus, number> = { new: 0, contacted: 0, trial: 0, converted: 0, lost: 0 }
  for (const p of prospects) {
    const s = (p.status ?? "new") as ProspectStatus
    if (s in byStatus) byStatus[s]++
  }
  const total = prospects.length
  const qualified = total - byStatus.lost
  const conversionRate = qualified > 0 ? byStatus.converted / qualified : 0
  const activationRate = total > 0 ? (byStatus.trial + byStatus.converted) / total : 0
  return { total, byStatus, conversionRate, activationRate }
}

// ── The platform's OWN pitch (self-marketing copy) ────────────────────────────

const ROLE_HOOK: Record<string, string> = {
  solo_agent: "run your whole book like you have a team behind you",
  team: "give your team one command center instead of ten tools",
  brokerage: "run the brokerage with an accountable AI team, not more software",
  multi_location: "coordinate every office from one command center",
  unknown: "run your real-estate business with an accountable AI team",
}

/**
 * PURE: compose the platform's own outreach to a prospect — the "AI OS transforming
 * real estate" pitch, tier-aware. Returned as a GATED draft (never auto-sent); a
 * marketing/superadmin operator reviews + sends. Honest, no fabricated claims.
 */
export function composeProspectOutreach(p: { name?: string | null; roleInterest?: string | null; company?: string | null; brandName?: string | null }): { subject: string; body: string } {
  const productName = (p.brandName ?? "").trim() || "VIP Agents"
  const first = (p.name ?? "").trim().split(" ")[0] || "there"
  const hook = ROLE_HOOK[(p.roleInterest ?? "unknown")] ?? ROLE_HOOK.unknown
  const co = (p.company ?? "").trim()
  return {
    subject: `An AI team that runs the whole business — from lead to lifetime client`,
    body:
      `Hi ${first},\n\n` +
      `Most real-estate software gives you another dashboard. ${productName} gives you an AI TEAM ` +
      `of managers that actually do the work together — scraping leads, qualifying, coordinating deals, ` +
      `marketing (video + social + ads), recruiting and retaining agents, managing vendors, and reporting — ` +
      `all overseen from one command center, with a voice admin that takes a command and executes.\n\n` +
      `For ${co || "your business"}, that means you can ${hook} — the AI runs the process end to end and ` +
      `keeps you and your clients on the same page while cutting the busywork.\n\n` +
      `Worth a 15-minute look? I'll show you the AI team handing a real deal between managers, live.\n\n` +
      "— The " + productName + " team",
  }
}
