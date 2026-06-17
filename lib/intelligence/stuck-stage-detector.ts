// lib/intelligence/stuck-stage-detector.ts
//
// STUCK-STAGE DETECTOR (pure) — the journey-conformance monitor catches ILLEGAL transitions; this
// catches the quieter failure: a contact sitting in a perfectly legal stage TOO LONG with nobody
// acting. A buyer "financially verified" for 60 days who never toured, a seller "listing prep" for
// three weeks that never went live — these stall silently. This reads how long they've been in the
// stage vs the stage's expected dwell ceiling and whether anyone's already working it, and routes the
// nudge to the manager who owns that stage. Pure (no I/O), unit-tested directly.

export type StuckSeverity = "none" | "watch" | "overdue"
export type StageOwner = "ai_isa" | "shopping_agent" | "listing_concierge" | "deal_coordinator"

export interface StuckStageInput {
  /** the canonical lifecycle stage the contact is in. */
  stage: string
  daysInStage: number
  /** the stage's expected dwell ceiling (days); the runner supplies it from the lifecycle map. */
  expectedMaxDays: number
  /** is someone already working this contact (a pending task / open action / scheduled touch)? */
  hasOpenAction: boolean
}

export interface StuckStageResult {
  stuck: boolean
  severity: StuckSeverity
  /** daysInStage / expectedMaxDays. */
  ratio: number
  reason: string
}

/** Expected dwell ceilings (days) for the canonical journey stages. Conservative defaults. */
export const STAGE_DWELL_CEILINGS: Record<string, number> = {
  // lead / qualification (AI ISA)
  new: 7, lead: 7, contacted: 10, qualifying: 14, nurturing: 30,
  // buyer (Shopping Agent)
  buyer_active: 21, touring: 21, financially_verified: 30, offer_stage: 14,
  // seller (Listing Concierge)
  listing_prep: 14, pre_listing: 14, listing_appointment: 10, coming_soon: 14,
  // deal (Deal Coordinator)
  under_contract: 45, closing: 21,
}

const STAGE_OWNER_PATTERNS: Array<{ owner: StageOwner; re: RegExp }> = [
  { owner: "deal_coordinator",  re: /under.?contract|closing|escrow|pending/i },
  { owner: "listing_concierge", re: /listing|seller|pre.?list|coming_soon|appointment/i },
  { owner: "shopping_agent",    re: /buyer|tour|financ|offer|shop/i },
  { owner: "ai_isa",            re: /lead|new|contact|qualif|nurtur/i },
]

/** Which manager owns this stage (the nudge target). Pure. */
export function ownerForStage(stage: string): StageOwner {
  for (const { owner, re } of STAGE_OWNER_PATTERNS) if (re.test(stage ?? "")) return owner
  return "ai_isa" // default: the qualifier picks it up
}

/** Expected dwell ceiling for a stage (falls back to a conservative default). Pure. */
export function expectedDwellForStage(stage: string): number {
  const key = (stage ?? "").toLowerCase()
  return STAGE_DWELL_CEILINGS[key] ?? 30
}

/**
 * Detect whether a contact is stuck in its current stage. A contact already being worked
 * (hasOpenAction) is never "stuck" — someone's on it. Otherwise, past the ceiling is overdue; in the
 * warning band is watch. Pure.
 */
export function detectStuckStage(input: StuckStageInput): StuckStageResult {
  const max = input.expectedMaxDays > 0 ? input.expectedMaxDays : 30
  const ratio = input.daysInStage / max

  if (input.hasOpenAction) {
    return { stuck: false, severity: "none", ratio, reason: "already being worked — an action is open" }
  }
  if (ratio >= 1.5) {
    return { stuck: true, severity: "overdue", ratio, reason: `${input.daysInStage}d in "${input.stage}" — well past the ~${max}d the stage should take, with nothing in motion` }
  }
  if (ratio >= 1.0) {
    return { stuck: true, severity: "watch", ratio, reason: `${input.daysInStage}d in "${input.stage}" — at the ~${max}d ceiling with no action open` }
  }
  return { stuck: false, severity: "none", ratio, reason: "within the expected window" }
}
