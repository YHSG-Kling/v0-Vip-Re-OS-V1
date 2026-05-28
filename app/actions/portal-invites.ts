"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { randomUUID } from "crypto"

export async function createPortalInviteForContact(params: {
  contactId: string
  brokerageId?: string  // ignored — derived from contact + verified against session
  invitedByUserId?: string  // ignored — derived from session
  sendMagicLink?: boolean
}): Promise<{ success: boolean; inviteId?: string; error?: string }> {
  const { contactId, sendMagicLink = false } = params

  // Auth gate — previously open. Any caller could create portal invites
  // for any contact in any brokerage, with arbitrary brokerageId stamping
  // and forged "invited_by" attribution. The magic-link path even sent
  // real auth-OTP emails to those contacts' addresses.
  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return { success: false, error: "Unauthorized" }

  const supabase = createServiceClient()

  // 1. Load contact
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, email, first_name, contact_type, contact_persona, brokerage_id")
    .eq("id", contactId)
    .maybeSingle()

  if (contactError || !contact) {
    return { success: false, error: "Contact not found" }
  }

  // Verify caller is an agent/admin in the contact's brokerage. Contact-self
  // self-invites don't make sense (they'd already be authed) so we don't
  // allow them here.
  const { data: callerRow } = await supabase
    .from("users").select("brokerage_id").eq("id", authUser.id).maybeSingle()
  if (!callerRow?.brokerage_id || callerRow.brokerage_id !== contact.brokerage_id) {
    return { success: false, error: "Forbidden" }
  }
  const brokerageId = contact.brokerage_id as string
  const invitedByUserId = authUser.id

  // 2. Require valid email
  if (!contact.email) {
    return { success: false, error: "No email" }
  }

  // 3. Derive portal_view from contact_type
  let portalView = "lifetime"
  if (["seller", "motivated_seller"].includes(contact.contact_type ?? "")) {
    portalView = "seller"
  } else if (["buyer", "renter"].includes(contact.contact_type ?? "")) {
    portalView = "buyer"
  }

  // 4. Check for existing invite
  const { data: existing } = await supabase
    .from("portal_contact_invites")
    .select("id, status, expires_at")
    .eq("contact_id", contactId)
    .maybeSingle()

  const now = new Date()
  const newExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days

  if (existing) {
    // Expiry check: revoked → block
    if (existing.status === "revoked") {
      return { success: false, error: "Invite has been revoked for this contact" }
    }

    // Expired → reset and reuse
    if (new Date(existing.expires_at) < now) {
      await supabase
        .from("portal_contact_invites")
        .update({ status: "pending", expires_at: newExpiry })
        .eq("id", existing.id)
    }

    // 5. Optionally send magic link
    if (sendMagicLink) {
      const redirectTo = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/portal/${contactId}`
      await supabase.auth.signInWithOtp({
        email: contact.email,
        options: { emailRedirectTo: redirectTo },
      })
      await supabase
        .from("portal_contact_invites")
        .update({ status: "sent" })
        .eq("id", existing.id)
    }

  // 6. Non-blocking welcome message
  void supabase
    .from("client_portal_messages")
    .insert({
      contact_id: contactId,
      brokerage_id: brokerageId,
      direction: "outbound",
      body: `Hi ${contact.first_name ?? "there"}, your client portal is ready. Log in to track your journey.`,
    })

    return { success: true, inviteId: existing.id }
  }

  // No existing invite — create new
  const token = randomUUID()
  const { data: newInvite, error: insertError } = await supabase
    .from("portal_contact_invites")
    .insert({
      contact_id: contactId,
      brokerage_id: brokerageId,
      email: contact.email,
      invited_by: invitedByUserId,
      invite_token: token,
      portal_view: portalView,
      status: "pending",
      expires_at: newExpiry,
      invited_at: now.toISOString(),
    })
    .select("id")
    .single()

  if (insertError || !newInvite) {
    return { success: false, error: insertError?.message ?? "Failed to create invite" }
  }

  // 5. Optionally send magic link
  if (sendMagicLink) {
    const redirectTo = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/portal/${contactId}`
    await supabase.auth.signInWithOtp({
      email: contact.email,
      options: { emailRedirectTo: redirectTo },
    })
    await supabase
      .from("portal_contact_invites")
      .update({ status: "sent" })
      .eq("id", newInvite.id)
  }

  // 6. Non-blocking welcome message
  void supabase
    .from("client_portal_messages")
    .insert({
      contact_id: contactId,
      brokerage_id: brokerageId,
      direction: "outbound",
      body: `Hi ${contact.first_name ?? "there"}, your client portal is ready. Log in to track your journey.`,
    })

  return { success: true, inviteId: newInvite.id }
}
