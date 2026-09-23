// lib/assets/screenshot-capture.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE SCREENSHOT SEAM — an asset_manager capability (lane 78B, owner verbatim:
// "an ai agent can take screenshots of the portal and/or os tabs/user
// dashboards and/or like zillow property zestimates of a property from using a
// search tool so these screenshots can be used in videos and/or demos and/or
// training material").
//
// ALREADY EXISTED — REUSED (the inventory that shaped this file):
//   · puppeteer-core + @sparticuz/chromium-min are ALREADY production deps —
//     @remotion/renderer drives them for every reel. The three render routes
//     each carried a private copy of the chromium resolution; that is now ONE
//     launcher-resolver, lib/remotion/chromium-executable.ts, and this seam is
//     its fourth caller, not a second launcher. (The PDF renderers named in the
//     wave brief — board-packet-pdf, client-pdf, certificate-pdf — are pdf-lib
//     and launch nothing; they were checked, not reused.)
//   · ONE media host: lib/remotion/media-host.ts::hostRenderedMedia into the
//     `video-assets` bucket (PUBLIC by design — a still a render worker fetches
//     with no session belongs there; CLASS_BUCKETS.image lists it).
//   · ONE asset table: marketing_assets on the SHARED IMAGE LIBRARY rail
//     (visibility_scope='platform', brokerage_id NULL, asset_type='image',
//     source_table='image_library' — the exact row shape
//     app/actions/marketing/image-library.ts::saveLibraryImageAction writes).
//     No new table, so no migration.
//   · ONE demo tenant: lib/platform/demo-tenant.ts::findDemoBrokerage — the
//     brokerages.is_demo row. OS-surface captures are minted as the DEMO OWNER
//     (DEMO_OWNER_EMAIL) and only ever for that tenant.
//   · ONE public rate limiter: lib/security/public-rate-limit.ts.
//   · ONE search tool: lib/external/exa-client.ts::exaSearch, domain-restricted
//     to the public property portals, to FIND the page to capture.
//   · ONE refresh loop: app/api/cron/marketing-image-regen (every 10 min)
//     already drains marketing_assets.regen_status='requested'; a screenshot
//     row is re-captured there instead of re-generated. No new cron.
//   · Remotion image slot: lib/platform/product-content.ts::
//     composeProductVideoSpec(…imageUrls) → remotion/ProductPromoReel.tsx
//     (the Ken Burns platform-screenshot slideshow the registry note said
//     was filled BY HAND — "copy URL into reel imageUrls").
//   · Demo token: lib/platform/product-demo.ts [[CLIP:url]] — a still variant
//     [[STILL:url]] rides the same split/append path.
//   · Training material: lib/education/onboarding-authoring.ts::
//     persistOnboardingModule — figures append to the module body.
//
// TWO KINDS, ONE ENTRY (captureScreenshot):
//   os_surface  — an authenticated capture of a DEMO_STILL_SURFACES route as
//                 the demo tenant's owner. Refuses any other brokerage. PII is
//                 blurred by selector (demo data is fictional; the blur is
//                 belt-and-braces). Rows are approved platform library images
//                 (platform-OWNED content — canShareToTenants "owned").
//   public_page — a public property page (Zestimate & co.) found through the
//                 search tool. ToS-aware: robots.txt honoured, host allowlist,
//                 per-host rate limit, cached by URL+day, source + captured_at
//                 recorded. Rows land approval_status='pending' so they NEVER
//                 enter tenant pickers (listImageLibraryAction filters
//                 approved): they are DEMO / TRAINING / VIDEO material, never
//                 an AI-agent statement of a home's value to a customer —
//                 scripts/screenshot-capture-guard.ts asserts no customer-
//                 facing tool imports this module.
//
// PROVIDER ADAPTER: one `ScreenshotProvider` shape; the default drives
// puppeteer-core on the resolved chromium (local / self-hosted / Vercel via the
// -min pack). A hosted screenshot API drops in behind SCREENSHOT_PROVIDER=
// hosted (ScreenshotOne-shaped request — cheapest evaluated: 100 free/mo,
// cache hits free, $17/2k; see the lane notes) without touching any caller.
//
// No model calls. Every DB-touching dependency is imported lazily so the pure
// planners load under tsx for the proof.

import { createHash } from "node:crypto"
import type { PickedBrollClip } from "@/lib/video/broll-picker"
import type { ProductDemoTopic } from "@/lib/platform/product-demo"

// ── Kinds + surfaces ─────────────────────────────────────────────────────────

export const SCREENSHOT_KINDS = ["os_surface", "public_page"] as const
export type ScreenshotKind = (typeof SCREENSHOT_KINDS)[number]

export interface Viewport { width: number; height: number; deviceScaleFactor?: number }
export const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900, deviceScaleFactor: 1 }

/** Selectors blurred on every OS-surface capture. Demo data is fictional
 *  (Exampleton, 555 phones, example.com) — this is the second lock. */
export const DEFAULT_REDACT_SELECTORS = [
  "[data-pii]",
  'a[href^="mailto:"]',
  'a[href^="tel:"]',
  'input[type="email"]',
  'input[type="tel"]',
] as const

export interface DemoStillSurface {
  /** Stable id — the `surface_id` a planner asks for. */
  id: string
  /** App route captured as the demo owner. */
  route: string
  label: string
  /** Product-demo topics this still illustrates ([[STILL:url]] on show_product_demo). */
  demoTopics: readonly ProductDemoTopic[]
  /** Onboarding topic keys (lib/education/onboarding-curriculum.ts) it figures in. */
  educationTopics: readonly string[]
  /** Product-video angles (lib/platform/product-content.ts PRODUCT_ANGLES keys) it rides as imageUrls. */
  videoAngles: readonly string[]
}

/**
 * THE REGISTRY of demo stills — every route is a real app/… /page.tsx (the
 * proof checks). Adding a surface here is the whole change: the refresh loop,
 * the demo, the video slot and the training figures all read this list.
 */
export const DEMO_STILL_SURFACES: readonly DemoStillSurface[] = [
  { id: "command_center", route: "/dashboard",              label: "Command center",         demoTopics: ["overview", "recruiting_ops"], educationTopics: ["platform_tour", "working_with_managers"], videoAngles: ["ai_team"] },
  { id: "lead_desk",      route: "/dashboard/acquisition",  label: "Lead acquisition desk",  demoTopics: ["reception_isa"],               educationTopics: ["solo_pipeline"],                        videoAngles: [] },
  { id: "sphere",         route: "/dashboard/sphere",       label: "Sphere / contacts",      demoTopics: ["reception_isa"],               educationTopics: ["solo_pipeline", "persona_playbook"],    videoAngles: [] },
  { id: "deals",          route: "/dashboard/transactions", label: "Deals board",            demoTopics: ["deals_portal"],                educationTopics: ["contract_walkthrough"],                 videoAngles: [] },
  { id: "video_studio",   route: "/dashboard/videos",       label: "Video studio",           demoTopics: ["video_marketing"],             educationTopics: ["self_marketing"],                       videoAngles: [] },
  { id: "marketing",      route: "/dashboard/marketing",    label: "Marketing hub",          demoTopics: ["video_marketing"],             educationTopics: ["self_marketing"],                       videoAngles: [] },
  { id: "team_board",     route: "/dashboard/team",         label: "Team board",             demoTopics: ["recruiting_ops"],              educationTopics: ["team_collaboration", "team_leadership"], videoAngles: [] },
  { id: "client_portal",  route: "/portal",                 label: "Client portal",          demoTopics: ["deals_portal", "live_agent"],  educationTopics: [],                                       videoAngles: [] },
] as const

export function demoStillSurface(id: string): DemoStillSurface | null {
  return DEMO_STILL_SURFACES.find((s) => s.id === id) ?? null
}

/** Public property-page hosts a capture may target (subdomains included). The
 *  search tool is restricted to the same list. */
export const PUBLIC_PAGE_HOSTS = ["zillow.com", "redfin.com", "realtor.com", "trulia.com", "homes.com"] as const

/** Identified, honest UA — robots.txt rules for this token are honoured. */
export const SCREENSHOT_USER_AGENT = "VipReOS-DemoStillBot/1.0 (demo/training material capture; honours robots.txt)"

/** Per-host ceiling on public-page captures (the rate limiter's window). */
export const PUBLIC_PAGE_RATE = { limit: 3, windowMs: 60_000 } as const

/** A still older than this is re-captured by the regen loop. */
export const STILL_MAX_AGE_DAYS = 7

// ── Request / plan ───────────────────────────────────────────────────────────

export interface ScreenshotRequest {
  kind: ScreenshotKind
  /** os_surface: a DEMO_STILL_SURFACES id, or a raw app route. */
  surfaceId?: string
  route?: string
  /** public_page: the absolute URL to capture. */
  url?: string
  viewport?: Partial<Viewport>
  /** Extra selectors to blur (os_surface only; merged with the defaults). */
  redact?: string[]
  /** os_surface: MUST be the demo tenant's id, or "platform" to resolve it. */
  brokerageId?: string | "platform"
  /** Human label for the library row. */
  label?: string
  /** Day key override (tests); defaults to today UTC. */
  dayIso?: string
  /**
   * TENANT OWNER (wave 80D — owner: "screenshots can be used by tenants").
   * When set, the row lands in THAT brokerage's marketing assets
   * (visibility_scope='brokerage', brokerage_id, created_by) instead of the
   * platform library, with exactly these uses tagged, and the URL+day cache is
   * scoped to the same tenant (one tenant's still is never another's). The
   * brokerageId here comes from the caller's SESSION gate
   * (lib/marketing/tenant-screenshot-door.ts), never from a request body.
   * public_page only — an os_surface capture stays demo-tenant-only.
   */
  owner?: ScreenshotOwner
}

export interface ScreenshotOwner {
  brokerageId: string
  createdBy: string | null
  uses?: readonly ScreenshotUse[]
  /** Free provenance the owner records on metadata (estimate_source, address, listing_id…). */
  provenance?: Record<string, unknown>
}

export interface ScreenshotPlan {
  ok: true
  kind: ScreenshotKind
  targetUrl: string
  /** os_surface only — the route captured. */
  route: string | null
  surface: DemoStillSurface | null
  needsDemoSession: boolean
  redactSelectors: string[]
  viewport: Viewport
  /** URL + day — the cache key; a second capture the same day is a cache hit. */
  cacheKey: string
  /** video-assets object path. */
  storagePath: string
  label: string
  host: string
  dayIso: string
}
export interface ScreenshotRefusal { ok: false; reason: string }

export function screenshotCacheKey(url: string, dayIso: string): string {
  return createHash("sha256").update(`${url}\n${dayIso}`).digest("hex").slice(0, 32)
}

export function isPublicPageHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return PUBLIC_PAGE_HOSTS.some((d) => h === d || h.endsWith(`.${d}`))
}

/**
 * PURE: decide everything about a capture before anything runs. `siteOrigin`
 * is lib/platform/site-url.ts::siteUrl() (never a hardcoded domain).
 */
export function planScreenshotCapture(
  req: ScreenshotRequest,
  ctx: { siteOrigin: string; now?: Date },
): ScreenshotPlan | ScreenshotRefusal {
  const dayIso = req.dayIso ?? (ctx.now ?? new Date()).toISOString().slice(0, 10)
  const viewport: Viewport = { ...DEFAULT_VIEWPORT, ...(req.viewport ?? {}) }
  if (!(SCREENSHOT_KINDS as readonly string[]).includes(req.kind)) {
    return { ok: false, reason: `screenshot kind "${String(req.kind)}" is not one of ${SCREENSHOT_KINDS.join("|")}` }
  }

  if (req.kind === "os_surface") {
    const surface = req.surfaceId ? demoStillSurface(req.surfaceId) : null
    if (req.surfaceId && !surface) return { ok: false, reason: `demo still surface "${req.surfaceId}" is not registered in DEMO_STILL_SURFACES` }
    const route = surface?.route ?? req.route ?? null
    if (!route || !route.startsWith("/") || route.startsWith("//")) return { ok: false, reason: "os_surface capture needs a same-app route starting with '/'" }
    const origin = ctx.siteOrigin.trim().replace(/\/$/, "")
    if (!/^https?:\/\//.test(origin)) return { ok: false, reason: "os_surface capture needs the site origin (NEXT_PUBLIC_APP_URL / VERCEL_URL) — no origin, no capture" }
    const targetUrl = `${origin}${route}`
    const host = new URL(targetUrl).hostname
    const cacheKey = screenshotCacheKey(targetUrl, dayIso)
    const slug = (surface?.id ?? (route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root")).toLowerCase()
    return {
      ok: true, kind: "os_surface", targetUrl, route, surface, needsDemoSession: true,
      redactSelectors: Array.from(new Set([...DEFAULT_REDACT_SELECTORS, ...(req.redact ?? [])])),
      viewport, cacheKey, storagePath: `screenshots/os_surface/${slug}/${dayIso}-${cacheKey}.png`,
      label: req.label ?? surface?.label ?? `OS surface ${route}`, host, dayIso,
    }
  }

  // public_page
  const raw = (req.url ?? "").trim()
  let u: URL
  try { u = new URL(raw) } catch { return { ok: false, reason: "public_page capture needs an absolute http(s) url" } }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "public_page capture url must be http(s)" }
  if (!isPublicPageHost(u.hostname)) return { ok: false, reason: `public_page host "${u.hostname}" is not on PUBLIC_PAGE_HOSTS (${PUBLIC_PAGE_HOSTS.join(", ")})` }
  u.hash = ""
  const targetUrl = u.toString()
  const cacheKey = screenshotCacheKey(targetUrl, dayIso)
  const slug = u.hostname.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase()
  return {
    ok: true, kind: "public_page", targetUrl, route: null, surface: null, needsDemoSession: false,
    redactSelectors: [], viewport, cacheKey,
    storagePath: `screenshots/public_page/${slug}/${dayIso}-${cacheKey}.png`,
    label: req.label ?? `${u.hostname} ${u.pathname}`.slice(0, 160), host: u.hostname, dayIso,
  }
}

/**
 * PURE, FAIL-CLOSED: an OS-surface capture may run ONLY for the brokerage that
 * is the flagged demo tenant. A missing demo tenant refuses; a real tenant's
 * id refuses; "platform" resolves to the demo id.
 */
export function assertDemoTenantOnly(
  requested: string | "platform" | null | undefined,
  demoBrokerageId: string | null,
): { ok: true; brokerageId: string } | ScreenshotRefusal {
  if (!demoBrokerageId) return { ok: false, reason: "no demo tenant exists (no brokerages.is_demo row) — OS-surface screenshots capture only the demo tenant" }
  if (requested === "platform" || requested == null) return { ok: true, brokerageId: demoBrokerageId }
  if (requested !== demoBrokerageId) return { ok: false, reason: `REFUSED: brokerage ${requested} is not the demo tenant — OS-surface screenshots never capture a real tenant's data` }
  return { ok: true, brokerageId: demoBrokerageId }
}

// ── robots.txt (pure) ────────────────────────────────────────────────────────

/**
 * PURE: the longest-match rule for `path` under the most specific user-agent
 * group (our token, else `*`). Missing/empty robots.txt allows. Only the
 * Allow/Disallow/User-agent directives are read — `$`-anchors and `*`
 * wildcards are honoured, sitemaps and crawl-delay ignored.
 */
export function isRobotsAllowed(robotsTxt: string | null | undefined, path: string, userAgentToken: string): boolean {
  if (!robotsTxt || !robotsTxt.trim()) return true
  const token = userAgentToken.toLowerCase()
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; pattern: string }> }> = []
  let cur: { agents: string[]; rules: Array<{ allow: boolean; pattern: string }> } | null = null
  let lastWasAgent = false
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim()
    if (!line) continue
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase(), val = m[2].trim()
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur) }
      cur.agents.push(val.toLowerCase())
      lastWasAgent = true
    } else if ((key === "allow" || key === "disallow") && cur) {
      cur.rules.push({ allow: key === "allow", pattern: val })
      lastWasAgent = false
    } else {
      lastWasAgent = false
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)))
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"))
  if (!chosen.length) return true
  let best: { allow: boolean; len: number } | null = null
  for (const g of chosen) for (const r of g.rules) {
    if (!r.pattern) { if (!r.allow && !best) best = { allow: true, len: 0 }; continue } // "Disallow:" (empty) = allow all
    const re = new RegExp("^" + r.pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*").replace(/\\\$$/, "$"))
    if (re.test(path) && (!best || r.pattern.length > best.len)) best = { allow: r.allow, len: r.pattern.length }
  }
  return best ? best.allow : true
}

// ── Provider adapter ─────────────────────────────────────────────────────────

export interface ProviderCaptureInput {
  url: string
  viewport: Viewport
  /** Cookies to set before navigation (demo session). */
  cookies?: Array<{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite: "Lax" | "Strict" | "None" }>
  /** CSS selectors to blur before the shot. */
  redactSelectors: string[]
  userAgent: string
  timeoutMs: number
}

export interface ScreenshotProvider {
  name: "puppeteer" | "hosted"
  capture(input: ProviderCaptureInput): Promise<{ png: Buffer }>
}

/** PURE: the stylesheet injected to blur redacted selectors. */
export function redactionCss(selectors: string[]): string {
  if (!selectors.length) return ""
  return `${selectors.join(", ")} { filter: blur(9px) !important; user-select: none !important; }`
}

/**
 * The default provider: puppeteer-core on the ONE resolved chromium
 * (lib/remotion/chromium-executable.ts). Local / self-hosted / CI use the
 * Playwright cache or CHROMIUM_EXECUTABLE_PATH; Vercel uses the -min pack.
 */
export const puppeteerScreenshotProvider: ScreenshotProvider = {
  name: "puppeteer",
  async capture(input) {
    const { resolveChromiumExecutable, chromiumLaunchArgs } = await import("@/lib/remotion/chromium-executable")
    const executablePath = await resolveChromiumExecutable({ localDiscovery: true })
    if (!executablePath) throw new Error("[screenshot-capture] no chromium executable: set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH (serverless hosts resolve the @sparticuz/chromium-min pack automatically)")
    const puppeteer = (await import("puppeteer-core")).default
    const browser = await puppeteer.launch({ executablePath, args: await chromiumLaunchArgs(), headless: true, defaultViewport: null })
    try {
      const page = await browser.newPage()
      await page.setUserAgent(input.userAgent)
      await page.setViewport({ width: input.viewport.width, height: input.viewport.height, deviceScaleFactor: input.viewport.deviceScaleFactor ?? 1 })
      if (input.cookies?.length) await browser.setCookie(...input.cookies.map((c) => ({ ...c, expires: -1 })))
      await page.goto(input.url, { waitUntil: "networkidle2", timeout: input.timeoutMs })
      const css = redactionCss(input.redactSelectors)
      if (css) await page.addStyleTag({ content: css })
      const png = Buffer.from(await page.screenshot({ type: "png", fullPage: false }))
      return { png }
    } finally {
      await browser.close().catch(() => {})
    }
  },
}

/**
 * A hosted screenshot API behind the SAME shape — ScreenshotOne-style GET
 * (`?url=&viewport_width=&viewport_height=&format=png&access_key=`), the
 * cheapest hosted path evaluated (100 free/mo, cache hits and failures not
 * metered, $17/2,000). It cannot carry a demo session cookie, so it serves
 * public_page captures only; os_surface stays on puppeteer.
 */
export function hostedScreenshotProvider(env: NodeJS.ProcessEnv = process.env): ScreenshotProvider {
  return {
    name: "hosted",
    async capture(input) {
      const base = env.SCREENSHOT_API_URL?.trim()
      const key = env.SCREENSHOT_API_KEY?.trim()
      if (!base || !key) throw new Error("[screenshot-capture] hosted provider not configured: SCREENSHOT_API_URL + SCREENSHOT_API_KEY")
      if (input.cookies?.length) throw new Error("[screenshot-capture] hosted provider cannot carry the demo session — os_surface captures run on the puppeteer provider")
      const q = new URLSearchParams({
        url: input.url, access_key: key, format: "png",
        viewport_width: String(input.viewport.width), viewport_height: String(input.viewport.height),
        device_scale_factor: String(input.viewport.deviceScaleFactor ?? 1),
        block_cookie_banners: "true", block_ads: "true", cache: "true", cache_ttl: "86400",
        user_agent: input.userAgent,
      })
      const res = await fetch(`${base.replace(/\/$/, "")}?${q.toString()}`, { signal: AbortSignal.timeout(input.timeoutMs) })
      if (!res.ok) throw new Error(`[screenshot-capture] hosted provider refused (${res.status})`)
      return { png: Buffer.from(await res.arrayBuffer()) }
    },
  }
}

/** SCREENSHOT_PROVIDER=hosted selects the hosted adapter; anything else (or
 *  unset) is puppeteer on the one chromium. */
export function resolveScreenshotProvider(env: NodeJS.ProcessEnv = process.env): ScreenshotProvider {
  return env.SCREENSHOT_PROVIDER === "hosted" ? hostedScreenshotProvider(env) : puppeteerScreenshotProvider
}

// ── Demo session (OS surfaces) ───────────────────────────────────────────────

/** PURE: the @supabase/ssr cookie set a browser must carry for `session` —
 *  the SAME encoding createServerClient reads (base64- prefix + chunking),
 *  built with the library's own helpers, never a hand-rolled copy. */
export async function demoSessionCookies(
  supabaseUrl: string,
  session: { access_token: string; refresh_token: string; expires_at?: number; expires_in?: number; token_type?: string; user?: unknown },
  siteHost: string,
  secure: boolean,
): Promise<NonNullable<ProviderCaptureInput["cookies"]>> {
  const { createChunks, stringToBase64URL } = await import("@supabase/ssr")
  const ref = new URL(supabaseUrl).hostname.split(".")[0]
  const value = "base64-" + stringToBase64URL(JSON.stringify(session))
  return createChunks(`sb-${ref}-auth-token`, value).map((c) => ({
    name: c.name, value: c.value, domain: siteHost, path: "/", secure, httpOnly: false, sameSite: "Lax" as const,
  }))
}

/**
 * Mint a session for the demo owner without a password: an admin magic link's
 * token_hash verified server-side. Nothing is emailed. The RFC-2606 owner
 * address bounces harmlessly by design (lib/platform/demo-tenant.ts).
 */
async function mintDemoOwnerSession(svc: any): Promise<{ ok: true; session: { access_token: string; refresh_token: string; expires_at?: number; expires_in?: number; token_type?: string; user?: unknown } } | ScreenshotRefusal> {
  const { DEMO_OWNER_EMAIL } = await import("@/lib/platform/demo-tenant")
  const { data: link, error: linkErr } = await svc.auth.admin.generateLink({ type: "magiclink", email: DEMO_OWNER_EMAIL })
  if (linkErr || !link?.properties?.hashed_token) return { ok: false, reason: `demo owner magic link refused: ${linkErr?.message ?? "no hashed_token"}` }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) return { ok: false, reason: "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY missing — cannot verify the demo owner session" }
  const { createClient } = await import("@supabase/supabase-js")
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  const { data, error } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "magiclink" })
  if (error || !data.session) return { ok: false, reason: `demo owner session verify refused: ${error?.message ?? "no session"}` }
  return { ok: true, session: data.session }
}

// ── Library row (pure) ───────────────────────────────────────────────────────

export interface ScreenshotAssetRow {
  id: string
  asset_name: string | null
  asset_url: string
  thumbnail_url: string | null
  approval_status: string | null
  updated_at: string | null
  metadata: Record<string, unknown> | null
}

/** metadata.asset_kind every screenshot row carries — the discriminator the
 *  regen loop and every planner query on. */
export const SCREENSHOT_ASSET_KIND = "screenshot"

// ── MULTI-USE (wave 79C, owner verbatim: "the zestimate screenshot will be
// used in some marketing campaigns so there can be many uses for the
// screenshots") ────────────────────────────────────────────────────────────
// A screenshot still is ONE library row that several consumers select from:
// marketing campaigns (platform growth content), product videos (the
// `screenshot` body treatment — lib/video/body-visual-model.ts), demos
// ([[STILL:url]]) and training modules (figures). The USE is a tag on the
// existing marketing_assets.tags array (`use:<use>`) mirrored in
// metadata.uses — no column, no CHECK, no migration (CLAUDE.md §3: checked
// against scripts/check-vocabularies.ts marketing_assets before deciding).
// A public_page capture keeps approval_status='pending' whatever its uses:
// the uses say WHO MAY SELECT IT AS MATERIAL; the approval says it never
// enters a tenant picker, and nothing here ever reads a value off the page.
export const SCREENSHOT_USES = ["marketing_campaign", "product_video", "demo", "training"] as const
export type ScreenshotUse = (typeof SCREENSHOT_USES)[number]

export function screenshotUseTag(use: ScreenshotUse): string { return `use:${use}` }

/** Every capture is usable everywhere by default; a human narrows it
 *  (setScreenshotUses) — a Zestimate still meant only for a campaign can be
 *  taken off the training and demo menus without losing the row. */
export function defaultScreenshotUses(_kind: ScreenshotKind): ScreenshotUse[] { return [...SCREENSHOT_USES] }

/** PURE: the tags array with exactly this use set (other tags kept). */
export function tagsWithUses(tags: readonly string[] | null | undefined, uses: readonly ScreenshotUse[]): string[] {
  const kept = (tags ?? []).filter((t) => !t.startsWith("use:"))
  const valid = SCREENSHOT_USES.filter((u) => uses.includes(u))
  return [...kept, ...valid.map(screenshotUseTag)]
}

/** PURE: the uses a row carries — the tag set, else metadata.uses, else (a row
 *  captured before uses existed) every use. */
export function usesOfRow(row: { tags?: readonly string[] | null; metadata?: Record<string, unknown> | null }): ScreenshotUse[] {
  const fromTags = (row.tags ?? []).filter((t) => t.startsWith("use:")).map((t) => t.slice(4)).filter((u): u is ScreenshotUse => (SCREENSHOT_USES as readonly string[]).includes(u))
  if (fromTags.length) return fromTags
  const meta = row.metadata?.uses
  if (Array.isArray(meta)) return meta.filter((u): u is ScreenshotUse => (SCREENSHOT_USES as readonly string[]).includes(String(u)))
  return [...SCREENSHOT_USES]
}

/** PURE: the marketing_assets row for a finished capture — the image-library
 *  row shape, plus provenance. */
export function screenshotAssetRow(plan: ScreenshotPlan, assetUrl: string, capturedAtIso: string, providerName: string, owner?: ScreenshotOwner | null): Record<string, unknown> {
  const isOs = plan.kind === "os_surface"
  // A tenant-owned still carries the uses the tenant chose (marketing_campaign
  // always — it is campaign material by definition); a platform still is
  // usable everywhere until a human narrows it.
  const uses: ScreenshotUse[] = owner
    ? SCREENSHOT_USES.filter((u) => u === "marketing_campaign" || (owner.uses ?? []).includes(u))
    : defaultScreenshotUses(plan.kind)
  if (owner) {
    return {
      brokerage_id: owner.brokerageId,
      created_by: owner.createdBy,
      visibility_scope: "brokerage",
      asset_type: "image",
      asset_name: plan.label.slice(0, 160),
      asset_url: assetUrl,
      thumbnail_url: assetUrl,
      preview_text: `Online estimate page capture of ${plan.host} — marketing material, pending approval`.slice(0, 280),
      source_table: "image_library",
      tags: tagsWithUses(["library", SCREENSHOT_ASSET_KIND, plan.kind, "third_party_page", "estimate_still"], uses),
      // ALWAYS pending: a third-party page capture enters a tenant's campaign
      // only once a human approves it on the tenant's own marketing_assets
      // approval rail (app/actions/marketing-studio.ts approveAsset/rejectAsset).
      approval_status: "pending",
      metadata: {
        asset_kind: SCREENSHOT_ASSET_KIND,
        source: `screenshot:${plan.kind}`,
        screenshot_kind: plan.kind,
        surface_id: null,
        route: null,
        source_url: plan.targetUrl,
        captured_at: capturedAtIso,
        cache_key: plan.cacheKey,
        day: plan.dayIso,
        viewport: plan.viewport,
        redact: plan.redactSelectors,
        provider: providerName,
        usage: "marketing_material_never_customer_value",
        uses,
        customer_facing_value: false,
        license_note: `Third-party page (${plan.host}) captured as this brokerage's own marketing material; source and capture time recorded; shown whole as the portal's own figure; never redistributed as stock and never spoken as a value.`,
        ...(owner.provenance ?? {}),
      },
    }
  }
  return {
    brokerage_id: null,
    created_by: null,
    visibility_scope: "platform",
    asset_type: "image",
    asset_name: plan.label.slice(0, 160),
    asset_url: assetUrl,
    thumbnail_url: assetUrl,
    preview_text: (isOs ? `Demo still of ${plan.route}` : `Public page capture of ${plan.host}`).slice(0, 280),
    source_table: "image_library",
    tags: tagsWithUses(["library", SCREENSHOT_ASSET_KIND, plan.kind, ...(isOs ? [] : ["third_party_page"])], uses),
    // OS stills are platform-OWNED renders (canShareToTenants "owned") and join
    // the tenant pickers; a third-party page capture is NOT redistributable
    // library stock, so it stays 'pending' — reachable only by the demo /
    // training / video planners that query by asset_kind.
    approval_status: isOs ? "approved" : "pending",
    metadata: {
      asset_kind: SCREENSHOT_ASSET_KIND,
      source: isOs ? "owned" : `screenshot:${plan.kind}`,
      screenshot_kind: plan.kind,
      surface_id: plan.surface?.id ?? null,
      route: plan.route,
      source_url: plan.targetUrl,
      captured_at: capturedAtIso,
      cache_key: plan.cacheKey,
      day: plan.dayIso,
      viewport: plan.viewport,
      redact: plan.redactSelectors,
      provider: providerName,
      usage: "demo_training_video_only",
      uses,
      license_note: isOs ? "Platform-owned render of the demo tenant (fictional data)." : `Third-party page (${plan.host}) captured for internal demo/training/video use; source and capture time recorded; not redistributable as stock.`,
    },
  }
}

// ── The one entry ────────────────────────────────────────────────────────────

export interface CaptureDeps {
  svc?: any
  provider?: ScreenshotProvider
  /** Test seam: robots.txt text for a host (default fetches it). */
  fetchRobots?: (origin: string) => Promise<string | null>
  /** Test seam: the demo tenant lookup (default: lib/platform/demo-tenant.ts::findDemoBrokerage — the ONE survivor). */
  findDemo?: (svc: any) => Promise<{ id: string } | null>
  /** Test seam: the demo owner session mint (default: admin magic link → verifyOtp). */
  mintSession?: (svc: any) => ReturnType<typeof mintDemoOwnerSession>
  now?: Date
  timeoutMs?: number
}

export interface CaptureResult {
  ok: true
  assetId: string
  url: string
  cached: boolean
  kind: ScreenshotKind
  capturedAt: string
  sourceUrl: string
}

async function defaultFetchRobots(origin: string): Promise<string | null> {
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: { "user-agent": SCREENSHOT_USER_AGENT }, signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    return await res.text()
  } catch { return null }
}

/**
 * captureScreenshot — plan → tenant guard → cache → ToS → session → provider →
 * ONE host → ONE library row. Refuses loudly; never fabricates a still.
 */
export async function captureScreenshot(req: ScreenshotRequest, deps: CaptureDeps = {}): Promise<CaptureResult | ScreenshotRefusal> {
  const { siteUrl } = await import("@/lib/platform/site-url")
  const plan = planScreenshotCapture(req, { siteOrigin: siteUrl(), now: deps.now })
  if (!plan.ok) return plan
  const owner = req.owner ?? null
  if (owner && plan.kind !== "public_page") return { ok: false, reason: "REFUSED: an os_surface still is demo-tenant-only — a tenant owner may capture public_page stills only" }
  if (owner && !owner.brokerageId) return { ok: false, reason: "REFUSED: a tenant-owned capture needs the session's brokerage id" }
  const svc = deps.svc ?? (await import("@/lib/supabase/service")).createServiceClient()

  // Cache by URL + day — the same still is never captured twice in a day.
  // Scoped to the OWNER: a tenant's cache hit is its own row, never another
  // tenant's and never the platform library's.
  let cacheQ = svc.from("marketing_assets")
    .select("id, asset_url, metadata")
    .eq("asset_type", "image")
    .eq("metadata->>asset_kind", SCREENSHOT_ASSET_KIND).eq("metadata->>cache_key", plan.cacheKey)
  cacheQ = owner ? cacheQ.eq("visibility_scope", "brokerage").eq("brokerage_id", owner.brokerageId) : cacheQ.eq("visibility_scope", "platform")
  const { data: hit, error: hitErr } = await cacheQ.limit(1).maybeSingle()
  if (hitErr) return { ok: false, reason: `screenshot cache read refused: ${hitErr.message}` }
  if (hit) {
    const h = hit as { id: string; asset_url: string; metadata: Record<string, unknown> | null }
    return { ok: true, assetId: h.id, url: h.asset_url, cached: true, kind: plan.kind, capturedAt: String(h.metadata?.captured_at ?? ""), sourceUrl: plan.targetUrl }
  }

  let cookies: ProviderCaptureInput["cookies"]
  if (plan.kind === "os_surface") {
    const findDemo = deps.findDemo ?? (async (s: any) => (await import("@/lib/platform/demo-tenant")).findDemoBrokerage(s))
    const demo = await findDemo(svc)
    const gate = assertDemoTenantOnly(req.brokerageId ?? "platform", demo?.id ?? null)
    if (!gate.ok) return gate
    const minted = await (deps.mintSession ?? mintDemoOwnerSession)(svc)
    if (!minted.ok) return minted
    const target = new URL(plan.targetUrl)
    cookies = await demoSessionCookies(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", minted.session, target.hostname, target.protocol === "https:")
  } else {
    // ToS: robots first, then the per-host rate ceiling.
    const target = new URL(plan.targetUrl)
    const robots = await (deps.fetchRobots ?? defaultFetchRobots)(target.origin)
    if (!isRobotsAllowed(robots, target.pathname + target.search, SCREENSHOT_USER_AGENT)) {
      return { ok: false, reason: `robots.txt on ${target.hostname} disallows ${target.pathname} for this capture agent — not captured` }
    }
    const { checkPublicRateLimit } = await import("@/lib/security/public-rate-limit")
    const verdict = checkPublicRateLimit("screenshot-capture", target.hostname, PUBLIC_PAGE_RATE)
    if (!verdict.allowed) return { ok: false, reason: `public page capture rate ceiling for ${target.hostname} reached — retry in ${verdict.retryAfterSeconds}s` }
  }

  const provider = deps.provider ?? resolveScreenshotProvider()
  const capturedAt = (deps.now ?? new Date()).toISOString()
  let png: Buffer
  try {
    ;({ png } = await provider.capture({
      url: plan.targetUrl, viewport: plan.viewport, cookies, redactSelectors: plan.redactSelectors,
      userAgent: SCREENSHOT_USER_AGENT, timeoutMs: deps.timeoutMs ?? 45_000,
    }))
  } catch (e) {
    return { ok: false, reason: `screenshot provider ${provider.name} failed: ${(e as Error).message}` }
  }

  // ONE host (media-host throws on refusal — surfaced, never swallowed).
  const { hostRenderedMedia } = await import("@/lib/remotion/media-host")
  let url: string
  try { url = await hostRenderedMedia(svc, plan.storagePath, png, "image/png") }
  catch (e) { return { ok: false, reason: (e as Error).message } }

  const { data: row, error } = await svc.from("marketing_assets").insert(screenshotAssetRow(plan, url, capturedAt, provider.name, owner)).select("id").single()
  if (error || !row) return { ok: false, reason: `screenshot library row insert refused: ${error?.message ?? "no row"}` }
  return { ok: true, assetId: (row as { id: string }).id, url, cached: false, kind: plan.kind, capturedAt, sourceUrl: plan.targetUrl }
}

// ── Public property page via the search tool ────────────────────────────────

/**
 * Find a property's public page (Zestimate & co.) through the ONE search tool
 * (lib/external/exa-client.ts), restricted to PUBLIC_PAGE_HOSTS, then capture
 * it. DEMO / TRAINING / VIDEO material only — the value on the page is never
 * read, parsed or spoken; only pixels are kept, with source + captured_at.
 */
export async function capturePublicPropertyPage(
  query: string,
  deps: CaptureDeps & { search?: (q: string, domains: string[]) => Promise<Array<{ url: string | null }>> } = {},
  opts: {
    /** Restrict the search to a SUBSET of PUBLIC_PAGE_HOSTS (a tenant's chosen
     *  estimate source — wave 80D). A host off the allowlist refuses. */
    domains?: readonly string[]
    /** Extra request fields (owner, label) merged onto the capture. */
    request?: Partial<Pick<ScreenshotRequest, "owner" | "label" | "dayIso" | "viewport">>
  } = {},
): Promise<CaptureResult | ScreenshotRefusal> {
  const q = query.trim()
  if (q.length < 6) return { ok: false, reason: "a property search needs an address or a specific query" }
  const domains = opts.domains?.length ? [...opts.domains] : [...PUBLIC_PAGE_HOSTS]
  const offList = domains.filter((d) => !isPublicPageHost(d))
  if (offList.length) return { ok: false, reason: `search domain ${offList.join(", ")} is not on PUBLIC_PAGE_HOSTS (${PUBLIC_PAGE_HOSTS.join(", ")}) — not searched` }
  const search = deps.search ?? (async (qq: string, dd: string[]) => {
    const { exaSearch } = await import("@/lib/external/exa-client")
    return (await exaSearch({ query: qq, numResults: 5, includeDomains: dd })).results
  })
  const results = await search(q, domains)
  const onDomain = (host: string) => domains.some((d) => host === d || host.endsWith(`.${d}`))
  const first = results.map((r) => r.url).find((u): u is string => typeof u === "string" && (() => { try { const h = new URL(u).hostname.toLowerCase(); return isPublicPageHost(h) && onDomain(h) } catch { return false } })())
  if (!first) return { ok: false, reason: `the search tool found no public property page on ${domains.join("/")} for "${q}"` }
  return captureScreenshot({ kind: "public_page", url: first, label: `Public listing page — ${q}`.slice(0, 160), ...(opts.request ?? {}) }, deps)
}

// ── Refresh loop (rides marketing-image-regen) ───────────────────────────────

/**
 * Flag demo stills older than STILL_MAX_AGE_DAYS as regen_status='requested'
 * so app/api/cron/marketing-image-regen re-captures them one per tick — the
 * EXISTING drain, no new cron. Bounded; returns how many were flagged.
 */
export async function enqueueStaleScreenshotStills(svc: any, opts: { now?: Date; maxAgeDays?: number; limit?: number } = {}): Promise<{ flagged: number; error?: string }> {
  const now = opts.now ?? new Date()
  const cutoff = new Date(now.getTime() - (opts.maxAgeDays ?? STILL_MAX_AGE_DAYS) * 86_400_000).toISOString()
  const { data: stale, error } = await svc.from("marketing_assets").select("id")
    .eq("asset_type", "image").eq("visibility_scope", "platform")
    .eq("metadata->>asset_kind", SCREENSHOT_ASSET_KIND).eq("metadata->>screenshot_kind", "os_surface")
    .is("regen_status", null).lt("updated_at", cutoff)
    .order("updated_at", { ascending: true }).limit(opts.limit ?? 3)
  if (error) return { flagged: 0, error: error.message }
  const ids = ((stale ?? []) as Array<{ id: string }>).map((r) => r.id)
  if (!ids.length) return { flagged: 0 }
  const { data: flagged, error: flagErr } = await svc.from("marketing_assets")
    .update({ regen_status: "requested", updated_at: now.toISOString() }).in("id", ids).is("regen_status", null).select("id")
  if (flagErr) return { flagged: 0, error: flagErr.message }
  return { flagged: ((flagged ?? []) as unknown[]).length }
}

/**
 * SEED: capture the first registered surface that has no still yet — one per
 * call, so the regen loop fills the registry over its ticks without a human
 * pasting URLs. Returns which surface was captured, or null when the registry
 * is complete. Refusals are reported, never hidden (a missing demo tenant or
 * site origin refuses every tick until fixed, visibly in the cron's JSON).
 */
export async function seedMissingDemoStill(svc: any, deps: CaptureDeps = {}): Promise<{ surfaceId: string | null; result: CaptureResult | ScreenshotRefusal | null }> {
  const have = await listDemoStills(svc)
  const missing = DEMO_STILL_SURFACES.find((s) => !have.has(s.id))
  if (!missing) return { surfaceId: null, result: null }
  const result = await captureScreenshot({ kind: "os_surface", surfaceId: missing.id, brokerageId: "platform" }, { ...deps, svc })
  return { surfaceId: missing.id, result }
}

/**
 * Re-capture a screenshot row IN PLACE (same id, new asset_url) from its own
 * metadata — what the regen cron calls when the claimed row is a screenshot.
 * public_page rows re-run the ToS gate; os_surface rows re-mint the demo
 * session. A refusal leaves the old still and reports the reason.
 */
export async function recaptureScreenshotAsset(svc: any, row: ScreenshotAssetRow & { brokerage_id?: string | null; created_by?: string | null; tags?: string[] | null }, deps: CaptureDeps = {}): Promise<{ ok: true; url: string } | ScreenshotRefusal> {
  const meta = row.metadata ?? {}
  const kind = meta.screenshot_kind
  if (kind !== "os_surface" && kind !== "public_page") return { ok: false, reason: `row ${row.id} has no screenshot_kind in metadata` }
  // A tenant-owned still (wave 80D) re-captures INTO the same tenant: the
  // owner rides from the row itself, so the fresh cache row is that tenant's
  // and its uses/provenance survive the refresh.
  const owner: ScreenshotOwner | undefined = kind === "public_page" && row.brokerage_id
    ? { brokerageId: row.brokerage_id, createdBy: row.created_by ?? null, uses: usesOfRow(row), provenance: Object.fromEntries(Object.entries(meta).filter(([k]) => ["estimate_source", "address", "listing_id"].includes(k))) }
    : undefined
  const req: ScreenshotRequest = kind === "os_surface"
    ? { kind, surfaceId: typeof meta.surface_id === "string" ? meta.surface_id : undefined, route: typeof meta.route === "string" ? meta.route : undefined, brokerageId: "platform", label: row.asset_name ?? undefined }
    : { kind, url: typeof meta.source_url === "string" ? meta.source_url : undefined, label: row.asset_name ?? undefined, owner }
  const { siteUrl } = await import("@/lib/platform/site-url")
  const plan = planScreenshotCapture(req, { siteOrigin: siteUrl(), now: deps.now })
  if (!plan.ok) return plan
  // Capture as a fresh still (its own cache key for today), then point THIS row at it.
  const fresh = await captureScreenshot({ ...req, dayIso: plan.dayIso }, { ...deps, svc })
  if (!fresh.ok) return fresh
  const { error } = await svc.from("marketing_assets").update({
    asset_url: fresh.url, thumbnail_url: fresh.url, regen_status: null, updated_at: new Date().toISOString(),
    metadata: { ...meta, captured_at: fresh.capturedAt, cache_key: plan.cacheKey, day: plan.dayIso, regen_count: (typeof meta.regen_count === "number" ? meta.regen_count : 0) + 1, last_regen_at: fresh.capturedAt },
  }).eq("id", row.id)
  if (error) return { ok: false, reason: `screenshot row ${row.id} update refused: ${error.message}` }
  // The fresh capture wrote its own row too (cache); keep ONE row per surface.
  if (!fresh.cached && fresh.assetId !== row.id) {
    const { error: dupErr } = await svc.from("marketing_assets").delete().eq("id", fresh.assetId).eq("metadata->>asset_kind", SCREENSHOT_ASSET_KIND)
    if (dupErr) console.warn(`[screenshot-capture] duplicate still ${fresh.assetId} not removed: ${dupErr.message}`)
  }
  return { ok: true, url: fresh.url }
}

// ── Planner mounts (read-only lookups; capture is the loop's job) ────────────

/** The newest still per surface id (os_surface rows only). */
export async function listDemoStills(svc: any): Promise<Map<string, ScreenshotAssetRow>> {
  const { data, error } = await svc.from("marketing_assets")
    .select("id, asset_name, asset_url, thumbnail_url, approval_status, updated_at, metadata")
    .eq("asset_type", "image").eq("visibility_scope", "platform")
    .eq("metadata->>asset_kind", SCREENSHOT_ASSET_KIND).eq("metadata->>screenshot_kind", "os_surface")
    .order("updated_at", { ascending: false }).limit(200)
  if (error) { console.error("[screenshot-capture] demo stills read refused:", error.message); return new Map() }
  const out = new Map<string, ScreenshotAssetRow>()
  for (const r of (data ?? []) as ScreenshotAssetRow[]) {
    const id = typeof r.metadata?.surface_id === "string" ? r.metadata.surface_id : null
    if (id && !out.has(id)) out.set(id, r)
  }
  return out
}

/** PURE: the still URLs for a product-demo topic, registry order. */
export function stillUrlsForDemoTopic(topic: ProductDemoTopic, stills: ReadonlyMap<string, ScreenshotAssetRow>): string[] {
  return DEMO_STILL_SURFACES.filter((s) => s.demoTopics.includes(topic)).map((s) => stills.get(s.id)?.asset_url).filter((u): u is string => !!u)
}

/** PURE: the imageUrls for a product-video angle — the surfaces tagged for it,
 *  else every surface with a still (the Ken Burns slideshow cycles). */
export function stillUrlsForVideoAngle(angle: string, stills: ReadonlyMap<string, ScreenshotAssetRow>): string[] {
  const tagged = DEMO_STILL_SURFACES.filter((s) => s.videoAngles.includes(angle))
  const pool = tagged.length ? tagged : DEMO_STILL_SURFACES
  return pool.map((s) => stills.get(s.id)?.asset_url).filter((u): u is string => !!u)
}

/** DB: imageUrls for composeProductVideoSpec — empty when no still exists yet
 *  (the composition keeps its text-motion fallback; never a fabricated URL). */
export async function demoStillImageUrls(svc: any, angle: string): Promise<string[]> {
  return stillUrlsForVideoAngle(angle, await listDemoStills(svc))
}

/** DB: the one still to show for a product-demo topic, or null. */
export async function demoStillForTopic(svc: any, topic: ProductDemoTopic): Promise<string | null> {
  return stillUrlsForDemoTopic(topic, await listDemoStills(svc))[0] ?? null
}

// ── Multi-use selection (the asset-library category the consumers query) ───

export interface ScreenshotStillPick {
  id: string
  url: string
  label: string
  kind: ScreenshotKind
  uses: ScreenshotUse[]
  approvalStatus: string | null
  sourceUrl: string | null
  capturedAt: string | null
  /** Tenant estimate stills (wave 80D): the picked source key + the address
   *  the tenant typed; null on platform stills. */
  estimateSource?: string | null
  address?: string | null
  /** ALWAYS false: a still is material for a campaign, a video, a demo or a
   *  lesson — never an AI-agent statement of a home's value to a customer. */
  customerFacingValue: false
}

/**
 * DB: the stills a consumer may select for a USE — the one query behind the
 * campaign picker, the product-video `screenshot` treatment
 * (screenshotUrlsForUse → input_props.screenshotUrls), the demo token and the
 * training figures. os_surface rows are approved platform renders;
 * public_page rows (Zestimate & co.) are `pending` by design and come back
 * ONLY when the caller says `includePublicPage` — a platform-marketing caller
 * building a campaign or a product video, never a tenant picker. Rows
 * captured before uses existed carry no use tag and count for every use.
 */
export async function listScreenshotStillsForUse(
  svc: any, use: ScreenshotUse,
  opts: {
    includePublicPage?: boolean; kind?: ScreenshotKind; limit?: number
    /** TENANT SCOPE (wave 80D): list THAT brokerage's own stills instead of the
     *  platform library. The id comes from the session gate, never a body.
     *  Tenant stills are public_page captures by construction, so
     *  includePublicPage is implied; `approvedOnly` narrows to the rows a
     *  human has approved on the tenant's rail — the campaign consumer's view. */
    brokerageId?: string
    approvedOnly?: boolean
  } = {},
): Promise<ScreenshotStillPick[]> {
  if (!(SCREENSHOT_USES as readonly string[]).includes(use)) return []
  let q = svc.from("marketing_assets")
    .select("id, asset_name, asset_url, approval_status, tags, updated_at, metadata")
    .eq("asset_type", "image")
    .eq("metadata->>asset_kind", SCREENSHOT_ASSET_KIND)
  q = opts.brokerageId ? q.eq("visibility_scope", "brokerage").eq("brokerage_id", opts.brokerageId) : q.eq("visibility_scope", "platform")
  if (opts.kind) q = q.eq("metadata->>screenshot_kind", opts.kind)
  if (opts.approvedOnly) q = q.eq("approval_status", "approved")
  const { data, error } = await q.order("updated_at", { ascending: false }).limit(opts.limit ?? 100)
  if (error) { console.error("[screenshot-capture] stills-for-use read refused:", error.message); return [] }
  const out: ScreenshotStillPick[] = []
  for (const r of (data ?? []) as Array<ScreenshotAssetRow & { tags?: string[] | null }>) {
    const meta = r.metadata ?? {}
    const kind = meta.screenshot_kind === "public_page" ? "public_page" : "os_surface"
    if (kind === "public_page" && !opts.includePublicPage && !opts.brokerageId) continue
    const uses = usesOfRow(r)
    if (!uses.includes(use)) continue
    out.push({
      id: r.id, url: r.asset_url, label: r.asset_name ?? "", kind, uses,
      approvalStatus: r.approval_status ?? null,
      sourceUrl: typeof meta.source_url === "string" ? meta.source_url : null,
      capturedAt: typeof meta.captured_at === "string" ? meta.captured_at : null,
      estimateSource: typeof meta.estimate_source === "string" ? meta.estimate_source : null,
      address: typeof meta.address === "string" ? meta.address : null,
      customerFacingValue: false,
    })
  }
  return out
}

/** DB: just the URLs for a use — what a video producer stages as
 *  input_props.screenshotUrls for the `screenshot` body treatment. */
export async function screenshotUrlsForUse(svc: any, use: ScreenshotUse, opts: { includePublicPage?: boolean; limit?: number } = {}): Promise<string[]> {
  return (await listScreenshotStillsForUse(svc, use, opts)).map((p) => p.url)
}

/**
 * DB: narrow or widen a still's uses. Writes the tag set AND metadata.uses
 * (one fact, two readers: the array filter and the row's own record), only on
 * a screenshot row. `.select()`ed and COUNTED (CLAUDE.md §3): an unmatched id
 * — not a screenshot, already gone — is a refusal, never a silent success.
 */
export async function setScreenshotUses(
  svc: any, assetId: string, uses: readonly ScreenshotUse[],
  /** TENANT SCOPE (wave 80D): both the read and the counted update carry the
   *  session tenant's predicate, so another tenant's still matches 0 rows and
   *  refuses (§3) instead of being re-tagged. Omitted = platform library. */
  scope: { brokerageId?: string } = {},
): Promise<{ ok: true; uses: ScreenshotUse[] } | ScreenshotRefusal> {
  const valid = SCREENSHOT_USES.filter((u) => uses.includes(u))
  let readQ = svc.from("marketing_assets").select("id, tags, metadata")
    .eq("id", assetId).eq("metadata->>asset_kind", SCREENSHOT_ASSET_KIND)
  readQ = scope.brokerageId ? readQ.eq("brokerage_id", scope.brokerageId) : readQ.eq("visibility_scope", "platform")
  const { data: rows, error: readErr } = await readQ.limit(1)
  if (readErr) return { ok: false, reason: `screenshot row ${assetId} read refused: ${readErr.message}` }
  const row = ((rows ?? []) as Array<{ id: string; tags: string[] | null; metadata: Record<string, unknown> | null }>)[0]
  if (!row) return { ok: false, reason: `screenshot row ${assetId} not found (or not a screenshot${scope.brokerageId ? " of this brokerage" : ""})` }
  let updQ = svc.from("marketing_assets").update({
    tags: tagsWithUses(row.tags, valid),
    metadata: { ...(row.metadata ?? {}), uses: valid },
    updated_at: new Date().toISOString(),
  }).eq("id", assetId).eq("metadata->>asset_kind", SCREENSHOT_ASSET_KIND)
  updQ = scope.brokerageId ? updQ.eq("brokerage_id", scope.brokerageId) : updQ.eq("visibility_scope", "platform")
  const { data: updated, error } = await updQ.select("id")
  if (error) return { ok: false, reason: `screenshot row ${assetId} update refused: ${error.message}` }
  if (((updated ?? []) as unknown[]).length !== 1) return { ok: false, reason: `screenshot row ${assetId}: update matched ${((updated ?? []) as unknown[]).length} rows, expected 1` }
  return { ok: true, uses: valid }
}

/** PURE: stills as the composition-facing B-roll clip shape (image URLs are
 *  legal BrollClips — remotion/_BrollLayer detects by extension). */
export function stillsAsBrollClips(urls: string[], captions?: string[]): PickedBrollClip[] {
  return urls.map((url, i) => ({ url, ...(captions?.[i] ? { caption: captions[i] } : {}) }))
}

export interface LessonFigure { url: string; caption: string; source: string; capturedAt: string | null }

/** PURE: the figures an onboarding topic gets — registry order, stills only. */
export function figuresForEducationTopic(topicKey: string, stills: ReadonlyMap<string, ScreenshotAssetRow>): LessonFigure[] {
  return DEMO_STILL_SURFACES.filter((s) => s.educationTopics.includes(topicKey)).flatMap((s) => {
    const r = stills.get(s.id)
    return r ? [{ url: r.asset_url, caption: s.label, source: `demo tenant ${s.route}`, capturedAt: typeof r.metadata?.captured_at === "string" ? r.metadata.captured_at : null }] : []
  })
}

/** PURE: the markdown figure block appended to a module body (empty → ""). */
export function renderFigures(figures: LessonFigure[]): string {
  if (!figures.length) return ""
  return ["## In the OS", ...figures.map((f) => `![${f.caption}](${f.url})\n_${f.caption} — ${f.source}${f.capturedAt ? `, captured ${f.capturedAt.slice(0, 10)}` : ""}_`)].join("\n\n")
}
