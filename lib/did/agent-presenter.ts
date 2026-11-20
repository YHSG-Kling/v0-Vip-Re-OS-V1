// lib/did/agent-presenter.ts
// ─────────────────────────────────────────────────────────────────────────────
// WHICH PRESENTER FAMILY OUR CONVERSATIONAL AVATAR IS, AND WHAT THAT BUYS.
//
// m324 wired the live widget's microphone, barge-in and status readout onto the
// SDK methods that provide them. This module exists because that work was aimed
// at a capability our own agents did not have — and the fix is not in the
// widget, it is here.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
// lib/did/agents.ts hardcoded `presenter: { type: "clip" }` and passed our
// twin's `did_avatar_id` as the presenter_id. Two things are wrong with that,
// both readable in D-ID's published reference:
//
//  1. WRONG ID FAMILY. The OpenAPI says ClipAgentPresenter.presenter_id is
//     "ID of the video avatar used by the Agent. Retrieved from the
//     GET /presenters endpoint" — that is D-ID's pre-built presenter gallery.
//     OUR ids are `avt_…`, minted by POST /scenes/avatars (the Express /
//     Instant avatar family, m321), and `avt_` is the id shape the
//     ExpressiveAgentPresenter schema documents (example:
//     "public_mia_elegant@avt_TJ0Tq5"). We were handing a V4 id to a V3 field.
//
//  2. THE CAPABILITIES WE JUST BUILT ARE V4-ONLY. Verbatim from the Agents SDK
//     overview:
//       · publishMicrophoneStream — "Supported only with Expressive (V4) agents."
//       · unpublishMicrophoneStream — same.
//       · interrupt — "Supported for Fluent streams (V3 Pro Avatars) and all
//         Expressive (V4) agents."
//       · sentiment / should_queue_speaks — "supported for Expressive (V4)
//         agents only."
//       · streamOptions — "(Optional — v2/v3 avatars only)"; Expressive avatars
//         "manage transport settings automatically and do not use these
//         options", and fluent is "Always enabled for V4 Avatars".
//
//     So on a clip agent the microphone the widget now offers cannot work, and
//     the `fluent: true` m324 requested is a V3-Pro option that a V4 avatar
//     ignores. The widget was honest about it — every affordance is
//     feature-detected, so the mic would have reported "not available on this
//     connection" rather than lying — but honest-and-dark is still dark.
//
// ── WHY THIS IS A TABLE AND NOT AN IF ───────────────────────────────────────
// The capability matrix below is the published contract in one place, read by
// the agent builder, the session route, the widget and the guard. The previous
// arrangement had the presenter type decided in one file and the capabilities
// assumed in another, which is precisely how a widget comes to offer a button
// for something the account cannot do.
//
// PURE — no I/O.

/** The three presenter families D-ID's /agents endpoint accepts. */
export const DID_PRESENTER_TYPES = ["talk", "clip", "expressive"] as const
export type DidPresenterType = (typeof DID_PRESENTER_TYPES)[number]

export interface PresenterCapabilities {
  /** publishMicrophoneStream / unpublishMicrophoneStream. */
  microphone: boolean
  /** interrupt() — barge-in mid-playback. */
  interrupt: boolean
  /** speak({sentiment, should_queue_speaks}). */
  sentiment: boolean
  /**
   * Whether createAgentManager's `streamOptions` mean anything.
   * FALSE for expressive: the docs say V4 manages transport itself and does
   * not use these options, so sending them is noise that reads as configuration.
   */
  streamOptions: boolean
  /** Why, in one line, for whoever reads a disabled control and wonders. */
  why: string
}

/**
 * The published capability matrix.
 *
 * `interrupt` is true for clip because the SDK supports it on FLUENT streams,
 * which are "V3 Pro Avatars" — that is a plan-level distinction we cannot see
 * from here, which is exactly why the widget ALSO checks the SDK's own
 * getIsInterruptAvailable()/onInterruptibleChange at runtime rather than
 * trusting this table alone. The table decides what to OFFER; the SDK decides
 * what is actually live.
 */
export const PRESENTER_CAPABILITIES: Record<DidPresenterType, PresenterCapabilities> = {
  talk: {
    microphone: false, interrupt: false, sentiment: false, streamOptions: true,
    why: "V2 photo presenters stream over WebRTC with no microphone channel.",
  },
  clip: {
    microphone: false, interrupt: true, sentiment: false, streamOptions: true,
    why: "V3 presenters support barge-in on fluent (Pro) streams, but voice input and sentiment are V4-only.",
  },
  expressive: {
    microphone: true, interrupt: true, sentiment: true, streamOptions: false,
    why: "V4 expressive avatars stream over LiveKit with microphone input and always-on fluent mode.",
  },
}

export function capabilitiesFor(type: DidPresenterType | null | undefined): PresenterCapabilities {
  const t = (type ?? "") as DidPresenterType
  return PRESENTER_CAPABILITIES[t] ?? {
    // Unknown presenter type: offer NOTHING optional. An unrecognised family is
    // not a reason to guess a capability on — the same allow-list discipline the
    // status classifier uses.
    microphone: false, interrupt: false, sentiment: false, streamOptions: true,
    why: "Unrecognised presenter type — optional capabilities are withheld rather than guessed.",
  }
}

/**
 * The sentiment vocabulary, verbatim from the SDK overview.
 *
 * Closed on purpose: the docs say an unsupported sentiment silently falls back
 * to the default, so a typo would be invisible — the avatar would just sound
 * ordinary and nothing would report why.
 */
export const DID_SENTIMENTS = [
  "friendly", "excited", "professional", "empathetic", "frustrated",
] as const
export type DidSentiment = (typeof DID_SENTIMENTS)[number]

export function isDidSentiment(v: unknown): v is DidSentiment {
  return typeof v === "string" && (DID_SENTIMENTS as readonly string[]).includes(v)
}

/**
 * The presenter family for a twin we built ourselves.
 *
 * EXPRESSIVE, because every avatar this OS creates comes from
 * POST /scenes/avatars and carries an `avt_…` id — the family the Expressive
 * schema documents. It is also the only family where the live widget's
 * microphone and sentiment work at all, so getting this wrong does not merely
 * mis-name the avatar: it darkens the feature.
 *
 * A `talk` presenter is the one exception the API takes by source_url rather
 * than by id, and this OS does not create those, so it is not synthesised here.
 */
export function presenterTypeForTwin(didAvatarId: string | null | undefined): DidPresenterType {
  const id = (didAvatarId ?? "").trim()
  // Public gallery avatars arrive as `name@avt_xxx`; ours are the bare id. Both
  // are the expressive family.
  if (/(^|@)avt_/.test(id)) return "expressive"
  // Anything else is a presenter id from D-ID's own gallery (GET /presenters),
  // which is what the clip family expects.
  return "clip"
}

export interface AgentVoiceConfig {
  type: "elevenlabs" | "microsoft"
  voice_id: string
  voice_config?: Record<string, unknown>
}

export interface AgentPresenterBody {
  type: DidPresenterType
  presenter_id: string
  voice?: AgentVoiceConfig
}

/**
 * The presenter block for POST /agents.
 *
 * `type` and `presenter_id` are the only required fields on both the Clip and
 * Expressive schemas; voice is optional and omitted rather than defaulted when
 * the agent has no clone yet, so D-ID picks its own instead of us naming a
 * voice that is not theirs.
 */
export function buildAgentPresenter(input: {
  presenterId: string
  voice?: AgentVoiceConfig | null
  type?: DidPresenterType
}): AgentPresenterBody {
  const body: AgentPresenterBody = {
    type: input.type ?? presenterTypeForTwin(input.presenterId),
    presenter_id: input.presenterId.trim(),
  }
  if (input.voice) body.voice = input.voice
  return body
}
