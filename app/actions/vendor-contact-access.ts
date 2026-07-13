"use server"

/**
 * Vendor contact-scoped access management.
 *
 * Two write paths:
 *   - assignVendorToContactAction:    agent grants vendor access to a contact
 *   - revokeVendorContactAccessAction: any tenant admin revokes
 *
 * Two read paths for the scoped vendor portal:
 *   - listVendorAssignedContactsAction: contacts the vendor can see this session
 *   - listVendorAssignedTransactionsAction: transactions the vendor is on
 *
 * RLS lockdown lives in migration 1059. These actions enforce business rules
 * (caller must belong to the same brokerage as the vendor+contact) BEFORE
 * trusting the DB layer — defense in depth.
 *
 * Future paid add-on (vendor_subscriptions / vendor_plans tables already exist):
 *   vendor.access_level = 'brokerage_full_access' bypasses contact-by-contact
 *   gating via public.vendor_has_contact_access(). Today only superadmin can
 *   set that; commit-G will add the billing path.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"

const ASSIGN_ALLOWED_ROLES = new Set([
  "broker", "broker_admin", "admin", "superadmin", "team_lead", "agent", "tc",
])

const REVOKE_ALLOWED_ROLES = new Set([
  "broker", "broker_admin", "admin", "superadmin", "team_lead",
])

async function requireBrokerageMember(allowed: Set<string>): Promise<
  | { ok: true; userId: string; brokerageId: string; userType: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!data?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  if (!allowed.has(data.user_type ?? "")) return { ok: false, error: "Forbidden" }
  return { ok: true, userId: user.id, brokerageId: data.brokerage_id, userType: data.user_type }
}

// ── ASSIGN ───────────────────────────────────────────────────────────────────

export interface AssignVendorContactInput {
  vendorId:       string
  contactId:      string
  transactionId?: string
  scope?:         "pii_basic" | "pii_full" | "transaction_docs" | "financial"
  expiresAt?:     string
  notes?:         string
}

export interface AssignVendorContactResult {
  ok:           boolean
  error?:       string
  assignmentId?: string
}

export async function assignVendorToContactAction(
  input: AssignVendorContactInput,
): Promise<AssignVendorContactResult> {
  const auth = await requireBrokerageMember(ASSIGN_ALLOWED_ROLES)
  if (!auth.ok) return auth

  const svc = createServiceClient()

  // Sanity: vendor + contact must belong to caller's brokerage. Refusing
  // cross-tenant grants here even though RLS would, because failing fast at
  // the action layer gives a clearer error message + leaves no DB noise.
  const [{ data: vendor }, { data: contact }] = await Promise.all([
    svc.from("vendors").select("id, brokerage_id, access_level").eq("id", input.vendorId).maybeSingle(),
    svc.from("contacts").select("id, brokerage_id").eq("id", input.contactId).maybeSingle(),
  ])
  if (!vendor)  return { ok: false, error: "Vendor not found" }
  if (!contact) return { ok: false, error: "Contact not found" }
  if (vendor.brokerage_id  !== auth.brokerageId) return { ok: false, error: "Vendor belongs to another brokerage" }
  if (contact.brokerage_id !== auth.brokerageId) return { ok: false, error: "Contact belongs to another brokerage" }

  // Transaction is optional but must match brokerage if provided
  if (input.transactionId) {
    const { data: tx } = await svc
      .from("transactions")
      .select("id, brokerage_id")
      .eq("id", input.transactionId)
      .maybeSingle()
    if (!tx) return { ok: false, error: "Transaction not found" }
    if (tx.brokerage_id !== auth.brokerageId) {
      return { ok: false, error: "Transaction belongs to another brokerage" }
    }
  }

  // Reactivate any prior revoked assignment for this (vendor, contact, tx)
  // OR insert fresh. The uq_vca_active unique index enforces "one active per tuple".
  const { data: existing } = await svc
    .from("vendor_contact_assignments")
    .select("id, status")
    .eq("vendor_id", input.vendorId)
    .eq("contact_id", input.contactId)
    .eq("transaction_id", input.transactionId ?? null as any)
    .maybeSingle()

  let assignmentId: string

  if (existing && existing.status === "active") {
    assignmentId = existing.id as string
  } else if (existing) {
    // Reactivate the prior revoked/expired row
    const { error } = await svc
      .from("vendor_contact_assignments")
      .update({
        status:        "active",
        granted_at:    new Date().toISOString(),
        assigned_by:   auth.userId,
        revoked_at:    null,
        revoked_by:    null,
        revoke_reason: null,
        scope:         input.scope ?? "pii_basic",
        expires_at:    input.expiresAt ?? null,
        notes:         input.notes ?? null,
      })
      .eq("id", existing.id as string)
    if (error) return { ok: false, error: error.message }
    assignmentId = existing.id as string
  } else {
    const { data: inserted, error } = await svc
      .from("vendor_contact_assignments")
      .insert({
        vendor_id:      input.vendorId,
        contact_id:     input.contactId,
        transaction_id: input.transactionId ?? null,
        brokerage_id:   auth.brokerageId,
        assigned_by:    auth.userId,
        scope:          input.scope ?? "pii_basic",
        status:         "active",
        expires_at:     input.expiresAt ?? null,
        notes:          input.notes ?? null,
      })
      .select("id")
      .single()
    if (error || !inserted) return { ok: false, error: error?.message ?? "Insert failed" }
    assignmentId = inserted.id as string
  }

  revalidatePath("/dashboard/vendors")
  revalidatePath("/portal/vendor")
  return { ok: true, assignmentId }
}

// ── REVOKE ───────────────────────────────────────────────────────────────────

export async function revokeVendorContactAccessAction(params: {
  assignmentId: string
  reason?:      string
}): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireBrokerageMember(REVOKE_ALLOWED_ROLES)
  if (!auth.ok) return auth

  const svc = createServiceClient()
  const { error } = await svc
    .from("vendor_contact_assignments")
    .update({
      status:        "revoked",
      revoked_at:    new Date().toISOString(),
      revoked_by:    auth.userId,
      revoke_reason: params.reason ?? null,
    })
    .eq("id", params.assignmentId)
    .eq("brokerage_id", auth.brokerageId)
    .eq("status", "active")

  if (error) return { ok: false, error: error.message }
  revalidatePath("/dashboard/vendors")
  revalidatePath("/portal/vendor")
  return { ok: true }
}

// ── READ (vendor side) ───────────────────────────────────────────────────────

export interface VendorAssignedContactRow {
  assignment_id:  string
  contact_id:     string
  contact_name:   string
  contact_email:  string | null
  contact_phone:  string | null
  scope:          string
  transaction_id: string | null
  property_address: string | null
  granted_at:     string
}

/**
 * Returns ONLY the contacts the calling vendor has active access to.
 * Reads through service client + explicit join to bypass the cross-table
 * RLS (which would require the vendor to hold direct contacts read at the
 * exact moment of query — needlessly fragile). Business gate is the
 * user_role_assignments → vendor_id lookup.
 */
export async function listVendorAssignedContactsAction(): Promise<
  | { ok: true; rows: VendorAssignedContactRow[] }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }

  // Resolve calling user's vendor_id via user_role_assignments
  const { data: roleRow } = await supabase
    .from("user_role_assignments")
    .select("vendor_id")
    .eq("user_id", user.id)
    .not("vendor_id", "is", null)
    .maybeSingle()
  if (!roleRow?.vendor_id) return { ok: false, error: "Not a vendor account" }

  const svc = createServiceClient()

  // VENDOR-LEVEL EXPIRY (l49-s01, concierge §1.7) — assignment-level
  // expires_at was already enforced below; this adds the whole-vendor
  // time box (engagement ended = every assignment goes dark at once).
  const { data: vendorRow } = await svc
    .from("vendors").select("access_expires_at, status").eq("id", roleRow.vendor_id).maybeSingle()
  if (vendorRow?.access_expires_at && new Date(vendorRow.access_expires_at).getTime() < Date.now()) {
    return { ok: false, error: "Vendor access has expired — ask the brokerage to renew it" }
  }

  const { data, error } = await svc
    .from("vendor_contact_assignments")
    .select(`
      id, scope, granted_at, transaction_id,
      contact:contacts!inner ( id, first_name, last_name, email, phone ),
      transaction:transactions ( id, property_address )
    `)
    .eq("vendor_id", roleRow.vendor_id)
    .eq("status", "active")
    .or("expires_at.is.null,expires_at.gt." + new Date().toISOString())
    .order("granted_at", { ascending: false })

  if (error) return { ok: false, error: error.message }

  const rows: VendorAssignedContactRow[] = (data ?? []).map((r: any) => {
    const c  = Array.isArray(r.contact)     ? r.contact[0]     : r.contact
    const tx = Array.isArray(r.transaction) ? r.transaction[0] : r.transaction
    return {
      assignment_id:    r.id,
      contact_id:       c?.id,
      contact_name:     [c?.first_name, c?.last_name].filter(Boolean).join(" ") || "Unknown",
      contact_email:    c?.email   ?? null,
      contact_phone:    c?.phone   ?? null,
      scope:            r.scope,
      transaction_id:   r.transaction_id,
      property_address: tx?.property_address ?? null,
      granted_at:       r.granted_at,
    }
  })

  return { ok: true, rows }
}

// ── READ (admin side — for /dashboard/vendors detail panel) ──────────────────

export async function listVendorAssignmentsForBrokerageAction(
  vendorId?: string,
): Promise<
  | {
      ok: true
      rows: Array<{
        id:               string
        vendor_id:        string
        vendor_name:      string
        contact_id:       string
        contact_name:     string
        transaction_id:   string | null
        scope:            string
        status:           string
        granted_at:       string
        revoked_at:       string | null
      }>
    }
  | { ok: false; error: string }
> {
  const auth = await requireBrokerageMember(new Set([
    "broker","broker_admin","admin","superadmin","team_lead","agent","tc","isa",
  ]))
  if (!auth.ok) return auth

  const svc = createServiceClient()
  let q = svc
    .from("vendor_contact_assignments")
    .select(`
      id, vendor_id, contact_id, transaction_id, scope, status,
      granted_at, revoked_at,
      vendor:vendors!inner ( name ),
      contact:contacts!inner ( first_name, last_name )
    `)
    .eq("brokerage_id", auth.brokerageId)
    .order("granted_at", { ascending: false })
    .limit(100)

  if (vendorId) q = q.eq("vendor_id", vendorId)

  const { data, error } = await q
  if (error) return { ok: false, error: error.message }

  return {
    ok: true,
    rows: (data ?? []).map((r: any) => {
      const v = Array.isArray(r.vendor)  ? r.vendor[0]  : r.vendor
      const c = Array.isArray(r.contact) ? r.contact[0] : r.contact
      return {
        id:             r.id,
        vendor_id:      r.vendor_id,
        vendor_name:    v?.name ?? "Unknown vendor",
        contact_id:     r.contact_id,
        contact_name:   [c?.first_name, c?.last_name].filter(Boolean).join(" ") || "Unknown",
        transaction_id: r.transaction_id,
        scope:          r.scope,
        status:         r.status,
        granted_at:     r.granted_at,
        revoked_at:     r.revoked_at,
      }
    }),
  }
}
