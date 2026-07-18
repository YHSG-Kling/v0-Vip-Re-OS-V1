/**
 * proxy.ts (root) — Next.js 16 unified edge middleware.
 *
 * Next 16 only allows one of middleware.ts / proxy.{js,ts}; we consolidated
 * both prior surfaces into this single file:
 *
 *   1. Wave 34 — Content-Security-Policy frame-ancestors enforcement on
 *      /embed/blog/[slug]. The embed route is designed to be iframed by
 *      the brokerage / agent on their own external site; CSP locks the
 *      allowed parent origins to (a) the platform, (b) the post's
 *      brokerage.website, (c) the post's agent.personal_website_url.
 *      Without an allowlist we fall back to frame-ancestors *  +  console
 *      warn — a hard restriction would break new brokerages on their
 *      first publish.
 *
 *   2. Auth gate — protected routes redirect to /login when the Supabase
 *      session is missing or expired.
 *
 *   3. White-label custom domains (round 24) — brokerage-tier tenants point
 *      www.theirbrokerage.com at their /site/[slug] storefront. When the
 *      request host is NOT one of the platform's own hosts (env-derived) we
 *      look up tenant_custom_domains (status='active', 60s in-memory TTL
 *      cache per edge isolate) and rewrite "/" (and bare /site) to
 *      /site/[slug]. App/auth surfaces on a vanity host bounce to the
 *      canonical origin; a vanity host can never serve ANOTHER tenant's
 *      /site. SAFETY RULE: every custom-domain branch only RETURNS when it
 *      acts — unknown hosts and unmatched paths fall through to the
 *      pre-existing pipeline completely unchanged, and an unknown host is
 *      never rewritten onto any tenant's site.
 *
 * Routing rules below are evaluated in order so the embed CSP path always
 * runs before the auth gate (the embed surface is public; auth checks
 * would redirect it away from its iframe parent).
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { createServiceClient } from "@/lib/supabase/service"
import { PROTECTED_ROUTES, PUBLIC_ROUTES } from "@/app/constants/auth"
import { siteUrl } from "@/lib/platform/site-url"

export default async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname

  // ── 0) White-label custom domains ──────────────────────────────────────
  // Only engages when the host is NOT platform-owned; static/asset paths are
  // skipped so the edge lookup never runs for them. Branches RETURN only when
  // they act — everything else falls through to the existing pipeline.
  const host = (request.headers.get("host") ?? "").toLowerCase().split(":")[0]
  if (
    host &&
    !isPlatformHost(host) &&
    !pathname.startsWith("/_next") &&
    !pathname.startsWith("/static") &&
    !pathname.includes(".")
  ) {
    const slug = await customDomainSiteSlug(host)
    if (slug) {
      // Dashboard/auth/app surfaces never render on a tenant vanity host —
      // redirect to the canonical app origin (same path + query).
      if (isAppOnlyPath(pathname)) {
        const canonical = siteUrl()
        if (canonical) {
          return NextResponse.redirect(new URL(`${pathname}${request.nextUrl.search}`, canonical))
        }
        // No canonical origin known (bare dev) — fall through; the auth gate
        // below still protects every protected route.
      }
      if (pathname === "/" || pathname === "/site" || pathname === "/site/") {
        return NextResponse.rewrite(new URL(`/site/${slug}`, request.url))
      }
      if (pathname.startsWith("/site/")) {
        const requested = pathname.slice("/site/".length).split("/")[0]
        if (requested !== slug) {
          // NEVER serve another tenant's site under this vanity host.
          const canonical = siteUrl()
          if (canonical) return NextResponse.redirect(new URL(pathname, canonical))
          return NextResponse.rewrite(new URL(`/site/${slug}`, request.url))
        }
      }
      // All other public paths (/blog, /listing, /p, /recruiting, /embed…)
      // fall through path-preserving — they already exist on this app.
    }
    // Unknown host (no 'active' mapping): fall through UNCHANGED.
  }

  // ── 1) Embed-blog CSP path ─────────────────────────────────────────────
  // Per-slug allowlist resolved from blog_posts → brokerages.website +
  // users.personal_website_url. Public route; no auth check.
  if (pathname.startsWith("/embed/blog/")) {
    const slug = pathname.split("/").pop()
    const res = NextResponse.next()
    if (!slug) return res

    const origins = await resolveAllowedFrameOrigins(slug).catch(() => [])
    const platformOrigin = process.env.NEXT_PUBLIC_APP_URL ?? ""
    const allowed = [
      "'self'",
      ...(platformOrigin ? [originOf(platformOrigin)] : []),
      ...origins,
    ].filter((v, i, arr) => v && arr.indexOf(v) === i)

    const csp = allowed.length > 2
      ? `frame-ancestors ${allowed.join(" ")}`
      : `frame-ancestors *`
    res.headers.set("Content-Security-Policy", csp)
    // Older browsers without CSP3 use X-Frame-Options. SAMEORIGIN is the
    // safe default when we have no allowlist; we DROP it when we DO have
    // an allowlist because X-Frame-Options can't express multiple origins
    // and CSP3 frame-ancestors supersedes it on modern browsers.
    if (allowed.length <= 2) {
      res.headers.set("X-Frame-Options", "SAMEORIGIN")
    }
    return res
  }

  // ── 2) Public route pass-through ───────────────────────────────────────
  if (PUBLIC_ROUTES.some((route) => pathname.startsWith(route))) {
    return NextResponse.next()
  }

  // ── 3) Static files + Next internals ───────────────────────────────────
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/static") ||
    pathname.includes(".")
  ) {
    return NextResponse.next()
  }

  // ── 4) Auth gate on protected routes ───────────────────────────────────
  const isProtected = PROTECTED_ROUTES.some((route) => pathname.startsWith(route))
  if (!isProtected) return NextResponse.next()

  let response = NextResponse.next({ request: { headers: request.headers } })
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) {
    return NextResponse.redirect(new URL("/login", request.url))
  }
  return response
}

/** Resolve (brokerage.website + agent.personal_website_url) origins for a
 *  blog post by slug. Returns origin strings ("https://x.com") only. */
async function resolveAllowedFrameOrigins(slug: string): Promise<string[]> {
  const svc = createServiceClient()
  const { data: post } = await svc.from("blog_posts")
    .select("brokerage_id, agent_user_id")
    .eq("slug", slug)
    .maybeSingle()
  const p = post as { brokerage_id: string | null; agent_user_id: string | null } | null
  if (!p) return []

  const [brokerageR, userR] = await Promise.all([
    p.brokerage_id
      ? svc.from("brokerages").select("website").eq("id", p.brokerage_id).maybeSingle()
      : Promise.resolve({ data: null } as { data: null }),
    p.agent_user_id
      ? svc.from("users").select("personal_website_url").eq("id", p.agent_user_id).maybeSingle()
      : Promise.resolve({ data: null } as { data: null }),
  ])

  const out: string[] = []
  const broker = brokerageR.data as { website: string | null } | null
  const usr    = userR.data as { personal_website_url: string | null } | null
  if (broker?.website) {
    const o = originOf(broker.website)
    if (o) out.push(o)
  }
  if (usr?.personal_website_url) {
    const o = originOf(usr.personal_website_url)
    if (o) out.push(o)
  }
  return out
}

function originOf(url: string): string {
  try { return new URL(url).origin } catch { return "" }
}

// ── White-label custom-domain helpers ────────────────────────────────────────

/** Auth/marketing paths that must never render on a vanity host (protected
 *  routes are appended — they redirect too, and the auth gate still backstops). */
const APP_ONLY_PATH_PREFIXES = [
  "/login", "/signup", "/forgot-password", "/reset-password", "/auth",
  "/get-started", "/onboarding", "/pricing", "/api/auth",
]

function isAppOnlyPath(pathname: string): boolean {
  return (
    APP_ONLY_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    PROTECTED_ROUTES.some((p) => pathname.startsWith(p))
  )
}

/** The platform's own hosts — requests on these NEVER hit the custom-domain
 *  branch, so existing routing is untouched. Env-derived (the product domain
 *  is a setting, never hardcoded): NEXT_PUBLIC_APP_URL host (+ its www/apex
 *  twin — env drift between www and apex must not brick the app), Vercel
 *  deployment hosts, *.vercel.app previews, localhost. */
let platformHostsCache: Set<string> | null = null
function platformHosts(): Set<string> {
  if (platformHostsCache) return platformHostsCache
  const hosts = new Set<string>(["localhost", "127.0.0.1"])
  const candidates = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
    process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null,
  ]
  for (const c of candidates) {
    if (!c) continue
    try {
      const h = new URL(c).hostname.toLowerCase()
      hosts.add(h)
      hosts.add(h.startsWith("www.") ? h.slice(4) : `www.${h}`)
    } catch { /* unparseable env value — skip */ }
  }
  platformHostsCache = hosts
  return hosts
}

function isPlatformHost(host: string): boolean {
  if (platformHosts().has(host)) return true
  if (host.endsWith(".localhost")) return true
  if (host === "vercel.app" || host.endsWith(".vercel.app")) return true
  return false
}

/** host → brokerage site slug for ACTIVE custom domains, cached in-memory per
 *  edge isolate (60s TTL, negatives cached too; 5s on lookup failure so a
 *  transient DB error can't pin a bad answer). Middleware talks to Supabase
 *  the same way the embed-CSP path above does — createServiceClient. */
const DOMAIN_CACHE_TTL_MS = 60_000
const DOMAIN_CACHE_ERROR_TTL_MS = 5_000
const DOMAIN_CACHE_MAX = 500
const domainSlugCache = new Map<string, { slug: string | null; expires: number }>()

async function customDomainSiteSlug(host: string): Promise<string | null> {
  const now = Date.now()
  const hit = domainSlugCache.get(host)
  if (hit && hit.expires > now) return hit.slug

  let slug: string | null = null
  let ttl = DOMAIN_CACHE_TTL_MS
  try {
    const svc = createServiceClient()
    const { data } = await svc
      .from("tenant_custom_domains")
      .select("brokerage_id, brokerages(slug)")
      .eq("domain", host)
      .eq("status", "active")
      .maybeSingle()
    const joined = (data as { brokerages?: { slug?: string | null } | Array<{ slug?: string | null }> } | null)?.brokerages
    const raw = Array.isArray(joined) ? joined[0]?.slug : joined?.slug
    slug = raw && typeof raw === "string" ? raw : null
  } catch {
    // Missing env / transient DB failure — behave like an unknown host
    // (fall through unchanged) and retry soon.
    slug = null
    ttl = DOMAIN_CACHE_ERROR_TTL_MS
  }

  if (domainSlugCache.size >= DOMAIN_CACHE_MAX) domainSlugCache.clear()
  domainSlugCache.set(host, { slug, expires: now + ttl })
  return slug
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static files. Internal static + image
     * paths and common asset extensions are excluded so the edge function
     * doesn't run for every favicon / image request.
     */
    "/((?!_next/static|_next/image|favicon.ico|icon.*\\.png|icon\\.svg|apple-icon\\.png|.*\\.(?:jpg|jpeg|gif|png|svg|ico|webp)).*)",
  ],
}
