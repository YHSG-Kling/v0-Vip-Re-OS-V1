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
