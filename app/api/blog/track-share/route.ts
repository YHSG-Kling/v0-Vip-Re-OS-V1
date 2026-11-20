/**
 * app/api/blog/track-share/route.ts
 *
 * Wave 29 — fires when a recipient clicks a "Share to X" button on the
 * blog post. This is the ONLINE VISIBILITY signal (vs. SEO keyword
 * count): the article was COMPELLING enough to share. The aggregator
 * weights share clicks higher than passive views.
 *
 * POST body:
 *   { blog_post_id, share_channel, persona_snapshot? }   (a contact_id in the body is ignored — wave 155, lane 155K2)
 *
 * Valid share_channel: 'facebook' | 'twitter' | 'linkedin' | 'whatsapp'
 *   | 'email_share' | 'copy_link'
 */
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { decidePublicDoor, callerIpFrom } from "@/lib/security/public-rate-limit"

export const dynamic = "force-dynamic"

const VALID_CHANNELS = new Set([
  "facebook", "twitter", "linkedin", "whatsapp", "email_share", "copy_link",
])

export async function POST(req: NextRequest) {
  let body: { blog_post_id?: string; share_channel?: string; persona_snapshot?: string | null }
  try { body = await req.json() } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }) }
  if (!body.blog_post_id) return NextResponse.json({ error: "blog_post_id required" }, { status: 400 })
  if (!body.share_channel || !VALID_CHANNELS.has(body.share_channel)) {
    return NextResponse.json({ error: "invalid share_channel" }, { status: 400 })
  }

  const svc = createServiceClient()
  // WAVE 155 (lane 155R18 — G10): the DECISION before any write — the per-IP cap, then the TENANT'S OWN OPT-IN: a post its
  // tenant PUBLISHED (the predicate the public site serves, app/site/[slug]/page.tsx). A draft, rejected or archived post takes
  // no share; the brokerage is that row's, never the body's.
  const postId = body.blog_post_id
  const seen: { p: { id: string; brokerage_id: string } | null } = { p: null }
  const door = await decidePublicDoor({
    surface: "blog-track-share", callerKey: callerIpFrom(req.headers), cap: { limit: 60, windowMs: 60_000 },
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

  await sentinelWrite(svc, svc.from("blog_post_share_clicks").insert({
    blog_post_id:            p.id,
    brokerage_id:            p.brokerage_id,
    // Never a body-supplied id (wave 155). It was stored unverified; lane 155R5 then verified it against the post's tenant,
    // and lane 155K2 removed it altogether — a same-tenant id can be guessed, and this row feeds a movement signal about
    // that person. No writer builds a share link that carries a contact, so the share is anonymous until a sealed
    // recipient grant exists.
    viewer_contact_id:       null,
    viewer_persona_snapshot: body.persona_snapshot ?? null,
    share_channel:           body.share_channel,
  }), { table: "blog_post_share_clicks", flow: "blog_post_share_clicks_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
  try { await svc.rpc("increment_blog_share_count", { p_blog_post_id: p.id }) }
  catch { /* best-effort denormalized counter */ }
  return NextResponse.json({ ok: true })
}
