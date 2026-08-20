#!/usr/bin/env tsx
/**
 * scripts/seat-display-simulator.ts (npm run test:seat-display)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SAME TENANT HAD THREE DIFFERENT SEAT COUNTS.
 *
 * The owner's plan: Solo = 2 seats (one staff/admin + one agent) · Team = 5 ·
 * Brokerage and Multi-Location unlimited. The seat MATH was right in
 * lib/kernel/tier-role-matrix.ts. Three surfaces then answered "how many seats
 * are in use?" differently, because two of them did not ask that module:
 *
 *   /dashboard/admin/users        SEAT_ROLES, excludes suspended.  CORRECT.
 *   critical-setup meter (AGENT)  its OWN copy of the seat list, which contained
 *                                 "broker_admin" — a value users.user_type does
 *                                 not admit, so it could never match — OMITTED
 *                                 "broker_owner", which the column DOES admit,
 *                                 and counted SUSPENDED users as working seats.
 *   Settings → User Access        `users.length`, twice, as both "Total Users"
 *                                 and "Active" — counting PARTNERS (vendor,
 *                                 lender), the `system` AI-ISA actor and
 *                                 suspended users as if they held seats, and
 *                                 showing no limit at all.
 *
 * Measured against the live tenant "Your Brokerage" (Solo, limit 2) whose users
 * are admin, agent, team_lead, lender, system: the users page says 3, the setup
 * meter says 3, and Settings said 5 — and only one of the three ever mentioned
 * that the plan allows 2.
 *
 * A brokerage OWNER consumed no seat on ANY surface, because "broker_owner" was
 * in no seat list while being an admitted user_type.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { stripComments } from "./strip-comments"
import {
  SEAT_ROLES, PARTNER_ROLES, TIER_SEAT_LIMITS, TIER_ORDER, TIER_INVITABLE_ROLES,
  seatLimitForTier, roleConsumesSeat, effectiveSeatLimit,
  seatDecision, seatDecisionMessage, agentRoleAdvisory, ADDITIONAL_SEAT_MONTHLY_USD,
} from "../lib/kernel/tier-role-matrix"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")

console.log("══════════════════════════════════════════════════")
console.log(" Seat display — one tenant, one seat number")
console.log("══════════════════════════════════════════════════")

console.log("\n[the limits are the owner's plan]")
{
  check("Solo = 2 seats", TIER_SEAT_LIMITS.solo_agent === 2)
  check("Team = 5 seats", TIER_SEAT_LIMITS.team === 5)
  check("Brokerage = unlimited", TIER_SEAT_LIMITS.brokerage === null)
  check("Multi-Location = unlimited", TIER_SEAT_LIMITS.multi_location === null)
  check("every canonical tier has a stated limit",
    TIER_ORDER.every((t) => t in TIER_SEAT_LIMITS))
  check("an unknown/legacy tier fails OPEN to unlimited, never to zero",
    seatLimitForTier("something_else") === null && seatLimitForTier(null) === null)
}

console.log("\n[every seat role is a real user_type]")
{
  // A seat list naming a value the column cannot store is dead weight that reads
  // like coverage. "broker_admin" was exactly that.
  const admitted = CHECK_VOCABULARIES.users?.user_type ?? []
  check(`users.user_type admits ${admitted.length} values`, admitted.length > 0)
  const phantom = SEAT_ROLES.filter((r) => !admitted.includes(r))
  check("no seat role is a value the column rejects", phantom.length === 0, phantom.join(", "))

  // The inverse: an admitted WORKING role missing from the seat list is a tenant
  // getting a free seat. broker_owner was missing.
  check("broker_owner consumes a seat (it is an admitted role and was in no list)",
    (SEAT_ROLES as readonly string[]).includes("broker_owner") && admitted.includes("broker_owner"))
  check("broker_admin is NOT treated as a role — the column never admitted it",
    !(SEAT_ROLES as readonly string[]).includes("broker_admin") && !admitted.includes("broker_admin"))

  // Partners and the AI actor must never consume a seat.
  for (const r of ["vendor", "lender", "contact", "system", "title_agent", "superadmin", "support"]) {
    check(`${r} never consumes a seat`, !(SEAT_ROLES as readonly string[]).includes(r))
  }
  check("PARTNER_ROLES and SEAT_ROLES do not overlap",
    !PARTNER_ROLES.some((p) => (SEAT_ROLES as readonly string[]).includes(p)))
  check("roleConsumesSeat agrees with the list",
    roleConsumesSeat("agent") && !roleConsumesSeat("vendor"))
}

console.log("\n[there is exactly ONE seat list, and ONE seat count]")
{
  // Two homes, each with one occupant:
  //   the seat ROLE list  → lib/kernel/tier-role-matrix.ts SEAT_ROLES
  //   the seat COUNT      → lib/kernel/seat-usage.ts resolveSeatUsage
  // The defect was three surfaces each answering the count their own way.
  const setup = src("lib/onboarding/critical-setup.ts")
  check("the critical-setup meter no longer keeps its own seat list",
    !/const SEAT_USER_TYPES\s*=/.test(setup))

  const settingsPage = src("app/dashboard/settings/page.tsx")
  check("Settings resolves the limit through effectiveSeatLimit (override-aware)",
    /effectiveSeatLimit\(/.test(settingsPage))
  check("…and no longer reports users.length as the active count",
    !/activeUsers: users\.length/.test(settingsPage))

  const usersPage = src("app/dashboard/admin/users/page.tsx")
  check("the users page resolves the limit the same way",
    /effectiveSeatLimit\(/.test(usersPage))

  // No surface may inline the role list OR hand-roll the count.
  // Display AND enforcement. The gates matter more: a meter that under-counts is
  // a wrong label, but a GATE that under-counts admits an invite that pushes the
  // tenant past the limit they pay for.
  const SURFACES = [
    "lib/onboarding/critical-setup.ts",
    "app/dashboard/settings/page.tsx",
    "app/dashboard/admin/users/page.tsx",
    "app/actions/admin/invite-user.ts",
    "app/actions/superadmin/tenant-users.ts",
    "app/actions/superadmin/tenant-entitlements.ts",
  ]
  const inlined = SURFACES.filter((f) => /=\s*\[\s*"admin",\s*"broker"/.test(src(f)))
  check("no surface restates the seat roles inline", inlined.length === 0, inlined.join(", "))
  const handRolled = SURFACES.filter((f) => /in\("user_type", SEAT_ROLES/.test(src(f)))
  check("no surface hand-rolls the seat count off user_type",
    handRolled.length === 0, handRolled.join(", "))
}

console.log("\n[the display tells the truth, including when it is exceeded]")
{
  const panel = src("app/dashboard/settings/components/os/user-access-panel.tsx")
  check("the panel shows SEATS, not raw headcount", /stats\.seatCount/.test(panel))
  check("…shows the plan's limit beside it", /stats\.seatLimit/.test(panel))
  check("…names the tier so the number means something", /TIER_NAMES/.test(panel))
  check("…says plainly when the tenant is OVER the limit",
    /overSeats/.test(panel) && /Over your/.test(panel))
  check("…states that partners never consume a seat",
    /never use(s)? one/.test(panel))
  check("…and still shows total people, labelled as people rather than seats",
    /People in workspace/.test(panel))

  // Unlimited must never render as "3/null".
  check("an unlimited tier renders a bare count, not a division by null",
    /stats\.seatLimit === null[\s\S]{0,120}?stats\.seatCount/.test(panel))
}

console.log("\n[a seat is a PERSON, across BOTH role sources]")
{
  // The OS assigns roles two ways and both are real: users.user_type (primary)
  // and user_role_assignments (RBAC, where a user may hold SEVERAL roles). Live
  // today: 2 users hold more than one role and 3 assignments disagree with that
  // user's user_type. Counting only user_type therefore under-counts by
  // construction — an admin also carrying agent, a contact granted isa. It
  // happened to agree on today's data, which is exactly why it would have gone
  // unnoticed until a tenant slipped past their limit.
  const usage = src("lib/kernel/seat-usage.ts")
  check("there is ONE seat resolver", usage.length > 0)
  check("…it reads user_type AND user_role_assignments",
    /from\("users"\)/.test(usage) && /from\("user_role_assignments"\)/.test(usage))
  check("…counts DISTINCT users, so a second role never charges twice",
    /holders\.length/.test(usage) && /seatHolderIds/.test(usage))
  check("…excludes suspended users", /status !== "suspended"/.test(usage))
  check("…and reports people separately from seats", /peopleCount/.test(usage))
  check("…never throws — a read failure returns zeroes, not a wrong number",
    /Never throws/.test(usage))

  // All three surfaces must call it — that is the whole point.
  for (const f of [
    "app/dashboard/admin/users/page.tsx",
    "app/dashboard/settings/page.tsx",
    "lib/onboarding/critical-setup.ts",
    "app/actions/admin/invite-user.ts",
    "app/actions/superadmin/tenant-users.ts",
    "app/actions/superadmin/tenant-entitlements.ts",
  ]) {
    check(`${f} resolves seats through it`, /resolveSeatUsage\(/.test(src(f)))
  }
  check("no surface counts seats off user_type alone any more",
    ![
      "app/dashboard/admin/users/page.tsx",
      "app/dashboard/settings/page.tsx",
      "lib/onboarding/critical-setup.ts",
    ].some((f) => /in\("user_type", SEAT_ROLES/.test(src(f))))
}

console.log("\n[title_agent is a vendor; support is a platform user type]")
{
  const admitted = CHECK_VOCABULARIES.users?.user_type ?? []
  check("users.user_type no longer admits 'title_agent' (m307)",
    !admitted.includes("title_agent"))
  check("…because a title company is a VENDOR — the taxonomy already has 'title'",
    (CHECK_VOCABULARIES.vendors?.category ?? []).includes("title"))
  check("'support' IS admitted — it is a real platform/OS user type",
    admitted.includes("support"))
  check("…and it never consumes a tenant seat, like superadmin",
    !(SEAT_ROLES as readonly string[]).includes("support"))
  const mig = src("supabase/migrations/m307-title-agent-is-not-a-user-type.sql")
  check("the migration refuses to run if any row still carries it",
    /RAISE EXCEPTION/.test(mig) && /title_agent/.test(mig))
}

console.log("\n[the tier sells SEATS — with ONE role constraint on solo]")
{
  // OWNER RULING: "they can use those seats anyway they want" — the tier sells
  // SEATS, not a narrower menu. AND, held firm after I briefly reversed it and was
  // corrected: "no solo agent tier subscription does NOT have a broker owner or
  // broker." A solo subscription is not a brokerage, so the two roles that exist
  // to GOVERN a brokerage are off its menu. Its 2 seats are spent inside the rest.
  check("solo has NO broker", !TIER_INVITABLE_ROLES.solo_agent.includes("broker"))
  check("solo has NO broker_owner", !TIER_INVITABLE_ROLES.solo_agent.includes("broker_owner"))
  for (const role of SEAT_ROLES.filter((r) => r !== "broker" && r !== "broker_owner")) {
    check(`solo may invite ${role} — every other working role is on its menu`,
      TIER_INVITABLE_ROLES.solo_agent.includes(role))
  }
  check("solo's menu is brokerage's MINUS exactly the two governance roles",
    [...TIER_INVITABLE_ROLES.brokerage].filter((r) => r !== "broker" && r !== "broker_owner").sort().join(",") ===
    [...TIER_INVITABLE_ROLES.solo_agent].sort().join(","))
  check("team and above DO get them — that is where a brokerage begins",
    TIER_INVITABLE_ROLES.team.includes("broker") && TIER_INVITABLE_ROLES.brokerage.includes("broker_owner"))
  check("…and the limits still differ, because SEATS are what a tier sells",
    TIER_SEAT_LIMITS.solo_agent === 2 && TIER_SEAT_LIMITS.brokerage === null)
}

console.log("\n[over the limit is a CHOICE — upgrade first, paid seat second]")
{
  // OWNER RULING: "if they try to go over alloted seats, we can charge them
  // monthly for each additional seats but I would rather get them to upgrade to
  // the team level." Refusing the invite is the one outcome that serves nobody —
  // the tenant is trying to grow.
  const inside = seatDecision("solo_agent", 1)
  check("inside the limit there is nothing to decide", inside.withinLimit && inside.outcome === "within_limit")
  check("…and no message, so a healthy tenant is not nagged", seatDecisionMessage(inside) === null)

  const full = seatDecision("solo_agent", 2)
  check("a full Solo plan OFFERS the upgrade rather than refusing",
    !full.withinLimit && full.outcome === "upgrade_offered" && full.upgradeTo === "team")
  check("…naming the seats the upgrade brings", full.upgradeSeats === 5)
  check("…and the per-seat price as the alternative, not the only option",
    (seatDecisionMessage(full) ?? "").includes(`$${ADDITIONAL_SEAT_MONTHLY_USD}/month`) &&
    (seatDecisionMessage(full) ?? "").includes("Upgrading to Team"))
  check("…never telling a growing tenant to remove someone",
    !/remove|deactivate|suspend/i.test(seatDecisionMessage(full) ?? ""))

  const team = seatDecision("team", 5)
  check("a full Team plan points at Brokerage and its unlimited seats",
    team.upgradeTo === "brokerage" && team.upgradeSeats === null)

  check("an unlimited tier is never 'over'", seatDecision("brokerage", 5000).withinLimit)

  // A staff-set override is a DELIBERATE cap — answering it with "upgrade" would
  // send a tenant to buy a tier they may already be on.
  const capped = seatDecision("solo_agent", 3, 3)
  check("a staff override offers the paid seat only, never a tier upgrade",
    capped.outcome === "paid_seat_only" && capped.upgradeTo === null && capped.overridden)

  check("the over-by count is exact, so the billing quote is exact",
    seatDecision("solo_agent", 4).seatsOver === 3)
  check("asking about the CURRENT state (0 requested) does not invent an overage",
    seatDecision("solo_agent", 2, null, 0).withinLimit)
}

console.log("\n[a workspace with no AGENT is inert, and says so]")
{
  // OWNER RULING: "if they don't use atleast 1 agent role, then they won't get
  // much out of the system." Advisory, never a gate — but a real one: contacts,
  // deals, listings, commissions and campaigns all attach to an agents record.
  const none = agentRoleAdvisory(["admin", "tc", "compliance_officer"])
  check("seats held with no Agent among them raises the advisory", !none.hasAgent && !!none.advisory)
  check("…and it explains WHY, not just that", /Contacts, deals, listings/.test(none.advisory ?? ""))
  check("…and it is advice, not a refusal", !/cannot|not allowed|blocked/i.test(none.advisory ?? ""))
  const has = agentRoleAdvisory(["admin", "agent"])
  check("one Agent silences it", has.hasAgent && has.advisory === null)
  check("…including an admin who ALSO carries agent by assignment",
    agentRoleAdvisory(["admin", "agent"]).hasAgent)

  // The advisory needs roles, so the resolver must report them.
  const usage = src("lib/kernel/seat-usage.ts")
  check("the seat resolver reports the roles in use, from BOTH sources",
    /rolesInUse/.test(usage) && /assignments\b/.test(usage))
  check("…restricted to seat HOLDERS — a suspended user's role is not in use",
    /holderIds\.has\(a\.user_id\)/.test(usage))
  const panel = src("app/dashboard/settings/components/os/user-access-panel.tsx")
  check("the panel shows the advisory", /agentRoleAdvisory/.test(panel))
  // Comment-stripped: the fix documents the phrase it replaced, so a raw search
  // trips on the very explanation that proves the copy changed.
  const panelCode = stripComments(panel)
  check("…and the over-limit copy offers the plan, not a scolding",
    /See plans/.test(panelCode) && !/remove or suspend a user/.test(panelCode))
}

console.log("\n[a tenant user without a brokerage_id is locked out by RLS]")
{
  // OWNER RULING: "a solo agent tier subscription has 2 seats but should be
  // assigned a brokerageid so access isn't restricted."
  //
  // This is not cosmetic. has_brokerage_access() and current_user_brokerage_id()
  // — the predicates in nearly every tenant RLS policy — read users.brokerage_id.
  // A tenant user with NULL there is invisible to their own data: not an error, a
  // silently empty app. Live audit found 2 ACTIVE AGENTS and 4 contacts in exactly
  // that state, none resolvable from an agents or contacts row.
  //
  // Platform staff (superadmin/support, or any platform_role) legitimately have no
  // brokerage — the guard must exempt them and only them.
  const invite = src("app/actions/admin/invite-user.ts")
  check("the tenant invite path resolves a brokerage before provisioning",
    /resolvedBrokerageId/.test(invite))
  check("…and refuses rather than creating a tenant user with no tenant",
    /brokerage/i.test(invite) && /return \{\s*success: false/.test(invite))
  const usersKernel = src("lib/kernel/users.ts")
  check("inviteTenantMember takes the brokerage as a required input",
    /brokerageId/.test(usersKernel))
}

console.log("\n[the override still wins, on every surface]")
{
  // A staff-set per-tenant seat override must beat the tier default everywhere,
  // or the meter and the invite gate disagree about who can be invited.
  const solo = effectiveSeatLimit("solo_agent", null)
  check("no override → the tier default", solo.limit === 2 && solo.overridden === false)
  const bumped = effectiveSeatLimit("solo_agent", 4)
  check("an override raises the limit and is flagged as custom",
    bumped.limit === 4 && bumped.overridden === true)
  const unlimited = effectiveSeatLimit("brokerage", null)
  check("brokerage stays unlimited", unlimited.limit === null)
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ SEAT_DISPLAY_FAIL"); process.exit(1) }
console.log(" ✅ SEAT_DISPLAY_PASS — one tenant, one seat number, and the limit is visible")
