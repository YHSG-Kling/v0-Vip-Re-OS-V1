// lib/marketing/circle-tactics.ts
// ─────────────────────────────────────────────────────────────────────────────
// TOP-PRODUCER LEARNING WITHIN AUTHORIZED TENANT CIRCLES (wave 154, lane 154G3 — directive G9, owner ruling R8).
//
// WHAT A "CIRCLE" IS — resolved ONLY through membership that already exists; no membership class is invented:
//   · team        teams + team_members (is_active, effective window) — "a team is a mini brokerage" (CLAUDE.md §4)
//   · mentorship  agent_mentor_relationships (status 'active') — the existing coaching / mentoring pairing
//   · brokerage   the tenant's own active agents (agents.brokerage_id) — the tenant boundary itself
// Nothing crosses a tenant: every read and write is pinned to the session brokerage, and a circle that does not belong to it
// is refused. Office (agents.location_id) is NOT a circle here — no existing structure carries an office-scoped share; a
// published blind spot.
//
// WHAT WAS MISSING, AND THE SMALLEST THING ADDED: nothing in the live schema carries "this producer opted in to share THIS
// generalized method with THIS circle, until THIS date, revocably" — learning_modules has no consent / expiry / evidence column
// and its picker (lib/learning-router/composer.ts) ignores team_id, marketing_assets is an asset store (asset_url) whose studio
// lists show brokerage scope to everyone, strategy_library is insert-only and digest-verified for StrategyDefinitions, and the
// topic pool is tenant-wide. supabase/migrations/m973 adds ONE table, circle_tactic_shares (a sharing RECORD — membership
// still resolves through the three structures above). WRITTEN, NOT APPLIED: until the integrator applies it every write here is
// refused by the database and reported as such (fail closed), never pretended.
//
// THE FLOW: verified campaign outcome → the ROI reader (lib/intelligence/roi-ledger.ts loadRoiOutcomeLedger, the producer's OWN
// session scope) and a comparable baseline → classification (classifyTacticEvidence) → the producer OPTS IN (the share action is
// their own session act) → the privacy / rights strip (stripTacticBrief) → a STRATEGY BRIEF (method + components + explanation +
// evidence QUALITY, never a figure) → per member, the arbiter's door (lib/ai-isa/followup-arbiter.ts arbitrateFollowUp, called
// never edited): offer · recommend adaptation · hold for evidence · ignore (different audience) → the member adapts it in THEIR
// voice: an ORIGINAL topic in the ONE pool (lib/content-intel/topic-intake.ts intakeTopicIdeas) carrying the member as brand
// owner → the existing writers produce the creative → the member's own results flow back through content_topic_uses →
// performance-aggregator (calibration of the topic; calibration of the BRIEF's evidence from adopters is a published gap).
//
// THE EVIDENCE RULE (stated, sourced, NOT a validated statistic): a tactic is "attributable_comparable" only when
//   (a) its campaigns are the producer's own, inside the ROI reader's window (EVIDENCE_WINDOW_DAYS = the reader's default
//       trailing window, lib/intelligence/roi-ledger.ts generateRoiLedger periodDays = 90);
//   (b) they reached at least HISTORY_MIN_SAMPLE Contacts (lib/kernel/strategy-library.ts — the repo's existing minimum sample
//       before tenant history may move a strategy threshold);
//   (c) the comparison cohort is at least ROI_MIN_COMPARABLE_CAMPAIGNS of the producer's OTHER campaigns of the same type
//       (mirrors lib/intelligence/roi-ledger.ts ROI_MIN_COMPARABLE — "a comparison needs at least this many comparable
//       campaigns"; the guard fails if the two drift);
//   (d) appointments per Contact reached is HIGHER than that cohort's.
// Anything else is labeled (insufficient_sample · no_comparable_cohort · no_measured_lift · outdated) and is never OFFERED as
// proven; a competitor's public idea is "idea_unknown_conversions"; a self-entered "top producer" title is labeled as such.
// What crosses is the generalized method — never a caption, lead list, campaign URL, recipient, Contact, demographic, exact
// ROI figure or revenue.
//
// Not server-only: scripts/events-and-circles-guard.ts drives it with a recording fake.

import { HISTORY_MIN_SAMPLE } from "@/lib/kernel/strategy-library"
import type { TopicIdea, TopicIntakeResult } from "@/lib/content-intel/topic-intake"

type Db = { from: (table: string) => any }

const CIRCLE_KINDS = ["team", "mentorship", "brokerage"] as const
type CircleKind = (typeof CIRCLE_KINDS)[number]
const EVIDENCE_QUALITIES = ["attributable_comparable", "insufficient_sample", "no_comparable_cohort", "no_measured_lift", "outdated", "idea_unknown_conversions"] as const
type EvidenceQuality = (typeof EVIDENCE_QUALITIES)[number]
const MEMBER_DECISIONS = ["offer", "recommend_adaptation", "hold_for_evidence", "ignore_different_audience"] as const
type MemberDecision = (typeof MEMBER_DECISIONS)[number]
/** Mirrors lib/intelligence/roi-ledger.ts ROI_MIN_COMPARABLE (module-private there). */
/** @proofSeam scripts/events-and-circles-guard.ts C2 pins it to roi-ledger.ts ROI_MIN_COMPARABLE; production caller classifyTacticEvidence below. */
export const ROI_MIN_COMPARABLE_CAMPAIGNS = 3
/** The ROI reader's default trailing window (lib/intelligence/roi-ledger.ts generateRoiLedger periodDays). A brief expires with it. */
/** @proofSeam scripts/events-and-circles-guard.ts C2 pins it to generateRoiLedger periodDays; production callers shareCircleTactic / classifyTacticEvidence below. */
export const EVIDENCE_WINDOW_DAYS = 90
/** The generalized building blocks a method is described in (a closed list — free text is screened, components are not). */
const TACTIC_COMPONENTS = ["consumer_question_first_hook", "short_video_faq", "timely_hyperlocal_fact", "personal_close", "market_stat_explainer", "neighborhood_walkthrough", "checklist_format"] as const

const DAY_MS = 86_400_000
const MAX_FANOUT = 25

// ── Evidence classification (PURE) ────────────────────────────────────────────────────────────────────────────

export interface CampaignOutcome { campaignId: string; type: string; agentUserId: string | null; contactsReached: number; appointments: number }
interface TacticEvidence { quality: EvidenceQuality; rule: string; tacticCampaigns: number; cohortCampaigns: number; direction: "higher" | "not_higher" | null; windowDays: number }

/** PURE — the evidence quality of a producer's tactic against their own comparable baseline. Never returns a figure. */
function classifyTacticEvidence(input: { campaigns: readonly CampaignOutcome[]; tacticCampaignIds: readonly string[]; producerUserId: string }): TacticEvidence {
  const rule = `own campaigns in the ROI reader's ${EVIDENCE_WINDOW_DAYS}-day window; ≥ ${HISTORY_MIN_SAMPLE} Contacts reached (strategy-library HISTORY_MIN_SAMPLE); ≥ ${ROI_MIN_COMPARABLE_CAMPAIGNS} comparable campaigns of the same type (roi-ledger ROI_MIN_COMPARABLE); appointments per Contact reached above that cohort`
  const base = { rule, windowDays: EVIDENCE_WINDOW_DAYS }
  const ids = new Set(input.tacticCampaignIds)
  const own = input.campaigns.filter((c) => c.agentUserId === input.producerUserId)
  const tactic = own.filter((c) => ids.has(c.campaignId))
  if (tactic.length === 0) return { ...base, quality: "outdated", tacticCampaigns: 0, cohortCampaigns: 0, direction: null }
  const types = new Set(tactic.map((c) => c.type))
  const cohort = own.filter((c) => !ids.has(c.campaignId) && types.has(c.type) && c.contactsReached > 0)
  const sample = tactic.reduce((n, c) => n + Math.max(0, c.contactsReached), 0)
  if (sample < HISTORY_MIN_SAMPLE) return { ...base, quality: "insufficient_sample", tacticCampaigns: tactic.length, cohortCampaigns: cohort.length, direction: null }
  if (cohort.length < ROI_MIN_COMPARABLE_CAMPAIGNS) return { ...base, quality: "no_comparable_cohort", tacticCampaigns: tactic.length, cohortCampaigns: cohort.length, direction: null }
  const rate = (xs: CampaignOutcome[]) => { const r = xs.reduce((n, c) => n + c.contactsReached, 0); return r > 0 ? xs.reduce((n, c) => n + c.appointments, 0) / r : 0 }
  const higher = rate(tactic) > rate(cohort)
  return { ...base, quality: higher ? "attributable_comparable" : "no_measured_lift", tacticCampaigns: tactic.length, cohortCampaigns: cohort.length, direction: higher ? "higher" : "not_higher" }
}

// ── The privacy / rights strip (PURE) ─────────────────────────────────────────────────────────────────────────

interface TacticBrief { method: string; components: string[]; explanation: string }

const URL_RE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|us|realty|homes)\b/i
const MONEY_RE = /\$\s?\d|\b\d[\d,.]*\s?(?:k|m|million|thousand)\b|\b\d+(?:\.\d+)?\s?%|\bpercent\b/i
const FIGURE_RE = /\b\d{2,}\b/
const HANDLE_RE = /(^|\s)@[a-z0-9_.]{2,}/i

/** PURE — what may cross: the generalized method in closed components + screened prose. A caption, a link, a handle, an email /
 *  phone, a money or percentage figure, any number of two or more digits (an exact result), or a near-copy of the producer's
 *  caption is REFUSED with its reason — the brief is not "cleaned" into something the producer did not write. */
function stripTacticBrief(input: { method: string; components: readonly string[]; explanation: string; caption?: string | null }, screens: { personalData: (t: string) => string | null; nearCopy: (candidate: string, source: string) => string | null }): { ok: true; brief: TacticBrief } | { ok: false; reason: string } {
  const method = String(input.method ?? "").replace(/\s+/g, " ").trim()
  const explanation = String(input.explanation ?? "").replace(/\s+/g, " ").trim()
  if (method.length < 12) return { ok: false, reason: "method_too_short" }
  const components = [...new Set(input.components ?? [])]
  if (components.length === 0 || components.some((c) => !(TACTIC_COMPONENTS as readonly string[]).includes(c))) return { ok: false, reason: "unknown_component" }
  for (const [field, text] of [["method", method], ["explanation", explanation]] as const) {
    if (screens.personalData(text)) return { ok: false, reason: `${field}:personal_data` }
    if (URL_RE.test(text)) return { ok: false, reason: `${field}:link` }
    if (HANDLE_RE.test(text)) return { ok: false, reason: `${field}:handle` }
    if (MONEY_RE.test(text) || FIGURE_RE.test(text)) return { ok: false, reason: `${field}:exact_figure` }
    if (input.caption && screens.nearCopy(text, input.caption)) return { ok: false, reason: `${field}:caption_copy` }
  }
  return { ok: true, brief: { method: method.slice(0, 300), components, explanation: explanation.slice(0, 600) } }
}

// ── Membership (live, every read) ─────────────────────────────────────────────────────────────────────────────

interface CircleRef { kind: CircleKind; teamId?: string | null; mentorshipId?: string | null }

/** The user ids of a circle's CURRENT members, tenant-pinned. A circle outside the tenant resolves to an error. */
async function circleMemberUserIds(db: Db, brokerageId: string, circle: CircleRef, now: Date): Promise<{ userIds: string[]; error: string | null }> {
  let agentIds: string[] = []
  if (circle.kind === "team") {
    if (!circle.teamId) return { userIds: [], error: "no team named" }
    const { data: team, error: tErr } = await db.from("teams").select("id").eq("id", circle.teamId).eq("brokerage_id", brokerageId).is("deleted_at", null)
    if (tErr) return { userIds: [], error: `teams read refused: ${tErr.message ?? "unknown"}` }
    if ((team ?? []).length !== 1) return { userIds: [], error: "team_not_in_tenant" }
    const { data, error } = await db.from("team_members").select("agent_id, effective_to").eq("team_id", circle.teamId).eq("brokerage_id", brokerageId).eq("is_active", true)
    if (error) return { userIds: [], error: `team_members read refused: ${error.message ?? "unknown"}` }
    agentIds = ((data ?? []) as Array<{ agent_id: string | null; effective_to: string | null }>).filter((m) => m.agent_id && (!m.effective_to || Date.parse(m.effective_to) > now.getTime())).map((m) => m.agent_id as string)
  } else if (circle.kind === "mentorship") {
    if (!circle.mentorshipId) return { userIds: [], error: "no mentorship named" }
    const { data, error } = await db.from("agent_mentor_relationships").select("mentor_agent_id, mentee_agent_id").eq("id", circle.mentorshipId).eq("brokerage_id", brokerageId).eq("status", "active")
    if (error) return { userIds: [], error: `agent_mentor_relationships read refused: ${error.message ?? "unknown"}` }
    agentIds = ((data ?? []) as Array<{ mentor_agent_id: string | null; mentee_agent_id: string | null }>).flatMap((r) => [r.mentor_agent_id, r.mentee_agent_id]).filter((x): x is string => !!x)
  } else if (circle.kind !== "brokerage") return { userIds: [], error: "unknown_circle_kind" }
  let q = db.from("agents").select("id, user_id").eq("brokerage_id", brokerageId).eq("is_active", true)
  if (circle.kind !== "brokerage") { if (agentIds.length === 0) return { userIds: [], error: null }; q = q.in("id", agentIds) }
  const { data: agents, error: aErr } = await q.limit(500)
  if (aErr) return { userIds: [], error: `agents read refused: ${aErr.message ?? "unknown"}` }
  return { userIds: [...new Set(((agents ?? []) as Array<{ user_id: string | null }>).map((a) => a.user_id).filter((u): u is string => !!u))], error: null }
}

// ── Deps ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface CircleSession { userId: string; brokerageId: string }

export interface CircleDeps {
  now?: Date
  /** The producer's OWN campaign outcomes from the ROI reader (session-scoped). Default: loadRoiOutcomeLedger. */
  roi?: (db: Db, session: CircleSession, window: { sinceDay: string; untilDay: string }) => Promise<{ ok: true; campaigns: CampaignOutcome[]; complete: boolean } | { ok: false; error: string }>
  intake?: (db: Db, args: { brokerageId: string; ideas: readonly TopicIdea[]; now?: Date }) => Promise<TopicIntakeResult>
  screens?: { personalData: (t: string) => string | null; nearCopy: (candidate: string, source: string) => string | null }
  ledger?: <T>(ctx: { brokerageId: string; userId: string; action: string; key: string; detail: Record<string, unknown>; reason: string }, run: () => Promise<T>, replay: (refused: boolean) => T) => Promise<T>
  arbiter?: typeof import("@/lib/ai-isa/followup-arbiter").arbitrateFollowUp
  decide?: import("@/lib/ai-isa/followup-arbiter").ArbiterDecide
  policy?: import("@/lib/ai-isa/followup-policy").FollowupPolicy
}

async function screensOf(deps: CircleDeps): Promise<NonNullable<CircleDeps["screens"]>> {
  if (deps.screens) return deps.screens
  const t = await import("@/lib/content-intel/topic-intake")
  return { personalData: t.personalDataProblem, nearCopy: t.rewordedNearCopyProblem }
}
function ledgerOf(db: Db, deps: CircleDeps): NonNullable<CircleDeps["ledger"]> {
  if (deps.ledger) return deps.ledger
  return async (c, run, replay) => {
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    return withActionLedger(
      { brokerageId: c.brokerageId, action: c.action, actor: { type: "user", userId: c.userId }, subject: { type: "circle_tactic", ref: c.key }, idempotencyKey: c.key, riskClass: "LOW_RISK_WRITE", systemSource: "circle_tactics", reasonCode: "HUMAN_REQUESTED", reasonDetail: c.reason.slice(0, 500), detail: c.detail },
      run,
      { settle: () => ({ status: "executed" as const, outcome: "done" }), replay: (claim) => replay(claim.kind === "refused") },
      { client: db as never },
    )
  }
}
const defaultRoi: NonNullable<CircleDeps["roi"]> = async (db, session, window) => {
  const { loadRoiOutcomeLedger } = await import("@/lib/intelligence/roi-ledger")
  const r = await loadRoiOutcomeLedger(db, session, window)
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, complete: r.ledger.completeness.label !== "incomplete", campaigns: r.ledger.campaigns.map((c) => ({ campaignId: c.campaignId, type: c.type, agentUserId: c.agentUserId, contactsReached: c.acquisition.contactsReached, appointments: c.engagement.appointments })) }
}

// ── Share (the producer's opt-in) ─────────────────────────────────────────────────────────────────────────────

export interface ShareInput {
  circle: CircleRef
  method: string
  components: string[]
  explanation: string
  caption?: string | null
  sourceKind: "producer_outcome" | "competitor_public_idea"
  tacticCampaignIds?: string[]
  /** A "top producer" title the producer entered themselves — labeled, never treated as evidence. */
  claimedTitle?: string | null
}
type ShareResult = { ok: true; shareId: string; quality: EvidenceQuality; sourceLabel: string; offered: number; evaluated: number } | { ok: false; reason: string }

/**
 * THE PRODUCER OPTS IN. Session-only (the producer is the signed-in user); the circle must be the tenant's and the producer a
 * current member; the brief passes the strip; the evidence is read through the ROI reader under the producer's own scope; the
 * share row carries quality + counts of campaigns (never a figure); each current member (bounded) is evaluated by the arbiter.
 * Ledgered (marketing.circle_tactic.share). Never throws.
 */
export async function shareCircleTactic(db: Db, session: CircleSession, input: ShareInput, deps: CircleDeps = {}): Promise<ShareResult> {
  const now = deps.now ?? new Date()
  try {
    if (!session.userId || !session.brokerageId) return { ok: false, reason: "not_signed_in" }
    const members = await circleMemberUserIds(db, session.brokerageId, input.circle, now)
    if (members.error) return { ok: false, reason: members.error }
    if (!members.userIds.includes(session.userId)) return { ok: false, reason: "producer_not_a_member_of_circle" }
    const strip = stripTacticBrief(input, await screensOf(deps))
    if (!strip.ok) return { ok: false, reason: `brief_refused:${strip.reason}` }
    let evidence: TacticEvidence
    if (input.sourceKind === "competitor_public_idea") {
      evidence = { quality: "idea_unknown_conversions", rule: "a competitor's public idea: its conversions are unknown and never claimed", tacticCampaigns: 0, cohortCampaigns: 0, direction: null, windowDays: EVIDENCE_WINDOW_DAYS }
    } else {
      const window = { sinceDay: new Date(now.getTime() - EVIDENCE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10), untilDay: now.toISOString().slice(0, 10) }
      const roi = await (deps.roi ?? defaultRoi)(db, session, window)
      if (!roi.ok) return { ok: false, reason: `roi_unreadable:${roi.error}` }
      evidence = classifyTacticEvidence({ campaigns: roi.campaigns, tacticCampaignIds: input.tacticCampaignIds ?? [], producerUserId: session.userId })
      if (!roi.complete && evidence.quality === "attributable_comparable") evidence = { ...evidence, quality: "insufficient_sample", rule: `${evidence.rule}; the ROI reader marked its own view incomplete` }
    }
    const sourceLabel = input.sourceKind === "competitor_public_idea" ? "competitor_public_idea" : evidence.quality === "attributable_comparable" ? "measured_by_roi_reader" : input.claimedTitle ? "self_entered_title" : "unmeasured"
    const key = `circle_share:${session.brokerageId}:${session.userId}:${input.circle.kind}:${input.circle.teamId ?? input.circle.mentorshipId ?? "tenant"}:${strip.brief.method.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}`
    return await ledgerOf(db, deps)({ brokerageId: session.brokerageId, userId: session.userId, action: "marketing.circle_tactic.share", key, reason: `a producer opted in to share a generalized method with their ${input.circle.kind}`, detail: { circle: input.circle, quality: evidence.quality, sourceLabel } }, async (): Promise<ShareResult> => {
      const { data: ins, error } = await db.from("circle_tactic_shares").insert({
        brokerage_id: session.brokerageId, producer_user_id: session.userId, circle_kind: input.circle.kind,
        team_id: input.circle.kind === "team" ? input.circle.teamId : null, mentorship_id: input.circle.kind === "mentorship" ? input.circle.mentorshipId : null,
        status: "shared", evidence_quality: evidence.quality, source_label: sourceLabel,
        brief: { ...strip.brief, source_kind: input.sourceKind, claimed_title: input.claimedTitle ? "self-entered title (not verified)" : null },
        evidence: { quality: evidence.quality, rule: evidence.rule, window_days: evidence.windowDays, tactic_campaigns: evidence.tacticCampaigns, cohort_campaigns: evidence.cohortCampaigns, direction: evidence.direction },
        offers: {}, opted_in_at: now.toISOString(), expires_at: new Date(now.getTime() + EVIDENCE_WINDOW_DAYS * DAY_MS).toISOString(),
      }).select("id")
      const id = ((ins ?? []) as Array<{ id: string }>)[0]?.id
      if (error || !id) return { ok: false, reason: `share_not_recorded:${error?.message ?? "no row returned"}` }
      let offered = 0, evaluated = 0
      const share: ShareRow = { id, brokerage_id: session.brokerageId, producer_user_id: session.userId, circle_kind: input.circle.kind, team_id: input.circle.teamId ?? null, mentorship_id: input.circle.mentorshipId ?? null, status: "shared", evidence_quality: evidence.quality, source_label: sourceLabel, brief: strip.brief as unknown as Record<string, any>, offers: {}, expires_at: new Date(now.getTime() + EVIDENCE_WINDOW_DAYS * DAY_MS).toISOString() }
      for (const memberId of members.userIds.filter((u) => u !== session.userId).slice(0, MAX_FANOUT)) {
        const d = await evaluateForMember(db, share, memberId, deps)
        if (d.recorded) { evaluated++; if (d.decision === "offer" || d.decision === "recommend_adaptation") offered++ }
      }
      return { ok: true, shareId: id, quality: evidence.quality, sourceLabel, offered, evaluated }
    }, (refused) => ({ ok: false, reason: refused ? "ledger_refused" : "already_shared" }))
  } catch (e) {
    return { ok: false, reason: `shareCircleTactic threw: ${(e as Error)?.message ?? String(e)}` }
  }
}

interface ShareRow {
  id: string; brokerage_id: string; producer_user_id: string; circle_kind: string; team_id: string | null; mentorship_id: string | null
  status: string; evidence_quality: string; source_label: string; brief: Record<string, any>; offers: Record<string, any> | null; expires_at: string
  /** The basis recorded at share time (rule, window, counts, direction) — the PRODUCER's own figures; shown only to the producer. */
  evidence?: Record<string, any> | null
  revoked_at?: string | null
}
const SHARE_COLS = "id, brokerage_id, producer_user_id, circle_kind, team_id, mentorship_id, status, evidence_quality, source_label, brief, offers, expires_at, evidence, revoked_at"

async function territoryOf(db: Db, brokerageId: string, userId: string): Promise<string | null> {
  const { data: ag } = await db.from("agents").select("id").eq("brokerage_id", brokerageId).eq("user_id", userId).limit(1)
  const agentId = ((ag ?? []) as Array<{ id: string }>)[0]?.id
  if (!agentId) return null
  const { data } = await db.from("farm_territories").select("city, state").eq("brokerage_id", brokerageId).eq("agent_id", agentId).eq("is_active", true).limit(3)
  const t = ((data ?? []) as Array<{ city: string | null; state: string | null }>).map((r) => [r.city, r.state].filter(Boolean).join(", ")).filter(Boolean)
  return t.length ? t.join("; ") : null
}

/**
 * The arbiter's decision for ONE member. Code decides first: evidence that is not attributable (and not a labeled idea) is HELD —
 * the model is never asked to promote it. Otherwise the arbiter's door chooses over the closed menu; its planned verdict is
 * "recommend adaptation" (never an automatic copy). The decision lands in the share row's offers (counted write).
 */
async function evaluateForMember(db: Db, share: ShareRow, memberUserId: string, deps: CircleDeps): Promise<{ decision: MemberDecision; recorded: boolean; error: string | null }> {
  const now = deps.now ?? new Date()
  let decision: MemberDecision, rationale: string, source = "deterministic"
  if (share.evidence_quality !== "attributable_comparable" && share.evidence_quality !== "idea_unknown_conversions") {
    decision = "hold_for_evidence"; rationale = `evidence is ${share.evidence_quality.replace(/_/g, " ")} — held until it is attributable and comparable`
  } else {
    const A = deps.arbiter ?? (await import("@/lib/ai-isa/followup-arbiter")).arbitrateFollowUp
    const policy = deps.policy ?? (await (await import("@/lib/ai-isa/followup-policy")).loadFollowupPolicy(db as never, share.brokerage_id)).policy
    const [memberMarket, producerMarket] = await Promise.all([territoryOf(db, share.brokerage_id, memberUserId), territoryOf(db, share.brokerage_id, share.producer_user_id)])
    const menu = [
      { id: "offer", kind: "education" as const, channels: ["in_app" as const], why: ["a generalized method a circle member opted to share", `evidence: ${share.evidence_quality.replace(/_/g, " ")}`] },
      { id: "recommend_adaptation", kind: "education" as const, channels: ["in_app" as const], why: ["the method fits only once localized to this member's market and voice"] },
      { id: "hold_for_evidence", kind: "wait" as const, channels: [], why: ["the evidence may not transfer yet"] },
      { id: "ignore_different_audience", kind: "wait" as const, channels: [], why: ["this member's audience or territory differs"] },
    ]
    const planned = menu[1]
    const facts = {
      subject: "lead" as const, relationship: { type: "circle_member", persona: null, hasAssignedAgent: true }, intent: null, preferences: [], fatigueRisk: null, localHour: null,
      history: { hoursSinceAnyTouch: null, hoursSinceAgentTouch: null, campaignTouches7d: null, lastChannel: null, portalEducationViews: null },
      journey: { transactionStage: null, nextMilestone: null, openLessons: null, nextLesson: String(share.brief.method ?? "").slice(0, 160) },
      moment: { key: "circle_tactic_offer", intent: `A ${share.circle_kind} member shared a generalized marketing method (${(share.brief.components ?? []).join(" + ")}). Decide whether to offer it to this member, recommend they adapt it, hold for evidence, or ignore it because their audience / territory differs.`, daysSinceOpen: 0 },
      blindSpots: [`member market: ${memberMarket ?? "unknown"}`, `sharer market: ${producerMarket ?? "unknown"}`, `evidence: ${share.evidence_quality} (${share.source_label})`, "no exact results are shared — quality only"],
    }
    const d = await A({ brokerageId: share.brokerage_id, facts: facts as never, menu: { menu, locked: null }, planned, policy }, { decide: deps.decide })
    decision = (MEMBER_DECISIONS as readonly string[]).includes(d.optionId) ? (d.optionId as MemberDecision) : "recommend_adaptation"
    rationale = d.rationale; source = d.source
  }
  const offers = { ...(share.offers ?? {}), [memberUserId]: { decision, rationale: rationale.slice(0, 300), source, decided_at: now.toISOString(), adapted_topic_id: share.offers?.[memberUserId]?.adapted_topic_id ?? null } }
  const { data, error } = await db.from("circle_tactic_shares").update({ offers }).eq("id", share.id).eq("brokerage_id", share.brokerage_id).eq("status", "shared").select("id")
  if (error || (data ?? []).length !== 1) return { decision, recorded: false, error: error?.message ?? "share no longer active" }
  share.offers = offers
  return { decision, recorded: true, error: null }
}

// ── Read, revoke, evaluate, adapt ─────────────────────────────────────────────────────────────────────────────

interface CircleTacticView { shareId: string; circleKind: string; method: string; components: string[]; explanation: string; evidenceQuality: string; sourceLabel: string; decision: MemberDecision | null; rationale: string | null; adaptedTopicId: string | null; expiresAt: string }

async function liveCirclesOf(db: Db, brokerageId: string, userId: string, now: Date): Promise<{ teams: Set<string>; mentorships: Set<string>; agentId: string | null; error: string | null }> {
  const { data: ag, error: aErr } = await db.from("agents").select("id").eq("brokerage_id", brokerageId).eq("user_id", userId).eq("is_active", true).limit(1)
  if (aErr) return { teams: new Set(), mentorships: new Set(), agentId: null, error: `agents read refused: ${aErr.message ?? "unknown"}` }
  const agentId = ((ag ?? []) as Array<{ id: string }>)[0]?.id ?? null
  if (!agentId) return { teams: new Set(), mentorships: new Set(), agentId: null, error: null }
  const [tm, mr] = await Promise.all([
    db.from("team_members").select("team_id, effective_to").eq("brokerage_id", brokerageId).eq("agent_id", agentId).eq("is_active", true),
    db.from("agent_mentor_relationships").select("id, mentor_agent_id, mentee_agent_id").eq("brokerage_id", brokerageId).eq("status", "active").or(`mentor_agent_id.eq.${agentId},mentee_agent_id.eq.${agentId}`),
  ])
  if (tm.error || mr.error) return { teams: new Set(), mentorships: new Set(), agentId, error: `membership read refused: ${(tm.error ?? mr.error).message ?? "unknown"}` }
  const teams = new Set(((tm.data ?? []) as Array<{ team_id: string; effective_to: string | null }>).filter((m) => !m.effective_to || Date.parse(m.effective_to) > now.getTime()).map((m) => m.team_id))
  return { teams, mentorships: new Set(((mr.data ?? []) as Array<{ id: string }>).map((m) => m.id)), agentId, error: null }
}

/**
 * THE ONLY READER of shared briefs for a member. Live membership on EVERY read — for the viewer AND the producer (a producer who
 * left the circle takes their share with them); revoked or expired shares, and those the arbiter ignored for this member, are
 * never returned. No producer identity and no figure are in the view. `mine` lists the viewer's own shares with their state.
 */
export async function listCircleTacticsForViewer(db: Db, session: CircleSession, opts: { now?: Date } = {}): Promise<{ visible: CircleTacticView[]; mine: Array<{ shareId: string; circleKind: string; method: string; status: string; evidenceQuality: string; expiresAt: string; offered: number; evidenceBasis: { rule: string | null; windowDays: number | null; tacticCampaigns: number | null; cohortCampaigns: number | null; direction: string | null } | null; revokedAt: string | null }>; error: string | null }> {
  const now = opts.now ?? new Date()
  if (!session.userId || !session.brokerageId) return { visible: [], mine: [], error: "not signed in" }
  const { data, error } = await db.from("circle_tactic_shares").select(SHARE_COLS).eq("brokerage_id", session.brokerageId).order("opted_in_at", { ascending: false }).limit(200)
  if (error) return { visible: [], mine: [], error: `circle_tactic_shares read refused: ${error.message ?? "unknown"}` }
  const rows = (data ?? []) as ShareRow[]
  const mine = rows.filter((r) => r.producer_user_id === session.userId).map((r) => ({ shareId: r.id, circleKind: r.circle_kind, method: String(r.brief?.method ?? ""), status: r.status === "shared" && Date.parse(r.expires_at) <= now.getTime() ? "expired" : r.status, evidenceQuality: r.evidence_quality, expiresAt: r.expires_at, offered: Object.values(r.offers ?? {}).filter((o: any) => o?.decision === "offer" || o?.decision === "recommend_adaptation").length,
    // The producer reads back the basis of THEIR OWN share (their own campaigns — never shown to a member) and when they revoked it.
    evidenceBasis: r.evidence && typeof r.evidence === "object" ? { rule: typeof r.evidence.rule === "string" ? r.evidence.rule : null, windowDays: typeof r.evidence.window_days === "number" ? r.evidence.window_days : null, tacticCampaigns: typeof r.evidence.tactic_campaigns === "number" ? r.evidence.tactic_campaigns : null, cohortCampaigns: typeof r.evidence.cohort_campaigns === "number" ? r.evidence.cohort_campaigns : null, direction: typeof r.evidence.direction === "string" ? r.evidence.direction : null } : null,
    revokedAt: r.revoked_at ?? null }))
  const live = rows.filter((r) => r.producer_user_id !== session.userId && r.status === "shared" && Date.parse(r.expires_at) > now.getTime())
  if (live.length === 0) return { visible: [], mine, error: null }
  const viewer = await liveCirclesOf(db, session.brokerageId, session.userId, now)
  if (viewer.error) return { visible: [], mine, error: viewer.error }
  if (!viewer.agentId) return { visible: [], mine, error: null }
  const producerOk = new Map<string, Awaited<ReturnType<typeof liveCirclesOf>>>()
  const visible: CircleTacticView[] = []
  for (const r of live) {
    const inCircle = (c: { teams: Set<string>; mentorships: Set<string>; agentId: string | null }) => r.circle_kind === "brokerage" ? !!c.agentId : r.circle_kind === "team" ? !!r.team_id && c.teams.has(r.team_id) : r.circle_kind === "mentorship" ? !!r.mentorship_id && c.mentorships.has(r.mentorship_id) : false
    if (!inCircle(viewer)) continue
    if (!producerOk.has(r.producer_user_id)) producerOk.set(r.producer_user_id, await liveCirclesOf(db, session.brokerageId, r.producer_user_id, now))
    const p = producerOk.get(r.producer_user_id)!
    if (p.error || !inCircle(p)) continue
    const o = (r.offers ?? {})[session.userId] as { decision?: string; rationale?: string; adapted_topic_id?: string | null } | undefined
    if (o?.decision === "ignore_different_audience") continue
    visible.push({ shareId: r.id, circleKind: r.circle_kind, method: String(r.brief?.method ?? ""), components: Array.isArray(r.brief?.components) ? r.brief.components : [], explanation: String(r.brief?.explanation ?? ""), evidenceQuality: r.evidence_quality, sourceLabel: r.source_label, decision: (o?.decision as MemberDecision) ?? null, rationale: o?.rationale ?? null, adaptedTopicId: o?.adapted_topic_id ?? null, expiresAt: r.expires_at })
  }
  return { visible, mine, error: null }
}

/** The producer OPTS OUT: future access ends at once (the reader filters on status); history — the adaptations members already
 *  made and the ledger rows — stays exactly as attributed. Only the producer may revoke. Counted write. */
export async function revokeCircleTactic(db: Db, session: CircleSession, shareId: string, deps: CircleDeps = {}): Promise<{ ok: boolean; reason: string | null }> {
  const now = deps.now ?? new Date()
  try {
    return await ledgerOf(db, deps)({ brokerageId: session.brokerageId, userId: session.userId, action: "marketing.circle_tactic.revoke", key: `circle_revoke:${session.brokerageId}:${shareId}`, reason: "the producer opted out of sharing", detail: { shareId } }, async (): Promise<{ ok: boolean; reason: string | null }> => {
      const { data, error } = await db.from("circle_tactic_shares").update({ status: "revoked", revoked_at: now.toISOString() }).eq("id", shareId).eq("brokerage_id", session.brokerageId).eq("producer_user_id", session.userId).eq("status", "shared").select("id")
      if (error) return { ok: false, reason: `revoke_refused:${error.message ?? "unknown"}` }
      return (data ?? []).length === 1 ? { ok: true, reason: null } : { ok: false, reason: "not_your_active_share" }
    }, (refused) => ({ ok: !refused, reason: refused ? "ledger_refused" : "already_revoked" }))
  } catch (e) {
    return { ok: false, reason: `revokeCircleTactic threw: ${(e as Error)?.message ?? String(e)}` }
  }
}

async function visibleShare(db: Db, session: CircleSession, shareId: string, now: Date): Promise<{ share: ShareRow; view: CircleTacticView } | { error: string }> {
  const list = await listCircleTacticsForViewer(db, session, { now })
  if (list.error) return { error: list.error }
  const view = list.visible.find((v) => v.shareId === shareId)
  if (!view) return { error: "not_visible_to_you" }
  const { data, error } = await db.from("circle_tactic_shares").select(SHARE_COLS).eq("id", shareId).eq("brokerage_id", session.brokerageId).limit(1)
  const share = ((data ?? []) as ShareRow[])[0]
  if (error || !share) return { error: "not_visible_to_you" }
  return { share, view }
}

/** A member who has no decision yet (joined after the share) asks the arbiter for one. */
export async function evaluateCircleTacticForMe(db: Db, session: CircleSession, shareId: string, deps: CircleDeps = {}): Promise<{ ok: boolean; decision: MemberDecision | null; reason: string | null }> {
  const now = deps.now ?? new Date()
  const v = await visibleShare(db, session, shareId, now)
  if ("error" in v) return { ok: false, decision: null, reason: v.error }
  if (v.view.decision) return { ok: true, decision: v.view.decision, reason: null }
  return ledgerOf(db, deps)({ brokerageId: session.brokerageId, userId: session.userId, action: "marketing.circle_tactic.evaluate", key: `circle_evaluate:${session.brokerageId}:${shareId}:${session.userId}`, reason: "a circle member asked whether a shared method fits their market", detail: { shareId } }, async () => {
    const d = await evaluateForMember(db, v.share, session.userId, deps)
    return { ok: d.recorded, decision: d.decision as MemberDecision | null, reason: d.error }
  }, (refused) => ({ ok: false, decision: null, reason: refused ? "ledger_refused" : "already_evaluated" }))
}

/**
 * The member ADAPTS the method in their own voice: an ORIGINAL topic in the ONE pool, brand-owned by the member, carrying the
 * generalized method and the member's market — never the producer's identity, caption or results. Allowed only on an "offer" /
 * "recommend adaptation" decision; one adaptation per member per share (dedup key). Ledgered.
 */
export async function adaptCircleTactic(db: Db, session: CircleSession, shareId: string, deps: CircleDeps = {}): Promise<{ ok: boolean; topicId: string | null; reason: string | null }> {
  const now = deps.now ?? new Date()
  try {
    const v = await visibleShare(db, session, shareId, now)
    if ("error" in v) return { ok: false, topicId: null, reason: v.error }
    if (v.view.decision !== "offer" && v.view.decision !== "recommend_adaptation") return { ok: false, topicId: null, reason: v.view.decision ? `arbiter_decided:${v.view.decision}` : "no_decision_yet" }
    if (v.view.adaptedTopicId) return { ok: true, topicId: v.view.adaptedTopicId, reason: null }
    const market = await territoryOf(db, session.brokerageId, session.userId)
    // agents.id (disjoint from users.id, CLAUDE.md §3) — what the topic picker knows the generating agent by.
    const { data: ag } = await db.from("agents").select("id").eq("brokerage_id", session.brokerageId).eq("user_id", session.userId).limit(1)
    const agentId = ((ag ?? []) as Array<{ id: string }>)[0]?.id ?? null
    return await ledgerOf(db, deps)({ brokerageId: session.brokerageId, userId: session.userId, action: "marketing.circle_tactic.adapt", key: `circle_adapt:${session.brokerageId}:${shareId}:${session.userId}`, reason: "a circle member adapted a shared method in their own voice", detail: { shareId, evidenceQuality: v.view.evidenceQuality } }, async () => {
      const intake = deps.intake ?? (async (d: Db, a: { brokerageId: string; ideas: readonly TopicIdea[]; now?: Date }) => (await import("@/lib/content-intel/topic-intake")).intakeTopicIdeas(d, a))
      const idea: TopicIdea = {
        sourceKind: "circle_tactic", title: v.view.method, angle: `Produce an ORIGINAL piece in YOUR own voice and brand using this method: ${v.view.components.join(" + ").replace(/_/g, " ")}. ${v.view.explanation}`.slice(0, 600),
        categories: ["circle_tactic", ...v.view.components], geo: market ? { label: market } : null, observedAt: now.toISOString(),
        expiresAt: v.view.expiresAt, evidence: { kind: "unknown", note: `a circle method; its evidence quality at share time was ${v.view.evidenceQuality} — it does not transfer as this topic's popularity` },
        rights: "first_party", dedupKey: `circle:${shareId}:${session.userId}`,
        brief: { topic_concept: v.view.method, format_pattern: v.view.components.join("+"), localization_opportunity: market, brand_owner_user_id: session.userId, brand_owner_brokerage_id: session.brokerageId, circle_adaptation: { share_id: shareId, for_agent_user_id: session.userId, for_agent_id: agentId, evidence_quality: v.view.evidenceQuality, source_label: v.view.sourceLabel } },
      }
      const r = await intake(db, { brokerageId: session.brokerageId, ideas: [idea], now })
      const row = r.rows[0]
      if (!row) return { ok: false, topicId: null, reason: r.excluded[0]?.reason ?? r.errors[0] ?? r.refused ?? "not_stored" }
      const offers = { ...(v.share.offers ?? {}), [session.userId]: { ...((v.share.offers ?? {})[session.userId] ?? {}), adapted_topic_id: row.id, adapted_at: now.toISOString() } }
      const { data, error } = await db.from("circle_tactic_shares").update({ offers }).eq("id", shareId).eq("brokerage_id", session.brokerageId).select("id")
      return { ok: true, topicId: row.id, reason: error || (data ?? []).length !== 1 ? `adapted, but the share did not record it: ${error?.message ?? "no row"}` : null }
    }, (refused) => ({ ok: false, topicId: null, reason: refused ? "ledger_refused" : "already_adapted" }))
  } catch (e) {
    return { ok: false, topicId: null, reason: `adaptCircleTactic threw: ${(e as Error)?.message ?? String(e)}` }
  }
}
