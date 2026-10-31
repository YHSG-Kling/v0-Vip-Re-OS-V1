// lib/commission/client-agreement-fees.ts — THE TRANSACTION / ADMIN FEES THE SELLER'S AND THE BUYER'S AGREEMENTS ESTABLISH
// (wave 145, lane 145C; owner ruling 5, 2026-10-27).
//
// Owner, verbatim: "There is a transaction fee or an admin fee which will be dictated from the seller and buyer agreements now
// which the agents fill out." Who owes each fee, which agreement establishes it, payable at closing or not, who receives it,
// whether it is already in the commission/settlement calculation, whether brokerage policy permits it, whether an executed
// amendment changes it. Agent/team-agreement fees and buyer/seller-agreement fees are NOT interchangeable; never double-count;
// agent-completed fields need human review and execution.
//
// TWO DIFFERENT OBLIGATIONS, NEVER CROSSED (§6):
//   · AGENT-agreement fees (transaction / desk / technology / E&O / royalty) — the agent owes the brokerage; charged to the
//     agent's share by lib/commission/waterfall/10-fees.ts from agent_commission_profiles; commission_distributions 'fee' rows.
//   · CLIENT-agreement fees (this module) — the SELLER (listing agreement) or the BUYER (buyer-broker agreement) owes them; they
//     are SETTLEMENT lines on that party's side, recorded in client_agreement_fees (m859). No stage of the commission engine
//     reads this module and this module never writes commission_distributions (scripts/agreement-governance-guard.ts proves both).
//
// ONE RESOLVER for a deal: resolveClientAgreementFees. The listing intake's legacy flat field (listing_agreements
// .seller_transaction_fee, written by app/actions/seller-listing/execution-engine.ts) is read as an UNVERIFIED seller transaction
// fee ONLY when no fee row of that kind exists for that agreement — never both (no double count), never copied.
//
// Pure rule at the top; the I/O half (loader + the three writers) below takes the service client and the SESSION actor.

import { isBrokerageFinanceAdmin, TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { calendarDay, type AgreementActor } from "@/lib/agreements/agent-agreements"

// ─── Vocabulary (mirrors the m859 CHECKs) ───────────────────────────────────────────────────────────────────────────

export const CLIENT_FEE_KINDS = ["transaction_fee", "admin_fee"] as const
export type ClientFeeKind = (typeof CLIENT_FEE_KINDS)[number]
export const CLIENT_FEE_PAYERS = ["seller", "buyer"] as const
export type ClientFeePayer = (typeof CLIENT_FEE_PAYERS)[number]
export const CLIENT_FEE_RECEIVERS = ["brokerage", "agent"] as const
export type ClientFeeReceiver = (typeof CLIENT_FEE_RECEIVERS)[number]
export const CLIENT_FEE_VALUE_TYPES = ["flat", "percent_of_price"] as const
export type ClientFeeValueType = (typeof CLIENT_FEE_VALUE_TYPES)[number]
export const CLIENT_FEE_STATUSES = ["entered", "verified", "superseded", "void"] as const
export type ClientFeeStatus = (typeof CLIENT_FEE_STATUSES)[number]

export const CLIENT_FEE_KIND_LABEL: Record<ClientFeeKind, string> = { transaction_fee: "Transaction fee", admin_fee: "Administrative fee" }

/** The settlement statement line each payable-at-closing fee is compared against (lib/transactions/closing-compliance-core.ts). */
export const CLIENT_FEE_SETTLEMENT_TERM: Record<ClientFeePayer, Record<ClientFeeKind, string>> = {
  seller: { transaction_fee: "seller_transaction_fee", admin_fee: "seller_admin_fee" },
  buyer: { transaction_fee: "buyer_transaction_fee", admin_fee: "buyer_admin_fee" },
}

export interface ClientFeeRow {
  id: string
  listing_agreement_id?: string | null
  buyer_broker_agreement_id?: string | null
  fee_kind: string
  payer: string
  receiver: string
  value: unknown
  value_type: string
  payable_at_closing: boolean
  included_in_commission: boolean
  brokerage_policy_permits?: boolean | null
  status: string
  effective_date?: string | null
  supersedes_fee_id?: string | null
  amendment_document_id?: string | null
}

export interface ResolvedClientFee {
  feeId: string | null
  kind: ClientFeeKind
  payer: ClientFeePayer
  receiver: ClientFeeReceiver | null
  establishedBy: { kind: "listing_agreement" | "buyer_broker_agreement"; id: string }
  /** Dollars — computed from the price when the agreement states a percent of the price; null when the price is unknown. */
  amount: number | null
  valueType: ClientFeeValueType
  value: number
  payableAtClosing: boolean | null
  includedInCommission: boolean | null
  status: ClientFeeStatus | "legacy_unverified"
  /** Settles as its own line on the payer's side: verified, payable at closing, NOT already inside the commission. */
  settlesAsOwnLine: boolean
  amendedBy: string | null
  findings: string[]
}

export interface ClientFeeResolution {
  fees: ResolvedClientFee[]
  /** Per payer, the dollars that settle as their own lines (verified, payable at closing, not inside the commission). */
  settlementTotals: Record<ClientFeePayer, Partial<Record<ClientFeeKind, number>>>
  findings: string[]
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v))
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * PURE — the client-agreement fees in force for one deal on `asOf`:
 *   · per agreement and kind, the LIVE row (entered | verified) whose effective date is on/before `asOf` — superseded / void rows
 *     are history (an amendment's row names what it replaced);
 *   · the listing intake's legacy seller_transaction_fee counts ONLY when the listing agreement has no transaction-fee row at all
 *     (an unverified line, said) — never both;
 *   · a fee settles as its own line only when VERIFIED, payable at closing and NOT already inside the commission (a fee inside
 *     the commission is already in the commission figure — charging it again is the double count the ruling forbids).
 */
/** The fee lifecycle states the resolver branches on — named once from the m859 vocabulary (a typed constant, never a loose
 *  literal compared against a row whose table the reader would have to guess). */
const FEE_ENTERED: ClientFeeStatus = CLIENT_FEE_STATUSES[0]
const FEE_VERIFIED: ClientFeeStatus = CLIENT_FEE_STATUSES[1]
const isLiveFee = (status: string) => status === FEE_ENTERED || status === FEE_VERIFIED

// module-private: proved through its one caller, loadClientAgreementFeesForTransaction (scripts/agreement-governance-guard.ts §D)
function resolveClientAgreementFees(input: {
  asOf: string
  purchasePrice: number | null
  listingAgreements: ReadonlyArray<{ id: string; seller_transaction_fee?: unknown }>
  buyerAgreementIds: readonly string[]
  rows: ReadonlyArray<ClientFeeRow>
}): ClientFeeResolution {
  const findings: string[] = []
  const fees: ResolvedClientFee[] = []
  const amountOf = (valueType: ClientFeeValueType, value: number): number | null =>
    valueType === "flat" ? round2(value) : input.purchasePrice && input.purchasePrice > 0 ? round2((input.purchasePrice * value) / 100) : null

  const agreementsInScope = [
    ...input.listingAgreements.map((a) => ({ kind: "listing_agreement" as const, id: a.id, payer: "seller" as const })),
    ...input.buyerAgreementIds.map((id) => ({ kind: "buyer_broker_agreement" as const, id, payer: "buyer" as const })),
  ]
  for (const ag of agreementsInScope) {
    const mine = input.rows.filter((r) => (ag.kind === "listing_agreement" ? r.listing_agreement_id : r.buyer_broker_agreement_id) === ag.id)
    for (const kind of CLIENT_FEE_KINDS) {
      const ofKind = mine.filter((r) => r.fee_kind === kind)
      const live = ofKind
        .filter((r) => isLiveFee(r.status) && (calendarDay(r.effective_date) ?? "0000-00-00") <= input.asOf)
        .sort((a, b) => String(b.effective_date ?? "").localeCompare(String(a.effective_date ?? "")))
      const r = live[0]
      if (r) {
        const value = num(r.value) ?? 0
        const vt = (CLIENT_FEE_VALUE_TYPES as readonly string[]).includes(r.value_type) ? (r.value_type as ClientFeeValueType) : "flat"
        const amount = amountOf(vt, value)
        const f: string[] = []
        if (r.payer !== ag.payer) f.push(`fee ${r.id} names the ${r.payer} as payer on a ${ag.kind.replace(/_/g, " ")} — the ${ag.payer}'s agreement binds the ${ag.payer} only`)
        const verified = r.status === FEE_VERIFIED
        if (r.status === FEE_ENTERED) f.push(`the ${CLIENT_FEE_KIND_LABEL[kind].toLowerCase()} on ${ag.kind.replace(/_/g, " ")} ${ag.id} was entered by an agent and is not yet verified against the executed agreement — it does not settle until a human verifies it`)
        if (verified && r.brokerage_policy_permits !== true) f.push(`fee ${r.id} is verified but brokerage policy permission is not recorded`)
        if (amount === null) f.push(`fee ${r.id} is ${value}% of the price, but the deal's price is not known — no dollar figure`)
        const settles = verified && r.brokerage_policy_permits === true && r.payable_at_closing === true && r.included_in_commission === false && amount !== null && r.payer === ag.payer
        if (verified && r.included_in_commission) f.push(`fee ${r.id} is part of the commission the agreement states — it is NOT a separate settlement line (no double count)`)
        if (verified && !r.payable_at_closing) f.push(`fee ${r.id} is not payable at closing — it is billed outside the settlement statement`)
        fees.push({
          feeId: r.id, kind, payer: ag.payer, receiver: (CLIENT_FEE_RECEIVERS as readonly string[]).includes(r.receiver) ? (r.receiver as ClientFeeReceiver) : null,
          establishedBy: { kind: ag.kind, id: ag.id }, amount, valueType: vt, value, payableAtClosing: r.payable_at_closing, includedInCommission: r.included_in_commission,
          status: r.status as ClientFeeStatus, settlesAsOwnLine: settles, amendedBy: r.supersedes_fee_id ? (r.amendment_document_id ?? null) : null, findings: f,
        })
        findings.push(...f)
        if (live.length > 1) findings.push(`${live.length} live ${kind.replace(/_/g, " ")} rows on ${ag.kind.replace(/_/g, " ")} ${ag.id} — the latest effective one applies; a human retires the others`)
        continue
      }
      // the legacy intake field — only for a listing agreement's transaction fee, only when no row of that kind exists at all
      if (ag.kind === "listing_agreement" && kind === "transaction_fee" && ofKind.length === 0) {
        const legacy = num(input.listingAgreements.find((a) => a.id === ag.id)?.seller_transaction_fee)
        if (legacy !== null && legacy > 0) {
          const msg = `the listing intake recorded a $${legacy} seller transaction fee on ${ag.id} with no receiver, payable-at-closing or commission treatment — it does not settle until a human verifies it as a client-agreement fee`
          fees.push({
            feeId: null, kind, payer: "seller", receiver: null, establishedBy: { kind: ag.kind, id: ag.id }, amount: round2(legacy), valueType: "flat", value: legacy,
            payableAtClosing: null, includedInCommission: null, status: "legacy_unverified", settlesAsOwnLine: false, amendedBy: null, findings: [msg],
          })
          findings.push(msg)
        }
      }
    }
  }
  const settlementTotals: ClientFeeResolution["settlementTotals"] = { seller: {}, buyer: {} }
  for (const f of fees) {
    if (!f.settlesAsOwnLine || f.amount === null) continue
    settlementTotals[f.payer][f.kind] = round2((settlementTotals[f.payer][f.kind] ?? 0) + f.amount)
  }
  return { fees, settlementTotals, findings }
}

// ─── I/O ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Db = { from: (t: string) => any }

/** A missing m859 table — reported by name (fail closed: nothing settles, nothing is written). */
function m859Missing(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  return error.code === "42P01" || error.code === "PGRST205" || /client_agreement_fees/.test(String(error.message ?? "")) && /does not exist|schema cache/i.test(String(error.message ?? ""))
}

/**
 * The deal's client-agreement fees: its listing agreement(s) (transactions.listing_id) and the buyer's active buyer-broker
 * agreement(s) (transactions.buyer_contact_id), their fee rows, resolved on the deal's date. Tenant-pinned; a refused read is a
 * refusal (never "no fees"); an unapplied m859 is `available: false`, said.
 */
export async function loadClientAgreementFeesForTransaction(
  db: Db,
  brokerageId: string,
  transactionId: string,
): Promise<{ ok: true; available: boolean; resolution: ClientFeeResolution; agreements: Array<{ kind: "listing_agreement" | "buyer_broker_agreement"; id: string }> } | { ok: false; error: string }> {
  if (!brokerageId) return { ok: false, error: "no_tenant" }
  const { data: txn, error: tErr } = await db.from("transactions").select("id, listing_id, buyer_contact_id, purchase_price, close_date, estimated_close_date, contract_date").eq("id", transactionId).eq("brokerage_id", brokerageId).maybeSingle()
  if (tErr) return { ok: false, error: `transaction_read_refused: ${tErr.message}` }
  if (!txn) return { ok: false, error: "transaction_not_found" }
  const t = txn as { listing_id?: string | null; buyer_contact_id?: string | null; purchase_price?: unknown; close_date?: string | null; estimated_close_date?: string | null; contract_date?: string | null }
  const asOf = calendarDay(t.close_date) ?? calendarDay(t.estimated_close_date) ?? calendarDay(t.contract_date) ?? new Date().toISOString().slice(0, 10)
  let listingAgreements: Array<{ id: string; seller_transaction_fee?: unknown }> = []
  if (t.listing_id) {
    const { data, error } = await db.from("listing_agreements").select("id, seller_transaction_fee").eq("brokerage_id", brokerageId).eq("listing_id", t.listing_id)
    if (error) return { ok: false, error: `listing_agreement_read_refused: ${error.message}` }
    listingAgreements = (data ?? []) as typeof listingAgreements
  }
  let buyerAgreementIds: string[] = []
  if (t.buyer_contact_id) {
    const { data, error } = await db.from("buyer_broker_agreements").select("id, status").eq("brokerage_id", brokerageId).eq("buyer_contact_id", t.buyer_contact_id)
    if (error) return { ok: false, error: `buyer_agreement_read_refused: ${error.message}` }
    buyerAgreementIds = ((data ?? []) as Array<{ id: string; status?: string | null }>).filter((r) => r.status === "active" || r.status === "expired" || r.status === "superseded").map((r) => r.id)
  }
  const ids = [...listingAgreements.map((a) => a.id), ...buyerAgreementIds]
  let rows: ClientFeeRow[] = []
  let available = true
  if (ids.length > 0) {
    const filters: string[] = []
    if (listingAgreements.length) filters.push(`listing_agreement_id.in.(${listingAgreements.map((a) => a.id).join(",")})`)
    if (buyerAgreementIds.length) filters.push(`buyer_broker_agreement_id.in.(${buyerAgreementIds.join(",")})`)
    const { data, error } = await db.from("client_agreement_fees").select("*").eq("brokerage_id", brokerageId).or(filters.join(","))
    if (error && m859Missing(error)) available = false
    else if (error) return { ok: false, error: `client_fees_read_refused: ${error.message}` }
    else rows = (data ?? []) as ClientFeeRow[]
  }
  const resolution = resolveClientAgreementFees({ asOf, purchasePrice: num(t.purchase_price), listingAgreements, buyerAgreementIds, rows })
  if (!available) resolution.findings.push("client_agreement_fees (m859) is not applied — only the listing intake's legacy field is read, and nothing settles")
  const agreements = [
    ...listingAgreements.map((a) => ({ kind: "listing_agreement" as const, id: a.id })),
    ...buyerAgreementIds.map((id) => ({ kind: "buyer_broker_agreement" as const, id })),
  ]
  return { ok: true, available, resolution, agreements }
}

/** The agreement an agent or admin may record a fee on — tenant-pinned, with its agent (agents.id) for the RLS book reader. */
async function loadEstablishingAgreement(
  db: Db,
  brokerageId: string,
  ref: { listingAgreementId?: string | null; buyerBrokerAgreementId?: string | null },
): Promise<{ ok: true; kind: "listing_agreement" | "buyer_broker_agreement"; id: string; payer: ClientFeePayer; agentId: string | null; executed: boolean } | { ok: false; error: string }> {
  if (!!ref.listingAgreementId === !!ref.buyerBrokerAgreementId) return { ok: false, error: "name exactly one agreement: the listing agreement (seller) or the buyer-broker agreement (buyer)" }
  if (ref.listingAgreementId) {
    const { data, error } = await db.from("listing_agreements").select("id, agent_user_id, esign_status, fully_executed_at").eq("id", ref.listingAgreementId).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { ok: false, error: `listing_agreement_read_refused: ${error.message}` }
    if (!data) return { ok: false, error: "listing_agreement_not_found" }
    const d = data as { agent_user_id?: string | null; esign_status?: string | null; fully_executed_at?: string | null }
    let agentId: string | null = null
    if (d.agent_user_id) {
      const { data: ag, error: agErr } = await db.from("agents").select("id").eq("user_id", d.agent_user_id).eq("brokerage_id", brokerageId).maybeSingle()
      if (agErr) return { ok: false, error: `agent_read_refused: ${agErr.message}` }
      agentId = (ag as { id?: string } | null)?.id ?? null
    }
    const executed = ["fully_signed", "fully_executed", "compliance_pending", "compliance_approved"].includes(String(d.esign_status ?? "")) || !!d.fully_executed_at
    return { ok: true, kind: "listing_agreement", id: ref.listingAgreementId, payer: "seller", agentId, executed }
  }
  const { data, error } = await db.from("buyer_broker_agreements").select("id, agent_id, status, signed_at").eq("id", ref.buyerBrokerAgreementId as string).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: `buyer_agreement_read_refused: ${error.message}` }
  if (!data) return { ok: false, error: "buyer_agreement_not_found" }
  const d = data as { agent_id?: string | null; status?: string | null; signed_at?: string | null }
  return { ok: true, kind: "buyer_broker_agreement", id: ref.buyerBrokerAgreementId as string, payer: "buyer", agentId: d.agent_id ?? null, executed: !!d.signed_at && d.status !== "draft" && d.status !== "pending_signature" }
}

export interface ClientFeeEntry {
  listingAgreementId?: string | null
  buyerBrokerAgreementId?: string | null
  kind: ClientFeeKind
  receiver: ClientFeeReceiver
  value: number
  valueType: ClientFeeValueType
  payableAtClosing: boolean
  includedInCommission: boolean
  effectiveDate: string
  notes?: string | null
}

/** PURE — the shape of an entered fee (refused by name). Module-private: reached through the writers. */
function validateEntry(e: ClientFeeEntry): string | null {
  if (!(CLIENT_FEE_KINDS as readonly string[]).includes(e.kind)) return "kind_invalid: transaction_fee or admin_fee"
  if (!(CLIENT_FEE_RECEIVERS as readonly string[]).includes(e.receiver)) return "receiver_invalid: brokerage or agent — who the agreement says receives it"
  if (!(CLIENT_FEE_VALUE_TYPES as readonly string[]).includes(e.valueType)) return "value_type_invalid: flat or percent_of_price"
  const v = Number(e.value)
  if (!Number.isFinite(v) || v <= 0) return "value_invalid: a fee is a positive amount"
  if (e.valueType === "percent_of_price" && v > 100) return "value_invalid: a percent of the price is at most 100"
  if (typeof e.payableAtClosing !== "boolean") return "payable_at_closing_required: state whether the agreement makes it payable at closing"
  if (typeof e.includedInCommission !== "boolean") return "included_in_commission_required: state whether the agreement's commission already includes it"
  if (!calendarDay(e.effectiveDate)) return "effective_date_invalid: the date the agreement (or its amendment) makes the fee effective, yyyy-mm-dd"
  return null
}

const isTenantStaff = (a: AgreementActor) => TENANT_ADMIN_USER_TYPES.has(String(a.userType ?? "").toLowerCase())
const isFinance = (a: AgreementActor) => isBrokerageFinanceAdmin({ user_type: a.userType, is_tenant_principal: a.isTenantPrincipal })
/** compliance_officer reviews the paper; the finance class verifies money terms — either may verify a client fee. */
const mayVerify = (a: AgreementActor) => isFinance(a) || String(a.userType ?? "").toLowerCase() === "compliance_officer"

async function ledger<T extends { ok: boolean; error?: string }>(db: Db, actor: AgreementActor, action: string, subjectId: string | null, ref: string, reasonDetail: string, detail: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  return withActionLedger<T>(
    { brokerageId: actor.brokerageId, action, actor: { type: "user", userId: actor.userId, agentId: actor.agentId }, subject: { type: "client_agreement_fee", id: subjectId, ref }, reasonCode: "HUMAN_REQUESTED", reasonDetail: reasonDetail.slice(0, 500), riskClass: "FINANCIAL", systemSource: "client_agreement_fee", detail },
    run,
    { settle: (r) => (r.ok ? { status: "executed", outcome: "recorded" } : { status: "failed", outcome: "refused", error: r.error ?? null }), replay: (claim) => ({ ok: false, error: `already ${claim.kind === "in_flight" ? "in flight" : "recorded"}` }) as unknown as T },
    { client: db as never },
  )
}

/**
 * The AGENT (or tenant staff) ENTERS a fee the client's agreement states — status 'entered': not authoritative until a human
 * verifies it against the executed agreement. The agent must be the agreement's own agent.
 */
export async function enterClientAgreementFee(db: Db, actor: AgreementActor, entry: ClientFeeEntry): Promise<{ ok: true; feeId: string } | { ok: false; error: string }> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  const bad = validateEntry(entry)
  if (bad) return { ok: false, error: bad }
  const ag = await loadEstablishingAgreement(db, actor.brokerageId, entry)
  if (!ag.ok) return ag
  if (!isTenantStaff(actor) && (!actor.agentId || actor.agentId !== ag.agentId)) return { ok: false, error: "forbidden: only the agreement's own agent or brokerage staff record its fees" }
  let id: string | null = null
  const res = await ledger(db, actor, "finance.client_fee.entered", null, ag.id, `${entry.kind.replace(/_/g, " ")} entered from the ${ag.kind.replace(/_/g, " ")} (awaiting verification)`, { agreement: ag, entry }, async () => {
    const { data, error } = await db.from("client_agreement_fees").insert({
      brokerage_id: actor.brokerageId,
      listing_agreement_id: ag.kind === "listing_agreement" ? ag.id : null,
      buyer_broker_agreement_id: ag.kind === "buyer_broker_agreement" ? ag.id : null,
      agent_id: ag.agentId, fee_kind: entry.kind, payer: ag.payer, receiver: entry.receiver, value: Number(entry.value), value_type: entry.valueType,
      payable_at_closing: entry.payableAtClosing, included_in_commission: entry.includedInCommission, status: "entered",
      effective_date: calendarDay(entry.effectiveDate), entered_by: actor.userId, notes: entry.notes?.trim() || null,
    }).select("id")
    if (error) return { ok: false, error: m859Missing(error) ? `m859 (client agreement fees) is not applied: ${error.message}` : error.code === "23505" ? "a live fee of this kind is already recorded on this agreement — amend it instead" : `fee_refused: ${error.message}` }
    const rows = (data ?? []) as Array<{ id: string }>
    if (rows.length !== 1) return { ok: false, error: `fee_not_recorded (${rows.length} rows)` }
    id = rows[0].id
    return { ok: true }
  })
  if (!res.ok || !id) return { ok: false, error: res.error ?? "fee_not_recorded" }
  return { ok: true, feeId: id }
}

/**
 * A HUMAN VERIFIES an entered fee against the EXECUTED agreement and records the brokerage-policy decision. Finance admins or
 * the compliance officer; never the agent who entered it. A fee the policy does not permit is refused (it stays entered, the
 * policy reference is kept as evidence) — compare-and-swap on status 'entered'.
 */
export async function verifyClientAgreementFee(
  db: Db,
  actor: AgreementActor,
  input: { feeId: string; brokeragePolicyPermits: boolean; brokeragePolicyRef: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  if (!mayVerify(actor)) return { ok: false, error: "forbidden: a finance admin or the compliance officer verifies a client-agreement fee" }
  const ref = String(input.brokeragePolicyRef ?? "").trim()
  if (ref.length < 3) return { ok: false, error: "policy_ref_required: name the brokerage policy (or its section) that permits — or does not permit — this fee" }
  const { data: cur, error: cErr } = await db.from("client_agreement_fees").select("*").eq("id", input.feeId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (cErr) return { ok: false, error: m859Missing(cErr) ? `m859 (client agreement fees) is not applied: ${cErr.message}` : `fee_read_refused: ${cErr.message}` }
  if (!cur) return { ok: false, error: "fee_not_found" }
  const row = cur as ClientFeeRow & { entered_by?: string | null; listing_agreement_id?: string | null; buyer_broker_agreement_id?: string | null }
  if (row.status !== "entered") return { ok: false, error: `not_pending: this fee is ${row.status}` }
  if (row.entered_by && row.entered_by === actor.userId && !isFinance(actor)) return { ok: false, error: "forbidden: the person who entered a fee does not verify it" }
  const ag = await loadEstablishingAgreement(db, actor.brokerageId, { listingAgreementId: row.listing_agreement_id ?? null, buyerBrokerAgreementId: row.buyer_broker_agreement_id ?? null })
  if (!ag.ok) return ag
  if (!ag.executed) return { ok: false, error: "agreement_not_executed: a fee is verified only against the EXECUTED agreement" }
  const now = new Date().toISOString()
  return ledger(db, actor, input.brokeragePolicyPermits ? "finance.client_fee.verified" : "finance.client_fee.refused_by_policy", input.feeId, ag.id,
    input.brokeragePolicyPermits ? `client ${row.fee_kind.replace(/_/g, " ")} verified against the executed ${ag.kind.replace(/_/g, " ")}` : `client ${row.fee_kind.replace(/_/g, " ")} NOT permitted by brokerage policy (${ref})`,
    { fee_id: input.feeId, policy_permits: input.brokeragePolicyPermits, policy_ref: ref }, async () => {
      const patch = input.brokeragePolicyPermits
        ? { status: "verified", verified_by: actor.userId, verified_at: now, brokerage_policy_permits: true, brokerage_policy_ref: ref }
        : { brokerage_policy_permits: false, brokerage_policy_ref: ref }
      const { data, error } = await db.from("client_agreement_fees").update(patch).eq("id", input.feeId).eq("brokerage_id", actor.brokerageId).eq("status", "entered").select("id")
      if (error) return { ok: false, error: `verify_refused: ${error.message}` }
      if (((data ?? []) as unknown[]).length !== 1) return { ok: false, error: "not_pending: the fee changed under you" }
      return input.brokeragePolicyPermits ? { ok: true } : { ok: false, error: "policy_does_not_permit: recorded — the fee does not settle" }
    })
}

/**
 * AN EXECUTED AMENDMENT CHANGES A FEE: a NEW row (status entered — it is verified like any other) that supersedes the live one,
 * citing the executed amendment document; the prior row is marked superseded (kept). Finance admins / compliance only.
 */
export async function amendClientAgreementFee(
  db: Db,
  actor: AgreementActor,
  input: { supersedesFeeId: string; amendmentDocumentId: string; entry: Omit<ClientFeeEntry, "listingAgreementId" | "buyerBrokerAgreementId" | "kind"> },
): Promise<{ ok: true; feeId: string } | { ok: false; error: string }> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  if (!mayVerify(actor)) return { ok: false, error: "forbidden: a finance admin or the compliance officer records an executed amendment of a client fee" }
  const { data: prev, error: pErr } = await db.from("client_agreement_fees").select("*").eq("id", input.supersedesFeeId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (pErr) return { ok: false, error: `fee_read_refused: ${pErr.message}` }
  const p = prev as (ClientFeeRow & { agent_id?: string | null }) | null
  if (!p) return { ok: false, error: "fee_not_found" }
  if (p.status !== "entered" && p.status !== "verified") return { ok: false, error: `not_live: this fee is ${p.status}` }
  const entry: ClientFeeEntry = { ...input.entry, kind: p.fee_kind as ClientFeeKind, listingAgreementId: p.listing_agreement_id ?? null, buyerBrokerAgreementId: p.buyer_broker_agreement_id ?? null }
  const bad = validateEntry(entry)
  if (bad) return { ok: false, error: bad }
  const { data: doc, error: dErr } = await db.from("documents").select("id").eq("id", input.amendmentDocumentId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (dErr) return { ok: false, error: `document_read_refused: ${dErr.message}` }
  if (!doc) return { ok: false, error: "amendment_document_not_found: the executed amendment must be stored in this brokerage" }
  let id: string | null = null
  const res = await ledger(db, actor, "finance.client_fee.amended", input.supersedesFeeId, input.amendmentDocumentId, `client ${p.fee_kind.replace(/_/g, " ")} amended by an executed amendment`, { supersedes: input.supersedesFeeId, amendment_document_id: input.amendmentDocumentId, entry }, async () => {
    const { data: sup, error: sErr } = await db.from("client_agreement_fees").update({ status: "superseded" }).eq("id", input.supersedesFeeId).eq("brokerage_id", actor.brokerageId).in("status", ["entered", "verified"]).select("id")
    if (sErr) return { ok: false, error: `supersede_refused: ${sErr.message}` }
    if (((sup ?? []) as unknown[]).length !== 1) return { ok: false, error: "not_live: the fee changed under you" }
    const { data, error } = await db.from("client_agreement_fees").insert({
      brokerage_id: actor.brokerageId, listing_agreement_id: p.listing_agreement_id ?? null, buyer_broker_agreement_id: p.buyer_broker_agreement_id ?? null,
      agent_id: p.agent_id ?? null, fee_kind: p.fee_kind, payer: p.payer, receiver: entry.receiver, value: Number(entry.value), value_type: entry.valueType,
      payable_at_closing: entry.payableAtClosing, included_in_commission: entry.includedInCommission, status: "entered",
      effective_date: calendarDay(entry.effectiveDate), entered_by: actor.userId, supersedes_fee_id: input.supersedesFeeId,
      amendment_document_id: input.amendmentDocumentId, notes: entry.notes?.trim() || null,
    }).select("id")
    const rows = (data ?? []) as Array<{ id: string }>
    if (error || rows.length !== 1) {
      // compensate: the fee the amendment could not replace stays LIVE as it was (never left superseded by nothing)
      const { data: back, error: bErr } = await db.from("client_agreement_fees").update({ status: p.status }).eq("id", input.supersedesFeeId).eq("brokerage_id", actor.brokerageId).eq("status", "superseded").select("id")
      const restored = !bErr && ((back ?? []) as unknown[]).length === 1
      return { ok: false, error: `amendment_refused: ${error?.message ?? `${rows.length} rows written`}${restored ? " (the prior fee is unchanged)" : " — AND the prior fee could not be restored; a finance admin must re-open it"}` }
    }
    id = rows[0].id
    return { ok: true }
  })
  if (!res.ok || !id) return { ok: false, error: res.error ?? "amendment_not_recorded" }
  return { ok: true, feeId: id }
}
