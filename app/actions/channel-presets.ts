"use server"

/**
 * app/actions/channel-presets.ts
 *
 * Wave 38 — CRUD for the 7 channel preset tables:
 *   · email_presets             (email)
 *   · sms_presets               (sms)
 *   · social_post_presets       (social)
 *   · voicedrop_presets         (phone — ringless VM)
 *   · podcast_episode_presets   (social)
 *   · ad_retarget_presets       (social — paid ad creative)
 *   · portal_push_presets       (in_app)
 *
 * Each preset is a locked piece of creative the bundle dispatcher fires
 * verbatim. The compliance gate (Fair Housing / Them-First / brand voice)
 * runs ONCE at preset-save time against the locked copy and the resulting
 * compliance_event_id is stamped on the row so future dispatches inherit
 * the audit. Portal push + podcast episode skip the gate (portal copy is
 * client-facing internal content; podcast episodes are gated at the
 * episode-creation layer).
 *
 * Tier scope mirrors the direct-mail-presets pattern.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolvePolicyScopeAccess, type PolicyScopeAccess } from "@/lib/identity/policy-scope"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import type { MessageType } from "@/lib/kernel/types"
import { revalidatePath } from "next/cache"

export type PresetChannel =
  | "email"
  | "sms"
  | "social_post"
  | "voicedrop"
  | "portal_push"
  | "podcast_episode"
  | "ad_retarget"

const CHANNEL_TABLE: Record<PresetChannel, string> = {
  email:           "email_presets",
  sms:             "sms_presets",
  social_post:     "social_post_presets",
  voicedrop:       "voicedrop_presets",
  portal_push:     "portal_push_presets",
  podcast_episode: "podcast_episode_presets",
  ad_retarget:     "ad_retarget_presets",
}

/** MessageType to feed evaluateOutbound. Null = skip the gate (the
 *  channel has no copy worth evaluating at the preset layer). */
const GATE_MESSAGE_TYPE: Record<PresetChannel, MessageType | null> = {
  email:           "email",
  sms:             "sms",
  social_post:     "social",
  voicedrop:       "phone",
  ad_retarget:     "social",
  podcast_episode: null,
  portal_push:     null,
}

/** Pull the locked copy out of a preset payload so we can run the gate
 *  against the bits the user is actually publishing. */
function extractGateCopy(channel: PresetChannel, p: Record<string, unknown>): string {
  switch (channel) {
    case "email":       return [p.subject, p.body_html, p.body_text].filter(Boolean).join("\n")
    case "sms":         return String(p.body ?? "")
    case "social_post": return String(p.caption ?? "")
    case "voicedrop":   return String(p.tts_script ?? "")
    case "ad_retarget": return [p.ad_headline, p.ad_body, p.ad_cta].filter(Boolean).join("\n")
    default:            return ""
  }
}

export interface ChannelPresetRow {
  id:                 string
  name:               string
  scope_type:         "agent" | "team" | "brokerage"
  scope_id:           string
  is_active:          boolean
  compliance_event_id: string | null
  created_at:         string
  /** Channel-specific payload — caller renders only the fields it knows. */
  payload:            Record<string, unknown>
}

function buildScopeFilters(access: PolicyScopeAccess): string[] {
  const filters: string[] = []
  if (access.canEditAgent && access.agentScopeId) {
    filters.push(`and(scope_type.eq.agent,scope_id.eq.${access.agentScopeId})`)
  }
  for (const teamId of access.teamScopeIds) {
    filters.push(`and(scope_type.eq.team,scope_id.eq.${teamId})`)
  }
  if (access.canEditBrokerage && access.brokerageScopeId) {
    filters.push(`and(scope_type.eq.brokerage,scope_id.eq.${access.brokerageScopeId})`)
  }
  return filters
}

function resolveTargetScope(
  access: PolicyScopeAccess,
  requested: { scope_type?: "agent" | "team" | "brokerage"; scope_id?: string },
): { ok: true; scope_type: "agent" | "team" | "brokerage"; scope_id: string } | { ok: false; error: string } {
  const tier = requested.scope_type ?? (
    access.canEditBrokerage ? "brokerage" :
    access.canEditTeam      ? "team"      :
    "agent"
  )
  if (tier === "agent") {
    if (!access.canEditAgent) return { ok: false, error: "agent_scope_forbidden" }
    const id = requested.scope_id ?? access.agentScopeId
    if (!id) return { ok: false, error: "agent_scope_unresolved" }
    return { ok: true, scope_type: "agent", scope_id: id }
  }
  if (tier === "team") {
    if (!access.canEditTeam) return { ok: false, error: "team_scope_forbidden" }
    const id = requested.scope_id ?? access.teamScopeIds[0]
    if (!id || !access.teamScopeIds.includes(id)) return { ok: false, error: "team_not_in_your_scope" }
    return { ok: true, scope_type: "team", scope_id: id }
  }
  if (!access.canEditBrokerage) return { ok: false, error: "brokerage_scope_forbidden" }
  const id = requested.scope_id ?? access.brokerageScopeId
  if (!id) return { ok: false, error: "brokerage_scope_unresolved" }
  return { ok: true, scope_type: "brokerage", scope_id: id }
}

export async function listChannelPresets(channel: PresetChannel): Promise<
  | { success: true; presets: ChannelPresetRow[] }
  | { success: false; error: string }
> {
  const access = await resolvePolicyScopeAccess()
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  const brokerageId = access.brokerageScopeId ?? ctx.brokerageId
  if (!brokerageId) return { success: false, error: "brokerage_unresolved" }

  const scopeFilters = buildScopeFilters(access)
  if (scopeFilters.length === 0) return { success: true, presets: [] }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from(CHANNEL_TABLE[channel])
    .select("*")
    .eq("brokerage_id", brokerageId)
    .or(scopeFilters.join(","))
    .order("created_at", { ascending: false })
  if (error) return { success: false, error: error.message }

  const rows = (data ?? []) as Array<Record<string, unknown>>
  return {
    success: true,
    presets: rows.map((r) => ({
      id:                 r.id as string,
      name:               r.name as string,
      scope_type:         r.scope_type as "agent" | "team" | "brokerage",
      scope_id:           r.scope_id as string,
      is_active:          (r.is_active as boolean) ?? true,
      compliance_event_id: (r.compliance_event_id as string | null) ?? null,
      created_at:         r.created_at as string,
      payload:            r,
    })),
  }
}

export interface UpsertChannelPresetInput {
  id?:          string
  name:         string
  scope_type?:  "agent" | "team" | "brokerage"
  scope_id?:    string
  /** Channel-specific fields. Validated per channel below. */
  payload:      Record<string, unknown>
}

export async function upsertChannelPreset(
  channel: PresetChannel,
  input: UpsertChannelPresetInput,
): Promise<{ success: boolean; presetId?: string; violations?: string[]; error?: string }> {
  const access = await resolvePolicyScopeAccess()
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  const brokerageId = access.brokerageScopeId ?? ctx.brokerageId
  if (!brokerageId) return { success: false, error: "brokerage_unresolved" }

  if (!input.name?.trim()) return { success: false, error: "name required" }
  const scope = resolveTargetScope(access, { scope_type: input.scope_type, scope_id: input.scope_id })
  if (!scope.ok) return { success: false, error: scope.error }

  // Per-channel validation. Lean — the DB has CHECK constraints for
  // structural rules; here we just guard the required fields a UI form
  // might omit so the error message is actionable.
  const p = input.payload
  switch (channel) {
    case "email":
      if (!p.subject || !p.body_html) return { success: false, error: "email preset needs subject + body_html" }
      break
    case "sms":
      if (!p.body) return { success: false, error: "sms preset needs body" }
      break
    case "social_post":
      if (!p.caption) return { success: false, error: "social preset needs caption" }
      if (!Array.isArray(p.target_platforms) || (p.target_platforms as unknown[]).length === 0) {
        return { success: false, error: "social preset needs at least one target_platforms entry" }
      }
      break
    case "voicedrop":
      if (!p.tts_script && !p.audio_url) {
        return { success: false, error: "voicedrop preset needs tts_script OR audio_url" }
      }
      break
    case "portal_push":
      if (!p.title || !p.body_md) return { success: false, error: "portal push needs title + body_md" }
      break
    case "podcast_episode":
      // podcast_episode_id + target_distribution_channels are both
      // optional at create — broker can stage a preset before the
      // episode is bound.
      break
    case "ad_retarget":
      if (!p.ad_headline || !p.ad_body) return { success: false, error: "ad preset needs ad_headline + ad_body" }
      break
  }

  // Run the compliance gate ONCE if the channel has one. Failures
  // bubble up to the UI as violations; the row never lands.
  let complianceEventId: string | null = null
  const gateMessageType = GATE_MESSAGE_TYPE[channel]
  if (gateMessageType) {
    const copy = extractGateCopy(channel, p)
    if (copy.trim().length > 0) {
      const gateResult = await evaluateOutbound({
        actorContext: { brokerageId, role: "agent", userId: brokerageId },
        messageType:  gateMessageType,
        journeyType:  "buyer",
        persona:      "other",
        content:      copy,
      })
      if (!gateResult.allowed) {
        return { success: false, violations: gateResult.violations, error: "compliance_gate_blocked" }
      }
      const svcForGate = createServiceClient()
      const { data: ceRow } = await svcForGate
        .from("compliance_events")
        .select("id")
        .eq("brokerage_id", brokerageId)
        .eq("message_type", gateMessageType)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      complianceEventId = (ceRow?.id as string | undefined) ?? null
    }
  }

  const svc = createServiceClient()
  const row: Record<string, unknown> = {
    ...p,
    brokerage_id: brokerageId,
    name:         input.name.trim(),
    scope_type:   scope.scope_type,
    scope_id:     scope.scope_id,
    is_active:    true,
    updated_at:   new Date().toISOString(),
  }
  if (gateMessageType) row.compliance_event_id = complianceEventId
  // Strip server-generated fields the payload might carry over from a
  // reused row (e.g. when the UI passes the whole `payload` object back
  // on edit).
  delete row.id
  delete row.created_at
  delete row.created_by

  if (input.id) {
    const { data: existing } = await svc.from(CHANNEL_TABLE[channel])
      .select("brokerage_id, scope_type, scope_id")
      .eq("id", input.id).maybeSingle()
    const ex = existing as { brokerage_id: string; scope_type: string; scope_id: string } | null
    if (!ex) return { success: false, error: "preset_not_found" }
    if (ex.brokerage_id !== brokerageId) return { success: false, error: "tenant_mismatch" }
    const canEditExisting =
      (ex.scope_type === "agent"     && access.canEditAgent     && ex.scope_id === access.agentScopeId) ||
      (ex.scope_type === "team"      && access.canEditTeam      && access.teamScopeIds.includes(ex.scope_id)) ||
      (ex.scope_type === "brokerage" && access.canEditBrokerage && ex.scope_id === access.brokerageScopeId)
    if (!canEditExisting) return { success: false, error: "scope_forbidden_existing" }
    const { error } = await svc.from(CHANNEL_TABLE[channel]).update(row).eq("id", input.id)
    if (error) return { success: false, error: error.message }
    revalidatePath("/settings/channel-presets")
    return { success: true, presetId: input.id }
  }

  const { data, error } = await svc.from(CHANNEL_TABLE[channel]).insert(row).select("id").single()
  if (error) {
    if (error.code === "23505") return { success: false, error: `A preset named "${input.name.trim()}" already exists.` }
    return { success: false, error: error.message }
  }
  revalidatePath("/settings/channel-presets")
  return { success: true, presetId: data.id as string }
}

export async function deactivateChannelPreset(
  channel: PresetChannel,
  presetId: string,
): Promise<{ success: boolean; error?: string }> {
  const access = await resolvePolicyScopeAccess()
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  const brokerageId = access.brokerageScopeId ?? ctx.brokerageId
  if (!brokerageId) return { success: false, error: "brokerage_unresolved" }
  const svc = createServiceClient()
  const { data: row } = await svc.from(CHANNEL_TABLE[channel])
    .select("scope_type, scope_id")
    .eq("id", presetId).eq("brokerage_id", brokerageId).maybeSingle()
  const r = row as { scope_type: string; scope_id: string } | null
  if (!r) return { success: false, error: "preset_not_found" }
  const canEditScope =
    (r.scope_type === "agent"     && access.canEditAgent     && r.scope_id === access.agentScopeId) ||
    (r.scope_type === "team"      && access.canEditTeam      && access.teamScopeIds.includes(r.scope_id)) ||
    (r.scope_type === "brokerage" && access.canEditBrokerage && r.scope_id === access.brokerageScopeId)
  if (!canEditScope) return { success: false, error: "scope_forbidden" }
  const { error } = await svc.from(CHANNEL_TABLE[channel])
    .update({ is_active: false }).eq("id", presetId)
  if (error) return { success: false, error: error.message }
  revalidatePath("/settings/channel-presets")
  return { success: true }
}
