"use server"

/**
 * app/actions/vendors/vendor-plans.ts
 *
 * THE BROKERAGE'S VENDOR PACKAGE CATALOGUE — `public.vendor_plans`.
 *
 * ══ THE DIRECTION THIS FILE SHIPPED WITH WAS WRONG, AND THAT IS THE POINT ══
 *
 * Two waves ago this module was written as A VENDOR PUBLISHING ITS OWN PRICE
 * LIST for brokerages to subscribe to — money brokerage → vendor, monthly. The
 * owner ruling, verbatim:
 *
 *   "vendor packages are for brokerages to charge the vendor on a subscription
 *    to the platform. vendors do bill the brokerages for jobs but not a monthly
 *    subscription."
 *
 * So a VENDOR PACKAGE is something a BROKERAGE SELLS TO A VENDOR: recurring
 * access and placement in that brokerage's marketplace. MONEY FLOWS VENDOR →
 * BROKERAGE. The only recurring path between the two runs that way, and the
 * brokerage → vendor money is PER JOB, through `vendor_invoices` with
 * billed_to='brokerage'. m497 repoints the schema; this file is the writer.
 *
 * The earlier header claimed the live RLS had "already answered" who publishes a
 * plan. It answered a narrower question than it was read as answering: the
 * policies said a marketplace vendor could write `vendor_plans` rows, which is
 * true of a catalogue THE VENDOR OWNS and says nothing about which way money
 * moves. Meanwhile the policies on `vendor_subscriptions` — brokerage finance
 * admin writes, vendor reads only — were describing the corrected direction the
 * whole time. The schema was read where it was convenient and not where it
 * disagreed.
 *
 * ══ WHO MAY AUTHOR A PACKAGE ══
 *
 * The SELLING BROKERAGE's finance admin, on the same tier that already guards
 * `vendor_subscriptions` and `vendor_invoices` (m497:
 * vendor_plans_brokerage_manage_own → is_platform_admin() OR
 * (has_brokerage_access(brokerage_id) AND is_brokerage_finance_admin())). A
 * vendor has NO write path: the payer does not author its own bill.
 *
 * ══ THIS IS A PRICE SHEET, NOT A BILLING RAIL ══
 *
 * Nothing here charges anything. The collectable amount is raised through
 * `vendor_invoices` with billed_to='vendor' — the ONE tenant→vendor ledger this
 * repo has, shared with app/actions/vendor-payments.ts :: issueVendorCharge and
 * lib/vendors/premium-placement.ts. A second rail would make "what does this
 * vendor owe us" a question with two answers.
 *
 * ══ REFUSALS ARE REAL ══
 *
 * supabase-js RESOLVES a refused query, so every call destructures
 * `{ data, error }` and reports it. Nothing returns `{ ok: true }` on a write it
 * did not make:
 *   · not authenticated / read-only impersonation → refused by resolveWriteContext
 *   · no brokerage on the acting context          → named refusal, no rows touched
 *   · a package id that is not this brokerage's   → "not found on your catalogue"
 *                                                   (the ownership predicate is on
 *                                                    the UPDATE itself, so a guessed
 *                                                    id changes nothing)
 *   · delete of a package a vendor is enrolled in → refused by name AND count
 *                                                   before the FK raises 23503
 *
 * Every export is an async Server Action (a public HTTP endpoint). Helpers below
 * are deliberately NOT exported.
 */

import { revalidatePath } from "next/cache"
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"
import { VENDOR_PACKAGE, describeDirection } from "@/lib/vendors/vendor-money-directions"
import {
  validateVendorPlan,
  VENDOR_PLAN_STATUSES,
  type VendorPlanBillingCycle,
  type VendorPlanStatus,
} from "@/lib/vendors/vendor-validators"

export interface VendorPlan {
  id: string
  /** The SELLER — the brokerage that collects this package fee. */
  brokerage_id: string
  name: string
  description: string | null
  /** What the VENDOR pays the brokerage each period. */
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
  /** Live count of VENDORS enrolled in this package — why a delete may be refused. */
  enrolled_vendor_count?: number
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
  | { ok: true; plans: VendorPlan[]; brokerageId: string; direction: string }
  | { ok: false; error: string }

const PLAN_COLUMNS =
  "id, brokerage_id, name, description, price_per_month, price_per_credit, max_credits_per_month, " +
  "features_json, billing_cycle, trial_days, status, is_default, created_at, updated_at"

/**
 * Resolve the acting SELLING BROKERAGE through the write seam (so a read-only
 * act-as session is refused before it can reach a write).
 *
 * NOT EXPORTED — a "use server" module's exports are all public endpoints, and
 * this one hands back a live database client.
 */
async function actingSeller(
  mode: "read" | "write",
): Promise<
  { ok: true; db: any; brokerageId: string; userId: string } | { ok: false; error: string }
> {
  // ONE gate, TWO channels (§6). `write` refuses a read_only act-as grant before
  // any catalogue row is touched; `read` admits it so a support seat can SEE the
  // packages it is investigating (§5 — a grant walks the account). The service
  // client, the tenant and the seller predicate are identical on both channels.
  const ctx = mode === "write" ? await resolveWriteContext() : await resolveActingContext()
  if (!ctx.ok) return { ok: false, error: ctx.error ?? "Unauthorized" }
  if (!ctx.brokerageId) {
    return {
      ok: false,
      error: "Your account is not attached to a brokerage, so it cannot sell vendor packages.",
    }
  }
  return { ok: true, db: ctx.db, brokerageId: ctx.brokerageId, userId: ctx.userId }
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
 * This brokerage's full package catalogue — ACTIVE and ARCHIVED, because a
 * seller must be able to see and restore what it archived. Each package carries
 * its live enrolled-vendor count so the UI can say why a delete is unavailable.
 */
export async function listVendorPlansAction(): Promise<VendorPlanListResult> {
  const actor = await actingSeller("read")
  if (!actor.ok) return { ok: false, error: actor.error }

  const { data, error } = await actor.db
    .from("vendor_plans")
    .select(PLAN_COLUMNS)
    .eq("brokerage_id", actor.brokerageId)
    .order("is_default", { ascending: false })
    .order("price_per_month", { ascending: true })

  if (error) return { ok: false, error: `Could not load your vendor packages: ${error.message}` }

  const plans = (data ?? []) as VendorPlan[]
  const direction = describeDirection(VENDOR_PACKAGE)
  if (plans.length === 0) {
    return { ok: true, plans, brokerageId: actor.brokerageId, direction }
  }

  const { data: subs, error: subsError } = await actor.db
    .from("vendor_subscriptions")
    .select("plan_id")
    .eq("brokerage_id", actor.brokerageId)

  // A refused enrolment read must not render every package as "0 vendors, safe to delete".
  if (subsError) {
    return { ok: false, error: `Could not load package enrolments: ${subsError.message}` }
  }
  const counts = new Map<string, number>()
  for (const s of (subs ?? []) as Array<{ plan_id: string }>) {
    counts.set(s.plan_id, (counts.get(s.plan_id) ?? 0) + 1)
  }
  return {
    ok: true,
    brokerageId: actor.brokerageId,
    direction,
    plans: plans.map((p) => ({ ...p, enrolled_vendor_count: counts.get(p.id) ?? 0 })),
  }
}

/** Publish a new package on the acting brokerage's catalogue. */
export async function createVendorPlanAction(input: VendorPlanInput): Promise<VendorPlanResult> {
  const actor = await actingSeller("write")
  if (!actor.ok) return { ok: false, error: actor.error }

  const fieldErrors = validateVendorPlan(input)
  if (fieldErrors.length > 0) {
    return { ok: false, error: "This package cannot be published yet.", fieldErrors }
  }

  const { data, error } = await actor.db
    .from("vendor_plans")
    .insert({ ...planPayload(input), brokerage_id: actor.brokerageId })
    .select(PLAN_COLUMNS)
    .single()

  if (error) return { ok: false, error: `Could not create the package: ${error.message}` }
  revalidatePath("/dashboard/vendors")
  revalidatePath("/vendor/plans")
  return { ok: true, plan: data as VendorPlan }
}

/** Edit one of the acting brokerage's own packages. */
export async function updateVendorPlanAction(params: {
  planId: string
  input: VendorPlanInput
}): Promise<VendorPlanResult> {
  const actor = await actingSeller("write")
  if (!actor.ok) return { ok: false, error: actor.error }
  if (!params?.planId) return { ok: false, error: "A package id is required." }

  const fieldErrors = validateVendorPlan(params.input)
  if (fieldErrors.length > 0) {
    return { ok: false, error: "This package cannot be saved yet.", fieldErrors }
  }

  // OWNERSHIP IS ON THE UPDATE, not a prior read: `.eq("brokerage_id", …)` means another tenant's
  // id matches zero rows and changes nothing, with no window between check and write.
  const { data, error } = await actor.db
    .from("vendor_plans")
    .update({ ...planPayload(params.input), updated_at: new Date().toISOString() })
    .eq("id", params.planId)
    .eq("brokerage_id", actor.brokerageId)
    .select(PLAN_COLUMNS)
    .maybeSingle()

  if (error) return { ok: false, error: `Could not save the package: ${error.message}` }
  if (!data) return { ok: false, error: "That package was not found on your catalogue." }
  revalidatePath("/dashboard/vendors")
  revalidatePath("/vendor/plans")
  return { ok: true, plan: data as VendorPlan }
}

/**
 * Archive or restore a package.
 *
 * ARCHIVING IS THE RETIREMENT PATH, not deletion: the composite FK
 * `vendor_subscriptions(plan_id, brokerage_id)` is ON DELETE RESTRICT, so a
 * package a vendor is paying for can never be removed — and should not be.
 * Archived packages drop out of the shopper browse policy (status = 'active') so
 * no new vendor can be enrolled, while existing enrolments keep a valid package
 * row to point at.
 */
export async function setVendorPlanStatusAction(params: {
  planId: string
  status: VendorPlanStatus
}): Promise<VendorPlanResult> {
  const actor = await actingSeller("write")
  if (!actor.ok) return { ok: false, error: actor.error }
  if (!params?.planId) return { ok: false, error: "A package id is required." }
  if (!VENDOR_PLAN_STATUSES.includes(params.status)) {
    return { ok: false, error: `Status must be one of: ${VENDOR_PLAN_STATUSES.join(", ")}` }
  }

  const patch: Record<string, unknown> = { status: params.status, updated_at: new Date().toISOString() }
  // An archived package must not stay the default new-enrolment package.
  if (params.status === "archived") patch.is_default = false

  const { data, error } = await actor.db
    .from("vendor_plans")
    .update(patch)
    .eq("id", params.planId)
    .eq("brokerage_id", actor.brokerageId)
    .select(PLAN_COLUMNS)
    .maybeSingle()

  if (error) return { ok: false, error: `Could not update the package: ${error.message}` }
  if (!data) return { ok: false, error: "That package was not found on your catalogue." }
  revalidatePath("/dashboard/vendors")
  revalidatePath("/vendor/plans")
  return { ok: true, plan: data as VendorPlan }
}

/**
 * Make one package the default. Exactly one may hold it
 * (m497: vendor_plans_one_default_per_brokerage), so the others are cleared first.
 *
 * The clear and the set are two statements; if the SET fails after the CLEAR
 * succeeded, the brokerage ends with NO default rather than two — the safe
 * direction, and it is reported rather than hidden.
 */
export async function setDefaultVendorPlanAction(params: { planId: string }): Promise<VendorPlanResult> {
  const actor = await actingSeller("write")
  if (!actor.ok) return { ok: false, error: actor.error }
  if (!params?.planId) return { ok: false, error: "A package id is required." }

  const { data: target, error: targetError } = await actor.db
    .from("vendor_plans")
    .select("id, status")
    .eq("id", params.planId)
    .eq("brokerage_id", actor.brokerageId)
    .maybeSingle()
  if (targetError) return { ok: false, error: `Could not read that package: ${targetError.message}` }
  if (!target) return { ok: false, error: "That package was not found on your catalogue." }
  if (target.status !== "active") {
    return { ok: false, error: "An archived package cannot be the default — restore it first." }
  }

  const { error: clearError } = await actor.db
    .from("vendor_plans")
    .update({ is_default: false, updated_at: new Date().toISOString() })
    .eq("brokerage_id", actor.brokerageId)
    .eq("is_default", true)
  if (clearError) return { ok: false, error: `Could not clear the previous default: ${clearError.message}` }

  const { data, error } = await actor.db
    .from("vendor_plans")
    .update({ is_default: true, updated_at: new Date().toISOString() })
    .eq("id", params.planId)
    .eq("brokerage_id", actor.brokerageId)
    .select(PLAN_COLUMNS)
    .maybeSingle()

  if (error) {
    return {
      ok: false,
      error: `Could not set the default (your catalogue now has no default package): ${error.message}`,
    }
  }
  if (!data) return { ok: false, error: "That package was not found on your catalogue." }
  revalidatePath("/dashboard/vendors")
  revalidatePath("/vendor/plans")
  return { ok: true, plan: data as VendorPlan }
}

/**
 * Permanently delete a package — allowed ONLY while no vendor is enrolled in it.
 *
 * The composite FK is ON DELETE RESTRICT, so an enrolled package would fail with
 * a raw 23503 from Postgres. The count is checked first so the brokerage is told
 * the actual reason and the number, and pointed at archiving instead.
 */
export async function deleteVendorPlanAction(params: { planId: string }): Promise<
  { ok: true; deletedId: string } | { ok: false; error: string }
> {
  const actor = await actingSeller("write")
  if (!actor.ok) return { ok: false, error: actor.error }
  if (!params?.planId) return { ok: false, error: "A package id is required." }

  const { count, error: countError } = await actor.db
    .from("vendor_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("plan_id", params.planId)
    .eq("brokerage_id", actor.brokerageId)
  if (countError) {
    return { ok: false, error: `Could not check package enrolments: ${countError.message}` }
  }
  if ((count ?? 0) > 0) {
    return {
      ok: false,
      error:
        `${count} vendor${count === 1 ? " is" : "s are"} enrolled in this package and being charged ` +
        `for it, so it cannot be deleted. Archive it instead — that closes it to new enrolments and ` +
        `keeps the existing ones valid.`,
    }
  }

  const { data, error } = await actor.db
    .from("vendor_plans")
    .delete()
    .eq("id", params.planId)
    .eq("brokerage_id", actor.brokerageId)
    .select("id")
    .maybeSingle()

  if (error) return { ok: false, error: `Could not delete the package: ${error.message}` }
  if (!data) return { ok: false, error: "That package was not found on your catalogue." }
  revalidatePath("/dashboard/vendors")
  revalidatePath("/vendor/plans")
  return { ok: true, deletedId: data.id as string }
}
