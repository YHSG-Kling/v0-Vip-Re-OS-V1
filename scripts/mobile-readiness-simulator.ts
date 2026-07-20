#!/usr/bin/env tsx
/**
 * scripts/mobile-readiness-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * MOBILE READINESS harness — verifies the installable-PWA + mobile-nav posture
 * documented in MOBILE.md. All checks are static/pure (no DB, no network):
 *
 *  [1] Manifest — app/manifest.ts executes (brand load falls back to defaults
 *      without env) and returns installability fields: name, standalone display,
 *      start_url /dashboard, id, theme color, 192/512 icons incl. maskable.
 *  [2] Icons — every manifest icon file exists in public/ and its PNG IHDR
 *      dimensions match the declared sizes; apple-icon.png is 180x180.
 *  [3] Root layout — Next 15 viewport export (device-width, viewport-fit=cover,
 *      themeColor) + appleWebApp metadata for iOS home-screen installs.
 *  [4] Bottom nav — app-shell renders MobileBottomNav from the role config
 *      (navigation.mobileBottomNav), mounted fixed-bottom / lg:hidden, content
 *      padded (pb-20), and the nav pads env(safe-area-inset-bottom).
 *  [5] Role config — every role in NAVIGATION_BY_ROLE has a non-empty
 *      mobileBottomNav (≤ 5 items, every item has an href).
 *  [6] Service-worker verdict — NO offline/caching SW in v1 (documented in
 *      app/manifest.ts + MOBILE.md); the only SW is push-sw.js and it must have
 *      a push handler and NO fetch handler (can never intercept navigation).
 *  [7] Portal mobile posture — portal layout is shell-independent and its tab
 *      nav is horizontally scrollable; legacy orphaned public/manifest.json
 *      (broken icon refs) is gone.
 *
 * Run: npx tsx scripts/mobile-readiness-simulator.ts
 * Suggested npm script (not added here — package.json is owned elsewhere):
 *   "test:mobile-readiness": "tsx scripts/mobile-readiness-simulator.ts"
 */
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Mobile readiness verified (installable PWA + role-driven bottom nav; no caching SW by design)")
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8")
}

/** Parse PNG IHDR width/height (bytes 16..24, big-endian). */
function pngSize(rel: string): { w: number; h: number } | null {
  try {
    const buf = readFileSync(join(ROOT, rel))
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  } catch { return null }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Mobile readiness simulator")
  console.log("══════════════════════════════════════════════════")

  // ── [1] Manifest route shape ──────────────────────────────────────────────
  console.log("\n[1 · app/manifest.ts — installability fields]")
  const manifestFn = (await import("../app/manifest")).default
  const m = await manifestFn()
  check("name is a non-empty string (DB brand or default)", typeof m.name === "string" && m.name!.length > 0)
  check("short_name fits the 12-char launcher budget", typeof m.short_name === "string" && m.short_name!.length <= 12)
  check("display is standalone", m.display === "standalone")
  check("start_url is /dashboard", m.start_url === "/dashboard")
  check("stable id set", m.id === "/dashboard")
  check("scope is /", m.scope === "/")
  check("theme_color is a hex color", /^#[0-9a-fA-F]{6}$/.test(m.theme_color ?? ""))
  check("background_color set", !!m.background_color)
  const icons = m.icons ?? []
  const bySize = (s: string, p: string) => icons.find((i: any) => i.sizes === s && (i.purpose ?? "any") === p)
  check("icon 192 purpose any", !!bySize("192x192", "any"))
  check("icon 512 purpose any", !!bySize("512x512", "any"))
  check("icon 192 purpose maskable", !!bySize("192x192", "maskable"))
  check("icon 512 purpose maskable", !!bySize("512x512", "maskable"))
  check("shortcuts declared", (m.shortcuts ?? []).length >= 1)

  // ── [2] Icon files ────────────────────────────────────────────────────────
  console.log("\n[2 · public/ icon assets]")
  for (const icon of icons) {
    const rel = join("public", (icon as any).src.replace(/^\//, ""))
    const dim = pngSize(rel)
    const want = parseInt((icon as any).sizes, 10)
    check(`${(icon as any).src} exists as ${want}x${want} PNG`, !!dim && dim.w === want && dim.h === want,
      dim ? `got ${dim.w}x${dim.h}` : "missing/not PNG")
  }
  const apple = pngSize("public/apple-icon.png")
  check("apple-icon.png is 180x180 PNG", !!apple && apple.w === 180 && apple.h === 180)

  // ── [3] Root layout viewport + iOS metadata ───────────────────────────────
  console.log("\n[3 · app/layout.tsx — viewport + appleWebApp]")
  const layout = read("app/layout.tsx")
  check("exports a Viewport const", /export const viewport\s*:\s*Viewport/.test(layout))
  check("viewport width device-width", /width:\s*'device-width'/.test(layout))
  check("viewport-fit cover (safe-area env() enabled)", /viewportFit:\s*'cover'/.test(layout))
  check("themeColor declared in viewport", /themeColor:\s*'#[0-9a-fA-F]{6}'/.test(layout))
  check("appleWebApp metadata (iOS standalone install)", /appleWebApp:\s*\{/.test(layout) && /capable:\s*true/.test(layout))

  // ── [4] Bottom nav rendered by the shell ──────────────────────────────────
  console.log("\n[4 · app shell renders the role-driven bottom nav]")
  const shell = read("app/components/layout/app-shell.tsx")
  check("shell imports MobileBottomNav", /import \{ MobileBottomNav \} from '\.\/mobile-bottom-nav'/.test(shell))
  check("shell derives nav via getNavigationForRole", /getNavigationForRole\(primaryRole\)/.test(shell))
  check("shell passes navigation.mobileBottomNav to the component", /<MobileBottomNav items=\{navigation\.mobileBottomNav\}/.test(shell))
  check("bar is fixed to the bottom and hidden ≥ lg", /lg:hidden fixed bottom-0/.test(shell))
  check("main content padded so the bar never covers it", /pb-20 lg:pb-0/.test(shell))
  const nav = read("app/components/layout/mobile-bottom-nav.tsx")
  check("nav pads env(safe-area-inset-bottom)", /pb-\[env\(safe-area-inset-bottom\)\]/.test(nav))

  // ── [5] Every role has a bottom nav ───────────────────────────────────────
  console.log("\n[5 · NAVIGATION_BY_ROLE mobileBottomNav coverage]")
  const { NAVIGATION_BY_ROLE } = await import("../app/config/navigation-config")
  const roles = Object.keys(NAVIGATION_BY_ROLE)
  check(`config defines roles (${roles.length})`, roles.length >= 10)
  for (const role of roles) {
    const items = (NAVIGATION_BY_ROLE as any)[role]?.mobileBottomNav ?? []
    const ok = items.length >= 1 && items.length <= 5 && items.every((i: any) => typeof i.href === "string" && i.href.startsWith("/"))
    check(`${role}: 1–5 items, all with hrefs (${items.length})`, ok)
  }

  // ── [6] Service-worker verdict ────────────────────────────────────────────
  console.log("\n[6 · SW verdict — push-only, no caching SW in v1]")
  const manifestSrc = read("app/manifest.ts")
  check("verdict documented in app/manifest.ts header", /NO OFFLINE SERVICE WORKER/i.test(manifestSrc))
  check("MOBILE.md documents the no-caching-SW verdict", existsSync(join(ROOT, "MOBILE.md")) && /No offline\/caching service worker/i.test(read("MOBILE.md")))
  const pushSw = read("public/push-sw.js")
  check("push-sw.js handles push", /addEventListener\(["']push["']/.test(pushSw))
  check("push-sw.js handles notificationclick", /addEventListener\(["']notificationclick["']/.test(pushSw))
  check("push-sw.js has NO fetch handler (never intercepts navigation)", !/addEventListener\(["']fetch["']/.test(pushSw))

  // ── [7] Portal + legacy cleanup ───────────────────────────────────────────
  console.log("\n[7 · portal mobile posture + legacy manifest removed]")
  check("portal bypasses the staff shell (own layout)", /'\/portal'/.test(shell) && existsSync(join(ROOT, "app/portal/[contactId]/layout.tsx")))
  const portalNav = read("app/components/features/portal/base/PortalNav.tsx")
  check("portal tab nav horizontally scrollable on phones", /overflow-x-auto/.test(portalNav) && /whitespace-nowrap/.test(portalNav))
  check("orphaned public/manifest.json (broken icon refs) removed", !existsSync(join(ROOT, "public/manifest.json")))

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
