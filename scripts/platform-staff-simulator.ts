#!/usr/bin/env tsx
/**
 * scripts/platform-staff-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SUPERADMIN CREATES PLATFORM EMPLOYEES (support / superadmin) — the people who run
 * the platform, above every tenant. Also consolidates the THREE drifted
 * ROLE_DASHBOARD_ROUTES copies (users.ts / onboarding.ts / root-role-resolver.tsx)
 * onto ONE canonical map (lib/kernel/role-routes.ts) that now routes 'support'.
 *
 * Layer 1 (pure): validateStaffInput (valid → normalized; bad email / empty name /
 *   non-staff role → error); isPlatformStaffRole; roleDashboardRoute (support →
 *   /dashboard/support, unknown → default).
 * Layer 2 (source): the CRUD actions are superadmin-gated + audited + guard against
 *   self-demote / self-revoke; the three former route maps now IMPORT the canonical
 *   one (no local const left).
 * Layer 3 (live, gated): create a platform-staff users row (user_type + platform_role
 *   support, NO brokerage) → the roster query lists it → promote to superadmin →
 *   revoke (platform_role null + status inactive) → cleanup, count == 0.
 *
 * Run: npx tsx scripts/platform-staff-simulator.ts   (npm run test:platform-staff)
 */
import { validateStaffInput, isPlatformStaffRole, PLATFORM_STAFF_ROLES, platformStaffCan } from "../lib/platform/platform-staff-roster"
import { roleDashboardRoute, ROLE_DASHBOARD_ROUTES } from "../lib/kernel/role-routes"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Platform staff verified — superadmin CRUD, audited, one canonical route map (support routes)")
  console.log(" PLATFORM_STAFF_PASS")
}

function uuidFrom(tag: string): string {
  const h = Buffer.from(tag).toString("hex").padEnd(32, "0").slice(0, 32)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Platform staff (superadmin CRUD) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure validation + route map]")
  const good = validateStaffInput({ email: " Sam@Co.COM ", firstName: " Sam ", lastName: "Ops", role: "support" })
  check("valid staff normalizes (email lowered/trimmed, role kept)",
    good.ok && good.value.email === "sam@co.com" && good.value.firstName === "Sam" && good.value.role === "support")
  check("bad email → error", !validateStaffInput({ email: "nope", firstName: "A", role: "support" }).ok)
  check("empty first name → error", !validateStaffInput({ email: "a@b.co", firstName: "", role: "support" }).ok)
  check("non-staff role → error", !validateStaffInput({ email: "a@b.co", firstName: "A", role: "agent" }).ok)
  check("isPlatformStaffRole: the 4 platform roles, not a tenant role", isPlatformStaffRole("support") && isPlatformStaffRole("superadmin") && isPlatformStaffRole("marketing") && isPlatformStaffRole("admin") && !isPlatformStaffRole("agent"))
  check("PLATFORM_STAFF_ROLES = [superadmin, admin, marketing, support]", PLATFORM_STAFF_ROLES.length === 4)
  check("capability map: superadmin all; admin most; marketing→marketing only; support→support only",
    platformStaffCan("superadmin", "staff") && platformStaffCan("admin", "billing") && !platformStaffCan("admin", "staff") &&
    platformStaffCan("marketing", "marketing") && !platformStaffCan("marketing", "billing") &&
    platformStaffCan("support", "support") && !platformStaffCan("support", "plans"))
  check("staff validator accepts the 4 roles, rejects a tenant role",
    validateStaffInput({ email: "a@b.co", firstName: "A", role: "marketing" }).ok && !validateStaffInput({ email: "a@b.co", firstName: "A", role: "agent" }).ok)
  check("canonical route map routes 'support' → /dashboard/support",
    ROLE_DASHBOARD_ROUTES.support === "/dashboard/support" && roleDashboardRoute("support") === "/dashboard/support")
  check("unknown role → default agent route", roleDashboardRoute("who") === "/dashboard/agent")

  console.log("\n[Layer 2 · CRUD gating + route consolidation]")
  const actionSrc = readFileSync(join(process.cwd(), "app/actions/superadmin/platform-staff.ts"), "utf8")
  check("staff actions are superadmin-gated + audited",
    /requireSuperadmin/.test(actionSrc) && /superadmin_audit_log/.test(actionSrc))
  check("cannot self-demote or self-revoke (platform lockout guard)",
    /cannot remove your own superadmin role/.test(actionSrc) && /cannot revoke your own access/.test(actionSrc))
  check("create maps role→(user_type, platform_role) coherently for all 4 roles + NO brokerage",
    /roleColumns\(/.test(actionSrc) && /case "admin":\s*return \{ user_type: "admin", platform_role: "admin" \}/.test(actionSrc) &&
    /platform_role: "marketing"/.test(actionSrc) && /brokerage_id: null/.test(actionSrc))
  check("revoke breaks every gate condition (user_type contact + platform_role null + inactive)",
    /user_type: "contact", platform_role: null, status: "inactive"/.test(actionSrc))

  // THE TWO ROUTE MAPS MUST AGREE.
  //
  // This block used to iterate a hand-typed list of three files, one of which
  // (root-os/root-role-resolver.tsx) has since been deleted as dead code — and a
  // hardcoded readFileSync of a deleted path throws ENOENT, so removing dead code
  // would have broken the guard. Same brittleness the legacy-table guard had: the
  // right assertion over the wrong input.
  //
  // A first rewrite scanned lib/ for ANY dashboard route literal, which was too
  // broad — it flagged CTA hrefs in a briefing module, where linking to a page is
  // not the same thing as declaring where a role lands. Breadth is not rigour.
  //
  // The invariant that actually matters is CONSISTENCY between the two maps that
  // legitimately both exist:
  //   · ROLE_DASHBOARD_ROUTES (lib/kernel/role-routes) — role → landing route
  //   · ROUTE_ROLE_REQUIREMENTS (lib/kernel/helpers)   — route prefix → allowed roles
  // They are inverses of each other over an overlapping domain. If they drift, a
  // role lands on a page its own role is refused — a redirect loop at login, for
  // that role only, which is exactly the kind of break nobody sees until a
  // customer with that role signs in.
  {
    const helpersSrc = readFileSync(join(process.cwd(), "lib/kernel/helpers.ts"), "utf8")
    const block = helpersSrc.slice(
      helpersSrc.indexOf("ROUTE_ROLE_REQUIREMENTS"),
      helpersSrc.indexOf("}", helpersSrc.indexOf("ROUTE_ROLE_REQUIREMENTS")),
    )
    // Capture the RAW array body, not just its string literals: one entry is
    // `[...STAFF_ROLES]`, and a literals-only parse turns that into an empty
    // array — which then reports every role landing under /dashboard as locked
    // out. That was a parser bug reporting seven false findings, and a guard that
    // cries wolf gets switched off.
    const requirements = new Map<string, { roles: string[]; raw: string }>()
    for (const m of block.matchAll(/"([^"]+)":\s*\[([^\]]*)\]/g)) {
      requirements.set(m[1], {
        roles: Array.from(m[2].matchAll(/"([^"]+)"/g)).map((x) => x[1]),
        raw: m[2],
      })
    }

    // CANARY — a parse that silently yields nothing would pass every check below.
    check(`the route→roles map parsed (${requirements.size} prefixes)`, requirements.size >= 8)

    const mismatched: string[] = []
    for (const [role, route] of Object.entries(ROLE_DASHBOARD_ROUTES)) {
      // Longest matching prefix wins, the way a real prefix guard resolves.
      const prefix = [...requirements.keys()]
        .filter((p) => route === p || route.startsWith(p + "/"))
        .sort((a, b) => b.length - a.length)[0]
      if (!prefix) continue                       // route not access-gated at all
      const entry = requirements.get(prefix)!
      // A spread means the allow-list is computed elsewhere; this static check
      // cannot resolve it and must not guess.
      if (entry.raw.includes("...")) continue
      if (!entry.roles.includes(role)) {
        mismatched.push(`${role} lands on ${route} but ${prefix} allows only [${entry.roles.join(", ")}]`)
      }
    }
    check(`every role can reach the dashboard it lands on (${mismatched.length})`,
      mismatched.length === 0)
    if (mismatched.length) mismatched.slice(0, 5).forEach((m) => console.log(`      ${m}`))

    for (const f of ["lib/kernel/users.ts", "lib/kernel/onboarding.ts"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8")
      check(`${f} imports the canonical route map (role-routes)`,
        /from ['"](@\/lib\/kernel\/role-routes|\.\/role-routes)['"]/.test(src))
    }
  }

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 3 · live staff CRUD]")
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure + source layers ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `Staff${Date.now()}`
  const staffId = uuidFrom(TAG)
  const email = `${TAG}@platform.local`.toLowerCase()

  console.log("\n[Layer 3 · live staff CRUD]")
  try {
    // create — SUPPORT is a user_type (platform_role CHECK only allows superadmin), no brokerage
    const { error: cErr } = await svc.from("users").insert({
      id: staffId, email, first_name: TAG, last_name: "Support", user_type: "support",
      platform_role: null, brokerage_id: null, is_contact: false, status: "active",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    })
    if (cErr) { check("create platform-staff row", false, cErr.message); report(); return }

    // list (the roster query: user_type support/superadmin OR platform_role superadmin)
    const { data: listed } = await svc.from("users")
      .select("id, user_type, brokerage_id")
      .or("user_type.in.(superadmin,support),platform_role.eq.superadmin")
      .eq("id", staffId).maybeSingle()
    check("support staff appears in the roster (user_type support, no brokerage)",
      (listed as any)?.user_type === "support" && (listed as any)?.brokerage_id === null)

    // promote support → superadmin (sets BOTH columns coherently)
    await svc.from("users").update({ user_type: "superadmin", platform_role: "superadmin" }).eq("id", staffId)
    const { data: promoted } = await svc.from("users").select("user_type, platform_role").eq("id", staffId).single()
    check("role change persists (support → superadmin, both columns)",
      (promoted as any).user_type === "superadmin" && (promoted as any).platform_role === "superadmin")

    // revoke → breaks EVERY gate condition (user_type non-staff + platform_role null + inactive)
    await svc.from("users").update({ user_type: "contact", platform_role: null, status: "inactive" }).eq("id", staffId)
    const { data: revoked } = await svc.from("users").select("user_type, platform_role, status").eq("id", staffId).single()
    check("revoke breaks all gate conditions (user_type contact, platform_role null, inactive)",
      (revoked as any).user_type === "contact" && (revoked as any).platform_role === null && (revoked as any).status === "inactive")
  } finally {
    try { await svc.from("users").delete().eq("id", staffId) } catch { /* noop */ }
    const { count } = await svc.from("users").select("id", { count: "exact", head: true }).eq("email", email)
    check("cleanup verified — 0 seeded staff remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
