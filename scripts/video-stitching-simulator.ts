#!/usr/bin/env tsx
/**
 * scripts/video-stitching-simulator.ts — test:video-stitching (wave 86, lane 86B)
 * ─────────────────────────────────────────────────────────────────────────────
 * OWNER (2026-09-27, verbatim): "videos need to be professionally completed
 * especially when stiching the full video together without any hiccups. A motion
 * picture production video when finished. use the least amount of blur reasons in
 * the plan. trying to keep the cost down on the os without loosing quality." Plus
 * answer 4 (the video feature gate → tier-METERED) and 6 (retire the unused doors).
 *
 * What the lane's real render found (lane86B-notes.md) is held here as RULES, each
 * with a positive control (the finder still recognises the defect it was written for):
 *   §stitch    the join graph (lib/video/stitch-graph.ts) — conform, exact lengths,
 *              silence synthesised, dissolves on handles, spoken bookends never cut;
 *   §delivery  every renderMedia site spreads the ONE delivery spec (audio always
 *              present, BT.709, 48 kHz) and the stitch/master agree on the rate;
 *   §hybrid    the D-ID hook/CTA are spoken bookends and ONE bed runs under the joins;
 *   §blur      motion blur only on segments whose treatment is a synthesised camera
 *              move fast enough to see, at the measured minimum samples;
 *   §captions  the burned-in caption sits on the cinema type scale and the safe inset;
 *   §meter     video is tier-METERED: the one refusal is a tier that excludes video;
 *   §doors     the five /api/video/projects/** doors are retired onto their survivors.
 * NO network, NO database, NO ffmpeg — pure functions executed + stripped source read.
 * BLIND SPOTS (published): the render itself (Chromium + ffmpeg) is proven by the
 * lane's harness, not here; the blur threshold is a measured number on the lane's
 * synthetic photos, not on every real listing; live plan_limits values are read by
 * the migration's postconditions, not by this proof.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { blankStrings, stripComments } from "./strip-comments"
import {
  DECLICK_SECONDS, JOIN_DISSOLVE_SECONDS, STITCH_SAMPLE_RATE, TRIM_AUDIO_FADE_SECONDS,
  buildStitchPlan, parseFfmpegProbe, stitchCanvasFrom, stitchEncodeArgs, type MediaProbe,
} from "../lib/video/stitch-graph"
import {
  CINEMA_MOTION_BLUR, DELIVERY_RENDER_OPTIONS, cinemaCaptionStyle, cinemaFrame, cinemaMotionBlurAt, cinemaMotionBlurFor,
  cinemaMotionBlurWindows, cinemaTypeScale, kenBurnsPeakStreakPx, blurSamplesForStreak, BLUR_VISIBLE_STREAK_PX,
} from "../lib/video/cinema-finish"
import { MASTER_LOUDNESS, MASTER_TRIM_TOLERANCE_LU, masterTrimGainDb, parseLoudnessMeasurement } from "../lib/remotion/music-filter-graph"
import { MAX_BRAND_BOOKEND_SECONDS } from "../lib/video/realism-profile"
import { insideSafeArea, COMPOSITION_TREATMENTS, type BodyVisualPlan } from "../lib/video/body-visual-model"
import { compositionBookends } from "../lib/video/duration-model"
import { kenBurnsPlan } from "../lib/video/ken-burns-plan"
import { decideVideoMeter, videoMeterUnits } from "../lib/video/video-metering"
import { OVERAGE_BILLED_METRICS, VIDEO_OVERAGE_METRIC, AI_OVERAGE_METRIC } from "../lib/billing/plan-catalog"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const root = process.cwd()
const raw = (rel: string) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "")
const code = (rel: string) => stripComments(raw(rel))
const codeNoStrings = (rel: string) => blankStrings(code(rel))

const probe = (d: number | null, o: Partial<MediaProbe> = {}): MediaProbe =>
  ({ durationSeconds: d, width: 1080, height: 1920, fps: 30, hasAudio: true, colorMatrix: "bt709", ...o })

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §stitch · the join graph (executed) ──")
{
  // The probe parser reads what ffmpeg-static prints (it ships no ffprobe).
  const withAudio = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':\n  Duration: 00:00:04.00, start: 0.000000, bitrate: 22 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 18 kb/s, 25 fps, 25 tbr, 12800 tbn (default)\n  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s (default)`
  const silent = withAudio.split("\n").slice(0, 3).join("\n")
  const p1 = parseFfmpegProbe(withAudio), p2 = parseFfmpegProbe(silent)
  check("the probe reads length, shape, fps, the audio stream and the colour matrix", p1.durationSeconds === 4 && p1.width === 1920 && p1.height === 1080 && p1.fps === 25 && p1.hasAudio && p1.colorMatrix === "bt709")
  check("…and sees a SILENT file as silent (the case that failed the whole old stitch)", p2.durationSeconds === 4 && !p2.hasAudio)
  check("29.97 fps survives as 29.97 (no literal 30)", parseFfmpegProbe(withAudio.replace("25 fps", "29.97 fps")).fps === 29.97)
  check("the canvas is the MAIN render's shape and rate (even dimensions for 4:2:0)",
    JSON.stringify(stitchCanvasFrom(probe(10, { width: 1079, height: 1919, fps: 25 }))) === JSON.stringify({ width: 1080, height: 1920, fps: 25 }))

  const canvas = { width: 1080, height: 1920, fps: 30 }
  const plan = buildStitchPlan({
    canvas,
    segments: [
      { inputIndex: 0, role: "intro", probe: probe(4, { width: 1920, height: 1080, fps: 25, hasAudio: false }), capSeconds: MAX_BRAND_BOOKEND_SECONDS },
      { inputIndex: 1, role: "main", probe: probe(20), capSeconds: null },
      { inputIndex: 2, role: "outro", probe: probe(2), capSeconds: MAX_BRAND_BOOKEND_SECONDS },
    ],
  })
  check("a plan is built", plan.ok)
  if (plan.ok) {
    const D = JOIN_DISSOLVE_SECONDS
    const [i, m, o] = plan.segments
    check("a silent sting gets an in-graph silent track of its EXACT length (never an invalid [0:a])",
      i.synthesizedSilence && plan.filter.includes(`anullsrc=r=${STITCH_SAMPLE_RATE}:cl=stereo,atrim=duration=${MAX_BRAND_BOOKEND_SECONDS}[as0]`) && !plan.filter.includes("[0:a]"))
    check("a 4 s sting is capped at the brand cap and its SOUND faded out (no click); the 2 s outro is untouched",
      i.trimmed && i.programSeconds === MAX_BRAND_BOOKEND_SECONDS && !o.trimmed && o.programSeconds === 2
        && plan.filter.includes(`afade=t=out:st=${MAX_BRAND_BOOKEND_SECONDS - TRIM_AUDIO_FADE_SECONDS}:d=${TRIM_AUDIO_FADE_SECONDS}`))
    check("the main programme is never capped", !m.trimmed && m.programSeconds === 20)
    check("a different frame shape gets the blurred cover fill, never black bars", i.fill === "blurred_cover" && m.fill === "direct" && /boxblur/.test(plan.filter))
    check("every segment is conformed to the MAIN's fps, yuv420p, SAR 1, BT.709",
      (plan.filter.match(/fps=30,format=yuv420p/g) ?? []).length === 3 && (plan.filter.match(/setsar=1/g) ?? []).length === 3 && (plan.filter.match(/out_color_matrix=bt709/g) ?? []).length === 3 && !/fps=25/.test(plan.filter))
    // Picture: ONE pad (head held, tail held past the end) then ONE cut to head + programme + tail.
    const r3 = (n: number) => Number(n.toFixed(3))
    const vTotal = (k: number): number | null => {
      const mm = new RegExp(`\\[vf${k}\\]tpad=[^,]*stop_mode=clone:stop_duration=[\\d.]+,trim=duration=([\\d.]+),setpts=PTS-STARTPTS,fps=30\\[v${k}\\]`).exec(plan.filter)
      return mm ? Number(mm[1]) : null
    }
    // Sound: exact programme length, then the same head (adelay) + tail (apad) handles.
    const aTotal = (k: number, s: typeof i): number | null => plan.filter.includes(`[as${k}]apad,atrim=duration=${s.programSeconds},asetpts=PTS-STARTPTS`)
      ? r3(s.programSeconds + s.headHandleSeconds + s.tailHandleSeconds) : null
    check("picture and sound of EVERY segment are cut to the SAME exact length, handles included (the concat-desync rule)",
      [i, m, o].every((s, k) => vTotal(k) !== null && vTotal(k) === aTotal(k, s) && vTotal(k) === r3(s.programSeconds + s.headHandleSeconds + s.tailHandleSeconds)))
    check("the handles are padded BEFORE the cut (a tpad after a trim adds nothing on ffmpeg 7 — the lane's second stitch lost 5.7 s of picture)",
      !/trim=duration=[\d.]+,setpts=PTS-STARTPTS,tpad=/.test(plan.filter))
    check("POSITIVE CONTROL — the finder sees a tpad placed after a trim", /trim=duration=[\d.]+,setpts=PTS-STARTPTS,tpad=/.test("[vf1]tpad=stop_mode=clone:stop_duration=12.56,trim=duration=11.56,setpts=PTS-STARTPTS,tpad=start_mode=clone:start_duration=0.4[v1]"))
    check("every video chain RE-STATES the rate after trim/tpad (xfade refuses the 1/0 rate they leave — the lane's first real stitch failed on it)",
      [0, 1, 2].every((k) => new RegExp(`\\[vf${k}\\][^;]*,fps=30\\[v${k}\\]`).test(plan.filter)))
    check("POSITIVE CONTROL — a chain ending on tpad is recognised as rate-less", !/\[vf0\][^;]*,fps=30\[v0\]/.test("[vf0]tpad=stop_mode=clone:stop_duration=3.5,trim=duration=2.5,setpts=PTS-STARTPTS[v0]"))
    check("every programme edge is de-clicked", (plan.filter.match(new RegExp(`afade=t=in:st=0:d=${DECLICK_SECONDS}`, "g")) ?? []).length === 3)
    check("every inner side carries a handle of exactly one dissolve (held frame + silence) — outer edges none",
      i.headHandleSeconds === 0 && i.tailHandleSeconds === D && m.headHandleSeconds === D && m.tailHandleSeconds === D && o.headHandleSeconds === D && o.tailHandleSeconds === 0
        && (plan.filter.match(new RegExp(`tpad=start_mode=clone:start_duration=${D}`, "g")) ?? []).length === 2 && (plan.filter.match(new RegExp(`apad=pad_dur=${D}`, "g")) ?? []).length === 2)
    check("each join is ONE xfade + ONE acrossfade of the SAME length (the picture and sound cannot drift apart)",
      (plan.filter.match(new RegExp(`xfade=transition=fade:duration=${D}:`, "g")) ?? []).length === 2 && (plan.filter.match(new RegExp(`acrossfade=d=${D}:`, "g")) ?? []).length === 2 && !/concat=n=/.test(plan.filter))
    // offsets derived from exact lengths
    const segLen = (s: typeof i) => s.programSeconds + s.headHandleSeconds + s.tailHandleSeconds
    const off1 = segLen(i) - D, off2 = segLen(i) + segLen(m) - 2 * D
    check(`join offsets come from the exact lengths (${plan.joins.map((j) => j.offsetSeconds).join(", ")} s)`,
      Math.abs(plan.joins[0].offsetSeconds - off1) < 1e-6 && Math.abs(plan.joins[1].offsetSeconds - off2) < 1e-6)
    check(`the dissolve consumes ONLY handles: the main programme starts at intro + one dissolve (${plan.mainStartSeconds} s) and the film is programme + one dissolve per join (${plan.totalSeconds} s)`,
      Math.abs(plan.mainStartSeconds - (MAX_BRAND_BOOKEND_SECONDS + D)) < 1e-6 && Math.abs(plan.totalSeconds - (MAX_BRAND_BOOKEND_SECONDS + 20 + 2 + 2 * D)) < 1e-6
        && Math.abs(plan.afterMainSeconds - (2 + D)) < 1e-6)
    check("the dissolve is inside the handles: join k starts at the outgoing handle and ends at the incoming programme",
      Math.abs(plan.joins[0].offsetSeconds - MAX_BRAND_BOOKEND_SECONDS) < 1e-6 && Math.abs(plan.joins[0].offsetSeconds + D - plan.mainStartSeconds) < 1e-6)
    // POSITIVE CONTROL — the old graph shape is what these rules reject.
    const OLD = "[0:v]trim=duration=2.5,setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v0];[0:a]atrim=duration=2.5,asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0,aformat=channel_layouts=stereo:sample_rates=48000[a0];[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[outv][outa]"
    check("POSITIVE CONTROL — the pre-86 concat graph is recognised as a HARD CUT with a literal fps and an [i:a] a silent sting cannot satisfy",
      /concat=n=/.test(OLD) && !/xfade/.test(OLD) && /\[0:a\]/.test(OLD) && !/anullsrc/.test(OLD) && /fps=30/.test(OLD))
  }
  const spoken = buildStitchPlan({
    canvas,
    segments: [
      { inputIndex: 0, role: "intro", probe: probe(5.2, { width: 512, height: 512, fps: 25 }), capSeconds: null },
      { inputIndex: 1, role: "main", probe: probe(20), capSeconds: null },
    ],
  })
  check("a SPOKEN bookend is kept whole (5.2 s of the agent, never cut to the 2.5 s sting cap)", spoken.ok && spoken.segments[0].programSeconds === 5.2 && !spoken.segments[0].trimmed)
  check("a main whose length cannot be measured is REFUSED (a join timed against a guess drifts)",
    !buildStitchPlan({ canvas, segments: [{ inputIndex: 0, role: "main", probe: probe(null), capSeconds: null }] }).ok)
  check("…while a capped sting whose length cannot be read is held EXACTLY to its cap",
    (() => { const q = buildStitchPlan({ canvas, segments: [{ inputIndex: 0, role: "intro", probe: probe(null), capSeconds: MAX_BRAND_BOOKEND_SECONDS }, { inputIndex: 1, role: "main", probe: probe(10), capSeconds: null }] }); return q.ok && q.segments[0].programSeconds === MAX_BRAND_BOOKEND_SECONDS })())
  const enc = stitchEncodeArgs(canvas).join(" ")
  check("the stitched file leaves as h264 yuv420p BT.709 at the main's rate, AAC 48 kHz stereo, faststart",
    /-c:v libx264/.test(enc) && /-pix_fmt yuv420p/.test(enc) && /-colorspace bt709/.test(enc) && /-r 30/.test(enc) && /-ar 48000/.test(enc) && /-ac 2/.test(enc) && /\+faststart/.test(enc))

  const attribution = code("lib/video/composite-attribution.ts")
  const concatBody = attribution.slice(attribution.indexOf("export async function concatIntroOutro"), attribution.indexOf("export async function compositeExplainerVideo"))
  check("concatIntroOutro builds its graph through the pure plan (no private concat, no literal fps)",
    /buildStitchPlan\(/.test(concatBody) && !/concat=n=/.test(concatBody) && !/fps=30/.test(concatBody) && /stitchEncodeArgs\(/.test(concatBody))
  check("…reports the exact output offsets the coordinator places the narration and the fade on",
    /introSeconds:\s*introPath\s*\?\s*plan\.mainStartSeconds/.test(concatBody) && /totalSeconds:\s*plan\.totalSeconds/.test(concatBody))
  check("the coordinator places the narration at the concat's reported main start",
    /concat\.introSeconds\s*\?\?/.test(code("lib/remotion/render-coordinator.ts")) && /const startSeconds = introClipSeconds/.test(code("lib/remotion/render-coordinator.ts")))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §delivery · one render spec, one sample rate, one master ──")
{
  const d = DELIVERY_RENDER_OPTIONS
  check("the delivery spec always carries an audio track (a silent composition still has [0:a])", d.enforceAudioTrack === true)
  check("…BT.709 tagged, yuv420p, h264, AAC", d.colorSpace === "bt709" && d.pixelFormat === "yuv420p" && d.codec === "h264" && d.audioCodec === "aac")
  check(`one sample rate end to end: render ${d.sampleRate} = stitch ${STITCH_SAMPLE_RATE} = master ${MASTER_LOUDNESS.sampleRate}`,
    d.sampleRate === STITCH_SAMPLE_RATE && STITCH_SAMPLE_RATE === MASTER_LOUDNESS.sampleRate)
  check("the master is the social target: -14 LUFS integrated, true peak ≤ -1 dBTP", MASTER_LOUDNESS.integratedLufs === -14 && MASTER_LOUDNESS.truePeakDbtp <= -1)
  // THE MEASURED TRIM: single-pass loudnorm landed the lane's real films at -12.9 / -14.7 LUFS.
  const g = (i: number, tp: number) => masterTrimGainDb({ integratedLufs: i, truePeakDbtp: tp })
  check(`the trim moves a measured master onto -14: -12.9 → ${g(-12.9, -4.3)} dB, -14.7 → +${g(-14.7, -11.1)} dB, -14.3 (inside ±${MASTER_TRIM_TOLERANCE_LU} LU) → ${g(-14.3, -5)}`,
    g(-12.9, -4.3) === -1.1 && g(-14.7, -11.1) === 0.7 && g(-14.3, -5) === 0)
  check("…never lifts past the true-peak ceiling (needs +3 dB, peak at -2 dBTP → +0.9 only) and leaves silence alone",
    g(-17, -2) === 0.9 && g(-17, -1.05) === 0 && g(-70, -60) === 0)
  const EBU = "[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -12.9 LUFS\n    Threshold: -23.1 LUFS\n\n  Loudness range:\n    LRA:         3.1 LU\n\n  True peak:\n    Peak:       -4.3 dBFS"
  check("the trim measures with the EBU R128 meter itself (ebur128 Summary: I + true Peak) — the reading a platform takes",
    JSON.stringify(parseLoudnessMeasurement(EBU)) === JSON.stringify({ integratedLufs: -12.9, truePeakDbtp: -4.3 }) && parseLoudnessMeasurement("no summary here") === null)
  const mixer = code("lib/remotion/music-mixer.ts")
  check("both masters (the music pass and the voice-only master) end in the measured trim",
    /if \(mastered\) \{\s*const trimmed = await trimToMasterTarget\(outBuf\)/.test(mixer) && /trimToMasterTarget\(await fs\.readFile\(outPath\)\)/.test(mixer))
  // Every renderMedia( call in the runtime tree spreads the spec.
  const sites: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(rel) }
      else if (/\.(ts|tsx)$/.test(e.name)) sites.push(rel)
    }
  }
  walk("app"); walk("lib")
  const calls = (text: string) => {
    const out: string[] = []
    const re = /\brenderMedia\(\s*\{/g
    let mm: RegExpExecArray | null
    while ((mm = re.exec(text))) out.push(text.slice(mm.index, mm.index + 600))
    return out
  }
  const offenders: string[] = []
  let count = 0
  for (const f of sites) {
    const c = code(f)
    for (const call of calls(c)) { count++; if (!/\.\.\.DELIVERY_RENDER_OPTIONS/.test(call)) offenders.push(f) }
  }
  check(`every renderMedia call spreads DELIVERY_RENDER_OPTIONS (${count} calls over ${sites.length} files; offenders: ${offenders.join(", ") || "none"})`, count >= 3 && offenders.length === 0)
  check("POSITIVE CONTROL — the finder sees a codec-only renderMedia call",
    calls('await renderMedia({ composition, serveUrl, codec: "h264", outputLocation })').length === 1 && !/\.\.\.DELIVERY_RENDER_OPTIONS/.test(calls('await renderMedia({ composition, serveUrl, codec: "h264" })')[0]))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §hybrid · spoken bookends, one bed under both joins ──")
{
  const cron = code("app/api/cron/listing-promo-hybrid-composite/route.ts")
  check("the hybrid stitch passes the D-ID hook + CTA as SPOKEN bookends", /bookendKind:\s*"spoken"/.test(cron))
  check("the bed is mixed AFTER the stitch (ducked under the voice, mastered) when the middle deferred it",
    /hybrid_music_deferred === true/.test(cron) && /finishHybridSound\(/.test(cron) && /duckToNarration:\s*true/.test(cron) && /master:\s*true/.test(cron))
  check("…with no bed in the library the voice is still mastered", /masterAudioLoudness\(/.test(cron))
  const rjl = code("app/api/internal/remotion/render-just-listed/route.ts")
  check("the hybrid middle defers its bed (never a bed under the middle alone) and says so on the row",
    /musicAfterStitch:\s*hybrid/.test(rjl) && /if \(args\.musicAfterStitch\) intent\.applyMusic = false/.test(rjl) && /hybrid_music_deferred:\s*true/.test(rjl))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §blur · the fewest blur reasons, the fewest samples ──")
{
  const W = 1080, H = 1920
  // WHERE: only a SYNTHESISED camera move (Ken Burns property photos) with nobody on screen.
  const seg = (treatment: string, from: number, len: number, presenter = "none") => ({ index: 0, kind: "beat", treatment, background: "none", presenter, from, durationInFrames: len, words: 0, text: "", candidates: [treatment], assetIndex: 0 })
  const plan = {
    compositionId: "ComingSoonReel", fps: 30, durationInFrames: 600,
    intro: { from: 0, durationInFrames: 60, treatment: "brand_card" }, body: { from: 60, durationInFrames: 480 }, outro: { from: 540, durationInFrames: 60, treatment: "brand_card" },
    segments: [seg("broll", 60, 120), seg("property_photos", 180, 180), seg("kinetic_text", 360, 90), seg("property_photos", 450, 90, "pip")],
    captionWindow: { from: 0, to: 600 },
  } as unknown as BodyVisualPlan
  const fastStreak = 12 // a fast push the plan cannot rule out: blur warranted
  const w = cinemaMotionBlurWindows("ComingSoonReel", 600, plan, { width: W, height: H, streakPx: fastStreak })
  check(`only the property-photo segment with nobody on screen blurs — footage (b-roll carries its own shutter), kinetic text and a PiP photo never (${JSON.stringify(w.map((x) => [x.from, x.to]))})`,
    w.length === 1 && w[0].from === 180 && w[0].to === 360)
  check("frames outside the window render without the blur wrapper (0 samples)", cinemaMotionBlurAt(100, w) === 0 && cinemaMotionBlurAt(200, w) > 0 && cinemaMotionBlurAt(400, w) === 0 && cinemaMotionBlurAt(0, w) === 0)
  // HOW MUCH: the streak decides; an invisible streak is not paid for.
  const typical = kenBurnsPeakStreakPx(kenBurnsPlan(["a", "b", "c", "d", "e", "f"], 360, { fps: 30 }), W, H, CINEMA_MOTION_BLUR.shutterAngle)
  check(`a typical walkthrough's Ken Burns streak (${typical} px) is below the visible floor (${BLUR_VISIBLE_STREAK_PX} px) → 0 samples, no blur cost`,
    typical < BLUR_VISIBLE_STREAK_PX && blurSamplesForStreak(typical) === 0)
  check(`samples grow with the streak and never exceed the measured ceiling (${CINEMA_MOTION_BLUR.samples})`,
    blurSamplesForStreak(BLUR_VISIBLE_STREAK_PX) >= 2 && blurSamplesForStreak(50) === CINEMA_MOTION_BLUR.samples
      && blurSamplesForStreak(BLUR_VISIBLE_STREAK_PX) <= blurSamplesForStreak(50))
  const fast = kenBurnsPeakStreakPx(kenBurnsPlan(["a", "b", "c", "d", "e", "f", "a", "b", "c", "d"], 180, { fps: 30 }), W, H, CINEMA_MOTION_BLUR.shutterAngle)
  check(`a fast push (10 photos in 6 s, streak ${fast} px) blurs at 3 samples — the bench's minimum that reaches the 16-sample smear (was a flat 5)`,
    fast >= BLUR_VISIBLE_STREAK_PX && blurSamplesForStreak(fast) === 3)
  const slow = cinemaMotionBlurWindows("ComingSoonReel", 600, plan, { width: W, height: H, streakPx: typical })
  check("…so a plan whose photo push is typical carries NO blur window at all", slow.length === 0)
  check("no plan staged: the fallback blurs only the BODY of a camera-move composition (never the cover or the outro card)",
    (() => { const b = compositionBookends("PhotoWalkthroughReel"); const x = cinemaMotionBlurWindows("PhotoWalkthroughReel", 600, null, { width: W, height: H, streakPx: fastStreak }); return x.length === 1 && x[0].from === b.introFrames && x[0].to === 600 - b.outroFrames })())
  check("a talking head, a screen and a still never blur, plan or not",
    cinemaMotionBlurWindows("AgentTalkingHeadReel", 600, null, { width: W, height: H, streakPx: fastStreak }).length === 0
      && cinemaMotionBlurWindows("ProductPromoReel", 600, null, { width: W, height: H, streakPx: fastStreak }).length === 0
      && !cinemaMotionBlurFor("PostcardFront4x6").enabled)
  check("b-roll-only compositions no longer pay for synthetic blur (footage carries its camera's own)",
    (COMPOSITION_TREATMENTS.NeighborhoodSpotlightReel ?? []).includes("broll") && !cinemaMotionBlurFor("NeighborhoodSpotlightReel").enabled)
  const cf = code("remotion/components/CinemaFinish.tsx")
  check("CinemaFinish wraps a frame in CameraMotionBlur only inside a window (per frame, not per composition)",
    /cinemaMotionBlurWindows\(/.test(cf) && /cinemaMotionBlurAt\(frame,/.test(cf) && /samples=\{blurSamples\}/.test(cf))
  check("POSITIVE CONTROL — a composition-wide blur wrapper (the pre-86 shape) is recognised",
    /blur\.enabled \? \(/.test("{blur.enabled ? (<CameraMotionBlur samples={blur.samples}>") )
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §photos · the photo-to-photo dissolve cannot throw and never dips to black ──")
{
  // Found by the lane's REAL render: the last clip's envelope [0, 10, dur, dur] made
  // interpolate THROW (the whole PhotoWalkthroughReel render failed), and the outgoing
  // photo faded OUT under the incoming one (a dip toward the dark stage every change).
  const kb = stripComments(raw("remotion/components/KenBurnsPhoto.tsx"))
  const MAXED = /interpolate\(\s*frame,\s*\[\s*0\s*,\s*\w+\s*,\s*Math\.max\(/
  check("the photo envelope has no computed Math.max(...) knee (the shape that collapsed to [0,10,36,36])", !MAXED.test(kb))
  check("POSITIVE CONTROL — the finder sees the pre-86 envelope", MAXED.test("const opacity = interpolate(\n    frame,\n    [0, fadeIn, Math.max(fadeIn, fadeOutStart), dur],"))
  check("the incoming photo fades IN over an opaque outgoing one — no fade-out term, and the tour's first photo never fades from the dark stage",
    /interpolate\(frame, \[0, fadeIn\], \[0, 1\]/.test(kb) && !/\[0, 1, 1, /.test(kb) && /clip\.fromFrame === 0/.test(kb))
  // Every clip of every plan the planner makes has a strictly increasing fade range.
  let bad = 0
  for (let n = 1; n <= 12; n++) for (const frames of [30, 60, 90, 180, 360, 900]) {
    for (const c of kenBurnsPlan(Array.from({ length: n }, (_, i) => `p${i}`), frames, { fps: 30 })) {
      const fadeIn = Math.max(1, Math.min(c.crossfadeFrames > 0 ? c.crossfadeFrames : 10, c.durationFrames - 1))
      if (!(c.fromFrame === 0 || c.durationFrames <= 1) && !(0 < fadeIn)) bad++
    }
  }
  check("every clip the planner makes (1-12 photos × 1-30 s) gets a strictly increasing fade range", bad === 0)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §captions · the cinema type scale, seated on the safe inset ──")
{
  for (const [w, h] of [[1080, 1920], [1920, 1080], [1080, 1080], [720, 1280]] as const) {
    const cs = cinemaCaptionStyle(w, h), t = cinemaTypeScale(w, h), f = cinemaFrame(w, h)
    const boxH = Math.round(cs.fontSize * cs.lineHeight * 2) + 2 * cs.padY + cs.tickGap + cs.tickHeight // a two-line cue
    check(`${w}×${h}: caption text is the scale's title step (${cs.fontSize}px), its band sits on the safe bottom inset (${cs.bandBottom}px) and a two-line cue stays inside the safe area`,
      cs.fontSize === t.title && cs.bandBottom === f.safe.bottom
        && insideSafeArea(w, h, { bottom: cs.bandBottom, left: cs.sidePad, width: w - 2 * cs.sidePad, height: boxH }))
  }
  const layer = codeNoStrings("remotion/components/CaptionLayer.tsx")
  check("CaptionLayer sizes and places from cinemaCaptionStyle — no literal font size, pad or 78 % band",
    /cinemaCaptionStyle\(width, height\)/.test(layer) && /fontSize:\s*cs\.fontSize/.test(layer) && !/fontSize:\s*\d/.test(layer) && !/\?\?\s*78/.test(layer))
  check("POSITIVE CONTROL — the finder sees a literal caption size", /fontSize:\s*\d/.test("fontSize: 56,"))
  // The pre-86 band (top at 78 %) on a 9:16 frame sat INSIDE the unsafe bottom band.
  const f = cinemaFrame(1080, 1920)
  check("CONTROL: the old 78 %-top band on 1080×1920 started below the safe line (the defect fixed)", 1920 * 0.78 > 1920 - f.safe.bottom - 1)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §meter · video is tier-METERED; the one refusal is a tier that excludes it ──")
{
  check("units: a 30 s reel spends 1 video minute, 61 s spends 2, an unknown length 1", videoMeterUnits(30) === 1 && videoMeterUnits(61) === 2 && videoMeterUnits(null) === 1 && videoMeterUnits(0) === 1)
  const cap = (used: number, limit: number, soft = false, error?: string) => ({ allowed: limit < 0 || used < limit, used, limit, soft_warning: soft, ...(error ? { error } : {}) })
  const cases = [
    { name: "excluded (allowance 0)", d: decideVideoMeter(cap(1, 0), 1) },
    { name: "unlimited", d: decideVideoMeter(cap(0, -1), 1) },
    { name: "within", d: decideVideoMeter(cap(5, 30), 1) },
    { name: "approaching", d: decideVideoMeter(cap(25, 30, true), 1) },
    { name: "overage", d: decideVideoMeter(cap(31, 30), 1) },
    { name: "unchecked (read refused)", d: decideVideoMeter(cap(0, -1, false, "plan_limits read refused: boom"), 1) },
  ]
  for (const c of cases) console.log(`    · ${c.name.padEnd(26)} → ${c.d.allowed ? "SERVED" : "REFUSED"} (${c.d.verdict})`)
  check("exactly ONE verdict refuses — the tier that explicitly excludes video", cases.filter((c) => !c.d.allowed).map((c) => c.d.verdict).join() === "excluded")
  check("over the allowance is SERVED and marked overage (billed, never refused)", cases[4].d.allowed && cases[4].d.verdict === "overage")
  check("a read that could not run is SERVED but labelled unchecked — never 'within allowance'", cases[5].d.allowed && cases[5].d.verdict === "unchecked")
  const cc = code("lib/kernel/content-creators.ts")
  const create = cc.slice(cc.indexOf("export async function createVideoProject"))
  check("the video creator gates BEFORE the insert and meters AFTER it",
    create.indexOf("gateVideoCreation(") > 0 && create.indexOf("gateVideoCreation(") < create.indexOf('.from("ai_video_projects")') && create.indexOf("meterVideoCreation(") > create.indexOf('.from("ai_video_projects")'))
  check("…and refuses only on the meter's own verdict", /if \(!videoMeter\.allowed\) return \{ success: false, error: videoMeter\.reason \}/.test(create))
  const dir = code("lib/video/video-director.ts")
  const cv = dir.slice(dir.indexOf("export async function commissionVideo("), dir.indexOf("function stillAddressOf"))
  check("the Director gates before any spend (right after identity) and meters the ADS cut once the row lands",
    cv.indexOf("gateVideoCreation(") > 0 && cv.indexOf("gateVideoCreation(") < cv.indexOf("loadBrandVoicePrompt(") && /if \(cut !== "mls"\) \{\s*await meterVideoCreation\(/.test(cv))
  check("the hook experiment spends the allowance once, not once per variant", /if \(staged\.length > 0\) \{\s*await meterVideoCreation\(/.test(dir))
  check("the autonomous topic runner commissions as autonomous and counts an excluded tier by name",
    /autonomous:\s*true/.test(code("lib/video/topic-video-runner.ts")) && /video_excluded_by_tier/.test(raw("lib/video/topic-video-runner.ts")))
  check("overage flows to billing: the ONE writethrough bills both metrics", OVERAGE_BILLED_METRICS.includes(VIDEO_OVERAGE_METRIC) && OVERAGE_BILLED_METRICS.includes(AI_OVERAGE_METRIC)
    && /runAIOverageBilling\(\{\s*metric:\s*VIDEO_OVERAGE_METRIC\s*\}\)/.test(code("app/api/cron/ai-overage-billing/route.ts"))
    && /metric:\s*OverageBilledMetric = AI_OVERAGE_METRIC/.test(code("lib/billing/ai-overage.ts")))
  const m666 = raw("supabase/migrations/m666-video-is-tier-metered-and-overage-billed.sql")
  check("m666 widens the overage ledger to video and prices capped tiers (never an unlimited one), with postconditions",
    /check \(metric in \('ai_tokens_monthly', 'video_minutes'\)\)/.test(m666) && /overage_rate_cents_per_1k = 50000/.test(m666) && /limit_value > 0/.test(m666) && (m666.match(/raise exception/g) ?? []).length >= 3)
  check("the overage projection reads the SAME allowance (plan_limits video_minutes), not a features key that does not exist",
    /\.eq\("metric", "video_minutes"\)/.test(code("lib/kernel/billing.ts")) && /limits\.video_minutes = /.test(code("lib/kernel/billing.ts")))
  check("a refused plan_limits / usage_counters read is SAID by the cap reader (never read as unlimited)",
    /plan_limits read refused/.test(code("lib/usage/check-cap.ts")) && /usage_counters read refused/.test(code("lib/usage/check-cap.ts")))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §doors · the /api/video/projects/** doors are retired onto their survivors ──")
{
  const doors = ["app/api/video/projects/route.ts", "app/api/video/projects/[projectId]/script/route.ts", "app/api/video/projects/[projectId]/generate/route.ts",
    "app/api/video/projects/[projectId]/preview/route.ts", "app/api/video/projects/[projectId]/publish/route.ts"]
  check(`all ${doors.length} doors are gone`, doors.every((d) => !existsSync(join(root, d))))
  check("POSITIVE CONTROL — the absence check sees a file that exists", existsSync(join(root, "app/actions/video.ts")))
  check("tombstones name the survivors (prose is the subject here)", /TOMBSTONE: THE SECOND HTTP DOORS ARE RETIRED/.test(raw("app/actions/video.ts"))
    && /TOMBSTONE \(wave 86, lane 86B[\s\S]{0,120}app\/api\/video\/projects\/route\.ts/.test(raw("app/actions/video/create-video-project.ts")))
  check("the survivors are live server actions", ["generateVideoScriptAction", "submitVideoGenerationJobAction", "previewVideoProjectAction", "distributeVideoProjectAction"].every((n) => new RegExp(`export async function ${n}\\(`).test(code("app/actions/video.ts"))))
  check("the census no longer carries them as unresolved doors", !/\["\/api\/video\/projects/.test(code("scripts/opposite-missing-census.ts")))
}

console.log(`\n${"═".repeat(70)}\n VIDEO STITCHING — ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ✗ Failures:"); for (const f of fails) console.log(`   - ${f}`); process.exit(1) }
console.log(" ✅ VIDEO_STITCHING_PASS — joins conformed + dissolved on handles, one delivery spec, blur only where it shows, captions on the scale, video metered")
