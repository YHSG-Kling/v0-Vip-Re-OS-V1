#!/usr/bin/env tsx
/**
 * scripts/transaction-creation-gate-simulator.ts  (npm run test:transaction-creation-gate)
 * ─────────────────────────────────────────────────────────────────────────────
 * A TRANSACTION COULD COME INTO EXISTENCE WITH NOTHING CHECKED.
 *
 * Owner's rule, verbatim:
 *
 *   "when the transaction is created it is only created after the compliance is
 *    good, all documents are present with full signatures and initials. the
 *    required document list is in the settings for the transaction coordinator
 *    or admin."
 *
 * FIVE writers put rows into `transactions`, and only ONE of them checked
 * anything:
 *
 *   1. lib/transactions/offer-bridge.ts:createTransactionFromOffer — the
 *      documented single source of truth. It gated the OFFER COLUMNS (buyer
 *      signed, executed contract on file, compliance stamped) but never the
 *      brokerage's required-document LIST and never the per-document signature
 *      and initial state.
 *   2. lib/application/transactions.ts:createTransaction — LIVE, reached from
 *      app/dashboard/transactions/components/create-transaction-sheet.tsx via
 *      app/actions/transactions.ts. Zero checks of any kind.
 *   3. lib/kernel/transactions.ts:createManualTransaction — exported from
 *      lib/kernel/index.ts. Zero checks.
 *   4. services/supabaseService.ts:createTransaction — an OPAQUE payload pushed
 *      through the SERVICE-ROLE client. Zero checks, no session tenant.
 *   5. app/actions/listings-kernel.ts:createListingWithSellerContact — opened a
 *      seller-side deal row at LISTING INTAKE, before any agreement was signed
 *      and while the listing itself was still a draft.
 *
 * All five now run lib/transactions/transaction-creation-gate.ts, which refuses
 * unless all four obligations hold, and refuses when it cannot RUN.
 *
 * ── MEASUREMENT DISCIPLINE (CLAUDE.md §2) ────────────────────────────────────
 * Every absence assertion below carries a POSITIVE CONTROL: the same finder is
 * run against a fixture that MUST trip it. A broken regex and a clean tree both
 * report zero, so each "0 found" here is proved to be a real zero.
 *
 * The behavioural half runs against an INJECTED fake Postgrest client rather
 * than the live database, so a refused read can be produced on demand — which is
 * the only way to prove the fail-closed branch, and the branch the whole lane
 * exists for.
 */
import { readFileSync, existsSync } from "node:fs"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) => (existsSync(p) ? stripComments(readFileSync(p, "utf8")) : "")

// ═══════════════════════════════════════════════════════════════════════════
// A fake PostgREST client. Chainable, filterable, and able to REFUSE.
// ═══════════════════════════════════════════════════════════════════════════

type Row = Record<string, any>
interface FakeDb {
  tables: Record<string, Row[]>
  /** table → error message. A table listed here REFUSES every read. */
  refuse?: Record<string, string>
}

function makeClient(db: FakeDb) {
  const reads: string[] = []
  const client: any = {
    reads,
    from(table: string) {
      reads.push(table)
      let rows: Row[] = (db.tables[table] ?? []).slice()
      const err = db.refuse?.[table] ? { message: db.refuse[table] } : null
      const b: any = {
        select: () => b,
        order:  () => b,
        limit:  (n: number) => { rows = rows.slice(0, n); return b },
        eq: (col: string, val: any) => { rows = rows.filter(r => r[col] === val); return b },
        is: (col: string, val: any) => { rows = rows.filter(r => (r[col] ?? null) === val); return b },
        not: (col: string, _op: string, val: any) => {
          rows = rows.filter(r => (r[col] ?? null) !== val); return b
        },
        filter: (path: string, _op: string, val: any) => {
          // "metadata->>linked_offer_id"
          const m = path.match(/^(\w+)->>(\w+)$/)
          if (m) rows = rows.filter(r => (r[m[1]] ?? {})[m[2]] === val)
          return b
        },
        or: (expr: string) => {
          // "deal_type.eq.buyer,deal_type.eq.dual"
          const clauses = expr.split(",").map(c => c.split("."))
          rows = rows.filter(r => clauses.some(([col, op, v]) => op === "eq" && String(r[col]) === v))
          return b
        },
        maybeSingle: async () => (err ? { data: null, error: err } : { data: rows[0] ?? null, error: null }),
        single:      async () => (err ? { data: null, error: err } : { data: rows[0] ?? null, error: null }),
        then: (resolve: any, reject: any) =>
          Promise.resolve(err ? { data: null, error: err } : { data: rows, error: null }).then(resolve, reject),
      }
      return b
    },
  }
  return client
}

// ═══════════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════════

const BROKERAGE = "11111111-1111-4111-8111-111111111111"
const OFFER     = "22222222-2222-4222-8222-222222222222"
const CONTACT   = "33333333-3333-4333-8333-333333333333"
const AGENT_U   = "44444444-4444-4444-8444-444444444444"

const compliancePassedActivities = () => ([
  {
    id: "act-1", brokerage_id: BROKERAGE, entity_type: "offer", entity_id: OFFER,
    activity_type: "buyer.offer.compliance.passed", status: null,
    created_at: "2026-08-01T00:00:00Z", title: null,
  },
])

const offerRow = (over: Row = {}) => ({
  id: OFFER, brokerage_id: BROKERAGE, transaction_id: null,
  compliance_passed_at: "2026-08-01T00:00:00Z", ...over,
})

/** The brokerage's SETTINGS checklist: one blocking signed_contract. */
const checklist = (over: Row = {}) => ([{
  classification: "signed_contract", scope_type: "brokerage", scope_id: BROKERAGE,
  block_on_missing: true, description: null, deal_type: "buyer",
  state_code: null, template_form_id: null, is_required: true,
  brokerage_id: BROKERAGE, ...over,
}])

/** A signed contract in the deal file with a given execution blob. */
const contractDoc = (signature_completeness: any) => ({
  id: "doc-contract", brokerage_id: BROKERAGE, contact_id: CONTACT,
  listing_id: null, classification: "signed_contract", status: "signed",
  metadata: { linked_offer_id: OFFER }, signature_completeness,
})

const FULLY_EXECUTED = {
  signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }],
  initials:   [{ signer_role: "buyer", all_required_initials_present: true },
               { signer_role: "seller", all_required_initials_present: true }],
}
const SELLER_NOT_SIGNED = {
  signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: false }],
  initials:   [{ signer_role: "buyer", all_required_initials_present: true },
               { signer_role: "seller", all_required_initials_present: true }],
}
const SELLER_INITIALS_OUTSTANDING = {
  signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }],
  initials:   [{ signer_role: "buyer", all_required_initials_present: true },
               { signer_role: "seller", all_required_initials_present: false }],
}

const GATE_PARAMS = {
  brokerageId: BROKERAGE,
  offerId:     OFFER,
  listingId:   null,
  contactIds:  [CONTACT],
  agentUserId: AGENT_U,
  teamId:      null,
  dealType:    "buyer" as const,
  stateCode:   null,
  door:        "simulator",
}

async function main() {
  const { assertTransactionCreationAllowed, findUnexecutedDocuments } =
    await import("../lib/transactions/transaction-creation-gate")

  console.log("\n[the four obligations — each one refuses on its own]\n")

  // ── ALL FOUR HOLD → ALLOWED. This is the positive control for every
  //    refusal below: if this cannot go green, a refusal proves nothing.
  const allGood = await assertTransactionCreationAllowed(makeClient({
    tables: {
      offers: [offerRow()],
      activities: compliancePassedActivities(),
      brokerage_required_documents: checklist(),
      documents: [contractDoc(FULLY_EXECUTED)],
    },
  }), GATE_PARAMS)
  check("ALLOWED when compliance is good, the required document is present, fully signed and fully initialed",
    allGood.allowed === true && allGood.refusals.length === 0)
  check("  ↳ and it says so with the required TOTAL beside the verdict ('nothing required' ≠ 'nothing checked')",
    allGood.detail.requiredTotal === 1 && allGood.detail.complianceState === "passed")

  // ── 1. compliance not good ────────────────────────────────────────────────
  const noCompliance = await assertTransactionCreationAllowed(makeClient({
    tables: {
      offers: [offerRow({ compliance_passed_at: null })],
      activities: [],
      brokerage_required_documents: checklist(),
      documents: [contractDoc(FULLY_EXECUTED)],
    },
  }), GATE_PARAMS)
  check("REFUSED when compliance has not passed",
    noCompliance.allowed === false
    && noCompliance.refusals.some(r => r.requirement === "compliance_good"))
  check("  ↳ POSITIVE CONTROL: the same fixture with compliance stamped is ALLOWED",
    allGood.allowed === true)

  const openFlag = await assertTransactionCreationAllowed(makeClient({
    tables: {
      offers: [offerRow()],
      activities: [
        ...compliancePassedActivities(),
        { id: "act-2", brokerage_id: BROKERAGE, entity_type: "offer", entity_id: OFFER,
          activity_type: "buyer.offer.compliance.flagged", status: "open",
          title: "Field missing on Purchase Agreement: closing date", created_at: "2026-08-02T00:00:00Z" },
      ],
      brokerage_required_documents: checklist(),
      documents: [contractDoc(FULLY_EXECUTED)],
    },
  }), GATE_PARAMS)
  check("REFUSED when a compliance flag is still OPEN, even with the pass stamped",
    openFlag.allowed === false
    && openFlag.refusals.some(r => r.requirement === "compliance_good")
    && /still open/i.test(openFlag.reason))
  check("  ↳ …and the refusal NAMES the outstanding item, not just 'blocked'",
    openFlag.reason.includes("closing date"))
  check("  ↳ POSITIVE CONTROL: the same flag RESOLVED (status≠open) is ALLOWED",
    (await assertTransactionCreationAllowed(makeClient({
      tables: {
        offers: [offerRow()],
        activities: [
          ...compliancePassedActivities(),
          { id: "act-2", brokerage_id: BROKERAGE, entity_type: "offer", entity_id: OFFER,
            activity_type: "buyer.offer.compliance.flagged", status: "resolved",
            title: "Field missing on Purchase Agreement: closing date", created_at: "2026-08-02T00:00:00Z" },
        ],
        brokerage_required_documents: checklist(),
        documents: [contractDoc(FULLY_EXECUTED)],
      },
    }), GATE_PARAMS)).allowed === true)

  // ── 2. a required document missing ────────────────────────────────────────
  const missingDoc = await assertTransactionCreationAllowed(makeClient({
    tables: {
      offers: [offerRow()],
      activities: compliancePassedActivities(),
      brokerage_required_documents: [
        ...checklist(),
        { ...checklist()[0], classification: "agency_disclosure" },
      ],
      documents: [contractDoc(FULLY_EXECUTED)],
    },
  }), GATE_PARAMS)
  check("REFUSED when a SETTINGS-required document is missing from the deal file",
    missingDoc.allowed === false
    && missingDoc.refusals.some(r => r.requirement === "required_documents_present"))
  check("  ↳ …and the refusal NAMES which document is missing",
    missingDoc.reason.includes("Agency disclosure")
    && missingDoc.detail.missingRequired.includes("Agency disclosure"))
  check("  ↳ POSITIVE CONTROL: supply that document and the same fixture is ALLOWED",
    (await assertTransactionCreationAllowed(makeClient({
      tables: {
        offers: [offerRow()],
        activities: compliancePassedActivities(),
        brokerage_required_documents: [
          ...checklist(),
          { ...checklist()[0], classification: "agency_disclosure" },
        ],
        documents: [
          contractDoc(FULLY_EXECUTED),
          { ...contractDoc(FULLY_EXECUTED), id: "doc-agency", classification: "agency_disclosure" },
        ],
      },
    }), GATE_PARAMS)).allowed === true)

  // ── 3. present but NOT fully signed ───────────────────────────────────────
  const notSigned = await assertTransactionCreationAllowed(makeClient({
    tables: {
      offers: [offerRow()],
      activities: compliancePassedActivities(),
      brokerage_required_documents: checklist(),
      documents: [contractDoc(SELLER_NOT_SIGNED)],
    },
  }), GATE_PARAMS)
  check("REFUSED when a required document is PRESENT but not fully signed",
    notSigned.allowed === false
    && notSigned.refusals.some(r => r.requirement === "documents_fully_signed"))
  check("  ↳ …and the refusal names the missing SIGNATURE and the document",
    notSigned.reason.includes("seller signature") && notSigned.reason.includes("Signed contract"))

  // ── 4. INITIALS outstanding, signatures complete ──────────────────────────
  const initialsOut = await assertTransactionCreationAllowed(makeClient({
    tables: {
      offers: [offerRow()],
      activities: compliancePassedActivities(),
      brokerage_required_documents: checklist(),
      documents: [contractDoc(SELLER_INITIALS_OUTSTANDING)],
    },
  }), GATE_PARAMS)
  check("REFUSED when INITIALS are outstanding even though every signature block is filled",
    initialsOut.allowed === false
    && initialsOut.refusals.some(r => r.requirement === "initials_complete"))
  check("  ↳ initials refuse under their OWN requirement, not folded into 'signatures'",
    initialsOut.refusals.every(r => r.requirement !== "documents_fully_signed")
    && initialsOut.reason.includes("seller initials"))
  check("  ↳ POSITIVE CONTROL: flip that ONE boolean to true and the same fixture is ALLOWED",
    allGood.allowed === true
    && JSON.stringify(SELLER_INITIALS_OUTSTANDING.signatures) === JSON.stringify(FULLY_EXECUTED.signatures))

  // A document that was NEVER SCANNED has verified nothing. Absence is not consent.
  const unscanned = await assertTransactionCreationAllowed(makeClient({
    tables: {
      offers: [offerRow()],
      activities: compliancePassedActivities(),
      brokerage_required_documents: checklist(),
      documents: [contractDoc(null)],
    },
  }), GATE_PARAMS)
  check("REFUSED when the required contract carries NO signature record at all (absence is not consent)",
    unscanned.allowed === false
    && unscanned.refusals.some(r => r.requirement === "documents_fully_signed")
    && unscanned.refusals.some(r => r.requirement === "initials_complete"))
  check("  ↳ …and it says the document was NEVER SCANNED, not that a party failed to sign — a different remedy",
    /never scanned/.test(unscanned.reason)
    && unscanned.detail.unexecuted.every(u => u.unscanned === true))
  check("  ↳ POSITIVE CONTROL: a scanned-but-incomplete document is NOT reported as unscanned",
    notSigned.detail.unexecuted.every(u => u.unscanned === false)
    && !/never scanned/.test(notSigned.reason))

  console.log("\n[fail-closed — a gate that cannot RUN must refuse]\n")

  const checklistRefused = await assertTransactionCreationAllowed(makeClient({
    tables: {
      offers: [offerRow()],
      activities: compliancePassedActivities(),
      brokerage_required_documents: checklist(),
      documents: [contractDoc(FULLY_EXECUTED)],
    },
    refuse: { brokerage_required_documents: "permission denied for table brokerage_required_documents" },
  }), GATE_PARAMS)
  check("REFUSED when the SETTINGS checklist read is refused — an unreadable list is not an empty one",
    checklistRefused.allowed === false
    && checklistRefused.refusals.some(r => r.requirement === "gate_could_not_run")
    && /permission denied/.test(checklistRefused.reason))
  check("  ↳ …and requiredTotal is NULL, never 0 — the number that would have read as 'nothing required'",
    checklistRefused.detail.requiredTotal === null)

  const fileRefused = await assertTransactionCreationAllowed(makeClient({
    tables: {
      offers: [offerRow()],
      activities: compliancePassedActivities(),
      brokerage_required_documents: checklist(),
      documents: [contractDoc(FULLY_EXECUTED)],
    },
    refuse: { documents: "could not connect to documents" },
  }), GATE_PARAMS)
  check("REFUSED when the DEAL FILE read is refused",
    fileRefused.allowed === false
    && fileRefused.refusals.some(r => r.requirement === "gate_could_not_run"))

  const ledgerRefused = await assertTransactionCreationAllowed(makeClient({
    tables: {
      offers: [offerRow()],
      activities: compliancePassedActivities(),
      brokerage_required_documents: checklist(),
      documents: [contractDoc(FULLY_EXECUTED)],
    },
    refuse: { activities: "statement timeout" },
  }), GATE_PARAMS)
  check("REFUSED when the COMPLIANCE LEDGER read is refused",
    ledgerRefused.allowed === false
    && ledgerRefused.refusals.some(r => r.requirement === "gate_could_not_run"))

  check("  ↳ POSITIVE CONTROL: with no refusal configured, the identical fixture is ALLOWED",
    allGood.allowed === true)

  const noTenant = await assertTransactionCreationAllowed(makeClient({ tables: {} }), {
    ...GATE_PARAMS, brokerageId: "",
  })
  check("REFUSED when there is no session tenant to scope the check to",
    noTenant.allowed === false && noTenant.refusals[0].requirement === "gate_could_not_run")

  const foreignOffer = await assertTransactionCreationAllowed(makeClient({
    tables: {
      offers: [offerRow({ brokerage_id: "99999999-9999-4999-8999-999999999999" })],
      activities: compliancePassedActivities(),
      brokerage_required_documents: checklist(),
      documents: [contractDoc(FULLY_EXECUTED)],
    },
  }), GATE_PARAMS)
  check("REFUSED when the offer belongs to ANOTHER brokerage (tenant re-read, not caller-asserted)",
    foreignOffer.allowed === false
    && /different brokerage/.test(foreignOffer.reason))

  console.log("\n[no offer = no compliance evidence — the manual doors]\n")

  const manual = await assertTransactionCreationAllowed(makeClient({
    tables: {
      offers: [], activities: [],
      brokerage_required_documents: checklist(),
      documents: [],
    },
  }), { ...GATE_PARAMS, offerId: null })
  check("REFUSED when there is no accepted offer at all — compliance has never been reviewed",
    manual.allowed === false
    && manual.refusals.some(r => r.requirement === "compliance_good")
    && manual.detail.complianceState === "unknown")
  check("  ↳ …and it still names the outstanding paperwork so the refusal is actionable",
    manual.detail.missingRequired.includes("Signed contract"))

  console.log("\n[the pure predicate — signatures and initials kept apart]\n")

  const split = findUnexecutedDocuments(
    [{ id: "d1", classification: "signed_contract", status: "signed", signature_completeness: SELLER_INITIALS_OUTSTANDING }],
    ["signed_contract"],
  )
  check("findUnexecutedDocuments reports an initials gap with NO signature gap",
    split.length === 1 && split[0].missingSignatures.length === 0 && split[0].missingInitials.length === 1)
  const split2 = findUnexecutedDocuments(
    [{ id: "d1", classification: "signed_contract", status: "signed", signature_completeness: SELLER_NOT_SIGNED }],
    ["signed_contract"],
  )
  check("  ↳ and a signature gap with NO initials gap on the mirror fixture",
    split2.length === 1 && split2[0].missingSignatures.length === 1 && split2[0].missingInitials.length === 0)
  check("  ↳ POSITIVE CONTROL: a fully executed document produces NO finding",
    findUnexecutedDocuments(
      [{ id: "d1", classification: "signed_contract", status: "signed", signature_completeness: FULLY_EXECUTED }],
      ["signed_contract"],
    ).length === 0)
  check("an EVIDENCE document (proof of funds) is never asked for a signature it does not carry",
    findUnexecutedDocuments(
      [{ id: "d2", classification: "proof_of_funds", status: "complete", signature_completeness: null }],
      ["proof_of_funds"],
    ).length === 0)
  check("  ↳ POSITIVE CONTROL: the same unsigned blob on a CONTRACT does produce a finding",
    findUnexecutedDocuments(
      [{ id: "d3", classification: "signed_contract", status: "complete", signature_completeness: null }],
      ["signed_contract"],
    ).length === 1)

  console.log("\n[the settings checklist fails closed at its own end]\n")

  const { resolveRequiredDocuments } = await import("../lib/compliance/required-documents")
  const refusedResolve = await resolveRequiredDocuments(makeClient({
    tables: { brokerage_required_documents: checklist() },
    refuse: { brokerage_required_documents: "RLS refused" },
  }) as any, { brokerageId: BROKERAGE, dealType: "buyer" })
  check("resolveRequiredDocuments returns ok:false on a refused read — never an empty checklist",
    refusedResolve.ok === false)
  const okResolve = await resolveRequiredDocuments(makeClient({
    tables: { brokerage_required_documents: checklist() },
  }) as any, { brokerageId: BROKERAGE, dealType: "buyer" })
  check("  ↳ POSITIVE CONTROL: the same read unrefused returns ok:true with the rule",
    okResolve.ok === true && okResolve.docs.length === 1)
  const emptyResolve = await resolveRequiredDocuments(makeClient({
    tables: { brokerage_required_documents: [] },
  }) as any, { brokerageId: BROKERAGE, dealType: "buyer" })
  check("  ↳ a checklist that RAN and is genuinely empty stays ok:true — 'nothing required' is a real answer",
    emptyResolve.ok === true && emptyResolve.docs.length === 0)

  // ═════════════════════════════════════════════════════════════════════════
  // EVERY CREATION PATH IS GATED (source layer — the behavioural gate above
  // proves the gate works; this proves nothing routes around it).
  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n[every writer into `transactions` runs the gate]\n")

  const GATE_CALL = /assertTransactionCreationAllowed\s*\(/
  const WRITERS: Array<{ file: string; label: string }> = [
    { file: "lib/transactions/offer-bridge.ts",     label: "offer → transaction (the single source of truth)" },
    { file: "lib/application/transactions.ts",      label: "the LIVE manual transaction sheet" },
    { file: "lib/kernel/transactions.ts",           label: "kernel createManualTransaction" },
    { file: "services/supabaseService.ts",          label: "supabaseService.createTransaction (service-role)" },
    { file: "app/actions/listings-kernel.ts",       label: "listing-intake seller-side deal" },
  ]
  for (const w of WRITERS) {
    const text = src(w.file)
    check(`${w.label} — ${w.file} calls the gate`, GATE_CALL.test(text))
  }
  check("  ↳ POSITIVE CONTROL: the finder does NOT fire on a file that has no gate",
    !GATE_CALL.test(src("lib/compliance/document-classifications.ts")))

  // The census itself: no SIXTH writer appeared without a gate. Denominator and
  // exclusions published beside the number (CLAUDE.md §2).
  const { execSync } = await import("node:child_process")
  const raw = execSync(
    `grep -rln 'from("transactions")' --include=*.ts --include=*.tsx app lib services || true`,
    { cwd: process.cwd(), encoding: "utf8" },
  )
  const candidateFiles = raw.split("\n").filter(Boolean)

  // THE INSERTER FINDER, AND WHY IT IS TIGHT.
  //
  // The first spelling was `from("transactions") … {0,200} … .insert(`, which
  // reported EIGHT inserters. Three of them — app/actions/deal-shaky.ts,
  // lib/transactions/walkthrough-outcome.ts, lib/transactions/gift-order-trigger.ts
  // — do not insert a transaction at all: each SELECTs or UPDATEs `transactions`
  // and then, a few lines later, inserts into `lifecycle_events`, `tasks` or
  // `activities`. The window swallowed the intervening `.from()`.
  //
  // A COUNT THAT MOVES IS THE FINDING (CLAUDE.md §2): 8 → 5, and the direction is
  // FEWER because the loose finder was ACCUSING LIVE CODE, not because anything
  // was gated away. The tight form requires `.insert(` to be chained DIRECTLY off
  // `.from("transactions")`, which is how all five real writers are written.
  const INSERTER = /from\("transactions"\)\s*\.insert\(/
  const inserters = candidateFiles.filter(f => INSERTER.test(src(f)))
  const ungated = inserters.filter(f => !GATE_CALL.test(src(f)))
  console.log(`  · scanned ${candidateFiles.length} file(s) touching \`transactions\` under app/ lib/ services/;`)
  console.log(`    ${inserters.length} of them INSERT (a loose {0,200} window said 8 — three of those`)
  console.log(`    select/update transactions then insert a DIFFERENT table); excluded: scripts/`)
  console.log(`    (simulators seed fixtures deliberately), e2e/, supabase/ migrations, node_modules.`)
  check(`no UNGATED transactions writer remains in app/ lib/ services/ (found ${ungated.length}${ungated.length ? `: ${ungated.join(", ")}` : ""})`,
    ungated.length === 0)
  check("  ↳ POSITIVE CONTROL: the inserter-finder still recognises a real insert, chained and wrapped",
    INSERTER.test(`const x = await svc.from("transactions").insert({ a: 1 })`)
    && INSERTER.test(`await supabase\n    .from("transactions")\n    .insert({ a: 1 })`))
  check("  ↳ NEGATIVE CONTROL: it does NOT fire on select-then-insert-another-table (the three it used to accuse)",
    !INSERTER.test(`await svc.from("transactions").update({ x: 1 }).eq("id", id)\n  await svc.from("tasks").insert({ y: 2 })`))
  check("  ↳ …and all five known writers are still caught by the tight form",
    WRITERS.every(w => INSERTER.test(src(w.file))))

  // ── THE SAME FACT, ONE STAGE EARLIER, FROM THE SAME READER ────────────────
  //
  // "present but not fully executed" was computed ONLY here, at creation. So a
  // required agency disclosure or addendum uploaded blank satisfied the compliance
  // checkpoint's missing-document audit, compliance was STAMPED, and the gap
  // surfaced only when the deal tried to become a transaction and this gate
  // refused. submitOfferToCompliance now makes the same reading at submit time
  // and names it to the TC on the existing warning path — through THIS module's
  // exported reader, not a second copy of the loop (CLAUDE.md §6), so the warning
  // a TC sees and the refusal they would hit later cannot describe different
  // documents.
  console.log("\n[the compliance checkpoint reads execution through this same gate module]\n")
  const submitSrc = src("app/actions/buyer-offer/submit-to-compliance.ts") // src() already strips comments
  check("POSITIVE CONTROL — submitOfferToCompliance's source is visible to this scan",
    submitSrc.length > 0 && /auditOfferDocuments\(/.test(submitSrc))
  check("the checkpoint imports the gate's OWN reader rather than re-spelling the loop",
    /import \{ findUnexecutedDocuments \}\s+from "@\/lib\/transactions\/transaction-creation-gate"/.test(submitSrc))
  check("…and actually calls it over the audited deal file + the settings checklist",
    /findUnexecutedDocuments\(\s*audit\.deal_file,\s*audit\.required_breakdown\.map\(\(r\) => r\.classification\),\s*\)/.test(submitSrc))
  check("…and the un-executed miss REACHES somebody — it is on the warning condition, not merely computed",
    /\|\|\s*unexecutedRequired\.length > 0/.test(submitSrc))
  check("…keeping signatures and initials apart, and the never-scanned apart from a real gap",
    /unexecutedNeverScanned\s*=\s*unexecutedRequired\.filter\(\(u\) => u\.unscanned\)/.test(submitSrc)
    && /unexecutedRealGaps\s*=\s*unexecutedRequired\.filter\(\(u\) => !u\.unscanned\)/.test(submitSrc))
  check("…and it WARNS rather than blocking — the ruling that turns this into a refusal does not exist",
    !/unexecutedRequired\.length > 0\s*\)\s*\{\s*return \{\s*success: false/.test(submitSrc))
  check("  ↳ POSITIVE CONTROL: the call-site finder does NOT fire on a file that never makes this reading",
    !/findUnexecutedDocuments\(/.test(src("lib/documents/listing-agreement-gate.ts")))
  check("  ↳ POSITIVE CONTROL: …and it DOES fire on a hand-written call of the same shape",
    /findUnexecutedDocuments\(\s*audit\.deal_file,\s*audit\.required_breakdown\.map\(\(r\) => r\.classification\),\s*\)/.test(
      "const u = findUnexecutedDocuments(\n    audit.deal_file,\n    audit.required_breakdown.map((r) => r.classification),\n  )"))

  console.log("\n[the gate is not skippable on the offer path]\n")
  const bridge = src("lib/transactions/offer-bridge.ts")
  check("skipOfferGate skips only the OFFER-COLUMN gate, never the creation gate",
    /if \(!params\.skipOfferGate\)/.test(bridge)
    && GATE_CALL.test(bridge)
    && !/skipOfferGate[\s\S]{0,400}assertTransactionCreationAllowed/.test(
      bridge.slice(bridge.indexOf("if (!params.skipOfferGate)"), bridge.indexOf("if (!params.skipOfferGate)") + 400)))
  check("  ↳ the bridge crosses agents.id → users.id before asking for an agent-scoped checklist",
    /from\("agents"\)[\s\S]{0,120}select\("user_id"\)/.test(bridge))

  console.log("\n[the settings surface admits the transaction coordinator]\n")
  const manageRaw = src("app/actions/compliance/manage-required-docs.ts")
  const pageRaw   = src("app/dashboard/settings/required-documents/page.tsx")
  const clientRaw = src("app/dashboard/settings/required-documents/required-docs-settings-client.tsx")
  check("the WRITE action admits 'tc' — the role the owner names first",
    /PRINCIPAL_ROLES\s*=\s*new Set\(\[[\s\S]*?"tc"/.test(manageRaw))
  check("the settings PAGE admits 'tc'", /ADMIN_ROLES\s*=\s*\[[^\]]*"tc"/.test(pageRaw))
  check("the scope picker admits 'tc'", /PRINCIPALS\s*=\s*\[[^\]]*"tc"/.test(clientRaw))
  check("  ↳ POSITIVE CONTROL: the same finders reject a role that is NOT admitted",
    !/PRINCIPAL_ROLES\s*=\s*new Set\(\[[\s\S]*?"lender"/.test(manageRaw)
    && !/ADMIN_ROLES\s*=\s*\[[^\]]*"lender"/.test(pageRaw))
  check("platform staff are admitted through users.platform_role, not a dead user_type",
    /isPlatformStaffRole\(/.test(manageRaw)
    && !/"superadmin"/.test(manageRaw.slice(manageRaw.indexOf("PRINCIPAL_ROLES"), manageRaw.indexOf("PRINCIPAL_ROLES") + 300)))

  console.log("\n[manager ownership]\n")
  const { MAINTENANCE_DOMAINS, MANAGERS } = await import("../lib/kernel/manager-registry")
  const domain = (MAINTENANCE_DOMAINS as any).transaction_creation_gate
  check("transaction_creation_gate is registered in MAINTENANCE_DOMAINS", !!domain)
  check("  ↳ owned by a REAL manager from the 14-seat registry",
    !!domain && domain.manager in MANAGERS)
  check("  ↳ owned by deal_coordinator (the steward of `transactions`)",
    !!domain && domain.manager === "deal_coordinator")
  check("  ↳ the cross-cooperation with compliance_officer is named, on an ALREADY-DECLARED edge",
    !!domain && /compliance_officer/.test(domain.what) && /closing_money_and_risk/.test(domain.what))
  check("  ↳ proof names this simulator", !!domain && domain.proof === "test:transaction-creation-gate")

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log(` ❌ TRANSACTION_CREATION_GATE_FAIL`)
    for (const f of fails) console.log(`    · ${f}`)
    process.exit(1)
  }
  console.log(" ✅ TRANSACTION_CREATION_GATE_PASS — a transaction exists only after compliance, documents, signatures and initials")
}

main().catch((e) => { console.error(e); process.exit(1) })
