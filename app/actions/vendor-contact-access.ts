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
import { readRoleGrants, selectVendorId } from "@/lib/auth/role-grants"

const ASSIGN_ALLOWED_ROLES = new Set([
  "broker", "broker_admin", "admin", "superadmin", "team_lead", "agent", "tc",
])

const REVOKE_ALLOWED_ROLES = new Set([
  "broker", "broker_admin", "admin", "superadmin", "team_lead",
])

/** vendor_contact_assignments.scope CHECK vocabulary, verified against the live
 *  database. Mirrors VendorAccessScope in lib/vendor/assignment-access.ts. */
const VENDOR_ACCESS_SCOPES = ["pii_basic", "pii_full", "transaction_docs", "financial"] as const

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

  // Vocabulary gate — vendor_contact_assignments.scope carries a CHECK constraint
  // (verified against the live schema: pii_basic | pii_full | transaction_docs |
  // financial). A value outside it is rejected by the column, and the scope is the
  // least-privilege dial assertVendorAssignedToContact reads, so a silent default
  // would be a silent privilege change.
  const scope = input.scope ?? "pii_basic"
  if (!(VENDOR_ACCESS_SCOPES as readonly string[]).includes(scope)) {
    return { ok: false, error: `Unknown scope — must be one of: ${VENDOR_ACCESS_SCOPES.join(", ")}` }
  }
  // An expiry in the past would grant access that is already dark — the vendor
  // portal filters on expires_at, so this silently produces a dead grant.
  let expiresAt: string | null = null
  if (input.expiresAt) {
    const t = Date.parse(input.expiresAt)
    if (Number.isNaN(t)) return { ok: false, error: "Expiry date is not a valid timestamp" }
    if (t <= Date.now()) return { ok: false, error: "Expiry must be in the future — that grant would already be expired" }
    expiresAt = new Date(t).toISOString()
  }

  const svc = createServiceClient()

  // Sanity: vendor + contact must belong to caller's brokerage. Refusing
  // cross-tenant grants here even though RLS would, because this reads through
  // the SERVICE client, which bypasses RLS entirely — the tenant boundary on
  // this path is these comparisons and nothing else. Errors are destructured:
  // a refused read resolving to `data: null` would otherwise read as
  // "vendor not found" and mask a real failure.
  const [vendorRes, contactRes] = await Promise.all([
    svc.from("vendors").select("id, brokerage_id, access_level").eq("id", input.vendorId).maybeSingle(),
    svc.from("contacts").select("id, brokerage_id").eq("id", input.contactId).maybeSingle(),
  ])
  if (vendorRes.error)  return { ok: false, error: vendorRes.error.message }
  if (contactRes.error) return { ok: false, error: contactRes.error.message }
  const vendor  = vendorRes.data
  const contact = contactRes.data
  if (!vendor)  return { ok: false, error: "Vendor not found" }
  if (!contact) return { ok: false, error: "Contact not found" }
  if (vendor.brokerage_id  !== auth.brokerageId) return { ok: false, error: "Vendor belongs to another brokerage" }
  if (contact.brokerage_id !== auth.brokerageId) return { ok: false, error: "Contact belongs to another brokerage" }

  // Transaction is optional but must match brokerage if provided
  if (input.transactionId) {
    const { data: tx, error: txErr } = await svc
      .from("transactions")
      .select("id, brokerage_id")
      .eq("id", input.transactionId)
      .maybeSingle()
    if (txErr) return { ok: false, error: txErr.message }
    if (!tx) return { ok: false, error: "Transaction not found" }
    if (tx.brokerage_id !== auth.brokerageId) {
      return { ok: false, error: "Transaction belongs to another brokerage" }
    }
  }

  // Reactivate any prior revoked assignment for this (vendor, contact, tx)
  // OR insert fresh. The uq_vca_active unique index enforces "one active per
  // tuple" over COALESCE(transaction_id, all-zero uuid).
  //
  // BUG THIS REPLACES: the lookup used `.eq("transaction_id", null)`. PostgREST
  // renders that as `transaction_id=eq.null`, which matches NO rows — SQL NULL
  // is never equal to anything. So for the common contact-level grant (no
  // transaction) the reactivate branch was unreachable: every re-grant fell
  // through to INSERT and collided with uq_vca_active, and re-granting a
  // previously revoked vendor failed with a raw unique-violation.
  let existingQ = svc
    .from("vendor_contact_assignments")
    .select("id, status")
    .eq("brokerage_id", auth.brokerageId)
    .eq("vendor_id", input.vendorId)
    .eq("contact_id", input.contactId)
  existingQ = input.transactionId
    ? existingQ.eq("transaction_id", input.transactionId)
    : existingQ.is("transaction_id", null)
  // Newest first + limit(1): uq_vca_active only constrains ACTIVE rows, so this
  // tuple can legitimately hold several revoked rows. maybeSingle() would throw
  // on those instead of reusing one.
  const { data: existingRows, error: existingErr } = await existingQ
    .order("status", { ascending: true })   // 'active' sorts before 'expired'/'revoked'
    .order("granted_at", { ascending: false })
    .limit(1)
  if (existingErr) return { ok: false, error: existingErr.message }
  const existing = existingRows?.[0] ?? null

  let assignmentId: string
  let reactivated = false

  if (existing && existing.status === "active") {
    assignmentId = existing.id as string
  } else if (existing) {
    // Reactivate the prior revoked/expired row
    const { error, count } = await svc
      .from("vendor_contact_assignments")
      .update({
        brokerage_id:  auth.brokerageId,
        status:        "active",
        granted_at:    new Date().toISOString(),
        assigned_by:   auth.userId,
        revoked_at:    null,
        revoked_by:    null,
        revoke_reason: null,
        scope,
        expires_at:    expiresAt,
        notes:         input.notes ?? null,
      }, { count: "exact" })
      .eq("id", existing.id as string)
      .eq("brokerage_id", auth.brokerageId)
    if (error) return { ok: false, error: error.message }
    if ((count ?? 0) === 0) return { ok: false, error: "Could not reactivate the prior assignment — nothing was granted." }
    assignmentId = existing.id as string
    reactivated = true
  } else {
    const { data: inserted, error } = await svc
      .from("vendor_contact_assignments")
      .insert({
        brokerage_id:   auth.brokerageId,
        vendor_id:      input.vendorId,
        contact_id:     input.contactId,
        transaction_id: input.transactionId ?? null,
        assigned_by:    auth.userId,
        scope,
        status:         "active",
        expires_at:     expiresAt,
        notes:          input.notes ?? null,
      })
      .select("id")
      .single()
    if (error || !inserted) return { ok: false, error: error?.message ?? "Insert failed" }
    assignmentId = inserted.id as string
  }

  // Granting an outside party access to a client's PII is an auditable event.
  await svc.from("audit_log").insert({
    after: {
      brokerage_id:   auth.brokerageId,
      vendor_id:      input.vendorId,
      contact_id:     input.contactId,
      transaction_id: input.transactionId ?? null,
      scope,
      expires_at:     expiresAt,
      reactivated,
    },
    user_id:     auth.userId,
    action:      "vendor_contact_access.granted",
    entity_type: "vendor_contact_assignment",
    entity_id:   assignmentId,
  })

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
  // A REVOKE THAT MATCHED NO ROW MUST NEVER REPORT SUCCESS. postgrest resolves an
  // UPDATE that matches zero rows as a plain success, so without count:"exact"
  // this returned { ok: true } — and the operator walked away believing a vendor's
  // access to a client's PII had been cut when the grant was still live. Every
  // filter below can legitimately miss (wrong brokerage, already revoked, bad id),
  // which is precisely why the zero case has to be loud.
  const { error, count } = await svc
    .from("vendor_contact_assignments")
    .update({
      status:        "revoked",
      revoked_at:    new Date().toISOString(),
      revoked_by:    auth.userId,
      revoke_reason: params.reason ?? null,
    }, { count: "exact" })
    .eq("id", params.assignmentId)
    .eq("brokerage_id", auth.brokerageId)
    .eq("status", "active")

  if (error) return { ok: false, error: error.message }
  if ((count ?? 0) === 0) {
    return {
      ok: false,
      error: "No ACTIVE assignment matched — access was NOT revoked. It may already be revoked, or it belongs to another brokerage.",
    }
  }

  await svc.from("audit_log").insert({
    after:       { brokerage_id: auth.brokerageId, assignment_id: params.assignmentId, revoke_reason: params.reason ?? null, revoked_by: auth.userId },
    user_id:     auth.userId,
    action:      "vendor_contact_access.revoked",
    entity_type: "vendor_contact_assignment",
    entity_id:   params.assignmentId,
  })

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

  // Resolve calling user's vendor_id via user_role_assignments.
  //
  // WAS: `.not("vendor_id","is",null).maybeSingle()` with no limit, and no error
  // check. user_role_assignments is UNIQUE on (user_id, role), NOT on user_id —
  // the constraint permits two vendor-bearing grants under different roles, and
  // `.maybeSingle()` over two rows is an ERROR. supabase-js RESOLVES that error,
  // so the unchecked read collapsed BOTH "you hold no vendor grant" and "the read
  // was refused" into the same "Not a vendor account" message. Those are a
  // permissions answer and an outage, and reporting them identically is how an
  // outage reads as a data problem.
  const grantsResult = await readRoleGrants(supabase, user.id)
  if (!grantsResult.ok) {
    console.error("[vendor-contact-access] role grant read failed:", grantsResult.error)
    return { ok: false, error: "Could not verify your vendor account — please retry" }
  }
  const { vendorId, ambiguous } = selectVendorId(grantsResult.grants)
  if (ambiguous) {
    return { ok: false, error: "Your account is linked to more than one vendor — ask the brokerage to correct it" }
  }
  if (!vendorId) return { ok: false, error: "Not a vendor account" }

  const svc = createServiceClient()

  // VENDOR-LEVEL EXPIRY (l49-s01, concierge §1.7) — assignment-level
  // expires_at was already enforced below; this adds the whole-vendor
  // time box (engagement ended = every assignment goes dark at once).
  const { data: vendorRow } = await svc
    .from("vendors").select("access_expires_at, status").eq("id", vendorId).maybeSingle()
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
    .eq("vendor_id", vendorId)
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
