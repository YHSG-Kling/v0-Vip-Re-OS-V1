/**
 * lib/esign/addendum-signature-request.ts — THE REQUESTED-SIGNATURES DOOR FOR A PROPOSED ADDENDUM, I/O half (wave 152, lane 152F).
 *
 * Owner (verbatim, wave 152): "the requested signatures on a proposed addendum door needs to be built as it says not implemented."
 * Origin: wave 151 lane 151K recorded the door as EVALUATED—NOT IMPLEMENTED ("the e-sign request survivors are form-submission and
 * offer-packet shaped; a document-level request door is a new capability").
 *
 * ── THE STATE MACHINE, ON THE SURVIVORS (nothing here is a new e-sign abstraction) ────────────────────────────────────────
 *   PROPOSED ADDENDUM            contract_term_versions, source addendum | amendment, status proposed (the ONE recorder,
 *                                lib/offers/governing-terms.ts recordContractTermsVersion — lane 152E's; called, never edited)
 *   → CONTRACT ASSOCIATION       governingContractTerms: an executed contract must exist (there is nothing to amend otherwise)
 *   → PARTIES RESOLVED           planAddendumSignatureRouting (pure): represented principals in our envelope; a side another
 *                                brokerage represents signs through ITS agent; attorneys review; broker approval ≠ a signature
 *   → AUTHORITY + COMPLIANCE     the contract's agent or a tenant admin; the sender clear to transact (checkAgentTransactable);
 *                                a commission change held for a brokerage-finance admin (hold-for-human)
 *   → PROVIDER REQUEST           the request row is CLAIMED first (m953: one live request per proposal — a replay returns the
 *                                request already out, never a second envelope), then the ONE dispatch core
 *                                lib/esign/dispatch-packet.ts dispatchEsignPacket (the tenant's selection / the platform default /
 *                                the Google Drive hand-off), under withActionLedger (LAW 5 evidence)
 *   → sent / delivered / viewed / partially_signed / declined / voided / expired / failed — provider events (webhooks, through
 *                                lib/forms/esign-execution-loop.ts) and the poll (lib/transactions/esign-doc-sync-sweep.ts)
 *   → COMPLETION                 the provider's own signer list, read with the tenant's credential (never the event name); a
 *                                partial envelope is never executed
 *   → SIGNED COPY                retrieved, sha256 pinned on FIRST authenticated retrieval; a later copy with another hash is
 *                                refused and flagged, never recorded
 *   → EXECUTED VERSION           recordContractTermsVersion(status executed) — which re-reads the contract through the ONE reader,
 *                                re-runs compliance on the changed terms, moves the closing date through its governed writer and
 *                                notifies the deal team (governing-terms-consequences.ts)
 *   → NOTIFICATIONS              the provider emails the signers; the deal team hears each hop once (compare-and-set transitions).
 *
 * Every function takes the caller's client (service client from a door after its session gate / a webhook / the sweep; the
 * in-memory client in scripts/addendum-signatures-guard.ts) and seams for every vendor reach (`deps`). Defaults load the
 * server-only survivors lazily, so a tsx proof can inject a sandbox provider instead.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { createHash } from "node:crypto"
import { governingContractTerms, recordContractTermsVersion, type RecordVersionInput } from "@/lib/offers/governing-terms"
import { OUTSIDE_LOOP_KEY, OUTSIDE_RECIPIENT_VERIFICATIONS, normalizeEmail } from "@/lib/offers/outside-offer-loop"
import { OUTSIDE_LISTING_AGENT_EMAIL_KEY, OUTSIDE_LISTING_AGENT_NAME_KEY } from "@/lib/inbound-mail/offer-detect"
import { TENANT_ADMIN_USER_TYPES, BROKERAGE_FINANCE_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { resolveAgentIdInBrokerage } from "@/lib/kernel/agent-identity"
import { NUDGE_HOURS, ESCALATE_HOURS } from "@/lib/kernel/signature-chase"
import { presentTenantError } from "@/lib/errors"
import type { DispatchPacketInput, DispatchPacketResult } from "@/lib/esign/dispatch-packet"
import type { ITransactionProvider } from "@/lib/integrations/providers/transaction-provider.interface"
import {
  LIVE_SIGNATURE_REQUEST_STATUSES, canAdvanceSignatureRequest, describeAddendumRequest, isLiveSignatureRequest, planAddendumSignatureRouting,
  providerEventOutcome, requiredSignaturesFrom, signatureRoleOf,
  type AddendumPrincipal, type AddendumRequestDisplay, type AddendumRoutingInput, type AddendumRoutingPlan, type AddendumSide, type CounterpartyAgent,
  type SignatureRequestStatus,
} from "./addendum-signature-rules"

type Svc = SupabaseClient<any, any, any>

/** The verified session caller (the door resolves it with requireCaller BEFORE the service client is created). */
export interface AddendumActor { userId: string; brokerageId: string; userType: string | null; teamId: string | null }

type ProviderClient = Pick<ITransactionProvider, "getSignatureStatus" | "syncDocuments" | "voidTransaction">

/** Every vendor reach is a seam. Omitted → the production survivor, loaded lazily. */
interface AddendumSignatureDeps {
  now?: () => Date
  /** Preflight: which e-sign route the sender's account has (resolveESignChoice). Nothing is written when it has none. */
  esignChoice?: (ctx: { brokerageId: string; userId: string; teamId: string | null }) => Promise<{ ok: true; kind: "google" | "api"; providerName: string } | { ok: false; error: string }>
  dispatch?: (svc: Svc, input: DispatchPacketInput) => Promise<DispatchPacketResult>
  /** The account that SENT the envelope (resolveESignProviderForActor with the provider hint). */
  provider?: (ctx: { brokerageId: string; userId: string | null; provider: string }) => Promise<ProviderClient>
  fetchBytes?: (url: string) => Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }>
  storeSignedCopy?: (svc: Svc, input: { brokerageId: string; contactId: string | null; transactionId: string | null; offerId: string | null; requestId: string; bytes: Uint8Array; sha256: string; fileName: string; metadata: Record<string, unknown> }) => Promise<{ ok: true; documentId: string } | { ok: false; error: string }>
  recordExecuted?: (svc: Svc, input: RecordVersionInput) => ReturnType<typeof recordContractTermsVersion>
  readiness?: (svc: Svc, userId: string) => Promise<{ transactable: boolean; message: string | null; blockers: string[] }>
  /** A fresh short-lived link to the addendum file (documents.storage_url is a signed link that expires). */
  documentUrl?: (svc: Svc, storageUrl: string) => Promise<string | null>
  event?: (svc: Svc, brokerageId: string, input: { event_type: string; payload: Record<string, unknown>; source: "ui" | "webhook" | "system" | "cron"; user_id?: string | null; entity_type?: string; entity_id?: string; dedupe_key?: string }) => Promise<unknown>
  signal?: (input: { brokerageId: string; fromManager: "deal_coordinator" | "compliance_officer"; toManager: "deal_coordinator" | "compliance_officer"; signalType: string; message: string; entityType: string; entityId: string; payload?: Record<string, unknown> }, svc: Svc) => Promise<{ ok: boolean }>
}

const REQUEST_TTL_DAYS = 14 // the survivor writers' expiry (lib/workflow/adapters/send-for-esign.ts, app/actions/dotloop-integration.ts)
const REQUEST_COLUMNS = "id, brokerage_id, transaction_id, contact_id, contract_term_version_id, request_status, provider_envelope_id, all_parties, signing_order, sent_at, expires_at, completed_at, signing_url, evidence, created_at"
const ADDENDUM_SOURCES = ["addendum", "amendment"]

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex")
const iso = (d: Date) => d.toISOString()
const lower = (s: unknown) => String(s ?? "").toLowerCase()

// ─── defaults (the production survivors) ──────────────────────────────────────────────────────────────────────────────────

const DEFAULTS: Required<Omit<AddendumSignatureDeps, "now">> = {
  esignChoice: async (ctx) => {
    const { resolveESignChoice } = await import("@/lib/integrations/resolve-esign-provider")
    const c = await resolveESignChoice(ctx)
    return c.ok ? { ok: true, kind: c.kind, providerName: c.providerName } : { ok: false, error: c.error }
  },
  dispatch: async (svc, input) => (await import("@/lib/esign/dispatch-packet")).dispatchEsignPacket(svc, input),
  provider: async (ctx) => {
    const { resolveESignProviderForActor } = await import("@/lib/integrations/resolve-esign-provider")
    return (await resolveESignProviderForActor({ brokerageId: ctx.brokerageId, userId: ctx.userId, provider: ctx.provider })).provider
  },
  fetchBytes: async (url) => {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    const got = await callConnector<Buffer>({ connector: "asset-download", url, method: "GET", auth: { style: "none" }, responseType: "arraybuffer", timeoutMs: 60_000 })
    return got.ok && got.data ? { ok: true, bytes: new Uint8Array(got.data) } : { ok: false, error: got.error ?? `HTTP ${got.status}` }
  },
  storeSignedCopy: async (svc, input) => {
    // The same path the offer upload route takes (app/api/offers/[offerId]/upload-document): private `documents` bucket →
    // issueBucketObjectUrl → uploadDocument (classifier). The provider's URL expires; the deal file keeps its own copy.
    const path = `${input.brokerageId}/${input.contactId ?? "anon"}/addendum-signed/${input.requestId}_${input.sha256.slice(0, 12)}.pdf`
    const { error: upErr } = await svc.storage.from("documents").upload(path, input.bytes as never, { contentType: "application/pdf", upsert: true })
    if (upErr) return { ok: false, error: `the signed copy could not be stored: ${upErr.message}` }
    const { issueBucketObjectUrl } = await import("@/lib/storage/document-buckets")
    const issued = await issueBucketObjectUrl(svc as never, { bucket: "documents", objectPath: path })
    if (!issued.ok) return { ok: false, error: `the signed copy was stored but no link could be issued: ${issued.reason}` }
    const { uploadDocument } = await import("@/lib/documents/upload-document")
    const r = await uploadDocument({ brokerageId: input.brokerageId, storageUrl: issued.url, fileName: input.fileName, documentType: "addendum", contactId: input.contactId, offerId: input.offerId, transactionId: input.transactionId, metadata: { ...input.metadata, storage_path: path, sha256: input.sha256 } })
    return r.success && r.documentId ? { ok: true, documentId: r.documentId } : { ok: false, error: r.error ?? "the signed copy could not be filed" }
  },
  recordExecuted: (svc, input) => recordContractTermsVersion(svc, input),
  readiness: async (svc, userId) => (await import("@/lib/compliance/agent-readiness-gate")).checkAgentTransactable(svc, userId),
  documentUrl: async (svc, storageUrl) => {
    // `…/storage/v1/object/(sign|public)/<bucket>/<path>?…` → re-issued through the ONE issuer (lib/storage/document-buckets.ts).
    const m = /\/storage\/v1\/object\/(?:sign|public)\/([^/]+)\/([^?]+)/.exec(storageUrl)
    if (!m) return storageUrl
    const { issueBucketObjectUrl } = await import("@/lib/storage/document-buckets")
    const issued = await issueBucketObjectUrl(svc as never, { bucket: m[1], objectPath: decodeURIComponent(m[2]) })
    return issued.ok ? issued.url : null
  },
  event: async (svc, brokerageId, input) => (await import("@/lib/events/lifecycle-event-core")).recordLifecycleEvent(svc, brokerageId, input as never, { dedupeWindowHours: null }),
  signal: async (input, svc) => (await import("@/lib/kernel/manager-signals")).publishManagerSignal(input, svc as never),
}
const dep = <K extends keyof typeof DEFAULTS>(deps: AddendumSignatureDeps, k: K) => (deps[k] ?? DEFAULTS[k]) as (typeof DEFAULTS)[K]
const nowOf = (deps: AddendumSignatureDeps) => (deps.now ?? (() => new Date()))()

// ─── the context of one proposed addendum ─────────────────────────────────────────────────────────────────────────────────

interface ProposalRow { id: string; root_offer_id: string | null; transaction_id: string | null; offer_id: string | null; document_id: string | null; source: string; status: string; terms: Record<string, unknown>; evidence: Record<string, any>; version_no: number }

interface SigningContext {
  proposal: ProposalRow
  transactionId: string | null
  rootOfferId: string | null
  propertyAddress: string | null
  /** agents.id of the contract's agent (the deal's agent, else the offer chain's) — and that agent's users.id. */
  agentId: string | null
  agentUserId: string | null
  /** The principal contact the request row hangs off (our client) — signature_requests.contact_id. */
  contactId: string | null
  document: { id: string; storageUrl: string | null; name: string } | null
  routingBase: Pick<AddendumRoutingInput, "representedSides" | "principals" | "counterpartyAgents" | "attorneys" | "changedTermKeys" | "brokerApproval">
}

type Fail = { ok: false; code: string; message: string }
const fail = (code: string, message: string): Fail => ({ ok: false, code, message })
/** A read that could not run: the TENANT hears what happened, that nothing changed, and who can act; the database's own words stay
 *  in the server log (the charter's message contract — no SQL / RLS / provider strings in tenant copy). */
// PRESENTER WIRING (wave 152, lane 152K — the integrator queue): both copy helpers now compose through THE tenant
// presenter (lib/errors/index.ts presentTenantError): the raw refusal is LOGGED with a quotable reference, the sentence
// passes the ONE tenant-copy gate (a leaking label is replaced, never shown), and "nothing was changed" is said only as
// the work truth. Same 23 call sites, same contract shape.
const unreadable = (what: string, detail: string): Fail =>
  fail("unreadable", presentTenantError({
    what: `${what} could not be read right now, so nothing was sent`, raw: `${what} could not be read: ${detail}`,
    work: { state: "unchanged" }, next: "platform_support", action: { label: "Try again in a moment" }, context: "addendum-signatures",
  }).sentence)
/** A write that could not land: same contract — the detail is logged, the tenant hears the outcome and the next step. */
const unsaved = (what: string, detail: string, next: string): string =>
  presentTenantError({ what: `${what}. ${next}`, raw: `${what}: ${detail}`, next: "you", action: null, context: "addendum-signatures" }).sentence

async function loadProposal(svc: Svc, brokerageId: string, versionId: string): Promise<{ ok: true; row: ProposalRow } | Fail> {
  const { data, error } = await svc.from("contract_term_versions").select("id, root_offer_id, transaction_id, offer_id, document_id, source, status, terms, evidence, version_no").eq("id", versionId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return unreadable("The proposed addendum", error.message)
  if (!data) return fail("not_found", "That proposed addendum is not on file for your account.")
  const row = data as ProposalRow
  if (!ADDENDUM_SOURCES.includes(row.source)) return fail("not_addendum", "Only an addendum or an amendment is sent for signature here.")
  return { ok: true, row: { ...row, evidence: (row.evidence ?? {}) as Record<string, any>, terms: (row.terms ?? {}) as Record<string, unknown> } }
}

const nameOf = (c: { first_name?: string | null; last_name?: string | null } | null | undefined) => [c?.first_name, c?.last_name].filter(Boolean).join(" ").trim() || null

async function loadSigningContext(svc: Svc, brokerageId: string, versionId: string): Promise<{ ok: true; ctx: SigningContext } | Fail> {
  const p = await loadProposal(svc, brokerageId, versionId)
  if (!p.ok) return p
  const proposal = p.row
  // AUTHORITATIVE ASSOCIATION — the ONE reader: an addendum amends an EXECUTED contract.
  const gov = await governingContractTerms(svc, brokerageId, proposal.transaction_id ? { transactionId: proposal.transaction_id } : { offerId: proposal.root_offer_id as string })
  if (!gov.ok) return unreadable("The contract this addendum changes", gov.reason)
  if (!gov.governing.governingVersion) return fail("no_contract", "There is no executed contract for this addendum to change yet — an addendum changes a contract both parties have signed.")
  const transactionId = proposal.transaction_id ?? gov.transactionId
  const rootOfferId = proposal.root_offer_id ?? gov.rootOfferId

  const representedSides: AddendumSide[] = []
  const principals: AddendumPrincipal[] = []
  const counterpartyAgents: CounterpartyAgent[] = []
  const attorneys: Array<{ name: string | null; email: string | null; role: string }> = []
  let agentId: string | null = null
  let contactId: string | null = null
  let propertyAddress: string | null = null
  let rootMeta: Record<string, any> = {}

  if (rootOfferId) {
    const { data: root, error } = await svc.from("offers").select("id, agent_id, contact_id, listing_id, property_address, metadata").eq("id", rootOfferId).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return unreadable("The offer behind this contract", error.message)
    rootMeta = ((root as any)?.metadata ?? {}) as Record<string, any>
    agentId = ((root as any)?.agent_id as string | null) ?? null
    propertyAddress = ((root as any)?.property_address as string | null) ?? null
    if (!transactionId && root) {
      // Before a transaction exists, the offer chain names the sides: our buyer (offers.contact_id) and — on an in-house listing —
      // the listing's seller; an OUTSIDE listing's seller is represented by the listing agent recorded on the offer.
      const buyerId = (root as any).contact_id as string | null
      if (buyerId) representedSides.push("buyer")
      let sellerId: string | null = null
      if ((root as any).listing_id) {
        const { data: listing, error: lErr } = await svc.from("listings").select("seller_contact_id").eq("id", (root as any).listing_id).eq("brokerage_id", brokerageId).maybeSingle()
        if (lErr) return unreadable("The listing behind this contract", lErr.message)
        sellerId = ((listing as any)?.seller_contact_id as string | null) ?? null
        if (sellerId) representedSides.push("seller")
      }
      const ids = [buyerId, sellerId].filter(Boolean) as string[]
      if (ids.length) {
        const { data: cs, error: cErr } = await svc.from("contacts").select("id, first_name, last_name, email").eq("brokerage_id", brokerageId).in("id", ids)
        if (cErr) return unreadable("The parties", cErr.message)
        for (const c of (cs ?? []) as any[]) principals.push({ side: c.id === buyerId ? "buyer" : "seller", role: c.id === buyerId ? "buyer" : "seller", name: nameOf(c), email: c.email ?? null, source: "contact" })
      }
      contactId = buyerId ?? sellerId
    }
  }

  if (transactionId) {
    const { data: tx, error } = await svc.from("transactions").select("id, agent_id, buyer_contact_id, seller_contact_id, property_address").eq("id", transactionId).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return unreadable("The transaction", error.message)
    if (!tx) return fail("not_found", "The transaction this addendum changes is not on file for your account.")
    const t = tx as Record<string, any>
    agentId = (t.agent_id as string | null) ?? agentId
    propertyAddress = (t.property_address as string | null) ?? propertyAddress
    // A represented principal has a contact FK on the deal; an outside principal has none (notifyTransactionParties' rule).
    if (t.buyer_contact_id) representedSides.push("buyer")
    if (t.seller_contact_id && t.seller_contact_id !== t.buyer_contact_id) representedSides.push("seller")
    const ids = [t.buyer_contact_id, t.seller_contact_id].filter(Boolean) as string[]
    if (ids.length) {
      const { data: cs, error: cErr } = await svc.from("contacts").select("id, first_name, last_name, email").eq("brokerage_id", brokerageId).in("id", ids)
      if (cErr) return unreadable("The parties", cErr.message)
      for (const c of (cs ?? []) as any[]) principals.push({ side: c.id === t.buyer_contact_id ? "buyer" : "seller", role: c.id === t.buyer_contact_id ? "buyer" : "seller", name: nameOf(c), email: c.email ?? null, source: "contact" })
    }
    contactId = (t.buyer_contact_id as string | null) ?? (t.seller_contact_id as string | null) ?? null
    const { data: roster, error: rErr } = await svc.from("transaction_participants").select("role, name, email").eq("brokerage_id", brokerageId).eq("transaction_id", transactionId)
    if (rErr) return unreadable("The deal's participant roster", rErr.message)
    for (const r of (roster ?? []) as Array<{ role: string | null; name: string | null; email: string | null }>) {
      const role = lower(r.role)
      if ((role === "co_buyer" || role === "co_seller") && representedSides.includes(role === "co_buyer" ? "buyer" : "seller")) principals.push({ side: role === "co_buyer" ? "buyer" : "seller", role: role as AddendumPrincipal["role"], name: r.name, email: r.email, source: "participant" })
      else if ((role === "buyer_agent" || role === "seller_agent") && !representedSides.includes(role === "buyer_agent" ? "buyer" : "seller")) counterpartyAgents.push({ side: role === "buyer_agent" ? "buyer" : "seller", name: r.name, email: r.email, verified: true })
      else if (role.includes("attorney")) attorneys.push({ name: r.name, email: r.email, role })
    }
  }

  // The outside listing agent the offer loop recorded (and verified) — the seller's route when the seller is not ours.
  if (!representedSides.includes("seller") && !counterpartyAgents.some((a) => a.side === "seller")) {
    const recorded = normalizeEmail((rootMeta[OUTSIDE_LISTING_AGENT_EMAIL_KEY] as string | undefined) ?? rootMeta[OUTSIDE_LOOP_KEY]?.counterparty?.email)
    const cp = rootMeta[OUTSIDE_LOOP_KEY]?.counterparty as { email?: string; verified_by?: string } | undefined
    const verified = !!cp && normalizeEmail(cp.email) === recorded && (OUTSIDE_RECIPIENT_VERIFICATIONS as readonly string[]).includes(String(cp.verified_by))
    if (recorded) counterpartyAgents.push({ side: "seller", name: (rootMeta[OUTSIDE_LISTING_AGENT_NAME_KEY] as string | undefined) ?? null, email: recorded, verified })
  }

  let agentUserId: string | null = null
  if (agentId) {
    const { data: a, error: aErr } = await svc.from("agents").select("user_id").eq("id", agentId).maybeSingle()
    if (aErr) return unreadable("The contract's agent", aErr.message)
    agentUserId = ((a as any)?.user_id as string | null) ?? null
  }

  let document: SigningContext["document"] = null
  if (proposal.document_id) {
    const { data: d, error: dErr } = await svc.from("documents").select("id, storage_url, metadata").eq("id", proposal.document_id).eq("brokerage_id", brokerageId).maybeSingle()
    if (dErr) return unreadable("The addendum document", dErr.message)
    if (d) document = { id: (d as any).id, storageUrl: ((d as any).storage_url as string | null) ?? null, name: String(((d as any).metadata as any)?.file_name ?? `${proposal.source === "amendment" ? "Amendment" : "Addendum"} — ${propertyAddress ?? "contract"}`) }
  }

  const approval = proposal.evidence.broker_approval as { approved_by?: string; approved_at?: string } | undefined
  return {
    ok: true,
    ctx: {
      proposal, transactionId, rootOfferId, propertyAddress, agentId, agentUserId, contactId, document,
      routingBase: {
        representedSides, principals, counterpartyAgents, attorneys, changedTermKeys: Object.keys(proposal.terms),
        brokerApproval: approval?.approved_by && approval.approved_at ? { approvedBy: approval.approved_by, approvedAt: approval.approved_at } : null,
      },
    },
  }
}

/** The contract's agent or a tenant admin — the same gate as the executed-addendum door (record-contract-addendum.ts). */
async function authorize(svc: Svc, actor: AddendumActor, ctx: SigningContext): Promise<{ ok: true; isAdmin: boolean } | Fail> {
  if (TENANT_ADMIN_USER_TYPES.has(lower(actor.userType))) return { ok: true, isAdmin: true }
  const mine = await resolveAgentIdInBrokerage(svc, actor.userId, actor.brokerageId)
  if (!mine || !ctx.agentId || mine !== ctx.agentId) return fail("forbidden", "Only the contract's agent or a brokerage admin can send this addendum for signature.")
  return { ok: true, isAdmin: false }
}

/** What the sender chose in the party review. A side another brokerage represents is never given a direct signer here. */
export interface AddendumPartyChoices {
  additionalSigners?: Array<{ side: AddendumSide; role: "buyer" | "co_buyer" | "seller" | "co_seller"; name: string; email: string }>
  counterpartyAgentEmail?: string | null
  counterpartyAgentName?: string | null
  confirmCounterpartyAgent?: boolean
  includeAttorneys?: boolean
  /** Reminder nudges from the sweep (the sender's preference). Default on. */
  reminders?: boolean
}

async function senderEmailOf(svc: Svc, actor: AddendumActor): Promise<string | null> {
  const { data } = await svc.from("users").select("email").eq("id", actor.userId).maybeSingle()
  return ((data as any)?.email as string | null) ?? null
}

function routingInputFor(ctx: SigningContext, choices: AddendumPartyChoices, senderEmail: string | null, senderMayApproveCommission: boolean): AddendumRoutingInput {
  const principals = [...ctx.routingBase.principals]
  for (const s of choices.additionalSigners ?? []) {
    if (!ctx.routingBase.representedSides.includes(s.side)) continue // an outside principal is reached through their agent, never added here
    principals.push({ side: s.side, role: s.role, name: s.name?.trim() || null, email: s.email?.trim() || null, source: "entered" })
  }
  let counterpartyAgents = ctx.routingBase.counterpartyAgents
  const entered = normalizeEmail(choices.counterpartyAgentEmail ?? "")
  if (entered) {
    const missingSide = (["buyer", "seller"] as AddendumSide[]).find((s) => !ctx.routingBase.representedSides.includes(s))
    if (missingSide) {
      const known = counterpartyAgents.find((a) => a.side === missingSide)
      counterpartyAgents = [...counterpartyAgents.filter((a) => a.side !== missingSide), { side: missingSide, name: choices.counterpartyAgentName ?? known?.name ?? null, email: entered, verified: !!known && known.verified && normalizeEmail(known.email) === entered }]
    }
  }
  return {
    ...ctx.routingBase, principals, counterpartyAgents, includeAttorneys: choices.includeAttorneys !== false, senderEmail,
    senderMayApproveCommission, confirmedCounterpartyAgent: choices.confirmCounterpartyAgent === true,
  }
}

/** The proposal's identity at send: its document and its terms. A change after send is a NEW request, never an edit. */
function packetFingerprint(p: ProposalRow): string {
  const terms = Object.fromEntries(Object.keys(p.terms).sort().map((k) => [k, p.terms[k]]))
  return sha256(JSON.stringify({ document_id: p.document_id, source: p.source, terms }))
}

// ─── reading ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

type ProviderReadiness = { state: "connected" | "handoff" | "connection_required"; providerName: string | null; message: string }

async function providerReadiness(actor: AddendumActor, deps: AddendumSignatureDeps): Promise<ProviderReadiness> {
  const c = await dep(deps, "esignChoice")({ brokerageId: actor.brokerageId, userId: actor.userId, teamId: actor.teamId })
  if (!c.ok) {
    // The resolver's own sentence names vendors and settings; the tenant hears the contract's words (the detail stays internal).
    console.error(`[addendum-signatures] no e-sign route for user ${actor.userId}: ${c.error}`)
    return { state: "connection_required", providerName: null, message: "No e-signature connection is available for your account, so this addendum cannot be sent for signature from here. Nothing was sent and the proposed addendum is still saved. An account admin can connect an e-sign provider in Settings → Integrations — or download the addendum, have it signed, and file the signed copy here." }
  }
  if (c.kind === "google") return { state: "handoff", providerName: c.providerName, message: "Your e-signature is set to send from your own Google Drive. The addendum is placed there for you to request the signatures; file the signed copy here when every party has signed." }
  return { state: "connected", providerName: c.providerName, message: "Ready to review: the signers below will receive the addendum in the order shown." }
}

export interface AddendumReview {
  ok: true
  proposal: { id: string; source: string; terms: Record<string, unknown>; documentName: string | null; status: string }
  plan: AddendumRoutingPlan
  provider: ProviderReadiness
  liveRequest: { id: string; status: string; display: AddendumRequestDisplay } | null
  /** A fresh short-lived link to the unsigned addendum (the download for a hand-off). */
  documentUrl: string | null
}

/** THE PARTY REVIEW — who signs, through what route, what is missing, which e-sign route. Writes nothing. */
export async function reviewAddendumSignatures(svc: Svc, actor: AddendumActor, input: { versionId: string; choices?: AddendumPartyChoices }, deps: AddendumSignatureDeps = {}): Promise<AddendumReview | Fail> {
  const loaded = await loadSigningContext(svc, actor.brokerageId, input.versionId)
  if (!loaded.ok) return loaded
  const auth = await authorize(svc, actor, loaded.ctx)
  if (!auth.ok) return auth
  const plan = planAddendumSignatureRouting(routingInputFor(loaded.ctx, input.choices ?? {}, await senderEmailOf(svc, actor), BROKERAGE_FINANCE_ADMIN_USER_TYPES.has(lower(actor.userType))))
  const live = await liveRequestFor(svc, actor.brokerageId, input.versionId)
  if (!live.ok) return live
  return {
    ok: true,
    proposal: { id: loaded.ctx.proposal.id, source: loaded.ctx.proposal.source, terms: loaded.ctx.proposal.terms, documentName: loaded.ctx.document?.name ?? null, status: loaded.ctx.proposal.status },
    plan, provider: await providerReadiness(actor, deps),
    liveRequest: live.row ? { id: live.row.id, status: live.row.request_status, display: describeAddendumRequest(live.row.request_status, live.row.evidence) } : null,
    documentUrl: loaded.ctx.document?.storageUrl ? await dep(deps, "documentUrl")(svc, loaded.ctx.document.storageUrl) : null,
  }
}

/**
 * DOWNLOAD AND HAND OFF — no e-sign route (or the sender chose to collect wet / outside signatures). A request is opened in
 * `pending` with handoff_mode "download": nothing is sent from the platform and nothing claims it was; the fully signed copy is
 * filed against it (fileSignedAddendumCopy → the recorder reads BOTH signatures). Same gates as a send: authority, readiness,
 * the broker's hold on a commission change, one live request per proposal.
 */
export async function startAddendumHandoff(svc: Svc, actor: AddendumActor, input: { versionId: string }, deps: AddendumSignatureDeps = {}): Promise<RequestAddendumResult> {
  const loaded = await loadSigningContext(svc, actor.brokerageId, input.versionId)
  if (!loaded.ok) return { ok: false, state: "refused", message: loaded.message }
  const ctx = loaded.ctx
  if (ctx.proposal.status !== "proposed") return { ok: false, state: "refused", message: "This addendum is no longer a proposal." }
  const auth = await authorize(svc, actor, ctx)
  if (!auth.ok) return { ok: false, state: "refused", message: auth.message }
  const live = await liveRequestFor(svc, actor.brokerageId, ctx.proposal.id)
  if (!live.ok) return { ok: false, state: "refused", message: live.message }
  if (live.row) return { ok: true, replayed: true, requestId: live.row.id, status: live.row.request_status, display: describeAddendumRequest(live.row.request_status, live.row.evidence), handoff: null }
  const readiness = await dep(deps, "readiness")(svc, actor.userId)
  if (!readiness.transactable) return { ok: false, state: "refused", message: readiness.message ?? "Your account is not clear to transact, so a contract document cannot be handed off for signature from it." }
  const plan = planAddendumSignatureRouting(routingInputFor(ctx, {}, await senderEmailOf(svc, actor), BROKERAGE_FINANCE_ADMIN_USER_TYPES.has(lower(actor.userType))))
  const held = plan.blockers.find((b) => b.code === "broker_approval_required")
  if (held) return { ok: false, state: "needs_review", message: held.message, plan }
  const now = nowOf(deps)
  const { data, error } = await svc.from("signature_requests").insert({
    brokerage_id: actor.brokerageId, transaction_id: ctx.transactionId, contact_id: ctx.contactId, contract_term_version_id: ctx.proposal.id, request_status: "pending",
    all_parties: { recipients: plan.recipients, routed: plan.routed, required: plan.required, approvals: plan.approvals }, signing_order: plan.recipients.map((r) => ({ order: r.order, email: r.email, role: r.role })),
    expires_at: iso(new Date(now.getTime() + REQUEST_TTL_DAYS * 86_400_000)),
    evidence: { kind: ctx.proposal.source, provider: null, handoff_mode: "download", packet_fingerprint: packetFingerprint(ctx.proposal), packet_document_id: ctx.document?.id ?? null, requested_by: actor.userId, requested_at: iso(now), agent_user_id: ctx.agentUserId, root_offer_id: ctx.rootOfferId, reminders: true },
  }).select("id")
  if (error) {
    if (error.code === "23505") { const again = await liveRequestFor(svc, actor.brokerageId, ctx.proposal.id); if (again.ok && again.row) return { ok: true, replayed: true, requestId: again.row.id, status: again.row.request_status, display: describeAddendumRequest(again.row.request_status, again.row.evidence), handoff: null } }
    return { ok: false, state: "refused", message: unsaved("The hand-off could not be started", error.message, "Nothing was sent and the proposed addendum is still saved. Try again in a moment.") }
  }
  const requestId = ((data ?? [])[0] as { id?: string } | undefined)?.id as string
  await stampProposal(svc, actor.brokerageId, ctx.proposal, { signature_request_id: requestId })
  return { ok: true, replayed: false, requestId, status: "pending", display: describeAddendumRequest("pending", { handoff_mode: "download" }), handoff: null }
}

async function liveRequestFor(svc: Svc, brokerageId: string, versionId: string): Promise<{ ok: true; row: Record<string, any> | null } | Fail> {
  const { data, error } = await svc.from("signature_requests").select(REQUEST_COLUMNS).eq("brokerage_id", brokerageId).eq("contract_term_version_id", versionId).in("request_status", [...LIVE_SIGNATURE_REQUEST_STATUSES]).order("created_at", { ascending: false }).limit(1)
  if (error) return unreadable("The signature requests", error.message)
  return { ok: true, row: ((data ?? [])[0] as Record<string, any> | undefined) ?? null }
}

/** Every proposed addendum on one contract with its requests, for the addendum panel. Tenant-pinned; a refused read is a reason. */
export async function listAddendumSignatureState(svc: Svc, actor: AddendumActor, ref: { offerId: string } | { transactionId: string }): Promise<{ ok: true; proposals: Array<{ id: string; source: string; versionNo: number; status: string; closedAs: string | null; terms: Record<string, unknown>; documentId: string | null; createdAt: string | null; requests: Array<{ id: string; status: string; sentAt: string | null; display: AddendumRequestDisplay; parties: unknown; fileable: boolean; held: boolean }> }> } | Fail> {
  const gov = await governingContractTerms(svc, actor.brokerageId, ref)
  if (!gov.ok) return unreadable("The contract", gov.reason)
  const filters = [gov.rootOfferId ? `root_offer_id.eq.${gov.rootOfferId}` : null, gov.transactionId ? `transaction_id.eq.${gov.transactionId}` : null].filter(Boolean) as string[]
  if (filters.length === 0) return { ok: true, proposals: [] }
  const { data: vs, error } = await svc.from("contract_term_versions").select("id, source, version_no, status, terms, document_id, evidence, created_at").eq("brokerage_id", actor.brokerageId).in("source", ADDENDUM_SOURCES).or(filters.join(","))
  if (error) return unreadable("The proposed addenda", error.message)
  const proposals = ((vs ?? []) as any[]).filter((v) => v.status === "proposed" || (v.status === "void" && v.evidence?.closed_as))
  if (proposals.length === 0) return { ok: true, proposals: [] }
  const { data: rs, error: rErr } = await svc.from("signature_requests").select(REQUEST_COLUMNS).eq("brokerage_id", actor.brokerageId).in("contract_term_version_id", proposals.map((p) => p.id))
  if (rErr) return unreadable("The signature requests", rErr.message)
  const byVersion = new Map<string, any[]>()
  for (const r of (rs ?? []) as any[]) byVersion.set(r.contract_term_version_id, [...(byVersion.get(r.contract_term_version_id) ?? []), r])
  return {
    ok: true,
    proposals: proposals.map((p) => ({
      id: p.id, source: p.source, versionNo: Number(p.version_no), status: p.status, closedAs: (p.evidence?.closed_as as string | undefined) ?? null, terms: p.terms ?? {}, documentId: p.document_id ?? null, createdAt: p.created_at ?? null,
      requests: (byVersion.get(p.id) ?? []).sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))).map((r) => ({ id: r.id, status: r.request_status, sentAt: r.sent_at ?? null, display: describeAddendumRequest(r.request_status, r.evidence), parties: r.all_parties, ...fileableState(r) })),
    })),
  }
}

// ─── proposing ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Record a PROPOSED addendum through the ONE recorder (status proposed — it never governs; the reader lists it as pending).
 * The addendum's unsigned document is part of the proposal: it is what goes out for signature.
 */
export async function proposeContractAddendumVersion(svc: Svc, actor: AddendumActor, input: { ref: { offerId: string } | { transactionId: string }; kind: "addendum" | "amendment"; documentId: string; terms: Record<string, unknown>; effectiveOn: string | null; termEvidence: Record<string, unknown> | null }): Promise<{ ok: true; versionId: string; versionNo: number } | Fail> {
  const gov = await governingContractTerms(svc, actor.brokerageId, input.ref)
  if (!gov.ok) return unreadable("The contract", gov.reason)
  if (!gov.governing.governingVersion) return fail("no_contract", "There is no executed contract to amend yet — an addendum changes a contract both parties have signed.")
  if (!TENANT_ADMIN_USER_TYPES.has(lower(actor.userType))) {
    if (!gov.rootOfferId) return fail("forbidden", "Only a brokerage admin can propose an addendum on a contract with no offer on file.")
    const { data: root, error } = await svc.from("offers").select("agent_id").eq("id", gov.rootOfferId).eq("brokerage_id", actor.brokerageId).maybeSingle()
    if (error) return unreadable("The contract's offer", error.message)
    const mine = await resolveAgentIdInBrokerage(svc, actor.userId, actor.brokerageId)
    if (!root || !mine || (root as any).agent_id !== mine) return fail("forbidden", "Only the contract's agent or a brokerage admin can propose an addendum on it.")
  }
  const { data: doc, error: dErr } = await svc.from("documents").select("id").eq("id", input.documentId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (dErr) return unreadable("The addendum document", dErr.message)
  if (!doc) return fail("no_document", "Upload the addendum document first — it is what the parties sign.")
  const rec = await recordContractTermsVersion(svc, {
    brokerageId: actor.brokerageId, rootOfferId: gov.rootOfferId, transactionId: gov.transactionId, source: input.kind, status: "proposed",
    terms: input.terms, documentId: input.documentId, recordedBy: actor.userId,
    evidence: { recorded_via: "propose_contract_addendum", ...(input.effectiveOn ? { effective_on: input.effectiveOn } : {}), ...(input.termEvidence ? { term_evidence_stated: input.termEvidence } : {}) },
  })
  if (!rec.ok) return fail("refused", rec.reason)
  return { ok: true, versionId: rec.id, versionNo: rec.versionNo }
}

/** A brokerage-finance admin approves a proposal whose terms move the brokerage's money (hold-for-human, recorded on the proposal). */
export async function approveAddendumForSignature(svc: Svc, actor: AddendumActor, input: { versionId: string }, deps: AddendumSignatureDeps = {}): Promise<{ ok: true } | Fail> {
  if (!BROKERAGE_FINANCE_ADMIN_USER_TYPES.has(lower(actor.userType))) return fail("forbidden", "Only a brokerage finance admin can approve an addendum that changes commission terms.")
  const p = await loadProposal(svc, actor.brokerageId, input.versionId)
  if (!p.ok) return p
  if (p.row.status !== "proposed") return fail("not_proposed", "This addendum is no longer a proposal.")
  const at = iso(nowOf(deps))
  const { data, error } = await svc.from("contract_term_versions").update({ evidence: { ...p.row.evidence, broker_approval: { approved_by: actor.userId, approved_at: at } } }).eq("id", p.row.id).eq("brokerage_id", actor.brokerageId).eq("status", "proposed").select("id")
  if (error) return fail("refused", unsaved("The approval could not be saved", error.message, "The addendum is still waiting for approval. Try again in a moment."))
  if (!data || data.length === 0) return fail("refused", "The approval could not be saved: the proposal changed while you approved it. Reload and try again.")
  return { ok: true }
}

// ─── sending ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

type RequestAddendumResult =
  | { ok: true; replayed: boolean; requestId: string; status: SignatureRequestStatus; display: AddendumRequestDisplay; handoff: DispatchPacketResult["handoff"] | null }
  | { ok: false; state: "needs_review" | "connection_required" | "failed" | "refused"; message: string; plan?: AddendumRoutingPlan; requestId?: string; retryable?: boolean }

/**
 * REQUEST SIGNATURES on a proposed addendum. Order: the context and the authority → the sender's readiness → the plan (refused
 * with the blockers, nothing written) → the e-sign route (refused when none, nothing written) → the CLAIM (one live request per
 * proposal; a replay returns the request already out) → the dispatch under the action ledger → the record. A dispatch failure
 * leaves a `failed` request with the reason (the proposal stands; a new request may be sent).
 */
export async function requestAddendumSignatures(svc: Svc, actor: AddendumActor, input: { versionId: string; choices?: AddendumPartyChoices }, deps: AddendumSignatureDeps = {}): Promise<RequestAddendumResult> {
  const loaded = await loadSigningContext(svc, actor.brokerageId, input.versionId)
  if (!loaded.ok) return { ok: false, state: "refused", message: loaded.message }
  const ctx = loaded.ctx
  if (ctx.proposal.status !== "proposed") return { ok: false, state: "refused", message: "This addendum is no longer a proposal, so it cannot be sent for signature. Propose a new one if the terms are still changing." }
  const auth = await authorize(svc, actor, ctx)
  if (!auth.ok) return { ok: false, state: "refused", message: auth.message }

  // REPLAY FIRST: the request already out is the answer — never a second envelope.
  const live = await liveRequestFor(svc, actor.brokerageId, ctx.proposal.id)
  if (!live.ok) return { ok: false, state: "refused", message: live.message }
  if (live.row) return { ok: true, replayed: true, requestId: live.row.id, status: live.row.request_status, display: describeAddendumRequest(live.row.request_status, live.row.evidence), handoff: null }

  const readiness = await dep(deps, "readiness")(svc, actor.userId)
  if (!readiness.transactable) return { ok: false, state: "refused", message: readiness.message ?? "Your account is not clear to transact, so a contract document cannot go out for signature from it. Your broker can see what is needed." }
  if (!ctx.document?.storageUrl) return { ok: false, state: "needs_review", message: "Upload the addendum document before requesting signatures — it is what the parties sign." }

  const choices = input.choices ?? {}
  const plan = planAddendumSignatureRouting(routingInputFor(ctx, choices, await senderEmailOf(svc, actor), BROKERAGE_FINANCE_ADMIN_USER_TYPES.has(lower(actor.userType))))
  if (!plan.ready) return { ok: false, state: "needs_review", message: plan.blockers[0].message, plan }

  const route = await providerReadiness(actor, deps)
  if (route.state === "connection_required") return { ok: false, state: "connection_required", message: route.message, plan }

  // THE CLAIM — before any provider call. m953's partial unique index refuses a second LIVE row for the proposal (23505).
  const now = nowOf(deps)
  const fingerprint = packetFingerprint(ctx.proposal)
  const brokerApproval = plan.approvals.find((a) => a.kind === "broker_approval")
  const { data: claimed, error: claimErr } = await svc.from("signature_requests").insert({
    brokerage_id: actor.brokerageId, transaction_id: ctx.transactionId, contact_id: ctx.contactId, contract_term_version_id: ctx.proposal.id,
    request_status: "pending", all_parties: { recipients: plan.recipients, routed: plan.routed, required: plan.required, approvals: plan.approvals },
    signing_order: plan.recipients.map((r) => ({ order: r.order, email: r.email, role: r.role })),
    expires_at: iso(new Date(now.getTime() + REQUEST_TTL_DAYS * 86_400_000)),
    evidence: {
      kind: ctx.proposal.source, provider: route.providerName, packet_fingerprint: fingerprint, packet_document_id: ctx.document.id,
      requested_by: actor.userId, requested_at: iso(now), agent_user_id: ctx.agentUserId, root_offer_id: ctx.rootOfferId, reminders: choices.reminders !== false,
      ...(brokerApproval ? { broker_approval: auth.isAdmin && BROKERAGE_FINANCE_ADMIN_USER_TYPES.has(lower(actor.userType)) ? { approved_by: actor.userId, approved_at: iso(now), by_send: true } : ctx.routingBase.brokerApproval } : {}),
    },
  }).select("id")
  if (claimErr) {
    if (claimErr.code === "23505") {
      const again = await liveRequestFor(svc, actor.brokerageId, ctx.proposal.id)
      if (again.ok && again.row) return { ok: true, replayed: true, requestId: again.row.id, status: again.row.request_status, display: describeAddendumRequest(again.row.request_status, again.row.evidence), handoff: null }
    }
    return { ok: false, state: "refused", message: unsaved("The signature request could not be started", claimErr.message, "Nothing was sent and the proposed addendum is still saved. Try again in a moment.") }
  }
  const requestId = ((claimed ?? [])[0] as { id?: string } | undefined)?.id
  if (!requestId) return { ok: false, state: "refused", message: "The signature request could not be started. Nothing was sent." }

  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const packetUrl = await dep(deps, "documentUrl")(svc, ctx.document.storageUrl)
  if (!packetUrl) {
    await advanceRequest(svc, actor.brokerageId, { id: requestId, request_status: "pending", evidence: {} }, "failed", { failure: "the addendum file could not be opened for sending", failed_at: iso(nowOf(deps)) }, { quiet: true })
    return { ok: false, state: "failed", requestId, retryable: true, message: "The addendum was not sent: its file could not be opened for sending. Nothing was signed and the proposed addendum is still saved. Upload the addendum again, then send it." }
  }
  const dispatchInput: DispatchPacketInput = {
    brokerageId: actor.brokerageId, userId: actor.userId, teamId: actor.teamId, transactionType: "purchase",
    propertyAddress: ctx.propertyAddress ?? "Real estate contract", contactId: ctx.contactId,
    signers: plan.recipients.map((r) => ({ name: r.name, email: r.email, role: r.role })),
    documents: [{ name: ctx.document.name, url: packetUrl }], recordId: requestId,
    message: `${ctx.proposal.source === "amendment" ? "Amendment" : "Addendum"} to the contract for ${ctx.propertyAddress ?? "your property"} — please review and sign`,
  }
  let dispatch: DispatchPacketResult
  try {
    dispatch = await withActionLedger<DispatchPacketResult>({
      brokerageId: actor.brokerageId, action: "contract.addendum_signatures.request", actor: { type: "user", userId: actor.userId },
      subject: { type: "signature_request", id: requestId, ref: ctx.proposal.id }, reasonCode: "HUMAN_REQUESTED",
      reasonDetail: `request signatures on proposed ${ctx.proposal.source} ${ctx.proposal.version_no}`, idempotencyKey: `addendum-signatures:${requestId}`,
      channel: "esign", riskClass: "LEGAL", detail: { recipients: plan.recipients.length, routed: plan.routed.length, provider: route.providerName },
    }, () => dep(deps, "dispatch")(svc, dispatchInput), {
      settle: (r) => r.ok ? { status: "executed", outcome: r.status === "sent" ? "sent" : "awaiting_agent_send", provider: r.providerName ?? null, providerRef: r.envelopeId ?? null } : { status: "failed", outcome: "provider_refused", provider: r.providerName ?? null, error: r.error ?? null },
      replay: (claim) => ({ ok: false, error: claim.kind === "refused" ? `the request could not be recorded on the action ledger (${claim.error}) — nothing was sent` : "this signature request is already in flight" }),
    }, { client: svc })
  } catch (err) {
    dispatch = { ok: false, error: (err as Error)?.message ?? String(err) }
  }

  if (!dispatch.ok) {
    const failure = dispatch.needsReconnect ? "your e-sign connection needs to be reconnected" : "the e-sign provider did not accept it"
    await advanceRequest(svc, actor.brokerageId, { id: requestId, request_status: "pending", evidence: {} }, "failed", { failure, failure_detail: dispatch.error ?? null, provider: dispatch.providerName ?? route.providerName, failed_at: iso(nowOf(deps)) }, { quiet: true })
    return { ok: false, state: "failed", requestId, retryable: true, message: `The addendum was not sent: ${failure}. Nothing was signed and the proposed addendum is still saved. ${dispatch.needsReconnect ? "Reconnect your e-sign provider in Settings → Integrations, then send it again." : "Send it again, or file a signed copy here once it is signed another way."}` }
  }

  const status: SignatureRequestStatus = dispatch.status === "sent" ? "sent" : "pending"
  const evidencePatch = {
    provider: dispatch.providerName ?? route.providerName, credential_scope: dispatch.credentialScope ?? null, dispatch_status: dispatch.status ?? null,
    handoff_mode: dispatch.handoff?.mode ?? null, handoff_urls: dispatch.kind === "google" ? (dispatch.handoff?.urls ?? []) : [], attached: dispatch.attachedCount ?? 0,
  }
  const priorEvidence = await requestEvidence(svc, actor.brokerageId, requestId)
  const { data: rec, error: recErr } = await svc.from("signature_requests").update({
    request_status: status, provider_envelope_id: dispatch.envelopeId ?? null, sent_at: status === "sent" ? iso(nowOf(deps)) : null,
    signing_url: dispatch.kind === "google" ? (dispatch.handoff?.urls[0]?.url ?? null) : null,
    // the status and envelope reference always land; the evidence merge only when the prior record was READ (never `{}` over it)
    ...(priorEvidence ? { evidence: { ...priorEvidence, ...evidencePatch } } : {}),
  }).eq("id", requestId).eq("brokerage_id", actor.brokerageId).eq("request_status", "pending").select("id")
  if (recErr || !rec || rec.length === 0) {
    // The envelope IS out — say so with its reference, so nobody sends a second one.
    return { ok: false, state: "refused", requestId, message: `The addendum went out for signature${dispatch.envelopeId ? ` (reference ${dispatch.envelopeId})` : ""}, but its status could not be saved here. Do not send it again; platform support can link the signed copy back to this deal.` }
  }
  await stampProposal(svc, actor.brokerageId, ctx.proposal, { signature_request_id: requestId })
  await dep(deps, "event")(svc, actor.brokerageId, {
    event_type: "contract_sent_for_signature", source: "ui", user_id: actor.userId,
    entity_type: ctx.transactionId ? "transaction" : "offer", entity_id: (ctx.transactionId ?? ctx.rootOfferId) as string,
    payload: { kind: ctx.proposal.source, proposed_version_id: ctx.proposal.id, signature_request_id: requestId, provider: evidencePatch.provider, envelope_id: dispatch.envelopeId ?? null, status, recipients: plan.recipients.length, routed: plan.routed.map((r) => r.side) },
    dedupe_key: `addendum-signatures-requested-${requestId}`,
  }).catch((err: unknown) => console.error(`[addendum-signatures] request ${requestId} sent; its lifecycle event was not written:`, (err as Error)?.message ?? err))
  const after = await requestEvidence(svc, actor.brokerageId, requestId)
  return { ok: true, replayed: false, requestId, status, display: describeAddendumRequest(status, after ?? { ...(priorEvidence ?? {}), ...evidencePatch }), handoff: dispatch.handoff ?? null }
}

async function requestEvidence(svc: Svc, brokerageId: string, requestId: string): Promise<Record<string, any> | null> {
  // A refused read is SAID (CLAUDE.md §3) and returns null — a caller must never merge `{}` over the stored record and overwrite it.
  const { data, error } = await svc.from("signature_requests").select("evidence").eq("id", requestId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) { console.error(`[addendum-signatures] request ${requestId} record could not be read: ${error.message}`); return null }
  return (((data as any)?.evidence ?? {}) as Record<string, any>)
}

/** Add to a PROPOSED version's evidence (m986 freezes executed rows only; a proposal's evidence is its working record). */
async function stampProposal(svc: Svc, brokerageId: string, p: ProposalRow, patch: Record<string, unknown>): Promise<boolean> {
  const { data: cur } = await svc.from("contract_term_versions").select("evidence").eq("id", p.id).eq("brokerage_id", brokerageId).maybeSingle()
  const { data, error } = await svc.from("contract_term_versions").update({ evidence: { ...(((cur as any)?.evidence ?? {}) as Record<string, unknown>), ...patch } }).eq("id", p.id).eq("brokerage_id", brokerageId).eq("status", "proposed").select("id")
  if (error || !data || data.length === 0) { console.error(`[addendum-signatures] proposal ${p.id}: evidence not stamped (${error?.message ?? "no proposed row matched"})`); return false }
  return true
}

// ─── the one transition writer ─────────────────────────────────────────────────────────────────────────────────────────────

const HOP_WORDS: Partial<Record<SignatureRequestStatus, { title: string; priority: "medium" | "high" }>> = {
  partially_signed: { title: "Addendum partly signed", priority: "medium" },
  completed: { title: "Addendum fully signed", priority: "medium" },
  declined: { title: "Addendum declined", priority: "high" },
  cancelled: { title: "Addendum request voided", priority: "medium" },
  expired: { title: "Addendum request expired", priority: "high" },
  failed: { title: "Addendum not sent", priority: "high" },
}

/**
 * Move one request — COMPARE-AND-SET on its current status (`.eq("request_status", from)`), rows counted. Only the writer that
 * wins the transition rings the bell, so a redelivered webhook or a concurrent poll never notifies twice. Never throws.
 */
async function advanceRequest(svc: Svc, brokerageId: string, row: { id: string; request_status: string; evidence: Record<string, any> | null }, to: SignatureRequestStatus, evidencePatch: Record<string, unknown>, opts: { extra?: Record<string, unknown>; quiet?: boolean } = {}): Promise<{ ok: true; changed: boolean } | { ok: false; reason: string }> {
  const verdict = canAdvanceSignatureRequest(row.request_status, to)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }
  const prior = await requestEvidence(svc, brokerageId, row.id)
  if (prior === null) return { ok: false, reason: "the signature request's record could not be read — nothing was changed" }
  const current = { ...prior }
  if (verdict.noop) {
    if (Object.keys(evidencePatch).length) {
      const { error: noopErr } = await svc.from("signature_requests").update({ evidence: { ...current, ...evidencePatch } }).eq("id", row.id).eq("brokerage_id", brokerageId).eq("request_status", to)
      if (noopErr) console.error(`[addendum-signatures] request ${row.id} evidence not stamped (${to}): ${noopErr.message}`)
    }
    return { ok: true, changed: false }
  }
  const { data, error } = await svc.from("signature_requests").update({ request_status: to, evidence: { ...current, ...evidencePatch }, ...(opts.extra ?? {}) }).eq("id", row.id).eq("brokerage_id", brokerageId).eq("request_status", row.request_status).select("id, transaction_id, evidence")
  if (error) return { ok: false, reason: `signature_requests write refused: ${error.message}` }
  if (!data || data.length === 0) return { ok: true, changed: false } // another writer won this transition — it rang the bell
  const words = HOP_WORDS[to]
  if (words && !opts.quiet) await bell(svc, brokerageId, data[0] as any, to, words.title, words.priority)
  return { ok: true, changed: true }
}

async function bell(svc: Svc, brokerageId: string, row: { id: string; transaction_id: string | null; evidence: Record<string, any> | null }, to: SignatureRequestStatus, title: string, priority: "medium" | "high"): Promise<void> {
  const ev = (row.evidence ?? {}) as Record<string, any>
  const recipients = [...new Set([ev.requested_by, ev.agent_user_id].filter(Boolean) as string[])]
  if (recipients.length === 0) return
  const d = describeAddendumRequest(to, ev)
  const entity = row.transaction_id ? { entity_type: "transaction", entity_id: row.transaction_id } : ev.root_offer_id ? { entity_type: "offer", entity_id: ev.root_offer_id as string } : { entity_type: "signature_request", entity_id: row.id }
  const { error } = await svc.from("notifications").insert(recipients.map((uid) => ({
    user_id: uid, brokerage_id: brokerageId, type: `esign.addendum.${to}`, title, body: `${d.detail}${d.action ? ` Next: ${d.action}.` : ""} Reference: ${row.id}`.slice(0, 480),
    priority, channel: "in_app", is_read: false, ...entity,
  })))
  if (error) console.error(`[addendum-signatures] request ${row.id} → ${to}: the bell was not written (${error.message})`)
}

// ─── provider events (webhooks) ────────────────────────────────────────────────────────────────────────────────────────────

async function requestByEnvelope(svc: Svc, brokerageId: string, envelopeId: string): Promise<{ ok: true; row: Record<string, any> | null } | { ok: false; reason: string }> {
  const { data, error } = await svc.from("signature_requests").select(REQUEST_COLUMNS).eq("brokerage_id", brokerageId).eq("provider_envelope_id", envelopeId).not("contract_term_version_id", "is", null).order("created_at", { ascending: false }).limit(1)
  if (error) return { ok: false, reason: `signature_requests read refused: ${error.message}` }
  return { ok: true, row: ((data ?? [])[0] as Record<string, any> | undefined) ?? null }
}

/** Does this envelope belong to an addendum signature request in this tenant? (the webhook router's question). */
export async function isAddendumEnvelope(svc: Svc, brokerageId: string, envelopeId: string): Promise<boolean> {
  const r = await requestByEnvelope(svc, brokerageId, envelopeId)
  return r.ok && !!r.row
}

/**
 * A provider event that is NOT a completion — delivered / viewed (stamped, the status stays `sent`), declined / voided / expired /
 * undeliverable (terminal). The tenant is the envelope's resolved brokerage (the caller's resolveEnvelopeBrokerageId). Never throws.
 */
export async function applyAddendumProviderEvent(svc: Svc, input: { brokerageId: string; envelopeId: string; provider: string; event: string | null; status: string | null; reason?: string | null }, deps: AddendumSignatureDeps = {}): Promise<{ matched: boolean; changed: boolean; to: SignatureRequestStatus | null; refused?: string }> {
  const found = await requestByEnvelope(svc, input.brokerageId, input.envelopeId)
  if (!found.ok) return { matched: false, changed: false, to: null, refused: found.reason }
  if (!found.row) return { matched: false, changed: false, to: null }
  const row = found.row
  const outcome = providerEventOutcome(input.event, input.status)
  const at = iso(nowOf(deps))
  if (outcome.stamp) {
    if (!isLiveSignatureRequest(row.request_status)) return { matched: true, changed: false, to: null }
    const ev = { ...(row.evidence ?? {}) }
    if (ev[outcome.stamp]) return { matched: true, changed: false, to: null } // the first instant stands; a redelivery changes nothing
    const { data, error: stampErr } = await svc.from("signature_requests").update({ evidence: { ...ev, [outcome.stamp]: at } }).eq("id", row.id).eq("brokerage_id", input.brokerageId).eq("request_status", row.request_status).select("id")
    if (stampErr) console.error(`[addendum-signatures] request ${row.id} ${outcome.stamp} not stamped: ${stampErr.message}`)
    return { matched: true, changed: !stampErr && !!data && data.length > 0, to: null }
  }
  if (!outcome.to) return { matched: true, changed: false, to: null }
  const patch: Record<string, unknown> = { provider_event: input.event ?? input.status ?? null, provider_event_at: at }
  if (outcome.to === "cancelled") patch.void_reason = "voided at the e-sign provider"
  if (outcome.to === "failed") patch.failure = "the provider could not deliver it to a signer — check the signer's email address"
  const r = await advanceRequest(svc, input.brokerageId, row as any, outcome.to, patch)
  if (!r.ok) return { matched: true, changed: false, to: outcome.to, refused: r.reason }
  if (r.changed && (outcome.to === "declined" || outcome.to === "failed" || outcome.to === "expired")) {
    await dep(deps, "signal")({ brokerageId: input.brokerageId, fromManager: "compliance_officer", toManager: "deal_coordinator", signalType: "addendum_signature_request_stopped", message: `An addendum signature request ${outcome.to === "failed" ? "could not be delivered" : `was ${outcome.to}`} — the contract is unchanged; the agent decides the next step.`, entityType: "signature_request", entityId: row.id, payload: { to: outcome.to, envelopeId: input.envelopeId } }, svc).catch(() => ({ ok: false }))
  }
  return { matched: true, changed: r.changed, to: outcome.to }
}

// ─── completion (webhook completion or poll) ───────────────────────────────────────────────────────────────────────────────

type AddendumSyncResult =
  | { ok: true; noop: boolean; state: string; executed: boolean; versionNo?: number; awaiting?: "counterparty_agent"; held?: string }
  | { ok: false; reason: string; integrity?: "mismatch" }

/**
 * Read the provider's own account of the envelope and move the request: nobody signed → nothing; some required parties → partly
 * signed; every envelope signer → retrieve the signed copy (sha256 pinned on FIRST retrieval; a different copy later is refused
 * and flagged) → a side that signs through its agent still outstanding → waiting on them; otherwise → the EXECUTED version
 * through the ONE recorder. Idempotent: a completed request is a no-op; a replayed completion records nothing twice.
 */
export async function syncAddendumSignatureRequest(svc: Svc, input: { brokerageId: string; requestId?: string; envelopeId?: string; source: "webhook" | "cron" }, deps: AddendumSignatureDeps = {}): Promise<AddendumSyncResult> {
  let row: Record<string, any> | null = null
  if (input.requestId) {
    const { data, error } = await svc.from("signature_requests").select(REQUEST_COLUMNS).eq("id", input.requestId).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (error) return { ok: false, reason: `signature_requests read refused: ${error.message}` }
    row = (data as Record<string, any> | null) ?? null
  } else if (input.envelopeId) {
    const r = await requestByEnvelope(svc, input.brokerageId, input.envelopeId)
    if (!r.ok) return { ok: false, reason: r.reason }
    row = r.row
  }
  if (!row || !row.contract_term_version_id) return { ok: false, reason: "no addendum signature request matches" }
  if (!isLiveSignatureRequest(row.request_status)) return { ok: true, noop: true, state: row.request_status, executed: !!row.evidence?.executed_version_id }
  const ev = (row.evidence ?? {}) as Record<string, any>
  if (!row.provider_envelope_id || !ev.provider || ev.provider === "google_esign") return { ok: true, noop: true, state: row.request_status, executed: false } // a hand-off: completed by the filed copy

  let client: ProviderClient
  try { client = await dep(deps, "provider")({ brokerageId: input.brokerageId, userId: (ev.requested_by as string | null) ?? null, provider: String(ev.provider) }) }
  catch (err) { return { ok: false, reason: `the e-sign account that sent this envelope could not be reached: ${(err as Error)?.message ?? err}` } }
  const [status, docs] = await Promise.all([
    client.getSignatureStatus(row.provider_envelope_id).catch((e) => ({ success: false, total: 0, signed: 0, pending: 0, percentComplete: 0, error: String(e) })),
    client.syncDocuments({ externalTransactionId: row.provider_envelope_id, contactId: row.contact_id ?? "", transactionId: row.transaction_id ?? undefined }).catch((e) => ({ success: false, error: String(e) } as { success: false; error: string; documents?: undefined })),
  ])
  if (!status.success && !docs.success) return { ok: false, reason: `the provider's status could not be read: ${status.error ?? (docs as any).error ?? "unknown"}` }

  const parties = (row.all_parties ?? {}) as { recipients?: Array<{ email: string; role: string }>; required?: AddendumRoutingPlan["required"]; routed?: AddendumRoutingPlan["routed"] }
  const required = parties.required ?? []
  const providerDocs = (docs.success ? docs.documents ?? [] : [])
  const signers = providerDocs.flatMap((d) => d.signers ?? []).map((s) => ({ email: s.email ?? null, signedAt: s.signedAt ?? null }))
  const allRecipientsSigned = status.success && status.total > 0 && status.signed >= status.total && status.total >= (parties.recipients?.length ?? 1)
  const verdict = requiredSignaturesFrom(required, signers, allRecipientsSigned)
  const partyState = { signed: verdict.signed.map((r) => ({ side: r.side, role: r.role, email: r.email })), missing: verdict.missing.map((r) => ({ side: r.side, role: r.role, route: r.route })), read_at: iso(nowOf(deps)) }

  if (!verdict.envelopeComplete) {
    if (verdict.signed.length === 0) return { ok: true, noop: true, state: row.request_status, executed: false }
    const r = await advanceRequest(svc, input.brokerageId, row as any, "partially_signed", { party_state: partyState })
    return r.ok ? { ok: true, noop: !r.changed, state: "partially_signed", executed: false } : { ok: false, reason: r.reason }
  }

  // EVERY envelope signer signed — the signed copy, its hash pinned the FIRST time it is retrieved.
  const signedDoc = providerDocs.find((d) => d.isSigned && d.url) ?? null
  if (!signedDoc?.url) return { ok: false, reason: "the provider reports every signer done but has not released the signed copy yet — the next poll retries" }
  const got = await dep(deps, "fetchBytes")(signedDoc.url)
  if (!got.ok) return { ok: false, reason: `the signed copy could not be retrieved: ${got.error}` }
  const hash = sha256(got.bytes)
  if (ev.signed_sha256 && ev.signed_sha256 !== hash) return flagIntegrity(svc, input.brokerageId, row, hash, deps)

  let signedDocumentId = (ev.signed_document_id as string | undefined) ?? null
  if (!signedDocumentId) {
    const stored = await dep(deps, "storeSignedCopy")(svc, {
      brokerageId: input.brokerageId, contactId: row.contact_id ?? null, transactionId: row.transaction_id ?? null, offerId: (ev.root_offer_id as string | null) ?? null,
      requestId: row.id, bytes: got.bytes, sha256: hash, fileName: signedDoc.documentName || `Signed ${ev.kind ?? "addendum"}.pdf`,
      metadata: { envelope_id: row.provider_envelope_id, provider: ev.provider, signature_request_id: row.id, contract_term_version_id: row.contract_term_version_id, is_signed: true, signers: signers },
    })
    if (!stored.ok) return { ok: false, reason: stored.error }
    signedDocumentId = stored.documentId
    // The PROVIDER's attestation, per signer, on the copy it signed — the recorder reads it (signature_completeness). Only the parties
    // the provider says signed; a routed side is absent until its own copy comes back. Source named; nothing is inferred.
    const signatures = verdict.signed.map((r) => ({ signer_role: signatureRoleOf(r.role) ?? r.role, signed: true, email: r.email, source: "esign_provider", envelope_id: row!.provider_envelope_id, signed_at: signers.find((s) => s.email && r.email && s.email.toLowerCase() === r.email)?.signedAt ?? null }))
    const { data: sc, error: scErr } = await svc.from("documents").update({ signature_completeness: { source: "esign_provider_attested", signatures } }).eq("id", signedDocumentId).eq("brokerage_id", input.brokerageId).select("id")
    if (scErr || !sc || sc.length === 0) return { ok: false, reason: `the signed copy is filed but its signatures could not be recorded (${scErr?.message ?? "no row matched"})` }
  }
  const pinned = { signed_sha256: hash, signed_document_id: signedDocumentId, signed_retrieved_at: (ev.signed_retrieved_at as string | undefined) ?? iso(nowOf(deps)), party_state: partyState }
  const completedAt = signers.map((s) => s.signedAt).filter(Boolean).sort().pop() ?? iso(nowOf(deps))

  if (verdict.missing.some((r) => r.route === "counterparty_agent")) {
    const r = await advanceRequest(svc, input.brokerageId, row as any, "partially_signed", { ...pinned, awaiting: "counterparty_agent" })
    if (!r.ok) return { ok: false, reason: r.reason }
    return { ok: true, noop: !r.changed, state: "partially_signed", executed: false, awaiting: "counterparty_agent" }
  }
  // pin first (a crash after this point leaves the hash recorded for the replay to compare against)
  const { error: pinErr } = await svc.from("signature_requests").update({ evidence: { ...ev, ...pinned } }).eq("id", row.id).eq("brokerage_id", input.brokerageId).eq("request_status", row.request_status)
  // Never execute on an UNPINNED copy: the pinned hash is what a later copy is compared against. The next sync retries.
  if (pinErr) return { ok: false, reason: `the signed copy's fingerprint could not be recorded (${pinErr.message}) — it was not executed; the next sync retries` }
  return executeSignedAddendum(svc, input.brokerageId, { ...row, evidence: { ...ev, ...pinned } }, signedDocumentId, completedAt, deps, { mode: "provider", recordedBy: (ev.requested_by as string | null) ?? null })
}

async function flagIntegrity(svc: Svc, brokerageId: string, row: Record<string, any>, hash: string, deps: AddendumSignatureDeps): Promise<AddendumSyncResult> {
  const ev = { ...(row.evidence ?? {}) }
  const alerts = Array.isArray(ev.integrity_alerts) ? ev.integrity_alerts : []
  if (!alerts.some((a: any) => a.sha256 === hash)) {
    const { error: alertErr } = await svc.from("signature_requests").update({ evidence: { ...ev, integrity_alerts: [...alerts, { sha256: hash, at: iso(nowOf(deps)) }] } }).eq("id", row.id).eq("brokerage_id", brokerageId)
    if (alertErr) console.error(`[addendum-signatures] request ${row.id} integrity alert not recorded on the request (the compliance signal below still goes): ${alertErr.message}`)
    await dep(deps, "signal")({ brokerageId, fromManager: "deal_coordinator", toManager: "compliance_officer", signalType: "addendum_signed_copy_mismatch", message: "A signed copy of an addendum arrived that does not match the copy first retrieved from the e-sign provider. It was not recorded; the first copy stands. Review it before anything else is filed.", entityType: "signature_request", entityId: row.id, payload: { pinned: ev.signed_sha256, offered: hash } }, svc).catch(() => ({ ok: false }))
  }
  return { ok: false, reason: "the signed copy does not match the copy first retrieved — refused and flagged for compliance", integrity: "mismatch" }
}

/**
 * The EXECUTED version, through lane 152E's ONE recorder (both signatures read from the document, per-term evidence, the
 * consequences: compliance re-check of the changed terms, closing date, settlement, CDA, the deal team's notice). Shared by the
 * provider completion and a filed signed copy. On a refusal: a PROVIDER-completed envelope is HELD (completed, not recorded) for a
 * person; a FILED copy returns the reason and the request does not move (the copy may simply not have been read for signatures yet).
 */
async function executeSignedAddendum(svc: Svc, brokerageId: string, row: Record<string, any>, signedDocumentId: string, executedAtIso: string, deps: AddendumSignatureDeps, opts: { mode: "provider" | "filed"; recordedBy: string | null }): Promise<AddendumSyncResult> {
  const ev = (row.evidence ?? {}) as Record<string, any>
  if (ev.executed_version_id) return { ok: true, noop: true, state: row.request_status, executed: true, versionNo: ev.executed_version_no }
  const p = await loadProposal(svc, brokerageId, row.contract_term_version_id)
  if (!p.ok) return { ok: false, reason: p.message }
  const proposal = p.row
  const hold = async (why: string, detail: string | null): Promise<AddendumSyncResult> => {
    if (opts.mode === "filed") return { ok: false, reason: `Not recorded: ${why}${detail && detail !== why ? ` (${detail})` : ""}.` }
    const r = await advanceRequest(svc, brokerageId, row as any, "completed", { record_refused: why, record_refused_detail: detail, held_at: iso(nowOf(deps)) }, { extra: { completed_at: iso(nowOf(deps)) } })
    await dep(deps, "signal")({ brokerageId, fromManager: "deal_coordinator", toManager: "compliance_officer", signalType: "addendum_execution_held", message: `A fully signed addendum was not recorded as executed: ${why}. The contract is unchanged until a person resolves it.`, entityType: "signature_request", entityId: row.id, payload: { detail } }, svc).catch(() => ({ ok: false }))
    return r.ok ? { ok: true, noop: !r.changed, state: "completed", executed: false, held: why } : { ok: false, reason: r.reason }
  }
  if (proposal.status !== "proposed") return hold("the proposal is no longer open (it was withdrawn or replaced after this request went out)", proposal.status)
  if (ev.packet_fingerprint && ev.packet_fingerprint !== packetFingerprint(proposal)) return hold("the proposal changed after it was sent for signature, so what was signed is not what is on file", "packet fingerprint mismatch")

  const pe = proposal.evidence
  const rec = await dep(deps, "recordExecuted")(svc, {
    brokerageId, rootOfferId: proposal.root_offer_id, transactionId: proposal.transaction_id ?? row.transaction_id ?? null,
    source: proposal.source as RecordVersionInput["source"], status: "executed", terms: proposal.terms, documentId: signedDocumentId, executedAt: executedAtIso,
    recordedBy: opts.recordedBy,
    evidence: {
      recorded_via: "addendum_signature_request", signature_request_id: row.id, envelope_id: row.provider_envelope_id ?? null, provider: ev.provider ?? null,
      signed_sha256: ev.signed_sha256 ?? null, packet_fingerprint: ev.packet_fingerprint ?? null, proposed_version_id: proposal.id, proposed_version_no: proposal.version_no,
      executed_on: executedAtIso.slice(0, 10), signed_copy: opts.mode === "provider" ? "retrieved_from_provider" : "filed_by_user",
      ...(pe.effective_on ? { effective_on: pe.effective_on } : {}), ...(pe.term_evidence_stated ? { term_evidence_stated: pe.term_evidence_stated } : {}),
    },
  })
  if (!rec.ok) return hold("the signed copy did not pass the contract record's checks — compliance reviews it", rec.reason)

  // a held request is already `completed`: the same status again is the ladder's no-op, which still stamps the evidence
  const done = await advanceRequest(svc, brokerageId, row as any, "completed", { executed_version_id: rec.id, executed_version_no: rec.versionNo, executed_at: executedAtIso, record_refused: null, ...(opts.mode === "filed" ? { filed_by: opts.recordedBy } : {}) }, { extra: { completed_at: iso(nowOf(deps)) } })
  const { data: closed, error: closeErr } = await svc.from("contract_term_versions").update({ status: "void", evidence: { ...proposal.evidence, closed_as: "executed", executed_version_id: rec.id, executed_version_no: rec.versionNo, signature_request_id: row.id } }).eq("id", proposal.id).eq("brokerage_id", brokerageId).eq("status", "proposed").select("id")
  if (closeErr || !closed || closed.length === 0) console.error(`[addendum-signatures] proposal ${proposal.id} executed as version ${rec.versionNo}; the proposal was not closed (${closeErr?.message ?? "no proposed row matched"})`)
  const entityId = (proposal.transaction_id ?? row.transaction_id ?? proposal.root_offer_id) as string
  await dep(deps, "event")(svc, brokerageId, {
    event_type: "contract.addendum.recorded", source: "webhook", entity_type: proposal.transaction_id ?? row.transaction_id ? "transaction" : "offer", entity_id: entityId,
    payload: { kind: proposal.source, version_no: rec.versionNo, document_id: signedDocumentId, executed_on: executedAtIso.slice(0, 10), terms: Object.keys(proposal.terms), via: "signature_request", signature_request_id: row.id, proposed_version_id: proposal.id },
    dedupe_key: `addendum-executed-${row.id}`,
  }).catch((err: unknown) => console.error(`[addendum-signatures] version ${rec.versionNo} recorded; its lifecycle event was not written:`, (err as Error)?.message ?? err))
  if (!done.ok) return { ok: false, reason: unsaved(`The addendum is recorded as executed version ${rec.versionNo}, but this request's status could not be updated`, done.reason, "Refresh the deal; platform support can reconcile the request if it still shows as open.") }
  return { ok: true, noop: false, state: "completed", executed: true, versionNo: rec.versionNo }
}

// ─── the sender's own moves ────────────────────────────────────────────────────────────────────────────────────────────────

async function loadRequestForActor(svc: Svc, actor: AddendumActor, requestId: string): Promise<{ ok: true; row: Record<string, any>; ctx: SigningContext } | Fail> {
  const { data, error } = await svc.from("signature_requests").select(REQUEST_COLUMNS).eq("id", requestId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (error) return unreadable("The signature request", error.message)
  if (!data || !(data as any).contract_term_version_id) return fail("not_found", "That addendum signature request is not on file for your account.")
  const loaded = await loadSigningContext(svc, actor.brokerageId, (data as any).contract_term_version_id)
  if (!loaded.ok) return loaded
  const auth = await authorize(svc, actor, loaded.ctx)
  if (!auth.ok) return auth
  return { ok: true, row: data as Record<string, any>, ctx: loaded.ctx }
}

/**
 * VOID a live request — at the provider first (the account that sent it), then here. A change to the addendum after it was sent is
 * a void + a NEW proposal and request: nothing already sent is edited. A provider that refuses the void leaves the request live.
 */
export async function voidAddendumSignatureRequest(svc: Svc, actor: AddendumActor, input: { requestId: string; reason: string }, deps: AddendumSignatureDeps = {}): Promise<{ ok: true; providerVoided: boolean } | Fail> {
  const loaded = await loadRequestForActor(svc, actor, input.requestId)
  if (!loaded.ok) return loaded
  const { row } = loaded
  if (!isLiveSignatureRequest(row.request_status)) return fail("finished", "This request has already finished, so there is nothing to void.")
  const ev = (row.evidence ?? {}) as Record<string, any>
  let providerVoided = false
  if (row.provider_envelope_id && ev.provider && ev.provider !== "google_esign") {
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    const client = await dep(deps, "provider")({ brokerageId: actor.brokerageId, userId: (ev.requested_by as string | null) ?? actor.userId, provider: String(ev.provider) }).catch(() => null)
    if (!client) return fail("provider_unreachable", "The e-sign account that sent this addendum could not be reached, so it is still out for signature. Try again, or void it in that e-sign account directly.")
    const v = await withActionLedger<{ success: boolean; error?: string }>({
      brokerageId: actor.brokerageId, action: "contract.addendum_signatures.void", actor: { type: "user", userId: actor.userId },
      subject: { type: "signature_request", id: row.id, ref: row.provider_envelope_id }, reasonCode: "HUMAN_REQUESTED", reasonDetail: input.reason.slice(0, 200),
      idempotencyKey: `addendum-signatures-void:${row.id}`, channel: "esign", riskClass: "LEGAL",
    }, () => client.voidTransaction({ externalTransactionId: row.provider_envelope_id, reason: input.reason }), {
      settle: (r) => r.success ? { status: "executed", outcome: "voided", provider: String(ev.provider), providerRef: row.provider_envelope_id } : { status: "failed", outcome: "provider_refused", provider: String(ev.provider), error: r.error ?? null },
      replay: (claim) => claim.kind === "refused" ? { success: false, error: `the void could not be recorded on the action ledger (${claim.error}) — it was not voided` } : { success: true },
    }, { client: svc }).catch((e) => ({ success: false, error: String(e) }))
    if (!v.success) { console.error(`[addendum-signatures] void of request ${row.id} refused by the provider: ${v.error}`); return fail("provider_refused", "The e-sign provider did not void it, so the addendum is still out for signature. Try again, or void it in that e-sign account directly.") }
    providerVoided = true
  }
  const r = await advanceRequest(svc, actor.brokerageId, row as any, "cancelled", { void_reason: input.reason.slice(0, 200), voided_by: actor.userId, voided_at: iso(nowOf(deps)), ...(providerVoided ? {} : { void_note: "withdrawn here; if it was already sent from your own e-sign window, cancel it there too" }) })
  if (!r.ok) return fail("refused", unsaved(providerVoided ? "It was voided at the e-sign provider, but the void could not be recorded here" : "The void could not be recorded", r.reason, providerVoided ? "Nothing it carried can be signed; refresh the deal — platform support can reconcile the status." : "It is still open. Try again in a moment."))
  return { ok: true, providerVoided }
}

/** Withdraw a proposal (void its live request first). A revised addendum is a NEW proposal; the old one stays in the history. */
export async function withdrawProposedAddendum(svc: Svc, actor: AddendumActor, input: { versionId: string; reason: string }, deps: AddendumSignatureDeps = {}): Promise<{ ok: true } | Fail> {
  const loaded = await loadSigningContext(svc, actor.brokerageId, input.versionId)
  if (!loaded.ok) return loaded
  const auth = await authorize(svc, actor, loaded.ctx)
  if (!auth.ok) return auth
  if (loaded.ctx.proposal.status !== "proposed") return fail("not_proposed", "This addendum is no longer a proposal.")
  const live = await liveRequestFor(svc, actor.brokerageId, input.versionId)
  if (!live.ok) return live
  if (live.row) {
    const v = await voidAddendumSignatureRequest(svc, actor, { requestId: live.row.id, reason: input.reason }, deps)
    if (!v.ok) return v
  }
  const p = loaded.ctx.proposal
  const { data, error } = await svc.from("contract_term_versions").update({ status: "void", evidence: { ...p.evidence, closed_as: "withdrawn", withdrawn_by: actor.userId, withdrawn_at: iso(nowOf(deps)), withdrawn_reason: input.reason.slice(0, 200) } }).eq("id", p.id).eq("brokerage_id", actor.brokerageId).eq("status", "proposed").select("id")
  if (error) return fail("refused", unsaved("The proposal could not be withdrawn", error.message, "It is still a proposal. Try again in a moment."))
  if (!data || data.length === 0) return fail("refused", "The proposal changed while you withdrew it. Reload and try again.")
  return { ok: true }
}

/** ONE rule for "a person may file the signed copy against this request": a signed request that was HELD (retried on the provider's
 *  own copy), our side signed and the other side signs through its agent, or a hand-off (own Drive / download) still open. */
function fileableState(row: Record<string, any>): { held: boolean; fileable: boolean } {
  const ev = (row.evidence ?? {}) as Record<string, any>
  const held = row.request_status === "completed" && !ev.executed_version_id && !!ev.record_refused
  const routedWait = row.request_status === "partially_signed" && ev.awaiting === "counterparty_agent"
  const handoff = isLiveSignatureRequest(row.request_status) && (ev.provider === "google_esign" || !row.provider_envelope_id)
  return { held, fileable: held || routedWait || handoff }
}

/**
 * FILE A SIGNED COPY against a request: the copy the other side's agent returned (the routed side signed), or the copy signed from
 * the sender's own Drive (a hand-off), or a retry of a signed request that was held. The recorder still reads BOTH signatures on the
 * document — a person's upload never asserts them. An envelope the provider completed keeps ITS copy: another file is refused.
 */
export async function fileSignedAddendumCopy(svc: Svc, actor: AddendumActor, input: { requestId: string; documentId?: string | null; executedOn: string }, deps: AddendumSignatureDeps = {}): Promise<AddendumSyncResult> {
  const loaded = await loadRequestForActor(svc, actor, input.requestId)
  if (!loaded.ok) return { ok: false, reason: loaded.message }
  const { row } = loaded
  const ev = (row.evidence ?? {}) as Record<string, any>
  const { held, fileable } = fileableState(row)
  if (!fileable) return { ok: false, reason: row.request_status === "completed" ? "This addendum is already signed and recorded." : "This request is still with the e-sign provider — its signed copy comes back automatically." }
  let documentId = input.documentId ?? null
  if (held) {
    if (documentId && ev.signed_document_id && documentId !== ev.signed_document_id) return { ok: false, reason: "The e-sign provider's signed copy is the record for this request — a different file is not filed in its place.", integrity: "mismatch" }
    documentId = (ev.signed_document_id as string | undefined) ?? documentId
  }
  if (!documentId) return { ok: false, reason: "Upload the fully signed copy first." }
  const { data: doc, error } = await svc.from("documents").select("id").eq("id", documentId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (error) return { ok: false, reason: unreadable("The signed copy", error.message).message }
  if (!doc) return { ok: false, reason: "That signed copy is not on file for your account." }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.executedOn) || new Date(`${input.executedOn}T00:00:00.000Z`).toISOString().slice(0, 10) !== input.executedOn) return { ok: false, reason: "Give the date the last party signed, as yyyy-mm-dd." }
  if (new Date(`${input.executedOn}T00:00:00.000Z`).getTime() > nowOf(deps).getTime() + 86_400_000) return { ok: false, reason: "A signature date cannot be in the future." }
  // A held request retries on the provider's own copy; a routed / hand-off request is executed from the filed copy. Either way the
  // recorder reads the signatures on the document — and a refusal is returned to the person, the request unchanged.
  return executeSignedAddendum(svc, actor.brokerageId, row, documentId, `${input.executedOn}T23:59:59.999Z`, deps, { mode: "filed", recordedBy: actor.userId })
}

// ─── the sweep leg (lib/transactions/esign-doc-sync-sweep.ts) ───────────────────────────────────────────────────────────────

export interface AddendumSweepResult { examined: number; polled: number; executed: number; expired: number; nudged: number; escalated: number; errors: string[] }

/**
 * The autonomous half: every LIVE addendum request — past its expiry → expired (the agent and the deal coordinator hear it);
 * an API envelope → read the provider (a provider with no webhook, or a webhook that was lost); stalled past the chase windows
 * (lib/kernel/signature-chase.ts NUDGE_HOURS / ESCALATE_HOURS) → ONE nudge to the sender (when they kept reminders on) and ONE
 * escalation to the deal coordinator's queue. No client egress: the provider reminds signers; people call people.
 */
export async function sweepAddendumSignatureRequests(svc: Svc, deps: AddendumSignatureDeps = {}, opts: { limit?: number } = {}): Promise<AddendumSweepResult> {
  const out: AddendumSweepResult = { examined: 0, polled: 0, executed: 0, expired: 0, nudged: 0, escalated: 0, errors: [] }
  const { data, error } = await svc.from("signature_requests").select(REQUEST_COLUMNS).not("contract_term_version_id", "is", null).in("request_status", [...LIVE_SIGNATURE_REQUEST_STATUSES]).limit(opts.limit ?? 200)
  if (error) { out.errors.push(`signature_requests read refused: ${error.message}`); return out }
  const now = nowOf(deps)
  for (const row of (data ?? []) as Array<Record<string, any>>) {
    out.examined++
    const b = row.brokerage_id as string
    if (!b) continue
    try {
      if (row.expires_at && new Date(row.expires_at).getTime() < now.getTime()) {
        const r = await advanceRequest(svc, b, row as any, "expired", { expired_at: iso(now) })
        if (r.ok && r.changed) {
          out.expired++
          await dep(deps, "signal")({ brokerageId: b, fromManager: "compliance_officer", toManager: "deal_coordinator", signalType: "addendum_signature_request_stopped", message: "An addendum signature request expired before every party signed — the contract is unchanged; the agent decides whether to send a new request.", entityType: "signature_request", entityId: row.id, payload: { to: "expired" } }, svc).catch(() => ({ ok: false }))
        }
        continue
      }
      const ev = (row.evidence ?? {}) as Record<string, any>
      if (row.provider_envelope_id && ev.provider && ev.provider !== "google_esign" && ev.awaiting !== "counterparty_agent") {
        out.polled++
        const s = await syncAddendumSignatureRequest(svc, { brokerageId: b, requestId: row.id, source: "cron" }, deps)
        if (s.ok && s.executed && !s.noop) out.executed++
        if (!s.ok) out.errors.push(`request ${row.id}: ${s.reason}`)
        if (s.ok && !isLiveSignatureRequest(s.state)) continue
      }
      const anchor = row.sent_at ?? row.created_at
      const ageHours = anchor ? (now.getTime() - new Date(anchor).getTime()) / 3_600_000 : 0
      if (ageHours >= ESCALATE_HOURS && !ev.escalated_at) {
        const s = await dep(deps, "signal")({ brokerageId: b, fromManager: "compliance_officer", toManager: "deal_coordinator", signalType: "addendum_signature_stalled", message: `An addendum has waited ${Math.floor(ageHours / 24)} days for signatures — a call to the party usually settles it. The contract is unchanged until it is signed.`, entityType: "signature_request", entityId: row.id, payload: { status: row.request_status } }, svc).catch(() => ({ ok: false }))
        if (s.ok) {
          out.escalated++
          const prior = await requestEvidence(svc, b, row.id)
          if (prior === null) out.errors.push(`request ${row.id}: escalated, but its record could not be read to stamp it`)
          else {
            const { error: escErr } = await svc.from("signature_requests").update({ evidence: { ...prior, escalated_at: iso(now) } }).eq("id", row.id).eq("brokerage_id", b)
            if (escErr) out.errors.push(`request ${row.id}: escalated, but the stamp was refused (${escErr.message})`)
          }
        }
      } else if (ageHours >= NUDGE_HOURS && !ev.nudged_at && ev.reminders !== false && ev.requested_by) {
        const { error: nErr } = await svc.from("notifications").insert({ user_id: ev.requested_by, brokerage_id: b, type: "signature_chase", title: "An addendum is waiting on a signature", body: `It went out ${Math.floor(ageHours / 24)} days ago and is still ${row.request_status.replace(/_/g, " ")} — a personal nudge to the party settles most of these. Reference: ${row.id}`, priority: "medium", channel: "in_app", is_read: false, ...(row.transaction_id ? { entity_type: "transaction", entity_id: row.transaction_id } : {}) })
        if (nErr) out.errors.push(`request ${row.id}: nudge not written (${nErr.message})`)
        else {
          out.nudged++
          const prior = await requestEvidence(svc, b, row.id)
          if (prior === null) out.errors.push(`request ${row.id}: nudged, but its record could not be read to stamp it`)
          else {
            const { error: nudgeErr } = await svc.from("signature_requests").update({ evidence: { ...prior, nudged_at: iso(now) } }).eq("id", row.id).eq("brokerage_id", b)
            if (nudgeErr) out.errors.push(`request ${row.id}: nudged, but the stamp was refused (${nudgeErr.message})`)
          }
        }
      }
    } catch (err) {
      out.errors.push(`request ${row.id}: ${(err as Error)?.message ?? err}`)
    }
  }
  return out
}
