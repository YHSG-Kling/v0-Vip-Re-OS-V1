// lib/repurpose/transcribe-core.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE TRANSCRIPTION PRIMITIVE. Fetch a direct media-file URL through the
// single egress gateway, hand the bytes to a speech-to-text vendor, return the
// text — with the host allowlist, the byte cap, the vendor budget gate and the
// vendor ledger all decided HERE, once.
//
// ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────────
// There were two Whisper call sites doing the same four things: the body of
// `lib/repurpose/transcribe.ts:transcribeFromUrl`, and an inline block in
// `app/actions/ai-voice-transcription.ts:transcribeAudio`. The inline one is
// GONE — it calls this — so there is one place that decides which vendor
// transcribes, one place that caps the bytes, and one place that meters the
// spend. Two copies is how a provider swap lands on one lane and not the other.
//
// ── WHY IT IS NOT IN THE "use server" FILE ───────────────────────────────────
// `lib/repurpose/transcribe.ts` carries a top-level `"use server"`, which makes
// every one of its exports an RPC endpoint any authenticated session can call
// with any arguments. Widening THAT function's signature with `brokerageId`
// would have handed callers a parameter that decides which tenant's ledger gets
// billed — a cross-tenant write knob reachable from the browser. So the
// implementation lives here (server-only, not an action), `transcribeFromUrl`
// keeps its original one-argument shape, and the option bag is reachable only
// from server code that already resolved its own tenant.
//
// ── TWO CALLERS, TWO OPPOSITE URL TRUST MODELS ───────────────────────────────
// The merge could NOT merge the URL policy, which is why `allowedHosts` is a
// parameter rather than a constant:
//
//   · REPURPOSE (lib/repurpose/actions.ts) transcribes a link the agent PASTED —
//     their own upload, a webinar recording, a competitor's clip. The URL being
//     external is the entire feature. It passes no allowlist.
//   · transcribeAudio transcribes a recording THIS SYSTEM produced or stored, and
//     the caller supplies only the pointer. It passes `platformAudioHostRules()`
//     (lib/security/audio-source-allowlist.ts), so the server cannot be steered
//     at an arbitrary address.
//
// ── PROVIDER ─────────────────────────────────────────────────────────────────
// `provider: "elevenlabs"` selects ElevenLabs Scribe (`POST /v1/speech-to-text`,
// model `scribe_v1`) — the owner's named choice — riding the EXACT credential
// path every other ElevenLabs egress in this repo already uses: the platform
// `ELEVENLABS_API_KEY` through the `elevenlabs` connector on the single gateway.
// See `lib/voice/elevenlabs-tts.ts:75,97-113` and
// `app/api/elevenlabs/voice-clone/route.ts:29-31,~120`.
//
// ElevenLabs is `platform_metered` in `lib/providers/tenancy-matrix.ts:50-54`
// and is deliberately absent from `lib/connections/scope.ts:CONNECTOR_PROVIDERS`,
// so there is no tenant-scoped ElevenLabs credential to resolve —
// `resolveScopedConnection("elevenlabs", …)` would answer `not_connected` by
// construction. That is the same shape the RentCast ruling states in the tenancy
// matrix ("a tenant does NOT bring their own key and is never offered the
// option"), and inventing a scoped credential lane for it would be inventing a
// credential. The connection cascade is the wrong resolver for a platform-owned
// vendor; the env key IS the existing credential path.
//
// The default stays `"whisper"`, so the repurpose lane's behaviour is unchanged
// by this file's arrival; only the caller that asks for ElevenLabs gets it.
//
// ── GATE + METER ─────────────────────────────────────────────────────────────
// When `brokerageId` is supplied the call is pre-flighted against the vendor
// budget gate and the real spend is recorded to `vendor_usage_tracking` — the
// same two calls, in the same order, as `lib/voice/elevenlabs-tts.ts:82-89` and
// `:136-147`. The FAIL-OPEN contract is preserved exactly: `checkVendorBudget`
// returns `allowed: true` on an unreadable ledger or an unreadable plan tier, and
// this function refuses only on a MEASURED `allowed: false`. It never inverts it.
//
// The gate runs AFTER the download and BEFORE the vendor call, which is where the
// money is: fetching from an allowlisted bucket is free, and the byte count is
// the only duration signal that exists before the vendor answers.

import "server-only"
import { openai } from "@ai-sdk/openai"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { checkAudioSourceUrl, type AudioHostRule } from "@/lib/security/audio-source-allowlist"

/** Whisper's hard per-file limit, and the ceiling for EVERY lane here. ElevenLabs
 *  Scribe accepts far larger files; capping both at the smaller number keeps ONE
 *  answer to "how big can this get" and stops a provider swap from silently
 *  raising the ceiling on the bill. */
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024
const MEDIA_CT = /^(audio|video)\//i

/** The lowest speech-mp3 bitrate we expect to see (32 kbps ≈ 4 KB/s). Used ONLY
 *  to turn a byte count into the LONGEST the clip could be, for the pre-flight
 *  budget estimate. Over-estimating the pre-flight is the safe direction for the
 *  money, and the ledger below is corrected with the vendor's own timings. */
const MIN_AUDIO_BYTES_PER_SECOND = 4_000

/** Published list prices in USD per second of audio. ElevenLabs Scribe bills
 *  ~$0.40/hour; OpenAI Whisper bills $0.006/minute. Telemetry only — real billing
 *  reconciles against each vendor's invoice, the same caveat PLATFORM_VENDOR_RATES
 *  carries in lib/vendor-governance/meter-vendor.ts. */
const STT_USD_PER_SECOND = {
  elevenlabs_scribe: 0.40 / 3600,
  openai_whisper: 0.006 / 60,
} as const

export type TranscriptionProvider = keyof typeof STT_USD_PER_SECOND

export type TranscribeResult =
  | {
      success: true
      transcript: string
      /** Which vendor actually produced it — never assumed by the caller. */
      provider: TranscriptionProvider
      audioBytes: number
      /** Real spoken duration when the vendor reported word timings, else null. */
      durationSeconds: number | null
    }
  | {
      success: false
      reason:
        | "not_media"
        | "too_large"
        | "fetch_failed"
        | "no_speech"
        | "error"
        /** The URL is not a host this system stores audio on (the SSRF refusal). */
        | "host_not_allowed"
        /** No transcription vendor is configured — HONEST, never an empty string. */
        | "not_configured"
        /** The tenant is over its MEASURED vendor ceiling. */
        | "budget_exceeded"
      message: string
    }

export interface TranscribeOptions {
  /** When present the URL's host MUST satisfy one of these rules. Omit for the
   *  pasted-link lane, where an external URL is the point. */
  allowedHosts?: readonly AudioHostRule[]
  /** The tenant the spend belongs to. Supplying it turns ON the budget gate and
   *  the vendor ledger; omitting it leaves both off (the repurpose behaviour). */
  brokerageId?: string | null
  /** Vendor preference. "elevenlabs" falls back to Whisper ONLY when
   *  ELEVENLABS_API_KEY is unset — never when ElevenLabs answers with an error,
   *  because silently paying a second vendor hides the first one being down. */
  provider?: "whisper" | "elevenlabs"
  /** BCP-47 hint passed to the vendor when it accepts one. */
  language?: string | null
  /** Ledger attribution (vendor_usage_tracking.request_metadata.system_source). */
  systemSource?: string
}

interface ScribeWord { text?: string; start?: number; end?: number; type?: string }
interface ScribeBody {
  text?: string
  language_code?: string
  language_probability?: number
  words?: ScribeWord[]
}

export async function transcribeMediaUrl(
  url: string,
  options: TranscribeOptions = {},
): Promise<TranscribeResult> {
  if (!/^https?:\/\/\S+$/i.test(url)) {
    return { success: false, reason: "error", message: "Invalid URL" }
  }

  // ── SSRF: the URL must be one this system produced, when the caller says so ──
  if (options.allowedHosts) {
    const verdict = checkAudioSourceUrl(url, options.allowedHosts)
    if (!verdict.allowed) {
      return { success: false, reason: "host_not_allowed", message: verdict.detail }
    }
  }

  // ── Which vendor, and is one configured at all? ─────────────────────────────
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY
  const openAiKey = process.env.OPENAI_API_KEY
  const wantsElevenLabs = options.provider === "elevenlabs"
  const provider: TranscriptionProvider =
    wantsElevenLabs && elevenLabsKey ? "elevenlabs_scribe" : "openai_whisper"
  if (provider === "openai_whisper" && !openAiKey) {
    // HONEST REFUSAL. An unconfigured provider must never look like a call that
    // happened and heard nothing — that is the shape that writes an empty
    // transcript onto a contact record and calls it a success.
    return {
      success: false,
      reason: "not_configured",
      message: wantsElevenLabs
        ? "Transcription is not configured (neither ELEVENLABS_API_KEY nor OPENAI_API_KEY is set)"
        : "Transcription is not configured",
    }
  }

  try {
    const res = await callConnector<Buffer>({
      connector: "asset-download", baseUrl: "", path: "", url,
      method: "GET", auth: { style: "none" }, responseType: "arraybuffer", timeoutMs: 60_000,
    })
    if (!res.ok || !res.data) {
      return { success: false, reason: "fetch_failed", message: `Could not fetch the URL (${res.status})` }
    }

    const contentType = res.headers["content-type"] ?? ""
    if (!MEDIA_CT.test(contentType)) {
      // HTML pages (YouTube/Vimeo links), etc. — not transcribable here, and not
      // billable either: refusing on content-type is half of the cap.
      return { success: false, reason: "not_media", message: "That link isn't a direct audio/video file" }
    }

    const audioBytes = res.data.byteLength
    if (audioBytes > MAX_TRANSCRIBE_BYTES) {
      return { success: false, reason: "too_large", message: "File is larger than 25MB" }
    }

    // ── VENDOR BUDGET GATE ────────────────────────────────────────────────────
    const ceilingSeconds = audioBytes / MIN_AUDIO_BYTES_PER_SECOND
    const estimatedCost = round4(STT_USD_PER_SECOND[provider] * ceilingSeconds)
    if (options.brokerageId) {
      const { checkVendorBudget } = await import("@/lib/vendor-governance/budget-gate")
      const budget = await checkVendorBudget({ brokerageId: options.brokerageId, addCost: estimatedCost })
      // Only a MEASURED refusal stops the call. An unreadable ledger or tier comes
      // back allowed:true with `degraded` set, and this branch is not taken — the
      // fail-open contract, carried, not inverted.
      if (!budget.allowed) {
        return {
          success: false,
          reason: "budget_exceeded",
          message: "Vendor budget exceeded — transcription paused for this brokerage",
        }
      }
    }

    const spoken =
      provider === "elevenlabs_scribe"
        ? await transcribeWithScribe(res.data, contentType, elevenLabsKey as string, options.language ?? null)
        : await transcribeWithWhisper(res.data)
    if (!spoken.ok) {
      return { success: false, reason: "error", message: spoken.message }
    }

    const transcript = (spoken.text ?? "").trim()
    if (!transcript) {
      return { success: false, reason: "no_speech", message: "No speech detected in the media" }
    }

    // ── VENDOR LEDGER ─────────────────────────────────────────────────────────
    // Metered on the REAL duration when the vendor reported one, else on the same
    // ceiling the gate used — never on a number nobody can trace back.
    if (options.brokerageId) {
      const billedSeconds = spoken.durationSeconds ?? ceilingSeconds
      const { meterVendorSpend } = await import("@/lib/vendor-governance/meter-vendor")
      void meterVendorSpend({
        vendorName: provider === "elevenlabs_scribe" ? "elevenlabs" : "openai",
        usageType: "stt",
        cost: round4(STT_USD_PER_SECOND[provider] * billedSeconds),
        unitCount: Math.max(1, Math.ceil(billedSeconds)),
        brokerageId: options.brokerageId,
        systemSource: options.systemSource ?? "transcription",
        metadata: {
          provider,
          audio_bytes: audioBytes,
          duration_seconds_measured: spoken.durationSeconds,
          duration_seconds_billed: Math.ceil(billedSeconds),
          content_type: contentType,
        },
      })
    }

    return { success: true, transcript, provider, audioBytes, durationSeconds: spoken.durationSeconds }
  } catch (err) {
    return { success: false, reason: "error", message: err instanceof Error ? err.message : "Transcription failed" }
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

type SpokenResult =
  | { ok: true; text: string; durationSeconds: number | null }
  | { ok: false; message: string }

/**
 * ElevenLabs Scribe. Multipart through the SINGLE gateway (`bodyType: "multipart"`,
 * which the voice-clone route already relies on) with the platform `xi-api-key` —
 * the same connector id, base URL and auth style as every other ElevenLabs egress
 * in this repo.
 *
 * A provider failure is REPORTED. It is not swallowed, and it does NOT silently
 * re-bill the same audio to a second vendor.
 */
async function transcribeWithScribe(
  audio: Buffer,
  contentType: string,
  apiKey: string,
  language: string | null,
): Promise<SpokenResult> {
  const form = new FormData()
  form.append("file", new Blob([new Uint8Array(audio)], { type: contentType || "audio/mpeg" }), "audio")
  form.append("model_id", "scribe_v1")
  if (language) form.append("language_code", language)

  const res = await callConnector<ScribeBody>({
    connector: "elevenlabs",
    baseUrl: "https://api.elevenlabs.io",
    path: "v1/speech-to-text",
    method: "POST",
    auth: { style: "header", name: "xi-api-key", value: apiKey },
    bodyType: "multipart",
    body: form,
    responseType: "json",
    timeoutMs: 120_000,
  })
  if (!res.ok || !res.data) {
    return { ok: false, message: `ElevenLabs Scribe (${res.status ?? "—"}): ${res.error || "request failed"}` }
  }
  // Scribe returns per-word timings; the last word's end IS the spoken duration,
  // which is the unit the vendor bills on.
  const words = Array.isArray(res.data.words) ? res.data.words : []
  const ends = words.map((w) => (typeof w.end === "number" ? w.end : null)).filter((n): n is number => n != null)
  return {
    ok: true,
    text: res.data.text ?? "",
    durationSeconds: ends.length ? Math.max(...ends) : null,
  }
}

/** OpenAI Whisper — the path that was already here, unchanged in behaviour. */
async function transcribeWithWhisper(audio: Buffer): Promise<SpokenResult> {
  const { experimental_transcribe } = await import("ai")
  const result = await experimental_transcribe({
    model: openai.transcription("whisper-1"),
    audio: new Uint8Array(audio),
  })
  // `durationInSeconds` is present on the SDK result for verbose responses and
  // absent otherwise. Never fabricated when missing — null means "we do not know",
  // and the ledger falls back to the same ceiling the gate used.
  const reported = (result as { durationInSeconds?: number }).durationInSeconds
  return {
    ok: true,
    text: result.text ?? "",
    durationSeconds: typeof reported === "number" && reported > 0 ? reported : null,
  }
}
