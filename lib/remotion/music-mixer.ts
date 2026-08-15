/**
 * lib/remotion/music-mixer.ts
 *
 * Wave 39 — background-music mix layer. Takes a rendered video
 * buffer (the bookend-stitched output) and an mp3 music URL, mixes
 * the music UNDER the existing audio (the agent's voiceover) at a
 * configurable volume, and returns the new buffer.
 *
 * Uses ffmpeg-static (already in deps for the D-ID composite path
 * — no new dependency). The filter graph:
 *   - [0:v] passthrough video
 *   - [1:a] loop the music + apply volume scaling
 *   - amix [0:a][1:a] -> mixed audio with the music sitting at
 *     the configured percentage of the voiceover
 *
 * Compliance note: music tracks attached via video_assets carry
 * license_url + license_attribution columns (m170). The CALLER
 * verifies the brokerage has a paid license for the track before
 * the music_asset row was added; this module trusts the row.
 */
import "server-only"
import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let FFMPEG_BIN: string | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpegStatic = require("ffmpeg-static")
  FFMPEG_BIN = typeof ffmpegStatic === "string" ? ffmpegStatic : null
} catch {
  FFMPEG_BIN = null
}

export interface MixBackgroundMusicInput {
  videoBuffer:    Buffer
  musicUrl:       string
  /** 0-100. Default 20% sits the music well under voice. */
  musicVolumePct: number
  /** Loop the music to fill the video if the track is shorter. */
  loop:           boolean
}

export interface MixBackgroundMusicResult {
  ok:           boolean
  outputBuffer: Buffer
  skippedReason?: string
  error?:       string
}

export async function mixBackgroundMusic(
  input: MixBackgroundMusicInput,
): Promise<MixBackgroundMusicResult> {
  if (!FFMPEG_BIN) {
    return { ok: false, outputBuffer: input.videoBuffer, skippedReason: "ffmpeg-static unavailable" }
  }
  if (input.videoBuffer.length === 0) {
    return { ok: false, outputBuffer: input.videoBuffer, skippedReason: "empty video buffer" }
  }
  const volume = Math.max(0, Math.min(100, input.musicVolumePct)) / 100
  if (volume === 0) {
    return { ok: true, outputBuffer: input.videoBuffer, skippedReason: "music volume 0" }
  }

  const dir       = await fs.mkdtemp(join(tmpdir(), "remotion-mix-"))
  const videoPath = join(dir, "in.mp4")
  const musicPath = join(dir, "music.mp3")
  const outPath   = join(dir, "out.mp4")

  try {
    await fs.writeFile(videoPath, input.videoBuffer)

    // Download the music. Vercel Blob URLs are public; brokerage-
    // hosted CDN URLs are also public. We don't sign here.
    const musicRes = await fetch(input.musicUrl)
    if (!musicRes.ok) {
      return { ok: false, outputBuffer: input.videoBuffer, skippedReason: `music download failed (${musicRes.status})` }
    }
    const musicBuf = Buffer.from(await musicRes.arrayBuffer())
    await fs.writeFile(musicPath, musicBuf)

    // Build the filter graph. amix with duration=first locks the
    // mixed audio to the video's length; the loop on the music
    // stream means short tracks fill long videos without an audible
    // tail-cut.
    const filter = [
      input.loop
        ? `[1:a]aloop=loop=-1:size=2147483647,volume=${volume.toFixed(2)}[a1]`
        : `[1:a]volume=${volume.toFixed(2)}[a1]`,
      `[0:a][a1]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
    ].join(";")

    const exit = await new Promise<number>((resolve, reject) => {
      const proc = spawn(FFMPEG_BIN as string, [
        "-y",
        "-i", videoPath,
        "-stream_loop", input.loop ? "-1" : "0",
        "-i", musicPath,
        "-filter_complex", filter,
        "-map", "0:v",
        "-map", "[aout]",
        "-c:v", "copy",
        "-c:a", "aac",
        "-shortest",
        outPath,
      ], { stdio: ["ignore", "ignore", "pipe"] })
      let stderr = ""
      proc.stderr.on("data", (c) => { stderr += c.toString() })
      proc.on("error", reject)
      proc.on("close", (code) => {
        if (code !== 0) reject(new Error(`ffmpeg amix exit ${code}: ${stderr.slice(-512)}`))
        else resolve(code ?? 0)
      })
    })
    void exit

    const outBuf = await fs.readFile(outPath)
    return { ok: true, outputBuffer: outBuf }
  } catch (e) {
    return { ok: false, outputBuffer: input.videoBuffer, error: (e as Error).message }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
