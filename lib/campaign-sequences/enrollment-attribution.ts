/**
 * SEQUENCE CREDIT FOLLOWS THE CONTACT — the ONE attribution rule for sequence reports.
 *
 * Lane 82E proved the SEND half: lib/campaign-sequences/step-executor.ts resolves the
 * sender from contacts.agent_id at SEND time, so after a book move (lib/agents/
 * agent-books.ts) the next step of an in-flight sequence goes out from whoever holds the
 * contact now. The REPORT half did not follow: lib/brokerage-intelligence/miners.ts and
 * app/actions/workflow-reports.ts credited `sequence_enrollments.enrolled_by` — the
 * ENROLLER — so an inherited contact's sequence kept reporting under the agent who left.
 *
 * The rule, in one place so both reports agree:
 *   · CREDIT goes to the CURRENT holder — contacts.agent_id (an agents.id; FK agents) and
 *     that agent's login, agents.user_id (users.id).
 *   · `enrolled_by` (FK users) is HISTORY — who started it. It is kept, returned beside
 *     the credit, and never overwritten; `inherited` says the two differ.
 *   · A lead enrollment (contact_id null) or an unassigned contact credits NOBODY: leads
 *     belong to the brokerage (CLAUDE.md §5), so they count in the brokerage view only.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { resolveUserIdsForAgentRecords } from "@/lib/kernel/agent-identity"

export interface ContactHolder {
  /** contacts.agent_id — agents.id of the agent who holds the contact NOW. */
  agentId: string | null
  /** agents.user_id of that agent — users.id, the class enrolled_by is written in. */
  userId: string | null
}

export interface EnrollmentCredit {
  creditedAgentId: string | null
  creditedUserId: string | null
  /** sequence_enrollments.enrolled_by — users.id of the enroller; history, never the credit. */
  enrolledBy: string | null
  /** true when a known enroller is not the current holder — the contact was inherited. */
  inherited: boolean
}

/** PURE — the credit for one enrollment row given the holder of its contact. */
export function creditEnrollment(
  row: { contact_id: string | null; enrolled_by: string | null },
  holder: ContactHolder | undefined,
): EnrollmentCredit {
  const creditedAgentId = row.contact_id ? holder?.agentId ?? null : null
  const creditedUserId = row.contact_id ? holder?.userId ?? null : null
  const enrolledBy = row.enrolled_by ?? null
  const inherited = !!enrolledBy && !!creditedUserId && enrolledBy !== creditedUserId
  return { creditedAgentId, creditedUserId, enrolledBy, inherited }
}

/**
 * The current holder of each contact, tenant-pinned. Chunked `.in()` reads; a refused
 * read is returned as a refusal (supabase-js resolves refusals — CLAUDE.md §3).
 */
export async function loadContactHolders(
  supabase: Pick<SupabaseClient, "from">,
  brokerageId: string,
  contactIds: ReadonlyArray<string>,
): Promise<{ ok: true; holders: Map<string, ContactHolder> } | { ok: false; error: string }> {
  const holders = new Map<string, ContactHolder>()
  const ids = Array.from(new Set(contactIds.filter(Boolean)))
  if (!brokerageId || ids.length === 0) return { ok: true, holders }

  const agentIdByContact = new Map<string, string | null>()
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from("contacts")
      .select("id, agent_id")
      .eq("brokerage_id", brokerageId)
      .in("id", ids.slice(i, i + 200))
    if (error) return { ok: false, error: `contacts (current holder) read refused: ${error.message}` }
    for (const c of (data ?? []) as Array<{ id: string; agent_id: string | null }>) {
      agentIdByContact.set(c.id, c.agent_id ?? null)
    }
  }

  const agentIds = Array.from(new Set(Array.from(agentIdByContact.values()).filter((a): a is string => !!a)))
  const users = await resolveUserIdsForAgentRecords(supabase, brokerageId, agentIds)
  if (!users.ok) return { ok: false, error: users.error }

  for (const [contactId, agentId] of agentIdByContact) {
    holders.set(contactId, { agentId, userId: agentId ? users.userIdByAgentId.get(agentId) ?? null : null })
  }
  return { ok: true, holders }
}
