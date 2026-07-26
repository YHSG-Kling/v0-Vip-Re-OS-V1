"use server"

/**
 * Objection-training server actions.
 *
 * Three core actions:
 *   - startObjectionPracticeSession  : create a session row, return scenario + opening line
 *   - submitPracticeTurn             : agent responds → AI scores agent + generates next prospect line
 *   - endPracticeSession             : finalize session with overall score + summary + improvements
 *
 * Each agent turn is scored on the scenario's success criteria. The session
 * total feeds Smarter-this-week digest aggregations.
 */

import { resolveWriteContext } from "@/lib/kernel/identity"
import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { z } from "zod"
import { getScenarioByKey, OBJECTION_SCENARIOS } from "@/lib/training/objection-scenarios"
import type { ObjectionScenario } from "@/lib/training/objection-scenarios"

// OBJECTION_SCENARIOS + ObjectionScenario were re-exported here but "use server"
// rejects non-async exports. Consumers import them directly from
// "@/lib/training/objection-scenarios".

const MODEL = "claude-haiku-4-5-20251001"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PracticeSession {
  id: string
  scenarioKey: string
  scenarioLabel: string
  persona: string | null
  difficulty: "easy" | "medium" | "hard" | null
  status: "active" | "completed" | "abandoned"
  totalScore: number | null
  startedAt: string
  completedAt: string | null
  summary: string | null
  strengths: string[] | null
  improvements: string[] | null
}

export interface PracticeTurn {
  index: number
  speaker: "prospect" | "agent"
  text: string
  audioUrl: string | null
  turnScore: number | null
  feedback: string | null
}

// ─── Scenario resolution ─────────────────────────────────────────────────────

/**
 * Resolve the scenario definition for a session. Call-sourced scenarios (key
 * `call:<id>`) aren't in the static library, so we persist the full definition
 * in scenario_snapshot at start time and read it back here. Falls back to the
 * static library for older sessions / library scenarios without a snapshot.
 */
function scenarioFromSession(session: any): ObjectionScenario | undefined {
  const snap = session?.scenario_snapshot
  if (snap && typeof snap === "object" && snap.systemPrompt && Array.isArray(snap.successCriteria)) {
    return snap as ObjectionScenario
  }
  return getScenarioByKey(session?.scenario_key)
}

/** Validate + clamp a client-supplied (AI-generated) scenario before it drives an LLM role-play. */
function sanitizeClientScenario(raw: any): ObjectionScenario | null {
  if (!raw || typeof raw !== "object") return null
  const str = (v: any, max: number) => (typeof v === "string" ? v.slice(0, max) : "")
  const key = str(raw.key, 120)
  const openingLine = str(raw.openingLine, 1000)
  const systemPrompt = str(raw.systemPrompt, 4000)
  if (!key || !openingLine || !systemPrompt) return null
  const difficulty = ["easy", "medium", "hard"].includes(raw.difficulty) ? raw.difficulty : "medium"
  const category = ["listing", "buyer", "fsbo", "investor", "negotiation"].includes(raw.category) ? raw.category : "listing"
  const successCriteria = Array.isArray(raw.successCriteria)
    ? raw.successCriteria.filter((c: any) => typeof c === "string").slice(0, 6).map((c: string) => c.slice(0, 300))
    : []
  const sourceObjections = Array.isArray(raw.sourceObjections)
    ? raw.sourceObjections.filter((c: any) => typeof c === "string").slice(0, 10).map((c: string) => c.slice(0, 200))
    : undefined
  return {
    key,
    label: str(raw.label, 200) || "Call-sourced objection",
    category: category as ObjectionScenario["category"],
    persona: str(raw.persona, 400) || "Prospect from a recent call",
    difficulty: difficulty as ObjectionScenario["difficulty"],
    openingLine,
    systemPrompt,
    successCriteria: successCriteria.length ? successCriteria : ["Acknowledge the objection", "Lead with specific value", "Secure a clear next step"],
    source: "call",
    sourceObjections,
  }
}

// ─── Start session ───────────────────────────────────────────────────────────

export async function startObjectionPracticeSession(params: {
  scenarioKey: string
  /** Full scenario for AI-generated (call-sourced) scenarios not in the static library. */
  scenario?: ObjectionScenario
}): Promise<{ success: boolean; sessionId?: string; openingLine?: string; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.userId) {
    return { success: false, error: "Unauthorized" }
  }

  // Call-sourced scenarios arrive as a full definition (sanitized); library
  // scenarios resolve by key from the static catalog.
  const scenario = params.scenario ? sanitizeClientScenario(params.scenario) : getScenarioByKey(params.scenarioKey)
  if (!scenario) return { success: false, error: "Unknown scenario" }

  const svc = createServiceClient()
  const { data: session, error } = await svc
    .from("objection_training_sessions")
    .insert({
      agent_user_id: ctx.userId,
      brokerage_id: ctx.brokerageId,
      scenario_key: scenario.key,
      scenario_label: scenario.label,
      persona: scenario.persona,
      difficulty: scenario.difficulty,
      // Persist the full definition so submit/end can resolve call-sourced
      // scenarios that don't exist in the static library.
      scenario_snapshot: scenario,
      status: "active",
    })
    .select("id")
    .single()

  if (error || !session) {
    return { success: false, error: error?.message ?? "Failed to start session" }
  }

  // Insert the opening line as turn 0 (prospect's first line)
  await svc.from("objection_training_turns").insert({
    session_id: session.id,
    turn_index: 0,
    speaker: "prospect",
    text: scenario.openingLine,
  })

  return { success: true, sessionId: session.id, openingLine: scenario.openingLine }
}

// ─── Submit agent turn ───────────────────────────────────────────────────────

export async function submitPracticeTurn(params: {
  sessionId: string
  agentResponse: string
}): Promise<{
  success: boolean
  prospectReply?: string
  agentTurnScore?: number
  agentTurnFeedback?: string
  shouldEnd?: boolean
  error?: string
}> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.userId) {
    return { success: false, error: "Unauthorized" }
  }

  const svc = createServiceClient()

  // Load session + history
  const { data: session } = await svc
    .from("objection_training_sessions")
    .select("*")
    .eq("id", params.sessionId)
    .eq("agent_user_id", ctx.userId)
    .maybeSingle()

  if (!session) return { success: false, error: "Session not found" }
  if (session.status !== "active") return { success: false, error: "Session already ended" }

  const scenario = scenarioFromSession(session)
  if (!scenario) return { success: false, error: "Scenario disappeared" }

  const { data: priorTurns } = await svc
    .from("objection_training_turns")
    .select("turn_index, speaker, text")
    .eq("session_id", params.sessionId)
    .order("turn_index", { ascending: true })

  const turns = priorTurns ?? []
  const nextIndex = turns.length

  // Save the agent turn first (with placeholder score)
  await svc.from("objection_training_turns").insert({
    session_id: params.sessionId,
    turn_index: nextIndex,
    speaker: "agent",
    text: params.agentResponse,
  })

  // Build conversation transcript for AI
  const transcript = [
    ...turns.map((t) => `${t.speaker === "prospect" ? "PROSPECT" : "AGENT"}: ${t.text}`),
    `AGENT: ${params.agentResponse}`,
  ].join("\n")

  // Score the agent's response + generate prospect's next line
  const aiResult = await scoreAndContinue({ scenario, transcript })

  // Persist the score on the agent turn we just inserted
  await svc
    .from("objection_training_turns")
    .update({
      turn_score: aiResult.agentTurnScore,
      feedback: aiResult.agentTurnFeedback,
    })
    .eq("session_id", params.sessionId)
    .eq("turn_index", nextIndex)

  // Insert the prospect's reply as the next turn (or signal end)
  if (!aiResult.shouldEnd && aiResult.prospectReply) {
    await svc.from("objection_training_turns").insert({
      session_id: params.sessionId,
      turn_index: nextIndex + 1,
      speaker: "prospect",
      text: aiResult.prospectReply,
    })
  }

  return {
    success: true,
    prospectReply: aiResult.prospectReply,
    agentTurnScore: aiResult.agentTurnScore,
    agentTurnFeedback: aiResult.agentTurnFeedback,
    shouldEnd: aiResult.shouldEnd,
  }
}

// ─── End session ─────────────────────────────────────────────────────────────

export async function endPracticeSession(params: {
  sessionId: string
}): Promise<{
  success: boolean
  totalScore?: number
  summary?: string
  strengths?: string[]
  improvements?: string[]
  error?: string
}> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.userId) {
    return { success: false, error: "Unauthorized" }
  }

  const svc = createServiceClient()
  const { data: session } = await svc
    .from("objection_training_sessions")
    .select("*")
    .eq("id", params.sessionId)
    .eq("agent_user_id", ctx.userId)
    .maybeSingle()
  if (!session) return { success: false, error: "Session not found" }

  const scenario = scenarioFromSession(session)
  if (!scenario) return { success: false, error: "Scenario gone" }

  const { data: turns } = await svc
    .from("objection_training_turns")
    .select("turn_index, speaker, text, turn_score, feedback")
    .eq("session_id", params.sessionId)
    .order("turn_index", { ascending: true })

  const allTurns = turns ?? []
  const agentTurns = allTurns.filter((t) => t.speaker === "agent")
  const scoredTurns = agentTurns.filter((t) => t.turn_score != null)
  const avgScore = scoredTurns.length > 0
    ? scoredTurns.reduce((s, t) => s + Number(t.turn_score), 0) / scoredTurns.length
    : 0

  const finalEval = await finalizeSession({ scenario, turns: allTurns, averageScore: avgScore })

  await svc
    .from("objection_training_sessions")
    .update({
      status: "completed",
      total_score: avgScore,
      summary: finalEval.summary,
      strengths: finalEval.strengths,
      improvements: finalEval.improvements,
      completed_at: new Date().toISOString(),
    })
    .eq("id", params.sessionId)

  return {
    success: true,
    totalScore: avgScore,
    summary: finalEval.summary,
    strengths: finalEval.strengths,
    improvements: finalEval.improvements,
  }
}

// ─── List sessions ───────────────────────────────────────────────────────────

export async function listPracticeSessions(): Promise<PracticeSession[]> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.userId) return []

  const svc = createServiceClient()
  const { data } = await svc
    .from("objection_training_sessions")
    .select("*")
    .eq("agent_user_id", ctx.userId)
    .order("started_at", { ascending: false })
    .limit(50)

  return (data ?? []).map((s: any) => ({
    id: s.id,
    scenarioKey: s.scenario_key,
    scenarioLabel: s.scenario_label,
    persona: s.persona,
    difficulty: s.difficulty,
    status: s.status,
    totalScore: s.total_score,
    startedAt: s.started_at,
    completedAt: s.completed_at,
    summary: s.summary,
    strengths: s.strengths,
    improvements: s.improvements,
  }))
}

// ─── Generate scenarios from real calls ──────────────────────────────────────

const GeneratedScenarioSchema = z.object({
  label: z.string().describe("Short title for the scenario, e.g. 'Seller anchored on Zestimate'"),
  category: z.enum(["listing", "buyer", "fsbo", "investor", "negotiation"]),
  persona: z.string().describe("One line describing who the prospect is and their emotional state"),
  difficulty: z.enum(["easy", "medium", "hard"]),
  openingLine: z.string().describe("The prospect's opening objection line — 1-2 sentences, in their voice"),
  systemPrompt: z.string().describe("Instructions that shape the AI's behavior as this prospect throughout the role-play"),
  successCriteria: z.array(z.string()).min(2).max(5).describe("What the agent should accomplish to handle this objection well"),
})

/**
 * generateObjectionScenariosFromCalls
 *
 * Turns the agent's OWN real calls where an objection was handled poorly
 * (call_analyses.objections non-empty AND a low coaching_score) into practice
 * scenarios — so agents drill the objections THEY actually keep getting wrong,
 * grounded in the real transcript, instead of only the canned library.
 *
 * On-demand (an explicit agent action, LLM cost) and capped per run. Returns the
 * scenarios in-memory; starting a session persists the chosen one as a snapshot.
 */
export async function generateObjectionScenariosFromCalls(params?: {
  limit?: number
}): Promise<{ success: boolean; scenarios?: ObjectionScenario[]; message?: string; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.userId) return { success: false, error: "Unauthorized" }
  if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }

  const svc = createServiceClient()

  // Resolve the caller's agent id (calls are agent-scoped) — null for non-agents.
  const { data: agentRow } = await svc
    .from("agents")
    .select("id")
    .eq("user_id", ctx.userId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()
  const agentId = agentRow?.id ?? null

  // Analyzed calls that had objections AND a low coaching score (the objection
  // wasn't served well). Lowest coaching score first — the worst-handled calls.
  const { data: analyses } = await svc
    .from("call_analyses")
    .select("voice_call_id, objections, coaching_score, intent_primary, summary")
    .eq("brokerage_id", ctx.brokerageId)
    .not("objections", "is", null)
    .lte("coaching_score", 60)
    .order("coaching_score", { ascending: true })
    .limit(25)

  const withObjections = (analyses ?? []).filter(
    (a: any) => Array.isArray(a.objections) && a.objections.length > 0,
  )
  if (withObjections.length === 0) {
    return {
      success: true,
      scenarios: [],
      message: "No recent calls with mishandled objections found — your coaching scores are holding up. Practice a library scenario below.",
    }
  }

  // Pull transcripts for those calls, agent-scoped when we have an agent id.
  let vcQuery = svc
    .from("voice_calls")
    .select("id, transcription, direction, call_type, agent_id")
    .in("id", withObjections.map((a: any) => a.voice_call_id))
  if (agentId) vcQuery = vcQuery.eq("agent_id", agentId)
  const { data: calls } = await vcQuery
  const callMap = new Map((calls ?? []).map((c: any) => [c.id, c]))

  const eligible = withObjections
    .filter((a: any) => {
      const c = callMap.get(a.voice_call_id)
      return c && typeof c.transcription === "string" && c.transcription.trim().length > 40
    })
    .slice(0, Math.min(params?.limit ?? 3, 5))

  if (eligible.length === 0) {
    return {
      success: true,
      scenarios: [],
      message: "Found calls with objections, but none had a transcript long enough to build a scenario yet. Try again after your next few calls are analyzed.",
    }
  }

  const scenarios: ObjectionScenario[] = []
  for (const a of eligible) {
    const call = callMap.get(a.voice_call_id)
    const transcript = String(call.transcription).slice(0, 4000)
    const objections = (a.objections as string[]).slice(0, 6)
    try {
      const { object } = await generateObject({
        model: resolveModel("openai/gpt-4o-mini"),
        schema: GeneratedScenarioSchema,
        prompt: `A real estate agent had a call where these objections were raised and NOT handled well (low coaching score). Build a practice role-play scenario so the agent can rehearse this exact situation.

OBJECTIONS THE PROSPECT RAISED:
${objections.map((o, i) => `  ${i + 1}. ${o}`).join("\n")}

WHAT THE CALLER WANTED: ${a.intent_primary ?? "unknown"}
CALL SUMMARY: ${a.summary ?? "n/a"}

REAL CALL TRANSCRIPT (ground the prospect's voice and objection in this):
${transcript}

Produce a scenario where the AI role-plays THIS prospect raising THIS objection. The openingLine should be the prospect leading with their strongest objection in their own words. The systemPrompt should tell the AI to stay in character, push back on generic answers, and only soften for specific, value-led responses. successCriteria should be the concrete things the agent needed to do to handle this objection well. Keep it realistic to the transcript — do not invent facts not implied by it.`,
      })
      scenarios.push({
        key: `call:${a.voice_call_id}`,
        label: object.label,
        category: object.category,
        persona: object.persona,
        difficulty: object.difficulty,
        openingLine: object.openingLine,
        systemPrompt: object.systemPrompt,
        successCriteria: object.successCriteria,
        source: "call",
        sourceObjections: objections,
      })
    } catch {
      // Skip a call whose synthesis failed — never emit a partial scenario.
    }
  }

  if (scenarios.length === 0) {
    return { success: false, error: "Could not generate scenarios from your calls — please try again." }
  }
  return { success: true, scenarios }
}

// ─── AI helpers ──────────────────────────────────────────────────────────────

interface ScoreAndContinueResult {
  agentTurnScore: number
  agentTurnFeedback: string
  prospectReply?: string
  shouldEnd: boolean
}

async function scoreAndContinue(params: {
  scenario: ObjectionScenario
  transcript: string
}): Promise<ScoreAndContinueResult> {
  const systemPrompt = `You are scoring a real estate agent's objection-handling practice AND continuing the role-play as the prospect.

SCENARIO: ${params.scenario.label}
PROSPECT PERSONA: ${params.scenario.persona}
PROSPECT BEHAVIOR: ${params.scenario.systemPrompt}

SUCCESS CRITERIA the agent should hit across the conversation:
${params.scenario.successCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}

Return ONLY a JSON object:
{
  "agentTurnScore": <0-100 — how well the agent's LAST response did against the criteria>,
  "agentTurnFeedback": "<1-2 sentences of specific, actionable feedback on the agent's last response>",
  "prospectReply": "<the prospect's next line in character — 2-3 sentences>",
  "shouldEnd": <true if the agent has clearly succeeded OR the prospect would naturally end the call (FSBO hangup, walked away, agreed to next step). Otherwise false.>
}

Stay in character as the prospect. Don't break role in the prospectReply. Don't make scoring lenient — push the agent to actually meet the criteria.`

  const userPrompt = `Conversation so far:\n\n${params.transcript}\n\nScore the agent's last response and continue the conversation as the prospect.`

  try {
    // generateTextRouted: gateway + AI_TASK_ROUTING + auto-fallback + fair-use + cost log.
    // The constant `MODEL` is kept only for db logging — actual model is chosen by the routing table.
    const result = await generateTextRouted({
      feature:     "playbook_response",
      system:      systemPrompt,
      prompt:      userPrompt,
      maxTokens:   600,
      temperature: 0.7,
    })
    const cleaned = result.text.replace(/```json\n?|\n?```/g, "").trim()
    const parsed = JSON.parse(cleaned)
    return {
      agentTurnScore: clamp(Number(parsed.agentTurnScore ?? 50), 0, 100),
      agentTurnFeedback: String(parsed.agentTurnFeedback ?? ""),
      prospectReply: parsed.prospectReply,
      shouldEnd: Boolean(parsed.shouldEnd),
    }
  } catch {
    return {
      agentTurnScore: 50,
      agentTurnFeedback: "Could not generate AI evaluation — try again.",
      prospectReply: "Hmm, can you say more about that?",
      shouldEnd: false,
    }
  }
}

async function finalizeSession(params: {
  scenario: ObjectionScenario
  turns: Array<{ speaker: string; text: string; turn_score: number | null; feedback: string | null }>
  averageScore: number
}): Promise<{ summary: string; strengths: string[]; improvements: string[] }> {
  const transcript = params.turns
    .map((t) => `${t.speaker === "prospect" ? "PROSPECT" : "AGENT"}: ${t.text}${t.turn_score != null ? ` [score: ${t.turn_score}]` : ""}`)
    .join("\n")

  const prompt = `Practice scenario: ${params.scenario.label}
Average per-turn score: ${params.averageScore.toFixed(1)}/100

Success criteria:
${params.scenario.successCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}

Full transcript:
${transcript}

Return ONLY a JSON object with:
{
  "summary": "<3-4 sentence overall assessment of the agent's performance>",
  "strengths": ["<concrete strength>", ...],   // 2-4 items
  "improvements": ["<concrete improvement>", ...]   // 2-4 items
}`

  try {
    // generateTextRouted: gateway + AI_TASK_ROUTING + auto-fallback + fair-use + cost log.
    const result = await generateTextRouted({
      feature:     "playbook_response",
      prompt,
      maxTokens:   600,
      temperature: 0.3,
    })
    const cleaned = result.text.replace(/```json\n?|\n?```/g, "").trim()
    const parsed = JSON.parse(cleaned)
    return {
      summary: String(parsed.summary ?? ""),
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 4) : [],
      improvements: Array.isArray(parsed.improvements) ? parsed.improvements.slice(0, 4) : [],
    }
  } catch {
    return {
      summary: `Session completed with an average score of ${params.averageScore.toFixed(0)}/100.`,
      strengths: [],
      improvements: [],
    }
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}
