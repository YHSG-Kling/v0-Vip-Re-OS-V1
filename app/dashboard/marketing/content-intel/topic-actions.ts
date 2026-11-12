"use server"
/**
 * app/dashboard/marketing/content-intel/topic-actions.ts — THE TOPIC BANK'S SESSION DOORS (wave 145, lane 145G).
 *
 * Every export is a public endpoint (CLAUDE.md §4): async, the tenant from the SESSION (getAgentContext), never a parameter.
 *   · listTopicIntelligenceAction — the tenant's intelligence + local-fact topics with the evidence ruling 22 requires (source,
 *     timestamp, accessible engagement evidence + its basis, confidence) and where each stands in the ONE approval queue;
 *   · publishCommunityVideoAction — the community / event video door (lib/video/community-video-publish.ts);
 *   · stageTopicTvSpotAction — contract C5: an APPROVED topic + its creative → the Ads Manager's TV staging (a DRAFT; the
 *     launch keeps its own approval) (lib/marketing/ctv-lane.ts).
 * The two doors are the operational admin roster's (TENANT_ADMIN_USER_TYPES — a public broadcast and a TV draft are tenant
 * decisions); the list is readable by any member of the tenant.
 */
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createServiceClient } from "@/lib/supabase/service"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"

interface TopicIntelligenceRow {
  id: string
  title: string
  angle: string | null
  sourceClass: string
  source: string
  observedAt: string | null
  engagementBasis: string
  engagement: Record<string, number>
  confidence: number | null
  feeds: string[]
  sourceUrl: string | null
  expiresAt: string | null
  ideaStatus: string | null
  tvStatus: string | null
  /** For a TV-suited topic: the ONLY claims a spot made from it may make (its facts, with source + date) — what the person
   *  approving the TV topic is approving (lib/marketing/ctv-lane.ts tvSpotBriefFromTopic). Null = not a TV topic. */
  tvClaims: string[] | null
}

export async function listTopicIntelligenceAction(): Promise<{ success: true; topics: TopicIntelligenceRow[] } | { success: false; error: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId) return { success: false, error: "Not authenticated" }
    const svc = createServiceClient()
    const { data, error } = await svc.from("content_topic_bank")
      .select("id, topic_title, value_angle, categories, source_url, expires_at, scraped_at, raw_data")
      .eq("brokerage_id", ctx.brokerageId).overlaps("categories", ["topic_intelligence", "local_intel"])
      .gt("expires_at", new Date().toISOString()).order("scraped_at", { ascending: false }).limit(100)
    if (error) return { success: false, error: `The topic bank could not be read: ${error.message}` }
    const rows = (data ?? []) as Array<{ id: string; topic_title: string; value_angle: string | null; categories: string[] | null; source_url: string | null; expires_at: string | null; scraped_at: string | null; raw_data: Record<string, any> | null }>
    const { TOPIC_CAMPAIGN_IDEA_ITEM_TYPE } = await import("@/lib/content-intel/topic-intelligence")
    const { LOCAL_CAMPAIGN_IDEA_ITEM_TYPE } = await import("@/lib/content-intel/local-intel")
    const { CTV_TOPIC_ITEM_TYPE, topicSuitsTv, tvSpotBriefFromTopic } = await import("@/lib/marketing/ctv-lane")
    const status = new Map<string, { idea: string | null; tv: string | null }>()
    if (rows.length) {
      const { data: items, error: itemErr } = await svc.from("approval_items").select("item_id, item_type, status")
        .eq("brokerage_id", ctx.brokerageId).in("item_id", rows.map((r) => r.id)).in("item_type", [TOPIC_CAMPAIGN_IDEA_ITEM_TYPE, LOCAL_CAMPAIGN_IDEA_ITEM_TYPE, CTV_TOPIC_ITEM_TYPE])
      if (itemErr) return { success: false, error: `Approval states could not be read: ${itemErr.message}` }
      for (const i of (items ?? []) as Array<{ item_id: string; item_type: string; status: string | null }>) {
        const cur = status.get(i.item_id) ?? { idea: null, tv: null }
        if (i.item_type === CTV_TOPIC_ITEM_TYPE) cur.tv = i.status
        else cur.idea = i.status
        status.set(i.item_id, cur)
      }
    }
    return {
      success: true,
      topics: rows.map((r) => {
        const ev = (r.raw_data?.topic_evidence ?? null) as Record<string, any> | null
        const local = (r.raw_data?.local_fact ?? null) as Record<string, any> | null
        return {
          id: r.id, title: r.topic_title, angle: r.value_angle,
          sourceClass: String(ev?.source_class ?? (local ? `local_${String(local.kind ?? "fact")}` : "topic")),
          source: String(ev?.source ?? local?.publisher ?? local?.provider ?? "—"),
          observedAt: (ev?.observed_at as string | undefined) ?? r.scraped_at,
          engagementBasis: String(ev?.engagement?.basis ?? (local ? "none" : "—")),
          engagement: (ev?.engagement?.metrics ?? {}) as Record<string, number>,
          confidence: typeof ev?.confidence === "number" ? ev.confidence : typeof local?.confidence === "number" ? local.confidence : null,
          feeds: Array.isArray(ev?.feeds) ? (ev?.feeds as string[]) : [],
          sourceUrl: r.source_url, expiresAt: r.expires_at,
          ideaStatus: status.get(r.id)?.idea ?? null, tvStatus: status.get(r.id)?.tv ?? null,
          tvClaims: topicSuitsTv({ categories: r.categories, evidence: ev as never }) ? tvSpotBriefFromTopic({ title: r.topic_title, valueAngle: r.value_angle, evidence: ev as never }).claims : null,
        }
      }),
    }
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? "Failed to load the topic bank" }
  }
}

export async function publishCommunityVideoAction(input: { videoProjectId: string; topicId: string }): Promise<{ success: true; socialPostId: string; alreadyQueued: boolean } | { success: false; error: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId || !ctx.userId) return { success: false, error: "Not authenticated" }
    if (!TENANT_ADMIN_USER_TYPES.has(ctx.userType ?? "")) return { success: false, error: "Publishing a community video is a brokerage administrator's decision." }
    const { publishCommunityVideo } = await import("@/lib/video/community-video-publish")
    const r = await publishCommunityVideo({ brokerageId: ctx.brokerageId, actorUserId: ctx.userId, videoProjectId: String(input?.videoProjectId ?? ""), topicId: String(input?.topicId ?? "") })
    return r.ok ? { success: true, socialPostId: r.socialPostId, alreadyQueued: r.alreadyQueued } : { success: false, error: r.reason }
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? "Failed to publish the community video" }
  }
}

export async function stageTopicTvSpotAction(input: { topicId: string; assetId: string; dailyBudgetCents: number; dmas?: string[]; cities?: string[]; zips?: string[] }): Promise<{ success: true; campaignId: string; warnings: string[] } | { success: false; error: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId || !ctx.userId) return { success: false, error: "Not authenticated" }
    if (!TENANT_ADMIN_USER_TYPES.has(ctx.userType ?? "")) return { success: false, error: "Staging a TV spot is a brokerage administrator's decision." }
    const clean = (xs: unknown) => (Array.isArray(xs) ? xs.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 20) : [])
    const { stageTopicTvSpot } = await import("@/lib/marketing/ctv-lane")
    const r = await stageTopicTvSpot({
      brokerageId: ctx.brokerageId, agentUserId: ctx.userId, topicId: String(input?.topicId ?? ""), assetId: String(input?.assetId ?? ""),
      dailyBudgetCents: Math.round(Number(input?.dailyBudgetCents ?? 0)), targeting: { dmas: clean(input?.dmas), cities: clean(input?.cities), zips: clean(input?.zips) },
    })
    return r.ok ? { success: true, campaignId: r.campaignId, warnings: r.warnings } : { success: false, error: r.reason }
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? "Failed to stage the TV spot" }
  }
}
