#!/usr/bin/env tsx
/**
 * scripts/remotion-real-render-probe.ts — A REAL REMOTION RENDER, MEASURED (wave 143, lane 143F).
 * NOT in the guard chain: it needs a browser binary and runs the real bundler + renderer (minutes), so it is an OPERATOR
 * PROBE that answers the owner's two questions with evidence instead of a fallback:
 *     "does a render produce a PLAYABLE file?"   and   "what Remotion errors do we actually run into?"
 *
 * What it does, per composition id (default: ListingPresentationSlide, ComingSoonReel, plus the LeadMagnetCard still):
 *   bundle(remotion/index.ts) once → selectComposition(defaultProps) → renderMedia (first FRAMES frames, h264 yuv420p BT.709,
 *   the repo's own DELIVERY_RENDER_OPTIONS) / renderStill → read the bytes → probePlayableOutput (the SAME probe the media host
 *   runs) → `ffmpeg -i` facts (parseFfmpegInfo) → on a failure: classifyRenderFailure (the SAME census signatures the queue
 *   cron folds) so a real error lands in a NAMED bucket with its recorded root cause and fix.
 * The browser is CHROMIUM_EXECUTABLE_PATH, else a Playwright / headless-shell binary found under PLAYWRIGHT_BROWSERS_PATH or
 * /opt/pw-browsers. No browser → "REAL_RENDER_NOT_RUN" with the reason (exit 0 — it is not a guard, and it never claims a pass).
 *
 * Usage:  NODE_OPTIONS=--max-old-space-size=6000 npx tsx scripts/remotion-real-render-probe.ts [ids,comma,separated]
 * Env:    REAL_RENDER_FRAMES (default 45), CHROMIUM_EXECUTABLE_PATH
 */
import { existsSync, readdirSync, mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { probePlayableOutput, describeUnplayable } from "../lib/video/playable-output"
import { classifyRenderFailure, RENDER_FAILURE_SIGNATURES } from "../lib/remotion/render-failure-census"
import { parseFfmpegInfo } from "../lib/video/tv-spot"

function findBrowser(): string | null {
  const env = process.env.CHROMIUM_EXECUTABLE_PATH
  if (env && existsSync(env)) return env
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", join(process.env.HOME ?? "", ".cache/ms-playwright")].filter((x): x is string => !!x && existsSync(x))
  for (const r of roots) {
    for (const d of readdirSync(r).sort().reverse()) {
      for (const rel of ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell", "chrome-linux/chrome"]) {
        const p = join(r, d, rel)
        if (existsSync(p)) return p
      }
    }
  }
  return null
}

/** Decoded length of one stream class ("v" picture / "a" sound) in seconds, read from ffmpeg's own progress line on a stream copy to null; null when the stream is absent. */
function streamSeconds(ffmpeg: string, file: string, kind: "v" | "a"): number | null {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-i", file, "-map", `0:${kind}:0`, "-c", "copy", "-f", "null", "-"], { encoding: "utf8" })
  if (r.status !== 0) return null
  const all = [...(r.stderr ?? "").matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)]
  if (all.length === 0) return null
  const m = all[all.length - 1]
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

async function main() {
  const browser = findBrowser()
  if (!browser) { console.log(" REAL_RENDER_NOT_RUN — no Chromium / headless-shell binary found (set CHROMIUM_EXECUTABLE_PATH). Nothing was rendered; nothing is claimed."); return }
  const ids = (process.argv[2] ?? "ListingPresentationSlide,ComingSoonReel,LeadMagnetCard").split(",").map((s) => s.trim()).filter(Boolean)
  const frames = Math.max(15, Number(process.env.REAL_RENDER_FRAMES ?? 45))
  const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string
  const { bundle } = await import("@remotion/bundler")
  const { selectComposition, renderMedia, renderStill } = await import("@remotion/renderer")
  const { DELIVERY_RENDER_OPTIONS } = await import("../lib/video/cinema-finish")
  // EXPERIMENT HOOK (operator only): REAL_RENDER_OPTIONS='{"enforceAudioTrack":false}' merges into the delivery options so a suspected cause can be toggled and re-measured.
  let extraOptions: Record<string, unknown> = {}
  try { extraOptions = process.env.REAL_RENDER_OPTIONS ? JSON.parse(process.env.REAL_RENDER_OPTIONS) : {} } catch { console.log(" REAL_RENDER_OPTIONS is not valid JSON — ignored") }
  if (Object.keys(extraOptions).length) console.log(` options override: ${JSON.stringify(extraOptions)}`)
  console.log(` browser: ${browser}`)
  const t0 = Date.now()
  let serveUrl: string
  try {
    serveUrl = await bundle({ entryPoint: join(process.cwd(), "remotion/index.ts") })
    console.log(` bundle: OK in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  } catch (e) {
    const msg = (e as Error).message
    console.log(` bundle: FAILED — ${msg.slice(0, 400)}\n   census bucket: ${classifyRenderFailure(msg).bucket}`)
    console.log(" REAL_RENDER_FAILED — the bundle did not compile")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "real-render-"))
  const rows: string[] = []
  let ok = 0, bad = 0
  for (const id of ids) {
    const t1 = Date.now()
    try {
      const comp = await selectComposition({ serveUrl, id, inputProps: {}, browserExecutable: browser, chromeMode: browser.includes("headless") ? "headless-shell" : undefined } as never)
      const still = /Card$|Flyer|Postcard|DoorHanger|CarouselSlide|Thumb$/.test(id) || comp.durationInFrames <= 1
      const out = join(dir, `${id}.${still ? "png" : "mp4"}`)
      if (still) {
        await renderStill({ composition: comp, serveUrl, output: out, inputProps: {}, browserExecutable: browser, chromeMode: browser.includes("headless") ? "headless-shell" : undefined, chromiumOptions: { gl: "swangle" } } as never)
      } else {
        await renderMedia({
          composition: comp, serveUrl, ...DELIVERY_RENDER_OPTIONS, ...extraOptions, outputLocation: out, inputProps: {}, concurrency: 1,
          frameRange: [0, Math.min(frames, comp.durationInFrames) - 1], chromiumOptions: { headless: true, gl: "swangle" },
          browserExecutable: browser, chromeMode: browser.includes("headless") ? "headless-shell" : undefined,
        } as never)
      }
      const bytes = readFileSync(out)
      if (process.env.REAL_RENDER_KEEP) { mkdirSync(process.env.REAL_RENDER_KEEP, { recursive: true }); copyFileSync(out, join(process.env.REAL_RENDER_KEEP, `${id}.${still ? "png" : "mp4"}`)) } // operator: keep the artifact for inspection
      if (still) {
        const png = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
        console.log(`  ${png ? "✓" : "✗"} ${id} (still): ${bytes.length} bytes, PNG signature ${png ? "present" : "ABSENT"}, ${((Date.now() - t1) / 1000).toFixed(1)} s`)
        if (png) ok++; else bad++
        rows.push(`${id}\tstill\t${png ? "ok" : "bad"}`)
        continue
      }
      const probe = probePlayableOutput(bytes, "video/mp4")
      const info = spawnSync(ffmpeg, ["-hide_banner", "-i", out], { encoding: "utf8" })
      const f = parseFfmpegInfo(info.stderr ?? "")
      console.log(`  ${probe.ok ? "✓" : "✗"} ${id}: ${bytes.length} bytes; probe ${probe.ok ? `playable (mp4, ${probe.durationSeconds?.toFixed(2)} s)` : describeUnplayable(probe)}; ffmpeg reads ${f.width}x${f.height} ${f.fps} fps ${f.videoCodec} ${f.pixelFormat}, audio ${f.hasAudio ? `${f.audioChannels}ch ${f.audioSampleRate} Hz` : "NONE"}; rendered in ${((Date.now() - t1) / 1000).toFixed(1)} s wall (software GL, concurrency 1)`)
      // A real decode: ffmpeg must be able to read every frame of the file it just made.
      const dec = spawnSync(ffmpeg, ["-v", "error", "-i", out, "-f", "null", "-"], { encoding: "utf8" })
      const decodeOk = dec.status === 0 && !(dec.stderr ?? "").trim()
      console.log(`      full decode (ffmpeg -v error -f null): ${decodeOk ? "clean" : `ERRORS — ${(dec.stderr ?? "").slice(0, 200)}`}`)
      // PICTURE AND SOUND MUST AGREE ON HOW LONG THE FILE IS. `ffmpeg -i` reports the LONGEST stream, a browser's <video>.duration is the
      // longest track, and every later pass (stitch, music mix, TV/social master) reads this container — so an audio track far longer than
      // the picture is a frozen last frame for minutes, even though the file "plays" and "decodes clean".
      const vSec = streamSeconds(ffmpeg, out, "v"), aSec = streamSeconds(ffmpeg, out, "a")
      const avOk = vSec === null || aSec === null || Math.abs(aSec - vSec) <= 0.5
      console.log(`      picture ${vSec === null ? "n/a" : vSec.toFixed(2)} s · audio ${aSec === null ? "n/a (no audio stream)" : aSec.toFixed(2)} s — ${avOk ? "agree (≤ 0.5 s apart)" : "AV_LENGTH_MISMATCH (audio is the longer stream; container/player duration = the audio's)"}`)
      if (probe.ok && decodeOk && avOk) ok++; else bad++
      rows.push(`${id}\tmoving\t${probe.ok && decodeOk && avOk ? "ok" : probe.ok && decodeOk ? "bad_av_length" : "bad"}`)
    } catch (e) {
      const msg = (e as Error).message ?? String(e)
      const c = classifyRenderFailure(msg)
      const sig = RENDER_FAILURE_SIGNATURES.find((s) => s.bucket === c.bucket)
      console.log(`  ✗ ${id}: FAILED after ${((Date.now() - t1) / 1000).toFixed(1)} s\n      error: ${msg.replace(/\s+/g, " ").slice(0, 420)}\n      census bucket: ${c.bucket}${sig ? ` — root cause on record: ${sig.rootCause.slice(0, 200)}` : ""}`)
      bad++
      rows.push(`${id}\t-\tfailed:${c.bucket}`)
    }
  }
  rmSync(dir, { recursive: true, force: true })
  console.log(` RESULT: ${ok} rendered playable, ${bad} failed of ${ids.length} (first ${frames} frames of each moving composition; bundle ${((Date.now() - t0) / 1000).toFixed(0)} s total)`)
  console.log(bad === 0 ? " REAL_RENDER_PASS" : " REAL_RENDER_FINDINGS — the failures above are REAL Remotion errors in this environment, classified by the census")
}

main().catch((e) => { console.error(e); process.exit(1) })
void statSync
