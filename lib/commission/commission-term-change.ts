// lib/commission/commission-term-change.ts — PRE-CLOSE COMMISSION TERM CHANGES (wave 153, lane 153B; owner ruling 4, 2026-11-14).
//
// Owner, verbatim: "anyone attached to the offer/listing/transaction that holds a seat or admin can change comission terms but
// not after a transaction has closed." Directive 153B: a seat holder ATTACHED to the deal, or an authorized admin of the tenant,
// submits through the existing governed financial writer; seat membership alone is not permission; a vendor / contact never;
// a proposed edit is not a signed modification where executed agreements govern (evidence + broker review); CLOSED / PAYOUT
// PENDING is closed; a post-close correction is a separately ledgered adjustment, never a mutation.
//
// SURVIVORS EXTENDED, nothing parallel (CLAUDE.md §1, LAW 2):
//   · the RECORD is public.commission_adjustments — the ledger already carrying the approval state machine (m850) — under its
//     own live mechanism 'rate_override' (zero rows, no writer until now). This module is that mechanism's ONE writer;
//     lib/commission/agent-concession.ts keeps the concession partition and refuses to decide a rate_override row. m902 adds
//     what the record lacked (listing anchor, requester, prior value, evidence, applied_at).
//   · the GOVERNING TERMS are the columns the existing readers already price from: transactions.commission_percentage (the
//     engine's stage 01 rate), offers.disclosed_buyer_commission_pct / _flat (the offer's commission term, read by closing
//     compliance and the seller net sheet), listings.commission_rate (the listing's rate, read by the net sheet and closing
//     cost accuracy). Nothing else is written — the executed agreement is never overwritten.
//   · "is an executed agreement governing this commission?" is answered by the engine's own reader
//     (waterfall/01-resolve-rate.ts governingClientAgreementRates) plus the offer contract's execution stamps.
//   · the RE-RUN is the canonical waterfall (lib/kernel/transactions.ts recalculateCommissionStateCommand → engine preview +
//     the deal stamp) — never a second calculator; the approval POLICY is the brokerage's existing setting
//     (brokerages.agent_concession_approval, resolved fail-closed by resolveAgentConcessionPolicy) — a rate cut spends the
//     brokerage's money exactly as a concession does; EVIDENCE is withActionLedger (decision ≠ attempt ≠ applied).
//   · the AFTER-CLOSE path is lib/kernel/financial.ts correctCommissionDistribution (reversal / adjustment rows, m689) — this
//     module refuses and names it; it never re-opens a closed deal or a released hold.
//
// AI never proposes, approves or applies a term change here: a person submits, a finance admin decides, the engine prices.
// Pure rules first (module-private — proved through the I/O functions by scripts/commission-term-change-guard.ts); the I/O half
// takes the service client and the SESSION actor (lib/agreements/session-actor.ts) and READS every { error } (§3).

import { BROKERAGE_FINANCE_ADMIN_USER_TYPES, TENANT_ADMIN_USER_TYPES, isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import type { AgreementActor } from "@/lib/agreements/agent-agreements"
import type { ActionContext } from "@/lib/kernel/action-ledger"
import { calendarDay } from "@/lib/agreements/agent-agreements"
import { AGENT_CONCESSION_REASON_MIN, resolveAgentConcessionPolicy } from "./agent-concession"
import { TRANSACTION_STATUSES_TERMINAL, inPipelineColumn } from "@/lib/transactions/transaction-status"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any }

/** The live commission_adjustments_adjustment_type_check member a term change is recorded under. */
const TERM_CHANGE = "rate_override"

/**
 * The seats that can EVER be a party to a tenant's commission terms: the tenant roster plus the two seats that work a
 * deal without administering the workspace — the agent and the transaction coordinator. DERIVED from the roster (spread,
 * never retyped — CLAUDE.md §4), so a ruling that moves the roster moves this with it. Every other stored seat — the
 * client, an outside vendor (a lender and a title agent are vendor CATEGORIES), the ISA desk, `system`, platform
 * `support` — is outside it, and so is a seat whose type could not be read: the test is POSITIVE, so it fails closed.
 *
 * (Was a hand-typed deny list, `NEVER_EDITS`. A deny list admits whatever it forgot to name — an unreadable or a newly
 * storable seat fell through to the attachment test — and it was a second role array in a module that already asks the
 * shared finance predicate, which scripts/finance-authority-simulator.ts refuses.)
 *
 * Membership is NOT permission: it only decides who is ever ASKED the attachment question below.
 */
const DEAL_SEAT_USER_TYPES: ReadonlySet<string> = new Set([...TENANT_ADMIN_USER_TYPES, "agent", "tc"])

/** offers.esign_status members that mean the contract is executed (the live CHECK's executed members). */
const OFFER_EXECUTED = new Set(["fully_signed", "fully_executed", "compliance_pending", "compliance_approved"])

/** listings.status members after which the listing's own terms are no longer live (the live CHECK). */
const LISTING_NOT_LIVE = new Set(["sold", "cancelled", "expired", "withdrawn", "off_market"])

// ─── PURE: the rules ──────────────────────────────────────────────────────────────────────────────────────────────

type AnchorKind = "transaction" | "offer" | "listing"
type ValueType = "percent" | "flat"
type ApproverRole = "finance_admin" | "deal_agent" | "team_lead" | "transaction_coordinator"

interface DealFacts {
  kind: AnchorKind
  id: string
  label: string | null
  stage: string | null
  agentIds: string[]
  coordinatorIds: string[]
  teamIds: string[]
  /** The governing values this anchor stores (only these may change). */
  current: { percent: number | null; flat: number | null }
  valueTypes: ValueType[]
  /** Sale price (transaction) · offer price (offer) · list price (listing) — the base the gross is shown at. */
  price: number | null
  listingId: string | null
  buyerContactId: string | null
  offerId: string | null
  /** Set when the deal's terms are frozen — the sentence says why and what to do instead. */
  frozen: string | null
}

/**
 * PURE — is this transaction's commission frozen? Closed (CLOSED / PAYOUT PENDING is closed) · fell through (lost / archived —
 * any earnest-money refund settles on the deal) · removed · finalized (CDA signed / final CD) · a payout approved or paid ·
 * a posted ledger entry. Each names the correction path: after close a change is a separately ledgered adjustment.
 */
function transactionFreeze(t: { status?: string | null; stage?: string | null; deleted_at?: string | null; commission_finalized_at?: string | null }, ledger: { posted: boolean; payoutDecided: boolean }): string | null {
  const correction = "a correction now is a separately ledgered adjustment a finance admin records on the commission breakdown — the closed terms are never rewritten"
  if (t.deleted_at) return "This deal was removed, so its commission terms cannot change."
  if (inPipelineColumn(t.status, "closed") || t.stage === "CLOSED") return `This deal is closed (including closed with the payout pending), so its commission terms are frozen; ${correction}.`
  if ((TRANSACTION_STATUSES_TERMINAL as readonly string[]).includes(String(t.status ?? ""))) return "This deal fell through, so its commission terms are no longer live (any earnest-money refund is settled on the deal). Reopen the deal before changing them."
  if (t.commission_finalized_at) return `This deal's commission is finalized (the CDA is signed or the final closing disclosure is in), so its terms are frozen; ${correction}.`
  if (ledger.payoutDecided) return `A commission payout on this deal is already approved or paid, so its terms are frozen; ${correction}.`
  if (ledger.posted) return `This deal's commission is already posted to the ledger, so its terms are frozen; ${correction}.`
  return null
}

/** PURE — who is asking, relative to THIS deal. Seat membership alone is never permission (directive B1). */
function termChangeAuthority(
  actor: AgreementActor,
  attached: { agentIds: string[]; teamLeadUserIds: string[]; coordinatorUserIds: string[] },
): { ok: true; role: ApproverRole; appliesDirectly: boolean } | { ok: false; error: string } {
  const type = String(actor.userType ?? "").toLowerCase()
  if (!DEAL_SEAT_USER_TYPES.has(type)) return { ok: false, error: "forbidden: client, vendor and system accounts never change a commission — the agent on the deal or a finance administrator can" }
  if (isBrokerageFinanceAdmin({ user_type: type, is_tenant_principal: actor.isTenantPrincipal })) return { ok: true, role: "finance_admin", appliesDirectly: true }
  if (actor.agentId && attached.agentIds.includes(actor.agentId)) return { ok: true, role: "deal_agent", appliesDirectly: false }
  if (attached.teamLeadUserIds.includes(actor.userId)) return { ok: true, role: "team_lead", appliesDirectly: false }
  if (attached.coordinatorUserIds.includes(actor.userId)) return { ok: true, role: "transaction_coordinator", appliesDirectly: false }
  return { ok: false, error: "not_attached: only someone attached to this listing, offer or deal — or a finance administrator — can change its commission" }
}

/**
 * PURE — does this change need the broker's decision before it takes effect?
 *   · an executed agreement governs and no executed evidence is named → REFUSED (a proposal is not a signed modification);
 *   · a finance admin applies directly (they ARE the broker review) — with the evidence when an executed agreement governs;
 *   · anyone else, where an executed agreement governs → requested (broker review always);
 *   · the deal's own agent where the brokerage EXPLICITLY requires no approval → applies; otherwise (undeclared included —
 *     fail closed) requested. A team lead or a TC always requests: neither holds the brokerage's books (m472).
 */
function termChangeApproval(input: { role: ApproverRole; appliesDirectly: boolean; executedGoverns: boolean; hasEvidence: boolean; policyRequiresApproval: boolean }):
  { ok: true; status: "not_required" | "requested" } | { ok: false; error: string } {
  if (input.executedGoverns && !input.hasEvidence) return { ok: false, error: "evidence_required: an executed agreement sets this commission — attach the executed amendment (or the signed agreement) the change rests on" }
  if (input.appliesDirectly) return { ok: true, status: "not_required" }
  if (input.executedGoverns) return { ok: true, status: "requested" }
  if (input.role === "deal_agent" && !input.policyRequiresApproval) return { ok: true, status: "not_required" }
  return { ok: true, status: "requested" }
}

/** PURE — refuse a malformed request by name. Money is never rounded on anyone's behalf. */
function validateRequest(input: TermChangeInput, facts: DealFacts | null): string | null {
  const anchors = [input.transactionId, input.offerId, input.listingId].filter(Boolean)
  if (anchors.length !== 1) return "anchor_invalid: name the listing, the offer or the deal — exactly one"
  if (input.valueType !== "percent" && input.valueType !== "flat") return "value_type_invalid: percent or flat"
  if (facts && !facts.valueTypes.includes(input.valueType)) return `value_type_invalid: this ${facts.kind} records its commission as a ${facts.valueTypes.join(" or ")}`
  const v = Number(input.value)
  if (!Number.isFinite(v) || v <= 0) return "value_invalid: a commission term is a positive amount"
  const decimals = String(input.value).includes(".") ? String(input.value).split(".")[1].length : 0
  if (input.valueType === "percent" && (v > 100 || decimals > 4)) return "value_invalid: a percent is at most 100, to at most 4 decimal places"
  if (input.valueType === "flat" && decimals > 2) return "value_invalid: at most 2 decimal places (cents)"
  if (String(input.reason ?? "").trim().length < AGENT_CONCESSION_REASON_MIN) return `reason_required: state why (at least ${AGENT_CONCESSION_REASON_MIN} characters) — it is kept as evidence`
  if (!calendarDay(input.effectiveDate)) return "effective_date_invalid: the date the change takes effect, yyyy-mm-dd"
  const key = String(input.idempotencyKey ?? "").trim()
  if (key.length < 8 || key.length > 120) return "idempotency_key_required: one key per submission, so a retried submit never records the change twice"
  if (facts) {
    const cur = input.valueType === "percent" ? facts.current.percent : facts.current.flat
    if (cur != null && Number(cur) === v) return "no_change: the commission already stands at that value"
  }
  return null
}

const fmt = (vt: ValueType, v: number | null) => (v == null ? "not set" : vt === "percent" ? `${v}%` : `$${v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`)
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v))

// ─── I/O: the deal as it stands ───────────────────────────────────────────────────────────────────────────────────

export interface TermChangeAnchor { transactionId?: string | null; offerId?: string | null; listingId?: string | null }

async function readTransactionFacts(db: Db, brokerageId: string, transactionId: string): Promise<{ ok: true; facts: DealFacts } | { ok: false; error: string }> {
  const { data: t, error } = await db.from("transactions")
    .select("id, status, stage, deleted_at, deal_name, property_address, agent_id, buyer_agent_id, seller_agent_id, coordinator_id, commission_percentage, commission_finalized_at, purchase_price, listing_id, buyer_contact_id, offer_id")
    .eq("id", transactionId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: `deal_read_refused: ${error.message}` }
  if (!t) return { ok: false, error: "deal_not_found: no such deal in your workspace" }
  const row = t as Record<string, unknown>
  const [dist, comm] = await Promise.all([
    db.from("commission_distributions").select("id, status").eq("transaction_id", transactionId).eq("brokerage_id", brokerageId),
    db.from("agent_commissions").select("id, status").eq("transaction_id", transactionId).eq("brokerage_id", brokerageId),
  ])
  if (dist.error) return { ok: false, error: `ledger_read_refused: ${dist.error.message}` }
  if (comm.error) return { ok: false, error: `payout_read_refused: ${comm.error.message}` }
  const posted = ((dist.data ?? []) as Array<{ status?: string | null }>).some((r) => r.status !== "voided")
  const payoutDecided = ((comm.data ?? []) as Array<{ status?: string | null }>).some((r) => r.status === "approved" || r.status === "paid")
  const agentIds = [...new Set([row.agent_id, row.buyer_agent_id, row.seller_agent_id].filter((x): x is string => typeof x === "string" && !!x))]
  return {
    ok: true,
    facts: {
      kind: "transaction", id: transactionId, label: (row.deal_name as string | null) ?? (row.property_address as string | null) ?? null,
      stage: [row.status, row.stage].filter(Boolean).join(" · ") || null,
      agentIds, coordinatorIds: typeof row.coordinator_id === "string" ? [row.coordinator_id] : [], teamIds: [],
      current: { percent: num(row.commission_percentage), flat: null }, valueTypes: ["percent"],
      price: num(row.purchase_price), listingId: (row.listing_id as string | null) ?? null, buyerContactId: (row.buyer_contact_id as string | null) ?? null,
      offerId: (row.offer_id as string | null) ?? null,
      frozen: transactionFreeze(row as never, { posted, payoutDecided }),
    },
  }
}

/** Resolve the anchor the person named to the deal it governs NOW: an offer that became a transaction is judged on the
 *  transaction; a listing with a deal on it (not fallen through) is judged on that deal. Tenant-pinned; refusals returned. */
async function resolveDeal(db: Db, brokerageId: string, anchor: TermChangeAnchor): Promise<{ ok: true; facts: DealFacts } | { ok: false; error: string }> {
  if (anchor.transactionId) return readTransactionFacts(db, brokerageId, anchor.transactionId)
  if (anchor.offerId) {
    const { data: o, error } = await db.from("offers")
      .select("id, agent_id, transaction_id, listing_id, contact_id, status, esign_status, buyer_signed_at, seller_signed_at, fully_signed_contract_received_at, disclosed_buyer_commission_pct, disclosed_buyer_commission_flat, offer_price, property_address")
      .eq("id", anchor.offerId).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { ok: false, error: `offer_read_refused: ${error.message}` }
    if (!o) return { ok: false, error: "offer_not_found: no such offer in your workspace" }
    const r = o as Record<string, unknown>
    if (typeof r.transaction_id === "string" && r.transaction_id) return readTransactionFacts(db, brokerageId, r.transaction_id)
    const status = String(r.status ?? "").toLowerCase()
    const deadStatus = /reject|withdraw|expire|declin|cancel|void/.test(status) || /voided|declined|expired/.test(String(r.esign_status ?? ""))
    return {
      ok: true,
      facts: {
        kind: "offer", id: anchor.offerId, label: (r.property_address as string | null) ?? null, stage: [r.status, r.esign_status].filter(Boolean).join(" · ") || null,
        agentIds: typeof r.agent_id === "string" ? [r.agent_id] : [], coordinatorIds: [], teamIds: [],
        current: { percent: num(r.disclosed_buyer_commission_pct), flat: num(r.disclosed_buyer_commission_flat) }, valueTypes: ["percent", "flat"],
        price: num(r.offer_price), listingId: (r.listing_id as string | null) ?? null, buyerContactId: (r.contact_id as string | null) ?? null, offerId: anchor.offerId,
        frozen: deadStatus ? "This offer is no longer live, so its commission terms cannot change." : null,
      },
    }
  }
  const listingId = anchor.listingId as string
  const { data: l, error } = await db.from("listings").select("id, agent_id, team_id, status, deleted_at, commission_rate, list_price, address").eq("id", listingId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: `listing_read_refused: ${error.message}` }
  if (!l) return { ok: false, error: "listing_not_found: no such listing in your workspace" }
  const lr = l as Record<string, unknown>
  const { data: deals, error: dErr } = await db.from("transactions").select("id, status, deleted_at, created_at").eq("listing_id", listingId).eq("brokerage_id", brokerageId)
  if (dErr) return { ok: false, error: `deal_read_refused: ${dErr.message}` }
  const live = ((deals ?? []) as Array<{ id: string; status?: string | null; deleted_at?: string | null; created_at?: string | null }>)
    .filter((d) => !d.deleted_at && !["lost", "archived"].includes(String(d.status ?? "")))
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
  if (live.length > 0) return readTransactionFacts(db, brokerageId, live[0].id)
  const status = String(lr.status ?? "")
  return {
    ok: true,
    facts: {
      kind: "listing", id: listingId, label: (lr.address as string | null) ?? null, stage: status || null,
      agentIds: typeof lr.agent_id === "string" ? [lr.agent_id] : [], coordinatorIds: [], teamIds: typeof lr.team_id === "string" ? [lr.team_id] : [],
      current: { percent: num(lr.commission_rate), flat: null }, valueTypes: ["percent"],
      price: num(lr.list_price), listingId, buyerContactId: null, offerId: null,
      frozen: lr.deleted_at ? "This listing was removed, so its commission terms cannot change." : LISTING_NOT_LIVE.has(status) ? `This listing is ${status.replace(/_/g, " ")}, so its commission terms are no longer live.` : null,
    },
  }
}

/** Who is attached to the deal beyond its agents: the leads of the agents' (or the listing's) teams and the assigned TC. */
async function readAttachment(db: Db, brokerageId: string, facts: DealFacts): Promise<{ ok: true; teamLeadUserIds: string[]; coordinatorUserIds: string[]; agentUserIds: string[] } | { ok: false; error: string }> {
  let teamIds = [...facts.teamIds]
  let agentUserIds: string[] = []
  if (facts.agentIds.length) {
    const { data, error } = await db.from("agents").select("id, user_id, team_id").eq("brokerage_id", brokerageId).in("id", facts.agentIds)
    if (error) return { ok: false, error: `deal_team_read_refused: ${error.message}` }
    const rows = (data ?? []) as Array<{ user_id?: string | null; team_id?: string | null }>
    teamIds = [...new Set([...teamIds, ...rows.map((r) => r.team_id).filter((x): x is string => !!x)])]
    agentUserIds = rows.map((r) => r.user_id).filter((x): x is string => !!x)
  }
  let teamLeadUserIds: string[] = []
  if (teamIds.length) {
    const { data, error } = await db.from("teams").select("id, team_lead_id, deleted_at").eq("brokerage_id", brokerageId).in("id", teamIds)
    if (error) return { ok: false, error: `team_read_refused: ${error.message}` }
    teamLeadUserIds = ((data ?? []) as Array<{ team_lead_id?: string | null; deleted_at?: string | null }>).filter((r) => !r.deleted_at).map((r) => r.team_lead_id).filter((x): x is string => !!x)
  }
  let coordinatorUserIds: string[] = []
  if (facts.coordinatorIds.length) {
    const { data, error } = await db.from("transaction_coordinators").select("id, user_id, is_active").eq("brokerage_id", brokerageId).in("id", facts.coordinatorIds)
    if (error) return { ok: false, error: `coordinator_read_refused: ${error.message}` }
    coordinatorUserIds = ((data ?? []) as Array<{ user_id?: string | null; is_active?: boolean | null }>).filter((r) => r.is_active !== false).map((r) => r.user_id).filter((x): x is string => !!x)
  }
  return { ok: true, teamLeadUserIds, coordinatorUserIds, agentUserIds }
}

/** Is an EXECUTED agreement governing this commission? The engine's own reader for the client agreements, plus the offer
 *  contract's execution stamps. A refused read is returned (fail closed — "nobody checked" is never "nothing governs"). */
async function readGovernance(db: Db, brokerageId: string, facts: DealFacts): Promise<{ ok: true; governing: Array<{ kind: string; id: string }> } | { ok: false; error: string }> {
  const governing: Array<{ kind: string; id: string }> = []
  if (facts.listingId || facts.buyerContactId) {
    const { governingClientAgreementRates } = await import("./waterfall/01-resolve-rate")
    const g = await governingClientAgreementRates(db, brokerageId, { listing_id: facts.listingId, buyer_contact_id: facts.buyerContactId })
    if (g.findings.some((f) => /could not be read/.test(f))) return { ok: false, error: `agreement_read_refused: ${g.findings.join("; ")}` }
    for (const a of g.governingClientAgreements) if (a.statesRate) governing.push({ kind: a.kind, id: a.id })
  }
  if (facts.offerId) {
    const { data, error } = await db.from("offers").select("id, esign_status, buyer_signed_at, seller_signed_at, fully_signed_contract_received_at, disclosed_buyer_commission_pct, disclosed_buyer_commission_flat").eq("id", facts.offerId).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { ok: false, error: `offer_read_refused: ${error.message}` }
    const o = (data ?? null) as Record<string, unknown> | null
    const executed = !!o && (OFFER_EXECUTED.has(String(o.esign_status ?? "")) || !!o.fully_signed_contract_received_at || (!!o.buyer_signed_at && !!o.seller_signed_at))
    if (o && executed && (num(o.disclosed_buyer_commission_pct) != null || num(o.disclosed_buyer_commission_flat) != null)) governing.push({ kind: "executed_offer_contract", id: facts.offerId })
  }
  return { ok: true, governing }
}

function anchorColumns(facts: DealFacts): Record<string, string> {
  return facts.kind === "transaction" ? { transaction_id: facts.id } : facts.kind === "offer" ? { offer_id: facts.id } : { listing_id: facts.id }
}

const GOVERNING: Record<AnchorKind, { table: string; col: Record<ValueType, string | null> }> = {
  transaction: { table: "transactions", col: { percent: "commission_percentage", flat: null } },
  offer: { table: "offers", col: { percent: "disclosed_buyer_commission_pct", flat: "disclosed_buyer_commission_flat" } },
  listing: { table: "listings", col: { percent: "commission_rate", flat: null } },
}

/** Move the governing term — COMPARE-AND-SWAP on the value the change was decided against, COUNTED (an UPDATE matching nothing
 *  resolves too — §3). A mismatch is a conflict, returned by name; nothing is silently overwritten. */
async function moveGoverningTerm(db: Db, brokerageId: string, facts: DealFacts, valueType: ValueType, from: number | null, to: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const g = GOVERNING[facts.kind]
  const col = g.col[valueType]
  if (!col) return { ok: false, error: `value_type_invalid: this ${facts.kind} records its commission as a ${facts.valueTypes.join(" or ")}` }
  let q = db.from(g.table).update({ [col]: to, updated_at: new Date().toISOString() }).eq("id", facts.id).eq("brokerage_id", brokerageId)
  q = from == null ? q.is(col, null) : q.eq(col, from)
  const { data, error } = await q.select("id")
  if (error) return { ok: false, error: `term_write_refused: ${error.message}` }
  if (((data ?? []) as unknown[]).length !== 1) return { ok: false, error: `conflict: the commission on this ${facts.kind} changed while this was being decided — reload it and submit again against the current terms` }
  return { ok: true }
}

// ─── Evidence (withActionLedger) ───────────────────────────────────────────────────────────────────────────────────

type LedgerResult = { ok: boolean; error?: string; rowId?: string | null }

async function ledger(db: Db, entry: { brokerageId: string; action: string; actor: AgreementActor; subjectId: string | null; ref: string; key: string; reasonDetail: string; detail: Record<string, unknown> }, run: () => Promise<LedgerResult>): Promise<LedgerResult & { replayOf?: string | null }> {
  const { withActionLedger, governanceRecord } = await import("@/lib/kernel/action-ledger")
  // WAVE 155 (lane 155R8, D 152): THE ONE DECISION RECORD at the commission-edit sink rides THIS row (no extra round trip): the
  // attached person's / finance admin's own submission (authorized_human), the authority and approval path that decided it.
  // The approval plane's own spelling: a finance admin's decision row says approved / rejected; a submission says approved (applied at
  // once) or pending (requested — a finance admin decides next).
  const decided = entry.detail.decision === "approved" ? "approved" : entry.detail.decision === "denied" ? "rejected" : null
  const verdict = decided ?? (entry.detail.approval_status === "not_required" ? "approved" : "pending")
  const governance = governanceRecord({
    plane: "approval", verdict,
    scope: { brokerageId: entry.brokerageId, userId: entry.actor.userId }, actor: { type: "user", id: entry.actor.userId },
    entity: { type: "commission_adjustment", id: entry.subjectId, version: null }, objective: entry.action,
    policyConstraints: ["sink rule (D 152): commission edit", "termChangeAuthority (attached or finance admin)", "termChangeApproval (commission_payout_policy)", "executed-agreement evidence"],
    rationale: entry.reasonDetail, trustClass: "authorized_human", approvalBasis: decided || verdict === "pending" ? "human_approval" : "policy_permitted",
    ...(verdict === "pending" ? { nextTrigger: { kind: "human", detail: "a finance admin decides the requested change" } } : verdict === "rejected" ? { nextTrigger: { kind: "none" } } : {}),
  })
  return withActionLedger<LedgerResult & { replayOf?: string | null }>(
    {
      trustClass: "authorized_human", dependencies: [{ type: "commission_anchor", id: null, version: entry.ref }],
      brokerageId: entry.brokerageId, action: entry.action,
      actor: { type: "user", userId: entry.actor.userId, agentId: entry.actor.agentId },
      subject: { type: "commission_adjustment", id: entry.subjectId, ref: entry.ref },
      idempotencyKey: entry.key, reasonCode: "HUMAN_REQUESTED", reasonDetail: entry.reasonDetail.slice(0, 500),
      riskClass: "FINANCIAL", systemSource: "commission_term_change", detail: { ...entry.detail, governance },
      // the registered tenant policy whose agent_concession_approval half decided the approval path (lib/kernel/tenant-policy.ts)
      policyKey: "commission_payout_policy",
    },
    run,
    {
      settle: (r) => (r.ok ? { status: "executed", outcome: "recorded", providerRef: r.rowId ?? null } : { status: "failed", outcome: "refused", error: r.error ?? null }),
      replay: (claim) => claim.kind === "replay"
        ? { ok: false, error: "already_recorded", replayOf: claim.entry.provider_ref ?? null }
        : { ok: false, error: claim.kind === "refused" ? `not_recorded: ${claim.error}` : "in_flight: the same submission is still being recorded — reload in a moment" },
    },
    { client: db as never },
  )
}

// ─── Notices (agent, team lead, TC, finance + compliance) ──────────────────────────────────────────────────────────

async function notifyDealTeam(db: Db, actor: AgreementActor, facts: DealFacts, attachment: { teamLeadUserIds: string[]; coordinatorUserIds: string[]; agentUserIds: string[] }, n: { type: string; title: string; body: string; priority: "medium" | "high" }): Promise<{ notified: number; error: string | null }> {
  const { data: staff, error } = await db.from("users").select("id, user_type").eq("brokerage_id", actor.brokerageId).in("user_type", [...BROKERAGE_FINANCE_ADMIN_USER_TYPES, "compliance_officer"])
  if (error) return { notified: 0, error: `the finance and compliance team could not be read, so they were not told (${error.message})` }
  const ids = [...new Set([...attachment.agentUserIds, ...attachment.teamLeadUserIds, ...attachment.coordinatorUserIds, ...((staff ?? []) as Array<{ id: string }>).map((u) => u.id)])].filter((id) => id && id !== actor.userId)
  if (ids.length === 0) return { notified: 0, error: null }
  const rows = ids.map((user_id) => ({ user_id, brokerage_id: actor.brokerageId, type: n.type, title: n.title.slice(0, 200), body: n.body.slice(0, 480), entity_type: facts.kind, entity_id: facts.id, priority: n.priority, channel: "in_app" }))
  const { data, error: insErr } = await db.from("notifications").insert(rows).select("id")
  if (insErr) return { notified: 0, error: `the people on the deal could not be told (${insErr.message})` }
  return { notified: ((data ?? []) as unknown[]).length, error: null }
}

// ─── The waterfall re-run seam ─────────────────────────────────────────────────────────────────────────────────────

interface TermChangeDeps {
  /** Re-run the canonical waterfall after a deal's rate moved. Default: lib/kernel/transactions.ts recalculateCommissionStateCommand. */
  recompute?: (input: { brokerageId: string; transactionId: string; actorUserId: string }) => Promise<{ ok: true; gross: number | null; agentNet: number | null; brokerageNet: number | null } | { ok: false; error: string }>
  /** WAVE 155 (155R8): who proposed this change when it is NOT the attached person's own submission (a model / inbound proposal
   *  states `trustClass`; the sink rule then holds it unless a named verification cleared it). Absent = the session's submission. */
  origin?: Pick<ActionContext, "trustClass" | "sink" | "cycle"> | null
}

async function defaultRecompute(input: { brokerageId: string; transactionId: string; actorUserId: string }) {
  const { recalculateCommissionStateCommand } = await import("@/lib/kernel/transactions")
  const r = await recalculateCommissionStateCommand({ transactionId: input.transactionId, brokerageId: input.brokerageId, agentId: input.actorUserId })
  if (!r.success) return { ok: false as const, error: r.error ?? "the commission engine could not price this deal" }
  const d = (r.data ?? null) as { grossCommission?: number; agentNet?: number; brokerageNet?: number } | null
  return { ok: true as const, gross: d?.grossCommission ?? null, agentNet: d?.agentNet ?? null, brokerageNet: d?.brokerageNet ?? null }
}

/** After a deal's rate moved: re-run the waterfall and say whether the CDA / settlement need a recheck. Never undoes the change. */
async function afterApplied(db: Db, actor: AgreementActor, facts: DealFacts, deps: TermChangeDeps): Promise<{ recalculated: TermChangeResult["recalculated"]; recheck: string[] }> {
  if (facts.kind !== "transaction") return { recalculated: null, recheck: [] }
  const recheck: string[] = []
  const { data: cda, error: cdaErr } = await db.from("closing_disclosure_agreement").select("id, status").eq("transaction_id", facts.id).eq("brokerage_id", actor.brokerageId)
  if (cdaErr) recheck.push(`the CDA could not be read (${cdaErr.message}) — check it against the new commission`)
  else if (((cda ?? []) as unknown[]).length > 0) recheck.push("the CDA's commission breakdown must be redone against the new rate")
  recheck.push("the settlement statement must show the new commission before closing compliance passes")
  const r = await (deps.recompute ?? defaultRecompute)({ brokerageId: actor.brokerageId, transactionId: facts.id, actorUserId: actor.userId })
  return { recalculated: r.ok ? { ok: true, gross: r.gross, agentNet: r.agentNet, brokerageNet: r.brokerageNet } : { ok: false, error: r.error }, recheck }
}

// ─── The doors ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface TermChangeInput extends TermChangeAnchor {
  valueType: ValueType
  value: number
  reason: string
  effectiveDate: string
  evidenceDocumentId?: string | null
  /** One key per submission (the form mints it) — a retried submit replays, never records twice. */
  idempotencyKey: string
}

export interface TermChangeRecord {
  id: string
  anchor: { kind: AnchorKind; id: string }
  valueType: ValueType
  priorValue: number | null
  value: number
  reason: string | null
  effectiveDate: string | null
  evidenceDocumentId: string | null
  approvalStatus: string
  requestedBy: string | null
  requestedAt: string | null
  decidedAt: string | null
  decidedBy: string | null
  decisionNote: string | null
  appliedAt: string | null
}

interface TermChangeResult {
  record: TermChangeRecord
  applied: boolean
  replayed: boolean
  recalculated: { ok: true; gross: number | null; agentNet: number | null; brokerageNet: number | null } | { ok: false; error: string } | null
  recheck: string[]
  notified: number
  noticeError: string | null
}

function toRecord(r: Record<string, unknown>): TermChangeRecord {
  const kind: AnchorKind = r.transaction_id ? "transaction" : r.offer_id ? "offer" : "listing"
  return {
    id: String(r.id), anchor: { kind, id: String(r.transaction_id ?? r.offer_id ?? r.listing_id ?? "") },
    valueType: r.value_type === "flat" ? "flat" : "percent", priorValue: num(r.prior_value), value: Number(r.value ?? 0),
    reason: (r.notes as string | null) ?? null, effectiveDate: (r.effective_date as string | null) ?? null,
    evidenceDocumentId: (r.evidence_document_id as string | null) ?? null, approvalStatus: String(r.approval_status ?? "not_required"),
    requestedBy: (r.requested_by_user_id as string | null) ?? null, requestedAt: (r.approval_requested_at as string | null) ?? (r.created_at as string | null) ?? null,
    decidedAt: (r.approval_decided_at as string | null) ?? null, decidedBy: (r.approval_decided_by as string | null) ?? null,
    decisionNote: (r.approval_note as string | null) ?? null, appliedAt: (r.applied_at as string | null) ?? null,
  }
}

/** A missing m902 column — reported by name, never as a generic failure. */
function m902Missing(message: string | undefined): boolean {
  return /listing_id|requested_by_user_id|prior_value|evidence_document_id|applied_at/.test(String(message ?? "")) && /column|schema cache|does not exist/i.test(String(message ?? ""))
}

async function pendingFor(db: Db, brokerageId: string, facts: DealFacts): Promise<{ ok: true; rows: Array<Record<string, unknown>> } | { ok: false; error: string }> {
  const [col, id] = Object.entries(anchorColumns(facts))[0]
  const { data, error } = await db.from("commission_adjustments").select("*").eq("brokerage_id", brokerageId).eq("adjustment_type", TERM_CHANGE).eq(col, id).order("created_at", { ascending: false })
  if (error) return { ok: false, error: m902Missing(error.message) ? `m902 (commission term change record) is not applied: ${error.message}` : `term_change_read_refused: ${error.message}` }
  return { ok: true, rows: (data ?? []) as Array<Record<string, unknown>> }
}

/**
 * WHAT THE PANEL SHOWS — the deal's current commission terms, the agreement that governs them, whether they are frozen, who
 * decides, what a change affects, and the change history. Refused for anyone who could not submit (a vendor, a Contact, an
 * unrelated seat) — the terms are financial, and §5 keeps them off those screens.
 */
export async function loadCommissionTermsForChange(db: Db, actor: AgreementActor, anchor: TermChangeAnchor): Promise<
  | { ok: true; view: { anchor: { kind: AnchorKind; id: string }; label: string | null; stage: string | null; current: { percent: number | null; flat: number | null }; valueTypes: ValueType[]; price: number | null; frozen: string | null; governing: Array<{ kind: string; id: string }>; yourRole: ApproverRole; appliesDirectly: boolean; approvalNote: string; affects: string[]; history: TermChangeRecord[] } }
  | { ok: false; error: string }
> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  const d = await resolveDeal(db, actor.brokerageId, anchor)
  if (!d.ok) return d
  const att = await readAttachment(db, actor.brokerageId, d.facts)
  if (!att.ok) return att
  const who = termChangeAuthority(actor, { agentIds: d.facts.agentIds, ...att })
  if (!who.ok) return who
  const gov = await readGovernance(db, actor.brokerageId, d.facts)
  if (!gov.ok) return gov
  const { data: brk, error: brkErr } = await db.from("brokerages").select("*").eq("id", actor.brokerageId).maybeSingle()
  if (brkErr) return { ok: false, error: `policy_read_refused: ${brkErr.message}` }
  const policy = resolveAgentConcessionPolicy((brk as Record<string, unknown> | null)?.agent_concession_approval)
  const history = await pendingFor(db, actor.brokerageId, d.facts)
  if (!history.ok) return history
  const executed = gov.governing.length > 0
  const approvalNote = who.appliesDirectly
    ? executed ? "You can apply a change directly; attach the executed amendment it rests on." : "You can apply a change directly."
    : executed ? "An executed agreement sets this commission: attach the executed amendment, and the broker reviews the change before it takes effect."
      : who.role === "deal_agent" && !policy.requiresApproval ? "Your brokerage lets the agent on the deal change it directly." : "The broker reviews the change before it takes effect."
  const affects = d.facts.kind === "transaction"
    ? ["the gross commission at the recorded sale price", "the agent, team and brokerage shares, fees, royalty, referral and any concession — recalculated by the commission engine", "the CDA, if the brokerage uses one, and the settlement statement — both are rechecked"]
    : d.facts.kind === "offer" ? ["the buyer-agent commission this offer states", "the seller's net sheet for this offer"] : ["the listing's commission rate", "seller net sheets built from this listing"]
  return {
    ok: true,
    view: {
      anchor: { kind: d.facts.kind, id: d.facts.id }, label: d.facts.label, stage: d.facts.stage, current: d.facts.current, valueTypes: d.facts.valueTypes,
      price: d.facts.price, frozen: d.facts.frozen, governing: gov.governing, yourRole: who.role, appliesDirectly: who.appliesDirectly, approvalNote, affects,
      history: history.rows.map(toRecord),
    },
  }
}

/**
 * SUBMIT a commission term change. Refused, by name, when: the shape is wrong · the deal is frozen (closed incl. payout
 * pending, fell through, finalized, payout decided, posted) · the person is not attached and is not a finance admin · an
 * executed agreement governs and no executed evidence is named · another change on this deal still awaits a decision (two
 * versions in flight must be resolved, never raced). Applies at once only where termChangeApproval says so; otherwise it is
 * REQUESTED and the finance admins are told. Idempotent on the submission key.
 */
export async function requestCommissionTermChange(db: Db, actor: AgreementActor, input: TermChangeInput, deps: TermChangeDeps = {}): Promise<({ ok: true } & TermChangeResult) | { ok: false; error: string }> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  // WAVE 155 (lane 155R8, D 152 / eval SCOPE-003): a change someone OTHER than the session's person proposed (deps.origin) passes the
  // pure sink rule FIRST — an untrusted origin with no recorded verification is HELD on one `finance.decision.wait` row and nothing
  // below runs; a verified one continues to the authority + approval gates (its own term-change row follows). A model's text is
  // recorded as claims and never read.
  if (deps.origin) {
    const { ledgerToolCall } = await import("@/lib/kernel/action-ledger")
    const o = deps.origin
    const r = await ledgerToolCall({
      brokerageId: actor.brokerageId, action: "finance.commission_term.propose", channel: "commission_sink", actor: { type: "user", userId: actor.userId, agentId: actor.agentId },
      subject: { type: "commission_anchor", id: input.transactionId ?? input.offerId ?? input.listingId ?? null }, riskClass: "FINANCIAL", systemSource: "commission_term_change",
      cycle: o.cycle ?? null, trustClass: o.trustClass ?? null, approvalBasis: o.sink?.verification?.kind === "authorized_human" ? "human_approval" : "policy_permitted",
      dependencies: [{ type: "commission_anchor", id: input.transactionId ?? input.offerId ?? input.listingId ?? null, version: null }],
      sink: o?.sink ?? null,
    }, () => requestCommissionTermChange(db, actor, input, { ...deps, origin: null }))
    return "ok" in r ? r : { ok: false, error: r.error ?? "already proposed — not repeated" }
  }
  const shape = validateRequest(input, null)
  if (shape) return { ok: false, error: shape }
  const anchor: TermChangeAnchor = { transactionId: input.transactionId ?? null, offerId: input.offerId ?? null, listingId: input.listingId ?? null }
  const d = await resolveDeal(db, actor.brokerageId, anchor)
  if (!d.ok) return d
  const facts = d.facts
  const att = await readAttachment(db, actor.brokerageId, facts)
  if (!att.ok) return att
  const who = termChangeAuthority(actor, { agentIds: facts.agentIds, ...att })
  if (!who.ok) return who

  const key = `commission_term_change:${actor.brokerageId}:${String(input.idempotencyKey).trim()}`
  // A retried submission replays BEFORE the deal's current state is judged (the first submit may already have moved it).
  const { data: prior, error: priorErr } = await db.from("agent_action_ledger").select("id, status, provider_ref").eq("brokerage_id", actor.brokerageId).eq("idempotency_key", key).maybeSingle()
  if (priorErr) return { ok: false, error: `evidence_read_refused: whether this submission was already recorded could not be checked (${priorErr.message}) — nothing was changed; submit again in a moment` }
  if (prior && (prior as { status?: string }).status === "executed" && (prior as { provider_ref?: string | null }).provider_ref) {
    return replayResult(db, actor, String((prior as { provider_ref: string }).provider_ref))
  }

  if (facts.frozen) return { ok: false, error: `frozen: ${facts.frozen}` }
  const bad = validateRequest(input, facts)
  if (bad) return { ok: false, error: bad }
  const gov = await readGovernance(db, actor.brokerageId, facts)
  if (!gov.ok) return gov
  const executedGoverns = gov.governing.length > 0
  const evidenceId = input.evidenceDocumentId ? String(input.evidenceDocumentId) : null
  if (evidenceId) {
    const { data: doc, error: docErr } = await db.from("documents").select("id").eq("id", evidenceId).eq("brokerage_id", actor.brokerageId).maybeSingle()
    if (docErr) return { ok: false, error: `evidence_read_refused: ${docErr.message}` }
    if (!doc) return { ok: false, error: "evidence_not_found: the executed amendment must be stored in your workspace's documents" }
  }
  const { data: brk, error: brkErr } = await db.from("brokerages").select("*").eq("id", actor.brokerageId).maybeSingle()
  if (brkErr) return { ok: false, error: `policy_read_refused: ${brkErr.message}` }
  const policy = resolveAgentConcessionPolicy((brk as Record<string, unknown> | null)?.agent_concession_approval)
  const approval = termChangeApproval({ role: who.role, appliesDirectly: who.appliesDirectly, executedGoverns, hasEvidence: !!evidenceId, policyRequiresApproval: policy.requiresApproval })
  if (!approval.ok) return approval

  const pending = await pendingFor(db, actor.brokerageId, facts)
  if (!pending.ok) return pending
  const open = pending.rows.filter((r) => r.approval_status === "requested" && r.is_active !== false)
  if (open.length > 0) return { ok: false, error: `conflicting_pending: another change to this commission (${fmt(open[0].value_type === "flat" ? "flat" : "percent", num(open[0].value))}) still awaits the broker's decision — it must be decided or withdrawn before a new one is submitted` }

  const valueType = input.valueType
  const before = valueType === "percent" ? facts.current.percent : facts.current.flat
  const value = Number(input.value)
  const reason = String(input.reason).trim()
  const now = new Date().toISOString()
  const applyNow = approval.status === "not_required"
  let inserted: Record<string, unknown> | null = null
  const res = await ledger(db, {
    brokerageId: actor.brokerageId, action: applyNow ? "finance.commission_term.changed" : "finance.commission_term.change_requested",
    actor, subjectId: null, ref: `${facts.kind}:${facts.id}`, key,
    reasonDetail: `commission on this ${facts.kind} ${fmt(valueType, before)} → ${fmt(valueType, value)}: ${reason}`,
    detail: {
      anchor: { kind: facts.kind, id: facts.id }, value_type: valueType, before, after: value, effective_date: calendarDay(input.effectiveDate),
      evidence_document_id: evidenceId, executed_agreements: gov.governing, role: who.role, approval_status: approval.status,
      policy: { key: "brokerages.agent_concession_approval", value: policy.value, declared: policy.declared },
      gross_at_price: facts.price != null && valueType === "percent" ? { before: before == null ? null : Math.round(facts.price * before) / 100, after: Math.round(facts.price * value) / 100 } : null,
    },
  }, async () => {
    const { data, error } = await db.from("commission_adjustments").insert({
      brokerage_id: actor.brokerageId, ...anchorColumns(facts),
      created_by_agent_id: actor.agentId ?? null, requested_by_user_id: actor.userId,
      adjustment_type: TERM_CHANGE, applies_to: "gross",
      // direction says which way the gross moves (a cut is a credit off the gross); value is the NEW term, prior_value the old
      direction: before != null && value > before ? "surcharge" : "credit", recipient_type: "brokerage",
      value, value_type: valueType, prior_value: before, notes: reason, is_active: true,
      effective_date: calendarDay(input.effectiveDate), evidence_document_id: evidenceId,
      approval_status: approval.status, approval_requested_at: applyNow ? null : now,
      approval_policy_ref: `brokerages.agent_concession_approval=${policy.value ?? "undeclared"}${executedGoverns ? "; executed agreement governs" : ""}`,
      applied_at: applyNow ? now : null,
    }).select("*")
    if (error) return { ok: false, error: m902Missing(error.message) ? `m902 (commission term change record) is not applied: ${error.message}` : `term_change_refused: ${error.message}` }
    const rows = (data ?? []) as Array<Record<string, unknown>>
    if (rows.length !== 1) return { ok: false, error: `term_change_not_recorded (${rows.length} rows written)` }
    inserted = rows[0]
    if (applyNow) {
      const moved = await moveGoverningTerm(db, actor.brokerageId, facts, valueType, before, value)
      if (!moved.ok) {
        // compensate: the record of a change the deal never took is withdrawn, never left reading as applied
        await db.from("commission_adjustments").update({ is_active: false, approval_status: "withdrawn", applied_at: null, updated_at: new Date().toISOString() }).eq("id", rows[0].id).eq("brokerage_id", actor.brokerageId).select("id")
        return { ok: false, error: moved.error }
      }
    }
    return { ok: true, rowId: String(rows[0].id) }
  })
  if (!res.ok && res.replayOf) return replayResult(db, actor, res.replayOf)
  if (!res.ok || !inserted) return { ok: false, error: res.error ?? "term_change_not_recorded" }
  const record = toRecord(inserted)
  const after = applyNow ? await afterApplied(db, actor, facts, deps) : { recalculated: null, recheck: [] as string[] }
  const roleWord = who.role === "finance_admin" ? "a finance administrator" : who.role === "deal_agent" ? "the agent on the deal" : who.role === "team_lead" ? "the team lead" : "the transaction coordinator"
  const notice = await notifyDealTeam(db, actor, facts, att, applyNow
    ? { type: "commission_term_changed", title: "A commission was changed", body: `The commission on ${facts.label ?? `this ${facts.kind}`} changed from ${fmt(valueType, before)} to ${fmt(valueType, value)}, effective ${record.effectiveDate}, by ${roleWord}. Reason: ${reason}.${after.recheck.length ? ` Next: ${after.recheck.join("; ")}.` : ""}`, priority: "high" }
    : { type: "commission_term_change_requested", title: "A commission change awaits the broker", body: `${roleWord[0].toUpperCase()}${roleWord.slice(1)} asks to change the commission on ${facts.label ?? `this ${facts.kind}`} from ${fmt(valueType, before)} to ${fmt(valueType, value)}, effective ${record.effectiveDate}. Reason: ${reason}. A finance administrator approves or denies it on the payouts page; nothing changes until then.`, priority: "high" })
  return { ok: true, record, applied: applyNow, replayed: false, recalculated: after.recalculated, recheck: after.recheck, notified: notice.notified, noticeError: notice.error }
}

async function replayResult(db: Db, actor: AgreementActor, rowId: string): Promise<({ ok: true } & TermChangeResult) | { ok: false; error: string }> {
  const { data, error } = await db.from("commission_adjustments").select("*").eq("id", rowId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (error) return { ok: false, error: `term_change_read_refused: ${error.message}` }
  if (!data) return { ok: false, error: "already_recorded: this submission was recorded, but its record could not be found in your workspace" }
  const record = toRecord(data as Record<string, unknown>)
  return { ok: true, record, applied: !!record.appliedAt, replayed: true, recalculated: null, recheck: [], notified: 0, noticeError: null }
}

/**
 * THE BROKER'S DECISION — finance admins only. Approve = re-judge the freeze, then a VERSION check (the governing value must
 * still be the one the request was made against — otherwise the two versions CONFLICT and a person resolves them), then move
 * the term (compare-and-swap) and mark the record approved + applied (compare-and-swap on 'requested'; a failed mark puts the
 * term back). Deny = the record is closed with the reason (a denial is allowed even on a frozen deal, to clear the queue).
 * A second decision on the same record replays / refuses — never applies twice.
 */
export async function decideCommissionTermChange(db: Db, actor: AgreementActor, input: { adjustmentId: string; decision: "approved" | "denied"; note?: string | null }, deps: TermChangeDeps = {}): Promise<({ ok: true } & TermChangeResult) | { ok: false; error: string }> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  if (!isBrokerageFinanceAdmin({ user_type: actor.userType, is_tenant_principal: actor.isTenantPrincipal })) return { ok: false, error: "forbidden: only a finance administrator approves or denies a commission change" }
  if (input.decision !== "approved" && input.decision !== "denied") return { ok: false, error: "decision_invalid: approved or denied" }
  const note = String(input.note ?? "").trim() || null
  if (input.decision === "denied" && (!note || note.length < AGENT_CONCESSION_REASON_MIN)) return { ok: false, error: `note_required: a denial states why (at least ${AGENT_CONCESSION_REASON_MIN} characters)` }
  const { data: cur, error: readErr } = await db.from("commission_adjustments").select("*").eq("id", input.adjustmentId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (readErr) return { ok: false, error: m902Missing(readErr.message) ? `m902 (commission term change record) is not applied: ${readErr.message}` : `term_change_read_refused: ${readErr.message}` }
  if (!cur || (cur as { adjustment_type?: string }).adjustment_type !== TERM_CHANGE) return { ok: false, error: "term_change_not_found" }
  const before = toRecord(cur as Record<string, unknown>)
  if (before.approvalStatus !== "requested") return { ok: false, error: `not_pending: this change is ${before.approvalStatus}` }
  const d = await resolveDeal(db, actor.brokerageId, before.anchor.kind === "transaction" ? { transactionId: before.anchor.id } : before.anchor.kind === "offer" ? { offerId: before.anchor.id } : { listingId: before.anchor.id })
  if (!d.ok) return d
  const facts = d.facts
  if (input.decision === "approved") {
    if (facts.kind !== before.anchor.kind || facts.id !== before.anchor.id) return { ok: false, error: `moved: this ${before.anchor.kind} became a deal since the change was requested — deny it and submit it again on the deal` }
    if (facts.frozen) return { ok: false, error: `frozen: ${facts.frozen} Deny this request to clear it.` }
    const now = before.valueType === "percent" ? facts.current.percent : facts.current.flat
    if ((now ?? null) !== (before.priorValue ?? null)) return { ok: false, error: `conflict: the commission was ${fmt(before.valueType, before.priorValue)} when this was requested and is ${fmt(before.valueType, now)} now — deny this request and submit a new one against the current terms` }
  }
  const att = await readAttachment(db, actor.brokerageId, facts)
  if (!att.ok) return att
  const decidedAt = new Date().toISOString()
  let updated: Record<string, unknown> | null = null
  const res = await ledger(db, {
    brokerageId: actor.brokerageId, action: `finance.commission_term.change_${input.decision}`, actor, subjectId: input.adjustmentId,
    ref: `${facts.kind}:${facts.id}`, key: `commission_term_change.decision:${actor.brokerageId}:${input.adjustmentId}`,
    reasonDetail: `broker ${input.decision} a commission change ${fmt(before.valueType, before.priorValue)} → ${fmt(before.valueType, before.value)}${note ? `: ${note}` : ""}`,
    detail: { adjustment_id: input.adjustmentId, anchor: before.anchor, before: before.priorValue, after: before.value, value_type: before.valueType, decision: input.decision, note, requested_by: before.requestedBy },
  }, async () => {
    if (input.decision === "approved") {
      const moved = await moveGoverningTerm(db, actor.brokerageId, facts, before.valueType, before.priorValue, before.value)
      if (!moved.ok) return moved
    }
    const { data, error } = await db.from("commission_adjustments").update({
      approval_status: input.decision, approval_decided_at: decidedAt, approval_decided_by: actor.userId, approval_note: note,
      ...(input.decision === "approved" ? { applied_at: decidedAt } : { is_active: false }), updated_at: decidedAt,
    }).eq("id", input.adjustmentId).eq("brokerage_id", actor.brokerageId).eq("approval_status", "requested").select("*")
    const rows = (data ?? []) as Array<Record<string, unknown>>
    if (error || rows.length !== 1) {
      if (input.decision === "approved") {
        // compensate: the term goes back to the value it had — a change whose record could not be closed is not left applied
        const g = GOVERNING[facts.kind]; const col = g.col[before.valueType] as string
        await db.from(g.table).update({ [col]: before.priorValue, updated_at: new Date().toISOString() }).eq("id", facts.id).eq("brokerage_id", actor.brokerageId).eq(col, before.value).select("id")
      }
      return { ok: false, error: error ? `decision_refused: ${error.message}` : "not_pending: this change was decided or withdrawn under you" }
    }
    updated = rows[0]
    return { ok: true, rowId: input.adjustmentId }
  })
  if (!res.ok && res.replayOf) return { ok: false, error: "already_decided: this change was already decided" }
  if (!res.ok || !updated) return { ok: false, error: res.error ?? "decision_not_recorded" }
  const record = toRecord(updated)
  const applied = input.decision === "approved"
  const after = applied ? await afterApplied(db, actor, facts, deps) : { recalculated: null, recheck: [] as string[] }
  const notice = await notifyDealTeam(db, actor, facts, att, applied
    ? { type: "commission_term_changed", title: "A commission change was approved", body: `The broker approved changing the commission on ${facts.label ?? `this ${facts.kind}`} from ${fmt(before.valueType, before.priorValue)} to ${fmt(before.valueType, before.value)}, effective ${before.effectiveDate}.${after.recheck.length ? ` Next: ${after.recheck.join("; ")}.` : ""}`, priority: "high" }
    : { type: "commission_term_change_denied", title: "A commission change was denied", body: `The broker denied changing the commission on ${facts.label ?? `this ${facts.kind}`} to ${fmt(before.valueType, before.value)}. Reason: ${note}. The commission stays at ${fmt(before.valueType, before.priorValue)}.`, priority: "medium" })
  return { ok: true, record, applied, replayed: false, recalculated: after.recalculated, recheck: after.recheck, notified: notice.notified, noticeError: notice.error }
}

/** The person who asked withdraws their own still-pending request (compare-and-swap on 'requested' + requester; counted). */
export async function withdrawCommissionTermChange(db: Db, actor: AgreementActor, input: { adjustmentId: string }): Promise<{ ok: true; record: TermChangeRecord } | { ok: false; error: string }> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  const { data, error } = await db.from("commission_adjustments").update({ approval_status: "withdrawn", is_active: false, updated_at: new Date().toISOString() })
    .eq("id", input.adjustmentId).eq("brokerage_id", actor.brokerageId).eq("adjustment_type", TERM_CHANGE).eq("requested_by_user_id", actor.userId).eq("approval_status", "requested").select("*")
  if (error) return { ok: false, error: m902Missing(error.message) ? `m902 (commission term change record) is not applied: ${error.message}` : `withdraw_refused: ${error.message}` }
  const rows = (data ?? []) as Array<Record<string, unknown>>
  if (rows.length !== 1) return { ok: false, error: "not_pending: only your own change that still awaits the broker can be withdrawn" }
  return { ok: true, record: toRecord(rows[0]) }
}

/** The finance admins' queue: every change in the tenant awaiting a decision, oldest first. Finance admins only. */
export async function listPendingCommissionTermChanges(db: Db, actor: AgreementActor): Promise<{ ok: true; records: TermChangeRecord[] } | { ok: false; error: string }> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  if (!isBrokerageFinanceAdmin({ user_type: actor.userType, is_tenant_principal: actor.isTenantPrincipal })) return { ok: false, error: "forbidden: the commission change queue belongs to the finance administrators" }
  const { data, error } = await db.from("commission_adjustments").select("*").eq("brokerage_id", actor.brokerageId).eq("adjustment_type", TERM_CHANGE).eq("approval_status", "requested").order("created_at", { ascending: true })
  if (error) return { ok: false, error: m902Missing(error.message) ? `m902 (commission term change record) is not applied: ${error.message}` : `term_change_read_refused: ${error.message}` }
  return { ok: true, records: ((data ?? []) as Array<Record<string, unknown>>).filter((r) => r.is_active !== false).map(toRecord) }
}
