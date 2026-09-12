#!/usr/bin/env tsx
/**
 * scripts/command-palette-role-simulator.ts   (npm run test:command-palette-roles)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COMMAND PALETTE SHOWED EVERY ENTRY TO EVERY USER.
 *
 * app/components/command-palette.tsx offered its whole roster — broker
 * dashboard, TC dashboard, lender pipeline, admin surfaces, financials —
 * to any authenticated user regardless of role. Owner ruled: build the filter.
 *
 * THE RULE THIS PINS (one vocabulary, §6): the palette holds NO role roster of
 * its own. Admission comes ENTIRELY from app/config/navigation-config.ts via
 * getNavigationForRole — the same call that builds the sidebar — through
 * visiblePaletteItems in app/components/command-palette-items.ts:
 *   · the merged commandPaletteItems lane (the per-role quick actions the nav
 *     config always carried and merged — role-union-nav U4 — which finally has
 *     its reader), and
 *   · the rich roster, filtered to destinations the user's merged navigation
 *     REACHES (exact path or nav-linked ancestor; "/dashboard" and "/" admit
 *     nothing by prefix).
 * FAIL CLOSED (§4): no roles → no entries.
 *
 * Every absence claim below carries a POSITIVE CONTROL (§2): the identical
 * probe run against the UNFILTERED roster, or against a role that legitimately
 * holds the surface, must go the other way — an unfiltered palette must go RED
 * here, and a probe that cannot fail is not a probe.
 */
import {
  PALETTE_ITEMS,
  visiblePaletteItems,
  pathnameOf,
  isPathAdmitted,
} from "../app/components/command-palette-items"
import { NAVIGATION_BY_ROLE, getNavigationForRole } from "../app/config/navigation-config"
import type { NavItem } from "../app/types/navigation"

let pass = 0
let fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}

const paths = (items: ReadonlyArray<{ href: string }>) => items.map((i) => pathnameOf(i.href))
const anyUnder = (items: ReadonlyArray<{ href: string }>, prefix: string) =>
  paths(items).some((p) => p === prefix || p.startsWith(prefix + "/"))

/** INDEPENDENT reach collector (not the module's own), children walked, all lanes. */
function independentReach(roles: string[]): Set<string> {
  const out = new Set<string>()
  const walk = (items?: readonly NavItem[]) => {
    for (const i of items ?? []) {
      if (i.href) out.add(i.href.split(/[?#]/)[0])
      if (i.children) walk(i.children as readonly NavItem[])
    }
  }
  const nav = getNavigationForRole(roles)
  walk(nav.sidebarItems as readonly NavItem[])
  walk(nav.topNavItems as readonly NavItem[])
  walk(nav.mobileBottomNav as readonly NavItem[])
  walk(nav.commandPaletteItems as readonly NavItem[])
  return out
}

console.log("══════════════════════════════════════════════════")
console.log(" Command palette role admission — the palette agrees with the nav")
console.log("══════════════════════════════════════════════════")

// ── 1 · FAIL CLOSED ──────────────────────────────────────────────────────────
console.log("\n[1 · fail closed — no roles, no palette]")

check("F1 roles undefined → empty palette", visiblePaletteItems(undefined).length === 0)
check("F2 roles null → empty palette", visiblePaletteItems(null).length === 0)
check("F3 roles [] → empty palette", visiblePaletteItems([]).length === 0)
// POSITIVE CONTROL — a filter that returned [] for everyone would pass F1–F3.
check("F4 POSITIVE CONTROL: an agent gets a non-empty palette, so F1–F3 measure the input and not a stub",
  visiblePaletteItems(["agent"]).length > 0)
check("F5 an unrecognised role string lands on the client portal's entries only (no /dashboard, /crm, or staff surface)",
  (() => {
    const v = visiblePaletteItems(["not_a_real_role"])
    return v.length > 0 && v.every((i) => pathnameOf(i.href).startsWith("/portal"))
  })())

// ── 2 · NAV AGREEMENT ────────────────────────────────────────────────────────
console.log("\n[2 · nav agreement — every visible entry is nav-admitted, per role]")

const ALL_ROLES = Object.keys(NAVIGATION_BY_ROLE)
let agree = true
for (const role of ALL_ROLES) {
  const reach = independentReach([role])
  const ownQuick = new Set(
    ((getNavigationForRole([role]).commandPaletteItems ?? []) as readonly NavItem[])
      .map((i) => i.href).filter(Boolean) as string[],
  )
  for (const item of visiblePaletteItems([role])) {
    const ok = ownQuick.has(item.href) || isPathAdmitted(item.href, reach)
    if (!ok) { agree = false; console.log(`     leak: role=${role} item=${item.label} → ${item.href}`) }
  }
}
check("N1 for EVERY role, every visible entry's destination is reachable from that role's own navigation", agree)

check("N2 the nav's commandPaletteItems lane is READ (isa's quick actions surface — the lane had no reader before)",
  (() => {
    const v = visiblePaletteItems(["isa"])
    const hrefs = new Set(v.map((i) => i.href))
    return hrefs.has("/dashboard/isa/calling") && hrefs.has("/dashboard/voice/isa")
  })())

// NOT a strict href-superset claim: mergeNavItems dedupes by `id || href`, so
// when two held roles both define an item ID the higher-precedence role's href
// wins and the other's is displaced (tc's 'dashboard' /dashboard/coordinator
// loses to compliance_officer's 'dashboard' /dashboard/compliance). That is the
// NAV's own documented ruling (role-union-nav asserts coverage by id, U1); the
// palette must follow it, not fight it — so any single-role entry missing from
// the union must be missing from the MERGED NAV too, never dropped by the
// palette on its own.
check("N3 multi-role union: every entry a single role sees is in the union, unless the merged NAV itself displaced that destination (id-dedupe)",
  (() => {
    const both = new Set(visiblePaletteItems(["tc", "compliance_officer"]).map((i) => i.href))
    const mergedReach = independentReach(["tc", "compliance_officer"])
    const lostToNav = (h: string) => !isPathAdmitted(h, mergedReach)
    const tcOnly = visiblePaletteItems(["tc"]).map((i) => i.href)
    const coOnly = visiblePaletteItems(["compliance_officer"]).map((i) => i.href)
    return [...tcOnly, ...coOnly].every((h) => both.has(h) || lostToNav(h))
  })())
check("N3a POSITIVE CONTROL: the union is strictly wider than either role alone, so N3's escape clause is not carrying the whole claim",
  (() => {
    const both = visiblePaletteItems(["tc", "compliance_officer"]).length
    return both > visiblePaletteItems(["tc"]).length
      && both > visiblePaletteItems(["compliance_officer"]).length
  })())

check("N4 …and the answer is order-independent (the grant rows arrive unordered)",
  JSON.stringify(visiblePaletteItems(["tc", "compliance_officer"]))
    === JSON.stringify(visiblePaletteItems(["compliance_officer", "tc"])))

// ── 3 · ROLE BOUNDARIES ──────────────────────────────────────────────────────
console.log("\n[3 · role boundaries — admin, platform, and financial surfaces stay put]")

const NON_ADMIN_STAFF = ["agent", "isa", "tc", "compliance_officer", "team_lead", "broker"]
check("A1 no non-admin tenant role sees a /dashboard/admin surface",
  NON_ADMIN_STAFF.every((r) => !anyUnder(visiblePaletteItems([r]), "/dashboard/admin")))
check("A1a POSITIVE CONTROL: admin DOES see /dashboard/admin surfaces, so A1 is not vacuous",
  anyUnder(visiblePaletteItems(["admin"]), "/dashboard/admin"))
check("A1b POSITIVE CONTROL: the UNFILTERED roster fails A1's probe — an everything-palette goes RED here",
  anyUnder(PALETTE_ITEMS, "/dashboard/admin"))

const TENANT_ROLES = [...NON_ADMIN_STAFF, "admin", "vendor", "lender", "contact", "title_agent"]
check("P1 no tenant role sees a platform (/dashboard/superadmin) surface",
  TENANT_ROLES.every((r) => !anyUnder(visiblePaletteItems([r]), "/dashboard/superadmin")))
check("P1a POSITIVE CONTROL: platform staff (superadmin) DO see platform entries",
  anyUnder(visiblePaletteItems(["superadmin"]), "/dashboard/superadmin"))

// §5 — vendors / contacts / lenders see no financials; commission is off
// external display. /dashboard/financials is the tenant money tree.
const EXTERNAL = ["vendor", "lender", "contact", "title_agent"]
check("M1 no external persona sees a /dashboard/financials surface",
  EXTERNAL.every((r) => !anyUnder(visiblePaletteItems([r]), "/dashboard/financials")))
check("M1a POSITIVE CONTROL: an agent DOES see their own /dashboard/financials/agent",
  anyUnder(visiblePaletteItems(["agent"]), "/dashboard/financials/agent"))
check("M1b POSITIVE CONTROL: the UNFILTERED roster fails M1's probe — an everything-palette goes RED here",
  anyUnder(PALETTE_ITEMS, "/dashboard/financials"))
check("M2 externals are not merely empty (each still gets its own portal's quick actions), so M1 measures the filter",
  EXTERNAL.every((r) => visiblePaletteItems([r]).length > 0))

check("B1 role-owned boards stay role-owned: lender pipeline → lender only; TC dashboard → tc only; vendor marketplace → broker only",
  (() => {
    const sees = (r: string, path: string) =>
      visiblePaletteItems([r]).some((i) => pathnameOf(i.href) === path)
    return ALL_ROLES.every((r) => sees(r, "/lender/pipeline") === (r === "lender"))
      && ALL_ROLES.every((r) => sees(r, "/dashboard/coordinator") === (r === "tc"))
      && ALL_ROLES.every((r) => sees(r, "/dashboard/vendors") === (r === "broker"))
  })())
check("B1a POSITIVE CONTROL: the UNFILTERED roster carries all three boards, so B1's probes can each go RED",
  anyUnder(PALETTE_ITEMS, "/lender/pipeline")
    && anyUnder(PALETTE_ITEMS, "/dashboard/coordinator")
    && anyUnder(PALETTE_ITEMS, "/dashboard/vendors"))

// ── 4 · ADMISSION MECHANICS ──────────────────────────────────────────────────
console.log("\n[4 · admission mechanics — prefix rules cannot re-open the floodgate]")

check("G1 '/dashboard' in a nav admits NOTHING by prefix (agent's mobile 'More' must not open the whole tree)",
  !isPathAdmitted("/dashboard/superadmin/platform", new Set(["/dashboard"]))
    && !isPathAdmitted("/dashboard/admin", new Set(["/dashboard"])))
check("G1a POSITIVE CONTROL: a specific nav path DOES admit its own sub-path ( /crm admits /crm/contacts/new )",
  isPathAdmitted("/crm/contacts/new", new Set(["/crm"])))
check("G2 an exact nav path admits itself; an unrelated path is refused",
  isPathAdmitted("/dashboard/listings?status=active", new Set(["/dashboard/listings"]))
    && !isPathAdmitted("/dashboard/listings", new Set(["/dashboard/transactions"])))

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ COMMAND_PALETTE_ROLES_FAIL"); process.exit(1) }
console.log(" ✅ COMMAND_PALETTE_ROLES_PASS — the palette shows each role exactly what its navigation admits, and nothing without a role")
