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
//
// ── THE TRUNCATION THIS FIXES (m313) ────────────────────────────────────────
// This muxed with -shortest and amix duration=first, which means THE VIDEO
// LENGTH WINS. Every composition has a FIXED duration_frames in the registry
// and no composition uses Remotion's calculateMetadata to size itself to its
// audio, while the narration script is capped at 2400 characters — several
// minutes of speech. So any script longer than its composition ran off the end
// and the agent was cut off MID-SENTENCE, silently, in a video sent to a client.
//
// The fix does not shorten the script: it EXTENDS the video, holding the final
// frame (ffmpeg tpad) for exactly the overrun, so the sentence finishes. The
// length comes free from the ElevenLabs alignment we already cache for captions
// (narration_cache.duration_seconds) — no probe, no second vendor call. When
// either length is unknown the old behaviour is kept rather than guessed at.

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
  /**
   * How long the narration runs, and how long the rendered video runs.
   *
   * Both optional, and when either is missing the mux keeps its historical
   * -shortest behaviour rather than guessing. When BOTH are known and the
   * narration is longer, the video is EXTENDED (final frame held) so the
   * sentence finishes — see the truncation note above.
   */
  narrationSeconds?: number | null
  videoSeconds?: number | null
}

export interface MixVoiceoverResult {
  ok: boolean
  outputBuffer: Buffer
  skippedReason?: string
  error?: string
  /** Seconds of video appended so the narration could finish. 0 = none needed. */
  paddedSeconds?: number
}

/**
 * How much video to append so the narration is not cut off.
 *
 * PURE, and deliberately conservative: it pads only when both lengths are known
 * and the overrun is more than a rounding artefact, and it refuses to pad by an
 * absurd amount (a bad duration would otherwise produce an hour of frozen
 * frame). Returns 0 when the current behaviour is correct.
 */
export function paddingSecondsFor(
  narrationSeconds: number | null | undefined,
  videoSeconds: number | null | undefined,
  maxPadSeconds = 120,
): number {
  if (typeof narrationSeconds !== "number" || typeof videoSeconds !== "number") return 0
  if (!Number.isFinite(narrationSeconds) || !Number.isFinite(videoSeconds)) return 0
  if (narrationSeconds <= 0 || videoSeconds <= 0) return 0
  const overrun = narrationSeconds - videoSeconds
  // Under a quarter second is an encode boundary, not a cut-off word.
  if (overrun <= 0.25) return 0
  return Number(Math.min(overrun, maxPadSeconds).toFixed(3))
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

/** Mux the narration over the video, extending the video if the voice runs longer. */
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

    // How much video to append so the last sentence lands. 0 = the video is
    // already long enough (or we do not know, and will not guess).
    const pad = paddingSecondsFor(input.narrationSeconds, input.videoSeconds)
    // tpad clones the final frame; re-encoding the video is required because we
    // are changing its length, so -c:v copy is dropped ONLY on the padded path.
    const padFilter = pad > 0 ? `[0:v]tpad=stop_mode=clone:stop_duration=${pad}[vpad];` : ""
    const videoMap = pad > 0 ? "[vpad]" : "0:v"
    const videoCodec = pad > 0 ? ["-c:v", "libx264", "-pix_fmt", "yuv420p"] : ["-c:v", "copy"]
    // With a padded video the AUDIO is now the shorter stream, so duration must
    // follow the longest to keep the held frame; unpadded keeps the old rule.
    const mixDuration = pad > 0 ? "longest" : "first"

    try {
      // Attempt A — the video HAS audio (avatar clip): narration on top.
      await runFfmpeg([
        "-y", "-i", videoPath, "-i", voPath,
        "-filter_complex",
        `${padFilter}[1:a]volume=1.0[vo];[0:a][vo]amix=inputs=2:duration=${mixDuration}:dropout_transition=0[aout]`,
        "-map", videoMap, "-map", "[aout]", ...videoCodec, "-c:a", "aac",
        ...(pad > 0 ? [] : ["-shortest"]), outPath,
      ])
    } catch {
      // Attempt B — silent video (no audio stream): narration IS the track.
      await runFfmpeg([
        "-y", "-i", videoPath, "-i", voPath,
        ...(pad > 0 ? ["-filter_complex", `[0:v]tpad=stop_mode=clone:stop_duration=${pad}[vpad]`] : []),
        "-map", videoMap, "-map", "1:a", ...videoCodec, "-c:a", "aac",
        ...(pad > 0 ? [] : ["-shortest"]), outPath,
      ])
    }
    const outBuf = await fs.readFile(outPath)
    return { ok: true, outputBuffer: outBuf, paddedSeconds: pad }
  } catch (e) {
    return { ok: false, outputBuffer: input.videoBuffer, error: (e as Error).message }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
