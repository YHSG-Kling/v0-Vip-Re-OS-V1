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
  // Expansion (owner spec): blog drafts, Facebook audiences + newsletters are
  // shelf items too — they write their CANONICAL homes (blog_posts /
  // facebook_custom_audiences / newsletter_campaigns), never a parallel preset
  // table (keep-one).
  | "blog_post" | "facebook_audience" | "newsletter"

const CHANNEL_TABLE: Partial<Record<PresetChannel, string>> = {
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
  email: ["subject", "body_html", "body_text", "from_name_override", "reply_to_override", "channel_purpose", "video_url"],
  sms: ["body", "video_url"],
  voicedrop: ["tts_script", "audio_url", "voice_id_override"],
  social_post: ["caption", "media_urls", "target_platforms", "platform_overrides"],
  portal_push: ["title", "body_md", "cta_label", "cta_url", "priority"],
  // Podcast presets carry their own script + voice (like voicedrop) — l72_s10.
  podcast_episode: ["podcast_episode_id", "target_distribution_channels", "tts_script", "voice_id_override"],
  // Ads can carry a video creative alongside the image — l72_s10.
  ad_retarget: ["ad_headline", "ad_body", "ad_cta", "ad_image_url", "ad_video_url", "ad_landing_url", "daily_budget_cents", "facebook_audience_id"],
  // Special-cased channels (canonical homes, not CHANNEL_TABLE):
  blog_post: [],
  facebook_audience: [],
  newsletter: [],
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
    case "podcast_episode": return String(fields.tts_script ?? "") // script gates like voicedrop; episode ref alone needs none
    case "blog_post": return [fields.title, fields.excerpt, fields.content].filter(Boolean).join("\n")
    case "facebook_audience": return "" // audience definitions carry no outbound copy
    case "newsletter": return [fields.subject_line, fields.content].filter(Boolean).join("\n")
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
  const SPECIAL = input.channel === "blog_post" || input.channel === "facebook_audience" || input.channel === "newsletter"
  const table = CHANNEL_TABLE[input.channel]
  if (!table && !SPECIAL) return { success: false, error: "unknown_channel" }
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
      newsletter: "email", blog_post: "social",
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

  // ── SPECIAL CHANNELS: canonical homes, never a parallel preset table ──────
  if (input.channel === "blog_post") {
    // A blog "preset" IS a reusable draft on the canonical blog_posts table —
    // approval_status pending (live CHECK), publish_status draft.
    const f = input.fields ?? {}
    const row = {
      brokerage_id: ctx.brokerageId,
      agent_user_id: ctx.userId, // users-class column (pass-13 census)
      created_by: ctx.userId,
      title: input.name.trim(),
      slug: `${input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)}-${Math.random().toString(36).slice(2, 8)}`,
      excerpt: (f.excerpt as string) ?? null,
      content: (f.content as string) ?? null,
      category: (f.category as string) ?? null,
      featured_image_url: (f.featured_image_url as string) ?? null,
      publish_status: "draft",
      approval_status: "pending",
      visibility_scope: (input.scopeType as string) ?? "brokerage",
      is_ai_generated: false,
    }
    if (input.id) {
      const { data: existing } = await svc.from("blog_posts").select("brokerage_id").eq("id", input.id).maybeSingle()
      if (!existing || (existing.brokerage_id as string) !== ctx.brokerageId) return { success: false, error: "tenant_mismatch" }
      const { slug: _s, ...updates } = row
      const { error } = await svc.from("blog_posts").update(updates).eq("id", input.id)
      if (error) return { success: false, error: error.message }
      revalidatePath("/dashboard/campaigns")
      return { success: true, presetId: input.id }
    }
    const { data, error } = await svc.from("blog_posts").insert(row).select("id").single()
    if (error) return { success: false, error: error.message }
    revalidatePath("/dashboard/campaigns")
    return { success: true, presetId: data.id as string }
  }
  if (input.channel === "facebook_audience") {
    // Audience shelf item on the canonical facebook_custom_audiences table.
    // Live CHECK vocabularies: audience_type (custom/lookalike/…), status
    // (draft/pending_review/…), target_platform (facebook/instagram/…).
    const f = input.fields ?? {}
    const row = {
      brokerage_id: ctx.brokerageId,
      agent_user_id: ctx.userId, // users-class column (pass-13 census)
      scope_type: (input.scopeType as string) ?? "brokerage",
      audience_name: input.name.trim(),
      audience_type: (f.audience_type as string) ?? "custom",
      target_platform: (f.target_platform as string) ?? "facebook",
      source_rule: (f.source_rule as Record<string, unknown>) ?? {},
      consent_basis: (f.consent_basis as string) ?? "first_party_crm",
      status: "draft",
    }
    const { data, error } = await svc.from("facebook_custom_audiences").insert(row).select("id").single()
    if (error) return { success: false, error: error.message }
    revalidatePath("/dashboard/campaigns")
    return { success: true, presetId: data.id as string }
  }
  if (input.channel === "newsletter") {
    // A newsletter "preset" IS a reusable draft on the canonical
    // newsletter_campaigns table (live CHECKs: status draft/scheduled/…,
    // approval_status draft/pending_review/…; agent_id is AGENTS-class).
    const f = input.fields ?? {}
    const row = {
      brokerage_id: ctx.brokerageId,
      agent_id: ctx.agentId, // agents.id FK — nullable for non-producing brokers
      created_by: ctx.userId,
      campaign_name: input.name.trim(),
      subject_line: (f.subject_line as string) ?? null,
      content: (f.content as string) ?? null,
      status: "draft",
      approval_status: "draft",
      is_ai_generated: false,
    }
    if (input.id) {
      const { data: existing } = await svc.from("newsletter_campaigns").select("brokerage_id").eq("id", input.id).maybeSingle()
      if (!existing || (existing.brokerage_id as string) !== ctx.brokerageId) return { success: false, error: "tenant_mismatch" }
      const { error } = await svc.from("newsletter_campaigns").update(row).eq("id", input.id)
      if (error) return { success: false, error: error.message }
      revalidatePath("/dashboard/campaigns")
      return { success: true, presetId: input.id }
    }
    const { data, error } = await svc.from("newsletter_campaigns").insert(row).select("id").single()
    if (error) return { success: false, error: error.message }
    revalidatePath("/dashboard/campaigns")
    return { success: true, presetId: data.id as string }
  }

  // Whitelist the channel's fields — never spread caller input into the row.
  // (table is guaranteed here: the !table && !SPECIAL guard returned above and
  // both SPECIAL channels returned in their branches — TS can't see that.)
  const presetTable = table as string
  const allowed = CHANNEL_FIELDS[input.channel]
  const content: Record<string, unknown> = {}
  for (const k of allowed) if (input.fields?.[k] !== undefined) content[k] = input.fields[k]

  // email_presets.body_html is NOT NULL (live-fired) — plain-text-only callers
  // (the quick-preset UI sends body_text) get an HTML twin derived from it.
  if (input.channel === "email" && !content.body_html) {
    const plain = String(content.body_text ?? "")
    content.body_html = plain
      ? plain.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`).join("")
      : "<p></p>"
  }

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
    const { data: existing } = await svc.from(presetTable).select("brokerage_id").eq("id", input.id).maybeSingle()
    if (!existing) return { success: false, error: "preset_not_found" }
    if ((existing.brokerage_id as string) !== ctx.brokerageId) return { success: false, error: "tenant_mismatch" }
    const { error } = await svc.from(presetTable).update(row).eq("id", input.id)
    if (error) return { success: false, error: error.message }
    revalidatePath("/dashboard/campaigns")
    return { success: true, presetId: input.id }
  }

  const { data, error } = await svc.from(presetTable).insert(row).select("id").single()
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
