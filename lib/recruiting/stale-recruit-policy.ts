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

/**
 * WAVE 153 (lane 153I — owner ruling 17, "check that … recruitment works properly"): THE recruits.status vocabulary, ONE
 * spelling (it mirrors the live CHECK, scripts/check-vocabularies.ts recruits.status). app/api/recruiting/advance-stage
 * kept its own copy (VALID_STATUSES) — now it validates against this.
 */
export const RECRUIT_STATUSES = ["prospect", "contacted", "interviewing", "offer_extended", "joined", "declined"] as const

/**
 * May a recruit's stage move from → to? Every tenant runs its own recruiting process, so the active stages move freely in
 * either direction (no universal linear flow is imposed). ONE hard rule: a PROVISIONED recruit (recruits.provisioned —
 * app/api/recruiting/provision-agent made a working, billed seat for them) is an AGENT now, so its stage stays "joined".
 * Moving it back to prospect / declined made the pipeline report a lost candidate while the seat kept billing and the
 * person kept working; ending the relationship is the seat's own offboarding (lib/agents/agent-deactivation.ts), never a
 * recruiting stage. Pure.
 */
export function recruitStageChange(input: { from: string | null | undefined; to: string; provisioned: boolean }): { ok: true } | { ok: false; reason: string } {
  const to = (input.to ?? "").trim()
  if (!(RECRUIT_STATUSES as readonly string[]).includes(to)) return { ok: false, reason: `"${to}" is not a recruiting stage` }
  if (input.provisioned && to !== "joined") {
    return { ok: false, reason: "This person already joined and has a working seat, so their recruiting stage stays Joined. To end their seat, use the agent's offboarding in Team settings." }
  }
  return { ok: true }
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

/**
 * WAVE 156 (lane 156K) — WHO MAY BECOME A RECRUITING PROSPECT. Pure.
 *
 * Three doors file a `recruits` row: the public recruiting page (app/recruiting/[brokerageSlug]/actions.ts), the scraped-signal
 * promotion (lib/recruit-pipeline/recruit-processor.ts) and the business-card scan (which already refuses a colleague). The
 * public page and the promotion filed a NEW prospect for anyone: a person this brokerage SUSPENDED came back as a fresh
 * prospect (and the weekly recruit-outreach sweep then drafted outreach to them); a recruit who DECLINED — the pipeline's one
 * "stop" — came back as a new prospect; a current member was "recruited" into their own brokerage; and the public page filed a
 * second row for someone already in the pipeline. Ending or restoring a seat is the user's own reactivation
 * (app/actions/admin/update-user.ts, seat-gated), never a recruiting stage. A person at ANOTHER brokerage is a legitimate recruit.
 */
export type RecruitIntakeReason = "suspended_member" | "current_member" | "declined_recruit" | "existing_recruit"
export type RecruitIntakeVerdict = { admit: true } | { admit: false; reason: RecruitIntakeReason; recruitId: string | null }

export interface RecruitIntakeFacts {
  brokerageId: string
  /** The users row holding this email, if any (users.email is unique platform-wide). */
  member: { brokerageId: string | null; status: string | null; userType: string | null } | null
  /** This tenant's recruits rows for the same person (by email, or by full name when no email is known). */
  recruits: Array<{ id: string; status: string | null }>
}

/** A portal CONTACT or a VENDOR seat of this tenant is a client / a vendor, not a member — the same line the business-card
 *  scan draws (app/actions/business-card/business-card-actions.ts isExistingTenantMember). */
export const RECRUIT_INTAKE_NON_MEMBER_SEATS: readonly string[] = ["contact", "vendor"]

export function recruitIntakeVerdict(f: RecruitIntakeFacts): RecruitIntakeVerdict {
  if (f.member && f.member.brokerageId === f.brokerageId && !RECRUIT_INTAKE_NON_MEMBER_SEATS.includes(String(f.member.userType ?? "").toLowerCase())) {
    return { admit: false, reason: String(f.member.status ?? "").toLowerCase() === "suspended" ? "suspended_member" : "current_member", recruitId: null }
  }
  const declined = f.recruits.find((r) => r.status === "declined")
  if (declined) return { admit: false, reason: "declined_recruit", recruitId: declined.id }
  if (f.recruits.length > 0) return { admit: false, reason: "existing_recruit", recruitId: f.recruits[0].id }
  return { admit: true }
}
