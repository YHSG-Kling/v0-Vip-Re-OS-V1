"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"

// All AI-identity profile actions are brokerage-admin tooling. Previously
// every read/write trusted caller-supplied scopeId / brokerageId / teamId
// and never verified caller auth. Any signed-in user could read or
// overwrite another brokerage's assistant identity (the system prompt
// applied to all customer-facing AI calls).
const SAVE_ROLES = ["admin", "super_admin", "superadmin", "broker", "broker_owner", "broker_admin", "team_lead", "team_leader", "agent"]

async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string; userType: string; teamId: string | null }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id, user_type, team_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return {
    ok: true,
    userId: user.id,
    brokerageId: u.brokerage_id,
    userType: u.user_type ?? "agent",
    teamId: u.team_id ?? null,
  }
}

export interface AIIdentityProfile {
  id: string
  scope_type: "brokerage" | "team" | "agent"
  scope_id: string
  brokerage_id: string
  assistant_name: string
  persona_label: string | null
  avatar_url: string | null
  elevenlabs_voice_id: string | null
  did_expressive_avatar_id: string | null
  tone: string | null
  formality_level: string | null
  objection_library: Array<{ objection: string; response: string; category: string }>
  faq_knowledge: Array<{ question: string; answer: string }>
  prohibited_language: string[]
  escalation_rules: Record<string, boolean>
  followup_style: string
  active: boolean
  parent_scope_id: string | null
  created_at: string
  updated_at: string
}

export type SaveAIIdentityInput = {
  scopeType: "brokerage" | "team" | "agent"
  scopeId: string
  brokerageId: string
  assistantName: string
  personaLabel: string
  /** Photo the assistant uses when it PRESENTS (report videos, avatar PIPs). */
  avatarUrl?: string | null
  /** The assistant's ElevenLabs voice (a curated preset from
   *  ASSISTANT_VOICE_OPTIONS, or a custom id) — phone + narration. */
  assistantVoiceId?: string | null
  /** D-ID V4 expressive avatar id ("@avt_") — the assistant presents report
   *  videos as a MOVING sentiment-aligned host when set. */
  assistantExpressiveAvatarId?: string | null
  tone: string | null
  formalityLevel: string | null
  objectionLibrary: Array<{ objection: string; response: string; category: string }>
  faqKnowledge: Array<{ question: string; answer: string }>
  prohibitedLanguage: string[]
  escalationRules: Record<string, boolean>
  followupStyle: string
  parentScopeId: string | null
  // Call handling — only set at brokerage scope; undefined means no change
  aiAnswerCalls?: boolean
  aiCallHandleInbound?: boolean
  aiCallHandleOutbound?: boolean
  aiCallForwardNumber?: string | null
  /** 'always' = AI owns every call; 'after_hours' = hour-aware reception. */
  aiAnswerMode?: "always" | "after_hours"
  businessHours?: { timezone?: string; start?: string; end?: string; days?: number[] } | null
}

export async function getAIIdentityProfile(
  scopeType: "brokerage" | "team" | "agent",
  scopeId: string
): Promise<{ data: AIIdentityProfile | null; error?: string }> {
  const auth = await requireCaller()
  if (!auth.ok) return { data: null, error: auth.error }

  try {
    const svc = createServiceClient()
    const { data, error } = await svc
      .from("ai_identity_profiles")
      .select("*")
      .eq("scope_type", scopeType)
      .eq("scope_id", scopeId)
      .maybeSingle()

    if (error) return { data: null, error: error.message }
    // Verify the profile belongs to caller's brokerage before returning
    if (data && (data as any).brokerage_id !== auth.brokerageId) {
      return { data: null, error: "Forbidden" }
    }
    return { data: data as AIIdentityProfile | null }
  } catch (err) {
    return { data: null, error: "Failed to load AI identity profile" }
  }
}

export async function getParentAIIdentityProfile(
  scopeType: "team" | "agent",
  _brokerageId?: string,  // ignored — derived from session
  teamId?: string | null
): Promise<{ data: AIIdentityProfile | null }> {
  const auth = await requireCaller()
  if (!auth.ok) return { data: null }

  try {
    const svc = createServiceClient()

    if (scopeType === "agent" && teamId) {
      // Agent: try team profile first, then brokerage. Team must belong to
      // caller's brokerage.
      const { data: teamProfile } = await svc
        .from("ai_identity_profiles")
        .select("*")
        .eq("scope_type", "team")
        .eq("scope_id", teamId)
        .eq("brokerage_id", auth.brokerageId)
        .maybeSingle()
      if (teamProfile) return { data: teamProfile as AIIdentityProfile }
    }

    // Brokerage profile — always the caller's brokerage
    const { data: brokProfile } = await svc
      .from("ai_identity_profiles")
      .select("*")
      .eq("scope_type", "brokerage")
      .eq("scope_id", auth.brokerageId)
      .maybeSingle()

    return { data: brokProfile as AIIdentityProfile | null }
  } catch {
    return { data: null }
  }
}

export async function saveAIIdentityProfile(
  input: SaveAIIdentityInput
): Promise<{ success: boolean; id?: string; error?: string; bindingNote?: string }> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  if (!SAVE_ROLES.includes(auth.userType)) {
    return { success: false, error: "Forbidden" }
  }

  // Verify scopeId belongs to caller's brokerage at the appropriate scope.
  // - brokerage scope: scopeId must equal caller's brokerage_id
  // - team scope: team must belong to caller's brokerage
  // - agent scope: agent must belong to caller's brokerage
  if (input.scopeType === "brokerage" && input.scopeId !== auth.brokerageId) {
    return { success: false, error: "Forbidden" }
  }
  if (input.scopeType === "team") {
    const svc = createServiceClient()
    const { data: team } = await svc.from("teams").select("brokerage_id").eq("id", input.scopeId).maybeSingle()
    if (!team || team.brokerage_id !== auth.brokerageId) {
      return { success: false, error: "Forbidden" }
    }
  }
  if (input.scopeType === "agent") {
    const svc = createServiceClient()
    const { data: agent } = await svc.from("agents").select("brokerage_id").eq("id", input.scopeId).maybeSingle()
    if (!agent || agent.brokerage_id !== auth.brokerageId) {
      return { success: false, error: "Forbidden" }
    }
  }

  try {
    const svc = createServiceClient()

    const { data, error } = await svc
      .from("ai_identity_profiles")
      .upsert(
        {
          scope_type: input.scopeType,
          scope_id: input.scopeId,
          brokerage_id: auth.brokerageId,  // always from session
          assistant_name: input.assistantName,
          persona_label: input.personaLabel || null,
          ...(input.avatarUrl !== undefined ? { avatar_url: input.avatarUrl } : {}),
          ...(input.assistantVoiceId !== undefined ? { elevenlabs_voice_id: input.assistantVoiceId } : {}),
          ...(input.assistantExpressiveAvatarId !== undefined ? { did_expressive_avatar_id: input.assistantExpressiveAvatarId } : {}),
          tone: input.tone || null,
          formality_level: input.formalityLevel || null,
          objection_library: input.objectionLibrary,
          faq_knowledge: input.faqKnowledge,
          prohibited_language: input.prohibitedLanguage,
          escalation_rules: input.escalationRules,
          followup_style: input.followupStyle,
          active: true,
          parent_scope_id: input.parentScopeId ?? null,
          // Call handling — only written when provided (brokerage upserts)
          ...(input.aiAnswerCalls !== undefined ? { ai_answer_calls: input.aiAnswerCalls } : {}),
          ...(input.aiCallHandleInbound !== undefined ? { ai_call_handle_inbound: input.aiCallHandleInbound } : {}),
          ...(input.aiCallHandleOutbound !== undefined ? { ai_call_handle_outbound: input.aiCallHandleOutbound } : {}),
          ...(input.aiCallForwardNumber !== undefined ? { ai_call_forward_number: input.aiCallForwardNumber } : {}),
          ...(input.aiAnswerMode !== undefined ? { ai_answer_mode: input.aiAnswerMode } : {}),
          ...(input.businessHours !== undefined ? { business_hours: input.businessHours } : {}),
        },
        { onConflict: "scope_type,scope_id" }
      )
      .select("id")
      .single()

    if (error) return { success: false, error: error.message }

    // THE TOGGLE MADE REAL: saving ai_answer_calls=ON now actually wires the
    // AI receptionist — assistant created/updated from this profile + the
    // scope's numbers imported into Vapi bound to the authoritative webhook.
    // Best-effort + honest: without VAPI creds the save succeeds and the
    // binding status says exactly why nothing was wired.
    let bindingNote: string | undefined
    if (input.aiAnswerCalls === true && data?.id) {
      try {
        const { applyInboundCallBinding } = await import("@/lib/voice/vapi-numbers")
        const b = await applyInboundCallBinding(svc, data.id)
        bindingNote = b.ok
          ? (b.applied ? `AI receptionist live — ${b.numbersBound ?? 0} number(s) bound to the assistant.` : undefined)
          : b.error
      } catch (e) {
        bindingNote = e instanceof Error ? e.message : "Inbound binding failed"
      }
    }

    // Revalidate relevant pages
    revalidatePath("/settings/admin/ai-identity")
    revalidatePath("/dashboard/team/ai-identity")
    revalidatePath("/dashboard/agent/ai-identity")

    return { success: true, id: data?.id, bindingNote }
  } catch (err) {
    return { success: false, error: "Failed to save AI identity profile" }
  }
}

export async function generateIdentityPreview(input: {
  assistantName: string
  personaLabel: string
  tone: string
  formalityLevel: string
}): Promise<{ success: boolean; preview?: string; error?: string }> {
  // Auth gate — preview burns paid AI inference
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  try {
    const { generateTextRouted } = await import("@/lib/ai/models")
    const prompt = `Generate a short (2-3 sentence) greeting from ${input.assistantName}, a ${input.personaLabel} for a real estate brokerage. Tone: ${input.tone}. Formality style: ${input.formalityLevel.replace("_", "-")}. Write only the greeting text, nothing else.`

    const { text } = await generateTextRouted({
      feature: "ai_isa_response",
      prompt,
      maxTokens: 400
    })

    return { success: true, preview: text }
  } catch (err) {
    return { success: false, error: "Preview generation failed — check AI configuration" }
  }
}

/** Generate the assistant HEADSHOT GALLERY (owner rule: real OPTIONS for the
 *  assistant's face) through the existing image-gen rail. Auth: any signed-in
 *  brokerage user (same bar as editing the identity). Best-effort per option. */
export async function generateAssistantFaceOptionsAction(): Promise<
  { success: true; options: Array<{ key: string; imageUrl: string }> } | { success: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthenticated" }
  try {
    const { generateAssistantFaceOptions } = await import("@/lib/video/assistant-options")
    const options = await generateAssistantFaceOptions(3)
    if (options.length === 0) return { success: false, error: "Image generation unavailable — add a photo URL instead" }
    return { success: true, options }
  } catch (e) {
    return { success: false, error: (e as Error).message }
  }
}

/** Hear a voice option before picking it — synthesizes ONE short sample line
 *  through the canonical ElevenLabs primitive (vendor budget gate riding) and
 *  returns a data URL the picker plays inline. Auth: signed-in user. */
export async function previewAssistantVoiceAction(voiceId: string): Promise<
  { success: true; audioDataUrl: string } | { success: false; error: string }
> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  if (!voiceId || voiceId.length > 64) return { success: false, error: "Invalid voice" }
  try {
    const { synthesizeSpeech } = await import("@/lib/voice/elevenlabs-tts")
    const tts = await synthesizeSpeech({
      text: "Hi, this is your AI assistant. I answer your calls, brief your mornings, and present your numbers.",
      voiceId, brokerageId: auth.brokerageId,
    })
    if (!tts.success || !tts.audioBuffer) return { success: false, error: tts.error ?? "Synthesis failed" }
    return { success: true, audioDataUrl: `data:audio/mpeg;base64,${tts.audioBuffer.toString("base64")}` }
  } catch (e) {
    return { success: false, error: (e as Error).message }
  }
}
