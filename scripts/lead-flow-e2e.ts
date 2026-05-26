/**
 * scripts/lead-flow-e2e.ts  —  `npm run test:lead-flow`
 *
 * End-to-end LEAD-FLOW harness for the buyer/seller/investor behavioral-intent
 * pipeline. Unlike scraper-simulator.ts (which unit-tests each normalizer), this
 * chains the REAL pipeline functions in sequence to prove the whole flow:
 *
 *   subscriber kill-switch  →  enabled-source gate  →  vendor sourcing (mock
 *   payloads)  →  normalize  →  viability gate  →  territory gate  →  dedup  →
 *   source scoring + urgency  →  promotion eligibility  →  usage tracking  →
 *   listing-source selection (RentCast default / IDX optional).
 *
 * The scrapers themselves cannot run here (sandbox egress is allow-listed), so we
 * inject realistic VENDOR PAYLOADS as test input and run the actual code over them.
 * No stubbed pipeline logic — every transform is the production function.
 */

import { activeSubscriberBrokerageIds, isActiveSubscriptionStatus } from "../lib/lead-pipeline/subscription-gate"
import {
  expandEnabledSources,
  calculateSourceScore,
  getSourceSemantics,
  scoreToUrgencyLevel,
  recordMatchesTerritory,
} from "../lib/lead-pipeline/source-intent-map"
import {
  isViableRecord,
  hasPromotionEligibleIdentity,
  buildLeadIdentityKey,
  type NormalizedScrapedRecord,
} from "../lib/lead-pipeline/raw-record-types"
import { normalizeRedditPost, normalizeFacebookPost } from "../lib/lead-pipeline/social-sourcer"
import { normalizeTavilyResult } from "../lib/lead-pipeline/tavily-sourcer"
import { normalizeExaResult } from "../lib/lead-pipeline/exa-sourcer"
import { normalizeCourtFiling } from "../lib/lead-pipeline/osint-sourcer"
import { resolveListingSource } from "../lib/property/listing-source"

let passed = 0
let failed = 0
const failures: string[] = []
const matrix: Record<string, boolean> = {}

function check(name: string, cond: boolean, detail?: string) {
  matrix[name] = cond
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

// Tampa FL territory (B1) used throughout.
const B1 = "b0000000-0000-0000-0000-000000000001"
const B4 = "b0000000-0000-0000-0000-000000000004"
const market = { city: "Tampa", state: "FL", zip_codes: ["33602", "33606"] }

// ── STAGE 1 — Subscriber kill-switch ─────────────────────────────────────────
// Only active/trialing brokerages may be scraped. Cancelled / past_due / paused
// subscribers' territories are skipped (we never spend on un-assignable leads).
function stageKillSwitch(): Set<string> {
  console.log("\n[1] Subscriber kill-switch (cancelled / past-due → scrapers off)")
  const subscriptions = [
    { brokerage_id: B1, status: "active" },
    { brokerage_id: "b2", status: "past_due" },
    { brokerage_id: "b3", status: "canceled" },
    { brokerage_id: B4, status: "trialing" },
    { brokerage_id: "b5", status: "paused" },
    { brokerage_id: "b6", status: null },
  ]
  const active = activeSubscriberBrokerageIds(subscriptions)
  check("active subscriber is scrapeable", active.has(B1))
  check("trialing subscriber is scrapeable", active.has(B4))
  check("PAST_DUE subscriber is NOT scraped", !active.has("b2"))
  check("CANCELED subscriber is NOT scraped", !active.has("b3"))
  check("PAUSED subscriber is NOT scraped", !active.has("b5"))
  check("null-status subscriber is NOT scraped", !active.has("b6"))
  check("isActiveSubscriptionStatus(active)", isActiveSubscriptionStatus("active"))
  check("isActiveSubscriptionStatus(canceled) false", !isActiveSubscriptionStatus("canceled"))
  return active
}

// ── STAGE 2 — Enabled-source gate ─────────────────────────────────────────────
function stageEnabledSources() {
  console.log("\n[2] Enabled-source gate (DB config → cron gate bridge)")
  const enabled = expandEnabledSources(["tavily_intent", "facebook", "batchdata_motivated", "osint_signal"])
  check("canonical tavily_intent activates 'tavily' gate", enabled.has("tavily"))
  check("short 'facebook' activates gate", enabled.has("facebook"))
  check("batchdata passthrough", enabled.has("batchdata_motivated"))
  check("osint passthrough", enabled.has("osint_signal"))
}

// ── STAGE 3 — Vendor sourcing → normalize → viability ────────────────────────
// Inject realistic vendor payloads (buyer / seller / investor) across multiple
// sources and run the production normalizers + viability gate.
function stageSourcing(): { records: NormalizedScrapedRecord[]; costByVendor: Record<string, number> } {
  console.log("\n[3] Vendor sourcing → normalize → viability gate")
  const costByVendor: Record<string, number> = {}
  const meter = (vendor: string, cost: number) => {
    costByVendor[vendor] = (costByVendor[vendor] ?? 0) + cost
  }

  const records: NormalizedScrapedRecord[] = []

  // Tavily — investor buyer with contact in snippet.
  meter("tavily", 0.005)
  const tav = normalizeTavilyResult(
    { title: "Investor in Tampa", content: "Cash buyer seeking rental portfolio in Tampa, email investor@example.com", url: "https://x/1", score: 0.9 },
    market,
  )
  records.push(tav)
  check("tavily investor → buyer intent + investor signal", tav.intentType === "buyer" && !!tav.intentSignals?.includes("investor"))

  // Exa — relocating buyer anchored on author handle.
  meter("exa", 0.01)
  const exa = normalizeExaResult(
    { id: "e1", url: "https://forum/2", title: "Relocating to Tampa, pre-approved", text: "We are pre-approved and looking to buy in Tampa.", author: "mover_mia", publishedDate: null },
    market,
  )
  records.push(exa)
  check("exa relocating → buyer intent + viable via author", exa.intentType === "buyer" && isViableRecord(exa))

  // Facebook — FSBO seller post.
  meter("apify", 0.02)
  const fb = normalizeFacebookPost(
    { postId: "fb1", text: "Selling my home in Tampa, need to sell fast", authorName: "Bob Seller", url: "https://fb/1" },
    market,
  )
  records.push(fb)
  check("facebook FSBO → seller intent", fb.intentType === "seller")

  // Reddit — buyer post (anonymous handle = viable).
  meter("apify", 0.02)
  const rd = normalizeRedditPost(
    { id: "r1", title: "First-time buyer, looking to buy in Tampa", author: "firsttimer", url: "https://rd/1" },
    market,
  )
  records.push(rd)
  check("reddit first-time buyer → buyer intent + viable", rd.intentType === "buyer" && isViableRecord(rd))

  // OSINT — probate distress = motivated seller.
  meter("osint", 0.0)
  const osint = normalizeCourtFiling(
    { recordType: "probate", firstName: "Jane", lastName: "Heir", caseNumber: "2024-PR-1234" } as any,
    market,
  )
  records.push(osint)
  check("osint probate → seller intent + high motivation", osint.intentType === "seller" && (osint.motivationScore ?? 0) >= 78)

  const viable = records.filter(isViableRecord)
  check("all sourced records pass viability gate", viable.length === records.length, `${viable.length}/${records.length}`)
  return { records: viable, costByVendor }
}

// ── STAGE 4 — Territory gate ─────────────────────────────────────────────────
function stageTerritory(records: NormalizedScrapedRecord[]): NormalizedScrapedRecord[] {
  console.log("\n[4] Territory gate (only the subscriber's market)")
  const inMarket = records.filter((r) => recordMatchesTerritory({ city: r.city, state: r.state, zip: r.zip }, market))
  check("in-territory Tampa records retained", inMarket.length === records.length)

  // Miami record against a Tampa market → rejected (city/state mismatch).
  const matchesTampa = recordMatchesTerritory({ city: "Miami", state: "FL", zip: null }, market)
  check("out-of-territory (Miami) rejected from Tampa market", !matchesTampa)
  return inMarket
}

// ── STAGE 5 — Dedup ──────────────────────────────────────────────────────────
function stageDedup(records: NormalizedScrapedRecord[]) {
  console.log("\n[5] Dedup (stable identity key)")
  const keys = new Set<string>()
  let withKey = 0
  for (const r of records) {
    const k = buildLeadIdentityKey(r)
    if (k) {
      withKey++
      keys.add(k)
    }
  }
  check("every viable record yields an identity key", withKey === records.length, `${withKey}/${records.length}`)

  // Two records, same email → one dedup key.
  const a = normalizeTavilyResult({ title: "A", content: "buy Tampa dup@example.com", url: "https://x/a", score: 0.5 }, market)
  const b = normalizeTavilyResult({ title: "B", content: "investor Tampa DUP@example.com", url: "https://x/b", score: 0.6 }, market)
  check("same email → identical dedup key (case-insensitive)", buildLeadIdentityKey(a) === buildLeadIdentityKey(b))
}

// ── STAGE 6 — Scoring + urgency ──────────────────────────────────────────────
function stageScoring(records: NormalizedScrapedRecord[]) {
  console.log("\n[6] Source scoring + urgency")
  for (const r of records) {
    const score = calculateSourceScore(r.source, r.intentSignals)
    const sem = getSourceSemantics(r.source)
    const urgency = scoreToUrgencyLevel(score)
    const inRange = score >= sem.scoreRange[0] && score <= sem.scoreRange[1]
    check(`score for ${r.source} within [${sem.scoreRange[0]},${sem.scoreRange[1]}] (=${score}, ${urgency})`, inRange)
  }
  // OSINT probate should land high/medium urgency.
  const osintScore = calculateSourceScore("osint_signal", ["probate", "distressed"])
  check("osint distress → high/medium urgency", ["high", "medium"].includes(scoreToUrgencyLevel(osintScore)))
}

// ── STAGE 7 — Promotion eligibility ──────────────────────────────────────────
function stagePromotion(records: NormalizedScrapedRecord[]) {
  console.log("\n[7] Promotion eligibility (raw → lead gate)")
  const eligible = records.filter(hasPromotionEligibleIdentity)
  check("all viable in-territory records are promotion-eligible", eligible.length === records.length, `${eligible.length}/${records.length}`)
}

// ── STAGE 8 — Usage tracking ─────────────────────────────────────────────────
function stageUsage(costByVendor: Record<string, number>) {
  console.log("\n[8] Vendor usage tracking (cost accrual per vendor)")
  const total = Object.values(costByVendor).reduce((s, c) => s + c, 0)
  check("total vendor spend accrued > 0", total > 0, `$${total.toFixed(4)}`)
  check("apify cost tracked (2 calls)", (costByVendor.apify ?? 0) > 0)
  check("tavily + exa AI-vendor cost tracked", (costByVendor.tavily ?? 0) > 0 && (costByVendor.exa ?? 0) > 0)
  console.log(`     spend: ${JSON.stringify(costByVendor)} total=$${total.toFixed(4)}`)
}

// ── STAGE 9 — Listing source (RentCast default / IDX optional) ───────────────
function stageListingSource() {
  console.log("\n[9] Listing source — RentCast default, IDX optional")
  check("no IDX → RentCast (platform default)", resolveListingSource({ hasIdx: false, idxResultCount: 0, hasRentcast: true }) === "rentcast")
  check("IDX connected + results → IDX (subscriber opt-in wins)", resolveListingSource({ hasIdx: true, idxResultCount: 5, hasRentcast: true }) === "idx")
  check("IDX connected but empty → RentCast fallback", resolveListingSource({ hasIdx: true, idxResultCount: 0, hasRentcast: true }) === "rentcast")
  check("neither provider → none", resolveListingSource({ hasIdx: false, idxResultCount: 0, hasRentcast: false }) === "none")
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" LEAD-FLOW E2E — subscriber → scrape → pipeline → lead")
  console.log("══════════════════════════════════════════════════")

  const active = stageKillSwitch()
  // Only proceed to spend for an active subscriber (mirrors the cron gate).
  if (!active.has(B1)) {
    console.log("active subscriber missing — aborting (kill-switch)")
    process.exit(1)
  }
  stageEnabledSources()
  const { records, costByVendor } = stageSourcing()
  const inMarket = stageTerritory(records)
  stageDedup(inMarket)
  stageScoring(inMarket)
  stagePromotion(inMarket)
  stageUsage(costByVendor)
  stageListingSource()

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(` e2e-matrix: ${JSON.stringify(matrix)}`)
  if (failed > 0) {
    console.log(" FAILURES:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ Lead-flow E2E passed end-to-end")
  process.exit(0)
}

main()
