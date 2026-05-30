"use server"

/**
 * Superadmin brokerage lifecycle management.
 *
 * Every action gates on user_type='superadmin' and writes a row to
 * superadmin_audit_log so the chain of custody on tier/state changes is
 * complete — state RE commissions occasionally audit broker-tools, and
 * "who changed what when" is table stakes.
 *
 * Actions:
 *   listBrokeragesAction(filter)         — full cross-tenant list
 *   getBrokerageDetailAction(brokerageId)
 *   changeBrokerageTierAction({brokerageId, newTier})
 *   suspendBrokerageAction({brokerageId, reason})
 *   reactivateBrokerageAction({brokerageId})
 *   cancelBrokerageAction({brokerageId, reason})
 *   listAuditLogAction(filter)
 *
 * Lifecycle: active ⇄ suspended → cancelled → archived (terminal).
 *   active     → can do anything
 *   suspended  → all logins blocked, data retained (e.g. failed payment, abuse review)
 *   cancelled  → tenant chose to leave; billing stopped, 90d before archive
 *   archived   → eligible for purge (handled by separate cron, not this commit)
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { headers } from "next/headers"

type CanonicalTier = "solo_agent" | "team" | "brokerage" | "multi_location"

async function requireSuperadmin(): Promise<
  | { ok: true; userId: string; email: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase
    .from("users")
    .select("user_type, email")
    .eq("id", user.id)
    .maybeSingle()
  if (data?.user_type !== "superadmin") return { ok: false, error: "Forbidden" }
  return { ok: true, userId: user.id, email: data.email ?? user.email ?? "" }
}

async function writeAuditLog(params: {
  actorUserId: string
  actorEmail:  string
  action:      string
  targetType:  string
  targetId?:   string
  details:     Record<string, unknown>
}): Promise<void> {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: params.actorUserId,
      actor_email:   params.actorEmail,
      action:        params.action,
      target_type:   params.targetType,
      target_id:     params.targetId ?? null,
      details:       params.details,
      ip_address:    hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
      user_agent:    hdrs.get("user-agent"),
    })
  } catch (err) {
    console.error("[superadmin-audit] write failed:", err)
    // Non-fatal — audit failure shouldn't block the underlying action
  }
}

// ── LIST ─────────────────────────────────────────────────────────────────────

export interface BrokerageListRow {
  id:                 string
  name:               string | null
  plan_tier:          CanonicalTier
  tier_display_name:  string | null
  status:             "active" | "suspended" | "cancelled" | "archived"
  signup_source:      string
  onboarding_status:  string
  mrr_cents:          number
  ai_cost_cents:      number
  margin_cents:       number
  margin_percent:     number | null
  quota_status:       string | null
  team_member_count:  number
  pending_invites:    number
  trial_ends_at:      string | null
  created_at:         string
  city:               string | null
  state:              string | null
}

export async function listBrokeragesAction(filter?: {
  status?:   "active" | "suspended" | "cancelled" | "archived"
  tier?:     CanonicalTier
  search?:   string
}): Promise<
  | { ok: true; rows: BrokerageListRow[]; totals: { count: number; total_mrr_cents: number; total_ai_cents: number } }
  | { ok: false; error: string }
> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  // Pull from v_platform_margin (Commit B) + brokerages base + onboarding rollup
  const { data: marginRows, error: marginErr } = await svc.from("v_platform_margin").select("*")
  if (marginErr) return { ok: false, error: marginErr.message }

  const { data: brokerages, error: bErr } = await svc
    .from("brokerages")
    .select("id, name, plan_tier, status, signup_source, onboarding_status, trial_ends_at, created_at, city, state")
  if (bErr) return { ok: false, error: bErr.message }

  const { data: progressRows } = await svc
    .from("v_brokerage_onboarding_progress")
    .select("brokerage_id, team_member_count, pending_invites")

  const marginMap   = new Map((marginRows ?? []).map((r: any) => [r.brokerage_id, r]))
  const progressMap = new Map((progressRows ?? []).map((r: any) => [r.brokerage_id, r]))

  const allRows: BrokerageListRow[] = (brokerages ?? []).map((b: any) => {
    const m = marginMap.get(b.id) as any
    const p = progressMap.get(b.id) as any
    return {
      id:                b.id,
      name:              b.name,
      plan_tier:         (b.plan_tier ?? "solo_agent") as CanonicalTier,
      tier_display_name: m?.tier_display_name ?? null,
      status:            (b.status ?? "active") as BrokerageListRow["status"],
      signup_source:     b.signup_source ?? "superadmin",
      onboarding_status: b.onboarding_status ?? "pending",
      mrr_cents:         Number(m?.mrr_cents ?? 0),
      ai_cost_cents:     Number(m?.ai_cost_cents ?? 0),
      margin_cents:      Number(m?.margin_cents ?? 0),
      margin_percent:    m?.margin_percent !== null && m?.margin_percent !== undefined ? Number(m.margin_percent) : null,
      quota_status:      m?.quota_status ?? null,
      team_member_count: Number(p?.team_member_count ?? 0),
      pending_invites:   Number(p?.pending_invites ?? 0),
      trial_ends_at:     b.trial_ends_at,
      created_at:        b.created_at,
      city:              b.city,
      state:             b.state,
    }
  })

  let filtered = allRows
  if (filter?.status) filtered = filtered.filter(r => r.status === filter.status)
  if (filter?.tier)   filtered = filtered.filter(r => r.plan_tier === filter.tier)
  if (filter?.search) {
    const q = filter.search.toLowerCase()
    filtered = filtered.filter(r =>
      (r.name?.toLowerCase().includes(q)) ||
      (r.city?.toLowerCase().includes(q)) ||
      (r.state?.toLowerCase().includes(q))
    )
  }

  return {
    ok: true,
    rows: filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    totals: {
      count:           filtered.length,
      total_mrr_cents: filtered.reduce((s, r) => s + r.mrr_cents, 0),
      total_ai_cents:  filtered.reduce((s, r) => s + r.ai_cost_cents, 0),
    },
  }
}

// ── DETAIL ───────────────────────────────────────────────────────────────────

export async function getBrokerageDetailAction(brokerageId: string): Promise<
  | { ok: true; brokerage: any; users: any[]; subscriptions: any[]; auditEntries: any[] }
  | { ok: false; error: string }
> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  const [{ data: brokerage, error }, { data: users }, { data: subs }, { data: audit }] = await Promise.all([
    svc.from("brokerages").select("*").eq("id", brokerageId).maybeSingle(),
    svc.from("users").select("id, email, first_name, last_name, user_type, created_at").eq("brokerage_id", brokerageId).order("created_at", { ascending: false }).limit(50),
    svc.from("subscriptions").select("id, tier_id, status, current_period_start, current_period_end, created_at").eq("brokerage_id", brokerageId).order("created_at", { ascending: false }).limit(10),
    svc.from("superadmin_audit_log").select("id, action, actor_email, details, created_at").eq("target_type", "brokerage").eq("target_id", brokerageId).order("created_at", { ascending: false }).limit(30),
  ])
  if (error || !brokerage) return { ok: false, error: error?.message ?? "Not found" }

  return { ok: true, brokerage, users: users ?? [], subscriptions: subs ?? [], auditEntries: audit ?? [] }
}

// ── TIER CHANGE ──────────────────────────────────────────────────────────────

export async function changeBrokerageTierAction(params: {
  brokerageId: string
  newTier:     CanonicalTier
  reason?:     string
}): Promise<{ ok: boolean; error?: string; previousTier?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  if (!["solo_agent","team","brokerage","multi_location"].includes(params.newTier)) {
    return { ok: false, error: "Invalid tier" }
  }
  const svc = createServiceClient()

  const { data: current } = await svc
    .from("brokerages")
    .select("plan_tier")
    .eq("id", params.brokerageId)
    .maybeSingle()
  if (!current) return { ok: false, error: "Brokerage not found" }

  const previousTier = current.plan_tier as string
  if (previousTier === params.newTier) return { ok: true, previousTier }

  const { error } = await svc
    .from("brokerages")
    .update({ plan_tier: params.newTier, updated_at: new Date().toISOString() })
    .eq("id", params.brokerageId)
  if (error) return { ok: false, error: error.message }

  await writeAuditLog({
    actorUserId: auth.userId,
    actorEmail:  auth.email,
    action:      "brokerage.tier_changed",
    targetType:  "brokerage",
    targetId:    params.brokerageId,
    details:     { previous_tier: previousTier, new_tier: params.newTier, reason: params.reason ?? null },
  })

  revalidatePath(`/dashboard/superadmin/brokerages/${params.brokerageId}`)
  revalidatePath("/dashboard/superadmin/brokerages")
  return { ok: true, previousTier }
}

// ── SUSPEND / REACTIVATE / CANCEL ────────────────────────────────────────────

export async function suspendBrokerageAction(params: {
  brokerageId: string
  reason:      string
}): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  if (!params.reason || params.reason.trim().length < 5) {
    return { ok: false, error: "Suspend reason required (5+ chars)" }
  }
  const svc = createServiceClient()
  const { error } = await svc
    .from("brokerages")
    .update({
      status:       "suspended",
      suspended_at: new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    })
    .eq("id", params.brokerageId)
    .neq("status", "archived")
  if (error) return { ok: false, error: error.message }

  await writeAuditLog({
    actorUserId: auth.userId,
    actorEmail:  auth.email,
    action:      "brokerage.suspended",
    targetType:  "brokerage",
    targetId:    params.brokerageId,
    details:     { reason: params.reason.trim() },
  })

  revalidatePath(`/dashboard/superadmin/brokerages/${params.brokerageId}`)
  revalidatePath("/dashboard/superadmin/brokerages")
  return { ok: true }
}

export async function reactivateBrokerageAction(brokerageId: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { error } = await svc
    .from("brokerages")
    .update({
      status:       "active",
      suspended_at: null,
      updated_at:   new Date().toISOString(),
    })
    .eq("id", brokerageId)
    .eq("status", "suspended")
  if (error) return { ok: false, error: error.message }

  await writeAuditLog({
    actorUserId: auth.userId,
    actorEmail:  auth.email,
    action:      "brokerage.reactivated",
    targetType:  "brokerage",
    targetId:    brokerageId,
    details:     {},
  })

  revalidatePath(`/dashboard/superadmin/brokerages/${brokerageId}`)
  revalidatePath("/dashboard/superadmin/brokerages")
  return { ok: true }
}

export async function cancelBrokerageAction(params: {
  brokerageId: string
  reason:      string
}): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  if (!params.reason || params.reason.trim().length < 5) {
    return { ok: false, error: "Cancellation reason required (5+ chars)" }
  }
  const svc = createServiceClient()
  const { error } = await svc
    .from("brokerages")
    .update({
      status:       "cancelled",
      cancelled_at: new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    })
    .eq("id", params.brokerageId)
  if (error) return { ok: false, error: error.message }

  // Also cancel any active subscriptions so billing webhook doesn't keep charging
  await svc.from("subscriptions")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("brokerage_id", params.brokerageId)
    .in("status", ["active", "trialing"])

  await writeAuditLog({
    actorUserId: auth.userId,
    actorEmail:  auth.email,
    action:      "brokerage.cancelled",
    targetType:  "brokerage",
    targetId:    params.brokerageId,
    details:     { reason: params.reason.trim() },
  })

  revalidatePath(`/dashboard/superadmin/brokerages/${params.brokerageId}`)
  revalidatePath("/dashboard/superadmin/brokerages")
  return { ok: true }
}

// ── AUDIT LOG ────────────────────────────────────────────────────────────────

export async function listSuperadminAuditLogAction(limit = 100): Promise<
  | { ok: true; rows: Array<{ id: string; actor_email: string | null; action: string; target_type: string; target_id: string | null; details: Record<string, unknown>; created_at: string }> }
  | { ok: false; error: string }
> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("superadmin_audit_log")
    .select("id, actor_email, action, target_type, target_id, details, created_at")
    .order("created_at", { ascending: false })
    .limit(limit)
  if (error) return { ok: false, error: error.message }
  return { ok: true, rows: (data ?? []) as any[] }
}
