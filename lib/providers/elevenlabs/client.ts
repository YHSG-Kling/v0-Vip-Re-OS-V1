// lib/providers/elevenlabs/client.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE ELEVENLABS SERVER ADAPTER (wave 70B, owner ruling: "if there is an
// sdk option, we should use that... keeping pricing in mind"). ElevenLabs'
// official server SDK is `@elevenlabs/elevenlabs-js` (the repo already carries
// the BROWSER sdk `@elevenlabs/client` for lib/voice — that one is unrelated
// and untouched). The SDK does not change per-call price (same v1 endpoints,
// same token cost) — it only removes the hand-rolled request/response mapping
// lib/voice/elevenlabs-tts.ts used to do through the connector gateway.
//
// SCOPE — buffered synthesis only. `synthesizeSpeechStream` in
// lib/voice/elevenlabs-tts.ts stays on a RAW fetch, unmigrated, on purpose:
// (1) it is the documented single-egress EXCEPTION (streaming can't go through
// the buffering connector-gateway either, SDK or REST), and (2)
// scripts/elevenlabs-egress-guard.ts counts exactly ONE raw
// `fetch(\`https://api.elevenlabs.io/...stream${suffix}\`)` literal as its
// positive control (wave 62 lesson) — replacing it with an SDK call would
// blind that guard, not just change its shape. The SDK's own `.stream()`
// method returns a ReadableStream and could serve this path too, but the
// existing literal-shaped guard is the one already proving streaming works,
// so it is left alone rather than swapped for a new unverified path.
//
// Every function here returns a GatewayResponse-SHAPED result ({ok, status,
// data, error}) so callers that used to read a callConnector result need only
// swap the call, not their branching.

// NOT import "server-only" — every caller of this adapter is itself a server
// action / API route / cron-only lib file (never a client component), and this
// repo's proof scripts (scripts/*.ts) load modules directly via tsx outside
// Next's webpack build, where "server-only" throws unconditionally rather than
// only-when-client-bundled. A static import of this adapter from a file a proof
// script statically reaches (e.g. lib/external/apify-client.ts from
// lib/platform/provider-posture.ts's chain) would crash that proof for a
// directive with no live client-bundling risk to guard against here.
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js"

export interface AdapterResult<T> {
  ok: boolean
  status: number | null
  data: T | null
  error: string | null
}

// One client per API key (platform-owned — effectively one key for the
// process lifetime, but keyed defensively rather than assuming a singleton).
const clients = new Map<string, ElevenLabsClient>()
function client(apiKey: string): ElevenLabsClient {
  let c = clients.get(apiKey)
  if (!c) {
    c = new ElevenLabsClient({ apiKey })
    clients.set(apiKey, c)
  }
  return c
}

async function readStreamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)))
}

function mapError(err: unknown): AdapterResult<any> {
  const e = err as { statusCode?: number; body?: unknown; message?: string }
  const bodyStr = typeof e?.body === "string" ? e.body : e?.body ? JSON.stringify(e.body) : ""
  return {
    ok: false,
    status: typeof e?.statusCode === "number" ? e.statusCode : null,
    data: null,
    error: bodyStr || e?.message || "ElevenLabs request failed",
  }
}

export interface ConvertSpeechParams {
  voiceId: string
  text: string
  modelId?: string
  /** Passed through to the SDK's `voiceSettings` param as-is — typed loosely
   *  because callers hand in their own settings shape (e.g.
   *  lib/video/realism-profile.ts's ElevenLabsRealismVoiceSettings, which has
   *  no index signature and would reject a stricter Record type here). */
  voiceSettings?: unknown
  /** 'auto' | 'on' | 'off' — matches ElevenLabs' apply_text_normalization vocabulary. */
  applyTextNormalization?: string
  /** Only pass when the caller already filtered to an enforcement-allowlisted
   *  model (LANGUAGE_ENFORCEMENT_MODELS in elevenlabs-tts.ts) — the adapter
   *  does not re-derive that rule, it stays where the research finding lives. */
  languageCode?: string | null
}

/** Buffered TTS (`POST /v1/text-to-speech/{voice_id}`) — same request/response
 *  contract synthesizeSpeech used over the connector gateway, now via the SDK. */
export async function convertSpeech(apiKey: string, params: ConvertSpeechParams): Promise<AdapterResult<Buffer>> {
  try {
    const stream = await client(apiKey).textToSpeech.convert(params.voiceId, {
      text: params.text,
      modelId: params.modelId,
      voiceSettings: params.voiceSettings as any,
      applyTextNormalization: params.applyTextNormalization as any,
      ...(params.languageCode ? { languageCode: params.languageCode } : {}),
    })
    const buffer = await readStreamToBuffer(stream)
    return { ok: true, status: 200, data: buffer, error: null }
  } catch (err) {
    return mapError(err)
  }
}

export interface VoiceSummary {
  voiceId: string
  name?: string
  category?: string
  labels?: Record<string, string>
  description?: string
  fineTuning?: { language?: string }
}

/** `GET /v1/voices` (deprecated on ElevenLabs' side but still the exact
 *  endpoint every caller here relies on — the SDK's `voices.getAll` hits the
 *  same path, so this is a like-for-like swap, not a move to `voices.search`
 *  which paginates differently). */
export async function listVoices(apiKey: string): Promise<AdapterResult<VoiceSummary[]>> {
  try {
    const res = await client(apiKey).voices.getAll()
    return { ok: true, status: 200, data: (res.voices ?? []) as unknown as VoiceSummary[], error: null }
  } catch (err) {
    return mapError(err)
  }
}

export interface ConvertSpeechWithTimestampsData {
  audioBase64: string
  alignment?: unknown
  normalizedAlignment?: unknown
}

/** `POST /v1/text-to-speech/{voice_id}/with-timestamps` — same contract
 *  synthesizeSpeechWithTimestamps used, now via the SDK. */
export async function convertSpeechWithTimestamps(
  apiKey: string,
  params: ConvertSpeechParams,
): Promise<AdapterResult<ConvertSpeechWithTimestampsData>> {
  try {
    const res = await client(apiKey).textToSpeech.convertWithTimestamps(params.voiceId, {
      text: params.text,
      modelId: params.modelId,
      voiceSettings: params.voiceSettings as any,
      applyTextNormalization: params.applyTextNormalization as any,
      ...(params.languageCode ? { languageCode: params.languageCode } : {}),
    })
    return { ok: true, status: 200, data: res as unknown as ConvertSpeechWithTimestampsData, error: null }
  } catch (err) {
    return mapError(err)
  }
}
