// lib/kernel/intelligence-report.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE MONTHLY INTELLIGENCE REPORT — "your AI team got measurably better this
// month, here's proof." One owner-facing surface fusing the OS's closed
// learning loops, every number traced to a ledger the OS already keeps:
//
//   1. DRAFT QUALITY  — ai_message_drafts (the reply-coach flywheel: drafted /
//      accepted / sent-untouched / avg edit), month vs prior month. The SAME
//      counting rules as lib/kernel/draft-quality.ts (rollupDraftQuality is
//      reused, not re-implemented).
//   2. EARNED AUTONOMY — grants the broker's own approval history earned this
//      month (policy_decisions, target_type='autonomy_grant') + the grants in
//      force (managed_agents.config doc_kernel_grants / marketing_grants via
//      lib/documents/autonomy-ratchet.ts).
//   3. ATTRIBUTION — marketing_attribution_credits (the board packet's exact
//      counting rules: credit_dollars summed, distinct transactions).
//   4. ACTIVITY — the Command Center's ledgers for the month: inbound calls the
//      AI answered (voice_calls), appointments booked live (showings, AI
//      receptionist marker), drafts produced (ai_message_drafts), deals
//      advanced to contract (transactions.contract_date — the weekly-P&L
//      rule), inter-manager coordination signals raised (manager_signals).
//   5. TRUST — self_heal_events: best_effort_write losses trending DOWN is a
//      healthier ledger; breaks self-healed vs escalated.
//
// The composer is PURE. A section with no data this month is OMITTED — never
// zero-padded; young tenants get an honest empty report, not a wall of zeros.
// The board packet renders the SAME sections (one implementation, two
// surfaces): see lib/kernel/board-packet.ts.

import { rollupDraftQuality, type DraftQuality, type DraftRow } from "./draft-quality"
import { loadDocKernelGrants, loadMarketingGrants } from "@/lib/documents/autonomy-ratchet"

// ─── Month windows (pure) ────────────────────────────────────────────────────

export interface MonthWindow {
  /** "YYYY-MM" */
  key: string
  /** "March 2026" */
  label: string
  startIso: string
  /** Exclusive end (first instant of the next month). */
  endIso: string
}

/** PURE: the UTC month window for a "YYYY-MM" key. */
export function monthWindow(key: string): MonthWindow {
  const m = /^(\d{4})-(\d{2})$/.exec(key)
  if (!m) throw new Error(`intelligence-report: bad month key "${key}" (want YYYY-MM)`)
  const y = Number(m[1]), mo = Number(m[2])
  const start = new Date(Date.UTC(y, mo - 1, 1))
  const end = new Date(Date.UTC(y, mo, 1))
  return {
    key,
    label: start.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  }
}

/** PURE: the month key immediately before this one. */
export function priorMonthKey(key: string): string {
  const w = monthWindow(key)
  const start = new Date(w.startIso)
  const prior = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1))
  return `${prior.getUTCFullYear()}-${String(prior.getUTCMonth() + 1).padStart(2, "0")}`
}

/** PURE: the last N month keys, newest first (current month included). */
export function lastMonthKeys(n: number, now: Date = new Date()): string[] {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`)
  }
  return out
}

// ─── Facts (what the loader reads; what the composer folds) ─────────────────

export interface AttributionMonth {
  /** Attribution-weighted closed volume credited to AI marketing (cents). */
  attributedGciCents: number
  /** Distinct closed transactions carrying credits. */
  attributedDeals: number
}

export interface ActivityMonth {
  /** Inbound calls the AI answered (voice_calls). */
  callsAnswered: number
  /** Appointments booked live on AI calls (showings, receptionist marker). */
  appointmentsBooked: number
  /** Drafts the AI produced (all ai_message_drafts, not only accepted). */
  draftsProduced: number
  /** Deals that went under contract in the month (weekly-P&L counting rule). */
  dealsAdvanced: number
  /** Inter-manager coordination signals raised on the bus (manager_signals). */
  signalsRaised: number
}

export interface IntelligenceFacts {
  monthKey: string
  monthLabel: string
  priorMonthLabel: string
  drafts: { current: DraftQuality; prior: DraftQuality }
  autonomy: {
    /** Grant shapes the broker approved THIS month (policy ledger, timestamped). */
    grantedShapes: string[]
    /** Ratchet proposals the broker declined this month. */
    declined: number
    /** Every grant currently in force (doc kernel + marketing, from managed_agents.config). */
    totalGrants: string[]
  }
  attribution: { current: AttributionMonth; prior: AttributionMonth }
  activity: { current: ActivityMonth; prior: ActivityMonth }
  trust: {
    /** best_effort_write failures ledgered this month (fewer = healthier). */
    writeLosses: number
    /** …and the prior month, for the trend. */
    priorWriteLosses: number
    /** Breaks the OS healed itself this month (any domain). */
    healed: number
    /** Breaks routed to a human. */
    escalated: number
  }
}

// ─── Report shape ────────────────────────────────────────────────────────────

export type IntelligenceSectionId =
  | "draft_quality"
  | "earned_autonomy"
  | "attribution"
  | "activity"
  | "trust"

export interface ReportMetricLine {
  label: string
  value: string
  /** "↑ 4 vs last month" / "↓ 12% vs last month" — null when no prior baseline. */
  delta: string | null
}

export interface IntelligenceSection {
  id: IntelligenceSectionId
  title: string
  /** The one plain-language sentence an owner reads first. */
  headline: string
  lines: ReportMetricLine[]
}

export interface IntelligenceReport {
  monthKey: string
  monthLabel: string
  /** Only sections with real data this month — never zero-padded. */
  sections: IntelligenceSection[]
  /** True when NO loop produced data this month (young tenant / quiet month). */
  empty: boolean
}

// ─── Pure formatting helpers ─────────────────────────────────────────────────

const money = (cents: number) => {
  const v = Math.round(Math.max(0, cents) / 100)
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (v >= 10_000) return `$${Math.round(v / 1000).toLocaleString("en-US")}K`
  return `$${v.toLocaleString("en-US")}`
}

const plural = (n: number, s: string, p?: string) => (n === 1 ? s : (p ?? `${s}s`))

/** PURE: "↑ 4 vs last month" / "↓ 2" / null when prior is no baseline. */
export function countDelta(current: number, prior: number): string | null {
  if (prior === 0 && current === 0) return null
  if (prior === 0) return null // no baseline month — a delta would be invented
  const diff = current - prior
  if (diff === 0) return "even with last month"
  return `${diff > 0 ? "↑" : "↓"} ${Math.abs(diff)} vs last month`
}

/** PURE: approval rate 0-100, null when nothing was drafted. */
export function approvalRatePct(q: DraftQuality): number | null {
  if (q.drafted === 0) return null
  return Math.round((q.accepted / q.drafted) * 100)
}

/** PURE: plain-language name for a grant shape (mirrors the ratchet's routing). */
export function describeGrantShape(shape: string): string {
  const [mode, ...rest] = shape.split(":")
  const subject = rest.join(":").replace(/_/g, " ").trim() || "unknown"
  if (mode === "deadline_correction") return `correct the ${subject} deadline from scanned documents`
  if (mode === "deadline_propose") return `track the ${subject} deadline from scanned documents`
  if (mode === "social_post") return `publish ${subject} social posts`
  if (mode === "newsletter") return `send ${subject} newsletters`
  if (mode === "blog") return `publish ${subject} blog posts`
  return shape.replace(/[_:]/g, " ")
}

// ─── Section composers (each returns null when it has nothing earned) ────────

function composeDraftSection(f: IntelligenceFacts): IntelligenceSection | null {
  const { current, prior } = f.drafts
  if (current.drafted === 0) return null // no drafts this month — omitted, not zero-padded

  const rate = approvalRatePct(current)
  const priorRate = approvalRatePct(prior)
  let headline: string
  if (rate != null && priorRate != null) {
    headline = rate >= priorRate
      ? `Draft approval rate ${priorRate}%→${rate}% — your edits are teaching the team.`
      : `Draft approval rate ${priorRate}%→${rate}% — dipped this month; every edit you make trains the next batch.`
  } else {
    headline = `Your AI drafted ${current.drafted} ${plural(current.drafted, "reply", "replies")} this month — you sent ${current.accepted}${current.sentUntouched > 0 ? `, ${current.sentUntouched} untouched` : ""}.`
  }

  const lines: ReportMetricLine[] = [
    { label: "Drafts written", value: String(current.drafted), delta: countDelta(current.drafted, prior.drafted) },
    { label: "Drafts you sent", value: String(current.accepted), delta: countDelta(current.accepted, prior.accepted) },
    { label: "Sent untouched", value: String(current.sentUntouched), delta: countDelta(current.sentUntouched, prior.sentUntouched) },
  ]
  if (current.avgEditPct != null && current.accepted > 0) {
    lines.push({
      label: "Average edit before sending",
      value: `${current.avgEditPct}%`,
      delta: prior.avgEditPct != null && prior.avgEditPct !== current.avgEditPct
        ? `${current.avgEditPct < prior.avgEditPct ? "↓" : "↑"} from ${prior.avgEditPct}% last month`
        : null,
    })
  }
  return { id: "draft_quality", title: "Draft quality — the flywheel", headline, lines }
}

function composeAutonomySection(f: IntelligenceFacts): IntelligenceSection | null {
  const { grantedShapes, declined, totalGrants } = f.autonomy
  if (grantedShapes.length === 0 && totalGrants.length === 0) return null // nothing earned yet — omitted

  const headline = grantedShapes.length > 0
    ? `Your AI team earned ${grantedShapes.length} new autonomy ${plural(grantedShapes.length, "grant")} this month — ${totalGrants.length} ${plural(totalGrants.length, "move now runs", "moves now run")} without waiting on approval.`
    : `${totalGrants.length} earned-autonomy ${plural(totalGrants.length, "grant")} in force — every one earned by your own approval history, revocable any time.`

  const lines: ReportMetricLine[] = grantedShapes.map((s) => ({
    label: "Earned this month",
    value: describeGrantShape(s),
    delta: null,
  }))
  lines.push({ label: "Grants in force", value: String(totalGrants.length), delta: null })
  if (declined > 0) {
    lines.push({ label: "Proposals you declined", value: `${declined} — those moves stay human-approved`, delta: null })
  }
  return { id: "earned_autonomy", title: "Earned autonomy — the trust ladder", headline, lines }
}

function composeAttributionSection(f: IntelligenceFacts): IntelligenceSection | null {
  const { current, prior } = f.attribution
  if (current.attributedGciCents <= 0 && current.attributedDeals <= 0) return null

  const headline = `${money(current.attributedGciCents)} closed volume attributed to AI marketing across ${current.attributedDeals} ${plural(current.attributedDeals, "deal")} — measured by the attribution engine, not claimed.`
  const lines: ReportMetricLine[] = [
    {
      label: "Attributed closed volume",
      value: money(current.attributedGciCents),
      delta: prior.attributedGciCents > 0
        ? `${current.attributedGciCents >= prior.attributedGciCents ? "↑" : "↓"} from ${money(prior.attributedGciCents)} last month`
        : null,
    },
    { label: "Deals carrying attribution credits", value: String(current.attributedDeals), delta: countDelta(current.attributedDeals, prior.attributedDeals) },
  ]
  return { id: "attribution", title: "Marketing attribution — receipts", headline, lines }
}

function composeActivitySection(f: IntelligenceFacts): IntelligenceSection | null {
  const c = f.activity.current
  const p = f.activity.prior
  const total = c.callsAnswered + c.appointmentsBooked + c.draftsProduced + c.dealsAdvanced + c.signalsRaised
  if (total === 0) return null

  // Headline from the nonzero parts only — never narrate a zero.
  const parts: string[] = []
  if (c.dealsAdvanced > 0) parts.push(`${c.dealsAdvanced} ${plural(c.dealsAdvanced, "deal")} advanced to contract`)
  if (c.draftsProduced > 0) parts.push(`${c.draftsProduced} ${plural(c.draftsProduced, "draft")} produced`)
  if (c.callsAnswered > 0) parts.push(`${c.callsAnswered} ${plural(c.callsAnswered, "call")} answered${c.appointmentsBooked > 0 ? ` (${c.appointmentsBooked} booked live)` : ""}`)
  if (c.signalsRaised > 0) parts.push(`${c.signalsRaised} manager-to-manager ${plural(c.signalsRaised, "signal")}`)
  const headline = `The AI team's month: ${parts.join(" · ")}.`

  const lines: ReportMetricLine[] = []
  if (c.callsAnswered > 0 || p.callsAnswered > 0) lines.push({ label: "Inbound calls answered", value: String(c.callsAnswered), delta: countDelta(c.callsAnswered, p.callsAnswered) })
  if (c.appointmentsBooked > 0 || p.appointmentsBooked > 0) lines.push({ label: "Appointments booked live", value: String(c.appointmentsBooked), delta: countDelta(c.appointmentsBooked, p.appointmentsBooked) })
  if (c.draftsProduced > 0 || p.draftsProduced > 0) lines.push({ label: "Reply drafts produced", value: String(c.draftsProduced), delta: countDelta(c.draftsProduced, p.draftsProduced) })
  if (c.dealsAdvanced > 0 || p.dealsAdvanced > 0) lines.push({ label: "Deals advanced to contract", value: String(c.dealsAdvanced), delta: countDelta(c.dealsAdvanced, p.dealsAdvanced) })
  if (c.signalsRaised > 0 || p.signalsRaised > 0) lines.push({ label: "Coordination signals raised", value: String(c.signalsRaised), delta: countDelta(c.signalsRaised, p.signalsRaised) })
  return { id: "activity", title: "AI team activity — the work itself", headline, lines }
}

function composeTrustSection(f: IntelligenceFacts): IntelligenceSection | null {
  const t = f.trust
  // Trend-aware inclusion: a zero-loss month AFTER a lossy month IS data (the
  // ledger got healthier) — but all-quiet with no history is omitted.
  if (t.writeLosses === 0 && t.priorWriteLosses === 0 && t.healed === 0 && t.escalated === 0) return null

  let headline: string
  if (t.priorWriteLosses > 0 && t.writeLosses < t.priorWriteLosses) {
    headline = `Silent write losses ${t.priorWriteLosses}→${t.writeLosses} — the data rails got measurably healthier this month.`
  } else if (t.writeLosses === 0 && t.healed > 0) {
    headline = `${t.healed} ${plural(t.healed, "break")} self-healed this month with zero data losses.`
  } else if (t.writeLosses > 0) {
    headline = `${t.writeLosses} write ${plural(t.writeLosses, "loss", "losses")} caught on the ledger this month — named, not hidden; each one points at the exact rail to fix.`
  } else {
    headline = `${t.healed} ${plural(t.healed, "break")} self-healed, ${t.escalated} routed to a human — nothing dropped silently.`
  }

  const lines: ReportMetricLine[] = []
  if (t.healed > 0) lines.push({ label: "Breaks self-healed", value: String(t.healed), delta: null })
  if (t.escalated > 0) lines.push({ label: "Escalated to a human", value: String(t.escalated), delta: null })
  if (t.writeLosses > 0 || t.priorWriteLosses > 0) {
    lines.push({
      label: "Silent write losses (fewer is healthier)",
      value: String(t.writeLosses),
      delta: countDelta(t.writeLosses, t.priorWriteLosses),
    })
  }
  return { id: "trust", title: "Trust — the OS keeps receipts on itself", headline, lines }
}

/** PURE: fold the month's facts into the owner-facing report. Only earned
 *  sections render; empty months come back honest, never zero-padded. */
export function composeIntelligenceReport(facts: IntelligenceFacts): IntelligenceReport {
  const sections = [
    composeDraftSection(facts),
    composeAutonomySection(facts),
    composeAttributionSection(facts),
    composeActivitySection(facts),
    composeTrustSection(facts),
  ].filter((s): s is IntelligenceSection => s !== null)
  return { monthKey: facts.monthKey, monthLabel: facts.monthLabel, sections, empty: sections.length === 0 }
}

// ─── Loader (reads the real ledgers; no new tables, no invented numbers) ─────

export async function loadIntelligenceFacts(svc: any, brokerageId: string, monthKey: string): Promise<IntelligenceFacts> {
  const cur = monthWindow(monthKey)
  const pri = monthWindow(priorMonthKey(monthKey))
  const cnt = async (q: any) => ((await q) as any)?.count ?? 0

  const draftsIn = (w: MonthWindow) => svc.from("ai_message_drafts")
    .select("status, edit_delta, channel")
    .eq("brokerage_id", brokerageId)
    .gte("created_at", w.startIso).lt("created_at", w.endIso).limit(2000)
  const creditsIn = (w: MonthWindow) => svc.from("marketing_attribution_credits")
    .select("credit_dollars, transaction_id")
    .eq("brokerage_id", brokerageId)
    .gte("created_at", w.startIso).lt("created_at", w.endIso).limit(2000)
  const callsIn = (w: MonthWindow) => cnt(svc.from("voice_calls").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("direction", "inbound")
    .gte("started_at", w.startIso).lt("started_at", w.endIso))
  const bookingsIn = (w: MonthWindow) => cnt(svc.from("showings").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).ilike("notes", "%AI receptionist%")
    .gte("created_at", w.startIso).lt("created_at", w.endIso))
  const dealsIn = (w: MonthWindow) => cnt(svc.from("transactions").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId)
    .in("status", ["under_contract", "closing", "closed"])
    .gte("contract_date", w.startIso.slice(0, 10)).lt("contract_date", w.endIso.slice(0, 10)))
  const signalsIn = (w: MonthWindow) => cnt(svc.from("manager_signals").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId)
    .gte("created_at", w.startIso).lt("created_at", w.endIso))
  const lossesIn = (w: MonthWindow) => cnt(svc.from("self_heal_events").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("domain", "data_flow")
    .eq("action", "best_effort_write").eq("outcome", "failed")
    .gte("created_at", w.startIso).lt("created_at", w.endIso))
  const healOutcomeIn = (w: MonthWindow, outcome: string) => cnt(svc.from("self_heal_events").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("outcome", outcome)
    .neq("action", "best_effort_write")
    .gte("created_at", w.startIso).lt("created_at", w.endIso))

  const [
    draftRowsCur, draftRowsPri,
    creditRowsCur, creditRowsPri,
    callsCur, callsPri, bookingsCur, bookingsPri,
    dealsCur, dealsPri, signalsCur, signalsPri,
    lossesCur, lossesPri, healedCur, escalatedCur,
    grantDecisions, docGrants, mktGrants,
  ] = await Promise.all([
    draftsIn(cur), draftsIn(pri),
    creditsIn(cur), creditsIn(pri),
    callsIn(cur), callsIn(pri), bookingsIn(cur), bookingsIn(pri),
    dealsIn(cur), dealsIn(pri), signalsIn(cur), signalsIn(pri),
    lossesIn(cur), lossesIn(pri), healOutcomeIn(cur, "healed"), healOutcomeIn(cur, "escalated"),
    // The autonomy ratchet's own ledger writes: target_type='autonomy_grant',
    // recommended_action 'autonomy_granted' / 'autonomy_grant_declined'
    // (lib/documents/autonomy-ratchet.ts resolveAutonomyRatchetCore).
    svc.from("policy_decisions")
      .select("recommended_action, target_id")
      .eq("brokerage_id", brokerageId).eq("target_type", "autonomy_grant")
      .gte("created_at", cur.startIso).lt("created_at", cur.endIso).limit(500),
    loadDocKernelGrants(svc, brokerageId),
    loadMarketingGrants(svc, brokerageId),
  ])

  const toCredits = (res: any): AttributionMonth => {
    const rows = ((res as any)?.data ?? []) as Array<{ credit_dollars: number | null; transaction_id: string | null }>
    return {
      attributedGciCents: rows.reduce((a, c) => a + Math.round(Number(c.credit_dollars ?? 0) * 100), 0),
      attributedDeals: new Set(rows.map((c) => c.transaction_id).filter(Boolean)).size,
    }
  }
  const decisionRows = (((grantDecisions as any)?.data ?? []) as Array<{ recommended_action: string | null; target_id: string | null }>)
  const grantedShapes = [...new Set(decisionRows
    .filter((r) => r.recommended_action === "autonomy_granted" && r.target_id)
    .map((r) => String(r.target_id)))]
  const declined = decisionRows.filter((r) => r.recommended_action === "autonomy_grant_declined").length
  const totalGrants = [...new Set([...(docGrants as Set<string>), ...(mktGrants as Set<string>)])]

  const draftsCurQ = rollupDraftQuality((((draftRowsCur as any)?.data ?? []) as DraftRow[]))
  const draftsPriQ = rollupDraftQuality((((draftRowsPri as any)?.data ?? []) as DraftRow[]))

  return {
    monthKey: cur.key,
    monthLabel: cur.label,
    priorMonthLabel: pri.label,
    drafts: { current: draftsCurQ, prior: draftsPriQ },
    autonomy: { grantedShapes, declined, totalGrants },
    attribution: { current: toCredits(creditRowsCur), prior: toCredits(creditRowsPri) },
    activity: {
      current: { callsAnswered: callsCur, appointmentsBooked: bookingsCur, draftsProduced: draftsCurQ.drafted, dealsAdvanced: dealsCur, signalsRaised: signalsCur },
      prior: { callsAnswered: callsPri, appointmentsBooked: bookingsPri, draftsProduced: draftsPriQ.drafted, dealsAdvanced: dealsPri, signalsRaised: signalsPri },
    },
    trust: { writeLosses: lossesCur, priorWriteLosses: lossesPri, healed: healedCur, escalated: escalatedCur },
  }
}
