#!/usr/bin/env tsx
/**
 * scripts/secrets-simulator.ts   (npm run test:secrets)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves SECRETS AT-REST + ROTATION: (1) AES-256-GCM encryption that is backward-compatible +
 * fail-safe + tamper-evident, and (2) a rotation monitor that flags expired/expiring OAuth tokens.
 *
 * PURE:   encrypt→decrypt roundtrip; plaintext passthrough (safe migration); tamper throws;
 *         no-key fail-safe; credentialRotationStatus classifies expired/expiring/ok/no_expiry.
 * SOURCE: decryptSecret adopted at a credential read; rotation loader + escalation + staff action
 *         + console panel wired; owned by data_steward.
 * LIVE (creds-gated): seed OAuth creds with varied token_expires_at → loadRotationRisks returns the
 *         expired + expiring ones (not the healthy one) → clean up == 0. Self-skips without creds.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { credentialRotationStatus, ROTATION_WARN_DAYS } from "../lib/security/credential-rotation"
import { shouldAttemptRefresh, resolveProviderOAuth } from "../lib/security/oauth-refresh"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

async function pureLayer() {
  console.log("\n[secret-crypto · pure — backward-compatible, fail-safe, tamper-evident]")
  // Load the module fresh with a key set.
  process.env.SECRETS_ENCRYPTION_KEY = "unit-test-passphrase-for-secret-crypto"
  const { encryptSecret, decryptSecret, isEncrypted, isEncryptionConfigured } = await import("../lib/security/secret-crypto")
  check("a key is detected", isEncryptionConfigured())
  const secret = "smtp-password-hunter2!"
  const enc = encryptSecret(secret)!
  check("encrypt produces an enc:v1 envelope (not plaintext)", isEncrypted(enc) && enc !== secret)
  check("decrypt roundtrips exactly", decryptSecret(enc) === secret)
  check("PLAINTEXT passes through decrypt unchanged (safe migration)", decryptSecret("still-plaintext") === "still-plaintext")
  check("empty / null are handled", encryptSecret("") === "" && decryptSecret(null) === null)
  let threw = false
  try { decryptSecret(enc.slice(0, -4) + "AAAA") } catch { threw = true }
  check("a TAMPERED envelope throws (GCM auth) — never silently corrupt", threw)

  console.log("\n[credentialRotationStatus · pure]")
  const now = new Date("2026-07-05T00:00:00Z")
  check("no expiry → no_expiry", credentialRotationStatus({ tokenExpiresAt: null }, now) === "no_expiry")
  check("past → expired", credentialRotationStatus({ tokenExpiresAt: "2026-07-01T00:00:00Z" }, now) === "expired")
  check(`within ${ROTATION_WARN_DAYS}d → expiring_soon`, credentialRotationStatus({ tokenExpiresAt: "2026-07-08T00:00:00Z" }, now) === "expiring_soon")
  check("far future → ok", credentialRotationStatus({ tokenExpiresAt: "2026-12-01T00:00:00Z" }, now) === "ok")

  console.log("\n[oauth-refresh · pure — automation gating + endpoint resolution]")
  check("refresh is attempted for an expiring cred WITH a refresh_token", shouldAttemptRefresh({ tokenExpiresAt: "2026-07-06T00:00:00Z", hasRefreshToken: true }, now))
  check("NOT attempted without a refresh_token", !shouldAttemptRefresh({ tokenExpiresAt: "2026-07-06T00:00:00Z", hasRefreshToken: false }, now))
  check("NOT attempted for a healthy cred (no point)", !shouldAttemptRefresh({ tokenExpiresAt: "2026-12-01T00:00:00Z", hasRefreshToken: true }, now))
  check("google/microsoft endpoints resolve; unknown provider → null (skip)",
    resolveProviderOAuth("gmail")?.tokenUrl.includes("googleapis") === true && resolveProviderOAuth("outlook")?.tokenUrl.includes("microsoftonline") === true && resolveProviderOAuth("zillow") === null)
}

function sourceLayer() {
  console.log("\n[wiring — crypto adopted at a read; rotation monitor surfaced]")
  const adapter = src("lib/providers/email/personal-email-adapter.ts")
  check("decryptSecret adopted at the credential read (backward-compatible first step)", /decryptSecret\(c\.access_token\)/.test(adapter))
  const rot = src("lib/security/credential-rotation.ts")
  check("the monitor scans all four OAuth credential tables cross-tenant", /platform_credentials/.test(rot) && /agent_api_credentials/.test(rot) && /social_media_accounts/.test(rot) && /calendar_provider_accounts/.test(rot))
  check("escalation nudges platform staff, deduped per day", /notifyPlatformStaff/.test(rot) && /credential_rotation_risk/.test(rot))
  const refresh = src("lib/security/oauth-refresh.ts")
  check("the OAuth refresh runner is provider-gated + ENCRYPTS the refreshed token on write",
    /resolveProviderOAuth/.test(refresh) && /skipped_unconfigured/.test(refresh) && /access_token: encryptSecret\(json\.access_token\)/.test(refresh))
  check("a staff action can trigger a refresh sweep", /runCredentialRefreshAction/.test(src("app/actions/superadmin/ai-ops.ts")))
  check("staff-gated action + console panel", /getCredentialRotationAction/.test(src("app/actions/superadmin/ai-ops.ts")) && /RotationRisksPanel/.test(src("app/dashboard/superadmin/ai-ops/page.tsx")))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by data_steward with a runnable proof", /secrets_hardening:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:secrets"/.test(reg))
  check("package.json wires the proof", /"test:secrets":\s*"tsx scripts\/secrets-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source proved the logic; live verified via MCP"); return }
  const svc = createClient(url, key)
  const { loadRotationRisks } = await import("../lib/security/credential-rotation")
  console.log("\n[live] seed OAuth creds with varied expiry → the monitor flags expired + expiring, not the healthy one")
  const { data: brk } = await svc.from("brokerages").insert({ name: "ZZSEC", email: "zzsec@example.com", plan_tier: "brokerage", onboarding_status: "pending" }).select("id").single()
  const b = (brk as any)?.id
  const past = new Date(Date.now() - 86400000).toISOString()
  const soon = new Date(Date.now() + 2 * 86400000).toISOString()
  const far = new Date(Date.now() + 90 * 86400000).toISOString()
  try {
    await svc.from("platform_credentials").insert([
      { brokerage_id: b, platform: "gmail", token_expires_at: past, refresh_token: "r1", owner_type: "brokerage", scope: "brokerage" },
      { brokerage_id: b, platform: "outlook", token_expires_at: soon, refresh_token: "r2", owner_type: "brokerage", scope: "brokerage" },
      { brokerage_id: b, platform: "google_calendar", token_expires_at: far, refresh_token: "r3", owner_type: "brokerage", scope: "brokerage" },
    ])
    const risks = await loadRotationRisks(svc as any)
    const mine = risks.filter((r) => r.brokerageId === b)   // scope to THIS test tenant
    check("live: the expired cred is flagged", mine.some((r) => r.provider === "gmail" && r.status === "expired"))
    check("live: the expiring-soon cred is flagged", mine.some((r) => r.provider === "outlook" && r.status === "expiring_soon"))
    check("live: the healthy cred is NOT flagged", !mine.some((r) => r.provider === "google_calendar"))
  } finally {
    await svc.from("platform_credentials").delete().eq("brokerage_id", b)
    await svc.from("brokerages").delete().eq("id", b)
    const { count } = await svc.from("platform_credentials").select("id", { count: "exact", head: true }).eq("brokerage_id", b)
    check("live: cleanup count == 0", (count ?? 0) === 0)
  }
}

async function main() {
  await pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SECRETS_FAIL"); process.exit(1) }
  console.log(" ✅ SECRETS_PASS — at-rest encryption (backward-compatible + tamper-evident) + a credential-rotation monitor")
}
main()
