/**
 * lib/remotion/composition-geometry.ts
 *
 * THE GEOMETRY OF EVERY REGISTERED COMPOSITION, in one place, importable by
 * both the guards and the runtime.
 *
 * ── WHY THIS FILE EXISTS (§1 merge onto the survivor) ────────────────────────
 *
 * TOMBSTONE: the `REGISTRY` geometry snapshot was declared in
 * `scripts/remotion-setup-guard.ts` (line 147 before this move). It holds the
 * SAME facts the narration cap now needs — how many frames a composition runs
 * and at what fps — and `lib/**` cannot import from `scripts/**`:
 * remotion-setup-guard executes its whole check suite at module load, so
 * importing it from a producer would run the guard inside a render. Copying the
 * numbers into a second table would have been the §6 defect this repo keeps
 * paying for, so the TABLE moved here and the guard imports it back. The guard
 * is still the only thing that PROVES it — it compares every field against
 * remotion/Root.tsx (what actually renders).
 *
 * `parseRootCompositions` deliberately did NOT move: reading Root.tsx as text is
 * something only the guard ever needs, and an export in `lib/**` whose only
 * caller is a proof is an orphan (§1). It stays in the guard, beside the
 * comparison it feeds.
 *
 * ── WHY THE TABLE IS STATIC, AND WHY THAT IS NOT A LIE ──────────────────────
 *
 * Composition geometry is not tenant data. It is a literal in Root.tsx, mirrored
 * into `remotion_compositions` (m168) and proven equal by test:remotion-setup.
 *
 * READ THAT CLAIM PRECISELY, because it used to be half of one. test:remotion-setup
 * §2-3 prove ROOT.TSX == THIS FILE. They cannot, in CI, prove THIS FILE == the
 * LIVE `remotion_compositions` rows, which is the copy the render cache key, the
 * m313 narration pad and the still/moving fork read at runtime — so an edit made
 * directly to the table would drift from here with every assertion still green.
 * §3b now makes that comparison whenever SUPABASE_SERVICE_ROLE_KEY is present and
 * SAYS IT SKIPPED otherwise; it never reports a comparison it did not make.
 * Hand-verified against hrvaqgvukzxfskkcrwbt on 2026-08-28: 33 rows, four
 * geometry fields each, zero drift on all three copies.
 * A narration cap derived from it must be computable with NO I/O:
 *   · the deterministic section-narration fallback runs when the AI is down —
 *     a cap that needed a network hop would be unavailable exactly then, and a
 *     cap that "fails open" is the gate that reports "checked and fine" when
 *     nobody checked (§4);
 *   · the cap is exercised by pure unit proofs, which have no database.
 * Callers holding a LIVE `remotion_compositions` row should pass it to
 * `compositionSeconds` directly — the shape is the row's shape for exactly that
 * reason. `geometryFor` is the fallback for callers that have only an id.
 *
 * PURE. No I/O, no server-only, no Supabase.
 */

/**
 * Width, height, fps and frame count of one registered composition.
 *
 * SNAKE-CASED because it mirrors the `remotion_compositions` ROW, so a live row
 * from `lib/remotion/registry.ts` can be handed to `compositionSeconds`
 * unchanged. Deliberately NOT `CompositionGeometry` from
 * `lib/remotion/composition-cache.ts`: that one is the camelCase cache-key
 * shape (`durationFrames`), a different vocabulary for a different consumer.
 */
export interface RegisteredGeometry {
  width: number
  height: number
  fps: number
  duration_frames: number
}

/**
 * The live registry, snapshotted. Regenerate with:
 *   select json_object_agg(composition_id, json_build_object(
 *     'width',width,'height',height,'fps',fps,'duration_frames',duration_frames))
 *   from remotion_compositions;
 *
 * Proven field-for-field against remotion/Root.tsx by test:remotion-setup §3.
 */
export const COMPOSITION_GEOMETRY: Record<string, RegisteredGeometry> = {
  AffordabilitySnapshotReel: { width: 1080, height: 1080, fps: 30, duration_frames: 450 },
  AgentExplainerReel: { width: 1080, height: 1080, fps: 30, duration_frames: 540 },
  AgentTalkingHeadReel: { width: 1080, height: 1080, fps: 30, duration_frames: 420 },
  BuyerConsultationSlide: { width: 1920, height: 1080, fps: 30, duration_frames: 180 },
  CMAReel: { width: 1080, height: 1080, fps: 30, duration_frames: 720 },
  CarouselSlide: { width: 1080, height: 1350, fps: 30, duration_frames: 1 },
  ComingSoonReel: { width: 1080, height: 1080, fps: 30, duration_frames: 360 },
  DoorHanger: { width: 1350, height: 3375, fps: 30, duration_frames: 1 },
  EquityReportReel: { width: 1080, height: 1080, fps: 30, duration_frames: 540 },
  ExplainerAnimReel: { width: 1080, height: 1080, fps: 30, duration_frames: 540 },
  JustListedReel: { width: 1080, height: 1920, fps: 30, duration_frames: 750 },
  JustListedReelHorizontal: { width: 1920, height: 1080, fps: 30, duration_frames: 600 },
  JustListedReelSquare: { width: 1080, height: 1080, fps: 30, duration_frames: 360 },
  JustSoldReelSquare: { width: 1080, height: 1080, fps: 30, duration_frames: 360 },
  LeadMagnetCard: { width: 1200, height: 630, fps: 30, duration_frames: 1 },
  ListingFlyer: { width: 2625, height: 3375, fps: 30, duration_frames: 1 },
  ListingPresentationSlide: { width: 1920, height: 1080, fps: 30, duration_frames: 180 },
  ListingSectionReel: { width: 1920, height: 1080, fps: 30, duration_frames: 900 },
  MarketUpdateReel: { width: 1080, height: 1080, fps: 30, duration_frames: 480 },
  NeighborhoodSpotlightReel: { width: 1080, height: 1080, fps: 30, duration_frames: 480 },
  NewsletterDigestThumb: { width: 1200, height: 630, fps: 30, duration_frames: 1 },
  NewsletterDigestVideo: { width: 1080, height: 1920, fps: 30, duration_frames: 600 },
  OpenHouseAnnounceReel: { width: 1080, height: 1080, fps: 30, duration_frames: 360 },
  PartnersMeetingReel: { width: 1920, height: 1080, fps: 30, duration_frames: 900 },
  PhotoWalkthroughReel: { width: 1080, height: 1080, fps: 30, duration_frames: 600 },
  PostcardBack4x6: { width: 1275, height: 1875, fps: 30, duration_frames: 1 },
  PostcardBack6x9: { width: 1875, height: 2775, fps: 30, duration_frames: 1 },
  PostcardFront4x6: { width: 1275, height: 1875, fps: 30, duration_frames: 1 },
  PostcardFront6x9: { width: 1875, height: 2775, fps: 30, duration_frames: 1 },
  ProductPromoReel: { width: 1080, height: 1920, fps: 30, duration_frames: 450 },
  TeammateExplainerReel: { width: 1080, height: 1080, fps: 30, duration_frames: 900 },
  TestimonialReel: { width: 1080, height: 1080, fps: 30, duration_frames: 420 },
  VideoCoverThumb: { width: 1200, height: 630, fps: 30, duration_frames: 1 },
}

/**
 * How many seconds of output a composition produces.
 *
 * THE ONE duration computation (§6). `lib/remotion/registry.ts`
 * (estimateCompositionCost), `lib/remotion/render-coordinator.ts` (the m313
 * narration pad) and `lib/remotion/render-cache.ts` (secondsAvoided) each had
 * their own copy of `duration_frames / fps`; they now all call this. The
 * `Math.max(1, fps)` floor comes from the coordinator's copy — a zero fps in a
 * drifted row must not produce Infinity seconds and a pad of `maxPadSeconds`.
 */
export function compositionSeconds(g: { duration_frames: number; fps: number }): number {
  const frames = Number(g?.duration_frames)
  const fps = Number(g?.fps)
  if (!Number.isFinite(frames) || frames <= 0) return 0
  return frames / Math.max(1, Number.isFinite(fps) ? fps : 0)
}

/** Geometry for a composition id, or null when the id is not registered. */
export function geometryFor(compositionId: string): RegisteredGeometry | null {
  return COMPOSITION_GEOMETRY[compositionId] ?? null
}
