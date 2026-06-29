// lib/video/presenter-media.ts
// ─────────────────────────────────────────────────────────────────────────────
// Resolve the PRESENTER MEDIA for an agent's avatar reel — the D-ID avatar source (created by the
// agent in Settings → Voice & Avatar, stored in Supabase storage) + their ElevenLabs voice clone.
// The autonomous render worker calls this before submitting a Director-commissioned avatar reel to
// D-ID; if the agent hasn't finished setup we return canRender=false so the worker notifies them to
// finish (graceful degrade) instead of failing silently. No avatar = the reel can't be a talking head.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface PresenterMedia {
  /** D-ID actor id (preferred — pre-processed, faster/consistent) OR null. */
  actorId: string | null
  /** Avatar source URL (Supabase storage photo/video) used when no actorId. */
  avatarImageUrl: string | null
  /** ElevenLabs voice clone id (null → D-ID falls back to its default TTS voice). */
  voiceId: string | null
  /** D-ID facial expression default for this agent. */
  expression: "happy" | "neutral" | "surprise" | "serious" | undefined
  /** Whether we have ENOUGH to render a talking head (an actorId OR an avatar source). */
  canRender: boolean
}

const NONE: PresenterMedia = { actorId: null, avatarImageUrl: null, voiceId: null, expression: undefined, canRender: false }

/**
 * Resolve an agent's avatar + voice. agentUserId is users.id; the avatar/voice tables key on the
 * agents RECORD id, so we resolve through the canonical helper first. Best-effort; never throws.
 */
export async function resolveAgentPresenterMedia(
  args: { agentUserId: string; brokerageId: string },
  client?: Svc,
): Promise<PresenterMedia> {
  const svc = client ?? createServiceClient()
  if (!args.agentUserId || !args.brokerageId) return NONE
  try {
    const { resolveUserIdToAgentRecord } = await import("@/lib/kernel/agent-identity-resolver")
    const agentRecordId = await resolveUserIdToAgentRecord(args.agentUserId, args.brokerageId)
    if (!agentRecordId) return NONE

    // Prefer a READY, default avatar asset (the agent's processed D-ID avatar in storage).
    const { data: asset } = await svc.from("agent_avatar_assets")
      .select("did_avatar_id, source_url, voice_id, status, is_default")
      .eq("agent_id", agentRecordId).eq("brokerage_id", args.brokerageId).eq("status", "ready")
      .order("is_default", { ascending: false }).limit(1).maybeSingle()

    // The voice profile carries the ElevenLabs clone + expression + a fallback avatar.
    const { data: profile } = await svc.from("agent_voice_profiles")
      .select("elevenlabs_voice_id, did_avatar_id, did_photo_url, did_video_url, default_expression")
      .eq("agent_id", agentRecordId).order("is_default", { ascending: false }).limit(1).maybeSingle()

    const a = asset as { did_avatar_id: string | null; source_url: string | null; voice_id: string | null } | null
    const p = profile as { elevenlabs_voice_id: string | null; did_avatar_id: string | null; did_photo_url: string | null; did_video_url: string | null; default_expression: string | null } | null

    const actorId = a?.did_avatar_id ?? p?.did_avatar_id ?? null
    const avatarImageUrl = a?.source_url ?? p?.did_video_url ?? p?.did_photo_url ?? null
    const voiceId = p?.elevenlabs_voice_id ?? a?.voice_id ?? null
    const exprRaw = (p?.default_expression ?? "").toLowerCase()
    const expression = (["happy", "neutral", "surprise", "serious"].includes(exprRaw) ? exprRaw : undefined) as PresenterMedia["expression"]

    return {
      actorId,
      avatarImageUrl,
      voiceId,
      expression,
      canRender: !!(actorId || avatarImageUrl),
    }
  } catch {
    return NONE
  }
}
