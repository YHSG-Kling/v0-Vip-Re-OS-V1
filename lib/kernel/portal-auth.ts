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
  lenderId:      string  // lender_portal_users.id (FK)
  brokerageId:   string
  lenderCompany: string | null
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
 * Lender portal authorization gate.
 * Verifies the authenticated user owns the lender_portal_users row that
 * matches the claimed lenderId. Throws on any mismatch.
 */
export async function requireLenderActor(claimedLenderId: string): Promise<LenderActorContext> {
  if (!claimedLenderId) throw new PortalAuthError("lenderId required")

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new PortalAuthError("Not authenticated")

  const { data: row } = await supabase
    .from("lender_portal_users")
    .select("id, user_id, brokerage_id, lender_company")
    .eq("user_id", user.id)
    .eq("id", claimedLenderId)
    .maybeSingle()

  if (!row) {
    throw new PortalAuthError(
      "Not authorized for this lender profile — your account does not match the claimed lender",
    )
  }

  if (!row.brokerage_id) {
    throw new PortalAuthError("Lender profile is missing a brokerage scope")
  }

  return {
    userId:        user.id,
    lenderId:      row.id,
    brokerageId:   row.brokerage_id,
    lenderCompany: row.lender_company ?? null,
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

// ─── Manual Override gate ────────────────────────────────────────────────────

export interface OverrideContext {
  userId:      string
  brokerageId: string
  role:        string
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
 *   - role is not broker / admin / superadmin / compliance_officer
 *   - reason is shorter than 10 characters (audit trail integrity)
 */
const OVERRIDE_ROLES = new Set([
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

  const role = (userRow?.user_type ?? "").toLowerCase()
  if (!OVERRIDE_ROLES.has(role)) {
    throw new PortalAuthError(
      `Role '${role || "unknown"}' is not authorized to override gates. Required: broker / admin / superadmin / compliance_officer`,
    )
  }
  if (!userRow?.brokerage_id) {
    throw new PortalAuthError("User has no brokerage scope")
  }

  return {
    userId:      user.id,
    brokerageId: userRow.brokerage_id,
    role,
    reason:      reason.trim(),
  }
}
