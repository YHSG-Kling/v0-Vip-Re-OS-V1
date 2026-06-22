"use server"

/**
 * app/actions/admin/locations.ts
 *
 * Multi-location (office) management for a brokerage. The schema already supported
 * it — a `locations` table (brokerage_id, name, address, city, state) and
 * `agents.location_id` FK → locations — but there was no UI or actions, so a
 * multi-office brokerage couldn't model its offices or place agents in them.
 * This wires office CRUD + agent↔office assignment to those live tables.
 *
 * All writes are brokerage-scoped and admin-gated (broker / broker_admin / admin /
 * superadmin / team_lead), identity resolved server-side.
 */

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"

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

  const [{ data: locs, error }, { data: agents }] = await Promise.all([
    svc.from("locations").select("id, name, address, city, state, created_at").eq("brokerage_id", auth.brokerageId).order("name"),
    svc.from("agents").select("id, location_id").eq("brokerage_id", auth.brokerageId),
  ])
  if (error) return { ok: false, error: error.message }

  const counts = new Map<string, number>()
  let unassigned = 0
  for (const a of agents ?? []) {
    const lid = (a.location_id as string | null) ?? null
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
  // Unassign first so no agent is orphaned by a dangling FK reference.
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
}

export async function listBrokerageAgentsAction(): Promise<
  { ok: true; agents: BrokerageAgentRow[] } | { ok: false; error: string }
> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("agents")
    .select("id, location_id, users:user_id ( first_name, last_name, email )")
    .eq("brokerage_id", auth.brokerageId)
    .limit(500)
  if (error) return { ok: false, error: error.message }

  const agents: BrokerageAgentRow[] = (data ?? []).map((a: Record<string, unknown>) => {
    const u = Array.isArray(a.users) ? a.users[0] : (a.users as Record<string, unknown> | null)
    const name = [u?.first_name, u?.last_name].filter(Boolean).join(" ") || "Unnamed agent"
    return {
      id: a.id as string,
      name,
      email: (u?.email as string | null) ?? null,
      locationId: (a.location_id as string | null) ?? null,
    }
  })
  return { ok: true, agents }
}

/** Place an agent in an office (or pass null to move them to Unassigned). Both must belong to the brokerage. */
export async function assignAgentToLocationAction(
  agentId: string,
  locationId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  if (locationId) {
    const { data: loc } = await svc.from("locations").select("id").eq("id", locationId).eq("brokerage_id", auth.brokerageId).maybeSingle()
    if (!loc) return { ok: false, error: "Office not found in your brokerage" }
  }
  const { error } = await svc
    .from("agents")
    .update({ location_id: locationId })
    .eq("id", agentId)
    .eq("brokerage_id", auth.brokerageId)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/dashboard/admin/locations")
  return { ok: true }
}
