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
 *   · a per-IP cap and a PUBLISHED post, decided before any write (decidePublicDoor — wave 155, lane 155R18)
 *
 * POST body:
 *   { blog_post_id, source?, referrer?, persona_snapshot? }   (a contact_id in the body is ignored — wave 155, lane 155K2)
 */
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { decidePublicDoor, callerIpFrom } from "@/lib/security/public-rate-limit"
import { createHash } from "node:crypto"

export const dynamic = "force-dynamic"

interface ReqBody {
  blog_post_id:        string
  source?:             string
  referrer?:           string
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

  // WAVE 155 (lane 155R18 — G10): the DECISION before any write — the per-IP cap (the "rate limit at the edge" this header
  // used to promise was never enforced here), then the TENANT'S OWN OPT-IN: a post its tenant PUBLISHED. A draft takes no
  // view; the brokerage is that row's, never the body's.
  const postId = body.blog_post_id
  const seen: { p: { id: string; brokerage_id: string } | null } = { p: null }
  const door = await decidePublicDoor({
    surface: "blog-track-view", callerKey: callerIpFrom(req.headers), cap: { limit: 120, windowMs: 60_000 },
    optIn: async () => {
      const { data: post, error } = await svc.from("blog_posts").select("id, brokerage_id, publish_status").eq("id", postId).maybeSingle()
      const row = post as { id: string; brokerage_id: string | null; publish_status: string | null } | null
      if (error || !row?.brokerage_id || row.publish_status !== "published") return null
      seen.p = { id: row.id, brokerage_id: row.brokerage_id }
      return { brokerageId: row.brokerage_id, basis: "blog_posts.publish_status = published" }
    },
  })
  if (!door.allowed || !seen.p) {
    return NextResponse.json({ error: !door.allowed && door.reason === "rate_limited" ? "too many requests" : "blog post not found" }, { status: door.allowed ? 404 : door.status })
  }
  const p = seen.p

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

  // Wave 155 (lane 155K2; directive 471 — no raw ids in analytics or outbound links): a body-supplied contact id is a CLAIM from
  // an unauthenticated POST, and this column feeds a movement signal about that person (lib/intent/movement-source-watcher.ts).
  // No writer ever built the ?c= link it came from, so the claim is never stored: every view is recorded anonymously. The
  // wave-149Z tenant check that used to admit a same-tenant id is retired with it — a guessed id was still a forged signal.

  await sentinelWrite(svc, svc.from("blog_post_views").insert({
    blog_post_id:            p.id,
    brokerage_id:            p.brokerage_id,
    viewer_contact_id:       null,
    viewer_persona_snapshot: body.persona_snapshot ?? null,
    source:                  body.source ?? "direct",
    referrer:                body.referrer ?? null,
    viewer_ip_hash:          ipHash,
  }), { table: "blog_post_views", flow: "blog_post_views_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })

  // Wave 31 — denormalized counter increment so the public landing page
  // can show "1.2k readers" without a live count() join. Best-effort; the
  // view row above is the source of truth and the aggregator's per-persona
  // scoring reads from there.
  try { await svc.rpc("increment_blog_view_count", { p_blog_post_id: p.id }) }
  catch { /* RPC may not exist on older envs — best-effort denormalized counter */ }

  return NextResponse.json({ ok: true })
}
