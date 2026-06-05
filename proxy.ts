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
 * Routing rules below are evaluated in order so the embed CSP path always
 * runs before the auth gate (the embed surface is public; auth checks
 * would redirect it away from its iframe parent).
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { createServiceClient } from "@/lib/supabase/service"
import { PROTECTED_ROUTES, PUBLIC_ROUTES } from "@/app/constants/auth"

export default async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname

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
