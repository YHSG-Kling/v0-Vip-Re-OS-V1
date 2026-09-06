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
// Was `import { put } from "@vercel/blob"`. Survivor:
// lib/remotion/media-host.ts#hostRenderedMedia (owner ruling — all file storage
// lives in Supabase buckets).
import { hostRenderedMedia } from "@/lib/remotion/media-host"
import { synthesizeSpeech } from "@/lib/voice/elevenlabs-tts"
import { createServiceClient } from "@/lib/supabase/service"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { classifyDidError, externalKeyHeader, DID_STATUS_IN_FLIGHT } from "./contract"

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
   * URL of the agent's photo used as the talking-head source, resolved by the
   * CALLER (agents.avatar_image_url / agent_voice_profiles.did_photo_url).
   * Null/omitted no longer means "use the brokerage's default" — there is no
   * brokerage default, by owner rule. With no actorId either, the render is
   * REFUSED rather than handed to D-ID's stock presenter.
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
  /** Brokerage ID — the METERING and BUDGET scope for this render (vendor spend
   *  ledger + the monthly vendor ceiling). It no longer resolves any identity:
   *  a brokerage never supplies the face or the voice for an agent's video. */
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
  /** Which D-ID engine rendered it — RECORDED at submit (talks = V2 photo,
   *  expressives = V4). Pollers key off this; never guess from id shapes.
   *  Typed as DidEngine (§6, 2026-08-31, lane M4): this field used to respell
   *  the union inline, leaving the named type below with no reader. */
  engine?: DidEngine
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
    // OUR ElevenLabs key, so OUR voice clones resolve. The D-ID reference is
    // explicit that x-api-key-external is "your own ElevenLabs API key for TTS
    // (IVC voices only)". Every agent voice in this OS is an IVC clone created
    // in our ElevenLabs account, so without this header D-ID looks the voice_id
    // up in ITS account, where our clones do not exist — the avatar renders in
    // a stock voice that is not the agent's, and nothing reports a problem.
    // Absent key → no header → D-ID's own voices, which is the honest fallback.
    headers: externalKeyHeader(),
    body,
  })
  if (!res.ok || !res.data) {
    // Structured, per the published contract, so a 402/451/400 is legible and
    // the caller can tell "never going to work" from "try again".
    const failure = classifyDidError(res.status ?? null, (res as { data?: unknown }).data ?? { description: res.error })
    throw new Error(`D-ID ${failure.kind}: ${failure.userMessage}`)
  }
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

/**
 * The statuses that mean the job is still being worked on.
 *
 * DELIBERATELY AN ALLOW-LIST, not a deny-list of terminal states. The previous
 * loop continued on anything that was not exactly "done" or "error", so ANY
 * status this code does not know about — a rejection, a moderation block, a
 * cancellation, whatever the provider adds next — polled silently to the
 * timeout and then reported "still processing" for a job that would never
 * finish. Inverting it means an unrecognised status is surfaced immediately,
 * with its own name in the message, which is correct whatever the provider's
 * vocabulary turns out to be.
 */
const DID_IN_FLIGHT_STATUSES = new Set<string>(DID_STATUS_IN_FLIGHT)

/** Which endpoint holds a given job — known at SUBMIT time, never guessed. */
export type DidEngine = "talks" | "expressives"

/**
 * Poll until the job reaches a terminal state, or the deadline passes.
 * Returns null ONLY on timeout (genuinely still processing).
 *
 * The engine is a PARAMETER because the caller already knows it: generateVideo
 * computes it from the avatar id and returns it, and the poll cron records it
 * on the row as provider_metadata.mode. The old code threw that away and
 * probed — `try { GET /talks/id } catch { GET /expressives/id }` — which is
 * wrong in both directions: a transient 5xx or a rate-limit on /talks diverted
 * a healthy talks job to /expressives, where it 404s, and the 404 surfaced as
 * "D-ID poll failed" on a render that was fine.
 */
async function pollUntilDone(talkId: string, engine: DidEngine): Promise<string | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const data = await didGet(`/${engine}/${talkId}`)
    const status = String(data.status ?? "")
    if (status === "done") {
      return (data.result_url as string) ?? null
    }
    if (DID_IN_FLIGHT_STATUSES.has(status)) continue
    // Terminal, and not success. "error" carries a description; anything else
    // is named verbatim so an unhandled provider state is legible rather than
    // silently indistinguishable from a slow render.
    throw new Error(
      status === "error"
        ? `D-ID ${engine} failed: ${String(data.error ?? "unknown error")}`
        : `D-ID ${engine} ended in status "${status || "(none)"}": ${String(data.error ?? "no description")}`,
    )
  }
  return null // timed out — still processing
}

// ---------------------------------------------------------------------------
// Avatar source resolution
// ---------------------------------------------------------------------------

/**
 * WHOSE FACE. Exactly two answers, both from the caller: the actor id the caller
 * resolved, or the photo the caller resolved. There is no third answer.
 *
 * There used to be two more, and both were wrong for the same reason.
 *
 *   · A BROKERAGE FALLBACK — brokerages.did_actor_id / did_avatar_url. Against
 *     the owner's rule that every user sets up their own avatar with no fallback
 *     to the brokerage, and dead besides: those columns were added by a schema
 *     reconciliation script and have NO writer anywhere in the app and no UI, so
 *     nothing could ever populate them. Live check: 0 of 2 brokerages had either
 *     set. The branch existed only to be skipped.
 *
 *   · AN "ULTIMATE FALLBACK" of returning {} and letting the request go out with
 *     neither actor_id nor source_url — which does not mean "no video". It means
 *     D-ID RENDERS WITH ITS OWN DEFAULT PRESENTER: a stock stranger. The job
 *     succeeded, the poller marked it done, and a contact received a talking-head
 *     video of someone who has never worked at the brokerage, under their agent's
 *     name. Nothing in the pipeline could tell that apart from a real render.
 *
 * That is the whole defect class in one branch — the OS collects the intent
 * (this agent's twin) and silently ships something else. Now the absence of a
 * face is a refusal the caller can act on, not a stranger.
 */
async function resolveAvatarSource(
  input: Pick<GenerateVideoInput, "avatarImageUrl" | "actorId">
): Promise<{ sourceUrl?: string; actorId?: string }> {
  if (input.actorId) return { actorId: input.actorId }
  if (input.avatarImageUrl) return { sourceUrl: input.avatarImageUrl }
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

  // `video-assets` (public): D-ID fetches this MP3 by URL with no session of
  // ours, so a signed URL would expire mid-job.
  const slug = Math.random().toString(36).slice(2, 9)
  const audioUrl = await hostRenderedMedia(
    createServiceClient(),
    `workflow-audio/${slug}.mp3`,
    ttsResult.audioBuffer,
    "audio/mpeg",
  )

  return {
    videoId: `audio-${slug}`,
    videoUrl: audioUrl,
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
    // Applied post-render in the poll-did-videos cron via
    // compositeBrollCutaways() — timed full-frame cutaways while the
    // voice-over continues; the row carries them in b_roll_urls.
    notes.push("B-roll cutaways applied post-render by compositeBrollCutaways()")
  }
  if (input.introUrl || input.outroUrl) {
    // Applied post-render via concatIntroOutro() off the row's
    // intro_video_url / outro_video_url columns.
    notes.push("Intro/outro applied post-render by concatIntroOutro()")
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

  // NO FACE → NO RENDER. Refused here, before the budget gate and before a
  // single provider call, because a D-ID submit with neither actor_id nor
  // source_url does not fail — it renders a stock stranger and reports success.
  // Callers that legitimately have no face already have a path for it: pass
  // voiceOnly (partners-meeting does exactly this, degrading to audio), or
  // handle the error and degrade to a memo. Every caller already branches on
  // status === "error" / a null videoUrl, so this reaches them as a real
  // instruction instead of a silent substitution.
  if (!avatarSrc.actorId && !avatarSrc.sourceUrl) {
    return {
      videoId: "",
      videoUrl: null,
      status: "error",
      note:
        "No avatar to render with — this agent has no D-ID twin or photo configured. " +
        "Set one up in Settings → Voice & Avatar, or request voice-only output.",
    }
  }

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

  // Actor vs source_url. One of the two is guaranteed present — the no-face case
  // returned above, because "neither" is the branch where D-ID substitutes its
  // own default presenter and nothing downstream can tell.
  if (avatarSrc.actorId) {
    bodyBase.actor_id = avatarSrc.actorId
  } else {
    bodyBase.source_url = avatarSrc.sourceUrl
  }

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
      engine: isV4Expressive ? "expressives" : "talks",
      note: [notes.length ? notes.join("; ") : undefined, `D-ID job ${talkId} submitted — poll-did-videos will complete it`].filter(Boolean).join("; "),
    }
  }

  let videoUrl: string | null = null
  try {
    videoUrl = await pollUntilDone(talkId, isV4Expressive ? "expressives" : "talks")
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`D-ID poll failed: ${msg}`)
  }

  const note = notes.length > 0 ? notes.join("; ") : undefined

  if (videoUrl) {
    // D-ID returns a SIGNED URL that expires in ~24h. The bytes are pulled and
    // re-hosted in our own Supabase bucket so a downstream
    // {{step_N.video_url}} reference still resolves weeks later.
    //
    // ── WHY THE FALLBACK IS GONE ────────────────────────────────────────────
    // This ended with
    //
    //     } catch { /* fall through with D-ID URL — better than nothing */ }
    //     return { videoId: talkId, videoUrl, status: "done", … }
    //
    // …which returned the VENDOR URL with status "done" whenever the download
    // or the re-host failed. It is the same shape lib/remotion/media-host.ts
    // deleted from its own body on the owner's ruling that all file storage
    // lives in Supabase buckets, and it fails the same way: the caller records
    // a completed step whose video_url dies tomorrow, and no error is ever
    // raised, so a broken bucket is indistinguishable from success for exactly
    // as long as the vendor's signature lasts. "Better than nothing" is the
    // claim that cannot be checked — a link that 403s next week is worse than a
    // job the caller knows is unfinished, because only the second one gets
    // retried.
    //
    // The D-ID job is NOT lost by refusing here: `talkId` is returned either
    // way, and "processing" is the status this function already uses to say
    // "the render exists, ask again" — app/api/cron/poll-did-videos is the
    // async finalizer that completes it, and it re-hosts too.
    const dl = await callConnector<Buffer>({
      connector: "asset-download", baseUrl: "", path: "", url: videoUrl,
      method: "GET", auth: { style: "none" }, responseType: "arraybuffer", timeoutMs: 60_000,
    })
    if (dl.ok && dl.data) {
      try {
        const bytes = dl.data
        const { hostRenderedMedia } = await import("@/lib/remotion/media-host")
        const hosted = await hostRenderedMedia(createServiceClient(), `workflow-video/${talkId}.mp4`, bytes, "video/mp4")
        return { videoId: talkId, videoUrl: hosted, status: "done", engine: isV4Expressive ? "expressives" : "talks", note }
      } catch (hostErr: unknown) {
        const msg = hostErr instanceof Error ? hostErr.message : String(hostErr)
        return {
          videoId: talkId,
          videoUrl: null,
          status: "processing",
          engine: isV4Expressive ? "expressives" : "talks",
          note: [note, `D-ID job ${talkId} rendered but could not be stored in our bucket (${msg}) — poll-did-videos will retry the download`]
            .filter(Boolean).join("; "),
        }
      }
    }
    return {
      videoId: talkId,
      videoUrl: null,
      status: "processing",
      engine: isV4Expressive ? "expressives" : "talks",
      note: [note, `D-ID job ${talkId} rendered but its bytes could not be downloaded (${dl.error ?? `status ${dl.status}`}) — poll-did-videos will retry`]
        .filter(Boolean).join("; "),
    }
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
