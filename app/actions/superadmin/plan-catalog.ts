"use server"

// app/actions/superadmin/plan-catalog.ts
// ─────────────────────────────────────────────────────────────────────────────
// Superadmin CRUD for the subscription tier catalog (subscription_tiers) — the
// SINGLE source of truth for price, blurb, marketing bullets, highlight, limits,
// and the Stripe price link. Nothing in the app hardcodes tier copy or price any
// more; staff create/update/remove plans here (or sync a price from Stripe).
// A tier that has active subscriptions is SOFT-removed (is_active=false) so no
// tenant is orphaned.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { validatePlanTierInput, type PlanTierInput } from "@/lib/billing/plan-catalog"

async function requireSuperadmin(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  const isSuper = (data as any)?.user_type === "superadmin" || (data as any)?.platform_role === "superadmin"
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
    revalidatePath("/dashboard/superadmin/plans")
    revalidatePath("/signup")
    return { ok: true, id: input.id }
  }

  const { data, error } = await svc.from("subscription_tiers").insert(row).select("id").single()
  if (error) return { ok: false, error: error.message }
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
    revalidatePath("/dashboard/superadmin/plans"); revalidatePath("/signup")
    return { ok: true, removed: "soft" }
  }
  const { error } = await svc.from("subscription_tiers").delete().eq("id", tierId)
  if (error) return { ok: false, error: error.message }
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
    revalidatePath("/dashboard/superadmin/plans"); revalidatePath("/signup")
    return { ok: true, monthlyPriceCents: cents }
  } catch (err: any) {
    return { ok: false, error: `Stripe sync failed: ${err?.message ?? "unknown"}` }
  }
}
