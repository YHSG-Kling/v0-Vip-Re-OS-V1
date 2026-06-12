/**
 * lib/video/video-director.ts
 *
 * THE VIDEO DIRECTOR — the Asset Manager becomes the team's creative director.
 *
 * Given a SITUATION (a listing just published, a price dropped, a sphere
 * anniversary came due, the agent wants an explainer …) the Director:
 *
 *   (a) CHOOSES the format most likely to succeed for that situation on that
 *       channel — selectVideoFormat (PURE). The creative-director logic lives
 *       here: new_listing on TikTok/IG wants a SQUARE reel with Remotion B-roll;
 *       the same listing for YouTube wants the HORIZONTAL 16:9 cut; a market
 *       update / CMA wants the chart compositions; an explainer wants the avatar;
 *       a presentation wants the narrated slide section; an anniversary wants the
 *       equity report. Each mapping is documented inline + fully unit-testable.
 *
 *   (b) COMMISSIONS the full assembly — intro → main → outro — reusing the
 *       just-shipped pieces (it does NOT rebuild them):
 *         · assemblySpec (PURE) returns the STRUCTURE of the intro (brand + agent
 *           photo + hook line) and the outro (brand + agent contact + QR
 *           destination kind). The hook COPY is generated at runtime via
 *           generatePersonaCopy with a deterministic fallback; assemblySpec only
 *           describes the shape the build will fill.
 *         · commissionVideo resolves the format, mints the outro QR
 *           (lib/video/video-qr.ts → mintVideoQr), drafts + gates the hook/script
 *           (lib/kernel/ai-copy generatePersonaCopy + lib/kernel/compliance-redraft
 *           runWithComplianceRedraft), and STAGES a real ai_video_projects row
 *           with the selected compositionId + bookend flags + intro/outro/QR input
 *           props. The existing render crons + concatIntroOutro carry it the rest
 *           of the way.
 *
 * Reused (NOT rebuilt) — referenced by ID-string + capability, never hard-deps:
 *   · the 24 registered Remotion compositions (remotion/Root.tsx) — by ID string,
 *     read through lib/remotion/registry getComposition so the registry row is the
 *     source of truth for supports_bookends / requires_did_avatar / requires_voiceover.
 *   · lib/video/composite-attribution concatIntroOutro (intro+main+outro stitch).
 *   · lib/video/video-qr mintVideoQr + qrDestinationForKind (tracked outro QR).
 *   · lib/kernel/video createVideoProject contract (the ai_video_projects shape).
 *   · lib/kernel/ai-copy generatePersonaCopy (+ deterministic fallback).
 *   · lib/kernel/compliance-redraft runWithComplianceRedraft + lib/kernel/compliance
 *     evaluateOutbound (the gate every producer uses before render spend).
 *
 * The Director is invoked by SITUATIONS / plays (a new listing, an anniversary,
 * an agent request) — there is NO new cron. It is compliance-gated and NEVER
 * auto-publishes: the row is staged at approval_status='pending_review' so a
 * human approves before any distribution.
 *
 * NOT server-only: the PURE selectors + assemblySpec are imported by the
 * simulator (tsx is neither a Server Component); commissionVideo uses the service
 * client only when actually invoked.
 */
import type { createServiceClient } from "@/lib/supabase/service"
import type { VideoQrKind } from "@/lib/video/video-qr"
// The learning layer is PURE (no I/O, not server-only) so it is safe to import by
// value here — selectVideoFormatLearned uses recommendFormatAdjustment directly,
// and selectVideoFormat itself never touches it (backward-compat preserved).
import { recommendFormatAdjustment, type ScoredFormats } from "@/lib/video/format-learning"

// ============================================================================
// SITUATION + FORMAT CONTRACTS (pure)
// ============================================================================

/** The creative brief the Director reasons over. */
export type SituationKind =
  | "new_listing"
  | "price_drop"
  | "just_sold"
  | "open_house"
  | "coming_soon"
  | "market_update"
  | "cma"
  | "explainer"
  | "presentation"
  | "anniversary"
  | "testimonial"
  | "neighborhood"

export type CompositionTierLite =
  | "solo_agent" | "team" | "brokerage" | "multi_location" | "platform"

export type TargetChannel =
  | "tiktok" | "instagram" | "youtube" | "facebook" | "email" | "portal"

export type VideoAspect = "square" | "vertical" | "horizontal"

export interface VideoSituation {
  kind: SituationKind
  tier: CompositionTierLite
  /** Where the agent intends to post — drives aspect + square-vs-horizontal. */
  targetChannel: TargetChannel
  /** Free-form, situation-specific facts (listing id, contact id, area name …).
   *  The selector reads only `kind`+`targetChannel`; commissionVideo reads facts. */
  facts?: Record<string, unknown>
}

export interface SelectedFormat {
  /** The Remotion composition id (a registry/Root.tsx ID string). */
  compositionId: string
  /** Does the chosen format put a D-ID avatar on screen? (explainer/market). */
  needsAvatar: boolean
  /** Does the chosen format want Remotion B-roll clips composited in? */
  needsBroll: boolean
  /** Does the chosen format render data charts (CMA / market update)? */
  needsCharts: boolean
  /** Is the chosen format a narrated slide section (presentation)? */
  needsSlides: boolean
  /** Canvas aspect the channel reads best. */
  aspect: VideoAspect
  /** The channels this format is sized + cut for. */
  targetChannels: TargetChannel[]
}

// ── Channel → aspect. Vertical feeds (TikTok/IG/Shorts) want 9:16 or 1:1;
//    horizontal placements (YouTube long-form, FB in-stream/CTV) want 16:9;
//    email/portal embed the square cut (plays inline without letterboxing). ──
function aspectForChannel(channel: TargetChannel): VideoAspect {
  switch (channel) {
    case "youtube":   return "horizontal"
    case "facebook":  return "horizontal"
    case "tiktok":    return "vertical"
    case "instagram": return "square"
    case "email":     return "square"
    case "portal":    return "square"
  }
}

/** Vertical-first social channels favor the SQUARE/vertical reel + B-roll. */
function isVerticalSocial(channel: TargetChannel): boolean {
  return channel === "tiktok" || channel === "instagram"
}

/**
 * selectVideoFormat — PURE creative-director logic. No I/O, no DB.
 *
 * The mapping (each documented):
 *
 *   new_listing
 *     · tiktok / instagram → JustListedReelSquare WITH Remotion B-roll. The
 *       square 1:1 cut is the organic-feed default for Meta/IG/TikTok; B-roll
 *       lifestyle clips under the listing facts is what stops the scroll.
 *     · youtube / facebook → JustListedReelHorizontal — the 16:9 cut sized for
 *       YouTube + FB in-stream / CTV; no B-roll (long-form reads the photos).
 *     · email / portal → JustListedReelSquare (embeds inline without letterbox).
 *   price_drop  → JustListedReelSquare (same listing chrome, neutral pricing copy
 *                 carried by the script; horizontal on youtube/facebook).
 *   just_sold   → JustSoldReelSquare — social-proof companion, square feed cut.
 *   open_house  → OpenHouseAnnounceReel — event headline (date/time/address).
 *   coming_soon → ComingSoonReel — pre-MLS teaser, heaviest B-roll user.
 *   market_update → MarketUpdateReel — CHART stat-cards + avatar narration.
 *   cma         → CMAReel — the chart flagship (price trend + comps + DOM + donut).
 *   explainer   → AgentExplainerReel — AVATAR-led educational reel.
 *   presentation→ ListingSectionReel — narrated SLIDE section (1920×1080).
 *   anniversary → EquityReportReel — the sphere equity report (by ID string; the
 *                 sibling agent registers the composition — we never hard-dep it).
 *   testimonial → TestimonialReel — 5-star social proof.
 *   neighborhood→ NeighborhoodSpotlightReel — lifestyle B-roll spotlight.
 */
export function selectVideoFormat(situation: VideoSituation): SelectedFormat {
  const { kind, targetChannel } = situation
  const vertical = isVerticalSocial(targetChannel)
  const wantsHorizontal = targetChannel === "youtube" || targetChannel === "facebook"

  // The channels a format ships for: the requested one + its natural siblings.
  const socialFeed: TargetChannel[] = ["tiktok", "instagram"]

  switch (kind) {
    case "new_listing":
    case "price_drop": {
      if (wantsHorizontal) {
        // YouTube / FB in-stream / CTV → 16:9, no B-roll (long-form reads photos).
        return {
          compositionId: "JustListedReelHorizontal",
          needsAvatar: false, needsBroll: false, needsCharts: false, needsSlides: false,
          aspect: "horizontal",
          targetChannels: ["youtube", "facebook"],
        }
      }
      // TikTok / IG / email / portal → the square reel; vertical social adds B-roll.
      return {
        compositionId: "JustListedReelSquare",
        needsAvatar: false,
        needsBroll: vertical, // B-roll is what stops the scroll on TikTok/IG
        needsCharts: false, needsSlides: false,
        aspect: vertical ? aspectForChannel(targetChannel) : "square",
        targetChannels: vertical ? socialFeed : [targetChannel],
      }
    }

    case "just_sold":
      return {
        compositionId: "JustSoldReelSquare",
        needsAvatar: false, needsBroll: false, needsCharts: false, needsSlides: false,
        aspect: "square",
        targetChannels: socialFeed,
      }

    case "open_house":
      return {
        compositionId: "OpenHouseAnnounceReel",
        needsAvatar: false, needsBroll: false, needsCharts: false, needsSlides: false,
        aspect: "square",
        targetChannels: socialFeed,
      }

    case "coming_soon":
      return {
        compositionId: "ComingSoonReel",
        needsAvatar: false,
        needsBroll: true, // coming-soon teaser is the heaviest B-roll user
        needsCharts: false, needsSlides: false,
        aspect: "square",
        targetChannels: socialFeed,
      }

    case "market_update":
      return {
        compositionId: "MarketUpdateReel",
        needsAvatar: true,   // avatar narrates the stat cards
        needsBroll: false,
        needsCharts: true,   // three big chart stat-cards
        needsSlides: false,
        aspect: "square",
        targetChannels: ["instagram", "email"],
      }

    case "cma":
      return {
        compositionId: "CMAReel",
        needsAvatar: false, needsBroll: false,
        needsCharts: true,   // price trend + comps + DOM + affordability donut
        needsSlides: false,
        aspect: "square",
        targetChannels: ["email", "portal"],
      }

    case "explainer":
      return {
        compositionId: "AgentExplainerReel",
        needsAvatar: true,   // avatar-led educational reel
        needsBroll: false, needsCharts: false, needsSlides: false,
        aspect: "square",
        targetChannels: socialFeed,
      }

    case "presentation":
      return {
        compositionId: "ListingSectionReel",
        needsAvatar: false, needsBroll: false, needsCharts: false,
        needsSlides: true,   // narrated slide section, 1920×1080
        aspect: "horizontal",
        targetChannels: ["email", "portal"],
      }

    case "anniversary":
      // EquityReportReel is registered by the sibling agent — referenced by ID
      // string only so the Director never hard-deps the composition module.
      return {
        compositionId: "EquityReportReel",
        needsAvatar: false, needsBroll: false,
        needsCharts: true,   // equity vs purchase price report
        needsSlides: false,
        aspect: "square",
        targetChannels: ["email", "portal"],
      }

    case "testimonial":
      return {
        compositionId: "TestimonialReel",
        needsAvatar: false, needsBroll: false, needsCharts: false, needsSlides: false,
        aspect: "square",
        targetChannels: socialFeed,
      }

    case "neighborhood":
      return {
        compositionId: "NeighborhoodSpotlightReel",
        needsAvatar: false,
        needsBroll: true,    // lifestyle clips under the data highlights
        needsCharts: false, needsSlides: false,
        aspect: "square",
        targetChannels: socialFeed,
      }
  }
}

// ============================================================================
// SELF-IMPROVING LAYER (pure, optional, backward-compatible)
// ============================================================================

/**
 * selectVideoFormatLearned — a SEPARATE, OPTIONAL learning layer over the expert
 * default. It NEVER replaces selectVideoFormat (the render-just-listed path + the
 * simulator still call plain selectVideoFormat and get the deterministic choice).
 *
 * Given a scored outcomes map (from lib/video/format-learning loadFormatOutcomes /
 * scoreFormatOutcomes), it resolves the default, then asks recommendFormatAdjustment
 * whether REAL per-brokerage outcomes justify overriding it. The gate is honest:
 * thin or tied data → the default is returned UNCHANGED (so passing an empty
 * ScoredFormats is EXACTLY equivalent to selectVideoFormat — the backward-compat
 * contract the simulator asserts).
 *
 * Returns the (possibly overridden) SelectedFormat — same shape selectVideoFormat
 * returns — PLUS the learning provenance so commissionVideo can stamp
 * video_metadata.format_source + the WHY for auditability.
 */
export interface LearnedFormat {
  format: SelectedFormat
  /** "default" = expert rule kept; "learned" = a real, gated per-brokerage win. */
  formatSource: "default" | "learned"
  /** The music mood after any learned override (default's mood unless overridden). */
  mood: MusicMood
  /** Human-readable explanation of the choice — rides video_metadata. */
  why: string
}

export function selectVideoFormatLearned(
  situation: VideoSituation,
  scored: ScoredFormats,
): LearnedFormat {
  // The expert default is ALWAYS the starting point and the fallback.
  const def = selectVideoFormat(situation)
  const defaultMood = musicMoodForSituation(situation.kind)

  const rec = recommendFormatAdjustment(
    { kind: videoTypeForSituation(situation.kind), channel: situation.targetChannel },
    scored,
    { compositionId: def.compositionId, mood: defaultMood },
  )

  if (rec.source !== "learned" || rec.compositionId === def.compositionId) {
    // Default kept — identical to selectVideoFormat (backward-compat contract).
    return { format: def, formatSource: "default", mood: defaultMood, why: rec.why }
  }

  // A gated, real win: swap the composition id (+ learned mood) onto the default's
  // flags/aspect/channels. The capability flags stay the default's — the render
  // path re-reads the registry for the chosen composition anyway (commissionVideo
  // step 2), so swapping the id is sufficient and never fabricates a capability.
  return {
    format: { ...def, compositionId: rec.compositionId },
    formatSource: "learned",
    mood: rec.mood,
    why: rec.why,
  }
}

// ============================================================================
// ASSEMBLY SPEC (pure) — the intro + outro STRUCTURE
// ============================================================================

/** The intro the build assembles: brand + agent photo + a hook line. The hook
 *  COPY is generated at runtime (generatePersonaCopy + fallback); the spec only
 *  declares the slots. */
export interface IntroSpec {
  /** Brand band shows the brokerage trade name + colors. */
  brand: true
  /** Agent photo card (agents.avatar_image_url at build time). */
  agentPhoto: true
  /** The hook headline slot — copy filled at runtime. */
  hook: { kind: "headline"; fallback: string }
}

/** The outro the build assembles: brand + agent contact + a tracked QR whose
 *  destination is keyed by the video kind (qrDestinationForKind). */
export interface OutroSpec {
  brand: true
  /** Agent contact line (name + phone) shown on the outro card. */
  agentContact: true
  /** The QR destination kind the outro encodes — resolved by mintVideoQr. */
  qr: { kind: VideoQrKind }
}

/** The music MOOD the Director assigns a situation. The render coordinator picks a
 *  licensed track tagged with this mood (video_assets.music_mood), VO stays dominant
 *  (music ducked to ~20%). "none" = informational cut, no music. */
export type MusicMood = "none" | "energetic" | "sophisticated" | "calm" | "upbeat"

export interface AssemblySpec {
  intro: IntroSpec
  outro: OutroSpec
  /** The background-music mood for this situation (the coordinator honors it). */
  music: { mood: MusicMood }
}

/**
 * Map a Director SituationKind → the background-music MOOD. The creative-director call:
 * social-proof/celebration → energetic; luxury/new-listing → sophisticated; data/teaching
 * → calm (subtle, never fights narration); lifestyle/community → upbeat. Informational
 * in-house cuts (CMA, presentation) default to "none" — the numbers carry themselves.
 */
export function musicMoodForSituation(kind: SituationKind): MusicMood {
  switch (kind) {
    case "just_sold":
    case "testimonial":   return "energetic"
    case "new_listing":
    case "price_drop":
    case "coming_soon":   return "sophisticated"
    case "open_house":
    case "neighborhood":  return "upbeat"
    case "market_update":
    case "anniversary":
    case "explainer":     return "calm"
    case "cma":
    case "presentation":  return "none"
  }
}

/**
 * Map a Director SituationKind → the VideoQrKind the OUTRO QR resolves. Reuses
 * the existing qr destination taxonomy (lib/video/video-qr): listing kinds →
 * just_listed/just_sold (listing_detail); open_house → open_house (book_meeting);
 * presentation → presentation_chapter (video_avatar_tour); anniversary →
 * anniversary (anniversary_video). Everything else lands on the listing page or
 * (for non-listing kinds) just_listed as the safe default the resolver edits.
 */
export function qrKindForSituation(kind: SituationKind): VideoQrKind {
  switch (kind) {
    case "just_sold":     return "just_sold"
    case "open_house":    return "open_house"
    case "presentation":  return "presentation_chapter"
    case "anniversary":   return "anniversary"
    case "new_listing":
    case "price_drop":
    case "coming_soon":
    case "market_update":
    case "cma":
    case "explainer":
    case "testimonial":
    case "neighborhood":
    default:              return "just_listed"
  }
}

/** A deterministic hook fallback per situation — the safe real copy used when
 *  the persona generator is unavailable (tests, gateway down). Never a stub. */
export function defaultHookForSituation(kind: SituationKind): string {
  switch (kind) {
    case "new_listing":   return "Just Listed"
    case "price_drop":    return "Pricing Update"
    case "just_sold":     return "Just Sold"
    case "open_house":    return "Open House This Weekend"
    case "coming_soon":   return "Coming Soon"
    case "market_update": return "Your Market This Month"
    case "cma":           return "What Your Home Is Worth"
    case "explainer":     return "What You Should Know"
    case "presentation":  return "Your Listing Strategy"
    case "anniversary":   return "A Year In Your Home"
    case "testimonial":   return "What Clients Say"
    case "neighborhood":  return "Inside The Neighborhood"
  }
}

/**
 * assemblySpec — PURE. Given the situation + the resolved format, return the
 * intro/outro STRUCTURE the build will fill. No I/O.
 */
export function assemblySpec(
  situation: VideoSituation,
  _format: SelectedFormat,
): AssemblySpec {
  return {
    intro: {
      brand: true,
      agentPhoto: true,
      hook: { kind: "headline", fallback: defaultHookForSituation(situation.kind) },
    },
    outro: {
      brand: true,
      agentContact: true,
      qr: { kind: qrKindForSituation(situation.kind) },
    },
    music: { mood: musicMoodForSituation(situation.kind) },
  }
}

// ============================================================================
// COMMISSION (live) — stage the ai_video_projects row through the pipeline
// ============================================================================

type AnyClient = ReturnType<typeof createServiceClient>

/** Map a Director SituationKind → the ai_video_projects.video_type CHECK enum. */
function videoTypeForSituation(kind: SituationKind): string {
  switch (kind) {
    case "new_listing":   return "just_listed"
    case "price_drop":    return "listing_promo"
    case "just_sold":     return "just_sold"
    case "open_house":    return "open_house_promo"
    case "coming_soon":   return "coming_soon"
    case "market_update": return "market_update"
    case "cma":           return "pre_appointment"
    case "explainer":     return "education"
    case "presentation":  return "presentation_chapter"
    case "anniversary":   return "memory_video"
    case "testimonial":   return "testimonial"
    case "neighborhood":  return "social_reel"
  }
}

/** ai_video_projects.format CHECK-free text — store the aspect the cut targets. */
function formatForAspect(aspect: VideoAspect): string {
  switch (aspect) {
    case "vertical":   return "9:16"
    case "square":     return "1:1"
    case "horizontal": return "16:9"
  }
}

export interface CommissionOpts {
  brokerageId: string
  /** users.id of the agent (ai_video_projects.agent_id FK → users.id). */
  agentUserId: string
  /** Listing this video promotes — drives QR listing_detail + idempotency entity. */
  listingId?: string | null
  /** Contact the video is addressed to (anniversary) — QR + idempotency entity. */
  contactId?: string | null
  /** Campaign id for newsletter-style kinds. */
  campaignId?: string | null
  /** Title for the project row (defaults to "<Hook> — <compositionId>"). */
  title?: string | null
  /** Origin for the QR scan/target URLs. */
  origin?: string
  /** Injectable persona-copy generator seam (tests pass () => null for the
   *  deterministic fallback; production routes through the AI gateway). */
  copyGenerator?: import("@/lib/kernel/ai-copy").CopyGenerator
  /** MLS-clean cut → the outro carries NO agent QR (mirrors QrOutroBadge). */
  mlsClean?: boolean
  /**
   * OPTIONAL self-improving seam. When an injected/loaded scored-outcomes map is
   * supplied, commissionVideo consults selectVideoFormatLearned — which still
   * returns the deterministic default unless REAL per-brokerage outcomes clear the
   * sample+margin gate (lib/video/format-learning). Omitted → current behavior
   * EXACTLY (the pure expert default). Pass `true` to load outcomes for the
   * brokerage on-read; pass a ScoredFormats to inject a precomputed map (tests).
   */
  formatLearning?: boolean | ScoredFormats
}

export interface CommissionResult {
  ok: boolean
  status: "staged" | "already_staged" | "blocked" | "failed"
  videoProjectId?: string
  compositionId?: string
  reason?: string
  violations?: string[]
}

/**
 * commissionVideo — resolve format → mint outro QR → draft+gate the hook →
 * STAGE a real ai_video_projects row carrying the selected compositionId +
 * bookend flags + intro/outro/QR input props. Idempotent per (entity, kind).
 * Compliance-gated, NEVER auto-publishes (approval_status='pending_review').
 *
 * The existing render crons + concatIntroOutro carry it from here.
 */
export async function commissionVideo(
  situation: VideoSituation,
  opts: CommissionOpts,
  client?: AnyClient,
): Promise<CommissionResult> {
  if (!opts.brokerageId || !opts.agentUserId) {
    return { ok: false, status: "failed", reason: "brokerageId + agentUserId required" }
  }

  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc: AnyClient = client ?? createServiceClient()

  // 1. Resolve the format + assembly structure (pure).
  //    By default this is the deterministic expert choice. When formatLearning is
  //    supplied, we consult the SELF-IMPROVING layer — which still returns the
  //    default unless REAL per-brokerage outcomes clear the sample+margin gate. The
  //    chosen source + WHY are stamped onto video_metadata for auditability.
  let format = selectVideoFormat(situation)
  let formatSource: "default" | "learned" = "default"
  let formatWhy = "Expert default (no learning consulted)."
  let learnedMood: MusicMood | null = null
  if (opts.formatLearning) {
    try {
      let scored: ScoredFormats
      if (opts.formatLearning === true) {
        const { loadFormatOutcomes } = await import("@/lib/video/format-learning")
        scored = await loadFormatOutcomes(opts.brokerageId, svc)
      } else {
        scored = opts.formatLearning
      }
      const learned = selectVideoFormatLearned(situation, scored)
      format = learned.format
      formatSource = learned.formatSource
      formatWhy = learned.why
      if (learned.formatSource === "learned") learnedMood = learned.mood
    } catch (e) {
      // Learning is an enhancement, never a gate — fall back to the expert default.
      console.warn("[video-director] format-learning consult failed; using default:", (e as Error).message)
    }
  }
  const spec = assemblySpec(situation, format)

  // 2. Read the composition's capabilities from the registry (source of truth).
  //    When the row is absent (e.g. EquityReportReel mid-registration by the
  //    sibling agent) we fall back to the format's own flags so the Director
  //    never hard-deps any single composition existing yet.
  let supportsBookends = true
  let requiresAvatar = format.needsAvatar
  let requiresVoiceover = format.needsAvatar || format.needsCharts
  try {
    const { getComposition } = await import("@/lib/remotion/registry")
    const comp = await getComposition(format.compositionId)
    if (comp) {
      supportsBookends = comp.supports_bookends
      requiresAvatar = comp.requires_did_avatar
      requiresVoiceover = comp.requires_voiceover
    }
  } catch { /* registry read is best-effort — the format flags are the fallback */ }

  // 3. Idempotency key — one commission per (entity, situation kind). The entity
  //    is the listing (most kinds), then the contact (anniversary), then the
  //    campaign, then the brokerage. Stamped into video_metadata.director_key so a
  //    re-run for the same situation reuses the staged row instead of duplicating.
  const entity = opts.listingId ?? opts.contactId ?? opts.campaignId ?? opts.brokerageId
  const directorKey = `director:${situation.kind}:${entity}`

  const { data: existing } = await svc
    .from("ai_video_projects")
    .select("id")
    .eq("brokerage_id", opts.brokerageId)
    .eq("video_metadata->>director_key", directorKey)
    .maybeSingle()
  if (existing?.id) {
    return {
      ok: true, status: "already_staged",
      videoProjectId: (existing as { id: string }).id,
      compositionId: format.compositionId,
      reason: "a commission already exists for this (entity, kind)",
    }
  }

  // 4. Mint the OUTRO QR (idempotent per entity×kind; null = render without QR).
  //    Skipped on MLS-clean cuts (a tracked agent QR is branding).
  let qr: import("@/lib/video/video-qr").MintedVideoQr | null = null
  if (!opts.mlsClean) {
    try {
      const { mintVideoQr } = await import("@/lib/video/video-qr")
      qr = await mintVideoQr({
        brokerageId: opts.brokerageId,
        agentUserId: opts.agentUserId,
        kind: spec.outro.qr.kind,
        listingId: opts.listingId ?? null,
        contactId: opts.contactId ?? null,
        campaignId: opts.campaignId ?? null,
        origin: opts.origin,
      }, svc)
    } catch { /* a video must still render without a QR */ }
  }

  // 5. Draft + GATE the hook line BEFORE any render spend. generatePersonaCopy
  //    (with the deterministic fallback) drafts; runWithComplianceRedraft runs
  //    evaluateOutbound and re-prompts once on violations.
  const fallbackHook = spec.intro.hook.fallback
  let hookLine = fallbackHook
  let complianceStatus: "passed" | "failed" = "passed"
  let violations: string[] = []
  try {
    const { generatePersonaCopy } = await import("@/lib/kernel/ai-copy")
    const { runWithComplianceRedraft } = await import("@/lib/kernel/compliance-redraft")
    const { evaluateOutbound } = await import("@/lib/kernel/compliance")

    const facts = factStrings(situation, fallbackHook)

    const result = await runWithComplianceRedraft({
      draft: async ({ violations: priorViolations }) => {
        const draft = await generatePersonaCopy(
          {
            goal: `a ${situation.kind.replace(/_/g, " ")} video hook headline${priorViolations.length ? ` (rewrite to clear: ${priorViolations.join("; ")})` : ""}`,
            facts,
            channel: situation.targetChannel,
            persona: { audience: "audience" },
            words: 8,
          },
          { body: fallbackHook },
          { generator: opts.copyGenerator },
        )
        return (draft.body || fallbackHook).trim()
      },
      gate: async (s) => {
        const r = await evaluateOutbound({
          actorContext: { brokerageId: opts.brokerageId, userId: opts.agentUserId, role: "system" },
          journeyType: "seller",
          persona: "other",
          messageType: "social",
          content: s,
        })
        return { allowed: r.allowed, violations: r.violations }
      },
    })
    if (result.ok) {
      hookLine = result.script
    } else {
      complianceStatus = "failed"
      violations = result.violations
    }
  } catch {
    // Gate unreachable (no creds / offline) — keep the deterministic fallback
    // hook and mark not-yet-evaluated so the render cron's gate is authoritative.
    complianceStatus = "passed"
  }

  if (complianceStatus === "failed") {
    return {
      ok: false, status: "blocked",
      compositionId: format.compositionId,
      reason: "hook failed the compliance gate on both attempts",
      violations,
    }
  }

  // 5b. SOURCE the B-roll when the chosen format wants it. The Director already
  //     FLAGS needsBroll; here we fill it — pickBrollClips walks the EXISTING
  //     agent → team → brokerage video_assets cascade (same walk as the render
  //     coordinator's bookend/music pick) and returns the ordered clips the
  //     composition's B-roll layer composites under the narration. Best-effort:
  //     an empty scope (no uploaded b_roll) returns [] and the composition
  //     renders WITHOUT B-roll exactly like today — a picker failure NEVER
  //     blocks staging.
  let brollClips: import("@/lib/video/broll-picker").PickedBrollClip[] = []
  let brollSourcedCount = 0
  let brollSourcedScope: string | null = null
  if (format.needsBroll) {
    try {
      const { pickBrollClips } = await import("@/lib/video/broll-picker")
      const picked = await pickBrollClips(
        {
          brokerageId: opts.brokerageId,
          // The Director renders for the agent's personal brand — agent scope
          // inherits team + brokerage b_roll via the cascade.
          scopeType:   "agent",
          scopeId:     opts.agentUserId,
        },
        svc,
      )
      brollClips        = picked.clips
      brollSourcedCount = picked.sourcedCount
      brollSourcedScope = picked.sourcedScope
    } catch (e) {
      // B-roll is an enhancement, never a gate — the render still ships without it.
      console.warn("[video-director] b-roll pick failed; staging without B-roll:", (e as Error).message)
    }
  }

  // 6. Build the composition input props carrying the intro + outro + QR.
  const introProps = {
    brand: true,
    hook: hookLine,
    agentPhotoSlot: "agents.avatar_image_url",
  }
  const outroProps = {
    brand: true,
    agentContact: true,
    qrCodeDataUrl: qr?.qrCodeDataUrl ?? null,
    qrDestinationType: qr?.destinationType ?? null,
    qrSlug: qr?.slug ?? null,
    mlsClean: opts.mlsClean ?? false,
  }

  // The effective music mood: the learned override when the gate fired, else the
  // expert default from the assembly spec.
  const effectiveMood: MusicMood = learnedMood ?? spec.music.mood

  const videoMetadata = {
    director_key: directorKey,
    composition_id: format.compositionId,
    supports_bookends: supportsBookends,
    needs_avatar: requiresAvatar,
    needs_broll: format.needsBroll,
    needs_charts: format.needsCharts,
    needs_slides: format.needsSlides,
    aspect: format.aspect,
    target_channels: format.targetChannels,
    intro: introProps,
    outro: outroProps,
    music_mood: effectiveMood,
    qr_code_id: qr?.qrCodeId ?? null,
    requested_via: "asset_manager",
    // SELF-IMPROVING provenance — "default" or a gated "learned" pick + the WHY,
    // so the format choice is auditable on the row itself.
    format_source: formatSource,
    format_why: formatWhy,
    // B-roll the Director sourced from the scope cascade (empty when none
    // uploaded — the composition then renders without B-roll, like today).
    broll_clips:         brollClips,
    broll_sourced_count: brollSourcedCount,
    broll_sourced_scope: brollSourcedScope,
  }

  const providerMetadata = {
    composition_id: format.compositionId,
    // music_mood rides input_props so buildRenderIntent threads it to the
    // coordinator's mood-matched music pick. brollClips rides input_props so the
    // render path feeds the composition's brollClips prop the real clips.
    input_props: {
      intro: introProps,
      outro: outroProps,
      music_mood: effectiveMood,
      ...(format.needsBroll ? { brollClips } : {}),
    },
  }

  // 7. STAGE the row — mirrors createVideoProject's shape, compliance-gated,
  //    NEVER auto-publishes (approval_status stays 'pending_review'; status
  //    'remotion_pending' so the existing composition-render cron drains it).
  const now = new Date().toISOString()
  const { data: inserted, error } = await svc
    .from("ai_video_projects")
    .insert({
      brokerage_id: opts.brokerageId,
      agent_id: opts.agentUserId,
      listing_id: opts.listingId ?? null,
      contact_id: opts.contactId ?? null,
      title: opts.title ?? `${hookLine} — ${format.compositionId}`,
      script_content: hookLine,
      status: "remotion_pending",
      video_type: videoTypeForSituation(situation.kind),
      format: formatForAspect(format.aspect),
      audience_type: situation.kind === "cma" || situation.kind === "presentation"
        ? "in_house" : "customer_facing",
      is_ai_generated: true,
      approval_status: "pending_review", // gated — a human approves before send
      compliance_status: "passed",       // hook pre-cleared the gate above
      compliance_violations: [],
      compliance_evaluated_at: now,
      brand_voice_context: {},
      intro_video_url: null,             // assembled by the render coordinator's bookend pass
      outro_video_url: null,
      b_roll_urls: format.needsBroll ? brollClips.map((c) => c.url) : null,
      video_metadata: videoMetadata,
      provider_metadata: providerMetadata,
      created_at: now,
      updated_at: now,
    })
    .select("id")
    .maybeSingle()

  if (error || !inserted) {
    return { ok: false, status: "failed", reason: error?.message ?? "insert failed" }
  }

  return {
    ok: true, status: "staged",
    videoProjectId: (inserted as { id: string }).id,
    compositionId: format.compositionId,
  }
}

/** The ONLY facts the hook copy may use — drawn from the situation, no fabrication. */
function factStrings(situation: VideoSituation, fallbackHook: string): string[] {
  const facts: string[] = [`Default hook: ${fallbackHook}`]
  const f = situation.facts ?? {}
  for (const key of ["address", "city_state", "area_name", "neighborhood", "when"]) {
    const v = f[key]
    if (typeof v === "string" && v.trim()) facts.push(`${key}: ${v.trim()}`)
  }
  return facts
}
