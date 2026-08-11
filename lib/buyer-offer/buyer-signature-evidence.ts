// ─── HOW WE KNOW THE BUYER SIGNED — and by WHAT evidence ─────────────────────
//
// THE OWNER'S RULING this exists to serve:
//
//   "there are times that an offer comes in from an outside buyers agent for a
//    listing in house and won't be created from the wizard and those contracts
//    need to be executed and signed from the seller and then submitted and read
//    and checked through the compliance gate."
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
// `offers.buyer_signed_at` had exactly ONE writer in the whole tree:
// `lib/esign-webhooks/finalize-packet.ts` (the two updates at 243 and 258), the
// webhook for OUR OWN e-sign envelopes. An offer written on an outside buyer's
// agent's paperwork was signed on THEIR provider, or on paper. Our webhook never
// fires, so the column stayed NULL forever and three gates refused it PERMANENTLY:
//
//   · app/actions/buyer-offer/record-seller-response.ts  — the seller could never
//     accept it;
//   · app/actions/buyer-offer/submit-to-compliance.ts    — it could never reach
//     the compliance gate;
//   · lib/transactions/offer-bridge.ts:assertOfferReadyForTransaction — and it
//     could never become a transaction.
//
// ── WHAT THIS MODULE DOES NOT DO ─────────────────────────────────────────────
// It does NOT weaken "both sides signed". That is settled law and every one of
// those three refusals stays exactly as it is. `buyer_signed_at` is a statement
// about the WORLD — "the buyer signed, on this date" — not a statement about our
// webhook. The bug was that only one kind of evidence was ever allowed to
// establish that fact.
//
// ── THE TWO ADMISSIBLE SOURCES ───────────────────────────────────────────────
//   1. `our_esign_envelope`          — the provider told us the envelope
//                                      completed. Machine evidence. Unchanged,
//                                      and this module never overwrites it.
//   2. `attested_executed_contract`  — a NAMED HUMAN in the deal's brokerage
//                                      states, at a recorded time, that the
//                                      executed contract ON FILE bears the
//                                      buyer's signature, and gives the date it
//                                      was signed.
//
// There is no third. In particular there is no "the AI thought it looked
// signed": see the AI note below.
//
// ── WHY A HUMAN ATTESTATION AND NOT THE AI EXTRACTOR ─────────────────────────
// The brief asked what the AI can establish for a document we did not send. Read
// out of the tree, honestly:
//
//   · `lib/offers/offer-extractor.ts:extractOfferFromPdf` — the extractor that
//     already runs on exactly these inbound PDFs — has NO signature field in its
//     schema at all. Its 17 keys are price / money / dates / contingencies /
//     notes. It cannot speak to a signature, and asking it to would be adding a
//     capability, not reading one.
//   · `lib/documents/scan-uploaded-document.ts` DOES ask a vision model for
//     `signature_completeness`, and `lib/compliance/signature-completeness.ts:
//     evaluateExecution` is the canonical, already-proven predicate over it. That
//     is a real reading — but it is a MODEL'S reading of a scanned page, and its
//     own prompt concedes the point ("Do NOT infer a signature from a typed
//     name... an unverifiable signature must read as missing").
//
// So the AI is used here in the only direction it is safe in: as CORROBORATION,
// recorded next to the attestation, and never as the thing that establishes it.
// A wrongly-assumed buyer signature is worse than a blocked deal.
//
// ── WHY THE ATTESTATION IS NOT GATED ON "IS THIS OFFER INBOUND?" ─────────────
// `isOutsideOriginated` below exists, is derived from live columns, and is
// RECORDED on every attestation. It deliberately does NOT decide whether an
// attestation is allowed. Gating on a heuristic would mint a second permanent
// dead-end the moment the heuristic is wrong about a deal — which is the exact
// defect class this module is closing. What actually protects the fact is
// stronger than a classifier: the attestor must be a real user in the offer's
// brokerage, the executed contract must ALREADY BE ON FILE, the date may not be
// in the future, and machine evidence is never overwritten by a human's.
//
// PURE readers first (no I/O, so a proof can drive them directly); the writer
// below takes an injectable client for the same reason —
// `scripts/inbound-offer-lane-simulator.ts` runs it with no credentials.

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { evaluateExecution } from "@/lib/compliance/signature-completeness"

type Svc = ReturnType<typeof createServiceClient>

/**
 * The audit event a buyer-signature attestation is filed under.
 *
 * DELIBERATELY NOT in `lib/buyer-offer/offer-lifecycle.ts:OFFER_EVENT`, for the
 * same reason `buyer.offer.compliance.passed` is not (see the vocabulary note in
 * lib/buyer-offer/compliance-gate.ts): OFFER_EVENT is the STATE MACHINE and
 * `EVENT_TO_STATE` / `EVENT_TO_STATUS` are total records over it, so any name
 * added there must invent a state AND a status. Recording how a signature was
 * evidenced changes neither — the offer is exactly where it was. So the literal
 * is spelled in ONE module, this one, which is its only writer.
 */
export const BUYER_SIGNATURE_ATTESTED_EVENT = "buyer.offer.signature.attested"

/** The `offers.metadata` key the evidence record lives under. */
export const BUYER_SIGNATURE_EVIDENCE_KEY = "buyer_signature_evidence"

export type BuyerSignatureSource = "our_esign_envelope" | "attested_executed_contract"

/**
 * What the classifier could see on the executed contract. Recorded, never
 * decisive — in EITHER direction. `checked:false` means nobody asked; it must
 * never read as "clean".
 */
export interface AiCorroboration {
  checked:  boolean
  /** evaluateExecution(...).executed for the BUYER party. null when unchecked. */
  executed: boolean | null
  missing:  string[]
  /** documents.classification, so a reader knows what was looked at. */
  classification: string | null
}

export interface BuyerSignatureEvidence {
  source:    BuyerSignatureSource
  /** The date the buyer's signature bears. */
  signed_at: string | null
  /**
   * FALSE when this record was DERIVED rather than read off a stored record —
   * i.e. a row stamped before this module existed, whose only possible writer
   * was the e-sign webhook. The distinction is kept because "we recorded the
   * source" and "we worked out the source" are not the same claim.
   */
  recorded:  boolean
  attested_by_user_id: string | null
  attested_by_name:    string | null
  attested_at:         string | null
  /** The attestor's own words. */
  attestation:  string | null
  document_id:  string | null
  document_url: string | null
  /** Was the offer's paperwork ours? Context on the record, never a gate. */
  outside_originated: boolean | null
  ai_corroboration: AiCorroboration | null
}

// ─── PURE: was this offer's paperwork ours? ──────────────────────────────────

/**
 * `offers.form_source` values that mean the paperwork was NOT produced by our
 * form engine. Both are already in the live CHECK constraint
 * (`offers_form_source_check`: portal_upload | dotloop | docusign | skyslope |
 * authentisign | in_app | manual) — no column and no vocabulary value is
 * invented here.
 */
export const OUTSIDE_ORIGINATED_FORM_SOURCES = ["portal_upload", "manual"] as const

export interface OfferOriginFacts {
  form_source?:          string | null
  provider_envelope_id?: string | null
  offer_document_url?:   string | null
}

/**
 * PURE. Did this offer's paperwork come from OUTSIDE our form + e-sign engine?
 *
 * Read off the live columns, in this order:
 *   1. `form_source` is recorded → it is the answer. `portal_upload` / `manual`
 *      are outside; `in_app` and the four provider names are ours.
 *   2. `form_source` is NULL → the paperwork is ours only if we ever dispatched
 *      an envelope for it (`provider_envelope_id`), and there is a document on
 *      file that somebody else produced.
 *
 * Step 2 is needed because BOTH outside-offer intake paths leave `form_source`
 * NULL today — `lib/inbound-mail/offer-intake.ts` (now fixed, see below) and
 * `app/api/offers/upload/route.ts` (NOT in this slice's scope; see
 * docs/wave10-slice-inbound.md "Required follow-up").
 */
export function isOutsideOriginated(offer: OfferOriginFacts): boolean {
  const source = String(offer.form_source ?? "").trim().toLowerCase()
  if (source) return (OUTSIDE_ORIGINATED_FORM_SOURCES as readonly string[]).includes(source)
  return !offer.provider_envelope_id && !!offer.offer_document_url
}

// ─── PURE: what established the buyer's signature on THIS offer? ─────────────

export interface OfferSignatureFacts extends OfferOriginFacts {
  buyer_signed_at?: string | null
  metadata?:        Record<string, any> | null
}

/**
 * PURE. The evidence behind `offers.buyer_signed_at`, or null when the buyer's
 * signature is not established at all.
 *
 * Never guesses that a signature exists: a NULL column returns null, full stop.
 * When the column is set but carries no evidence record, the source is derived
 * from the fact that the e-sign webhook is the only other writer of it in the
 * tree — and the return says `recorded: false` so a reader can tell a derived
 * answer from a recorded one.
 */
export function describeBuyerSignatureEvidence(
  offer: OfferSignatureFacts,
): BuyerSignatureEvidence | null {
  if (!offer.buyer_signed_at) return null

  const stored = offer.metadata?.[BUYER_SIGNATURE_EVIDENCE_KEY]
  if (stored && typeof stored === "object" && !Array.isArray(stored) && typeof stored.source === "string") {
    return { ...(stored as BuyerSignatureEvidence), recorded: true }
  }

  return {
    source:              "our_esign_envelope",
    signed_at:           offer.buyer_signed_at ?? null,
    recorded:            false,
    attested_by_user_id: null,
    attested_by_name:    null,
    attested_at:         null,
    attestation:         null,
    document_id:         null,
    document_url:        null,
    outside_originated:  isOutsideOriginated(offer),
    ai_corroboration:    null,
  }
}

/**
 * PURE. One line naming what established the buyer's signature, for the gate
 * event and for a refusal message. Mirrors the wave-9 `both_sides_established_by`
 * vocabulary rather than forking a second one.
 */
export function buyerSignatureEstablishedBy(evidence: BuyerSignatureEvidence | null): string {
  if (!evidence) return "nothing — offers.buyer_signed_at is not set"
  if (evidence.source === "attested_executed_contract") {
    return `offers.buyer_signed_at + attested_executed_contract (${evidence.attested_by_name ?? evidence.attested_by_user_id ?? "unnamed attestor"})`
  }
  return evidence.recorded
    ? "offers.buyer_signed_at + our_esign_envelope"
    : "offers.buyer_signed_at (source not recorded — derived: the e-sign webhook is its only other writer)"
}

/**
 * PURE. The refusal an outside-originated offer should get instead of the
 * dead-end "Buyer has not signed yet". Named here so both gates say the same
 * thing and neither invents its own wording.
 */
export function buyerSignatureRefusal(offer: OfferOriginFacts): string {
  const base = "Buyer has not signed yet — offers.buyer_signed_at is not set, so nothing has established the buyer's signature."
  return isOutsideOriginated(offer)
    ? `${base} This offer's paperwork did not come from our form engine, so our e-sign webhook will never stamp it. File the buyer-executed contract against this offer, then record the buyer-signature attestation (who holds it, and the date it was signed) — that is the other admissible evidence, and it is recorded with your name against it.`
    : `${base} Send the offer for signature and wait for the envelope to complete, or — if the buyer signed outside our envelope — file the executed contract against this offer and record the buyer-signature attestation.`
}

// ─── THE WRITER ──────────────────────────────────────────────────────────────

export interface AttestBuyerSignatureParams {
  /** offers.id */
  offerId: string
  /**
   * users.id of the human making the statement. NEVER a system id and never an
   * `agents.id` — those are DISJOINT spaces. Resolved against `users` below so
   * the record carries a real name, not an id nobody can read.
   */
  attestorUserId: string
  /** The date the buyer's signature bears, per the document in hand. */
  signedAt: string
  /** The attestation, in the attestor's own words. Required. */
  attestation: string
  /**
   * documents.id of the executed contract when the attestor names one. Omitted,
   * the newest document filed against this offer is used. Either way SOMETHING
   * must be on file — an attestation about a document nobody can open is not
   * evidence.
   */
  documentId?: string | null
  /** Injectable for proofs. Defaults to the service client. */
  client?: Svc
}

export interface AttestBuyerSignatureResult {
  success: boolean
  evidence?: BuyerSignatureEvidence
  /** True when the signature was ALREADY established — nothing was overwritten. */
  already_established?: boolean
  error?: string
}

/**
 * Record a human attestation that the buyer signed, and stamp
 * `offers.buyer_signed_at` from it.
 *
 * FAILS CLOSED at every step: supabase-js RESOLVES a refused query, so every
 * read and every write destructures `error`. An attestation whose write was
 * swallowed would leave a gate believing a signature it does not have.
 *
 * IDEMPOTENT AND NON-DESTRUCTIVE. If `buyer_signed_at` is already set — by the
 * webhook or by an earlier attestation — this returns the EXISTING evidence with
 * `already_established:true` and writes nothing. Machine evidence is never
 * replaced by a human's, and a second attestation never rewrites the first one's
 * date or author.
 *
 * THE METADATA IS MERGED, NEVER REPLACED. `offers.metadata` is a live jsonb
 * column other writers use; a wholesale overwrite here would silently destroy
 * whatever else is in it — the same class of defect wave 9 found in
 * `generateOfferDraft`, which replaced a document's metadata and destroyed the
 * only key the packet scan could find it by.
 */
export async function attestBuyerSignature(
  params: AttestBuyerSignatureParams,
): Promise<AttestBuyerSignatureResult> {
  const { offerId, attestorUserId, signedAt, attestation, documentId } = params

  if (!isValidUUID(offerId))        return { success: false, error: "Invalid offer ID" }
  if (!isValidUUID(attestorUserId)) return { success: false, error: "Invalid attestor user ID" }

  const statement = String(attestation ?? "").trim()
  if (statement.length < 10) {
    // An attestation is a STATEMENT a person is accountable for. An empty string
    // or a single character is a click, and a click is not a statement.
    return { success: false, error: "The attestation must say, in words, what the attestor is attesting to — who holds the executed contract and that it carries the buyer's signature." }
  }

  const signedDate = new Date(signedAt)
  if (!signedAt || Number.isNaN(signedDate.getTime())) {
    return { success: false, error: "The buyer's signature date is required and must be a real date." }
  }
  const now = new Date()
  if (signedDate.getTime() > now.getTime() + 60_000) {
    // 60s of clock skew, no more. A signature cannot be dated in the future, and
    // accepting one would let a deal be dated forward past its own deadlines.
    return { success: false, error: "The buyer's signature cannot be dated in the future." }
  }

  const svc = params.client ?? createServiceClient()
  const nowIso = now.toISOString()

  const { data: offer, error: offerError } = await svc
    .from("offers")
    .select("id, brokerage_id, contact_id, agent_id, buyer_signed_at, metadata, offer_document_url, seller_response_document_url, form_source, provider_envelope_id")
    .eq("id", offerId)
    .maybeSingle()
  if (offerError) return { success: false, error: `Could not read the offer: ${offerError.message}` }
  if (!offer)     return { success: false, error: "Offer not found" }
  if (!offer.brokerage_id) {
    // activities.brokerage_id is NOT NULL with no default — without it the audit
    // row writes ZERO rows while reporting success.
    return { success: false, error: "Offer has no brokerage — the attestation cannot be recorded against a tenant" }
  }

  // ALREADY ESTABLISHED → return what established it. Nothing is overwritten.
  if (offer.buyer_signed_at) {
    return {
      success: true,
      already_established: true,
      evidence: describeBuyerSignatureEvidence(offer as any) ?? undefined,
    }
  }

  // ── WHO. An attestation with no accountable human is not evidence. ─────────
  const { data: attestor, error: attestorError } = await svc
    .from("users")
    .select("id, first_name, last_name, email, brokerage_id")
    .eq("id", attestorUserId)
    .maybeSingle()
  if (attestorError) return { success: false, error: `Could not read the attesting user: ${attestorError.message}` }
  if (!attestor)     return { success: false, error: "The attesting user does not exist — a buyer signature may only be attested by a named person." }
  if (attestor.brokerage_id !== offer.brokerage_id) {
    return { success: false, error: "The attesting user is not in this offer's brokerage — only someone on the deal's side may attest to its signatures." }
  }
  const attestorName =
    [attestor.first_name, attestor.last_name].filter(Boolean).join(" ").trim()
    || (attestor.email as string | null)
    || null

  // ── WHAT. The executed contract has to actually BE on file. ────────────────
  //
  // This is the concrete tie between the attestation and the paper: you cannot
  // attest to a signature on a document the deal file does not hold. It is also
  // why F2 (filing inbound documents into `documents`) is a precondition for F1
  // rather than a separate nicety.
  let docRow: { id: string; storage_url: string | null; classification: string | null; signature_completeness: unknown } | null = null

  if (documentId) {
    if (!isValidUUID(documentId)) return { success: false, error: "Invalid document ID" }
    const { data: named, error: namedError } = await svc
      .from("documents")
      .select("id, storage_url, classification, signature_completeness, metadata")
      .eq("id", documentId)
      .eq("brokerage_id", offer.brokerage_id as string)
      .maybeSingle()
    if (namedError) return { success: false, error: `Could not read the named document: ${namedError.message}` }
    if (!named)     return { success: false, error: "The named executed contract is not in this brokerage's deal file." }
    // It must be filed against THIS offer. Attesting on the strength of some
    // other deal's paperwork is precisely the mistake worth refusing.
    const linked = (named as any).metadata?.linked_offer_id
    if (linked && linked !== offerId) {
      return { success: false, error: "The named document is filed against a different offer." }
    }
    docRow = named as any
  } else {
    const { data: newest, error: newestError } = await svc
      .from("documents")
      .select("id, storage_url, classification, signature_completeness")
      .eq("brokerage_id", offer.brokerage_id as string)
      .filter("metadata->>linked_offer_id", "eq", offerId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    // A REFUSED read is not "no documents". Pre-rollout these tables are empty,
    // so "nothing came back" can never be treated as an answer here.
    if (newestError) return { success: false, error: `Could not read the deal file: ${newestError.message}` }
    docRow = (newest as any) ?? null
  }

  const fallbackUrl =
    (offer.offer_document_url as string | null)
    ?? (offer.seller_response_document_url as string | null)
    ?? null

  if (!docRow && !fallbackUrl) {
    return {
      success: false,
      error: "No executed contract is on file for this offer, so there is nothing to attest to. Upload the buyer-executed contract against this offer first — the attestation records that a named person read THAT document.",
    }
  }

  // ── THE AI, IN ITS ONLY SAFE DIRECTION. ───────────────────────────────────
  // `evaluateExecution` is the canonical predicate over
  // `documents.signature_completeness` (the same one the listing gate uses), run
  // here for the BUYER party only. Its answer is RECORDED beside the attestation
  // and decides nothing: a null/absent/malformed blob yields executed:false with
  // every requirement listed missing, which is honest, and must not be read as a
  // contradiction of a human who has the paper in hand.
  let ai: AiCorroboration = { checked: false, executed: null, missing: [], classification: null }
  if (docRow) {
    const hasBlob = docRow.signature_completeness != null
    const verdict = evaluateExecution(docRow.signature_completeness, ["buyer"])
    ai = {
      checked:        hasBlob,
      executed:       hasBlob ? verdict.executed : null,
      missing:        hasBlob ? verdict.missing : [],
      classification: (docRow.classification as string | null) ?? null,
    }
  }

  const evidence: BuyerSignatureEvidence = {
    source:              "attested_executed_contract",
    signed_at:           signedDate.toISOString(),
    recorded:            true,
    attested_by_user_id: attestorUserId,
    attested_by_name:    attestorName,
    attested_at:         nowIso,
    attestation:         statement,
    document_id:         docRow?.id ?? null,
    document_url:        (docRow?.storage_url as string | null) ?? fallbackUrl,
    outside_originated:  isOutsideOriginated(offer as any),
    ai_corroboration:    ai,
  }

  // MERGE. Never `metadata: { [KEY]: … }` — that would replace the column.
  const mergedMetadata = {
    ...((offer.metadata as Record<string, any> | null) ?? {}),
    [BUYER_SIGNATURE_EVIDENCE_KEY]: evidence,
  }

  const { error: stampError } = await svc
    .from("offers")
    .update({ buyer_signed_at: evidence.signed_at, metadata: mergedMetadata })
    .eq("id", offerId)
    .eq("brokerage_id", offer.brokerage_id as string)
  if (stampError) {
    return { success: false, error: `The buyer-signature attestation could not be written to the offer (${stampError.message}) — nothing downstream was changed.` }
  }

  // THE AUDIT ROW, keyed the way every offer reader joins: entity_type='offer'
  // AND entity_id=<offers.id>. agent_id is agents-class from the OFFER;
  // agent_user_id is users-class from the attestor. The two are never crossed.
  const { error: eventError } = await svc.from("activities").insert({
    brokerage_id:  offer.brokerage_id,
    entity_type:   "offer",
    entity_id:     offerId,
    activity_type: BUYER_SIGNATURE_ATTESTED_EVENT,
    agent_id:      offer.agent_id ?? null,
    agent_user_id: attestorUserId,
    contact_id:    offer.contact_id ?? null,
    title:         "Buyer signature attested on the executed contract",
    description:   `${attestorName ?? attestorUserId} attested that the executed contract on file carries the buyer's signature, dated ${evidence.signed_at}. ${statement}`,
    notes:         JSON.stringify({ offer_id: offerId, ...evidence }),
    metadata:      { offer_id: offerId, buyer_signature_evidence: evidence },
    status:        "completed",
    priority:      "high",
  })
  if (eventError) {
    // The offer IS stamped, so say so — an agent who thinks nothing happened
    // will attest twice. A retry is safe: the already-established branch above
    // returns the recorded evidence without writing.
    return {
      success: false,
      error: `The buyer-signature attestation was recorded on the offer, but its audit event could not be written (${eventError.message}). Retry — the attestation will not be duplicated — and escalate if it repeats, because the signature evidence must be auditable.`,
    }
  }

  return { success: true, evidence }
}
