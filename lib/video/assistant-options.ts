// lib/video/assistant-options.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ASSISTANT'S FACE + VOICE OPTIONS (owner rule: choosing the assistant's
// avatar and voice offers real OPTIONS on both). ONE canonical module:
//
//   · VOICES — curated ELEVENLABS PREMADE voices (the platform's single TTS
//     vendor; the humans' clones are made in the Studio, the ASSISTANT picks
//     from these professional presets). Stable public premade voice ids from
//     the ElevenLabs voice library, labeled by the persona they carry.
//   · FACES — AI-generated professional headshot OPTIONS through the existing
//     image-gen rail (blob-hosted): one click renders a small gallery of
//     distinct personas; the broker picks one and it becomes
//     ai_identity_profiles.avatar_url (the face on reception, report videos,
//     and presenter PIPs). Never a stock photo of a real person.
//
// The human agents' OWN avatars/voices are untouched by this module — those
// are created in the Twin Studio (photo/video → D-ID; voice → ElevenLabs
// clone). This module is only the ASSISTANT persona's wardrobe.

export interface AssistantVoiceOption {
  voiceId: string
  label: string
  /** How it reads on the phone + narration — shown in the picker. */
  style: string
  gender: "male" | "female"
  accent: string
}

/**
 * THE ONE curated ElevenLabs PREMADE (stock) voice list (stable public ids).
 *
 * MERGED SURVIVOR. `lib/voice/voice-resolver.ts:GENERIC_VOICES` was a SECOND
 * hand-maintained list of the same thing — 8 entries, 5 of them the same ids as
 * these, with the same job (offer a professional stock voice to somebody who
 * does not want a clone). Two lists meant a voice could be offered on the
 * Assistant settings page and be missing from the AI Identity picker, and a
 * correction to one silently did not reach the other.
 *
 * The extra voices GENERIC_VOICES carried (Elli, Arnold, Sam) and the extra
 * fields it carried (gender, accent) are ported HERE, and GENERIC_VOICES is now
 * a derived projection of this array — same name, same shape, same call sites,
 * zero duplicated data. This module is the survivor because it is client-safe:
 * voice-resolver.ts carries `import "server-only"`, so a client-side picker can
 * never import its list directly.
 */
export const ASSISTANT_VOICE_OPTIONS: AssistantVoiceOption[] = [
  { voiceId: "21m00Tcm4TlvDq8ikWAM", label: "Rachel", style: "Warm, professional female — the classic concierge", gender: "female", accent: "American" },
  { voiceId: "EXAVITQu4vr4xnSDxMaL", label: "Sarah", style: "Soft, reassuring female — great for client updates", gender: "female", accent: "American" },
  { voiceId: "AZnzlk1XvdvUeBnXmlld", label: "Domi", style: "Confident, energetic female — market updates with punch", gender: "female", accent: "American" },
  { voiceId: "MF3mGyEYCl7XYWbV9V6O", label: "Elli", style: "Calm, articulate female — steady long-form narration", gender: "female", accent: "American" },
  { voiceId: "pNInz6obpgDQGcFmaJgB", label: "Adam", style: "Deep, steady male — authoritative reports", gender: "male", accent: "American" },
  { voiceId: "ErXwobaYiN019PkySvjV", label: "Antoni", style: "Well-rounded male — friendly explainer tone", gender: "male", accent: "American" },
  { voiceId: "TxGEqnHWrfWFTfGW9XjX", label: "Josh", style: "Young, upbeat male — social-first energy", gender: "male", accent: "American" },
  { voiceId: "VR6AewLTigWG4xSOukaG", label: "Arnold", style: "Authoritative, mature male — gravitas for market briefings", gender: "male", accent: "American" },
  { voiceId: "yoZ06aMxZJJ28mfd3POQ", label: "Sam", style: "Approachable, neutral male — the everyday assistant", gender: "male", accent: "American" },
]

/** PURE: label lookup for a saved assistant voice id (null → not a preset —
 *  e.g. a custom/cloned voice — the picker shows it honestly as custom). */
export function assistantVoiceLabel(voiceId: string | null | undefined): string | null {
  if (!voiceId) return null
  return ASSISTANT_VOICE_OPTIONS.find((v) => v.voiceId === voiceId)?.label ?? null
}

/** The distinct persona briefs the headshot generator renders — variety by
 *  DESIGN so the gallery offers a real choice, not four near-duplicates. */
export const ASSISTANT_FACE_BRIEFS: Array<{ key: string; prompt: string }> = [
  { key: "warm_professional", prompt: "Professional corporate headshot portrait of a warm, approachable woman in her 30s as an AI assistant persona for a real estate brokerage: friendly smile, modern business attire, soft studio lighting, clean light-gray background, photorealistic, head-and-shoulders, centered" },
  { key: "sharp_concierge", prompt: "Professional corporate headshot portrait of a polished man in his 30s as an AI concierge persona for a real estate brokerage: confident subtle smile, tailored navy blazer, soft studio lighting, clean neutral background, photorealistic, head-and-shoulders, centered" },
  { key: "friendly_modern", prompt: "Professional corporate headshot portrait of a friendly woman in her 40s as an AI assistant persona for a real estate brokerage: genuine warm expression, smart-casual attire, bright airy studio lighting, clean white background, photorealistic, head-and-shoulders, centered" },
  { key: "approachable_advisor", prompt: "Professional corporate headshot portrait of an approachable man in his 40s as an AI advisor persona for a real estate brokerage: kind expression, light-gray suit no tie, soft even studio lighting, clean background, photorealistic, head-and-shoulders, centered" },
]

export interface AssistantFaceOption { key: string; imageUrl: string }

// generateAssistantFaceOptions() moved to ./assistant-faces (server-only) — it
// pulls the image-generation rail (which imports "server-only"), and this
// module is imported by the client component AIIdentityEditor.tsx. Keeping the
// data (voices/face briefs/avatars) here client-safe; the server action
// app/actions/ai-identity.ts imports the generator from ./assistant-faces.

/** D-ID V4 EXPRESSIVE stock avatars the assistant can present AS — a moving,
 *  sentiment-aligned host instead of a still photo PIP. Ids carry "@avt_"
 *  (the marker lib/did routes to /expressives). The documented public stock
 *  id ships as the starter; a custom field accepts any expressive id the
 *  tenant licenses. NEVER used for client-facing video (the licensed human
 *  fronts clients — the finish-spec rule stands). */
export const ASSISTANT_EXPRESSIVE_AVATARS: Array<{ avatarId: string; label: string; style: string }> = [
  { avatarId: "public_amber_casual@avt_PfMblk", label: "Amber", style: "Casual, warm — the approachable concierge on camera" },
]
