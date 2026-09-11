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

import { spokenWords, avatarFadeOutFrame } from "./script-structure"
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
