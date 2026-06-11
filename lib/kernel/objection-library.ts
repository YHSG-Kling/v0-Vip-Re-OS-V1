// lib/kernel/objection-library.ts
//
// THE OBJECTION LIBRARY THAT LEARNS — sales intelligence that compounds off real
// conversations. Every AI ISA call logs a free-text outcome ("not interested", "too
// expensive", "using another agent", "just browsing", "bad timing"). This module turns
// that exhaust into a CATEGORIZED objection, tracks WHICH rebuttal (the script the AI
// used) actually booked an appointment, and feeds the WINNING rebuttal back to the team
// so the next call script gets better. No new table: it derives everything from the AI
// ISA call rows that already exist (ai_isa_calls.ai_response_summary = the objection,
// .script_used = the rebuttal tried, .appointment_set = the win signal).
//
// PURITY RULE (mirrors outcome-learning.ts): the value is two PURE functions —
//   · categorizeObjection(text)  free-text outcome → one of five canonical categories
//   · rankRebuttals(outcomes)    per-objection, which rebuttal books most, MIN-SAMPLE
//                                gated (like outcome-learning's MIN_DECISIONS / threshold)
// Then runObjectionLibrary aggregates a brokerage's recent calls into an
// objection→best-rebuttal map and proposes ONE agent-facing summary (real counts, no
// fabrication) into the governed gate. HUMAN-ONLY: only real call rows count; idempotent
// to one summary per brokerage per week.
//
// NOT server-only (simulator-driven, like the rest of the kernel loaders).

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** A rebuttal needs at least this many CATTEMPTS on an objection before it can be
 *  crowned the winner — a 1-for-1 fluke is not a strategy (cf. MIN_DECISIONS). */
export const MIN_REBUTTAL_ATTEMPTS = 5
/** An objection needs at least this many total calls before we report a "best" rebuttal
 *  for it — below this the sample is noise. */
export const MIN_OBJECTION_CALLS = 8
/** How many days of calls the library learns from. */
export const OBJECTION_WINDOW_DAYS = 30

/** The five canonical objections the AI ISA hears (plus a catch-all). */
export type ObjectionCategory =
  | "not_interested"
  | "too_expensive"
  | "using_another_agent"
  | "just_browsing"
  | "bad_timing"
  | "other"

/** Human-readable labels for the agent-facing summary. */
export const OBJECTION_LABELS: Record<ObjectionCategory, string> = {
  not_interested:      "not interested",
  too_expensive:       "too expensive / price",
  using_another_agent: "using another agent",
  just_browsing:       "just browsing",
  bad_timing:          "bad timing",
  other:               "other / uncategorized",
}

/** One raw AI ISA call outcome, as read off ai_isa_calls. */
export interface IsaCallOutcome {
  /** the free-text outcome / what the prospect said (ai_response_summary). */
  outcomeText: string | null
  /** the rebuttal/script the AI used on this call (script_used). */
  rebuttal: string | null
  /** did this call book an appointment? the positive outcome (appointment_set). */
  appointmentSet: boolean
}

/** One rebuttal's track record against a single objection. */
export interface RebuttalStat {
  rebuttal: string
  attempts: number
  booked: number
  successRate: number
}

/** The library's verdict for one objection category. */
export interface ObjectionVerdict {
  category: ObjectionCategory
  totalCalls: number
  booked: number
  /** ranked best-first; only rebuttals with ≥ MIN_REBUTTAL_ATTEMPTS are eligible to win. */
  rebuttals: RebuttalStat[]
  /** the winning rebuttal text, or null if no rebuttal cleared the min-sample gate. */
  bestRebuttal: string | null
  bestSuccessRate: number | null
}

// ── PURE LAYER ───────────────────────────────────────────────────────────────

/** Keyword → category rules, ordered by specificity (first match wins). Pure data. */
const RULES: Array<{ category: ObjectionCategory; patterns: RegExp }> = [
  // price first — "too expensive" should win over a generic "not interested" mention.
  { category: "too_expensive",       patterns: /\b(too\s+expensive|expensive|afford|price|pricing|cost(?:s|ly)?|commission|fee|cheaper|budget|money|costs?\s+too\s+much)\b/i },
  { category: "using_another_agent", patterns: /\b(another\s+agent|other\s+agent|already\s+(?:have|working|listed)|have\s+an?\s+agent|my\s+(?:realtor|agent|broker)|signed\s+with|under\s+contract\s+with\s+(?:a|an|another))\b/i },
  { category: "just_browsing",       patterns: /\b(just\s+(?:browsing|looking)|window\s+shopping|curious|not\s+(?:serious|ready\s+to\s+(?:buy|sell))|early\s+stage|tire[\s-]?kick)\b/i },
  { category: "bad_timing",          patterns: /\b(bad\s+timing|not\s+(?:a\s+good|the\s+right)\s+time|too\s+(?:soon|early)|next\s+(?:year|spring|season)|later|call\s+(?:me\s+)?back|wait(?:ing)?|maybe\s+(?:in|next)|busy\s+right\s+now)\b/i },
  { category: "not_interested",      patterns: /\b(not\s+interested|no\s+interest|don'?t\s+want|leave\s+me\s+alone|stop\s+calling|remove\s+me|do\s+not\s+call|no\s+thank)\b/i },
]

/**
 * PURE: map a free-text ISA call outcome to one canonical objection category.
 * Deterministic, keyword-driven, first-rule-wins; empty/unknown → "other".
 */
export function categorizeObjection(text: string | null | undefined): ObjectionCategory {
  const t = (text ?? "").trim()
  if (!t) return "other"
  for (const rule of RULES) {
    if (rule.patterns.test(t)) return rule.category
  }
  return "other"
}

/** Normalize a rebuttal/script string for grouping (trim + collapse whitespace). */
function normRebuttal(s: string | null | undefined): string | null {
  const v = (s ?? "").trim().replace(/\s+/g, " ")
  return v.length ? v : null
}

/**
 * PURE: given the brokerage's recent ISA call outcomes, build per-objection verdicts —
 * categorize each call, group rebuttals, compute each rebuttal's appointment-booking
 * rate, and crown the winner ONLY when:
 *   · the objection has ≥ MIN_OBJECTION_CALLS total calls (enough signal), AND
 *   · the winning rebuttal has ≥ MIN_REBUTTAL_ATTEMPTS attempts (not a fluke).
 * Ties broken by more attempts (more proven). No fabrication: counts come straight from
 * the rows.
 */
export function rankRebuttals(outcomes: IsaCallOutcome[]): Record<ObjectionCategory, ObjectionVerdict> {
  // accumulator keyed by category → rebuttal → { attempts, booked }
  const acc: Record<string, { total: number; booked: number; reb: Record<string, { attempts: number; booked: number }> }> = {}

  for (const o of outcomes) {
    const cat = categorizeObjection(o.outcomeText)
    const bucket = acc[cat] ?? { total: 0, booked: 0, reb: {} }
    bucket.total += 1
    if (o.appointmentSet) bucket.booked += 1
    const reb = normRebuttal(o.rebuttal)
    if (reb) {
      const r = bucket.reb[reb] ?? { attempts: 0, booked: 0 }
      r.attempts += 1
      if (o.appointmentSet) r.booked += 1
      bucket.reb[reb] = r
    }
    acc[cat] = bucket
  }

  const out = {} as Record<ObjectionCategory, ObjectionVerdict>
  for (const category of Object.keys(OBJECTION_LABELS) as ObjectionCategory[]) {
    const bucket = acc[category]
    if (!bucket) {
      out[category] = { category, totalCalls: 0, booked: 0, rebuttals: [], bestRebuttal: null, bestSuccessRate: null }
      continue
    }
    const rebuttals: RebuttalStat[] = Object.entries(bucket.reb)
      .map(([rebuttal, s]) => ({ rebuttal, attempts: s.attempts, booked: s.booked, successRate: s.attempts === 0 ? 0 : s.booked / s.attempts }))
      // rank: success rate desc, then attempts desc (more proven), then name for stability.
      .sort((a, b) => b.successRate - a.successRate || b.attempts - a.attempts || a.rebuttal.localeCompare(b.rebuttal))

    // crown the winner only past both gates.
    let bestRebuttal: string | null = null
    let bestSuccessRate: number | null = null
    if (bucket.total >= MIN_OBJECTION_CALLS) {
      const eligible = rebuttals.filter((r) => r.attempts >= MIN_REBUTTAL_ATTEMPTS)
      if (eligible.length > 0) {
        bestRebuttal = eligible[0].rebuttal
        bestSuccessRate = eligible[0].successRate
      }
    }
    out[category] = {
      category, totalCalls: bucket.total, booked: bucket.booked,
      rebuttals, bestRebuttal, bestSuccessRate,
    }
  }
  return out
}

/**
 * PURE: compose the agent-facing summary body from the verdicts. Internal data, so it's
 * plain text — but strictly fact-driven (real counts, real rates; no fabrication). Only
 * categories that cleared the gate AND have a winning rebuttal are reported as "what's
 * working"; everything else is reported as "still learning" with its raw counts.
 */
export function composeObjectionSummary(
  verdicts: Record<ObjectionCategory, ObjectionVerdict>,
): { subject: string; body: string; working: number } {
  const winners: string[] = []
  const learning: string[] = []
  for (const category of Object.keys(OBJECTION_LABELS) as ObjectionCategory[]) {
    if (category === "other") continue
    const v = verdicts[category]
    if (v.totalCalls === 0) continue
    const label = OBJECTION_LABELS[category]
    if (v.bestRebuttal && v.bestSuccessRate !== null) {
      const pct = Math.round(v.bestSuccessRate * 100)
      const snippet = v.bestRebuttal.length > 140 ? v.bestRebuttal.slice(0, 137) + "…" : v.bestRebuttal
      winners.push(`• For "${label}" (${v.totalCalls} calls, ${v.booked} booked): the rebuttal that books most (${pct}%) is — ${snippet}`)
    } else {
      learning.push(`• "${label}": ${v.totalCalls} calls, ${v.booked} booked — still gathering enough signal to crown a winning rebuttal.`)
    }
  }
  const parts: string[] = ["Here's what's working on the phones, learned from your real AI ISA calls this month:"]
  if (winners.length) parts.push(winners.join("\n"))
  else parts.push("No objection has cleared the min-sample bar yet — keep dialing and the library will name the winning rebuttals.")
  if (learning.length) parts.push("Still learning (not enough calls yet):\n" + learning.join("\n"))
  parts.push("Approve to fold the winning rebuttals into the next call script.")
  return {
    subject: `📞 Objection Library — ${winners.length} winning rebuttal${winners.length === 1 ? "" : "s"} identified`,
    body: parts.join("\n\n"),
    working: winners.length,
  }
}

// ── LIVE LAYER ───────────────────────────────────────────────────────────────

export interface ObjectionLibraryResult {
  callsAnalyzed: number
  objectionsCovered: number
  winningRebuttals: number
  summaryProposed: boolean
  verdicts: Record<ObjectionCategory, ObjectionVerdict>
}

/**
 * Aggregate a brokerage's recent AI ISA calls into an objection→best-rebuttal map and
 * propose ONE agent-facing summary into the governed gate (audience 'agent',
 * agentKind 'ai_isa'). Idempotent: one summary per brokerage per ISO week. Derives
 * everything from ai_isa_calls — no new table.
 */
export async function runObjectionLibrary(
  brokerageId: string,
  opts: { now?: Date; copyGenerator?: import("@/lib/kernel/ai-copy").CopyGenerator } = {},
  client?: Svc,
): Promise<ObjectionLibraryResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const result: ObjectionLibraryResult = {
    callsAnalyzed: 0, objectionsCovered: 0, winningRebuttals: 0, summaryProposed: false,
    verdicts: rankRebuttals([]),
  }

  const since = new Date(now.getTime() - OBJECTION_WINDOW_DAYS * 86_400_000).toISOString()
  const { data: calls } = await supabase.from("ai_isa_calls")
    .select("ai_response_summary, script_used, appointment_set")
    .eq("brokerage_id", brokerageId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(2000)

  const rows = (calls ?? []) as Array<{ ai_response_summary: string | null; script_used: string | null; appointment_set: boolean }>
  // HUMAN-ONLY signal: only count calls that actually logged an outcome (a real
  // conversation), not empty/system rows.
  const outcomes: IsaCallOutcome[] = rows
    .filter((r) => (r.ai_response_summary ?? "").trim().length > 0)
    .map((r) => ({ outcomeText: r.ai_response_summary, rebuttal: r.script_used, appointmentSet: !!r.appointment_set }))

  result.callsAnalyzed = outcomes.length
  if (outcomes.length === 0) return result

  const verdicts = rankRebuttals(outcomes)
  result.verdicts = verdicts
  result.objectionsCovered = (Object.keys(OBJECTION_LABELS) as ObjectionCategory[])
    .filter((c) => c !== "other" && verdicts[c].totalCalls > 0).length
  result.winningRebuttals = (Object.keys(OBJECTION_LABELS) as ObjectionCategory[])
    .filter((c) => verdicts[c].bestRebuttal !== null).length

  // IDEMPOTENT — one summary per brokerage per ISO week. The week tag lives in the
  // rationale so a re-run in the same week is a no-op.
  const weekTag = isoWeekTag(now)
  const { data: existing } = await supabase.from("agent_client_messages").select("id")
    .eq("brokerage_id", brokerageId).eq("agent_kind", "ai_isa")
    .ilike("rationale", `OBJECTION LIBRARY ${weekTag}%`).limit(1).maybeSingle()
  if (existing) return result

  const composed = composeObjectionSummary(verdicts)

  // NO HARDCODED CLIENT COPY — the summary is INTERNAL (audience 'agent'), so the plain
  // fact-driven body is canonical. But the value module still routes any client-facing
  // rebuttal wording through generatePersonaCopy with the composed body as the
  // deterministic fallback + an injectable seam, honoring the kernel's copy rule.
  const { generatePersonaCopy } = await import("@/lib/kernel/ai-copy")
  const facts = (Object.keys(OBJECTION_LABELS) as ObjectionCategory[])
    .filter((c) => c !== "other" && verdicts[c].bestRebuttal)
    .map((c) => `For "${OBJECTION_LABELS[c]}", the rebuttal booking ${Math.round((verdicts[c].bestSuccessRate ?? 0) * 100)}% is: ${verdicts[c].bestRebuttal}`)
  const body = facts.length
    ? (await generatePersonaCopy(
        { goal: "an internal note to the agent summarizing which call rebuttals are booking the most appointments",
          facts, channel: "portal",
          persona: { audience: "agent", situation: "reviewing AI ISA call performance" }, words: 110 },
        { body: composed.body }, { generator: opts.copyGenerator },
      )).body
    : composed.body

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const res = await proposeClientMessage({
    brokerageId, agentKind: "ai_isa", entityType: "brokerage",
    entityId: brokerageId, audience: "agent",
    subject: composed.subject,
    body,
    rationale: `OBJECTION LIBRARY ${weekTag} — ${result.callsAnalyzed} real AI ISA calls categorized into ${result.objectionsCovered} objections; ${result.winningRebuttals} winning rebuttal(s) (min-sample gated) proposed to feed the next call script.`,
    channel: "portal",
  }, supabase)
  result.summaryProposed = res.ok
  return result
}

/** ISO-week tag like "2026-W24" — the idempotency key for one summary per week. */
export function isoWeekTag(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = (date.getUTCDay() + 6) % 7 // Mon=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3) // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  const week = 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}
