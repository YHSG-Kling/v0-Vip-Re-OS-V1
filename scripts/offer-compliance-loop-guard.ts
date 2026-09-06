#!/usr/bin/env tsx
/**
 * scripts/offer-compliance-loop-guard.ts   (npm run test:offer-compliance-loop) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OFFER SIDE OF THE COMPLIANCE LOOP RUNS ON ITS OWN, LIKE THE LISTING SIDE.
 *
 * Owner, 2026-09-06: "make sure this compliance gate is autonomously also looped
 * for offers turning into active transactions after pass and if fail, same as
 * the listing autonomous loop."
 *
 * Proved here: (1) the loop spells no predicate and no gate — it imports the one
 * execute predicate and calls the one driver, which calls the one gate; (2) FAIL
 * is idempotent INSIDE the gate's block arm, so every caller is deduped; (3) PASS
 * is the gate's own transaction creation, not a second one; (4) UNKNOWN records
 * nothing as failure; (5) the five doors are wired with the right trigger; (6)
 * dotloop stamps the predicate's columns, not only esign_status.
 *
 * BLIND SPOTS, published beside the result (§2): static. Proves the wires and the
 * hash rule, not a live offer converting. The re-entry fires on
 * scanUploadedDocument; an upload path bypassing the scanner does not re-enter.
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"

let pass = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

const LOOP    = src("lib/transactions/offer-compliance-loop.ts")
const DRIVER  = src("lib/transactions/auto-execute-offer.ts")
const GATE    = src("app/actions/buyer-offer/submit-to-compliance.ts")
const SCAN    = src("lib/documents/scan-uploaded-document.ts")
const FINAL   = src("lib/esign-webhooks/finalize-packet.ts")
const DOTLOOP = src("app/api/webhooks/dotloop/route.ts")
const SELLER  = src("app/actions/buyer-offer/record-seller-response.ts")

console.log("══════════════════════════════════════════════════")
console.log(" The offer compliance loop: executed → gate → transaction, fail → fix → re-run")
console.log("══════════════════════════════════════════════════")

console.log("\n── 1 · one predicate, one driver, one gate (§6) ──")
check("the loop imports shouldAutoExecuteOffer (the one definition of fully-executed-by-both)",
  /import \{ shouldAutoExecuteOffer \} from "\.\/offer-execution-state"/.test(LOOP))
check("…and spells no execution predicate of its own",
  !/seller_response_type === "accepted"|!o\.buyer_signed_at|fully_signed_contract_received_at &&/.test(LOOP))
check("the loop calls the ONE driver", /autoExecuteFullySignedOffer\(offerId/.test(LOOP))
check("…which calls the ONE gate", /submitOfferToCompliance\(\{ offerId, userId: agentUserId \}\)/.test(DRIVER))
check("the loop never calls the gate or the bridge directly (no second door around the driver)",
  !/submitOfferToCompliance|createTransactionFromOffer/.test(LOOP))

console.log("\n── 2 · FAIL is idempotent INSIDE the gate's block arm (so every caller is deduped) ──")
check("the block arm hashes the blocker set", /blockersHash = createHash\("sha256"\)/.test(GATE))
check("…compares it to the prior hash on offers.metadata.compliance_gate",
  /priorGate\.blockers_hash !== blockersHash/.test(GATE))
check("…and pages notifyComplianceFlag ONLY when the set changed",
  /if \(blockerSetChanged\) \{\s*await notifyComplianceFlag\(/.test(GATE))
check("the blocker set names documents, unexecuted required documents and packet blockers (three families, one list)",
  /missing document: \$\{d\}/.test(GATE) && /not fully executed: \$\{s\}/.test(GATE) && /packet: \$\{b\.title\}/.test(GATE))
check("the live blockers are written back even when nobody is paged (counted, tenant-filtered — §3)",
  /compliance_gate: \{\s*state: "blocked", blockers, blockers_hash: blockersHash/.test(GATE)
  && /\.eq\("brokerage_id", offer\.brokerage_id as string\)\s*\.select\("id"\)/.test(GATE)
  && /gateRows\.length === 0/.test(GATE))
check("the gate's offer select carries metadata (the hash has to be readable to be compared)",
  /\.select\("[^"]*\bmetadata\b[^"]*"\)/.test(GATE))

console.log("\n── 3 · PASS is the gate's own transaction, recorded once ──")
check("the loop reports `advanced` only from the driver's `created`",
  /if \(created\) \{[\s\S]{0,400}outcome: "advanced"/.test(LOOP))
check("…and records transaction_id on the offer's gate state", /transaction_id: transactionId \?\? null/.test(LOOP))
check("the pass state merges the prior gate record rather than clobbering the hash", /\.\.\.prior, state: "passed"/.test(LOOP))

console.log("\n── 4 · UNKNOWN is not failure; outside the window nothing moves (§3/§4) ──")
check("a refused offer read is unknown, not 'no offer'", /rowErr[\s\S]{0,200}outcome: "unknown"/.test(LOOP))
check("an already-converted offer is left alone", /o\.transaction_id\) \{\s*return \{ outcome: "outside_window"/.test(LOOP))
check("a not-yet-executed offer is left alone", /!shouldAutoExecuteOffer\(o\)\) \{\s*return \{ outcome: "outside_window"/.test(LOOP))
check("a driver that did not attempt the gate is recorded as unknown, not blocked",
  /!attempted && !created[\s\S]{0,400}state: "unknown"[\s\S]{0,200}outcome: "unknown"/.test(LOOP))
check("the loop's gate-state write is counted and tenant-filtered",
  /from\("offers"\)\s*\.update\(\{ metadata: \{ \.\.\.meta, compliance_gate: gateState \}[\s\S]{0,200}\.eq\("brokerage_id", brokerageId\)\s*\.select\("id"\)/.test(LOOP))

console.log("\n── 5 · five doors, each with the right trigger ──")
const wired = (s: string, trig: string) => new RegExp(`runOfferComplianceLoop\\([\\s\\S]{0,300}?trigger:\\s*"${trig}"`).test(s)
check("finalize-packet (counter fully executed) → agreement_executed", wired(FINAL, "agreement_executed"))
check("…placed after the fully_signed + accepted stamp, not before it",
  /status:\s*"accepted",\s*\}\)\s*\.eq\("id", matchedOffer\.id\)[\s\S]{0,600}runOfferComplianceLoop/.test(FINAL))
check("dotloop (loop fully signed) → agreement_executed", wired(DOTLOOP, "agreement_executed"))
check("record-seller-response (accepted) → agreement_executed, through the loop and not the bare driver",
  wired(SELLER, "agreement_executed") && !/autoExecuteFullySignedOffer/.test(SELLER))
check("scanUploadedDocument → document_uploaded (the re-entry), keyed on metadata.linked_offer_id",
  wired(SCAN, "document_uploaded") && /linkedOfferId = \(\(doc as any\)\.metadata\?\.linked_offer_id/.test(SCAN))
// Emailed pages are scanned on ARRIVAL, before they carry an offer link, so the
// scanner's re-entry ran for no offer; the linker is the moment they start
// counting and re-enters once per offer, after the loop over pages.
const INTAKE = src("lib/inbound-mail/offer-intake.ts")
check("linkInboundDocumentsToOffer → document_uploaded, once per offer after the pages are linked",
  wired(INTAKE, "document_uploaded") && /linkedDocumentIds\.length > 0\) \{[\s\S]{0,300}runOfferComplianceLoop/.test(INTAKE))

console.log("\n── 6 · dotloop stamps the columns the predicate READS ──")
check("dotloop's offer select carries the three execution columns",
  /select\("id, contact_id, brokerage_id, transaction_id, buyer_signed_at, seller_signed_at, fully_signed_contract_received_at"\)/.test(DOTLOOP))
check("…and stamps each only where empty (a leg a human recorded is never overwritten)",
  /buyer_signed_at:\s*\(matchedOffer as any\)\.buyer_signed_at \?\? now/.test(DOTLOOP)
  && /seller_signed_at:\s*\(matchedOffer as any\)\.seller_signed_at \?\? now/.test(DOTLOOP)
  && /fully_signed_contract_received_at:\s*\(matchedOffer as any\)\.fully_signed_contract_received_at \?\? now/.test(DOTLOOP))
check("…reading the write's error before entering the loop", /offerStampError/.test(DOTLOOP) && /!offerStampError && /.test(DOTLOOP))

console.log("\n── CONTROLS ──")
check("POSITIVE CONTROL: the trigger finder sees a wired call",
  wired('await runOfferComplianceLoop(db, { brokerageId, offerId, trigger: "document_uploaded" })', "document_uploaded"))
check("NEGATIVE CONTROL: …and rejects the wrong trigger",
  !wired('runOfferComplianceLoop(db, { trigger: "agreement_executed" })', "document_uploaded"))
check("POSITIVE CONTROL: the bare-driver finder would catch a door that skipped the loop",
  /autoExecuteFullySignedOffer/.test('await autoExecuteFullySignedOffer(offerId, supabase)'))
check("POSITIVE CONTROL: the dedupe finder rejects an unconditional page",
  !/if \(blockerSetChanged\) \{\s*await notifyComplianceFlag\(/.test('await notifyComplianceFlag(supabase, {'))
check("BLINDNESS CONTROL: scans read comment-STRIPPED source",
  !stripComments("// runOfferComplianceLoop(db, { trigger: \"document_uploaded\" })\n").includes("runOfferComplianceLoop"))

console.log("\n──────────────────────────────────────────────────")
console.log(" BLIND SPOTS (§2): static. Proves the wires and the hash rule, not a live")
console.log(" offer converting. Re-entry is on scanUploadedDocument; an upload path")
console.log(" bypassing the scanner does not re-enter. dotloop's stamp is the provider's")
console.log(" word for both legs.")
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(`\n RESULT: ${pass} passed, ${fails.length} failed`)
if (fails.length > 0) { console.log(" ❌ OFFER_COMPLIANCE_LOOP_FAIL"); process.exit(1) }
console.log(" ✅ OFFER_COMPLIANCE_LOOP_PASS — executed offers gate to a transaction on their own; fail names the work once and re-runs on upload")
