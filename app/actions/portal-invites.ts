"use server"

import { createClient } from "@/lib/supabase/server"
import { issuePortalInvite } from "@/lib/portal/portal-invite-core"

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

