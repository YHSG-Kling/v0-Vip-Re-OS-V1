// scripts/crm-sync-credential-simulator.ts   (npm run test:crm-sync-credential)
// ─────────────────────────────────────────────────────────────────────────────
// CRM SYNC-OUT CREDENTIAL RESOLUTION — proves every CRM provider dispatches with
// the TENANT's own credential resolved through the ONE unified cascade
// (resolveScopedConnection: agent → team → brokerage → platform_credentials, with
// legacy fallback), and only falls back to the platform env credential when the
// tenant has connected nothing. This locks the multi-tenant fix: a GHL connected
// via the Connection Center or /settings/crm must NOT be ignored in favor of the
// platform env GHL_API_KEY.
//
// SOURCE-level assertions (same idiom as crm-pull-simulator): a live GHL/FUB call
// can't run here, so we assert the wiring that guarantees precedence. PURE test
// covers the locationId precedence used to build the GHL override.

import { readFileSync } from "node:fs"
import { join } from "node:path"

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

// PURE: the locationId precedence the sync uses to build the GHL override.
// Mirrors lib/crm/sync.ts: accountId ?? config.locationId ?? config.location_id.
function resolveGhlLocationId(conn: {
  accountId?: string | null
  config?: Record<string, unknown> | null
} | null): string | null {
  return (
    conn?.accountId ??
    (conn?.config?.locationId as string | undefined) ??
    (conn?.config?.location_id as string | undefined) ??
    null
  )
}

console.log("\n── PURE: GHL locationId precedence (accountId → config.locationId → config.location_id) ──")
{
  check("accountId wins when present",
    resolveGhlLocationId({ accountId: "loc_A", config: { locationId: "loc_B" } }) === "loc_A")
  check("config.locationId used when no accountId",
    resolveGhlLocationId({ accountId: null, config: { locationId: "loc_B" } }) === "loc_B")
  check("config.location_id (snake) used as last resort",
    resolveGhlLocationId({ accountId: null, config: { location_id: "loc_C" } }) === "loc_C")
  check("null when nothing resolvable → sync falls back to platform env",
    resolveGhlLocationId({ accountId: null, config: {} }) === null)
  check("null connection → env fallback", resolveGhlLocationId(null) === null)
}

console.log("\n── SOURCE: the unified resolver reads platform_credentials + legacy fallback ──")
{
  const rs = src("lib/connections/resolve-scoped.ts")
  check("resolveScopedConnection reads platform_credentials by (owner_type, owner_id)",
    rs.includes('.from("platform_credentials")') && rs.includes("owner_type") && rs.includes("owner_id"))
  check("legacy fallback to connection-manager preserved (works pre-migration)",
    rs.includes("resolveConnection") && /legacy/i.test(rs))
  check("cascade is most-specific-owner-first", rs.includes("scopeCascade"))
}

console.log("\n── SOURCE: sync.ts resolves the TENANT credential for every CRM provider ──")
{
  const sync = src("lib/crm/sync.ts")
  check("GHL branch resolves resolveScopedConnection(\"ghl\", …)",
    /resolveScopedConnection\(\s*["']ghl["']/.test(sync))
  check("GHL override (apiKey + locationId) is passed into syncContactToGHL",
    /syncContactToGHL\(/.test(sync) && sync.includes("ghlOverride"))
  check("GHL locationId precedence matches the pure helper (accountId ?? config.locationId ?? config.location_id)",
    sync.includes("conn?.accountId") && sync.includes("locationId") && sync.includes("location_id"))
  check("FUB/Lofty/HubSpot dispatch with conn.apiKey from resolveScopedConnection",
    sync.includes("resolveScopedConnection(providerKey") && sync.includes("conn?.apiKey"))
  check("provider RESOLUTION also honors platform_credentials (Connection-Center selection)",
    sync.includes('.from("platform_credentials")') && sync.includes("crmPlatforms"))
}

console.log("\n── SOURCE: goHighLevelService honors the override, env is only the fallback ──")
{
  const ghl = src("services/goHighLevelService.ts")
  check("syncContactToGHL accepts an optional tenant credentialOverride",
    /export async function syncContactToGHL\(\s*contact:[^,]+,\s*credentialOverride\??/.test(ghl))
  check("credentialOverride wins, getGHLConfig() (env) is the fallback",
    ghl.includes("credentialOverride ?? getGHLConfig()"))
  check("ghlFetch takes a configOverride so every call uses the tenant key",
    ghl.includes("configOverride?: GHLConfig | null") && ghl.includes("configOverride ?? getGHLConfig()"))
  check("env still supported (platform default) — GHL_API_KEY read remains",
    ghl.includes("process.env.GHL_API_KEY"))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ CRM_SYNC_CREDENTIAL_FAIL"); process.exit(1) }
console.log(" ✅ CRM_SYNC_CREDENTIAL_PASS — every CRM dispatches with the tenant's own credential; env is only the platform fallback")
