"use server"

// app/actions/managing-broker.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE TENANT'S DOOR TO ITS OFFICES' MANAGING BROKERS (wave 81A, owner verbatim
// 2026-09-24: "there can only be one managing broker per brokerage location"
// … "has to be producing"). Two exports, both public HTTP endpoints (§4):
//   · listManagingBrokerSlotsAction — the offices with their broker of record
//     plus the eligible roster
//   · setManagingBrokerAction — assign / clear one office's managing broker
// Tenant from the SESSION; gate = the commerce-admin class (an assignment can
// ADD a producing seat, so it may obligate the brokerage to pay — the same
// class the seat door uses); the kernel does the counted writes and the audit.
// Mounted by app/dashboard/admin/billing/seat-door-card.tsx.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { TENANT_COMMERCE_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { assignManagingBroker, readManagingBrokerRoster, type ManagingBrokerRoster } from "@/lib/kernel/managing-broker"

async function requireTenantCommerceAdmin(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data: u, error } = await supabase.from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (error) return { ok: false, error: `Managing-broker door could not read your account: ${error.message}` }
  if (!u?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  if (!TENANT_COMMERCE_ADMIN_USER_TYPES.has(String((u as { user_type?: string | null }).user_type ?? "").toLowerCase())) {
    return { ok: false, error: "Only a broker, owner, admin or team lead can assign an office's managing broker" }
  }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id as string }
}

export async function listManagingBrokerSlotsAction(): Promise<ManagingBrokerRoster> {
  const auth = await requireTenantCommerceAdmin()
  if (!auth.ok) return { ok: false, error: auth.error, slots: [], eligible: [] }
  return readManagingBrokerRoster(createServiceClient(), auth.brokerageId)
}

export async function setManagingBrokerAction(input: { locationId: string | null; userId: string | null }): Promise<
  | { ok: true; locationId: string; seatAdded: boolean; principalOfficeCreated: boolean }
  | { ok: false; error: string }
> {
  const auth = await requireTenantCommerceAdmin()
  if (!auth.ok) return auth
  const res = await assignManagingBroker(createServiceClient(), {
    brokerageId: auth.brokerageId,
    locationId: input?.locationId ? String(input.locationId) : null,
    userId: input?.userId ? String(input.userId) : null,
    actorUserId: auth.userId,
  })
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, locationId: res.locationId, seatAdded: res.seatAdded, principalOfficeCreated: res.principalOfficeCreated }
}
