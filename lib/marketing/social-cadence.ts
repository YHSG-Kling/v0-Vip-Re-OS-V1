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

  // MEDIA PAIRING PER CHANNEL (owner rule: video/image are media TYPES, not
  // channels — each channel gets the type that is PROVEN for it: the
  // tenant's own learned engagement first, competitor-validated channel
  // norms second, library availability last). Generation happens at most
  // once — the generated image is captured into the library, so the next
  // platform's library lookup finds it instead of paying again. A null
  // pairing stages a bare draft the approval UI surfaces — the exception,
  // not the default it used to be.
  const { resolveSocialMedia } = await import("./social-media-pairing")

  // THE MARKETING AUTONOMY RATCHET — when the broker has GRANTED this
  // post_type (earned: >=20 straight human approvals, zero rejections) AND
  // the Campaign Orchestrator's autonomy posture allows it (approval_required
  // — broker override, eval probation, or the platform circuit-breaker —
  // OVERRIDES any grant), the post stages APPROVED + SCHEDULED instead of
  // waiting in the queue. Fair Housing + every dispatch gate still run on
  // send; the act is recorded on the policy ledger. Fail-closed everywhere.
  let autoApprove = false
  let grantedShape: string | null = null
  try {
    const { loadMarketingGrants } = await import("@/lib/documents/autonomy-ratchet")
    const grants = await loadMarketingGrants(svc, input.brokerageId)
    const shape = `social_post:${postType}`
    if (grants.has(shape)) {
      const { resolveManagerAutonomy } = await import("@/lib/managers/autonomy-gate")
      const posture = await resolveManagerAutonomy(input.brokerageId, "campaign_orchestrator", svc as any)
      if (posture !== "approval_required") {
        autoApprove = true
        grantedShape = shape
      }
    }
  } catch { /* fail closed — the queue is the default */ }

  // One draft per connected platform (gated in the approval queue unless the
  // broker granted this shape — then approved + scheduled, ledger-recorded).
  let count = 0
  for (const platform of platforms) {
    let mediaUrls: string[] = []
    try {
      const paired = await resolveSocialMedia(svc, {
        brokerageId: input.brokerageId,
        agentUserId: input.agentUserId,
        topicTitle,
        postType,
        platform,
      })
      if (paired) mediaUrls = paired.mediaUrls
    } catch { /* bare draft fallback */ }
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
        ai_generated: true, // AI-staged — the ratchet's evidence ledger reads this
        ...(autoApprove
          // post_brief is TEXT (live contract) — a plain provenance marker, not jsonb.
          ? { status: "scheduled", approval_status: "approved", scheduled_for: new Date().toISOString(), post_brief: `auto_approved_by_grant:${grantedShape}` }
          : { status: "draft", approval_status: "pending" }), // GATED — publish-social-posts only sends approval_status='approved'
      })
      .select("id")
      .maybeSingle()
    if (post?.id) {
      count++
      if (autoApprove && grantedShape) {
        // The autonomous act goes on the SAME policy ledger the doc kernel uses.
        try {
          const { recordPolicyDecision } = await import("@/lib/documents/policy-decisions")
          await recordPolicyDecision(svc as any, {
            brokerageId: input.brokerageId,
            targetType: "social_post",
            targetId: postType,
            verdict: {
              decision: "green",
              reasons: [`staged approved+scheduled under broker-granted autonomy (${grantedShape})`],
              recommendedAction: "auto_approved_by_grant",
              requiredApproverRole: null,
            },
            evidence: { granted_shape: grantedShape, platform, post_id: (post as any).id },
          })
        } catch { /* ledger write is best-effort; the post itself is already gated at dispatch */ }
      }
    }
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
