/**
 * app/api/ai/generate-sequence/route.ts
 *
 * POST — called by SequenceBuilderClient AI Generate modal.
 * Sends prompt to Anthropic claude via AI SDK.
 * Returns JSON array of step objects matching SequenceStep shape.
 *
 * Auth: user session required (server-side validation).
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { generateAIResponse } from "@/lib/ai"
import { getAgentContext } from "@/lib/identity/get-agent-context"

const SYSTEM_PROMPT = `You are a real estate ISA outreach expert. Generate a sequence of outreach steps as a JSON array.
Each item must have exactly these fields:
{
  "step_name": string,
  "channel": "email" | "sms" | "voice" | "in_app" | "direct_mail",
  "delay_days": number,
  "delay_hours": number,
  "send_time": string (HH:MM 24h format, e.g. "09:00"),
  "subject": string (only for email, otherwise null),
  "body": string,
  "personalization_tokens": string[]
}
Output ONLY a valid JSON array. No markdown. No explanation. No code fences. No extra text.
Use realistic real estate outreach content. Keep delay_days between 0 and 14. Max 10 steps.`

export async function POST(request: NextRequest) {
  // Auth check
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json()
  const { prompt } = body

  if (!prompt?.trim()) {
    return NextResponse.json({ error: "Prompt is required" }, { status: 400 })
  }
  // WAVE 155 (lane 155R19): ONE receipt (session user, SESSION tenant) for the draft; the spend stays on the AI cost ledger. A non-2xx answer settles it failed.
  const sessionCtx = await getAgentContext()
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const ledgered = await ledgerSessionAction({ brokerageId: sessionCtx.brokerageId ?? "", action: "sequence.steps.generate", actor: { type: "user", userId: user.id }, subject: { type: "user", id: user.id }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED" }, async () => { const res = await (async (): Promise<NextResponse> => {

  try {
    // Get actor context for governance
    const agentCtx = await getAgentContext()
    const actorContext = agentCtx
      ? { userId: agentCtx.userId, brokerageId: agentCtx.brokerageId }
      : undefined

    const response = await generateAIResponse({
      prompt: `${SYSTEM_PROMPT}\n\n${prompt.trim()}`,
      maxTokens: 4000,
      metadata: {
        userId: user.id,
        brokerageId: actorContext?.brokerageId,
        feature: "sequence_step_content",
      },
    })
    const text = response.text

    // Parse and validate JSON
    let steps: any[]
    try {
      steps = JSON.parse(text.trim())
    } catch {
      return NextResponse.json(
        { error: "AI returned invalid JSON. Try rephrasing your prompt." },
        { status: 422 }
      )
    }

    if (!Array.isArray(steps)) {
      return NextResponse.json({ error: "AI response was not an array" }, { status: 422 })
    }

    // Basic validation — keep only valid step objects
    const validated = steps
      .filter((s: any) => s && typeof s === "object" && typeof s.channel === "string")
      .slice(0, 10)

    return NextResponse.json({ steps: validated })
  } catch (err: any) {
    console.error("[generate-sequence] Error:", err?.message)
    return NextResponse.json(
      { error: err?.message ?? "AI generation failed" },
      { status: 500 }
    )
  }
  })(); return { success: res.ok, error: res.ok ? undefined : `HTTP ${res.status}`, res } })
  return "res" in ledgered ? ledgered.res : NextResponse.json({ error: ledgered.error ?? "Not recorded" }, { status: 500 })
}
