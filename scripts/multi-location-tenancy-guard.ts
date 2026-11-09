#!/usr/bin/env tsx
/**
 * scripts/multi-location-tenancy-guard.ts   (npm run test:multi-location-tenancy)   — wave 150, lane 150C, contract C34
 * ─────────────────────────────────────────────────────────────────────────────
 * CANARY 1 + THE NAME-COLLISION NEGATIVE, driven on the in-memory client with the REAL provisioning core
 * (lib/kernel/tenant-creation.ts createTenantCore → provisionTenantStructure) and the REAL hierarchy answer
 * (lib/kernel/resolve-user-office.ts resolveViewerHierarchy / loadOfficeDirectory) and seat gate
 * (lib/kernel/seat-usage.ts locationSeatGate):
 *
 *   T1  a SOLO created by staff (active — not a trial) and a SOLO self-enrolled (trial) declaring "Coastal Realty";
 *       a TEAM with seats; a BROKERAGE with its office (paid self-enrollment — a hosted checkout, not a trial); a
 *       BROKERAGE WITH TWO SAME-NAME LOCATIONS ("Coastal Realty" × 2) and DISTINCT teams — each provisions with its
 *       snapshot, website, brand, owner invite, role, plan/entitlement row and explicit memberships.
 *   T2  AUTHORIZATION — aggregated only with a tenant leadership grant; office heads see their office; team leads
 *       their team; agents their own work; a user_type / superadmin / platform_role never widens a multi-location row.
 *   T3  NAME COLLISION (negative) — two same-name offices stay two offices with their own teams and their heads never
 *       see each other's; the solo whose declared affiliation spells the brokerage's name holds NO membership, is
 *       refused as a viewer, and cannot be placed (only the consented transfer rail moves a person between tenants).
 *   T4  SEAT OWNERSHIP + REPAIR — an office over its own seat cap refuses the placement, routes it to the Recruiting
 *       Manager IN THE REQUEST, notifies the office's managing broker, and the resume finishes it once the cap allows.
 *   T5  CONSENTED-TRANSFER PLACEMENT — after the rail moved the person, the structure places them in the target office
 *       with source 'transfer' and the request's evidence; before the move it refuses.
 *   T6  STATIC — migrations' line-1 stamps, m958's dropped session write policies and composite FKs, the vocabulary
 *       matching the CHECKs, and the stripped-source census: no tenant / office / team read filters by name; the
 *       post-L1 membership RULE (one active row per scope, several scopes per person; a racing 23505 is idempotent).
 *   T8  SEAT REASSIGNMENT / SEVERAL MEMBERSHIPS / REVOCATION (wave 151, lane 151A) — a `reassign` move ends the other
 *       office placements (stamped, kept), an add keeps them (several memberships promote nobody), revokeScopeMemberships
 *       is the ONE counted revocation, the keep rule, and the reader census (no one-row-per-person read anywhere).
 *
 * BLIND SPOTS: Supabase Auth and Stripe are injected (counted, not run); RLS policies are proven by reading m958, not
 * by a live session; the composite FKs are read from SQL, not exercised against Postgres; the live per-scope UNIQUE
 * (NULLS NOT DISTINCT, partial on revoked_at IS NULL) is modelled only on team rows (the in-memory UNIQUE skips NULL keys).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"
import { randomUUID } from "node:crypto"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const _require = createRequire(import.meta.url)
let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

type Client = MemClient & { invites: string[] }
function client(seed: Record<string, Row[]>): Client {
  const base: any = memSupabase({ lifecycle_events: [], manager_signals: [], notifications: [], agent_action_ledger: [], organization_members: [], locations: [], ...seed }, { uuidIds: true, stampCreatedAt: true })
  base.invites = []
  base.rpc = async () => ({ data: null, error: null })
  const orig = base.from.bind(base)
  base.from = (table: string) => {
    const q: any = orig(table)
    if (table === "manager_signals") { const ins = q.insert.bind(q); q.insert = (p: any) => ins(Array.isArray(p) ? p.map((r: any) => ({ status: "open", ...r })) : { status: "open", ...p }) }
    return q
  }
  return base as Client
}
let ACTIVE: Client = client({})
;(globalThis as any).__MLT_SERVICE__ = () => ACTIVE
{
  const isServiceLeaf = (r: string) => r === "@/lib/supabase/service" || /[\\/]lib[\\/]supabase[\\/]service(\.ts)?$/.test(r)
  const nodeModule: any = _require("node:module")
  const realLoad = nodeModule._load
  nodeModule._load = function (request: string, ...rest: unknown[]) {
    if (isServiceLeaf(request)) return { createServiceClient: (globalThis as any).__MLT_SERVICE__, createClient: (globalThis as any).__MLT_SERVICE__ }
    if (request === "server-only" || /[\\/]node_modules[\\/]server-only[\\/]/.test(request)) return {}
    return realLoad.call(this, request, ...rest)
  }
  const SHIM = "vipre-mlt-proof:service"
  const loader = `
export async function resolve(specifier, context, next) {
  if (specifier === "@/lib/supabase/service") return { shortCircuit: true, url: ${JSON.stringify(SHIM)} }
  const r = await next(specifier, context)
  if (/[\\\\/]lib[\\\\/]supabase[\\\\/]service\\.ts$/.test(r.url ?? "")) return { shortCircuit: true, url: ${JSON.stringify(SHIM)} }
  return r
}
export async function load(url, context, next) {
  if (url === ${JSON.stringify(SHIM)}) return { shortCircuit: true, format: "module", source: "export const createServiceClient = () => globalThis.__MLT_SERVICE__(); export const createClient = createServiceClient" }
  return next(url, context)
}`
  const { register } = await import("node:module")
  try { register(`data:text/javascript,${encodeURIComponent(loader)}`) } catch { /* the CJS patch above still holds */ }
}
const { createTenantCore, resumeTenantProvisioning, provisionTenantStructure, planTenantOffices, MEMBERSHIP_ACCESS_LEVELS } = await import("../lib/kernel/tenant-creation")
const { resolveViewerHierarchy, loadOfficeDirectory } = await import("../lib/kernel/resolve-user-office")
const { locationSeatGate } = await import("../lib/kernel/seat-usage")
const { OPERATION_SIGNAL_TYPE } = await import("../lib/kernel/immediate-operations")
type LocationSeatGateReasonCheck = import("../lib/kernel/seat-usage").LocationSeatGateReason
type _Types = [import("../lib/kernel/tenant-creation").OfficeInput, import("../lib/kernel/tenant-creation").StructureMemberInput, import("../lib/kernel/tenant-creation").TenantStructureInput, import("../lib/kernel/tenant-creation").TenantStructureRecord, import("../lib/kernel/tenant-creation").ProvisionStructureParams, import("../lib/kernel/tenant-creation").StructureDeps, import("../lib/kernel/tenant-creation").MembershipAccessLevel, import("../lib/kernel/resolve-user-office").ScopeMembership, import("../lib/kernel/resolve-user-office").HierarchyFacts, import("../lib/kernel/resolve-user-office").HierarchyScope, import("../lib/kernel/resolve-user-office").OfficeDirectoryEntry, import("../lib/kernel/seat-usage").LocationSeatGateVerdict, LocationSeatGateReasonCheck]

const TIERS = ["solo_agent", "team", "brokerage", "multi_location"]
const seed = (): Record<string, Row[]> => ({
  subscription_tiers: TIERS.map((t) => ({ id: randomUUID(), tier_name: t, is_active: true, max_agents: t === "solo_agent" ? 2 : t === "team" ? 10 : null, monthly_price_cents: 0, annual_price_cents: 0, setup_fee_cents: 0, display_name: t })),
  platform_config_snapshots: TIERS.map((t) => ({ id: randomUUID(), name: `${t} funnel`, created_at: "2026-10-01T00:00:00.000Z", payload: { recommendedTier: t, global: { app_name: "VIP" }, brand: { tagline: `${t} tagline` }, site: { about_text: "about" }, features: [] } })),
  learning_modules: [], brokerages: [], users: [], subscriptions: [], global_settings: [], brokerage_brand_settings: [], brand_voice_profile: [],
  feature_access_overrides: [], platform_prospects: [], ai_identity_profiles: [], agents: [], learning_assignments: [], user_invitations: [], teams: [],
  user_role_assignments: [], agent_onboarding: [], agent_commission_profiles: [], superadmin_audit_log: [], brokerage_settings: [],
})
ACTIVE = client(seed())
const svc = ACTIVE
const STAFF = randomUUID()
svc.tables.users.push({ id: STAFF, email: "staff@platform.test", user_type: "agent", platform_role: "platform_admin", brokerage_id: null })
const deps = {
  provisionOwner: async (p: any) => {
    const id = randomUUID()
    svc.tables.users.push({ id, email: p.email, first_name: p.firstName, last_name: p.lastName, user_type: p.tier === "solo_agent" || p.tier === "team" ? "agent" : "broker_owner", brokerage_id: p.brokerageId, status: "active" })
    svc.invites.push(p.email)
    return { success: true, userId: id, agentId: null, teamId: null, inviteSent: true }
  },
  isaActor: async () => ({}), starterAssistant: async () => ({}), curriculum: async () => ({ authored: 0, topics: 0 }),
  accountRepair: async () => ({ success: true, repaired: [] }),
  readiness: async () => ({ ready: true, blockers: [], checkedAt: new Date().toISOString() }),
  checkout: async () => ({ ok: true, url: "https://checkout.example.test/s/1", setupFeeCents: 0, setupFeeWaived: false }),
  structure: {
    invite: async (a: any) => {
      if (/fail/.test(a.email)) return { success: false, userId: null, error: "auth invite refused (fixture)" }
      const id = randomUUID()
      svc.tables.users.push({ id, email: a.email, first_name: a.firstName, last_name: a.lastName, user_type: a.userType, brokerage_id: a.brokerageId, team_id: a.teamId, location_id: null, status: "active" })
      svc.invites.push(a.email)
      return { success: true, userId: id }
    },
  },
} as any
const make = async (input: any) => { try { return await createTenantCore(svc, { adminLastName: "Lee", ...input }, deps) } catch (e) { return { ok: false, error: `threw: ${(e as Error).message}`, extrasSkipped: [] } as any } }
const userByEmail = (e: string) => svc.tables.users.find((u) => u.email === e.toLowerCase())
const mems = (b: string, u?: string) => svc.tables.organization_members.filter((m) => m.brokerage_id === b && (!u || m.user_id === u) && !m.revoked_at)
const sub = (b: string) => svc.tables.subscriptions.filter((s) => s.brokerage_id === b)

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[T1 · canary 1 — every tier provisions: snapshot, site, brand, invite, role, entitlement, memberships]")
const soloStaff = await make({ brokerageName: "Maya Brooks Homes", adminEmail: "maya@solo.test", adminFirstName: "Maya", tier: "solo_agent", signupSource: "superadmin", billing: { mode: "active", billingCycle: "monthly" }, callerUserId: STAFF })
const soloSelf = await make({ brokerageName: "Coastal Realty", adminEmail: "sam@solo.test", adminFirstName: "Sam", tier: "solo_agent", signupSource: "self_serve", billing: { mode: "trial", trialDays: 14 }, callerUserId: null, declaredAffiliation: { name: "Coastal Realty", licenseState: "FL" } })
const team = await make({ brokerageName: "Ridgeline Team", adminEmail: "lead@team.test", adminFirstName: "Rae", tier: "team", signupSource: "self_serve", billing: { mode: "trial" }, callerUserId: null,
  structure: { members: [{ email: "a1@team.test", firstName: "Ana", userType: "agent", teamName: "Ridgeline Team" }, { email: "a2@team.test", firstName: "Ben", userType: "agent", teamName: "Ridgeline Team" }] } })
const brk = await make({ brokerageName: "Gulf Shore Brokerage", adminEmail: "owner@gulf.test", adminFirstName: "Gil", tier: "brokerage", signupSource: "self_serve", billing: { mode: "paid", billingCycle: "monthly" }, callerUserId: null,
  structure: { offices: [{ officeCode: "main", name: "Gulf Shore Brokerage", legalName: "Gulf Shore Brokerage LLC", licenseNumber: "CQ1234", licenseState: "FL", city: "Pensacola", state: "FL", territories: ["32501"], brandOverrides: { tagline: "Gulf by heart" } }],
    members: [{ email: "agent@gulf.test", firstName: "Gia", userType: "agent", officeCode: "main" }] } })
const multi = await make({ brokerageName: "Coastal Realty", adminEmail: "owner@coastal.test", adminFirstName: "Cora", tier: "multi_location", signupSource: "superadmin", billing: { mode: "active", billingCycle: "annual" }, callerUserId: STAFF,
  structure: {
    offices: [
      { officeCode: "dt", name: "Coastal Realty", legalName: "Coastal Realty Downtown LLC", licenseNumber: "CQ9001", licenseState: "FL", city: "Pensacola", state: "FL", territories: ["32501", "32502"], brandOverrides: { primary_color: "#0b3d91", logo_url: "https://cdn.example.test/dt.png" }, settings: { permissions: { agents_export: false } }, seatCap: 2, teams: [{ name: "Harbor Team" }] },
      { officeCode: "bch", name: "Coastal Realty", legalName: "Coastal Realty Beaches LLC", licenseNumber: "CQ9002", licenseState: "FL", city: "Navarre", state: "FL", territories: ["32566"], brandOverrides: { primary_color: "#7a1f1f" }, teams: [{ name: "Ridge Team" }] },
    ],
    members: [
      { email: "head.dt@coastal.test", firstName: "Dee", userType: "broker", officeCode: "dt", officeLeadership: true },
      { email: "lead.harbor@coastal.test", firstName: "Hal", userType: "agent", officeCode: "dt", teamName: "Harbor Team", leadsTeam: true },
      { email: "head.bch@coastal.test", firstName: "Bea", userType: "broker", officeCode: "bch", officeLeadership: true },
      { email: "agent.ridge@coastal.test", firstName: "Rio", userType: "agent", officeCode: "bch", teamName: "Ridge Team" },
      { email: "overflow@coastal.test", firstName: "Ova", userType: "agent", officeCode: "dt" },
    ],
  } })
const all = { soloStaff, soloSelf, team, brk, multi } as Record<string, any>
for (const [k, r] of Object.entries(all)) {
  const b = svc.tables.brokerages.find((x) => x.id === r.brokerageId)
  check(`T1 ${k}: created (${r.ok ? "ok" : r.error}), snapshot applied (${r.snapshotName}), website ${r.websitePath}, owner invited, one subscription row, owner holds TENANT LEADERSHIP`,
    r.ok === true && !!b && r.snapshotName === `${b.plan_tier} funnel` && /^\/site\//.test(r.websitePath ?? "") && svc.invites.includes(String(b.email)) && sub(r.brokerageId).length === 1
      && mems(r.brokerageId, r.userId).some((m) => m.scope_kind === "tenant" && m.access_level === "leadership" && m.source === "provisioning"),
    JSON.stringify({ ok: r.ok, err: r.error, snap: r.snapshotName, subs: sub(r.brokerageId ?? "").length, mem: mems(r.brokerageId ?? "", r.userId).length, s: r.structure?.errors }))
}
check("T1 not every subscription is a trial: staff solo + multi are 'active' (no trial_end), the self-enrolled solo is 'trialing' with trial_end, the paid brokerage minted a hosted checkout",
  sub(soloStaff.brokerageId)[0]?.status === "active" && !sub(soloStaff.brokerageId)[0]?.trial_end && sub(multi.brokerageId)[0]?.status === "active"
    && sub(soloSelf.brokerageId)[0]?.status === "trialing" && !!sub(soloSelf.brokerageId)[0]?.trial_end && brk.checkoutUrl === "https://checkout.example.test/s/1")
check("T1 solo + team carry NO offices; the brokerage has exactly its head office with its own legal identity, licence, territories and brand overrides",
  svc.tables.locations.filter((l) => [soloStaff.brokerageId, soloSelf.brokerageId, team.brokerageId].includes(l.brokerage_id)).length === 0
    && svc.tables.locations.filter((l) => l.brokerage_id === brk.brokerageId).length === 1
    && svc.tables.locations.some((l) => l.brokerage_id === brk.brokerageId && l.office_code === "main" && l.legal_name === "Gulf Shore Brokerage LLC" && l.license_state === "FL" && l.territories?.[0] === "32501" && l.brand_overrides?.tagline === "Gulf by heart"))
const teamRow = svc.tables.teams.find((t) => t.brokerage_id === team.brokerageId)
check("T1 team: the team is anchored on the owner (team_lead_id FACT) with a team leadership grant; both seats invited NOW with team memberships",
  !!teamRow && teamRow.team_lead_id === team.userId && mems(team.brokerageId, team.userId).some((m) => m.scope_kind === "team" && m.access_level === "leadership" && m.team_id === teamRow.id)
    && ["a1@team.test", "a2@team.test"].every((e) => { const u = userByEmail(e); return !!u && u.brokerage_id === team.brokerageId && svc.invites.includes(e) && mems(team.brokerageId, u.id).some((m) => m.scope_kind === "team" && m.team_id === teamRow.id && m.access_level === "member") }))
const gia = userByEmail("agent@gulf.test")
const gulfOffice = svc.tables.locations.find((l) => l.brokerage_id === brk.brokerageId)
check("T1 brokerage: the initial agent is invited, pinned to the head office (users.location_id) with a location membership, role 'agent'",
  !!gia && gia.user_type === "agent" && gia.location_id === gulfOffice?.id && mems(brk.brokerageId, gia.id).some((m) => m.scope_kind === "location" && m.location_id === gulfOffice?.id))
const offices = svc.tables.locations.filter((l) => l.brokerage_id === multi.brokerageId)
const dt = offices.find((o) => o.office_code === "dt"), bch = offices.find((o) => o.office_code === "bch")
const harbor = svc.tables.teams.find((t) => t.brokerage_id === multi.brokerageId && t.location_id === dt?.id)
const ridge = svc.tables.teams.find((t) => t.brokerage_id === multi.brokerageId && t.location_id === bch?.id)
check("T1 multi-location: TWO offices, BOTH named \"Coastal Realty\", distinct ids / codes / legal names / brands, each with its OWN team",
  offices.length === 2 && offices.every((o) => o.name === "Coastal Realty") && dt?.id !== bch?.id && dt?.legal_name !== bch?.legal_name
    && dt?.brand_overrides?.primary_color === "#0b3d91" && bch?.brand_overrides?.primary_color === "#7a1f1f" && !!harbor && !!ridge && harbor.id !== ridge.id && harbor.name === "Harbor Team" && ridge.name === "Ridge Team")
const headDt = userByEmail("head.dt@coastal.test")!, headBch = userByEmail("head.bch@coastal.test")!, lead = userByEmail("lead.harbor@coastal.test")!, ridgeAgent = userByEmail("agent.ridge@coastal.test")!
check("T1 multi-location: office heads hold OFFICE leadership on their own office only; the Harbor lead anchors teams.team_lead_id and holds team leadership",
  mems(multi.brokerageId, headDt.id).some((m) => m.scope_kind === "location" && m.location_id === dt?.id && m.access_level === "leadership") && !mems(multi.brokerageId, headDt.id).some((m) => m.location_id === bch?.id)
    && mems(multi.brokerageId, headBch.id).some((m) => m.scope_kind === "location" && m.location_id === bch?.id && m.access_level === "leadership")
    && harbor?.team_lead_id === lead.id && mems(multi.brokerageId, lead.id).some((m) => m.scope_kind === "team" && m.team_id === harbor?.id && m.access_level === "leadership"))

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[T2 · authorization — aggregated ONLY with granted leadership; never widened by user_type / superadmin]")
const scopeOf = async (userId: string, brokerageId: string) => resolveViewerHierarchy(svc as never, { userId, brokerageId })
const owner = await scopeOf(multi.userId, multi.brokerageId)
check("T2 the multi-location owner (tenant leadership grant) sees EVERY office — aggregate", owner.ok && owner.scope.kind === "tenant" && owner.scope.aggregate && owner.scope.locationIds.length === 2, JSON.stringify(owner))
const sDt = await scopeOf(headDt.id, multi.brokerageId), sBch = await scopeOf(headBch.id, multi.brokerageId)
check("T2 the Downtown head sees Downtown + its Harbor team ONLY — not Beaches, not Ridge, not aggregate",
  sDt.ok && sDt.scope.kind === "offices" && !sDt.scope.aggregate && sDt.scope.locationIds.join() === dt?.id && sDt.scope.teamIds.includes(harbor!.id) && !sDt.scope.teamIds.includes(ridge!.id), JSON.stringify(sDt))
check("T2 the Beaches head sees Beaches + Ridge ONLY", sBch.ok && sBch.scope.kind === "offices" && sBch.scope.locationIds.join() === bch?.id && sBch.scope.teamIds.includes(ridge!.id) && !sBch.scope.teamIds.includes(harbor!.id), JSON.stringify(sBch))
const sLead = await scopeOf(lead.id, multi.brokerageId), sAgent = await scopeOf(ridgeAgent.id, multi.brokerageId)
check("T2 the Harbor team lead sees their team only; the Ridge agent sees their own work", sLead.ok && sLead.scope.kind === "teams" && sLead.scope.teamIds.join() === harbor!.id && sAgent.ok && sAgent.scope.kind === "own")
// seats typed with a "big" user_type / platform role but holding NO grant and no office in the multi-location tenant
const typed = (user_type: string, extra: Row = {}) => { const id = randomUUID(); svc.tables.users.push({ id, email: `${user_type}-${id.slice(0, 4)}@coastal.test`, user_type, brokerage_id: multi.brokerageId, location_id: null, ...extra }); return id }
const bAdmin = typed("broker_admin"), sup = typed("superadmin"), plat = typed("agent", { platform_role: "platform_admin" }), compl = typed("compliance_officer")
const widened = []
for (const id of [bAdmin, sup, plat, compl]) { const s = await scopeOf(id, multi.brokerageId); if (!s.ok || s.scope.kind !== "own" || s.scope.aggregate) widened.push(`${id}:${s.ok ? s.scope.kind : s.error}`) }
check("T2 NEGATIVE — broker_admin / compliance_officer user_type, user_type 'superadmin' and a platform_role, with no grant: OWN WORK only in a multi-location tenant", widened.length === 0, widened.join(", "))
const pinnedAdmin = typed("admin", { location_id: bch?.id })
const sPinned = await scopeOf(pinnedAdmin, multi.brokerageId)
check("T2 a roster admin PINNED to Beaches (the office UI's explicit act) is that office's admin — Beaches only, never aggregate", sPinned.ok && sPinned.scope.kind === "offices" && sPinned.scope.locationIds.join() === bch?.id && !sPinned.scope.aggregate)
const singleAdmin = randomUUID()
svc.tables.users.push({ id: singleAdmin, email: "admin@gulf.test", user_type: "broker_admin", brokerage_id: brk.brokerageId })
const sSingle = await scopeOf(singleAdmin, brk.brokerageId)
check("T2 POSITIVE CONTROL — the same broker_admin seat in a SINGLE-office brokerage keeps the CLAUDE.md §4 roster rule (tenant view)", sSingle.ok && sSingle.scope.kind === "tenant", JSON.stringify(sSingle))
// a REVOKED grant: the multi-location owner's tenant leadership row revoked on a COPY of the tenant (the live rows untouched)
const revokedDb = memSupabase({
  users: [{ id: "u-rev", brokerage_id: "b-rev", user_type: "broker_owner", location_id: null }],
  brokerages: [{ id: "b-rev", plan_tier: "multi_location" }],
  locations: [{ id: "o1", brokerage_id: "b-rev", status: "active" }, { id: "o2", brokerage_id: "b-rev", status: "active" }], teams: [],
  organization_members: [{ brokerage_id: "b-rev", user_id: "u-rev", scope_kind: "tenant", location_id: null, team_id: null, access_level: "leadership", revoked_at: "2026-11-01T00:00:00Z" }],
})
const pure = await resolveViewerHierarchy(revokedDb as never, { userId: "u-rev", brokerageId: "b-rev" })
;(revokedDb as any).tables.organization_members[0].revoked_at = null
const unrevoked = await resolveViewerHierarchy(revokedDb as never, { userId: "u-rev", brokerageId: "b-rev" })
check("T2 a REVOKED tenant leadership grant opens nothing — a broker_owner seat alone stays own work; POSITIVE CONTROL the same grant un-revoked opens the aggregate", pure.ok && pure.scope.kind === "own" && !pure.scope.aggregate && unrevoked.ok && unrevoked.scope.aggregate)
const dirDt = await loadOfficeDirectory(svc as never, { userId: headDt.id, brokerageId: multi.brokerageId })
const dirOwner = await loadOfficeDirectory(svc as never, { userId: multi.userId, brokerageId: multi.brokerageId })
check("T2 Settings → Offices: the Downtown head's directory lists Downtown (+ Harbor) only; the owner's lists both same-name offices with their own teams",
  dirDt.ok && dirDt.offices.length === 1 && dirDt.offices[0].id === dt?.id && dirDt.offices[0].teams.map((t) => t.id).join() === harbor!.id
    && dirOwner.ok && dirOwner.offices.length === 2 && dirOwner.offices.every((o) => o.name === "Coastal Realty" && o.teams.length === 1) && dirOwner.offices.find((o) => o.id === dt?.id)?.seatCap === 2,
  JSON.stringify({ dt: dirDt.ok ? dirDt.offices.map((o) => o.officeCode) : dirDt.error, own: dirOwner.ok ? dirOwner.offices.length : dirOwner.error }))
const refusedRead = memSupabase({ users: [{ id: headDt.id, brokerage_id: multi.brokerageId, user_type: "broker" }] }, { refuse: { organization_members: "permission denied (fixture)" } })
const failClosed = await resolveViewerHierarchy(refusedRead as never, { userId: headDt.id, brokerageId: multi.brokerageId })
check("T2 FAIL CLOSED — a refused memberships read refuses the scope (never 'no restriction')", !failClosed.ok && /refused/.test(failClosed.error))

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[T3 · the name-collision negative — a NAME is a label, never membership]")
const samSolo = soloSelf.brokerageId as string
const sam = soloSelf.userId as string
check("T3 the solo named \"Coastal Realty\" declaring affiliation \"Coastal Realty\" is its OWN tenant: affiliation stored on its row, zero memberships in the multi-location tenant",
  svc.tables.brokerages.find((b) => b.id === samSolo)?.declared_affiliation?.name === "Coastal Realty" && mems(multi.brokerageId, sam).length === 0 && svc.tables.users.find((u) => u.id === sam)?.brokerage_id === samSolo)
const crossRead = await scopeOf(sam, multi.brokerageId)
const crossDir = await loadOfficeDirectory(svc as never, { userId: sam, brokerageId: multi.brokerageId })
check("T3 the solo viewing the same-name brokerage is REFUSED (not a member) — scope and directory", !crossRead.ok && /not a member/.test(crossRead.error) && !crossDir.ok)
const capture = await provisionTenantStructure(svc as never, { brokerageId: multi.brokerageId, tier: "multi_location", ownerUserId: multi.userId, brokerageName: "Coastal Realty", actorUserId: multi.userId, source: "admin_grant", input: { members: [{ existingUserId: sam, userType: "agent", locationId: dt?.id }] } }, { report: async () => ({}) })
check("T3 placing that solo's user into the same-name brokerage is REFUSED — only the consented transfer rail moves a person between tenants",
  !capture.complete && capture.members[0]?.status === "failed" && /consented transfer rail/.test(capture.members[0]?.error ?? "") && mems(multi.brokerageId, sam).length === 0)
const before = offices.length + svc.tables.teams.filter((t) => t.brokerage_id === multi.brokerageId).length
const rerun = await provisionTenantStructure(svc as never, { brokerageId: multi.brokerageId, tier: "multi_location", ownerUserId: multi.userId, brokerageName: "Coastal Realty", actorUserId: STAFF, source: "provisioning", prior: multi.structure, input: { offices: [{ officeCode: "dt", name: "Coastal Realty", teams: [{ name: "Harbor Team" }] }, { officeCode: "bch", name: "Coastal Realty", teams: [{ name: "Ridge Team" }] }] } }, { report: async () => ({}) })
const after = svc.tables.locations.filter((l) => l.brokerage_id === multi.brokerageId).length + svc.tables.teams.filter((t) => t.brokerage_id === multi.brokerageId).length
check("T3 IDEMPOTENT by key, not by name: a re-run mints no office or team — the two same-name offices stay two, never merged", rerun.complete && after === before && rerun.offices.length === 2 && new Set(rerun.offices.map((o) => o.id)).size === 2, `${before}→${after} ${rerun.errors.join("; ")}`)
const plans = {
  soloOffices: planTenantOffices("solo_agent", "X", [{ name: "Office" }]),
  brokerageTwo: planTenantOffices("brokerage", "X", [{ name: "A" }, { name: "B" }]),
  dupCodes: planTenantOffices("multi_location", "X", [{ name: "A", officeCode: "one" }, { name: "B", officeCode: "one" }]),
  sameNames: planTenantOffices("multi_location", "X", [{ name: "Same" }, { name: "Same" }]),
  badState: planTenantOffices("multi_location", "X", [{ name: "A", licenseState: "Florida" }]),
}
check("T3 the plan: a solo has no offices; a Brokerage runs ONE (several → Multi-Location); duplicate CODES are refused; duplicate NAMES are allowed; a bad licence state is refused",
  !plans.soloOffices.ok && !plans.brokerageTwo.ok && !plans.dupCodes.ok && plans.sameNames.ok && plans.sameNames.offices.length === 2 && plans.sameNames.offices[0].code !== plans.sameNames.offices[1].code && !plans.badState.ok)

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[T4 · office seat ownership + immediate routing + asynchronous repair]")
const rec = svc.tables.brokerages.find((b) => b.id === multi.brokerageId)?.billing_metadata?.provisioning
const over = multi.structure?.members?.find((m: any) => m.key === "email:overflow@coastal.test")
check("T4 Downtown owns 2 seats (its head + the Harbor lead): the overflow agent is REFUSED by the office's seat ownership, recorded, and the structure kept incomplete for the resume",
  over?.status === "failed" && /owns 2 seats/.test(over?.error ?? "") && rec?.structure?.complete === false && !!rec?.structure_input && multi.extrasSkipped.includes("org_structure") && !userByEmail("overflow@coastal.test"), JSON.stringify(over))
check("T4 IMMEDIATE: the gap was evidenced and routed to the Recruiting Manager in the request (an open operation signal)",
  svc.tables.manager_signals.some((s) => s.brokerage_id === multi.brokerageId && s.signal_type === OPERATION_SIGNAL_TYPE && s.to_manager === "recruiting_manager" && s.status === "open"))
const verdict = await locationSeatGate(svc as never, multi.brokerageId, dt!.id)
const other = await locationSeatGate(svc as never, brk.brokerageId, dt!.id)
check("T4 locationSeatGate: over Downtown's cap → over_office_cap; another tenant's office → office_not_in_tenant; no cap → the tenant band decides",
  !verdict.allowed && verdict.reason === "over_office_cap" && verdict.seated === 2 && !other.allowed && other.reason === "office_not_in_tenant" && (await locationSeatGate(svc as never, multi.brokerageId, bch!.id)).reason === "no_office_cap")
dt!.managing_broker_user_id = headDt.id
const notesBefore = svc.tables.notifications.filter((n) => n.user_id === headDt.id && n.type === "seat_provisioning").length
const retry1 = await resumeTenantProvisioning(svc, multi.brokerageId, { deps })
check("T4 a resume while the cap still binds fails again — and THIS time tells the office's managing broker (the right manager), not the owner",
  retry1.resumable === true && retry1.result.structure?.complete === false && svc.tables.notifications.filter((n) => n.user_id === headDt.id && n.type === "seat_provisioning").length === notesBefore + 1)
dt!.seat_cap = 3
const retry2 = await resumeTenantProvisioning(svc, multi.brokerageId, { deps })
const ova = userByEmail("overflow@coastal.test")
check("T4 once Downtown owns 3 seats the resume finishes it: overflow invited, pinned to Downtown, structure complete, no office / team minted twice",
  retry2.resumable === true && retry2.result.structure?.complete === true && !!ova && ova.location_id === dt!.id && svc.tables.locations.filter((l) => l.brokerage_id === multi.brokerageId).length === 2
    && svc.tables.brokerages.find((b) => b.id === multi.brokerageId)?.billing_metadata?.provisioning?.structure_input === null, JSON.stringify(retry2.resumable ? retry2.result.structure?.errors : retry2))
const done = await resumeTenantProvisioning(svc, multi.brokerageId, { deps })
check("T4 a further resume is a no-op that says so (complete)", done.resumable === false && done.reason === "complete")

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[T5 · consented-transfer placement — seat ownership reassigned to the target OFFICE]")
const transferEvidence = { transfer_request_id: randomUUID(), consent: "subject consented 2026-11-06" }
const preMove = await provisionTenantStructure(svc as never, { brokerageId: multi.brokerageId, tier: "multi_location", ownerUserId: multi.userId, brokerageName: "Coastal Realty", actorUserId: headBch.id, source: "transfer", evidence: transferEvidence, input: { members: [{ existingUserId: sam, userType: "agent", locationId: bch!.id, teamId: ridge!.id }] } }, { report: async () => ({}) })
check("T5 BEFORE the rail moved the person (still in their own tenant) the placement refuses", !preMove.complete && preMove.members[0]?.status === "failed")
svc.tables.users.find((u) => u.id === sam)!.brokerage_id = multi.brokerageId   // what brokerage-transfer.ts's membership step does (assignUserToBrokerage), after verified consent
const placed = await provisionTenantStructure(svc as never, { brokerageId: multi.brokerageId, tier: "multi_location", ownerUserId: multi.userId, brokerageName: "Coastal Realty", actorUserId: headBch.id, source: "transfer", evidence: transferEvidence, input: { members: [{ existingUserId: sam, userType: "agent", locationId: bch!.id, teamId: ridge!.id }] } }, { report: async () => ({}) })
const samMems = mems(multi.brokerageId, sam)
check("T5 AFTER the consented move: pinned to Beaches, location + team memberships with source 'transfer' carrying the request's evidence; the owner gets no second tenant grant",
  placed.complete && svc.tables.users.find((u) => u.id === sam)?.location_id === bch!.id && samMems.some((m) => m.scope_kind === "location" && m.location_id === bch!.id && m.source === "transfer" && m.evidence?.transfer_request_id === transferEvidence.transfer_request_id)
    && samMems.some((m) => m.scope_kind === "team" && m.team_id === ridge!.id && m.source === "transfer") && mems(multi.brokerageId, multi.userId).filter((m) => m.scope_kind === "tenant").length === 1, placed.errors.join("; "))
check("T5 the placed member's scope: own work (membership ≠ leadership) — two active memberships that grant no aggregation", samMems.length === 2 && (await scopeOf(sam, multi.brokerageId)).ok && ((await scopeOf(sam, multi.brokerageId)) as any).scope.kind === "own")
// T5b (wave 150, lane 150Z): the RAIL itself calls the placement — read from STRIPPED source (a tombstone is not a call site).
{
  const railCode = stripComments(read("lib/kernel/brokerage-transfer.ts"))
  const calls = /provisionTenantStructure\(svc, \{/.test(blankStrings(railCode)) && /source: "transfer"/.test(railCode) && /tier: "transfer_placement"/.test(railCode)
  const carried = /placement: req\.verification\.placement/.test(railCode)
  const verified = /from\("locations"\)\.select\("id"\)\.eq\("id", locId\)\.eq\("brokerage_id", targetId\)/.test(railCode) && /from\("teams"\)\.select\("id, location_id"\)\.eq\("id", teamId\)\.eq\("brokerage_id", targetId\)/.test(railCode)
  const noOffice = planTenantOffices("transfer_placement", "X", null)
  const control = planTenantOffices("brokerage", "X", null)
  check("T5b brokerage-transfer.ts's membership step CALLS provisionTenantStructure (source 'transfer', non-office tier), carries the request's tenant-verified office/team through verification, and the placement tier mints no office (positive control: a brokerage tier plans its head office)",
    calls && carried && verified && noOffice.ok && noOffice.offices.length === 0 && control.ok && control.offices.length === 1, JSON.stringify({ calls, carried, verified }))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[T6 · static — migrations, vocabulary, the stripped-source name census]")
const m957 = read("supabase/migrations/m957-office-location-identity.sql"), m958 = read("supabase/migrations/m958-explicit-scope-memberships.sql")
const stamp = (sql: string) => /^-- (WRITTEN, NOT APPLIED \(wave 150, lane 150C\)|── APPLIED LIVE )/.test(sql.split("\n")[0])
check("T6 m957 + m958 line 1 is the lane stamp OR the APPLIED LIVE stamp (the rule, not the waypoint)", stamp(m957) && stamp(m958))
const sql958 = m958.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
check("T6 m958 DROPS the three session write policies (a staff seat can no longer self-grant leadership) and keeps SELECT",
  ["insert", "update", "delete"].every((k) => new RegExp(`DROP POLICY IF EXISTS organization_members_tenant_${k}`).test(sql958)) && !/DROP POLICY[^;]*tenant_select/.test(sql958))
check("T6 composite same-tenant FKs: teams→locations (m957), memberships→locations and →teams (m958); the widening team_id SET NULL FK is replaced",
  /FOREIGN KEY \(location_id, brokerage_id\) REFERENCES public\.locations \(id, brokerage_id\) ON DELETE SET NULL \(location_id\)/.test(m957)
    && /FOREIGN KEY \(location_id, brokerage_id\) REFERENCES public\.locations \(id, brokerage_id\) ON DELETE CASCADE/.test(sql958)
    && /FOREIGN KEY \(team_id, brokerage_id\) REFERENCES public\.teams \(id, brokerage_id\) ON DELETE CASCADE/.test(sql958) && /DROP CONSTRAINT organization_members_team_id_fkey/.test(sql958))
check("T6 m958 does NOT drop the legacy UNIQUE (that index drop is owner SQL O-150C-1)", !/DROP CONSTRAINT organization_members_brokerage_id_user_id_key/.test(sql958))
const checkList = (name: string) => { const m = new RegExp(`${name}[^;]*?IN \\(([^)]*)\\)`).exec(sql958); return m ? m[1].split(",").map((s) => s.trim().replace(/'/g, "")) : [] }
const coreRaw = read("lib/kernel/tenant-creation.ts")
const vocab = (name: string) => { const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(coreRaw); return m ? m[1].split(",").map((x) => x.trim().replace(/["']/g, "")).filter(Boolean) : ["<missing>"] }
check("T6 ONE vocabulary: MEMBERSHIP_SCOPE_KINDS / ACCESS_LEVELS / SOURCES (read from source; ACCESS_LEVELS also imported) equal m958's CHECK lists",
  checkList("organization_members_scope_kind_check").join() === vocab("MEMBERSHIP_SCOPE_KINDS").join() && checkList("organization_members_access_level_check").join() === MEMBERSHIP_ACCESS_LEVELS.join() && vocab("MEMBERSHIP_ACCESS_LEVELS").join() === MEMBERSHIP_ACCESS_LEVELS.join() && checkList("organization_members_source_check").join() === vocab("MEMBERSHIP_SOURCES").join(),
  `${checkList("organization_members_scope_kind_check")} | ${checkList("organization_members_access_level_check")} | ${checkList("organization_members_source_check")}`)
const core = read("lib/kernel/tenant-creation.ts")
const structSrc = blankStrings(stripComments(core.slice(core.indexOf("THE TENANT STRUCTURE (wave 150"))))
const officeSrc = stripComments(read("lib/kernel/resolve-user-office.ts"))
/** PURE — a supabase read that filters a row by NAME (equality, ilike or like), on stripped source. */
const nameFilter = (src: string) => /\.(eq|ilike|like)\(\s*["'`]name["'`]/.test(src)
check("T6 CENSUS — the structure provisioner and the hierarchy answer never filter by name (stripped source)", !nameFilter(stripComments(core.slice(core.indexOf("THE TENANT STRUCTURE (wave 150")))) && !nameFilter(officeSrc))
check("T6 POSITIVE CONTROL — the census catches a name filter and ignores a commented one", nameFilter(`svc.from("locations").select("id").eq("name", n)`) && nameFilter(`q.ilike('name', x)`) && !nameFilter(stripComments(`// never .eq("name", x)\nconst a = 1`)))
const hierSrc = officeSrc.slice(officeSrc.indexOf("type HierarchySvc"))
/** PURE — a scope rule that reads platform staff or a superadmin seat (stripped source). */
const widensByStaff = (src: string) => /platform_role|["'`]superadmin["'`]/.test(src)
check("T6 the hierarchy answer never reads platform_role or a 'superadmin' user_type (stripped source)", hierSrc.length > 1000 && !widensByStaff(hierSrc))
check("T6 POSITIVE CONTROL — the staff-widening finder catches both spellings", widensByStaff(`if (u.platform_role) return all`) && widensByStaff(`userType === "superadmin"`) && !widensByStaff(`const x = 1`))
check("T6 structSrc is non-empty (the census actually read the section)", structSrc.length > 2000)
// ONE ACTIVE ROW PER SCOPE, SEVERAL SCOPES PER PERSON (wave 151, lane 151A). Owner SQL L1 dropped the legacy
// one-row-per-tenant UNIQUE (verified live 2026-11-09: only organization_members_active_scope_key remains, 0 rows), so the
// RULE is asserted — never the waypoint "O-150C-1 pending" (CLAUDE.md §2): a second SCOPE is admitted; the same scope
// twice is idempotent; a 23505 that races the read re-reads the winner (idempotent, never a refusal); a 23505 with NO
// winner is reported as the refusal it is (positive control).
{
  const fx = memSupabase({ organization_members: [], teams: [{ id: "t1", brokerage_id: "b1", location_id: null, deleted_at: null }], users: [{ id: "u1", brokerage_id: "b1" }] }, { unique: { organization_members: [["brokerage_id", "user_id", "scope_kind", "team_id"]] } })
  const first = await provisionTenantStructure(fx as never, { brokerageId: "b1", tier: "solo_agent", ownerUserId: "u1", brokerageName: "Solo", actorUserId: "u1", source: "provisioning", input: null }, { report: async () => ({}) })
  const second = await provisionTenantStructure(fx as never, { brokerageId: "b1", tier: "solo_agent", ownerUserId: "u1", brokerageName: "Solo", actorUserId: "u1", source: "admin_grant", input: { members: [{ existingUserId: "u1", userType: "agent", teamId: "t1" }] } }, { report: async () => ({}) })
  const again = await provisionTenantStructure(fx as never, { brokerageId: "b1", tier: "solo_agent", ownerUserId: "u1", brokerageName: "Solo", actorUserId: "u1", source: "admin_grant", input: { members: [{ existingUserId: "u1", userType: "agent", teamId: "t1" }] } }, { report: async () => ({}) })
  const active = (fx as any).tables.organization_members.filter((m: Row) => m.user_id === "u1" && !m.revoked_at)
  check("T6 RULE (post-L1): a person holds a TENANT membership AND a TEAM membership at once — two active rows, two scopes; the same team grant again is idempotent (no third row, no error)",
    first.complete && second.complete && again.complete && active.length === 2 && new Set(active.map((m: Row) => m.scope_kind)).size === 2 && second.memberships === 1 && again.memberships === 0, [...first.errors, ...second.errors, ...again.errors].join("; "))
  // The RACE: the read misses once (another writer landed the identical active row between read and insert) → 23505 → the
  // winner is re-read → created:false. Modelled by hiding the first organization_members read of the next run.
  let hide = 1
  const origFrom = (fx as any).from.bind(fx)
  ;(fx as any).from = (t: string) => {
    const q: any = origFrom(t)
    if (t === "organization_members") { const lim = q.limit.bind(q); q.limit = async (n: number) => { if (hide > 0) { hide--; return { data: [], error: null } } return lim(n) } }
    return q
  }
  ;(fx as any).tables.teams.push({ id: "t2", brokerage_id: "b1", location_id: null, deleted_at: null })
  ;(fx as any).tables.organization_members.push({ id: "pre-t2", brokerage_id: "b1", user_id: "u1", scope_kind: "team", location_id: null, team_id: "t2", access_level: "member", source: "admin_grant", revoked_at: null })
  const raced = await provisionTenantStructure(fx as never, { brokerageId: "b1", tier: "solo_agent", ownerUserId: "u1", brokerageName: "Solo", actorUserId: "u1", source: "admin_grant", input: { members: [{ existingUserId: "u1", userType: "agent", teamId: "t2" }] } }, { report: async () => ({}) })
  ;(fx as any).from = origFrom
  check("T6 a 23505 that RACES the read is idempotent: the winner is re-read, the placement completes, no second row, nothing reported as pending owner SQL",
    raced.complete && raced.memberships === 0 && (fx as any).tables.organization_members.filter((m: Row) => m.team_id === "t2" && !m.revoked_at).length === 1 && !/O-150C-1/.test(raced.errors.join(" ")), raced.errors.join("; "))
  // POSITIVE CONTROL: a 23505 with NO winner to re-read is a refusal, reported by name — never success.
  const ghost = memSupabase({ organization_members: [], teams: [{ id: "t1", brokerage_id: "b1", location_id: null, deleted_at: null }], users: [{ id: "u1", brokerage_id: "b1" }] })
  const ghostFrom = (ghost as any).from.bind(ghost)
  ;(ghost as any).from = (t: string) => { const q: any = ghostFrom(t); if (t === "organization_members") q.insert = async () => ({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint (fixture)" } }); return q }
  const refused = await provisionTenantStructure(ghost as never, { brokerageId: "b1", tier: "solo_agent", ownerUserId: "u1", brokerageName: "Solo", actorUserId: "u1", source: "admin_grant", input: { members: [{ existingUserId: "u1", userType: "agent", teamId: "t1" }] } }, { report: async () => ({}) })
  check("T6 POSITIVE CONTROL — a 23505 whose re-read finds no active row is REFUSED by name (duplicate, nothing to reuse), never success", !refused.complete && /duplicate/.test(refused.errors.join(" ")) && !/O-150C-1/.test(refused.errors.join(" ")), refused.errors.join("; "))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[T8 · seat reassignment, several memberships, revocation — wave 151 (lane 151A)]")
{
  const { revokeScopeMemberships } = await import("../lib/kernel/tenant-creation")
  const actor = multi.userId as string
  const ovaId = userByEmail("overflow@coastal.test")!.id
  const dtMem = () => mems(multi.brokerageId, ovaId).filter((m) => m.scope_kind === "location" && m.location_id === dt!.id)
  check("T8 pre-condition: the overflow agent sits in Downtown with ONE active location membership", dtMem().length === 1 && userByEmail("overflow@coastal.test")!.location_id === dt!.id)
  // A MOVE: Downtown → Beaches with `reassign` — the Downtown placement is ENDED (stamped, never deleted), Beaches is active, the pin follows.
  const moved = await provisionTenantStructure(svc as never, { brokerageId: multi.brokerageId, tier: "multi_location", ownerUserId: actor, brokerageName: "Coastal Realty", actorUserId: actor, source: "admin_grant", evidence: { granted_via: "proof" }, input: { members: [{ existingUserId: ovaId, userType: "agent", locationId: bch!.id, reassign: true }] } }, { report: async () => ({}) })
  const ovaRows = svc.tables.organization_members.filter((m) => m.brokerage_id === multi.brokerageId && m.user_id === ovaId)
  const ended = ovaRows.find((m) => m.scope_kind === "location" && m.location_id === dt!.id)
  check("T8 MOVE (reassign): Downtown's placement is revoked — row kept, revoked_at + revoked_by = the actor, evidence names the move and the office it went to; Beaches is the one active office placement; users.location_id = Beaches; the record counts 1 revoked",
    moved.complete && moved.revoked === 1 && !!ended?.revoked_at && ended?.revoked_by_user_id === actor && ended?.evidence?.revoked?.reason === "reassigned" && ended?.evidence?.revoked?.reassigned_to_location_id === bch!.id
      && mems(multi.brokerageId, ovaId).filter((m) => m.scope_kind === "location").map((m) => m.location_id).join() === bch!.id && userByEmail("overflow@coastal.test")!.location_id === bch!.id, moved.errors.join("; ") || JSON.stringify(ended))
  // An ADD (no reassign): placed in Downtown too — SEVERAL memberships, no promotion (scope stays own work).
  const added = await provisionTenantStructure(svc as never, { brokerageId: multi.brokerageId, tier: "multi_location", ownerUserId: actor, brokerageName: "Coastal Realty", actorUserId: actor, source: "admin_grant", input: { members: [{ existingUserId: ovaId, userType: "agent", locationId: dt!.id }] } }, { report: async () => ({}) })
  const twoOffices = mems(multi.brokerageId, ovaId).filter((m) => m.scope_kind === "location").map((m) => m.location_id).sort()
  const scopeAfter = await scopeOf(ovaId, multi.brokerageId)
  check("T8 ADD (no reassign): a person may hold SEVERAL office memberships — Beaches AND Downtown active (L1), nothing revoked, and holding two offices promotes nobody (scope still own work)",
    added.complete && (added.revoked ?? 0) === 0 && twoOffices.join() === [bch!.id, dt!.id].sort().join() && scopeAfter.ok && scopeAfter.scope.kind === "own" && !scopeAfter.scope.aggregate, added.errors.join("; ") || JSON.stringify(twoOffices))
  // REVOCATION through the ONE helper: everything the person holds in the tenant's offices ends; the rows stay as audit; the reader sees none.
  const revoked = await revokeScopeMemberships(svc as never, { brokerageId: multi.brokerageId, userId: ovaId, actorUserId: actor, scopes: ["location", "team"], evidence: { reason: "unassigned" } })
  const after = svc.tables.organization_members.filter((m) => m.brokerage_id === multi.brokerageId && m.user_id === ovaId)
  check("T8 REVOKE: both office placements ended in one counted call (2 revoked, 0 active); every row kept with revoked_at / revoked_by / evidence; a second call revokes 0 (idempotent)",
    revoked.ok && revoked.revoked === 2 && mems(multi.brokerageId, ovaId).length === 0 && after.length === 3 && after.every((m) => !!m.revoked_at && m.revoked_by_user_id === actor) && (await revokeScopeMemberships(svc as never, { brokerageId: multi.brokerageId, userId: ovaId, actorUserId: actor, scopes: ["location", "team"] })).revoked === 0, revoked.ok ? JSON.stringify(after.map((m) => [m.scope_kind, !!m.revoked_at])) : revoked.error)
  const refusedRevoke = await revokeScopeMemberships(memSupabase({}, { refuse: { organization_members: "permission denied (fixture)" } }) as never, { brokerageId: multi.brokerageId, userId: ovaId, actorUserId: actor, scopes: ["location"] })
  check("T8 FAIL CLOSED — a refused memberships read refuses the revocation by name (never '0 to revoke')", !refusedRevoke.ok && /refused/.test(refusedRevoke.error))
  // The keep rule: a team INSIDE the kept office stays; a team in another office goes with it. Pure fixture.
  const keepFx = memSupabase({
    organization_members: [
      { id: "m-loc-a", brokerage_id: "b", user_id: "u", scope_kind: "location", location_id: "A", team_id: null, revoked_at: null },
      { id: "m-loc-b", brokerage_id: "b", user_id: "u", scope_kind: "location", location_id: "B", team_id: null, revoked_at: null },
      { id: "m-team-a", brokerage_id: "b", user_id: "u", scope_kind: "team", location_id: null, team_id: "tA", revoked_at: null },
      { id: "m-team-b", brokerage_id: "b", user_id: "u", scope_kind: "team", location_id: null, team_id: "tB", revoked_at: null },
      { id: "m-team-free", brokerage_id: "b", user_id: "u", scope_kind: "team", location_id: null, team_id: "tFree", revoked_at: null },
    ],
    teams: [{ id: "tA", brokerage_id: "b", location_id: "A" }, { id: "tB", brokerage_id: "b", location_id: "B" }, { id: "tFree", brokerage_id: "b", location_id: null }],
  })
  const kept = await revokeScopeMemberships(keepFx as never, { brokerageId: "b", userId: "u", actorUserId: "x", scopes: ["location", "team"], keep: { locationId: "A" } })
  const keptActive = (keepFx as any).tables.organization_members.filter((m: Row) => !m.revoked_at).map((m: Row) => m.id).sort()
  check("T8 the KEEP rule on a move into A: office A and its team stay, office B and ITS team go, a team placed in no office stays (it is not B's)", kept.ok && kept.revoked === 2 && keptActive.join() === ["m-loc-a", "m-team-a", "m-team-free"].sort().join(), JSON.stringify(keptActive))
  // READER CENSUS: no reader of organization_members in lib/ or app/ asks for ONE row per person per tenant (stripped source).
  const { readdirSync, statSync } = await import("node:fs")
  const walk = (dir: string, out: string[] = []): string[] => { for (const e of readdirSync(join(ROOT, dir))) { const rel = `${dir}/${e}`; if (e === "node_modules" || e.startsWith(".")) continue; if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out); else if (/\.tsx?$/.test(e)) out.push(rel) } return out }
  /** PURE — a ONE-ROW-PER-PERSON read of organization_members: a maybeSingle / single whose filter chain is not keyed on the
   *  row's primary key (`.eq("id", …)` — one membership row by id, the revoke door's shape — is a row read, not a per-person
   *  assumption). Stripped source, whitespace folded. */
  const singleRowMembershipRead = (src: string) => {
    const flat = src.replace(/\s+/g, " ")
    for (const m of flat.matchAll(/from\( ?["'`]organization_members["'`] ?\)([^;]{0,600}?)\.(maybeSingle|single)\(/g)) {
      if (!/\.eq\( ?["'`]id["'`]/.test(m[1])) return true
    }
    return false
  }
  const offenders = [...walk("lib"), ...walk("app")].filter((f) => { const s = read(f); return /organization_members/.test(s) && singleRowMembershipRead(stripComments(s)) })
  check("T8 CENSUS — no lib/ or app/ reader of organization_members reads ONE row per person (a maybeSingle / single not keyed on the row id); every per-person reader takes the list (several memberships per person is the rule)", offenders.length === 0, offenders.join(", "))
  check("T8 POSITIVE CONTROL — the census catches a per-person one-row read, ignores a list read, a by-id row read and a commented one",
    singleRowMembershipRead(`const { data } = await svc.from("organization_members").select("id").eq("brokerage_id", b).eq("user_id", u).maybeSingle()`) && !singleRowMembershipRead(`const { data } = await svc.from("organization_members").select("id").eq("user_id", u)`)
      && !singleRowMembershipRead(`const { data } = await svc.from("organization_members").select("id, user_id").eq("id", membershipId).eq("brokerage_id", b).is("revoked_at", null).maybeSingle()`) && !singleRowMembershipRead(stripComments(`// svc.from("organization_members").select("id").eq("user_id", u).maybeSingle()\nconst a = 1`)))
}

console.log("\n[T7 · the explicit grant door — Settings → Offices (source-read; the session client cannot run in memory)]")
const actSrc = stripComments(read("app/dashboard/settings/offices/actions.ts"))
/** PURE — the grant door's gate order: session user → session tenant → the GRANTER's scope → leadership only from the aggregate → the write. */
const doorGated = (src: string) => /^"use server"/.test(src.trim()) && /auth\.getUser\(\)/.test(src) && /from\("users"\)\.select\("brokerage_id"\)\.eq\("id", user\.id\)/.test(src)
  && /resolveViewerHierarchy\(svc, \{ userId: user\.id, brokerageId \}\)/.test(src) && /access === "leadership" && !scope\.aggregate/.test(src)
  && src.indexOf("resolveViewerHierarchy(") < src.indexOf("provisionTenantStructure(svc") && !/formData\.get\("brokerageId"\)/.test(src)
check("T7 the grant door: tenant from the SESSION (never a form field), the granter's scope checked BEFORE the write, office leadership only from the aggregated view", doorGated(actSrc))
check("T7 POSITIVE CONTROL — a door that read the tenant from the form, or wrote before checking scope, is caught",
  !doorGated(actSrc.replace('resolveViewerHierarchy(svc, { userId: user.id, brokerageId })', 'resolveViewerHierarchy(svc, { userId: user.id, brokerageId: String(formData.get("brokerageId")) })')) && !doorGated(actSrc.replace('access === "leadership" && !scope.aggregate', 'false')))
check("T7 every export of the door is async (a \"use server\" export is a public endpoint)", [...actSrc.matchAll(/^export\s+(async\s+)?function/gm)].every((m) => !!m[1]) && /export async function grantOfficeMembershipAction/.test(actSrc))

console.log("\n[blind spots]")
console.log("  · Supabase Auth (the member invite) and Stripe (the paid checkout) are injected; the REAL inviteTenantMember path is driven by test:subscriber-provisioning")
console.log("  · RLS and the composite FKs are read from m957/m958, not exercised against Postgres; the live per-scope UNIQUE (NULLS NOT DISTINCT, partial) is modelled on team rows only; owner SQL L1 (the legacy UNIQUE drop) was verified LIVE on 2026-11-09, not here")
console.log("  · T5 drives the placement after simulating the rail's membership step; T5b proves the rail CALLS it by stripped source — the full rail run is test:brokerage-identity's (no office fixture there)")
console.log("  · consumers that still scope by egress-scope.ts user_type ladder (command center, exception center, reporting) are not re-pointed here (Outside-lane)")
console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
if (fail) { console.log("FAILURES:\n  - " + fails.join("\n  - ")); process.exit(1) }
