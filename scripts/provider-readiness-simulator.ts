#!/usr/bin/env tsx
/**
 * scripts/provider-readiness-simulator.ts   (npm run test:provider-readiness)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BROKERAGE PROVIDER-READINESS PANEL MUST NOT LIE. It used to read
 * brokerage_integrations RAW and mark everything not status='connected' as
 * "Pending" — blind to keyless free lanes and platform-PROVIDED providers. A
 * solo admin relying entirely on the platform's keys had zero integration rows,
 * so the panel showed 0% "nothing ready" while their whole capability set was
 * live. This proves the readiness state is now derived from the ONE canonical
 * provider registry (the same engine the fleet posture uses), scoped to the
 * brokerage, so platform-provided + keyless capabilities read LIVE.
 *
 * Two layers: (1) exhaust the REAL pure resolver's truth table (imported, not
 * re-implemented — no drift); (2) source-assert the wiring end to end.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resolveBrokerageReadinessState, getBrokerageProviderReadiness } from "../lib/platform/provider-posture"
import { PROVIDER_TENANCY, providerTenancy } from "../lib/providers/tenancy-matrix"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the REAL pure resolver — every branch, exhaustively ──")
{
  const R = resolveBrokerageReadinessState
  // A tenant's own connection always wins, regardless of scope/env/keyless.
  check("tenant connection → live_connected + ready (platform scope)",
    R({ keyless: false, scope: "platform", envConfigured: false, tenantConnected: true }).state === "live_connected")
  check("tenant connection → ready even when byo + no key",
    R({ keyless: false, scope: "tenant_byo", envConfigured: null, tenantConnected: true }).ready === true)

  // Keyless free lanes are always on (when not already tenant-connected).
  check("keyless → keyless + ready",
    R({ keyless: true, scope: "platform", envConfigured: null, tenantConnected: false }).state === "keyless" &&
    R({ keyless: true, scope: "platform", envConfigured: null, tenantConnected: false }).ready === true)

  // Platform-PROVIDED: present platform key ⇒ the tenant gets it for free.
  check("platform scope + env key present → live_platform + ready",
    R({ keyless: false, scope: "platform", envConfigured: true, tenantConnected: false }).state === "live_platform")
  check("both scope + env key present → live_platform + ready",
    R({ keyless: false, scope: "both", envConfigured: true, tenantConnected: false }).state === "live_platform")

  // BYO lanes the tenant can still switch on.
  check("tenant_byo + no key → needs_connection + NOT ready",
    R({ keyless: false, scope: "tenant_byo", envConfigured: null, tenantConnected: false }).state === "needs_connection" &&
    R({ keyless: false, scope: "tenant_byo", envConfigured: null, tenantConnected: false }).ready === false)
  check("both + no key + not connected → needs_connection",
    R({ keyless: false, scope: "both", envConfigured: false, tenantConnected: false }).state === "needs_connection")

  // Platform-scoped but the key is absent — staff's job, not the tenant's.
  check("platform scope + no key → platform_dark + NOT ready",
    R({ keyless: false, scope: "platform", envConfigured: false, tenantConnected: false }).state === "platform_dark" &&
    R({ keyless: false, scope: "platform", envConfigured: null, tenantConnected: false }).state === "platform_dark")

  // THE REGRESSION THIS FIXES: a solo admin with NO tenant connections but
  // platform keys present is NOT dark — the platform-provided rail reads live.
  check("solo admin (no connections) + platform key → still ready (the bug fix)",
    R({ keyless: false, scope: "platform", envConfigured: true, tenantConnected: false }).ready === true)
}

console.log("\n── readiness derives from the canonical registry, scoped to the brokerage ──")
{
  const pp = src("lib/platform/provider-posture.ts")
  check("getBrokerageProviderReadiness is exported", /export async function getBrokerageProviderReadiness\(/.test(pp))
  check("it builds on the canonical registry (getPlatformProviderRegistry), not a raw table read",
    /getBrokerageProviderReadiness[\s\S]*?getPlatformProviderRegistry\(\)/.test(pp))
  check("credential reads are SCOPED to the brokerage (.eq brokerage_id) across all three stores",
    (pp.match(/\.eq\("brokerage_id", brokerageId\)/g) ?? []).length >= 4)
  check("it folds in platform env presence (process.env), so platform-provided rails read live",
    /getBrokerageProviderReadiness[\s\S]*?process\.env\[/.test(pp))
  check("readiness counts LIVE capabilities (ready), not just tenant connections",
    /readinessPct:\s*rows\.length > 0 \? Math\.round\(\(ready \/ rows\.length\)/.test(pp))
}

console.log("\n── the onboarding page + panel are wired to the honest readiness ──")
{
  const page = src("app/dashboard/admin/onboarding/page.tsx")
  check("page calls getBrokerageProviderReadiness (not a raw brokerage_integrations read for the panel)",
    /getBrokerageProviderReadiness\(service, userData\.brokerage_id\)/.test(page))
  check("page passes providerReadiness to the client", /providerReadiness=\{providerReadiness\}/.test(page))

  const client = src("app/dashboard/admin/onboarding/admin-onboarding-os-client.tsx")
  check("client threads providerReadiness into ProviderReadinessPanel",
    /providerReadiness: BrokerageProviderReadiness/.test(client) && /ProviderReadinessPanel readiness=\{providerReadiness\}/.test(client))

  const panel = src("app/dashboard/admin/onboarding/components/os/provider-readiness-panel.tsx")
  check("panel renders honest per-capability state (STATE_META over readiness.rows), not binary connected/pending",
    panel.includes("STATE_META") && panel.includes("capabilities live"))
  check("panel no longer reads status === 'connected' as the only 'Ready' signal",
    !panel.includes('status === "connected"'))
}


// ── System Intelligence panel: no invented status ────────────────────────────
// The live walkthrough reported "says all providers are up but we do not have any
// configured yet". The panel defaulted `enabled ?? true` with no override row on file,
// so a tenant that had configured NOTHING read as fully active. It now reads the SAME
// credential-backed evaluator as the onboarding panel — one notion of provider status,
// not two.
{
  const sys = src("app/dashboard/system/components/os/provider-health-panel.tsx")
  check("System Intelligence reads the canonical getBrokerageProviderReadiness",
    /getBrokerageProviderReadiness\(svc, brokerageId\)/.test(sys))
  check("it no longer defaults an unconfigured provider to enabled (the 'all up' bug)",
    !/enabled: override\?\.enabled \?\? true/.test(sys) && !/getProviderStatus/.test(sys))
  check("it no longer carries its own hardcoded provider list",
    !/default: 'sendgrid'/.test(sys) && !/providerTypes/.test(sys))
  check("it separates the broker's work from platform staff's work",
    /needsConnection/.test(sys) && /platformDark/.test(sys))
  check("it counts usable-right-now from the evaluator, not from an assumption",
    /readiness\.ready\}\/\{readiness\.total/.test(sys))
}

// ── WHOSE JOB IS IT? — the tenancy matrix decides, not the scope fold ────────
//
// getPlatformProviderRegistry folds PROVIDER_TENANCY's five ownership models
// into a platform/tenant boolean pair. That fold is lossy: `byo_top_tier` — an
// enterprise escape hatch the matrix scopes to the multi_location tier — landed
// in the same bucket as `user_oauth`, so Twilio, whose product promise is
// literally "a tenant never touches a Twilio signup", was rendered to brokers as
// "Connect · waiting on you". lib/providers/tenancy-matrix.ts:providerTenancy is
// the lookup back to the ruling, and the readiness surface now uses it.
//
// These assert the PROPERTY — "a lane the tenant cannot initiate is never
// reported as the tenant's move" — end to end through the real function, not
// the presence of any particular line of code. A correct consolidation that
// moves the code keeps passing; a regression that re-derives tenancy from the
// fold fails no matter how it is spelled.
console.log("\n── whose job is it: the tenancy matrix, not the platform/tenant fold ──")
{
  const R = resolveBrokerageReadinessState

  // The pure branch: an explicitly non-actionable lane is staff's, not the broker's.
  check("tenant-scoped lane + tenantActionable:false + no key → platform_dark (staff's job)",
    R({ keyless: false, scope: "both", envConfigured: false, tenantConnected: false, tenantActionable: false }).state === "platform_dark" &&
    R({ keyless: false, scope: "tenant_byo", envConfigured: null, tenantConnected: false, tenantActionable: false }).state === "platform_dark")
  check("tenantActionable omitted or true keeps the pre-existing needs_connection branch",
    R({ keyless: false, scope: "both", envConfigured: false, tenantConnected: false }).state === "needs_connection" &&
    R({ keyless: false, scope: "both", envConfigured: false, tenantConnected: false, tenantActionable: true }).state === "needs_connection")
  check("a non-actionable lane the tenant HAS connected still reads live_connected",
    R({ keyless: false, scope: "both", envConfigured: false, tenantConnected: true, tenantActionable: false }).state === "live_connected")

  // The matrix is the authority, and it says something for Twilio specifically.
  const twilio = providerTenancy("twilio")
  check("providerTenancy('twilio') returns the matrix row (the lookup is reachable)",
    !!twilio && twilio.provider === "twilio")
  check("Twilio's matrix models carry NO tenant-initiated model (platform-provisioned + BYO top tier only)",
    !!twilio && !twilio.models.some((m) => m === "user_oauth" || m === "tenant_optional_key"))
  check("providerTenancy returns null for a name with no ruling (so callers keep prior behaviour)",
    providerTenancy("definitely-not-a-provider") === null)
}

// END TO END through the real readiness function, against a client that returns
// zero credential rows (pre-rollout truth: the tables ARE empty).
{
  const q: any = {
    select: () => q, eq: () => q, in: () => q, gte: () => q, lt: () => q,
    order: () => q, limit: () => q, maybeSingle: () => q,
    then: (onOk: any, onErr?: any) => Promise.resolve({ data: [], error: null }).then(onOk, onErr),
  }
  const svc: any = { from: () => q }

  const readiness = await getBrokerageProviderReadiness(svc, "00000000-0000-0000-0000-000000000000")
  const byProvider = new Map(readiness.rows.map((r) => [r.provider, r]))

  check("the readiness sweep produced rows for the whole registry", readiness.rows.length > 0)

  // THE PROPERTY: every provider the matrix rules is NOT tenant-initiated must
  // never be reported as work the broker can do. Checked over the real matrix,
  // so a new row obeys it automatically.
  const misattributed = PROVIDER_TENANCY
    .filter((t) => !t.models.some((m) => m === "user_oauth" || m === "tenant_optional_key"))
    .map((t) => byProvider.get(t.provider))
    .filter((row): row is NonNullable<typeof row> => !!row && row.state === "needs_connection")
    .map((row) => row.provider)
  check(`no platform-provisioned provider is reported as the broker's move${misattributed.length ? ` (found: ${misattributed.join(", ")})` : ""}`,
    misattributed.length === 0)

  // The mirror: a provider the matrix DOES let a tenant initiate keeps its
  // connect affordance whenever it is not already live.
  const tenantInitiated = PROVIDER_TENANCY
    .filter((t) => t.models.some((m) => m === "user_oauth" || m === "tenant_optional_key"))
    .map((t) => byProvider.get(t.provider))
    .filter((row): row is NonNullable<typeof row> => !!row)
  check("tenant-initiated providers are either already live or offered as a connection",
    tenantInitiated.length > 0 &&
    tenantInitiated.every((row) => row.ready || row.state === "needs_connection"))

  // Notes are the sentence a broker reads; a state must never be noteless.
  check("every readiness row carries a non-empty note",
    readiness.rows.every((r) => typeof r.note === "string" && r.note.trim().length > 0))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ PROVIDER_READINESS_FAIL"); process.exit(1) }
console.log(" ✅ PROVIDER_READINESS_PASS — brokerage readiness is registry-derived, brokerage-scoped, and counts live capabilities")
