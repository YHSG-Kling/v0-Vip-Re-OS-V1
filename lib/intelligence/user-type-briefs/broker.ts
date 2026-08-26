"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"
import type { UserTypeBrief, BriefPriority, BriefMetric } from "./types"

/**
 * Generate broker brief — surfaces critical brokerage-wide items.
 *
 * Data sources (all real, no mocks):
 *   - deal_health_scores filtered by brokerage_id (critical/at_risk)
 *   - users for license expirations approaching (next 60d)
 *   - compliance_events with severity=high (last 7d)
 *   - assignment_log unassigned leads
 *   - ai_isa_calls for ISA performance signals
 *
 * Returns shape from types.ts — caches per-day in ai_daily_briefings keyed
 * by user_id + briefing_date.
 */
export async function generateBrokerBrief(params: {
  userId: string
  brokerageId: string
  forceRegenerate?: boolean
}): Promise<UserTypeBrief> {
  const supabase = createServiceClient()
  const today = new Date().toISOString().slice(0, 10)

  // 1. Cache check
  if (!params.forceRegenerate) {
    const { data: cached } = await supabase
      .from("ai_daily_briefings")
      .select("*")
      .eq("user_id", params.userId)
      .eq("briefing_date", today)
      .maybeSingle()

    if (cached) {
      const c = cached as unknown as {
        agent_id: string
        brokerage_id: string
        briefing_date: string
        summary: string
        top_priority_actions: BriefPriority[]
        market_pulse: string
        generated_at: string
      }
      return {
        userId: c.agent_id,
        userType: "broker",
        brokerageId: c.brokerage_id,
        briefingDate: c.briefing_date,
        summary: c.summary,
        priorities: c.top_priority_actions ?? [],
        metrics: parseMarketPulseMetrics(c.market_pulse),
        generatedAt: c.generated_at,
        cached: true,
      }
    }
  }

  // 2. Pull data in parallel
  const sixtyDaysOut = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [criticalDealsRes, expiringLicensesRes, complianceEventsRes, unassignedLeadsRes, activeAgentsRes] = await Promise.all([
    supabase
      .from("deal_health_scores")
      .select("transaction_id, overall_score, risk_level, score_components, transactions!inner(property_address, brokerage_id)")
      .eq("transactions.brokerage_id", params.brokerageId)
      .in("risk_level", ["critical", "at_risk"])
      .order("overall_score", { ascending: true })
      .limit(10),
    supabase
      .from("agents")
      .select("id, license_expiry, users!inner(first_name, last_name, brokerage_id)")
      .eq("users.brokerage_id", params.brokerageId)
      .lte("license_expiry", sixtyDaysOut)
      .order("license_expiry", { ascending: true })
      .limit(5),
    supabase
      .from("compliance_events")
      .select("id, entity_type, entity_id, gate_name, blocked_reason, created_at")
      .eq("brokerage_id", params.brokerageId)
      .eq("allowed", false)
      .gte("created_at", sevenDaysAgo)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", params.brokerageId)
      .is("agent_id", null)
      .eq("is_active", true),
    supabase
      .from("agents")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", params.brokerageId)
      .eq("is_active", true),
  ])

  const criticalDeals = (criticalDealsRes.data ?? []) as unknown as Array<{
    transaction_id: string
    overall_score: number
    risk_level: string
    score_components: Array<{ category?: string; severity?: string; message?: string }> | null
    transactions: { property_address: string | null }
  }>
  const expiringLicenses = (expiringLicensesRes.data ?? []) as unknown as Array<{
    id: string
    license_expiry: string
    users: { first_name: string | null; last_name: string | null }
  }>
  const complianceEvents = (complianceEventsRes.data ?? []) as unknown as Array<{
    id: string
    gate_name: string | null
    blocked_reason: string | null
  }>
  const unassignedLeadsCount = unassignedLeadsRes.count ?? 0
  const activeAgentsCount = activeAgentsRes.count ?? 0

  // 3. Build priorities (top 3 by severity)
  const priorities: BriefPriority[] = []

  // Critical deals first
  for (const deal of criticalDeals.slice(0, 2)) {
    if (priorities.length >= 3) break
    const topConcern = deal.score_components?.find((c) => c.severity === "critical" || c.severity === "high")
    priorities.push({
      id: `deal-risk-${deal.transaction_id}`,
      title: `${deal.risk_level === "critical" ? "Critical" : "At-risk"} deal: ${deal.transactions.property_address ?? "Unknown property"}`,
      body: topConcern?.message ?? `Health score ${Math.round(deal.overall_score)}/100`,
      severity: deal.risk_level === "critical" ? "critical" : "high",
      ctas: [
        { label: "Open transaction", href: `/dashboard/transactions/${deal.transaction_id}` },
        { label: "View interventions", href: `/dashboard/brokerage/deal-health` },
      ],
    })
  }

  // License expirations
  if (priorities.length < 3 && expiringLicenses.length > 0) {
    const days = Math.ceil(
      (new Date(expiringLicenses[0].license_expiry).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    )
    const agentName = `${expiringLicenses[0].users.first_name ?? ""} ${expiringLicenses[0].users.last_name ?? ""}`.trim() || "Agent"
    priorities.push({
      id: `license-${expiringLicenses[0].id}`,
      title: `${agentName}'s license expires in ${days} days`,
      body: `${expiringLicenses.length} agent${expiringLicenses.length === 1 ? "" : "s"} with licenses expiring within 60 days`,
      severity: days <= 14 ? "critical" : days <= 30 ? "high" : "medium",
      ctas: [{ label: "Review licenses", href: "/dashboard/brokerage/licenses" }],
    })
  }

  // Unassigned leads
  if (priorities.length < 3 && unassignedLeadsCount > 0) {
    priorities.push({
      id: "unassigned-leads",
      title: `${unassignedLeadsCount} unassigned leads`,
      body: `Leads waiting for agent assignment — distribution rules may need review`,
      severity: unassignedLeadsCount > 20 ? "high" : "medium",
      ctas: [{ label: "Distribute leads", href: "/dashboard/admin/lead-lineage" }],
    })
  }

  // Compliance flags
  if (priorities.length < 3 && complianceEvents.length > 0) {
    priorities.push({
      id: `compliance-${complianceEvents[0].id}`,
      title: `${complianceEvents.length} compliance flag${complianceEvents.length === 1 ? "" : "s"} this week`,
      body: complianceEvents[0].blocked_reason ?? "Review compliance dashboard for details",
      severity: "high",
      ctas: [{ label: "Review compliance", href: "/dashboard/compliance" }],
    })
  }

  // Agent flight risk — the Recruiting Manager's retention board, folded into the broker's daily read.
  let retentionAtRisk = 0
  let curriculumPending = 0
  try {
    const { generateRetentionBoard } = await import("@/lib/intelligence/retention-board")
    const board = await generateRetentionBoard(params.brokerageId)
    retentionAtRisk = board?.atRisk ?? 0
    if (priorities.length < 3 && retentionAtRisk > 0) {
      const worst = board?.agents.find((a) => a.tier === "at_risk" || a.tier === "critical")
      priorities.push({
        id: "retention-flight-risk",
        title: `${retentionAtRisk} agent${retentionAtRisk === 1 ? "" : "s"} at flight risk`,
        body: worst ? `Most at-risk: ${worst.name} (${worst.score}/100). Review their save-plays before they slip.` : "Review save-plays in your approval queue.",
        severity: retentionAtRisk > 2 ? "critical" : "high",
        manager: "recruiting_manager",
        ctas: [{ label: "Open Command Center", href: "/dashboard/command-center" }],
      })
    }
  } catch (err) {
    console.error("[BrokerBrief] retention board failed:", err)
  }
  try {
    const { generateCurriculumBoard } = await import("@/lib/intelligence/curriculum-board")
    curriculumPending = (await generateCurriculumBoard(params.brokerageId))?.pending ?? 0
  } catch { /* best-effort */ }

  // 3b. MANAGER DAILY STANDUP — what the ten Claude managers did in 24h and what
  // needs a human. Items needing approval become priorities (manager-attributed);
  // the report itself rides the brief, so the broker reads governed autonomy's
  // accountability report in the same glance as deals and compliance.
  let standupLines: import("@/lib/intelligence/manager-standup").ManagerStandupLine[] = []
  try {
    const { generateManagerStandup } = await import("@/lib/intelligence/manager-standup")
    standupLines = await generateManagerStandup(params.brokerageId)
    for (const line of standupLines) {
      if (line.needs_human > 0) {
        priorities.push({
          id: `standup-${line.manager}`,
          title: line.headline,
          body: `${line.label} is waiting on your decision.`,
          severity: "high",
          manager: line.manager,
          ctas: [{ label: "Open Command Center", href: "/dashboard/command-center" }],
        })
      }
    }
  } catch (err) {
    console.error("[BrokerBrief] manager standup failed:", err)
  }

  // 4. Build metrics
  const metrics: BriefMetric[] = [
    { label: "Active agents", value: activeAgentsCount, href: "/dashboard/admin/users" },
    { label: "Critical deals", value: criticalDeals.length, href: "/dashboard/brokerage/deal-health" },
    { label: "Unassigned leads", value: unassignedLeadsCount, href: "/dashboard/admin/lead-lineage" },
    { label: "Compliance flags 7d", value: complianceEvents.length, href: "/dashboard/compliance" },
    { label: "Agents at flight risk", value: retentionAtRisk, href: "/dashboard/command-center" },
    ...(curriculumPending > 0 ? [{ label: "AI curriculum pending", value: curriculumPending, href: "/dashboard/command-center" }] : []),
    // Standup digest — one metric per reporting manager (label = manager, value = 24h activity)
    ...standupLines.slice(0, 4).map((l) => ({
      label: l.label,
      value: l.needs_human > 0 ? `${l.activity_24h} (${l.needs_human} need you)` : l.activity_24h,
    })),
  ]

  // 5. AI summary via routed model (Commit 1 layering)
  let summary = "Brokerage running normally."
  if (priorities.length > 0) {
    try {
      const { text } = await generateTextRouted({
        brokerageId: params.brokerageId,
        userId: params.userId,
        feature: "daily_briefing",
        prompt:
          `Write a one-sentence morning summary for a real estate broker. ` +
          `Priorities today: ${priorities.map((p) => p.title).join(" · ")}. ` +
          `Active agents: ${activeAgentsCount}. ` +
          `Tone: direct, factual. No fluff. Under 25 words.`,
        temperature: 0.4,
        maxTokens: 80,
      })
      summary = text.trim().replace(/^["']|["']$/g, "")
    } catch {
      summary = priorities.map((p) => p.title).slice(0, 2).join("; ")
    }
  }

  // 6. Cache result
  await supabase
    .from("ai_daily_briefings")
    .upsert({
      user_id: params.userId,
      brokerage_id: params.brokerageId,
      briefing_date: today,
      summary,
      top_priority_actions: priorities,
      market_pulse: JSON.stringify(metrics),
      ai_model_used: "claude-sonnet-routed",
      generated_at: new Date().toISOString(),
    }, { onConflict: "agent_id,briefing_date" })

  return {
    userId: params.userId,
    userType: "broker",
    brokerageId: params.brokerageId,
    briefingDate: today,
    summary,
    priorities,
    metrics,
    generatedAt: new Date().toISOString(),
  }
}

function parseMarketPulseMetrics(market_pulse: string): BriefMetric[] {
  try {
    const parsed = JSON.parse(market_pulse)
    if (Array.isArray(parsed)) return parsed
  } catch {}
  return []
}
