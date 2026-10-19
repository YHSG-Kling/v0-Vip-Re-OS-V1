/**
 * scripts/canaries/listing-lifecycle.ts — LISTING canary (wave 142, lane 142J):
 *   agent + seller signing → provider completion evidence → compliance catches a missing document / initial →
 *   parties notified → corrections → the pass arm → FULLY EXECUTED only after compliance
 * through the survivors at HEAD: lib/compliance/signature-completeness.ts (evaluateExecution — absence is NOT
 * consent), lib/forms/esign-execution-loop.ts (evaluateEnvelopeExecution — every tracked form of the envelope
 * signed? partial → a deal_coordinator signal; complete → the ready writes + finalizeVoiceCockpitPacket + the
 * listing compliance loop), lib/esign-webhooks/finalize-packet.ts (the packet of record completes), and
 * lib/listings/listing-compliance-loop.ts (runListingComplianceLoop — the ONE gate assertListingActivationAllowed
 * → blocked with the work NAMED to tc + compliance officer + agent, deduped by blocker set; re-entered on every
 * upload; the pass arm walks the stage machine one allowed hop at a time). Owner (wave 142): "Listing → Offer →
 * Signatures → Compliance → Fully Executed Contract → Transaction → Closing … Provider completion ≠ compliance
 * approval … only after compliance approval: FULLY EXECUTED."
 *
 * THE MEASURED GAP THIS CANARY HOLDS (lane 142B's contract): at HEAD the provider's completion event itself stamps
 * listing_agreements { esign_status: "fully_signed", fully_executed_at } BEFORE the compliance loop runs — the
 * loop then catches the missing paperwork, but the row already reads executed. Asserted as it stands; the
 * reorder is a WAVE142 HOOK. In-memory only (the dispatch core is a recorder; nothing reaches a provider).
 */
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, stubModule, uuid } from "./_harness"
import { ROOT, hooksFor, strippedRepo } from "./_registry"

export async function run() {
  const c = canary("Listing: agent + seller signing → provider completion → compliance catches missing docs/initials → parties told → corrections → FULLY EXECUTED only after compliance")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only — the loop pages real compliance officers and the live tables hold no listing agreements")
  stubModule("@/lib/esign/dispatch-packet", pathToFileURL(join(ROOT, "scripts/canaries/_esign-dispatch-stub.ts")).href)
  const B = uuid(), AG_U = uuid(), AG = uuid(), TC_U = uuid(), CO_U = uuid(), SELLER = uuid(), L = uuid(), LA = uuid(), D1 = uuid(), D2 = uuid(), SR = uuid(), PACKET_DOC = uuid()
  const ENV = `env_${CANARY_TAG}_listing`
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-listing`, state: "FL" }],
    users: [
      { id: AG_U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B, first_name: "Canary", last_name: "Agent" },
      { id: TC_U, email: `tc@${CANARY_EMAIL_DOMAIN}`, user_type: "tc", brokerage_id: B, first_name: "Canary", last_name: "Coordinator" },
      { id: CO_U, email: `compliance@${CANARY_EMAIL_DOMAIN}`, user_type: "compliance_officer", brokerage_id: B, first_name: "Canary", last_name: "Officer" },
    ],
    agents: [{ id: AG, user_id: AG_U, brokerage_id: B, first_name: "Canary", last_name: "Agent", is_active: true }],
    contacts: [{ id: SELLER, brokerage_id: B, agent_id: AG, first_name: "Sam", last_name: "Seller", email: `seller@${CANARY_EMAIL_DOMAIN}`, contact_type: "seller", status: "active", notes: CANARY_TAG }],
    listings: [{ id: L, brokerage_id: B, agent_id: AG, seller_contact_id: SELLER, address: "1 Canary Way", city: "Pensacola", state: "FL", zip: "32501", status: "pre_listing", lifecycle_stage: "LISTING_AGREEMENT_INITIATED", go_live_date: null, metadata: {}, notes: CANARY_TAG, created_at: nowIso() }],
    // The agreement the wizard sent (provider_ref = the envelope): esign 'sent', not executed, compliance not reviewed.
    listing_agreements: [{ id: LA, brokerage_id: B, listing_id: L, provider_ref: ENV, esign_status: "sent", fully_executed_at: null, compliance_passed: null, created_at: nowIso() }],
    // The envelope's tracked forms (what the provider sync lands): one still unsigned.
    transaction_documents: [
      { id: D1, brokerage_id: B, listing_id: L, transaction_id: null, provider_source: "docusign", doc_label: `${CANARY_TAG} Listing Agreement`, status: "pending" },
      { id: D2, brokerage_id: B, listing_id: L, transaction_id: null, provider_source: "docusign", doc_label: `${CANARY_TAG} Seller Disclosure`, status: "signed" },
    ],
    // The packet of record the Sign button reads, and the staged document the finalize flips.
    signature_requests: [{ id: SR, brokerage_id: B, provider_envelope_id: ENV, request_status: "sent", completed_at: null }],
    documents: [{ id: PACKET_DOC, brokerage_id: B, contact_id: SELLER, listing_id: null, document_type: "listing_agreement_packet", classification: null, status: "pending_signature", metadata: { signature_request_id: ENV } }],
    // The brokerage's checklist for a seller deal: the executed listing agreement is REQUIRED and blocks.
    brokerage_required_documents: [{ id: uuid(), brokerage_id: B, classification: "listing_agreement", scope_type: "brokerage", scope_id: B, block_on_missing: true, is_required: true, deal_type: "seller", state_code: null, description: null, template_form_id: null }],
  })
  setSvc(svc)
  const listing = () => (svc.tables.listings ?? []).find((l) => l.id === L)
  const agreement = () => (svc.tables.listing_agreements ?? []).find((a) => a.id === LA)
  const bells = () => svc.tables.notifications ?? []
  const signals = () => svc.tables.manager_signals ?? []

  // ── 1 · "is it actually signed?" — asked once, answered the safe way (pure) ──
  const { evaluateExecution, LISTING_AGREEMENT_PARTIES } = await import("../../lib/compliance/signature-completeness")
  const full = { signatures: [{ signer_role: "agent", signed: true }, { signer_role: "seller", signed: true }], initials: [{ signer_role: "agent", all_required_initials_present: true }, { signer_role: "seller", all_required_initials_present: true }] }
  const noSellerInitials = { ...full, initials: [{ signer_role: "agent", all_required_initials_present: true }, { signer_role: "seller", all_required_initials_present: false }] }
  c.step(`signature completeness (pure): both parties (${LISTING_AGREEMENT_PARTIES.join(" + ")}) signed AND initialed → executed; seller initials missing → NOT executed, naming "seller initials"; a signature block that reads "yes" (not true) is not a signature`, evaluateExecution(full).executed && !evaluateExecution(noSellerInitials).executed && evaluateExecution(noSellerInitials).missing.join() === "seller initials" && !evaluateExecution({ ...full, signatures: [{ signer_role: "agent", signed: true }, { signer_role: "seller", signed: "yes" }] }).executed, evaluateExecution(noSellerInitials).missing.join(","))
  c.step("POSITIVE CONTROL (absence is not consent): a null, a string, an array or an empty blob is NOT executed and lists every requirement missing (4)", [null, "signed", [], {}].every((sc) => !evaluateExecution(sc).executed && evaluateExecution(sc).missing.length === 4), "")

  // ── 2 · the send door (session-bound) on stripped source ──
  const door = strippedRepo("app/actions/listings-kernel.ts") ?? ""
  const sendBody = door.slice(door.indexOf("export async function sendListingAgreementForSignatureAction"))
  c.step("the send door: a SELLER signer is required before anything is sent, the agent must be clear to transact, the forms must be in the tenant's own library, and the envelope leaves through the ONE dispatch core (dispatchEsignPacket) — never provider.sendForSignature directly, never a Dotloop branch", /role\s*===\s*["']seller["']/.test(sendBody) && /checkAgentTransactable\(/.test(sendBody) && /checkFormPathsInScope\(/.test(sendBody) && /dispatchEsignPacket\(/.test(sendBody) && !/\.sendForSignature\(/.test(sendBody) && !/DotloopProvider/.test(sendBody), "")

  // ── 3 · the provider reports: partial, then complete ──
  const { evaluateEnvelopeExecution } = await import("../../lib/forms/esign-execution-loop")
  const partial = await evaluateEnvelopeExecution(svc as never, { brokerageId: B, providerSource: "docusign", externalEnvelopeId: ENV })
  const partialSignal = signals().find((s) => s.signal_type === "esign_loop_partially_signed")
  c.step("participant signed, one form still open: the envelope resolves to the LISTING through the agreement's provider_ref, reads every tracked form, is NOT fully executed, writes nothing to the agreement and signals the deal_coordinator with the forms still unsigned", partial.evaluated && !partial.fullyExecuted && partial.listingId === L && partial.matchedAgreementId === LA && !partial.readyWritesApplied && partial.signalPublished && !!partialSignal && partialSignal.brokerage_id === B && partialSignal.to_manager === "deal_coordinator" && agreement()?.esign_status === "sent" && !agreement()?.fully_executed_at, JSON.stringify({ evaluated: partial.evaluated, fully: partial.fullyExecuted, signal: partial.signalPublished, incomplete: partial.execResult?.incomplete }))
  const d1 = (svc.tables.transaction_documents ?? []).find((d) => d.id === D1)
  if (d1) d1.status = "signed"
  const bellsBefore = bells().length
  const complete = await evaluateEnvelopeExecution(svc as never, { brokerageId: B, providerSource: "docusign", externalEnvelopeId: ENV })
  const sr = (svc.tables.signature_requests ?? []).find((r) => r.id === SR), packetDoc = (svc.tables.documents ?? []).find((d) => d.id === PACKET_DOC)
  c.step("all signed: the ready writes run — the packet of record completes (signature_requests completed_at), the staged document is marked signed with the envelope + provider on it, ESIGN_PACKET_SIGNED is recorded, and the listing moves LISTING_AGREEMENT_INITIATED → LISTING_AGREEMENT_SIGNED through the kernel transition", complete.evaluated && complete.fullyExecuted && complete.readyWritesApplied && sr?.request_status === "completed" && !!sr?.completed_at && packetDoc?.status === "signed" && packetDoc?.metadata?.signed_envelope_id === ENV && packetDoc?.metadata?.signed_via === "docusign" && (svc.tables.lifecycle_events ?? []).some((e) => e.brokerage_id === B && /esign_packet_signed/i.test(String(e.event_type))) && listing()?.lifecycle_stage === "LISTING_AGREEMENT_SIGNED", JSON.stringify({ stage: listing()?.lifecycle_stage, sr: sr?.request_status, doc: packetDoc?.status }))
  // THE MEASURED GAP (asserted as it stands, never relaxed): the provider's completion stamped the agreement EXECUTED
  // before compliance looked at anything. The compliance loop below then blocks on the missing paperwork.
  c.step("MEASURED AT HEAD (lane 142B's contract — provider completion ≠ compliance approval): the agreement row reads esign_status fully_signed WITH fully_executed_at stamped the moment the provider completed, while compliance_passed is still unreviewed — the 'fully executed only after compliance' ordering is the WAVE142 HOOK below", agreement()?.esign_status === "fully_signed" && !!agreement()?.fully_executed_at && agreement()?.compliance_passed !== true, JSON.stringify({ esign: agreement()?.esign_status, executed_at: !!agreement()?.fully_executed_at, compliance: agreement()?.compliance_passed ?? null }))

  // ── 4 · compliance catches the missing document, tells the three roles, dedupes ──
  const gate = () => (listing()?.metadata?.compliance_gate ?? {}) as Record<string, unknown>
  const flagBells = () => bells().filter((n) => n.brokerage_id === B && /listing_gate_blocked/.test(String(n.type)))
  c.step("auto-submitted to compliance on completion: the loop ran from the ready writes and BLOCKED — the listing agreement is REQUIRED by the brokerage checklist and no classified document is on file — the work named on the listing (metadata.compliance_gate) and the TC + compliance officer + agent told", gate().state === "blocked" && (gate().blockers as string[] ?? []).some((b) => /missing document/i.test(b) && /listing agreement/i.test(b)) && flagBells().length > 0 && [TC_U, CO_U, AG_U].every((u) => flagBells().some((n) => n.user_id === u)), JSON.stringify({ gate: gate().state, blockers: gate().blockers, told: flagBells().map((n) => (n.user_id === TC_U ? "tc" : n.user_id === CO_U ? "compliance" : n.user_id === AG_U ? "agent" : "other")) }).slice(0, 300))
  const { runListingComplianceLoop } = await import("../../lib/listings/listing-compliance-loop")
  const same = await runListingComplianceLoop(svc as never, { brokerageId: B, listingId: L, trigger: "document_uploaded" })
  c.step("deduped: an unrelated upload re-enters the loop with the SAME blocker set → still blocked, the live list rewritten, NOBODY paged again", same.outcome === "blocked" && !same.notified && flagBells().length === bellsBefore + flagBells().length - bellsBefore && (same.blockers ?? []).length > 0, JSON.stringify({ outcome: same.outcome, notified: same.notified }))
  // The correction: the executed agreement is uploaded and scanned — seller initials still missing on one page.
  const UPLOAD = uuid()
  ;(svc.tables.documents ??= []).push({ id: UPLOAD, brokerage_id: B, listing_id: L, contact_id: SELLER, document_type: "listing_agreement", classification: "listing_agreement", status: "uploaded", signature_completeness: noSellerInitials, metadata: {} })
  const toldBefore = flagBells().length
  const initials = await runListingComplianceLoop(svc as never, { brokerageId: B, listingId: L, trigger: "document_uploaded" })
  c.step("correction round 1: the agreement is uploaded but the SELLER INITIALS are blank → still blocked, now naming the initials (a signature block being filled does not make a document complete), the blocker set CHANGED so the roles are told again", initials.outcome === "blocked" && initials.blockers.some((b) => /seller initials/i.test(b) && /not initialed/i.test(b)) && !initials.blockers.some((b) => /missing document/i.test(b)) && initials.notified && flagBells().length > toldBefore, JSON.stringify({ outcome: initials.outcome, blockers: initials.blockers }).slice(0, 300))
  const up = (svc.tables.documents ?? []).find((d) => d.id === UPLOAD)
  if (up) up.signature_completeness = full
  const stillUnreviewed = await runListingComplianceLoop(svc as never, { brokerageId: B, listingId: L, trigger: "document_uploaded" })
  c.step("correction round 2: every signature and initial present, but the agreement's COMPLIANCE REVIEW has not passed → the gate still refuses (compliance_good), naming the review — paperwork alone never executes a listing", stillUnreviewed.outcome === "blocked" && /compliance review has not passed|compliance/i.test(stillUnreviewed.reason ?? "") && listing()?.lifecycle_stage === "LISTING_AGREEMENT_SIGNED", (stillUnreviewed.reason ?? "").slice(0, 200))
  // Compliance approves the agreement (the human review's mark), with no MLS start date yet.
  const ag = agreement(); if (ag) ag.compliance_passed = true
  const awaiting = await runListingComplianceLoop(svc as never, { brokerageId: B, listingId: L, trigger: "document_uploaded" })
  c.step("compliance APPROVED: the gate passes; with no MLS start date on the listing the loop records passed_awaiting_date and does NOT invent a date to satisfy a stage", awaiting.outcome === "passed_awaiting_date" && gate().state === "passed_awaiting_date" && listing()?.lifecycle_stage === "LISTING_AGREEMENT_SIGNED", awaiting.reason ?? "")
  const lrow = listing(); if (lrow) lrow.go_live_date = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)
  const advanced = await runListingComplianceLoop(svc as never, { brokerageId: B, listingId: L, trigger: "document_uploaded" })
  c.step("with the MLS start date set the pass arm walks the stage machine one allowed hop at a time (LISTING_AGREEMENT_SIGNED → MLS_DATE_CONFIRMED → COMING_SOON_PREP) and the gated status reads coming_soon only because the verdict was an explicit pass", advanced.outcome === "advanced" && listing()?.lifecycle_stage === "COMING_SOON_PREP" && listing()?.status === "coming_soon" && (gate().advanced as string[] ?? []).join() === "MLS_DATE_CONFIRMED,COMING_SOON_PREP", JSON.stringify({ outcome: advanced.outcome, stage: listing()?.lifecycle_stage, status: listing()?.status, reason: advanced.reason }).slice(0, 240))
  const past = await runListingComplianceLoop(svc as never, { brokerageId: B, listingId: L, trigger: "document_uploaded" })
  c.step("POSITIVE CONTROL (never regresses): a listing past the window is left exactly where it is (outside_window), nothing rewritten", past.outcome === "outside_window" && listing()?.lifecycle_stage === "COMING_SOON_PREP", past.reason ?? "")
  const hops = bells().filter((n) => n.brokerage_id === B).map((n) => String(n.type))
  const hopTypes = [...new Set(hops)]
  // The owner's hops vs what rang: measured, never pre-judged (the kernel fan-out DOES ring the signed hops).
  const rang = (re: RegExp) => hopTypes.some((t) => re.test(t))
  const hopCensus = { sent: rang(/sent_for_signature|envelope_requested/i), participant_signed: rang(/participant|partially/i), all_signed: rang(/packet_signed|agreement_signed/i), compliance_begins_or_corrections: rang(/gate_blocked|compliance/i), approved: rang(/approved/i), fully_executed: rang(/fully_executed|agreement_signed/i) }
  console.log(`    census: bells rung on this tenant across the journey — ${hopTypes.map((t) => `${t}×${hops.filter((x) => x === t).length}`).join(", ") || "none"}; owner hops with a bell: ${Object.entries(hopCensus).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}; without: ${Object.entries(hopCensus).filter(([, v]) => !v).map(([k]) => k).join(", ") || "none"}`)

  // ── WAVE142 HOOK (integrator): 142B — one status vocabulary; fully executed only after compliance; every hop notified. ──
  for (const h of hooksFor("listing-lifecycle")) {
    const at = h.probe()
    if (!at) {
      c.hook(h.lane, h.contract, /vocabulary/i.test(h.contract) ? "at HEAD listing_agreements.esign_status is declined/fully_signed/partially_signed/pending/sent/voided (no compliance_pending / compliance_approved / fully_executed value; scripts/check-vocabularies.ts)" : /AUTO-SUBMITTED/.test(h.contract) ? "measured above: the provider completion stamps fully_executed_at before the loop runs" : `measured above: hops with a bell ${Object.entries(hopCensus).filter(([, v]) => v).map(([k]) => k).join(",") || "none"}; without ${Object.entries(hopCensus).filter(([, v]) => !v).map(([k]) => k).join(",") || "none"}`)
      continue
    }
    if (/vocabulary/i.test(h.contract)) {
      const s = strippedRepo(at) ?? ""
      const states = ["draft", "sent", "partially_signed", "all_signed", "compliance_pending", "correction_required", "compliance_approved", "fully_executed", "declined", "voided", "expired"]
      const missing = states.filter((x) => !new RegExp(`["']${x}["']`).test(s))
      c.step(`${h.lane} landed (${at}): the ONE vocabulary names all eleven states as string literals (the CHECK's spelling), none missing`, missing.length === 0, missing.join(",") || "all 11 present")
      continue
    }
    c.step(`${h.lane} landed (${at}) — wire its export into this canary and assert the contract (WAVE142 HOOK (integrator): ${h.lane}): ${/AUTO-SUBMITTED/.test(h.contract) ? "re-run the journey above and assert fully_executed_at is NULL after the provider completes and set only after compliance_passed" : "assert one bell per hop (sent, participant signed, all signed, compliance begins, corrections, approved, fully executed), deduped"}`, false, h.contract.slice(0, 120))
  }
  c.blind("No envelope reaches a provider (the dispatch core is a recorder; the send door needs a session and is asserted on stripped source); the provider WEBHOOK routes (app/api/webhooks/{docusign,dotloop,skyslope,authentisign}) and their signature verification are test:webhook-contract's, not driven — evaluateEnvelopeExecution is driven directly with the envelope id a webhook would carry. The document scanner (signature_completeness) is modelled by fixtures; RLS not modelled.")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, cleanup.map((x) => `${x.table}:${x.deleted}`).join(" ") + (mismatches.length ? ` MISMATCH ${mismatches.join("; ")}` : ""))
  return c.report(cleanup, residual)
}
