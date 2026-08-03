#!/usr/bin/env tsx
/**
 * scripts/seller-document-vocabulary-simulator.ts (npm run test:seller-doc-vocabulary)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COMPLIANCE FILE HAD NO WORD FOR THE DOCUMENT THAT STARTS A LISTING.
 *
 * The classification vocabulary was buyer-shaped — pre_approval_letter,
 * proof_of_funds, lender_letter, earnest_money_receipt — and named NEITHER
 * document a seller side turns on. A brokerage could not mark the listing
 * agreement required, on the checkpoint whose whole job is to refuse a listing
 * whose paperwork is incomplete.
 *
 * OWNER'S RULING, and it is two documents, not one:
 *   · the LISTING AGREEMENT must be signed in order to take on a listing
 *   · a SELLER BROKER AGREEMENT is a DIFFERENT document from a listing
 *     agreement — a brokerage may require either, both, or neither
 *
 * m356 adds both to the live CHECK on documents.classification AND
 * brokerage_required_documents.classification, plus
 * preliminary_closing_statement — the preliminary HUD the title company or
 * closing attorney sends, which is the trigger for the agent to prepare the CDA.
 * Verified live: all three store in both tables and an invented value is still
 * refused by the CHECK.
 *
 * ── AND THE SELLER SEED WAS INSTALLING BUYER PAPERWORK ──────────────────────
 * seedRequiredDocsForBrokerage has always accepted dealType: "seller", but
 * getRequiredDocPresetsForState ignored it and returned the buyer stack
 * regardless. Seeding a seller scope therefore installed pre_approval_letter
 * and proof_of_funds as BLOCKING requirements — paperwork a seller has no way
 * to produce — so every seller file would have sat permanently blocked on
 * documents that do not exist for that side of the deal.
 */
import { readFileSync, existsSync } from "node:fs"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { getRequiredDocPresetsForState } from "../lib/compliance/required-doc-presets"
import {
  DOCUMENT_CLASSIFICATION_LABEL,
  SELLER_SIDE_CLASSIFICATIONS,
  type DocumentClassification,
} from "../lib/compliance/document-classifications"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  existsSync(p)
    ? readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
    : ""

const SELLER_ANCHORS = ["listing_agreement", "seller_broker_agreement"] as const

console.log("\n── the two seller documents are storable, and they are DISTINCT ──")
{
  const docs = CHECK_VOCABULARIES.documents?.classification ?? []
  const rules = CHECK_VOCABULARIES.brokerage_required_documents?.classification ?? []

  for (const v of SELLER_ANCHORS) {
    check(`documents.classification admits '${v}'`, docs.includes(v))
    check(`brokerage_required_documents.classification admits '${v}'`, rules.includes(v))
  }
  check("the preliminary HUD has a classification too",
    docs.includes("preliminary_closing_statement") && rules.includes("preliminary_closing_statement"))

  // THE RULING. These are two documents, not one renamed.
  check("listing_agreement and seller_broker_agreement are SEPARATE values",
    new Set<string>(SELLER_ANCHORS).size === 2 &&
    SELLER_ANCHORS.every((v) => docs.includes(v)))

  // Both tables must agree or a rule can name a value a document cannot hold.
  check("the two CHECKs carry the same vocabulary",
    docs.length > 0 && rules.length > 0 &&
    rules.every((r) => r === "other" || docs.includes(r)))
}

console.log("\n── the TypeScript union mirrors the live CHECK ──")
{
  const live = CHECK_VOCABULARIES.documents?.classification ?? []
  const declared = Object.keys(DOCUMENT_CLASSIFICATION_LABEL) as DocumentClassification[]

  // A member in the union that the CHECK rejects is a write that fails
  // silently — PostgREST resolves a refused insert.
  check(`every declared classification is storable (${declared.length} declared)`,
    declared.length > 0 && declared.every((d) => live.includes(d)))
  check("every storable classification is declared — no unlabelled value can reach a UI",
    live.every((l) => declared.includes(l as DocumentClassification)))
  check("both seller anchors carry a human label",
    SELLER_ANCHORS.every((v) => !!DOCUMENT_CLASSIFICATION_LABEL[v as DocumentClassification]))
  check("…and the labels are distinct, so the two are not confusable in a picker",
    DOCUMENT_CLASSIFICATION_LABEL.listing_agreement !== DOCUMENT_CLASSIFICATION_LABEL.seller_broker_agreement)
  check("the seller-side set names both anchors",
    SELLER_ANCHORS.every((v) => SELLER_SIDE_CLASSIFICATIONS.includes(v as DocumentClassification)))
}

console.log("\n── a seller seed installs SELLER paperwork ──")
{
  const buyer  = getRequiredDocPresetsForState("TX", "buyer")
  const seller = getRequiredDocPresetsForState("TX", "seller")
  const dual   = getRequiredDocPresetsForState("TX", "dual")
  const has = (rows: typeof buyer, c: string) => rows.some((r) => r.classification === c)

  // THE BUG. A seller has no pre-approval letter; requiring one as BLOCKING
  // leaves the file permanently unable to pass.
  const BUYER_ONLY = ["pre_approval_letter", "proof_of_funds", "lender_letter", "earnest_money_receipt"]
  check("the seller stack contains no buyer-only paperwork",
    BUYER_ONLY.every((c) => !has(seller, c)))
  check("…and it is not simply empty", seller.length >= 5)

  check("the listing agreement is BLOCKING on the seller side — the owner's rule",
    seller.find((r) => r.classification === "listing_agreement")?.block_on_missing === true)
  check("the seller broker agreement is offered separately", has(seller, "seller_broker_agreement"))
  check("…and is not blocking by default (a brokerage opts in)",
    seller.find((r) => r.classification === "seller_broker_agreement")?.block_on_missing === false)
  check("the preliminary HUD is on the seller stack as a warning",
    seller.find((r) => r.classification === "preliminary_closing_statement")?.block_on_missing === false)

  check("the BUYER stack is unchanged — still anchored on the contract",
    has(buyer, "signed_contract") && has(buyer, "pre_approval_letter"))
  check("…and carries no seller anchors", SELLER_ANCHORS.every((c) => !has(buyer, c)))

  check("a DUAL scope gets both sides",
    has(dual, "signed_contract") && has(dual, "listing_agreement"))

  check("every preset classification is storable by the live CHECK",
    [...buyer, ...seller, ...dual].every((r) =>
      (CHECK_VOCABULARIES.brokerage_required_documents?.classification ?? []).includes(r.classification)))
}

console.log("\n── the seeder passes the deal type through ──")
{
  const seeder = src("app/actions/compliance/seed-required-docs.ts")
  check("seedRequiredDocsForBrokerage forwards dealType to the resolver",
    /getRequiredDocPresetsForState\([^)]*dealType\)/.test(seeder))
  const presets = src("lib/compliance/required-doc-presets.ts")
  check("the resolver takes a deal type at all",
    /dealType:\s*"buyer" \| "seller" \| "dual"/.test(presets))
  check("…and a seller stack really exists behind it",
    /const SELLER_BASELINE: RequiredDocPreset\[\]/.test(presets))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ SELLER_DOC_VOCABULARY_FAIL"); process.exit(1) }
console.log(" ✅ SELLER_DOC_VOCABULARY_PASS — the listing agreement is requirable, and distinct from the seller broker agreement")
