// lib/did/contract.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE D-ID CONTRACT, IN ONE PLACE, VERIFIED AGAINST THE PUBLISHED API.
//
// Four surfaces call D-ID — avatar creation, the avatar poll cron, the video
// poll cron, and the inline talks/expressives client — and each had grown its
// own partial understanding of the same API. The result was the failure mode
// this OS keeps producing: a provider says something specific, and we collapse
// it into "something went wrong".
//
// Everything here is transcribed from the D-ID API reference (docs.d-id.com,
// v4.2.1), NOT from memory. The three things that reference actually says, and
// that our code did not know:
//
// 1. ERRORS ARE STRUCTURED. Every endpoint returns `{ kind, description }` with
//    documented HTTP classes: 400 (BadRequestError | InvalidFileSizeError |
//    InvalidFaceError), 401 AuthorizationError, 402 InsufficientCreditsError,
//    403 PermissionError, 451 (ImageModerationError | CelebrityRecognizedError |
//    TextModerationError | AudioModerationError). We read only `description`
//    and threw the `kind` away — so an agent who uploaded a video with no
//    detectable face, a brokerage that ran out of credits, and a headshot that
//    tripped celebrity recognition all produced the same shrug. Those are three
//    completely different things for a human to do next, and only one of them
//    is worth retrying.
//
// 2. THE STATUS VOCABULARY IS CLOSED: created | started | error | done |
//    rejected. `rejected` is a real terminal state (it is in the published
//    SceneStatus enum), which is why the poller's allow-list is correct.
//
// 3. CREATION TAKES MORE THAN A URL. POST /scenes/avatars accepts source_url,
//    consent_id, name, webhook, user_data and is_greenscreen. We sent only
//    source_url — so every avatar is unnamed in the D-ID account (a brokerage
//    with fifty agents sees fifty untitled avatars), nothing correlates the job
//    back to our row except an id we happen to store, and no webhook is
//    registered so completion depends entirely on a polling cron.
//
// PURE — no I/O, no fetch. Callers do the request; this decides what it meant.

/**
 * The closed status vocabulary.
 *
 * The published SceneStatus/ClipStatus enums are created|started|error|done|
 * rejected, but AVATAR TRAINING carries a longer lifecycle that the avatar poll
 * cron already documents from live observation: draft, validating and
 * training-started all precede `started`. They are listed here because this
 * allow-list is what decides "keep waiting" versus "terminal" — omitting a real
 * in-flight state would fail a job that was simply still training.
 */
export const DID_STATUS_IN_FLIGHT = [
  "created", "started", "processing", "pending",
  "draft", "validating", "training-started", "training",
] as const
export const DID_STATUS_TERMINAL_OK = ["done"] as const
export const DID_STATUS_TERMINAL_BAD = ["error", "rejected"] as const

export type DidStatusClass = "in_flight" | "succeeded" | "failed" | "unknown"

/**
 * Classify a job status.
 *
 * ALLOW-LIST, not deny-list. Anything unrecognised is "unknown" and must be
 * treated as TERMINAL by the caller — the previous poller continued on any
 * status it did not know, so a `rejected` job polled to timeout and then
 * reported "still processing" for something that would never finish.
 */
export function classifyDidStatus(status: string | null | undefined): DidStatusClass {
  const s = String(status ?? "").toLowerCase()
  if ((DID_STATUS_IN_FLIGHT as readonly string[]).includes(s)) return "in_flight"
  if ((DID_STATUS_TERMINAL_OK as readonly string[]).includes(s)) return "succeeded"
  if ((DID_STATUS_TERMINAL_BAD as readonly string[]).includes(s)) return "failed"
  return "unknown"
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/** The documented `kind` values. Anything else falls through to the status class. */
export type DidErrorKind =
  | "BadRequestError" | "InvalidFileSizeError" | "InvalidFaceError"
  | "AuthorizationError" | "InsufficientCreditsError" | "PermissionError"
  | "ImageModerationError" | "CelebrityRecognizedError"
  | "TextModerationError" | "AudioModerationError"
  | "NotFoundError" | "RateLimitError" | "ProviderError"

export interface DidFailure {
  kind: DidErrorKind | "UnknownError"
  /** HTTP status, when the caller had one. */
  status: number | null
  /** TRUE when retrying could plausibly succeed without a human changing something. */
  retryable: boolean
  /**
   * What the AGENT is told. Never the raw provider string — these reach a
   * human who uploaded a video and is waiting, and "InvalidFaceError" is not
   * an instruction.
   */
  userMessage: string
  /** What goes in the row / the log. Carries the provider's own words. */
  operatorMessage: string
  /** Does a human have to do something before this can ever succeed? */
  needsHumanAction: boolean
}

/**
 * Turn a D-ID error response into a decision.
 *
 * The retryable split is the point. 402 (out of credits), 451 (moderation) and
 * 400 (bad input) are things no amount of re-polling fixes — retrying them
 * burns quota and hides the real answer from the person waiting. 429 and 5xx
 * genuinely are transient.
 */
export function classifyDidError(
  httpStatus: number | null,
  body: unknown,
): DidFailure {
  const b = (body ?? {}) as { kind?: unknown; description?: unknown; message?: unknown }
  const rawKind = typeof b.kind === "string" ? b.kind : ""
  const description = typeof b.description === "string" ? b.description
    : typeof b.message === "string" ? b.message : ""
  const operator = [rawKind, description].filter(Boolean).join(": ") || `HTTP ${httpStatus ?? "?"}`

  const mk = (
    kind: DidFailure["kind"], retryable: boolean, needsHumanAction: boolean, userMessage: string,
  ): DidFailure => ({ kind, status: httpStatus, retryable, userMessage, operatorMessage: operator, needsHumanAction })

  switch (rawKind) {
    case "InvalidFaceError":
      return mk("InvalidFaceError", false, true,
        "We couldn't find a clear, single face in that video. Re-record facing the camera in even lighting, with only you in frame.")
    case "InvalidFileSizeError":
      return mk("InvalidFileSizeError", false, true,
        "That file is outside the size D-ID accepts. Try a shorter clip — around 30–90 seconds is ideal.")
    case "CelebrityRecognizedError":
      return mk("CelebrityRecognizedError", false, true,
        "Automated checks flagged this footage as a recognised public figure, so it can't be used to build an avatar. Upload footage of yourself.")
    case "ImageModerationError":
    case "AudioModerationError":
    case "TextModerationError":
      return mk(rawKind as DidErrorKind, false, true,
        "Automated content moderation rejected this submission. If you believe that's wrong, contact support for a manual review.")
    case "InsufficientCreditsError":
      // Deliberately NOT retryable: re-polling a credit exhaustion just burns
      // cron ticks while the real fix is a billing action.
      return mk("InsufficientCreditsError", false, true,
        "The video provider account is out of credits. Your admin needs to top it up before new avatars or videos can render.")
    case "PermissionError":
      return mk("PermissionError", false, true,
        "This video feature isn't enabled on the current provider plan.")
    case "AuthorizationError":
      return mk("AuthorizationError", false, true,
        "The video provider rejected our credentials. An administrator needs to check the D-ID API key.")
    case "BadRequestError":
      return mk("BadRequestError", false, true,
        "The video provider rejected the request. The source file may be an unsupported format.")
  }

  // No documented kind — fall back to the HTTP class.
  if (httpStatus === 404) return mk("NotFoundError", false, false,
    "The provider no longer has this job. Please start it again.")
  if (httpStatus === 401 || httpStatus === 403) return mk("AuthorizationError", false, true,
    "The video provider rejected our credentials or plan permissions.")
  if (httpStatus === 402) return mk("InsufficientCreditsError", false, true,
    "The video provider account is out of credits.")
  if (httpStatus === 451) return mk("ImageModerationError", false, true,
    "Automated content moderation rejected this submission.")
  if (httpStatus === 429) return mk("RateLimitError", true, false,
    "The video provider is rate-limiting us. This will retry automatically.")
  if (httpStatus !== null && httpStatus >= 500) return mk("ProviderError", true, false,
    "The video provider had a temporary problem. This will retry automatically.")

  return mk("UnknownError", httpStatus === null, false,
    "The video provider returned an unexpected response. This has been logged.")
}

/** Should a poller try this job again on the next tick? */
export function isRetryable(f: DidFailure): boolean {
  return f.retryable
}

// ─────────────────────────────────────────────────────────────────────────────
// Requests
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpressAvatarRequest {
  source_url: string
  name?: string
  consent_id?: string
  webhook?: string
  user_data?: string
  is_greenscreen?: boolean
}

/**
 * The COMPLETE POST /scenes/avatars body, per the published contract.
 *
 * `user_data` is the field D-ID designed for exactly the correlation problem we
 * had: it is echoed back on both the job response AND the webhook, so a
 * completion can be matched to our row without trusting an id we stored on a
 * separate write. Capped at 1000 chars and must not be blank, per the schema.
 *
 * `name` matters operationally rather than technically — without it a brokerage
 * with fifty agents has fifty untitled avatars in the D-ID account and no way
 * to tell whose is whose when something needs support.
 */
export function buildExpressAvatarRequest(input: {
  sourceUrl: string
  /** Our agent_avatar_assets row id — travels as user_data for correlation. */
  assetId?: string | null
  agentName?: string | null
  label?: string | null
  consentId?: string | null
  webhookUrl?: string | null
  isGreenscreen?: boolean
}): ExpressAvatarRequest {
  const req: ExpressAvatarRequest = { source_url: input.sourceUrl }

  const name = [input.agentName?.trim(), input.label?.trim()].filter(Boolean).join(" — ").slice(0, 120)
  if (name) req.name = name

  if (input.consentId?.trim()) req.consent_id = input.consentId.trim()
  // Webhook must be https per the schema pattern; an http dev URL is dropped
  // rather than sent and rejected.
  if (input.webhookUrl && /^https:\/\/\S+$/.test(input.webhookUrl)) req.webhook = input.webhookUrl
  if (input.assetId) req.user_data = `asset:${input.assetId}`.slice(0, 1000)
  if (input.isGreenscreen === true) req.is_greenscreen = true

  return req
}

/** Parse the correlation id back out of a job's user_data. */
export function assetIdFromUserData(userData: unknown): string | null {
  if (typeof userData !== "string") return null
  const m = /^asset:([0-9a-fA-F-]{36})$/.exec(userData.trim())
  return m ? m[1] : null
}

/**
 * The header that makes OUR ElevenLabs voice clones work.
 *
 * The reference is explicit: "Use your own ElevenLabs API key for TTS (IVC
 * voices only), consuming your ElevenLabs quota." Our agent voices ARE IVC
 * (instant voice clones) created in our own ElevenLabs account, so without this
 * header D-ID resolves voice_id against ITS account, where our clones do not
 * exist. Documented on /talks, /clips and /scenes alike.
 *
 * Returns {} when no key is configured, so the caller simply gets D-ID's own
 * stock voices rather than a failed request.
 */
export function externalKeyHeader(elevenLabsKey?: string | null): Record<string, string> {
  const key = (elevenLabsKey ?? process.env.ELEVENLABS_API_KEY ?? "").trim()
  if (!key) return {}
  return { "x-api-key-external": JSON.stringify({ elevenlabs: key }) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Consent (pure half) — the server I/O lives in lib/did/consent.ts
// ─────────────────────────────────────────────────────────────────────────────

/** The languages D-ID accepts for a consent script. */
export const CONSENT_LANGUAGES = [
  "english", "spanish", "french", "german", "italian", "portuguese", "dutch",
  "polish", "turkish", "swedish", "indonesian", "filipino", "czech",
  "romanian", "danish", "malay", "slovak", "croatian",
] as const
export type ConsentLanguage = (typeof CONSENT_LANGUAGES)[number]

export function normalizeConsentLanguage(input?: string | null): ConsentLanguage {
  const v = (input ?? "").trim().toLowerCase()
  return (CONSENT_LANGUAGES as readonly string[]).includes(v) ? (v as ConsentLanguage) : "english"
}

/**
 * Does this avatar source require a verified consent?
 *
 * VIDEO does — that is a V3 Instant Avatar, built from footage of a real person,
 * and it is the flow the consent process exists to police. A PHOTO-sourced V2
 * talking head does not go through instant-avatar training, so demanding a
 * passcode performance for one would be friction with nothing behind it.
 */
export function consentRequiredFor(sourceType: "photo" | "video"): boolean {
  return sourceType === "video"
}

/**
 * The on-screen instruction set, here so every surface says the same thing —
 * and so the capture component (a client component) can read it without
 * pulling in the server-only D-ID client.
 */
export const CONSENT_INSTRUCTIONS = [
  "Look straight at the camera in a well-lit room, with only you in frame.",
  "Read the three words on screen aloud, clearly and at a normal pace.",
  "Recording must be done here on camera — an uploaded file cannot be accepted.",
] as const
