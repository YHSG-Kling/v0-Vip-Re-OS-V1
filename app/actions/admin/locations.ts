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
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import { pickUserOffice } from "@/lib/kernel/resolve-user-office"

const ADMIN_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead"])

async function requireAdmin(): Promise<
  | { ok: true; brokerageId: string; userType: string }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  if (!ADMIN_ROLES.has(ctx.userType)) return { ok: false, error: "Forbidden" }
  return { ok: true, brokerageId: ctx.brokerageId, userType: ctx.userType }
}

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
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const name = input.name?.trim()
  if (!name) return { ok: false, error: "Office name is required" }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("locations")
    .insert({
      brokerage_id: auth.brokerageId,
      name,
      address: input.address?.trim() || null,
      city: input.city?.trim() || null,
      state: input.state?.trim() || null,
    })
    .select("id")
    .single()
  if (error || !data) return { ok: false, error: error?.message ?? "Could not create office" }
  revalidatePath("/dashboard/admin/locations")
  return { ok: true, id: data.id as string }
}

export async function updateLocationAction(
  id: string,
  patch: { name?: string; address?: string; city?: string; state?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAdmin()
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
  if (Object.keys(update).length === 0) return { ok: true }

  const svc = createServiceClient()
  const { error } = await svc.from("locations").update(update).eq("id", id).eq("brokerage_id", auth.brokerageId)
  if (error) return { ok: false, error: error.message }
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
  await svc.from("users").update({ location_id: null }).eq("location_id", id).eq("brokerage_id", auth.brokerageId)
  await svc.from("agents").update({ location_id: null }).eq("location_id", id).eq("brokerage_id", auth.brokerageId)
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
 */
export async function assignUserToLocationAction(
  userId: string,
  locationId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  if (locationId) {
    const { data: loc, error: locErr } = await svc.from("locations")
      .select("id").eq("id", locationId).eq("brokerage_id", auth.brokerageId).maybeSingle()
    if (locErr) return { ok: false, error: locErr.message }
    if (!loc) return { ok: false, error: "Office not found in your brokerage" }
  }

  // `.eq("brokerage_id", …)` is the tenancy check on the SUBJECT: without it an
  // admin could pin a user from another brokerage into one of their offices.
  const { data: updated, error } = await svc
    .from("users")
    .update({ location_id: locationId })
    .eq("id", userId)
    .eq("brokerage_id", auth.brokerageId)
    .select("id")
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!updated) return { ok: false, error: "User not found in your brokerage" }

  revalidatePath("/dashboard/admin/locations")
  return { ok: true }
}
