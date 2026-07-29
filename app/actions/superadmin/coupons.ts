"use server"

// app/actions/superadmin/coupons.ts
// ─────────────────────────────────────────────────────────────────────────────
// Superadmin COUPON / DISCOUNT CODES for tier subscriptions. All rules live in
// the PURE layer (lib/platform/coupons.ts); this file is the thin gated
// DB/Stripe wrapper. Tables: platform_coupons + platform_coupon_redemptions.
//
// Conventions copied from the existing billing surfaces:
//   • Gate: requirePlatformCapability('billing') (writes add requireWrite) —
//     the same capability that guards /dashboard/superadmin/subscriptions.
//   • Audit: every mutation → superadmin_audit_log (non-fatal on failure),
//     same shape as brokerage-management's writeAuditLog.
//   • Stripe: the MOCK-SAFE pattern of lib/billing/stripe-subscription-ops.ts +
//     the plan-catalog publish tool — isStripeConfigured() guard, LAZY
//     import("@/lib/stripe") only after the guard, error returned never thrown.
//     Unconfigured publish records an HONEST mock ledger id (mock_… — see
//     isMockStripeCouponId) so the UI can show "mock" vs "live on Stripe"
//     truthfully, and re-publishing after creds arrive replaces it.
//   • Redemption atomicity WITHOUT an RPC: insert the redemption row FIRST —
//     UNIQUE(coupon_id, brokerage_id) is the real concurrency guard — then set
//     redeemed_count from a fresh COUNT of the ledger (derived, never +1 on a
//     stale read).

import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import { createServiceClient } from "@/lib/supabase/service"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { isStripeConfigured } from "@/lib/billing/stripe-subscription-ops"
import { toPlanTier } from "@/lib/billing/plan-tier"
import {
  validateCouponInput,
  validateCouponForRedemption,
  describeCoupon,
  stripeCouponPayload,
  isMockStripeCouponId,
  type CouponInput,
  type PlatformCoupon,
} from "@/lib/platform/coupons"

const COUPONS_PATH = "/dashboard/superadmin/coupons"
const COUPON_COLS =
  "id, code, description, percent_off, amount_off_cents, duration, duration_months, applies_to_tier, max_redemptions, redeemed_count, expires_at, active, stripe_coupon_id, created_at"

// ── Gate + audit (same conventions as the other superadmin billing actions) ──

async function gateBilling(requireWrite = false) {
  return requirePlatformCapability("billing", requireWrite ? { requireWrite: true } : {})
}

async function audit(actorUserId: string, action: string, targetId: string | null, details: Record<string, unknown>): Promise<void> {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    const { data: actor } = await svc.from("users").select("email").eq("id", actorUserId).maybeSingle()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId,
      actor_email: (actor as any)?.email ?? null,
      action,
      target_type: "platform_coupon",
      target_id: targetId,
      details,
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
      user_agent: hdrs.get("user-agent"),
    })
  } catch (err) {
    console.error("[coupon-audit] write failed:", err) // non-fatal — audit never blocks the action
  }
}

// ── LIST (with redemption counts from the ledger) ────────────────────────────

export interface CouponListRow extends PlatformCoupon {
  id: string
  created_at: string
  /** Honest count from platform_coupon_redemptions (the ledger), alongside the
   *  denormalized redeemed_count column. */
  ledger_redemptions: number
  last_redeemed_at: string | null
  summary: string
}

export async function listCouponsAction(): Promise<
  | { ok: true; coupons: CouponListRow[]; stripeConfigured: boolean }
  | { ok: false; error: string }
> {
  const gate = await gateBilling()
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  const svc = createServiceClient()

  const [couponsRes, redemptionsRes] = await Promise.all([
    svc.from("platform_coupons").select(COUPON_COLS).order("created_at", { ascending: false }),
    svc.from("platform_coupon_redemptions").select("coupon_id, redeemed_at"),
  ])
  if (couponsRes.error) return { ok: false, error: couponsRes.error.message }

  const byCoupon = new Map<string, { count: number; last: string | null }>()
  for (const r of (redemptionsRes.data ?? []) as Array<{ coupon_id: string; redeemed_at: string | null }>) {
    const cur = byCoupon.get(r.coupon_id) ?? { count: 0, last: null }
    cur.count += 1
    if (r.redeemed_at && (!cur.last || r.redeemed_at > cur.last)) cur.last = r.redeemed_at
    byCoupon.set(r.coupon_id, cur)
  }

  const coupons = ((couponsRes.data ?? []) as any[]).map((c) => {
    const agg = byCoupon.get(c.id) ?? { count: 0, last: null }
    return { ...c, ledger_redemptions: agg.count, last_redeemed_at: agg.last, summary: describeCoupon(c) } as CouponListRow
  })
  return { ok: true, coupons, stripeConfigured: isStripeConfigured() }
}

// ── CREATE ───────────────────────────────────────────────────────────────────

export async function createCouponAction(input: CouponInput): Promise<
  | { ok: true; id: string; code: string }
  | { ok: false; error: string }
> {
  const gate = await gateBilling(true)
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }

  const v = validateCouponInput(input)
  if (!v.ok) return { ok: false, error: v.error }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("platform_coupons")
    .insert({ ...v.value, active: true, created_by: gate.userId })
    .select("id")
    .single()
  if (error) {
    if ((error as any).code === "23505") return { ok: false, error: `A coupon with code ${v.value.code} already exists` }
    return { ok: false, error: error.message }
  }

  await audit(gate.userId!, "coupon.create", (data as any).id, { code: v.value.code, summary: describeCoupon({ ...v.value, redeemed_count: 0, active: true }) })
  revalidatePath(COUPONS_PATH)
  return { ok: true, id: (data as any).id, code: v.value.code }
}

// ── ACTIVATE / DEACTIVATE ────────────────────────────────────────────────────

export async function setCouponActiveAction(couponId: string, active: boolean): Promise<
  | { ok: true }
  | { ok: false; error: string }
> {
  const gate = await gateBilling(true)
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  const svc = createServiceClient()

  const { data: coupon } = await svc.from("platform_coupons").select("id, code").eq("id", couponId).maybeSingle()
  if (!coupon) return { ok: false, error: "Coupon not found" }

  const { error } = await svc.from("platform_coupons").update({ active }).eq("id", couponId)
  if (error) return { ok: false, error: error.message }

  await audit(gate.userId!, active ? "coupon.activate" : "coupon.deactivate", couponId, { code: (coupon as any).code })
  revalidatePath(COUPONS_PATH)
  return { ok: true }
}

// ── REMOVE (hard delete only while unredeemed; else soft deactivate) ─────────

export async function removeCouponAction(couponId: string): Promise<
  | { ok: true; removed: "hard" | "soft" }
  | { ok: false; error: string }
> {
  const gate = await gateBilling(true)
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  const svc = createServiceClient()

  const { data: coupon } = await svc.from("platform_coupons").select("id, code, redeemed_count").eq("id", couponId).maybeSingle()
  if (!coupon) return { ok: false, error: "Coupon not found" }

  // A redeemed coupon is a billing record — never delete it (the redemption
  // ledger FK would cascade away the chain of custody). Deactivate instead.
  const { count } = await svc.from("platform_coupon_redemptions").select("id", { count: "exact", head: true }).eq("coupon_id", couponId)
  if ((count ?? 0) > 0 || ((coupon as any).redeemed_count ?? 0) > 0) {
    const { error } = await svc.from("platform_coupons").update({ active: false }).eq("id", couponId)
    if (error) return { ok: false, error: error.message }
    await audit(gate.userId!, "coupon.deactivate", couponId, { code: (coupon as any).code, reason: "remove requested but coupon has redemptions — soft-deactivated" })
    revalidatePath(COUPONS_PATH)
    return { ok: true, removed: "soft" }
  }

  const { error } = await svc.from("platform_coupons").delete().eq("id", couponId)
  if (error) return { ok: false, error: error.message }
  await audit(gate.userId!, "coupon.delete", couponId, { code: (coupon as any).code })
  revalidatePath(COUPONS_PATH)
  return { ok: true, removed: "hard" }
}

// ── APPLY TO A TENANT ────────────────────────────────────────────────────────

/** Small tenant list for the apply-to-tenant picker. */
export async function listBrokeragesForCouponAction(): Promise<
  | { ok: true; brokerages: Array<{ id: string; name: string; tier: string | null }> }
  | { ok: false; error: string }
> {
  const gate = await gateBilling()
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("brokerages")
    .select("id, name, plan_tier, status")
    .order("name", { ascending: true })
    .limit(500)
  if (error) return { ok: false, error: error.message }
  const brokerages = ((data ?? []) as any[])
    .filter((b) => b.status !== "archived")
    .map((b) => ({ id: b.id, name: b.name ?? "(unnamed)", tier: toPlanTier(b.plan_tier) }))
  return { ok: true, brokerages }
}

/**
 * Redeem a coupon for a tenant. Validates via the PURE layer against the
 * brokerage's subscription tier, then: (1) INSERT the redemption row — the
 * UNIQUE(coupon_id, brokerage_id) constraint is the real double-redeem guard,
 * so a concurrent duplicate fails here, not after the count bump; (2) set
 * redeemed_count from a fresh COUNT of the ledger (derived, never a stale +1).
 */
export async function redeemCouponForBrokerageAction(couponId: string, brokerageId: string): Promise<
  | { ok: true; code: string; brokerageName: string; summary: string }
  | { ok: false; error: string }
> {
  const gate = await gateBilling(true)
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  const svc = createServiceClient()

  const [couponRes, brokerageRes, existingRes] = await Promise.all([
    svc.from("platform_coupons").select(COUPON_COLS).eq("id", couponId).maybeSingle(),
    svc.from("brokerages").select("id, name, plan_tier").eq("id", brokerageId).maybeSingle(),
    svc.from("platform_coupon_redemptions").select("id").eq("coupon_id", couponId).eq("brokerage_id", brokerageId).maybeSingle(),
  ])
  const coupon = couponRes.data as unknown as (PlatformCoupon & { id: string }) | null
  const brokerage = brokerageRes.data as any
  if (!coupon) return { ok: false, error: "Coupon not found" }
  if (!brokerage) return { ok: false, error: "Brokerage not found" }

  // plan_tier only — a coupon must key off the tier the tenant is BILLED on (m306).
  const tier = toPlanTier(brokerage.plan_tier)
  const check = validateCouponForRedemption(coupon, { tier, now: new Date(), existingRedemption: !!existingRes.data })
  if (!check.ok) return { ok: false, error: check.message }

  // 1) Redemption row first — the unique constraint is the concurrency guard.
  const { error: insErr } = await svc.from("platform_coupon_redemptions").insert({
    coupon_id: couponId,
    brokerage_id: brokerageId,
    redeemed_by: gate.userId,
  })
  if (insErr) {
    if ((insErr as any).code === "23505") return { ok: false, error: `This tenant already redeemed ${coupon.code}` }
    return { ok: false, error: insErr.message }
  }

  // 2) redeemed_count = COUNT(ledger) — derived from the source of truth.
  const { count } = await svc.from("platform_coupon_redemptions").select("id", { count: "exact", head: true }).eq("coupon_id", couponId)
  const { error: cntErr } = await svc.from("platform_coupons").update({ redeemed_count: count ?? coupon.redeemed_count + 1 }).eq("id", couponId)
  if (cntErr) console.error("[coupons] redeemed_count sync failed (ledger row exists):", cntErr.message)

  await audit(gate.userId!, "coupon.redeem", couponId, {
    code: coupon.code,
    brokerage_id: brokerageId,
    brokerage_name: brokerage.name ?? null,
    tier,
    summary: describeCoupon(coupon),
  })
  revalidatePath(COUPONS_PATH)
  return { ok: true, code: coupon.code, brokerageName: brokerage.name ?? "(unnamed)", summary: describeCoupon(coupon) }
}

// ── CANCELLATION SAVE-OFFER DESIGNATION ──────────────────────────────────────
// Which coupon the tenant cancel flow counters with (platform_settings.
// retention_offer jsonb — the singleton, no new table). Read by the tenant-side
// getCancellationSaveOfferAction; a tenant is only shown the offer when the
// coupon's own redemption rules allow it. Clearing turns the save-offer off.

export async function getRetentionOfferConfigAction(): Promise<
  | { ok: true; couponCode: string | null; headline: string }
  | { ok: false; error: string }
> {
  const gate = await gateBilling()
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  const { resolveRetentionOfferConfig } = await import("@/lib/platform/save-offer")
  const svc = createServiceClient()
  try {
    const { data } = await svc.from("platform_settings").select("retention_offer").limit(1).maybeSingle()
    const config = resolveRetentionOfferConfig((data as any)?.retention_offer)
    return { ok: true, couponCode: config.couponCode, headline: config.headline }
  } catch {
    // Column not migrated yet — honest "not configured", not an error.
    const config = resolveRetentionOfferConfig(null)
    return { ok: true, couponCode: null, headline: config.headline }
  }
}

export async function setRetentionOfferAction(input: { couponCode: string | null; headline?: string | null }): Promise<
  | { ok: true; couponCode: string | null }
  | { ok: false; error: string }
> {
  const gate = await gateBilling(true)
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  const { resolveRetentionOfferConfig } = await import("@/lib/platform/save-offer")
  const svc = createServiceClient()

  const config = resolveRetentionOfferConfig({ couponCode: input.couponCode, headline: input.headline ?? undefined })
  if (input.couponCode && !config.couponCode) return { ok: false, error: "That coupon code is not a valid code" }

  // Setting (not clearing) requires the coupon to exist and be active.
  if (config.couponCode) {
    const { data: coupon } = await svc.from("platform_coupons").select("id, active").eq("code", config.couponCode).maybeSingle()
    if (!coupon) return { ok: false, error: `No coupon with code ${config.couponCode} exists` }
    if (!(coupon as any).active) return { ok: false, error: `Coupon ${config.couponCode} is deactivated — activate it first` }
  }

  const value = { couponCode: config.couponCode, headline: config.headline }
  const { data: existing, error: readErr } = await svc.from("platform_settings").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }
  const write = existing
    ? await svc.from("platform_settings").update({ retention_offer: value, updated_at: new Date().toISOString() }).eq("id", (existing as any).id)
    : await svc.from("platform_settings").insert({ retention_offer: value })
  if (write.error) {
    return { ok: false, error: `${write.error.message} — has scripts/l61-s01-retention-offer-status-notice.sql been applied?` }
  }

  await audit(gate.userId!, config.couponCode ? "coupon.set_save_offer" : "coupon.clear_save_offer", null, value)
  revalidatePath(COUPONS_PATH)
  return { ok: true, couponCode: config.couponCode }
}

// ── PUBLISH TO STRIPE (mock-safe, same convention as the pricing publish) ────

/**
 * Publish a coupon to Stripe so checkout/subscriptions can apply it. Follows
 * the plan-catalog publish + stripe-subscription-ops convention: real Stripe
 * SDK call when STRIPE_SECRET_KEY is present (lazy import AFTER the guard),
 * HONEST mock otherwise — an unmistakable mock_… ledger id is recorded so the
 * UI shows "mock (Stripe not configured)" truthfully; re-publishing once creds
 * exist replaces it with the live id. A previously-published LIVE coupon is
 * deleted on Stripe before re-publish (Stripe coupons are immutable; deleting
 * a coupon never affects customers it was already applied to).
 */
export async function publishCouponToStripeAction(couponId: string): Promise<
  | { ok: true; mode: "live" | "mock"; stripeCouponId: string; note?: string }
  | { ok: false; error: string }
> {
  const gate = await gateBilling(true)
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  const svc = createServiceClient()

  const { data } = await svc.from("platform_coupons").select(COUPON_COLS).eq("id", couponId).maybeSingle()
  const coupon = data as unknown as (PlatformCoupon & { id: string }) | null
  if (!coupon) return { ok: false, error: "Coupon not found" }
  if (!coupon.active) return { ok: false, error: "Coupon is deactivated — activate it before publishing" }

  // ── Honest mock path: no creds → record a self-describing mock ledger id.
  if (!isStripeConfigured()) {
    const mockId = `mock_${coupon.code}_${Date.now()}`
    const { error } = await svc.from("platform_coupons").update({ stripe_coupon_id: mockId }).eq("id", couponId)
    if (error) return { ok: false, error: error.message }
    await audit(gate.userId!, "coupon.publish_stripe", couponId, { code: coupon.code, mode: "mock", stripe_coupon_id: mockId, payload: stripeCouponPayload(coupon) })
    revalidatePath(COUPONS_PATH)
    return {
      ok: true,
      mode: "mock",
      stripeCouponId: mockId,
      note: "STRIPE_SECRET_KEY unset — recorded a mock ledger entry (nothing hit Stripe). Re-publish after configuring Stripe.",
    }
  }

  // ── Live path: lazy import only after the guard (same as stripe-subscription-ops).
  try {
    const { stripe } = await import("@/lib/stripe")
    // Replace a previously-published LIVE coupon (Stripe coupons are immutable).
    if (coupon.stripe_coupon_id && !isMockStripeCouponId(coupon.stripe_coupon_id)) {
      try {
        await stripe.coupons.del(coupon.stripe_coupon_id)
      } catch { /* an already-gone old coupon never blocks the new publish */ }
    }
    const created = await stripe.coupons.create(stripeCouponPayload(coupon) as any)
    const { error } = await svc.from("platform_coupons").update({ stripe_coupon_id: created.id }).eq("id", couponId)
    if (error) return { ok: false, error: `Stripe coupon ${created.id} created but linking failed: ${error.message}` }
    await audit(gate.userId!, "coupon.publish_stripe", couponId, { code: coupon.code, mode: "live", stripe_coupon_id: created.id })
    revalidatePath(COUPONS_PATH)
    return { ok: true, mode: "live", stripeCouponId: created.id }
  } catch (err: any) {
    return { ok: false, error: `Stripe publish failed: ${err?.message ?? "unknown"}` }
  }
}
