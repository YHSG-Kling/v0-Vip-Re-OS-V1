"use server"

/**
 * Overdue aggregator — single surface for "everything that's late."
 *
 * Vision moment: "knows nothing fell through the cracks." Today these
 * signals are scattered across 6 dashboards; this aggregates them into
 * one prioritized list at /dashboard/overdue.
 *
 * Sources (all confirmed in DB):
 *   1. transaction_tasks (due_date < now, status != completed)
 *   2. transaction_milestones (target_date/target_date < now, status != completed)
 *   3. transaction_deadlines (deadline_date < now, status != completed)
 *   4. agents.license_expiry (< now + 60 days)
 *   5. client_gifts (status='pending' and scheduled_delivery < now)
 *   6. transaction_lenders (pre_approval_date older than 90 days)
 *
 * Role-aware: agents see only their own; broker / admin / TC / compliance see all.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { resolveActingContext } from "@/lib/platform/acting-context"
import { priorityRank } from "@/lib/kernel/priority-rank"

export type OverdueSeverity = "critical" | "high" | "medium" | "low"
export type OverdueCategory =
  | "task"
  | "milestone"
  | "deadline"
  | "license"
  | "gift"
  | "pre_approval"

export interface OverdueItem {
  id: string
  category: OverdueCategory
  title: string
  description: string
  severity: OverdueSeverity
  daysOverdue: number
  /** Where to navigate when the agent clicks the row */
  href: string
  /** Optional context so the UI can show contact / transaction / property links */
  contactId?: string | null
  transactionId?: string | null
  agentId?: string | null
}

export interface OverdueSummary {
  items: OverdueItem[]
  byCategory: Record<OverdueCategory, number>
  totalCount: number
  criticalCount: number
}

export async function getOverdueSummary(): Promise<OverdueSummary> {
  const ctx = await resolveActingContext()
  if (!ctx.ok || !ctx.brokerageId) {
    return EMPTY
  }

  const svc = createServiceClient()
  // SCOPE LADDER (kept inline — admits tc/compliance tiers): 'superadmin'
  // removed — dead as users.user_type (0 live rows); broker_owner added —
  // storable seat that owns the brokerage.
  const elevated = ["admin", "broker", "broker_owner", "broker_admin", "tc", "transaction_coordinator", "compliance_officer"].includes(
    ctx.userType ?? ""
  )

  const today = new Date().toISOString().slice(0, 10)
  const sixtyDaysOut = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10)
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)

  // For agent-scope: pre-fetch transaction IDs they own so we can filter
  // child tables (tasks/milestones/deadlines) by transaction_id.
  let agentTransactionIds: string[] = []
  if (!elevated && ctx.agentId) {
    const { data } = await svc
      .from("transactions")
      .select("id")
      .eq("agent_id", ctx.agentId)
    agentTransactionIds = (data ?? []).map((t) => t.id)
  }

  // Run all six queries in parallel
  const [
    tasksResult,
    milestonesResult,
    deadlinesResult,
    licensesResult,
    giftsResult,
    lendersResult,
  ] = await Promise.all([
    fetchOverdueTasks(svc, { brokerageId: ctx.brokerageId, elevated, agentTransactionIds, today }),
    fetchOverdueMilestones(svc, { brokerageId: ctx.brokerageId, elevated, agentTransactionIds, today }),
    fetchOverdueDeadlines(svc, { brokerageId: ctx.brokerageId, elevated, agentTransactionIds, today }),
    fetchExpiringLicenses(svc, { brokerageId: ctx.brokerageId, elevated, agentId: ctx.agentId, sixtyDaysOut, today }),
    fetchUnsentGifts(svc, { brokerageId: ctx.brokerageId, elevated, agentId: ctx.agentId, today }),
    fetchStalePreApprovals(svc, { brokerageId: ctx.brokerageId, elevated, agentTransactionIds, ninetyDaysAgo }),
  ])

  const items: OverdueItem[] = [
    ...tasksResult,
    ...milestonesResult,
    ...deadlinesResult,
    ...licensesResult,
    ...giftsResult,
    ...lendersResult,
  ].sort((a, b) => priorityRank(b.severity) - priorityRank(a.severity) || b.daysOverdue - a.daysOverdue)

  const byCategory = items.reduce(
    (acc, item) => ({ ...acc, [item.category]: (acc[item.category] ?? 0) + 1 }),
    {} as Record<OverdueCategory, number>
  )

  return {
    items,
    byCategory,
    totalCount: items.length,
    criticalCount: items.filter((i) => i.severity === "critical").length,
  }
}

// ---------------------------------------------------------------------------
// Per-source fetchers
// ---------------------------------------------------------------------------

interface ScopeArgs {
  brokerageId: string
  elevated: boolean
  agentTransactionIds?: string[]
  agentId?: string | null
  today?: string
  sixtyDaysOut?: string
  ninetyDaysAgo?: string
}

async function fetchOverdueTasks(svc: ReturnType<typeof createServiceClient>, scope: ScopeArgs): Promise<OverdueItem[]> {
  if (!scope.elevated && !scope.agentTransactionIds?.length) return []
  let q = svc
    .from("transaction_tasks")
    .select("id, transaction_id, title, description, due_date, status, priority")
    .lt("due_date", scope.today!)
    .neq("status", "completed")
    .limit(100)

  if (!scope.elevated) q = q.in("transaction_id", scope.agentTransactionIds!)

  const { data } = await q
  return (data ?? []).map((t) => ({
    id: `task-${t.id}`,
    category: "task" as const,
    title: t.title ?? "Task",
    description: t.description ?? "",
    severity: severityFromDays(daysSince(t.due_date), t.priority),
    daysOverdue: daysSince(t.due_date),
    href: `/dashboard/transactions/${t.transaction_id}?tab=tasks`,
    transactionId: t.transaction_id,
  }))
}

async function fetchOverdueMilestones(svc: ReturnType<typeof createServiceClient>, scope: ScopeArgs): Promise<OverdueItem[]> {
  if (!scope.elevated && !scope.agentTransactionIds?.length) return []
  let q = svc
    .from("transaction_milestones")
    .select("id, transaction_id, milestone_name, title, target_date, target_date, status")
    .neq("status", "completed")
    .limit(100)

  if (!scope.elevated) q = q.in("transaction_id", scope.agentTransactionIds!)

  const { data } = await q
  const out: OverdueItem[] = []
  for (const m of data ?? []) {
    const date = m.target_date ?? m.target_date
    if (!date || date >= scope.today!) continue
    out.push({
      id: `milestone-${m.id}`,
      category: "milestone",
      title: m.title ?? m.milestone_name ?? "Milestone",
      description: `${date}`,
      severity: severityFromDays(daysSince(date)),
      daysOverdue: daysSince(date),
      href: `/dashboard/transactions/${m.transaction_id}`,
      transactionId: m.transaction_id,
    })
  }
  return out
}

async function fetchOverdueDeadlines(svc: ReturnType<typeof createServiceClient>, scope: ScopeArgs): Promise<OverdueItem[]> {
  if (!scope.elevated && !scope.agentTransactionIds?.length) return []
  let q = svc
    .from("transaction_deadlines")
    .select("id, transaction_id, deadline_type, deadline_date, status")
    .lt("deadline_date", scope.today!)
    .neq("status", "completed")
    .limit(100)

  if (!scope.elevated) q = q.in("transaction_id", scope.agentTransactionIds!)

  const { data } = await q
  return (data ?? []).map((d) => ({
    id: `deadline-${d.id}`,
    category: "deadline" as const,
    title: humanize(d.deadline_type ?? "deadline"),
    description: `Due ${d.deadline_date}`,
    severity: severityFromDays(daysSince(d.deadline_date), "high"),
    daysOverdue: daysSince(d.deadline_date),
    href: `/dashboard/transactions/${d.transaction_id}`,
    transactionId: d.transaction_id,
  }))
}

async function fetchExpiringLicenses(svc: ReturnType<typeof createServiceClient>, scope: ScopeArgs): Promise<OverdueItem[]> {
  let q = svc
    .from("agents")
    .select("id, user_id, license_expiry, license_state")
    .eq("brokerage_id", scope.brokerageId)
    .lt("license_expiry", scope.sixtyDaysOut!)

  if (!scope.elevated && scope.agentId) q = q.eq("id", scope.agentId)

  const { data } = await q
  if (!data?.length) return []

  // Hydrate user names for display
  const userIds = data.map((a) => a.user_id).filter(Boolean) as string[]
  const { data: users } = userIds.length
    ? await svc.from("users").select("id, first_name, last_name").in("id", userIds)
    : { data: [] as any[] }
  const nameById = new Map((users ?? []).map((u) => [u.id, `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim()]))

  return data.map((a) => {
    const days = -daysSince(a.license_expiry)  // negative when not yet expired
    const expired = a.license_expiry < scope.today!
    return {
      id: `license-${a.id}`,
      category: "license" as const,
      title: expired ? "License EXPIRED" : "License expiring soon",
      description: `${nameById.get(a.user_id) ?? "Agent"} · ${a.license_state ?? ""} · ${a.license_expiry}`,
      severity: expired ? "critical" : days <= 30 ? "high" : "medium",
      daysOverdue: expired ? daysSince(a.license_expiry) : -days,
      href: `/dashboard/admin/onboarding`,
      agentId: a.id,
    }
  })
}

async function fetchUnsentGifts(svc: ReturnType<typeof createServiceClient>, scope: ScopeArgs): Promise<OverdueItem[]> {
  let q = svc
    .from("client_gifts")
    .select("id, contact_id, agent_id, status, scheduled_delivery, occasion")
    .eq("status", "pending")
    .lt("scheduled_delivery", scope.today!)
    .limit(50)

  if (!scope.elevated && scope.agentId) q = q.eq("agent_id", scope.agentId)

  const { data } = await q
  return (data ?? []).map((g) => ({
    id: `gift-${g.id}`,
    category: "gift" as const,
    title: `Gift unsent: ${g.occasion ?? "milestone"}`,
    description: `Scheduled ${g.scheduled_delivery}`,
    severity: severityFromDays(daysSince(g.scheduled_delivery)),
    daysOverdue: daysSince(g.scheduled_delivery),
    href: g.contact_id ? `/crm?contact=${g.contact_id}&action=gift` : `/lifetime-customers`,
    contactId: g.contact_id,
    agentId: g.agent_id,
  }))
}

async function fetchStalePreApprovals(svc: ReturnType<typeof createServiceClient>, scope: ScopeArgs): Promise<OverdueItem[]> {
  if (!scope.elevated && !scope.agentTransactionIds?.length) return []
  let q = svc
    .from("transaction_lenders")
    .select("transaction_id, pre_approval_date, pre_approval_amount")
    .lt("pre_approval_date", scope.ninetyDaysAgo!)
    .limit(50)

  if (!scope.elevated) q = q.in("transaction_id", scope.agentTransactionIds!)

  const { data } = await q
  return (data ?? []).map((l) => ({
    id: `preappr-${l.transaction_id}`,
    category: "pre_approval" as const,
    title: "Pre-approval may be stale",
    description: `Issued ${l.pre_approval_date} — typical 90-day expiry`,
    severity: "medium" as const,
    daysOverdue: daysSince(l.pre_approval_date),
    href: `/dashboard/transactions/${l.transaction_id}?tab=lender`,
    transactionId: l.transaction_id,
  }))
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function daysSince(dateStr: string | null): number {
  if (!dateStr) return 0
  const d = new Date(dateStr).getTime()
  return Math.floor((Date.now() - d) / 86400000)
}

function severityFromDays(days: number, hint?: string): OverdueSeverity {
  if (days >= 14 || hint === "critical") return "critical"
  if (days >= 7 || hint === "high") return "high"
  if (days >= 3) return "medium"
  return "low"
}

// TOMBSTONE (§1.1, 2026-09-03): `severityWeight(s) → {critical:4, high:3,
// medium:2, low:1}[s]` stood here — one of five hand copies of the same rank
// map. Survivor: lib/kernel/priority-rank.ts:45 (PRIORITY_RANK, identical
// numbering) via `priorityRank` (:65), imported above and applied at the sort in
// getOverdueSummary.

function humanize(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

const EMPTY: OverdueSummary = {
  items: [],
  byCategory: { task: 0, milestone: 0, deadline: 0, license: 0, gift: 0, pre_approval: 0 },
  totalCount: 0,
  criticalCount: 0,
}
