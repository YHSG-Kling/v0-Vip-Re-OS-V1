/**
 * lib/video/assembly-timeline.ts
 *
 * THE SHARED intro → body → outro SPLIT — one formula, not a fifteenth
 * hand-rolled copy of it (§6, one vocabulary per function).
 *
 * ── WHAT WAVE 48's ASSEMBLY AUDIT FOUND ─────────────────────────────────────
 * Every video-shaped composition in remotion/Root.tsx (23 of the 33 registered
 * — the rest are 1-frame stills) already splits its own timeline into a brand
 * intro, a body, and a branded/CTA outro, and — checked composition by
 * composition against COMPOSITION_GEOMETRY
 * (lib/remotion/composition-geometry.ts) — every one of them sums EXACTLY to
 * its registered duration_frames with no gap and no overrun. That is a real,
 * verified finding (scripts/video-assembly-simulator.ts §sums), not an
 * assumption this file makes.
 *
 * What was NOT shared was the FORMULA. Most compositions hardcode three
 * literal frame constants (COVER/BODY/OUTRO, or COVER/BODY/CTA, or
 * INTRO/BODY/OUTRO — three spellings of the same idea) that happen to sum to
 * the registered duration because someone did the arithmetic by hand and
 * test:remotion-setup would catch a drift from Root.tsx. PhotoWalkthroughReel
 * was the one exception — it already DERIVES its split from
 * `useVideoConfig().durationInFrames` instead of a literal, because it has to:
 * the same component renders at whatever duration a future registration gives
 * it. That derivation is the shape every future avatar/voiceover-driven
 * composition needs, so it moves here rather than staying inlined where only
 * PhotoWalkthroughReel could reach it.
 *
 * PURE. No Remotion import (importable from both `remotion/**` components and
 * `lib/**` producers/proofs), no I/O, no server-only.
 */

export interface AssemblyTimelineInput {
  /** The registered composition length — `useVideoConfig().durationInFrames`
   *  inside a component, or `COMPOSITION_GEOMETRY[id].duration_frames`
   *  (lib/remotion/composition-geometry.ts) outside one. */
  durationInFrames: number
  /** Requested intro length, in frames. Clamped — see `computeAssemblyTimeline`. */
  introFrames: number
  /** Requested outro length, in frames. Clamped — see `computeAssemblyTimeline`. */
  outroFrames: number
}

export interface AssemblySegment {
  from: number
  durationInFrames: number
}

export interface AssemblyTimeline {
  intro: AssemblySegment
  body: AssemblySegment
  outro: AssemblySegment
  /** Convenience — intro.durationInFrames + body.durationInFrames +
   *  outro.durationInFrames. Always equals the clamped total, never the raw
   *  `durationInFrames` input when that input was non-positive (see below). */
  totalFrames: number
}

/**
 * Clamp requested intro/outro lengths so BOTH invariants this whole module
 * exists to keep hold no matter what a caller asks for:
 *   · every segment's durationInFrames is >= 1 (a zero-length Sequence is a
 *     gap the render pipeline treats as nothing, not as "skip this segment"),
 *   · intro + body + outro === durationInFrames EXACTLY — no gap, no overrun.
 *
 * The body absorbs whatever intro/outro do NOT claim, floored at 1 frame.
 * When the requested intro+outro would leave less than 1 frame for the body
 * (a pathologically short registration, or a caller asking for more chrome
 * than the composition has room for), intro and outro are scaled down
 * proportionally so the body still gets its 1 frame — a still composition
 * degrading gracefully, never silently rendering an impossible split.
 */
export function computeAssemblyTimeline(input: AssemblyTimelineInput): AssemblyTimeline {
  const total = Number.isFinite(input.durationInFrames) && input.durationInFrames > 0
    ? Math.floor(input.durationInFrames)
    : 1

  let intro = Math.max(0, Math.floor(input.introFrames || 0))
  let outro = Math.max(0, Math.floor(input.outroFrames || 0))

  // Cap requests that would leave no room for a body at all — scale both down
  // proportionally rather than favoring one over the other, and always leave
  // the body at least 1 frame.
  const chrome = intro + outro
  if (chrome > total - 1) {
    const scale = chrome > 0 ? (total - 1) / chrome : 0
    intro = Math.floor(intro * scale)
    outro = Math.floor(outro * scale)
  }

  const body = Math.max(1, total - intro - outro)
  // Re-derive outro from what's left so the three ALWAYS sum to `total`
  // exactly, even after the floor()s above could have dropped a frame or two.
  const outroFinal = Math.max(0, total - intro - body)

  return {
    intro: { from: 0, durationInFrames: intro },
    body: { from: intro, durationInFrames: body },
    outro: { from: intro + body, durationInFrames: outroFinal },
    totalFrames: intro + body + outroFinal,
  }
}

/**
 * A generic "divide the body evenly across N shots" deriver — the idiom
 * JustListedReel/Square/Horizontal, JustSoldReelSquare and
 * OpenHouseAnnounceReel each hand-roll as `windowFrames / images.length`.
 * Extracted here as the ONE spelling for compositions that want an even split
 * rather than the measured-duration tiling `lib/video/broll-plan.ts`
 * (`selectBrollPlan`) and `remotion/_BrollLayer.tsx` (`brollSlots`) already
 * own for B-roll with KNOWN clip lengths.
 *
 * `shotCount` is clamped to >= 1 (a "0 shots" request is nonsensical — there is
 * always at least one slot, even if the caller has nothing to put in it; the
 * COMPOSITION decides what an empty slot renders, this only decides how many
 * frames it gets). FALLBACK CONTRACT: when `shotCount` exceeds the number of
 * assets a caller actually has, the caller loops or fills the remainder with
 * its own honest empty state — this function only ever hands back N frame
 * windows, one per requested shot; it does not know or care whether an asset
 * exists for each one.
 *
 * PURE.
 */
export function evenShotSlots(bodyFrames: number, shotCount: number): AssemblySegment[] {
  const total = Number.isFinite(bodyFrames) && bodyFrames > 0 ? Math.floor(bodyFrames) : 0
  const n = Math.max(1, Math.floor(shotCount || 1))
  if (total <= 0) return []

  const slots: AssemblySegment[] = []
  let cursor = 0
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1
    // Even division with the remainder absorbed by the LAST slot — the same
    // "tile exactly, no drift" rule brollSlots/selectBrollPlan already prove;
    // this is the integer-frame-domain version of the same idea for a caller
    // that has no per-clip durations to bound by, only a count.
    const end = isLast ? total : Math.round(((i + 1) * total) / n)
    slots.push({ from: cursor, durationInFrames: Math.max(1, end - cursor) })
    cursor = end
  }
  return slots
}
