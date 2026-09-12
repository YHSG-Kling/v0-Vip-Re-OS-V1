#!/usr/bin/env tsx
/**
 * scripts/listing-documents-gate-simulator.ts  (npm run test:listing-documents-gate)
 * ─────────────────────────────────────────────────────────────────────────────
 * A LISTING WITH NO PAPERWORK AT ALL PASSED "DOCUMENTS VERIFIED".
 *
 * The owner's rule for this checkpoint is explicit: a signed listing agreement
 * requires all signed documents from both sides, all required brokerage / team /
 * agent documents, where required-vs-warning is a SETTING, and any missing item
 * notifies the TC and/or the listing agent.
 *
 * Two paths claimed to enforce it, and the wrong one was the one agents use.
 *
 *  · markAgreementSigned (execution-engine) runs auditListingDocuments +
 *    scanListingPacketCompleteness — the real gate. It had NO callers.
 *  · evaluateReadinessChecks → checkDocumentsVerified is what the StagePipeline
 *    and StageAdvanceModal actually run, and it only asked whether the documents
 *    ATTACHED to the listing were in a terminal status. With ZERO documents the
 *    filter is empty, `unverified === 0`, and it returned passed: true.
 *
 * VERIFIED LIVE on a real listing carrying no documents:
 *   docs_attached 0 · required_total 2 · missing_blocking 1 · missing_warning 1
 *   OLD gate passes: TRUE      ← the bypass
 *   NEW gate passes: FALSE     ← blocked
 * and after supplying only the BLOCKING document:
 *   missing_blocking 0 · missing_warning 1 · gate passes: TRUE
 * so a warning-level requirement correctly does not block, exactly as the
 * setting says.
 *
 * The readiness check now runs the SAME canonical audit the execution
 * checkpoint runs, resolved against the same identity (listings.agent_id is
 * agents.id → users.id, never substituted), so the two cannot disagree about
 * what "required" means for a listing.
 *
 * NOTED, NOT FIXED — brokerage_required_documents.classification is CHECK-
 * constrained and has no `listing_agreement` value, so a brokerage cannot today
 * mark the listing agreement itself as a required seller document. Extending
 * that vocabulary is a schema decision for the owner, not a guard fix.
 */
import { readFileSync, existsSync } from "node:fs"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  existsSync(p)
    ? stripComments(readFileSync(p, "utf8"))
    : ""

/** Body of a named function, skipping its parameter list and return type. */
const fnBody = (text: string, name: string): string => {
  const start = text.search(new RegExp(`(async\\s+)?function\\s+${name}\\b`))
  if (start < 0) return ""
  const paren = text.indexOf("(", start)
  if (paren < 0) return ""
  let pDepth = 0, afterParams = -1
  for (let i = paren; i < text.length; i++) {
    if (text[i] === "(") pDepth++
    else if (text[i] === ")" && --pDepth === 0) { afterParams = i + 1; break }
  }
  if (afterParams < 0) return ""
  let aDepth = 0, open = -1
  for (let i = afterParams; i < text.length; i++) {
    const c = text[i]
    if (c === "<") aDepth++
    else if (c === ">") aDepth = Math.max(0, aDepth - 1)
    else if (c === "{" && aDepth === 0) { open = i; break }
  }
  if (open < 0) return ""
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1)
  }
  return text.slice(open)
}

const checker = src("lib/listing-lifecycle/readiness-checker.ts")
const gate = fnBody(checker, "checkDocumentsVerified")

console.log("\n── the gate an agent actually hits runs the REQUIRED-DOCS audit ──")
{
  check("checkDocumentsVerified exists", gate.length > 0)

  // THE WHOLE POINT. Counting attached documents can never notice an ABSENT
  // one, so presence must be decided against the resolved requirement list.
  check("it resolves the brokerage's required-document checklist",
    /auditListingDocuments\(/.test(gate))
  check("…and blocks on a MISSING blocking requirement, not just on an unfinished attachment",
    /missing_blocking\.length === 0/.test(gate))
  check("…while a warning-level requirement does NOT block",
    !/missing_warning\.length === 0/.test(gate) && /missing_warning/.test(gate))
  check("…and the attached-status check is still enforced alongside it",
    /unverifiedDocs\.length === 0/.test(gate))

  // The failure the whole check exists to catch.
  //
  // ASSERTED AS A RULE, NOT AS AN ADJACENCY (CLAUDE.md §2 — "do not pin an
  // assertion to a WAYPOINT"). This used to require the literal
  // `missing_blocking.length === 0 && unverifiedDocs.length === 0`, i.e. those
  // two terms SIDE BY SIDE. The owner's 2026-09-04 ruling ("same compliance gate
  // when a listing becomes an active listing") added a third conjunct —
  // `unexecuted.length === 0`, the signature/initial half — BETWEEN them, and
  // this assertion went red because the gate it guards got STRONGER. That is the
  // §2 failure mode exactly: an assertion that can only pass while the work is
  // unfinished. What actually matters is that each term GATES `passed`, not what
  // order they appear in or what else is conjoined with them.
  // The LAST `passed:` in the body is the real verdict — the earlier ones are
  // the fail-closed early returns (`passed: false`), and matching the first is
  // how this read "false" and reported every term missing.
  const passedExprs = Array.from(gate.matchAll(/passed:\s*([\s\S]*?),\s*reason:/g)).map(m => m[1])
  const passedExpr = passedExprs.length ? passedExprs[passedExprs.length - 1] : ""
  const conjuncts = [
    { name: "a MISSING blocking requirement", re: /audit\.missing_blocking\.length === 0/ },
    { name: "an unfinished ATTACHMENT",       re: /unverifiedDocs\.length === 0/ },
    { name: "an audit that could not RUN",    re: /!audit\.unavailable_reason/ },
  ]
  const absent = conjuncts.filter(c => !c.re.test(passedExpr)).map(c => c.name)
  check(
    `an empty document set can no longer satisfy the gate on its own (every term gates \`passed\`${absent.length ? `; MISSING: ${absent.join(", ")}` : ""})`,
    passedExpr.length > 0 && absent.length === 0,
  )
  // POSITIVE CONTROL — prove the finder above still recognises the defect it was
  // written for. A regex that matches nothing and a clean tree both report zero.
  check("…and that finder still catches a `passed` that ignores the required-docs audit",
    (() => {
      const defective = "passed: unverifiedDocs.length === 0,\n    reason:"
      const expr = (defective.match(/passed:\s*([\s\S]*?),\s*reason:/) ?? [])[1] ?? ""
      return expr.length > 0 && !/audit\.missing_blocking\.length === 0/.test(expr)
    })())
}

console.log("\n── it cannot disagree with the execution checkpoint ──")
{
  const engine = src("app/actions/seller-listing/execution-engine.ts")
  check("markAgreementSigned still runs the same audit",
    /auditListingDocuments\(/.test(engine))
  check("…and the packet scan", /scanListingPacketCompleteness\(/.test(engine))
  check("…and still refuses to execute the agreement on a failure",
    /Cannot execute the listing agreement/.test(engine))

  // Same inputs, or the two gates answer different questions about one listing.
  // Read the KEYS of each auditListingDocuments call rather than matching
  // `field:` — an object shorthand (`teamId,`) has no colon and is the same
  // argument. Assert the argument, not the punctuation.
  const auditKeys = (text: string): Set<string> => {
    const call = /auditListingDocuments\([\s\S]*?\{([\s\S]*?)\}\)/.exec(text)?.[1] ?? ""
    return new Set([...call.matchAll(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*(?::|,|$)/gm)].map((m) => m[1]))
  }
  const gateKeys = auditKeys(gate)
  const engineKeys = auditKeys(engine)
  for (const field of ["brokerageId", "sellerContactId", "agentUserId", "teamId", "stateCode", "listingId"]) {
    check(`both pass ${field} to the audit`, gateKeys.has(field) && engineKeys.has(field))
  }
}

console.log("\n── the seller is read from the column that is actually populated ──")
{
  // Raised in review on the neighborhood-report fallback, and the SAME column
  // mistake was in both listing checkpoints: listings.contact_id exists but is
  // not populated (0 of 3 rows live carry it; seller_contact_id does), so
  // sellerContactId was always null and the audit silently skipped every
  // document filed against the seller's CONTACT record rather than the listing.
  const engine2 = src("app/actions/seller-listing/execution-engine.ts")
  for (const [label, text] of [["the readiness gate", gate], ["markAgreementSigned", engine2]] as const) {
    check(`${label} reads seller_contact_id`, /seller_contact_id/.test(text))
    check(`…${label} does not pass contact_id alone as the seller`,
      !/sellerContactId:\s*\(?(listing|listingRow)\??\.contact_id/.test(text))
  }
}

console.log("\n── identity is RESOLVED, never substituted ──")
{
  // listings.agent_id is agents.id; auditListingDocuments wants users.id. A
  // substitution here silently resolves a DIFFERENT agent's requirements.
  check("agents.id is exchanged for users.id before the audit",
    /from\("agents"\)[\s\S]{0,120}?\.select\("user_id"\)[\s\S]{0,120}?\.eq\("id", listing\.agent_id\)/.test(gate))
  check("…and the agent id is never passed straight through as a user id",
    !/agentUserId:\s*listing\.agent_id/.test(gate))
}

console.log("\n── an unresolvable gate BLOCKS, it does not fall through ──")
{
  check("a listing with no brokerage is refused rather than passed",
    /Listing has no brokerage on file/.test(gate) &&
    /check: "documents_verified",\s*\n\s*passed: false/.test(gate))
  check("a failed listing read is refused too", /Error reading the listing/.test(gate))
  check("a failed documents read was already refused", /Error checking documents/.test(gate))
}

console.log("\n── the surface can say WHAT is missing, not just that it failed ──")
{
  check("the blocking classifications are named in the reason",
    /required document\(s\) missing/.test(gate))
  check("…and the details carry both lists for the UI",
    /missing_blocking,/.test(gate) && /missing_warning,/.test(gate))
  check("…plus the required total, so 'nothing required' is distinguishable from 'nothing checked'",
    /required_total: audit\.required_total/.test(gate))

  const modal = src("app/components/dashboard/listings/lifecycle/stage-advance-modal.tsx")
  check("the advance modal reports real pass/fail from validateListingTransition",
    /validateListingTransition\(/.test(modal))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ LISTING_DOCUMENTS_GATE_FAIL"); process.exit(1) }
console.log(" ✅ LISTING_DOCUMENTS_GATE_PASS — a listing with no paperwork can no longer pass 'documents verified'")
