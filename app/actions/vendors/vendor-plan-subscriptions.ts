"use server"

/**
 * app/actions/vendors/vendor-plan-subscriptions.ts
 *
 * THE OTHER HALF OF THE VENDOR PLAN CATALOGUE — the writer for `vendor_subscriptions`.
 *
 * WHY THIS EXISTS. app/actions/vendors/vendor-plans.ts gave `vendor_plans` its first writer, and
 * reads `vendor_subscriptions` for two things: the subscriber count shown on each plan, and the
 * gate that refuses deleting a plan somebody pays for. The writer-less-read sweep caught that
 * immediately, and it was RIGHT to: with no writer, "0 brokerage subscriptions" is not a
 * measurement, it is a structural certainty — and a delete gate that can never fire is a safety
 * check that only looks like one. A catalogue nobody can subscribe to is the same half-built
 * shape this whole pass exists to close.
 *
 * WHAT A SUBSCRIPTION IS HERE. `vendor_subscriptions(brokerage_id, vendor_id, plan_id)` is the
 * ENTITLEMENT record: which of a vendor's published plans this brokerage is on, its billing
 * period, and the credits consumed against it. It is NOT a Stripe subscription — the two stripe_*
 * columns are nullable and stay NULL on this path, and the UI says so rather than implying a
 * charge was made. Money between a brokerage and a vendor already has its lane
 * (`vendor_invoices.billed_to`, app/actions/vendor-payments.ts); this table is the plan the
 * invoice is FOR, not a second billing rail.
 *
 * TENANT SCOPING. The brokerage comes from `resolveWriteContext()`, never from the caller, and
 * every read and write pins `.eq("brokerage_id", ctx.brokerageId)`. A brokerage can only ever see
 * and change its own subscriptions.
 *
 * REFUSALS. Only `status = 'active'` plans may be subscribed to — that is the same line
 * `vendor_plans_authenticated_browse` draws, so an archived plan is refused by name here instead
 * of silently returning nothing. The live UNIQUE (brokerage_id, vendor_id, plan_id) is checked
 * before the insert so a repeat subscribe is reported as "already subscribed" rather than a 23505.
 */

import { revalidatePath } from "next/cache"
import { resolveWriteContext } from "@/lib/platform/acting-context"

export interface VendorPlanCatalogueEntry {
  plan_id: string
  vendor_id: string
  vendor_name: string | null
  name: string
  description: string | null
  price_per_month: number
  price_per_credit: number | null
  max_credits_per_month: number | null
  billing_cycle: string
  trial_days: number
  is_default: boolean
  /** This brokerage's subscription to this plan, when it has one. */
  subscription: {
    id: string
    status: string
    current_period_start: string
    current_period_end: string
    credits_used_this_period: number
  } | null
}

export type VendorPlanCatalogueResult =
  | { ok: true; entries: VendorPlanCatalogueEntry[] }
  | { ok: false; error: string }

export type VendorSubscriptionResult =
  | { ok: true; subscriptionId: string; status: string }
  | { ok: false; error: string }

/** Period length per billing cycle, in days. Matches the two values the live CHECK allows. */
const PERIOD_DAYS: Record<string, number> = { monthly: 30, annual: 365 }

/**
 * Every ACTIVE published plan across the marketplace, with this brokerage's own subscription
 * attached where one exists.
 *
 * Reads only `status = 'active'` — the same slice the live browse policy exposes — so an archived
 * plan can never be presented as subscribable.
 */
export async function listVendorPlanCatalogueAction(): Promise<VendorPlanCatalogueResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { ok: false, error: ctx.error }
  if (!ctx.brokerageId) return { ok: false, error: "Your account is not attached to a brokerage yet." }

  const { data: plans, error: plansError } = await ctx.db
    .from("vendor_plans")
    .select(
      "id, vendor_id, name, description, price_per_month, price_per_credit, max_credits_per_month, " +
      "billing_cycle, trial_days, is_default",
    )
    .eq("status", "active")
    .order("price_per_month", { ascending: true })

  if (plansError) return { ok: false, error: `Could not load the vendor plan catalogue: ${plansError.message}` }
  const planRows = (plans ?? []) as Array<Record<string, any>>
  if (planRows.length === 0) return { ok: true, entries: [] }

  // WHY THE COMPANY NAME IS NOT AN EMBED. A PostgREST embed applies the EMBEDDED table's RLS, and
  // `vendor_marketplace_profiles` grants SELECT only to the vendor themself and to platform staff.
  // A brokerage user embedding it gets a plan list where every publisher is null — a catalogue you
  // cannot attribute, silently. Widening that policy is the wrong fix: the row also carries
  // api_key_encrypted and the Stripe ids, and an RLS policy grants the whole row.
  //
  // So the name is fetched deliberately and narrowly: the service client, ONLY the ids that
  // already have an ACTIVE published plan (which `vendor_plans_authenticated_browse` shows to
  // every authenticated user anyway), and ONLY the two columns needed to label a card.
  const { createServiceClient } = await import("@/lib/supabase/service")
  const vendorIds = [...new Set(planRows.map((p) => p.vendor_id).filter(Boolean))]
  const { data: vendorRows, error: vendorError } = await createServiceClient()
    .from("vendor_marketplace_profiles")
    .select("id, company_name")
    .in("id", vendorIds)
  if (vendorError) return { ok: false, error: `Could not load vendor names: ${vendorError.message}` }
  const vendorNames = new Map<string, string | null>(
    ((vendorRows ?? []) as Array<{ id: string; company_name: string | null }>).map((v) => [v.id, v.company_name]),
  )

  const { data: subs, error: subsError } = await ctx.db
    .from("vendor_subscriptions")
    .select("id, plan_id, status, current_period_start, current_period_end, credits_used_this_period")
    .eq("brokerage_id", ctx.brokerageId)

  // A refused subscription read would render every plan as "not subscribed" — a wrong fact, not a
  // missing one, and the subscribe button would then offer a duplicate the UNIQUE index refuses.
  if (subsError) return { ok: false, error: `Could not load your vendor subscriptions: ${subsError.message}` }

  const byPlan = new Map<string, any>()
  for (const s of (subs ?? []) as Array<Record<string, any>>) byPlan.set(s.plan_id, s)

  return {
    ok: true,
    entries: planRows.map((p) => ({
      plan_id: p.id,
      vendor_id: p.vendor_id,
      vendor_name: vendorNames.get(p.vendor_id) ?? null,
      name: p.name,
      description: p.description ?? null,
      price_per_month: Number(p.price_per_month),
      price_per_credit: p.price_per_credit === null ? null : Number(p.price_per_credit),
      max_credits_per_month: p.max_credits_per_month ?? null,
      billing_cycle: p.billing_cycle,
      trial_days: p.trial_days ?? 0,
      is_default: !!p.is_default,
      subscription: byPlan.get(p.id)
        ? {
            id: byPlan.get(p.id).id,
            status: byPlan.get(p.id).status,
            current_period_start: byPlan.get(p.id).current_period_start,
            current_period_end: byPlan.get(p.id).current_period_end,
            credits_used_this_period: byPlan.get(p.id).credits_used_this_period ?? 0,
          }
        : null,
    })),
  }
}

/**
 * Put this brokerage on a vendor's published plan.
 *
 * The plan is re-read server-side (never trusted from the client) to get its vendor_id and to
 * confirm it is still active, then the period is derived from the plan's own billing_cycle plus
 * any trial. Nothing is charged here — see the module header.
 */
export async function subscribeToVendorPlanAction(params: { planId: string }): Promise<VendorSubscriptionResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { ok: false, error: ctx.error }
  if (!ctx.brokerageId) return { ok: false, error: "Your account is not attached to a brokerage yet." }
  if (!params?.planId) return { ok: false, error: "A plan id is required." }

  const { data: plan, error: planError } = await ctx.db
    .from("vendor_plans")
    .select("id, vendor_id, status, billing_cycle, trial_days")
    .eq("id", params.planId)
    .maybeSingle()
  if (planError) return { ok: false, error: `Could not read that plan: ${planError.message}` }
  if (!plan) return { ok: false, error: "That plan no longer exists." }
  if (plan.status !== "active") {
    return { ok: false, error: "That plan has been archived by the vendor and is closed to new subscribers." }
  }

  // The live UNIQUE (brokerage_id, vendor_id, plan_id) — checked by name so a repeat subscribe is
  // a sentence, not a 23505. A CANCELED row is reactivated rather than duplicated, because the
  // unique index does not care about status.
  const { data: existing, error: existingError } = await ctx.db
    .from("vendor_subscriptions")
    .select("id, status")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("vendor_id", plan.vendor_id)
    .eq("plan_id", plan.id)
    .maybeSingle()
  if (existingError) return { ok: false, error: `Could not check your existing subscription: ${existingError.message}` }

  const start = new Date()
  const days = (PERIOD_DAYS[plan.billing_cycle] ?? 30) + (plan.trial_days ?? 0)
  const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000)

  if (existing) {
    if (existing.status === "active") {
      return { ok: false, error: "Your brokerage is already subscribed to this plan." }
    }
    const { data: revived, error: reviveError } = await ctx.db
      .from("vendor_subscriptions")
      .update({
        status: "active",
        canceled_at: null,
        current_period_start: start.toISOString(),
        current_period_end: end.toISOString(),
        credits_used_this_period: 0,
        updated_at: start.toISOString(),
      })
      .eq("id", existing.id)
      .eq("brokerage_id", ctx.brokerageId)
      .select("id, status")
      .maybeSingle()
    if (reviveError) return { ok: false, error: `Could not resume the subscription: ${reviveError.message}` }
    if (!revived) return { ok: false, error: "That subscription was not found on your brokerage." }
    revalidatePath("/dashboard/vendors")
    return { ok: true, subscriptionId: revived.id as string, status: revived.status as string }
  }

  const { data: created, error: createError } = await ctx.db
    .from("vendor_subscriptions")
    .insert({
      brokerage_id: ctx.brokerageId,
      vendor_id: plan.vendor_id,
      plan_id: plan.id,
      status: "active",
      current_period_start: start.toISOString(),
      current_period_end: end.toISOString(),
      credits_used_this_period: 0,
    })
    .select("id, status")
    .single()
  if (createError) return { ok: false, error: `Could not subscribe to that plan: ${createError.message}` }
  revalidatePath("/dashboard/vendors")
  return { ok: true, subscriptionId: created.id as string, status: created.status as string }
}

/**
 * Cancel this brokerage's subscription to a vendor plan.
 *
 * The ROW IS KEPT with status 'canceled' and a canceled_at stamp, never deleted: it is the record
 * of a period that was used, and `credits_used_this_period` on it is the basis of anything the
 * vendor still invoices for. Deleting it would erase that.
 */
export async function cancelVendorPlanSubscriptionAction(params: {
  subscriptionId: string
}): Promise<VendorSubscriptionResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { ok: false, error: ctx.error }
  if (!ctx.brokerageId) return { ok: false, error: "Your account is not attached to a brokerage yet." }
  if (!params?.subscriptionId) return { ok: false, error: "A subscription id is required." }

  const { data, error } = await ctx.db
    .from("vendor_subscriptions")
    .update({ status: "canceled", canceled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", params.subscriptionId)
    .eq("brokerage_id", ctx.brokerageId)
    .select("id, status")
    .maybeSingle()

  if (error) return { ok: false, error: `Could not cancel that subscription: ${error.message}` }
  if (!data) return { ok: false, error: "That subscription was not found on your brokerage." }
  revalidatePath("/dashboard/vendors")
  return { ok: true, subscriptionId: data.id as string, status: data.status as string }
}
