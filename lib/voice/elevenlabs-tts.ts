/**
 * lib/voice/elevenlabs-tts.ts
 *
 * Shared ElevenLabs Text-to-Speech primitive.
 *
 * Used by:
 *   - app/actions/brief-audio.ts        (morning brief read aloud in agent's voice)
 *   - app/api/internal/voice-tts/route.ts (real-time assistant TTS)
 *   - app/actions/podcast-generation.ts  (legacy — to be migrated)
 *   - lib/video/reel-voiceover.ts        (avatar/reel narration, multilingual)
 *
 * Default voice settings prioritize naturalness over speed. Callers can
 * override via `voiceSettings`. Returns raw mp3 bytes; caller decides
 * whether to stream, cache, or upload to blob storage.
 *
 * RESEARCH FINDING (wave 52, 2026-09-10 — Exa web search against ElevenLabs'
 * own API reference, elevenlabs-python reference.md, and the convert /
 * convert-with-timestamps endpoint docs): `language_code` is NOT a general
 * "precision hint" for every model, despite how earlier comments in this repo
 * described it. Per ElevenLabs: "Currently only Turbo v2.5 and Flash v2.5
 * support language enforcement. For other models, an error will be returned
 * if language code is provided" (the plain /convert endpoint — used by
 * synthesizeSpeech below) — `eleven_multilingual_v2` is one of those "other
 * models" and is NOT in the enforcement allowlist. The /convert-with-timestamps
 * endpoint (synthesizeSpeechWithTimestamps) is more forgiving — "if the model
 * does not support the provided language code, it will be ignored" — but
 * still names multilingual_v2 as unsupported for the param. Net effect: a
 * caller that sets modelId="eleven_multilingual_v2" (this repo's multilingual
 * constant, lib/video/multilingual-reel.ts MULTILINGUAL_TTS_MODEL) AND passes
 * languageCode risked a hard 400 on the plain-convert path and a silent no-op
 * on the with-timestamps path either way — never the "precision hint" the
 * comments described. FIX: `language_code` is now sent to the API ONLY when
 * modelId names a model on ElevenLabs' actual enforcement allowlist
 * (LANGUAGE_ENFORCEMENT_MODELS below); for every other model (including the
 * multilingual one this repo uses for avatar reels) the param is dropped
 * before the request — auto-detection from the (already-translated, see
 * lib/video/multilingual-reel.ts translateReelScript) input text is what
 * actually selects the language for that model, so dropping the param loses
 * nothing multilingual_v2 was ever honoring. ADDITIVE / SAFE: every existing
 * caller that never set languageCode is byte-for-byte unaffected; a caller
 * that WAS setting languageCode against multilingual_v2 stops risking the 400
 * and gets the same auto-detected audio it always effectively got.
 */

import "server-only"
import { convertSpeech, convertSpeechWithTimestamps } from "@/lib/providers/elevenlabs/client"
import {
  ELEVENLABS_REALISM_VOICE_SETTINGS,
  ELEVENLABS_TEXT_NORMALIZATION,
  ELEVENLABS_NARRATION_MODEL_ID,
  ELEVENLABS_PHONE_MODEL_ID,
} from "@/lib/video/realism-profile"

// THE DEFAULT MODEL IS NO LONGER THE OLDEST ONE (lane 77C, blind spot (4)).
// All three primitives below fell back to a bare "eleven_monolingual_v1"
// literal whenever a caller named no modelId — and nine non-video callers
// (brief, standup, week-in-review, podcast, letter audio, presentation
// narration, the voice preview, the /api/elevenlabs/tts route, lib/did's
// audio-only path) named none, so every one of them spoke through the model
// the realism research in lib/video/realism-profile.ts retired for narration.
// Every caller now resolves its lane through elevenLabsModelForLane (the ONE
// selector, §6); these fallbacks exist for the NEXT caller that forgets, and
// they pick the register each primitive actually serves: the two BUFFERED
// paths are scripted narration (v3), the STREAMING path is the real-time
// register (Flash v2.5 — v3 is "not suitable for real-time" per ElevenLabs).
// Never a monolingual_v1 literal again.
const DEFAULT_BUFFERED_MODEL_ID = ELEVENLABS_NARRATION_MODEL_ID
const DEFAULT_STREAMING_MODEL_ID = ELEVENLABS_PHONE_MODEL_ID

// The streaming path (synthesizeSpeechStream) keeps its OWN literal
// `https://api.elevenlabs.io/...` URL rather than sharing a base-URL
// constant — see that function's header for why (elevenlabs-egress-guard.ts
// positive control).

/**
 * Models ElevenLabs actually enforces `language_code` on (per the research
 * finding above). Everything else — including `eleven_multilingual_v2`, the
 * model this repo uses for avatar/reel narration — either 400s (plain
 * /convert) or silently ignores the param (/convert-with-timestamps), so it
 * is never sent to them. Extend this set only when ElevenLabs documents a
 * new model on the enforcement allowlist.
 */
const LANGUAGE_ENFORCEMENT_MODELS = new Set(["eleven_turbo_v2_5", "eleven_flash_v2_5"])

/** PURE. The `language_code` body field to spread into an ElevenLabs request —
 *  `{}` whenever the model doesn't actually honor it, so a caller can never
 *  reintroduce the 400/no-op by hand at a new call site. */
function languageCodeField(modelId: string, languageCode: string | null | undefined): { language_code: string } | Record<string, never> {
  return languageCode && LANGUAGE_ENFORCEMENT_MODELS.has(modelId) ? { language_code: languageCode } : {}
}

export interface VoiceSettings {
  stability?: number          // 0-1, lower = more variable
  similarity_boost?: number   // 0-1, higher = stays closer to original voice
  style?: number              // 0-1, expressiveness
  use_speaker_boost?: boolean
}

// REALISM (wave 55): these three were ElevenLabs' own bare API defaults
// (stability 0.5 / similarity_boost 0.75 / style 0) — nobody had ever chosen
// them for realism. ELEVENLABS_REALISM_VOICE_SETTINGS (lib/video/
// realism-profile.ts, see its header for the 2026-09-11 research) is the ONE
// tuned constant every avatar/voice call site now shares (§6) — including
// lib/providers/dispatch.ts's D-ID avatar-video TTS leg, which sent NO
// voice_settings at all before this wave. `apply_text_normalization` is added
// alongside it below so numbers/dates in a script are spelled out correctly.
const DEFAULT_VOICE_SETTINGS: Required<VoiceSettings> = ELEVENLABS_REALISM_VOICE_SETTINGS

/** ElevenLabs default professional voice (Rachel) — fallback when no clone */
export const FALLBACK_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"

export interface SynthesizeSpeechInput {
  text: string
  voiceId?: string | null
  voiceSettings?: VoiceSettings
  modelId?: string             // resolve it via elevenLabsModelForLane(lane) — see DEFAULT_BUFFERED_MODEL_ID for what an omitted value means
  /**
   * BCP-47 language code for the multilingual model (e.g. 'es', 'pt', 'zh', 'fr').
   * Only honoured when modelId is 'eleven_multilingual_v2' (or any future multilingual
   * model). When omitted, ElevenLabs auto-detects the language from the input text —
   * which is the correct behaviour for the multilingual model. Existing callers that
   * do NOT supply this field are UNAFFECTED (the default model stays monolingual_v1).
   *
   * ADDITIVE: no existing caller is broken — the field is optional and ignored by
   * the monolingual model endpoint.
   */
  languageCode?: string | null
  /** When set, the synthesis cost is recorded to the unified vendor ledger. */
  brokerageId?: string | null
  /**
   * ElevenLabs' `output_format` query param — ONLY consulted by
   * synthesizeSpeechStream (wave 62, the Simli live-agent leg needs raw
   * PCM16 mono 16kHz to feed simli-client's sendAudioData, not mp3). Every
   * pre-wave-62 caller leaves this unset and gets the exact same mp3 stream
   * as before (additive, §6 — one streaming function, not a second one for
   * PCM). synthesizeSpeech (the buffered/non-streaming variant) does not
   * accept this — no caller of it needs raw PCM.
   */
  outputFormat?: "pcm_16000"
  /** Wave 156 (156S): ONE charge per key — a repeat of the same synthesis replays its receipt and is not billed again
   *  (the replay returns no audio: the caller already holds the first result). Omit for an unkeyed call. */
  idempotencyKey?: string | null
}

export interface SynthesizeSpeechResult {
  success: boolean
  audioBuffer?: Buffer
  error?: string
  /** Detail useful for fallback decisions (e.g. quota exceeded → retry with browser TTS) */
  errorCode?: "no_api_key" | "rate_limit" | "quota" | "auth" | "voice_not_found" | "unknown" | "replay_unavailable"
  /** Wave 156 (156S): true when this is the SAME audio a keyed earlier call produced (no new provider call, no charge). */
  replayed?: boolean
}

/**
 * Synthesize speech via ElevenLabs API. Returns mp3 audio bytes.
 *
 * Throws never — returns { success: false, errorCode } on failure so callers
 * can degrade gracefully (e.g. fall back to browser TTS or skip audio).
 */
export async function synthesizeSpeech(
  input: SynthesizeSpeechInput
): Promise<SynthesizeSpeechResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) {
    return { success: false, errorCode: "no_api_key", error: "ELEVENLABS_API_KEY not set" }
  }

  const voiceId = input.voiceId || FALLBACK_VOICE_ID
  const settings = { ...DEFAULT_VOICE_SETTINGS, ...(input.voiceSettings ?? {}) }

  try {
    // PLATFORM-owned — one ELEVENLABS_API_KEY; per-subscriber voice rides as voiceId.
    // Buffered synthesis goes through the official server SDK adapter
    // (lib/providers/elevenlabs/client.ts) — same endpoint, same price, no
    // more hand-rolled request/response mapping.
    const modelId = input.modelId ?? DEFAULT_BUFFERED_MODEL_ID
    const langField = languageCodeField(modelId, input.languageCode)
    // THE PAID DOOR (wave 156, lane 156S): budget before the call, a receipt, the spend booked only on success
    // (lib/vendor-governance/paid-egress.ts runPaidEgress). Over budget → "quota", the provider never reached;
    // callers fall back to browser TTS on quota. A call with no tenant is now booked as platform spend.
    // A KEYED call keeps one private copy of the audio and its receipt names it, so a replay under the same key returns
    // THE SAME audio with no new provider call and no new charge (wave 156, 156S round 4 — never an empty replay).
    const replayKey = input.idempotencyKey ?? null
    let replayRef: string | null = null
    const paid = await runTtsDoor(input, "voice_tts", { voice_id: voiceId }, async () => { const r = await convertSpeech(apiKey, {
      voiceId,
      text: input.text,
      modelId,
      voiceSettings: settings,
      applyTextNormalization: ELEVENLABS_TEXT_NORMALIZATION,
      languageCode: "language_code" in langField ? langField.language_code : null,
    })
      if (replayKey && r.ok && r.data) {
        const { storeReplayCopy } = await import("@/lib/vendor-governance/paid-egress")
        replayRef = await storeReplayCopy({ brokerageId: input.brokerageId ?? null, key: replayKey, bytes: r.data, contentType: "audio/mpeg", ext: "mp3" }).catch(() => null)
      }
      return r
    }, (r) => r.ok && !!r.data, () => replayRef)
    if (!paid.ran && paid.reason === "replay") {
      const { loadReplayCopy } = await import("@/lib/vendor-governance/paid-egress")
      const first = await loadReplayCopy(paid.providerRef, input.brokerageId ?? null)
      if (first) return { success: true, audioBuffer: first, replayed: true }
      return { success: false, errorCode: "replay_unavailable", error: "This audio was already generated and paid for, but its stored copy cannot be served again. Ask to generate it again — that is a new, budget-checked call." }
    }
    if (!paid.ran) return { success: false, errorCode: "quota", error: paid.reason === "budget_refused" ? "Vendor budget exceeded — TTS paused" : paid.detail }
    const res = paid.result

    if (!res.ok || !res.data) {
      const body = res.error ?? ""
      const code: SynthesizeSpeechResult["errorCode"] =
        res.status === 401 || res.status === 403
          ? "auth"
          : res.status === 422 && /voice/i.test(body)
          ? "voice_not_found"
          : res.status === 429
          ? "rate_limit"
          : /quota/i.test(body)
          ? "quota"
          : "unknown"
      return {
        success: false,
        errorCode: code,
        error: `ElevenLabs (${res.status ?? "—"}): ${body || "request failed"}`,
      }
    }

    // The spend (ElevenLabs bills per character synthesized) was booked by the door above, on success only.
    const arrayBuffer = res.data
    return { success: true, audioBuffer: Buffer.from(arrayBuffer) }
  } catch (err: any) {
    return { success: false, errorCode: "unknown", error: err?.message ?? "Network error" }
  }
}

// ─── Timestamped TTS (caption burn-in) ──────────────────────────────────────

/**
 * Per-character alignment as returned by ElevenLabs'
 * /v1/text-to-speech/{voice}/with-timestamps endpoint
 * (CharacterAlignmentResponseModel). The three arrays are parallel: the i-th
 * character is spoken from character_start_times_seconds[i] to
 * character_end_times_seconds[i]. Mirrors lib/video/caption-plan.ts
 * CharacterAlignment so the planner can consume it directly.
 */
export interface CharacterAlignment {
  characters: string[]
  character_start_times_seconds: number[]
  character_end_times_seconds: number[]
}

export interface SynthesizeSpeechWithTimestampsResult extends SynthesizeSpeechResult {
  /** Per-character alignment for the original text — present on success. Used by
   *  buildCaptionPlan to place WORD-ACCURATE captions. */
  alignment?: CharacterAlignment
}

// The raw with-timestamps response shape (AudioWithTimestampsResponseModel,
// snake_case) is no longer hand-mapped here — the SDK adapter
// (lib/providers/elevenlabs/client.ts ConvertSpeechWithTimestampsData) returns
// the camelCase `audioBase64`/`alignment`/`normalizedAlignment` shape directly.

/**
 * synthesizeSpeechWithTimestamps — PREFERRED path for SOUND-OFF CAPTIONS.
 *
 * A SIBLING of synthesizeSpeech (the default buffered path is UNCHANGED). Calls
 * the `/v1/text-to-speech/{voice}/with-timestamps` endpoint, which returns the
 * full mp3 as base64 PLUS per-character alignment. We decode the audio to a
 * Buffer (identical contract to synthesizeSpeech.audioBuffer so the existing
 * upload/compose path is unchanged) AND return the alignment so captions can be
 * placed at the REAL frame each word is spoken.
 *
 * Throws never — returns { success: false, errorCode } on failure so callers can
 * fall back to synthesizeSpeech (no alignment → even-distribution caption ESTIMATE).
 */
export async function synthesizeSpeechWithTimestamps(
  input: SynthesizeSpeechInput,
): Promise<SynthesizeSpeechWithTimestampsResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) {
    return { success: false, errorCode: "no_api_key", error: "ELEVENLABS_API_KEY not set" }
  }

  const voiceId = input.voiceId || FALLBACK_VOICE_ID
  const settings = { ...DEFAULT_VOICE_SETTINGS, ...(input.voiceSettings ?? {}) }

  try {
    // PLATFORM-owned — the with-timestamps leg goes through the same SDK
    // adapter as the buffered path (lib/providers/elevenlabs/client.ts).
    const modelId = input.modelId ?? DEFAULT_BUFFERED_MODEL_ID
    const langField = languageCodeField(modelId, input.languageCode)
    // The same paid door as synthesizeSpeech (budget → receipt → spend on success only).
    const paid = await runTtsDoor({ ...input, idempotencyKey: null }, "voice_tts_timestamped", { voice_id: voiceId, with_timestamps: true }, () => convertSpeechWithTimestamps(apiKey, {
      voiceId,
      text: input.text,
      modelId,
      voiceSettings: settings,
      applyTextNormalization: ELEVENLABS_TEXT_NORMALIZATION,
      languageCode: "language_code" in langField ? langField.language_code : null,
    }), (r) => r.ok && !!r.data?.audioBase64)
    if (!paid.ran) return { success: false, errorCode: "quota", error: paid.reason === "budget_refused" ? "Vendor budget exceeded — TTS paused" : paid.detail }
    const res = paid.result

    if (!res.ok || !res.data?.audioBase64) {
      const body = res.error ?? ""
      const code: SynthesizeSpeechResult["errorCode"] =
        res.status === 401 || res.status === 403
          ? "auth"
          : res.status === 422 && /voice/i.test(body)
          ? "voice_not_found"
          : res.status === 429
          ? "rate_limit"
          : /quota/i.test(body)
          ? "quota"
          : "unknown"
      return {
        success: false,
        errorCode: code,
        error: `ElevenLabs with-timestamps (${res.status ?? "—"}): ${body || "request failed"}`,
      }
    }

    const audioBuffer = Buffer.from(res.data.audioBase64, "base64")
    // Prefer alignment over the original text (matches the characters we sent).
    const alignment = (res.data.alignment ?? res.data.normalizedAlignment ?? undefined) as CharacterAlignment | undefined

    // The spend was booked by the door above, on success only.
    return { success: true, audioBuffer, alignment: alignment ?? undefined }
  } catch (err: any) {
    return { success: false, errorCode: "unknown", error: err?.message ?? "Network error" }
  }
}

/**
 * Streaming variant — returns the raw fetch Response so callers can pipe
 * the audio chunks directly to the client (lower TTFB for assistant TTS).
 *
 * Intentionally NOT routed through the connector-gateway: the gateway returns a
 * buffered/parsed body, but this path must hand back the live Response to stream
 * chunks. Streaming is the documented exception to the single-egress rule.
 */
export async function synthesizeSpeechStream(input: SynthesizeSpeechInput): Promise<{
  success: boolean
  response?: Response
  error?: string
  errorCode?: SynthesizeSpeechResult["errorCode"]
}> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) {
    return { success: false, errorCode: "no_api_key", error: "ELEVENLABS_API_KEY not set" }
  }

  const voiceId = input.voiceId || FALLBACK_VOICE_ID
  const settings = { ...DEFAULT_VOICE_SETTINGS, ...(input.voiceSettings ?? {}) }

  try {
    // DOCUMENTED EXCEPTION to single-egress: STREAMING response — the raw fetch Response is returned
    // so audio is piped to the client with low latency (no full buffer). The connector-gateway
    // buffers responses and can't express streaming; the buffered TTS path in this file uses
    // callConnector, only this low-latency stream stays a direct fetch.
    // The query suffix stays INSIDE the one fetch literal so
    // scripts/elevenlabs-egress-guard.ts keeps counting exactly one raw
    // /stream fetch (its shape, not a URL object it cannot see).
    const outputFormatQuery = input.outputFormat ? `?output_format=${input.outputFormat}` : ""
    const streamModelId = input.modelId ?? DEFAULT_STREAMING_MODEL_ID
    // THE PAID DOOR (wave 156, 156S): this leg asked the budget but never BOOKED its characters — the live
    // assistant's and the Simli agent's speech was spend no ledger saw. Same door as the buffered legs now.
    const paid = await runTtsDoor({ ...input, idempotencyKey: null }, "voice_tts_stream", { voice_id: voiceId, stream: true }, () => fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream${outputFormatQuery}`,
      {
        method: "POST",
        headers: {
          // pcm_16000 is raw signed 16-bit PCM, not an mpeg container — an
          // Accept: audio/mpeg header on that request is simply wrong, and
          // ElevenLabs' own response Content-Type for it is audio/pcm; the
          // default (unset outputFormat) path is completely unchanged.
          Accept: input.outputFormat ? "audio/pcm" : "audio/mpeg",
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify({
          text: input.text,
          model_id: streamModelId,
          voice_settings: settings,
        apply_text_normalization: ELEVENLABS_TEXT_NORMALIZATION,
          // language_code is sent ONLY to models ElevenLabs actually enforces it
          // on (see the file header's research finding) — never to multilingual_v2.
          ...languageCodeField(streamModelId, input.languageCode),
        }),
      }
    ), (r) => r.ok)
    if (!paid.ran) return { success: false, errorCode: "quota", error: paid.reason === "budget_refused" ? "Vendor budget exceeded — TTS paused" : paid.detail }
    const response = paid.result

    if (!response.ok) {
      const body = await response.text().catch(() => "")
      return {
        success: false,
        errorCode: response.status === 429 ? "rate_limit" : "unknown",
        error: `ElevenLabs stream (${response.status}): ${body || response.statusText}`,
      }
    }

    return { success: true, response }
  } catch (err: any) {
    return { success: false, errorCode: "unknown", error: err?.message ?? "Network error" }
  }
}

/**
 * Encode an mp3 buffer as a data URL the browser <audio> element can play.
 * Use only for short clips (<200kb) — long content should go to blob storage.
 */
export function audioBufferToDataUrl(buffer: Buffer): string {
  return `data:audio/mpeg;base64,${buffer.toString("base64")}`
}

/**
 * THE ONE PAID DOOR every ElevenLabs synthesis leg above goes through (wave 156, lane 156S) — the existing
 * lib/vendor-governance/paid-egress.ts runPaidEgress with this vendor's ONE price (estimatePlatformVendorCost
 * "elevenlabs", per character). Replaces three hand-assembled copies: the buffered and timestamped legs gated + booked
 * only when a tenant was passed, the stream leg gated and never booked; none left a receipt.
 */
async function runTtsDoor<T>(
  input: SynthesizeSpeechInput,
  systemSource: string,
  metadata: Record<string, unknown>,
  call: () => Promise<T>,
  ok: (r: T) => boolean,
  providerRef: () => string | null = () => null,
) {
  const { runPaidEgress } = await import("@/lib/vendor-governance/paid-egress")
  const { estimatePlatformVendorCost, meterVendorSpend } = await import("@/lib/vendor-governance/meter-vendor")
  const chars = input.text.length
  // THE SPEND IS BOOKED HERE, in this door's own span (round 5): `book: "caller"` — the composition still asks the budget
  // first and settles the receipt with the cost, and the characters are booked below only when the call SUCCEEDED, once
  // per idempotency key. Booking from this span (not the composition's nested meter call) keeps the real
  // vendor_usage_tracking write on every caller's path, one hop shorter, where the coverage census reads it.
  const res = await runPaidEgress<T>({
    brokerageId: input.brokerageId ?? null, vendor: "elevenlabs", usageType: "tts", action: "voice.tts.synthesize",
    estimatedCostUsd: estimatePlatformVendorCost("elevenlabs", chars), units: chars, book: "caller",
    subject: { type: "tts_voice", id: null, ref: String(metadata.voice_id ?? "") || null },
    systemSource, metadata: { ...metadata, chars }, idempotencyKey: input.idempotencyKey ?? null,
  }, call, (r) => ({ ok: ok(r), units: chars, providerRef: ok(r) ? providerRef() : null }))
  if (res.ran && res.ok && res.costUsd > 0) {
    await meterVendorSpend({
      vendorName: "elevenlabs", usageType: "tts", cost: res.costUsd, unitCount: chars,
      brokerageId: input.brokerageId ?? null, platformPaid: !input.brokerageId, idempotencyKey: input.idempotencyKey ?? null,
      systemSource, metadata: { ...metadata, chars, action: "voice.tts.synthesize" },
    })
  }
  return res
}
