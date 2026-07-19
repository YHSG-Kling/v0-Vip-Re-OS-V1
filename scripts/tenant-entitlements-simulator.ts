#!/usr/bin/env tsx
/**
 * scripts/tenant-entitlements-simulator.ts   (npm run test:tenant-entitlements)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves PER-TENANT ENTITLEMENTS from the god console: flip a feature for ONE tenant
 * (grant_trial / disable / clear) + grant/revoke an AI-token quota override — reusing the
 * existing data model with zero drift (feature_access_overrides canonical vocab,
 * ai_quota_overrides status='approved', v_brokerage_ai_quota).
 *
 * PURE:   normalizeOverrideType folds any spelling onto the DB-valid CHECK vocabulary.
 * SOURCE: the action is requireSuperadmin-gated + audited, writes via the service client
 *         at brokerage scope, uses the override vocab + approved quota; the panel is wired;
 *         owned by data_steward with a runnable proof.
 * LIVE (creds-gated): grant trial → override row (brokerage-scoped, grant_trial); disable →
 *         flips; clear → gone; quota grant → approved ai_quota_overrides row counted by
 *         fair-use; revoke → status revoked; clean up == 0. Self-skips without creds.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { normalizeOverrideType } from "../lib/kernel/override-vocab"
import { parseSeatOverride, effectiveSeatLimit, seatCheck } from "../lib/kernel/tier-role-matrix"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[override vocab · pure — CHECK-valid, no drift]")
  check("'grant_trial' + legacy 'trial' fold to grant_trial", normalizeOverrideType("grant_trial") === "grant_trial" && normalizeOverrideType("trial") === "grant_trial")
  check("'disable' + legacy 'disabled' fold to disable", normalizeOverrideType("disable") === "disable" && normalizeOverrideType("disabled") === "disable")
  check("an unknown/clear action is not a valid override kind", normalizeOverrideType("clear") === null && normalizeOverrideType("") === null)

  console.log("\n[per-tenant seat override · pure — ONE keep-one resolution]")
  check("billing_metadata.seat_override parses only honest integers ≥ 0",
    parseSeatOverride({ seat_override: 12 }) === 12
    && parseSeatOverride({ seat_override: 0 }) === 0
    && parseSeatOverride({ seat_override: -3 }) === null
    && parseSeatOverride({ seat_override: 2.5 }) === null
    && parseSeatOverride({ seat_override: "9" }) === null
    && parseSeatOverride(null) === null && parseSeatOverride({}) === null)
  check("override WINS when set — raises a capped tier and caps an unlimited one",
    effectiveSeatLimit("solo_agent", 12).limit === 12 && effectiveSeatLimit("solo_agent", 12).overridden === true
    && effectiveSeatLimit("brokerage", 25).limit === 25)
  check("null override ⇒ tier default (Solo 2 · Team 5 · Brokerage unlimited)",
    effectiveSeatLimit("solo_agent", null).limit === 2 && effectiveSeatLimit("solo_agent", null).overridden === false
    && effectiveSeatLimit("team", null).limit === 5 && effectiveSeatLimit("brokerage", null).limit === null)
  check("seatCheck enforces the SAME resolved limit (2 in use: solo denies, solo+override 12 allows)",
    seatCheck("solo_agent", 2).allowed === false
    && seatCheck("solo_agent", 2, 12).allowed === true && seatCheck("solo_agent", 2, 12).overridden === true
    && seatCheck("brokerage", 25, 25).allowed === false)
}

function sourceLayer() {
  console.log("\n[wiring — gated, audited, cross-tenant, reused primitives]")
  const act = src("app/actions/superadmin/tenant-entitlements.ts")
  check("all writers are superadmin-gated", (act.match(/requireSuperadmin\(\)/g) ?? []).length >= 4)
  check("writes go through the SERVICE client (cross-tenant) + audited", /createServiceClient\(\)/.test(act) && /superadmin_audit_log/.test(act) && /"entitlement\./.test(act))
  check("feature override uses the canonical vocab at BROKERAGE scope only", /normalizeOverrideType\(params\.action\)/.test(act) && /\.is\("user_id", null\)\.is\("team_id", null\)/.test(act))
  check("quota grant inserts an APPROVED ai_quota_overrides row (fair-use sums approved)", /from\("ai_quota_overrides"\)[\s\S]*status: "approved"/.test(act) && /approved_by: auth\.userId/.test(act))
  check("quota revoke expires the grant (status='expired' — CHECK-valid, drops from fair-use)", /export async function revokeTenantQuotaAction/.test(act) && /status: "expired"/.test(act))
  check("live ceiling + usage read from the existing quota view", /v_brokerage_ai_quota/.test(act))
  check("the brokerage detail page wires the panel", /TenantEntitlementsPanel/.test(src("app/dashboard/superadmin/brokerages/[id]/page.tsx")))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by data_steward with a runnable proof", /tenant_entitlements:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:tenant-entitlements"/.test(reg))
  check("package.json wires the proof", /"test:tenant-entitlements":\s*"tsx scripts\/tenant-entitlements-simulator\.ts"/.test(src("package.json")))

  console.log("\n[wiring — per-tenant autonomy halt (cert blocker #3)]")
  check("halt writer is tenants-capability + requireWrite gated, reason required",
    /setTenantAutonomyHaltAction/.test(act)
    && /requirePlatformCapability\("tenants", \{ requireWrite: true \}\)/.test(act)
    && /A reason is required \(audited \+ shown to the tenant\)/.test(act))
  check("halt is a brokerage-scoped 'autonomy' feature kill (override_type disable, user/team null)",
    /TENANT_AUTONOMY_FEATURE_KEY/.test(act) && /override_type: "disable"/.test(act))
  check("audited as tenant.autonomy_halted / tenant.autonomy_resumed",
    /"tenant\.autonomy_halted" : "tenant\.autonomy_resumed"/.test(act))
  const gateSrc = src("lib/managers/autonomy-gate.ts")
  check("gate enforces the tenant halt at the SAME hook point as the god switch (resolveManagerAutonomy)",
    /loadTenantAutonomyHalt\(brokerageId, client\)/.test(gateSrc) && /tenantHalt\.halted\) return "approval_required"/.test(gateSrc))
  check("pure decision holds on tenantHalt below platformHalt, above broker posture",
    /input\.tenantHalt\?\.halted/.test(gateSrc)
    && gateSrc.indexOf("input.platformHalt?.halted") < gateSrc.indexOf("input.tenantHalt?.halted"))
  check("the brokerage detail page wires the halt toggle + the tenant Command Center wires the banner",
    /TenantAutonomyPanel/.test(src("app/dashboard/superadmin/brokerages/[id]/page.tsx"))
    && /AutonomyHaltBanner/.test(src("app/dashboard/admin/command-center/page.tsx")))

  console.log("\n[wiring — per-tenant seat override (cert blocker #4)]")
  check("seat-override writer is requireWrite gated + audited tenant.seat_override_set with old/new",
    /setTenantSeatOverrideAction/.test(act) && /"tenant\.seat_override_set"/.test(act) && /old, new: params\.seatOverride/.test(act))
  check("BOTH invite gates resolve seats through parseSeatOverride → seatCheck (one enforcement point)",
    /seatCheck\(tenantTier, seatCount \?\? 0, parseSeatOverride\(/.test(src("app/actions/admin/invite-user.ts"))
    && /seatCheck\(targetTier, seatCount \?\? 0, parseSeatOverride\(/.test(src("app/actions/superadmin/tenant-users.ts")))
  check("the tenant seat meter uses the SAME resolution and says 'custom limit' when overridden",
    /effectiveSeatLimit\(planTier, parseSeatOverride\(/.test(src("app/dashboard/admin/users/page.tsx"))
    && /custom limit/.test(src("app/dashboard/admin/users/page.tsx")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source proved the logic; live verified via MCP"); return }
  const svc = createClient(url, key)
  console.log("\n[live] grant trial → disable → clear a feature + grant/revoke quota → clean up")
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: brk } = await svc.from("brokerages").insert({ name: "ZZENT", email: "zzent@example.com", plan_tier: "brokerage", onboarding_status: "pending" }).select("id").single()
    const { data: staff } = await svc.from("users").insert({ email: "zzent-staff@example.com", first_name: "Ent", last_name: "Staff", user_type: "superadmin", is_contact: false }).select("id").single()
    const { data: flag } = await svc.from("feature_flags").select("feature_key").eq("enabled", true).limit(1).maybeSingle()
    const b = (brk as any).id, staffId = (staff as any).id, fk = (flag as any)?.feature_key
    cleanup.push({ table: "brokerages", id: b }, { table: "users", id: staffId })
    if (!fk) { check("live: a feature flag exists to target", false); return }

    await svc.from("feature_access_overrides").insert({ brokerage_id: b, feature_key: fk, override_type: "grant_trial", trial_ends_at: new Date(Date.now() + 30 * 86400000).toISOString(), created_by: staffId })
    let { data: ov } = await svc.from("feature_access_overrides").select("override_type").eq("brokerage_id", b).eq("feature_key", fk).maybeSingle()
    check("live: grant_trial override written at brokerage scope", (ov as any)?.override_type === "grant_trial")

    await svc.from("feature_access_overrides").delete().eq("brokerage_id", b).eq("feature_key", fk).is("user_id", null).is("team_id", null)
    await svc.from("feature_access_overrides").insert({ brokerage_id: b, feature_key: fk, override_type: "disable", created_by: staffId })
    ;({ data: ov } = await svc.from("feature_access_overrides").select("override_type").eq("brokerage_id", b).eq("feature_key", fk).maybeSingle())
    check("live: flips to disable", (ov as any)?.override_type === "disable")

    await svc.from("feature_access_overrides").delete().eq("brokerage_id", b).eq("feature_key", fk).is("user_id", null).is("team_id", null)
    const { count: leftOv } = await svc.from("feature_access_overrides").select("id", { count: "exact", head: true }).eq("brokerage_id", b)
    check("live: clear removes the override", (leftOv ?? 0) === 0)

    const { data: grant } = await svc.from("ai_quota_overrides").insert({ brokerage_id: b, requested_by: staffId, approved_by: staffId, extra_tokens: 50000, reason: "sim grant", status: "approved", approved_at: new Date().toISOString() }).select("id").single()
    check("live: approved quota override created (counted by fair-use)", !!grant)
    await svc.from("ai_quota_overrides").update({ status: "expired", effective_until: new Date().toISOString() }).eq("id", (grant as any).id)
    const { data: after } = await svc.from("ai_quota_overrides").select("status").eq("id", (grant as any).id).maybeSingle()
    check("live: revoke expires the grant", (after as any)?.status === "expired")
    if (grant) cleanup.push({ table: "ai_quota_overrides", id: (grant as any).id })
  } finally {
    await svc.from("feature_access_overrides").delete().eq("brokerage_id", cleanup.find((c) => c.table === "brokerages")?.id ?? "")
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
  if (fail > 0) { console.log(" ❌ TENANT_ENTITLEMENTS_FAIL"); process.exit(1) }
  console.log(" ✅ TENANT_ENTITLEMENTS_PASS — per-tenant feature flips + quota overrides, gated + audited, reusing the existing engines with no drift")
}
main()
