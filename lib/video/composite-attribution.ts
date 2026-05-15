/**
 * lib/video/composite-attribution.ts
 *
 * ffmpeg-based post-render compositor that burns the legally-required
 * brokerage attribution onto a D-ID video:
 *   - Brokerage / team logo composited in the bottom-right corner
 *   - 56px-tall semi-transparent attribution band along the bottom edge
 *     carrying "[Brokerage Name] · Lic #[Number] ([State]) · Agent Lic
 *     #[Number]    [⌂ Equal Housing Opportunity]"
 *
 * Architecture:
 *   1. Render the band as a PNG with Sharp (reuses the SVG approach the
 *      image pipeline already uses — keeps the band visually identical
 *      between video and image outputs).
 *   2. Download the input video + (optional) logo to /tmp.
 *   3. Spawn ffmpeg with a filter_complex that scales the logo, overlays
 *      it bottom-right, then overlays the band along the bottom.
 *   4. Read the output back as a Buffer for the caller to upload.
 *
 * SKIPPED when:
 *   - input.brand.mlsClean === true (MLS feed rules forbid agent /
 *     brokerage branding on listing media — even photos and videos)
 *   - No brokerage trade name, DBA, or team name is configured
 *
 * NEVER throws — the original input URL is always returned on failure
 * so the calling cron can fall back to the un-branded video. The
 * has_visual_brand_overlay boolean on the row tells the compliance
 * gate whether the overlay actually completed.
 */

import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import sharp from "sharp"
import ffmpegPath from "ffmpeg-static"

export interface VideoAttributionBrand {
  brokerageName?: string | null
  brokerageDba?: string | null
  brokerageLicense?: string | null
  brokerageLicenseState?: string | null
  teamName?: string | null
  agentLicense?: string | null
  logoUrl?: string | null
  /**
   * When true, no overlay is applied — MLS rules forbid agent / brokerage
   * branding on listing media submitted to the MLS feed. The function
   * returns the input buffer untouched.
   */
  mlsClean?: boolean
}

export interface CompositeVideoAttributionResult {
  outputBuffer: Buffer
  /** False means we returned the input untouched (skipped or failed) */
  overlayApplied: boolean
  /** Human-readable reason when overlayApplied=false */
  skippedReason?: string
}

const FFMPEG_BIN = ffmpegPath as unknown as string | null

export async function compositeVideoAttribution(opts: {
  inputVideoUrl: string
  brand: VideoAttributionBrand
}): Promise<CompositeVideoAttributionResult> {
  if (!FFMPEG_BIN) {
    return await passthrough(opts.inputVideoUrl, "ffmpeg-static binary unavailable")
  }
  if (opts.brand.mlsClean) {
    return await passthrough(opts.inputVideoUrl, "mls_clean")
  }
  const tradeName = opts.brand.brokerageDba ?? opts.brand.brokerageName ?? opts.brand.teamName
  if (!tradeName) {
    return await passthrough(opts.inputVideoUrl, "no brokerage trade name configured")
  }

  let workDir: string | null = null
  try {
    workDir = await mkdtemp(path.join(tmpdir(), "vip-vid-"))
    const inputPath  = path.join(workDir, "in.mp4")
    const bandPath   = path.join(workDir, "band.png")
    const logoPath   = path.join(workDir, "logo.png")
    const outputPath = path.join(workDir, "out.mp4")

    // ── 1. Download the input video ─────────────────────────────────────────
    const videoRes = await fetch(opts.inputVideoUrl)
    if (!videoRes.ok) {
      return await passthrough(opts.inputVideoUrl, `Input fetch failed: ${videoRes.status}`)
    }
    await writeFile(inputPath, Buffer.from(await videoRes.arrayBuffer()))

    // ── 2. Probe input dimensions so the band is sized correctly ───────────
    const dims = await probeDimensions(inputPath)
    const videoWidth  = dims.width  ?? 1280
    const videoHeight = dims.height ?? 720

    // ── 3. Render the attribution band PNG ──────────────────────────────────
    const bandPng = await renderAttributionBand({
      width:  videoWidth,
      videoHeight,
      brand:  opts.brand,
      tradeName,
    })
    await writeFile(bandPath, bandPng)

    // ── 4. Optionally fetch logo ───────────────────────────────────────────
    let hasLogo = false
    if (opts.brand.logoUrl) {
      try {
        const logoRes = await fetch(opts.brand.logoUrl)
        if (logoRes.ok) {
          const logoBuf  = Buffer.from(await logoRes.arrayBuffer())
          // Normalize to PNG so ffmpeg's overlay filter always works
          const logoPng = await sharp(logoBuf).png().toBuffer()
          await writeFile(logoPath, logoPng)
          hasLogo = true
        }
      } catch {
        // logo is best-effort — band alone still satisfies attribution
      }
    }

    // ── 5. Run ffmpeg ───────────────────────────────────────────────────────
    const bandHeight = bandPngHeight(videoHeight)
    const targetLogoWidth = Math.max(60, Math.min(180, Math.round(videoWidth * 0.12)))
    const logoPad = Math.round(videoWidth * 0.02)
    const logoYOffset = bandHeight + logoPad  // sit just above the band

    // Build filter_complex string. When no logo, just overlay the band.
    let filter: string
    if (hasLogo) {
      filter =
        `[2:v]scale=${targetLogoWidth}:-1[lg];` +
        `[0:v][1:v]overlay=0:H-h[base];` +
        `[base][lg]overlay=W-w-${logoPad}:H-h-${logoYOffset}`
    } else {
      filter = `[0:v][1:v]overlay=0:H-h`
    }

    const args = [
      "-y",
      "-i", inputPath,
      "-i", bandPath,
      ...(hasLogo ? ["-i", logoPath] : []),
      "-filter_complex", filter,
      "-c:a", "copy",       // pass audio through untouched
      "-preset", "fast",
      "-movflags", "+faststart",
      outputPath,
    ]

    await runFfmpeg(args)

    const outputBuffer = await readFile(outputPath)
    return { outputBuffer, overlayApplied: true }
  } catch (err: any) {
    return await passthrough(opts.inputVideoUrl, err?.message ?? "ffmpeg failed")
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────────────

async function passthrough(inputUrl: string, reason: string): Promise<CompositeVideoAttributionResult> {
  try {
    const res = await fetch(inputUrl)
    if (!res.ok) {
      throw new Error(`Input fetch failed: ${res.status}`)
    }
    return {
      outputBuffer:   Buffer.from(await res.arrayBuffer()),
      overlayApplied: false,
      skippedReason:  reason,
    }
  } catch (err: any) {
    // If even the passthrough fetch fails, surface as an empty buffer with
    // the original reason so the caller decides what to do. The cron always
    // checks overlayApplied before swapping the video URL.
    return {
      outputBuffer:   Buffer.alloc(0),
      overlayApplied: false,
      skippedReason:  `${reason}; passthrough fetch failed: ${err?.message ?? "unknown"}`,
    }
  }
}

function bandPngHeight(videoHeight: number): number {
  return Math.max(48, Math.round(videoHeight * 0.07))
}

async function renderAttributionBand(opts: {
  width: number
  videoHeight: number
  brand: VideoAttributionBrand
  tradeName: string
}): Promise<Buffer> {
  const { width, videoHeight, brand, tradeName } = opts
  const height = bandPngHeight(videoHeight)
  const fontSize = Math.max(14, Math.round(height * 0.4))
  const pad      = Math.round(height * 0.4)

  const licenseParts: string[] = []
  if (brand.brokerageLicense) {
    const state = brand.brokerageLicenseState ? ` (${brand.brokerageLicenseState})` : ""
    licenseParts.push(`Lic #${brand.brokerageLicense}${state}`)
  }
  if (brand.agentLicense && brand.agentLicense !== brand.brokerageLicense) {
    licenseParts.push(`Agent #${brand.agentLicense}`)
  }
  const attributionTextParts: string[] = [tradeName]
  if (brand.teamName && brand.teamName !== tradeName) attributionTextParts.push(brand.teamName)
  attributionTextParts.push(...licenseParts)
  const attributionText = attributionTextParts.join(" · ")

  const xmlEscape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${width}" height="${height}" fill="black" fill-opacity="0.55"/>
      <text x="${pad}" y="${height / 2}"
            font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}"
            fill="white" dominant-baseline="middle">
        ${xmlEscape(attributionText)}
      </text>
      <text x="${width - pad - 200}" y="${height / 2}"
            font-family="Arial, Helvetica, sans-serif" font-size="${Math.round(fontSize * 0.85)}"
            fill="white" dominant-baseline="middle">
        ⌂ Equal Housing Opportunity
      </text>
    </svg>
  `

  return await sharp(Buffer.from(svg)).png().toBuffer()
}

async function probeDimensions(filePath: string): Promise<{ width: number | null; height: number | null }> {
  if (!FFMPEG_BIN) return { width: null, height: null }
  // ffmpeg-static ships ffprobe-equivalent capability via ffmpeg -i; we parse
  // the stderr stream. Avoids a second binary dep.
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_BIN!, ["-i", filePath, "-hide_banner"])
    let stderr = ""
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString() })
    proc.on("close", () => {
      const match = stderr.match(/, (\d+)x(\d+)[,\s]/)
      if (match) {
        resolve({ width: parseInt(match[1], 10), height: parseInt(match[2], 10) })
      } else {
        resolve({ width: null, height: null })
      }
    })
    proc.on("error", () => resolve({ width: null, height: null }))
  })
}

async function runFfmpeg(args: string[]): Promise<void> {
  if (!FFMPEG_BIN) throw new Error("ffmpeg-static binary unavailable")
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN!, args)
    let stderr = ""
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString() })
    proc.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`))
    })
    proc.on("error", reject)
  })
}
