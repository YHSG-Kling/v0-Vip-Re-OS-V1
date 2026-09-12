#!/usr/bin/env tsx
/**
 * scripts/conversion-gate-auto-enrichment-simulator.ts
 *   (npm run test:conversion-gate-enrichment) — pure + source, no DB, no network.
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO OWNER RULINGS, WAVE 14, BOTH VERBATIM.
 *
 *  1. THE CONVERSION GATE
 *     "when a raw lead gets converted to a lead, the gate approves only if there
 *      is a first name and last name and email and/or phone number and/or a
 *      mailing address verified."
 *
 *     Read precisely: first name AND last name are BOTH required; then at least
 *     ONE of {email, phone, VERIFIED mailing address}. The word VERIFIED is the
 *     load-bearing one — an unverified scrap of an address does not satisfy the
 *     gate. Which makes `mailing_address_verified` a gate input, and a gate is
 *     only as honest as the writer behind its inputs.
 *
 *  2. AUTOMATIC ENRICHMENT
 *     "when a list or any time there is a new contact, there is an automatic
 *      enrichment run."
 *
 * ── WHY EACH ASSERTION EXISTS ────────────────────────────────────────────────
 * A gate proof that only tests the APPROVALS is not a proof. Every arm of a
 * disjunction can be satisfied by a gate that returns `true` unconditionally, so
 * the REFUSALS are the assertions that can actually fail: first name only, last
 * name missing, all three channels absent, and — the one this ruling turns on —
 * an address present but NOT verified.
 *
 * And an absence assertion needs a POSITIVE CONTROL. Where this file claims a
 * pattern is gone from the source, it first proves the finder still recognises
 * that pattern in a synthetic sample; otherwise a broken regex and a clean tree
 * report the same zero. Source reads run through scripts/strip-comments.ts, so a
 * rule quoted in a comment can never be mistaken for a rule in force — this file
 * asserts the ABSENCE of the old `hasMailingData` fallback, and that fallback is
 * still described, in prose, in the very comment that replaced it.
 *
 * LAYERS
 *   PURE   — the gate itself, and the Lob→gate interpretation (fail closed).
 *   SOURCE — the writer is wired at the promotion path; the dishonest writer is
 *            gone; enrichment is queued on the single-contact and list-import
 *            doors; the bulk path is bounded; the lead→contact conversion still
 *            carries notes, lineage and dnc_status.
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  evaluateCanonicalLeadEligibility,
  hasVerifiedMailingAddress,
  hasUnverifiedMailingAddress,
} from "../lib/lead-pipeline/canonical-lead-eligibility"
import {
  needsPromotionAddressVerification,
  interpretLobForPromotion,
} from "../lib/lead-pipeline/promotion-address-verification"
import { CASS_SOURCE } from "../lib/providers/mailing-cass-gate"
import { stripComments } from "./strip-comments"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"))
/** Raw (comments intact) — used only where the assertion is ABOUT the prose. */
const raw = (rel: string) => readFileSync(join(root, rel), "utf8")

/**
 * Both enrichment cores import `server-only`, which throws under plain `tsx`, so
 * the caps are read from the (comment-stripped) source rather than imported —
 * the same idiom scripts/enrichment-suppression-simulator.ts already uses for
 * MAX_PENDING_LEAD_ENRICHMENTS. Returns NaN when the constant is absent, which
 * fails the assertions below rather than silently passing.
 */
const capFrom = (rel: string, name: string): number => {
  const m = new RegExp(`export const ${name}\\s*=\\s*(\\d+)`).exec(src(rel))
  return m ? Number(m[1]) : Number.NaN
}
const MAX_PENDING_CONTACT_ENRICHMENTS = capFrom("lib/enrichment/contact-enrichment-core.ts", "MAX_PENDING_CONTACT_ENRICHMENTS")
const MAX_PENDING_LEAD_ENRICHMENTS    = capFrom("lib/enrichment/lead-enrichment-core.ts",    "MAX_PENDING_LEAD_ENRICHMENTS")

let pass = 0, fail = 0
const fails: string[] = []
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ═════════════════════════════════════════════════════════════════════════════
// RULING 1 · THE CONVERSION GATE
// ═════════════════════════════════════════════════════════════════════════════
function gatePure() {
  console.log("\n[PURE · ruling 1 — the gate approves]")
  const email = evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "Gonzalez", email: "m@x.com" })
  check("first + last + EMAIL → approved via email",
    email.eligible === true && (email as any).via.join(",") === "email")

  const phone = evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "Gonzalez", phone: "3055550142" })
  check("first + last + PHONE → approved via phone (the owner named phone; round 38 had excluded it)",
    phone.eligible === true && (phone as any).via.join(",") === "phone")

  const addr = evaluateCanonicalLeadEligibility({
    first_name: "Walter", last_name: "Sobchak",
    mailing_address: "742 Evergreen Ter, Miami FL 33101", mailing_address_verified: true,
  })
  check("first + last + VERIFIED mailing address → approved via the address arm",
    addr.eligible === true && (addr as any).via.join(",") === "verified_mailing_address")

  const all = evaluateCanonicalLeadEligibility({
    first_name: "Maria", last_name: "Gonzalez", email: "m@x.com", phone: "3055550142",
    mailing_address: "PO Box 9", mailing_address_verified: true,
  })
  check("all three channels → every one is named in `via` (attribution, not just a boolean)",
    all.eligible === true && (all as any).via.length === 3)

  console.log("\n[PURE · ruling 1 — THE REFUSALS (the assertions that can actually fail)]")
  const firstOnly = evaluateCanonicalLeadEligibility({ first_name: "Maria", email: "m@x.com", phone: "3055550142" })
  check("REFUSAL · FIRST NAME ONLY → refused, failing 'name', however reachable they are",
    firstOnly.eligible === false && (firstOnly as any).failing === "name")

  const lastMissing = evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "   ", email: "m@x.com" })
  check("REFUSAL · LAST NAME MISSING (whitespace is not a name) → refused, failing 'name'",
    lastMissing.eligible === false && (lastMissing as any).failing === "name")

  const lastOnly = evaluateCanonicalLeadEligibility({ last_name: "Gonzalez", email: "m@x.com" })
  check("REFUSAL · LAST NAME ONLY → refused, failing 'name'",
    lastOnly.eligible === false && (lastOnly as any).failing === "name")

  const noChannel = evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "Gonzalez" })
  check("REFUSAL · ALL THREE CHANNELS ABSENT → refused, failing 'contact_anchor'",
    noChannel.eligible === false && (noChannel as any).failing === "contact_anchor")
  check("REFUSAL · the refusal reason states the owner's rule, all three arms",
    /email address and\/or a phone number and\/or a VERIFIED mailing address/.test((noChannel as any).reason))

  const unverified = evaluateCanonicalLeadEligibility({
    first_name: "Walter", last_name: "Sobchak",
    mailing_address: "742 Evergreen Ter, Miami FL 33101", mailing_address_verified: false,
  })
  check("REFUSAL · ADDRESS PRESENT BUT NOT VERIFIED → refused (the word the owner used is VERIFIED)",
    unverified.eligible === false && (unverified as any).failing === "contact_anchor")

  const unverifiedNull = evaluateCanonicalLeadEligibility({
    first_name: "Walter", last_name: "Sobchak", mailing_address: "742 Evergreen Ter",
  })
  check("REFUSAL · an address with NO verdict at all is not verified either (null !== true)",
    unverifiedNull.eligible === false && (unverifiedNull as any).failing === "contact_anchor")

  const flagNoAddress = evaluateCanonicalLeadEligibility({
    first_name: "Walter", last_name: "Sobchak", mailing_address_verified: true,
  })
  check("REFUSAL · a verified FLAG with no address string is not a mailing address",
    flagNoAddress.eligible === false && (flagNoAddress as any).failing === "contact_anchor")

  const whitespace = evaluateCanonicalLeadEligibility({
    first_name: "Maria", last_name: "Gonzalez", email: "  ", phone: "\t", mailing_address: " ", mailing_address_verified: true,
  })
  check("REFUSAL · whitespace in every channel fabricates nothing", whitespace.eligible === false)

  console.log("\n[PURE · ruling 1 — the address predicates]")
  check("hasVerifiedMailingAddress demands BOTH the string and the flag",
    hasVerifiedMailingAddress({ mailing_address: "x", mailing_address_verified: true }) === true &&
    hasVerifiedMailingAddress({ mailing_address: "x" }) === false &&
    hasVerifiedMailingAddress({ mailing_address_verified: true }) === false)
  check("hasUnverifiedMailingAddress finds exactly the records a verification could rescue",
    hasUnverifiedMailingAddress({ mailing_address: "x" }) === true &&
    hasUnverifiedMailingAddress({ mailing_address: "x", mailing_address_verified: true }) === false &&
    hasUnverifiedMailingAddress({}) === false)
}

function gateWriterPure() {
  console.log("\n[PURE · ruling 1 — the verified-address WRITER: when it spends, and what it concludes]")
  check("spends ONLY when the address is the record's only possible anchor",
    needsPromotionAddressVerification({ mailing_address: "742 Evergreen Ter" }) === true)
  check("does NOT spend when an email already opens the gate",
    needsPromotionAddressVerification({ email: "m@x.com", mailing_address: "742 Evergreen Ter" }) === false)
  check("does NOT spend when a phone already opens the gate",
    needsPromotionAddressVerification({ phone: "3055550142", mailing_address: "742 Evergreen Ter" }) === false)
  check("does NOT spend when there is nothing to verify",
    needsPromotionAddressVerification({}) === false)
  check("does NOT re-buy a verdict already recorded as verified",
    needsPromotionAddressVerification({ mailing_address: "x", mailing_address_verified: true }) === false)
  check("does NOT re-buy an address Lob already ruled UNDELIVERABLE (the CASS marker is the receipt)",
    needsPromotionAddressVerification({ mailing_address: "x", mailing_address_source: CASS_SOURCE }) === false)

  // FAIL CLOSED — the whole point. A gate that cannot run must refuse.
  const unavailable = interpretLobForPromotion(null)
  check("FAIL CLOSED · no LOB_API_KEY / transient failure → NOT verified",
    unavailable.verified === false)
  check("FAIL CLOSED · and writes NOTHING (a synthetic false would look like Lob's own verdict next pass)",
    Object.keys(unavailable.patch).length === 0)

  const deliverable = interpretLobForPromotion({
    verified: true, deliverability: "deliverable",
    standardized: { primary_line: "742 EVERGREEN TER", city: "MIAMI", state: "FL", zip_code: "33101" },
    raw: {}, error: null,
  })
  check("deliverable → verified, and Lob's STANDARDIZED parts are what gets persisted",
    deliverable.verified === true &&
    deliverable.patch.mailing_address === "742 EVERGREEN TER" &&
    deliverable.patch.mailing_address_verified === true &&
    deliverable.patch.mailing_address_source === CASS_SOURCE)

  const undeliverable = interpretLobForPromotion({
    verified: false, deliverability: "undeliverable", standardized: {}, raw: {}, error: null,
  })
  check("undeliverable (authoritative) → NOT verified, and the false verdict is RECORDED so it is not re-bought",
    undeliverable.verified === false &&
    undeliverable.patch.mailing_address_verified === false &&
    undeliverable.patch.mailing_address_source === CASS_SOURCE)

  // The verdict feeds the gate, and the gate refuses on it. End to end, pure.
  const afterUndeliverable = evaluateCanonicalLeadEligibility({
    first_name: "Walter", last_name: "Sobchak",
    mailing_address: "742 Evergreen Ter",
    mailing_address_verified: undeliverable.patch.mailing_address_verified as boolean,
  })
  check("END TO END · an undeliverable address still refuses the conversion",
    afterUndeliverable.eligible === false && (afterUndeliverable as any).failing === "contact_anchor")
  const afterDeliverable = evaluateCanonicalLeadEligibility({
    first_name: "Walter", last_name: "Sobchak",
    mailing_address: deliverable.patch.mailing_address as string,
    mailing_address_verified: deliverable.patch.mailing_address_verified as boolean,
  })
  check("END TO END · a deliverable address opens the gate on the address arm alone",
    afterDeliverable.eligible === true && (afterDeliverable as any).via.join(",") === "verified_mailing_address")
}

function gateSource() {
  console.log("\n[SOURCE · ruling 1 — the gate is enforced where leads are actually made]")
  const pipeline = src("lib/lead-pipeline/pipeline-processor.ts")
  check("the promotion path delegates to THE canonical gate (one gate, no local copy)",
    /evaluateCanonicalLeadEligibility\(/.test(pipeline))
  check("the gate is fed the PHONE (the arm the owner added)",
    /phone:\s+enriched\.phone \?\? phone,/.test(pipeline))
  check("the gate is fed the verified FLAG, not merely the address string",
    /mailing_address_verified:\s+resolvedMailingVerified/.test(pipeline))
  check("a refused record is NOT promoted — it stays raw under insufficient_identity_for_promotion",
    /insufficient_identity_for_promotion/.test(pipeline) && /promotion_identity_gate/.test(pipeline))
  check("the writer runs ONLY on a contact_anchor refusal (never on a name refusal, never on a pass)",
    /failing === "contact_anchor"/.test(pipeline) && /verifyMailingAddressForPromotion\(/.test(pipeline))
  check("the gate is RE-EVALUATED after the verification, by the same canonical function",
    pipeline.split("evaluateCanonicalLeadEligibility(").length - 1 >= 2)
  check("the promoted lead carries the verdict AND the CASS marker (so nothing re-buys it)",
    /mailing_address_verified:\s*resolvedMailingVerified/.test(pipeline) &&
    /mailing_address_source:\s*resolvedMailingSource/.test(pipeline))

  const evaluator = src("lib/lead-promotion/eligibility-evaluator.ts")
  // The delegation body moved to eligibility-core.ts when the integrator split this
  // lane's PUBLIC DOOR from its ungated core. That split is the point: a "use server"
  // file publishes EVERY export as an HTTP endpoint, and this one ran a service-role
  // client and returned the whole raw_scraped_leads row with no session and no tenant
  // predicate — a cross-tenant read of another brokerage's raw lead. Assert the gate
  // here so it cannot quietly come back off.
  const evaluatorCore = src("lib/lead-promotion/eligibility-core.ts")
  check("the second historical promotion path delegates to the SAME gate (no drift)",
    /evaluateCanonicalLeadEligibility\(/.test(evaluatorCore) && /phone:\s+rawRecord\.phone/.test(evaluatorCore))
  check("that path — a 'use server' public endpoint — spends NOTHING on verification",
    !/verifyMailingAddressForPromotion|verifyAddressViaLob/.test(evaluator))
  check("the public door is GATED: tenant from the session, never the caller",
    /getAgentContext\(\)/.test(evaluator) && /brokerage_id\s*!==\s*brokerageId/.test(evaluator))
  check("the ungated core is NOT itself a 'use server' module",
    !/^['"]use server['"]/m.test(evaluatorCore))
  check("the public door refuses a foreign record with the SAME message as a missing one (no id oracle)",
    (evaluator.match(/return REFUSAL/g) || []).length >= 3)

  console.log("\n[SOURCE · ruling 1 — the dishonest writer is gone (with a positive control)]")
  const orchestrator = src("lib/lead-pipeline/enrichment-orchestrator.ts")
  const finder = /mailingVerified[^\n]*:\s*boolean\s*=\s*typeof mvRaw === 'boolean' \? mvRaw : hasMailingData/
  // POSITIVE CONTROL — the finder must still recognise the defect it was written for.
  const synthetic = "const mailingVerified: boolean = typeof mvRaw === 'boolean' ? mvRaw : hasMailingData"
  check("positive control · the finder still recognises the old 'an address exists ⇒ verified' fallback",
    finder.test(synthetic))
  check("the fallback is GONE from the live enrichment writer",
    !finder.test(orchestrator))
  check("absent an explicit provider verdict the flag stays FALSE",
    /const mailingVerified: boolean = mvRaw === true/.test(orchestrator))
  check("and the prose still explains what was removed and why (blind spots published, not erased)",
    /hasMailingData/.test(raw("lib/lead-pipeline/enrichment-orchestrator.ts")))

  console.log("\n[SOURCE · ruling 1 — the flag's OTHER writers agree on one vocabulary]")
  const leadQa = src("app/actions/lead-quick-actions.ts")
  const contactQa = src("app/actions/contact-quick-actions.ts")
  check("hand-verifying a LEAD address stamps the CASS marker (so the mail gate does not re-bill it)",
    /mailing_address_verified: data\.verified, mailing_address_source: CASS_SOURCE/.test(leadQa))
  check("hand-verifying a CONTACT address stamps marker + timestamp",
    /mailing_address_source:\s+CASS_SOURCE/.test(contactQa) && /mailing_address_verified_at:/.test(contactQa))
  check("both READ the write error — a swallowed refusal would report a verification that never landed",
    /verifyWriteError/.test(leadQa) && /verifyWriteError/.test(contactQa))
}

// ═════════════════════════════════════════════════════════════════════════════
// RULING 2 · AUTOMATIC ENRICHMENT
// ═════════════════════════════════════════════════════════════════════════════
function enrichmentSource() {
  console.log("\n[SOURCE · ruling 2 — ONE enrichment lane, not a second one]")
  const core = src("lib/enrichment/contact-enrichment-core.ts")
  check("the survivor is still the only contact-side queue writer",
    /export async function queueContactEnrichment\(/.test(core))
  const doors = [
    ["lib/contact-pipeline/contact-capture.ts",        /queueContactEnrichment\(/],
    ["lib/kernel/event-reactor.ts",                    /queueContactEnrichment\(/],
    ["lib/kernel/crm.ts",                              /queueContactEnrichment\(/],
    ["lib/application/lead-application-service.ts",    /queueContactEnrichment\(/],
    ["app/actions/home-value.ts",                      /queueContactEnrichment\(/],
  ] as const
  for (const [file, re] of doors) {
    check(`${file} calls the SURVIVOR (no private copy)`, re.test(src(file)))
  }
  const priv = /from\("lead_enrichment_queue"\)\s*\.insert\(|from\('lead_enrichment_queue'\)\s*\.insert\(/
  check("positive control · the private-queue-writer finder recognises a direct insert",
    priv.test(`await supabase.from("lead_enrichment_queue").insert({ contact_id })`))
  // The survivor is deliberately NOT in `doors` — it is the one file that MAY
  // write the queue, and every door listed above must go through it.
  for (const [file] of doors) {
    check(`${file} does NOT write the queue itself`, !priv.test(src(file)))
  }

  console.log("\n[SOURCE · ruling 2 — SINGLE new contact: the create-time lane fires]")
  const capture = src("lib/contact-pipeline/contact-capture.ts")
  check("captureContact queues on the CREATE path", /queueContactEnrichmentAndScore\(/.test(capture))
  const reactor = src("lib/kernel/event-reactor.ts")
  check("the reactor queues on CONTACT_CREATED and CONTACT_CAPTURED",
    /KernelEvent\.CONTACT_CREATED \|\| params\.event === KernelEvent\.CONTACT_CAPTURED/.test(reactor))
  const openHouse = src("app/actions/seller-open-house.ts")
  check("the open-house conversion now DISPATCHES its CONTACT_CREATED (a bare lifecycle insert never reached the reactor)",
    /processKernelEvent\(\{[\s\S]{0,200}?KernelEvent\.CONTACT_CREATED/.test(openHouse))
  const homeValue = src("app/actions/home-value.ts")
  check("both home-value contact doors queue enrichment",
    (homeValue.match(/queueContactEnrichment\(/g) ?? []).length === 2)

  console.log("\n[SOURCE · ruling 2 — A LIST: every import door reaches the lane]")
  const importActions = src("app/actions/lead-import/import-actions.ts")
  check("the CSV import routes every row through captureContact (which queues)",
    /captureContact\(/.test(importActions))
  const importPull = src("lib/crm/import-pull.ts")
  check("the CRM migration pull feeds the SAME gated import pipeline (no bypass)",
    /CrmPullPage/.test(importPull) && !/from\("contacts"\)/.test(importPull))
  const appService = src("lib/application/lead-application-service.ts")
  check("serviceImportLeads — the list door that inserted contacts directly — now queues per row",
    /queueContactEnrichment\(\{[\s\S]{0,200}?triggerType: "import"/.test(appService))

  console.log("\n[SOURCE · ruling 2 — SUPPRESSED during an active deal (previous ruling, still in force)]")
  check("the queue writer consults the live-deal predicate BEFORE writing a row",
    /isContactInLiveDeal\(/.test(core))
  check("the drain re-checks suppression before it spends",
    /isContactInLiveDeal\(/.test(src("lib/lead-pipeline/enrichment-orchestrator.ts")))
}

function bulkBound() {
  console.log("\n[PURE + SOURCE · ruling 2 — the bulk path is BOUNDED (a 5,000-row import cannot fan out unbounded)]")
  check("the contact lane now HAS a backlog cap", Number.isFinite(MAX_PENDING_CONTACT_ENRICHMENTS))
  check("it is the same number as the lead lane's (one vocabulary, no drift)",
    MAX_PENDING_CONTACT_ENRICHMENTS === MAX_PENDING_LEAD_ENRICHMENTS)
  const IMPORT_ROWS = 5_000
  check(`a ${IMPORT_ROWS}-row import commits at most ${MAX_PENDING_CONTACT_ENRICHMENTS} queued enrichments, not ${IMPORT_ROWS}`,
    Math.min(IMPORT_ROWS, MAX_PENDING_CONTACT_ENRICHMENTS) === MAX_PENDING_CONTACT_ENRICHMENTS &&
    MAX_PENDING_CONTACT_ENRICHMENTS < IMPORT_ROWS)
  const perContactUsd = 0.16
  const cappedSpend = MAX_PENDING_CONTACT_ENRICHMENTS * perContactUsd
  const uncappedSpend = IMPORT_ROWS * perContactUsd
  check(`committed spend is bounded at ~$${cappedSpend.toFixed(0)}/tenant, not ~$${uncappedSpend.toFixed(0)} per upload`,
    cappedSpend < uncappedSpend / 10)

  const core = src("lib/enrichment/contact-enrichment-core.ts")
  check("the cap counts contact_id rows ONLY (a lead surge cannot mask an import, or vice versa)",
    /\.not\("contact_id", "is", null\)/.test(core))
  check("the cap counts only rows still in flight (pending/processing)",
    /\.in\("status", \["pending", "processing"\]\)/.test(core))
  check("FAIL CLOSED on the money question: an unreadable backlog count refuses rather than uncapping",
    /backlogError[\s\S]{0,200}?reason: "error"/.test(core))
  check("'backlog' is a REFUSAL REASON, not an exception — the import still finishes",
    /reason: "backlog"/.test(core))

  console.log("\n[SOURCE · ruling 2 — backpressure, not a drop: the refused rows are still reachable]")
  check("the nightly net selects by EVIDENCE (enriched_at IS NULL), so a backlogged contact is picked up later",
    /\.is\("enriched_at", null\)/.test(core))
  const cron = src("app/api/cron/contact-enrichment/route.ts")
  check("the net is a real, bounded cron (per-brokerage cap + a global per-run vendor ceiling)",
    /PER_BROKERAGE_ENRICH/.test(cron) && /RUN_VENDOR_CALL_BUDGET/.test(cron))
  const drain = src("lib/lead-pipeline/enrichment-orchestrator.ts")
  check("the drain itself takes a bounded batch per tick (the queue is a buffer, not a reservoir)",
    /const BATCH_SIZE = \d+/.test(drain))
}

function conversionInvariants() {
  console.log("\n[SOURCE · standing rulings that must survive this change]")
  const creator = src("lib/contact-promotion/contact-creator.ts")
  check("lead→contact conversion still CARRIES dnc_status from the lead (was once hardcoded false)",
    /dnc_status:\s+data\.lead\.dnc_status\s+\?\?\s+false/.test(creator) &&
    !/dnc_status:\s*false\s*,/.test(creator))
  check("conversion still carries the lead's NOTES and its LINEAGE",
    /Promoted from lead \$\{data\.leadId\}/.test(creator) && /notes:/.test(creator))
  check("conversion still carries the mailing verification state onto the contact",
    /mailing_address_verified:\s+data\.lead\.mailing_address_verified/.test(creator))
  const gate = src("lib/lead-pipeline/canonical-lead-eligibility.ts")
  check("the gate module stays PURE (the plain-tsx simulators import it directly)",
    !/^import /m.test(gate) && !/require\(/.test(gate))
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════════════")
  console.log(" CONVERSION GATE + AUTOMATIC ENRICHMENT — two owner rulings, wave 14")
  console.log("══════════════════════════════════════════════════════════════════════")
  gatePure()
  gateWriterPure()
  gateSource()
  enrichmentSource()
  bulkBound()
  conversionInvariants()
  console.log(`\n${"═".repeat(70)}`)
  console.log(`CONVERSION GATE + AUTO ENRICHMENT — ${pass} passed, ${fail} failed`)
  console.log("Blind spots: no DB and no network layer here. The gate, the Lob")
  console.log("interpretation and the bulk bound are proved as pure functions; the")
  console.log("wiring is proved by comment-stripped source. Whether Lob itself")
  console.log("answers, and whether the queue drains, are live questions this")
  console.log("simulator deliberately does not claim to have checked.")
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of fails) console.log(`  · ${f}`)
    console.log("\nA gate that approves a nameless or unreachable record is not a gate,")
    console.log("and an unbounded import is a bill nobody approved.")
    process.exit(1)
  }
  console.log("✅ CONVERSION_GATE_AUTO_ENRICHMENT_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
