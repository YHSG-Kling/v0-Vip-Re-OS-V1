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
}

/** Curated ElevenLabs PREMADE voices (stable public ids). */
export const ASSISTANT_VOICE_OPTIONS: AssistantVoiceOption[] = [
  { voiceId: "21m00Tcm4TlvDq8ikWAM", label: "Rachel", style: "Warm, professional female — the classic concierge" },
  { voiceId: "EXAVITQu4vr4xnSDxMaL", label: "Sarah", style: "Soft, reassuring female — great for client updates" },
  { voiceId: "AZnzlk1XvdvUeBnXmlld", label: "Domi", style: "Confident, energetic female — market updates with punch" },
  { voiceId: "pNInz6obpgDQGcFmaJgB", label: "Adam", style: "Deep, steady male — authoritative reports" },
  { voiceId: "ErXwobaYiN019PkySvjV", label: "Antoni", style: "Well-rounded male — friendly explainer tone" },
  { voiceId: "TxGEqnHWrfWFTfGW9XjX", label: "Josh", style: "Young, upbeat male — social-first energy" },
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

/** Generate the headshot GALLERY through the existing image-gen rail.
 *  Best-effort per option — a single generation failure shrinks the gallery
 *  instead of blocking it; zero successes returns [] (the UI says so). */
export async function generateAssistantFaceOptions(count = 3): Promise<AssistantFaceOption[]> {
  const briefs = ASSISTANT_FACE_BRIEFS.slice(0, Math.max(1, Math.min(count, ASSISTANT_FACE_BRIEFS.length)))
  const { generateImage } = await import("@/lib/ai/image-generation")
  const results = await Promise.all(briefs.map(async (b) => {
    try {
      const img = await generateImage({ prompt: b.prompt, purpose: "generic", size: "1024x1024", style: "natural" })
      return img.success && img.imageUrl ? { key: b.key, imageUrl: img.imageUrl } : null
    } catch { return null }
  }))
  return results.filter((r): r is AssistantFaceOption => !!r)
}
