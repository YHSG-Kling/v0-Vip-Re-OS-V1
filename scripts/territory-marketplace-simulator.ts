#!/usr/bin/env tsx
/**
 * scripts/territory-marketplace-simulator.ts   (npm run test:territory-marketplace)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TERRITORY MARKETPLACE (owner round 40, rec 4) — proves the public
 * /pricing territory read is anonymized, floored, honest, and keep-one:
 *
 *   1. ANONYMIZATION LOCK — the public payload is EXACTLY
 *      { zip, city, state, leadCount, periodLabel }: no tenant ids, no tenant
 *      names, no claimedBy — checked structurally AND by serializing a fixture
 *      with a named claimant and asserting the name/uuid never appear.
 *   2. THRESHOLD FLOOR — a zip needs ≥ MARKETPLACE_MIN_LEADS platform leads to
 *      be listed; sub-threshold volume is never leaked (not even in "no_volume").
 *   3. THREE HONEST STATES — available (unclaimed, count shown) / served
 *      (claimed — NO numbers) / no_volume (unclaimed, below bar) + invalid guard.
 *   4. CLAIMED-ZIP VOLUME NEVER EXPOSED — a claimed zip's count is absent from
 *      every serialized public shape (it's the subscriber's business).
 *   5. KEEP-ONE — counting comes from lib/analytics/territory-coverage's board
 *      (composeCoverageBoard / loadCoverageBoard); the marketplace lib performs
 *      NO lead/claim queries of its own (source grep).
 *   6. PREFILL CARRY — cleanCarriedZip validation + source greps: /pricing CTA →
 *      /signup?zip= → billing_metadata.signup_intent → market-setup suggestion,
 *      and NOTHING in the signup action auto-creates a market or claim.
 *
 * Pure fixtures only — no DB required.
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* nothing to shim */ }

import { composeCoverageBoard, type CoverageInputs } from "../lib/analytics/territory-coverage"
import {
  composeMarketplaceSnapshot,
  lookupZipAvailability,
  cleanCarriedZip,
  MARKETPLACE_MIN_LEADS,
  MARKETPLACE_TEASER_LIMIT,
} from "../lib/platform/territory-marketplace"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

// ─── Fixture: one active claimant, one stale claimant, mixed zip volume ──────

const TENANT_A_ID = "aaaaaaaa-1111-2222-3333-444444444444" // active — claims 78701
const TENANT_B_ID = "bbbbbbbb-5555-6666-7777-888888888888" // cancelled — stale claim on 78702
const TENANT_A_NAME = "Acme Premier Realty"
const TENANT_B_NAME = "Bygone Brokerage"

const platformLead = (zip: string, state = "TX") =>
  ({ zip_code: zip, state, brokerage_id: null, raw_record_id: null, source_origin: "platform", created_at: new Date().toISOString() })
const tenantLead = (zip: string, brokerageId: string, state = "TX") =>
  ({ zip_code: zip, state, brokerage_id: brokerageId, raw_record_id: null, source_origin: "tenant", created_at: new Date().toISOString() })

const inputs: CoverageInputs = {
  subscriptions: [
    { brokerage_id: TENANT_A_ID, status: "active" },
    { brokerage_id: TENANT_B_ID, status: "cancelled" },
  ],
  serviceAreas: [
    { brokerage_id: TENANT_A_ID, zip_code: "78701", city: "Austin", state: "TX", active: true },
    { brokerage_id: TENANT_B_ID, zip_code: "78702", city: "Austin", state: "TX", active: true }, // stale
  ],
  brokerages: [
    { id: TENANT_A_ID, name: TENANT_A_NAME },
    { id: TENANT_B_ID, name: TENANT_B_NAME },
  ],
  leadRows: [
    // 78701 — CLAIMED by active tenant A: 12 platform leads (must never go public)
    ...Array.from({ length: 12 }, () => platformLead("78701")),
    // 78704 — unclaimed: 7 platform + 3 tenant-origin (only the 7 may show)
    ...Array.from({ length: 7 }, () => platformLead("78704")),
    ...Array.from({ length: 3 }, () => tenantLead("78704", TENANT_A_ID)),
    // 78745 — unclaimed: 4 platform leads (below the floor — never listed)
    ...Array.from({ length: 4 }, () => platformLead("78745")),
    // 78702 — STALE claim only (cancelled tenant): 6 platform leads ⇒ unclaimed+listed
    ...Array.from({ length: 6 }, () => platformLead("78702")),
  ],
  rawZips: [],
  windowDays: 30,
  capped: false,
}

const board = composeCoverageBoard(inputs)
const snapshot = composeMarketplaceSnapshot(board)
const publicJson = JSON.stringify(snapshot)

console.log("\n[1 · Anonymization lock — the public shape carries zero tenant data]")
check("tenant NAMES never appear in the serialized public snapshot",
  !publicJson.includes(TENANT_A_NAME) && !publicJson.includes(TENANT_B_NAME) && !publicJson.includes("Acme"))
check("tenant IDS never appear in the serialized public snapshot",
  !publicJson.includes(TENANT_A_ID) && !publicJson.includes(TENANT_B_ID))
check("no claim metadata keys leak (claimedBy / brokerage / awaiting / promoted)",
  !publicJson.includes("claimedBy") && !publicJson.includes("brokerage") &&
  !publicJson.includes("awaiting") && !publicJson.includes("promoted"))
const allowedKeys = ["zip", "city", "state", "leadCount", "periodLabel"].sort().join(",")
check("every public row is EXACTLY { zip, city, state, leadCount, periodLabel }",
  snapshot.available.length > 0 &&
  snapshot.available.every((z) => Object.keys(z).sort().join(",") === allowedKeys) &&
  snapshot.teaser.every((z) => Object.keys(z).sort().join(",") === allowedKeys))
check("servedZips carries zip strings ONLY (who claims them is never present)",
  snapshot.servedZips.every((z) => typeof z === "string" && /^\d{5}$/.test(z)))

console.log("\n[2 · Threshold floor + platform-origin counting]")
check(`unclaimed 78704 listed with leadCount 7 (platform-origin ONLY — tenant-sourced excluded)`,
  snapshot.available.some((z) => z.zip === "78704" && z.leadCount === 7))
check(`unclaimed 78745 (4 < ${MARKETPLACE_MIN_LEADS}) is NOT listed`,
  !snapshot.available.some((z) => z.zip === "78745") && !publicJson.includes("78745"))
check("stale-claimed 78702 counts as UNCLAIMED (active-tenant predicate, keep-one) and is listed",
  snapshot.available.some((z) => z.zip === "78702" && z.leadCount === 6))
check("available is sorted by volume desc",
  snapshot.available.map((z) => z.zip).join(",") === "78704,78702")
check(`teaser is available capped at ${MARKETPLACE_TEASER_LIMIT}`,
  snapshot.teaser.length === Math.min(snapshot.available.length, MARKETPLACE_TEASER_LIMIT))
check("city/state derive from the market/claim rows where known",
  snapshot.available.every((z) => z.state === "TX"))
// Exact-threshold boundary: 5 shows, 4 doesn't (dedicated micro-board).
const microBoard = composeCoverageBoard({
  subscriptions: [], serviceAreas: [], brokerages: [], rawZips: [], windowDays: 30,
  leadRows: [
    ...Array.from({ length: MARKETPLACE_MIN_LEADS }, () => platformLead("10001", "NY")),
    ...Array.from({ length: MARKETPLACE_MIN_LEADS - 1 }, () => platformLead("10002", "NY")),
  ],
})
const microSnap = composeMarketplaceSnapshot(microBoard)
check(`exactly ${MARKETPLACE_MIN_LEADS} leads clears the floor; ${MARKETPLACE_MIN_LEADS - 1} does not`,
  microSnap.available.some((z) => z.zip === "10001") && !microSnap.available.some((z) => z.zip === "10002"))

console.log("\n[3 · Three honest states (+ input guard)]")
const served = lookupZipAvailability(snapshot, "78701")
const availHit = lookupZipAvailability(snapshot, "78704")
const noVol = lookupZipAvailability(snapshot, "78745")
const unknown = lookupZipAvailability(snapshot, "99999")
const invalid = lookupZipAvailability(snapshot, "abc12")
check("claimed 78701 ⇒ 'served'", served.state === "served")
check("served answer carries NO volume (the subscriber's business)",
  !JSON.stringify(served).includes("leadCount") && !JSON.stringify(served).includes("12"))
check("unclaimed ≥-floor 78704 ⇒ 'available' with the real count",
  availHit.state === "available" && availHit.zip.leadCount === 7)
check("unclaimed sub-floor 78745 ⇒ 'no_volume' and its sub-threshold count is NOT leaked",
  noVol.state === "no_volume" && !JSON.stringify(noVol).includes("leadCount"))
check("never-seen 99999 ⇒ 'no_volume' (same honest answer as sub-floor)", unknown.state === "no_volume")
check("malformed input ⇒ 'invalid' guard", invalid.state === "invalid")

console.log("\n[4 · Claimed-zip volume never exposed]")
check("claimed 78701 appears in NO public available/teaser row",
  !snapshot.available.some((z) => z.zip === "78701") && !snapshot.teaser.some((z) => z.zip === "78701"))
check("claimed 78701 is answered only via servedZips (zip string, nothing else)",
  snapshot.servedZips.includes("78701"))

console.log("\n[5 · Floors honesty — a capped board says so]")
const cappedSnap = composeMarketplaceSnapshot(composeCoverageBoard({ ...inputs, capped: true }))
check("capped read ⇒ countsAreFloors true (labels render 'N+')", cappedSnap.countsAreFloors === true)
check("uncapped read ⇒ countsAreFloors false", snapshot.countsAreFloors === false)

console.log("\n[6 · Keep-one + anonymized reads — source locks]")
const libSrc = src("lib/platform/territory-marketplace.ts")
check("marketplace lib consumes the round-39 coverage board (loadCoverageBoard import)",
  libSrc.includes('from "@/lib/analytics/territory-coverage"') && libSrc.includes("loadCoverageBoard"))
check("marketplace lib re-implements NO counting — zero direct lead/claim/subscription queries",
  !libSrc.includes('from("leads")') && !libSrc.includes('from("raw_scraped_leads")') &&
  !libSrc.includes('from("subscriber_service_areas")') && !libSrc.includes('from("subscriptions")'))
check("the lib's only SELECT is billing_metadata (the prefill carry) — never tenant names",
  (libSrc.match(/\.select\(/g) ?? []).length === 1 && libSrc.includes('.select("billing_metadata")'))
const ifaceMatch = libSrc.match(/export interface MarketplaceZip \{([\s\S]*?)\}/)
const ifaceFields = (ifaceMatch?.[1] ?? "").split("\n")
  .map((l) => l.trim()).filter((l) => l && !l.startsWith("/") && !l.startsWith("*"))
  .map((l) => l.split(":")[0].replace("?", "").trim()).sort().join(",")
check("MarketplaceZip interface declares EXACTLY the five public fields",
  ifaceFields === "city,leadCount,periodLabel,state,zip")

console.log("\n[7 · Prefill carry — /pricing → /signup?zip= → onboarding suggestion]")
check("cleanCarriedZip accepts a 5-digit zip (trimmed)",
  cleanCarriedZip("78704") === "78704" && cleanCarriedZip(" 78704 ") === "78704")
check("cleanCarriedZip rejects short / long / alpha / empty input",
  cleanCarriedZip("787") === null && cleanCarriedZip("787045") === null &&
  cleanCarriedZip("78a04") === null && cleanCarriedZip("") === null && cleanCarriedZip(undefined) === null)
const pricingSrc = src("app/pricing/page.tsx")
const sectionSrc = src("app/pricing/territory-availability.tsx")
const signupPageSrc = src("app/get-started/page.tsx")
const signupFormSrc = src("app/get-started/trial-funnel-form.tsx")
const actionSrc = src("app/actions/auth/signup-brokerage.ts")
const insightsPageSrc = src("app/dashboard/market-insights/page.tsx")
const insightsClientSrc = src("app/dashboard/market-insights/market-insights-client.tsx")
check("/pricing mounts the TerritoryAvailability section + territory JSON-LD ItemList",
  pricingSrc.includes("TerritoryAvailability") && pricingSrc.includes('"@type": "ItemList"') &&
  pricingSrc.includes("serializeJsonLd(territoryJsonLd)"))
check("the section's CTAs carry the zip into the signup funnel (/signup?zip= → 308 → /get-started)",
  sectionSrc.includes("/signup?zip=") && pricingSrc.includes("/signup?zip="))
check("the signup funnel validates + threads the carried zip (cleanCarriedZip → TrialFunnelForm → action)",
  signupPageSrc.includes("cleanCarriedZip(params.zip)") && signupPageSrc.includes("initialZip={initialZip}") &&
  signupFormSrc.includes("territoryZip: initialZip"))
check("signup action stores the zip as signup_intent SUGGESTION (merge-never-replace bag)",
  actionSrc.includes("signup_intent") && actionSrc.includes("territory_zip") &&
  actionSrc.includes("cleanCarriedZip"))
check("signup action NEVER auto-creates a market or territory claim from the zip",
  !actionSrc.includes("createScrapingMarket") && !actionSrc.includes("lead_scraping_markets") &&
  !actionSrc.includes("subscriber_service_areas"))
check("market setup reads the carried zip back as the suggested first market (prefill only)",
  insightsPageSrc.includes("loadCarriedTerritoryZip") && insightsPageSrc.includes("suggestedZip={suggestedZip}") &&
  insightsClientSrc.includes("zipCode: suggestedZip ?? \"\""))
check("prefill is a suggestion in the dialog — the user still saves it themselves",
  insightsClientSrc.includes("Suggested from signup") && insightsClientSrc.includes("nothing is added until you save"))

// ─── Verdict ─────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(72)}`)
console.log(`Territory marketplace simulator: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("Failed checks:"); for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1) }
console.log("All checks passed — the public territory read is anonymized, floored, and honest.")
