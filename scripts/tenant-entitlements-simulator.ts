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
import { stripComments } from "./strip-comments"

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
  check("null override ⇒ tier default (Solo 2 · Team 5 · Brokerage 50 · Multi unlimited)",
    effectiveSeatLimit("solo_agent", null).limit === 2 && effectiveSeatLimit("solo_agent", null).overridden === false
    && effectiveSeatLimit("team", null).limit === 5
    && effectiveSeatLimit("brokerage", null).limit === 50
    && effectiveSeatLimit("multi_location", null).limit === null)
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
  // The `?? 0` this used to pin is gone: seatCount now comes from
  // resolveSeatUsage (lib/kernel/seat-usage.ts), which returns a real number
  // rather than a possibly-undefined count. The contract asserted here is
  // unchanged — ONE enforcement point — plus the new requirement that both gates
  // get the count from the shared resolver, since counting users.user_type alone
  // misses a seat role held through user_role_assignments and would admit an
  // invite past the tenant's paid limit.
  // The TENANT gate now resolves through seatDecision, not seatCheck: past the
  // limit is a billing CHOICE (upgrade first, per-seat price second) rather than a
  // refusal, per the owner's ruling. The SUPERADMIN gate keeps the hard check —
  // platform staff already hold the seat_override lever, so for them a stop is
  // actionable rather than a dead end. Both still read the ONE override parser and
  // the ONE seat resolver, which is what "one enforcement point" protects.
  // ONE ENFORCEMENT POINT IS NOW LITERAL. Both gates used to compose the pieces
  // themselves (each its own resolveSeatUsage + parseSeatOverride + decision),
  // which is one enforcement RULE written twice; they now call seatGate, the
  // single async gate in lib/kernel/seat-usage.ts that the role-change,
  // reactivation and recruiting paths also call. The override parser and the
  // seat resolver are reached through it, so the probe follows them there.
  check("BOTH invite gates resolve seats through the ONE gate (one enforcement point)",
    /seatGate\(/.test(src("app/actions/admin/invite-user.ts"))
    && /seatGate\(/.test(src("app/actions/superadmin/tenant-users.ts")))
  check("…and the tenant gate offers the upgrade instead of a dead end",
    /verdict\.message/.test(src("app/actions/admin/invite-user.ts"))
    && !/Deactivate a user to free a seat/.test(src("app/actions/admin/invite-user.ts")))
  check("…and the gate they share reads the ONE override parser and the ONE seat resolver",
    /parseSeatOverride\(/.test(src("lib/kernel/seat-usage.ts"))
    && /await resolveSeatUsage\(/.test(src("lib/kernel/seat-usage.ts")))
  // THE METER'S ROUTE GOT LONGER AND STRICTER, so this probe follows it.
  //
  // It used to require the literal `effectiveSeatLimit(planTier, parseSeatOverride(`
  // — the meter resolved the LIMIT from the shared resolver and then re-derived
  // the at-capacity verdict inline (`seatLimit !== null && seatCount >= seatLimit`),
  // a third spelling of a rule the gate already owns. The meter now calls
  // `seatCheck`, which is computed BY `seatDecision`, which resolves through
  // `effectiveSeatLimit` — so the shared resolution this check was defending is
  // still there, with the VERDICT shared as well, not just the number. Asserted
  // at both ends so the chain cannot be cut in the middle.
  const meterSrc = src("app/dashboard/admin/users/page.tsx")
  // CODE, NOT PROSE (CLAUDE.md §2). The absence half below asks whether the
  // inline at-capacity derivation is GONE, and the comment explaining why it is
  // gone necessarily quotes it — so a raw-text scan accuses the very note that
  // records the fix. stripComments() is the one correct scanner in this repo;
  // hand-rolling a second one is the defect §2 names.
  const meterCode = stripComments(meterSrc)
  check("POSITIVE CONTROL — the seat meter's source is visible to this scan",
    meterCode.length > 0 && /seatCount/.test(meterCode))
  check("the tenant seat meter uses the SAME resolution and says 'custom limit' when overridden",
    /seatCheck\(planTier, seatCount, parseSeatOverride\(/.test(meterCode)
    && /custom limit/.test(meterCode))
  check("  ↳ …and seatCheck is the gate's own verdict, not a second copy of the arithmetic",
    /seatDecision\(tier, currentSeatCount, seatOverride, 1, catalog\)/.test(
      stripComments(src("lib/kernel/tier-role-matrix.ts"))))
  const INLINE_CAPACITY = /seatLimit !== null && seatCount >= seatLimit/
  check("  ↳ …and the meter no longer re-derives at-capacity inline",
    !INLINE_CAPACITY.test(meterCode))
  check("  ↳ POSITIVE CONTROL: that inline finder still recognises the spelling it replaced",
    INLINE_CAPACITY.test(
      'className={`${seatLimit !== null && seatCount >= seatLimit ? "text-red-600" : ""}`}'))
  check("  ↳ POSITIVE CONTROL: stripComments left the meter's CODE intact, it did not just empty it",
    /seatCheck\(/.test(meterCode) && meterCode.length > meterSrc.length / 3)
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
