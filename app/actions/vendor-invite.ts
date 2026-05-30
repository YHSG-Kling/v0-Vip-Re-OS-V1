"use server"

/**
 * Vendor invite-to-platform handshake.
 *
 * inviteVendorToPlatformAction:
 *   Caller: any admin / broker / team_lead / agent within a brokerage.
 *   Creates a vendor_invitations row with a cryptographically random token,
 *   sends a Supabase invite email pointing the vendor to /vendor-invite/[token].
 *
 * acceptVendorInviteAction:
 *   Caller: vendor (after authenticating via the magic link in the invite email).
 *   Verifies the token is pending + unexpired, then:
 *     1. Upserts a users row with user_type='vendor', brokerage_id from invitation
 *     2. Creates a user_role_assignments row linking auth user_id ↔ vendor_id
 *     3. Marks the invitation 'accepted' with accepted_by + accepted_at
 *
 * The vendor portal (/portal/vendor) already reads user_role_assignments.vendor_id,
 * so once acceptance completes the vendor lands on a working portal.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { randomBytes } from "node:crypto"

const INVITE_TTL_DAYS = 14
const INVITE_ALLOWED_ROLES = new Set(["broker","broker_admin","admin","superadmin","team_lead","agent"])

function generateInviteToken(): string {
  // 32 random bytes → 43 url-safe base64 chars. Plenty of entropy
  // (~256 bits) and short enough for a clean URL.
  return randomBytes(32).toString("base64url")
}

// ── INVITE ───────────────────────────────────────────────────────────────────

export interface InviteVendorInput {
  vendorId:        string
  customMessage?:  string
}

export interface InviteVendorResult {
  ok:           boolean
  error?:       string
  invitationId?: string
  inviteUrl?:   string
}

export async function inviteVendorToPlatformAction(
  input: InviteVendorInput,
): Promise<InviteVendorResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }

  const { data: caller } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!caller?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  if (!INVITE_ALLOWED_ROLES.has(caller.user_type ?? "")) {
    return { ok: false, error: "Forbidden — your role cannot invite vendors" }
  }

  const svc = createServiceClient()

  // Look up vendor — must exist and belong to the caller's brokerage.
  const { data: vendor } = await svc
    .from("vendors")
    .select("id, name, email, brokerage_id")
    .eq("id", input.vendorId)
    .maybeSingle()
  if (!vendor) return { ok: false, error: "Vendor not found" }
  if (vendor.brokerage_id !== caller.brokerage_id) {
    return { ok: false, error: "Forbidden — vendor belongs to another brokerage" }
  }
  if (!vendor.email) {
    return { ok: false, error: "Vendor record has no email — add one before inviting" }
  }

  // If a pending invite already exists for this vendor + email, reuse it
  // (idempotent — clicking "Invite" twice should not flood the vendor's inbox).
  const { data: existing } = await svc
    .from("vendor_invitations")
    .select("id, token, expires_at")
    .eq("vendor_id", vendor.id)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle()

  let invitationId: string
  let token: string

  if (existing) {
    invitationId = existing.id as string
    token        = existing.token as string
  } else {
    token = generateInviteToken()
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 3600 * 1000).toISOString()

    const { data: inv, error } = await svc
      .from("vendor_invitations")
      .insert({
        vendor_id:      vendor.id,
        brokerage_id:   caller.brokerage_id,
        invited_by:     user.id,
        email:          vendor.email.toLowerCase(),
        token,
        status:         "pending",
        expires_at:     expiresAt,
        custom_message: input.customMessage ?? null,
      })
      .select("id")
      .single()
    if (error || !inv) {
      return { ok: false, error: `Failed to create invitation: ${error?.message ?? "unknown"}` }
    }
    invitationId = inv.id as string
  }

  const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? ""
  const inviteUrl = `${appUrl}/vendor-invite/${token}`

  // Send Supabase auth invite. The magic link drops them at /auth/callback;
  // /auth/callback then redirects to /vendor-invite/[token] (next param) where
  // accept-form.tsx finalizes the link to user_role_assignments.
  try {
    await svc.auth.admin.inviteUserByEmail(vendor.email.toLowerCase(), {
      data: {
        first_name:     vendor.name?.split(" ")[0] ?? "Vendor",
        last_name:      vendor.name?.split(" ").slice(1).join(" ") ?? "",
        user_type:      "vendor",
        brokerage_id:   caller.brokerage_id,
        invitation_id:  invitationId,
        custom_message: input.customMessage ?? null,
      },
      redirectTo: `${appUrl}/auth/callback?next=${encodeURIComponent(`/vendor-invite/${token}`)}`,
    })
  } catch (err: any) {
    console.warn("[inviteVendor] Email send failed:", err?.message)
    // Non-fatal — caller can manually share inviteUrl.
  }

  return { ok: true, invitationId, inviteUrl }
}

// ── ACCEPT ───────────────────────────────────────────────────────────────────

export interface AcceptVendorInviteResult {
  ok:        boolean
  error?:    string
  vendorId?: string
  redirectTo?: string
}

export async function acceptVendorInviteAction(
  token: string,
): Promise<AcceptVendorInviteResult> {
  if (!token || token.length < 16) return { ok: false, error: "Invalid invitation token" }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "You must be signed in to accept this invitation" }
  if (!user.email) return { ok: false, error: "Your account has no email on file" }

  const svc = createServiceClient()

  // Read invitation — service client to bypass tenant RLS on read (we'll
  // enforce email match below).
  const { data: invitation } = await svc
    .from("vendor_invitations")
    .select("id, vendor_id, brokerage_id, email, status, expires_at, invited_by")
    .eq("token", token)
    .maybeSingle()
  if (!invitation) return { ok: false, error: "Invitation not found" }
  if (invitation.status !== "pending") {
    return { ok: false, error: `Invitation already ${invitation.status}` }
  }
  if (new Date(invitation.expires_at).getTime() < Date.now()) {
    // Mark expired so admins can clean up
    await svc.from("vendor_invitations").update({ status: "expired" }).eq("id", invitation.id)
    return { ok: false, error: "Invitation has expired — ask the brokerage to send a new one" }
  }

  // Email must match the invitation (defense against forwarded links)
  if (user.email.toLowerCase() !== (invitation.email as string).toLowerCase()) {
    return { ok: false, error: "Sign in with the invited email address" }
  }

  // Upsert the users row — vendor user_type, scoped to inviting brokerage
  const { data: existingUser } = await svc
    .from("users")
    .select("id, user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (existingUser) {
    // If user already belongs to a different brokerage, refuse — vendor
    // cross-brokerage support is intentionally NOT implemented here.
    if (existingUser.brokerage_id && existingUser.brokerage_id !== invitation.brokerage_id) {
      return { ok: false, error: "This email is already tied to a different brokerage" }
    }
    await svc.from("users").update({
      user_type:    "vendor",
      role:         "vendor",
      brokerage_id: invitation.brokerage_id,
      updated_at:   new Date().toISOString(),
    }).eq("id", user.id)
  } else {
    await svc.from("users").insert({
      id:           user.id,
      email:        user.email.toLowerCase(),
      first_name:   (user.user_metadata?.first_name as string) ?? "",
      last_name:    (user.user_metadata?.last_name as string)  ?? "",
      user_type:    "vendor",
      role:         "vendor",
      brokerage_id: invitation.brokerage_id,
      is_contact:   false,
      created_at:   new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    })
  }

  // Link auth user ↔ vendor record via user_role_assignments
  // Upsert pattern: delete any existing vendor assignment for this user, then insert.
  await svc.from("user_role_assignments")
    .delete()
    .eq("user_id", user.id)
    .not("vendor_id", "is", null)

  await svc.from("user_role_assignments").insert({
    user_id:      user.id,
    vendor_id:    invitation.vendor_id,
    brokerage_id: invitation.brokerage_id,
    role:         "vendor",
    created_at:   new Date().toISOString(),
    updated_at:   new Date().toISOString(),
  })

  // Mark invitation accepted
  await svc.from("vendor_invitations").update({
    status:      "accepted",
    accepted_by: user.id,
    accepted_at: new Date().toISOString(),
  }).eq("id", invitation.id)

  return {
    ok:         true,
    vendorId:   invitation.vendor_id as string,
    redirectTo: "/portal/vendor",
  }
}

// ── ADMIN UTILITIES ──────────────────────────────────────────────────────────

export async function revokeVendorInviteAction(
  invitationId: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }

  const { data: caller } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!caller?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  if (!["broker","broker_admin","admin","superadmin","team_lead"].includes(caller.user_type ?? "")) {
    return { ok: false, error: "Forbidden" }
  }

  const svc = createServiceClient()
  const { error } = await svc
    .from("vendor_invitations")
    .update({ status: "revoked" })
    .eq("id", invitationId)
    .eq("brokerage_id", caller.brokerage_id)
    .eq("status", "pending")
  return error ? { ok: false, error: error.message } : { ok: true }
}
