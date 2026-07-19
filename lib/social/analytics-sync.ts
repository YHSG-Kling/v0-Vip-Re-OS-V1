import "server-only"

// lib/social/analytics-sync.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE REAL WRITER for social_media_analytics (round 30). This table had NO
// honest writer in the codebase's entire history — its only feeder was a dead
// fake-success stub that fabricated external ids and zeroed metrics (killed
// this round). The bundle-attribution rollup READS this table for SOCIAL_POST
// scans, so until now that attribution lane could only ever see zeros.
//
// This sync pulls REAL metrics from each platform's API for posts the OS
// actually published (social_posts.status='published' with a real
// external_post_id), through the SAME connector gateway + stored tenant
// credentials the publisher used to post. Honest per-platform capability:
//   · twitter/x   — GET /2/tweets?ids=…&tweet.fields=public_metrics
//   · facebook    — Graph {id}?fields=likes/comments/shares summaries
//   · instagram   — Graph {id}?fields=like_count,comments_count
//   · linkedin    — GET /v2/socialActions/{urn} likes/comments summaries
//   · others      — honestly skipped (no metrics fetch implemented; counted)
// A platform token without metrics scope fails that POST's fetch — counted as
// an error, never fabricated. No creds → honest skip. Nothing here ever
// invents a number.

import { callConnector, type GatewayAuth } from "@/lib/agentic-os/connector-gateway"

type Svc = any

export interface AnalyticsSyncResult {
  scanned: number
  synced: number
  skippedNoAccount: number
  skippedUnsupported: number
  errors: number
}

interface PublishedPost {
  id: string
  brokerage_id: string
  platform: string
  external_post_id: string
  published_at: string | null
  social_account_id: string | null
}

interface FetchedMetrics {
  impressions: number | null
  engagements: number | null
  clicks: number | null
}

// ── Per-platform metric fetches (real API calls; null = metric not exposed) ──

async function fetchTwitterMetrics(externalId: string, accessToken: string): Promise<FetchedMetrics> {
  const auth: GatewayAuth = { style: "bearer", token: accessToken }
  const res = await callConnector<{ data?: Array<{ public_metrics?: Record<string, number> }> }>({
    connector: "twitter",
    baseUrl: "https://api.twitter.com",
    path: `/2/tweets?ids=${encodeURIComponent(externalId)}&tweet.fields=public_metrics`,
    method: "GET",
    auth,
  })
  const m = res.data?.data?.[0]?.public_metrics
  if (!m) throw new Error("no public_metrics in response")
  return {
    impressions: m.impression_count ?? null,
    engagements: (m.like_count ?? 0) + (m.retweet_count ?? 0) + (m.reply_count ?? 0) + (m.quote_count ?? 0),
    clicks: null, // not exposed on the public_metrics surface
  }
}

async function fetchFacebookMetrics(externalId: string, accessToken: string): Promise<FetchedMetrics> {
  const auth: GatewayAuth = { style: "query", name: "access_token", value: accessToken }
  const res = await callConnector<{
    likes?: { summary?: { total_count?: number } }
    comments?: { summary?: { total_count?: number } }
    shares?: { count?: number }
  }>({
    connector: "meta",
    baseUrl: "https://graph.facebook.com",
    path: `/v18.0/${encodeURIComponent(externalId)}?fields=likes.summary(true),comments.summary(true),shares`,
    method: "GET",
    auth,
  })
  const d = res.data
  if (!d) throw new Error("empty Graph response")
  const engagements =
    (d.likes?.summary?.total_count ?? 0) +
    (d.comments?.summary?.total_count ?? 0) +
    (d.shares?.count ?? 0)
  return { impressions: null, engagements, clicks: null }
}

async function fetchInstagramMetrics(externalId: string, accessToken: string): Promise<FetchedMetrics> {
  const auth: GatewayAuth = { style: "query", name: "access_token", value: accessToken }
  const res = await callConnector<{ like_count?: number; comments_count?: number }>({
    connector: "meta",
    baseUrl: "https://graph.facebook.com",
    path: `/v18.0/${encodeURIComponent(externalId)}?fields=like_count,comments_count`,
    method: "GET",
    auth,
  })
  const d = res.data
  if (!d) throw new Error("empty Graph response")
  return {
    impressions: null,
    engagements: (d.like_count ?? 0) + (d.comments_count ?? 0),
    clicks: null,
  }
}

async function fetchLinkedInMetrics(externalId: string, accessToken: string): Promise<FetchedMetrics> {
  const auth: GatewayAuth = { style: "bearer", token: accessToken }
  const res = await callConnector<{
    likesSummary?: { totalLikes?: number }
    commentsSummary?: { aggregatedTotalComments?: number }
  }>({
    connector: "linkedin",
    baseUrl: "https://api.linkedin.com",
    path: `/v2/socialActions/${encodeURIComponent(externalId)}`,
    method: "GET",
    auth,
  })
  const d = res.data
  if (!d) throw new Error("empty socialActions response")
  return {
    impressions: null,
    engagements: (d.likesSummary?.totalLikes ?? 0) + (d.commentsSummary?.aggregatedTotalComments ?? 0),
    clicks: null,
  }
}

const FETCHERS: Record<string, (id: string, token: string) => Promise<FetchedMetrics>> = {
  twitter: fetchTwitterMetrics,
  x: fetchTwitterMetrics,
  facebook: fetchFacebookMetrics,
  instagram: fetchInstagramMetrics,
  linkedin: fetchLinkedInMetrics,
}

// ── The sync sweep ────────────────────────────────────────────────────────────

export async function syncSocialAnalytics(
  svc: Svc,
  opts: { sinceDays?: number; limit?: number; now?: Date } = {},
): Promise<AnalyticsSyncResult> {
  const sinceDays = opts.sinceDays ?? 30
  const limit = opts.limit ?? 100
  const now = opts.now ?? new Date()
  const sinceIso = new Date(now.getTime() - sinceDays * 86_400_000).toISOString()
  const result: AnalyticsSyncResult = { scanned: 0, synced: 0, skippedNoAccount: 0, skippedUnsupported: 0, errors: 0 }

  const { data: posts } = await svc
    .from("social_posts")
    .select("id, brokerage_id, platform, external_post_id, published_at, social_account_id")
    .eq("status", "published")
    .not("external_post_id", "is", null)
    .gte("published_at", sinceIso)
    .order("published_at", { ascending: false })
    .limit(limit)

  for (const post of (posts ?? []) as PublishedPost[]) {
    result.scanned++
    const fetcher = FETCHERS[post.platform]
    if (!fetcher) { result.skippedUnsupported++; continue }

    // The SAME credential the publisher posted with.
    if (!post.social_account_id) { result.skippedNoAccount++; continue }
    const { data: account } = await svc
      .from("social_media_accounts")
      .select("access_token")
      .eq("id", post.social_account_id)
      .maybeSingle()
    const token = (account as { access_token?: string | null } | null)?.access_token
    if (!token) { result.skippedNoAccount++; continue }

    try {
      const metrics = await fetcher(post.external_post_id, token)

      // Upsert on (post_id, platform): update the existing measurement row or
      // insert the first one. Checked writes — a loss is an error, never silent.
      const { data: existing } = await svc
        .from("social_media_analytics")
        .select("id")
        .eq("post_id", post.id)
        .eq("platform", post.platform)
        .maybeSingle()

      const row = {
        brokerage_id: post.brokerage_id,
        post_id: post.id,
        platform: post.platform,
        external_post_id: post.external_post_id,
        impressions: metrics.impressions ?? 0,
        engagements: metrics.engagements ?? 0,
        clicks: metrics.clicks ?? 0,
        published_at: post.published_at,
        measured_at: now.toISOString(),
        metadata: {
          source: "analytics_sync",
          // Honesty markers: which metrics the platform actually exposed vs
          // zero-filled because the surface doesn't provide them.
          exposed: {
            impressions: metrics.impressions != null,
            engagements: metrics.engagements != null,
            clicks: metrics.clicks != null,
          },
        },
      }

      const write = existing
        ? await svc.from("social_media_analytics").update(row).eq("id", (existing as { id: string }).id)
        : await svc.from("social_media_analytics").insert(row)
      if (write.error) { result.errors++; continue }
      result.synced++
    } catch {
      result.errors++
    }
  }

  return result
}
