// lib/platform/subscription-oversight.ts
//
// SUBSCRIPTION OVERSIGHT — the god-layer's "oversee + manage EVERY subscription" surface. The platform had
// cross-tenant MRR/margin analytics and per-tenant lifecycle buttons, but NO operational queue: trials about
// to lapse, payments past due, and renewals coming up were surfaced NOWHERE actionable, and there was no
// automated watch (dunning = a single notification, zero crons). This adds the missing operational spine:
// a PURE classifier that turns each tenant's subscription facts into one operational state + an attention
// flag, a cross-tenant rollup for the superadmin console, and an autonomous daily WATCH that alerts platform
// staff on the tenants that need a human (trial expiring / past due / renewal due). Reuses subscriptions +
// subscription_tiers + billing_invoices + the tenant registry — no new table; reconciles the two trial
// fields (subscriptions.trial_end and brokerages.trial_ends_at).

import { createServiceClient } from "@/lib/supabase/service"
import { notifyPlatformStaff } from "@/lib/notifications/platform-staff"

export type SubscriptionState =
  | "trialing" | "trial_expiring" | "active" | "renewal_due" | "past_due" | "cancelled" | "no_subscription"

/** Days-out thresholds that flip a trial/renewal into the attention queue. */
export const TRIAL_WARN_DAYS = 7
export const RENEWAL_WARN_DAYS = 7

export interface ClassifyInput {
  /** subscriptions.status (active/trialing/past_due/cancelled/…) — null when there is no subscription row. */
  status: string | null
  hasSubscription: boolean
  /** Reconciled trial end: subscriptions.trial_end ?? brokerages.trial_ends_at. */
  trialEnd: string | null
  currentPeriodEnd: string | null
  cancelAt: string | null
  cancelledAt: string | null
  /** Latest invoice status + due date (for past-due detection independent of subscription status). */
  latestInvoiceStatus: string | null
  latestInvoiceDue: string | null
}

export interface Classification {
  state: SubscriptionState
  daysToTrialEnd: number | null
  daysToRenewal: number | null
  /** True ⇒ this tenant needs a human (surfaced in the queue + alerted by the watch). */
  attention: boolean
  reason: string
}

/** PURE: turn a tenant's subscription facts into one operational state + attention flag. Deterministic. */
export function classifySubscription(input: ClassifyInput, now: Date): Classification {
  const t = now.getTime()
  const daysOut = (iso: string | null): number | null => (iso && !Number.isNaN(Date.parse(iso)) ? Math.ceil((Date.parse(iso) - t) / 86_400_000) : null)

  // Cancelled wins.
  if (input.status === "cancelled" || input.cancelledAt) {
    return { state: "cancelled", daysToTrialEnd: null, daysToRenewal: null, attention: false, reason: "Subscription cancelled." }
  }

  // Past due — billing failed. The most urgent operational state.
  const invPastDue = (input.latestInvoiceStatus === "open" || input.latestInvoiceStatus === "unpaid") &&
    !!input.latestInvoiceDue && !Number.isNaN(Date.parse(input.latestInvoiceDue)) && Date.parse(input.latestInvoiceDue) < t
  if (input.status === "past_due" || invPastDue) {
    return { state: "past_due", daysToTrialEnd: null, daysToRenewal: null, attention: true, reason: "Payment past due — billing failed and needs remediation before service lapses." }
  }

  // Trialing (either an explicit trialing status or a future trial-end date).
  const dTrial = daysOut(input.trialEnd)
  const inTrial = input.status === "trialing" || (dTrial !== null && dTrial >= 0)
  if (inTrial) {
    if (dTrial !== null && dTrial <= TRIAL_WARN_DAYS) {
      return { state: "trial_expiring", daysToTrialEnd: dTrial, daysToRenewal: null, attention: true, reason: `Trial ends in ${dTrial} day${dTrial === 1 ? "" : "s"} — convert to paid or it lapses.` }
    }
    return { state: "trialing", daysToTrialEnd: dTrial, daysToRenewal: null, attention: false, reason: dTrial !== null ? `In trial — ${dTrial} days left.` : "In trial." }
  }

  // No subscription and no trial on record — a tenant using the platform with no paid plan.
  if (!input.hasSubscription && !input.trialEnd) {
    return { state: "no_subscription", daysToTrialEnd: null, daysToRenewal: null, attention: false, reason: "No active subscription on record." }
  }

  // Active — flag an upcoming renewal so a human can confirm it will convert.
  const dRenew = daysOut(input.currentPeriodEnd)
  if (dRenew !== null && dRenew >= 0 && dRenew <= RENEWAL_WARN_DAYS) {
    return { state: "renewal_due", daysToTrialEnd: null, daysToRenewal: dRenew, attention: false, reason: `Renews in ${dRenew} day${dRenew === 1 ? "" : "s"}.` }
  }
  return { state: "active", daysToTrialEnd: null, daysToRenewal: dRenew, attention: false, reason: "Active." }
}

export interface SubscriptionOversightRow {
  brokerageId: string
  name: string
  tier: string
  state: SubscriptionState
  mrrCents: number
  daysToTrialEnd: number | null
  daysToRenewal: number | null
  attention: boolean
  reason: string
}

export interface SubscriptionOversight {
  rows: SubscriptionOversightRow[]
  /** Attention rows first (past_due, then trial_expiring), worst-first. */
  queue: SubscriptionOversightRow[]
  counts: Record<SubscriptionState, number>
  totalMrrCents: number
  attentionCount: number
}

const STATE_URGENCY: Record<SubscriptionState, number> = {
  past_due: 0, trial_expiring: 1, renewal_due: 2, no_subscription: 3, trialing: 4, active: 5, cancelled: 6,
}

/** PURE: roll up rows into counts + the attention queue (worst-first). */
export function summarizeOversight(rows: SubscriptionOversightRow[]): Omit<SubscriptionOversight, "rows"> {
  const counts = { trialing: 0, trial_expiring: 0, active: 0, renewal_due: 0, past_due: 0, cancelled: 0, no_subscription: 0 } as Record<SubscriptionState, number>
  let totalMrrCents = 0
  for (const r of rows) {
    counts[r.state] += 1
    if (r.state !== "cancelled" && r.state !== "no_subscription") totalMrrCents += r.mrrCents
  }
  const queue = rows.filter((r) => r.attention).sort((a, b) =>
    STATE_URGENCY[a.state] - STATE_URGENCY[b.state] ||
    (a.daysToTrialEnd ?? a.daysToRenewal ?? 99) - (b.daysToTrialEnd ?? b.daysToRenewal ?? 99) ||
    a.name.localeCompare(b.name),
  )
  return { queue, counts, totalMrrCents, attentionCount: queue.length }
}

type Svc = ReturnType<typeof createServiceClient>

/** Cross-tenant read — every tenant's subscription, classified, with the attention queue + counts. */
export async function loadSubscriptionOversight(client?: Svc, now: Date = new Date()): Promise<SubscriptionOversight> {
  const svc = client ?? createServiceClient()
  const [brokeragesR, subsR, tiersR, invoicesR] = await Promise.all([
    svc.from("brokerages").select("id, name, plan_tier, trial_ends_at, status").is("archived_at", null).limit(2000),
    svc.from("subscriptions").select("brokerage_id, tier_id, status, trial_end, current_period_end, cancel_at, cancelled_at").limit(2000),
    svc.from("subscription_tiers").select("id, display_name, monthly_price_cents").limit(200),
    svc.from("billing_invoices").select("brokerage_id, status, due_date, invoice_date").order("invoice_date", { ascending: false }).limit(5000),
  ])

  const subByBrokerage = new Map<string, any>()
  for (const s of (subsR.data ?? []) as any[]) if (!subByBrokerage.has(s.brokerage_id)) subByBrokerage.set(s.brokerage_id, s)
  const tierById = new Map<string, { display: string; priceCents: number }>()
  for (const t of (tiersR.data ?? []) as any[]) tierById.set(t.id, { display: t.display_name ?? t.tier_name, priceCents: Number(t.monthly_price_cents) || 0 })
  const latestInvoiceByBrokerage = new Map<string, any>()
  for (const inv of (invoicesR.data ?? []) as any[]) if (!latestInvoiceByBrokerage.has(inv.brokerage_id)) latestInvoiceByBrokerage.set(inv.brokerage_id, inv)

  const rows: SubscriptionOversightRow[] = []
  for (const b of (brokeragesR.data ?? []) as any[]) {
    if (b.status === "cancelled" || b.status === "archived") { /* still classify cancelled below via sub */ }
    const sub = subByBrokerage.get(b.id) ?? null
    const inv = latestInvoiceByBrokerage.get(b.id) ?? null
    const tier = sub?.tier_id ? tierById.get(sub.tier_id) : null
    const c = classifySubscription({
      status: sub?.status ?? (b.status === "cancelled" ? "cancelled" : null),
      hasSubscription: !!sub,
      trialEnd: sub?.trial_end ?? b.trial_ends_at ?? null, // reconcile the two trial fields
      currentPeriodEnd: sub?.current_period_end ?? null,
      cancelAt: sub?.cancel_at ?? null,
      cancelledAt: sub?.cancelled_at ?? (b.status === "cancelled" ? "cancelled" : null),
      latestInvoiceStatus: inv?.status ?? null,
      latestInvoiceDue: inv?.due_date ?? null,
    }, now)
    rows.push({
      brokerageId: b.id, name: (b.name ?? "").trim() || `Brokerage ${String(b.id).slice(0, 8)}`,
      tier: tier?.display ?? (b.plan_tier ?? "—"),
      state: c.state, mrrCents: tier?.priceCents ?? 0,
      daysToTrialEnd: c.daysToTrialEnd, daysToRenewal: c.daysToRenewal, attention: c.attention, reason: c.reason,
    })
  }

  const summary = summarizeOversight(rows)
  return { rows, ...summary }
}

const STATE_LABEL: Record<SubscriptionState, string> = {
  past_due: "Payment past due", trial_expiring: "Trial expiring", renewal_due: "Renewal due",
  no_subscription: "No subscription", trialing: "In trial", active: "Active", cancelled: "Cancelled",
}

/**
 * AUTONOMOUS WATCH — the missing dunning/renewal engine. Alerts platform staff (superadmin/support) on every
 * tenant that needs a human (past due / trial expiring), deduped per (brokerage, state) per day. Rides the
 * daily platform rollup cron. Best-effort. Returns how many were flagged + alerted.
 */
export async function runSubscriptionWatch(client?: Svc, now: Date = new Date()): Promise<{ attention: number; notified: number }> {
  const svc = client ?? createServiceClient()
  const { rows } = await loadSubscriptionOversight(svc, now)
  const attention = rows.filter((r) => r.attention)
  let notified = 0
  const since = new Date(now.getTime() - 20 * 3_600_000).toISOString()
  for (const r of attention) {
    const type = `subscription_watch:${r.state}`
    const { count } = await svc.from("notifications").select("id", { count: "exact", head: true })
      .eq("type", type).eq("entity_id", r.brokerageId).gte("created_at", since)
    if ((count ?? 0) > 0) continue // deduped per (tenant, state) per day
    const n = await notifyPlatformStaff(svc as any, {
      type, title: `Subscription — ${r.name}: ${STATE_LABEL[r.state]}`,
      body: r.reason, entityType: "subscription", entityId: r.brokerageId,
      priority: r.state === "past_due" ? "high" : "medium",
    })
    if (n > 0) notified++
  }
  return { attention: attention.length, notified }
}
