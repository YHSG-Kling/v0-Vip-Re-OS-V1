/**
 * lib/esign/addendum-signature-rules.ts — THE RULES OF A SIGNATURE REQUEST ON A PROPOSED ADDENDUM (wave 152, lane 152F). PURE.
 *
 * Owner (verbatim, wave 152): "the requested signatures on a proposed addendum door needs to be built as it says not implemented."
 *
 * No I/O and no server import, so the addendum panel (a client component) renders the same words the door decides with. The I/O
 * half is lib/esign/addendum-signature-request.ts; the door is app/actions/buyer-offer/request-addendum-signatures.ts.
 *
 * ── THE SURVIVORS THIS EXTENDS (CLAUDE.md §1) ─────────────────────────────────────────────────────────────────────────────
 *   · the request record is public.signature_requests (m953 links it to the proposed contract_term_versions row) — its column
 *     vocabulary is SIGNATURE_REQUEST_STATUSES below, the ONE code source of signature_requests_request_status_check;
 *   · the provider outcome words come from lib/esign/packet-states.ts providerTerminalState (declined / voided / expired) —
 *     re-used, not re-read;
 *   · "a represented principal is reached directly; an outside principal is reached through their own agent" is the rule
 *     lib/notifications/notify-helpers.ts notifyTransactionParties already applies ("represented by another brokerage — their own
 *     agent notifies them; direct contact would bypass their representation"). The signer routing below applies the SAME rule to a
 *     signature: the platform never puts another brokerage's client in its envelope.
 */

import { providerTerminalState } from "./packet-states"

// ─── THE COLUMN VOCABULARY (m953) ──────────────────────────────────────────────────────────────────────────────────────────

/** signature_requests.request_status — the live CHECK plus m953's two additions (declined, failed). ONE source. */
export const SIGNATURE_REQUEST_STATUSES = ["pending", "sent", "partially_signed", "completed", "cancelled", "expired", "declined", "failed"] as const
export type SignatureRequestStatus = (typeof SIGNATURE_REQUEST_STATUSES)[number]

/** The open statuses — exactly the m953 partial unique index (one live request per proposed version) and the statuses
 *  lib/transactions/final-compliance-check.ts counts as an open closing item. */
export const LIVE_SIGNATURE_REQUEST_STATUSES = ["pending", "sent", "partially_signed"] as const satisfies readonly SignatureRequestStatus[]

const RANK: Readonly<Record<SignatureRequestStatus, number>> = Object.freeze({
  pending: 0, sent: 1, partially_signed: 2, completed: 3, cancelled: 9, expired: 9, declined: 9, failed: 9,
})

export const isLiveSignatureRequest = (s: string | null | undefined): boolean => (LIVE_SIGNATURE_REQUEST_STATUSES as readonly string[]).includes(String(s ?? ""))

/**
 * PURE — only UP the ladder. Equal = an idempotent no-op (a redelivered webhook). A completed request and a terminal failure are
 * never overwritten (a void after completion is refused; a late "viewed" after a decline writes nothing). Any live request may
 * end in a terminal failure.
 */
export function canAdvanceSignatureRequest(from: string | null | undefined, to: SignatureRequestStatus): { ok: true; noop: boolean } | { ok: false; reason: string } {
  if (!(SIGNATURE_REQUEST_STATUSES as readonly string[]).includes(to)) return { ok: false, reason: `'${String(to)}' is not a signature request status` }
  if (from === to) return { ok: true, noop: true }
  const f = (SIGNATURE_REQUEST_STATUSES as readonly string[]).includes(String(from)) ? RANK[from as SignatureRequestStatus] : -1
  if (f >= RANK.completed) return { ok: false, reason: `the request is already ${from} — a finished request is never reopened; make a new request` }
  if (RANK[to] < f) return { ok: false, reason: `a request does not move back from ${from} to ${to}` }
  return { ok: true, noop: false }
}

/**
 * PURE — what a provider event means for the request (the owner's words → the column's spelling). "Delivered" and "viewed" are
 * NOT statuses: the request stays `sent` and the instant is stamped in evidence (every open-status reader keeps matching it); the
 * provider's "voided" is this table's `cancelled`; a bounced / undeliverable recipient is `failed` (the request cannot complete as
 * sent — correct the address and send a new request). A completion word returns null: completion is decided by reading the
 * provider's signer list (syncAddendumSignatureRequest), never by the event name.
 */
export function providerEventOutcome(event: string | null | undefined, status: string | null | undefined): { to: SignatureRequestStatus | null; stamp: "delivered_at" | "viewed_at" | null } {
  const text = `${event ?? ""} ${status ?? ""}`.toLowerCase()
  const terminal = providerTerminalState(event, status)
  if (terminal === "voided") return { to: "cancelled", stamp: null }
  if (terminal) return { to: terminal, stamp: null }
  if (/autorespond|bounce|undeliver|delivery[ _.-]?fail|authentication[ _.-]?fail/.test(text)) return { to: "failed", stamp: null }
  if (/complet|signed/.test(text)) return { to: null, stamp: null }
  if (/view|open/.test(text)) return { to: null, stamp: "viewed_at" }
  if (/deliver/.test(text)) return { to: null, stamp: "delivered_at" }
  return { to: null, stamp: null }
}

// ─── WHO MUST SIGN ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type AddendumSide = "buyer" | "seller"
type PrincipalRole = "buyer" | "co_buyer" | "seller" | "co_seller"

export interface AddendumPrincipal { side: AddendumSide; role: PrincipalRole; name: string | null; email: string | null; source: "contact" | "participant" | "entered" }
export interface CounterpartyAgent { side: AddendumSide; name: string | null; email: string | null; verified: boolean }

export interface AddendumRoutingInput {
  /** The sides this brokerage REPRESENTS (a contact FK on the deal) — their principals sign in our envelope. */
  representedSides: AddendumSide[]
  principals: AddendumPrincipal[]
  /** The agent of a side this brokerage does NOT represent — that side signs through them, never directly. */
  counterpartyAgents: CounterpartyAgent[]
  attorneys: Array<{ name: string | null; email: string | null; role: string }>
  includeAttorneys: boolean
  /** The terms the proposed addendum changes (contract-term vocabulary keys). */
  changedTermKeys: string[]
  /** The sending user's own address: never the signer for a client. */
  senderEmail: string | null
  /** A broker's approval already recorded on the proposal (evidence.broker_approval). */
  brokerApproval: { approvedBy: string; approvedAt: string } | null
  /** The sender holds the brokerage-finance admin role, so their send IS the approval. */
  senderMayApproveCommission: boolean
  /** The sender confirmed an outside agent's address the platform has not verified. */
  confirmedCounterpartyAgent: boolean
}

interface AddendumRecipient { order: number; side: AddendumSide | null; role: string; name: string; email: string; kind: "party_signature" | "attorney_review" }
interface AddendumRequirement { side: AddendumSide; role: string; route: "envelope" | "counterparty_agent"; email: string | null }
interface AddendumBlocker { code: "missing_signer" | "invalid_email" | "duplicate_signer" | "sender_is_signer" | "no_counterparty_route" | "counterparty_unverified" | "broker_approval_required" | "no_represented_party"; message: string }
export interface AddendumRoutingPlan {
  /** Our envelope, in signing order (the provider routes by position — see `signingOrder`). */
  recipients: AddendumRecipient[]
  /** Sides that sign through their own agent after our side signs. */
  routed: Array<{ side: AddendumSide; agentName: string | null; agentEmail: string; verified: boolean }>
  /** Every signature the addendum needs before it can be EXECUTED (attorneys and approvals are not party signatures). */
  required: AddendumRequirement[]
  approvals: Array<{ kind: "broker_approval"; reason: string; satisfied: boolean }>
  blockers: AddendumBlocker[]
  /** Sequential by listed position: the provider contract carries no parallel routing (DocuSign's adapter numbers routingOrder by position). */
  signingOrder: "sequential"
  ready: boolean
}

/** The message contract's opening line for an addendum that cannot go yet (charter: tenant-facing copy). */
export const SELECT_SIGNERS_MESSAGE = "Select the required signing parties before sending this addendum."

/** Terms that move the brokerage's money: a change to them is the broker's decision before it goes out for signature. */
const COMMISSION_TERM_KEYS = ["buyer_agent_commission_pct", "buyer_agent_commission_flat", "commission_payer"] as const

const EMAIL_SHAPE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i
const norm = (e: string | null | undefined) => String(e ?? "").trim().toLowerCase()
const label = (role: string) => role.replace(/_/g, " ")

/**
 * PURE — THE SIGNER ROUTING. Decides who signs, through what route, in what order, and what must happen before anything is sent.
 * Never assumes "buyer + seller in one envelope": a represented side's principals sign in our envelope; a side represented by
 * another brokerage signs through its own agent after ours (the representation rule above); attorneys review and are never a
 * party signature; a change to the brokerage's commission terms is held for the broker. Every refusal is a tenant-facing sentence.
 */
export function planAddendumSignatureRouting(input: AddendumRoutingInput): AddendumRoutingPlan {
  const blockers: AddendumBlocker[] = []
  const recipients: AddendumRecipient[] = []
  const routed: AddendumRoutingPlan["routed"] = []
  const required: AddendumRequirement[] = []
  const sender = norm(input.senderEmail)
  const sides: AddendumSide[] = ["buyer", "seller"]
  let order = 0

  if (input.representedSides.length === 0) {
    blockers.push({ code: "no_represented_party", message: `${SELECT_SIGNERS_MESSAGE} This brokerage represents neither side on file for this contract, so there is no client to send it to.` })
  }

  for (const side of sides) {
    if (input.representedSides.includes(side)) {
      const principals = input.principals.filter((p) => p.side === side)
      if (principals.length === 0) {
        blockers.push({ code: "missing_signer", message: `${SELECT_SIGNERS_MESSAGE} No ${side} is on file for this contract — add the ${side} to the deal.` })
        continue
      }
      order++
      for (const p of principals) {
        const email = norm(p.email)
        const who = p.name?.trim() || label(p.role)
        if (!email) { blockers.push({ code: "missing_signer", message: `${SELECT_SIGNERS_MESSAGE} ${who} (${label(p.role)}) has no email address — add it on their contact record.` }); continue }
        if (!EMAIL_SHAPE.test(email)) { blockers.push({ code: "invalid_email", message: `${SELECT_SIGNERS_MESSAGE} ${email} is not a usable email address for ${who}.` }); continue }
        if (sender && email === sender) { blockers.push({ code: "sender_is_signer", message: `${who} must sign from their own address — ${email} is yours, and nobody signs for a client.` }); continue }
        recipients.push({ order, side, role: p.role, name: who, email, kind: "party_signature" })
        required.push({ side, role: p.role, route: "envelope", email })
      }
    } else {
      const agent = input.counterpartyAgents.find((a) => a.side === side && norm(a.email))
      if (!agent) {
        blockers.push({ code: "no_counterparty_route", message: `${SELECT_SIGNERS_MESSAGE} The ${side} is represented by another brokerage, so the ${side}'s signature is requested through their agent — add that agent's email.` })
        continue
      }
      const email = norm(agent.email)
      if (!EMAIL_SHAPE.test(email)) { blockers.push({ code: "invalid_email", message: `${SELECT_SIGNERS_MESSAGE} ${email} is not a usable email address for the ${side}'s agent.` }); continue }
      if (!agent.verified && !input.confirmedCounterpartyAgent) {
        blockers.push({ code: "counterparty_unverified", message: `${email} has not been verified as the ${side}'s agent. Confirm it is their address before the ${side}'s signature is requested through them.` })
        continue
      }
      routed.push({ side, agentName: agent.name, agentEmail: email, verified: agent.verified })
      required.push({ side, role: side, route: "counterparty_agent", email })
    }
  }

  if (input.includeAttorneys) {
    for (const a of input.attorneys) {
      const email = norm(a.email)
      if (!email || !EMAIL_SHAPE.test(email)) continue // an attorney without an address is simply not copied — never a blocker
      recipients.push({ order: order + 1, side: null, role: a.role || "attorney", name: a.name?.trim() || "Attorney", email, kind: "attorney_review" })
    }
  }

  // one address, one party: the same mailbox cannot sign for two parties (or route a party AND sign as another)
  const seen = new Map<string, string>()
  for (const r of [...recipients.map((x) => ({ email: x.email, who: `${x.name} (${label(x.role)})` })), ...routed.map((x) => ({ email: x.agentEmail, who: `the ${x.side}'s agent` }))]) {
    const prior = seen.get(r.email)
    if (prior) blockers.push({ code: "duplicate_signer", message: `${r.email} is listed for both ${prior} and ${r.who} — one address cannot sign for two parties.` })
    else seen.set(r.email, r.who)
  }

  const approvals: AddendumRoutingPlan["approvals"] = []
  const commission = input.changedTermKeys.filter((k) => (COMMISSION_TERM_KEYS as readonly string[]).includes(k))
  if (commission.length > 0) {
    const satisfied = input.senderMayApproveCommission || !!input.brokerApproval
    approvals.push({ kind: "broker_approval", reason: `it changes ${commission.map(label).join(", ")}`, satisfied })
    if (!satisfied) blockers.push({ code: "broker_approval_required", message: `This addendum changes ${commission.map(label).join(", ")}, so your broker approves it before it goes out for signature. It is saved as proposed; a brokerage finance admin can approve it from this deal.` })
  }

  return { recipients, routed, required, approvals, blockers, signingOrder: "sequential", ready: blockers.length === 0 }
}

/**
 * PURE — which REQUIRED signatures the provider attests. Our-envelope requirements match a provider signer by address with a
 * signing instant; a routed side is never satisfied by our envelope (it comes back on the counter-signed copy). When the provider
 * reports no per-signer list, `allRecipientsSigned` (its own count: signed === total over our recipients) satisfies the envelope
 * requirements — still the provider's statement, never ours.
 */
export function requiredSignaturesFrom(required: AddendumRequirement[], providerSigners: Array<{ email: string | null; signedAt: string | null }>, allRecipientsSigned: boolean): { signed: AddendumRequirement[]; missing: AddendumRequirement[]; envelopeComplete: boolean } {
  const signedBy = new Set(providerSigners.filter((s) => s.signedAt && norm(s.email)).map((s) => norm(s.email)))
  const signed: AddendumRequirement[] = []
  const missing: AddendumRequirement[] = []
  for (const r of required) {
    const ok = r.route === "envelope" && (signedBy.has(norm(r.email)) || (signedBy.size === 0 && allRecipientsSigned))
    ;(ok ? signed : missing).push(r)
  }
  const envelope = required.filter((r) => r.route === "envelope")
  return { signed, missing, envelopeComplete: envelope.length > 0 && envelope.every((r) => signed.includes(r)) }
}

/** PURE — signer role as the document's signature reading names it (documents.signature_completeness, read by the recorder). */
export const signatureRoleOf = (role: string): "buyer" | "seller" | null => (role === "buyer" || role === "co_buyer" ? "buyer" : role === "seller" || role === "co_seller" ? "seller" : null)

// ─── WHAT THE TENANT SEES (the charter's message contract) ─────────────────────────────────────────────────────────────────

export type AddendumRequestDisplay = { label: string; tone: "neutral" | "progress" | "done" | "attention"; detail: string; action: string | null }

/**
 * PURE — one request, in plain words: what happened · what it affects · what was saved · who acts next · ONE action. No provider
 * strings, no credential or table names. `evidence` is the request's own record (m953).
 */
export function describeAddendumRequest(status: string, evidence: Record<string, unknown> | null | undefined): AddendumRequestDisplay {
  const ev = (evidence ?? {}) as Record<string, any>
  const awaitingRoute = ev.awaiting === "counterparty_agent"
  switch (status) {
    case "pending":
      if (ev.handoff_mode === "download") return { label: "Download and have it signed", tone: "attention", detail: "No e-signature connection is available, so nothing was sent from the platform. Each party signs the downloaded addendum; the contract changes only when the fully signed copy is filed here and recorded.", action: "File the fully signed copy" }
      return ev.handoff_mode
        ? { label: "Ready for you to send", tone: "attention", detail: "The addendum is staged in your e-sign window but has not been sent yet. Nothing is signed until each party signs it there.", action: "Open the e-sign window and press Send" }
        : { label: "Preparing", tone: "progress", detail: "The signature request is being prepared. Nothing has been sent yet.", action: null }
    case "sent":
      return {
        label: ev.viewed_at ? "Viewed by a signer" : ev.delivered_at ? "Delivered to the signers" : "Sent for signature",
        tone: "progress",
        detail: "The signers have the addendum. It does not change the contract until every required party has signed it and it has been recorded.",
        action: null,
      }
    case "partially_signed":
      return awaitingRoute
        ? { label: "Your client signed — waiting on the other side", tone: "attention", detail: "Your client's signature is on file. The other party is represented by another brokerage, so their signature comes back through their agent. The contract has not changed yet.", action: "Send the signed copy to their agent, then file the copy they return" }
        : { label: "Partly signed", tone: "progress", detail: "Some required parties have signed; the rest have not. The contract has not changed yet.", action: null }
    case "completed":
      return ev.executed_version_no
        ? { label: "Fully signed and recorded", tone: "done", detail: `Every required party signed. It is recorded as executed version ${ev.executed_version_no} and compliance re-checked the terms it changes.`, action: null }
        : { label: "Signed — held for review", tone: "attention", detail: `Every required party signed, but it was not recorded as executed: ${String(ev.record_refused ?? "a review is needed")}. The contract has not changed; the signed copy is saved.`, action: "Review it with compliance" }
    case "declined":
      return { label: "A signer declined", tone: "attention", detail: "A party declined to sign. The contract has not changed and nothing was recorded.", action: "Talk with the party, then propose a revised addendum" }
    case "cancelled":
      return { label: "Voided", tone: "neutral", detail: `This request was voided${ev.void_reason ? ` (${String(ev.void_reason)})` : ""}. Nothing it carried can be signed any more.`, action: null }
    case "expired":
      return { label: "Expired before it was signed", tone: "attention", detail: "The request expired before every required party signed. The contract has not changed.", action: "Send a new request" }
    case "failed":
      return { label: "Not sent", tone: "attention", detail: `The signature request did not go out${ev.failure ? `: ${String(ev.failure)}` : "."} Nothing was signed and the proposed addendum is still saved.`, action: "Fix what is named and send it again" }
    default:
      return { label: status, tone: "neutral", detail: "", action: null }
  }
}
