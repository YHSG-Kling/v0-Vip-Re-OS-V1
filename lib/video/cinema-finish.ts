// lib/video/cinema-finish.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CINEMA FINISH — one layer every moving composition inherits (wave 82, 82C).
//
// OWNER (2026-09-25, verbatim): "the videos need to be a completely finished and
// very smooth cinema quality production as the end product."
//
// What "finished" means here is decided ONCE, by rule, from registries that
// already exist — never per reel, never by hand timing:
//
//   · WHICH compositions get it      → lib/video/finish-spec.ts (a STILL — a
//     postcard, a flyer, a thumbnail — is a print/card deliverable and is never
//     graded or faded).
//   · THE LOOK (a subtle grade)      → the composition's first served PURPOSE
//     (lib/video/duration-model.ts compositionPurposes). Screens are never graded
//     (a product demo shows a UI whose colours must stay true); a keepsake is
//     warmed; everything else gets the "natural" listing look — brighter, a touch
//     of contrast and saturation, no colour cast (fotober 2025-07 / beatcolor
//     2025-11 / blurit 2026-04: "bright, natural, consistent … most homes benefit
//     from restraint"; misrepresenting the space is the line not to cross).
//   · THE CUT POINTS                 → the body-visual PLAN's own segment
//     boundaries when one was staged (lib/video/body-visual-model.ts
//     fitBodyVisualPlan), else the composition's registered bookends
//     (compositionBookends). A soft eased DIP through the brand colour sits on
//     each cut — an OVERLAY, which the vendored remotion skill
//     (remotion-markup/transitions.md) documents as "render an effect on top of
//     the cut point without shortening the timeline". The registered geometry,
//     the render cache and the narration pad all key on the timeline, so an
//     overlapping TransitionSeries (which SHORTENS it) is not an option; and
//     @remotion/transitions is not installed (package.json) — see
//     remotion/components/SceneFade.tsx for the same reasoning, recorded first.
//   · CUT LENGTH                     → peachgum 2026-04: "transitions that last
//     about 6–12 frames for snap without whiplash", "keep duration under 12
//     frames" for pushes; a keepsake breathes longer. Expressed in SECONDS and
//     converted with the render's fps, so a 60 fps render keeps the same feel.
//   · HEAD / TAIL                    → the picture fades IN from and OUT to the
//     BRAND colour, never black — no hard cut on black at either edge, and the
//     stitched stock bookend (render-coordinator) meets a brand field.
//   · J / L CUTS                     → a cut that lands INSIDE the narration
//     window keeps the voice running while the picture changes (the L-cut / J-cut
//     feel: sound bridges the cut). The dip is lighter there so the picture never
//     "blinks" under a sentence; a cut outside the voice gets the fuller dip.
//   · EASING                         → one set of curves for every move
//     (remotion-markup/timing.md: `Easing.bezier(0.16, 1, 0.3, 1)` enter — the
//     decelerating curve the skill pairs with `Easing.spring({damping: 200})`).
//   · TYPOGRAPHY + SAFE AREAS        → one modular scale from the frame's short
//     side; safe insets from the ONE survivor (body-visual-model safeInsets).
//   · AUDIO MASTER                   → lib/remotion/music-filter-graph.ts
//     MASTER_LOUDNESS (-14 LUFS integrated, -1 dBTP) + music fades derived from
//     the composition's own intro/outro lengths (the bed swells under the cover
//     card and resolves across the outro — the L-cut on the music).
//
// PURE. No React, no I/O — remotion/components/CinemaFinish.tsx renders it and
// scripts/cinema-finish-guard.ts proves it.

import { finishForVideo, type VideoFinish } from "./finish-spec"
import { compositionBookends, compositionPurposes, type VideoPurpose } from "./duration-model"
import { COMPOSITION_TREATMENTS, safeInsets, type BodyTreatment, type BodyVisualPlan, type SafeInsets } from "./body-visual-model"
import { DEFAULT_MUSIC_FADE_IN_SECONDS, DEFAULT_MUSIC_FADE_OUT_SECONDS } from "../remotion/music-filter-graph"

// ── § EASING — one set of curves ────────────────────────────────────────────

/** Cubic-bezier control points (remotion `Easing.bezier(...points)`). */
export const CINEMA_EASING = {
  /** Decelerate into rest — entrances, fade-ins (remotion-markup/timing.md). */
  enter: [0.16, 1, 0.3, 1] as const,
  /** Accelerate away — exits, fade-outs. */
  exit: [0.7, 0, 0.84, 0] as const,
  /** Symmetric — the dip's rise and fall across a cut. */
  inOut: [0.65, 0, 0.35, 1] as const,
}


// ── § LOOK — a subtle grade ──────────────────────────────────────────────────

export interface CinemaLook {
  id: "natural" | "warm" | "true_color"
  contrast: number
  saturate: number
  brightness: number
  /** 0-1 sepia used as a warmth trim (a CSS-filter stand-in for a LUT's white-balance shift). */
  warmth: number
  /** 0-1 edge darkening (radial). */
  vignette: number
}

/** Every value stays within ±8 % of identity — a grade, never a filter effect. */
export const CINEMA_LOOKS: Record<CinemaLook["id"], CinemaLook> = {
  natural:    { id: "natural",    contrast: 1.05, saturate: 1.06, brightness: 1.02, warmth: 0,    vignette: 0.16 },
  warm:       { id: "warm",       contrast: 1.03, saturate: 1.04, brightness: 1.02, warmth: 0.06, vignette: 0.2 },
  true_color: { id: "true_color", contrast: 1,    saturate: 1,    brightness: 1,    warmth: 0,    vignette: 0 },
}

/** The largest departure from identity any look may take (the proof holds every look to it). */
export const MAX_GRADE_DEPARTURE = 0.08

/** Purposes whose picture is a SCREEN (UI colour must stay true) or a keepsake (warmed). */
const TRUE_COLOR_PURPOSES: ReadonlySet<VideoPurpose> = new Set<VideoPurpose>(["product_demo"])
const WARM_PURPOSES: ReadonlySet<VideoPurpose> = new Set<VideoPurpose>(["memory"])

/** The CSS `filter` string for a look (identity → "none"). */
export function gradeFilter(look: CinemaLook): string {
  const parts: string[] = []
  if (look.contrast !== 1) parts.push(`contrast(${look.contrast})`)
  if (look.saturate !== 1) parts.push(`saturate(${look.saturate})`)
  if (look.brightness !== 1) parts.push(`brightness(${look.brightness})`)
  if (look.warmth > 0) parts.push(`sepia(${look.warmth})`)
  return parts.length ? parts.join(" ") : "none"
}

// ── § THE SPEC — derived per composition ─────────────────────────────────────

export interface CinemaFinishSpec {
  compositionId: string
  enabled: boolean
  /** Why enabled/disabled and which rule chose the look — printed by the proof. */
  reason: string
  purpose: VideoPurpose | null
  look: CinemaLook
  /** Seconds a cut's dip takes, rise + fall. */
  cutSeconds: number
  /** Peak dip opacity for a cut outside the narration / inside it (J/L cut). */
  dipPeak: number
  dipPeakUnderVoice: number
  headFadeSeconds: number
  tailFadeSeconds: number
}

/** A STILL is a card/print deliverable: no bookends, no music, no captions, no thumbnail. */
export function isStillFinish(f: VideoFinish): boolean {
  return !f.bookends && !f.music && !f.captions && !f.thumbnail && f.presenter === "none" && f.broll === "none"
}

/** 6-12 frames at 30 fps for a snappy cut (peachgum 2026-04); a keepsake breathes. */
function cutSecondsFor(purpose: VideoPurpose | null): number {
  if (purpose === "memory") return 0.6
  if (purpose === "listing_promo" || purpose === "photo_walkthrough" || purpose === "lead_reel") return 0.3
  return 0.4
}

export function cinemaFinishFor(compositionId: string, entityType?: string | null): CinemaFinishSpec {
  const finish = finishForVideo(compositionId, entityType)
  const purpose = compositionPurposes(compositionId)[0] ?? null
  if (isStillFinish(finish)) {
    return {
      compositionId, enabled: false, reason: "a still deliverable (finish-spec STILL) — no grade, no fades",
      purpose, look: CINEMA_LOOKS.true_color, cutSeconds: 0, dipPeak: 0, dipPeakUnderVoice: 0, headFadeSeconds: 0, tailFadeSeconds: 0,
    }
  }
  const look = purpose && TRUE_COLOR_PURPOSES.has(purpose) ? CINEMA_LOOKS.true_color
    : purpose && WARM_PURPOSES.has(purpose) ? CINEMA_LOOKS.warm
    : CINEMA_LOOKS.natural
  return {
    compositionId, enabled: true,
    reason: `moving video (${purpose ?? "no registered purpose"}) → ${look.id} look`,
    purpose, look,
    cutSeconds: cutSecondsFor(purpose),
    dipPeak: 0.45,
    dipPeakUnderVoice: 0.22,
    headFadeSeconds: 0.35,
    tailFadeSeconds: 0.5,
  }
}

// ── § CUT POINTS — from the plan, else the bookends ─────────────────────────

export interface CinemaCut {
  /** Composition-absolute frame where the picture changes. */
  frame: number
  kind: "intro_end" | "segment" | "outro_start"
  /** The cut lands inside the narration window — the voice bridges it (J/L cut). */
  underVoice: boolean
}

export function cinemaCutPoints(
  compositionId: string,
  durationInFrames: number,
  plan?: BodyVisualPlan | null,
): CinemaCut[] {
  const raw: Array<Omit<CinemaCut, "underVoice">> = []
  let voice: { from: number; to: number } | null = null
  if (plan && plan.durationInFrames === durationInFrames) {
    raw.push({ frame: plan.intro.from + plan.intro.durationInFrames, kind: "intro_end" })
    plan.segments.slice(1).forEach((s) => raw.push({ frame: s.from, kind: "segment" }))
    raw.push({ frame: plan.outro.from, kind: "outro_start" })
    voice = plan.captionWindow
  } else {
    const { introFrames, outroFrames } = compositionBookends(compositionId)
    if (introFrames > 0) raw.push({ frame: introFrames, kind: "intro_end" })
    if (outroFrames > 0) raw.push({ frame: durationInFrames - outroFrames, kind: "outro_start" })
  }
  const seen = new Set<number>()
  const out: CinemaCut[] = []
  for (const c of raw) {
    if (!(c.frame > 0 && c.frame < durationInFrames) || seen.has(c.frame)) continue
    seen.add(c.frame)
    out.push({ ...c, underVoice: voice ? c.frame > voice.from && c.frame < voice.to : false })
  }
  return out.sort((a, b) => a.frame - b.frame)
}

/** The inOut bezier evaluated at t (0..1) — pure, so the proof can check the dip shape without React. */
export function easeInOut(t: number): number {
  const x = Math.max(0, Math.min(1, t))
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

/** The dip opacity at a frame: a symmetric eased bell centred on every cut. */
export function dipOpacityAt(frame: number, cuts: readonly CinemaCut[], spec: CinemaFinishSpec, fps: number): number {
  if (!spec.enabled || cuts.length === 0) return 0
  const half = Math.max(1, Math.round((spec.cutSeconds * fps) / 2))
  let best = 0
  for (const c of cuts) {
    const d = Math.abs(frame - c.frame)
    if (d > half) continue
    const peak = c.underVoice ? spec.dipPeakUnderVoice : spec.dipPeak
    best = Math.max(best, peak * easeInOut(1 - d / half))
  }
  return best
}

/** Head and tail fades, in frames (never longer than a quarter of the video). */
export function edgeFadeFrames(spec: CinemaFinishSpec, fps: number, durationInFrames: number): { head: number; tail: number } {
  if (!spec.enabled) return { head: 0, tail: 0 }
  const cap = Math.max(1, Math.floor(durationInFrames / 4))
  return {
    head: Math.min(cap, Math.max(1, Math.round(spec.headFadeSeconds * fps))),
    tail: Math.min(cap, Math.max(1, Math.round(spec.tailFadeSeconds * fps))),
  }
}

// ── § MOTION BLUR — where the camera moves, never on a talking head ─────────
//
// WAVE 83 (owner: motion blur — https://www.remotion.dev/docs/motion-blur/).
// @remotion/motion-blur's <CameraMotionBlur> "produces natural looking motion
// blur similar to what would be produced by a film camera": it renders `samples`
// time-offset copies and averages them. The docs' own cautions set the rule:
//   · "shutterAngle … common values … 30 fps / 180° or 90°" → 180° (the film
//     standard) for a camera move;
//   · "samples … Recommended values: 5-10" and "the technique is destructive to
//     colors … keep the samples property as low as possible" → 5, the floor;
//   · it re-renders the subtree `samples` times → render cost ×samples, so it is
//     spent only where motion warrants it.
// WHERE, DERIVED from the body-visual registry (COMPOSITION_TREATMENTS), never a
// hand list: a composition whose picture MOVES AS A CAMERA — Ken Burns over
// property_photos (KenBurnsPhoto) or moving b-roll — gets it; a composition that
// can put a PERSON on screen (full_avatar / avatar_pip — a talking head, whose
// lips and eyes must stay crisp) or a SCREEN (true-colour look: UI must stay
// sharp and true) never does, and a still never does. The static card/text
// layers inside a moving composition are unaffected in practice: identical
// samples average to themselves.

/** Treatments whose picture moves like a camera (Ken Burns push, footage). */
const CAMERA_MOVE_TREATMENTS: ReadonlySet<BodyTreatment> = new Set<BodyTreatment>(["property_photos", "broll"])
/** Treatments that put a person on screen — kept crisp. */
const PERSON_TREATMENTS: ReadonlySet<BodyTreatment> = new Set<BodyTreatment>(["full_avatar", "avatar_pip"])

export interface CinemaMotionBlur {
  enabled: boolean
  /** Degrees; 180 = the film standard at 24-60 fps (remotion docs). */
  shutterAngle: number
  /** Time-offset copies averaged per frame (docs: 5-10; lowest kept — colour-destructive). */
  samples: number
  reason: string
}

export const CINEMA_MOTION_BLUR = { shutterAngle: 180, samples: 5 } as const

export function cinemaMotionBlurFor(compositionId: string, entityType?: string | null): CinemaMotionBlur {
  const off = (reason: string): CinemaMotionBlur => ({ enabled: false, shutterAngle: 0, samples: 0, reason })
  const spec = cinemaFinishFor(compositionId, entityType)
  if (!spec.enabled) return off("a still — nothing moves")
  if (spec.look.id === "true_color") return off("a screen — UI stays sharp and true")
  const treatments = COMPOSITION_TREATMENTS[compositionId] ?? []
  const person = treatments.filter((t) => PERSON_TREATMENTS.has(t))
  if (person.length > 0) return off(`a person on screen (${person.join(", ")}) — a talking head stays crisp`)
  const moves = treatments.filter((t) => CAMERA_MOVE_TREATMENTS.has(t))
  if (moves.length === 0) return off("no camera move — cards and kinetic text only")
  return { enabled: true, ...CINEMA_MOTION_BLUR, reason: `camera moves (${moves.join(", ")}) — film-camera blur, 180° shutter, 5 samples` }
}

// ── § CROSSFADE — why the cut is still a dip (wave 83B, documented) ─────────
//
// A TRUE two-picture crossfade needs both scenes mounted across the cut.
// `@remotion/transitions` is NOT installed (package.json; checked 2026-09-26) and
// its TransitionSeries.Transition SHORTENS the timeline by the transition length
// (remotion-markup/transitions.md "Duration calculation") — which the registered
// geometry, the render cache and the narration pad all key on. The
// timeline-keeping shape (widen each scene's Sequence by half the fade on each
// inner side; raise the incoming scene's opacity over the still-playing outgoing
// one, painted on an opaque backdrop — the fade() presentation "works only if the
// incoming slide is fully opaque") is per-COMPOSITION work: every composition's
// scenes are hand-mounted `<Sequence from={…} durationInFrames={…}>` tags that
// scripts/composition-segments.ts (the ONE timeline extractor) tiles against the
// registered geometry, so a list-driven series would blind that proof. Until a
// composition is migrated with its proof re-anchored, the cut stays the eased DIP.


// ── § TYPOGRAPHY + SAFE AREAS ────────────────────────────────────────────────

export interface CinemaTypeScale { caption: number; body: number; title: number; display: number; lineHeight: number }

/** A 1.25 (major-third) modular scale from the frame's SHORT side — 1080 short side → 40 px body. */
export function cinemaTypeScale(width: number, height: number): CinemaTypeScale {
  const base = Math.round(Math.min(Math.max(1, width), Math.max(1, height)) * 0.037)
  return { caption: Math.round(base * 0.8), body: base, title: Math.round(base * 1.5625), display: Math.round(base * 2.441), lineHeight: 1.2 }
}

/** The ONE safe-area survivor, re-exposed with the type scale so a layer asks one place. */
export function cinemaFrame(width: number, height: number): { safe: SafeInsets; type: CinemaTypeScale } {
  return { safe: safeInsets(width, height), type: cinemaTypeScale(width, height) }
}

// ── § AUDIO — fades derived from the composition, loudness from the master ──

/**
 * Music fades DERIVED from the composition's own bookends: the bed swells under
 * the cover card (fade-in ≈ 80 % of the intro, 0.8-2 s) and resolves across the
 * outro card (fade-out = the outro, 1.5-3 s) — the voice ends, the music carries
 * the last picture out (an L-cut on the bed). An unregistered composition keeps
 * the mixer's defaults.
 */
export function cinemaMusicFades(compositionId: string, fps = 30): { fadeInSeconds: number; fadeOutSeconds: number } {
  const { introFrames, outroFrames } = compositionBookends(compositionId)
  const f = fps > 0 ? fps : 30
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  return {
    fadeInSeconds: introFrames > 0 ? Number(clamp((introFrames / f) * 0.8, 0.8, 2).toFixed(2)) : DEFAULT_MUSIC_FADE_IN_SECONDS,
    fadeOutSeconds: outroFrames > 0 ? Number(clamp(outroFrames / f, 1.5, 3).toFixed(2)) : DEFAULT_MUSIC_FADE_OUT_SECONDS,
  }
}
