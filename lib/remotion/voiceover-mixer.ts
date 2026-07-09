// lib/remotion/voiceover-mixer.ts
// ─────────────────────────────────────────────────────────────────────────────
// NARRATION ON EVERY VIDEO (owner rule: voice is included unless stated
// otherwise). Muxes an ElevenLabs narration mp3 over a rendered video —
// the assistant's voice on internal reports, the agent's clone on
// contact-facing video. Mirrors music-mixer's ffmpeg-static pattern.
//
// Remotion renders WITHOUT <Audio> elements have NO audio stream, so a
// bare [0:a] filter fails — we attempt the mix (video audio + narration,
// narration on top) and on failure fall back to mapping the narration
// directly (silent video → narrated video). Music is mixed AFTER this in
// the coordinator, ducked under the narration by its own volume pct.

import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let FFMPEG_BIN: string | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpegStatic = require("ffmpeg-static")
  FFMPEG_BIN = typeof ffmpegStatic === "string" ? ffmpegStatic : null
} catch { FFMPEG_BIN = null }

export interface MixVoiceoverInput {
  videoBuffer: Buffer
  /** Public URL of the narration mp3 (uploaded at queue time). */
  voiceoverUrl: string
}

export interface MixVoiceoverResult {
  ok: boolean
  outputBuffer: Buffer
  skippedReason?: string
  error?: string
}

const runFfmpeg = (args: string[]) => new Promise<void>((resolve, reject) => {
  const proc = spawn(FFMPEG_BIN as string, args, { stdio: ["ignore", "ignore", "pipe"] })
  let stderr = ""
  proc.stderr.on("data", (c) => { stderr += c.toString() })
  proc.on("error", reject)
  proc.on("close", (code) => {
    if (code !== 0) reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-512)}`))
    else resolve()
  })
})

/** Mux the narration over the video (video length wins; -shortest). */
export async function mixNarrationVoiceover(input: MixVoiceoverInput): Promise<MixVoiceoverResult> {
  if (!FFMPEG_BIN) return { ok: false, outputBuffer: input.videoBuffer, skippedReason: "ffmpeg-static unavailable" }
  if (input.videoBuffer.length === 0) return { ok: false, outputBuffer: input.videoBuffer, skippedReason: "empty video buffer" }

  const dir = await fs.mkdtemp(join(tmpdir(), "remotion-vo-"))
  const videoPath = join(dir, "in.mp4")
  const voPath = join(dir, "vo.mp3")
  const outPath = join(dir, "out.mp4")
  try {
    await fs.writeFile(videoPath, input.videoBuffer)
    const res = await fetch(input.voiceoverUrl)
    if (!res.ok) return { ok: false, outputBuffer: input.videoBuffer, skippedReason: `voiceover download failed (${res.status})` }
    await fs.writeFile(voPath, Buffer.from(await res.arrayBuffer()))

    try {
      // Attempt A — the video HAS audio (avatar clip): narration on top.
      await runFfmpeg([
        "-y", "-i", videoPath, "-i", voPath,
        "-filter_complex", "[1:a]volume=1.0[vo];[0:a][vo]amix=inputs=2:duration=first:dropout_transition=0[aout]",
        "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-shortest", outPath,
      ])
    } catch {
      // Attempt B — silent video (no audio stream): narration IS the track.
      await runFfmpeg([
        "-y", "-i", videoPath, "-i", voPath,
        "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", outPath,
      ])
    }
    const outBuf = await fs.readFile(outPath)
    return { ok: true, outputBuffer: outBuf }
  } catch (e) {
    return { ok: false, outputBuffer: input.videoBuffer, error: (e as Error).message }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
