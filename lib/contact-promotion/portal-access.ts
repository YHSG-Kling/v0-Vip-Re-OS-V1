/**
 * lib/contact-promotion/portal-access.ts
 *
 * "…at the same time since this is a new contact record, the contact gets access to
 * their portal." (owner)
 *
 * THIS BUILDS NO SECOND PORTAL MECHANISM. It resolves the one thing the conversion
 * has that the invite core needs — an authorizing users.id — and then delegates to
 * the CANONICAL system invite path:
 *
 *   lib/portal/portal-invite-core.ts  createSystemPortalInvite → issuePortalInvite
 *
 * which is the same function the automatic assignment lane already calls
 * (lib/kernel/lead-acquisition-handlers.ts:562). The OTHER door,
 * app/actions/portal-invites.ts:createPortalInviteForContact, is a `"use server"`
 * action: it authorizes against the LOGGED-IN SESSION, and a promotion runs in a
 * background/service context where there is no session — it would fail here, which
 * is exactly why the system path exists. Both doors converge on issuePortalInvite,
 * so there is one invite table, one token, one welcome message.
 *
 * WHAT "ACCESS" MEANS, precisely: issuePortalInvite creates (or reuses) the
 * `portal_contact_invites` row — that row IS the access grant, and it is reachable
 * through a link the agent can share. The magic-link EMAIL is delivery, and it is
 * compliance-gated inside the core (no email, opted out, or unsubscribed → no send).
 * So a contact with no email still GETS a portal; what they don't get is the email.
 * That distinction is reported, never papered over.
 *
 * IMPORT IS DYNAMIC ON PURPOSE. portal-invite-core.ts is `server-only`; a static
 * import would drag it into every module graph reaching the converter — including
 * the plain `tsx` simulators, which crash on `server-only` at load. Same reason
 * contact-creator.ts defers `contact-enrichment-core`.
 */

/**
 * Contact types that do NOT get a client portal. The portal is the CLIENT's view of
 * their own transaction; a vendor or a referral partner is a counterparty, not a
 * client, and handing them a client portal is a data-exposure decision nobody made.
 * Everything else in the canonical contact_type vocabulary gets access.
 */
export const PORTAL_EXCLUDED_CONTACT_TYPES: readonly string[] = ["vendor", "referral_partner"]

export interface PortalAccessResult {
  /** A portal_contact_invites row exists for this contact after this call. */
  granted: boolean
  /** The magic-link email actually went out. False is NOT a failure — see below. */
  emailSent: boolean
  /** Machine-readable outcome for the caller's log. */
  reason:
    | "granted"
    | "excluded_contact_type"
    | "no_authorizing_agent_user"
    | "invite_refused"
    | "unavailable"
  /** Human-readable notes the caller surfaces as WARNINGS, never as a failure. */
  warnings: string[]
}

export interface PortalAccessParams {
  /** contacts.id — the PRIMARY key. */
  contactId: string
  /** agents.id of the assigned agent. `agents.id` and `users.id` are DISJOINT spaces. */
  agentId: string
  /**
   * users.id of the assigned agent, when the caller already resolved it. Omit and
   * this resolves it via agents.user_id — the ONLY legal crossing between the spaces.
   */
  agentUserId?: string | null
  /** Canonical contacts.contact_type, used only for the exclusion gate. */
  contactType?: string | null
}

/**
 * Grant the newly converted contact access to their portal.
 *
 * NEVER THROWS and NEVER returns a failure the caller should treat as fatal. A
 * portal invite is a best-effort step at the end of a conversion that has ALREADY
 * created the contact and re-pointed its history; unwinding that because an email
 * provider was down would be the worse outcome. Every refusal comes back in
 * `warnings` for the caller to report.
 */
export async function grantPortalAccessForPromotedContact(
  supabase: any,
  params: PortalAccessParams,
): Promise<PortalAccessResult> {
  const out: PortalAccessResult = { granted: false, emailSent: false, reason: "unavailable", warnings: [] }

  const type = (params.contactType ?? "").toLowerCase()
  if (PORTAL_EXCLUDED_CONTACT_TYPES.includes(type)) {
    out.reason = "excluded_contact_type"
    return out
  }

  // ── Resolve the authorizing users.id ───────────────────────────────────────
  // agents.id ≠ users.id. issuePortalInvite verifies the ACTOR's brokerage against
  // the contact's, and it looks the actor up in `users` — so handing it an agents.id
  // resolves to no user, no brokerage, and a flat "Forbidden". The crossing is
  // agents.user_id and nothing else.
  let agentUserId = params.agentUserId ?? null
  if (!agentUserId) {
    const { data: agentRow, error: agentError } = await supabase
      .from("agents")
      .select("user_id")
      .eq("id", params.agentId)
      .maybeSingle()
    if (agentError) {
      out.reason = "no_authorizing_agent_user"
      out.warnings.push(
        `portal access NOT granted for contact ${params.contactId}: agents lookup refused — ${agentError.message}`,
      )
      return out
    }
    agentUserId = agentRow?.user_id ?? null
  }

  // FAIL HONESTLY. Without an authorizing user there is no legitimate actor to
  // attribute the invite to. Creating an invite anyway would produce a portal row
  // nobody can be shown to have authorized — worse than reporting it.
  if (!agentUserId) {
    out.reason = "no_authorizing_agent_user"
    out.warnings.push(
      `portal access NOT granted for contact ${params.contactId}: assigned agent ${params.agentId} has no users.id ` +
        `(agents.user_id is null), so no actor can authorize the invite. Link the agent to a user, then re-send from the CRM.`,
    )
    return out
  }

  try {
    const { createSystemPortalInvite } = await import("@/lib/portal/portal-invite-core")
    const invite = await createSystemPortalInvite({
      contactId: params.contactId,
      agentUserId,
      sendMagicLink: true,
    })

    if (!invite.success) {
      out.reason = "invite_refused"
      out.warnings.push(
        `portal access NOT granted for contact ${params.contactId}: ${invite.error ?? "invite refused"}`,
      )
      return out
    }

    out.granted = true
    out.emailSent = invite.emailSent === true
    out.reason = "granted"

    // Access exists; delivery did not. The contact has a portal, but no email left
    // the building — because they have no email address, or because they opted out
    // and the core (correctly) refused to mail them. The agent has to share the link.
    if (!out.emailSent) {
      out.warnings.push(
        `portal created for contact ${params.contactId} but NO invite email was sent ` +
          `(no email address, or the contact has opted out / unsubscribed). The agent must share the portal link.`,
      )
    }
    return out
  } catch (e: any) {
    out.reason = "unavailable"
    out.warnings.push(
      `portal access NOT granted for contact ${params.contactId}: ${e?.message ?? "portal invite core unavailable"}`,
    )
    return out
  }
}
