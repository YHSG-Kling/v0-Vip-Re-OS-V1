// lib/offers/outside-offer-loop.ts
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE OUTSIDE-OFFER LOOP — our buyer's offer on SOMEONE ELSE'S listing (wave 143, lane 143A).
//
// Owner (wave 143, verbatim): "Not all offers are on in-house listings. An offer is created in the platform and emailed
// to the OUTSIDE listing agent; the outside seller accepts, counters or declines. A counter comes back by email (counter +
// addendums + original offer signed by the seller) to the in-house buyer agent; the buyer accepts, counters back or
// declines. A counter-back is created in the platform and ONLY the counter is sent to the outside listing agent; the seller
// accepts, counters or declines and the outside agent emails it back; the buyer accepts or declines. The platform WATCHES for
// the email responses, uploads them into the platform and notifies the offer recipients."
//
// ── AUDIT (CLAUDE.md §1 — what already existed, and what this extends) ─────────────────────────────
//   BUILT   the outside agent RECORD for an outside BUYER's agent on OUR listing (lib/offers/outside-agent-record.ts, waves
//           94/95: inbound email → record → AI read → seller portal). That is the OTHER direction; it is untouched.
//   BUILT   the buyer-side WATCH: submit-for-signature arms `offers.metadata.outside_listing_agent_email` for an offer with no
//           listings row (planOutboundWatch, lib/inbound-mail/offer-detect.ts), and tryRouteOutboundOfferReply
//           (lib/inbound-mail/offer-intake.ts) routed a reply FROM that address into the offer's deal file. It matched on the
//           sender address ONLY, filed the PDFs, stamped the offer and belled the agent — with no thread match, no sender
//           verification, no idempotency (a redelivered webhook re-filed and re-belled), no reading of what the reply SAID,
//           and no way back out.
//   BUILT   the versioned counter chain: issueCounterOffer (lib/kernel/offers.ts) writes a new `offers` row with
//           parent_offer_id + current_round + the carried terms (lib/transactions/contract-terms.ts); recordSellerSignedCounter
//           (app/actions/buyer-offer/record-seller-signed-counter.ts) records a seller-signed external counter;
//           recordSellerResponse records an acceptance / decline. These are the survivors every decision below goes through.
//   MISSING (built here) the outbound email to the outside listing agent (the packet left only on an e-sign envelope), the
//           ledger that makes the loop idempotent and auditable, sender verification, the AI READING of a reply (class, terms,
//           attachments, recommended action — a recommendation, never a decision), the buyer's counter-back SENT as only the
//           counter, and the confirm step where a person turns a reading into a recorded response.
//
// ── THE RULES THIS FILE IS (each has a positive-controlled proof in scripts/outside-offer-loop-guard.ts) ─────────────
//   1. THE PLATFORM NEVER ACCEPTS, SIGNS OR CREATES A TRANSACTION. The AI classifies and recommends. A reply becomes a
//      recorded acceptance / counter / decline only when a PERSON confirms it (confirmOutsideReply), through the existing
//      survivors; a transaction exists only after execution + compliance (the offer-compliance loop and the transaction gate).
//   2. AMBIGUITY IS NEVER ACCEPTANCE. Acceptance needs the AI, the deterministic floor AND a signed contract attached to agree;
//      anything less is `ambiguous` with the remedy named (ask for the signed contract). Conditional "accepted, but…" is a counter.
//   3. NOTHING IS INVENTED. Terms come only from the reply; a value the reply does not state is null, never a default.
//   4. THE SENDER IS VERIFIED OR THE AGENT IS TOLD IT IS NOT. A failed authentication quarantines the message (nothing filed);
//      an unauthenticated or unexpected sender is filed and flagged, and confirming it needs an explicit acknowledgement.
//   5. IDEMPOTENT. One inbound message = one ledger row (unique on brokerage + offer + direction + message key). A redelivery
//      re-files nothing and re-bells nobody.
//   6. A COUNTER-BACK SENDS ONLY THE COUNTER. The documents named must be linked to the counter row itself; the original packet
//      and prior rounds are refused by name.
//   7. THE RECIPIENT IS VERIFIED BEFORE ANYTHING LEAVES. The outside listing agent's address must match the MLS-published listing
//      agent contact (RentCast) or be confirmed by the agent; then the send is governed egress (dispatchEmail), human-approved.
//
// PURE where it can be (a proof runs it with no database); every database touch is behind an injected client, tenant-pinned,
// error-read and counted. Not `server-only`: the pure half is driven by a plain tsx guard.

import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { normalizeMessageId } from "@/lib/inbound-mail/message-meta"

type Svc = SupabaseClient<any, any, any>

// ─── ONE VOCABULARY (m798's CHECKs are DERIVED from these by the proof) ──────────────────────────
export const OUTSIDE_MESSAGE_DIRECTIONS = ["outbound", "inbound"] as const
export const OUTSIDE_MESSAGE_KINDS = ["offer_packet", "counter_back", "seller_reply"] as const
export const OUTSIDE_MESSAGE_STATUSES = ["sent", "send_failed", "awaiting_agent", "confirmed", "dismissed", "quarantined"] as const
export const OUTSIDE_REPLY_CLASSES = ["acceptance", "counter", "decline", "ambiguous", "acknowledgement", "other"] as const
export const OUTSIDE_RECOMMENDED_ACTIONS = ["record_acceptance", "record_counter", "record_decline", "request_signed_document", "request_clarification", "review_manually", "file_only"] as const
export const OUTSIDE_SENDER_AUTH = ["pass", "fail", "unknown"] as const
export const OUTSIDE_RECIPIENT_VERIFICATIONS = ["mls_published", "agent_confirmed"] as const

export type OutsideMessageStatus = (typeof OUTSIDE_MESSAGE_STATUSES)[number]
export type OutsideReplyClass = (typeof OUTSIDE_REPLY_CLASSES)[number]
export type OutsideRecommendedAction = (typeof OUTSIDE_RECOMMENDED_ACTIONS)[number]
export type OutsideRecipientVerification = (typeof OUTSIDE_RECIPIENT_VERIFICATIONS)[number]

/** `offers.metadata` key holding the loop's pointers (merged, never assigned). */
export const OUTSIDE_LOOP_KEY = "outside_loop"

// ─── identifiers ─────────────────────────────────────────────────────────────────────────────────
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The token an outbound subject carries and a reply echoes — the SAME `ref:offer:<uuid>` shape the generic inbound lane already reads. */
function outsideOfferToken(offerId: string): string {
  return `[ref:offer:${offerId}]`
}

/** The offer id a text names through the token, or null. */
export function offerIdFromText(text: string | null | undefined): string | null {
  const m = (text ?? "").match(new RegExp(`ref:offer:(${UUID})`, "i"))
  return m ? m[1].toLowerCase() : null
}

export function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase()
}

export function isEmailShape(raw: string | null | undefined): boolean {
  return EMAIL_SHAPE.test(normalizeEmail(raw))
}

/** PURE: the bucket and object path inside one of OUR signed storage URLs (…/object/sign/<bucket>/<path>?token=…), or null. */
export function parseSignedStorageUrl(url: string | null | undefined): { bucket: string; path: string } | null {
  const m = (url ?? "").match(/\/storage\/v1\/object\/(?:sign|authenticated|public)\/([^/?]+)\/([^?]+)/)
  if (!m) return null
  try {
    return { bucket: decodeURIComponent(m[1]), path: decodeURIComponent(m[2]) }
  } catch {
    return null
  }
}

/**
 * PURE: the idempotency key of one inbound message — its RFC Message-ID when the provider carried one, else a content
 * hash (sender + subject + body head + each attachment's name and size). Two deliveries of the same message have the
 * same key; two different messages with the same subject do not.
 */
export function messageKeyFor(input: {
  messageId?: string | null
  fromEmail: string
  subject: string | null
  bodyText: string | null
  attachments: Array<{ fileName: string; contentB64: string | null }>
}): string {
  const mid = normalizeMessageId(input.messageId)
  if (mid) return `mid:${mid}`
  const h = createHash("sha256")
  h.update(normalizeEmail(input.fromEmail)); h.update("\n")
  h.update((input.subject ?? "").trim()); h.update("\n")
  h.update((input.bodyText ?? "").slice(0, 2000)); h.update("\n")
  for (const a of input.attachments) {
    h.update(a.fileName); h.update(":")
    h.update(createHash("sha256").update(a.contentB64 ?? "").digest("hex")); h.update("\n")
  }
  return `sha:${h.digest("hex")}`
}

// ─── sender verification ─────────────────────────────────────────────────────────────────────────
export interface SenderVerdict {
  /** The From address is the counterparty the offer recorded (or an alias the agent recorded). */
  matchesRecorded: boolean
  /** Safe to read without asking the agent: the recorded counterparty AND the provider authenticated the domain. */
  trusted: boolean
  /** The provider reports an authentication FAILURE for this From — the message is not filed. */
  quarantine: boolean
  reason: string
}

/**
 * PURE — decide how far a reply's sender may be trusted. A reply can reach the offer by its token or its thread from a
 * DIFFERENT address (the listing agent's assistant, a transaction coordinator); that is allowed, and flagged, never trusted.
 */
export function verifyOutsideSender(input: {
  recordedEmail: string | null
  aliases?: string[]
  fromEmail: string
  senderAuth: "pass" | "fail" | "unknown" | null | undefined
}): SenderVerdict {
  const from = normalizeEmail(input.fromEmail)
  const known = new Set([normalizeEmail(input.recordedEmail), ...(input.aliases ?? []).map(normalizeEmail)].filter(Boolean))
  const matchesRecorded = !!from && known.has(from)
  const auth = input.senderAuth ?? "unknown"
  if (auth === "fail") {
    return { matchesRecorded, trusted: false, quarantine: true, reason: `the receiving provider reports that ${from || "the sender"} failed authentication (DMARC/DKIM/SPF) — the message may be spoofed` }
  }
  if (!matchesRecorded) {
    return { matchesRecorded, trusted: false, quarantine: false, reason: `${from || "the sender"} is not the listing agent recorded on this offer (${[...known][0] ?? "none recorded"}) — it reached the offer by its reference, so confirm who sent it` }
  }
  if (auth !== "pass") {
    return { matchesRecorded, trusted: false, quarantine: false, reason: `${from} matches the recorded listing agent, but the receiving provider did not authenticate the domain — confirm it before relying on it` }
  }
  return { matchesRecorded, trusted: true, quarantine: false, reason: `${from} is the recorded listing agent and the domain authenticated` }
}

// ─── reading a reply: the deterministic floor, the AI's reading, and their reconciliation ────────────

/** PURE: the reply's OWN words — quoted history (our own offer, "Please accept…") is stripped so it cannot read as the seller's. */
export function ownWords(subject: string | null | undefined, body: string | null | undefined): string {
  let text = (body ?? "").replace(/\r/g, "")
  const cuts = [/^On .{0,240}wrote:\s*$/im, /^-{2,}\s*Original Message\s*-{2,}/im, /^From:\s.+\n(?:Sent|Date):\s/im, /^_{5,}\s*$/m]
  for (const c of cuts) {
    const m = text.match(c)
    if (m && m.index !== undefined) text = text.slice(0, m.index)
  }
  text = text.split("\n").filter((l) => !/^\s*>/.test(l)).join("\n")
  return `${(subject ?? "").replace(/^\s*(re|fw|fwd):\s*/gi, "")}\n${text}`.slice(0, 20_000)
}

export interface ReplySignals { acceptance: boolean; counter: boolean; decline: boolean }

const NEGATED_ACCEPT = /\b(?:not|never|cannot|can't|can not|won't|will not|unable to|unwilling to|decline to)\s+(?:be\s+)?(?:accept|accepting)/i
const ACCEPTED_ANOTHER = /\baccept(?:ed|ing)\s+(?:an?|another|the)\s+(?:other\s+|different\s+)?offer\b|\bunder contract with (?:another|a different)\b|\bhas (?:already )?(?:been )?(?:sold|accepted another)\b/i
const ACCEPT = /\b(?:accept(?:ed|s|ing)?|fully executed|ratif(?:y|ied)|agree(?:d|s)? to (?:the )?(?:terms|offer))\b/i
const COUNTER = /\bcounter(?:\s*-?\s*offer(?:ed|ing)?|ed|ing|proposal)?\b|\bnew terms\b|\bamend(?:ed|ment|ments)\b|\brevised (?:offer|terms)\b|\bhighest and best\b|\bbest and final\b|\bmultiple offers\b/i
const DECLINE = /\bdecline[ds]?\b|\breject(?:ed|s|ing)?\b|\bnot (?:interested|moving forward|accepting)\b|\bno longer available\b|\bwithdrawn\b|\bwill not (?:be )?(?:consider|proceed)/i
const CONDITIONAL = /\b(?:subject to|contingent (?:on|upon)|provided that|as long as|with the following (?:changes|terms|conditions)|except (?:for|that)|but\b|however\b|if (?:the|you|your))\b/i

/**
 * PURE — the DETERMINISTIC floor: which of {acceptance, counter, decline} the reply's own words signal. It is deliberately
 * dumb and conservative; its job is to catch the model contradicting plain words, not to replace it. A conditional acceptance
 * ("accepted, but…") raises the counter signal too — it is not an acceptance.
 */
export function deterministicReplySignals(subject: string | null | undefined, body: string | null | undefined): ReplySignals {
  const text = ownWords(subject, body)
  const negated = NEGATED_ACCEPT.test(text)
  const another = ACCEPTED_ANOTHER.test(text)
  const accept = ACCEPT.test(text) && !negated && !another
  const conditional = accept && CONDITIONAL.test(text)
  return { acceptance: accept, counter: COUNTER.test(text) || conditional, decline: DECLINE.test(text) || negated || another }
}

/** The single class the signals name, or `ambiguous` (none, or more than one). */
function classOfSignals(s: ReplySignals): OutsideReplyClass {
  const on = (["acceptance", "counter", "decline"] as const).filter((k) => s[k])
  return on.length === 1 ? on[0] : "ambiguous"
}

export interface ReplyReading {
  classification: OutsideReplyClass
  /** 0..1 as the model reported it; null when the model did not. */
  confidence: number | null
  summary: string
  /** Verbatim quotes from the reply the classification rests on. */
  evidence: string[]
  /** Terms the reply STATES (offer_price, closing_date, …). A term the reply does not state is absent, never defaulted. */
  terms: Record<string, unknown>
  /** What the reply attached, as the model saw it. */
  attachments: Array<{ fileName: string; role: string }>
  questions: string[]
}

/** PURE: parse the model's JSON into a ReplyReading, or null. Never throws; an unknown class is `ambiguous`, never guessed. */
export function parseReplyReading(text: string | null | undefined): ReplyReading | null {
  if (!text) return null
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  let raw: any
  try { raw = JSON.parse(cleaned) } catch { return null }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const cls = (OUTSIDE_REPLY_CLASSES as readonly string[]).includes(String(raw.classification)) ? (raw.classification as OutsideReplyClass) : "ambiguous"
  const conf = typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : null
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => (x as string).trim().slice(0, 400)).slice(0, 12) : [])
  const terms: Record<string, unknown> = {}
  if (raw.terms && typeof raw.terms === "object" && !Array.isArray(raw.terms)) {
    for (const [k, v] of Object.entries(raw.terms as Record<string, unknown>)) {
      if (v === null || v === undefined || v === "") continue // a term the reply does not state is ABSENT (rule 3)
      if (["string", "number", "boolean"].includes(typeof v) || Array.isArray(v)) terms[k] = v
    }
  }
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments.filter((a: any) => a && typeof a.fileName === "string").map((a: any) => ({ fileName: String(a.fileName).slice(0, 200), role: typeof a.role === "string" ? a.role.slice(0, 40) : "other" })).slice(0, 12)
    : []
  return { classification: cls, confidence: conf, summary: typeof raw.summary === "string" ? raw.summary.slice(0, 600) : "", evidence: strs(raw.evidence), terms, attachments, questions: strs(raw.questions) }
}

export interface ReconciledReading {
  classification: OutsideReplyClass
  recommendedAction: OutsideRecommendedAction
  /** Why the class is not the model's, when it was lowered (rule 2). */
  downgrades: string[]
}

/** The minimum model confidence for an acceptance. Below it, an acceptance is ambiguous. */
export const ACCEPTANCE_MIN_CONFIDENCE = 0.7

/**
 * PURE — THE RULE (2): reconcile the model's reading with the deterministic floor and the attachments.
 *   · the model unavailable → the floor's single signal, else ambiguous;
 *   · the model and the floor disagree (the floor signalled exactly one class) → ambiguous;
 *   · ACCEPTANCE needs the model's acceptance, the floor's acceptance, confidence ≥ 0.7 and a PDF attached — otherwise it
 *     is ambiguous and the action is `request_signed_document` (a claimed acceptance with no contract is not an acceptance);
 *   · a COUNTER with no document is still a counter, but the action is to ask for the signed counter, not to record one.
 * It cannot RAISE a class: a downgrade is the only direction it moves.
 */
export function reconcileReplyClassification(input: {
  signals: ReplySignals
  reading: ReplyReading | null
  pdfCount: number
}): ReconciledReading {
  const floor = classOfSignals(input.signals)
  const downgrades: string[] = []
  let cls: OutsideReplyClass
  if (!input.reading) {
    cls = floor
    downgrades.push("the AI reading was unavailable — classified from the reply's plain words only")
  } else if (floor !== "ambiguous" && input.reading.classification !== floor) {
    cls = "ambiguous"
    downgrades.push(`the AI read this as ${input.reading.classification} but the reply's own words signal ${floor} — disagreement is ambiguity`)
  } else if (floor === "ambiguous" && input.reading.classification === "acceptance") {
    cls = "ambiguous"
    downgrades.push("the AI read acceptance but the reply's own words do not clearly accept")
  } else {
    cls = input.reading.classification
  }
  if (cls === "acceptance") {
    if (input.pdfCount === 0) { cls = "ambiguous"; downgrades.push("acceptance claimed with no signed contract attached — an acceptance is the signed contract, not a sentence") }
    else if (input.reading && (input.reading.confidence ?? 0) < ACCEPTANCE_MIN_CONFIDENCE) { cls = "ambiguous"; downgrades.push(`acceptance read with confidence ${input.reading.confidence ?? "n/a"} (< ${ACCEPTANCE_MIN_CONFIDENCE})`) }
    else if (!input.reading) { cls = "ambiguous"; downgrades.push("acceptance cannot be confirmed without the AI reading of the attached contract") }
  }
  return { classification: cls, recommendedAction: recommendedActionFor(cls, input.pdfCount > 0, downgrades.some((d) => /no signed contract/.test(d))), downgrades }
}

/** PURE: the next action for the agent — a recommendation, never a state change. */
function recommendedActionFor(cls: OutsideReplyClass, hasDocument: boolean, claimedAcceptanceWithoutDocument = false): OutsideRecommendedAction {
  switch (cls) {
    case "acceptance": return "record_acceptance"
    case "counter": return hasDocument ? "record_counter" : "request_signed_document"
    case "decline": return "record_decline"
    case "ambiguous": return claimedAcceptanceWithoutDocument ? "request_signed_document" : "request_clarification"
    case "acknowledgement": return "file_only"
    default: return hasDocument ? "review_manually" : "file_only"
  }
}

// ─── the chain: root, head, and which message a reply answers ────────────────────────────────────────
export interface ChainRow {
  id: string
  parent_offer_id: string | null
  current_round: number | null
  offer_type?: string | null
  status?: string | null
  created_at?: string | null
}

/** PURE: the chain's original offer (no parent). */
function chainRootOf(rows: ChainRow[]): ChainRow | null {
  return rows.find((r) => !r.parent_offer_id) ?? null
}

/** PURE: the newest row of the chain — the one an answer is an answer TO (highest round, then latest). */
function chainHeadOf(rows: ChainRow[]): ChainRow | null {
  if (rows.length === 0) return null
  return [...rows].sort((a, b) => (b.current_round ?? 1) - (a.current_round ?? 1) || String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0]
}

export type OutsideTarget =
  | { kind: "matched"; rootId: string; how: "token" | "thread" | "sender" }
  | { kind: "ambiguous"; rootIds: string[] }
  | { kind: "none" }

/** PURE — the order a reply is matched to an offer: its reference token, then its thread, then the sender; >1 by sender refuses. */
export function pickOutsideTarget(input: { byToken: string | null; byThread: string | null; bySender: string[] }): OutsideTarget {
  if (input.byToken) return { kind: "matched", rootId: input.byToken, how: "token" }
  if (input.byThread) return { kind: "matched", rootId: input.byThread, how: "thread" }
  const uniq = [...new Set(input.bySender)]
  if (uniq.length === 1) return { kind: "matched", rootId: uniq[0], how: "sender" }
  if (uniq.length > 1) return { kind: "ambiguous", rootIds: uniq }
  return { kind: "none" }
}

// ─── the outbound rules ──────────────────────────────────────────────────────────────────────────────
export interface OutboundDoc { id: string; name: string; classification: string | null; linkedOfferId: string | null; storageUrl: string | null }

export type OutboundDecision = { ok: true } | { ok: false; reason: string }

/**
 * PURE — may these documents leave for the outside listing agent? (rules 6 and 7)
 *   · an offer PACKET: the offer is on an outside property (no listings row), the buyer has signed, every document is linked
 *     to THIS offer, and the recipient is verified;
 *   · a COUNTER-BACK: every document is linked to the COUNTER ROW ITSELF — never to the original offer or an earlier round —
 *     because the owner's rule is "ONLY the counter is sent".
 */
export function decideOutsideSend(input: {
  kind: "offer_packet" | "counter_back"
  offer: { id: string; listing_id: string | null }
  buyerSigned: boolean
  recipient: { email: string; verifiedBy: OutsideRecipientVerification | null }
  documents: OutboundDoc[]
}): OutboundDecision {
  if (input.offer.listing_id) return { ok: false, reason: "this offer is on an in-house listing — the outside-listing loop does not apply" }
  if (!isEmailShape(input.recipient.email)) return { ok: false, reason: `"${input.recipient.email}" is not a usable email address` }
  if (!input.recipient.verifiedBy) return { ok: false, reason: "the listing agent's address is not verified — it must match the MLS-published listing agent or be confirmed by you before anything is sent" }
  if (input.documents.length === 0) return { ok: false, reason: input.kind === "counter_back" ? "attach the counter-offer document — a counter-back sends only the counter" : "attach the offer packet documents" }
  if (!input.buyerSigned) return { ok: false, reason: input.kind === "counter_back" ? "the buyer has not signed the counter-offer document yet — a counter-back leaves only once the buyer's signature is on it" : "the buyer has not signed the offer packet yet" }
  const wrong = input.documents.filter((d) => d.linkedOfferId !== input.offer.id)
  if (wrong.length > 0) {
    return {
      ok: false,
      reason: input.kind === "counter_back"
        ? `${wrong.map((d) => d.name).join(", ")} ${wrong.length === 1 ? "is" : "are"} not part of this counter — a counter-back sends ONLY the counter document(s), never the original offer or an earlier round`
        : `${wrong.map((d) => d.name).join(", ")} ${wrong.length === 1 ? "is" : "are"} not filed to this offer`,
    }
  }
  const unsendable = input.documents.filter((d) => !parseSignedStorageUrl(d.storageUrl))
  if (unsendable.length > 0) return { ok: false, reason: `${unsendable.map((d) => d.name).join(", ")} cannot be shared by a secure link (not in platform storage)` }
  return { ok: true }
}

export interface OutsideEmail { subject: string; html: string; text: string }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/**
 * PURE — the transactional email to the outside listing agent. Plain facts, the reference token in the subject (so a reply
 * carries it back), secure expiring links to the documents, and nothing about price or terms in the body (those live in the
 * documents the agent signs). No marketing, no fair-housing-sensitive content: this is correspondence about a contract.
 */
export function buildOutsideEmail(input: {
  kind: "offer_packet" | "counter_back"
  offerId: string
  propertyAddress: string
  round: number
  fromAgentName: string
  brokerageName: string | null
  documents: Array<{ name: string; url: string }>
  linkDays: number
  note?: string | null
}): OutsideEmail {
  const what = input.kind === "counter_back" ? `Counter-offer (round ${input.round})` : "Offer"
  const subject = `${what} — ${input.propertyAddress} ${outsideOfferToken(input.offerId)}`
  const intro = input.kind === "counter_back"
    ? `Attached is our buyer's counter-offer (round ${input.round}) on ${input.propertyAddress}. This email contains only the counter-offer.`
    : `On behalf of my buyer, please find our offer on ${input.propertyAddress}.`
  const ask = input.kind === "counter_back"
    ? "Please reply with your client's acceptance, counter-offer or decision, with the signed documents attached."
    : "Please reply with your client's acceptance, counter-offer or decision, with the signed documents (and any addenda) attached."
  const note = input.note?.trim() ? `\n\n${input.note.trim()}` : ""
  const lines = input.documents.map((d) => `• ${d.name}: ${d.url}`)
  const text = `${intro}${note}\n\nDocuments (secure links, valid ${input.linkDays} days):\n${lines.join("\n")}\n\n${ask}\n\n${input.fromAgentName}${input.brokerageName ? `\n${input.brokerageName}` : ""}\n\nReference: ${outsideOfferToken(input.offerId)} (please keep this in the subject of your reply)`
  const html = `<p>${esc(intro)}</p>${input.note?.trim() ? `<p>${esc(input.note.trim())}</p>` : ""}<p>Documents (secure links, valid ${input.linkDays} days):</p><ul>${input.documents.map((d) => `<li><a href="${esc(d.url)}">${esc(d.name)}</a></li>`).join("")}</ul><p>${esc(ask)}</p><p>${esc(input.fromAgentName)}${input.brokerageName ? `<br/>${esc(input.brokerageName)}` : ""}</p><p style="color:#666;font-size:12px">Reference: ${esc(outsideOfferToken(input.offerId))} — please keep this in the subject of your reply.</p>`
  return { subject, html, text }
}

// ─── I/O: the chain and the ledger (tenant-pinned, error-read, counted) ──────────────────────────────

export interface OutsideChain {
  root: ChainRow & { listing_id: string | null; agent_id: string | null; contact_id: string | null; property_address: string | null; metadata: Record<string, any> | null }
  rows: Array<ChainRow & { listing_id: string | null; agent_id: string | null; contact_id: string | null; property_address: string | null; metadata: Record<string, any> | null }>
  head: ChainRow
}

/** Read the whole chain an offer belongs to — up to its root, then every descendant — inside the tenant. A refused read is a returned reason. */
export async function loadOutsideChain(svc: Svc, brokerageId: string, anyOfferId: string): Promise<{ ok: true; chain: OutsideChain } | { ok: false; reason: string }> {
  const cols = "id, parent_offer_id, current_round, offer_type, status, created_at, listing_id, agent_id, contact_id, property_address, metadata"
  let cur = anyOfferId
  let rootRow: any = null
  for (let i = 0; i < 20; i++) {
    const { data, error } = await svc.from("offers").select(cols).eq("id", cur).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { ok: false, reason: `offer read refused: ${error.message}` }
    if (!data) return { ok: false, reason: "no such offer in this brokerage" }
    rootRow = data
    if (!(data as any).parent_offer_id) break
    cur = (data as any).parent_offer_id as string
  }
  if (!rootRow || rootRow.parent_offer_id) return { ok: false, reason: "the offer chain has no root within 20 rounds" }
  const rows: any[] = [rootRow]
  let frontier = [rootRow.id as string]
  for (let depth = 0; depth < 20 && frontier.length > 0; depth++) {
    const { data, error } = await svc.from("offers").select(cols).in("parent_offer_id", frontier).eq("brokerage_id", brokerageId)
    if (error) return { ok: false, reason: `offer chain read refused: ${error.message}` }
    const kids = (data ?? []) as any[]
    rows.push(...kids)
    frontier = kids.map((k) => k.id as string)
  }
  // the chain's root and head are named by the two pickers over the rows actually collected, not assumed from the walk
  const root = chainRootOf(rows) as OutsideChain["root"] | null
  const head = chainHeadOf(rows)
  if (!root || !head) return { ok: false, reason: "empty chain" }
  return { ok: true, chain: { root, rows, head } }
}

export interface InboundClaim {
  brokerageId: string
  rootOfferId: string
  headOfferId: string
  messageKey: string
  fromEmail: string
  subject: string | null
  senderAuth: "pass" | "fail" | "unknown"
  status: OutsideMessageStatus
  receivedAt: string
  reading?: Record<string, unknown>
}

/** CLAIM an inbound message (rule 5). The unique key makes a redelivery a `duplicate`, not a second row. */
export async function claimInboundMessage(svc: Svc, c: InboundClaim): Promise<{ ok: true; id: string } | { ok: true; duplicate: true } | { ok: false; reason: string }> {
  const { data, error } = await svc
    .from("outside_offer_messages")
    .insert({
      brokerage_id: c.brokerageId, offer_id: c.rootOfferId, head_offer_id: c.headOfferId, direction: "inbound", kind: "seller_reply",
      message_key: c.messageKey, counterparty_email: normalizeEmail(c.fromEmail), sender_auth: c.senderAuth, subject: c.subject,
      received_at: c.receivedAt, status: c.status, reading: c.reading ?? {},
    })
    .select("id")
  if (error) {
    if (error.code === "23505") return { ok: true, duplicate: true }
    return { ok: false, reason: `outside_offer_messages claim refused: ${error.message}` }
  }
  const id = ((data ?? [])[0] as { id?: string } | undefined)?.id
  return id ? { ok: true, id } : { ok: false, reason: "outside_offer_messages claim matched no row" }
}

/** Patch a ledger row, pinned to the tenant, and COUNT it (an update matching nothing resolves like one that worked, §3). */
export async function patchMessage(svc: Svc, brokerageId: string, id: string, patch: Record<string, unknown>): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { data, error } = await svc.from("outside_offer_messages").update(patch).eq("id", id).eq("brokerage_id", brokerageId).select("id")
  if (error) return { ok: false, reason: `outside_offer_messages update refused: ${error.message}` }
  if (!data || data.length === 0) return { ok: false, reason: "outside_offer_messages update matched no row (wrong tenant?)" }
  return { ok: true }
}

/** Merge the loop's pointers into the ROOT offer's metadata (read-modify-write: the wholesale assignment that destroyed linked_offer_id is the defect this avoids). */
export async function mergeLoopState(svc: Svc, brokerageId: string, rootOfferId: string, patch: Record<string, unknown>, topLevel: Record<string, unknown> = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { data, error } = await svc.from("offers").select("metadata").eq("id", rootOfferId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, reason: `offer read refused: ${error.message}` }
  if (!data) return { ok: false, reason: "no such offer in this brokerage" }
  const meta = ((data as { metadata?: Record<string, any> | null }).metadata ?? {}) as Record<string, any>
  const next = { ...meta, ...topLevel, [OUTSIDE_LOOP_KEY]: { ...(meta[OUTSIDE_LOOP_KEY] ?? {}), ...patch }, updated_loop_at: new Date().toISOString() }
  const { data: upd, error: uErr } = await svc.from("offers").update({ metadata: next, updated_at: new Date().toISOString() }).eq("id", rootOfferId).eq("brokerage_id", brokerageId).select("id")
  if (uErr) return { ok: false, reason: `offer metadata write refused: ${uErr.message}` }
  if (!upd || upd.length === 0) return { ok: false, reason: "offer metadata write matched no row" }
  return { ok: true }
}

// ─── recipient verification against the MLS-published listing agent ─────────────────────────────────────

export type RecipientLookup = (input: { brokerageId: string; propertyAddress: string }) => Promise<{ ok: true; agentEmails: string[]; officeEmails: string[]; mlsNumber: string | null } | { ok: false; reason: string }>

/** Default lookup: RentCast's for-sale index by the property's postal address (the single-home query mode) — the listing's PUBLISHED agent / office contact. */
const rentcastRecipientLookup: RecipientLookup = async ({ brokerageId, propertyAddress }) => {
  try {
    const { searchRentcastSaleListings } = await import("@/lib/property/rentcast")
    const r = await searchRentcastSaleListings({ brokerageId, filters: { address: propertyAddress } })
    if (!r.success) return { ok: false, reason: r.error ?? "RentCast did not answer" }
    const listings = r.listings ?? []
    return {
      ok: true,
      agentEmails: listings.map((l) => normalizeEmail(l.listingAgent?.email)).filter(Boolean),
      officeEmails: listings.map((l) => normalizeEmail(l.listingOffice?.email)).filter(Boolean),
      mlsNumber: listings[0]?.mlsNumber ?? null,
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Is `recipientEmail` the listing agent the MLS PUBLISHED for this property? Only an exact match to the published AGENT address
 * verifies (the office's general address does not — a front desk is not the listing agent). `verified: false` is a fact about
 * the lookup, not an accusation: the agent can still confirm the recipient themselves (agent_confirmed).
 */
export async function verifyRecipientAgainstMls(
  input: { brokerageId: string; propertyAddress: string; recipientEmail: string },
  lookup: RecipientLookup = rentcastRecipientLookup,
): Promise<{ verified: boolean; reason: string; publishedAgentEmails: string[] }> {
  const r = await lookup({ brokerageId: input.brokerageId, propertyAddress: input.propertyAddress })
  if (!r.ok) return { verified: false, reason: `the MLS-published listing agent could not be looked up (${r.reason})`, publishedAgentEmails: [] }
  const want = normalizeEmail(input.recipientEmail)
  if (r.agentEmails.includes(want)) return { verified: true, reason: "matches the listing agent published on the MLS", publishedAgentEmails: r.agentEmails }
  if (r.agentEmails.length === 0) return { verified: false, reason: "the MLS publishes no listing-agent email for this property", publishedAgentEmails: [] }
  return { verified: false, reason: `the MLS publishes a different listing-agent email (${r.agentEmails[0]})`, publishedAgentEmails: r.agentEmails }
}
