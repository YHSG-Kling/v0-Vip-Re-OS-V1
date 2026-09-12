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
 *   - [1:a] loop the music + apply volume scaling + fade in/out
 *   - amix [0:a][1:a] -> mixed audio with the music sitting at
 *     the configured percentage of the voiceover
 *
 * ── FADES (wave 48, video-assembly audit) ───────────────────────────────────
 * TOMBSTONE — the filter graph used to be a FLAT volume() scale for the whole
 * track: music at (say) 20% from frame 0 straight through to the last frame,
 * cut off exactly where `amix duration=first` ends the mix. finish-spec.ts
 * declares `music: true` for nearly every composition in the registry and the
 * owner's brief for this wave named fades at intro/outro explicitly; a track
 * that snaps to full volume on frame 1 and hard-cuts on the last frame reads as
 * a mixing bug even though the DUCK (constant lower volume under narration) and
 * the NEVER-PAST-END rule (`-shortest` + `duration=first`, unchanged below) were
 * already correct. `buildMusicFilterGraph` is the missing half: two `afade`
 * stages appended to the SAME `[a1]` chain the volume/loop stages already build,
 * fading in from 0 at the start and fading out to 0 over the tail. PURE — no
 * ffmpeg, no I/O — so the graph string can be asserted without spawning a
 * process (`scripts/video-assembly-simulator.ts` §music).
 *
 * `videoSeconds` (the length of the video the music is being mixed onto, i.e.
 * `compositionSeconds(composition) + bookendSeconds` — the same number
 * render-coordinator already derives for the m313 narration pad) is what times
 * the fade-OUT: `afade=t=out:st=(videoSeconds-fadeOutSeconds)`. Optional and
 * honest about it — a caller with no video-length fact (an older call site, a
 * probe that failed) gets fade-IN only, never a fade-out timed against a
 * guessed length that could clip the middle of the track.
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
import { buildMusicMixFilterGraph, buildMusicDuckFilterGraph } from "./music-filter-graph"
import { MUSIC_SIDECHAIN_DUCK_SETTINGS } from "@/lib/video/realism-profile"

// Re-exported unchanged so every existing caller of these names (including
// this file's own mixBackgroundMusic below) is unaffected by the split —
// lib/remotion/music-filter-graph.ts is the PURE half, moved out so
// scripts/video-assembly-simulator.ts can import it without dragging in
// `server-only` / ffmpeg-static / child_process. See that file's header.
export {
  buildMusicTrackFilter,
  buildMusicMixFilterGraph,
  buildMusicDuckFilterGraph,
  dbToLinearAmplitude,
  DEFAULT_MUSIC_FADE_IN_SECONDS,
  DEFAULT_MUSIC_FADE_OUT_SECONDS,
  type MusicFilterGraphInput,
  type MusicDuckFilterGraphInput,
  type SidechainDuckSettings,
} from "./music-filter-graph"

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
  /**
   * Seconds of `videoBuffer` — composition seconds + any bookends already
   * stitched onto it. Optional; absent means fade-in only (see
   * buildMusicTrackFilter). Never used to trim or extend the video itself —
   * `amix duration=first` + `-shortest` below are what keep the mix locked to
   * the ACTUAL muxed video length regardless of what this number claims.
   */
  videoSeconds?:  number | null
  fadeInSeconds?: number
  fadeOutSeconds?: number
  /**
   * REAL sidechain ducking (wave 58): true when the caller knows [0:a] on
   * `videoBuffer` carries narration THIS render (render-coordinator's
   * `usedVoiceover` fact, not a guess) — the music then ducks dynamically
   * under the speech (sidechaincompress, MUSIC_SIDECHAIN_DUCK_SETTINGS) and
   * returns to the same bed level in the gaps, instead of sitting at one flat
   * scale for the whole track. Defaults to false — the ORIGINAL constant-level
   * behaviour — so every caller that does not opt in (or a video with no
   * narration to sidechain against) is byte-for-byte unaffected.
   */
  duckToNarration?: boolean
}

export interface MixBackgroundMusicResult {
  ok:           boolean
  outputBuffer: Buffer
  skippedReason?: string
  error?:       string
  /** true when the SIDECHAIN graph actually rendered (not just requested) —
   *  the caller-visible fact for the audit trail / cache identity. false on
   *  the constant-level path, whether by choice or because the sidechain
   *  attempt fell back after an ffmpeg error (see the retry below). */
  ducked?:      boolean
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

    const runMix = (filter: string) => new Promise<void>((resolve, reject) => {
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
        else resolve()
      })
    })

    // Constant-level graph — loop (optional) → volume → fade-in → fade-out
    // (see buildMusicMixFilterGraph header). `amix` with duration=first locks
    // the mixed audio to the VIDEO's length regardless of the music track's
    // own length or the fade math above; the loop on the music stream means
    // short tracks fill long videos without an audible tail-cut. Built
    // unconditionally — it is BOTH the historical default path AND the
    // fallback the sidechain attempt below retries with on failure.
    const constantFilter = buildMusicMixFilterGraph({
      loop: input.loop,
      volume,
      videoSeconds: input.videoSeconds ?? null,
      fadeInSeconds: input.fadeInSeconds,
      fadeOutSeconds: input.fadeOutSeconds,
    })

    let ducked = false
    if (input.duckToNarration) {
      // REAL sidechain ducking (wave 58) — the SAME bed-level chain as
      // constantFilter, plus sidechaincompress keyed off the narration at
      // [0:a]. Attempted FIRST when the caller says [0:a] carries narration
      // this render; on ANY ffmpeg failure (an unusual audio layout, a codec
      // ffmpeg-static can't sidechain against) we fall back to the constant
      // level rather than shipping a silent/failed render — "keeping the
      // constant level as the fallback when sidechain unavailable" per the
      // task brief, covering both "no narration to key off" (caller never
      // sets duckToNarration) and "sidechain attempt itself failed" (here).
      const duckFilter = buildMusicDuckFilterGraph({
        loop: input.loop,
        volume,
        videoSeconds: input.videoSeconds ?? null,
        fadeInSeconds: input.fadeInSeconds,
        fadeOutSeconds: input.fadeOutSeconds,
        duck: MUSIC_SIDECHAIN_DUCK_SETTINGS,
      })
      try {
        await runMix(duckFilter)
        ducked = true
      } catch (e) {
        console.warn("[music-mixer] sidechain duck failed; falling back to constant level:", (e as Error).message)
      }
    }
    if (!ducked) {
      await runMix(constantFilter)
    }

    const outBuf = await fs.readFile(outPath)
    return { ok: true, outputBuffer: outBuf, ducked }
  } catch (e) {
    return { ok: false, outputBuffer: input.videoBuffer, error: (e as Error).message }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
