#!/usr/bin/env tsx
/**
 * scripts/journey-promotion-gates-guard.ts  (npm run test:journey-promotion-gates) — in-memory, no DB, no network.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * THE CANONICAL SELLER + BUYER JOURNEYS, EACH PROMOTION GUARDED AT ITS AUTHORITATIVE WRITE (wave 144, lane 144B).
 *
 * Owner (wave 144 ruling 19, abridged): SELLER motivated-seller signal → raw lead → dedup/identity/territory gate →
 * lead → AI qualification → contact → listing appointment → confirmation/reschedule/follow-up loop → listing intake
 * with planned MLS live date → listing agreement → e-sign ladder → compliance → fully executed agreement → coming-soon
 * eligibility/policy gate → verified MLS live → offers and counters → final executed terms → transaction → closing
 * compliance → preliminary settlement/commission → CDA if the brokerage requires → verified closing → review request →
 * lifetime → post-close touchpoints. BUYER … criteria → cash verification or pre-approval → matching → showings →
 * offer (gates bound at the write) → outside-listing loop → executed terms → compliance → transaction → … the same
 * tail. "Review requests fire at the VERIFIED closing event, not a scheduled date … Every promotion is guarded at its
 * authoritative WRITE, not only in the UI."
 *
 *   1  JOURNEY MAP — every arrow names its authoritative writer (file + function) and the gate token that function
 *      must reach; the function is sliced out of STRIPPED source (scripts/strip-comments.ts — a tombstone is not a
 *      call site) and the token must be in its body. POSITIVE CONTROL: an arrow whose gate is absent is flagged.
 *   2  THE VERIFIED-CLOSING GATE, driven for real (lib/transactions/stage-progression.ts canAdvanceStage on the
 *      in-memory client): the CDA milestone is required ONLY when the brokerage uses a CDA (resolveCdaMode), a refused
 *      brokerage read keeps it (fail closed), the milestone is found through the ONE identity resolver (the retired
 *      `m.name` lookup is shown missing the same rows — control), closing compliance is asked at the CLOSE, contingency
 *      TYPES no longer freeze a deal (the retired "initialed" predicate is shown refusing the createOffer shape —
 *      control), and the stage order holds (UNDER_CONTRACT → CLOSED and a null stage are refused by name).
 *   3  THE CLOSE THROUGH THE GATED STAGE MACHINE (advanceStage → CLOSED): close_date becomes the VERIFIED date (not the
 *      contract's scheduled one), TRANSACTION_CLOSED + DEAL_CLOSED are emitted, the BUYER and the SELLER convert through
 *      the ONE lifetime writer with the touchpoint schedule once, a hold tenant holds ("CLOSED / PAYOUT PENDING"), a
 *      re-run converts nobody twice, and the review ask is timed from the verified closing (control: the same engine on
 *      the scheduled date reads differently).
 *   4  CENSUS — every writer of a closed transaction is GATED (canAdvanceStage before the write), an AUTHORIZED
 *      OVERRIDE (requireOverrideActor + an audit event), or reported; every listing-stage door in the seller execution
 *      engine reaches its stage gate. Doors outside this lane's file domain are reported PENDING (outside lane) with the
 *      exact owner, never asserted green and never silently passed. POSITIVE CONTROLS on both finders.
 *
 * BLIND SPOTS (published): RLS is not modelled (the tenant predicates are what scope the in-memory reads); the
 * commission engine, closing-cost accuracy, net-sheet guard, prediction grading, FB audience and newsletter are
 * recorder stubs (their own proofs own them); the kernel event fan-out runs for real against the in-memory client;
 * the session-bound closing-compliance gate (app/actions/transaction-compliance.ts canProceedToClosingPrep) is a
 * recorder whose verdict the proof sets; the census reads `.from("transactions")…update({…})` payloads with a literal
 * closed status or the stage→status map — a status passed through a variable from elsewhere is not seen.
 *
 * Run: NODE_OPTIONS=--max-old-space-size=6000 npx tsx --conditions=react-server scripts/journey-promotion-gates-guard.ts
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { canaryClient, setSvc, stubModule, uuid } from "./canaries/_harness"

const ROOT = process.cwd()
let passed = 0, failed = 0
const failures: string[] = []
const pending: string[] = []
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
/** A requirement whose fix lives in ANOTHER lane's file: green once landed, otherwise published as PENDING, never passed. */
function outsideLane(name: string, landed: boolean, owner: string, detail = ""): void {
  if (landed) { passed++; console.log(`  ✓ ${name} (landed)`) }
  else { pending.push(`${name} — owner ${owner}${detail ? ` — ${detail}` : ""}`); console.log(`  ◌ PENDING (outside lane, ${owner}): ${name}${detail ? ` — ${detail}` : ""}`) }
}
const raw = (rel: string): string => { try { return readFileSync(join(ROOT, rel), "utf8") } catch { return "" } }
const code = (rel: string): string => stripComments(raw(rel))

/** The body of `function <name>(` (export or not, async or not) in stripped source — "" when absent. */
function fnBody(src: string, name: string): string {
  const m = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]`).exec(src)
  if (!m) return ""
  const start = m.index
  const rest = src.slice(start + m[0].length)
  const next = /\n(?:export\s+(?:async\s+)?function|async\s+function|function)\s+\w+\s*[(<]/.exec(rest)
  return src.slice(start, start + m[0].length + (next ? next.index : rest.length))
}

// ── recorder stubs (installed BEFORE the first import of the graph that reaches them) ───────────────────────────
const G = globalThis as unknown as { __J144: { closingGate: { allowed: boolean; blockers: string[] }; gateCalls: Array<{ t: string }>; calc: Array<Record<string, unknown>>; audience: string[]; newsletter: string[] } }
G.__J144 = { closingGate: { allowed: true, blockers: [] }, gateCalls: [], calc: [], audience: [], newsletter: [] }
stubModule("@/app/actions/transaction-compliance", "export async function canProceedToClosingPrep(t, b) { const g = globalThis.__J144; g.gateCalls.push({ t, b }); return g.closingGate } export async function seedTransactionComplianceChecks() { return { success: true } }")
stubModule("@/lib/commission/engine", "export async function calculateCommission(p) { globalThis.__J144.calc.push(p); return { success: true } }")
stubModule("@/lib/commission/reconcile-tracking", "export async function finalizeCommissionAtClose() { return { ok: true } }")
stubModule("@/lib/offers/closing-cost-accuracy", "export async function recordClosingCostAccuracy() { return { recorded: false } }")
stubModule("@/lib/net-sheet/net-sheet-guard-runner", "export async function runNetSheetSurpriseGuard() { return { ran: false } }")
stubModule("@/lib/analytics/ai-prediction-outcomes", "export async function gradeTransactionPredictionOutcomes() { return 0 } export async function markLeadConversionOutcomes() { return 0 }")
stubModule("@/lib/audiences/audience-sync", "export async function onContactBecameLifetimeForAudience(p) { globalThis.__J144.audience.push(p.contactId); return { ok: true } }")
stubModule("@/lib/content/newsletter-enrollment", "export async function enrollContactInNewsletter(p) { globalThis.__J144.newsletter.push(p.contactId); return { ok: true } }")
stubModule("@/lib/managers/accuracy-gate", "export function __clearAccuracyGateCache() {}")

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE JOURNEY MAP — arrow → authoritative writer → the gate it must reach
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
interface Arrow { id: string; journey: "seller" | "buyer" | "both"; arrow: string; file: string; fn: string; gate: RegExp; gateLabel: string }
const JOURNEY_ARROWS: readonly Arrow[] = [
  { id: "J01", journey: "both", arrow: "raw lead → dedup → identity → lead", file: "lib/lead-pipeline/pipeline-processor.ts", fn: "processRawRecord", gate: /findBestMatch\([\s\S]*evaluateCanonicalLeadEligibility\(/, gateLabel: "pre/post-enrich dedup then evaluateCanonicalLeadEligibility before the leads insert" },
  { id: "J02", journey: "both", arrow: "raw lead → territory gate", file: "lib/lead-pipeline/pipeline-processor.ts", fn: "processRawRecord", gate: /territory_mismatch/, gateLabel: "territory_mismatch refusal" },
  { id: "J03", journey: "both", arrow: "lead → AI qualification → contact (manual / ISA door)", file: "lib/contact-promotion/promote-lead-to-contact.ts", fn: "promoteLeadToContactService", gate: /validatePromotionEligibility\([\s\S]*createContactFromLead\(/, gateLabel: "validatePromotionEligibility BEFORE createContactFromLead" },
  { id: "J04", journey: "both", arrow: "qualification rule (lead_stage = qualified + agent)", file: "lib/contact-promotion/promotion-eligibility.ts", fn: "validatePromotionEligibility", gate: /lead_stage !== "qualified"/, gateLabel: "unqualified refused" },
  { id: "J05", journey: "both", arrow: "lead → contact (CRM door)", file: "lib/kernel/crm.ts", fn: "convertLeadToContact", gate: /lead_stage[\s\S]{0,40}!== "qualified"/, gateLabel: "unqualified refused" },
  { id: "J06", journey: "both", arrow: "lead → contact (automatic assignment door)", file: "lib/kernel/lead-acquisition-handlers.ts", fn: "handleLeadAssigned", gate: /assertValidTransition\('consented', 'assigned'/, gateLabel: "consented → assigned on the lead state machine" },
  { id: "J07", journey: "seller", arrow: "contact → listing appointment", file: "lib/ai-isa/book-seller-appointment.ts", fn: "bookSellerListingAppointment", gate: /lifecycle_state === "representation"[\s\S]*promoteLeadToContactService\(/, gateLabel: "representation refusal, then the qualified-only converter" },
  { id: "J08", journey: "seller", arrow: "appointment confirmation", file: "lib/ai-isa/listing-appointment.ts", fn: "confirmListingAppointment", gate: /confirmAppointmentCore\([\s\S]*fireListingAppointmentSetForBooking\(/, gateLabel: "the tenant-pinned confirm core, THEN the listing-presentation prep starts" },
  { id: "J09", journey: "seller", arrow: "appointment no-show → re-book proposal (reschedule loop)", file: "lib/kernel/appointment-noshow-autopilot.ts", fn: "runAppointmentNoShowAutopilot", gate: /rebookPlan|classifyAppointment/, gateLabel: "classify → gated re-book proposal" },
  { id: "J10", journey: "seller", arrow: "listing intake (draft at LISTING_AGREEMENT_INITIATED)", file: "lib/kernel/listings.ts", fn: "createListingRecord", gate: /isValidUUID\(input\.sellerContactId\)/, gateLabel: "seller contact id validated before the insert" },
  { id: "J11", journey: "seller", arrow: "planned MLS live date (a person's plan, never invented)", file: "lib/listings/mls-live-date.ts", fn: "recordPlannedMlsLiveDate", gate: /go_live_date/, gateLabel: "planned date recorded with its source" },
  { id: "J12", journey: "seller", arrow: "listing agreement signed → compliance audit", file: "app/actions/seller-listing/execution-engine.ts", fn: "markAgreementSigned", gate: /authorizeListingAction\([\s\S]*auditListingDocuments\([\s\S]*scanListingPacketCompleteness\([\s\S]*runListingComplianceLoop\(/, gateLabel: "session tenant → document audit + packet scan → the compliance loop (signed STARTS compliance; the pass is COMING_SOON_PREP)" },
  { id: "J13", journey: "seller", arrow: "coming-soon PREP (compliance-passed agreement)", file: "app/actions/seller-listing/execution-engine.ts", fn: "prepareComingSoonAssets", gate: /requireListingStage\(supabase, listingId, "COMING_SOON_PREP"\)/, gateLabel: "requireListingStage COMING_SOON_PREP" },
  { id: "J14", journey: "seller", arrow: "coming-soon status only after the agreement gate (the WRITE)", file: "lib/kernel/lifecycle.ts", fn: "transitionLifecycle", gate: /isGatedStage\([\s\S]*listingAgreementComplianceState\(/, gateLabel: "gated status map + compliance read in the atomic update" },
  { id: "J15", journey: "seller", arrow: "verified MLS live (feed-fed verifier only)", file: "lib/listings/mls-live-verification.ts", fn: "verifyAndRecordMlsLive", gate: /recordVerifiedMlsLive\(/, gateLabel: "the one verified-live writer" },
  { id: "J16", journey: "seller", arrow: "MLS active (the activation door)", file: "app/actions/seller-listing/execution-engine.ts", fn: "activateMLS", gate: /assertListingActivationAllowed\(/, gateLabel: "listing activation gate" },
  { id: "J17", journey: "buyer", arrow: "buyer criteria → matching (session-gated search)", file: "app/actions/buyer-property-search.ts", fn: "searchPropertiesWithNaturalLanguage", gate: /requireContactAccess\([\s\S]*searchPropertiesCore\(/, gateLabel: "contact access BEFORE the paid search" },
  { id: "J18", journey: "buyer", arrow: "showings (tenant financial-gate setting)", file: "lib/buyer-execution/showing-financial-policy.ts", fn: "guardShowingFinancialGate", gate: /isFinancialGateRequiredForShowings\([\s\S]*checkBuyerCanPerformAction\(/, gateLabel: "the tenant setting, then the buyer's financial verification (tour)" },
  { id: "J19", journey: "buyer", arrow: "offer (gates bound at the write)", file: "app/actions/buyer-offers.ts", fn: "createOffer", gate: /checkBuyerOfferEligibility\([\s\S]*\.from\("offers"\)/, gateLabel: "lifecycle + financial gate BEFORE the offers insert" },
  { id: "J20", journey: "buyer", arrow: "outside-listing reply → agent confirms (email ≠ acceptance)", file: "app/actions/buyer-offer/outside-offer-loop.ts", fn: "confirmOutsideReply", gate: /requireCaller\(\)[\s\S]*\.eq\("brokerage_id", caller\.brokerageId\)[\s\S]*authorize\(svc, caller/, gateLabel: "the session caller, the tenant-pinned reply, then the chain authority — the agent's act" },
  { id: "J21", journey: "both", arrow: "executed offer → ONE transaction", file: "lib/transactions/transaction-creation-gate.ts", fn: "assertTransactionCreationAllowed", gate: /findUnexecutedDocuments\(|initials/i, gateLabel: "signatures + initials + required docs" },
  { id: "J22", journey: "both", arrow: "closing compliance + CDA-if-required + stage order → VERIFIED closing", file: "lib/transactions/stage-progression.ts", fn: "canAdvanceStage", gate: /resolveCdaMode\([\s\S]*resolveMilestoneIdentity\([\s\S]*canProceedToClosingPrep\(/, gateLabel: "CDA mode, the identity resolver, closing compliance at the close" },
  { id: "J23", journey: "both", arrow: "verified closing write (gated stage machine)", file: "lib/transactions/stage-progression.ts", fn: "advanceStage", gate: /canAdvanceStage\([\s\S]*\.from\("transactions"\)\s*\.update\(stageUpdate\)/, gateLabel: "canAdvanceStage BEFORE the stage write" },
  { id: "J24", journey: "both", arrow: "verified closing → review ask (status, never a scheduled row)", file: "lib/reputation/review-ask.ts", fn: "reviewAskTiming", gate: /VERIFIED_CLOSING_STATUSES\.includes\(/, gateLabel: "closed | funded only" },
  { id: "J25", journey: "both", arrow: "verified closing → lifetime (ONE writer + payout hold)", file: "lib/transactions/stage-progression.ts", fn: "advanceStage", gate: /lifetimeConversionVerdict\([\s\S]*promoteDealContactsToLifetime\([\s\S]*holdLifetimeConversionPendingPayout\(/, gateLabel: "verdict → promote or hold" },
  { id: "J26", journey: "both", arrow: "lifetime → post-close moments (delivered, arbitrated)", file: "lib/sphere/followup-moments.ts", fn: "conductDueFollowUpMomentsAllTenants", gate: /conductDueFollowUpMoments\(svc/, gateLabel: "every tenant through the per-tenant conductor" },
]

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  console.log("══════════════════════════════════════════════════")
  console.log(" Journey promotion gates — seller + buyer (wave 144, lane 144B)")
  console.log("══════════════════════════════════════════════════")

  console.log(`\n── 1. JOURNEY MAP: ${JOURNEY_ARROWS.length} arrows, each writer reaches its gate (stripped source) ──`)
  for (const a of JOURNEY_ARROWS) {
    const body = fnBody(code(a.file), a.fn)
    check(`${a.id} [${a.journey}] ${a.arrow} — ${a.file} ${a.fn}() reaches: ${a.gateLabel}`, existsSync(join(ROOT, a.file)) && body.length > 0 && a.gate.test(body), body ? "gate token absent" : "function not found")
  }
  {
    const fixture = stripComments("export async function promoteFixture(id) {\n  // validatePromotionEligibility( — a comment is not a call site\n  return createContactFromLead(svc, id)\n}\n")
    const body = fnBody(fixture, "promoteFixture")
    check("POSITIVE CONTROL: an arrow whose gate is only named in a COMMENT is flagged (the slice reads stripped source)", body.length > 0 && !JOURNEY_ARROWS[2].gate.test(body))
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 2. THE VERIFIED-CLOSING GATE, driven (canAdvanceStage on the in-memory client) ──")
  const now = new Date().toISOString()
  const today = now.slice(0, 10)
  const B_NOCDA = uuid(), B_CDA = uuid(), B_NULL = uuid(), B_HOLD = uuid()
  const U = uuid(), AG = uuid(), U2 = uuid(), AG2 = uuid()
  const T_NOCDA = uuid(), T_CDA = uuid(), T_CDA_DONE = uuid(), T_CDA_NAMEONLY = uuid(), T_NULL = uuid(), T_CONT = uuid(), T_UC = uuid(), T_NOSTAGE = uuid()
  const O_CONT = uuid()
  const contractDate = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10)
  const tx = (id: string, b: string, stage: string | null, extra: Record<string, unknown> = {}) => ({ id, brokerage_id: b, agent_id: AG, stage, status: "clear_to_close", contract_date: contractDate, compliance_passed_at: now, contact_id: null, offer_id: null, ...extra })
  const svc = canaryClient({
    brokerages: [
      { id: B_NOCDA, name: "J144 no-CDA", offers_cda: false, non_cda_payout_default: "direct_deposit" },
      { id: B_CDA, name: "J144 CDA", offers_cda: true },
      { id: B_NULL, name: "J144 undeclared", offers_cda: null },
      { id: B_HOLD, name: "J144 hold", offers_cda: false },
    ],
    transactions: [
      tx(T_NOCDA, B_NOCDA, "CLOSING_PREP"), tx(T_CDA, B_CDA, "CLOSING_PREP"), tx(T_CDA_DONE, B_CDA, "CLOSING_PREP"), tx(T_CDA_NAMEONLY, B_CDA, "CLOSING_PREP"),
      tx(T_NULL, B_NULL, "CLOSING_PREP"), tx(T_CONT, B_NOCDA, "UNDER_CONTRACT", { offer_id: O_CONT }), tx(T_UC, B_NOCDA, "UNDER_CONTRACT"), tx(T_NOSTAGE, B_NOCDA, null),
    ],
    offers: [{ id: O_CONT, brokerage_id: B_NOCDA, contingencies: ["financing", "inspection", "appraisal"] }],
    transaction_milestones: [
      { id: uuid(), brokerage_id: B_CDA, transaction_id: T_CDA_DONE, milestone_type: "cda_delivered", milestone_name: "Commission Disbursement", status: "completed", completed_at: now, target_date: today },
      { id: uuid(), brokerage_id: B_CDA, transaction_id: T_CDA_NAMEONLY, milestone_type: null, milestone_name: "cda_delivered", status: "completed", completed_at: null, target_date: today },
    ],
  })
  setSvc(svc)
  const { canAdvanceStage, advanceStage } = await import("../lib/transactions/stage-progression")

  const noCda = await canAdvanceStage(T_NOCDA, "CLOSING_PREP", "CLOSED", B_NOCDA)
  check("CDA IF REQUIRED: a NO-CDA brokerage (offers_cda false) closes with no cda_delivered milestone on file", noCda.allowed, noCda.blockers.join("; "))
  const withCda = await canAdvanceStage(T_CDA, "CLOSING_PREP", "CLOSED", B_CDA)
  check("CDA IF REQUIRED: a CDA brokerage (offers_cda true) without the delivered CDA is REFUSED, naming the milestone", !withCda.allowed && withCda.blockers.some((b) => /cda_delivered/.test(b)), withCda.blockers.join("; "))
  const undeclared = await canAdvanceStage(T_NULL, "CLOSING_PREP", "CLOSED", B_NULL)
  check("CDA IF REQUIRED: an UNDECLARED setting (offers_cda null) never manufactures a mandatory CDA (resolveCdaMode: cda_not_declared)", undeclared.allowed, undeclared.blockers.join("; "))
  const done = await canAdvanceStage(T_CDA_DONE, "CLOSING_PREP", "CLOSED", B_CDA)
  const nameOnly = await canAdvanceStage(T_CDA_NAMEONLY, "CLOSING_PREP", "CLOSED", B_CDA)
  check("ONE MILESTONE VOCABULARY: a completed CDA milestone is FOUND through resolveMilestoneIdentity — by canonical milestone_type, and by a canonical milestone_name with status 'completed'", done.allowed && nameOnly.allowed, `${done.blockers.join("; ")} | ${nameOnly.blockers.join("; ")}`)
  {
    const rows = (svc.tables.transaction_milestones ?? []) as Array<Record<string, unknown>>
    check("CONTROL: the retired lookup (`m.name === criticalName`) finds NONE of those rows — transaction_milestones has no `name` column, so the gate could never pass", rows.length === 2 && rows.every((m) => m.name === undefined) && !rows.find((m) => m.name === "cda_delivered"))
  }
  {
    const refusing = canaryClient({ transactions: [tx(T_CDA, B_CDA, "CLOSING_PREP")] }, { refuse: { brokerages: "permission denied for table brokerages" } })
    setSvc(refusing)
    const refused = await canAdvanceStage(T_CDA, "CLOSING_PREP", "CLOSED", B_CDA)
    check("FAIL CLOSED: a REFUSED brokerage read keeps the CDA requirement and says why (never 'nobody checked' as a pass)", !refused.allowed && refused.blockers.some((b) => /CDA requirement could not be read/.test(b)) && refused.blockers.some((b) => /cda_delivered/.test(b)), refused.blockers.join("; "))
    setSvc(svc)
  }
  G.__J144.gateCalls.length = 0
  G.__J144.closingGate = { allowed: false, blockers: ["Compliance failed: closing_terms.purchase_price - the settlement statement disagrees with the executed terms"] }
  const ccBlocked = await canAdvanceStage(T_NOCDA, "CLOSING_PREP", "CLOSED", B_NOCDA)
  check("CLOSING COMPLIANCE AT THE CLOSE: a blocking closing-compliance finding (written during closing prep) refuses CLOSED, by name", !ccBlocked.allowed && ccBlocked.blockers.some((b) => /closing_terms\.purchase_price/.test(b)), ccBlocked.blockers.join("; "))
  check("…and it was the SAME gate (canProceedToClosingPrep) asked, for THIS transaction", G.__J144.gateCalls.some((c) => c.t === T_NOCDA))
  G.__J144.closingGate = { allowed: true, blockers: [] }
  const intoPrep = G.__J144.gateCalls.length
  await canAdvanceStage(T_UC, "UNDER_CONTRACT", "INSPECTION", B_NOCDA)
  check("CONTROL: an ordinary advance (UNDER_CONTRACT → INSPECTION) does not consult the closing-compliance gate", G.__J144.gateCalls.length === intoPrep)

  const cont = await canAdvanceStage(T_CONT, "UNDER_CONTRACT", "INSPECTION", B_NOCDA)
  check("CONTINGENCY TYPES NO LONGER FREEZE A DEAL: an offer carrying [financing, inspection, appraisal] (the createOffer shape) advances to INSPECTION", cont.allowed && !cont.blockers.some((b) => /initialed/.test(b)), cont.blockers.join("; "))
  {
    const retired = (cs: string[]) => cs.filter((c) => c && !c.toLowerCase().includes("initialed"))
    check("CONTROL: the retired 'initialed' predicate refuses that exact shape — every contingency TYPE lacks the word", retired(["financing", "inspection", "appraisal"]).length === 3)
    const tomb = raw("lib/transactions/stage-progression.ts")
    check("the retirement is TOMBSTONED naming its survivor (transaction-creation-gate.ts initials obligation), and the survivor file exists", /TOMBSTONE \(wave 144, lane 144B\): "Contingencies not initialed"/.test(tomb) && /SURVIVOR: lib\/transactions\/transaction-creation-gate\.ts/.test(tomb) && existsSync(join(ROOT, "lib/transactions/transaction-creation-gate.ts")))
  }
  const skip = await canAdvanceStage(T_UC, "UNDER_CONTRACT", "CLOSED", B_NOCDA)
  check("STAGE ORDER: UNDER_CONTRACT → CLOSED is refused (a verified closing comes from CLOSING_PREP)", !skip.allowed && /Not an allowed transition/.test(skip.blockers.join(" ")))
  let nullStage: { allowed: boolean; blockers: string[] } = { allowed: true, blockers: [] }
  try { nullStage = await canAdvanceStage(T_NOSTAGE, null as never, "CLOSED", B_NOCDA) } catch (e) { nullStage = { allowed: true, blockers: [`THREW ${(e as Error).message}`] } }
  check("a transaction with NO stage is refused by name, not a TypeError out of the gate", !nullStage.allowed && /Not an allowed transition/.test(nullStage.blockers.join(" ")), nullStage.blockers.join("; "))
  const wrongTenant = await canAdvanceStage(T_NOCDA, "CLOSING_PREP", "CLOSED", B_CDA)
  check("TENANT: another brokerage asking about this transaction reads 'Transaction not found'", !wrongTenant.allowed && wrongTenant.blockers.includes("Transaction not found"))

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 3. THE CLOSE THROUGH THE GATED STAGE MACHINE (advanceStage → CLOSED) ──")
  const BUYER = uuid(), SELLER = uuid(), L = uuid(), T_CLOSE = uuid(), T_TWIN = uuid()
  const BUYER_H = uuid(), SELLER_H = uuid(), T_HOLD = uuid()
  const scheduled = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10)
  const contact = (id: string, b: string, agent: string, type: string, first: string) => ({ id, brokerage_id: b, agent_id: agent, contact_type: type, lifecycle_state: type, first_name: first, last_name: "Journey", email: `${first.toLowerCase()}@j144.test` })
  ;(svc.tables.users ??= []).push({ id: U, email: "agent@j144.test", user_type: "agent", brokerage_id: B_NOCDA }, { id: U2, email: "agent2@j144.test", user_type: "agent", brokerage_id: B_HOLD })
  ;(svc.tables.agents ??= []).push({ id: AG, user_id: U, brokerage_id: B_NOCDA, is_active: true }, { id: AG2, user_id: U2, brokerage_id: B_HOLD, is_active: true })
  ;(svc.tables.contacts ??= []).push(contact(BUYER, B_NOCDA, AG, "buyer", "Blair"), contact(SELLER, B_NOCDA, AG, "seller", "Sloane"), contact(BUYER_H, B_HOLD, AG2, "buyer", "Hana"), contact(SELLER_H, B_HOLD, AG2, "seller", "Hal"))
  ;(svc.tables.listings ??= []).push({ id: L, brokerage_id: B_NOCDA, agent_id: AG, status: "pending", lifecycle_stage: "UNDER_CONTRACT", address: "1 Journey Way" })
  ;(svc.tables.transactions ??= []).push(
    tx(T_CLOSE, B_NOCDA, "CLOSING_PREP", { buyer_contact_id: BUYER, seller_contact_id: SELLER, contact_id: BUYER, listing_id: L, deal_type: "dual", close_date: scheduled }),
    { ...tx(T_TWIN, B_NOCDA, "CLOSED", { buyer_contact_id: BUYER, contact_id: BUYER, deal_type: "buyer", close_date: scheduled }), status: "closed" },
    { ...tx(T_HOLD, B_HOLD, "CLOSING_PREP", { buyer_contact_id: BUYER_H, seller_contact_id: SELLER_H, contact_id: BUYER_H, deal_type: "dual", close_date: scheduled }), agent_id: AG2 },
  )
  ;(svc.tables.brokerage_settings ??= []).push({ id: uuid(), brokerage_id: B_HOLD, settings: { lifetime_conversion: { require_payout_verified: true } } })

  const closed = await advanceStage({ transactionId: T_CLOSE, targetStage: "CLOSED", brokerageId: B_NOCDA, userId: U, reason: "journey proof close" })
  const row = (svc.tables.transactions ?? []).find((t) => t.id === T_CLOSE) as Record<string, unknown> | undefined
  check("THE GATED CLOSE LANDS: status closed, stage CLOSED", closed.success && row?.status === "closed" && row?.stage === "CLOSED", closed.error ?? "")
  check(`THE VERIFIED DATE: close_date is the day it closed (${today}), no longer the contract's scheduled ${scheduled}`, row?.close_date === today, String(row?.close_date))
  const events = (svc.tables.lifecycle_events ?? []).filter((e) => e.entity_id === T_CLOSE).map((e) => String(e.event_type))
  check("THE CLOSE IS AN EVENT: TRANSACTION_CLOSED and DEAL_CLOSED rows land for this transaction (the post-close sequences, portal, notifications and journey resume read them)", events.includes("transaction_closed") && events.includes("deal_closed"), events.join(","))
  const contacts = () => (svc.tables.contacts ?? []) as Array<Record<string, unknown>>
  const b = contacts().find((c) => c.id === BUYER), s = contacts().find((c) => c.id === SELLER)
  check("BOTH PARTIES → LIFETIME through the ONE writer: the BUYER (never converted on this path before) and the SELLER read lifetime_customer on contact_type AND lifecycle_state", b?.contact_type === "lifetime_customer" && b?.lifecycle_state === "lifetime_customer" && s?.contact_type === "lifetime_customer" && s?.lifecycle_state === "lifetime_customer", `${String(b?.contact_type)}/${String(s?.contact_type)}`)
  const tps = () => (svc.tables.lifetime_customer_touchpoints ?? []).filter((t) => t.related_transaction_id === T_CLOSE)
  const tpCount = tps().length
  check("THE POST-CLOSE SCHEDULE STARTS once per transaction, for both parties, attributed to the DEAL's agent (agents.id), anchored on the verified date", tpCount > 0 && new Set(tps().map((t) => t.contact_id)).size === 2 && tps().every((t) => t.agent_id === AG && String(t.scheduled_date) >= today), `${tpCount} rows`)
  check("the seller's lifetime audience + newsletter hooks ran (consent-gated in their own modules); the listing reads sold", G.__J144.audience.includes(SELLER) && G.__J144.newsletter.includes(SELLER) && (svc.tables.listings ?? []).find((l) => l.id === L)?.status === "sold")
  check("UNCHANGED: the FINAL commission calculation still runs at the close (close freezes the amount; it never pays)", G.__J144.calc.some((c) => c.transactionId === T_CLOSE && c.calculationMode === "final"))
  const again = await advanceStage({ transactionId: T_CLOSE, targetStage: "CLOSED", brokerageId: B_NOCDA, userId: U })
  check("RE-RUN: a second close is refused (CLOSED is terminal) and NOTHING is converted or scheduled twice", !again.success && tps().length === tpCount, again.error ?? "")

  const held = await advanceStage({ transactionId: T_HOLD, targetStage: "CLOSED", brokerageId: B_HOLD, userId: U2 })
  const hb = contacts().find((c) => c.id === BUYER_H), hs = contacts().find((c) => c.id === SELLER_H)
  const holds = (svc.tables.activities ?? []).filter((a) => a.transaction_id === T_HOLD && a.activity_type === "lifetime_conversion_pending_payout")
  check("CLOSED / PAYOUT PENDING: a tenant whose policy holds conversion until the payout closes the deal but converts NOBODY, opens ONE visible hold, schedules nothing (the stage machine used to convert the seller anyway)", held.success && hb?.contact_type === "buyer" && hs?.contact_type === "seller" && holds.length === 1 && (svc.tables.lifetime_customer_touchpoints ?? []).filter((t) => t.related_transaction_id === T_HOLD).length === 0 && !G.__J144.audience.includes(SELLER_H), `holds=${holds.length}`)
  {
    const { releaseLifetimeConversionOnPayout } = await import("../lib/kernel/lifetime-conversion")
    const rel = await releaseLifetimeConversionOnPayout(svc as never, { brokerageId: B_HOLD, transactionId: T_HOLD, actorUserId: U2 })
    const hb2 = contacts().find((c) => c.id === BUYER_H)
    check("…and the PAYOUT releases it through the same writer (both parties convert, the hold completes)", rel.released && hb2?.contact_type === "lifetime_customer" && holds[0]?.status === "completed", rel.reason)
  }

  {
    const engine = await import("../lib/reputation/review-ask")
    const { REVIEW_REQUEST_DEFAULT_DELAY_DAYS } = await import("../lib/reputation/review-request-delay")
    const deps = { draft: async () => ({ success: false, error: "proof: no draft" }), dispatchEmail: async () => ({ success: false }), dispatchSms: async () => ({ success: false }), emit: async () => ({}), notifyAgent: async () => {}, notifyBrokerageAdmins: async () => 0 }
    const dayOf = await engine.askForReviewAtClose(svc as never, { brokerageId: B_NOCDA, transactionId: T_CLOSE }, { ...deps, now: () => new Date() })
    const afterDelay = await engine.askForReviewAtClose(svc as never, { brokerageId: B_NOCDA, transactionId: T_CLOSE }, { ...deps, now: () => new Date(Date.now() + (REVIEW_REQUEST_DEFAULT_DELAY_DAYS + 1) * 86_400_000) })
    const dayOfReason = (dayOf.results[0] as { reason?: string }).reason
    const laterReason = (afterDelay.results[0] as { reason?: string }).reason
    check("REVIEW AT THE VERIFIED CLOSING: on the closing day the ask is `not_due` (the tenant's delay counts from the verified date); once the delay passes it is DUE (here it stops at no_review_link — nothing configured, nothing sent)", dayOfReason === "not_due" && laterReason !== "not_due" && laterReason !== "aged_out" && laterReason !== "not_closed", `${dayOfReason} → ${laterReason}`)
    const twin = await engine.askForReviewAtClose(svc as never, { brokerageId: B_NOCDA, transactionId: T_TWIN }, { ...deps, now: () => new Date() })
    const twinReason = (twin.results[0] as { reason?: string }).reason
    check("CONTROL: the SAME engine on a closed twin still carrying the contract's scheduled date reads it differently on the same day (aged out / already due) — the date the close writes is what times the ask", twinReason !== "not_due", String(twinReason ?? twin.results[0]?.status))
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 4. CENSUS: every closed-transaction writer and every listing-stage door reaches its gate ──")
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${e}`
      if (e === "node_modules" || e.startsWith(".")) continue
      const st = statSync(join(ROOT, rel))
      if (st.isDirectory()) walk(rel, out)
      else if (/\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(rel)
    }
    return out
  }
  const CLOSE_WRITE = /\.from\(\s*["']transactions["']\s*\)\s*\.update\(\s*(\{[\s\S]{0,400}?\}|\w+)\s*\)/g
  const closesInPayload = (payload: string, src: string): boolean => {
    if (/status:\s*["']closed["']|stage:\s*["']CLOSED["']/.test(payload)) return true
    if (/^\w+$/.test(payload)) { const decl = new RegExp(`const\\s+${payload}\\s*=\\s*\\{([\\s\\S]{0,500}?)\\n\\s*\\}`).exec(src); return !!decl && /STAGE_TO_STATUS_MAP\[|status:\s*mappedStatus|status:\s*["']closed["']/.test(decl[1]) }
    return /STAGE_TO_STATUS_MAP\[|status:\s*mappedStatus/.test(payload)
  }
  type Writer = { file: string; fn: string; verdict: "gated" | "override" | "ungated" }
  const enclosingFn = (src: string, idx: number): string => { const head = src.slice(0, idx); const all = [...head.matchAll(/(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/g)]; return all.length ? all[all.length - 1][1] : "(top level)" }
  const classify = (body: string, writeIdx: number): Writer["verdict"] => {
    const before = body.slice(0, writeIdx)
    if (/canAdvanceStage\(/.test(before)) return "gated"
    if (/requireOverrideActor\(/.test(before) && /overrideReason/.test(before)) return "override"
    return "ungated"
  }
  const censusOf = (files: string[], read: (f: string) => string): Writer[] => {
    const out: Writer[] = []
    for (const f of files) {
      const src = read(f)
      for (const m of src.matchAll(CLOSE_WRITE)) {
        if (!closesInPayload(m[1], src)) continue
        const fn = enclosingFn(src, m.index ?? 0)
        const body = fnBody(src, fn)
        const at = body.indexOf(m[0])
        out.push({ file: f, fn, verdict: classify(body, at < 0 ? body.length : at) })
      }
    }
    return out
  }
  const files = [...walk("lib"), ...walk("app")]
  const writers = censusOf(files, code)
  console.log(`    closed-transaction writers found: ${writers.length} (${files.length} files scanned) — ${writers.map((w) => `${w.file}:${w.fn}=${w.verdict}`).join(", ")}`)
  check("the census sees the gated stage machine (stage-progression advanceStage = gated)", writers.some((w) => w.file === "lib/transactions/stage-progression.ts" && w.fn === "advanceStage" && w.verdict === "gated"))
  check("…and the authorized override (transaction-stage-machine advanceTransactionStage = override: role + reason + audit event)", writers.some((w) => w.file === "app/actions/transaction-stage-machine.ts" && w.verdict === "override"))
  {
    const fixture = 'export async function closeFixture(id) {\n  await svc.from("transactions").update({ status: "closed", stage: "CLOSED" }).eq("id", id)\n}\n'
    const fx = censusOf(["fixture.ts"], () => fixture)
    check("POSITIVE CONTROL: an ungated fixture close is found AND classified ungated", fx.length === 1 && fx[0].verdict === "ungated")
  }
  const kernelClose = writers.find((w) => w.file === "lib/kernel/transactions.ts" && w.fn === "closeTransactionCommand")
  outsideLane("closeTransactionCommand (the 'Close Transaction' button's door) is GATED by canAdvanceStage before it writes status closed — today any stage closes with no closing compliance, CDA or TRID check, and the review ask, lifetime conversion and commission finalization follow an UNVERIFIED close",
    !!kernelClose && kernelClose.verdict === "gated", "lane 144I (lib/kernel/transactions.ts non-money parts)", kernelClose ? `classified ${kernelClose.verdict}` : "writer not found")
  const others = writers.filter((w) => w.verdict === "ungated" && !(w.file === "lib/kernel/transactions.ts" && w.fn === "closeTransactionCommand"))
  check("NO OTHER ungated closed-transaction writer exists in app/ + lib/", others.length === 0, others.map((w) => `${w.file}:${w.fn}`).join(", "))

  // Listing-stage doors: every export of the seller execution engine that moves the listing stage machine to a
  // stage reaches that stage's gate (requireListingStage / requireCurrentListingStage) or the activation gate.
  const ENGINE = "app/actions/seller-listing/execution-engine.ts"
  const engine = code(ENGINE)
  type Door = { fn: string; to: string; gated: boolean }
  const doorsOf = (src: string): Door[] => {
    const out: Door[] = []
    for (const m of src.matchAll(/\nexport\s+async\s+function\s+(\w+)\s*\(/g)) {
      const body = fnBody(src, m[1])
      const t = /transitionLifecycle\(\{[\s\S]{0,300}?entityType:\s*"listing_stage_machine"[\s\S]{0,200}?toState:\s*"([A-Z_]+)"/.exec(body)
      if (!t) continue
      const before = body.slice(0, t.index)
      out.push({ fn: m[1], to: t[1], gated: /requireListingStage\(|requireCurrentListingStage\(|assertListingActivationAllowed\(|runListingComplianceLoop\(|readinessFor|requireStage/.test(before) })
    }
    return out
  }
  const doors = doorsOf(engine)
  console.log(`    listing-stage doors in ${ENGINE}: ${doors.length} — ${doors.map((d) => `${d.fn}→${d.to}${d.gated ? "" : " (UNGATED)"}`).join(", ")}`)
  check("the door census sees the coming-soon PREP door gated (prepareComingSoonAssets → COMING_SOON_PREP)", doors.some((d) => d.fn === "prepareComingSoonAssets" && d.gated))
  {
    const fx = doorsOf('\nexport async function goFixture(id) {\n  await transitionLifecycle({ entityType: "listing_stage_machine", entityId: id, fromState: "A", toState: "COMING_SOON_ACTIVE" })\n}\n')
    check("POSITIVE CONTROL: a door that moves the stage with no gate before it is classified UNGATED", fx.length === 1 && !fx[0].gated)
  }
  const comingSoon = doors.find((d) => d.fn === "activateComingSoon")
  outsideLane("activateComingSoon (COMING_SOON_PREP → COMING_SOON_ACTIVE — the PUBLIC coming-soon announcement) checks the listing really is in a stage COMING_SOON_ACTIVE may be entered from; transitionLifecycle never verifies fromState, so today a listing whose agreement never passed compliance can be announced",
    !!comingSoon && comingSoon.gated, "integrator (app/actions/seller-listing/** is in no wave-144 lane's domain)", comingSoon ? "no requireListingStage before the transition" : "door not found")
  const otherUngated = doors.filter((d) => !d.gated && d.fn !== "activateComingSoon")
  console.log(`    other listing-stage doors without a stage gate before the transition (reported, not judged here — their stages are not promotions this lane certifies): ${otherUngated.map((d) => `${d.fn}→${d.to}`).join(", ") || "none"}`)

  report()
}

function report(): void {
  console.log("\n──────────────────────────────────────────────────")
  if (pending.length) { console.log(` PENDING (outside lane, not counted as pass): ${pending.length}`); for (const p of pending) console.log(`   ◌ ${p}`) }
  console.log(` RESULT: ${passed} passed, ${failed} failed, ${pending.length} pending outside lane`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" JOURNEY_PROMOTION_GATES_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
