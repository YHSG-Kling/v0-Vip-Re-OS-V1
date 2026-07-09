// lib/video/reel-voiceover.ts
// ─────────────────────────────────────────────────────────────────────────────
// QUEUE-TIME NARRATION for the reels (owner rule: voice on every video).
// One helper, every producer: synthesize the script through the canonical
// ElevenLabs primitive (the assistant's voice for internal reports, the
// agent's clone for contact-facing — the SAME voice ids the phone lane
// speaks with), host the mp3 on SUPABASE STORAGE, and return the URL the
// render coordinator muxes over the video (voiceover-mixer, before music).
//
// WORD-SYNCED CAPTIONS: the timestamped TTS path is PREFERRED — it returns
// the same mp3 plus per-character alignment, which buildCaptionPlan turns
// into word-accurate cues for the composition's CaptionLayer. Any failure
// falls back to plain synthesis (captions then even-distribute honestly).
// Best-effort at every step: no voice / TTS down / upload failure → null —
// the video ships silent rather than blocked or faked.

import type { CharacterAlignment } from "@/lib/video/caption-plan"

export interface ReelVoiceover {
  url: string
  /** Per-character ElevenLabs alignment when the timestamped path succeeded —
   *  feed to buildCaptionPlan for word-accurate caption cues. */
  alignment: CharacterAlignment | null
}

export async function prepareReelVoiceover(
  p: { brokerageId: string; narration: string | null | undefined; voiceId: string | null | undefined; renderKey: string },
): Promise<ReelVoiceover | null> {
  const text = (p.narration ?? "").trim()
  if (!text || !p.voiceId) return null
  try {
    const { synthesizeSpeech, synthesizeSpeechWithTimestamps } = await import("@/lib/voice/elevenlabs-tts")
    // brokerageId → the vendor budget gate rides every synthesis (over-ceiling
    // tenants ship silent video instead of an unbounded TTS bill).
    const script = text.slice(0, 2400)
    let audio: Buffer | null = null
    let alignment: CharacterAlignment | null = null
    const stamped = await synthesizeSpeechWithTimestamps({ text: script, voiceId: p.voiceId, brokerageId: p.brokerageId })
    if (stamped.success && stamped.audioBuffer) {
      audio = stamped.audioBuffer
      alignment = (stamped.alignment as CharacterAlignment | null) ?? null
    } else {
      const tts = await synthesizeSpeech({ text: script, voiceId: p.voiceId, brokerageId: p.brokerageId })
      if (!tts.success || !tts.audioBuffer || tts.audioBuffer.length === 0) return null
      audio = tts.audioBuffer
    }
    // SUPABASE STORAGE hosts our media (owner rule); Blob is the fallback.
    const { createServiceClient } = await import("@/lib/supabase/service")
    const { hostRenderedMedia } = await import("@/lib/remotion/media-host")
    const url = await hostRenderedMedia(
      createServiceClient(),
      `voiceovers/${p.brokerageId}/${p.renderKey}-${Date.now()}.mp3`,
      audio, "audio/mpeg",
    )
    return { url, alignment }
  } catch {
    return null
  }
}
