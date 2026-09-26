#!/usr/bin/env tsx
/**
 * scripts/listing-activation-gate-simulator.ts  (npm run test:listing-activation-gate)
 * ─────────────────────────────────────────────────────────────────────────────
 * A LISTING COULD GO PUBLICLY LIVE WITH NOTHING CHECKED.
 *
 * Owner's ruling, verbatim (2026-09-04):
 *
 *   "compliance is involved when an offer gates to create a transaction once the
 *    offer is fully executed by both buyer and seller, the compliance gate runs
 *    through the documents against an approved checklist provided by the
 *    brokerage to make sure all documents are present and that all signatures
 *    and initials are present, then the executed offer becomes a transaction,
 *    wether we represent the seller, or/and the buyer. SAME COMPLIANCE GATE WHEN
 *    A LISTING BECOMES AN ACTIVE LISTING."
 *
 * TWO doors made a listing publicly live and NEITHER checked a document:
 *
 *   1. app/actions/seller-listing/execution-engine.ts::activateMLS — gated on
 *      tenancy and `role !== "admin"` and nothing else. It calls
 *      transitionLifecycle to MLS_ACTIVE, and lib/kernel/lifecycle.ts syncs
 *      listings.status to 'active' on that transition
 *      (lib/listings/listing-status-sync.ts), so the listing went public.
 *   2. lib/kernel/listings.ts::launchListing — writes `status:'active'` AND
 *      `lifecycle_stage:'MLS_ACTIVE'` straight onto the row, bypassing the stage
 *      machine entirely. Its only gate, validateListingLaunchReadiness, asks for
 *      a seller contact, a list price, an MLS number and five photos — never a
 *      document, a signature or an initial.
 *
 * And a THIRD path could walk around both: the generic stage advance
 * (lib/application/listing-lifecycle.ts::requireListingStageAdvance) evaluates
 * whatever the TARGET stage declares, and MLS_ACTIVE declared only
 * ["mls_data_complete"].
 *
 * All three now enforce the owner's four obligations.
 *
 * ── MEASUREMENT DISCIPLINE (CLAUDE.md §2) ────────────────────────────────────
 * · Source scanning reads COMMENT-STRIPPED text. This tree is dense with
 *   tombstones and headers that quote the very call shapes being searched for —
 *   including this file's own header — and a raw scan would read that prose as
 *   live code and pass while the code was gone.
 * · Every assertion is paired with a MUTATION that must flip it to failure. A
 *   mutation whose find-string no longer matches is reported as THEATRE rather
 *   than silently counted as a pass.
 * · THE TWO GATE-SHAPED NEGATIVE CONTROLS the brief demands are explicit:
 *   an always-pass gate and an always-refuse gate are both run through the same
 *   behavioural battery and both MUST be caught (`alwaysPassGate` /
 *   `alwaysRefuseGate` below). A battery that only ever sees the real gate
 *   cannot tell a working gate from a rubber stamp.
 * · Assertions name the RULE, never a spelling: the refusal battery asserts
 *   WHICH REQUIREMENT refused (the imported `GateRequirement` union), never the
 *   English of the message, so a reworded refusal does not fail the proof and a
 *   renamed requirement fails it loudly.
 * · Denominator and blind spots are printed beside the numbers at the end.
 *
 * The behavioural half runs against an INJECTED fake PostgREST client rather
 * than the live database, so a refused read can be produced on demand — the only
 * way to prove the fail-closed branch, which is the branch the lane exists for.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { stripComments } from "./strip-comments"
import {
  assertListingActivationAllowed,
  type GateRequirement,
  type ListingActivationGateResult,
} from "../lib/listings/listing-activation-gate"
import { LISTING_AGREEMENT_PARTIES } from "../lib/compliance/signature-completeness"
import {
  SELLER_SIDE_CLASSIFICATIONS,
  classificationCarriesSignatures,
} from "../lib/compliance/document-classifications"
import { LISTING_AGREEMENT_EXECUTED_STATUS } from "../lib/transactions/coordination-status"
import { LISTING_LIFECYCLE_STAGES } from "../lib/listing-lifecycle/lifecycle-definitions"
import { LIVE_TABLES } from "./live-tables"

// Repo root. `process.cwd()` rather than `__dirname` — this file is loaded as an
// ES module (no __dirname), and it is the form the sibling simulators use.
const ROOT = process.cwd()

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(resolve(ROOT, p)) ? stripComments(readFileSync(resolve(ROOT, p), "utf8")) : "")
const raw = (p: string) => (existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), "utf8") : "")

const F = {
  gate:     "lib/listings/listing-activation-gate.ts",
  engine:   "app/actions/seller-listing/execution-engine.ts",
  kernel:   "lib/kernel/listings.ts",
  action:   "app/actions/listings-kernel.ts",
  defs:     "lib/listing-lifecycle/lifecycle-definitions.ts",
  readiness:"lib/listing-lifecycle/readiness-checker.ts",
  txGate:   "lib/transactions/transaction-creation-gate.ts",
}

// ═══════════════════════════════════════════════════════════════════════════
// A fake PostgREST client. Chainable, filterable, and able to REFUSE.
// Modelled on scripts/transaction-creation-gate-simulator.ts's client so the
// two gates are proved against the same client semantics.
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
          const m = path.match(/^(\w+)->>(\w+)$/)
          if (m) rows = rows.filter(r => (r[m[1]] ?? {})[m[2]] === val)
          return b
        },
        or: (expr: string) => {
          const clauses = expr.split(",").map(c => c.split("."))
          rows = rows.filter(r => clauses.some(([col, op, v]) => op === "eq" && String(r[col]) === v))
          return b
        },
        maybeSingle: async () => (err ? { data: null, error: err } : { data: rows[0] ?? null, error: null }),
        single:      async () => (err ? { data: null, error: err } : { data: rows[0] ?? null, error: null }),
        then: (resolveP: any, rejectP: any) =>
          Promise.resolve(err ? { data: null, error: err } : { data: rows, error: null }).then(resolveP, rejectP),
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
const LISTING   = "22222222-2222-4222-8222-222222222222"
const SELLER    = "33333333-3333-4333-8333-333333333333"
const AGENT_U   = "44444444-4444-4444-8444-444444444444"
const AGENT_REC = "55555555-5555-4555-8555-555555555555"
const OTHER_BRK = "66666666-6666-4666-8666-666666666666"

/**
 * THE FIXTURE CLASSIFICATIONS ARE DERIVED FROM THE VOCABULARY, NOT TYPED OUT
 * (CLAUDE.md §2 — assert the RULE and derive the value).
 *
 * The first draft of this file hardcoded "property_disclosure", which is not a
 * member of the vocabulary at all — the seller-side spelling is "disclosure" —
 * and, not being signature-bearing, it was skipped by findUnexecutedDocuments.
 * Three signature/initial cases therefore came back ALLOWED and the proof
 * reported the gate as broken when the FIXTURE was. Deriving both values from
 * the live vocabulary means a renamed or re-scoped classification changes these
 * fixtures with it instead of quietly making the battery test nothing.
 */
const SELLER_SIGNING_CLASSES = SELLER_SIDE_CLASSIFICATIONS
  .filter(c => classificationCarriesSignatures(c))
/** Two seller-side, SIGNATURE-BEARING classifications — what the battery gates on. */
const SIG_A = SELLER_SIGNING_CLASSES[0]
const SIG_B = SELLER_SIGNING_CLASSES[1]
/** A seller-side classification that carries NO signatures — presence-only. */
const NONSIG = SELLER_SIDE_CLASSIFICATIONS.find(c => !classificationCarriesSignatures(c))

/** Both required parties signed AND initialed. */
const fullyExecuted = () => ({
  signatures: LISTING_AGREEMENT_PARTIES.map(p => ({ signer_role: p, signed: true })),
  initials:   LISTING_AGREEMENT_PARTIES.map(p => ({ signer_role: p, all_required_initials_present: true })),
})
/** Signed by everyone, but the seller's initials are outstanding. */
const signedNotInitialed = () => ({
  signatures: LISTING_AGREEMENT_PARTIES.map(p => ({ signer_role: p, signed: true })),
  initials:   [{ signer_role: "agent", all_required_initials_present: true }],
})
/** Initialed by everyone, but the seller never signed. */
const initialedNotSigned = () => ({
  signatures: [{ signer_role: "agent", signed: true }],
  initials:   LISTING_AGREEMENT_PARTIES.map(p => ({ signer_role: p, all_required_initials_present: true })),
})

const listingRow = (over: Row = {}) => ({
  id: LISTING, brokerage_id: BROKERAGE, agent_id: AGENT_REC,
  seller_contact_id: SELLER, contact_id: null, state: "TX", ...over,
})
const goodAgreement = (over: Row = {}) => ({
  id: "la-1", listing_id: LISTING, brokerage_id: BROKERAGE,
  compliance_passed: true, esign_status: LISTING_AGREEMENT_EXECUTED_STATUS,
  fully_executed_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", ...over,
})
const requiredDoc = (classification: string, blocking = true) => ({
  brokerage_id: BROKERAGE, classification, scope_type: "brokerage", scope_id: BROKERAGE,
  is_required: true, block_on_missing: blocking, description: null,
  deal_type: "seller", state_code: null, template_form_id: null,
})
const docRow = (classification: string, sc: unknown, over: Row = {}) => ({
  id: `doc-${classification}`, brokerage_id: BROKERAGE, listing_id: LISTING,
  contact_id: SELLER, classification, signature_completeness: sc,
  status: "complete", metadata: {}, ...over,
})

/** The all-good world: agreement executed + compliance passed, both required
 *  documents present and fully executed by agent + seller. */
function cleanDb(over: Partial<FakeDb> = {}): FakeDb {
  return {
    tables: {
      listings:  [listingRow()],
      agents:    [{ id: AGENT_REC, user_id: AGENT_U }],
      users:     [{ id: AGENT_U, team_id: null }],
      listing_agreements: [goodAgreement()],
      brokerage_required_documents: [
        requiredDoc(SIG_A),
        requiredDoc(SIG_B),
      ],
      documents: [
        docRow(SIG_A, fullyExecuted()),
        docRow(SIG_B, fullyExecuted()),
      ],
      ...(over.tables ?? {}),
    },
    refuse: over.refuse,
  }
}

const runGate = (db: FakeDb, over: Row = {}) =>
  assertListingActivationAllowed(makeClient(db), {
    brokerageId: BROKERAGE, listingId: LISTING, door: "test", ...over,
  })

/** Which requirements refused, as a sorted set — the RULE, not the wording. */
const reqs = (r: ListingActivationGateResult): GateRequirement[] =>
  Array.from(new Set(r.refusals.map(x => x.requirement))).sort() as GateRequirement[]

// ═══════════════════════════════════════════════════════════════════════════
// THE BEHAVIOURAL BATTERY — run against the real gate AND against two
// deliberately-broken stand-ins, so a battery that cannot tell them apart is
// itself caught. This is the brief's "a gate that always passes and a gate that
// always refuses must both be caught".
// ═══════════════════════════════════════════════════════════════════════════

type GateFn = (db: FakeDb, over?: Row) => Promise<ListingActivationGateResult>

const alwaysPassGate: GateFn = async () => ({
  allowed: true, refusals: [], reason: "rubber stamp",
  detail: {
    complianceState: "passed", requiredTotal: 0, missingRequired: [], unexecuted: [],
    missingWarning: [], complianceEvidence: [], checkedAt: new Date().toISOString(),
  },
})
const alwaysRefuseGate: GateFn = async () => ({
  allowed: false,
  refusals: [{ requirement: "gate_could_not_run", message: "brick wall" }],
  reason: "brick wall",
  detail: {
    complianceState: "unknown", requiredTotal: null, missingRequired: [], unexecuted: [],
    missingWarning: [], complianceEvidence: [], checkedAt: new Date().toISOString(),
  },
})

interface Case {
  id: string
  what: string
  db: () => FakeDb
  over?: Row
  /** null = must be ALLOWED. Otherwise the exact set of refusing requirements. */
  expect: GateRequirement[] | null
}

const CASES: Case[] = [
  {
    id: "clean-file-passes",
    what: "a listing whose agreement is compliance-passed and whose required documents are all present and fully executed is ALLOWED (the gate is not a brick wall)",
    db: () => cleanDb(), expect: null,
  },
  {
    id: "no-agreement-refuses",
    what: "a listing with NO listing agreement on file refuses compliance_good — no evidence is never a pass",
    db: () => cleanDb({ tables: { ...cleanDb().tables, listing_agreements: [] } }),
    expect: ["compliance_good"],
  },
  {
    id: "agreement-not-compliance-passed-refuses",
    what: "an agreement that exists but never passed compliance refuses compliance_good",
    db: () => cleanDb({ tables: { ...cleanDb().tables, listing_agreements: [goodAgreement({ compliance_passed: false })] } }),
    expect: ["compliance_good"],
  },
  {
    id: "agreement-not-fully-signed-refuses",
    what: "an agreement stuck at partially_signed refuses compliance_good even with compliance_passed true",
    db: () => cleanDb({ tables: { ...cleanDb().tables, listing_agreements: [goodAgreement({ esign_status: "partially_signed" })] } }),
    expect: ["compliance_good"],
  },
  {
    id: "agreement-never-executed-refuses",
    what: "an agreement with no fully_executed_at refuses compliance_good — a stamp without its execution is a half-stamped gate",
    db: () => cleanDb({ tables: { ...cleanDb().tables, listing_agreements: [goodAgreement({ fully_executed_at: null })] } }),
    expect: ["compliance_good"],
  },
  {
    id: "missing-required-document-refuses",
    what: "a blocking required document absent from the file refuses required_documents_present",
    db: () => cleanDb({ tables: { ...cleanDb().tables, documents: [docRow(SIG_A, fullyExecuted())] } }),
    expect: ["required_documents_present"],
  },
  {
    id: "warning-document-does-not-block",
    what: "a NON-blocking (warning) requirement missing does NOT refuse — the required-vs-warning SETTING is honoured",
    db: () => cleanDb({ tables: {
      ...cleanDb().tables,
      brokerage_required_documents: [requiredDoc(SIG_A), requiredDoc(SIG_B, false)],
      documents: [docRow(SIG_A, fullyExecuted())],
    } }),
    expect: null,
  },
  {
    id: "unsigned-document-refuses-signatures-only",
    what: "a present document missing a SIGNATURE refuses documents_fully_signed and NOT initials_complete",
    db: () => cleanDb({ tables: { ...cleanDb().tables, documents: [
      docRow(SIG_A, fullyExecuted()),
      docRow(SIG_B, initialedNotSigned()),
    ] } }),
    expect: ["documents_fully_signed"],
  },
  {
    id: "uninitialed-document-refuses-initials-only",
    what: "a fully SIGNED document with an outstanding INITIAL refuses initials_complete and NOT documents_fully_signed — the owner names them separately",
    db: () => cleanDb({ tables: { ...cleanDb().tables, documents: [
      docRow(SIG_A, fullyExecuted()),
      docRow(SIG_B, signedNotInitialed()),
    ] } }),
    expect: ["initials_complete"],
  },
  {
    id: "unscanned-document-refuses-both",
    what: "a required document with NO signature_completeness at all refuses BOTH — absence is not consent",
    db: () => cleanDb({ tables: { ...cleanDb().tables, documents: [
      docRow(SIG_A, fullyExecuted()),
      docRow(SIG_B, null),
    ] } }),
    expect: ["documents_fully_signed", "initials_complete"],
  },
  {
    id: "refused-checklist-read-fails-closed",
    what: "a REFUSED brokerage_required_documents read refuses gate_could_not_run — supabase-js resolves refusals, and 'nobody checked' must not read as 'checked and fine'",
    db: () => cleanDb({ refuse: { brokerage_required_documents: "permission denied for table brokerage_required_documents" } }),
    expect: ["gate_could_not_run"],
  },
  {
    id: "refused-documents-read-fails-closed",
    what: "a REFUSED documents read refuses gate_could_not_run rather than reporting an empty, clean file",
    db: () => cleanDb({ refuse: { documents: "permission denied for table documents" } }),
    expect: ["gate_could_not_run"],
  },
  {
    id: "refused-agreement-read-fails-closed",
    what: "a REFUSED listing_agreements read refuses gate_could_not_run rather than reading as 'no agreement'",
    db: () => cleanDb({ refuse: { listing_agreements: "permission denied for table listing_agreements" } }),
    expect: ["gate_could_not_run"],
  },
  {
    id: "refused-listing-read-fails-closed",
    what: "a REFUSED listings read refuses gate_could_not_run",
    db: () => cleanDb({ refuse: { listings: "permission denied for table listings" } }),
    expect: ["gate_could_not_run"],
  },
  {
    id: "cross-tenant-listing-refuses",
    what: "a listing belonging to ANOTHER brokerage refuses gate_could_not_run — the gate re-reads the row's own brokerage_id and will not walk another tenant's file",
    db: () => cleanDb({ tables: { ...cleanDb().tables, listings: [listingRow({ brokerage_id: OTHER_BRK })] } }),
    expect: ["gate_could_not_run"],
  },
  {
    id: "missing-tenant-anchor-refuses",
    what: "no brokerage on the session refuses gate_could_not_run — a gate that cannot run must refuse, not pass",
    db: () => cleanDb(), over: { brokerageId: "" },
    expect: ["gate_could_not_run"],
  },
  {
    id: "invalid-listing-id-refuses",
    what: "a malformed listing id refuses gate_could_not_run",
    db: () => cleanDb(), over: { listingId: "not-a-uuid" },
    expect: ["gate_could_not_run"],
  },
  {
    id: "empty-checklist-is-not-a-refusal",
    what: "a brokerage that has configured NO checklist is allowed (a read that RAN and returned zero rows is a different fact from a refused read) — and requiredTotal says 0 so a surface can tell them apart",
    db: () => cleanDb({ tables: { ...cleanDb().tables, brokerage_required_documents: [], documents: [] } }),
    expect: null,
  },
  {
    id: "buyer-parties-would-refuse-everything",
    what: "the LISTING parties are agent+seller: a file executed by agent+seller PASSES, which it could not if the purchase-contract default (buyer+seller) were used",
    db: () => cleanDb(), expect: null,
  },
]

async function runBattery(gate: GateFn, label: string): Promise<{ ok: number; bad: string[] }> {
  let ok = 0
  const bad: string[] = []
  for (const c of CASES) {
    let r: ListingActivationGateResult
    try { r = await gate(c.db(), c.over ?? {}) }
    catch (e: any) { bad.push(`${c.id}: threw ${e?.message}`); continue }
    const got = reqs(r)
    const want = c.expect
    const good = want === null
      ? r.allowed === true && got.length === 0
      : r.allowed === false && got.join(",") === [...want].sort().join(",")
    if (good) ok++
    else bad.push(`${c.id}: expected ${want === null ? "ALLOWED" : `refusals[${[...want].sort().join(",")}]`}, got ${r.allowed ? "ALLOWED" : `refusals[${got.join(",")}]`}`)
  }
  void label
  return { ok, bad }
}

// ═══════════════════════════════════════════════════════════════════════════
// SOURCE assertions + their mutations (each mutation MUST flip its assertion)
// ═══════════════════════════════════════════════════════════════════════════

interface SourceAssertion {
  id: string
  what: string
  run: () => { ok: boolean; detail?: string }
  breaks: Array<{ file: string; find: string; replace: string }>
}

const SOURCE: SourceAssertion[] = [
  {
    id: "activateMLS-runs-the-gate-before-it-transitions",
    what: "activateMLS calls assertListingActivationAllowed and REFUSES on it, and does so BEFORE transitionLifecycle",
    run: () => {
      const s = src(F.engine)
      const gateAt = s.indexOf("assertListingActivationAllowed(")
      if (gateAt < 0) return { ok: false, detail: "activateMLS does not call the gate" }
      const fnAt = s.indexOf("export async function activateMLS")
      if (fnAt < 0) return { ok: false, detail: "activateMLS not found" }
      const body = s.slice(fnAt, fnAt + 4000)
      if (!/assertListingActivationAllowed\(/.test(body)) return { ok: false, detail: "the gate call is not inside activateMLS" }
      if (!/complianceGate\.allowed/.test(body)) return { ok: false, detail: "the verdict is computed and never read" }
      const g = body.indexOf("assertListingActivationAllowed(")
      const t = body.indexOf("transitionLifecycle(")
      if (t >= 0 && g > t) return { ok: false, detail: "the gate runs AFTER the transition" }
      return { ok: true }
    },
    breaks: [
      // RE-ANCHORED 2026-09-05: the find string used to include the block's first three inner
      // lines, so wiring the compliance-loop notification INSIDE the refusal block (a change
      // that made the door strictly better) stopped the mutation applying and the theatre
      // detector went red. The rule this mutation breaks is the CONDITION — flip it and the
      // gate is decorative — so only the condition line is matched now.
      { file: F.engine, find: `  if (!complianceGate.allowed) {`, replace: `  if (false) {` },
    ],
  },
  {
    id: "launchListing-runs-the-gate",
    what: "launchListing — the door that writes status:'active' directly — calls the gate and refuses on it",
    run: () => {
      const s = src(F.kernel)
      const fnAt = s.indexOf("export async function launchListing")
      if (fnAt < 0) return { ok: false, detail: "launchListing not found" }
      const body = s.slice(fnAt, fnAt + 4000)
      if (!/assertListingActivationAllowed/.test(body)) return { ok: false, detail: "launchListing does not call the gate" }
      if (!/complianceGate\.allowed/.test(body)) return { ok: false, detail: "the verdict is computed and never read" }
      const g = body.indexOf("assertListingActivationAllowed")
      const w = body.indexOf(`status:          "active"`)
      if (w >= 0 && g > w) return { ok: false, detail: "the gate runs AFTER the active write" }
      return { ok: true }
    },
    breaks: [
      { file: F.kernel, find: `    if (!complianceGate.allowed) {`, replace: `    if (false) {` },
    ],
  },
  {
    id: "launch-action-passes-the-session-brokerage",
    what: "launchListingAction hands launchListing the SESSION's brokerage (CLAUDE.md §4), not a request body's",
    run: () => {
      const s = src(F.action)
      if (!/launchListing\(\{[\s\S]{0,400}?brokerageId:\s*ctx\.brokerageId/.test(s)) {
        return { ok: false, detail: "the session brokerage is not passed to launchListing" }
      }
      return { ok: true }
    },
    breaks: [
      { file: F.action, find: `    brokerageId: ctx.brokerageId,\n  })`, replace: `  })` },
    ],
  },
  {
    id: "mls-active-declares-documents-verified",
    what: "the MLS_ACTIVE stage declares documents_verified, so the generic stage-advance path cannot walk a listing live around the gate",
    run: () => {
      // The RUNTIME table is the rule — what the system enforces, not how the
      // file is spelled. But the runtime module is imported once at load, so a
      // file mutation cannot flip a runtime-only assertion (the first draft's
      // negative control silently "did not flip", which is exactly the theatre
      // §2 warns about). So SOURCE and RUNTIME are BOTH read and required to
      // AGREE: mutating the file makes them disagree and the assertion fails.
      const def = LISTING_LIFECYCLE_STAGES.find(s => s.stage === "MLS_ACTIVE")
      if (!def) return { ok: false, detail: "MLS_ACTIVE is not in the stage table" }
      if (!def.readinessChecks.includes("documents_verified" as never)) {
        return { ok: false, detail: `runtime MLS_ACTIVE declares [${def.readinessChecks.join(", ")}]` }
      }
      const s = src(F.defs)
      const block = s.slice(s.indexOf(`stage: "MLS_ACTIVE"`))
      const m = block.match(/readinessChecks:\s*\[([^\]]*)\]/)
      if (!m) return { ok: false, detail: "could not parse MLS_ACTIVE.readinessChecks from source" }
      const parsed = Array.from(m[1].matchAll(/"([^"]+)"/g)).map(x => x[1])
      if (parsed.join(",") !== def.readinessChecks.join(",")) {
        return { ok: false, detail: `source [${parsed.join(", ")}] disagrees with runtime [${def.readinessChecks.join(", ")}]` }
      }
      return { ok: true, detail: `MLS_ACTIVE requires [${def.readinessChecks.join(", ")}]` }
    },
    breaks: [
      { file: F.defs, find: `    readinessChecks: ["mls_data_complete", "documents_verified"],`, replace: `    readinessChecks: ["mls_data_complete"],` },
    ],
  },
  {
    id: "documents-verified-checks-execution-not-just-presence",
    what: "checkDocumentsVerified runs findUnexecutedDocuments, so a check named documents_verified no longer overstates what it verified",
    run: () => {
      const s = src(F.readiness)
      const fnAt = s.indexOf("async function checkDocumentsVerified")
      if (fnAt < 0) return { ok: false, detail: "checkDocumentsVerified not found" }
      const body = s.slice(fnAt, fnAt + 6000)
      if (!/findUnexecutedDocuments\(/.test(body)) return { ok: false, detail: "no execution check" }
      // The token must reach the CALL, not merely the import line. Testing for
      // the bare token passed even with the argument deleted, because the
      // dynamic `import { LISTING_AGREEMENT_PARTIES }` still mentions it — the
      // first draft's negative control caught exactly that.
      if (!/findUnexecutedDocuments\([\s\S]{0,300}?LISTING_AGREEMENT_PARTIES/.test(body)) {
        return { ok: false, detail: "the listing parties are not passed to the call — the buyer default would refuse every listing" }
      }
      if (!/unexecuted\.length === 0/.test(body)) return { ok: false, detail: "the execution verdict does not affect `passed`" }
      return { ok: true }
    },
    breaks: [
      { file: F.readiness, find: `      unexecuted.length === 0 &&`, replace: `      true &&` },
      { file: F.readiness, find: `        LISTING_AGREEMENT_PARTIES,\n      )`, replace: `      )` },
    ],
  },
  {
    id: "gate-passes-the-listing-parties-explicitly",
    what: "the gate passes LISTING_AGREEMENT_PARTIES to findUnexecutedDocuments rather than taking the purchase-contract default",
    run: () => {
      const s = src(F.gate)
      if (!/findUnexecutedDocuments\([\s\S]{0,200}?LISTING_AGREEMENT_PARTIES/.test(s)) {
        return { ok: false, detail: "the listing parties are not passed" }
      }
      return { ok: true }
    },
    breaks: [
      { file: F.gate, find: `    LISTING_AGREEMENT_PARTIES,\n  )`, replace: `  )` },
    ],
  },
  {
    id: "gate-reuses-the-transaction-vocabulary",
    what: "the verdict vocabulary is IMPORTED from the transaction gate, not re-declared — the owner ruled these are the SAME gate (§6)",
    run: () => {
      const s = src(F.gate)
      if (/^\s*export type GateRequirement\s*=/m.test(s)) {
        return { ok: false, detail: "GateRequirement is re-declared here instead of imported" }
      }
      if (!/from "@\/lib\/transactions\/transaction-creation-gate"/.test(s)) {
        return { ok: false, detail: "nothing is imported from the transaction gate" }
      }
      if (!/findUnexecutedDocuments/.test(s)) return { ok: false, detail: "the shared executor is not used" }
      return { ok: true }
    },
    breaks: [
      { file: F.gate, find: `import {\n  findUnexecutedDocuments,`, replace: `export type GateRequirement = "x"\nimport {\n  findUnexecutedDocuments,` },
    ],
  },
  {
    id: "gate-reads-every-error",
    what: "every supabase read in the gate destructures and READS its error — supabase-js RESOLVES refusals (§3)",
    run: () => {
      const s = src(F.gate)
      const selects = (s.match(/await supabase\s*\n?\s*\.from\(/g) ?? []).length
      const errChecks = (s.match(/if \(\w*[Ee]rr\w*\) return/g) ?? []).length
      if (selects === 0) return { ok: false, detail: "no reads found — the scanner is blind" }
      if (errChecks < selects) return { ok: false, detail: `${selects} reads but only ${errChecks} error branches` }
      return { ok: true, detail: `${selects} reads, ${errChecks} error branches` }
    },
    breaks: [
      { file: F.gate, find: `  if (error) return { ok: false, error: \`listing could not be read: \${error.message}\` }`, replace: `  if (false) return { ok: false, error: "" }` },
    ],
  },
  {
    id: "the-tables-the-gate-reads-are-live",
    what: "every table the gate names exists in the generated LIVE_TABLES cache — a retired name must not sit here reading as enforced (§2)",
    run: () => {
      const s = src(F.gate)
      const named = Array.from(new Set(Array.from(s.matchAll(/\.from\("([a-z_]+)"\)/g)).map(m => m[1])))
      if (named.length === 0) return { ok: false, detail: "no .from() found — the scanner is blind" }
      const live = LIVE_TABLES as unknown as string[]
      const dead = named.filter(t => !live.includes(t))
      if (dead.length > 0) return { ok: false, detail: `not live: ${dead.join(", ")}` }
      return { ok: true, detail: `${named.length} tables, all live: ${named.join(", ")}` }
    },
    breaks: [
      { file: F.gate, find: `    .from("listing_agreements")`, replace: `    .from("open_houses_retired")` },
    ],
  },
]

// ═══════════════════════════════════════════════════════════════════════════
// BLINDNESS CONTROL — this file's own header and the gate's header quote the
// call shapes the scans above search for. Prove the scans read STRIPPED source,
// or every assertion here would pass forever on prose alone (CLAUDE.md §2).
// ═══════════════════════════════════════════════════════════════════════════
function blindnessControl(): { ok: boolean; detail: string } {
  const rawGate = raw(F.gate)
  const strippedGate = src(F.gate)
  // The gate's header names findUnexecutedDocuments and LISTING_AGREEMENT_PARTIES
  // in prose. Those mentions MUST be gone from the stripped text's comments.
  const rawMentions = (rawGate.match(/findUnexecutedDocuments/g) ?? []).length
  const strippedMentions = (strippedGate.match(/findUnexecutedDocuments/g) ?? []).length
  if (rawMentions <= strippedMentions) {
    return { ok: false, detail: `raw ${rawMentions} vs stripped ${strippedMentions} — the header no longer mentions it, so this control proves nothing` }
  }
  // And the stripper must not have eaten the live call.
  if (!/findUnexecutedDocuments\(/.test(strippedGate)) {
    return { ok: false, detail: "the stripper removed the live call — the scanner would accuse live code of being absent" }
  }
  return { ok: true, detail: `raw mentions ${rawMentions} → stripped ${strippedMentions}; the live call survives` }
}

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log("\n═══ LISTING ACTIVATION COMPLIANCE GATE ".padEnd(70, "═"))
  console.log("Owner (2026-09-04): \"same compliance gate when a listing becomes an active listing.\"\n")

  console.log("─── SOURCE — the gate is wired into every door ".padEnd(70, "─"))
  for (const a of SOURCE) {
    const r = a.run()
    check(`${a.id}${r.detail ? ` (${r.detail})` : ""}`, r.ok, r.detail)
  }

  console.log("\n─── BLINDNESS CONTROL — the scans read stripped source ".padEnd(70, "─"))
  const bc = blindnessControl()
  check(`comment-stripping is load-bearing (${bc.detail})`, bc.ok)

  console.log("\n─── BEHAVIOUR — the four obligations, against an injected client ".padEnd(70, "─"))
  const real = await runBattery(runGate, "real")
  for (const c of CASES) {
    const bad = real.bad.find(b => b.startsWith(`${c.id}:`))
    check(c.what, !bad, bad)
  }

  console.log("\n─── NEGATIVE CONTROLS — the battery can tell a real gate from a fake ".padEnd(70, "─"))
  const passer = await runBattery(alwaysPassGate, "always-pass")
  const refuser = await runBattery(alwaysRefuseGate, "always-refuse")
  check(
    `an ALWAYS-PASS gate is caught (${passer.bad.length} of ${CASES.length} cases fail it)`,
    passer.bad.length > 0,
  )
  check(
    `an ALWAYS-REFUSE gate is caught (${refuser.bad.length} of ${CASES.length} cases fail it)`,
    refuser.bad.length > 0,
  )
  // A battery that only catches one direction is half a battery.
  check(
    "the always-pass gate is caught on REFUSAL cases specifically (not merely on the happy path)",
    passer.bad.some(b => /expected refusals/.test(b)),
  )
  check(
    "the always-refuse gate is caught on ALLOWED cases specifically",
    refuser.bad.some(b => /expected ALLOWED/.test(b)),
  )

  console.log("\n─── NEGATIVE — every source assertion is broken on purpose ".padEnd(70, "─"))
  let negPass = 0, negFail = 0
  const negProblems: string[] = []
  for (const a of SOURCE) {
    if (a.breaks.length === 0) {
      negFail++; negProblems.push(`${a.id}: has NO negative test`)
      console.log(`  ✘ ${a.id}  no negative test defined`)
      continue
    }
    for (let bi = 0; bi < a.breaks.length; bi++) {
      const b = a.breaks[bi]
      const path = resolve(ROOT, b.file)
      const before = readFileSync(path, "utf8")
      const digestBefore = createHash("sha256").update(before).digest("hex")
      const after = before.replace(b.find as never, b.replace)
      // THEATRE DETECTOR — a replace that matched nothing leaves the file
      // untouched and the assertion would "fail to fail" for the wrong reason.
      if (after === before) {
        negFail++
        negProblems.push(`${a.id}[${bi}]: the mutation DID NOT APPLY (find string no longer matches ${b.file})`)
        console.log(`  ✘ ${a.id}[${bi}]  mutation did not apply — theatre, fix the find string`)
        continue
      }
      writeFileSync(path, after, "utf8")
      let broke = false, detail = ""
      try { const r = a.run(); broke = !r.ok; detail = r.detail ?? "" }
      catch { broke = true }
      finally { writeFileSync(path, before, "utf8") }
      const restored = createHash("sha256").update(readFileSync(path)).digest("hex") === digestBefore
      if (broke && restored) { negPass++; console.log(`  ✔ ${a.id}[${bi}]  broke as expected, file restored (sha256 verified)`) }
      else {
        negFail++
        if (!broke) negProblems.push(`${a.id}[${bi}]: still PASSED with the defect reintroduced`)
        if (!restored) negProblems.push(`${a.id}[${bi}]: FILE NOT RESTORED (${b.file})`)
        console.log(`  ✘ ${a.id}[${bi}]  ${!broke ? "did NOT flip to failure" : ""}${!restored ? " FILE NOT RESTORED" : ""}${detail ? ` (${detail})` : ""}`)
      }
    }
  }

  // ── DENOMINATOR + BLIND SPOTS (CLAUDE.md §2) ──────────────────────────────
  console.log(`\n${"═".repeat(70)}`)
  console.log(` SOURCE + BEHAVIOUR     ${pass} passed, ${fail} failed`)
  console.log(` NEGATIVE (source)      ${negPass} flipped to failure as required, ${negFail} did not`)
  console.log(` DENOMINATOR            ${SOURCE.length} source assertions · ${CASES.length} behavioural cases ×`)
  console.log(`                        3 gates (real, always-pass, always-refuse) = ${CASES.length * 3} gate runs`)
  console.log(`                        doors covered: activateMLS, launchListing, generic stage advance (3 of 3 found)`)
  console.log(` BLIND SPOTS`)
  console.log(`   · NO LIVE DATABASE. This lane may not query hrvaqgvukzxfskkcrwbt, so every`)
  console.log(`     behavioural case runs against an injected fake client. The client mimics`)
  console.log(`     PostgREST filter semantics but NOT RLS: a policy that refuses a read in`)
  console.log(`     production is simulated by the \`refuse\` map, never observed.`)
  console.log(`   · HOW MANY LIVE LISTINGS THIS REFUSES IS UNMEASURED — see the report's blast`)
  console.log(`     radius section for the exact SQL the integrator must run.`)
  console.log(`   · The gate is proved as a FUNCTION. That activateMLS/launchListing are the`)
  console.log(`     only doors is proved by source scan over the tree, not by runtime tracing;`)
  console.log(`     a door added in a file this scan does not read would not be seen.`)
  console.log(`   · compliance_good rests on listing_agreements. There is NO listing-side`)
  console.log(`     open-flag ledger (notifyComplianceFlag writes notifications, which carry no`)
  console.log(`     open/resolved lifecycle), so the offer side's "still-open flag" arm has no`)
  console.log(`     counterpart here. Recorded as an owner question, not guessed at.`)
  console.log("═".repeat(70))

  if (negProblems.length) {
    console.log("\nNegative-layer problems:")
    for (const p of negProblems) console.log(`  · ${p}`)
  }
  if (fails.length) {
    console.log("\nFailures:")
    for (const f of fails) console.log(`  · ${f}`)
  }

  const ok = fail === 0 && negFail === 0
  console.log(ok ? "\n✅ LISTING_ACTIVATION_GATE_PASS" : "\n❌ LISTING_ACTIVATION_GATE_FAIL")
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
