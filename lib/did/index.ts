/**
 * lib/did/index.ts
 *
 * D-ID talking avatar video generation + ElevenLabs voice synthesis.
 *
 * Exported surface:
 *   generateVideo(params) — creates a talking-head video via the D-ID Talks API.
 *     - Full avatar mode: D-ID renders agent's photo as a talking head, voice
 *       synthesized via ElevenLabs (provider.type = "elevenlabs").
 *     - Voice-only mode (voiceOnly=true): synthesizes audio via ElevenLabs TTS,
 *       uploads to Vercel Blob, returns an audio URL instead of a video URL.
 *     - Background image: injected via D-ID config.background.source_url.
 *     - Logo watermark: composited onto D-ID output thumbnail via Sharp,
 *       AND burned into the finished video by lib/video/composite-attribution.ts
 *       (ffmpeg-static + filter_complex overlay) in the poll-did-videos cron.
 *       Public-marketing videos get the brokerage logo + attribution band;
 *       MLS-bound videos pass through clean (MLS rules forbid branding).
 *
 * B-roll and intro/outro clip compositing still require additional ffmpeg
 * filter graphs (deferred — separate from the logo overlay shipped above).
 *
 * D-ID Auth: Authorization: Basic base64(DID_API_KEY + ":")
 * API base:  https://api.d-id.com
 *
 * Polling: D-ID is async (60–180 s for a 1-minute clip). We poll up to
 * POLL_TIMEOUT_MS. On timeout the caller receives { videoId, videoUrl: null }
 * so it can enqueue a background completion check (Sprint F webhook handler).
 */

import "server-only"
import { put } from "@vercel/blob"
import { synthesizeSpeech } from "@/lib/voice/elevenlabs-tts"
import { createServiceClient } from "@/lib/supabase/service"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DID_BASE = "https://api.d-id.com"
const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS  = 90_000   // 90 s — conservative for serverless; extend in webhook handler

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateVideoInput {
  /** The narration script (what the avatar says) */
  script: string
  /** ElevenLabs voice ID — if omitted, D-ID falls back to its default TTS */
  voiceId?: string
  /** If true, produce audio-only output (no avatar rendering) */
  voiceOnly?: boolean
  /** D-ID facial expression. Without this the avatar renders monotone.
   *  When omitted, falls back to the agent's default_expression on
   *  agent_voice_profiles (m112), then to platform default "happy" @ 0.7. */
  expression?: "happy" | "neutral" | "surprise" | "serious"
  /** 0..1 — D-ID expression intensity. Defaults to 0.7 (warm-professional). */
  expressionIntensity?: number
  /** Optional agent (users.id) — used to load agent_voice_profiles defaults
   *  for `expression`/`expressionIntensity` when caller didn't pass them. */
  agentUserId?: string
  /**
   * URL of the agent's photo used as the talking-head source.
   * Resolved from agents.avatar_image_url by the caller; pass null to use
   * the brokerage's configured default D-ID actor URL instead.
   */
  avatarImageUrl?: string | null
  /** D-ID actor ID (alternative to avatarImageUrl; preferred if set) */
  actorId?: string | null
  /** Image/video URL placed behind the avatar (optional) */
  backgroundUrl?: string | null
  /** B-roll clip URLs — passed through in output metadata; ffmpeg compositing in Sprint C */
  brollUrls?: string[]
  /** Intro clip URL — passed through in output metadata; ffmpeg compositing in Sprint C */
  introUrl?: string | null
  /** Outro clip URL — passed through in output metadata; ffmpeg compositing in Sprint C */
  outroUrl?: string | null
  /** Logo/watermark URL — composited onto output video (requires ffmpeg; Sprint C) */
  logoUrl?: string | null
  /** Brokerage ID — used to resolve brokerage-level D-ID config when agent has none */
  brokerageId: string
  /** Submit the D-ID job and return immediately (status='processing' + the talk id) WITHOUT
   *  inline-polling. For the AUTONOMOUS pipeline: the caller stamps the talk id onto an
   *  ai_video_projects row (status='generating') and the poll-did-videos cron drives completion +
   *  the avatar→composition handoff. Default false (keeps the synchronous submit+poll behavior). */
  submitOnly?: boolean
}

export interface GenerateVideoResult {
  /** Permanent video (mp4) or audio (mp3) URL — null if still processing */
  videoUrl: string | null
  /** D-ID talk/clip job ID for later polling */
  videoId: string
  /** Processing status at return time */
  status: "done" | "processing" | "error"
  /** Human-readable note (e.g. "B-roll compositing deferred to Sprint C") */
  note?: string
}

// ---------------------------------------------------------------------------
// D-ID helpers
// ---------------------------------------------------------------------------

// D-ID is a PLATFORM-owned connector (one DID_API_KEY; subscribers' avatars ride as request
// params). Egress goes through the single connector-gateway. Auth = HTTP Basic base64(key + ":").
function didKey(): string {
  const key = process.env.DID_API_KEY
  if (!key) throw new Error("DID_API_KEY is not configured")
  return key
}

async function didPost(path: string, body: unknown): Promise<{ id: string }> {
  const res = await callConnector<{ id: string }>({
    connector: "did",
    baseUrl: DID_BASE,
    path,
    method: "POST",
    auth: { style: "basic", username: didKey(), password: "" },
    body,
  })
  if (!res.ok || !res.data) throw new Error(`D-ID API error (${res.status ?? "—"}): ${res.error ?? "unknown"}`)
  return res.data
}

async function didGet(path: string): Promise<Record<string, unknown>> {
  const res = await callConnector<Record<string, unknown>>({
    connector: "did",
    baseUrl: DID_BASE,
    path,
    method: "GET",
    auth: { style: "basic", username: didKey(), password: "" },
  })
  if (!res.ok || !res.data) throw new Error(`D-ID poll error (${res.status ?? "—"}): ${res.error ?? "unknown"}`)
  return res.data
}

/** Poll until done/error or timeout. Returns null on timeout (still processing). */
async function pollUntilDone(talkId: string): Promise<string | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    // Both engines: photo avatars live at /talks; V4 expressive at /expressives.
    let data: Record<string, unknown>
    try {
      data = await didGet(`/talks/${talkId}`)
    } catch {
      data = await didGet(`/expressives/${talkId}`)
    }
    const status = data.status as string | undefined
    if (status === "done") {
      return (data.result_url as string) ?? null
    }
    if (status === "error") {
      throw new Error(`D-ID talk failed: ${String(data.error ?? "unknown error")}`)
    }
    // status === "created" | "started" — continue polling
  }
  return null // timed out — still processing
}

// ---------------------------------------------------------------------------
// Avatar source resolution
// ---------------------------------------------------------------------------

async function resolveAvatarSource(
  input: Pick<GenerateVideoInput, "avatarImageUrl" | "actorId" | "brokerageId">
): Promise<{ sourceUrl?: string; actorId?: string }> {
  // Caller-provided actor ID takes priority
  if (input.actorId) return { actorId: input.actorId }

  // Caller-provided avatar photo URL
  if (input.avatarImageUrl) return { sourceUrl: input.avatarImageUrl }

  // Fall back to brokerage-configured D-ID source
  try {
    const svc = createServiceClient()
    const { data } = await svc
      .from("brokerages")
      .select("did_avatar_url, did_actor_id")
      .eq("id", input.brokerageId)
      .maybeSingle()
    if ((data as any)?.did_actor_id) return { actorId: (data as any).did_actor_id }
    if ((data as any)?.did_avatar_url) return { sourceUrl: (data as any).did_avatar_url }
  } catch { /* best-effort */ }

  // Ultimate fallback — D-ID will use its default presenter
  return {}
}

// ---------------------------------------------------------------------------
// Voice-only path — ElevenLabs TTS → Vercel Blob
// ---------------------------------------------------------------------------

async function generateAudioOnly(
  input: GenerateVideoInput
): Promise<GenerateVideoResult> {
  const ttsResult = await synthesizeSpeech({
    text: input.script,
    voiceId: input.voiceId ?? null,
  })

  if (!ttsResult.success || !ttsResult.audioBuffer) {
    return {
      videoId: `audio-failed-${Date.now()}`,
      videoUrl: null,
      status: "error",
      note: ttsResult.error ?? "ElevenLabs synthesis failed",
    }
  }

  // Upload to Vercel Blob
  const slug = Math.random().toString(36).slice(2, 9)
  const blob = await put(`workflow-audio/${slug}.mp3`, ttsResult.audioBuffer, {
    access: "public",
    contentType: "audio/mpeg",
  })

  return {
    videoId: `audio-${slug}`,
    videoUrl: blob.url,
    status: "done",
    note: "Voice-only mode — audio file (no avatar rendering)",
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate a talking-head video via D-ID + ElevenLabs.
 *
 * Returns immediately with `status: "processing"` and a `videoId` if the
 * D-ID job does not complete within POLL_TIMEOUT_MS. The caller (video.ts
 * adapter) stores `videoId` in step_outputs so a Sprint F webhook handler
 * can finalize the result asynchronously.
 */
export async function generateVideo(
  input: GenerateVideoInput
): Promise<GenerateVideoResult> {
  // Voice-only path — skip D-ID rendering entirely
  if (input.voiceOnly) {
    return generateAudioOnly(input)
  }

  const notes: string[] = []
  if ((input.brollUrls?.length ?? 0) > 0) {
    notes.push("B-roll compositing pending (ffmpeg filter graph not yet wired)")
  }
  if (input.introUrl || input.outroUrl) {
    notes.push("Intro/outro compositing pending (ffmpeg filter graph not yet wired)")
  }
  if (input.logoUrl) {
    // Logo + attribution band overlay runs in the poll-did-videos cron via
    // lib/video/composite-attribution.ts. No deferral needed here.
    notes.push("Logo overlay applied post-render by compositeVideoAttribution()")
  }

  // ---------------------------------------------------------------------------
  // 1. Build D-ID /talks request body
  // ---------------------------------------------------------------------------

  const avatarSrc = await resolveAvatarSource(input)

  const scriptBlock: Record<string, unknown> = {
    type: "text",
    input: input.script,
    ssml: false,
  }

  if (input.voiceId) {
    scriptBlock.provider = {
      type: "elevenlabs",
      voice_id: input.voiceId,
      voice_config: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }
  }

  // Resolve facial expression — caller > agent profile > platform default.
  // agent_voice_profiles.agent_id FKs to agents(id); resolve users.id
  // through the canonical helper before querying.
  let expression: string = input.expression ?? "happy"
  let intensity: number  = input.expressionIntensity ?? 0.7
  if (!input.expression && input.agentUserId) {
    try {
      const svc = createServiceClient()
      const { resolveUserIdToAgentRecord } = await import("@/lib/kernel/agent-identity-resolver")
      const agentRecordId = await resolveUserIdToAgentRecord(input.agentUserId, input.brokerageId)
      if (agentRecordId) {
        const { data: prof } = await svc
          .from("agent_voice_profiles")
          .select("default_expression, expression_intensity")
          .eq("agent_id", agentRecordId)
          .maybeSingle()
        if (prof?.default_expression) expression = prof.default_expression as string
        if (prof?.expression_intensity != null) intensity = Number(prof.expression_intensity)
      }
    } catch { /* best-effort — keep defaults */ }
  }

  const config: Record<string, unknown> = {
    result_format: "mp4",
    stitch: true,
    driver_expressions: {
      expressions: [{ start_frame: 0, expression, intensity }],
    },
  }

  if (input.backgroundUrl) {
    config.background = {
      source_url: input.backgroundUrl,
    }
  }

  const bodyBase: Record<string, unknown> = {
    script: scriptBlock,
    config,
  }

  // Actor vs source_url
  if (avatarSrc.actorId) {
    bodyBase.actor_id = avatarSrc.actorId
  } else if (avatarSrc.sourceUrl) {
    bodyBase.source_url = avatarSrc.sourceUrl
  }
  // If neither is set, D-ID uses its default presenter

  // ---------------------------------------------------------------------------
  // 2. Submit the D-ID job
  // ---------------------------------------------------------------------------

  // Vendor budget gate — auto-pause D-ID renders when the brokerage is over its
  // monthly platform-vendor ceiling (closes the metering→cap governance loop).
  {
    const { checkVendorBudget } = await import("@/lib/vendor-governance/budget-gate")
    const { estimatePlatformVendorCost: estCost } = await import("@/lib/vendor-governance/meter-vendor")
    const budget = await checkVendorBudget({ brokerageId: input.brokerageId, addCost: estCost("did", 1) })
    if (!budget.allowed) {
      throw new Error(`Vendor budget exceeded — D-ID render paused ($${budget.spent}/$${budget.budget})`)
    }
  }

  // V4 EXPRESSIVE (owner rule: personalized avatar video rides D-ID's newest
  // engine when the avatar supports it). Expressive avatar ids carry "@avt_"
  // (e.g. "public_amber_casual@avt_..."); those submit to /expressives with
  // avatar_id + a sentiment mapped from the resolved expression — the
  // diffusion engine aligns tone to the message. Photo-derived avatars keep
  // the proven /talks path with driver_expressions. One submit, two engines,
  // zero drift for callers.
  const isV4Expressive = typeof avatarSrc.actorId === "string" && avatarSrc.actorId.includes("@avt_")
  let talkId: string
  try {
    if (isV4Expressive) {
      const sentimentFor: Record<string, string> = { happy: "happy", neutral: "neutral", serious: "serious", surprise: "surprise" }
      const created = await didPost("/expressives", {
        avatar_id: avatarSrc.actorId,
        script: scriptBlock,
        sentiment_id: sentimentFor[expression] ?? "neutral",
        config: { result_format: "mp4" },
      })
      talkId = created.id
    } else {
      const created = await didPost("/talks", bodyBase)
      talkId = created.id
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`D-ID submit failed: ${msg}`)
  }

  // Unified vendor-spend ledger — D-ID bills per submitted talk render.
  const { meterVendorSpend, estimatePlatformVendorCost } = await import("@/lib/vendor-governance/meter-vendor")
  void meterVendorSpend({
    vendorName: "did",
    usageType: "video_render",
    cost: estimatePlatformVendorCost("did", 1),
    brokerageId: input.brokerageId,
    systemSource: "video_generation",
    metadata: { talk_id: talkId },
  })

  // ---------------------------------------------------------------------------
  // 3. Poll for completion (skipped in submitOnly mode — the async pipeline drives it)
  // ---------------------------------------------------------------------------

  if (input.submitOnly) {
    return {
      videoId: talkId,
      videoUrl: null,
      status: "processing",
      note: [notes.length ? notes.join("; ") : undefined, `D-ID job ${talkId} submitted — poll-did-videos will complete it`].filter(Boolean).join("; "),
    }
  }

  let videoUrl: string | null = null
  try {
    videoUrl = await pollUntilDone(talkId)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`D-ID poll failed: ${msg}`)
  }

  const note = notes.length > 0 ? notes.join("; ") : undefined

  if (videoUrl) {
    // D-ID returns a signed URL (~24h expiry). Download + re-upload to Vercel Blob
    // so the video URL stays valid for downstream {{step_N.video_url}} references
    // weeks or months later.
    try {
      const dl = await callConnector<Buffer>({
        connector: "asset-download", baseUrl: "", path: "", url: videoUrl,
        method: "GET", auth: { style: "none" }, responseType: "arraybuffer", timeoutMs: 60_000,
      })
      if (dl.ok && dl.data) {
        const bytes = dl.data
        const blob = await put(`workflow-video/${talkId}.mp4`, bytes, {
          access: "public",
          contentType: "video/mp4",
        })
        return { videoId: talkId, videoUrl: blob.url, status: "done", note }
      }
    } catch { /* fall through with D-ID URL — better than nothing */ }
    return { videoId: talkId, videoUrl, status: "done", note }
  }

  // Timed out — return partial result so caller can record and continue
  return {
    videoId: talkId,
    videoUrl: null,
    status: "processing",
    note: [note, `D-ID job ${talkId} still processing — poll for completion`]
      .filter(Boolean)
      .join("; "),
  }
}
