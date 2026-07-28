"use server"

/**
 * Predictive surface data — feeds the Sphere Resonance + Wealth Advisor
 * cards on the agent dashboard. Both backends already exist; this action
 * is the missing surface layer.
 *
 * Sphere Resonance: contacts whose engagement has dropped recently and
 *   need an AI-drafted touchpoint to stay warm.
 *
 * Wealth Advisor: contacts where the AI has detected a refinance,
 *   equity-extraction, downsize, or 1031 opportunity worth surfacing.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { resolveWriteContext } from "@/lib/kernel/identity"
import { WEALTH_ACTIVE_STATUSES } from "@/lib/wealth-advisor/recommendation-status"

// ─── Sphere Resonance ────────────────────────────────────────────────────────

export interface SphereCandidate {
  contactId: string
  contactName: string
  score: number
  daysSinceLastInteraction: number
  touchpointsCount: number
}

export interface SphereSurface {
  candidates: SphereCandidate[]
  totalAtRisk: number
  topRiskName: string | null
}

export async function getSphereResonanceSurface(): Promise<SphereSurface> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.agentId) {
    return { candidates: [], totalAtRisk: 0, topRiskName: null }
  }

  const svc = createServiceClient()

  const { data: scores } = await svc
    .from("sphere_engagement_scores")
    .select("contact_id, score, last_interaction, touchpoints_count")
    .eq("agent_id", ctx.agentId)
    .order("score", { ascending: true })
    .limit(20)

  const rows = scores ?? []
  if (rows.length === 0) {
    return { candidates: [], totalAtRisk: 0, topRiskName: null }
  }

  // Hydrate names for the top 3 to display
  const contactIds = rows.slice(0, 3).map((r: any) => r.contact_id)
  const { data: contacts } = contactIds.length
    ? await svc
        .from("contacts")
        .select("id, first_name, last_name")
        .in("id", contactIds)
    : { data: [] as any[] }

  const nameById = new Map(
    (contacts ?? []).map((c: any) => [
      c.id,
      [c.first_name, c.last_name].filter(Boolean).join(" ") || "Contact",
    ])
  )

  const candidates: SphereCandidate[] = rows.slice(0, 3).map((r: any) => ({
    contactId: r.contact_id,
    contactName: nameById.get(r.contact_id) ?? "Contact",
    score: Number(r.score ?? 0),
    daysSinceLastInteraction: r.last_interaction
      ? Math.floor((Date.now() - new Date(r.last_interaction).getTime()) / 86_400_000)
      : 9999,
    touchpointsCount: r.touchpoints_count ?? 0,
  }))

  // "At risk" = score below 40 OR > 60 days since last interaction
  const totalAtRisk = rows.filter((r: any) => {
    const score = Number(r.score ?? 0)
    const days = r.last_interaction
      ? Math.floor((Date.now() - new Date(r.last_interaction).getTime()) / 86_400_000)
      : 9999
    return score < 40 || days > 60
  }).length

  return {
    candidates,
    totalAtRisk,
    topRiskName: candidates[0]?.contactName ?? null,
  }
}

// ─── Wealth Advisor ──────────────────────────────────────────────────────────

export interface WealthOpportunity {
  id: string
  contactId: string
  contactName: string
  opportunityType: string
  estimatedEquity: number | null
  monthlySavingsEstimate: number | null
  oneTimeProceedsEstimate: number | null
  aiNarrative: string | null
  status: string
}

export interface WealthSurface {
  opportunities: WealthOpportunity[]
  totalOpen: number
  totalPotentialMonthlySavings: number
  topOpportunityType: string | null
}

export async function getWealthAdvisorSurface(): Promise<WealthSurface> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.agentId) {
    return { opportunities: [], totalOpen: 0, totalPotentialMonthlySavings: 0, topOpportunityType: null }
  }

  const svc = createServiceClient()
  const today = new Date().toISOString().slice(0, 10)

  const { data: recs } = await svc
    .from("wealth_advisor_recommendations")
    .select(
      "id, contact_id, opportunity_type, estimated_equity, monthly_savings_estimate, one_time_proceeds_estimate, ai_narrative, status, expires_at"
    )
    .eq("agent_id", ctx.agentId)
    // open | presented | reviewed — the live CHECK vocabulary. This filter used
    // to ask for pending_review/ready_to_push/pushed, none of which the column
    // admits, so the surface was permanently empty.
    .in("status", [...WEALTH_ACTIVE_STATUSES])
    .gte("expires_at", today)
    .order("monthly_savings_estimate", { ascending: false, nullsFirst: false })
    .limit(20)

  const rows = recs ?? []
  if (rows.length === 0) {
    return { opportunities: [], totalOpen: 0, totalPotentialMonthlySavings: 0, topOpportunityType: null }
  }

  const contactIds = Array.from(new Set(rows.map((r: any) => r.contact_id).filter(Boolean)))
  const { data: contacts } = contactIds.length
    ? await svc
        .from("contacts")
        .select("id, first_name, last_name")
        .in("id", contactIds)
    : { data: [] as any[] }

  const nameById = new Map(
    (contacts ?? []).map((c: any) => [
      c.id,
      [c.first_name, c.last_name].filter(Boolean).join(" ") || "Contact",
    ])
  )

  const opportunities: WealthOpportunity[] = rows.slice(0, 3).map((r: any) => ({
    id: r.id,
    contactId: r.contact_id,
    contactName: nameById.get(r.contact_id) ?? "Contact",
    opportunityType: r.opportunity_type,
    estimatedEquity: r.estimated_equity,
    monthlySavingsEstimate: r.monthly_savings_estimate,
    oneTimeProceedsEstimate: r.one_time_proceeds_estimate,
    aiNarrative: r.ai_narrative,
    status: r.status,
  }))

  const totalPotentialMonthlySavings = rows.reduce(
    (s: number, r: any) => s + (Number(r.monthly_savings_estimate) || 0),
    0
  )

  // Most common type as headline (refi vs equity vs downsize vs 1031)
  const typeCounts = rows.reduce((acc: Record<string, number>, r: any) => {
    const t = r.opportunity_type ?? "unknown"
    acc[t] = (acc[t] ?? 0) + 1
    return acc
  }, {})
  const topOpportunityType =
    Object.entries(typeCounts).sort((a, b) => (b[1] as number) - (a[1] as number))[0]?.[0] ?? null

  return {
    opportunities,
    totalOpen: rows.length,
    totalPotentialMonthlySavings,
    topOpportunityType,
  }
}
