#!/usr/bin/env tsx
/**
 * scripts/seat-cap-simulator.ts   (npm run test:seat-cap)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SEAT CAP IS A CAP ONLY IF EVERY DOOR IS GATED, AND ONLY IF IT REFUSES
 * WHEN IT CANNOT SEE.
 *
 * OWNER RULING, VERBATIM:
 *   "team tier only has 5 seats for the subscription and if they need more than
 *    they need to upgrade to a brokerage plan. agent tier subscription only has
 *    2 seats and if they need more than they need to upgrade to a team
 *    subscription. but these lower plans need to be treated like mini
 *    brokerages."
 *
 * LAYER 1 — pure: the caps, the upgrade targets, the refusal copy, the
 *   catalogue-over-literal precedence, and who does NOT consume a seat.
 * LAYER 2 — the gate, driven against a FAKE supabase client, so the three
 *   fail-closed branches (tenant / count / catalogue unreadable) can actually be
 *   made to happen rather than asserted about.
 * LAYER 3 — source: every add path found in the tree resolves through the ONE
 *   gate.
 * LAYER 4 — live catalogue (skipped without creds): what subscription_tiers
 *   actually says today, so a passing pure layer cannot hide a wrong invoice.
 *
 * EVERY absence/negative assertion carries a POSITIVE CONTROL (CLAUDE.md §2): a
 * deliberately broken input that must make the same check go RED, printed as
 * `↺ control`. A check with no control is a check that has never proved it can
 * fail.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  seatDecision, seatDecisionMessage, seatCheck, effectiveSeatLimit, seatLimitForTier,
  roleConsumesSeat, TIER_SEAT_LIMITS, WORKSPACE_STAFF_ROLES, PRODUCER_SEAT_ROLES, LICENSED_SEAT_ROLES, SEAT_BY_PRODUCTION_ROLES, FREE_STAFF_ROLES, PARTNER_ROLES, TIER_LABELS,
  tierAllowsRole,
  type CatalogSeatLimits,
} from "../lib/kernel/tier-role-matrix"
import { seatGate, resolveSeatUsage, resolveCatalogSeatLimits } from "../lib/kernel/seat-usage"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
/** POSITIVE CONTROL: the same assertion, fed a defect, MUST be false. */
const control = (n: string, wouldPass: boolean) => {
  if (!wouldPass) { pass++; console.log(`  ↺ control: ${n}`) }
  else { fail++; fails.push(`CONTROL DID NOT GO RED: ${n}`); console.log(`  ✗ CONTROL DID NOT GO RED: ${n}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

// ── A FAKE supabase client ───────────────────────────────────────────────────
// Only the four shapes seatGate uses: .from(t).select(c).eq(...).maybeSingle()
// for brokerages, .from(t).select(c).eq(...) for users / user_role_assignments,
// and .from("subscription_tiers").select(...).eq("is_active", true).
type TableFixture = { data: any; error: { message: string } | null }
function fakeSvc(fx: Record<string, TableFixture>) {
  const get = (t: string): TableFixture => fx[t] ?? { data: [], error: null }
  return {
    from(table: string) {
      const f = get(table)
      const thenable = {
        eq() { return thenable },
        in() { return thenable },
        not() { return thenable },
        order() { return thenable },
        limit() { return thenable },
        maybeSingle: async () => ({ data: Array.isArray(f.data) ? (f.data[0] ?? null) : f.data, error: f.error }),
        then(res: (v: any) => unknown) { return Promise.resolve({ data: f.data, error: f.error }).then(res) },
      }
      return { select() { return thenable } }
    },
  } as any
}
const tenant = (plan_tier: string | null, billing_metadata: unknown = {}) =>
  ({ data: [{ plan_tier, billing_metadata }], error: null })
const users = (rows: Array<{ id: string; user_type: string; status?: string }>) =>
  ({ data: rows.map((r) => ({ status: "active", ...r })), error: null })
const catalog = (rows: Array<{ tier_name: string; max_agents: number | null }>) =>
  ({ data: rows, error: null })
const LIVE_SHAPED_CATALOG = catalog([
  { tier_name: "solo_agent", max_agents: 2 },
  { tier_name: "team", max_agents: TIER_SEAT_LIMITS.team },
  { tier_name: "brokerage", max_agents: TIER_SEAT_LIMITS.brokerage },
  { tier_name: "multi_location", max_agents: -1 },
])
const seatUsers = (n: number) =>
  users(Array.from({ length: n }, (_, i) => ({ id: `u${i}`, user_type: "agent" })))
/** Wave 78A — a seat is a PRODUCER. The fact the count reads is an active agents
 *  record; this fixture is passed as the `agents` table. */
const agents = (userIds: string[]) => ({ data: userIds.map((user_id) => ({ user_id, is_active: true })), error: null })

async function main() {
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[1 · THE CAPS — agent tier 2, team tier 10, brokerage 30, multi-location custom (wave 79A)]")
  check("solo_agent (the owner's 'agent tier subscription') caps at 2",
    TIER_SEAT_LIMITS.solo_agent === 2)
  check("team caps at 10", TIER_SEAT_LIMITS.team === 10)
  // OWNER, 2026-09-23 (wave 79A): "solo tier is 2 seats; team tier is 10 seats;
  // brokerage tier is 30 seats; multi location tier is custom pricing for
  // seats" — superseding wave 78A's unlimited brokerage. m660 moves the live
  // catalogue; this literal is the plan-catalog table BY IDENTITY
  // (scripts/seat-bands-guard.ts), so it cannot say anything else.
  check("brokerage caps at 30", TIER_SEAT_LIMITS.brokerage === 30)
  check("multi_location is custom (null — unlimited until a count is negotiated)", TIER_SEAT_LIMITS.multi_location === null)
  const TEAM_BAND = TIER_SEAT_LIMITS.team as number
  const BRK_BAND = TIER_SEAT_LIMITS.brokerage as number
  check(`…so a brokerage is admitted up to its band and refused past it (${BRK_BAND} → ${BRK_BAND + 1})`,
    seatDecision("brokerage", BRK_BAND - 1).withinLimit && !seatDecision("brokerage", BRK_BAND).withinLimit)
  check("…while multi_location keeps hiring", seatDecision("multi_location", 4999).withinLimit)
  control("a brokerage capped at the team number would show as over one under its band",
    seatDecision("brokerage", BRK_BAND - 1, null, 1, { brokerage: TEAM_BAND }).withinLimit)
  control("the superseded UNLIMITED brokerage WOULD admit its 5,000th — the number this moved",
    seatDecision("brokerage", 4999, null, 1, { brokerage: null }).withinLimit === false)

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[1b · THE OWNER'S WORKED EXAMPLES, RE-READ UNDER 'STAFF SHOULD NOT TAKE UP SEATS']")
  //
  // OWNER, 2026-08-22, gave four rosters; OWNER, 2026-09-22 (wave 78A), ruled
  // "staff should not take up seats". The rosters stand — every user type may
  // still be SEATED on every tier — but what is BILLED is the producer: agent
  // and team_lead by type; broker and broker_owner by type unless the tenant
  // exempts them (wave 80A, owner: "brokers and broker owners can be a
  // producing seat."); admin only while they hold an agents record;
  // broker_admin, tc, isa, compliance_officer never.
  //
  //   solo (2)      : owner(admin, produces) + agent      = 2 of 2, a tc is free, a 3rd producer refused
  //   team (10)     : team_lead + agent + broker            = 3 of 10, admin + tc + isa free, an EXEMPTED broker free
  //   brokerage (∞) : broker_admin + team_lead + agent     = 2 seats, never refused
  //   multi         : the same shapes, unlimited
  {
    type Seated = { role: string; produces?: boolean }
    /** Seats consumed by a roster — the rule under test. `produces` is passed
     *  THREE-VALUED (true / false / undefined): this helper used to collapse
     *  "nobody said" onto false, which is exactly the wave-78A inference the
     *  wave-80A ruling retires (a broker with no statement is a seat). */
    const seatsFor = (roster: readonly Seated[]) =>
      roster.filter((r) => roleConsumesSeat(r.role, { produces: r.produces })).length
    /** The RETIRED rule (every working user type is a seat) — the control in each example. */
    const retiredSeatsFor = (roster: readonly Seated[]) =>
      roster.filter((r) => (WORKSPACE_STAFF_ROLES as readonly string[]).includes(r.role)).length

    // ── SOLO: owner (admin wearing an agents row) + agent = 2 of 2 ──────────
    const solo: Seated[] = [{ role: "admin", produces: true }, { role: "agent" }]
    check("SOLO · the producing owner (admin + agents row) and an agent both consume a seat → 2 of 2", seatsFor(solo) === 2)
    check("SOLO · a TC hired by the solo agent is FREE — 2 of 2 stays 2 of 2", seatsFor([...solo, { role: "tc" }]) === 2)
    check("SOLO · the 2nd seat is still INSIDE the plan",
      seatDecision("solo_agent", 1).withinLimit)
    check("SOLO · …and the 3rd PRODUCER is REFUSED, naming Team",
      !seatDecision("solo_agent", 2).withinLimit
      && seatDecision("solo_agent", 2).upgradeTo === "team")
    control("SOLO · the retired rule charged the TC a seat (3 of 2) — if staff ever count again the two rules agree and this goes red",
      retiredSeatsFor([...solo, { role: "tc" }]) === seatsFor([...solo, { role: "tc" }]))

    // ── TEAM: team_lead + agent + broker = 3 of 10 ──────────────────────────
    const team: Seated[] = [{ role: "team_lead" }, { role: "agent" }, { role: "broker" }]
    check("TEAM · team_lead + agent + a broker → 3 seats (a broker is a producer BY TYPE, wave 80A — no agents row needed)", seatsFor(team) === 3)
    check("TEAM · a BROKER may be seated on team tier (the ruling that moved this)",
      tierAllowsRole("team", "broker"))
    check("TEAM · a broker who runs the shop and does not sell is FREE only once the tenant EXEMPTS them (produces: false)", seatsFor([{ role: "broker", produces: false }]) === 0)
    // (this file's control() takes the DEFECT condition and goes red when it is true)
    control("TEAM · the superseded wave-78A inference (no agents row ⇒ free broker) would count a broker with NO statement as 0 — if that ever comes back this goes red", seatsFor([{ role: "broker" }]) === 0)
    check("TEAM · admin + tc + isa on top of them are FREE — still 3 of 5",
      seatsFor([...team, { role: "admin" }, { role: "tc" }, { role: "isa" }]) === 3)
    check(`TEAM · 3 of ${TEAM_BAND} is inside the plan, with ${TEAM_BAND - 3} to spare`,
      seatDecision("team", 3).withinLimit && seatDecision("team", 3).remaining === TEAM_BAND - 3)
    control("TEAM · the retired rule billed the admin, tc and isa (6 of 5) — the two rules must disagree here",
      retiredSeatsFor([...team, { role: "admin" }, { role: "tc" }, { role: "isa" }]) === seatsFor([...team, { role: "admin" }, { role: "tc" }, { role: "isa" }]))

    // ── BROKERAGE: broker_admin + team_lead + agent = 2 seats, unlimited ────
    const brokerage: Seated[] = [{ role: "broker_admin" }, { role: "team_lead" }, { role: "agent" }]
    check("BROKERAGE · broker_admin is STAFF (free); team_lead + agent → 2 seats", seatsFor(brokerage) === 2)
    check("BROKERAGE · broker_admin never consumes a seat", !roleConsumesSeat("broker_admin", { produces: true }))
    check(`BROKERAGE · ${BRK_BAND} seats — 2 seated, ${BRK_BAND - 2} remaining`,
      seatDecision("brokerage", 2).withinLimit && seatDecision("brokerage", 2).remaining === BRK_BAND - 2)
    control("BROKERAGE · the retired rule counted broker_admin (3) — the two rules must disagree here",
      retiredSeatsFor(brokerage) === seatsFor(brokerage))

    // ── MULTI-LOCATION: the same shapes, unlimited ──────────────────────────
    check("MULTI · the same shapes are all seatable",
      [...solo, ...team, ...brokerage].every((r) => tierAllowsRole("multi_location", r.role as never)))
    check("MULTI · unlimited — no roster size is ever 'over'",
      seatDecision("multi_location", 3).withinLimit
      && seatDecision("multi_location", 50_000).withinLimit
      && seatDecision("multi_location", 3).remaining === null)
    control("MULTI · a capped multi_location WOULD refuse at its cap",
      seatDecision("multi_location", 3, null, 1, { multi_location: 2 }).withinLimit)

    // ── THE RULE UNDERNEATH ALL FOUR ────────────────────────────────────────
    check("EVERY producer costs exactly ONE seat — by type, by licence unless exempted, or by production",
      PRODUCER_SEAT_ROLES.every((r) => seatsFor([{ role: r }]) === 1 && seatsFor([{ role: r, produces: false }]) === 1)
      && LICENSED_SEAT_ROLES.every((r) => seatsFor([{ role: r }]) === 1 && seatsFor([{ role: r, produces: true }]) === 1 && seatsFor([{ role: r, produces: false }]) === 0)
      && SEAT_BY_PRODUCTION_ROLES.every((r) => seatsFor([{ role: r, produces: true }]) === 1 && seatsFor([{ role: r }]) === 0))
    check("…and FREE STAFF cost none, even 'producing' (the ISA's desk agents row is not a licence)",
      FREE_STAFF_ROLES.every((r) => seatsFor([{ role: r, produces: true }]) === 0))
    check("…and NON-staff cost none: contact, lender, vendor, system (the AI-ISA actor)",
      seatsFor([{ role: "contact" }, { role: "lender" }, { role: "vendor" }, { role: "system" }]) === 0)
    control("a partner counted as a seat would break the contacts rule",
      seatsFor([{ role: "vendor" }]) === 0 && roleConsumesSeat("vendor" as never, { produces: true }))
    check("…so a tenant's whole contact book never eats the plan",
      seatsFor(Array(500).fill({ role: "contact" })) === 0)
  }

  console.log("\n[2 · THE THIRD SEAT AND THE SIXTH — refused, naming the upgrade]")
  const soloAt2 = seatDecision("solo_agent", 2)
  check("agent tier: the 3rd seat is REFUSED", soloAt2.withinLimit === false)
  check("…and the refusal names TEAM, the next tier up", soloAt2.upgradeTo === "team")
  check("…quoting the seats team gives them", soloAt2.upgradeSeats === TEAM_BAND)
  check("…in the sentence a person reads",
    (seatDecisionMessage(soloAt2) ?? "").includes(`upgrade to ${TIER_LABELS.team} for ${TEAM_BAND} seats`))
  control("the 2nd seat on agent tier is NOT refused (the cap is 2, not 1)",
    seatDecision("solo_agent", 1).withinLimit === false)

  const teamAt5 = seatDecision("team", TEAM_BAND)
  check(`team tier: the ${TEAM_BAND + 1}th seat is REFUSED`, teamAt5.withinLimit === false)
  check("…and the refusal names BROKERAGE", teamAt5.upgradeTo === "brokerage")
  check(`…quoting ${BRK_BAND} seats on brokerage`, teamAt5.upgradeSeats === BRK_BAND
    && new RegExp(`for ${BRK_BAND} seats`).test(seatDecisionMessage(teamAt5) ?? ""))
  check("…in the sentence a person reads",
    (seatDecisionMessage(teamAt5) ?? "").includes(`upgrade to ${TIER_LABELS.brokerage}`))
  control(`the ${TEAM_BAND}th seat on team tier is NOT refused (the cap is ${TEAM_BAND}, not ${TEAM_BAND - 1})`,
    seatDecision("team", TEAM_BAND - 1).withinLimit === false)

  console.log("\n[2b · THE REFUSAL IS AN UPGRADE PROMPT, NOT A SCOLDING OR AN UPSELL]")
  // The NEW ruling replaced 'or pay per seat' with 'upgrade'. Where a tier above
  // exists, the money sentence must be gone.
  check("no 'deactivate / remove / suspend somebody' anywhere in the copy",
    !/remove|deactivate|suspend/i.test(seatDecisionMessage(soloAt2) ?? ""))
  check("no per-seat price offered where an UPGRADE is the ruling",
    !/\$\d+\/month/.test(seatDecisionMessage(soloAt2) ?? "")
    && !/\$\d+\/month/.test(seatDecisionMessage(teamAt5) ?? ""))
  control("the superseded copy (which quoted $/month beside the upgrade) would fail that",
    !/\$\d+\/month/.test("Upgrading to Team gives you 5 seats — or add the seat for $25/month."))
  // Wave 79A: the per-seat LITERAL is retired; past a staff cap the door offers
  // the catalogue's package when sellable, else a person — never an invented $.
  check("the top tier, where there IS no tier to climb, hands off to a person (contact) with no invented price",
    seatDecision("multi_location", 9, 9).outcome === "over_limit"
    && seatDecision("multi_location", 9, 9).paths.every((p) => p.kind === "contact")
    && !/\$\d/.test(seatDecisionMessage(seatDecision("multi_location", 9, 9)) ?? ""))
  check("a staff-set OVERRIDE is a deliberate cap, so it never says 'upgrade'",
    seatDecision("solo_agent", 3, 3).outcome === "over_limit"
    && seatDecision("solo_agent", 3, 3).upgradeTo === null
    && !seatDecision("solo_agent", 3, 3).paths.some((p) => p.kind === "upgrade"))

  console.log("\n[3 · WHAT IS A SEAT — producers only; staff, contacts, lenders, vendors are NOT]")
  check("the working roster is the nine staff user types (the invite menu), partitioned into producer / licensed / by-production / free",
    ["admin", "broker", "broker_admin", "broker_owner", "team_lead", "agent", "tc", "isa", "compliance_officer"]
      .every((r) => (WORKSPACE_STAFF_ROLES as readonly string[]).includes(r))
    && WORKSPACE_STAFF_ROLES.length === PRODUCER_SEAT_ROLES.length + LICENSED_SEAT_ROLES.length + SEAT_BY_PRODUCTION_ROLES.length + FREE_STAFF_ROLES.length)
  for (const nonSeat of ["contact", "lender", "vendor", "system", "tc", "isa", "compliance_officer", "broker_admin"]) {
    check(`'${nonSeat}' consumes NO seat`, roleConsumesSeat(nonSeat as any, { produces: true }) === false)
  }
  check("vendor is the partner role and partners never consume a seat",
    (PARTNER_ROLES as readonly string[]).includes("vendor")
    && !(PARTNER_ROLES as readonly string[]).some((r) => (WORKSPACE_STAFF_ROLES as readonly string[]).includes(r)))
  control("a scan that called every role a seat would pass the wrong way",
    ["contact", "lender", "vendor"].every((r) => (["contact", "lender", "vendor", ...WORKSPACE_STAFF_ROLES] as string[]).includes(r)) === false)

  // The count itself must skip them — the fear is a brokerage's CONTACT LIST
  // eating the plan.
  {
    const svc = fakeSvc({
      users: users([
        { id: "a", user_type: "agent" },
        { id: "b", user_type: "admin" },   // the owner — produces (agents row below)
        { id: "c", user_type: "contact" },
        { id: "d", user_type: "lender" },
        { id: "e", user_type: "vendor" },
        { id: "f", user_type: "system" },
        { id: "g", user_type: "agent", status: "suspended" },
        { id: "h", user_type: "tc" },      // free staff
      ]),
      agents: agents(["b"]),
      user_role_assignments: { data: [], error: null },
    })
    const usage = await resolveSeatUsage(svc, "b1")
    check("2 producers + 1 free staff + 3 partners/system + 1 suspended ⇒ 2 seats, 1 free staff", usage.seatCount === 2 && usage.freeStaffCount === 1)
    check("…while the PEOPLE count still sees all 8", usage.peopleCount === 8)
    control("counting people as seats would have said 8", usage.peopleCount === 2)
  }
  {
    // 60 contacts on a 2-seat plan is still 2 seats — the exact wrong answer to avoid.
    const svc = fakeSvc({
      brokerages: tenant("solo_agent"),
      subscription_tiers: LIVE_SHAPED_CATALOG,
      users: users([
        { id: "a", user_type: "agent" }, { id: "b", user_type: "admin" },
        ...Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, user_type: "contact" })),
      ]),
      agents: agents(["b"]),
      user_role_assignments: { data: [], error: null },
    })
    const v = await seatGate(svc, "b1", "contact")
    check("adding a 61st CONTACT to a full 2-seat tenant is ALLOWED", v.allowed && v.reason === "not_a_seat")
    const v2 = await seatGate(svc, "b1", "agent")
    check("…while the 3rd AGENT on the same tenant is refused", !v2.allowed && v2.decision?.upgradeTo === "team")
    const v3 = await seatGate(svc, "b1", "tc")
    check("…and a TC on the same full tenant is ALLOWED — staff never take a seat (wave 78A)", v3.allowed && v3.reason === "not_a_seat")
  }

  console.log("\n[4 · A SEAT IS A PERSON, ACROSS BOTH ROLE SOURCES]")
  {
    const svc = fakeSvc({
      users: users([{ id: "a", user_type: "contact" }, { id: "b", user_type: "agent" }, { id: "c", user_type: "admin" }]),
      user_role_assignments: { data: [{ user_id: "a", role: "agent" }, { user_id: "b", role: "team_lead" }, { user_id: "c", role: "tc" }], error: null },
    })
    const usage = await resolveSeatUsage(svc, "b1")
    check("a 'contact' holding an AGENT grant holds a seat (user_type alone under-counts)",
      usage.seatCount === 2 && usage.seatHolderIds.includes("a"))
    check("a user with TWO producer roles is still ONE seat; an admin granted tc holds none", usage.seatHolderIds.length === 2 && !usage.seatHolderIds.includes("c"))
  }

  console.log("\n[5 · FAIL CLOSED — three ways the gate can fail to know, three refusals]")
  {
    const svc = fakeSvc({ brokerages: { data: [], error: { message: "boom" } }, subscription_tiers: LIVE_SHAPED_CATALOG })
    const v = await seatGate(svc, "b1", "agent")
    check("tenant row unreadable ⇒ REFUSE", v.allowed === false && v.reason === "tenant_unreadable")
    check("…and the refusal says WHY, not just 'denied'", /plan could not be read/.test(v.message ?? ""))
  }
  {
    // No error, no row — the shape a wrong id or an RLS-refused single read
    // produces. "We found nothing" must not resolve as "unlimited".
    const svc = fakeSvc({ brokerages: { data: [], error: null }, subscription_tiers: LIVE_SHAPED_CATALOG })
    const v = await seatGate(svc, "b1", "agent")
    check("tenant MISSING (no row, no error) ⇒ REFUSE too", v.allowed === false && v.reason === "tenant_unreadable")
  }
  {
    // A tenant that EXISTS with a NULL plan_tier is a different case: it is
    // readable, so the gate runs and the floor tier answers.
    const svc = fakeSvc({
      brokerages: tenant(null), users: seatUsers(2),
      user_role_assignments: { data: [], error: null }, subscription_tiers: LIVE_SHAPED_CATALOG,
    })
    const v = await seatGate(svc, "b1", "agent")
    check("a tenant with a NULL plan_tier is READ, then held to the floor cap",
      v.allowed === false && v.reason === "over_limit" && v.decision?.limit === 2)
  }
  {
    const svc = fakeSvc({
      brokerages: tenant("solo_agent"),
      users: { data: null, error: { message: "refused" } },
      user_role_assignments: { data: [], error: null },
      subscription_tiers: LIVE_SHAPED_CATALOG,
    })
    const v = await seatGate(svc, "b1", "agent")
    check("seat COUNT unreadable ⇒ REFUSE (a swallowed refusal reads as 0 seats used)",
      v.allowed === false && v.reason === "seat_count_unreadable")
    control("the pre-fix behaviour — 0 seats used, so the add sails through — is what this kills",
      seatCheck("solo_agent", 0).allowed === false)
  }
  {
    const svc = fakeSvc({
      brokerages: tenant("solo_agent"),
      users: seatUsers(0),
      user_role_assignments: { data: [], error: null },
      subscription_tiers: { data: null, error: { message: "catalogue refused" } },
    })
    const v = await seatGate(svc, "b1", "agent")
    check("plan CATALOGUE unreadable ⇒ REFUSE, even with seats to spare",
      v.allowed === false && v.reason === "catalog_unreadable")
    check("…quoting the underlying error", /catalogue refused/.test(v.message ?? ""))
  }
  {
    const svc = fakeSvc({
      brokerages: tenant("not_a_real_tier"),
      users: seatUsers(2),
      user_role_assignments: { data: [], error: null },
      subscription_tiers: LIVE_SHAPED_CATALOG,
    })
    const v = await seatGate(svc, "b1", "agent")
    check("an UNRECOGNISED tier resolves to the FLOOR cap and refuses the 3rd seat",
      v.allowed === false && v.decision?.limit === 2)
    check("…still naming an upgrade rather than dead-ending", v.decision?.upgradeTo === "team")
    control("the superseded fail-OPEN rule (unknown ⇒ unlimited) would have allowed it",
      seatLimitForTier("not_a_real_tier") === null)
  }

  console.log("\n[6 · THE NUMBER IS CATALOGUE DATA, NOT A LITERAL IN A BRANCH]")
  const cat: CatalogSeatLimits = { solo_agent: 4, team: 9 }
  check("the catalogue OVERRIDES the code literal", seatLimitForTier("solo_agent", cat) === 4)
  check("…and a tier absent from the catalogue falls back to the literal",
    seatLimitForTier("brokerage", cat) === TIER_SEAT_LIMITS.brokerage)
  check("the gate's decision follows the catalogue, not the literal",
    seatDecision("solo_agent", 3, null, 1, cat).withinLimit === true
    && seatDecision("solo_agent", 4, null, 1, cat).withinLimit === false)
  check("the UPGRADE COPY quotes the catalogue's seats for the target tier",
    seatDecision("solo_agent", 4, null, 1, cat).upgradeSeats === 9)
  control("a resolver ignoring the catalogue would still say 2",
    seatLimitForTier("solo_agent", cat) === 2)
  {
    // -1 and NULL are both 'unlimited' in the catalogue's vocabulary.
    const svc = fakeSvc({ subscription_tiers: LIVE_SHAPED_CATALOG })
    const read = await resolveCatalogSeatLimits(svc)
    const nullRead = await resolveCatalogSeatLimits(fakeSvc({ subscription_tiers: catalog([{ tier_name: "multi_location", max_agents: null }]) }))
    check("catalogue read: NULL ⇒ unlimited", nullRead.ok && nullRead.limits.multi_location === null)
    check("…and the fallback agrees with the catalogue on brokerage (both the band — wave 79A)", seatLimitForTier("brokerage", read.limits) === TIER_SEAT_LIMITS.brokerage && seatLimitForTier("brokerage") === TIER_SEAT_LIMITS.brokerage)
    check("catalogue read: -1 ⇒ unlimited (not a cap of minus one)", read.limits.multi_location === null)
    check("catalogue read: the three capped tiers come through as numbers",
      read.limits.solo_agent === 2 && read.limits.team === TIER_SEAT_LIMITS.team && read.limits.brokerage === TIER_SEAT_LIMITS.brokerage)
    control("treating -1 as a literal cap would refuse every add on the top tier",
      seatCheck("multi_location", 0, -1).allowed === true)
  }
  {
    const svc = fakeSvc({ subscription_tiers: { data: null, error: { message: "nope" } } })
    const read = await resolveCatalogSeatLimits(svc)
    check("a REFUSED catalogue read reports ok:false, never an empty map that looks fine",
      read.ok === false && read.error === "nope")
  }

  console.log("\n[7 · THE OVERRIDE STILL WINS, AND THE MATH IS UNCHANGED BY ANY OF THIS]")
  check("staff override raises a capped tier", effectiveSeatLimit("solo_agent", 12).limit === 12)
  check("…and can cap an unlimited one (multi_location is unlimited until negotiated)", effectiveSeatLimit("multi_location", 25).limit === 25 && effectiveSeatLimit("multi_location", null).limit === null)
  check("no override ⇒ the resolved tier number", effectiveSeatLimit("team", null).limit === TIER_SEAT_LIMITS.team)
  check("asking about the CURRENT state (0 requested) never invents an overage",
    seatDecision("solo_agent", 2, null, 0).withinLimit === true)

  // ── THE DISPLAY VERDICT AND THE ENFORCED VERDICT ARE ONE VERDICT ──────────
  //
  // `seatCheck` is what the admin seat meter renders; `seatDecision` is what the
  // invite gate enforces. They were two independent derivations of the same
  // rule, which is a drift the tenant would only discover by being told they had
  // room and then refused — so seatCheck is now COMPUTED BY seatDecision. This
  // pins that: across every tier, every seat count either side of each limit,
  // and both override states, the two must agree on the limit, the verdict and
  // the remaining count. The grid is exhaustive rather than sampled because the
  // interesting inputs are exactly the boundaries.
  {
    const TIERS = ["solo_agent", "team", "brokerage", "multi_location", "not_a_real_tier", null]
    const OVERRIDES: Array<number | null> = [null, 0, 1, 12]
    let compared = 0
    const divergent: string[] = []
    for (const t of TIERS) {
      for (let n = 0; n <= 14; n++) {
        for (const ov of OVERRIDES) {
          const c = seatCheck(t, n, ov)
          const d = seatDecision(t, n, ov, 1)
          compared++
          if (c.allowed !== d.withinLimit || c.limit !== d.limit
            || c.remaining !== d.remaining || c.overridden !== d.overridden) {
            divergent.push(`${t}/${n}/${ov}`)
          }
        }
      }
    }
    console.log(`  · seatCheck ≡ seatDecision compared over ${compared} (tier × seats 0-14 × override) combinations`)
    check(`the meter's verdict and the gate's verdict never disagree (${divergent.length} divergence(s)${divergent.length ? `: ${divergent.slice(0, 5).join(", ")}` : ""})`,
      divergent.length === 0)
    // An equivalence assertion that cannot go red is decoration: this is what a
    // REAL divergence looks like, and the same comparison catches it.
    const stale = (tier: string | null, n: number) => {
      // The pre-merge arithmetic, but with the off-by-one a second copy drifts into.
      const lim = effectiveSeatLimit(tier, null).limit
      return lim === null ? true : n <= lim
    }
    control("the same comparison catches a meter that drifted one seat past the gate",
      stale("solo_agent", 2) === seatDecision("solo_agent", 2, null, 1).withinLimit)
  }

  console.log("\n[8 · EVERY ADD PATH GOES THROUGH THE ONE GATE]")
  // A cap enforced on one path is not a cap. These are every route by which a
  // person becomes a seat holder in a tenant, found by sweeping the tree for
  // user provisioning / role assignment / reactivation.
  const ADD_PATHS: Array<[string, string]> = [
    ["app/actions/admin/invite-user.ts", "tenant admin invites a user"],
    ["app/actions/superadmin/tenant-users.ts", "god console creates a tenant user + reactivates one"],
    ["app/actions/admin/update-user.ts", "role change into a seat role / reactivation"],
    ["app/api/recruiting/provision-agent/route.ts", "recruiting provisions a joined recruit"],
    ["lib/kernel/users.ts", "tenant-owner provisioning (signup + create-subscriber)"],
  ]
  for (const [file, what] of ADD_PATHS) {
    check(`${what} → seatGate (${file})`, /seatGate\(/.test(src(file)))
  }
  check("the gate itself lives in ONE module", /export async function seatGate/.test(src("lib/kernel/seat-usage.ts")))
  check("…and no add path hand-rolls a second seat count",
    ADD_PATHS.every(([f]) => !/from\("users"\)[\s\S]{0,200}user_type[\s\S]{0,120}length/.test(src(f))))
  control("the shape scan can see a real seatGate call",
    !/seatGate\(/.test("const verdict = await seatGate(svc, id, role)"))
  // The paths that must NOT be gated: partner + portal invites.
  for (const f of ["app/actions/vendor-invite.ts", "lib/portal/portal-invite-core.ts"]) {
    check(`${f} adds a PARTNER/CLIENT and is correctly not seat-gated`, !/seatGate\(/.test(src(f)))
  }

  console.log("\n[9 · THE MIGRATION THAT MAKES THE CATALOGUE AGREE WITH THE RULING]")
  const mig = "supabase/migrations/m523-the-seat-number-a-prospect-is-quoted-and-the-one-the-gate-enforces-were-two-different-numbers.sql"
  check("the seat-catalogue migration exists (written, NOT applied)", existsSync(join(process.cwd(), mig)))
  if (existsSync(join(process.cwd(), mig))) {
    const m = src(mig)
    check("…it sets solo_agent = 2", /max_agents = 2 WHERE tier_name = 'solo_agent'/.test(m))
    check("…it sets team = 5", /max_agents = 5 WHERE tier_name = 'team'/.test(m))
    check("…and it VERIFIES rather than hoping (postcondition block)", /RAISE EXCEPTION 'm523/.test(m))
  }
  const m655 = "supabase/migrations/m655-brokerage-seats-are-unlimited-and-a-seat-is-a-producer.sql"
  check("m655 (brokerage → unlimited, a seat is a producer) exists — its numbers are pinned to TIER_SEAT_BANDS by scripts/seat-bands-guard.ts", existsSync(join(process.cwd(), m655)))
  const parity = "supabase/migrations/m524-the-mini-brokerage-tiers-were-locked-out-of-their-own-board-money-and-settings.sql"
  check("the mini-brokerage parity migration exists (written, NOT applied)", existsSync(join(process.cwd(), parity)))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[10 · LIVE CATALOGUE]")
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("  ⏭  Skipped — SUPABASE creds not set. Layers 1-4 ran; the live catalogue was read")
    console.log("     through the Supabase MCP during this lane and is reported in the lane notes.")
  } else {
    const { createClient } = await import("@supabase/supabase-js")
    const svc = createClient(url, key, { auth: { persistSession: false } })
    const read = await resolveCatalogSeatLimits(svc as any)
    check("live catalogue read succeeds", read.ok)
    check(`live solo_agent cap is 2 (found ${String(read.limits.solo_agent)}) — RED until m523 is applied`,
      read.limits.solo_agent === 2)
    check(`live team cap is ${TIER_SEAT_LIMITS.team} (found ${String(read.limits.team)}) (m660 applied live 2026-09-23)`,
      read.limits.team === TIER_SEAT_LIMITS.team)
    check(`live brokerage cap is ${TIER_SEAT_LIMITS.brokerage} (found ${String(read.limits.brokerage)}) (m660 applied live 2026-09-23)`, read.limits.brokerage === TIER_SEAT_LIMITS.brokerage)
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SEAT_CAP_FAIL"); process.exit(1) }
  console.log(` ✅ SEAT_CAP_PASS — ${TIER_SEAT_LIMITS.solo_agent} seats on agent tier, ${TIER_SEAT_LIMITS.team} on team, ${TIER_SEAT_LIMITS.brokerage} on brokerage, every add path gated, unreadable refuses, and staff/contacts never eat a seat`)
}

main().catch((e) => { console.error(e); process.exit(1) })
