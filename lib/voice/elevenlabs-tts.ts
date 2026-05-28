/**
 * lib/voice/elevenlabs-tts.ts
 *
 * Shared ElevenLabs Text-to-Speech primitive.
 *
 * Used by:
 *   - app/actions/brief-audio.ts        (morning brief read aloud in agent's voice)
 *   - app/api/internal/voice-tts/route.ts (real-time assistant TTS)
 *   - app/actions/podcast-generation.ts  (legacy — to be migrated)
 *
 * Default voice settings prioritize naturalness over speed. Callers can
 * override via `voiceSettings`. Returns raw mp3 bytes; caller decides
 * whether to stream, cache, or upload to blob storage.
 */

import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

const ELEVENLABS_BASE = "https://api.elevenlabs.io"

export interface VoiceSettings {
  stability?: number          // 0-1, lower = more variable
  similarity_boost?: number   // 0-1, higher = stays closer to original voice
  style?: number              // 0-1, expressiveness
  use_speaker_boost?: boolean
}

const DEFAULT_VOICE_SETTINGS: Required<VoiceSettings> = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.0,
  use_speaker_boost: true,
}

/** ElevenLabs default professional voice (Rachel) — fallback when no clone */
export const FALLBACK_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"

export interface SynthesizeSpeechInput {
  text: string
  voiceId?: string | null
  voiceSettings?: VoiceSettings
  modelId?: string             // 'eleven_monolingual_v1' (default), 'eleven_multilingual_v2', etc.
  /** When set, the synthesis cost is recorded to the unified vendor ledger. */
  brokerageId?: string | null
}

export interface SynthesizeSpeechResult {
  success: boolean
  audioBuffer?: Buffer
  error?: string
  /** Detail useful for fallback decisions (e.g. quota exceeded → retry with browser TTS) */
  errorCode?: "no_api_key" | "rate_limit" | "quota" | "auth" | "voice_not_found" | "unknown"
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

  // Vendor budget gate — auto-pause TTS when the brokerage is over its monthly
  // platform-vendor ceiling. Callers fall back to browser TTS on quota.
  if (input.brokerageId) {
    const { checkVendorBudget } = await import("@/lib/vendor-governance/budget-gate")
    const { estimatePlatformVendorCost } = await import("@/lib/vendor-governance/meter-vendor")
    const budget = await checkVendorBudget({ brokerageId: input.brokerageId, addCost: estimatePlatformVendorCost("elevenlabs", input.text.length) })
    if (!budget.allowed) {
      return { success: false, errorCode: "quota", error: "Vendor budget exceeded — TTS paused" }
    }
  }

  const voiceId = input.voiceId || FALLBACK_VOICE_ID
  const settings = { ...DEFAULT_VOICE_SETTINGS, ...(input.voiceSettings ?? {}) }

  try {
    // PLATFORM-owned connector — one ELEVENLABS_API_KEY; per-subscriber voice rides as voiceId.
    // Buffered synthesis egresses through the single gateway (arraybuffer mode → raw mp3 bytes).
    const res = await callConnector<Buffer>({
      connector: "elevenlabs",
      baseUrl: ELEVENLABS_BASE,
      path: `v1/text-to-speech/${voiceId}`,
      method: "POST",
      auth: { style: "header", name: "xi-api-key", value: apiKey },
      headers: { Accept: "audio/mpeg" },
      responseType: "arraybuffer",
      body: {
        text: input.text,
        model_id: input.modelId ?? "eleven_monolingual_v1",
        voice_settings: settings,
      },
    })

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

    const arrayBuffer = res.data
    // Unified vendor-spend ledger — ElevenLabs bills per character synthesized.
    if (input.brokerageId) {
      const { meterVendorSpend, estimatePlatformVendorCost } = await import("@/lib/vendor-governance/meter-vendor")
      void meterVendorSpend({
        vendorName: "elevenlabs",
        usageType: "tts",
        cost: estimatePlatformVendorCost("elevenlabs", input.text.length),
        unitCount: input.text.length,
        brokerageId: input.brokerageId,
        systemSource: "voice_tts",
        metadata: { voice_id: voiceId, chars: input.text.length },
      })
    }
    return { success: true, audioBuffer: Buffer.from(arrayBuffer) }
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

  // Vendor budget gate — auto-pause TTS when the brokerage is over its monthly
  // platform-vendor ceiling. Callers fall back to browser TTS on quota.
  if (input.brokerageId) {
    const { checkVendorBudget } = await import("@/lib/vendor-governance/budget-gate")
    const { estimatePlatformVendorCost } = await import("@/lib/vendor-governance/meter-vendor")
    const budget = await checkVendorBudget({ brokerageId: input.brokerageId, addCost: estimatePlatformVendorCost("elevenlabs", input.text.length) })
    if (!budget.allowed) {
      return { success: false, errorCode: "quota", error: "Vendor budget exceeded — TTS paused" }
    }
  }

  const voiceId = input.voiceId || FALLBACK_VOICE_ID
  const settings = { ...DEFAULT_VOICE_SETTINGS, ...(input.voiceSettings ?? {}) }

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        method: "POST",
        headers: {
          Accept: "audio/mpeg",
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify({
          text: input.text,
          model_id: input.modelId ?? "eleven_monolingual_v1",
          voice_settings: settings,
        }),
      }
    )

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
