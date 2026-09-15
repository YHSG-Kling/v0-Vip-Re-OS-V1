#!/usr/bin/env tsx
/**
 * scripts/lead-intake-pipeline-simulator.ts   (npm run test:lead-intake-pipeline)
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 64 (lane 64A) — proves the owner's raw-lead-intake contract end to end,
 * verbatim: "any scraping/behavioral gets put in as a raw lead which then
 * triggers finding if there are duplicates, then enrichment, then check again
 * if duplicates, then gate evaluates if it can be created as a lead."
 *
 * lib/lead-pipeline/pipeline-processor.ts::processRawRecord is the one door.
 * Every assertion below reads STRIPPED source (scripts/strip-comments.ts) when
 * it looks for a code token, so a tombstone/JSDoc comment can never read as a
 * live call site (CLAUDE.md §2), and every "X before Y" claim is an index
 * comparison on named identifiers in the ACTUAL file, not a literal snippet
 * pinned to today's formatting.
 *
 * Layer 1 — a STRIPPED-SOURCE positive control on this file (the guard must
 *           still be able to see code once comments are gone).
 * Layer 2 — the DEDUPE ORDERING contract: pre-enrich dedupe before spend,
 *           post-enrich dedupe after, both passes hit the SAME three tables.
 * Layer 3 — the GATE contract: eligibility + address verification run before
 *           the leads insert, and refuse FAIL-CLOSED (never a fabricated true).
 * Layer 4 — SUBSCRIPTION + TERRITORY gates run upstream of ingestion (pure).
 * Layer 5 — every terminal status carries processed_at (derived, not pinned).
 * Layer 6 — brokerage ownership + source_origin land on the promoted lead from
 *           the market/session, never a request body.
 * Layer 7 — raw_scraped_leads.dedupe_status: the reader existed with no
 *           writer; proves the writer this lane BUILT and its vocabulary.
 *
 * No DB, no network — every layer is pure/static, so this runs in CI with no
 * creds. Run: npx tsx scripts/lead-intake-pipeline-simulator.ts
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"
import { calculateFuzzyMatch, isConfidentMatch } from "../lib/lead-pipeline/fuzzy-matcher"
import { evaluateCanonicalLeadEligibility } from "../lib/lead-pipeline/canonical-lead-eligibility"
import { needsPromotionAddressVerification } from "../lib/lead-pipeline/promotion-address-verification"
import { CASS_SOURCE } from "../lib/providers/mailing-cass-gate"
import {
  RAW_PROCESSING_STATUSES, IN_FLIGHT_STATUSES, REJECTION_STATUSES,
  isTerminalRawProcessingStatus, DEDUPE_STATUSES,
} from "../lib/lead-pipeline/processing-status"
import { activeSubscriberBrokerageIds } from "../lib/lead-pipeline/subscription-gate"
import { resolveScrapeTerritoriesFrom } from "../lib/lead-pipeline/scrape-territories"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const PP_PATH = "lib/lead-pipeline/pipeline-processor.ts"
const rawSrc = readFileSync(PP_PATH, "utf8")
const code = stripComments(rawSrc)

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — positive control: the stripper must still see code in THIS file,
// and must NOT still see a comment-only string. (CLAUDE.md §2: an absence
// assertion with no control is worse than no guard — it reads clean when it is
// merely blind.) "batchdata_motivated_sellers_raw" appears exactly once in the
// source, inside the STEP-3 `//` comment at pipeline-processor.ts:109 ("Read
// from raw_scraped_leads (not batchdata_motivated_sellers_raw)") — never in
// real code — so its presence in stripped output would mean the scanner is
// blind on this exact file, the same way the JSDoc-tombstone defect blinded
// five other guards on one shared comment block.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · strip-comments positive control on pipeline-processor.ts]")
check("comment-only token is ABSENT from stripped source (the scanner can see comments)",
  !code.includes("batchdata_motivated_sellers_raw"))
check("a real code token from the same region is PRESENT (the scanner did not eat the code too)",
  code.includes(".select('*')") && code.includes("processing_status: status,"))
check("stripped source is never LONGER than raw (comments only shrink, never expand)",
  code.length <= rawSrc.length)

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — DEDUPE ORDERING: raw lead → find duplicates (pre) → enrichment →
// find duplicates again (post) → gate. Index comparisons on named call sites,
// not literal line pins.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · dedupe ordering — pre-enrich BEFORE spend, post-enrich AFTER]")
const idxTerritoryGate   = code.indexOf("'territory_mismatch'")
const idxIdentityGate    = code.indexOf("'insufficient_identity'")
const idxPreEnrichDedup  = code.indexOf("findBestMatch(preEnrichLookup")
const idxEnrichSpend     = code.indexOf("enrichWithPeopleData(")
const idxPostEnrichDedup = code.indexOf("findBestMatch(enriched,")
const idxEligibilityGate = code.indexOf("evaluateCanonicalLeadEligibility(promoCandidate)")
const idxLeadsInsert     = code.search(/\.from\('leads'\)\s*\.insert\(/)

check("every gate/dedupe/spend token is actually present in the source (no silent 0)",
  [idxTerritoryGate, idxIdentityGate, idxPreEnrichDedup, idxEnrichSpend, idxPostEnrichDedup, idxEligibilityGate, idxLeadsInsert].every((i) => i >= 0))
check("territory gate runs before pre-enrich dedupe",   idxTerritoryGate  < idxPreEnrichDedup)
check("identity gate runs before pre-enrich dedupe",     idxIdentityGate   < idxPreEnrichDedup)
check("PRE-enrichment dedupe runs BEFORE enrichment spend (no wasted PeopleData/Perplexity calls on a record that will be discarded as a duplicate)",
  idxPreEnrichDedup < idxEnrichSpend)
check("POST-enrichment dedupe runs AFTER enrichment (the record is re-checked once identity is filled in)",
  idxEnrichSpend < idxPostEnrichDedup)
check("the promotion-identity GATE runs after post-enrich dedupe, before the leads insert",
  idxPostEnrichDedup < idxEligibilityGate && idxEligibilityGate < idxLeadsInsert)

// Both dedupe passes call the SAME function, over the SAME three canonical
// tables (owner round 38) — proved once on the function body, not per call site.
const fbmStart = code.indexOf("async function findBestMatch")
const fbmEnd   = code.indexOf("async function logDeduplication")
const fbmBody  = fbmStart >= 0 && fbmEnd > fbmStart ? code.slice(fbmStart, fbmEnd) : ""
check("findBestMatch exists and its body was actually sliced (not a silent empty string)", fbmBody.length > 200)
check("findBestMatch queries ALL THREE canonical tables — raw_scraped_leads AND leads AND contacts",
  /\.from\('leads'\)/.test(fbmBody) && /\.from\('contacts'\)/.test(fbmBody) && /\.from\('raw_scraped_leads'\)/.test(fbmBody))
check("findBestMatch scopes leads AND contacts to the record's own brokerage (no cross-tenant PII merge)",
  (fbmBody.match(/\.eq\('brokerage_id', brokerageId\)/g) ?? []).length >= 2)
check("pre-enrich AND post-enrich both call the identical findBestMatch (one function, table set can never drift between passes)",
  idxPreEnrichDedup >= 0 && idxPostEnrichDedup >= 0)

// The matcher itself: a name-only match must never auto-merge two different
// people (the identity anchor requirement behind BOTH dedupe passes).
console.log("\n[Layer 2b · the matcher pre/post-enrich dedupe actually calls]")
const nameOnly = calculateFuzzyMatch(
  { first_name: "Maria", last_name: "Gonzalez", email: null, phone: null },
  { first_name: "Maria", last_name: "Gonzalez", email: null, phone: null },
)
check("THE BUG THIS GATE EXISTS TO PREVENT: name-only exact match is NOT auto-merged", !isConfidentMatch(nameOnly))
const emailMatch = calculateFuzzyMatch(
  { first_name: "Maria", last_name: "Gonzalez", email: "m@x.com", phone: null },
  { first_name: "Maria", last_name: "Gonzalez", email: "m@x.com", phone: null },
)
check("an exact email match IS a confident auto-merge", isConfidentMatch(emailMatch))

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 3 — THE GATE. Eligibility + address verification before the insert,
// fail-closed on every refusal path.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · the conversion gate — eligibility + address verification, fail-closed]")

check("gate refuses without BOTH first and last name, even with email+phone",
  !evaluateCanonicalLeadEligibility({ first_name: null, last_name: "Doe", email: "a@b.com", phone: "5551234567" }).eligible)
check("gate refuses a full name with NO reachable channel",
  !evaluateCanonicalLeadEligibility({ first_name: "A", last_name: "B" }).eligible)
check("gate promotes on name + PHONE alone (owner wave-14 wording: phone counts)",
  evaluateCanonicalLeadEligibility({ first_name: "A", last_name: "B", phone: "5551234567" }).eligible === true)
check("gate promotes on name + EMAIL alone",
  evaluateCanonicalLeadEligibility({ first_name: "A", last_name: "B", email: "a@b.com" }).eligible === true)
check("a BARE unverified mailing-address string does NOT satisfy the gate (the round-38 defect this gate replaced)",
  !evaluateCanonicalLeadEligibility({ first_name: "A", last_name: "B", mailing_address: "123 Main St", mailing_address_verified: false }).eligible)
check("a VERIFIED mailing address alone DOES satisfy the gate",
  evaluateCanonicalLeadEligibility({ first_name: "A", last_name: "B", mailing_address: "123 Main St", mailing_address_verified: true }).eligible === true)

check("Lob spend is bought ONLY when the address is the record's ONLY possible anchor",
  needsPromotionAddressVerification({ mailing_address: "123 Main St", mailing_address_verified: false }) === true)
check("Lob spend is WITHHELD when an email already makes the record reachable (no spend needed)",
  needsPromotionAddressVerification({ email: "a@b.com", mailing_address: "123 Main St", mailing_address_verified: false }) === false)
check("Lob spend is WITHHELD when a phone already makes the record reachable",
  needsPromotionAddressVerification({ phone: "5551234567", mailing_address: "123 Main St", mailing_address_verified: false }) === false)
check("an address Lob already ruled on (CASS_SOURCE) is never re-bought",
  needsPromotionAddressVerification({ mailing_address: "123 Main St", mailing_address_verified: false, mailing_address_source: CASS_SOURCE }) === false)

// Wiring: the gate runs BEFORE the insert, and the ARM'S WRITER (Lob) runs
// before the gate is re-evaluated — and a refusal genuinely RETURNS (fail
// closed) rather than falling through into the insert below it.
const idxAddressVerifyWriter = code.indexOf("verifyMailingAddressForPromotion({")
const idxFinalRefusal        = code.indexOf("if (!promoEligibility.eligible) {")
check("address-verification writer runs between the first eligibility check and the final refusal check",
  idxEligibilityGate < idxAddressVerifyWriter && idxAddressVerifyWriter < idxFinalRefusal)
check("the FINAL refusal check runs before the leads insert (fail-closed: refuse, don't fall through)",
  idxFinalRefusal >= 0 && idxFinalRefusal < idxLeadsInsert)
// The refusal branch must itself terminate the function (a `return` inside it,
// before the insert token) — a gate that computes a verdict and ignores it is
// the same failure as never gating at all.
const refusalBlock = code.slice(idxFinalRefusal, idxLeadsInsert)
check("the refusal branch actually RETURNS (never reaches the leads insert on refusal)",
  /return\s*\{/.test(refusalBlock) && /success:\s*false/.test(refusalBlock))
check("FAIL CLOSED, verbatim: no LOB_API_KEY / a transient Lob failure never fabricates `verified: true`",
  /verified: false, patch: \{\}, reason: decision\.reason/.test(stripComments(readFileSync("lib/lead-pipeline/promotion-address-verification.ts", "utf8"))))

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 4 — SUBSCRIPTION + TERRITORY gates run UPSTREAM of ingestion. A raw
// lead can only exist for an active-subscriber territory in the first place;
// the territory (geography) gate then runs first inside processRawRecord
// itself (already proved in Layer 2).
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 4 · subscription gate — upstream of any raw record existing]")
check("no active subscriber ⇒ honest no-op (never scrapes past-due/cancelled/paused territory)",
  resolveScrapeTerritoriesFrom(
    [{ brokerage_id: "b1", status: "cancelled" }],
    [{ brokerage_id: "b1", city: "Austin" }],
  ).noOp === true)
check("an active subscriber's territory passes the resolver through",
  resolveScrapeTerritoriesFrom(
    [{ brokerage_id: "b1", status: "active" }],
    [{ brokerage_id: "b1", city: "Austin" }],
  ).territories.length === 1)
check("a TRIALING subscriber is treated as live (not just 'active')",
  activeSubscriberBrokerageIds([{ brokerage_id: "b1", status: "trialing" }]).has("b1"))
check("past_due is NOT eligible for scraping",
  !activeSubscriberBrokerageIds([{ brokerage_id: "b1", status: "past_due" }]).has("b1"))

const cronSrc = stripComments(readFileSync("app/api/cron/lead-scraping/route.ts", "utf8"))
const kernelScrapingSrc = stripComments(readFileSync("lib/kernel/scraping.ts", "utf8"))
check("the lead-scraping cron resolves territory through the subscription-gated resolver before scraping",
  cronSrc.includes("resolveActiveScrapeTerritories"))
check("the kernel scraping loop resolves territory through the SAME resolver (no second, ungated code path)",
  kernelScrapingSrc.includes("resolveScrapeTerritoriesFrom"))

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 5 — every TERMINAL status carries processed_at. Derived from the ONE
// vocabulary (processing-status.ts), not a hand-picked 'promoted'|'error' list.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 5 · every terminal status is written with processed_at]")
for (const s of RAW_PROCESSING_STATUSES) {
  const shouldBeTerminal = !(IN_FLIGHT_STATUSES as readonly string[]).includes(s)
  check(`isTerminalRawProcessingStatus('${s}') === ${shouldBeTerminal}`, isTerminalRawProcessingStatus(s) === shouldBeTerminal)
}
check("every REJECTION status (gate-stop reason) is terminal", REJECTION_STATUSES.every((s) => isTerminalRawProcessingStatus(s)))
check("'promoted' and 'error' are terminal", isTerminalRawProcessingStatus("promoted") && isTerminalRawProcessingStatus("error"))
check("every IN_FLIGHT status is NOT terminal (still moving)", IN_FLIGHT_STATUSES.every((s) => !isTerminalRawProcessingStatus(s)))

// Wiring: setStatus's processed_at write is DERIVED (calls the predicate),
// never re-pinned to a literal 'promoted' || 'error' check.
const setStatusStart = code.indexOf("async function setStatus")
const setStatusEnd   = code.indexOf("export async function processRawRecord")
const setStatusBody  = setStatusStart >= 0 && setStatusEnd > setStatusStart ? code.slice(setStatusStart, setStatusEnd) : ""
check("setStatus body was sliced (not a silent empty string)", setStatusBody.length > 100)
check("setStatus derives processed_at from isTerminalRawProcessingStatus(status) — not a hardcoded status list",
  /isTerminalRawProcessingStatus\(status\)\s*\?\s*\{\s*processed_at/.test(setStatusBody))
check("setStatus no longer hardcodes the old ('promoted'|'error') literal check for processed_at",
  !/status === 'promoted' \|\| status === 'error'/.test(setStatusBody))
// Every gate-stop call site in the file passes a status setStatus will now
// recognise as terminal — count occurrences of each rejection status literal
// as a setStatus() first argument.
let gateStopCallSites = 0
for (const s of REJECTION_STATUSES) {
  const m = code.match(new RegExp(`setStatus\\(supabase, rawRecordId, '${s}'`, "g"))
  gateStopCallSites += m ? m.length : 0
}
check("at least one setStatus() call site exists for every rejection status this file can reach",
  gateStopCallSites >= REJECTION_STATUSES.length,
  `${gateStopCallSites} call sites over ${REJECTION_STATUSES.length} statuses`)
// The 'promoted' path writes processed_at directly on its own update (not
// through setStatus) — prove that block still carries it.
const promotedBlock = code.slice(code.indexOf("processing_status: 'promoted' as ProcessingStatus,") - 40, code.indexOf("processing_status: 'promoted' as ProcessingStatus,") + 200)
check("the 'promoted' update (outside setStatus) also carries processed_at", /processed_at:\s*new Date/.test(promotedBlock))

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 6 — brokerage ownership from the market/territory, never a request
// body; source_origin carried onto the promoted lead.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 6 · brokerage ownership from session/market, never a body — source_origin carried]")
check("effectiveBrokerageId resolves from the explicit param OR the market's OWN brokerage_id (never a raw body field)",
  code.includes("const effectiveBrokerageId = brokerageId ?? marketBrokerageId"))
check("marketBrokerageId is read off lead_scraping_markets (the territory row), not a request payload",
  /marketBrokerageId = \(market as \{ brokerage_id\?: string \| null \}\)\.brokerage_id/.test(code))
check("no brokerage owner is resolvable ⇒ the record is refused, not promoted with a guessed tenant",
  code.includes("'unassigned_no_market'") && code.includes("if (!effectiveBrokerageId)"))
check("the leads insert stamps brokerage_id from effectiveBrokerageId (platform-origin leads park NULL by design)",
  /brokerage_id:\s*\(rec\.source_origin \?\? 'brokerage'\) === 'platform' \? null : effectiveBrokerageId,/.test(code))
check("the leads insert carries source_origin from the raw record",
  /source_origin:\s*rec\.source_origin \?\? 'brokerage',/.test(code))

// Two of the three real-world callers, checked for the tenancy discipline. This
// one check reads RAW (not stripped) source on purpose — the thing being proved
// IS the doc comment declaring the param dead weight; stripping it is exactly
// what would make the check pass falsely on a file where it had been deleted.
const socialSrcRaw = readFileSync("app/actions/scrape-social-media.ts", "utf8")
check("scrapeSocialMedia's brokerageId PARAM is explicitly documented+ignored — the real value is session-derived",
  socialSrcRaw.includes("ignored — derived from session"))
check("…and getAgentContext (session resolver) is actually imported, so the doc comment has something to point at",
  stripComments(socialSrcRaw).includes("getAgentContext"))
check("the lead-scraping cron passes brokerageId from the TERRITORY row (market.brokerage_id), never a body",
  cronSrc.includes("brokerageId: market.brokerage_id"))

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 7 — raw_scraped_leads.dedupe_status: opposite-missing (read, no
// writer) — the writer this lane BUILT, and its vocabulary.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 7 · raw_scraped_leads.dedupe_status — the reader had no writer; now it does]")
const promoteLeadSrc = readFileSync("app/actions/lead-promotion/promote-lead.ts", "utf8")
check("THE READER: listRawLeadsForReview SELECTs dedupe_status off raw_scraped_leads",
  /\.select\(("|`)[^)]*\bdedupe_status\b/.test(promoteLeadSrc))
check("…and surfaces it on the row shape the platform bench renders (dedupeStatus)",
  promoteLeadSrc.includes("dedupeStatus:") && promoteLeadSrc.includes("r.dedupe_status"))
const intakePageSrc = readFileSync("app/dashboard/admin/lead-intake/page.tsx", "utf8")
check("the reader is wired into a real production surface (the Lead Intake Cockpit calls listRawLeadsForReview)",
  intakePageSrc.includes("listRawLeadsForReview"))

check("THE WRITER (built this lane): setStatus writes dedupe_status when a dedupe verdict was reached",
  /dedupe_status: 'complete' satisfies DedupeStatus/.test(setStatusBody) && /opts\?\.dedupeComplete/.test(setStatusBody))
const dedupeCompleteCallSites = (code.match(/\{\s*dedupeComplete:\s*true\s*\}/g) ?? []).length
check("every dedupe-verdict call site (pre-dup, post-dup ×3, insufficient_identity_for_promotion, error) passes dedupeComplete:true",
  dedupeCompleteCallSites === 6, `found ${dedupeCompleteCallSites}, expected 6`)
check("gates that stop BEFORE dedupe ever runs (territory_mismatch, insufficient_identity, unassigned_no_market) do NOT claim a dedupe verdict",
  !new RegExp(`setStatus\\(supabase, rawRecordId, '(territory_mismatch|insufficient_identity|unassigned_no_market)'[^)]*dedupeComplete`).test(code))
check("the 'promoted' update also stamps dedupe_status: 'complete' directly (both passes necessarily cleared to reach it)",
  /dedupe_status:\s*'complete' satisfies DedupeStatus,/.test(code))

check("vocabulary is DERIVED from the sibling leads.dedupe_status column's own observed values (pending/complete), not invented",
  DEDUPE_STATUSES.length === 2
  && (DEDUPE_STATUSES as readonly string[]).includes("pending")
  && (DEDUPE_STATUSES as readonly string[]).includes("complete")
  && !(DEDUPE_STATUSES as readonly string[]).includes("deduped"))
const lineageClientSrc = readFileSync("app/dashboard/admin/lead-lineage/lead-lineage-client.tsx", "utf8")
check("the sibling column's only other reader in the tree uses exactly this vocabulary ('complete')",
  lineageClientSrc.includes("lead.dedupe_status === 'complete'"))

// The opposite-missing census is the independent instrument that FOUND this.
// Once the writer landed and the integrator regenerated the baseline
// (2026-09-15), the column is GONE from col-read-no-write — that absence is
// the permanent state the writer guarantees, and a regression of the writer
// surfaces as a NEW census finding (which fails that guard outright). Assert
// the rule, not the pre-fix waypoint (CLAUDE.md §2).
const baseline = JSON.parse(readFileSync("scripts/opposite-missing-baseline.json", "utf8"))
check("opposite-missing-baseline.json no longer carries raw_scraped_leads.dedupe_status as a writer-less read (the writer exists; a regression would be a NEW census finding)",
  !(baseline.keys?.["col-read-no-write"] ?? []).includes("raw_scraped_leads.dedupe_status"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(60))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log("\n❌ LEAD_INTAKE_PIPELINE_CONTRACT — see failures above")
  process.exit(1)
} else {
  console.log(" ✅ LEAD_INTAKE_PIPELINE_CONTRACT — raw lead → dedupe → enrich → dedupe → gate → lead, proved end to end")
}
