// lib/video/video-identity.ts
// ─────────────────────────────────────────────────────────────────────────────
// WHO FRONTS THE VIDEO — the owner's rule, made structural:
//
//   · CONTACT-FACING video (property reels, seller updates, buyer reels, the
//     listing pitch) is fronted by the LICENSED HUMAN — agent / team lead /
//     broker — their own D-ID photo and ElevenLabs-cloned voice
//     (agent_voice_profiles). Clients build a relationship with a person.
//
//   · INTERNAL REPORTING video (the Partners' Meeting show, board packet,
//     week-in-review, digests) is fronted by the named AI ASSISTANT
//     (ai_identity_profiles: assistant_name + avatar_url photo +
//     elevenlabs_voice_id, agent → team → brokerage cascade — the SAME
//     identity that answers the phone) so the human is briefed BY their
//     assistant instead of staring into a mirror of themselves.
//
// Honest fallbacks, never a fake: assistant not configured → the human's own
// clone; no clone either → name-only (photo PIP degrades to monogram, media
// degrades to memo). Every field traces to a settings row — nothing invented.

export type VideoPurpose = "contact_facing" | "internal_report"

export interface VideoIdentity {
  /** Whose face/voice fronts the video. */
  kind: "assistant" | "agent" | "none"
  /** D-ID V4 expressive avatar id ("...@avt_...") when the assistant is
   *  configured to present as a MOVING sentiment-aligned host (internal
   *  reports only — the licensed human always fronts clients). */
  expressiveAvatarId?: string | null
  /** Display name spoken/shown in the PIP (assistant_name or the human's name). */
  speakerName: string
  /** Still photo for the D-ID avatar / PIP (assistant avatar_url or did_photo_url). */
  avatarPhotoUrl: string | null
  /** ElevenLabs voice for narration (assistant voice or the human's clone). */
  voiceId: string | null
}

/** The scope's assistant identity via the SAME agent → team → brokerage cascade
 *  the phone reception uses (most-specific wins; nothing hardcoded). */
async function loadAssistantIdentity(svc: any, brokerageId: string, agentUserId: string | null): Promise<{
  name: string | null; photo: string | null; voiceId: string | null; expressiveAvatarId?: string | null
} | null> {
  let profile: any = null
  let teamId: string | null = null
  if (agentUserId) {
    const { data: agent } = await svc.from("agents").select("id, team_id").eq("user_id", agentUserId).maybeSingle()
    if (agent) {
      teamId = (agent as any).team_id ?? null
      const { data: p } = await svc.from("ai_identity_profiles")
        .select("assistant_name, avatar_url, elevenlabs_voice_id, did_expressive_avatar_id")
        .eq("scope_type", "agent").eq("scope_id", (agent as any).id).maybeSingle()
      profile = p
    }
  }
  if (!profile && teamId) {
    const { data: p } = await svc.from("ai_identity_profiles")
      .select("assistant_name, avatar_url, elevenlabs_voice_id, did_expressive_avatar_id")
      .eq("scope_type", "team").eq("scope_id", teamId).maybeSingle()
    profile = p
  }
  if (!profile) {
    const { data: p } = await svc.from("ai_identity_profiles")
      .select("assistant_name, avatar_url, elevenlabs_voice_id, did_expressive_avatar_id")
      .eq("scope_type", "brokerage").eq("scope_id", brokerageId).maybeSingle()
    profile = p
  }
  if (!profile) return null
  return {
    name: profile.assistant_name ?? null,
    photo: profile.avatar_url ?? null,
    voiceId: profile.elevenlabs_voice_id ?? null,
    expressiveAvatarId: profile.did_expressive_avatar_id ?? null,
  }
}

/** The human's own video identity: cloned voice + D-ID photo (their configured
 *  voice profile first, else their default trained profile), name from users. */
async function loadHumanIdentity(svc: any, agentUserId: string): Promise<{
  name: string | null; photo: string | null; voiceId: string | null
}> {
  // pass 12: voice_assistant_config.agent_id and agent_voice_profiles.agent_id
  // are AGENTS-class (agent_voice_profiles.agent_id FKs agents; voice-assistant
  // getVoiceConfig keys config on agents.id) — resolve from the users.id first.
  const [{ data: u }, { data: agentRow }] = await Promise.all([
    svc.from("users").select("first_name, last_name").eq("id", agentUserId).maybeSingle(),
    svc.from("agents").select("id").eq("user_id", agentUserId).maybeSingle(),
  ])
  const name = u ? [(u as any).first_name, (u as any).last_name].filter(Boolean).join(" ") || null : null
  const agentRecordId = (agentRow as any)?.id ?? null
  let vp: any = null
  if (agentRecordId) {
    const { data: cfg } = await svc.from("voice_assistant_config")
      .select("voice_profile_id").eq("agent_id", agentRecordId).maybeSingle()
    if ((cfg as any)?.voice_profile_id) {
      const { data } = await svc.from("agent_voice_profiles")
        .select("did_photo_url, elevenlabs_voice_id").eq("id", (cfg as any).voice_profile_id).maybeSingle()
      vp = data
    }
    if (!vp) {
      const { data } = await svc.from("agent_voice_profiles")
        .select("did_photo_url, elevenlabs_voice_id")
        .eq("agent_id", agentRecordId).eq("is_default", true).limit(1).maybeSingle()
      vp = data
    }
  }
  return { name, photo: vp?.did_photo_url ?? null, voiceId: vp?.elevenlabs_voice_id ?? null }
}

/**
 * Resolve who fronts a video by PURPOSE. internal_report prefers the named
 * assistant (falls back to the human's clone); contact_facing is ALWAYS the
 * licensed human — the assistant never fronts client-facing video.
 */
export async function resolveVideoIdentity(
  svc: any,
  p: { brokerageId: string; agentUserId: string | null; purpose: VideoPurpose },
): Promise<VideoIdentity> {
  if (p.purpose === "internal_report") {
    const assistant = await loadAssistantIdentity(svc, p.brokerageId, p.agentUserId)
    if (assistant && (assistant.voiceId || assistant.photo)) {
      return {
        kind: "assistant",
        speakerName: assistant.name ?? "Your AI Assistant",
        avatarPhotoUrl: assistant.photo,
        voiceId: assistant.voiceId,
        expressiveAvatarId: assistant.expressiveAvatarId ?? null,
      }
    }
    // Assistant not configured → the human's own clone (better than silence).
    if (p.agentUserId) {
      const human = await loadHumanIdentity(svc, p.agentUserId)
      if (human.voiceId || human.photo) {
        return { kind: "agent", speakerName: human.name ?? "Your Team", avatarPhotoUrl: human.photo, voiceId: human.voiceId }
      }
      return { kind: "none", speakerName: human.name ?? "Your AI Team", avatarPhotoUrl: null, voiceId: null }
    }
    return { kind: "none", speakerName: assistant?.name ?? "Your AI Team", avatarPhotoUrl: assistant?.photo ?? null, voiceId: assistant?.voiceId ?? null }
  }

  // contact_facing — the licensed human, full stop.
  if (!p.agentUserId) return { kind: "none", speakerName: "Your Agent", avatarPhotoUrl: null, voiceId: null }
  const human = await loadHumanIdentity(svc, p.agentUserId)
  return {
    kind: human.voiceId || human.photo ? "agent" : "none",
    speakerName: human.name ?? "Your Agent",
    avatarPhotoUrl: human.photo,
    voiceId: human.voiceId,
  }
}
