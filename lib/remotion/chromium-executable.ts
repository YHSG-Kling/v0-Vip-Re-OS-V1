// lib/remotion/chromium-executable.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE CHROMIUM LAUNCHER-RESOLVER (lane 78B, CLAUDE.md §6 — one vocabulary
// per function).
//
// Before this file, three render routes each carried a private copy of the
// same eleven lines:
//
//     if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
//       const chromium = (await import("@sparticuz/chromium-min")).default
//       executablePath = await chromium.executablePath(process.env.CHROMIUM_PACK_URL || "https://github.com/…/chromium-v149.0.0-pack.tar")
//     }
//
// in app/api/internal/remotion/render-composition/route.ts (resolveChromium),
// app/api/internal/remotion/render-newsletter-video/route.ts and
// app/api/internal/remotion/render-just-listed/route.ts. Three copies of a
// pack URL is three places a Chromium version bump can be missed, and a fourth
// caller — the screenshot seam at lib/assets/screenshot-capture.ts, which needs
// the SAME binary puppeteer-core drives for Remotion — would have been a fourth
// copy. All of them now call this module; each old site carries a tombstone
// naming this file.
//
// WHAT IS RESOLVED, AND WHERE:
//   · Vercel / Lambda  → @sparticuz/chromium-min downloads the Brotli pack once
//     per warm instance (CHROMIUM_PACK_URL, else the pinned v149 release) and
//     extracts to /tmp/chromium. The pinned version tracks the
//     @sparticuz/chromium-min major in package.json.
//   · Anywhere else     → `undefined` by default, which is what every render
//     route always passed locally: @remotion/renderer then uses the browser it
//     manages itself. Behaviour-preserving for the three routes.
//   · `localDiscovery`  → for a caller that launches puppeteer-core DIRECTLY
//     (the screenshot seam has no Remotion-managed browser to fall back to):
//     CHROMIUM_EXECUTABLE_PATH, else the Playwright browser cache
//     (PLAYWRIGHT_BROWSERS_PATH/chromium-*/chrome-linux/chrome — the CI and
//     dev containers pre-install it), else the usual system binaries. Nothing
//     is downloaded here; `playwright install` is never run by this module.
//
// No model calls, no DB. Pure resolution plus one dynamic import.

import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

/** The pack the -min package downloads on Vercel when CHROMIUM_PACK_URL is unset.
 *  Bump together with the @sparticuz/chromium-min major in package.json. */
export const DEFAULT_CHROMIUM_PACK_URL =
  "https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.tar"

/** Serverless hosts where the bundled-browser path is unavailable and the
 *  Brotli pack must be fetched. Read from env at call time, never cached, so a
 *  proof can exercise both branches. */
export function isServerlessChromiumHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME)
}

/** Well-known local binaries, in preference order — checked only under
 *  `localDiscovery`. */
const LOCAL_CHROMIUM_CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
] as const

/**
 * PURE (filesystem reads only): the newest Playwright-cached Chromium under
 * `browsersPath`, or null. Playwright lays its cache out as
 * `<root>/chromium-<build>/chrome-linux/chrome` (and `chrome-mac/…` on macOS);
 * the build number sorts numerically so the newest wins.
 */
export function findPlaywrightChromium(browsersPath: string | undefined): string | null {
  if (!browsersPath || !existsSync(browsersPath)) return null
  let entries: string[]
  try { entries = readdirSync(browsersPath) } catch { return null }
  const builds = entries
    .map((name) => ({ name, build: /^chromium-(\d+)$/.exec(name)?.[1] }))
    .filter((e): e is { name: string; build: string } => typeof e.build === "string")
    .sort((a, b) => Number(b.build) - Number(a.build))
  for (const b of builds) {
    for (const rel of ["chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-win/chrome.exe"]) {
      const p = join(browsersPath, b.name, rel)
      if (existsSync(p)) return p
    }
  }
  return null
}

export interface ResolveChromiumOptions {
  /** Search CHROMIUM_EXECUTABLE_PATH → Playwright cache → system binaries when
   *  not on a serverless host. Off by default so the Remotion render routes
   *  keep their historical "undefined → Remotion-managed browser" behaviour. */
  localDiscovery?: boolean
  env?: NodeJS.ProcessEnv
}

/**
 * The executable path to hand to @remotion/renderer's `browserExecutable` or
 * puppeteer-core's `executablePath`. `undefined` means "let Remotion manage
 * the browser" and is only ever returned off-serverless without discovery, or
 * when discovery finds nothing (the caller decides whether that is fatal).
 */
export async function resolveChromiumExecutable(opts: ResolveChromiumOptions = {}): Promise<string | undefined> {
  const env = opts.env ?? process.env
  if (isServerlessChromiumHost(env)) {
    const chromium = (await import("@sparticuz/chromium-min")).default
    return await chromium.executablePath(env.CHROMIUM_PACK_URL || DEFAULT_CHROMIUM_PACK_URL)
  }
  if (!opts.localDiscovery) return undefined
  const explicit = env.CHROMIUM_EXECUTABLE_PATH?.trim()
  if (explicit) return explicit
  const pw = findPlaywrightChromium(env.PLAYWRIGHT_BROWSERS_PATH)
  if (pw) return pw
  for (const p of LOCAL_CHROMIUM_CANDIDATES) if (existsSync(p)) return p
  return undefined
}

/**
 * Launch flags for a DIRECT puppeteer-core launch (not Remotion — Remotion
 * passes its own via chromiumOptions). On serverless the -min package's
 * recommended args are the ones that survive Lambda's sandbox; locally the
 * same no-sandbox / shm flags keep CI containers from dying on /dev/shm.
 */
export async function chromiumLaunchArgs(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  if (isServerlessChromiumHost(env)) {
    const chromium = (await import("@sparticuz/chromium-min")).default
    return [...chromium.args]
  }
  return ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars"]
}
