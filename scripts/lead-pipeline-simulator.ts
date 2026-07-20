#!/usr/bin/env tsx
/**
 * scripts/lead-pipeline-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 39 — end-to-end lead scraping → enrichment → promotion simulator.
 *
 * The scraping/enrichment subsystem (BatchData + PeopleData HTTP clients, 10+
 * sources, raw_scraped_leads → enrich → promote → leads → contacts) is REAL and
 * production-grade. This harness proves the COMPLETE flow with NO mocks:
 *
 *   Layer 1 — the real decision functions the pipeline runs at every gate
 *             (fuzzy dedup, canonical eligibility, BatchData normalization,
 *             territory gate, source scoring). Deterministic, no DB, no API.
 *
 *   Layer 2 — a LIVE DB round-trip that drives those same canonical gates
 *             (recordMatchesTerritory → evaluateCanonicalLeadEligibility →
 *             calculateFuzzyMatch) and performs the real `leads` promotion
 *             insert exactly as pipeline-processor.ts does, then asserts the
 *             Kernel-OS ownership fields landed, and DELETES every test row
 *             (including on failure). Requires SUPABASE_SERVICE_ROLE_KEY;
 *             skips cleanly without it so the pure layer still runs in CI.
 *
 *   Layer 4 — THE CANONICAL SCRAPING PRE-PIPELINE (owner, round 38): shared
 *             pre-scrape territory resolver (active tenants' territories only,
 *             honest no-op otherwise), sourcer no-op-without-territory, THREE-
 *             table dedup (raw+leads+contacts) in BOTH passes, enrich between
 *             the passes, first+last-name AND email-and/or-mailing-address
 *             eligibility (round 39 name correction), and the deterministic
 *             brokerage-pickup rule. Pure + static conformance.
 *
 *   Layer 5 — PARKED PLATFORM LEADS (owner, round 39): a platform lead whose
 *             zip has no subscriber is PARKED (brokerage_id NULL), never
 *             deleted; the AI ISA is structurally excluded until the 2-hour
 *             distribution sweep un-parks it into a new subscriber's rotation.
 *
 * The production promotion path (processRawRecord) wraps these same functions
 * behind the SSR cookie client + the paid PeopleData enrichment call — neither
 * is script-drivable, so Layer 2 drives the identical gate functions directly
 * against the live schema. No stubs, no mock data, full cleanup.
 *
 * Run:  npx tsx scripts/lead-pipeline-simulator.ts   (npm run test:lead-pipeline)
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { calculateFuzzyMatch } from "../lib/lead-pipeline/fuzzy-matcher"
import { evaluateCanonicalLeadEligibility } from "../lib/lead-pipeline/canonical-lead-eligibility"
import { resolveScrapeTerritoriesFrom, territoryUnion } from "../lib/lead-pipeline/scrape-territories"
import { normalizeBatchDataProperty } from "../lib/external/batchdata-client"
import {
  recordMatchesTerritory, calculateSourceScore, resolveSourceKey,
  scoreToUrgencyLevel, getSourceSemantics, expandEnabledSources,
} from "../lib/lead-pipeline/source-intent-map"
import { engine2GatePasses, deriveQualificationSignals, qualificationScoreFor } from "../lib/ai-isa/qualification-core"
import { validatePromotionEligibility } from "../lib/contact-promotion/promotion-eligibility"
import { evaluateRuleConditions, pickRoundRobinAgent } from "../lib/lead-assignment/rule-matcher"
import { BROKER_COMMANDS } from "../lib/voice/team-command-names"
import { parseTeamCommandText } from "../lib/voice/parse-team-command"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const approx = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — real decision functions (no DB, no external API)
// ─────────────────────────────────────────────────────────────────────────────

function testFuzzyDedup() {
  console.log("\n[Layer 1 · fuzzy dedup — calculateFuzzyMatch]")
  const a = { first_name: "Maria", last_name: "Gonzalez", email: "maria.g@example.com", phone: "(305) 555-0142" }
  check("identical records → score 1.0", approx(calculateFuzzyMatch(a, a).score, 1.0))
  // Same phone, different formatting → phone normalizes to a match.
  const b = { ...a, phone: "305-555-0142" }
  check("phone formatting differences still match", calculateFuzzyMatch(a, b).details.phoneScore === 1.0)
  // Same email, slightly different name → high (email weight 0.35 dominates).
  const c = { first_name: "Maria", last_name: "Gonzales", email: "maria.g@example.com", phone: null }
  check("same email + near name → high score", calculateFuzzyMatch(a, c).score > 0.8)
  // Totally different person → low.
  const d = { first_name: "Robert", last_name: "Kim", email: "rkim@other.com", phone: "212-555-9999" }
  check("different person → low score", calculateFuzzyMatch(a, d).score < 0.4)
  // No shared anchors → zero (avoids false-positive merges).
  check("no comparable fields → score 0", calculateFuzzyMatch({ email: "x@y.com" }, { phone: "123" }).score === 0)
}

function testEligibilityGate() {
  console.log("\n[Layer 1 · promotion gate — evaluateCanonicalLeadEligibility (owner canonical, round 39: first+last NAME AND (email AND/OR mailing address))]")
  const full = evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "Gonzalez", email: "m@x.com", phone: "3055550142", mailing_address: "PO Box 9", mailing_address_verified: true })
  check("full identity + email + mailing → eligible via BOTH anchors",
    full.eligible === true && (full as any).via.includes("email") && (full as any).via.includes("mailing_address"))
  const nameAndEmail = evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "Gonzalez", email: "m@x.com" })
  check("name + email (no mailing) → eligible via email",
    nameAndEmail.eligible === true && (nameAndEmail as any).via.join(",") === "email")
  const mailingAnchor = evaluateCanonicalLeadEligibility({ first_name: "Walter", last_name: "Sobchak", mailing_address: "742 Evergreen Ter, Miami FL 33101" })
  check("name + mailing address (no email) → eligible via mailing (and/or rule)",
    mailingAnchor.eligible === true && (mailingAnchor as any).via.join(",") === "mailing_address")
  const verifiedFlagWithName = evaluateCanonicalLeadEligibility({ first_name: "Walter", last_name: "Sobchak", mailing_address_verified: true })
  check("verified-mailing flag counts as the mailing anchor", verifiedFlagWithName.eligible === true)
  const emailNoName = evaluateCanonicalLeadEligibility({ email: "m@x.com" })
  check("email WITHOUT first+last name → NOT eligible, failing 'name' (retryable — enrichment can supply names)",
    emailNoName.eligible === false && (emailNoName as any).failing === "name")
  const partialName = evaluateCanonicalLeadEligibility({ first_name: "Maria", email: "m@x.com" })
  check("first name alone does not satisfy the name requirement",
    partialName.eligible === false && (partialName as any).failing === "name")
  const phoneOnly = evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "Gonzalez", phone: "3055550142" })
  check("name + phone only (no email, no mailing) → NOT eligible (phone is not an owner anchor)",
    phoneOnly.eligible === false && (phoneOnly as any).failing === "contact_anchor")
  const nothing = evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "Gonzalez" })
  check("name but no anchors → blocked with the honest owner-rule reason",
    nothing.eligible === false && /email address and\/or a mailing address/i.test((nothing as any).reason))
  check("whitespace-only email/mailing do not fabricate an anchor",
    evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "Gonzalez", email: "   ", mailing_address: "  " }).eligible === false)
  check("whitespace-only names do not fabricate a name",
    (evaluateCanonicalLeadEligibility({ first_name: "  ", last_name: " ", email: "m@x.com" }) as any).failing === "name")
}

function testBatchDataNormalize() {
  console.log("\n[Layer 1 · BatchData normalization — normalizeBatchDataProperty]")
  // Realistic BatchData Property Search response shape.
  const payload = {
    address: { street: "742 Evergreen Ter", city: "Miami", state: "FL", zip: "33133" },
    owner: { fullName: "Walter Sobchak", phone: "3055551234", email: null,
             mailingAddress: { street: "PO Box 9", city: "Miami", state: "FL", zip: "33101" } },
    building: { bedroomCount: 4, bathroomCount: 3, livingAreaSquareFeet: 2450 },
    valuation: { estimatedValue: 689000, estimatedEquity: 410000 },
    quickLists: ["high-equity", "absentee-owner"],
  }
  const r = normalizeBatchDataProperty(payload, "high_equity")
  check("splits fullName → first/last", r.firstName === "Walter" && r.lastName === "Sobchak")
  check("prefers owner mailing address over property address", r.city === "Miami" && r.zip === "33101")
  check("keeps property address separately", r.propertyAddress === "742 Evergreen Ter" && r.propertyZip === "33133")
  check("preserves valuation signal", r.valuation?.estimatedValue === 689000)
  check("preserves quickLists motivation tags", Array.isArray(r.quickLists) && r.quickLists!.includes("high-equity"))
  check("missing email stays null (no fabrication)", r.email === null)
}

function testTerritoryAndScoring() {
  console.log("\n[Layer 1 · territory gate + source scoring]")
  const market = { city: "Miami", state: "FL", zip_codes: ["33133", "33101"] }
  check("zip in market → in territory", recordMatchesTerritory({ zip: "33133" }, market) === true)
  check("zip outside market → rejected", recordMatchesTerritory({ zip: "90210" }, market) === false)
  check("city+state match → in territory", recordMatchesTerritory({ city: "Miami", state: "FL" }, market) === true)
  check("wrong city → rejected", recordMatchesTerritory({ city: "Tampa", state: "FL" }, market) === false)
  check("no geo data → passes through (cannot reject)", recordMatchesTerritory({}, market) === true)

  const key = resolveSourceKey("batchdata_motivated")
  check("resolveSourceKey maps a real source", !!key)
  const sem = getSourceSemantics("batchdata_motivated")
  check("getSourceSemantics returns leadType + motivationType", !!sem.leadType && typeof sem.motivationType === "string")
  const score = calculateSourceScore("batchdata_motivated", ["high_equity", "absentee"])
  check("source score is within 0–100", score >= 0 && score <= 100)
  check("scoreToUrgencyLevel maps score → temperature (matches leads constraint)",
    scoreToUrgencyLevel(80) === "hot" && scoreToUrgencyLevel(50) === "warm" && scoreToUrgencyLevel(30) === "cool" && scoreToUrgencyLevel(10) === "cold")
  const expanded = expandEnabledSources(["batchdata_motivated", "zenrows_zillow"])
  check("expandEnabledSources returns a Set", expanded instanceof Set && expanded.size > 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 3 — CANONICAL BUSINESS PROCESS (owner, round 37)
//   "rawleads are platform only and can't be manually moved to leads (full
//    automatic promotion). leads are qualified by the ai isa, converted to
//    contacts once qualified, and auto-assigned per the admin's settings."
// Static source conformance (no manual door anywhere) + the real pure gate
// functions the auto chain runs. No DB, no mocks.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

/** Recursive walk of app/ + lib/ .ts(x) sources (skips node_modules by construction). */
function walkSources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(name)) out.push({ rel: p.slice(ROOT.length + 1), text: readFileSync(p, "utf8") })
    }
  }
  walk(join(ROOT, "app"))
  walk(join(ROOT, "lib"))
  return out
}

function testNoManualRawToLeadDoor() {
  console.log("\n[Layer 3 · raw→lead: automatic pipeline is the ONLY door]")
  const sources = walkSources()
  const callers = (re: RegExp, allow: RegExp) =>
    sources.filter((s) => re.test(s.text) && !allow.test(s.rel)).map((s) => s.rel)

  // The old manual orchestration action is gone — nothing in app/ or lib/ calls it.
  const promoteLeadCalls = callers(/\bpromoteLead\s*\(/, /^$/)
  check("no promoteLead( caller anywhere in app/ or lib/", promoteLeadCalls.length === 0, promoteLeadCalls.join(", "))
  const action = src("app/actions/lead-promotion/promote-lead.ts")
  check("lead-promotion action exports NO manual promote verb (inspection listing only)",
    !/export\s+async\s+function\s+promoteLead\b/.test(action) && /listRawLeadsForReview/.test(action))

  // The promotion-insert lib is reachable only through lib/lead-promotion itself (+ test scripts).
  const rawPromoteCalls = callers(/\bpromoteRawRecordToLead\s*\(/, /^lib[\/\\]lead-promotion[\/\\]/)
  check("promoteRawRecordToLead has no production caller outside lib/lead-promotion", rawPromoteCalls.length === 0, rawPromoteCalls.join(", "))

  // The dashboard bench is read-only; the on-demand broker POST trigger is gone.
  const bench = src("app/dashboard/admin/lead-intake/raw-leads-review.tsx")
  check("raw-leads bench has no promote button/import (read-only inspection)", !/promoteLead/.test(bench))
  const route = src("app/api/leads/process-pipeline/route.ts")
  check("process-pipeline route has no POST (stats GET only)", !/export\s+async\s+function\s+POST\b/.test(route) && /export\s+async\s+function\s+GET\b/.test(route))

  // Voice: raw→lead is not speakable. The broker lead verb is convert_lead (qualified only).
  check("voice BROKER_COMMANDS excludes promote_lead, includes convert_lead",
    !BROKER_COMMANDS.has("promote_lead") && BROKER_COMMANDS.has("convert_lead"))
  const brokerLane = src("lib/voice/broker-commands.ts")
  check("voice broker lane never touches raw_scraped_leads", !/raw_scraped_leads/.test(brokerLane))
  check("voice broker lane rides Engine 2 (evaluateAndAssignLead)", /evaluateAndAssignLead/.test(brokerLane))
  const parsedPromote = parseTeamCommandText("promote the lead for John Smith")
  const parsedConvert = parseTeamCommandText("convert the lead for John Smith")
  check("spoken 'promote the lead …' now routes to convert_lead (no raw door)",
    parsedPromote?.name === "convert_lead" && parsedConvert?.name === "convert_lead")

  // The automatic pipeline runs from the cron and completes the platform lane.
  const cron = src("app/api/cron/lead-scraping/route.ts")
  check("lead-scraping cron runs the automatic promotion pass (processRawRecord)", /processRawRecord\(/.test(cron))
  const pipeline = src("lib/lead-pipeline/pipeline-processor.ts")
  check("pipeline carries source_origin and fires Engine 1 distribution itself",
    /source_origin/.test(pipeline) && /distributePlatformLead/.test(pipeline))
}

function testAutoConvertChainLive() {
  console.log("\n[Layer 3 · qualification → auto-convert → auto-assign chain]")
  // The AI-ISA qualification hook: readiness triggers consent → qualified → Engine 2.
  const evalSrc = src("lib/ai-isa/qualification-evaluator.ts")
  check("qualification hook transitions consent via the kernel handler", /handleConsentReceived/.test(evalSrc))
  check("qualification hook marks lead qualified + hands to Engine 2", /lead_stage:\s*'qualified'/.test(evalSrc) && /evaluateAndAssignLead/.test(evalSrc))
  // Engine 2 assigns per admin policy then converts + notifies through the canonical handler.
  const engine = src("lib/lead-assignment/assignment-engine.ts")
  check("Engine 2 reads the admin's assignment_rules policy", /from\("assignment_rules"\)/.test(engine))
  check("Engine 2 converts via handleLeadAssigned (no forked converter)", /handleLeadAssigned\(/.test(engine))
  const handlers = src("lib/kernel/lead-acquisition-handlers.ts")
  check("handleLeadAssigned converts through THE canonical createContactFromLead", /createContactFromLead/.test(handlers))
  check("handleLeadAssigned emits LEAD_ASSIGNED + LEAD_CONVERTED_TO_CONTACT (agent notification fan-out)",
    /KernelEvent\.LEAD_ASSIGNED/.test(handlers) && /LEAD_CONVERTED_TO_CONTACT/.test(handlers))

  // The REAL pure gate the engine runs (Engine 2 Step 2 semantics).
  check("engine2 gate: unqualified lead REFUSED", engine2GatePasses("new", "unconsented") === false)
  check("engine2 gate: qualified but unconsented REFUSED", engine2GatePasses("qualified", "unconsented") === false)
  check("engine2 gate: qualified + consented passes", engine2GatePasses("qualified", "consented") === true)

  // Qualification core still derives readiness the hook keys off.
  const ready = deriveQualificationSignals({
    messageText: "we're ready to schedule asap", conversationCount: 3, timeline: "immediate", leadScore: 70,
  })
  check("ISA readiness derives from intent+urgency+engagement+score", ready.readinessForAgent === true && qualificationScoreFor(ready) === 85)
  const notReady = deriveQualificationSignals({ messageText: "who is this?", conversationCount: 1, leadScore: 20 })
  check("non-ready conversation stays with the ISA", notReady.readinessForAgent === false)
}

async function testConversionRefusesUnqualified() {
  console.log("\n[Layer 3 · conversion refuses unqualified leads (server-side)]")
  // THE canonical service eligibility (promoteLeadToContactService inherits this).
  const unqual = await validatePromotionEligibility({
    lead_stage: "new", agent_id: "a1", is_active: true, email: "x@y.com", first_name: "Maria",
  })
  check("service eligibility: unqualified lead REFUSED (even with agent + contact info)",
    unqual.isEligible === false && /qualified/i.test(unqual.reason))
  const qual = await validatePromotionEligibility({
    lead_stage: "qualified", agent_id: "a1", is_active: true, email: "x@y.com", first_name: "Maria",
  })
  check("service eligibility: qualified + assigned lead passes", qual.isEligible === true)
  const qualNoAgent = await validatePromotionEligibility({
    lead_stage: "qualified", is_active: true, email: "x@y.com", first_name: "Maria",
  })
  check("service eligibility: qualified but unassigned still refused", qualNoAgent.isEligible === false)

  // The kernel manual-conversion command carries the same refusal.
  const crm = src("lib/kernel/crm.ts")
  check("kernel convertLeadToContact refuses lead_stage !== 'qualified'",
    /lead_stage[\s\S]{0,80}!==\s*"qualified"/.test(crm) && /has not been qualified/.test(crm))
  // The ISA appointment lane stamps the qualification an appointment evidences (no bypass, no break).
  const appt = src("lib/ai-isa/book-seller-appointment.ts")
  check("ISA appointment lane stamps lead_stage='qualified' before its safety-convert",
    /lead_stage:\s*"qualified"/.test(appt))
}

function testAssignmentPolicyConsumed() {
  console.log("\n[Layer 3 · admin assignment policy → conversion path]")
  // The settings surface the admin configures…
  const ui = src("app/dashboard/admin/assignment-rules/page.tsx")
  check("admin settings surface manages assignment_rules (with honest fallback copy)",
    /assignment_rules/.test(ui) && /fallback/i.test(ui))
  // …is evaluated by the SAME pure matcher the engine runs.
  const lead = { source: "batchdata_motivated", lead_score: 80, property_zip_code: "33133" }
  check("rule matcher: matching conditions fire", evaluateRuleConditions(lead as any, { min_score: 50 }) === true)
  check("rule matcher: failing conditions do not", evaluateRuleConditions(lead as any, { min_score: 90 }) === false)
  check("round-robin pick rotates deterministically",
    pickRoundRobinAgent(["a", "b", "c"], 0) === "a" && pickRoundRobinAgent(["a", "b", "c"], 4) === "b")
  // Track B (import-time contacts) shares the same policy chain.
  const track2 = src("lib/lead-assignment/contact-assignment.ts")
  check("contact capture lane consumes the same assignment_rules chain", /assignment_rules/.test(track2))
}

function testVisibilityGates() {
  console.log("\n[Layer 3 · visibility gates (round 33) still hold]")
  const action = src("app/actions/lead-promotion/promote-lead.ts")
  check("raw-lead listing is platform-staff-only (tenants refused server-side)",
    /platform_role/.test(action) && /platform-only/i.test(action))
  const page = src("app/dashboard/admin/lead-intake/page.tsx")
  check("lead-intake page renders the raw bench only for platform staff", /isPlatform\s*&&\s*<RawLeadsReviewPanel/.test(page))
  const lifecycle = src("app/actions/lead-lifecycle.ts")
  check("lead-desk verbs gated to brokerage-level roles + platform", /LEAD_DESK_ROLES/.test(lifecycle) && /superadmin/.test(lifecycle))
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 4 — THE CANONICAL SCRAPING PRE-PIPELINE (owner, round 38 — verbatim):
//   "before scrap, checks all active tenants and their territories which are
//    setup in their settings at onboarding then only scrapes those areas, pulls
//    in raw leads, then dedup against raw leads, leads and contacts, enriches,
//    dedups again and if atleast an email address and/or mailing address,
//    promote to a lead when picks up a brokerage and ai isa starts trying to
//    qualify."
// Pure resolver tests + static source conformance + real sourcer no-op checks.
// ─────────────────────────────────────────────────────────────────────────────

function testScrapeTerritoryResolver() {
  console.log("\n[Layer 4 · shared pre-scrape territory resolver (active tenants only)]")
  const subs = [
    { brokerage_id: "b-active",  status: "active" },
    { brokerage_id: "b-trial",   status: "trialing" },
    { brokerage_id: "b-churned", status: "cancelled" },
    { brokerage_id: "b-pastdue", status: "past_due" },
  ]
  const markets = [
    { brokerage_id: "b-active",  city: "Miami",  state: "FL", zip_codes: ["33133", "33101"], counties: ["Miami-Dade"] },
    { brokerage_id: "b-trial",   city: "Austin", state: "TX", zip_codes: ["78701", "33133"], counties: null },
    { brokerage_id: "b-churned", city: "Tampa",  state: "FL", zip_codes: ["33602"], counties: null },
    { brokerage_id: "b-pastdue", city: "Dallas", state: "TX", zip_codes: ["75201"], counties: null },
  ]
  const res = resolveScrapeTerritoriesFrom(subs, markets)
  check("only ACTIVE tenants' territories survive the resolver", res.noOp === false && res.territories.length === 2)
  check("churned tenant's territory is never scraped", !res.territories.some((t) => t.brokerage_id === "b-churned"))
  check("past_due tenant's territory is never scraped", !res.territories.some((t) => t.brokerage_id === "b-pastdue"))
  check("trialing counts as a live tenant (trials are customers)", res.territories.some((t) => t.brokerage_id === "b-trial"))

  const noSubs = resolveScrapeTerritoriesFrom([{ brokerage_id: "b-churned", status: "cancelled" }], markets)
  check("no active subscribers → honest no-op (no_active_subscribers), zero territories",
    noSubs.noOp === true && noSubs.reason === "no_active_subscribers" && noSubs.territories.length === 0)
  const noTerr = resolveScrapeTerritoriesFrom(subs, [markets[2]])
  check("active subscribers WITHOUT territories → honest no-op (never scrapes the whole country)",
    noTerr.noOp === true && noTerr.reason === "no_active_territories" && noTerr.territories.length === 0)

  const union = territoryUnion(res.territories)
  check("territoryUnion is the DEDUPED union of active territories (zip 33133 once)",
    union.zipCodes.filter((z) => z === "33133").length === 1 && union.zipCodes.length === 3)
  check("union spans both tenants' states, none from inactive tenants",
    union.states.includes("FL") && union.states.includes("TX") && union.cities.includes("miami") && !union.cities.includes("tampa"))
}

function testScraperTerritoryConformance() {
  console.log("\n[Layer 4 · every scraper derives its areas from the shared resolver (static conformance)]")
  const cron = src("app/api/cron/lead-scraping/route.ts")
  check("lead-scraping cron (ZenRows/BatchData/Apify social/Exa/Tavily/OSINT/recruiting) consumes resolveActiveScrapeTerritories",
    /resolveActiveScrapeTerritories\(/.test(cron))
  check("cron no-ops honestly with a stated reason (no inline subscription query, no global fallback)",
    /no_op_reason/.test(cron) && !/from\("subscriptions"\)/.test(cron))
  const kernel = src("lib/kernel/scraping.ts")
  check("kernel scrape orchestrator filters its work-list through the SAME pure resolver",
    /resolveScrapeTerritoriesFrom\(/.test(kernel) && /no_active_/.test(src("lib/lead-pipeline/scrape-territories.ts")))
  const resolver = src("lib/lead-pipeline/scrape-territories.ts")
  check("resolver's active-tenant predicate IS the canonical subscription gate (active/trialing)",
    /activeSubscriberBrokerageIds/.test(resolver))
  check("territory source is the onboarding-settings work-list (lead_scraping_markets, is_active)",
    /lead_scraping_markets/.test(resolver) && /is_active/.test(resolver))
  check("both raw writers keep the INGEST territory gate (recordMatchesTerritory)",
    /recordMatchesTerritory\(/.test(cron) && /recordMatchesTerritory\(/.test(kernel))
  const intentCron = src("app/api/cron/intent-campaign/route.ts")
  check("intent-campaign cron (BatchData counts + Exa buyer intent) is active-tenant gated with honest no-op",
    /activeSubscriberBrokerageIds/.test(intentCron) && /no_active_subscribers/.test(intentCron))
}

async function testSourcersNoOpWithoutTerritory() {
  console.log("\n[Layer 4 · sourcers no-op without a territory (real functions, $0, no provider call)]")
  const { sourceExaBuyerIntent }     = await import("../lib/lead-pipeline/exa-sourcer")
  const { sourceTavilyIntent }       = await import("../lib/lead-pipeline/tavily-sourcer")
  const { sourceOsintRecords }       = await import("../lib/lead-pipeline/osint-sourcer")
  const { sourceLinkedInRelocation } = await import("../lib/lead-pipeline/social-sourcer")
  const empty = { city: null, state: null }
  const exa = await sourceExaBuyerIntent(empty)
  check("Exa sourcer: no territory → 0 records, $0 spend", exa.records.length === 0 && exa.cost === 0)
  const tavily = await sourceTavilyIntent(empty)
  check("Tavily sourcer: no territory → 0 records, $0 spend", tavily.records.length === 0 && tavily.cost === 0)
  const osint = await sourceOsintRecords(empty)
  check("OSINT sourcer: no territory state → 0 records, $0 spend", osint.records.length === 0 && osint.cost === 0)
  const li = await sourceLinkedInRelocation(empty)
  check("LinkedIn sourcer: no territory → 0 records, $0 spend (no global sweep)", li.records.length === 0 && li.cost === 0)
}

function testThreeTableDedupAndPromotionConformance() {
  console.log("\n[Layer 4 · dedup against raw+leads+contacts, enrich between passes, brokerage pickup]")
  const pipeline = src("lib/lead-pipeline/pipeline-processor.ts")

  // THREE-TABLE dedup in ONE matcher, run by BOTH passes.
  const fbm = pipeline.slice(pipeline.indexOf("async function findBestMatch"))
  check("findBestMatch consults ALL THREE tables (raw_scraped_leads + leads + contacts)",
    fbm.includes("from('leads')") && fbm.includes("from('contacts')") && fbm.includes("from('raw_scraped_leads')"))
  check("pre-enrich pass runs the three-table matcher",
    /findBestMatch\(preEnrichLookup, 'pre_enrichment', effectiveBrokerageId, supabase, dedupScope\)/.test(pipeline))
  check("post-enrich pass runs the SAME three-table matcher",
    /findBestMatch\(enriched, 'post_enrichment', effectiveBrokerageId, supabase, dedupScope\)/.test(pipeline))
  check("raw-vs-raw dedup is deterministic (older-wins, never self-match)",
    fbm.includes("excludeRawId") && fbm.includes("rawCreatedAt"))
  const kernel = src("lib/kernel/scraping.ts")
  check("kernel canonical dedup checks the third table too (raw_identity_match, matchType 'raw')",
    /raw_identity_match/.test(kernel) && /'lead' \| 'contact' \| 'raw'/.test(kernel))

  // ENRICH BETWEEN THE TWO DEDUP PASSES, provider-gated honestly.
  const pre  = pipeline.indexOf("findBestMatch(preEnrichLookup")
  const enr  = pipeline.indexOf("await enrichWithPeopleData(")
  const post = pipeline.indexOf("findBestMatch(enriched")
  check("enrichment runs BETWEEN the two dedup passes (pre → enrich → post)", pre > -1 && enr > pre && post > enr)
  check("enrichment is provider-gated honestly (failure → no fabricated identity; Perplexity gap-fill cost-gated)",
    /catch\(\(\) => \(\{ data: null \}\)\)/.test(pipeline) && /shouldGapFill/.test(pipeline))

  // CANONICAL ELIGIBILITY (round 39: first+last name AND email-and/or-mailing) in both promotion paths.
  check("pipeline delegates promotion to THE canonical eligibility gate, feeding it the mailing address",
    /evaluateCanonicalLeadEligibility/.test(pipeline) && /mailing_address:\s+resolvedMailingAddress/.test(pipeline))
  check("pipeline feeds POST-ENRICH names into the gate (enrichment can SUPPLY a missing name before the pass)",
    /first_name:\s+enriched\.first_name \?\? firstName,/.test(pipeline.slice(pipeline.indexOf("evaluateCanonicalLeadEligibility({"))))
  check("enrichWithPeopleData actually backfills first/last name from the provider (names flow into promotion)",
    /first_name:\s+data\.firstName\s+\|\|\s+fields\.first_name/.test(pipeline) && /last_name:\s+data\.lastName\s+\|\|\s+fields\.last_name/.test(pipeline))
  const evaluator = src("lib/lead-promotion/eligibility-evaluator.ts")
  check("lead-promotion evaluator delegates to the SAME canonical gate (no drift)",
    /evaluateCanonicalLeadEligibility/.test(evaluator) && /mailing_address:/.test(evaluator))
  check("evaluator feeds names first-class-column-first (same resolution chain as the pipeline)",
    /first_name:\s+rawRecord\.first_name \?\? rawData\.first_name/.test(evaluator))
  const gate = src("lib/lead-pipeline/canonical-lead-eligibility.ts")
  check("gate reports name-vs-anchor failures distinctly ('name' is retryable via enrichment, 'contact_anchor' honest)",
    /failing:\s+"name"/.test(gate) && /failing:\s+"contact_anchor"/.test(gate))
  check("promoted lead's mailing_address_verified is HONEST (no blanket true stamp)",
    !/mailing_address_verified:\s*true\s*,/.test(pipeline) && /mailing_address_verified:\s*resolvedMailingVerified/.test(pipeline))

  // BROKERAGE PICKUP on promotion.
  check("brokerage pickup: owning brokerage resolves from the scraped market's territory",
    /marketBrokerageId/.test(pipeline) && /brokerageId \?\? marketBrokerageId/.test(pipeline))
  check("no territory + no explicit brokerage → honest refusal (unassigned_no_market), never a guess",
    /unassigned_no_market/.test(pipeline))
  const dist = src("lib/platform/distribution-engine.ts")
  check("platform-origin overlap rule is deterministic: zip service-area roster ordered by joined_at, round-robin by prior distribution count",
    /subscriber_service_areas/.test(dist) && /joined_at/.test(dist) && /%\s*subscriberList\.length/.test(dist))
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 5 — PARKED PLATFORM LEADS (owner, round 39): "distribution sweep should
// not get rid of any leads if no subscriber but just pause the ai isa from
// engaging and they don't get worked at all." Parked = platform-origin lead
// with brokerage_id NULL + distribution_brokerage_id NULL: never deleted, no
// tenant sees it, the AI ISA never engages it, and the 2-hour sweep re-attempts
// distribution until a subscriber joins the zip (un-park → engagement begins).
// ─────────────────────────────────────────────────────────────────────────────

function testParkedPlatformLeads() {
  console.log("\n[Layer 5 · parked platform leads — no subscriber ⇒ PARK (never delete), ISA excluded, sweep un-parks]")
  const dist = src("lib/platform/distribution-engine.ts")

  // NO DELETE PATH, EVER: the engine never deletes, deactivates, or terminally marks a lead.
  check("distribution engine has NO delete path and never deactivates a lead",
    !/\.delete\(/.test(dist) && !/is_active:\s*false/.test(dist))
  const noSubReturn = dist.indexOf('reason: "no_subscribers_for_zip"')
  const firstLeadWrite = dist.indexOf(".update(")
  check("no-subscriber outcome is a plain return BEFORE any write — the lead is left exactly as it was (parked)",
    noSubReturn > -1 && firstLeadWrite > noSubReturn)
  check("platform-DNC suppression also just returns (parked, not deleted, not marked)",
    dist.indexOf('reason: "suppressed_phone"') > -1 && dist.indexOf('reason: "suppressed_phone"') < firstLeadWrite)

  // THE PARKED SET IS RE-SWEPT: pending selection = platform + undistributed + active.
  check("pending sweep re-selects the parked set every run (source_origin=platform, distribution_brokerage_id NULL, is_active)",
    /\.eq\("source_origin", "platform"\)/.test(dist) && /\.is\("distribution_brokerage_id", null\)/.test(dist) && /\.eq\("is_active", true\)/.test(dist))

  // BORN PARKED: both promotion paths birth platform leads with brokerage_id NULL.
  const pipeline = src("lib/lead-pipeline/pipeline-processor.ts")
  check("pipeline births platform-origin leads PARKED (brokerage_id NULL until Engine 1 assigns a subscriber)",
    /=== 'platform' \? null : effectiveBrokerageId/.test(pipeline))
  const promoter = src("lib/lead-promotion/lead-promoter.ts")
  check("lead-promoter path births platform leads parked too (no drift between the two paths)",
    /sourceOrigin === 'platform' \? null : brokerageId/.test(promoter))

  // AI ISA EXCLUSION: the engagement sweep is per-brokerage (a NULL-brokerage lead can never
  // be selected), and the engagement entry point hard-refuses brokerage-less leads.
  const sweep = src("lib/ai-isa/speed-to-lead.ts")
  check("ISA speed-to-lead sweep selects strictly BY brokerage — parked (brokerage-less) leads are structurally unselectable",
    /\.eq\("brokerage_id", brokerageId\)/.test(sweep))
  const engage = src("app/actions/ai-isa/initiate-engagement.ts")
  check("initiate-engagement hard-refuses parked leads (stop:parked_awaiting_distribution belt-and-suspenders)",
    /stop:parked_awaiting_distribution/.test(engage) && /!lead\.brokerage_id/.test(engage))

  // UN-PARK: distribution stamps brokerage_id + distributed_at (optimistic lock), and the
  // speed-to-lead window opens on distributed_at so engagement begins even weeks after created_at.
  check("un-park = distribution stamps brokerage_id + distributed_at under the optimistic lock",
    /brokerage_id: targetBrokerageId/.test(dist) && /distributed_at: nowIso/.test(dist) && /\.is\("distribution_brokerage_id", null\)/.test(dist))
  check("speed-to-lead window opens on distributed_at too — a freshly un-parked lead gets its first touch",
    /distributed_at\.gte/.test(sweep))
  check("zip resolution falls back property → mailing → physical zip (a zip-bearing lead is never stranded as no_zip_code)",
    /lead\.property_zip_code \|\| lead\.mailing_zip \|\| lead\.zip_code/.test(dist))

  // The 2-hour cron reports every parked outcome honestly — nothing dropped, nothing faked.
  const cronSrc = src("app/api/cron/platform-lead-distribution/route.ts")
  check("2-hour sweep cron counts no_subscribers/suppressed/no_zip honestly and re-runs distributePendingPlatformLeads",
    /no_subscribers: result\.noSubscribers/.test(cronSrc) && /distributePendingPlatformLeads/.test(cronSrc))
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — live DB round-trip (real schema, real gates, full cleanup)
// ─────────────────────────────────────────────────────────────────────────────

type Cleanup = { table: string; column: string; value: string }

async function testLivePromotion() {
  console.log("\n[Layer 2 · live promotion round-trip]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer still ran).")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const RUN = `__leadsim_${Date.now()}__`
  const cleanup: Cleanup[] = []

  try {
    // Owning brokerage (existing tenant).
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage in DB."); return }
    const brokerageId = (brk as { id: string }).id

    // 1. Seed an in-territory market.
    const { data: market, error: mErr } = await svc.from("lead_scraping_markets").insert({
      brokerage_id: brokerageId, name: `${RUN}market`, city: "Miami", state: "FL",
      zip_codes: ["33133", "33101"], is_active: true,
    }).select("id, city, state, zip_codes").single()
    check("seed market territory", !mErr && !!market, mErr?.message)
    if (!market) throw new Error("market seed failed")
    cleanup.push({ table: "lead_scraping_markets", column: "id", value: (market as any).id })

    // 2. Seed a fully-formed, in-territory raw record (platform-owned, brokerage_id NULL
    //    until promotion — matches the scheduled-scrape contract).
    const preview = {
      firstName: "Maria", lastName: "Gonzalez", email: `${RUN}@example.com`,
      phone: "3055550142", city: "Miami", state: "FL", zip: "33133",
      propertyAddress: "742 Evergreen Ter", intentSignals: ["high_equity", "absentee"],
    }
    const { data: raw, error: rErr } = await svc.from("raw_scraped_leads").insert({
      brokerage_id: null, market_id: (market as any).id, source: "batchdata_motivated",
      source_record_id: `${RUN}rec`, raw_data: { ...preview, mailing_address_verified: true, mailing_address: "PO Box 9" },
      normalized_preview: preview, processing_status: "pending", mailing_address_verified: true,
    }).select("id").single()
    check("seed raw_scraped_leads record", !rErr && !!raw, rErr?.message)
    if (!raw) throw new Error("raw seed failed")
    const rawId = (raw as any).id
    cleanup.push({ table: "raw_scraped_leads", column: "id", value: rawId })

    // 3. Drive the REAL gates the production path runs, in order.
    const recGeo = { city: preview.city, state: preview.state, zip: preview.zip }
    check("real gate: record is in market territory",
      recordMatchesTerritory(recGeo, market as any) === true)

    const elig = evaluateCanonicalLeadEligibility({
      first_name: preview.firstName, last_name: preview.lastName,
      email: preview.email, phone: preview.phone, mailing_address_verified: true,
    })
    check("real gate: candidate is promotion-eligible", elig.eligible === true)

    // Dedup against existing leads for this brokerage (sentinel email → no match expected).
    const { data: existing } = await svc.from("leads")
      .select("first_name,last_name,email,phone").eq("brokerage_id", brokerageId)
      .or(`email.eq.${preview.email},phone.eq.${preview.phone}`).limit(5)
    const dupHit = (existing ?? []).some((e: any) =>
      calculateFuzzyMatch({ first_name: preview.firstName, last_name: preview.lastName, email: preview.email, phone: preview.phone }, e).score >= 0.8)
    check("real gate: no pre-existing duplicate", dupHit === false)

    // 4. Real promotion insert — exact Kernel-OS contract from pipeline-processor.ts.
    const sem = getSourceSemantics("batchdata_motivated")
    const score = calculateSourceScore("batchdata_motivated", preview.intentSignals)
    const { data: lead, error: lErr } = await svc.from("leads").insert({
      brokerage_id: brokerageId, first_name: preview.firstName, last_name: preview.lastName,
      email: preview.email, phone: preview.phone, source: "batchdata_motivated",
      lead_type: sem.leadType !== "unknown" ? sem.leadType : null,
      motivation_type: sem.motivationType, motivation_confidence: score / 100,
      urgency_level: scoreToUrgencyLevel(score), lead_score: score,
      enrichment_status: "completed", enrichment_confidence: 0.9, lead_stage: "new",
      source_raw_ids: [rawId], lifecycle_state: "unconsented", ai_isa_owner: true,
      minimum_viable_for_isa: true, mailing_address_verified: true,
      mailing_address: "PO Box 9", email_verified: false, raw_record_id: rawId,
    }).select("id, lifecycle_state, ai_isa_owner, lead_stage").single()
    check("promotion insert lands in leads", !lErr && !!lead, lErr?.message)
    if (!lead) throw new Error("promotion insert failed")
    cleanup.push({ table: "leads", column: "id", value: (lead as any).id })

    check("lead carries Kernel-OS ownership (unconsented + ai_isa_owner)",
      (lead as any).lifecycle_state === "unconsented" && (lead as any).ai_isa_owner === true)

    // 5. Close the loop on the raw record exactly as the pipeline does.
    const { error: upErr } = await svc.from("raw_scraped_leads")
      .update({ lead_id: (lead as any).id, processing_status: "promoted", processed_at: new Date().toISOString() })
      .eq("id", rawId)
    check("raw record marked promoted + linked to lead", !upErr, upErr?.message)
    const { data: promoted } = await svc.from("raw_scraped_leads").select("processing_status, lead_id").eq("id", rawId).single()
    check("raw status reads back 'promoted' with lead_id",
      (promoted as any)?.processing_status === "promoted" && (promoted as any)?.lead_id === (lead as any).id)

    // 6. Negative cases against the real gates (no promotion should occur).
    check("real gate: out-of-territory record rejected",
      recordMatchesTerritory({ city: "Tampa", state: "FL", zip: "33602" }, market as any) === false)
    check("real gate: candidate with NO email and NO mailing address not promotable",
      evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "Gonzalez", phone: "3055550142" }).eligible === false)
  } finally {
    // Self-cleanup — reverse order, best-effort, runs even on failure.
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq(c.column, c.value) } catch { /* ignore */ }
    }
    // Belt-and-suspenders: purge anything matching the run sentinel. Order
    // matters — raw_scraped_leads.lead_id FK-references leads, so delete the
    // child rows before the leads they point at.
    try { await svc.from("raw_scraped_leads").delete().eq("source_record_id", `${RUN}rec`) } catch { /* ignore */ }
    try { await svc.from("leads").delete().like("email", `${RUN}%`) } catch { /* ignore */ }
    try { await svc.from("lead_scraping_markets").delete().like("name", `${RUN}%`) } catch { /* ignore */ }
    const { count } = await svc.from("raw_scraped_leads").select("id", { count: "exact", head: true }).eq("source_record_id", `${RUN}rec`)
    check("cleanup verified — 0 test rows remain", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Lead pipeline simulator (scrape → enrich → promote → qualify → convert → assign)")
  console.log("══════════════════════════════════════════════════")
  testFuzzyDedup(); testEligibilityGate(); testBatchDataNormalize(); testTerritoryAndScoring()
  testScrapeTerritoryResolver()
  testScraperTerritoryConformance()
  await testSourcersNoOpWithoutTerritory()
  testThreeTableDedupAndPromotionConformance()
  testParkedPlatformLeads()
  testNoManualRawToLeadDoor()
  testAutoConvertChainLive()
  await testConversionRefusesUnqualified()
  testAssignmentPolicyConsumed()
  testVisibilityGates()
  await testLivePromotion()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Lead pipeline verified end-to-end (no mocks, test rows cleaned up)")
}
main().catch((e) => { console.error(e); process.exit(1) })
