"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { KernelEvent } from "@/lib/kernel/events"
import { toPlanTier } from "@/lib/billing/plan-tier"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
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
    line_items: lineItems as any,
    subscription_data: {
      // add_invoice_items charges the one-time setup fee on the first invoice only.
      ...(addInvoiceItems.length > 0 ? { add_invoice_items: addInvoiceItems as any } : {}),
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
// These three are DELIBERATELY LEFT UNWIRED — see the report. The wired, more
// complete cross-tenant read is lib/platform/subscription-oversight.ts
// (loadSubscriptionOversight), and the wired tier writer is
// app/actions/superadmin/brokerage-management.ts:changeBrokerageTierAction.
//
// ── EVIDENCE ADDED 2026-08-28 (lane G4), so the next pass does not re-derive it.
//
// The verdicts above were re-checked end to end against the live database rather
// than by name, per the owner's ruling that a same-sounding function is not the
// same capability.
//
//  · manualTierOverride vs changeBrokerageTierAction — SAME business process.
//    The one thing this pair genuinely disagreed on was REACH: this action moves
//    a subscription onto any `subscription_tiers` row by id, while the survivor
//    takes a CanonicalTier name union of four values, so a catalog row outside
//    that union would have been reachable only from here. Measured on
//    hrvaqgvukzxfskkcrwbt: `subscription_tiers` holds exactly FOUR active rows —
//    solo_agent, team, brokerage, multi_location — i.e. the union is the whole
//    catalog and this action reaches nothing the survivor cannot. The survivor
//    is otherwise strictly fuller (brokerages.plan_tier AND subscriptions.tier_id,
//    the Stripe price swap, the ai_subscription_tier entitlement row, the
//    SUBSCRIPTION_UPGRADED/DOWNGRADED kernel events and superadmin_audit_log).
//    THE ONE PIECE THE SURVIVOR IS MISSING before it can absorb this: the
//    MANDATORY substantive reason. Here a price change is refused without one
//    ("A substantive reason (10+ chars) is required — this is the audit record
//    for a price change"); on the survivor `reason` is optional and lands as
//    null. That merge belongs in brokerage-management.ts, not here.
//
//  · getAllBrokeragesBilling — covered by loadSubscriptionOversight, which
//    returns the same tenant/tier/status/MRR per brokerage and classifies it.
//
//  · getDelinquentAccounts — the past-due set is covered (oversight detects it
//    from subscriptions.status AND from the latest unpaid invoice, which is
//    broader than the `status = 'past_due'` filter here). The ONE field this one
//    carries that SubscriptionOversightRow does not is the brokerage EMAIL — the
//    dunning contact. A collapse should add it to the oversight row first.

// ─── GET ALL BROKERAGES BILLING (PLATFORM 'billing' CAPABILITY) ──────────────
export async function getAllBrokeragesBilling(): Promise<
  | { ok: true; rows: any[] }
  | { ok: false; error: string }
> {
  const gate = await requirePlatformCapability("billing")
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }

  const supabase = await createClient()
  // A refused cross-tenant read must NOT come back as an empty roster — an empty
  // platform is indistinguishable from a denied one, and "we have no customers"
  // is the wrong thing to show a finance operator.
  const { data: brokerages, error } = await supabase
    .from("brokerages")
    .select(`
      id,
      name,
      subscriptions:subscriptions(
        id,
        status,
        current_period_end,
        stripe_subscription_id,
        subscription_tiers:tier_id(tier_name, display_name, monthly_price_cents)
      )
    `)
    .order("name", { ascending: true })

  if (error) return { ok: false, error: error.message }
  return { ok: true, rows: brokerages ?? [] }
}

// ─── GET DELINQUENT ACCOUNTS (PLATFORM 'billing' CAPABILITY) ─────────────────
export async function getDelinquentAccounts(): Promise<
  | { ok: true; rows: any[] }
  | { ok: false; error: string }
> {
  const gate = await requirePlatformCapability("billing")
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }

  const supabase = await createClient()
  const { data: delinquent, error } = await supabase
    .from("subscriptions")
    .select(`
      id,
      brokerage_id,
      status,
      current_period_end,
      brokerages:brokerage_id(id, name, email),
      subscription_tiers:tier_id(tier_name, display_name)
    `)
    .eq("status", "past_due")
    .order("current_period_end", { ascending: true })

  if (error) return { ok: false, error: error.message }
  return { ok: true, rows: delinquent ?? [] }
}

// ─── MANUAL TIER OVERRIDE (SUPERADMIN ONLY) ──────────────────────────────────
/**
 * Move ONE subscription onto a different subscription_tiers row.
 *
 * This changes what a customer is charged, so it is the strictest gate in the
 * file: the platform 'billing' capability AND a resolved platform role of
 * superadmin — a platform 'admin' employee holds 'billing' for reads but must
 * not silently reprice a tenant. Records WHO (actor id + role) and WHY (a
 * required, substantive reason) into audit_log with before/after.
 *
 * IDEMPOTENT-SAFE: if the subscription already sits on the requested tier the
 * call is a no-op — it does not rewrite updated_at, does not re-run the plan_tier
 * sync, and does not append a second audit entry claiming a change that did not
 * happen. Callers get { changed: false } so a double-submit cannot manufacture a
 * pricing-change history.
 */
export async function manualTierOverride(
  subscriptionId: string,
  newTierId: string,
  reason: string
): Promise<{ ok: true; changed: boolean; previousTierId: string | null } | { ok: false; error: string }> {
  const gate = await requirePlatformCapability("billing", { requireWrite: true })
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  if (gate.role !== "superadmin") {
    return { ok: false, error: "Forbidden — changing what a tenant is charged is superadmin-only" }
  }
  const actorId = gate.userId
  if (!actorId) return { ok: false, error: "Unauthenticated" }

  const trimmedReason = (reason ?? "").trim()
  if (trimmedReason.length < 10) {
    return { ok: false, error: "A substantive reason (10+ chars) is required — this is the audit record for a price change" }
  }

  const supabase = await createClient()

  // Read the CURRENT tier before writing: it is both the idempotency check and
  // the `before` half of the audit entry.
  const { data: subRow, error: subErr } = await supabase
    .from("subscriptions")
    .select("id, brokerage_id, tier_id")
    .eq("id", subscriptionId)
    .maybeSingle()
  if (subErr) return { ok: false, error: subErr.message }
  if (!subRow) return { ok: false, error: "Subscription not found" }

  // Refuse a tier id the catalog does not carry — subscriptions.tier_id has an FK
  // to subscription_tiers, so a bad id would surface as an opaque 23503.
  const { data: tierRow, error: tierErr } = await supabase
    .from("subscription_tiers")
    .select("id, tier_name, monthly_price_cents")
    .eq("id", newTierId)
    .maybeSingle()
  if (tierErr) return { ok: false, error: tierErr.message }
  if (!tierRow) return { ok: false, error: "Tier not found in the subscription catalog" }

  const previousTierId = (subRow.tier_id as string | null) ?? null
  if (previousTierId === newTierId) {
    return { ok: true, changed: false, previousTierId }
  }

  const { error, count } = await supabase
    .from("subscriptions")
    .update({
      tier_id: newTierId,
      updated_at: new Date().toISOString(),
    }, { count: "exact" })
    .eq("id", subscriptionId)

  if (error) return { ok: false, error: error.message }
  if ((count ?? 0) === 0) {
    // An UPDATE matching nothing still succeeds in postgrest. Reporting a price
    // change that never landed is how a tenant ends up billed on a tier nobody
    // believes they are on.
    return { ok: false, error: "No subscription row was updated — the tier was NOT changed." }
  }

  // Sync brokerages.plan_tier so cap-enforcement reflects the new tier
  // immediately. Without this, checkUsageCap would still gate on the old
  // tier's limits until the next Stripe webhook fires.
  if (subRow.brokerage_id) {
    const { syncBrokeragePlanTier } = await import("@/lib/billing/sync-plan-tier")
    await syncBrokeragePlanTier(subRow.brokerage_id as string)
  }

  // Log the override in audit_log — WHO, WHY, and what it moved from/to.
  await supabase.from("audit_log").insert({
    after: {
      brokerage_id: subRow.brokerage_id,
      tier_id: newTierId,
      tier_name: (tierRow as any).tier_name,
      monthly_price_cents: (tierRow as any).monthly_price_cents,
      reason: trimmedReason,
      actor_platform_role: gate.role,
    },
    before: { tier_id: previousTierId },
    user_id: actorId,
    action: "manual_tier_override",
    entity_type: "subscription",
    entity_id: subscriptionId,
  })

  // Revalidate inside function to avoid module-level server dependency
  const { revalidatePath } = await import("next/cache")
  revalidatePath("/dashboard/superadmin/subscriptions")

  return { ok: true, changed: true, previousTierId }
}
