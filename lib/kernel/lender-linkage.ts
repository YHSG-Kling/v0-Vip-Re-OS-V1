// lib/kernel/lender-linkage.ts
// ─────────────────────────────────────────────────────────────────────────────
// LENDERS ARE VENDORS. A lender in a transaction is a vendor (vendors.category
// 'Lender') assigned to the deal through the vendor rail (vendor_assignments) —
// NOT a separate user_type/portal identity. This is the single source of truth
// for resolving "which lender vendor is on this transaction" and for linking one.
//
// Why this replaced the old lender_portal_users identity rail: that table was a
// per-(user, transaction) grant that never ran (0 rows live) and duplicated the
// vendor identity/provisioning/assignment path. The vendor system already:
//   • models a lender as a settlement-service category (lib/compliance/vendor-respa
//     treats 'Lender' as RESPA-regulated — so a lender-vendor INHERITS the AfBA /
//     kickback / disclosure gates the standalone lender portal never had),
//   • provisions via vendor-invite (invite → accept → user_role_assignments.vendor_id),
//   • assigns to a transaction via vendor_assignments.
// The lender's financing SPECIFICS (rate, underwriting_status, clear_to_close_date,
// appraisal, rate-lock, conditions) live on transaction_lenders — the alive
// capability layer, keyed by transaction_id and preserved untouched.

import { VENDOR_CATEGORY_LENDER } from "@/lib/kernel/vendor-categories"

/** The vendor category that IS a lender. vendors.category carries a live CHECK
 *  (Contractor|Inspector|Lender|Other|Stager|Title Company) — it is NOT free text,
 *  whatever this comment used to say. One spelling, from one module. */
export const LENDER_VENDOR_CATEGORY = VENDOR_CATEGORY_LENDER

export function isLenderVendorCategory(category: string | null | undefined): boolean {
  const c = (category ?? "").trim().toLowerCase()
  // The exact arm compares against THE category constant, not a second spelling
  // of it (§6; lane 80E — LENDER_VENDOR_CATEGORY was exported for the
  // vendor-category proof and read by nothing at runtime).
  return c === LENDER_VENDOR_CATEGORY.toLowerCase() || c.includes("lender") || c.includes("mortgage") || c.includes("loan officer")
}

/**
 * The lender bench, spelled for a POSTGRES filter.
 *
 * `isLenderVendorCategory` is a substring predicate — correct in memory, useless
 * in a query: PostgREST `.in()` is exact and case-sensitive, and a filter that
 * cannot match is a permission (or a picker) that silently never fires
 * (scripts/role-vocabulary-guard.ts). These are the vendors.category CHECK values
 * that ARE a lender, both of which `isLenderVendorCategory` accepts — the two
 * must agree, and the vendor-category guard proves both against the live CHECK.
 *
 * Use this wherever the QUESTION is "which vendors are the brokerage's lenders";
 * use isLenderVendorCategory when you already hold the row.
 */
export const LENDER_BENCH_CATEGORIES = ["lender", "refinance_lender"] as const

/** A safe .in() list — never empty (an empty PostgREST .in() can error), so
 *  callers pass this sentinel for "no rows". */
const NO_MATCH = "00000000-0000-0000-0000-000000000000"
export function lenderFilterIds(ids: string[]): string[] {
  return ids.length > 0 ? ids : [NO_MATCH]
}

export interface LenderVendorRef {
  vendorId: string
  name: string | null
  brokerageId: string
}

/** The Lender vendor assigned to a transaction (via vendor_assignments), if any. */
export async function resolveLenderVendorForTransaction(
  client: any,
  transactionId: string,
): Promise<LenderVendorRef | null> {
  const { data: assigns } = await client
    .from("vendor_assignments")
    .select("vendor_id, brokerage_id, vendors!inner(id, name, category, brokerage_id)")
    .eq("transaction_id", transactionId)
  for (const a of (assigns ?? []) as any[]) {
    const v = a.vendors
    if (v && isLenderVendorCategory(v.category)) {
      return { vendorId: v.id, name: v.name ?? null, brokerageId: v.brokerage_id ?? a.brokerage_id }
    }
  }
  return null
}

/** A vendor SEAT, resolved from the user who holds it. Every vendor category
 *  — not only the lender — rides this shape; `LenderVendorRef` is the same
 *  three fields and stays as the lender-specific name its callers use. */
export interface VendorSeatRef extends LenderVendorRef {
  category: string | null
}

/**
 * THE ONE user → vendors resolver (lane 77C, blind spot (2): "vendor↔contact
 * link by email/phone with no FK").
 *
 * A vendor is a USER TYPE (owner, wave 77: "vendors are not contact type, they
 * are user type"), and the seat is `users.user_type='vendor'`. The `vendors`
 * table carries NO user_id column — its columns (scripts/schema-snapshot.ts,
 * 2026-09-20) are access_expires_at, access_level, ai_verification_score,
 * audience_tags, brokerage_id, category, compliance_credentials, created_at,
 * display_priority, email, estimated_turnaround_days, id, invited_by_team_id,
 * invited_by_user_id, name, notes, phone, platform_vendor_id, preferred,
 * rating, stage_tags, status, team_id, updated_at, verification_flags,
 * verified_at, verified_by, visible_in_portal, website — and
 * `invited_by_user_id` is the INVITER, never the vendor's own seat. The ONE
 * FK-backed link between a user and the vendor company it works for is
 * user_role_assignments.vendor_id (user_id, vendor_id both live on that row:
 * scripts/schema-fk-map.ts), written by app/actions/vendor-invite.ts when the
 * invitation is accepted. So the honest resolution of "which vendor is this
 * signed-in user" is that join — never a contacts row's email/phone digits,
 * which is how a CUSTOMER-surface tool has to guess when a vendor calls the
 * office line as a stranger and lands in `contacts` (the lane-76A tool in
 * lib/ai-isa/capability-catalogue.ts; lane 77A is moving it to the vendor
 * user-type surface, where it can call this instead of matching digits).
 *
 * Returns EVERY vendor seat the user holds, in row order — a user can be
 * linked to more than one vendor row (one per brokerage that invited them).
 * The read's error is READ (§3): a refused read returns [] AND is logged, so
 * a caller that gates on "has a seat" fails closed rather than seeing an
 * empty list it cannot tell from "no seat".
 */
export async function vendorSeatsForUser(client: any, userId: string): Promise<VendorSeatRef[]> {
  if (!userId) return []
  const { data: roleRows, error } = await client
    .from("user_role_assignments")
    .select("vendor_id, vendors!inner(id, name, category, brokerage_id)")
    .eq("user_id", userId)
    .not("vendor_id", "is", null)
  if (error) {
    console.error(`[lender-linkage] vendor seat read refused for user ${userId}: ${error.message}`)
    return []
  }
  const out: VendorSeatRef[] = []
  for (const r of (roleRows ?? []) as any[]) {
    const v = r.vendors
    if (!v?.id) continue
    out.push({ vendorId: v.id, name: v.name ?? null, brokerageId: v.brokerage_id, category: v.category ?? null })
  }
  return out
}

/** The caller's LENDER vendor identity (user_role_assignments.vendor_id → a
 *  Lender-category vendor), if the user is a lender vendor. A FILTER over
 *  vendorSeatsForUser — the same join, never a second query (§6). */
export async function lenderVendorForUser(
  client: any,
  userId: string,
): Promise<LenderVendorRef | null> {
  for (const seat of await vendorSeatsForUser(client, userId)) {
    if (isLenderVendorCategory(seat.category)) {
      return { vendorId: seat.vendorId, name: seat.name, brokerageId: seat.brokerageId }
    }
  }
  return null
}

/**
 * The USER ids attached to a lender vendor — the reverse of lenderVendorForUser.
 *
 * A vendor is a COMPANY; anything addressed to a person (a notification, an
 * inbox row) needs `users.id`, and `notifications.user_id` FKs `users` — handing
 * it a `vendors.id` is a 23503, which loses the whole INSERT (CLAUDE.md §3).
 * user_role_assignments is the one link between the two, so this is where the
 * hop lives instead of being re-derived at each caller.
 *
 * Returns [] both when the vendor has no linked user AND when the read is
 * refused; the caller decides whether "nobody to notify" is acceptable — for a
 * best-effort notification it is, for a gate it never is (use the gates in
 * lib/kernel/portal-auth.ts for that).
 */
export async function lenderVendorUserIds(client: any, vendorId: string): Promise<string[]> {
  if (!vendorId) return []
  const { data, error } = await client
    .from("user_role_assignments")
    .select("user_id")
    .eq("vendor_id", vendorId)
  if (error) return []
  return ((data ?? []) as Array<{ user_id: string | null }>)
    .map((r) => r.user_id)
    .filter((x): x is string => !!x)
}

/** All transaction ids a given lender vendor is assigned to (dashboard/brief scoping). */
export async function lenderVendorTransactionIds(
  client: any,
  vendorId: string,
  brokerageId?: string | null,
): Promise<string[]> {
  let q = client.from("vendor_assignments").select("transaction_id").eq("vendor_id", vendorId)
  if (brokerageId) q = q.eq("brokerage_id", brokerageId)
  const { data } = await q
  return ((data ?? []) as Array<{ transaction_id: string | null }>)
    .map((r) => r.transaction_id).filter((x): x is string => !!x)
}

export interface LinkLenderVendorResult {
  ok: boolean
  error?: string
  assignmentId?: string
}

/**
 * Idempotently assign a Lender vendor to a transaction and ensure a
 * transaction_lenders financing row exists. Constraint-safe (check-then-insert,
 * no ON CONFLICT dependency). This is the vendor-rail replacement for the old
 * assignLenderToTransaction/lender_portal_users write.
 */
export async function linkLenderVendorToTransaction(
  svc: any,
  params: { vendorId: string; transactionId: string; brokerageId: string; lenderName?: string | null },
): Promise<LinkLenderVendorResult> {
  const { vendorId, transactionId, brokerageId } = params
  if (!vendorId || !transactionId || !brokerageId) {
    return { ok: false, error: "vendorId, transactionId and brokerageId are all required" }
  }

  // 1) vendor_assignments (assignment_type 'lender') — one per (vendor, transaction).
  const { data: existing } = await svc
    .from("vendor_assignments")
    .select("id")
    .eq("vendor_id", vendorId)
    .eq("transaction_id", transactionId)
    .maybeSingle()

  let assignmentId: string
  if (existing?.id) {
    assignmentId = existing.id as string
    await svc.from("vendor_assignments")
      .update({ assignment_type: "lender", status: "confirmed", brokerage_id: brokerageId })
      .eq("id", assignmentId)
  } else {
    const { data: inserted, error } = await svc
      .from("vendor_assignments")
      .insert({
        vendor_id: vendorId, transaction_id: transactionId, brokerage_id: brokerageId,
        assignment_type: "lender", status: "confirmed",
      })
      .select("id")
      .maybeSingle()
    if (error || !inserted?.id) return { ok: false, error: error?.message ?? "Failed to assign lender vendor" }
    assignmentId = inserted.id as string
  }

  // 2) Ensure a transaction_lenders financing row (the capability layer).
  const { data: tl } = await svc
    .from("transaction_lenders")
    .select("id")
    .eq("transaction_id", transactionId)
    .maybeSingle()
  if (!tl?.id) {
    await svc.from("transaction_lenders").insert({
      transaction_id: transactionId, brokerage_id: brokerageId,
      lender_name: params.lenderName ?? null,
    })
  } else if (params.lenderName) {
    await svc.from("transaction_lenders").update({ lender_name: params.lenderName }).eq("id", tl.id)
  }

  return { ok: true, assignmentId }
}
