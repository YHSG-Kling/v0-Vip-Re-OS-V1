"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"

// ── saveWidgetSettings ────────────────────────────────────────────────────────
// Updates agents.widget_embed_enabled and agents.widget_position for the
// calling user's agent record.

export async function saveWidgetSettings({
  agentId,
  enabled,
  position,
}: {
  agentId: string | null
  enabled: boolean
  position: "right" | "left"
}): Promise<{ success: boolean; error?: string }> {
  if (!agentId) return { success: false, error: "No agent record found for this user." }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated." }

  const service = createServiceClient()

  const { error } = await service
    .from("agents")
    .update({
      widget_embed_enabled: enabled,
      widget_position: position,
      updated_at: new Date().toISOString(),
    })
    .eq("id", agentId)
    .eq("user_id", user.id) // ownership check

  if (error) {
    console.error("[saveWidgetSettings] error:", error)
    return { success: false, error: error.message }
  }

  // Emit lifecycle event
  const { data: agent } = await service
    .from("agents")
    .select("brokerage_id")
    .eq("id", agentId)
    .maybeSingle()

  if (agent?.brokerage_id) {
    await service.from("lifecycle_events").insert({
      brokerage_id: agent.brokerage_id,
      event_type: "widget_settings_updated",
      entity_type: "agent",
      entity_id: agentId,
      actor_user_id: user.id,
      metadata: { widget_enabled: enabled, widget_position: position },
    })
  }

  revalidatePath("/dashboard/settings/widget")
  return { success: true }
}

// ── saveAIIdentity ────────────────────────────────────────────────────────────
// Upserts the ai_identity_profiles row for this agent's scope.

export async function saveAIIdentity({
  identityId,
  agentId,
  brokerageId,
  assistantName,
  personaLabel,
  tone,
  formalityLevel,
  welcomeMessage,
  followupStyle,
}: {
  identityId: string | null
  agentId: string | null
  brokerageId: string
  assistantName: string
  personaLabel: string
  tone: string
  formalityLevel: string
  welcomeMessage: string
  followupStyle: string
}): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated." }

  const service = createServiceClient()

  const payload = {
    brokerage_id: brokerageId,
    scope_type: agentId ? "agent" : "brokerage",
    scope_id: agentId ?? brokerageId,
    assistant_name: assistantName.trim() || "Alex",
    persona_label: personaLabel.trim() || "Real Estate Assistant",
    tone,
    formality_level: formalityLevel,
    welcome_message: welcomeMessage.trim(),
    followup_style: followupStyle,
    active: true,
    updated_at: new Date().toISOString(),
  }

  let error

  if (identityId) {
    // Update existing
    const res = await service
      .from("ai_identity_profiles")
      .update(payload)
      .eq("id", identityId)
    error = res.error
  } else {
    // Insert new
    const res = await service
      .from("ai_identity_profiles")
      .insert({ ...payload, created_at: new Date().toISOString() })
    error = res.error
  }

  if (error) {
    console.error("[saveAIIdentity] error:", error)
    return { success: false, error: error.message }
  }

  // Emit lifecycle event
  await service.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    event_type: "ai_identity_updated",
    entity_type: agentId ? "agent" : "brokerage",
    entity_id: agentId ?? brokerageId,
    actor_user_id: user.id,
    metadata: { assistant_name: assistantName, tone, formality_level: formalityLevel },
  })

  revalidatePath("/dashboard/settings/widget")
  return { success: true }
}
