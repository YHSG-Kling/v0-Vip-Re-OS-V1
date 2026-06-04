/**
 * app/api/blog/track-view/route.ts
 *
 * Wave 29 — public-facing tracking endpoint for blog page views. Called
 * by a small inline script on the rendered blog page (or by a WordPress
 * webhook when WP is the host). Writes one row per view into
 * blog_post_views; the daily aggregator joins this to contacts for
 * per-(blog_post, persona) engagement attribution.
 *
 * No auth — the endpoint is public BY DESIGN (anonymous viewers must be
 * able to track). Abuse prevention is via:
 *   · IP hashing (we never store raw IP)
 *   · brokerage scope check via blog_post_id (only valid post IDs can
 *     receive views)
 *   · rate limit at the edge (CDN) — not enforced here
 *
 * POST body:
 *   { blog_post_id, source?, referrer?, contact_id?, persona_snapshot? }
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { createHash } from "node:crypto"

export const dynamic = "force-dynamic"

interface ReqBody {
  blog_post_id:        string
  source?:             string
  referrer?:           string
  contact_id?:         string | null
  persona_snapshot?:   string | null
}

export async function POST(req: NextRequest) {
  let body: ReqBody
  try {
    body = await req.json() as ReqBody
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 })
  }
  if (!body.blog_post_id || typeof body.blog_post_id !== "string") {
    return NextResponse.json({ error: "blog_post_id required" }, { status: 400 })
  }

  const svc = createServiceClient()

  // Resolve brokerage_id from the blog post — also serves as existence check.
  const { data: post } = await svc.from("blog_posts")
    .select("id, brokerage_id")
    .eq("id", body.blog_post_id)
    .maybeSingle()
  const p = post as { id: string; brokerage_id: string | null } | null
  if (!p || !p.brokerage_id) {
    return NextResponse.json({ error: "blog post not found" }, { status: 404 })
  }

  // IP hashing — we never store the raw IP. Salt is fixed per-brokerage
  // so the same household scanning multiple pages within a brokerage
  // dedupes; switching brokerages produces a different hash. The salt
  // value is the brokerage_id itself — sufficient one-way protection for
  // Fair Housing posture, no per-brokerage rotation key required.
  const rawIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? req.headers.get("x-real-ip")
    ?? "unknown"
  const ipHash = createHash("sha256")
    .update(`${rawIp}|${p.brokerage_id}`)
    .digest("hex")
    .slice(0, 32)

  await svc.from("blog_post_views").insert({
    blog_post_id:            p.id,
    brokerage_id:            p.brokerage_id,
    viewer_contact_id:       body.contact_id ?? null,
    viewer_persona_snapshot: body.persona_snapshot ?? null,
    source:                  body.source ?? "direct",
    referrer:                body.referrer ?? null,
    viewer_ip_hash:          ipHash,
  })

  return NextResponse.json({ ok: true })
}
