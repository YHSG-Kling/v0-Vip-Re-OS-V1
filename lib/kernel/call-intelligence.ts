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

// ── VOICE-LANE ACTIVITY — what the AI team DID on the phones this week ───────
// Distinct from the coaching rollup above (what it HEARD): this is the work
// report — calls answered, appointments booked live, outbound connects,
// voicemails left, opt-outs honored. Spoken in the Monday week-in-review so
// the voice AI's work is visible, never silent.

export interface VoiceActivity {
  inboundAnswered: number
  outboundConnected: number
  voicemailsLeft: number
  aiBookings: number
  optOutsHonored: number
}

/** PURE: fold ledger rows into the work report. */
export function rollupVoiceActivity(
  calls: Array<{ direction: string | null; call_type: string | null; status: string | null; outcome: string | null }>,
  aiBookings: number,
): VoiceActivity {
  let inboundAnswered = 0, outboundConnected = 0, voicemailsLeft = 0, optOutsHonored = 0
  for (const c of calls) {
    if ((c.outcome ?? "") === "opt_out") { optOutsHonored++; continue }
    if ((c.outcome ?? "") === "voicemail") { voicemailsLeft++; continue }
    if (c.direction === "inbound" && (c.status === "completed" || c.status === "in_progress")) inboundAnswered++
    else if (c.direction === "outbound" && c.status === "completed" && !["busy", "no_answer", "failed", "canceled"].includes(c.outcome ?? "")) outboundConnected++
  }
  return { inboundAnswered, outboundConnected, voicemailsLeft, aiBookings, optOutsHonored }
}

/** PURE: the spoken work-report sentence(s) — "" on a silent week (the brief
 *  never pads); opt-outs stated plainly (compliance is a feature, not a secret). */
export function composeVoiceActivityBrief(v: VoiceActivity): string {
  const total = v.inboundAnswered + v.outboundConnected + v.voicemailsLeft
  if (total === 0 && v.aiBookings === 0) return ""
  const parts: string[] = []
  if (v.inboundAnswered > 0) parts.push(`answered ${v.inboundAnswered} inbound call${v.inboundAnswered === 1 ? "" : "s"}`)
  if (v.outboundConnected > 0) parts.push(`reached ${v.outboundConnected} contact${v.outboundConnected === 1 ? "" : "s"} on follow-up calls`)
  if (v.voicemailsLeft > 0) parts.push(`left ${v.voicemailsLeft} voicemail${v.voicemailsLeft === 1 ? "" : "s"}`)
  const lines: string[] = []
  if (parts.length > 0) lines.push(`On the phones, your AI ${parts.join(", ")}.`)
  if (v.aiBookings > 0) lines.push(`It booked ${v.aiBookings} appointment${v.aiBookings === 1 ? "" : "s"} live on calls.`)
  if (v.optOutsHonored > 0) lines.push(`${v.optOutsHonored} caller${v.optOutsHonored === 1 ? "" : "s"} asked not to be called — honored and recorded immediately.`)
  return lines.join(" ")
}

/** Load one agent's last-N-days voice-lane activity (read-only). */
export async function loadVoiceActivity(
  svc: any, brokerageId: string, agentUserId: string, sinceDays = 7,
): Promise<VoiceActivity> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString()
  const { data: agent } = await svc.from("agents").select("id")
    .eq("user_id", agentUserId).eq("brokerage_id", brokerageId).maybeSingle()
  const agentRowId = (agent as any)?.id
  if (!agentRowId) return rollupVoiceActivity([], 0)
  const [{ data: calls }, { count: bookings }] = await Promise.all([
    svc.from("voice_calls").select("direction, call_type, status, outcome")
      .eq("brokerage_id", brokerageId).eq("agent_id", agentRowId)
      .gte("started_at", since).limit(1000),
    svc.from("showings").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("agent_id", agentRowId)
      .gte("created_at", since).ilike("notes", "%AI receptionist%"),
  ])
  return rollupVoiceActivity((calls ?? []) as any[], bookings ?? 0)
}
