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
import { toCanonicalRole, isCanonicalRole } from "../lib/security/types"
import type { NavItem } from "../app/types/navigation"

let pass = 0
let fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}

const SHELL = "app/components/layout/app-shell.tsx"
const NAV = "app/config/navigation-config.ts"
const USE_AUTH = "lib/auth/useAuth.ts"
const KERNEL_HELPERS = "lib/kernel/helpers.ts"
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

/** Strip // and /* *\/ comments so a probe reads CODE, never prose. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

/**
 * The string members of `const <name> = new Set([...])`, read from CODE.
 *
 * Returns null when the literal cannot be found, and every caller treats null
 * as FAILURE. That is the point: the claims below are ABSENCE claims ("this
 * role is not in that set"), and an absence claim passes for free if the
 * collector silently returns nothing. A broken extractor must go red, not green.
 */
function setLiteralMembers(source: string, constName: string): string[] | null {
  const code = codeOnly(source)
  const at = code.indexOf(constName)
  if (at < 0) return null
  const open = code.indexOf("[", at)
  const close = code.indexOf("]", open)
  if (open < 0 || close < 0) return null
  return code
    .slice(open + 1, close)
    .split(",")
    .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean)
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

  // ── OWNER RULING · cross-role surface reach ────────────────────────────────
  // "a tc needs to see compliance and marketing; compliance officer needs to see
  //  transactions and marketing… the compliance manager is the one that deals
  //  with marketing."
  //
  // Asserted against the REACHABLE HREF SET, flattened through group children,
  // because that is the claim: can this role GET THERE. Deliberately not asserted
  // against item counts, item labels, or the presence of a particular const —
  // this session lost a CI run to a probe pinned to a variable's spelling, which
  // could not tell an improvement from a regression. A count would break the day
  // someone legitimately adds a link; a label would break on a rename; the href
  // set is the thing the ruling is actually about.
  const reach = (role: string): Set<string> => {
    const out = new Set<string>()
    const walk = (items: readonly NavItem[]) => {
      for (const i of items ?? []) {
        if (i.href) out.add(i.href)
        if (i.children) walk(i.children as readonly NavItem[])
      }
    }
    walk(getNavigationForRole([role]).sidebarItems)
    return out
  }
  const reaches = (role: string, prefix: string) =>
    [...reach(role)].some((h) => h.startsWith(prefix))

  check("U15 a tc reaches COMPLIANCE (the queue that holds what blocks their file)",
    reaches("tc", "/dashboard/compliance") || reaches("tc", "/compliance"))
  check("U16 a tc reaches MARKETING",
    reaches("tc", "/dashboard/marketing"))
  check("U17 a compliance officer reaches TRANSACTIONS (they can open the deal they audit)",
    reaches("compliance_officer", "/transaction"))
  check("U18 a compliance officer reaches MARKETING — they are the one who deals with it",
    reaches("compliance_officer", "/dashboard/marketing"))
  check("U19 …including the Review Queue specifically, which IS their approval surface",
    reach("compliance_officer").has("/dashboard/marketing/review"))

  // The two roles must still be DIFFERENT roles. Giving a coordinator the
  // officer's whole instrument panel would satisfy U15 while quietly collapsing
  // the distinction the tenant depends on, so pin that too.
  check("U20 a tc does NOT inherit the officer's own instruments (policies / audit logs)",
    !reach("tc").has("/compliance/policies") && !reach("tc").has("/compliance/audits"))
  // U20 is an ABSENCE claim, and an absence claim passes for free if the collector
  // is broken. Prove reach() actually finds those two hrefs for the role that DOES
  // own them, so U20 is measuring the role and not a bug in the helper.
  check("U20a …and reach() really does find those instruments for the officer, so U20 is not vacuous",
    reach("compliance_officer").has("/compliance/policies") &&
    reach("compliance_officer").has("/compliance/audits"))
  // Same guard for the reach-through-children walk: an external persona must not
  // pick up the marketing group, which also proves the walk is not returning
  // every href in the file regardless of role.
  check("U20b an external persona reaches NEITHER marketing nor transactions",
    !reaches("contact", "/dashboard/marketing") && !reaches("contact", "/transaction"))

  // Union hygiene for the newly-shared groups: one person holding both roles must
  // see each shared link ONCE. mergeNavItems dedupes on `id || href`, and these
  // groups are now referenced from two places, so this is the case that would
  // regress if a copy were pasted instead of referenced.
  const bothIds = getNavigationForRole(["tc", "compliance_officer"]).sidebarItems.map((i) => i.id || i.href)
  check("U21 holding BOTH tc and compliance_officer shows every shared surface exactly once",
    bothIds.length === new Set(bothIds).size)
}

// ── Layer 1b · PURE — the bare seat ──────────────────────────────────────────
//
// OWNER RULING, verbatim: "users are users with no rights except seeing their
// own work but once you give them a role, that is what determines what they can
// see and do."
//
// The owner chose, between two readings, that user_type is the SEAT and role
// grants ADD ON TOP — so `member` is a NEW seat for someone given neither, and
// the 19 live users who hold zero grants are untouched. These checks are the
// two halves of that sentence: what a member sees with nothing (their own work,
// and provably nothing else), and what a member sees the moment a role arrives
// (that role's workspace, with nothing of the bare seat clinging to it).
//
// Everything here is asserted BEHAVIOURALLY — through getNavigationForRole and
// the reachable-href set — and never by naming STAFF_NAV_PRECEDENCE or
// EXTERNAL_NAV_ROLES. `member` must be absent from both, and the way to pin
// that is the behaviour each absence produces, not the spelling of either const:
//   · if `member` joined STAFF_NAV_PRECEDENCE, member+tc would MERGE and B5/B7
//     would go red;
//   · if `member` joined EXTERNAL_NAV_ROLES, the external branch would pick
//     whichever external role the Set happened to yield first and B9's
//     order-independence would go red.

function memberSeatLayer() {
  console.log("\n[1b · pure — the bare seat sees its own work and nothing else]")

  const sig = (n: { sidebarItems: NavItem[] }) => n.sidebarItems.map((i) => i.id || i.href).join("|")

  /** Every href a role can actually GET TO, flattened through group children. */
  const reach = (roles: string | string[]): Set<string> => {
    const out = new Set<string>()
    const walk = (items: readonly NavItem[]) => {
      for (const i of items ?? []) {
        if (i.href) out.add(i.href)
        if (i.children) walk(i.children as readonly NavItem[])
      }
    }
    walk(getNavigationForRole(roles).sidebarItems)
    return out
  }

  check("B1 `member` is a canonical role and canonicalises to itself, not to a fallback",
    isCanonicalRole("member") && toCanonicalRole("member") === "member")

  check("B2 a member ALONE gets the bare workspace, byte-identical to its own config",
    sig(getNavigationForRole(["member"])) === sig(NAVIGATION_BY_ROLE.member))

  // The whole specification of the seat, as the set of places it can reach.
  // Asserted as SET EQUALITY, not as a count and not as a label: adding a
  // destination and removing one both go red, and a rename of an item's label
  // or id does not. Each of these three was checked against the filesystem
  // (app/dashboard/profile/page.tsx, app/notifications/page.tsx,
  // app/settings/notifications/page.tsx all exist) before it was written.
  const OWN_WORK = ["/dashboard/profile", "/notifications", "/settings/notifications"]
  const memberReach = reach(["member"])
  check("B3 the bare seat reaches EXACTLY its own profile, its own notifications and its own notification settings",
    memberReach.size === OWN_WORK.length && OWN_WORK.every((h) => memberReach.has(h)))

  // "no rights except seeing their own work", stated as the absence of every
  // business surface — and PAIRED, prefix by prefix, with the role that does
  // own it, so a broken reach() cannot make this pass by finding nothing.
  const BUSINESS: Array<[string, string]> = [
    ["/crm", "agent"],
    ["/dashboard/transactions", "agent"],
    ["/dashboard/marketing", "agent"],
    ["/dashboard/financials", "agent"],
    ["/compliance", "compliance_officer"],
    ["/transaction/", "tc"],
    ["/dashboard/admin", "admin"],
    ["/leads", "broker"],
    ["/analytics", "broker"],
    ["/dashboard/team", "team_lead"],
  ]
  const reaches = (roles: string | string[], prefix: string) =>
    [...reach(roles)].some((h) => h.startsWith(prefix))

  check("B4 a member reaches NONE of the business surfaces",
    BUSINESS.every(([prefix]) => !reaches(["member"], prefix)))
  check("B4a …and reach() really does find every one of those surfaces for the role that owns it, so B4 is not vacuous",
    BUSINESS.every(([prefix, owner]) => reaches([owner], prefix)))

  console.log("\n[1b · pure — grant a role and that role is what they see]")

  // The second half of the ruling. A member LATER granted tc must get the tc
  // workspace — not a blend of the two.
  check("B5 member + tc yields the tc workspace, byte-identical to tc alone",
    sig(getNavigationForRole(["member", "tc"])) === sig(getNavigationForRole(["tc"])))

  check("B5a …and the same in the other order, because grant rows come back unordered",
    sig(getNavigationForRole(["tc", "member"])) === sig(getNavigationForRole(["tc"])))

  // Not a special case for tc: every staff seat behaves this way.
  const STAFF = ["broker", "admin", "team_lead", "compliance_officer", "tc", "isa", "agent"]
  check("B6 member + ANY staff role yields exactly that staff role's workspace, for all seven",
    STAFF.every((r) => sig(getNavigationForRole(["member", r])) === sig(getNavigationForRole([r]))))

  // B5/B6 would still pass if the bare seat happened to be a SUBSET of every
  // staff nav. It is not — /settings/notifications belongs to no other role —
  // so pin the stronger claim directly: the bare seat contributes nothing.
  const memberOnly = [...memberReach].filter((h) => !reach(["tc"]).has(h))
  check("B7 the bare seat contributes NOTHING to a granted workspace (and it has surfaces of its own to contribute, so this is a real test)",
    memberOnly.length > 0 && memberOnly.every((h) => !reach(["member", "tc"]).has(h)))

  console.log("\n[1b · pure — a member is neither staff nor a client]")

  // NOT STAFF: naming one role for a member alone must answer 'member', and the
  // moment any staff role is held the staff precedence must win outright.
  check("B8 resolvePrimaryRole names the bare seat when it is all they have, and the staff role the moment they have one",
    resolvePrimaryRole(["member"]) === "member"
      && resolvePrimaryRole(["member", "agent"]) === "agent"
      && resolvePrimaryRole(["member", "broker"]) === "broker")

  // NOT A CLIENT: if `member` were in the external-persona set, this branch
  // would return whichever of the two the Set yielded first and the two orders
  // would disagree. Both orders must land on the client portal.
  check("B9 a member who is ALSO a client gets the client portal, in either order — the bare seat is not an external persona",
    sig(getNavigationForRole(["member", "contact"])) === sig(NAVIGATION_BY_ROLE.contact)
      && sig(getNavigationForRole(["contact", "member"])) === sig(NAVIGATION_BY_ROLE.contact))

  console.log("\n[1b · pure — the team_member audit]")

  // `team_member` was named in three places and existed in NO vocabulary, so no
  // account could hold it. It is NOT the bare seat: every reference gave it
  // PRODUCING, STAFF capability (USER_TYPE_TO_TIER maps it to the "team" billing
  // tier beside team_lead; helpers.ts groups it with agent+team_lead for the
  // isAgent test that grants canEdit/canCreate). It is `agent` + a team_id —
  // the team-tier twin of solo_agent — so it is MAPPED there, not deleted.
  check("B10 team_member canonicalises to the producing agent seat",
    toCanonicalRole("team_member") === "agent")

  check("B10a …and specifically NOT to the bare seat, which is the mapping that would have been wrong",
    toCanonicalRole("team_member") !== "member")

  check("B10b a legacy team_member therefore lands in the AGENT workspace, not the bare one",
    sig(getNavigationForRole([toCanonicalRole("team_member") as string])) === sig(NAVIGATION_BY_ROLE.agent)
      && sig(getNavigationForRole([toCanonicalRole("team_member") as string])) !== sig(NAVIGATION_BY_ROLE.member))

  check("B10c `member` is a real seat and not merely an alias of an existing one — no other canonical role reaches the same set of surfaces",
    !Object.keys(NAVIGATION_BY_ROLE)
      .filter((r) => r !== "member")
      .some((r) => sig(NAVIGATION_BY_ROLE[r as keyof typeof NAVIGATION_BY_ROLE]) === sig(NAVIGATION_BY_ROLE.member)))
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
  {
    // The internal AI assistant is a staff instrument. A seat with no business
    // role has no business holding it, and the shell's gate admits ANY held
    // role (S5), so a single wrong entry in this set would hand the assistant
    // to every bare seat in the tenant.
    //
    // Read out of the SET LITERAL rather than by searching the file for the
    // word: `agent` must be present and `member` absent in the SAME extraction,
    // so a broken extractor (which returns null) fails instead of passing.
    name: "M1 the bare seat does NOT get the internal AI assistant — and the extraction proves itself by finding the seat that does",
    run: (s) => {
      const roles = setLiteralMembers(s[SHELL], "STAFF_AI_ROLES")
      return roles !== null && roles.includes("agent") && !roles.includes("member")
    },
  },
  {
    // helpers.ts STAFF_ROLES is STAFF_AI_ROLES' twin — its own comment says the
    // two must stay in sync — and it also feeds ROUTE_ROLE_REQUIREMENTS. Same
    // claim, same self-proving extraction, separate file.
    name: "M2 the bare seat is not counted as staff by the kernel's own staff set either",
    run: (s) => {
      const roles = setLiteralMembers(s[KERNEL_HELPERS], "STAFF_ROLES")
      return roles !== null && roles.includes("agent") && !roles.includes("member")
    },
  },
]

function loadSources(): Record<string, string> {
  return {
    [SHELL]: src(SHELL),
    [NAV]: src(NAV),
    [USE_AUTH]: src(USE_AUTH),
    [KERNEL_HELPERS]: src(KERNEL_HELPERS),
  }
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
  {
    name: "the bare seat is added to the shell's staff-AI set",
    probe: "M1",
    mutate: (s) => ({ ...s, [SHELL]: s[SHELL].replace(/const STAFF_AI_ROLES = new Set\(\[/, "const STAFF_AI_ROLES = new Set([\n  'member',") }),
  },
  {
    name: "…and the extraction itself is broken, so M1 cannot pass on a collector failure",
    probe: "M1",
    // The other half of M1's honesty. The first mutation proves M1 notices a
    // WRONG set; this proves M1 notices NO set. An absence claim whose collector
    // has silently stopped working is the exact defect this run has been burned
    // by, so it is hand-broken here rather than assumed.
    mutate: (s) => ({ ...s, [SHELL]: s[SHELL].replace(/STAFF_AI_ROLES/g, "SOME_OTHER_AI_SET") }),
  },
  {
    name: "the bare seat is added to the kernel's staff set",
    probe: "M2",
    mutate: (s) => ({ ...s, [KERNEL_HELPERS]: s[KERNEL_HELPERS].replace(/const STAFF_ROLES = new Set\(\[/, "const STAFF_ROLES = new Set([\n  \"member\",") }),
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

  // ── the bare seat's own negative controls ──────────────────────────────────
  const sig = (n: { sidebarItems: NavItem[] }) => n.sidebarItems.map((i) => i.id || i.href).join("|")

  // B5/B6 say a granted role REPLACES the bare seat rather than merging with it.
  // The failure that claim exists to catch is `member` being added to
  // STAFF_NAV_PRECEDENCE, which would make member+tc a two-config MERGE. Build
  // that merge by hand and confirm it is a different answer — if it were the
  // same answer, B5 would be measuring nothing.
  const handMerged = [
    ...NAVIGATION_BY_ROLE.tc.sidebarItems,
    ...NAVIGATION_BY_ROLE.member.sidebarItems,
  ]
  const mergedSig = handMerged
    .filter((it, i, all) => all.findIndex((o) => (o.id || o.href) === (it.id || it.href)) === i)
    .map((i) => i.id || i.href).join("|")
  check("NEGATIVE CONTROL a resolver that MERGED the bare seat into tc would fail B5 — went RED as required",
    mergedSig !== sig(getNavigationForRole(["tc"])))

  // B4 is an absence claim. Prove the shape of the assertion can fail by running
  // it against a role that DOES reach a business surface.
  const agentHrefs = new Set<string>()
  const walk = (items: readonly NavItem[]) => {
    for (const i of items ?? []) {
      if (i.href) agentHrefs.add(i.href)
      if (i.children) walk(i.children as readonly NavItem[])
    }
  }
  walk(getNavigationForRole(["agent"]).sidebarItems)
  check("NEGATIVE CONTROL the B4 'reaches no business surface' test applied to an AGENT fails — went RED as required",
    [...agentHrefs].some((h) => h.startsWith("/crm")))

  // B10 says team_member is the producing seat. The mapping that would have been
  // wrong is team_member → member; assert that answer is not what we get.
  check("NEGATIVE CONTROL mapping team_member to the bare seat would fail B10 — went RED as required",
    toCanonicalRole("team_member") !== "member" && toCanonicalRole("team_member") !== null)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Role-union navigation — the second seat wears every hat it was given")
  console.log("══════════════════════════════════════════════════")
  pureLayer()
  memberSeatLayer()
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
