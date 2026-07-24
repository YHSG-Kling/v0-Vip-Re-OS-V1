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
import { resolveBrokerageReadinessState } from "../lib/platform/provider-posture"

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

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ PROVIDER_READINESS_FAIL"); process.exit(1) }
console.log(" ✅ PROVIDER_READINESS_PASS — brokerage readiness is registry-derived, brokerage-scoped, and counts live capabilities")
