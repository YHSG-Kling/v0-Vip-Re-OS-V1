#!/usr/bin/env tsx
/**
 * scripts/seat-producer-roles-guard.ts   (npm run test:seat-producer-roles)
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 80A — owner verbatim (2026-09-23): "brokers and broker owners can be a
 * producing seat."
 *
 * THE RULE (one predicate, four rosters — lib/kernel/tier-role-matrix.ts):
 *   agent, team_lead          a seat by TYPE
 *   broker, broker_owner      a seat by TYPE unless the tenant EXEMPTS them
 *                             (produces:false — billing_metadata.non_producing_user_ids)
 *   admin                     a seat only WHILE PRODUCING (an active agents row)
 *   broker_admin/tc/isa/co    never
 *
 * Proves, against production functions and injected clients, with a positive
 * control beside every absence claim and the RULE asserted (never a count):
 *   1 · the predicate and the rosters
 *   2 · the exemption parser fails toward BILLING on a malformed blob
 *   3 · the meter: a broker with no agents row is a seat; the exempted one is
 *       not; one person is never two seats across users/agents/grants
 *   4 · the writer: only a licensed user of the SESSION tenant, counted write
 *   5 · every path that admits on produces:false also RECORDS it; the tenant
 *       has a door to flip it; the seat copy says the rule
 *   6 · no migration after m660 restates the superseded producers clause
 *   7 · registration
 *
 * No DB, no network. Run: npx tsx --conditions=react-server scripts/seat-producer-roles-guard.ts
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
/** POSITIVE CONTROL: the same finder, fed the defect, MUST report it. */
function control(name: string, defectSeen: boolean) {
  if (defectSeen) { passed++; console.log(`  ↺ control: ${name}`) }
  else { failed++; failures.push(`CONTROL DID NOT GO RED: ${name}`); console.log(`  ✗ CONTROL DID NOT GO RED: ${name}`) }
}
const root = process.cwd()
const raw = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : "")
const code = (p: string) => stripComments(raw(p))

const MATRIX = "lib/kernel/tier-role-matrix.ts"
const USAGE = "lib/kernel/seat-usage.ts"
const INVITE = "app/actions/admin/invite-user.ts"
const STAFF_DOOR = "app/actions/superadmin/tenant-users.ts"
const BILLING = "app/actions/billing.ts"
const CARD = "app/dashboard/admin/billing/seat-door-card.tsx"
const CATALOG = "lib/billing/plan-catalog.ts"

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1 · THE PREDICATE — four rosters, one rule]")
const {
  roleConsumesSeat, roleProducesOnTier, parseNonProducingUserIds,
  PRODUCER_SEAT_ROLES, LICENSED_SEAT_ROLES, SEAT_BY_PRODUCTION_ROLES, FREE_STAFF_ROLES, WORKSPACE_STAFF_ROLES, PARTNER_ROLES, TIER_ORDER,
} = await import("../lib/kernel/tier-role-matrix")

check("LICENSED_SEAT_ROLES is exactly broker + broker_owner, disjoint from the other three rosters, and the four partition the working roster",
  [...LICENSED_SEAT_ROLES].sort().join() === "broker,broker_owner"
  && LICENSED_SEAT_ROLES.every((r) => !PRODUCER_SEAT_ROLES.includes(r) && !SEAT_BY_PRODUCTION_ROLES.includes(r) && !FREE_STAFF_ROLES.includes(r))
  && new Set(WORKSPACE_STAFF_ROLES).size === PRODUCER_SEAT_ROLES.length + LICENSED_SEAT_ROLES.length + SEAT_BY_PRODUCTION_ROLES.length + FREE_STAFF_ROLES.length
  && !PARTNER_ROLES.some((p) => (WORKSPACE_STAFF_ROLES as readonly string[]).includes(p)))
check("admin is the ONLY seat-by-production role (the solo/team owner wearing an agents row)", [...SEAT_BY_PRODUCTION_ROLES].join() === "admin")
for (const r of LICENSED_SEAT_ROLES) {
  check(`${r}: a seat with no statement, a seat when producing, FREE only on the explicit exemption (produces:false)`,
    roleConsumesSeat(r) && roleConsumesSeat(r, {}) && roleConsumesSeat(r, { produces: true }) && roleConsumesSeat(r, { produces: undefined }) && !roleConsumesSeat(r, { produces: false }))
  check(`${r} produces on EVERY canonical tier and on an unknown one (licensed by type — the provisioning spec is not consulted)`,
    TIER_ORDER.every((t) => roleProducesOnTier(r, t)) && roleProducesOnTier(r, null) && roleProducesOnTier(r, "legacy_tier"))
}
control("the superseded wave-78A rule (a broker is staff until an agents row says otherwise) would read `!roleConsumesSeat(\"broker\")` — that now goes red", !roleConsumesSeat("broker") === false)
check("agent and team_lead are a seat whatever is stated — an exemption cannot free a producer by type", PRODUCER_SEAT_ROLES.every((r) => roleConsumesSeat(r) && roleConsumesSeat(r, { produces: false })))
check("admin is a seat only with the agents-row fact", !roleConsumesSeat("admin") && !roleConsumesSeat("admin", { produces: false }) && roleConsumesSeat("admin", { produces: true }))
check("free staff, partners, contacts, system and platform identities are never a seat, even 'producing'",
  [...FREE_STAFF_ROLES, ...PARTNER_ROLES, "contact", "lender", "system", "superadmin", "support", "title_agent"].every((r) => !roleConsumesSeat(r, { produces: true })))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2 · THE EXEMPTION PARSER — fails toward billing]")
check("a well-formed list is read; blanks and non-strings are dropped", [...parseNonProducingUserIds({ non_producing_user_ids: ["u1", " ", 7, null, "u2"] })].sort().join() === "u1,u2")
check("a malformed blob (string, object, number, null, undefined, a non-array field) reads as NO exemptions — a bad blob must never free a seat",
  [null, undefined, "u1", 42, { non_producing_user_ids: "u1" }, { non_producing_user_ids: { u1: true } }, { seat_override: 3 }].every((b) => parseNonProducingUserIds(b).size === 0))
control("the parser does see an exemption when one is there", parseNonProducingUserIds({ non_producing_user_ids: ["u1"] }).has("u1"))
check("the ids are users.id — the parser never reads an agents.id field (the two classes are disjoint, CLAUDE.md §3)", !/agent_id|agents\.id/.test(code(MATRIX).slice(code(MATRIX).indexOf("export function parseNonProducingUserIds"), code(MATRIX).indexOf("export function parseNonProducingUserIds") + 600)))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3 · THE METER — a broker is a seat by type; the exempted one is free; nobody is counted twice]")
type Fixture = { data: unknown; error: { message: string } | null }
function readSvc(fx: Record<string, Fixture>) {
  return {
    from(table: string) {
      const f = fx[table] ?? { data: [], error: null }
      const chain: any = {
        eq() { return chain }, in() { return chain }, not() { return chain }, limit() { return chain }, order() { return chain },
        maybeSingle: async () => ({ data: Array.isArray(f.data) ? (f.data[0] ?? null) : f.data, error: f.error }),
        then(res: (v: unknown) => unknown) { return Promise.resolve({ data: f.data, error: f.error }).then(res) },
      }
      return { select() { return chain } }
    },
  } as any
}
const { resolveSeatUsage, setLicensedProducerExemption, seatGate } = await import("../lib/kernel/seat-usage")
const users = (rows: Array<{ id: string; user_type: string; status?: string }>): Fixture => ({ data: rows.map((r) => ({ status: "active", ...r })), error: null })
function tenant(ids: string[]): Fixture {
  return { data: [{ billing_metadata: { non_producing_user_ids: ids } }], error: null }
}
{
  const roster = [
    { id: "brk", user_type: "broker" },          // no agents row
    { id: "bo", user_type: "broker_owner" },     // agents row
    { id: "bor", user_type: "broker" },          // EXEMPTED, no agents row
    { id: "bo2", user_type: "broker_owner" },    // EXEMPTED, agents row — the exemption wins over the row
    { id: "adm", user_type: "admin" },           // agents row → produces
    { id: "adm2", user_type: "admin" },          // staff
    { id: "ag", user_type: "agent" },
  ]
  const agents: Fixture = { data: [{ user_id: "bo", is_active: true }, { user_id: "bo2", is_active: true }, { user_id: "adm", is_active: true }], error: null }
  const u = await resolveSeatUsage(readSvc({ users: users(roster), agents, brokerages: tenant(["bor", "bo2"]), user_role_assignments: { data: [], error: null } }), "b1")
  check("brk (no agents row) IS a seat; bor and bo2 (exempted) are NOT, agents row or no; adm produces, adm2 is staff; ag by type → 4 seats, 3 free staff, exemptions reported",
    u.ok && u.seatCount === 4 && [...u.seatHolderIds].sort().join() === "adm,ag,bo,brk" && u.freeStaffCount === 3 && [...u.nonProducingIds].sort().join() === "bo2,bor", JSON.stringify(u))
  const none = await resolveSeatUsage(readSvc({ users: users(roster), agents, brokerages: tenant([]), user_role_assignments: { data: [], error: null } }), "b1")
  control("with an EMPTY exemption list the same roster bills 6 — the list is what moves the number", none.seatCount === 6 && none.nonProducingIds.length === 0)
  const absent = await resolveSeatUsage(readSvc({ users: users(roster), agents, user_role_assignments: { data: [], error: null } }), "b1")
  check("a tenant with NO billing_metadata row read (no row, no error) bills the same 6 — absence is not an exemption", absent.ok && absent.seatCount === 6)
  const refused = await resolveSeatUsage(readSvc({ users: users(roster), agents, brokerages: { data: null, error: { message: "permission denied" } }, user_role_assignments: { data: [], error: null } }), "b1")
  check("a REFUSED exemption read is ok:false — the gate must not bill (or free) on a fact it could not read", refused.ok === false)
  // Double counting: one person, three spellings of production.
  const one = await resolveSeatUsage(readSvc({
    users: users([{ id: "p", user_type: "broker" }]),
    agents: { data: [{ user_id: "p", is_active: true }, { user_id: "p", is_active: true }], error: null },
    user_role_assignments: { data: [{ user_id: "p", role: "agent" }, { user_id: "p", role: "broker_owner" }], error: null },
    brokerages: tenant([]),
  }), "b1")
  check("one person typed broker, with two agents rows and two producer grants, is ONE seat (users.id is the unit; agents.user_id is the crossing)", one.seatCount === 1 && one.seatHolderIds.join() === "p")
  const exemptButAgent = await resolveSeatUsage(readSvc({ users: users([{ id: "p", user_type: "broker" }]), agents: { data: [], error: null }, user_role_assignments: { data: [{ user_id: "p", role: "agent" }], error: null }, brokerages: tenant(["p"]) }), "b1")
  check("an exempted broker who ALSO holds an agent grant is still a seat (the grant is a producer by type) and is not reported as an exemption in force",
    exemptButAgent.seatCount === 1 && exemptButAgent.nonProducingIds.length === 1)
  const stale = await resolveSeatUsage(readSvc({ users: users([{ id: "ag", user_type: "agent" }, { id: "gone", user_type: "broker", status: "suspended" }]), agents: { data: [], error: null }, user_role_assignments: { data: [], error: null }, brokerages: tenant(["gone", "never-here"]) }), "b1")
  check("a listed id that is suspended or not on the roster is a STALE exemption — not reported, nothing freed", stale.seatCount === 1 && stale.nonProducingIds.length === 0)
}
{
  // The gate on a full team: a broker is refused by type; the stated exemption admits.
  const TEAM = 10
  const full = users(Array.from({ length: TEAM }, (_, i) => ({ id: `p${i}`, user_type: "agent" })))
  const svc = readSvc({ brokerages: { data: [{ plan_tier: "team", billing_metadata: {} }], error: null }, users: full, agents: { data: [], error: null }, user_role_assignments: { data: [], error: null }, subscription_tiers: { data: [{ tier_name: "team", max_agents: TEAM }], error: null } })
  const b = await seatGate(svc, "b1", "broker")
  const bo = await seatGate(svc, "b1", "broker_owner", { produces: false })
  check("the gate: an 11th producer as BROKER is refused over_limit (no agents-row inference); a broker_owner the caller exempts is not_a_seat", !b.allowed && b.reason === "over_limit" && bo.allowed && bo.reason === "not_a_seat")
  control("…and the same gate still admits a TC on the full team", (await seatGate(svc, "b1", "tc")).reason === "not_a_seat")
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4 · THE WRITER — licensed users of the session tenant only; the update is counted]")
function writeSvc(opts: { user: { id: string; user_type: string; brokerage_id: string } | null; bm: unknown; matchRows?: number; userErr?: string; writeErr?: string }) {
  const writes: unknown[] = []
  const svc = {
    writes,
    from(table: string) {
      let payload: unknown = null
      const chain: any = {
        eq() { return chain }, in() { return chain },
        update(p: unknown) { payload = p; return chain },
        select() { return chain },
        maybeSingle: async () => {
          if (table === "users") return { data: opts.userErr ? null : opts.user, error: opts.userErr ? { message: opts.userErr } : null }
          if (table === "brokerages") return { data: { billing_metadata: opts.bm }, error: null }
          return { data: null, error: null }
        },
        then(res: (v: unknown) => unknown) {
          if (payload !== null) {
            writes.push(payload)
            const n = opts.matchRows ?? 1
            return Promise.resolve({ data: opts.writeErr ? null : Array.from({ length: n }, () => ({ id: "b1" })), error: opts.writeErr ? { message: opts.writeErr } : null }).then(res)
          }
          return Promise.resolve({ data: [], error: null }).then(res)
        },
      }
      return chain
    },
  }
  return svc as any
}
{
  const ok = writeSvc({ user: { id: "u1", user_type: "broker", brokerage_id: "b1" }, bm: { seat_override: 5, non_producing_user_ids: ["u0"] } })
  const r = await setLicensedProducerExemption(ok, "b1", "u1", true)
  check("marks a broker non-producing: the list gains u1, keeps u0, and the rest of billing_metadata (seat_override) survives the spread",
    r.ok && r.nonProducingIds.join() === "u0,u1" && (ok.writes[0] as any).billing_metadata.seat_override === 5 && (ok.writes[0] as any).billing_metadata.non_producing_user_ids.join() === "u0,u1")
  const un = writeSvc({ user: { id: "u1", user_type: "broker_owner", brokerage_id: "b1" }, bm: { non_producing_user_ids: ["u0", "u1"] } })
  const r2 = await setLicensedProducerExemption(un, "b1", "u1", false)
  check("unmarks: u1 leaves the list, u0 stays", r2.ok && r2.nonProducingIds.join() === "u0")
  const agent = writeSvc({ user: { id: "u1", user_type: "agent", brokerage_id: "b1" }, bm: {} })
  const r3 = await setLicensedProducerExemption(agent, "b1", "u1", true)
  check("REFUSES a non-licensed user (an agent is always a seat) and writes nothing", !r3.ok && r3.reason === "not_licensed" && agent.writes.length === 0)
  const admin = writeSvc({ user: { id: "u1", user_type: "admin", brokerage_id: "b1" }, bm: {} })
  check("…and an admin (their seat is the agents record, not a declaration)", !(await setLicensedProducerExemption(admin, "b1", "u1", true)).ok && admin.writes.length === 0)
  const outside = writeSvc({ user: null, bm: {} })
  const r4 = await setLicensedProducerExemption(outside, "b1", "u-other-tenant", true)
  check("REFUSES a user the tenant predicate does not match (another tenant's broker) — user_not_in_tenant, nothing written", !r4.ok && r4.reason === "user_not_in_tenant" && outside.writes.length === 0)
  const zero = writeSvc({ user: { id: "u1", user_type: "broker", brokerage_id: "b1" }, bm: {}, matchRows: 0 })
  const r5 = await setLicensedProducerExemption(zero, "b1", "u1", true)
  check("a COUNTED write: 0 rows updated is a refusal, not a success (CLAUDE.md §3 — an unmatched update resolves with no error)", !r5.ok && r5.reason === "write_refused" && /0 rows/.test(r5.error))
  const err = writeSvc({ user: { id: "u1", user_type: "broker", brokerage_id: "b1" }, bm: {}, writeErr: "rls" })
  check("a refused write is reported by the database's own sentence", !(await setLicensedProducerExemption(err, "b1", "u1", true)).ok)
  check("the writer scopes the user read by BOTH id and brokerage_id (the session tenant), and selects the update", /\.eq\("id", userId\)\.eq\("brokerage_id", brokerageId\)/.test(code(USAGE)) && /\.eq\("id", brokerageId\)\s*\.select\("id"\)/.test(code(USAGE)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5 · EVERY ADMIT ON produces:false RECORDS IT; the tenant can flip it; the copy says the rule]")
{
  const invite = code(INVITE), staff = code(STAFF_DOOR), billing = code(BILLING), card = code(CARD)
  check("the tenant invite admits through seatGate with `produces` and, for a LICENSED role stated non-producing, calls setLicensedProducerExemption on the new user (refusal reported, not swallowed)",
    /seatGate\(service, resolvedBrokerageId, requestedRole, \{ produces: params\.produces \}\)/.test(invite)
    && /params\.produces === false && \(LICENSED_SEAT_ROLES as readonly string\[\]\)\.includes\(requestedRole\)/.test(invite)
    && /setLicensedProducerExemption\(service, resolvedBrokerageId, resolvedUserId, true\)/.test(invite) && /if \(!exemption\.ok\) \{\s*return \{ success: false/.test(invite))
  check("the staff door does the same on the target tenant and audits it",
    /seatGate\(svc, params\.brokerageId, params\.userType, \{ produces: params\.produces \}\)/.test(staff)
    && /params\.produces === false && \(LICENSED_SEAT_ROLES as readonly string\[\]\)\.includes\(params\.userType\)/.test(staff)
    && /setLicensedProducerExemption\(svc, params\.brokerageId, res\.userId, true\)/.test(staff) && /"user\.marked_non_producing"/.test(staff))
  control("the finder sees an admit-without-record (the invite text minus the writer)", !/setLicensedProducerExemption\(/.test(invite.replace(/setLicensedProducerExemption\([^)]*\)/g, "")))
  check("the tenant door: setLicensedProducerAction — session tenant via requireTenantCommerceAdmin, the ONE writer, audited, and the seat door lists the licensed roster with the exemption the METER applied",
    /export async function setLicensedProducerAction\(userId: string, producing: boolean\)/.test(billing) && /const auth = await requireTenantCommerceAdmin\(\)[\s\S]{0,400}setLicensedProducerExemption\(svc, auth\.brokerageId, id, !producing\)/.test(billing)
    && /"seat\.licensed_producer_set"/.test(billing) && /licensed: LicensedSeatRow\[\]/.test(billing) && /usage\.nonProducingIds/.test(billing) && /\.in\("user_type", \[\.\.\.LICENSED_SEAT_ROLES\]\)/.test(billing))
  check("the seat-door card mounts the toggle (no orphan action) and its copy states the rule — brokers and broker owners are producer seats; non-producing is a mark, not an inference",
    /setLicensedProducerAction\(p\.userId, !p\.producing\)/.test(card) && /Mark non-producing/.test(raw(CARD)) && /brokers and broker owners are producer seats/.test(raw(CARD)) && !/non-producing brokers never take a seat/.test(raw(CARD)))
  check("the catalogue prose names the four rosters and the ruling", /LICENSED_SEAT_ROLES/.test(raw(CATALOG)) && /brokers and broker owners/.test(raw(CATALOG)))
  check("the gate's `produces` doc says the caller that admits must also record (the drift this wave closes)", /must also RECORD it \(setLicensedProducerExemption\)/.test(raw(USAGE)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[6 · THE PRODUCERS SQL — the superseded clause stays in history and reaches no newer migration]")
{
  // The wave-78A clause: broker/broker_owner/admin count only with an agents row.
  const SUPERSEDED = /user_type IN \('broker', 'broker_owner', 'admin'\) AND a\.id IS NOT NULL/
  const dir = join(root, "supabase/migrations")
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^m\d+/.test(f)) : []
  const num = (f: string) => Number(/^m(\d+)/.exec(f)?.[1] ?? 0)
  const m660 = files.find((f) => num(f) === 660) ?? ""
  const newer = files.filter((f) => num(f) > 660)
  const restating = newer.filter((f) => SUPERSEDED.test(readFileSync(join(dir, f), "utf8")))
  console.log(`    denominator: ${files.length} migrations; ${newer.length} newer than m660; blind spot: only the exact wave-78A spelling is hunted, a paraphrase is not`)
  control("m660 (applied, history) DOES carry the superseded clause — the finder recognises it", m660 !== "" && SUPERSEDED.test(readFileSync(join(dir, m660), "utf8")))
  check(`no migration newer than m660 restates it (found: ${restating.join(", ") || "none"})`, restating.length === 0)
  check("the survivor's documented producers SQL (seat-usage.ts) reads the exemption list and names the three seat rosters", /non_producing_user_ids', '\[\]'::jsonb\) \? u\.id::text/.test(raw(USAGE)) && /PRODUCER_SEAT_ROLES/.test(raw(USAGE)) && /LICENSED_SEAT_ROLES/.test(raw(USAGE)) && /SEAT_BY_PRODUCTION_ROLES/.test(raw(USAGE)))
  check("no lane migration was written for this (the exemption lives in an existing jsonb column — no column, no backfill)", !files.some((f) => num(f) === 661 && /non_producing|producer/i.test(f)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[7 · registration]")
{
  const pkg = raw("package.json")
  check(`"test:seat-producer-roles" is registered`, /"test:seat-producer-roles":\s*"tsx --conditions=react-server scripts\/seat-producer-roles-guard\.ts"/.test(pkg))
  const guardLine = /"guard":\s*"([^"]+)"/.exec(pkg)?.[1] ?? ""
  check("the guard chain runs it AFTER test:scrapers (ordering only — never an adjacency pin)", guardLine.indexOf("npm run test:scrapers") >= 0 && guardLine.indexOf("npm run test:seat-producer-roles") > guardLine.indexOf("npm run test:scrapers"))
  check("MAINTENANCE_DOMAINS carries seat_producer_roles with proof test:seat-producer-roles and a structured co-owner", /seat_producer_roles:\s*\{\s*manager:\s*"finance_manager",\s*proof:\s*"test:seat-producer-roles",\s*coOwners:\s*\["data_steward"\]/.test(code("lib/kernel/manager-registry.ts")))
}

console.log("\n" + "─".repeat(60))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log("\n❌ SEAT_PRODUCER_ROLES — see failures above")
  process.exit(1)
}
console.log("\n✅ SEAT_PRODUCER_ROLES — brokers and broker owners are producer seats by type, free only on the tenant's recorded exemption; admin while producing; staff never")
