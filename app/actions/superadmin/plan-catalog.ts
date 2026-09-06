"use server"

// app/actions/superadmin/plan-catalog.ts
// ─────────────────────────────────────────────────────────────────────────────
// Superadmin CRUD for the subscription tier catalog (subscription_tiers) — the
// SINGLE source of truth for price, blurb, marketing bullets, highlight, limits,
// and the Stripe price link. Nothing in the app hardcodes tier copy or price any
// more; staff create/update/remove plans here (or sync a price from Stripe).
// A tier that has active subscriptions is SOFT-removed (is_active=false) so no
// tenant is orphaned.

import { headers } from "next/headers"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { validatePlanTierInput, validateAIOverageTermsInput, CANONICAL_TIERS, type PlanTierInput, type AIOverageTermsInput } from "@/lib/billing/plan-catalog"
import { AI_OVERAGE_METRIC } from "@/lib/billing/ai-overage"
import { isPlatformSuperadminIdentity } from "@/lib/platform/platform-staff-roster"

// Audit — same conventions as the other superadmin billing actions (coupons /
// brokerage-management): every catalog mutation → superadmin_audit_log,
// non-fatal on failure (audit never blocks the action).
async function audit(actorUserId: string, action: string, targetId: string | null, details: Record<string, unknown>, targetType: string = "subscription_tier"): Promise<void> {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    const { data: actor } = await svc.from("users").select("email").eq("id", actorUserId).maybeSingle()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId,
      actor_email: (actor as any)?.email ?? null,
      action,
      target_type: targetType,
      target_id: targetId,
      details,
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
      user_agent: hdrs.get("user-agent"),
    })
  } catch (err) {
    console.error("[plan-catalog audit] write failed:", err)
  }
}

async function requireSuperadmin(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  const isSuper = isPlatformSuperadminIdentity((data as any)?.user_type, (data as any)?.platform_role)
  if (!isSuper) return { ok: false, error: "Forbidden — superadmin only" }
  return { ok: true, userId: user.id }
}

const TIER_COLS = "id, tier_name, display_name, description, monthly_price_cents, annual_price_cents, setup_fee_cents, marketing_bullets, is_featured, is_active, max_agents, max_brokerages, stripe_price_id, features"

export async function listPlanTiersAction(): Promise<{ ok: true; tiers: any[] } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data, error } = await svc.from("subscription_tiers").select(TIER_COLS).order("monthly_price_cents", { ascending: true })
  if (error) return { ok: false, error: error.message }
  return { ok: true, tiers: data ?? [] }
}

export async function upsertPlanTierAction(input: PlanTierInput & { id?: string }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const v = validatePlanTierInput(input)
  if (!v.ok) return { ok: false, error: v.error }

  const svc = createServiceClient()
  const row = {
    tier_name: v.value.tierName,
    display_name: v.value.displayName,
    description: v.value.description,
    monthly_price_cents: v.value.monthlyPriceCents,
    annual_price_cents: v.value.annualPriceCents,
    setup_fee_cents: v.value.setupFeeCents,
    marketing_bullets: v.value.marketingBullets,
    is_featured: v.value.isFeatured,
    is_active: v.value.isActive,
    max_agents: v.value.maxAgents,
    stripe_price_id: v.value.stripePriceId,
  }

  if (input.id) {
    const { error } = await svc.from("subscription_tiers").update(row).eq("id", input.id)
    if (error) return { ok: false, error: error.message }
    await audit(auth.userId, "plan_tier.updated", input.id, { tierName: row.tier_name, monthlyPriceCents: row.monthly_price_cents, isActive: row.is_active })
    revalidatePath("/dashboard/superadmin/plans")
    revalidatePath("/signup")
    return { ok: true, id: input.id }
  }

  const { data, error } = await svc.from("subscription_tiers").insert(row).select("id").single()
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, "plan_tier.created", (data as any).id, { tierName: row.tier_name, monthlyPriceCents: row.monthly_price_cents, isActive: row.is_active })
  revalidatePath("/dashboard/superadmin/plans")
  revalidatePath("/signup")
  return { ok: true, id: (data as any).id }
}

/** Remove a tier. SOFT (deactivate) when tenants are on it — never orphan a subscription. */
export async function removePlanTierAction(tierId: string): Promise<{ ok: true; removed: "hard" | "soft" } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  const { count } = await svc.from("subscriptions").select("id", { count: "exact", head: true }).eq("tier_id", tierId)
  if ((count ?? 0) > 0) {
    const { error } = await svc.from("subscription_tiers").update({ is_active: false }).eq("id", tierId)
    if (error) return { ok: false, error: error.message }
    await audit(auth.userId, "plan_tier.deactivated", tierId, { reason: "remove requested but tenants are subscribed — soft-deactivated", subscriptions: count })
    revalidatePath("/dashboard/superadmin/plans"); revalidatePath("/signup")
    return { ok: true, removed: "soft" }
  }
  const { error } = await svc.from("subscription_tiers").delete().eq("id", tierId)
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, "plan_tier.deleted", tierId, {})
  revalidatePath("/dashboard/superadmin/plans"); revalidatePath("/signup")
  return { ok: true, removed: "hard" }
}

/** Pull the live price for a tier's stripe_price_id from Stripe (source-of-truth = Stripe). */
export async function syncPlanTierFromStripeAction(tierId: string): Promise<{ ok: true; monthlyPriceCents: number } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data: tier } = await svc.from("subscription_tiers").select("stripe_price_id").eq("id", tierId).maybeSingle()
  const priceId = (tier as any)?.stripe_price_id
  if (!priceId) return { ok: false, error: "Tier has no stripe_price_id to sync from" }
  try {
    const { stripe } = await import("@/lib/stripe")
    const price = await stripe.prices.retrieve(priceId)
    const cents = price.unit_amount ?? 0
    const patch = price.recurring?.interval === "year" ? { annual_price_cents: cents } : { monthly_price_cents: cents }
    await svc.from("subscription_tiers").update(patch).eq("id", tierId)
    await audit(auth.userId, "plan_tier.synced_from_stripe", tierId, { priceId, cents, interval: price.recurring?.interval ?? "month" })
    revalidatePath("/dashboard/superadmin/plans"); revalidatePath("/signup")
    return { ok: true, monthlyPriceCents: cents }
  } catch (err: any) {
    return { ok: false, error: `Stripe sync failed: ${err?.message ?? "unknown"}` }
  }
}

/**
 * PUBLISH a tier's CURRENT DB pricing to Stripe — pricing day is one click:
 * edit the tier in the plan catalog, press Publish. Creates a fresh Stripe
 * product+price from the tier's monthly_price_cents (Stripe prices are
 * immutable — a change means a NEW price), archives the previously linked
 * price's product (existing subscriptions keep billing on their old price),
 * and links the new id. Nothing here decides pricing — the DB is the source
 * of truth; Stripe mirrors it on demand.
 */
export async function publishTierToStripeAction(tierId: string): Promise<{ ok: true; priceId: string } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data: tier } = await svc.from("subscription_tiers")
    .select("id, tier_name, display_name, monthly_price_cents, stripe_price_id, is_active")
    .eq("id", tierId).maybeSingle()
  if (!tier) return { ok: false, error: "Tier not found" }
  const t = tier as any
  if (!t.is_active) return { ok: false, error: "Tier is inactive — activate it before publishing" }
  if (!(t.monthly_price_cents > 0)) return { ok: false, error: "Tier has no monthly price set — decide pricing in the catalog first" }

  try {
    const { stripe } = await import("@/lib/stripe")
    // Archive the previously linked price's product (old price keeps billing
    // existing subscriptions; it just can't be used for NEW checkouts).
    if (t.stripe_price_id) {
      try {
        const old = await stripe.prices.retrieve(t.stripe_price_id)
        if (typeof old.product === "string") await stripe.products.update(old.product, { active: false })
      } catch { /* an already-gone old price never blocks the new publish */ }
    }
    const price = await stripe.prices.create({
      currency: "usd",
      unit_amount: t.monthly_price_cents,
      recurring: { interval: "month" },
      product_data: { name: t.display_name ?? t.tier_name },
      lookup_key: `${t.tier_name}_monthly_${Date.now()}`,
      metadata: { tier_name: t.tier_name },
    })
    await svc.from("subscription_tiers").update({ stripe_price_id: price.id }).eq("id", tierId)
    await audit(auth.userId, "plan_tier.published_to_stripe", tierId, {
      tierName: t.tier_name, monthlyPriceCents: t.monthly_price_cents,
      newPriceId: price.id, previousPriceId: t.stripe_price_id ?? null,
    })
    revalidatePath("/dashboard/superadmin/plans"); revalidatePath("/signup")
    return { ok: true, priceId: price.id }
  } catch (err: any) {
    return { ok: false, error: `Stripe publish failed: ${err?.message ?? "unknown"}` }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AI OVERAGE TERMS (m479) — administrable exactly like tier pricing.
// Owner ruling (verbatim): "the billing for overage needs to be coded so that
// we can pass in the cent per limit so the same as how we are handling the
// subscription tier amount." The per-tier terms (plan_limits.overage_allowed +
// overage_rate_cents_per_1k on the ai_tokens_monthly rows) are configured HERE,
// through the same superadmin gate, the same pure-validator discipline, and the
// same audit trail as the tier price — never hardcoded, never edited raw.
// Consumers (lib/ai/fair-use.ts serving, lib/billing/ai-overage.ts billing)
// read the columns unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export interface AIOverageTermsRow {
  id: string
  plan_tier: string
  metric: string
  /** Included monthly tokens for the tier (plan_limits.limit_value; -1 = unlimited). */
  limit_value: number
  overage_allowed: boolean
  /** Integer CENTS per 1K tokens — meaningful only when overage_allowed. */
  overage_rate_cents_per_1k: number
}

/** The four (canonical tier, ai_tokens_monthly) rows: included limit + overage terms. */
export async function listAIOverageTermsAction(): Promise<{ ok: true; terms: AIOverageTermsRow[] } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("plan_limits")
    .select("id, plan_tier, metric, limit_value, overage_allowed, overage_rate_cents_per_1k")
    .eq("metric", AI_OVERAGE_METRIC)
    .in("plan_tier", [...CANONICAL_TIERS])
    .order("limit_value", { ascending: true })
  if (error) return { ok: false, error: error.message }
  return { ok: true, terms: (data ?? []) as AIOverageTermsRow[] }
}

/**
 * Set a tier's AI overage terms. UPDATE-only on the live (tier, ai_tokens_monthly)
 * row — this action can never mint a plan_limits row (a new metric or tier is a
 * migration decision, not a form submit), and the validator refuses any metric
 * other than ai_tokens_monthly, so m479's postcondition (no non-AI metric is
 * overage-enabled) stays true by construction.
 */
export async function upsertAIOverageTermsAction(input: AIOverageTermsInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const v = validateAIOverageTermsInput(input)
  if (!v.ok) return { ok: false, error: v.error }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("plan_limits")
    .update({
      overage_allowed: v.value.overageAllowed,
      overage_rate_cents_per_1k: v.value.overageRateCentsPer1k,
      updated_at: new Date().toISOString(),
    })
    .eq("plan_tier", v.value.planTier)
    .eq("metric", AI_OVERAGE_METRIC)
    .select("id")
  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) {
    return { ok: false, error: `no plan_limits row for (${v.value.planTier}, ${AI_OVERAGE_METRIC}) — seed the included limit first; overage terms are never created out of thin air` }
  }
  const id = (data[0] as any).id as string
  await audit(auth.userId, "plan_limits.ai_overage_terms_updated", id, {
    planTier: v.value.planTier,
    metric: AI_OVERAGE_METRIC,
    overageAllowed: v.value.overageAllowed,
    overageRateCentsPer1k: v.value.overageRateCentsPer1k,
  }, "plan_limit")
  revalidatePath("/dashboard/superadmin/plans")
  return { ok: true, id }
}
