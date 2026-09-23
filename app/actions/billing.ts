"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { KernelEvent } from "@/lib/kernel/events"
import { toPlanTier } from "@/lib/billing/plan-tier"
import { currentBillingPeriodLabel } from "@/lib/usage/period"

// TRUE ADMIN GATE, brokerage-wide MONEY (billing): derived from THE finance
// roster (admin/broker/broker_owner — mirrors public.is_brokerage_finance_admin,
// m472) instead of a retyped list. 'superadmin'/'super_admin' were dead here —
// tested against users.user_type, where 0 live rows store either spelling.
import { BROKERAGE_FINANCE_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
const BILLING_ADMIN_ROLES = BROKERAGE_FINANCE_ADMIN_USER_TYPES

/**
 * Open the Stripe billing portal for the caller's brokerage — self-serve card /
 * invoices / cancellation, parity with the vendor flow (one shared implementation).
 */
export async function createBrokerageBillingPortalAction(returnUrl?: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data: u } = await supabase.from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  if (!BILLING_ADMIN_ROLES.has((u as any).user_type ?? "")) return { ok: false, error: "Only an admin/broker can manage billing" }

  const { data: sub } = await supabase.from("subscriptions").select("stripe_customer_id").eq("brokerage_id", u.brokerage_id).not("stripe_customer_id", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle()
  const base = returnUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? ""
  try {
    const { createBillingPortalUrl } = await import("@/lib/billing/stripe-portal")
    return { ok: true, url: await createBillingPortalUrl((sub as any)?.stripe_customer_id, `${base}/dashboard/admin/billing`) }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Could not open the billing portal" }
  }
}

// ─── CANCELLATION SAVE-OFFER ─────────────────────────────────────────────────
// The retention step before cancel. The offer coupon is configured by platform
// staff (platform_settings.retention_offer → a platform_coupons code); a tenant
// is only ever shown an offer they are actually eligible to redeem (same rules
// as a manual redemption — lib/platform/save-offer.ts). Honest empty: no offer
// configured or ineligible ⇒ { offer: null } and the cancel flow proceeds.

async function requireTenantBillingAdmin(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data: u } = await supabase.from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  if (!BILLING_ADMIN_ROLES.has((u as any).user_type ?? "")) return { ok: false, error: "Only an admin/broker can manage billing" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id as string }
}

/** Load the save-offer context for the caller's brokerage: config + coupon +
 *  tier price + prior-redemption flag, resolved through the pure layer. */
async function loadSaveOfferResolution(brokerageId: string) {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { resolveRetentionOfferConfig, resolveSaveOffer } = await import("@/lib/platform/save-offer")
  const svc = createServiceClient()

  // retention_offer column may not be migrated yet — fail soft to "not configured".
  let rawConfig: any = null
  try {
    const { data } = await svc.from("platform_settings").select("retention_offer").limit(1).maybeSingle()
    rawConfig = (data as any)?.retention_offer
  } catch { rawConfig = null }
  const config = resolveRetentionOfferConfig(rawConfig)

  const [brokerageRes, subRes] = await Promise.all([
    svc.from("brokerages").select("plan_tier").eq("id", brokerageId).maybeSingle(),
    svc
      .from("subscriptions")
      .select("id, stripe_subscription_id, status, subscription_tiers:tier_id(monthly_price_cents)")
      .eq("brokerage_id", brokerageId)
      .in("status", ["active", "trialing", "past_due"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  let coupon: any = null
  let existingRedemption = false
  if (config.couponCode) {
    const { data: couponRow } = await svc
      .from("platform_coupons")
      .select("id, code, description, percent_off, amount_off_cents, duration, duration_months, applies_to_tier, max_redemptions, redeemed_count, expires_at, active, stripe_coupon_id")
      .eq("code", config.couponCode)
      .maybeSingle()
    coupon = couponRow ?? null
    if (coupon) {
      const { data: existing } = await svc
        .from("platform_coupon_redemptions")
        .select("id")
        .eq("coupon_id", coupon.id)
        .eq("brokerage_id", brokerageId)
        .maybeSingle()
      existingRedemption = !!existing
    }
  }

  // plan_tier only — the save-offer a churning tenant is shown must key off the
  // tier they are actually BILLED on, not an unmaintained twin (m306).
  const tier = toPlanTier((brokerageRes.data as any)?.plan_tier)
  const monthlyPriceCents = Number((subRes.data as any)?.subscription_tiers?.monthly_price_cents ?? 0)
  const resolution = resolveSaveOffer({
    config, coupon, tier, monthlyPriceCents, existingRedemption, now: new Date(),
  })
  return { resolution, coupon, subscription: subRes.data as any, svc }
}

export async function getCancellationSaveOfferAction(): Promise<
  | { ok: true; offer: import("@/lib/platform/save-offer").SaveOffer | null }
  | { ok: false; error: string }
> {
  const gate = await requireTenantBillingAdmin()
  if (!gate.ok) return { ok: false, error: gate.error }
  try {
    const { resolution } = await loadSaveOfferResolution(gate.brokerageId)
    return { ok: true, offer: resolution.offer ?? null }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Could not load the save-offer" }
  }
}

/**
 * Accept the save-offer INSTEAD of cancelling. The offer is re-derived
 * server-side (the client never picks the coupon): redemption row first
 * (UNIQUE(coupon_id, brokerage_id) is the concurrency guard), derived
 * redeemed_count, then the discount is pushed to Stripe when both the coupon
 * and the subscription are live there (mock/unconfigured ⇒ honest skip; the
 * ledger row is still the source of intent). Audited to audit_log.
 */
export async function acceptCancellationSaveOfferAction(): Promise<
  | { ok: true; summary: string }
  | { ok: false; error: string }
> {
  const gate = await requireTenantBillingAdmin()
  if (!gate.ok) return { ok: false, error: gate.error }

  try {
    const { resolution, coupon, subscription, svc } = await loadSaveOfferResolution(gate.brokerageId)
    if (!resolution.offer || !coupon) {
      const detail = resolution.offer ? null : (resolution as { detail?: string }).detail
      return { ok: false, error: detail || "No save-offer is available for this account" }
    }

    // 1) Redemption row first — the unique constraint is the double-redeem guard.
    const { error: insErr } = await svc.from("platform_coupon_redemptions").insert({
      coupon_id: coupon.id,
      brokerage_id: gate.brokerageId,
      redeemed_by: gate.userId,
    })
    if (insErr) {
      if ((insErr as any).code === "23505") return { ok: false, error: "This offer was already redeemed for your account" }
      return { ok: false, error: insErr.message }
    }

    // 2) redeemed_count = COUNT(ledger) — derived, never a stale +1.
    const { count } = await svc.from("platform_coupon_redemptions").select("id", { count: "exact", head: true }).eq("coupon_id", coupon.id)
    const { error: cntErr } = await svc.from("platform_coupons").update({ redeemed_count: count ?? (coupon.redeemed_count ?? 0) + 1 }).eq("id", coupon.id)
    if (cntErr) console.error("[save-offer] redeemed_count sync failed (ledger row exists):", cntErr.message)

    // 3) Push the discount to Stripe (skips honestly when mock/unlinked).
    const { stripeApplyCoupon } = await import("@/lib/billing/stripe-subscription-ops")
    const stripeRes = await stripeApplyCoupon(subscription?.stripe_subscription_id, coupon.stripe_coupon_id)
    if (stripeRes.error) console.error("[save-offer] Stripe discount apply failed (ledger row kept):", stripeRes.error)

    // 4) Audit — a retention acceptance is a billing event.
    await svc.from("audit_log").insert({
      user_id: gate.userId,
      action: "retention_offer_accepted",
      entity_type: "subscription",
      entity_id: subscription?.id ?? null,
      after: {
        brokerage_id: gate.brokerageId,
        coupon_code: coupon.code,
        summary: resolution.offer.summary,
        stripe_applied: stripeRes.applied,
        stripe_skipped: stripeRes.skipped,
      },
    })

    const { revalidatePath } = await import("next/cache")
    revalidatePath("/settings/billing")
    return { ok: true, summary: resolution.offer.summary }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Could not apply the offer" }
  }
}

// ─── GET SUBSCRIPTION TIERS ──────────────────────────────────────────────────
export async function getSubscriptionTiers() {
  const supabase = await createClient()

  const { data: tiers, error } = await supabase
    .from("subscription_tiers")
    .select("*")
    .eq("is_active", true)
    .order("monthly_price_cents", { ascending: true })

  if (error) throw error
  return tiers || []
}

// ─── GET CURRENT SUBSCRIPTION ────────────────────────────────────────────────
export async function getCurrentSubscription(_brokerageId?: string) {
  // AUTH GATE — was returning any brokerage's subscription by id.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return null
  }

  const supabase = await createClient()

  const { data: subscription, error } = await supabase
    .from("subscriptions")
    .select(`
      *,
      subscription_tiers:tier_id(*)
    `)
    .eq("brokerage_id", ctx.brokerageId)
    .in("status", ["active", "trialing", "past_due"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return subscription
}

// ─── GET BILLING USAGE ───────────────────────────────────────────────────────
export async function getBillingUsage(_brokerageId?: string) {
  // AUTH GATE — was returning any brokerage's billing usage.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return null
  const supabase = await createClient()

  // PERIOD KEY — the same UTC billing month the writer stamps
  // (lib/kernel/billing.ts recordUsageEvent, via lib/usage/period.ts).
  // "newest row by recorded_at" is not the same question as "this month's
  // usage": on the first day of a new month, before any event is recorded, the
  // unkeyed read hands the Active Agents / AI Calls / Storage / Video bars LAST
  // month's totals and labels them as current. Now an unstarted month reads as
  // an unstarted month.
  const { data: usage, error } = await supabase
    .from("billing_usage")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("period_label", currentBillingPeriodLabel())
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return usage
}

// ─── GET INVOICE HISTORY ─────────────────────────────────────────────────────
export async function getInvoiceHistory(_brokerageId?: string, year?: number) {
  // AUTH GATE — was returning any brokerage's invoice history (PII +
  // financial data).
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return []
  const supabase = await createClient()

  let query = supabase
    .from("billing_invoices")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
    .order("invoice_date", { ascending: false })

  if (year) {
    const startOfYear = `${year}-01-01`
    const endOfYear = `${year}-12-31`
    query = query.gte("invoice_date", startOfYear).lte("invoice_date", endOfYear)
  }

  const { data: invoices, error } = await query

  if (error) throw error
  return invoices || []
}

// ─── START SUBSCRIPTION CHECKOUT ─────────────────────────────────────────────
export async function startSubscriptionCheckout(
  _brokerageId: string, // ignored — derived from session
  tierId: string,
  billingCycle: "monthly" | "annual"
) {
  // AUTH GATE — was creating Stripe checkout sessions on any brokerage id,
  // letting a caller initiate paid subscription changes for tenants they
  // don't belong to. Now scoped to caller's brokerage + admin role only.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    throw new Error("Unauthorized")
  }

  const supabase = await createClient()

  const { data: u } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", ctx.userId)
    .maybeSingle()
  const userType = u?.user_type ?? ctx.userType
  if (!BILLING_ADMIN_ROLES.has(userType)) {
    throw new Error("Forbidden: admin only")
  }

  const brokerageId = ctx.brokerageId

  // Get the tier
  const { data: tier, error: tierError } = await supabase
    .from("subscription_tiers")
    .select("*")
    .eq("id", tierId)
    .single()

  if (tierError || !tier) throw new Error("Tier not found")

  // Get brokerage info for customer
  const { data: brokerage, error: brokerageError } = await supabase
    .from("brokerages")
    .select("name, email")
    .eq("id", brokerageId)
    .single()

  if (brokerageError || !brokerage) throw new Error("Brokerage not found")

  // Check if brokerage already has a Stripe customer
  const { data: existingSub } = await supabase
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("brokerage_id", brokerageId)
    .not("stripe_customer_id", "is", null)
    .limit(1)
    .maybeSingle()

  let customerId = existingSub?.stripe_customer_id

  // Create customer if not exists
  if (!customerId) {
    const { stripe } = await import("@/lib/stripe")
    const customer = await stripe.customers.create({
      email: brokerage.email || undefined,
      name: brokerage.name,
      metadata: {
        brokerage_id: brokerageId,
      },
    })
    customerId = customer.id
  }

  const { stripe } = await import("@/lib/stripe")

  // Collect the recurring plan + a one-time SETUP FEE on the first invoice.
  const { buildCheckoutConfig, buildCheckoutTaxConfig } = await import("@/lib/billing/subscription-activation")
  const { lineItems, addInvoiceItems } = buildCheckoutConfig(tier as any, billingCycle)

  // Stripe Tax rides the platform flag (requires a live Stripe Tax registration).
  const { data: platformRow } = await supabase.from("platform_settings").select("collect_tax").limit(1).maybeSingle()
  const taxConfig = buildCheckoutTaxConfig((platformRow as any)?.collect_tax === true)

  // Create checkout session for subscription
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    ui_mode: "embedded",
    mode: "subscription",
    ...(taxConfig as any),
    // The one-time setup fee rides line_items (a non-recurring price lands on
    // the FIRST invoice only in subscription mode). Lane 79D: it was passed as
    // subscription_data.add_invoice_items, a parameter Checkout Sessions reject
    // — see lib/billing/subscription-activation.ts CheckoutConfig.
    line_items: [...lineItems, ...addInvoiceItems] as any,
    subscription_data: {
      metadata: {
        brokerage_id: brokerageId,
        tier_id: tierId,
        tier_name: tier.tier_name,
      },
    },
    // Also stamp the session so checkout.session.completed can resolve the tenant.
    metadata: { brokerage_id: brokerageId, tier_id: tierId, tier_name: tier.tier_name },
    redirect_on_completion: "never",
  })

  return session.client_secret
}

// ─── CANCEL SUBSCRIPTION ─────────────────────────────────────────────────────
export async function cancelSubscription(subscriptionId: string) {
  // CRITICAL: was previously open — any caller could cancel any
  // brokerage's Stripe subscription by passing its id. Require admin
  // role + verify the subscription belongs to caller's brokerage.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) throw new Error("Unauthorized")
  const supabase = await createClient()
  const { data: u } = await supabase
    .from("users").select("user_type").eq("id", ctx.userId).maybeSingle()
  if (!BILLING_ADMIN_ROLES.has(u?.user_type ?? ctx.userType)) {
    throw new Error("Forbidden: billing admin only")
  }

  // Get the subscription — scoped to caller's brokerage
  const { data: subscription, error } = await supabase
    .from("subscriptions")
    .select("stripe_subscription_id, brokerage_id")
    .eq("id", subscriptionId)
    .eq("brokerage_id", ctx.brokerageId)
    .single()

  if (error || !subscription?.stripe_subscription_id) {
    throw new Error("Subscription not found")
  }

  // Cancel at period end in Stripe
  const { stripe } = await import("@/lib/stripe")
  await stripe.subscriptions.update(subscription.stripe_subscription_id, {
    cancel_at_period_end: true,
  })

  // Update local record — scoped
  const { error: updateError } = await supabase
    .from("subscriptions")
    .update({
      cancel_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", subscriptionId)
    .eq("brokerage_id", ctx.brokerageId)

  if (updateError) throw updateError

  // BUILT (orphan doctrine §1.2 — no duplicate existed, the capability is wanted).
  // `KernelEvent` was imported at the top of this file and read by NOTHING — a dead
  // import that is the stub of exactly this wire. lib/kernel/events.ts:409
  // SUBSCRIPTION_CANCELLED was declared and emitted by NOBODY, so the one lifecycle
  // transition a tenant cares most about never reached the reactor, while
  // events.ts:9 states the rule: "every lifecycle state transition maps to exactly
  // one KernelEvent". The reader half already exists — lib/kernel/emit.ts:59
  // emitKernelEvent writes lifecycle_events AND fans out to notifications, marketing
  // triggers and sequences — so this closes the pair rather than adding a new one.
  //
  // Best-effort, matching app/actions/auth/signup-brokerage.ts:465 (SUBSCRIPTION_CREATED):
  // the Stripe cancel and the local row already landed above; a fan-out failure must
  // not turn a completed cancellation into a thrown error the caller retries.
  try {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    await emitKernelEvent({
      event:       KernelEvent.SUBSCRIPTION_CANCELLED,
      brokerageId: ctx.brokerageId,
      entityType:  "subscription",
      entityId:    subscriptionId,
      metadata:    { cancel_at_period_end: true, cancelled_by: ctx.userId, stripe_subscription_id: subscription.stripe_subscription_id },
    })
  } catch (err) {
    console.warn("[cancelSubscription] SUBSCRIPTION_CANCELLED emit failed:", (err as any)?.message)
  }

  // Revalidate inside function to avoid module-level server dependency
  const { revalidatePath } = await import("next/cache")
  revalidatePath("/settings/billing")

  return { success: true }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLATFORM (CROSS-TENANT) BILLING
// ═══════════════════════════════════════════════════════════════════════════════
//
// Everything below this line reads or writes ACROSS EVERY TENANT. The gate is
// lib/platform/require-capability.ts:requirePlatformCapability — the ONE gate that
// resolves platform_role the canonical way and answers from the capability map
// (+ superadmin overrides). It is NOT interchangeable with a tenant-role list:
// 'admin' and 'broker' are TENANT user_types in this schema, so a list like
// ["superadmin","admin","broker"] hands every brokerage's broker the whole
// platform's revenue. The previous gate here checked (user_type ?? role) against
// two superadmin spellings — closer, but it ignored platform_role entirely, so a
// real platform 'admin' employee was locked out while the capability-override
// table that is supposed to govern them was never consulted.
//
// ── TOMBSTONE (orphan doctrine §1.1) — BURN-C, 2026-09-04 ────────────────────
//
// Three cross-tenant billing actions stood here, complete, correctly gated and
// called by NOTHING. Lane G4 measured each against its survivor on 2026-08-28,
// named what the survivors were missing, and then left all three in place — so
// the census kept reporting them and the merge never happened. It happens here.
//
//   getAllBrokeragesBilling → lib/platform/subscription-oversight.ts:loadSubscriptionOversight
//     Nothing to merge. The survivor returns the same tenant/tier/status/MRR per
//     brokerage and additionally CLASSIFIES each one into an operational state
//     with an attention flag. Deleted outright (§1.3).
//
//   getDelinquentAccounts → lib/platform/subscription-oversight.ts:loadSubscriptionOversight
//     MERGED FIRST, THEN DELETED. The survivor's past-due set was already
//     broader (it detects past_due from subscriptions.status AND from the latest
//     unpaid invoice, where this one filtered `status = 'past_due'` alone), but
//     it did not carry the brokerage EMAIL — the dunning contact, which on a
//     collections queue is the actionable half. `email` is now a field on
//     SubscriptionOversightRow, selected in loadSubscriptionOversight, and
//     rendered on each attention row at
//     app/dashboard/superadmin/subscriptions/page.tsx.
//
//   manualTierOverride → app/actions/superadmin/brokerage-management.ts:changeBrokerageTierAction
//     MERGED FIRST, THEN DELETED. G4 verified live that subscription_tiers holds
//     exactly the four rows the survivor's CanonicalTier union names, so this
//     action reached no tier the survivor cannot, and the survivor is otherwise
//     strictly fuller (brokerages.plan_tier AND subscriptions.tier_id, the Stripe
//     price swap, the ai_subscription_tier entitlement row, the
//     SUBSCRIPTION_UPGRADED/DOWNGRADED kernel events, superadmin_audit_log). The
//     one thing only this copy had was the MANDATORY 10-char reason on a price
//     change; the survivor took `reason?` and wrote null. That gate now lives on
//     changeBrokerageTierAction (params.reason is required, 10-char floor, and
//     both the audit-log row and the kernel event carry the validated string),
//     and its caller at
//     app/dashboard/superadmin/brokerages/[id]/brokerage-actions.tsx:applyTierChange
//     checks it before the round trip.
//
// The requirePlatformCapability import went with them: these three were its only
// users in this file. Everything left here is TENANT-scoped and gates on
// BROKERAGE_FINANCE_ADMIN_USER_TYPES / getAgentContext instead, so nothing in
// app/actions/billing.ts reads across tenants any more — the cross-tenant reads
// now live behind the platform capability in lib/platform/ and app/actions/superadmin/.

// ═════════════════════════════════════════════════════════════════════════════
// THE SEAT DOOR (wave 79A) — owner verbatim: "if the tenant hits a limit they
// will be able to either upgrade to a higher tier (or lower tier if their
// business changes) or buy more seats. subscriptions will be setup in stripe
// so they sync."
//
// Three tenant-side actions on the survivors: the ONE gate (seatGate) for
// the door, stripeSwapPrice for a tier change, stripeSetSeatPackages for a
// package (a quantity on the tier's seat price — a second Stripe subscription
// item, prorated). Tenant from the SESSION; the gate is the COMMERCE roster
// (may obligate the brokerage to pay). Stripe is written FIRST and the row
// only after Stripe accepted — the webhook re-syncs the same row from the
// same items, so a missed local write is repaired, never invented. Every row
// write is COUNTED (§3) and every door use is audited.
// ═════════════════════════════════════════════════════════════════════════════

import { TENANT_COMMERCE_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { createServiceClient } from "@/lib/supabase/service"
import { seatGate, resolveSeatUsage, resolveCatalogSeatLimits, resolveTenantSeatTerms, setLicensedProducerExemption } from "@/lib/kernel/seat-usage"
import { isCanonicalTier, TIER_ORDER, TIER_LABELS, LICENSED_SEAT_ROLES, effectiveSeatLimit, parseSeatOverride, type SeatDecision, type SeatPath } from "@/lib/kernel/tier-role-matrix"
import { seatPackageSellable } from "@/lib/billing/plan-catalog"
import { stripeSwapPrice, stripeSetSeatPackages } from "@/lib/billing/stripe-subscription-ops"
import { syncBrokeragePlanTier } from "@/lib/billing/sync-plan-tier"

async function requireTenantCommerceAdmin(): Promise<
  | { ok: true; userId: string; email: string | null; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data: u, error } = await supabase.from("users").select("user_type, brokerage_id, email").eq("id", user.id).maybeSingle()
  if (error) return { ok: false, error: `Seat door could not read your account: ${error.message}` }
  if (!u?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  if (!TENANT_COMMERCE_ADMIN_USER_TYPES.has(String((u as any).user_type ?? "").toLowerCase())) {
    return { ok: false, error: "Only a broker, owner, admin or team lead can change the plan or buy seats" }
  }
  return { ok: true, userId: user.id, email: (u as any).email ?? user.email ?? null, brokerageId: u.brokerage_id as string }
}

async function auditSeatDoor(svc: any, actor: { userId: string; email: string | null }, action: string, brokerageId: string, details: Record<string, unknown>): Promise<void> {
  const { error } = await svc.from("superadmin_audit_log").insert({
    actor_user_id: actor.userId, actor_email: actor.email, action,
    target_type: "brokerage", target_id: brokerageId, details,
  })
  if (error) console.warn("[seat-door] audit insert refused:", error.message)
}

export interface SeatDoor {
  ok: boolean
  error?: string
  tier: string | null
  seatCount: number | null
  /** The decision for ONE more producer — the door's paths ride on it. */
  decision: SeatDecision | null
  message: string | null
  paths: SeatPath[]
  /** The tenant's LICENSED users (broker / broker_owner) and whether each is
   *  billed (wave 80A: a seat by type unless the tenant marks them
   *  non-producing). Empty when the door could not run. */
  licensed: LicensedSeatRow[]
}

export interface LicensedSeatRow {
  userId: string
  label: string
  role: string
  /** false = the tenant exempted them (billing_metadata.non_producing_user_ids). */
  producing: boolean
}

/** What the tenant is offered when the next producer would cross the limit
 *  (asked for one seat). Inside the limit: paths is empty. */
export async function getSeatDoorAction(): Promise<SeatDoor> {
  const auth = await requireTenantCommerceAdmin()
  if (!auth.ok) return { ok: false, error: auth.error, tier: null, seatCount: null, decision: null, message: null, paths: [], licensed: [] }
  const svc = createServiceClient()
  // "agent" is the plainest producer — the door asks what happens when one is added.
  const verdict = await seatGate(svc, auth.brokerageId, "agent", { seatsRequested: 1 })
  if (!verdict.decision) return { ok: false, error: verdict.message ?? "Seat check could not run", tier: verdict.tier, seatCount: verdict.seatCount, decision: null, message: verdict.message, paths: [], licensed: [] }
  // The licensed roster, with the exemption the meter applied — read through
  // the ONE count so this list and the seat number come from the same facts.
  const usage = await resolveSeatUsage(svc, auth.brokerageId)
  const exempt = new Set(usage.nonProducingIds)
  const { data: people, error: peopleErr } = await svc
    .from("users").select("id, first_name, last_name, email, user_type, status")
    .eq("brokerage_id", auth.brokerageId).in("user_type", [...LICENSED_SEAT_ROLES])
  if (peopleErr) console.warn("[seat-door] licensed roster read refused:", peopleErr.message)
  const licensed: LicensedSeatRow[] = ((people ?? []) as Array<{ id: string; first_name?: string | null; last_name?: string | null; email?: string | null; user_type?: string | null; status?: string | null }>)
    .filter((p) => p.status !== "suspended")
    .map((p) => ({
      userId: p.id,
      label: [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email || p.id.slice(0, 8),
      role: p.user_type ?? "",
      producing: !exempt.has(p.id),
    }))
  return { ok: true, tier: verdict.tier, seatCount: verdict.seatCount, decision: verdict.decision, message: verdict.message, paths: verdict.decision.paths, licensed }
}

/**
 * MARK A LICENSED BROKER NON-PRODUCING (or producing again) — wave 80A, owner:
 * "brokers and broker owners can be a producing seat." The default is the
 * seat; this is the tenant's exemption for the broker of record who runs the
 * shop and never sells. Tenant from the SESSION, commerce-admin gate (it
 * moves the bill), the ONE writer (setLicensedProducerExemption), audited.
 */
export async function setLicensedProducerAction(userId: string, producing: boolean): Promise<
  | { ok: true; producing: boolean; seatCount: number | null }
  | { ok: false; error: string }
> {
  const auth = await requireTenantCommerceAdmin()
  if (!auth.ok) return auth
  const id = String(userId ?? "").trim()
  if (!id) return { ok: false, error: "A user is required" }
  const svc = createServiceClient()
  const res = await setLicensedProducerExemption(svc, auth.brokerageId, id, !producing)
  if (!res.ok) return { ok: false, error: res.error }
  const usage = await resolveSeatUsage(svc, auth.brokerageId)
  await auditSeatDoor(svc, auth, "seat.licensed_producer_set", auth.brokerageId, { user_id: id, producing, non_producing_user_ids: res.nonProducingIds, producers_after: usage.ok ? usage.seatCount : null })
  return { ok: true, producing, seatCount: usage.ok ? usage.seatCount : null }
}

/**
 * BUY SEAT PACKAGES: set the tenant's package quantity to `packagesTotal`
 * (an absolute quantity, so a double-click cannot buy twice). Refuses when
 * the tier's seat price is not linked, when there is no Stripe subscription
 * to add the item to, or when a DEcrease would drop the limit under the
 * producers already seated.
 */
export async function buySeatPackagesAction(packagesTotal: number): Promise<
  | { ok: true; seatPackages: number; extraSeats: number; effectiveLimit: number | null; stripeApplied: boolean }
  | { ok: false; error: string }
> {
  const auth = await requireTenantCommerceAdmin()
  if (!auth.ok) return auth
  const qty = Math.floor(Number(packagesTotal))
  if (!Number.isFinite(qty) || qty < 0 || qty > 500) return { ok: false, error: "Seat packages must be a whole number between 0 and 500" }
  const svc = createServiceClient()

  const { data: brokerage, error: bErr } = await svc.from("brokerages").select("plan_tier, billing_metadata").eq("id", auth.brokerageId).maybeSingle()
  if (bErr || !brokerage) return { ok: false, error: `Your plan could not be read${bErr ? ` (${bErr.message})` : ""} — no seats were bought.` }
  const tier = (brokerage as { plan_tier?: string | null }).plan_tier ?? null
  if (!isCanonicalTier(tier)) return { ok: false, error: "Your plan is not a canonical tier — contact support to buy seats." }
  if (tier === "multi_location") return { ok: false, error: "Seats on the Multi-Location plan are priced for you — contact us to add more." }

  const catalog = await resolveCatalogSeatLimits(svc)
  if (!catalog.ok) return { ok: false, error: `The plan catalogue could not be read (${catalog.error}) — no seats were bought.` }
  const facts = catalog.packages[tier]
  if (!seatPackageSellable(facts)) return { ok: false, error: `Seat packages for the ${TIER_LABELS[tier]} plan are not on sale yet (no priced Stripe seat package is linked) — contact us.` }

  const terms = await resolveTenantSeatTerms(svc, auth.brokerageId)
  if (!terms.ok) return { ok: false, error: `Your purchased seats could not be read (${terms.error}) — no seats were bought.` }
  if (!terms.subscriptionId) return { ok: false, error: "No live subscription to add seats to — activate your plan first." }
  const usage = await resolveSeatUsage(svc, auth.brokerageId)
  if (!usage.ok) return { ok: false, error: "The number of seats in use could not be read — no seats were bought." }

  const newExtra = qty * facts.size
  const { limit: newLimit } = effectiveSeatLimit(tier, parseSeatOverride((brokerage as { billing_metadata?: unknown }).billing_metadata), catalog.limits, { extraSeats: newExtra })
  if (newLimit !== null && usage.seatCount > newLimit) {
    return { ok: false, error: `You have ${usage.seatCount} producers seated; ${qty} package${qty === 1 ? "" : "s"} would leave room for only ${newLimit}. Remove a producer first or keep more packages.` }
  }

  const { data: subRow, error: sErr } = await svc.from("subscriptions").select("id, stripe_subscription_id").eq("id", terms.subscriptionId).maybeSingle()
  if (sErr || !subRow) return { ok: false, error: `Your subscription could not be read${sErr ? ` (${sErr.message})` : ""} — no seats were bought.` }
  const stripeSubId = (subRow as { stripe_subscription_id?: string | null }).stripe_subscription_id ?? null
  if (!stripeSubId) return { ok: false, error: "Your plan is not linked to Stripe yet (trial or invoiced) — add a payment method from Billing first, then buy seats." }

  // STRIPE FIRST. A refusal here means nothing was bought and nothing is recorded.
  const op = await stripeSetSeatPackages(stripeSubId, facts.stripePriceId, qty)
  if (!op.applied) return { ok: false, error: op.skipped ? "Stripe is not configured — seats cannot be sold from this environment." : `Stripe refused the seat change: ${op.error ?? "unknown"}. Nothing was bought.` }

  const { data: written, error: wErr } = await svc.from("subscriptions")
    .update({ seat_packages: qty, extra_seats: newExtra, stripe_seat_item_id: op.itemId ?? null, updated_at: new Date().toISOString() })
    .eq("id", terms.subscriptionId).select("id")
  // Stripe already holds the truth; a refused local write is reported and the
  // daily reconcile / next webhook repairs the row from the items.
  if (wErr || (written ?? []).length !== 1) console.error("[seat-door] subscriptions seat write refused after Stripe accepted — reconcile will repair:", wErr?.message ?? "matched no row")

  await auditSeatDoor(svc, auth, "subscription.seat_packages_changed", auth.brokerageId, { tier, from_packages: terms.terms.seatPackages ?? 0, to_packages: qty, extra_seats: newExtra, stripe_item_id: op.itemId ?? null, stripe_subscription_id: stripeSubId, local_write_ok: !wErr && (written ?? []).length === 1 })
  return { ok: true, seatPackages: qty, extraSeats: newExtra, effectiveLimit: newLimit, stripeApplied: true }
}

/**
 * CHANGE PLAN — up OR down (the "business changed" path). A downgrade is
 * allowed only when the producers already seated fit the target tier's band
 * plus any packages kept; an upgrade always fits. Stripe is repriced FIRST
 * (stripeSwapPrice, prorated) when the tenant has a Stripe subscription and
 * the target tier a published price; a Stripe-linked tenant whose target has
 * no price is refused (a tier change that moves what they can do without
 * moving what they pay is the drift this closes). Then subscriptions.tier_id
 * and brokerages.plan_tier follow through the ONE tier sync.
 */
export async function changePlanTierAction(newTier: string): Promise<
  | { ok: true; from: string; to: string; direction: "upgrade" | "downgrade"; stripeApplied: boolean; stripeSkipped: boolean }
  | { ok: false; error: string }
> {
  const auth = await requireTenantCommerceAdmin()
  if (!auth.ok) return auth
  if (!isCanonicalTier(newTier)) return { ok: false, error: "Unknown plan" }
  if (newTier === "multi_location") return { ok: false, error: "The Multi-Location plan is priced for you — contact us and we will set it up." }
  const svc = createServiceClient()

  const { data: brokerage, error: bErr } = await svc.from("brokerages").select("plan_tier, billing_metadata").eq("id", auth.brokerageId).maybeSingle()
  if (bErr || !brokerage) return { ok: false, error: `Your plan could not be read${bErr ? ` (${bErr.message})` : ""} — nothing changed.` }
  const fromTier = (brokerage as { plan_tier?: string | null }).plan_tier ?? null
  if (!isCanonicalTier(fromTier)) return { ok: false, error: "Your current plan is not a canonical tier — contact support." }
  if (fromTier === newTier) return { ok: false, error: `You are already on ${TIER_LABELS[newTier]}.` }
  const direction: "upgrade" | "downgrade" = TIER_ORDER.indexOf(newTier) > TIER_ORDER.indexOf(fromTier) ? "upgrade" : "downgrade"

  const catalog = await resolveCatalogSeatLimits(svc)
  if (!catalog.ok) return { ok: false, error: `The plan catalogue could not be read (${catalog.error}) — nothing changed.` }
  const terms = await resolveTenantSeatTerms(svc, auth.brokerageId)
  if (!terms.ok) return { ok: false, error: `Your purchased seats could not be read (${terms.error}) — nothing changed.` }
  const usage = await resolveSeatUsage(svc, auth.brokerageId)
  if (!usage.ok) return { ok: false, error: "The number of seats in use could not be read — nothing changed." }

  if (direction === "downgrade") {
    const { limit } = effectiveSeatLimit(newTier, parseSeatOverride((brokerage as { billing_metadata?: unknown }).billing_metadata), catalog.limits, terms.terms)
    if (limit !== null && usage.seatCount > limit) {
      return { ok: false, error: `${TIER_LABELS[newTier]} seats ${limit} producers and you have ${usage.seatCount}. Remove producers or keep a bigger plan.` }
    }
  }

  const { data: tierRow, error: tErr } = await svc.from("subscription_tiers").select("id, stripe_price_id, is_active").eq("tier_name", newTier).maybeSingle()
  if (tErr || !tierRow) return { ok: false, error: `The ${TIER_LABELS[newTier]} plan could not be read${tErr ? ` (${tErr.message})` : ""} — nothing changed.` }
  if ((tierRow as { is_active?: boolean }).is_active === false) return { ok: false, error: `The ${TIER_LABELS[newTier]} plan is not currently offered.` }

  const { data: subRow, error: sErr } = await svc.from("subscriptions").select("id, stripe_subscription_id")
    .eq("brokerage_id", auth.brokerageId).in("status", ["active", "trialing", "past_due", "paused"]).order("updated_at", { ascending: false }).limit(1).maybeSingle()
  if (sErr) return { ok: false, error: `Your subscription could not be read (${sErr.message}) — nothing changed.` }
  const stripeSubId = (subRow as { stripe_subscription_id?: string | null } | null)?.stripe_subscription_id ?? null
  const priceId = (tierRow as { stripe_price_id?: string | null }).stripe_price_id ?? null

  let stripeApplied = false
  let stripeSkipped = false
  if (stripeSubId) {
    if (!priceId) return { ok: false, error: `The ${TIER_LABELS[newTier]} plan has no Stripe price published yet — contact us to change plan.` }
    const r = await stripeSwapPrice(stripeSubId, priceId)
    if (!r.applied && !r.skipped) return { ok: false, error: `Stripe refused the plan change: ${r.error ?? "unknown"}. Nothing changed.` }
    stripeApplied = r.applied
    stripeSkipped = r.skipped
  } else {
    stripeSkipped = true // trial / invoiced tenant: local change only, checkout collects on the new tier
  }

  if (subRow) {
    const { data: written, error: wErr } = await svc.from("subscriptions")
      .update({ tier_id: (tierRow as { id: string }).id, ...(priceId ? { stripe_price_id: priceId } : {}), updated_at: new Date().toISOString() })
      .eq("id", (subRow as { id: string }).id).select("id")
    if (wErr) return { ok: false, error: `Stripe ${stripeApplied ? "was repriced but" : "untouched;"} the subscription row refused the tier change: ${wErr.message}` }
    if ((written ?? []).length !== 1) return { ok: false, error: "The subscription row matched nothing — the tier was not changed." }
  }
  const synced = await syncBrokeragePlanTier(auth.brokerageId)
  if (synced !== newTier) {
    // sync derives from the subscription row; a trial tenant with no row still needs plan_tier moved.
    const { data: w2, error: pErr } = await svc.from("brokerages").update({ plan_tier: newTier, updated_at: new Date().toISOString() }).eq("id", auth.brokerageId).select("id")
    if (pErr || (w2 ?? []).length !== 1) return { ok: false, error: `The plan could not be written${pErr ? ` (${pErr.message})` : ""}.` }
  }

  await auditSeatDoor(svc, auth, "subscription.tier_changed_by_tenant", auth.brokerageId, { from: fromTier, to: newTier, direction, stripe_applied: stripeApplied, stripe_skipped: stripeSkipped, producers: usage.seatCount })
  return { ok: true, from: fromTier, to: newTier, direction, stripeApplied, stripeSkipped }
}
