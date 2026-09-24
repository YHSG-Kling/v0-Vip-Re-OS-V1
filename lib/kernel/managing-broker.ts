// lib/kernel/managing-broker.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE MANAGING BROKER (BROKER OF RECORD) OF A BROKERAGE LOCATION — wave 81A.
//
// OWNER, VERBATIM (2026-09-24): "a broker who is the broker of record for a
// brokerage location has to be producing since that person manages the agents
// of the brokerage. there can only be one managing broker per brokerage
// location."
//
// WHERE THE FACT LIVES: locations.managing_broker_user_id (m661, WRITTEN NOT
// APPLIED) — a scalar column on the office row, so "one per location" is true
// by construction rather than by a second index. The office model already
// existed (public.locations; agents/users/listings/contacts.location_id FK to
// it; app/actions/admin/locations.ts is the office CRUD). A single-office
// tenant has no locations row until it needs one: assigning a managing broker
// MATERIALISES the principal office as one row (name = the brokerage's name,
// address copied from brokerages), so the fact keeps one home (§6).
//
// WHAT IT MEANS FOR SEATS: lib/kernel/tier-role-matrix.ts roleConsumesSeat
// reads `managingBroker: true` as a seat whatever the exemption says, the
// meter (lib/kernel/seat-usage.ts resolveSeatUsage) supplies the fact, and
// setLicensedProducerExemption refuses to exempt a managing broker. Assigning
// one therefore may ADD a producing seat (the person was exempt) — so the
// assignment passes the seat GATE first and refuses over the limit with the
// door's own message; nobody is billed a seat the plan cannot hold.
//
// NOT server-only (the proof drives it with an injected client); only ever
// writes through a caller-supplied service client; the tenant is the CALLER's
// session tenant (§4) — never a parameter a browser could set.

import type { SupabaseClient } from "@supabase/supabase-js"
import { canBeManagingBroker } from "./tier-role-matrix"
import { parseNonProducingUserIds } from "./tier-role-matrix"
import { seatGate, setLicensedProducerExemption } from "./seat-usage"

type Svc = SupabaseClient<any, any, any>

export interface ManagingBrokerSlot {
  /** locations.id — null for a single-office tenant whose principal office is not yet a row. */
  locationId: string | null
  locationName: string
  managingBrokerUserId: string | null
  managingBrokerLabel: string | null
  assignedAt: string | null
}

export interface ManagingBrokerRoster {
  ok: boolean
  error?: string
  slots: ManagingBrokerSlot[]
  /** Eligible people: non-suspended broker / broker_owner of the tenant. */
  eligible: Array<{ userId: string; label: string; role: string }>
}

/** Display name for a users row — name, then email, then a short id. */
function labelOf(u: { id: string; first_name?: string | null; last_name?: string | null; email?: string | null }): string {
  return [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email || u.id.slice(0, 8)
}

/**
 * READ the tenant's offices with their managing broker, plus the eligible
 * roster. A tenant with no locations rows is shown ONE virtual slot (the
 * principal office, locationId null) so the surface can assign into it.
 */
export async function readManagingBrokerRoster(svc: Svc, brokerageId: string): Promise<ManagingBrokerRoster> {
  const [locRes, peopleRes, brkRes] = await Promise.all([
    svc.from("locations").select("id, name, managing_broker_user_id, managing_broker_assigned_at").eq("brokerage_id", brokerageId).order("name"),
    svc.from("users").select("id, first_name, last_name, email, user_type, status").eq("brokerage_id", brokerageId),
    svc.from("brokerages").select("name").eq("id", brokerageId).maybeSingle(),
  ])
  if (locRes.error) return { ok: false, error: `Offices could not be read (${locRes.error.message}).`, slots: [], eligible: [] }
  if (peopleRes.error) return { ok: false, error: `The roster could not be read (${peopleRes.error.message}).`, slots: [], eligible: [] }
  const people = (peopleRes.data ?? []) as Array<{ id: string; first_name?: string | null; last_name?: string | null; email?: string | null; user_type?: string | null; status?: string | null }>
  const byId = new Map(people.map((p) => [p.id, p]))
  const eligible = people
    .filter((p) => p.status !== "suspended" && canBeManagingBroker(p.user_type))
    .map((p) => ({ userId: p.id, label: labelOf(p), role: String(p.user_type ?? "") }))
  const rows = (locRes.data ?? []) as Array<{ id: string; name: string | null; managing_broker_user_id: string | null; managing_broker_assigned_at: string | null }>
  const brokerageName = ((brkRes.data as { name?: string | null } | null)?.name ?? "").trim() || "Principal office"
  const slots: ManagingBrokerSlot[] = rows.length > 0
    ? rows.map((r) => {
        const mb = r.managing_broker_user_id ? byId.get(r.managing_broker_user_id) ?? null : null
        return {
          locationId: r.id,
          locationName: r.name || r.id.slice(0, 8),
          managingBrokerUserId: r.managing_broker_user_id,
          managingBrokerLabel: mb ? labelOf(mb) : r.managing_broker_user_id ? "(not on the roster)" : null,
          assignedAt: r.managing_broker_assigned_at,
        }
      })
    : [{ locationId: null, locationName: brokerageName, managingBrokerUserId: null, managingBrokerLabel: null, assignedAt: null }]
  return { ok: true, slots, eligible }
}

export type AssignManagingBrokerResult =
  | { ok: true; locationId: string; userId: string | null; seatAdded: boolean; principalOfficeCreated: boolean }
  | { ok: false; reason: "not_eligible" | "user_not_in_tenant" | "office_not_in_tenant" | "unreadable" | "seat_limit" | "write_refused"; error: string }

/**
 * ASSIGN (or clear, userId null) the managing broker of ONE office of the
 * caller's tenant. Gate first, then the service client:
 *   · the person is on THIS tenant and typed broker / broker_owner
 *   · if they are currently EXEMPT (non-producing), the seat gate must admit
 *     one more producer — a managing broker is always a seat — and the
 *     exemption is cleared through the ONE writer (never by editing the list)
 *   · the office is THIS tenant's (or the principal office is created when the
 *     tenant has none and locationId is null)
 *   · the UPDATE is counted (§3): 0 rows is a refusal, not a success
 */
export async function assignManagingBroker(
  svc: Svc,
  params: { brokerageId: string; locationId: string | null; userId: string | null; actorUserId: string | null },
): Promise<AssignManagingBrokerResult> {
  const { brokerageId, actorUserId } = params
  const userId = params.userId ? String(params.userId).trim() : null
  let seatAdded = false

  if (userId) {
    const { data: user, error: userErr } = await svc
      .from("users").select("id, user_type, brokerage_id, status").eq("id", userId).eq("brokerage_id", brokerageId).maybeSingle()
    if (userErr) return { ok: false, reason: "unreadable", error: `The person could not be read (${userErr.message}); no managing broker was assigned.` }
    if (!user) return { ok: false, reason: "user_not_in_tenant", error: "That person is not on this workspace; no managing broker was assigned." }
    const role = String((user as { user_type?: string | null }).user_type ?? "")
    if (!canBeManagingBroker(role)) {
      return { ok: false, reason: "not_eligible", error: `Only a broker or broker owner can be an office's managing broker (this person is '${role || "untyped"}').` }
    }
    if ((user as { status?: string | null }).status === "suspended") {
      return { ok: false, reason: "not_eligible", error: "A suspended user cannot be an office's managing broker." }
    }
    // Exempt today? Then this assignment ADDS a producing seat — the gate decides.
    const { data: tenant, error: tenantErr } = await svc.from("brokerages").select("billing_metadata").eq("id", brokerageId).maybeSingle()
    if (tenantErr) return { ok: false, reason: "unreadable", error: `The workspace's billing record could not be read (${tenantErr.message}); no managing broker was assigned.` }
    const exempt = parseNonProducingUserIds((tenant as { billing_metadata?: unknown } | null)?.billing_metadata)
    if (exempt.has(userId)) {
      const verdict = await seatGate(svc, brokerageId, role, { seatsRequested: 1, produces: true })
      if (!verdict.allowed) {
        return { ok: false, reason: "seat_limit", error: `A managing broker must hold a producing seat and this person is marked non-producing today. ${verdict.message ?? "The plan has no seat for them."}` }
      }
      const cleared = await setLicensedProducerExemption(svc, brokerageId, userId, false)
      if (!cleared.ok) return { ok: false, reason: "write_refused", error: `Their non-producing exemption could not be cleared (${cleared.error}); no managing broker was assigned.` }
      seatAdded = true
    }
  }

  // The office: an existing row of THIS tenant, or the principal office materialised.
  let locationId = params.locationId
  let principalOfficeCreated = false
  if (locationId) {
    const { data: office, error: officeErr } = await svc.from("locations").select("id").eq("id", locationId).eq("brokerage_id", brokerageId).maybeSingle()
    if (officeErr) return { ok: false, reason: "unreadable", error: `The office could not be read (${officeErr.message}); no managing broker was assigned.` }
    if (!office) return { ok: false, reason: "office_not_in_tenant", error: "That office is not in this workspace; no managing broker was assigned." }
  } else {
    const { data: existing, error: existingErr } = await svc.from("locations").select("id").eq("brokerage_id", brokerageId).order("created_at").limit(1)
    if (existingErr) return { ok: false, reason: "unreadable", error: `Offices could not be read (${existingErr.message}); no managing broker was assigned.` }
    const first = ((existing ?? []) as Array<{ id: string }>)[0]
    if (first) {
      locationId = first.id
    } else {
      if (!userId) return { ok: true, locationId: "", userId: null, seatAdded: false, principalOfficeCreated: false }
      const { data: brk, error: brkErr } = await svc.from("brokerages").select("name, address, city, license_state").eq("id", brokerageId).maybeSingle()
      if (brkErr) return { ok: false, reason: "unreadable", error: `The brokerage could not be read (${brkErr.message}); no managing broker was assigned.` }
      const b = (brk ?? {}) as { name?: string | null; address?: string | null; city?: string | null; license_state?: string | null }
      const { data: created, error: createErr } = await svc.from("locations").insert({
        brokerage_id: brokerageId,
        name: (b.name ?? "").trim() || "Principal office",
        address: b.address ?? null, city: b.city ?? null, state: b.license_state ?? null,
      }).select("id")
      if (createErr) return { ok: false, reason: "write_refused", error: `The principal office could not be created (${createErr.message}); no managing broker was assigned.` }
      const row = ((created ?? []) as Array<{ id: string }>)[0]
      if (!row) return { ok: false, reason: "write_refused", error: "The principal office was not created (0 rows); no managing broker was assigned." }
      locationId = row.id
      principalOfficeCreated = true
    }
  }

  const nowIso = new Date().toISOString()
  const { data: written, error: writeErr } = await svc
    .from("locations")
    .update({
      managing_broker_user_id: userId,
      managing_broker_assigned_at: userId ? nowIso : null,
      managing_broker_assigned_by: userId ? actorUserId : null,
    })
    .eq("id", locationId).eq("brokerage_id", brokerageId)
    .select("id")
  if (writeErr) return { ok: false, reason: "write_refused", error: `The managing broker could not be saved (${writeErr.message}).` }
  if ((written ?? []).length !== 1) return { ok: false, reason: "write_refused", error: "The managing broker was not saved: the office row did not match (0 rows updated)." }

  // Audited on the lifecycle ledger (the same ledger coverage / deactivation use).
  const { error: auditErr } = await svc.from("lifecycle_events").insert({
    brokerage_id: brokerageId, entity_type: "location", entity_id: locationId,
    event_type: userId ? "managing_broker_assigned" : "managing_broker_cleared",
    actor_user_id: actorUserId,
    metadata: { managing_broker_user_id: userId, seat_added: seatAdded, principal_office_created: principalOfficeCreated },
    created_at: nowIso,
  })
  if (auditErr) console.warn("[managing-broker] audit insert refused:", auditErr.message)

  return { ok: true, locationId: locationId as string, userId, seatAdded, principalOfficeCreated }
}

/**
 * PURE readiness verdict — the setup-readiness item reads it: every office
 * has a managing broker, and there is at least one office (a tenant with no
 * locations row and no assignment has NO broker of record on file).
 */
export function managingBrokerReadiness(offices: Array<{ managing_broker_user_id: string | null }>): {
  ready: boolean
  offices: number
  unassigned: number
} {
  const unassigned = offices.filter((o) => !o.managing_broker_user_id).length
  return { ready: offices.length > 0 && unassigned === 0, offices: offices.length, unassigned }
}
