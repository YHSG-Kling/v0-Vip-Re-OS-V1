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

export const VoiceIntelSchema = z.object({
  summary: z.string(),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  objections: z.array(z.string()).describe("Concerns or pushback the caller voiced, short phrases"),
  urgencyScore: z.number().min(0).max(100).describe("How soon this person intends to act (0=no timeline, 100=this week)"),
  coachingScore: z.number().min(0).max(100).describe("How well the conversation served the caller (clarity, next step secured)"),
  intentPrimary: z.string().describe("One phrase: what the caller wanted (e.g. book showing, price question, sell home, support)"),
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

/** Analyze one voice_calls row and write the intelligence columns. */
export async function analyzeVoiceCallRow(svc: any, call: {
  id: string
  brokerage_id: string
  contact_id: string | null
  agent_id: string | null // agents.id on the ledger
  direction: string | null
  duration_seconds: number | null
  transcription: string
}): Promise<{ ok: boolean; error?: string }> {
  try {
    // The intelligence reader (loadCallIntelligence) filters call_analyses by
    // the agent's USER id — resolve it from the ledger's agents.id.
    let agentUserId: string | null = null
    if (call.agent_id) {
      const { data: agent } = await svc.from("agents").select("user_id").eq("id", call.agent_id).maybeSingle()
      agentUserId = (agent as any)?.user_id ?? null
    }

    const { generateObject } = await import("@/lib/ai/generate")
    const { object } = await generateObject({
      model: "openai/gpt-4o-mini",
      schema: VoiceIntelSchema,
      prompt: `Analyze this real-estate phone call between an AI assistant and a caller. Be factual — extract only what was actually said.

DIRECTION: ${call.direction ?? "unknown"}
TRANSCRIPT:
${call.transcription.slice(0, 12_000)}

Extract: a 2-sentence summary; overall caller sentiment; the caller's objections/concerns (short phrases, empty if none); urgency 0-100 (how soon they intend to act); a coaching score 0-100 (did the conversation serve the caller — clarity, questions answered, a next step secured); the caller's primary intent in one phrase; up to 6 key topics.`,
    })

    const { error } = await svc.from("call_analyses").insert({
      voice_call_id: call.id,
      brokerage_id: call.brokerage_id,
      contact_id: call.contact_id,
      agent_id: agentUserId,
      call_type: call.direction === "outbound" ? "outbound" : "inbound",
      call_duration: call.duration_seconds,
      transcript: call.transcription.slice(0, 20_000),
      summary: object.summary.slice(0, 2000),
      sentiment: object.sentiment,
      objections: object.objections.slice(0, 10),
      urgency_score: Math.round(object.urgencyScore),
      coaching_score: Math.round(object.coachingScore),
      intent_primary: object.intentPrimary.slice(0, 120),
      key_topics: object.keyTopics,
      analyzed_at: new Date().toISOString(),
      analyzed_by: "voice_intel_sweep",
    })
    if (error) return { ok: false, error: error.message }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "analysis failed" }
  }
}

export interface VoiceIntelSweepResult { candidates: number; analyzed: number; skipped: number; errors: number }

/** Hourly sweep: recent completed AI calls with transcripts, not yet analyzed
 *  (keyed by voice_call_id), newest first, capped per run (LLM cost control). */
export async function sweepVoiceCallIntelligence(svc: any, limit = 15): Promise<VoiceIntelSweepResult> {
  const r: VoiceIntelSweepResult = { candidates: 0, analyzed: 0, skipped: 0, errors: 0 }
  const since = new Date(Date.now() - 48 * 3_600_000).toISOString()
  const { data: calls } = await svc.from("voice_calls")
    .select("id, brokerage_id, contact_id, agent_id, direction, duration_seconds, transcription, status")
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
    if (res.ok) r.analyzed += 1
    else r.errors += 1
  }
  return r
}
