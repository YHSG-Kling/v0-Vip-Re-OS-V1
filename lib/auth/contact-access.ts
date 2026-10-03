/**
 * lib/auth/contact-access.ts
 *
 * Canonical "is the caller allowed to read/act on this contact?" gate. Single source of truth used
 * by:
 *   - `app/actions/contact-quick-actions.ts` server actions (write-side enforcement)
 *   - `app/actions/contacts/update-addressing.ts`, `app/actions/contacts/last-promise.ts`,
 *     `app/actions/strategy-session.ts`, `app/actions/convert-outside-inquiry.ts` (write-side)
 *   - `app/crm/contacts/[contactId]/page.tsx` (read-side defense-in-depth on the consolidated
 *      contact detail page — passes `intent: "read"`)
 *
 * The contact table's RLS policies already gate cross-brokerage reads — but every caller above
 * writes through the SERVICE client (RLS bypass), so THIS gate is the only gate on those lanes.
 *
 * ── ★ ACT-AS WRITE SEAM ★ (impersonation closure) ──────────────────────────────────────────────
 * This gate used to admit platform staff UNCONDITIONALLY — read or write, impersonating or not,
 * read_only grant or full. That made it a WRITE lane a read_only impersonation grant could use.
 * Closed:
 *   - The identity is resolved through getAgentContext(), which re-validates any impersonation
 *     grant against the live session row ON THIS CALL (never a stale flag).
 *   - While IMPERSONATING, the tree below is evaluated AS THE IMPERSONATED IDENTITY — the
 *     investigator inherits exactly that seat's authority over contacts and never exceeds it —
 *     and a write intent under anything but an active FULL grant is refused.
 *   - Platform staff NOT impersonating keep read access (the pre-existing read-side behaviour)
 *     but may no longer WRITE through this lane at all: staff writes into a tenant exist only
 *     through an active FULL act-as grant.
 *
 * `intent` defaults to "write" — fail closed. Read surfaces opt in explicitly.
 *
 * Authorization tree for tenant identities (unchanged):
 *   - assigned agent              → contacts.agent_id resolves to the effective agents.id
 *   - same-brokerage staff        → broker / team_lead / TC / compliance officer in the contact's brokerage
 *   - anyone else                 → denied
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { isPlatformStaffRole } from "@/lib/platform/platform-staff-roster"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { READ_ONLY_ACTING_ERROR } from "@/lib/platform/acting-context"

export interface ContactAccessRow {
  id:               string
  brokerage_id:     string | null
  agent_id:         string | null
  email:            string | null
  mailing_address:  string | null
  mailing_city:     string | null
  mailing_state:    string | null
  mailing_zip:      string | null
}

export type ContactAccessResult =
  | {
      ok: true
      /** The EFFECTIVE user (the impersonated tenant identity when acting-as). */
      userId: string
      /** The REAL human for audit columns — the staff member when impersonating. */
      actorUserId: string
      contact: ContactAccessRow
    }
  | { ok: false; error: string }

const BROKERAGE_ROLES = new Set([
  "broker", "broker_owner", "team_lead", "team_leader",
  "tc", "transaction_coordinator", "compliance_officer", "compliance_manager",
])

/**
 * Server-side gate: confirm the current caller is allowed to act on the given contact.
 * Returns the contact row on success so callers don't have to refetch.
 *
 * @param opts.intent "write" (default, fail-closed) or "read". Only a read intent
 *        admits a read_only impersonation grant or non-impersonating platform staff.
 */
export async function assertCanActOnContact(
  contactId: string,
  opts?: { intent?: "read" | "write" },
): Promise<ContactAccessResult> {
  const intent = opts?.intent ?? "write"

  // Fresh resolution — getAgentContext re-validates any impersonation grant
  // against the live session row (ended_at/expires_at + staff roster) on every
  // call. Nothing here trusts a caller-supplied or cached flag.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId) return { ok: false, error: "Unauthorized" }

  const actorUserId = ctx.impersonatorUserId ?? ctx.userId

  // read_only NEVER writes — refused before the contact is even looked up.
  if (intent === "write" && ctx.isImpersonating && ctx.impersonationMode !== "full") {
    return { ok: false, error: READ_ONLY_ACTING_ERROR }
  }

  const svc = createServiceClient()
  const { data: contact, error: contactError } = await svc
    .from("contacts")
    .select("id, brokerage_id, agent_id, email, mailing_address, mailing_city, mailing_state, mailing_zip")
    .eq("id", contactId)
    .maybeSingle()

  // supabase-js RESOLVES a failed query — "we could not look" is not "not there".
  if (contactError) return { ok: false, error: `Could not load that contact: ${contactError.message}` }
  if (!contact) return { ok: false, error: "Contact not found" }
  const c = contact as ContactAccessRow

  if (!ctx.isImpersonating) {
    // Platform staff pass — READ ONLY. The staff write lane into a tenant exists
    // only through an active FULL act-as grant (handled below via the
    // impersonated identity), never through raw staff identity.
    const { data: profile, error: profileError } = await svc
      .from("users")
      .select("user_type, platform_role")
      .eq("id", ctx.userId)
      .maybeSingle()
    if (profileError) return { ok: false, error: `Could not resolve your identity: ${profileError.message}` }
    const isStaff =
      profile?.user_type === "superadmin" || isPlatformStaffRole((profile as { platform_role?: string | null } | null)?.platform_role)
    if (isStaff) {
      if (intent === "read") return { ok: true, userId: ctx.userId, actorUserId, contact: c }
      return {
        ok: false,
        error: "Platform staff can only change tenant contacts while acting as the tenant with full access.",
      }
    }
  }

  // ── The tenant tree, evaluated on the EFFECTIVE identity ──────────────────
  // When impersonating (full grant for writes; full or read_only for reads),
  // ctx.userId/agentId/brokerageId/userType are the IMPERSONATED seat's own —
  // so the investigator can act on exactly the contacts that seat can act on.

  // Agent — must own the contact (contacts.agent_id is an agents.id).
  if (ctx.userType === "agent") {
    let agentId = ctx.agentId
    if (!agentId) {
      const { data: a, error: agentError } = await svc
        .from("agents").select("id").eq("user_id", ctx.userId).maybeSingle()
      if (agentError) return { ok: false, error: `Could not resolve your agent profile: ${agentError.message}` }
      agentId = (a as { id?: string } | null)?.id ?? null
    }
    if (agentId && c.agent_id === agentId) return { ok: true, userId: ctx.userId, actorUserId, contact: c }
    return { ok: false, error: "Forbidden — not your contact" }
  }

  // Broker / team-lead / TC / compliance in the contact's brokerage
  if (ctx.userType && BROKERAGE_ROLES.has(ctx.userType) && ctx.brokerageId && ctx.brokerageId === c.brokerage_id) {
    return { ok: true, userId: ctx.userId, actorUserId, contact: c }
  }

  return { ok: false, error: "Forbidden" }
}
