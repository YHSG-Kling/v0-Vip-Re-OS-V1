// lib/kernel/egress-scope.ts
//
// EGRESS SCOPE (pure) — one resolver for "what does THIS user oversee?" so the Command Center and the
// manager-egress surfaces show the right slice for every tier: a solo agent sees their own work; a
// team lead sees their team; a single-office broker/admin sees the brokerage; a MULTI-LOCATION
// brokerage's location admin sees their location, while the brokerage admin sees ALL locations. Today
// the egress is one undifferentiated pool — this is the scoping that makes the multi-location,
// team, and role tiers real. Pure (no I/O), unit-tested; the loaders apply scopeFilter to their queries.

export type EgressScopeKind = "brokerage" | "location" | "team" | "agent"

export interface EgressUser {
  userType: string
  userId: string
  brokerageId: string
  /** the user's office/location (multi-location brokerages); null for single-office. */
  locationId?: string | null
  /** the user's team, when they belong to one. */
  teamId?: string | null
}

export interface EgressScope {
  kind: EgressScopeKind
  brokerageId: string
  /** non-null only when the scope is narrowed to one location. */
  locationId: string | null
  /** non-null only when the scope is narrowed to one team. */
  teamId: string | null
  /** non-null only when the scope is narrowed to one agent. */
  agentUserId: string | null
  /** brokerage-wide visibility across every location (the top of a multi-location org). */
  seesAllLocations: boolean
}

/** Role families. */
const BROKERAGE_WIDE = new Set(["superadmin", "broker", "broker_admin"])
const ADMIN = new Set(["admin"])
const TEAM_LEVEL = new Set(["team_lead"])

/**
 * Resolve what a user oversees. Pure.
 *
 *  · superadmin / broker / broker_admin → the whole brokerage, ALL locations.
 *  · admin WITH a locationId → that location only (a multi-location office admin).
 *  · admin WITHOUT a locationId → the whole brokerage (single-office admin).
 *  · team_lead → their team.
 *  · everyone else (agent / isa / tc / staff) → their own work.
 */
export function resolveEgressScope(user: EgressUser): EgressScope {
  const base = { brokerageId: user.brokerageId, locationId: null as string | null, teamId: null as string | null, agentUserId: null as string | null }

  if (BROKERAGE_WIDE.has(user.userType)) {
    return { ...base, kind: "brokerage", seesAllLocations: true }
  }
  if (ADMIN.has(user.userType)) {
    if (user.locationId) return { ...base, kind: "location", locationId: user.locationId, seesAllLocations: false }
    return { ...base, kind: "brokerage", seesAllLocations: true }
  }
  if (TEAM_LEVEL.has(user.userType) && user.teamId) {
    return { ...base, kind: "team", teamId: user.teamId, seesAllLocations: false }
  }
  // agent / isa / tc / staff (or a team_lead with no team) → own work.
  return { ...base, kind: "agent", agentUserId: user.userId, seesAllLocations: false }
}

export interface ScopeFilter {
  /** always present — every query is tenant-scoped. */
  brokerage_id: string
  /** apply when narrowing to a location (the loader maps it to its own column). */
  location_id?: string
  team_id?: string
  agent_user_id?: string
}

/** The column filters a scoped query should apply. The loader maps these to its table's columns. Pure. */
export function scopeFilter(scope: EgressScope): ScopeFilter {
  const f: ScopeFilter = { brokerage_id: scope.brokerageId }
  if (scope.kind === "location" && scope.locationId) f.location_id = scope.locationId
  if (scope.kind === "team" && scope.teamId) f.team_id = scope.teamId
  if (scope.kind === "agent" && scope.agentUserId) f.agent_user_id = scope.agentUserId
  return f
}

/** A short human label for the scope (for the Command Center header). Pure. */
export function describeScope(scope: EgressScope): string {
  switch (scope.kind) {
    case "brokerage": return scope.seesAllLocations ? "Brokerage — all locations" : "Brokerage"
    case "location":  return "This location"
    case "team":      return "My team"
    case "agent":     return "My work"
  }
}
