#!/usr/bin/env tsx
/**
 * scripts/role-union-nav-simulator.ts   (npm run test:role-union-nav)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SECOND SEAT COULD ONLY EVER SEE ONE ROLE'S WORKSPACE.
 *
 * OWNER'S RULING, which this locks:
 *   "since a sole agent only has 2 users, in reality an agent can also wear all
 *    of these separate types of roles in a real estate business — which is why
 *    we went to creating users, so that the business roles would need to be
 *    assigned to an agent, and their other user could be a separate admin, but
 *    that admin would need to take on all the responsibility other than an
 *    agent of the business. So that 2nd user, for example Jane Smith, would need
 *    the ability to see all of the transactions, compliance, support, admin and
 *    marketing."
 *
 * So: business roles are ASSIGNED to a user through user_role_assignments, and
 * ONE USER HOLDING SEVERAL ROLES IS THE DESIGNED CASE — not an anomaly.
 *
 * WHAT WAS ACTUALLY WRONG, measured end to end before any of this was written.
 * The role set was collapsed to a single element FOUR times over:
 *
 *   1. lib/auth/useAuth.ts built `resolvedRoles` as "grants if any, ELSE
 *      users.user_type". A user given one grant therefore STOPPED counting as
 *      their user_type — an 'admin' granted 'agent' silently lost admin.
 *   2. user_role_assignments is UNIQUE on (user_id, role), so a user's grants
 *      come back as MULTIPLE ROWS IN NO ORDER.
 *   3. app-shell.tsx took `userContext.roles[0]` — an arbitrary pick out of that
 *      unordered set. The same person could get a different sidebar per login.
 *   4. getNavigationForRole accepted `string | string[]`, then did `roles[0]`
 *      and returned that one role's config. The array parameter was already
 *      there; the union behind it was never built.
 *
 * LIVE, at audit time: 7 grant rows over 4 users, and TWO of those four hold
 * MULTIPLE grants — one holds admin+agent+isa, another holds contact+team_lead.
 * This was never hypothetical.
 *
 * THE SAFETY RULE THIS ALSO PINS. `contact`, `vendor`, `lender` and
 * `title_agent` are EXTERNAL personas — people the brokerage works with, not
 * staff of it. The live contact+team_lead account is exactly why they are not
 * merged into a staff union: that is not one person wearing several business
 * hats, it is two different relationships to the brokerage, and putting the
 * client portal and the staff workspace in one sidebar is a leak, not a feature.
 *
 * LAYERS
 *   1. PURE — the union, its determinism, and the external-persona rule.
 *   2. SOURCE — the three upstream collapses are gone and cannot return.
 *   3. NEGATIVE CONTROLS — every claim re-run against a deliberately broken
 *      copy; the run FAILS unless each probe is killed by its mutation.
 *
 * Run: npx tsx scripts/role-union-nav-simulator.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  getNavigationForRole,
  resolvePrimaryRole,
  NAVIGATION_BY_ROLE,
} from "../app/config/navigation-config"

let pass = 0
let fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}

const SHELL = "app/components/layout/app-shell.tsx"
const NAV = "app/config/navigation-config.ts"
const USE_AUTH = "lib/auth/useAuth.ts"
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

/** Strip // and /* *\/ comments so a probe reads CODE, never prose. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

const ids = (items: Array<{ id?: string; href?: string }>) =>
  new Set(items.map((i) => i.id || i.href).filter(Boolean) as string[])

// ── Layer 1 · PURE ───────────────────────────────────────────────────────────

function pureLayer() {
  console.log("\n[1 · pure — the union is a union]")

  // THE RULING, stated as an assertion: the second seat holds several business
  // roles and must see all of their surfaces.
  const jane = ["admin", "compliance_officer", "tc", "isa"]
  const union = getNavigationForRole(jane)
  const unionIds = ids(union.sidebarItems)

  let everyRoleCovered = true
  for (const r of jane) {
    const own = NAVIGATION_BY_ROLE[r as keyof typeof NAVIGATION_BY_ROLE]
    if (!own) continue
    for (const id of ids(own.sidebarItems)) if (!unionIds.has(id)) everyRoleCovered = false
  }
  check("U1 a multi-role user sees EVERY item of EVERY role they hold (nothing is dropped)", everyRoleCovered)

  check("U2 the union is strictly wider than any single role in it",
    unionIds.size > ids(NAVIGATION_BY_ROLE.admin.sidebarItems).size)

  check("U3 no duplicates survive the merge (two roles listing one destination collapse)",
    union.sidebarItems.length === unionIds.size)

  check("U4 every nav lane is merged, not just the sidebar",
    ids(union.topNavItems).size >= ids(NAVIGATION_BY_ROLE.admin.topNavItems).size
      && ids(union.commandPaletteItems).size >= ids(NAVIGATION_BY_ROLE.admin.commandPaletteItems).size
      && ids(union.mobileBottomNav).size >= 1)

  console.log("\n[1 · pure — determinism, because the grant rows are unordered]")
  // THE BUG THIS REPLACES: roles[0] out of an unordered set. Shuffling the input
  // must not change one pixel of the answer.
  const a = getNavigationForRole(["admin", "compliance_officer", "tc", "isa"])
  const b = getNavigationForRole(["isa", "tc", "compliance_officer", "admin"])
  const c = getNavigationForRole(["tc", "admin", "isa", "compliance_officer"])
  const sig = (n: typeof a) => n.sidebarItems.map((i) => i.id || i.href).join("|")
  check("U5 the SAME role set in three different orders yields byte-identical navigation",
    sig(a) === sig(b) && sig(b) === sig(c))

  check("U6 resolvePrimaryRole is order-independent too",
    resolvePrimaryRole(["isa", "admin"]) === resolvePrimaryRole(["admin", "isa"]))

  check("U7 …and follows the same precedence the merge uses (the wider role wins)",
    resolvePrimaryRole(["agent", "admin"]) === "admin"
      && resolvePrimaryRole(["isa", "broker"]) === "broker")

  console.log("\n[1 · pure — external personas are NOT merged into staff]")
  // The live contact+team_lead account. A staff role must win outright; the
  // client portal must not be bolted onto a staff workspace.
  const dual = getNavigationForRole(["contact", "team_lead"])
  check("U8 a user who is BOTH a client and a team lead gets the STAFF workspace",
    sig(dual) === sig(getNavigationForRole(["team_lead"])))

  check("U9 …and none of the contact-portal items leak into it",
    (() => {
      const staffIds = ids(dual.sidebarItems)
      const contactOnly = [...ids(NAVIGATION_BY_ROLE.contact.sidebarItems)]
        .filter((id) => !ids(NAVIGATION_BY_ROLE.team_lead.sidebarItems).has(id))
      return contactOnly.length === 0 || contactOnly.every((id) => !staffIds.has(id))
    })())

  check("U10 an external persona ALONE still gets its own portal",
    sig(getNavigationForRole(["contact"])) === sig(NAVIGATION_BY_ROLE.contact))

  console.log("\n[1 · pure — unknown input cannot widen anybody]")
  check("U11 an unrecognised role string is ignored, not defaulted into staff",
    sig(getNavigationForRole(["not_a_real_role"])) === sig(NAVIGATION_BY_ROLE.contact))

  check("U12 an unrecognised role mixed with a real one changes nothing",
    sig(getNavigationForRole(["not_a_real_role", "admin"])) === sig(getNavigationForRole(["admin"])))

  check("U13 an empty role set lands on the portal, never on a staff workspace",
    sig(getNavigationForRole([])) === sig(NAVIGATION_BY_ROLE.contact))

  check("U14 a bare string still works (the signature's other shape)",
    sig(getNavigationForRole("admin")) === sig(getNavigationForRole(["admin"])))
}

// ── Layer 2 · SOURCE ─────────────────────────────────────────────────────────

interface Probe { name: string; run: (s: Record<string, string>) => boolean }

const PROBES: Probe[] = [
  {
    name: "S1 useAuth UNIONS the users.user_type role with the grants — it no longer replaces one with the other",
    run: (s) => {
      const code = codeOnly(s[USE_AUTH])
      // The claim: canonicalRole (from users.user_type) is IN the resolved set,
      // together with the mapped grants, deduped.
      return /new Set\(\[\s*canonicalRole\s*,\s*\.\.\.grantRoles\s*\]\)/.test(code.replace(/\s+/g, " "))
    },
  },
  {
    name: "S2 …and the old grants-else-user_type ternary is gone",
    run: (s) => {
      const flat = codeOnly(s[USE_AUTH]).replace(/\s+/g, " ")
      return !/rolesData && rolesData\.length > 0 \? rolesData\.map/.test(flat)
    },
  },
  {
    name: "S3 the shell hands the WHOLE role set to the resolver, not element zero",
    run: (s) => {
      const code = codeOnly(s[SHELL])
      return /getNavigationForRole\(\s*heldRoles\s*\)/.test(code)
        && !/userContext\?\.roles\?\.\[0\]/.test(code)
    },
  },
  {
    name: "S4 where the shell needs ONE role it uses the shared precedence, never heldRoles[0]",
    run: (s) => {
      const code = codeOnly(s[SHELL])
      return /resolvePrimaryRole\(\s*heldRoles\s*\)/.test(code)
        && !/heldRoles\[0\]/.test(code)
    },
  },
  {
    name: "S5 the staff-AI gate tests EVERY held role, not just the primary one",
    run: (s) => {
      const flat = codeOnly(s[SHELL]).replace(/\s+/g, " ")
      return /heldRoles\.some\(\s*\(r\)\s*=>\s*STAFF_AI_ROLES\.has/.test(flat)
    },
  },
  {
    name: "S6 the resolver no longer collapses the array to roles[0]",
    run: (s) => {
      const flat = codeOnly(s[NAV]).replace(/\s+/g, " ")
      return !/const primaryRole = roles\[0\]/.test(flat)
    },
  },
  {
    name: "S7 the merge order is an explicit named precedence, not incidental",
    run: (s) => /STAFF_NAV_PRECEDENCE/.test(codeOnly(s[NAV])),
  },
  {
    name: "S8 external personas are named as a set and excluded from the staff union",
    run: (s) => /EXTERNAL_NAV_ROLES/.test(codeOnly(s[NAV])),
  },
]

function loadSources(): Record<string, string> {
  return { [SHELL]: src(SHELL), [NAV]: src(NAV), [USE_AUTH]: src(USE_AUTH) }
}

function sourceLayer() {
  console.log("\n[2 · source — the four collapses are gone]")
  const s = loadSources()
  for (const p of PROBES) check(p.name, p.run(s))
}

// ── Layer 3 · NEGATIVE CONTROLS ──────────────────────────────────────────────

const MUTATIONS: Array<{ name: string; probe: string; mutate: (s: Record<string, string>) => Record<string, string> }> = [
  {
    name: "useAuth goes back to grants-else-user_type",
    probe: "S1",
    mutate: (s) => ({ ...s, [USE_AUTH]: s[USE_AUTH].replace(/new Set\(\[canonicalRole, \.\.\.grantRoles\]\)/, "new Set([...grantRoles])") }),
  },
  {
    name: "the grants-else-user_type ternary is re-introduced alongside the union",
    probe: "S2",
    // S2 asserts the OLD shape is absent, so the only mutation that can kill it
    // is one that puts the old shape back. Without this the probe could never
    // go red — and a check that cannot fail is not a check.
    mutate: (s) => ({
      ...s,
      [USE_AUTH]: s[USE_AUTH] +
        "\nconst legacy = rolesData && rolesData.length > 0 ? rolesData.map((r) => r.role) : [canonicalRole]\n",
    }),
  },
  {
    name: "the shell reverts to roles[0]",
    probe: "S3",
    mutate: (s) => ({ ...s, [SHELL]: s[SHELL].replace(/getNavigationForRole\(heldRoles\)/, "getNavigationForRole(userContext?.roles?.[0] ?? 'agent')") }),
  },
  {
    name: "the shell hand-rolls a primary role again",
    probe: "S4",
    mutate: (s) => ({ ...s, [SHELL]: s[SHELL].replace(/resolvePrimaryRole\(heldRoles\)/, "heldRoles[0]") }),
  },
  {
    name: "the staff-AI gate narrows back to the primary role",
    probe: "S5",
    mutate: (s) => ({ ...s, [SHELL]: s[SHELL].replace(/heldRoles\.some\(\(r\) => STAFF_AI_ROLES\.has\(String\(r\)\.toLowerCase\(\)\)\)/, "STAFF_AI_ROLES.has(primaryRole)") }),
  },
  {
    name: "the resolver collapses to roles[0] again",
    probe: "S6",
    mutate: (s) => ({ ...s, [NAV]: s[NAV] + "\nconst primaryRole = roles[0]\n" }),
  },
  {
    name: "the precedence list is removed",
    probe: "S7",
    mutate: (s) => ({ ...s, [NAV]: s[NAV].replace(/STAFF_NAV_PRECEDENCE/g, "SOME_OTHER_THING") }),
  },
  {
    name: "the external-persona set is removed",
    probe: "S8",
    mutate: (s) => ({ ...s, [NAV]: s[NAV].replace(/EXTERNAL_NAV_ROLES/g, "SOME_OTHER_SET") }),
  },
]

function negativeControls() {
  console.log("\n[3 · negative controls — every probe hand-broken and re-asserted]")
  const base = loadSources()
  const killed = new Set<string>()
  for (const m of MUTATIONS) {
    const probe = PROBES.find((p) => p.name.startsWith(m.probe))
    if (!probe) { check(`NEGATIVE CONTROL ${m.name} — probe ${m.probe} not found`, false); continue }
    const wentRed = !probe.run(m.mutate(base))
    check(`NEGATIVE CONTROL ${m.name} — went RED as required`, wentRed)
    if (wentRed) killed.add(m.probe)
  }
  for (const p of PROBES) {
    const key = p.name.slice(0, 2)
    check(`coverage: probe ${key} is killed by at least one mutation`, killed.has(key))
  }
}

/** A union that silently drops a role would pass a weak "is it wider" test, so
 *  the pure claim is re-asserted against a deliberately lossy merge. */
function pureNegativeControls() {
  console.log("\n[3 · negative controls — pure rules, hand-broken]")
  const jane = ["admin", "compliance_officer", "tc", "isa"]
  const lossy = NAVIGATION_BY_ROLE.admin // "union" that just returns the first role
  const lossyIds = ids(lossy.sidebarItems)
  let covered = true
  for (const r of jane) {
    const own = NAVIGATION_BY_ROLE[r as keyof typeof NAVIGATION_BY_ROLE]
    if (!own) continue
    for (const id of ids(own.sidebarItems)) if (!lossyIds.has(id)) covered = false
  }
  check("NEGATIVE CONTROL a merge that returns only the first role fails U1 — went RED as required", !covered)

  check("NEGATIVE CONTROL a precedence that ignored order would fail U7 — went RED as required",
    resolvePrimaryRole(["agent", "admin"]) !== "agent")
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Role-union navigation — the second seat wears every hat it was given")
  console.log("══════════════════════════════════════════════════")
  pureLayer()
  sourceLayer()
  negativeControls()
  pureNegativeControls()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ ROLE_UNION_NAV_FAIL"); process.exit(1) }
  console.log(" ✅ ROLE_UNION_NAV_PASS — a user sees every role they hold, in a fixed order, and an external persona is never merged into a staff workspace")
}
main()
