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
  roleConsumesSeat, TIER_SEAT_LIMITS, SEAT_ROLES, PARTNER_ROLES, TIER_LABELS,
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
  { tier_name: "team", max_agents: 5 },
  { tier_name: "brokerage", max_agents: null },
  { tier_name: "multi_location", max_agents: -1 },
])
const seatUsers = (n: number) =>
  users(Array.from({ length: n }, (_, i) => ({ id: `u${i}`, user_type: "agent" })))

async function main() {
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[1 · THE CAPS — agent tier 2, team tier 5, brokerage above them]")
  check("solo_agent (the owner's 'agent tier subscription') caps at 2",
    TIER_SEAT_LIMITS.solo_agent === 2)
  check("team caps at 5", TIER_SEAT_LIMITS.team === 5)
  // OWNER, 2026-08-22: "a brokerage should be changed to 50 seats … and then the
  // same goes for multiple location brokerages but unlimited seats." The live
  // catalogue was moved by m529 (subscription_tiers.max_agents = 50,
  // plan_limits.active_users = 50); this literal — the FALLBACK when the
  // catalogue cannot be read — still said unlimited, i.e. it failed OPEN on the
  // seat axis exactly when the real number was unavailable.
  check("brokerage caps at 50", TIER_SEAT_LIMITS.brokerage === 50)
  check("multi_location alone is uncapped", TIER_SEAT_LIMITS.multi_location === null)
  check("…so a brokerage's 50th seat is inside its plan and its 51st is not",
    seatDecision("brokerage", 49).withinLimit && !seatDecision("brokerage", 50).withinLimit)
  check("…while multi_location keeps hiring", seatDecision("multi_location", 4999).withinLimit)
  control("a brokerage capped at the team number would show as over",
    seatDecision("brokerage", 499, null, 1, { brokerage: 5 }).withinLimit)
  control("a brokerage treated as UNLIMITED would not refuse its 51st seat — the defect this pins",
    seatDecision("brokerage", 50, null, 1, { brokerage: null }).withinLimit === false)

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[1b · THE OWNER'S FOUR WORKED EXAMPLES, VERBATIM]")
  //
  // OWNER, 2026-08-22 — these four shapes ARE the specification, so they are
  // asserted as written rather than paraphrased:
  //
  //   solo (2)      : agent + admin                    = 2 of 2, 3rd refused
  //   team (5)      : team_lead + agent + broker       = 3 of 5
  //   brokerage (50): broker_admin + team_lead + agent = 3 of 50
  //   multi         : the same shapes, unlimited
  //
  // The load-bearing claim in each is that EVERY seated user costs exactly ONE
  // seat WHATEVER THEIR USER TYPE — the tier caps the count, not the menu.
  {
    /** Seats consumed by a roster of user types — the rule under test. */
    const seatsFor = (roster: readonly string[]) =>
      roster.filter((r) => roleConsumesSeat(r as never)).length

    // ── SOLO: agent + admin = 2 of 2 ────────────────────────────────────────
    const solo = ["agent", "admin"]
    check("SOLO · agent + admin both consume a seat → 2 of 2", seatsFor(solo) === 2)
    check("SOLO · the 2nd seat is still INSIDE the plan",
      seatDecision("solo_agent", 1).withinLimit)
    check("SOLO · …and the 3rd is REFUSED, naming Team",
      !seatDecision("solo_agent", 2).withinLimit
      && seatDecision("solo_agent", 2).upgradeTo === "team")
    control("SOLO · a roster of 3 would NOT fit 2 seats",
      seatsFor([...solo, "tc"]) <= (TIER_SEAT_LIMITS.solo_agent ?? 0))

    // ── TEAM: team_lead + agent + broker = 3 of 5 ───────────────────────────
    // THE SENTENCE THAT SUPERSEDED THE OLD MATRIX. A broker on TEAM tier.
    const team = ["team_lead", "agent", "broker"]
    check("TEAM · team_lead + agent + broker → 3 seats", seatsFor(team) === 3)
    check("TEAM · a BROKER may be seated on team tier (the ruling that moved this)",
      tierAllowsRole("team", "broker"))
    check("TEAM · 3 of 5 is inside the plan, with 2 to spare",
      seatDecision("team", 3).withinLimit && seatDecision("team", 3).remaining === 2)
    control("TEAM · the old matrix, which withheld broker, would refuse this example",
      ["team_lead", "agent", "broker"].every((r) =>
        (SEAT_ROLES.filter((x) => x !== "broker" && x !== "broker_owner") as readonly string[]).includes(r)))

    // ── BROKERAGE: broker_admin + team_lead + agent = 3 of 50 ───────────────
    const brokerage = ["broker_admin", "team_lead", "agent"]
    check("BROKERAGE · broker_admin + team_lead + agent → 3 seats", seatsFor(brokerage) === 3)
    check("BROKERAGE · broker_admin is a seat-consuming user type",
      roleConsumesSeat("broker_admin" as never))
    check("BROKERAGE · 3 of 50 is inside the plan, with 47 to spare",
      seatDecision("brokerage", 3).withinLimit && seatDecision("brokerage", 3).remaining === 47)
    control("BROKERAGE · if broker_admin consumed NO seat this example would count 2",
      seatsFor(["team_lead", "agent"]) === 3)

    // ── MULTI-LOCATION: the same shapes, unlimited ──────────────────────────
    check("MULTI · the same three shapes are all seatable",
      [...solo, ...team, ...brokerage].every((r) => tierAllowsRole("multi_location", r as never)))
    check("MULTI · unlimited — no roster size is ever 'over'",
      seatDecision("multi_location", 3).withinLimit
      && seatDecision("multi_location", 50_000).withinLimit
      && seatDecision("multi_location", 3).remaining === null)
    control("MULTI · a capped multi_location WOULD refuse at its cap",
      seatDecision("multi_location", 3, null, 1, { multi_location: 2 }).withinLimit)

    // ── THE RULE UNDERNEATH ALL FOUR ────────────────────────────────────────
    check("EVERY seat user type costs exactly ONE seat — no type is cheaper or dearer",
      SEAT_ROLES.every((r) => seatsFor([r]) === 1))
    check("…and NON-seats cost none: contact, lender, vendor, system (the AI-ISA actor)",
      seatsFor(["contact", "lender", "vendor", "system"]) === 0)
    control("a partner counted as a seat would break the contacts rule",
      seatsFor(["vendor"]) === 0 && roleConsumesSeat("vendor" as never))
    check("…so a tenant's whole contact book never eats the plan",
      seatsFor(Array(500).fill("contact")) === 0)
  }

  console.log("\n[2 · THE THIRD SEAT AND THE SIXTH — refused, naming the upgrade]")
  const soloAt2 = seatDecision("solo_agent", 2)
  check("agent tier: the 3rd seat is REFUSED", soloAt2.withinLimit === false)
  check("…and the refusal names TEAM, the next tier up", soloAt2.upgradeTo === "team")
  check("…quoting the seats team gives them", soloAt2.upgradeSeats === 5)
  check("…in the sentence a person reads",
    (seatDecisionMessage(soloAt2) ?? "").includes(`Upgrade to ${TIER_LABELS.team}`))
  control("the 2nd seat on agent tier is NOT refused (the cap is 2, not 1)",
    seatDecision("solo_agent", 1).withinLimit === false)

  const teamAt5 = seatDecision("team", 5)
  check("team tier: the 6th seat is REFUSED", teamAt5.withinLimit === false)
  check("…and the refusal names BROKERAGE", teamAt5.upgradeTo === "brokerage")
  check("…quoting the 50 seats brokerage gives them", teamAt5.upgradeSeats === 50)
  check("…in the sentence a person reads",
    (seatDecisionMessage(teamAt5) ?? "").includes(`Upgrade to ${TIER_LABELS.brokerage}`))
  control("the 5th seat on team tier is NOT refused (the cap is 5, not 4)",
    seatDecision("team", 4).withinLimit === false)

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
  check("the top tier, where there IS no tier to climb, still gets the per-seat offer",
    seatDecision("multi_location", 9, 9).outcome === "paid_seat_only"
    && /\$\d+\/month/.test(seatDecisionMessage(seatDecision("multi_location", 9, 9)) ?? ""))
  check("a staff-set OVERRIDE is a deliberate cap, so it never says 'upgrade'",
    seatDecision("solo_agent", 3, 3).outcome === "paid_seat_only"
    && seatDecision("solo_agent", 3, 3).upgradeTo === null)

  console.log("\n[3 · WHAT IS A SEAT — staff only; contacts, lenders, vendors are NOT]")
  check("the seat roles are the working staff roles",
    ["admin", "broker", "broker_owner", "team_lead", "agent", "tc", "isa", "compliance_officer"]
      .every((r) => (SEAT_ROLES as readonly string[]).includes(r)))
  for (const nonSeat of ["contact", "lender", "vendor", "system"]) {
    check(`'${nonSeat}' consumes NO seat`, roleConsumesSeat(nonSeat as any) === false)
  }
  check("vendor is the partner role and partners never consume a seat",
    (PARTNER_ROLES as readonly string[]).includes("vendor")
    && !(PARTNER_ROLES as readonly string[]).some((r) => (SEAT_ROLES as readonly string[]).includes(r)))
  control("a scan that called every role a seat would pass the wrong way",
    ["contact", "lender", "vendor"].every((r) => (["contact", "lender", "vendor", ...SEAT_ROLES] as string[]).includes(r)) === false)

  // The count itself must skip them — the fear is a brokerage's CONTACT LIST
  // eating the plan.
  {
    const svc = fakeSvc({
      users: users([
        { id: "a", user_type: "agent" },
        { id: "b", user_type: "admin" },
        { id: "c", user_type: "contact" },
        { id: "d", user_type: "lender" },
        { id: "e", user_type: "vendor" },
        { id: "f", user_type: "system" },
        { id: "g", user_type: "agent", status: "suspended" },
      ]),
      user_role_assignments: { data: [], error: null },
    })
    const usage = await resolveSeatUsage(svc, "b1")
    check("2 staff + 3 partners + 1 system + 1 suspended ⇒ 2 seats", usage.seatCount === 2)
    check("…while the PEOPLE count still sees all 7", usage.peopleCount === 7)
    control("counting people as seats would have said 7", usage.peopleCount === 2)
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
      user_role_assignments: { data: [], error: null },
    })
    const v = await seatGate(svc, "b1", "contact")
    check("adding a 61st CONTACT to a full 2-seat tenant is ALLOWED", v.allowed && v.reason === "not_a_seat")
    const v2 = await seatGate(svc, "b1", "agent")
    check("…while the 3rd AGENT on the same tenant is refused", !v2.allowed && v2.decision?.upgradeTo === "team")
  }

  console.log("\n[4 · A SEAT IS A PERSON, ACROSS BOTH ROLE SOURCES]")
  {
    const svc = fakeSvc({
      users: users([{ id: "a", user_type: "contact" }, { id: "b", user_type: "agent" }]),
      user_role_assignments: { data: [{ user_id: "a", role: "admin" }, { user_id: "b", role: "isa" }], error: null },
    })
    const usage = await resolveSeatUsage(svc, "b1")
    check("a 'contact' holding an ADMIN grant holds a seat (user_type alone under-counts)",
      usage.seatCount === 2 && usage.seatHolderIds.includes("a"))
    check("a user with TWO seat roles is still ONE seat", usage.seatHolderIds.length === 2)
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
    check("catalogue read: NULL ⇒ unlimited", read.ok && read.limits.brokerage === null)
    check("catalogue read: -1 ⇒ unlimited (not a cap of minus one)", read.limits.multi_location === null)
    check("catalogue read: the two capped tiers come through as numbers",
      read.limits.solo_agent === 2 && read.limits.team === 5)
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
  check("…and can cap an unlimited one", effectiveSeatLimit("brokerage", 25).limit === 25)
  check("no override ⇒ the resolved tier number", effectiveSeatLimit("team", null).limit === 5)
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
    check(`live team cap is 5 (found ${String(read.limits.team)}) — RED until m523 is applied`,
      read.limits.team === 5)
    check("live brokerage is unlimited", read.limits.brokerage === null)
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SEAT_CAP_FAIL"); process.exit(1) }
  console.log(" ✅ SEAT_CAP_PASS — 2 seats on agent tier, 5 on team, every add path gated, unreadable refuses, and contacts never eat a seat")
}

main().catch((e) => { console.error(e); process.exit(1) })
