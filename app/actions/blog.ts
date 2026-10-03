"use server"

// app/actions/blog.ts
// Layer 9.6 — SEO & Blog Engine Actions
// Kernel gates: canAccessFeature('seo_blog_engine'), checkBrandCompliance; the AI writer (applyBrandVoice, evaluateOutbound,
// postcheckScript) is lib/kernel/content-creators.ts writeBlogPost, reached through generateBlogPost.

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { canAccessFeature } from "@/lib/kernel/0.1-feature-access"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { checkBrandCompliance } from "@/lib/kernel/brand-compliance"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { resolveWordPressCredential, wordPressUnavailableReason } from "@/lib/blog/wordpress-connection"
import { requireCallerTenant } from "@/lib/auth/require-caller"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface GenerateBlogPostParams {
  brokerageId: string
  agentUserId?: string
  title?: string
  keywords: string[]
  campaignId?: string
  tone?: string
  /** Source material to repurpose (e.g. a video transcript) — the article is
   * written FROM this when provided, instead of from keywords alone. */
  sourceContent?: string
  /** When true, generate a branded cover image and set featured_image_url. */
  generateCoverImage?: boolean
  /** Wave 29 — when set, the generator picks topics from content_topic_bank
   *  for this persona (per-persona perf score weighted via m136). The blog
   *  author then writes from those topics' value_angle rather than from
   *  keyword input alone. Same Wave 20.1 cohesion pattern newsletter has. */
  recipientPersona?: string
  /** Wave 29 — when true (cadence-cron path), the generator pulls topics
   *  from the topic bank automatically. When false (manual path), it
   *  honors the keywords array as-is. */
  pullFromTopicBank?: boolean
}

export interface UpdateBlogPostParams {
  title?: string
  slug?: string
  content?: string
  excerpt?: string
  featuredImageUrl?: string
  publishStatus?: "draft" | "pending_review" | "approved" | "published" | "rejected"
  category?: string
  callToAction?: string
}

// ─── generateBlogPost ─────────────────────────────────────────────────────────
//
// THE SESSION DOOR onto the one AI blog writer, lib/kernel/content-creators.ts writeBlogPost
// (lane 86C). The body moved there: this export is a public HTTP endpoint (§4), and it took
// BOTH `userId` and `params.brokerageId` from the browser, wrote through the cookie client, and
// filed `params.campaignId` unverified. Now the tenant and the actor come from the SESSION
// (resolveBlogActor below): a claimed userId that is not the session's is refused, and a body
// brokerageId naming another tenant is refused, never quietly corrected. The kernel verifies
// every caller-named id (agent seat, campaign) in the session's tenant.
//
// TOMBSTONE (§1.1): lib/kernel/marketing.ts createBlogPost — the unwired duplicate AI blog
// writer — was merged onto this survivor and deleted (its campaign verification and its
// gate-then-service-client insert now live in writeBlogPost).

export async function generateBlogPost(
  userId: string,
  params: GenerateBlogPostParams
): Promise<{ success: boolean; postId?: string; error?: string; keywordWarnings?: string[]; complianceWarnings?: string[] }> {
  const actor = await resolveBlogActor(userId)
  if (!actor.ok) return { success: false, error: actor.error }
  if (!decideClaimedTenant({ actingBrokerageId: actor.brokerageId, claimedBrokerageId: params.brokerageId }).ok) { // The claimed-tenant rule is the ONE decision table (lane 93A, §6) — not a hand-rolled copy.
    return { success: false, error: "That brokerage is not yours — a blog post is written for your own brokerage only." }
  }

  const { writeBlogPost } = await import("@/lib/kernel/content-creators")
  const result = await writeBlogPost({
    ctx: { userId: actor.userId, brokerageId: actor.brokerageId },
    agentUserId: params.agentUserId,
    title: params.title,
    keywords: params.keywords ?? [],
    campaignId: params.campaignId,
    tone: params.tone,
    sourceContent: params.sourceContent,
    generateCoverImage: params.generateCoverImage,
    recipientPersona: params.recipientPersona,
    pullFromTopicBank: params.pullFromTopicBank,
  })
  if (!result.success) return { success: false, error: result.error, complianceWarnings: result.complianceWarnings }
  return {
    success: true,
    postId: result.postId,
    ...(result.keywordWarnings ? { keywordWarnings: result.keywordWarnings } : {}),
    complianceWarnings: result.complianceWarnings,
  }
}

// ─── THE BLOG ACTOR GATE ──────────────────────────────────────────────────────
//
// `userId` arrives from the BROWSER on three exported server actions in this file
// (updateBlogPost, publishBlogPost, publishToWordPress). Every export of a
// "use server" file is a public HTTP endpoint (CLAUDE.md §4), and on two of the
// three that parameter was accepted and READ BY NOTHING — so the actions ran no
// authorization at all: any authenticated session could name any blog post id, in
// any brokerage, and edit or publish it.
//
// The fix is the rule, not the parameter: THE TENANT COMES FROM THE SESSION. The
// client-supplied id is now read only as an ASSERTION — if the browser claims to be
// someone the session is not, that is a refusal, not a fallback — and the session's
// brokerage becomes the predicate on every subsequent read and write.
//
// This is a NON-EXPORTED helper on purpose: exporting it would publish the gate
// itself as an endpoint.
async function resolveBlogActor(
  claimedUserId: string,
): Promise<{ ok: true; userId: string; brokerageId: string } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) {
    return { ok: false, error: "Not authenticated" }
  }
  // FAIL CLOSED (§4): a mismatch is refused rather than quietly preferring the
  // session, so a caller passing someone else's id is TOLD, not silently corrected.
  if (claimedUserId && claimedUserId !== ctx.userId) {
    return { ok: false, error: "Identity mismatch — you may only act as yourself" }
  }
  return { ok: true, userId: ctx.userId, brokerageId: ctx.brokerageId }
}

// ─── updateBlogPost ───────────────────────────────────────────────────────────

export async function updateBlogPost(
  userId: string,
  postId: string,
  updates: UpdateBlogPostParams
): Promise<{ success: boolean; error?: string }> {
  const actor = await resolveBlogActor(userId)
  if (!actor.ok) return { success: false, error: actor.error }

  const supabase = await createClient()

  // ── 1. Fetch post to get brokerageId — SCOPED TO THE SESSION'S BROKERAGE ────
  const { data: existingPost, error: fetchError } = await supabase
    .from("blog_posts")
    .select("brokerage_id, publish_status")
    .eq("id", postId)
    .eq("brokerage_id", actor.brokerageId)
    .maybeSingle()

  if (fetchError || !existingPost) {
    return { success: false, error: "Blog post not found" }
  }

  // ── 2. If moving to 'approved', run brand compliance ────────────────────────
  if (updates.publishStatus === "approved" && existingPost.publish_status !== "approved") {
    const { data: fullPost } = await supabase
      .from("blog_posts")
      .select("content")
      .eq("id", postId)
      .eq("brokerage_id", actor.brokerageId)
      .maybeSingle()

    if (fullPost?.content) {
      const complianceResult = await checkBrandCompliance({
        brokerageId: existingPost.brokerage_id,
        contentType: "blog_post",
        contentId: postId,
      })

      if (!complianceResult.passed) {
        return {
          success: false,
          error: `Brand compliance failed: ${complianceResult.violations?.join(", ")}`,
        }
      }
    }
  }

  // ── 3. Update blog_posts ────────────────────────────────────────────────────
  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  if (updates.title !== undefined) updateData.title = updates.title
  if (updates.slug !== undefined) updateData.slug = updates.slug
  if (updates.content !== undefined) updateData.content = updates.content
  if (updates.excerpt !== undefined) updateData.excerpt = updates.excerpt
  if (updates.featuredImageUrl !== undefined) updateData.featured_image_url = updates.featuredImageUrl
  if (updates.publishStatus !== undefined) updateData.publish_status = updates.publishStatus
  if (updates.category !== undefined) updateData.category = updates.category || null
  if (updates.callToAction !== undefined) updateData.call_to_action = updates.callToAction || null

  const { data: updatedRows, error: updateError } = await supabase
    .from("blog_posts")
    .update(updateData)
    .eq("id", postId)
    .eq("brokerage_id", actor.brokerageId)
    .select("id")

  if (updateError) {
    console.error("[updateBlogPost] Update failed:", updateError)
    return { success: false, error: "Failed to update blog post" }
  }
  // An UPDATE that matched NOTHING also resolves with error === null (CLAUDE.md §3):
  // a refused tenant predicate is byte-identical to a successful write. COUNT the
  // rows the write actually returned rather than trusting the absent error.
  if (!updatedRows || updatedRows.length === 0) {
    return { success: false, error: "Blog post not found" }
  }

  // ── 4. If published, fire kernel event ──────────────────────────────────────
  if (updates.publishStatus === "published") {
    const { error: publishedAtErr } = await supabase
      .from("blog_posts")
      .update({ published_at: new Date().toISOString() })
      .eq("id", postId)
      .eq("brokerage_id", actor.brokerageId)
    if (publishedAtErr) console.error(`[blog] published_at NOT stamped: ${publishedAtErr.message}`)

    await processKernelEvent({
      event: KernelEvent.BLOG_POST_PUBLISHED,
      brokerageId: existingPost.brokerage_id,
      entityType: "blog_post",
      entityId: postId,
    }).catch((err) => {
      console.error("[blog] updateBlogPost kernel event failed (non-blocking):", err)
    })
  }

  return { success: true }
}

// ─── publishToWordPress ───────────────────────────────────────────────────────
// Wave 31 — kept as the WordPress-specific implementation. New callers use
// publishBlogPost() below which routes to the right backend based on
// blog_posts.publish_target. publishToWordPress is still exported for the
// 'both' target's WP leg and for backward-compat.

/**
 * Wave 31 — top-level publish entrypoint. Routes to the right backend
 * based on blog_posts.publish_target:
 *
 *   'hosted'    — flip publish_status='published' + published_at; the
 *                 /blog/[slug] route serves the post directly. No external
 *                 API call. Brokerages without WordPress use this.
 *   'wordpress' — call publishToWordPress (existing path); also flips
 *                 publish_status. Requires platform_credentials row.
 *   'both'      — fire the hosted publish AND the WordPress publish; the
 *                 WP content gets a rel="canonical" tag pointing to the
 *                 hosted URL so search engines don't see duplicate content.
 */
export async function publishBlogPost(
  userId: string,
  postId: string,
): Promise<{ success: boolean; hostedUrl?: string; wordpressPostId?: string; error?: string }> {
  const actor = await resolveBlogActor(userId)
  if (!actor.ok) return { success: false, error: actor.error }

  const supabase = await createClient()
  const { data: post } = await supabase
    .from("blog_posts")
    .select("id, brokerage_id, slug, publish_status, publish_target")
    .eq("id", postId)
    .eq("brokerage_id", actor.brokerageId)
    .maybeSingle()
  const p = post as { id: string; brokerage_id: string; slug: string; publish_status: string; publish_target: string } | null
  if (!p) return { success: false, error: "Blog post not found" }
  if (p.publish_status !== "approved" && p.publish_status !== "published") {
    return { success: false, error: "Post must be approved before publishing" }
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  const hostedUrl = `${baseUrl}/blog/${p.slug}`

  if (p.publish_target === "hosted") {
    const { error: hostedPublishErr } = await supabase.from("blog_posts").update({
      publish_status: "published",
      published_at:   new Date().toISOString(),
    }).eq("id", postId).eq("brokerage_id", actor.brokerageId)
    if (hostedPublishErr) return { success: false, error: `Could not mark the post published: ${hostedPublishErr.message}` }
    return { success: true, hostedUrl }
  }

  if (p.publish_target === "embed") {
    // Wave 32 — embed target is hosted-shape (no external API call), but
    // the URL the brokerage embeds is the chrome-stripped /embed route.
    // Both /blog/[slug] and /embed/blog/[slug] return the post on hit so
    // a brokerage can A/B test landing vs embed without re-publishing.
    const { error: embedPublishErr } = await supabase.from("blog_posts").update({
      publish_status: "published",
      published_at:   new Date().toISOString(),
    }).eq("id", postId).eq("brokerage_id", actor.brokerageId)
    if (embedPublishErr) return { success: false, error: `Could not mark the post published: ${embedPublishErr.message}` }
    return { success: true, hostedUrl: `${baseUrl}/embed/blog/${p.slug}` }
  }

  if (p.publish_target === "wordpress") {
    return await publishToWordPress(userId, postId)
  }

  // 'both' — fire hosted first (it never fails), then WordPress.
  await supabase.from("blog_posts").update({
    publish_status: "published",
    published_at:   new Date().toISOString(),
  }).eq("id", postId).eq("brokerage_id", actor.brokerageId)
  const wpResult = await publishToWordPress(userId, postId)
  return {
    success:         true,
    hostedUrl,
    wordpressPostId: wpResult.wordpressPostId,
    error:           wpResult.success ? undefined : wpResult.error,
  }
}

export async function publishToWordPress(
  userId: string,
  postId: string
): Promise<{ success: boolean; wordpressPostId?: string; error?: string }> {
  // `userId` was accepted here and read by NOTHING — see the gate's note above
  // resolveBlogActor. This endpoint pushes a brokerage's article to that
  // brokerage's WordPress using ITS stored credential, so an un-gated post id was
  // a cross-tenant publish, not just a cross-tenant read.
  const actor = await resolveBlogActor(userId)
  if (!actor.ok) return { success: false, error: actor.error }

  const supabase = await createClient()

  // ── 1. Fetch post — SCOPED TO THE SESSION'S BROKERAGE ───────────────────────
  const { data: post, error: fetchError } = await supabase
    .from("blog_posts")
    .select("id, brokerage_id, title, content, excerpt, publish_status")
    .eq("id", postId)
    .eq("brokerage_id", actor.brokerageId)
    .maybeSingle()

  if (fetchError || !post) {
    return { success: false, error: "Blog post not found" }
  }

  if (post.publish_status !== "approved" && post.publish_status !== "published") {
    return { success: false, error: "Post must be approved before publishing to WordPress" }
  }

  // ── 2. Get WordPress credentials ────────────────────────────────────────────
  // Resolution is gated on the Connection OS — see lib/blog/wordpress-connection.ts
  // for why this used to be an unanswerable query and what decision unblocks it.
  const credentials = await resolveWordPressCredential(supabase, post.brokerage_id)

  if (!credentials || !credentials.api_url) {
    return { success: false, error: wordPressUnavailableReason() }
  }

  // ── 3. Call WordPress REST API ──────────────────────────────────────────────
  // Wave 30 — augment the content with online-visibility instrumentation:
  //   · Inline view-tracker script that fires POST /api/blog/track-view on
  //     page load (parses ?p= / ?c= / ?utm_source= URL params)
  //   · Share-button block with per-channel onclick handlers that fire
  //     POST /api/blog/track-share BEFORE opening the share dialog
  // Both endpoints accept anonymous requests; the brokerage_id is
  // derived from the blog_post_id on the server. The platform's public
  // URL is read from env (NEXT_PUBLIC_APP_URL or VERCEL_URL) so the
  // injected script always points at the canonical tracker.
  const trackerBase = process.env.NEXT_PUBLIC_APP_URL
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "")
  const augmentedContent = buildInstrumentedBlogContent(post.content, postId, trackerBase)
  try {
    const authHeader = credentials.access_token
      ? `Bearer ${credentials.access_token}`
      : `Basic ${Buffer.from(`admin:${credentials.api_key}`).toString("base64")}`

    const response = await callConnector<{ id?: string | number }>({
      connector: "wordpress", baseUrl: credentials.api_url, path: "/wp-json/wp/v2/posts", method: "POST",
      auth: { style: "header", name: "Authorization", value: authHeader },
      body: { title: post.title, content: augmentedContent, excerpt: post.excerpt, status: "publish" },
    })

    if (!response.ok) {
      console.error("[publishToWordPress] WordPress API error:", response.error)
      return { success: false, error: "WordPress API error" }
    }

    const wpPost = response.data ?? {}

    // ── 4. Update blog_posts with wordpress_post_id ───────────────────────────
    const { error: wpStampErr } = await supabase
      .from("blog_posts")
      .update({
        wordpress_post_id: String(wpPost.id),
        published_at: new Date().toISOString(),
        publish_status: "published",
      })
      .eq("id", postId)
      .eq("brokerage_id", actor.brokerageId)
    if (wpStampErr) console.error(`[blog] WordPress post created but NOT linked on blog_posts: ${wpStampErr.message}`)

    return { success: true, wordpressPostId: String(wpPost.id) }
  } catch (err) {
    console.error("[publishToWordPress] Request failed:", err)
    return { success: false, error: "Failed to connect to WordPress" }
  }
}

// ─── getBlogPosts ──────────���────────────────────────────�����─────────────────────
//
// The FILTERED, reusable counterpart to the inline read in
// app/dashboard/marketing/blog/page.tsx (BlogDashboardPage), which loads the
// unfiltered first page server-side. That page is the survivor for the plain
// list; this action exists for the filters it does NOT have (publish status,
// agent, date range) — the refresh path the dashboard client still needs.
//
// TENANT NOW COMES FROM THE SESSION, NOT THE CALLER. It used to take
// `brokerageId: string` and feed it straight into `.eq("brokerage_id", …)` with
// no auth gate at all. In a "use server" module every export is a public HTTP
// endpoint, so that was an unauthenticated cross-tenant read: any brokerage's
// entire blog inventory — including unpublished drafts — for anyone who could
// guess a brokerage uuid. The page it duplicates always scoped to the signed-in
// user's brokerage; this one now does the same, the same way.
//
// WIRED (lane L). Caller: app/dashboard/marketing/blog/blog-dashboard-client.tsx —
// the Author / Created-from / Created-to controls and the Refresh button.
//
// It is NOT covered by the page, which is why it was never a deletion. The page
// runs ONE unfiltered read and hands the whole list to the client, which then
// narrows it in memory by search text, publish status and category. Author and
// date range cannot be done that way and existed nowhere: the client had no
// concept of either, and no way to re-read at all, so a post generated in one tab
// or written by a colleague never appeared until a full page reload. Those three
// server axes now come back through here.
//
// THE PROJECTION MATCHES THE PAGE'S, COLUMN FOR COLUMN, and that is load-bearing:
// the client keeps filtering the refreshed rows by `category` in memory, and this
// file's sibling lesson (blog page, `category` once omitted from the select) is that
// a column the surface renders but the reader drops turns every comparison false and
// empties the list without an error. Do not narrow it.
//
// PATH GLOBS ARE WRITTEN WITHOUT THEIR TRAILING WILDCARD IN THIS FILE, on
// purpose: a slash followed by a star opens a BLOCK comment even inside a line
// comment, for any tool that strips block comments BEFORE it drops line comments
// — and this file's own guard does exactly that. One such glob once swallowed
// ~670 lines of real code from every such analyzer's view, including the query
// this file's projection check anchors on. Do not reintroduce one.

// ─── Traffic sources — reads blog_post_views.source/referrer/viewer_ip_hash ──
//
// Written on every POST /api/blog/track-view but never read anywhere until
// now: the daily content-intel aggregator (lib/content-intel/performance-
// aggregator.ts) only reads blog_post_id + viewer_persona_snapshot for its
// topic/persona scoring, which is a DIFFERENT question ("which persona reads
// this") from the one this action answers ("where do readers come from, and
// how many distinct people is that"). viewer_ip_hash is never a raw IP
// (hashed at write time, per-brokerage salted) — it is read here ONLY to
// count DISTINCT hashes, never displayed or exported as an identifier.
export interface BlogTrafficOverview {
  totalViews: number
  uniqueViewers: number
  topSources: Array<{ source: string; count: number }>
  topReferrers: Array<{ referrer: string; count: number }>
  /** blog_post_share_clicks.share_channel, rolled up brokerage-wide — which
   *  platform readers actually use to share posts out. */
  sharesByChannel: Array<{ channel: string; count: number }>
}

export async function getBlogTrafficOverview(): Promise<{
  success: boolean
  overview?: BlogTrafficOverview
  error?: string
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Not authenticated" }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("blog_post_views")
    .select("source, referrer, viewer_ip_hash")
    .eq("brokerage_id", ctx.brokerageId)
    .order("viewed_at", { ascending: false })
    .limit(5000)

  if (error) return { success: false, error: error.message }

  const rows = (data ?? []) as Array<{ source: string | null; referrer: string | null; viewer_ip_hash: string | null }>
  const sourceCounts = new Map<string, number>()
  const referrerCounts = new Map<string, number>()
  const uniqueHashes = new Set<string>()

  for (const r of rows) {
    const source = (r.source ?? "direct").trim() || "direct"
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1)
    if (r.referrer) {
      // Referrers are full URLs — bucket by hostname so "utm-tagged" variants
      // of the same site don't fragment the top-referrers list.
      let bucket = r.referrer
      try { bucket = new URL(r.referrer).hostname } catch { /* not a URL — keep raw */ }
      referrerCounts.set(bucket, (referrerCounts.get(bucket) ?? 0) + 1)
    }
    if (r.viewer_ip_hash) uniqueHashes.add(r.viewer_ip_hash)
  }

  const topN = (m: Map<string, number>, n: number) =>
    Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, n)

  const { data: shareRows, error: shareError } = await supabase
    .from("blog_post_share_clicks")
    .select("share_channel")
    .eq("brokerage_id", ctx.brokerageId)
    .order("clicked_at", { ascending: false })
    .limit(2000)
  if (shareError) console.error("[getBlogTrafficOverview] share-clicks read failed:", shareError.message)
  const channelCounts = new Map<string, number>()
  for (const r of (shareRows ?? []) as Array<{ share_channel: string | null }>) {
    const ch = r.share_channel ?? "unknown"
    channelCounts.set(ch, (channelCounts.get(ch) ?? 0) + 1)
  }

  return {
    success: true,
    overview: {
      totalViews: rows.length,
      uniqueViewers: uniqueHashes.size,
      topSources: topN(sourceCounts, 5).map(([source, count]) => ({ source, count })),
      topReferrers: topN(referrerCounts, 5).map(([referrer, count]) => ({ referrer, count })),
      sharesByChannel: topN(channelCounts, 10).map(([channel, count]) => ({ channel, count })),
    },
  }
}

export async function getBlogPosts(
  filters?: {
    publishStatus?: string
    agentUserId?: string
    startDate?: string
    endDate?: string
  }
): Promise<{
  success: boolean
  posts?: Array<{
    id: string
    title: string
    slug: string
    excerpt: string
    publish_status: string
    category: string | null
    seo_score: number | null
    created_at: string
    published_at: string | null
    agent_user_id: string | null
    visibility_scope: string | null
  }>
  error?: string
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Not authenticated" }
  }

  const supabase = await createClient()

  let query = supabase
    .from("blog_posts")
    .select("id, title, slug, excerpt, publish_status, category, seo_score, created_at, published_at, agent_user_id, visibility_scope")
    .eq("brokerage_id", ctx.brokerageId)
    .order("created_at", { ascending: false })

  if (filters?.publishStatus) {
    query = query.eq("publish_status", filters.publishStatus)
  }
  if (filters?.agentUserId) {
    query = query.eq("agent_user_id", filters.agentUserId)
  }
  if (filters?.startDate) {
    query = query.gte("created_at", filters.startDate)
  }
  if (filters?.endDate) {
    query = query.lte("created_at", filters.endDate)
  }

  const { data, error } = await query

  if (error) {
    console.error("[getBlogPosts] Query failed:", error)
    return { success: false, error: "Failed to fetch blog posts" }
  }

  return { success: true, posts: data || [] }
}

// ─── REMOVED in the orphan burn-down (lane O) ─────────────────────────────────
//
// `getBlogPostById(postId)` — DELETED.
// SURVIVOR: app/dashboard/marketing/blog/[id]/page.tsx (BlogEditorPage), which
// loads the same three things inline and always did: the post scoped
// `.eq("id", postId).eq("brokerage_id", …)` (line 40-ish), its linked keywords
// through blog_post_keywords → seo_keywords (line 59-76), and the latest
// seo_optimization_log row (line 87). Nothing this action returned is missing
// there, so nothing needed merging.
//
// Its own header, written by the wave that repaired it, already named that page
// as the survivor and recorded that the page "was ALWAYS correct" while this
// copy shipped `.eq("id", postId)` and nothing else — no auth gate and no
// tenant predicate — returning any brokerage's unpublished body, keyword
// strategy and SEO audit to anyone holding a post uuid. It was gated then
// rather than removed. It has gained no caller since, and a second door onto a
// page's own data is a door that has to be re-audited every time the page's
// scoping changes. It is closed.

// ─── addSeoKeyword ────────────────────────────────────────────────────────────

export async function addSeoKeyword(
  userId: string,
  params: {
    brokerageId: string
    keyword: string
    keywordType: "primary" | "secondary" | "long_tail"
    searchIntent: "informational" | "transactional" | "navigational" | "commercial"
    targetLocation?: string
    searchVolume?: number
    competition?: number
    difficultyScore?: number
    priorityScore?: number
  }
): Promise<{ success: boolean; keywordId?: string; error?: string }> {
  const supabase = await createClient()

  // Check if keyword already exists
  const { data: existing } = await supabase
    .from("seo_keywords")
    .select("id")
    .eq("brokerage_id", params.brokerageId)
    .eq("keyword", params.keyword)
    .maybeSingle()

  if (existing) {
    return { success: false, error: "Keyword already exists" }
  }

  const { data: keyword, error } = await supabase
    .from("seo_keywords")
    .insert({
      brokerage_id: params.brokerageId,
      keyword: params.keyword,
      keyword_type: params.keywordType,
      search_intent: params.searchIntent,
      target_location: params.targetLocation || null,
      search_volume: params.searchVolume || null,
      competition: params.competition || null,
      difficulty_score: params.difficultyScore || null,
      priority_score: params.priorityScore || null,
      visibility_scope: "brokerage",
      created_by: userId,
      is_active: true,
    })
    .select("id")
    .maybeSingle()

  if (error || !keyword) {
    console.error("[addSeoKeyword] Insert failed:", error)
    return { success: false, error: "Failed to add keyword" }
  }

  return { success: true, keywordId: keyword.id }
}

// ─── getSeoKeywords ───────────────────────────────────────────────────────────
//
// NOT a duplicate of app/actions/ai-content-generation.tsx:getSEOKeywords — that
// file's own comment records the split deliberately: it reads the AGENT-scoped
// list (`.eq("agent_user_id", …)`), this one reads the BROKERAGE-wide list. Same
// table, different axes; both are wanted. Kept.
//
// What was wrong was the scope's SOURCE: `brokerageId` arrived from the caller
// with no auth gate, making a brokerage's whole keyword strategy — the SEO
// targets it is spending on — readable by anyone with the uuid. Derived from the
// session now, matching how the agent-scoped sibling gets its scope from
// requireContentActor().
//
// WIRED (lane L). Caller: app/dashboard/marketing/seo/seo-keywords-client.tsx,
// the Refresh control beside the keyword filters. That client had no reader at
// all: it seeded from the page's server-rendered list and thereafter kept the
// list in sync by RECONSTRUCTING each row from what the agent typed into the add
// form. This is the read that replaces the guess with what the table actually
// holds. The keep verdict above still holds — the agent-scoped sibling in
// app/actions/ai-content-generation.tsx is a different axis, not a survivor.
//
// `created_at` IS IN THIS PROJECTION for the same class of reason the blog page
// needed `category` in its own: the surface renders it, so a reader that omits
// it hands back rows the client cannot render. It matches the SeoKeywordsTab
// projection in app/dashboard/marketing/seo/page.tsx column for column, which is
// what makes this a drop-in refresh of that list rather than a second shape.

export async function getSeoKeywords(): Promise<{
  success: boolean
  keywords?: Array<{
    id: string
    keyword: string
    keyword_type: string
    search_intent: string
    target_location: string | null
    search_volume: number | null
    competition: number | null
    difficulty_score: number | null
    priority_score: number | null
    is_active: boolean
    created_at: string
  }>
  error?: string
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Not authenticated" }
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("seo_keywords")
    .select(
      "id, keyword, keyword_type, search_intent, target_location, search_volume, competition, difficulty_score, priority_score, is_active, created_at"
    )
    .eq("brokerage_id", ctx.brokerageId)
    .order("priority_score", { ascending: false, nullsFirst: false })

  if (error) {
    console.error("[getSeoKeywords] Query failed:", error)
    return { success: false, error: "Failed to fetch keywords" }
  }

  return { success: true, keywords: data || [] }
}

// ─── discoverKeywordsAI ───────────────────────────────────────────────────────
//
// Asks AI to surface the most popular SEO keywords for the brokerage's territory
// and their top competitor brokerages. Returns keywords with a relative search
// popularity percentage (0-100) so the agent can pick which ones to use for
// content generation.
//
// DB write: zero — this is a discovery/preview action only. The caller saves
// selected keywords via addSeoKeyword.

export interface DiscoveredKeyword {
  keyword:       string
  keyword_type:  "primary" | "secondary" | "long_tail"
  search_intent: "informational" | "transactional" | "navigational" | "commercial"
  popularity_pct: number   // 0-100 relative popularity score from AI analysis
  competitor_usage: boolean // true if a local competitor is ranking for this keyword
  rationale:     string    // one-sentence explanation
}

export async function discoverKeywordsAI(
  userId: string,
  params: {
    brokerageId: string
    territory?: string   // e.g. "Austin, TX" — falls back to brokerage city/state
    competitorNames?: string[] // optional list of known competitor brand names
    focusArea?: string   // e.g. "luxury listings", "first-time buyers", "rentals"
  }
): Promise<{
  success: boolean
  keywords?: DiscoveredKeyword[]
  error?: string
}> {
  // ── 0. Session gate (lane 91D2, CLAUDE.md §4) ───────────────────────────────
  // Both ids used to be trusted from the caller: an unauthenticated request could
  // run the keyword model under a named user's feature grant in a named tenant.
  // The tenant is the session's (a different body brokerage is refused) and the
  // user must be the signed-in one.
  const tenant = await requireCallerTenant(params.brokerageId)
  if (!tenant.ok) return { success: false, error: tenant.error }
  if (userId !== tenant.userId) return { success: false, error: "Forbidden: you can only run this as yourself." }
  params = { ...params, brokerageId: tenant.brokerageId }

  const supabase = await createClient()

  // ── 1. Feature gate ──────────────────────────────────────────────────────────
  const accessCheck = await canAccessFeature(userId, "seo_blog_engine")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  // ── 2. Resolve territory from brokerage record if not supplied ──────────────
  let territory = params.territory
  if (!territory) {
    const { data: brokerage } = await supabase
      .from("brokerages")
      .select("city, state, name")
      .eq("id", params.brokerageId)
      .maybeSingle()
    if (brokerage?.city && brokerage?.state) {
      territory = `${brokerage.city}, ${brokerage.state}`
    }
  }

  // ── 3. Fetch existing keywords so AI knows what agent already has ────────────
  const { data: existingKeywords } = await supabase
    .from("seo_keywords")
    .select("keyword")
    .eq("brokerage_id", params.brokerageId)
    .eq("is_active", true)
    .limit(30)

  const existingList = existingKeywords?.map(k => k.keyword) ?? []

  // ── 4. Build AI prompt ───────────────────────────────────────────────────────
  const competitorClause = params.competitorNames?.length
    ? `Known local competitors: ${params.competitorNames.join(", ")}.`
    : "Identify what keywords dominant local real estate brokerages in this market typically rank for."

  const focusClause = params.focusArea
    ? `Focus the keyword discovery on: ${params.focusArea}.`
    : "Cover a balanced mix of buyer-intent, seller-intent, and informational keywords."

  const existingClause = existingList.length
    ? `The agent already has these keywords: ${existingList.join(", ")}. Avoid exact duplicates but related variants are fine.`
    : ""

  const systemPrompt = `You are an SEO strategist specializing in real estate digital marketing. 
Your job is to surface the highest-impact keywords for a real estate brokerage based on their territory, 
local competitor landscape, and market demand. You return structured JSON only.`

  const userPrompt = `Discover the 12-15 most valuable SEO keywords for a real estate brokerage in ${territory || "a local real estate market"}.

${competitorClause}
${focusClause}
${existingClause}

For each keyword, estimate its relative popularity (0-100 where 100 = highest demand in this market) 
and whether local competitors are actively targeting it.

Return ONLY valid JSON (no markdown, no code blocks):
{
  "keywords": [
    {
      "keyword": "homes for sale in ${territory || "the area"}",
      "keyword_type": "primary",
      "search_intent": "transactional",
      "popularity_pct": 92,
      "competitor_usage": true,
      "rationale": "Highest-volume buyer search term in this market"
    }
  ]
}`

  let discovered: DiscoveredKeyword[]
  try {
    const { text } = await generateText({
      feature:      "blog_post_generation",
      system:       systemPrompt,
      prompt:       userPrompt,
      temperature:  0.4,
      brokerageId:  params.brokerageId,
      userId,
    })

    const cleaned = text.replace(/```json\n?|\n?```/g, "").trim()
    const parsed  = JSON.parse(cleaned) as { keywords: DiscoveredKeyword[] }
    discovered     = parsed.keywords ?? []
  } catch (err) {
    console.error("[discoverKeywordsAI] AI generation failed:", err)
    return { success: false, error: "Failed to generate keyword suggestions" }
  }

  // ── 5. Sort by popularity descending ─────────────────────────────────────────
  discovered.sort((a, b) => b.popularity_pct - a.popularity_pct)

  return { success: true, keywords: discovered }
}

// ─── toggleKeywordActive ──────────────────────────────────────────────────────

export async function toggleKeywordActive(
  keywordId: string,
  isActive: boolean
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  const { error } = await supabase.from("seo_keywords").update({ is_active: isActive }).eq("id", keywordId)

  if (error) {
    console.error("[toggleKeywordActive] Update failed:", error)
    return { success: false, error: "Failed to update keyword" }
  }

  return { success: true }
}

// ─── saveBlogPost (manual create) ────────────────────────────────────────────
//
// Creates a blank/manual blog post — no AI generation.
// Uses getAgentContext() per architecture rules.

export interface SaveBlogPostParams {
  title: string
  slug?: string
  excerpt?: string
  content?: string
  featuredImageUrl?: string
  category?: string
  callToAction?: string
  publishStatus?: "draft" | "pending_review"
  keywords?: string[]
}

export async function saveBlogPost(
  params: SaveBlogPostParams
): Promise<{ success: boolean; postId?: string; error?: string }> {
  // TOMBSTONE (wave 85F, §1.1). The feature gate, the slug, the blog_posts insert, the SEO
  // keyword upsert + links and the usage counter MOVED to the one draft creator,
  // lib/kernel/content-creators.ts createBlogPostDraft. The voice webhook has no cookie session
  // and was refused "Not authenticated" here, then fell back to a raw service-role insert in
  // lib/wizard-staging/content-staging.ts that skipped the gate and the counter; that fallback
  // merged onto the same creator. This door keeps the SESSION check.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) {
    return { success: false, error: "Not authenticated" }
  }
  const { createBlogPostDraft } = await import("@/lib/kernel/content-creators")
  const result = await createBlogPostDraft({
    ctx: { userId: ctx.userId, brokerageId: ctx.brokerageId },
    title: params.title,
    slug: params.slug,
    excerpt: params.excerpt,
    content: params.content,
    featuredImageUrl: params.featuredImageUrl,
    category: params.category,
    callToAction: params.callToAction,
    publishStatus: params.publishStatus,
    keywords: params.keywords,
  })
  return result.success ? { success: true, postId: result.postId } : { success: false, error: result.error }
}

// ─── generateTopicIdeas ───────────────────────────────────────────────────────
// ─── generateTopicIdeas ───────────────────────────────────────────────────────
//
// Returns 5 real estate blog topic suggestions based on the agent's market.
// Uses getAgentContext() — no userId param needed.

export interface TopicIdea {
  title: string
  category: string
  keywords: string[]
  rationale: string
}

export async function generateTopicIdeas(): Promise<{
  success: boolean
  ideas?: TopicIdea[]
  error?: string
}> {
  // ── 1. Auth ──────────────────────────────────────────────────────────────────
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) {
    return { success: false, error: "Not authenticated" }
  }

  // ── 2. Feature gate ──────────────────────────────────────────────────────────
  const accessCheck = await canAccessFeature(ctx.userId, "seo_blog_engine")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  const supabase = await createClient()

  // ── 3. Fetch brokerage context ───────────────────────────────────────────────
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("name, city, state")
    .eq("id", ctx.brokerageId)
    .maybeSingle()

  const territory = brokerage?.city && brokerage?.state
    ? `${brokerage.city}, ${brokerage.state}`
    : "a local real estate market"

  // ── 4. Fetch recent existing posts to avoid duplicates ───────────────────────
  const { data: recentPosts } = await supabase
    .from("blog_posts")
    .select("title")
    .eq("brokerage_id", ctx.brokerageId)
    .order("created_at", { ascending: false })
    .limit(10)

  const recentTitles = recentPosts?.map((p) => p.title).join("; ") || ""

  // ── 5. Generate via AI ───────────────────────────────────────────────────────
  const systemPrompt = `You are a real estate content strategist. Generate timely, SEO-rich blog topic ideas for a real estate brokerage. Return structured JSON only.`

  const userPrompt = `Generate 5 blog topic ideas for a real estate brokerage in ${territory}.

Categories to choose from: Market Update, Buyer Tips, Seller Tips, Neighborhood Guide, Investment Tips, Company News

${recentTitles ? `Avoid these already-written topics: ${recentTitles}` : ""}

Return ONLY valid JSON (no markdown, no code blocks):
{
  "ideas": [
    {
      "title": "5 Things Every First-Time Buyer Should Know About ${territory}",
      "category": "Buyer Tips",
      "keywords": ["first-time buyer", "home buying guide", "${territory} real estate"],
      "rationale": "High search volume for first-time buyer content in this market"
    }
  ]
}`

  try {
    const { text } = await generateText({
      feature: "blog_post_generation",
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.8,
      brokerageId: ctx.brokerageId,
      userId: ctx.userId,
    })

    const cleaned = text.replace(/```json\n?|\n?```/g, "").trim()
    const parsed = JSON.parse(cleaned) as { ideas: TopicIdea[] }
    return { success: true, ideas: parsed.ideas || [] }
  } catch (err) {
    console.error("[generateTopicIdeas] AI failed:", err)
    return { success: false, error: "Failed to generate topic ideas" }
  }
}

// ─── suggestSEOKeywords ───────────────────────────────────────────────────────
//
// Given a blog title and partial content, suggests relevant SEO keywords.
// Uses getAgentContext() — no userId param needed.

export async function suggestSEOKeywords(params: {
  title: string
  content?: string
}): Promise<{
  success: boolean
  keywords?: Array<{ keyword: string; type: "primary" | "secondary" | "long_tail" }>
  error?: string
}> {
  // ── 1. Auth ──────────────────────────────────────────────────────────────────
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) {
    return { success: false, error: "Not authenticated" }
  }

  // ── 2. Feature gate ──────────────────────────────────────────────────────────
  const accessCheck = await canAccessFeature(ctx.userId, "seo_blog_engine")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  const supabase = await createClient()

  // ── 3. Fetch territory context ───────────────────────────────────────────────
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("city, state")
    .eq("id", ctx.brokerageId)
    .maybeSingle()

  const territory = brokerage?.city && brokerage?.state
    ? `${brokerage.city}, ${brokerage.state}`
    : "local area"

  // ── 4. Generate keyword suggestions via AI ───────────────────────────────────
  const systemPrompt = `You are an SEO specialist for real estate content. Suggest relevant, high-value SEO keywords. Return structured JSON only.`

  const contentSnippet = params.content
    ? params.content.slice(0, 500)
    : ""

  const userPrompt = `Suggest 8-10 SEO keywords for this real estate blog post in ${territory}.

Title: ${params.title}
${contentSnippet ? `Content preview: ${contentSnippet}` : ""}

Return ONLY valid JSON (no markdown, no code blocks):
{
  "keywords": [
    { "keyword": "homes for sale in ${territory}", "type": "primary" },
    { "keyword": "real estate tips", "type": "secondary" },
    { "keyword": "how to buy a home in ${territory} 2025", "type": "long_tail" }
  ]
}`

  try {
    const { text } = await generateText({
      feature: "blog_post_generation",
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.3,
      brokerageId: ctx.brokerageId,
      userId: ctx.userId,
    })

    const cleaned = text.replace(/```json\n?|\n?```/g, "").trim()
    const parsed = JSON.parse(cleaned) as {
      keywords: Array<{ keyword: string; type: "primary" | "secondary" | "long_tail" }>
    }
    return { success: true, keywords: parsed.keywords || [] }
  } catch (err) {
    console.error("[suggestSEOKeywords] AI failed:", err)
    return { success: false, error: "Failed to suggest keywords" }
  }
}

/**
 * Wave 30 — wrap blog HTML with view-tracking script + share-button block.
 * Called from publishToWordPress before the WP REST insert. The script is
 * self-contained: reads its own data-blog-post-id attribute, parses URL
 * params (?p= persona, ?c= contact_id, ?utm_source= source), and fires a
 * fire-and-forget POST to the tracker endpoint. Share buttons render as
 * inline HTML with onclick handlers that fire the share-tracker before
 * opening the platform-specific share dialog.
 *
 * Why injected into content (not the WP theme): zero theme modification,
 * works on every WP install including managed hosts where theme edits are
 * locked. Some heavily-sanitized themes may strip the inline <script>;
 * those installs can add the script to their theme footer instead — but
 * the share buttons (pure HTML+onclick) survive every sanitizer.
 */
function buildInstrumentedBlogContent(originalContent: string, blogPostId: string, trackerBase: string): string {
  const safeBase = trackerBase.replace(/['"<>]/g, "")
  const safeId   = blogPostId.replace(/[^a-z0-9-]/gi, "")
  // Share buttons — emoji + label + onclick handler. The handler fires the
  // tracker THEN opens the share window (so a blocked window doesn't lose
  // the signal). Each channel is a simple anchor with javascript:void(0).
  const shareBlock = `
<div class="blog-share-block" style="margin:32px 0 16px 0;padding:16px;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;text-align:center;font-family:system-ui,-apple-system,sans-serif">
  <div style="font-size:14px;font-weight:600;color:#374151;margin-bottom:12px">Found this useful? Share it</div>
  <div style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap">
    <a href="javascript:void(0)" onclick="window.__bptShare('facebook')"   style="padding:8px 14px;background:#1877f2;color:#fff;border-radius:6px;text-decoration:none;font-size:13px">Facebook</a>
    <a href="javascript:void(0)" onclick="window.__bptShare('twitter')"    style="padding:8px 14px;background:#000;color:#fff;border-radius:6px;text-decoration:none;font-size:13px">X / Twitter</a>
    <a href="javascript:void(0)" onclick="window.__bptShare('linkedin')"   style="padding:8px 14px;background:#0a66c2;color:#fff;border-radius:6px;text-decoration:none;font-size:13px">LinkedIn</a>
    <a href="javascript:void(0)" onclick="window.__bptShare('whatsapp')"   style="padding:8px 14px;background:#25d366;color:#fff;border-radius:6px;text-decoration:none;font-size:13px">WhatsApp</a>
    <a href="javascript:void(0)" onclick="window.__bptShare('email_share')" style="padding:8px 14px;background:#374151;color:#fff;border-radius:6px;text-decoration:none;font-size:13px">Email</a>
    <a href="javascript:void(0)" onclick="window.__bptShare('copy_link')"   style="padding:8px 14px;background:#6b7280;color:#fff;border-radius:6px;text-decoration:none;font-size:13px">Copy Link</a>
  </div>
</div>`
  // The tracker script — view fires on load, share fires on button click.
  // Uses mode:'no-cors' so cross-origin posts succeed without preflight
  // (the tracker endpoint accepts the body as-is from any origin since
  // it's public by design).
  const trackerScript = `
<script data-blog-post-id="${safeId}">
(function(){
  var BASE   = "${safeBase}";
  var POSTID = "${safeId}";
  if (!BASE || !POSTID) return;
  function paramOf(name){
    try { return new URLSearchParams(window.location.search).get(name); } catch(e) { return null; }
  }
  var persona = paramOf("p");
  var contactId = paramOf("c");
  var source = paramOf("utm_source") || (document.referrer ? guessSource(document.referrer) : "direct");
  function guessSource(ref){
    if (!ref) return "direct";
    var h = (function(){ try { return new URL(ref).hostname; } catch(e){ return ""; } })();
    if (h.indexOf("newsletter") >= 0 || ref.indexOf("utm_source=newsletter") >= 0) return "newsletter";
    if (h.indexOf("facebook") >= 0 || h.indexOf("twitter") >= 0 || h.indexOf("linkedin") >= 0 || h.indexOf("x.com") >= 0) return "social_post";
    if (h.indexOf("google") >= 0 || h.indexOf("bing") >= 0) return "organic";
    if (h.indexOf("openai") >= 0 || h.indexOf("perplexity") >= 0 || h.indexOf("chat.") >= 0 || h.indexOf("gemini") >= 0) return "ai_overview";
    return "unknown";
  }
  function post(path, body){
    try {
      fetch(BASE + path, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true
      });
    } catch(e){}
  }
  // View tracker — fire once on load
  post("/api/blog/track-view", {
    blog_post_id: POSTID,
    source: source,
    referrer: document.referrer || null,
    contact_id: contactId,
    persona_snapshot: persona
  });
  // Share handler — fire tracker, then open the share dialog
  window.__bptShare = function(channel){
    post("/api/blog/track-share", {
      blog_post_id: POSTID,
      share_channel: channel,
      contact_id: contactId,
      persona_snapshot: persona
    });
    var url = window.location.href;
    var title = document.title || "";
    if (channel === "copy_link") {
      try { navigator.clipboard.writeText(url); } catch(e){}
      return;
    }
    var target = "";
    if (channel === "facebook") target = "https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(url);
    else if (channel === "twitter") target = "https://twitter.com/intent/tweet?url=" + encodeURIComponent(url) + "&text=" + encodeURIComponent(title);
    else if (channel === "linkedin") target = "https://www.linkedin.com/sharing/share-offsite/?url=" + encodeURIComponent(url);
    else if (channel === "whatsapp") target = "https://api.whatsapp.com/send?text=" + encodeURIComponent(title + " " + url);
    else if (channel === "email_share") target = "mailto:?subject=" + encodeURIComponent(title) + "&body=" + encodeURIComponent(url);
    if (target) window.open(target, "_blank", "noopener,noreferrer");
  };
})();
</script>`
  return originalContent + shareBlock + trackerScript
}

// Imported at the foot (lane 93A) so the file:line references other files hold into this one stay true (ES imports hoist).
import { decideClaimedTenant } from "@/lib/platform/acting-context"
