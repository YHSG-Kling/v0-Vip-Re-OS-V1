// lib/podcast/episode-audio-measure.ts
//
// THE PODCAST-AUDIO METER (wave 143, lane 143F) — what an audio file itself can say: duration, codec, rate, channels, bitrate, integrated
// loudness and true peak. Extracted from lib/podcast/episode-audio.ts so the assembly pass imports its meter instead of calling an export of
// its own file. ffmpeg-static (the same binary lib/remotion/music-mixer.ts and lib/video/tv-spot-measure.ts run) ships no ffprobe, so the facts
// come from `ffmpeg -i`'s own report (parseAudioInfo) and the loudness from the EBU R128 meter (lib/remotion/music-filter-graph.ts).
// Never throws: a failed read returns ok:false with the reason.

import "server-only"
import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildLoudnessMeasureStage, parseLoudnessMeasurement } from "@/lib/remotion/music-filter-graph"
import { parseAudioInfo, type PodcastAudioFacts } from "./episode-audio-spec"

let FFMPEG_BIN: string | null = null
try {
  const ffmpegStatic = createRequire(import.meta.url)("ffmpeg-static")
  FFMPEG_BIN = typeof ffmpegStatic === "string" ? ffmpegStatic : null
} catch {
  FFMPEG_BIN = null
}

/** Is the bundled ffmpeg binary present? (false on a runtime that did not trace it into the function — the caller refuses by name.) */
export function ffmpegAvailable(): boolean {
  return FFMPEG_BIN !== null
}

/** Run the bundled ffmpeg; resolves with stderr (where ffmpeg reports), rejects on a non-zero exit unless `allowNonZero`. */
export function runFfmpeg(args: string[], opts: { allowNonZero?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN as string, args, { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    proc.stderr.on("data", (c) => { stderr += c.toString() })
    proc.on("error", reject)
    proc.on("close", (code) => (code === 0 || opts.allowNonZero ? resolve(stderr) : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`))))
  })
}

/** Measure an audio file: duration, codec, rate, channels, bitrate, integrated loudness and true peak. Never throws. */
export async function measurePodcastAudio(buffer: Buffer): Promise<{ ok: true; facts: PodcastAudioFacts } | { ok: false; error: string }> {
  if (!FFMPEG_BIN) return { ok: false, error: "ffmpeg-static unavailable" }
  if (buffer.length === 0) return { ok: false, error: "empty file" }
  const dir = await fs.mkdtemp(join(tmpdir(), "podcast-measure-"))
  const inPath = join(dir, "in.mp3")
  try {
    await fs.writeFile(inPath, buffer)
    const info = parseAudioInfo(await runFfmpeg(["-hide_banner", "-i", inPath], { allowNonZero: true }))
    if (info.codec === null) return { ok: false, error: "ffmpeg could not read an audio stream from the file" }
    const m = parseLoudnessMeasurement(await runFfmpeg(["-hide_banner", "-i", inPath, "-af", buildLoudnessMeasureStage(), "-f", "null", "-"]))
    return { ok: true, facts: { ...info, integratedLufs: m?.integratedLufs ?? null, truePeakDbtp: m?.truePeakDbtp ?? null } }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
