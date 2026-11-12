"use server"

/**
 * app/actions/admin/locations.ts
 *
 * Multi-location (office) management for a brokerage. The schema already supported
 * it — a `locations` table (brokerage_id, name, address, city, state) and
 * `agents.location_id` FK → locations — but there was no UI or actions, so a
 * multi-office brokerage couldn't model its offices or place agents in them.
 * This wires office CRUD + person↔office assignment to those live tables.
 *
 * THE OFFICE NOW LIVES ON `users.location_id` (m423). It used to live only on
 * `agents.location_id`, which meant this screen could not place the very person
 * it exists for: requiresAgentRow() deliberately gives a pure-admin owner of a
 * brokerage / multi_location tenant NO agents row, so the office admin that
 * resolveEgressScope implements was unreachable on the one tier that has
 * offices. Reads go through pickUserOffice, which prefers the person's office
 * and falls back to their agent record.
 *
 * All writes are brokerage-scoped and admin-gated (broker / broker_admin / admin /
 * superadmin / team_lead), identity resolved server-side.
 */

import { revalidatePath } from "next/cache"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import { pickUserOffice, resolveViewerHierarchy } from "@/lib/kernel/resolve-user-office"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

/**
 * THE OFFICE GATE (wave 150, lane 150Z — lane 150C Outside-lane 2, C34). The role check is the floor; the SCOPE is the
 * C34 hierarchy (resolveViewerHierarchy, session ids only): the whole-tenant office roster — list, create, delete, place
 * people — needs the aggregated view (a tenant leadership grant, or the single-office roster admin); editing ONE office's
 * identity is also open to that office's own leadership (`officeId` in scope.locationIds). A user_type alone never
 * widens a multi-location tenant. Fail closed: an unreadable hierarchy refuses.
 */
async function requireAdmin(opts: { officeId?: string } = {}): Promise<
  | { ok: true; brokerageId: string; userType: string; userId: string }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  if (!isAdminOrBroker({ user_type: ctx.userType })) return { ok: false, error: "Forbidden" }
  const h = await resolveViewerHierarchy(createServiceClient() as never, { userId: ctx.userId, brokerageId: ctx.brokerageId })
  if (!h.ok) return { ok: false, error: `Your office scope could not be read (${h.error}) — refused.` }
  const mayAct = h.scope.aggregate || (!!opts.officeId && h.scope.locationIds.includes(opts.officeId))
  if (!mayAct) return { ok: false, error: opts.officeId ? "That office is outside your scope." : "Managing every office needs tenant leadership." }
  return { ok: true, brokerageId: ctx.brokerageId, userType: ctx.userType, userId: ctx.userId }
}

const trimOr = (v: unknown, max = 160): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null)

export interface OfficeLocation {
  id: string
  name: string
  address: string | null
  city: string | null
  state: string | null
  agentCount: number
  createdAt: string
}

export async function listLocationsAction(): Promise<
  { ok: true; locations: OfficeLocation[]; unassignedCount: number } | { ok: false; error: string }
> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  // Headcount is counted over the SAME population the roster below lists —
  // brokerage users, office resolved by pickUserOffice — not over `agents`. When
  // this counted agents and the roster listed users the two disagreed by however
  // many people had no agents row, and a headcount that contradicts the list
  // under it is worse than no headcount.
  const [{ data: locs, error }, { data: people }, { data: agentOffices }] = await Promise.all([
    svc.from("locations").select("id, name, address, city, state, created_at").eq("brokerage_id", auth.brokerageId).order("name"),
    svc.from("users").select("id, location_id").eq("brokerage_id", auth.brokerageId)
      .not("user_type", "in", "(contact,vendor,lender,system)"),
    svc.from("agents").select("user_id, location_id").eq("brokerage_id", auth.brokerageId),
  ])
  if (error) return { ok: false, error: error.message }

  const agentOfficeByUser = new Map<string, string | null>()
  for (const a of (agentOffices ?? []) as Array<{ user_id: string | null; location_id: string | null }>) {
    if (a.user_id) agentOfficeByUser.set(a.user_id, a.location_id)
  }

  const counts = new Map<string, number>()
  let unassigned = 0
  for (const p of (people ?? []) as Array<{ id: string; location_id: string | null }>) {
    const lid = pickUserOffice(p.location_id, agentOfficeByUser.get(p.id) ?? null).locationId
    if (lid) counts.set(lid, (counts.get(lid) ?? 0) + 1)
    else unassigned += 1
  }

  return {
    ok: true,
    unassignedCount: unassigned,
    locations: (locs ?? []).map((l: Record<string, unknown>) => ({
      id: l.id as string,
      name: l.name as string,
      address: (l.address as string | null) ?? null,
      city: (l.city as string | null) ?? null,
      state: (l.state as string | null) ?? null,
      agentCount: counts.get(l.id as string) ?? 0,
      createdAt: l.created_at as string,
    })),
  }
}

export async function createLocationAction(input: {
  name: string
  address?: string
  city?: string
  state?: string
  /** C34 office identity (m957): the office's own legal identity, license and seat ownership. */
  legalName?: string
  dba?: string
  licenseNumber?: string
  licenseState?: string
  seatCap?: number | null
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const name = input.name?.trim()
  if (!name) return { ok: false, error: "Office name is required" }
  const licenseState = trimOr(input.licenseState, 2)?.toUpperCase() ?? null
  if (licenseState && !/^[A-Z]{2}$/.test(licenseState)) return { ok: false, error: "License state must be a two-letter US state code" }
  if (input.seatCap !== undefined && input.seatCap !== null && (!Number.isInteger(input.seatCap) || input.seatCap < 0)) return { ok: false, error: "Seat ownership must be a whole number of seats (0 or more)" }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("locations")
    .insert({
      brokerage_id: auth.brokerageId,
      name,
      address: input.address?.trim() || null,
      city: input.city?.trim() || null,
      state: input.state?.trim() || null,
      // The office's idempotency key inside the tenant (m957 UNIQUE (brokerage_id, office_code)) — never the name.
      office_code: `office-${crypto.randomUUID().slice(0, 8)}`,
      created_by_user_id: auth.userId,
      legal_name: trimOr(input.legalName),
      dba: trimOr(input.dba),
      license_number: trimOr(input.licenseNumber, 64),
      license_state: licenseState,
      seat_cap: input.seatCap ?? null,
      status: "active",
    })
    .select("id")
    .single()
  if (error || !data) return { ok: false, error: error?.message ?? "Could not create office" }
  revalidatePath("/dashboard/admin/locations")
  return { ok: true, id: data.id as string }
}

export async function updateLocationAction(
  id: string,
  patch: {
    name?: string; address?: string; city?: string; state?: string
    /** C34 office identity (m957). */
    legalName?: string; dba?: string; licenseNumber?: string; licenseState?: string
    territories?: string[]; brandOverrides?: Record<string, unknown>; settings?: Record<string, unknown>
    seatCap?: number | null; status?: "active" | "archived"
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAdmin({ officeId: id })
  if (!auth.ok) return auth
  const update: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    const n = patch.name.trim()
    if (!n) return { ok: false, error: "Office name cannot be empty" }
    update.name = n
  }
  if (patch.address !== undefined) update.address = patch.address.trim() || null
  if (patch.city !== undefined) update.city = patch.city.trim() || null
  if (patch.state !== undefined) update.state = patch.state.trim() || null
  if (patch.legalName !== undefined) update.legal_name = trimOr(patch.legalName)
  if (patch.dba !== undefined) update.dba = trimOr(patch.dba)
  if (patch.licenseNumber !== undefined) update.license_number = trimOr(patch.licenseNumber, 64)
  if (patch.licenseState !== undefined) {
    const ls = trimOr(patch.licenseState, 2)?.toUpperCase() ?? null
    if (ls && !/^[A-Z]{2}$/.test(ls)) return { ok: false, error: "License state must be a two-letter US state code" }
    update.license_state = ls
  }
  if (patch.territories !== undefined) {
    if (!Array.isArray(patch.territories)) return { ok: false, error: "Territories must be a list" }
    update.territories = patch.territories.map((t) => String(t).trim()).filter(Boolean).slice(0, 200)
  }
  if (patch.brandOverrides !== undefined) {
    if (!patch.brandOverrides || typeof patch.brandOverrides !== "object" || Array.isArray(patch.brandOverrides)) return { ok: false, error: "Brand overrides must be an object" }
    update.brand_overrides = patch.brandOverrides
  }
  if (patch.settings !== undefined) {
    if (!patch.settings || typeof patch.settings !== "object" || Array.isArray(patch.settings)) return { ok: false, error: "Office settings must be an object" }
    update.settings = patch.settings
  }
  if (patch.seatCap !== undefined) {
    if (patch.seatCap !== null && (!Number.isInteger(patch.seatCap) || patch.seatCap < 0)) return { ok: false, error: "Seat ownership must be a whole number of seats (0 or more)" }
    update.seat_cap = patch.seatCap
  }
  // locations.status CHECK (m957, scripts/check-vocabularies.ts): active | archived.
  if (patch.status !== undefined) {
    if (patch.status !== "active" && patch.status !== "archived") return { ok: false, error: "Office status must be active or archived" }
    update.status = patch.status
  }
  if (Object.keys(update).length === 0) return { ok: true }
  update.updated_at = new Date().toISOString()

  const svc = createServiceClient()
  const { data: changed, error } = await svc.from("locations").update(update).eq("id", id).eq("brokerage_id", auth.brokerageId).select("id")
  if (error) return { ok: false, error: error.message }
  if ((changed ?? []).length !== 1) return { ok: false, error: "Office not found in your workspace" }
  revalidatePath("/dashboard/admin/locations")
  return { ok: true }
}

/** Delete an office. Agents assigned to it are first moved to Unassigned (location_id null). */
export async function deleteLocationAction(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  // Unassign BOTH office columns first so nobody is left pointing at a deleted
  // office. users.location_id is ON DELETE SET NULL at the FK, so the database
  // would handle that one — this is explicit anyway because agents.location_id
  // is the pre-m423 column and is not covered by that FK behaviour, and because
  // clearing them in the same place keeps the two from drifting.
  // Either refusal leaves people pointing at an office about to be deleted — stop
  // before the delete rather than strand them.
  const { error: usersUnassignErr } = await svc.from("users").update({ location_id: null }).eq("location_id", id).eq("brokerage_id", auth.brokerageId)
  if (usersUnassignErr) return { ok: false, error: `Could not unassign users from this office: ${usersUnassignErr.message}` }
  const { error: agentsUnassignErr } = await svc.from("agents").update({ location_id: null }).eq("location_id", id).eq("brokerage_id", auth.brokerageId)
  if (agentsUnassignErr) return { ok: false, error: `Could not unassign agents from this office: ${agentsUnassignErr.message}` }
  const { error } = await svc.from("locations").delete().eq("id", id).eq("brokerage_id", auth.brokerageId)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/dashboard/admin/locations")
  return { ok: true }
}

export interface BrokerageAgentRow {
  id: string
  name: string
  email: string | null
  locationId: string | null
  /**
   * `users.id`. The office is written HERE, not on the agents row — see
   * assignUserToLocationAction. Present on every person in the brokerage,
   * including the ones with no agents row at all.
   */
  userId: string
  role: string
  /**
   * false when this person has no `agents` row. NOT a defect and NOT hidden:
   * requiresAgentRow() deliberately withholds one from a pure-admin owner of a
   * brokerage / multi_location tenant, and from tc / compliance_officer style
   * roles. Measured on the live database when this was written: 8 of 13
   * non-client users, including 2 of 3 admins. Listing agents ONLY — which is
   * what this action used to do — hid most of the brokerage from the office
   * assignment UI, and hid the office ADMIN in particular, who is the entire
   * reason office scoping exists.
   */
  hasAgentRecord: boolean
}

export async function listBrokerageAgentsAction(): Promise<
  { ok: true; agents: BrokerageAgentRow[] } | { ok: false; error: string }
> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  // DRIVEN OFF `users`, NOT `agents`. This used to select from `agents`, which
  // meant the roster silently showed only the people who happen to have an
  // agents row — and requiresAgentRow() withholds one from exactly the person
  // this screen exists for: the admin of a multi_location brokerage, who owns
  // no listings and therefore gets no agents row. `agents` is now a LEFT-JOIN
  // lookup for the legacy office value, not the source of the roster.
  const [{ data: userRows, error }, { data: agentRows }] = await Promise.all([
    svc.from("users")
      .select("id, first_name, last_name, email, user_type, location_id")
      .eq("brokerage_id", auth.brokerageId)
      .not("user_type", "in", "(contact,vendor,lender,system)")
      .limit(500),
    svc.from("agents")
      .select("id, user_id, location_id")
      .eq("brokerage_id", auth.brokerageId)
      .limit(500),
  ])
  if (error) return { ok: false, error: error.message }

  const agentByUser = new Map<string, { id: string; location_id: string | null }>()
  for (const a of (agentRows ?? []) as Array<{ id: string; user_id: string | null; location_id: string | null }>) {
    if (a.user_id) agentByUser.set(a.user_id, { id: a.id, location_id: a.location_id })
  }

  const agents: BrokerageAgentRow[] = ((userRows ?? []) as Array<Record<string, unknown>>).map((u) => {
    const userId = u.id as string
    const agent = agentByUser.get(userId)
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || "Unnamed user"
    return {
      // `id` stays the AGENT id where one exists so existing callers keep
      // working; it falls back to the user id for people who have none.
      id: agent?.id ?? userId,
      userId,
      name,
      email: (u.email as string | null) ?? null,
      role: (u.user_type as string | null) ?? "user",
      hasAgentRecord: !!agent,
      // Same precedence the scope resolver uses: the office set on the person
      // wins over the one on their agent record.
      locationId: pickUserOffice(
        (u.location_id as string | null) ?? null,
        agent?.location_id ?? null,
      ).locationId,
    }
  })
  return { ok: true, agents }
}

/**
 * Place a PERSON in an office (or pass null to move them to Unassigned). Both
 * must belong to the caller's brokerage.
 *
 * WRITES `users.location_id`, which is why this takes a userId. It used to take
 * an agentId and write `agents.location_id`, and that could not place the one
 * person the feature exists for: a pure-admin on a brokerage / multi_location
 * tenant has no agents row (requiresAgentRow), so there was no row to update
 * and the office admin `resolveEgressScope` implements was unreachable.
 *
 * `agents.location_id` is left alone rather than dual-written. Two columns
 * holding the same fact is how they start disagreeing; the read side
 * (pickUserOffice) already prefers this one and falls back to the agent row for
 * anyone provisioned before m423.
 *
 * THE PIN AND THE PLACEMENT ARE ONE ACT (wave 151, lane 151A). Since m958 the
 * hierarchy's placements are `organization_members` rows (lib/kernel/
 * resolve-user-office.ts reads them; Settings → Offices lists them), and this
 * door wrote only the pin — so a person moved here was counted against the
 * office's seats (locationSeatGate counts pins) while "People placed here"
 * never listed them, and their old office kept its placement row active. It
 * now goes through THE ONE placement (lib/kernel/tenant-creation.ts
 * provisionTenantStructure, `reassign: true`): the office seat gate runs, the
 * other office placements are revoked with the actor as evidence, the pin is
 * written and the membership recorded. Unassigning (null) revokes the office
 * and office-team placements and clears the pin — counted. Scope: the office
 * must be inside the caller's hierarchy (an office head places into their own
 * office; a move out of another office needs the aggregated view, which
 * requireAdmin without an officeId already demands).
 */
export async function assignUserToLocationAction(
  userId: string,
  locationId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAdmin(locationId ? { officeId: locationId } : {})
  if (!auth.ok) return auth
  const svc = createServiceClient()

  // `.eq("brokerage_id", …)` is the tenancy check on the SUBJECT: without it an
  // admin could pin a user from another brokerage into one of their offices.
  const { data: person, error: personErr } = await svc.from("users")
    .select("id, user_type, location_id").eq("id", userId).eq("brokerage_id", auth.brokerageId).maybeSingle()
  if (personErr) return { ok: false, error: personErr.message }
  const subject = person as { id: string; user_type: string | null; location_id: string | null } | null
  if (!subject) return { ok: false, error: "User not found in your brokerage" }

  const { revokeScopeMemberships, provisionTenantStructure } = await import("@/lib/kernel/tenant-creation")

  if (!locationId) {
    // Unassign: end the office (and office-team) placements, then clear the pin — both counted.
    const revoked = await revokeScopeMemberships(svc, {
      brokerageId: auth.brokerageId, userId: subject.id, actorUserId: auth.userId, scopes: ["location", "team"],
      evidence: { reason: "unassigned", granted_via: "admin_locations" },
    })
    if (!revoked.ok) return { ok: false, error: `The person's office placements could not be ended: ${revoked.error}` }
    const { data: updated, error } = await svc.from("users").update({ location_id: null }).eq("id", subject.id).eq("brokerage_id", auth.brokerageId).select("id")
    if (error) return { ok: false, error: error.message }
    if ((updated ?? []).length !== 1) return { ok: false, error: "User not found in your brokerage" }
    revalidatePath("/dashboard/admin/locations")
    return { ok: true }
  }

  // A move out of another office needs the aggregated view (requireAdmin above admitted an office head for THEIR
  // office only; the person's current office must then be that same office or none).
  if (subject.location_id && subject.location_id !== locationId) {
    const whole = await requireAdmin()
    if (!whole.ok) return { ok: false, error: "That person works out of another office — moving them needs tenant leadership." }
  }

  const { data: tenant, error: tierErr } = await svc.from("brokerages").select("plan_tier, name").eq("id", auth.brokerageId).maybeSingle()
  if (tierErr || !tenant) return { ok: false, error: `Your workspace's plan could not be read${tierErr ? ` (${tierErr.message})` : ""} — nothing was changed.` }
  const t = tenant as { plan_tier: string | null; name: string | null }
  const rec = await provisionTenantStructure(svc, {
    brokerageId: auth.brokerageId, tier: t.plan_tier ?? "", ownerUserId: auth.userId, brokerageName: t.name ?? "", actorUserId: auth.userId,
    source: "admin_grant", evidence: { granted_via: "admin_locations", mode: "move" },
    input: { members: [{ existingUserId: subject.id, userType: subject.user_type ?? "agent", locationId, reassign: true }] },
  })
  if (!rec.complete) return { ok: false, error: rec.errors.join("; ") || "The placement was refused." }

  revalidatePath("/dashboard/admin/locations")
  return { ok: true }
}
