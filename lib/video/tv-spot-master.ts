// lib/video/tv-spot-master.ts
//
// THE TV MASTER — RE-MASTER A FINISHED FILE TO lib/video/tv-spot.ts (wave 143, lane 143F).
// ffmpeg-static (already a dependency; the same binary lib/remotion/music-mixer.ts runs) does the pass; the METER it reads before and after
// (container facts from `ffmpeg -i`, EBU R128 loudness with true peak — the SAME meter and parser the social master uses) is
// lib/video/tv-spot-measure.ts.
//
// THE MASTER differs from the social master in exactly the ways the spec differs: 1920×1080 progressive at 29.97 fps
// (letter-boxed only from a 16:9 source — a vertical or square cut is REFUSED, not pillar-boxed), H.264 High / yuv420p /
// BT.709, 48 kHz stereo AAC at −24 LKFS with a −2 dBTP ceiling (loudnorm single pass, then ONE measured linear trim — the
// social master's pattern: single-pass loudnorm lands within ~1 LU on a short programme, the meter reads what it made).
// It NEVER trims duration: a 17-second reel is reported as "not a spot length", it is not silently cut.
//
// Every function takes bytes and returns bytes + facts; hosting and recording are lib/video/tv-spot-produce.ts's job.
// Never throws — a failed pass returns ok:false with the reason, and the input is untouched.

import "server-only"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tvTrimGainDb, TV_SPOT_SPEC } from "./tv-spot"
// The meter (ffmpeg -i report + EBU R128) is lib/video/tv-spot-measure.ts:1 — extracted so this pass imports it. No behaviour changed.
import { ffmpegAvailable, measureTvSpotFile, runFfmpeg, type TvMeasuredFacts } from "./tv-spot-measure"

export type TvMasterOutcome =
  | { ok: true; buffer: Buffer; facts: TvMeasuredFacts; trimDb: number | null }
  | { ok: false; error: string }

/**
 * Re-master a finished 16:9 file to the TV spec. Refuses a source that is not 16:9 landscape or has no audio track.
 * Output is always 1920×1080 / 29.97 / H.264 / 48 kHz stereo AAC at −24 LKFS, ≤ −2 dBTP after the measured trim.
 */
export async function masterForTv(buffer: Buffer): Promise<TvMasterOutcome> {
  if (!ffmpegAvailable()) return { ok: false, error: "ffmpeg-static unavailable" }
  const before = await measureTvSpotFile(buffer)
  if (!before.ok) return { ok: false, error: `source could not be read: ${before.error}` }
  const s = before.facts
  if (s.width === null || s.height === null || s.height <= 0) return { ok: false, error: "source frame size could not be read" }
  const ratio = s.width / s.height
  if (Math.abs(ratio - TV_SPOT_SPEC.aspectRatio) / TV_SPOT_SPEC.aspectRatio > TV_SPOT_SPEC.aspectTolerance) {
    return { ok: false, error: `source is ${s.width}×${s.height} — not 16:9 landscape. A TV master is never made by pillar-boxing a vertical or square cut; render the 16:9 composition.` }
  }
  if (!s.hasAudio) return { ok: false, error: "source has no audio track — a spot with no sound is not a TV master" }

  const dir = await fs.mkdtemp(join(tmpdir(), "tv-spot-master-"))
  const inPath = join(dir, "in.mp4"), outPath = join(dir, "out.mp4"), trimPath = join(dir, "trim.mp4")
  try {
    await fs.writeFile(inPath, buffer)
    const t = TV_SPOT_SPEC.loudness
    await runFfmpeg([
      "-y", "-i", inPath,
      "-vf", `scale=${TV_SPOT_SPEC.width}:${TV_SPOT_SPEC.height}:force_original_aspect_ratio=decrease,pad=${TV_SPOT_SPEC.width}:${TV_SPOT_SPEC.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30000/1001,format=yuv420p`,
      "-af", `loudnorm=I=${t.targetLkfs}:TP=${t.maxTruePeakDbtp}:LRA=7,aresample=${TV_SPOT_SPEC.audio.sampleRate}`,
      "-ac", String(TV_SPOT_SPEC.audio.channels), "-ar", String(TV_SPOT_SPEC.audio.sampleRate),
      "-c:v", "libx264", "-profile:v", "high", "-level:v", "4.0", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
      "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart",
      outPath,
    ])
    let out = await fs.readFile(outPath)
    let measured = await measureTvSpotFile(out)
    if (!measured.ok) return { ok: false, error: `mastered file could not be re-measured: ${measured.error}` }
    // THE MEASURED TRIM — single-pass loudnorm misses a short programme by up to ~1 LU; one read, one linear gain, the video copied.
    let trimDb: number | null = null
    if (measured.facts.integratedLufs !== null && measured.facts.truePeakDbtp !== null) {
      const gain = tvTrimGainDb({ integratedLufs: measured.facts.integratedLufs, truePeakDbtp: measured.facts.truePeakDbtp })
      trimDb = gain
      if (gain !== 0) {
        await runFfmpeg(["-y", "-i", outPath, "-map", "0:v", "-map", "0:a", "-c:v", "copy", "-af", `volume=${gain}dB`, "-c:a", "aac", "-b:a", "256k", "-ar", String(TV_SPOT_SPEC.audio.sampleRate), "-ac", String(TV_SPOT_SPEC.audio.channels), "-movflags", "+faststart", trimPath])
        out = await fs.readFile(trimPath)
        measured = await measureTvSpotFile(out)
        if (!measured.ok) return { ok: false, error: `trimmed file could not be re-measured: ${measured.error}` }
      }
    }
    return { ok: true, buffer: out, facts: measured.facts, trimDb }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
