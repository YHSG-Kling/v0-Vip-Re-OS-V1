// lib/voice/call-analysis.ts
// ─────────────────────────────────────────────────────────────────────────────
// VOICE INTELLIGENCE ON EVERY LANE — the autonomous half of call analysis.
// The deep on-demand analyzer (app/actions/ai-voice-transcription.ts) exists
// for a human clicking "analyze" on one call, but it (a) requires a session,
// so no webhook/cron could run it, and (b) never fills the exact columns the
// intelligence loop READS (call_analyses.objections / urgency_score /
// coaching_score / intent_primary — rollupCallIntelligence's whole diet), so
// the Monday coaching brief was reading mostly-empty columns. This sweep
// closes the loop: every completed AI call with a transcript (Twilio inbound
// reception, outbound ISA, legacy Vapi — one ledger) gets ONE compact analysis
// writing precisely those columns, keyed by voice_calls.id (idempotent), on
// the hourly cron. agent_id carries the agent's USER id — the id the
// intelligence reader filters by.

import { z } from "zod"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"

export const VoiceIntelSchema = z.object({
  summary: z.string(),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  objections: z.array(z.string()).describe("Concerns or pushback the caller voiced, short phrases"),
  urgencyScore: z.number().min(0).max(100).describe("How soon this person intends to act (0=no timeline, 100=this week)"),
  coachingScore: z.number().min(0).max(100).describe("How well the conversation served the caller (clarity, next step secured)"),
  intentPrimary: z.string().describe("One phrase: what the caller wanted (e.g. book showing, price question, sell home, support)"),
  // SECOND INTENT + NEXT ACTION. Both columns were READ BY CODE AND WRITTEN BY
  // NOBODY (census 1b): app/dashboard/isa/page.tsx:227 selects
  // `intent_secondary` on every ISA call row and
  // app/dashboard/communications/handoffs/page.tsx:77 selects
  // `suggested_next_action` on every contact's calls — so the ISA console's
  // second-intent column and the handoff queue's "what to do next" both
  // rendered a dash on every row, which reads as "the AI had no suggestion"
  // rather than "nobody ever asked it for one". The extractor already reads the
  // whole transcript; asking for these two costs no extra call.
  intentSecondary: z.string().nullable().describe("A SECOND thing the caller wanted, one phrase, or null if the call had only one intent — do not restate the primary"),
  suggestedNextAction: z.string().describe("The single most useful thing the agent should do next, phrased as an instruction (e.g. 'Send the Maple St disclosure and call back Thursday')"),
  keyTopics: z.array(z.string()).max(6),
})

/** PURE: which ledger rows deserve analysis — completed, a real transcript
 *  (not just the greeting), not yet analyzed. */
export function isAnalyzableCall(row: { status?: string | null; transcription?: string | null }, alreadyAnalyzed: boolean): boolean {
  if (alreadyAnalyzed) return false
  if ((row.status ?? "") !== "completed") return false
  const t = (row.transcription ?? "").trim()
  // Needs at least one caller line — a greeting-only transcript has nothing to analyze.
  return t.length >= 80 && /(^|\n)Caller:/.test(t)
}

/** THE one conversation-intel extractor (schema + prompt single-sourced here).
 *  Every transcript lane — the voice sweep AND the Zoom transcript lane
 *  (lib/connections/zoom-transcripts.ts) — extracts through THIS function, so
 *  the insight vocabulary can never fork per channel. */
export async function extractVoiceIntel(
  transcription: string,
  direction: string | null,
): Promise<z.infer<typeof VoiceIntelSchema>> {
  const { generateObject } = await import("@/lib/ai/generate")
  const { object } = await generateObject({
    model: "openai/gpt-4o-mini",
    schema: VoiceIntelSchema,
    prompt: `Analyze this real-estate conversation (phone call or video meeting). Be factual — extract only what was actually said.

DIRECTION: ${direction ?? "unknown"}
TRANSCRIPT:
${transcription.slice(0, 12_000)}

Extract: a 2-sentence summary; overall caller sentiment; the caller's objections/concerns (short phrases, empty if none); urgency 0-100 (how soon they intend to act); a coaching score 0-100 (did the conversation serve the caller — clarity, questions answered, a next step secured); the caller's primary intent in one phrase; a SECOND intent in one phrase if the call genuinely had one, otherwise null; the single most useful next action for the agent, phrased as an instruction; up to 6 key topics.`,
  })
  return object
}

/** Analyze one voice_calls row and write the intelligence columns.
 *  `provenance` stamps call_analyses.analyzed_by — the hourly sweep uses the
 *  default; the Zoom transcript lane passes 'zoom_transcript'. */
export async function analyzeVoiceCallRow(svc: any, call: {
  id: string
  brokerage_id: string
  contact_id: string | null
  agent_id: string | null // agents.id on the ledger
  direction: string | null
  duration_seconds: number | null
  transcription: string
}, provenance: string = "voice_intel_sweep"): Promise<{ ok: boolean; error?: string; intel?: { urgencyScore: number; intentPrimary: string; summary: string } }> {
  try {
    // The intelligence reader (loadCallIntelligence) filters call_analyses by
    // the agent's USER id — resolve it from the ledger's agents.id.
    let agentUserId: string | null = null
    if (call.agent_id) {
      const { data: agent } = await svc.from("agents").select("user_id").eq("id", call.agent_id).maybeSingle()
      agentUserId = (agent as any)?.user_id ?? null
    }

    const object = await extractVoiceIntel(call.transcription, call.direction)

    const { data: analysisRow, error } = await svc.from("call_analyses").insert({
      voice_call_id: call.id,
      brokerage_id: call.brokerage_id,
      contact_id: call.contact_id,
      agent_id: call.agent_id, // call_analyses.agent_id FKs agents(id) — the ledger id, never users.id
      call_type: call.direction === "outbound" ? "outbound" : "inbound",
      call_duration: call.duration_seconds,
      transcript: call.transcription.slice(0, 20_000),
      summary: object.summary.slice(0, 2000),
      sentiment: object.sentiment,
      objections: object.objections.slice(0, 10),
      urgency_score: Math.round(object.urgencyScore),
      coaching_score: Math.round(object.coachingScore),
      intent_primary: object.intentPrimary.slice(0, 120),
      // The two columns the ISA console and the handoff queue read and nobody
      // wrote — see VoiceIntelSchema above. A single-intent call stores NULL
      // rather than a repeat of the primary: the console renders a dash for
      // "there was only one intent", which is true, where a duplicate would be
      // a fabricated second one.
      intent_secondary: (object.intentSecondary ?? "").trim() ? object.intentSecondary!.trim().slice(0, 120) : null,
      suggested_next_action: object.suggestedNextAction.slice(0, 600),
      key_topics: object.keyTopics,
      analyzed_at: new Date().toISOString(),
      analyzed_by: provenance,
    })
      // The row id is needed to hang the coaching insights off this analysis —
      // call_coaching_insights.call_analysis_id is NOT NULL.
      .select("id")
      .maybeSingle()
    if (error) return { ok: false, error: error.message }

    // COACHING WRITTEN WHERE THE FACT BECOMES KNOWN. call_coaching_insights had
    // six readers and no writer, so every coaching surface in the OS rendered
    // "nothing to improve" permanently. The projection is pure and grounded in
    // the analysis just written — see lib/voice/call-coaching.ts. Best-effort:
    // a coaching write that fails must not undo a stored analysis, but it is
    // never silent.
    const analysisId = (analysisRow as { id?: string } | null)?.id ?? null
    if (analysisId) {
      const { writeCallCoachingInsights } = await import("@/lib/voice/call-coaching")
      const coached = await writeCallCoachingInsights(svc, {
        callAnalysisId: analysisId,
        brokerageId: call.brokerage_id,
        agentId: call.agent_id, // agents.id — the class every coaching reader filters on
        facts: {
          objections: object.objections,
          coachingScore: Math.round(object.coachingScore),
          sentiment: object.sentiment,
          urgencyScore: Math.round(object.urgencyScore),
          suggestedNextAction: object.suggestedNextAction,
        },
      })
      if (coached.error) console.error("[voice-intel] coaching insights NOT written:", coached.error)
    }

    return { ok: true, intel: { urgencyScore: Math.round(object.urgencyScore), intentPrimary: object.intentPrimary, summary: object.summary } }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "analysis failed" }
  }
}

/** A call scoring at/above this urgency proposes a SAME-DAY human callback —
 *  the intelligence acting, not just reporting (gated; nothing auto-dials). */
export const URGENT_CALLBACK_THRESHOLD = 80

/** Propose ONE gated same-day callback for a hot call (deduped per call). */
async function proposeUrgentCallback(svc: any, call: {
  id: string; brokerage_id: string; contact_id: string | null; agent_id: string | null
}, intel: { urgencyScore: number; intentPrimary: string; summary: string }): Promise<boolean> {
  if (!call.contact_id) return false
  try {
    const tag = `[HOT_CALL] [${call.id}]`
    const { data: dup } = await svc.from("agent_client_messages").select("id")
      .ilike("rationale", `${tag}%`).limit(1).maybeSingle()
    if (dup) return false
    const { data: contact } = await svc.from("contacts").select("first_name, last_name").eq("id", call.contact_id).maybeSingle()
    const who = [((contact as any)?.first_name ?? "").trim(), ((contact as any)?.last_name ?? "").trim()].filter(Boolean).join(" ") || "This caller"
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const p = await proposeClientMessage({
      brokerageId: call.brokerage_id,
      agentKind: "ai_isa",
      entityType: "contact",
      entityId: call.contact_id,
      audience: "agent",
      subject: `Hot call — ${who} needs a same-day callback`,
      body: `${who} scored ${intel.urgencyScore}/100 urgency on a call today (${intel.intentPrimary}). ${intel.summary.slice(0, 200)} Approve and I'll queue the callback at the top of today's plan.`,
      rationale: `${tag} — urgency ${intel.urgencyScore} ≥ ${URGENT_CALLBACK_THRESHOLD}; the AI heard intent to act soon. Transcript is on the call record.`,
    }, svc)
    return (p as any)?.ok !== false
  } catch {
    return false
  }
}

/** SPOKEN CRITERIA → LIVING ALERT — a call where the buyer STATED search
 *  criteria ("3 bed under 650 in Mocksley") proposes ONE ready-to-approve
 *  property alert (is_active=false, source 'voice_conversation'). Gated:
 *  extraction must be high-confidence with at least this many distinct
 *  concrete signals (location+price, beds+location, …). The agent approves in
 *  /approvals — nothing self-activates. */
// UN-EXPORTED (§1.1, 2026-08-31, lane M4): the keyword claimed a public entry
// point no file used; the only reader is proposeSpokenCriteriaAlert below.
// Re-export WITH a proof if a simulator is ever written for this gate.
const SPOKEN_ALERT_MIN_SIGNALS = 2

async function proposeSpokenCriteriaAlert(svc: any, call: {
  id: string; brokerage_id: string; contact_id: string | null; agent_id: string | null; transcription: string
}): Promise<boolean> {
  if (!call.contact_id) return false // criteria without a buyer to alert are just chatter
  try {
    const { extractCriteriaFromTranscript, criteriaToAlertRow, describeCriteria, spokenAlertCallMarker, VOICE_PROPOSAL_MARKER } =
      await import("@/lib/buyer-search/conversation-criteria")

    const extraction = extractCriteriaFromTranscript(call.transcription)
    if (extraction.confidence !== "high" || extraction.signalCount < SPOKEN_ALERT_MIN_SIGNALS) return false

    // IDEMPOTENT: one proposal per source call — the call marker lives in
    // alert_name and survives approval, so a re-run can never double-propose.
    const marker = spokenAlertCallMarker(call.id)
    const { data: dup } = await svc.from("property_alerts").select("id")
      .eq("contact_id", call.contact_id).ilike("alert_name", `%${marker}%`).limit(1).maybeSingle()
    if (dup) return false

    // agent_user_id carries the agent's USER id (createPropertyAlert's shape) —
    // resolve from the ledger's agents.id.
    let agentUserId: string | null = null
    if (call.agent_id) {
      const { data: agent } = await svc.from("agents").select("user_id").eq("id", call.agent_id).maybeSingle()
      agentUserId = (agent as any)?.user_id ?? null
    }

    const row = criteriaToAlertRow(extraction.criteria, {
      contactId: call.contact_id,
      agentUserId,
      brokerageId: call.brokerage_id,
      alertName: `${describeCriteria(extraction.criteria)} ${marker}`,
    })
    // paused_reason carries the proposal state marker + the buyer's literal
    // words — the approval card shows them; approval clears the column.
    const heard = extraction.evidence.map((q) => `"${q}"`).join(" · ")
    return await sentinelWrite(svc, svc.from("property_alerts").insert({
      ...row,
      paused_reason: `${VOICE_PROPOSAL_MARKER} They said: ${heard}`.slice(0, 600),
    }), { table: "property_alerts", flow: "spoken_criteria_alert", brokerageId: call.brokerage_id })
  } catch {
    return false
  }
}

export interface VoiceIntelSweepResult { candidates: number; analyzed: number; skipped: number; errors: number; callbacksProposed: number; alertsProposed: number; followthroughActions: number; recapsProposed: number }

/** Hourly sweep: recent completed AI calls with transcripts, not yet analyzed
 *  (keyed by voice_call_id), newest first, capped per run (LLM cost control). */
export async function sweepVoiceCallIntelligence(svc: any, limit = 15): Promise<VoiceIntelSweepResult> {
  const r: VoiceIntelSweepResult = { candidates: 0, analyzed: 0, skipped: 0, errors: 0, callbacksProposed: 0, alertsProposed: 0, followthroughActions: 0, recapsProposed: 0 }
  const since = new Date(Date.now() - 48 * 3_600_000).toISOString()
  const { data: calls } = await svc.from("voice_calls")
    .select("id, brokerage_id, contact_id, agent_id, direction, call_type, started_at, duration_seconds, transcription, status")
    .eq("status", "completed").not("transcription", "is", null)
    .gte("started_at", since).order("started_at", { ascending: false }).limit(80)
  const rows = (calls ?? []) as any[]
  if (rows.length === 0) return r

  const { data: existing } = await svc.from("call_analyses")
    .select("voice_call_id").in("voice_call_id", rows.map((c) => c.id))
  const analyzedIds = new Set(((existing ?? []) as any[]).map((a) => a.voice_call_id))

  for (const call of rows) {
    if (r.analyzed >= limit) break
    r.candidates += 1
    if (!isAnalyzableCall(call, analyzedIds.has(call.id))) { r.skipped += 1; continue }
    const res = await analyzeVoiceCallRow(svc, call)
    if (res.ok) {
      r.analyzed += 1
      // THE INTELLIGENCE ACTS: a hot call (urgency ≥ threshold) proposes one
      // gated same-day callback on the proposal rail — nothing auto-dials.
      if (res.intel && res.intel.urgencyScore >= URGENT_CALLBACK_THRESHOLD) {
        if (await proposeUrgentCallback(svc, call, res.intel)) r.callbacksProposed += 1
      }
      // SPOKEN CRITERIA → LIVING ALERT: a linked contact who stated concrete
      // search criteria gets ONE proposed (inactive) property alert on the
      // approval rail — deduped per call, agent-approved before it ever runs.
      if (await proposeSpokenCriteriaAlert(svc, call)) r.alertsProposed += 1
      // MEETING-TO-ACTION LOOP (round 40): ONE consumer, TWO sources — the same
      // follow-through that fires when a Zoom transcript analysis completes also
      // picks up every phone-call analysis this sweep writes. Sell-first →
      // gated listing-side outreach, financing → gated pre-qual education,
      // stated timeline → follow-up at that horizon, objection → agent coaching
      // note. Proposals only (deduped per call); never a direct send.
      try {
        const { runMeetingFollowthroughForCall } = await import("@/lib/ai-isa/meeting-followthrough")
        const ft = await runMeetingFollowthroughForCall(svc, call.id)
        if (ft.ok) r.followthroughActions += ft.proposed + ft.scheduled
      } catch { /* best-effort — the analysis itself stands */ }
      // THE CLIENT MEETING RECAP (round 41): AFTER follow-through so "what
      // happens next" cites the real proposals. Only MEETING-length
      // conversations recap — composeMeetingRecap enforces the conservative
      // gate itself (zoom meetings always; a phone call ONLY when a calendar
      // appointment sits near the call time). Human-approved, portal-only,
      // deduped per call; never a direct send.
      try {
        const { composeMeetingRecap } = await import("@/lib/ai-isa/meeting-recap")
        const rc = await composeMeetingRecap(svc, call.id)
        if (rc.proposed) r.recapsProposed += 1
      } catch { /* best-effort — the analysis itself stands */ }
    } else r.errors += 1
  }
  return r
}
