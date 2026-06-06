/**
 * lib/social/orchestrate-social-preset-publish.ts
 *
 * Wave 37 — social preset dispatcher. Loads a social_post_presets
 * row, expands it to N social_posts rows (one per target platform,
 * each with the platform-specific caption when overridden), stages
 * them at status='scheduled' for the existing /api/cron/publish-
 * social-posts cron to dispatch on its 15-minute tick.
 *
 * Why we don't publish synchronously here:
 *   · publish-social-posts is the canonical egress path; it carries
 *     OAuth refresh, platform-specific rate limiting, retry logic.
 *     Duplicating that in the preset path would drift over time.
 *   · The 15-min batch window is fine for bundle dispatches —
 *     the postcard takes 4-7 days to arrive; an extra 15 min of
 *     social latency is invisible in context.
 *
 * Returns the number of platform-specific rows staged so the bundle
 * dispatcher's channel outcome captures fan-out volume.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveBrandContext } from "@/lib/branding/resolve-brand-context"

export interface OrchestrateSocialPresetPublishArgs {
  brokerageId:  string
  presetId:     string
  /** Optional schedule time. When omitted, status='scheduled' with
   *  scheduled_for=now() so the cron picks it up on its next tick. */
  scheduledFor?: string
  teamId?:      string | null
  agentUserId?: string | null
  systemSource?: string
}

export interface OrchestrateSocialPresetPublishResult {
  success:        boolean
  presetName?:    string
  platformsCount?: number
  socialPostIds?: string[]
  error?:         string
}

interface PresetRow {
  id: string
  brokerage_id: string
  name: string
  caption: string
  media_urls: string[] | null
  target_platforms: string[]
  platform_overrides: Record<string, string> | null
  is_active: boolean
}

function interpolate(s: string, vars: Record<string, string>): string {
  return s.replace(/{{\s*([\w_]+)\s*}}/g, (_, key) => vars[key] ?? "")
}

export async function orchestrateSocialPresetPublish(
  args: OrchestrateSocialPresetPublishArgs,
): Promise<OrchestrateSocialPresetPublishResult> {
  const svc = createServiceClient()

  const { data: presetData } = await svc
    .from("social_post_presets")
    .select("id, brokerage_id, name, caption, media_urls, target_platforms, platform_overrides, is_active")
    .eq("id", args.presetId)
    .maybeSingle()
  const preset = presetData as PresetRow | null
  if (!preset) return { success: false, error: "preset_not_found" }
  if (preset.brokerage_id !== args.brokerageId) {
    return { success: false, error: "tenant_mismatch", presetName: preset.name }
  }
  if (!preset.is_active) {
    return { success: false, error: "preset_deactivated", presetName: preset.name }
  }
  if (!preset.target_platforms || preset.target_platforms.length === 0) {
    return { success: false, error: "no_target_platforms", presetName: preset.name }
  }

  const brand = await resolveBrandContext({
    brokerageId: args.brokerageId,
    teamId:      args.teamId ?? null,
    agentUserId: args.agentUserId ?? null,
  })
  const vars: Record<string, string> = {
    agent_name:     brand.agentName ?? brand.displayName,
    brokerage_name: brand.brokerageName,
  }

  const scheduledFor = args.scheduledFor ?? new Date().toISOString()
  const overrides = preset.platform_overrides ?? {}

  // Stage one social_posts row per target platform with the canonical
  // (or platform-specific overridden) caption.
  const rowsToInsert = preset.target_platforms.map((platform) => {
    const raw = overrides[platform] ?? preset.caption
    return {
      brokerage_id:   args.brokerageId,
      platform,
      content:        interpolate(raw, vars),
      status:         "scheduled",
      scheduled_for:  scheduledFor,
      created_at:     new Date().toISOString(),
    }
  })

  const { data: inserted, error } = await svc
    .from("social_posts")
    .insert(rowsToInsert)
    .select("id")
  if (error) return { success: false, error: error.message, presetName: preset.name }

  return {
    success:         true,
    presetName:      preset.name,
    platformsCount:  preset.target_platforms.length,
    socialPostIds:   ((inserted ?? []) as Array<{ id: string }>).map((r) => r.id),
  }
}
