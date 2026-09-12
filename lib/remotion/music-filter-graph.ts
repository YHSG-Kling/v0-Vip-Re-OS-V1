/**
 * lib/remotion/music-filter-graph.ts
 *
 * THE PURE HALF of lib/remotion/music-mixer.ts's ffmpeg filter graph — split
 * out so it can be imported by a proof (scripts/video-assembly-simulator.ts)
 * without dragging in `server-only`, `ffmpeg-static`, `child_process`, or a
 * network fetch. music-mixer.ts re-exports these names unchanged, so every
 * existing caller of `buildMusicTrackFilter`/`buildMusicMixFilterGraph` is
 * unaffected — this is a move, not a new implementation (§6: one filter
 * graph, one place it is built).
 *
 * See music-mixer.ts's header for why the fades exist (wave 48 audit) and what
 * `videoSeconds` is for. PURE — no I/O, no ffmpeg, no server-only.
 */

/** Default fade lengths (seconds). Short enough to stay invisible at any
 *  composition length (the shortest music-eligible reel is 12s — ComingSoonReel
 *  — so 1.2s in / 1.5s out never overlaps at typical volumes), long enough that
 *  neither edge reads as a hard cut. */
export const DEFAULT_MUSIC_FADE_IN_SECONDS = 1.2
export const DEFAULT_MUSIC_FADE_OUT_SECONDS = 1.5

export interface MusicFilterGraphInput {
  /** Loop the music to fill the video if the track is shorter. */
  loop: boolean
  /** 0-1, already clamped by the caller. */
  volume: number
  /**
   * Seconds of the video this music is being mixed onto (composition +
   * bookends). Required to time the fade-OUT against the real end of the
   * track; when absent (or non-positive) the graph fades in only — a fade-out
   * timed against an unknown length could as easily clip the middle of the
   * track as the tail, which is worse than no fade-out.
   */
  videoSeconds?: number | null
  fadeInSeconds?: number
  fadeOutSeconds?: number
}

/**
 * The `[1:a] → [a1]` filter chain: loop (optional) → volume → fade-in →
 * fade-out (when `videoSeconds` is known and longer than both fades combined).
 *
 * PURE. No ffmpeg, no I/O — the whole point is that this string can be
 * asserted directly (scripts/video-assembly-simulator.ts) without spawning a
 * binary or fetching a track.
 */
export function buildMusicTrackFilter(input: MusicFilterGraphInput): string {
  const volume = Math.max(0, Math.min(1, input.volume))
  const fadeIn = Math.max(0, input.fadeInSeconds ?? DEFAULT_MUSIC_FADE_IN_SECONDS)
  const fadeOut = Math.max(0, input.fadeOutSeconds ?? DEFAULT_MUSIC_FADE_OUT_SECONDS)
  const videoSeconds = Number.isFinite(input.videoSeconds) && (input.videoSeconds as number) > 0
    ? (input.videoSeconds as number)
    : null

  const stages: string[] = []
  stages.push(input.loop ? "aloop=loop=-1:size=2147483647" : null as unknown as string)
  stages.push(`volume=${volume.toFixed(2)}`)
  if (fadeIn > 0) stages.push(`afade=t=in:st=0:d=${fadeIn.toFixed(2)}`)
  // Only time a fade-out against a REAL video length, and only when there is
  // room for it (a track shorter than both fades combined skips the fade-out
  // rather than emitting a negative start time).
  if (fadeOut > 0 && videoSeconds !== null && videoSeconds > fadeIn + fadeOut) {
    const start = videoSeconds - fadeOut
    stages.push(`afade=t=out:st=${start.toFixed(2)}:d=${fadeOut.toFixed(2)}`)
  }
  return `[1:a]${stages.filter(Boolean).join(",")}[a1]`
}

/** The full `-filter_complex` graph: the track filter above, mixed with the
 *  video's own audio at [0:a]. PURE — same reason as buildMusicTrackFilter. */
export function buildMusicMixFilterGraph(input: MusicFilterGraphInput): string {
  return [
    buildMusicTrackFilter(input),
    `[0:a][a1]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
  ].join(";")
}

// ── SIDECHAIN DUCKING (wave 58, video-realism audit) ────────────────────────
// TOMBSTONE-ADJACENT NOTE (not a tombstone — nothing is deleted here): the
// realism-profile.ts research header (MUSIC / DUCKING section) named this gap
// explicitly: "This repo's mixer applies one constant level for the whole
// track rather than a sidechain... attack/release has no analog here —
// recorded as a real gap." `buildMusicDuckFilterGraph` below is that gap
// closed. It reuses `buildMusicTrackFilter` UNCHANGED (loop/volume/fades — the
// pre-gain "bed" level, the SAME musicVolumePct a caller already resolves, own
// row value or MUSIC_DUCK_VOLUME_PCT fallback) and adds ONE new stage:
// `sidechaincompress` keyed off the NARRATION track at [0:a] — the same
// channel `buildMusicMixFilterGraph` already mixes against, and by the time
// this runs in render-coordinator.ts it already carries the mixed-in
// narration (mixNarrationVoiceover runs before the music pass). The bed
// volume is unchanged; what changes is that the bed now dips FURTHER while
// speech is present and returns to that same bed level in the gaps, instead
// of sitting at one flat scale for the whole track — "ducks under speech"
// becomes a real per-sample decision instead of a constant multiply.
//
// Tuning (lib/video/realism-profile.ts MUSIC_SIDECHAIN_DUCK_SETTINGS,
// research-derived — see that file's header) sits inside ffmpeg's own
// documented `sidechaincompress` ranges (threshold 0.00097563-1 linear,
// ratio 1-20, attack/release in ms, makeup 1-64 linear) — every value below
// is clamped to that filter's actual accepted range so an out-of-range
// constant cannot silently produce a filter ffmpeg refuses to run.

/** dB → linear amplitude (the unit ffmpeg's audio filters — volume=,
 *  sidechaincompress's threshold/makeup — actually take). PURE arithmetic,
 *  no filter-specific clamping (callers clamp to the filter's own range). */
export function dbToLinearAmplitude(db: number): number {
  return Math.pow(10, db / 20)
}

export interface SidechainDuckSettings {
  /** dB (negative). Sidechain (narration) level above which ducking starts. */
  thresholdDb: number
  /** 1-20. Compression ratio applied once the narration crosses threshold. */
  ratio: number
  /** ms. How fast the music dips once speech starts. */
  attackMs: number
  /** ms. How fast the music returns to the bed level once speech stops. */
  releaseMs: number
  /** dB. Gain restored after compression. 0 = no makeup (the default — avoids
   *  the ducked-then-boosted track reading louder than the bed level chosen). */
  makeupDb?: number
}

export interface MusicDuckFilterGraphInput extends MusicFilterGraphInput {
  duck: SidechainDuckSettings
}

/** ffmpeg's own accepted ranges for `sidechaincompress` (libavfilter/
 *  af_sidechaincompress.c) — clamped to here so a bad constant cannot produce
 *  a filter string ffmpeg refuses to run at spawn time. */
const SIDECHAIN_THRESHOLD_RANGE: [number, number] = [0.00097563, 1]
const SIDECHAIN_RATIO_RANGE: [number, number] = [1, 20]
const SIDECHAIN_ATTACK_MS_RANGE: [number, number] = [0.01, 2000]
const SIDECHAIN_RELEASE_MS_RANGE: [number, number] = [0.01, 9000]
const SIDECHAIN_MAKEUP_RANGE: [number, number] = [1, 64]
const clamp = (v: number, [lo, hi]: [number, number]) => Math.max(lo, Math.min(hi, v))

/**
 * The DYNAMIC-ducking `-filter_complex` graph: the same bed-level track chain
 * as `buildMusicMixFilterGraph` (loop/volume/fade-in/fade-out, unchanged), then
 * `sidechaincompress` driven by the NARRATION at [0:a] pulls the bed down
 * further while speech is present, then `amix` mixes it back against [0:a].
 *
 * PURE — no ffmpeg, no I/O. The caller (music-mixer.ts) chooses THIS graph
 * only when it knows [0:a] actually carries narration (the video-buffer-in-
 * hand had a narration mux land on it this render); otherwise it falls back to
 * `buildMusicMixFilterGraph`'s constant level — sidechaining against a silent
 * or non-speech channel would never trigger and would just waste a filter
 * stage, so the caller's `usedVoiceover` fact IS the availability check.
 */
export function buildMusicDuckFilterGraph(input: MusicDuckFilterGraphInput): string {
  const threshold = clamp(dbToLinearAmplitude(input.duck.thresholdDb), SIDECHAIN_THRESHOLD_RANGE)
  const ratio = clamp(input.duck.ratio, SIDECHAIN_RATIO_RANGE)
  const attack = clamp(input.duck.attackMs, SIDECHAIN_ATTACK_MS_RANGE)
  const release = clamp(input.duck.releaseMs, SIDECHAIN_RELEASE_MS_RANGE)
  const makeup = clamp(dbToLinearAmplitude(input.duck.makeupDb ?? 0), SIDECHAIN_MAKEUP_RANGE)
  return [
    buildMusicTrackFilter(input),
    `[a1][0:a]sidechaincompress=threshold=${threshold.toFixed(6)}:ratio=${ratio.toFixed(2)}:` +
      `attack=${attack.toFixed(2)}:release=${release.toFixed(2)}:makeup=${makeup.toFixed(2)}[a1d]`,
    `[0:a][a1d]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
  ].join(";")
}
