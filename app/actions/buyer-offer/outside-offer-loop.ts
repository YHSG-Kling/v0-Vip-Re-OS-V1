"use server"

/**
 * app/actions/buyer-offer/outside-offer-loop.ts — THE AGENT'S DOORS INTO THE OUTSIDE-OFFER LOOP (wave 143, lane 143A).
 *
 * Our buyer's offer on SOMEONE ELSE'S listing: the agent APPROVES the outgoing packet → the platform emails the VERIFIED outside
 * listing agent → the reply is watched, filed and READ (lib/inbound-mail/offer-intake.ts tryRouteOutboundOfferReply) → the agent
 * CONFIRMS what it means → a counter-back is a NEW versioned counter and ONLY the counter is sent → repeat until agreement or
 * termination. The rules, and why each exists, are lib/offers/outside-offer-loop.ts's header.
 *
 *   sendOutsideOffer         approve + send an offer packet OR a counter-back (the recipient is verified first; governed egress)
 *   createOutsideCounterBack the buyer's counter to the seller's counter — a new versioned `offers` row (issueCounterOffer, the survivor)
 *   confirmOutsideReply      a person turns a READING into a recorded acceptance / counter / decline — through the existing
 *                            survivors (recordSellerResponse, recordSellerSignedCounter) — or dismisses it
 *   respondToOutsideCounter  decline (or accept) a received counter — delegates to the survivor respondToCounter
 *   listOutsideOffers        the reader behind /dashboard/offers (threads, readings, what needs the agent)
 *
 * EVERY export is a public endpoint (CLAUDE.md §4): the tenant is the SESSION's (requireCaller), the caller must be the offer's agent
 * or a tenant admin, the service client is used only AFTER that gate and every statement is pinned to the session's brokerage.
 * Nothing here accepts a contract, signs for anyone, or creates a transaction.
 */

import { requireCaller } from "@/lib/auth/require-caller"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { resolveAgentIdInBrokerage } from "@/lib/kernel/agent-identity"
import { OUTSIDE_LISTING_AGENT_EMAIL_KEY, OUTSIDE_LISTING_AGENT_NAME_KEY, OUTBOUND_WATCH_ARMED_AT_KEY } from "@/lib/inbound-mail/offer-detect"
import { isAtOrPastAllSigned } from "@/lib/esign/packet-states"
import { normalizeMessageId } from "@/lib/inbound-mail/message-meta"
import {
  OUTSIDE_LOOP_KEY, OUTSIDE_RECIPIENT_VERIFICATIONS, buildOutsideEmail, decideOutsideSend, isEmailShape, loadOutsideChain,
  mergeLoopState, normalizeEmail, parseSignedStorageUrl, patchMessage, verifyRecipientAgainstMls,
  type OutboundDoc, type OutsideChain, type OutsideRecipientVerification,
} from "@/lib/offers/outside-offer-loop"
import { governingContractTerms, recordContractTermsVersion } from "@/lib/offers/governing-terms"
import { canonicalTerms, signaturesPresent } from "@/lib/offers/governing-terms-rule"

type Svc = ReturnType<typeof createServiceClient>
type Caller = { userId: string; brokerageId: string; userType: string | null }

/** How long a document link in the email stays valid. Short on purpose (the stored URLs live ten years). */
const OUTBOUND_LINK_DAYS = 7

/** The caller must be this offer's agent or a tenant admin; the offer must be on an OUTSIDE property. */
async function authorize(svc: Svc, caller: Caller, offerId: string): Promise<{ ok: true; chain: OutsideChain } | { ok: false; error: string }> {
  if (!isValidUUID(offerId)) return { ok: false, error: "Invalid offer ID" }
  const loaded = await loadOutsideChain(svc as any, caller.brokerageId, offerId)
  if (!loaded.ok) return { ok: false, error: loaded.reason }
  if (loaded.chain.root.listing_id) return { ok: false, error: "This offer is on an in-house listing — the outside-listing loop does not apply." }
  if (!TENANT_ADMIN_USER_TYPES.has(String(caller.userType ?? "").toLowerCase())) {
    const agentId = await resolveAgentIdInBrokerage(svc as any, caller.userId, caller.brokerageId)
    if (!agentId || loaded.chain.root.agent_id !== agentId) return { ok: false, error: "Only the offer's agent or a brokerage admin can act on this offer." }
  }
  return { ok: true, chain: loaded.chain }
}

// ─── SEND ────────────────────────────────────────────────────────────────────────────────────────

export async function sendOutsideOffer(params: {
  /** The row being sent: the chain's ROOT (the offer packet) or the newest COUNTER row the buyer issued (a counter-back). */
  offerId: string
  /** The documents to share. For a counter-back: only documents filed to the counter row itself. */
  documentIds: string[]
  /** Overrides the address recorded on the offer. */
  recipientEmail?: string
  /** The agent states this address IS the outside listing agent (used only when the MLS lookup cannot verify it). */
  confirmRecipient?: boolean
  note?: string
}): Promise<{ success: boolean; error?: string; needsRecipientConfirmation?: boolean; messageId?: string; deliveredTo?: string; verifiedBy?: OutsideRecipientVerification; replyWatch?: "mailbox_connected" | "no_mailbox"; warnings?: string[] }> {
  const caller = await requireCaller()
  if (!caller.ok) return { success: false, error: caller.error }
  if (!Array.isArray(params.documentIds) || !params.documentIds.every((d) => isValidUUID(d))) return { success: false, error: "Invalid document IDs" }
  const svc = createServiceClient()
  const auth = await authorize(svc, caller, params.offerId)
  if (!auth.ok) return { success: false, error: auth.error }
  const { chain } = auth
  const row = chain.rows.find((r) => r.id === params.offerId)
  if (!row) return { success: false, error: "That offer is not part of this chain." }
  if (row.id !== chain.head.id) return { success: false, error: "Only the newest round can be sent — an earlier round is superseded." }
  const kind = row.parent_offer_id ? "counter_back" : "offer_packet"
  if (kind === "counter_back" && (row.metadata?.[OUTSIDE_LOOP_KEY]?.issued_by !== "buyer")) {
    return { success: false, error: "This counter was issued by the seller's side — only a counter the buyer issued (createOutsideCounterBack) is sent." }
  }

  // ── the recipient is VERIFIED before anything leaves ──────────────────────────────────────────
  const rootMeta = (chain.root.metadata ?? {}) as Record<string, any>
  const recipient = normalizeEmail(params.recipientEmail ?? (rootMeta[OUTSIDE_LISTING_AGENT_EMAIL_KEY] as string | undefined))
  if (!isEmailShape(recipient)) return { success: false, error: "Enter the listing agent's email address — none is recorded on this offer." }
  const cp = (rootMeta[OUTSIDE_LOOP_KEY]?.counterparty ?? null) as { email?: string; verified_by?: string } | null
  let verifiedBy: OutsideRecipientVerification | null =
    cp && normalizeEmail(cp.email) === recipient && (OUTSIDE_RECIPIENT_VERIFICATIONS as readonly string[]).includes(String(cp.verified_by)) ? (cp.verified_by as OutsideRecipientVerification) : null
  if (!verifiedBy) {
    const mls = await verifyRecipientAgainstMls({ brokerageId: caller.brokerageId, propertyAddress: chain.root.property_address ?? "", recipientEmail: recipient })
    if (mls.verified) verifiedBy = "mls_published"
    else if (params.confirmRecipient === true) verifiedBy = "agent_confirmed"
    else return { success: false, needsRecipientConfirmation: true, error: `${recipient} is not verified as the listing agent: ${mls.reason}. If you know this is the listing agent's address, confirm it and send again.` }
  }

  // ── the documents ────────────────────────────────────────────────────────────────────────────
  const { data: docRows, error: docErr } = await svc.from("documents").select("id, classification, storage_url, metadata, signature_completeness").in("id", params.documentIds).eq("brokerage_id", caller.brokerageId)
  if (docErr) return { success: false, error: `Could not read the documents: ${docErr.message}` }
  if ((docRows ?? []).length !== params.documentIds.length) return { success: false, error: "One or more documents are not in your brokerage." }
  const docs: OutboundDoc[] = (docRows as any[]).map((d) => ({ id: d.id, name: (d.metadata?.file_name as string) ?? d.id, classification: d.classification ?? null, linkedOfferId: (d.metadata?.linked_offer_id as string | null) ?? null, storageUrl: d.storage_url ?? null }))
  // The buyer's signature: the e-sign ladder for a packet; the document's own signature reading for a counter (nothing is invented).
  const { data: rootFull } = await svc.from("offers").select("esign_status, buyer_signed_at").eq("id", chain.root.id).eq("brokerage_id", caller.brokerageId).maybeSingle()
  const buyerSigned = kind === "offer_packet"
    ? isAtOrPastAllSigned((rootFull as any)?.esign_status) || !!(rootFull as any)?.buyer_signed_at || (docRows as any[]).some((d) => signaturesPresent(d.signature_completeness, ["buyer"]).missing.length === 0)
    : (docRows as any[]).some((d) => signaturesPresent(d.signature_completeness, ["buyer"]).missing.length === 0)
  const decision = decideOutsideSend({ kind, offer: { id: row.id, listing_id: chain.root.listing_id }, buyerSigned, recipient: { email: recipient, verifiedBy }, documents: docs })
  if (!decision.ok) return { success: false, error: decision.reason }

  // ── no unauthorized agent concession leaves with it (wave 146, lane 146I — owner ruling 4: ask the broker FIRST) ───────────
  {
    const { unauthorizedConcessionsOnOfferChain, unauthorizedConcessionRefusal } = await import("@/lib/commission/agent-concession")
    const pending = await unauthorizedConcessionsOnOfferChain(svc as any, { brokerageId: caller.brokerageId, offerId: row.id })
    if (!pending.ok) return { success: false, error: pending.error }
    if (pending.unauthorized.length > 0) return { success: false, error: unauthorizedConcessionRefusal(pending.unauthorized, kind === "counter_back" ? "This counter" : "This offer") }
  }

  // ── secure expiring links (the governed egress carries no attachments) ──────────────────────────
  const { signedDocUrl } = await import("@/lib/storage/signed-doc-url")
  const links: Array<{ name: string; url: string }> = []
  for (const d of docs) {
    const loc = parseSignedStorageUrl(d.storageUrl)!
    const url = await signedDocUrl(svc as any, loc.bucket, loc.path, OUTBOUND_LINK_DAYS * 86_400)
    if (!url) return { success: false, error: `A secure link for ${d.name} could not be created — nothing was sent.` }
    links.push({ name: d.name, url })
  }
  const { data: agentUser } = await svc.from("users").select("first_name, last_name").eq("id", caller.userId).maybeSingle()
  const { data: brk } = await svc.from("brokerages").select("name").eq("id", caller.brokerageId).maybeSingle()
  const fromName = [(agentUser as any)?.first_name, (agentUser as any)?.last_name].filter(Boolean).join(" ") || "Your buyer's agent"
  const email = buildOutsideEmail({
    kind, offerId: chain.root.id, propertyAddress: chain.root.property_address ?? "the property", round: row.current_round ?? 1,
    fromAgentName: fromName, brokerageName: (brk as any)?.name ?? null, documents: links, linkDays: OUTBOUND_LINK_DAYS, note: params.note ?? null,
  })

  // ── send through the ONE governed egress, human-approved ─────────────────────────────────────────
  const { dispatchEmail } = await import("@/lib/providers/dispatch")
  const sent = await dispatchEmail({
    brokerageId: caller.brokerageId, userId: caller.userId, to: recipient, subject: email.subject, html: email.html, text: email.text,
    channelPurpose: "transactional", sendAsAgentUserId: caller.userId, humanApproved: true, systemSource: "outside_offer_loop",
    ledger: { reasonCode: "HUMAN_REQUESTED", reasonDetail: `${kind === "counter_back" ? "counter-back" : "offer packet"} approved by the agent and sent to the verified outside listing agent` },
    metadata: { offer_id: chain.root.id, head_offer_id: row.id, kind },
  } as any)
  const sentAt = new Date().toISOString()
  const warnings: string[] = []

  const sentMid = normalizeMessageId((sent as any).messageId == null ? null : String((sent as any).messageId))
  const messageKey = sentMid ? `mid:${sentMid}` : `out:${row.id}:${sentAt}`
  const { data: ledger, error: ledgerErr } = await svc.from("outside_offer_messages").insert({
    brokerage_id: caller.brokerageId, offer_id: chain.root.id, head_offer_id: row.id, direction: "outbound", kind, message_key: messageKey,
    counterparty_email: recipient, recipient_verification: verifiedBy, subject: email.subject, sent_at: sentAt, document_ids: params.documentIds,
    status: sent.success ? "sent" : "send_failed", approved_by: caller.userId, approved_at: sentAt,
    reading: sent.success ? {} : { send_error: (sent as any).error ?? "unknown" },
  }).select("id")
  if (ledgerErr) warnings.push(`the send was ${sent.success ? "delivered but" : "refused and"} could not be ledgered: ${ledgerErr.message}`)
  const messageId = (ledger as any)?.[0]?.id as string | undefined
  if (!sent.success) return { success: false, error: `The email was not sent: ${(sent as any).error ?? "the egress refused it"}`, messageId, warnings }

  // arm the reply watch on the ROOT (merged, never assigned) and remember who was verified how
  const armed = await mergeLoopState(svc as any, caller.brokerageId, chain.root.id,
    { counterparty: { email: recipient, verified_by: verifiedBy, verified_at: sentAt, verified_by_user: caller.userId, aliases: cp && normalizeEmail(cp.email) === recipient ? ((cp as any).aliases ?? []) : [] }, head_offer_id: row.id, last_outbound_message_id: messageId ?? null, last_outbound_at: sentAt },
    { [OUTSIDE_LISTING_AGENT_EMAIL_KEY]: recipient, [OUTSIDE_LISTING_AGENT_NAME_KEY]: rootMeta[OUTSIDE_LISTING_AGENT_NAME_KEY] ?? null, [OUTBOUND_WATCH_ARMED_AT_KEY]: rootMeta[OUTBOUND_WATCH_ARMED_AT_KEY] ?? sentAt })
  if (!armed.ok) warnings.push(`the reply watch could not be armed: ${armed.reason}`)

  // evidence + the offer's lifecycle (SENT_TO_LISTING → under review)
  try {
    const { recordLifecycleEvent } = await import("@/lib/events/lifecycle-event-core")
    await recordLifecycleEvent(svc, caller.brokerageId, { event_type: "offer.outside.sent", payload: { offer_id: chain.root.id, head_offer_id: row.id, kind, to: recipient, verified_by: verifiedBy, document_count: docs.length, message_id: messageId ?? null }, source: "ui", user_id: caller.userId, entity_type: "offer", entity_id: chain.root.id }, { dedupeWindowHours: null })
    const { OFFER_EVENT } = await import("@/lib/buyer-offer/offer-lifecycle")
    const { error: actErr } = await svc.from("activities").insert({ brokerage_id: caller.brokerageId, agent_id: chain.root.agent_id, contact_id: chain.root.contact_id, activity_type: OFFER_EVENT.SENT_TO_LISTING, title: kind === "counter_back" ? "Counter-offer sent to the listing agent" : "Offer sent to the listing agent", description: `Emailed to ${recipient} (verified: ${verifiedBy})`, metadata: { offer_id: row.id, message_id: messageId ?? null }, status: "completed", entity_type: "offer", entity_id: row.id })
    if (actErr) warnings.push(`the offer's lifecycle event was not written: ${actErr.message}`)
    else { const { syncOfferStatus } = await import("@/lib/buyer-offer"); await syncOfferStatus(row.id, caller.brokerageId).catch(() => undefined) }
  } catch (err) {
    warnings.push(`evidence step failed: ${(err as Error)?.message ?? err}`)
  }

  // is the reply watch real? (the agent's mailbox must be one the inbound webhook can see)
  let replyWatch: "mailbox_connected" | "no_mailbox" = "no_mailbox"
  try {
    const { resolveInboundEmailProviderForUser } = await import("@/lib/inbound-mail/resolve-user-provider")
    const { data: u } = await svc.from("users").select("team_id").eq("id", caller.userId).maybeSingle()
    const p = await resolveInboundEmailProviderForUser({ userId: caller.userId, teamId: (u as any)?.team_id ?? null, brokerageId: caller.brokerageId })
    if (p) replyWatch = "mailbox_connected"
  } catch { /* unknown stays no_mailbox */ }
  if (replyWatch === "no_mailbox") warnings.push("No inbound mailbox is connected for you, so the platform cannot see the listing agent's reply — connect your Gmail/Outlook (or forward replies to your brokerage inbound address).")

  return { success: true, messageId, deliveredTo: recipient, verifiedBy: verifiedBy!, replyWatch, warnings }
}

// ─── COUNTER-BACK ────────────────────────────────────────────────────────────────────────────────

export async function createOutsideCounterBack(params: {
  /** The seller's counter row (the chain's newest round) the buyer is answering. */
  parentOfferId: string
  counterPrice?: number
  closingDate?: string
  earnestMoney?: number
  contingencies?: string[]
  possessionTerms?: string
  /** Any other term the counter changes, in the contract-term vocabulary (title_policy_payer, inspection_period_days, …). */
  terms?: Record<string, unknown>
  notes?: string
}): Promise<{ success: boolean; error?: string; counterOfferId?: string; round?: number }> {
  const caller = await requireCaller()
  if (!caller.ok) return { success: false, error: caller.error }
  const svc = createServiceClient()
  const auth = await authorize(svc, caller, params.parentOfferId)
  if (!auth.ok) return { success: false, error: auth.error }
  const { chain } = auth
  const parent = chain.rows.find((r) => r.id === params.parentOfferId)
  if (!parent || parent.id !== chain.head.id) return { success: false, error: "Counter the newest round — an earlier round is superseded." }
  if (!parent.parent_offer_id || parent.metadata?.[OUTSIDE_LOOP_KEY]?.issued_by === "buyer") return { success: false, error: "There is no seller counter to answer yet — wait for the listing agent's reply, or send the offer first." }
  const extra = canonicalTerms(params.terms)
  if (extra.unknownKeys.length) return { success: false, error: `Not contract terms in the vocabulary: ${extra.unknownKeys.join(", ")}` }
  const changed = params.counterPrice !== undefined || params.closingDate !== undefined || params.earnestMoney !== undefined || params.contingencies !== undefined || params.possessionTerms !== undefined || Object.keys(extra.terms).length > 0
  if (!changed) return { success: false, error: "A counter-back changes at least one term — name it." }

  if (!chain.root.agent_id) return { success: false, error: "This offer has no agent on it — assign one before countering." }
  const { issueCounterOffer } = await import("@/lib/kernel/offers")
  const made = await issueCounterOffer({
    // offers.agent_id IS an agents.id (the counter row is written under the same agent as the offer it answers)
    offerId: parent.id, agentId: chain.root.agent_id, brokerageId: caller.brokerageId,
    counterPrice: params.counterPrice, closingDate: params.closingDate, earnestMoney: params.earnestMoney, contingencies: params.contingencies,
    possessionTerms: params.possessionTerms, notes: params.notes, actorUserId: caller.userId,
  }, svc as any)
  if (!made.success || !made.data) return { success: false, error: made.error ?? "The counter-back could not be created" }
  const counterId = made.data.counterId

  // who issued it (the rows alone cannot say), merged into the new row's metadata
  const { error: metaErr } = await svc.from("offers").update({ metadata: { [OUTSIDE_LOOP_KEY]: { issued_by: "buyer", counter_back_of: parent.id, issued_by_user: caller.userId } } }).eq("id", counterId).eq("brokerage_id", caller.brokerageId)
  if (metaErr) console.error(`[outside-offer-loop] counter-back ${counterId} issuer not recorded: ${metaErr.message}`)
  // the full confirmed terms ride the immutable record as a PROPOSED version (it governs only once executed)
  const fullTerms: Record<string, unknown> = { ...extra.terms }
  if (params.counterPrice !== undefined) fullTerms.offer_price = params.counterPrice
  if (params.closingDate !== undefined) fullTerms.closing_date = params.closingDate
  if (params.earnestMoney !== undefined) fullTerms.earnest_money = params.earnestMoney
  if (params.contingencies !== undefined) fullTerms.contingencies = params.contingencies
  if (params.possessionTerms !== undefined) fullTerms.possession_terms = params.possessionTerms
  const rec = await recordContractTermsVersion(svc as any, { brokerageId: caller.brokerageId, rootOfferId: chain.root.id, offerId: counterId, source: "counter", status: "proposed", terms: fullTerms, recordedBy: caller.userId, evidence: { issued_by: "buyer", counter_back_of: parent.id } })
  if (!rec.ok) console.error(`[outside-offer-loop] counter-back ${counterId} terms version not recorded: ${rec.reason}`)
  const merged = await mergeLoopState(svc as any, caller.brokerageId, chain.root.id, { head_offer_id: counterId })
  if (!merged.ok) console.error(`[outside-offer-loop] chain head pointer not updated: ${merged.reason}`)
  return { success: true, counterOfferId: counterId, round: made.data.round }
}

// ─── CONFIRM ─────────────────────────────────────────────────────────────────────────────────────

export async function confirmOutsideReply(params: {
  /** The ledger row (outside_offer_messages) of the inbound reply. */
  messageId: string
  decision: "accepted" | "countered" | "rejected" | "dismissed"
  /** The filed document that IS the signed contract (accepted) or the seller-signed counter (countered). Must be one of the reply's. */
  documentId?: string
  /** The counter's terms AS THE AGENT CONFIRMS THEM (the AI's reading is a draft, never the record). */
  terms?: Record<string, unknown>
  /** Required to act on a reply whose sender the platform could not verify. */
  acknowledgeSender?: boolean
  note?: string
}): Promise<{ success: boolean; error?: string; needsSenderAcknowledgement?: boolean; resultingOfferId?: string }> {
  const caller = await requireCaller()
  if (!caller.ok) return { success: false, error: caller.error }
  if (!isValidUUID(params.messageId)) return { success: false, error: "Invalid message ID" }
  if (!["accepted", "countered", "rejected", "dismissed"].includes(params.decision)) return { success: false, error: "Invalid decision" }
  const svc = createServiceClient()
  const { data: msg, error: msgErr } = await svc.from("outside_offer_messages").select("*").eq("id", params.messageId).eq("brokerage_id", caller.brokerageId).maybeSingle()
  if (msgErr) return { success: false, error: `Could not read the reply: ${msgErr.message}` }
  if (!msg) return { success: false, error: "Reply not found in your brokerage" }
  const m = msg as Record<string, any>
  if (m.direction !== "inbound") return { success: false, error: "Only an inbound reply can be confirmed." }
  if (m.status !== "awaiting_agent") return { success: false, error: `This reply is already ${m.status}.` }
  const auth = await authorize(svc, caller, m.offer_id)
  if (!auth.ok) return { success: false, error: auth.error }
  const { chain } = auth
  const headId = (m.head_offer_id as string) ?? chain.head.id
  const resolution = { decision: params.decision, by: caller.userId, at: new Date().toISOString(), note: params.note ?? null, acknowledged_sender: params.acknowledgeSender === true, document_id: params.documentId ?? null }

  if (params.decision === "dismissed") {
    const p = await patchMessage(svc as any, caller.brokerageId, m.id, { status: "dismissed", resolved_by: caller.userId, resolved_at: resolution.at, resolution })
    return p.ok ? { success: true } : { success: false, error: p.reason }
  }
  // THE SENDER (rule 4): an unverified sender is acted on only when the agent says they know who it is.
  const verdict = (m.reading?.sender_verdict ?? null) as { trusted?: boolean; reason?: string } | null
  if (!verdict?.trusted && params.acknowledgeSender !== true) {
    return { success: false, needsSenderAcknowledgement: true, error: `The platform could not verify this sender: ${verdict?.reason ?? "no verification on record"}. If you know this message is from the listing agent, acknowledge it and confirm again.` }
  }
  const messageDocs: string[] = Array.isArray(m.document_ids) ? m.document_ids : []
  let doc: Record<string, any> | null = null
  if (params.documentId) {
    if (!messageDocs.includes(params.documentId)) return { success: false, error: "That document did not come with this reply." }
    const { data, error } = await svc.from("documents").select("id, storage_url, signature_completeness, metadata").eq("id", params.documentId).eq("brokerage_id", caller.brokerageId).maybeSingle()
    if (error) return { success: false, error: `Could not read the document: ${error.message}` }
    doc = (data as Record<string, any> | null) ?? null
  }

  let resultingOfferId: string | undefined
  if (params.decision === "accepted") {
    if (!doc) return { success: false, error: "Name the signed contract the listing agent sent — an acceptance is the signed document, not the email." }
    const sig = signaturesPresent(doc.signature_completeness, ["buyer", "seller"])
    if (sig.missing.length) return { success: false, error: `The document does not show ${sig.missing.join(" and ")} signed${doc.signature_completeness ? "" : " (it has not been read for signatures yet)"} — an acceptance is recorded only on a contract both parties signed. Ask the listing agent for the signed contract.` }
    const { recordSellerResponse } = await import("./record-seller-response")
    const r = await recordSellerResponse({ offerId: headId, responseType: "accepted", documentId: params.documentId, notes: params.note })
    if (!r.success) return { success: false, error: r.error ?? "The acceptance could not be recorded" }
    resultingOfferId = headId
  } else if (params.decision === "rejected") {
    const { recordSellerResponse } = await import("./record-seller-response")
    const r = await recordSellerResponse({ offerId: headId, responseType: "rejected", documentId: params.documentId, notes: params.note })
    if (!r.success) return { success: false, error: r.error ?? "The decline could not be recorded" }
    resultingOfferId = headId
  } else {
    const c = canonicalTerms(params.terms)
    if (c.unknownKeys.length) return { success: false, error: `Not contract terms in the vocabulary: ${c.unknownKeys.join(", ")}` }
    if (Object.keys(c.terms).length === 0) return { success: false, error: "State the counter's terms (confirm what the listing agent proposed) — the AI's reading is a draft, not the record." }
    if (!doc) return { success: false, error: "Name the seller-signed counter document the listing agent sent." }
    const sig = signaturesPresent(doc.signature_completeness, ["seller"])
    if (sig.missing.length) return { success: false, error: `The counter does not show the seller's signature${doc.signature_completeness ? "" : " (it has not been read for signatures yet)"} — the seller signs a counter first. Ask the listing agent for the signed counter.` }
    const { recordSellerSignedCounter } = await import("./record-seller-signed-counter")
    const t = c.terms as Record<string, any>
    const r = await recordSellerSignedCounter({
      parentOfferId: headId, raiserUserId: caller.userId, source: "external",
      terms: { counterPrice: t.offer_price as number | undefined, closingDate: t.closing_date as string | undefined, contingencies: t.contingencies as string[] | undefined, possessionTerms: t.possession_terms as string | undefined, notes: params.note },
      sellerSignedDocumentUrl: doc.storage_url as string,
    })
    if (!r.success || !r.counterOfferId) return { success: false, error: r.error ?? "The counter could not be recorded" }
    resultingOfferId = r.counterOfferId
    // the confirmed terms (all of them, including the ones an offers row has no column for) ride the immutable record as PROPOSED
    const rec = await recordContractTermsVersion(svc as any, { brokerageId: caller.brokerageId, rootOfferId: chain.root.id, offerId: r.counterOfferId, source: "counter", status: "proposed", terms: c.terms, documentId: params.documentId, recordedBy: caller.userId, evidence: { issued_by: "seller_side", message_id: m.id } })
    if (!rec.ok) console.error(`[outside-offer-loop] counter ${r.counterOfferId} terms version not recorded: ${rec.reason}`)
    const merged = await mergeLoopState(svc as any, caller.brokerageId, chain.root.id, { head_offer_id: r.counterOfferId })
    if (!merged.ok) console.error(`[outside-offer-loop] chain head pointer not updated: ${merged.reason}`)
  }
  const done = await patchMessage(svc as any, caller.brokerageId, m.id, { status: "confirmed", resolved_by: caller.userId, resolved_at: resolution.at, resolution: { ...resolution, resulting_offer_id: resultingOfferId ?? null } })
  if (!done.ok) console.error(`[outside-offer-loop] reply ${m.id} was recorded but its ledger row was not closed: ${done.reason}`)
  return { success: true, resultingOfferId }
}

export async function respondToOutsideCounter(params: { counterOfferId: string; response: "accept" | "reject"; reason?: string }): Promise<{ success: boolean; error?: string }> {
  const caller = await requireCaller()
  if (!caller.ok) return { success: false, error: caller.error }
  const svc = createServiceClient()
  const auth = await authorize(svc, caller, params.counterOfferId)
  if (!auth.ok) return { success: false, error: auth.error }
  const row = auth.chain.rows.find((r) => r.id === params.counterOfferId)
  if (!row || row.id !== auth.chain.head.id || !row.parent_offer_id || row.metadata?.[OUTSIDE_LOOP_KEY]?.issued_by === "buyer") return { success: false, error: "Respond to the seller's newest counter." }
  const { respondToCounter } = await import("./respond-to-counter")
  const r = await respondToCounter({ offerId: params.counterOfferId, response: params.response, rejectionReason: params.reason })
  return r.success ? { success: true } : { success: false, error: (r as { error?: string }).error ?? "The response could not be recorded" }
}

// ─── READ ────────────────────────────────────────────────────────────────────────────────────────

export interface OutsideOfferThread {
  offerId: string
  propertyAddress: string | null
  recipientEmail: string | null
  verifiedBy: string | null
  headOfferId: string
  headRound: number
  headIssuedBy: "buyer" | "seller_side" | "original"
  headStatus: string | null
  /** Documents filed to the head row (what a send/counter-back may attach). */
  headDocuments: Array<{ id: string; name: string; classification: string | null }>
  messages: Array<{ id: string; direction: string; kind: string; status: string; classification: string | null; recommendedAction: string | null; subject: string | null; at: string | null; documentIds: string[]; summary: string | null; senderTrusted: boolean | null; senderReason: string | null; downgrades: string[]
    /** The AI's DRAFT reading of the terms the reply states — shown so the agent can confirm or correct them; never the record. */
    draftTerms: Record<string, unknown>; questions: string[]
    /** The chain row the message was sent about / answers (tells the UI whether the CURRENT round has gone out). */
    headOfferId: string | null }>
  /** The contract AS IT STANDS — read through the ONE reader (lib/offers/governing-terms.ts governingContractTerms). Null when it could not be read (see governingError) or nothing is executed yet. */
  governing: { source: string; versionNo: number; values: Record<string, unknown>; supersededCount: number; pendingCount: number } | null
  governingError: string | null
  needsAgent: boolean
}

export async function listOutsideOffers(): Promise<{ success: boolean; error?: string; threads: OutsideOfferThread[] }> {
  const caller = await requireCaller()
  if (!caller.ok) return { success: false, error: caller.error, threads: [] }
  const svc = createServiceClient()
  let q = svc.from("offers").select("id, agent_id, property_address, metadata, created_at").eq("brokerage_id", caller.brokerageId).is("listing_id", null).is("parent_offer_id", null)
  if (!TENANT_ADMIN_USER_TYPES.has(String(caller.userType ?? "").toLowerCase())) {
    const agentId = await resolveAgentIdInBrokerage(svc as any, caller.userId, caller.brokerageId)
    if (!agentId) return { success: true, threads: [] }
    q = q.eq("agent_id", agentId)
  }
  const { data: roots, error } = await q.order("created_at", { ascending: false }).limit(25)
  if (error) return { success: false, error: `Could not read your outside offers: ${error.message}`, threads: [] }
  const rootIds = (roots ?? []).map((r: any) => r.id as string)
  if (rootIds.length === 0) return { success: true, threads: [] }
  const { data: msgs, error: mErr } = await svc.from("outside_offer_messages").select("*").eq("brokerage_id", caller.brokerageId).in("offer_id", rootIds).order("created_at", { ascending: false }).limit(300)
  if (mErr) return { success: false, error: `Could not read the replies: ${mErr.message}`, threads: [] }
  const threads: OutsideOfferThread[] = []
  for (const r of (roots ?? []) as any[]) {
    const loaded = await loadOutsideChain(svc as any, caller.brokerageId, r.id)
    if (!loaded.ok) continue
    const { chain } = loaded
    const headRow = chain.rows.find((x) => x.id === chain.head.id)!
    const { data: docs } = await svc.from("documents").select("id, classification, metadata").eq("brokerage_id", caller.brokerageId).eq("metadata->>linked_offer_id", chain.head.id).limit(20)
    const mine = (msgs ?? []).filter((x: any) => x.offer_id === r.id)
    const loop = (r.metadata?.[OUTSIDE_LOOP_KEY] ?? {}) as any
    // the contract as it stands: the ONE reader, never a re-derivation here. A refused read is shown as such, never as "no terms".
    const gov = await governingContractTerms(svc as any, caller.brokerageId, { offerId: r.id })
    threads.push({
      offerId: r.id, propertyAddress: r.property_address ?? null,
      recipientEmail: (r.metadata?.[OUTSIDE_LISTING_AGENT_EMAIL_KEY] as string | undefined) ?? null, verifiedBy: loop.counterparty?.verified_by ?? null,
      headOfferId: chain.head.id, headRound: chain.head.current_round ?? 1,
      headIssuedBy: !headRow.parent_offer_id ? "original" : headRow.metadata?.[OUTSIDE_LOOP_KEY]?.issued_by === "buyer" ? "buyer" : "seller_side",
      headStatus: chain.head.status ?? null,
      headDocuments: ((docs ?? []) as any[]).map((d) => ({ id: d.id, name: d.metadata?.file_name ?? d.id, classification: d.classification ?? null })),
      messages: mine.map((x: any) => ({
        id: x.id, direction: x.direction, kind: x.kind, status: x.status, classification: x.classification ?? null, recommendedAction: x.recommended_action ?? null,
        subject: x.subject ?? null, at: x.received_at ?? x.sent_at ?? x.created_at ?? null, documentIds: x.document_ids ?? [],
        summary: x.reading?.model?.summary ?? null, senderTrusted: x.reading?.sender_verdict?.trusted ?? null, senderReason: x.reading?.sender_verdict?.reason ?? null, downgrades: x.reading?.downgrades ?? [],
        draftTerms: (x.reading?.model?.terms && typeof x.reading.model.terms === "object" ? x.reading.model.terms : {}) as Record<string, unknown>,
        questions: Array.isArray(x.reading?.model?.questions) ? x.reading.model.questions : [],
        headOfferId: (x.head_offer_id as string | null) ?? null,
      })),
      governing: gov.ok && gov.governing.governingVersion
        ? { source: gov.governing.governingVersion.source, versionNo: gov.governing.governingVersion.versionNo, values: gov.governing.values as Record<string, unknown>, supersededCount: gov.governing.conflicts.length, pendingCount: gov.governing.pending.length }
        : null,
      governingError: gov.ok ? null : gov.reason,
      needsAgent: mine.some((x: any) => x.direction === "inbound" && x.status === "awaiting_agent"),
    })
  }
  return { success: true, threads }
}
