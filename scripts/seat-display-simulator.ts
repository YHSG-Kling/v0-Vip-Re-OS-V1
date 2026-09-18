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
  seatLimitForTier, roleConsumesSeat, effectiveSeatLimit, seatableUserTypes,
  seatDecision, seatDecisionMessage, agentRoleAdvisory, ADDITIONAL_SEAT_MONTHLY_USD,
  TIER_LABELS,
} from "../lib/kernel/tier-role-matrix"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")

// COMMENT-BLIND vs COMMENT-AWARE (CLAUDE.md §2).
//
// `src` above returns RAW source, so every assertion built on it can be
// satisfied — or defeated — by prose. That is not hypothetical here: an
// explanatory comment naming the OLD code (`max_agents || 1` was the bug) made
// the "no longer uses `|| 1`" probe below report the defect as still present in
// a file that no longer contains it. A tombstone read as live code.
//
// `code` is the same read through scripts/strip-comments.ts — the ONE correct
// scanner — so an absence assertion is about the CODE. `src` is left in place
// because some checks above deliberately match JSX copy, and re-pointing all of
// them is a separate change; new absence probes should use `code`.
const code = (p: string) => stripComments(src(p))

console.log("══════════════════════════════════════════════════")
console.log(" Seat display — one tenant, one seat number")
console.log("══════════════════════════════════════════════════")

console.log("\n[the limits are the owner's plan]")
{
  check("Solo = 2 seats", TIER_SEAT_LIMITS.solo_agent === 2)
  check("Team = 5 seats", TIER_SEAT_LIMITS.team === 5)
  // MOVED null → 50 (lane A). OWNER: "a brokerage should be changed to 50 seats".
  // The live catalogue already said 50 in BOTH subscription_tiers.max_agents and
  // plan_limits.active_users (m529); this literal, which is the FALLBACK used when
  // the catalogue cannot be read, still said unlimited — a fail-OPEN answer on the
  // seat axis at exactly the moment the real number is unavailable.
  check("Brokerage = 50 seats", TIER_SEAT_LIMITS.brokerage === 50)
  check("Multi-Location = unlimited", TIER_SEAT_LIMITS.multi_location === null)
  check("…and the fallback ladder is strictly increasing, so an upgrade always buys seats",
    (TIER_SEAT_LIMITS.solo_agent ?? 0) < (TIER_SEAT_LIMITS.team ?? 0)
    && (TIER_SEAT_LIMITS.team ?? 0) < (TIER_SEAT_LIMITS.brokerage ?? 0)
    && TIER_SEAT_LIMITS.multi_location === null)
  check("every canonical tier has a stated limit",
    TIER_ORDER.every((t) => t in TIER_SEAT_LIMITS))
  // DIRECTION CHANGED (seat-cap lane): this used to assert an unknown/legacy
  // tier fell OPEN to unlimited. A seat cap is not a role menu — "we could not
  // read this tenant's plan" rendering as "they may hire without limit" is the
  // shape CLAUDE.md §4 forbids, and it is the opposite of what the tier reader
  // beside it does (lib/billing/plan-tier.ts toPlanTier falls to the TIGHTEST).
  // It now falls to the FLOOR tier's cap — never to zero, which would brick.
  check("an unknown/legacy tier fails CLOSED to the FLOOR tier's cap, never to zero",
    seatLimitForTier("something_else") === TIER_SEAT_LIMITS.solo_agent
    && seatLimitForTier(null) === TIER_SEAT_LIMITS.solo_agent
    && (seatLimitForTier(null) ?? 0) > 0)
}

console.log("\n[every seat role is a real user_type]")
{
  // A seat list naming a value the column cannot store is dead weight that reads
  // like coverage. "broker_admin" was exactly that.
  const admitted = CHECK_VOCABULARIES.users?.user_type ?? []
  check(`users.user_type admits ${admitted.length} values`, admitted.length > 0)

  // ── THE ONE PENDING VALUE, TRACKED RATHER THAN ASSERTED AWAY (lane A) ─────
  //
  // This used to be a flat `SEAT_ROLES ⊆ admitted`, plus a companion assertion
  // that broker_admin was in NEITHER. The owner has now ruled broker_admin a
  // user type ("a broker admin is a user type with differnt permission roles"),
  // and CLAUDE.md §4 has always listed it in the tenant roster — so it belongs in
  // SEAT_ROLES, and the DEFECT is that the column cannot store it.
  //
  // m530 (WRITTEN, NOT APPLIED) adds it. Until it is applied and the vocabulary
  // cache regenerated, exactly ONE value may be pending, it must be that value,
  // and nothing may write it — `seatableUserTypes` intersects the invite menu
  // with `admitted`, so the pending value is simply not offered.
  //
  // The check is written so it PASSES BOTH BEFORE AND AFTER m530 without an edit,
  // and goes RED if any OTHER phantom appears.
  const pending = SEAT_ROLES.filter((r) => !admitted.includes(r))
  check("at most one seat user type is pending a migration, and it is broker_admin",
    pending.length === 0 || (pending.length === 1 && pending[0] === "broker_admin"),
    `pending: ${pending.join(", ") || "none"}`)
  check("m530 — the migration that makes it storable — exists on disk",
    src("supabase/migrations/m530-broker-admin-is-a-user-type-the-column-cannot-hold.sql").length > 0)
  check("the invite menu HIDES a pending user type, so nothing can write it",
    pending.every((r) => !seatableUserTypes("brokerage", admitted).includes(r as never)))
  check("…while every STORABLE seat user type stays on the menu",
    SEAT_ROLES.filter((r) => admitted.includes(r))
      .every((r) => seatableUserTypes("brokerage", admitted).includes(r)))

  // POSITIVE CONTROL — the intersection must actually be able to remove something.
  check("POSITIVE CONTROL seatableUserTypes drops a role a vocabulary omits",
    !seatableUserTypes("brokerage", admitted.filter((v) => v !== "agent")).includes("agent"))
  // …and must NOT brick the surface when the vocabulary is unreadable.
  check("POSITIVE CONTROL an empty/unreadable vocabulary falls back to the full menu",
    seatableUserTypes("brokerage", []).includes("agent")
    && seatableUserTypes("brokerage", null).includes("agent")
    && seatableUserTypes("brokerage", ["nothing_real"]).includes("agent"))

  // The inverse: an admitted WORKING role missing from the seat list is a tenant
  // getting a free seat. broker_owner was missing.
  check("broker_owner consumes a seat (it is an admitted role and was in no list)",
    (SEAT_ROLES as readonly string[]).includes("broker_owner") && admitted.includes("broker_owner"))
  check("broker_admin IS a seat user type now (owner ruling + CLAUDE.md §4 roster)",
    (SEAT_ROLES as readonly string[]).includes("broker_admin"))

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
  // The claim is "the same way", never "via this identifier". The page used to
  // call `effectiveSeatLimit` directly; it now calls `seatCheck`, which resolves
  // the limit THROUGH `seatDecision` and additionally answers at-capacity and
  // staff-override in one place. Pinning the old identifier made this assertion
  // fail on the change that made the claim MORE true — a proof measuring the
  // spelling instead of the property. Accept either resolution, and separately
  // forbid the hand-rolled comparison that used to live beside it, since that
  // inline copy was the third spelling of at-capacity and the reason this page's
  // meter could report room after the invite gate had begun refusing.
  check("the users page resolves the limit the same way",
    /effectiveSeatLimit\(|seatCheck\(/.test(usersPage))
  // stripComments, NOT the raw source. The page's own comment EXPLAINS that the
  // inline `seatCount >= seatLimit` was removed and quotes it to say so — so a
  // raw scan matches the prose describing the defect and reports the defect as
  // still present. CLAUDE.md §2: the one correct scanner, every time. (This file
  // already does exactly that at :344 for the panel; the new check just has to
  // follow the same rule.)
  check("…and it does not re-derive at-capacity inline beside it",
    !/seatCount\s*>=\s*seatLimit/.test(stripComments(usersPage)))

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
  // The wording moved with the ruling: "Over your N seats … or add seats at
  // $X/month each" became "All N seats … are in use. Upgrading gives you room",
  // because past the seats the answer is the UPGRADE, not a per-seat purchase.
  // The probe follows the FACT (a distinct over-limit branch that names the
  // limit), not the old sentence.
  check("…says plainly when the tenant is OVER the limit",
    /overSeats/.test(panel) && /are in use/.test(panel) && /stats\.seatLimit/.test(panel))
  check("…and does not quote a per-seat price where an upgrade is the ruling",
    !/\$\$?\{?stats\.additionalSeatMonthlyUsd[^}]*\}?\/month/.test(panel))
  check("…states that partners never consume a seat",
    /never use(s)? one/.test(panel))
  check("…and still shows total people, labelled as people rather than seats",
    /People in workspace/.test(panel))

  // Unlimited must never render as "3/null".
  check("an unlimited tier renders a bare count, not a division by null",
    /stats\.seatLimit === null[\s\S]{0,120}?stats\.seatCount/.test(panel))
}

// ── THE THREE SEAT SURFACES THIS SUITE WAS NOT LOOKING AT ────────────────────
//
// This file scanned /dashboard/settings and /dashboard/admin/users and passed
// 130 checks. It never opened app/settings/billing/** — the TENANT'S OWN
// billing page, which is where a customer reads what their plan includes.
//
// All three surfaces there tested `max_agents === -1` for "unlimited", and the
// live catalogue spells unlimited as NULL (measured: subscription_tiers
// .max_agents is solo 2 / team 5 / brokerage 50 / multi_location NULL). So on
// the top-priced plan the upgrade modal printed "Up to null agents", the
// current-plan card printed "null agents", and app/settings/billing/page.tsx's
// `max_agents || 1` turned unlimited into a ONE-seat cap whose usage bar then
// drew pegged over the limit. The GATE was always right — only what the paying
// customer was shown was wrong, which is exactly the kind of defect a suite
// that checks the gate and not the page reports as 130 green.
console.log("\n[the TENANT'S BILLING PAGE agrees with the seat ladder]")
{
  const matrix = code("lib/kernel/tier-role-matrix.ts")
  check("ONE fold for the two spellings of unlimited lives in the matrix module",
    /export function normalizeCatalogSeatLimit/.test(matrix) && /export function formatSeatLimit/.test(matrix))
  check("…and the seat GATE reads that same fold rather than its own copy",
    /normalizeCatalogSeatLimit\(row\.max_agents\)/.test(code("lib/kernel/seat-usage.ts")))

  const billingSurfaces = [
    "app/settings/billing/upgrade-modal.tsx",
    "app/settings/billing/current-plan-card.tsx",
    "app/settings/billing/usage-section.tsx",
  ]
  for (const f of billingSurfaces) {
    const s = code(f)
    check(`${f} no longer tests only for -1`, !/max_agents === -1|maxAgents === -1/.test(s),
      "NULL is how the live multi_location tier spells unlimited")
    check(`${f} folds through the shared normalizer`,
      /normalizeCatalogSeatLimit|formatSeatLimit/.test(s))
  }
  check("the billing page passes NULL through instead of `|| 1`",
    !/max_agents \|\| 1/.test(code("app/settings/billing/page.tsx")))

  // POSITIVE CONTROLS — both absence probes must still recognise the defects
  // they were written for, and `code` must actually be removing comments.
  check("↺ control: the -1 probe still recognises the defect it was written for",
    /max_agents === -1/.test(`{tier.max_agents === -1 ? "Unlimited" : tier.max_agents}`))
  check("↺ control: the `|| 1` probe still recognises the defect it was written for",
    /max_agents \|\| 1/.test(`const maxAgents = currentTier?.max_agents || 1`))
  check("↺ control: `code` strips comments while `src` does not",
    /max_agents \|\| 1/.test(src("app/settings/billing/page.tsx")) &&
    !/max_agents \|\| 1/.test(code("app/settings/billing/page.tsx")),
    "the file's own tombstone naming the old expression must not read as live code")
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
    // The two ENFORCEMENT surfaces reach the resolver through seatGate now (the
    // one gate every add path shares — lib/kernel/seat-usage.ts), which is
    // still exactly one seat count; the DISPLAY surfaces call it directly.
    check(`${f} resolves seats through it`, /resolveSeatUsage\(|seatGate\(/.test(src(f)))
  }
  check("…and the gate they share is the one that calls the resolver",
    /export async function seatGate/.test(usage) && /await resolveSeatUsage\(/.test(usage))
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
  // ── SUPERSEDED, AND THE SUPERSESSION IS THE ASSERTION NOW (lane A) ────────
  //
  // This block used to pin the OPPOSITE ruling: "solo has NO broker", "team has
  // NO broker", "solo's menu is brokerage's MINUS exactly the two governance
  // roles". OWNER, 2026-08-22, seating a broker on TEAM tier explicitly:
  //
  //   "a team is a team tier subscription with 5 seats so can have a team lead
  //    user type given permission roles, then an agent as a user type with
  //    permission roles, THEN A BROKER AS A USER TYPE with different permisson
  //    roles which that takes up 3 of 5 seats"
  //
  // A tier restricts HOW MANY seats, never WHICH user types fill them. The
  // earlier "team tier … don't have a broker in the subscription" sentence
  // described the PACKAGE, not a prohibition — and m518's team_lead lead-desk
  // grant does not depend on it, because is_lead_visible_role() is per-user and
  // carries no tier clause. Both rulings hold; see the header of
  // lib/kernel/tier-role-matrix.ts.
  for (const tier of TIER_ORDER) {
    for (const role of SEAT_ROLES) {
      check(`${tier} may seat ${role} — a tier caps the COUNT, not the menu`,
        TIER_INVITABLE_ROLES[tier].includes(role))
    }
  }
  check("every tier's menu is the SAME menu — no tier subtracts a user type",
    TIER_ORDER.every((t) =>
      [...TIER_INVITABLE_ROLES[t]].sort().join(",") ===
      [...TIER_INVITABLE_ROLES.brokerage].sort().join(",")))
  check("the owner's team example is seatable: team_lead + agent + broker all on TEAM",
    ["team_lead", "agent", "broker"].every((r) => TIER_INVITABLE_ROLES.team.includes(r as never)))
  check("the owner's brokerage example is seatable: broker_admin + team_lead + agent",
    ["broker_admin", "team_lead", "agent"].every((r) => TIER_INVITABLE_ROLES.brokerage.includes(r as never)))
  check("…and the LIMITS still differ, because SEATS are the whole of what a tier sells",
    TIER_SEAT_LIMITS.solo_agent === 2 && TIER_SEAT_LIMITS.team === 5
    && TIER_SEAT_LIMITS.brokerage === 50 && TIER_SEAT_LIMITS.multi_location === null)

  // POSITIVE CONTROL — the parity finder above must be able to go RED. A tier
  // whose menu is genuinely short of one role must fail the same comparison.
  {
    const sabotaged = TIER_INVITABLE_ROLES.brokerage.filter((r) => r !== "broker")
    check("POSITIVE CONTROL a tier missing 'broker' fails the parity check",
      [...sabotaged].sort().join(",") !== [...TIER_INVITABLE_ROLES.brokerage].sort().join(","))
    check("POSITIVE CONTROL …and fails the team-example check the same way",
      !["team_lead", "agent", "broker"].every((r) => sabotaged.includes(r as never)))
  }
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
  check("a full Solo plan points at the upgrade rather than dead-ending",
    !full.withinLimit && full.outcome === "upgrade_offered" && full.upgradeTo === "team")
  check("…naming the seats the upgrade brings", full.upgradeSeats === 5)
  // RULING SUPERSEDED (seat-cap lane). This used to require the per-seat price
  // to appear BESIDE the upgrade. Owner, later and more specific: "agent tier
  // subscription only has 2 seats and if they need more than they need to
  // upgrade to a team subscription." Where a tier above exists the upgrade is
  // THE answer, so quoting $/month next to it offers what that ruling withdrew.
  // The price still lives on the top tier / staff-override case (below), where
  // there is nothing to climb to and the earlier ruling is still the only one
  // that speaks — asserted here so it cannot be deleted as dead.
  check("…and the upgrade is the WHOLE offer, with no per-seat price beside it",
    (seatDecisionMessage(full) ?? "").includes(`Upgrade to ${TIER_LABELS.team}`) &&
    !(seatDecisionMessage(full) ?? "").includes(`$${ADDITIONAL_SEAT_MONTHLY_USD}/month`))
  check("…never telling a growing tenant to remove someone",
    !/remove|deactivate|suspend/i.test(seatDecisionMessage(full) ?? ""))

  const team = seatDecision("team", 5)
  check("a full Team plan points at Brokerage and its 50 seats",
    team.upgradeTo === "brokerage" && team.upgradeSeats === 50)

  // Brokerage is a NUMBER now (50), so the unlimited case is multi_location —
  // the only tier the owner calls unlimited.
  check("an unlimited tier is never 'over'", seatDecision("multi_location", 5000).withinLimit)
  check("a FULL brokerage is over, and points at Multi-Location", (() => {
    const d = seatDecision("brokerage", 50)
    return !d.withinLimit && d.upgradeTo === "multi_location" && d.upgradeSeats === null
  })())
  check("…and 49 of 50 is still fine", seatDecision("brokerage", 49).withinLimit)

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
  const brokerage = effectiveSeatLimit("brokerage", null)
  check("brokerage resolves to its 50-seat plan", brokerage.limit === 50 && brokerage.overridden === false)
  const unlimited = effectiveSeatLimit("multi_location", null)
  check("multi_location stays unlimited", unlimited.limit === null)
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ SEAT_DISPLAY_FAIL"); process.exit(1) }
console.log(" ✅ SEAT_DISPLAY_PASS — one tenant, one seat number, and the limit is visible")
