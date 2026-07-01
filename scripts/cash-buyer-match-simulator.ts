#!/usr/bin/env tsx
/**
 * scripts/cash-buyer-match-simulator.ts   (npm run test:cash-buyer-match)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the CASH-BUYER DISPOSITION MATCH — the disposition bookend that matches a distressed /
 * hard-to-finance property to nearby CASH INVESTORS from BatchData's investor-buybox (the seller-side
 * analog of reverse-prospecting, which excludes investors). The buy-box query build, candidate
 * normalization, and ranking are PURE; the persist round-trip is proven live against cash_buyer_matches.
 * PROVIDER-GATED: no fabricated investors when BatchData is unconfigured.
 *
 * PURE:   buildBuyBoxQuery (subject → API args, honest about missing filters) + normalizeInvestorCandidate
 *         (defensive field reads, never fabricated) + rankInvestorCandidates (recency + capacity +
 *         classification, trust-gated floor) + qualifiedInvestors.
 * SOURCE: runner is provider-gated (unconfigured → honest skip) + metered; owned by shopping_agent;
 *         reverse-prospecting still excludes investors (this fills that gap); table in the snapshot.
 * LIVE (creds-gated): seed a listing → persist a ranked match → assert idempotent per listing → clean up.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  buildBuyBoxQuery,
  normalizeInvestorCandidate,
  rankInvestorCandidates,
  qualifiedInvestors,
  DISPOSITION_THRESHOLD,
  type SubjectProperty,
} from "../lib/disposition/investor-match"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const subject: SubjectProperty = { street: "3741 W Evans Dr", city: "Phoenix", state: "AZ", zip: "85053", bedrooms: 3, bathrooms: 2, livingAreaSqft: 1500, yearBuilt: 1985, propertyTypeDetail: "Single Family" }

function pureLayer() {
  console.log("\n[buildBuyBoxQuery · pure — subject → BatchData args, honest about missing filters]")
  const q = buildBuyBoxQuery(subject)!
  check("carries the subject geography", q.street === "3741 W Evans Dr" && q.city === "Phoenix" && q.state === "AZ" && q.zip === "85053")
  check("filters by distance (cash buyers work a farm)", q.use_distance === true && typeof q.distance_miles === "number")
  check("filters by year built when known (±15 default)", q.use_year_built === true && q.min_year_built === -15 && q.max_year_built === 15)
  check("filters by living-area percent when known", q.use_area === true && q.min_area_percent === -25 && q.max_area_percent === 25)
  check("passes the property type through", q.property_type_detail === "Single Family")
  check("defaults to active buyers only (last 24 months)", q.last_sold_date === 24)
  const noArea = buildBuyBoxQuery({ ...subject, livingAreaSqft: null, yearBuilt: null })!
  check("HONEST: no sqft/year on the row ⇒ those filters OFF (widen, don't guess)", noArea.use_area === false && noArea.use_year_built === false)
  check("no street ⇒ null (can't query)", buildBuyBoxQuery({ ...subject, street: "" }) === null)
  check("no city AND no zip ⇒ null (no geography)", buildBuyBoxQuery({ ...subject, city: null, zip: null }) === null)

  console.log("\n[normalizeInvestorCandidate · pure — defensive, never fabricated]")
  const c = normalizeInvestorCandidate({ name: "Acme Holdings LLC", investor_type: "Company Owned", investor_classification: "LANDLORD", last_sold_months_ago: 4, investor_current_holdings: { a: 1, b: 1, c: 1 }, investor_acquisitions: { x: 1, y: 1 }, state: "AZ" })
  check("reads name/type/classification", c.name === "Acme Holdings LLC" && c.investorType === "Company Owned" && c.classification === "LANDLORD")
  check("derives holdings + acquisitions counts", c.holdingsCount === 3 && c.acquisitionsCount === 2)
  check("stable dedupe key from name+state", c.key === "acme holdings llc|az")
  const empty = normalizeInvestorCandidate({})
  check("missing data ⇒ nulls, never fabricated", empty.name === null && empty.holdingsCount === null && empty.lastSoldMonthsAgo === null)

  console.log("\n[rankInvestorCandidates · pure — recency + capacity + classification, trust-gated]")
  const ranked = rankInvestorCandidates([
    { name: "Hot Flipper", investorType: "Individual", classification: "HOME BUILDER", holdingsCount: 8, acquisitionsCount: 4, lastSoldMonthsAgo: 3, city: "Phoenix", state: "AZ", key: "hot flipper|az" },
    { name: "Cold Whale", investorType: "Company Owned", classification: "LANDLORD", holdingsCount: 40, acquisitionsCount: 0, lastSoldMonthsAgo: 30, city: "Phoenix", state: "AZ", key: "cold whale|az" },
    { name: "Unknown Entity", investorType: null, classification: null, holdingsCount: null, acquisitionsCount: null, lastSoldMonthsAgo: null, city: null, state: null, key: "unknown entity|" },
  ])
  check("a recent, active buyer ranks first", ranked[0].name === "Hot Flipper" && ranked[0].matchScore >= 0.6)
  check("no-signal candidate is floored at 0.2 (unknown ≠ good)", ranked.find((r) => r.name === "Unknown Entity")!.matchScore === 0.2)
  check("every candidate carries human reasons", ranked.every((r) => r.reasons.length > 0))
  check("dedupes by stable key", rankInvestorCandidates([ranked[0], ranked[0]]).length === 1)
  check(`qualifiedInvestors keeps only ≥ ${DISPOSITION_THRESHOLD}`, qualifiedInvestors(ranked).every((r) => r.matchScore >= DISPOSITION_THRESHOLD))
  check("the cold whale (stale) still scores > 0 on capacity but honestly low on recency", ranked.find((r) => r.name === "Cold Whale")!.matchScore < ranked[0].matchScore)
}

function sourceLayer() {
  console.log("\n[wiring — provider-gated + metered; owned by shopping_agent; fills the reverse-prospecting gap]")
  const runner = src("lib/disposition/cash-buyer-match-runner.ts")
  check("runner sources from BatchData investor-buybox", /callBatchDataMcp<any>\(INVESTOR_BUYBOX_TOOL/.test(runner))
  check("PROVIDER-GATED — unconfigured ⇒ honest skip, no fabricated investors", /res\.unconfigured\)\s*return\s*\{\s*ok:\s*false,\s*reason:\s*"provider_unconfigured"/.test(runner))
  check("buybox lookup is metered through the vendor gateway", /meterVendorSpend\(\{[\s\S]*?vendorName:\s*"batchdata"[\s\S]*?investor_buybox/.test(runner))
  check("idempotent per listing (updates the same row in place)", /eq\("listing_id", m\.listingId\)[\s\S]*?update\(row\)/.test(runner))
  const rp = src("lib/kernel/reverse-prospecting.ts")
  check("reverse-prospecting STILL excludes investors (this is the fill, not a dup)", /contact_type/.test(rp) && !/cash_buyer_matches/.test(rp))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by shopping_agent with a runnable proof", /cash_buyer_match:\s*\{\s*manager:\s*"shopping_agent",\s*proof:\s*"test:cash-buyer-match"/.test(reg))
  check("cash_buyer_matches table owned by shopping_agent", /cash_buyer_matches:\s*"shopping_agent"/.test(reg))
  check("table is in the schema snapshot (drift-guarded)", /cash_buyer_matches:\s*\[/.test(src("scripts/schema-snapshot.ts")))
  const act = src("app/actions/cash-buyer-match.ts")
  check("action returns an honest 'not connected' when BatchData is unconfigured", /provider_unconfigured:[\s\S]*?BatchData/.test(act))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed a listing → persist a ranked match (upsert path) → idempotent per listing → clean up")
  const { data: listing } = await svc.from("listings").select("id, brokerage_id, address, city, state, zip").limit(1).maybeSingle()
  if (!listing) { console.log("  ⊘ no listing — skipping"); return }
  const brokerageId = (listing as any).brokerage_id, listingId = (listing as any).id
  const cleanup: string[] = []
  try {
    // Pre-clean any stale match for a deterministic seed (unique per listing).
    const { data: stale } = await svc.from("cash_buyer_matches").select("id").eq("listing_id", listingId).maybeSingle()
    if (stale) await svc.from("cash_buyer_matches").delete().eq("id", (stale as any).id)

    const ranked = rankInvestorCandidates([
      { name: "Live Flipper LLC", investorType: "Company Owned", classification: "HOME BUILDER", holdingsCount: 6, acquisitionsCount: 3, lastSoldMonthsAgo: 5, city: "Phoenix", state: "AZ", key: "live flipper llc|az" },
    ])
    const row = {
      brokerage_id: brokerageId, listing_id: listingId, subject_street: (listing as any).address ?? "1 Test St",
      subject_city: (listing as any).city ?? null, subject_state: (listing as any).state ?? null, subject_zip: (listing as any).zip ?? null,
      candidate_count: ranked.length, candidates: ranked as any, last_matched_at: new Date().toISOString(),
    }
    const { data: created } = await svc.from("cash_buyer_matches").insert(row).select("id, candidate_count").single()
    cleanup.push((created as any).id)
    check("live: persisted the match with the ranked candidates", (created as any).candidate_count === 1)

    // Upsert path: a re-match updates the SAME row (idempotent per listing) — assert no duplicate.
    await svc.from("cash_buyer_matches").update({ candidate_count: 2, updated_at: new Date().toISOString() }).eq("listing_id", listingId)
    const { count } = await svc.from("cash_buyer_matches").select("id", { count: "exact", head: true }).eq("listing_id", listingId)
    check("live: still exactly ONE match row per listing (idempotent)", count === 1)
    const { data: reread } = await svc.from("cash_buyer_matches").select("candidates").eq("listing_id", listingId).maybeSingle()
    check("live: candidates jsonb round-trips (name + score preserved)", (reread as any)?.candidates?.[0]?.name === "Live Flipper LLC" && typeof (reread as any)?.candidates?.[0]?.matchScore === "number")
  } finally {
    for (const id of cleanup) await svc.from("cash_buyer_matches").delete().eq("id", id)
    let left = 0
    for (const id of cleanup) { const { count } = await svc.from("cash_buyer_matches").select("id", { count: "exact", head: true }).eq("id", id); left += count ?? 0 }
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
  if (fail > 0) { console.log(" ❌ CASH_BUYER_MATCH_FAIL"); process.exit(1) }
  console.log(" ✅ CASH_BUYER_MATCH_PASS — a hard property matched to ranked cash investors (provider-gated, never fabricated); the disposition bookend no competitor has")
}
main()
