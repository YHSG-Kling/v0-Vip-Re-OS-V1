// lib/intelligence/listing-marketing-handoff.ts
//
// LISTING MARKETING HANDOFF (pure) — when a listing crosses into coming-soon or goes live, the
// Listing Concierge hands marketing to the Campaign Orchestrator. The existing kernel-event fanout
// already ENROLLS the marketing sequences (the production engine stays untouched); what was missing
// is the MANAGER HANDOFF being visible on the bus — "Listing Concierge → Campaign Orchestrator: 123
// Main is live, coordinate the just-listed push." This decides whether a stage transition is a
// marketing-handoff moment and which play. Pure (no I/O), unit-tested; the runner announces it.

export type MarketingStage = "coming_soon" | "live"

export interface ListingMarketingHandoff {
  announce: boolean
  stage: MarketingStage | null
  /** the coordination play the orchestrator owns at this stage. */
  play: string
}

const COMING_SOON_STAGES = new Set(["COMING_SOON_PREP", "COMING_SOON_ACTIVE", "coming_soon"])
const LIVE_STAGES = new Set(["ACTIVE", "MLS_ACTIVE", "PUBLISHED", "active", "mls_active", "published"])

/** Decide whether a listing stage transition is a marketing-handoff moment, and the play. Pure. */
export function marketingHandoffForStage(targetStage: string | null | undefined): ListingMarketingHandoff {
  const s = (targetStage ?? "").trim()
  if (COMING_SOON_STAGES.has(s)) {
    return { announce: true, stage: "coming_soon", play: "coming_soon_teasers" }
  }
  if (LIVE_STAGES.has(s)) {
    return { announce: true, stage: "live", play: "just_listed_push" }
  }
  return { announce: false, stage: null, play: "" }
}
