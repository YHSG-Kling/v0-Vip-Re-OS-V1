"use server"

/**
 * app/actions/vendors/vendor-plan-subscriptions.ts
 *
 * VENDOR PACKAGE ENROLMENTS — `public.vendor_subscriptions`.
 *
 * ══ THE DIRECTION THIS FILE SHIPPED WITH WAS BACKWARDS ══
 *
 * It was written as A BROKERAGE SUBSCRIBING TO A VENDOR'S PLAN — money
 * brokerage → vendor, monthly. The owner ruling, verbatim:
 *
 *   "vendor packages are for brokerages to charge the vendor on a subscription
 *    to the platform. vendors do bill the brokerages for jobs but not a monthly
 *    subscription."
 *
 * There is no monthly brokerage → vendor path. What exists is:
 *
 *   · VENDOR PACKAGE   vendor → brokerage, RECURRING  ← this file
 *   · VENDOR JOB BILL  brokerage → vendor, PER JOB    ← vendor_invoices,
 *                                                        billed_to='brokerage'
 *
 * A row here is therefore ONE VENDOR'S ENROLMENT in ONE BROKERAGE PACKAGE:
 * `brokerage_id` is the party that CHARGES, `vendor_id` is the party that PAYS.
 * m497 pins that with a single-valued `billing_direction` CHECK and a composite
 * FK to `vendor_plans(id, brokerage_id)`, so a cross-tenant or inverted row is
 * unrepresentable rather than merely discouraged.
 *
 * ══ WHY THE PARTIES DID NOT MOVE, AND ONE ID SPACE DID ══
 *
 * The table already carried both parties; only which one pays changed. The live
 * write RLS — `has_brokerage_access(brokerage_id) AND is_brokerage_finance_admin()`,
 * with the vendor granted SELECT only — was already the corrected direction: the
 * seller issues, the payer reads. Nothing about it needed to change.
 *
 * What DID move is `vendor_id`. It pointed at `vendor_marketplace_profiles(id)`,
 * the PLATFORM-tier id space. Every other brokerage↔vendor money artefact —
 * `vendor_invoices`, issueVendorCharge, premium placement, W-9s, bookings, and
 * the vendor portal's own linkage (user_role_assignments.vendor_id) — runs on
 * `vendors(id)`. With the payer in the other space, a vendor's recurring package
 * fee and its per-job invoices would sit on two different identities with no
 * join between them (m440: the spaces are disjoint). m497 repoints the FK.
 *
 * ══ THIS IS AN ENTITLEMENT RECORD, NOT A CHARGE ══
 *
 * Nothing here takes money. The two stripe_* columns are nullable and stay NULL
 * on this path — it is NOT a Stripe subscription, and the UI says so rather than
 * implying a charge was made. The collectable amount is raised through
 * `vendor_invoices` with billed_to='vendor', the ONE tenant→vendor ledger
 * (app/actions/vendor-payments.ts :: issueVendorCharge,
 * lib/vendors/premium-placement.ts). This table records the arrangement the
 * invoice is FOR.
 *
 * ══ TENANT SCOPING ══
 *
 * The charging brokerage comes from `resolveWriteContext()`, never from the
 * caller, and every read and write pins `.eq("brokerage_id", ctx.brokerageId)`.
 * The vendor being enrolled is verified to belong to that brokerage first, so a
 * brokerage can never bill a vendor it has no relationship with.
 *
 * Every export is an async Server Action (a public HTTP endpoint).
 */

import { revalidatePath } from "next/cache"
import { resolveWriteContext } from "@/lib/platform/acting-context"
import { createClient } from "@/lib/supabase/server"
import { readRoleGrants, selectVendorGrant } from "@/lib/auth/role-grants"
import {
  VENDOR_PACKAGE,
  VENDOR_PACKAGE_BILLING_DIRECTION,
  describeDirection,
} from "@/lib/vendors/vendor-money-directions"

/* ─────────────────────────────────────────────────────────────────────────────
 * TOMBSTONE — THREE EXPORTS WERE RENAMED, NOT REMOVED.
 *
 * The orphan-export census reports these three as CAPABILITY REMOVED, and it is
 * right to: its move-detection needs a NEW HOME in a DIFFERENT file, because a
 * pre-existing same-named function in an unrelated module is a coincidence and
 * not a destination. A rename WITHIN one file looks identical to a deletion from
 * the outside. So the survivors are named here, by line:
 *
 *   listVendorPlanCatalogueAction     → listVendorPackageEnrolmentsAction   :161
 *   subscribeToVendorPlanAction       → enrolVendorInPackageAction          :231
 *   cancelVendorPlanSubscriptionAction→ endVendorPackageEnrolmentAction     :342
 *
 * Every one is the SAME capability with a corrected name. "Subscribe to a vendor
 * plan" describes a BROKERAGE paying a VENDOR monthly — the direction m497
 * proved backwards. A function named for the wrong direction is exactly how the
 * wrong direction survives a review: the reader trusts the name and never opens
 * the body. Renaming is therefore part of the fix, not cosmetics.
 *
 * `listMyVendorPackageChargesAction` :379 is NEW in the same pass — the payer's
 * read-only view, which had no equivalent before because under the inverted
 * model the vendor was the one being paid.
 * ────────────────────────────────────────────────────────────────────────── */

/** One package this brokerage sells, with the vendors currently enrolled in it. */
export interface VendorPackageEnrolmentRow {
  subscription_id: string
  vendor_id: string
  vendor_name: string | null
  plan_id: string
  plan_name: string
  status: string
  current_period_start: string
  current_period_end: string
  credits_used_this_period: number
  /** What the VENDOR pays the brokerage each period. */
  price_per_month: number
  billing_cycle: string
}

/** A vendor on this brokerage's bench who could be enrolled. */
export interface EnrollableVendor {
  vendor_id: string
  name: string
  category: string | null
}

export type VendorPackageEnrolmentListResult =
  | {
      ok: true
      enrolments: VendorPackageEnrolmentRow[]
      enrollableVendors: EnrollableVendor[]
      /** "vendor pays brokerage, every billing period" — rendered, never re-typed in the UI. */
      direction: string
    }
  | { ok: false; error: string }

/** What a VENDOR sees: the packages it is being charged for, and by whom. */
export interface VendorPackageChargeRow {
  subscription_id: string
  brokerage_id: string
  plan_name: string
  status: string
  current_period_start: string
  current_period_end: string
  credits_used_this_period: number
  max_credits_per_month: number | null
  price_per_month: number
  price_per_credit: number | null
  billing_cycle: string
}

export type VendorPackageChargeListResult =
  | { ok: true; charges: VendorPackageChargeRow[]; direction: string }
  | { ok: false; error: string }

export type VendorEnrolmentResult =
  | { ok: true; subscriptionId: string; status: string }
  | { ok: false; error: string }

/** Period length per billing cycle, in days. Matches the two values the live CHECK allows. */
const PERIOD_DAYS: Record<string, number> = { monthly: 30, annual: 365 }

/**
 * THE SELLER'S VIEW — every vendor this brokerage has enrolled in one of its
 * packages, plus the bench vendors still available to enrol.
 */
export async function listVendorPackageEnrolmentsAction(): Promise<VendorPackageEnrolmentListResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { ok: false, error: ctx.error }
  if (!ctx.brokerageId) return { ok: false, error: "Your account is not attached to a brokerage yet." }

  const { data: subs, error: subsError } = await ctx.db
    .from("vendor_subscriptions")
    .select(
      "id, vendor_id, plan_id, status, current_period_start, current_period_end, credits_used_this_period",
    )
    .eq("brokerage_id", ctx.brokerageId)
  if (subsError) return { ok: false, error: `Could not load package enrolments: ${subsError.message}` }

  const subRows = (subs ?? []) as Array<Record<string, any>>

  const { data: plans, error: plansError } = await ctx.db
    .from("vendor_plans")
    .select("id, name, price_per_month, billing_cycle")
    .eq("brokerage_id", ctx.brokerageId)
  if (plansError) return { ok: false, error: `Could not load your vendor packages: ${plansError.message}` }
  const planById = new Map<string, any>(((plans ?? []) as Array<Record<string, any>>).map((p) => [p.id, p]))

  // The brokerage's own bench. `vendors.brokerage_id` is nullable — a NULL row is
  // a GLOBAL vendor visible to every tenant, and one tenant may not put a global
  // row on its books, so the equality filter deliberately excludes them (the same
  // line lib/vendors/premium-placement.ts draws for placement).
  const { data: bench, error: benchError } = await ctx.db
    .from("vendors")
    .select("id, name, category")
    .eq("brokerage_id", ctx.brokerageId)
    .order("name", { ascending: true })
  if (benchError) return { ok: false, error: `Could not load your vendors: ${benchError.message}` }
  const benchRows = (bench ?? []) as Array<Record<string, any>>
  const vendorNames = new Map<string, string>(benchRows.map((v) => [v.id, v.name]))

  const enrolledActive = new Set(
    subRows.filter((s) => s.status === "active").map((s) => s.vendor_id as string),
  )

  return {
    ok: true,
    direction: describeDirection(VENDOR_PACKAGE),
    enrolments: subRows.map((s) => ({
      subscription_id: s.id,
      vendor_id: s.vendor_id,
      vendor_name: vendorNames.get(s.vendor_id) ?? null,
      plan_id: s.plan_id,
      plan_name: planById.get(s.plan_id)?.name ?? "Unknown package",
      status: s.status,
      current_period_start: s.current_period_start,
      current_period_end: s.current_period_end,
      credits_used_this_period: s.credits_used_this_period ?? 0,
      price_per_month: Number(planById.get(s.plan_id)?.price_per_month ?? 0),
      billing_cycle: planById.get(s.plan_id)?.billing_cycle ?? "monthly",
    })),
    enrollableVendors: benchRows
      .filter((v) => !enrolledActive.has(v.id))
      .map((v) => ({ vendor_id: v.id, name: v.name, category: v.category ?? null })),
  }
}

/**
 * Enrol one of this brokerage's vendors in one of this brokerage's packages —
 * the brokerage starts charging that vendor.
 *
 * The package is re-read server-side (never trusted from the client) to confirm
 * it belongs to the acting brokerage and is still active, then the period is
 * derived from the package's own billing_cycle plus any trial. Nothing is
 * charged here — see the module header.
 */
export async function enrolVendorInPackageAction(params: {
  vendorId: string
  planId: string
}): Promise<VendorEnrolmentResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { ok: false, error: ctx.error }
  if (!ctx.brokerageId) return { ok: false, error: "Your account is not attached to a brokerage yet." }
  if (!params?.planId) return { ok: false, error: "A package id is required." }
  if (!params?.vendorId) return { ok: false, error: "A vendor is required." }

  // THE PACKAGE MUST BE OURS. Pinned on the read, so another tenant's package id
  // simply does not resolve — it is never "found then rejected".
  const { data: plan, error: planError } = await ctx.db
    .from("vendor_plans")
    .select("id, status, billing_cycle, trial_days")
    .eq("id", params.planId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()
  if (planError) return { ok: false, error: `Could not read that package: ${planError.message}` }
  if (!plan) return { ok: false, error: "That package was not found on your catalogue." }
  if (plan.status !== "active") {
    return { ok: false, error: "That package is archived and closed to new enrolments — restore it first." }
  }

  // THE VENDOR MUST BE OURS. A global vendor (brokerage_id IS NULL) is visible to
  // every tenant and belongs to none, so it cannot be put on one tenant's books.
  const { data: vendor, error: vendorError } = await ctx.db
    .from("vendors")
    .select("id, name")
    .eq("id", params.vendorId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()
  if (vendorError) return { ok: false, error: `Could not read that vendor: ${vendorError.message}` }
  if (!vendor) {
    return { ok: false, error: "That vendor is not on your brokerage's bench, so you cannot charge it." }
  }

  // The live UNIQUE (brokerage_id, vendor_id, plan_id) — checked by name so a
  // repeat enrolment is a sentence, not a 23505. A CANCELED row is reactivated
  // rather than duplicated, because the unique index does not care about status.
  const { data: existing, error: existingError } = await ctx.db
    .from("vendor_subscriptions")
    .select("id, status")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("vendor_id", vendor.id)
    .eq("plan_id", plan.id)
    .maybeSingle()
  if (existingError) {
    return { ok: false, error: `Could not check the existing enrolment: ${existingError.message}` }
  }

  const start = new Date()
  const days = (PERIOD_DAYS[plan.billing_cycle] ?? 30) + (plan.trial_days ?? 0)
  const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000)

  if (existing) {
    if (existing.status === "active") {
      return { ok: false, error: "That vendor is already enrolled in this package." }
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
    if (reviveError) return { ok: false, error: `Could not resume the enrolment: ${reviveError.message}` }
    if (!revived) return { ok: false, error: "That enrolment was not found on your brokerage." }
    revalidatePath("/dashboard/vendors")
    revalidatePath("/vendor/plans")
    return { ok: true, subscriptionId: revived.id as string, status: revived.status as string }
  }

  const { data: created, error: createError } = await ctx.db
    .from("vendor_subscriptions")
    .insert({
      brokerage_id: ctx.brokerageId,
      vendor_id: vendor.id,
      plan_id: plan.id,
      // Written explicitly, from the one shared constant, even though the column
      // defaults to it: the direction is the fact this whole lane exists to state,
      // and a default is something a future writer can forget it relied on.
      billing_direction: VENDOR_PACKAGE_BILLING_DIRECTION,
      status: "active",
      current_period_start: start.toISOString(),
      current_period_end: end.toISOString(),
      credits_used_this_period: 0,
    })
    .select("id, status")
    .single()
  if (createError) return { ok: false, error: `Could not enrol that vendor: ${createError.message}` }
  revalidatePath("/dashboard/vendors")
  revalidatePath("/vendor/plans")
  return { ok: true, subscriptionId: created.id as string, status: created.status as string }
}

/**
 * End a vendor's enrolment — the brokerage stops charging it.
 *
 * The ROW IS KEPT with status 'canceled' and a canceled_at stamp, never deleted:
 * it is the record of a period that was used, and `credits_used_this_period` on
 * it is the basis of anything still invoiced to the vendor for that period.
 * Deleting it would erase the reason for a charge already raised.
 */
export async function endVendorPackageEnrolmentAction(params: {
  subscriptionId: string
}): Promise<VendorEnrolmentResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { ok: false, error: ctx.error }
  if (!ctx.brokerageId) return { ok: false, error: "Your account is not attached to a brokerage yet." }
  if (!params?.subscriptionId) return { ok: false, error: "An enrolment id is required." }

  const { data, error } = await ctx.db
    .from("vendor_subscriptions")
    .update({ status: "canceled", canceled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", params.subscriptionId)
    .eq("brokerage_id", ctx.brokerageId)
    .select("id, status")
    .maybeSingle()

  if (error) return { ok: false, error: `Could not end that enrolment: ${error.message}` }
  if (!data) return { ok: false, error: "That enrolment was not found on your brokerage." }
  revalidatePath("/dashboard/vendors")
  revalidatePath("/vendor/plans")
  return { ok: true, subscriptionId: data.id as string, status: data.status as string }
}

/**
 * THE PAYER'S VIEW — read only, on purpose.
 *
 * A vendor may see what it is being charged and by which brokerage; it may not
 * author or end its own enrolment, because the payer does not write its own
 * bill. That is the line the live write RLS already draws
 * (vendor_subscriptions_tenant_insert/update/delete are brokerage-finance-admin
 * only) and this action does not pretend otherwise.
 *
 * Resolved through the CANONICAL vendor portal linkage —
 * user_role_assignments.vendor_id → vendors.id — the same one /vendor/invoices
 * and /vendor/dashboard use. Not vendor_marketplace_profiles, which is the
 * platform-tier identity (a different, disjoint id space; m440).
 */
export async function listMyVendorPackageChargesAction(): Promise<VendorPackageChargeListResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "You are not signed in." }

  const grantsResult = await readRoleGrants(supabase, user.id)
  if (!grantsResult.ok) {
    return { ok: false, error: "We could not verify your vendor account just now — please refresh." }
  }
  const { grant, ambiguous } = selectVendorGrant(grantsResult.grants)
  if (ambiguous) {
    return { ok: false, error: "Your account is linked to more than one vendor — ask the brokerage to correct it." }
  }
  if (!grant?.vendor_id) return { ok: false, error: "No vendor profile found for your account." }

  const { data, error } = await supabase
    .from("vendor_subscriptions")
    .select(
      "id, brokerage_id, plan_id, status, current_period_start, current_period_end, credits_used_this_period",
    )
    .eq("vendor_id", grant.vendor_id)
    .order("current_period_end", { ascending: false })
  if (error) return { ok: false, error: `Could not load your package charges: ${error.message}` }

  const rows = (data ?? []) as Array<Record<string, any>>
  const direction = describeDirection(VENDOR_PACKAGE)
  if (rows.length === 0) return { ok: true, charges: [], direction }

  // The package rows are readable to a vendor through m497's shopper-browse
  // policy. A refused read here would render every charge with no price at all,
  // which reads as "free" — so it is reported, not defaulted.
  const { data: plans, error: plansError } = await supabase
    .from("vendor_plans")
    .select("id, name, price_per_month, price_per_credit, max_credits_per_month, billing_cycle")
    .in("id", [...new Set(rows.map((r) => r.plan_id))])
  if (plansError) return { ok: false, error: `Could not load package pricing: ${plansError.message}` }
  const planById = new Map<string, any>(((plans ?? []) as Array<Record<string, any>>).map((p) => [p.id, p]))

  return {
    ok: true,
    direction,
    charges: rows.map((r) => {
      const p = planById.get(r.plan_id)
      return {
        subscription_id: r.id,
        brokerage_id: r.brokerage_id,
        plan_name: p?.name ?? "Package",
        status: r.status,
        current_period_start: r.current_period_start,
        current_period_end: r.current_period_end,
        credits_used_this_period: r.credits_used_this_period ?? 0,
        max_credits_per_month: p?.max_credits_per_month ?? null,
        price_per_month: Number(p?.price_per_month ?? 0),
        price_per_credit: p?.price_per_credit === null || p?.price_per_credit === undefined ? null : Number(p.price_per_credit),
        billing_cycle: p?.billing_cycle ?? "monthly",
      }
    }),
  }
}
