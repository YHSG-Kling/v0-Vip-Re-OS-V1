/**
 * scripts/provider-waterfall-guard.ts — THE CAPABILITY-FIRST WATERFALL, DORMANT ADAPTERS, EXISTING-ADAPTER AUDIT (wave 150,
 * lane 150HIAB; directive 150H + 150I, owner ruling R9, canary 9). npm run test:provider-waterfall (key listed for 150I2).
 *
 *   A  planProviderWaterfall (lib/providers/provider-scorecard.ts) rides routeCapability: live = the route table's order
 *      minus failing providers minus providers that sell none of the MISSING fields; nothing missing → no call; a provider
 *      pending rights never appears live and appears offline only with mayCallLive=false; a seller score has NO live
 *      provider today (every seller score is a dormant vendor's);
 *   B  dormancy by construction: every dormant-pending-rights provider is ABSENT from CONTACT_PROVIDER_ROUTES, and the
 *      dormant modules carry no transport (no fetch / SDK / credential read / vendor host / client import) — read from
 *      STRIPPED source, with planted positive controls; the wave-149 R19 canary's own two regexes stay clean on them;
 *   C  documented-fields mapping (lib/providers/dormant-adapters.ts): a Tracerfy skip trace never yields a seller score
 *      (canary 9), DataZapp's 0x–4x label is labelled in its own unit and a "5x" refused, PropertyRadar's Purchase=0
 *      totalResultCount is a free preview, DistressScore outside 0–100 refused, Data Axle refused (no documented fields),
 *      undocumented keys land in unmappedKeys — never in a field;
 *   D  the 150H audit of the EXISTING acquisition adapters (BatchData pooled quicklists, ArcGIS / Socrata permits, Apify
 *      FSBO, Zyte, ZenRows, scraper health): each claimed cursor / rate limit / failure path / paid gate is a symbol that
 *      must exist in that file's stripped source — an audit that cannot lie about the code it cites;
 *   E  C35 hygiene (lane-150EFG Outside-lane 3): the BatchData buy-box and Exa id fallbacks key on content, never the
 *      clock — the same row twice yields the same id.
 *
 * BLIND SPOTS (published): Apify / Zyte / ZenRows have NO incremental source cursor — re-delivered rows are deduplicated by
 * the C35 idempotency key AFTER they are paid for (a cost leak, Still open); the per-territory cron pulls are not behind the
 * approval gate (cron outside this lane); the Tracerfy / DataZapp mappers can only map the keys the pages read named.
 */
import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { createRequire } from "node:module"
import { stripComments } from "./strip-comments"

const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* not installed */ }

const ROOT = process.cwd()
let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const stripped = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))

async function main() {
  const sc = await import("../lib/providers/provider-scorecard")
  const { CONTACT_PROVIDER_ROUTES } = await import("../lib/ai-isa/property-lookup-rail")
  const { mapDormantProviderResponse } = await import("../lib/providers/dormant-adapters")

  console.log("\nA — the capability-first waterfall rides the one router")
  const live = sc.planProviderWaterfall({ capability: "owner_contact", missingFields: ["owner_phone"], mode: "live" })
  const order = live.steps.map((s) => s.provider)
  const routeOrder = CONTACT_PROVIDER_ROUTES.owner_contact.map((e) => e.provider).filter((p) => order.includes(p as any))
  check("live order is the route table's order (versium → batchdata), every step live-callable", order.join(">") === "versium>batchdata" && JSON.stringify(order) === JSON.stringify(routeOrder) && live.steps.every((s) => s.mayCallLive && s.source === "route_table"), order.join(">"))
  check("a provider that sells none of the missing fields is skipped with that reason (PeopleData has no phone row)", live.skipped.some((s) => s.provider === "peopledata" && /none of the missing/.test(s.reason)))
  check("providers pending rights are skipped LIVE with the activation reason", ["tracerfy", "datazapp", "propertyradar"].every((p) => live.skipped.some((s) => s.provider === p && /blocks activation/.test(s.reason))))
  check("the dormant survivor is flagged as live only until the owner closes its doors", live.steps.find((s) => s.provider === "batchdata")?.why.includes("dormant survivor") === true)
  const off = sc.planProviderWaterfall({ capability: "owner_contact", missingFields: ["owner_phone"], mode: "offline_simulation" })
  check("offline simulation adds the dormant candidates — mayCallLive=false (licence unknown blocks activation, not testing)", ["tracerfy", "datazapp", "propertyradar"].every((p) => off.steps.some((s) => s.provider === p && s.source === "dormant_candidate" && s.mayCallLive === false)))
  check("nothing missing → no provider is asked", sc.planProviderWaterfall({ capability: "owner_contact", missingFields: [], mode: "live" }).noCallReason !== null)
  const failing = sc.planProviderWaterfall({ capability: "owner_contact", missingFields: ["owner_email"], mode: "live", health: { versium: { state: "failing", routeAround: true, reason: "5xx streak" } } })
  check("a failing provider is routed around through routeCapability, with its reason", failing.steps[0]?.provider === "batchdata" && failing.skipped.some((s) => s.provider === "versium" && /provider_failing/.test(s.reason)))
  const seller = sc.planProviderWaterfall({ capability: "seller_signal_score", missingFields: ["seller_signal"], mode: "live" })
  check("a seller score has NO live provider today — no call, with the reason", seller.steps.length === 0 && /no active, licensed provider/.test(seller.noCallReason ?? ""))
  const sellerOff = sc.planProviderWaterfall({ capability: "seller_signal_score", missingFields: ["seller_signal"], mode: "offline_simulation" })
  check("offline: Tracerfy and DataZapp are the seller-score candidates (the matched pair), never live", ["tracerfy", "datazapp"].every((p) => sellerOff.steps.some((s) => s.provider === p && !s.mayCallLive)))

  console.log("\nB — dormant by construction (no route row, no transport)")
  const pending = (Object.keys(sc.PROVIDER_ACTIVATION) as Array<keyof typeof sc.PROVIDER_ACTIVATION>).filter((p) => sc.PROVIDER_ACTIVATION[p].state === "dormant_pending_rights")
  const pendingRouted = (routes: Record<string, ReadonlyArray<{ provider: string }>>) => {
    const routed = new Set(Object.values(routes).flat().map((e) => e.provider))
    return pending.filter((p) => routed.has(p))
  }
  check(`every provider pending rights (${pending.join(", ")}) is absent from CONTACT_PROVIDER_ROUTES`, pending.length === 4 && pendingRouted(CONTACT_PROVIDER_ROUTES as any).length === 0)
  check("positive control: a planted route row for tracerfy is seen", pendingRouted({ ...(CONTACT_PROVIDER_ROUTES as any), owner_contact: [...CONTACT_PROVIDER_ROUTES.owner_contact, { provider: "tracerfy" }] }).join() === "tracerfy")
  const TRANSPORT = /\bfetch\s*\(|process\.env\b|https?:\/\/|createServiceClient|from\s+["']@\/lib\/external\/|new\s+[A-Z][A-Za-z]*Client\s*\(/
  const DORMANT_FILES = ["lib/providers/provider-scorecard.ts", "lib/providers/dormant-adapters.ts", "lib/providers/provider-pilot.ts"]
  for (const f of DORMANT_FILES) check(`${f}: no transport in stripped source`, !TRANSPORT.test(stripped(f)), (stripped(f).match(TRANSPORT) ?? [""])[0])
  check("positive control: a planted fetch / env read is seen", TRANSPORT.test(stripComments(`const r = await fetch(u, { headers: { a: process.env.X } })`)) && !TRANSPORT.test(stripComments(`// fetch( process.env.X https://x\nexport const y = 1`)))
  // The wave-149 R19 canary (scripts/wave149-canaries.ts) — its own two regexes, verbatim, over these files.
  const VENDOR_FILE = /datazapp|tracerf[l]?y|amcards/i
  const TRACE = /process\.env\.(DATAZAPP_[A-Z_]+|TRACERFY_[A-Z_]+|AMCARDS_[A-Z_]+)\b|["'`]https?:\/\/(?:[a-z0-9-]+\.)*(?:datazapp\.com|tracerfy\.com|tracerfly\.com|amcards\.com)/i
  check("the wave-149 R19 regexes stay clean: no vendor-named file, no credential read, no vendor host", DORMANT_FILES.every((f) => !VENDOR_FILE.test(f) && !TRACE.test(stripped(f))))

  console.log("\nC — documented-fields mapping")
  const at = "2026-11-06T00:00:00.000Z"
  const trace = mapDormantProviderResponse("tracerfy_skip_trace", { hit: true, credits_deducted: 1, seller_score: 88, phones: [] }, at)
  check("canary 9: a Tracerfy SKIP TRACE never yields a seller score, even with a score-looking key", trace.sellerSignals.length === 0 && trace.unmappedKeys.includes("seller_score") && trace.billing.hit === true && trace.billing.creditsDeducted === 1)
  const lb = mapDormantProviderResponse("tracerfy_lead_builder", { hit: true, credits_deducted: 5, scores: { sell: 71 } }, at)
  check("Lead Builder: the score's key is undocumented → nothing labelled, refusal says why", lb.sellerSignals.length === 0 && lb.refusals.some((r) => /not documented/.test(r)))
  const dz = mapDormantProviderResponse("datazapp_demographic", { Signal_Seller_Score: "3X", LOR: 12, Ethnicity: "x" }, at)
  check("DataZapp Signal_Seller_Score labelled in its OWN unit (0x–4x), probability null", dz.sellerSignals.length === 1 && dz.sellerSignals[0].name === "datazapp_signal_seller_score" && dz.sellerSignals[0].value === "3x" && dz.sellerSignals[0].probability === null && dz.fields.length_of_residence === 12)
  check("a column the capability does not need is NOT stored by this adapter (unmapped, not blocked)", dz.unmappedKeys.includes("Ethnicity") && !("Ethnicity" in dz.fields))
  check("a '5x' DataZapp label is refused (outside the documented labels)", mapDormantProviderResponse("datazapp_demographic", { Signal_Seller_Score: "5x" }, at).refusals.some((r) => /not one of/.test(r)))
  const pr = mapDormantProviderResponse("propertyradar_search_preview", { results: [], resultCount: 0, totalResultCount: 1234, quantityFreeRemaining: 250 }, at)
  check("PropertyRadar Purchase=0 totalResultCount → a free preview count, zero credits", pr.preview?.count === 1234 && pr.billing.creditsDeducted === 0)
  check("PropertyRadar DistressScore 72 labelled (0–100); 140 refused", mapDormantProviderResponse("propertyradar_property", { RadarID: "P1", DistressScore: 72 }, at).sellerSignals[0]?.value === 72 && mapDormantProviderResponse("propertyradar_property", { DistressScore: 140 }, at).refusals.length === 1)
  check("Data Axle: no documented fields → refused, nothing mapped", mapDormantProviderResponse("data_axle_people", { anything: 1 }, at).refusals.some((r) => /no field-level documentation/.test(r)))

  console.log("\nD — the 150H audit of the existing acquisition adapters (every cited symbol must exist)")
  const AUDIT: Array<{ adapter: string; claims: Array<{ what: string; file: string; symbol: string }> }> = [
    { adapter: "BatchData pooled quicklists", claims: [
      { what: "incremental cursor: request-side date window per trigger (lookbackDays)", file: "lib/external/batchdata-client.ts", symbol: "export function dateWindowCriteria" },
      { what: "incremental cursor: client-side listing-status window", file: "lib/external/batchdata-client.ts", symbol: "export function withinListingStatusWindow" },
      { what: "rate limit: vendor take / in-list limits", file: "lib/external/batchdata-client.ts", symbol: "export const BATCHDATA_POOLED_MAX_TAKE" },
      { what: "failure: a failed chunk is reported, costs nothing, never throws", file: "lib/lead-pipeline/pooled-pull.ts", symbol: "pooled ${pool.trigger} pull for" },
      { what: "paid gate: the approved acquisition plan", file: "lib/lead-pipeline/pooled-pull.ts", symbol: "deps.approval(w.territory.brokerage_id, lane)" },
      { what: "paid gate: dollar backpressure", file: "lib/lead-pipeline/pooled-pull.ts", symbol: "decideSpendBackpressure(" },
    ] },
    { adapter: "ArcGIS permits", claims: [
      { what: "incremental cursor: issued-date >= since", file: "lib/external/arcgis-permits.ts", symbol: "export function buildArcgisDateWhere" },
      { what: "failure: the service's own error payload is read", file: "lib/external/arcgis-permits.ts", symbol: "export function readArcgisError" },
    ] },
    { adapter: "Socrata permits", claims: [
      { what: "incremental cursor: $where on an ISO day", file: "lib/external/socrata-client.ts", symbol: "export function isIsoCalendarDay" },
      { what: "the recent-permits query", file: "lib/external/socrata-client.ts", symbol: "export async function recentPermits" },
    ] },
    { adapter: "Apify FSBO", claims: [
      { what: "rate / size: maxItems per run", file: "lib/external/apify-client.ts", symbol: "maxItems: params.limit" },
      { what: "pooled locations per run", file: "lib/lead-pipeline/pooled-pull.ts", symbol: "export const APIFY_POOLED_LOCATIONS_PER_RUN" },
    ] },
    { adapter: "Zyte", claims: [
      { what: "unconfigured → no call", file: "lib/external/zyte-client.ts", symbol: "export function zyteConfigured" },
      { what: "documented per-request cost", file: "lib/external/zyte-client.ts", symbol: "export function estimateZyteCost" },
    ] },
    { adapter: "ZenRows", claims: [
      { what: "failure: fallback provider order", file: "lib/external/zenrows-client.ts", symbol: "export function scrapeProviderOrder" },
      { what: "failure: retry with the Apify fallback", file: "lib/external/zenrows-client.ts", symbol: "export async function retryWithApifyFallback" },
    ] },
    { adapter: "scraper health (all scrapers)", claims: [
      { what: "failure escalation threshold → a healer proposal", file: "lib/lead-pipeline/scraper-health.ts", symbol: "export async function escalateScraperFailureIfNeeded" },
      { what: "provider health cool-down the router reads", file: "lib/agentic-os/connector-gateway.ts", symbol: "export const PROVIDER_HEALTH_POLICY" },
    ] },
  ]
  for (const a of AUDIT) {
    const bad = a.claims.filter((c) => !existsSync(join(ROOT, c.file)) || !stripped(c.file).includes(c.symbol))
    check(`${a.adapter}: ${a.claims.length} cited claims exist in stripped source`, bad.length === 0, bad.map((c) => `${c.file} ∌ ${c.symbol}`).join("; "))
  }
  check("positive control: a claim citing a symbol that is not there is caught", !stripped("lib/external/zyte-client.ts").includes("export function zyteIncrementalCursor"))

  console.log("\nE — C35 hygiene: content-keyed id fallbacks")
  const bd = stripped("lib/external/batchdata-client.ts")
  const exa = stripped("lib/external/exa-client.ts")
  check("BatchData buy-box id falls back to stableContentDigest, not Date.now()", /batchdata-buybox-\$\{idSlug \|\| stableContentDigest\(row\)\}/.test(bd) && !/batchdata-buybox-\$\{idSlug \|\| Date\.now\(\)\}/.test(bd))
  check("Exa id falls back to stableContentDigest, not Date.now()/Math.random()", /exa-\$\{stableContentDigest\(r\)\}/.test(exa) && !/Date\.now\(\)\}-\$\{Math\.random\(\)/.test(exa))
  const { normalizeExaRow } = await import("../lib/external/exa-client")
  const row = { title: "Moving to Austin", text: "we plan to buy" }
  check("the same id-less Exa row twice → the same id (replay is one observation)", normalizeExaRow(row).id === normalizeExaRow({ ...row }).id && normalizeExaRow(row).id !== normalizeExaRow({ ...row, title: "x" }).id)

  console.log(`\nPROVIDER WATERFALL — RESULT: ${passed} passed, ${failed} failed ${failed === 0 ? "✅ PROVIDER_WATERFALL_PASS" : "❌ PROVIDER_WATERFALL_FAIL"}`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
