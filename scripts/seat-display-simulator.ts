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
import {
  SEAT_ROLES, PARTNER_ROLES, TIER_SEAT_LIMITS, TIER_ORDER,
  seatLimitForTier, roleConsumesSeat, effectiveSeatLimit,
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

console.log("\n[there is exactly ONE seat list]")
{
  // The defect: two more copies, both drifted.
  const setup = src("lib/onboarding/critical-setup.ts")
  check("the critical-setup meter no longer keeps its own seat list",
    !/const SEAT_USER_TYPES\s*=/.test(setup))
  check("…it uses the canonical SEAT_ROLES", /in\("user_type", SEAT_ROLES/.test(setup))
  check("…and excludes suspended users, like the users page does",
    /SEAT_ROLES[\s\S]{0,160}?\.neq\("status", "suspended"\)/.test(setup))

  const settingsPage = src("app/dashboard/settings/page.tsx")
  check("Settings derives seats from the canonical source",
    /from "@\/lib\/kernel\/tier-role-matrix"/.test(settingsPage) &&
    /SEAT_ROLES as readonly string\[\]/.test(settingsPage))
  check("…resolves the limit through effectiveSeatLimit (override-aware)",
    /effectiveSeatLimit\(/.test(settingsPage))
  check("…and no longer reports users.length as the active count",
    !/activeUsers: users\.length/.test(settingsPage))

  const usersPage = src("app/dashboard/admin/users/page.tsx")
  check("the users page still uses the same source (unchanged)",
    /SEAT_ROLES as readonly string\[\]/.test(usersPage) && /effectiveSeatLimit\(/.test(usersPage))

  // No fourth copy anywhere.
  const dupes: string[] = []
  for (const f of ["lib/onboarding/critical-setup.ts", "app/dashboard/settings/page.tsx",
                   "app/dashboard/admin/users/page.tsx", "app/actions/admin/invite-user.ts"]) {
    const s = src(f)
    if (/=\s*\[\s*"admin",\s*"broker"/.test(s)) dupes.push(f)
  }
  check("no surface restates the seat roles inline", dupes.length === 0, dupes.join(", "))
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
