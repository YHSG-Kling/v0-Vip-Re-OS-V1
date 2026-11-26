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
 *   Every mutator must call requireLenderVendorActor / requireTitleVendorActor /
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
import { OVERRIDE_REASON_MIN_CHARS } from "@/lib/kernel/status-override"

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
  userId:       string         // auth.users.id — the SESSION, never a caller-supplied id
  vendorId:     string         // vendors.id — a title company IS a vendor (category 'title')
  brokerageId:  string         // vendors.brokerage_id — the tenant the title seat serves
  companyName:  string | null  // vendors.name
  companyPhone: string | null  // vendors.phone
  email:        string | null  // the signed-in person's own email (auth user), for "updated_by" audit text only
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
 * Title authorization — TITLE COMPANIES ARE VENDORS (CLAUDE.md §4: "A LENDER IS NOT A USER TYPE — it is a VENDOR
 * CATEGORY, and so is a title agent"). The same reads as requireLenderVendorActor above:
 *   1. the SESSION user (auth.getUser) — no session, no actor;
 *   2. holds a role row for a vendor (user_role_assignments.vendor_id → vendors) whose category is TITLE
 *      (lib/kernel/lender-linkage.ts isTitleVendorCategory — the category test stated once);
 *   3. that vendor is in a brokerage (vendors.brokerage_id) — the tenant comes from the vendor row, never a body;
 *   4. when a deal is named: that title vendor is ASSIGNED to THAT transaction in its own tenant
 *      (vendor_assignments: vendor_id + transaction_id + brokerage_id).
 * Pass `null` only where no single deal is in question (a dashboard listing the seat's own files).
 *
 * WHICH "ON THE DEAL" RULE (two existed): the old title code matched transaction_title_escrow.title_company_email
 * against an email; the lender gate matches vendor_assignments. The assignment is kept, because it is the STRICTER:
 * it is an FK-backed act of the brokerage (vendor_id → vendors, brokerage_id pinned), while the escrow email is free
 * text a brokerage types for outreach, is not unique, and would admit any title seat whose email happened to equal it.
 * Escrow rows are still READ (the title figures) — but only after this gate has admitted the deal, never as the gate.
 *
 * Every read's refusal is READ (§3) and becomes `refused` — "could not verify" is never spoken as "not authorized".
 * TOMBSTONE: this replaces requireTitleActor(claimedTitleUserId), which admitted a title_company_users row
 * (0 rows live, no writer in app code, triggers or functions — wave 155, lane 155T3). The caller-supplied
 * titleUserId is gone with it: the actor is the SESSION's title vendor seat.
 */
export type TitleActorResolution =
  | { ok: true; actor: TitleActorContext }
  | { ok: false; reason: "unauthenticated" | "not_title_vendor" | "no_brokerage" | "not_on_deal" | "refused"; detail: string }

export async function resolveTitleVendorActor(
  supabase: any,
  transactionId: string | null,
): Promise<TitleActorResolution> {
  if (transactionId !== null && !transactionId) return { ok: false, reason: "not_on_deal", detail: "transactionId required" }

  const { data: sessionData, error: sessionError } = await supabase.auth.getUser()
  const user = sessionData?.user
  if (sessionError || !user) return { ok: false, reason: "unauthenticated", detail: "Not authenticated" }

  // The caller's vendor identity (a title company is a vendor).
  const { data: roleRows, error: roleError } = await supabase
    .from("user_role_assignments")
    .select("vendor_id, vendors!inner(id, name, phone, category, brokerage_id)")
    .eq("user_id", user.id)
    .not("vendor_id", "is", null)
  if (roleError) return { ok: false, reason: "refused", detail: `Could not verify your title access just now (${roleError.message})` }

  const { isTitleVendorCategory } = await import("@/lib/kernel/lender-linkage")
  const titleVendors = ((roleRows ?? []) as any[])
    .map((r) => r.vendors)
    .filter((v) => v?.id && isTitleVendorCategory(v.category))
  if (titleVendors.length === 0) {
    return { ok: false, reason: "not_title_vendor", detail: "Not authorized — your account is not a title company vendor" }
  }
  // Stable order: one person may hold title seats at several brokerages (one vendor row per inviting brokerage).
  const seats = titleVendors.filter((v) => !!v.brokerage_id).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  if (seats.length === 0) return { ok: false, reason: "no_brokerage", detail: "Title vendor is missing a brokerage scope" }

  const toActor = (v: any): TitleActorContext => ({
    userId:       user.id,
    vendorId:     v.id,
    brokerageId:  v.brokerage_id,
    companyName:  v.name ?? null,
    companyPhone: v.phone ?? null,
    email:        (user.email as string | undefined) ?? null,
  })
  if (transactionId === null) return { ok: true, actor: toActor(seats[0]) }

  // Must be assigned to THIS transaction, inside the seat's own tenant.
  for (const v of seats) {
    const { data: assigned, error: assignError } = await supabase
      .from("vendor_assignments")
      .select("id")
      .eq("vendor_id", v.id)
      .eq("transaction_id", transactionId)
      .eq("brokerage_id", v.brokerage_id)
      .limit(1)
    if (assignError) return { ok: false, reason: "refused", detail: `Could not verify your assignment just now (${assignError.message})` }
    if ((assigned ?? []).length > 0) return { ok: true, actor: toActor(v) }
  }
  return { ok: false, reason: "not_on_deal", detail: "Unauthorized: title company not assigned to this transaction" }
}

/** The throwing form every title server action calls first (the shape of requireLenderVendorActor). */
export async function requireTitleVendorActor(transactionId: string | null): Promise<TitleActorContext> {
  const supabase = await createClient()
  const r = await resolveTitleVendorActor(supabase, transactionId)
  if (!r.ok) throw new PortalAuthError(r.detail)
  return r.actor
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

  // "Does this user hold ANY grant against the claimed vendor?" — an EXISTENCE
  // question, and (user_id, vendor_id) is not a unique key: the table is UNIQUE on
  // (user_id, role), so one user may hold e.g. both `vendor` and `title_agent`
  // against the same vendor. `.maybeSingle()` over those two rows is an ERROR, and
  // this gate — reading `data` alone — refused a legitimately linked vendor with
  // "your account does not have a vendor role for this vendor". A gate must never
  // speak a refused read as a settled denial.
  const { data: rows, error } = await supabase
    .from("user_role_assignments")
    .select("user_id, vendor_id, brokerage_id, role")
    .eq("user_id", user.id)
    .eq("vendor_id", claimedVendorId)

  if (error) {
    throw new PortalAuthError("Could not verify your vendor access just now — please try again")
  }

  if (!rows || rows.length === 0) {
    throw new PortalAuthError(
      "Not authorized for this vendor — your account does not have a vendor role for this vendor",
    )
  }

  // All these rows describe the SAME vendor; the only thing to choose between them
  // is the brokerage scope, and a grant that carries one is strictly better than a
  // grant that does not. Ordered by role name so the choice is stable rather than
  // whatever the plan returned.
  const row =
    [...rows].sort((a, b) => String(a.role ?? "").localeCompare(String(b.role ?? "")))
      .find((r) => r.brokerage_id) ?? rows[0]

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
// requireVendorActor takes a CLAIMED id and verifies the session owns it, and
// requireLenderVendorActor / requireTitleVendorActor take the DEAL and derive the
// actor from the session — the right shapes for a server action. The
// two `app/api/external-portal/*` routes had no claimed-id contract worth
// keeping: they read `partnerId` and `partnerType` from the request and used
// them as the authorization SUBJECT, and the ids their own callers send are in a
// different id space than the ids they compared against (the vendor and title
// dashboards pass `vendors.id`, while the download route compared that value to
// a title-membership user id and to `user_role_assignments.user_id`). A
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
  /** The caller holds a TITLE vendor seat (vendors.category 'title' — title is a vendor category, CLAUDE.md §4). */
  isTitlePartner: boolean
  /** vendors.id of that title seat (lib/kernel/lender-linkage.ts isTitleVendorCategory), or null. */
  titleVendorId: string | null
  /** vendors.id via user_role_assignments.vendor_id, when the caller is one (the lender seat first, else any). */
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

  // TITLE — TOMBSTONE (wave 155, lane 155T3): this read title_company_users (0 rows, no writer anywhere), so no
  // title company ever resolved here. A title company is a VENDOR seat whose category is title, derived from the
  // same user_role_assignments read below — the rail requireTitleVendorActor (this file) checks.

  // VENDOR / LENDER / TITLE — user_role_assignments.vendor_id → vendors. Its RLS is
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

  const { isLenderVendorCategory, isTitleVendorCategory } = await import("@/lib/kernel/lender-linkage")
  const vendors = ((roleRows ?? []) as any[]).map((r) => r.vendors).filter(Boolean)
  const lenderVendor = vendors.find((v) => isLenderVendorCategory(v.category)) ?? null
  const titleVendor = vendors.find((v) => isTitleVendorCategory(v.category)) ?? null
  const plainVendor = vendors.find((v) => !isLenderVendorCategory(v.category) && !isTitleVendorCategory(v.category)) ?? null
  const anyVendor = lenderVendor ?? plainVendor ?? titleVendor ?? null

  const partnerTypes: ExternalPartnerType[] = []
  if (titleVendor) partnerTypes.push("title")
  if (lenderVendor) partnerTypes.push("lender")
  else if (plainVendor) partnerTypes.push("vendor")

  if (partnerTypes.length === 0) {
    return {
      ok: false,
      reason: "not_a_partner",
      detail: "session holds no vendor role assignment (title, lender or other vendor)",
    }
  }

  return {
    ok: true,
    identity: {
      userId:         user.id,
      brokerageId:    (userRow?.brokerage_id as string | null) ?? null,
      isTitlePartner: !!titleVendor,
      titleVendorId:  (titleVendor?.id as string | null) ?? null,
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
 * keyed on the caller's own identity — `vendor_assignments.vendor_id =
 * identity.titleVendorId` / `= identity.vendorId`. Nothing
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

  if (identity.isTitlePartner && identity.titleVendorId) {
    // Title companies are vendors — the caller's OWN title vendor must be assigned here (the same rule as
    // requireTitleVendorActor; the retired title_company_users membership read is tombstoned above).
    const { data: titleAccess, error: titleError } = await supabase
      .from("vendor_assignments")
      .select("id")
      .eq("vendor_id", identity.titleVendorId) // ← resolved from the session, not the request
      .eq("transaction_id", transactionId)
      .limit(1)
      .maybeSingle()
    if (titleError) {
      return { ok: false, reason: "refused", detail: `vendor_assignments (title) read refused: ${titleError.message}` }
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
// SCOPE LADDER (kept inline — admits compliance tiers): 'superadmin' removed —
// dead as users.user_type (0 live rows store it); broker_owner added — storable
// seat that owns the brokerage. Mirrored by COMPLIANCE_OVERRIDE_USER_TYPES in
// app/components/layout/unified-inbox-slideout.tsx.
const OVERRIDE_USER_TYPES = new Set([
  "broker", "broker_owner", "broker_admin", "admin",
  "compliance_officer", "compliance_manager",
])

export async function requireOverrideActor(reason: string | null | undefined): Promise<OverrideContext> {
  // ONE floor (wave 148, lane 148I — contract C23): the same reason rule every manual status change holds
  // (lib/kernel/status-override.ts OVERRIDE_REASON_MIN_CHARS), never a second literal.
  if (!reason || reason.trim().length < OVERRIDE_REASON_MIN_CHARS) {
    throw new PortalAuthError(`Override reason required (min ${OVERRIDE_REASON_MIN_CHARS} characters) for audit trail`)
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
