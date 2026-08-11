#!/usr/bin/env tsx
/**
 * scripts/offer-packet-gate-simulator.ts  (npm run test:offer-packet-gate)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AUDIT GATE CANNOT PASS ON PAPERWORK NOBODY LOOKED AT.
 *
 * Owner's ruling: "the audit gate is when the offer is accepted and all
 * paperwork is submitted to compliance to be sure all documents for the
 * transaction are all present and all signatures/initials are complete on both
 * sides. if all are present, then a transaction is created, if not, then the
 * missing piece is sent to the tc and agent to get it finished and resubmitted
 * for approval."
 *
 * TWO DEFECTS THIS PINS SHUT:
 *
 * D1 — the gate passed when there was NO PACKET.
 *   scanOfferPacketCompleteness answered "no staged document found" with
 *   `blockers: []`, and submit-to-compliance read ONLY `blockers.length`. So
 *   "every signature is on the page" and "there is no paperwork whatsoever"
 *   arrived at the gate looking identical, and both created a transaction.
 *   Fixed at both ends: a scan that could not RUN returns a real blocker AND
 *   `success:false`, and the gate reads both.
 *
 * D3 — "both sides" was never asserted inside the packet.
 *   The field walk is side-agnostic: it reports on whatever the packet happens
 *   to contain, and a buyer-only packet produced zero blockers. The side is now
 *   explicit — read out of the field NAME, never inferred — so a packet that
 *   cannot show a side says so, and a blocker NAMES the side it belongs to.
 *
 * WHAT THIS PROOF ASSERTS: constructs, not spellings. The behaviour sections
 * call the real pure functions with real packet shapes. The two source sections
 * assert a STRUCTURAL property (an unsuccessful scan always carries a blocker;
 * the gate's refusal reads the scan's success flag) resolved through whatever
 * identifier the code happens to use, so a rename or a re-word cannot fake it.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  analyzeFilledPacket,
  classifyMissingField,
} from "../lib/workflow/intelligence/packet-analysis"
import { scanListingPacketCompleteness } from "../lib/workflow/intelligence/scan-offer-packet"

/**
 * The side of a block, read the way a REAL consumer reads it: out of the
 * finding the analyzer produces. The classifier itself is module-private, so
 * this exercises the path the gate actually uses rather than a helper only the
 * proof can see.
 */
const sideOf = (fieldName: string): string => {
  const a = analyzeFilledPacket({
    forms: [{ formName: "F", filledFields: [], unfilled: [{ fieldName }] }],
  })
  return a.blockers[0]?.side ?? "not-a-signature-block"
}

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? `\n      ${detail}` : ""}`) }
}
const ROOT = process.cwd()
/** Source with comments removed — prose that DESCRIBES a defect is not the defect. */
const stripComments = (t: string) => t
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "")
const src = (p: string) =>
  existsSync(join(ROOT, p)) ? stripComments(readFileSync(join(ROOT, p), "utf8")) : ""

/**
 * The object literal that encloses index `i`. Used to ask "what else is in the
 * same return as this flag?" without caring how the return is written.
 */
function enclosingObjectLiteral(text: string, i: number): string {
  let depth = 0, start = -1
  for (let k = i; k >= 0; k--) {
    if (text[k] === "}") depth++
    else if (text[k] === "{") { if (depth === 0) { start = k; break } depth-- }
  }
  if (start < 0) return ""
  let d = 0
  for (let k = start; k < text.length; k++) {
    if (text[k] === "{") d++
    else if (text[k] === "}") { d--; if (d === 0) return text.slice(start, k + 1) }
  }
  return text.slice(start)
}

// ── A supabase-shaped stub, for driving the REAL listing scan ───────────────
//
// Only the chain the scanner uses. It emulates the two things the lookup rules
// turn on and that a hand-written fake usually gets wrong:
//   · `metadata->>key` is a TEXT cast — `true` (jsonb) reads as the string
//     "true", and a JSON null (or an absent key) reads as SQL NULL;
//   · a REFUSED query RESOLVES in supabase-js, so `readError` is injectable and
//     the scanner must fail closed on it rather than seeing "no rows".
type Row = Record<string, any>
interface Store { listings: Row[]; documents: Row[]; users: Row[]; notifications: Row[] }

function makeStub(store: Store, opts: { readError?: string } = {}) {
  return {
    from(table: keyof Store) {
      const preds: Array<(r: Row) => boolean> = []
      let op: "select" | "insert" = "select"
      let single = false, order: string | null = null, asc = true
      const rows = () => store[table] ?? []
      const val = (r: Row, col: string) => {
        const m = /^metadata->>(.+)$/.exec(col)
        if (!m) return r[col]
        const raw = (r.metadata ?? {})[m[1]]
        return raw === undefined || raw === null ? null : String(raw)
      }
      const b: any = {
        select() { return b },
        insert(p: any) { op = "insert"; for (const x of (Array.isArray(p) ? p : [p])) rows().push({ id: `stub-${rows().length + 1}`, ...x }); return b },
        eq(c: string, v: any) { preds.push(r => val(r, c) === (/^metadata->>/.test(c) ? String(v) : v)); return b },
        in(c: string, vs: any[]) { preds.push(r => vs.includes(r[c])); return b },
        is(c: string, v: any) { preds.push(r => (v === null ? val(r, c) == null : val(r, c) === v)); return b },
        not(c: string, o: string, v: any) { preds.push(r => !(o === "is" && v === null ? val(r, c) == null : val(r, c) === v)); return b },
        filter(c: string, o: string, v: any) {
          preds.push(r => (o === "is" && v === null) ? val(r, c) == null : val(r, c) === String(v))
          return b
        },
        order(c: string, o?: { ascending?: boolean }) { order = c; asc = o?.ascending !== false; return b },
        limit() { return b },
        maybeSingle() { single = true; return b },
        then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej) },
      }
      function run() {
        if (op === "insert") return { data: null, error: null }
        if (opts.readError) return { data: null, error: { message: opts.readError } }
        let hit = rows().filter(r => preds.every(p => p(r)))
        if (order) hit = [...hit].sort((a, c) => asc
          ? String(a[order!]).localeCompare(String(c[order!]))
          : String(c[order!]).localeCompare(String(a[order!])))
        return { data: single ? (hit[0] ?? null) : hit, error: null }
      }
      return b
    },
  } as any
}

const LISTING     = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OTHER_LST   = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const BROKERAGE   = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const OTHER_BROK  = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const RAISER      = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const SELLER      = "ffffffff-ffff-4fff-8fff-ffffffffffff"

/** The content BOTH listing staging paths write, before the generator lands. */
const STAGED_CONTENT = JSON.stringify({
  intake: {},
  filledPacket: {
    forms: [{
      formName: "Exclusive Right to Sell",
      filledFields: [{ fieldName: "sellerLegalName", confidence: "high" }],
      unfilled: [{ fieldName: "seller_signature", reason: "not signed" }],
    }],
  },
})

/**
 * The content `ai-listing-intake.ts:generateListingAgreement` OVERWRITES it
 * with, moments later, on BOTH staging paths — its real shape, keys and all.
 */
const GENERATOR_CONTENT = JSON.stringify({
  packet_type: "listing_agreement",
  state: "TX",
  forms: { required: ["LA-1"], addenda: [], brokerage_representation: null },
  prefilled: { seller_legal_name: "Ada Vance", property_address: "12 Oak" },
  needs_agent_input: [
    { field: "list_price", reason: "Strategy decision with seller (CMA-driven)" },
    { field: "commission_structure", reason: "Listing-side commission" },
  ],
  formwizard_url: "/dashboard/listings/new",
})

const listingWorld = (docs: Row[], listingOver: Row = {}): Store => ({
  listings: [{
    id: LISTING, brokerage_id: BROKERAGE, seller_contact_id: SELLER,
    contact_id: null, state: "TX", ...listingOver,
  }],
  documents: docs,
  users: [{ id: RAISER, brokerage_id: BROKERAGE, user_type: "transaction_coordinator" }],
  notifications: [],
})

/** A row shaped like what the two staging inserts actually write. */
const stagedPacketRow = (over: Row = {}): Row => ({
  id: "doc-staged", brokerage_id: BROKERAGE, contact_id: SELLER, listing_id: null,
  document_type: "listing_agreement", status: "needs_agent_input", state_code: "TX",
  storage_url: null, metadata: { packet_type: "listing", state: "TX" },
  content: STAGED_CONTENT, created_at: "2026-03-01T00:00:00.000Z", ...over,
})

/** A row shaped like what the AGENT'S UPLOAD writes — a file, never a packet. */
const uploadedPdfRow = (over: Row = {}): Row => ({
  id: "doc-uploaded", brokerage_id: BROKERAGE, contact_id: SELLER, listing_id: LISTING,
  document_type: "listing_agreement", status: "complete", state_code: null,
  storage_url: "https://storage.test/signed-listing-agreement.pdf",
  metadata: { file_name: "listing agreement signed.pdf", upload_source: "agent_upload", linked_offer_id: null },
  content: null, created_at: "2026-03-02T00:00:00.000Z", ...over,
})

const scanListing = (store: Store, opts: { readError?: string } = {}) =>
  scanListingPacketCompleteness({
    listingId: LISTING, raiserUserId: RAISER, brokerageId: BROKERAGE,
    client: makeStub(store, opts),
  })

async function main() {

console.log("══════════════════════════════════════════════════")
console.log(" The audit gate — no packet is not a pass")
console.log("══════════════════════════════════════════════════")

// ── D3 · PURE: whose block is it? ───────────────────────────────────────────
console.log("\n[the side is read, never inferred]")
{
  check("a seller signature is the SELLER's",  sideOf("seller_signature") === "seller")
  check("a buyer initial is the BUYER's",      sideOf("buyer_2_initials") === "buyer")
  // The tree's own form-field vocabulary (form-fill-engine HEURISTIC_PATTERNS)
  // matches purchaser/grantor as well as buyer/seller.
  check("…and the deed-vocabulary synonyms count too",
    sideOf("purchaser_signature") === "buyer" &&
    sideOf("grantor_signature")   === "seller")
  // BOTH directions of doubt are 'unspecified'. Silence is never a side.
  check("a block that names no party is unspecified, not assumed",
    sideOf("page_3_initials") === "unspecified")
  check("a block naming BOTH parties is evidence for neither",
    sideOf("buyer_and_seller_initials") === "unspecified")
  check("a word merely CONTAINING a party token is not that party",
    sideOf("resellers_signature") === "unspecified")
  // A data field is not a block at all, so it gets no side to argue about.
  check("a data field carries no side", sideOf("purchase_price") === "not-a-signature-block")
}

// ── D3 · PURE: a buyer-only packet cannot show both sides ───────────────────
console.log("\n[a packet that cannot show both sides says so]")
{
  const buyerOnly = analyzeFilledPacket({
    forms: [{
      formName: "Purchase Agreement",
      filledFields: [{ fieldName: "buyer_signature", confidence: "high" }],
      unfilled: [],
    }],
  })
  check("a buyer-only packet has zero blockers — which is why the sides matter",
    buyerOnly.blockers.length === 0)
  check("…and it records the seller side as NOT shown",
    buyerOnly.signatureSides.buyer.evidenced === true &&
    buyerOnly.signatureSides.seller.evidenced === false)

  const bothSides = analyzeFilledPacket({
    forms: [{
      formName: "Purchase Agreement",
      filledFields: [
        { fieldName: "buyer_signature",  confidence: "high" },
        { fieldName: "seller_signature", confidence: "high" },
      ],
      unfilled: [],
    }],
  })
  check("a packet carrying both signature blocks shows both sides",
    bothSides.signatureSides.buyer.evidenced && bothSides.signatureSides.seller.evidenced &&
    bothSides.signatureSides.seller.outstanding === 0)

  const sellerMissing = analyzeFilledPacket({
    forms: [{
      formName: "Purchase Agreement",
      filledFields: [{ fieldName: "buyer_signature", confidence: "high" }],
      unfilled: [{ fieldName: "seller_signature", reason: "not signed" }],
    }],
  })
  const sellerBlocker = sellerMissing.blockers.find(b => b.flagType === "missing_signature")
  check("an outstanding seller signature blocks at CRITICAL and NAMES the seller",
    !!sellerBlocker && sellerBlocker.severity === "critical" && sellerBlocker.side === "seller")
  check("…and the count of that side's outstanding blocks is carried",
    sellerMissing.signatureSides.seller.outstanding === 1 &&
    sellerMissing.signatureSides.buyer.outstanding === 0)
  // The blocker for one side must not read identically to the other side's.
  const buyerMissing = analyzeFilledPacket({
    forms: [{ formName: "Purchase Agreement", filledFields: [], unfilled: [{ fieldName: "buyer_signature" }] }],
  })
  check("the two sides do not produce the same sentence",
    buyerMissing.blockers[0].title !== sellerBlocker!.title)

  // An unattributed block is still a blocker, and still not evidence of a side.
  const unattributed = analyzeFilledPacket({
    forms: [{ formName: "Addendum", filledFields: [], unfilled: [{ fieldName: "page_3_initials" }] }],
  })
  check("an unattributed block blocks without crediting either side",
    unattributed.blockers.length === 1 &&
    unattributed.signatureSides.buyer.evidenced === false &&
    unattributed.signatureSides.seller.evidenced === false &&
    unattributed.signatureSides.unspecified.evidenced === true)
}

// ── D3 · the shape the fill engine ACTUALLY produces ────────────────────────
//
// This is the evidence behind docs/wave9-slice-gate.md, made executable:
// lib/workflow/intake/form-fill-engine.ts:fillStateAssociationForm emits its
// unfilled list from a FIXED set of intake names and never emits a signature or
// initial field at all. So on a state-association packet the sides come back
// unshown — and that is a fact the gate must SAY, not a pass it may assume.
console.log("\n[the packet the fill engine really builds]")
{
  const engineShaped = analyzeFilledPacket({
    forms: [{
      formName: "Residential Purchase Agreement",
      filledFields: [
        { fieldName: "buyerLegalName",  confidence: "high" },
        { fieldName: "propertyAddress", confidence: "high" },
      ],
      unfilled: [
        { fieldName: "offerPrice", reason: "Required field not provided in intake" },
        { fieldName: "closeDate",  reason: "Required field not provided in intake" },
      ],
    }],
  })
  check("a state-association packet produces no signature findings at all",
    engineShaped.blockers.every(b => b.flagType === "missing_field"))
  check("…so NEITHER side is shown, and neither may be read as signed",
    engineShaped.signatureSides.buyer.evidenced === false &&
    engineShaped.signatureSides.seller.evidenced === false)
  check("the classifier is what draws that line, not a form list",
    classifyMissingField("buyerLegalName") === "missing_field" &&
    classifyMissingField("buyer_signature") === "missing_signature")
}

// ── D1 · the scanner fails closed ───────────────────────────────────────────
//
// THE CONSTRUCT: in the packet-scan module, a summary that reports
// `success: false` never also reports an empty blocker list. Blockers are the
// field every consumer reads and the field that fans out to the TC and the
// agent, so this is what makes a future caller unable to repeat the mistake.
// Asserted over the enclosing object literal, so it survives any re-wording of
// the messages or renaming of the helpers.
console.log("\n[a scan that could not run is not a clean scan]")
{
  const s = src("lib/workflow/intelligence/scan-offer-packet.ts")
  const failureLiterals: string[] = []
  const re = /success:\s*false/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) failureLiterals.push(enclosingObjectLiteral(s, m.index))

  check(`every unsuccessful-scan return was found (${failureLiterals.length})`,
    failureLiterals.length >= 2 && failureLiterals.every(l => l.length > 0))
  check("…and not one of them reports an empty blocker list",
    failureLiterals.every(l => !/blockers:\s*\[\s*\]/.test(l)))
  check("…each carries at least one finding of its own",
    failureLiterals.every(l => /blockers:\s*\[\s*\{/.test(l)))
  check("…and none of them claims a completion percentage of 100",
    failureLiterals.every(l => !/completionPercent:\s*100/.test(l)))
  // A refused read RESOLVES in supabase-js. Both lookups must destructure it,
  // or "the query was refused" and "there is no document" are the same value.
  const reads = s.match(/const \{[^}]*\}\s*=\s*await supabase[\s\S]*?maybeSingle\(\)/g) ?? []
  check(`both document lookups destructure error (${reads.length} found)`,
    reads.length >= 2 && reads.every(r => /error:/.test(r.slice(0, r.indexOf("=")))))
}

// ── D1 · the gate reads it ──────────────────────────────────────────────────
//
// THE CONSTRUCT: the branch that refuses the submit depends on the packet
// scan's SUCCESS, not only on its blocker count. Resolved through whichever
// identifier the code binds `packetScan.success` to, so renaming it cannot
// fake the assertion and moving the logic cannot silently drop it.
console.log("\n[the gate refuses on a check that did not run]")
{
  const s = src("app/actions/buyer-offer/submit-to-compliance.ts")
  check("the gate reads the scan's success flag at all",
    /packetScan\.success/.test(s),
    "it read only packetScan.blockers.length — that was the defect")

  const bound = s.match(/const\s+(\w+)\s*=\s*packetScan\.success/)
  check("…binds it to a named condition", !!bound)

  // REFINED AFTER THE FIRST PASS, and deliberately STRONGER.
  //
  // The refusal used to key on "the scan did not succeed". That over-refuses:
  // `buyer-offers.ts:createOffer` — the offer wizard, the main path in the
  // product — stages no packet at all, so its offers legitimately arrive with
  // `success:false`. Refusing them would block every wizard deal at compliance,
  // which is an outage, not a compliance improvement. They are not unverified:
  // both sides are established on the offer's executed-contract columns, which
  // this same function enforces before the scan is ever called.
  //
  // So the construct is now: refuse whenever the packet is UNVERIFIED, where
  // unverified = an explicit fault, OR any unsuccessful scan that did not
  // explicitly declare itself a never-staged packet. That second clause is the
  // belt: a future scanner exit that forgets to tag its outcome still refuses
  // rather than passing as clean. Resolved through whichever identifiers the
  // code binds, so renaming cannot fake it.
  const faultBound = s.match(/const\s+(\w+)\s*=\s*packetScan\.scanOutcome\s*===\s*"fault"/)
  const stagedBound = s.match(/const\s+(\w+)\s*=\s*packetScan\.scanOutcome\s*===\s*"no_packet_staged"/)
  check("…and distinguishes a FAULT from a never-staged packet",
    !!faultBound && !!stagedBound,
    "both outcomes must be bound — over-refusing blocks every wizard offer")

  const unverifiedBound = s.match(/const\s+(\w+)\s*=\s*(\w+)\s*\|\|\s*\(!(\w+)\s*&&\s*!(\w+)\)/)
  check("…and derives 'unverified' as fault OR untagged-unsuccessful (the belt)",
    !!unverifiedBound && !!bound && !!faultBound && !!stagedBound &&
    unverifiedBound[2] === faultBound[1] &&
    unverifiedBound[3] === bound[1] &&
    unverifiedBound[4] === stagedBound[1],
    `derivation was: ${unverifiedBound?.[0] ?? "(not found)"}`)

  const guard = s.match(/if\s*\(([^)]*missing_blocking[^)]*|[^)]*hasBlockingMissing[^)]*)\)\s*\{/)
  check("…and the refusal branch depends on it",
    !!unverifiedBound && !!guard && guard[1].includes(unverifiedBound[1]),
    `refusal condition was: ${guard?.[1] ?? "(not found)"}`)

  // The never-staged pass must not be silent: the gate event has to say which
  // evidence actually established both sides, or a later reader cannot tell a
  // field-by-field check from a column check.
  check("…and a never-staged pass RECORDS that the field scan did not run",
    /both_sides_established_by/.test(s) &&
    /executed_contract_columns_only/.test(s) &&
    /ran:\s*packetScan\.scanOutcome === "scanned"/.test(s),
    "a gate row claiming a check it never performed is the same lie as the empty-blockers pass")

  // The refusal must reach the TC + the agent by the SAME path every other
  // blocking miss uses, with the deal recipients this file resolves.
  const refuseIdx = s.search(/if\s*\([^)]*hasBlockingMissing/)
  const refuseBlock = refuseIdx >= 0 ? s.slice(refuseIdx, refuseIdx + 2000) : ""
  check("…and fans the refusal out to the TC + agent on the shared path",
    refuseBlock.includes("notifyComplianceFlag(") && refuseBlock.includes("alsoNotifyUserIds: dealRecipients"))
  check("…telling them what to DO, not only what is wrong",
    /blockers\.map\(b\s*=>\s*b\.body\)/.test(refuseBlock))

  // D3 at the gate: the both-sides determination is RECORDED with its source,
  // so nothing downstream can read the gate row as a field-level signature check.
  check("the gate records what established each side",
    /packetScan\.signatureSides/.test(s) && /both_sides/.test(s))
  check("…and a side the packet could not show is notified, not swallowed",
    /signatureSides/.test(s) && /compliance\.submit_warnings/.test(s) &&
    /evidenced/.test(s))
}

// ── L3 · THE LISTING SCAN, DRIVEN FOR REAL ──────────────────────────────────
//
// The sibling of D1, in a purer form and still live: the listing scan looked
// its document up by `metadata.linked_listing_id` — a key NOTHING in the tree
// writes — so it always took the "no document" branch and returned
// `success: true, completionPercent: 100, blockers: []`. A permanent no-op that
// read as a full pass, at the checkpoint that decides whether a listing may be
// taken on.
//
// These drive the REAL scanner against row shapes copied from the REAL writers,
// so what is asserted is the LOOKUP RULE, not a spelling of it.
console.log("\n[the listing packet is found by what the staging paths really write]")
{
  // The two staging inserts write brokerage_id, contact_id (the seller),
  // document_type, status, state_code, metadata.packet_type and content — and
  // NO listing link of any kind, because at staging time there is frequently no
  // listing row yet. The seller contact is therefore the only key there is.
  const found = await scanListing(listingWorld([stagedPacketRow()]))
  check("a packet staged against the SELLER is found — the key the staging paths write",
    found.documentId === "doc-staged" && found.scanOutcome === "scanned",
    `outcome was ${found.scanOutcome}, documentId ${String(found.documentId)}`)
  check("…and it is WALKED: the outstanding seller signature blocks at critical",
    found.blockers.some(b => b.flagType === "missing_signature" && b.severity === "critical"))
  check("…which is the whole defect: this used to report a 100% pass with no blockers",
    found.completionPercent !== 100 || found.blockers.length > 0)

  // The link forms the sibling audit was fixed to match are honoured too.
  const byColumn = await scanListing(listingWorld([stagedPacketRow({ id: "doc-col", contact_id: null, listing_id: LISTING })]))
  check("a packet carrying the listing_id COLUMN is found",
    byColumn.documentId === "doc-col" && byColumn.scanOutcome === "scanned")
  const byMeta = await scanListing(listingWorld([stagedPacketRow({
    id: "doc-meta", contact_id: null,
    metadata: { packet_type: "listing", linked_listing_id: LISTING },
  })]))
  check("…and so is one carrying metadata.linked_listing_id, for anything ever written that way",
    byMeta.documentId === "doc-meta" && byMeta.scanOutcome === "scanned")
}

console.log("\n[an uploaded PDF is never mistaken for a packet — wave 9's reasoning, kept]")
{
  // WAVE 9 DECLINED TO WIDEN THIS LOOKUP for exactly this reason: matching any
  // listing document would start matching agent-uploaded PDFs, which
  // legitimately carry no filledPacket, and the paper-signing path must not be
  // refused. The discriminator is what a staged packet IS — form data with no
  // file behind it and a packet marker on it — not what it is linked to.
  const uploaded = await scanListing(listingWorld([uploadedPdfRow()]))
  check("the agent's signed-agreement PDF is NOT adopted as a packet",
    uploaded.documentId === null && uploaded.scanOutcome === "no_packet_staged")
  check("…and the paper path is NOT refused for it",
    uploaded.success === true && uploaded.blockers.length === 0)

  // Both halves of the discriminator have to hold, or the class comes back.
  const pdfWithMarker = await scanListing(listingWorld([uploadedPdfRow({
    metadata: { file_name: "x.pdf", packet_type: "listing" },
  })]))
  // HARDENED after the negative control: `documentId === null` alone stayed
  // GREEN with the discriminator removed, because the fault exit also reports a
  // null documentId. An assertion a reintroduced bug can satisfy is worthless,
  // so this now says what must be TRUE of the verdict, not only of one field.
  check("a file with a packet marker is still a file — storage_url is the tell",
    pdfWithMarker.documentId === null && pdfWithMarker.scanOutcome === "no_packet_staged" &&
    pdfWithMarker.success === true && pdfWithMarker.blockers.length === 0,
    `outcome was ${pdfWithMarker.scanOutcome}`)
  const packetShapedNoMarker = await scanListing(listingWorld([stagedPacketRow({
    metadata: { state: "TX" },
  })]))
  check("…and an unmarked row is not adopted either, in the other direction",
    packetShapedNoMarker.documentId === null)
}

console.log("\n[nothing to verify is recorded as nothing — never as 100%]")
{
  const none = await scanListing(listingWorld([]))
  check("no staged packet does not block the listing gate",
    none.success === true && none.blockers.length === 0 && none.scanOutcome === "no_packet_staged")
  check("…and NEVER claims a complete packet again",
    none.completionPercent === 0,
    `completionPercent was ${none.completionPercent}`)
  check("…and says why, so a reader can tell it from a verified pass",
    typeof none.error === "string" && none.error.length > 0)

  // THE ONE THAT WOULD HAVE BLOCKED 100% OF AI-STAGED LISTINGS.
  // generateListingAgreement overwrites the staged row's `content` with its
  // prefill shape on BOTH staging paths, so the field-level packet is gone from
  // every listing this product stages. Treating that like the offer side's
  // "document with no packet" FAULT would refuse every one of them at
  // markAgreementSigned, which refuses on `!success` and on any blocker.
  const generated = await scanListing(listingWorld([stagedPacketRow({ id: "doc-gen", content: GENERATOR_CONTENT })]))
  check("the generator's prefill shape does NOT refuse the listing",
    generated.success === true && generated.blockers.length === 0,
    `success=${generated.success}, blockers=${generated.blockers.length}`)
  check("…and is recorded as unverified, naming the document it saw",
    generated.scanOutcome === "no_packet_staged" && generated.documentId === "doc-gen" &&
    generated.completionPercent === 0 && !!generated.error)

  // …AND THE OVERWRITE ITSELF IS FIXED, so that tolerance is a safety net for
  // legacy rows rather than the permanent state of the AI lane.
  //
  // The tolerance above stops the generator's shape REFUSING a listing. It
  // cannot make the packet verifiable — only not destroying it can. Both
  // staging paths insert `content = { intake, filledPacket }` and then call
  // generateListingAgreement, which assigned `content` and `metadata` WHOLESALE
  // and took `filledPacket` with it. That is the same defect wave 9 fixed on the
  // offer side (ai-offer-creation.ts:generateOfferDraft), and without this
  // assertion a regression silently returns the listing lane to "nothing to
  // verify" — green, and blind.
  //
  // Structural, resolved through the spread rather than a spelling: prior
  // content and prior metadata are both carried, and the write is error-checked.
  for (const [file, fn] of [
    ["app/actions/ai-listing-intake.ts", "generateListingAgreement"],
    ["app/actions/ai-offer-creation.ts", "generateOfferDraft"],
  ] as const) {
    const s = src(file)
    check(`${fn} MERGES the staged document rather than replacing it`,
      /\.\.\.priorContent/.test(s) && /\.\.\.priorMetadata/.test(s) &&
      !/content: JSON\.stringify\(packet, null, 2\),\s*\n\s*status:[\s\S]{0,200}metadata: \{\s*\n\s*state,/.test(s),
      `${file}: prior content/metadata spread not found`)
    check(`…and ${fn}'s packet write is error-checked`,
      /packetWriteErr/.test(s))
  }
}

console.log("\n[a scan that could not run still refuses, on the listing side too]")
{
  const corrupt = await scanListing(listingWorld([stagedPacketRow({ content: "{not json" })]))
  check("a staged packet in a shape nothing writes is a FAULT",
    corrupt.success === false && corrupt.scanOutcome === "fault")
  check("…carrying a real blocker, never an empty list",
    corrupt.blockers.length >= 1 && !!corrupt.blockers[0].body)

  const refused = await scanListing(listingWorld([stagedPacketRow()]), { readError: "permission denied for table documents" })
  check("a REFUSED read fails closed — supabase-js resolves it, so it must be destructured",
    refused.success === false && refused.scanOutcome === "fault" && refused.blockers.length >= 1)

  const badId = await scanListingPacketCompleteness({
    listingId: "not-a-uuid", raiserUserId: RAISER, brokerageId: BROKERAGE,
    client: makeStub(listingWorld([])),
  })
  check("an invalid id is a fault, not an empty pass",
    badId.success === false && badId.scanOutcome === "fault" && badId.blockers.length >= 1)
}

console.log("\n[the seller-contact match cannot reach across a deal or a tenant]")
{
  const otherTenant = await scanListing(listingWorld([stagedPacketRow({ brokerage_id: OTHER_BROK })]))
  check("a packet in ANOTHER brokerage is never adopted",
    otherTenant.documentId === null && otherTenant.success === true)

  const otherListing = await scanListing(listingWorld([stagedPacketRow({ listing_id: OTHER_LST })]))
  check("a packet already linked to ANOTHER listing is never adopted by the contact match",
    otherListing.documentId === null)

  const otherState = await scanListing(listingWorld([stagedPacketRow({ state_code: "CA" })]))
  check("…and one staged for a different STATE is a different property's packet",
    otherState.documentId === null)

  const crossTenantListing = await scanListingPacketCompleteness({
    listingId: LISTING, raiserUserId: RAISER, brokerageId: OTHER_BROK,
    client: makeStub(listingWorld([stagedPacketRow()])),
  })
  check("a listing outside the caller's brokerage is a FAULT, not an empty pass",
    crossTenantListing.success === false && crossTenantListing.scanOutcome === "fault")
}

// ── L3 · the summary can no longer lie by omission ──────────────────────────
console.log("\n[the listing summary carries WHY, in the same vocabulary as the offer side]")
{
  const s = src("lib/workflow/intelligence/scan-offer-packet.ts")
  // ONE vocabulary, not two, and no exit may skip it: every summary either
  // scan returns must say WHY it ended, or `blockers: []` goes back to meaning
  // both "verified clean" and "nobody looked". Asserted over the enclosing
  // object literal, so re-wording or renaming cannot fake it.
  const summaries: string[] = []
  const reSummary = /success:\s*(true|false)/g
  let sm: RegExpExecArray | null
  while ((sm = reSummary.exec(s))) summaries.push(enclosingObjectLiteral(s, sm.index))
  check(`every summary either scan returns was found (${summaries.length})`,
    summaries.length >= 5 && summaries.every(l => l.length > 0))
  check("…and every one of them says WHY the scan ended as it did",
    summaries.every(l => /scanOutcome:/.test(l)),
    "an exit with no outcome is an exit a consumer has to guess about")
  check("…and no exit in the module reports a 100% complete packet",
    !/completionPercent:\s*100/.test(s),
    "the listing scan's no-document branch used to return exactly that")
  // The lookup is no longer keyed on the one key nothing writes.
  const linkForms = (s.match(/metadata->>linked_listing_id/g) ?? []).length
  check("the listing lookup no longer depends ONLY on the key nothing writes",
    /\.eq\("listing_id",\s*listingId\)/.test(s) && /contact_id/.test(s) && linkForms >= 1)
  check("…and every candidate lookup is pinned to the caller's brokerage",
    /\.eq\("brokerage_id",\s*brokerageId\)/.test(s))
}

// ── L5 · the panel surfaces the remedy it was handed ────────────────────────
//
// THE CONSTRUCT: whatever identifier the component binds `json.blockers` to,
// the first finding's BODY reaches the message the agent reads — on the refusal
// path AND on the path where a scan ran and found blockers. A refusal that
// names the fault and withholds the fix is the dead end this sequence removes.
console.log("\n[the pre-flight scan panel shows what to DO]")
{
  const s = src("app/components/offer/offer-agent-actions.tsx")
  const i = s.indexOf("async function runScan")
  const fn = i >= 0 ? s.slice(i, s.indexOf("function pickFile") > i ? s.indexOf("function pickFile") : i + 3000) : ""
  check("runScan was found", fn.length > 0)

  const blockersBound = /const\s+(\w+)[^=]*=\s*Array\.isArray\(json\.blockers\)/.exec(fn)
  check("it reads the blockers the API already returns",
    !!blockersBound, "it read only json.error — that was the defect")

  const firstBound = blockersBound && new RegExp(`const\\s+(\\w+)\\s*=\\s*${blockersBound[1]}\\[0\\]`).exec(fn)
  check("…takes the first finding", !!firstBound)

  const remedyBound = firstBound && new RegExp(`const\\s+(\\w+)\\s*=\\s*\\[[^\\]]*${firstBound[1]}\\?\\.body[^\\]]*\\]`).exec(fn)
  check("…and builds the message from its BODY — the 'What to do:' half",
    !!remedyBound, "the title alone names the fault and withholds the remedy")

  const reports = fn.match(/report\("scan",[\s\S]*?\)\n/g) ?? []
  const failReport = fn.slice(fn.indexOf("if (!res.ok)"), fn.indexOf("if (!res.ok)") + 600)
  check("…which reaches the agent on the REFUSAL path",
    !!remedyBound && failReport.includes(remedyBound![1]))
  check("…and on the path where a scan ran and found blockers",
    !!remedyBound && reports.length >= 1 &&
    fn.slice(fn.lastIndexOf("report(\"scan\"")).includes(remedyBound![1]))
  check("…and a never-staged packet does not read as a system fault",
    /no_packet_staged/.test(fn),
    "the wizard stages no packet at all; calling that a failure teaches agents to ignore the panel")
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  for (const f of fails) console.log(`   - ${f}`)
  console.log(" ❌ OFFER_PACKET_GATE_FAIL — a gate that cannot see the paperwork must not pass it")
  process.exit(1)
}
console.log(" ✅ OFFER_PACKET_GATE_PASS — no packet is a refusal, and the missing side has a name")

}

main().catch((e) => { console.error(e); process.exit(1) })
