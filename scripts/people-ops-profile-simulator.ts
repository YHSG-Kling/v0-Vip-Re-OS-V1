// scripts/people-ops-profile-simulator.ts   (npm run test:people-ops-profile)
// ─────────────────────────────────────────────────────────────────────────────
// PEOPLE-OPS CONSOLIDATION — proves the brokerage-admin user-edit surface now
// manages the WHOLE person in one place: contact phone (was missing), the agent's
// real-estate profile (license #/state/expiry, office assignment, commission
// split), and a read-only "what this role can do" view — instead of scattering
// them across separate license-tracking / locations pages. Writes go through
// admin-gated, brokerage-scoped server actions against the LIVE columns only.
//
// AND (wave 26) the second half of that last claim: the "what this role can do"
// view is only honest if there is ONE role→capability table for it to read. This
// file now counts them tree-wide — see the block below the user-edit checks.

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { blankStrings, stringLiterals } from "./strip-comments"

let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── phone (contact) is now editable on the user ──")
{
  const a = src("app/actions/admin/update-user.ts")
  check("updateUser accepts phone and patches users.phone",
    a.includes("phone?: string") && a.includes("patch.phone"))
  const form = src("app/dashboard/admin/users/[userId]/user-edit-form.tsx")
  check("the edit form renders a phone field bound to form.phone",
    form.includes('id="phone"') && form.includes('set("phone"'))
  check("the form passes phone into updateUser",
    form.includes("phone: form.phone"))
}

console.log("\n── the agent real-estate profile is managed inline (LIVE columns only) ──")
{
  const a = src("app/actions/admin/agent-profile.ts")
  check("is a server module with load + update actions",
    a.includes('"use server"') &&
    a.includes("export async function getAgentProfileForUserAction") &&
    a.includes("export async function updateAgentProfileAction"))
  // Pinned to WHERE the gate comes from, not to the identifier it is spelled
  // with. The previous form named a local const that the admin-vocabulary
  // consolidation deleted and m472 renamed again, so it reported a CORRECT
  // tightening as a regression. There is exactly one module allowed to answer
  // "is this caller an admin"; a gate imported from it is the shared answer.
  // agent_commission_profiles is a FINANCE table (m472), so this one must be on
  // the NARROW tier — the owner holds team_lead out of brokerage-wide money, and
  // this action writes through the SERVICE client where RLS cannot re-decide.
  check("admin-gated via requireAdmin, from the ONE roster module, on the FINANCE tier",
    a.includes("requireAdmin") && /from\s+["\x27]@\/lib\/auth\/resolve-user-role["\x27]/.test(a) && a.includes("isBrokerageFinanceAdmin"))
  check("target agent is pinned to the caller's own brokerage",
    a.includes('.eq("brokerage_id", auth.brokerageId)') && a.includes("belongs to a different brokerage"))
  check("writes ONLY live columns (license_number/state/expiry, commission_split, location_id)",
    a.includes("license_number") && a.includes("license_state") && a.includes("license_expiry") &&
    a.includes("commission_split") && a.includes("location_id"))
  check("does NOT write drift columns (mls_id / commission_tier not present live)",
    !a.includes("patch.mls_id") && !a.includes("patch.commission_tier") &&
    !/mls_id\s*=/.test(a) && !/commission_tier\s*=/.test(a))
  check("office assignment validates the office belongs to the brokerage",
    a.includes('.from("locations")') && a.includes("Office not found for this brokerage"))
  check("commission split is validated to 0–100",
    a.includes("between 0 and 100"))
  // SHAPE-TOLERANT, because the CLAIM is not a shape. This probe used to require
  // three exact literals: `.from("agent_commission_profiles").upsert(` on ONE
  // line, and the payload key written inline as `split_percent: patch.commission_split`.
  // Both broke on a refactor that KEPT the behaviour and strengthened it — the
  // chain gained a `.select("id")` row-count proof (a zero-row RLS refusal arrives
  // as error:null) and the payload moved into a variable so a negotiated team term
  // could be written in the same upsert without either field blanking the other.
  //
  // A guard that fails on a legitimate refactor while the behaviour is intact is
  // not protecting anything; it is taxing improvement. Asserted here as: the split
  // REACHES agent_commission_profiles.split_percent, upserted on the unique
  // agent_id. Removing the sync still turns this red — see the negative control.
  const aFlat = a.replace(/\s+/g, " ")
  const rule1Sync = (source: string) => {
    const flat = source.replace(/\s+/g, " ")
    return /from\("agent_commission_profiles"\)\s*\.upsert\(/.test(flat)
      && /onConflict: "agent_id"/.test(flat)
      // `split_percent: patch.commission_split` OR `profilePatch.split_percent = patch.commission_split`
      && /split_percent\s*[:=]\s*patch\.commission_split/.test(flat)
  }
  check("RULE-1 SYNC: the broker's split is mirrored onto the engine-authoritative agent_commission_profiles",
    rule1Sync(a))
  check("NEGATIVE CONTROL removing the profile sync turns RULE-1 red — went RED as required",
    !rule1Sync(a.replace(/split_percent/g, "split_percent_REMOVED")))
  check("the sync sets is_active so the engine's active-profile read finds it",
    /agent_commission_profiles[\s\S]*?is_active: true/.test(a) || /is_active: true[\s\S]*?agent_commission_profiles/.test(aFlat))
  // The write must be PROVEN, not assumed: supabase-js resolves a refused write
  // with error:null and zero rows, so a broker would be told a split was saved
  // that the engine will never see.
  check("…and the profile write proves it landed (row count, not a resolved promise)",
    /\.select\("id"\)/.test(aFlat) && /profileRows/.test(aFlat))

  const form = src("app/dashboard/admin/users/[userId]/user-edit-form.tsx")
  check("the form shows the Agent Profile card only when an agent row exists",
    form.includes("{agentProfile && (") && form.includes("Agent Profile"))
  check("the form saves the agent profile via updateAgentProfileAction",
    form.includes("updateAgentProfileAction"))
  check("office dropdown is populated from the brokerage offices",
    form.includes("offices.map"))
}

console.log("\n── read-only role capabilities are surfaced from the canonical matrix ──")
{
  const form = src("app/dashboard/admin/users/[userId]/user-edit-form.tsx")
  check("imports the permission matrix (SSOT; live DB has no role_capabilities table)",
    form.includes("ROLE_PERMISSIONS") && form.includes("PERMISSION_DEFINITIONS") && form.includes("ROLE_HIERARCHY"))
  check("resolves the selected role to canonical before lookup",
    form.includes("toCanonicalRole(form.user_type)"))
  check("renders the 'What this role can do' card",
    form.includes("What this role can do"))
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE ROLE→CAPABILITY TABLE (CLAUDE.md §6). Added wave 26, lane PERM, after the
// deletion of lib/auth/permissions.ts — a SECOND role→capability table
// (`ROLE_CAPABILITIES`) with eleven exported gate helpers over it and ZERO
// callers anywhere in app/, lib/ or scripts/. Nothing read it, so nothing
// disagreed with the matrix yet; but it carried `lender: ["contacts:read"]`,
// which CLAUDE.md §5 forbids, and it had no `contact` and no `title_agent` row
// while its lookup fell back to `ROLE_CAPABILITIES.agent` — so the day anyone
// wired a gate to it, a contact would have been handed the AGENT capability set.
// m470 lists the three role tables it maintained and this one was not among
// them: it had already dropped out of the vocabulary waves, unseen, because
// NOTHING COUNTED HOW MANY OF THESE TABLES EXIST. This block counts them.
//
// The finder is deliberately two-sided, because a role table is half code and
// half string data: the ROLE KEYS must be CODE (found in blankStrings output, so
// a role name inside a fixture, a tombstone or a registry narrative cannot
// count), while the CAPABILITY GRANTS are STRING LITERALS (collected through
// stringLiterals, which is the same single scanner and skips comments for free).
// Reading raw source for either half is the §2 defect — the tombstone this lane
// left in lib/auth/index.ts contains the literal "contacts:read", and a raw scan
// would read the record of the fix as the defect itself, forever.
//
// STATED BLIND SPOTS (§2, published beside the number):
//   · The discriminator is a `group:action` capability literal. A fourth table
//     written in the snake_case vocabulary CANONICAL_ROLE_CONFIG uses
//     ('manage_users', 'view_all_contacts') would not trip it. That vocabulary
//     is itself the §6 residue named in the registry below.
//   · Thresholds are 5 distinct role keys and 10 distinct capability literals.
//     A deliberately small table (three roles, four grants) passes under them.
//   · scripts/ is excluded: a simulator that reproduces a table as a specimen is
//     a proof, not a second source of truth.
console.log("\n── there is ONE role→capability table, and the tree cannot grow a second ──")
{
  const SCAN_ROOTS = [
    "app", "lib", "constants", "contexts", "hooks",
    "services", "types", "workflows", "remotion", "tools",
  ]
  const ROLE_FLOOR = 5
  const CAP_FLOOR = 10
  const SCAN_ROLES = [
    "superadmin", "admin", "broker", "team_lead", "agent", "isa",
    "tc", "compliance_officer", "vendor", "lender", "title_agent", "contact",
  ]
  const CAPABILITY_LITERAL = /^[a-z_]+:[a-z_*]+$/
  const RAW_CAPABILITY = /['"`][a-z_]+:[a-z_*]+['"`]/g

  const walk = (dir: string, out: string[] = []): string[] => {
    const abs = join(process.cwd(), dir)
    if (!existsSync(abs)) return out
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next" || e.name.startsWith(".")) continue
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) walk(rel, out)
      else if (/\.tsx?$/.test(e.name)) out.push(rel)
    }
    return out
  }

  /** Role keys counted in CODE; capability grants counted in STRING LITERALS. */
  const measure = (raw: string) => {
    // EXACT prefilter, not an approximation: stringLiterals() can only ever
    // return a SUBSET of the quoted `x:y` tokens present in the raw text, so a
    // file below the floor raw cannot reach it after scanning. It keeps the real
    // scanner off ~5,000 files that could not qualify however they are read.
    const rawCaps = raw.match(RAW_CAPABILITY)
    if (!rawCaps || rawCaps.length < CAP_FLOOR) return { roles: 0, caps: 0, flagged: false }
    const structure = blankStrings(raw)
    const roles = SCAN_ROLES.filter((r) =>
      new RegExp(`(?:^|[{,;(\\s])${r}\\s*:\\s*[\\[{]`, "m").test(structure)).length
    const caps = new Set(
      stringLiterals(raw).map((l) => l.text).filter((t) => CAPABILITY_LITERAL.test(t)),
    ).size
    return { roles, caps, flagged: roles >= ROLE_FLOOR && caps >= CAP_FLOOR }
  }

  // The COMPLETE set of role→capability tables this tree is allowed to hold, each
  // with the vocabulary it owns. A fourth entry is not something to add here — it
  // is the defect this block exists to catch.
  const REGISTERED: Record<string, string> = {
    "lib/security/permission-matrix.ts":
      "THE SSOT. ROLE_PERMISSIONS/ROLE_HIERARCHY over the canonical `Permission` " +
      "vocabulary catalogued in PERMISSION_DEFINITIONS. The live DB has no " +
      "role_capabilities table, so this static matrix is the source of truth.",
    "lib/security/permissions-service.ts":
      "ROLE_UI_PERMISSIONS/ROLE_NAVIGATION — the UI-SURFACE vocabulary " +
      "(`verb:surface`, e.g. view:all_contacts), a different question from the " +
      "`group:action` data permissions. Named beside the matrix in m470.",
    "lib/security/types.ts":
      "CANONICAL_ROLE_CONFIG — the role LABEL/description/icon catalogue. Its " +
      "`permissions` field is a snake_case prose summary, not a gate vocabulary; " +
      "it trips the finder on the `Permission` union declared in the same file.",
  }

  const flagged: string[] = []
  for (const root of SCAN_ROOTS) {
    for (const f of walk(root)) {
      let raw = ""
      try { raw = readFileSync(join(process.cwd(), f), "utf8") } catch { continue }
      if (measure(raw).flagged) flagged.push(f)
    }
  }

  const unregistered = flagged.filter((f) => !(f in REGISTERED))
  check(`no role→capability table outside the ${Object.keys(REGISTERED).length} registered ones`,
    unregistered.length === 0, unregistered.join(", "))

  // POSITIVE CONTROL, on the REAL TREE: every registered table is still found by
  // the finder. A registry gone stale and a regex that stopped matching both
  // report "0 unregistered" — this is what separates them.
  for (const f of Object.keys(REGISTERED)) {
    check(`the finder still sees ${f} (registry is live, not stale)`, flagged.includes(f))
  }

  // POSITIVE CONTROL, on the DELETED TABLE: the exact shape lib/auth/permissions.ts
  // carried. If this stops being flagged, the finder no longer recognises the
  // defect it was written for and every "0 found" above is worthless.
  const DELETED_SHAPE = [
    'const ROLE_CAPABILITIES: Record<string, string[]> = {',
    '  superadmin: ["*"],',
    '  broker: ["contacts:read", "contacts:write", "listings:read", "listings:write", "transactions:read", "transactions:write", "agents:read", "agents:write", "reports:read", "billing:read", "billing:write", "admin:read", "admin:write"],',
    '  admin: ["contacts:read", "contacts:write", "listings:read", "transactions:read", "agents:read", "reports:read", "admin:read"],',
    '  team_lead: ["contacts:read", "contacts:write", "listings:read", "transactions:read", "agents:read"],',
    '  agent: ["contacts:read", "contacts:write", "listings:read", "listings:write", "transactions:read"],',
    '  tc: ["transactions:read", "transactions:write", "listings:read", "contacts:read"],',
    '  compliance_officer: ["compliance:read", "compliance:write", "listings:read"],',
    '  isa: ["contacts:read", "contacts:write"],',
    '  vendor: ["listings:read"],',
    '  lender: ["contacts:read"],',
    '}',
  ].join("\n")
  check("POSITIVE CONTROL the deleted ROLE_CAPABILITIES shape is still recognised",
    measure(DELETED_SHAPE).flagged)

  // Eleven distinct capability literals, so both negative controls below clear the
  // capability floor and are decided by the ROLE-KEY half alone. A control that
  // only passes because it never reached the second test proves nothing.
  const CAPS_LINE =
    'type P = "contacts:view" | "contacts:create" | "contacts:edit" | "leads:view" | ' +
    '"leads:claim" | "listings:create" | "listings:edit" | "listings:view_all" | ' +
    '"transactions:view" | "analytics:view_own" | "financials:view_own"'

  // NEGATIVE CONTROL 1 — role names as VALUES are not a table. FEATURE_FLAGS in the
  // survivor is exactly this inverse shape, and condemning it would be a false
  // accusation against the SSOT's own file.
  const INVERSE_SHAPE = [
    CAPS_LINE,
    'const FEATURE_FLAGS: Record<string, UserRole[]> = {',
    '  crm: ["agent", "team_lead", "broker", "admin", "superadmin"],',
    '  calling_center: ["isa", "broker", "admin", "superadmin"],',
    '  loan_pipeline: ["lender", "broker", "admin", "superadmin"],',
    '}',
  ].join("\n")
  check("NEGATIVE CONTROL role names as array VALUES are not a role→capability table",
    !measure(INVERSE_SHAPE).flagged)

  // NEGATIVE CONTROL 2 — a role→LABEL map. Without this the finder would condemn
  // RoleManager.getRoleLabel and every navigation map keyed by role. The
  // discriminator is what follows the colon: a label map holds a STRING, the
  // registered CANONICAL_ROLE_CONFIG holds an OBJECT.
  const LABEL_SHAPE = [
    CAPS_LINE,
    'const labels: Record<UserRole, string> = {',
    '  superadmin: "Super Admin", admin: "Administrator", broker: "Broker",',
    '  team_lead: "Team Lead", agent: "Agent", isa: "ISA", tc: "Transaction Coordinator",',
    '  compliance_officer: "Compliance Officer", vendor: "Vendor", lender: "Lender",',
    '  title_agent: "Title Agent", contact: "Contact",',
    '}',
  ].join("\n")
  check("NEGATIVE CONTROL a role→label map is not flagged", !measure(LABEL_SHAPE).flagged)
  check("…and both negative controls DID clear the capability floor, so the role half decided them",
    measure(LABEL_SHAPE).caps >= CAP_FLOOR && measure(INVERSE_SHAPE).caps >= CAP_FLOOR)

  // NEGATIVE CONTROL 3 — the §2 one. The same table written entirely inside a
  // comment must NOT be flagged: a tombstone is not a call site, and
  // lib/auth/index.ts now carries "contacts:read" in exactly that form.
  const asComment = DELETED_SHAPE.split("\n").map((l) => `// ${l}`).join("\n")
  check("NEGATIVE CONTROL the same table written as a COMMENT is not flagged",
    !measure(asComment).flagged)
  check("…so the real tombstone in lib/auth/index.ts is not counted, though it is there",
    !flagged.includes("lib/auth/index.ts") && src("lib/auth/index.ts").includes("contacts:read"))
}

console.log("\n── the deleted duplicate stays deleted, and names its survivor ──")
{
  check("lib/auth/permissions.ts is gone",
    !existsSync(join(process.cwd(), "lib/auth/permissions.ts")))
  const barrel = src("lib/auth/index.ts")
  check("lib/auth/index.ts leaves a tombstone naming the survivor",
    barrel.includes("lib/security/permission-matrix.ts"))

  // Asserted over CODE. The tombstone names every one of these helpers in prose,
  // so a raw scan would report the barrel as still exporting all of them — the
  // exact §2 failure where following the orphan doctrine turns a guard red.
  const barrelCode = blankStrings(barrel)
  const GONE = [
    "getCurrentUserContext", "getCurrentUserWithRole", "getUserBrokerages",
    "hasCapability", "hasRole", "isAdmin", "assertCapability", "assertRole",
    "assertAdmin", "getCurrentBrokerageId", "canAccessResource",
    "UserWithRole", "BrokerageContext",
  ]
  const stillExported = GONE.filter((n) => new RegExp(`\\b${n}\\b`).test(barrelCode))
  check("the barrel no longer re-exports any of the deleted symbols",
    stillExported.length === 0, stillExported.join(", "))
  check("STRIPPER CONTROL every one of those names IS in the raw file, so the check can see",
    GONE.every((n) => barrel.includes(n)))

  // CLAUDE.md §5 — contacts, lenders and vendors see no financials and only their
  // own. The dead table's `lender: ["contacts:read"]` was deliberately NOT ported
  // onto the survivor, and the whole retired read/write spelling stays out of the
  // capability modules with it. Read through stringLiterals, NOT blankStrings:
  // blankStrings empties every literal, so a regex for a capability STRING run
  // over its output can never match and would report a clean tree forever.
  const RETIRED_SPELLING = /^(contacts|listings|transactions|agents|reports|billing|compliance):(read|write)$/
  const CAPABILITY_MODULES: string[] = []
  for (const dir of ["lib/auth", "lib/security"]) {
    const abs = join(process.cwd(), dir)
    if (!existsSync(abs)) continue
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isFile() && /\.tsx?$/.test(e.name)) CAPABILITY_MODULES.push(`${dir}/${e.name}`)
    }
  }
  const reintroduced = CAPABILITY_MODULES.filter((f) =>
    stringLiterals(src(f)).some((l) => RETIRED_SPELLING.test(l.text)))
  check("the retired read/write capability spelling is in no live lib/auth or lib/security code",
    reintroduced.length === 0, reintroduced.join(", "))
  check("POSITIVE CONTROL that finder still matches the spelling it hunts",
    RETIRED_SPELLING.test("contacts:read") && !RETIRED_SPELLING.test("contacts:view"))
  check("STRIPPER CONTROL the tombstone's own \"contacts:read\" is raw text the literal scan skips",
    barrel.includes('"contacts:read"') &&
    !stringLiterals(barrel).some((l) => RETIRED_SPELLING.test(l.text)))
}

console.log("\n── the page loads the profile through the gated action ──")
{
  const page = src("app/dashboard/admin/users/[userId]/page.tsx")
  check("loads the agent profile + offices via getAgentProfileForUserAction",
    page.includes("getAgentProfileForUserAction"))
  check("passes agentProfile + offices to the form",
    page.includes("agentProfile={agentProfile}") && page.includes("offices={offices}"))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ PEOPLE_OPS_PROFILE_FAIL"); process.exit(1) }
console.log(" ✅ PEOPLE_OPS_PROFILE_PASS — one person, one surface: contact + license + office + commission + role view, read from ONE role→capability table")
