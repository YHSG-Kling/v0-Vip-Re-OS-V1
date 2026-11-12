/**
 * lib/listings/listing-activation-gate.ts
 *
 * THE ONE PLACE THAT DECIDES A LISTING MAY GO ACTIVE.
 *
 * Owner's rule, verbatim (2026-09-04):
 *
 *   "compliance is involved when an offer gates to create a transaction once the
 *    offer is fully executed by both buyer and seller, the compliance gate runs
 *    through the documents against an approved checklist provided by the
 *    brokerage to make sure all documents are present and that all signatures
 *    and initials are present, then the executed offer becomes a transaction,
 *    wether we represent the seller, or/and the buyer. SAME COMPLIANCE GATE WHEN
 *    A LISTING BECOMES AN ACTIVE LISTING."
 *
 * The last sentence is this module. It is the listing-side twin of
 * lib/transactions/transaction-creation-gate.ts and asks the SAME four
 * questions, in the listing's vocabulary:
 *
 *   1. COMPLIANCE IS GOOD — the listing agreement for this listing was executed
 *      through the checkpoint that actually runs a compliance audit
 *      (app/actions/seller-listing/execution-engine.ts::markAgreementSigned),
 *      evidenced by a `listing_agreements` row carrying compliance_passed=true
 *      and an esign_status at or past ALL-SIGNED on the ladder (wave 143, lane
 *      143A: `fully_executed_at` is the stamp of the ladder's `fully_executed`
 *      hop, which lands only AFTER compliance approval, so it is no longer an
 *      input to this question — see readListingCompliance). A listing with no
 *      agreement to point at has no compliance evidence at all, and "no
 *      evidence" is a REFUSAL, never a pass — exactly as the offer side treats a
 *      deal with no offer.
 *   2. EVERY REQUIRED DOCUMENT IS PRESENT — required by SETTINGS
 *      (`brokerage_required_documents`, resolved agent → team → brokerage,
 *      state-scoped, dealType "seller"), never by a list hardcoded here.
 *   3. EACH OF THOSE DOCUMENTS IS FULLY SIGNED.
 *   4. INITIALS ARE COMPLETE — tracked SEPARATELY, because the owner names them
 *      separately and a TC chasing a signature is not chasing an initial.
 *
 * ── WHY ["agent","seller"] AND NOT ["buyer","seller"] ────────────────────────
 * findUnexecutedDocuments defaults to TRANSACTION_CONTRACT_PARTIES —
 * ["buyer","seller"] — which is right for a purchase contract and WRONG here,
 * and the difference is not cosmetic.
 *
 * A listing is a contract between the SELLER and the BROKERAGE, executed by the
 * listing agent on the brokerage's behalf. LISTING_AGREEMENT_PARTIES
 * (lib/compliance/signature-completeness.ts) is exactly that pair, and it is
 * already the pair the document-scan gate
 * (lib/documents/listing-agreement-gate.ts) and the execution checkpoint use.
 *
 * At the moment a listing goes ACTIVE there is NO BUYER. The property has not
 * been shown, let alone sold; `documents.signature_completeness` on seller-side
 * paperwork carries no buyer role and never will. Passing the transaction
 * default here would demand a buyer signature and a buyer initial on every
 * seller document, which no listing can ever satisfy — so EVERY listing in
 * every brokerage would become permanently un-activatable. That is a refusal
 * the owner did not ask for, and a gate that refuses everything teaches people
 * to route around it. The parties are therefore passed EXPLICITLY below rather
 * than left to the default.
 *
 * ── FAIL CLOSED (CLAUDE.md §4) ───────────────────────────────────────────────
 * "A gate that cannot run must refuse, not pass." Every read destructures
 * `{ data, error }` and READS the error, because supabase-js RESOLVES refusals
 * (CLAUDE.md §3). A refused listing read, a refused agreement read, an
 * unavailable document audit, an unscanned document — each is a REFUSAL
 * carrying its reason, never an empty verdict that reads as clean.
 * `requiredTotal` travels beside the verdict so "nothing required" stays
 * distinguishable from "nothing checked" (the finding-#105 shape).
 *
 * ── TENANCY (CLAUDE.md §4) ──────────────────────────────────────────────────
 * `brokerageId` is the tenant anchor and must be THE SESSION'S — never a
 * request body's. The gate re-reads the listing's own brokerage_id and refuses a
 * mismatch, so a caller that got it wrong cannot walk another tenant's file.
 *
 * ── ONE VOCABULARY (CLAUDE.md §6) ───────────────────────────────────────────
 * Nothing here is a second compliance system. `GateRequirement`, `GateRefusal`
 * and `UnexecutedDocument` are IMPORTED from the transaction gate rather than
 * re-declared, so the two gates cannot drift into two spellings of one verdict,
 * and `findUnexecutedDocuments` is the same pure function the offer side runs.
 * The checklist and the deal-file reader are lib/compliance/required-documents.ts;
 * "is it actually signed AND initialed" is lib/compliance/signature-completeness.ts.
 *
 * NOT `server-only`: the simulator drives it with an injected client, like the
 * rest of the kernel loaders. It writes nothing — it is a pure decision over
 * reads.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { LISTING_AGREEMENT_PARTIES } from "@/lib/compliance/signature-completeness"
import {
  auditListingDocuments,
  documentClassificationLabel,
  type AuditResult,
} from "@/lib/compliance/required-documents"
// The verdict vocabulary is the TRANSACTION gate's. Imported, never re-spelled:
// the owner ruled these are the SAME gate, so they answer in the same words.
import {
  findUnexecutedDocuments,
  buildGateRefusal,
  offerChecklistDimensions,
  type GateRefusal,
  type GateRequirement,
  type UnexecutedDocument,
} from "@/lib/transactions/transaction-creation-gate"
// The executed-agreement spelling lives with the status vocabulary that owns it,
// so a widened CHECK fails that module's proof instead of silently passing here.
import { LISTING_AGREEMENT_EXECUTED_STATUS } from "@/lib/transactions/coordination-status"
// wave 142 (lane 142K finding 1): the e-sign mark is read on the LADDER — compliance_pending / correction_required /
// compliance_approved / fully_executed are all PAST all-signed; pinning the pre-ladder literal refused every listing the
// compliance loop had touched, forever.
import { isAtOrPastAllSigned } from "@/lib/esign/packet-states"

export type { GateRequirement, GateRefusal, UnexecutedDocument }

export interface ListingActivationGateResult {
  allowed: boolean
  /** Every obligation that refused, in the owner's order. Empty when allowed. */
  refusals: GateRefusal[]
  /** One sentence a caller can put in an error/notification verbatim. */
  reason: string
  detail: {
    complianceState: "passed" | "not_passed" | "unknown"
    /** null when the checklist could not be read — NOT zero. */
    requiredTotal: number | null
    missingRequired: string[]
    /** Present but not fully executed (signatures and/or initials). */
    unexecuted: UnexecutedDocument[]
    /** Non-blocking checklist misses, passed through for the caller's notice. */
    missingWarning: string[]
    /** What established compliance, when it did. */
    complianceEvidence: string[]
    checkedAt: string
  }
}

export interface ListingActivationGateParams {
  /** THE SESSION'S brokerage. Never a request body's. */
  brokerageId: string
  listingId: string
  /** Who/what is asking, for the refusal text ("MLS activation"). */
  door?: string
  /**
   * THIS RUN IS THE COMPLIANCE REVIEW ITSELF (wave 143, lane 143A — closes 142K finding 5). Only
   * lib/listings/listing-compliance-loop.ts sets it, and only while the listing sits between
   * LISTING_AGREEMENT_SIGNED and COMING_SOON_PREP.
   *
   * Obligation 1 asks "has the agreement cleared compliance?" — `compliance_passed`. For an agreement
   * that came back through the e-sign PROVIDER, nothing has stamped that yet: the review that stamps it
   * IS this run (obligations 2-4 below are its audit), so demanding the stamp as an INPUT to its own
   * decision refused every provider-signed agreement forever. In review mode obligation 1 therefore asks
   * for what the provider can truthfully say — the packet is at or past ALL-SIGNED on the ladder, with
   * both parties' signature evidence on the row — and the loop writes `compliance_passed` (and, one hop
   * later, `fully_executed_at`) when the whole gate passes. Every other door (activateMLS, launchListing,
   * the status map) leaves this false and still requires the recorded `compliance_passed`.
   */
  complianceReview?: boolean
}

/**
 * OBLIGATION 1 ALONE, for the status map. Three states, and the third is the point.
 *
 * lib/listings/listing-status-sync.ts is PURE and does no I/O, so it takes the
 * gate's VERDICT rather than re-deriving it. This is where that verdict comes
 * from, and it DELEGATES to readListingCompliance — the same private function
 * assertListingActivationAllowed uses for the same obligation — so there is
 * exactly one implementation of "has the listing agreement cleared compliance?"
 * in the tree (§6). A second predicate spelling those three column checks again
 * is the defect this export exists to prevent, not a shortcut it permits.
 *
 * WHY THE RETURN IS THREE-VALUED AND NOT A BOOLEAN. supabase-js RESOLVES a
 * refusal (CLAUDE.md §3), so `false` would fuse two facts a caller must keep
 * apart: "read fine, the gate has not passed" and "the read was REFUSED, we do
 * not know". §4 is explicit that a gate which cannot run must refuse rather than
 * pass — but it must also not masquerade as a clean negative, because a caller
 * that logs "not passed" for a refused read sends someone to chase paperwork
 * that is already complete. `"unknown"` is that third state, and the status map
 * treats it exactly as it treats `"not_passed"`: no status change.
 *
 * This reads ONLY obligation 1. It is NOT a substitute for the full gate — a
 * listing whose agreement is compliant can still be missing required documents,
 * signatures or initials, and only assertListingActivationAllowed answers that.
 * Anything deciding whether a listing may go PUBLICLY LIVE must call the gate.
 */
export async function listingAgreementComplianceState(
  supabase: SupabaseClient,
  params: { listingId: string; brokerageId: string },
): Promise<"passed" | "not_passed" | "unknown"> {
  if (!UUID_RE.test(params.listingId) || !UUID_RE.test(params.brokerageId)) return "unknown"
  const res = await readListingCompliance(supabase, params)
  if (!res.ok) return "unknown"
  return res.passed ? "passed" : "not_passed"
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// TOMBSTONE: local refuse merged onto
// lib/transactions/transaction-creation-gate.ts buildGateRefusal (imported
// above) — §1/§6 SAME BODY census round 3, 2026-09-09.
function refuse(
  refusals: GateRefusal[],
  detail: ListingActivationGateResult["detail"],
): ListingActivationGateResult {
  return buildGateRefusal(refusals, detail)
}

/**
 * The listing's own anchors, read ONCE and tenant-pinned.
 *
 * The identity resolution here is deliberately identical to the one
 * lib/listing-lifecycle/readiness-checker.ts::checkDocumentsVerified and
 * markAgreementSigned use — listings.agent_id is an AGENTS id and is RESOLVED to
 * users.id, never substituted, because a substitution silently resolves a
 * DIFFERENT agent's document requirements — so the three checkpoints cannot
 * disagree about what this brokerage requires for this listing.
 */
async function readListingAnchors(
  supabase: SupabaseClient,
  params: { listingId: string; brokerageId: string },
): Promise<
  | { ok: true; sellerContactId: string | null; agentUserId: string | null; teamId: string | null; stateCode: string | null } & ReturnType<typeof offerChecklistDimensions>
  | { ok: false; error: string }
> {
  const { data: listing, error } = await supabase
    .from("listings")
    // metadata: the listing's own contract subtype / representation (wave 144, lane 144A Outside-lane 3) — see below
    .select("id, brokerage_id, agent_id, seller_contact_id, contact_id, state, metadata")
    .eq("id", params.listingId)
    .maybeSingle()
  if (error) return { ok: false, error: `listing could not be read: ${error.message}` }
  if (!listing) return { ok: false, error: "listing not found" }
  if ((listing as any).brokerage_id !== params.brokerageId) {
    return { ok: false, error: "listing belongs to a different brokerage" }
  }

  // listings.agent_id FKs agents(id); the checklist resolver wants users.id.
  let agentUserId: string | null = null
  const agentRecordId = (listing as any).agent_id as string | null
  if (agentRecordId) {
    const { data: agent, error: agentErr } = await supabase
      .from("agents")
      .select("user_id")
      .eq("id", agentRecordId)
      .maybeSingle()
    if (agentErr) return { ok: false, error: `listing agent could not be resolved: ${agentErr.message}` }
    agentUserId = ((agent as any)?.user_id as string | null) ?? null
  }

  let teamId: string | null = null
  if (agentUserId) {
    const { data: user, error: userErr } = await supabase
      .from("users")
      .select("team_id")
      .eq("id", agentUserId)
      .maybeSingle()
    if (userErr) return { ok: false, error: `listing agent's team could not be resolved: ${userErr.message}` }
    teamId = ((user as any)?.team_id as string | null) ?? null
  }

  // THE SELLER IS IN seller_contact_id. listings.contact_id is the historical
  // fallback and is not populated live; reading it first made sellerContactId
  // always null and the audit silently skipped every document filed against the
  // seller's CONTACT record rather than the listing.
  const sellerContactId =
    (((listing as any).seller_contact_id ?? (listing as any).contact_id) as string | null) ?? null

  return {
    ok: true,
    sellerContactId,
    agentUserId,
    teamId,
    stateCode: ((listing as any).state as string | null) ?? null,
    // The checklist dimensions the LISTING itself states (wave 144 — lane 144A Outside-lane 3, "callers that know the deal's
    // subtype / representation should pass them"), read through the SAME narrowing the offer-side gates use
    // (transaction-creation-gate.ts offerChecklistDimensions: metadata.contract_subtype / metadata.representation through the
    // ONE vocabulary). Unrecognised or absent = null = unknown, and a rule that needs it keeps applying as a WARNING (the
    // resolver's fail-safe) — nothing is guessed from property_type or sub_category.
    ...offerChecklistDimensions(listing as { metadata?: unknown }),
  }
}

/**
 * Obligation 1 for the listing side — read fail-closed.
 *
 * WHY THE AGREEMENT ROW IS THE EVIDENCE. `listing_agreements.compliance_passed`
 * is written `true` at exactly one place in the tree — markAgreementSigned,
 * AFTER its own document audit and packet scan have passed — so the column
 * records a check that ran rather than asserting one that did not. Together with
 * `esign_status = fully_signed` and `fully_executed_at` it is the listing-side
 * counterpart of `offers.compliance_passed_at` plus the compliance-passed audit
 * event: a stamp and its execution, both required, because either alone is a
 * half-stamped gate.
 *
 * NO OPEN-FLAG ARM. The offer side additionally refuses on a still-OPEN
 * compliance flag in the `activities` ledger. THE LISTING SIDE HAS NO SUCH
 * LEDGER: notifyComplianceFlag writes `notifications` rows, which carry no
 * open/resolved lifecycle, and `compliance_flags` is a communication-content
 * table (flagged_content / content_type / violation_type, no listing anchor —
 * verified against the generated schema cache). Inventing a second flag ledger
 * here would be a rival vocabulary (§6), so this gate reads the evidence that
 * exists and the gap is recorded for the owner rather than papered over.
 *
 * ── THE GATE IS SATISFIABLE, RESOLVED BY THE INTEGRATOR ─────────────────────
 *
 * The lane that wrote this could not query the live database and left two
 * questions open, on the reasoning that they decide "the largest refusal
 * bucket". Both are answered, and neither is a bucket:
 *
 *   · CAN THE PRIMARY PATH SATISFY THE CONDITIONS? Yes.
 *     markAgreementSigned's single INSERT writes `esign_status` =
 *     LISTING_AGREEMENT_EXECUTED_STATUS ("fully_signed") and `compliance_passed`
 *     = true in the same object, reached only after its own gate passed (wave
 *     143: it no longer writes `fully_executed_at` — the compliance loop's
 *     fully_executed hop does, after compliance approval). The PROVIDER path
 *     (a wizard-sent agreement that came back signed) carries no compliance
 *     mark yet: the loop's run of this gate in `complianceReview` mode is the
 *     review that writes it.
 *
 *   · DOES THE DOTLOOP WEBHOOK STAMP COMPLIANCE? No, and that is correct.
 *     app/api/webhooks/dotloop/route.ts only UPDATES an already-matched row's
 *     `esign_status` and `fully_executed_at`; it writes no `compliance_passed`
 *     and it INSERTS no agreement. So every `listing_agreements` row in
 *     existence originates from the gated path, and the webhook can only
 *     advance the execution state of a row whose compliance already ran. There
 *     is no route by which an un-audited agreement becomes this gate's evidence.
 *
 * BLAST RADIUS, MEASURED LIVE 2026-09-04 on hrvaqgvukzxfskkcrwbt: 3 listings,
 * 1 already `status='active'` and at MLS_ACTIVE, and ZERO `listing_agreements`
 * rows. So no listing is retroactively broken — this gate sits on the
 * TRANSITION, not on rows already through it — and every FUTURE activation now
 * requires the agreement checkpoint to have run. That is the ruling, stated as
 * a number rather than as an intention. The brokerage's checklist is real and
 * populated: 7 rows in `brokerage_required_documents`.
 */
async function readListingCompliance(
  supabase: SupabaseClient,
  params: { listingId: string; brokerageId: string; review?: boolean },
): Promise<
  | { ok: true; passed: boolean; evidence: string[]; why: string | null }
  | { ok: false; error: string }
> {
  const { data: rows, error } = await supabase
    .from("listing_agreements")
    .select("id, compliance_passed, esign_status, fully_executed_at, agent_signed_at, seller_signed_at, created_at")
    .eq("listing_id", params.listingId)
    .eq("brokerage_id", params.brokerageId)
    .order("created_at", { ascending: false })

  // supabase-js RESOLVES refusals — a refused read is not "no agreement".
  if (error) return { ok: false, error: `listing agreement could not be read: ${error.message}` }

  const agreements = (rows ?? []) as Array<Record<string, any>>
  if (agreements.length === 0) {
    return {
      ok: true,
      passed: false,
      evidence: [],
      why: "there is no listing agreement on file for this listing, so compliance has never been reviewed for it",
    }
  }

  // THE RULE (wave 143, lane 143A — 142K finding 5, ONE vocabulary): `fully_executed_at` is stamped by exactly
  // ONE hop, the ladder's `fully_executed`, which lands only AFTER compliance approval. It is no longer an
  // INPUT to the decision that approves compliance (the provider's completion used to stamp it, and the gate
  // read the stamp back as proof). So the evidence is:
  //   · the packet is at or past ALL-SIGNED on the ladder (the provider's statement),
  //   · the compliance decision is on the row — `compliance_passed` — OR this run IS the review (review mode),
  //     where both parties' signature evidence must be on the row instead,
  //   · a row that CLAIMS `fully_executed` carries its stamp (a status without its execution is a half-stamped gate).
  const signedBothSides = (a: Record<string, any>) => !!a.agent_signed_at && !!a.seller_signed_at
  const good = agreements.find(
    (a) =>
      isAtOrPastAllSigned(a.esign_status) &&
      (params.review ? signedBothSides(a) : a.compliance_passed === true) &&
      (a.esign_status !== "fully_executed" || !!a.fully_executed_at),
  )
  if (good) {
    return {
      ok: true,
      passed: true,
      evidence: [
        `listing_agreements.id=${good.id}`,
        params.review ? `signature_evidence=agent+seller (compliance review in progress)` : `compliance_passed=true`,
        `esign_status=${good.esign_status}`,
        ...(good.fully_executed_at ? [`fully_executed_at=${good.fully_executed_at}`] : []),
      ],
      why: null,
    }
  }

  // There IS an agreement, but it does not carry the marks. Say WHICH is missing — "not compliant" without
  // the reason sends a TC hunting.
  const latest = agreements[0]
  const gaps: string[] = []
  if (!isAtOrPastAllSigned(latest.esign_status)) {
    gaps.push(`its e-sign status is "${latest.esign_status ?? "not recorded"}" — not yet "${LISTING_AGREEMENT_EXECUTED_STATUS}" (or a compliance state past it) on the ladder`)
  } else if (params.review) {
    if (!latest.agent_signed_at) gaps.push("the agent's signature is not evidenced on the agreement")
    if (!latest.seller_signed_at) gaps.push("the seller's signature is not evidenced on the agreement")
  } else if (latest.compliance_passed !== true) {
    gaps.push("its compliance review has not passed")
  }
  if (latest.esign_status === "fully_executed" && !latest.fully_executed_at) gaps.push("it reads fully executed but carries no execution stamp")

  return {
    ok: true,
    passed: false,
    evidence: [`listing_agreements.id=${latest.id}`],
    why: `the listing agreement on file is not complete — ${gaps.join(", ")}`,
  }
}

/**
 * THE GATE. Returns `allowed:true` only when all four obligations hold; every
 * other outcome is a refusal that NAMES which requirement failed and which
 * documents are missing, unsigned or un-initialed.
 *
 * Callers: app/actions/seller-listing/execution-engine.ts::activateMLS and
 * lib/kernel/listings.ts::launchListing — the two doors that make a listing
 * publicly live. Any third door must call this before it writes.
 */
export async function assertListingActivationAllowed(
  supabase: SupabaseClient,
  params: ListingActivationGateParams,
): Promise<ListingActivationGateResult> {
  const checkedAt = new Date().toISOString()
  const door = params.door ? ` (${params.door})` : ""
  const baseDetail: ListingActivationGateResult["detail"] = {
    complianceState: "unknown",
    requiredTotal: null,
    missingRequired: [],
    unexecuted: [],
    missingWarning: [],
    complianceEvidence: [],
    checkedAt,
  }

  // ── 0. Can the gate run at all? ──────────────────────────────────────────
  if (!params.brokerageId || !UUID_RE.test(params.brokerageId)) {
    return refuse([{
      requirement: "gate_could_not_run",
      message: `Listing activation refused${door}: no brokerage on the session, so the compliance gate could not run. Nothing was checked, so the listing may not go active.`,
    }], baseDetail)
  }
  if (!params.listingId || !UUID_RE.test(params.listingId)) {
    return refuse([{
      requirement: "gate_could_not_run",
      message: `Listing activation refused${door}: the listing id is not a valid id, so the compliance gate could not run.`,
    }], baseDetail)
  }

  // ── 0b. The listing's own anchors ────────────────────────────────────────
  const anchors = await readListingAnchors(supabase, {
    listingId: params.listingId,
    brokerageId: params.brokerageId,
  })
  if (!anchors.ok) {
    return refuse([{
      requirement: "gate_could_not_run",
      message: `Listing activation refused${door}: the listing could not be resolved (${anchors.error}). Nothing was verified, so the listing may not go active.`,
    }], baseDetail)
  }

  // ── 1. Compliance is GOOD ────────────────────────────────────────────────
  const refusals: GateRefusal[] = []
  let complianceState: "passed" | "not_passed" | "unknown" = "unknown"
  let complianceEvidence: string[] = []

  const compliance = await readListingCompliance(supabase, {
    listingId: params.listingId,
    brokerageId: params.brokerageId,
    review: params.complianceReview === true,
  })
  if (!compliance.ok) {
    return refuse([{
      requirement: "gate_could_not_run",
      message: `Listing activation refused${door}: the compliance state could not be read (${compliance.error}). Nothing was verified, so the listing may not go active.`,
    }], baseDetail)
  }
  complianceEvidence = compliance.evidence
  complianceState = compliance.passed ? "passed" : "not_passed"
  if (!compliance.passed) {
    refusals.push({
      requirement: "compliance_good",
      message: `Listing activation refused${door}: ${compliance.why}. A listing goes active only after compliance passes on a fully executed listing agreement.`,
    })
  }

  // ── 2. Every required document present (from SETTINGS) ───────────────────
  // dealType is fixed "seller" inside auditListingDocuments — this is the
  // seller side by construction, and the brokerage's SELLER checklist is the
  // one the owner means by "an approved checklist provided by the brokerage".
  const audit: AuditResult = await auditListingDocuments(supabase, {
    brokerageId: params.brokerageId,
    listingId: params.listingId,
    sellerContactId: anchors.sellerContactId,
    agentUserId: anchors.agentUserId,
    teamId: anchors.teamId,
    stateCode: anchors.stateCode,
    // the listing's own subtype / representation, off the anchors read above (null = not stated → the resolver's warning arm)
    contractSubtype: anchors.contractSubtype,
    representation: anchors.representation,
  })

  if (audit.unavailable_reason) {
    // THE FAIL-CLOSED CASE. An unreadable file is not an empty one, and an empty
    // verdict here would be "nobody checked" rendered as "checked and fine".
    return refuse([{
      requirement: "gate_could_not_run",
      message: `Listing activation refused${door}: the required-document check could not run (${audit.unavailable_reason}). Nothing was verified, so the listing may not go active.`,
    }], { ...baseDetail, complianceState, complianceEvidence })
  }

  if (audit.missing_blocking.length > 0) {
    refusals.push({
      requirement: "required_documents_present",
      message: `Listing activation refused${door}: ${audit.missing_blocking.length} required document(s) missing from the listing file — ${audit.missing_blocking.map(documentClassificationLabel).join(", ")}. Upload them before the listing goes active.`,
    })
  }

  // ── 3 + 4. Fully signed, and initials complete ───────────────────────────
  // LISTING_AGREEMENT_PARTIES is passed EXPLICITLY — see the header. The default
  // is the purchase-contract pair and would refuse every listing forever.
  const requiredClassifications = audit.required_breakdown.map((r) => r.classification)
  const unexecuted = findUnexecutedDocuments(
    audit.deal_file,
    requiredClassifications,
    LISTING_AGREEMENT_PARTIES,
  )

  const signatureGaps = unexecuted.filter((u) => u.missingSignatures.length > 0)
  const initialGaps = unexecuted.filter((u) => u.missingInitials.length > 0)

  // A document nobody scanned has a DIFFERENT remedy from one a party has not
  // signed — "scan it" rather than "chase the seller" — so the refusal says which.
  const describe = (u: UnexecutedDocument, which: "sig" | "ini") =>
    u.unscanned
      ? `${u.label} (never scanned — nothing about it has been verified)`
      : `${u.label} (missing ${(which === "sig" ? u.missingSignatures : u.missingInitials).join(", ")})`

  if (signatureGaps.length > 0) {
    refusals.push({
      requirement: "documents_fully_signed",
      message: `Listing activation refused${door}: ${signatureGaps.length} required document(s) are not fully signed — ${signatureGaps.map((u) => describe(u, "sig")).join("; ")}.`,
    })
  }
  if (initialGaps.length > 0) {
    refusals.push({
      requirement: "initials_complete",
      message: `Listing activation refused${door}: initials are still outstanding on ${initialGaps.length} required document(s) — ${initialGaps.map((u) => describe(u, "ini")).join("; ")}. A signature block being filled does not make a document complete when a page initial is blank.`,
    })
  }

  const detail: ListingActivationGateResult["detail"] = {
    complianceState,
    requiredTotal: audit.required_total,
    missingRequired: audit.missing_blocking.map(documentClassificationLabel),
    unexecuted,
    missingWarning: audit.missing_warning.map(documentClassificationLabel),
    complianceEvidence,
    checkedAt,
  }

  if (refusals.length > 0) return refuse(refusals, detail)

  return {
    allowed: true,
    refusals: [],
    reason: `Compliance gate passed at ${checkedAt} — compliance good, all ${audit.required_total} required document(s) present, every signature and every initial complete.`,
    detail,
  }
}
