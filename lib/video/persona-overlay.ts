/**
 * lib/video/persona-overlay.ts
 *
 * Wave 22b — burn a persona-specific text overlay onto the first 3 seconds
 * of the existing newsletter main MP4 (Remotion + ElevenLabs voice). Result
 * is one composite MP4 per (campaign × persona); the publish-newsletters
 * loop reads which composite to embed per recipient by recipient persona.
 *
 * Cost shape: the main render is reused; this helper just re-encodes the
 * first 3 seconds with a drawtext filter over them. ffmpeg-static is the
 * canonical binary (already in the dependency set — used by
 * lib/video/composite-attribution.ts for the listing-promo hybrid stitch).
 *
 * Per the existing pattern, this helper:
 *   · Falls back to passthrough (returns the input as-is) when ffmpeg-static
 *     isn't available — never throws on missing-binary so the publish loop
 *     never blocks on infra hiccups
 *   · Logs ffmpeg stderr on non-zero exit so degradations are visible
 *   · Returns a buffer the caller can upload to Vercel Blob storage in one
 *     step (matches composite-attribution::concatIntroOutro's shape)
 */
import "server-only"
import { spawn } from "node:child_process"
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import ffmpegPath from "ffmpeg-static"

const FFMPEG_BIN = ffmpegPath as unknown as string | null

export interface PersonaOverlayInput {
  /** The fully-rendered main newsletter MP4 (already in storage). The helper
   *  fetches the bytes itself so the caller just hands over a URL. */
  mainVideoUrl: string
  /** 8-15 word persona hook line. Must be compliance-cleaned upstream —
   *  this helper just burns text, no policy check happens here. */
  personaHookText: string
  /** Hex color for the text fill. Default white. */
  textColor?:     string
  /** Hex color for the semi-transparent backing box behind the text. */
  boxColor?:      string
  /** Seconds the overlay stays visible. Default 3. The fade-out is the
   *  last 0.5s of that window so it doesn't pop. */
  durationSeconds?: number
}

export interface PersonaOverlayResult {
  outputBuffer:   Buffer
  overlayApplied: boolean
  /** Set when overlayApplied=false — e.g. ffmpeg missing, fetch failed. */
  skippedReason?: string
}

export async function burnPersonaOverlay(
  input: PersonaOverlayInput,
): Promise<PersonaOverlayResult> {
  if (!FFMPEG_BIN) {
    const passthrough = await fetchVideoBuffer(input.mainVideoUrl)
    return { outputBuffer: passthrough, overlayApplied: false, skippedReason: "ffmpeg-static binary unavailable" }
  }

  const durationSec = input.durationSeconds ?? 3
  const fadeOutStart = Math.max(0, durationSec - 0.5)
  const textColor = input.textColor ?? "white"
  // Default backing: dark semi-transparent so light text reads on any
  // background. The accent color is per-brokerage but lives upstream;
  // this default is safe for every brand.
  const boxColor = input.boxColor ?? "black@0.55"

  // ffmpeg drawtext requires escaped single quotes + commas in the text
  // body. The text is also passed via -filter_complex which has its own
  // shell-style escaping rules. We use double-escaping (\\: , \\') so the
  // value survives BOTH the JSON property and the filter parser.
  const safeText = input.personaHookText
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")

  // The filter: draw text at the bottom-third, with a backing box, alpha
  // ramping in over the first 0.3s and out over the last 0.5s of the
  // overlay window. The `enable` expression bounds the overlay to the
  // first `durationSec` seconds of the video.
  const filter = [
    `drawtext=`,
    `text='${safeText}':`,
    `fontcolor=${textColor}:`,
    `fontsize=64:`,
    `box=1:boxcolor=${boxColor}:boxborderw=24:`,
    `x=(w-text_w)/2:`,
    `y=h-(text_h*2.5):`,
    `enable='between(t,0,${durationSec})':`,
    // Alpha ramp: 0→1 over first 0.3s; 1→0 over last 0.5s.
    `alpha='if(lt(t,0.3),t/0.3, if(gt(t,${fadeOutStart}), max(0,(${durationSec}-t)/0.5), 1))'`,
  ].join("")

  let workDir: string | null = null
  try {
    workDir = await mkdtemp(path.join(tmpdir(), "persona-overlay-"))
    const inputBuffer = await fetchVideoBuffer(input.mainVideoUrl)
    const inputPath  = path.join(workDir, "main.mp4")
    const outputPath = path.join(workDir, "out.mp4")
    await writeFile(inputPath, inputBuffer)

    // -c:a copy keeps the ElevenLabs voice track untouched. -c:v libx264
    // forces re-encode because drawtext requires raw frames. CRF 22 keeps
    // size reasonable on the short overlay segment.
    await runFfmpeg([
      "-y",
      "-i", inputPath,
      "-vf", filter,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "22",
      "-c:a", "copy",
      "-movflags", "+faststart",
      outputPath,
    ])

    const outBuffer = await readFile(outputPath)
    return { outputBuffer: outBuffer, overlayApplied: true }
  } catch (err) {
    const msg = (err as Error).message ?? "unknown"
    console.error("[persona-overlay] ffmpeg failed; falling back to passthrough:", msg)
    const passthrough = await fetchVideoBuffer(input.mainVideoUrl).catch(() => Buffer.alloc(0))
    return { outputBuffer: passthrough, overlayApplied: false, skippedReason: msg }
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

async function fetchVideoBuffer(url: string): Promise<Buffer> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`fetch main video failed: ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

function runFfmpeg(args: string[]): Promise<void> {
  if (!FFMPEG_BIN) throw new Error("ffmpeg-static binary unavailable")
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN!, args)
    let stderr = ""
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString() })
    proc.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`))
    })
    proc.on("error", (err) => reject(err))
  })
}
