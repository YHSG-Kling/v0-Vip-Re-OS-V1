/**
 * lib/video/memory-video-gate.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE — decides whether a seller-side deal warrants a "memory video"
 * recommendation (app/api/ai/video-recommendations/route.ts).
 *
 * WHERE THE PERSONA ACTUALLY LIVES
 * public.leads has a `persona` column but no age column, and — verified against
 * pg_constraint — there is no foreign key joining transactions and leads in
 * either direction, so a deal cannot reach a lead at all. The client of a deal
 * is a CONTACT (transactions.contact_id / seller_contact_id / buyer_contact_id
 * all FK contacts.id), and public.contacts is where contact_persona lives. That
 * is the column this gate reads.
 *
 * WHY THERE IS NO AGE TEST
 * contacts.age_range exists, but gating a marketing recommendation on the
 * client's age is protected-class targeting — the same reason the re-engagement
 * copy in lib/ai-isa/adaptive-reengagement.ts keeps age to tone and never to
 * eligibility. The qualifying signal here is the client's own SITUATION
 * (downsizing, senior-move), which contact_persona states directly and which a
 * person chooses rather than has. Age is deliberately not an input.
 *
 * The raw column is free text that has already drifted, so it is normalised
 * through the one canonical normaliser (lib/campaigns/contact-sources.ts:
 * normalizeContactPersona) rather than compared against a hand-rolled spelling.
 */
import { normalizeContactPersona, type CampaignPersona } from "@/lib/campaigns/contact-sources"

/**
 * Canonical personas that mean "long-time homeowner closing a chapter" — the
 * situation a memory video is for. Both are members of CAMPAIGN_PERSONAS, so a
 * drifted spelling such as `downsizer` / `downsizing` normalises into this set.
 */
export const MEMORY_VIDEO_PERSONAS: readonly CampaignPersona[] = ["downsize", "senior"]

/**
 * PURE — does this contact_persona warrant a memory-video recommendation?
 * Unknown, empty and non-qualifying personas all return false; nothing is
 * inferred from the absence of a persona.
 */
export function qualifiesForMemoryVideo(rawPersona: string | null | undefined): boolean {
  const persona = normalizeContactPersona(rawPersona)
  return persona !== null && MEMORY_VIDEO_PERSONAS.includes(persona)
}

// ═══════════════════════════════════════════════════════════════════════════
// WHAT A MEMORY VIDEO ACTUALLY IS  (the owner's ruling, m565)
// ═══════════════════════════════════════════════════════════════════════════
//
// VERBATIM: "memory video is for sellers that have been in their home more than
// 20 years which is a seller dictated video going over the history of the house
// so the family has it (this is a special service that can be offered)."
//
// Four load-bearing facts, and each one is enforced somewhere below or names the
// file that enforces it:
//
//   1. ELIGIBILITY IS TENURE — more than 20 years in the home. Not age (that is
//      protected-class targeting, and the note at the top of this file records
//      why the age operand was removed once already). Not persona alone: the
//      persona says the SITUATION, the tenure is the RULE.
//   2. THE SELLER DICTATES IT. The content is the seller's own words about their
//      own family's history. A model may not write it. See MODEL_MAY /
//      MODEL_MAY_NOT and assembleSellerDictatedScript below.
//   3. IT IS OFFERED, NEVER AUTO-SENT. "a special service that can be offered" —
//      so the rail proposes it to the AGENT (gated, through
//      lib/video/memory-video.ts) and nothing fires at a 20-year contact on its
//      own.
//   4. THE FAMILY KEEPS IT. The deliverable is a keepsake, not marketing — which
//      is why 'memory_video' is not in PROMOTABLE_VIDEO_KINDS either.
//
// TWO PREDICATES, TWO QUESTIONS, NOT TWO SPELLINGS OF ONE (§6).
// qualifiesForMemoryVideo answers "is this the situation?" from the persona the
// client declares. assessMemoryVideoTenure answers "does the owner's rule admit
// them?" from how long they have lived there. Neither substitutes for the other,
// and both callers — app/api/ai/video-recommendations/route.ts and
// lib/video/memory-video.ts — run them in that order.

/**
 * The owner's threshold, in years. Read as a LOWER BOUND, and that is a decision
 * worth stating: the free-text column this is measured from
 * (`contacts.length_of_residence`) is a banded enrichment field whose top band is
 * literally "20+ years", which lib/avm/provider-chain.ts::parseLengthOfResidence
 * reads as the number 20. A strict `> 20` would therefore refuse the exact
 * population the ruling names, because "20+ years" cannot prove 20.5. So the gate
 * admits at 20 and above: 19 refuses, 20 admits, 21 admits.
 */
export const MEMORY_VIDEO_MIN_TENURE_YEARS = 20

export interface MemoryVideoTenureVerdict {
  /** True only when tenure is KNOWN and meets the threshold. */
  eligible: boolean
  /** Years used for the decision, or null when tenure could not be established. */
  tenureYears: number | null
  /** Why — always populated, always safe to show an agent. */
  reason: string
}

/**
 * PURE — the eligibility rule, and it FAILS CLOSED.
 *
 * `tenureYears` is what lib/avm/provider-chain.ts::parseLengthOfResidence made of
 * `contacts.length_of_residence`, falling back to years since a prior purchase's
 * `close_date` — the SAME survivor lib/predictive-listing/signal-generators.ts
 * already derives tenure with. There is no second parser, here or anywhere.
 *
 * UNKNOWN TENURE REFUSES. A null (no enrichment on file, an unparseable band, no
 * prior transaction) is NOT treated as "probably long enough". This is a paid
 * service being offered to a specific family on the strength of a specific claim
 * about their own home; offering it to someone whose tenure the platform cannot
 * establish is a claim the platform has not earned, and CLAUDE.md §4 is explicit
 * that "nobody checked" must never render as "checked and fine".
 */
export function assessMemoryVideoTenure(
  tenureYears: number | null | undefined,
): MemoryVideoTenureVerdict {
  if (tenureYears == null || !Number.isFinite(tenureYears) || tenureYears <= 0) {
    return {
      eligible: false,
      tenureYears: null,
      reason:
        "tenure unknown — no length_of_residence on file and no prior purchase to date it from. " +
        "The memory video is not offered on an unestablished claim.",
    }
  }
  if (tenureYears < MEMORY_VIDEO_MIN_TENURE_YEARS) {
    return {
      eligible: false,
      tenureYears,
      reason: `${tenureYears} years in the home — the memory video is for ${MEMORY_VIDEO_MIN_TENURE_YEARS}+ years.`,
    }
  }
  return {
    eligible: true,
    tenureYears,
    reason: `${tenureYears} years in the home — ${MEMORY_VIDEO_MIN_TENURE_YEARS}+ years, so the memory video can be offered.`,
  }
}

// ─── THE SELLER-DICTATED BOUNDARY ───────────────────────────────────────────
//
// CLAUDE.md §5 already holds one absolute of this shape: "Anything reaching a
// LICENSED APPRAISER must not be model-authored." The reason there is that the
// output is someone else's professional judgement and a model imitating it is a
// forgery. The same reason applies word for word here, with the family in the
// appraiser's place: a memory video IS the seller's account of their own home. A
// model that writes "the kitchen was where everyone gathered at Christmas"
// because kitchens usually are has forged a memory, and the family — who will
// keep this — is the one party in the product with no way to tell.
//
// So the boundary is stated in the code rather than left to good intentions, and
// assembleSellerDictatedScript below is where it is enforced: the script it
// returns is a concatenation of captured seller text and nothing else. There is
// no model call in this module, and none in the assembly path.

/** What the model MAY do with a memory video. Shown to agents; asserted by the proof. */
export const MODEL_MAY: readonly string[] = [
  "order the captured answers into the canonical chapter sequence",
  "trim leading/trailing whitespace and drop an empty answer",
  "cut a caption strip VERBATIM from what the seller said",
  "screen the seller's words against the fair-housing pattern bank and flag them for a human",
]

/** What the model MAY NOT do. These are the product, not a style preference. */
export const MODEL_MAY_NOT: readonly string[] = [
  "write, complete, embellish or 'improve' any sentence of the family's history",
  "invent a memory, a date, a name, a room or an event the seller did not say",
  "paraphrase the seller's words into a narrator's voice",
  "substitute a generated script when the seller's capture is incomplete",
]

/** The chapters the agent walks the seller through. ORDER IS THE SCRIPT ORDER. */
export const MEMORY_VIDEO_PROMPTS: ReadonlyArray<{ id: string; ask: string }> = [
  { id: "arrival",     ask: "When did you move in, and what made you choose this house?" },
  { id: "the_house",   ask: "Tell me about the house itself — what did you change, what did you keep?" },
  { id: "the_people",  ask: "Who grew up here, and who came to visit?" },
  { id: "the_moments", ask: "What happened in this house that you want the family to remember?" },
  { id: "the_street",  ask: "What do you want them to know about the street and the neighbours?" },
  { id: "farewell",    ask: "What would you say to whoever lives here next?" },
]

export interface SellerDictatedSegment {
  /** One of MEMORY_VIDEO_PROMPTS[].id — anything else is refused. */
  promptId: string
  /** THE SELLER'S OWN WORDS. Transcribed or typed, never generated. */
  sellerWords: string
  /** How the words were captured — the provenance a human can audit. */
  capturedVia: "agent_transcription" | "seller_typed" | "voice_recording"
  /** ISO timestamp of capture. */
  capturedAt: string
  /**
   * THE SELLER'S OWN RECORDING for this chapter (wave 80C): an on-camera clip
   * (seller_walkthrough) or an audio recording (seller_audio_photos), hosted in
   * a Supabase bucket. This is what narrates the film — never TTS, never a
   * cloned voice (MEMORY_VIDEO_VOICE_RULE).
   */
  mediaUrl?: string | null
  mediaKind?: "video" | "audio" | null
  /** Measured on upload; the chapter's frames come from it. Absent → estimated from the words and reported. */
  mediaDurationSeconds?: number | null
}

// ─── THE TWO MODES AND WHOSE VOICE (wave 80C) ────────────────────────────────

import { MEMORY_VIDEO_MODES, type MemoryVideoMode } from "./memory-video-composition"
export { MEMORY_VIDEO_MODES, type MemoryVideoMode }

/**
 * WHOSE VOICE NARRATES. Stated once, asserted by the proof: the seller's own
 * recording is the narration in BOTH modes. The platform does not synthesize
 * the seller's words in the agent's voice (a stranger telling the family's
 * story) and it NEVER clones the seller's voice — a voice clone is a consent
 * gate the seller has not walked (lib/did/consent.ts, the D-ID/ElevenLabs
 * consent rail) and this product must not be the place it is skipped.
 */
export const MEMORY_VIDEO_VOICE_RULE =
  "The narrator is the seller's own recording. No text-to-speech, no cloned voice: a memory film speaks in the family's voice or it is not made."

/** Photos the audio mode needs before it can film — one is the floor; one per chapter is the recommendation reported back. */
export const MEMORY_VIDEO_MIN_PHOTOS = 1

export interface SellerMediaVerdict {
  ok: boolean
  mode: MemoryVideoMode | null
  /** Chapters (prompt ids) still missing the seller's recording. */
  missingMedia: string[]
  photoCount: number
  reason: string
}

/**
 * PURE — does the capture carry the seller's OWN media for the mode it was
 * made in? FAILS CLOSED: an unknown mode, a chapter without its recording, a
 * recording of the wrong kind for the mode, or an audio film with no photos
 * all refuse, naming what is missing. A capture that holds only typed or
 * transcribed words (the wave-78 shape) is NOT filmable until the seller's
 * recordings are attached — the platform does not voice it for them.
 */
export function assessSellerMedia(input: {
  mode: string | null | undefined
  segments: readonly SellerDictatedSegment[]
  photoUrls?: readonly string[] | null
}): SellerMediaVerdict {
  const photos = (input.photoUrls ?? []).filter((u) => typeof u === "string" && u.trim().length > 0)
  const mode = (MEMORY_VIDEO_MODES as readonly string[]).includes(String(input.mode ?? "")) ? (input.mode as MemoryVideoMode) : null
  if (!mode) {
    return { ok: false, mode: null, missingMedia: [], photoCount: photos.length, reason: `no memory-video mode on the capture — it is made either as ${MEMORY_VIDEO_MODES.join(" or ")}; pick one and attach the seller's recordings` }
  }
  const wantKind: "video" | "audio" = mode === "seller_walkthrough" ? "video" : "audio"
  const dictated = input.segments.filter((s) => (s.sellerWords ?? "").trim().length > 0)
  // The last capture per chapter wins (a re-record corrects), exactly as assembleSellerDictatedScript treats words.
  const latest = new Map<string, SellerDictatedSegment>()
  for (const s of dictated) latest.set(s.promptId, s)
  const missingMedia = [...latest.entries()]
    .filter(([, s]) => !(typeof s.mediaUrl === "string" && s.mediaUrl.trim().length > 0 && s.mediaKind === wantKind))
    .map(([id]) => id)
  if (latest.size === 0) return { ok: false, mode, missingMedia, photoCount: photos.length, reason: "nothing has been captured yet" }
  if (missingMedia.length > 0) {
    return { ok: false, mode, missingMedia, photoCount: photos.length, reason: `${mode}: the seller's ${wantKind} recording is missing for ${missingMedia.join(", ")} — the platform does not voice a family's story for them (${MEMORY_VIDEO_VOICE_RULE})` }
  }
  if (mode === "seller_audio_photos" && photos.length < MEMORY_VIDEO_MIN_PHOTOS) {
    return { ok: false, mode, missingMedia, photoCount: photos.length, reason: `seller_audio_photos: the home's photos are the visuals and none are attached (need ≥ ${MEMORY_VIDEO_MIN_PHOTOS}; one per chapter — ${latest.size} — is the recommendation)` }
  }
  const advice = mode === "seller_audio_photos" && photos.length < latest.size ? ` (${photos.length} photo(s) over ${latest.size} chapters — one per chapter is the recommendation; photos will repeat)` : ""
  return { ok: true, mode, missingMedia, photoCount: photos.length, reason: `${mode}: every chapter carries the seller's own ${wantKind}${advice}` }
}

export interface MemoryVideoScript {
  ok: boolean
  /** The seller's words, in chapter order. Empty string when !ok. */
  script: string
  /** Chapters that carry seller words, in order. */
  chapters: string[]
  /** Prompt ids still unanswered — the agent's to-do, never the model's to fill. */
  missing: string[]
  reason: string
}

/**
 * PURE — assemble the seller's captured words into the script.
 *
 * This is the whole of the "authoring" the platform does, and it is deliberately
 * boring: sort by the canonical chapter order, drop blanks, join. It CANNOT
 * introduce a sentence, because it never constructs one — every character it
 * returns came out of a `sellerWords` field.
 *
 * REFUSES rather than degrades:
 *   · an unknown promptId → refused whole. A chapter nobody asked for is a
 *     chapter nobody can attribute to the seller.
 *   · every chapter blank → refused. An empty keepsake is not a keepsake, and
 *     returning "" would invite a caller to fill it with something else.
 * A PARTIAL capture is allowed and reported in `missing`: a seller who answers
 * four of six chapters has still dictated four chapters, and the honest state is
 * "four chapters, two still to record" — not a model finishing their sentences.
 */
export function assembleSellerDictatedScript(
  segments: readonly SellerDictatedSegment[],
): MemoryVideoScript {
  const order = MEMORY_VIDEO_PROMPTS.map((p) => p.id)
  const unknown = segments.map((s) => s.promptId).filter((id) => !order.includes(id))
  if (unknown.length > 0) {
    return {
      ok: false, script: "", chapters: [], missing: [...order],
      reason: `refused: ${unknown.join(", ")} is not a memory-video chapter — nothing outside the capture sheet can be attributed to the seller`,
    }
  }

  const byPrompt = new Map<string, string>()
  for (const s of segments) {
    const words = (s.sellerWords ?? "").trim()
    if (!words) continue
    // Later capture of the same chapter wins — a seller re-recording an answer
    // is correcting themselves, and the correction is still their words.
    byPrompt.set(s.promptId, words)
  }

  const chapters = order.filter((id) => byPrompt.has(id))
  const missing = order.filter((id) => !byPrompt.has(id))
  if (chapters.length === 0) {
    return {
      ok: false, script: "", chapters: [], missing,
      reason: "refused: nothing has been captured yet — a memory video with no dictated words is not a memory video",
    }
  }

  return {
    ok: true,
    script: chapters.map((id) => byPrompt.get(id)!).join("\n\n"),
    chapters,
    missing,
    reason: missing.length === 0
      ? `all ${chapters.length} chapters dictated`
      : `${chapters.length} of ${order.length} chapters dictated; still to record: ${missing.join(", ")}`,
  }
}

/**
 * PURE — is this project row's script genuinely the seller's?
 *
 * The stamp lib/video/memory-video.ts writes is `video_metadata.authored_by =
 * 'seller'` plus the captured segments. Any consumer about to publish, caption or
 * repurpose a memory video can ask this before it does, and a row that cannot
 * prove seller authorship answers NO — the same fail-closed direction as the
 * tenure gate.
 */
export function isSellerAuthored(videoMetadata: unknown): boolean {
  const m = (videoMetadata ?? null) as { authored_by?: unknown; dictation?: unknown } | null
  if (!m || m.authored_by !== "seller") return false
  return Array.isArray(m.dictation) && m.dictation.length > 0
}
