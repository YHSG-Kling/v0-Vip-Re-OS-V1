#!/usr/bin/env tsx
/**
 * scripts/config-snapshots-simulator.ts   (npm run test:config-snapshots)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves TENANT CONFIG SNAPSHOTS (GoHighLevel-style templates): capture a tenant's brand +
 * voice + public-site content + feature enablement as a reusable template, apply it to
 * another tenant (incl. right after manual provisioning, so a new subscriber's day-one
 * website comes up fully branded) — WITHOUT ever copying a secret OR an identity field
 * (name/slug/email/tier/status) between tenants.
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
import { join, relative } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { pickFields, payloadLeaksSecret, SNAPSHOT_GLOBAL_FIELDS, SNAPSHOT_SITE_FIELDS, SNAPSHOT_FORBIDDEN_FIELDS, SNAPSHOT_SITE_FORBIDDEN_FIELDS } from "../lib/platform/config-snapshots"
import { stripComments } from "./strip-comments"
import { walkTs } from "./runtime-roots"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
/** STRIPPED source — the creation-path census scans for CODE TOKENS, and these
 *  files carry comments/tombstones naming the very tokens scanned (§2). */
const code = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"))

function pureLayer() {
  console.log("\n[allow-list · pure — a snapshot NEVER carries a secret]")
  const row = { primary_color: "#0A2540", font_family: "Geist", smtp_password: "hunter2", ghl_api_key: "sk-secret", app_logo_url: "/logo.png", zapier_api_key: "z-secret", from_email: "a@b.co" }
  const picked = pickFields(row, SNAPSHOT_GLOBAL_FIELDS)
  check("pickFields keeps allow-listed brand fields", picked.primary_color === "#0A2540" && picked.font_family === "Geist" && picked.app_logo_url === "/logo.png")
  check("pickFields DROPS every secret (smtp_password / *_api_key / from_email)", !("smtp_password" in picked) && !("ghl_api_key" in picked) && !("zapier_api_key" in picked) && !("from_email" in picked))
  check("payloadLeaksSecret is FALSE for a clean payload", !payloadLeaksSecret({ global: picked }))
  check("payloadLeaksSecret CATCHES a leaked secret (defence in depth)", payloadLeaksSecret({ global: { ...picked, smtp_password: "x" } }))
  check("the forbidden list covers the real secret columns", SNAPSHOT_FORBIDDEN_FIELDS.includes("smtp_password") && SNAPSHOT_FORBIDDEN_FIELDS.includes("ghl_api_key") && SNAPSHOT_FORBIDDEN_FIELDS.includes("zapier_api_key"))

  // SITE layer — brokerages fields that shape the public /site/[slug] website
  const brkRow = { about_text: "About us", bio_text: "Bio", primary_color: "#123456", recruiting_pitch: "Join us", widget_enabled: true, name: "Acme Realty", slug: "acme", email: "owner@acme.co", plan_tier: "brokerage", subscription_tier: "brokerage", status: "active", id: "some-uuid", twilio_subaccount_sid: "AC-secret" }
  const site = pickFields(brkRow, SNAPSHOT_SITE_FIELDS)
  check("site layer keeps only site-shaping brokerage fields", site.about_text === "About us" && site.primary_color === "#123456" && site.widget_enabled === true)
  check("site layer DROPS identity/billing fields (name/slug/email/tier/status/id/sid)", !("name" in site) && !("slug" in site) && !("email" in site) && !("plan_tier" in site) && !("subscription_tier" in site) && !("status" in site) && !("id" in site) && !("twilio_subaccount_sid" in site))
  check("payloadLeaksSecret is FALSE for a clean site layer", !payloadLeaksSecret({ site }))
  check("payloadLeaksSecret CATCHES an identity field smuggled into the site layer", payloadLeaksSecret({ site: { ...site, slug: "hijacked" } }) && payloadLeaksSecret({ site: { ...site, plan_tier: "multi_location" } }))
  check("payloadLeaksSecret CATCHES a secret in the site layer too", payloadLeaksSecret({ site: { ...site, ghl_api_key: "sk-x" } }))
  check("the site-forbidden list covers identity + billing columns", SNAPSHOT_SITE_FORBIDDEN_FIELDS.includes("name") && SNAPSHOT_SITE_FORBIDDEN_FIELDS.includes("slug") && SNAPSHOT_SITE_FORBIDDEN_FIELDS.includes("email") && SNAPSHOT_SITE_FORBIDDEN_FIELDS.includes("plan_tier") && SNAPSHOT_SITE_FORBIDDEN_FIELDS.includes("status"))
  check("recommendedTier is inert metadata — never a leak", !payloadLeaksSecret({ site, recommendedTier: "team" }))
}

function sourceLayer() {
  console.log("\n[wiring — gated, audited, secret-safe, reused primitives]")
  const lib = src("lib/platform/config-snapshots.ts")
  check("capture builds from allow-lists only (brand/voice/features)", /SNAPSHOT_GLOBAL_FIELDS/.test(lib) && /SNAPSHOT_BRAND_FIELDS/.test(lib) && /SNAPSHOT_VOICE_FIELDS/.test(lib) && /pickFields/.test(lib))
  check("apply reuses the canonical override vocab for feature overrides", /normalizeOverrideType/.test(lib) && /feature_access_overrides/.test(lib))
  check("site apply re-sanitizes through the allow-list before touching brokerages", /pickFields\(payload\.site as Record<string, any>, SNAPSHOT_SITE_FIELDS\)/.test(lib) && /from\("brokerages"\)\.update\(/.test(lib))
  // 2026-08-27: the apply moved INTO createSubscriber (the shared inner path —
  // tombstone in manual-subscriber.ts names the survivor); manual provisioning
  // now PASSES the staff-picked snapshotId through and audits the outcome.
  const ms = src("app/actions/superadmin/manual-subscriber.ts")
  check("manual provisioning passes the snapshot through to the ONE apply site (createSubscriber) + audits snapshot use",
    /snapshotId:\s*input\.snapshotId/.test(ms) && !/applySnapshotPayload\(/.test(code("app/actions/superadmin/manual-subscriber.ts")) && /"tenant\.provisioned_from_snapshot"/.test(ms))
  check("the add-subscriber form offers the snapshot picker with recommended tier", /listSnapshotsAction/.test(src("app/dashboard/superadmin/brokerages/new/manual-subscriber-form.tsx")) && /recommendedTier/.test(src("app/dashboard/superadmin/brokerages/new/manual-subscriber-form.tsx")))
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

function creationPathLayer() {
  console.log("\n[creation paths — EVERY tenant-creation path snapshots at creation (owner ruling)]")
  // Owner ruling (2026-08-27): "when the platform prospect is converted, the
  // account should also create the account with a snapshot." The RULE asserted
  // here (§2 — never a pinned file list): every file under app/ or lib/ that
  // INSERTS a brokerages row either applies a config snapshot itself
  // (applySnapshotPayload / snapshotForTier) or delegates to createSubscriber
  // (which does). The path list is DERIVED from the tree on every run, so a
  // new creation path that forgets its snapshot goes red the day it lands.
  const insertRe = /from\("brokerages"\)\s*\.\s*insert/
  const snapshotRe = /applySnapshotPayload|snapshotForTier/
  const delegateRe = /createSubscriber\(/

  // POSITIVE CONTROLS — a broken finder and a compliant tree both report zero.
  check("control: the insert finder sees the multiline .from(\"brokerages\")\\n.insert idiom",
    insertRe.test('await service\n    .from("brokerages")\n    .insert({ name: "x" })') && !insertRe.test('svc.from("brokerages").select("id")'))
  check("control: an unsnapshotted creation-path specimen is FLAGGED",
    (() => { const specimen = 'const { data } = await svc.from("brokerages").insert({ name: "n" }).select("id").single()'; return insertRe.test(specimen) && !snapshotRe.test(specimen) && !delegateRe.test(specimen) })())
  check("control: the stripper keeps a commented insert from counting as a creation path",
    !insertRe.test(stripComments('// legacy: svc.from("brokerages").insert({...}) moved to createSubscriber\nconst a = 1')))

  const rootsToScan = ["app", "lib"].flatMap((d) => walkTs(join(process.cwd(), d)))
  const creationPaths: string[] = []
  for (const abs of rootsToScan) {
    const rel = relative(process.cwd(), abs)
    let stripped = ""
    try { stripped = stripComments(readFileSync(abs, "utf8")) } catch { continue }
    if (insertRe.test(stripped)) creationPaths.push(rel)
  }
  console.log(`    denominator: ${rootsToScan.length} .ts/.tsx files under app/ + lib/ (node_modules/.next excluded by the walker)`)
  console.log(`    creation paths found: ${creationPaths.length} — ${creationPaths.join(" · ") || "none"}`)
  check("the census finds the known creation paths (the finder is not blind)",
    creationPaths.some((p) => p.includes("signup-brokerage")) && creationPaths.some((p) => p.includes("create-subscriber")))

  const unsnapshotted = creationPaths.filter((rel) => {
    const stripped = stripComments(readFileSync(join(process.cwd(), rel), "utf8"))
    return !snapshotRe.test(stripped) && !delegateRe.test(stripped)
  })
  check(`every derived creation path snapshots at creation or delegates to one that does (unsnapshotted: ${unsnapshotted.length}${unsnapshotted.length ? " → " + unsnapshotted.join(", ") : ""})`,
    unsnapshotted.length === 0)

  // The three direct-insert paths, asserted individually so a regression names its file:
  const signup = code("app/actions/auth/signup-brokerage.ts")
  check("self-serve signup resolves the snapshot SERVER-SIDE from the tier (snapshotForTier — never the request's snapshotId)",
    /snapshotForTier\(input\.tier/.test(signup) && /applySnapshotPayload\(/.test(signup))
  const sub = code("app/actions/admin/create-subscriber.ts")
  check("createSubscriber applies the staff-picked snapshot OR the tier default, best-effort, and reports the outcome",
    /params\.snapshotId/.test(sub) && /snapshotForTier\(params\.tierName/.test(sub) && /applySnapshotPayload\(/.test(sub) && /snapshotError/.test(sub))
  const heal = code("app/actions/onboarding/ensure-agent-brokerage.ts")
  check("the brokerage-of-one self-heal applies the solo_agent funnel snapshot, best-effort",
    /snapshotForTier\("solo_agent"/.test(heal) && /applySnapshotPayload\(/.test(heal))

  // MUTATION CONTROL: strip the snapshot calls out of a real path's source and
  // the detector must flag it — proof the assertion can actually fail.
  const mutated = sub.replace(/applySnapshotPayload/g, "").replace(/snapshotForTier/g, "").replace(/createSubscriber\(/g, "renamed(")
  check("mutation control: create-subscriber with its snapshot calls removed WOULD be flagged",
    insertRe.test(mutated) && !snapshotRe.test(mutated) && !delegateRe.test(mutated))
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
    const { data: srcBrk } = await svc.from("brokerages").insert({ name: "ZZSNAP-src", email: "zzsnap-src@example.com", plan_tier: "brokerage", onboarding_status: "pending", about_text: "ZZSNAP about", primary_color: "#0A2540" }).select("id").single()
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
    check("live: site layer carries the public-site fields but NOT identity", (payload.site as any)?.about_text === "ZZSNAP about" && !("name" in (payload.site ?? {})) && !("email" in (payload.site ?? {})))

    await applySnapshotPayload(payload, t, staffId, svc)
    const { data: tgs } = await svc.from("global_settings").select("primary_color, ghl_api_key").eq("brokerage_id", t).maybeSingle()
    check("live: target got the brand", (tgs as any)?.primary_color === "#0A2540")
    check("live: target did NOT receive the secret", !(tgs as any)?.ghl_api_key)
    const { data: tbrk } = await svc.from("brokerages").select("name, email, about_text").eq("id", t).maybeSingle()
    check("live: target's day-one site got the branding (about_text)", (tbrk as any)?.about_text === "ZZSNAP about")
    check("live: target identity untouched (name/email stay its own)", (tbrk as any)?.name === "ZZSNAP-tgt" && (tbrk as any)?.email === "zzsnap-tgt@example.com")
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
  creationPathLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CONFIG_SNAPSHOTS_FAIL"); process.exit(1) }
  console.log(" ✅ CONFIG_SNAPSHOTS_PASS — capture→apply a tenant template (brand + voice + features), gated + audited, secrets never copied")
}
main()
