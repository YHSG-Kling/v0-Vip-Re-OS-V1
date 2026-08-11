#!/usr/bin/env tsx
/**
 * scripts/compliance-checkpoints-simulator.ts  (npm run test:compliance-checkpoints)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COMPLIANCE RUN HAPPENS AT **TWO** CHECKPOINTS, AND IT IS THE SAME RUN.
 *
 * Owner's rule, applied to both:
 *   · an ACCEPTED OFFER does not become a transaction, and
 *   · a SIGNED LISTING AGREEMENT does not become a live listing,
 *   until every signed document from both sides is on file, every required
 *   brokerage / team / agent document is present, and no signature, initial or
 *   field is missing. Whether a given document is REQUIRED or merely a WARNING
 *   is a setting. Any missing item — document, signature or initial — notifies
 *   the TC and/or the listing agent. The MLS number is NOT required at either
 *   checkpoint; it belongs to listing LAUNCH.
 *
 * What was actually there:
 *   · the OFFER side had the gate, but notified only whoever clicked, and a
 *     WARNING-level miss notified nobody at all.
 *   · the LISTING side had NO gate. markAgreementSigned wrote
 *     `compliance_passed: true` as a LITERAL — a compliance column asserting a
 *     check that had never run — and auditListingDocuments, whose own comment
 *     states this exact rule, was never called from it.
 *   · the field-level scan existed only for offers, keyed on
 *     document_type='offer' + linked_offer_id, even though nothing in the walk
 *     is offer-shaped.
 *
 * The walk is now ONE pure function (lib/workflow/intelligence/packet-analysis),
 * shared by both checkpoints, and this proof exercises it with real packets
 * rather than only asserting that the source mentions it.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { analyzeFilledPacket, classifyMissingField } from "../lib/workflow/intelligence/packet-analysis"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? `\n      ${detail}` : ""}`) }
}
const ROOT = process.cwd()
/**
 * Read a file's CODE, with comments removed.
 *
 * Every source assertion below is about what the code DOES. A guard for a
 * defect has to describe the defect, and the description quotes it verbatim —
 * three separate assertions in this sweep were tripped by a comment explaining
 * the very thing they were checking for. Prose is not code; do not scan it.
 */
const stripComments = (t: string) => t
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "")
const src = (p: string) =>
  existsSync(join(ROOT, p)) ? stripComments(readFileSync(join(ROOT, p), "utf8")) : ""

console.log("══════════════════════════════════════════════════")
console.log(" Compliance checkpoints — one run, two gates")
console.log("══════════════════════════════════════════════════")

// ── PURE: what counts as a missing signature ────────────────────────────────
console.log("\n[the field walk — behaviour, not source text]")
{
  check("a signature field is critical", classifyMissingField("buyer_signature") === "missing_signature")
  check("an initial field is its own class", classifyMissingField("seller_initials") === "missing_initial")
  check("…and matches the short form too", classifyMissingField("pg3_init") === "missing_initial")
  check("anything else is a plain field", classifyMissingField("purchase_price") === "missing_field")
  // The direction that matters: a data field must NOT be mistaken for a
  // signature, or a complete packet reads as legally unsigned.
  check("a field merely CONTAINING 'design' is not a signature",
    classifyMissingField("design_notes") === "missing_field")
}

{
  const packet = {
    forms: [{
      formName: "Exclusive Right to Sell",
      filledFields: [
        { fieldName: "list_price", confidence: "high" },
        { fieldName: "term_days",  confidence: "medium" },
        { fieldName: "apn",        confidence: "low" },
      ],
      unfilled: [
        { fieldName: "seller_signature", reason: "not provided in intake" },
        { fieldName: "seller_initials_p3" },
        { fieldName: "hoa_dues" },
      ],
    }],
    agentMustComplete: ["Lead-Based Paint Disclosure"],
  }
  const a = analyzeFilledPacket(packet)

  check("a missing signature blocks at CRITICAL",
    a.blockers.some(b => b.flagType === "missing_signature" && b.severity === "critical"))
  check("a missing initial blocks at HIGH",
    a.blockers.some(b => b.flagType === "missing_initial" && b.severity === "high"))
  check("a missing data field blocks at MEDIUM",
    a.blockers.some(b => b.flagType === "missing_field" && b.severity === "medium"))
  check("a form the fill engine could not build is its own blocker",
    a.blockers.some(b => b.flagType === "missing_form" && b.title.includes("Lead-Based Paint")))
  check("a low-confidence value WARNS rather than blocks",
    a.warnings.length === 1 && a.blockers.every(b => b.severity !== "low"))
  // 6 fields, 2 of them high/medium-filled → 33%. The low-confidence one is
  // deliberately NOT counted as filled: a packet of guesses is not complete.
  check(`completion counts only high/medium confidence (${a.completionPercent}% of ${a.totalFields})`,
    a.totalFields === 6 && a.filledFields === 2 && a.completionPercent === 33)
}

{
  const clean = analyzeFilledPacket({
    forms: [{ formName: "Listing Agreement", filledFields: [{ fieldName: "price", confidence: "high" }], unfilled: [] }],
  })
  check("a complete packet has no blockers and reads 100%",
    clean.blockers.length === 0 && clean.completionPercent === 100)
  // An absent packet is not a 0% packet — a brokerage that signs on paper has
  // no filledPacket at all, and the required-DOCUMENT audit covers that case.
  const none = analyzeFilledPacket({})
  check("an empty packet is 100% with nothing outstanding, not 0%",
    none.totalFields === 0 && none.completionPercent === 100 && none.blockers.length === 0)
  check("…and malformed input does not throw",
    analyzeFilledPacket({ forms: "nonsense", agentMustComplete: 7 } as any).blockers.length === 0)
}

// ── The two checkpoints are wired, and wired the same way ───────────────────
console.log("\n[checkpoint 1 — accepted offer → transaction]")
{
  const s = src("app/actions/buyer-offer/submit-to-compliance.ts")
  check("runs the required-document audit + the packet scan",
    s.includes("auditOfferDocuments(") && s.includes("scanOfferPacketCompleteness("))
  check("refuses on a blocking miss", s.includes("Cannot submit to compliance"))
  check("notifies the TC, the offer's agent and the LISTING agent",
    s.includes("alsoNotifyUserIds: dealRecipients") && s.includes('.from("listings").select("agent_id")'))
  check("a WARNING-level miss still notifies", s.includes("compliance.submit_warnings"))
  check("consults no MLS number", !/mls_number/i.test(s))
}

console.log("\n[checkpoint 2 — signed listing agreement → live listing]")
{
  const s = src("app/actions/seller-listing/execution-engine.ts")
  const fn = s.slice(s.indexOf("export async function markAgreementSigned"),
                     s.indexOf("export async function recordPreListingRepair"))
  check("runs the required-document audit + the packet scan",
    fn.includes("auditListingDocuments(") && fn.includes("scanListingPacketCompleteness("))
  check("refuses on a blocking miss instead of recording a pass",
    fn.includes("Cannot execute the listing agreement"))
  check("a packet check that could not RUN is a block, never a pass",
    fn.includes("packet check could not run"))
  check("a WARNING-level miss still notifies",
    fn.includes("compliance.listing_agreement_warnings"))
  check("notifies the listing agent, RESOLVED agents.id → users.id",
    fn.includes("listingAgentUserId") && fn.includes('.from("agents").select("user_id")'))
  check("consults no MLS number", !/mls_number/i.test(fn))
  // The literal that started this: compliance_passed must sit AFTER the gate.
  check("compliance_passed is written only past the gate",
    fn.indexOf("Cannot execute the listing agreement") < fn.indexOf("compliance_passed:"))
}

console.log("\n[one rule, not two copies of it]")
{
  const scan = src("lib/workflow/intelligence/scan-offer-packet.ts")
  // THE CONSTRUCT, not the spelling. This used to name the two ARGUMENT
  // EXPRESSIONS verbatim (`analyzeFilledPacket(filledPacket)` and
  // `analyzeFilledPacket((parsed?.filledPacket`), so re-binding the packet to a
  // differently-named local — which is all wave 11 did to the listing scan on
  // its way to fixing the lookup — read as "the shared rule was abandoned".
  // What must be true is that EACH scan reaches the one analyzer, whatever it
  // hands it; asserted by splitting the module at the listing scan.
  const boundary = scan.indexOf("export async function scanListingPacketCompleteness")
  const offerHalf   = boundary > 0 ? scan.slice(0, boundary) : scan
  const listingHalf = boundary > 0 ? scan.slice(boundary)    : ""
  check("both scans call the shared analyzer",
    boundary > 0 &&
    /analyzeFilledPacket\(/.test(offerHalf) && /analyzeFilledPacket\(/.test(listingHalf),
    "one checkpoint walking its own copy of the rule is how the two gates drift apart")
  check("…and the old inline copy of the signature rule is gone",
    !/const SIGNATURE_HINTS/.test(scan))
  check("required-vs-warning comes from the ONE settings cascade for both",
    src("lib/compliance/required-documents.ts").includes("block_on_missing"))
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  for (const f of fails) console.log(`   - ${f}`)
  console.log(" ❌ COMPLIANCE_CHECKPOINTS_FAIL — a gate that does not run is a column that lies")
  process.exit(1)
}
console.log(" ✅ COMPLIANCE_CHECKPOINTS_PASS — both checkpoints run the same compliance gate")
