"use server"

// app/actions/campaign-presets.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PRESET WRITER (writer-less burn-down, campaign 2). Seven preset tables
// (email / sms / voicedrop / social post / portal push / podcast episode /
// ad retarget) were READ by the campaign-bundle dispatcher but had NO writer —
// the bundle builder listed empty preset shelves forever. This is the ONE
// canonical upsert for all seven channels, mirroring the direct-mail preset
// discipline exactly: tenant-guarded, scope-checked, compliance-gated on every
// content-carrying channel, and never trusting a caller-supplied brokerage.

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { revalidatePath } from "next/cache"

export type PresetChannel =
  | "email" | "sms" | "voicedrop" | "social_post" | "portal_push" | "podcast_episode" | "ad_retarget"

const CHANNEL_TABLE: Record<PresetChannel, string> = {
  email: "email_presets",
  sms: "sms_presets",
  voicedrop: "voicedrop_presets",
  social_post: "social_post_presets",
  portal_push: "portal_push_presets",
  podcast_episode: "podcast_episode_presets",
  ad_retarget: "ad_retarget_presets",
}

/** The channel's content fields (whitelist — anything else from the caller is dropped). */
const CHANNEL_FIELDS: Record<PresetChannel, string[]> = {
  email: ["subject", "body_html", "body_text", "from_name_override", "reply_to_override", "channel_purpose"],
  sms: ["body"],
  voicedrop: ["tts_script", "audio_url", "voice_id_override"],
  social_post: ["caption", "media_urls", "target_platforms", "platform_overrides"],
  portal_push: ["title", "body_md", "cta_label", "cta_url", "priority"],
  podcast_episode: ["podcast_episode_id", "target_distribution_channels"],
  ad_retarget: ["ad_headline", "ad_body", "ad_cta", "ad_image_url", "ad_landing_url", "daily_budget_cents", "facebook_audience_id"],
}

/** The text the compliance gate must see per channel ("" = no free text → no gate). */
function complianceText(channel: PresetChannel, fields: Record<string, unknown>): string {
  switch (channel) {
    case "email": return [fields.subject, fields.body_text, fields.body_html].filter(Boolean).join("\n")
    case "sms": return String(fields.body ?? "")
    case "voicedrop": return String(fields.tts_script ?? "")
    case "social_post": return String(fields.caption ?? "")
    case "portal_push": return [fields.title, fields.body_md].filter(Boolean).join("\n")
    case "ad_retarget": return [fields.ad_headline, fields.ad_body, fields.ad_cta].filter(Boolean).join("\n")
    case "podcast_episode": return "" // references an already-gated episode
  }
}

export interface UpsertCampaignPresetInput {
  id?: string
  channel: PresetChannel
  name: string
  /** 'brokerage' | 'team' | 'agent' — same scope model as direct-mail presets. */
  scopeType?: string
  scopeId?: string | null
  fields: Record<string, unknown>
}

export async function upsertCampaignPreset(input: UpsertCampaignPresetInput): Promise<{
  success: boolean
  presetId?: string
  violations?: unknown[]
  error?: string
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  const table = CHANNEL_TABLE[input.channel]
  if (!table) return { success: false, error: "unknown_channel" }
  if (!input.name?.trim()) return { success: false, error: "name_required" }

  const svc = createServiceClient()

  // Compliance gate on every content-carrying channel — a preset is pre-approved
  // copy that the dispatcher will send verbatim, so it gates at SAVE time.
  let complianceEventId: string | null = null
  const text = complianceText(input.channel, input.fields ?? {})
  if (text.trim().length > 0) {
    // Same call shape as the direct-mail preset gate (the pattern this mirrors).
    const MESSAGE_TYPE: Record<string, "email" | "sms" | "social" | "phone" | "in_app"> = {
      email: "email", sms: "sms", voicedrop: "phone",
      social_post: "social", portal_push: "in_app", ad_retarget: "social",
    }
    const gate = await evaluateOutbound({
      actorContext: { brokerageId: ctx.brokerageId, role: ctx.role ?? "agent", userId: ctx.userId },
      messageType: MESSAGE_TYPE[input.channel] ?? "in_app",
      journeyType: "buyer", // presets default to the buyer journey bucket (same as direct-mail presets)
      persona: "other",
      content: text,
    } as any)
    if (gate && (gate as any).allowed === false) {
      return { success: false, violations: (gate as any).violations, error: "compliance_gate_blocked" }
    }
    complianceEventId = (gate as any)?.complianceEventId ?? null
  }

  // Whitelist the channel's fields — never spread caller input into the row.
  const allowed = CHANNEL_FIELDS[input.channel]
  const content: Record<string, unknown> = {}
  for (const k of allowed) if (input.fields?.[k] !== undefined) content[k] = input.fields[k]

  const row: Record<string, unknown> = {
    brokerage_id: ctx.brokerageId,
    scope_type: input.scopeType ?? "brokerage",
    // scope_id is NOT NULL (live-fired) — brokerage scope anchors on the tenant id.
    scope_id: input.scopeId ?? ctx.brokerageId,
    name: input.name.trim(),
    ...content,
    ...(complianceEventId ? { compliance_event_id: complianceEventId } : {}),
    is_active: true,
    created_by: ctx.userId,
    updated_at: new Date().toISOString(),
  }

  if (input.id) {
    const { data: existing } = await svc.from(table).select("brokerage_id").eq("id", input.id).maybeSingle()
    if (!existing) return { success: false, error: "preset_not_found" }
    if ((existing.brokerage_id as string) !== ctx.brokerageId) return { success: false, error: "tenant_mismatch" }
    const { error } = await svc.from(table).update(row).eq("id", input.id)
    if (error) return { success: false, error: error.message }
    revalidatePath("/dashboard/campaigns")
    return { success: true, presetId: input.id }
  }

  const { data, error } = await svc.from(table).insert(row).select("id").single()
  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/campaigns")
  return { success: true, presetId: data.id as string }
}

/** Soft-delete (deactivate) — the dispatcher only reads is_active=true. */
export async function deactivateCampaignPreset(channel: PresetChannel, presetId: string): Promise<{ success: boolean; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  const table = CHANNEL_TABLE[channel]
  if (!table) return { success: false, error: "unknown_channel" }
  const svc = createServiceClient()
  const { error } = await svc.from(table)
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", presetId)
    .eq("brokerage_id", ctx.brokerageId)
  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/campaigns")
  return { success: true }
}
