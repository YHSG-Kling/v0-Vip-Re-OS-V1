#!/usr/bin/env tsx
/**
 * scripts/listing-compliance-loop-guard.ts   (npm run test:listing-compliance-loop) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COMPLIANCE GATE'S TWO ARMS ARE A LOOP THE OS RUNS ON ITS OWN.
 *
 * Owner, 2026-09-05: "after compliance gate, it either passes or fails and if
 * fails, the compliance officer, tc or agent goes and gets the missing document
 * and/or initials/signatures to upload so compliance can run again. if the
 * compliance passes, then the listing is marked coming soon with coming
 * soon/prelisting prep".
 *
 * Proved here, in the owner's order: (1) the loop asks THE gate and spells no
 * predicate; (2) FAIL names documents, signatures and initials apart, to the
 * three roles, deduped; (3) PASS walks the stage machine one allowed hop at a
 * time to COMING_SOON_PREP and never regresses; (4) UNKNOWN pages nobody and
 * moves nothing; (5) the five entry points are wired with the right trigger;
 * (6) no signature-time writer stamps coming_soon any more.
 *
 * BLIND SPOTS, published beside the result (§2): static + the stage machine's own
 * definitions. It proves the wires and the hops, not that a row moved live.
 * The re-entry fires on scanUploadedDocument; an upload path bypassing the
 * scanner does not re-enter, and this proof cannot see one.
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"
import { getStageDefinition } from "../lib/listing-lifecycle/lifecycle-definitions"

let pass = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

const LOOP    = src("lib/listings/listing-compliance-loop.ts")
const ENGINE  = src("app/actions/seller-listing/execution-engine.ts")
const KERNEL  = src("lib/kernel/listings.ts")
const SCAN    = src("lib/documents/scan-uploaded-document.ts")
const FINAL   = src("lib/esign-webhooks/finalize-packet.ts")
const DOTLOOP = src("app/api/webhooks/dotloop/route.ts")
const AUTOCR  = src("lib/workflow-orchestrator/chains/compliance-listing-auto-create.ts")

console.log("══════════════════════════════════════════════════")
console.log(" The compliance loop: fail → fix → re-run, pass → coming soon prep")
console.log("══════════════════════════════════════════════════")

console.log("\n── 1 · one gate, no second predicate (§6) ──")
check("the loop imports assertListingActivationAllowed", /assertListingActivationAllowed/.test(LOOP))
check("…and spells none of the gate's column checks itself",
  !/compliance_passed|esign_status|fully_executed_at/.test(LOOP))

console.log("\n── 2 · FAIL: name the work, tell the three roles, only when it changed ──")
check("signatures and initials are named APART (the owner names them separately)",
  /not signed/.test(LOOP) && /not initialed/.test(LOOP))
check("missing documents are named", /missing document:/.test(LOOP))
check("the audience helper is the one that already fans to tc + compliance_officer", /notifyComplianceFlag/.test(LOOP))
check("the listing agent's users.id is resolved from agents.user_id (listings.agent_id is an agents.id — §3)",
  /from\("agents"\)\.select\("user_id"\)/.test(LOOP))
check("idempotent: the blocker set is hashed and compared before paging",
  /blockers_hash/.test(LOOP) && /prior\.blockers_hash !== hash/.test(LOOP))
check("…and the live blockers are still written back even when nobody is paged", /writeGateState\(/.test(LOOP))

console.log("\n── 3 · PASS: one allowed hop at a time, never a regression ──")
{
  const prep = getStageDefinition("COMING_SOON_PREP")
  const mid  = getStageDefinition("MLS_DATE_CONFIRMED")
  check("the stage machine enters COMING_SOON_PREP from MLS_DATE_CONFIRMED (derived from lifecycle-definitions, not typed here)",
    !!prep && (prep.allowedFrom as readonly string[]).includes("MLS_DATE_CONFIRMED"))
  check("…and MLS_DATE_CONFIRMED from LISTING_AGREEMENT_SIGNED",
    !!mid && (mid.allowedFrom as readonly string[]).includes("LISTING_AGREEMENT_SIGNED"))
  check("the loop checks allowedFrom before EVERY hop (the kernel write does not)",
    /getStageDefinition\(to\)/.test(LOOP) && (LOOP.match(/allowedHop\(current, WINDOW_/g) ?? []).length === 2)
  check("the first hop needs the MLS start date on the row — it never invents one",
    /go_live_date/.test(LOOP) && /passed_awaiting_date/.test(LOOP))
  check("outside the window the loop touches nothing", /outside_window/.test(LOOP))
  check("an activation refusal still tells the roles but NEVER advances",
    /trigger !== "activation_refused"/.test(LOOP) && /if \(!inWindow\) \{\s*return \{ outcome: "outside_window"/.test(LOOP))
  check("the final hop lets the kernel ask the gate itself (the gated map, one authority)",
    /toState: WINDOW_END/.test(LOOP))
}

console.log("\n── 4 · UNKNOWN is not failure (§3/§4) ──")
check("a gate that could not run returns before any notification or transition",
  /complianceState === "unknown"[\s\S]{0,400}return \{ outcome: "unknown"/.test(LOOP))
check("a refused listing read is unknown, not 'no listing'", /rowErr[\s\S]{0,200}outcome: "unknown"/.test(LOOP))

console.log("\n── 5 · five entry points, each with the right trigger ──")
const wired = (s: string, trig: string) => new RegExp(`runListingComplianceLoop\\([\\s\\S]{0,300}?trigger:\\s*"${trig}"`).test(s)
check("markAgreementSigned → agreement_executed", wired(ENGINE, "agreement_executed"))
check("activateMLS refusal → activation_refused", wired(ENGINE, "activation_refused"))
check("launchListing refusal → activation_refused", wired(KERNEL, "activation_refused"))
check("finalize-packet webhook → agreement_executed", wired(FINAL, "agreement_executed"))
check("dotloop webhook → agreement_executed", wired(DOTLOOP, "agreement_executed"))
check("scanUploadedDocument → document_uploaded (the re-entry), guarded on doc.listing_id",
  wired(SCAN, "document_uploaded") && /listing_id\)\s*\{[\s\S]{0,200}runListingComplianceLoop/.test(SCAN))

console.log("\n── 6 · no signature-time writer stamps coming_soon any more ──")
check("finalize-packet writes stage_entered_at only after the signed transition",
  /update\(\{ stage_entered_at: now \}\)/.test(FINAL) && !/STATUS_AFTER_LISTING_AGREEMENT_GATE/.test(FINAL))
check("dotloop likewise",
  /update\(\{ stage_entered_at: now \}\)/.test(DOTLOOP) && !/STATUS_AFTER_LISTING_AGREEMENT_GATE/.test(DOTLOOP))
check("the auto-create INSERT uses the START status constant, not the passed one",
  /STATUS_AT_LISTING_AGREEMENT_SIGNED/.test(AUTOCR) && !/STATUS_AFTER_LISTING_AGREEMENT_GATE/.test(AUTOCR))

console.log("\n── CONTROLS ──")
check("POSITIVE CONTROL: the trigger finder sees a wired call", wired('await runListingComplianceLoop(db, { brokerageId, listingId, trigger: "document_uploaded" })', "document_uploaded"))
check("NEGATIVE CONTROL: …and rejects the wrong trigger", !wired('runListingComplianceLoop(db, { trigger: "agreement_executed" })', "document_uploaded"))
check("NEGATIVE CONTROL: the status-stamp finder would catch the old webhook write",
  /STATUS_AFTER_LISTING_AGREEMENT_GATE/.test('update({ status: STATUS_AFTER_LISTING_AGREEMENT_GATE, stage_entered_at: now })'))
check("BLINDNESS CONTROL: scans read comment-STRIPPED source",
  !stripComments("// runListingComplianceLoop(db, { trigger: \"document_uploaded\" })\n").includes("runListingComplianceLoop"))

console.log("\n──────────────────────────────────────────────────")
console.log(" BLIND SPOTS (§2): static + the stage machine's definitions. Proves the")
console.log(" wires and the hops, not a live row moving. Re-entry is on")
console.log(" scanUploadedDocument; an upload path bypassing the scanner does not re-enter.")
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(`\n RESULT: ${pass} passed, ${fails.length} failed`)
if (fails.length > 0) { console.log(" ❌ LISTING_COMPLIANCE_LOOP_FAIL"); process.exit(1) }
console.log(" ✅ LISTING_COMPLIANCE_LOOP_PASS — fail names the work to the three roles and re-runs on upload; pass walks to coming-soon prep")
