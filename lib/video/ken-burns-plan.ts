/**
 * lib/video/ken-burns-plan.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE motion planner for the CINEMATIC photo→walkthrough reel
 * (remotion/PhotoWalkthroughReel.tsx). Turns a flat MLS photo set into a
 * MOVING property tour: each photo gets a Ken Burns move (scale + pan) over its
 * own frame window, with a cross-fade into the next photo — so a listing with
 * NO video still gets a scroll-stopping reel.
 *
 * This module is the deterministic, DB-free, React-free brain the Remotion
 * composition renders. The Video Director (a sibling agent owns
 * lib/video/video-director.ts — NOT edited here) selects this format; we expose
 * a clip plan it can reason over and the composition can render verbatim.
 *
 * Contract per photo clip:
 *   { url, fromFrame, durationFrames, startScale, endScale,
 *     panFromXY, panToXY, crossfadeFrames, roomLabel }
 *
 * Guarantees (proven by scripts/photo-walkthrough-simulator.ts):
 *   · Windows TILE the body timeline — consecutive clips overlap by exactly
 *     crossfadeFrames (the cross-fade), no gaps and no other overlap. The last
 *     clip ends exactly at totalFrames.
 *   · Pan directions ALTERNATE for variety (left↔right / up↕down cycle).
 *   · An oversized photo set is CAPPED to maxClips (sane clip count) so each
 *     clip keeps a watchable dwell; a tiny set is used as-is (no looping a
 *     single photo into a slideshow of itself unless asked).
 *   · Scale/pan bounds are SANE — no extreme zoom (startScale/endScale in
 *     [1.0, 1.12]) and pan offsets are a small % of frame, never off-screen.
 *   · HONEST empty: no photos → [] so the Director won't pick this format and
 *     the composition shows its fallback card.
 *
 * No DB, no React, no Remotion imports — unit-testable in isolation.
 */

export interface KenBurnsClip {
  /** Photo URL (our Supabase storage / MLS CDN). */
  url: string
  /** Absolute frame (within the body window) this clip's Img mounts. */
  fromFrame: number
  /** How many frames this clip is on screen (includes its trailing cross-fade). */
  durationFrames: number
  /** Scale at the clip's first frame (>= 1.0 so cover never letterboxes). */
  startScale: number
  /** Scale at the clip's last frame. */
  endScale: number
  /** Pan offset (%) of the frame at the clip start — [x, y]. */
  panFromXY: [number, number]
  /** Pan offset (%) of the frame at the clip end — [x, y]. */
  panToXY: [number, number]
  /** Cross-fade length into the NEXT clip (0 on the final clip). */
  crossfadeFrames: number
  /** Synthesized room/caption label (generic tour beat — never fabricated MLS data). */
  roomLabel: string
}

export interface KenBurnsOptions {
  /** Frames per second — used only to derive sane min/max dwell. Default 30. */
  fps?: number
  /** Hard cap on clips so a 60-photo dump becomes a watchable tour. Default 10. */
  maxClips?: number
  /** Cross-fade length between photos. Default 12 frames (0.4s @ 30fps). */
  crossfadeFrames?: number
  /** Optional caller-supplied captions (room labels) aligned to photo order. */
  captions?: (string | null | undefined)[]
  /** Max zoom delta — endScale never exceeds startScale + this. Default 0.08. */
  maxZoom?: number
}

/**
 * Generic room-tour beats. We do NOT have per-photo room metadata in
 * listing_media, so we narrate the WALK (not a fabricated room name): the cover
 * sets context and these caption the journey. Honest, brand-safe, never claims
 * a photo is a specific room it may not be.
 */
const TOUR_BEATS = [
  "Welcome home",
  "Step inside",
  "Room to gather",
  "Where the light lives",
  "Cook and connect",
  "Rest and recharge",
  "Made for mornings",
  "Step outside",
  "Room to grow",
  "Your next chapter",
] as const

/**
 * The four pan directions we cycle through for variety. Values are the
 * start/end offsets as a PERCENT of the frame; the composition translates by
 * these. Small magnitudes (<= 4%) keep the subject on-screen at every scale.
 */
const PAN_MOVES: { from: [number, number]; to: [number, number] }[] = [
  { from: [-3, 0], to: [3, 0] },   // pan right
  { from: [3, 0], to: [-3, 0] },   // pan left
  { from: [0, -3], to: [0, 3] },   // pan down
  { from: [0, 3], to: [0, -3] },   // pan up
]

function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * kenBurnsPlan — distribute `photos` across `totalFrames` as Ken Burns clips.
 *
 * @param photos       Ordered photo URLs (listing_media file_url, sort_order asc).
 * @param totalFrames  The BODY window length in frames (cover/outro are the
 *                     caller's responsibility — this plans only the photo tour).
 * @param opts         Tuning (fps, maxClips, crossfadeFrames, captions, maxZoom).
 * @returns            One KenBurnsClip per used photo; [] when there are no
 *                     photos OR totalFrames is non-positive (honest empty).
 */
export function kenBurnsPlan(
  photos: (string | null | undefined)[] | null | undefined,
  totalFrames: number,
  opts: KenBurnsOptions = {},
): KenBurnsClip[] {
  const fps = opts.fps && opts.fps > 0 ? opts.fps : 30
  const maxClips = opts.maxClips && opts.maxClips > 0 ? Math.floor(opts.maxClips) : 10
  const maxZoom = opts.maxZoom && opts.maxZoom > 0 ? Math.min(opts.maxZoom, 0.12) : 0.08

  // ── Honest empty ─────────────────────────────────────────────────────────
  // No photos (or a non-positive window) → []. The Director sees an empty plan
  // and never selects PhotoWalkthroughReel; the composition shows its fallback.
  const clean = (photos ?? []).map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean)
  if (clean.length === 0 || !Number.isFinite(totalFrames) || totalFrames <= 0) return []

  // ── Cap to a sane clip count ───────────────────────────────────────────────
  // An oversized set is truncated (not loop-padded) so every clip keeps a
  // watchable dwell. A small set is used as-is.
  const used = clean.slice(0, maxClips)
  const n = used.length

  // ── Cross-fade sizing ──────────────────────────────────────────────────────
  // Default ~0.4s. Never let the cross-fade swallow a clip: cap it to a third of
  // the average per-clip slot so each photo still gets a clear "hold".
  const avgSlot = totalFrames / n
  const requestedXfade =
    opts.crossfadeFrames !== undefined && opts.crossfadeFrames >= 0
      ? Math.floor(opts.crossfadeFrames)
      : Math.round(fps * 0.4)
  // With n clips and n-1 internal cross-fades, the visible timeline is
  // totalFrames = sum(duration) - (n-1)*xfade. Keep xfade < avgSlot/3 and < a
  // floor so a single-photo plan (n===1) just fills the window.
  const crossfade = n <= 1 ? 0 : clampNum(requestedXfade, 0, Math.max(0, Math.floor(avgSlot / 3)))

  // ── Tile the timeline ──────────────────────────────────────────────────────
  // We want the visible content to span exactly [0, totalFrames]. Each clip
  // (except the last) overlaps the next by `crossfade`. So:
  //   advance per clip = (totalFrames - crossfade) / n   (the "stride")
  //   clip i starts at  i * stride
  //   clip i duration   = stride + crossfade  (the final clip omits the trailing
  //                       fade and ends exactly at totalFrames)
  // This guarantees: no gaps, the only overlap is the intended cross-fade, and
  // clip[n-1].fromFrame + duration === totalFrames.
  const stride = (totalFrames - crossfade) / n

  const clips: KenBurnsClip[] = []
  for (let i = 0; i < n; i++) {
    const fromFrame = Math.round(i * stride)
    const isLast = i === n - 1
    // End frame: last clip lands exactly on totalFrames; others extend one
    // cross-fade past the next clip's start.
    const nextStart = isLast ? totalFrames : Math.round((i + 1) * stride)
    const endFrame = isLast ? totalFrames : nextStart + crossfade
    const durationFrames = endFrame - fromFrame

    // Alternate pan direction every clip for cinematic variety.
    const move = PAN_MOVES[i % PAN_MOVES.length]

    // Alternate the zoom polarity too (push in / pull out) so consecutive
    // photos don't feel mechanically identical. Both stay in [1.0, 1.0+maxZoom].
    const pushIn = i % 2 === 0
    const startScale = pushIn ? 1.0 : clampNum(1.0 + maxZoom, 1.0, 1.12)
    const endScale = pushIn ? clampNum(1.0 + maxZoom, 1.0, 1.12) : 1.0

    const captionOverride = opts.captions?.[i]
    const roomLabel =
      captionOverride && captionOverride.trim()
        ? captionOverride.trim()
        : TOUR_BEATS[i % TOUR_BEATS.length]

    clips.push({
      url: used[i],
      fromFrame,
      durationFrames,
      startScale,
      endScale,
      panFromXY: move.from,
      panToXY: move.to,
      crossfadeFrames: isLast ? 0 : crossfade,
      roomLabel,
    })
  }

  return clips
}
