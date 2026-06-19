// lib/voice/team-command-names.ts
//
// PURE catalog of the team-coordination command names — the single source of truth for
// "which commands the dispatcher routes", importable by client/test code WITHOUT pulling in
// the server-only dispatcher (lib/voice/team-commands.ts re-exports these). Keeps the NL parser
// + its simulator able to assert "the parser only emits a real, dispatchable command" with no
// server-only import and no drift.

/** The read-only bullpen commands. */
export const TEAM_QUERY_COMMANDS = new Set<string>(["team_query", "area_query", "morning_standup"])

/** The ACTING commands — each delegates to a backend that enforces its own gate. */
export const TEAM_ACTION_COMMANDS = new Set<string>(["standup_action", "voice_followup", "start_marketing", "cut_promo"])

/** Read-only buyer commands — search inventory + the market for a buyer. */
export const BUYER_COMMANDS = new Set<string>(["find_properties"])

/** All team-coordination commands the dispatcher routes (read-only + acting + buyer). */
export const TEAM_COMMANDS = new Set<string>([...TEAM_QUERY_COMMANDS, ...TEAM_ACTION_COMMANDS, ...BUYER_COMMANDS])

export function isTeamCommand(name: string): boolean {
  return TEAM_COMMANDS.has(name)
}
