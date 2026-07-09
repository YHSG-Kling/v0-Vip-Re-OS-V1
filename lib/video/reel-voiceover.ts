// lib/video/reel-voiceover.ts
// ─────────────────────────────────────────────────────────────────────────────
// QUEUE-TIME NARRATION for the reels (owner rule: voice on every video).
// One helper, every producer: synthesize the script through the canonical
// ElevenLabs primitive (the assistant's voice for internal reports, the
// agent's clone for contact-facing — the SAME voice ids the phone lane
// speaks with), upload the mp3 to blob storage, and return the URL the
// render coordinator muxes over the video (voiceover-mixer, before music).
// Best-effort at every step: no voice configured / TTS down / upload
// failure → null → the video ships silent rather than blocked or faked.

export async function prepareReelVoiceover(
  p: { brokerageId: string; narration: string | null | undefined; voiceId: string | null | undefined; renderKey: string },
): Promise<string | null> {
  const text = (p.narration ?? "").trim()
  if (!text || !p.voiceId) return null
  try {
    const { synthesizeSpeech } = await import("@/lib/voice/elevenlabs-tts")
    // brokerageId → the vendor budget gate rides every synthesis (over-ceiling
    // tenants ship silent video instead of an unbounded TTS bill).
    const tts = await synthesizeSpeech({ text: text.slice(0, 2400), voiceId: p.voiceId, brokerageId: p.brokerageId })
    if (!tts.success || !tts.audioBuffer || tts.audioBuffer.length === 0) return null
    const audio = tts.audioBuffer
    const { put } = await import("@vercel/blob")
    const uploaded = await put(
      `voiceovers/${p.brokerageId}/${p.renderKey}.mp3`,
      audio as Buffer,
      { access: "public", contentType: "audio/mpeg", addRandomSuffix: true },
    )
    return uploaded.url
  } catch {
    return null
  }
}
