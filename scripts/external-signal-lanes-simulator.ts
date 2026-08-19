#!/usr/bin/env tsx
/**
 * scripts/external-signal-lanes-simulator.ts   (npm run test:external-signal-lanes)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROOF FOR THREE CAPABILITIES THAT WERE BUILT AND LEFT UNCONNECTED.
 *
 *   1. extractFromHtml   → ZenrowsClient.scrapeNextdoor (lib/external/nextdoor-extract.ts)
 *   2. recentPermits     → /api/cron/permit-signal-scan (lib/external/permit-signals.ts)
 *   3. validateVendorPlan → /vendor/plans (app/actions/vendors/vendor-plans.ts)
 *
 * Layer 1 (pure): the extraction/scoring/matching/validation cores, with real assertions.
 * Layer 2 (wiring): the cron is registered AND owned; the action file exists; the page is
 *   nav-linked; the validator's rules match the live CHECK constraints named in its header.
 * Layer 3 (live, best-effort): one bounded Socrata call proving recentPermits returns the
 *   adapter's structured shape and never throws. Asserted on SHAPE, not on a vendor's uptime.
 *
 * Run: npx tsx scripts/external-signal-lanes-simulator.ts
 */
import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  scoreNextdoorPost, normalizeExtractedPosts, regexFallbackPosts,
  NEXTDOOR_POST_SCHEMA, NEXTDOOR_EXTRACT_INSTRUCTIONS,
} from "../lib/external/nextdoor-extract"
import {
  normalizeStreetAddress, readPermitAddress, readPermitId, readPermitValuation,
  classifyPermitStrength, matchPermitsToLeads, buildPermitSignalRow, permitDedupeKey,
  PERMIT_SIGNAL_TYPE, PERMIT_DETECTED_VIA,
} from "../lib/external/permit-signals"
import { getMarketDatasets } from "../lib/external/socrata-market-registry"
import { recentPermits } from "../lib/external/socrata-client"
import { validateVendorPlan, VENDOR_PLAN_BILLING_CYCLES, VENDOR_PLAN_STATUSES } from "../lib/vendors/vendor-validators"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"
import { CRON_MANAGER, MAINTENANCE_DOMAINS, MANAGERS } from "../lib/kernel/manager-registry"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (rel: string) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "")

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

console.log("══════════════════════════════════════════════════")
console.log(" External signal lanes — extractFromHtml · recentPermits · validateVendorPlan")
console.log("══════════════════════════════════════════════════")

// ═══════════════════════════════════════════════════════════════════════════
// 1 · extractFromHtml → Nextdoor
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[1 · extractFromHtml lane — the schema, and what the model may NOT author]")

check("the schema asks for the exact fields the two live consumers read",
  ["post_id", "author_name", "content", "neighborhood", "url", "posted_at"]
    .every((f) => NEXTDOOR_POST_SCHEMA.includes(f)))
check("the schema does NOT ask the model for a score, a type, or a keyword list",
  !/relevance|score|matched_keywords|classif/i.test(NEXTDOOR_POST_SCHEMA))
check("the instructions forbid inferring, scoring and summarizing",
  /do not infer/i.test(NEXTDOOR_EXTRACT_INSTRUCTIONS) && /do not summarize/i.test(NEXTDOOR_EXTRACT_INSTRUCTIONS))

const sellPost = "Hi neighbors — we are thinking of selling our house this spring, any recommendations for a realtor?"
const s1 = scoreNextdoorPost(sellPost)
const s2 = scoreNextdoorPost(sellPost)
check("scoring is deterministic (same text → identical result)", JSON.stringify(s1) === JSON.stringify(s2))
check("a selling declaration types as selling_intent and scores above the consumers' 70 gate",
  s1.type === "selling_intent" && s1.relevance_score > 70, `type=${s1.type} score=${s1.relevance_score}`)
const noise = scoreNextdoorPost("Lost cat near the park, orange tabby, answers to Mango.")
check("an unrelated post scores 0 and types general — a post can genuinely FAIL the gate",
  noise.relevance_score === 0 && noise.type === "general")
check("caller keywords add to the match set", scoreNextdoorPost("we need a bigger yard", ["bigger yard"]).matched_keywords.includes("bigger yard"))
check("score is capped at 100", scoreNextdoorPost(SELL_SPAM()).relevance_score <= 100)

const normalized = normalizeExtractedPosts([
  { post_id: "p1", author_name: "Dana R", content: sellPost, neighborhood: "Hyde Park", url: "https://nextdoor.com/p/1", relevance_score: 99, type: "selling_intent" },
  { post_id: "p2", author_name: "No Text", content: "   " },
  { nonsense: true },
], { sourceUrl: "https://nextdoor.com/search" })
check("a record with no readable content is DROPPED, not patched into a plausible post", normalized.length === 1)
check("extracted facts survive verbatim",
  normalized[0].post_id === "p1" && normalized[0].author_name === "Dana R" && normalized[0].neighborhood === "Hyde Park")
check("a model-authored relevance_score is IGNORED and recomputed",
  normalized[0].relevance_score !== 99 && normalized[0].relevance_score === s1.relevance_score)
check("llm-path records are stamped llm_schema", normalized[0].extraction === "llm_schema")
check("a record with no url falls back to the page it came from",
  normalizeExtractedPosts([{ content: sellPost }], { sourceUrl: "https://nextdoor.com/search" })[0].url === "https://nextdoor.com/search")

const fallback = regexFallbackPosts(
  `<div class="post-body">${sellPost} plus enough words to clear the length floor for the block scan</div>`,
  { sourceUrl: "https://nextdoor.com/search" },
)
check("the regex fallback still recovers text", fallback.length === 1 && fallback[0].content.includes("selling our house"))
check("…but withholds the score (null, never 0) and says it is degraded",
  fallback[0].relevance_score === null && fallback[0].extraction === "regex_fallback")

const zen = src("lib/external/zenrows-client.ts")
check("scrapeNextdoor calls extractFromHtml", zen.includes("llm-html-extractor") && zen.includes("extractFromHtml"))
check("…and keeps the regex path as the named fallback", zen.includes("regexFallbackPosts"))
check("…and a failed scrape reports an error instead of an empty neighborhood",
  /success: false[\s\S]{0,200}error:/.test(zen))
check("the extractor itself still routes through the AI Gateway, never a provider SDK",
  src("lib/external/llm-html-extractor.ts").includes("gatewayChat"))

// ═══════════════════════════════════════════════════════════════════════════
// 2 · recentPermits → motivated_seller_signals
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[2 · permit lane — address normalization, exact-only matching, honest skips]")

check("suffix + directional + unit all normalize to one key",
  normalizeStreetAddress("1234 N. Lamar Boulevard, Apt 5B") === normalizeStreetAddress("1234 north lamar blvd #5b"),
  `${normalizeStreetAddress("1234 N. Lamar Boulevard, Apt 5B")} vs ${normalizeStreetAddress("1234 north lamar blvd #5b")}`)
check("the city/state tail is dropped before comparison",
  normalizeStreetAddress("55 Oak St, Austin, TX 78701") === normalizeStreetAddress("55 OAK STREET"))
check("an address with no house number yields an empty key (never matchable)",
  normalizeStreetAddress("Lamar Boulevard") === "" && normalizeStreetAddress("") === "" && normalizeStreetAddress(null) === "")
check("two different houses do NOT collide",
  normalizeStreetAddress("1234 Oak St") !== normalizeStreetAddress("1235 Oak St"))

check("address is read across portal-specific column names",
  readPermitAddress({ original_address1: "1234 Oak St" }) === "1234 Oak St"
  && readPermitAddress({ street_address: "9 Elm Ave" }) === "9 Elm Ave"
  && readPermitAddress({ nothing_useful: 1 }) === null)

// THE REAL SHAPES OF THE REGISTERED PORTALS, pinned offline.
// The live block at the bottom of this file caught that NONE of these three publishes a
// single address column — every row of every one of them read as null, so the sweep counted
// three of the largest markets in the country as "nothing happening" rather than "cannot
// read". These rows are verbatim field names and values from one live row of each dataset.
// They are asserted here, with no network, so the regression cannot hide behind a portal
// being unreachable from wherever this happens to run.
check("COMPOSITE ADDRESS — the three registered portals that split it across columns",
  // Chicago ydr8-5enu: number · direction · name
  readPermitAddress({ street_number: "7529", street_direction: "N", street_name: "CLARK ST" }) === "7529 N CLARK ST"
  // San Francisco i98e-djp9: number · name · suffix
  && readPermitAddress({ street_number: "930", street_name: "Sutter", street_suffix: "St" }) === "930 Sutter St"
  // New York ipu4-2q9a: house__ · name (the suffix is inside the name)
  && readPermitAddress({ house__: "60", street_name: "BAY 34 ST" }) === "60 BAY 34 ST"
  // A street with no house number names a BLOCK. Refused — matching a seller signal onto a
  // block is the fuzzy match this lane exists to not make.
  && readPermitAddress({ street_name: "CLARK ST", street_direction: "N" }) === null
  // A single column still wins over the parts when a portal publishes both.
  && readPermitAddress({ address: "1 Main St", street_number: "2", street_name: "Other Rd" }) === "1 Main St")

check("permit id is read across portal-specific column names",
  readPermitId({ permit_number: "2026-123" }) === "2026-123" && readPermitId({}) === null
  // Socrata renders a trailing '#' in a column label as '_', which is where Chicago's
  // "PERMIT#" → permit_ and NYC's job__ both come from. Chicago's was unreadable, so the
  // per-(permit, lead) uniqueness m490 added had no handle to dedupe on.
  && readPermitId({ permit_: "101046020" }) === "101046020"
  && readPermitId({ job__: "340733647" }) === "340733647")
check("valuation parses currency text and refuses junk (never 0-as-unknown)",
  readPermitValuation({ estimated_cost: "$125,000" }) === 125000 && readPermitValuation({ estimated_cost: "n/a" }) === null)

check("demolition is the only 'strong' permit", classifyPermitStrength({ description: "DEMOLITION of single family", valuation: null }) === "strong")
check("pre-listing work is 'moderate'", classifyPermitStrength({ description: "Kitchen remodel", valuation: null }) === "moderate")
check("routine maintenance is 'weak'", classifyPermitStrength({ description: "Water heater replacement", valuation: 900 }) === "weak")
check("a six-figure job lifts an unrecognized permit to moderate", classifyPermitStrength({ description: "misc", valuation: 250_000 }) === "moderate")

const leads = [
  { id: "lead-a", address: "1234 N Lamar Blvd" },
  { id: "lead-b", address: "1234 N Lamar Blvd" }, // same house, two lead records
  { id: "lead-c", address: null },
  { id: "lead-d", address: "Lamar Boulevard" },   // unusable key
]
const permits = [
  { original_address1: "1234 north lamar boulevard apt 2", permit_number: "P-1", description: "Kitchen remodel" },
  { original_address1: "999 Nowhere Ln", permit_number: "P-2", description: "Reroof" },
  { permit_number: "P-3", description: "Demolition" }, // no address at all
  { original_address1: "Lamar Boulevard", permit_number: "P-4" }, // unusable key
]
const outcome = matchPermitsToLeads(permits, leads)
check("both leads at one address get the signal (never a silent tie-break)",
  outcome.matches.length === 2 && new Set(outcome.matches.map((m) => m.leadId)).size === 2)
check("a permit with no readable address is counted, not matched", outcome.skippedNoAddress === 2, `got ${outcome.skippedNoAddress}`)
check("a permit at an address nobody owns is counted, not fuzzy-matched", outcome.skippedNoLeadMatch === 1)
check("an unusable key on BOTH sides never collides (lead-d never matches P-4)",
  !outcome.matches.some((m) => m.leadId === "lead-d"))

const dataset = getMarketDatasets({ state: "TX", city: "Austin" }).find((d) => d.kind === "permits")!
const row = buildPermitSignalRow({ match: outcome.matches[0], brokerageId: "brok-1", dataset })
check("the signal row carries every live motivated_seller_signals column",
  ["lead_id", "brokerage_id", "signal_type", "signal_strength", "detected_via", "signal_details"]
    .every((k) => k in row))
check("it is filed as permit_activity / socrata", row.signal_type === PERMIT_SIGNAL_TYPE && row.detected_via === PERMIT_DETECTED_VIA)
check("it is tenant-stamped", row.brokerage_id === "brok-1")
check("signal_details carries the dedupe key m490's unique index is built on",
  typeof (row.signal_details as any).dedupe_key === "string" && (row.signal_details as any).dedupe_key.length > 0)
check("the dedupe key is stable across runs",
  permitDedupeKey(outcome.matches[0], dataset) === permitDedupeKey(outcome.matches[0], dataset))
check("the dedupe key separates two leads at the same address",
  permitDedupeKey(outcome.matches[0], dataset) !== permitDedupeKey(outcome.matches[1], dataset))

const permitSrc = src("lib/external/permit-signals.ts")
check("the ingest writes the CANONICAL signal table, never the retired twin",
  permitSrc.includes('.from("motivated_seller_signals")')
  && !permitSrc.includes('.from("lead_motivated_seller_signals")'))
check("the ingest never creates a lead or a contact (a permit is an address, not a person)",
  !/\.from\("(leads|contacts)"\)[\s\S]{0,120}\.insert/.test(permitSrc))
check("every read destructures error and reports it",
  (permitSrc.match(/error:\s*\w+Error/g) ?? []).length >= 3 && permitSrc.includes("read refused"))
check("the lead read is tenant-scoped", /\.from\("leads"\)[\s\S]{0,200}\.eq\("brokerage_id"/.test(permitSrc))
check("a duplicate (23505) is absorbed as already-recorded, other errors are reported", permitSrc.includes('"23505"'))

const cronPath = "/api/cron/permit-signal-scan"
check("the cron route file exists", existsSync(join(root, "app/api/cron/permit-signal-scan/route.ts")))
check("the route is gated the way its neighbours are (verifyCronAuth)",
  src("app/api/cron/permit-signal-scan/route.ts").includes("verifyCronAuth"))
check("the route uses the ACTIVE-subscriber territory resolver, not fixed geography",
  src("app/api/cron/permit-signal-scan/route.ts").includes("resolveActiveScrapeTerritories"))
check("the cron is registered in the single-heartbeat dispatcher", CRON_REGISTRY.some((c) => c.path === cronPath))
check("the cron has an accountable manager", cronPath in CRON_MANAGER && CRON_MANAGER[cronPath] in MANAGERS)

// ═══════════════════════════════════════════════════════════════════════════
// 3 · validateVendorPlan → the vendor plan catalogue
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[3 · vendor plan catalogue — every live CHECK, both drift directions]")

const good = { name: "Starter", price_per_month: 49, billing_cycle: "monthly" }
check("a valid plan passes clean", validateVendorPlan(good).length === 0, validateVendorPlan(good).join("; "))
check("a nameless plan is refused (name NOT NULL)", validateVendorPlan({ ...good, name: "  " }).length === 1)
check("a missing price is refused (price_per_month NOT NULL)",
  validateVendorPlan({ name: "X", billing_cycle: "monthly" }).some((e) => /required/i.test(e)))
check("DRIFT FIX (too strict): price_per_month = 0 is ACCEPTED — the live CHECK is >= 0",
  validateVendorPlan({ ...good, price_per_month: 0 }).length === 0)
check("a negative price is refused", validateVendorPlan({ ...good, price_per_month: -1 }).length === 1)
check("a non-numeric price is refused", validateVendorPlan({ ...good, price_per_month: "free" }).length === 1)
check("DRIFT FIX (too permissive): max_credits_per_month = 0 is REFUSED — the live CHECK is NULL OR > 0",
  validateVendorPlan({ ...good, max_credits_per_month: 0 }).length === 1)
check("max_credits_per_month null/absent is fine (unlimited)",
  validateVendorPlan({ ...good, max_credits_per_month: null }).length === 0 && validateVendorPlan(good).length === 0)
check("max_credits_per_month must be a whole number", validateVendorPlan({ ...good, max_credits_per_month: 2.5 }).length === 1)
check("price_per_credit >= 0 when set", validateVendorPlan({ ...good, price_per_credit: -0.01 }).length === 1 && validateVendorPlan({ ...good, price_per_credit: 0 }).length === 0)
check("trial_days >= 0 when set (0 is legal — no trial)",
  validateVendorPlan({ ...good, trial_days: -1 }).length === 1 && validateVendorPlan({ ...good, trial_days: 0 }).length === 0)
check("billing_cycle is EXACTLY the live list",
  VENDOR_PLAN_BILLING_CYCLES.join(",") === "monthly,annual"
  && validateVendorPlan({ ...good, billing_cycle: "weekly" }).length === 1
  && validateVendorPlan({ ...good, billing_cycle: "annual" }).length === 0)
check("status is EXACTLY the live list",
  VENDOR_PLAN_STATUSES.join(",") === "active,archived"
  && validateVendorPlan({ ...good, status: "draft" }).length === 1
  && validateVendorPlan({ ...good, status: "archived" }).length === 0)

const planAction = src("app/actions/vendors/vendor-plans.ts")
check("the writer exists and runs the validator", planAction.includes("validateVendorPlan"))
check("every export is an async Server Action",
  planAction.split("\n").filter((l) => /^export\s+(const|function|class|let|var|enum)\s/.test(l)).length === 0)
check("ownership is on the WRITE itself, not a prior read",
  (planAction.match(/\.eq\("vendor_id", actor\.vendorId\)/g) ?? []).length >= 4)
check("delete refuses a subscribed plan BY NAME before the FK can raise 23503",
  planAction.includes("vendor_subscriptions") && /cannot\s+`?\s*\+?\s*`?be deleted|cannot \$\{|cannot be deleted/i.test(planAction))
check("archiving is offered as the retirement path", planAction.includes("setVendorPlanStatusAction") && planAction.includes("archived"))
check("the surface exists", existsSync(join(root, "app/vendor/plans/page.tsx")) && existsSync(join(root, "app/vendor/plans/plans-client.tsx")))
check("the surface is NAV-LINKED (never a page nothing points at)",
  src("app/config/navigation-config.ts").includes("'/vendor/plans'"))
check("the client runs the same validator the server does",
  src("app/vendor/plans/plans-client.tsx").includes("validateVendorPlan"))

// The catalogue's OTHER half. vendor_plans' subscriber count and its delete gate both read
// vendor_subscriptions, and a read whose table has no writer is not a measurement — "0
// subscribers" would be a structural certainty and the delete gate could never fire.
const subAction = src("app/actions/vendors/vendor-plan-subscriptions.ts")
check("vendor_subscriptions has a real writer (the read is a measurement, not a certainty)",
  /\.from\("vendor_subscriptions"\)[\s\S]{0,400}\.insert/.test(subAction))
check("the brokerage comes from the write seam, never from the caller",
  subAction.includes("resolveWriteContext") && !/params[^\n]*brokerageId/.test(subAction))
check("every vendor_subscriptions read AND write is tenant-pinned",
  (subAction.match(/\.eq\("brokerage_id", ctx\.brokerageId\)/g) ?? []).length >= 4)
check("only an ACTIVE plan may be subscribed to (the line the browse policy draws)",
  subAction.includes('plan.status !== "active"'))
check("a repeat subscribe is a sentence, not a 23505 from the UNIQUE index",
  subAction.includes("already subscribed to this plan"))
check("cancel KEEPS the row (credits used are the invoice basis) — it never deletes",
  subAction.includes('status: "canceled"') && !/\.from\("vendor_subscriptions"\)[\s\S]{0,200}\.delete\(/.test(subAction))
check("the brokerage-side surface exists and is mounted on the nav-linked vendors page",
  existsSync(join(root, "app/dashboard/vendors/vendor-plan-catalogue-panel.tsx"))
  && src("app/dashboard/vendors/page.tsx").includes("VendorPlanCataloguePanel"))
check("no fabricated charge — the subscription is an entitlement record and says so",
  subAction.includes("stripe_") === false || /not a Stripe subscription/i.test(subAction))

// ═══════════════════════════════════════════════════════════════════════════
// ownership
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[ownership]")
const domain = MAINTENANCE_DOMAINS["external_signal_lanes"]
check("this proof has an accountable manager", !!domain && domain.manager in MANAGERS)
check("…and the domain names THIS script", domain?.proof === "test:external-signal-lanes")

// ═══════════════════════════════════════════════════════════════════════════
// live (best-effort, shape-asserted)
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[live · recentPermits against a registered dataset — shape, not uptime]")
{
  const spec = getMarketDatasets({ state: "IL", city: "Chicago" }).find((d) => d.kind === "permits" && d.dateColumn)
  if (!spec) {
    check("a registered Chicago permit dataset with a dateColumn exists", false)
  } else {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const res = await recentPermits<Record<string, unknown>>({
      host: spec.host, datasetId: spec.datasetId, sinceIso: since,
      permitDateColumn: spec.dateColumn as string, limit: 5,
    })
    check("recentPermits returns the adapter's structured shape and never throws",
      typeof res.ok === "boolean" && Array.isArray(res.data))
    check("ok=true implies rows, ok=false implies a stated error",
      res.ok ? Array.isArray(res.data) : typeof res.error === "string")
    if (res.ok && res.data.length > 0) {
      const withAddr = res.data.filter((r) => !!normalizeStreetAddress(readPermitAddress(r)))
      console.log(`      · live: ${res.data.length} permits, ${withAddr.length} with a usable address key`)
      // WHEN THIS FAILS IT MUST SAY WHY. The first time it did, it reported only that zero rows
      // yielded a key — true, and useless: the cause was that the portal splits the address
      // across columns no reader knew. Printing the row's actual field names turns the next
      // failure into the fix, instead of another round trip to a portal CI can reach and a
      // developer often cannot.
      if (withAddr.length === 0) {
        console.log(`      · UNREADABLE — this portal's row exposes: ${Object.keys(res.data[0]).sort().join(", ")}`)
      }
      check("at least one live permit row yields a usable address key (the readers cover this portal)",
        withAddr.length > 0)
    } else {
      console.log(`      · live call unavailable (${res.error ?? "no rows"}) — shape assertions still ran`)
    }
  }
}

function SELL_SPAM() {
  return "selling my house selling our house thinking of selling for sale by owner fsbo need to sell downsizing " +
    "looking to buy house hunting relocating moving away recommend a realtor any recommendations"
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  console.log(" ❌ EXTERNAL_SIGNAL_LANES_FAIL")
  process.exit(1)
}
console.log(" ✅ All three lanes are connected end to end — consumer, cadence, surface.")
console.log(" EXTERNAL_SIGNAL_LANES_PASS")
