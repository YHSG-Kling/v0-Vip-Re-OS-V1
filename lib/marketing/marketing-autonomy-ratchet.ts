/**
 * lib/marketing/marketing-autonomy-ratchet.ts
 *
 * THE MARKETING AUTONOMY RATCHET — the earned-autonomy pattern (built on
 * the document kernel) generalized to the biggest friction point in the
 * product: approval fatigue on the marketing lanes. The social approval
 * queue already records every HUMAN approve/reject on AI-staged posts
 * (social_posts.approval_status + approved_by, ai_generated=true); when
 * one content SHAPE (`social_post:<post_type>`, per brokerage) has been
 * human-approved ≥ MARKETING_RATCHET_MIN_APPROVALS times with ZERO
 * rejections, the Campaign Orchestrator proposes — TO THE BROKER — letting
 * that one shape publish on schedule without the queue.
 *
 * The bar is DELIBERATELY HIGHER than the deal-file ratchet (20 vs 10):
 * a social post is outward-facing brand surface. And a grant loosens
 * ONLY the human-approval queue — the legal/content gates are untouched
 * by construction: the Fair-Housing dispatch backstop, consent gates,
 * and the platform circuit-breaker all still run on every send, and the
 * Campaign Orchestrator's autonomy POSTURE (approval_required — broker
 * override, eval probation, or platform halt) OVERRIDES any grant.
 *
 * Same proposal signal (autonomy_ratchet_proposal), same feed buttons,
 * same broker-only resolution, same policy ledger — one trust system,
 * two domains. The evidence math is PURE.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

/** Outward-facing brand surface — a higher bar than the deal-file ratchet's 10. */
export const MARKETING_RATCHET_MIN_APPROVALS = 20

export const socialShapeKey = (postType: string): string => `social_post:${postType}`

export interface SocialDecisionRow {
  post_type: string | null
  approval_status: string | null
  approved_by: string | null
  ai_generated: boolean | null
}

export interface SocialShapeStats {
  shape: string
  postType: string
  approvals: number
  rejections: number
}

/** PURE: aggregate the queue's HUMAN decisions on AI-staged posts into
 *  per-shape stats. Only ai_generated rows count (a human approving their
 *  own hand-written post proves nothing about the AI); an approval needs a
 *  named approver; a rejection counts regardless (the reject action doesn't
 *  stamp approved_by — the status itself is the human act). */
export function computeSocialShapeStats(rows: SocialDecisionRow[]): SocialShapeStats[] {
  const byShape = new Map<string, SocialShapeStats>()
  for (const r of rows) {
    if (!r.ai_generated) continue
    const postType = (r.post_type ?? "").trim()
    if (!postType) continue
    const approved = r.approval_status === "approved" && !!r.approved_by
    const rejected = r.approval_status === "rejected"
    if (!approved && !rejected) continue
    const key = socialShapeKey(postType)
    const s = byShape.get(key) ?? { shape: key, postType, approvals: 0, rejections: 0 }
    if (approved) s.approvals++
    else s.rejections++
    byShape.set(key, s)
  }
  return [...byShape.values()]
}

/** PURE: does this shape's history earn a grant proposal? One rejection
 *  resets trust — the broker's brand judgment differs somewhere. */
export function decideMarketingRatchet(stats: SocialShapeStats): boolean {
  return stats.rejections === 0 && stats.approvals >= MARKETING_RATCHET_MIN_APPROVALS
}

export interface MarketingRatchetSweepResult {
  shapesQualified: number
  proposed: number
}

/** The periodic sweep — rides the social-cadence cron (no new cron). */
export async function runMarketingRatchetSweep(
  svc: Svc,
  input: { brokerageId: string },
): Promise<MarketingRatchetSweepResult> {
  const out: MarketingRatchetSweepResult = { shapesQualified: 0, proposed: 0 }

  const { data: rows } = await svc
    .from("social_posts")
    .select("post_type, approval_status, approved_by, ai_generated")
    .eq("brokerage_id", input.brokerageId)
    .eq("ai_generated", true)
    .in("approval_status", ["approved", "rejected"])
    .order("created_at", { ascending: false })
    .limit(2000)

  const stats = computeSocialShapeStats((rows ?? []) as SocialDecisionRow[])

  // NEWSLETTER + BLOG lanes — same bar, same proposal. These tables carry no
  // approved_by column, but on AI-staged rows (is_ai_generated=true) the ONLY
  // writer of approval_status='approved'/'rejected' is the admin-gated
  // approval action — human by rail construction.
  const laneShapes: SocialShapeStats[] = []
  for (const lane of [
    { table: "newsletter_campaigns", shape: "newsletter:default", postType: "newsletter" },
    { table: "blog_posts", shape: "blog:default", postType: "blog" },
  ]) {
    const { data: laneRows } = await svc
      .from(lane.table)
      .select("approval_status")
      .eq("brokerage_id", input.brokerageId)
      .eq("is_ai_generated", true)
      .in("approval_status", ["approved", "rejected"])
      .order("created_at", { ascending: false })
      .limit(2000)
    let approvals = 0, rejections = 0
    for (const r of ((laneRows ?? []) as Array<{ approval_status: string | null }>)) {
      if (r.approval_status === "approved") approvals++
      else if (r.approval_status === "rejected") rejections++
    }
    if (approvals + rejections > 0) laneShapes.push({ shape: lane.shape, postType: lane.postType, approvals, rejections })
  }

  const { loadMarketingGrants } = await import("@/lib/documents/autonomy-ratchet")
  const granted = await loadMarketingGrants(svc, input.brokerageId)

  for (const s of [...stats, ...laneShapes]) {
    if (!decideMarketingRatchet(s)) continue
    if (granted.has(s.shape)) continue
    out.shapesQualified++

    // A declined/unactioned proposal inside 30 days stands — don't re-ask.
    const dedupSince = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const { data: dup } = await svc.from("manager_signals")
      .select("id")
      .eq("brokerage_id", input.brokerageId)
      .eq("signal_type", "autonomy_ratchet_proposal")
      .contains("payload", { shape: s.shape })
      .gte("created_at", dedupSince)
      .limit(1)
      .maybeSingle()
    if (dup) continue

    const laneLabel = s.shape.startsWith("social_post:")
      ? `${s.postType.replace(/_/g, " ")} social posts`
      : s.shape.startsWith("newsletter:") ? "newsletters" : "blog posts"
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const sig = await publishManagerSignal({
      brokerageId: input.brokerageId,
      fromManager: "campaign_orchestrator",
      toManager: "compliance_officer",
      signalType: "autonomy_ratchet_proposal",
      message: `Earned autonomy: you've approved ${s.approvals} of ${s.approvals} AI-staged ${laneLabel} — zero rejections. Grant the Campaign Orchestrator this one content type and it publishes on schedule without the queue (Fair Housing and every dispatch gate still run on every send; revoke any time).`,
      payload: { shape: s.shape, mode: "marketing", post_type: s.postType, approvals: s.approvals, declines: s.rejections },
      dedupe: false, // entity-less — the payload-contains check above is the dedupe
    }, svc)
    if (sig.ok) out.proposed++
  }

  return out
}
