"use server"

/**
 * app/actions/vendors/vendor-plans.ts
 *
 * THE VENDOR PLAN CATALOGUE — the writer `lib/vendors/vendor-validators.ts :: validateVendorPlan`
 * was waiting for, and the one `public.vendor_plans` never had.
 *
 * WHO MAY PUBLISH A PLAN — settled by the live database, not by this file. vendor_plans has RLS
 * enabled with three policies (measured on project hrvaqgvukzxfskkcrwbt):
 *
 *   vendor_plans_vendor_manage_own    ALL     is_current_user_marketplace_vendor(vendor_id)
 *   vendor_plans_platform_manage      ALL     is_platform_staff()
 *   vendor_plans_authenticated_browse SELECT  status = 'active'
 *
 * So a VENDOR manages their own catalogue, platform staff may act on any, and every authenticated
 * user may browse ACTIVE plans. Brokerage staff have no write path — they SUBSCRIBE
 * (vendor_subscriptions.plan_id → vendor_plans.id ON DELETE RESTRICT), they do not author.
 * These actions enforce exactly that boundary in app code as well, so the refusal is a sentence
 * rather than an empty result set.
 *
 * REFUSALS ARE REAL. supabase-js RESOLVES a refused query, so every call destructures
 * `{ data, error }` and reports it. Nothing here returns `{ ok: true }` on a write it did not make:
 *   · not authenticated / read-only impersonation → refused by resolveWriteContext
 *   · authenticated but not a marketplace vendor  → named refusal, no rows touched
 *   · a plan id that is not this vendor's         → "not found or not yours" (the ownership
 *                                                    predicate is on the UPDATE itself, so a
 *                                                    guessed id changes nothing)
 *   · delete of a plan a brokerage subscribes to  → refused by name BEFORE the FK raises 23503
 *
 * Every export is an async Server Action (a public HTTP endpoint). Helpers below are deliberately
 * NOT exported.
 */

import { revalidatePath } from "next/cache"
import { resolveWriteContext } from "@/lib/platform/acting-context"
import {
  validateVendorPlan,
  VENDOR_PLAN_STATUSES,
  type VendorPlanBillingCycle,
  type VendorPlanStatus,
} from "@/lib/vendors/vendor-validators"

export interface VendorPlan {
  id: string
  vendor_id: string
  name: string
  description: string | null
  price_per_month: number
  price_per_credit: number | null
  max_credits_per_month: number | null
  features_json: unknown
  billing_cycle: VendorPlanBillingCycle
  trial_days: number
  status: VendorPlanStatus
  is_default: boolean
  created_at: string | null
  updated_at: string | null
  /** Live count of brokerage subscriptions pointing at this plan — why a delete may be refused. */
  subscriber_count?: number
}

export interface VendorPlanInput {
  name: string
  description?: string | null
  price_per_month: number | string
  price_per_credit?: number | string | null
  max_credits_per_month?: number | string | null
  billing_cycle: VendorPlanBillingCycle
  trial_days?: number | string | null
  features?: string[]
  status?: VendorPlanStatus
}

export type VendorPlanResult =
  | { ok: true; plan: VendorPlan }
  | { ok: false; error: string; fieldErrors?: string[] }

export type VendorPlanListResult =
  | { ok: true; plans: VendorPlan[]; vendorId: string }
  | { ok: false; error: string }

const PLAN_COLUMNS =
  "id, vendor_id, name, description, price_per_month, price_per_credit, max_credits_per_month, " +
  "features_json, billing_cycle, trial_days, status, is_default, created_at, updated_at"

/**
 * Resolve the acting user's OWN vendor marketplace profile, through the write seam (so a
 * read-only act-as session is refused before it can reach a write).
 *
 * NOT EXPORTED — a "use server" module's exports are all public endpoints, and this one hands back
 * a live database client.
 */
async function actingVendor(): Promise<
  { ok: true; db: any; vendorId: string; userId: string } | { ok: false; error: string }
> {
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { ok: false, error: ctx.error }

  const { data: profile, error } = await ctx.db
    .from("vendor_marketplace_profiles")
    .select("id, user_id")
    .eq("user_id", ctx.userId)
    .maybeSingle()

  // A REFUSED read is not "no profile" — say which one happened.
  if (error) return { ok: false, error: `Could not read your vendor profile: ${error.message}` }
  if (!profile) {
    return {
      ok: false,
      error: "This account has no vendor marketplace profile, so it cannot publish plans.",
    }
  }
  return { ok: true, db: ctx.db, vendorId: profile.id as string, userId: ctx.userId }
}

/** Numeric coercion for the writes. Returns null for anything unusable — the validator already ran. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** Build the column payload from validated input. Never invents a value the caller did not give. */
function planPayload(input: VendorPlanInput) {
  return {
    name: String(input.name).trim(),
    description: input.description ? String(input.description).trim() : null,
    price_per_month: num(input.price_per_month) ?? 0,
    price_per_credit: num(input.price_per_credit),
    max_credits_per_month: num(input.max_credits_per_month),
    billing_cycle: input.billing_cycle,
    trial_days: num(input.trial_days) ?? 0,
    features_json: Array.isArray(input.features)
      ? input.features.map((f) => String(f).trim()).filter(Boolean)
      : [],
    status: input.status ?? "active",
  }
}

/**
 * The acting vendor's full catalogue — ACTIVE and ARCHIVED, because a vendor must be able to see
 * and restore what they archived. (The browse policy only exposes active plans to everyone else.)
 * Each plan carries its live subscriber count so the UI can say why a delete is unavailable.
 */
export async function listVendorPlansAction(): Promise<VendorPlanListResult> {
  const actor = await actingVendor()
  if (!actor.ok) return { ok: false, error: actor.error }

  const { data, error } = await actor.db
    .from("vendor_plans")
    .select(PLAN_COLUMNS)
    .eq("vendor_id", actor.vendorId)
    .order("is_default", { ascending: false })
    .order("price_per_month", { ascending: true })

  if (error) return { ok: false, error: `Could not load your plans: ${error.message}` }

  const plans = (data ?? []) as VendorPlan[]
  if (plans.length === 0) return { ok: true, plans, vendorId: actor.vendorId }

  const { data: subs, error: subsError } = await actor.db
    .from("vendor_subscriptions")
    .select("plan_id")
    .eq("vendor_id", actor.vendorId)

  // A refused subscription read must not render every plan as "0 subscribers, safe to delete".
  if (subsError) {
    return { ok: false, error: `Could not load plan subscriptions: ${subsError.message}` }
  }
  const counts = new Map<string, number>()
  for (const s of (subs ?? []) as Array<{ plan_id: string }>) {
    counts.set(s.plan_id, (counts.get(s.plan_id) ?? 0) + 1)
  }
  return {
    ok: true,
    vendorId: actor.vendorId,
    plans: plans.map((p) => ({ ...p, subscriber_count: counts.get(p.id) ?? 0 })),
  }
}

/** Publish a new plan on the acting vendor's catalogue. */
export async function createVendorPlanAction(input: VendorPlanInput): Promise<VendorPlanResult> {
  const actor = await actingVendor()
  if (!actor.ok) return { ok: false, error: actor.error }

  const fieldErrors = validateVendorPlan(input)
  if (fieldErrors.length > 0) {
    return { ok: false, error: "This plan cannot be published yet.", fieldErrors }
  }

  const { data, error } = await actor.db
    .from("vendor_plans")
    .insert({ ...planPayload(input), vendor_id: actor.vendorId })
    .select(PLAN_COLUMNS)
    .single()

  if (error) return { ok: false, error: `Could not create the plan: ${error.message}` }
  revalidatePath("/vendor/plans")
  return { ok: true, plan: data as VendorPlan }
}

/** Edit one of the acting vendor's own plans. */
export async function updateVendorPlanAction(params: {
  planId: string
  input: VendorPlanInput
}): Promise<VendorPlanResult> {
  const actor = await actingVendor()
  if (!actor.ok) return { ok: false, error: actor.error }
  if (!params?.planId) return { ok: false, error: "A plan id is required." }

  const fieldErrors = validateVendorPlan(params.input)
  if (fieldErrors.length > 0) {
    return { ok: false, error: "This plan cannot be saved yet.", fieldErrors }
  }

  // OWNERSHIP IS ON THE UPDATE, not a prior read: `.eq("vendor_id", …)` means another vendor's id
  // matches zero rows and changes nothing, with no window between check and write.
  const { data, error } = await actor.db
    .from("vendor_plans")
    .update({ ...planPayload(params.input), updated_at: new Date().toISOString() })
    .eq("id", params.planId)
    .eq("vendor_id", actor.vendorId)
    .select(PLAN_COLUMNS)
    .maybeSingle()

  if (error) return { ok: false, error: `Could not save the plan: ${error.message}` }
  if (!data) return { ok: false, error: "That plan was not found on your catalogue." }
  revalidatePath("/vendor/plans")
  return { ok: true, plan: data as VendorPlan }
}

/**
 * Archive or restore a plan.
 *
 * ARCHIVING IS THE RETIREMENT PATH, not deletion: `vendor_subscriptions.plan_id` is ON DELETE
 * RESTRICT, so a plan someone pays for can never be removed — and should not be. Archived plans
 * drop out of `vendor_plans_authenticated_browse` (status = 'active') so nobody new can subscribe,
 * while existing subscriptions keep a valid plan row to point at.
 */
export async function setVendorPlanStatusAction(params: {
  planId: string
  status: VendorPlanStatus
}): Promise<VendorPlanResult> {
  const actor = await actingVendor()
  if (!actor.ok) return { ok: false, error: actor.error }
  if (!params?.planId) return { ok: false, error: "A plan id is required." }
  if (!VENDOR_PLAN_STATUSES.includes(params.status)) {
    return { ok: false, error: `Status must be one of: ${VENDOR_PLAN_STATUSES.join(", ")}` }
  }

  const patch: Record<string, unknown> = { status: params.status, updated_at: new Date().toISOString() }
  // An archived plan must not stay the default new-subscriber plan.
  if (params.status === "archived") patch.is_default = false

  const { data, error } = await actor.db
    .from("vendor_plans")
    .update(patch)
    .eq("id", params.planId)
    .eq("vendor_id", actor.vendorId)
    .select(PLAN_COLUMNS)
    .maybeSingle()

  if (error) return { ok: false, error: `Could not update the plan: ${error.message}` }
  if (!data) return { ok: false, error: "That plan was not found on your catalogue." }
  revalidatePath("/vendor/plans")
  return { ok: true, plan: data as VendorPlan }
}

/**
 * Make one plan the default. Exactly one may hold it, so the others are cleared first.
 *
 * The clear and the set are two statements; if the SET fails after the CLEAR succeeded, the vendor
 * ends with NO default rather than two — the safe direction, and it is reported rather than hidden.
 */
export async function setDefaultVendorPlanAction(params: { planId: string }): Promise<VendorPlanResult> {
  const actor = await actingVendor()
  if (!actor.ok) return { ok: false, error: actor.error }
  if (!params?.planId) return { ok: false, error: "A plan id is required." }

  const { data: target, error: targetError } = await actor.db
    .from("vendor_plans")
    .select("id, status")
    .eq("id", params.planId)
    .eq("vendor_id", actor.vendorId)
    .maybeSingle()
  if (targetError) return { ok: false, error: `Could not read that plan: ${targetError.message}` }
  if (!target) return { ok: false, error: "That plan was not found on your catalogue." }
  if (target.status !== "active") {
    return { ok: false, error: "An archived plan cannot be the default — restore it first." }
  }

  const { error: clearError } = await actor.db
    .from("vendor_plans")
    .update({ is_default: false, updated_at: new Date().toISOString() })
    .eq("vendor_id", actor.vendorId)
    .eq("is_default", true)
  if (clearError) return { ok: false, error: `Could not clear the previous default: ${clearError.message}` }

  const { data, error } = await actor.db
    .from("vendor_plans")
    .update({ is_default: true, updated_at: new Date().toISOString() })
    .eq("id", params.planId)
    .eq("vendor_id", actor.vendorId)
    .select(PLAN_COLUMNS)
    .maybeSingle()

  if (error) {
    return {
      ok: false,
      error: `Could not set the default (your catalogue now has no default plan): ${error.message}`,
    }
  }
  if (!data) return { ok: false, error: "That plan was not found on your catalogue." }
  revalidatePath("/vendor/plans")
  return { ok: true, plan: data as VendorPlan }
}

/**
 * Permanently delete a plan — allowed ONLY while nothing subscribes to it.
 *
 * `vendor_subscriptions.plan_id` is ON DELETE RESTRICT, so a subscribed plan would fail with a raw
 * 23503 from Postgres. The count is checked first so the vendor is told the actual reason and the
 * number, and pointed at archiving instead.
 */
export async function deleteVendorPlanAction(params: { planId: string }): Promise<
  { ok: true; deletedId: string } | { ok: false; error: string }
> {
  const actor = await actingVendor()
  if (!actor.ok) return { ok: false, error: actor.error }
  if (!params?.planId) return { ok: false, error: "A plan id is required." }

  const { count, error: countError } = await actor.db
    .from("vendor_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("plan_id", params.planId)
    .eq("vendor_id", actor.vendorId)
  if (countError) {
    return { ok: false, error: `Could not check plan subscriptions: ${countError.message}` }
  }
  if ((count ?? 0) > 0) {
    return {
      ok: false,
      error:
        `${count} brokerage subscription${count === 1 ? "" : "s"} point at this plan, so it cannot ` +
        `be deleted. Archive it instead — that closes it to new subscribers and keeps the existing ` +
        `ones valid.`,
    }
  }

  const { data, error } = await actor.db
    .from("vendor_plans")
    .delete()
    .eq("id", params.planId)
    .eq("vendor_id", actor.vendorId)
    .select("id")
    .maybeSingle()

  if (error) return { ok: false, error: `Could not delete the plan: ${error.message}` }
  if (!data) return { ok: false, error: "That plan was not found on your catalogue." }
  revalidatePath("/vendor/plans")
  return { ok: true, deletedId: data.id as string }
}
