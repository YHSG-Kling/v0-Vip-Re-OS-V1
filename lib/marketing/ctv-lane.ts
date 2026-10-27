// lib/marketing/ctv-lane.ts
// ─────────────────────────────────────────────────────────────────────────────
// TV CREATIVE FROM THE TOPIC BANK (wave 145, lane 145G — contract C5; owner rulings 13 + 22: "TV ads derive from the topic
// bank"; "the topic bank … feeds … TV/CTV ads").
//
// NOT A SECOND TV SUBSYSTEM. The ONE streaming-TV path is the Ads Manager's: lib/ads/ctv-campaign.ts stageCtvCampaign (the
// Vibe provider, the TV-master judge, the public-video gate, the launch gate — lane 145D's file, the gateway of contract C5).
// This module is the TOPIC side of the contract and nothing else:
//   1. which topics SUIT a TV spot (the evidence's own `feeds` — a market change, a property-value trend, a high-engagement
//      pattern, the local market) and the BRIEF a spot made from one carries (the claim it may make = the topic's facts);
//   2. a person's approval of a topic FOR TV — filed PENDING in the ONE approval queue (approval_items, item_type
//      CTV_TOPIC_ITEM_TYPE; the gateway's CTV_TOPIC_APPROVAL_ITEM_TYPES reads the same spelling);
//   3. the request: an APPROVED topic id + the creative's asset id → the gateway's { topicId, assetId } — checked here first
//      (approved by a person, the creative made FROM that topic, a public approved video, the humanized final recorded) so a
//      refusal names its reason before anything is staged; the gateway re-checks the approval itself (it owns the gate).
//   4. the evidence: the TV spot claims the topic in content_topic_uses (asset_type 'ctv_ad', m866) and the request leaves a
//      ledger row (who asked, which topic, which creative, what the gateway answered).
// Nothing here spends, uploads or launches: staging is a draft; the launch stays the gateway's human-approved step.
//
// Not server-only: scripts/content-distribution-guard.ts drives it on an in-memory client with the gateway as a seam.

import { finalizeForDistribution, resolveTenantBrandForFinal, stageDistributionFinal, type TenantBrandForFinal } from "./humanize-final"
import { LOCAL_CAMPAIGN_IDEA_ITEM_TYPE } from "@/lib/content-intel/local-intel"
import type { TopicEvidence } from "@/lib/content-intel/topic-themes"

type Db = { from: (table: string) => any }

/** approval_items.item_type: "a person approved this topic for a TV spot" (item_id = content_topic_bank.id). */
export const CTV_TOPIC_ITEM_TYPE = "ctv_topic"
/** The approvals that admit a topic to TV: the TV approval itself, and a local fact's approved campaign idea (its brief names a 30-60 s video). */
export const CTV_TOPIC_APPROVAL_TYPES = [CTV_TOPIC_ITEM_TYPE, LOCAL_CAMPAIGN_IDEA_ITEM_TYPE] as const

/** PURE. Does a topic suit a broadcast spot? Its evidence names TV among what it can become, or it is a local-market fact. */
export function topicSuitsTv(t: { categories?: readonly string[] | null; evidence?: Pick<TopicEvidence, "feeds" | "source_class"> | null }): boolean {
  if (t.evidence?.feeds?.includes("ctv_ad")) return true
  const cats = t.categories ?? []
  return cats.includes("local_intel") || cats.includes("market_change") || cats.includes("property_value_trend")
}

/**
 * PURE. The brief a TV spot made from this topic carries — the ONE claim it may make is the topic's own facts (with their
 * source and date), the spec is the TV-master judge's (lib/video/tv-spot.ts — 15 / 30 s, captions, loudness), the approved
 * tagline goes on the END CARD (the final phase renders it), housing-ad rules apply (no audience by protected class; the
 * Ads Manager's special-ad-category targeting), and nothing from a competitor's creative is reused. No result is promised.
 */
export function tvSpotBriefFromTopic(topic: { title: string; valueAngle?: string | null; evidence?: Pick<TopicEvidence, "facts" | "source" | "observed_at"> | null }): { headline: string; claims: string[]; directions: string[] } {
  const claims = (topic.evidence?.facts ?? []).slice(0, 3)
  return {
    headline: topic.title.slice(0, 120),
    claims,
    directions: [
      "A 15- or 30-second spot; the TV master is judged by lib/video/tv-spot.ts (aspect, duration, loudness, captions) before any launch.",
      claims.length ? `State only these facts, with their source and date on screen: ${claims.join("; ")}.` : "State no figure: this topic carries no verified fact, so the spot speaks to the question, not a statistic.",
      "End card: the brand's logo and APPROVED tagline (the final personalization phase vets it), the brokerage name and the licence line.",
      "Housing advertising: describe the place and the service, never who should live there; audiences follow the Ads Manager's special-ad-category rules.",
      "Original words and footage — never a competitor's headline, copy, images or offer. No sales, ranking or viewership result is promised.",
    ],
  }
}

/** The latest decision on a topic for TV (a later rejection revokes an earlier approval; a pending item decides nothing). */
async function readTvTopicApproval(db: Db, brokerageId: string, topicId: string): Promise<{ approved: boolean; reason: string; approvedBy: string | null; approvedAt: string | null; error: string | null }> {
  if (!brokerageId || !topicId) return { approved: false, reason: "a tenant and a topic are required", approvedBy: null, approvedAt: null, error: null }
  const { data, error } = await db.from("approval_items").select("id, item_type, status, reviewed_by, reviewed_at, submitted_at")
    .eq("brokerage_id", brokerageId).eq("item_id", topicId).in("item_type", [...CTV_TOPIC_APPROVAL_TYPES]).limit(50)
  if (error) return { approved: false, reason: "approval unreadable", approvedBy: null, approvedAt: null, error: `approval_items read refused: ${error.message ?? "unknown"}` }
  type Row = { status: string | null; reviewed_by: string | null; reviewed_at: string | null; submitted_at: string | null }
  const at = (r: Row) => Date.parse(r.reviewed_at ?? r.submitted_at ?? "") || 0
  const decided = ((data ?? []) as Row[]).filter((r) => r.status === "approved" || r.status === "rejected").sort((a, b) => at(b) - at(a))
  const latest = decided[0]
  if (!latest) return { approved: false, reason: ((data ?? []) as Row[]).length ? "the TV approval for this topic is still pending" : "no person has approved this topic for TV", approvedBy: null, approvedAt: null, error: null }
  if (latest.status !== "approved") return { approved: false, reason: "the latest decision on this topic for TV is a rejection", approvedBy: null, approvedAt: null, error: null }
  return { approved: true, reason: "approved", approvedBy: latest.reviewed_by ?? null, approvedAt: latest.reviewed_at ?? null, error: null }
}

/**
 * File a topic for a person's TV approval (PENDING in the ONE approval queue). Idempotent per topic: a topic that already has a
 * TV item — pending, approved or rejected — is never re-filed. Only a topic that suits TV is filed. Counted insert; never throws.
 */
export async function proposeCtvTopic(db: Db, brokerageId: string, topic: { id: string; title: string; valueAngle?: string | null; categories?: readonly string[] | null; evidence?: TopicEvidence | null }, opts: { now?: Date } = {}): Promise<{ proposed: boolean; reason: string; error: string | null }> {
  try {
    if (!topicSuitsTv(topic)) return { proposed: false, reason: "the topic does not suit a TV spot", error: null }
    const { data: prior, error: priorErr } = await db.from("approval_items").select("id")
      .eq("brokerage_id", brokerageId).eq("item_type", CTV_TOPIC_ITEM_TYPE).eq("item_id", topic.id).limit(1)
    if (priorErr) return { proposed: false, reason: "approval unreadable", error: `approval_items read refused: ${priorErr.message ?? "unknown"}` }
    if ((prior ?? []).length > 0) return { proposed: false, reason: "already filed for TV approval", error: null }
    const brief = tvSpotBriefFromTopic({ title: topic.title, valueAngle: topic.valueAngle ?? null, evidence: topic.evidence ?? null })
    const { data, error } = await db.from("approval_items").insert({
      brokerage_id: brokerageId, agent_id: null, item_type: CTV_TOPIC_ITEM_TYPE, item_id: topic.id, status: "pending",
      submitted_at: (opts.now ?? new Date()).toISOString(),
      review_notes: JSON.stringify({ violations: [], excerpt: `TV spot from the topic "${brief.headline}". ${brief.directions[1]} Approving lets the Ads Manager stage a DRAFT streaming-TV campaign from it; the budget and the launch are approved separately.`.slice(0, 500) }),
    }).select("id")
    if (error || (data ?? []).length !== 1) return { proposed: false, reason: "not filed", error: `approval_items insert refused: ${error?.message ?? "no row"}` }
    return { proposed: true, reason: "filed for TV approval", error: null }
  } catch (e) {
    return { proposed: false, reason: "threw", error: `proposeCtvTopic threw: ${(e as Error)?.message ?? String(e)}` }
  }
}

/** The gateway request of contract C5 (lane 145D's lib/ads/ctv-campaign.ts stageCtvCampaign accepts it). */
export interface CtvGatewayInput {
  brokerageId: string
  agentUserId: string
  topicId: string
  assetId: string
  /** The pre-C5 name of the same creative (the gateway checks they agree). */
  videoProjectId: string
  campaignName?: string
  dailyBudgetCents: number
  targeting: { dmas?: string[]; cities?: string[]; zips?: string[] }
  client?: unknown
}
export type CtvGateway = (input: CtvGatewayInput) => Promise<{ success: boolean; error?: string; package?: { campaignId: string; warnings?: string[] } }>

/** THE ONE GATEWAY (lane 145D): the Ads Manager's streaming-TV staging. Lazy — the proof hands a seam. */
const defaultGateway: CtvGateway = async (input) => {
  const mod = await import("@/lib/ads/ctv-campaign")
  return mod.stageCtvCampaign(input as unknown as Parameters<typeof mod.stageCtvCampaign>[0])
}

export interface StageTopicTvSpotInput {
  /** The VERIFIED tenant (session) — never a request body. */
  brokerageId: string
  /** users.id of the requester (the ledger actor; the gateway's agentUserId). */
  agentUserId: string
  topicId: string
  /** ai_video_projects.id of the creative made FROM the topic. */
  assetId: string
  dailyBudgetCents: number
  targeting: { dmas?: string[]; cities?: string[]; zips?: string[] }
  campaignName?: string
}

export interface StageTopicTvSpotDeps {
  client?: Db
  gateway?: CtvGateway
  brand?: (db: Db, a: { brokerageId: string; agentUserId: string }) => Promise<TenantBrandForFinal>
  logUse?: (a: { topicIds: string[]; brokerageId: string; assetId: string }) => Promise<void | { error: string | null }>
  ledger?: boolean
  now?: Date
}

export type StageTopicTvSpotResult =
  | { ok: true; campaignId: string; finalId: string; brief: ReturnType<typeof tvSpotBriefFromTopic>; warnings: string[]; package?: unknown }
  | { ok: false; reason: string }

/**
 * contract C5 — an APPROVED topic + its creative → the Ads Manager's TV staging (a DRAFT; nothing launches here). Every check
 * refuses with its reason and writes nothing: the topic approved for TV by a person (latest decision), still in the tenant's
 * pool; the creative is this tenant's PUBLIC approved video made FROM the topic (the content_topic_uses claim its producer wrote);
 * its script passes the final personalization phase (recorded as the version the human's video approval covers).
 */
export async function stageTopicTvSpot(input: StageTopicTvSpotInput, deps: StageTopicTvSpotDeps = {}): Promise<StageTopicTvSpotResult> {
  try {
    if (!input.brokerageId || !input.agentUserId || !input.topicId || !input.assetId) return { ok: false, reason: "tenant, requester, topic and creative are required" }
    if (!(input.dailyBudgetCents > 0)) return { ok: false, reason: "a daily budget is required (the launch still needs its own approval)" }
    const db = (deps.client ?? ((await import("@/lib/supabase/service")).createServiceClient() as unknown as Db))
    const now = deps.now ?? new Date()

    // 1 · the topic: approved FOR TV by a person, and still in this tenant's pool.
    const approval = await readTvTopicApproval(db, input.brokerageId, input.topicId)
    if (approval.error) return { ok: false, reason: approval.error }
    if (!approval.approved) return { ok: false, reason: `topic not approved for TV — ${approval.reason}` }
    const { data: topicRow, error: topicErr } = await db.from("content_topic_bank").select("id, brokerage_id, topic_title, value_angle, categories, status, expires_at, raw_data")
      .eq("id", input.topicId).or(`brokerage_id.is.null,brokerage_id.eq.${input.brokerageId}`).maybeSingle()
    if (topicErr) return { ok: false, reason: `content_topic_bank read refused: ${topicErr.message ?? "unknown"}` }
    const topic = topicRow as { id: string; topic_title: string; value_angle: string | null; categories: string[] | null; status: string | null; expires_at: string | null; raw_data: { topic_evidence?: TopicEvidence } | null } | null
    if (!topic) return { ok: false, reason: "the topic is not in this tenant's pool" }
    if (topic.status === "rejected") return { ok: false, reason: "the topic was rejected in the topic bank" }
    const warnings: string[] = []
    if (topic.expires_at && Date.parse(topic.expires_at) < now.getTime()) warnings.push(`the topic's freshness window ended ${topic.expires_at.slice(0, 10)} — confirm its facts still hold before launch`)

    // 2 · the creative: this tenant's video, made FROM the topic, public + approved by a person.
    const { data: vid, error: vidErr } = await db.from("ai_video_projects")
      .select("id, brokerage_id, title, script_content, video_type, audience_type, usage_intent, contact_id, learning_module_id, approval_status, approved_by, approved_at, status, compliance_status, video_url, video_metadata")
      .eq("id", input.assetId).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (vidErr) return { ok: false, reason: `ai_video_projects read refused: ${vidErr.message ?? "unknown"}` }
    const v = vid as Record<string, any> | null
    if (!v) return { ok: false, reason: "the creative is not a video of this brokerage" }
    const { classifyPublicVideo } = await import("@/lib/video/public-video")
    const verdict = classifyPublicVideo(v)
    if (!verdict.public) return { ok: false, reason: `the creative is not an approved public marketing video (${verdict.reason})` }
    // MADE FROM THE TOPIC: the topic claim the producer wrote when it made the creative (content_topic_uses — the topic video
    // runner, the content creators); the one link the OS records between a topic and an asset.
    const { data: uses, error: useErr } = await db.from("content_topic_uses").select("id").eq("brokerage_id", input.brokerageId).eq("topic_id", input.topicId).eq("asset_id", input.assetId).limit(1)
    if (useErr) return { ok: false, reason: `content_topic_uses read refused: ${useErr.message ?? "unknown"}` }
    if ((uses ?? []).length === 0) return { ok: false, reason: "the creative was not made from this topic (no topic claim links them) — make the spot from the topic first (ruling 13: TV ads derive from the topic bank)" }

    // 3 · the final personalization phase on the spot's words — recorded as the version the human's video approval covers.
    const brandOf = deps.brand ?? (async (d: Db, a: { brokerageId: string; agentUserId: string }) => (await resolveTenantBrandForFinal(d, { brokerageId: a.brokerageId, agentUserId: a.agentUserId })).brand)
    const brand = await brandOf(db, input).catch(() => ({} as TenantBrandForFinal))
    const script = String(v.script_content ?? v.title ?? "").trim()
    if (!script) return { ok: false, reason: "the creative has no script to finalise" }
    const final = await finalizeForDistribution({ assetKind: "ctv_ad", text: script, tenantBrand: brand, facts: topic.raw_data?.topic_evidence?.facts ?? [] })
    if (final.fairHousing.length || final.brandVoice.prohibited.length) return { ok: false, reason: `the spot's words carry what no approval waives — ${[...final.fairHousing, ...final.brandVoice.prohibited.map((w) => `prohibited "${w}"`)].join("; ")}` }
    const staged = await stageDistributionFinal(db, {
      brokerageId: input.brokerageId, assetTable: "ai_video_projects", assetId: input.assetId, final, createdBy: input.agentUserId, notifyUserId: null,
      derivedFromApproval: { by: (v.approved_by as string | null) ?? null, at: (v.approved_at as string | null) ?? null }, now,
    })
    if (!staged.ok) return { ok: false, reason: `the humanized final was not recorded — nothing staged: ${staged.error}` }
    if (final.blockers.length) warnings.push(`accepted with the video's approval: ${final.blockers.slice(0, 3).join("; ")}`)

    // 4 · the ONE gateway (the Ads Manager), under ledger evidence.
    const brief = tvSpotBriefFromTopic({ title: topic.topic_title, valueAngle: topic.value_angle, evidence: topic.raw_data?.topic_evidence ?? null })
    const gwInput: CtvGatewayInput = {
      brokerageId: input.brokerageId, agentUserId: input.agentUserId, topicId: input.topicId, assetId: input.assetId, videoProjectId: input.assetId,
      campaignName: input.campaignName ?? `TV — ${topic.topic_title}`.slice(0, 120), dailyBudgetCents: input.dailyBudgetCents, targeting: input.targeting, client: deps.client,
    }
    const call = () => (deps.gateway ?? defaultGateway)(gwInput)
    let res: Awaited<ReturnType<CtvGateway>>
    if (deps.ledger === false) res = await call()
    else {
      const { withActionLedger } = await import("@/lib/kernel/action-ledger")
      res = await withActionLedger<Awaited<ReturnType<CtvGateway>>>(
        {
          brokerageId: input.brokerageId, action: "marketing.ctv.topic_spot_stage", actor: { type: "user", userId: input.agentUserId },
          subject: { type: "content_topic", id: input.topicId }, reasonCode: "HUMAN_REQUESTED",
          reasonDetail: `TV spot staged from the approved topic "${topic.topic_title}" with creative ${input.assetId}`, riskClass: "LOW_RISK_WRITE", systemSource: "ctv_lane",
          detail: { topic_id: input.topicId, asset_id: input.assetId, approved_by: approval.approvedBy, approved_at: approval.approvedAt, final_id: staged.finalId, daily_budget_cents: input.dailyBudgetCents },
        },
        call,
        { settle: (r) => (r.success ? { status: "executed", outcome: "ctv_draft_staged", providerRef: r.package?.campaignId ?? null } : { status: "failed", outcome: "gateway_refused", error: r.error ?? null }), replay: () => ({ success: false, error: "already staged (ledger replay)" }) },
        { client: db as never },
      )
    }
    if (!res.success || !res.package?.campaignId) return { ok: false, reason: `the Ads Manager refused the spot: ${res.error ?? "no campaign returned"}` }

    // 5 · the spot claims its topic (the performance loop reads uses; asset_type 'ctv_ad' — m866).
    // A refused claim (before m866 widens the CHECK, 'ctv_ad' is refused) is REPORTED on the result — the spot is staged
    // either way (the gateway already wrote it), but "claimed" never renders when it was not.
    const logUse = deps.logUse ?? (async (a) => {
      const { logTopicUses } = await import("@/lib/content-intel/performance-aggregator")
      return logTopicUses({ topicIds: a.topicIds, brokerageId: a.brokerageId, assetType: "ctv_ad", assetId: a.assetId })
    })
    try {
      const claimed = await logUse({ topicIds: [input.topicId], brokerageId: input.brokerageId, assetId: res.package.campaignId })
      if (claimed && claimed.error) warnings.push(`topic claim not recorded: ${claimed.error}`)
    } catch (e) {
      warnings.push(`topic claim not recorded: ${(e as Error)?.message ?? String(e)}`)
    }
    // `package` = the gateway's own launch package, handed through so the Ads screen's action (app/actions/ctv-ads.ts) shows
    // exactly what the Ads Manager staged (wave 145, lane 145Z — lane 145G Outside-lane 1).
    return { ok: true, campaignId: res.package.campaignId, finalId: staged.finalId, brief, warnings: [...warnings, ...(res.package.warnings ?? [])], package: res.package }
  } catch (e) {
    return { ok: false, reason: `stageTopicTvSpot threw: ${(e as Error)?.message ?? String(e)}` }
  }
}
