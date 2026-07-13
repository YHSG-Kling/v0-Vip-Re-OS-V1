/**
 * lib/platform/expansion-advisor.ts
 *
 * EXPANSION ADVISOR (tenant concierge list #35) — the OS notices when an
 * account has OUTGROWN its tier and says so, grounded in the tenant's own
 * numbers: a "solo" running multiple active agents needs team features; a
 * team at brokerage scale needs recruiting/compliance oversight; a
 * brokerage operating multiple locations needs the multi-location control
 * plane. Consumed by the Quarterly Business Review (one surface, no
 * upsell spam) — a suggestion, never an automatic plan change. PURE;
 * honest null when the account fits its tier. finance_manager owns
 * subscription economics. NOT server-only (simulator-driven).
 */

export interface ExpansionFacts {
  planTier: string | null
  activeAgents: number
  locations: number
}

export interface ExpansionSuggestion {
  suggestTier: "team" | "brokerage" | "multi_location"
  reason: string
}

export function decideExpansionSuggestion(f: ExpansionFacts): ExpansionSuggestion | null {
  const tier = (f.planTier ?? "").toLowerCase()
  if (tier === "solo_agent" && f.activeAgents >= 2) {
    return {
      suggestTier: "team",
      reason: `${f.activeAgents} active agents are working this account on a solo plan — team features (shared playbooks, lead routing, a team-lead support layer) fit how you already operate.`,
    }
  }
  if (tier === "team" && f.activeAgents >= 10) {
    return {
      suggestTier: "brokerage",
      reason: `${f.activeAgents} active agents is brokerage scale — recruiting, compliance oversight, and agent-development tooling would start earning their keep.`,
    }
  }
  if (tier === "brokerage" && f.locations >= 2) {
    return {
      suggestTier: "multi_location",
      reason: `${f.locations} locations on a single-office plan — office-level rollout, local overrides, and per-office health views fit a multi-location operation.`,
    }
  }
  return null
}
