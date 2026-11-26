/**
 * lib/video/pip-panel-split.ts
 *
 * THE NO-PLAN PANEL SPLITS of the three PiP compositions — PURE, BODY-relative
 * (frame 0 is the body's first frame, which is also the avatar track's own
 * timeline: the presenter first mounts at COVER). Wave 80C: the panels
 * normally come from the body-visual plan (lib/video/body-visual-model.ts
 * panelWindowsFromPlan); these are the fallbacks each composition keeps when
 * no plan is staged or it carries fewer than three beats.
 *
 * Here rather than in the compositions so that scripts/composition-segments.ts
 * (a Node-run proof) can reproduce each chain without importing a .tsx file
 * (which would drag @remotion/media into the proof), and so that
 * EquityReportReel and MarketUpdateReel share ONE thirds split (§6).
 */
import type { AssemblySegment } from "./assembly-timeline"

/** AgentExplainerReel's own 3:4:5 rhythm, tiling [0, BODY) exactly. */
export function explainerPanelSplit(BODY: number): AssemblySegment[] {
  const body = Math.max(3, Math.floor(BODY))
  const B1 = Math.round(body * 3 / 12)
  const B2 = Math.round(body * 4 / 12)
  const B3 = Math.max(1, body - B1 - B2)
  return [{ from: 0, durationInFrames: B1 }, { from: B1, durationInFrames: B2 }, { from: B1 + B2, durationInFrames: B3 }]
}

/** MarketUpdateReel's / EquityReportReel's thirds, the last panel absorbing the remainder, tiling [0, BODY) exactly. */
export function thirdsPanelSplit(BODY: number): AssemblySegment[] {
  const body = Math.max(3, Math.floor(BODY))
  const STAT = Math.floor(body / 3)
  return [{ from: 0, durationInFrames: STAT }, { from: STAT, durationInFrames: STAT }, { from: STAT * 2, durationInFrames: Math.max(1, body - STAT * 2) }]
}
