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
 * LANDED (lane 142B, wired 142K): the ONE packet ladder (lib/esign/packet-states.ts — the owner's eleven words on the
 * column's spelling), the ONE writer (lib/esign/packet-state-writer.ts: tenant-pinned, counted, evidence per hop, the
 * deduped hop bell through notifyEsignPacketHop) and the compliance loop stamping compliance_pending → correction_required
 * | compliance_approved → fully_executed. The provider's completion is ALL SIGNED (fully_signed), never FULLY EXECUTED.
 * INTEGRATOR FINDING held RED below: lib/listings/listing-activation-gate.ts:331,:353 pin the literal
 * LISTING_AGREEMENT_EXECUTED_STATUS = "fully_signed" (lib/transactions/coordination-status.ts:179), so an agreement the
 * loop itself moved to compliance_pending is refused forever — the listing can never activate after the loop runs.
 * In-memory only (the dispatch core is a recorder; nothing reaches a provider).
 */
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, stubModule, uuid } from "./_harness"
import { ROOT, hooksFor, listFiles, readRepo, strippedRepo } from "./_registry"

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- the in-memory client's row shape

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
    // agent_user_id / seller_contact_id: the columns the ONE writer resolves the hop bell's recipient from (lane 142B).
    listing_agreements: [{ id: LA, brokerage_id: B, listing_id: L, provider_ref: ENV, esign_status: "sent", fully_executed_at: null, compliance_passed: null, agent_user_id: AG_U, seller_contact_id: SELLER, created_at: nowIso() }],
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
  // The ladder's evidence trail (lib/esign/packet-state-writer.ts evidenceAndBell → lifecycle_events esign.packet.state_changed).
  const pl = (e: Row): Row => ((e.payload ?? e.metadata ?? {}) as Row)
  const hopRows = () => (svc.tables.lifecycle_events ?? []).filter((e) => e.brokerage_id === B && e.event_type === "esign.packet.state_changed" && pl(e).recordId === LA)
  const hopEvidence = (state: string) => hopRows().filter((e) => pl(e).to === state)
  const trail = () => hopRows().map((e) => String(pl(e).to))

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

  // ── 2b · the SENT hop (lane 142B, wired 142K): the send door records it after dispatch (app/actions/listings-kernel.ts:1265 —
  //        a session door, asserted above); here the same ONE writer records it on the staged agreement so the hop census
  //        below is the whole journey. A redelivered hop is the dedupe's positive control.
  const { recordEsignPacketHop } = await import("../../lib/esign/packet-state-writer")
  const { canAdvancePacketState, isAtOrPastAllSigned } = await import("../../lib/esign/packet-states")
  const sentHop = await recordEsignPacketHop(svc as never, { brokerageId: B, record: { table: "listing_agreements", id: LA }, state: "sent", source: "ui", actorUserId: AG_U, provider: "docusign", envelopeId: ENV })
  const sentAgain = await recordEsignPacketHop(svc as never, { brokerageId: B, record: { table: "listing_agreements", id: LA }, state: "sent", source: "ui", actorUserId: AG_U, provider: "docusign", envelopeId: ENV })
  const sentBells = () => bells().filter((n) => n.brokerage_id === B && n.type === "esign.packet.sent")
  c.step("SENT hop (142B, the ONE writer): recording the hop on the staged agreement rings the responsible agent ONCE (esign.packet.sent, the owner's notice) and leaves ONE evidence row keyed on record + state; the redelivered hop is DEDUPED — the second call rings nobody and adds no evidence row", sentHop.ok && sentHop.notified === 1 && sentBells().length === 1 && sentBells()[0].user_id === AG_U && sentAgain.ok && sentAgain.notified === 0 && sentBells().length === 1 && hopEvidence("sent").length === 1, sentHop.ok ? `notified ${sentHop.notified}; redelivery notified ${sentAgain.ok ? sentAgain.notified : sentAgain.reason}` : sentHop.reason)

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
  // THE RULE (lane 142B landed): the provider's completion is ALL SIGNED, never FULLY EXECUTED. The row read fully_signed
  // (the column's spelling of the owner's all_signed) the moment every tracked form was signed, the all-signed hop was
  // recorded, and the loop that ran from the ready writes moved it INTO compliance (and, blocked, to correction_required).
  c.step("PROVIDER COMPLETION = ALL SIGNED, NEVER FULLY EXECUTED (lane 142B's ladder): the evidence trail reads sent → fully_signed → compliance_pending (→ correction_required: the loop below blocked), NO fully_executed hop exists before compliance approval, the ladder refuses fully_executed from any state below all-signed (a packet the provider never reported signed) and refuses a regression from compliance_pending back to fully_signed; the packet is at-or-past all-signed while compliance_passed is still unreviewed", trail().slice(0, 3).join() === "sent,fully_signed,compliance_pending" && hopEvidence("fully_executed").length === 0 && !canAdvancePacketState("sent", "fully_executed").ok && !canAdvancePacketState("partially_signed", "fully_executed").ok && !canAdvancePacketState("compliance_pending", "fully_signed").ok && canAdvancePacketState("compliance_approved", "fully_executed").ok && agreement()?.compliance_passed !== true && isAtOrPastAllSigned(agreement()?.esign_status), JSON.stringify({ trail: trail(), esign: agreement()?.esign_status, compliance: agreement()?.compliance_passed ?? null }))
  // Published (lane 142B / integrator, hardening): the ladder itself ADMITS fully_signed → fully_executed in one hop
  // (lib/esign/packet-states.ts:164 refuses only from BELOW all-signed); the compliance ordering is held by the ONE writer of
  // fully_executed (the loop, after compliance_approved) — a second writer could skip compliance without the ladder refusing.
  console.log(`    finding (lane 142B, ladder hardening): canAdvancePacketState("fully_signed", "fully_executed").ok = ${canAdvancePacketState("fully_signed", "fully_executed").ok} — the compliance order is the loop's rule, not the ladder's (packet-states.ts:164)`)
  // WAVE 143 (lane 143A) — 142K FINDING 5 CLOSED, and ASSERTED (it used to be a console.log): the legacy column
  // fully_executed_at is no longer stamped at the PROVIDER's completion; it is the companion of the ladder's fully_executed
  // hop (lib/esign/packet-states.ts hopCompanionColumns) — ONE meaning of "fully executed" on the row. The provider's
  // completion stamps only the two signature instants (the signature evidence the compliance review reads).
  c.step("142K FINDING 5 CLOSED — ONE vocabulary: at the provider's completion listing_agreements.fully_executed_at is NULL (not stamped), the two signature instants (agent + seller) ARE the signature evidence, and the compliance mark is not yet written — 'fully executed' will appear on the row only with the ladder's fully_executed hop",
    agreement()?.fully_executed_at == null && !!agreement()?.agent_signed_at && !!agreement()?.seller_signed_at && agreement()?.compliance_passed !== true && isAtOrPastAllSigned(agreement()?.esign_status), JSON.stringify({ esign: agreement()?.esign_status, stamp: agreement()?.fully_executed_at ?? null, agent: !!agreement()?.agent_signed_at, seller: !!agreement()?.seller_signed_at }))

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
  // THE RULE (owner: "only after compliance approval: FULLY EXECUTED"; lane 142B's ladder; wave 143 lane 143A closes 142K finding 5):
  // the compliance loop IS the review. Round 2 has every signature and initial and the provider's all-signed evidence, so the
  // review PASSES here with no human flag: it writes the compliance mark with compliance_approved, then the execution stamp with
  // fully_executed - and, because no planned MLS live date has been typed, it takes NO stage hop and invents no date
  // (passed_awaiting_date). Before wave 143 this step expected the gate to refuse until a person hand-set compliance_passed -
  // a mark nothing in the provider path ever wrote, so every provider-signed agreement was stuck blocked forever.
  c.step("correction round 2: every signature and initial present → the compliance REVIEW PASSES (the loop is the review): compliance_approved writes the mark, fully_executed writes the execution stamp, the listing stays at LISTING_AGREEMENT_SIGNED with outcome passed_awaiting_date and NO go-live date invented",
    stillUnreviewed.outcome === "passed_awaiting_date" && gate().state === "passed_awaiting_date" && listing()?.lifecycle_stage === "LISTING_AGREEMENT_SIGNED" && listing()?.go_live_date == null
    && agreement()?.esign_status === "fully_executed" && agreement()?.compliance_passed === true && typeof agreement()?.fully_executed_at === "string"
    && trail().indexOf("compliance_approved") > trail().indexOf("compliance_pending") && trail().indexOf("fully_executed") > trail().indexOf("compliance_approved"),
    JSON.stringify({ outcome: stillUnreviewed.outcome, trail: trail(), stamp: agreement()?.fully_executed_at ?? null, mark: agreement()?.compliance_passed }).slice(0, 320))
  const awaiting = stillUnreviewed
  c.step("the MLS date waits on a PERSON: no stage hop was taken without a planned date, the listing is not coming_soon, the open-house dates were not invented, and the review's evidence is on the listing (metadata.compliance_gate)",
    awaiting.outcome === "passed_awaiting_date" && listing()?.status !== "coming_soon" && listing()?.open_house_event_date == null && hopEvidence("compliance_approved").length === 1 && hopEvidence("fully_executed").length === 1, `${awaiting.outcome}: ${(awaiting.reason ?? "").slice(0, 200)}`)
  // The planned MLS live date is typed (the lifecycle timeline's save → the ONE planned-date writer): the writer re-runs the loop, which
  // takes the hop that waited on it. The date is a PLAN: no verified column is touched.
  const { recordPlannedMlsLiveDate } = await import("../../lib/listings/mls-live-date")
  const plannedOn = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)
  const plannedRes = await recordPlannedMlsLiveDate(svc as never, { brokerageId: B, listingId: L, date: plannedOn, actorUserId: AG_U, source: "timeline" })
  const advanced = { outcome: plannedRes.ok ? (plannedRes as { loop: string | null }).loop : "refused", reason: plannedRes.ok ? null : plannedRes.reason }
  c.step("with the planned MLS live date typed, the writer re-runs the loop and the pass arm walks the stage machine one allowed hop at a time (LISTING_AGREEMENT_SIGNED → MLS_DATE_CONFIRMED → COMING_SOON_PREP), the gated status reads coming_soon only because the verdict was an explicit pass, the date is recorded as a PLAN (nothing verified), and the packet was already FULLY EXECUTED at approval - compliance_approved RECORDED (evidence, no bell), fully_executed ANNOUNCED (one bell for the one moment)",
    advanced.outcome === "advanced" && listing()?.lifecycle_stage === "COMING_SOON_PREP" && listing()?.status === "coming_soon" && (gate().advanced as string[] ?? []).join() === "MLS_DATE_CONFIRMED,COMING_SOON_PREP" && listing()?.go_live_date === plannedOn && listing()?.go_live_confirmed_at == null && listing()?.mls_live_date_actual == null
    && agreement()?.esign_status === "fully_executed" && hopEvidence("compliance_approved").length === 1 && hopEvidence("fully_executed").length === 1 && bells().some((n) => n.brokerage_id === B && n.type === "esign.packet.fully_executed") && !bells().some((n) => n.type === "esign.packet.compliance_approved"),
    JSON.stringify({ outcome: advanced.outcome, stage: listing()?.lifecycle_stage, status: listing()?.status, esign: agreement()?.esign_status, reason: (advanced.reason ?? "").slice(0, 120) }).slice(0, 300))
  const past = await runListingComplianceLoop(svc as never, { brokerageId: B, listingId: L, trigger: "document_uploaded" })
  c.step("POSITIVE CONTROL (never regresses): a listing past the window is left exactly where it is (outside_window), nothing rewritten, and the packet stays fully_executed (a terminal success is never moved back)", past.outcome === "outside_window" && listing()?.lifecycle_stage === "COMING_SOON_PREP" && agreement()?.esign_status === "fully_executed", past.reason ?? "")
  const hops = bells().filter((n) => n.brokerage_id === B).map((n) => String(n.type))
  const hopTypes = [...new Set(hops)]
  // The owner's hops vs what rang: measured, never pre-judged (the kernel fan-out DOES ring the signed hops).
  const rang = (re: RegExp) => hopTypes.some((t) => re.test(t))
  const hopCensus = { sent: rang(/sent_for_signature|envelope_requested/i), participant_signed: rang(/participant|partially/i), all_signed: rang(/packet_signed|agreement_signed/i), compliance_begins_or_corrections: rang(/gate_blocked|compliance/i), approved: rang(/approved/i), fully_executed: rang(/fully_executed|agreement_signed/i) }
  console.log(`    census: bells rung on this tenant across the journey — ${hopTypes.map((t) => `${t}×${hops.filter((x) => x === t).length}`).join(", ") || "none"}; owner hops with a bell: ${Object.entries(hopCensus).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}; without: ${Object.entries(hopCensus).filter(([, v]) => !v).map(([k]) => k).join(", ") || "none"}`)

  // ── WAVE142 HOOK (integrator): 142B — wired 142K: one status vocabulary; fully executed only after compliance; every hop notified. ──
  for (const h of hooksFor("listing-lifecycle")) {
    const at = h.probe()
    if (!at) {
      c.hook(h.lane, h.contract, /vocabulary/i.test(h.contract) ? "at HEAD listing_agreements.esign_status is declined/fully_signed/partially_signed/pending/sent/voided (no compliance_pending / compliance_approved / fully_executed value; scripts/check-vocabularies.ts)" : /AUTO-SUBMITTED/.test(h.contract) ? "measured above: the provider completion stamps fully_executed_at before the loop runs" : `measured above: hops with a bell ${Object.entries(hopCensus).filter(([, v]) => v).map(([k]) => k).join(",") || "none"}; without ${Object.entries(hopCensus).filter(([, v]) => !v).map(([k]) => k).join(",") || "none"}`)
      continue
    }
    if (/vocabulary/i.test(h.contract)) {
      // ONE VOCABULARY: the owner's eleven words ON the column's spelling (never a 12th), the migration, the live cache.
      const { ESIGN_PACKET_STATES, OWNER_PACKET_STATES, OWNER_STATE_ALIASES, fromOwnerState, isEsignPacketState, ESIGN_TERMINAL_FAILURE_STATES } = await import("../../lib/esign/packet-states")
      const m783 = listFiles("supabase/migrations", (f) => /\/m783-[^/]+\.sql$/.test(f))[0] ?? null
      const sql = m783 ? readRepo(m783) ?? "" : ""
      const cacheLists = [...(readRepo("scripts/check-vocabularies.ts") ?? "").matchAll(/esign_status:\s*\[([^\]]*)\]/g)].map((m) => m[1].replace(/["'\s]/g, "").split(",").filter(Boolean))
      const eleven = cacheLists.filter((l) => l.length === 11)
      c.step(`${h.lane} landed (${at}): ONE vocabulary — the column spells 11 states (ESIGN_PACKET_STATES) and every one of the owner's 11 words maps onto exactly one of them (draft→pending, all_signed→fully_signed, the rest identity — fromOwnerState; an unknown word → null); the terminal failures are declined / voided / expired; m783 names all 11 column states; the LIVE cache (scripts/check-vocabularies.ts, regenerated after m783) carries the same 11 on both tables (offers + listing_agreements) — a subset of the ladder, never a 12th spelling`, ESIGN_PACKET_STATES.length === 11 && OWNER_PACKET_STATES.length === 11 && OWNER_PACKET_STATES.every((w) => isEsignPacketState(OWNER_STATE_ALIASES[w]) && fromOwnerState(w) === OWNER_STATE_ALIASES[w]) && fromOwnerState("draft") === "pending" && fromOwnerState("all_signed") === "fully_signed" && fromOwnerState("bogus") === null && [...ESIGN_TERMINAL_FAILURE_STATES].join() === "declined,voided,expired" && ESIGN_PACKET_STATES.every((s) => new RegExp(`'${s}'`).test(sql)) && eleven.length >= 2 && eleven.every((l) => l.every((v) => isEsignPacketState(v))), `cache lists of 11: ${eleven.length}; migration ${m783 ?? "MISSING"}`)
      continue
    }
    if (/AUTO-SUBMITTED/.test(h.contract)) {
      // FULLY EXECUTED ONLY AFTER COMPLIANCE — the source rule + the writer's refusal; the journey above is the drive.
      const exec = strippedRepo("lib/forms/esign-execution-loop.ts") ?? "", fin = strippedRepo("lib/esign-webhooks/finalize-packet.ts") ?? "", comp = strippedRepo(at) ?? ""
      const approvedAt = comp.indexOf("\"compliance_approved\""), executedAt = comp.indexOf("\"fully_executed\"")
      const mismatch = await recordEsignPacketHop(svc as never, { brokerageId: B, record: { table: "listing_agreements", id: LA }, state: "sent", source: "ui" })
      c.step(`${h.lane} landed (${at}): the provider-side survivors (esign-execution-loop + finalize-packet) write fully_signed through the ladder and NEVER the literal fully_executed (0 spellings in either); the ONLY writer of fully_executed is the listing compliance loop, after compliance_approved (source order); a hop recorded against a state the row does not hold is REFUSED by name (never papered over) — the journey above proved the trail and holds the gate finding red`, /\b(recordEsignPacketHop|advanceEsignPacketState)\b/.test(exec) && !/["']fully_executed["']/.test(exec) && !/["']fully_executed["']/.test(fin) && /\b(advanceEsignPacketState|isAtOrPastAllSigned|recordEsignPacketHop)\b/.test(fin) && approvedAt >= 0 && executedAt > approvedAt && !mismatch.ok && /holds esign_status/.test(mismatch.reason), mismatch.ok ? "a mismatched hop was accepted" : mismatch.reason.slice(0, 140))
      continue
    }
    // NOTIFICATIONS AT EVERY HOP — the deduped fan-out, measured on the journey's own bells.
    const { notifyEsignPacketHop } = await import("../../lib/notifications/notify-helpers")
    const { PACKET_HOP_NOTICE, ESIGN_PACKET_STATES: STATES } = await import("../../lib/esign/packet-states")
    const dedupe = await notifyEsignPacketHop(svc as never, { brokerageId: B, state: "fully_signed", entityType: "listing", entityId: L, agentUserId: AG_U, includeComplianceRoles: true, title: "re-announced", body: "a redelivered webhook" })
    const byType = (t: string) => bells().filter((n) => n.brokerage_id === B && n.type === t)
    const recipients = (t: string) => new Set(byType(t).map((n) => String(n.user_id)))
    c.step(`${h.lane} landed (${at}) — NOTIFICATIONS AT EVERY HOP through the ONE fan-out (notifyEsignPacketHop, deduped on record + state): sent → the agent once; all signed (fully_signed) → the agent + the compliance bench (TC + compliance officer), once each; compliance begins (compliance_pending) → the three, once; corrections → the blocker fan-out (notifyComplianceFlag, deduped on the blocker set) and NOT a second bell (evidence row only); approved recorded, fully executed announced; a re-announced hop is DEDUPED (0 sent); every state carries a notice with no amount and no legal term`, byType("esign.packet.sent").length === 1 && byType("esign.packet.fully_signed").length === 3 && [AG_U, TC_U, CO_U].every((u) => recipients("esign.packet.fully_signed").has(u)) && byType("esign.packet.compliance_pending").length === 3 && recipients("esign.packet.compliance_pending").size === 3 && byType("esign.packet.correction_required").length === 0 && hopEvidence("correction_required").length === 1 && dedupe.deduped && dedupe.notified_count === 0 && byType("esign.packet.fully_signed").length === 3 && STATES.every((s) => !!PACKET_HOP_NOTICE[s]?.title && !!PACKET_HOP_NOTICE[s]?.body && !/\$\s?\d/.test(PACKET_HOP_NOTICE[s].body)), `bells: ${[...new Set(bells().filter((n) => n.brokerage_id === B && /^esign\.packet\./.test(String(n.type))).map((n) => String(n.type)))].map((t) => `${t}×${byType(t).length}`).join(", ")}`)
  }
  c.blind("No envelope reaches a provider (the dispatch core is a recorder; the send door needs a session and is asserted on stripped source); the provider WEBHOOK routes (app/api/webhooks/{docusign,dotloop,skyslope,authentisign}) and their signature verification are test:webhook-contract's, not driven — evaluateEnvelopeExecution is driven directly with the envelope id a webhook would carry. The document scanner (signature_completeness) is modelled by fixtures; RLS not modelled.")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, cleanup.map((x) => `${x.table}:${x.deleted}`).join(" ") + (mismatches.length ? ` MISMATCH ${mismatches.join("; ")}` : ""))
  return c.report(cleanup, residual)
}
