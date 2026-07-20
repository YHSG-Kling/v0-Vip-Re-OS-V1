// lib/voice/team-command-names.ts
//
// PURE catalog of the team-coordination command names — the single source of truth for
// "which commands the dispatcher routes", importable by client/test code WITHOUT pulling in
// the server-only dispatcher (lib/voice/team-commands.ts re-exports these). Keeps the NL parser
// + its simulator able to assert "the parser only emits a real, dispatchable command" with no
// server-only import and no drift.

/** The read-only bullpen commands. ask_guidance is the on-demand educator —
 *  "how do I…?" answered from the published curriculum, gaps logged so the
 *  library grows from real questions. */
export const TEAM_QUERY_COMMANDS = new Set<string>(["team_query", "area_query", "morning_standup", "ask_guidance", "quarterly_review"])

/** The ACTING commands — each delegates to a backend that enforces its own gate.
 *  kernel_proposals/kernel_resolve are the document kernel's spoken loop: list the
 *  open amber proposals, resolve one by rank — the SAME cores the feed buttons use.
 *  Round 36 closed the rest of the deal-decision family (reject/counter/withdraw
 *  ride the SAME kernel transitions via client-param overloads) plus the spoken
 *  showing request (canonical requestShowing, BBA gate inside, fails closed). */
export const TEAM_ACTION_COMMANDS = new Set<string>([
  "standup_action", "voice_followup", "start_marketing", "cut_promo", "kernel_proposals", "kernel_resolve",
  "accept_offer", "reject_offer", "counter_offer", "withdraw_offer", "stage_showing",
])

/** Read-only buyer commands — search inventory + the market for a buyer. */
export const BUYER_COMMANDS = new Set<string>(["find_properties"])

/** BROKER-LANE commands (round 36) — principal/manager-gated backends
 *  (lib/voice/broker-commands.ts); each re-checks its role guard server-side
 *  AND the canonical action re-runs its own gate. Leads policy: promote_lead
 *  is brokerage+platform only — never agent-speakable. Broadcast is in-app only. */
export const BROKER_COMMANDS = new Set<string>(["promote_lead", "reassign_contact", "broadcast_announcement"])

/** All team-coordination commands the dispatcher routes (read-only + acting + buyer + broker). */
export const TEAM_COMMANDS = new Set<string>([...TEAM_QUERY_COMMANDS, ...TEAM_ACTION_COMMANDS, ...BUYER_COMMANDS, ...BROKER_COMMANDS])

export function isTeamCommand(name: string): boolean {
  return TEAM_COMMANDS.has(name)
}
