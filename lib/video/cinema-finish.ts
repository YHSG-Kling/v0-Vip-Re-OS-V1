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
import { kenBurnsPlan, type KenBurnsClip } from "./ken-burns-plan"
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
// MEASURED (wave 84A — owner: "chack on motion blur"; a real @remotion/renderer
// render of CinemaFinish, 1280×720, 300 frames, Chromium 1194 new-headless,
// swangle): the blurred reel smears the moving edge (10 partial pixels on the
// block's row vs 0 unblurred), a STATIC patch renders identical (197,41,41 in
// both — "destructive to colors" does not show at 5 samples on opaque content;
// max 4/255 anywhere the block never crosses), no black frames, the audio is
// identical (same RMS, same 10.048 s — the renderer dedupes the N sample copies'
// <Audio> by id), and the render cost 5.2× the unblurred one (444.6 s vs 85.1 s).
// DEFECT FIXED: the grade filter sat INSIDE CameraMotionBlur, so each of the 5
// samples was graded before averaging; it now wraps the blur (once, after the
// shutter — the film order). Controlled A/B, 90 frames × 2 rounds: 112.4 / 94.1 s
// inside → 71.2 / 67.1 s outside (≈ -33 %), unblurred 25.7 / 19.5 s; colours equal.

// WAVE 86 (lane 86B — owner: "use the least amount of blur reasons in the plan.
// trying to keep the cost down on the os without loosing quality"). The rule above
// was per COMPOSITION: every frame of an eligible reel paid for `samples` re-renders
// — the cover card, the outro card, the kinetic text, the b-roll — whether the
// camera moved or not. Measured on the lane's real render (lane86B-notes.md), the
// rule is now per SEGMENT and per STREAK:
//   · WHERE — only a plan segment whose treatment is a SYNTHESISED camera move
//     (property_photos: the Ken Burns push) with nobody on screen. B-ROLL IS
//     FOOTAGE: a real camera already integrated its own shutter into every frame
//     (compstart 2024 "Motion Blur for VFX": blur "already baked into the pixels";
//     adding synthetic blur on top doubles it) — so it is no longer a reason. A
//     presenter (full or PiP), a screen, a card, text: never.
//   · WHETHER — blur length ≈ on-screen speed × open time (compstart; RED "shutter
//     angle"): at 180° the streak is half the per-frame displacement. The Ken Burns
//     planner's own numbers give that displacement exactly; below
//     BLUR_VISIBLE_STREAK_PX the averaged image is indistinguishable from the sharp
//     one (measured PSNR vs a 16-sample reference), so it is not paid for.
//   · HOW MUCH — the fewest samples whose step (streak ÷ (samples − 1)) stays under
//     the measured ghosting step, capped at the measured ceiling.
// No plan staged: the composition-level eligibility below picks the BODY window only
// (the cover and outro are cards).
// MEASURED (lane 86B bench: the REAL KenBurnsPhoto driven by the REAL kenBurnsPlan,
// 1080×1920 at scale 0.5, 60 frames, Chromium 1194 chrome-for-testing, swangle; a
// "typical" tour = 6 photos over 12 s, a "fast" one = 10 photos over 6 s):
//   peak streak at 180°: typical 1.2 px, fast 3.6 px.
//   render time per 60 frames (samples 0/2/3/4/5):
//     typical 17.8 / 29.9 / 33.5 / 47.3 / 70.1 s — fast 30.5 / 57.9 / 67.7 / 91.4 / 137.8 s
//   smear achieved vs a 16-sample reference (edge-energy loss; a per-pixel PSNR is
//   confounded by the sub-frame time shift the sample offsets introduce):
//     fast push — the reference loses ~24 % of edge energy (a visible smear); 3 samples
//     reach 90–114 % of it (2 samples: 70–115 %, ragged) → 3 is the minimum that looks right;
//     typical push — the reference loses 0.4–10 % (a sub-2-px smear on hard synthetic
//     edges, invisible at playback) → not paid for (1.7–3.9× render time for nothing).
// So: floor 2 px, step ≤ 2 px (3 samples at the fast push), ceiling 4 (an unmeasured
// move) — the old flat 5 samples on every frame of an eligible reel cost 3.9–4.5×.

/** Treatments whose picture is a SYNTHESISED camera move (the Ken Burns push). Footage is not. */
const CAMERA_MOVE_TREATMENTS: ReadonlySet<BodyTreatment> = new Set<BodyTreatment>(["property_photos"])
/** Treatments that put a person on screen — kept crisp. */
const PERSON_TREATMENTS: ReadonlySet<BodyTreatment> = new Set<BodyTreatment>(["full_avatar", "avatar_pip"])

export interface CinemaMotionBlur {
  enabled: boolean
  /** Degrees; 180 = the film standard at 24-60 fps (remotion docs). */
  shutterAngle: number
  /** Time-offset copies averaged per frame — the CEILING; a window's own streak picks fewer. */
  samples: number
  reason: string
}

/** 180° shutter; `samples` is the measured CEILING (lane 86B bench), a window's streak picks fewer. */
export const CINEMA_MOTION_BLUR = { shutterAngle: 180, samples: 4 } as const

/** Below this streak (px) the blurred frame is indistinguishable from the sharp one (lane 86B, measured). */
export const BLUR_VISIBLE_STREAK_PX = 2

/** The largest spacing (px) between two time-offset copies before they read as ghosts (lane 86B, measured). */
export const BLUR_MAX_SAMPLE_STEP_PX = 2

/** The fewest samples for a streak: 0 below the visible floor, else enough copies that
 *  no two sit further apart than BLUR_MAX_SAMPLE_STEP_PX, between 2 and the ceiling. PURE. */
export function blurSamplesForStreak(streakPx: number): number {
  if (!Number.isFinite(streakPx) || streakPx < BLUR_VISIBLE_STREAK_PX) return 0
  return Math.max(2, Math.min(CINEMA_MOTION_BLUR.samples, Math.ceil(streakPx / BLUR_MAX_SAMPLE_STEP_PX) + 1))
}

/** KenBurnsPhoto's easing, Easing.bezier(0.45, 0, 0.55, 1), evaluated at x ∈ [0, 1] (bisection). PURE. */
function kenBurnsEase(x: number): number {
  const [x1, y1, x2, y2] = [0.45, 0, 0.55, 1]
  const bez = (u: number, a: number, b: number) => 3 * (1 - u) * (1 - u) * u * a + 3 * (1 - u) * u * u * b + u * u * u
  const t = Math.max(0, Math.min(1, x))
  let lo = 0, hi = 1
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (bez(mid, x1, x2) < t) lo = mid; else hi = mid }
  return bez((lo + hi) / 2, y1, y2)
}

/**
 * The longest on-screen streak (px) a Ken Burns tour draws at `shutterAngle`: the
 * frame corner's peak per-frame displacement under KenBurnsPhoto's S·T transform
 * (scale(s) translate(pan%) on the same eased curve), frame by frame, × the
 * shutter's open fraction. PURE.
 */
export function kenBurnsPeakStreakPx(clips: readonly KenBurnsClip[], width: number, height: number, shutterAngle: number = CINEMA_MOTION_BLUR.shutterAngle): number {
  let peak = 0
  for (const c of clips) {
    if (c.durationFrames <= 0) continue
    const at = (f: number): [number, number] => {
      const e = kenBurnsEase(f / c.durationFrames)
      const s = c.startScale + (c.endScale - c.startScale) * e
      const px = c.panFromXY[0] + (c.panToXY[0] - c.panFromXY[0]) * e
      const py = c.panFromXY[1] + (c.panToXY[1] - c.panFromXY[1]) * e
      return [s * (-width / 2 + (px / 100) * width), s * (-height / 2 + (py / 100) * height)]
    }
    let prev = at(0)
    for (let f = 1; f <= c.durationFrames; f++) {
      const cur = at(f)
      peak = Math.max(peak, Math.hypot(cur[0] - prev[0], cur[1] - prev[1]))
      prev = cur
    }
  }
  return Number((peak * (Math.max(0, Math.min(360, shutterAngle)) / 360)).toFixed(2))
}

/** Composition-level eligibility — the no-plan fallback and the outer gate. */
export function cinemaMotionBlurFor(compositionId: string, entityType?: string | null): CinemaMotionBlur {
  const off = (reason: string): CinemaMotionBlur => ({ enabled: false, shutterAngle: 0, samples: 0, reason })
  const spec = cinemaFinishFor(compositionId, entityType)
  if (!spec.enabled) return off("a still — nothing moves")
  if (spec.look.id === "true_color") return off("a screen — UI stays sharp and true")
  const treatments = COMPOSITION_TREATMENTS[compositionId] ?? []
  const person = treatments.filter((t) => PERSON_TREATMENTS.has(t))
  if (person.length > 0) return off(`a person on screen (${person.join(", ")}) — a talking head stays crisp`)
  const moves = treatments.filter((t) => CAMERA_MOVE_TREATMENTS.has(t))
  if (moves.length === 0) {
    return off(treatments.includes("broll")
      ? "footage only — b-roll already carries its own camera's shutter blur"
      : "no camera move — cards and kinetic text only")
  }
  return { enabled: true, ...CINEMA_MOTION_BLUR, reason: `synthesised camera move (${moves.join(", ")}) — 180° shutter, samples by streak` }
}

export interface CinemaBlurWindow {
  /** Composition-absolute frames [from, to). */
  from: number
  to: number
  samples: number
  streakPx: number | null
  reason: string
}

/**
 * The frame windows that blur, and at how many samples. `streakPx` is the camera's
 * peak streak when the caller knows it (cinemaCameraStreakPx); unknown → the
 * ceiling (quality first: an unmeasured move is never under-blurred). PURE.
 */
export function cinemaMotionBlurWindows(
  compositionId: string,
  durationInFrames: number,
  plan: BodyVisualPlan | null | undefined,
  opts: {
    width: number
    height: number
    fps?: number
    /** A known peak streak (px). Absent → measured from `props` (cinemaCameraStreakPx). */
    streakPx?: number | null
    /** The composition's input props — its staged photos give the push its speed. */
    props?: Record<string, unknown> | null
  },
): CinemaBlurWindow[] {
  const spec = cinemaFinishFor(compositionId)
  if (!spec.enabled || spec.look.id === "true_color") return []
  // WHERE first: the camera-move frame windows, before any cost is decided.
  let spans: Array<{ from: number; to: number; label: string }> = []
  if (plan && plan.durationInFrames === durationInFrames && Array.isArray(plan.segments)) {
    spans = plan.segments
      .filter((s) => CAMERA_MOVE_TREATMENTS.has(s.treatment) && s.presenter === "none" && s.durationInFrames > 0)
      .map((s) => ({ from: s.from, to: s.from + s.durationInFrames, label: `${s.treatment} segment ${s.index}` }))
  } else if (cinemaMotionBlurFor(compositionId).enabled) {
    const { introFrames, outroFrames } = compositionBookends(compositionId)
    const from = Math.max(0, introFrames), to = Math.max(from, durationInFrames - Math.max(0, outroFrames))
    if (to > from) spans = [{ from, to, label: "body (no plan staged)" }]
  }
  if (spans.length === 0) return []
  // HOW FAST: the caller's streak, else the staged photos' own push over the shortest window.
  let streak: number | null = typeof opts.streakPx === "number" && Number.isFinite(opts.streakPx) ? opts.streakPx : null
  if (streak === null && opts.streakPx === undefined && opts.props) {
    streak = cinemaCameraStreakPx(opts.props, Math.min(...spans.map((s) => s.to - s.from)), spans.length, { width: opts.width, height: opts.height, fps: opts.fps ?? 30 })
  }
  const samples = streak === null ? CINEMA_MOTION_BLUR.samples : blurSamplesForStreak(streak)
  if (samples === 0) return []
  const why = streak === null ? "camera move of unmeasured speed — the ceiling" : `peak streak ${streak}px`
  return spans.map((s) => ({ from: s.from, to: s.to, samples, streakPx: streak, reason: `${s.label} — ${why}` }))
}

/** Samples at this frame (0 = render without the blur wrapper). PURE. */
export function cinemaMotionBlurAt(frame: number, windows: readonly CinemaBlurWindow[]): number {
  for (const w of windows) if (frame >= w.from && frame < w.to) return w.samples
  return 0
}

/**
 * The camera's peak streak for a composition's staged photos, when the photo push is
 * the house Ken Burns planner (kenBurnsPlan) — the gentlest-to-strongest push any
 * photo layer here draws (JustListed-family slides zoom ≤ 8 % linearly; the planner
 * zooms ≤ 12 % + pans ≤ 6 % on an eased curve), so modelling a photo window as a
 * kenBurnsPlan tour of the photos it shows is an UPPER bound. The photos are shared
 * evenly across the photo windows. null when the props carry no photos (unknown). PURE.
 */
export function cinemaCameraStreakPx(
  props: Record<string, unknown>,
  windowFrames: number,
  photoWindows: number,
  opts: { width: number; height: number; fps: number },
): number | null {
  const urls = Array.isArray(props.imageUrls) ? (props.imageUrls as unknown[]).filter((u) => typeof u === "string" && u) as string[] : []
  if (urls.length === 0 || windowFrames <= 0) return null
  const perWindow = Math.max(1, Math.ceil(urls.length / Math.max(1, photoWindows)))
  return kenBurnsPeakStreakPx(kenBurnsPlan(urls.slice(0, perWindow), windowFrames, { fps: opts.fps }), opts.width, opts.height)
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


// ── § DELIVERY SPEC — what every moving render leaves the renderer as ────────
//
// WAVE 86 (lane 86B — the stitch). Three renderMedia call sites (render-
// composition, render-just-listed, render-newsletter-video) each spelled
// `codec: "h264"` and nothing else, so the file handed to the bookend stitch,
// the narration mux and the music pass was whatever Remotion defaulted to.
// MEASURED (lane 86B, @remotion/renderer 4.0.521, a silent PhotoWalkthroughReel):
//   · the COLOUR MATRIX came out BT.601 (bt470bg) while stock clips and D-ID
//     renders arrive BT.709 — a colour shift at every stitched join. The spec
//     renders BT.709 (measured: bt709).
//   · a silent composition DID still carry a silent AAC track (2.048 s, 48 kHz)
//     — so `enforceAudioTrack` is not fixing a measured defect today; it PINS
//     that behaviour, because every ffmpeg pass after the render reads `[0:a]`
//     and a renderer default is not a contract.
// ONE spec, spread at every site: yuv420p, BT.709, an audio track always present,
// AAC at the stitch's 48 kHz.
export const DELIVERY_RENDER_OPTIONS = {
  codec: "h264",
  pixelFormat: "yuv420p",
  colorSpace: "bt709",
  enforceAudioTrack: true,
  audioCodec: "aac",
  audioBitrate: "192k",
  sampleRate: 48000,
} as const

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

/**
 * THE BURNED-IN CAPTION on the cinema type scale (wave 86, lane 86B — owner
 * decision on the 85E open item "should the cinemaFrame type scale drive caption
 * sizes?": yes). remotion/components/CaptionLayer.tsx hard-coded 56 px, an 18 px
 * pad, a 64×6 tick and a band whose TOP sat at 78 % of the frame — on a 9:16
 * reel that put the whole caption inside the bottom 22 % the platforms paint
 * their own UI over (safeInsets). Now every number is a step of the one scale:
 *   · text = the `title` step (1.5625 × body; 62 px on a 1080 short side — the
 *     muted-social caption size, a step above body copy so it reads at arm's length);
 *   · padding, radius, stroke, tick = fractions of the body step;
 *   · the band's BOTTOM sits ON the safe-area bottom inset, its sides inside the
 *     safe left/right — so a 16:9, a 1:1 and a 9:16 frame each get captions sized
 *     and placed for that frame, never a literal.
 * PURE.
 */
export interface CinemaCaptionStyle {
  fontSize: number
  lineHeight: number
  padX: number
  padY: number
  radius: number
  strokePx: number
  tickWidth: number
  tickHeight: number
  tickGap: number
  /** px from the frame's bottom edge to the band's bottom edge (the safe inset). */
  bandBottom: number
  /** px kept clear on each side (the safe inset). */
  sidePad: number
}

export function cinemaCaptionStyle(width: number, height: number): CinemaCaptionStyle {
  const { safe, type } = cinemaFrame(width, height)
  const b = type.body
  return {
    fontSize: type.title,
    lineHeight: 1.12,
    padX: Math.round(b * 0.75),
    padY: Math.round(b * 0.45),
    radius: Math.round(b * 0.4),
    strokePx: Math.max(1, Math.round(b / 20)),
    tickWidth: Math.round(b * 1.6),
    tickHeight: Math.max(2, Math.round(b * 0.15)),
    tickGap: Math.round(b * 0.3),
    bandBottom: safe.bottom,
    sidePad: Math.max(safe.left, safe.right),
  }
}

/**
 * THE LOWER-THIRD'S PLACE AND TIME (wave 87, lane 87D — found by the lane's
 * real render of the approval-render talking head). The LowerThird strap and
 * the burned-in caption band BOTH parked on the safe-area bottom inset, so the
 * agent's name sat UNDER the caption box for the whole body — half of it
 * hidden, and the frame carried two bottom bands at once. Broadcast practice
 * (and the short-form norm): the name strap IDENTIFIES the speaker as they
 * first appear — in for ~0.5 s, held ~4 s, then out — and it sits clear of the
 * caption band, never behind it.
 *   · bottom = the caption band's bottom + a TWO-LINE caption band's height +
 *     one body-step gap (the band's height from the same cinemaCaptionStyle
 *     numbers the CaptionLayer draws with — one derivation);
 *   · holdFrames = LOWER_THIRD_HOLD_SECONDS at the render's fps.
 * PURE.
 */
export const LOWER_THIRD_HOLD_SECONDS = 4
export const LOWER_THIRD_EXIT_FRAMES = 12

export function cinemaLowerThirdPlacement(width: number, height: number, fps = 30): { bottom: number; holdFrames: number; exitFrames: number } {
  const cap = cinemaCaptionStyle(width, height)
  const { type } = cinemaFrame(width, height)
  const twoLineBand = Math.ceil(cap.fontSize * cap.lineHeight * 2 + cap.padY * 2 + cap.tickHeight + cap.tickGap)
  return {
    bottom: cap.bandBottom + twoLineBand + Math.round(type.body * 0.5),
    holdFrames: Math.round(LOWER_THIRD_HOLD_SECONDS * (fps > 0 ? fps : 30)),
    exitFrames: LOWER_THIRD_EXIT_FRAMES,
  }
}

/**
 * THE DISCLOSURE FOOTER (wave 89, lane 89F — the fleet-wide twin of 87D's one
 * talking-head fix). Eleven outro tiles and the shared EndCard typed the
 * Equal Housing / licence line as `bottom: 24, fontSize: 14, opacity: 0.55`
 * — 24 px from the edge (inside every platform's UI band: safeInsets is 97 px
 * on a 1:1 frame, 22 % on 9:16) in 14 px type at half opacity: a DISCLOSURE
 * nobody on a phone could read. One derivation now: the line sits ON the
 * safe-area bottom inset, inside the safe sides, on the scale's caption step,
 * at readable contrast. Spread into the footer's style; the proof
 * (scripts/video-hook-window-guard.ts §disclosure) fails any moving
 * composition that still types the edge. PURE.
 */
export interface CinemaDisclosureStyle {
  bottom: number
  left: number
  right: number
  fontSize: number
  lineHeight: number
  letterSpacing: number
  opacity: number
  textAlign: "center"
}

export function cinemaDisclosureStyle(width: number, height: number): CinemaDisclosureStyle {
  const { safe, type } = cinemaFrame(width, height)
  return { bottom: safe.bottom, left: safe.left, right: safe.right, fontSize: type.caption, lineHeight: 1.5, letterSpacing: 1, opacity: 0.8, textAlign: "center" }
}

/**
 * THE BADGE SLOT — where a corner badge (the tracked QR, the persistent
 * Equal Housing pill) sits: inside the safe sides, and ABOVE the band the
 * burned-in captions and the disclosure footer share (the lower-third's own
 * cleared height, cinemaLowerThirdPlacement — one derivation), so a badge
 * never lands under a caption cue or on top of the disclosure line. Both
 * badges typed 24-28 px corners before (inside the platform UI band). PURE.
 */
export function cinemaBadgeSlot(width: number, height: number): { bottom: number; left: number; right: number } {
  const { safe } = cinemaFrame(width, height)
  return { bottom: cinemaLowerThirdPlacement(width, height).bottom, left: safe.left, right: safe.right }
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
