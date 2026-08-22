"use server"

/**
 * Submit a fully-executed offer to compliance review.
 *
 * This is the EXPLICIT agent trigger that gates the transaction auto-create
 * chain. No automation (not even the e-sign webhook) advances an offer past
 * this point without the agent clicking "submit to compliance" — the agent
 * is responsible for verifying the executed contract is correct before
 * compliance is logged + a transaction is created.
 *
 * Preconditions:
 *   - Offer exists in the agent's brokerage.
 *   - Buyer has signed (offers.buyer_signed_at IS NOT NULL).
 *   - Seller has accepted (offers.seller_response_type = 'accepted' AND
 *     offers.fully_signed_contract_received_at IS NOT NULL).
 *   - No prior transaction has been created (offers.transaction_id IS NULL).
 *   - The packet completeness scan found nothing outstanding, OR no packet was
 *     ever staged because this offer was not built through the packet builder.
 *     A scan that FAULTED — invalid ids, an unreadable document store, or a
 *     staged packet that could not be parsed — is a REFUSAL, not a pass: it has
 *     verified zero signatures and zero initials. A never-staged packet is NOT
 *     a fault: the e-sign path establishes both sides on the offer columns
 *     above, and the gate event records which evidence was actually used.
 *
 * What this action does on success:
 *   1. Stamps offers.ready_for_compliance_at + offers.compliance_passed_at
 *   2. Inserts buyer.offer.compliance.passed activity (audit trail)
 *   3. Inserts buyer.offer.accepted activity (lifecycle state → ACCEPTED)
 *   4. Calls createTransactionFromOffer to create the transaction, seed
 *      milestones + deadlines, populate participants
 *
 * Returns the new transaction_id when success.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID }          from "@/lib/validations"
import { OFFER_EVENT }          from "@/lib/buyer-offer/offer-lifecycle"
import { emitCompliancePassed } from "@/lib/buyer-offer/compliance-gate"
import { createTransactionFromOffer } from "@/lib/transactions"
import { auditOfferDocuments }       from "@/lib/compliance/required-documents"
// THE SAME PURE READING THE TRANSACTION-CREATION GATE MAKES, made HERE too.
// Imported, never re-spelled: this checkpoint and the gate that later refuses on
// the identical fact must not be able to disagree (CLAUDE.md §6).
import { findUnexecutedDocuments }   from "@/lib/transactions/transaction-creation-gate"
import { scanOfferPacketCompleteness } from "@/lib/workflow/intelligence/scan-offer-packet"
import { notifyComplianceFlag }       from "@/lib/notifications/notify-helpers"
import { resolveOfferComplianceFlags } from "@/lib/compliance/offer-flag-resolution"
import {
  describeBuyerSignatureEvidence,
  buyerSignatureEstablishedBy,
  buyerSignatureRefusal,
} from "@/lib/buyer-offer/buyer-signature-evidence"

export interface SubmitToComplianceParams {
  offerId: string
  userId:  string
  /** Optional override for the contract date — defaults to today. */
  contractDate?: string
}

export interface SubmitToComplianceResult {
  success:        boolean
  transaction_id?: string
  error?:         string
  /** When refused: which brokerage-required documents are missing (blocking). */
  missing_required?: string[]
  /** When refused: which packet fields/signatures/initials are missing. */
  packet_blockers?:  Array<{ flagType: string; severity: string; title: string }>
}

export async function submitOfferToCompliance(
  params: SubmitToComplianceParams,
): Promise<SubmitToComplianceResult> {
  const { offerId, userId, contractDate } = params

  if (!isValidUUID(offerId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  // 1. Load the offer with everything we need to enforce the gate + create
  //    the transaction. Counters have parent_offer_id set + seller_signed_at
  //    rather than seller_response_type='accepted', so we accept either path
  //    to "executed contract on file".
  // `error` is destructured: supabase-js RESOLVES a refused read, and this is
  // THE gate — a refused read must not render as "offer not found" and must
  // certainly not render as "buyer has not signed".
  const { data: offer, error: offerReadError } = await supabase
    .from("offers")
    // metadata / form_source / provider_envelope_id / offer_document_url are
    // read for the buyer-signature EVIDENCE question below — what established
    // the signature, not merely that a timestamp is present.
    .select("id, brokerage_id, contact_id, agent_id, transaction_id, parent_offer_id, offer_type, buyer_signed_at, seller_signed_at, seller_response_type, fully_signed_contract_received_at, ready_for_compliance_at, compliance_passed_at, closing_date, inspection_period_days, appraisal_contingency_days, financing_contingency_days, earnest_money, listing_id, property_address, metadata, form_source, provider_envelope_id, offer_document_url")
    .eq("id", offerId)
    .maybeSingle()
  if (offerReadError) return { success: false, error: `Could not read the offer: ${offerReadError.message}` }
  if (!offer) return { success: false, error: "Offer not found" }

  if (offer.transaction_id) {
    return { success: false, error: "Offer already converted to a transaction" }
  }

  // THE BUYER SIDE, UNCHANGED IN WHAT IT REQUIRES. `buyer_signed_at` must be
  // set. What changed this wave is that more than one kind of evidence may
  // establish it, and the gate now reads WHICH — see
  // lib/buyer-offer/buyer-signature-evidence.ts. `null` here still means nothing
  // established it, and that is still a refusal; the wording now names the
  // evidence an outside-originated offer can actually produce, instead of
  // telling an agent to wait for a webhook that will never fire.
  const buyerEvidence = describeBuyerSignatureEvidence(offer as any)
  if (!buyerEvidence) {
    return { success: false, error: `Cannot submit to compliance. ${buyerSignatureRefusal(offer as any)}` }
  }

  // Two valid paths to "executed contract on file":
  //   A) Buyer-first original offer: seller_response_type='accepted' AND
  //      fully_signed_contract_received_at set (agent uploaded seller-signed PDF).
  //   B) Seller-first counter: seller_signed_at is set AND buyer signed the
  //      counter envelope (fully_signed_contract_received_at stamped by the
  //      webhook automatically when both sides signed).
  const executedViaResponse = offer.seller_response_type === "accepted" && !!offer.fully_signed_contract_received_at
  const executedViaCounter  = !!offer.seller_signed_at && !!offer.fully_signed_contract_received_at
  if (!executedViaResponse && !executedViaCounter) {
    return { success: false, error: "Executed contract not on file yet — seller hasn't accepted (record seller response) or signed counter (record seller-signed counter)" }
  }

  const now = new Date().toISOString()
  const finalContractDate = contractDate ?? now.slice(0, 10)

  // 1.5 — Pre-flight compliance gate. Two checks BEFORE we stamp anything:
  //   A) Brokerage-required documents — the broker's onboarding checklist.
  //      Resolution cascade: agent → team → brokerage. Blocking misses
  //      refuse the submit; warning misses are returned but pass through.
  //   B) Packet completeness scan — walks documents.content.filledPacket
  //      for missing signatures / initials / fields. Any blockers refuse.
  // On refusal we fan out compliance flags so the agent + TC see why.
  const { data: actingUser } = await supabase
    .from("users")
    .select("team_id")
    .eq("id", userId)
    .maybeSingle()
  const teamId = (actingUser?.team_id as string | null) ?? null

  // Resolve the property's state so the audit applies the correct state-specific
  // required documents (in-house → listing.state; outside property → parse the
  // 2-letter state from the address). Without this the audit can't scope by state.
  let stateCode: string | null = null
  if (offer.listing_id) {
    const { data: listingRow } = await supabase
      .from("listings").select("state").eq("id", offer.listing_id as string).maybeSingle()
    stateCode = (listingRow?.state as string | null) ?? null
  }
  if (!stateCode && offer.property_address) {
    const m = String(offer.property_address).match(/,\s*([A-Za-z]{2})\s*\d{5}(?:-\d{4})?\b/)
    stateCode = m ? m[1].toUpperCase() : null
  }

  const audit = await auditOfferDocuments(supabase as any, {
    offerId,
    brokerageId:  offer.brokerage_id as string,
    contactId:    offer.contact_id as string | null,
    agentUserId:  userId,
    teamId,
    dealType:     "buyer",
    stateCode,
  })

  // THE AUDIT ITSELF CAN FAIL TO RUN, and that is not a pass.
  //
  // auditOfferDocuments used to answer a REFUSED checklist read and a refused
  // deal-file read with the same all-zero shape a clean file produces — so
  // "the required-document list could not be read" arrived here indistinguishable
  // from "this brokerage requires nothing", and the submit sailed through. That
  // is the finding-#105 shape at the settings end of the gate. It now carries
  // `unavailable_reason`, and an unavailable audit REFUSES here.
  if (audit.unavailable_reason) {
    return {
      success: false,
      error: `Cannot submit to compliance — the required-document check could not run (${audit.unavailable_reason}). Nothing was verified, so nothing was submitted.`,
    }
  }

  const packetScan = await scanOfferPacketCompleteness({
    offerId,
    raiserUserId: userId,
  })

  const hasBlockingMissing = audit.missing_blocking.length > 0
  // The scanner synthesises a blocker on EVERY exit that did not walk a packet
  // — deliberately, so a consumer reading only `blockers` fails closed. But the
  // never-staged exit is not a finding about this deal's paperwork (see the
  // scanOutcome note below), so it must not be counted as one here. Faults keep
  // their blocker and still refuse.
  const hasPacketBlockers  = packetScan.scanOutcome !== "no_packet_staged"
    && packetScan.blockers.length > 0

  // THE GATE FAILS CLOSED on a packet check that could not RUN.
  //
  // This line used to read ONLY `packetScan.blockers.length`, and the scanner
  // answered "there is no packet at all" with `blockers: []`. So "fully signed"
  // and "no paperwork whatsoever" arrived here looking identical and BOTH
  // passed — a transaction created having verified zero signatures and zero
  // initials, which is the exact opposite of the owner's rule that every
  // signature and initial be complete on both sides before a transaction
  // exists.
  //
  // Fixed at BOTH ends. The scanner now returns a real blocker on every exit
  // that did not walk a packet (so `blockers` alone already refuses, for any
  // future caller that reads nothing else), and `success` is read HERE as well
  // so a scan that reports a fault without a finding still cannot pass. The
  // listing-agreement checkpoint has always read it this way
  // (execution-engine.ts:markAgreementSigned) — the two checkpoints are the
  // same run, so they refuse on the same condition.
  // …WITH ONE DISTINCTION THE FIRST PASS OF THIS FIX DID NOT DRAW, and it
  // matters in both directions.
  //
  // "the packet could not be verified" and "this offer never had a packet" are
  // NOT the same claim. `app/actions/buyer-offers.ts:createOffer` — the offer
  // wizard, the main path in the product — writes no `documents` row at all, so
  // its offers reach here with no packet by design, not by fault. Refusing them
  // would block every wizard-created deal at compliance: a product outage, not a
  // compliance improvement.
  //
  // Those offers are NOT unverified. Signature completeness for the e-sign path
  // is established on the OFFER row and is already enforced ABOVE, before this
  // scan is even called: buyer_signed_at set, plus an executed contract on file
  // via seller_response_type='accepted' or seller_signed_at, each with
  // fully_signed_contract_received_at. That IS "both sides signed"; the packet
  // walk is a SECOND, field-level mechanism that only exists for packet-built
  // offers.
  //
  // So: a FAULT refuses (invalid ids, a refused read, or a packet that exists
  // and cannot be parsed — something is there and we could not check it), and a
  // never-staged packet does not. The distinction is carried explicitly as
  // `scanOutcome` rather than inferred from `documentId`, because a refused read
  // also has a null document id and is a genuine fault.
  const packetScanFaulted = packetScan.scanOutcome === "fault"
  const packetNeverStaged = packetScan.scanOutcome === "no_packet_staged"
  // Kept as the belt to `scanOutcome`'s braces: a scanner that ever reported a
  // fault WITHOUT tagging the outcome (a future exit added without setting it)
  // must still refuse rather than fall through as if the packet were clean.
  const packetScanRan     = packetScan.success === true
  const packetUnverified  = packetScanFaulted || (!packetScanRan && !packetNeverStaged)

  // Owner's rule: any missing item — document, signature or initial — notifies
  // the TC AND/OR the listing agent. The TC comes from the brokerage roster
  // inside notifyComplianceFlag; the two deal-specific people have to be
  // resolved here, because only this function knows the offer and its listing.
  //
  //   · the OFFER's agent — offers.agent_id is an agents.id, so it is RESOLVED
  //     to a users.id, never substituted. It differs from `userId` whenever a
  //     TC or broker submits on the agent's behalf, and in that case the agent
  //     was previously told nothing at all.
  //   · the LISTING agent — the other side of an in-house deal, who has just as
  //     much at stake in a missing seller signature.
  //
  // NOTE: no MLS number is read or required anywhere on this path. Per the
  // owner's ruling the MLS number belongs to the listing-launch checkpoint, not
  // to accepting an offer, and nothing here consults it.
  const dealRecipients: (string | null)[] = []
  if (offer.agent_id) {
    const { data: offerAgent } = await supabase
      .from("agents").select("user_id").eq("id", offer.agent_id as string).maybeSingle()
    dealRecipients.push((offerAgent?.user_id as string | null) ?? null)
  }
  if (offer.listing_id) {
    const { data: listingRow } = await supabase
      .from("listings").select("agent_id").eq("id", offer.listing_id as string).maybeSingle()
    if (listingRow?.agent_id) {
      const { data: listingAgent } = await supabase
        .from("agents").select("user_id").eq("id", listingRow.agent_id as string).maybeSingle()
      dealRecipients.push((listingAgent?.user_id as string | null) ?? null)
    }
  }

  if (hasBlockingMissing || hasPacketBlockers || packetUnverified) {
    // Fan out a critical compliance flag so the agent + TC + compliance_officer
    // all see the unblock work clearly in their bells (high/critical severity
    // routes through multi-channel: in-app + email + SMS-on-consent).
    //
    // "There is no packet" travels the SAME path as every other blocking miss —
    // the owner's step 4 sends the missing piece to the TC and the agent, and
    // an absent packet is the largest possible missing piece. dealRecipients
    // (the offer's agent, RESOLVED agents.id → users.id, plus the listing
    // agent) are already resolved above; notifyComplianceFlag adds the TC and
    // the compliance officer from the brokerage roster.
    const summaryBits: string[] = []
    if (hasBlockingMissing) summaryBits.push(`${audit.missing_blocking.length} required document(s) missing`)
    if (hasPacketBlockers)  summaryBits.push(`${packetScan.blockers.length} packet blocker(s)`)
    if (packetUnverified)   summaryBits.push(`packet check could not run (${packetScan.error ?? "no reason given"})`)

    // What the agent must actually DO. The scanner's blocker bodies carry the
    // remedy for the could-not-run case; a refusal that only names the fault
    // leaves the TC and agent with nothing to finish and resubmit.
    const remedies = packetUnverified
      ? packetScan.blockers.map(b => b.body).filter(Boolean)
      : []

    await notifyComplianceFlag(supabase as any, {
      brokerageId: offer.brokerage_id as string,
      agentUserId: userId,
      alsoNotifyUserIds: dealRecipients,
      flag: {
        type:        "compliance.submit_blocked",
        severity:    "high",
        title:       `Submit to compliance blocked: ${summaryBits.join(", ")}`,
        body:        `Missing required: ${audit.missing_blocking.join(", ") || "(none)"}.\nPacket blockers: ${packetScan.blockers.slice(0, 5).map(b => b.title).join("; ") || "(none)"}.${remedies.length > 0 ? `\nWhat to do: ${remedies.join(" ")}` : ""}`,
        entityType:  "offer",
        entityId:    offerId,
        offerId,
      },
    })

    return {
      success: false,
      error: `Cannot submit to compliance — ${summaryBits.join(" and ")}. Fix the listed items first.${remedies.length > 0 ? ` ${remedies.join(" ")}` : ""}`,
      missing_required: audit.missing_blocking,
      packet_blockers: packetScan.blockers.map(b => ({
        flagType: b.flagType, severity: b.severity, title: b.title,
      })),
    }
  }

  // 1.55 — "BOTH SIDES", asserted explicitly instead of assumed.
  //
  // Obligation 3 of the owner's ruling is that signatures and initials are
  // complete ON BOTH SIDES. Two altitudes can speak to that, and only one of
  // them can actually answer it:
  //
  //   · the OFFER row — buyer_signed_at, plus an executed contract on file by
  //     one of the two named paths. Both sides, established from columns, and
  //     already enforced by the early returns at the top of this function.
  //     THIS is the assertion.
  //   · the PACKET — field level. It can only speak about the sides it
  //     actually contains. `signatureSides` reports what it could show, and a
  //     side it never mentioned comes back `evidenced:false` — which is
  //     SILENCE, not a pass. An outstanding block on a side the packet DID
  //     show is already a blocker above, and that blocker names the side.
  //
  // The packet cannot be made to assert both sides today: the fill engine
  // emits no signature or initial fields at all for state-association forms,
  // and the only source of side-bearing signature names is a brokerage's own
  // uploaded field_schema. Evidence in docs/wave9-slice-gate.md. So the
  // assertion is RECORDED with the column that established each side, and a
  // packet that could not corroborate it is notified — never silently counted
  // as corroboration.
  const sides = packetScan.signatureSides
  const bothSidesInPacket = sides.buyer.evidenced && sides.seller.evidenced
  const sidesAbsentFromPacket = [
    sides.buyer.evidenced  ? null : "buyer",
    sides.seller.evidenced ? null : "seller",
  ].filter(Boolean) as string[]
  // A ONE-SIDED packet is the per-deal signal: this packet DOES carry signature
  // blocks, and one side's are simply not in it — the buyer-only packet that
  // used to pass with zero blockers. A packet carrying no signature blocks at
  // ALL is a different fact: it is every packet the fill engine builds today,
  // so notifying it per deal would be noise that teaches people to ignore the
  // bell. That one is recorded on the gate row instead, where it is durable and
  // where a reader is asking what was verified.
  const packetIsOneSided = (sides.buyer.evidenced || sides.seller.evidenced) && !bothSidesInPacket
  // THE BUYER SIDE NAMES ITS EVIDENCE, not merely its column.
  //
  // "offers.buyer_signed_at" was true and useless: it said a timestamp existed,
  // never what put it there. Now that the column has two admissible writers —
  // our e-sign webhook, and a named human attesting to the executed contract on
  // file — a gate row that does not distinguish them cannot be audited at all.
  // `established_by` therefore carries the SOURCE, and for an attestation the
  // whole record travels with it: who, when, which document, and what the
  // classifier could (or could not) see on that document.
  const bothSidesRecord = {
    buyer: {
      established_by: buyerSignatureEstablishedBy(buyerEvidence),
      at:             offer.buyer_signed_at ?? null,
      evidence:       buyerEvidence,
    },
    seller: {
      established_by: executedViaResponse
        ? "offers.seller_response_type='accepted' + offers.fully_signed_contract_received_at"
        : "offers.seller_signed_at + offers.fully_signed_contract_received_at",
      at:             offer.fully_signed_contract_received_at ?? null,
    },
    // Did the FIELD-LEVEL packet independently show a signature block for each
    // side? A reader of this event must never infer that it did.
    packet_corroborated:      bothSidesInPacket,
    packet_sides_not_shown:   sidesAbsentFromPacket,
    packet_side_evidence:     sides,
  }

  // 1.6 — WARNING-level misses still get told to somebody.
  //
  // Owner's rule is "whether or not a doc is required or a warning, any missing
  // item … needs to be a notification to the TC and/or the listing agent". Only
  // the BLOCKING path notified anyone; a settings-marked warning passed through
  // in total silence, which made the required/warning switch a choice between
  // "stops the deal" and "nobody ever hears about it".
  const warningDocs  = audit.missing_warning ?? []
  const packetWarns  = packetScan.warnings ?? []

  // ── PRESENT BUT NOT EXECUTED — the miss this checkpoint could not see ──────
  //
  // The audit above answers "is the document THERE". Nothing here answered "is
  // it SIGNED AND INITIALED", for any required document other than the purchase
  // contract: the packet scan reads the offer's own staged packet, and the
  // buyer/seller evidence block reads the offer's columns. A required agency
  // disclosure, lead-paint addendum or brokerage form could be uploaded blank,
  // satisfy `missing_blocking`, and pass compliance in silence.
  //
  // It did not stay silent forever — lib/transactions/transaction-creation-gate.ts
  // refuses transaction creation on exactly this, by the owner's rule that a
  // transaction exists "only after the compliance is good, all documents are
  // present with full signatures and initials". So the fact was already computed
  // and already load-bearing; it was just discovered a stage TOO LATE, at the
  // moment the deal tried to become a transaction, by which point compliance had
  // been stamped and everyone believed the file was clean.
  //
  // This calls the gate's OWN pure reader rather than a second copy of it, so the
  // warning a TC sees here and the refusal they would hit later are the same
  // reading of the same deal file. Owner's rule for this path, verbatim, is the
  // one already quoted above: "whether or not a doc is required or a warning, any
  // missing item … needs to be a notification to the TC and/or the listing
  // agent" — an unsigned required document is a missing item.
  //
  // WARNING, NOT A BLOCK, and deliberately so. `medium` severity is the in-app
  // bell only (see the flag below), so this never becomes an email + SMS on every
  // deal; and turning it into a refusal here would change what submitting to
  // compliance MEANS, which is a ruling this does not have. The gate still
  // refuses at creation — this only stops the TC finding out then.
  const unexecutedRequired = findUnexecutedDocuments(
    audit.deal_file,
    audit.required_breakdown.map((r) => r.classification),
  )
  // Split the way the gate splits them: a document nobody SCANNED has a different
  // remedy from one a party has not signed — "scan it" rather than "chase them".
  const unexecutedNeverScanned = unexecutedRequired.filter((u) => u.unscanned)
  const unexecutedRealGaps     = unexecutedRequired.filter((u) => !u.unscanned)
  // THE ATTESTATION AND THE SCANNER DISAGREE.
  //
  // A buyer signature established by human attestation carries the classifier's
  // reading of the SAME document beside it. When the classifier positively
  // reported that it could not find the buyer's signature on that page, the two
  // records contradict each other. That does NOT reverse the attestation — a
  // model's reading of a scan is not authority over a person holding the paper,
  // and `evaluateExecution` returns "not executed" for a blob it never got, so
  // treating it as a veto would block honest deals. But it is exactly the kind of
  // disagreement nobody should discover after closing, so it is NAMED to the TC
  // and the agent on the existing warning path. `checked` is load-bearing:
  // unchecked is silence, not agreement.
  const attestationContested =
    buyerEvidence.source === "attested_executed_contract" &&
    buyerEvidence.ai_corroboration?.checked === true &&
    buyerEvidence.ai_corroboration?.executed === false
  if (warningDocs.length > 0 || packetWarns.length > 0 || packetIsOneSided
      || attestationContested || unexecutedRequired.length > 0) {
    const warnBits: string[] = []
    if (warningDocs.length > 0) warnBits.push(`${warningDocs.length} optional document(s) missing`)
    if (packetWarns.length > 0) warnBits.push(`${packetWarns.length} packet warning(s)`)
    if (unexecutedRealGaps.length > 0) {
      warnBits.push(`${unexecutedRealGaps.length} required document(s) not fully signed/initialed`)
    }
    if (unexecutedNeverScanned.length > 0) {
      warnBits.push(`${unexecutedNeverScanned.length} required document(s) never scanned`)
    }
    if (attestationContested) {
      warnBits.push("the document scan could not find the buyer signature that was attested")
    }
    // Named, not silent. "This packet has buyer signature blocks and no seller
    // ones" is a fact the TC and the agent are entitled to know, because it is
    // the difference between a signature that was checked and one that was
    // taken on the strength of the offer row alone.
    if (packetIsOneSided) {
      warnBits.push(`packet is one-sided — no signature block for: ${sidesAbsentFromPacket.join(", ")}`)
    }
    await notifyComplianceFlag(supabase as any, {
      brokerageId: offer.brokerage_id as string,
      agentUserId: userId,
      alsoNotifyUserIds: dealRecipients,
      flag: {
        // medium → in-app bell only. A warning must be visible without
        // becoming an email + SMS on every deal.
        type:       "compliance.submit_warnings",
        severity:   "medium",
        title:      `Submitted with warnings: ${warnBits.join(", ")}`,
        body:       `Missing (warning): ${warningDocs.join(", ") || "(none)"}.\nPacket warnings: ${packetWarns.slice(0, 5).map(w => w.title).join("; ") || "(none)"}.`
                  // NAMED, not counted. The header line says how many; a TC needs
                  // to know WHICH document and WHOSE signature or initial, because
                  // that is the difference between an email to the seller and a
                  // re-scan. Same split, same wording as the creation gate's own
                  // refusal, so the two read as one system.
                  + (unexecutedRealGaps.length > 0
                     ? `\nPresent but NOT fully executed — the transaction gate will refuse creation on these: ${
                         unexecutedRealGaps.slice(0, 8).map((u) =>
                           `${u.label} (missing ${[...u.missingSignatures, ...u.missingInitials].join(", ")})`,
                         ).join("; ")}. A signature block being filled does not make a document complete when a page initial is blank.`
                     : "")
                  + (unexecutedNeverScanned.length > 0
                     ? `\nRequired but NEVER SCANNED — nothing about these has been verified, so they cannot be treated as signed: ${
                         unexecutedNeverScanned.slice(0, 8).map((u) => u.label).join("; ")}. Open each one and run the document scan.`
                     : "")
                  + (packetIsOneSided
                     ? `\nBoth-sides check: the staged packet carries signature blocks, but none naming the ${sidesAbsentFromPacket.join(" or ")} side — so that side was NOT verified field-by-field. It rests on the offer record: ${bothSidesRecord.buyer.established_by} and ${bothSidesRecord.seller.established_by}. Open the executed contract and confirm every ${sidesAbsentFromPacket.join(" and ")} signature and initial is on it.`
                     : "")
                  + (attestationContested
                     ? `\nBuyer signature — ATTESTED BUT CONTESTED: ${buyerEvidence.attested_by_name ?? buyerEvidence.attested_by_user_id ?? "someone"} attested on ${buyerEvidence.attested_at} that the executed contract carries the buyer's signature dated ${buyerEvidence.signed_at}, but the document scan of that same file reports ${buyerEvidence.ai_corroboration?.missing.join(", ") || "the buyer signature"} as not found. The attestation stands — a person holding the contract outranks a model reading a scan — but open the document and confirm before closing.`
                     : ""),
        entityType: "offer",
        entityId:   offerId,
        offerId,
      },
    })
  }

  // 2. Stamp readiness + compliance pass on the offer.
  //
  // CHECKED, not fire-and-forget: `offers.compliance_passed_at` is the column
  // lib/transactions/offer-bridge.ts:assertOfferReadyForTransaction refuses on
  // ("compliance has not passed on this offer"). supabase-js RESOLVES a rejected
  // update, so an unread { error } here let step 4 walk straight into a throw
  // whose message named compliance rather than the failed write.
  const { error: stampError } = await supabase
    .from("offers")
    .update({
      ready_for_compliance_at: now,
      compliance_passed_at:    now,
    })
    .eq("id", offerId)
  if (stampError) {
    return { success: false, error: `Compliance stamp could not be written to the offer (${stampError.message}) — nothing downstream was created.` }
  }

  // 3. THE GATE EVENT — delegated, not duplicated.
  //
  // This step used to carry its OWN `buyer.offer.compliance.passed` insert with
  // `entity_type:'offer'` and NO `entity_id`, while
  // lib/buyer-offer/compliance-gate.ts:emitCompliancePassed wrote the SAME event
  // WITH `entity_id` (and no brokerage_id). Two writers of one event disagreeing
  // on the key, and BOTH broken. All three readers require
  // `entity_type='offer' AND entity_id=<offers.id>`:
  // convert-to-transaction.ts:110-112, lib/kernel/transactions.ts:221-223, and
  // compliance-gate.ts:checkCompliancePassed itself.
  //
  // MERGED — this insert's richer audit shape (title/description/notes/
  // contact_id/agent_id/status/priority) was carried onto the survivor and this
  // copy deleted. SURVIVOR: `lib/buyer-offer/compliance-gate.ts:emitCompliancePassed`.
  // The survivor takes brokerage_id + contact_id + agent_id from the OFFER row,
  // so nothing here has to hand it a tenant.
  //
  // FAILS CLOSED: this row IS the gate the transaction lane reads. Creating a
  // transaction after it failed to land would produce a transaction whose gate
  // event does not exist.
  const gateEmit = await emitCompliancePassed({
    offerId,
    userId,
    source:      "agent_submit_to_compliance",
    description: `Agent submitted offer ${offerId} to compliance review. Executed contract on file.`,
    scanResults: {
      missing_warning:  audit.missing_warning ?? [],
      packet_warnings:  (packetScan.warnings ?? []).map(w => w.title),
      submitted_at:     now,
      // WHAT WAS ACTUALLY VERIFIED, and by what. The gate row is the only
      // durable record that this transaction passed compliance; without this
      // it says "passed" and nothing about the evidence, so a later reader
      // cannot tell a field-by-field signature check from a column check.
      // `ran` is the SCAN's own verdict, not an assumption. When no packet was
      // ever staged (the e-sign path), the field-level walk did not happen and
      // this record says so plainly, naming what DID establish both sides —
      // the executed-contract columns enforced at the top of this function.
      // A gate row that claimed a field-by-field check it never performed would
      // be the same lie as the empty-blockers pass this wave removed.
      packet_checked:   {
        ran:                packetScan.scanOutcome === "scanned",
        outcome:            packetScan.scanOutcome,
        document_id:        packetScan.documentId,
        completion_percent: packetScan.completionPercent,
        fields_walked:      packetScan.totalFields,
        both_sides_established_by: packetScan.scanOutcome === "scanned"
          ? "packet_field_scan + executed_contract_columns"
          : "executed_contract_columns_only",
        // EXTENDING wave 9's vocabulary rather than forking it. The line above
        // records the ALTITUDE the check ran at (field-level packet walk vs the
        // offer's columns). This one records what put the buyer's timestamp in
        // that column in the first place, which used to have exactly one
        // possible answer and now has two. A reader asking "was this signature
        // machine-verified or attested by a person?" gets an answer here rather
        // than having to know which webhook writes which column.
        buyer_signature_source:         buyerEvidence.source,
        buyer_signature_established_by: buyerSignatureEstablishedBy(buyerEvidence),
        executed_contract: {
          buyer_signed_at:                   offer.buyer_signed_at ?? null,
          seller_response_type:              offer.seller_response_type ?? null,
          seller_signed_at:                  offer.seller_signed_at ?? null,
          fully_signed_contract_received_at: offer.fully_signed_contract_received_at ?? null,
        },
      },
      both_sides:       bothSidesRecord,
    },
  })
  if (!gateEmit.success) {
    return { success: false, error: `Compliance gate event could not be recorded (${gateEmit.error}) — the transaction was NOT created, because the gate the transaction lane reads does not exist.` }
  }

  // 3b. The lifecycle transition to ACCEPTED.
  //
  // RE-KEYED. This was written with `entity_type:'contact'` and no `entity_id`,
  // so the one event in the system that means "this offer is accepted" was
  // unreachable from the offer: every derivation
  // (track-offer-lifecycle.ts:getOfferLifecycleState,
  // lib/buyer-offer/status-sync.ts, lib/buyer-offer/expire-offers.ts,
  // offer-lifecycle.ts:deriveOfferStateFromActivities) filters
  // entity_type='offer' + entity_id=<offers.id>.
  //
  // ONE ROW, NOT TWO. A second contact-keyed copy was considered and rejected on
  // evidence: no reader in the tree looks for `buyer.offer.*` under a contact
  // key. The contact-keyed activity readers all match a CONTACT-NATIVE
  // activity_type (`buyer.offer.lifecycle` in
  // lib/buyer-lifecycle/extensions/multi-offer-guards.ts:76-78,
  // `contact.lifecycle.sync` in contact-lifecycle-sync.ts:219-221), and the
  // contact timeline surfaces reach this row through `contact_id`, which is
  // still populated below. A duplicate row would also be counted twice by
  // `deriveOfferStateFromActivities`' history and by the counter-round cap in
  // respond-to-counter.ts.
  //
  // activities.agent_id FKs agents(id); use agent_user_id for users(id).
  const { error: acceptedEventError } = await supabase.from("activities").insert({
    brokerage_id:   offer.brokerage_id,
    agent_user_id:  userId,
    agent_id:       offer.agent_id,
    contact_id:     offer.contact_id,
    entity_type:    "offer",
    entity_id:      offerId,
    activity_type:  OFFER_EVENT.ACCEPTED,
    title:          "Offer accepted — under contract",
    description:    `Offer ${offerId} is fully executed; transitioning to UNDER_CONTRACT.`,
    notes:          JSON.stringify({ offer_id: offerId, previous_state: "PENDING", new_state: "ACCEPTED", source: "agent_submit_to_compliance" }),
    metadata:       { offer_id: offerId, source: "agent_submit_to_compliance", accepted_at: now },
    status:         "completed",
  })
  if (acceptedEventError) {
    // FAILS CLOSED for the same reason as the gate above: creating the
    // transaction while the lifecycle still derives PENDING would leave the
    // offer permanently mid-flight (the expiry sweep keys on PENDING).
    return { success: false, error: `Acceptance lifecycle event could not be recorded (${acceptedEventError.message}) — the transaction was NOT created. Retry the submit.` }
  }

  // 4. Create the transaction — same canonical creator the legacy chain
  //    used. Seeds milestones + deadlines, populates participants (buyer,
  //    buyer_agent, seller, seller_agent — never lender/title/inspector).
  const fromContract = (days: number | null | undefined) =>
    days ? new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10) : undefined

  try {
    const result = await createTransactionFromOffer({
      offerId,
      brokerageId:         offer.brokerage_id as string,
      contractDate:        finalContractDate,
      compliancePassedAt:  now,
      contractTerms: {
        // earnestMoneyDue is a DATE term (milestone target), not the deposit amount —
        // passing String(offer.earnest_money) here fed "$5000" into the earnest-money
        // milestone date. Leave it unset: the bridge derives the real due date from
        // contract_date + offers.earnest_money_due_days / earnest_money_due_at.
        inspectionDeadline:  fromContract(offer.inspection_period_days as number | null),
        appraisalDeadline:   fromContract(offer.appraisal_contingency_days as number | null),
        financingDeadline:   fromContract(offer.financing_contingency_days as number | null),
        closingDate:         (offer.closing_date as string | null) ?? undefined,
      },
    })
    if (!result?.success || !result.transactionId) {
      return { success: false, error: "Transaction creation failed in offer-bridge" }
    }

    // No supersede cascade. The original offer is always the parent root and
    // stays part of the executed contract; counters AMEND it, they don't
    // replace it. The has_counter checkbox on the parent (set by
    // issueCounterOffer) is the UI signal. The compliance package reads the
    // full chain via parent_offer_id from the counter back to the original.
    // THE LOOP CLOSES. Compliance has just verified every required document is
    // present and every signature/initial complete on both sides, so nothing
    // outstanding on this offer can still be true. Sweep the flag ledger and
    // record WHO cleared it and WHEN.
    //
    // AFTER the transaction, deliberately: the owner's ruling is "if all are
    // present, then a transaction is created". A fault in the flag ledger must
    // not withhold the transaction — but it must not be swallowed either, or we
    // reproduce the write-only outbox this wave exists to fix.
    const cleared = await resolveOfferComplianceFlags({
      offerId,
      brokerageId: offer.brokerage_id as string,   // from the OFFER row, never a caller
      actorUserId: userId,                          // users-class; never crossed into agent_id
      reason: `Compliance gate passed on ${now} — all required documents present, all signatures and initials complete on both sides. Transaction ${result.transactionId} created.`,
    })
    if (!cleared.success) {
      console.error(`[submit-to-compliance] offer ${offerId}: transaction ${result.transactionId} was created but the compliance flag ledger was not cleared:`, cleared.error)
    }

    return { success: true, transaction_id: result.transactionId }
  } catch (err: any) {
    return { success: false, error: err?.message ?? "Transaction creation threw" }
  }
}
