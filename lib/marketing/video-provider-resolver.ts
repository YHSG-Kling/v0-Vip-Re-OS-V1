/**
 * Resolves the video provider to use for a given video.
 *
 * Hierarchy (most-specific wins):
 *   1. agent_voice_profiles.preferred_avatar_provider (per-agent, defaults 'did')
 *   2. global_settings.additional_settings.platform_video_provider (per-brokerage)
 *   3. 'did' — the platform default (migration 025 established D-ID as primary)
 *
 * Why D-ID is the default:
 *   - @d-id/client-sdk is the SDK in package.json
 *   - The agent_voice_profiles.preferred_avatar_provider column CHECK is
 *     ('did','heygen') with DEFAULT 'did'
 *   - poll-did-avatars + poll-did-videos crons exist for D-ID lifecycle
 *
 * HeyGen is the fallback for cases D-ID can't render (e.g., specific
 * template features). Future: the resolver can pick per-template.
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

export type VideoProvider = "did" | "heygen" | "upload"

export interface ResolveProviderInput {
  brokerageId: string
  /** Optional agent (users.id). If set, the agent's preferred provider wins. */
  agentUserId?: string | null
}

export async function resolveVideoProvider(
  supabase: SupabaseClient,
  input:    ResolveProviderInput,
): Promise<VideoProvider> {
  // 1. Agent preference
  if (input.agentUserId) {
    const { data: agentRow } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", input.agentUserId)
      .maybeSingle()
    const agentsId = (agentRow?.id as string | null) ?? null
    if (agentsId) {
      const { data: voice } = await supabase
        .from("agent_voice_profiles")
        .select("preferred_avatar_provider")
        .eq("agent_id", agentsId)
        .eq("brokerage_id", input.brokerageId)
        .order("is_default", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()
      const p = voice?.preferred_avatar_provider as string | null | undefined
      if (p === "did" || p === "heygen") return p
    }
  }

  // 2. Brokerage default (global_settings.additional_settings.platform_video_provider)
  const { data: gs } = await supabase
    .from("global_settings")
    .select("additional_settings")
    .eq("brokerage_id", input.brokerageId)
    .maybeSingle()
  const platformProvider = (gs?.additional_settings as Record<string, unknown> | null)?.platform_video_provider
  if (platformProvider === "did" || platformProvider === "heygen") {
    return platformProvider as VideoProvider
  }

  // 3. Default — D-ID is the platform primary
  return "did"
}

/**
 * The provider-specific status column to set on insert. D-ID uses
 * `provider_status`/`provider_job_id`; HeyGen uses `heygen_status`/
 * `heygen_video_id`. Both columns exist on ai_video_projects.
 */
export function initialProviderColumns(provider: VideoProvider): Record<string, unknown> {
  if (provider === "did") {
    return { provider_status: "pending", provider_job_id: null }
  }
  if (provider === "heygen") {
    return { heygen_status: "pending", heygen_video_id: null }
  }
  // upload — content already exists, no async render
  return {}
}
