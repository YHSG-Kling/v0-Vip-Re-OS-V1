/**
 * lib/video/script-structure.ts
 *
 * Pure, deterministic helpers for AI video-script generation. Extracted from the
 * "use server" action app/actions/video/generate-script.ts so they can be unit-tested
 * without an LLM call, a DB, or any session context.
 *
 * A "use server" file may only export async functions, so these constants/pure
 * functions live here and are imported by the action.
 */

/** Canonical video types the script generator supports. */
export type VideoScriptType =
  | "property_tour"
  | "market_update"
  | "agent_intro"
  | "listing_presentation"
  | "buyer_education"
  | "seller_update"
  | "testimonial"
  | "tips"
  | "custom"

/** Delivery tones the script generator supports. */
export type VideoScriptTone = "professional" | "friendly" | "luxury" | "educational"

/** Input shape for the generateVideoScript server action. */
export interface GenerateVideoScriptParams {
  brokerageId: string
  agentId: string
  userId: string
  /** What the video is about — free-text brief from the user */
  description: string
  /** Canonical video type */
  videoType: VideoScriptType
  /** Delivery tone */
  tone: VideoScriptTone
  /** Target duration in seconds — controls word-count target */
  targetDurationSeconds?: number
  /** Optional listing context pre-fill */
  listingContext?: {
    address: string
    city: string
    state: string
    listPrice: number
    bedrooms?: number
    bathrooms?: number
    sqft?: number
    features?: string[]
  }
  /** Optional brand voice tone from ai_identity_profiles */
  brandVoiceTone?: string
  saveToLibrary?: boolean
}

/** Result shape returned by the generateVideoScript server action. */
export interface GenerateVideoScriptResult {
  success: boolean
  script?: string
  wordCount?: number
  estimatedDurationSeconds?: number
  savedScriptId?: string
  error?: string
  complianceBlocked?: boolean
  /** Advisory compliance notes from post-generation check — not a hard block */
  complianceWarnings?: string[]
}

/** Average speaking pace used to convert between duration and word count. */
export const WORDS_PER_MINUTE = 150

/** Tone → system-prompt directive. */
export const TONE_INSTRUCTIONS: Record<VideoScriptTone, string> = {
  professional: "Use a polished, authoritative tone. Speak with confidence and expertise. Avoid slang.",
  friendly:
    "Use a warm, conversational tone. Speak as if talking to a friend. Be approachable and genuine.",
  luxury:
    "Use elevated, aspirational language. Evoke exclusivity and lifestyle. Focus on the experience, not just facts.",
  educational:
    "Use a clear, informative tone. Explain concepts simply. Use structure (numbered points where helpful).",
}

/**
 * Map a video type to the synthetic broadcast contact_type. This determines the
 * audience/journey context the compliance gate evaluates the script against.
 * Seller-facing content → "seller"; everything else defaults to "buyer".
 */
export function videoTypeToContactType(videoType: VideoScriptType): "buyer" | "seller" {
  switch (videoType) {
    case "seller_update":
    case "listing_presentation":
      return "seller"
    default:
      return "buyer"
  }
}

/**
 * Target word count for a given spoken duration, at WORDS_PER_MINUTE pace.
 * 150 words ≈ 60 seconds (2.5 words/second).
 */
export function targetWordCount(durationSeconds: number): number {
  return Math.round((durationSeconds / 60) * WORDS_PER_MINUTE)
}

/**
 * Estimate spoken duration (seconds) for a written word count, at WORDS_PER_MINUTE pace.
 * Inverse of targetWordCount.
 */
export function estimateDurationSeconds(wordCount: number): number {
  return Math.round((wordCount / WORDS_PER_MINUTE) * 60)
}

// ═══════════════════════════════════════════════════════════════════════════
// CAPPING A SCRIPT TO THE COMPOSITION THAT WILL SPEAK IT
// ═══════════════════════════════════════════════════════════════════════════
//
// THE DEFECT THIS CLOSES. There are TWO narration keys in a render's
// input_props and only one of them is protected:
//
//   · `voiceover_url` (snake) is muxed by ffmpeg AFTER the render, and m313's
//     tpad HOLDS THE FINAL FRAME for any overrun — the sentence finishes.
//     (lib/remotion/voiceover-mixer.ts paddingSecondsFor.)
//   · `voiceoverUrl` (camel) is an <Audio> INSIDE the composition, baked into a
//     FIXED durationInFrames. Nothing pads it. THE OVERRUN IS CUT — the agent
//     is silenced mid-word in a video already sent to a client.
//
// The distinction is deliberate (lib/remotion/composition-cache.ts:55 separates
// them), so the fix cannot be "pad the camel key too". It is to size the SCRIPT
// to the composition BEFORE it is written and to refuse to let an overrun pass
// unseen — which is what these three functions do.
//
// They live HERE, beside WORDS_PER_MINUTE / targetWordCount, rather than in a
// new module: a second words-per-minute constant or a second duration
// computation is the §6 defect. The composition half of the arithmetic is
// lib/remotion/composition-geometry.ts compositionSeconds().

/**
 * Fraction of a composition's runtime left UNCLAIMED by the script.
 *
 * WHY THERE IS ANY. WORDS_PER_MINUTE is an AVERAGE, not a bound. A script sized
 * to exactly 150 wpm overruns whenever the read is faster than average, which
 * for an energetic listing promo is most of the time; ElevenLabs also brackets
 * a clip with a little lead-in and tail silence, and both land inside the same
 * fixed frame count. At 0.20 the script may claim 80% of the runtime, so the
 * narration still fits at up to 150 / 0.8 = 187.5 wpm — a read 25% faster than
 * average. Slower reads simply end early against the composition's outro, which
 * is the harmless direction.
 */
export const NARRATION_HEADROOM = 0.20

/** What one composition's geometry permits a narration script to be. */
export interface NarrationBudget {
  compositionId: string
  /** duration_frames / fps — the composition's real runtime. */
  compositionSeconds: number
  /** Seconds the script may claim, after headroom. */
  budgetSeconds: number
  /** Word ceiling at WORDS_PER_MINUTE over budgetSeconds. */
  maxWords: number
  /** The headroom fraction this budget was derived with. */
  headroom: number
}

/**
 * The word budget a composition's geometry allows.
 *
 * DERIVED, never a literal: pass the composition's real seconds
 * (compositionSeconds of its geometry) and the ceiling moves when the geometry
 * moves. A composition with no runtime (a still card, or an unregistered id
 * resolving to 0) yields maxWords 0 — the caller must treat that as "this
 * composition cannot carry narration", not as "no limit".
 */
export function narrationBudget(
  compositionId: string,
  compositionSeconds: number,
  headroom: number = NARRATION_HEADROOM,
): NarrationBudget {
  const secs = Number.isFinite(compositionSeconds) && compositionSeconds > 0 ? compositionSeconds : 0
  const h = Number.isFinite(headroom) && headroom >= 0 && headroom < 1 ? headroom : NARRATION_HEADROOM
  const budgetSeconds = Number((secs * (1 - h)).toFixed(3))
  return {
    compositionId,
    compositionSeconds: secs,
    budgetSeconds,
    maxWords: targetWordCount(budgetSeconds),
    headroom: h,
  }
}

/**
 * Split spoken text into words. One spelling for the whole video lane (§6) —
 * lib/video/caption-plan.ts's private splitWords now calls this.
 */
export function spokenWords(text: string | null | undefined): string[] {
  return (text ?? "").trim().split(/\s+/).filter(Boolean)
}

/** What happened when a generated script met its composition's budget. */
export interface NarrationFit {
  /** The script as it should actually be spoken. */
  script: string
  wordCount: number
  /** Spoken seconds of `script` at WORDS_PER_MINUTE. */
  estimatedSeconds: number
  /** The model's draft exceeded maxWords. True whenever anything was dropped. */
  overran: boolean
  /** Words dropped from the draft. 0 when it fit as written. */
  droppedWords: number
  /**
   * The trim could not get under budget — the FIRST sentence alone is longer
   * than the composition. The clean cut is kept anyway (an empty narration is
   * worse than a long one, and the mux is the same either way), but the caller
   * must surface this rather than treat it as a pass.
   */
  stillOverBudget: boolean
  /** Quotable one-liner for the log. Empty string when the draft fit. */
  note: string
}

/** Split a script into sentences, keeping terminal punctuation with its sentence. */
function splitSentences(script: string): string[] {
  const flat = (script ?? "").trim().replace(/\s+/g, " ")
  if (!flat) return []
  return flat.split(/(?<=[.!?]["'”’)\]]?)\s+/).filter((s) => s.trim().length > 0)
}

/**
 * Hold a generated script to its composition's budget.
 *
 * THE OVERRUN POLICY IS **TRIM TO A SENTENCE BOUNDARY**, and the reasoning is
 * that the two alternatives are both worse here:
 *
 *   · REGENERATE ONCE costs a second paid model call and guarantees nothing —
 *     the model already ignored an explicit word ceiling, and the two producers
 *     that draft through runWithComplianceRedraft would then owe the compliance
 *     gate a second pass on the re-draft. An unbounded retry loop to enforce a
 *     bound is the wrong shape.
 *   · REFUSE throws away a compliance-cleared script over a length the code can
 *     fix deterministically, and turns "slightly long" into no narration at all
 *     — against the standing "voice on every video" rule.
 *
 * Trimming at a SENTENCE boundary (never mid-word, never mid-clause) is the one
 * option that is free, deterministic, and keeps the result compliance-safe: a
 * prefix of cleared sentences carries no claim the gate did not already clear.
 * What it costs is the closing CTA when the draft runs long, which is a real
 * content loss — so it is REPORTED, never silent. That is the whole point: the
 * defect being fixed is not that scripts are long, it is that nothing ever
 * looked.
 */
export function fitNarrationToBudget(
  script: string | null | undefined,
  budget: NarrationBudget,
): NarrationFit {
  const draftWords = spokenWords(script)
  const draftCount = draftWords.length

  const fitted = (text: string, dropped: number, stillOver: boolean, note: string): NarrationFit => {
    const words = spokenWords(text)
    return {
      script: text,
      wordCount: words.length,
      estimatedSeconds: estimateDurationSeconds(words.length),
      overran: dropped > 0 || stillOver,
      droppedWords: dropped,
      stillOverBudget: stillOver,
      note,
    }
  }

  if (draftCount === 0) return fitted("", 0, false, "")

  // A composition with no runtime cannot carry narration at all. Say so; do not
  // silently treat "no budget" as "no limit".
  if (budget.maxWords <= 0) {
    return fitted("", draftCount, true,
      `${budget.compositionId} has no runtime to narrate (${budget.compositionSeconds}s): `
      + `dropped all ${draftCount} words rather than baking a track nothing can play.`)
  }

  if (draftCount <= budget.maxWords) return fitted((script ?? "").trim(), 0, false, "")

  const sentences = splitSentences(script ?? "")
  const kept: string[] = []
  let keptWords = 0
  for (const s of sentences) {
    const n = spokenWords(s).length
    if (keptWords + n > budget.maxWords) break
    kept.push(s)
    keptWords += n
  }

  if (kept.length === 0) {
    // Not one whole sentence fits. Keep the first — a clean sentence that runs
    // long is still better than an empty track — and flag it hard.
    const first = sentences[0] ?? (script ?? "").trim()
    const firstWords = spokenWords(first).length
    return fitted(first, draftCount - firstWords, true,
      `${budget.compositionId}: the first sentence alone is ${firstWords} words `
      + `(~${estimateDurationSeconds(firstWords)}s) against a ${budget.maxWords}-word / `
      + `${budget.budgetSeconds}s budget on a ${budget.compositionSeconds}s composition — `
      + `it WILL be cut off. The composition is too short for this narration.`)
  }

  const text = kept.join(" ")
  return fitted(text, draftCount - keptWords, false,
    `${budget.compositionId}: script came back ${draftCount} words `
    + `(~${estimateDurationSeconds(draftCount)}s) against a ${budget.maxWords}-word / `
    + `${budget.budgetSeconds}s budget on a ${budget.compositionSeconds}s composition; `
    + `trimmed to ${keptWords} words at a sentence boundary (${draftCount - keptWords} dropped).`)
}

/**
 * The sentence a prompt uses to ask for a script that fits. ONE spelling, so
 * every producer asks in the same words and a reader can tell at a glance that
 * the number came from the geometry rather than from someone's guess.
 */
/**
 * A model token budget sized to the word budget.
 *
 * Not a second cap — the WORD budget is the cap, and fitNarrationToBudget
 * enforces it. This just stops a producer paying for (and waiting on) three
 * times the text it is going to throw away. Deliberately LOOSE: ~3 tokens per
 * word plus a fixed 32, because a token cut lands mid-sentence and the trim then
 * discards that whole partial sentence — a tight token budget would silently
 * shorten the script below its real budget.
 */
export function narrationMaxTokens(budget: NarrationBudget): number {
  return Math.max(64, Math.ceil(budget.maxWords * 3) + 32)
}

export function narrationLengthDirective(budget: NarrationBudget): string {
  return `Hard length limit: AT MOST ${budget.maxWords} words total `
    + `(this is spoken over a ${budget.compositionSeconds}-second video — anything longer is cut off). `
    + `Finish your final sentence within that budget.`
}
