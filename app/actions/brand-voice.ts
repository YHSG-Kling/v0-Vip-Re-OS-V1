"use server"

/**
 * app/actions/brand-voice.ts
 * CRUD actions for brand_voice_profile.
 * Agents manage their own profile; brokers/admins can manage brokerage-level profiles.
 */

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"

export interface BrandVoiceProfile {
  id:                  string
  brokerage_id:        string | null
  agent_id:            string | null
  team_id:             string | null
  tone:                string | null
  formality_level:     string | null
  key_brand_messages:  string[] | null
  prohibited_words:    string[] | null
  preferred_words:     string[] | null
  tagline:             string | null
  mission_statement:   string | null
  custom_instructions: string | null
  is_active:           boolean | null
  created_at:          string | null
  updated_at:          string | null
}

export interface BrandVoiceUpsertInput {
  tone?:                string
  formality_level?:     string
  key_brand_messages?:  string[]
  prohibited_words?:    string[]
  preferred_words?:     string[]
  tagline?:             string
  mission_statement?:   string
  custom_instructions?: string
}

// Roles permitted to read/write brand voice profiles
const BRAND_VOICE_ALLOWED_ROLES = ["agent", "broker", "admin", "superadmin"]

// ── Load the caller's brand voice profile ────────────────────────────────────

export async function loadBrandVoiceProfileAction(): Promise<{
  success: boolean
  profile?: BrandVoiceProfile | null
  error?: string
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { success: false, error: "Unauthorized" }
  if (!BRAND_VOICE_ALLOWED_ROLES.includes(ctx.userType)) {
    return { success: false, error: "Forbidden: insufficient role" }
  }
  if (ctx.userType === "agent" && !ctx.agentId) {
    return { success: false, error: "Agent profile not found" }
  }

  const supabase = await createClient()

  let query = supabase
    .from("brand_voice_profile")
    .select("*")
    .eq("is_active", true)

  if (ctx.userType === "agent") {
    // Agents: fetch their own profile by agent_id
    query = query.eq("agent_id", ctx.agentId)
  } else {
    // Brokers / admins: fetch the brokerage-level profile (no agent_id set)
    if (!ctx.brokerageId) return { success: false, error: "Brokerage not found" }
    query = query.eq("brokerage_id", ctx.brokerageId).is("agent_id", null)
  }

  const { data, error } = await query.maybeSingle()

  if (error) return { success: false, error: error.message }
  return { success: true, profile: data }
}

// ── Upsert (create or update) the caller's brand voice profile ───────────────

export async function saveBrandVoiceProfileAction(input: BrandVoiceUpsertInput): Promise<{
  success: boolean
  profile?: BrandVoiceProfile
  error?: string
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { success: false, error: "Unauthorized" }
  if (!BRAND_VOICE_ALLOWED_ROLES.includes(ctx.userType)) {
    return { success: false, error: "Forbidden: insufficient role" }
  }
  if (ctx.userType === "agent" && !ctx.agentId) {
    return { success: false, error: "Agent profile not found" }
  }

  const supabase = await createClient()

  // Check if a profile already exists for this agent
  const { data: existing } = await supabase
    .from("brand_voice_profile")
    .select("id")
    .eq("agent_id", ctx.agentId)
    .maybeSingle()

  const payload = {
    brokerage_id:        ctx.brokerageId,
    agent_id:            ctx.agentId,
    tone:                input.tone                ?? null,
    formality_level:     input.formality_level     ?? null,
    key_brand_messages:  input.key_brand_messages  ?? null,
    prohibited_words:    input.prohibited_words    ?? null,
    preferred_words:     input.preferred_words     ?? null,
    tagline:             input.tagline             ?? null,
    mission_statement:   input.mission_statement   ?? null,
    custom_instructions: input.custom_instructions ?? null,
    is_active:           true,
    updated_at:          new Date().toISOString(),
  }

  let data: BrandVoiceProfile | null = null
  let error: any = null

  if (existing) {
    const result = await supabase
      .from("brand_voice_profile")
      .update(payload)
      .eq("id", existing.id)
      .select("*")
      .single()
    data  = result.data
    error = result.error
  } else {
    const result = await supabase
      .from("brand_voice_profile")
      .insert({ ...payload, created_at: new Date().toISOString() })
      .select("*")
      .single()
    data  = result.data
    error = result.error
  }

  if (error) return { success: false, error: error.message }
  return { success: true, profile: data! }
}
