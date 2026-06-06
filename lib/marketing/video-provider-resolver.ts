/**
 * Resolves the video/avatar VENDOR to use for a render.
 *
 * The vendor is a PLATFORM setting (one engine for the whole app), not an
 * agent choice — see lib/kernel/providers.ts (`video` is a system-only type).
 * Resolution therefore delegates to the kernel registry: superadmin override
 * or the platform default (D-ID). The per-agent avatar/voice ASSET IDs
 * (did_avatar_id, heygen_voice_clone_id, …) are applied downstream by the
 * generation code; only the vendor is decided here.
 *
 * Why D-ID is the platform default:
 *   - @d-id/client-sdk is the SDK in package.json
 *   - poll-did-avatars + poll-did-videos crons exist for D-ID lifecycle
 *
 * NOTE: agent_voice_profiles.preferred_avatar_provider is no longer consulted
 * for vendor selection — the vendor is platform-locked by design.
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { resolveProvider } from "@/lib/kernel/providers"

export type VideoProvider = "did" | "heygen" | "upload"

export interface ResolveProviderInput {
  brokerageId: string
  /** Optional agent (users.id). Retained for call-site compatibility; the
   *  vendor is platform-locked so it does not affect the result. */
  agentUserId?: string | null
}

export async function resolveVideoProvider(
  _supabase: SupabaseClient,
  input:     ResolveProviderInput,
): Promise<VideoProvider> {
  const { providerKey } = await resolveProvider({
    providerType: "video",
    actorContext: { userId: input.agentUserId ?? "", brokerageId: input.brokerageId },
  })
  // resolveProvider returns the platform vendor (superadmin override or 'did').
  return providerKey === "heygen" ? "heygen" : "did"
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
