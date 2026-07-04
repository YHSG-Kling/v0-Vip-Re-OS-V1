// lib/kernel/tenant-provisioning-spec.ts
//
// PURE, server-safe tier→required-rows spec for tenant / user provisioning.
// Kept in a plain module (NOT "use server") so the SAME logic drives both the
// kernel provisioner (lib/kernel/users.ts) and the simulator — no drift, and
// unit-testable in isolation. Encodes the business truth of each tier:
//
//   • solo_agent  — the owner IS the producing agent (needs an agents row).
//   • team        — the owner is the producing team LEAD (agents row) + a teams row.
//   • brokerage / multi_location — the owner is a pure administrator (no agents row);
//                    producing agents are invited later.

/** Roles that ALWAYS carry a book of business (contacts.agent_id → agents.id). */
export const AGENT_ROLES = new Set<string>(["agent", "isa", "team_lead"])

/** Tiers whose OWNER (admin/broker) is themselves a producing agent. */
export const OWNER_AGENT_TIERS = new Set<string>(["solo_agent", "team"])

/** Does this (role, tier) require an agents row? AGENT_ROLES always; plus the
 *  admin/broker OWNER of a solo_agent or team tenant — without it they cannot own
 *  a single contact / listing / transaction. */
export function requiresAgentRow(userType: string, tier?: string | null): boolean {
  if (AGENT_ROLES.has(userType)) return true
  if ((userType === "admin" || userType === "broker") && !!tier && OWNER_AGENT_TIERS.has(tier)) return true
  return false
}

/** agent_onboarding is AGENT-SCOPED (agent_id is NOT NULL, FK → agents.id), so a
 *  row exists exactly when an agents row exists. A pure-admin owner
 *  (brokerage / multi_location) tracks onboarding at brokerages.onboarding_status. */
export function requiresOnboardingRow(userType: string, tier?: string | null): boolean {
  return requiresAgentRow(userType, tier)
}

/** A team tenant must have a teams row (team = team_lead + teams row). */
export function ownerNeedsTeamRow(tier: string): boolean {
  return tier === "team"
}
