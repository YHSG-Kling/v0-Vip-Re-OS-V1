#!/usr/bin/env tsx
/**
 * scripts/listing-coming-soon-live-date-guard.ts  (npm run test:listing-coming-soon-live-date) — in-memory, no DB, no network.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WAVE 145, LANE 145B — owner rulings 1 + 2 (2026-10-27), cross-lane contract C7.
 *   1 "You can advertise a coming soon only if you don't disclose the street address, unless otherwise."
 *   2 "The listing agreement would have the date the seller wants to go live on the MLS so check the listing agreement."
 *
 *   A  THE ADDRESS DECISION (pure, lib/compliance/coming-soon-policy.ts comingSoonStreetAddressDecision): withheld by
 *      default; disclosed ONLY with the seller's authorization AND an attested rule permitting it — every other
 *      combination withholds, by name. Old stored policy entries read the new field as null (closed). POSITIVE CONTROL:
 *      the one disclosing combination discloses.
 *   B  THE CREATIVE SCRUBBER (pure, lib/marketing/listing-public-address.ts): finds THIS listing's street address in its
 *      common spellings, never a street name alone / another house number / another street (controls), redacts to
 *      "City, ST", refuses in refuse mode, passes untouched when disclosure is allowed.
 *   C  THE DOOR RESOLVER on the in-memory client: the attested rule + the executed agreement disclose; a refused policy
 *      read or a refused agreement read WITHHOLD (fail closed) and say why.
 *   D  THE AGREEMENT'S GOVERNING TERMS (lib/listings/listing-agreement-terms.ts): the m797 precedence over the listing
 *      vocabulary (latest executed wins, originals preserved as conflicts, a strike governs), the ONE reader (no agreement /
 *      unsigned / executed / amended / refused / pre-m856), the amendment writer's refusals (vocabulary, malformed,
 *      future day, foreign document, another listing's document, missing signatures) and its version numbering, and the
 *      original-terms writer's write-once behaviour.
 *   E  THE PLANNED-DATE WRITER OBEYS THE AGREEMENT (lib/listings/mls-live-date.ts recordPlannedMlsLiveDate): a different
 *      date or a clear is refused naming the amendment path; the agreed date is admitted; with no agreement the legacy
 *      behaviour holds (control); an unreadable agreement refuses (fail closed).
 *   F  A DATE CHANGE REACHES ITS SURVIVORS (followSellerAgreedMlsLiveDate): planned date, evidence event, open-house
 *      schedule (only before open-house marketing — control), the agent's bell, the compliance loop at
 *      LISTING_AGREEMENT_SIGNED; it never writes a verified column. The ONE open-house rule equals the retired one.
 *   G  SOURCE (stripped — a tombstone is not a call site): the three doors in this lane call the rule; the census of the
 *      OTHER public Coming Soon creative doors is published PENDING with its owner until each calls the door function.
 *
 * BLIND SPOTS (published): RLS and the m856 trigger / CHECK are not executed (the trigger's write-once rule is modelled by
 * the writer's `.is(col, null)` predicate and proven by its SQL text); the server door
 * (app/actions/seller-listing/listing-agreement-amendment.ts) is session-bound and is proven by source here (lane J drives
 * it); the scrubber cannot see a street number written in words, an address inside an image / video frame / QR target,
 * or a street name without its number; the creative-door census is a hand-kept list of the doors found by the audit
 * (grep for coming-soon tokens + an address interpolation) — a new door is not discovered automatically.
 *
 * Run: NODE_OPTIONS=--max-old-space-size=6000 npx tsx --conditions=react-server scripts/listing-coming-soon-live-date-guard.ts
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { stubModule } from "./canaries/_harness"

const ROOT = process.cwd()
let passed = 0, failed = 0
const failures: string[] = []
const pending: string[] = []
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function outsideLane(name: string, landed: boolean, owner: string, detail = ""): void {
  if (landed) { passed++; console.log(`  ✓ ${name} (landed)`) }
  else { pending.push(`${name} — owner ${owner}${detail ? ` — ${detail}` : ""}`); console.log(`  ◌ PENDING (outside lane, ${owner}): ${name}${detail ? ` — ${detail}` : ""}`) }
}
const raw = (rel: string): string => { try { return readFileSync(join(ROOT, rel), "utf8") } catch { return "" } }
const code = (rel: string): string => stripComments(raw(rel))
function fnBody(src: string, name: string): string {
  const m = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]`).exec(src)
  if (!m) return ""
  const rest = src.slice(m.index + m[0].length)
  const next = /\n(?:export\s+(?:async\s+)?function|async\s+function|function)\s+\w+\s*[(<]/.exec(rest)
  return src.slice(m.index, m.index + m[0].length + (next ? next.index : rest.length))
}

// ── recorder stubs (installed BEFORE the graph that reaches them is imported) ───────────────────────────────────────
const G = globalThis as unknown as { __145B: { events: any[]; loops: any[] } }
G.__145B = { events: [], loops: [] }
stubModule("@/lib/events/lifecycle-event-core", "export const recordLifecycleEvent = async (svc, brokerageId, input, opts) => { const g = globalThis.__145B; if (input.dedupe_key && g.events.find((e) => e.brokerageId === brokerageId && e.input.dedupe_key === input.dedupe_key)) return { ok: true, deduped: true }; g.events.push({ brokerageId, input, opts }); return { ok: true, event: { id: 'evt-' + g.events.length }, deduped: false } }")
stubModule("@/lib/listings/listing-compliance-loop", "export const runListingComplianceLoop = async (svc, input) => { globalThis.__145B.loops.push(input); return { outcome: 'passed_awaiting_date' } }")

const B = "b1450000-0000-4000-8000-00000000000b", B2 = "b1450000-0000-4000-8000-0000000000b2"
const L = "11450000-0000-4000-8000-00000000000l", L2 = "11450000-0000-4000-8000-0000000000l2"
const AG = "a1450000-0000-4000-8000-00000000000a", U = "u1450000-0000-4000-8000-00000000000u"
const LA = "1a450000-0000-4000-8000-0000000000aa"
const DOC = "d1450000-0000-4000-8000-00000000000d", DOC_UNSIGNED = "d1450000-0000-4000-8000-0000000000d2", DOC_FOREIGN = "d1450000-0000-4000-8000-0000000000d3", DOC_OTHER_LISTING = "d1450000-0000-4000-8000-0000000000d4"
const signed = (roles: string[]) => ({ signatures: roles.map((r) => ({ signer_role: r, signed: true })) })
const RULE = (o: Record<string, unknown> = {}) => ({
  mls_slug: "example_coast_mls", mls_name: "Example Coast MLS", state_codes: ["FL"], permitted: true, max_days: 21, showings_permitted: false,
  mls_submission_within_business_days: 1, source: { url: "https://rules.example-coast-mls.test/coming-soon", rule_ref: "Sec. 1.3", title: null, verified_on: "2026-10-27" },
  attestation: { user_id: U, user_type: "compliance_officer", at: "2026-10-27T00:00:00Z" }, updated_at: "2026-10-27T00:00:00Z", ...o,
})

async function main() {
  const csp = await import("../lib/compliance/coming-soon-policy")
  const lpa = await import("../lib/marketing/listing-public-address")
  const lat = await import("../lib/listings/listing-agreement-terms")
  const mld = await import("../lib/listings/mls-live-date")
  const policyOf = async (entry: Record<string, unknown> | null) => {
    const r = await csp.loadComingSoonPolicy(memSupabase({ brokerage_settings: [{ id: "s", brokerage_id: B, settings: entry ? { coming_soon_policy: { mls: { example_coast_mls: entry } } } : {} }] }) as any, B)
    if (!r.ok) throw new Error(r.error)
    return r.policy
  }

  console.log("\n── A  the Coming Soon street-address decision (pure) ──")
  const permits = await policyOf(RULE({ street_address_disclosure_permitted: true }))
  const silent = await policyOf(RULE())
  const forbids = await policyOf(RULE({ street_address_disclosure_permitted: false }))
  const unattested = await policyOf(RULE({ street_address_disclosure_permitted: true, attestation: null }))
  const noComingSoon = await policyOf(RULE({ street_address_disclosure_permitted: true, permitted: false }))
  const garbage = await policyOf(RULE({ street_address_disclosure_permitted: "sometimes" }))
  const at = { stateCode: "FL" }
  const d = (p: any, s: any) => csp.comingSoonStreetAddressDecision(p, at, s)
  check("DEFAULT WITHHELD: no policy on file + no seller authorization → not disclosed, both reasons named", !d(null, "not_recorded").disclose && d(null, "not_recorded").withheldBecause.length === 2)
  check("POSITIVE CONTROL — the ONE disclosing combination: seller authorized + an ATTESTED rule that permits Coming Soon AND the street address → disclosed, citing the rule",
    d(permits, "authorized").disclose && d(permits, "authorized").withheldBecause.length === 0 && d(permits, "authorized").policySource?.rule_ref === "Sec. 1.3")
  check("seller authorized but the rule is SILENT on the address (an entry recorded before wave 145) → withheld, naming the report path", !d(silent, "authorized").disclose && /does not say/.test(d(silent, "authorized").withheldBecause.join(" ")))
  check("seller authorized but the rule FORBIDS it → withheld", !d(forbids, "authorized").disclose && /may not appear/.test(d(forbids, "authorized").withheldBecause.join(" ")))
  check("the rule permits it but the seller DECLINED / did NOT record it / the agreement was UNREADABLE → withheld each time (an agent's say-so is not the seller's)",
    (["declined", "not_recorded", "unreadable"] as const).every((s) => !d(permits, s).disclose && d(permits, s).withheldBecause.length === 1))
  check("an UNATTESTED rule that permits it → withheld (a rule is in force only once a compliance approver attests it)", !d(unattested, "authorized").disclose)
  check("a rule that does not permit Coming Soon at all → withheld even when it 'permits' the address", !d(noComingSoon, "authorized").disclose && /does not permit a coming-soon status/.test(d(noComingSoon, "authorized").withheldBecause.join(" ")))
  check("an old stored entry parses with street_address_disclosure_permitted null (backward compatible); a non-yes/no value REJECTS the entry by name (never read as permission)",
    silent.entries.example_coast_mls?.street_address_disclosure_permitted === null && !garbage.entries.example_coast_mls && /street_address_disclosure_permitted/.test(garbage.rejected.map((r) => r.why).join(" ")))
  const base = { mlsName: "Example Coast MLS", stateCodes: ["FL"], permitted: true, maxDays: 21, showingsPermitted: false, mlsSubmissionWithinBusinessDays: 1, sourceUrl: "https://rules.example-coast-mls.test/x", ruleRef: "Sec. 1.3" }
  const rUnstated = csp.validateComingSoonPolicyReport(base, "2026-10-27T00:00:00Z")
  const rYes = csp.validateComingSoonPolicyReport({ ...base, streetAddressDisclosurePermitted: true }, "2026-10-27T00:00:00Z")
  const rBad = csp.validateComingSoonPolicyReport({ ...base, streetAddressDisclosurePermitted: "yes" as any }, "2026-10-27T00:00:00Z")
  check("the policy REPORT: the address rule unstated → null (closed), stated → carried, malformed → refused by name",
    rUnstated.ok && rUnstated.entry.street_address_disclosure_permitted === null && rYes.ok && rYes.entry.street_address_disclosure_permitted === true && !rBad.ok && /street address/.test((rBad as any).errors.join(" ")))
  check("readiness is UNCHANGED by the address field (withholding the address does not exempt the MLS's other obligations)",
    csp.evaluateComingSoonReadiness(permits, { stateCode: "FL", showingsScheduled: 1 }).ready === false && csp.evaluateComingSoonReadiness(permits, { stateCode: "FL" }).ready === true)

  console.log("\n── B  the creative scrubber (through the exported door functions) ──")
  const lst = { address: "123 N Main St, Apt 4", city: "Tampa", state: "fl", zip: "33601" }
  const withheld = { decision: d(null, "not_recorded"), addressLine: "Tampa, FL", publicLocation: "Tampa, FL" }
  const allowed = { decision: d(permits, "authorized"), addressLine: "123 N Main St, Apt 4, Tampa, fl", publicLocation: "Tampa, FL" }
  const finds = (t: string, l: typeof lst | { address: string; city: string; state: string } = lst) => lpa.guardComingSoonCreativeText(t, l, { ...withheld, publicLocation: "PUBLIC" }, "redact").redactions
  const emptyDb = memSupabase({ brokerage_settings: [], listing_agreements: [] })
  const loc = async (p: { address: string | null; city: string | null; state: string | null }) =>
    (await lpa.resolveComingSoonCreativeAddress({ policyClient: emptyDb as any, termsClient: emptyDb as any, listing: { id: L, brokerage_id: B, ...p } })).publicLocation
  check("the public location is 'City, ST' (never the ZIP or the street); state only / nothing degrade honestly",
    (await loc(lst)) === "Tampa, FL" && (await loc({ address: "1 X St", city: null, state: "TX" })) === "TX" && (await loc({ address: null, city: null, state: null })) === "this area")
  check("FOUND in its common spellings: '123 N Main St', '123 Main Street', '123 main st.', '123 N. Main St, Apt 4', 'at 123 MAIN!'",
    ["Coming soon: 123 N Main St!", "Tour 123 Main Street soon", "see 123 main st. next week", "123 N. Main St, Apt 4 is coming", "at 123 MAIN!"].every((t) => finds(t) === 1))
  check("NOT found (controls): the street name alone, another house number, another street, a price that starts with the number",
    finds("Coming soon on Main Street in Tampa") === 0 && finds("1234 Main St") === 0 && finds("123 Oak Ave") === 0 && finds("$123,000 Main event") === 0 && finds("4123 Main St") === 0)
  const multi = { address: "45 Old Mill Road", city: "Austin", state: "TX" }
  check("a multi-word street: '45 Old Mill Rd' and '45 Old Mill Road' are found; '45 Old Town Rd' is not",
    finds("45 Old Mill Rd", multi) === 1 && finds("Visit 45 Old Mill Road.", multi) === 1 && finds("45 Old Town Rd", multi) === 0)
  const red = lpa.guardComingSoonCreativeText("Coming soon at 123 N Main St, Apt 4 — and 123 Main Street again", lst, withheld, "redact")
  check("redact: every occurrence becomes the public location, the rest of the copy is kept", red.redactions === 2 && red.text === "Coming soon at Tampa, FL — and Tampa, FL again", red.text)
  const gRefuse = lpa.guardComingSoonCreativeText("Coming soon: 123 Main St", lst, withheld, "refuse")
  const gRedact = lpa.guardComingSoonCreativeText("Coming soon: 123 Main St", lst, withheld, "redact")
  const gAllowed = lpa.guardComingSoonCreativeText("Coming soon: 123 Main St", lst, allowed, "refuse")
  const gClean = lpa.guardComingSoonCreativeText("Coming soon in Tampa", lst, withheld, "refuse")
  check("refuse mode: a person's copy naming the street is REFUSED, unchanged, with the public location to use", !gRefuse.ok && gRefuse.text === "Coming soon: 123 Main St" && /Tampa, FL/.test(gRefuse.findings[0]))
  check("redact mode: AI copy is scrubbed and the removal is reported", gRedact.ok && gRedact.text === "Coming soon: Tampa, FL" && gRedact.redactions === 1)
  check("POSITIVE CONTROL: when disclosure is allowed the same copy passes untouched; clean copy passes in either mode", gAllowed.ok && gAllowed.text === "Coming soon: 123 Main St" && gClean.ok)

  console.log("\n── C  the door resolver (in-memory client) ──")
  const lrow = { id: L, brokerage_id: B, address: "123 N Main St", city: "Tampa", state: "FL", zip: "33601" }
  const agreementRow = (o: Record<string, unknown> = {}) => ({ id: LA, listing_id: L, brokerage_id: B, esign_status: "fully_signed", seller_signed_at: "2026-10-20T10:00:00Z", agent_signed_at: "2026-10-20T10:00:00Z", fully_executed_at: null, created_at: "2026-10-20T10:00:00Z", seller_requested_mls_live_date: "2026-11-04", coming_soon_street_address_authorized: true, ...o })
  const seedC = (o: Record<string, unknown> = {}, opts: any = {}) => memSupabase({
    brokerage_settings: [{ id: "s", brokerage_id: B, settings: { coming_soon_policy: { mls: { example_coast_mls: RULE({ street_address_disclosure_permitted: true }) } } } }],
    listing_agreements: [agreementRow(o)], contract_term_versions: [],
  }, opts)
  const cOk = await lpa.resolveComingSoonCreativeAddress({ policyClient: seedC() as any, termsClient: seedC() as any, listing: lrow })
  check("attested rule + the EXECUTED agreement's authorization → the full address line", cOk.decision.disclose && cOk.addressLine === "123 N Main St, Tampa, FL", JSON.stringify(cOk))
  const cRefPolicy = await lpa.resolveComingSoonCreativeAddress({ policyClient: seedC({}, { refuse: { brokerage_settings: "permission denied for table brokerage_settings" } }) as any, termsClient: seedC() as any, listing: lrow })
  const cRefTerms = await lpa.resolveComingSoonCreativeAddress({ policyClient: seedC() as any, termsClient: seedC({}, { refuse: { listing_agreements: "permission denied for table listing_agreements" } }) as any, listing: lrow })
  const cUnsigned = await lpa.resolveComingSoonCreativeAddress({ policyClient: seedC() as any, termsClient: seedC({ esign_status: "sent" }) as any, listing: lrow })
  check("FAIL CLOSED: a refused policy read → withheld, the refusal named; a refused agreement read → 'unreadable', withheld; an UNSIGNED agreement authorizes nothing",
    !cRefPolicy.decision.disclose && /permission denied/.test(cRefPolicy.decision.withheldBecause.join(" ")) && cRefPolicy.addressLine === "Tampa, FL"
    && !cRefTerms.decision.disclose && cRefTerms.decision.sellerAuthorization === "unreadable" && !cUnsigned.decision.disclose && cUnsigned.decision.sellerAuthorization === "not_recorded")

  console.log("\n── D  the listing agreement's governing terms ──")
  // THE PRECEDENCE RULE, driven through the ONE reader on seeded rows (the original agreement row + executed amendments).
  const ctv = (o: Record<string, unknown>) => ({ id: `ctv-${Math.random()}`, brokerage_id: B, listing_agreement_id: LA, root_offer_id: null, transaction_id: null, offer_id: null, document_id: DOC, source: "amendment", status: "executed", evidence: {}, ...o })
  const govOf = async (agreement: Record<string, unknown>, amendments: Array<Record<string, unknown>>) =>
    lat.governingListingAgreementTerms(memSupabase({ listing_agreements: [agreementRow(agreement)], contract_term_versions: amendments.map(ctv) }) as any, { brokerageId: B, listingId: L })
  const pr = await govOf({ seller_requested_mls_live_date: "2026-11-04", coming_soon_street_address_authorized: false }, [
    { version_no: 1, executed_at: "2026-10-25T23:59:59.999Z", terms: { seller_requested_mls_live_date: "2026-11-11" } },
    { version_no: 9, status: "proposed", executed_at: null, terms: { seller_requested_mls_live_date: "2027-01-01" } },
    { version_no: 2, executed_at: "2026-10-26T23:59:59.999Z", terms: { seller_requested_mls_live_date: "2026-11-18" }, listing_agreement_id: "1a450000-0000-4000-8000-0000000000zz" },
  ])
  check("PRECEDENCE: the later executed amendment governs the date, the original keeps governing what the amendment does not name, the superseded value is KEPT as a conflict; a proposed version and another agreement's amendment never govern",
    pr.ok && pr.sellerRequestedMlsLiveDate === "2026-11-11" && pr.resolved.terms.seller_requested_mls_live_date?.source === "amendment"
    && pr.comingSoonStreetAddressAuthorized === false && pr.resolved.conflicts.length === 1 && pr.resolved.conflicts[0].superseded.value === "2026-11-04", JSON.stringify(pr))
  const tie = await govOf({ seller_requested_mls_live_date: "2026-11-04", fully_executed_at: "2026-10-20T10:00:00Z" }, [{ version_no: 1, executed_at: "2026-10-20T10:00:00Z", terms: { seller_requested_mls_live_date: "2026-12-01" } }])
  const strike = await govOf({ coming_soon_street_address_authorized: true }, [{ version_no: 1, executed_at: "2026-10-21T00:00:00Z", terms: { coming_soon_street_address_authorized: null } }])
  const order = await govOf({}, [
    { version_no: 2, executed_at: "2026-10-23T00:00:00Z", terms: { seller_requested_mls_live_date: "2026-11-25" } },
    { version_no: 1, executed_at: "2026-10-22T00:00:00Z", terms: { seller_requested_mls_live_date: "2026-11-20" } },
  ])
  check("same instant: the amendment follows the original (it amends an agreement that exists); an explicit null STRIKES the term (not recorded = withheld); rows arriving out of order resolve by execution time",
    tie.ok && tie.sellerRequestedMlsLiveDate === "2026-12-01" && strike.ok && strike.comingSoonStreetAddressAuthorized === null && strike.resolved.terms.coming_soon_street_address_authorized?.value === null
    && order.ok && order.sellerRequestedMlsLiveDate === "2026-11-25")

  const docs = [
    { id: DOC, brokerage_id: B, listing_id: L, signature_completeness: signed(["seller", "agent"]) },
    { id: DOC_UNSIGNED, brokerage_id: B, listing_id: L, signature_completeness: signed(["agent"]) },
    { id: DOC_FOREIGN, brokerage_id: B2, listing_id: L, signature_completeness: signed(["seller", "agent"]) },
    { id: DOC_OTHER_LISTING, brokerage_id: B, listing_id: L2, signature_completeness: signed(["seller", "broker"]) },
  ]
  const seedD = (o: Record<string, unknown> = {}, opts: any = {}) => memSupabase({
    listings: [{ id: L, brokerage_id: B, agent_id: AG, state: "FL", address: "123 N Main St", go_live_date: null, lifecycle_stage: "COMING_SOON_PREP", go_live_confirmed_at: null, mls_live_date_actual: null, mls_live_timezone: "America/New_York" }],
    agents: [{ id: AG, user_id: U, brokerage_id: B }],
    listing_agreements: [agreementRow(o)], contract_term_versions: [], documents: docs, notifications: [], global_settings: [],
  }, { unique: { contract_term_versions: [["brokerage_id", "listing_agreement_id", "source", "version_no"]] }, ...opts })
  const none = await lat.governingListingAgreementTerms(memSupabase({ listing_agreements: [] }) as any, { brokerageId: B, listingId: L })
  const unsignedOnly = await lat.governingListingAgreementTerms(seedD({ esign_status: "partially_signed" }) as any, { brokerageId: B, listingId: L })
  const exec = await lat.governingListingAgreementTerms(seedD() as any, { brokerageId: B, listingId: L })
  const foreignTenant = await lat.governingListingAgreementTerms(seedD() as any, { brokerageId: B2, listingId: L })
  const refused = await lat.governingListingAgreementTerms(seedD({}, { refuse: { listing_agreements: "permission denied for table listing_agreements" } }) as any, { brokerageId: B, listingId: L })
  const preM856 = await lat.governingListingAgreementTerms(seedD({}, { missingColumns: { listing_agreements: ["seller_requested_mls_live_date", "coming_soon_street_address_authorized"] } }) as any, { brokerageId: B, listingId: L })
  check("THE ONE READER: no agreement → nothing governs; a partially-signed agreement governs nothing; the executed agreement's two terms govern; another tenant sees nothing",
    none.ok && none.agreementId === null && unsignedOnly.ok && unsignedOnly.agreementId === null
    && exec.ok && exec.sellerRequestedMlsLiveDate === "2026-11-04" && exec.comingSoonStreetAddressAuthorized === true && foreignTenant.ok && foreignTenant.agreementId === null)
  check("FAIL CLOSED: a refused read is ok:false naming it (never 'not stated'); PRE-m856 the agreement is found but nothing is recordable or governed (legacy, named)",
    !refused.ok && /permission denied/.test((refused as any).reason) && preM856.ok && preM856.agreementId === LA && preM856.termsRecordable === false && preM856.sellerRequestedMlsLiveDate === null)

  const dbA = seedD()
  const rec = (o: Partial<import("../lib/listings/listing-agreement-terms").RecordListingAmendmentInput>) => lat.recordListingAgreementAmendment(dbA as any, { brokerageId: B, listingId: L, documentId: DOC, executedOn: "2026-10-25", terms: { seller_requested_mls_live_date: "2026-11-11" }, recordedBy: U, now: new Date("2026-10-27T12:00:00Z"), ...o })
  const refusals = await Promise.all([
    rec({ terms: { list_price: 500000 } }), rec({ terms: { seller_requested_mls_live_date: "2026-02-31" } }), rec({ terms: {} }),
    rec({ executedOn: "2026-12-30" }), rec({ documentId: DOC_FOREIGN }), rec({ documentId: DOC_OTHER_LISTING }), rec({ documentId: DOC_UNSIGNED }),
  ])
  const reasons = refusals.map((r) => (r.ok ? "OK" : r.reason))
  check("AMENDMENT REFUSALS by name: a term outside the vocabulary, a non-date, no term, a future signing day, another tenant's document, another listing's document, a document without the SELLER's signature",
    refusals.every((r) => !r.ok) && /not listing-agreement terms/.test(reasons[0]) && /calendar day/.test(reasons[1]) && /state the term/.test(reasons[2]) && /future/.test(reasons[3])
    && /not in your brokerage/.test(reasons[4]) && /different listing/.test(reasons[5]) && /the seller/.test(reasons[6]) && dbA.tables.contract_term_versions.length === 0, reasons.join(" | "))
  const a1 = await rec({})
  const a2 = await rec({ terms: { coming_soon_street_address_authorized: false }, executedOn: "2026-10-26" })
  const row1 = dbA.tables.contract_term_versions[0]
  check("an executed amendment is ONE contract_term_versions row anchored to the agreement (no offer / transaction), status executed, the document kept; numbering continues (1, 2); the original agreement row is untouched",
    a1.ok && a2.ok && (a1 as any).versionNo === 1 && (a2 as any).versionNo === 2 && row1.listing_agreement_id === LA && row1.root_offer_id === null && row1.transaction_id === null
    && row1.status === "executed" && row1.source === "amendment" && row1.document_id === DOC && dbA.tables.listing_agreements[0].seller_requested_mls_live_date === "2026-11-04", JSON.stringify({ a1, a2 }))
  const after = await lat.governingListingAgreementTerms(dbA as any, { brokerageId: B, listingId: L })
  check("after the amendments the reader governs the amended values and keeps the originals as conflicts", after.ok && after.sellerRequestedMlsLiveDate === "2026-11-11" && after.comingSoonStreetAddressAuthorized === false && after.resolved.conflicts.length === 2)
  const preRec = await lat.recordListingAgreementAmendment(seedD({}, { missingColumns: { listing_agreements: ["seller_requested_mls_live_date"] } }) as any, { brokerageId: B, listingId: L, documentId: DOC, executedOn: "2026-10-25", terms: { seller_requested_mls_live_date: "2026-11-11" }, recordedBy: U, now: new Date("2026-10-27T12:00:00Z") })
  check("pre-m856 an amendment is refused naming the migration (never written somewhere else)", !preRec.ok && /m856/.test((preRec as any).reason))

  const dbO = seedD({ seller_requested_mls_live_date: null, coming_soon_street_address_authorized: null })
  const o1 = await lat.recordOriginalListingAgreementTerms(dbO as any, { brokerageId: B, agreementId: LA, terms: { seller_requested_mls_live_date: "2026-11-04", coming_soon_street_address_authorized: false } })
  const o2 = await lat.recordOriginalListingAgreementTerms(dbO as any, { brokerageId: B, agreementId: LA, terms: { seller_requested_mls_live_date: "2026-12-01" } })
  const oPre = await lat.recordOriginalListingAgreementTerms(seedD({}, { missingColumns: { listing_agreements: ["seller_requested_mls_live_date"] } }) as any, { brokerageId: B, agreementId: LA, terms: { seller_requested_mls_live_date: "2026-11-04" } })
  check("the ORIGINAL terms writer: writes both when unrecorded; a second write of a recorded term matches nothing and is REFUSED (write-once — the amendment is the path); pre-m856 says preMigration",
    o1.ok && dbO.tables.listing_agreements[0].seller_requested_mls_live_date === "2026-11-04" && dbO.tables.listing_agreements[0].coming_soon_street_address_authorized === false
    && !o2.ok && /amendment/.test((o2 as any).reason) && dbO.tables.listing_agreements[0].seller_requested_mls_live_date === "2026-11-04" && !oPre.ok && (oPre as any).preMigration === true)

  console.log("\n── E  the planned-date writer obeys the agreement ──")
  G.__145B.events.length = 0
  const dbE = seedD()
  const eOther = await mld.recordPlannedMlsLiveDate(dbE as any, { brokerageId: B, listingId: L, date: "2026-11-20", actorUserId: U, source: "timeline" })
  const eAgentAgree = await mld.recordPlannedMlsLiveDate(dbE as any, { brokerageId: B, listingId: L, date: "2026-11-20", actorUserId: U, source: "agreement" })
  check("a DIFFERENT date from the timeline, and even an 'agreement'-sourced different date, are REFUSED naming the agreed date and the amendment path; the listing is untouched",
    !eOther.ok && /2026-11-04/.test((eOther as any).reason) && /amendment/.test((eOther as any).reason) && !eAgentAgree.ok && dbE.tables.listings[0].go_live_date === null)
  const eSame = await mld.recordPlannedMlsLiveDate(dbE as any, { brokerageId: B, listingId: L, date: "2026-11-04", actorUserId: U, source: "timeline" })
  check("the AGREED date is admitted (whoever records it) and leaves its evidence row", eSame.ok && dbE.tables.listings[0].go_live_date === "2026-11-04" && G.__145B.events.some((e) => e.input.event_type === "listing.mls_live_date.planned"))
  const eClear = await mld.recordPlannedMlsLiveDate(dbE as any, { brokerageId: B, listingId: L, date: null, actorUserId: U, source: "intake" })
  check("CLEARING the agreed date (intake) is refused too — the plan stays the agreed date", !eClear.ok && /amendment/.test((eClear as any).reason) && dbE.tables.listings[0].go_live_date === "2026-11-04")
  const dbNoAg = memSupabase({ listings: [{ id: L, brokerage_id: B, agent_id: AG, state: "FL", go_live_date: null, lifecycle_stage: "COMING_SOON_PREP" }], listing_agreements: [], global_settings: [] })
  const eLegacy = await mld.recordPlannedMlsLiveDate(dbNoAg as any, { brokerageId: B, listingId: L, date: "2026-11-20", actorUserId: U, source: "timeline" })
  check("CONTROL — no executed agreement: a person's plan is recorded exactly as before (wave 143A behaviour unchanged)", eLegacy.ok && dbNoAg.tables.listings[0].go_live_date === "2026-11-20")
  const dbRef = seedD({}, { refuse: { listing_agreements: "permission denied for table listing_agreements" } })
  const eRef = await mld.recordPlannedMlsLiveDate(dbRef as any, { brokerageId: B, listingId: L, date: "2026-11-20", actorUserId: U, source: "timeline" })
  check("FAIL CLOSED: an unreadable agreement refuses the change ('unknown', never 'the seller agreed nothing')", !eRef.ok && /unknown/.test((eRef as any).reason) && dbRef.tables.listings[0].go_live_date === null)

  console.log("\n── F  a date change reaches its survivors ──")
  const retired = (goLive: Date) => { const dow = goLive.getDay(); const lf = dow === 5 ? 7 : ((dow + 2) % 7) + 1; const m = new Date(goLive); m.setDate(goLive.getDate() - lf); const ns = ((6 - dow + 7) % 7) || 7; const e = new Date(goLive); e.setDate(goLive.getDate() + ns); return { m: m.toISOString().slice(0, 10), e: e.toISOString().slice(0, 10) } }
  const days = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]
  const dow = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay()
  const gap = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
  check("the ONE open-house rule meets its SPEC on every weekday: marketing is a FRIDAY 1–7 days BEFORE the live day, the event the first SATURDAY 1–7 days AFTER it (and agrees with the retired calculator on the event day)",
    days.every((x) => { const n = mld.openHouseDatesForPlannedLive(x)!; const g1 = gap(n.marketingDate, x), g2 = gap(x, n.eventDate); return dow(n.marketingDate) === 5 && g1 >= 1 && g1 <= 7 && dow(n.eventDate) === 6 && g2 >= 1 && g2 <= 7 && n.eventDate === retired(new Date(`${x}T12:00:00Z`)).e })
    && mld.openHouseDatesForPlannedLive("2026-11-04")!.marketingDate === "2026-10-30" && mld.openHouseDatesForPlannedLive("2026-11-07")!.eventDate === "2026-11-14" && mld.openHouseDatesForPlannedLive("nope") === null)
  check("DEFECT CONTROL — the retired calculator's 'last Friday' was a THURSDAY for every non-Friday live day (6 of 7 weekdays), which is why the moved rule differs from it",
    days.filter((x) => dow(retired(new Date(`${x}T12:00:00Z`)).m) === 4).length === 6 && dow(retired(new Date("2026-11-06T12:00:00Z")).m) === 5)
  G.__145B.events.length = 0
  const dbF = seedD()
  dbF.tables.listings[0].go_live_date = "2026-11-04"
  const amend = await lat.recordListingAgreementAmendment(dbF as any, { brokerageId: B, listingId: L, documentId: DOC, executedOn: "2026-10-25", terms: { seller_requested_mls_live_date: "2026-11-11" }, recordedBy: U, now: new Date("2026-10-27T12:00:00Z") })
  const f = await mld.followSellerAgreedMlsLiveDate(dbF as any, { brokerageId: B, listingId: L, actorUserId: U, via: "amendment", amendmentVersion: 1 })
  const fl = dbF.tables.listings[0]
  check("an executed amendment moves the PLANNED date, the open-house schedule (pre-open-house stage), bells the agent ONCE naming old → new, and leaves the evidence event — never a verified column",
    amend.ok && f.ok && !(f as any).noop && fl.go_live_date === "2026-11-11" && fl.open_house_marketing_date === "2026-11-06" && fl.open_house_event_date === "2026-11-14"
    && dbF.tables.notifications.filter((n) => n.type === "listing.mls_live_date_changed" && /2026-11-04 → 2026-11-11/.test(n.title)).length === 1
    && G.__145B.events.filter((e) => e.input.event_type === "listing.mls_live_date.planned" && e.input.payload.source === "amendment" && e.input.payload.planned === "2026-11-11").length === 1
    && fl.mls_live_date_actual === null && fl.go_live_confirmed_at === null && (f as any).reached.includes("alert:listing_agent") && (f as any).reached.includes("marketing_schedule:open_house_dates"), JSON.stringify(f))
  const fAgain = await mld.followSellerAgreedMlsLiveDate(dbF as any, { brokerageId: B, listingId: L, actorUserId: U, via: "amendment" })
  check("IDEMPOTENT: following the same agreed date again changes nothing and bells nobody", fAgain.ok && (fAgain as any).noop === true && dbF.tables.notifications.length === 1)
  const dbOH = seedD()
  Object.assign(dbOH.tables.listings[0], { lifecycle_stage: "OPEN_HOUSE_MARKETING", go_live_date: "2026-10-30", open_house_marketing_date: "2026-10-23", open_house_event_date: "2026-10-31" })
  const fOH = await mld.followSellerAgreedMlsLiveDate(dbOH as any, { brokerageId: B, listingId: L, actorUserId: U, via: "agreement" })
  check("CONTROL — once open-house marketing has started its days are NOT moved (the agent is told); the planned date still follows",
    fOH.ok && dbOH.tables.listings[0].go_live_date === "2026-11-04" && dbOH.tables.listings[0].open_house_event_date === "2026-10-31" && (fOH as any).warnings.some((w: string) => /already started/.test(w)))
  const dbLoop = seedD()
  dbLoop.tables.listings[0].lifecycle_stage = "LISTING_AGREEMENT_SIGNED"
  G.__145B.loops.length = 0
  const fLoop = await mld.followSellerAgreedMlsLiveDate(dbLoop as any, { brokerageId: B, listingId: L, actorUserId: U, via: "agreement" })
  check("POLICY CHECKS: at LISTING_AGREEMENT_SIGNED the listing compliance loop re-runs on the agreed date (trigger mls_live_date_set)",
    fLoop.ok && G.__145B.loops.length === 1 && G.__145B.loops[0].trigger === "mls_live_date_set" && (fLoop as any).reached.some((r: string) => r.startsWith("policy:")))

  console.log("\n── G  source: the doors in this lane, and the census of the rest ──")
  const eng = code("app/actions/seller-listing/execution-engine.ts")
  const prep = fnBody(eng, "prepareComingSoonAssets"), act = fnBody(eng, "activateComingSoon"), mas = fnBody(eng, "markAgreementSigned")
  check("prepareComingSoonAssets records the DECIDED address answer (comingSoonCreativeAddressFor), no literal `includes_address: false` claim survives",
    /comingSoonCreativeAddressFor\(/.test(prep) && !/includes_address:\s*false\s*}/.test(prep.replace(/:\s*{\s*includes_address:\s*false,\s*address_withheld_because/, "")) && /includes_address:\s*addr\.resolved\.decision\.disclose/.test(prep))
  check("activateComingSoon checks the reviewed creative in REFUSE mode and refuses on a finding",
    /guardComingSoonCreativeText\([^)]*"refuse"\)/.test(act) && /findings\.length\)\s*return\s*{\s*success:\s*false/.test(act))
  check("markAgreementSigned records the agreement's terms write-once and the plan FOLLOWS the agreement; the engine still writes no `go_live_date:` itself",
    /recordOriginalListingAgreementTerms\(/.test(mas) && /followSellerAgreedMlsLiveDate\(/.test(mas) && !/go_live_date\s*:/.test(eng) && !/function\s+calculateOpenHouseDates/.test(eng))
  const page = code("app/dashboard/listings/[id]/lifecycle/page.tsx")
  const cardAt = page.indexOf("<ComingSoonCommandCard")
  const cardBlock = cardAt >= 0 ? page.slice(cardAt, page.indexOf("/>", cardAt)) : ""
  check("the lifecycle page hands the Coming Soon card the RESOLVED address line, never the raw street (the card feeds it to the AI copy and the posts); POSITIVE CONTROL: the finder sees the retired raw interpolation in a specimen",
    /listingAddress=\{comingSoonCreative\.addressLine\}/.test(cardBlock) && !/listingAddress=\{`\$\{listing\.address\}/.test(cardBlock) && /resolveComingSoonCreativeAddress\(/.test(page)
    && /listingAddress=\{`\$\{listing\.address\}/.test("listingAddress={`${listing.address}, ${listing.city}`}"))
  const door = code("app/actions/seller-listing/listing-agreement-amendment.ts")
  check("the amendment door: session tenant (requireCaller), agent-or-admin gate BEFORE the service client writes, inside withActionLedger (riskClass LEGAL), then follows the date",
    /requireCaller\(\)/.test(door) && /TENANT_ADMIN_USER_TYPES/.test(door) && /withActionLedger/.test(door) && /riskClass:\s*"LEGAL"/.test(door) && /followSellerAgreedMlsLiveDate\(/.test(door) && !/brokerageId:\s*params\./.test(door))
  const mig = raw("supabase/migrations/m856-listing-agreement-governing-terms-mls-live-date-and-coming-soon-address.sql")
  const line1 = mig.split("\n")[0] ?? ""
  check("m856: line 1 is the lane stamp OR the applied stamp (the rule, not the waypoint); adds the two columns, the write-once trigger, the listing_agreement_id anchor and the widened anchor CHECK",
    (/^-- WRITTEN, NOT APPLIED \(wave 145, lane 145B\)/.test(line1) || /^-- ── APPLIED LIVE /.test(line1))
    && /ADD COLUMN IF NOT EXISTS seller_requested_mls_live_date date/.test(mig) && /ADD COLUMN IF NOT EXISTS coming_soon_street_address_authorized boolean/.test(mig)
    && /BEFORE UPDATE OF seller_requested_mls_live_date, coming_soon_street_address_authorized/.test(mig) && /listing_agreement_id uuid NULL REFERENCES public\.listing_agreements\(id\)/.test(mig)
    && /CHECK \(root_offer_id IS NOT NULL OR transaction_id IS NOT NULL OR listing_agreement_id IS NOT NULL\)/.test(mig))

  // THE CENSUS — every PUBLIC Coming Soon creative door the audit found. A door is WIRED when its stripped source calls
  // the address rule; otherwise it is PENDING with its owner (never asserted green, never silently passed).
  const DOOR_CALL = /\b(resolveComingSoonCreativeAddress|guardComingSoonCreativeText|redactStreetAddress|publicComingSoonLocation|comingSoonCreativeAddressFor)\s*\(|listingAddress=\{comingSoonCreative\.addressLine\}/
  check("POSITIVE CONTROL: the door-call finder sees a call in a specimen and not in a bare address interpolation",
    DOOR_CALL.test("const r = guardComingSoonCreativeText(t, l, x, \"redact\")") && !DOOR_CALL.test("const caption = `${hook}: ${address}`"))
  // A door whose prescribed wiring is NOT a call to the rule itself names its own finder (wave 145, lane 145Z): the
  // command card's change is to hand the reviewed copy to activateComingSoon, which REFUSES it under the rule — the
  // card is a client component and cannot call the server rule. Its finder must see exactly that hand-off.
  const CARD_HANDOFF = /activateComingSoon\(\{[^}]*creative:\s*\{\s*socialPost,\s*emailBody\s*\}/
  check("POSITIVE CONTROL: the card hand-off finder sees the reviewed copy passed to the activation door and not the bare activation",
    CARD_HANDOFF.test("await activateComingSoon({ listingId, userId, brokerageId, role: resolvedRole, creative: { socialPost, emailBody } })")
    && !CARD_HANDOFF.test("await activateComingSoon({ listingId, userId, brokerageId, role: resolvedRole })"))
  const DOORS: Array<{ file: string; door: string; owner: string; change: string; wiredBy?: RegExp }> = [
    { file: "app/actions/seller-listing/execution-engine.ts", door: "prepareComingSoonAssets / activateComingSoon", owner: "145B", change: "wired" },
    { file: "app/dashboard/listings/[id]/lifecycle/page.tsx", door: "Coming Soon card's address line", owner: "145B", change: "wired" },
    { file: "app/actions/coming-soon-content.ts", door: "generateComingSoonContent (AI social + email teaser)", owner: "integrator (unowned)", change: "take listingId, resolve the line with resolveComingSoonCreativeAddress, guard the output in redact mode" },
    { file: "app/components/dashboard/listings/lifecycle/coming-soon-command-card.tsx", door: "activation passes the reviewed copy", owner: "integrator (unowned)", change: "activateComingSoon({ …, creative: { socialPost, emailBody } })", wiredBy: CARD_HANDOFF },
    { file: "app/actions/social-media-automation.ts", door: "createListingPosts (coming soon posts)", owner: "integrator (unowned)", change: "guard contentOverride / generated text when the listing is coming soon" },
    { file: "app/actions/email-campaigns.ts", door: "prepareListingEmailCampaign campaignType coming_soon", owner: "integrator (unowned)", change: "guard bodyOverride / generated body for coming_soon" },
    { file: "lib/video/listing-promo-reactor.ts", door: "dispatchListingPromoVideo coming_soon facts", owner: "integrator (unowned)", change: "facts.address = resolved addressLine for coming_soon" },
    { file: "app/api/cron/listing-promo-social-publish/route.ts", door: "coming_soon promo captions", owner: "integrator (unowned)", change: "caption address = resolved addressLine for coming_soon" },
    { file: "lib/marketing/social-carousel.ts", door: "COMING_SOON_ACTIVE carousel slides + caption", owner: "integrator (unowned)", change: "slide title / caption use resolved addressLine for COMING_SOON_ACTIVE" },
    { file: "lib/documents/listing-brochure.ts", door: "COMING_SOON_ACTIVE brochure", owner: "integrator (unowned)", change: "address line resolved for COMING_SOON_ACTIVE" },
    { file: "lib/direct-mail/listing-lifecycle-mail-reactor.ts", door: "coming_soon postcard", owner: "145D", change: "postcard address line resolved for coming_soon" },
    { file: "app/listings/[listingId]/page.tsx", door: "public listing page + metadata for status coming_soon", owner: "integrator (unowned)", change: "title / h1 / alt use resolved addressLine when status = coming_soon" },
    { file: "app/actions/idx-search.ts", door: "public IDX results for status coming_soon", owner: "integrator (unowned)", change: "address of coming_soon results resolved per listing" },
  ]
  for (const dd of DOORS) {
    const src = code(dd.file)
    check(`census entry is real: ${dd.file} exists and still reads a coming-soon token`, existsSync(join(ROOT, dd.file)) && /coming[_ -]?soon|COMING_SOON|ComingSoon/i.test(raw(dd.file)))
    const wired = (dd.wiredBy ?? DOOR_CALL).test(src)
    if (dd.owner === "145B") check(`WIRED (this lane): ${dd.door} — ${dd.file}`, wired)
    else outsideLane(`public Coming Soon creative door ${dd.door} — ${dd.file}`, wired, dd.owner, dd.change)
  }

  // ONE PRECEDENCE FUNCTION (wave 146, lane 146I — closes 145B Outside-lane 16, §6): the listing rail and the contract rail
  // both fold executions through lib/offers/governing-terms-rule.ts foldTermsByPrecedence; neither file keeps its own copy of
  // the loop (stripped source). POSITIVE CONTROL: a resolver that still carries the inline loop is caught.
  {
    const ownLoop = (s: string) => /for \(const key of [A-Z_]+_KEYS\) \{\s*\n\s*if \(!Object\.prototype\.hasOwnProperty\.call\(v\.terms, key\)\) continue/.test(s)
    const listing = code("lib/listings/listing-agreement-terms.ts"), rule = code("lib/offers/governing-terms-rule.ts")
    const ruleOutsideFold = rule.slice(rule.indexOf("export function resolveGoverningTerms"))
    check("ONE precedence fold: the listing rail and the contract rail both call foldTermsByPrecedence and neither keeps its own loop — POSITIVE CONTROL: the inline loop shape is recognised",
      /foldTermsByPrecedence\(/.test(listing) && /foldTermsByPrecedence\(/.test(ruleOutsideFold) && !ownLoop(listing) && !ownLoop(ruleOutsideFold)
      && ownLoop(`for (const key of LISTING_AGREEMENT_TERM_KEYS) {\n      if (!Object.prototype.hasOwnProperty.call(v.terms, key)) continue`))
  }

  console.log(`\n RESULT: ${passed} passed, ${failed} failed, ${pending.length} pending outside lane`)
  if (pending.length) { console.log(" PENDING (outside lane):"); for (const p of pending) console.log(`   ◌ ${p}`) }
  if (failed) { console.log(" FAILURES:"); for (const f2 of failures) console.log(`   ✗ ${f2}`); console.log(" ❌ LISTING_COMING_SOON_LIVE_DATE_FAIL"); process.exit(1) }
  console.log(" ✅ LISTING_COMING_SOON_LIVE_DATE_PASS — the street address is withheld from public Coming Soon creative unless the seller AND the attested rule allow it; the seller-agreed MLS live date comes from the executed agreement, changes only by an executed amendment, and reaches its survivors")
}

main().catch((err) => { console.error(err); process.exit(1) })
