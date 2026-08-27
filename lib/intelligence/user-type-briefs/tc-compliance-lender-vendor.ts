"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"
import type { UserTypeBrief, BriefPriority, BriefMetric } from "./types"

// ─── TC Brief ─────────────────────────────────────────────────────────────────

export async function generateTcBrief(params: {
  userId: string
  brokerageId: string
  forceRegenerate?: boolean
}): Promise<UserTypeBrief> {
  return generateTcLikeBrief({ ...params, userType: "TC" })
}

// ─── Compliance Brief ─────────────────────────────────────────────────────────

export async function generateComplianceBrief(params: {
  userId: string
  brokerageId: string
  forceRegenerate?: boolean
}): Promise<UserTypeBrief> {
  const supabase = createServiceClient()
  const today = new Date().toISOString().slice(0, 10)
  const cached = await readCachedBrief(params.userId, today, params.forceRegenerate)
  if (cached) return { ...cached, userType: "compliance_officer" }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [pendingApprovalsRes, criticalViolationsRes, openComplianceCheckRes] = await Promise.all([
    supabase
      .from("compliance_checks")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .or(`brokerage_id.eq.${params.brokerageId},brokerage_id.is.null`),
    supabase
      .from("compliance_events")
      .select("id, gate_name, blocked_reason, entity_type, entity_id, created_at")
      .eq("brokerage_id", params.brokerageId)
      .eq("allowed", false)
      .gte("created_at", sevenDaysAgo)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("compliance_checks")
      .select("id", { count: "exact", head: true })
      // TENANT-SCOPED (2026-08-27): this count had NO brokerage filter at all,
      // so on the service client it counted every tenant's open checks into
      // this brokerage's brief. The `.is.null` arm stays only for legacy rows
      // written before app/actions/documents.ts stamped the brokerage_id
      // column (it used to live only inside the findings jsonb).
      .or(`brokerage_id.eq.${params.brokerageId},brokerage_id.is.null`)
      .in("status", ["pending", "needs_review"]),
  ])

  const pendingCount = pendingApprovalsRes.count ?? 0
  const violations = (criticalViolationsRes.data ?? []) as unknown as Array<{
    id: string
    gate_name: string | null
    blocked_reason: string | null
  }>
  const openCount = openComplianceCheckRes.count ?? 0

  const priorities: BriefPriority[] = []

  if (pendingCount > 0) {
    priorities.push({
      id: "pending-approvals",
      title: `${pendingCount} pending approvals`,
      body: "Review queue is full. Triage by severity to clear blocking items first.",
      severity: pendingCount > 10 ? "high" : "medium",
      ctas: [{ label: "Open triage queue", href: "/dashboard/compliance" }],
    })
  }

  if (violations.length > 0) {
    priorities.push({
      id: `violation-${violations[0].id}`,
      title: `${violations.length} compliance flag${violations.length === 1 ? "" : "s"} this week`,
      body: violations[0].blocked_reason ?? "Review violations dashboard",
      severity: "high",
      ctas: [{ label: "Review violations", href: "/compliance/violations" }],
    })
  }

  const metrics: BriefMetric[] = [
    { label: "Pending review", value: pendingCount, href: "/dashboard/compliance" },
    { label: "Open total", value: openCount },
    { label: "Flags 7d", value: violations.length },
  ]

  const summary = await synthesize("compliance officer", priorities, metrics, { brokerageId: params.brokerageId, userId: params.userId })
  await persistBrief(params.userId, params.brokerageId, today, summary, priorities, metrics)

  return {
    userId: params.userId,
    userType: "compliance_officer",
    brokerageId: params.brokerageId,
    briefingDate: today,
    summary,
    priorities,
    metrics,
    generatedAt: new Date().toISOString(),
  }
}

// ─── Lender Brief ─────────────────────────────────────────────────────────────

export async function generateLenderBrief(params: {
  userId: string
  brokerageId: string
  forceRegenerate?: boolean
}): Promise<UserTypeBrief> {
  const supabase = createServiceClient()
  const today = new Date().toISOString().slice(0, 10)
  const cached = await readCachedBrief(params.userId, today, params.forceRegenerate)
  if (cached) return { ...cached, userType: "lender" }

  const sevenDaysOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  // Lenders are vendors — resolve this user's lender vendor, then scope by the
  // transactions it's assigned to (vendor_assignments), not a lender user id.
  const { isLenderVendorCategory, lenderVendorTransactionIds, lenderFilterIds } =
    await import("@/lib/kernel/lender-linkage")
  const { data: roleRows } = await supabase
    .from("user_role_assignments")
    .select("vendor_id, vendors!inner(id, category)")
    .eq("user_id", params.userId)
    .not("vendor_id", "is", null)
  const lenderVendor = ((roleRows ?? []) as any[]).map((r) => r.vendors).find((v) => v && isLenderVendorCategory(v.category))
  const txnIds = lenderFilterIds(lenderVendor ? await lenderVendorTransactionIds(supabase, lenderVendor.id, params.brokerageId) : [])

  const [activeLoansRes, closingsThisWeekRes, stuckLoansRes] = await Promise.all([
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .in("id", txnIds)
      .not("stage", "in", "(closed,cancelled)"),
    supabase
      .from("transactions")
      .select("id, property_address, close_date, stage")
      .in("id", txnIds)
      .gte("close_date", today)
      .lte("close_date", sevenDaysOut)
      .order("close_date", { ascending: true })
      .limit(10),
    supabase
      .from("transactions")
      .select("id, property_address, stage, updated_at")
      .in("id", txnIds)
      .lt("updated_at", new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString())
      .not("stage", "in", "(closed,cancelled)")
      .limit(5),
  ])

  const activeCount = activeLoansRes.count ?? 0
  const closings = (closingsThisWeekRes.data ?? []) as unknown as Array<{
    id: string; property_address: string | null; close_date: string | null; stage: string
  }>
  const stuckLoans = (stuckLoansRes.data ?? []) as unknown as Array<{
    id: string; property_address: string | null; stage: string
  }>

  const priorities: BriefPriority[] = []

  for (const c of closings.slice(0, 2)) {
    if (priorities.length >= 3) break
    const days = c.close_date ? Math.ceil((new Date(c.close_date).getTime() - Date.now()) / (24 * 60 * 60 * 1000)) : 0
    priorities.push({
      id: `close-${c.id}`,
      title: `Closing in ${days}d: ${c.property_address ?? "transaction"}`,
      body: `Currently in ${c.stage} — confirm CD ready and clear-to-close on file`,
      severity: days <= 2 ? "critical" : days <= 5 ? "high" : "medium",
      ctas: [{ label: "Open transaction", href: `/dashboard/transactions/${c.id}` }],
    })
  }

  if (priorities.length < 3 && stuckLoans.length > 0) {
    priorities.push({
      id: `stuck-${stuckLoans[0].id}`,
      title: `${stuckLoans.length} loan${stuckLoans.length === 1 ? "" : "s"} stalled (5+ days)`,
      body: stuckLoans[0].property_address ?? "Loan files with no recent activity",
      severity: "high",
      ctas: [{ label: "Review pipeline", href: "/lender/dashboard" }],
    })
  }

  const metrics: BriefMetric[] = [
    { label: "Active loans", value: activeCount, href: "/lender/dashboard" },
    { label: "Closing 7d", value: closings.length, href: "/lender/dashboard?filter=closing-soon" },
    { label: "Stalled (5d+)", value: stuckLoans.length, href: "/lender/dashboard?filter=stuck" },
  ]

  const summary = await synthesize("lender", priorities, metrics, { brokerageId: params.brokerageId, userId: params.userId })
  await persistBrief(params.userId, params.brokerageId, today, summary, priorities, metrics)

  return {
    userId: params.userId,
    userType: "lender",
    brokerageId: params.brokerageId,
    briefingDate: today,
    summary,
    priorities,
    metrics,
    generatedAt: new Date().toISOString(),
  }
}

// ─── Vendor Brief ─────────────────────────────────────────────────────────────

export async function generateVendorBrief(params: {
  userId: string
  brokerageId: string
  forceRegenerate?: boolean
}): Promise<UserTypeBrief> {
  const supabase = createServiceClient()
  const today = new Date().toISOString().slice(0, 10)
  const cached = await readCachedBrief(params.userId, today, params.forceRegenerate)
  if (cached) return { ...cached, userType: "vendor" }

  const sevenDaysOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  // vendor_assignments real columns: vendor_id, scheduled_date (no deliverable_due_date),
  // status CHECK pending|confirmed|in_progress|completed|cancelled, address via transactions
  // (no listings FK). NOTE: there is no user→vendor link in the schema (vendors has no
  // user_id), so this brief is scoped to the brokerage's vendor-deliverable workload.
  // Per-vendor scoping requires a vendors.user_id link — flagged for product.
  const [openJobsRes, dueSoonRes, overdueRes] = await Promise.all([
    supabase
      .from("vendor_assignments")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", params.brokerageId)
      .in("status", ["pending", "confirmed", "in_progress"]),
    supabase
      .from("vendor_assignments")
      .select("id, scheduled_date, transactions(property_address)")
      .eq("brokerage_id", params.brokerageId)
      .gte("scheduled_date", today)
      .lte("scheduled_date", sevenDaysOut)
      .limit(5),
    supabase
      .from("vendor_assignments")
      .select("id, scheduled_date")
      .eq("brokerage_id", params.brokerageId)
      .lt("scheduled_date", today)
      .neq("status", "completed")
      .limit(5),
  ])

  const openCount = openJobsRes.count ?? 0
  const dueSoon = (dueSoonRes.data ?? []) as unknown as Array<{ id: string; scheduled_date: string | null; transactions: { property_address: string | null } | null }>
  const overdue = (overdueRes.data ?? []) as unknown as Array<{ id: string; scheduled_date: string | null }>

  const priorities: BriefPriority[] = []

  if (overdue.length > 0) {
    priorities.push({
      id: "overdue",
      title: `${overdue.length} deliverable${overdue.length === 1 ? "" : "s"} overdue`,
      body: "Past-due jobs hurt brokerage SLA score — address first",
      severity: "critical",
      ctas: [{ label: "Open jobs", href: "/vendor/jobs?filter=overdue" }],
    })
  }

  if (dueSoon.length > 0) {
    priorities.push({
      id: "due-soon",
      title: `${dueSoon.length} deliverable${dueSoon.length === 1 ? "" : "s"} due this week`,
      body: dueSoon[0].transactions?.property_address ?? "Property deliverables — see job list",
      severity: "medium",
      ctas: [{ label: "View calendar", href: "/vendor/jobs" }],
    })
  }

  const metrics: BriefMetric[] = [
    { label: "Open jobs", value: openCount, href: "/vendor/jobs" },
    { label: "Due 7d", value: dueSoon.length },
    { label: "Overdue", value: overdue.length, href: "/vendor/jobs?filter=overdue" },
  ]

  const summary = await synthesize("vendor", priorities, metrics, { brokerageId: params.brokerageId, userId: params.userId })
  await persistBrief(params.userId, params.brokerageId, today, summary, priorities, metrics)

  return {
    userId: params.userId,
    userType: "vendor",
    brokerageId: params.brokerageId,
    briefingDate: today,
    summary,
    priorities,
    metrics,
    generatedAt: new Date().toISOString(),
  }
}

// ─── Internal: shared TC-like brief (used for TC) ─────────────────────────────

async function generateTcLikeBrief(params: {
  userId: string
  brokerageId: string
  userType: string
  forceRegenerate?: boolean
}): Promise<UserTypeBrief> {
  const supabase = createServiceClient()
  const today = new Date().toISOString().slice(0, 10)
  const cached = await readCachedBrief(params.userId, today, params.forceRegenerate)
  if (cached) return { ...cached, userType: params.userType }

  const sevenDaysOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const [closingsRes, atRiskRes, openInterventionsRes, activeTransactionsRes] = await Promise.all([
    supabase
      .from("transactions")
      .select("id, property_address, close_date")
      .eq("coordinator_id", params.userId)
      .gte("close_date", today)
      .lte("close_date", sevenDaysOut)
      .order("close_date", { ascending: true })
      .limit(10),
    // TC column is coordinator_id (assigned_tc_id never existed — the embed failed).
    supabase
      .from("deal_health_scores")
      .select("transaction_id, overall_score, risk_level, transactions!inner(property_address, coordinator_id)")
      .eq("transactions.coordinator_id", params.userId)
      .in("risk_level", ["critical", "at_risk"])
      .order("overall_score", { ascending: true })
      .limit(5),
    supabase
      .from("proactive_interventions")
      .select("id, transaction_id, issue_detected, severity")
      .eq("resolved", false)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("coordinator_id", params.userId)
      .not("stage", "in", "(closed,cancelled)"),
  ])

  const closings = (closingsRes.data ?? []) as unknown as Array<{ id: string; property_address: string | null; close_date: string | null }>
  const atRisk = (atRiskRes.data ?? []) as unknown as Array<{ transaction_id: string; overall_score: number; risk_level: string; transactions: { property_address: string | null } }>
  const interventions = (openInterventionsRes.data ?? []) as unknown as Array<{ id: string; transaction_id: string; issue_detected: string | null; severity: string | null }>
  const activeCount = activeTransactionsRes.count ?? 0

  const priorities: BriefPriority[] = []

  for (const r of atRisk.slice(0, 2)) {
    if (priorities.length >= 3) break
    priorities.push({
      id: `tc-risk-${r.transaction_id}`,
      title: `${r.risk_level === "critical" ? "Critical" : "At-risk"}: ${r.transactions.property_address ?? "deal"}`,
      body: `Health score ${Math.round(r.overall_score)}/100 — open interventions panel`,
      severity: r.risk_level === "critical" ? "critical" : "high",
      ctas: [{ label: "Open transaction", href: `/dashboard/transactions/${r.transaction_id}` }],
    })
  }

  if (priorities.length < 3 && closings.length > 0) {
    const next = closings[0]
    const days = next.close_date ? Math.ceil((new Date(next.close_date).getTime() - Date.now()) / (24 * 60 * 60 * 1000)) : 0
    priorities.push({
      id: `tc-close-${next.id}`,
      title: `${closings.length} closing${closings.length === 1 ? "" : "s"} this week`,
      body: `Next: ${next.property_address ?? "property"} in ${days}d`,
      severity: days <= 2 ? "high" : "medium",
      ctas: [{ label: "Open closing pipeline", href: "/dashboard/coordinator" }],
    })
  }

  if (priorities.length < 3 && interventions.length > 0) {
    priorities.push({
      id: `tc-interventions`,
      title: `${interventions.length} open intervention${interventions.length === 1 ? "" : "s"}`,
      body: interventions[0].issue_detected ?? "Open interventions awaiting resolution",
      severity: interventions.some((i) => i.severity === "high") ? "high" : "medium",
      ctas: [{ label: "Resolve interventions", href: "/dashboard/coordinator" }],
    })
  }

  const metrics: BriefMetric[] = [
    { label: "Active txns", value: activeCount, href: "/dashboard/coordinator" },
    { label: "Closings 7d", value: closings.length },
    { label: "At-risk", value: atRisk.length },
    { label: "Open interventions", value: interventions.length },
  ]

  const summary = await synthesize("transaction coordinator", priorities, metrics, { brokerageId: params.brokerageId, userId: params.userId })
  await persistBrief(params.userId, params.brokerageId, today, summary, priorities, metrics)

  return {
    userId: params.userId,
    userType: params.userType,
    brokerageId: params.brokerageId,
    briefingDate: today,
    summary,
    priorities,
    metrics,
    generatedAt: new Date().toISOString(),
  }
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function readCachedBrief(
  userId: string,
  today: string,
  forceRegenerate?: boolean
): Promise<Omit<UserTypeBrief, "userType"> | null> {
  if (forceRegenerate) return null
  const supabase = createServiceClient()
  const { data: cached } = await supabase
    .from("ai_daily_briefings")
    .select("*")
    .eq("user_id", userId)
    .eq("briefing_date", today)
    .maybeSingle()
  if (!cached) return null
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
    brokerageId: c.brokerage_id,
    briefingDate: c.briefing_date,
    summary: c.summary,
    priorities: c.top_priority_actions ?? [],
    metrics: parseMarketPulse(c.market_pulse),
    generatedAt: c.generated_at,
    cached: true,
  }
}

async function persistBrief(
  userId: string,
  brokerageId: string,
  today: string,
  summary: string,
  priorities: BriefPriority[],
  metrics: BriefMetric[]
): Promise<void> {
  const supabase = createServiceClient()
  await supabase
    .from("ai_daily_briefings")
    .upsert(
      {
        user_id: userId,
        brokerage_id: brokerageId,
        briefing_date: today,
        summary,
        top_priority_actions: priorities,
        market_pulse: JSON.stringify(metrics),
        ai_model_used: "claude-sonnet-routed",
        generated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id,briefing_date" }
    )
}

async function synthesize(
  userTypeLabel: string,
  priorities: BriefPriority[],
  metrics: BriefMetric[],
  /** Tenant + actor for the AI cost ledger — the same `params.brokerageId` /
   *  `params.userId` each brief already persists against (§4). */
  spendActor: { brokerageId: string | null; userId: string | null } = { brokerageId: null, userId: null },
): Promise<string> {
  if (priorities.length === 0) {
    return `Quiet day for ${userTypeLabel}. Nothing critical on the radar — good time to focus on growth work.`
  }
  try {
    const { text } = await generateTextRouted({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId,
      feature: "daily_briefing",
      prompt:
        `Write a one-sentence morning summary for a real estate ${userTypeLabel}. ` +
        `Priorities: ${priorities.map((p) => p.title).join(" · ")}. ` +
        `Metrics: ${metrics.map((m) => `${m.label} ${m.value}`).join(" · ")}. ` +
        `Tone: direct, factual, no fluff. Under 25 words.`,
      temperature: 0.4,
      maxTokens: 80,
    })
    return text.trim().replace(/^["']|["']$/g, "")
  } catch {
    return priorities
      .map((p) => p.title)
      .slice(0, 2)
      .join("; ")
  }
}

function parseMarketPulse(market_pulse: string): BriefMetric[] {
  try {
    const parsed = JSON.parse(market_pulse)
    if (Array.isArray(parsed)) return parsed
  } catch {}
  return []
}
