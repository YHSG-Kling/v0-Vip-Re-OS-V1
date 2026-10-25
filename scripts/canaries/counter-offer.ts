/**
 * scripts/canaries/counter-offer.ts — COUNTER canary (wave 144, lane 144J; owner ruling 2 "counter follows the offer"):
 *   ORIGINAL OFFER → COUNTER → ACCEPTED COUNTER + ORIGINAL (+ADDENDA) → ALL SIGNATURES/INITIALS → COMPLIANCE SCAN of the
 *   complete governing packet → COMPLIANCE APPROVAL → EXECUTED CONTRACT → ONE TRANSACTION; every version kept (the counter never
 *   replaces the original); an unaccepted counter never becomes terms; with several counters the ACCEPTED sequence governs, not
 *   the latest draft; an outside agent's email is never automatic legal acceptance.
 * Through the survivors at 967a4866: lib/offers/governing-terms-rule.ts (versionsFromOfferChain / resolveGoverningTerms — the
 * pure precedence rule), lib/transactions/offer-compliance-loop.ts → app/actions/buyer-offer/submit-to-compliance.ts (the ONE
 * chokepoint: brokerage checklist + packet audit → lib/transactions/transaction-creation-gate.ts → offer-bridge's insert),
 * lib/offers/outside-offer-loop.ts (verifyOutsideSender / reconcileReplyClassification — recommendations, never state changes).
 * In memory; the sessionless automation presents CRON_SECRET exactly as the offer-lifecycle canary does. Nothing is sent.
 *
 * MEASURED AT 967a4866: the precedence rule holds (green). The compliance chokepoint audits the BROKERAGE CHECKLIST's
 * classifications only — an accepted COUNTER document that is not fully signed is not part of the scan unless the brokerage
 * happened to list counter_offer, so the executed contract can be promoted with its counter unsigned — 144C.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"

export async function run() {
  const c = canary("Counter: original + accepted counter (+addenda) → all signatures → compliance of the COMPLETE packet → ONE transaction · versions kept · accepted sequence governs · email ≠ acceptance")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only")

  // ── 1 · THE PRECEDENCE RULE (pure) ──
  const { versionsFromOfferChain, resolveGoverningTerms } = await import("../../lib/offers/governing-terms-rule")
  const t = (h: number) => new Date(Date.UTC(2026, 9, 20, h)).toISOString()
  const O = "o-root", C1 = "c-1", C2 = "c-2", C3 = "c-3"
  // The buyer's offer $400k with $10k earnest money → the seller counters $410k (C1) → the buyer counters back $405k (C2), the
  // seller ACCEPTS and both sign C2 → later someone drafts C3 at $402k that nobody signs.
  const chain = [
    { id: O, parent_offer_id: null, current_round: 1, offer_type: "purchase", status: "countered", offer_price: 400_000, earnest_money: 10_000, buyer_signed_at: t(1), seller_signed_at: null, created_at: t(1) },
    { id: C1, parent_offer_id: O, current_round: 2, offer_type: "counter", status: "countered", offer_price: 410_000, seller_signed_at: t(2), buyer_signed_at: null, created_at: t(2) },
    { id: C2, parent_offer_id: C1, current_round: 3, offer_type: "counter", status: "accepted", offer_price: 405_000, buyer_signed_at: t(3), seller_signed_at: t(4), fully_signed_contract_received_at: t(4), created_at: t(3) },
    { id: C3, parent_offer_id: C2, current_round: 4, offer_type: "counter", status: "draft", offer_price: 402_000, created_at: t(5) },
  ]
  const gov = resolveGoverningTerms(versionsFromOfferChain(chain as never))
  c.rule("144C", "THE ACCEPTED SEQUENCE GOVERNS (pure): offer $400k → seller counter $410k → buyer counter-back $405k ACCEPTED and signed by both → a later unsigned $402k draft: the governing price is $405,000 (the accepted counter), the earnest money only the ORIGINAL names ($10,000) survives under it, the unsigned draft is PENDING and governs nothing, and all four versions are kept (the original is never replaced)", gov.values.offer_price === 405_000 && gov.values.earnest_money === 10_000 && gov.pending.some((v) => v.offerId === C3) && !gov.pending.some((v) => v.offerId === C2) && gov.versions.length === 4 && gov.governingVersion?.offerId === C2, JSON.stringify({ price: gov.values.offer_price, emd: gov.values.earnest_money, governing: gov.governingVersion, pending: gov.pending.map((v) => v.offerId) }))
  const unaccepted = resolveGoverningTerms(versionsFromOfferChain([{ ...chain[0], status: "countered" }, { ...chain[1], status: "countered" }] as never))
  c.rule("144C", "AN UNACCEPTED COUNTER NEVER BECOMES TERMS (pure): offer + a seller counter nobody accepted → NOTHING is executed (no governing version, no governing price) and the counter is reported pending", unaccepted.governingVersion === null && unaccepted.values.offer_price === undefined && unaccepted.pending.some((v) => v.offerId === C1), JSON.stringify(unaccepted.governingVersion))

  // ── 1b · THE CONTRACT IS THE ACCEPTED SEQUENCE (lane 144C's rule, folded in from its notes — Verdict 1) ──
  // lib/offers/governing-terms-rule.ts acceptedOfferSequence (landed by 144C in an EXISTING file; absent at 967a4866 → red). On a
  // chain with a REJECTED counter, an ACCEPTED sibling counter and a later unsigned counter-back: the contract is root → the
  // accepted sibling; the rejected one and the counter-back are REPORTED (never deleted); a second executed branch is refused by
  // name (a person says which was accepted); a chain that already became a transaction is reported so the gate refuses a second.
  const termsRule = (await import("../../lib/offers/governing-terms-rule")) as Record<string, any>
  const seq = typeof termsRule.acceptedOfferSequence === "function" ? (() => {
    const R = "s-root", REJ = "s-rej", ACC = "s-acc", BACK = "s-back"
    const rows = [
      { id: R, parent_offer_id: null, offer_type: "purchase", status: "countered", buyer_signed_at: t(1), seller_signed_at: null, created_at: t(1) },
      { id: REJ, parent_offer_id: R, offer_type: "counter", status: "rejected", seller_signed_at: t(2), buyer_signed_at: null, created_at: t(2) },
      { id: ACC, parent_offer_id: R, offer_type: "counter", status: "accepted", seller_signed_at: t(3), buyer_signed_at: t(4), fully_signed_contract_received_at: t(4), created_at: t(3) },
      { id: BACK, parent_offer_id: ACC, offer_type: "counter", status: "draft", created_at: t(5) },
    ]
    const ok = termsRule.acceptedOfferSequence(rows, ACC)
    const excluded = ok.ok ? Object.fromEntries(ok.sequence.excluded.map((e: { offerId: string; reason: string }) => [e.offerId, e.reason])) : {}
    const competing = termsRule.acceptedOfferSequence(rows.map((r) => (r.id === REJ ? { ...r, status: "accepted", buyer_signed_at: t(2) } : r)), ACC)
    const already = termsRule.acceptedOfferSequence(rows.map((r) => (r.id === R ? { ...r, transaction_id: "tx-earlier" } : r)), ACC)
    return {
      sequenceIsRootThenAccepted: ok.ok && ok.sequence.sequence.join() === `${R},${ACC}`,
      rejectedAndCounterBackReported: excluded[REJ] === "void" && excluded[BACK] === "after_execution",
      secondExecutedBranchRefused: !competing.ok && competing.code === "competing_execution",
      earlierTransactionReported: already.ok && already.sequence.transactionIds.includes("tx-earlier"),
    }
  })() : null
  c.rule("144C", "THE CONTRACT IS THE ACCEPTED SEQUENCE, NOT THE LATEST DRAFT (ruling 2 + lane 144C): offer → a REJECTED counter, an ACCEPTED sibling counter (both signed) → a later unsigned counter-back — the contract is the original + the accepted sibling; the rejected counter and the counter-back are REPORTED (every version kept); a second executed branch is refused by name (a person says which was accepted); a chain that already became a transaction is reported, so the gate refuses a second one", !!seq && Object.values(seq).every(Boolean), seq ? `landed rule: ${JSON.stringify(seq)}` : "HEAD: no accepted-sequence rule in lib/offers/governing-terms-rule.ts (the checkpoints scan the submitted row's paperwork only)")

  // ── 2 · THE COMPLIANCE SCAN COVERS THE COMPLETE PACKET (original + accepted counter) ──
  const B = uuid(), AG_U = uuid(), AG = uuid(), BUYER = uuid(), ROOT = uuid(), CTR = uuid(), DOC_C = uuid(), DOC_O = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Counter Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-counter`, state: "FL" }],
    users: [{ id: AG_U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B, first_name: "Canary", last_name: "Agent", team_id: null }],
    agents: [{ id: AG, user_id: AG_U, brokerage_id: B, first_name: "Canary", last_name: "Agent", is_active: true }],
    contacts: [{ id: BUYER, brokerage_id: B, agent_id: AG, first_name: "Bo", last_name: "Buyer", email: `buyer@${CANARY_EMAIL_DOMAIN}`, contact_type: "buyer", status: "active", notes: CANARY_TAG }],
    offers: [
      // The ORIGINAL buyer offer (outside listing): buyer-signed, then countered by the seller.
      { id: ROOT, brokerage_id: B, contact_id: BUYER, agent_id: AG, listing_id: null, property_address: `7 Counter Ct, Pensacola, FL 32501 ${CANARY_TAG}`, offer_type: "purchase", status: "countered", has_counter: true, buyer_signed_at: nowIso(), seller_signed_at: null, seller_response_type: null, fully_signed_contract_received_at: null, compliance_passed_at: null, transaction_id: null, parent_offer_id: null, current_round: 1, offer_price: 400_000, earnest_money: 10_000, closing_date: null, metadata: {}, created_at: nowIso() },
      // The seller's COUNTER at $405k: the seller signed it, the buyer signed it back → executed by the counter path.
      { id: CTR, brokerage_id: B, contact_id: BUYER, agent_id: AG, listing_id: null, property_address: `7 Counter Ct, Pensacola, FL 32501 ${CANARY_TAG}`, offer_type: "counter", status: "accepted", buyer_signed_at: nowIso(), seller_signed_at: nowIso(), seller_response_type: null, fully_signed_contract_received_at: nowIso(), compliance_passed_at: null, transaction_id: null, parent_offer_id: ROOT, current_round: 2, offer_price: 405_000, earnest_money: 10_000, closing_date: null, metadata: {}, created_at: nowIso() },
    ],
    // The brokerage's checklist names the purchase contract only (a typical checklist — counters are not listed separately).
    brokerage_required_documents: [{ id: uuid(), brokerage_id: B, classification: "signed_contract", scope_type: "brokerage", scope_id: B, block_on_missing: true, is_required: true, deal_type: "buyer", state_code: null, description: null, template_form_id: null }],
    documents: [
      // The original purchase contract: complete.
      { id: DOC_O, brokerage_id: B, contact_id: BUYER, listing_id: null, document_type: "signed_contract", classification: "signed_contract", status: "uploaded", signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }], initials: [{ signer_role: "buyer", all_required_initials_present: true }, { signer_role: "seller", all_required_initials_present: true }] }, metadata: { linked_offer_id: CTR }, content: null },
      // The ACCEPTED COUNTER document: the seller's signature is MISSING on the paper.
      { id: DOC_C, brokerage_id: B, contact_id: BUYER, listing_id: null, document_type: "counter_offer", classification: "counter_offer", status: "uploaded", signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: false }], initials: [{ signer_role: "buyer", all_required_initials_present: true }, { signer_role: "seller", all_required_initials_present: false }] }, metadata: { linked_offer_id: CTR }, content: null },
    ],
  })
  setSvc(svc)
  const txs = () => (svc.tables.transactions ?? []).filter((x) => x.brokerage_id === B)
  const { runOfferComplianceLoop } = await import("../../lib/transactions/offer-compliance-loop")
  const prevSecret = process.env.CRON_SECRET
  process.env.CRON_SECRET = `canary-${uuid()}`
  try {
    const first = await runOfferComplianceLoop(svc as never, { brokerageId: B, offerId: CTR, trigger: "agreement_executed" })
    c.rule("144C", "BOTH GO THROUGH THE COMPLIANCE SCAN (ruling 2): the accepted counter's own document is part of the executed contract — with the SELLER'S signature missing on the counter paper, compliance BLOCKS (naming the counter) and NO transaction exists, even though the brokerage's checklist lists only the purchase contract", first.outcome === "blocked" && txs().length === 0 && /counter/i.test(first.reason ?? ""), `HEAD: outcome ${first.outcome}; transactions ${txs().length}; ${(first.reason ?? "").slice(0, 160)} — the chokepoint audits the checklist's classifications only (transaction-creation-gate.ts findUnexecutedDocuments: requiredSet)`)
    // The seller signs the counter paper → the packet is complete.
    const docC = (svc.tables.documents ?? []).find((d) => d.id === DOC_C)
    if (docC) docC.signature_completeness = { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }], initials: [{ signer_role: "buyer", all_required_initials_present: true }, { signer_role: "seller", all_required_initials_present: true }] }
    const second = txs().length ? first : await runOfferComplianceLoop(svc as never, { brokerageId: B, offerId: CTR, trigger: "document_uploaded" })
    const tx = txs()[0]
    c.rule("144C", "COMPLETE PACKET → EXECUTED CONTRACT → ONE TRANSACTION at the ACCEPTED terms: once every signature and initial on the original AND the counter is present, compliance passes and exactly ONE transaction exists, priced at the accepted counter's $405,000 (never the original's $400,000), linked to the counter; the ORIGINAL offer row still exists unchanged (the counter never replaces it)", txs().length === 1 && Number(tx?.purchase_price) === 405_000 && (svc.tables.offers ?? []).some((o) => o.id === ROOT && o.offer_price === 400_000), `outcome ${second.outcome}; transactions ${txs().length}; price ${tx?.purchase_price}; ${(second.reason ?? "").slice(0, 120)}`)
    const third = await runOfferComplianceLoop(svc as never, { brokerageId: B, offerId: CTR, trigger: "document_uploaded" })
    c.rule("144C", "IDEMPOTENT: the loop on a converted counter creates nothing more — ONE transaction for the executed contract", txs().length === 1 && third.outcome !== "advanced", `${third.outcome}; transactions ${txs().length}`)
  } finally {
    if (prevSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prevSecret
  }

  // ── 3 · THE OUTSIDE-LISTING LOOP: an email is never legal acceptance (pure) ──
  const { verifyOutsideSender, reconcileReplyClassification, deterministicReplySignals } = await import("../../lib/offers/outside-offer-loop")
  const spoof = verifyOutsideSender({ recordedEmail: "la@other.test", fromEmail: "la@other.test", senderAuth: "fail" })
  const assistant = verifyOutsideSender({ recordedEmail: "la@other.test", fromEmail: "tc@other.test", senderAuth: "pass" })
  const ok = verifyOutsideSender({ recordedEmail: "la@other.test", fromEmail: "LA@other.test", senderAuth: "pass" })
  c.rule("144C", "VERIFIED SENDER (external-listing loop): a reply whose domain FAILED authentication is quarantined; a reply from someone other than the recorded listing agent is never trusted (a human confirms); only the recorded agent with an authenticated domain is trusted", spoof.quarantine && !spoof.trusted && !assistant.trusted && !assistant.quarantine && ok.trusted, `${spoof.reason.slice(0, 60)} | ${assistant.reason.slice(0, 60)}`)
  const words = deterministicReplySignals("Re: offer", "We accept your offer, congrats!")
  const noPdf = reconcileReplyClassification({ signals: words, reading: { classification: "acceptance", confidence: 0.95 } as never, pdfCount: 0 })
  const withPdf = reconcileReplyClassification({ signals: words, reading: { classification: "acceptance", confidence: 0.95 } as never, pdfCount: 1 })
  c.rule("144C", "AN OUTSIDE AGENT'S EMAIL IS NEVER AUTOMATIC ACCEPTANCE: 'We accept your offer' with no signed contract attached reads AMBIGUOUS → request_signed_document; with the signed PDF it is a RECOMMENDATION to record acceptance (the agent confirms — the classifier changes no offer state)", noPdf.classification === "ambiguous" && noPdf.recommendedAction === "request_signed_document" && withPdf.recommendedAction === "record_acceptance", `${noPdf.classification}/${noPdf.recommendedAction} · ${withPdf.classification}/${withPdf.recommendedAction}`)

  c.blind("The signing itself is modelled by the offer columns and the scanner's signature_completeness fixture (no provider). The packet's ADDENDA half is not seeded (no addendum classification on this deal); the rule asserted for the counter applies to an addendum the same way. The chokepoint ran under the internal secret (a provider webhook's posture), not a session.")
  const cl = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", cl.mismatches.length === 0 && cl.residual === 0, cl.cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cl.cleanup, cl.residual)
}
