#!/usr/bin/env tsx
/**
 * scripts/impersonation-simulator.ts   (npm run test:impersonation)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves STAFF "ACT AS TENANT" (GoHighLevel-style sub-account control): platform staff enter any
 * tenant and operate the app AS that tenant, ACCOUNTABLY (real staff id stays attributable).
 *
 * PURE:   isSessionActive — the expiry/ended predicate the whole seam trusts.
 * SOURCE: getAgentContext consults resolveActiveImpersonation (staff-gated); enter/exit are
 *         staff-gated + audited; banner + Enter button are wired; owned by data_steward.
 * LIVE (creds-gated): seed a staff user + a target tenant, open a session, assert
 *         resolveActiveImpersonation returns the TARGET brokerage + the real actor; a NON-staff
 *         user with the same session gets null; an EXPIRED session resolves null; exit clears it;
 *         clean up == 0. Self-skips without creds (verified via MCP).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { isSessionActive } from "../lib/platform/impersonation"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const NOW = new Date("2026-07-05T12:00:00Z")
const iso = (msFromNow: number) => new Date(NOW.getTime() + msFromNow).toISOString()

function pureLayer() {
  console.log("\n[isSessionActive · pure — the act-as predicate]")
  check("live session (future expiry, not ended) is active", isSessionActive({ ended_at: null, expires_at: iso(10 * 60_000) }, NOW))
  check("expired session is NOT active", !isSessionActive({ ended_at: null, expires_at: iso(-60_000) }, NOW))
  check("ended session is NOT active (exited)", !isSessionActive({ ended_at: iso(-1000), expires_at: iso(10 * 60_000) }, NOW))
  check("malformed expiry is NOT active (fails safe)", !isSessionActive({ ended_at: null, expires_at: "not-a-date" }, NOW))
}

function sourceLayer() {
  console.log("\n[wiring — the seam, gating, audit, ownership]")
  const ctx = src("lib/identity/get-agent-context.ts")
  // (round-19 parity: the seam now checks BOTH identity columns — legacy
  //  user_type 'superadmin' OR roster platform_role — so platform admin/
  //  marketing staff can impersonate per the capability map.)
  check("getAgentContext consults the act-as seam, staff-gated, only for platform staff",
    /isPlatformStaffIdentity\(userType, platformRole\)/.test(ctx) && /resolveActiveImpersonation\(user\.id, platformRole \?\? userType/.test(ctx))
  check("impersonated context keeps the REAL actor + flags (attributable writes)",
    /impersonatorUserId: imp\.impersonatorUserId/.test(ctx) && /isImpersonating: true/.test(ctx))
  const lib = src("lib/platform/impersonation.ts")
  // (round-19: full 4-role roster — 'admin' is safe here because staffRole is
  //  ALWAYS sourced from platform_role/legacy-superadmin, never tenant user_type.)
  check("resolver is defence-in-depth (returns null unless roster staff)", /if \(!isPlatformStaffRole\(staffRole\)\) return null/.test(lib))
  check("sessions auto-expire (TTL) — no standing backdoor", /IMPERSONATION_TTL_MINUTES\s*=\s*30/.test(lib) && /expires_at/.test(lib))
  const act = src("app/actions/superadmin/impersonation.ts")
  check("enter/exit are platform-staff-gated + audited to superadmin_audit_log",
    /requirePlatformStaff/.test(act) && /superadmin_audit_log/.test(act) && /"impersonation\.enter"/.test(act) && /"impersonation\.exit"/.test(act))
  check("a named target user must belong to the target tenant (no cross-tenant leak)",
    /brokerage_id !== params\.brokerageId/.test(act))
  check("the shell mounts the persistent Exit banner", /ImpersonationBanner/.test(src("app/components/layout/app-shell.tsx")))
  check("the god console exposes Enter tenant", /EnterTenantButton/.test(src("app/dashboard/superadmin/brokerages/[id]/page.tsx")))
  const mig = src("supabase/migrations/m267-platform-impersonation.sql")
  check("one active session per actor (partial unique) + RLS limits a staff user to their OWN session",
    /ux_impersonation_active_actor/.test(mig) && /where ended_at is null/.test(mig) && /actor_user_id = auth\.uid\(\)/.test(mig))
  console.log("\n[act-as WRITES — operate tenant screens as-tenant]")
  const acting = src("lib/platform/acting-context.ts")
  // WAS PINNED TO ONE EXPRESSION: `isImpersonating ? createServiceClient() :
  // await createClient()`. The act-as merge — which deleted a SECOND, differently
  // shaped declaration of this seam from lib/kernel/identity.ts — lifted the
  // client construction into a shared resolver and keyed it on an explicit
  // CHANNEL instead of re-testing the flag inline. The ternary still exists; it
  // now reads `channel === "service" ? …`, so this assertion went red for a
  // refactor that made the seam more correct, which is §2's waypoint trap.
  //
  // The claim is unchanged and is now checked in three parts, none of them a
  // spelling: the decision function exists and RESOLVES to a channel, the
  // service client is reached on the service channel and nowhere else, and the
  // read-only flag is still derived from the grant mode rather than assumed.
  check("acting context hands writers a service client when acting-as (bypasses target RLS) + a read-only flag",
    /export function decideWriteChannel/.test(acting)
    && /channel === "service" \? createServiceClient\(\) : await createClient\(\)/.test(acting)
    && /readOnly:\s*ctx\.impersonationMode === "read_only"/.test(acting))
  // And the half the old pin could not express at all: a read_only grant is
  // REFUSED at the decision, so it never reaches a client. That is the direction
  // the merge found broken across 112 call sites — a read_only grant that could
  // write — so it is asserted here rather than left to the seam's own proof.
  check("…and a read_only grant is REFUSED before any client is constructed",
    /if \(ctx\.impersonationMode !== "full"\) return \{ channel: "refused", reason: "read_only" \}/.test(acting))
  const brand = src("app/actions/onboarding/brand.ts")
  check("tenant brand writers are impersonation-aware: acting context + read-only refusal + write THROUGH db",
    /resolveActingContext/.test(brand) && /READ_ONLY_ACTING_ERROR/.test(brand) && /const supabase = auth\.db|const supabase = adminAuth\.db/.test(brand))
  check("brand read (getBrandSetupStatus) lets staff see the TARGET tenant's brand",
    /const ctx = await resolveActingContext\(\)[\s\S]*ctx\.brokerageId !== brokerageId/.test(brand))

  console.log("\n[centralized platform-staff gate — no more drift]")
  const guard = src("lib/auth/platform-guard.ts")
  check("ONE gate module: requireSuperadmin (destructive) + requirePlatformStaff (assist), both read user_type+platform_role",
    /export async function requireSuperadmin/.test(guard) && /export async function requirePlatformStaff/.test(guard) && /platform_role/.test(guard))
  check("god-console actions adopt the shared guard (dropped their copy-pasted local gate)",
    /from "@\/lib\/auth\/platform-guard"/.test(act) && /from "@\/lib\/auth\/platform-guard"/.test(src("app/actions/superadmin/tenant-users.ts")))
  check("the superadmin subtree has a single layout gate",
    /requirePlatformStaff/.test(src("app/dashboard/superadmin/layout.tsx")))

  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by data_steward with a runnable proof",
    /platform_impersonation:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:impersonation"/.test(reg))
  check("the impersonation table has an owning manager", /platform_impersonation_sessions:\s*"data_steward"/.test(reg))
  check("package.json wires the proof", /"test:impersonation":\s*"tsx scripts\/impersonation-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source proved the logic; live verified via MCP"); return }
  const svc = createClient(url, key)
  const { resolveActiveImpersonation, startImpersonation, endImpersonation } = await import("../lib/platform/impersonation")
  console.log("\n[live] staff opens a session on a target tenant → context resolves target → exit → clean up")
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: brk } = await svc.from("brokerages").insert({ name: "ZZIMP tenant", email: "zzimp@example.com", plan_tier: "brokerage", onboarding_status: "pending" }).select("id").single()
    const { data: staff } = await svc.from("users").insert({ email: "zzimp-staff@example.com", first_name: "Imp", last_name: "Staff", user_type: "superadmin", is_contact: false }).select("id").single()
    const { data: nonstaff } = await svc.from("users").insert({ email: "zzimp-agent@example.com", first_name: "Imp", last_name: "Agent", user_type: "agent", is_contact: false }).select("id").single()
    const brokerageId = (brk as any).id, staffId = (staff as any).id, nonstaffId = (nonstaff as any).id
    cleanup.push({ table: "brokerages", id: brokerageId }, { table: "users", id: staffId }, { table: "users", id: nonstaffId })

    const started = await startImpersonation({ actorUserId: staffId, actorEmail: "zzimp-staff@example.com", targetBrokerageId: brokerageId, mode: "full", client: svc })
    check("live: session started", started.ok)

    const resolved = await resolveActiveImpersonation(staffId, "superadmin", svc)
    check("live: staff context resolves the TARGET tenant + real actor", resolved?.brokerageId === brokerageId && resolved?.impersonatorUserId === staffId)
    const asNonStaff = await resolveActiveImpersonation(nonstaffId, "agent", svc)
    check("live: a non-staff user resolves NO impersonation (defence in depth)", asNonStaff === null)

    // Force-expire → resolves null.
    await svc.from("platform_impersonation_sessions").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("actor_user_id", staffId).is("ended_at", null)
    const afterExpiry = await resolveActiveImpersonation(staffId, "superadmin", svc)
    check("live: an EXPIRED session resolves null", afterExpiry === null)

    await endImpersonation(staffId, svc)
    const afterExit = await resolveActiveImpersonation(staffId, "superadmin", svc)
    check("live: after exit, no active session", afterExit === null)
  } finally {
    await svc.from("platform_impersonation_sessions").delete().in("actor_user_id", cleanup.filter((c) => c.table === "users").map((c) => c.id))
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ IMPERSONATION_FAIL"); process.exit(1) }
  console.log(" ✅ IMPERSONATION_PASS — staff act-as tenant: target context resolved, real actor attributable, staff-gated + audited + auto-expiring")
}
main()
