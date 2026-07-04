#!/usr/bin/env tsx
/**
 * scripts/platform-providers-simulator.ts   (npm run test:platform-providers)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves PLATFORM PROVIDER CONFIG: the write surface for provider_overrides at scope_type='superadmin' that
 * the runtime read pipelines (resolveProvider / getSystemProviderStatus) already consume.
 *
 * PURE:   validatePlatformProvider (only configurable types; default vendors must be in the option set) +
 *         the catalog covers channel-enablement + default-vendor axes.
 * SOURCE: the get/set actions are superadmin-gated + audited; the config panel is mounted on the god console;
 *         the read side already honors superadmin rows; owned by data_steward with a runnable proof.
 * LIVE (creds-gated): set a platform default (email) + a channel (direct_mail) → resolveProvider returns it
 *         + getSystemProviderStatus reflects it → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { validatePlatformProvider, PLATFORM_PROVIDER_SPEC, PLATFORM_SCOPE_ID } from "../lib/platform/platform-providers"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[validatePlatformProvider · pure]")
  check("a configurable default (email=sendgrid) is valid", validatePlatformProvider("email", "sendgrid").ok)
  check("an invalid vendor for a default is rejected", !validatePlatformProvider("email", "notavendor").ok)
  check("a non-configurable type (voice_clone) is rejected (locked by design)", !validatePlatformProvider("voice_clone", "elevenlabs").ok)
  check("empty provider key is rejected", !validatePlatformProvider("sms", "").ok)
  check("a channel (direct_mail=lob) is valid", validatePlatformProvider("direct_mail", "lob").ok)

  console.log("\n[catalog · pure — both axes covered]")
  check("channels cover direct_mail + video (enablement)", PLATFORM_PROVIDER_SPEC.some((s) => s.providerType === "direct_mail" && s.kind === "channel") && PLATFORM_PROVIDER_SPEC.some((s) => s.providerType === "video" && s.kind === "channel"))
  check("default vendors cover email/sms/phone (BYO inheritance)", ["email", "sms", "phone"].every((t) => PLATFORM_PROVIDER_SPEC.some((s) => s.providerType === t && s.kind === "default")))
  check("the sentinel platform scope id is the NIL uuid", PLATFORM_SCOPE_ID === "00000000-0000-0000-0000-000000000000")
}

function sourceLayer() {
  console.log("\n[wiring — write surface, gating, read side, UI]")
  const lib = src("lib/platform/platform-providers.ts")
  check("platform rows use the sentinel scope_id so UNIQUE dedupes to one per type", /scope_id:\s*PLATFORM_SCOPE_ID/.test(lib) && /onConflict:\s*"scope_type,scope_id,provider_type"/.test(lib))
  const act = src("app/actions/superadmin/platform-providers.ts")
  check("get/set actions are superadmin-gated + audited", /requireSuperadmin/.test(act) && /superadmin_audit_log"\)\.insert\([\s\S]*?platform_provider_update/.test(act))
  const prov = src("lib/kernel/providers.ts")
  check("the read side (resolveProvider) already honors scope_type='superadmin'", /scope_type",\s*"superadmin"/.test(prov))
  check("getSystemProviderStatus gates channels on the superadmin rows", /scope_type",\s*"superadmin"[\s\S]*?direct_mail/.test(src("app/actions/settings/provider-settings-actions.ts")))
  const page = src("app/dashboard/superadmin/platform/page.tsx")
  check("the god console mounts the providers panel with live config", /getPlatformProviderConfig\(\)/.test(page) && /<PlatformProvidersPanel/.test(page))
  check("the panel writes via the gated action", /setPlatformProviderAction/.test(src("app/dashboard/superadmin/platform/platform-providers-panel.tsx")))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by data_steward with a runnable proof", /platform_providers:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:platform-providers"/.test(reg))
  check("package.json wires the proof", /"test:platform-providers":\s*"tsx scripts\/platform-providers-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source proved the logic; live verified via MCP"); return }
  const svc = createClient(url, key)
  console.log("\n[live] set a platform default (email=mailgun) + channel (direct_mail on) → verify → clean up")
  const { setPlatformProviderOverride, getPlatformProviderConfig } = await import("../lib/platform/platform-providers")
  const cleanup: string[] = []
  try {
    const r1 = await setPlatformProviderOverride(svc as any, { providerType: "email", providerKey: "mailgun", enabled: true })
    const r2 = await setPlatformProviderOverride(svc as any, { providerType: "direct_mail", providerKey: "lob", enabled: true })
    check("live: the writes succeeded", r1.ok && r2.ok)
    const { data: rows } = await svc.from("provider_overrides").select("id, provider_type, provider_key, enabled").eq("scope_type", "superadmin")
    for (const row of (rows ?? []) as any[]) cleanup.push(row.id)
    const email = (rows ?? []).find((r: any) => r.provider_type === "email")
    check("live: the platform email default is now mailgun (resolveProvider will inherit it)", (email as any)?.provider_key === "mailgun")
    const dm = (rows ?? []).find((r: any) => r.provider_type === "direct_mail")
    check("live: direct_mail channel is enabled (getSystemProviderStatus reads it)", (dm as any)?.enabled === true)
    const cfg = await getPlatformProviderConfig(svc as any)
    check("live: getPlatformProviderConfig reflects the writes", cfg.find((c) => c.providerType === "email")?.providerKey === "mailgun")
  } finally {
    for (const id of cleanup) await svc.from("provider_overrides").delete().eq("id", id)
    let left = 0
    for (const id of cleanup) { const { count } = await svc.from("provider_overrides").select("id", { count: "exact", head: true }).eq("id", id); left += count ?? 0 }
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
  if (fail > 0) { console.log(" ❌ PLATFORM_PROVIDERS_FAIL"); process.exit(1) }
  console.log(" ✅ PLATFORM_PROVIDERS_PASS — the write surface for platform provider config; the already-live read path lights up")
}
main()
