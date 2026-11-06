// lib/kernel/resolve-user-office.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE ANSWER to "which office does this person work out of?"
//
// There are two places an office can be recorded and they exist for different
// people, which is exactly why this has to be one function rather than an
// `?? ` written out at each call site:
//
//   users.location_id   — the PERSON's office. Set by an admin on
//                         Admin → Office Locations. This is the only option for
//                         a pure-admin on a brokerage / multi_location tenant,
//                         because requiresAgentRow() (lib/kernel/
//                         tenant-provisioning-spec.ts) deliberately gives them
//                         no `agents` row at all.
//   agents.location_id  — the producing AGENT's office. Predates m423 and stays
//                         the office of record for anyone who has an agents row;
//                         the brokerage P&L's per-office rollup joins through it.
//
// PRECEDENCE IS users FIRST, and it is a real decision rather than an ordering
// accident: `users.location_id` is what an admin last set deliberately through
// the office UI, while `agents.location_id` can also be written by provisioning
// and import paths. The explicit act wins.
//
// NULL means NOT PINNED — which for an admin means they see the whole
// brokerage. It does not mean "no office found, fail closed": narrowing someone
// is always an explicit act, and inventing a narrowing from missing data would
// silently hide a brokerage's own numbers from its own broker.

import type { SupabaseClient } from "@supabase/supabase-js"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"

export interface UserOffice {
  locationId: string | null
  /** Where the answer came from — for surfaces that explain a scope to a human. */
  source: "user" | "agent" | "none"
}

/**
 * The precedence rule itself, as a pure function.
 *
 * Exists because several callers have ALREADY loaded both rows for other
 * reasons (reporting-kernel builds a whole ctx; the exception center has the
 * agent row in hand). Making them call the async resolver would re-query two
 * tables to re-derive something they are holding — so they get this instead,
 * and the rule still lives in exactly one place. The async `resolveUserOffice`
 * below is a thin wrapper over it, which is what keeps the two from drifting.
 */
export function pickUserOffice(
  userLocationId: string | null | undefined,
  agentLocationId: string | null | undefined,
): UserOffice {
  if (userLocationId) return { locationId: userLocationId, source: "user" }
  if (agentLocationId) return { locationId: agentLocationId, source: "agent" }
  return { locationId: null, source: "none" }
}

/**
 * Resolve one user's office. `client` must be a service client or a session
 * client that can read `users` and `agents` for this tenant.
 *
 * Errors are DESTRUCTURED and logged rather than swallowed: supabase-js resolves
 * a refused read, so `const { data }` alone would turn "permission denied" into
 * "this person has no office" and quietly widen their scope to the whole
 * brokerage. A refused read returns `none` — the same value as genuinely
 * unpinned — so the log line is the only way to tell them apart. Say so loudly.
 */
export async function resolveUserOffice(
  client: SupabaseClient<any, any, any>,
  userId: string,
): Promise<UserOffice> {
  const { data: userRow, error: userErr } = await client
    .from("users")
    .select("location_id")
    .eq("id", userId)
    .maybeSingle()

  if (userErr) {
    console.error(`[resolve-user-office] users read REFUSED for ${userId}: ${userErr.message}`)
  }
  const fromUser = (userRow as { location_id?: string | null } | null)?.location_id ?? null
  if (fromUser) return pickUserOffice(fromUser, null)

  const { data: agentRow, error: agentErr } = await client
    .from("agents")
    .select("location_id")
    .eq("user_id", userId)
    .maybeSingle()

  if (agentErr) {
    console.error(`[resolve-user-office] agents read REFUSED for ${userId}: ${agentErr.message}`)
  }
  const fromAgent = (agentRow as { location_id?: string | null } | null)?.location_id ?? null
  return pickUserOffice(null, fromAgent)
}

// ═════════════════════════════════════════════════════════════════════════════
// THE HIERARCHY ANSWER (wave 150, lane 150C — contract C34): "which offices / teams may this person SEE?"
// The office pin above says where a person WORKS; it never widens what they see. In a multi-location tenant the
// aggregated all-office view needs an explicit TENANT LEADERSHIP grant (organization_members, m958); an office head
// sees their office (an office leadership grant, or the locations.managing_broker_user_id fact), a team lead their
// team (the teams.team_lead_id fact, or a team leadership grant); everyone else their own work. users.user_type
// never widens a multi-location row and superadmin / platform_role never widen any row here; a SINGLE-office tenant
// keeps the CLAUDE.md §4 roster rule. Every read's error is read and any refusal REFUSES (fail closed). The
// writer of the grants is lib/kernel/tenant-creation.ts provisionTenantStructure. Lives here (not beside the
// provisioner) so the read surface (app/dashboard/settings/offices/page.tsx) does not pull the invite graph
// (test:proxy-graph-budget).
// ═════════════════════════════════════════════════════════════════════════════

type HierarchySvc = SupabaseClient<any, any, any>

export interface ScopeMembership { scope_kind: string; location_id: string | null; team_id: string | null; access_level: string; revoked_at?: string | null }

/** Every ACTIVE membership a user holds in ONE tenant (the tenant is the caller's session tenant). Error READ. */
async function readScopeMemberships(svc: HierarchySvc, brokerageId: string, userId: string): Promise<{ ok: true; memberships: ScopeMembership[] } | { ok: false; error: string }> {
  const { data, error } = await svc.from("organization_members").select("scope_kind, location_id, team_id, access_level, revoked_at").eq("brokerage_id", brokerageId).eq("user_id", userId).is("revoked_at", null)
  if (error) return { ok: false, error: error.message }
  return { ok: true, memberships: (data ?? []) as ScopeMembership[] }
}



export interface HierarchyFacts {
  userId: string
  userType: string | null
  tier: string | null
  /** Active offices of THIS tenant. */
  officeIds: string[]
  /** users.location_id. */
  pinnedLocationId: string | null
  memberships: ScopeMembership[]
  /** teams.team_lead_id = userId (the leadership FACT). */
  ledTeamIds: string[]
  /** locations.managing_broker_user_id = userId (the office-head FACT, m661). */
  managedOfficeIds: string[]
  /** team id → its office (teams.location_id), for every team of the tenant. */
  teamOffice: Record<string, string | null>
}

export interface HierarchyScope {
  kind: "tenant" | "offices" | "teams" | "own"
  /** True ONLY for the all-office view. */
  aggregate: boolean
  locationIds: string[]
  teamIds: string[]
  /** Why — one entry per fact or grant that decided it (shown to the human; asserted by the proof). */
  basis: string[]
}

/** PURE: the C34 authorization rule. Never reads platform_role / superadmin; user_type widens only a SINGLE-office
 *  tenant (the §4 roster), never a multi-location one. */
function resolveHierarchyScope(f: HierarchyFacts): HierarchyScope {
  const active = f.memberships.filter((m) => !m.revoked_at)
  const multi = f.tier === "multi_location" || f.officeIds.length >= 2
  if (active.some((m) => m.scope_kind === "tenant" && m.access_level === "leadership")) {
    return { kind: "tenant", aggregate: true, locationIds: [...f.officeIds], teamIds: Object.keys(f.teamOffice), basis: ["tenant leadership grant"] }
  }
  const roster = TENANT_ADMIN_USER_TYPES.has(String(f.userType ?? ""))
  if (!multi && roster) return { kind: "tenant", aggregate: true, locationIds: [...f.officeIds], teamIds: Object.keys(f.teamOffice), basis: ["single-office tenant admin (CLAUDE.md §4 roster)"] }
  const offices = new Set<string>()
  const basis: string[] = []
  for (const m of active) if (m.scope_kind === "location" && m.access_level === "leadership" && m.location_id) { offices.add(m.location_id); basis.push(`office leadership grant ${m.location_id}`) }
  for (const id of f.managedOfficeIds) { offices.add(id); basis.push(`managing broker of ${id}`) }
  if (multi && roster && f.pinnedLocationId) { offices.add(f.pinnedLocationId); basis.push(`office admin pinned to ${f.pinnedLocationId}`) }
  const officeIds = [...offices].filter((id) => f.officeIds.includes(id))
  const teams = new Set<string>()
  for (const id of f.ledTeamIds) { teams.add(id); basis.push(`leads team ${id}`) }
  for (const m of active) if (m.scope_kind === "team" && m.access_level === "leadership" && m.team_id) { teams.add(m.team_id); basis.push(`team leadership grant ${m.team_id}`) }
  for (const [team, office] of Object.entries(f.teamOffice)) if (office && officeIds.includes(office)) teams.add(team)
  const teamIds = [...teams].filter((id) => id in f.teamOffice)
  if (officeIds.length) return { kind: "offices", aggregate: false, locationIds: officeIds, teamIds, basis }
  if (teamIds.length) return { kind: "teams", aggregate: false, locationIds: [], teamIds, basis }
  return { kind: "own", aggregate: false, locationIds: [], teamIds: [], basis: [multi && roster ? "multi-location admin without a leadership grant or office — own work only" : "own work"] }
}

/**
 * The viewer's scope in ONE tenant, from the SESSION's ids (the caller resolved both from the session; never a body).
 * A viewer who does not sit in that tenant is REFUSED (the cross-tenant / cross-tier read refusal). Every read's
 * error is read; any refusal refuses (fail closed).
 */
/** Consumers: loadOfficeDirectory (Settings → Offices) and grantOfficeMembershipAction (app/dashboard/settings/offices/actions.ts — the grant door checks the GRANTER's scope with it). */
export async function resolveViewerHierarchy(svc: HierarchySvc, viewer: { userId: string; brokerageId: string }): Promise<{ ok: true; scope: HierarchyScope; tier: string | null } | { ok: false; error: string }> {
  const { data: u, error: uErr } = await svc.from("users").select("id, brokerage_id, user_type, location_id").eq("id", viewer.userId).maybeSingle()
  if (uErr) return { ok: false, error: `viewer read refused (${uErr.message})` }
  const user = u as { brokerage_id: string | null; user_type: string | null; location_id: string | null } | null
  if (!user || !user.brokerage_id || user.brokerage_id !== viewer.brokerageId) return { ok: false, error: "not a member of this workspace" }
  const [tenantRes, officeRes, teamRes, mem] = await Promise.all([
    svc.from("brokerages").select("plan_tier").eq("id", viewer.brokerageId).maybeSingle(),
    svc.from("locations").select("id, status, managing_broker_user_id").eq("brokerage_id", viewer.brokerageId),
    svc.from("teams").select("id, location_id, team_lead_id, deleted_at").eq("brokerage_id", viewer.brokerageId),
    readScopeMemberships(svc, viewer.brokerageId, viewer.userId),
  ])
  if (tenantRes.error || !tenantRes.data) return { ok: false, error: `plan read refused (${tenantRes.error?.message ?? "no tenant row"})` }
  if (officeRes.error) return { ok: false, error: `offices read refused (${officeRes.error.message})` }
  if (teamRes.error) return { ok: false, error: `teams read refused (${teamRes.error.message})` }
  if (!mem.ok) return { ok: false, error: `memberships read refused (${mem.error})` }
  const offices = (officeRes.data ?? []) as Array<{ id: string; status: string | null; managing_broker_user_id: string | null }>
  const teams = ((teamRes.data ?? []) as Array<{ id: string; location_id: string | null; team_lead_id: string | null; deleted_at: string | null }>).filter((t) => !t.deleted_at)
  const tier = (tenantRes.data as { plan_tier: string | null }).plan_tier ?? null
  const activeOffices = offices.filter((o) => (o.status ?? "active") === "active")
  const scope = resolveHierarchyScope({
    userId: viewer.userId, userType: user.user_type, tier,
    officeIds: activeOffices.map((o) => o.id), pinnedLocationId: user.location_id,
    memberships: mem.memberships, ledTeamIds: teams.filter((t) => t.team_lead_id === viewer.userId).map((t) => t.id),
    managedOfficeIds: activeOffices.filter((o) => o.managing_broker_user_id === viewer.userId).map((o) => o.id),
    teamOffice: Object.fromEntries(teams.map((t) => [t.id, t.location_id])),
  })
  return { ok: true, scope, tier }
}

/** One ACTIVE placement in an office (or one of its teams) — the membership row's audit fields, read back as written. */
interface OfficePlacement {
  userId: string; name: string; team: string | null; access: string; role: string; source: string
  joinedAt: string | null; grantedBy: string | null; evidence: string[]
}

export interface OfficeDirectoryEntry {
  id: string; name: string; officeCode: string | null; legalName: string | null; dba: string | null
  licenseNumber: string | null; licenseState: string | null; city: string | null; state: string | null
  territories: string[]; brandOverrides: Record<string, unknown>; settings: Record<string, unknown>
  seatCap: number | null; seated: number; status: string; createdBy: string | null
  teams: Array<{ id: string; name: string; members: number }>
  placements: OfficePlacement[]
}

/** The Settings → Offices read model: ONLY the offices and teams the viewer's scope admits. */
export async function loadOfficeDirectory(svc: HierarchySvc, viewer: { userId: string; brokerageId: string }): Promise<{ ok: true; scope: HierarchyScope; tier: string | null; offices: OfficeDirectoryEntry[]; unassignedTeams: Array<{ id: string; name: string; members: number }>; people: Array<{ id: string; name: string; userType: string }> } | { ok: false; error: string }> {
  const v = await resolveViewerHierarchy(svc, viewer)
  if (!v.ok) return v
  const { scope } = v
  if (scope.kind === "own") return { ok: true, scope, tier: v.tier, offices: [], unassignedTeams: [], people: [] }
  const [officeRes, teamRes, memRes, pinRes] = await Promise.all([
    svc.from("locations").select("id, name, office_code, legal_name, dba, license_number, license_state, city, state, territories, brand_overrides, settings, seat_cap, status, created_by_user_id").eq("brokerage_id", viewer.brokerageId).order("name"),
    svc.from("teams").select("id, name, location_id, deleted_at").eq("brokerage_id", viewer.brokerageId),
    // Every ACTIVE office / team placement with the audit fields the provisioner wrote (who placed, when, on what evidence).
    svc.from("organization_members").select("user_id, scope_kind, location_id, team_id, access_level, role, source, joined_at, granted_by_user_id, evidence").eq("brokerage_id", viewer.brokerageId).in("scope_kind", ["location", "team"]).is("revoked_at", null),
    svc.from("users").select("location_id").eq("brokerage_id", viewer.brokerageId).not("location_id", "is", null),
  ])
  const refused = officeRes.error ?? teamRes.error ?? memRes.error ?? pinRes.error
  if (refused) return { ok: false, error: `office directory read refused (${refused.message})` }
  // The tenant's staff seats: the people a viewer may PLACE (grantOfficeMembershipAction) and the names behind every
  // placement's user / granter / office creator. Contacts / vendors are never seats. Names resolve ONLY through this
  // tenant-scoped read — a granter outside the tenant (platform staff) is named as such, never looked up across tenants.
  const { data: staff, error: staffErr } = await svc.from("users").select("id, first_name, last_name, email, user_type, location_id").eq("brokerage_id", viewer.brokerageId).not("user_type", "in", "(contact,vendor,lender,system)")
  if (staffErr) return { ok: false, error: `office directory read refused (${staffErr.message})` }
  const staffRows = (staff ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null; user_type: string | null; location_id: string | null }>
  const nameOf = new Map(staffRows.map((u) => [u.id, [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || u.id]))
  const nameOrStaff = (id: string | null) => (id ? nameOf.get(id) ?? "Platform staff" : null)
  type MembershipRow = { user_id: string; scope_kind: string; location_id: string | null; team_id: string | null; access_level: string | null; role: string | null; source: string | null; joined_at: string | null; granted_by_user_id: string | null; evidence: Record<string, unknown> | null }
  const memberships = (memRes.data ?? []) as MembershipRow[]
  const memberCount = new Map<string, number>()
  for (const m of memberships) if (m.scope_kind === "team" && m.team_id) memberCount.set(m.team_id, (memberCount.get(m.team_id) ?? 0) + 1)
  const seated = new Map<string, number>()
  for (const u of (pinRes.data ?? []) as Array<{ location_id: string | null }>) if (u.location_id) seated.set(u.location_id, (seated.get(u.location_id) ?? 0) + 1)
  const teams = ((teamRes.data ?? []) as Array<{ id: string; name: string; location_id: string | null; deleted_at: string | null }>).filter((t) => !t.deleted_at && (scope.aggregate || scope.teamIds.includes(t.id)))
  const teamName = new Map(teams.map((t) => [t.id, t.name]))
  const placement = (m: MembershipRow): OfficePlacement => ({
    userId: m.user_id, name: nameOf.get(m.user_id) ?? m.user_id, team: m.team_id ? teamName.get(m.team_id) ?? null : null,
    access: m.access_level ?? "member", role: m.role ?? "member", source: m.source ?? "admin_grant", joinedAt: m.joined_at ?? null,
    grantedBy: nameOrStaff(m.granted_by_user_id), evidence: Object.keys(m.evidence ?? {}).sort(),
  })
  const offices = ((officeRes.data ?? []) as Array<Record<string, any>>)
    .filter((o) => scope.aggregate || scope.locationIds.includes(o.id) || teams.some((t) => t.location_id === o.id))
    .map((o) => {
      const officeTeams = teams.filter((t) => t.location_id === o.id)
      const officeTeamIds = new Set(officeTeams.map((t) => t.id))
      return {
        id: o.id, name: o.name, officeCode: o.office_code ?? null, legalName: o.legal_name ?? null, dba: o.dba ?? null,
        licenseNumber: o.license_number ?? null, licenseState: o.license_state ?? null, city: o.city ?? null, state: o.state ?? null,
        territories: Array.isArray(o.territories) ? o.territories : [], brandOverrides: o.brand_overrides ?? {}, settings: o.settings ?? {},
        seatCap: typeof o.seat_cap === "number" ? o.seat_cap : null, seated: seated.get(o.id) ?? 0, status: o.status ?? "active",
        createdBy: nameOrStaff(o.created_by_user_id ?? null),
        teams: officeTeams.map((t) => ({ id: t.id, name: t.name, members: memberCount.get(t.id) ?? 0 })),
        placements: memberships
          .filter((m) => (m.scope_kind === "location" && m.location_id === o.id) || (m.scope_kind === "team" && !!m.team_id && officeTeamIds.has(m.team_id)))
          .map(placement)
          .sort((a, b) => a.name.localeCompare(b.name)),
      }
    })
  const unassignedTeams = teams.filter((t) => !t.location_id).map((t) => ({ id: t.id, name: t.name, members: memberCount.get(t.id) ?? 0 }))
  // The people a viewer may PLACE: all staff seats for leadership, otherwise those already in the viewer's offices or not yet in any office.
  const people = staffRows
    .filter((u) => scope.aggregate || !u.location_id || scope.locationIds.includes(u.location_id))
    .map((u) => ({ id: u.id, name: nameOf.get(u.id) ?? u.id, userType: u.user_type ?? "agent" }))
  return { ok: true, scope, tier: v.tier, offices, unassignedTeams, people }
}
