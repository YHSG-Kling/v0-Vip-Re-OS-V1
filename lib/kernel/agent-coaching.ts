// lib/kernel/agent-coaching.ts
//
// THE AGENT COACHING LOOP — the brokerage develops its PEOPLE, not just its deals.
// Every week the OS already-computed outcome data is turned into a per-agent coaching
// brief: "here's what's working, here's where you're leaking deals, here's the ONE thing
// to focus on this week." The brokerage's own production/health/activity data, read back
// as a development conversation.
//
// OWNER: recruiting_manager. The registry already assigns agent development/talent to the
// Recruiting Manager — recruiter_agent_mgmt loops crushing/stalling agents, and the
// recruiting_manager:agent_stalling bus handler already routes an 'agent_coaching'
// notification to the broker/admins. The Deal Coordinator owns deal EXECUTION; the
// Recruiting Manager owns agent DEVELOPMENT. The weekly coaching brief is the scheduled,
// richer version of that same charter, delivered to the same audience (the broker /
// team-lead who develops the agent) through the same gated rail.
//
// DELIVERY: a GATED, MANAGER-FACING brief via proposeClientMessage (audience 'agent' —
// the internal/manager audience, the same one commission-forecaster + recruiting-outreach
// use), agentKind 'recruiting_manager', addressed to the agent's broker/team-lead. It is
// the broker's to read and act on — the OS NEVER autonomously coaches the agent.
//
// REUSE, NOT RECOMPUTE:
//   · generateAgentScorecards (lib/intelligence/agent-scorecard) — production (YTD GCI +
//     closings), deal health (active deals + avg health_score), education completion. The
//     per-agent stats already aggregated over REAL transactions / learning_assignments.
//   · the no-show + stale-lead aggregates from the EXISTING conventions: calendar_events
//     status='no_show' (appointment-noshow-autopilot) keyed by agent_user_id, and a contact
//     gone stale = last_contacted_at older than DEFAULT_STALE_DAYS (stale-contact-detector)
//     scoped to the agent.
//   · tours / offers — tour→offer conversion (a real buyer-side production signal).
//   · proposeClientMessage (the gate) + isoWeekTag (the per-week idempotency key).
//
// NO FABRICATION: every line is earned from a REAL row. A metric with too small a sample
// is reported as honest "not enough data yet" — NEVER invented criticism. A brand-new
// agent with no data gets an honest, minimal welcome brief, not a fabricated scorecard.
//
// The composition (composeCoachingBrief) is PURE + deterministic; the runner is a thin
// orchestration that pulls the real stats and proposes the gated brief. NOT server-only
// (simulator-driven, like the rest of the kernel loaders).

import { createServiceClient } from "@/lib/supabase/service"
import { generateAgentScorecards, type AgentScorecard } from "@/lib/intelligence/agent-scorecard"
import { isoWeekTag } from "@/lib/kernel/commission-forecaster"
import { DEFAULT_STALE_DAYS } from "@/lib/ai-isa/stale-contact-detector"

type Svc = ReturnType<typeof createServiceClient>

// ── Documented deterministic thresholds ───────────────────────────────────────
//
// Every threshold is a conservative, documented floor. The MIN_* sample gates are the
// honesty guards: below them we say "not enough data yet" rather than praise or criticize
// on noise. Boundaries are intentionally cautious — we'd rather stay silent than mislabel.

/** A conversion/no-show metric needs at least this many events before it earns a verdict. */
export const MIN_SAMPLE = 3
// TOMBSTONE (orphan doctrine §1.3) — these names are no longer exported: LEAK_PENALTY, STRONG_EDUCATION_PCT, STRONG_HEALTH, STRONG_TOUR_OFFER, WEAK_EDUCATION_PCT, WEAK_HEALTH, WEAK_TOUR_OFFER.
// Nothing in the product imported them, and no simulator did either; the
// values are live and unchanged, reached through this module's own exported
// functions, which is where callers already get their effect. Same ruling and same
// reasoning as lib/vendors/appraiser-independence.ts (isAppraiserTrade,
// labelNamesAppraisal): an export with no importer is a public surface nobody
// asked for, and the wire to build is not a second copy of the module's door.
/** Tour→offer conversion at/above this is a STRENGTH (buyer-side: tours turning into offers). */
const STRONG_TOUR_OFFER = 0.5
/** Tour→offer conversion at/below this is a LEAK (tours not converting to written offers). */
const WEAK_TOUR_OFFER = 0.2
/** No-show RATE at/above this (of scheduled appointments) is a LEAK. */
export const HIGH_NOSHOW_RATE = 0.25
/** Avg deal health at/above this is a STRENGTH; at/below LOW is a LEAK. */
const STRONG_HEALTH = 80
const WEAK_HEALTH = 50
/** This many+ stale (cold past DEFAULT_STALE_DAYS) contacts on the agent's book is a LEAK. */
export const STALE_LEAK_COUNT = 5
/** Education completion at/below this (with assignments on file) is a LEAK. */
const WEAK_EDUCATION_PCT = 50
/** Education completion at/above this is a STRENGTH. */
const STRONG_EDUCATION_PCT = 90

// ── The pure brief model ──────────────────────────────────────────────────────

/** The REAL, agent-scoped stats the brief is composed from. Every field is a measured
 *  value or null (null = the metric has no sample — honestly absent, never zero-faked). */
export interface AgentCoachingStats {
  agentId: string
  name: string
  /** Production. */
  ytdGci: number
  closings: number
  /** Deal health (null when no active deals carry a health score). */
  activeDeals: number
  avgHealthScore: number | null
  /** Buyer-side conversion: tours taken and offers written in the window. */
  tours: number
  offers: number
  /** Appointments scheduled vs no-showed in the window (agent's calendar). */
  appointments: number
  noShows: number
  /** Relationship hygiene: contacts on the book that have gone cold (stale). */
  staleContacts: number
  /** Education. */
  lessonsAssigned: number
  lessonsCompleted: number
  educationCompletionPct: number | null
}

export interface CoachingBrief {
  strengths: string[]
  leaks: string[]
  /** The ONE thing to work on this week — derived from the most expensive leak, or an
   *  encouragement when there are no leaks, or an honest "still gathering data" line. */
  focusThisWeek: string
  /** True when NO metric cleared its sample gate — the agent is too new to coach yet. */
  notEnoughData: boolean
}

const pct = (n: number) => `${Math.round(n * 100)}%`
const usd = (n: number) => `$${Math.round(n).toLocaleString()}`

/**
 * PURE + deterministic. Compose a coaching brief from REAL agent stats.
 *
 * Each signal is only emitted once its sample gate is cleared (MIN_SAMPLE events, or a
 * real assignment/active-deal on file). A signal with no sample contributes NOTHING — it
 * is silently absent, never a fabricated criticism. When NO signal clears its gate the
 * brief is an honest minimal "not enough data yet" — encouragement, no invented numbers.
 *
 * focusThisWeek is the highest-leverage leak (ordered most-expensive-first: no-shows
 * leak booked deals, then tour→offer, then cold book, then deal health, then education);
 * when there are leaks none, it celebrates the top strength or, failing that, the volume
 * the agent is putting up.
 */
export function composeCoachingBrief(stats: AgentCoachingStats): CoachingBrief {
  const strengths: string[] = []
  const leaks: string[] = []
  // Ordered leaks (most expensive first) so focusThisWeek picks the right one.
  const leakFocus: string[] = []

  // ── No-shows (most expensive: a no-show is a booked deal walking out the door) ──
  if (stats.appointments >= MIN_SAMPLE) {
    const rate = stats.noShows / stats.appointments
    if (rate >= HIGH_NOSHOW_RATE) {
      leaks.push(`${pct(rate)} of your appointments are no-shows (${stats.noShows} of ${stats.appointments}). Confirm-the-day-before and a value reminder cut this fast.`)
      leakFocus.push(`Tighten your appointment confirmation routine — ${pct(rate)} no-show rate is leaking booked business.`)
    } else if (stats.noShows === 0) {
      strengths.push(`Zero no-shows across ${stats.appointments} appointments — your clients show up, which means your pre-meeting touch is working.`)
    }
  }

  // ── Tour → offer conversion (buyer-side: are tours turning into written offers?) ──
  if (stats.tours >= MIN_SAMPLE) {
    const conv = stats.offers / stats.tours
    if (conv >= STRONG_TOUR_OFFER) {
      strengths.push(`Strong tour→offer conversion (${pct(conv)} — ${stats.offers} offers from ${stats.tours} tours). You're touring the right homes with ready buyers.`)
    } else if (conv <= WEAK_TOUR_OFFER) {
      leaks.push(`Low tour→offer conversion (${pct(conv)} — only ${stats.offers} offers from ${stats.tours} tours). Are you touring buyers who are truly ready, and asking for the offer?`)
      leakFocus.push(`Pre-qualify buyers harder before touring and ask for the offer — ${pct(conv)} of tours are converting to offers.`)
    }
  }

  // ── Cold book (stale contacts the agent owns and hasn't touched in 2+ weeks) ──
  if (stats.staleContacts >= STALE_LEAK_COUNT) {
    leaks.push(`${stats.staleContacts} contacts have gone cold (no touch in ${DEFAULT_STALE_DAYS}+ days). Cold leads go stale — block time to re-engage your warmest ones first.`)
    leakFocus.push(`Re-engage your ${stats.staleContacts} cold contacts — leads going stale is lost pipeline you already paid for.`)
  }

  // ── Deal health (active deals trending healthy vs at-risk) ──
  if (stats.activeDeals > 0 && stats.avgHealthScore != null) {
    if (stats.avgHealthScore >= STRONG_HEALTH) {
      strengths.push(`Your ${stats.activeDeals} active deal${stats.activeDeals === 1 ? "" : "s"} are healthy (avg health ${stats.avgHealthScore}/100) — you're staying on top of your pipeline.`)
    } else if (stats.avgHealthScore <= WEAK_HEALTH) {
      leaks.push(`Your active deals are running at-risk (avg health ${stats.avgHealthScore}/100). At-risk deals fall apart quietly — a deadline + contingency sweep this week protects them.`)
      leakFocus.push(`Sweep your ${stats.activeDeals} active deal${stats.activeDeals === 1 ? "" : "s"} for slipping deadlines — avg health ${stats.avgHealthScore}/100 is in the danger zone.`)
    }
  }

  // ── Education (assigned learning the agent is/ isn't completing) ──
  if (stats.lessonsAssigned > 0 && stats.educationCompletionPct != null) {
    if (stats.educationCompletionPct >= STRONG_EDUCATION_PCT) {
      strengths.push(`You've completed ${stats.educationCompletionPct}% of your assigned training — you're investing in your craft.`)
    } else if (stats.educationCompletionPct <= WEAK_EDUCATION_PCT) {
      leaks.push(`Only ${stats.educationCompletionPct}% of your assigned training is complete (${stats.lessonsCompleted} of ${stats.lessonsAssigned}). The skills you're skipping are the deals you're not closing.`)
      leakFocus.push(`Finish your assigned training — you're at ${stats.educationCompletionPct}% (${stats.lessonsCompleted} of ${stats.lessonsAssigned}).`)
    }
  }

  // ── Production (a genuine, earned strength — only when real GCI/closings exist) ──
  if (stats.closings > 0) {
    strengths.push(`${stats.closings} closing${stats.closings === 1 ? "" : "s"} booked${stats.ytdGci > 0 ? ` (${usd(stats.ytdGci)} GCI year-to-date)` : ""} — real production on the board.`)
  }

  // ── Honesty gate: did ANY metric clear its sample? ──
  const anySignal =
    stats.appointments >= MIN_SAMPLE ||
    stats.tours >= MIN_SAMPLE ||
    stats.staleContacts >= STALE_LEAK_COUNT ||
    (stats.activeDeals > 0 && stats.avgHealthScore != null) ||
    (stats.lessonsAssigned > 0 && stats.educationCompletionPct != null) ||
    stats.closings > 0

  if (!anySignal) {
    return {
      strengths: [],
      leaks: [],
      focusThisWeek: `Not enough activity on the board yet to coach on — let's get reps in. Book showings, log your conversations, and we'll have real numbers to work with next week.`,
      notEnoughData: true,
    }
  }

  // focusThisWeek = the most expensive leak; else celebrate the top strength; else the
  // honest "keep the volume up" when there's signal but neither a clear leak nor strength.
  let focusThisWeek: string
  if (leakFocus.length > 0) {
    focusThisWeek = leakFocus[0]
  } else if (strengths.length > 0) {
    focusThisWeek = `No leaks this week — keep doing what's working: ${strengths[0]}`
  } else {
    focusThisWeek = `You're putting up activity with no red flags — keep the volume up and the numbers will follow.`
  }

  return { strengths, leaks, focusThisWeek, notEnoughData: false }
}

/** PURE. Render the brief into the manager-facing message {subject, body}. */
export function renderCoachingMessage(stats: AgentCoachingStats, brief: CoachingBrief): { subject: string; body: string } {
  if (brief.notEnoughData) {
    return {
      subject: `📋 Coaching brief: ${stats.name} — getting started`,
      body: `Weekly coaching brief for ${stats.name}.\n\n${brief.focusThisWeek}`,
    }
  }
  const lines: string[] = [`Weekly coaching brief for ${stats.name}.`]
  if (brief.strengths.length > 0) {
    lines.push(`\n✅ What's working:`)
    for (const s of brief.strengths) lines.push(`• ${s}`)
  }
  if (brief.leaks.length > 0) {
    lines.push(`\n⚠️ Where deals are leaking:`)
    for (const l of brief.leaks) lines.push(`• ${l}`)
  }
  lines.push(`\n🎯 Focus this week: ${brief.focusThisWeek}`)
  const subject = brief.leaks.length > 0
    ? `📋 Coaching brief: ${stats.name} — ${brief.leaks.length} thing${brief.leaks.length === 1 ? "" : "s"} to fix`
    : `📋 Coaching brief: ${stats.name} — on track`
  return { subject, body: lines.join("\n") }
}

// ── Dashboard adapter (the coaching dashboard's WeeklyReport shape) ───────────
//
// The coaching dashboard (app/dashboard/coaching) renders a "Weekly Report" card with the
// shape {overall_score, headline, wins[], gaps[], top_recommendation, recommended_actions[],
// deal_focus, created_at, id}. That card was historically fed by the RETIRED
// lib/intelligence/coaching-engine weekly-report (an AI free-text report persisted to
// agent_performance_reports). This OUTCOME-BASED loop is now the single source of truth, so
// the adapter below maps THIS brief's REAL signals into that exact UI shape — no new tables,
// no AI free-text, every line earned from a row:
//   strengths       → wins
//   leaks           → gaps
//   focusThisWeek   → top_recommendation
//   leaks/strengths → recommended_actions (the actionable focus + a couple of leak fixes)
//   focusThisWeek   → deal_focus
// overall_score is a PURE, deterministic 1:1 of the brief (no fabricated number): 100 minus a
// documented penalty per leak, floored, with an honest mid-score for the not-enough-data case.

/** The dashboard's Weekly Report shape — kept in lockstep with the coaching-dashboard client. */
export interface WeeklyCoachingReport {
  overall_score: number
  headline: string
  wins: string[]
  gaps: string[]
  top_recommendation: string
  recommended_actions: string[]
  deal_focus: string
}

/** PURE + deterministic. A 0-100 coaching score from the brief — never a fabricated number:
 *  each real leak costs LEAK_PENALTY (capped), a clean brief with strengths sits high, and the
 *  honest not-enough-data case is a neutral 70 (a "we don't know yet" placeholder, not praise). */
const LEAK_PENALTY = 12
export function coachingScore(brief: CoachingBrief): number {
  if (brief.notEnoughData) return 70
  const base = brief.strengths.length > 0 ? 92 : 80
  return Math.max(40, base - brief.leaks.length * LEAK_PENALTY)
}

/** PURE. Map a composed brief into the dashboard's WeeklyCoachingReport shape. */
export function briefToWeeklyReport(stats: AgentCoachingStats, brief: CoachingBrief): WeeklyCoachingReport {
  if (brief.notEnoughData) {
    return {
      overall_score: coachingScore(brief),
      headline: `${stats.name} — getting started`,
      wins: [],
      gaps: [],
      top_recommendation: brief.focusThisWeek,
      recommended_actions: ["Book showings", "Log your conversations", "Build a real activity base to coach on"],
      deal_focus: brief.focusThisWeek,
    }
  }
  const headline = brief.leaks.length > 0
    ? `${brief.leaks.length} thing${brief.leaks.length === 1 ? "" : "s"} to fix this week`
    : "On track — keep it up"
  // recommended_actions = the single focus first, then up to two more leak fixes (deduped).
  const actions = [brief.focusThisWeek, ...brief.leaks.slice(0, 2)].filter(
    (a, i, arr) => a && arr.indexOf(a) === i,
  )
  return {
    overall_score: coachingScore(brief),
    headline,
    wins: brief.strengths,
    gaps: brief.leaks,
    top_recommendation: brief.focusThisWeek,
    recommended_actions: actions,
    deal_focus: brief.focusThisWeek,
  }
}

/** Resolve the brokerage for an agent id (the dashboard's getLatestWeeklyReport only has the
 *  agent id; the new loop is brokerage-scoped). Returns null when the agent has no brokerage. */
async function brokerageForAgent(agentId: string, supabase: Svc): Promise<string | null> {
  const { data } = await supabase.from("agents").select("brokerage_id").eq("id", agentId).maybeSingle()
  return (data as { brokerage_id: string | null } | null)?.brokerage_id ?? null
}

/**
 * Build the coaching dashboard's Weekly Report for ONE agent from the REAL outcome stats —
 * the read path that replaces the retired getLatestWeeklyReport. Returns null when the agent
 * is unknown / has no brokerage (the dashboard renders its empty state).
 */
export async function getAgentWeeklyReport(
  agentId: string, opts: { now?: Date } = {}, client?: Svc,
): Promise<(WeeklyCoachingReport & { id: string; created_at: string }) | null> {
  if (!agentId) return null
  const supabase = client ?? createServiceClient()
  const brokerageId = await brokerageForAgent(agentId, supabase)
  if (!brokerageId) return null
  const now = opts.now ?? new Date()
  const statsList = await buildCoachingStats(brokerageId, { now }, supabase)
  const stats = statsList.find((s) => s.agentId === agentId)
  if (!stats) return null
  const brief = composeCoachingBrief(stats)
  return {
    ...briefToWeeklyReport(stats, brief),
    id: `${agentId}:${isoWeekTag(now)}`,
    created_at: now.toISOString(),
  }
}

// ── Live aggregation (REAL rows only) ─────────────────────────────────────────

const ACTIVE_TXN_STATUSES = ["active", "under_contract", "closing"] as const
/** calendar_events statuses that count as a scheduled appointment for no-show rate. */
const APPT_STATUSES = ["scheduled", "confirmed", "completed", "no_show"] as const

/**
 * Build the REAL per-agent coaching stats for a brokerage. Reuses generateAgentScorecards
 * for production / deal-health / education (already aggregated over real rows), and adds
 * the agent-scoped no-show / stale-book / tour→offer aggregates from the existing
 * conventions. Every number traces to a real row; missing data stays null/zero honestly.
 */
export async function buildCoachingStats(
  brokerageId: string, opts: { now?: Date; sinceIso?: string } = {}, client?: Svc,
): Promise<AgentCoachingStats[]> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  // Activity window for tours/offers/appointments — the trailing 90 days (a coaching
  // horizon: recent enough to be actionable, long enough to clear the sample gate).
  const windowStart = new Date(now.getTime() - 90 * 86_400_000).toISOString()
  const staleCutoff = new Date(now.getTime() - DEFAULT_STALE_DAYS * 86_400_000).toISOString()

  // Roster (active agents only) — id + user_id (calendar is keyed by agent_user_id).
  const { data: agentRows } = await supabase
    .from("agents").select("id, user_id").eq("brokerage_id", brokerageId).eq("is_active", true).limit(2000)
  const agents = (agentRows ?? []) as Array<{ id: string; user_id: string | null }>
  if (agents.length === 0) return []
  const agentIds = agents.map((a) => a.id)
  const userIds = agents.map((a) => a.user_id).filter(Boolean) as string[]

  // Scorecards (production / deal-health / education) — REUSE, do not recompute.
  const cards = await generateAgentScorecards({ brokerageId }, supabase)
  const cardById = new Map<string, AgentScorecard>(cards.map((c) => [c.agentId, c]))

  // Tours + offers in the window (agent-scoped) → tour→offer conversion.
  const tourCount = new Map<string, number>()
  const offerCount = new Map<string, number>()
  const { data: tours } = await supabase
    .from("tours").select("agent_id").eq("brokerage_id", brokerageId).in("agent_id", agentIds)
    .gte("created_at", windowStart).limit(20000)
  for (const t of (tours ?? []) as Array<{ agent_id: string | null }>) {
    if (t.agent_id) tourCount.set(t.agent_id, (tourCount.get(t.agent_id) ?? 0) + 1)
  }
  const { data: offers } = await supabase
    .from("offers").select("agent_id").eq("brokerage_id", brokerageId).in("agent_id", agentIds)
    .gte("created_at", windowStart).limit(20000)
  for (const o of (offers ?? []) as Array<{ agent_id: string | null }>) {
    if (o.agent_id) offerCount.set(o.agent_id, (offerCount.get(o.agent_id) ?? 0) + 1)
  }

  // Appointments + no-shows in the window (calendar_events keyed by agent_user_id).
  const apptCount = new Map<string, number>()
  const noShowCount = new Map<string, number>()
  if (userIds.length > 0) {
    const { data: appts } = await supabase
      .from("calendar_events").select("agent_user_id, status")
      .eq("brokerage_id", brokerageId).in("agent_user_id", userIds)
      .in("status", APPT_STATUSES as unknown as string[])
      .gte("start_at", windowStart).limit(20000)
    for (const e of (appts ?? []) as Array<{ agent_user_id: string | null; status: string | null }>) {
      if (!e.agent_user_id) continue
      apptCount.set(e.agent_user_id, (apptCount.get(e.agent_user_id) ?? 0) + 1)
      if (e.status === "no_show") noShowCount.set(e.agent_user_id, (noShowCount.get(e.agent_user_id) ?? 0) + 1)
    }
  }

  // Stale book: the agent's contacts gone cold (last_contacted_at past the stale cutoff,
  // not withdrawn) — the existing stale convention, scoped to the agent.
  const staleCount = new Map<string, number>()
  const { data: stale } = await supabase
    .from("contacts").select("agent_id")
    .eq("brokerage_id", brokerageId).in("agent_id", agentIds)
    .neq("nurture_status", "withdrawn")
    .lt("last_contacted_at", staleCutoff)
    .limit(20000)
  for (const c of (stale ?? []) as Array<{ agent_id: string | null }>) {
    if (c.agent_id) staleCount.set(c.agent_id, (staleCount.get(c.agent_id) ?? 0) + 1)
  }

  return agents.map((a) => {
    const card = cardById.get(a.id)
    return {
      agentId: a.id,
      name: card?.name ?? "Agent",
      ytdGci: card?.ytdGci ?? 0,
      closings: card?.closings ?? 0,
      activeDeals: card?.activeDeals ?? 0,
      avgHealthScore: card?.avgHealthScore ?? null,
      tours: tourCount.get(a.id) ?? 0,
      offers: offerCount.get(a.id) ?? 0,
      appointments: (a.user_id && apptCount.get(a.user_id)) || 0,
      noShows: (a.user_id && noShowCount.get(a.user_id)) || 0,
      staleContacts: staleCount.get(a.id) ?? 0,
      lessonsAssigned: card?.lessonsAssigned ?? 0,
      lessonsCompleted: card?.lessonsCompleted ?? 0,
      educationCompletionPct: card?.educationCompletionPct ?? null,
    }
  })
}

// ── The live runner ───────────────────────────────────────────────────────────

export interface AgentCoachingResult {
  agentsConsidered: number
  briefsProposed: number
  /** Briefs that landed as honest "not enough data yet" minimal briefs. */
  thinDataBriefs: number
  /** Briefs that carried at least one real leak. */
  briefsWithLeaks: number
  errors: string[]
}

/**
 * Per-agent weekly coaching brief for a brokerage. For each active agent:
 *  1) pull the REAL stats (buildCoachingStats — reusing the scorecard + the no-show /
 *     stale / tour-offer aggregates),
 *  2) compose the brief (composeCoachingBrief — pure),
 *  3) propose ONE GATED, manager-facing brief (audience 'agent', recruiting_manager) to
 *     the broker / team-lead — never autonomously to the agent.
 *
 * IDEMPOTENT: one brief per agent per ISO week, keyed on the agent_client_messages
 * rationale carrying the week tag + agent id (mirrors commission-forecaster). A brand-new
 * agent with no data gets an honest minimal brief, never fabricated criticism. NOT
 * server-only (simulator-driven).
 */
export async function runAgentCoaching(
  brokerageId: string, opts: { now?: Date } = {}, client?: Svc,
): Promise<AgentCoachingResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const weekTag = isoWeekTag(now)
  const result: AgentCoachingResult = {
    agentsConsidered: 0, briefsProposed: 0, thinDataBriefs: 0, briefsWithLeaks: 0, errors: [],
  }

  let statsList: AgentCoachingStats[]
  try {
    statsList = await buildCoachingStats(brokerageId, { now }, supabase)
  } catch (e: any) {
    result.errors.push(`buildCoachingStats: ${e?.message ?? String(e)}`)
    return result
  }

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")

  for (const stats of statsList) {
    result.agentsConsidered += 1
    try {
      // Idempotency — one coaching brief per agent per ISO week.
      const { data: already } = await supabase.from("agent_client_messages").select("id")
        .eq("brokerage_id", brokerageId).eq("agent_kind", "recruiting_manager").eq("entity_type", "agent")
        .ilike("rationale", `AGENT COACHING ${weekTag}%agent:${stats.agentId}%`).limit(1).maybeSingle()
      if (already) continue

      const brief = composeCoachingBrief(stats)
      const { subject, body } = renderCoachingMessage(stats, brief)

      const res = await proposeClientMessage({
        brokerageId, agentKind: "recruiting_manager", entityType: "agent", entityId: stats.agentId,
        audience: "agent", subject, body,
        rationale: `AGENT COACHING ${weekTag} — agent:${stats.agentId} — strengths ${brief.strengths.length}, leaks ${brief.leaks.length}${brief.notEnoughData ? ", not-enough-data" : ""}; gated manager-facing coaching brief.`,
        channel: "portal",
      }, supabase)

      if (res.ok) {
        result.briefsProposed += 1
        if (brief.notEnoughData) result.thinDataBriefs += 1
        if (brief.leaks.length > 0) result.briefsWithLeaks += 1
      } else if (res.error) {
        result.errors.push(`agent ${stats.agentId}: ${res.error}`)
      }
    } catch (e: any) {
      result.errors.push(`agent ${stats.agentId}: ${e?.message ?? String(e)}`)
    }
  }

  return result
}

/**
 * Single-agent coaching brief — the WRITE path behind the dashboard's "Generate New Report"
 * button. Builds the agent's REAL stats, proposes the ONE gated, manager-facing brief for THIS
 * agent (idempotent per ISO week, same rationale key as runAgentCoaching so the two never
 * double-propose), and returns the brief mapped into the dashboard's WeeklyCoachingReport
 * shape so the UI re-renders immediately. Returns null when the agent is unknown.
 */
export async function runAgentCoachingForAgent(
  agentId: string, brokerageId: string, opts: { now?: Date } = {}, client?: Svc,
): Promise<(WeeklyCoachingReport & { id: string; created_at: string }) | null> {
  if (!agentId || !brokerageId) return null
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const weekTag = isoWeekTag(now)

  const statsList = await buildCoachingStats(brokerageId, { now }, supabase)
  const stats = statsList.find((s) => s.agentId === agentId)
  if (!stats) return null

  const brief = composeCoachingBrief(stats)

  // Idempotency — one coaching brief per agent per ISO week (mirrors runAgentCoaching's key).
  const { data: already } = await supabase.from("agent_client_messages").select("id")
    .eq("brokerage_id", brokerageId).eq("agent_kind", "recruiting_manager").eq("entity_type", "agent")
    .ilike("rationale", `AGENT COACHING ${weekTag}%agent:${agentId}%`).limit(1).maybeSingle()

  if (!already) {
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const { subject, body } = renderCoachingMessage(stats, brief)
    await proposeClientMessage({
      brokerageId, agentKind: "recruiting_manager", entityType: "agent", entityId: agentId,
      audience: "agent", subject, body,
      rationale: `AGENT COACHING ${weekTag} — agent:${agentId} — strengths ${brief.strengths.length}, leaks ${brief.leaks.length}${brief.notEnoughData ? ", not-enough-data" : ""}; gated manager-facing coaching brief.`,
      channel: "portal",
    }, supabase)
  }

  return {
    ...briefToWeeklyReport(stats, brief),
    id: `${agentId}:${weekTag}`,
    created_at: now.toISOString(),
  }
}
