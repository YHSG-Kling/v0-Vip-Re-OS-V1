/**
 * lib/kernel/reporting-autonomy.ts
 *
 * THE KPI KERNEL's new columns — program item #1 (owner-approved): the
 * numbers no competitor can show, EXTENDING the existing reporting kernel
 * (lib/kernel/reporting.ts + reporting-scope.ts) rather than adding a
 * fifth dashboard engine (keep-one: same ReportingActorContext, same
 * narrowReportAgentIds tier ladder — brokerage / location / team / agent).
 *
 *  1. AUTONOMY IMPACT — "what the OS did, measured": assets produced and
 *     delivered, AI drafts written vs sent, decision PROVENANCE (how often
 *     creative ran on the tenant's own learned evidence vs proven norms vs
 *     fallback — read from the generated_from / content_kit.built_by
 *     fields every producer records), and marketing-attributed credit
 *     dollars from the attribution ledger. Every number traces to rows.
 *
 *  2. COACHING SIGNALS — the broker-coaching layer the 2026 audit called
 *     for: median first-response time to new contacts, follow-up gaps
 *     (active contacts gone quiet), and at-risk/missed transaction
 *     deadlines — computed from the activities and deadlines ledgers, not
 *     self-reported.
 *
 *  3. composeKpiNarrative — the pure storyline the tenant's ASSISTANT
 *     presents (the report-video rail consumes narrative lines, not
 *     tables). Honest by construction: zero-activity windows say so.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { narrowReportAgentIds, type EgressScopeKind } from "./reporting-scope"
import type { ReportingActorContext, KernelReportingResult } from "./reporting"

type Svc = ReturnType<typeof createServiceClient>

// ── Scope resolution (shared by both generators) ─────────────────────────────

/** Resolve the actor's tier + the agent ids their reports may see.
 *  null agentIds ⇒ whole brokerage (broker tier). */
async function resolveScope(
  svc: Svc,
  ctx: ReportingActorContext,
): Promise<{ tier: EgressScopeKind; agentIds: string[] | null; agentUserIds: string[] | null }> {
  const tier: EgressScopeKind =
    ctx.userType === "broker" || ctx.userType === "admin" ? "brokerage"
    : ctx.teamId ? "team"
    : ctx.locationId ? "location"
    : "agent"
  let memberAgentIds: string[] = []
  if (tier === "team" && ctx.teamId) {
    const { data } = await svc.from("agents").select("id, user_id")
      .eq("brokerage_id", ctx.brokerageId).eq("team_id", ctx.teamId)
    memberAgentIds = ((data ?? []) as Array<{ id: string }>).map((a) => a.id)
    const agentIds = narrowReportAgentIds(tier, ctx.agentId, memberAgentIds)
    const userIds = ((data ?? []) as Array<{ user_id: string | null }>).map((a) => a.user_id).filter(Boolean) as string[]
    return { tier, agentIds, agentUserIds: userIds }
  }
  if (tier === "location" && ctx.locationId) {
    const { data } = await svc.from("agents").select("id, user_id")
      .eq("brokerage_id", ctx.brokerageId).eq("location_id", ctx.locationId)
    memberAgentIds = ((data ?? []) as Array<{ id: string }>).map((a) => a.id)
    const agentIds = narrowReportAgentIds(tier, ctx.agentId, memberAgentIds)
    const userIds = ((data ?? []) as Array<{ user_id: string | null }>).map((a) => a.user_id).filter(Boolean) as string[]
    return { tier, agentIds, agentUserIds: userIds }
  }
  if (tier === "agent") {
    const { data } = await svc.from("agents").select("user_id").eq("id", ctx.agentId).maybeSingle()
    return {
      tier,
      agentIds: narrowReportAgentIds(tier, ctx.agentId, []),
      agentUserIds: (data as any)?.user_id ? [(data as any).user_id] : [ctx.userId],
    }
  }
  return { tier, agentIds: null, agentUserIds: null }
}

// ── 1. AUTONOMY IMPACT ───────────────────────────────────────────────────────

export interface AutonomyImpactReport {
  tier: EgressScopeKind
  window: { from: string; to: string }
  assets: {
    videosProduced: number
    rendersProduced: number
    documentsProduced: number
    socialPostsPublished: number
  }
  aiLane: {
    draftsWritten: number
    draftsSent: number
    /** drafts the human sent ÷ drafts written — the trust ratio. */
    draftAdoptionRate: number | null
  }
  provenance: {
    /** creative conditioned on the tenant's OWN learned evidence. */
    learned: number
    /** proven norms / deterministic rails. */
    norm: number
    /** fact-built fallback (generator or gate unreachable). */
    fallback: number
    /** learned ÷ total — "ran on your own evidence" share. */
    learnedShare: number | null
  }
  attribution: {
    creditDollars: number
    creditedTransactions: number
  }
}

export async function generateAutonomyImpactReport(input: {
  ctx: ReportingActorContext
  dateFrom?: string
  dateTo?: string
}): Promise<KernelReportingResult<AutonomyImpactReport>> {
  try {
    const svc = createServiceClient()
    const { ctx } = input
    const from = input.dateFrom ?? new Date(Date.now() - 30 * 86_400_000).toISOString()
    const to = input.dateTo ?? new Date().toISOString()
    const { tier, agentUserIds } = await resolveScope(svc, ctx)

    const scopedByUser = <T extends { in: any; eq: any }>(q: T, col: string): T => {
      if (agentUserIds) return q.in(col, agentUserIds)
      return q
    }

    // Assets produced — the four production ledgers
    const [videos, renders, docs, posts] = await Promise.all([
      scopedByUser(
        svc.from("ai_video_projects").select("id", { count: "exact", head: true })
          .eq("brokerage_id", ctx.brokerageId).eq("status", "completed")
          .gte("created_at", from).lte("created_at", to) as any, "agent_id",
      ),
      scopedByUser(
        svc.from("remotion_composition_renders").select("id", { count: "exact", head: true })
          .eq("brokerage_id", ctx.brokerageId).eq("render_status", "succeeded")
          .gte("created_at", from).lte("created_at", to) as any, "agent_user_id",
      ),
      svc.from("generated_documents").select("id", { count: "exact", head: true })
        .eq("brokerage_id", ctx.brokerageId).gte("created_at", from).lte("created_at", to),
      scopedByUser(
        svc.from("social_posts").select("id", { count: "exact", head: true })
          .eq("brokerage_id", ctx.brokerageId).eq("status", "published")
          .gte("published_at", from).lte("published_at", to) as any, "user_id",
      ),
    ])

    // AI lane — drafts written vs acted on (ai_message_drafts: sent_message_id set = sent)
    const draftsBase = () => scopedByUser(
      svc.from("ai_message_drafts").select("id", { count: "exact", head: true })
        .eq("brokerage_id", ctx.brokerageId).gte("created_at", from).lte("created_at", to) as any,
      "agent_user_id",
    )
    const [{ count: draftsWritten }, { count: draftsSent }] = await Promise.all([
      draftsBase(),
      draftsBase().not("sent_message_id", "is", null),
    ])

    // Decision provenance — read from the fields every producer records
    const { data: creatives } = await svc.from("ad_creative_variations")
      .select("generated_from").eq("brokerage_id", ctx.brokerageId)
      .gte("created_at", from).lte("created_at", to).limit(2000)
    const { data: kitVideos } = await svc.from("ai_video_projects")
      .select("video_metadata").eq("brokerage_id", ctx.brokerageId)
      .gte("created_at", from).lte("created_at", to).not("video_metadata", "is", null).limit(2000)
    let learned = 0, norm = 0, fallback = 0
    for (const c of ((creatives ?? []) as Array<{ generated_from: string | null }>)) {
      const g = c.generated_from ?? ""
      if (g.startsWith("learned:")) learned++
      else norm++
    }
    for (const v of ((kitVideos ?? []) as Array<{ video_metadata: any }>)) {
      const b = v.video_metadata?.content_kit?.built_by
      if (b === "ai") norm++
      else if (b === "fallback") fallback++
    }
    const provTotal = learned + norm + fallback

    // Attribution — the measured marketing credit ledger
    const { data: credits } = await svc.from("marketing_attribution_credits")
      .select("credit_dollars, transaction_id")
      .eq("brokerage_id", ctx.brokerageId).gte("created_at", from).lte("created_at", to).limit(2000)
    const creditRows = (credits ?? []) as Array<{ credit_dollars: number | null; transaction_id: string | null }>

    return {
      success: true,
      data: {
        tier,
        window: { from, to },
        assets: {
          videosProduced: (videos as any).count ?? 0,
          rendersProduced: (renders as any).count ?? 0,
          documentsProduced: docs.count ?? 0,
          socialPostsPublished: (posts as any).count ?? 0,
        },
        aiLane: {
          draftsWritten: draftsWritten ?? 0,
          draftsSent: draftsSent ?? 0,
          draftAdoptionRate: draftsWritten ? Math.round(((draftsSent ?? 0) / draftsWritten) * 100) / 100 : null,
        },
        provenance: {
          learned, norm, fallback,
          learnedShare: provTotal ? Math.round((learned / provTotal) * 100) / 100 : null,
        },
        attribution: {
          creditDollars: Math.round(creditRows.reduce((s, r) => s + (Number(r.credit_dollars) || 0), 0)),
          creditedTransactions: new Set(creditRows.map((r) => r.transaction_id).filter(Boolean)).size,
        },
      },
    }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "autonomy report failed" }
  }
}

// ── 2. COACHING SIGNALS ──────────────────────────────────────────────────────

export interface CoachingSignalsReport {
  tier: EgressScopeKind
  window: { from: string; to: string }
  /** Median minutes from contact creation to the first outbound activity. */
  medianFirstResponseMinutes: number | null
  contactsMeasured: number
  /** Active contacts with no activity in the last 14 days. */
  followUpGaps: number
  deadlines: { atRisk: number; missed: number }
}

/** PURE: median of a number list (exported for the sim). */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export async function generateCoachingSignalsReport(input: {
  ctx: ReportingActorContext
  dateFrom?: string
  dateTo?: string
}): Promise<KernelReportingResult<CoachingSignalsReport>> {
  try {
    const svc = createServiceClient()
    const { ctx } = input
    const from = input.dateFrom ?? new Date(Date.now() - 30 * 86_400_000).toISOString()
    const to = input.dateTo ?? new Date().toISOString()
    const { tier, agentIds } = await resolveScope(svc, ctx)

    // First response: contacts created in window → first activity after creation
    let contactsQ = svc.from("contacts")
      .select("id, created_at, agent_id")
      .eq("brokerage_id", ctx.brokerageId)
      .gte("created_at", from).lte("created_at", to)
      .limit(500)
    if (agentIds) contactsQ = contactsQ.in("agent_id", agentIds)
    const { data: contacts } = await contactsQ
    const contactRows = (contacts ?? []) as Array<{ id: string; created_at: string }>

    const responseMinutes: number[] = []
    if (contactRows.length > 0) {
      const ids = contactRows.map((c) => c.id)
      const { data: acts } = await svc.from("activities")
        .select("contact_id, created_at")
        .eq("brokerage_id", ctx.brokerageId)
        .in("contact_id", ids)
        .order("created_at", { ascending: true })
        .limit(3000)
      const firstByContact = new Map<string, string>()
      for (const a of ((acts ?? []) as Array<{ contact_id: string; created_at: string }>)) {
        if (!firstByContact.has(a.contact_id)) firstByContact.set(a.contact_id, a.created_at)
      }
      for (const c of contactRows) {
        const first = firstByContact.get(c.id)
        if (!first) continue
        const mins = (new Date(first).getTime() - new Date(c.created_at).getTime()) / 60_000
        if (mins >= 0) responseMinutes.push(Math.round(mins))
      }
    }

    // Follow-up gaps: active contacts with no activity in 14 days
    const gapCutoff = new Date(Date.now() - 14 * 86_400_000).toISOString()
    let activeQ = svc.from("contacts")
      .select("id")
      .eq("brokerage_id", ctx.brokerageId).eq("status", "active")
      .limit(1000)
    if (agentIds) activeQ = activeQ.in("agent_id", agentIds)
    const { data: activeContacts } = await activeQ
    const activeIds = ((activeContacts ?? []) as Array<{ id: string }>).map((c) => c.id)
    let followUpGaps = 0
    if (activeIds.length > 0) {
      const { data: recent } = await svc.from("activities")
        .select("contact_id")
        .eq("brokerage_id", ctx.brokerageId)
        .in("contact_id", activeIds)
        .gte("created_at", gapCutoff)
        .limit(5000)
      const touched = new Set(((recent ?? []) as Array<{ contact_id: string }>).map((a) => a.contact_id))
      followUpGaps = activeIds.filter((id) => !touched.has(id)).length
    }

    // Deadlines at risk / missed
    const { data: deadlines } = await svc.from("transaction_deadlines")
      .select("status")
      .eq("brokerage_id", ctx.brokerageId)
      .in("status", ["at_risk", "missed"])
      .limit(1000)
    const dlRows = (deadlines ?? []) as Array<{ status: string }>

    return {
      success: true,
      data: {
        tier,
        window: { from, to },
        medianFirstResponseMinutes: median(responseMinutes),
        contactsMeasured: responseMinutes.length,
        followUpGaps,
        deadlines: {
          atRisk: dlRows.filter((d) => d.status === "at_risk").length,
          missed: dlRows.filter((d) => d.status === "missed").length,
        },
      },
    }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "coaching report failed" }
  }
}

// ── 3. THE NARRATIVE (what the assistant SAYS) ───────────────────────────────

/** PURE: the storyline lines the tenant's assistant presents. Honest by
 *  construction — a quiet window says so instead of inventing momentum. */
export function composeKpiNarrative(
  autonomy: AutonomyImpactReport,
  coaching: CoachingSignalsReport,
): string[] {
  const lines: string[] = []
  const a = autonomy.assets
  const produced = a.videosProduced + a.rendersProduced + a.documentsProduced
  if (produced + a.socialPostsPublished === 0) {
    lines.push("A quiet window on the production side — no finished assets this period.")
  } else {
    lines.push(
      `Your AI team produced ${produced} finished asset${produced === 1 ? "" : "s"} this period` +
      (a.socialPostsPublished ? ` and published ${a.socialPostsPublished} social post${a.socialPostsPublished === 1 ? "" : "s"}.` : "."),
    )
  }
  if (autonomy.aiLane.draftsWritten > 0) {
    const pct = autonomy.aiLane.draftAdoptionRate != null ? Math.round(autonomy.aiLane.draftAdoptionRate * 100) : null
    lines.push(
      `${autonomy.aiLane.draftsWritten} reply draft${autonomy.aiLane.draftsWritten === 1 ? "" : "s"} written` +
      (pct != null ? ` — you sent ${pct}% of them.` : "."),
    )
  }
  if (autonomy.provenance.learnedShare != null) {
    lines.push(
      `${Math.round(autonomy.provenance.learnedShare * 100)}% of creative decisions ran on your own measured results rather than defaults.`,
    )
  }
  if (autonomy.attribution.creditDollars > 0) {
    lines.push(
      `Marketing the OS produced is credited with $${autonomy.attribution.creditDollars.toLocaleString("en-US")} across ${autonomy.attribution.creditedTransactions} transaction${autonomy.attribution.creditedTransactions === 1 ? "" : "s"} — measured by the attribution ledger, not claimed.`,
    )
  }
  if (coaching.medianFirstResponseMinutes != null) {
    lines.push(`Median first response to a new contact: ${coaching.medianFirstResponseMinutes} minutes.`)
  }
  if (coaching.followUpGaps > 0) {
    lines.push(`${coaching.followUpGaps} active contact${coaching.followUpGaps === 1 ? "" : "s"} haven't been touched in two weeks — worth a pass.`)
  }
  if (coaching.deadlines.atRisk + coaching.deadlines.missed > 0) {
    lines.push(`Deadlines: ${coaching.deadlines.atRisk} at risk, ${coaching.deadlines.missed} missed.`)
  }
  return lines
}
