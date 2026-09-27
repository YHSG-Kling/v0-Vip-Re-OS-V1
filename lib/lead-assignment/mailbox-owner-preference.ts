// lib/lead-assignment/mailbox-owner-preference.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE MAILBOX-OWNER PREFERENCE — a rung of THE assignment router, not a second router.
//
// Wave 86 follow-up (lane 86A2, integrator's recommendation on lane 86A's open item #2). Wave 86
// (owner verbatim: "yes all mailboxes should be configured the same.") sends an unknown sender to an
// AGENT's or TEAM LEAD's mailbox RAW → dedup → enrich → dedup → THE gate, exactly like the brokerage
// mailbox — so the lead is the BROKERAGE's (CLAUDE.md §5) and the receiving agent never sees it. The
// raw row records whose mailbox received it (raw_scraped_leads.raw_data.mailbox_owner_kind /
// mailbox_owner_agent_id, stamped by unknown-sender-identification.ts::landUnknownSenderRaw).
//
// THIS RUNG: when such a lead is QUALIFIED and assigned (lib/lead-assignment/tier-routing.ts::
// autoAssignLead → resolveTierRouting — THE one resolver), the brokerage's assignment settings
// PREFER the receiving mailbox's owner. The person wrote to that agent; handing the resulting contact
// to someone else is the surprise, not the rule.
//   · DEFAULT ON. The brokerage admin (or a team lead — team_lead is tenant-admin class) can turn it
//     off in Settings → Lead Routing (app/actions/admin/lead-routing-settings.ts). Stored in the
//     EXISTING jsonb brokerage_settings.settings.lead_routing.prefer_mailbox_owner (no migration);
//     an absent key reads as ON.
//   · STILL THE BROKERAGE'S LEAD. The rung runs only inside autoAssignLead, AFTER the qualification /
//     positive-intent gate — nothing reaches the agent before then, and what reaches them is the
//     CONTACT handleLeadAssigned creates.
//   · FALL THROUGH to the normal rules (never a hold, never a failure) when: the setting is off; the
//     lead did not land from an agent / team-lead mailbox; the owner is not an ACTIVE agents row of
//     THIS brokerage; the owner is out of capacity ("out of seats": working load at/over the
//     capacity guardian's HIGH_LOAD share of the tier ceiling — the same ceiling capacity-pick.ts
//     routes by); the owner's book is on an open transfer (agent_book_transfers status 'active' —
//     they are away and someone else is carrying their work); on a TEAM-tier tenant the owner is not
//     on the routing team's board (teams see only their own board) and is not its team lead; or any
//     read the decision needs is refused (§4 fail closed: an unknown answer is "not preferred", and
//     the normal rules — always legal — decide).
//   · SOLO-tier tenants never reach this rung: the single agent owns every lead already.
//
// The decision is PURE (decideMailboxOwnerPreference) so the proof drives every branch with no DB;
// loadMailboxOwnerFacts gathers the facts, every read tenant-anchored, every error read (§3).

import type { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** The settings key — brokerage_settings.settings.lead_routing.prefer_mailbox_owner. */
export const MAILBOX_OWNER_PREFERENCE_KEY = "prefer_mailbox_owner"
/** Default when the brokerage has never saved the setting (the owner-recommended default). */
export const MAILBOX_OWNER_PREFERENCE_DEFAULT = true

/** PURE — the stored settings jsonb → the effective preference. Absent → the default (ON); only an
 *  explicit boolean false turns it off (a garbage value is not a decision to turn it off). */
export function mailboxOwnerPreferenceFromSettings(settings: unknown): boolean {
  const lr = settings && typeof settings === "object" ? (settings as Record<string, any>).lead_routing : null
  const v = lr && typeof lr === "object" ? (lr as Record<string, unknown>)[MAILBOX_OWNER_PREFERENCE_KEY] : undefined
  return typeof v === "boolean" ? v : MAILBOX_OWNER_PREFERENCE_DEFAULT
}

export interface MailboxOwnerFacts {
  /** The brokerage's setting could be read (null = the read was refused). */
  enabled: boolean | null
  /** raw_data.mailbox_owner_kind of the raw row the lead came from ("agent" | "team_lead" | "brokerage" | null). */
  ownerKind: string | null
  /** raw_data.mailbox_owner_agent_id — agents.id (never users.id). */
  ownerAgentId: string | null
  /** The owner is an ACTIVE agents row of THIS brokerage (null = the read was refused). */
  ownerActive: boolean | null
  /** The owner has capacity headroom (null = unknown). */
  ownerHasHeadroom: boolean | null
  /** The owner's book is on an OPEN transfer (null = the ledger read was refused). */
  ownerOnBookTransfer: boolean | null
  /** TEAM tier only: the owner is on the routing team's board or is its team lead (null = not team tier). */
  ownerOnTeamBoard: boolean | null
  /** The lead-provenance read itself was refused. */
  provenanceError?: string
}

export type MailboxOwnerDecision =
  | { prefer: true; agentId: string; reason: string }
  | { prefer: false; reason: string }

/** PURE — prefer the receiving mailbox's owner, or say exactly why the normal rules decide. */
export function decideMailboxOwnerPreference(f: MailboxOwnerFacts): MailboxOwnerDecision {
  const skip = (reason: string): MailboxOwnerDecision => ({ prefer: false, reason: `mailbox-owner preference skipped — ${reason}` })
  if (f.provenanceError) return skip(`the lead's mailbox provenance could not be read (${f.provenanceError})`)
  if (f.ownerKind !== "agent" && f.ownerKind !== "team_lead") return skip("the lead did not land from an agent or team-lead mailbox")
  if (f.enabled === null) return skip("the brokerage's routing setting could not be read")
  if (!f.enabled) return skip("turned off in the brokerage's lead-routing settings")
  if (!f.ownerAgentId) return skip("the receiving mailbox's owner has no agents row")
  if (f.ownerActive !== true) return skip(f.ownerActive === null ? "the owner's agents row could not be read" : "the owner is not an active agent of this brokerage")
  if (f.ownerOnBookTransfer !== false) return skip(f.ownerOnBookTransfer === null ? "the book-transfer ledger could not be read" : "the owner's book is on an open transfer")
  if (f.ownerHasHeadroom !== true) return skip(f.ownerHasHeadroom === null ? "the owner's load could not be read" : "the owner is out of capacity")
  if (f.ownerOnTeamBoard === false) return skip("the owner is not on the routing team's board")
  return {
    prefer: true, agentId: f.ownerAgentId,
    reason: `mailbox-owner preference — the sender emailed this ${f.ownerKind === "team_lead" ? "team lead's" : "agent's"} own mailbox (brokerage setting on; owner active, with capacity, not on a book transfer)`,
  }
}

/** Gather the facts for one lead. Every read is tenant-anchored and every error is READ; a refused
 *  read becomes `null`, which decideMailboxOwnerPreference treats as "not preferred". */
export async function loadMailboxOwnerFacts(
  supabase: Svc,
  brokerageId: string,
  leadId: string,
  team: { memberIds: string[]; teamLeadAgentId: string | null } | null,
): Promise<MailboxOwnerFacts> {
  const facts: MailboxOwnerFacts = {
    enabled: null, ownerKind: null, ownerAgentId: null, ownerActive: null,
    ownerHasHeadroom: null, ownerOnBookTransfer: null, ownerOnTeamBoard: null,
  }

  const { data: prov, error: provErr } = await supabase
    .from("raw_scraped_leads")
    .select("mailbox_owner_kind:raw_data->>mailbox_owner_kind, mailbox_owner_agent_id:raw_data->>mailbox_owner_agent_id")
    .eq("brokerage_id", brokerageId)
    .eq("lead_id", leadId)
    .eq("source", "inbound_email_unknown")
    .order("created_at", { ascending: true })
    .limit(1)
  if (provErr) return { ...facts, provenanceError: provErr.message }
  const row = ((prov ?? []) as Array<{ mailbox_owner_kind?: string | null; mailbox_owner_agent_id?: string | null }>)[0]
  facts.ownerKind = row?.mailbox_owner_kind ?? null
  facts.ownerAgentId = row?.mailbox_owner_agent_id ?? null
  // Not from an agent / team-lead mailbox → nothing else is worth reading.
  if (facts.ownerKind !== "agent" && facts.ownerKind !== "team_lead") return facts

  const { data: bs, error: bsErr } = await supabase
    .from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  facts.enabled = bsErr ? null : mailboxOwnerPreferenceFromSettings((bs as { settings?: unknown } | null)?.settings)
  if (!facts.enabled || !facts.ownerAgentId) return facts
  const ownerId = facts.ownerAgentId

  const { data: agent, error: agentErr } = await supabase
    .from("agents").select("id").eq("brokerage_id", brokerageId).eq("id", ownerId).eq("is_active", true).maybeSingle()
  facts.ownerActive = agentErr ? null : !!agent
  if (!facts.ownerActive) return facts

  const { data: open, error: openErr } = await supabase
    .from("agent_book_transfers").select("id")
    .eq("brokerage_id", brokerageId).eq("from_agent_id", ownerId).eq("status", "active").limit(1)
  facts.ownerOnBookTransfer = openErr ? null : ((open ?? []) as unknown[]).length > 0
  if (facts.ownerOnBookTransfer !== false) return facts

  try {
    const { agentHasHeadroom } = await import("./capacity-pick")
    facts.ownerHasHeadroom = await agentHasHeadroom(supabase, brokerageId, ownerId)
  } catch {
    facts.ownerHasHeadroom = null
  }

  if (team) facts.ownerOnTeamBoard = team.memberIds.includes(ownerId) || team.teamLeadAgentId === ownerId
  return facts
}
