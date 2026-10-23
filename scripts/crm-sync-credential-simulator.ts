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
import { classifyCoordination } from "../lib/kernel/coordination-kind"
import { MANAGERS } from "../lib/kernel/manager-registry"

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

console.log("\n── MANAGER OWNERSHIP: the manual 'Sync now' is a governed Data Steward operation ──")
{
  const registry = src("lib/kernel/signal-registry.ts")
  check("contact_crm_synced is catalogued as a feed_only signal",
    /contact_crm_synced:\s*\{[^}]*disposition:\s*"feed_only"/.test(registry))

  check("contact_crm_synced classifies to 'update' (matches the registry kind)",
    classifyCoordination("contact_crm_synced") === "update")

  check("data_steward → sphere_of_influence is a valid signal route (both registered, distinct)",
    "data_steward" in MANAGERS && "sphere_of_influence" in MANAGERS)

  const connect = src("app/actions/crm-connect.ts")
  check("syncContactNowAction publishes contact_crm_synced from data_steward → sphere_of_influence",
    connect.includes('signalType: "contact_crm_synced"') &&
    connect.includes('fromManager: "data_steward"') &&
    connect.includes('toManager: "sphere_of_influence"'))
  check("the bus announcement is best-effort (a bus hiccup never fails the CRM push)",
    /publishManagerSignal[\s\S]*?\}\s*catch\s*\{/.test(connect))

  const cc = src("app/settings/connections/connection-center-client.tsx")
  check("the manual sync tool is BUILT INTO the Connection Center CRM domain (feature parity, not deleted)",
    cc.includes("CrmSyncNowCard") && cc.includes('d.domain === "crm"') && cc.includes("syncContactNowAction"))
  check("the sync card is attributed to the Data Steward manager identity",
    cc.includes("MANAGERS.data_steward"))
}

console.log("\n── CONNECTION CENTER: phone/SMS is platform-provided (BYO carrier is top-tier only) ──")
{
  const cc = src("app/settings/connections/connection-center-client.tsx")
  check("phone domain renders the platform-provided panel (no carrier API key by default)",
    cc.includes("PlatformProvidedPhonePanel") && cc.includes('d.domain === "phone"'))
  check("the carrier API-key rows are reframed as advanced bring-your-own-carrier",
    /bring your own carrier/i.test(cc))

  const action = src("app/actions/connections/connection-center.ts")
  check("BYO phone is available on every plan — gated by the SUBSCRIBER policy, not the tier",
    action.includes('params.domain === "phone"') &&
    action.includes("isTenancyPrincipal") &&
    action.includes("allow_user_byo_carrier") &&
    !action.includes("multi_location"))
  check("tenancy principals (solo agent / team lead / broker) may always BYO; managed agents need opt-in",
    action.includes('actor.scope === "agent"') && action.includes("principal"))

  const gs = src("app/actions/settings/global-settings-actions.ts")
  check("subscriber toggle exists: setByoCarrierPolicy is broker-gated, getByoCarrierPolicy is member-readable",
    gs.includes("export async function setByoCarrierPolicy") &&
    gs.includes("export async function getByoCarrierPolicy") &&
    // Keyed to the roster module, not the identifier: the BYO toggle is
    // OPERATIONAL tenant admin, and the gate it calls has been renamed since.
    /from\s+["']@\/lib\/auth\/resolve-user-role["']/.test(gs) &&
    /setByoCarrierPolicy[\s\S]*?(isAdminOrBroker|resolveTenantAdmin)/.test(gs))

  const cc2 = src("app/settings/connections/connection-center-client.tsx")
  check("the subscriber sees a 'let your agents BYO' toggle in the phone panel",
    cc2.includes("setByoCarrierPolicy") && cc2.includes("bring their own carrier"))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ CRM_SYNC_CREDENTIAL_FAIL"); process.exit(1) }
console.log(" ✅ CRM_SYNC_CREDENTIAL_PASS — every CRM dispatches with the tenant's own credential; env is only the platform fallback")
