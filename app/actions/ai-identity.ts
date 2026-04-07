"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"

export interface AIIdentityProfile {
  id: string
  scope_type: "brokerage" | "team" | "agent"
  scope_id: string
  brokerage_id: string
  assistant_name: string
  persona_label: string | null
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
}

export async function getAIIdentityProfile(
  scopeType: "brokerage" | "team" | "agent",
  scopeId: string
): Promise<{ data: AIIdentityProfile | null; error?: string }> {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from("ai_identity_profiles")
      .select("*")
      .eq("scope_type", scopeType)
      .eq("scope_id", scopeId)
      .maybeSingle()

    if (error) return { data: null, error: error.message }
    return { data: data as AIIdentityProfile | null }
  } catch (err) {
    return { data: null, error: "Failed to load AI identity profile" }
  }
}

export async function getParentAIIdentityProfile(
  scopeType: "team" | "agent",
  brokerageId: string,
  teamId?: string | null
): Promise<{ data: AIIdentityProfile | null }> {
  try {
    const supabase = await createClient()

    if (scopeType === "agent" && teamId) {
      // Agent: try team profile first, then brokerage
      const { data: teamProfile } = await supabase
        .from("ai_identity_profiles")
        .select("*")
        .eq("scope_type", "team")
        .eq("scope_id", teamId)
        .maybeSingle()
      if (teamProfile) return { data: teamProfile as AIIdentityProfile }
    }

    // Fall back to brokerage profile
    const { data: brokProfile } = await supabase
      .from("ai_identity_profiles")
      .select("*")
      .eq("scope_type", "brokerage")
      .eq("scope_id", brokerageId)
      .maybeSingle()

    return { data: brokProfile as AIIdentityProfile | null }
  } catch {
    return { data: null }
  }
}

export async function saveAIIdentityProfile(
  input: SaveAIIdentityInput
): Promise<{ success: boolean; id?: string; error?: string }> {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("ai_identity_profiles")
      .upsert(
        {
          scope_type: input.scopeType,
          scope_id: input.scopeId,
          brokerage_id: input.brokerageId,
          assistant_name: input.assistantName,
          persona_label: input.personaLabel || null,
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
        },
        { onConflict: "scope_type,scope_id" }
      )
      .select("id")
      .single()

    if (error) return { success: false, error: error.message }

    // Revalidate relevant pages
    revalidatePath("/settings/admin/ai-identity")
    revalidatePath("/dashboard/team/ai-identity")
    revalidatePath("/dashboard/agent/ai-identity")

    return { success: true, id: data?.id }
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
  try {
    const { generateTextRouted } = await import("@/lib/ai/models")
    const prompt = `Generate a short (2-3 sentence) greeting from ${input.assistantName}, a ${input.personaLabel} for a real estate brokerage. Tone: ${input.tone}. Formality style: ${input.formalityLevel.replace("_", "-")}. Write only the greeting text, nothing else.`

    const { text } = await generateTextRouted({
      feature: "ai_isa_response",
      prompt,
      maxTokens: 120,
    })

    return { success: true, preview: text }
  } catch (err) {
    return { success: false, error: "Preview generation failed — check AI configuration" }
  }
}
