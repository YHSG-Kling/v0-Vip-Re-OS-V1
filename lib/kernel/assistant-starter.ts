// lib/kernel/assistant-starter.ts
// ─────────────────────────────────────────────────────────────────────────────
// DAY-ONE ASSISTANT WITH A FACE. ai_identity_profiles was EMPTY in production —
// a new tenant had no named assistant until they found the settings page,
// which meant: no assistant name on reception calls, no host for the weekly
// show, no presenter photo on report videos. This seeds a STARTER identity
// the moment a brokerage signs up (best-effort, never blocks signup):
//
//   · a name ("Aria") + persona label — the settings page becomes
//     PERSONALIZATION ("rename your assistant") instead of setup
//   · a professional AI-generated headshot (the existing image-gen rail,
//     blob-hosted) so the presenter PIP has a face on day one
//   · the professional fallback ElevenLabs voice — so the first weekly show
//     is NARRATED from the first Monday (a cloned voice replaces it whenever
//     the broker configures one)
//
// Idempotent: an existing brokerage-scope profile is NEVER overwritten (a
// tenant's chosen identity is theirs). Headshot generation failing → the
// profile seeds without a photo (monogram PIP) — honest, not blocked.

export const STARTER_ASSISTANT_NAME = "Aria"
export const STARTER_PERSONA_LABEL = "AI Real Estate Assistant"

export interface SeedAssistantResult { seeded: boolean; withPhoto: boolean; reason?: string }

export async function seedStarterAssistant(svc: any, brokerageId: string): Promise<SeedAssistantResult> {
  const { data: existing } = await svc.from("ai_identity_profiles").select("id")
    .eq("scope_type", "brokerage").eq("scope_id", brokerageId).limit(1).maybeSingle()
  if (existing) return { seeded: false, withPhoto: false, reason: "profile exists — tenant identity is theirs" }

  // Headshot — best-effort through the existing image-gen rail (blob-hosted).
  let photoUrl: string | null = null
  try {
    const { generateImage } = await import("@/lib/ai/image-generation")
    const img = await generateImage({
      prompt: "Professional corporate headshot portrait of a friendly, approachable AI assistant persona for a real estate brokerage: warm smile, business attire, soft studio lighting, clean neutral background, photorealistic, centered head-and-shoulders composition",
      purpose: "generic",
      size: "1024x1024",
      style: "natural",
    })
    if (img.success && img.imageUrl) photoUrl = img.imageUrl
  } catch { /* seed without a face — monogram PIP until one is set */ }

  const { FALLBACK_VOICE_ID } = await import("@/lib/voice/elevenlabs-tts")
  const { error } = await svc.from("ai_identity_profiles").insert({
    scope_type: "brokerage", scope_id: brokerageId, brokerage_id: brokerageId,
    assistant_name: STARTER_ASSISTANT_NAME,
    persona_label: STARTER_PERSONA_LABEL,
    avatar_url: photoUrl,
    elevenlabs_voice_id: FALLBACK_VOICE_ID,
    active: true,
  })
  if (error) return { seeded: false, withPhoto: false, reason: error.message }

  // MEET YOUR ASSISTANT — a one-time 20-second intro video (D-ID from the
  // generated headshot + the starter narration voice) delivered to the
  // broker: onboarding magic on day one. Best-effort — a render failure
  // never blocks the seed; the assistant still answers the phone.
  try {
    if (photoUrl) {
      const { data: b } = await svc.from("brokerages").select("name").eq("id", brokerageId).maybeSingle()
      const brokName = (b as any)?.name ?? "your brokerage"
      const { generateVideo } = await import("@/lib/did")
      const intro = await generateVideo({
        script: `Hi, I'm ${STARTER_ASSISTANT_NAME} — the AI assistant for ${brokName}. I answer your calls, brief your mornings, host your weekly show, and keep your clients in the loop. You can rename me, change my face, or pick my voice any time in settings. Let's get to work.`,
        voiceId: FALLBACK_VOICE_ID, avatarImageUrl: photoUrl,
        agentUserId: null as any, brokerageId,
      })
      if (intro?.videoUrl) {
        const { data: admins } = await svc.from("users").select("id")
          .eq("brokerage_id", brokerageId).in("user_type", ["broker", "admin"]).limit(3)
        for (const u of ((admins ?? []) as any[])) {
          await svc.from("notifications").insert({
            user_id: u.id, brokerage_id: brokerageId, type: "assistant_intro",
            title: `Meet ${STARTER_ASSISTANT_NAME} — your AI assistant`,
            body: `${STARTER_ASSISTANT_NAME} introduces itself on camera: ${intro.videoUrl}`,
            priority: "medium", channel: "in_app", is_read: false,
          }).then(undefined, () => {})
        }
      }
    }
  } catch { /* the intro is a delight, not a dependency */ }

  return { seeded: true, withPhoto: !!photoUrl }
}
