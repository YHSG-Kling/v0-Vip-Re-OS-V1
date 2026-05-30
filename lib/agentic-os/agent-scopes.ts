// lib/agentic-os/agent-scopes.ts
// Agentic-API scope model (agenticapi.com): every action declares a granular scope
// (e.g. "valuation:read", "comms:voice"); an agent must hold it to invoke the action.
// Supports wildcards: "*" (all), "valuation:*" (all valuation actions). Pure — the
// grant SOURCE (agent token, platform-staff = all) is resolved by the caller.

/** Platform staff implicitly hold all scopes. */
export const ALL_SCOPES = "*"

/** Pure: does the granted scope set satisfy the required scope? Supports * and domain:* wildcards. */
export function hasScope(granted: readonly string[] | null | undefined, required: string): boolean {
  if (!granted || granted.length === 0) return false
  if (granted.includes(ALL_SCOPES)) return true
  if (granted.includes(required)) return true
  const domain = required.split(":")[0]
  return granted.includes(`${domain}:*`)
}

/** Pure: filter an action manifest to the actions an agent's scopes can invoke. */
export function authorizedActions<T extends { scope: string }>(actions: T[], granted: readonly string[] | null | undefined): T[] {
  return actions.filter((a) => hasScope(granted, a.scope))
}
