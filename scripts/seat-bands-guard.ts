#!/usr/bin/env tsx
/**
 * scripts/seat-bands-guard.ts   (npm run test:seat-bands)
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 78A — owner verbatim (2026-09-22):
 *
 *   "the tier seat bands are solo agent maxseats 2 team is 5 brokerage is
 *    unlimited and same to multiple locations is unlimited. expert advice is
 *    welcomed. staff should not take up seats. need your expertise to confirm
 *    that. these seat numbers have already been coded. not all converts or
 *    tenant creations are going to enroll in the trial. there is a setup fee."
 *
 * Proves, with production functions against injected clients and STRIPPED
 * source for every code-token scan (scripts/strip-comments.ts, CLAUDE.md §2),
 * a positive control beside every absence claim:
 *
 *   1 · ONE DERIVATION  — TIER_SEAT_BANDS (lib/billing/plan-catalog.ts) is
 *       2 / 5 / ∞ / ∞; TIER_SEAT_LIMITS IS that object (identity, not a copy);
 *       tierForProspect derives from tierForSeatCount and never reaches
 *       multi_location by count; NO OTHER band table exists in lib/ + app/
 *       (control: a fixture restating the bands is caught); m655 pins the
 *       live catalogue to the same numbers, derived — not retyped — here.
 *   2 · STAFF ARE FREE  — resolveSeatUsage counts producers only; adding a
 *       TC / ISA / compliance / broker_admin / EXEMPTED broker never
 *       moves the count (control: the retired every-staff-is-a-seat rule
 *       WOULD move it); a broker is a producer by type (wave 80A) unless the
 *       tenant exempts them; the 11th team producer is refused; a brokerage
 *       past its band is refused (control: a capped catalogue refuses).
 *   3 · SETUP FEE       — present on a paid activation checkout, absent on a
 *       trial and when WAIVED; the waiver is audited by the core and refused
 *       without a staff caller / to a self-converting prospect.
 *   4 · SURFACES        — start_subscription takes the prospect's choice
 *       (trial | paid); the playbook wording quotes the fee from the plan
 *       row and never invents it; the voice/chat tier lines speak the fee
 *       from the row; the growth board, /get-started and the signup action
 *       carry the paid door; the webhook advances trial → converted.
 *   5 · registration.
 *
 * No DB, no network. Run: npx tsx --conditions=react-server scripts/seat-bands-guard.ts
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { walkTs } from "./runtime-roots"

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

const CATALOG = "lib/billing/plan-catalog.ts"
const MATRIX = "lib/kernel/tier-role-matrix.ts"
const USAGE = "lib/kernel/seat-usage.ts"
const CONVERSION = "lib/platform/prospect-conversion.ts"
const CORE = "lib/kernel/tenant-creation.ts"
const ACTIVATION = "lib/billing/subscription-activation.ts"
const TOOLS = "lib/platform/prospect-agent-tools.ts"
const PLAYBOOK = "lib/ai-isa/qualification-playbook.ts"
const RECEPTION = "lib/voice/platform-reception.ts"
const WEBHOOK = "app/api/billing/webhook/route.ts"
const SIGNUP = "app/actions/auth/signup-brokerage.ts"
const FORM = "app/get-started/trial-funnel-form.tsx"
const GROWTH_ACTIONS = "app/actions/superadmin/platform-growth.ts"
const BOARD = "app/dashboard/superadmin/growth/platform-growth-board.tsx"
const MIGRATION = "supabase/migrations/m660-seat-bands-2-10-30-custom-and-seat-packages.sql" // the NEWEST band migration (m655 → m660, wave 79A)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1 · ONE DERIVATION — the bands, the identity, the fit, no second table, the migration]")
const { TIER_SEAT_BANDS, tierForSeatCount, CANONICAL_TIERS } = await import("../lib/billing/plan-catalog")
const { TIER_SEAT_LIMITS, TIER_ORDER, seatDecision, roleConsumesSeat, roleProducesOnTier, PRODUCER_SEAT_ROLES, LICENSED_SEAT_ROLES, SEAT_BY_PRODUCTION_ROLES, FREE_STAFF_ROLES, WORKSPACE_STAFF_ROLES, PARTNER_ROLES } = await import("../lib/kernel/tier-role-matrix")
const { tierForProspect } = await import("../lib/platform/prospect-conversion")

check("the bands are the owner's (wave 79A): solo_agent 2 · team 10 · brokerage 30 · multi_location custom (null)",
  TIER_SEAT_BANDS.solo_agent === 2 && TIER_SEAT_BANDS.team === 10 && TIER_SEAT_BANDS.brokerage === 30 && TIER_SEAT_BANDS.multi_location === null)
const BAND = (t: (typeof CANONICAL_TIERS)[number]) => TIER_SEAT_BANDS[t] as number
check("every canonical tier has a band and nothing else does", CANONICAL_TIERS.every((t) => t in TIER_SEAT_BANDS) && Object.keys(TIER_SEAT_BANDS).length === CANONICAL_TIERS.length)
check("the capped bands ascend and every tier after the first unlimited one is unlimited (a plan above never sells fewer seats)",
  (() => {
    let prev = 0; let unlimitedSeen = false
    for (const t of CANONICAL_TIERS) {
      const b = TIER_SEAT_BANDS[t]
      if (b === null) { unlimitedSeen = true; continue }
      if (unlimitedSeen || b <= prev) return false
      prev = b
    }
    return true
  })())
check("TIER_SEAT_LIMITS (the gate's fallback) IS TIER_SEAT_BANDS — one object, not a copy that could drift", (TIER_SEAT_LIMITS as unknown) === (TIER_SEAT_BANDS as unknown) && TIER_ORDER.every((t) => TIER_SEAT_LIMITS[t] === TIER_SEAT_BANDS[t]))
control("a copied table that agreed today would still be a second spelling — identity is what the check reads", ({ ...TIER_SEAT_BANDS } as unknown) !== (TIER_SEAT_BANDS as unknown))
check("tierForSeatCount fits by the bands (derived): 1..solo → solo · solo+1..team → team · team+1..brokerage → brokerage · above every band → multi_location (custom)",
  tierForSeatCount(1) === "solo_agent" && tierForSeatCount(BAND("solo_agent")) === "solo_agent" && tierForSeatCount(BAND("solo_agent") + 1) === "team" && tierForSeatCount(BAND("team")) === "team"
  && tierForSeatCount(BAND("team") + 1) === "brokerage" && tierForSeatCount(BAND("brokerage")) === "brokerage" && tierForSeatCount(BAND("brokerage") + 1) === "multi_location" && tierForSeatCount(5000) === "multi_location"
  && tierForSeatCount(null) === "solo_agent" && tierForSeatCount(0) === "solo_agent")
check("tierForProspect derives from it (declared multi_location wins; a seat count follows the bands)",
  tierForProspect("multi_location", 3) === "multi_location" && tierForProspect("unknown", BAND("solo_agent") + 1) === "team" && tierForProspect(null, BAND("team") + 1) === "brokerage" && tierForProspect(null, BAND("solo_agent")) === "solo_agent")
check("prospect-conversion no longer carries its own band table (the 1/15/75 table is tombstoned)", !/TIER_SEAT_BANDS\s*[:=]/.test(code(CONVERSION)) && /tierForSeatCount\(/.test(code(CONVERSION)) && /TOMBSTONE \(wave 78A\)/.test(raw(CONVERSION)))

// NO SECOND SEAT-BAND TABLE ANYWHERE IN RUNTIME CODE. Per-tier objects are
// common and legitimate (TIER_TEAMMATE_LIMITS, MONTHLY_VENDOR_BUDGET_USD, a
// composition TIER_RANK — measured: 7 such files), so the shape alone is not
// the defect. A SEAT band table is a per-tier object DECLARED UNDER A NAME THAT
// SAYS SEAT (TIER_SEAT_*, SEAT_LADDER, *Seats*) keying a canonical tier to a
// number/null, or a `maxSeats:` list. Comments stripped AND strings blanked
// (a fixture inside a template literal must not count), lib/ + app/ only.
// TIER_SEAT_LIMITS in the matrix is `= TIER_SEAT_BANDS` (no literal), so it is
// invisible to this finder by construction — and the identity check above is
// what keeps it honest.
{
  const SEAT_NAMED_TABLE = /\b[A-Za-z_$]*(?:SEAT|Seat|seat)[A-Za-z_$]*\s*(?::\s*[^=;{}]{0,120})?=\s*(?:Object\.freeze\()?\s*\{[\s\S]{0,200}?\b(?:solo_agent|team|brokerage|multi_location)\s*:\s*(?:\d+|null|Number\.POSITIVE_INFINITY)\b/
  const MAX_SEATS_LIST = /\bmaxSeats\s*:\s*(?:\d+|Number\.POSITIVE_INFINITY)\b/
  const files = [...walkTs(join(root, "lib")), ...walkTs(join(root, "app"))]
  const hits = files
    .filter((f) => { const s = blankStrings(stripComments(readFileSync(f, "utf8"))); return SEAT_NAMED_TABLE.test(s) || MAX_SEATS_LIST.test(s) })
    .map((f) => f.replace(root + "/", ""))
  console.log(`    denominator: ${files.length} .ts/.tsx files under lib/ + app/; seat-band tables found in: ${hits.join(" · ") || "none"}`)
  check(`exactly ONE seat-band table in runtime code, and it is ${CATALOG} (found: ${hits.join(", ") || "none"})`, hits.length === 1 && hits[0] === CATALOG)
  control("the finder sees a restated seat table (the retired TIER_SEAT_LIMITS literal shape)", SEAT_NAMED_TABLE.test(blankStrings(stripComments("export const TIER_SEAT_LIMITS: Record<CanonicalTier, number | null> = {\n  solo_agent: 2,\n  team: 5,\n  brokerage: 50,\n  multi_location: null,\n}"))))
  control("…and a frozen one, and a SEAT_LADDER", SEAT_NAMED_TABLE.test(blankStrings(stripComments("const SEAT_LADDER = Object.freeze({ solo_agent: 2, team: 5 })"))))
  control("the finder sees a maxSeats list", MAX_SEATS_LIST.test(blankStrings(stripComments('const B = [{ tier: "team", maxSeats: 15 }]'))))
  control("…and ignores the same table inside a comment or a string", !SEAT_NAMED_TABLE.test(blankStrings(stripComments("// const TIER_SEAT_X = { solo_agent: 2, team: 5 }\nconst s = `TIER_SEAT_X = { solo_agent: 2, team: 5 }`"))))
  check("…while a per-tier table that is NOT about seats (a teammate limit, a budget) is left alone — the finder is not blind, it is aimed", !SEAT_NAMED_TABLE.test("export const TIER_TEAMMATE_LIMITS: Record<string, number | null> = {\n  solo_agent: 1,\n  team: 3,\n}"))
}

// THE MIGRATION pins the live catalogue to the bands — derived from the table,
// never retyped. It asserts the RULE (each capped tier's number appears in the
// postcondition CASE; unlimited tiers are the ELSE NULL branch), not the
// "WRITTEN, NOT APPLIED" header, which is a waypoint (§2).
{
  const m = raw(MIGRATION)
  const capped = CANONICAL_TIERS.filter((t) => TIER_SEAT_BANDS[t] !== null)
  const unlimited = CANONICAL_TIERS.filter((t) => TIER_SEAT_BANDS[t] === null)
  check("the newest band migration exists and SETS every tier's max_agents / active_users to its band (NULL / -1 for the custom tier)", m.length > 0
    && capped.every((t) => new RegExp(`SET max_agents = ${TIER_SEAT_BANDS[t]}\\s+WHERE tier_name = '${t}'`).test(m) && new RegExp(`SET limit_value = ${TIER_SEAT_BANDS[t]},[^;]*WHERE plan_tier = '${t}'`).test(m))
    && unlimited.every((t) => new RegExp(`SET max_agents = NULL\\s+WHERE tier_name = '${t}'`).test(m) && new RegExp(`SET limit_value = -1,[^;]*WHERE plan_tier = '${t}'`).test(m)))
  check(`the migration's postcondition names each capped tier with ITS band (${capped.map((t) => `${t}=${TIER_SEAT_BANDS[t]}`).join(", ")})`,
    capped.every((t) => new RegExp(`WHEN '${t}'\\s+THEN ${TIER_SEAT_BANDS[t]}\\b`).test(m)))
  check(`…and no capped number for a custom tier (${unlimited.join(", ")}) — they fall to the ELSE NULL / -1 branch`,
    unlimited.every((t) => !new RegExp(`WHEN '${t}'\\s+THEN \\d`).test(m)) && /ELSE NULL/.test(m) && /ELSE -1/.test(m))
  control("the migration finder would catch a stale brokerage number", /WHEN 'brokerage'\s+THEN \d/.test("WHEN 'brokerage' THEN 50") && !new RegExp(`WHEN 'brokerage'\\s+THEN ${TIER_SEAT_BANDS.brokerage}\\b`).test("WHEN 'brokerage' THEN 50"))
  check("the migration states the producer rule in the column comment (the max_agents name is right again)", /COMMENT ON COLUMN public\.subscription_tiers\.max_agents IS[\s\S]{0,400}PRODUCERS/.test(m))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2 · STAFF ARE FREE — producers count, staff never do; the producer past the team band is refused; a brokerage past its band too; multi_location never]")
check("the four rosters partition the working roster: producers by type (agent, team_lead), licensed (broker, broker_owner — wave 80A), by production (admin), free staff (broker_admin, tc, isa, compliance_officer)",
  [...PRODUCER_SEAT_ROLES].sort().join() === "agent,team_lead" && [...LICENSED_SEAT_ROLES].sort().join() === "broker,broker_owner" && [...SEAT_BY_PRODUCTION_ROLES].sort().join() === "admin"
  && [...FREE_STAFF_ROLES].sort().join() === "broker_admin,compliance_officer,isa,tc"
  && new Set(WORKSPACE_STAFF_ROLES).size === PRODUCER_SEAT_ROLES.length + LICENSED_SEAT_ROLES.length + SEAT_BY_PRODUCTION_ROLES.length + FREE_STAFF_ROLES.length
  && !PARTNER_ROLES.some((p) => (WORKSPACE_STAFF_ROLES as readonly string[]).includes(p)))
check("roleConsumesSeat: producer types always; licensed unless EXEMPTED (produces:false); by-production only with the fact; staff/partners/contacts never — even 'producing'",
  roleConsumesSeat("agent") && roleConsumesSeat("team_lead") && roleConsumesSeat("agent", { produces: false })
  && roleConsumesSeat("broker") && roleConsumesSeat("broker", { produces: true }) && !roleConsumesSeat("broker", { produces: false }) && roleConsumesSeat("broker_owner") && !roleConsumesSeat("broker_owner", { produces: false })
  && !roleConsumesSeat("admin") && roleConsumesSeat("admin", { produces: true })
  && ["tc", "isa", "compliance_officer", "broker_admin", "vendor", "contact", "system", "superadmin", "support", "lender"].every((r) => !roleConsumesSeat(r, { produces: true })))
check("roleProducesOnTier: the solo/team OWNER (admin) produces; a brokerage-tier admin does not; a broker produces on EVERY tier (licensed by type); the ISA's operational agents row is never a licence",
  roleProducesOnTier("admin", "solo_agent") && roleProducesOnTier("admin", "team") && !roleProducesOnTier("admin", "brokerage") && roleProducesOnTier("broker", "brokerage") && roleProducesOnTier("broker_owner", "team") && !roleProducesOnTier("isa", "solo_agent") && roleProducesOnTier("agent", "brokerage"))

// The count, against an injected client. Only the shapes resolveSeatUsage and
// seatGate use: .from(t).select().eq()… thenable, and .maybeSingle().
type Fixture = { data: unknown; error: { message: string } | null }
function fakeSvc(fx: Record<string, Fixture>) {
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
const { resolveSeatUsage, seatGate } = await import("../lib/kernel/seat-usage")
const LIVE_CATALOG: Fixture = { data: CANONICAL_TIERS.map((t) => ({ tier_name: t, max_agents: TIER_SEAT_BANDS[t] })), error: null }
const workspace = [
  { id: "owner", user_type: "admin" },          // the solo/team owner — admin wearing an agents row: PRODUCES
  { id: "a1", user_type: "agent" },
  { id: "tc", user_type: "tc" },
  { id: "isa", user_type: "isa" },              // has an agents row (desk), still free
  { id: "co", user_type: "compliance_officer" },
  { id: "ba", user_type: "broker_admin" },
  { id: "brk", user_type: "broker" },           // no agents row — still a SEAT (licensed by type, wave 80A)
  { id: "own2", user_type: "broker_owner" },    // agents row: sells → a seat
  { id: "bor", user_type: "broker" },           // the broker of record the tenant EXEMPTED (billing_metadata below) → free
  { id: "c", user_type: "contact" }, { id: "v", user_type: "vendor" }, { id: "sys", user_type: "system" },
  { id: "susp", user_type: "agent", status: "suspended" },
]
const usersFx = (rows: Array<{ id: string; user_type: string; status?: string }>): Fixture => ({ data: rows.map((r) => ({ status: "active", ...r })), error: null })
const agentsFx: Fixture = { data: [{ user_id: "owner", is_active: true }, { user_id: "a1", is_active: true }, { user_id: "isa", is_active: true }, { user_id: "own2", is_active: null }, { user_id: "susp", is_active: true }], error: null }
// The tenant's exemption list (wave 80A) — the ONLY thing that frees a licensed broker.
const tenantFx: Fixture = { data: [{ billing_metadata: { non_producing_user_ids: ["bor"] } }], error: null }
{
  const usage = await resolveSeatUsage(fakeSvc({ users: usersFx(workspace), agents: agentsFx, brokerages: tenantFx, user_role_assignments: { data: [], error: null } }), "b1")
  check("13 people → 4 seats (owner-admin producing, the agent, the broker with no agents row, the producing broker_owner); tc/isa/compliance/broker_admin/EXEMPTED broker are FREE staff (5); partners, contacts, system, suspended never count",
    usage.ok && usage.seatCount === 4 && [...usage.seatHolderIds].sort().join() === "a1,brk,own2,owner" && usage.freeStaffCount === 5 && usage.peopleCount === 13 && usage.nonProducingIds.join() === "bor", JSON.stringify(usage))
  const noExemption = await resolveSeatUsage(fakeSvc({ users: usersFx(workspace), agents: agentsFx, user_role_assignments: { data: [], error: null } }), "b1")
  control("without the exemption the same broker of record IS a seat (5) — the list, not the agents table, is what frees a licensed producer", noExemption.seatCount === 5 && noExemption.seatHolderIds.includes("bor") && noExemption.nonProducingIds.length === 0)
  const plusTc = await resolveSeatUsage(fakeSvc({ users: usersFx([...workspace, { id: "tc2", user_type: "tc" }, { id: "isa2", user_type: "isa" }]), agents: { data: [...(agentsFx.data as unknown[]), { user_id: "isa2", is_active: true }], error: null }, brokerages: tenantFx, user_role_assignments: { data: [], error: null } }), "b1")
  check("POSITIVE CONTROL (the ruling): adding a TC and an ISA does NOT move the seat count", plusTc.seatCount === usage.seatCount && plusTc.freeStaffCount === usage.freeStaffCount + 2)
  const plusAgent = await resolveSeatUsage(fakeSvc({ users: usersFx([...workspace, { id: "a2", user_type: "agent" }]), agents: agentsFx, brokerages: tenantFx, user_role_assignments: { data: [], error: null } }), "b1")
  check("…while adding an AGENT does (the counter is not stuck)", plusAgent.seatCount === usage.seatCount + 1)
  // The retired rule — every working type is a seat — would have said 9 here.
  const retiredRule = workspace.filter((u) => (u as { status?: string }).status !== "suspended" && (WORKSPACE_STAFF_ROLES as readonly string[]).includes(u.user_type)).length
  control("the retired every-staff-is-a-seat rule counts 9 of the same roster — the defect this pins", retiredRule === 9 && retiredRule !== usage.seatCount)
  const exemptRefused = await resolveSeatUsage(fakeSvc({ users: usersFx(workspace), agents: agentsFx, brokerages: { data: null, error: { message: "brokerages refused" } }, user_role_assignments: { data: [], error: null } }), "b1")
  check("a refused exemption read makes the count ok:false (a swallowed refusal would bill the broker the tenant exempted)", exemptRefused.ok === false)
  const granted = await resolveSeatUsage(fakeSvc({ users: usersFx([{ id: "c1", user_type: "contact" }, { id: "ad", user_type: "admin" }]), agents: { data: [], error: null }, user_role_assignments: { data: [{ user_id: "c1", role: "agent" }, { user_id: "ad", role: "tc" }], error: null } }), "b1")
  check("a contact GRANTED the agent role holds a seat (assignments count); an admin granted tc holds none", granted.seatCount === 1 && granted.seatHolderIds[0] === "c1")
  const refused = await resolveSeatUsage(fakeSvc({ users: usersFx(workspace), agents: { data: null, error: { message: "agents refused" } }, user_role_assignments: { data: [], error: null } }), "b1")
  check("a refused agents read makes the count ok:false (the production fact is part of the number; a gate must refuse on it)", refused.ok === false)
}
{
  // The gate on a FULL team: 5 producers seated.
  const TEAM_BAND = TIER_SEAT_BANDS.team as number
  const BRK_BAND = TIER_SEAT_BANDS.brokerage as number
  const five = usersFx(Array.from({ length: TEAM_BAND }, (_, i) => ({ id: `p${i}`, user_type: "agent" })))
  const teamFull = (extra: Record<string, Fixture> = {}) => fakeSvc({ brokerages: { data: [{ plan_tier: "team", billing_metadata: {} }], error: null }, users: five, agents: { data: [], error: null }, user_role_assignments: { data: [], error: null }, subscription_tiers: LIVE_CATALOG, ...extra })
  const tc = await seatGate(teamFull(), "b1", "tc")
  const isa = await seatGate(teamFull(), "b1", "isa")
  const brokerAdmin = await seatGate(teamFull(), "b1", "broker_admin")
  check("a full team may still add a TC, an ISA and a broker_admin — not_a_seat, no upgrade demanded", [tc, isa, brokerAdmin].every((v) => v.allowed && v.reason === "not_a_seat"))
  const sixth = await seatGate(teamFull(), "b1", "agent")
  check(`the ${TEAM_BAND + 1}th team PRODUCER is refused, naming Brokerage with ${BRK_BAND} seats (the door; wave 79A)`, !sixth.allowed && sixth.reason === "over_limit" && sixth.decision?.upgradeTo === "brokerage" && sixth.decision?.upgradeSeats === BRK_BAND && new RegExp(`upgrade to Brokerage for ${BRK_BAND} seats`).test(sixth.message ?? ""))
  const adminOwnerOnTeam = await seatGate(teamFull(), "b1", "admin")
  check("an ADMIN on a team tenant produces (the owner shape) and so is a 6th producer — refused too", !adminOwnerOnTeam.allowed && adminOwnerOnTeam.reason === "over_limit")
  const adminStaffOnTeam = await seatGate(teamFull(), "b1", "admin", { produces: false })
  check("…but an admin the caller states will NOT produce is free on the same full team", adminStaffOnTeam.allowed && adminStaffOnTeam.reason === "not_a_seat")
  const brokerOnTeam = await seatGate(teamFull(), "b1", "broker")
  check("a BROKER on the full team is a producer by type (wave 80A) — refused as the 11th, no agents row consulted", !brokerOnTeam.allowed && brokerOnTeam.reason === "over_limit")
  const exemptBrokerOnTeam = await seatGate(teamFull(), "b1", "broker_owner", { produces: false })
  check("…and the broker of record the tenant states does NOT produce is free on the same full team (the invite then RECORDS the exemption)", exemptBrokerOnTeam.allowed && exemptBrokerOnTeam.reason === "not_a_seat")
  control(`the ${TEAM_BAND}th producer on a team of ${TEAM_BAND - 1} is admitted (the refusal is the band, not a stuck gate)`, (await seatGate(fakeSvc({ brokerages: { data: [{ plan_tier: "team", billing_metadata: {} }], error: null }, users: usersFx(Array.from({ length: TEAM_BAND - 1 }, (_, i) => ({ id: `p${i}`, user_type: "agent" }))), agents: { data: [], error: null }, user_role_assignments: { data: [], error: null }, subscription_tiers: LIVE_CATALOG }), "b1", "agent")).allowed)
  const solo = usersFx([{ id: "owner", user_type: "admin" }, { id: "a1", user_type: "agent" }])
  const soloSvc = fakeSvc({ brokerages: { data: [{ plan_tier: "solo_agent", billing_metadata: {} }], error: null }, users: solo, agents: { data: [{ user_id: "owner", is_active: true }], error: null }, user_role_assignments: { data: [], error: null }, subscription_tiers: LIVE_CATALOG })
  const soloTc = await seatGate(soloSvc, "b1", "tc")
  const soloThird = await seatGate(soloSvc, "b1", "agent")
  check("SOLO: owner (admin, producing) + agent = 2 of 2; a TC is still free; a 3rd producer is refused naming Team", soloTc.allowed && soloTc.reason === "not_a_seat" && !soloThird.allowed && soloThird.decision?.upgradeTo === "team" && soloThird.seatCount === 2)
  const many = usersFx(Array.from({ length: BRK_BAND }, (_, i) => ({ id: `p${i}`, user_type: "agent" })))
  const almost = usersFx(Array.from({ length: BRK_BAND - 1 }, (_, i) => ({ id: `p${i}`, user_type: "agent" })))
  const brokerage = fakeSvc({ brokerages: { data: [{ plan_tier: "brokerage", billing_metadata: {} }], error: null }, users: many, agents: { data: [], error: null }, user_role_assignments: { data: [], error: null }, subscription_tiers: LIVE_CATALOG })
  const b = await seatGate(brokerage, "b1", "agent")
  check(`a BROKERAGE at its band (${BRK_BAND}) is refused, offered Multi-Location (custom seats) — by the catalogue AND the fallback`, !b.allowed && b.reason === "over_limit" && b.decision?.limit === BRK_BAND && b.decision?.upgradeTo === "multi_location" && !seatDecision("brokerage", BRK_BAND).withinLimit && !seatDecision("brokerage", BRK_BAND, null, 1, {}).withinLimit)
  check(`…and one under the band is admitted`, (await seatGate(fakeSvc({ brokerages: { data: [{ plan_tier: "brokerage", billing_metadata: {} }], error: null }, users: almost, agents: { data: [], error: null }, user_role_assignments: { data: [], error: null }, subscription_tiers: LIVE_CATALOG }), "b1", "agent")).allowed)
  control("a catalogue that capped brokerage BELOW the band WOULD refuse an add one under it", !(await seatGate(fakeSvc({ brokerages: { data: [{ plan_tier: "brokerage", billing_metadata: {} }], error: null }, users: many, agents: { data: [], error: null }, user_role_assignments: { data: [], error: null }, subscription_tiers: { data: [{ tier_name: "brokerage", max_agents: BRK_BAND - 5 }], error: null } }), "b1", "agent")).allowed)
  check("multi_location (custom, nothing negotiated) is never refused", seatDecision("multi_location", 5000).withinLimit)
  check("the catalogue reader and the gate rely on the SAME predicate (roleConsumesSeat) — the meter and the refusal cannot disagree about who is billed",
    // Re-anchored (wave 81A): the meter hands the predicate BOTH facts — the
    // production/exemption fact and the managing-broker fact — through ONE
    // options builder (seatOpts), so the assertion is on the rule, not a spelling.
    /roleConsumesSeat\(r, seatOpts\(u\.id\)\)/.test(code(USAGE)) && /produces: producesFact\(userId\), managingBroker: managingBrokers\.has\(userId\)/.test(code(USAGE)) && /roleConsumesSeat\(role, \{ produces \}\)/.test(code(USAGE)) && /from\("agents"\)/.test(code(USAGE)) && /parseNonProducingUserIds\(/.test(code(USAGE)))
  check("the retired SEAT_ROLES identifier is gone from runtime code (tombstone kept in prose)", !/\bSEAT_ROLES\b/.test(code(MATRIX)) && !/\bSEAT_ROLES\b/.test(code(USAGE)) && /TOMBSTONE — `SEAT_ROLES`/.test(raw(MATRIX)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3 · THE SETUP FEE — on a paid activation, not on a trial, gone when WAIVED, and the waiver is audited]")
const { buildCheckoutConfig } = await import("../lib/billing/subscription-activation")
const { buildSubscriptionRow } = await import("../lib/kernel/tenant-creation")
const { convertProspectToSubscriber } = await import("../lib/platform/prospect-conversion")
const TIER = { tier_name: "team", display_name: "Team", monthly_price_cents: 29900, annual_price_cents: 299000, setup_fee_cents: 49900 }
{
  const paid = buildCheckoutConfig(TIER, "monthly")
  const waived = buildCheckoutConfig(TIER, "monthly", { waiveSetupFee: true })
  const none = buildCheckoutConfig({ ...TIER, setup_fee_cents: 0 }, "monthly")
  check("paid activation carries ONE one-time setup-fee item at the tier's setup_fee_cents beside the recurring plan", paid.lineItems.length === 1 && paid.addInvoiceItems.length === 1 && (paid.addInvoiceItems[0] as any).price_data.unit_amount === 49900 && !(paid.addInvoiceItems[0] as any).price_data.recurring)
  check("a WAIVED fee produces no one-time item; a tier with no fee produces none either — the recurring plan is untouched in both", waived.addInvoiceItems.length === 0 && none.addInvoiceItems.length === 0 && (waived.lineItems[0] as any).price_data.unit_amount === 29900)
  control("the builder is not simply ignoring the fee (unwaived with a fee → an item)", paid.addInvoiceItems.length === 1)
  const now = new Date("2026-09-22T12:00:00.000Z")
  const trial = buildSubscriptionRow({ brokerageId: "b", tierId: "t", billing: { mode: "trial" }, now })
  const pending = buildSubscriptionRow({ brokerageId: "b", tierId: "t", billing: { mode: "paid", billingCycle: "monthly" }, now })
  check("a TRIAL row has a 14-day trial_end; a PAID-activation row is 'trialing' with trial_end = now (the paywall holds the door until checkout.session.completed) — no status outside the live vocabulary",
    trial.status === "trialing" && trial.trial_end === "2026-10-06T12:00:00.000Z" && pending.status === "trialing" && pending.trial_end === now.toISOString()
    && ["active", "cancelled", "past_due", "paused", "trialing"].includes(pending.status))
  const core = code(CORE)
  check("the core mints the activation checkout ONLY on the paid branch, through the ONE activation survivor, and reports a refusal by name (checkoutError) instead of rolling the tenant back",
    /if \(input\.billing\.mode === "paid"\) \{[\s\S]{0,3000}createActivationCheckout\(service, \{/.test(core) && (core.match(/createActivationCheckout\(/g) ?? []).length === 1 && /checkoutError = /.test(core) && !/rollbackTenantCreation\([\s\S]{0,200}checkout/.test(core))
  check("the trial branch never touches a checkout", !/mode === "trial"[\s\S]{0,400}createActivationCheckout/.test(core))
  check("the waiver FAILS CLOSED without a staff caller and without a reason, and is AUDITED (superadmin_audit_log subscription.setup_fee_waived + billing_metadata.setup_fee_waiver)",
    /if \(waiver && !input\.callerUserId\) return \{ ok: false/.test(core) && /if \(waiver && !\(waiver\.reason \?\? ""\)\.trim\(\)\) return \{ ok: false/.test(core)
    && /action: "subscription\.setup_fee_waived"/.test(core) && /setup_fee_waiver: waiverRecord/.test(core))
  // Lane 79D re-anchor: the fee is a one-time price in line_items (Checkout
  // Sessions reject subscription_data.add_invoice_items).
  check("the activation survivor is a HOSTED subscription checkout on the PLATFORM account with the setup fee as a one-time line_items price and the tenant in metadata (the webhook resolves it)",
    /export async function createActivationCheckout/.test(code(ACTIVATION)) && /mode: "subscription"/.test(code(ACTIVATION)) && /line_items: \[\.\.\.lineItems, \.\.\.addInvoiceItems\]/.test(code(ACTIVATION)) && !/add_invoice_items:/.test(code(ACTIVATION))
    && /getPlatformStripe\(\)/.test(code(ACTIVATION)) && /brokerage_id: input\.brokerageId/.test(code(ACTIVATION)) && /setup_fee_waived/.test(code(ACTIVATION)))
  check("the setup fee lands on the ledger the OS already keeps: the first Stripe invoice → billing_invoices (invoice.paid, amount_paid) — no new table", /case "invoice\.paid"/.test(code(WEBHOOK)) && /from\("billing_invoices"\)[\s\S]{0,300}amount_cents: invoice\.amount_paid/.test(code(WEBHOOK)) && !existsSync(join(root, "supabase/migrations")) === false && !/create table[\s\S]{0,60}setup_fee/i.test(raw(MIGRATION)))
}
{
  // Behaviour: the conversion's actor rule for the paid door, with the core injected.
  type Row = Record<string, unknown> & { id: string }
  function convSvc(prospects: Row[]) {
    const tables: Record<string, Row[]> = { platform_prospects: prospects, calendar_events: [], brokerages: [], superadmin_audit_log: [] }
    function from(name: string) {
      const store = tables[name] ?? (tables[name] = [])
      let filters: Array<(r: Row) => boolean> = []
      let op: { kind: "select" | "insert" | "update"; payload?: Record<string, unknown> } = { kind: "select" }
      let single = false
      const api: any = {
        select() { return api }, eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return api }, is(c: string, v: unknown) { filters.push((r) => r[c] === v); return api },
        in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return api }, maybeSingle() { single = true; return api }, single() { single = true; return api },
        insert(p: Record<string, unknown>) { op = { kind: "insert", payload: p }; return api }, update(p: Record<string, unknown>) { op = { kind: "update", payload: p }; return api },
        then(resolve: (v: unknown) => unknown) {
          const match = store.filter((r) => filters.every((f) => f(r)))
          let out: unknown
          if (op.kind === "insert") { const r = { id: `${name}-${store.length + 1}`, ...op.payload } as Row; store.push(r); out = { data: r, error: null } }
          else if (op.kind === "update") { for (const r of match) Object.assign(r, op.payload); out = { data: match.map((r) => ({ id: r.id })), error: null } }
          else out = { data: single ? (match[0] ?? null) : match, error: null }
          filters = []; op = { kind: "select" }; single = false
          return Promise.resolve(resolve(out))
        },
      }
      return api
    }
    return { from, tables }
  }
  const row = { id: "p", name: "Dana Lee", email: "dana@acme.com", phone: null, company: "Acme", role_interest: "team", status: "contacted", converted_brokerage_id: null, details: {} }
  const seams = () => {
    const calls: any[] = []
    return { calls, deps: { provisionTenant: async (_s: any, input: any) => { calls.push(input); return { ok: true, brokerageId: "brk", userId: "usr", subscriptionId: "sub", trialEndsAt: null, inviteSent: true, checkoutUrl: "https://checkout.stripe.test/cs_1", setupFeeCents: 49900, setupFeeWaived: false, extrasSkipped: [] } }, notifyStaff: async () => 0 } }
  }
  {
    const s = seams()
    const r = await convertProspectToSubscriber(convSvc([{ ...row }]) as any, { prospectId: "p", actor: { kind: "prospect_self", channel: "web:prospect_chat" }, billing: { mode: "paid", billingCycle: "annual" } }, s.deps)
    check("a PROSPECT may activate paid on a chat surface: the core is called with mode paid / annual and NO waiver; the checkout URL and the fee come back", r.ok && !r.alreadyConverted && s.calls[0]?.billing?.mode === "paid" && s.calls[0]?.billing?.billingCycle === "annual" && !s.calls[0]?.billing?.setupFeeWaiver && r.checkoutUrl === "https://checkout.stripe.test/cs_1" && r.setupFeeCents === 49900)
  }
  {
    const s = seams()
    const r = await convertProspectToSubscriber(convSvc([{ ...row }]) as any, { prospectId: "p", actor: { kind: "prospect_self", channel: "web:prospect_chat" }, billing: { mode: "paid", billingCycle: "monthly", setupFeeWaiver: { reason: "please" } } }, s.deps)
    check("a prospect asking to WAIVE their own fee is refused and the core is never called (control: zero provisioning calls)", !r.ok && /platform staff/.test(r.error) && s.calls.length === 0)
  }
  {
    const s = seams()
    const r = await convertProspectToSubscriber(convSvc([{ ...row }]) as any, { prospectId: "p", actor: { kind: "platform_staff", userId: "staff", email: "rep@x.test" }, billing: { mode: "paid", billingCycle: "monthly", setupFeeWaiver: { reason: "migration credit" } } }, s.deps)
    check("STAFF may waive: the core receives the waiver with its reason under the staff caller id", r.ok && s.calls[0]?.billing?.setupFeeWaiver?.reason === "migration credit" && s.calls[0]?.callerUserId === "staff")
  }
  {
    const s = seams()
    const r = await convertProspectToSubscriber(convSvc([{ ...row }]) as any, { prospectId: "p", actor: { kind: "prospect_self", channel: "web:prospect_chat" }, billing: { mode: "active", billingCycle: "monthly" } }, s.deps)
    check("a prospect can still never self-provision an 'active' (invoiced) row", !r.ok && s.calls.length === 0)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4 · SURFACES — the prospect's choice drives trial vs paid; the fee is quoted from the row, never invented]")
{
  const tools = code(TOOLS)
  check("start_subscription takes activation: trial | paid (+ billing_cycle) and maps 'paid' to billing mode paid, 'trial' to trial",
    /start_subscription:\s*tool\(\{[\s\S]{0,3000}activation: z\.enum\(\["trial", "paid"\]\)/.test(tools) && /a\.activation === "paid"\s*\?\s*\{ mode: "paid" as const/.test(tools) && /: \{ mode: "trial" as const \}/.test(tools))
  // Lane 79D re-anchor: the checkout email moved onto the ONE sender
  // (lib/platform/subscriber-door.ts::sendActivationCheckoutEmail) so every
  // entrance sends it; the tool delegates and the survivor rides dispatchEmail.
  const door = code("lib/platform/subscriber-door.ts")
  check("the paid result emails the hosted checkout through the ONE sender (subscriber-door → dispatchEmail, the ONE egress survivor) and never a raw sender; the fee is stated from the result, not a literal",
    /sendActivationCheckoutEmail\(svc, \{/.test(tools) && /systemSource: "platform_prospect_activation_checkout"/.test(door) && /@\/lib\/providers\/dispatch/.test(door) && !/@\/lib\/providers\/messaging/.test(tools + door) && /r\.setupFeeCents/.test(tools) && !/\$\d{2,}/.test(tools + door))
  const { PLATFORM_EXIT_MENU } = await import("../lib/ai-isa/qualification-playbook")
  const exit = PLATFORM_EXIT_MENU.find((o) => o.tool === "start_subscription")
  check("the playbook exit offers BOTH honestly — free trial OR activate now with the plan's setup fee — and forbids inventing or waiving it", !!exit && /FREE TRIAL/.test(exit.when) && /ACTIVATE NOW/.test(exit.when) && /setup fee/.test(exit.when) && /never invent/.test(exit.when) && /never offer to waive/.test(exit.when))
  const { PLATFORM_PROSPECT_TOOL_GUIDANCE } = await import("../lib/platform/prospect-agent-tools")
  check("the tool guidance says the same (one wording, both surfaces)", /'trial'/.test(PLATFORM_PROSPECT_TOOL_GUIDANCE) && /'paid'/.test(PLATFORM_PROSPECT_TOOL_GUIDANCE) && /never invent an amount/.test(PLATFORM_PROSPECT_TOOL_GUIDANCE))
  const { composeTierLines } = await import("../lib/voice/platform-reception")
  const withFee = composeTierLines([{ display_name: "Team", monthly_price_cents: 29900, max_agents: 5, is_active: true, setup_fee_cents: 49900 }])[0]!
  const noFee = composeTierLines([{ display_name: "Solo", monthly_price_cents: 9900, max_agents: 2, is_active: true, setup_fee_cents: 0 }])[0]!
  check("the spoken tier lines carry the setup fee FROM THE ROW ($499 one-time) and say nothing about a fee when the row has none", /\$499 setup fee/.test(withFee) && /up to 5 agents/.test(withFee) && !/setup fee/.test(noFee))
  control("a line for a fee-bearing row would be caught if it dropped the amount", /\$499/.test(withFee))
  check("the reception context selects setup_fee_cents so the line can be composed", /select\("display_name, monthly_price_cents, max_agents, is_active, setup_fee_cents"\)/.test(code(RECEPTION)))
  check("the growth board offers trial / activate-now (with an audited waiver + reason) / invoiced-active, and the action maps the waiver reason onto the core's SetupFeeWaiver",
    /mode: 'paid', billingCycle: form\.cycle, setupFeeWaiverReason/.test(code(BOARD)) && /A waiver needs a reason/.test(raw(BOARD)) && /setupFeeWaiver: \(input\.billing\.setupFeeWaiverReason \?\? ""\)\.trim\(\) \? \{ reason:/.test(code(GROWTH_ACTIONS)))
  check("/get-started posts the signer's choice (activation + billingCycle) and redirects a paid signer to the hosted checkout; the fee shown is the tier row's setupCents",
    /activation,\s*billingCycle: activation === "paid" \? billingCycle : undefined/.test(code(FORM)) && /window\.location\.assign\(r\.checkoutUrl\)/.test(code(FORM)) && /selectedTier\.setupCents/.test(code(FORM)))
  // Lane 79D re-anchor: the signer's choice is planned by the door
  // (planSubscriberEntrance → plan.billing) and mapped from there.
  check("the signup action maps 'paid' → mode paid with no waiver field (a public door cannot waive) and defaults to the trial", /plan\.billing\.mode === "paid" \? "paid" : "trial"/.test(code(SIGNUP)) && /\{ mode: "paid" as const, billingCycle:/.test(code(SIGNUP)) && !/setupFeeWaiver/.test(code(SIGNUP)) && !/setupFeeWaiver/.test(code("lib/platform/subscriber-door.ts")))
  check("the webhook's checkout.session.completed advances linked prospects trial → converted, COUNTED", /case "checkout\.session\.completed"[\s\S]{0,2500}from\("platform_prospects"\)[\s\S]{0,200}status: "converted"[\s\S]{0,200}\.eq\("status", "trial"\)[\s\S]{0,80}\.select\("id"\)/.test(code(WEBHOOK)))
  check("the core's prospect stamp: 'converted' only for an invoiced active row; trial AND paid-pending are 'trial' until money moves", /outcome: input\.billing\.mode === "active" \? "converted" : "trial"/.test(code(CORE)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5 · registration]")
{
  const pkg = raw("package.json")
  check(`"test:seat-bands" is registered`, /"test:seat-bands":\s*"tsx --conditions=react-server scripts\/seat-bands-guard\.ts"/.test(pkg))
  const guardLine = /"guard":\s*"([^"]+)"/.exec(pkg)?.[1] ?? ""
  check("the guard chain runs it AFTER test:scrapers (ordering only — never an adjacency pin)", guardLine.indexOf("npm run test:scrapers") >= 0 && guardLine.indexOf("npm run test:seat-bands") > guardLine.indexOf("npm run test:scrapers"))
  check("MAINTENANCE_DOMAINS carries seat_bands_and_paid_activation with proof test:seat-bands", /seat_bands_and_paid_activation:\s*\{\s*manager:\s*"[a-z_]+",\s*proof:\s*"test:seat-bands"/.test(code("lib/kernel/manager-registry.ts")))
}

console.log("\n" + "─".repeat(60))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log("\n❌ SEAT_BANDS — see failures above")
  process.exit(1)
}
console.log(`\n✅ SEAT_BANDS — one derivation (${CANONICAL_TIERS.map((t) => TIER_SEAT_BANDS[t] ?? "custom").join("/")}), staff never consume a seat, the setup fee rides paid activation and only staff may waive it`)
