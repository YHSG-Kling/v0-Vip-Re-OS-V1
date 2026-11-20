// lib/kernel/egress-scope.ts
//
// EGRESS SCOPE (pure) — one resolver for "what does THIS user oversee?" so the Command Center and the
// manager-egress surfaces show the right slice for every tier: a solo agent sees their own work; a
// team lead sees their team; a single-office broker/admin sees the brokerage; a MULTI-LOCATION
// brokerage's location admin sees their location, while the brokerage admin sees ALL locations. Today
// the egress is one undifferentiated pool — this is the scoping that makes the multi-location,
// team, and role tiers real. Pure (no I/O), unit-tested; the loaders apply scopeFilter to their queries.
// WAVE 150 (lane 150DAC): on a MULTI-LOCATION tenant the answer comes from the C34 hierarchy
// (egressScopeFromHierarchy, pure; resolveEgressScopeForViewer, the one session-side reader) — the user_type
// ladder below stays the single-office answer.

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
  /** WAVE 150 (lane 150DAC, C34): every office the scope admits when it came from the tenant HIERARCHY
   *  (lib/kernel/resolve-user-office.ts resolveViewerHierarchy) — an office head may lead more than one office.
   *  `locationId` stays the first of them for single-office readers; a loader that honours several reads this. */
  locationIds?: string[]
  /** Every team a hierarchy team scope admits (a lead of several teams); `teamId` is the first. */
  teamIds?: string[]
  /** Why — the hierarchy's own basis lines (shown in the Command Center header; asserted by the proof). */
  basis?: string[]
}

/** Role families. */
// SCOPE LADDER (kept inline — collapsing to a shared admin predicate would move
// roles between tiers). 'superadmin' removed: dead as users.user_type (0 live
// rows; platform staff carry platform_role). 'broker_owner' added: storable,
// owns the brokerage, and previously fell to the "own work" tier below.
const BROKERAGE_WIDE = new Set(["broker", "broker_owner", "broker_admin"])
// Lane 90A: 'compliance_officer' joins the admin tier on the owner's 2026-09-04
// ruling (CLAUDE.md §4 — the sixth tenant-admin seat, TENANT_ADMIN_USER_TYPES).
// Before this it fell through to "own work" below, so every scope this resolver
// decides (Command Center, exception center, reporting, source analytics) showed
// the compliance officer an empty personal slice of a brokerage they administer.
// Same tier as admin: location-aware, brokerage-wide without one. NOT a move of
// any other role between tiers.
const ADMIN = new Set(["admin", "compliance_officer"])
const TEAM_LEVEL = new Set(["team_lead"])

/**
 * Resolve what a user oversees. Pure.
 *
 *  · broker / broker_owner / broker_admin → the whole brokerage, ALL locations.
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

/** The structural shape of lib/kernel/resolve-user-office.ts HierarchyScope (kept structural so this module's
 *  pure half stays import-free; the proof asserts the two agree). */
interface HierarchyScopeLike {
  kind: "tenant" | "offices" | "teams" | "own"
  aggregate: boolean
  locationIds: string[]
  teamIds: string[]
  basis: string[]
}

/**
 * PURE (wave 150, lane 150DAC — lane 150C Outside-lane #4): the egress scope of a viewer on a MULTI-LOCATION tenant,
 * taken from the C34 hierarchy instead of the user_type ladder. users.user_type never widens a multi-location row:
 *  · aggregate (a tenant leadership grant)   → the whole brokerage, ALL locations;
 *  · offices (an office grant / managing broker / an office admin pinned to it) → those offices only;
 *  · teams (a team lead / team grant)        → those teams only;
 *  · own                                      → own work.
 */
function egressScopeFromHierarchy(user: Pick<EgressUser, "userId" | "brokerageId">, h: HierarchyScopeLike): EgressScope {
  const base = { brokerageId: user.brokerageId, locationId: null as string | null, teamId: null as string | null, agentUserId: null as string | null, basis: [...h.basis] }
  if (h.aggregate) return { ...base, kind: "brokerage", seesAllLocations: true }
  if (h.kind === "offices" && h.locationIds.length > 0) {
    return { ...base, kind: "location", locationId: h.locationIds[0], locationIds: [...h.locationIds], teamIds: [...h.teamIds], seesAllLocations: false }
  }
  if (h.kind === "teams" && h.teamIds.length > 0) {
    return { ...base, kind: "team", teamId: h.teamIds[0], teamIds: [...h.teamIds], seesAllLocations: false }
  }
  return { ...base, kind: "agent", agentUserId: user.userId, seesAllLocations: false }
}

type ViewerSvc = any

/**
 * THE SESSION-SIDE RESOLVER (wave 150, lane 150DAC). The caller passes ids it resolved from the SESSION (never a body).
 *  · a SINGLE-office tenant keeps the ladder (resolveEgressScope — byte-identical for every existing tier);
 *  · a MULTI-LOCATION tenant (plan_tier 'multi_location' or ≥ 2 active offices) takes the hierarchy
 *    (resolveViewerHierarchy): seesAllLocations = scope.aggregate, otherwise kind 'location' with scope.locationIds.
 * FAIL CLOSED: a read that cannot run narrows the viewer to their own work and says so in `refusal` — "nobody
 * checked" never renders as "brokerage-wide".
 */
export async function resolveEgressScopeForViewer(svc: ViewerSvc, user: EgressUser): Promise<{ scope: EgressScope; multiLocation: boolean; refusal: string | null }> {
  const own = (refusal: string, multiLocation: boolean) => ({
    scope: { brokerageId: user.brokerageId, locationId: null, teamId: null, agentUserId: user.userId, kind: "agent" as const, seesAllLocations: false, basis: [refusal] },
    multiLocation, refusal,
  })
  const [tenantRes, officeRes] = await Promise.all([
    svc.from("brokerages").select("plan_tier").eq("id", user.brokerageId).maybeSingle(),
    svc.from("locations").select("id, status").eq("brokerage_id", user.brokerageId),
  ])
  if (tenantRes.error || !tenantRes.data) return own(`scope narrowed to your own work — the workspace plan could not be read (${tenantRes.error?.message ?? "no workspace row"})`, false)
  if (officeRes.error) return own(`scope narrowed to your own work — the offices could not be read (${officeRes.error.message})`, false)
  const activeOffices = ((officeRes.data ?? []) as Array<{ status: string | null }>).filter((o) => (o.status ?? "active") === "active").length
  const multiLocation = (tenantRes.data as { plan_tier: string | null }).plan_tier === "multi_location" || activeOffices >= 2
  if (!multiLocation) return { scope: resolveEgressScope(user), multiLocation: false, refusal: null }
  const { resolveViewerHierarchy } = await import("@/lib/kernel/resolve-user-office")
  const h = await resolveViewerHierarchy(svc, { userId: user.userId, brokerageId: user.brokerageId })
  if (!h.ok) return own(`scope narrowed to your own work — your office access could not be read (${h.error})`, true)
  return { scope: egressScopeFromHierarchy(user, h.scope), multiLocation: true, refusal: null }
}

export interface ScopeFilter {
  /** always present — every query is tenant-scoped. */
  brokerage_id: string
  /** apply when narrowing to a location (the loader maps it to its own column). */
  location_id?: string
  /** a hierarchy office scope over SEVERAL offices (the loader applies `.in(column, location_ids)`). */
  location_ids?: string[]
  team_id?: string
  /** a hierarchy team scope over SEVERAL teams. */
  team_ids?: string[]
  agent_user_id?: string
}

/** The column filters a scoped query should apply. The loader maps these to its table's columns. Pure. */
export function scopeFilter(scope: EgressScope): ScopeFilter {
  const f: ScopeFilter = { brokerage_id: scope.brokerageId }
  if (scope.kind === "location" && scope.locationId) f.location_id = scope.locationId
  if (scope.kind === "location" && (scope.locationIds?.length ?? 0) > 1) f.location_ids = [...(scope.locationIds ?? [])]
  if (scope.kind === "team" && scope.teamId) f.team_id = scope.teamId
  if (scope.kind === "team" && (scope.teamIds?.length ?? 0) > 1) f.team_ids = [...(scope.teamIds ?? [])]
  if (scope.kind === "agent" && scope.agentUserId) f.agent_user_id = scope.agentUserId
  return f
}

/** A short human label for the scope (for the Command Center header). Pure. */
export function describeScope(scope: EgressScope): string {
  switch (scope.kind) {
    case "brokerage": return scope.seesAllLocations ? "Brokerage — all locations" : "Brokerage"
    case "location":  return (scope.locationIds?.length ?? 0) > 1 ? `My offices (${scope.locationIds?.length})` : "This location"
    case "team":      return (scope.teamIds?.length ?? 0) > 1 ? `My teams (${scope.teamIds?.length})` : "My team"
    case "agent":     return "My work"
  }
}
