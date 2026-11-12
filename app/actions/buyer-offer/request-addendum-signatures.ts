"use server"

/**
 * app/actions/buyer-offer/request-addendum-signatures.ts — THE DOOR: REQUEST SIGNATURES ON A PROPOSED ADDENDUM (wave 152, lane 152F).
 *
 * Owner (verbatim, wave 152): "the requested signatures on a proposed addendum door needs to be built as it says not implemented."
 *
 * The sibling of record-contract-addendum.ts (which records an addendum ALREADY signed): here an addendum is PROPOSED, its signers
 * are reviewed, it goes out for signature through the tenant's e-sign route, and it becomes the executed version only when every
 * required party has signed and the contract record's checks pass. Every rule lives in lib/esign/addendum-signature-request.ts
 * (I/O) and lib/esign/addendum-signature-rules.ts (pure); this file is the session gate.
 *
 * Every export is a public endpoint (CLAUDE.md §4): async, the tenant is the SESSION's (requireCaller), inputs are validated, and
 * the service client is created only AFTER that gate. Nothing here signs, accepts or creates a transaction.
 */

import { requireCaller } from "@/lib/auth/require-caller"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import * as door from "@/lib/esign/addendum-signature-request"

type Ref = { offerId?: string; transactionId?: string }

async function gate(): Promise<{ ok: true; actor: door.AddendumActor } | { ok: false; error: string }> {
  const caller = await requireCaller()
  if (!caller.ok) return { ok: false, error: caller.error }
  return { ok: true, actor: { userId: caller.userId, brokerageId: caller.brokerageId, userType: caller.userType ?? null, teamId: caller.teamId ?? null } }
}

function refOf(p: Ref): { offerId: string } | { transactionId: string } | string {
  if (!!p.transactionId === !!p.offerId) return "Name the transaction OR an offer in the contract's chain — exactly one."
  if (p.transactionId) return isValidUUID(p.transactionId) ? { transactionId: p.transactionId } : "Invalid transaction ID"
  return isValidUUID(p.offerId as string) ? { offerId: p.offerId as string } : "Invalid offer ID"
}

const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00.000Z`).toISOString().slice(0, 10) === s

/** The party-review choices, trimmed to what the rules read. A side the brokerage does not represent is never given a signer here. */
function choicesOf(raw: unknown): door.AddendumPartyChoices {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const signers = Array.isArray(c.additionalSigners) ? c.additionalSigners.slice(0, 6) : []
  return {
    additionalSigners: signers
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .map((s) => ({ side: s.side === "seller" ? "seller" : "buyer", role: (["buyer", "co_buyer", "seller", "co_seller"].includes(String(s.role)) ? s.role : "co_buyer") as "buyer" | "co_buyer" | "seller" | "co_seller", name: String(s.name ?? "").slice(0, 120), email: String(s.email ?? "").slice(0, 200) })),
    counterpartyAgentEmail: typeof c.counterpartyAgentEmail === "string" ? c.counterpartyAgentEmail.slice(0, 200) : null,
    counterpartyAgentName: typeof c.counterpartyAgentName === "string" ? c.counterpartyAgentName.slice(0, 120) : null,
    confirmCounterpartyAgent: c.confirmCounterpartyAgent === true,
    includeAttorneys: c.includeAttorneys !== false,
    reminders: c.reminders !== false,
  }
}

/** PROPOSE an addendum / amendment: the unsigned document plus ONLY the terms it would change. It never governs until executed. */
export async function proposeContractAddendum(params: Ref & {
  kind: "addendum" | "amendment"
  documentId: string
  terms: Record<string, unknown>
  effectiveOn?: string | null
  termEvidence?: Record<string, { page?: number | null; field?: string | null; quote?: string | null }> | null
}): Promise<{ success: boolean; error?: string; versionId?: string; versionNo?: number }> {
  const g = await gate()
  if (!g.ok) return { success: false, error: g.error }
  const ref = refOf(params)
  if (typeof ref === "string") return { success: false, error: ref }
  if (params.kind !== "addendum" && params.kind !== "amendment") return { success: false, error: "Say whether this is an addendum or an amendment." }
  if (!isValidUUID(params.documentId)) return { success: false, error: "Upload the addendum document first." }
  if (!params.terms || typeof params.terms !== "object" || Array.isArray(params.terms) || Object.keys(params.terms).length === 0) return { success: false, error: "State the terms the addendum changes." }
  if (params.effectiveOn && !isDay(params.effectiveOn)) return { success: false, error: "Give the date the change takes effect as yyyy-mm-dd (or leave it empty)." }
  let termEvidence: Record<string, { page: number | null; field: string | null; quote: string | null }> | null = null
  if (params.termEvidence) {
    if (typeof params.termEvidence !== "object" || Array.isArray(params.termEvidence)) return { success: false, error: "Term evidence must map each changed term to its page / field / quote." }
    termEvidence = {}
    for (const [key, ev] of Object.entries(params.termEvidence)) {
      if (!(key in params.terms)) return { success: false, error: `Evidence names "${key}", which this addendum does not change.` }
      if (!ev || typeof ev !== "object") continue
      const page = ev.page == null ? null : Number(ev.page)
      if (page !== null && (!Number.isInteger(page) || page < 1)) return { success: false, error: `The page for "${key}" must be a whole number from 1.` }
      const field = typeof ev.field === "string" && ev.field.trim() ? ev.field.trim().slice(0, 120) : null
      const quote = typeof ev.quote === "string" && ev.quote.trim() ? ev.quote.trim().slice(0, 500) : null
      if (page !== null || field || quote) termEvidence[key] = { page, field, quote }
    }
  }
  const svc = createServiceClient()
  const r = await door.proposeContractAddendumVersion(svc as never, g.actor, { ref, kind: params.kind, documentId: params.documentId, terms: params.terms, effectiveOn: params.effectiveOn ?? null, termEvidence: termEvidence && Object.keys(termEvidence).length ? termEvidence : null })
  return r.ok ? { success: true, versionId: r.versionId, versionNo: r.versionNo } : { success: false, error: r.message }
}

/** Every proposed addendum on the contract, with its signature requests in plain words. */
export async function listAddendumSignatures(params: Ref): Promise<{ success: boolean; error?: string; proposals: Extract<Awaited<ReturnType<typeof door.listAddendumSignatureState>>, { ok: true }>["proposals"] }> {
  const g = await gate()
  if (!g.ok) return { success: false, error: g.error, proposals: [] }
  const ref = refOf(params)
  if (typeof ref === "string") return { success: false, error: ref, proposals: [] }
  const svc = createServiceClient()
  const r = await door.listAddendumSignatureState(svc as never, g.actor, ref)
  return r.ok ? { success: true, proposals: r.proposals } : { success: false, error: r.message, proposals: [] }
}

/** THE PARTY REVIEW: who signs, through what route, what is missing, and whether an e-sign route exists. Writes nothing. */
export async function reviewAddendumSignatureRequest(params: { versionId: string; choices?: door.AddendumPartyChoices }): Promise<{ success: boolean; error?: string; review?: door.AddendumReview }> {
  const g = await gate()
  if (!g.ok) return { success: false, error: g.error }
  if (!isValidUUID(params.versionId)) return { success: false, error: "Invalid addendum ID" }
  const svc = createServiceClient()
  const r = await door.reviewAddendumSignatures(svc as never, g.actor, { versionId: params.versionId, choices: choicesOf(params.choices) })
  return r.ok ? { success: true, review: r } : { success: false, error: r.message }
}

/** SEND FOR SIGNATURES. A replay returns the request already out — never a second envelope. */
export async function requestAddendumSignatures(params: { versionId: string; choices?: door.AddendumPartyChoices }): Promise<{ success: boolean; error?: string; state?: string; replayed?: boolean; requestId?: string; status?: string; label?: string; detail?: string; handoff?: { mode: "iframe" | "popup"; urls: Array<{ label: string; url: string }>; instructions: string } | null; retryable?: boolean }> {
  const g = await gate()
  if (!g.ok) return { success: false, error: g.error }
  if (!isValidUUID(params.versionId)) return { success: false, error: "Invalid addendum ID" }
  const svc = createServiceClient()
  const r = await door.requestAddendumSignatures(svc as never, g.actor, { versionId: params.versionId, choices: choicesOf(params.choices) })
  if (!r.ok) return { success: false, error: r.message, state: r.state, requestId: r.requestId, retryable: r.retryable }
  return { success: true, replayed: r.replayed, requestId: r.requestId, status: r.status, label: r.display.label, detail: r.display.detail, handoff: r.handoff ?? null }
}

/** DOWNLOAD AND HAND OFF: nothing is sent from the platform; the fully signed copy is filed here later. */
export async function startAddendumSignatureHandoff(params: { versionId: string }): Promise<{ success: boolean; error?: string; requestId?: string; label?: string; detail?: string }> {
  const g = await gate()
  if (!g.ok) return { success: false, error: g.error }
  if (!isValidUUID(params.versionId)) return { success: false, error: "Invalid addendum ID" }
  const svc = createServiceClient()
  const r = await door.startAddendumHandoff(svc as never, g.actor, { versionId: params.versionId })
  return r.ok ? { success: true, requestId: r.requestId, label: r.display.label, detail: r.display.detail } : { success: false, error: r.message }
}

/** A brokerage finance admin approves a proposal that changes commission terms (the hold-for-human). */
export async function approveAddendumForSignature(params: { versionId: string }): Promise<{ success: boolean; error?: string }> {
  const g = await gate()
  if (!g.ok) return { success: false, error: g.error }
  if (!isValidUUID(params.versionId)) return { success: false, error: "Invalid addendum ID" }
  const svc = createServiceClient()
  const r = await door.approveAddendumForSignature(svc as never, g.actor, { versionId: params.versionId })
  return r.ok ? { success: true } : { success: false, error: r.message }
}

/** VOID a request that is out (at the provider first). A changed addendum is a void + a new proposal, never an edit. */
export async function voidAddendumSignatureRequest(params: { requestId: string; reason: string }): Promise<{ success: boolean; error?: string; providerVoided?: boolean }> {
  const g = await gate()
  if (!g.ok) return { success: false, error: g.error }
  if (!isValidUUID(params.requestId)) return { success: false, error: "Invalid request ID" }
  const reason = String(params.reason ?? "").trim()
  if (!reason) return { success: false, error: "Say why it is being voided — the signers' e-sign provider shows the reason." }
  const svc = createServiceClient()
  const r = await door.voidAddendumSignatureRequest(svc as never, g.actor, { requestId: params.requestId, reason })
  return r.ok ? { success: true, providerVoided: r.providerVoided } : { success: false, error: r.message }
}

/** WITHDRAW a proposal (its live request is voided first). The history keeps it. */
export async function withdrawProposedAddendum(params: { versionId: string; reason: string }): Promise<{ success: boolean; error?: string }> {
  const g = await gate()
  if (!g.ok) return { success: false, error: g.error }
  if (!isValidUUID(params.versionId)) return { success: false, error: "Invalid addendum ID" }
  const reason = String(params.reason ?? "").trim()
  if (!reason) return { success: false, error: "Say why the proposal is withdrawn." }
  const svc = createServiceClient()
  const r = await door.withdrawProposedAddendum(svc as never, g.actor, { versionId: params.versionId, reason })
  return r.ok ? { success: true } : { success: false, error: r.message }
}

/** FILE THE FULLY SIGNED COPY (returned by the other side's agent, signed from your own Drive, or a held request retried). */
export async function fileSignedAddendumCopy(params: { requestId: string; documentId?: string | null; executedOn: string }): Promise<{ success: boolean; error?: string; executed?: boolean; versionNo?: number }> {
  const g = await gate()
  if (!g.ok) return { success: false, error: g.error }
  if (!isValidUUID(params.requestId)) return { success: false, error: "Invalid request ID" }
  if (params.documentId && !isValidUUID(params.documentId)) return { success: false, error: "Invalid document ID" }
  if (!isDay(params.executedOn)) return { success: false, error: "Give the date the last party signed, as yyyy-mm-dd." }
  const svc = createServiceClient()
  const r = await door.fileSignedAddendumCopy(svc as never, g.actor, { requestId: params.requestId, documentId: params.documentId ?? null, executedOn: params.executedOn })
  if (!r.ok) return { success: false, error: r.reason }
  return { success: true, executed: r.executed, versionNo: r.versionNo }
}
