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
import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
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

// ─── Start session ───────────────────────────────────────────────────────────

export async function startObjectionPracticeSession(params: {
  scenarioKey: string
}): Promise<{ success: boolean; sessionId?: string; openingLine?: string; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.userId) {
    return { success: false, error: "Unauthorized" }
  }

  const scenario = getScenarioByKey(params.scenarioKey)
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

  const scenario = getScenarioByKey(session.scenario_key)
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

  const scenario = getScenarioByKey(session.scenario_key)
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
    const result = await generateText({
      model: resolveModel(`anthropic/${MODEL}` as Parameters<typeof resolveModel>[0]),
      system: systemPrompt,
      prompt: userPrompt,
      maxOutputTokens: 600,
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
    const result = await generateText({
      model: resolveModel(`anthropic/${MODEL}` as Parameters<typeof resolveModel>[0]),
      prompt,
      maxOutputTokens: 600,
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
