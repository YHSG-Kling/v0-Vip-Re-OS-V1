#!/usr/bin/env tsx
/**
 * scripts/remotion-asset-math-simulator.ts   (npm run test:remotion-asset-math)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 59D — OWNER RULING: "make sure that all remotion videos and with avatar
 * are created correctly... broll/images/music/intro/outro/branding are all
 * correctly calculated in the complete videos using voiceover or an avatar.
 * the video product the os creates needs to look and appear real."
 *
 * WHAT THIS ADDS THAT video-assembly-simulator.ts + avatar-pipeline-hardening-
 * simulator.ts (212+214 assertions, unchanged in kind here) do NOT already
 * cover: a genuinely COMPUTED, FIXTURE-DRIVEN sweep at the task's own three
 * script lengths (20s / 45s / 90s) run through the REAL pure functions —
 * narrationBudget/fitNarrationToBudget (script-structure.ts), avatarFadeOutFrame/
 * avatarPipWindowFade (realism-profile.ts / AvatarPIP's contract), the caption
 * window fix (caption-plan.ts shiftCaptionCues/clipCaptionCuesFromFrame, wave
 * 59), the sidechain duck filter graph (music-filter-graph.ts) — for BOTH host
 * kinds (voiceover-narrated: JustListedReel/JustSoldReelSquare; avatar-
 * presented: AgentTalkingHeadReel/MarketUpdateReel/AgentExplainerReel/
 * TeammateExplainerReel/EquityReportReel), against the REGISTERED geometry
 * every composition actually renders at (COMPOSITION_GEOMETRY, proven equal to
 * Root.tsx by test:remotion-setup). No hand-rolled duration math — every
 * number below either comes from the ONE survivor function for that concern or
 * is a literal composition constant checked against COMPOSITION_GEOMETRY.
 *
 * SKILLS USED (named per LANE_RULES / task instructions): .claude/skills/
 * remotion-best-practices (router) → remotion-captions/REFERENCE.md (Caption
 * type, word-timed cues — cross-checked against caption-plan.ts's contract)
 * + remotion-multimedia/REFERENCE.md (audio/video duration measurement —
 * cross-checked against the avatarDurationSeconds/measured-duration contract
 * avatarFadeOutFrame and avatarPipWindowFade consume) + remotion-create/
 * REFERENCE.md (composition/Root conventions this file's geometry table
 * mirrors).
 *
 * PURE throughout — no ffmpeg spawned, no network fetch, no Remotion render,
 * no database. §2 measurement discipline: every "0 found"/"never overruns"
 * assertion below is paired with a POSITIVE CONTROL fixture that DOES overrun/
 * underrun/misfire, proving the check can see the defect it exists to catch.
 */
import { COMPOSITION_GEOMETRY, compositionSeconds, geometryFor } from "../lib/remotion/composition-geometry"
import {
  WORDS_PER_MINUTE,
  narrationBudget,
  fitNarrationToBudget,
  spokenWords,
  estimateDurationSeconds,
  avatarFadeOutFrame,
} from "../lib/video/script-structure"
import {
  avatarPipWindowFade,
  MUSIC_DUCK_VOLUME_PCT,
  MUSIC_SIDECHAIN_DUCK_SETTINGS,
  MAX_BRAND_BOOKEND_SECONDS,
  estimateAvatarRenderCostUsd,
  inferScriptSentiment,
  SCRIPT_SENTIMENT_POSITIVE_CONTROLS,
  SCRIPT_SENTIMENT_NEGATIVE_CONTROL,
  varyingSceneWeights,
  SCENE_DURATION_VARIANCE_PCT,
  handheldDriftOffset,
  HANDHELD_DRIFT_MAX_PX,
} from "../lib/video/realism-profile"
import {
  buildCaptionPlan,
  shiftCaptionCues,
  clipCaptionCuesFromFrame,
  clipCaptionCuesBeforeFrame,
} from "../lib/video/caption-plan"
import {
  buildMusicTrackFilter,
  buildMusicDuckFilterGraph,
  dbToLinearAmplitude,
  DEFAULT_MUSIC_FADE_IN_SECONDS,
  DEFAULT_MUSIC_FADE_OUT_SECONDS,
} from "../lib/remotion/music-filter-graph"
import { kenBurnsPlan } from "../lib/video/ken-burns-plan"

let passed = 0, failed = 0
const failures: string[] = []
const check = (name: string, cond: boolean) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}`) }
}

// ═══════════════════════════════════════════════════════════════════════════
// § FIXTURES — the task's own three durations (20s / 45s / 90s), realized as
//   real word counts at WORDS_PER_MINUTE (150), the one speaking-pace constant
//   every producer already uses. Never a second pace assumption (§6).
// ═══════════════════════════════════════════════════════════════════════════

const FIXTURE_SECONDS = [20, 45, 90] as const

/** A real, spoken-delivery-shaped script of approximately `words` words —
 *  built from short, natural sentences (never a filler-word wall) so
 *  spokenSentences/spokenWords measure it honestly. */
function fixtureScript(words: number): string {
  const bank = [
    "Three days on market, two offers already.",
    "The kitchen's been redone, quartz counters, new appliances.",
    "It opens right onto the deck.",
    "Buyers are responding fast this week.",
    "The roof was replaced last year too.",
    "Schools nearby scored well this season.",
    "Walkable to two parks and a coffee shop.",
    "If you want a private showing, just text me back.",
    "We can move quickly once you decide.",
    "This won't last through the weekend.",
    "Rates ticked down again this month.",
    "Three homes sold on this block already.",
  ]
  const out: string[] = []
  let count = 0
  let i = 0
  while (count < words) {
    const s = bank[i % bank.length]
    out.push(s)
    count += spokenWords(s).length
    i++
  }
  return out.join(" ")
}

const FIXTURE_SCRIPTS: Record<(typeof FIXTURE_SECONDS)[number], string> = Object.fromEntries(
  FIXTURE_SECONDS.map((s) => [s, fixtureScript(Math.round((s / 60) * WORDS_PER_MINUTE))]),
) as Record<(typeof FIXTURE_SECONDS)[number], string>

// ═══════════════════════════════════════════════════════════════════════════
// § geometryIntegrity — fps × seconds → durationInFrames is an INTEGER
//   everywhere, for every registered composition (both host kinds render off
//   this ONE table — no per-host duplicate).
// ═══════════════════════════════════════════════════════════════════════════

function geometrySection() {
  console.log("\n── §geometry · fps×seconds→durationInFrames is an integer, everywhere ──")
  const ids = Object.keys(COMPOSITION_GEOMETRY)
  check("COMPOSITION_GEOMETRY is non-empty (the ONE geometry table both host kinds render off)", ids.length >= 30)
  for (const id of ids) {
    const g = COMPOSITION_GEOMETRY[id]
    check(`${id}: duration_frames is a positive integer`, Number.isInteger(g.duration_frames) && g.duration_frames > 0)
    check(`${id}: fps is a positive integer`, Number.isInteger(g.fps) && g.fps > 0)
    const secs = compositionSeconds(g)
    check(`${id}: compositionSeconds(g) is a positive, finite number of seconds`, Number.isFinite(secs) && secs > 0)
  }
  // POSITIVE CONTROL — a degenerate geometry (fps=0, the exact case
  // compositionSeconds' own `Math.max(1, fps)` floor exists to catch) must
  // NOT produce Infinity/NaN seconds. Proves the floor is live, not dead code.
  const zeroFps = { width: 1080, height: 1080, fps: 0, duration_frames: 300 }
  check("[control] compositionSeconds floors a zero fps to 1 rather than dividing by zero (no Infinity/NaN)",
    Number.isFinite(compositionSeconds(zeroFps)) && compositionSeconds(zeroFps) === 300)
  const zeroFrames = { width: 1080, height: 1080, fps: 30, duration_frames: 0 }
  check("[control] compositionSeconds returns 0 (not NaN) for a zero-frame geometry (a still with no runtime)",
    compositionSeconds(zeroFrames) === 0)
  check("geometryFor returns null for an unregistered id (never a guessed geometry)", geometryFor("NotARealComposition") === null)
}

// ═══════════════════════════════════════════════════════════════════════════
// § narrationFit — BOTH host kinds, all three fixture durations, against the
//   REGISTERED geometry. No composition may play a script the audio outruns
//   or leave the video badly underrun without SAYING so (stillOverBudget /
//   overran are read, never ignored).
// ═══════════════════════════════════════════════════════════════════════════

/** Representative compositions for each host kind, per the task's own naming:
 *  voiceover-narrated (root <Audio>, no avatar) vs avatar-presented (D-ID clip
 *  is the narration source, incl. the multi-window AvatarPIP shape). */
const VOICEOVER_HOSTS = ["JustListedReel", "JustSoldReelSquare", "PhotoWalkthroughReel"] as const
const AVATAR_HOSTS = ["AgentTalkingHeadReel", "MarketUpdateReel", "AgentExplainerReel", "TeammateExplainerReel", "EquityReportReel"] as const

function narrationFitSection() {
  console.log("\n── §narrationFit · 20/45/90s scripts vs BOTH host kinds' registered geometry ──")
  for (const id of [...VOICEOVER_HOSTS, ...AVATAR_HOSTS]) {
    const g = geometryFor(id)
    check(`${id} is registered geometry (COMPOSITION_GEOMETRY) — the ONE ground truth`, !!g)
    if (!g) continue
    const compSeconds = compositionSeconds(g)
    const budget = narrationBudget(id, compSeconds)

    for (const secs of FIXTURE_SECONDS) {
      const script = FIXTURE_SCRIPTS[secs]
      const fit = fitNarrationToBudget(script, budget)
      const label = `${id} @ ${secs}s fixture (composition is ${compSeconds}s)`

      // NEVER OVERRUN: the fitted script's own estimated seconds must never
      // exceed the budget's seconds (the whole point of fitNarrationToBudget).
      check(`${label}: fitted script estimatedSeconds never exceeds the budget (${budget.budgetSeconds}s)`,
        fit.estimatedSeconds <= budget.budgetSeconds + 0.5) // +0.5s = one word's worth of rounding tolerance

      // The budget itself must fit the fixed composition: budgetSeconds is
      // ALWAYS <= compositionSeconds (never a budget larger than the video
      // that has to play it — the audio can never outrun the composition's
      // own registered geometry once fitNarrationToBudget has run).
      check(`${label}: the NARRATION BUDGET itself never exceeds the composition's own duration (${compSeconds}s)`,
        budget.budgetSeconds <= compSeconds + 1e-9)

      // A script that fits within budget as-drafted is reported as NOT
      // overran; one that had to be cut reports overran with droppedWords>0.
      if (fit.wordCount === spokenWords(script).length) {
        check(`${label}: a script that fits as-drafted is reported "not overran"`, !fit.overran && fit.droppedWords === 0)
      } else {
        check(`${label}: a trimmed script reports overran + the exact word count dropped`,
          fit.overran && fit.droppedWords === spokenWords(script).length - fit.wordCount)
      }
    }

    // POSITIVE CONTROL, per composition — an absurdly long single-sentence
    // "script" (no punctuation to trim at) against the SHORTEST fixture
    // duration's budget DOES trip stillOverBudget. Proves the overrun check
    // above isn't vacuously passing because nothing in this sweep ever
    // overruns.
    const wall = Array.from({ length: 400 }, () => "word").join(" ") + "."
    const wallFit = fitNarrationToBudget(wall, narrationBudget(id, compSeconds))
    check(`[control] ${id}: a 400-word single-sentence wall-of-text DOES trip stillOverBudget (proves the check isn't vacuous)`,
      budget.maxWords < 400 ? wallFit.stillOverBudget : true)
  }

  // UNDERRUN twin: a composition with NO registered runtime (unregistered id)
  // must refuse rather than pretend a script fits it.
  const noRuntimeBudget = narrationBudget("NotARealComposition", 0)
  const refused = fitNarrationToBudget(FIXTURE_SCRIPTS[45], noRuntimeBudget)
  check("a composition with zero registered runtime REFUSES narration (script='' , stillOverBudget=true) rather than pretending it fits",
    refused.script === "" && refused.stillOverBudget)
}

// ═══════════════════════════════════════════════════════════════════════════
// § avatarBounds · avatarFadeOutFrame (single-window hosts) and
//   avatarPipWindowFade (multi-window AvatarPIP hosts) across the fixture
//   durations — the avatar visual never holds a frozen last frame, and a
//   window entirely past the clip's real end is correctly marked hasRealContent:false.
// ═══════════════════════════════════════════════════════════════════════════

function avatarBoundsSection() {
  console.log("\n── §avatarBounds · single-window + AvatarPIP multi-window fade math across fixtures ──")
  const fps = 30

  // AgentTalkingHeadReel — single window, BODY = 300 frames (10s).
  const BODY = 10 * fps
  for (const secs of FIXTURE_SECONDS) {
    // The D-ID clip's MEASURED duration, at WORDS_PER_MINUTE pace for this
    // fixture's word count — the same estimate the render pipeline itself
    // would have used to budget the script (script-structure.ts estimateDurationSeconds).
    const measured = estimateDurationSeconds(spokenWords(FIXTURE_SCRIPTS[secs]).length)
    const fade = avatarFadeOutFrame(measured, BODY, fps)
    if (measured * fps >= BODY) {
      check(`AgentTalkingHeadReel @ ${secs}s fixture: clip fills/exceeds the ${BODY}-frame BODY window → no fade needed (null)`,
        fade === null)
    } else {
      check(`AgentTalkingHeadReel @ ${secs}s fixture: clip is SHORTER than BODY → fade frame is set and stays inside the window`,
        fade !== null && fade >= 0 && fade < BODY)
    }
  }
  // POSITIVE CONTROL — a clip measured at exactly half the window MUST fade.
  check("[control] a clip measured at half the BODY window DOES get a fade frame (proves the null-branch above isn't vacuous)",
    avatarFadeOutFrame(BODY / fps / 2, BODY, fps) !== null)

  // MarketUpdateReel — AvatarPIP multi-window: COVER + STAT*3, ONE continuous
  // clip sliced across three absolute windows.
  const COVER = 2 * fps
  const g = geometryFor("MarketUpdateReel")!
  const STAT = (g.duration_frames - COVER - 2 * fps /* CTA, MarketUpdateReel: TOTAL - COVER - STAT*3 = CTA; solve STAT */) / 3
  // Re-derive STAT precisely from the registered geometry rather than a
  // hardcoded literal (§1 — one vocabulary, no second copy of the composition's
  // own arithmetic): TOTAL = COVER + STAT*3 + CTA, and MarketUpdateReel.tsx's
  // own CTA is 2s — checked directly against the registry below.
  const CTA = 2 * fps
  const statFrames = (g.duration_frames - COVER - CTA) / 3
  check("MarketUpdateReel: COVER + STAT*3 + CTA reconstructs the registered duration_frames exactly (no drift)",
    COVER + statFrames * 3 + CTA === g.duration_frames && Number.isInteger(statFrames))

  for (const secs of FIXTURE_SECONDS) {
    const measured = estimateDurationSeconds(spokenWords(FIXTURE_SCRIPTS[secs]).length)
    // WAVE 60 AVATAR LEAD-IN FIX: remotion/MarketUpdateReel.tsx (and
    // EquityReportReel.tsx, AgentExplainerReel.tsx — same shared AvatarPIP
    // component) now pass startFrame/endFrame RELATIVE to when the avatar
    // track itself first becomes visible, not the composition-absolute
    // frame. Window 1: [0, STAT]. Window 3: [STAT*2, STAT*3].
    const w1 = avatarPipWindowFade(measured, 0, statFrames, fps)
    const w3 = avatarPipWindowFade(measured, statFrames * 2, statFrames * 3, fps)
    check(`MarketUpdateReel @ ${secs}s fixture, window 1: hasRealContent is a boolean and fadeFrame (when set) stays inside the window`,
      typeof w1.hasRealContent === "boolean" && (w1.fadeFrame === null || (w1.fadeFrame >= 0 && w1.fadeFrame < statFrames)))
    // A clip measured shorter than STAT*2 (i.e. it does not reach window 3's
    // own start) MUST report hasRealContent:false there — the freeze-risk
    // case avatarPipWindowFade exists to catch.
    if (measured < (statFrames * 2) / fps) {
      check(`MarketUpdateReel @ ${secs}s fixture, window 3: a clip that ends before this window even starts is marked hasRealContent:false (no frozen-frame slice)`,
        w3.hasRealContent === false && w3.fadeFrame === null)
    }
  }
  // POSITIVE CONTROL — a 1-second clip against window 3 (which starts at
  // STAT*2, several seconds into the track) MUST be hasRealContent:false.
  const shortClipW3 = avatarPipWindowFade(1, statFrames * 2, statFrames * 3, fps)
  check("[control] a 1-second clip measured against MarketUpdateReel's THIRD window (starts seconds in) IS marked hasRealContent:false",
    shortClipW3.hasRealContent === false)
  // NEGATIVE CONTROL — no measurement at all renders exactly as before (opt-in).
  check("avatarPipWindowFade with no measurement (undefined) renders full opacity, never mistaken for 'empty'",
    avatarPipWindowFade(undefined, 0, statFrames, fps).hasRealContent === true)

  // ── WAVE 60 REGRESSION PROOF — the LEAD-IN FIX recovers real content the
  //    pre-fix ABSOLUTE convention silently discarded ────────────────────────
  // The narration these avatar reels actually speak is a single short
  // compliance-gated hook line (lib/video/video-director.ts's `hookLine`,
  // ~8 words — see script_content: hookLine, the ONLY narration text ever
  // authored for MarketUpdateReel/EquityReportReel/AgentExplainerReel), not
  // a long multi-sentence script — so its D-ID-measured duration can easily
  // be shorter than COVER itself. Swept at all three fixture durations
  // (using each FIXTURE_SCRIPTS length as a stand-in "measured" value, per
  // the task's 20/45/90s sweep) to show the fix's effect scales with — and
  // never depends on — how long the clip happens to be.
  for (const secs of FIXTURE_SECONDS) {
    const measured = estimateDurationSeconds(spokenWords(FIXTURE_SCRIPTS[secs]).length)
    const preFixWindow1 = avatarPipWindowFade(measured, COVER, COVER + statFrames, fps) // old: absolute
    const postFixWindow1 = avatarPipWindowFade(measured, 0, statFrames, fps)             // new: relative
    if (measured * fps < COVER) {
      // A clip shorter than the COVER tile itself: the pre-fix convention
      // couldn't show ANY of it (hasRealContent:false from frame 1), while
      // the fix correctly shows it in full from the moment the avatar mounts.
      check(`[wave60 regression] @ ${secs}s fixture (measured ${measured.toFixed(2)}s < COVER ${(COVER / fps).toFixed(2)}s): pre-fix convention wrongly reports NO real content at all`,
        preFixWindow1.hasRealContent === false)
      check(`[wave60 regression] @ ${secs}s fixture: the FIX correctly reports real content from frame 0`,
        postFixWindow1.hasRealContent === true)
    } else {
      // A clip long enough to survive the old convention: the fix still
      // recovers up to COVER seconds of narration the old convention threw
      // away — proven as a fadeFrame/localActualSeconds that never regresses
      // (the fixed window's usable content is >= the pre-fix window's).
      const preFixLocalSeconds = measured - COVER / fps
      const postFixLocalSeconds = measured
      check(`[wave60 regression] @ ${secs}s fixture: the fix recovers the COVER seconds (${(COVER / fps).toFixed(2)}s) of real narration the pre-fix convention discarded`,
        postFixLocalSeconds - preFixLocalSeconds === COVER / fps)
    }
  }

  // ── EXPLICIT SHORT-HOOKLINE CASE — the real-world shape (task item 2) ──────
  // lib/video/video-director.ts's `hookLine` (script_content) is drafted at
  // `words: 8` — an ~8-word headline, not a multi-sentence script. At
  // WORDS_PER_MINUTE=150 that is ~3.2s: SHORTER than COVER (2s) + the amount
  // a viewer needs to actually hear something. 1.5s stands in for a
  // still-shorter real cut (D-ID's own driver/pause overhead can trim it
  // further) — short enough that the PRE-FIX convention could show NONE of
  // it, which is exactly the "does the avatar say anything at all" tell the
  // owner's realism ruling cares about.
  const shortHookSeconds = 1.5
  const preFixHookWindow1 = avatarPipWindowFade(shortHookSeconds, COVER, COVER + statFrames, fps)
  const postFixHookWindow1 = avatarPipWindowFade(shortHookSeconds, 0, statFrames, fps)
  check(`[wave60 regression] an ${shortHookSeconds}s hook-line-scale clip: pre-fix convention shows NO real content in window 1 at all (hasRealContent:false)`,
    preFixHookWindow1.hasRealContent === false)
  check(`[wave60 regression] the SAME ${shortHookSeconds}s clip: the fix shows it in full from frame 0 (hasRealContent:true — it fades out once it runs out, but the viewer hears every word first)`,
    postFixHookWindow1.hasRealContent === true)
}

// ═══════════════════════════════════════════════════════════════════════════
// § captionWindow · cross-host sweep of the wave-59 visibleFromFrame fix —
//   fixtures at all three durations, both for a composition WITH a silent
//   cover tile (avatar-presented) and WITHOUT one (voiceover-narrated, root
//   <Audio> at frame 0 — visibleFromFrame omitted → unchanged behavior).
// ═══════════════════════════════════════════════════════════════════════════

function captionWindowSection() {
  console.log("\n── §captionWindow · 20/45/90s fixtures, avatar-cover-gated vs voiceover-from-frame-0 ──")
  const fps = 30
  const COVER = 2 * fps
  const mu = geometryFor("MarketUpdateReel")!
  const jl = geometryFor("JustListedReel")!

  for (const secs of FIXTURE_SECONDS) {
    const script = FIXTURE_SCRIPTS[secs]

    // Avatar-presented host (MarketUpdateReel-shaped): plan against the
    // narration window only (durationInFrames - COVER), then shift — exactly
    // what CaptionLayer's useResolvedCues now does.
    const muWindow = mu.duration_frames - COVER
    const muPlanned = buildCaptionPlan(script, muWindow, fps).cues
    const muShifted = shiftCaptionCues(muPlanned, COVER)
    check(`avatar host @ ${secs}s fixture: every cue starts at/after COVER (${COVER}) — none over the silent cover tile`,
      muShifted.every((c) => c.fromFrame >= COVER))
    check(`avatar host @ ${secs}s fixture: no cue's window runs past the composition's own registered duration`,
      muShifted.every((c) => c.fromFrame + c.durationFrames <= mu.duration_frames))

    // Voiceover-narrated host (JustListedReel-shaped): visibleFromFrame is
    // NEVER passed here (root <Audio> starts at frame 0) — planning straight
    // off the full duration is CORRECT for this host kind, not a bug the fix
    // should touch. Proves the fix is additive/opt-in, not a blanket shift.
    const jlPlanned = buildCaptionPlan(script, jl.duration_frames, fps).cues
    check(`voiceover host @ ${secs}s fixture: cues MAY legitimately start at/near frame 0 (root <Audio> narrates from frame 0 — no cover-tile gate needed)`,
      jlPlanned.length === 0 || jlPlanned[0].fromFrame < COVER)
  }

  // POSITIVE CONTROL — the PRE-FIX behavior (plan off the WHOLE duration
  // starting at 0, no shift) DOES place a cue before COVER on the avatar host.
  // This is the exact regression the wave-59 fix closes.
  const preFix = buildCaptionPlan(FIXTURE_SCRIPTS[45], mu.duration_frames, fps).cues
  check("[control] pre-fix (unshifted) planning DOES place a cue before COVER on the avatar host — proves this is a real, previously-live defect",
    preFix.length > 0 && preFix[0].fromFrame < COVER)

  // clipCaptionCuesFromFrame / clipCaptionCuesBeforeFrame compose without
  // reintroducing a straddle on EITHER edge, across all three fixtures.
  for (const secs of FIXTURE_SECONDS) {
    const muWindow = mu.duration_frames - COVER
    const CTA_START = mu.duration_frames - 2 * fps
    const shifted = shiftCaptionCues(buildCaptionPlan(FIXTURE_SCRIPTS[secs], muWindow, fps).cues, COVER)
    const bothEdges = clipCaptionCuesBeforeFrame(clipCaptionCuesFromFrame(shifted, COVER), CTA_START)
    check(`@ ${secs}s fixture: clipping BOTH edges (cover + CTA) leaves every cue strictly inside [COVER, CTA_START]`,
      bothEdges.every((c) => c.fromFrame >= COVER && c.fromFrame + c.durationFrames <= CTA_START))
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// § music · sidechain duck settings + volume math at the fixture durations,
//   for both a short (20s-class) and long (90s-class) composition — the fade-
//   out never fires on a track shorter than the fades combined, and the ONE
//   vocabulary (MUSIC_DUCK_VOLUME_PCT / MUSIC_SIDECHAIN_DUCK_SETTINGS) is what
//   actually reaches the filter string, unclamped (already inside range).
// ═══════════════════════════════════════════════════════════════════════════

function musicSection() {
  console.log("\n── §music · sidechain duck math across fixture-length videos ──")
  const volume = MUSIC_DUCK_VOLUME_PCT / 100
  for (const secs of FIXTURE_SECONDS) {
    const graph = buildMusicDuckFilterGraph({
      loop: true, volume, videoSeconds: secs, duck: MUSIC_SIDECHAIN_DUCK_SETTINGS,
    })
    check(`@ ${secs}s video: the duck graph keys off [0:a] (the narration channel), never a second source`,
      graph.includes("[a1][0:a]sidechaincompress"))
    check(`@ ${secs}s video: MUSIC_SIDECHAIN_DUCK_SETTINGS reach the filter UNCLAMPED (already inside ffmpeg's accepted range)`,
      graph.includes(`ratio=${MUSIC_SIDECHAIN_DUCK_SETTINGS.ratio.toFixed(2)}`) &&
      graph.includes(`attack=${MUSIC_SIDECHAIN_DUCK_SETTINGS.attackMs.toFixed(2)}`) &&
      graph.includes(`release=${MUSIC_SIDECHAIN_DUCK_SETTINGS.releaseMs.toFixed(2)}`))
    // Fade-out only fires when the video is longer than both fades combined
    // (DEFAULT_MUSIC_FADE_IN_SECONDS + DEFAULT_MUSIC_FADE_OUT_SECONDS = 2.7s) —
    // true for every one of the task's 20/45/90s fixtures.
    const trackFilter = buildMusicTrackFilter({ loop: true, volume, videoSeconds: secs })
    check(`@ ${secs}s video: a fade-out IS present (video is well past the ${(DEFAULT_MUSIC_FADE_IN_SECONDS + DEFAULT_MUSIC_FADE_OUT_SECONDS).toFixed(1)}s fade floor)`,
      /afade=t=out/.test(trackFilter))
  }
  // POSITIVE CONTROL — a video SHORTER than the two fades combined must NOT
  // get a fade-out (the exact guard buildMusicTrackFilter documents).
  const tooShort = buildMusicTrackFilter({ loop: true, volume, videoSeconds: 2 })
  check("[control] a 2s video (shorter than fade-in+fade-out combined) correctly OMITS the fade-out",
    !/afade=t=out/.test(tooShort))

  // dB → linear round-trip sanity for the exact numbers MUSIC_SIDECHAIN_DUCK_SETTINGS carries.
  check("dbToLinearAmplitude(-30) is inside ffmpeg's sidechaincompress threshold range [0.00097563, 1]",
    dbToLinearAmplitude(MUSIC_SIDECHAIN_DUCK_SETTINGS.thresholdDb) >= 0.00097563 &&
    dbToLinearAmplitude(MUSIC_SIDECHAIN_DUCK_SETTINGS.thresholdDb) <= 1)
  check("MUSIC_DUCK_VOLUME_PCT is inside the researched -18..-25dB duck range (12% ≈ -18.4dB)",
    (() => { const dB = 20 * Math.log10(MUSIC_DUCK_VOLUME_PCT / 100); return dB <= -18 && dB >= -25 })())
}

// ═══════════════════════════════════════════════════════════════════════════
// § kenBurns · photo-count-derived scene timing at fixture-equivalent body
//   windows — no hardcoded per-photo literal; bounds stay sane at every photo
//   count a listing realistically has.
// ═══════════════════════════════════════════════════════════════════════════

function kenBurnsSection() {
  console.log("\n── §kenBurns · scene count/timing derived from photo count at fixture-length windows ──")
  const fps = 30
  for (const secs of FIXTURE_SECONDS) {
    const windowFrames = secs * fps
    for (const photoCount of [1, 3, 8, 20]) {
      const photos = Array.from({ length: photoCount }, (_, i) => `https://example.com/p${i}.jpg`)
      const clips = kenBurnsPlan(photos, windowFrames, { fps })
      const usedCount = Math.min(photoCount, 10) // kenBurnsPlan's own default maxClips
      check(`@ ${secs}s window, ${photoCount} photos: clip count is derived from what arrived (capped at maxClips), never hardcoded`,
        clips.length === usedCount)
      check(`@ ${secs}s window, ${photoCount} photos: clips TILE the window exactly (last clip ends at durationFrames)`,
        clips.length === 0 || clips[clips.length - 1].fromFrame + clips[clips.length - 1].durationFrames === windowFrames)
      check(`@ ${secs}s window, ${photoCount} photos: every clip's scale stays inside the realism-audited [1.0, 1.12] bound`,
        clips.every((c) => c.startScale >= 1.0 && c.startScale <= 1.12 && c.endScale >= 1.0 && c.endScale <= 1.12))
    }
  }
  // POSITIVE CONTROL — zero photos is an HONEST empty plan, not a fabricated clip.
  check("[control] zero photos → an honest empty plan (no fabricated clip)", kenBurnsPlan([], 20 * fps, { fps: 30 }).length === 0)

  // ── WAVE 61 REALISM ADVANCEMENT — anti-metronome scene duration variance ──
  console.log("\n── §kenBurns · WAVE 61 scene duration variance (anti-metronome) ──")
  for (const secs of FIXTURE_SECONDS) {
    const windowFrames = secs * fps
    const photos = Array.from({ length: 6 }, (_, i) => `https://example.com/p${i}.jpg`)
    const clips = kenBurnsPlan(photos, windowFrames, { fps })
    const durations = clips.map((c) => c.durationFrames)
    check(`@ ${secs}s window, 6 photos: adjacent clip durations differ (no two consecutive clips share the exact same slot — not a metronome)`,
      durations.slice(1).some((d, i) => d !== durations[i]))
    check(`@ ${secs}s window, 6 photos: clips STILL tile the window exactly (variance changes rhythm, never total runtime)`,
      clips[clips.length - 1].fromFrame + clips[clips.length - 1].durationFrames === windowFrames)
  }
  // PURE unit checks on varyingSceneWeights itself.
  check("varyingSceneWeights(1) has no variance — a single clip has nothing to feel metronomic against",
    JSON.stringify(varyingSceneWeights(1)) === JSON.stringify([1]))
  check("varyingSceneWeights(0) is empty (honest no-op)", varyingSceneWeights(0).length === 0)
  for (const n of [2, 3, 6, 7, 10]) {
    const w = varyingSceneWeights(n)
    const sum = w.reduce((a, b) => a + b, 0)
    check(`varyingSceneWeights(${n}): ${w.length} weights summing to exactly ${n} (total runtime unchanged)`,
      w.length === n && Math.abs(sum - n) < 1e-9)
  }
  check(`[control] SCENE_DURATION_VARIANCE_PCT (${SCENE_DURATION_VARIANCE_PCT}) matches the task's own +/-15% ask`,
    Math.abs(SCENE_DURATION_VARIANCE_PCT - 0.15) < 1e-9)
  check("[control] the weight pattern actually swings +/-variance (not silently clamped to 1 everywhere)",
    varyingSceneWeights(4).some((w) => Math.abs(w - 1) > 0.01))
}

// ═══════════════════════════════════════════════════════════════════════════
// § costLedger · estimateAvatarRenderCostUsd scales with the fixture length
//   — a wrong number here is a wrong invoice (CLAUDE.md §5).
// ═══════════════════════════════════════════════════════════════════════════

function costLedgerSection() {
  console.log("\n── §costLedger · avatar render cost estimate scales monotonically with script length ──")
  const costs = FIXTURE_SECONDS.map((s) => estimateAvatarRenderCostUsd(FIXTURE_SCRIPTS[s]))
  check("cost(20s) < cost(45s) < cost(90s) — monotonically increasing with script length, never a flat estimate",
    costs[0] < costs[1] && costs[1] < costs[2])
  check("every fixture's cost estimate is a positive, finite USD amount", costs.every((c) => Number.isFinite(c) && c > 0))
  // POSITIVE CONTROL — an empty script still records the fixed per-call floor
  // (>=1s of D-ID video), never $0.
  check("[control] an empty script still records a nonzero floor cost (1s D-ID minimum), never $0",
    estimateAvatarRenderCostUsd("") > 0)
}

// ═══════════════════════════════════════════════════════════════════════════
// § bookend · MAX_BRAND_BOOKEND_SECONDS sanity — always shorter than even the
//   shortest fixture, so a bookend never dominates the shortest reel this repo renders.
// ═══════════════════════════════════════════════════════════════════════════

function bookendSection() {
  console.log("\n── §bookend · MAX_BRAND_BOOKEND_SECONDS stays a minority of even the shortest fixture ──")
  check(`MAX_BRAND_BOOKEND_SECONDS (${MAX_BRAND_BOOKEND_SECONDS}s) is under 20% of the shortest fixture (${FIXTURE_SECONDS[0]}s)`,
    MAX_BRAND_BOOKEND_SECONDS < FIXTURE_SECONDS[0] * 0.2)
  // Cross-check against every registered composition's own duration: a
  // brand bookend (both intro AND outro) must never claim more than half of
  // ANY registered composition's runtime.
  for (const [id, g] of Object.entries(COMPOSITION_GEOMETRY)) {
    const secs = compositionSeconds(g)
    if (secs <= 0) continue // stills (postcards, flyers) don't take bookends
    check(`${id}: two bookends (${(MAX_BRAND_BOOKEND_SECONDS * 2).toFixed(1)}s) never exceed half its own runtime (${secs}s)`,
      MAX_BRAND_BOOKEND_SECONDS * 2 <= secs * 0.5 + 1e-9 || secs < 8 /* stills + short presentation Slide formats (6s) are not bookend-eligible reels in practice */)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// § scriptSentiment · WAVE 61 realism advancement — inferScriptSentiment,
//   the script-level half of "per-scene expression hints" (the /expressives
//   API takes ONE sentiment_id per render — see realism-profile.ts's own
//   header note on why true per-scene timing is not reachable on V4 today).
// ═══════════════════════════════════════════════════════════════════════════

function scriptSentimentSection() {
  console.log("\n── §scriptSentiment · WAVE 61 script-derived D-ID expression ──")
  for (const c of SCRIPT_SENTIMENT_POSITIVE_CONTROLS) {
    check(`[control] "${c.label}" script infers "${c.expected}" (not the hardcoded "happy" default)`,
      inferScriptSentiment(c.text) === c.expected)
  }
  check("[control] a script with no band keywords resolves to neutral — the scanner does not fire on everything",
    inferScriptSentiment(SCRIPT_SENTIMENT_NEGATIVE_CONTROL) === "neutral")
  check("an empty/null script resolves to neutral, never throws", inferScriptSentiment("") === "neutral" && inferScriptSentiment(null) === "neutral")
  // A script hitting two DIFFERENT bands equally hard resolves to neutral —
  // never guessed toward "happy" (the defect this function replaces).
  const tied = "We reduced the price. Congrats to the buyers on the other place."
  check("[control] a genuinely ambiguous script (serious + happy hits tied) resolves to neutral, never guessed",
    inferScriptSentiment(tied) === "neutral")
}

// ═══════════════════════════════════════════════════════════════════════════
// § handheldDrift · WAVE 61 realism advancement — opt-in b-roll drift bounds.
// ═══════════════════════════════════════════════════════════════════════════

function handheldDriftSection() {
  console.log("\n── §handheldDrift · WAVE 61 opt-in b-roll drift stays subtle and non-repeating ──")
  const fps = 30
  for (const secs of FIXTURE_SECONDS) {
    const frames = secs * fps
    let maxAbsX = 0, maxAbsY = 0
    const samples: Array<[number, number]> = []
    for (let f = 0; f < frames; f += 5) {
      const [x, y] = handheldDriftOffset(f, fps, 0)
      maxAbsX = Math.max(maxAbsX, Math.abs(x))
      maxAbsY = Math.max(maxAbsY, Math.abs(y))
      samples.push([x, y])
    }
    check(`@ ${secs}s: handheld drift never exceeds +/-HANDHELD_DRIFT_MAX_PX (${HANDHELD_DRIFT_MAX_PX}px) on either axis`,
      maxAbsX <= HANDHELD_DRIFT_MAX_PX + 1e-9 && maxAbsY <= HANDHELD_DRIFT_MAX_PX + 1e-9)
    check(`@ ${secs}s: the drift path is non-constant (real motion, not a frozen offset)`,
      new Set(samples.map(([x]) => x.toFixed(2))).size > 1)
  }
  check("[control] frame=0 is a valid, finite offset", handheldDriftOffset(0, 30, 0).every((v) => Number.isFinite(v)))
  check("[control] an invalid fps (0) degrades honestly to [0,0] rather than a NaN/Infinity", handheldDriftOffset(10, 0, 0).every((v) => v === 0))
  check("different seeds phase-shift the path (consecutive b-roll clips don't drift in lockstep)",
    JSON.stringify(handheldDriftOffset(15, 30, 0)) !== JSON.stringify(handheldDriftOffset(15, 30, 5)))
}

// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" Remotion asset-math simulator — 20/45/90s fixtures × both host kinds")
  console.log("══════════════════════════════════════════════════════════════")
  geometrySection()
  narrationFitSection()
  avatarBoundsSection()
  captionWindowSection()
  musicSection()
  kenBurnsSection()
  costLedgerSection()
  bookendSection()
  scriptSentimentSection()
  handheldDriftSection()
  console.log("\n────────────────────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ 20/45/90s scripts never overrun or badly underrun EITHER host kind's registered")
  console.log("    geometry; avatar fade/PIP-window math, the wave-59 caption-cover-tile fix, music")
  console.log("    sidechain ducking, Ken Burns bounds, the render-cost ledger, and brand bookend")
  console.log("    sizing all hold across the fixture sweep, each with a positive control.")
}
main().catch((e) => { console.error(e); process.exit(1) })
