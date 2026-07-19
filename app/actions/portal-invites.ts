"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { issuePortalInvite } from "@/lib/portal/portal-invite-core"
import {
  composePortalClientsRead,
  type PortalClientRow,
  type PendingPortalInviteRow,
} from "@/lib/portal/portal-clients-read"

export type { PortalClientRow, PendingPortalInviteRow } from "@/lib/portal/portal-clients-read"

/**
 * User-triggered portal invite (CRM "invite to portal" button). Session-gated: the actor is bound to
 * the logged-in user so a client cannot forge attribution or invite cross-tenant. All invite logic
 * lives in the shared issuePortalInvite core (one implementation — no drift with the system path).
 */
export async function createPortalInviteForContact(params: {
  contactId: string
  brokerageId?: string       // ignored — derived from contact inside the core
  invitedByUserId?: string   // ignored — bound to the session below
  sendMagicLink?: boolean
}): Promise<{ success: boolean; inviteId?: string; error?: string }> {
  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return { success: false, error: "Unauthorized" }

  return issuePortalInvite({
    contactId:       params.contactId,
    invitedByUserId: authUser.id,
    sendMagicLink:   params.sendMagicLink ?? false,
  })
}

// Staff seat roles that may see the tenant's portal-client roster. Mirrors
// SEAT_ROLES (lib/kernel/tier-role-matrix) + legacy aliases — never contacts,
// vendors, or other partner logins.
const ROSTER_ROLES = new Set([
  "admin", "broker", "broker_admin", "team_lead", "agent", "solo_agent",
  "tc", "isa", "compliance_officer", "superadmin",
])

/**
 * The TENANT's own portal-clients roster — the round-31 staff view (god console
 * tenant page), mirrored for the subscriber. Same composition
 * (lib/portal/portal-clients-read.ts), tenant gate instead of the platform
 * capability gate: any working seat of the brokerage, scoped to THEIR tenancy.
 */
export async function listMyPortalClientsAction(): Promise<
  | { ok: true; clients: PortalClientRow[]; pending: PendingPortalInviteRow[] }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const { data: profile } = await supabase
    .from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  const brokerageId = (profile as { brokerage_id?: string | null } | null)?.brokerage_id
  const userType = String((profile as { user_type?: string | null } | null)?.user_type ?? "")
  if (!brokerageId || !ROSTER_ROLES.has(userType)) {
    return { ok: false, error: "Staff access required" }
  }

  const { clients, pending } = await composePortalClientsRead(createServiceClient(), brokerageId)
  return { ok: true, clients, pending }
}

