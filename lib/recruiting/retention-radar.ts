// lib/recruiting/retention-radar.ts
//
// Live side of the AGENT RETENTION RADAR (recruiting_manager). Daily, per active agent, it gathers the
// REAL engagement signals the app already tracks, computes the pure retention score, upserts the day's
// agent_retention_scores row, and — the moment an agent FRESHLY crosses into at-risk — proposes a gated
// broker "save play" (targeted to the driving signals) so a slipping agent is caught before they leave.
// Nothing auto-sends. Best-effort; never throws into a caller.

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createServiceClient } from "@/lib/supabase/service"
import {
  computeRetentionScore, isAtRisk, scoreTrendOf, weakFatigueSignals,
  CLIENT_REPLY_WINDOW_HOURS, SUPPORT_NUDGE_MIN_SIGNALS, type RetentionSignals,
} from "@/lib/recruiting/retention-score"
import { supportSuggestedLines } from "@/lib/recruiting/retention-intervention"
import { daysSince } from "@/lib/format/dates"

type Svc = ReturnType<typeof createServiceClient>

// TOMBSTONE: local daysSince merged onto lib/format/dates.ts daysSince
// (imported above) — §1/§6 SAME BODY census round 3, 2026-09-09.

// ── WAVE 89 (lane 89C) — AGENT FATIGUE SIGNALS, gathered beside the five the radar already had ──
// Owner, verbatim: "brokerages need agent fatigue signals so they can give the support that they are
// lacking before they decide to leave." EXTENDED, not rewritten (wave 88 NO-REWRITES): the same
// gatherSignals, the same computeRetentionScore, the same agent_retention_scores row — now carrying
// the fatigue sub-scores in signal_breakdown, the raw inputs in raw_signals (m674) and the broker's
// "support suggested" lines in support_suggested (m674). Every read destructures { data, error } and
// a refused read leaves THAT signal null (dropped + renormalized in the scorer), never zero.
//
// Identity classes (§3): agents.id keys transactions / tasks / buyer_fatigue_scores / contacts /
// client_portal_messages / agent_book_transfers; calendar_events is keyed on agent_user_id (users.id)
// and messages on agent_id — checked against the live columns 2026-09-29.

/** The wave-89 signal windows. */
const FATIGUE_WINDOW_DAYS = 30
const ACTIVITY_TREND_HALF_DAYS = 14
const BOOK_TRANSFER_WINDOW_DAYS = 90
/** calendar_events statuses that count as an appointment, and the ones that read as missed / moved. */
const FATIGUE_APPT_STATUSES = ["scheduled", "confirmed", "completed", "no_show", "rescheduled"] as const
const FATIGUE_MISSED_STATUSES = ["no_show", "rescheduled"] as const

/** PURE — pair client inbound messages with the agent's next outbound to the same contact:
 *  the median reply lag (hours) and the inbound messages still unanswered past the window. */
export function clientResponsiveness(
  rows: ReadonlyArray<{ contact_id: string | null; inbound: boolean; at: string }>,
  now: Date,
  windowHours: number = CLIENT_REPLY_WINDOW_HOURS,
): { medianLagHours: number | null; unanswered: number } {
  const byContact = new Map<string, Array<{ inbound: boolean; t: number }>>()
  for (const r of rows) {
    if (!r.contact_id) continue
    const t = Date.parse(r.at)
    if (!Number.isFinite(t)) continue
    const arr = byContact.get(r.contact_id) ?? []
    arr.push({ inbound: r.inbound, t })
    byContact.set(r.contact_id, arr)
  }
  const lags: number[] = []
  let unanswered = 0
  const cutoff = now.getTime() - windowHours * 3_600_000
  for (const arr of byContact.values()) {
    arr.sort((a, b) => a.t - b.t)
    let openInbound: number | null = null
    for (const m of arr) {
      if (m.inbound) { if (openInbound === null) openInbound = m.t }
      else if (openInbound !== null) { lags.push((m.t - openInbound) / 3_600_000); openInbound = null }
    }
    if (openInbound !== null && openInbound < cutoff) unanswered += 1
  }
  if (lags.length === 0) return { medianLagHours: null, unanswered }
  lags.sort((a, b) => a - b)
  const mid = Math.floor(lags.length / 2)
  const median = lags.length % 2 ? lags[mid] : (lags[mid - 1] + lags[mid]) / 2
  return { medianLagHours: Math.round(median * 10) / 10, unanswered }
}

/** Gather the real signals for one agent (best-effort; missing → null → neutral in the scorer). */
async function gatherSignals(
  svc: Svc, agent: { id: string; user_id?: string | null; brokerage_id?: string | null; created_at?: string | null }, now: Date,
): Promise<RetentionSignals> {
  const since30 = new Date(now.getTime() - 30 * 86_400_000).toISOString()
  const [act, lastClose, pipeline, onboarding, points] = await Promise.all([
    svc.from("agent_assistant_sessions").select("started_at").eq("agent_id", agent.id).order("started_at", { ascending: false }).limit(1).maybeSingle(),
    svc.from("transactions").select("close_date").eq("agent_id", agent.id).eq("status", "closed").not("close_date", "is", null).order("close_date", { ascending: false }).limit(1).maybeSingle(),
    svc.from("transactions").select("id", { count: "exact", head: true }).eq("agent_id", agent.id).in("stage", ["UNDER_CONTRACT", "INSPECTION", "APPRAISAL", "FINANCING_PENDING", "CLOSING_PREP"]),
    svc.from("agent_onboarding").select("completion_percentage").eq("agent_id", agent.id).maybeSingle(),
    svc.from("agent_points_log").select("points").eq("agent_id", agent.id).gte("created_at", since30).limit(2000),
  ])
  const points30d = Array.isArray(points.data) ? (points.data as Array<{ points: number | null }>).reduce((s, r) => s + (Number(r.points) || 0), 0) : null
  const base: RetentionSignals = {
    daysSinceActivity: daysSince((act.data as any)?.started_at ?? null, now),
    daysSinceClosing: daysSince((lastClose.data as any)?.close_date ?? null, now),
    activePipeline: (pipeline as any)?.count ?? null,
    onboardingPct: (onboarding.data as any)?.completion_percentage ?? null,
    tenureDays: daysSince(agent.created_at ?? null, now),
    gamificationPoints30d: points30d,
  }
  return { ...base, ...(await gatherFatigueSignals(svc, agent, now)) }
}

/** The wave-89 fatigue signals for one agent. Each read is error-read; a refusal is logged and leaves
 *  that signal ABSENT (null) so the scorer drops it — never a fabricated zero. Best-effort, never throws. */
async function gatherFatigueSignals(
  svc: Svc, agent: { id: string; user_id?: string | null; brokerage_id?: string | null }, now: Date,
): Promise<Partial<RetentionSignals>> {
  const sinceFatigue = new Date(now.getTime() - FATIGUE_WINDOW_DAYS * 86_400_000).toISOString()
  const sinceHalf = new Date(now.getTime() - ACTIVITY_TREND_HALF_DAYS * 86_400_000).toISOString()
  const sinceTrend = new Date(now.getTime() - 2 * ACTIVITY_TREND_HALF_DAYS * 86_400_000).toISOString()
  const sinceTransfer = new Date(now.getTime() - BOOK_TRANSFER_WINDOW_DAYS * 86_400_000).toISOString()
  const priorDate = new Date(now.getTime() - FATIGUE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)
  const today = now.toISOString().slice(0, 10)
  const refused = (what: string, err: { message?: string } | null | undefined) => {
    if (err) console.error(`[retention-radar] ${what} read refused for agent ${agent.id}: ${err.message ?? "unknown"}`)
    return !!err
  }

  const [portalMsgs, msgs, appts, sessions, tasks, priorScore, fatigued, book, transfers] = await Promise.all([
    // Client ↔ agent portal messages (direction CHECK: agent_to_client | client_to_agent).
    svc.from("client_portal_messages").select("contact_id, direction, created_at").eq("agent_id", agent.id).gte("created_at", sinceFatigue).limit(2000),
    // The inbox ledger (direction inbound | outbound), keyed on the same agents.id.
    svc.from("messages").select("contact_id, direction, created_at").eq("agent_id", agent.id).gte("created_at", sinceFatigue).limit(2000),
    // Appointments — calendar_events is THE appointment ledger (the no-show autopilot marks 'no_show';
    // seller-showings marks 'rescheduled'); keyed on agent_user_id (users.id).
    agent.user_id
      ? svc.from("calendar_events").select("status").eq("agent_user_id", agent.user_id).in("status", FATIGUE_APPT_STATUSES as unknown as string[]).gte("start_at", sinceFatigue).limit(2000)
      : Promise.resolve({ data: null, error: null }),
    // Platform activity trend — sessions in the last fortnight vs the one before.
    svc.from("agent_assistant_sessions").select("started_at").eq("agent_id", agent.id).gte("started_at", sinceTrend).limit(2000),
    // Follow-up tasks past due and not completed (tasks.status is free text; 'completed' is the done word).
    svc.from("tasks").select("id", { count: "exact", head: true }).eq("assigned_to_agent_id", agent.id).neq("status", "completed").lt("due_date", today),
    // The pipeline ~30 days ago — the raw signal this radar stored then (m674 raw_signals).
    svc.from("agent_retention_scores").select("raw_signals").eq("agent_id", agent.id).lte("score_date", priorDate).order("score_date", { ascending: false }).limit(1).maybeSingle(),
    // Contact fatigue on the agent's book — the one fatigue calculator's scores (buyer_fatigue_scores.agent_id, stamped in wave 88).
    svc.from("buyer_fatigue_scores").select("id", { count: "exact", head: true }).eq("agent_id", agent.id).in("risk_level", ["high", "critical"]),
    svc.from("contacts").select("id", { count: "exact", head: true }).eq("agent_id", agent.id).is("deleted_at", null),
    // Book transfers AWAY from the agent (temporary cover or permanent) in the window.
    svc.from("agent_book_transfers").select("id", { count: "exact", head: true }).eq("from_agent_id", agent.id).in("status", ["active", "permanent"]).gte("created_at", sinceTransfer),
  ])

  const out: Partial<RetentionSignals> = {}

  // Responsiveness — both message ledgers, paired per contact.
  if (!refused("client_portal_messages", portalMsgs.error) && !refused("messages", msgs.error)) {
    const rows: Array<{ contact_id: string | null; inbound: boolean; at: string }> = []
    for (const m of (portalMsgs.data ?? []) as Array<{ contact_id: string | null; direction: string | null; created_at: string }>) {
      rows.push({ contact_id: m.contact_id, inbound: m.direction === "client_to_agent", at: m.created_at })
    }
    for (const m of (msgs.data ?? []) as Array<{ contact_id: string | null; direction: string | null; created_at: string }>) {
      rows.push({ contact_id: m.contact_id, inbound: m.direction === "inbound", at: m.created_at })
    }
    const r = clientResponsiveness(rows, now)
    out.responseLagHours = r.medianLagHours
    // No inbound at all → nothing to answer → the signal is absent, not "0 unanswered = perfect".
    out.unansweredClientMessages = rows.some((x) => x.inbound) ? r.unanswered : null
  }

  if (!refused("calendar_events", appts.error) && appts.data) {
    const list = appts.data as Array<{ status: string | null }>
    out.appointments30d = list.length
    out.missedOrRescheduled30d = list.filter((e) => (FATIGUE_MISSED_STATUSES as readonly string[]).includes(e.status ?? "")).length
  }

  if (!refused("agent_assistant_sessions (trend)", sessions.error)) {
    const list = (sessions.data ?? []) as Array<{ started_at: string | null }>
    out.sessionsLast14d = list.filter((s) => (s.started_at ?? "") >= sinceHalf).length
    out.sessionsPrior14d = list.length - out.sessionsLast14d
  }

  if (!refused("tasks", tasks.error)) out.overdueTasks = (tasks as { count?: number | null }).count ?? 0

  if (!refused("agent_retention_scores (prior raw)", priorScore.error)) {
    const raw = (priorScore.data as { raw_signals?: { activePipeline?: unknown } | null } | null)?.raw_signals
    const prior = raw && typeof raw === "object" ? Number((raw as { activePipeline?: unknown }).activePipeline) : NaN
    out.activePipelinePrior = Number.isFinite(prior) ? prior : null
  }

  if (!refused("buyer_fatigue_scores", fatigued.error) && !refused("contacts", book.error)) {
    out.fatiguedContacts = (fatigued as { count?: number | null }).count ?? 0
    out.bookContacts = (book as { count?: number | null }).count ?? 0
  }

  if (!refused("agent_book_transfers", transfers.error)) out.bookTransfers90d = (transfers as { count?: number | null }).count ?? 0

  return out
}

/** How long a support nudge stands before the same agent's lit signals may raise another. */
const SUPPORT_NUDGE_DEDUPE_DAYS = 14

/**
 * WAVE 89 (lane 89C) — the AUTONOMOUS SUPPORT NUDGE. When two or more fatigue signals are lit
 * (SUPPORT_NUDGE_MIN_SIGNALS — "one signal is worth watching, two is worth a direct conversation"),
 * the broker / admin roster AND the agent's team lead get ONE in-app notice naming the signals and the
 * suggested support actions. It goes to the people who develop the agent — never to the agent (a
 * solo shop's owner IS the agent, so their own user id is skipped rather than told "you're at risk").
 * Deduped per agent per SUPPORT_NUDGE_DEDUPE_DAYS. Best-effort; never throws.
 */
async function nudgeSupport(
  svc: Svc,
  p: { brokerageId: string; agent: { id: string; user_id: string | null; team_id?: string | null }; agentName: string; score: number; signals: string[]; support: string[]; now: Date },
): Promise<boolean> {
  try {
    const { resolveOrgRecipients } = await import("@/lib/kernel/org-recipients")
    const recipients = new Set(await resolveOrgRecipients(svc, p.brokerageId))
    // The team lead of the agent's team (teams.team_lead_id is a users.id — the session identity class).
    if (p.agent.team_id) {
      const { data: team, error: teamErr } = await svc.from("teams").select("team_lead_id").eq("id", p.agent.team_id).eq("brokerage_id", p.brokerageId).maybeSingle()
      if (teamErr) console.error(`[retention-radar] team lead read refused: ${teamErr.message}`)
      const leadId = (team as { team_lead_id?: string | null } | null)?.team_lead_id
      if (leadId) recipients.add(leadId)
    }
    if (p.agent.user_id) recipients.delete(p.agent.user_id) // NEVER agent-facing
    if (recipients.size === 0) return false

    const sinceDedupe = new Date(p.now.getTime() - SUPPORT_NUDGE_DEDUPE_DAYS * 86_400_000).toISOString()
    let landed = false
    for (const userId of recipients) {
      const { data: seen, error: seenErr } = await svc.from("notifications").select("id")
        .eq("user_id", userId).eq("entity_type", "agent").eq("entity_id", p.agent.id).eq("type", "agent_support_suggested")
        .gte("created_at", sinceDedupe).limit(1).maybeSingle()
      if (seenErr) { console.error(`[retention-radar] support-nudge dedupe read refused: ${seenErr.message}`); continue }
      if (seen) continue
      const ok = await sentinelWrite(svc, svc.from("notifications").insert({
        user_id: userId, brokerage_id: p.brokerageId, type: "agent_support_suggested",
        title: `${p.agentName} may need support (${p.signals.length} fatigue signal${p.signals.length === 1 ? "" : "s"})`,
        body: `${p.signals.join("; ")}. Suggested support: ${p.support.join(" · ")}`,
        entity_type: "agent", entity_id: p.agent.id, priority: p.score < 60 ? "high" : "medium", is_read: false,
      }), { table: "notifications", flow: "retention_radar_support_nudge", brokerageId: p.brokerageId, reason: "in-app notification — a lost row is a missed bell, never the score row it follows" })
      landed = landed || ok
    }
    return landed
  } catch (e) {
    console.error("[retention-radar] support nudge failed:", e)
    return false
  }
}

/**
 * Propose ONE gated retention save-play for an at-risk agent (idempotent per agent — an open save-play
 * isn't re-proposed). Shared by the daily radar (on a fresh breach) and the on-demand voice/broker
 * "draft save-plays" command, so both use the same dedupe tag + copy. Returns true when a NEW one lands.
 */
export async function proposeRetentionSavePlay(
  svc: Svc, p: { brokerageId: string; agentId: string; agentName: string; score: number; drivers: string[] },
): Promise<boolean> {
  const dedupeTag = `RETENTION SAVE-PLAY — agent:${p.agentId}`
  const { data: prior } = await svc.from("agent_client_messages").select("id")
    .eq("brokerage_id", p.brokerageId).eq("entity_type", "agent").eq("entity_id", p.agentId)
    .eq("agent_kind", "recruiting_manager").ilike("rationale", `${dedupeTag}%`).in("status", ["proposed", "approved"]).limit(1).maybeSingle()
  if (prior) return false
  try {
    // SIGNAL-SPECIFIC intervention — the save-play is tailored to the dominant driving signal (quiet vs
    // drought vs stalled pipeline vs onboarding), not one generic template.
    const { buildSavePlayCopy } = await import("@/lib/recruiting/retention-intervention")
    const copy = buildSavePlayCopy({ agentName: p.agentName, score: p.score, drivers: p.drivers })
    const driverText = p.drivers.filter(Boolean).join("; ") || "engagement is slipping across the board"

    // RETENTION LEVER — the broker-marked benefit offerings (residual income / medical /
    // retirement, m574 + m264). An at-risk agent weighing a competing offer should be reminded of
    // the FULL package they'd walk away from, so the save-play tells the broker which marked
    // offerings to put back on the table. FAIL-CLOSED: loader errors / unset marks → no line at
    // all — an unoffered benefit must never appear in a retention conversation.
    let benefitsLever = ""
    try {
      const { loadBenefitOfferings, offeredBenefitLabels } = await import("@/lib/recruiting/benefit-offerings")
      const labels = offeredBenefitLabels(await loadBenefitOfferings(svc, p.brokerageId))
      if (labels.length > 0) {
        benefitsLever = `\n\nRetention lever — what ${p.agentName} would be walking away from here:\n${labels.map((l) => `· ${l}`).join("\n")}\nWork these into the conversation as part of the full picture of staying.`
      }
    } catch { /* the save-play stands without it */ }
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: p.brokerageId, agentKind: "recruiting_manager", entityType: "agent", entityId: p.agentId,
      recipientContactId: null, audience: "agent",
      subject: copy.subject,
      body: copy.body + benefitsLever,
      rationale: `${dedupeTag} — score ${p.score}, intervention ${copy.interventionKey}, drivers: ${driverText}; review before it reaches the agent/broker.`,
      channel: "portal",
    }, svc)
    return res.ok
  } catch { return false }
}

export interface RetentionRadarResult {
  scanned: number; scored: number; atRisk: number; savePlaysProposed: number
  /** Wave 89: agents with ≥ SUPPORT_NUDGE_MIN_SIGNALS lit fatigue signals, and the nudges that landed. */
  supportSuggested: number; supportNudged: number
}

/** Score a brokerage's active agents, persist today's scores, and propose a save-play on a fresh breach. */
export async function runRetentionRadar(
  svc: Svc, params: { brokerageId: string; now?: Date },
): Promise<RetentionRadarResult> {
  const out: RetentionRadarResult = { scanned: 0, scored: 0, atRisk: 0, savePlaysProposed: 0, supportSuggested: 0, supportNudged: 0 }
  const now = params.now ?? new Date()
  const today = now.toISOString().slice(0, 10)

  const { data: agents } = await svc
    .from("agents")
    .select("id, user_id, team_id, created_at, users(first_name, last_name)")
    .eq("brokerage_id", params.brokerageId).not("user_id", "is", null).limit(500)

  for (const a of (agents ?? []) as any[]) {
    out.scanned++
    const sig = await gatherSignals(svc, { ...a, brokerage_id: params.brokerageId }, now)
    const rs = computeRetentionScore(sig)
    // Wave 89: which fatigue signals are lit, and the broker's support lines for the drivers.
    const litSignals = weakFatigueSignals(rs.breakdown)
    const supportSuggested = supportSuggestedLines(rs.drivingSignals)

    // Previous score (yesterday-or-earlier) for trend + fresh-breach detection.
    const { data: prev } = await svc.from("agent_retention_scores")
      .select("composite_score").eq("agent_id", a.id).lt("score_date", today)
      .order("score_date", { ascending: false }).limit(1).maybeSingle()
    const previousScore = (prev as any)?.composite_score ?? null

    await sentinelWrite(svc, svc.from("agent_retention_scores").upsert({
      brokerage_id: params.brokerageId, agent_id: a.id, score_date: today,
      composite_score: rs.score, previous_score: previousScore, tier: rs.tier,
      score_trend: scoreTrendOf(rs.score, previousScore), driving_signals: rs.drivingSignals, signal_breakdown: rs.breakdown as any,
      // m674 (wave 89, lane 89C): the raw inputs (the next run's pipeline-drop baseline) and the
      // broker's support lines. An unapplied m674 refuses the WHOLE upsert (PGRST204) — ledgered.
      raw_signals: sig as any,
      support_suggested: supportSuggested,
    }, { onConflict: "agent_id,score_date" }), { table: "agent_retention_scores", flow: "agent_retention_scores_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
    out.scored++

    const u = Array.isArray(a.users) ? a.users[0] : a.users
    const agentName = [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim() || "An agent"

    // WAVE 89 — the support nudge fires on LIT SIGNALS, before the composite reads at-risk: the owner
    // wants the support given "before they decide to leave", and two lit signals is that moment.
    if (litSignals.length >= SUPPORT_NUDGE_MIN_SIGNALS) {
      out.supportSuggested++
      const signalLabels = rs.drivingSignals.length ? rs.drivingSignals : litSignals
      if (await nudgeSupport(svc, { brokerageId: params.brokerageId, agent: a, agentName, score: rs.score, signals: signalLabels, support: supportSuggested, now })) out.supportNudged++
    }

    if (!isAtRisk(rs.score)) continue
    out.atRisk++

    // FRESH breach only — crossed into at-risk (no prior score, or prior was healthy). A persistent
    // low doesn't re-spam; the score keeps updating silently until they recover or the broker acts.
    const freshBreach = previousScore == null || previousScore >= 40
    if (!freshBreach) continue

    if (await proposeRetentionSavePlay(svc, { brokerageId: params.brokerageId, agentId: a.id, agentName, score: rs.score, drivers: rs.drivingSignals })) out.savePlaysProposed++

    // Also surface directly (deduped per open, like the license sweep). TIER-SAFE — a broker/admin gets
    // the flag in a team/brokerage org; a SOLO agent (no separate broker) gets it themselves, so a
    // one-person shop's red-flag is never dropped for lack of a broker recipient.
    try {
      const { resolveOrgRecipients } = await import("@/lib/kernel/org-recipients")
      const recipientIds = await resolveOrgRecipients(svc, params.brokerageId)
      for (const mId of recipientIds) {
        const { data: seen } = await svc.from("notifications").select("id").eq("user_id", mId).eq("entity_type", "agent").eq("entity_id", a.id).eq("type", "agent_retention_risk").gte("created_at", new Date(now.getTime() - 7 * 86_400_000).toISOString()).limit(1).maybeSingle()
        if (seen) continue
        const driverText = rs.drivingSignals.length ? rs.drivingSignals.join("; ") : "engagement is slipping across the board"
        await sentinelWrite(svc, svc.from("notifications").insert({ user_id: mId, brokerage_id: params.brokerageId, type: "agent_retention_risk", title: `${agentName} is at retention risk (${rs.score}/100)`, body: driverText, entity_type: "agent", entity_id: a.id, priority: "high", is_read: false }), { table: "notifications", flow: "retention_radar_notify", brokerageId: params.brokerageId, reason: "in-app notification — a lost row is a missed bell, never the business write it follows" })
      }
    } catch { /* best-effort */ }
  }
  return out
}

/**
 * ON-DEMAND — draft gated save-plays for every CURRENTLY at-risk agent that doesn't already have one
 * open (invoked by the voice command "draft save-plays for my at-risk agents" or a broker button). Reads
 * the retention board (latest scores) and reuses proposeRetentionSavePlay, so it shares the radar's
 * dedupe + copy. Returns how many were drafted. Best-effort.
 */
export async function draftSavePlaysForAtRiskAgents(svc: Svc, params: { brokerageId: string }): Promise<{ atRisk: number; drafted: number }> {
  const out = { atRisk: 0, drafted: 0 }
  const { generateRetentionBoard } = await import("@/lib/intelligence/retention-board")
  const board = await generateRetentionBoard(params.brokerageId, svc)
  if (!board) return out
  for (const a of board.agents) {
    if (a.tier !== "at_risk" && a.tier !== "critical") continue
    out.atRisk++
    if (await proposeRetentionSavePlay(svc, { brokerageId: params.brokerageId, agentId: a.agentId, agentName: a.name, score: a.score, drivers: a.drivers })) out.drafted++
  }
  return out
}

/** Autonomous: score every brokerage's agents (rides the daily compliance-monitoring cron). */
export async function runRetentionRadarAll(svc: Svc, now?: Date): Promise<{ brokerages: number; atRisk: number; savePlays: number; supportNudged: number }> {
  const out = { brokerages: 0, atRisk: 0, savePlays: 0, supportNudged: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runRetentionRadar(svc, { brokerageId: b.id, now }); out.atRisk += r.atRisk; out.savePlays += r.savePlaysProposed; out.supportNudged += r.supportNudged } catch { /* keep going */ }
  }
  return out
}
