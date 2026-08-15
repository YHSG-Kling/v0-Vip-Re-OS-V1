/**
 * app/api/blog/track-share/route.ts
 *
 * Wave 29 — fires when a recipient clicks a "Share to X" button on the
 * blog post. This is the ONLINE VISIBILITY signal (vs. SEO keyword
 * count): the article was COMPELLING enough to share. The aggregator
 * weights share clicks higher than passive views.
 *
 * POST body:
 *   { blog_post_id, share_channel, contact_id?, persona_snapshot? }
 *
 * Valid share_channel: 'facebook' | 'twitter' | 'linkedin' | 'whatsapp'
 *   | 'email_share' | 'copy_link'
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"

const VALID_CHANNELS = new Set([
  "facebook", "twitter", "linkedin", "whatsapp", "email_share", "copy_link",
])

export async function POST(req: NextRequest) {
  let body: { blog_post_id?: string; share_channel?: string; contact_id?: string | null; persona_snapshot?: string | null }
  try { body = await req.json() } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }) }
  if (!body.blog_post_id) return NextResponse.json({ error: "blog_post_id required" }, { status: 400 })
  if (!body.share_channel || !VALID_CHANNELS.has(body.share_channel)) {
    return NextResponse.json({ error: "invalid share_channel" }, { status: 400 })
  }

  const svc = createServiceClient()
  const { data: post } = await svc.from("blog_posts")
    .select("id, brokerage_id")
    .eq("id", body.blog_post_id)
    .maybeSingle()
  const p = post as { id: string; brokerage_id: string | null } | null
  if (!p || !p.brokerage_id) return NextResponse.json({ error: "blog post not found" }, { status: 404 })

  await svc.from("blog_post_share_clicks").insert({
    blog_post_id:            p.id,
    brokerage_id:            p.brokerage_id,
    viewer_contact_id:       body.contact_id ?? null,
    viewer_persona_snapshot: body.persona_snapshot ?? null,
    share_channel:           body.share_channel,
  })
  try { await svc.rpc("increment_blog_share_count", { p_blog_post_id: p.id }) }
  catch { /* best-effort denormalized counter */ }
  return NextResponse.json({ ok: true })
}
