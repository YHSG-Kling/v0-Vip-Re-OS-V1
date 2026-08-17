"use server"

/**
 * Brokerage Fee System — server actions.
 *
 * Brokers create fee TYPES (recurring or one-time) and assign them to all
 * agents, specific agents, a role, or a team. The system generates monthly
 * CHARGES (one per agent per fee type per period) which agents pay either
 * via autopay (Stripe) or manual mark-paid by the broker.
 *
 * NOTE: This is separate from agent commissions, which flow via CDA at
 * closing through title/closing-attorney — the brokerage charges agents
 * for tech, desk, and other shared costs here.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { resolveWriteContext } from "@/lib/kernel/identity"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeeCadence = "monthly" | "quarterly" | "annual" | "per_transaction" | "one_time"
export type AppliesTo = "all_agents" | "specific_agents" | "role" | "team"
export type ChargeStatus = "open" | "paid" | "overdue" | "waived" | "disputed"

export interface FeeType {
  id: string
  brokerageId: string
  name: string
  description: string | null
  amount: number
  cadence: FeeCadence
  appliesTo: AppliesTo
  appliesToRole: string | null
  isActive: boolean
  startDate: string
  endDate: string | null
  createdAt: string
}

export interface AgentFeeCharge {
  id: string
  agentId: string
  agentName: string
  feeTypeId: string
  feeTypeName: string
  periodStart: string
  periodEnd: string | null
  amount: number
  status: ChargeStatus
  dueDate: string | null
  paidAt: string | null
  paymentMethod: string | null
}

// ---------------------------------------------------------------------------
// CREATE / UPDATE FEE TYPES (broker only)
// ---------------------------------------------------------------------------

interface CreateFeeTypeInput {
  name: string
  description?: string
  amount: number
  cadence: FeeCadence
  appliesTo: AppliesTo
  appliesToRole?: string
  appliesToTeam?: string
  startDate?: string
  endDate?: string
  agentIds?: string[]   // when appliesTo='specific_agents'
}

export async function createFeeType(input: CreateFeeTypeInput): Promise<{
  success: boolean
  feeTypeId?: string
  error?: string
}> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  if (!isBrokerRole(ctx.userType)) {
    return { success: false, error: "Only broker / admin / superadmin can create fees" }
  }
  if (input.amount <= 0) return { success: false, error: "Amount must be positive" }

  const svc = createServiceClient()

  const { data: feeType, error } = await svc
    .from("brokerage_fee_types")
    .insert({
      brokerage_id: ctx.brokerageId,
      name: input.name,
      description: input.description ?? null,
      amount: input.amount,
      cadence: input.cadence,
      applies_to: input.appliesTo,
      applies_to_role: input.appliesToRole ?? null,
      applies_to_team: input.appliesToTeam ?? null,
      is_active: true,
      start_date: input.startDate ?? new Date().toISOString().slice(0, 10),
      end_date: input.endDate ?? null,
    })
    .select("id")
    .single()

  if (error || !feeType) {
    return { success: false, error: error?.message ?? "Failed to create fee" }
  }

  // Specific-agent assignments
  if (input.appliesTo === "specific_agents" && input.agentIds?.length) {
    const rows = input.agentIds.map((agentId) => ({
      fee_type_id: feeType.id,
      agent_id: agentId,
      brokerage_id: ctx.brokerageId,
      is_active: true,
    }))
    await svc.from("agent_fee_assignments").insert(rows)
  }

  return { success: true, feeTypeId: feeType.id }
}

export async function toggleFeeType(params: {
  feeTypeId: string
  isActive: boolean
}): Promise<{ success: boolean; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !isBrokerRole(ctx.userType)) {
    return { success: false, error: "Unauthorized" }
  }
  const svc = createServiceClient()
  const { error } = await svc
    .from("brokerage_fee_types")
    .update({ is_active: params.isActive })
    .eq("id", params.feeTypeId)
    .eq("brokerage_id", ctx.brokerageId!)
  return error ? { success: false, error: error.message } : { success: true }
}

// ---------------------------------------------------------------------------
// READ
// ---------------------------------------------------------------------------

export async function listFeeTypes(): Promise<FeeType[]> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return []
  // The fee schedule is broker-level financial config — gate the read to the
  // same roles that create/toggle fees (createFeeType / setFeeTypeActive). This
  // uses the service client (RLS-bypassing), so a brokerage_id check alone let
  // any plain agent enumerate the whole fee structure.
  if (!isBrokerRole(ctx.userType)) return []

  const svc = createServiceClient()
  const { data } = await svc
    .from("brokerage_fee_types")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
    .order("created_at", { ascending: false })

  return (data ?? []).map((r: any) => ({
    id: r.id,
    brokerageId: r.brokerage_id,
    name: r.name,
    description: r.description,
    amount: r.amount,
    cadence: r.cadence,
    appliesTo: r.applies_to,
    appliesToRole: r.applies_to_role,
    isActive: r.is_active,
    startDate: r.start_date,
    endDate: r.end_date,
    createdAt: r.created_at,
  }))
}

export async function getMyOpenCharges(): Promise<AgentFeeCharge[]> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.agentId) return []

  const svc = createServiceClient()
  const { data: charges } = await svc
    .from("agent_fee_charges")
    .select(`
      id, agent_id, fee_type_id, period_start, period_end,
      amount, status, due_date, paid_at, payment_method,
      brokerage_fee_types(name)
    `)
    .eq("agent_id", ctx.agentId)
    .order("period_start", { ascending: false })
    .limit(60)

  return (charges ?? []).map((c: any) => ({
    id: c.id,
    agentId: c.agent_id,
    agentName: "",
    feeTypeId: c.fee_type_id,
    feeTypeName: c.brokerage_fee_types?.name ?? "Fee",
    periodStart: c.period_start,
    periodEnd: c.period_end,
    amount: c.amount,
    status: c.status,
    dueDate: c.due_date,
    paidAt: c.paid_at,
    paymentMethod: c.payment_method,
  }))
}

export async function listBrokerageCharges(filter?: {
  status?: ChargeStatus
  agentId?: string
}): Promise<AgentFeeCharge[]> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !isBrokerRole(ctx.userType)) return []

  const svc = createServiceClient()
  let q = svc
    .from("agent_fee_charges")
    .select(`
      id, agent_id, fee_type_id, period_start, period_end,
      amount, status, due_date, paid_at, payment_method,
      brokerage_fee_types(name)
    `)
    .eq("brokerage_id", ctx.brokerageId)

  if (filter?.status) q = q.eq("status", filter.status)
  if (filter?.agentId) q = q.eq("agent_id", filter.agentId)

  const { data: charges } = await q.order("period_start", { ascending: false }).limit(500)

  // Hydrate agent names
  const agentIds = Array.from(new Set((charges ?? []).map((c) => c.agent_id)))
  const { data: agents } = agentIds.length
    ? await svc
        .from("agents")
        .select("id, user_id")
        .in("id", agentIds)
    : { data: [] as any[] }

  const userIds = (agents ?? []).map((a) => a.user_id)
  const { data: users } = userIds.length
    ? await svc.from("users").select("id, first_name, last_name").in("id", userIds)
    : { data: [] as any[] }

  const agentNameById = new Map<string, string>()
  for (const a of agents ?? []) {
    const u = (users ?? []).find((x) => x.id === a.user_id)
    agentNameById.set(a.id, [u?.first_name, u?.last_name].filter(Boolean).join(" ") || "Unknown")
  }

  return (charges ?? []).map((c: any) => ({
    id: c.id,
    agentId: c.agent_id,
    agentName: agentNameById.get(c.agent_id) ?? "Unknown",
    feeTypeId: c.fee_type_id,
    feeTypeName: c.brokerage_fee_types?.name ?? "Fee",
    periodStart: c.period_start,
    periodEnd: c.period_end,
    amount: c.amount,
    status: c.status,
    dueDate: c.due_date,
    paidAt: c.paid_at,
    paymentMethod: c.payment_method,
  }))
}

// ---------------------------------------------------------------------------
// MARK PAID / WAIVE (broker action)
// ---------------------------------------------------------------------------

export async function markChargePaid(params: {
  chargeId: string
  paymentMethod?: string
}): Promise<{ success: boolean; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !isBrokerRole(ctx.userType)) {
    return { success: false, error: "Unauthorized" }
  }
  const svc = createServiceClient()
  const { error } = await svc
    .from("agent_fee_charges")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      payment_method: params.paymentMethod ?? "manual",
    })
    .eq("id", params.chargeId)
    .eq("brokerage_id", ctx.brokerageId!)
  return error ? { success: false, error: error.message } : { success: true }
}

export async function waiveCharge(params: {
  chargeId: string
  reason?: string
}): Promise<{ success: boolean; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !isBrokerRole(ctx.userType)) {
    return { success: false, error: "Unauthorized" }
  }
  const svc = createServiceClient()
  const { error } = await svc
    .from("agent_fee_charges")
    .update({
      status: "waived",
      notes: params.reason ?? "Waived by broker",
    })
    .eq("id", params.chargeId)
    .eq("brokerage_id", ctx.brokerageId!)
  return error ? { success: false, error: error.message } : { success: true }
}

// ---------------------------------------------------------------------------
// GENERATE CHARGES — called by a cron each cadence period
// ---------------------------------------------------------------------------

/**
 * Generate this period's charges for all active fee types.
 * Idempotent via the (agent_id, fee_type_id, period_start) UNIQUE constraint.
 * Designed to run from a Vercel cron / Supabase scheduled function monthly.
 */
export async function generatePeriodicCharges(): Promise<{
  success: boolean
  generated: number
  error?: string
}> {
  const svc = createServiceClient()
  const today = new Date().toISOString().slice(0, 10)

  // Pull all active fee types (across all brokerages — system run)
  const { data: feeTypes } = await svc
    .from("brokerage_fee_types")
    .select("*")
    .eq("is_active", true)

  if (!feeTypes?.length) return { success: true, generated: 0 }

  let inserted = 0
  for (const ft of feeTypes) {
    // Determine period_start for this cadence
    const periodStart = computePeriodStart(ft.cadence, today)
    if (!periodStart) continue
    // one_time fee — skip if already charged
    if (ft.cadence === "one_time") {
      const { data: existing } = await svc
        .from("agent_fee_charges")
        .select("id")
        .eq("fee_type_id", ft.id)
        .limit(1)
      if (existing?.length) continue
    }

    // Determine which agents this applies to
    const agentIds = await resolveAgentsForFeeType(ft, svc)

    for (const agentId of agentIds) {
      const { error } = await svc
        .from("agent_fee_charges")
        .insert({
          brokerage_id: ft.brokerage_id,
          agent_id: agentId,
          fee_type_id: ft.id,
          period_start: periodStart,
          period_end: computePeriodEnd(ft.cadence, periodStart),
          amount: ft.amount,
          currency: ft.currency,
          status: "open",
          due_date: computeDueDate(periodStart),
        })
      if (!error) inserted++
      // ON CONFLICT (UNIQUE) silently skips dupes — no error to surface
    }
  }

  return { success: true, generated: inserted }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// BROKERAGE-WIDE MONEY (m472). The fee schedule IS the brokerage charging its
// agents, and brokerage_fee_types / agent_fee_assignments / agent_fee_charges are
// all FINANCE tables under public.is_brokerage_finance_admin(). This function is
// kept as the local NAME its six call sites already read, but its ANSWER now
// comes from the ONE shared roster instead of a literal written here — so the app
// and RLS cannot disagree, which matters because these paths write through the
// SERVICE client and have no RLS backstop.
//
// The old literal refused broker_owner — the person who owns the brokerage could
// not set their own brokerage's fees. The shared roster admits them. It carries
// 'broker_admin' forward as an input spelling and drops 'superadmin', which is
// MEASURED dead as a user_type (zero live rows; the platform's one superadmin is
// user_type='admin' with platform_role='superadmin', admitted through 'admin').
function isBrokerRole(t?: string | null) {
  return isBrokerageFinanceAdmin({ user_type: t })
}

function computePeriodStart(cadence: FeeCadence, today: string): string | null {
  const d = new Date(today + "T00:00:00Z")
  switch (cadence) {
    case "monthly":
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
        .toISOString().slice(0, 10)
    case "quarterly":
      return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1))
        .toISOString().slice(0, 10)
    case "annual":
      return new Date(Date.UTC(d.getUTCFullYear(), 0, 1)).toISOString().slice(0, 10)
    case "one_time":
      return today
    case "per_transaction":
      return null  // generated per-transaction event, not by cron
  }
  return null
}

function computePeriodEnd(cadence: FeeCadence, periodStart: string): string | null {
  const d = new Date(periodStart + "T00:00:00Z")
  switch (cadence) {
    case "monthly":
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
        .toISOString().slice(0, 10)
    case "quarterly":
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 0))
        .toISOString().slice(0, 10)
    case "annual":
      return new Date(Date.UTC(d.getUTCFullYear(), 11, 31)).toISOString().slice(0, 10)
    default:
      return null
  }
}

function computeDueDate(periodStart: string): string {
  const d = new Date(periodStart + "T00:00:00Z")
  d.setUTCDate(d.getUTCDate() + 14)
  return d.toISOString().slice(0, 10)
}

async function resolveAgentsForFeeType(ft: any, svc: ReturnType<typeof createServiceClient>): Promise<string[]> {
  if (ft.applies_to === "all_agents") {
    const { data } = await svc
      .from("agents")
      .select("id")
      .eq("brokerage_id", ft.brokerage_id)
    return (data ?? []).map((r: any) => r.id)
  }
  if (ft.applies_to === "specific_agents") {
    const { data } = await svc
      .from("agent_fee_assignments")
      .select("agent_id")
      .eq("fee_type_id", ft.id)
      .eq("is_active", true)
    return (data ?? []).map((r: any) => r.agent_id)
  }
  if (ft.applies_to === "team" && ft.applies_to_team) {
    const { data } = await svc
      .from("agents")
      .select("id")
      .eq("brokerage_id", ft.brokerage_id)
      .eq("team_id", ft.applies_to_team)
    return (data ?? []).map((r: any) => r.id)
  }
  if (ft.applies_to === "role" && ft.applies_to_role) {
    const { data: users } = await svc
      .from("users")
      .select("id")
      .eq("brokerage_id", ft.brokerage_id)
      .eq("user_type", ft.applies_to_role)
    const userIds = (users ?? []).map((u: any) => u.id)
    if (!userIds.length) return []
    const { data: agents } = await svc
      .from("agents")
      .select("id")
      // tenant anchor (scope burn-down): userIds already came from this brokerage's
      // users, but the agents rows themselves must also belong to the fee's brokerage.
      .eq("brokerage_id", ft.brokerage_id)
      .in("user_id", userIds)
    return (agents ?? []).map((a: any) => a.id)
  }
  return []
}
