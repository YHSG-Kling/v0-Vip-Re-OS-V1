/**
 * Portal Auth — kernel-level helper that closes the authorization-bypass
 * vulnerability across all portal mutator actions.
 *
 * Before this:
 *   Each lender / title / vendor action took the caller's claimed portal id
 *   (lenderId / titleUserId / vendorId) as input and trusted it. An
 *   authenticated user with any portal role could pass a different
 *   portal-user id and act on their behalf.
 *
 * After:
 *   Every mutator must call requireLenderActor / requireTitleActor /
 *   requireVendorActor at the top. Each helper verifies:
 *     1. supabase.auth.getUser() returns an authenticated user
 *     2. The portal-users row that maps to that user.id MATCHES the
 *        claimed id passed in
 *     3. Returns the canonical {userId, actorId, brokerageId} that the
 *        action then uses for all writes + fan-out
 *
 *   Mismatch / missing row → throws PortalAuthError which callers translate
 *   to { success: false, error } at the action boundary.
 */

import { createClient } from "@/lib/supabase/server"

export class PortalAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PortalAuthError"
  }
}

export interface LenderActorContext {
  userId:        string  // auth.users.id
  vendorId:      string  // vendors.id — a lender IS a vendor (category 'Lender')
  brokerageId:   string
  lenderCompany: string | null  // vendors.name
}

export interface TitleActorContext {
  userId:      string
  titleUserId: string  // title_company_users.id
  brokerageId: string  // resolved via user.brokerage_id (title_company_users has no brokerage_id column)
  email:       string | null
}

export interface VendorActorContext {
  userId:      string
  vendorId:    string  // vendors.id (via user_role_assignments)
  brokerageId: string
}

/**
 * Lender authorization gate — LENDERS ARE VENDORS.
 * Verifies the authenticated user is a vendor (user_role_assignments.vendor_id)
 * whose vendor is a LENDER category AND is assigned to THIS transaction
 * (vendor_assignments). Replaces the retired lender_portal_users identity rail.
 * Passing the transactionId folds "is this my deal?" into the gate itself, so no
 * caller-supplied lender id can be spoofed.
 */
export async function requireLenderVendorActor(transactionId: string): Promise<LenderActorContext> {
  if (!transactionId) throw new PortalAuthError("transactionId required")

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new PortalAuthError("Not authenticated")

  // The caller's vendor identity (a lender is a vendor).
  const { data: roleRows } = await supabase
    .from("user_role_assignments")
    .select("vendor_id, brokerage_id, vendors!inner(id, name, category, brokerage_id)")
    .eq("user_id", user.id)
    .not("vendor_id", "is", null)

  const { isLenderVendorCategory } = await import("@/lib/kernel/lender-linkage")
  const lenderVendor = ((roleRows ?? []) as any[])
    .map((r) => r.vendors)
    .find((v) => v && isLenderVendorCategory(v.category))
  if (!lenderVendor) {
    throw new PortalAuthError("Not authorized — your account is not a lender vendor")
  }
  const brokerageId = lenderVendor.brokerage_id
  if (!brokerageId) throw new PortalAuthError("Lender vendor is missing a brokerage scope")

  // Must be assigned to THIS transaction.
  const { data: assigned } = await supabase
    .from("vendor_assignments")
    .select("id")
    .eq("vendor_id", lenderVendor.id)
    .eq("transaction_id", transactionId)
    .maybeSingle()
  if (!assigned) {
    throw new PortalAuthError("Unauthorized: lender not assigned to this transaction")
  }

  return {
    userId:        user.id,
    vendorId:      lenderVendor.id,
    brokerageId,
    lenderCompany: lenderVendor.name ?? null,
  }
}

/**
 * Title portal authorization gate.
 * Verifies the authenticated user owns the title_company_users row that
 * matches the claimed titleUserId. Returns the brokerage_id resolved via
 * the user's users.brokerage_id (the title_company_users table does not
 * carry a brokerage_id of its own per live schema).
 */
export async function requireTitleActor(claimedTitleUserId: string): Promise<TitleActorContext> {
  if (!claimedTitleUserId) throw new PortalAuthError("titleUserId required")

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new PortalAuthError("Not authenticated")

  const { data: row } = await supabase
    .from("title_company_users")
    .select("id, user_id, email")
    .eq("user_id", user.id)
    .eq("id", claimedTitleUserId)
    .maybeSingle()

  if (!row) {
    throw new PortalAuthError(
      "Not authorized for this title profile — your account does not match the claimed title user",
    )
  }

  // Resolve brokerage via users.brokerage_id
  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!userRow?.brokerage_id) {
    throw new PortalAuthError("User has no brokerage association")
  }

  return {
    userId:      user.id,
    titleUserId: row.id,
    brokerageId: userRow.brokerage_id,
    email:       row.email ?? null,
  }
}

/**
 * Vendor portal authorization gate.
 * Vendor users link to vendors.id via user_role_assignments.vendor_id.
 * Verifies the authenticated user has a role row pointing at the claimed
 * vendorId.
 */
export async function requireVendorActor(claimedVendorId: string): Promise<VendorActorContext> {
  if (!claimedVendorId) throw new PortalAuthError("vendorId required")

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new PortalAuthError("Not authenticated")

  const { data: row } = await supabase
    .from("user_role_assignments")
    .select("user_id, vendor_id, brokerage_id, role")
    .eq("user_id", user.id)
    .eq("vendor_id", claimedVendorId)
    .maybeSingle()

  if (!row) {
    throw new PortalAuthError(
      "Not authorized for this vendor — your account does not have a vendor role for this vendor",
    )
  }

  if (!row.brokerage_id) {
    throw new PortalAuthError("Vendor role is missing a brokerage scope")
  }

  return {
    userId:      user.id,
    vendorId:    claimedVendorId,
    brokerageId: row.brokerage_id,
  }
}

// ─── External-partner portal identity (the /api/external-portal rail) ────────
//
// WHY THIS EXISTS SEPARATELY FROM THE THREE GATES ABOVE.
// requireTitleActor / requireVendorActor / requireLenderVendorActor each take a
// CLAIMED id and verify the session owns it — the right shape for a server
// action whose caller already knows which portal profile it is acting as. The
// two `app/api/external-portal/*` routes had no claimed-id contract worth
// keeping: they read `partnerId` and `partnerType` from the request and used
// them as the authorization SUBJECT, and the ids their own callers send are in a
// different id space than the ids they compared against (the vendor and title
// dashboards pass `vendors.id`, while the download route compared that value to
// `title_company_users.user_id` and to `user_role_assignments.user_id`). A
// cross-check against a claimed id would therefore have refused every legitimate
// partner while proving nothing, so those routes take NO id from the caller at
// all: this resolver derives every class the session actually holds, and the
// route tries only the lanes the caller genuinely has.
//
// `partnerType` is derived for the same reason as `partnerId`. It selected the
// branch, so a caller who is a vendor could take the `title` branch by asking
// for it; a class the caller does not hold now simply has no lane to try.

export type ExternalPartnerType = "vendor" | "lender" | "title"

export interface ExternalPartnerIdentity {
  /** auth.users.id — the ONLY identity that arrives with the session. */
  userId: string
  /** users.brokerage_id — the caller's own tenant (NOT the document's). */
  brokerageId: string | null
  /** The caller owns at least one `title_company_users` row (the title rail). */
  isTitlePartner: boolean
  /** vendors.id via user_role_assignments.vendor_id, when the caller is one. */
  vendorId: string | null
  /** …and that vendor is Lender-category. LENDERS ARE VENDORS. */
  isLenderVendor: boolean
  /** Every class the CALLER holds. Derived from the session, never asked for. */
  partnerTypes: ExternalPartnerType[]
}

/**
 * Three refusals that must never be collapsed into one another:
 *   · `unauthenticated` — no session at all. The caller cannot be told apart
 *     from an anonymous stranger, and that is a 401, not "no such document".
 *   · `not_a_partner`   — a real session that holds no partner class.
 *   · `refused`         — a read was DENIED or errored. supabase-js RESOLVES a
 *     refused query, so `const { data }` alone turns an outage into a clean
 *     "this partner has no access" and hides it forever. Callers must fail
 *     closed on this AND say so; it is not an absence.
 */
export type ExternalPartnerResolution =
  | { ok: true;  identity: ExternalPartnerIdentity }
  | { ok: false; reason: "unauthenticated"; detail: string }
  | { ok: false; reason: "not_a_partner";   detail: string }
  | { ok: false; reason: "refused";         detail: string }

/**
 * The caller's external-partner identity, derived ENTIRELY from the session.
 *
 * Takes the request's supabase client so the route and the gate share one
 * session (and so a test can hand it a client), and returns a discriminated
 * result rather than throwing, because the route has to answer 401 and 404
 * differently and a thrown string cannot carry that.
 */
export async function resolveExternalPartnerIdentity(
  supabase: any,
): Promise<ExternalPartnerResolution> {
  const { data: authData, error: authError } = await supabase.auth.getUser()
  const user = authData?.user
  if (authError || !user) {
    return { ok: false, reason: "unauthenticated", detail: authError?.message ?? "no session" }
  }

  // TITLE — the identity rail is title_company_users.user_id, which is exactly
  // what requireTitleActor checks. `user_id = auth.uid()`, never a caller id.
  const { data: titleRows, error: titleError } = await supabase
    .from("title_company_users")
    .select("id")
    .eq("user_id", user.id)
    .limit(1)
  if (titleError) {
    return { ok: false, reason: "refused", detail: `title_company_users read refused: ${titleError.message}` }
  }

  // VENDOR / LENDER — user_role_assignments.vendor_id → vendors. Its RLS is
  // `user_id = auth.uid()` for the self lane, so this read is the caller's own
  // rows by construction; passing somebody else's id here (as the route used to)
  // is what a same-brokerage admin/broker could still satisfy.
  const { data: roleRows, error: roleError } = await supabase
    .from("user_role_assignments")
    .select("vendor_id, brokerage_id, vendors!inner(id, name, category, brokerage_id)")
    .eq("user_id", user.id)
    .not("vendor_id", "is", null)
  if (roleError) {
    return { ok: false, reason: "refused", detail: `user_role_assignments read refused: ${roleError.message}` }
  }

  const { data: userRow, error: userError } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (userError) {
    return { ok: false, reason: "refused", detail: `users read refused: ${userError.message}` }
  }

  const { isLenderVendorCategory } = await import("@/lib/kernel/lender-linkage")
  const vendors = ((roleRows ?? []) as any[]).map((r) => r.vendors).filter(Boolean)
  const lenderVendor = vendors.find((v) => isLenderVendorCategory(v.category)) ?? null
  const anyVendor = lenderVendor ?? vendors[0] ?? null

  const partnerTypes: ExternalPartnerType[] = []
  if ((titleRows ?? []).length > 0) partnerTypes.push("title")
  if (lenderVendor) partnerTypes.push("lender")
  else if (anyVendor) partnerTypes.push("vendor")

  if (partnerTypes.length === 0) {
    return {
      ok: false,
      reason: "not_a_partner",
      detail: "session holds no title_company_users row and no vendor role assignment",
    }
  }

  return {
    ok: true,
    identity: {
      userId:         user.id,
      brokerageId:    (userRow?.brokerage_id as string | null) ?? null,
      isTitlePartner: (titleRows ?? []).length > 0,
      vendorId:       (anyVendor?.id as string | null) ?? null,
      isLenderVendor: !!lenderVendor,
      partnerTypes,
    },
  }
}

export type ExternalPartnerLaneResult =
  | { ok: true;  grantedVia: ExternalPartnerType }
  | { ok: false; reason: "no_access" }
  | { ok: false; reason: "refused"; detail: string }

/**
 * Is THIS caller attached to THIS transaction, and through which lane?
 *
 * Only the lanes the caller actually holds are tried, and every one of them is
 * keyed on the caller's own identity — `title_company_users.user_id =
 * identity.userId`, `vendor_assignments.vendor_id = identity.vendorId`. Nothing
 * from the request reaches a predicate here.
 *
 * A plain (non-lender) vendor has NO lane: `documents.transaction_id` never
 * modelled vendor document access and the route it serves denied that class
 * before this repair. Giving it one would be a product decision, not a fix.
 *
 * Shared by both `app/api/external-portal/*` routes so "which lane grants" has
 * exactly one definition and the read route and the action route cannot drift
 * into disagreeing about it.
 */
export async function externalPartnerTransactionLane(
  supabase: any,
  identity: ExternalPartnerIdentity,
  transactionId: string,
): Promise<ExternalPartnerLaneResult> {
  if (!transactionId) return { ok: false, reason: "no_access" }

  if (identity.isTitlePartner) {
    const { data: titleAccess, error: titleError } = await supabase
      .from("title_company_users")
      .select("id")
      .eq("user_id", identity.userId)          // ← the session, not the request
      .eq("transaction_id", transactionId)
      .maybeSingle()
    if (titleError) {
      return { ok: false, reason: "refused", detail: `title_company_users membership read refused: ${titleError.message}` }
    }
    if (titleAccess) return { ok: true, grantedVia: "title" }
  }

  if (identity.isLenderVendor && identity.vendorId) {
    // Lenders are vendors — the caller's OWN lender vendor must be assigned here.
    const { data: assignment, error: assignmentError } = await supabase
      .from("vendor_assignments")
      .select("id")
      .eq("vendor_id", identity.vendorId)      // ← resolved from the session
      .eq("transaction_id", transactionId)
      .maybeSingle()
    if (assignmentError) {
      return { ok: false, reason: "refused", detail: `vendor_assignments read refused: ${assignmentError.message}` }
    }
    if (assignment) return { ok: true, grantedVia: "lender" }
  }

  return { ok: false, reason: "no_access" }
}

// ─── Manual Override gate ────────────────────────────────────────────────────

export interface OverrideContext {
  userId:      string
  brokerageId: string
  userType:    string  // canonical — users.user_type
  reason:      string
}

/**
 * Require an authenticated broker / admin / superadmin who supplies a
 * written reason. Used by all gated mutator actions that accept an
 * `overrideReason?: string` param (advance stage past blockers, send a
 * message past compliance, approve an item that failed signature check,
 * etc.).
 *
 * Returns the resolved actor context. Throws if:
 *   - not authenticated
 *   - user_type is not broker / admin / superadmin / compliance_officer
 *   - reason is shorter than 10 characters (audit trail integrity)
 */
const OVERRIDE_USER_TYPES = new Set([
  "broker", "broker_admin", "admin", "superadmin",
  "compliance_officer", "compliance_manager",
])

export async function requireOverrideActor(reason: string | null | undefined): Promise<OverrideContext> {
  if (!reason || reason.trim().length < 10) {
    throw new PortalAuthError("Override reason required (min 10 characters) for audit trail")
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new PortalAuthError("Not authenticated")

  const { data: userRow } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const userType = (userRow?.user_type ?? "").toLowerCase()
  if (!OVERRIDE_USER_TYPES.has(userType)) {
    throw new PortalAuthError(
      `User type '${userType || "unknown"}' is not authorized to override gates. Required: broker / admin / superadmin / compliance_officer`,
    )
  }
  if (!userRow?.brokerage_id) {
    throw new PortalAuthError("User has no brokerage scope")
  }

  return {
    userId:      user.id,
    brokerageId: userRow.brokerage_id,
    userType,
    reason:      reason.trim(),
  }
}
