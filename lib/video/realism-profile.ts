/**
 * lib/video/realism-profile.ts
 *
 * OWNER RULING (wave 55, 2026-09-11), verbatim: "all video scripts/avatar use/
 * video creation needs to be on an advanced level and the video product the os
 * creates needs to look and appear real and not a fake ai creation. the person
 * viewing the video must not think it was made with ai." Avatar videos are
 * named the single most important capability this OS ships.
 *
 * THIS IS THE ONE PLACE realism knobs live (§6 — one vocabulary per function).
 * Before this file: D-ID's `config` was assembled ad hoc at each call site with
 * an inconsistent shape between the two source branches (lib/providers/
 * dispatch.ts had `fluent`/`pad_audio` on the photo-driven `/talks` branch and
 * NOT on the video-driven `/clips` branch — same realism concern, two different
 * answers, the exact §6 defect), and ElevenLabs' `voice_settings` was never
 * sent AT ALL on the avatar-video TTS call (lib/providers/dispatch.ts) — every
 * avatar video's voice rode whatever ElevenLabs' bare API default happens to be
 * today, not a value anyone chose for realism. lib/voice/elevenlabs-tts.ts had
 * its own separate DEFAULT_VOICE_SETTINGS, unresearched (ElevenLabs' raw
 * defaults, stability 0.5 / similarity_boost 0.75 / style 0), which is a
 * different spelling of the same "what does a realistic voice sound like"
 * question. Both now read from ONE constant here.
 *
 * ── RESEARCH (Exa web search + web_fetch, 2026-09-11) ───────────────────────
 *
 * D-ID Talks/Clips API (docs.d-id.com/reference/createtalk,
 * docs.d-id.com/reference/createclip, docs.d-id.com/docs/tts-microsoft, fetched
 * 2026-09-11):
 *   · `config.stitch` — "Stitch back the animated result to the original
 *     image." Without it the result is the driver's own crop, not the agent's
 *     actual photo/video — the single biggest giveaway that the frame was
 *     puppeted rather than filmed.
 *   · `config.fluent` — "Interpolate between the last & first frames of the
 *     driver video," default false. D-ID's own best-practice doc for
 *     idle/silent clips names `fluent: true` as what removes a "noticeable
 *     jump-cut" at the loop point; the same interpolation removes the same
 *     jump-cut at the START of every ordinary talk/clip render.
 *   · `config.pad_audio` — seconds of trailing silence appended before D-ID
 *     renders, 0-60, default 0. At 0 the render's last frame is whatever
 *     viseme the mouth was mid-shaping when the audio track ends — a visibly
 *     unnatural half-open mouth freeze. A small pad (we use 0.3s) lets the
 *     driver settle to a closed/neutral mouth before the clip ends.
 *   · `config.driver_expressions` (`ExpressionConfig`/`TimedExpression`) —
 *     `{expression, intensity, start_frame}`. A flat `neutral` expression for
 *     the whole clip is the #1 reason a talking head reads "uncanny" —
 *     dispatch.ts already resolves a per-agent default (`happy` @ 0.7) from
 *     `agent_voice_profiles`; this file does not replace that per-agent choice,
 *     it fixes the surrounding config fields that were inconsistent around it.
 *   · `driver_url: "bank://natural"` — D-ID's own idle-video guidance names
 *     this driver as the one that "provides the best results" when there is no
 *     custom driver video (i.e. the photo-only path) — already used correctly
 *     on the photo branch; this file does not change it.
 *
 * ElevenLabs (elevenlabs.io/docs/api-reference/text-to-speech/convert,
 * elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices,
 * github.com/elevenlabs/skills text-to-speech/references/voice-settings.md,
 * a 2026-05-31 engineering deep-dive on what the sliders actually do — all
 * fetched 2026-09-11):
 *   · `stability` (0-1, default 0.5) — "Lower values introduce broader
 *     emotional range... higher values can result in a monotonous voice."
 *     0.5 already reads as "someone reading from a script" for a to-camera
 *     piece; 0.40-0.48 is the band the deep-dive and ElevenLabs' own examples
 *     converge on for a natural, spontaneous-sounding conversational read.
 *   · `similarity_boost` (0-1, default 0.75) — how tightly the output matches
 *     the cloned voice. For a CLONED agent voice (the case here — every avatar
 *     video call this file's constant reaches uses the agent's own
 *     `elevenlabs_voice_id` clone) a low value drifts toward ElevenLabs'
 *     generic baseline, i.e. it stops sounding like the specific person the
 *     viewer is supposed to recognize. 0.82-0.88 is the band the research
 *     names as "stops sounding like an impression and starts sounding like the
 *     person."
 *   · `style` (0-1, default 0) — style exaggeration. 0 is flat/neutral; the
 *     research explicitly warns that above ~0.3 "you're producing audio for a
 *     podcast intro, not a message from a person." A real-estate to-camera
 *     video is closer to that "message from a person" register than a
 *     performance, so this file lands low-moderate (0.18).
 *   · `use_speaker_boost` — "boosts the similarity to the original speaker,"
 *     recommended ON for cloned voices specifically (the deep-dive: "for
 *     cloned voices, it's always worth enabling — the perceptible quality
 *     improvement is real"). Every caller of this constant is a cloned voice.
 *   · `apply_text_normalization` — three modes (on/off/auto); ElevenLabs'
 *     help center: normalization "spells out numbers and dates to ensure
 *     proper pronunciation," at a latency cost. "auto" is the documented
 *     middle ground (the AI decides when the input needs it) and is what this
 *     file exports rather than forcing "on" on every short avatar-video line.
 *   · SSML `<break>` tags are honored by `eleven_multilingual_v2` (this repo's
 *     model, see lib/voice/elevenlabs-tts.ts LANGUAGE_ENFORCEMENT_MODELS'
 *     sibling research) but NOT by `eleven_v3` — this repo does not use v3, so
 *     no `<break>` handling is added here; recorded so a future v3 adoption
 *     does not silently inherit break tags that model ignores.
 *
 * Script realism for AI avatars (Exa web search, 2026-09-11 — cloudpano.com's
 * two AI-real-estate-avatar scripting guides, quickinfoai.com's "spoken
 * language rules" block, lilachbullock.com's AI-avatar-video workflow guide,
 * kineclip.com / reviewnexa.com / videoai.me / therankmasters.com's 2026
 * "how to make AI video look real" write-ups): the same handful of rules
 * recur across every source —
 *   · contractions throughout; short sentences said in one breath (~15 words);
 *     no formal written-register transitions ("furthermore", "additionally",
 *     "it is worth noting");
 *   · never open with a self-introduction ("hi, i'm X from Y, and today...") —
 *     open with the fact/hook/situation;
 *   · never let the avatar reference being AI-generated;
 *   · no canned video sign-offs ("thanks for watching", "subscribe");
 *   · name real, specific, already-known facts (a street, a number, a name) —
 *     specificity is what a viewer reads as "a real person said this";
 *   · one idea per sentence — a wall-of-text sentence read by TTS is the
 *     "monotone AI voice" tell even when the voice model itself is good.
 * SPOKEN_REALISM_DIRECTIVE below is that rule set, phrased as a system-prompt
 * directive; scanForAiTells is the deterministic backstop that catches what a
 * model ships anyway, with positive AND negative controls (§2) so the check
 * cannot silently degrade into a no-op.
 */

import { spokenWords, spokenSentences, avatarFadeOutFrame } from "./script-structure"
export { avatarFadeOutFrame } from "./script-structure"

// ─────────────────────────────────────────────────────────────────────────────
// § D-ID TALK/CLIP REALISM CONFIG
// ─────────────────────────────────────────────────────────────────────────────

/** D-ID `TalksConfig` / `ClipConfig` fields tuned for realism, per the research
 *  above. ONE object — every D-ID `/talks` and `/clips` submission spreads
 *  this in and then adds only what genuinely differs per call (the resolved
 *  `driver_expressions`, which is per-agent and stays a caller concern). */
export const DID_TALK_REALISM_CONFIG = {
  stitch: true,
  fluent: true,
  /** Seconds of trailing silence so the mouth settles before the clip ends —
   *  see the header note on the mid-viseme freeze this replaces. Kept small:
   *  D-ID bills pad_audio into render duration/credits. */
  pad_audio: 0.3,
  result_format: "mp4" as const,
} as const

/** The idle-driver bank entry D-ID's own docs name as producing the best
 *  result for a photo-only (no custom driver video) source. ONE spelling —
 *  lib/providers/dispatch.ts already used this literal; re-exported here so a
 *  future call site does not retype it and drift. */
export const DID_NATURAL_DRIVER_URL = "bank://natural"

// ─────────────────────────────────────────────────────────────────────────────
// § D-ID V4 EXPRESSIVE — REACHABILITY FINDING (wave 57)
// ─────────────────────────────────────────────────────────────────────────────
//
// Task ask: "if reachable, add the config to DID_TALK_REALISM_CONFIG behind a
// documented flag; if not, record the finding in the header (unresolved, with
// source)." Neither branch is quite right — V4 Expressive IS reachable, but
// NOT as an addition to DID_TALK_REALISM_CONFIG, because it is not the same
// API surface at all.
//
// RESEARCH (Exa, 2026-09-11): d-id.com/introducing-v4-expressive-avatars/
// (2026-02-02) — "Conversational latency (end-to-end): < 500 ms... Excellent
// lip-sync accuracy: 5.7 LSE-D... Accessible in D-ID Studio and via the D-ID
// API." docs.d-id.com's own OpenAPI (Videos V4) shows V4 avatars are created
// with a `presenter_id` (a pre-provisioned "digital twin" object, NOT a
// per-request `source_url`/`driver_url` pair) and rendered via `POST /videos`,
// a structurally different endpoint from `/talks` and `/clips` — DID_TALK_
// REALISM_CONFIG's fields (`stitch`, `fluent`, `pad_audio`, `driver_expressions`)
// are TalksConfig fields that do not exist on that request shape at all, so
// spreading this constant into a V4 submission would send fields V4 ignores or
// rejects, not a realism upgrade. d-id.com/ai-avatars/'s own comparison table:
// custom ("digital twin") avatars on V4 are "Custom avatar plan availability:
// Enterprise" ONLY (V2/V3-Instant: all plans; V3-Pro: Pro and above) — this
// account's D-ID plan tier is not visible from here, so whether OUR agents can
// even MINT a V4 presenter_id for their own likeness is UNRESOLVED.
//
// THE SURVIVOR (orphan doctrine §1 — "functionality already lives elsewhere"):
// V4 Expressive is ALREADY REACHABLE AND WIRED in this repo, at
// lib/did/index.ts's generateVideo() (`isV4Expressive` branch, `didPost(
// "/expressives", …)`), gated on an avatar id carrying the "@avt_" marker
// (lib/did/agent-presenter.ts's presenterTypeForTwin — the ONE detector, reused
// below rather than re-implemented) and used today by
// lib/intelligence/partners-meeting.ts's internal-report video. That is the
// correct home for any FUTURE V4 config tuning (sentiment_id, config.
// result_format) — not this file's TalksConfig-shaped constant.
//
// THE ACTUAL GAP THIS WAVE CLOSES: lib/providers/dispatch.ts's
// dispatchVideoViaDID (the agent-outreach EMAIL avatar-video path) queried
// agent_voice_profiles for `elevenlabs_voice_id, did_photo_url, did_video_url,
// default_expression, expression_intensity` — NEVER `did_avatar_id`, the
// column that carries the "@avt_" marker — so it could never detect an agent
// who has upgraded to a V4 Expressive avatar; every outreach video silently
// downgraded that agent to the older /talks or /clips path even when a V4
// presenter was configured. Fixed at dispatch.ts (see its own comment at the
// fix) by selecting `did_avatar_id` and branching through presenterTypeForTwin
// exactly like lib/did/index.ts already does — ONE detector, two callers,
// never a second regex for "is this an @avt_ id" (§6).

// ─────────────────────────────────────────────────────────────────────────────
// § ELEVENLABS VOICE REALISM SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

export interface ElevenLabsRealismVoiceSettings {
  stability: number
  similarity_boost: number
  style: number
  use_speaker_boost: boolean
}

/** ElevenLabs `voice_settings` tuned for a natural, conversational, to-camera
 *  read of a CLONED agent voice — see the header research note for why each
 *  number is what it is. ONE constant, used by every avatar/voice call site
 *  (lib/providers/dispatch.ts's D-ID TTS leg, lib/voice/elevenlabs-tts.ts's
 *  DEFAULT_VOICE_SETTINGS) so "what does realistic sound like" is answered
 *  once rather than redefined — and re-tuned — per caller. */
export const ELEVENLABS_REALISM_VOICE_SETTINGS: ElevenLabsRealismVoiceSettings = {
  stability: 0.44,
  similarity_boost: 0.85,
  style: 0.18,
  use_speaker_boost: true,
}

/** `apply_text_normalization` mode — "auto" per the header research note
 *  (ElevenLabs decides when the input needs number/date spell-out, rather
 *  than paying the latency cost on every short avatar-video line, or risking
 *  a mispronounced price/date by never applying it). */
export const ELEVENLABS_TEXT_NORMALIZATION: "auto" = "auto"

// ─────────────────────────────────────────────────────────────────────────────
// § WAVE 57 — ELEVENLABS MODEL PER LANE + NATURAL PAUSES
// ─────────────────────────────────────────────────────────────────────────────
//
// OWNER RULING (wave 57, 2026-09-11), verbatim: "no need to add heygen at this
// time if what we have is advanced so make any upgrades like v3 and if voice
// between elevenlabs or twilio". Stay on D-ID + ElevenLabs; upgrade the model
// selection and add the expressive controls v3 actually ships.
//
// RESEARCH (Exa web_search_exa + web_fetch_exa, all fetched/searched
// 2026-09-11 unless a publish date is shown):
//   · Eleven v3 (`eleven_v3`) — elevenlabs.io/docs/overview/models: "the most
//     advanced speech synthesis model... natural, life-like speech with high
//     emotional range." SAME billed rate as multilingual_v2 — $0.10 per 1,000
//     characters, both listed under "Multilingual v2 / v3" on
//     elevenlabs.io/pricing/api — so this upgrade is COST-NEUTRAL. Audio tags
//     (`[laughs]`, `[whispers]`, `[sighs]`, `[pause]`/`[short pause]`/
//     `[long pause]`, …) and native IPA phoneme control are v3-ONLY
//     (elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices,
//     elevenlabs.io/blog/v3-audiotags, 2025-06-06) — multilingual_v2 does not
//     honour them (a v2 request containing `[pause]` speaks the bracket text
//     literally, per a 2026-05-11 vendor-neutral reference,
//     hivebook.wiki/wiki/elevenlabs-api-tts-with-eleven-v3-ga: "Tags pasted
//     into a Multilingual v2 or Flash request are read aloud literally as
//     words"). v3 does NOT support SSML `<break>` — best-practices.mdx:
//     "Eleven v3 does not support SSML break tags... Use audio tags,
//     punctuation... to control pauses." multilingual_v2 DOES honour SSML
//     `<break>` (this repo's own prior research, lib/voice/elevenlabs-tts.ts
//     header) — the two models need two different pause mechanisms, which is
//     exactly why withNaturalPauses below branches on `model` rather than
//     emitting one spelling for both.
//   · Stability is exposed on v3 as three NAMED modes rather than a bare
//     slider (help.elevenlabs.io "What is Eleven v3"; best-practices.mdx
//     "Prompting Eleven v3"): Creative (low — emotional, prone to
//     hallucination), Natural (balanced — closest to the reference
//     recording), Robust (high — stable, least responsive to audio tags,
//     "similar to v2"). ElevenLabs does not publish exact floats for the
//     three modes, but three independent 2026 sources converge on the same
//     BAND for a tag-responsive "Natural"-equivalent setting: agentvsai.com
//     ("lowering stability e.g. to 0.35-0.45 significantly increases the
//     model's adherence to Audio Tags"), ekly.ai ("stability ≈ 50... adjust
//     minimally"), hivebook.wiki ("0.4-0.6 is typical"). This file's existing
//     `ELEVENLABS_REALISM_VOICE_SETTINGS.stability = 0.44` (wave 55, tuned
//     BEFORE this v3 research existed, for an unrelated reason — "someone
//     reading from a script" vs spontaneous) already sits inside that exact
//     band, so no numeric change was needed to adopt v3's tag-responsive
//     "Natural" register — only the model_id and the tags themselves. Kept as
//     ONE constant (§6): no second, v3-specific voice_settings object.
//   · v3 is explicitly NOT for the PHONE lane — help.elevenlabs.io "What is
//     Eleven v3": "more variable consistency and higher latency mean it's not
//     suitable for real-time or conversational use cases. For those, we
//     recommend Flash v2 (English) or v2.5 (Multilingual)." Flash v2.5
//     (`eleven_flash_v2_5`) is ElevenLabs' own current pick for real-time
//     (elevenlabs.io/docs/eleven-api/choosing-the-right-model: "~75ms...the
//     best all-round choice" for conversational agents), at HALF the
//     per-character price of v3/multilingual_v2 (help.elevenlabs.io "What
//     models do you offer"). This task named "Turbo/Flash v2.5", but
//     ElevenLabs' own models doc is explicit that Turbo is the OLDER of the
//     two: "`eleven_turbo_v2_5` and `eleven_turbo_v2` are functionally
//     equivalent to the Flash models... except the latency on Flash models is
//     lower on average. We recommend using the Flash models over Turbo models
//     in ALL use cases" (elevenlabs.io/docs/overview/models) — one 2026-06-18
//     third-party comparison (voxrater.com) even lists Turbo as "Retired, use
//     Flash v2.5." So this file selects Flash v2.5, never Turbo, for the
//     phone lane; the Turbo id is kept below ONLY as a documented deprecated
//     synonym so nobody reintroduces it believing it is still the modern
//     real-time choice.
//   · TIMESTAMPS/ALIGNMENT on v3 (this repo's word-synced captions depend on
//     it): ElevenLabs has not published one single "v3 + /with-timestamps:
//     yes" line, but two same-vendor facts converge on yes — (1) the NEWER
//     `/v1/text-to-dialogue/with-timestamps` endpoint
//     (elevenlabs.io/docs/api-reference/text-to-dialogue/
//     convert-with-timestamps) defaults `model_id` to `eleven_v3` — ElevenLabs
//     ships v3 as the DEFAULT model for a timestamps-returning endpoint, not
//     an unsupported one; (2) the 2026-05-11 hivebook.wiki v3-GA reference
//     documents "Convert with timing (POST /v1/text-to-speech/{voice_id}/
//     with-timestamps)... useful for caption sync" as part of v3's OWN
//     capability write-up, with no model exclusion noted. The ONE documented
//     v3 exclusion found anywhere is the WebSocket streaming-input endpoint
//     (elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts:
//     "does not support the eleven_v3 model") — this repo does not call that
//     endpoint; lib/voice/elevenlabs-tts.ts's synthesizeSpeechWithTimestamps
//     is the plain HTTP with-timestamps endpoint. If this finding is ever
//     wrong in production, the existing fallback already absorbs it for free:
//     lib/video/reel-voiceover.ts falls back from
//     synthesizeSpeechWithTimestamps to plain synthesizeSpeech on ANY
//     failure, degrading to honestly-labelled even-distribution captions
//     rather than breaking the render.
//   · language_code enforcement is UNCHANGED by adopting v3 — v3 is not on
//     ElevenLabs' enforcement allowlist any more than multilingual_v2 is
//     (elevenlabs.io/docs/api-reference/text-to-speech/convert: "language_code
//     ... not supported for multilingual_v2 models"; ElevenLabs states
//     enforcement is Turbo v2.5 / Flash v2.5 ONLY — the exact prior research
//     already in lib/voice/elevenlabs-tts.ts's LANGUAGE_ENFORCEMENT_MODELS).
//     v3's 70+ languages (elevenlabs.io/docs/overview/models) are a SUPERSET
//     of every locale lib/video/language-vocabulary.ts's LANGUAGE_NAMES
//     resolves — including "no" (Norwegian) and "vi" (Vietnamese), which
//     multilingual_v2's own 29-language list omits — so elevenLabsModelForLane
//     needs no language-conditional fallback to multilingual_v2 for coverage.
//   · D-ID V4 EXPRESSIVE — see the header note above DID_TALK_REALISM_CONFIG's
//     companion section further down this file for the finding (already
//     wired elsewhere in this repo, not a fit for THIS config object).

export type ElevenLabsLane = "avatar_narration" | "reel_narration" | "phone_realtime" | "voice_drop"

/** model_id for the three NARRATION lanes (avatar email-video, reel
 *  voiceover, and voice-drop voicemail) — v3, timestamped and plain.
 *  Word-synced captions need alignment, which v3 is expected to support (see
 *  the research block above); every caller already falls back to plain
 *  synthesis on any failure.
 *
 *  WAVE 58 — "voice_drop" ADDED (renderVoiceDrop, lib/voice/render-voice-drop.ts):
 *  a voicemail drop is SCRIPTED and PRE-RENDERED, never a live back-and-forth —
 *  it is read once, to an audience that cannot interrupt or ask it to slow
 *  down — which is exactly the "someone reading from a script" register v3
 *  and this file's ELEVENLABS_REALISM_VOICE_SETTINGS were tuned for (see the
 *  stability-band note above), and exactly UNLIKE "phone_realtime" (a live,
 *  interruptible <ConversationRelay> turn, where v3's own docs rule it out:
 *  "not suitable for real-time... higher latency"). Grouped with the
 *  narration lanes rather than the phone lane on that distinction, not on
 *  "does this happen to ride a phone call" — the phone lane's speed
 *  requirement is about interruptibility, and a voice drop is never
 *  interrupted. */
export const ELEVENLABS_NARRATION_MODEL_ID = "eleven_v3"

/** model_id for the PHONE lane — Flash v2.5, ElevenLabs' own real-time
 *  recommendation. NOT v3 (ElevenLabs: "not suitable for real-time"; higher
 *  and more variable latency) and NOT Turbo v2.5 (ElevenLabs: use Flash over
 *  Turbo "in all use cases" — see the research block above). */
export const ELEVENLABS_PHONE_MODEL_ID = "eleven_flash_v2_5"

/** The deprecated synonym some ElevenLabs/Twilio material still names.
 *  NEVER returned by elevenLabsModelForLane — documented only so a future
 *  reader who finds "Turbo v2.5" in older material does not reintroduce it
 *  believing it is still the modern real-time choice (see research above). */
export const ELEVENLABS_PHONE_MODEL_ID_DEPRECATED_SYNONYM = "eleven_turbo_v2_5"

/**
 * elevenLabsModelForLane — PURE. THE ONE model_id selector (§6) for every
 * ElevenLabs narration/phone call site in the video + voice lanes — never a
 * second hardcoded "eleven_v3" / "eleven_flash_v2_5" literal at a call site.
 *
 * `languageCode` is accepted (not merely decorative — a future language v3
 * does not cover would need this to fall back to multilingual_v2) but is
 * CURRENTLY a no-op: per the research block above, v3's 70+ languages already
 * cover every locale this repo resolves, so no lane needs a language-
 * conditional fallback today.
 */
export function elevenLabsModelForLane(lane: ElevenLabsLane, languageCode?: string | null): string {
  void languageCode
  return lane === "phone_realtime" ? ELEVENLABS_PHONE_MODEL_ID : ELEVENLABS_NARRATION_MODEL_ID
}

/** `withNaturalPauses` honours "voice_drop" for free: it dispatches on the
 *  resolved MODEL id, not the lane name, and "voice_drop" resolves to the
 *  same eleven_v3 model id as the other narration lanes
 *  (NATURAL_PAUSE_AUDIO_TAG_MODELS below is keyed by model). No lane-specific
 *  branch needed here — asserted by the positive control alongside
 *  withNaturalPauses' other controls further down this file. */

// ─── Natural pauses ───────────────────────────────────────────────────────────
//
// v3 audio tags for pacing (`[short pause]`, `[long pause]`) vs
// multilingual_v2's SSML `<break>` — see the research block above for why
// each model needs its OWN spelling and why the two are mutually exclusive
// (v3 does not honour `<break>`; multilingual_v2 speaks `[short pause]`
// literally). Any OTHER model (Flash/Turbo — the phone lane) is left
// UNTOUCHED: neither mechanism is confirmed honoured there, and the phone
// lane's replies are already forced to one short sentence by
// lib/voice/conversation-relay.ts's composePacingRule, so there is no
// multi-sentence/paragraph script for this function to pace in the first
// place.

const NATURAL_PAUSE_AUDIO_TAG_MODELS = new Set<string>([ELEVENLABS_NARRATION_MODEL_ID])
const NATURAL_PAUSE_SSML_BREAK_MODELS = new Set<string>(["eleven_multilingual_v2"])

const SENTENCE_PAUSE_TAG = "[short pause]"
const PARAGRAPH_PAUSE_TAG = "[long pause]"
/** elevenlabs.io best-practices.mdx: "Use `<break>` for natural pauses up to
 *  3 seconds" — 0.35s / 1.2s are this file's own numbers (§6 — the same
 *  "short beat vs a real breath" distinction SENTENCE_PAUSE_TAG /
 *  PARAGRAPH_PAUSE_TAG already draw for v3), not an ElevenLabs-published
 *  default duration. */
const SENTENCE_PAUSE_BREAK = '<break time="0.35s" />'
const PARAGRAPH_PAUSE_BREAK = '<break time="1.2s" />'

/** The exact markup withNaturalPauses can insert — reused by
 *  stripNaturalPauseMarkup and alignmentWithoutPauseMarkup so the "what did
 *  we insert" and "what do we strip back out" vocabularies can never drift
 *  apart (§6). */
const PAUSE_MARKUP_PATTERN = /\[(?:short pause|long pause)\]|<break[^>]*\/>/g

/**
 * withNaturalPauses — PURE. Inserts pause markup at SENTENCE boundaries
 * (reuses script-structure.ts's spokenSentences — the ONE sentence splitter,
 * §6, the exact boundary fitNarrationToBudget already trims on) and
 * PARAGRAPH boundaries (a blank line in the source script) — but ONLY for a
 * model that actually honours the mechanism it would insert. Any other
 * model — including the phone lane's Flash/Turbo — is returned UNCHANGED, so
 * a caller can apply this unconditionally without checking the model itself.
 *
 * Never inserts a TRAILING pause after the final sentence of a paragraph
 * (nothing left to say — that would read as dead air) or after the final
 * paragraph of the script.
 */
export function withNaturalPauses(script: string | null | undefined, model: string): string {
  const text = (script ?? "").trim()
  if (!text) return text

  const useAudioTags = NATURAL_PAUSE_AUDIO_TAG_MODELS.has(model)
  const useSsmlBreak = !useAudioTags && NATURAL_PAUSE_SSML_BREAK_MODELS.has(model)
  if (!useAudioTags && !useSsmlBreak) return text

  const sentencePause = useAudioTags ? ` ${SENTENCE_PAUSE_TAG} ` : ` ${SENTENCE_PAUSE_BREAK} `
  const paragraphPause = useAudioTags ? ` ${PARAGRAPH_PAUSE_TAG} ` : ` ${PARAGRAPH_PAUSE_BREAK} `

  const paragraphs = text.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean)
  const pacedParagraphs = paragraphs.map((paragraph) => {
    const sentences = spokenSentences(paragraph)
    if (sentences.length <= 1) return paragraph
    return sentences
      .map((s, i) => (i < sentences.length - 1 ? `${s}${sentencePause}` : s))
      .join(" ")
  })
  return pacedParagraphs.join(paragraphPause)
}

/**
 * stripNaturalPauseMarkup — PURE, the exact inverse of withNaturalPauses'
 * insertions. Used wherever a SCRIPT (not an alignment) must reach a caption
 * or a downstream reader tag-free — e.g. the even-distribution caption
 * fallback, which builds cues from the raw script text rather than alignment
 * and would otherwise render a literal "[short pause]" cue on screen.
 */
export function stripNaturalPauseMarkup(taggedText: string | null | undefined): string {
  return (taggedText ?? "").replace(PAUSE_MARKUP_PATTERN, " ").replace(/\s+/g, " ").trim()
}

export interface PauseableAlignment {
  characters: string[]
  character_start_times_seconds: number[]
  character_end_times_seconds: number[]
}

/**
 * alignmentWithoutPauseMarkup — PURE. The PREFERRED caption path
 * (lib/voice/elevenlabs-tts.ts synthesizeSpeechWithTimestamps) returns
 * character-level alignment for whatever TEXT was actually sent — which, once
 * withNaturalPauses runs before synthesis, includes the inserted markup.
 * ElevenLabs has published no statement on whether its alignment response
 * includes or omits audio-tag/break characters, so this function is written
 * to be CORRECT EITHER WAY: it finds every markup span inside the joined
 * `characters` array by the SAME PAUSE_MARKUP_PATTERN withNaturalPauses
 * inserts (§6 — one vocabulary for "what pause markup looks like") and drops
 * every character index that falls inside one. If ElevenLabs already omits
 * tag characters, no span is found and this is a no-op — verified by the
 * "already tag-free" positive control alongside the "has tag characters"
 * one in the avatar-pipeline-hardening simulator.
 *
 * This is the reader-side half of "never inside the caption text" — captions
 * (lib/video/caption-plan.ts buildCaptionPlan) consume ONLY the alignment
 * this function returns, never the raw stamped.alignment.
 */
export function alignmentWithoutPauseMarkup(
  alignment: PauseableAlignment | null | undefined,
): PauseableAlignment | null {
  if (!alignment) return null
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment
  if (!Array.isArray(characters) || characters.length === 0) return alignment

  const joined = characters.join("")
  const dropRanges: Array<[number, number]> = []
  const re = new RegExp(PAUSE_MARKUP_PATTERN.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(joined))) dropRanges.push([m.index, m.index + m[0].length])
  if (dropRanges.length === 0) return alignment

  const keepChars: string[] = []
  const keepStarts: number[] = []
  const keepEnds: number[] = []
  for (let i = 0; i < characters.length; i++) {
    if (dropRanges.some(([a, b]) => i >= a && i < b)) continue
    keepChars.push(characters[i])
    keepStarts.push(starts[i])
    keepEnds.push(ends[i])
  }
  return { characters: keepChars, character_start_times_seconds: keepStarts, character_end_times_seconds: keepEnds }
}

/**
 * POSITIVE + NEGATIVE CONTROLS (§2) for withNaturalPauses /
 * stripNaturalPauseMarkup / alignmentWithoutPauseMarkup — asserted in
 * scripts/avatar-pipeline-hardening-simulator.ts's §v3 section.
 */
export const NATURAL_PAUSES_FIXTURE_SCRIPT =
  "Three days on market, two offers already. The kitchen's been redone — quartz counters, new appliances.\n\n" +
  "If you want a private showing before the weekend, just text me back. I'll make it easy."

/** A synthetic alignment fixture whose characters DO include inserted pause
 *  markup — the positive control proving alignmentWithoutPauseMarkup can
 *  actually find and remove it, not merely no-op on everything.
 *  @proofSeam scripts/avatar-pipeline-hardening-simulator.ts §v3 */
export const PAUSE_MARKUP_ALIGNMENT_FIXTURE: PauseableAlignment = (() => {
  const text = `Nice. ${SENTENCE_PAUSE_TAG} Right there.`
  const characters = text.split("")
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => i * 0.05),
    character_end_times_seconds: characters.map((_, i) => (i + 1) * 0.05),
  }
})()

/** The SAME fixture text with the markup already removed — what
 *  alignmentWithoutPauseMarkup(PAUSE_MARKUP_ALIGNMENT_FIXTURE) must
 *  reconstruct (joining `characters` back together). */
export const PAUSE_MARKUP_ALIGNMENT_FIXTURE_EXPECTED_TEXT = "Nice.  Right there."

/** NEGATIVE CONTROL — an alignment with no tag characters at all. Proves
 *  alignmentWithoutPauseMarkup is a true no-op on ordinary alignment, not a
 *  function that happens to always return something shorter.
 *  @proofSeam scripts/avatar-pipeline-hardening-simulator.ts §v3 */
export const PLAIN_ALIGNMENT_FIXTURE: PauseableAlignment = (() => {
  const text = "Nice. Right there."
  const characters = text.split("")
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => i * 0.05),
    character_end_times_seconds: characters.map((_, i) => (i + 1) * 0.05),
  }
})()

// ─────────────────────────────────────────────────────────────────────────────
// § BRAND BOOKEND LENGTH CAP (wave 56)
// ─────────────────────────────────────────────────────────────────────────────
//
// lib/video/composite-attribution.ts's concatIntroOutro stitches a brokerage-
// curated stock intro/outro clip (video_assets, selected upstream) onto the
// avatar/voiceover video with NO length cap — a brokerage that uploaded a
// long corporate sting (8-10s of logo animation before anything real-estate-
// specific plays) had that whole clip prepended/appended to every video, which
// is exactly the "reads as a canned corporate video, not a person" tell the
// owner's realism ruling names. Research (cloudpano.com / lilachbullock.com's
// AI-avatar-video production guides, both cited in this file's header) puts a
// branded bookend at 2-3 seconds before it starts costing watch-through on a
// social-length reel; 2.5s is the midpoint this file already uses for other
// realism numbers (the fade lead, the pad_audio settle). ONE constant (§6) —
// concatIntroOutro trims each bookend segment to this before the concat, the
// main video segment is NEVER trimmed by it.
export const MAX_BRAND_BOOKEND_SECONDS = 2.5

// ─────────────────────────────────────────────────────────────────────────────
// § SPOKEN-DELIVERY SCRIPT REALISM DIRECTIVE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Appended to every script-writing prompt whose output is SPOKEN by a D-ID
 * avatar (never for written-only copy — postcards, emails, landing pages stay
 * on lib/ai/script-standards.ts's SCRIPT_QUALITY_CHARTER, a different concern:
 * that charter governs what is SAID, this governs how it is SAID ALOUD).
 * ADDITIVE at every call site — appended alongside the existing compliance
 * blocks / SCRIPT_QUALITY_CHARTER, never replacing them.
 */
export const SPOKEN_REALISM_DIRECTIVE = [
  "SPOKEN-DELIVERY REALISM (owner ruling, wave 55: the finished video must look and sound like a real person, never like an AI creation) — this script will be SPOKEN ALOUD by an avatar, not read as text:",
  "1. Use contractions throughout (it's, don't, you're, we're, that's, here's) — never their formal spelled-out form.",
  "2. One idea per sentence. Keep sentences short enough to say in a single natural breath — cut subordinate clauses; split anything you would not say in one breath out loud.",
  "3. NEVER refer to yourself as an AI, a language model, or an assistant, and never mention that this video was generated. You are speaking AS the agent, first person, to camera — a real person, not a narrator.",
  "4. No stock phrases a viewer has heard in a hundred other videos: no \"in today's fast-paced market\", no \"hi, i'm [name] from [brokerage], and today i'm going to talk about\", no \"thanks for watching\" or \"don't forget to subscribe\", no formal written-register transitions (\"furthermore\", \"additionally\", \"it is worth noting\", \"in conclusion\").",
  "5. Open with the fact, the number, or their situation — never a self-introduction. Use the person's name and the real property/neighbourhood facts already given to you; specificity is what makes a viewer believe a real person is speaking.",
  "6. Close with ONE natural, specific next step, said the way a person actually talks — not a generic call-to-action template.",
  "7. Read it aloud in your head before finishing: if it would sound stiff coming out of a real person's mouth, rewrite it.",
].join("\n")

// ─────────────────────────────────────────────────────────────────────────────
// § THE AI-TELL SCANNER — the deterministic backstop for what a model ships
//   anyway. Advisory input to a redraft, never a silent block (§5's "advisory
//   passes" ruling, same posture as lib/ai/script-standards.ts lintScriptQuality).
// ─────────────────────────────────────────────────────────────────────────────

const AI_TELL_SELF_REFERENCE_PATTERNS: RegExp[] = [
  /\bas an ai\b/i,
  /\bas a language model\b/i,
  /\bi'?m an ai\b/i,
  /\bi am an ai\b/i,
  /\bas an artificial intelligence\b/i,
  /\bi (?:don'?t|do not) have (?:personal )?feelings\b/i,
  /\bgenerated (?:by|using) ai\b/i,
]

const AI_TELL_ROBOTIC_OPENER_PATTERNS: RegExp[] = [
  // "Hi, I'm Jordan from Century Realty" — the self-intro every researched
  // guide names as the #1 attention-killer AND AI tell. Wave 56: broadened
  // from|with — an AUTHORED template ("Hi, I'm X with Y") is the identical
  // tell, just a different preposition, and was slipping past the original
  // from-only pattern (found auditing lib/video/listing-pitch-reel.ts).
  /^\s*hi[,!]?\s+i'?m\s+[a-z][a-z .'-]{0,40}\b(?:from|with)\b/i,
  // "Hi Sarah, Jordan here with your update" — the SAME self-intro tell in
  // the "X here" register (found auditing lib/kernel/deal-room-reel.ts).
  /^\s*hi\b[^.!?]{0,30},\s+[a-z][a-z'-]*\s+here\b/i,
  /^\s*hey (?:guys|everyone|there)[,!]/i,
  /^\s*welcome (?:back )?to (?:my|this) (?:channel|video)/i,
]

const AI_TELL_FORMAL_TRANSITION_PATTERNS: RegExp[] = [
  /\bfurthermore\b/i,
  /\badditionally\b/i,
  /\bmoreover\b/i,
  /\bit is worth noting\b/i,
  /\bin conclusion\b/i,
  /\bin today'?s fast-paced market\b/i,
]

const AI_TELL_ROBOTIC_SIGNOFF_PATTERNS: RegExp[] = [
  /\bthanks for watching\b/i,
  /\bplease like and subscribe\b/i,
  /\bdon'?t forget to subscribe\b/i,
]

/** Formal → contraction pairs. Each PATTERN matches the UNCONTRACTED form;
 *  three or more distinct hits in one script is the "reads as stiff" signal —
 *  a single "do not" is normal spoken emphasis, not a tell. */
const UNCONTRACTED_PATTERNS: RegExp[] = [
  /\bdo not\b/i, /\bcannot\b/i, /\bwill not\b/i, /\bdid not\b/i, /\bis not\b/i,
  /\bare not\b/i, /\bwould not\b/i, /\bcould not\b/i, /\bshould not\b/i,
  /\bi am\b/i, /\byou are\b/i, /\bit is\b/i, /\bwe are\b/i, /\bthey are\b/i,
]

/** A sentence this long, spoken aloud by TTS, is the "monotone wall of text"
 *  tell even when the underlying voice model is good — see the header
 *  research note. Reuses spokenWords (§6 — one word-splitter for the video
 *  lane) rather than a second regex split. */
const MAX_NATURAL_SENTENCE_WORDS = 28

/**
 * Split into sentences for the length check. Deliberately NOT importing
 * script-structure.ts's `spokenSentences` — that splitter is the load-bearing
 * boundary fitNarrationToBudget TRIMS at (its own header: "a second splitter
 * would inspect different sentences than the trim actually produced"), and
 * this scanner runs BEFORE the budget trim, on the model's raw draft. Reusing
 * it here would be borrowing a contract this function does not need and does
 * not want to be coupled to. This local split only needs "roughly one
 * sentence," which terminal-punctuation splitting gives without importing
 * the trim boundary.
 */
function roughSentences(text: string): string[] {
  return text.trim().split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0)
}

/**
 * Scan a spoken-delivery script for the tells that make a viewer think "this
 * was made with AI." PURE — no I/O, no model call. Returns human-readable
 * findings, empty when clean.
 *
 * ADVISORY BY DESIGN, same posture as lib/ai/script-standards.ts's
 * lintScriptQuality: a caller may feed these findings back into ONE redraft
 * (the pattern every video-script generator already uses for compliance —
 * see intro-video-reactor.ts / listing-promo-reactor.ts's `gate` functions,
 * which now fold this scan's findings into the SAME one-redraft loop rather
 * than adding a second retry mechanism, §6) or simply surface them.
 */
export function scanForAiTells(script: string | null | undefined): string[] {
  const text = (script ?? "").trim()
  if (!text) return []
  const hits: string[] = []

  if (AI_TELL_SELF_REFERENCE_PATTERNS.some((p) => p.test(text))) {
    hits.push(
      "AI-tell: the script refers to itself as an AI / language model / assistant, or names itself as generated — " +
      "the avatar must speak as the agent, in first person, never acknowledging it is AI-made.",
    )
  }
  if (AI_TELL_ROBOTIC_OPENER_PATTERNS.some((p) => p.test(text))) {
    hits.push(
      "AI-tell: opens with a generic self-introduction (\"hi, i'm ... from ...\") instead of a hook — " +
      "lead with a fact, a number, or the viewer's situation.",
    )
  }
  if (AI_TELL_FORMAL_TRANSITION_PATTERNS.some((p) => p.test(text))) {
    hits.push(
      "AI-tell: a formal written-register transition (\"furthermore\", \"additionally\", \"it is worth noting\") — " +
      "nobody says this out loud; use \"but\", \"so\", or \"here's the thing\" instead.",
    )
  }
  if (AI_TELL_ROBOTIC_SIGNOFF_PATTERNS.some((p) => p.test(text))) {
    hits.push(
      "AI-tell: a canned video sign-off (\"thanks for watching\", \"subscribe\") — " +
      "close with a specific next step said the way a person actually talks.",
    )
  }
  const uncontractedCount = UNCONTRACTED_PATTERNS.filter((p) => p.test(text)).length
  if (uncontractedCount >= 3) {
    hits.push(
      `AI-tell: ${uncontractedCount} uncontracted phrases ("do not", "it is", "you are", …) — ` +
      "spoken delivery this formal reads as stiff; use contractions throughout.",
    )
  }
  const longSentence = roughSentences(text).find((s) => spokenWords(s).length > MAX_NATURAL_SENTENCE_WORDS)
  if (longSentence) {
    hits.push(
      `AI-tell: a ${spokenWords(longSentence).length}-word sentence — TTS delivery of a sentence this long reads ` +
      "as a monotone wall of text; keep one idea per sentence.",
    )
  }

  return hits
}

/**
 * POSITIVE CONTROLS (§2 — "every absence assertion needs a positive control").
 * Each fixture is built from a real, researched AI-tell and MUST produce at
 * least one finding from scanForAiTells. The avatar-pipeline-hardening
 * simulator asserts this so a broken regex reporting "0 tells" everywhere
 * cannot pass as a clean bill of health.
 */
export const AI_TELL_POSITIVE_CONTROLS: ReadonlyArray<{ label: string; text: string }> = [
  {
    label: "self_reference",
    text: "As an AI, I'm here to help you find your dream home in this wonderful neighborhood.",
  },
  {
    label: "robotic_opener",
    text: "Hi, I'm Jordan Ellis from Century Realty Group, and today I'm going to talk about the local market.",
  },
  {
    // Wave 56 — the "with" preposition variant this file's own header note
    // documents finding in an AUTHORED (not model-drafted) template.
    label: "robotic_opener_with",
    text: "Hi, I'm Jordan Ellis with Century Realty Group. Here's what listing your home with us looks like.",
  },
  {
    // Wave 56 — the "X here" register variant found in the deal-room reel's
    // authored opener.
    label: "robotic_opener_here",
    text: "Hi Sarah, Jordan here with your weekly update on 214 Maple.",
  },
  {
    label: "formal_transition",
    text: "Furthermore, it is worth noting that inventory remains low across the county this quarter.",
  },
  {
    label: "robotic_signoff",
    text: "That's the update for this week. Thanks for watching, and don't forget to subscribe for more.",
  },
  {
    label: "uncontracted",
    text: "I am not sure you will not regret it. We are certain it is not going to last. They are ready when you are.",
  },
  {
    label: "long_sentence",
    text: "This home, which sits on a quiet street near the elementary school and the new coffee shop that just opened last spring, has been completely renovated from top to bottom including the roof, the plumbing, and the electrical system, and it is priced to sell quickly this week.",
  },
]

/**
 * NEGATIVE CONTROL — a script written the way the directive above asks for.
 * MUST produce zero findings. Proves the scanner does not simply flag every
 * script (the other half of a positive control's proof — a detector that
 * fires on everything is exactly as useless as one that fires on nothing).
 */
export const AI_TELL_NEGATIVE_CONTROL =
  "Three days on market, two offers already. Here's what buyers are responding to at 214 Maple. " +
  "The kitchen's been redone — quartz counters, new appliances, opens right onto the deck. " +
  "If you want a private showing before the weekend, just text me back."

/**
 * FIVE MORE NEGATIVE CONTROLS (wave 56 capability check, owner ruling
 * "check to make sure all capabilities are working properly"). One negative
 * control alone can't rule out a scanner that only happens to pass its own
 * single fixture — these cover five different spoken-delivery shapes
 * (open-house recap, price-change update, portal welcome, market/neighborhood
 * update, anniversary check-in) so a scanner that overfits one script's
 * phrasing shows up as a false positive on at least one of the other four.
 * Every entry is written to the SPOKEN_REALISM_DIRECTIVE rules above
 * (contractions throughout, short one-idea sentences, no self-intro, no
 * formal transitions, no canned sign-off) and MUST produce zero findings —
 * asserted in scripts/avatar-pipeline-hardening-simulator.ts alongside the
 * single AI_TELL_NEGATIVE_CONTROL above.
 */
export const AI_TELL_ADDITIONAL_NEGATIVE_CONTROLS: ReadonlyArray<{ label: string; text: string }> = [
  {
    label: "open_house_recap",
    text: "We had forty people through the open house Saturday. Three showings are already booked for this week. " +
      "If you're thinking about listing before spring, now's the time to talk.",
  },
  {
    label: "price_change_update",
    text: "Good news on Maple Street — we just dropped the price by ten thousand. It's priced right for today's buyers. " +
      "Let's get you in this weekend before it's gone.",
  },
  {
    label: "portal_welcome",
    text: "Welcome to your new portal, Sarah. I've already loaded five homes that match what you're looking for. " +
      "Take a look and let me know which ones catch your eye.",
  },
  {
    label: "neighborhood_market_update",
    text: "Three homes sold on Birchwood last month, all above asking. That tells you where this market's heading. " +
      "Want me to run the numbers on your place?",
  },
  {
    label: "anniversary_checkin",
    text: "Happy one year in your home! I hope the kitchen's still your favorite spot. " +
      "If you ever need anything, you know where to find me.",
  },
]

// The avatar-track hold/freeze guard (avatarFadeOutFrame) lives in
// lib/video/script-structure.ts, beside avatarDurationOverrunSeconds — its
// direct sibling in the same wave-53 measurement family — and is re-exported
// above so every realism concern still has ONE front door.

// ─────────────────────────────────────────────────────────────────────────────
// § THE WINDOWED PIP FREEZE GUARD (wave 56)
// ─────────────────────────────────────────────────────────────────────────────
//
// avatarFadeOutFrame assumes the avatar <Video> plays its source from frame 0
// (AgentTalkingHeadReel: `trimBefore={0} trimAfter={BODY}`, one window, one
// clip). remotion/components/AvatarPIP.tsx is a DIFFERENT shape: EquityReportReel,
// MarketUpdateReel, and (after this wave) AgentExplainerReel each cut THREE
// separate Sequence windows into ONE continuous D-ID clip, passing ABSOLUTE
// `trimBefore={startFrame} trimAfter={endFrame}` per window (COVER, COVER+STAT,
// COVER+STAT*2, …). A clip that measures shorter than the composition's fixed
// geometry does not just freeze its OWN last frame once — every LATER window
// whose startFrame is already past the clip's real end asks `<Video>` to play a
// slice that does not exist at all, which is the same freeze risk multiplied by
// the window count.
//
// avatarPipWindowFade adapts avatarFadeOutFrame to this windowed shape instead
// of re-deriving the arithmetic (§6): the real seconds of source LEFT once this
// window's own startFrame is subtracted out is exactly the "local actual
// duration" avatarFadeOutFrame already knows how to fade against. A window that
// starts entirely past the clip's measured end (`hasRealContent: false`) gets no
// fade frame at all — there is nothing to fade FROM — so the caller must skip
// the <Video> for that window and fall back to the photo/monogram rather than
// hold whatever frame a naive trimAfter would freeze on.

export interface AvatarPipWindowFade {
  /** false when this window's slice starts AFTER the measured avatar clip
   *  ended — there is NO real video content in this window at all. The caller
   *  must render the photo/monogram fallback instead of the <Video>, or it
   *  freezes on the clip's own last rendered frame for the whole window. */
  hasRealContent: boolean
  /** Local frame (0-based, relative to THIS window's own Sequence — the same
   *  frame space useCurrentFrame() reads inside a <Sequence>) at which the
   *  avatar should start fading out. Null when the window is fully covered by
   *  real content (no fade needed) OR when there is no measurement at all
   *  (additive/opt-in — an older render row with no avatarDurationSeconds
   *  renders EXACTLY as before, full opacity throughout). */
  fadeFrame: number | null
}

/**
 * The per-window fade/skip decision for one AvatarPIP Sequence slice of a
 * SINGLE continuous avatar clip. PURE — no I/O, safe for a simulator.
 *
 * `avatarDurationSeconds` is the MEASURED D-ID duration for the WHOLE clip
 * (ai_video_projects.duration_seconds, threaded by
 * lib/video/avatar-render-orchestrator.ts into every composition's input_props
 * — not composition-specific, so this reads the same number
 * AgentTalkingHeadReel's single-window fade already reads).
 * `startFrame`/`endFrame` are this window's ABSOLUTE frame offsets into that
 * same clip (what the caller already passes to `<Video trimBefore trimAfter>`).
 */
export function avatarPipWindowFade(
  avatarDurationSeconds: number | null | undefined,
  startFrame: number,
  endFrame: number,
  fps: number,
  fadeFrames = 12,
): AvatarPipWindowFade {
  // No measurement at all ⇒ render exactly as before this wave: full opacity,
  // every window, for the whole window. Never treat "unmeasured" as "empty".
  if (typeof avatarDurationSeconds !== "number" || !Number.isFinite(avatarDurationSeconds)) {
    return { hasRealContent: true, fadeFrame: null }
  }
  if (!Number.isFinite(startFrame) || !Number.isFinite(endFrame) || !Number.isFinite(fps) || fps <= 0) {
    return { hasRealContent: true, fadeFrame: null }
  }
  const windowFrames = endFrame - startFrame
  if (windowFrames <= 0) return { hasRealContent: true, fadeFrame: null }

  // Seconds of REAL clip left once this window's own start is subtracted —
  // the "local actual duration" avatarFadeOutFrame's contract already expects.
  const localActualSeconds = avatarDurationSeconds - startFrame / fps
  if (localActualSeconds <= 0) return { hasRealContent: false, fadeFrame: null }

  return {
    hasRealContent: true,
    fadeFrame: avatarFadeOutFrame(localActualSeconds, windowFrames, fps, fadeFrames),
  }
}

// ═════════════════════════════════════════════════════════════════════════
// § NON-AVATAR VIDEO REALISM (wave 57)
// ═════════════════════════════════════════════════════════════════════════
//
// OWNER RULING (wave 57, 2026-09-11), verbatim: "the video product the os
// creates needs to look and appear real and not a fake ai creation... this
// includes ai created videos." Everything above this line is the AVATAR
// track (D-ID + ElevenLabs). This section is the rest of every automated
// video — b-roll/imagery, the music bed, captions, and intro/outro/branding —
// which the ruling names explicitly as in scope, not only the talking head.
//
// SKILLS CONSULTED (named per LANE_RULES): plugins/ecc/skills/fal-ai-media
// (image/video generation model catalogue — Nano Banana / Seedance / Kling /
// Veo3 parameter shapes), plugins/ecc/skills/video-editing (the "edit real
// footage, generate only what doesn't exist" thesis this section's real-
// media-first ruling below restates for this repo), plugins/ecc/skills/
// videodb (server-side timeline/caption/reframe primitives — this repo's own
// ffmpeg-based mixer/caption stack already covers the same ground, so no new
// dependency), plugins/ecc/skills/motion-foundations + motion-patterns
// (motion/react UI-animation rules — informed the "no CSS transitions inside
// a Remotion composition" cross-check against CaptionLayer.tsx, which already
// drives every pop/fade off useCurrentFrame()+interpolate as required),
// .claude/skills/remotion-best-practices (router) → remotion-captions/
// REFERENCE.md + display-captions.md (word-timed cues, safe-area, no CSS
// transitions — cross-checked against lib/video/caption-plan.ts +
// remotion/components/CaptionLayer.tsx below).
//
// RESEARCH (Exa web search, 2026-09-11, 2 queries — b-roll/AI-image realism
// and music/ducking levels):
//
//  B-ROLL / AI-GENERATED IMAGERY — versely.studio "Matching generated footage
//  to real camera footage" (2026-08-20), dev.to "How to Generate B-Roll with
//  AI for Existing Videos" (2026-04-30), kompozy.io "AI B-roll generation in
//  2026" (2026-05-06), hailuoai.video "Director Mode for Precise AI B-Roll
//  Control" (2026-07-27):
//    · REAL PHOTOS/VIDEO FIRST. "A 100%-generative channel reads uncanny...
//      the model's tells compound shot over shot"; the recommended mix is
//      ~70% real/stock footage as the visual baseline and generative only for
//      the minority of shots with no real coverage. For THIS repo that maps
//      exactly onto the existing cascade: a listing's own photos/video
//      (listing_media, photo-intelligence hero picks) and the brokerage's
//      uploaded b_roll stock (lib/video/broll-picker.ts's video_assets
//      cascade) are REAL media and must be preferred; lib/ai/image-generation.ts
//      scenes are the fallback for the minority of cases with no real
//      coverage, never the default source when real media exists.
//    · THE #1 TELL IS MISMATCHED LIGHTING/COLOR TEMPERATURE, fixed in the
//      PROMPT, not in post. "Ignoring color temperature [is] the single
//      biggest tell of AI B-roll... Fix in the prompt, not in post."
//    · NO TEXT IN THE IMAGE — a generative model routinely mangles in-image
//      text (the "melted words" tell); this repo's image-generation.ts
//      already forbids it ("No text or watermarks in the image"), confirmed
//      correct by this research, not changed.
//    · CAMERA MOTION, when a generated scene has any: short clips (3-6s), ONE
//      dominant move axis, modest angular change (10-25°) and modest zoom
//      (5-15%) — "over-animating the camera... [is a] common cause of AI
//      b-roll feeling synthetic." (This repo's image-based b-roll — SafeImg/
//      Ken Burns — is a STILL photo with a code-driven pan/zoom, not a
//      generated moving clip, so the camera-motion research applies to
//      Ken Burns bounds below, not to a video model's own internal motion.)
//    · GRAIN/VIGNETTE. "Real footage has a noise floor... generated footage
//      arrives clean — often unnaturally clean." A LIGHT grain + vignette is
//      what real footage carries by default and flat-clean generated stills
//      do not; see FILM_GRAIN_OVERLAY_OPACITY / VIGNETTE_OVERLAY below.
//
//  MUSIC / DUCKING — zellahq.com "Audio Ducking: How to Lower Music Under a
//  Voiceover" (2026-07-19), versely.studio "Ducking Music Under a Voiceover"
//  (2026-08-19), pixflow.net "How to Mix Dialogue, Music & Sound Effects in
//  Premiere Pro" (2026-06-02), playbooks.com audio-mixing-patterns skill
//  (2026-01-26):
//    · Every source converges on MUSIC 18-25 dB BELOW THE VOICE while speech
//      plays — "roughly -18 to -25 dB below the voice, present but never
//      competing" — squarely inside the task's own framing ("music bed
//      levels -18 to -22 LUFS under speech"). This repo's mixer
//      (lib/remotion/music-mixer.ts) is a CONSTANT `volume=` scale, not a
//      real-time sidechain, so the number that matters is the LINEAR ffmpeg
//      multiplier: -20 dB ≈ 0.10 linear (10^(-20/20)). The render-coordinator's
//      prior fallback (`music_volume_pct ?? 20`, i.e. 20% ≈ -14 dB) sat
//      OUTSIDE every researched range — louder relative to the voice than any
//      source recommends, exactly the "I can hear the music while the person
//      talks" failure the research names as the tell. MUSIC_DUCK_VOLUME_PCT
//      below corrects the FALLBACK (a brokerage's own stock music_asset row
//      that already sets `music_volume_pct` is untouched — this is the
//      code-side default for rows that never set one).
//    · Fade lengths ALREADY in this repo (DEFAULT_MUSIC_FADE_IN_SECONDS=1.2 /
//      DEFAULT_MUSIC_FADE_OUT_SECONDS=1.5, lib/remotion/music-filter-graph.ts)
//      sit inside every researched range ("a couple of seconds", "an outro
//      fade over the last second or two") — AUDITED, not changed.
//    · GAP CLOSED (wave 58, ffmpeg-cookbook.com "Automatically Duck BGM Under
//      Narration with sidechaincompress" 2026-04-11, ayosec.github.io ffmpeg
//      9.0 sidechaincompress filter reference, capcut.com "Audio Ducking for
//      Clear Voiceover" 2026-08-11, infinitecreation.io "Ducking Music Under
//      Dialogue", all fetched 2026-09-11): the wave-57 audit above recorded
//      "this repo's mixer applies one constant level for the whole track
//      rather than a sidechain... attack/release has no analog here" as an
//      unresolved gap. `buildMusicDuckFilterGraph` (lib/remotion/
//      music-filter-graph.ts) closes it — a real `sidechaincompress` stage
//      keyed off the narration track, not a second constant. Researched
//      ranges converge tightly around ffmpeg's OWN filter defaults: threshold
//      -20..-30dB (podcast/video sources), ratio 4-8:1, attack 10-80ms (one
//      source's "5ms" outlier is for near-instant dialogue-detect, not music
//      ducking), release 200-700ms — MUSIC_SIDECHAIN_DUCK_SETTINGS below picks
//      the conservative middle of that convergence (threshold -30dB, ratio 8,
//      attack 20ms, release 250ms — the last two ARE literally
//      sidechaincompress's own ffmpeg defaults). The pre-gain "bed" level is
//      UNCHANGED — same musicVolumePct a caller already resolved (brokerage's
//      own row, or MUSIC_DUCK_VOLUME_PCT) — sidechaining only makes that bed
//      dip further while speech plays and RETURN to it in the gaps, instead of
//      sitting at one flat scale for the whole track.
//
// CAPTIONS — cross-checked against lib/video/caption-plan.ts + remotion/
// components/CaptionLayer.tsx (already built, wave-prior): word-timed cues
// from REAL ElevenLabs alignment when available (buildCaptionPlan Path A),
// ≤4 words/cue by default (maxWordsPerCue default 4, matches the research
// brief's "≤4 words/cue"), a lower-third safe-area band (bottomPercent
// default 78) with a high-contrast stroke so text survives over any frame
// muted, and per-cue pop/fade driven by interpolate(useCurrentFrame()) — NO
// CSS transitions, per remotion-best-practices. AUDITED CORRECT. The one gap
// this wave found and fixed is NOT the cue shape, it is TIMING: every reel
// mounting `<CaptionLayer>` mounted it once over the WHOLE timeline, so a cue
// could still be on screen when the composition's own branding/CTA tile
// (brokerage name, EHO mark, QR code) started — captions drawing over a
// video's own compliance mark. `clipCaptionCuesBeforeFrame` (lib/video/
// caption-plan.ts) + `CaptionLayer`'s new `hiddenFromFrame` prop close this;
// wired into the 10 compositions that mount a root-level CaptionLayer
// alongside a branding/CTA tail (MarketUpdateReel, AgentExplainerReel,
// ExplainerAnimReel, JustListedReel, JustListedReelSquare, JustSoldReelSquare,
// NeighborhoodSpotlightReel, PartnersMeetingReel, PhotoWalkthroughReel,
// TeammateExplainerReel).
//
// SCRIPT AUDIO TAGS → CAPTIONS. Coordinating with lane PA's
// `withNaturalPauses` (spoken-delivery pause markup): that helper does not
// exist in this checkout yet (not yet merged), so nothing here can read its
// tag syntax. Per LANE_RULES this lane assumes captions are built from the
// UNTAGGED script — buildCaptionPlan's even-distribution fallback (Path B)
// and every producer's `captionScript` prop already pass the plain narration
// string (grep across remotion/*.tsx: captionScript is always the same value
// as the voiceover script, never a tagged variant), so no audio-pause tag
// currently reaches a caption cue. UNRESOLVED, named rather than guessed:
// once `withNaturalPauses` lands, whatever module emits the TAGGED script for
// TTS must hand `buildCaptionPlan`/`captionScript` the UNTAGGED string — a
// contract this file cannot enforce from here because the tagged producer
// does not exist yet to enforce it against.

/** THE MUSIC DUCK LEVEL — the code-side FALLBACK for a music-eligible
 *  `video_assets` row with no `music_volume_pct` of its own
 *  (lib/remotion/render-coordinator.ts, lib/remotion/render-cache.ts:
 *  `musicRow.music_volume_pct ?? MUSIC_DUCK_VOLUME_PCT`). 12% linear ≈
 *  -18.4 dB below the (unscaled) voice channel — inside BOTH the research's
 *  -18..-25 dB range and the task's own -18..-22 LUFS framing. Replaces the
 *  prior fallback of 20 (≈ -14 dB — outside every researched range, louder
 *  than any source recommends). A brokerage's own stock row that already sets
 *  `music_volume_pct` is UNCHANGED by this — it is a fallback, not a cap. */
export const MUSIC_DUCK_VOLUME_PCT = 12

/** THE SIDECHAIN DUCK TUNING (wave 58 — see the MUSIC/DUCKING research note
 *  above for sourcing). Drives `buildMusicDuckFilterGraph`'s `sidechaincompress`
 *  stage, keyed off the narration track — used whenever the render-coordinator
 *  knows [0:a] carries narration this render (the sidechain path); when it does
 *  not, MUSIC_DUCK_VOLUME_PCT's flat constant level above is the fallback, not
 *  this. `attackMs`/`releaseMs` ARE sidechaincompress's own ffmpeg defaults
 *  (20/250) — the research converges on the same numbers as the filter's
 *  out-of-the-box behaviour, so nothing here fights the tool's own defaults.
 *  `thresholdDb`/`ratio` are picked at the conservative-but-audible end of the
 *  researched range (-20..-30dB threshold, 4-8:1 ratio) so quiet room-tone or a
 *  breath does not falsely trigger a duck, while normalized narration speech
 *  (~-14 LUFS, per ELEVENLABS_REALISM_VOICE_SETTINGS' companion research)
 *  reliably crosses it. `makeupDb: 0` — no post-compression gain restore, so a
 *  ducked-then-boosted track cannot end up reading louder than the bed level
 *  the caller chose. */
export interface SidechainDuckTuning {
  thresholdDb: number
  ratio: number
  attackMs: number
  releaseMs: number
  makeupDb: number
}
export const MUSIC_SIDECHAIN_DUCK_SETTINGS: SidechainDuckTuning = {
  thresholdDb: -30,
  ratio: 8,
  attackMs: 20,
  releaseMs: 250,
  makeupDb: 0,
}

/** Additive realism directive appended to every AI-image-generation prompt
 *  (lib/ai/image-generation.ts buildBrandAwarePrompt) — the "no text in
 *  image, natural lighting, photographic, no AI artefacts" block named by
 *  this wave's task. ONE spelling (§6): every ImagePurpose already funnels
 *  through buildBrandAwarePrompt's shared "Constraints:" line, so this reads
 *  once here rather than being pasted per purpose. */
export const IMAGE_SCENE_REALISM_PROMPT_BLOCK =
  "Photographic realism: shot on a real camera, natural unstaged lighting matching the time of day implied by the " +
  "prompt, true-to-life color (avoid an artificially saturated or over-'cinematic' grade), no illustration/render/" +
  "3D-CGI look unless explicitly requested, no legible text or lettering anywhere in the image, no distorted hands, " +
  "faces, or architecture, no warped or duplicated objects, no impossible geometry or physics."

/** AI-IMAGE-TELL CHECKLIST — the questions a human (or a future vision-model
 *  reviewer) asks of a generated scene before it ships in a video, the image
 *  counterpart of `scanForAiTells` above. NOT a pixel-level scanner: unlike a
 *  spoken script, a generated image's defects (warped hands, mismatched
 *  lighting, melted text) are not reliably regex-detectable from the prompt
 *  or the file bytes alone without a vision model this repo does not call
 *  here. Documented as a checklist — surfaced to a human reviewer / QA pass —
 *  rather than faked as an automated "0 tells found" that cannot see what it
 *  claims to have checked (§2 — a guard that cannot see the code/image it
 *  judges is worse than no guard). */
export const AI_IMAGE_TELL_CHECKLIST: readonly string[] = [
  "Does any text in the image look melted, duplicated, or nonsensical? (The #1 giveaway — real photos rarely have baked-in text at all.)",
  "Do the light direction and color temperature match the rest of the video's shots? (The #1 AI-image tell per the research above.)",
  "Do hands, fingers, faces, or architectural lines look warped, duplicated, or physically impossible?",
  "Does the image look unnaturally clean/flat compared to a real photo (no grain, no sensor noise, glassy-smooth surfaces)?",
  "Is the composition suspiciously symmetric or 'perfect' in a way a real photograph rarely is?",
  "Does anything violate real-world physics (impossible shadows, reflections that don't match, floating objects)?",
  "Would a viewer who knows this property recognize it as NOT the actual listing? (A generated scene must never be presented as if it were the real property.)",
]

/** Subtle film-grain overlay opacity for a photo/video B-roll layer — the
 *  research's "real footage has a noise floor; generated/flat stills do not"
 *  finding. Deliberately low: this is meant to read as "shot on a real
 *  camera," not as a visible texture effect. Composition-optional (only
 *  compositions that already render a plain overlay layer over B-roll —
 *  `remotion/_BrollLayer.tsx`'s `ClipFrame` — can add this cheaply, as a CSS
 *  `background` on the existing `AbsoluteFill`; no new dependency, no extra
 *  render pass). */
export const FILM_GRAIN_OVERLAY_OPACITY = 0.05

/** A cheap CSS-only film-grain texture — a tiled SVG `feTurbulence` noise
 *  filter as a `background-image` data URI. No asset fetch, no extra render
 *  pass; works anywhere a `<div>`'s `background` can be set (Chromium, which
 *  is what Remotion renders through). Paired with `FILM_GRAIN_OVERLAY_OPACITY`
 *  on the element's opacity, not baked into the filter itself, so a caller can
 *  dial it down for a bright daytime scene without re-deriving the SVG. */
export const FILM_GRAIN_BACKGROUND_IMAGE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E" +
  "%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E" +
  "%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

/** Vignette overlay — a soft radial darkening toward the frame edges, the
 *  other half of the "reads as shot on a real camera" pair with film grain.
 *  A `radial-gradient` string, ready for a `background` CSS property; no
 *  asset, no extra render pass. Subtle by design (alpha caps at 0.35) — this
 *  is meant to be felt, not seen. */
export const VIGNETTE_BACKGROUND_IMAGE =
  "radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,0.35) 100%)"

/**
 * KEN BURNS ZOOM/PAN BOUNDS — AUDITED, NOT CHANGED. lib/video/ken-burns-plan.ts
 * already caps scale to [1.0, 1.12] (a maximum 12% push over a clip's dwell,
 * `maxZoom` clamped to <= 0.12) and pan offsets to +/-3% of frame width/height
 * (`PAN_MOVES`). Cross-checked against this wave's research (b-roll camera-move
 * guides recommend 5-20% zoom / 10-25° angular pan over 3-6s moves for a
 * GENERATED moving clip): a real-estate Ken Burns pan over a STILL photo is a
 * gentler cousin of that same "modest, single-axis, no over-animation" rule,
 * and 12% zoom / 3% pan already sits at the conservative end of even the
 * generated-video range. No change made — recorded here so a future audit
 * does not re-open a bound that already matches the research. */
export const KEN_BURNS_REALISM_AUDIT_NOTE =
  "lib/video/ken-burns-plan.ts scale<=1.12 (12% max zoom), pan<=3% of frame — already inside every researched " +
  "range for a subtle, non-fake-reading push/pan. AUDITED 2026-09-11, unchanged."

/**
 * THE 3-SECOND COVER/CTA CONTENT-BEAT RULING (wave 57 task item 4). The
 * COVER and CTA/outro tiles most reels open/close on (COVER=2-3s, CTA/OUTRO=
 * 2-3s across MarketUpdateReel, AgentExplainerReel, ExplainerAnimReel,
 * JustSoldReelSquare, JustListedReelSquare, TeammateExplainerReel,
 * NeighborhoodSpotlightReel) are NOT the "canned corporate sting" the realism
 * ruling targets — that concern is `MAX_BRAND_BOOKEND_SECONDS` above, which
 * caps a BROKERAGE-UPLOADED STOCK CLIP (a pre-recorded intro/outro video
 * concatenated onto the render) at 2.5s so a long corporate logo animation
 * cannot precede/follow every video. The COVER/CTA tiles are a different
 * thing entirely: they are CONTENT the composition itself renders — the
 * area/price/headline text, the agent's name and phone, the QR code, the
 * compliance mark — not stock footage standing in for a person. A viewer
 * reading "$625K · 3bd · 2ba" or a QR code for 2-3 seconds is reading
 * information, not watching a canned intro; shortening it would cut the one
 * moment in the reel a muted viewer can actually read the facts. LEFT AS IS
 * — documented per LANE_RULES rather than re-timed. */
export const COVER_CTA_CONTENT_BEAT_RULING =
  "COVER/CTA tiles (2-3s) are CONTENT (price/address/agent/QR/compliance text), not a stock bookend — " +
  "MAX_BRAND_BOOKEND_SECONDS already caps the separate concern (a brokerage-uploaded stock intro/outro clip). Left as is."
