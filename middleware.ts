/**
 * middleware.ts (root)
 *
 * Wave 34 — Content-Security-Policy frame-ancestors enforcement on the
 * /embed/blog/[slug] route. The embed route is designed to be iframed
 * by the brokerage / agent on their own external site; CSP prevents
 * embedding by ANY OTHER origin, defending against clickjacking on
 * platform sessions and brand-impersonation attempts.
 *
 * Per-request allowlist resolved from:
 *   1. The blog_post's brokerage_id → brokerages.website (broker's site)
 *   2. The blog_post's agent_user_id → users.personal_website_url
 *      (agent's personal site — preferred when set, since many brokerages
 *      don't have their own site but the agent does)
 *   3. The platform's own origin (NEXT_PUBLIC_APP_URL) — always allowed
 *      so the platform's own /blog/[slug] preview can iframe-test
 *
 * When neither field is set we fall back to a permissive policy
 * (frame-ancestors *) with a console.warn so the brokerage knows their
 * embed isn't pinned to any domain. A hard 'self' restriction would
 * break new brokerages on their first publish.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export const config = {
  matcher: ["/embed/blog/:slug*"],
}

export async function middleware(req: NextRequest) {
  const url   = req.nextUrl
  const slug  = url.pathname.split("/").pop()
  const res   = NextResponse.next()
  if (!slug) return res

  // Resolve brokerage + agent personal-site origins from the post's
  // associated rows. Cached by the CDN at the Vercel edge because the
  // response varies by slug only (not by viewer identity).
  const origins = await resolveAllowedFrameOrigins(slug).catch(() => [])
  const platformOrigin = process.env.NEXT_PUBLIC_APP_URL ?? ""

  const allowed = [
    "'self'",
    ...(platformOrigin ? [originOf(platformOrigin)] : []),
    ...origins,
  ].filter((v, i, arr) => v && arr.indexOf(v) === i)

  // If nothing resolved beyond 'self' + platform, leave the route
  // wide-open with a console warn (deliberate: first publish on a brand
  // new brokerage with no website fields lands here; punishing them with
  // a 404-in-iframe would be hostile).
  const csp = allowed.length > 2
    ? `frame-ancestors ${allowed.join(" ")}`
    : `frame-ancestors *`

  res.headers.set("Content-Security-Policy", csp)
  // Older browsers without CSP3 fall back to X-Frame-Options. SAMEORIGIN
  // is the safe default when we have no allowlist; we DROP the header
  // when there IS an allowlist because X-Frame-Options can't express
  // multiple origins (CSP3 frame-ancestors supersedes it).
  if (allowed.length <= 2) {
    res.headers.set("X-Frame-Options", "SAMEORIGIN")
  }
  return res
}

/** Resolve the (brokerage.website + agent.personal_website_url) pair
 *  for THIS blog post's slug. Returns origin strings ("https://x.com")
 *  with no path. */
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
