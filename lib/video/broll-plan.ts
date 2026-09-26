/**
 * lib/video/broll-plan.ts
 *
 * THE B-ROLL TIMELINE MATH — pure, unit-agnostic, importable from BOTH the
 * server-side picker and the Remotion composition bundle.
 *
 * ── WHY THIS FILE EXISTS (§1: BUILD the missing half of the wire) ────────────
 *
 * TOMBSTONE: `selectBrollPlan`, `BrollSourceClip`, `BrollPlanEntry` and
 * `DEFAULT_CLIP_SECONDS` were declared in `lib/video/broll-picker.ts`
 * (lines 50-146 before this move). broll-picker.ts remains the SURVIVOR for
 * SOURCING clips — `pickBrollClips`, the video_assets scope cascade, the
 * Mediabunny duration probe — and re-exports every name below, so its existing
 * importer `scripts/broll-picker-simulator.ts` is unchanged.
 *
 * The math had to LEAVE broll-picker.ts because `remotion/_BrollLayer.tsx` now
 * needs it and cannot import that module: `pickBrollClips` does
 * `await import("@/lib/supabase/service")`, which Remotion's webpack bundler
 * resolves at build time and which is `server-only`. Copying the arithmetic into
 * the layer instead would have been the §6 defect this repo keeps paying for —
 * two spellings of "how a B-roll window is divided" — and that disagreement is
 * EXACTLY the finding this file closes:
 *
 *   broll-picker computed REAL per-clip durations, and the Video Director
 *   dropped them (`picked.plan` had no reader), so `_BrollLayer` divided its
 *   frame window EVENLY across N clips because it had nothing better to divide
 *   by. A clip SHORTER than its evenly-divided slot then plays past its own
 *   end, and past its end a `<Video>` HOLDS ITS LAST FRAME — a frozen still
 *   where the reel promised motion, reported as a successful render. The
 *   sibling defect (clips 2..N starting at the wrong source second) was closed
 *   2026-09-04 by scripts/broll-window-guard.ts, which published this one as
 *   its blind spot.
 *
 * ── UNIT-AGNOSTIC ON PURPOSE ────────────────────────────────────────────────
 *
 * Every number below is "one time unit". `pickBrollClips` calls it in SECONDS
 * (its clips are measured in seconds and its timeline is a duration).
 * `_BrollLayer` calls it in FRAMES — integers in, integers out — so the slots
 * tile the frame window EXACTLY: no rounding drift, no 1-frame gap that would
 * render black, no 1-frame overshoot past a clip's end. The field names keep
 * their `Seconds` suffix because that is the vocabulary every existing caller
 * and the stored `video_assets.duration_seconds` already use (§6 — one
 * spelling, even where one caller reads the unit as frames).
 *
 * PURE. No I/O, no `server-only`, no Supabase, no Remotion runtime.
 */

/** One clip in the ordered B-roll timeline plan. */
export interface BrollPlanEntry {
  /** The source clip URL. */
  url:             string
  /** When this clip starts in the composition's B-roll window. */
  startSeconds:    number
  /** How long this clip plays. NEVER more than the source clip's own length —
   *  that invariant is the entire point of the plan. (The final entry may be
   *  TRUNCATED further so the plan ends exactly at the timeline length.) */
  durationSeconds: number
  /** Index into the `clips` array handed to `selectBrollPlan`. The library
   *  LOOPS when it is shorter than the timeline, so several entries can share
   *  one source clip; this says which one without callers re-deriving it from
   *  the URL (two library entries may legitimately share a URL and differ only
   *  by caption, and a URL match would then pick the wrong caption). */
  sourceIndex:     number
  /** Optional caption carried through from the source clip. */
  caption?:        string
}

/** A library clip handed to selectBrollPlan — a URL + its (probed/stored)
 *  length. duration must be > 0; selectBrollPlan defends against bad input. */
export interface BrollSourceClip {
  url:             string
  durationSeconds: number
  caption?:        string
}

/** When a clip's true duration is unknown (no Mediabunny probe + no stored
 *  duration_seconds), assume this many seconds. Long enough that a single
 *  unknown clip can carry a short window, short enough that the loop logic
 *  still cycles a library of unknowns. */
export const DEFAULT_CLIP_SECONDS = 4

/**
 * selectBrollPlan — PURE. Sequence the supplied clips in order to fill exactly
 * `neededSeconds` of B-roll timeline.
 *
 *   · If `perClipSeconds` is supplied (> 0), every clip is shown for that long
 *     (capped to its own duration so we never ask a 3s clip to play 5s),
 *     looping the library until the timeline is full.
 *   · Otherwise each clip plays for its own duration.
 *   · LOOP: when the library is shorter than the timeline, the clips repeat
 *     from the top until the timeline is filled.
 *   · TRUNCATE: the final clip is clipped so the plan ends exactly at
 *     `neededSeconds` (never overruns).
 *
 * THE INVARIANT THE LAYER DEPENDS ON: every entry's `durationSeconds` is
 * `min(want, remaining)`, where `want` is itself `min(perClip, clip.duration)`
 * or `clip.duration`. So NO ENTRY EVER EXCEEDS ITS OWN CLIP'S LENGTH — which is
 * precisely what an even division cannot promise, and what
 * `scripts/broll-slot-guard.ts` asserts here and shows the even division
 * failing.
 *
 * Deterministic — same inputs, same ordered plan. Empty library or a
 * non-positive timeline returns [].
 */
export function selectBrollPlan(
  clips:         BrollSourceClip[],
  neededSeconds: number,
  perClipSeconds?: number,
): BrollPlanEntry[] {
  if (!Array.isArray(clips) || clips.length === 0) return []
  if (!(neededSeconds > 0)) return []

  // Normalize each source clip to a positive duration, remembering where it sat
  // in the CALLER's array so `sourceIndex` points at the caller's clip and not
  // at this filtered copy.
  const lib = clips
    .map((c, sourceIndex) => ({ c, sourceIndex }))
    .filter(({ c }) => c && typeof c.url === "string" && c.url.length > 0)
    .map(({ c, sourceIndex }) => ({
      url:      c.url,
      caption:  c.caption,
      sourceIndex,
      duration: c.durationSeconds > 0 ? c.durationSeconds : DEFAULT_CLIP_SECONDS,
    }))
  if (lib.length === 0) return []

  const plan: BrollPlanEntry[] = []
  let cursor = 0
  let i = 0
  // Hard cap on iterations so a degenerate input (e.g. all-zero perClip) can
  // never spin forever; the timeline is finite so this is only a guardrail.
  const maxEntries = 10_000

  while (cursor < neededSeconds - 1e-6 && plan.length < maxEntries) {
    const src = lib[i % lib.length]
    // How long this clip WANTS to play: a fixed per-clip beat (capped to the
    // clip's own length) or its full natural duration.
    const want = perClipSeconds && perClipSeconds > 0
      ? Math.min(perClipSeconds, src.duration)
      : src.duration
    // Truncate the final clip so the plan ends exactly at the timeline length.
    const remaining = neededSeconds - cursor
    const dur = Math.min(want, remaining)
    if (dur <= 1e-6) break

    plan.push({
      url:             src.url,
      startSeconds:    round3(cursor),
      durationSeconds: round3(dur),
      sourceIndex:     src.sourceIndex,
      ...(src.caption ? { caption: src.caption } : {}),
    })
    cursor += dur
    i += 1
  }

  return plan
}

/** Round to ms precision so the plan numbers are clean + comparable. Integer
 *  inputs — the frame-domain caller — pass through untouched. */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
