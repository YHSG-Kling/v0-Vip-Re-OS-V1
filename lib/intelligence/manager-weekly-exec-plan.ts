// lib/intelligence/manager-weekly-exec-plan.ts
//
// THE AI EXECUTIVE STANDUP — the executive synthesis layer that sits ABOVE the per-manager weekly P&L.
// Every manager already reports what it PRODUCED this week (manager-weekly-pnl) and every board already
// surfaces its own signal (retention flight-risk, approval backlog, curriculum, revenue-share…). What no
// surface did was RANK those signals against each other by dollar impact and hand the human ONE prioritized
// org plan: "here are the N moves that most move your P&L this week, why, which manager owns each, and the
// single thing only you can decide." This is a scoring/sort pass over already-aggregated data — NOT a new
// data system (it reuses the exact tables the boards already made trustworthy).
//
// HONEST BY CONSTRUCTION: a move only carries a dollar figure when a REAL one exists (a WoW GCI delta, an
// at-risk producer's trailing production, stuck-deal value). When no real dollar is available the move is
// banded qualitatively (high/medium/low) and NEVER assigned a fabricated number — the same discipline the
// rest of the OS holds. The total only sums dollars we actually know.
//
// This file is PURE (no I/O) so it is fully unit-testable; the generator (loadWeeklyExecPlan) feeds it real
// board data and the Command Center renders it.

import { createServiceClient } from "@/lib/supabase/service"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import { generateManagerWeeklyPnl, type ManagerWeeklyScorecard } from "@/lib/intelligence/manager-weekly-pnl"
import { generateRetentionBoard, type RetentionBoard } from "@/lib/intelligence/retention-board"
import { generateCurriculumBoard, type CurriculumBoard } from "@/lib/intelligence/curriculum-board"

export type ExecSignalKind =
  | "production_drop"      // a manager's weekly production fell sharply WoW
  | "retention_risk"       // a producing agent freshly at flight-risk (churn = lost future GCI)
  | "approval_backlog"     // SLA-breached proposals waiting on a human — value stuck at the gate
  | "compliance_exposure"  // an outbound blocked / a lapse that exposes the brokerage
  | "enablement"           // AI-authored curriculum / skill refresh pending human publish
  | "flywheel"             // a growth lever (recruiting flywheel, revenue-share, marketplace take-rate)
  | "growth_opportunity"   // a manager's production surged — press the advantage

/** One executive-level signal, normalized from a board/scorecard. The generator fills real numbers. */
export interface ExecSignal {
  kind: ExecSignalKind
  /** The accountable Claude manager (registry key). */
  manager: ManagerKey
  /** The move, imperative + specific. e.g. "Reverse AI ISA's 42% handoff drop". */
  title: string
  /** The driving evidence in the broker's language — REAL numbers only. */
  why: string
  /**
   * Dollar impact in cents when a REAL figure exists (WoW GCI delta, trailing GCI at risk, stuck value);
   * null when no honest dollar is available (then `impactBand` carries the weight instead).
   */
  estimatedImpactCents: number | null
  /** 0..100 — how time-sensitive (a freshly-crossed threshold / SLA breach is more urgent than a trend). */
  urgency: number
  /** 0..100 — how confident the signal is real (thin data lowers this, never fabricates). */
  confidence: number
  /** Rough hours the human action costs — feeds the effort term (a 5-min approval beats a re-org). */
  effortHours: number
  /** Does this need a HUMAN decision, or will the owning manager handle it autonomously? Drives the one ask. */
  needsHuman: boolean
  /** Deep-link the Command Center can attach so the move is one click from the relevant board/queue. */
  ctaHref?: string
  /** The entity this move concerns (agent id / manager key), for dedup + linking. */
  entityId?: string | null
}

export interface RankedExecMove extends ExecSignal {
  rank: number
  priorityScore: number
  /** Qualitative impact band — honest when no dollar figure exists; derived from the dollar when it does. */
  impactBand: "high" | "medium" | "low"
  /** The manager's display label, resolved for the UI. */
  managerLabel: string
}

export interface WeeklyExecPlan {
  weekLabel: string
  moves: RankedExecMove[]
  /** The single highest-priority move that requires a human — the "one ask". Null on a clean week. */
  oneAsk: RankedExecMove | null
  /** Sum of the REAL dollar impacts only (moves with a null figure are excluded — never inflated). */
  totalKnownImpactCents: number
  /** One executive sentence over the whole plan. */
  headline: string
}

/** $ → a saturating 0..100 impact score ($100k of weekly impact tops it out). */
export function dollarImpactScore(cents: number | null): number | null {
  if (cents === null || !Number.isFinite(cents)) return null
  const dollars = Math.abs(cents) / 100
  return Math.min(100, Math.round((dollars / 100_000) * 100))
}

/** A kind-appropriate default impact score for signals with NO honest dollar figure (never fabricates $). */
const KIND_DEFAULT_IMPACT: Record<ExecSignalKind, number> = {
  retention_risk: 80,       // losing a producer is expensive even before we price it
  production_drop: 70,
  compliance_exposure: 75,  // exposure is high-consequence regardless of a clean dollar
  flywheel: 55,
  growth_opportunity: 45,
  approval_backlog: 50,
  enablement: 30,
}

/**
 * PURE: the shared priority formula, mirroring lib/income-engine/action-recommender.ts `priority_score`
 * (impact·0.4 + urgency·0.3 + confidence·0.2 + (100−effort)·0.1) so the executive layer ranks on the SAME
 * scale the income engine already uses per-agent — one prioritization language across the OS.
 */
export function execPriorityScore(impact: number, urgency: number, confidence: number, effortHours: number): number {
  const effortPct = Math.min(100, (effortHours / 4) * 100) // 4h = 100% effort, same anchor as the income engine
  return Math.round((impact * 0.4 + urgency * 0.3 + confidence * 0.2 + (100 - effortPct) * 0.1) * 100) / 100
}

function bandFor(impactScore: number): "high" | "medium" | "low" {
  if (impactScore >= 66) return "high"
  if (impactScore >= 33) return "medium"
  return "low"
}

/**
 * PURE: rank executive signals by dollar-weighted priority, assign 1-indexed ranks, pick the one ask, and
 * write an honest headline. Deterministic tie-break: higher known-dollar first, then title. Caps to `topN`.
 */
export function rankExecutiveMoves(signals: ExecSignal[], opts?: { weekLabel?: string; topN?: number }): WeeklyExecPlan {
  const topN = opts?.topN ?? 6
  const weekLabel = opts?.weekLabel ?? "this week"

  const scored = signals.map((s) => {
    const dollarScore = dollarImpactScore(s.estimatedImpactCents)
    const impact = dollarScore ?? KIND_DEFAULT_IMPACT[s.kind]
    const priorityScore = execPriorityScore(impact, s.urgency, s.confidence, s.effortHours)
    return {
      ...s,
      priorityScore,
      impactBand: bandFor(impact),
      managerLabel: MANAGERS[s.manager]?.label ?? s.manager,
    }
  })

  scored.sort((a, b) =>
    b.priorityScore - a.priorityScore ||
    (b.estimatedImpactCents ?? -1) - (a.estimatedImpactCents ?? -1) ||
    a.title.localeCompare(b.title),
  )

  const moves: RankedExecMove[] = scored.slice(0, topN).map((s, i) => ({ ...s, rank: i + 1 }))
  const oneAsk = moves.find((m) => m.needsHuman) ?? null
  const totalKnownImpactCents = moves.reduce((acc, m) => acc + (m.estimatedImpactCents ?? 0), 0)

  const headline = buildHeadline(moves, totalKnownImpactCents, weekLabel)
  return { weekLabel, moves, oneAsk, totalKnownImpactCents, headline }
}

function buildHeadline(moves: RankedExecMove[], totalCents: number, weekLabel: string): string {
  if (moves.length === 0) return `No priority moves ${weekLabel} — the AI team has the board covered.`
  const top = moves[0]
  const dollars = totalCents > 0 ? ` ~$${Math.round(totalCents / 100).toLocaleString()} of ranked impact in play.` : ""
  return `${moves.length} prioritized move${moves.length === 1 ? "" : "s"} ${weekLabel}, led by ${top.managerLabel}: ${top.title}.${dollars}`
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL MAPPING (pure) — turn the already-aggregated boards/scorecards into ExecSignals. Every dollar here
// traces to a real number (a WoW GCI delta, an at-risk producer's trailing production, a recruiting ROI);
// where no honest dollar exists the signal carries a null figure and leans on its qualitative band.

const CC_HREF = "/dashboard/admin/command-center"

export interface ExecPlanInputs {
  weeklyPnl: ManagerWeeklyScorecard[]
  retentionBoard: RetentionBoard | null
  curriculumBoard: CurriculumBoard | null
  /** Per-manager approval backlog (breached = SLA-breached). Empty in the cron path (no live SLA state). */
  managerBacklog: Array<{ manager: ManagerKey; breached: number; pending: number }>
  /** agentId → REAL trailing production (cents) for at-risk agents; absent → the move bands by tier. */
  atRiskGciCents: Map<string, number>
  /** Brokerage recruiting ROI (avg %) + the lifetime value the flywheel is compounding (cents), or null. */
  recruitingRoiPct: number | null
  recruitingLtvCents: number | null
}

/** PURE: assemble ExecSignals from the inputs, then rank. No I/O — fully unit-testable. */
export function buildWeeklyExecPlan(inputs: ExecPlanInputs, opts?: { weekLabel?: string; topN?: number }): WeeklyExecPlan {
  const signals: ExecSignal[] = []

  // 1) RETENTION RISK — losing a producer is the most expensive thing a brokerage lets happen. One signal per
  //    at-risk/critical agent (top 3, worst-first), priced by their real trailing production when we have it.
  const atRisk = (inputs.retentionBoard?.agents ?? []).filter((a) => a.tier === "critical" || a.tier === "at_risk").slice(0, 3)
  for (const a of atRisk) {
    const cents = inputs.atRiskGciCents.get(a.agentId) ?? null
    const trend = a.trend ? `, ${a.trend}` : ""
    const drivers = a.drivers.length ? ` — ${a.drivers.slice(0, 2).join("; ")}` : ""
    signals.push({
      kind: "retention_risk",
      manager: "recruiting_manager",
      title: `Save ${a.name} — ${a.tier === "critical" ? "critical" : "rising"} flight risk`,
      why: `${a.name} is ${a.tier} (retention ${a.score}/100${trend})${drivers}.${cents ? ` ~$${Math.round(cents / 100).toLocaleString()} of trailing production walks if they leave.` : ""}`,
      estimatedImpactCents: cents,
      urgency: a.tier === "critical" ? 95 : 80,
      confidence: Math.min(95, 55 + Math.round((100 - a.score) / 2)),
      effortHours: 1,
      needsHuman: true,
      ctaHref: CC_HREF,
      entityId: a.agentId,
    })
  }

  // 2) PRODUCTION MOVES — read the weekly P&L for a sharp GCI swing (real dollars, WoW).
  const dc = inputs.weeklyPnl.find((c) => c.manager === "deal_coordinator")
  const gci = dc?.metrics.find((m) => m.unit === "currency")
  if (gci && gci.deltaPct !== null) {
    if (gci.deltaPct <= -35 && gci.prior >= 1000) {
      signals.push({
        kind: "production_drop",
        manager: "deal_coordinator",
        title: `Reverse the ${Math.abs(gci.deltaPct)}% GCI drop`,
        why: `Closed GCI fell from $${Math.round(gci.prior).toLocaleString()} to $${Math.round(gci.value).toLocaleString()} week-over-week — the pipeline needs a push before it compounds.`,
        estimatedImpactCents: Math.round((gci.prior - gci.value) * 100),
        urgency: 75, confidence: 80, effortHours: 2, needsHuman: true, ctaHref: CC_HREF,
      })
    } else if (gci.deltaPct >= 50 && gci.value >= 1000) {
      signals.push({
        kind: "growth_opportunity",
        manager: "deal_coordinator",
        title: `Press the advantage — GCI up ${gci.deltaPct}%`,
        why: `Closed GCI jumped from $${Math.round(gci.prior).toLocaleString()} to $${Math.round(gci.value).toLocaleString()} WoW. Reinvest the momentum (ads + listing pushes) while it's hot.`,
        estimatedImpactCents: Math.round((gci.value - gci.prior) * 100),
        urgency: 40, confidence: 70, effortHours: 3, needsHuman: false, ctaHref: CC_HREF,
      })
    }
  }
  // A soft, no-dollar dip on any manager's headline metric — the owning manager handles it, but surface it.
  for (const card of inputs.weeklyPnl) {
    const head = card.metrics.find((m) => m.unit === "count")
    if (head && head.deltaPct !== null && head.deltaPct <= -50 && head.prior >= 4 && card.manager !== "deal_coordinator") {
      signals.push({
        kind: "production_drop",
        manager: card.manager,
        title: `${card.label} output down ${Math.abs(head.deltaPct)}%`,
        why: `${head.label} fell from ${head.prior} to ${head.value} WoW. ${card.label} is on it — flagged for visibility.`,
        estimatedImpactCents: null,
        urgency: 45, confidence: 65, effortHours: 0.5, needsHuman: false, ctaHref: CC_HREF,
      })
    }
  }

  // 3) APPROVAL BACKLOG — value stuck at the gate. Low-effort, high-urgency when SLA-breached (a strong one-ask).
  const worstBacklog = [...inputs.managerBacklog].filter((b) => b.breached > 0).sort((a, b) => b.breached - a.breached)[0]
  if (worstBacklog) {
    const label = MANAGERS[worstBacklog.manager]?.label ?? worstBacklog.manager
    signals.push({
      kind: "approval_backlog",
      manager: worstBacklog.manager,
      title: `Clear ${label}'s ${worstBacklog.breached} overdue approval${worstBacklog.breached === 1 ? "" : "s"}`,
      why: `${worstBacklog.breached} proposal${worstBacklog.breached === 1 ? " has" : "s have"} breached SLA (of ${worstBacklog.pending} pending). Each is a ready deliverable the team is waiting on — a few clicks releases them.`,
      estimatedImpactCents: null,
      urgency: 90, confidence: 95, effortHours: 0.2, needsHuman: true, ctaHref: CC_HREF,
    })
  }

  // 4) FLYWHEEL — when recruiting is clearly profitable, tell the broker to press it (real ROI %).
  if (inputs.recruitingRoiPct !== null && inputs.recruitingRoiPct > 20) {
    signals.push({
      kind: "flywheel",
      manager: "recruiting_manager",
      title: `Press the recruiting flywheel — ${Math.round(inputs.recruitingRoiPct)}% ROI`,
      why: `Recruited agents are returning ${Math.round(inputs.recruitingRoiPct)}% on cost${inputs.recruitingLtvCents ? ` (~$${Math.round(inputs.recruitingLtvCents / 100).toLocaleString()} lifetime value compounding)` : ""}. Approve the week's switch-propensity brief to add the next producers.`,
      estimatedImpactCents: inputs.recruitingLtvCents,
      urgency: 30, confidence: 70, effortHours: 3, needsHuman: false, ctaHref: CC_HREF,
    })
  }

  // 5) ENABLEMENT — AI-authored curriculum waiting to publish (the OS teaching itself to teach).
  if (inputs.curriculumBoard && inputs.curriculumBoard.pending > 0) {
    const n = inputs.curriculumBoard.pending
    signals.push({
      kind: "enablement",
      manager: "recruiting_manager",
      title: `Publish ${n} AI-authored course${n === 1 ? "" : "s"}`,
      why: `The OS drafted ${n} micro-course${n === 1 ? "" : "s"} from real skill gaps, awaiting your publish. Approving them keeps the roster sharp.`,
      estimatedImpactCents: null,
      urgency: 25, confidence: 80, effortHours: 0.5, needsHuman: true, ctaHref: CC_HREF,
    })
  }

  return rankExecutiveMoves(signals, opts)
}

/**
 * Load + synthesize the weekly executive plan for a brokerage. Reuses the already-computed boards when the
 * caller passes them (the Command Center path — no double board queries), otherwise computes them (the cron
 * path). Always does the small honest finance reads (at-risk trailing production + recruiting ROI). Best-effort.
 */
export async function loadWeeklyExecPlan(
  brokerageId: string,
  opts?: {
    supabase?: ReturnType<typeof createServiceClient>
    weeklyPnl?: ManagerWeeklyScorecard[]
    retentionBoard?: RetentionBoard | null
    curriculumBoard?: CurriculumBoard | null
    managerBacklog?: Array<{ manager: ManagerKey; breached: number; pending: number }>
    weekLabel?: string
    topN?: number
  },
): Promise<WeeklyExecPlan> {
  const supabase = opts?.supabase ?? createServiceClient()

  const [weeklyPnl, retentionBoard, curriculumBoard] = await Promise.all([
    opts?.weeklyPnl ?? generateManagerWeeklyPnl(brokerageId),
    opts?.retentionBoard !== undefined ? Promise.resolve(opts.retentionBoard) : generateRetentionBoard(brokerageId, supabase),
    opts?.curriculumBoard !== undefined ? Promise.resolve(opts.curriculumBoard) : generateCurriculumBoard(brokerageId, supabase),
  ])

  // Honest finance reads.
  const atRiskGciCents = new Map<string, number>()
  const atRiskIds = (retentionBoard?.agents ?? []).filter((a) => a.tier === "critical" || a.tier === "at_risk").map((a) => a.agentId)
  if (atRiskIds.length) {
    try {
      const { data } = await supabase.from("agent_pl_snapshot").select("agent_id, gci_gross").eq("brokerage_id", brokerageId).in("agent_id", atRiskIds).limit(5000)
      for (const r of (data ?? []) as Array<{ agent_id: string; gci_gross: number | null }>) {
        atRiskGciCents.set(r.agent_id, (atRiskGciCents.get(r.agent_id) ?? 0) + Math.round((Number(r.gci_gross) || 0) * 100))
      }
    } catch { /* no snapshots → price by tier */ }
  }

  let recruitingRoiPct: number | null = null
  let recruitingLtvCents: number | null = null
  try {
    const { data } = await supabase.from("recruiting_roi").select("roi_pct, ltv_estimate").eq("brokerage_id", brokerageId).limit(2000)
    const rows = (data ?? []) as Array<{ roi_pct: number | null; ltv_estimate: number | null }>
    if (rows.length) {
      const roi = rows.map((r) => Number(r.roi_pct)).filter((n) => Number.isFinite(n))
      if (roi.length) recruitingRoiPct = Math.round(roi.reduce((a, b) => a + b, 0) / roi.length)
      const ltv = rows.reduce((a, r) => a + (Number(r.ltv_estimate) || 0), 0)
      if (ltv > 0) recruitingLtvCents = Math.round(ltv * 100)
    }
  } catch { /* no recruiting ROI yet */ }

  return buildWeeklyExecPlan({
    weeklyPnl, retentionBoard, curriculumBoard,
    managerBacklog: opts?.managerBacklog ?? [],
    atRiskGciCents, recruitingRoiPct, recruitingLtvCents,
  }, { weekLabel: opts?.weekLabel, topN: opts?.topN })
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTONOMOUS — the weekly proactive nudge. Rides the Monday recruit-outreach cron: per brokerage it
// synthesizes the plan and, when there are real moves, drops ONE internal notification to the org's leaders
// (tier-safe via resolveOrgRecipients — a solo owner still gets it) pointing them at the Command Center.
// Nothing leaves the org (this is executive info to the broker, not client egress), so it is not gated;
// idempotent per brokerage per week (a single exec_standup notification in the trailing 6 days suppresses it).

/** Compute + deliver the weekly standup nudge for one brokerage. Returns true if it briefed (else deduped/empty). */
export async function runWeeklyExecStandup(
  supabase: ReturnType<typeof createServiceClient>, brokerageId: string, now: Date = new Date(),
): Promise<boolean> {
  const plan = await loadWeeklyExecPlan(brokerageId, { supabase })
  if (plan.moves.length === 0) return false

  // Weekly dedup — any exec_standup notification for this brokerage in the trailing 6 days suppresses a re-send.
  const since = new Date(now.getTime() - 6 * 86_400_000).toISOString()
  const { count } = await supabase.from("notifications").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("type", "exec_standup").gte("created_at", since)
  if ((count ?? 0) > 0) return false

  const { resolveOrgRecipients } = await import("@/lib/kernel/org-recipients")
  const recipients = await resolveOrgRecipients(supabase, brokerageId)
  if (recipients.length === 0) return false

  const ask = plan.oneAsk ? ` Start here: ${plan.oneAsk.title}.` : ""
  const priority = plan.oneAsk?.impactBand === "high" ? "high" : "medium"
  const body = `${plan.headline}${ask} Open the Command Center to action your ranked plan.`
  for (const uid of recipients) {
    await supabase.from("notifications").insert({
      user_id: uid, brokerage_id: brokerageId, type: "exec_standup",
      title: "🎯 Your AI Executive Standup is ready", body,
      entity_type: "brokerage", entity_id: brokerageId, priority, is_read: false,
    }).then(undefined, () => {})
  }
  return true
}

/** Ride the weekly cron: brief every brokerage that has real priority moves this week. Best-effort. */
export async function runWeeklyExecStandupAll(
  supabase?: ReturnType<typeof createServiceClient>, now: Date = new Date(),
): Promise<{ brokerages: number; briefed: number }> {
  const svc = supabase ?? createServiceClient()
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  let briefed = 0
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    try { if (await runWeeklyExecStandup(svc, b.id, now)) briefed++ } catch { /* keep going */ }
  }
  return { brokerages: (rows ?? []).length, briefed }
}
