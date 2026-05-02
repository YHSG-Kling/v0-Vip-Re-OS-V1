"use server"

import { generateAIResponse } from "@/lib/ai"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { getAgentContext } from "@/lib/identity"
import { createServiceClient } from "@/lib/supabase/service"

type StepType = "email" | "sms" | "voice_drop" | "ai_call" | "wait" | "direct_mail"

const TYPE_GUIDANCE: Record<Exclude<StepType, "wait">, string> = {
  email:
    "Write an email body. Keep it under 150 words. Lead with value for the recipient. End with one clear next step (link or reply). No subject line — caller already has one.",
  sms:
    "Write a text message. Strict 320-character limit. Conversational, no emojis unless context fits. Single clear ask. Include {{first_name}} if natural.",
  voice_drop:
    "Write a voicemail script. 25-35 seconds when read at conversational pace (~80 words). Warm, personal, mention agent name and one specific reason for the call.",
  ai_call:
    "Write a call script outline as 3-5 short bullet talking points. Each bullet is what the AI ISA should cover, not verbatim dialogue.",
  direct_mail:
    "Write postcard / letter copy. 3 sections: hook headline (under 8 words), body (2-3 sentences leading with value), call to action (one clear next step).",
}

const PERSONALIZATION_HINT = `Use these tokens where natural: {{first_name}}, {{last_name}}, {{agent_name}}.`

export async function composeSequenceStepCopy(params: {
  stepType: StepType
  goal: string
  audience?: string
  tone?: string
  /** Existing draft to refine; if provided, the model edits rather than starting fresh. */
  existingBody?: string
}): Promise<{
  success: boolean
  text?: string
  subject?: string | null
  violations?: string[]
  notes?: string[]
  error?: string
}> {
  if (params.stepType === "wait") {
    return { success: false, error: "Wait steps don't need copy." }
  }

  if (!params.goal?.trim()) {
    return { success: false, error: "Describe what this step should accomplish." }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Not authenticated." }
  }

  const guidance = TYPE_GUIDANCE[params.stepType]
  const audience = params.audience?.trim() || "lead or contact in the agent's pipeline"
  const tone = params.tone?.trim() || "friendly, professional, helpful — never pushy"

  const refineNote = params.existingBody?.trim()
    ? `\n\nExisting draft to refine (keep what works, fix what doesn't):\n"""\n${params.existingBody.trim()}\n"""`
    : ""

  const wantsSubject = params.stepType === "email"
  const subjectInstruction = wantsSubject
    ? '\n\nAlso return a subject line. Format the response as JSON: {"subject": "...", "body": "..."}. No prose outside the JSON.'
    : '\n\nReturn ONLY the body text. No labels, no headers, no commentary.'

  const prompt = `You are drafting a step in an automated outreach sequence for a real estate agent.

Goal of this step: ${params.goal.trim()}
Audience: ${audience}
Tone: ${tone}

${guidance}
${PERSONALIZATION_HINT}
${refineNote}${subjectInstruction}`

  try {
    const response = await generateAIResponse({
      prompt,
      temperature: 0.6,
      maxTokens: 600,
      metadata: {
        userId: ctx.userId ?? "",
        brokerageId: ctx.brokerageId,
        feature: "sequence_step_compose",
      },
    })

    let body = response.text.trim()
    let subject: string | null = null

    if (wantsSubject) {
      // Try to parse JSON; fall back to using whole text as body if parsing fails.
      try {
        const cleaned = body
          .replace(/^```(?:json)?/i, "")
          .replace(/```$/i, "")
          .trim()
        const parsed = JSON.parse(cleaned)
        if (typeof parsed?.subject === "string") subject = parsed.subject.trim()
        if (typeof parsed?.body === "string") body = parsed.body.trim()
      } catch {
        // leave body as-is, subject null
      }
    }

    // Run the brand-voice / fair-housing gate on the generated body.
    const brandResult = await applyBrandVoice({
      brokerageId: ctx.brokerageId,
      actorUserId: ctx.userId ?? undefined,
      actorRole: "agent",
      journeyType: "seller",
      persona: "default",
      messageType: params.stepType === "sms" ? "sms" : params.stepType === "email" ? "email" : "ai",
      content: body,
    })

    return {
      success: true,
      text: body,
      subject,
      violations: brandResult.violations,
      notes: brandResult.notes,
    }
  } catch (err: any) {
    return { success: false, error: err?.message ?? "Compose failed." }
  }
}

// ─── Pre-launch compliance check ─────────────────────────────────────────────
// Runs the brand-voice / fair-housing gate on every messaging step in a sequence
// before the agent activates it. Returns per-step violations + notes so the UI
// can surface them in a preview dialog.

export interface SequenceStepCheck {
  stepId: string
  stepNumber: number
  stepName: string
  channel: string
  violations: string[]
  notes: string[]
  empty: boolean
}

export async function precheckSequenceCompliance(sequenceId: string): Promise<{
  success: boolean
  blocked: boolean
  totalViolations: number
  checks: SequenceStepCheck[]
  error?: string
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, blocked: false, totalViolations: 0, checks: [], error: "Not authenticated." }
  }

  const service = createServiceClient()

  // Verify ownership of the sequence
  const { data: seq } = await service
    .from("campaign_sequences")
    .select("id, brokerage_id")
    .eq("id", sequenceId)
    .maybeSingle()
  if (!seq || seq.brokerage_id !== ctx.brokerageId) {
    return { success: false, blocked: false, totalViolations: 0, checks: [], error: "Sequence not found." }
  }

  const { data: stepRows, error } = await service
    .from("campaign_sequence_steps")
    .select("id, step_number, step_name, channel, body, subject")
    .eq("sequence_id", sequenceId)
    .order("step_number", { ascending: true })

  if (error) {
    return { success: false, blocked: false, totalViolations: 0, checks: [], error: error.message }
  }

  const messagingChannels = new Set(["email", "sms", "voice_drop", "ai_call", "direct_mail"])
  const checks: SequenceStepCheck[] = []
  let totalViolations = 0

  for (const row of stepRows ?? []) {
    const channel = row.channel ?? "email"
    if (!messagingChannels.has(channel)) {
      // wait/etc. — no copy to check
      continue
    }
    const body = (row.body ?? "").toString().trim()
    const subject = (row.subject ?? "").toString().trim()
    const empty = !body && !subject

    if (empty) {
      checks.push({
        stepId: row.id,
        stepNumber: row.step_number,
        stepName: row.step_name ?? channel,
        channel,
        violations: ["Step body is empty — recipients won't receive anything."],
        notes: [],
        empty: true,
      })
      totalViolations += 1
      continue
    }

    const result = await applyBrandVoice({
      brokerageId: ctx.brokerageId,
      actorUserId: ctx.userId ?? undefined,
      actorRole: "agent",
      journeyType: "seller",
      persona: "default",
      messageType: channel === "sms" ? "sms" : channel === "email" ? "email" : "ai",
      content: [subject, body].filter(Boolean).join("\n\n"),
    })

    checks.push({
      stepId: row.id,
      stepNumber: row.step_number,
      stepName: row.step_name ?? channel,
      channel,
      violations: result.violations,
      notes: result.notes,
      empty: false,
    })
    totalViolations += result.violations.length
  }

  return {
    success: true,
    blocked: totalViolations > 0,
    totalViolations,
    checks,
  }
}
