#!/usr/bin/env tsx
/**
 * scripts/tenant-provider-connections-guard.ts — TENANT-OWNED ACQUISITION PROVIDER CONNECTIONS (wave 151, lane 151F; directive
 * 151F route B, the 14-step setup / runtime contract, canaries). npm run test:tenant-provider-connections.
 *
 *   A  the CATALOGUE is honest: every provider with no transport is a dormant-pending-rights provider in PROVIDER_ACTIVATION
 *      and absent from CONTACT_PROVIDER_ROUTES; the one transport_built provider names a tenant-key parameter that EXISTS in
 *      the adapter's stripped source; the pure module carries no transport of its own (the wave-150 TRANSPORT regex);
 *   B  the STATE MACHINE (step 11): unavailable / unsupported / unconfigured / sandbox / pending_owner_licensing / healthy /
 *      degraded / revoked — each reached, each refusing or admitting ingestion as ruled;
 *   C  the AGREEMENT (step 5): platform cost payer refused, redistribution refused, a scope outside the catalogue refused,
 *      no attestation refused, out-of-range retention refused; a complete agreement accepted verbatim;
 *   D  the COST BOOKING (step 8): a tenant-owned call books coverage tenant_paid, tenant-pinned, never platformPaid;
 *   E  FAILURE CLASSIFICATION (step 12): 401/403 → revoked + reconnect + tenant told; 402/429 → degraded + hold queue;
 *      5xx / network → degraded + retry; a bearer token in an error never reaches the tenant message;
 *   F  the CANARY (steps 3, 9, 10, 13, 14 on the REAL code, in memory): two tenants, same provider, different keys — no
 *      crossover in calls, records or costs; a replay is ONE observation; revoked / 401 / quota / daily cap recover as ruled;
 *   G  WIRING (stripped source): the smart-search route tries the tenant door BEFORE the platform secret and hydrates under the
 *      tenant key with no platform fallback inside it; the client refuses an empty tenant key and never falls through; the
 *      action writes only catalogue providers and raises the secret-storage incident when the key is absent; m975 admits
 *      'batchdata' and KEEPS every live value (the generated cache is the live truth); m976's column name is the loader's;
 *      both migrations carry the lane stamp (or the APPLIED LIVE stamp — the rule, not the waypoint); the webhook contract
 *      row names both implementing files; the tenancy matrix carries tenant_optional_key for batchdata; the canary is in
 *      the roster and on disk.
 *
 * Positive controls: a planted catalogue claim naming a missing symbol is flagged; a planted route with the doors in the
 * wrong order is flagged; a planted migration missing a live value is flagged; a planted secret in an error is redacted.
 *
 * BLIND SPOTS (published): the provider is never called (the hydrate is a recording stub; the live wallet read runs only in the
 * connect action); RLS is not modelled in memory; the gateway's api_response_logs attribution of a tenant-keyed call is
 * asserted by parameter, not observed; only BatchData has a transport — the other catalogue rows prove honesty, not ingestion.
 */
import { memSupabase } from "./in-memory-supabase"
import "./canaries/_harness"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { fnBody } from "./canaries/_registry"

const ROOT = process.cwd()
let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const stripped = (p: string) => stripComments(read(p))

async function main() {
  const tp = await import("../lib/providers/tenant-provider-connections")
  const { PROVIDER_ACTIVATION, CONTACT_PROVIDER_ROUTES } = await import("../lib/ai-isa/property-lookup-rail")

  console.log("\nA — the catalogue is honest")
  const keys = Object.keys(tp.TENANT_ACQUISITION_PROVIDERS)
  const noTransport = keys.filter((k) => tp.TENANT_ACQUISITION_PROVIDERS[k].adapter.state === "no_transport")
  const routed = new Set(Object.values(CONTACT_PROVIDER_ROUTES).flat().map((e) => e.provider as string))
  check(`every no-transport provider (${noTransport.join(", ")}) is dormant_pending_rights in PROVIDER_ACTIVATION and absent from the route table`,
    noTransport.length > 0 && noTransport.every((k) => PROVIDER_ACTIVATION[k as keyof typeof PROVIDER_ACTIVATION]?.state === "dormant_pending_rights" && !routed.has(k) && tp.TENANT_ACQUISITION_PROVIDERS[k].transports.length === 0 && tp.TENANT_ACQUISITION_PROVIDERS[k].fields.length === 0))
  const built = keys.filter((k) => tp.TENANT_ACQUISITION_PROVIDERS[k].adapter.state === "transport_built")
  check("exactly one provider is transport_built today (batchdata) — every other row proves honesty, not ingestion", built.join() === "batchdata")
  const claimExists = (k: string) => { const p = tp.TENANT_ACQUISITION_PROVIDERS[k]; return !!p.adapter.tenantKeyParam && existsSync(join(ROOT, p.adapter.module)) && new RegExp(`\\b${p.adapter.tenantKeyParam}\\??:\\s*string\\s*\\|\\s*null`).test(stripped(p.adapter.module)) }
  check("the transport_built claim names a tenant-key parameter that EXISTS in the adapter's stripped source", built.every(claimExists))
  check("positive control: a planted claim naming a missing parameter is caught", !new RegExp(`\\btenantTokenZ\\??:\\s*string\\s*\\|\\s*null`).test(stripped("lib/external/batchdata-client.ts")))
  const TRANSPORT = /\bfetch\s*\(|process\.env\b|https?:\/\/|createServiceClient|from\s+["']@\/lib\/external\/|new\s+[A-Z][A-Za-z]*Client\s*\(/
  check("the pure module carries no transport (no fetch / env / URL / service client / external import)", !TRANSPORT.test(stripped("lib/providers/tenant-provider-connections.ts")), (stripped("lib/providers/tenant-provider-connections.ts").match(TRANSPORT) ?? [""])[0])
  check("every catalogue row names a tenant cost payer and prohibits redistribution", keys.every((k) => tp.TENANT_ACQUISITION_PROVIDERS[k].pricing.payer === "tenant" && tp.TENANT_ACQUISITION_PROVIDERS[k].rights.redistribution === "prohibited"))
  check("the state vocabulary is the directive's eight, once", tp.TENANT_PROVIDER_CONNECTION_STATES.length === 8 && new Set(tp.TENANT_PROVIDER_CONNECTION_STATES).size === 8 && ["unavailable", "unsupported", "unconfigured", "sandbox", "pending_owner_licensing", "healthy", "degraded", "revoked"].every((s) => (tp.TENANT_PROVIDER_CONNECTION_STATES as readonly string[]).includes(s)))

  console.log("\nB — the state machine")
  const ok = { status: "ok" as const, kind: "wallet_balance", at: "2026-11-09T00:00:00.000Z", detail: null }
  const agreement = { scopes: ["owner_contact"], license_acknowledged: true as const, retention_days: 30, ai_processing_permitted: false, redistribution: "prohibited" as const, cost_payer: "tenant" as const, accepted_by_user_id: "u1", accepted_at: "2026-11-09T00:00:00.000Z" }
  const base = { exists: true, isActive: true, testStatus: "pass" as const, hasApiKey: true, config: { agreement, last_health: ok, sandbox: false, disconnected_at: null, territory: { state: "FL", zip_codes: ["32501"], city: null } } }
  const st = (facts: Parameters<typeof tp.deriveTenantProviderConnectionState>[1], provider = "batchdata") => tp.deriveTenantProviderConnectionState(provider, facts as never)
  check("unavailable: an unknown provider (no generic field), never ingests", st(null, "zapierlike").state === "unavailable" && !st(null, "zapierlike").mayIngest)
  check("unsupported: a dormant no-transport provider, never ingests", st(null, "tracerfy").state === "unsupported" && !st(base, "datazapp").mayIngest)
  check("unconfigured: no row → the actionable next step", st(null).state === "unconfigured" && /Settings/.test(st(null).actionable ?? ""))
  check("healthy: verified under the tenant's token → ingests", st(base).state === "healthy" && st(base).mayIngest)
  check("revoked: disconnected (inactive) → never ingests; revoked: the provider refused the token (auth_failed) → never ingests", st({ ...base, isActive: false }).state === "revoked" && !st({ ...base, isActive: false }).mayIngest && st({ ...base, config: { ...base.config, last_health: { ...ok, status: "auth_failed" } } }).state === "revoked")
  check("sandbox: a test account is never a production source", st({ ...base, config: { ...base.config, sandbox: true } }).state === "sandbox" && !st({ ...base, config: { ...base.config, sandbox: true } }).mayIngest)
  check("degraded: quota / unreachable / drift keep the queue and still ingest when the provider answers; a pending verification is degraded, not healthy", ["quota", "unreachable", "shape_drift"].every((s) => st({ ...base, config: { ...base.config, last_health: { ...ok, status: s as never } } }).state === "degraded") && st({ ...base, testStatus: "pending", config: { ...base.config, last_health: null } }).state === "degraded")
  check("unconfigured: an incomplete agreement on a stored row is not a connection", st({ ...base, config: { ...base.config, agreement: { ...agreement, cost_payer: "platform" as never } } }).state === "unconfigured")
  check("pending_owner_licensing is reachable by RULE (a transport-built provider the platform keeps dormant pending rights) and is reserved today — no catalogue row has both", (() => {
    // Derive: were a transport built for a dormant_pending_rights provider, the state would be pending_owner_licensing. The rule is
    // asserted against the SAME derivation the code uses (the branch order in deriveTenantProviderConnectionState).
    const src = stripped("lib/providers/tenant-provider-connections.ts")
    const i1 = src.indexOf('state: "unsupported"'), i2 = src.indexOf('state: "pending_owner_licensing"'), i3 = src.indexOf('state: "unconfigured"')
    return i1 > 0 && i2 > i1 && i3 > i2 && !keys.some((k) => tp.TENANT_ACQUISITION_PROVIDERS[k].adapter.state === "transport_built" && PROVIDER_ACTIVATION[k as keyof typeof PROVIDER_ACTIVATION]?.state === "dormant_pending_rights")
  })())

  console.log("\nC — the agreement")
  const good = tp.validateProviderAgreement("batchdata", { scopes: ["motivated_seller_list"], license_acknowledged: true, retention_days: 365, ai_processing_permitted: true, redistribution: "prohibited", cost_payer: "tenant" }, { userId: "u1" })
  check("a complete agreement is accepted verbatim (scopes, retention, AI processing, redistribution prohibited, payer tenant, accepting user)", good.ok && good.agreement.scopes.join() === "motivated_seller_list" && good.agreement.cost_payer === "tenant" && good.agreement.accepted_by_user_id === "u1")
  const refuse = (over: Record<string, unknown>) => { const r = tp.validateProviderAgreement("batchdata", { scopes: ["motivated_seller_list"], license_acknowledged: true, retention_days: 365, ai_processing_permitted: true, redistribution: "prohibited", cost_payer: "tenant", ...over }, { userId: "u1" }); return !r.ok ? r.problems.join(" | ") : "" }
  check("a PLATFORM cost payer is refused", /cost_payer/.test(refuse({ cost_payer: "platform" })))
  check("any redistribution is refused", /redistribution/.test(refuse({ redistribution: "allowed" })))
  check("a scope the provider does not sell is refused", /scopes/.test(refuse({ scopes: ["virtual_event_hosting"] })))
  check("no attestation is refused", /license_acknowledged/.test(refuse({ license_acknowledged: false })))
  check("retention outside (0, 10y] is refused", /retention_days/.test(refuse({ retention_days: 0 })) && /retention_days/.test(refuse({ retention_days: 99999 })))
  check("an unknown provider's agreement is refused", !tp.validateProviderAgreement("someapi", {}, { userId: "u1" }).ok)
  const terr = tp.validateProviderTerritory({ state: "fl", zip_codes: ["32501", "bad", "32502"], city: " Pensacola " })
  check("territory: state upper-cased, only five-digit ZIPs kept, city trimmed; no ZIP → refused", terr.ok && terr.territory.state === "FL" && terr.territory.zip_codes.join() === "32501,32502" && terr.territory.city === "Pensacola" && !tp.validateProviderTerritory({ state: "FL", zip_codes: [] }).ok)

  console.log("\nD — the cost booking is the tenant's (through THE ONE tenant ingest door, never a second booking spelling)")
  {
    const { normalizeBatchDataRecord } = await import("../lib/lead-pipeline/scraper-parsers")
    const { ingestRawSourceBatch } = await import("../lib/kernel/scraping")
    const booked: Array<Record<string, any>> = []
    const parked: unknown[] = []
    const at = new Date().toISOString()
    const bookDb = memSupabase({ raw_scraped_leads: [], scraper_executions: [], lifecycle_events: [], lead_scraping_markets: [], vendor_usage_tracking: [], ingress_dead_letters: [] } as never, { unique: { raw_scraped_leads: [["idempotency_key"]] } } as never) as never
    const connD = { id: "c1", brokerage_id: "b1", platform: "batchdata", is_active: true, test_status: "pass" as const, apiKey: "tenant-token-xxxxxxxxxxxxxxxxxxxx", config: { agreement: good.ok ? good.agreement : null, territory: terr.ok ? terr.territory : null, frequency: "push", last_health: { kind: "wallet_balance", status: "ok", at, detail: null } } as never }
    const fixture = (propertyId: string) => ({ propertyId, _id: propertyId, address: { street: "12 Palafox St", city: "Pensacola", state: "FL", zip: "32501" }, owner: { fullName: "Dana Whitfield" }, propertyAddress: "12 Palafox St", city: "Pensacola", state: "FL", zip: "32501", first_name: "Dana", last_name: "Whitfield", email: "dana.whitfield@example.org", quickLists: ["pre-foreclosure"] })
    const depsD = (cost: number | null) => ({
      hydrate: async (ids: string[]) => ({ ok: true, properties: ids.map(fixture), cost }),
      normalize: (raw: Record<string, unknown>, geo: { city: string | null; state: string | null }) => normalizeBatchDataRecord(raw, geo),
      ingest: (p: Parameters<typeof ingestRawSourceBatch>[0]) => ingestRawSourceBatch({ ...p, client: bookDb } as never),
      book: async (input: Record<string, any>) => { booked.push(input); return true },
      park: async (p: unknown) => { parked.push(p) },
    })
    const d1 = await tp.ingestTenantWebhookDelivery(bookDb, connD as never, [{ eventId: "evt-d1", propertyId: "P-D1", addedToSubscriptionIds: ["sub-a"], propertyChangedAt: at }], depsD(0.06) as never)
    check("a priced tenant delivery books ONE tenant_paid row, tenant-pinned, naming the payer and the connection — never platform_paid", d1.ok && booked.length === 1 && booked[0].coverage === "tenant_paid" && booked[0].brokerageId === "b1" && booked[0].metadata?.cost_payer === "tenant" && booked[0].metadata?.connection_id === "c1" && booked[0].priceState === undefined, JSON.stringify({ ok: d1.ok, refused: d1.refused, booked: booked.length, b0: booked[0] }).slice(0, 300))
    const d2 = await tp.ingestTenantWebhookDelivery(bookDb, connD as never, [{ eventId: "evt-d2", propertyId: "P-D2", addedToSubscriptionIds: ["sub-a"], propertyChangedAt: at }], depsD(null) as never)
    check("an unpriced tenant call books its units with price_state unknown — never a guessed dollar", d2.ok && booked.length === 2 && booked[1].priceState === "unknown" && booked[1].cost === 0 && booked[1].coverage === "tenant_paid", JSON.stringify({ ok: d2.ok, refused: d2.refused, b1: booked[1] }).slice(0, 300))
    check("positive control: a booking spy that never ran would read zero", booked.length === 2 && parked.length === 0, `parked ${parked.length}`)
  }

  console.log("\nE — failure classification and redaction")
  const f401 = tp.classifyTenantProviderFailure({ httpStatus: 401, message: "Unauthorized Bearer abcdefghijklmnopqrstuvwxyz012345" }, "BatchData")
  check("401 → revoked, reconnect, tenant told, and the bearer token never reaches the message", f401.state === "revoked" && f401.action === "reconnect" && f401.notify === "tenant_admin" && !/abcdefghijklmnop/.test(f401.tenantMessage))
  check("429 → degraded, hold the queue; 5xx / network → degraded, retry next cycle", tp.classifyTenantProviderFailure({ httpStatus: 429 }).action === "hold_queue" && tp.classifyTenantProviderFailure({ httpStatus: 503 }).action === "retry_next_cycle" && tp.classifyTenantProviderFailure({ httpStatus: null, networkError: true }).state === "degraded")
  check("redaction: a bearer token, a key=… pair, a 32-hex id and an enc:v1 envelope are all redacted", (() => { const r = tp.redactProviderSecrets("Bearer sk_live_ABCDEFGHIJKLMNOP token=ZZZZZZZZZZZZZZZZZZZZ 0123456789abcdef0123456789abcdef enc:v1:aaa:bbb:ccc"); return !/ABCDEFGHIJ|ZZZZZZ|0123456789abcdef0123456789abcdef|aaa:bbb/.test(r) && /redacted/.test(r) })())
  check("positive control: ordinary text is not redacted", tp.redactProviderSecrets("HTTP 503 upstream") === "HTTP 503 upstream")
  check("the push secret: no secret configured refuses; a mismatch refuses; the right secret passes", tp.verifyTenantWebhookSecret(null, "x") === "no_secret_configured" && tp.verifyTenantWebhookSecret("abc", "abd") === "mismatch" && tp.verifyTenantWebhookSecret("abc", "abc") === "ok")
  check("the connection id is read ONLY as a uuid query param", tp.tenantWebhookConnectionId("https://x.test/api/webhooks/batchdata-smart-search?connection=11111111-1111-4111-8111-111111111111") === "11111111-1111-4111-8111-111111111111" && tp.tenantWebhookConnectionId("https://x.test/api/webhooks/batchdata-smart-search?connection=../etc") === null && tp.tenantWebhookConnectionId("https://x.test/api/webhooks/batchdata-smart-search") === null)
  check("the payload envelopes read as ONE definition (ids-only events vs inline records)", tp.extractSmartSearchEvents({ events: [{ propertyId: "P" }] }).length === 1 && tp.extractSmartSearchEvents([{ propertyId: "P" }, { address: {} }]).length === 2 && tp.isIdsOnlySmartSearchEvent({ propertyId: "P" }) && !tp.isIdsOnlySmartSearchEvent({ propertyId: "P", address: {} }))

  console.log("\nF — the canary (two tenants, same provider, different keys; replay; recovery)")
  const { run } = await import("./canaries/tenant-provider-connections")
  const report = await run()
  check("the canary passed every step and cleaned up (residual 0)", report.passed && report.residual === 0, report.steps.filter((s) => !s.ok).map((s) => s.step).join("; "))
  for (const want of ["tenant 1 resolves ITS token", "tenant 2 resolves ITS token", "REPLAY", "COSTS", "REVOKED", "401", "QUOTA", "daily cap", "DISCONNECT"]) {
    check(`canary step present and green: ${want}`, report.steps.some((s) => s.step.includes(want) && s.ok))
  }

  console.log("\nG — wiring (stripped source)")
  const route = stripped("app/api/webhooks/batchdata-smart-search/route.ts")
  const post = fnBody(route, "POST")
  const tenantDoor = fnBody(route, "handleTenantDelivery")
  check("the route tries the TENANT door (tenantWebhookConnectionId) BEFORE the platform secret (verifySharedSecret)", post.indexOf("tenantWebhookConnectionId(request.url)") > 0 && post.indexOf("tenantWebhookConnectionId(request.url)") < post.indexOf("verifySharedSecret(request)"))
  check("positive control: a planted route with the doors in the wrong order is caught", (() => { const planted = "export async function POST(request: Request) {\n if (!verifySharedSecret(request)) return x\n const connectionId = tenantWebhookConnectionId(request.url)\n}"; const b = fnBody(planted, "POST"); return !(b.indexOf("tenantWebhookConnectionId(request.url)") < b.indexOf("verifySharedSecret(request)")) })())
  check("the tenant door hydrates under the TENANT's key and reads no platform secret / env key inside it", /lookupBatchDataPropertiesByIds\((?:ids|toHydrate), \{ apiKey: key/.test(tenantDoor) && !/process\.env|BATCHDATA_API_KEY|BATCHDATA_SMART_SEARCH_WEBHOOK_SECRET/.test(tenantDoor) && /verifyTenantWebhookSecret\(/.test(tenantDoor) && /ingestTenantWebhookDelivery\(/.test(tenantDoor))
  check("the tenant door pins every write to the connection's tenant and counts it", /\.eq\("brokerage_id", row\.brokerage_id\)\s*\.select\("id"\)/.test(tenantDoor))
  const client = stripped("lib/external/batchdata-client.ts")
  check("the client: a tenant-keyed lookup / search / wallet read refuses an EMPTY tenant key and never falls back to the platform key", (client.match(/no fallback to the platform key/g) ?? []).length >= 3 && /tenantKeyed \? \(opts!\.apiKey as string\)\.trim\(\) : \(resolveBatchDataToken/.test(client))
  check("the client: a tenant-keyed 401/403/402/429 is surfaced with its status (never fewer rows silently)", /tenantKeyed && !res\.ok && \(res\.status === 401 \|\| res\.status === 403 \|\| res\.status === 402 \|\| res\.status === 429\)/.test(client))
  const action = stripped("app/actions/tenant-connections.ts")
  check("the action writes only a CATALOGUE provider (tenantAcquisitionProvider gate before the row) and raises the secret-storage incident when the key is absent", /tenantAcquisitionProvider\(input\?\.provider/.test(action) && /isEncryptionConfigured\(\)/.test(action) && /raiseSecretStorageIncident\(/.test(action) && /platform: provider\.provider/.test(stripped("lib/providers/tenant-provider-connections.ts")))
  check("the action verifies the key by the FREE account read under the tenant's token (fetchBatchDataWalletBalance({ apiKey", /fetchBatchDataWalletBalance\(\{ apiKey, brokerageId: ctx\.brokerageId \}\)/.test(action))
  check("the disconnect is counted (select) and reports through the one operation-outcome survivor", /tenantProviderDisconnectPatch\(/.test(action) && /reportOperationOutcome\(/.test(action))
  // m975 keeps every live value — the generated cache (scripts/check-vocabularies.ts) IS the live CHECK.
  const cache = read("scripts/check-vocabularies.ts")
  const cacheBlock = cache.slice(cache.indexOf("  platform_credentials: {"))
  const livePlatforms = (cacheBlock.match(/platform: \[([^\]]*)\]/)?.[1] ?? "").match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? []
  const m975 = read("supabase/migrations/m975-tenant-owned-acquisition-provider-credential-door.sql")
  // [a-z0-9_] — a provider id may carry a digit (twilio_a2p); a letters-only class would read a kept value as dropped.
  const m975Values = (m975.slice(m975.indexOf("ADD CONSTRAINT platform_credentials_platform_check")).match(/'([a-z0-9_]+)'/g) ?? []).map((s) => s.slice(1, -1))
  // The RULE: m975's CHECK vocabulary IS the live vocabulary (the generated cache, scripts/check-vocabularies.ts) — set equality,
  // never a hand count; and the one value this lane added (batchdata) is in both.
  check(`m975's platform vocabulary equals the live vocabulary (${livePlatforms.length} values, batchdata included)`, livePlatforms.length > 50 && livePlatforms.includes("batchdata") && m975Values.includes("batchdata") && [...new Set(m975Values)].sort().join() === [...new Set(livePlatforms)].sort().join(), JSON.stringify({ onlyInM975: m975Values.filter((v) => !livePlatforms.includes(v)), onlyLive: livePlatforms.filter((v) => !m975Values.includes(v)) }))
  check("positive control: a planted migration missing a live value is caught", !livePlatforms.every((v) => m975Values.filter((x) => x !== "idxbroker").includes(v)))
  const stamp = (p: string) => { const l1 = read(p).split("\n")[0]; return l1 === "-- WRITTEN, NOT APPLIED (wave 151, lane 151F) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL" || l1.startsWith("-- ── APPLIED LIVE ") }
  check("both migrations carry the lane stamp on line 1 (or the APPLIED LIVE stamp — the rule, not the waypoint)", stamp("supabase/migrations/m975-tenant-owned-acquisition-provider-credential-door.sql") && stamp("supabase/migrations/m976-platform-acquisition-budget-caps.sql"))
  const m976 = read("supabase/migrations/m976-platform-acquisition-budget-caps.sql")
  check("m976 adds the column the caps loader selects and pins it to an object-or-null", /ADD COLUMN IF NOT EXISTS acquisition_budget_caps jsonb/.test(m976) && /jsonb_typeof\(acquisition_budget_caps\) = 'object'/.test(m976) && /select\("acquisition_budget_caps"\)/.test(stripped("lib/vendor-governance/platform-acquisition-caps.ts")))
  const { WEBHOOK_CONTRACT } = await import("../lib/providers/webhook-contract")
  const row = WEBHOOK_CONTRACT.find((e) => e.path === "/api/webhooks/batchdata-smart-search")
  check("the webhook contract row names both implementing files and the tenant door", !!row && (row.implementedIn ?? []).includes("lib/providers/tenant-provider-connections.ts") && /connection=/.test(row.consoleField))
  const { providerTenancy } = await import("../lib/providers/tenancy-matrix")
  check("the tenancy matrix: batchdata carries tenant_optional_key beside platform_metered", (providerTenancy("batchdata")?.models ?? []).includes("tenant_optional_key") && (providerTenancy("batchdata")?.models ?? []).includes("platform_metered"))
  const { CANARY_KEYS } = await import("./canaries/_registry")
  check("the canary is in the runner's roster and on disk", (CANARY_KEYS as readonly string[]).includes("tenant-provider-connections") && existsSync(join(ROOT, "scripts/canaries/tenant-provider-connections.ts")))
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
  check("test:tenant-provider-connections is registered and chained in the guard (later lanes append after it)", typeof pkg.scripts["test:tenant-provider-connections"] === "string" && /npm run test:tenant-provider-connections(?: |$)/.test(pkg.scripts.guard))
  check("NEGATIVE CONTROL: nothing in this lane's modules names an opt-in lead plan or a qualified-release meter (owner ruling 2026-11-09 — dropped, nothing built)", !/qualified_lead_release|platform_sourced_leads_opt_in|qualifiedReleaseMeter/i.test(stripped("lib/providers/tenant-provider-connections.ts") + stripped("lib/vendor-governance/platform-acquisition-caps.ts") + stripped("lib/vendor-governance/acquisition-economics.ts") + action))

  console.log("\nH — internal economics: measured, split by payer, never projected")
  const { loadAcquisitionEconomics } = await import("../lib/vendor-governance/acquisition-economics")
  const since = "2026-11-01T00:00:00.000Z", at = "2026-11-05T00:00:00.000Z"
  const econDb = memSupabase({
    vendor_usage_tracking: [
      { brokerage_id: "b1", total_cost: 4, request_metadata: { system_source: "lead_scraping", coverage: "platform_covered", units_used: 80 }, created_at: at },
      { brokerage_id: "b1", total_cost: 6, request_metadata: { system_source: "tenant_provider_connection", coverage: "tenant_paid", units_used: 3 }, created_at: at },
      { brokerage_id: "b1", total_cost: 99, request_metadata: { system_source: "ai_isa" }, created_at: at },
    ],
    raw_scraped_leads: [
      ...Array.from({ length: 4 }, (_, n) => ({ id: `r-lead-${n}`, dedupe_status: "unique", lead_id: `L${n}`, created_at: at })),
      ...Array.from({ length: 2 }, (_, n) => ({ id: `r-dup-${n}`, dedupe_status: "duplicate_pre_enrich", lead_id: null, created_at: at })),
      ...Array.from({ length: 4 }, (_, n) => ({ id: `r-open-${n}`, dedupe_status: "unique", lead_id: null, created_at: at })),
    ],
    leads: [
      ...Array.from({ length: 3 }, (_, n) => ({ id: `L${n}`, raw_record_id: `r-lead-${n}`, contact_id: null, created_at: at })),
      { id: "L3", raw_record_id: "r-lead-3", contact_id: "c1", created_at: at },
    ],
  } as never) as never
  const econ = await loadAcquisitionEconomics(econDb, { sinceIso: since, duplicateUnitUsd: 0.05 })
  check("platform-covered and tenant-paid spend are split by the row's coverage; non-acquisition rows are excluded (read through the ONE loader)", econ.platformSpendUsd === 4 && econ.tenantSpendUsd === 6 && econ.ledgerRows === 2 && econ.apiUnits === 83)
  check("duplicate-avoidance savings = duplicates × documented unit price; cost per usable record = platform spend ÷ (raw − duplicates)", econ.duplicateAvoidanceSavingsUsd === 0.1 && econ.costPerUsableRecordUsd === 0.5)
  check("gate yield and contact conversion are measured ratios; unattributed outcomes stay null with a caveat naming the reader (never a projection)", econ.rawLeadGateYield === 0.4 && econ.contactConversion === 0.25 && econ.appointments === null && econ.caveats.some((c: string) => /outcome|roi|reader|attribut/i.test(c)))
  const empty = await loadAcquisitionEconomics(memSupabase({ vendor_usage_tracking: [], raw_scraped_leads: [], leads: [] } as never) as never, { sinceIso: since, duplicateUnitUsd: null })
  check("positive control: zero denominators read NULL (n/a), never 0% claimed", empty.rawLeadGateYield === null && empty.contactConversion === null && empty.costPerUsableRecordUsd === null && empty.duplicateAvoidanceSavingsUsd === null)

  // ── I · wave 152, lane 152A — what the TENANT reads, and the recovery loop behind it ─────────────────────────────────
  // The verdict's reason / actionable stay INTERNAL (staff console, evidence); the tenant reads THE presenter
  // (lib/errors presentTenantConnection via presentTenantProviderConnection). Recovery: failed connection → classify →
  // reportOperationOutcome → data_steward's inbox → the consumer re-reads THE credential row (the provider health reader)
  // beside its readiness keys → escalate (bell + ticket, truthful) or verified → the watch closes.
  console.log("\nI — tenant presentation and recovery (wave 152, lane 152A)")
  const E = await import("../lib/errors")
  const io = await import("../lib/kernel/immediate-operations")
  const at152 = "2026-11-11T09:00:00.000Z"
  const agreed = good.ok ? good.agreement : null
  const factsOf = (probe: string | null, over: Record<string, unknown> = {}) => ({
    exists: true, isActive: true, testStatus: (probe === "ok" ? "pass" : probe ? "fail" : "pending") as "pass" | "fail" | "pending", hasApiKey: true,
    config: { agreement: agreed, territory: terr.ok ? terr.territory : null, frequency: "push", webhook_secret: "enc:v1:aaaa:bbbb:cccc", account_label: "Acme Data", last_health: probe ? { kind: "wallet_balance", status: probe, at: at152, detail: "HTTP 401 — Bearer [redacted]" } : null, ...over } as never,
  })
  const viewOf = (provider: string, facts: ReturnType<typeof factsOf> | null, payer = { kind: "team" as const }) => tp.presentTenantProviderConnection(provider, tp.deriveTenantProviderConnectionState(provider, facts), facts, payer)
  const INTERNAL = /pending_owner_licensing|unconfigured|auth_failed|shape_drift|not_configured|wallet_balance|HTTP \d{3}|lib\/|OWNER-SQL|token|transport|dormant/i
  const cases: Array<[string, ReturnType<typeof factsOf> | null, string]> = [
    ["batchdata", null, "unconfigured"], ["batchdata", factsOf(null), "degraded (not yet confirmed)"], ["batchdata", factsOf("ok"), "healthy"],
    ["batchdata", factsOf("auth_failed"), "revoked (provider refused)"], ["batchdata", factsOf("quota"), "degraded (quota)"], ["batchdata", factsOf("unreachable"), "degraded (unreachable)"],
    ["batchdata", factsOf("shape_drift"), "degraded (unreadable)"], ["batchdata", factsOf("not_configured"), "degraded (check failed)"],
    ["batchdata", { ...factsOf("ok"), isActive: false, config: { ...(factsOf("ok").config as object), disconnected_at: at152 } as never }, "revoked (disconnected)"],
    ["batchdata", { ...factsOf("ok"), config: { ...(factsOf("ok").config as object), sandbox: true } as never }, "sandbox"],
    ["propertyradar", null, "unsupported"], ["acme-anything", null, "unavailable"],
  ]
  const leaks = cases.map(([prov, f, name]) => ({ name, v: viewOf(prov, f) })).filter(({ v }) => {
    const all = [v.label, v.message.text, v.message.sentence, v.credentialLine, v.costLine].filter(Boolean).join(" ")
    return INTERNAL.test(all) || !E.tenantCopyVerdict(all, { payer: { kind: "team" } }).ok || !v.label || !v.message.text
  })
  check(`every state (${cases.length} cases, all eight states + the causes) reads as the presenter's sentence — no internal state name, probe code, HTTP status, module path, credential word or owner-SQL pointer`, leaks.length === 0, leaks.map((l) => `${l.name}: ${l.v.message.sentence}`).join(" | "))
  const internalUnsupported = tp.deriveTenantProviderConnectionState("propertyradar", null).reason
  check("positive control: the INTERNAL reason the panel used to render is caught by the same finders (it names a module path / state)", INTERNAL.test(internalUnsupported) && !E.tenantCopyVerdict(internalUnsupported).ok, internalUnsupported.slice(0, 120))
  const failing = ["auth_failed", "quota", "unreachable", "shape_drift", "not_configured", null].map((probe) => ({ probe, v: viewOf("batchdata", factsOf(probe)) }))
  check("a FAILED provider check never reads 'Connected' (label or message) — six failure shapes", failing.every(({ v }) => v.label !== "Connected" && !/^connected/i.test(v.message.text) && !/connected and confirmed/i.test(v.message.text)), failing.map((x) => `${x.probe}:${x.v.label}: ${x.v.message.text}`).join(" | "))
  check("positive control: the one confirmed state DOES read 'Connected' and 'confirmed' (the finder can see it)", viewOf("batchdata", factsOf("ok")).label === "Connected" && /confirmed with your BatchData account/.test(viewOf("batchdata", factsOf("ok")).message.text))
  const f429 = tp.classifyTenantProviderFailure({ httpStatus: 429, message: "rate limited for key sk_live_ABCDEFGHIJKLMNOP" }, "BatchData (your own account)")
  check("classified failures: the tenant sentence carries no HTTP status and no retry promise; the INTERNAL detail keeps the status, redacted", !/HTTP|retr|sk_live/i.test(f429.tenantMessage) && /HTTP 429/.test(f429.detail) && !/ABCDEFGHIJ/.test(f429.detail), `${f429.tenantMessage} || ${f429.detail}`)
  const actionSrc = stripped("app/actions/tenant-connections.ts")
  check("the connect post-condition is 'CONFIRMED' (healthy, or a deliberate test account) — a degraded connect is routed, never reported 'completed and verified'", /const confirmed = verified\.ok && \(state\.state === "healthy" \|\| state\.state === "sandbox"\)/.test(actionSrc) && /ok: confirmed,/.test(actionSrc))
  check("positive control: the pre-fix post-condition shape is not what the finder accepts", !/const confirmed = verified\.ok && \(state\.state === "healthy"/.test('ok: verified.ok && state.state !== "revoked",'))

  // The push door on a refused key: the tenant sentence says "kept" ONLY for deliveries actually parked.
  {
    const conn401 = { id: "c-401", brokerage_id: "b1", platform: "batchdata", is_active: true, test_status: "pass" as const, apiKey: "tenant-token-xxxxxxxxxxxxxxxxxxxx", config: factsOf("ok").config }
    const ev = [{ eventId: "evt-401", propertyId: "P-401", addedToSubscriptionIds: ["sub-a"], propertyChangedAt: at152 }]
    const base401 = { hydrate: async () => ({ ok: false, properties: [], cost: null, httpStatus: 401, error: "Unauthorized Bearer tenant-token-xxxxxxxxxxxxxxxxxxxx" }), normalize: () => ({}) as never, ingest: async () => ({}) as never, book: async () => true }
    const parkedRun = await tp.ingestTenantWebhookDelivery({ from: () => ({}) } as never, conn401 as never, ev, { ...base401, park: async () => ({ parked: true }) } as never)
    const unparkedRun = await tp.ingestTenantWebhookDelivery({ from: () => ({}) } as never, conn401 as never, ev, base401 as never)
    check("the push door's tenant sentence: 'needs to be updated', 'kept' only when a delivery WAS parked, no retry promise, no token, never 'Connected'",
      /needs to be updated/.test(parkedRun.refused ?? "") && /kept/.test(parkedRun.refused ?? "") && parkedRun.parked === 1 && unparkedRun.parked === 0 && !/kept/.test(unparkedRun.refused ?? "") && ![parkedRun.refused, unparkedRun.refused].some((s) => /retr|token|HTTP|connected/i.test(s ?? "")),
      `${parkedRun.refused} || ${unparkedRun.refused}`)
  }

  // THE RECOVERY LOOP, end to end over the REAL reporter and consumer (in memory).
  {
    const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1"
    const db = memSupabase({
      platform_credentials: [{ id: C1, brokerage_id: A, owner_type: "brokerage", owner_id: A, platform: "batchdata", is_active: true, test_status: "fail", account_name: "Acme Data", config: { account_label: "Acme Data", last_health: { kind: "hydrate", status: "auth_failed", at: at152, detail: "HTTP 401" } } }],
      lifecycle_events: [], manager_signals: [], notifications: [], support_tickets: [], users: [],
    } as never, { uuidIds: true, stampCreatedAt: true }) as unknown as { tables: Record<string, Array<Record<string, any>>>; from: (t: string) => any }
    const bells: Array<{ brokerage: string; body: string }> = []
    const staffBodies: string[] = []
    const deps = (brokerage: string, now?: Date) => ({
      readiness: async () => ({ ready: true, blockers: [], checks: [{ key: "providerState", required: true, status: "PASS", reason: "platform lanes lit", evidence: {}, owner: "platform", label: "x", repairable: false }] as never, repairs: [] }),
      notifyOrg: async (_s: unknown, b: string, n: { body: string }) => { bells.push({ brokerage: b, body: n.body }); return 1 },
      notifyStaff: async (_s: unknown, n: { body: string }) => { staffBodies.push(n.body); return 1 },
      now,
    })
    const refusal = tp.classifyTenantProviderFailure({ httpStatus: 401 }, "BatchData (your own account)")
    const rep = await io.reportOperationOutcome(db, { operation: "provider_connection", brokerageId: A, ok: false, subjectType: "platform_credentials", subjectId: C1, evidence: { connectionState: "revoked" }, error: refusal.detail, tenantFacing: refusal.tenantMessage, source: "webhook" })
    const sigRow = (db.tables.manager_signals ?? []).find((s) => s.id === rep.signalId)
    check("a refused tenant key is REPORTED to its registered owner (data_steward) with the presenter's sentence on the feed", !!sigRow && sigRow.to_manager === "data_steward" && sigRow.brokerage_id === A && /needs to be updated/.test(String(sigRow.message)) && !/HTTP|token/i.test(String(sigRow.message)), String(sigRow?.message))
    const asSignal = (row: Record<string, any>, createdAt?: string) => ({ id: row.id, payload: row.payload, entityType: row.entity_type, entityId: row.entity_id, createdAt: createdAt ?? row.created_at })
    const r1 = await io.handleOperationFailureEscalated(asSignal(sigRow!), { brokerageId: A, supabase: db }, deps(A))
    const ticketA = (db.tables.support_tickets ?? []).find((t) => t.brokerage_id === A)
    check("NEEDS ATTENTION: platform readiness PASSES but the key is still refused → NOT 're-verified' (the pre-fix false close) → the account's admins are told, with a ticket", !!r1 && !/re-verified/.test(r1) && /escalated to a human/.test(r1) && /credential re-check: needs_tenant/.test(r1) && bells.length === 1 && bells[0].brokerage === A && !!ticketA && ticketA.lane === "user_to_brokerage", r1 ?? "null")
    check("…and the bell is the contract: what to do, nothing internal, 'tracked' because a ticket exists", /needs to be updated/.test(bells[0]?.body ?? "") && /tracked as a support request your account's admins can see/.test(bells[0]?.body ?? "") && !/HTTP|auth_failed|token|platform_credentials/i.test(bells[0]?.body ?? ""), bells[0]?.body)
    // THE REPAIR: the tenant reconnects; the connect door's free read stamps the row healthy.
    const row = db.tables.platform_credentials[0]
    row.test_status = "pass"; row.config = { ...row.config, last_health: { kind: "wallet_balance", status: "ok", at: at152, detail: null } }
    const r2 = await io.handleOperationFailureEscalated(asSignal(sigRow!), { brokerageId: A, supabase: db }, deps(A))
    check("REPAIRED: needs-attention → VERIFIED on the row itself (active, last check passed) and through the readiness contract — no human bothered", !!r2 && /re-verified/.test(r2) && /the connection itself re-read: active, last check passed/.test(r2) && bells.length === 1, r2 ?? "null")
    // Provider-side (retryable) failure: stays OPEN in the owner's inbox while young; a human is told past the window.
    row.test_status = "fail"; row.config = { ...row.config, last_health: { kind: "hydrate", status: "unreachable", at: at152, detail: null } }
    const now = new Date("2026-11-11T12:00:00.000Z")
    const young = await io.handleOperationFailureEscalated(asSignal(sigRow!, "2026-11-11T11:00:00.000Z"), { brokerageId: A, supabase: db }, deps(A, now))
    const old = await io.handleOperationFailureEscalated(asSignal(sigRow!, "2026-11-11T02:00:00.000Z"), { brokerageId: A, supabase: db }, deps(A, now))
    check("a provider-side failure stays OPEN for the owner's next re-read (null = not consumed, nobody told yet); past the window the admins are told", young === null && !!old && /escalated/.test(old) && bells.length === 2, `${young} || ${old}`)
    // The tenant turned it off: nothing to repair.
    row.is_active = false; row.config = { ...row.config, disconnected_at: at152 }
    const off = await io.handleOperationFailureEscalated(asSignal(sigRow!), { brokerageId: A, supabase: db }, deps(A))
    check("disconnected by the account → the watch closes (nothing to repair), no bell", !!off && /nothing to repair/.test(off) && bells.length === 2, off ?? "null")
    // TENANT ISOLATION: tenant B's inbox handed tenant A's credential id learns nothing about A's connection.
    row.is_active = true; row.config = { ...row.config, disconnected_at: null, last_health: { kind: "hydrate", status: "auth_failed", at: at152, detail: "HTTP 401" } }
    const rB = await io.handleOperationFailureEscalated({ ...asSignal(sigRow!), id: "sig-b" }, { brokerageId: B, supabase: db }, deps(B))
    const bBell = bells.filter((b) => b.brokerage === B)
    const bTickets = (db.tables.support_tickets ?? []).filter((t) => t.brokerage_id === B)
    check("TENANT B cannot read tenant A's connection incident: B's re-read is pinned to B (missing), B's bell / ticket carry nothing of A's (no label, no id, no provider state)",
      !!rB && /credential re-check: missing — no such credential on this tenant/.test(rB) && bBell.length === 1 && /no longer on your account/.test(bBell[0].body) && ![bBell[0].body, ...bTickets.map((t) => String(t.description))].some((s) => /Acme Data|c1c1c1c1|auth_failed|refused|BatchData/.test(s)),
      JSON.stringify({ rB, bBell, bTickets: bTickets.map((t) => t.description) }))
    const openForB = (db.tables.manager_signals ?? []).filter((s) => s.brokerage_id === B && s.status === "open")
    check("…and A's open signal is not in B's inbox (the bus predicate brokerage_id = B finds none)", openForB.length === 0 && (db.tables.manager_signals ?? []).some((s) => s.brokerage_id === A))
    check("positive control: the SAME re-read on tenant A does find the row (the isolation is the pin, not an empty table)", /credential re-check: needs_tenant/.test((await io.handleOperationFailureEscalated(asSignal(sigRow!), { brokerageId: A, supabase: db }, deps(A))) ?? ""))
  }

  // Secrets: a stored token / signing secret never reaches anything the tenant reads.
  {
    const withSecrets = factsOf("ok")
    const rendered = JSON.stringify(viewOf("batchdata", withSecrets)) + JSON.stringify(viewOf("batchdata", factsOf("auth_failed")))
    const f = tp.classifyTenantProviderFailure({ httpStatus: 401, message: "denied for key=tenant-token-xxxxxxxxxxxxxxxxxxxx" }, "BatchData")
    check("missing / refused keys never render a secret: no signing secret, no token fragment in any view or failure sentence (detail redacted)", !/enc:v1|aaaa:bbbb|tenant-token/.test(rendered) && !/tenant-token-x/.test(f.tenantMessage + f.detail), rendered.slice(0, 160))
    const statusMap = fnBody(actionSrc, "getTenantAcquisitionProvidersAction")
    // The object the map RETURNS (from `key, label: name` to the end of the `connection:` line) — the row-typing above it
    // legitimately names api_key as a presence bit and is not handed to the browser.
    const returned = statusMap.slice(statusMap.indexOf("key, label: name"), statusMap.indexOf("\n", statusMap.indexOf("connection: row ?")))
    check("the status object handed to the browser carries no token / signing-secret field (stripped source of the read action)", returned.length > 40 && /connection: row \?/.test(returned) && !/api_key|apiKey|webhook_secret:|webhookSecret/.test(returned.replace(/cfg\?\.webhook_secret \?/g, "")), returned.slice(0, 200))
    check("positive control: the finder flags a status object that would carry the secret", /api_key|apiKey|webhook_secret:|webhookSecret/.test("key, label: name, view, connection: row ? { accountLabel: x, apiKey: row.apiKey }") && /api_key|apiKey|webhook_secret:|webhookSecret/.test("connection: row ? { webhook_secret: cfg.webhook_secret }"))
  }

  // Honest pending states: no claim of live acquisition, of confirmation, of a retry or of a cost incurred.
  {
    const pending = [viewOf("batchdata", null), viewOf("batchdata", factsOf(null)), viewOf("batchdata", { ...factsOf("ok"), config: { ...(factsOf("ok").config as object), sandbox: true } as never }), viewOf("propertyradar", null)]
    check("pending / test / not-yet-confirmed / unsupported states claim no live connection, no confirmation, no retry, no price and nothing 'included'", pending.every((v) => v.label !== "Connected" && !/connected and confirmed|retry|\$\d|included|\bis live\b|now live/i.test(`${v.message.text} ${v.costLine ?? ""}`)), pending.map((v) => `${v.label}: ${v.message.text}`).join(" | "))
    const modSrc = stripped("lib/providers/tenant-provider-connections.ts")
    check("the module no longer promises 'retried next cycle' / 'held for tomorrow' anywhere (no replay runner exists for a parked smart-search delivery)", !/retried next cycle|held for tomorrow/.test(modSrc))
    check("positive control: the pre-fix promise is what the finder catches", /retried next cycle/.test("the queue is kept and retried next cycle"))
  }

  console.log(`\nTENANT PROVIDER CONNECTIONS — RESULT: ${passed} passed, ${failed} failed ${failed === 0 ? "✅ TENANT_PROVIDER_CONNECTIONS_PASS" : "❌ TENANT_PROVIDER_CONNECTIONS_FAIL"}`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
