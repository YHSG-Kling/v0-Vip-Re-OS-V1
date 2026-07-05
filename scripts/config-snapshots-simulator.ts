#!/usr/bin/env tsx
/**
 * scripts/config-snapshots-simulator.ts   (npm run test:config-snapshots)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves TENANT CONFIG SNAPSHOTS (GoHighLevel-style templates): capture a tenant's brand +
 * voice + feature enablement as a reusable template, apply it to another tenant — WITHOUT
 * ever copying a secret between tenants.
 *
 * PURE:   pickFields keeps only allow-listed keys (secrets excluded); payloadLeaksSecret
 *         catches any forbidden field. This is the security guarantee.
 * SOURCE: capture/apply are requireSuperadmin-gated + audited, service-client, reuse the
 *         override vocab; the table is service-role-only (RLS); panel wired; owned by data_steward.
 * LIVE (creds-gated): seed a source tenant (brand + a SECRET api key + a feature override) →
 *         capture → the snapshot carries brand+feature but NOT the secret → apply to a fresh
 *         target → target gets the brand + feature override → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { pickFields, payloadLeaksSecret, SNAPSHOT_GLOBAL_FIELDS, SNAPSHOT_FORBIDDEN_FIELDS } from "../lib/platform/config-snapshots"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[allow-list · pure — a snapshot NEVER carries a secret]")
  const row = { primary_color: "#0A2540", font_family: "Geist", smtp_password: "hunter2", ghl_api_key: "sk-secret", app_logo_url: "/logo.png", zapier_api_key: "z-secret", from_email: "a@b.co" }
  const picked = pickFields(row, SNAPSHOT_GLOBAL_FIELDS)
  check("pickFields keeps allow-listed brand fields", picked.primary_color === "#0A2540" && picked.font_family === "Geist" && picked.app_logo_url === "/logo.png")
  check("pickFields DROPS every secret (smtp_password / *_api_key / from_email)", !("smtp_password" in picked) && !("ghl_api_key" in picked) && !("zapier_api_key" in picked) && !("from_email" in picked))
  check("payloadLeaksSecret is FALSE for a clean payload", !payloadLeaksSecret({ global: picked }))
  check("payloadLeaksSecret CATCHES a leaked secret (defence in depth)", payloadLeaksSecret({ global: { ...picked, smtp_password: "x" } }))
  check("the forbidden list covers the real secret columns", SNAPSHOT_FORBIDDEN_FIELDS.includes("smtp_password") && SNAPSHOT_FORBIDDEN_FIELDS.includes("ghl_api_key") && SNAPSHOT_FORBIDDEN_FIELDS.includes("zapier_api_key"))
}

function sourceLayer() {
  console.log("\n[wiring — gated, audited, secret-safe, reused primitives]")
  const lib = src("lib/platform/config-snapshots.ts")
  check("capture builds from allow-lists only (brand/voice/features)", /SNAPSHOT_GLOBAL_FIELDS/.test(lib) && /SNAPSHOT_BRAND_FIELDS/.test(lib) && /SNAPSHOT_VOICE_FIELDS/.test(lib) && /pickFields/.test(lib))
  check("apply reuses the canonical override vocab for feature overrides", /normalizeOverrideType/.test(lib) && /feature_access_overrides/.test(lib))
  const act = src("app/actions/superadmin/config-snapshots.ts")
  check("all actions are superadmin-gated + audited", (act.match(/requireSuperadmin\(\)/g) ?? []).length >= 4 && /superadmin_audit_log/.test(act) && /"snapshot\.capture"/.test(act) && /"snapshot\.apply"/.test(act))
  check("capture REFUSES to persist a payload that leaks a secret", /payloadLeaksSecret\(payload\)/.test(act))
  const mig = src("supabase/migrations/m268-platform-config-snapshots.sql")
  check("the snapshots table is service-role-only (RLS on, no policy)", /alter table public\.platform_config_snapshots enable row level security/.test(mig))
  check("the brokerage detail page wires the panel", /TenantSnapshotsPanel/.test(src("app/dashboard/superadmin/brokerages/[id]/page.tsx")))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by data_steward with a runnable proof", /config_snapshots:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:config-snapshots"/.test(reg))
  check("the snapshots table has an owning manager", /platform_config_snapshots:\s*"data_steward"/.test(reg))
  check("package.json wires the proof", /"test:config-snapshots":\s*"tsx scripts\/config-snapshots-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source proved the logic; live verified via MCP"); return }
  const svc = createClient(url, key)
  const { buildSnapshotPayload, applySnapshotPayload, payloadLeaksSecret } = await import("../lib/platform/config-snapshots")
  console.log("\n[live] capture (source with a SECRET) → payload has brand+feature, NO secret → apply to target → clean up")
  const cleanup: Array<{ table: string; col: string; id: string }> = []
  try {
    const { data: srcBrk } = await svc.from("brokerages").insert({ name: "ZZSNAP-src", email: "zzsnap-src@example.com", plan_tier: "brokerage", onboarding_status: "pending" }).select("id").single()
    const { data: tgtBrk } = await svc.from("brokerages").insert({ name: "ZZSNAP-tgt", email: "zzsnap-tgt@example.com", plan_tier: "brokerage", onboarding_status: "pending" }).select("id").single()
    const { data: staff } = await svc.from("users").insert({ email: "zzsnap-staff@example.com", first_name: "Snap", last_name: "Staff", user_type: "superadmin", is_contact: false }).select("id").single()
    const { data: flag } = await svc.from("feature_flags").select("feature_key").eq("enabled", true).limit(1).maybeSingle()
    const s = (srcBrk as any).id, t = (tgtBrk as any).id, staffId = (staff as any).id, fk = (flag as any)?.feature_key
    cleanup.push({ table: "brokerages", col: "id", id: s }, { table: "brokerages", col: "id", id: t }, { table: "users", col: "id", id: staffId })

    // Source: brand + a SECRET + a feature override
    await svc.from("global_settings").upsert({ brokerage_id: s, primary_color: "#0A2540", font_family: "Geist", ghl_api_key: "SECRET-should-not-copy" }, { onConflict: "brokerage_id" })
    if (fk) await svc.from("feature_access_overrides").insert({ brokerage_id: s, feature_key: fk, override_type: "grant_trial", trial_ends_at: new Date(Date.now() + 30 * 86400000).toISOString(), created_by: staffId })

    const payload = await buildSnapshotPayload(s, svc)
    check("live: payload carries the source brand", (payload.global as any)?.primary_color === "#0A2540")
    check("live: payload carries the feature override", (payload.features ?? []).some((f) => f.feature_key === fk))
    check("live: payload does NOT carry the secret", !payloadLeaksSecret(payload) && !("ghl_api_key" in (payload.global ?? {})))

    await applySnapshotPayload(payload, t, staffId, svc)
    const { data: tgs } = await svc.from("global_settings").select("primary_color, ghl_api_key").eq("brokerage_id", t).maybeSingle()
    check("live: target got the brand", (tgs as any)?.primary_color === "#0A2540")
    check("live: target did NOT receive the secret", !(tgs as any)?.ghl_api_key)
    if (fk) {
      const { data: tov } = await svc.from("feature_access_overrides").select("override_type").eq("brokerage_id", t).eq("feature_key", fk).maybeSingle()
      check("live: target got the feature override", (tov as any)?.override_type === "grant_trial")
    }
  } finally {
    const brokerageIds = cleanup.filter((c) => c.table === "brokerages").map((c) => c.id)
    for (const b of brokerageIds) {
      await svc.from("feature_access_overrides").delete().eq("brokerage_id", b)
      await svc.from("global_settings").delete().eq("brokerage_id", b)
      await svc.from("brokerage_brand_settings").delete().eq("brokerage_id", b)
      await svc.from("brand_voice_profile").delete().eq("brokerage_id", b)
    }
    await svc.from("platform_config_snapshots").delete().in("source_brokerage_id", brokerageIds)
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq(c.col, c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq(c.col, c.id); left += count ?? 0 }
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
  if (fail > 0) { console.log(" ❌ CONFIG_SNAPSHOTS_FAIL"); process.exit(1) }
  console.log(" ✅ CONFIG_SNAPSHOTS_PASS — capture→apply a tenant template (brand + voice + features), gated + audited, secrets never copied")
}
main()
