// ─── GENERAL/BRAND SOCIAL AUTO-CADENCE STAGER (session-free) ─────────────────
// Listing events already auto-produce social (listing-promo-social-publish), but there was
// no cadence for BRAND / engagement posts (market updates, tips) — the channel had one type,
// not full coverage. This stages GATED brand social drafts from the topics pool across the
// agent's connected platforms on a cadence, so the AI studio keeps the feed alive between
// listings and the human just approves. Session-free (service client) for the cron. Idempotent:
// one brand-social batch per agent per day.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

// The non-listing post types the social_posts CHECK allows.
export const BRAND_POST_TYPES = ["market_update", "custom"] as const
export type BrandPostType = (typeof BRAND_POST_TYPES)[number]

/** PURE: pick the brand post type for this run — a market update on even ISO weeks, an evergreen
 *  tip ('custom') on odd, unless the policy narrows the set. Deterministic (no repeats same week). */
export function pickBrandPostType(preferred: string[] | null | undefined, isoWeek: number): BrandPostType {
  const allowed = (preferred ?? []).filter((t): t is BrandPostType => (BRAND_POST_TYPES as readonly string[]).includes(t))
  const pool = allowed.length > 0 ? allowed : [...BRAND_POST_TYPES]
  return pool[isoWeek % pool.length]
}

export interface StageSocialInput {
  brokerageId: string
  /** agents.id — social_posts.agent_id FK. */
  agentsId: string
  /** users.id — social_posts.user_id (legacy column). */
  agentUserId: string
  categories?: string[] | null
  persona?: string | null
  postTypes?: string[] | null
}

export interface StageSocialResult {
  staged: boolean
  count: number
  postType?: string
  reason?: string
}

export async function stageSocialFromCadence(
  input: StageSocialInput,
  client?: Svc,
  opts?: { now?: Date },
): Promise<StageSocialResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()

  // Idempotency — one auto-staged brand-social batch per agent per day.
  const { count: already } = await svc
    .from("social_posts")
    .select("id", { count: "exact", head: true })
    .eq("brokerage_id", input.brokerageId)
    .eq("agent_id", input.agentsId)
    .is("listing_id", null)
    .in("post_type", [...BRAND_POST_TYPES])
    .gte("created_at", todayStart)
  if ((already ?? 0) > 0) return { staged: false, count: 0, reason: "already_staged_today" }

  // Connected platforms for this brokerage — no post without a real channel to publish to.
  const { data: accounts } = await svc
    .from("social_media_accounts")
    .select("platform")
    .eq("brokerage_id", input.brokerageId)
    .eq("is_active", true)
  const platforms = Array.from(new Set(((accounts ?? []) as Array<{ platform: string | null }>).map((a) => a.platform).filter((p): p is string => !!p)))
  if (platforms.length === 0) return { staged: false, count: 0, reason: "no_connected_platforms" }

  // Fresh topic from the pool — persona-aware, competitor-fed, repeat-avoidant.
  let topicTitle: string | null = null
  let topicAngle: string | null = null
  try {
    const { pickTopics } = await import("@/lib/content-intel/topic-bank")
    const topics = await pickTopics({ brokerageId: input.brokerageId, categoriesAny: input.categories ?? undefined, limit: 3, recipientPersona: input.persona ?? undefined, markUsed: false })
    if (topics.length > 0) { topicTitle = topics[0].topic_title ?? null; topicAngle = topics[0].value_angle ?? null }
  } catch { /* topic pool best-effort — the evergreen caption below keeps it real */ }

  const isoWeek = isoWeekOf(now)
  const postType = pickBrandPostType(input.postTypes, isoWeek)
  const caption = topicTitle
    ? `${topicTitle}${topicAngle ? ` — ${topicAngle}` : ""}`
    : postType === "market_update"
      ? "This week in your local market — what buyers and sellers should know."
      : "A quick real-estate tip worth two minutes of your time."

  // MEDIA PAIRING (owner rule: nothing ships bare) — library-first, then a
  // brand-aware generated image captured back into the library. Null means
  // "stage without media" — a bare draft the approval UI surfaces beats no
  // post, but it should be the exception, not the default it used to be.
  let mediaUrls: string[] = []
  try {
    const { resolveSocialMedia } = await import("./social-media-pairing")
    const paired = await resolveSocialMedia(svc, {
      brokerageId: input.brokerageId,
      agentUserId: input.agentUserId,
      topicTitle,
      postType,
    })
    if (paired) mediaUrls = paired.mediaUrls
  } catch { /* bare draft fallback */ }

  // One gated draft per connected platform (a human approves/edits before publish-social-posts sends).
  let count = 0
  for (const platform of platforms) {
    const { data: post } = await svc
      .from("social_posts")
      .insert({
        brokerage_id: input.brokerageId,
        agent_id: input.agentsId,
        user_id: input.agentUserId,
        listing_id: null,
        platform,
        post_type: postType,
        content: caption,
        media_urls: mediaUrls,
        status: "draft",
        approval_status: "pending", // GATED — publish-social-posts only sends approval_status='approved'
      })
      .select("id")
      .maybeSingle()
    if (post?.id) count++
  }

  return count > 0
    ? { staged: true, count, postType }
    : { staged: false, count: 0, reason: "insert_failed" }
}

/** ISO-8601 week number (1..53), UTC — matches lib/marketing/cadence-policy.isoWeekNumber. */
function isoWeekOf(d: Date): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - dayNum + 3)
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3)
  return 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000))
}
