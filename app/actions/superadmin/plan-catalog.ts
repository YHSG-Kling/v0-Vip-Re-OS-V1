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
import { validatePlanTierInput, validateAIOverageTermsInput, CANONICAL_TIERS, OVERAGE_BILLED_METRICS, isOverageBilledMetric, type PlanTierInput, type AIOverageTermsInput } from "@/lib/billing/plan-catalog"
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

const TIER_COLS = "id, tier_name, display_name, description, monthly_price_cents, annual_price_cents, setup_fee_cents, marketing_bullets, is_featured, is_active, max_agents, max_brokerages, stripe_price_id, features, seat_package_size, seat_package_price_cents, stripe_seat_price_id"

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
    seat_package_size: v.value.seatPackageSize,
    seat_package_price_cents: v.value.seatPackagePriceCents,
    stripe_seat_price_id: v.value.stripeSeatPriceId,
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
    // The Stripe price was read; a refused catalog write means the tier still shows
    // the OLD price on /signup while this reported the sync done.
    const { error: syncErr } = await svc.from("subscription_tiers").update(patch).eq("id", tierId)
    if (syncErr) return { ok: false, error: `Stripe price read, but the plan tier was not updated: ${syncErr.message}` }
    await audit(auth.userId, "plan_tier.synced_from_stripe", tierId, { priceId, cents, interval: price.recurring?.interval ?? "month" })
    revalidatePath("/dashboard/superadmin/plans"); revalidatePath("/signup")
    return { ok: true, monthlyPriceCents: cents }
  } catch (err: any) {
    return { ok: false, error: `Stripe sync failed: ${err?.message ?? "unknown"}` }
  }
}

/**
 * SYNC THE WHOLE CATALOGUE FROM STRIPE (wave 79A — owner: "subscriptions will
 * be setup in stripe so they sync"). Stripe is the catalogue source: every
 * ACTIVE recurring price whose metadata names a canonical `tier_name` lands
 * on its tier — a monthly plan price → stripe_price_id + monthly_price_cents,
 * a yearly one → annual_price_cents, and a `kind = seat_package` price →
 * stripe_seat_price_id + seat_package_price_cents (+ seat_package_size from
 * metadata / transform_quantity). Prices it cannot place are RETURNED by id
 * with the reason, never guessed; tiers Stripe holds no plan price for are
 * named so a "synced" catalogue is never read as complete. Every tier write
 * is COUNTED and audited. Pure mapping: lib/billing/seat-packages.ts
 * catalogFromStripePrices. `dryRun` returns the patches without writing.
 */
export async function syncCatalogFromStripeAction(opts: { dryRun?: boolean } = {}): Promise<
  | { ok: true; updated: Array<{ tierName: string; patch: Record<string, unknown> }>; unmatched: Array<{ priceId: string; reason: string }>; tiersWithoutPlanPrice: string[]; dryRun: boolean }
  | { ok: false; error: string }
> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const { stripeListActivePrices } = await import("@/lib/billing/stripe-subscription-ops")
  const listed = await stripeListActivePrices()
  if (!listed.ok) return { ok: false, error: listed.skipped ? "Stripe is not configured (STRIPE_SECRET_KEY) — nothing to sync from" : `Stripe price list failed: ${listed.error ?? "unknown"}` }
  const { catalogFromStripePrices, priceFactsOf } = await import("@/lib/billing/seat-packages")
  const mapped = catalogFromStripePrices(listed.prices.map(priceFactsOf))

  const svc = createServiceClient()
  const updated: Array<{ tierName: string; patch: Record<string, unknown> }> = []
  for (const { tierName, patch } of mapped.patches) {
    if (Object.keys(patch).length === 0) continue
    if (opts.dryRun) { updated.push({ tierName, patch }); continue }
    const { data, error } = await svc.from("subscription_tiers").update(patch).eq("tier_name", tierName).select("id")
    if (error) return { ok: false, error: `subscription_tiers update refused for ${tierName}: ${error.message}` }
    if (!data || data.length === 0) return { ok: false, error: `no subscription_tiers row for '${tierName}' — a tier is a migration decision, never minted by a sync` }
    updated.push({ tierName, patch })
    await audit(auth.userId, "plan_tier.catalog_synced_from_stripe", (data[0] as any).id, { tierName, patch })
  }
  if (!opts.dryRun) { revalidatePath("/dashboard/superadmin/plans"); revalidatePath("/signup") }
  return { ok: true, updated, unmatched: mapped.unmatched, tiersWithoutPlanPrice: mapped.tiersWithoutPlanPrice, dryRun: opts.dryRun === true }
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
    // The Stripe price now EXISTS; a refused write here leaves the tier pointing at
    // the old price, so signups keep being charged it. Name the orphan price.
    const { error: pubErr } = await svc.from("subscription_tiers").update({ stripe_price_id: price.id }).eq("id", tierId)
    if (pubErr) return { ok: false, error: `Stripe price ${price.id} was created, but the plan tier was not repointed to it: ${pubErr.message}` }
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
// OVERAGE TERMS (m479 AI, m666 video; wave 87C: one mechanism for both, and
// an optional Stripe Billing metered price per tier) — administrable exactly
// like tier pricing.
// Owner ruling (verbatim): "the billing for overage needs to be coded so that
// we can pass in the cent per limit so the same as how we are handling the
// subscription tier amount." The per-tier terms (plan_limits.overage_allowed +
// overage_rate_cents_per_1k on the ai_tokens_monthly and video_minutes rows —
// OVERAGE_BILLED_METRICS) are configured HERE,
// through the same superadmin gate, the same pure-validator discipline, and the
// same audit trail as the tier price — never hardcoded, never edited raw.
// Consumers (lib/ai/fair-use.ts serving, lib/billing/ai-overage.ts billing)
// read the columns unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export interface AIOverageTermsRow {
  id: string
  plan_tier: string
  /** One of OVERAGE_BILLED_METRICS — ai_tokens_monthly (tokens) or video_minutes (minutes). */
  metric: string
  /** Included monthly units for the tier (plan_limits.limit_value; -1 = unlimited). */
  limit_value: number
  overage_allowed: boolean
  /** Integer CENTS per 1K units — meaningful only when overage_allowed. */
  overage_rate_cents_per_1k: number
  /** m669 — the tier's published Stripe link (null = bills by invoice item). */
  stripe_meter_id: string | null
  stripe_metered_price_id: string | null
  stripe_metered_rate_cents_per_1k: number | null
  /** false when the m669 columns could not be read — the card says so instead of showing "not published". */
  stripe_link_readable: boolean
}

/** Every (canonical tier, billed metric) row: included limit + overage terms +
 *  the Stripe metered-price link. The link columns are read SEPARATELY and a
 *  refusal there (m669 not yet applied) degrades to "unreadable", never breaks
 *  the terms the platform must still be able to administer. */
export async function listAIOverageTermsAction(): Promise<{ ok: true; terms: AIOverageTermsRow[] } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("plan_limits")
    .select("id, plan_tier, metric, limit_value, overage_allowed, overage_rate_cents_per_1k")
    .in("metric", [...OVERAGE_BILLED_METRICS])
    .in("plan_tier", [...CANONICAL_TIERS])
    .order("limit_value", { ascending: true })
  if (error) return { ok: false, error: error.message }
  const { data: links, error: linkError } = await svc
    .from("plan_limits")
    .select("id, stripe_meter_id, stripe_metered_price_id, stripe_metered_rate_cents_per_1k")
    .in("metric", [...OVERAGE_BILLED_METRICS])
    .in("plan_tier", [...CANONICAL_TIERS])
  const linkById = new Map<string, any>(((linkError ? [] : links) ?? []).map((l: any) => [l.id as string, l]))
  const terms: AIOverageTermsRow[] = ((data ?? []) as any[]).map((r) => {
    const l = linkById.get(r.id)
    return {
      id: r.id, plan_tier: r.plan_tier, metric: r.metric,
      limit_value: Number(r.limit_value), overage_allowed: !!r.overage_allowed,
      overage_rate_cents_per_1k: Number(r.overage_rate_cents_per_1k ?? 0),
      stripe_meter_id: l?.stripe_meter_id ?? null,
      stripe_metered_price_id: l?.stripe_metered_price_id ?? null,
      stripe_metered_rate_cents_per_1k: l?.stripe_metered_rate_cents_per_1k == null ? null : Number(l.stripe_metered_rate_cents_per_1k),
      stripe_link_readable: !linkError,
    }
  })
  return { ok: true, terms }
}

/**
 * Set a tier's overage terms for one billed metric (AI tokens or video
 * minutes). UPDATE-only on the live (tier, metric) row — this action can never
 * mint a plan_limits row (a new metric or tier is a migration decision, not a
 * form submit), and the validator refuses any metric outside
 * OVERAGE_BILLED_METRICS, so only a billed metric can ever be overage-enabled.
 * A rate edit does NOT touch Stripe: a published metered price at the old rate
 * becomes STALE and the period-close run falls back to the invoice item at the
 * new rate until staff republish (never billed at a rate nobody configured).
 */
export async function upsertAIOverageTermsAction(input: AIOverageTermsInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const v = validateAIOverageTermsInput(input)
  if (!v.ok) return { ok: false, error: v.error }

  const svc = createServiceClient()
  const { data: before, error: beforeError } = await svc
    .from("plan_limits")
    .select("overage_allowed, overage_rate_cents_per_1k")
    .eq("plan_tier", v.value.planTier)
    .eq("metric", v.value.metric)
    .maybeSingle()
  if (beforeError) return { ok: false, error: beforeError.message }
  const { data, error } = await svc
    .from("plan_limits")
    .update({
      overage_allowed: v.value.overageAllowed,
      overage_rate_cents_per_1k: v.value.overageRateCentsPer1k,
      updated_at: new Date().toISOString(),
    })
    .eq("plan_tier", v.value.planTier)
    .eq("metric", v.value.metric)
    .select("id")
  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) {
    return { ok: false, error: `no plan_limits row for (${v.value.planTier}, ${v.value.metric}) — seed the included limit first; overage terms are never created out of thin air` }
  }
  const id = (data[0] as any).id as string
  // THE CHANGE LOG: before → after, so the history reads as a diff.
  await audit(auth.userId, "plan_limits.overage_terms_updated", id, {
    planTier: v.value.planTier,
    metric: v.value.metric,
    overageAllowed: v.value.overageAllowed,
    overageRateCentsPer1k: v.value.overageRateCentsPer1k,
    before: before ? { overageAllowed: !!(before as any).overage_allowed, overageRateCentsPer1k: Number((before as any).overage_rate_cents_per_1k ?? 0) } : null,
  }, "plan_limit")
  revalidatePath("/dashboard/superadmin/plans")
  return { ok: true, id }
}

/**
 * PUBLISH a tier's overage terms to Stripe Billing (wave 87C): reuse/create the
 * metric's Billing Meter, create a monthly metered price at the tier's CURRENT
 * configured rate, store the link on plan_limits, and attach it to every
 * Stripe-linked subscription on the tier. From then on the period-close run
 * reports that tier's overage as meter events on the subscription. Pressing it
 * again after a rate edit republishes (a new price; the stale one is removed
 * from each subscription). Refuses — creating nothing — when the terms are off
 * or Stripe is not configured. An OWNER action: nothing calls it on a schedule.
 */
export async function publishOverageMeteredPriceAction(input: { planTier: string; metric: string }): Promise<
  | { ok: true; priceId: string; meterId: string; linked: number; notLinked: Array<{ brokerageId: string; reason: string }> }
  | { ok: false; error: string }
> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  if (!isOverageBilledMetric(input?.metric)) return { ok: false, error: `'${String(input?.metric)}' is not a billed overage metric` }
  const { isStripeConfigured } = await import("@/lib/billing/stripe-subscription-ops")
  if (!isStripeConfigured()) return { ok: false, error: "Stripe is not configured (STRIPE_SECRET_KEY) — nothing was published; overage keeps billing by invoice item" }
  const svc = createServiceClient()
  const { stripe } = await import("@/lib/stripe")
  const { publishOverageMeteredPrice } = await import("@/lib/billing/stripe-overage-meter")
  const r = await publishOverageMeteredPrice(svc, stripe as any, { planTier: input.planTier, metric: input.metric })
  if (!r.ok) return { ok: false, error: r.error }
  const { data: row } = await svc.from("plan_limits").select("id").eq("plan_tier", r.planTier).eq("metric", r.metric).maybeSingle()
  await audit(auth.userId, "plan_limits.overage_metered_price_published", ((row as any)?.id as string | undefined) ?? null, {
    planTier: r.planTier, metric: r.metric, meterId: r.meterId, meterCreated: r.meterCreated,
    priceId: r.priceId, unitAmountDecimalCents: r.unitAmountDecimal, linked: r.linked, notLinked: r.notLinked,
  }, "plan_limit")
  revalidatePath("/dashboard/superadmin/plans")
  return { ok: true, priceId: r.priceId, meterId: r.meterId, linked: r.linked, notLinked: r.notLinked }
}

export interface OverageTermsChangeRow {
  id: string
  action: string
  actorEmail: string | null
  details: Record<string, unknown>
  createdAtIso: string
}

/** THE AUDITED CHANGE LOG for overage terms and their Stripe publication —
 *  the reader for the audit rows the two actions above write. */
export async function listOverageTermsChangeLogAction(limit = 20): Promise<{ ok: true; rows: OverageTermsChangeRow[] } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const n = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)))
  const { data, error } = await svc
    .from("superadmin_audit_log")
    .select("id, action, actor_email, details, created_at")
    .eq("target_type", "plan_limit")
    .in("action", ["plan_limits.overage_terms_updated", "plan_limits.overage_metered_price_published", "plan_limits.ai_overage_terms_updated"])
    .order("created_at", { ascending: false })
    .limit(n)
  if (error) return { ok: false, error: error.message }
  return {
    ok: true,
    rows: ((data ?? []) as any[]).map((r) => ({
      id: r.id as string, action: r.action as string, actorEmail: (r.actor_email as string | null) ?? null,
      details: (r.details ?? {}) as Record<string, unknown>, createdAtIso: r.created_at as string,
    })),
  }
}
