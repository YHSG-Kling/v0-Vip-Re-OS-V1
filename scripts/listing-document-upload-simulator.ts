#!/usr/bin/env tsx
/**
 * scripts/listing-document-upload-simulator.ts (npm run test:listing-doc-upload)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AGENT CAN FILE THE SIGNED PAPERWORK, AND FILING IT IS WHAT TAKES THE
 * LISTING ON.
 *
 * Owner: "there should still be an option to upload completed docs."
 *
 * A listing opens as a draft and is taken on only when the agreement is signed
 * and compliance has reviewed every required document, initial and signature.
 * That gate reads documents the scanner has classified — so somebody has to be
 * able to put the signed paperwork in. FOUR THINGS STOPPED THAT, and every one
 * of them was silent.
 *
 * 1. NOTHING COULD NAME A LISTING AGREEMENT. app/actions/documents.ts guards on
 *    `classification.document_type === "listing_agreement"` — while its own
 *    classifier prompt offers a fixed enum that does not contain it. The
 *    universal scanner was no better: it declared its OWN 18-value
 *    DocumentClassification union, also without listing_agreement, and folded
 *    anything outside that list to "other". So the branch that fires the gate
 *    was unreachable from every direction, and the required-document preset
 *    demanding a listing_agreement could never be satisfied.
 *
 * 2. THE AUDIT MATCHED A KEY NOBODY WRITES. auditListingDocuments looked up
 *    listing-filed documents on `metadata->>linked_listing_id`. The uploader
 *    writes the `listing_id` COLUMN. Verified live on a real filed agreement:
 *    the old lookup found 0 rows, the column lookup found 1.
 *
 * 3. THERE WAS NO AGENT UPLOAD AT ALL. The only uploader in the product was the
 *    client portal's dialog — rendered for the SELLER, writing `client_documents`
 *    while the audit reads `documents`. The agent who runs the appointment and
 *    walks out holding the signed agreement had nowhere to file it.
 *
 * 4. THE GATE LIVED ON THE WRONG PATH. The rule was written inside
 *    processDocumentWithAI, which classifies into the wrong vocabulary and
 *    writes the table the audit does not read. It now lives in
 *    lib/documents/listing-agreement-gate.ts, called from the scanner that runs
 *    on the uploads that matter.
 *
 * The execution predicate is exercised for real below — it is client-safe
 * precisely so this proof can call it rather than pattern-match its source.
 */
import { readFileSync, existsSync } from "node:fs"
import {
  evaluateExecution,
  LISTING_AGREEMENT_PARTIES,
} from "../lib/compliance/signature-completeness"
import { ALL_DOCUMENT_CLASSIFICATIONS } from "../lib/compliance/document-classifications"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
/** Comments stripped so this file's own prose cannot satisfy an assertion. */
const src = (p: string) =>
  existsSync(p)
    ? stripComments(readFileSync(p, "utf8"))
    : ""

const SCANNER = src("lib/documents/scan-uploaded-document.ts")
const GATE    = src("lib/documents/listing-agreement-gate.ts")
const AUDIT   = src("lib/compliance/required-documents.ts")
const ROUTE   = src("app/api/listings/[listingId]/upload-document/route.ts")
const PANEL   = src("app/components/dashboard/listings/lifecycle/completed-documents-panel.tsx")
const PAGE    = src("app/dashboard/listings/[id]/lifecycle/page.tsx")
const READS   = src("app/actions/listing-documents.ts")

console.log("\n── a listing agreement can finally be named ──")
{
  check("the canonical taxonomy carries listing_agreement",
    ALL_DOCUMENT_CLASSIFICATIONS.includes("listing_agreement"))
  check("…and the seller-side companions",
    ALL_DOCUMENT_CLASSIFICATIONS.includes("seller_broker_agreement") &&
    ALL_DOCUMENT_CLASSIFICATIONS.includes("preliminary_closing_statement"))

  // THE DEFECT: a second, shorter copy of the taxonomy that silently folded
  // everything it had not heard of into "other".
  check("the scanner no longer declares its own copy of the taxonomy",
    !/export type DocumentClassification =\s*\n\s*\| "pre_approval_letter"/.test(SCANNER))
  check("…it imports the canonical one",
    /import \{[\s\S]{0,120}?ALL_DOCUMENT_CLASSIFICATIONS[\s\S]{0,120}?\} from "@\/lib\/compliance\/document-classifications"/.test(SCANNER))
  check("…and the accept-list IS that vocabulary, not a hand-written twin",
    /const CLASSIFICATIONS: DocumentClassification\[\] = ALL_DOCUMENT_CLASSIFICATIONS/.test(SCANNER))
  check("the prompt offers the list it is generated from",
    /\$\{ALL_DOCUMENT_CLASSIFICATIONS\.join\(" \| "\)\}/.test(SCANNER))
  check("…and asks for the seller-side fields the gate needs",
    /listing_agreement\s+→ \{ property_address/.test(SCANNER))
}

console.log("\n── the signature verdict is recorded, and absence never means signed ──")
{
  check("the scanner asks for per-role signatures AND initials",
    /"signature_completeness"/.test(SCANNER) && /all_required_initials_present/.test(SCANNER))
  check("…and stores it as its own fact, not inside extracted_fields",
    /signature_completeness:\s*signatureCompleteness/.test(SCANNER))
  check("…defaulting to NULL when the answer is unusable",
    /signatureCompleteness =\s*\n?\s*result\.signature_completeness && typeof result\.signature_completeness === "object"/.test(SCANNER))

  // THE PREDICATE, RUN FOR REAL — this is the rule a listing goes live on.
  const fullyExecuted = {
    signatures: [
      { signer_role: "agent",  signed: true },
      { signer_role: "seller", signed: true },
    ],
    initials: [
      { signer_role: "agent",  all_required_initials_present: true },
      { signer_role: "seller", all_required_initials_present: true },
    ],
  }
  check("both parties signed and initialed → executed",
    evaluateExecution(fullyExecuted).executed === true)

  const sellerMissingInitials = {
    ...fullyExecuted,
    initials: [{ signer_role: "agent", all_required_initials_present: true }],
  }
  const v1 = evaluateExecution(sellerMissingInitials)
  check("seller initials missing → NOT executed, and it says which",
    v1.executed === false && v1.missing.includes("seller initials"))

  const sellerNotSigned = {
    ...fullyExecuted,
    signatures: [
      { signer_role: "agent",  signed: true },
      { signer_role: "seller", signed: false },
    ],
  }
  check("a blank seller signature line → NOT executed",
    evaluateExecution(sellerNotSigned).executed === false)

  // The aggregate-pass trap: one party fully executed is not an executed contract.
  const agentOnly = {
    signatures: [{ signer_role: "agent", signed: true }],
    initials:   [{ signer_role: "agent", all_required_initials_present: true }],
  }
  check("agent alone is not an executed agreement",
    evaluateExecution(agentOnly).executed === false)

  // Absence is not consent — every unusable shape must read as unsigned.
  for (const [label, value] of [
    ["null",        null],
    ["undefined",   undefined],
    ["a string",    "signed"],
    ["an array",    [{ signer_role: "seller", signed: true }]],
    ["empty object", {}],
  ] as Array<[string, unknown]>) {
    check(`${label} is NOT treated as signed`, evaluateExecution(value).executed === false)
  }

  // A truthy-but-not-true value must not pass for a signature.
  check("a truthy non-true value is not a signature",
    evaluateExecution({
      signatures: [{ signer_role: "agent", signed: "yes" as any }, { signer_role: "seller", signed: true }],
      initials:   [{ signer_role: "agent", all_required_initials_present: true },
                   { signer_role: "seller", all_required_initials_present: true }],
    }).executed === false)

  check("both parties are required, not just one", LISTING_AGREEMENT_PARTIES.length === 2)
}

console.log("\n── the audit can see a document filed against the listing ──")
{
  // THE DEFECT: matching a metadata key nothing writes.
  check("the audit matches the listing_id COLUMN",
    /\.eq\("listing_id",\s*params\.listingId\)/.test(AUDIT))
  check("…and still honours the old metadata form",
    /metadata->>linked_listing_id/.test(AUDIT))
  check("the uploader writes that column",
    /listing_id:\s*listingId\s*\?\? null/.test(src("lib/documents/upload-document.ts")))
  check("the scanner selects it, so the gate knows the listing",
    /\.select\("id, brokerage_id, contact_id, transaction_id, listing_id,/.test(SCANNER))
}

console.log("\n── the gate runs on the path the uploads actually take ──")
{
  check("the scanner calls the gate", /runListingAgreementGate\(/.test(SCANNER))
  check("…unconditionally, so one place owns the rule",
    !/if \(classification === "listing_agreement"\)[\s\S]{0,80}?runListingAgreementGate/.test(SCANNER))
  check("the gate returns immediately for anything else",
    /if \(params\.classification !== "listing_agreement"\)/.test(GATE))
  check("the gate demands full execution", /evaluateExecution\(/.test(GATE))
  check("…AND every required document", /auditListingDocuments\(/.test(GATE) && /missing_blocking\.length > 0/.test(GATE))
  check("…before anything is emitted",
    /missing_blocking\.length > 0[\s\S]{0,400}?return \{\s*\n?\s*passed: false/.test(GATE))
  check("it emits the event the chain listens for",
    /compliance\.listing_agreement_passed/.test(GATE))
  check("the gate never promotes a listing itself",
    !/\.from\("listings"\)[\s\S]{0,200}?\.update\(/.test(GATE))
  // A background scan has no request session, so the `use server` action's auth
  // gate would reject it. RE-ANCHORED (lane 88D): the gate used to call startRun with
  // triggerEventId = the DOCUMENT id — refused by workflow_runs.trigger_event_id's FK to
  // lifecycle_events (23503), so the chain never started. It now records the event
  // through the sessionless lifecycle-event core and the orchestrator starts the chain
  // from it (executed below, §gate-event).
  check("it records the pass event through the sessionless lifecycle-event core (never the session-gated action, never startRun)",
    /recordLifecycleEvent\(supabase, params\.brokerageId,/.test(GATE) && !/triggerChainsForEvent/.test(GATE) && !/startRun\(/.test(GATE))
  check("…deduped on the document for good, so a re-scan reuses the event (and its run)",
    // the key is the event name + the document id however the name is spelled (a const or the literal)
    /dedupe_key:\s*`(?:\$\{eventType\}|compliance\.listing_agreement_passed):\$\{params\.documentId\}`/.test(GATE) && /dedupeWindowHours:\s*null/.test(GATE) &&
    !/triggerEventId:\s*params\.documentId/.test(GATE))
  check("[control] the key finder catches the retired document-id run key",
    /triggerEventId:\s*params\.documentId/.test("await startRun({ triggerEventId: params.documentId })"))
  check("a blocked agreement records WHY on the document",
    /listing_gate_blockers/.test(SCANNER))
}

console.log("\n── the agent has a door, and it is tenant-gated ──")
{
  check("a listing upload endpoint exists", ROUTE.length > 0)
  check("…which refuses an unauthenticated caller", /if \(!user\) return NextResponse\.json\(\{ error: "Unauthorized" \}/.test(ROUTE))
  check("…and refuses another brokerage's listing",
    /actor\.brokerage_id !== listing\.brokerage_id/.test(ROUTE))
  // Static `from "…"` or dynamic `await import("…")` — either is fine; what
  // matters is that the route does not roll its own insert into `documents`.
  check("…routing through the universal uploader, not a private copy",
    /(?:from|import\()\s*"@\/lib\/documents\/upload-document"/.test(ROUTE) &&
    !/\.from\("documents"\)\s*\n?\s*\.insert\(/.test(ROUTE))
  check("…filing against BOTH the listing and its seller",
    /listingId,/.test(ROUTE) && /contactId:\s*listing\.seller_contact_id/.test(ROUTE))
  check("…and stamping who uploaded it, which the gate reads back",
    /uploaded_by:\s*user\.id/.test(ROUTE) && /metadata\?\.uploaded_by/.test(SCANNER))

  check("the agent sees the panel on the listing", /CompletedDocumentsPanel/.test(PAGE))
  check("…and it posts to that endpoint",
    /\/api\/listings\/\$\{listingId\}\/upload-document/.test(PANEL))
  check("…reporting the SAME audit the gate runs, not a second opinion",
    /auditListingDocuments\(/.test(READS))
  check("…and the read side is tenant-gated too",
    /actor\.brokerage_id !== listing\.brokerage_id/.test(READS))
  check("the panel tells the agent a draft is waiting on this paperwork",
    /listingStatus === "draft"/.test(PANEL))
  check("…and never claims a classification it does not have yet",
    /Scanning…/.test(PANEL))
}

// ── §gate-event (lane 88D): the gate EXECUTED on an in-memory service client ──
// workflow_runs.trigger_event_id is a uuid FK to lifecycle_events(id) (live,
// hrvaqgvukzxfskkcrwbt). Modelled here: the registered dispatcher stands in for
// lib/orchestrator/internal.ts orchestrateEvent → getChainsByTrigger → startRun and
// writes the run row the engine writes, keyed on the EVENT id. No network.
async function gateEvent() {
  console.log("\n── §gate-event: a passed agreement starts the listing chain on a REAL lifecycle event ──")
  // server-only is a guard module; neutralised for tsx exactly as
  // scripts/listing-appt-prep-simulator.ts does. The gate itself runs for real.
  const { createRequire } = await import("module")
  const req = createRequire(import.meta.url)
  try { const p = req.resolve("server-only"); req.cache[p] = { id: p, filename: p, loaded: true, exports: {} } as any } catch { /* not resolvable */ }
  const { runListingAgreementGate } = await import("../lib/documents/listing-agreement-gate")
  const { registerEventDispatcher } = await import("../lib/events/dispatcher-registry")
  const { getChainsByTrigger } = await import("../lib/workflow-orchestrator/chains")

  type Row = Record<string, any>
  const T = "b0000000-0000-4000-8000-0000000000d1"
  const USER = "u0000000-0000-4000-8000-0000000000d1"
  const SELLER = "c0000000-0000-4000-8000-0000000000d1"
  const LISTING = "l0000000-0000-4000-8000-0000000000d1"
  const DOC = "d0000000-0000-4000-8000-0000000000d1"
  const tables: Record<string, Row[]> = { users: [{ id: USER, brokerage_id: T }], lifecycle_events: [], workflow_runs: [] }
  let seq = 0
  // Any table not seeded reads EMPTY (no required-docs rule, an empty deal file):
  // the required-document audit is proven by its own checks above; this block
  // proves what happens AFTER the gate passes.
  const svc: any = {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = []
      let ins: Row | null = null
      const run = () => {
        if (ins) { const row = { id: `le-${++seq}`, created_at: new Date().toISOString(), ...ins }; (tables[table] ??= []).push(row); return { data: [row], error: null } }
        return { data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null }
      }
      const q: any = new Proxy({}, {
        get(_t, k: string) {
          if (k === "then") return (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
          if (k === "insert") return (row: Row) => { ins = row; return q }
          if (k === "eq") return (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q }
          if (k === "maybeSingle" || k === "single") return async () => { const r = run(); return { data: (r.data as Row[])[0] ?? null, error: null } }
          return () => q
        },
      })
      return q
    },
  }
  const dispatched: Row[] = []
  registerEventDispatcher(async (event) => {
    dispatched.push(event as Row)
    for (const chain of getChainsByTrigger(event.event_type)) {
      tables.workflow_runs.push({ id: `run-${dispatched.length}`, chain_key: chain.key, brokerage_id: event.brokerage_id, trigger_event_id: event.id, metadata: event.payload })
    }
  })
  const fkViolations = (t: Record<string, Row[]>) => {
    const ids = new Set((t.lifecycle_events ?? []).map((e) => e.id))
    return (t.workflow_runs ?? []).filter((r) => r.trigger_event_id != null && !ids.has(r.trigger_event_id))
  }
  const executed = {
    signatures: [{ signer_role: "agent", signed: true }, { signer_role: "seller", signed: true }],
    initials:   [{ signer_role: "agent", all_required_initials_present: true }, { signer_role: "seller", all_required_initials_present: true }],
  }
  const args = {
    documentId: DOC, brokerageId: T, classification: "listing_agreement",
    extractedFields: { state: "FL", property_address: "12 Cypress Ln" }, signatureCompleteness: executed,
    contactId: SELLER, listingId: LISTING, agentUserId: USER,
  }
  const verdict = await runListingAgreementGate(svc, args)
  const ev = tables.lifecycle_events
  check("a fully executed agreement PASSES and records ONE compliance.listing_agreement_passed event in the document's tenant",
    verdict.passed && ev.length === 1 && ev[0].event_type === "compliance.listing_agreement_passed" && ev[0].brokerage_id === T)
  check("…about the DOCUMENT, deduped on it, carrying the seller, listing and document for the chain",
    ev[0]?.entity_type === "document" && ev[0]?.entity_id === DOC && ev[0]?.dedupe_key === `compliance.listing_agreement_passed:${DOC}` &&
    ev[0]?.metadata?.contact_id === SELLER && ev[0]?.metadata?.listing_id === LISTING && ev[0]?.metadata?.document_id === DOC)
  const run = tables.workflow_runs[0]
  check("the event is DISPATCHED and the listing chain's run is keyed on the EVENT id",
    dispatched.length === 1 && run?.chain_key === "compliance-listing-auto-create" && run?.trigger_event_id === ev[0]?.id)
  check("workflow_runs.trigger_event_id satisfies its FK to lifecycle_events (modelled)", fkViolations(tables).length === 0)
  check("[control] the retired key — the DOCUMENT id — is refused by that FK",
    fkViolations({ lifecycle_events: ev, workflow_runs: [{ trigger_event_id: DOC }] }).length === 1)
  await runListingAgreementGate(svc, args)
  check("a re-scan of the same agreement reuses the event: no second event, no second dispatch, no second run",
    tables.lifecycle_events.length === 1 && dispatched.length === 1 && tables.workflow_runs.length === 1)
  const unsigned = await runListingAgreementGate(svc, { ...args, documentId: "d-unsigned", signatureCompleteness: { signatures: [], initials: [] } })
  check("[negative] an unexecuted agreement records NO event", !unsigned.passed && tables.lifecycle_events.length === 1)
}

gateEvent().catch((e) => { fail++; fails.push(`§gate-event threw: ${(e as Error)?.message}`); console.log(e) }).finally(() => {
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ LISTING_DOC_UPLOAD_FAIL"); process.exit(1) }
  console.log(" ✅ LISTING_DOC_UPLOAD_PASS — the agent can file completed paperwork, and a fully-executed agreement with a complete file takes the listing on")
})
