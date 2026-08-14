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
 *   listSuperadminAuditLogAction(limit)   — read the ledger (audit viewer page)
 *   issueRefundAction({brokerageId, reason, amountCents?})
 *
 * Lifecycle: active ⇄ suspended → cancelled → archived (terminal).
 *   active     → can do anything
 *   suspended  → all logins blocked, data retained (e.g. failed payment, abuse review)
 *   cancelled  → tenant chose to leave; billing stopped, 90d before archive
 *   archived   → eligible for purge (handled by separate cron, not this commit)
 */

import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import { requireSuperadmin } from "@/lib/auth/platform-guard"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import {
  stripeCancelAtPeriodEnd, stripeResume, stripeSwapPrice, stripeExtendTrial, stripePauseCollection,
  computeTrialExtension, isStripeConfigured,
} from "@/lib/billing/stripe-subscription-ops"

type CanonicalTier = "solo_agent" | "team" | "brokerage" | "multi_location"

// ─────────────────────────────────────────────────────────────────────────────
// THE GATE THIS FILE USED TO CARRY, AND WHY IT ADMITTED NOBODY
// ─────────────────────────────────────────────────────────────────────────────
//
// Every action here called a LOCAL requireSuperadmin() whose whole test was
// `users.user_type !== 'superadmin'`. Measured live: no row in public.users has
// user_type = 'superadmin'. The one platform superadmin account is
// platform_role = 'superadmin' with user_type = 'admin' — because 'admin' is
// also a TENANT user_type, the roster is deliberately carried on platform_role
// (lib/platform/platform-staff-roster.ts). So this gate returned "Forbidden" to
// EVERY caller, and /dashboard/superadmin/brokerages rendered
// "Failed: Forbidden" for the superadmin too. The subtree gate above it
// (requirePlatformStaff) let staff in; this one then refused them the data.
//
// lib/auth/platform-guard.ts:requireSuperadmin reads BOTH identity columns, which
// is the whole reason it exists. Importing it is the fix; the local copy is gone
// so it cannot drift again.
//
// READS vs WRITES. The owner's ruling is "platform needs to see all tenants and
// their users" — a READ grant for the platform staff roster, not for the
// superadmin alone. The two read-only actions below (listBrokeragesAction,
// getBrokerageDetailAction) therefore gate on the platform 'tenants' capability,
// which is exactly what the two PAGES that call them already gate on
// (requirePlatformCapability("tenants") in brokerages/page.tsx and
// brokerages/[id]/page.tsx) — before this change a platform admin/support/
// marketing operator could open those pages and was then handed "Forbidden" by
// the action, which is a gate disagreeing with itself. Every MUTATION in this
// file (tier change, suspend, cancel, refund, trial, pause) stays superadmin-only.

/** Read-only tenant oversight: the platform 'tenants' capability, which the
 *  capability map grants to all four staff roles. Same gate as the pages. */
async function requireTenantRead(): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await requirePlatformCapability("tenants")
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  return { ok: true }
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
  const auth = await requireTenantRead()   // read-only: the whole staff roster
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
  const auth = await requireTenantRead()   // read-only: the whole staff roster
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

  // Keep subscriptions.tier_id in lockstep with plan_tier (fixes the drift where tier change wrote only
  // brokerages.plan_tier), and reprice the Stripe subscription to the new tier's price when configured.
  let stripeApplied = false
  const { data: tierRow } = await svc.from("subscription_tiers").select("id, stripe_price_id").eq("tier_name", params.newTier).maybeSingle()
  const { data: sub } = await svc.from("subscriptions").select("id, stripe_subscription_id").eq("brokerage_id", params.brokerageId).in("status", ["active", "trialing", "past_due", "paused"]).maybeSingle()
  if (tierRow && sub) {
    await svc.from("subscriptions").update({ tier_id: (tierRow as any).id, updated_at: new Date().toISOString() }).eq("id", (sub as any).id)
    const r = await stripeSwapPrice((sub as any).stripe_subscription_id, (tierRow as any).stripe_price_id)
    stripeApplied = r.applied
  }

  // AI ENTITLEMENT ROW (burn-down round 6): lib/security/authorization.ts gates
  // admin AI operations on ai_subscription_tier — writer-less, so NO admin
  // could ever pass the entitlement check. Tier changes keep it in lockstep:
  // one active row per brokerage, admin_user_id = the brokerage's admin/broker.
  try {
    const { data: adminUser } = await svc
      .from("users").select("id").eq("brokerage_id", params.brokerageId)
      .in("user_type", ["broker", "admin", "broker_owner"])
      .order("created_at", { ascending: true }).limit(1).maybeSingle()
    if (adminUser) {
      const { data: existingTier } = await svc
        .from("ai_subscription_tier").select("id").eq("brokerage_id", params.brokerageId).maybeSingle()
      const tierRowPayload = {
        brokerage_id: params.brokerageId,
        tier_name: params.newTier,
        is_active: true,
        admin_user_id: (adminUser as any).id,
        subscribed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      if (existingTier) await svc.from("ai_subscription_tier").update(tierRowPayload).eq("id", (existingTier as any).id)
      else await svc.from("ai_subscription_tier").insert(tierRowPayload)
    }
  } catch { /* entitlement sync is best-effort — the audit log below is the record */ }

  await writeAuditLog({
    actorUserId: auth.userId,
    actorEmail:  auth.email,
    action:      "brokerage.tier_changed",
    targetType:  "brokerage",
    targetId:    params.brokerageId,
    details:     { previous_tier: previousTier, new_tier: params.newTier, reason: params.reason ?? null, stripe_applied: stripeApplied },
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

  // Resume Stripe billing (undo any pending cancel / pause) + un-cancel the local subscription.
  const { data: sub } = await svc.from("subscriptions").select("id, stripe_subscription_id, status").eq("brokerage_id", brokerageId).order("created_at", { ascending: false }).limit(1).maybeSingle()
  let stripeApplied = false
  if (sub) {
    await svc.from("subscriptions").update({ status: "active", cancel_at: null, cancelled_at: null, updated_at: new Date().toISOString() }).eq("id", (sub as any).id)
    stripeApplied = (await stripeResume((sub as any).stripe_subscription_id)).applied
  }

  await writeAuditLog({
    actorUserId: auth.userId,
    actorEmail:  auth.email,
    action:      "brokerage.reactivated",
    targetType:  "brokerage",
    targetId:    brokerageId,
    details:     { stripe_applied: stripeApplied },
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

  // Cancel through to Stripe (at period end) so billing actually stops — not just the local row.
  const { data: subs } = await svc.from("subscriptions").select("id, stripe_subscription_id").eq("brokerage_id", params.brokerageId).in("status", ["active", "trialing", "past_due", "paused"])
  let stripeApplied = false
  for (const s of (subs ?? []) as any[]) {
    const r = await stripeCancelAtPeriodEnd(s.stripe_subscription_id)
    if (r.applied) stripeApplied = true
  }
  await svc.from("subscriptions")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("brokerage_id", params.brokerageId)
    .in("status", ["active", "trialing", "past_due", "paused"])

  await writeAuditLog({
    actorUserId: auth.userId,
    actorEmail:  auth.email,
    action:      "brokerage.cancelled",
    targetType:  "brokerage",
    targetId:    params.brokerageId,
    details:     { reason: params.reason.trim(), stripe_applied: stripeApplied },
  })

  revalidatePath(`/dashboard/superadmin/brokerages/${params.brokerageId}`)
  revalidatePath("/dashboard/superadmin/brokerages")
  return { ok: true }
}

// ── SUBSCRIPTION PRIMITIVES: EXTEND TRIAL (COMP) / PAUSE ─────────────────────

/** Extend a tenant's trial by N days (a comp / free time). Writes local trial_end + brokerages.trial_ends_at
 *  and pushes trial_end to Stripe when configured. */
export async function extendTrialAction(params: { brokerageId: string; days: number; reason?: string }): Promise<{ ok: boolean; error?: string; newTrialEnd?: string; stripeApplied?: boolean }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const days = Math.floor(params.days)
  if (!(days > 0) || days > 365) return { ok: false, error: "Days must be 1–365" }
  const svc = createServiceClient()
  const now = new Date()

  const { data: sub } = await svc.from("subscriptions").select("id, stripe_subscription_id, trial_end").eq("brokerage_id", params.brokerageId).order("created_at", { ascending: false }).limit(1).maybeSingle()
  const { data: brk } = await svc.from("brokerages").select("trial_ends_at").eq("id", params.brokerageId).maybeSingle()
  const currentEnd = (sub as any)?.trial_end ?? (brk as any)?.trial_ends_at ?? null
  const ext = computeTrialExtension(currentEnd, days, now)

  if (sub) await svc.from("subscriptions").update({ trial_end: ext.iso, status: "trialing", updated_at: now.toISOString() }).eq("id", (sub as any).id)
  await svc.from("brokerages").update({ trial_ends_at: ext.iso, updated_at: now.toISOString() }).eq("id", params.brokerageId)
  const stripeApplied = (await stripeExtendTrial((sub as any)?.stripe_subscription_id, ext.unix)).applied

  await writeAuditLog({ actorUserId: auth.userId, actorEmail: auth.email, action: "subscription.trial_extended", targetType: "brokerage", targetId: params.brokerageId, details: { days, new_trial_end: ext.iso, reason: params.reason ?? null, stripe_applied: stripeApplied } })
  revalidatePath(`/dashboard/superadmin/brokerages/${params.brokerageId}`)
  revalidatePath("/dashboard/superadmin/subscriptions")
  return { ok: true, newTrialEnd: ext.iso, stripeApplied }
}

/** Pause (or resume) a tenant's billing without cancelling — comp a break. Local status paused/active +
 *  Stripe pause_collection when configured. */
export async function pauseSubscriptionAction(params: { brokerageId: string; pause: boolean; reason?: string }): Promise<{ ok: boolean; error?: string; stripeApplied?: boolean }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data: sub } = await svc.from("subscriptions").select("id, stripe_subscription_id, status").eq("brokerage_id", params.brokerageId).order("created_at", { ascending: false }).limit(1).maybeSingle()
  if (!sub) return { ok: false, error: "No subscription to pause" }

  await svc.from("subscriptions").update({ status: params.pause ? "paused" : "active", updated_at: new Date().toISOString() }).eq("id", (sub as any).id)
  const stripeApplied = (await stripePauseCollection((sub as any).stripe_subscription_id, params.pause)).applied

  await writeAuditLog({ actorUserId: auth.userId, actorEmail: auth.email, action: params.pause ? "subscription.paused" : "subscription.resumed", targetType: "brokerage", targetId: params.brokerageId, details: { reason: params.reason ?? null, stripe_applied: stripeApplied } })
  revalidatePath(`/dashboard/superadmin/brokerages/${params.brokerageId}`)
  revalidatePath("/dashboard/superadmin/subscriptions")
  return { ok: true, stripeApplied }
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

// ── REFUND (platform tooling gap — the ONE billing op that was missing) ──────
// Refunds the tenant's most recent PAID invoice (full, or partial cents)
// through Stripe, reason-logged to the superadmin audit ledger like every
// other lifecycle action. Local intent is the audit row; Stripe is the money.
export async function issueRefundAction(params: {
  brokerageId: string
  reason: string
  /** Omit for a full refund of the latest paid invoice. */
  amountCents?: number | null
}): Promise<{ ok: boolean; refundedCents?: number | null; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!params.reason?.trim()) return { ok: false, error: "A reason is required for every refund" }

  const svc = createServiceClient()
  const { data: sub } = await svc
    .from("subscriptions")
    .select("id, stripe_subscription_id")
    .eq("brokerage_id", params.brokerageId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!sub?.stripe_subscription_id) return { ok: false, error: "No Stripe-linked subscription for this tenant" }

  const { stripeRefundLatestInvoice } = await import("@/lib/billing/stripe-subscription-ops")
  const r = await stripeRefundLatestInvoice((sub as any).stripe_subscription_id, params.amountCents ?? null)
  if (!r.applied) return { ok: false, error: r.error ?? (r.skipped ? "Stripe not configured" : "Refund failed") }

  await writeAuditLog({
    actorUserId: auth.userId,
    actorEmail: auth.email,
    action: "brokerage.refund_issued",
    targetType: "brokerage",
    targetId: params.brokerageId,
    details: { reason: params.reason.trim(), amount_cents: params.amountCents ?? "full_latest_invoice", refunded_cents: (r as any).refundedCents ?? null },
  })

  revalidatePath(`/dashboard/superadmin/brokerages/${params.brokerageId}`)
  return { ok: true, refundedCents: (r as any).refundedCents ?? null }
}
