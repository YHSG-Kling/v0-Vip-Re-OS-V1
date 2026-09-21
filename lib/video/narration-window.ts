/**
 * lib/video/narration-window.ts
 *
 * THE FRAMES AN AVATAR-HOSTED COMPOSITION ACTUALLY PLAYS ITS NARRATION IN —
 * and the word budget derived from THAT window rather than from the whole
 * composition.
 *
 * ── THE DEFECT THIS CLOSES (lane 77D, per-type matrix §avatarOverrun) ───────
 * `narrationBudget(id, compositionSeconds(geo))` (lib/video/script-structure.ts)
 * sizes a script to the composition's WHOLE runtime with NARRATION_HEADROOM
 * off the top. That is exactly right for a voiceover-narrated reel: its root
 * `<Audio>` starts at frame 0 and keeps playing under the CTA tile, so the
 * whole duration is speakable. It is WRONG for an avatar-hosted reel, where
 * the D-ID track is mounted inside a BODY window that opens after a silent
 * COVER tile and is hard-cropped (`<Video trimAfter={BODY}>`, or the
 * AvatarPIP's last window) before the branding/CTA tile:
 *
 *   AgentTalkingHeadReel  420 frames → budget 11.2 s   BODY window 300 frames = 10.0 s
 *   MarketUpdateReel      480 frames → budget 12.8 s   STAT window 360 frames = 12.0 s
 *   EquityReportReel      540 frames → budget 14.4 s   STAT window 360 frames = 12.0 s
 *   AgentExplainerReel    540 frames → budget 14.4 s   B1+B2+B3   360 frames = 12.0 s
 *   ExplainerAnimReel     540 frames → budget 14.4 s   DIAGRAM    360 frames = 12.0 s
 *
 * lib/video/intro-video-reactor.ts's own header says "11.2 claimable seconds"
 * two lines above "BODY = 10s, so the agent was simply cut off mid-sentence":
 * a script written to the budget and read at exactly the average pace still
 * loses its last 1.2 s to the crop. The post-render measurement
 * (avatarDurationOverrunSeconds, tolerance 1 s) reports it after the client
 * already has the video. Sizing the script to the WINDOW is what prevents it.
 *
 * ── WHY A TABLE, AND WHY THAT IS NOT A LIE ──────────────────────────────────
 * The window is a literal in each composition's source (COVER/BODY/STAT
 * consts), the same way its total is a literal that lib/remotion/
 * composition-geometry.ts mirrors. This table is that mirror for the
 * narration window, and scripts/video-type-matrix-simulator.ts proves every
 * row equal to the window the composition itself declares on its
 * `<CaptionLayer visibleFromFrame hiddenFromFrame>` — the ONE place a
 * composition already says "real audio plays from here to here" — so a
 * re-timed composition fails CI here rather than silently re-opening the crop.
 * A composition absent from this table has no avatar window (voiceover-
 * narrated: the whole runtime is speakable) and falls back to the whole-
 * composition budget, byte-for-byte the prior behaviour.
 *
 * PURE. No I/O, no server-only, importable from proofs and producers alike.
 */
import { compositionSeconds, geometryFor } from "@/lib/remotion/composition-geometry"
import { narrationBudget, type NarrationBudget } from "@/lib/video/script-structure"

/** Composition-absolute [from, to) frames the avatar track plays in. */
export interface NarrationWindowFrames {
  from: number
  to: number
}

/**
 * The avatar-hosted compositions and their narration windows, in the frames
 * each composition's own source declares. Proven equal to the composition's
 * `<CaptionLayer visibleFromFrame/hiddenFromFrame>` by test:video-type-matrix.
 */
export const NARRATION_WINDOW_FRAMES: Record<string, NarrationWindowFrames> = {
  AgentTalkingHeadReel:  { from: 60, to: 360 }, // COVER 2s · BODY 10s · OUTRO 2s
  MarketUpdateReel:      { from: 60, to: 420 }, // COVER 2s · STAT×3 12s · CTA 2s
  EquityReportReel:      { from: 60, to: 420 }, // COVER 2s · STAT×3 12s · OUTRO 4s
  AgentExplainerReel:    { from: 90, to: 450 }, // COVER 3s · B1+B2+B3 12s · CTA 3s
  ExplainerAnimReel:     { from: 90, to: 450 }, // COVER 3s · DIAGRAM 12s · CTA 3s
  TeammateExplainerReel: { from: 75, to: 810 }, // INTRO 2.5s · BODY 24.5s · OUTRO 3s
}

/** Seconds the narration can actually be heard on `compositionId`: the
 *  avatar window when one is declared, else the whole runtime. 0 for an
 *  unregistered id (the caller must treat that as "cannot carry narration"). */
export function narrationWindowSeconds(compositionId: string): number {
  const geo = geometryFor(compositionId)
  if (!geo) return 0
  const win = NARRATION_WINDOW_FRAMES[compositionId]
  if (!win) return compositionSeconds(geo)
  const frames = Math.max(0, Math.min(geo.duration_frames, win.to) - Math.max(0, win.from))
  return frames / Math.max(1, geo.fps)
}

/**
 * The word budget for a script that will be SPOKEN BY THE AVATAR on
 * `compositionId` — narrationBudget's headroom applied to the window the
 * track is cropped to, never to frames the viewer will not hear. For a
 * composition with no declared window this equals the whole-composition
 * budget exactly, so voiceover-narrated callers are unaffected.
 */
export function narrationWindowBudget(compositionId: string): NarrationBudget {
  return narrationBudget(compositionId, narrationWindowSeconds(compositionId))
}
