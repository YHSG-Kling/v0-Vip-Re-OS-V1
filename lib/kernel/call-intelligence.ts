// lib/kernel/call-intelligence.ts
// ─────────────────────────────────────────────────────────────────────────────
// CALL INTELLIGENCE SURFACED — every AI call already lands in call_analyses
// with objections, sentiment, urgency, and coaching scores… which nobody ever
// read. This folds a week of analyses into the coaching brief competitors sell
// as a separate product: what buyers objected to, how calls felt, where the
// urgent ones are — spoken into the Monday week-in-review. Pure fold + one
// read-only loader; numbers trace to rows, nothing invented, thin weeks say so.

export interface CallAnalysisRow {
  objections: string[] | null
  sentiment: string | null
  urgency_score: number | null
  coaching_score: number | null
  intent_primary: string | null
}

export interface CallIntelligence {
  callCount: number
  topObjections: Array<{ objection: string; count: number }>
  sentimentMix: { positive: number; neutral: number; negative: number }
  highUrgencyCount: number
  avgCoachingScore: number | null
  topIntent: string | null
}

const HIGH_URGENCY = 70

/** PURE: fold a period's call analyses into the coaching brief's numbers. */
export function rollupCallIntelligence(rows: CallAnalysisRow[]): CallIntelligence {
  const objectionCounts = new Map<string, number>()
  const sentimentMix = { positive: 0, neutral: 0, negative: 0 }
  const intentCounts = new Map<string, number>()
  let highUrgencyCount = 0
  const coaching: number[] = []

  for (const r of rows) {
    for (const o of r.objections ?? []) {
      const key = String(o).trim().toLowerCase()
      if (key) objectionCounts.set(key, (objectionCounts.get(key) ?? 0) + 1)
    }
    const s = (r.sentiment ?? "").toLowerCase()
    if (s.includes("pos")) sentimentMix.positive++
    else if (s.includes("neg")) sentimentMix.negative++
    else if (s) sentimentMix.neutral++
    if ((r.urgency_score ?? 0) >= HIGH_URGENCY) highUrgencyCount++
    if (r.coaching_score != null) coaching.push(Number(r.coaching_score))
    const intent = (r.intent_primary ?? "").trim()
    if (intent) intentCounts.set(intent, (intentCounts.get(intent) ?? 0) + 1)
  }

  const topObjections = [...objectionCounts.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([objection, count]) => ({ objection, count }))
  const topIntent = [...intentCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  return {
    callCount: rows.length,
    topObjections,
    sentimentMix,
    highUrgencyCount,
    avgCoachingScore: coaching.length ? coaching.reduce((a, b) => a + b, 0) / coaching.length : null,
    topIntent,
  }
}

/** PURE: the spoken coaching paragraph — plain sentences, honest with thin data. */
export function composeCallIntelBrief(intel: CallIntelligence): string {
  if (intel.callCount === 0) return ""
  const lines: string[] = [`Your AI reviewed ${intel.callCount} call${intel.callCount === 1 ? "" : "s"} this week.`]
  if (intel.topObjections.length > 0) {
    const top = intel.topObjections[0]
    lines.push(`The most common pushback was "${top.objection}"${top.count > 1 ? `, heard ${top.count} times` : ""} — worth a ready answer.`)
  }
  if (intel.highUrgencyCount > 0) {
    lines.push(`${intel.highUrgencyCount} call${intel.highUrgencyCount === 1 ? " was" : "s were"} high urgency — those callers are moving soon.`)
  }
  const { positive, negative } = intel.sentimentMix
  if (positive + negative > 0 && negative > positive) {
    lines.push("Call sentiment leaned negative this week — the transcripts will show where it turned.")
  }
  if (intel.callCount < 5) {
    lines.push("Small sample this week — patterns firm up as call volume grows.")
  }
  return lines.join(" ")
}

/** Load one agent's last-N-days call analyses (read-only, tenant-scoped). */
export async function loadCallIntelligence(
  svc: any, brokerageId: string, agentUserId: string, sinceDays = 7,
): Promise<CallIntelligence> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString()
  const { data } = await svc.from("call_analyses")
    .select("objections, sentiment, urgency_score, coaching_score, intent_primary")
    .eq("brokerage_id", brokerageId).eq("agent_id", agentUserId)
    .gte("created_at", since).limit(500)
  return rollupCallIntelligence((data ?? []) as CallAnalysisRow[])
}
