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
//
// ── REUSED, NOT RE-SYNTHESIZED (m310) ───────────────────────────────────────
// This used to synthesize on EVERY call and host the clip under a path ending
// in a fresh millisecond stamp, so the same script in the same voice cost a
// fresh paid ElevenLabs synthesis, a fresh stored object, and — the part that
// mattered structurally — a fresh URL every single time. voiceover_url is muxed
// into the finished video, so that per-call nonce made the render's artifact
// key un-repeatable: the render cache could never have hit, no matter how
// identical the content was.
//
// So this is one fix with two payoffs. Key the clip on (brokerage, voice,
// script hash), store it at a DERIVED path, and reuse it:
//   · identical narration stops costing money — retries, Asset Manager
//     restarts, and one market update narrated for a whole sphere all reuse a
//     single clip, and
//   · voiceover_url becomes stable, which is what lets the render cache work
//     at all.
//
// "Deterministic" here means semantically identical, said out loud: ElevenLabs
// does not return byte-identical audio for a repeated request. The same words
// in the same voice are what a viewer actually hears, and that is the thing
// being reused.

import type { CharacterAlignment } from "@/lib/video/caption-plan"
import { computeNarrationKey } from "@/lib/remotion/composition-cache"
import { DEFAULT_LANGUAGE } from "@/lib/video/multilingual-reel"

export interface ReelVoiceover {
  url: string
  /** Per-character ElevenLabs alignment when the timestamped path succeeded —
   *  feed to buildCaptionPlan for word-accurate caption cues. */
  alignment: CharacterAlignment | null
  /** True when this clip came from narration_cache — no TTS call was made. */
  reused?: boolean
  /**
   * How long the narration actually runs.
   *
   * Free: the last entry of the alignment we already fetch for captions. The
   * render coordinator needs it because it muxes with -shortest — a script
   * longer than the composition's FIXED duration_frames was silently cut off
   * mid-sentence. NULL when the plain synthesis path returned no alignment, and
   * the mux then keeps its old behaviour rather than guessing a length.
   */
  durationSeconds?: number | null
}

/** The narration's length in seconds, from the alignment. Pure. */
// Module-private since 2026-09-08 — no importer outside this file (category B tranche).
function narrationDurationSeconds(
  alignment: CharacterAlignment | null | undefined,
): number | null {
  const ends = alignment?.character_end_times_seconds
  if (!Array.isArray(ends) || ends.length === 0) return null
  const last = ends[ends.length - 1]
  return Number.isFinite(last) && last > 0 ? Number(last.toFixed(3)) : null
}

/** The synthesis cap. Applied BEFORE hashing so the key names what is actually
 *  spoken, not what was asked for — two scripts differing only past the cap
 *  produce identical audio and must share one clip. */
const MAX_SCRIPT_CHARS = 2400

export async function prepareReelVoiceover(
  p: {
    brokerageId: string; narration: string | null | undefined; voiceId: string | null | undefined; renderKey: string
    /**
     * THE MISSING READER (measured gap, lib/kernel/manager-registry.ts
     * `multilingual_reels` entry: "video_metadata.tts_model / tts_language_code
     * keys it stamps are read by nothing (lib/video/reel-voiceover.ts
     * synthesizes with no modelId/languageCode)"). The ElevenLabs-mapped
     * language code from lib/video/multilingual-reel.ts resolveContactLanguage
     * / localeToElevenLabsLanguage. ADDITIVE — omitted or DEFAULT_LANGUAGE
     * ("en") reproduces the prior call byte-for-byte (auto-detect from text).
     * A non-default value also switches the TTS model to MULTILINGUAL_TTS_MODEL
     * (see below) — the caller must pass an already-translated `narration`
     * (lib/video/multilingual-reel.ts translateReelScript) for this to speak
     * anything but English with a foreign accent.
     */
    languageCode?: string | null
  },
): Promise<ReelVoiceover | null> {
  const text = (p.narration ?? "").trim()
  if (!text || !p.voiceId) return null

  const script = text.slice(0, MAX_SCRIPT_CHARS)
  // A non-default language namespaces the cache key so a Spanish and an
  // English clip of otherwise-identical text (short scripts, transliterated
  // names) can never collide on the same narration_cache row — English's key
  // is UNCHANGED (script hashed alone), so every existing cache entry still hits.
  const scriptForHash = p.languageCode && p.languageCode !== DEFAULT_LANGUAGE ? `${p.languageCode}::${script}` : script
  const scriptHash = computeNarrationKey(p.voiceId, scriptForHash)

  // ── Reuse before spend ────────────────────────────────────────────────────
  const cached = await loadCachedNarration(p.brokerageId, p.voiceId, scriptHash)
  if (cached) {
    return {
      url: cached.url, alignment: cached.alignment, reused: true,
      durationSeconds: cached.durationSeconds ?? narrationDurationSeconds(cached.alignment),
    }
  }

  try {
    const { synthesizeSpeech, synthesizeSpeechWithTimestamps } = await import("@/lib/voice/elevenlabs-tts")
    // brokerageId → the vendor budget gate rides every synthesis (over-ceiling
    // tenants ship silent video instead of an unbounded TTS bill).
    let audio: Buffer | null = null
    let alignment: CharacterAlignment | null = null
    // languageCode omitted for "en"/unset — synthesizeSpeechWithTimestamps
    // already treats an absent languageCode as "auto-detect", so this is a
    // no-op for every existing (English) caller.
    const languageCode = p.languageCode && p.languageCode !== "en" ? p.languageCode : undefined
    // WAVE 52 FIX: a non-default language must also switch the MODEL, not just
    // add a param. The default model (elevenlabs-tts.ts's "eleven_monolingual_v1")
    // is English-only — it cannot speak a translated script at all. And per the
    // research finding now in elevenlabs-tts.ts's header, `language_code` itself
    // is silently dropped by that primitive for any model outside ElevenLabs'
    // enforcement allowlist (never multilingual_v2) — so sending it here was
    // never what made a non-English narration audible; the MODEL is. Without
    // this, every non-English caller below (wired for the first time this wave)
    // would have synthesized translated text through the English-only model.
    const { MULTILINGUAL_TTS_MODEL } = await import("@/lib/video/multilingual-reel")
    const modelId = languageCode ? MULTILINGUAL_TTS_MODEL : undefined
    const stamped = await synthesizeSpeechWithTimestamps({ text: script, voiceId: p.voiceId, brokerageId: p.brokerageId, languageCode, modelId })
    if (stamped.success && stamped.audioBuffer) {
      audio = stamped.audioBuffer
      alignment = (stamped.alignment as CharacterAlignment | null) ?? null
    } else {
      const tts = await synthesizeSpeech({ text: script, voiceId: p.voiceId, brokerageId: p.brokerageId, languageCode, modelId })
      if (!tts.success || !tts.audioBuffer || tts.audioBuffer.length === 0) return null
      audio = tts.audioBuffer
    }
    // SUPABASE STORAGE hosts our media (owner rule); Blob is the fallback.
    // The path is DERIVED FROM THE SCRIPT, not from the clock: hostRenderedMedia
    // upserts, so a re-synthesis of the same script overwrites its own object
    // rather than littering storage with near-duplicate mp3s.
    const { createServiceClient } = await import("@/lib/supabase/service")
    const { hostRenderedMedia } = await import("@/lib/remotion/media-host")
    const svc = createServiceClient()
    const url = await hostRenderedMedia(
      svc,
      `voiceovers/${p.brokerageId}/${scriptHash}.mp3`,
      audio, "audio/mpeg",
    )

    // Record it so the next identical script costs nothing. Best-effort: a
    // cache-write failure must not lose a clip we already paid for and hosted.
    const durationSeconds = narrationDurationSeconds(alignment)
    await storeCachedNarration({
      brokerageId: p.brokerageId, voiceId: p.voiceId, scriptHash, script,
      audioUrl: url, alignment, renderKey: p.renderKey, durationSeconds,
    })

    return { url, alignment, reused: false, durationSeconds }
  } catch {
    return null
  }
}

/**
 * Cache read. Bumps hit_count so the saving is a counted fact on the Asset
 * Manager's cache board rather than an assertion in a comment.
 */
async function loadCachedNarration(
  brokerageId: string, voiceId: string, scriptHash: string,
): Promise<{ url: string; alignment: CharacterAlignment | null; durationSeconds: number | null } | null> {
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()
    const { data } = await svc.from("narration_cache")
      .select("id, audio_url, alignment, hit_count, duration_seconds")
      .eq("brokerage_id", brokerageId)
      .eq("voice_id", voiceId)
      .eq("script_hash", scriptHash)
      .maybeSingle()
    if (!data) return null
    const row = data as {
      id: string; audio_url: string; alignment: unknown
      hit_count: number; duration_seconds: number | null
    }
    if (!row.audio_url) return null
    await svc.from("narration_cache")
      .update({ hit_count: (row.hit_count ?? 0) + 1, last_used_at: new Date().toISOString() })
      .eq("id", row.id)
    return {
      url: row.audio_url,
      alignment: (row.alignment as CharacterAlignment | null) ?? null,
      durationSeconds: row.duration_seconds ?? null,
    }
  } catch {
    return null
  }
}

async function storeCachedNarration(p: {
  brokerageId: string; voiceId: string; scriptHash: string; script: string
  audioUrl: string; alignment: CharacterAlignment | null; renderKey: string
  durationSeconds: number | null
}): Promise<void> {
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()
    // Upsert on the unique (brokerage, voice, script_hash): two producers can
    // race on the same script, and the loser must UPDATE the row rather than
    // fail the whole synthesis on a constraint violation.
    await svc.from("narration_cache").upsert({
      brokerage_id: p.brokerageId,
      voice_id: p.voiceId,
      script_hash: p.scriptHash,
      script_preview: p.script.slice(0, 200),
      script_chars: p.script.length,
      audio_url: p.audioUrl,
      alignment: p.alignment as unknown as Record<string, unknown> | null,
      first_render_key: p.renderKey,
      duration_seconds: p.durationSeconds,
      last_used_at: new Date().toISOString(),
    }, { onConflict: "brokerage_id,voice_id,script_hash" })
  } catch { /* the clip is already hosted; the cache row is the optimization */ }
}
