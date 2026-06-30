// ─── STALE-RECRUIT POLICY (Recruiting Manager reaper) ────────────────────────
// Pure, import-free policy for the Recruiting Manager's "a recruit went cold in
// the pipeline" failure: a recruit in an ACTIVE stage that hasn't moved in a
// stage-weighted window. An extended offer going silent is urgent; a cold prospect
// is not — so the fuse scales with how far along (and how perishable) the stage is.
//
// Pure → unit-testable (scripts/stale-recruit-reaper-simulator.ts).

// recruits.status CHECK = prospect | contacted | interviewing | offer_extended |
// joined | declined. joined/declined are terminal — never stale.
// Days of no movement before the recruit is flagged, by stage.
export const RECRUIT_STAGE_SLA_DAYS: Record<string, number> = {
  offer_extended: 5,   // an extended offer going silent is the most perishable
  interviewing: 10,
  contacted: 14,
  prospect: 30,        // a cold prospect is low-urgency
}

export type StaleRecruitAction = "keep" | "escalate"

export interface StaleRecruitInput {
  status: string | null | undefined
  /** updated_at — last pipeline movement. */
  updatedAt: string | null | undefined
  /** Caller passes "now" so the policy stays deterministic/testable. */
  now: Date
}

export function slaDaysForStage(status: string | null | undefined): number | null {
  const s = (status ?? "").toLowerCase().trim()
  return s in RECRUIT_STAGE_SLA_DAYS ? RECRUIT_STAGE_SLA_DAYS[s] : null
}

export function classifyStaleRecruit(input: StaleRecruitInput): StaleRecruitAction {
  const sla = slaDaysForStage(input.status)
  if (sla === null) return "keep" // terminal / unknown stage
  if (!input.updatedAt) return "keep"

  const moved = Date.parse(input.updatedAt)
  if (Number.isNaN(moved)) return "keep"

  const ageDays = (input.now.getTime() - moved) / (24 * 60 * 60 * 1000)
  return ageDays >= sla ? "escalate" : "keep"
}
