/**
 * Brokerage Intelligence — pattern miners
 *
 * Each miner analyzes a brokerage's anonymized agent-level data, finds the
 * top-quartile pattern, and emits an insight describing the winning
 * behavior, the lift over the bottom quartile, and a playbook of concrete
 * actions adopters can apply with one click.
 *
 * Four miners (v1):
 *   - mineResponseTime    : how fast top-quartile agents touch a new lead
 *   - mineTouchpointCadence: avg days between sphere touchpoints for
 *                            agents whose lifetime customers refer most
 *   - mineAiIsaLift       : conversion delta between contacts with
 *                            ai_isa_enabled vs without
 *   - mineDripEngagement  : sequence_enrollments completion → engagement
 *                            uplift
 *
 * All four are pure functions over Supabase queries — they read live
 * tenant data via the service client and emit results the cron will
 * persist to brokerage_intelligence_insights.
 *
 * Source-of-truth columns (audit-confirmed):
 *   - activities.created_at + agent_id + contact_id + channel
 *   - contacts.created_at + ai_isa_enabled + status + agent_id
 *   - transactions.status='closed' (linked via contact_id)
 *   - sequence_enrollments.enrolled_at + completed_at + agent_id + status
 *   - lifetime_customer_touchpoints.sent_date + agent_id + status
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

// ─── Types ────────────────────────────────────────────────────────────────

export interface MinerInsight {
  brokerageId:             string
  patternKey:              "response_time" | "touchpoint_cadence" | "ai_isa_lift" | "drip_engagement" | "negotiation_copilot_adoption" | "win_rate_by_offer_strength" | "appraisal_gap_outcomes"
  headline:                string
  metricLabel:             string
  topQuartileValue:        number | null
  medianValue:             number | null
  bottomQuartileValue:     number | null
  outcomeLabel:            string
  topQuartileOutcome:      number
  medianOutcome:           number
  bottomQuartileOutcome:   number
  liftPct:                 number
  sampleSize:              number
  supportingAgents:        string[]
  playbook:                string
  playbookActions:         Array<{ type: string; [k: string]: unknown }>
  severity:                "low" | "medium" | "high" | "critical"
}

interface MinerInput {
  brokerageId: string
  /** Lookback window in days. Default 180. */
  lookbackDays?: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function median(arr: number[]): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

function quartile(arr: number[], q: 0.25 | 0.75): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.floor(sorted.length * q)
  return sorted[idx] ?? 0
}

function liftPct(top: number, bottom: number): number {
  if (bottom <= 0) return top > 0 ? 100 : 0
  return Math.round(((top - bottom) / bottom) * 100)
}

function severityFromLift(lift: number): MinerInsight["severity"] {
  if (lift >= 200) return "critical"
  if (lift >= 100) return "high"
  if (lift >= 30)  return "medium"
  return "low"
}

// ─── Miner 1: Response time → conversion ─────────────────────────────────
//
// Question: how fast do top-quartile agents touch a new lead, and what's
// the conversion lift vs. bottom quartile?
//
// Method: for each (agent, contact) pair where contact was created in the
// lookback window AND has at least one activity, compute minutes-to-first-
// activity. Bucket agents by their median first-touch time. Top quartile
// = fastest-responding 25%. Conversion = contacts.status='lead' → eventual
// transaction with a closed status.

export async function mineResponseTime(input: MinerInput): Promise<MinerInsight | null> {
  const svc = createServiceClient()
  const lookbackDays = input.lookbackDays ?? 180
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString()

  const { data: contacts } = await svc
    .from("contacts")
    .select("id, agent_id, status, created_at")
    .eq("brokerage_id", input.brokerageId)
    .not("agent_id", "is", null)
    .gte("created_at", since)
    .limit(5000)

  const list = (contacts ?? []) as Array<{ id: string; agent_id: string; status: string | null; created_at: string }>
  if (list.length < 20) return null   // not enough signal

  // Pull first activity per contact (cheap: contact_id IN + ORDER BY)
  const contactIds = list.map((c) => c.id)
  const { data: activities } = await svc
    .from("activities")
    .select("contact_id, created_at")
    .in("contact_id", contactIds)
    .order("created_at", { ascending: true })

  const firstActivity = new Map<string, string>()
  for (const a of (activities ?? []) as Array<{ contact_id: string; created_at: string }>) {
    if (!firstActivity.has(a.contact_id)) firstActivity.set(a.contact_id, a.created_at)
  }

  // Per-agent rollup
  const perAgent = new Map<string, { minutes: number[]; converted: number; total: number }>()
  for (const c of list) {
    if (!c.agent_id) continue
    const firstAt = firstActivity.get(c.id)
    const stats = perAgent.get(c.agent_id) ?? { minutes: [], converted: 0, total: 0 }
    stats.total++
    if (firstAt) {
      const dt = (new Date(firstAt).getTime() - new Date(c.created_at).getTime()) / 60000
      if (dt >= 0) stats.minutes.push(dt)
    }
    // Define conversion: contact moved out of 'lead'/'prospect' to engaged
    if (c.status && !["lead", "prospect", "unqualified"].includes(c.status)) stats.converted++
    perAgent.set(c.agent_id, stats)
  }

  type AgentStat = { agentId: string; medianMinutes: number; conversionPct: number; total: number }
  const agentStats: AgentStat[] = []
  for (const [agentId, s] of perAgent.entries()) {
    if (s.minutes.length === 0 || s.total < 3) continue
    agentStats.push({
      agentId,
      medianMinutes: median(s.minutes),
      conversionPct: (s.converted / s.total) * 100,
      total: s.total,
    })
  }
  if (agentStats.length < 4) return null

  // Sort by responsiveness (lower is better); split into quartiles
  agentStats.sort((a, b) => a.medianMinutes - b.medianMinutes)
  const q = Math.max(1, Math.floor(agentStats.length / 4))
  const top = agentStats.slice(0, q)
  const bottom = agentStats.slice(-q)
  const topMedianMinutes = median(top.map((a) => a.medianMinutes))
  const bottomMedianMinutes = median(bottom.map((a) => a.medianMinutes))
  const topConversion = median(top.map((a) => a.conversionPct))
  const bottomConversion = median(bottom.map((a) => a.conversionPct))
  const lift = liftPct(topConversion, bottomConversion)

  if (lift < 15) return null   // pattern too weak to publish

  const topMinutesRounded = Math.round(topMedianMinutes)
  return {
    brokerageId:           input.brokerageId,
    patternKey:            "response_time",
    headline:              `Agents who touch new leads within ${topMinutesRounded} min convert ${Math.round(topConversion)}% — ${lift}% more than the rest`,
    metricLabel:           "Median minutes-to-first-touch",
    topQuartileValue:      topMedianMinutes,
    medianValue:           median(agentStats.map((a) => a.medianMinutes)),
    bottomQuartileValue:   bottomMedianMinutes,
    outcomeLabel:          "Lead → engaged contact %",
    topQuartileOutcome:    topConversion,
    medianOutcome:         median(agentStats.map((a) => a.conversionPct)),
    bottomQuartileOutcome: bottomConversion,
    liftPct:               lift,
    sampleSize:            list.length,
    supportingAgents:      top.map((a) => a.agentId),
    playbook:              `Set a first-touch SLA of ${Math.max(topMinutesRounded, 5)} minutes on every new lead. The top-quartile agents in your brokerage already hit it — and convert ${lift}% more leads as a result.`,
    playbookActions:       [
      { type: "first_touch_target_minutes", minutes: Math.max(topMinutesRounded, 5) },
      { type: "enable_ai_isa_on_new_leads" },
    ],
    severity:              severityFromLift(lift),
  }
}

// ─── Miner 2: AI ISA enablement lift ─────────────────────────────────────

export async function mineAiIsaLift(input: MinerInput): Promise<MinerInsight | null> {
  const svc = createServiceClient()
  const lookbackDays = input.lookbackDays ?? 180
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString()

  const { data: contacts } = await svc
    .from("contacts")
    .select("id, agent_id, ai_isa_enabled, status, created_at")
    .eq("brokerage_id", input.brokerageId)
    .gte("created_at", since)
    .limit(10000)

  const list = (contacts ?? []) as Array<{ id: string; agent_id: string | null; ai_isa_enabled: boolean | null; status: string | null }>
  const isaOn  = list.filter((c) => c.ai_isa_enabled === true)
  const isaOff = list.filter((c) => c.ai_isa_enabled !== true)
  if (isaOn.length < 10 || isaOff.length < 10) return null

  const convertedShare = (rows: typeof list): number =>
    rows.filter((c) => c.status && !["lead", "prospect", "unqualified"].includes(c.status)).length / Math.max(rows.length, 1) * 100

  const onConv = convertedShare(isaOn)
  const offConv = convertedShare(isaOff)
  const lift = liftPct(onConv, offConv)
  if (lift < 20) return null

  // Top-quartile agents = those who have ai_isa_enabled on > 50 % of their contacts
  const perAgent = new Map<string, { onCount: number; total: number }>()
  for (const c of list) {
    if (!c.agent_id) continue
    const s = perAgent.get(c.agent_id) ?? { onCount: 0, total: 0 }
    s.total++
    if (c.ai_isa_enabled) s.onCount++
    perAgent.set(c.agent_id, s)
  }
  const topAgents: string[] = []
  for (const [aid, s] of perAgent.entries()) {
    if (s.total >= 3 && s.onCount / s.total >= 0.5) topAgents.push(aid)
  }

  return {
    brokerageId:           input.brokerageId,
    patternKey:            "ai_isa_lift",
    headline:              `Contacts with AI ISA on convert ${Math.round(onConv)}% vs ${Math.round(offConv)}% off — ${lift}% lift`,
    metricLabel:           "% of contacts with AI ISA enabled",
    topQuartileValue:      100,
    medianValue:           50,
    bottomQuartileValue:   0,
    outcomeLabel:          "Lead → engaged contact %",
    topQuartileOutcome:    onConv,
    medianOutcome:         (onConv + offConv) / 2,
    bottomQuartileOutcome: offConv,
    liftPct:               lift,
    sampleSize:            list.length,
    supportingAgents:      topAgents,
    playbook:              `Auto-enable AI ISA on every new lead. Adopters in your brokerage see ${lift}% more engagement, with no extra agent time required.`,
    playbookActions:       [
      { type: "enable_ai_isa_on_new_leads" },
      { type: "enable_ai_isa_on_existing_leads" },
    ],
    severity:              severityFromLift(lift),
  }
}

// ─── Miner 3: Touchpoint cadence → close rate ────────────────────────────

export async function mineTouchpointCadence(input: MinerInput): Promise<MinerInsight | null> {
  const svc = createServiceClient()
  const lookbackDays = input.lookbackDays ?? 365
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10)

  const { data: tps } = await svc
    .from("lifetime_customer_touchpoints")
    .select("agent_id, contact_id, sent_date, status")
    .eq("brokerage_id", input.brokerageId)
    .gte("sent_date", since)
    .limit(20000)

  const list = (tps ?? []) as Array<{ agent_id: string | null; contact_id: string | null; sent_date: string | null; status: string | null }>
  if (list.length < 30) return null

  // Per-agent: avg days between completed touchpoints + total closed deals
  const perAgent = new Map<string, { dates: number[] }>()
  for (const t of list) {
    if (!t.agent_id || !t.sent_date) continue
    if (t.status !== "completed" && t.status !== "sent") continue
    const s = perAgent.get(t.agent_id) ?? { dates: [] }
    s.dates.push(new Date(t.sent_date).getTime())
    perAgent.set(t.agent_id, s)
  }

  // Closed transactions per agent in same window (proxy for "this cadence → deals")
  const { data: txns } = await svc
    .from("transactions")
    .select("agent_id, status, close_date")
    .eq("brokerage_id", input.brokerageId)
    .eq("status", "closed")
    .gte("close_date", since)

  const closedPerAgent = new Map<string, number>()
  for (const t of (txns ?? []) as Array<{ agent_id: string | null }>) {
    if (!t.agent_id) continue
    closedPerAgent.set(t.agent_id, (closedPerAgent.get(t.agent_id) ?? 0) + 1)
  }

  type AgentStat = { agentId: string; avgDaysBetween: number; closedCount: number; tpCount: number }
  const agentStats: AgentStat[] = []
  for (const [aid, s] of perAgent.entries()) {
    if (s.dates.length < 3) continue
    s.dates.sort((a, b) => a - b)
    const gaps: number[] = []
    for (let i = 1; i < s.dates.length; i++) {
      const a = s.dates[i] ?? 0
      const b = s.dates[i - 1] ?? 0
      gaps.push((a - b) / 86_400_000)
    }
    agentStats.push({
      agentId:        aid,
      avgDaysBetween: median(gaps),
      closedCount:    closedPerAgent.get(aid) ?? 0,
      tpCount:        s.dates.length,
    })
  }
  if (agentStats.length < 4) return null

  // Sort by close count (top-quartile = most-deal agents)
  agentStats.sort((a, b) => b.closedCount - a.closedCount)
  const q = Math.max(1, Math.floor(agentStats.length / 4))
  const top = agentStats.slice(0, q)
  const bottom = agentStats.slice(-q)
  const topCadence = median(top.map((a) => a.avgDaysBetween))
  const bottomCadence = median(bottom.map((a) => a.avgDaysBetween))
  const topCloses = median(top.map((a) => a.closedCount))
  const bottomCloses = median(bottom.map((a) => a.closedCount))
  const lift = liftPct(topCloses, bottomCloses)
  if (lift < 50) return null

  const cadenceRounded = Math.round(topCadence)
  return {
    brokerageId:           input.brokerageId,
    patternKey:            "touchpoint_cadence",
    headline:              `Agents touching their sphere every ${cadenceRounded} days close ${lift}% more deals than agents waiting longer`,
    metricLabel:           "Median days between lifetime-customer touchpoints",
    topQuartileValue:      topCadence,
    medianValue:           median(agentStats.map((a) => a.avgDaysBetween)),
    bottomQuartileValue:   bottomCadence,
    outcomeLabel:          "Closed transactions in window",
    topQuartileOutcome:    topCloses,
    medianOutcome:         median(agentStats.map((a) => a.closedCount)),
    bottomQuartileOutcome: bottomCloses,
    liftPct:               lift,
    sampleSize:            list.length,
    supportingAgents:      top.map((a) => a.agentId),
    playbook:              `Touch every lifetime customer at least every ${cadenceRounded} days. Your top-quartile agents close ${lift}% more deals with this cadence — and the NPV-ranked sphere panel tells you exactly who's due.`,
    playbookActions:       [
      { type: "set_sphere_cadence_days", days: cadenceRounded },
      { type: "enable_npv_due_alerts" },
    ],
    severity:              severityFromLift(lift),
  }
}

// ─── Miner 4: Drip enrollment → engagement ───────────────────────────────

export async function mineDripEngagement(input: MinerInput): Promise<MinerInsight | null> {
  const svc = createServiceClient()
  const lookbackDays = input.lookbackDays ?? 180
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString()

  const { data: enrollments } = await svc
    .from("sequence_enrollments")
    .select("contact_id, agent_id:enrolled_by, status, enrolled_at, completed_at")
    .eq("brokerage_id", input.brokerageId)
    .gte("enrolled_at", since)
    .limit(10000)

  const list = (enrollments ?? []) as Array<{ contact_id: string | null; agent_id: string | null; status: string; enrolled_at: string; completed_at: string | null }>
  if (list.length < 20) return null

  const enrolledContactIds = Array.from(new Set(list.map((e) => e.contact_id).filter(Boolean) as string[]))
  if (enrolledContactIds.length === 0) return null

  // Compare engagement_score: contacts in any drip vs contacts who weren't
  const { data: enrolledContacts } = await svc
    .from("contacts")
    .select("id, engagement_score")
    .in("id", enrolledContactIds)
    .eq("brokerage_id", input.brokerageId)

  const enrolledScores = ((enrolledContacts ?? []) as Array<{ engagement_score: number | null }>)
    .map((c) => Number(c.engagement_score ?? 0))
    .filter((n) => n > 0)

  // Sample non-enrolled contacts in the same brokerage
  const { data: nonEnrolled } = await svc
    .from("contacts")
    .select("id, engagement_score")
    .eq("brokerage_id", input.brokerageId)
    .not("id", "in", `(${enrolledContactIds.slice(0, 500).join(",")})`)
    .limit(500)

  const nonEnrolledScores = ((nonEnrolled ?? []) as Array<{ engagement_score: number | null }>)
    .map((c) => Number(c.engagement_score ?? 0))
    .filter((n) => n > 0)

  if (enrolledScores.length < 10 || nonEnrolledScores.length < 10) return null

  const enrolledMedian = median(enrolledScores)
  const nonEnrolledMedian = median(nonEnrolledScores)
  const lift = liftPct(enrolledMedian, nonEnrolledMedian)
  if (lift < 15) return null

  // Top-quartile agents = those enrolling the largest share of their contacts
  const perAgent = new Map<string, { enrolled: number }>()
  for (const e of list) {
    if (!e.agent_id) continue
    const s = perAgent.get(e.agent_id) ?? { enrolled: 0 }
    s.enrolled++
    perAgent.set(e.agent_id, s)
  }
  const agentStats = Array.from(perAgent.entries()).map(([id, s]) => ({ id, count: s.enrolled }))
  agentStats.sort((a, b) => b.count - a.count)
  const q = Math.max(1, Math.floor(agentStats.length / 4))
  const top = agentStats.slice(0, q)

  return {
    brokerageId:           input.brokerageId,
    patternKey:            "drip_engagement",
    headline:              `Drip-enrolled contacts have ${lift}% higher engagement scores`,
    metricLabel:           "Contact engagement score (0-100)",
    topQuartileValue:      enrolledMedian,
    medianValue:           (enrolledMedian + nonEnrolledMedian) / 2,
    bottomQuartileValue:   nonEnrolledMedian,
    outcomeLabel:          "Median engagement score",
    topQuartileOutcome:    enrolledMedian,
    medianOutcome:         (enrolledMedian + nonEnrolledMedian) / 2,
    bottomQuartileOutcome: nonEnrolledMedian,
    liftPct:               lift,
    sampleSize:            enrolledScores.length + nonEnrolledScores.length,
    supportingAgents:      top.map((a) => a.id),
    playbook:              `Auto-enroll every new contact in a nurture drip within 24 hours. Drip-enrolled contacts in your brokerage carry ${lift}% higher engagement scores — and engagement is the leading indicator of close rate.`,
    playbookActions:       [
      { type: "enroll_in_drip_within_24h", sequence_key: "new-lead-nurture" },
    ],
    severity:              severityFromLift(lift),
  }
}

// ─── Miner 5: Negotiation Co-Pilot adoption (Sprint 8 → Sprint 7 cross-wire)
//
// Question: which agents are skipping the persisted Co-Pilot strategy?
// Method: count strategy outcomes per agent over the last 60 days.
//   adoption_score = (accepted_by_agent + outcome_recorded) / total
// Top-quartile agents adopt strategies; bottom-quartile dismiss them.
// The output drives the `no_negotiation_copilot_use` gap_tag in Sprint 7,
// which surfaces a learning module to bottom-quartile agents.

export async function mineNegotiationCoPilotAdoption(input: MinerInput): Promise<MinerInsight | null> {
  const svc = createServiceClient()
  const lookbackDays = input.lookbackDays ?? 60
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString()

  const { data: strats } = await svc
    .from("negotiation_strategies")
    .select("agent_user_id, status, agent_disposition, outcome, created_at")
    .eq("brokerage_id", input.brokerageId)
    .gte("created_at", since)
    .not("agent_user_id", "is", null)

  const rows = (strats ?? []) as Array<{
    agent_user_id:     string
    status:            string
    agent_disposition: string | null
    outcome:           string | null
  }>
  if (rows.length < 10) return null

  // Per-agent rollup
  const perAgent = new Map<string, { total: number; adopted: number; dismissed: number; closed_wins: number }>()
  for (const r of rows) {
    const s = perAgent.get(r.agent_user_id) ?? { total: 0, adopted: 0, dismissed: 0, closed_wins: 0 }
    s.total += 1
    if (r.status === "accepted_by_agent" || r.status === "outcome_recorded") s.adopted += 1
    if (r.status === "dismissed" || r.agent_disposition === "dismissed")     s.dismissed += 1
    if (r.outcome === "accepted" || r.outcome === "closed")                  s.closed_wins += 1
    perAgent.set(r.agent_user_id, s)
  }

  type AgentStat = { agentId: string; adoptionPct: number; winPct: number; total: number }
  const agentStats: AgentStat[] = []
  for (const [agentId, s] of perAgent.entries()) {
    if (s.total < 2) continue   // need at least 2 strategies to score
    agentStats.push({
      agentId,
      adoptionPct: (s.adopted / s.total) * 100,
      winPct:      (s.closed_wins / s.total) * 100,
      total:       s.total,
    })
  }
  if (agentStats.length < 4) return null

  // Sort by adoption (higher is better); split into quartiles
  agentStats.sort((a, b) => b.adoptionPct - a.adoptionPct)
  const q = Math.max(1, Math.floor(agentStats.length / 4))
  const top    = agentStats.slice(0, q)
  const bottom = agentStats.slice(-q)
  const topAdoption    = median(top.map((a) => a.adoptionPct))
  const bottomAdoption = median(bottom.map((a) => a.adoptionPct))
  const topWins        = median(top.map((a) => a.winPct))
  const bottomWins     = median(bottom.map((a) => a.winPct))
  const lift           = liftPct(topWins, bottomWins)

  if (lift < 10) return null   // pattern too weak

  return {
    brokerageId:           input.brokerageId,
    patternKey:            "negotiation_copilot_adoption",
    headline:              `Agents who follow Co-Pilot strategy close ${Math.round(topWins)}% of negotiations — ${lift}% better than agents who dismiss`,
    metricLabel:           "Strategy adoption rate (%)",
    topQuartileValue:      topAdoption,
    medianValue:           median(agentStats.map((a) => a.adoptionPct)),
    bottomQuartileValue:   bottomAdoption,
    outcomeLabel:          "Negotiation close rate (%)",
    topQuartileOutcome:    topWins,
    medianOutcome:         median(agentStats.map((a) => a.winPct)),
    bottomQuartileOutcome: bottomWins,
    liftPct:               lift,
    sampleSize:            rows.length,
    supportingAgents:      top.map((a) => a.agentId),
    playbook:              `Open every Co-Pilot strategy in the action queue. Even when you disagree, the rationale signals (peer concession curves, your prior track record) are calibrated to your brokerage — not generic. Bottom-quartile agents dismiss without opening; top-quartile read first, then decide.`,
    playbookActions:       [
      { type: "review_open_strategies_daily" },
      { type: "set_disposition_within_24h" },
    ],
    severity:              severityFromLift(lift),
  }
}

// ─── Miner 6: Negotiation-Outcome Learner (term-level win/loss) ───────────
//
// THE STARVED CONSUMER: lib/negotiation/analyzer.ts already READS
// brokerage_intelligence_insights for `win_rate_by_offer_strength` +
// `appraisal_gap_outcomes` to ground its counter-strategy in this brokerage's real local
// outcomes — but nothing mined them (dead reads). This miner closes that loop: it learns,
// from the brokerage's OWN resolved offers, which terms correlate with WINNING, and feeds
// the negotiation copilot. PURE term math lives in offer-term-outcomes.ts (reusing the
// canonical scoreBuyerStrength); this function does the I/O + maps to MinerInsight. HONEST:
// only resolved offers count, and a pattern publishes only above the cohort/lift floors.

export async function mineOfferTermOutcomes(input: MinerInput): Promise<MinerInsight[]> {
  const svc = createServiceClient()
  const lookbackDays = input.lookbackDays ?? 365
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString()

  const { data: offers } = await svc
    .from("offers")
    .select("offer_price, financing_type, down_payment_percent, contingencies, earnest_money, appraisal_gap, status, is_winning_offer, created_at")
    .eq("brokerage_id", input.brokerageId)
    .gte("created_at", since)
    .limit(5000)

  const { mineOfferTermPatterns } = await import("./offer-term-outcomes")
  type Row = {
    offer_price: number | null; financing_type: string | null; down_payment_percent: number | null
    contingencies: unknown; earnest_money: number | null; appraisal_gap: number | null
    status: string | null; is_winning_offer: boolean | null
  }
  const WON = new Set(["accepted"])
  const LOST = new Set(["rejected", "withdrawn", "lost", "expired"])
  const resolved = ((offers ?? []) as Row[])
    .map((o) => {
      const won = o.is_winning_offer === true || (o.status != null && WON.has(o.status))
      const lost = !won && o.status != null && LOST.has(o.status)
      if (!won && !lost) return null // unresolved (pending/submitted/countered) — excluded
      const contingencies = Array.isArray(o.contingencies)
        ? (o.contingencies as unknown[]).map(String)
        : []
      return {
        offerPrice: Number(o.offer_price ?? 0),
        financingType: o.financing_type ?? null,
        downPaymentPercent: o.down_payment_percent != null ? Number(o.down_payment_percent) : null,
        contingencies,
        emd: o.earnest_money != null ? Number(o.earnest_money) : null,
        appraisalGap: o.appraisal_gap != null ? Number(o.appraisal_gap) : null,
        won,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  const patterns = mineOfferTermPatterns(resolved)
  return patterns.map((p) => ({
    brokerageId:           input.brokerageId,
    patternKey:            p.patternKey,
    headline:              p.summary,
    metricLabel:           "Offer win rate by terms (%)",
    topQuartileValue:      p.topCohort.winRatePct,
    medianValue:           Math.round((p.topCohort.winRatePct + p.bottomCohort.winRatePct) / 2),
    bottomQuartileValue:   p.bottomCohort.winRatePct,
    outcomeLabel:          "Offer acceptance rate (%)",
    topQuartileOutcome:    p.topCohort.winRatePct,
    medianOutcome:         Math.round((p.topCohort.winRatePct + p.bottomCohort.winRatePct) / 2),
    bottomQuartileOutcome: p.bottomCohort.winRatePct,
    liftPct:               p.liftPct,
    sampleSize:            p.sampleSize,
    supportingAgents:      [], // brokerage-market pattern, not an agent-level behavior
    playbook:              p.playbook,
    playbookActions:       [{ type: "open_negotiation_copilot" }],
    severity:              severityFromLift(p.liftPct),
  }))
}

// ─── Orchestrator: run all miners for one brokerage ──────────────────────

export async function mineAllPatterns(input: MinerInput): Promise<MinerInsight[]> {
  const results = await Promise.allSettled([
    mineResponseTime(input),
    mineAiIsaLift(input),
    mineTouchpointCadence(input),
    mineDripEngagement(input),
    mineNegotiationCoPilotAdoption(input),
    mineOfferTermOutcomes(input),
  ])
  const out: MinerInsight[] = []
  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value) continue
    if (Array.isArray(r.value)) out.push(...r.value)
    else out.push(r.value)
  }
  return out
}
