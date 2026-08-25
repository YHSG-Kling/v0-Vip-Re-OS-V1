import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { randomUUID } from "crypto"

/**
 * Shared portal-invite core. NOT a server action and NOT client-callable — it performs NO session
 * check, so every caller MUST first authorize the actor (the "use server" action binds the actor to
 * the logged-in session; the system path passes a trusted, server-resolved agent). The brokerage
 * match (actor's brokerage === contact's brokerage) is enforced here as defense-in-depth so neither
 * path can invite cross-tenant.
 *
 * Email (Supabase OTP magic link) is sent only when the contact has an email AND has not opted out /
 * unsubscribed — TCPA/CAN-SPAM safe. The invite ROW is always (re)created so an opted-out contact
 * still has a portal they can reach via an agent-shared link.
 *
 * `sendMagicLink` IS A DELIVERY DECISION AND THE CALLER OWNS IT. On the conversion lanes it is
 * FALSE: the ONE welcome email (lib/kernel/client-welcome.ts) carries the portal door, and a
 * second OTP mail racing it is the duplicate the owner's "welcome email is the FIRST on
 * conversion" ruling forbids. It stays TRUE where no agent-signed welcome will be produced
 * (an agent's manual CRM invite, a home-value report, a contact type no manager picks
 * up — see resolveWelcomeManagers) — there it is the only thing that tells the contact
 * their portal exists.
 */
export interface IssuePortalInviteParams {
  contactId:        string
  /** Authorized actor (users.id). Caller is responsible for having verified this actor. */
  invitedByUserId:  string
  sendMagicLink?:   boolean
}

export async function issuePortalInvite(
  params: IssuePortalInviteParams,
): Promise<{ success: boolean; inviteId?: string; emailSent?: boolean; error?: string }> {
  const { contactId, invitedByUserId, sendMagicLink = false } = params
  const supabase = createServiceClient()

  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, email, first_name, contact_type, brokerage_id, agent_id, email_opt_out, email_unsubscribed")
    .eq("id", contactId)
    .maybeSingle()
  if (contactError || !contact) return { success: false, error: "Contact not found" }
  if (!contact.brokerage_id)    return { success: false, error: "Contact has no brokerage" }

  // Defense-in-depth tenant check: the actor must belong to the contact's brokerage. Resolve the
  // actor's brokerage from users.brokerage_id, falling back to agents.brokerage_id (some agent users
  // have a null users.brokerage_id but a populated agents row).
  const { data: actorUser } = await supabase
    .from("users").select("brokerage_id").eq("id", invitedByUserId).maybeSingle()
  let actorBrokerage = actorUser?.brokerage_id ?? null
  if (!actorBrokerage) {
    const { data: actorAgent } = await supabase
      .from("agents").select("brokerage_id").eq("user_id", invitedByUserId).maybeSingle()
    actorBrokerage = actorAgent?.brokerage_id ?? null
  }
  if (!actorBrokerage || actorBrokerage !== contact.brokerage_id) {
    return { success: false, error: "Forbidden" }
  }
  const brokerageId = contact.brokerage_id as string

  // Derive portal view from contact_type.
  let portalView = "lifetime"
  if (["seller", "motivated_seller"].includes(contact.contact_type ?? "")) portalView = "seller"
  else if (["buyer", "renter"].includes(contact.contact_type ?? ""))       portalView = "buyer"

  const now = new Date()
  const newExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()

  // Upsert the invite row (reuse/reset existing; revoked stays blocked).
  let inviteId: string
  const { data: existing } = await supabase
    .from("portal_contact_invites")
    .select("id, status, expires_at")
    .eq("contact_id", contactId)
    .maybeSingle()
  if (existing) {
    if (existing.status === "revoked") return { success: false, error: "Invite revoked for this contact" }
    if (new Date(existing.expires_at) < now) {
      await supabase.from("portal_contact_invites")
        .update({ status: "pending", expires_at: newExpiry }).eq("id", existing.id)
    }
    inviteId = existing.id
  } else {
    const { data: created, error: insErr } = await supabase
      .from("portal_contact_invites")
      .insert({
        contact_id: contactId, brokerage_id: brokerageId, email: contact.email ?? null,
        invited_by: invitedByUserId, invite_token: randomUUID(), portal_view: portalView,
        status: "pending", expires_at: newExpiry, invited_at: now.toISOString(),
      })
      .select("id").single()
    if (insErr || !created) return { success: false, error: insErr?.message ?? "Failed to create invite" }
    inviteId = created.id
  }

  // Compliance-gated magic-link email.
  let emailSent = false
  const canEmail = !!contact.email && !contact.email_opt_out && !contact.email_unsubscribed
  if (sendMagicLink && canEmail) {
    const redirectTo = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/portal/${contactId}`
    const { error: otpErr } = await supabase.auth.signInWithOtp({
      email: contact.email as string,
      options: { emailRedirectTo: redirectTo },
    })
    if (!otpErr) {
      emailSent = true
      await supabase.from("portal_contact_invites").update({ status: "sent" }).eq("id", inviteId)
    }
  }

  // ─── TOMBSTONE (orphan doctrine §1.1) ──────────────────────────────────────
  // REMOVED: the hardcoded generic portal greeting this function used to insert
  // into `client_portal_messages` —
  //   "Hi ${first_name}, your client portal is ready. Log in to track your journey."
  //
  // SURVIVOR: lib/kernel/client-welcome.ts::writePortalWelcomeCard (the
  // `transparency_updates` card the ONE welcome writes, carrying the agent-signed
  // situational copy AND the personal video URL the portal home feed plays).
  //
  // WHY IT HAD TO GO, not merely why it could. OWNER RULING: "we only sent content
  // to leads and contacts that are personalized and situation, them first
  // messaging." That sentence is exactly one line long and this greeting broke it
  // in every clause — no situation, no agent voice, brokerage-first framing, and
  // it was the FIRST thing a converted contact saw. Two spellings of "the portal
  // greeting" also put the welcome on two rails (client_portal_messages and
  // transparency_updates), which is the §6 defect that lets a scorer match neither.
  //
  // MEASUREMENT: `client_portal_messages` held ZERO rows on hrvaqgvukzxfskkcrwbt
  // when this was removed, so nothing live is losing a message it already had.
  //
  // The ACCESS GRANT above is deliberately untouched: the invite row IS the portal,
  // it is still created immediately and unconditionally, and no contact can lose
  // portal access because a video render, an email, or a greeting failed.

  return { success: true, inviteId, emailSent }
}

// ─── ensureContactPortalUser ─────────────────────────────────────────────────
//
// IDENTITY CORRECTION: portal clients ARE users. The magic-link OTP flow creates a
// REAL auth user, but nothing ever wrote the public.users row that makes the client
// first-class — visible in staff rosters and impersonable (impersonation targets
// users.id). This is the ONE ensure hook: called on the contact's first (and every)
// authenticated Rule-1 portal hit, and reused verbatim by the superadmin backfill.
//
// Contract:
//   • IDEMPOTENT — a users row for the auth uid short-circuits to link-stamping only.
//   • BEST-EFFORT — never throws; portal access NEVER fails on the ensure. Every
//     lost write is ledgered via sentinelWrite (silencer ratchet), never swallowed.
//   • Column shape follows the provisionTenantOwner users upsert idiom exactly
//     (id = auth uid, email, first/last, user_type + role 'contact', brokerage_id,
//     is_contact) + status 'active'. users.id === auth.users.id — THE invariant.
//   • Link-back: contacts.contact_user_id (the column every portal action already
//     authorizes on) is stamped when empty, plus has_login = true.

export interface EnsureContactUserParams {
  /** auth.users.id of the OTP-authenticated portal visitor. */
  authUserId: string
  /** The auth user's email (fallback when the contact row has none). */
  authEmail: string | null
  contact: {
    id: string
    email: string | null
    first_name: string | null
    last_name: string | null
    brokerage_id: string | null
  }
}

export interface EnsureContactUserResult {
  /** A users row for the auth uid exists after this call (created now or before). */
  ensured: boolean
  /** This call created the users row (false = already existed or write lost). */
  created: boolean
}

export async function ensureContactPortalUser(
  params: EnsureContactUserParams,
): Promise<EnsureContactUserResult> {
  const { authUserId, authEmail, contact } = params
  try {
    if (!authUserId || !contact?.id || !contact.brokerage_id) {
      return { ensured: false, created: false }
    }
    const svc = createServiceClient()

    // Idempotency gate: users.id === auth uid is the identity invariant.
    const { data: existing } = await svc
      .from("users").select("id").eq("id", authUserId).maybeSingle()

    let created = false
    if (!existing) {
      const email = (contact.email ?? authEmail ?? "").trim().toLowerCase()
      // Checked insert (NOT upsert): existence was checked above, and an id
      // collision here must ledger, never silently overwrite a staff row.
      created = await sentinelWrite(
        svc,
        svc.from("users").insert({
          id:           authUserId,
          email:        email || null,
          first_name:   contact.first_name ?? null,
          last_name:    contact.last_name ?? null,
          user_type:    "contact",
          role:         "contact",
          brokerage_id: contact.brokerage_id,
          is_contact:   true,
          status:       "active",
          updated_at:   new Date().toISOString(),
        }),
        { table: "users", flow: "portal_contact_user_ensure", brokerageId: contact.brokerage_id },
      )
    }

    // Link-back stamp: only when unset (never clobber an existing link), and the
    // has_login flag so roster/portal-state reads agree with reality.
    const { data: c } = await svc
      .from("contacts").select("contact_user_id, has_login").eq("id", contact.id).maybeSingle()
    if (c && (!c.contact_user_id || !c.has_login)) {
      await sentinelWrite(
        svc,
        svc.from("contacts")
          .update({ contact_user_id: c.contact_user_id ?? authUserId, has_login: true })
          .eq("id", contact.id),
        { table: "contacts", flow: "portal_contact_user_ensure", brokerageId: contact.brokerage_id },
      )
    }

    return { ensured: !!existing || created, created }
  } catch {
    // Best-effort contract: the portal must render regardless.
    return { ensured: false, created: false }
  }
}

/**
 * System (server-only) portal invite for TRUSTED automated flows (lead assignment, warm captures).
 * Not a server action → clients cannot call it to forge attribution. The caller supplies the
 * authorizing agent's users.id (e.g. the assigned agent); issuePortalInvite verifies that agent is in
 * the contact's brokerage.
 */
export async function createSystemPortalInvite(params: {
  contactId:   string
  agentUserId: string
  sendMagicLink?: boolean
}): Promise<{ success: boolean; inviteId?: string; emailSent?: boolean; error?: string }> {
  if (!params.agentUserId) return { success: false, error: "agentUserId required" }
  return issuePortalInvite({
    contactId:       params.contactId,
    invitedByUserId: params.agentUserId,
    sendMagicLink:   params.sendMagicLink ?? true,
  })
}
