#!/usr/bin/env tsx
/**
 * scripts/listing-draft-gate-simulator.ts (npm run test:listing-draft-gate)
 * ─────────────────────────────────────────────────────────────────────────────
 * A LISTING IS NOT TAKEN ON UNTIL THE AGREEMENT IS SIGNED.
 *
 * OWNER'S RULING, verbatim: "that is a draft, once the agreement is signed and
 * compliance check reviews all required docs, initials, signatures before
 * creating a new listing."
 *
 * THE PROCESS WAS ALREADY BUILT — and three writers ignored it.
 *
 * The gate exists in full: app/actions/documents.ts classifies a listing
 * agreement, requires BOTH the agent's AND the seller's signatures AND initials
 * (per-role, because the aggregate "pass" can be true with one party missing),
 * then requires auditListingDocuments to report zero blocking gaps, and only
 * then emits `compliance.listing_agreement_passed`. The registered chain
 * compliance-listing-auto-create turns that into a real listing at
 * coming_soon / LISTING_AGREEMENT_SIGNED.
 *
 * WHAT WAS WRONG.
 *
 * 1. THE MANUAL DOOR SKIPPED THE GATE ENTIRELY. createListingRecord inserted
 *    status='active' at LISTING_AGREEMENT_INITIATED — the exact moment BEFORE
 *    the agreement is signed. An unsigned listing was live to buyer search and
 *    the public pages. createListingService, a second writer of the same moment,
 *    did the same. ai-listing-intake.ts had it right all along ('draft', with
 *    the comment "Becomes coming_soon when the listing agreement is signed"),
 *    which is how we know which of the three was the drift.
 *
 * 2. "NEW LISTING" DID NOT CREATE A LISTING. Both FormWizard submit controls
 *    read `mode === "offer" ? handleSubmitOffer : handleSubmitOffer` — the SAME
 *    handler on both branches. Clicking through the New Listing wizard created
 *    an OFFER row against the seller (offer_price 0, buyer contingency defaults)
 *    and no listing anywhere. There was no listing handler and no listing
 *    completion screen; step 6 rendered only for `state.offerId`.
 *
 * 3. FIXING (2) WOULD HAVE CREATED A DUPLICATE. The chain did a bare INSERT.
 *    Once the wizard parks a draft, the same property gets TWO listing rows —
 *    the draft the agent works in, and a second one the seller portal, the media
 *    pipeline and the MLS-readiness gate would each resolve differently. The
 *    chain now ADOPTS the draft, and re-asserts status='draft' in the WHERE so a
 *    concurrent run is a no-op instead of a double-fire.
 *
 * Verified live on brokerage b0000000…0001: draft inserted (CHECK admits it),
 * invisible to the status='active' surfaces, adopt-lookup found exactly it,
 * first promotion updated 1 row, second updated 0, one row left for the
 * property. Test rows removed; `ZZTEST%` residue = 0.
 */
import { readFileSync, existsSync } from "node:fs"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
/** Comments stripped: this file's own prose must never satisfy an assertion. */
const src = (p: string) =>
  existsSync(p)
    ? stripComments(readFileSync(p, "utf8"))
    : ""

const KERNEL   = src("lib/kernel/listings.ts")
const SERVICE  = src("lib/application/listings.ts")
const CHAIN    = src("lib/workflow-orchestrator/chains/compliance-listing-auto-create.ts")
const WIZARD   = src("app/components/form-wizard/FormWizard.tsx")
const ACTIONS  = src("app/actions/listings-kernel.ts")
const DOCS     = src("app/actions/documents.ts")
// CONSOLIDATED: the listing-agreement gate used to live inline in
// app/actions/documents.ts behind a branch nothing could reach. It now lives in
// its own module, which app/actions/documents.ts calls. Same gate, one home.
const GATE     = src("lib/documents/listing-agreement-gate.ts")
// …and the execution test the gate delegates to.
const EXEC     = src("lib/compliance/signature-completeness.ts")
// …and the upload path that actually invokes the gate.
const SCANNER  = src("lib/documents/scan-uploaded-document.ts")
const INTAKE   = src("app/actions/ai-listing-intake.ts")

console.log("\n── a new listing opens as a DRAFT, never live ──")
{
  // The insert that runs at LISTING_AGREEMENT_INITIATED must say draft.
  const kernelInsert = /lifecycle_stage:\s*"LISTING_AGREEMENT_INITIATED"/.test(KERNEL)
  check("the kernel still creates at agreement-initiation", kernelInsert)
  check("…and it creates it as a draft",
    /status:\s*"draft",\s*\n\s*lifecycle_stage:\s*"LISTING_AGREEMENT_INITIATED"/.test(KERNEL))
  check("…with no 'active' left on that insert",
    !/status:\s*"active",\s*\n\s*lifecycle_stage:\s*"LISTING_AGREEMENT_INITIATED"/.test(KERNEL))

  check("the second writer of the same moment agrees",
    /lifecycle_stage:\s*"LISTING_AGREEMENT_INITIATED",\s*\n\s*status:\s*"draft"/.test(SERVICE))
  check("…and no longer opens it active",
    !/lifecycle_stage:\s*"LISTING_AGREEMENT_INITIATED",\s*\n\s*status:\s*"active"/.test(SERVICE))

  // The writer that was right before this change must stay right.
  //
  // IT MOVED. This used to assert `status: "draft"` inside
  // app/actions/ai-listing-intake.ts, whose local `createListing` was the third
  // listing-creation path. That function and its only caller
  // (`runCompleteListingIntake`) were both DELETED as duplicates — neither had
  // any caller, so the "AI intake path" opened no listings at all, draft or
  // otherwise. Survivor: app/actions/listings-kernel.ts
  // `createListingWithSellerContact` → lib/kernel/listings.ts
  // `createListingRecord`, which is the KERNEL insert already proven draft two
  // checks above.
  //
  // ASSERTED AS AN ABSENCE, which is the honest form now: the intake file must
  // no longer create a listing at all. Re-checking `status: "draft"` there would
  // pass on any stray literal and prove nothing.
  check("the AI intake path no longer opens listings at all (merged onto listings-kernel)",
    !/\.from\("listings"\)\s*\n?\s*\.insert\(/.test(INTAKE))
  // Read RAW, not through src(): src() strips comments, and a tombstone IS a
  // comment. A deletion whose survivor is not named at the deletion site is how
  // the next reader concludes the capability was dropped.
  const INTAKE_RAW = readFileSync("app/actions/ai-listing-intake.ts", "utf8")
  check("…and the tombstone names the survivor",
    /createListingWithSellerContact/.test(INTAKE_RAW) &&
    /app\/actions\/listings-kernel\.ts/.test(INTAKE_RAW))

  // Going live is a DIFFERENT moment and must keep its 'active'.
  check("launch still publishes the listing for real",
    /status:\s*"active",\s*\n\s*lifecycle_stage:\s*"MLS_ACTIVE"/.test(KERNEL))
}

console.log("\n── only signed + compliance-cleared promotes it ──")
{
  // The emitter must demand BOTH parties' signatures AND initials, then a clean
  // required-document audit. Either half missing re-opens the bypass.
  // ASSERT THE CONSTRUCT, NOT THE OLD SPELLING. These three used to scan
  // app/actions/documents.ts for two named booleans and a `!sigGap && !initGap`
  // expression. The gate has since been consolidated into its own module and the
  // execution test extracted into evaluateExecution, so the literals are gone —
  // but the REQUIREMENT is unchanged and in fact stricter. Pinning the old
  // spelling would have blocked a correct consolidation; pinning the requirement
  // still catches anyone weakening it.
  check("both parties' signatures and initials are required",
    // the gate defers to the one execution test…
    /evaluateExecution\(/.test(GATE) &&
    // …which demands, PER PARTY, a signature AND initials…
    /for \(const party of parties\)/.test(EXEC) &&
    /\.signed === true/.test(EXEC) &&
    /\.all_required_initials_present === true/.test(EXEC) &&
    // …and refuses anything that is merely truthy. `=== true` is the whole point:
    // the string "false" and the number 1 must not read as a signature.
    /=== true/.test(EXEC) &&
    // …across BOTH parties, not just the seller.
    /LISTING_AGREEMENT_PARTIES/.test(EXEC))
  check("…and every required document must be present",
    /auditListingDocuments/.test(GATE) && /missing_blocking\.length > 0/.test(GATE))
  check("…before the pass event is emitted at all",
    /compliance\.listing_agreement_passed/.test(GATE))
  // The consolidation must be real: ONE live caller, and no second copy left
  // behind in app/actions/documents.ts. Two gates that can disagree is exactly the
  // defect this replaced, and the branch in documents.ts was unreachable anyway.
  check("…the gate has a live caller on the upload path",
    /runListingAgreementGate\(/.test(SCANNER))
  // documents.ts still PRODUCES the signature payload — that is its job; the scan
  // prompt names those booleans and the parse fallback sets them. What it must not
  // do is DECIDE on them a second time. Banning the names outright would have
  // banned the producer, so assert the absence of a second verdict instead.
  check("…and app/actions/documents.ts does not re-decide the verdict itself",
    !/allRequiredSignaturesPresent\s*===/.test(DOCS) &&
    !/allRequiredInitialsPresent\s*===/.test(DOCS) &&
    !/evaluateExecution\(/.test(DOCS))
  // A scan that could not be parsed must not read as "signed".
  check("…and an unparseable scan falls back to NOT signed",
    /allRequiredSignaturesPresent:\s*false/.test(DOCS) &&
    /allRequiredInitialsPresent:\s*false/.test(DOCS))
  check("the chain listens for exactly that event",
    /triggerEvent:\s*"compliance\.listing_agreement_passed"/.test(CHAIN))
  check("…and promotes to the signed stage",
    /lifecycle_stage:\s*"LISTING_AGREEMENT_SIGNED"/.test(CHAIN))
}

console.log("\n── the signed agreement adopts the draft, it does not duplicate it ──")
{
  check("the chain looks for this seller's draft first",
    /\.eq\("status",\s*"draft"\)/.test(CHAIN) &&
    /\.eq\("seller_contact_id",\s*ctx\.contactId\)/.test(CHAIN))
  check("…scoped to the asking brokerage",
    /\.eq\("brokerage_id",\s*ctx\.brokerageId\)/.test(CHAIN))
  check("…matched on the property, not just the seller",
    /draftAddress/.test(CHAIN) && /existingDraft/.test(CHAIN))
  check("…and promotes that row in place",
    /const promotion = \{[\s\S]{0,700}?status:\s*"coming_soon"/.test(CHAIN) &&
    /\.update\(promotion\)\s*\n\s*\.eq\("id",\s*existingDraft\.id\)/.test(CHAIN))
  check("…with the tenant anchor on the WRITE, not just the read",
    /\.update\(promotion\)[\s\S]{0,200}?\.eq\("brokerage_id",\s*ctx\.brokerageId\)/.test(CHAIN))

  // Without re-asserting draft in the WHERE, two runs both "succeed" and the
  // listing fans out its creation event twice.
  check("a concurrent second run is a no-op, not a double-fire",
    /\.update\(promotion\)[\s\S]{0,300}?\.eq\("status",\s*"draft"\)/.test(CHAIN))
  check("…and an already-promoted row is not reported as a failure",
    /alreadyPromoted/.test(CHAIN))

  // The no-draft door — a signed agreement arriving cold — must still work.
  check("a signed agreement with no draft ahead of it still creates one",
    /\.from\("listings"\)\s*\n\s*\.insert\(\{/.test(CHAIN))
}

console.log("\n── 'New Listing' creates a listing, not an offer ──")
{
  // THE DEFECT: identical branches on both submit controls.
  check("no submit control has two identical branches",
    !/mode === "offer" \? handleSubmitOffer : handleSubmitOffer/.test(WIZARD))
  check("the listing lane has its own handler",
    /const handleSubmitListing = useCallback/.test(WIZARD))
  check("…and it creates a listing",
    /handleSubmitListing[\s\S]{0,2000}?createListingWithSellerContact\(/.test(WIZARD))
  check("…never an offer",
    !/handleSubmitListing[\s\S]{0,2000}?createOffer\(/.test(WIZARD))

  // Both controls — the step-5 panel and the footer button — must route by mode.
  const routed = WIZARD.match(/mode === "offer" \? handleSubmitOffer : handleSubmitListing/g) ?? []
  check("both submit controls route by mode", routed.length === 2)

  check("the listing lane has a completion screen of its own",
    /step === 6 && mode === "listing" && state\.listingId/.test(WIZARD))
  check("…and the offer screen no longer answers for both",
    /step === 6 && mode === "offer" && state\.offerId/.test(WIZARD))
  // The button must not claim to send an envelope it does not send.
  check("the listing button does not promise an e-sign send",
    /mode === "offer" \? "Send for E-Sign" : "Create Draft Listing"/.test(WIZARD))
}

console.log("\n── an MLS number is not a listing id ──")
{
  // offers.listing_id is uuid. The MLS text input was bound straight to it, so
  // an agent who filled the field in got a failed insert.
  check("the MLS input no longer writes the listing-id slot",
    !/update\("listingId",\s*e\.target\.value\)/.test(WIZARD))
  check("…it has its own field",
    /update\("mlsNumber",\s*e\.target\.value\)/.test(WIZARD))
  check("…which is translated to a real listing id before the offer write",
    /resolveListingIdByMlsAction\(/.test(WIZARD) && /listing_id:\s*resolvedListingId/.test(WIZARD))
  check("the resolver is tenant-scoped",
    /resolveListingIdByMlsAction[\s\S]{0,900}?\.eq\("brokerage_id",\s*ctx\.brokerageId\)/.test(ACTIONS))
  check("…and no match does not block the offer",
    /resolveListingIdByMlsAction[\s\S]{0,900}?listingId:\s*data\?\.id \?\? null/.test(ACTIONS))
  // MLS belongs to LAUNCH — asking for it at agreement-initiation is the wrong stage.
  check("the listing lane does not ask for an MLS number",
    /mode === "offer" && \(\s*\n?\s*<div className="space-y-1">\s*\n?\s*<Label>MLS/.test(WIZARD))
}

console.log("\n── the database still admits every value we write ──")
{
  const status = CHECK_VOCABULARIES.listings?.status ?? []
  const stages = CHECK_VOCABULARIES.listings?.lifecycle_stage ?? []
  check("'draft' is storable", status.includes("draft"))
  check("'coming_soon' is storable", status.includes("coming_soon"))
  check("'active' is still storable for launch", status.includes("active"))
  check("LISTING_AGREEMENT_INITIATED is storable", stages.includes("LISTING_AGREEMENT_INITIATED"))
  check("LISTING_AGREEMENT_SIGNED is storable", stages.includes("LISTING_AGREEMENT_SIGNED"))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ LISTING_DRAFT_GATE_FAIL"); process.exit(1) }
console.log(" ✅ LISTING_DRAFT_GATE_PASS — a listing opens as a draft and is taken on only when the signed agreement clears compliance")
