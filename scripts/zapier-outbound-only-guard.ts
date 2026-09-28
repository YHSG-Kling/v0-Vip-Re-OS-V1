#!/usr/bin/env tsx
/**
 * scripts/zapier-outbound-only-guard.ts   (npm run test:zapier-outbound-only) — pure, no network, no DB.
 *
 * WAVE 87 (lane 87A). Owner, verbatim: "zapier zaps are only allowed out from this platform,
 * never to the platform."
 *
 *   Z1 the inbound door is GONE — no route under app/api names zapier; the webhook contract has
 *      no zapier row; no runtime code reads ZAPIER_WEBHOOK_SECRET or resolves a tenant from
 *      global_settings.zapier_api_key; no scheduler (vercel.json, CRON_REGISTRY) names it.
 *      POSITIVE CONTROLS: each finder flags a specimen of the retired shape.
 *   Z2 the tombstone names the retired file AND the outbound survivor, and the survivor exists.
 *   Z3 OUTBOUND survives — a Zap's Catch Hook URL is a legal endpoint, and postSignedWebhook
 *      (driven with a stubbed fetch) POSTs the signed event to it; our own User-Agent does not
 *      trip the inbound refusal.
 *   Z4 the direction rule — isZapierInbound on real Zapier User-Agents / source labels, and the
 *      non-Zapier negatives.
 *   Z5 enforcement at the ingress doors a Zap could still be aimed at — the workflow trigger
 *      refuses (403, run: the POST handler is invoked) BEFORE any lookup; the Agentic API token
 *      path refuses before the token lookup.
 *   Z6 registration.
 *
 * Owner: data_steward (the webhook contract's owner). Co-owner named in prose: campaign_orchestrator
 * (the workflow trigger fabric and its inbound-events reader).
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"

const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* not resolvable — nothing to shim */ }

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(p, "utf8")

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// ── Z1 ────────────────────────────────────────────────────────────────────────
console.log("\n[Z1 · the inbound Zapier door is gone]")
const apiRoutes = walk("app/api").filter((p) => /route\.tsx?$/.test(p))
const zapierRoute = (p: string) => /zapier/i.test(p)
check(`no route under app/api names zapier (${apiRoutes.length} routes scanned)`, apiRoutes.length > 0 && !apiRoutes.some(zapierRoute), apiRoutes.filter(zapierRoute).join(", "))
check("POSITIVE CONTROL: the route finder flags the retired path", zapierRoute("app/api/webhooks/zapier/route.ts"))
const { WEBHOOK_CONTRACT } = await import("../lib/providers/webhook-contract")
check(`the inbound webhook contract carries no zapier row (${WEBHOOK_CONTRACT.length} rows)`,
  WEBHOOK_CONTRACT.length > 0 && !WEBHOOK_CONTRACT.some((e) => /zapier/i.test(`${e.provider} ${e.path} ${e.routeFile}`)))
const runtime = [...walk("app"), ...walk("lib")]
const SECRET_READ = /process\.env\.ZAPIER_WEBHOOK_SECRET|process\.env\[\s*["']ZAPIER_WEBHOOK_SECRET["']\s*\]/
const KEY_LOOKUP = /\.eq\(\s*["']zapier_api_key["']/
const secretReaders = runtime.filter((p) => SECRET_READ.test(stripComments(read(p))))
const keyLookups = runtime.filter((p) => KEY_LOOKUP.test(stripComments(read(p))))
check(`no runtime code reads ZAPIER_WEBHOOK_SECRET (${runtime.length} app/lib files, comment-stripped)`, secretReaders.length === 0, secretReaders.join(", "))
check("no runtime code resolves a tenant from global_settings.zapier_api_key (86F's inbound lookup)", keyLookups.length === 0, keyLookups.join(", "))
check("POSITIVE CONTROL: both finders flag the retired route's shapes",
  SECRET_READ.test(`const secret = process.env.ZAPIER_WEBHOOK_SECRET`) && KEY_LOOKUP.test(`svc.from("global_settings").select("brokerage_id").eq("zapier_api_key", key)`))
check("NEGATIVE CONTROL: a tombstone naming the secret is not a reader (stripped)",
  !SECRET_READ.test(stripComments(`// the route read process.env.ZAPIER_WEBHOOK_SECRET — retired\nconst x = 1`)))
const envActive = read(".env.example").split("\n").filter((l) => /^\s*ZAPIER_WEBHOOK_SECRET\s*=/.test(l))
check(".env.example no longer documents an active ZAPIER_WEBHOOK_SECRET", envActive.length === 0)
const vercel = read("vercel.json")
const { CRON_REGISTRY } = await import("../lib/kernel/cron-dispatch")
check("no scheduler names a zapier path (vercel.json, CRON_REGISTRY)", !/zapier/i.test(vercel) && !CRON_REGISTRY.some((e) => /zapier/i.test(e.path)))

// ── Z2 ────────────────────────────────────────────────────────────────────────
console.log("\n[Z2 · the tombstone names the retired file and the outbound survivor]")
const contractRaw = read("lib/providers/webhook-contract.ts")
check("the tombstone names app/api/webhooks/zapier/route.ts and its survivor drainTenantWebhookDeliveries / postSignedWebhook",
  /TOMBSTONE[\s\S]{0,400}app\/api\/webhooks\/zapier\/route\.ts/.test(contractRaw) && /drainTenantWebhookDeliveries/.test(contractRaw) && /postSignedWebhook/.test(contractRaw))
const survivor = blankStrings(stripComments(read("lib/platform/tenant-webhooks.ts")))
check("the survivor is live code (both exports exist, comment-stripped)",
  /export async function drainTenantWebhookDeliveries\(/.test(survivor) && /export async function postSignedWebhook\(/.test(survivor))

// ── Z3 ────────────────────────────────────────────────────────────────────────
console.log("\n[Z3 · OUTBOUND to a Zap survives]")
const actions = stripComments(read("app/actions/tenant-webhooks.ts"))
const validator = actions.slice(actions.indexOf("function validateEndpointUrl("), actions.indexOf("\n}\n", actions.indexOf("function validateEndpointUrl(")))
check("the endpoint validator admits any http(s) URL — a hooks.zapier.com Catch Hook is not refused", validator.length > 0 && !/zapier/i.test(validator) && /https:/.test(validator))
{
  const tw = await import("../lib/platform/tenant-webhooks")
  const realFetch = globalThis.fetch
  const seen: Array<{ url: string; init: any }> = []
  globalThis.fetch = (async (url: any, init: any) => { seen.push({ url: String(url), init }); return new Response("ok", { status: 200 }) }) as typeof fetch
  try {
    const r = await tw.postSignedWebhook({
      url: "https://hooks.zapier.com/hooks/catch/1234567/abcdef/",
      secret: "whsec_test", event: "contact.created", deliveryId: "d-1",
      payload: { id: "e-1", event: "contact.created", occurred_at: "2026-09-28T00:00:00Z", data: {} } as any,
    })
    const h = seen[0]?.init?.headers ?? {}
    check("postSignedWebhook POSTs the SIGNED event to the Zap's Catch Hook URL (stubbed fetch — no network)",
      r.ok === true && seen.length === 1 && seen[0].url.startsWith("https://hooks.zapier.com/") && seen[0].init.method === "POST" && typeof h["X-Webhook-Signature"] === "string")
    const { isZapierInbound } = await import("../lib/integrations/zapier-direction")
    check("our own outbound User-Agent does not identify as Zapier (no self-refusal)", !isZapierInbound({ userAgent: h["User-Agent"] }))
  } finally {
    globalThis.fetch = realFetch
  }
}
const dev = read("app/settings/developers/developers-client.tsx")
check("the developers page tells the tenant how to connect a Zap OUTBOUND (Catch Hook URL)", /Catch Hook/.test(dev) && /outbound only/.test(dev))

// ── Z4 ────────────────────────────────────────────────────────────────────────
console.log("\n[Z4 · the direction rule]")
const { isZapierInbound, ZAPIER_INBOUND_REFUSAL } = await import("../lib/integrations/zapier-direction")
const POS: Array<[string, Parameters<typeof isZapierInbound>[0]]> = [
  ["UA 'Zapier'", { userAgent: "Zapier" }],
  ["UA 'zapier-platform-core/15.0.0'", { userAgent: "zapier-platform-core/15.0.0" }],
  ["UA 'Mozilla/5.0 (compatible; ZapierBot)'", { userAgent: "Mozilla/5.0 (compatible; ZapierBot)" }],
  ["source 'zapier'", { userAgent: "curl/8", source: "zapier" }],
  ["source 'Zapier_Lead'", { userAgent: null, source: "Zapier_Lead" }],
]
for (const [n, r] of POS) check(`POSITIVE: ${n} → inbound Zap (refused)`, isZapierInbound(r))
const NEG: Array<[string, Parameters<typeof isZapierInbound>[0]]> = [
  ["UA 'VIP-RE-OS-Webhooks/1.0'", { userAgent: "VIP-RE-OS-Webhooks/1.0" }],
  ["UA 'GoHighLevel' + source 'ghl'", { userAgent: "GoHighLevel", source: "ghl" }],
  ["no UA, source 'qr'", { userAgent: undefined, source: "qr" }],
]
for (const [n, r] of NEG) check(`NEGATIVE: ${n} → not a Zap`, !isZapierInbound(r))
check("the refusal names the outbound path", /outbound-only/.test(ZAPIER_INBOUND_REFUSAL) && /Catch Hook/.test(ZAPIER_INBOUND_REFUSAL))

// ── Z5 ────────────────────────────────────────────────────────────────────────
console.log("\n[Z5 · enforcement at the ingress doors]")
const trig = blankStrings(stripComments(read("app/api/workflow/trigger/route.ts")))
const zAt = trig.indexOf("isZapierInbound(")
check("workflow trigger asks the rule BEFORE the service client, the tenant-secret lookup and any write",
  zAt > -1 && zAt < trig.indexOf("createServiceClient()") && zAt < trig.indexOf("secretsMatch(token") && zAt < trig.indexOf(".insert("))
{
  const { POST } = await import("../app/api/workflow/trigger/route")
  const { NextRequest } = await import("next/server")
  const mk = (ua: string, body: Record<string, unknown>) => new NextRequest("https://example.test/api/workflow/trigger", {
    method: "POST", headers: { authorization: "Bearer whsec_any", "user-agent": ua, "content-type": "application/json" }, body: JSON.stringify(body),
  })
  const res = await POST(mk("Zapier", { event: "lead.created", brokerageId: "00000000-0000-0000-0000-000000000001" }))
  const j = await res.json() as { error?: string }
  check("RUN: a Zap POSTing the trigger is refused 403 with the outbound-only sentence", res.status === 403 && j.error === ZAPIER_INBOUND_REFUSAL, `${res.status} ${JSON.stringify(j)}`)
  const res2 = await POST(mk("curl/8", { event: "lead.created", brokerageId: "b", source: "zapier" }))
  check("RUN: a caller LABELLED source 'zapier' is refused 403 too", res2.status === 403)
  // NEGATIVE CONTROL: a non-Zapier caller passes the rule and reaches the (env-less) auth path —
  // i.e. the 403 above is the rule, not a door that refuses everyone.
  let reached = false, status = 0
  try { const r3 = await POST(mk("GoHighLevel", { event: "lead.created", brokerageId: "b" })); status = r3.status; reached = r3.status !== 403 } catch { reached = true }
  check("NEGATIVE CONTROL: a GHL caller is NOT refused by the Zapier rule", reached, `status ${status}`)
}
const creds = blankStrings(stripComments(read("lib/agentic-os/agent-credentials.ts")))
const callerAt = creds.indexOf("export async function resolveAgenticCaller(")
const callerFn = creds.slice(callerAt)
check("Agentic API: a token call identifying as a Zap authenticates as nobody, BEFORE the token lookup",
  callerFn.indexOf("isZapierInbound(") > -1 && callerFn.indexOf("isZapierInbound(") < callerFn.indexOf("resolveAgentToken(raw)")
    && /isZapierInbound\(\{ userAgent: req\.headers\.get\(/.test(callerFn))

// ── Z6 ────────────────────────────────────────────────────────────────────────
console.log("\n[Z6 · registration]")
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
check("package.json registers test:zapier-outbound-only", pkg.scripts["test:zapier-outbound-only"] === "tsx scripts/zapier-outbound-only-guard.ts")
const guard = pkg.scripts.guard ?? ""
check("the guard chain runs it AFTER test:scrapers", guard.indexOf("npm run test:scrapers") >= 0 && guard.indexOf("npm run test:zapier-outbound-only") > guard.indexOf("npm run test:scrapers"))
const { MAINTENANCE_DOMAINS } = await import("../lib/kernel/manager-registry")
check("MAINTENANCE_DOMAINS owns it", Object.values(MAINTENANCE_DOMAINS).some((d: any) => d.proof === "test:zapier-outbound-only"))

console.log(`\n  denominators: ${apiRoutes.length} api routes · ${runtime.length} app/lib runtime files · ${WEBHOOK_CONTRACT.length} contract rows · ${POS.length} positive / ${NEG.length} negative direction cases · 2 ingress doors enforced`)
console.log("  blind spots: a Zap that overrides its User-Agent AND omits a zapier source label is indistinguishable from any HTTP client; provider-console drift (a Zap still pointed at the deleted URL) is repo-invisible — it now gets 404; global_settings.zapier_api_key stays a column (live: 0 rows) with no reader or writer — dropping it is an integrator/owner migration call; the 2 ingress doors are the ones a tenant can hand a Zap a credential for — any other public POST route is not scanned for the rule")
console.log("\n" + "─".repeat(50))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log(failed === 0 ? " ✅ ZAPIER_OUTBOUND_ONLY_PASS" : " ❌ ZAPIER_OUTBOUND_ONLY_FAIL")
if (failed) for (const f of failures) console.log(`   · ${f}`)
process.exit(failed === 0 ? 0 : 1)
