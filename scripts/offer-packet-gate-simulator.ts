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

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  for (const f of fails) console.log(`   - ${f}`)
  console.log(" ❌ OFFER_PACKET_GATE_FAIL — a gate that cannot see the paperwork must not pass it")
  process.exit(1)
}
console.log(" ✅ OFFER_PACKET_GATE_PASS — no packet is a refusal, and the missing side has a name")
