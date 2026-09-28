// lib/lead-assignment/mailbox-owner-preference.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE MAILBOX-OWNER RULE — a rung of THE assignment router, not a second router.
//
// Wave 86 follow-up (lane 86A2) built this as a switchable PREFERENCE. Wave 87 (lane 87A) makes it
// the RULE. Owner, verbatim: "since the email was from the agents' mailbox, it should lead back to the
// agent."
//
// Wave 86 (owner verbatim: "yes all mailboxes should be configured the same.") sends an unknown sender
// to an AGENT's or TEAM LEAD's mailbox RAW → dedup → enrich → dedup → THE gate, exactly like the
// brokerage mailbox — so the lead is the BROKERAGE's (CLAUDE.md §5) and the receiving agent never sees
// it. The raw row records whose mailbox received it (raw_scraped_leads.raw_data.mailbox_owner_kind /
// mailbox_owner_agent_id, stamped by unknown-sender-identification.ts::landUnknownSenderRaw).
//
// THIS RUNG: when such a lead is QUALIFIED and assigned (lib/lead-assignment/tier-routing.ts::
// autoAssignLead → resolveTierRouting — THE one resolver), it goes BACK TO THE MAILBOX'S OWNER.
//   · STILL THE BROKERAGE'S LEAD. The rung runs only inside autoAssignLead, AFTER the qualification /
//     positive-intent gate — nothing reaches the agent before then, and what reaches them is the
//     CONTACT handleLeadAssigned creates.
//   · FALL THROUGH to the normal rules ONLY when the owner cannot take it:
//       – the owner is INACTIVE, or NO LONGER IN THIS BROKERAGE (no active agents row here);
//       – TEAM tier: the owner is OFF the routing team's board (teams see only their own board) and is
//         not its team lead;
//       – the owner's book is on an OPEN transfer (agent_book_transfers status 'active' — they are
//         away) → the lead goes to the COVERING agent the transfer names (to_agent_id), provided that
//         agent is active here (and on the board on a team tier); otherwise the normal rules decide.
//     …plus the two shapes that are not a mailbox-owner lead at all (it did not land from an agent /
//     team-lead mailbox, or its provenance names no agent) and §4 fail-closed: any read the decision
//     needs that is REFUSED is "unknown", and the normal rules — always legal — decide.
//   · TOMBSTONE (lane 87A): the CAPACITY fall-through ("out of seats" read as working load at/over the
//     capacity guardian's HIGH_LOAD share — capacity-pick.ts agentHasHeadroom) is REMOVED: the sender
//     wrote to that agent, and a busy agent is still their agent. Survivor for the capacity test itself:
//     lib/lead-assignment/capacity-pick.ts pickLeastLoadedWithHeadroom (the normal rules' pool pick).
//   · TOMBSTONE (lane 87A): the brokerage ON/OFF SETTING (brokerage_settings.settings.lead_routing.
//     prefer_mailbox_owner — MAILBOX_OWNER_PREFERENCE_KEY / _DEFAULT / mailboxOwnerPreferenceFromSettings,
//     and the Settings → Lead Routing switch with its get/setMailboxOwnerPreference doors) is REMOVED:
//     the owner ruled the direction, so it is not a per-brokerage option. Survivor: this rung, always on.
//   · SOLO-tier tenants never reach this rung: the single agent owns every lead already.
//
// The decision is PURE (decideMailboxOwnerPreference) so the proof drives every branch with no DB;
// loadMailboxOwnerFacts gathers the facts, every read tenant-anchored, every error read (§3).

import type { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface MailboxOwnerFacts {
  /** raw_data.mailbox_owner_kind of the raw row the lead came from ("agent" | "team_lead" | "brokerage" | null). */
  ownerKind: string | null
  /** raw_data.mailbox_owner_agent_id — agents.id (never users.id). */
  ownerAgentId: string | null
  /** The owner is an ACTIVE agents row of THIS brokerage (null = the read was refused). */
  ownerActive: boolean | null
  /** TEAM tier only: the owner is on the routing team's board or is its team lead (null = not team tier). */
  ownerOnTeamBoard: boolean | null
  /** The owner's book is on an OPEN transfer (null = the ledger read was refused). */
  ownerOnBookTransfer: boolean | null
  /** The open transfer's covering agent (agent_book_transfers.to_agent_id — agents.id). */
  coveringAgentId: string | null
  /** The covering agent is an ACTIVE agents row of THIS brokerage (null = unread / refused). */
  coveringActive: boolean | null
  /** TEAM tier only: the covering agent is on the routing team's board or is its team lead. */
  coveringOnTeamBoard: boolean | null
  /** The lead-provenance read itself was refused. */
  provenanceError?: string
}

export type MailboxOwnerDecision =
  | { prefer: true; agentId: string; via: "owner" | "covering_agent"; reason: string }
  | { prefer: false; reason: string }

/** PURE — route back to the receiving mailbox's owner (or the agent covering their book), or say
 *  exactly why the normal rules decide. */
export function decideMailboxOwnerPreference(f: MailboxOwnerFacts): MailboxOwnerDecision {
  const skip = (reason: string): MailboxOwnerDecision => ({ prefer: false, reason: `mailbox-owner rule skipped — ${reason}` })
  if (f.provenanceError) return skip(`the lead's mailbox provenance could not be read (${f.provenanceError})`)
  if (f.ownerKind !== "agent" && f.ownerKind !== "team_lead") return skip("the lead did not land from an agent or team-lead mailbox")
  if (!f.ownerAgentId) return skip("the receiving mailbox's owner has no agents row")
  if (f.ownerActive !== true) return skip(f.ownerActive === null ? "the owner's agents row could not be read" : "the owner is inactive or no longer in this brokerage")
  if (f.ownerOnTeamBoard === false) return skip("the owner is not on the routing team's board")
  if (f.ownerOnBookTransfer === null) return skip("the book-transfer ledger could not be read")
  const whose = f.ownerKind === "team_lead" ? "team lead's" : "agent's"
  if (f.ownerOnBookTransfer) {
    if (!f.coveringAgentId) return skip("the owner's book is on an open transfer that names no covering agent")
    if (f.coveringActive !== true) return skip(f.coveringActive === null ? "the covering agent's agents row could not be read" : "the covering agent is inactive or no longer in this brokerage")
    if (f.coveringOnTeamBoard === false) return skip("the covering agent is not on the routing team's board")
    return {
      prefer: true, agentId: f.coveringAgentId, via: "covering_agent",
      reason: `mailbox-owner rule — the sender emailed this ${whose} own mailbox; their book is on an open transfer, so the lead goes to the covering agent per the transfer`,
    }
  }
  return {
    prefer: true, agentId: f.ownerAgentId, via: "owner",
    reason: `mailbox-owner rule — the sender emailed this ${whose} own mailbox (owner active in this brokerage, not on a book transfer)`,
  }
}

/** Gather the facts for one lead. Every read is tenant-anchored and every error is READ; a refused
 *  read becomes `null`, which decideMailboxOwnerPreference treats as "the normal rules decide". */
export async function loadMailboxOwnerFacts(
  supabase: Svc,
  brokerageId: string,
  leadId: string,
  team: { memberIds: string[]; teamLeadAgentId: string | null } | null,
): Promise<MailboxOwnerFacts> {
  const facts: MailboxOwnerFacts = {
    ownerKind: null, ownerAgentId: null, ownerActive: null, ownerOnTeamBoard: null,
    ownerOnBookTransfer: null, coveringAgentId: null, coveringActive: null, coveringOnTeamBoard: null,
  }
  const onBoard = (agentId: string) => (team ? team.memberIds.includes(agentId) || team.teamLeadAgentId === agentId : null)

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
  if (!facts.ownerAgentId) return facts
  const ownerId = facts.ownerAgentId

  const { data: agent, error: agentErr } = await supabase
    .from("agents").select("id").eq("brokerage_id", brokerageId).eq("id", ownerId).eq("is_active", true).maybeSingle()
  facts.ownerActive = agentErr ? null : !!agent
  if (!facts.ownerActive) return facts

  facts.ownerOnTeamBoard = onBoard(ownerId)
  if (facts.ownerOnTeamBoard === false) return facts

  const { data: open, error: openErr } = await supabase
    .from("agent_book_transfers").select("to_agent_id")
    .eq("brokerage_id", brokerageId).eq("from_agent_id", ownerId).eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
  if (openErr) { facts.ownerOnBookTransfer = null; return facts }
  const transfer = ((open ?? []) as Array<{ to_agent_id?: string | null }>)[0]
  facts.ownerOnBookTransfer = !!transfer
  if (!transfer) return facts

  // THE COVERING AGENT per the transfer — the same active-in-this-brokerage test the owner passed.
  facts.coveringAgentId = transfer.to_agent_id ?? null
  if (!facts.coveringAgentId) return facts
  const coverId = facts.coveringAgentId
  const { data: cover, error: coverErr } = await supabase
    .from("agents").select("id").eq("brokerage_id", brokerageId).eq("id", coverId).eq("is_active", true).maybeSingle()
  facts.coveringActive = coverErr ? null : !!cover
  if (facts.coveringActive) facts.coveringOnTeamBoard = onBoard(coverId)
  return facts
}
