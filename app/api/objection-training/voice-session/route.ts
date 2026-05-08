/**
 * POST /api/objection-training/voice-session
 *
 * Track C — start a live, voice-only objection-training session backed by
 * ElevenLabs Conversational AI.
 *
 * Flow:
 *   1. Auth (resolveWriteContext)
 *   2. Cap-check live_assistant_minutes (same metric as Track B)
 *   3. Resolve scenario from the in-code scenario library
 *   4. ensureScenarioAgent() — provision-or-reuse the prospect Conv AI agent
 *   5. Insert objection_training_sessions row (status='active')
 *   6. Insert turn 0 with the scenario opening line
 *   7. issueAssistantSession() to get a signed URL for the browser SDK
 *   8. Return { sessionId, signedUrl, openingLine, scenario }
 */

import "server-only"
import { type NextRequest, NextResponse } from "next/server"
import { resolveWriteContext } from "@/lib/kernel/identity"
import { createServiceClient } from "@/lib/supabase/service"
import { ensureScenarioAgent, issueAssistantSession } from "@/lib/elevenlabs/conv-ai"
import { checkUsageCap } from "@/lib/usage/check-cap"
import { logMediaUsage } from "@/lib/usage/log-media-usage"
import { getScenarioByKey } from "@/lib/training/objection-scenarios"

export const runtime = "nodejs"

interface Body {
  scenarioKey?: string
}

export async function POST(request: NextRequest) {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as Body
  if (!body.scenarioKey) return NextResponse.json({ error: "scenarioKey required" }, { status: 400 })

  const scenario = getScenarioByKey(body.scenarioKey)
  if (!scenario) return NextResponse.json({ error: "Unknown scenario" }, { status: 404 })

  const cap = await checkUsageCap({
    brokerageId: ctx.brokerageId,
    metric: "live_assistant_sessions",
    addQuantity: 1,
  })
  if (!cap.allowed) {
    return NextResponse.json(
      { error: cap.message ?? "Practice unavailable — plan limit reached." },
      { status: 429 },
    )
  }

  // Provision (or reuse) the scenario's roleplay agent.
  const ensured = await ensureScenarioAgent({
    scenarioKey: scenario.key,
    scenarioLabel: scenario.label,
    openingLine: scenario.openingLine,
    systemPrompt: scenario.systemPrompt,
  })
  if (!ensured.ok) return NextResponse.json({ error: ensured.error }, { status: 502 })

  const session = await issueAssistantSession({ convAiAgentId: ensured.convAiAgentId })
  if (!session.ok) return NextResponse.json({ error: session.error }, { status: 502 })

  const supabase = createServiceClient()

  // Create the practice session row + insert the opening prospect line.
  const { data: sessionRow, error: insertErr } = await supabase
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
  if (insertErr || !sessionRow) {
    return NextResponse.json({ error: insertErr?.message ?? "Failed to start session" }, { status: 500 })
  }

  await supabase.from("objection_training_turns").insert({
    session_id: sessionRow.id,
    turn_index: 0,
    speaker: "prospect",
    text: scenario.openingLine,
  })

  // Usage attribution — practice sessions burn the same allowance as on-the-go
  // assistant sessions. Same metric vocabulary + same cap.
  logMediaUsage({
    brokerageId: ctx.brokerageId,
    metric: "live_assistant_sessions",
    quantity: 1,
    agentId: ctx.agentId ?? null,
    userId: ctx.userId,
    sessionRef: sessionRow.id,
    feature: "objection_training",
    metadata: { scenario_key: scenario.key },
  }).catch(() => {})

  return NextResponse.json({
    sessionId: sessionRow.id,
    signedUrl: session.signedUrl,
    convAiAgentId: ensured.convAiAgentId,
    openingLine: scenario.openingLine,
    scenario: {
      key: scenario.key,
      label: scenario.label,
      persona: scenario.persona,
      difficulty: scenario.difficulty,
    },
    softWarning: cap.soft_warning ? cap.message : undefined,
  })
}
