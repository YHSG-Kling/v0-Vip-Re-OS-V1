/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONTACT ACCESS HAS TWO DOORS: ASSIGNMENT, OR PAID ACCESS. NEITHER = NOTHING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * OWNER RULING, verbatim:
 *
 *   "unless vendors are paying for contact access, a vendor is only able to
 *    access a contact if they are assigned to that contact"
 *
 * Read it as the conditional it is. There are TWO doors and a vendor holding
 * NEITHER sees nothing:
 *
 *   DOOR 1  ASSIGNMENT — the default, and free. An ACTIVE, unexpired
 *           `vendor_contact_assignments` row for (vendor, contact). This is what
 *           m549 named as what a second brokerage gets INSTEAD of a second
 *           platform-use charge.
 *   DOOR 2  PAID CONTACT ACCESS — a bench-wide entitlement, spelled today as
 *           `vendors.access_level = 'brokerage_full_access'` scoped to the
 *           vendor's own brokerage.
 *
 * WHAT CHANGED, AND WHY THE PREVIOUS READING WAS DEFENSIBLE. The prior wave
 * gated contact access free-and-un-chargeable, on a fail-closed reading of the
 * m549 ruling ("only access to their contacts" replacing a charge). That
 * left one question open — whether contact access could ever be SOLD — and the
 * safe answer while it was open was "no". The owner has now closed it: a PAID
 * door exists. lib/vendors/vendor-platform-identity.ts ::
 * SHARED_VENDOR_CONTACT_ACCESS_VERDICT carries the corrected wording.
 *
 * DOOR 2 IS NOT NEW AND IS NOT A SECOND SPELLING (CLAUDE.md §6). The live
 * database has said this since migration 1059 — `public.vendor_has_contact_access`
 * is literally `EXISTS(active unexpired assignment) OR access_level =
 * 'brokerage_full_access' AND same brokerage`. What was missing is that the
 * APPLICATION gate knew only about door 1, so RLS and the business gate
 * disagreed about who may see a contact. This module is now the one place both
 * doors are spelled, and it spells them the way the database already does.
 *
 * ── THE PAID DOOR BUYS REACH, NOT DEPTH ──────────────────────────────────────
 *
 * CLAUDE.md §5: "Contacts, lenders and vendors see no financials — only their
 * own." If door 2 bypassed the scope ladder, buying contact access would buy
 * financial visibility on every client in the brokerage, which that ruling
 * forbids. So door 2 confers PII scopes only: `pii_basic` and `pii_full`.
 * `transaction_docs` and `financial` remain ASSIGNMENT-ONLY — a per-contact,
 * per-transaction decision a human made. This is a ruling taken under fail-closed
 * and it is written down here rather than buried: see PAID_ACCESS_GRANTED_SCOPES.
 *
 * ── REVOKED AND EXPIRED ARE NOT "PRESENT" ────────────────────────────────────
 *
 * An assignment row EXISTING is not access. `status` must be 'active', and
 * `expires_at`, when set, must be in the future. Checking only for a row would
 * make revocation cosmetic — the operator who revoked would be told access was
 * cut while the vendor kept reading the contact. Both doors are additionally
 * subject to the whole-vendor time box (`vendors.access_expires_at`) and to the
 * vendor still being active.
 *
 * The canonical model (mirrors app/actions/vendor-contact-access.ts):
 *   1. user_role_assignments.vendor_id      resolves a logged-in user → vendors row
 *   2. vendor_contact_assignments           the (vendor_id, contact_id) grant with
 *                                           scope + status + per-assignment expiry
 *   3. vendors.access_level                 the PAID bench-wide door
 *   4. vendors.access_expires_at / status   the whole-vendor time box (engagement
 *                                           ended = every door goes dark at once)
 *
 * This helper is PURE of routing — it takes an already-constructed service client
 * so it works from server actions, voice dispatchers, and the buyer-execution
 * engine alike. It intentionally reads through the service client (RLS-independent)
 * and enforces the business gate itself: defense in depth, one code path.
 */
import type { SupabaseClient } from "@supabase/supabase-js"
import { readRoleGrants, selectVendorId } from "@/lib/auth/role-grants"

export type VendorAccessScope = "pii_basic" | "pii_full" | "transaction_docs" | "financial"

/** The live `vendors_access_level_check` list, verbatim. */
export const VENDOR_ACCESS_LEVELS = ["transaction_only", "team_full_access", "brokerage_full_access"] as const

/** The access_level that IS the paid contact-access door. Named once so a
 *  string literal cannot drift away from the CHECK. */
export const PAID_CONTACT_ACCESS_LEVEL = "brokerage_full_access"

/**
 * What DOOR 2 confers. PII only, by CLAUDE.md §5 — a bought bench-wide
 * entitlement must not carry `financial` (vendors see no financials but their
 * own) and must not carry `transaction_docs` (a per-deal document decision a
 * human makes per contact). Those two stay assignment-only.
 */
export const PAID_ACCESS_GRANTED_SCOPES: ReadonlySet<VendorAccessScope> = new Set<VendorAccessScope>([
  "pii_basic",
  "pii_full",
])

/** How access was granted, so a caller (and an audit line) can tell the free
 *  door from the paid one rather than seeing an undifferentiated `true`. */
export type VendorAccessDoor = "assignment" | "paid_brokerage_access"

/** The facts a contact-access verdict is computed from. Separated from the
 *  reads so the rule can be unit-tested without a database. */
export interface VendorContactAccessFacts {
  /** FALSE when a read was REFUSED or could not run. A refused read must fail
   *  CLOSED and say so — never be scored as "no grant exists". */
  resolved: boolean
  /** The resolved vendors.id, or null when the caller is not a vendor. */
  vendorId: string | null
  /** TRUE when the caller holds more than one vendor-bearing role grant. */
  ambiguousVendor?: boolean
  /** vendors.status — an inactive/archived vendor reads nothing. */
  vendorStatus: string | null
  /** vendors.access_expires_at — the whole-vendor time box. */
  vendorAccessExpiresAt: string | null
  /** vendors.access_level — door 2. */
  vendorAccessLevel: string | null
  /** vendors.brokerage_id and the CONTACT's brokerage_id. Door 2 is bench-wide
   *  WITHIN one tenant and must never reach across tenants. */
  vendorBrokerageId: string | null
  contactBrokerageId: string | null
  /** Every assignment row found for (vendor, contact) — including revoked and
   *  expired ones ON PURPOSE, so the rule does the filtering and the filtering
   *  is what gets tested. */
  assignments: Array<{ scope: string; status: string; expires_at: string | null }>
  /** When set, at least one door must confer one of these scopes. */
  requiredScopes?: VendorAccessScope[]
}

export type VendorContactAccessRefusal =
  | "read_refused"
  | "not_a_vendor"
  | "ambiguous_vendor"
  | "vendor_inactive"
  | "vendor_access_expired"
  | "no_door"
  | "scope_not_granted"

export type VendorContactAccessVerdict =
  | { ok: true; door: VendorAccessDoor; scope: VendorAccessScope }
  | { ok: false; reason: VendorContactAccessRefusal; error: string }

const ACCESS_REFUSAL_TEXT: Record<VendorContactAccessRefusal, string> = {
  read_refused: "Could not verify your vendor account just now — please try again.",
  not_a_vendor: "Not a vendor account — no vendor assignment on file.",
  ambiguous_vendor: "Your account is linked to more than one vendor — ask the brokerage to correct it.",
  vendor_inactive: "This vendor account is not active.",
  vendor_access_expired: "Vendor access has expired — ask the brokerage to renew it.",
  no_door: "You are not assigned to this contact.",
  scope_not_granted: "Your assignment does not grant the required scope.",
}

function denyAccess(reason: VendorContactAccessRefusal, error?: string): VendorContactAccessVerdict {
  return { ok: false, reason, error: error ?? ACCESS_REFUSAL_TEXT[reason] }
}

/**
 * PURE — may this vendor see this contact, and through which door?
 *
 * Order is deliberate: everything that makes the question UNANSWERABLE is
 * checked before anything that answers it "no", so a refused read is never
 * spoken as a settled "you are not assigned".
 */
export function vendorContactAccessVerdict(
  facts: VendorContactAccessFacts,
  now: number = Date.now(),
): VendorContactAccessVerdict {
  if (!facts.resolved) return denyAccess("read_refused")
  if (facts.ambiguousVendor) return denyAccess("ambiguous_vendor")
  if (!facts.vendorId) return denyAccess("not_a_vendor")

  // The whole-vendor time box and status gate BOTH doors at once: engagement
  // ended means everything goes dark, paid or assigned.
  if (facts.vendorStatus && facts.vendorStatus !== "active") return denyAccess("vendor_inactive")
  if (facts.vendorAccessExpiresAt) {
    const t = Date.parse(facts.vendorAccessExpiresAt)
    // An unparseable expiry fails CLOSED — a date nobody can read is not a
    // licence to keep reading a client's PII.
    if (Number.isNaN(t) || t < now) return denyAccess("vendor_access_expired")
  }

  // DOOR 1 — ASSIGNMENT. Revoked and expired rows are filtered out HERE, which
  // is the whole point of the door: a row's existence is not access.
  const activeAssignments = facts.assignments.filter((a) => {
    if (a.status !== "active") return false
    if (!a.expires_at) return true
    const t = Date.parse(a.expires_at)
    if (Number.isNaN(t)) return false // unreadable expiry fails CLOSED
    return t > now
  })

  // DOOR 2 — PAID bench-wide access, strictly within the vendor's own tenant.
  // A null brokerage on either side cannot be matched, so it cannot open.
  const paidDoorOpen =
    facts.vendorAccessLevel === PAID_CONTACT_ACCESS_LEVEL &&
    !!facts.vendorBrokerageId &&
    !!facts.contactBrokerageId &&
    facts.vendorBrokerageId === facts.contactBrokerageId

  if (activeAssignments.length === 0 && !paidDoorOpen) return denyAccess("no_door")

  const required = facts.requiredScopes
  if (!required || required.length === 0) {
    // No scope demanded. Prefer the assignment door when both are open: it is
    // the specific, human-made grant and it is what an audit line should name.
    if (activeAssignments.length > 0) {
      return { ok: true, door: "assignment", scope: activeAssignments[0].scope as VendorAccessScope }
    }
    return { ok: true, door: "paid_brokerage_access", scope: "pii_basic" }
  }

  const byAssignment = activeAssignments.find((a) => required.includes(a.scope as VendorAccessScope))
  if (byAssignment) {
    return { ok: true, door: "assignment", scope: byAssignment.scope as VendorAccessScope }
  }

  if (paidDoorOpen) {
    const byPaid = required.find((s) => PAID_ACCESS_GRANTED_SCOPES.has(s))
    if (byPaid) return { ok: true, door: "paid_brokerage_access", scope: byPaid }
  }

  return denyAccess(
    "scope_not_granted",
    `Your access does not grant the required scope (${required.join(" / ")}).`,
  )
}

export interface VendorAssignmentCheck {
  ok: boolean
  /** The resolved vendors.id for the calling user (present on success). */
  vendorId?: string
  /** The granting scope (present on success). */
  scope?: string
  /** WHICH DOOR opened (present on success) — 'assignment' is the free,
   *  per-contact grant; 'paid_brokerage_access' is the bench-wide entitlement.
   *  Surfaced rather than collapsed into `ok` so an audit line can say how a
   *  vendor came to be reading a client's PII. */
  door?: VendorAccessDoor
  /** Machine-readable refusal cause (present on failure). */
  reason?: VendorContactAccessRefusal
  /** Human-readable reason on failure — safe to speak/return to the caller. */
  error?: string
}

/**
 * Assert that a vendor/lender USER may reach a specific contact, through EITHER
 * door — an active assignment, or paid bench-wide access. The name is kept: it
 * is what every existing call site reads, and "assigned" is still the default
 * and the only door that can carry `transaction_docs` or `financial`.
 *
 * Fails closed with a spoken-safe reason when:
 *   - a read was REFUSED (an outage is not a "no")
 *   - the user resolves to no vendor row, or to more than one
 *   - the vendor is not active, or is time-boxed out (vendors.access_expires_at)
 *   - NEITHER door is open: no ACTIVE, unexpired vendor_contact_assignment AND
 *     no paid brokerage-wide access within the contact's own tenant
 *   - requiredScopes is set and no open door confers one of them
 *
 * @param svc     a service-role Supabase client (RLS-independent)
 * @param params  vendorUserId = the caller's users.id; contactId = target contact;
 *                requiredScopes = if set, at least one open door must confer one
 *                of these scopes (e.g. ['financial'] for financial confirmation —
 *                which the paid door never confers; see PAID_ACCESS_GRANTED_SCOPES).
 */
export async function assertVendorAssignedToContact(
  svc: SupabaseClient,
  params: { vendorUserId: string; contactId: string; requiredScopes?: VendorAccessScope[] },
): Promise<VendorAssignmentCheck> {
  const { vendorUserId, contactId, requiredScopes } = params

  const facts = await readVendorContactAccessFacts(svc, { vendorUserId, contactId, requiredScopes })
  const verdict = vendorContactAccessVerdict(facts)
  if (!verdict.ok) return { ok: false, reason: verdict.reason, error: verdict.error }
  return { ok: true, vendorId: facts.vendorId!, scope: verdict.scope, door: verdict.door }
}

/**
 * Gather the facts the verdict needs. Every read is error-checked and a refusal
 * sets `resolved: false` rather than degrading to an empty result — CLAUDE.md §3
 * (supabase-js RESOLVES refusals) and §4 (fail closed). This is an access gate:
 * a read that did not happen must never be spoken as a settled "no".
 */
export async function readVendorContactAccessFacts(
  svc: SupabaseClient,
  params: { vendorUserId: string; contactId: string; requiredScopes?: VendorAccessScope[] },
): Promise<VendorContactAccessFacts> {
  const { vendorUserId, contactId, requiredScopes } = params
  const unresolved: VendorContactAccessFacts = {
    resolved: false,
    vendorId: null,
    vendorStatus: null,
    vendorAccessExpiresAt: null,
    vendorAccessLevel: null,
    vendorBrokerageId: null,
    contactBrokerageId: null,
    assignments: [],
    requiredScopes,
  }

  // 1. Resolve caller → vendor row (same lookup the scoped vendor portal uses).
  //
  // "Which vendor is this user?" — asked of a table that is UNIQUE on
  // (user_id, role), NOT on user_id. `.not("vendor_id","is",null).maybeSingle()`
  // narrowed to the vendor-bearing grants but not to ONE of them, so a user
  // holding two vendor-bearing grants under different roles made this an ERROR
  // that supabase-js resolves — and this gate, reading `data` alone, would refuse
  // a genuinely assigned vendor with "Not a vendor account". This is an access
  // gate: a refused read must never be spoken as a settled "no".
  const grantsResult = await readRoleGrants(svc, vendorUserId)
  if (!grantsResult.ok) {
    console.error("[vendor/assignment-access] role grant read failed:", grantsResult.error)
    return unresolved
  }
  const { vendorId, ambiguous } = selectVendorId(grantsResult.grants)
  if (ambiguous) return { ...unresolved, resolved: true, ambiguousVendor: true }
  if (!vendorId) return { ...unresolved, resolved: true }

  // 2. The vendor row: the whole-vendor time box (l49-s01), its status, and the
  //    PAID door (access_level + the tenant it is scoped to).
  const { data: vendor, error: vendorErr } = await svc
    .from("vendors")
    .select("access_expires_at, status, access_level, brokerage_id")
    .eq("id", vendorId)
    .maybeSingle()
  if (vendorErr) {
    console.error("[vendor/assignment-access] vendor read failed:", vendorErr)
    return unresolved
  }
  // A vendor row that is genuinely absent is a settled answer, not an outage:
  // there is no vendor, so there is no door. Distinct from the refused read above.
  if (!vendor) return { ...unresolved, resolved: true }

  // 3. The CONTACT's tenant. Door 2 is bench-wide WITHIN one brokerage and must
  //    never reach across tenants (CLAUDE.md §4), so this comparison is the
  //    tenant boundary on the paid lane and nothing else is.
  const { data: contact, error: contactErr } = await svc
    .from("contacts")
    .select("brokerage_id")
    .eq("id", contactId)
    .maybeSingle()
  if (contactErr) {
    console.error("[vendor/assignment-access] contact read failed:", contactErr)
    return unresolved
  }

  // 4. EVERY assignment row for (vendor, contact) — revoked and expired ones
  //    INCLUDED on purpose. The rule does the filtering, so the filtering is what
  //    the guard can mutation-test. Filtering here instead would put the part
  //    that matters most out of reach of a unit test.
  const { data: rows, error: rowsErr } = await svc
    .from("vendor_contact_assignments")
    .select("scope, status, expires_at")
    .eq("vendor_id", vendorId)
    .eq("contact_id", contactId)
  if (rowsErr) {
    console.error("[vendor/assignment-access] assignment read failed:", rowsErr)
    return unresolved
  }

  return {
    resolved: true,
    vendorId,
    vendorStatus: (vendor.status as string) ?? null,
    vendorAccessExpiresAt: (vendor.access_expires_at as string) ?? null,
    vendorAccessLevel: (vendor.access_level as string) ?? null,
    vendorBrokerageId: (vendor.brokerage_id as string) ?? null,
    contactBrokerageId: (contact?.brokerage_id as string) ?? null,
    assignments: (rows ?? []).map((r: any) => ({
      scope: r.scope,
      status: r.status,
      expires_at: r.expires_at ?? null,
    })),
    requiredScopes,
  }
}
