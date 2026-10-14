import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

/**
 * lib/portal/portal-first-access.ts — the client's FIRST portal visit, recorded.
 *
 * WHY THIS IS A SERVICE-CLIENT CORE (lane 87E, found by the swallowed-refusal
 * census — scripts/swallowed-refusal-census.ts):
 *
 * app/portal/[contactId]/layout.tsx ran this block on the CLIENT'S OWN cookie
 * session, and every step of it was refused without a word:
 *   · `portal_contact_invites` has ONE policy, `pci_agent_manage`, scoped to
 *     `agents.user_id = auth.uid()` — a portal client cannot SELECT its own
 *     invite, so `invite` was always null and nothing below it ever ran;
 *   · `contacts` has no UPDATE policy a `contact` seat matches, so the
 *     Accept-Language capture (tier 3 of resolveContactLanguage) matched zero
 *     rows with error null (CLAUDE.md §3) even when it was reached;
 *   · the agent's "just opened their portal" notification was a `void` insert
 *     whose refusal nobody read.
 * So the invite never read "accepted" from this door, the language was never
 * captured, and the agent was never told — and every one of those looked
 * exactly like success.
 *
 * Gate first, then the service client (CLAUDE.md §4): the ONLY caller is the
 * layout's Rule-1 branch (the signed-in user IS this contact, matched by email),
 * and the tenant is the contact row that caller already read — never a
 * parameter a client can choose. Every write is pinned to that brokerage, READS
 * its error, and COUNTS its rows; a refusal is returned and logged, never
 * swallowed, and never blocks portal access.
 *
 * The token-spend door (app/portal/invite/route.ts) remains the survivor for
 * ACCEPTING an invite by token; this handles the magic-link arrival that never
 * passes through it (an invite still at status `sent`), with the same
 * counted-consume shape.
 */
export interface PortalFirstAccessInput {
  contactId: string
  /** contacts.brokerage_id of the row the gated caller read. */
  brokerageId: string | null
  /** contacts.agent_id (agents.id) of that row. */
  agentId: string | null
  contactFirstName: string | null
  /** contacts.metadata as the caller read it — merged, never replaced. */
  existingMetadata: Record<string, unknown> | null
  /** Already resolved by the caller through resolveCapturedLanguage; null = nothing to capture. */
  capturedLanguage: string | null
}

export interface PortalFirstAccessResult {
  accepted: boolean
  languageCaptured: boolean
  agentNotified: boolean
  refusals: string[]
}

/**
 * Invite states a first sign-in consumes. 'sent' is the magic-link arrival; 'pending' is an invite
 * granted WITHOUT a mail (grantPortalAccessForPromotedContact with sendMagicLink:false — the agent
 * shares the link, or the client signs in by OTP on their own). Reading 'sent' alone left that
 * client's first visit unrecorded: the invite never read accepted and the agent was never told —
 * proven live in the wave-93c walk (step 8c, accepted:false with no refusal). 'accepted', 'expired'
 * and 'revoked' are never consumed (portal_contact_invites status CHECK, live 2026-10-01).
 */
const FIRST_ACCESS_CONSUMABLE_STATUSES = ["sent", "pending"] as const

export async function recordPortalFirstAccess(input: PortalFirstAccessInput): Promise<PortalFirstAccessResult> {
  const out: PortalFirstAccessResult = { accepted: false, languageCaptured: false, agentNotified: false, refusals: [] }
  const refuse = (why: string) => {
    out.refusals.push(why)
    console.warn(`[portal-first-access] contact ${input.contactId}: ${why}`)
    return out
  }
  if (!input.brokerageId) return refuse("contact has no brokerage — nothing is written untenanted")
  const svc = createServiceClient()

  const { data: invite, error: inviteError } = await svc
    .from("portal_contact_invites")
    .select("id")
    .eq("contact_id", input.contactId)
    .eq("brokerage_id", input.brokerageId)
    .in("status", [...FIRST_ACCESS_CONSUMABLE_STATUSES])
    .limit(1)
    .maybeSingle()
  if (inviteError) return refuse(`invite read refused: ${inviteError.message}`)
  if (!invite) return out // not a first access — nothing to record

  const { data: consumed, error: consumeError } = await svc
    .from("portal_contact_invites")
    .update({ status: "accepted", accepted_at: new Date().toISOString() })
    .eq("id", (invite as { id: string }).id)
    .eq("brokerage_id", input.brokerageId)
    .in("status", [...FIRST_ACCESS_CONSUMABLE_STATUSES])
    .select("id")
  if (consumeError) return refuse(`invite accept refused: ${consumeError.message}`)
  if ((consumed ?? []).length !== 1) return refuse("invite accept matched no row — already accepted or raced")
  out.accepted = true

  if (input.capturedLanguage && !(input.existingMetadata as { captured_language?: unknown } | null)?.captured_language) {
    const { data: captured, error: captureError } = await svc
      .from("contacts")
      .update({ metadata: { ...(input.existingMetadata ?? {}), captured_language: input.capturedLanguage } })
      .eq("id", input.contactId)
      .eq("brokerage_id", input.brokerageId)
      .select("id")
    if (captureError) refuse(`language capture refused: ${captureError.message}`)
    else if ((captured ?? []).length !== 1) refuse("language capture matched no contact in this brokerage")
    else out.languageCaptured = true
  }

  if (input.agentId) {
    const { data: agent, error: agentError } = await svc
      .from("agents")
      .select("user_id")
      .eq("id", input.agentId)
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle()
    if (agentError) return refuse(`owning agent read refused: ${agentError.message}`)
    const agentUserId = (agent as { user_id: string | null } | null)?.user_id ?? null
    if (!agentUserId) return refuse("owning agent has no user seat to notify")
    const { error: notifyError } = await svc.from("notifications").insert({
      user_id: agentUserId,
      brokerage_id: input.brokerageId,
      type: "portal_first_login",
      title: `${input.contactFirstName || "Your client"} just opened their portal`,
      entity_type: "contact",
      entity_id: input.contactId,
    })
    if (notifyError) return refuse(`agent notification refused: ${notifyError.message}`)
    out.agentNotified = true
  }
  return out
}
