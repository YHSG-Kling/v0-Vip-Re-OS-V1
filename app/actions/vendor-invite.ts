"use server"

/**
 * Vendor invite-to-platform handshake.
 *
 * inviteVendorToPlatformAction:
 *   Caller: any admin / broker / team_lead / agent within a brokerage (round 15
 *   opened invites to every tier). The gate is the SHARED predicate
 *   lib/vendors/vendor-scope.ts:canInviteVendors — this file no longer keeps a
 *   local INVITE_ALLOWED_ROLES copy, so there is one role list, not two that
 *   have to be kept in step.
 *   Creates a vendor_invitations row with a cryptographically random token,
 *   sends a Supabase invite email pointing the vendor to /vendor-invite/[token].
 *
 *   ROUND 37 (attribution): the vendor row records WHO brought the vendor —
 *   vendors.invited_by_user_id (first inviter wins) + vendors.invited_by_team_id
 *   (the inviter's led team, else membership team) — migration 1106. Pre-migration
 *   the stamp is a logged no-op; the invite itself never fails on attribution.
 *   The invite email is the EXISTING governed send (svc.auth.admin
 *   .inviteUserByEmail — the Supabase auth invite every platform invitation
 *   rides); no new raw sender is introduced here.
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
import { canInviteVendors, resolveVendorActorScope } from "@/lib/vendors/vendor-scope"

/**
 * Best-effort first-inviter-wins attribution stamp on the vendor row
 * (migration 1106 columns). The `.is("invited_by_user_id", null)` filter makes
 * a second inviter a no-op — the vendor stays attributed to whoever brought
 * them first. Pre-migration (columns absent) this logs and returns; the invite
 * flow never fails on attribution.
 */
async function stampVendorInviteAttribution(
  svc: ReturnType<typeof createServiceClient>,
  args: { vendorId: string; invitedByUserId: string; invitedByTeamId: string | null },
): Promise<void> {
  const { error } = await svc
    .from("vendors")
    .update({
      invited_by_user_id: args.invitedByUserId,
      invited_by_team_id: args.invitedByTeamId,
    })
    .eq("id", args.vendorId)
    .is("invited_by_user_id", null)
  if (error) {
    // 42703 (undefined column) pre-migration — honest log, never fatal.
    console.warn(
      `[vendor-invite] attribution stamp skipped (${error.message}) — apply migration 1106 (vendors.invited_by_user_id / invited_by_team_id) to record who brought each vendor.`,
    )
  }
}

const INVITE_TTL_DAYS = 14

/** Roles that may REVOKE a pending invite — leadership only (an agent may bring
 *  a vendor in, but pulling the invite back is a brokerage decision). Kept here
 *  rather than in vendor-scope because nothing else needs it; the INVITE side
 *  now defers to lib/vendors/vendor-scope.ts:canInviteVendors so the two copies
 *  of that list cannot drift apart. */
const REVOKE_ALLOWED_ROLES = new Set(["broker","broker_admin","admin","superadmin","team_lead"])

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
  /** Whether the invitation EMAIL actually went out. The invitation row is the
   *  durable artifact and is created either way, but the send is a separate
   *  provider call that can fail (already-registered address, SMTP outage) —
   *  and a UI that says "invitation sent" over a failed send is exactly the
   *  "reports success without doing the thing" defect. `false` means: the link
   *  is live, hand it over yourself. */
  emailSent?:   boolean
  emailError?:  string
  /** True when an unexpired pending invitation already existed and was reused
   *  instead of minting a second token. */
  reused?:      boolean
}

export async function inviteVendorToPlatformAction(
  input: InviteVendorInput,
): Promise<InviteVendorResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }

  // `error` is read deliberately: supabase-js RESOLVES a refused query, so
  // `data: null` from an RLS denial is indistinguishable from "no such user"
  // unless the error is inspected. Both paths refuse — the gate fails CLOSED —
  // but a denied read must say so rather than blame the brokerage config.
  const { data: caller, error: callerErr } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (callerErr) return { ok: false, error: `Could not verify your account: ${callerErr.message}` }

  if (!caller?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  if (!canInviteVendors(caller.user_type)) {
    return { ok: false, error: "Forbidden — your role cannot invite vendors" }
  }

  const svc = createServiceClient()

  // Look up vendor — must exist and belong to the caller's brokerage.
  const { data: vendor, error: vendorErr } = await svc
    .from("vendors")
    .select("id, name, email, brokerage_id")
    .eq("id", input.vendorId)
    .maybeSingle()
  if (vendorErr) return { ok: false, error: `Could not read the vendor record: ${vendorErr.message}` }
  if (!vendor) return { ok: false, error: "Vendor not found" }
  if (vendor.brokerage_id !== caller.brokerage_id) {
    return { ok: false, error: "Forbidden — vendor belongs to another brokerage" }
  }
  if (!vendor.email) {
    return { ok: false, error: "Vendor record has no email — add one before inviting" }
  }

  // If a pending invite already exists for this vendor + email, reuse it
  // (idempotent — clicking "Invite" twice should not flood the vendor's inbox).
  const { data: existing, error: existingErr } = await svc
    .from("vendor_invitations")
    .select("id, token, expires_at")
    .eq("vendor_id", vendor.id)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  // A failed lookup must NOT fall through to "no pending invite" — that would
  // mint a second live token for the same vendor on every retry.
  if (existingErr) {
    return { ok: false, error: `Could not check for an existing invitation: ${existingErr.message}` }
  }

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

  // Attribution (round 37): record WHO brought this vendor on the vendor row.
  // Led team wins over membership team (teams.team_lead_id is users.id).
  const actorScope = await resolveVendorActorScope(svc, {
    userId: user.id,
    userType: caller.user_type ?? "",
    brokerageId: caller.brokerage_id,
  })
  await stampVendorInviteAttribution(svc, {
    vendorId: vendor.id,
    invitedByUserId: user.id,
    invitedByTeamId: actorScope.ledTeamId ?? actorScope.membershipTeamId,
  })

  const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? ""
  const inviteUrl = `${appUrl}/vendor-invite/${token}`

  // Send Supabase auth invite. The magic link drops them at /auth/callback;
  // /auth/callback then redirects to /vendor-invite/[token] (next param) where
  // accept-form.tsx finalizes the link to user_role_assignments.
  let emailSent = false
  let emailError: string | undefined
  try {
    // supabase-js resolves this call with { error } rather than throwing on a
    // provider refusal, so the error is read explicitly — a swallowed refusal
    // here is what made "Invitation sent" a claim nobody had checked.
    const { error: sendErr } = await svc.auth.admin.inviteUserByEmail(
      vendor.email.toLowerCase(),
      {
        data: {
          first_name:     vendor.name?.split(" ")[0] ?? "Vendor",
          last_name:      vendor.name?.split(" ").slice(1).join(" ") ?? "",
          user_type:      "vendor",
          brokerage_id:   caller.brokerage_id,
          invitation_id:  invitationId,
          custom_message: input.customMessage ?? null,
        },
        redirectTo: `${appUrl}/auth/callback?next=${encodeURIComponent(`/vendor-invite/${token}`)}`,
      },
    )
    if (sendErr) emailError = sendErr.message
    else emailSent = true
  } catch (err: any) {
    emailError = err?.message ?? "unknown send failure"
  }
  if (!emailSent) {
    console.warn(`[inviteVendor] invitation ${invitationId} created but email not sent: ${emailError}`)
  }

  return { ok: true, invitationId, inviteUrl, emailSent, emailError, reused: !!existing }
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

  // Legacy-invite attribution catch-up: invitations sent before the round-37
  // stamp still know their inviter (m1057 invited_by). First-inviter-wins; the
  // inviter's team at THAT time is unknowable, so team stays null here.
  if (invitation.invited_by) {
    await stampVendorInviteAttribution(svc, {
      vendorId: invitation.vendor_id as string,
      invitedByUserId: invitation.invited_by as string,
      invitedByTeamId: null,
    })
  }

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

  const { data: caller, error: callerErr } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (callerErr) return { ok: false, error: `Could not verify your account: ${callerErr.message}` }
  if (!caller?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  if (!REVOKE_ALLOWED_ROLES.has(caller.user_type ?? "")) {
    return { ok: false, error: "Forbidden — only a broker, admin or team lead can revoke an invitation" }
  }

  const svc = createServiceClient()
  // `.select("id")` makes the revocation PROVABLE. Without it this returned
  // {ok:true} whenever the statement executed — including when the tenant
  // filter matched nothing, so revoking another brokerage's invitation, or an
  // already-accepted one, reported success while the token stayed live.
  const { data: revoked, error } = await svc
    .from("vendor_invitations")
    .update({ status: "revoked", updated_at: new Date().toISOString() })
    .eq("id", invitationId)
    .eq("brokerage_id", caller.brokerage_id)
    .eq("status", "pending")
    .select("id")
  if (error) return { ok: false, error: error.message }
  if (!revoked || revoked.length === 0) {
    return {
      ok: false,
      error: "Nothing was revoked — that invitation is not a pending invitation of your brokerage (it may already be accepted, expired or revoked).",
    }
  }
  return { ok: true }
}
