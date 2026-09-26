/**
 * lib/video/narration-window.ts
 *
 * THIN ADAPTER over lib/video/duration-model.ts — kept because two producers
 * (lib/video/intro-video-reactor.ts, lib/video/avatar-explainer.ts) and the
 * proofs call `narrationWindowBudget` / `narrationWindowSeconds` by name.
 *
 * TOMBSTONE (wave 78, lane 78C): `NARRATION_WINDOW_FRAMES` — a hand table of
 * six avatar-hosted compositions' body windows at their FIXED registered
 * duration ({ from: 60, to: 360 } for AgentTalkingHeadReel, and five more) —
 * stood here from lane 77D until 2026-09-22. It mirrored literals inside each
 * composition's source, and the owner's ruling ("you hardcoded the length of
 * the video body for each video, what happens with any new videos…") is
 * exactly the shape it was: a new composition needed a new row and nothing
 * said what its length was FOR. The survivor is lib/video/duration-model.ts:
 *   · the window is DERIVED — narrationWindowFrames(id, durationInFrames) =
 *     [intro, total − outro) from the composition's registered bookends
 *     (COMPOSITION_DURATION_RULES) and whatever duration the render actually
 *     has (planCompositionDuration → Root.tsx calculateMetadata);
 *   · the word budget comes from the video's PURPOSE (purposeBudgetFor):
 *     min / ideal / max seconds × the host's pace, capped by the registered
 *     geometry and the provider limits — not from a table of frames.
 * scripts/video-type-matrix-simulator.ts, which proved the table equal to each
 * composition's CaptionLayer window, now proves the DERIVATION equal to it at
 * the registered cap and at a planned duration.
 *
 * PURE. No I/O.
 */
import { geometryFor } from "@/lib/remotion/composition-geometry"
import { narrationBudget, type NarrationBudget } from "@/lib/video/script-structure"
import { capBodySeconds, compositionDurationSpec, purposeBudgetFor } from "@/lib/video/duration-model"

/**
 * Seconds of narration a composition can HOLD between its bookends at its
 * registered cap: the derived window, not a table row. 0 for an unregistered
 * id (the caller must treat that as "cannot carry narration"). A composition
 * with no duration rule falls back to its whole runtime — the prior
 * whole-composition behaviour, byte-for-byte.
 */
export function narrationWindowSeconds(compositionId: string): number {
  const geo = geometryFor(compositionId)
  if (!geo) return 0
  if (!compositionDurationSpec(compositionId)) return geo.duration_frames / Math.max(1, geo.fps)
  return capBodySeconds(compositionId) ?? 0
}

/**
 * The word budget for a script that will be SPOKEN on `compositionId` — the
 * purpose-derived budget (floor + ceiling at the host's pace, inside the
 * registered cap and the provider caps). A composition with no purpose row
 * gets the whole-composition budget, so an unregistered caller is unaffected.
 */
export function narrationWindowBudget(compositionId: string): NarrationBudget {
  if (!compositionDurationSpec(compositionId)) return narrationBudget(compositionId, narrationWindowSeconds(compositionId))
  return purposeBudgetFor(compositionId)
}
