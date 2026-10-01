"use server"

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { requireCallerTenant } from "@/lib/auth/require-caller"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { normalizeFormalityLevel } from "@/lib/branding/formality"

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
    await sentinelWrite(service, service.from("lifecycle_events").insert({
      brokerage_id: agent.brokerage_id,
      event_type: "widget_settings_updated",
      entity_type: "agent",
      entity_id: agentId,
      actor_user_id: user.id,
      metadata: { widget_enabled: enabled, widget_position: position },
    }), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })
  }

  revalidatePath("/dashboard/settings/widget")
  return { success: true }
}

// ── saveAIIdentity ────────────────────────────────────────────────────────────
// Upserts the ai_identity_profiles row for this agent's scope.

export async function saveAIIdentity({
  identityId,
  agentId,
  brokerageId: claimedBrokerageId,
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
  // SESSION GATE (lane 91D2, CLAUDE.md §4). Before: any signed-in user could insert
  // an assistant identity into ANY brokerage (body brokerageId) and rewrite ANY
  // tenant's identity row by id — both on the service client. Now: the tenant is
  // the session's (a different body brokerage is refused); a BROKERAGE-scope
  // identity is a tenant-admin decision (the one roster); an AGENT-scope identity
  // must name an agent of this tenant, and only that agent or a tenant admin may
  // set it; an update touches only a row of this tenant, counted.
  const caller = await requireCallerTenant(claimedBrokerageId)
  if (!caller.ok) return { success: false, error: caller.error }
  const brokerageId = caller.brokerageId
  const user = { id: caller.userId }
  const isAdmin = isAdminOrBroker({ user_type: caller.userType })

  // ONE formality vocabulary (lib/branding/formality.ts): the widget offered "conversational" (its
  // default) and "semi-formal", neither admitted by ai_identity_profiles_formality_level_check —
  // a save on the default was refused outright. Normalize; refuse an unknown value out loud.
  const formality = normalizeFormalityLevel(formalityLevel)
  if (!formality) return { success: false, error: `Unknown formality level "${formalityLevel}" — use formal, semi-formal or casual.` }

  const service = createServiceClient()

  if (!agentId) {
    if (!isAdmin) return { success: false, error: "Only a brokerage admin can set the brokerage's assistant." }
  } else {
    const { data: agentRow, error: agentErr } = await service
      .from("agents").select("id, user_id").eq("id", agentId).eq("brokerage_id", brokerageId).maybeSingle()
    if (agentErr) return { success: false, error: `Could not verify the agent: ${agentErr.message}` }
    if (!agentRow) return { success: false, error: "Agent not found in your brokerage." }
    if (!isAdmin && (agentRow as { user_id?: string | null }).user_id !== caller.userId) {
      return { success: false, error: "You can only set your own assistant." }
    }
  }

  const payload = {
    brokerage_id: brokerageId,
    scope_type: agentId ? "agent" : "brokerage",
    scope_id: agentId ?? brokerageId,
    assistant_name: assistantName.trim() || "Alex",
    persona_label: personaLabel.trim() || "Real Estate Assistant",
    tone,
    formality_level: formality,
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
      .eq("brokerage_id", brokerageId)
      .select("id")
    error = res.error
    // §3: an UPDATE that matched nothing also resolves — count it.
    if (!error && (res.data ?? []).length === 0) return { success: false, error: "That assistant identity is not in your brokerage." }
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
  await sentinelWrite(service, service.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    event_type: "ai_identity_updated",
    entity_type: agentId ? "agent" : "brokerage",
    entity_id: agentId ?? brokerageId,
    actor_user_id: user.id,
    metadata: { assistant_name: assistantName, tone, formality_level: formality },
  }), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

  revalidatePath("/dashboard/settings/widget")
  return { success: true }
}
