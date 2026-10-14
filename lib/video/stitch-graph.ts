// lib/video/stitch-graph.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE STITCH — the PURE half of lib/video/composite-attribution.ts
// concatIntroOutro (wave 86, lane 86B). Same split as lib/remotion/
// music-filter-graph.ts: the filter graph is built here as a string a proof can
// assert (scripts/video-stitching-simulator.ts) without spawning ffmpeg; the
// impure half probes the files, runs the graph and returns the bytes.
//
// OWNER (2026-09-27, verbatim): "videos need to be professionally completed
// especially when stiching the full video together without any hiccups. A
// motion picture production video when finished."
//
// WHAT WAS WRONG WITH THE OLD concat=n=N (measured in the lane-86B render, see
// the notes): a HARD CUT at every join; the frame rate forced to a literal 30
// whatever the main render was; a segment with NO audio stream (a silent stock
// sting, or a Remotion render of a composition that plays no <Audio>) made
// `[i:a]` invalid, so the WHOLE stitch failed and the bookends silently never
// landed; a bookend trimmed to MAX_BRAND_BOOKEND_SECONDS was cut mid-waveform
// (a click) and mid-animation; a SPOKEN bookend (the D-ID hook and CTA of the
// listing-promo hybrid) was cut to 2.5 s — the agent stopped mid-sentence; and
// a mismatched aspect (a 512² D-ID clip on a 1080×1920 reel) got black bars.
//
// WHAT A JOIN IS NOW — a dissolve on HANDLES (the editor's term: extra frames
// either side of a cut that a transition may consume). Each segment is
// conformed (canvas, SAR 1, the MAIN render's fps, yuv420p, BT.709; audio
// 48 kHz stereo fltp), cut to an EXACT length (video tpad-clone + trim, audio
// apad + atrim, so a segment's picture and sound are the same length and the
// next join cannot drift), given JOIN_DISSOLVE_SECONDS of held-frame + silence
// handle on each inner side, and joined with xfade (video) + acrossfade (audio)
// of that same length. The dissolve therefore consumes ONLY the handles: no
// programme frame and no syllable is faded, eaten or shifted, and every join
// is a 0.4 s dissolve between the outgoing last frame and the incoming first
// frame — which, for a Remotion main, is the brand-colour field CinemaFinish
// fades in from and out to (lib/video/cinema-finish.ts § HEAD / TAIL). The
// music bed is mixed AFTER the stitch (render-coordinator; the hybrid cron),
// so it runs continuously under every join and ducks under the speech.
//
// Research (lane 86B, Exa): ffmpeg filters doc (acrossfade "cross fade … near
// the end of first stream"; concat "a desync will happen at the stitch if the
// audio and video streams do not have exactly the same duration"); stackoverflow
// 64696381 (xfade + acrossfade desync — the fix is `apad,atrim` to the video
// length per segment) and 63125583 (xfade needs a common timebase — the fps
// filter sets 1/fps on every link); peachgum 2026-04 (6-12 frame transitions).
//
// PURE. No I/O, no ffmpeg, no server-only.

/** Every inner join is a dissolve this long, taken from handles (12 frames at 30 fps). */
export const JOIN_DISSOLVE_SECONDS = 0.4

/** A trimmed (cut mid-programme) edge fades its SOUND out over this — no click, no chopped note. */
export const TRIM_AUDIO_FADE_SECONDS = 0.25

/** Every programme edge gets a de-click ramp this long (a sample-level fade, inaudible). */
export const DECLICK_SECONDS = 0.012

/** The delivery audio format every segment is conformed to (the AAC/video convention). */
export const STITCH_SAMPLE_RATE = 48000

/** Two frame shapes are "the same" within this relative tolerance (1080×1920 vs 1080×1918). */
const ASPECT_TOLERANCE = 0.01

export type StitchRole = "intro" | "main" | "outro"

/**
 * How a bookend is treated:
 *   · "brand_sting" — a brokerage-curated stock clip; capped at MAX_BRAND_BOOKEND_SECONDS
 *     (wave 56 realism ruling) and its trimmed edge faded, picture and sound.
 *   · "spoken"      — a presenter SPEAKING (the listing-promo hybrid's D-ID hook and CTA).
 *     NEVER trimmed: cutting a person off mid-sentence is the hiccup, not the fix.
 */
export type BookendKind = "brand_sting" | "spoken"

/** What `ffmpeg -i <file>` said about one input (parseFfmpegProbe). */
export interface MediaProbe {
  durationSeconds: number | null
  width: number | null
  height: number | null
  fps: number | null
  hasAudio: boolean
  /** The video stream's colour matrix tag, when the file carries one (bt709, bt470bg, smpte170m …). */
  colorMatrix: string | null
}

export interface StitchSegmentInput {
  /** The ffmpeg input index this segment is read from. */
  inputIndex: number
  role: StitchRole
  probe: MediaProbe
  /** Cap on the programme length (a brand sting's MAX_BRAND_BOOKEND_SECONDS); null = never trimmed. */
  capSeconds: number | null
}

export interface StitchCanvas { width: number; height: number; fps: number }

export interface StitchSegmentPlan {
  inputIndex: number
  role: StitchRole
  /** The EXACT programme length this segment contributes (seconds, before handles). */
  programSeconds: number
  /** True when the cap cut the source short (the sound fades out; the dissolve carries the picture). */
  trimmed: boolean
  headHandleSeconds: number
  tailHandleSeconds: number
  /** The segment's source frame shape differs from the canvas → blurred cover fill, not bars. */
  fill: "direct" | "blurred_cover"
  /** No audio stream in the source → an in-graph silent source of the exact length. */
  synthesizedSilence: boolean
}

export interface StitchJoin {
  /** Seconds into the OUTPUT where the dissolve starts. */
  offsetSeconds: number
  durationSeconds: number
  between: [StitchRole, StitchRole]
}

export interface StitchPlan {
  ok: true
  canvas: StitchCanvas
  segments: StitchSegmentPlan[]
  joins: StitchJoin[]
  /** Output seconds before the MAIN programme's first frame (intro + its dissolve). */
  mainStartSeconds: number
  /** Output seconds after the MAIN programme's last frame (dissolve + outro). */
  afterMainSeconds: number
  totalSeconds: number
  filter: string
}

export type StitchPlanResult = StitchPlan | { ok: false; reason: string }

const r3 = (n: number) => Number(n.toFixed(3))

/**
 * PURE: parse the stderr of `ffmpeg -hide_banner -i <file>` (ffmpeg-static ships no
 * ffprobe; the compositor has always read this text — composite-attribution.ts
 * probeDimensions / probeDuration). One pass, every fact the stitch needs.
 */
export function parseFfmpegProbe(stderr: string): MediaProbe {
  const dur = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  const durationSeconds = dur ? r3(parseInt(dur[1], 10) * 3600 + parseInt(dur[2], 10) * 60 + parseFloat(dur[3])) : null
  const videoLine = stderr.split("\n").find((l) => /Stream #\d+:\d+.*Video:/.test(l)) ?? ""
  const dims = videoLine.match(/, (\d{2,5})x(\d{2,5})[,\s]/)
  // "29.97 fps" / "30 fps" / "25 tbr" — fps first, the tbr (a guess) only as a fallback.
  const fpsM = videoLine.match(/, (\d+(?:\.\d+)?) fps/) ?? videoLine.match(/, (\d+(?:\.\d+)?) tbr/)
  const colorM = videoLine.match(/yuv\w*\((?:tv|pc)?,?\s*([a-z0-9]+)/i)
  return {
    durationSeconds: durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
    width: dims ? parseInt(dims[1], 10) : null,
    height: dims ? parseInt(dims[2], 10) : null,
    fps: fpsM ? Number(parseFloat(fpsM[1]).toFixed(3)) : null,
    hasAudio: /Stream #\d+:\d+.*Audio:/.test(stderr),
    colorMatrix: colorM && !/^(tv|pc|progressive)$/i.test(colorM[1]) ? colorM[1].toLowerCase() : null,
  }
}

/** The canvas every segment is conformed to: the MAIN render's own shape and rate. */
export function stitchCanvasFrom(main: MediaProbe): StitchCanvas {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2) // h264 4:2:0 needs even dimensions
  return {
    width: even(main.width ?? 1280),
    height: even(main.height ?? 720),
    fps: main.fps && main.fps > 0 && main.fps <= 120 ? main.fps : 30,
  }
}

function sameAspect(p: MediaProbe, c: StitchCanvas): boolean {
  if (!p.width || !p.height) return true // unknown shape: fit directly (the old behaviour), never guess a fill
  return Math.abs(p.width / p.height - c.width / c.height) / (c.width / c.height) <= ASPECT_TOLERANCE
}

/**
 * PURE: plan every segment's exact length + handles and build the whole
 * `-filter_complex` graph ending in `[outv]` / `[outa]`.
 *
 * Refuses (ok:false, with the reason) rather than guessing when a length it
 * needs is unknown: a join offset computed from a guessed duration is exactly
 * the desync this module exists to remove. A capped bookend whose length could
 * not be read is held to its cap (tpad-clone + apad make the length EXACT), so
 * only an unmeasurable MAIN or SPOKEN bookend refuses.
 */
export function buildStitchPlan(input: {
  segments: StitchSegmentInput[]
  canvas: StitchCanvas
  joinSeconds?: number
}): StitchPlanResult {
  const { canvas } = input
  const D = Math.max(0, input.joinSeconds ?? JOIN_DISSOLVE_SECONDS)
  const segs = input.segments
  if (segs.length === 0) return { ok: false, reason: "no segments" }
  if (segs.filter((s) => s.role === "main").length !== 1) return { ok: false, reason: "exactly one main segment is required" }

  const planned: StitchSegmentPlan[] = []
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k]
    const cap = s.capSeconds !== null && s.capSeconds > 0 ? s.capSeconds : null
    const measured = s.probe.durationSeconds
    let programSeconds: number
    let trimmed = false
    if (measured === null) {
      if (cap === null) return { ok: false, reason: `could not measure the ${s.role} segment's length — a join timed against a guess would drift` }
      programSeconds = cap
    } else if (cap !== null && measured > cap) {
      programSeconds = cap
      trimmed = true
    } else {
      programSeconds = measured
    }
    planned.push({
      inputIndex: s.inputIndex,
      role: s.role,
      programSeconds: r3(programSeconds),
      trimmed,
      // Handles only exist to be consumed by a dissolve; a zero-length join needs none.
      headHandleSeconds: k > 0 && D > 0 ? D : 0,
      tailHandleSeconds: k < segs.length - 1 && D > 0 ? D : 0,
      fill: sameAspect(s.probe, canvas) ? "direct" : "blurred_cover",
      synthesizedSilence: !s.probe.hasAudio,
    })
  }

  const W = canvas.width
  const H = canvas.height
  const F = canvas.fps
  const parts: string[] = []
  planned.forEach((p, k) => {
    const i = p.inputIndex
    const L = p.programSeconds
    // ── picture ──
    const fitted = p.fill === "direct"
      ? `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease:out_color_matrix=bt709:out_range=tv,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${F},format=yuv420p[vf${k}]`
      : // A different frame shape: the picture FITS over a softened COVER of itself — the
        // social-video convention, never black bars. One split, one blur, on this segment only.
        `[${i}:v]split=2[vbg${k}][vfg${k}];` +
        `[vbg${k}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=luma_radius=24:luma_power=2,eq=brightness=-0.06[vbgb${k}];` +
        `[vfg${k}]scale=${W}:${H}:force_original_aspect_ratio=decrease[vfgs${k}];` +
        `[vbgb${k}][vfgs${k}]overlay=(W-w)/2:(H-h)/2,scale=out_color_matrix=bt709:out_range=tv,setsar=1,fps=${F},format=yuv420p[vf${k}]`
    parts.push(fitted)
    // EXACT length, handles included, in ONE pad + ONE cut: the head handle is the
    // first frame held, the stream is padded past its end with its last frame held,
    // then cut to head + programme + tail. (Measured on ffmpeg 7.0.2: a tpad placed
    // AFTER a trim adds NOTHING — the lane's second real stitch came out with the
    // picture 5.7 s shorter than the sound — so the handles are padded before the cut.)
    // A capped sting's tail handle therefore shows its own next frames under the
    // dissolve (a real dissolve) while its sound has already faded; a programme that
    // ends on its own (the main, a spoken bookend) holds its last frame. A trimmed
    // picture is never faded to a colour: on a yuv420p link that colour is black.
    const head = p.headHandleSeconds, tail = p.tailHandleSeconds
    const vStages: string[] = [
      `tpad=${head > 0 ? `start_mode=clone:start_duration=${head}:` : ""}stop_mode=clone:stop_duration=${r3(L + tail + 1)}`,
      `trim=duration=${r3(head + L + tail)}`,
      "setpts=PTS-STARTPTS",
      // trim/tpad leave the link's frame rate UNKNOWN (1/0) and xfade refuses a
      // non-constant rate ("The inputs needs to be a constant frame rate") — the
      // lane's first real stitch failed exactly here. Re-state the rate last.
      `fps=${F}`,
    ]
    parts.push(`[vf${k}]${vStages.join(",")}[v${k}]`)
    // ── sound ──
    const src = p.synthesizedSilence
      ? `anullsrc=r=${STITCH_SAMPLE_RATE}:cl=stereo,atrim=duration=${L}[as${k}]`
      : `[${i}:a]aresample=${STITCH_SAMPLE_RATE}:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=${STITCH_SAMPLE_RATE}:channel_layouts=stereo[as${k}]`
    parts.push(src)
    const aStages: string[] = [
      // EXACT length, the same number as the picture (the concat-desync fix).
      "apad", `atrim=duration=${L}`, "asetpts=PTS-STARTPTS",
      `afade=t=in:st=0:d=${DECLICK_SECONDS}`,
      p.trimmed
        ? `afade=t=out:st=${r3(Math.max(0, L - TRIM_AUDIO_FADE_SECONDS))}:d=${TRIM_AUDIO_FADE_SECONDS}`
        : `afade=t=out:st=${r3(Math.max(0, L - DECLICK_SECONDS))}:d=${DECLICK_SECONDS}`,
    ]
    if (p.headHandleSeconds > 0) aStages.push(`adelay=${Math.round(p.headHandleSeconds * 1000)}:all=1`)
    if (p.tailHandleSeconds > 0) aStages.push(`apad=pad_dur=${p.tailHandleSeconds}`)
    parts.push(`[as${k}]${aStages.join(",")}[a${k}]`)
  })

  // ── joins: xfade + acrossfade of the SAME length, offsets from exact lengths ──
  const joins: StitchJoin[] = []
  let accLen = planned[0].programSeconds + planned[0].headHandleSeconds + planned[0].tailHandleSeconds
  let vPrev = "[v0]"
  let aPrev = "[a0]"
  for (let k = 1; k < planned.length; k++) {
    const p = planned[k]
    const segLen = p.programSeconds + p.headHandleSeconds + p.tailHandleSeconds
    const offset = r3(accLen - D)
    const last = k === planned.length - 1
    const vOut = last ? "[outv]" : `[vx${k}]`
    const aOut = last ? "[outa]" : `[ax${k}]`
    if (D > 0) {
      parts.push(`${vPrev}[v${k}]xfade=transition=fade:duration=${D}:offset=${offset}${vOut}`)
      parts.push(`${aPrev}[a${k}]acrossfade=d=${D}:c1=tri:c2=tri${aOut}`)
    } else {
      // A zero-length join is a straight (still exact-length, still de-clicked) cut.
      parts.push(`${vPrev}${aPrev}[v${k}][a${k}]concat=n=2:v=1:a=1${vOut}${aOut}`)
    }
    joins.push({ offsetSeconds: offset, durationSeconds: D, between: [planned[k - 1].role, p.role] })
    accLen = r3(accLen + segLen - D)
    vPrev = vOut
    aPrev = aOut
  }
  if (planned.length === 1) {
    parts.push("[v0]null[outv]")
    parts.push("[a0]anull[outa]")
  }

  const mainIdx = planned.findIndex((p) => p.role === "main")
  // Output time where the main programme's FIRST frame plays: everything before it,
  // minus one dissolve per join already crossed, plus main's own head handle.
  let mainStart = 0
  for (let k = 0; k < mainIdx; k++) {
    mainStart += planned[k].programSeconds + planned[k].headHandleSeconds + planned[k].tailHandleSeconds - D
  }
  mainStart += planned[mainIdx].headHandleSeconds
  const total = r3(accLen)
  const mainEnd = mainStart + planned[mainIdx].programSeconds
  return {
    ok: true,
    canvas,
    segments: planned,
    joins,
    mainStartSeconds: r3(mainStart),
    afterMainSeconds: r3(total - mainEnd),
    totalSeconds: total,
    filter: parts.join(";"),
  }
}

/** The encoder arguments every stitched file leaves with (one place, §6). */
export function stitchEncodeArgs(canvas: StitchCanvas): string[] {
  return [
    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
    "-pix_fmt", "yuv420p", "-r", String(canvas.fps),
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-c:a", "aac", "-b:a", "192k", "-ar", String(STITCH_SAMPLE_RATE), "-ac", "2",
    "-movflags", "+faststart",
  ]
}
