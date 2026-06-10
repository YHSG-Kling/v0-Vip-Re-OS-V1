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
  // BUSINESS RULE (platform-locked): the avatar/explainer video engine is D-ID +
  // ElevenLabs — HeyGen is NOT used. Even if a stale superadmin override still says
  // 'heygen', it is forced to 'did' here so the engine can never render via HeyGen.
  // 'upload' (agent-provided content, no async render) is still honored.
  return providerKey === "upload" ? "upload" : "did"
}

/**
 * The provider-specific status column to set on insert. D-ID uses
 * `provider_status`/`provider_job_id`. (HeyGen columns intentionally not produced —
 * the engine is D-ID-locked; see resolveVideoProvider.)
 */
export function initialProviderColumns(provider: VideoProvider): Record<string, unknown> {
  if (provider === "upload") {
    // upload — content already exists, no async render
    return {}
  }
  // did (the only render path)
  return { provider_status: "pending", provider_job_id: null }
}
