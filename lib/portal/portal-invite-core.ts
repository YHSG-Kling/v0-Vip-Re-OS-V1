import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { CONVERSION_MARKER_COLUMN } from "@/lib/contact-promotion/conversion-finality"
import {
  QUALIFIED_CONTACT_STATUS,
  PRE_QUALIFICATION_CONTACT_STATUSES,
} from "@/lib/contact-promotion/qualification"
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

// ─── QUALIFICATION — MERGED HERE FROM app/api/contacts/qualify/route.ts ───────
//
// OWNER RULING, verbatim:
//
//   "invitation from a lead converting to a contact makes sense for status
//    qualified but any other new contacts coming in from forms, lead magnets,
//    other real estate sites, etc. haven't been qualified yet."
//
// So `contacts.status = 'qualified'` is EARNED, and the only thing that earns it
// is a LEAD CONVERSION standing behind the contact. An invite issued for a
// contact that arrived from a web form, a lead magnet, an IDX/portal
// registration, a CSV import, a manual CRM add or any third-party real-estate
// site leaves the status exactly where that entry point put it.
//
// DERIVED FROM THE RECORD, NEVER FROM A CALLER FLAG (CLAUDE.md §4). The question
// "did a lead convert into this contact?" is answered by `leads.contact_id` —
// THE one conversion marker, spelled once at
// lib/contact-promotion/conversion-finality.ts:50 and imported here rather than
// re-spelled (§6). It is the only marker every one of the three converters
// writes. Both invite doors (the agent's manual CRM invite and the system
// conversion invite) therefore agree, because both are reading the same row
// rather than trusting whichever button was pressed.
//
// FAIL CLOSED. A refused or throwing conversion read leaves the status ALONE.
// "Nobody checked" must never render as "checked and qualified".
//
// NEVER A DOWNGRADE, AND NEVER A REWIND. The stamp is applied only to a contact
// still sitting at a pre-qualification status; anything later already claimed the
// row. Both the earned status and that set are spelled ONCE, in
// lib/contact-promotion/qualification.ts, and imported here — the same module the
// three CREATE paths use to refuse a forged 'qualified' (§6).

/**
 * Stamp `contacts.status = 'qualified'` IFF a lead converted into this contact.
 *
 * Returns true only when this call actually moved the row. Every other outcome —
 * no originating lead, an already-advanced status, a refused read, a refused
 * write — returns false and leaves the contact exactly as it was. NEVER THROWS
 * and never fails the invite: the portal grant does not depend on the stamp.
 */
async function stampQualifiedIfLeadConverted(
  supabase: ReturnType<typeof createServiceClient>,
  contactId: string,
  brokerageId: string,
): Promise<boolean> {
  try {
    // supabase-js RESOLVES refusals — the error is READ, never dropped (§3).
    const { data: originLeads, error: leadError } = await supabase
      .from("leads")
      .select("id")
      .eq(CONVERSION_MARKER_COLUMN, contactId)
      .eq("brokerage_id", brokerageId)
      .limit(1)

    if (leadError) {
      console.error(
        `[portal-invite] conversion check for contact ${contactId} was REFUSED (${leadError.message}) — ` +
          `status left UNCHANGED rather than stamped '${QUALIFIED_CONTACT_STATUS}' off an unread record.`,
      )
      return false
    }
    // No lead converted into this contact: it came from a form, a lead magnet, an
    // IDX/portal registration, an import, a manual add or a third-party site. Per
    // the ruling it has not been qualified — leave the entry status alone.
    if (!originLeads || originLeads.length === 0) return false

    // An UPDATE that matches nothing also resolves (§3) — `.select()` and COUNT.
    // Here zero rows is NOT a failure: it means the contact had already moved off
    // its entry status, and walking that back would be the rewind above.
    const { data: stamped, error: stampError } = await supabase
      .from("contacts")
      .update({ status: QUALIFIED_CONTACT_STATUS, updated_at: new Date().toISOString() })
      .eq("id", contactId)
      .eq("brokerage_id", brokerageId)
      .in("status", PRE_QUALIFICATION_CONTACT_STATUSES)
      .select("id")

    if (stampError) {
      console.error(
        `[portal-invite] qualification stamp REFUSED for contact ${contactId}:`,
        stampError.message,
      )
      return false
    }
    return (stamped?.length ?? 0) > 0
  } catch (e: any) {
    console.error(
      `[portal-invite] qualification stamp threw for contact ${contactId} (${e?.message ?? "unknown error"}) — ` +
        `status left unchanged; the portal grant is unaffected.`,
    )
    return false
  }
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

  // Qualification (owner ruling — see stampQualifiedIfLeadConverted above). AFTER
  // the grant, deliberately: the `portal_contact_invites` row is the access, and a
  // status stamp must never be able to cost a contact their portal. The return
  // value is not propagated because the READER of this write is the
  // `contacts.status` column itself — read live at app/actions/briefing-actions.ts:470,
  // app/actions/ai-lead-nurturing.ts:442, app/dashboard/listings/[id]/lifecycle/page.tsx:325
  // and counted as converted at app/api/contacts/analytics/route.ts:58 — and a
  // result field nobody reads is the very orphan §1 exists to prevent.
  await stampQualifiedIfLeadConverted(supabase, contactId, brokerageId)

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
    //
    // `login_created_at` MERGED HERE from app/api/contacts/qualify/route.ts:77,
    // which was the tree's ONLY writer of the column — deleting that route without
    // this line would have left a written-nowhere column, which is the orphan §1
    // forbids. It belongs in THIS statement and no other: `has_login` becomes true
    // exactly here, so the flag and its timestamp are set in one write and can
    // never disagree. Stamped only when EMPTY — a re-ensure must not keep pushing
    // "when did this contact get a login?" forward to today.
    //
    // The moment recorded is HONESTER than the route's was. The route stamped it
    // when it minted an auth user the contact had not used (and could not use: the
    // password was console.logged and no mail was ever sent), whereas the ensure
    // runs on the contact's first AUTHENTICATED portal hit — the point at which a
    // login demonstrably exists.
    const { data: c } = await svc
      .from("contacts").select("contact_user_id, has_login, login_created_at").eq("id", contact.id).maybeSingle()
    if (c && (!c.contact_user_id || !c.has_login || !c.login_created_at)) {
      await sentinelWrite(
        svc,
        svc.from("contacts")
          .update({
            contact_user_id:  c.contact_user_id ?? authUserId,
            has_login:        true,
            login_created_at: c.login_created_at ?? new Date().toISOString(),
          })
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

// ─── TOMBSTONE (orphan doctrine §1.1) ────────────────────────────────────────
//
// DELETED: app/api/contacts/qualify/route.ts (POST) — the SECOND portal-login
// door. It fetched the contact, minted an auth user, and stamped
// `contacts.status='qualified'`, `contact_user_id`, `has_login` and
// `login_created_at` in one write.
//
// SURVIVOR: this file.
//   · the qualification stamp      → stampQualifiedIfLeadConverted
//                                    (lib/portal/portal-invite-core.ts:77), called from
//                                    issuePortalInvite (lib/portal/portal-invite-core.ts:204)
//   · `login_created_at`           → ensureContactPortalUser
//                                    (lib/portal/portal-invite-core.ts:349)
//   · `contact_user_id`/`has_login`→ ensureContactPortalUser, which already held both
//   · the invite/portal grant      → issuePortalInvite (lib/portal/portal-invite-core.ts:131)
// Five wired callers reach the survivor through
// app/actions/portal-invites.ts:createPortalInviteForContact and
// lib/contact-promotion/portal-access.ts:grantPortalAccessForPromotedContact.
//
// WHY IT HAD TO GO, not merely why it could. Everything it did that the survivor
// did NOT do was a defect, VERIFIED in the source before deletion:
//   1. It generated a 16-char plaintext temporary password and printed it to the
//      server log (route.ts:47, :137). A credential in a log line is a credential
//      leaked to everyone with log access.
//   2. It never sent that password anywhere. `sendWelcomeEmail` was a `console.log`
//      with `// TODO: Replace with actual email provider` (route.ts:143), so every
//      account it created was unreachable by the person it was created for.
//   3. It called `auth.admin.createUser` and wrote NO `public.users` row — the one
//      thing ensureContactPortalUser exists to guarantee ("portal clients ARE
//      users", above). Its logins were therefore invisible to staff rosters and
//      not impersonable, because impersonation targets users.id.
//   4. It stamped 'qualified' on ANY contact whose id was posted, which is exactly
//      what the owner's ruling forbids for a contact that arrived from a form, a
//      lead magnet, an IDX/portal registration, an import or a manual add.
//
// NO CALLER COULD EXIST, proven rather than assumed (§1 "unreferenced is not
// dead"): the route opened with `requireAuth(supabase)` on a COOKIE-BOUND server
// client (lib/kernel/api-auth.ts:54) — no API key, no bearer token, no webhook
// signature — so nothing outside a logged-in browser session of this app could
// ever reach it. Inside the tree it had zero callers: the only occurrences of the
// string "contacts/qualify" anywhere in the repo were two BASELINE files already
// recording it as unwired (scripts/orphan-export-baseline.json:1200,
// scripts/opposite-missing-baseline.json:701). It appears in no `vercel.json`
// cron, in no lib/kernel/cron-dispatch.ts route, and in no `${baseUrl}/api/…`
// self-call.
