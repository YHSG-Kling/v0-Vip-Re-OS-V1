/**
 * scripts/canaries/offer-lifecycle.ts — OFFER canary (wave 142, lane 142J):
 *   in-house and OUTSIDE-PROPERTY offers (no internal listing id) → required buyer/seller signatures → compliance
 *   detects a missing contract / initials → corrections + approval → the transaction exists ONLY after clearance
 * through the survivors at HEAD: lib/transactions/offer-execution-state.ts (offerExecutionPath / isOfferFullyExecuted /
 * shouldAutoExecuteOffer — the ONE predicate), lib/buyer-offer/offer-lifecycle.ts (OFFER_EVENT / OFFER_AUDIT_EVENT —
 * two disjoint vocabularies the compiler holds apart), lib/transactions/offer-bridge.ts (assertOfferReadyForTransaction
 * — the offer-side gate every creator inherits), lib/buyer-offer/compliance-gate.ts (checkCompliancePassed — the audit
 * activity is THE source of truth), lib/transactions/transaction-creation-gate.ts (assertTransactionCreationAllowed —
 * the four obligations in the owner's order, refusing manual sheets with no offer) and lib/transactions/
 * offer-compliance-loop.ts → auto-execute-offer.ts → app/actions/buyer-offer/submit-to-compliance.ts (the ONE
 * chokepoint: audit the brokerage checklist + the packet, fan out flags, stamp compliance_passed_at, create the
 * transaction). Owner (wave 142): "it is listings and offers and then the offer turns into a transaction after the
 * offer passes compliance for an executed contract … An outside-property offer needs NO internal listing id. Never
 * create a transaction because an offer was submitted / accepted verbally / envelope marked complete."
 * In-memory only: offers holds 0 live rows (2026-10-19). The sessionless automation presents CRON_SECRET exactly as a
 * provider webhook would; no session exists (the canary client's auth answers "nobody signed in").
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor, readRepo, strippedRepo } from "./_registry"

export async function run() {
  const c = canary("Offer: outside-property + in-house → buyer/seller signatures → compliance catches missing forms/initials → corrections + approval → transaction only after clearance")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only — offers holds 0 live rows and the loop pages real TCs")
  const B = uuid(), B2 = uuid(), AG_U = uuid(), AG = uuid(), TC_U = uuid(), BUYER = uuid(), O = uuid(), O_IN = uuid(), L = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-offer`, state: "FL" }, { id: B2, name: `${CANARY_TAG} Other`, plan_tier: "team", slug: `${CANARY_TAG}-offer2` }],
    users: [
      { id: AG_U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B, first_name: "Canary", last_name: "Agent", team_id: null },
      { id: TC_U, email: `tc@${CANARY_EMAIL_DOMAIN}`, user_type: "tc", brokerage_id: B, first_name: "Canary", last_name: "Coordinator" },
    ],
    agents: [{ id: AG, user_id: AG_U, brokerage_id: B, first_name: "Canary", last_name: "Agent", is_active: true }],
    contacts: [{ id: BUYER, brokerage_id: B, agent_id: AG, first_name: "Bo", last_name: "Buyer", email: `buyer@${CANARY_EMAIL_DOMAIN}`, contact_type: "buyer", status: "active", notes: CANARY_TAG }],
    listings: [{ id: L, brokerage_id: B, agent_id: AG, address: "2 Canary Way", city: "Pensacola", state: "FL", zip: "32501", status: "active", notes: CANARY_TAG, created_at: nowIso() }],
    offers: [
      // THE OUTSIDE-PROPERTY OFFER: our buyer on someone else's listing — listing_id NULL, the address on the row.
      { id: O, brokerage_id: B, contact_id: BUYER, agent_id: AG, listing_id: null, property_address: `9 Outside Rd, Pensacola, FL 32501 ${CANARY_TAG}`, offer_type: "purchase", status: "draft", buyer_signed_at: null, seller_signed_at: null, seller_response_type: null, fully_signed_contract_received_at: null, compliance_passed_at: null, ready_for_compliance_at: null, transaction_id: null, parent_offer_id: null, closing_date: null, earnest_money: 5000, offer_price: 400000, metadata: {}, form_source: null, provider_envelope_id: null, offer_document_url: null, created_at: nowIso() },
      // An in-house offer on our own listing, untouched by the flow (the listing anchor is optional, never required).
      { id: O_IN, brokerage_id: B, contact_id: BUYER, agent_id: AG, listing_id: L, property_address: "2 Canary Way, Pensacola, FL 32501", offer_type: "purchase", status: "draft", buyer_signed_at: null, seller_signed_at: null, seller_response_type: null, fully_signed_contract_received_at: null, compliance_passed_at: null, transaction_id: null, metadata: {}, created_at: nowIso() },
    ],
    // The brokerage's buyer-deal checklist: the signed purchase contract is REQUIRED and blocks.
    brokerage_required_documents: [{ id: uuid(), brokerage_id: B, classification: "signed_contract", scope_type: "brokerage", scope_id: B, block_on_missing: true, is_required: true, deal_type: "buyer", state_code: null, description: null, template_form_id: null }],
  })
  setSvc(svc)
  const offer = () => (svc.tables.offers ?? []).find((o) => o.id === O)
  const patch = (p: Record<string, unknown>) => Object.assign(offer() ?? {}, p)

  // ── 1 · the ONE predicate and the two vocabularies (pure) ──
  const { offerExecutionPath, isOfferFullyExecuted, shouldAutoExecuteOffer } = await import("../../lib/transactions/offer-execution-state")
  const { OFFER_EVENT, OFFER_AUDIT_EVENT, EVENT_TO_STATE, EVENT_TO_STATUS, TERMINAL_OFFER_STATES, isTerminalOfferState } = await import("../../lib/buyer-offer/offer-lifecycle")
  const buyerOnly = { buyer_signed_at: nowIso(), seller_response_type: null, seller_signed_at: null, fully_signed_contract_received_at: null, transaction_id: null }
  const accepted = { ...buyerOnly, seller_response_type: "accepted", fully_signed_contract_received_at: nowIso() }
  const counter = { ...buyerOnly, seller_signed_at: nowIso(), fully_signed_contract_received_at: nowIso() }
  c.step("fully executed (pure): buyer-only → not executed; seller ACCEPTED + the signed contract on file → seller_accepted; a seller-signed COUNTER the buyer signed → seller_counter_signed; 'accepted' wins when both; a verbal acceptance with no contract on file is NOTHING; a converted offer never auto-executes again", !isOfferFullyExecuted(buyerOnly) && offerExecutionPath(accepted) === "seller_accepted" && offerExecutionPath(counter) === "seller_counter_signed" && offerExecutionPath({ ...counter, seller_response_type: "accepted" }) === "seller_accepted" && offerExecutionPath({ ...buyerOnly, seller_response_type: "accepted" }) === null && shouldAutoExecuteOffer(accepted) && !shouldAutoExecuteOffer({ ...accepted, transaction_id: uuid() }), "")
  const lifecycleValues = new Set(Object.values(OFFER_EVENT) as string[]), auditValues = Object.values(OFFER_AUDIT_EVENT) as string[]
  c.step("vocabularies (pure): every lifecycle event maps to exactly one state AND one operational status; the audit events (compliance passed / flagged, buyer signed, provider failed …) are DISJOINT from the lifecycle — a gate refusal or a compliance verdict never moves an offer's state; ACCEPTED / REJECTED / EXPIRED / WITHDRAWN are terminal", Object.values(OFFER_EVENT).every((e) => typeof EVENT_TO_STATE[e] === "string" && typeof EVENT_TO_STATUS[e] === "string") && auditValues.every((a) => !lifecycleValues.has(a)) && TERMINAL_OFFER_STATES.length === 4 && isTerminalOfferState("ACCEPTED") && !isTerminalOfferState("COUNTERED"), `${lifecycleValues.size} lifecycle · ${auditValues.length} audit`)

  // ── 2 · the offer-side gate: no listing id needed, nothing before the executed contract + compliance ──
  const { assertOfferReadyForTransaction } = await import("../../lib/transactions/offer-bridge")
  const g0 = await assertOfferReadyForTransaction({ offerId: O, brokerageId: B })
  c.step("gate 0 — submitted, nobody signed: REFUSED 'buyer has not signed yet' (a submitted offer is never a transaction)", !g0.allowed && /buyer has not signed/.test(g0.reason ?? ""), g0.reason ?? "allowed")
  patch({ buyer_signed_at: nowIso(), status: "pending" })
  const g1 = await assertOfferReadyForTransaction({ offerId: O, brokerageId: B })
  c.step("gate 1 — buyer signed, seller said yes on the phone: REFUSED 'executed contract not on file' (a verbal acceptance is nothing)", !g1.allowed && /executed contract not on file/.test(g1.reason ?? ""), g1.reason ?? "allowed")
  patch({ seller_response_type: "accepted", fully_signed_contract_received_at: nowIso(), status: "accepted" })
  const g2 = await assertOfferReadyForTransaction({ offerId: O, brokerageId: B })
  c.step("gate 2 — fully executed by both, compliance not yet passed: REFUSED 'compliance has not passed' — the executed contract alone never creates the transaction", !g2.allowed && /compliance has not passed/.test(g2.reason ?? "") && offer()?.listing_id === null, g2.reason ?? "allowed")
  const foreign = await assertOfferReadyForTransaction({ offerId: O, brokerageId: B2 })
  c.step("POSITIVE CONTROL (tenant boundary): another tenant asking about this offer is refused 'offer brokerage mismatch'", !foreign.allowed && /brokerage mismatch/.test(foreign.reason ?? ""), foreign.reason ?? "allowed")

  // ── 3 · the compliance ledger: the audit ACTIVITY is the source of truth ──
  const { checkCompliancePassed, validateAcceptanceEligibility } = await import("../../lib/buyer-offer/compliance-gate")
  const notYet = await checkCompliancePassed(O)
  let threw = false
  try { await validateAcceptanceEligibility(O) } catch { threw = true }
  c.step("compliance ledger: with no buyer.offer.compliance.passed activity the offer has NOT passed (no column is trusted) and acceptance eligibility throws", !notYet.passed && threw, notYet.error ?? "")

  // ── 4 · the autonomous loop: executed → the ONE chokepoint → compliance catches the missing contract ──
  const { runOfferComplianceLoop } = await import("../../lib/transactions/offer-compliance-loop")
  const early = await runOfferComplianceLoop(svc as never, { brokerageId: B, offerId: O_IN, trigger: "agreement_executed" })
  c.step("loop on a NOT-executed offer: outside_window — the loop never runs the gate, never creates anything ('never on submit')", early.outcome === "outside_window" && early.transactionId === null && !(svc.tables.transactions ?? []).length, early.reason ?? "")
  const prevSecret = process.env.CRON_SECRET
  process.env.CRON_SECRET = `canary-${uuid()}`
  let blocked: Awaited<ReturnType<typeof runOfferComplianceLoop>>, passed: typeof blocked
  try {
    blocked = await runOfferComplianceLoop(svc as never, { brokerageId: B, offerId: O, trigger: "agreement_executed" })
    const gateState = () => (offer()?.metadata?.compliance_gate ?? {}) as Record<string, unknown>
    const flagRows = () => (svc.tables.activities ?? []).filter((a) => a.entity_id === O && /compliance\.flagged/.test(String(a.activity_type)))
    const flagBells = () => (svc.tables.notifications ?? []).filter((n) => n.brokerage_id === B && n.entity_id === O)
    c.step("executed (seller accepted + contract on file) → the sessionless automation presents the internal secret → the ONE chokepoint audits the brokerage checklist: the SIGNED CONTRACT is required and absent → BLOCKED, no transaction, the blocker recorded on the offer, a compliance flag fanned out to the agent + TC", blocked.outcome === "blocked" && blocked.transactionId === null && !(svc.tables.transactions ?? []).length && gateState().state === "blocked" && !offer()?.compliance_passed_at && (flagRows().length > 0 || flagBells().length > 0), JSON.stringify({ outcome: blocked.outcome, reason: (blocked.reason ?? "").slice(0, 160), flags: flagRows().length, bells: flagBells().length }))
    // INTEGRATOR FINDING (asserted as it stands, never relaxed): lib/transactions/auto-execute-offer.ts:90-101 publishes
    // the "Deal Coordinator bus handoff" as deal_coordinator → deal_coordinator, which lib/kernel/manager-signals.ts:63
    // validSignalRoute refuses (`from !== to`), and the refusal is never read (the result is dropped inside a
    // try/catch) — so the Command Center "managers talking" feed NEVER sees the offer handoff. Lane 142B's file.
    const { validSignalRoute } = await import("../../lib/kernel/manager-signals")
    const deal = (svc.tables.manager_signals ?? []).find((s) => s.signal_type === "offer_docs_ready" && s.entity_id === O)
    c.step("INTEGRATOR FINDING, asserted as it stands: the Deal Coordinator bus handoff (offer_docs_ready) is published deal_coordinator → deal_coordinator, a route validSignalRoute REFUSES — no signal lands and the refusal is swallowed (lib/transactions/auto-execute-offer.ts:92 → lib/kernel/manager-signals.ts:63); the feed never learns compliance is not clear", !deal && !validSignalRoute("deal_coordinator", "deal_coordinator") && validSignalRoute("compliance_officer", "deal_coordinator"), deal ? "a signal landed (the route was fixed — re-anchor this step to assert the handoff)" : "0 offer_docs_ready signals; route refused by rule")
    // THE CORRECTION: the signed contract is uploaded and scanned — buyer initials missing on one page.
    const DOC = uuid()
    ;(svc.tables.documents ??= []).push({ id: DOC, brokerage_id: B, contact_id: BUYER, listing_id: null, document_type: "signed_contract", classification: "signed_contract", status: "uploaded", signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }], initials: [{ signer_role: "buyer", all_required_initials_present: false }, { signer_role: "seller", all_required_initials_present: true }] }, metadata: { linked_offer_id: O }, content: null })
    const initials = await runOfferComplianceLoop(svc as never, { brokerageId: B, offerId: O, trigger: "document_uploaded" })
    c.step("correction round 1: the contract is on file but the BUYER INITIALS are blank → still BLOCKED, the refusal naming the initials; no transaction", initials.outcome === "blocked" && /initial/i.test(initials.reason ?? "") && !(svc.tables.transactions ?? []).length, (initials.reason ?? "").slice(0, 200))
    const doc = (svc.tables.documents ?? []).find((d) => d.id === DOC)
    if (doc) doc.signature_completeness = { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }], initials: [{ signer_role: "buyer", all_required_initials_present: true }, { signer_role: "seller", all_required_initials_present: true }] }
    passed = await runOfferComplianceLoop(svc as never, { brokerageId: B, offerId: O, trigger: "document_uploaded" })
    const tx = (svc.tables.transactions ?? []).find((t) => t.id === passed.transactionId)
    const compliance = await checkCompliancePassed(O)
    c.step("correction round 2: every signature and initial present → compliance PASSES (offers.compliance_passed_at stamped AND the buyer.offer.compliance.passed activity recorded) → the canonical TRANSACTION is created under the tenant and linked back to the offer; the offer's gate state reads passed", passed.outcome === "advanced" && !!passed.transactionId && !!tx && tx.brokerage_id === B && offer()?.transaction_id === passed.transactionId && !!offer()?.compliance_passed_at && compliance.passed && gateState().state === "passed", JSON.stringify({ outcome: passed.outcome, tx: passed.transactionId, reason: passed.reason }).slice(0, 240))
    const again = await runOfferComplianceLoop(svc as never, { brokerageId: B, offerId: O, trigger: "document_uploaded" })
    c.step("idempotent: the loop on a converted offer is outside_window ('already converted') — ONE transaction, never a second", again.outcome === "outside_window" && again.transactionId === passed.transactionId && (svc.tables.transactions ?? []).filter((t) => t.brokerage_id === B).length === 1, again.reason ?? "")
  } finally {
    if (prevSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prevSecret
  }
  const g3 = await assertOfferReadyForTransaction({ offerId: O, brokerageId: B })
  c.step("gate 3 — the bridge refuses a SECOND transaction for the same offer ('transaction already exists')", !g3.allowed && /already exists/.test(g3.reason ?? ""), g3.reason ?? "allowed")

  // ── 5 · the manual door is refused without an offer; the kernel never creates on submit/accept ──
  const { assertTransactionCreationAllowed } = await import("../../lib/transactions/transaction-creation-gate")
  const manual = await assertTransactionCreationAllowed(svc as never, { brokerageId: B, offerId: null, dealType: "buyer", door: "manual transaction sheet", agentUserId: AG_U })
  c.step("the MANUAL door: a transaction with no accepted offer behind it is refused under compliance_good ('compliance has never been reviewed for it') — the manual sheet cannot skip the lifecycle", !manual.allowed && manual.refusals.some((r) => r.requirement === "compliance_good") && /never been reviewed/.test(manual.reason), manual.refusals.map((r) => r.requirement).join(","))
  const kernel = strippedRepo("lib/kernel/offers.ts") ?? "", bridge = strippedRepo("lib/transactions/offer-bridge.ts") ?? "", auto = strippedRepo("lib/transactions/auto-execute-offer.ts") ?? "", sig = strippedRepo("app/actions/buyer-offer/submit-for-signature.ts") ?? "", roles = strippedRepo("lib/inbound-mail/offer-detect.ts") ?? ""
  c.step("source rules: the offer kernel (recordOfferSubmitted / acceptOffer / issueCounterOffer) inserts NO transactions row; the bridge re-runs assertOfferReadyForTransaction unless the authoritative gate already ran (skipOfferGate); the autonomous driver reuses submitOfferToCompliance (one chokepoint, no second scanner); the signature door's role vocabulary (OutboundSignerRole) carries the OUTSIDE listing agent as a counterparty (listing_id null is a first-class shape)", !/\.from\(\s*["']transactions["']\s*\)\s*\.insert/.test(kernel) && /skipOfferGate/.test(bridge) && /assertOfferReadyForTransaction\(/.test(bridge) && /submitOfferToCompliance\(/.test(auto) && /OutboundSignerRole/.test(sig) && /OutboundSignerRole\s*=[^\n]*["']listing_agent["']/.test(roles), "")
  const drift = ["lib/kernel/bidding-war-concierge.ts", "lib/kernel/compliance/active-representation.ts", "lib/kernel/offer-net-sheet.ts"].map((f) => ({ f, s: strippedRepo(f) })).filter((x) => x.s !== null)
  console.log(`    finding (lane 142B, SURVIVORS142 §2): offers.status has NO CHECK and the open-status lists differ across ${drift.map((x) => x.f).join(", ") || "(files moved)"} — one vocabulary per function (§6) is the lane's merge`)

  // ── WAVE142 HOOK (integrator): 142B — wired 142K: webhook-first monitoring (the terminal outcome at the door) + the one reconciler; the lifecycle spine + the registered proof. ──
  for (const h of hooksFor("offer-lifecycle")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, /MONITORING/.test(h.contract) ? "at HEAD four provider webhooks + the esign-doc-sync / dotloop-sync crons exist; no ONE named reconciler through the selected provider" : "at HEAD test:listing-offer-lifecycle is not registered; the outside-property shape is proven here on the gate, not at every door"); continue }
    if (/MONITORING/.test(h.contract)) {
      // The webhook-first half in memory: the provider's TERMINAL outcome recorded at the door through the ONE writer.
      const { recordEnvelopeTerminalState } = await import("../../lib/forms/esign-execution-loop")
      const { canAdvancePacketState } = await import("../../lib/esign/packet-states")
      const ENV2 = `env_${CANARY_TAG}_offer_declined`
      const inHouse = () => (svc.tables.offers ?? []).find((o) => o.id === O_IN)
      Object.assign(inHouse() ?? {}, { provider_envelope_id: ENV2, esign_status: "sent" })
      const declined = await recordEnvelopeTerminalState(svc as never, { provider: "docusign", envelopeId: ENV2, state: "declined", reason: "Seller declined to sign" })
      const again = await recordEnvelopeTerminalState(svc as never, { provider: "docusign", envelopeId: ENV2, state: "declined" })
      const voided = await recordEnvelopeTerminalState(svc as never, { provider: "docusign", envelopeId: ENV2, state: "voided" })
      const nobody = await recordEnvelopeTerminalState(svc as never, { provider: "docusign", envelopeId: `env_${CANARY_TAG}_nobody`, state: "expired" })
      const declinedBells = (svc.tables.notifications ?? []).filter((n) => n.brokerage_id === B && n.type === "esign.packet.declined")
      const doors = ["app/api/webhooks/docusign/route.ts", "app/api/webhooks/skyslope/route.ts", "app/api/webhooks/authentisign/route.ts"].map((f) => strippedRepo(f) ?? "")
      const sweep = strippedRepo("lib/transactions/esign-doc-sync-sweep.ts") ?? "", dispatchSrc = strippedRepo("lib/kernel/cron-dispatch.ts") ?? ""
      c.step(`${h.lane} landed (${at}) — E-SIGN MONITORING, webhooks first: the provider's DECLINED envelope is recorded AT THE DOOR on the offer it matches (tenant resolved FROM the envelope, esign_status declined through the ladder, the evidence row, the agent's high-priority bell); a redelivery is a no-op (0 rows, no second bell); a later 'voided' over the declined packet is REFUSED (a terminal outcome is never overwritten); an envelope no tenant owns records nothing; the three verified webhook doors (HMAC + timingSafeEqual before the body is read) call recordEnvelopeTerminalState; the reconciliation BACKUP is the ONE sweep (sweepEsignDocSync → evaluateEnvelopeExecution, the same core the webhooks run) on the esign-doc-sync cron — cron is the fallback, never how a signing event is first found`, declined.brokerageId === B && declined.offers === 1 && declined.agreements === 0 && declined.refused.length === 0 && inHouse()?.esign_status === "declined" && declinedBells.length === 1 && declinedBells[0].user_id === AG_U && declinedBells[0].priority === "high" && again.offers === 0 && again.refused.length === 0 && voided.offers === 0 && voided.refused.some((r) => /never overwritten/.test(r)) && nobody.brokerageId === null && nobody.refused.length === 1 && !canAdvancePacketState("declined", "voided").ok && doors.every((d) => /timingSafeEqual/.test(d) && /\brecordEnvelopeTerminalState\s*\(/.test(d)) && /\bevaluateEnvelopeExecution\b/.test(sweep) && /export\s+async\s+function\s+sweepEsignDocSync\b/.test(sweep) && /esign-doc-sync/.test(dispatchSrc), JSON.stringify({ declined: { offers: declined.offers, refused: declined.refused }, redelivery: again.offers, voided: voided.refused[0]?.slice(0, 90), bells: declinedBells.length }).slice(0, 300))
      continue
    }
    // LIFECYCLE VOCABULARY — the owner's order on the spine, the column's form_source, the registered proof on the chain.
    const { DEAL_LIFECYCLE_STAGES } = await import("../../lib/esign/packet-states")
    const pkg = readRepo("package.json") ?? "", vocab = readRepo("scripts/check-vocabularies.ts") ?? "", guard = strippedRepo(at) ?? ""
    const formSource = /form_source:\s*\[([^\]]*)\]/.exec(vocab)?.[1]?.replace(/["'\s]/g, "").split(",").filter(Boolean) ?? []
    const vocabChecks: Array<[string, boolean]> = [
      ["the spine's order", [...DEAL_LIFECYCLE_STAGES].join() === "listing,offer,signatures,compliance,fully_executed_contract,transaction,closing"],
      ["form_source CHECK", formSource.includes("in_app") && formSource.includes("manual") && formSource.includes("docusign") && !formSource.some((v) => /my_forms|transaction_provider/.test(v))],
      ["proof registered + on the chain", /"test:listing-offer-lifecycle":/.test(pkg) && /npm run test:listing-offer-lifecycle\b/.test(pkg)],
      ["proof drives the ladder, the gate and the null-listing rule", /packet-states|packet-state-writer/.test(guard) && /assertTransactionCreationAllowed|transaction-creation-gate/.test(guard) && /resolvedListingId/.test(guard)],
      ["the outside-property offer reached its transaction", offer()?.listing_id === null && !!offer()?.transaction_id],
    ]
    const vocabBad = vocabChecks.filter(([, ok]) => !ok).map(([n]) => n)
    c.step(`${h.lane} landed (${at}) — LIFECYCLE VOCABULARY: the spine names the owner's order (listing → offer → signatures → compliance → fully_executed_contract → transaction → closing) as ONE tuple; offers.form_source is spelled in its CHECK (in_app | manual | the legal-forms providers — the wizard's old 'my_forms,transaction_provider' join is not a value); test:listing-offer-lifecycle is registered AND on the guard chain and drives the ladder, the writer, the transaction gate and the null-listing rule (resolvedListingId); the journey above proved an OUTSIDE-PROPERTY offer (listing_id null) walks every door to a transaction only after compliance`, vocabBad.length === 0, `form_source: ${formSource.join("|")}${vocabBad.length ? `; FAILED: ${vocabBad.join(", ")}` : ""}`)
  }
  c.blind("No provider is called: the signing itself is modelled by the offer columns the webhooks stamp (buyer_signed_at, seller_response_type, fully_signed_contract_received_at); the document scanner's signature_completeness is a fixture. The chokepoint ran for real in memory under the internal secret (the posture a provider webhook presents) — its session path (requireCallerTenant) is test:tenant-scope's. RLS not modelled.")
  const a = await cleanupCanary(svc, B), b = await cleanupCanary(svc, B2)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", a.mismatches.length + b.mismatches.length === 0 && a.residual + b.residual === 0, [...a.cleanup, ...b.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" ") + (a.mismatches.length + b.mismatches.length ? ` MISMATCH ${[...a.mismatches, ...b.mismatches].join("; ")}` : ""))
  return c.report([...a.cleanup, ...b.cleanup], a.residual + b.residual)
}
