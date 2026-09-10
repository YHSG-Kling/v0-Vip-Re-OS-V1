/**
 * lib/marketing/content-winner.ts
 *
 * THE `content_winner` SIGNAL HAS AN EMITTER NOW. lib/kernel/signal-registry.ts
 * has declared it since wave 41 ("a winning organic post — Ads Manager proposes
 * promoting it") and lib/kernel/manager-signals.ts has handled it
 * (ads_manager:content_winner → a launch_ad_campaign proposal), but NOTHING
 * PUBLISHED IT — lib/outcomes/provider-event-fanout.ts records why the
 * measurements were zero, and once they were real there was still no writer.
 * A handler with no emitter is the orphan shape §1.2 names: no duplicate
 * exists and the capability is wanted, so BUILD the missing half.
 *
 * What a winner is (ads-audit skill: judge on the brokerage's OWN floor, never
 * a vanity absolute): a PUBLISHED post whose latest measured engagement rate
 * (engagements / impressions) is at least WINNER_LIFT × the brokerage's 28-day
 * organic baseline for the same (platform, post_type) —
 * social_post_baselines_28d through lib/marketing/social-baselines.ts, the one
 * baseline reader — with enough impressions to mean something and a baseline
 * built from enough posts to be a floor. The signal rides the manager bus
 * (campaign_orchestrator → ads_manager — m618: survivor of the retired
 * marketing_agent seat), idempotent per open (post) signal.
 *
 * Runs after the daily analytics sync (app/api/cron/social-analytics-sync),
 * so it judges fresh numbers. Cross-cooperated: campaign_orchestrator emits,
 * ads_manager proposes paid promotion (gated spend), compliance_officer's
 * scan runs again when the paid creative is staged (lib/ads/promote-post.ts).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { listSocialBaselines } from "./social-baselines"
import { judgeContentWinner, WINNER_WINDOW_DAYS } from "./content-winner-verdict"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"

type Svc = ReturnType<typeof createServiceClient>

interface DetectResult { judged: number; winners: number; signalled: number; skippedRefusal?: string }

/**
 * For one brokerage: judge every published post of the window against the
 * organic baseline and publish `content_winner` for each winner. A refused
 * read is reported, not read as "no posts".
 */
async function detectContentWinners(brokerageId: string, client?: Svc, now: Date = new Date()): Promise<DetectResult> {
  const svc = client ?? createServiceClient()
  const baselines = await listSocialBaselines(brokerageId)
  if (baselines.length === 0) return { judged: 0, winners: 0, signalled: 0 }

  const sinceIso = new Date(now.getTime() - WINNER_WINDOW_DAYS * 86_400_000).toISOString()
  const { data: posts, error: postsError } = await svc
    .from("social_posts")
    .select("id, platform, post_type, listing_id, content, published_at")
    .eq("brokerage_id", brokerageId)
    .eq("status", "published")
    .gte("published_at", sinceIso)
    .not("external_post_id", "is", null)
    .limit(200)
  if (postsError) {
    console.error("[content-winner] social_posts read refused:", postsError.message)
    return { judged: 0, winners: 0, signalled: 0, skippedRefusal: postsError.message }
  }
  const rows = (posts ?? []) as Array<{ id: string; platform: string; post_type: string | null; listing_id: string | null; content: string | null; published_at: string | null }>
  if (rows.length === 0) return { judged: 0, winners: 0, signalled: 0 }

  // Latest measurement per post (the sync appends a row per measurement).
  const { data: metrics, error: metricsError } = await svc
    .from("social_media_analytics")
    .select("post_id, impressions, engagements, measured_at")
    .eq("brokerage_id", brokerageId)
    .in("post_id", rows.map((r) => r.id))
    .order("measured_at", { ascending: false })
  if (metricsError) {
    console.error("[content-winner] social_media_analytics read refused:", metricsError.message)
    return { judged: 0, winners: 0, signalled: 0, skippedRefusal: metricsError.message }
  }
  const latest = new Map<string, { impressions: number; engagements: number }>()
  for (const m of (metrics ?? []) as Array<{ post_id: string; impressions: number | null; engagements: number | null }>) {
    if (!latest.has(m.post_id)) latest.set(m.post_id, { impressions: Number(m.impressions ?? 0), engagements: Number(m.engagements ?? 0) })
  }

  let judged = 0, winners = 0, signalled = 0
  for (const p of rows) {
    const m = latest.get(p.id)
    if (!m) continue
    judged++
    const verdict = judgeContentWinner({ postId: p.id, platform: p.platform, postType: p.post_type ?? "post", impressions: m.impressions, engagements: m.engagements }, baselines)
    if (!verdict) continue
    winners++
    const excerpt = (p.content ?? "").replace(/\s+/g, " ").trim().slice(0, 140)
    const r = await publishManagerSignal({
      brokerageId,
      fromManager: "campaign_orchestrator", // m618: survivor of the retired marketing_agent seat
      toManager: "ads_manager",
      signalType: "content_winner",
      message: `Organic ${p.platform} ${verdict.postType} post is running at ${(verdict.engagementRate * 100).toFixed(1)}% engagement — ${verdict.lift.toFixed(1)}× the brokerage's 28-day baseline (${(verdict.baselineRate * 100).toFixed(1)}%) on ${verdict.impressions} impressions: "${excerpt}"`,
      entityType: "social_post",
      entityId: p.id,
      payload: {
        post_id: p.id, platform: p.platform, post_type: verdict.postType, listing_id: p.listing_id,
        impressions: verdict.impressions, engagement_rate: verdict.engagementRate, baseline_rate: verdict.baselineRate, lift: verdict.lift,
      },
    }, svc)
    if (r.ok) signalled++
  }
  return { judged, winners, signalled }
}

/** Every brokerage measured in the window, judged. Rides the analytics-sync cron. */
export async function detectContentWinnersAll(client?: Svc, now: Date = new Date()): Promise<{ brokerages: number; winners: number; signalled: number }> {
  const svc = client ?? createServiceClient()
  const sinceIso = new Date(now.getTime() - WINNER_WINDOW_DAYS * 86_400_000).toISOString()
  const { data, error } = await svc.from("social_media_analytics").select("brokerage_id").gte("measured_at", sinceIso).limit(5000)
  if (error) { console.error("[content-winner] brokerage sweep read refused:", error.message); return { brokerages: 0, winners: 0, signalled: 0 } }
  const ids = Array.from(new Set(((data ?? []) as Array<{ brokerage_id: string }>).map((r) => r.brokerage_id)))
  let winners = 0, signalled = 0
  for (const bid of ids) {
    try {
      const r = await detectContentWinners(bid, svc, now)
      winners += r.winners; signalled += r.signalled
    } catch (e) { console.error("[content-winner] brokerage failed:", bid, (e as Error).message) }
  }
  return { brokerages: ids.length, winners, signalled }
}
