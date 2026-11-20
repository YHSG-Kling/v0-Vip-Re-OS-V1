// lib/video/tv-spot-measure.ts
//
// THE TV-SPOT METER (wave 143, lane 143F) — what a video file itself can say about its fitness for the TV spec in lib/video/tv-spot.ts.
// Extracted from lib/video/tv-spot-master.ts so the mastering pass imports its meter instead of calling an export of its own file.
// ffmpeg-static (already a dependency; the same binary lib/remotion/music-mixer.ts runs) ships no ffprobe, so the container facts come from
// `ffmpeg -i`'s own report (parseFfmpegInfo) and the loudness from the EBU R128 meter (ebur128, true peak on — the SAME meter and parser the
// social master uses, lib/remotion/music-filter-graph.ts). Never throws: a failed read returns ok:false with the reason.

import "server-only"
import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildLoudnessMeasureStage, parseLoudnessMeasurement } from "@/lib/remotion/music-filter-graph"
import { parseFfmpegInfo, type TvSpotFacts } from "./tv-spot"

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

/** The facts the file itself can answer (captions are a sidecar the caller attaches). */
export type TvMeasuredFacts = Omit<TvSpotFacts, "captions">

/** Run the bundled ffmpeg; resolves with stderr (where ffmpeg reports), rejects on a non-zero exit unless `allowNonZero`. */
export function runFfmpeg(args: string[], opts: { allowNonZero?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN as string, args, { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    proc.stderr.on("data", (c) => { stderr += c.toString() })
    proc.on("error", reject)
    proc.on("close", (code) => (code === 0 || opts.allowNonZero ? resolve(stderr) : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-600)}`))))
  })
}

/** Measure a file: container facts + (when it has audio) integrated loudness and true peak. Never throws. */
export async function measureTvSpotFile(buffer: Buffer): Promise<{ ok: true; facts: TvMeasuredFacts } | { ok: false; error: string }> {
  if (!FFMPEG_BIN) return { ok: false, error: "ffmpeg-static unavailable" }
  if (buffer.length === 0) return { ok: false, error: "empty file" }
  const dir = await fs.mkdtemp(join(tmpdir(), "tv-spot-measure-"))
  const inPath = join(dir, "in.mp4")
  try {
    await fs.writeFile(inPath, buffer)
    // `ffmpeg -i file` with no output prints the stream report and exits 1 — that is the probe.
    const info = parseFfmpegInfo(await runFfmpeg(["-hide_banner", "-i", inPath], { allowNonZero: true }))
    let integratedLufs: number | null = null, truePeakDbtp: number | null = null
    if (info.hasAudio) {
      const m = parseLoudnessMeasurement(await runFfmpeg(["-hide_banner", "-i", inPath, "-vn", "-af", buildLoudnessMeasureStage(), "-f", "null", "-"]))
      integratedLufs = m?.integratedLufs ?? null
      truePeakDbtp = m?.truePeakDbtp ?? null
    }
    return { ok: true, facts: { ...info, integratedLufs, truePeakDbtp } }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
