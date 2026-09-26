#!/usr/bin/env tsx
/**
 * scripts/screenshot-capture-guard.ts   (npm run test:screenshot-capture)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SCREENSHOT SEAM, PROVED OFFLINE (lane 78B, owner verbatim: "an ai agent
 * can take screenshots of the portal and/or os tabs/user dashboards and/or
 * like zillow property zestimates of a property from using a search tool so
 * these screenshots can be used in videos and/or demos and/or training
 * material").
 *
 * What it holds, and how each is measured (CLAUDE.md §2 — every absence
 * assertion carries a positive control; every scan reads STRIPPED source):
 *   1. ONE seam / ONE launcher / ONE host — puppeteer.launch( and the
 *      @sparticuz/chromium-min import each exist in exactly one runtime file;
 *      the seam stores through hostRenderedMedia and never touches storage or
 *      a blob client directly.
 *   2. DEMO-TENANT-ONLY for OS surfaces — the pure gate and a stubbed capture
 *      run: a real brokerageId (positive control) and a missing demo tenant
 *      both refuse BEFORE any provider call; the demo path mints the owner
 *      session and hands the provider the @supabase/ssr cookie + redaction.
 *   3. REDACTION — defaults merged with extras, injected as blur CSS.
 *   4. ToS — robots.txt honoured (pure parser controls + a refused stubbed
 *      run), host allowlist, per-host rate ceiling, cache by URL+day, source +
 *      captured_at on the row, third-party rows never 'approved'.
 *   5. NO CUSTOMER-FACING TOOL imports the module (specimen-controlled scan);
 *      the prospect tool reaches ONLY the os_surface lookup.
 *   6. PLANNERS REACH IT — video (imageUrls), demo ([[STILL:url]]), training
 *      (figures), and the refresh rides marketing-image-regen (no new cron).
 *   7. OFFLINE — no browser launches here: the module never imports
 *      puppeteer-core at top level and every run uses a counting stub.
 *
 * Run: npx tsx --conditions=react-server scripts/screenshot-capture-guard.ts
 * (react-server: lib/security/public-rate-limit.ts carries `server-only`).
 */
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { stripComments, blankStrings } from "./strip-comments"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import {
  SCREENSHOT_KINDS, DEFAULT_REDACT_SELECTORS, DEMO_STILL_SURFACES, PUBLIC_PAGE_HOSTS, PUBLIC_PAGE_RATE,
  planScreenshotCapture, assertDemoTenantOnly, isRobotsAllowed, redactionCss, screenshotCacheKey, screenshotAssetRow,
  captureScreenshot, capturePublicPropertyPage, demoSessionCookies, stillUrlsForDemoTopic, stillUrlsForVideoAngle,
  figuresForEducationTopic, renderFigures, stillsAsBrollClips, resolveScreenshotProvider, seedMissingDemoStill,
  type ScreenshotProvider, type ProviderCaptureInput, type ScreenshotAssetRow,
} from "../lib/assets/screenshot-capture"
import { findPlaywrightChromium, isServerlessChromiumHost, resolveChromiumExecutable, DEFAULT_CHROMIUM_PACK_URL } from "../lib/remotion/chromium-executable"
import { PRODUCT_DEMO_TOPICS, describeProductDemo, splitDemoStillToken, splitDemoClipToken, demoStillToken } from "../lib/platform/product-demo"
import { PRODUCT_ANGLES } from "../lib/platform/product-content"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const rel = (p: string) => p.replace(root + "/", "")
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(p.startsWith("/") ? p : join(root, p), "utf8")
const stripped = (p: string) => blankStrings(stripComments(src(p)))
const strippedKeepStrings = (p: string) => stripComments(src(p))
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p)
  }
  return out
}
const runtimeFiles = [...walk(join(root, "lib")), ...walk(join(root, "app"))]
const SEAM = "lib/assets/screenshot-capture.ts"
const LAUNCHER = "lib/remotion/chromium-executable.ts"

// Env the seam reads (never a real origin — the stub provider never navigates).
process.env.NEXT_PUBLIC_APP_URL = "https://os.example.test"
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefghijklmnop.supabase.co"
delete process.env.VERCEL; delete process.env.AWS_LAMBDA_FUNCTION_NAME; delete process.env.SCREENSHOT_PROVIDER

// ── Stubs ────────────────────────────────────────────────────────────────────
function countingProvider(): ScreenshotProvider & { calls: ProviderCaptureInput[] } {
  const calls: ProviderCaptureInput[] = []
  // The stub CONFIRMS every readiness label (wave 81D) — the seam refuses otherwise; the refusal
  // itself is proved by scripts/zestimate-only-guard.ts with a provider that confirms nothing.
  return { name: "puppeteer", calls, async capture(input) { calls.push(input); return { png: Buffer.from("png-bytes"), satisfied: input.readyWhen.map((r) => r.label) } } }
}
interface SvcOpts { cacheHit?: { id: string; asset_url: string; metadata: Record<string, unknown> } | null; insertId?: string }
function makeSvc(opts: SvcOpts = {}) {
  const calls: string[] = []
  const inserted: Array<Record<string, unknown>> = []
  const chain = (table: string) => {
    const q: any = { _op: "select" }
    for (const m of ["select", "eq", "is", "lt", "in", "order", "limit", "not", "or", "gte", "neq"]) q[m] = () => q
    q.insert = (row: Record<string, unknown>) => { q._op = "insert"; inserted.push(row); return q }
    q.update = () => { q._op = "update"; return q }
    q.delete = () => { q._op = "delete"; return q }
    q.maybeSingle = async () => ({ data: table === "marketing_assets" && q._op === "select" ? (opts.cacheHit ?? null) : null, error: null })
    q.single = async () => ({ data: { id: opts.insertId ?? "row-new" }, error: null })
    q.then = (res: any, rej: any) => Promise.resolve({ data: [], error: null }).then(res, rej)
    return q
  }
  return {
    calls, inserted,
    from: (t: string) => { calls.push(`from:${t}`); return chain(t) },
    storage: { from: (b: string) => ({
      upload: async (p: string) => { calls.push(`upload:${b}/${p}`); return { error: null } },
      getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.example.test/${b}/${p}` } }),
    }) },
    auth: { admin: { generateLink: async () => ({ data: null, error: { message: "stub: admin link must not be minted in a proof" } }) } },
  }
}
const demoSession = { access_token: "a".repeat(40), refresh_token: "r".repeat(20), expires_at: 1_900_000_000, expires_in: 3600, token_type: "bearer", user: { id: "demo-owner" } }
const mintOk = async () => ({ ok: true as const, session: demoSession })

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[1 · ONE seam, ONE launcher, ONE host]")
const launchers = runtimeFiles.filter((f) => stripped(f).includes("puppeteer.launch(")).map(rel)
check("puppeteer.launch( exists in exactly one runtime file — the seam", launchers.length === 1 && launchers[0] === SEAM, launchers.join(", "))
check("positive control: the launch finder recognises a specimen", blankStrings(stripComments(`const b = await puppeteer.launch({ headless: true })`)).includes("puppeteer.launch("))
// IMPORT forms only (`from "…"` / `import("…")`): the package name also appears
// in prose strings (an error message, a registry charter), which are not launchers.
const CHROMIUM_IMPORT_RE = /(?:from\s*|import\s*\(\s*)"@sparticuz\/chromium-min"/
const chromiumImporters = runtimeFiles.filter((f) => CHROMIUM_IMPORT_RE.test(strippedKeepStrings(f))).map(rel)
check("@sparticuz/chromium-min is imported by exactly one runtime file — the launcher-resolver", chromiumImporters.length === 1 && chromiumImporters[0] === LAUNCHER, chromiumImporters.join(", "))
check("positive control: the chromium-import finder recognises both import forms and ignores prose", CHROMIUM_IMPORT_RE.test(stripComments(`const c = (await import("@sparticuz/chromium-min")).default`)) && CHROMIUM_IMPORT_RE.test(`import chromium from "@sparticuz/chromium-min"`) && !CHROMIUM_IMPORT_RE.test(`throw new Error("uses @sparticuz/chromium-min")`))
for (const route of ["app/api/internal/remotion/render-composition/route.ts", "app/api/internal/remotion/render-newsletter-video/route.ts", "app/api/internal/remotion/render-just-listed/route.ts"]) {
  const s = strippedKeepStrings(route)
  check(`${route} resolves chromium through the one launcher (tombstone kept in prose)`, s.includes("@/lib/remotion/chromium-executable") && s.includes("resolveChromiumExecutable") && src(route).includes("TOMBSTONE"))
}
const seamSrc = strippedKeepStrings(SEAM)
check("the seam stores ONLY through hostRenderedMedia (never storage.from / @vercel/blob / put())", seamSrc.includes("hostRenderedMedia(") && !/\.storage\s*\.from\(|@vercel\/blob|\bput\(/.test(seamSrc))
check("the seam's chromium comes from the one resolver with local discovery (no second pack URL)", seamSrc.includes("resolveChromiumExecutable({ localDiscovery: true })") && !seamSrc.includes("chromium-v"))
check("the seam never imports puppeteer-core at top level (offline-loadable; launch is lazy)", !/^import[^\n]*from "puppeteer-core"/m.test(seamSrc) && /import\("puppeteer-core"\)/.test(seamSrc))
check("the seam's row goes to the shared image library rail (marketing_assets, source_table image_library) — no new table, no migration", seamSrc.includes('from("marketing_assets")') && seamSrc.includes('source_table: "image_library"') && !readdirSync(join(root, "supabase/migrations")).some((f) => /screenshot/i.test(f)))

console.log("\n[2 · the launcher-resolver]")
const tmp = mkdtempSync(join(tmpdir(), "pw-cache-"))
mkdirSync(join(tmp, "chromium-99", "chrome-linux"), { recursive: true }); writeFileSync(join(tmp, "chromium-99", "chrome-linux", "chrome"), "")
mkdirSync(join(tmp, "chromium-1194", "chrome-linux"), { recursive: true }); writeFileSync(join(tmp, "chromium-1194", "chrome-linux", "chrome"), "")
mkdirSync(join(tmp, "ffmpeg-1011"), { recursive: true })
check("findPlaywrightChromium picks the newest chromium-<build> binary and ignores ffmpeg", findPlaywrightChromium(tmp) === join(tmp, "chromium-1194", "chrome-linux", "chrome"))
check("findPlaywrightChromium is null for a missing cache", findPlaywrightChromium(join(tmp, "nope")) === null && findPlaywrightChromium(undefined) === null)
check("isServerlessChromiumHost reads VERCEL / AWS_LAMBDA_FUNCTION_NAME from the env it is given", isServerlessChromiumHost({ VERCEL: "1" } as unknown as NodeJS.ProcessEnv) && isServerlessChromiumHost({ AWS_LAMBDA_FUNCTION_NAME: "f" } as unknown as NodeJS.ProcessEnv) && !isServerlessChromiumHost({} as unknown as NodeJS.ProcessEnv))
check("off-serverless without discovery → undefined (Remotion-managed browser, the routes' historical behaviour)", (await resolveChromiumExecutable({ env: {} as unknown as NodeJS.ProcessEnv })) === undefined)
check("CHROMIUM_EXECUTABLE_PATH wins under discovery; else the Playwright cache", (await resolveChromiumExecutable({ localDiscovery: true, env: { CHROMIUM_EXECUTABLE_PATH: "/opt/x/chrome" } as unknown as NodeJS.ProcessEnv })) === "/opt/x/chrome"
  && (await resolveChromiumExecutable({ localDiscovery: true, env: { PLAYWRIGHT_BROWSERS_PATH: tmp } as unknown as NodeJS.ProcessEnv })) === join(tmp, "chromium-1194", "chrome-linux", "chrome"))
check("the pinned pack URL tracks the @sparticuz/chromium-min major in package.json", (() => {
  const pkg = JSON.parse(src("package.json")) as { dependencies: Record<string, string> }
  const major = /(\d+)/.exec(pkg.dependencies["@sparticuz/chromium-min"] ?? "")?.[1]
  return !!major && DEFAULT_CHROMIUM_PACK_URL.includes(`/v${major}.`)
})())
rmSync(tmp, { recursive: true, force: true })

console.log("\n[3 · the plan — pure]")
const osPlan = planScreenshotCapture({ kind: "os_surface", surfaceId: "deals", redact: [".secret"], brokerageId: "platform" }, { siteOrigin: "https://os.example.test", now: new Date("2026-09-22T10:00:00Z") })
check("an os_surface plan targets the registered route on the site origin, needs the demo session, blurs defaults + extras", osPlan.ok && osPlan.targetUrl === "https://os.example.test/dashboard/transactions" && osPlan.needsDemoSession && osPlan.redactSelectors.includes(".secret") && DEFAULT_REDACT_SELECTORS.every((s) => osPlan.redactSelectors.includes(s)))
check("storage path lives under screenshots/<kind>/<surface>/<day>-<key>.png in the one media bucket", osPlan.ok && /^screenshots\/os_surface\/deals\/2026-09-22-[0-9a-f]{32}\.png$/.test(osPlan.storagePath))
check("an unregistered surface id refuses by name", !planScreenshotCapture({ kind: "os_surface", surfaceId: "nope" }, { siteOrigin: "https://x.test" }).ok)
check("no site origin → no os_surface capture (never an invented domain)", !planScreenshotCapture({ kind: "os_surface", surfaceId: "deals" }, { siteOrigin: "" }).ok)
check("a protocol-relative route refuses (no off-site redirect through the demo session)", !planScreenshotCapture({ kind: "os_surface", route: "//evil.test/x" }, { siteOrigin: "https://x.test" }).ok)
const pub = planScreenshotCapture({ kind: "public_page", url: "https://www.zillow.com/homedetails/123-Main-St/1_zpid/#frag" }, { siteOrigin: "", now: new Date("2026-09-22T10:00:00Z") })
check("a public_page plan on an allowlisted host needs no session, blurs nothing, drops the fragment", pub.ok && !pub.needsDemoSession && pub.redactSelectors.length === 0 && pub.targetUrl === "https://www.zillow.com/homedetails/123-Main-St/1_zpid/")
check("a host off PUBLIC_PAGE_HOSTS refuses; a non-http scheme refuses", !planScreenshotCapture({ kind: "public_page", url: "https://example.com/x" }, { siteOrigin: "" }).ok && !planScreenshotCapture({ kind: "public_page", url: "ftp://zillow.com/x" }, { siteOrigin: "" }).ok)
check("the cache key is URL + day: same day → same key, next day → new key", screenshotCacheKey("https://a.test/x", "2026-09-22") === screenshotCacheKey("https://a.test/x", "2026-09-22") && screenshotCacheKey("https://a.test/x", "2026-09-22") !== screenshotCacheKey("https://a.test/x", "2026-09-23"))
check("an unknown kind refuses naming the vocabulary", (() => { const r = planScreenshotCapture({ kind: "pdf" as any }, { siteOrigin: "" }); return !r.ok && r.reason.includes(SCREENSHOT_KINDS.join("|")) })())

console.log("\n[4 · DEMO-TENANT-ONLY, fail-closed]")
check("a real brokerageId refuses (positive control)", !assertDemoTenantOnly("real-tenant", "demo-id").ok)
check("no demo tenant → refuse, even for 'platform' (a gate that cannot run must refuse)", !assertDemoTenantOnly("platform", null).ok && !assertDemoTenantOnly("demo-id", null).ok)
check("'platform' and the demo id itself resolve to the demo tenant", assertDemoTenantOnly("platform", "demo-id").ok && assertDemoTenantOnly("demo-id", "demo-id").ok)
{
  const provider = countingProvider(); const svc = makeSvc()
  const r = await captureScreenshot({ kind: "os_surface", surfaceId: "command_center", brokerageId: "real-tenant" }, { svc, provider, findDemo: async () => ({ id: "demo-id" }), mintSession: mintOk })
  check("stubbed run: a real tenant's id is refused BEFORE the provider, the session mint and the host", !r.ok && /not the demo tenant/.test(r.reason) && provider.calls.length === 0 && !svc.calls.some((c) => c.startsWith("upload:")))
  const r2 = await captureScreenshot({ kind: "os_surface", surfaceId: "command_center", brokerageId: "platform" }, { svc, provider, findDemo: async () => null, mintSession: mintOk })
  check("stubbed run: no demo tenant → refused before the provider", !r2.ok && /no demo tenant/.test(r2.reason) && provider.calls.length === 0)
}
{
  const provider = countingProvider(); const svc = makeSvc({ insertId: "still-1" })
  const r = await captureScreenshot({ kind: "os_surface", surfaceId: "command_center", redact: [".pii-extra"], brokerageId: "platform" }, { svc, provider, findDemo: async () => ({ id: "demo-id" }), mintSession: mintOk, now: new Date("2026-09-22T10:00:00Z") })
  const call = provider.calls[0]
  check("stubbed demo run: ONE provider call carrying the @supabase/ssr session cookie (sb-<ref>-auth-token, base64- encoded) scoped to the site host", !!call && (call.cookies ?? []).length >= 1 && call.cookies![0].name.startsWith("sb-abcdefghijklmnop-auth-token") && call.cookies![0].value.startsWith("base64-") && call.cookies![0].domain === "os.example.test" && call.cookies![0].secure)
  check("redaction reaches the provider: defaults + the extra selector, rendered as blur CSS", !!call && call.redactSelectors.includes(".pii-extra") && call.redactSelectors.includes("[data-pii]") && /filter: blur/.test(redactionCss(call.redactSelectors)) && redactionCss([]) === "")
  check("the still is hosted through the one host into video-assets and recorded as an APPROVED platform-owned library image", r.ok && !r.cached && svc.calls.some((c) => c.startsWith("upload:video-assets/screenshots/os_surface/command_center/")) && svc.inserted.length === 1 && svc.inserted[0].approval_status === "approved" && (svc.inserted[0].metadata as any).source === "owned" && (svc.inserted[0].metadata as any).surface_id === "command_center")
  const cookies = await demoSessionCookies("https://abcdefghijklmnop.supabase.co", demoSession, "os.example.test", true)
  check("demoSessionCookies uses the library's own chunker (a long session splits into numbered chunks, short stays whole)", cookies.length >= 1 && cookies.every((c) => c.name.startsWith("sb-abcdefghijklmnop-auth-token")))
}

console.log("\n[5 · ToS — robots, allowlist, rate ceiling, cache, provenance]")
const robots = "User-agent: *\nDisallow: /homedetails/\nAllow: /homedetails/public/\n\nUser-agent: OtherBot\nDisallow: /\n"
check("robots: the longest-matching rule wins (Disallow /homedetails/, Allow /homedetails/public/)", !isRobotsAllowed(robots, "/homedetails/123/", "VipReOS-DemoStillBot/1.0") && isRobotsAllowed(robots, "/homedetails/public/x", "VipReOS-DemoStillBot/1.0") && isRobotsAllowed(robots, "/b/", "VipReOS-DemoStillBot/1.0"))
check("robots: a group naming our token overrides *; missing/empty robots allows", !isRobotsAllowed("User-agent: VipReOS-DemoStillBot\nDisallow: /\nUser-agent: *\nAllow: /", "/x", "VipReOS-DemoStillBot/1.0") && isRobotsAllowed(null, "/x", "bot") && isRobotsAllowed("", "/x", "bot"))
check("robots: wildcard + $ anchor honoured", !isRobotsAllowed("User-agent: *\nDisallow: /*.pdf$", "/a/b.pdf", "bot") && isRobotsAllowed("User-agent: *\nDisallow: /*.pdf$", "/a/b.pdfx", "bot"))
{
  const provider = countingProvider(); const svc = makeSvc()
  const r = await captureScreenshot({ kind: "public_page", url: "https://www.zillow.com/homedetails/1_zpid/" }, { svc, provider, fetchRobots: async () => robots })
  check("stubbed run: a robots-disallowed page is NOT captured (provider never called, nothing hosted)", !r.ok && /robots\.txt/.test(r.reason) && provider.calls.length === 0 && svc.inserted.length === 0)
}
{
  const provider = countingProvider(); const svc = makeSvc({ insertId: "pub-1" })
  const r = await captureScreenshot({ kind: "public_page", url: "https://www.zillow.com/homedetails/1-Main-Austin-TX/1_zpid/" }, { svc, provider, fetchRobots: async () => "User-agent: *\nAllow: /", now: new Date("2026-09-22T10:00:00Z") })
  const row = svc.inserted[0] as any
  check("stubbed run: an allowed public page is captured once with the identified UA and no cookies", r.ok && provider.calls.length === 1 && provider.calls[0].userAgent.includes("VipReOS-DemoStillBot") && !provider.calls[0].cookies)
  check("the third-party row is PENDING (never a tenant-picker asset), tagged third_party_page, with source_url + captured_at + day + provider, and (83C) marketing_campaign ONLY — never demo/training/video stock", !!row && row.approval_status === "pending" && row.tags.includes("third_party_page") && row.metadata.source_url === "https://www.zillow.com/homedetails/1-Main-Austin-TX/1_zpid/" && row.metadata.captured_at === "2026-09-22T10:00:00.000Z" && row.metadata.day === "2026-09-22" && row.metadata.provider === "puppeteer" && row.metadata.usage === "marketing_campaign_material_never_customer_value" && row.metadata.uses?.join() === "marketing_campaign")
  check("the third-party row's source is NOT a redistributable library source (canShareToTenants would say no)", row && !["ai_image", "upload", "owned", "licensed_redistribution"].includes(row.metadata.source))
}
{
  const provider = countingProvider(); const svc = makeSvc()
  // The apex host: a separate limiter key from the www. captures above (wave 81D — the allowlist
  // is zillow.com only, so the rate test rides the same domain on its other hostname).
  const host = "zillow.com"
  const results: boolean[] = []
  for (let i = 0; i < PUBLIC_PAGE_RATE.limit + 1; i++) {
    const r = await captureScreenshot({ kind: "public_page", url: `https://${host}/property/${i}/` }, { svc, provider, fetchRobots: async () => "User-agent: *\nAllow: /" })
    results.push(r.ok)
  }
  check(`the per-host rate ceiling (${PUBLIC_PAGE_RATE.limit}/${PUBLIC_PAGE_RATE.windowMs / 1000}s) refuses the next capture through the ONE public limiter`, results.slice(0, PUBLIC_PAGE_RATE.limit).every(Boolean) && results[PUBLIC_PAGE_RATE.limit] === false && provider.calls.length === PUBLIC_PAGE_RATE.limit)
}
{
  const provider = countingProvider()
  const svc = makeSvc({ cacheHit: { id: "cached-1", asset_url: "https://cdn.example.test/video-assets/x.png", metadata: { captured_at: "2026-09-22T01:00:00.000Z" } } })
  const r = await captureScreenshot({ kind: "public_page", url: "https://www.zillow.com/homedetails/2_zpid/" }, { svc, provider, fetchRobots: async () => "User-agent: *\nAllow: /" })
  check("cache by URL+day: a same-day row short-circuits before robots, the provider and the host", r.ok && r.cached && r.assetId === "cached-1" && provider.calls.length === 0 && svc.inserted.length === 0)
}
{
  const provider = countingProvider(); const svc = makeSvc({ insertId: "pub-2" })
  const searched: string[][] = []
  const r = await capturePublicPropertyPage("123 Main St, Austin TX zestimate", { svc, provider, fetchRobots: async () => "User-agent: *\nAllow: /", search: async (_q, domains) => { searched.push(domains); return [{ url: "https://example.com/not-a-portal" }, { url: "https://www.zillow.com/homedetails/123-Main/9_zpid/" }] } })
  check("the search tool is domain-restricted to PUBLIC_PAGE_HOSTS and the first PORTAL hit is what gets captured (off-list hits skipped)", r.ok && searched[0]?.join(",") === PUBLIC_PAGE_HOSTS.join(",") && r.sourceUrl === "https://www.zillow.com/homedetails/123-Main/9_zpid/")
  const none = await capturePublicPropertyPage("123 Main St", { svc, provider, search: async () => [] })
  check("no portal hit → honest refusal, nothing captured", !none.ok && /found no public property page/.test(none.reason))
}
check("the seam's public_page row shape uses only live marketing_assets columns and CHECK'd values", (() => {
  if (!pub.ok) return false
  const row = screenshotAssetRow(pub, "https://cdn.example.test/x.png", "2026-09-22T00:00:00.000Z", "puppeteer")
  const cols = new Set(SCHEMA_SNAPSHOT.marketing_assets)
  const v = CHECK_VOCABULARIES.marketing_assets
  return Object.keys(row).every((k) => cols.has(k)) && v.approval_status.includes(row.approval_status as string) && v.visibility_scope.includes(row.visibility_scope as string) && v.asset_type.includes(row.asset_type as string)
})())
check("the hosted provider adapter is selectable by env and refuses unconfigured (never a silent no-op)", resolveScreenshotProvider({} as unknown as NodeJS.ProcessEnv).name === "puppeteer" && resolveScreenshotProvider({ SCREENSHOT_PROVIDER: "hosted" } as unknown as NodeJS.ProcessEnv).name === "hosted"
  && await resolveScreenshotProvider({ SCREENSHOT_PROVIDER: "hosted" } as unknown as NodeJS.ProcessEnv).capture({ url: "https://x", viewport: { width: 1, height: 1 }, redactSelectors: [], readyWhen: [], userAgent: "u", timeoutMs: 1 }).then(() => false, (e: Error) => /not configured/.test(e.message)))

console.log("\n[6 · NO customer-facing tool imports the seam]")
const customerFacingDirs = ["lib/ai-isa", "lib/voice", "lib/portal", "app/portal", "app/api/portal", "app/api/public", "app/api/widget", "lib/customer-portal"]
const customerFiles = customerFacingDirs.flatMap((d) => walk(join(root, d)))
const offenders = customerFiles.filter((f) => /screenshot-capture/.test(strippedKeepStrings(f))).map(rel)
check(`no customer-facing module (${customerFiles.length} files under ${customerFacingDirs.join(", ")}) imports the seam — a Zestimate still is never an agent's statement of value`, offenders.length === 0, offenders.join(", "))
check("positive control: the importer finder recognises a specimen", /screenshot-capture/.test(stripComments(`import { captureScreenshot } from "@/lib/assets/screenshot-capture"`)))
const toolsSrc = strippedKeepStrings("lib/platform/prospect-agent-tools.ts")
const toolImport = /const \{([^}]*)\} = await import\("@\/lib\/assets\/screenshot-capture"\)/.exec(toolsSrc)
check("the platform prospect tool reaches ONLY demoStillForTopic (an os_surface-filtered lookup), never a capture entry", !!toolImport && toolImport[1].trim() === "demoStillForTopic" && !/capturePublicPropertyPage|captureScreenshot/.test(toolsSrc))
check("demoStillForTopic / listDemoStills filter screenshot_kind = os_surface (third-party pages cannot reach the demo)", /screenshot_kind", "os_surface"\)[\s\S]{0,400}order\("updated_at"/.test(seamSrc.slice(seamSrc.indexOf("export async function listDemoStills"))))

console.log("\n[7 · planners reach it — video, demo, training, refresh]")
const autopilot = strippedKeepStrings("lib/platform/product-content-autopilot.ts")
check("video: product-content-autopilot fills composeProductVideoSpec's imageUrls (the ProductPromoReel Ken Burns slot) from demoStillImageUrls", autopilot.includes("demoStillImageUrls(svc, draft.angle)") && /composeProductVideoSpec\(draft\.angle, format, brand, null, imageUrls\)/.test(autopilot))
check("video: the superadmin manual video action uses the same source", /demoStillImageUrls\(svc, input\.angle\)/.test(strippedKeepStrings("app/actions/superadmin/platform-content.ts")))
check("video: stillsAsBrollClips yields the composition-facing BrollClip shape (url + optional caption)", JSON.stringify(stillsAsBrollClips(["https://c/1.png", "https://c/2.png"], ["A"])) === JSON.stringify([{ url: "https://c/1.png", caption: "A" }, { url: "https://c/2.png" }]))
const fakeStills = new Map<string, ScreenshotAssetRow>([
  ["command_center", { id: "1", asset_name: "Command center", asset_url: "https://c/cc.png", thumbnail_url: null, approval_status: "approved", updated_at: null, metadata: { captured_at: "2026-09-20T00:00:00.000Z", surface_id: "command_center" } }],
  ["deals", { id: "2", asset_name: "Deals", asset_url: "https://c/deals.png", thumbnail_url: null, approval_status: "approved", updated_at: null, metadata: { surface_id: "deals" } }],
])
check("video: an angle tagged in the registry gets its surfaces; an untagged angle cycles every available still", stillUrlsForVideoAngle("ai_team", fakeStills).join() === "https://c/cc.png" && stillUrlsForVideoAngle("compliance_wire", fakeStills).length === 2)
check("registry: every videoAngle is a real PRODUCT_ANGLES key; every demoTopic a real PRODUCT_DEMO_TOPICS entry", DEMO_STILL_SURFACES.every((s) => s.videoAngles.every((a) => a in PRODUCT_ANGLES) && s.demoTopics.every((t) => (PRODUCT_DEMO_TOPICS as readonly string[]).includes(t))))
check("registry: every surface route is a real app page (app<route>/page.tsx)", DEMO_STILL_SURFACES.every((s) => existsSync(join(root, "app", s.route.replace(/^\//, ""), "page.tsx"))), DEMO_STILL_SURFACES.filter((s) => !existsSync(join(root, "app", s.route.replace(/^\//, ""), "page.tsx"))).map((s) => s.route).join(", "))
const eduKeys = new Set([...strippedKeepStrings("lib/education/onboarding-curriculum.ts").matchAll(/key: "([a-z_]+)"/g)].map((m) => m[1]))
check("registry: every educationTopic is a real onboarding-curriculum topic key", eduKeys.size > 5 && DEMO_STILL_SURFACES.every((s) => s.educationTopics.every((k) => eduKeys.has(k))), DEMO_STILL_SURFACES.flatMap((s) => s.educationTopics.filter((k) => !eduKeys.has(k))).join(", "))
check("registry: surface ids are unique and every product-demo topic has at least one still surface", new Set(DEMO_STILL_SURFACES.map((s) => s.id)).size === DEMO_STILL_SURFACES.length && PRODUCT_DEMO_TOPICS.every((t) => DEMO_STILL_SURFACES.some((s) => s.demoTopics.includes(t))))
// demo
const shown = describeProductDemo("deals_portal", { brandName: "Acme", stillUrl: "https://c/deals.png", clipUrl: null, surfaceCanShowClip: true }, [])
const voice = describeProductDemo("deals_portal", { brandName: "Acme", stillUrl: "https://c/deals.png", clipUrl: null, surfaceCanShowClip: false }, [])
check("demo: a still token is returned ONLY on a visual surface; voice gets none; with a still the 'nothing to show' line is empty", shown.stillToken === "[[STILL:https://c/deals.png]]" && shown.ifNoClip === "" && voice.stillToken === null && /offer the live demo/.test(voice.ifNoClip))
check("demo: splitDemoStillToken strips the token and coexists with the clip token", (() => { const a = splitDemoClipToken("Look. [[CLIP:https://c/d.mp4]] [[STILL:https://c/deals.png]]"); const b = splitDemoStillToken(a.text); return a.clipUrl === "https://c/d.mp4" && b.stillUrl === "https://c/deals.png" && b.text === "Look." && demoStillToken("https://x") === "[[STILL:https://x]]" })())
check("demo: stillUrlsForDemoTopic follows the registry", stillUrlsForDemoTopic("deals_portal", fakeStills).join() === "https://c/deals.png" && stillUrlsForDemoTopic("overview", fakeStills).join() === "https://c/cc.png")
check("demo: show_product_demo passes the still into describeProductDemo", /stillUrl,\s*\n?\s*surfaceCanShowClip/.test(toolsSrc) && toolsSrc.includes("demoStillForTopic(svc, topic)"))
const widget = strippedKeepStrings("app/embed/[publicId]/embed-widget.tsx")
check("demo: the widget splits the still token beside the clip token and renders it only under deployment=platform", widget.includes("splitDemoStillToken(spoken)") && /isPlatform && demoStillUrl && \(/.test(widget) && /<img src=\{demoStillUrl\}/.test(widget))
// training
const onboarding = strippedKeepStrings("lib/education/onboarding-authoring.ts")
check("training: persistOnboardingModule appends figuresForEducationTopic → renderFigures to the module body", onboarding.includes("figuresForEducationTopic(topic.key") && onboarding.includes("renderFigures(") && /body: \[renderModuleBody\([\s\S]{0,200}figures\]\.filter\(Boolean\)/.test(onboarding))
const figs = figuresForEducationTopic("platform_tour", fakeStills)
check("training: figures carry url, caption, source route and capture date; a topic with no still renders no section (never a broken image)", figs.length === 1 && figs[0].source === "demo tenant /dashboard" && figs[0].capturedAt === "2026-09-20T00:00:00.000Z" && /## In the OS[\s\S]*!\[Command center\]\(https:\/\/c\/cc\.png\)[\s\S]*captured 2026-09-20/.test(renderFigures(figs)) && renderFigures(figuresForEducationTopic("multi_office_ops", fakeStills)) === "")
// refresh
const regen = strippedKeepStrings("app/api/cron/marketing-image-regen/route.ts")
check("refresh: marketing-image-regen flags stale stills and RE-CAPTURES a claimed screenshot row instead of re-generating it", regen.includes("enqueueStaleScreenshotStills(svc)") && regen.includes("recaptureScreenshotAsset(svc") && /meta\.asset_kind === SCREENSHOT_ASSET_KIND/.test(regen))
check("refresh: an idle tick SEEDS the first missing surface (the registry fills itself; refusals surface in the cron JSON)", regen.includes("seedMissingDemoStill(svc)") && /demo_still_result/.test(regen))
check("refresh: no new cron — CRON_REGISTRY carries no screenshot/still entry and the image-regen drain is registered", !CRON_REGISTRY.some((e) => /screenshot|demo-still/.test(e.path)) && CRON_REGISTRY.some((e) => e.path === "/api/cron/marketing-image-regen"))
{
  const provider = countingProvider(); const svc = makeSvc({ insertId: "seed-1" })
  const seeded = await seedMissingDemoStill(svc, { provider, findDemo: async () => ({ id: "demo-id" }), mintSession: mintOk })
  check("seedMissingDemoStill captures exactly ONE missing surface per call (registry order) through the same guarded entry", seeded.surfaceId === DEMO_STILL_SURFACES[0].id && !!seeded.result?.ok && provider.calls.length === 1)
}
// human door
const door = strippedKeepStrings("app/actions/superadmin/screenshot-capture.ts")
// Re-anchored (wave 79C, CLAUDE.md §2 — assert the RULE, never a waypoint):
// the door's export COUNT was pinned at 3 and went red the moment lane 79C
// added the two multi-use doors (list stills for a use / set a still's
// uses). The rule is per export: every `export async function` awaits
// requireMarketing() before it touches the service client, and there are no
// non-async exports. Derived from the source, whatever the count.
{
  const doorExports = door.split(/(?=export async function )/).filter((chunk) => chunk.startsWith("export async function "))
  const gatedFirst = doorExports.every((chunk) => {
    const gate = chunk.indexOf("await requireMarketing()")
    const svcAt = chunk.indexOf("createServiceClient()")
    return gate !== -1 && (svcAt === -1 || gate < svcAt)
  })
  check(`the superadmin door gates EVERY export (${doorExports.length}) with requireMarketing before the service client (§4 gate first) and is 'use server' with async exports only`,
    src("app/actions/superadmin/screenshot-capture.ts").startsWith('"use server"') && doorExports.length >= 3 && !/export (const|function|let)/.test(door) && gatedFirst)
  check("CONTROL: an export that reaches the service client before the gate is caught",
    !(["export async function bad() {\n  const svc = createServiceClient()\n  const auth = await requireMarketing()\n}"].every((chunk) => { const g = chunk.indexOf("await requireMarketing()"); const s = chunk.indexOf("createServiceClient()"); return g !== -1 && (s === -1 || g < s) })))
}
check("the door never accepts a brokerageId from its input (tenant is the demo tenant, resolved server-side)", !/input\.brokerageId|brokerageId: input/.test(door) && door.includes('brokerageId: "platform"'))
check("refresh: the asset-manager regenerate_asset(kind=image) path already flips regen_status — the seam adds no second flag writer", (strippedKeepStrings("lib/agents/asset-manager-actions.ts").match(/regen_status: "requested"/g) ?? []).length === 1 && (seamSrc.match(/regen_status: "requested"/g) ?? []).length === 1)

console.log("\n[8 · registration]")
const pkg = JSON.parse(src("package.json")) as { scripts: Record<string, string> }
check("package.json registers test:screenshot-capture under react-server (public-rate-limit is server-only)", /--conditions=react-server scripts\/screenshot-capture-guard\.ts/.test(pkg.scripts["test:screenshot-capture"] ?? ""))
check("the guard chain runs it after test:scrapers (ordering, not adjacency)", pkg.scripts.guard.indexOf("npm run test:scrapers") > 0 && pkg.scripts.guard.indexOf("npm run test:screenshot-capture") > pkg.scripts.guard.indexOf("npm run test:scrapers"))
check("MAINTENANCE_DOMAINS.screenshot_capture → asset_manager, proof test:screenshot-capture", MAINTENANCE_DOMAINS.screenshot_capture?.manager === "asset_manager" && MAINTENANCE_DOMAINS.screenshot_capture?.proof === "test:screenshot-capture")
check(".env.example documents the seam's env (CHROMIUM_EXECUTABLE_PATH, SCREENSHOT_PROVIDER, SCREENSHOT_API_URL, SCREENSHOT_API_KEY, PLAYWRIGHT_BROWSERS_PATH)", ["CHROMIUM_EXECUTABLE_PATH=", "SCREENSHOT_PROVIDER=", "SCREENSHOT_API_URL=", "SCREENSHOT_API_KEY=", "PLAYWRIGHT_BROWSERS_PATH="].every((k) => src(".env.example").includes(`\n${k}`)))

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed} failed`)
console.log(`blind spots: the stubbed runs never navigate (a real capture is a smoke run, not this proof); the customer-facing scan covers ${customerFacingDirs.length} directories by name; robots parsing reads Allow/Disallow/User-agent only.`)
if (failed) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1) }
