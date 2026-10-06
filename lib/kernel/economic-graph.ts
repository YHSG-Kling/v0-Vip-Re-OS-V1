// lib/kernel/economic-graph.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ECONOMIC GRAPH — ONE kernel READ service deriving financial truth from
// AUTHORITATIVE LEDGER ROWS ONLY (wave 104, lane 104A; owner: "the ledger is
// authoritative, summaries are projections that reconcile back").
//
// SURVIVORS EVALUATED (CLAUDE.md §1, never re-derived):
//   · commission_distributions — THE ledger: one row per share of one closing
//     (waterfall step 11, lib/commission/waterfall/11-validate-persist.ts), posted
//     entries append-only (m689), corrections as NEW rows (m690: entry_type
//     'reversal' | 'adjustment', adjusts_distribution_id, correction_reason —
//     lib/commission/distribution-correction.ts planDistributionCorrection).
//   · commission_calculations — the frozen gross per closing (total_commission,
//     engine inputs + breakdown) — the economic EVENT's amount of record.
//   · company_books_obligations — brokerage-funded shares a capped deal could not
//     fund (m577; owner 2026-08-28: the cap ends the TAKING, not the PAYING).
//   · agent_relationships — the recruiting / residual tree (sponsor, depth,
//     effective window, stamped terms); the rules are revenue-share-model.ts.
//   · ai_tool_usage (cost_cents, platform_paid), vendor_usage_tracking
//     (total_cost), agent_action_ledger.cost_usd — the three cost ledgers
//     (CLAUDE.md §5: ai_tool_usage is the AI cost ledger); meter_readings is a
//     PERIOD PROJECTION of ai_tool_usage and is reconciled, never summed in.
//   · referral_payouts (recipient_brokerage_id — platform → brokerage, inbound),
//     vendor_invoices / vendor_payouts (marketplace economics).
//   · lib/intelligence/brokerage-pnl.ts generateBrokeragePnl is NOT this: it
//     folds transactions.commission_amount + commission_splits (m214) — summary
//     columns the engine writes, i.e. a PROJECTION. It stays the owner's report;
//     the reconciler (lib/commission/reconcile-tracking.ts
//     reconcileSummariesAgainstLedger) is where it is checked against this graph.
//
// DETERMINISTIC: integer cents end to end, one rounding at each ledger boundary,
// no model narration, no wall clock inside the pure core (the event date is the
// transaction's close_date). TENANT-SCOPED: every read pins brokerage_id (or
// recipient_brokerage_id for the one inbound table) and the pure core DROPS any
// row stamped with another tenant, counting it. EVERY NUMBER CITES ITS ROWS:
// each share / cost / gross carries LedgerRef[] (table + id) — a figure with no
// ref is a figure this file refused to make up.
//
// Agents never see this graph (CLAUDE.md §5: commission is off agent-facing
// display): readers are the brokerage finance page (isBrokerageFinanceAdmin),
// the broker brief and the admin command center.

import {
  computeRevenueShare,
  withinEffectiveWindow,
  type RevenueShareEdge,
  type RevenueShareModelState,
} from "@/lib/commission/revenue-share-model"
import type { DistributionRecord } from "@/lib/commission/types"
import { registerTwinSeam } from "@/lib/kernel/brokerage-twin"

type Client = { from: (table: string) => any }

/** Tables a number in this graph may cite — the authoritative ledgers, nothing else. */
export type EconomicLedgerTable =
  | "commission_calculations"
  | "commission_distributions"
  | "company_books_obligations"
  | "agent_relationships"
  | "ai_tool_usage"
  | "vendor_usage_tracking"
  | "agent_action_ledger"
  | "referral_payouts"
  | "vendor_invoices"
  | "vendor_payouts"
  | "transactions"

export interface LedgerRef { table: EconomicLedgerTable; id: string }

/** §6: ONE vocabulary — the live CHECK on commission_distributions.distribution_type. */
export type EconomicShareKind = DistributionRecord["distribution_type"]
const ECONOMIC_SHARE_KINDS: readonly EconomicShareKind[] = ["agent", "brokerage", "team_member", "referral", "residual", "royalty", "fee"]

export interface EconomicShare {
  kind: EconomicShareKind
  agentId: string | null
  teamId: string | null
  sourceOfFunds: string | null
  /** The posted entry's amount (entry_type 'entry' / null). */
  entryCents: number
  /** Σ corrections (reversal + adjustment rows pointing at this entry). */
  correctionCents: number
  /** entryCents + correctionCents — what the share nets to today. */
  netCents: number
  /** The net of this share that has been DISBURSED (status 'paid' on the entry; corrections follow the entry). */
  paidCents: number
  status: string | null
  capStatus: string | null
  refs: LedgerRef[]
}

export type EconomicCostKind = "ai_tool" | "vendor_data" | "provider_action" | "vendor_invoice"

export interface EconomicCost {
  kind: EconomicCostKind
  cents: number
  /** true = the platform bore it (ai_tool_usage.platform_paid); the tenant's margin does not carry it. */
  platformCovered: boolean
  agentId: string | null
  transactionId: string | null
  refs: LedgerRef[]
}

export interface ResidualExpectation {
  sponsorAgentId: string
  depth: number
  rateType: "percent" | "flat"
  value: number
  sourceOfFunds: string | null
  ref: LedgerRef
}

export interface ResidualResolution {
  /** Edges in force on the event date for the producing agent (the tree, resolved). */
  expected: ResidualExpectation[]
  /** 'residual' shares recorded on the ledger for this closing. */
  recorded: EconomicShare[]
  /** Expected sponsors with no recorded residual share — a finding, not a verdict
   *  (the model may be disabled / unconfigured — stage 09 records that skip). */
  missing: ResidualExpectation[]
  /** Recorded residual shares whose recipient has no edge in force — a finding. */
  unexpected: EconomicShare[]
}

export interface TransactionEconomics {
  transactionId: string
  brokerageId: string
  /** Producing agent (transactions.agent_id). */
  agentId: string | null
  closeDate: string | null
  /** The event's amount of record. */
  grossCents: number
  grossSource: "commission_calculations" | "distribution_entries" | "none"
  shares: EconomicShare[]
  byKind: Record<EconomicShareKind, number>
  /** Σ entry_type 'adjustment' rows / 'reversal' rows / voided entries. */
  adjustmentCents: number
  reversalCents: number
  voidedCents: number
  paidCents: number
  unpaidCents: number
  companyObligationCents: number
  costs: EconomicCost[]
  tenantCostCents: number
  platformCoveredCostCents: number
  /** brokerage share (net) − tenant-borne costs − company-books obligations. */
  contributionMarginCents: number
  /** gross == Σ posted entries (step 11's identity, re-checked from the rows). */
  conservation: { ok: boolean; deltaCents: number }
  residuals: ResidualResolution
  /** Rows stamped with another brokerage that arrived in this derivation — dropped, counted. */
  foreignRowsDropped: number
  evidence: LedgerRef[]
}

// ─── Raw ledger row shapes (what the loader selects; what the proof fixtures feed) ───

export interface CalculationRow { id: string; brokerage_id: string | null; transaction_id: string | null; total_commission: number | string | null }
export interface DistributionRow {
  id: string
  brokerage_id: string | null
  transaction_id: string | null
  distribution_type: string | null
  entry_type?: string | null
  adjusts_distribution_id?: string | null
  agent_id: string | null
  team_id: string | null
  source_of_funds: string | null
  calculated_amount: number | string | null
  status: string | null
  cap_status?: string | null
  paid_at?: string | null
}
export interface ObligationRow { id: string; brokerage_id: string | null; transaction_id: string | null; calculated_amount: number | string | null; status: string | null }
export interface RelationshipRow extends RevenueShareEdge { id: string; brokerage_id: string | null; agent_id: string | null }
export interface CostRow {
  table: "ai_tool_usage" | "vendor_usage_tracking" | "agent_action_ledger" | "vendor_invoices"
  id: string
  brokerage_id: string | null
  agent_id: string | null
  transaction_id: string | null
  cents: number
  platform_paid: boolean
}

const toCents = (v: number | string | null | undefined): number => {
  const n = typeof v === "string" ? Number(v) : (v ?? 0)
  return Number.isFinite(n) ? Math.round((n as number) * 100) : 0
}
// ONE void signal: status = 'voided' (the CHECK vocabulary). `voided_at` / `voided_reason` are live
// columns with NO writer anywhere (code, trigger, RPC — integrator census, wave 104); reading them
// would be a second spelling nobody fills (CLAUDE.md §6). Owner item: a void writer belongs in
// lib/commission/distribution-correction.ts, and would stamp both.
const isVoided = (r: { status: string | null }) => (r.status ?? "").toLowerCase() === "voided"
const emptyByKind = (): Record<EconomicShareKind, number> =>
  ({ agent: 0, brokerage: 0, team_member: 0, referral: 0, residual: 0, royalty: 0, fee: 0 })

/**
 * PURE: the residual tree for ONE economic event — the producing agent's sponsor
 * edges in force ON THE EVENT DATE (not today: a share that expired last month
 * still owed on a closing dated before it expired). Terms come off the EDGE
 * (revenue-share-model.ts: the edge is the record of its own terms).
  * @proofSeam the event-date residual tree the proof asserts directly (expired / foreign / other-agent edges excluded); the loader reaches it through deriveTransactionEconomics
 */
export function resolveResidualTree(
  edges: readonly RelationshipRow[],
  agentId: string | null,
  eventDate: string | null,
  /** When given, an edge stamped with another tenant is ignored (the pure core always passes it). */
  brokerageId?: string,
): ResidualExpectation[] {
  if (!agentId || !eventDate) return []
  const day = eventDate.slice(0, 10)
  const out: ResidualExpectation[] = []
  for (const e of edges) {
    if (brokerageId && e.brokerage_id !== brokerageId) continue
    if (e.agent_id !== agentId || !e.sponsor_agent_id || e.is_active === false) continue
    if (!withinEffectiveWindow(e, day)) continue
    const flat = Number(e.revenue_share_flat_cents)
    const pct = Number(e.revenue_share_percent)
    if (Number.isFinite(flat) && flat > 0) {
      out.push({ sponsorAgentId: e.sponsor_agent_id, depth: e.depth_level ?? 1, rateType: "flat", value: Math.round(flat), sourceOfFunds: e.source_of_funds ?? null, ref: { table: "agent_relationships", id: e.id } })
    } else if (Number.isFinite(pct) && pct > 0) {
      out.push({ sponsorAgentId: e.sponsor_agent_id, depth: e.depth_level ?? 1, rateType: "percent", value: pct, sourceOfFunds: e.source_of_funds ?? null, ref: { table: "agent_relationships", id: e.id } })
    }
  }
  return out.sort((a, b) => a.depth - b.depth)
}

/**
 * PURE: what the configured model WOULD pay the tree on this event — the
 * projection side of a residual reconciliation. Delegates to the ONE money step
 * (computeRevenueShare) so a projected residual can never disagree with the
 * waterfall's own arithmetic. Null when the model is off/unconfigured.
 * @proofSeam the projection half of the residual reconciliation; test:economic-graph asserts it
 * against the recorded residual share until a surface renders expected-vs-recorded per sponsor
 */
export function projectResidualShares(input: {
  brokerageId: string
  agentId: string
  agentFinalNetCents: number
  brokerageFinalCents: number
  state: RevenueShareModelState
  edges: readonly RelationshipRow[]
  eventDate: string
}): Array<{ sponsorAgentId: string; cents: number }> | null {
  const r = computeRevenueShare({
    agentId: input.agentId,
    agentFinalNetCents: input.agentFinalNetCents,
    brokerageFinalCents: input.brokerageFinalCents,
    state: input.state,
    relationships: input.edges.filter((e) => e.brokerage_id === input.brokerageId && e.agent_id === input.agentId),
    today: new Date(`${input.eventDate.slice(0, 10)}T00:00:00.000Z`),
  })
  if (r.skipped) return null
  return [
    ...r.distributions.map((d) => ({ sponsorAgentId: d.agent_id ?? "", cents: Math.round(d.calculated_amount * 100) })),
    ...r.companyObligations.map((o) => ({ sponsorAgentId: o.agent_id, cents: Math.round(o.calculated_amount * 100) })),
  ]
}

/**
 * PURE: the trace for ONE closing — economic event → gross → shares (brokerage,
 * agent, team, referral, residual, royalty, fee) → corrections / reversals →
 * payouts → costs → contribution margin, every number citing its rows.
  * @proofSeam the pure trace the proof feeds in-memory ledger fixtures; product code reaches it through loadEconomicGraph -> assembleEconomicGraph
 */
export function deriveTransactionEconomics(input: {
  transactionId: string
  brokerageId: string
  agentId: string | null
  closeDate: string | null
  calculation: CalculationRow | null
  distributions: readonly DistributionRow[]
  obligations: readonly ObligationRow[]
  costs: readonly CostRow[]
  relationships: readonly RelationshipRow[]
}): TransactionEconomics {
  const { transactionId, brokerageId } = input
  let foreignRowsDropped = 0
  const inTenant = <T extends { brokerage_id: string | null; transaction_id?: string | null }>(rows: readonly T[], txnKeyed = true): T[] =>
    rows.filter((r) => {
      if (r.brokerage_id !== brokerageId) { foreignRowsDropped++; return false }
      return !txnKeyed || r.transaction_id === transactionId
    })
  const evidence: LedgerRef[] = []
  const cite = (ref: LedgerRef) => { evidence.push(ref); return ref }

  const calc = input.calculation && input.calculation.brokerage_id === brokerageId && input.calculation.transaction_id === transactionId
    ? input.calculation : null
  if (input.calculation && !calc) foreignRowsDropped++

  const dists = inTenant(input.distributions)
  const entries = dists.filter((d) => (d.entry_type ?? "entry") === "entry")
  const corrections = dists.filter((d) => (d.entry_type ?? "entry") !== "entry")

  // Corrections attach to the entry they adjust; a correction naming no entry
  // (or a foreign one) is still MONEY and is counted on its own kind.
  const correctionsFor = new Map<string, DistributionRow[]>()
  const strayCorrections: DistributionRow[] = []
  for (const c of corrections) {
    const target = c.adjusts_distribution_id && entries.find((e) => e.id === c.adjusts_distribution_id)
    if (target) {
      const list = correctionsFor.get(target.id) ?? []
      list.push(c); correctionsFor.set(target.id, list)
    } else strayCorrections.push(c)
  }

  const byKind = emptyByKind()
  const shares: EconomicShare[] = []
  let adjustmentCents = 0, reversalCents = 0, voidedCents = 0, paidCents = 0, entrySumCents = 0

  for (const e of entries) {
    const kind = (ECONOMIC_SHARE_KINDS as readonly string[]).includes(e.distribution_type ?? "") ? (e.distribution_type as EconomicShareKind) : null
    if (!kind) continue
    const entryCents = toCents(e.calculated_amount)
    if (isVoided(e)) { voidedCents += entryCents; cite({ table: "commission_distributions", id: e.id }); continue }
    const refs: LedgerRef[] = [cite({ table: "commission_distributions", id: e.id })]
    let correctionCents = 0
    for (const c of correctionsFor.get(e.id) ?? []) {
      if (isVoided(c)) { voidedCents += toCents(c.calculated_amount); cite({ table: "commission_distributions", id: c.id }); continue }
      const cc = toCents(c.calculated_amount)
      correctionCents += cc
      if ((c.entry_type ?? "") === "reversal") reversalCents += cc; else adjustmentCents += cc
      refs.push(cite({ table: "commission_distributions", id: c.id }))
    }
    const netCents = entryCents + correctionCents
    const paid = (e.status ?? "").toLowerCase() === "paid" ? netCents : 0
    entrySumCents += entryCents
    byKind[kind] += netCents
    paidCents += paid
    shares.push({
      kind, agentId: e.agent_id ?? null, teamId: e.team_id ?? null, sourceOfFunds: e.source_of_funds ?? null,
      entryCents, correctionCents, netCents, paidCents: paid, status: e.status ?? null, capStatus: e.cap_status ?? null, refs,
    })
  }
  for (const c of strayCorrections) {
    const kind = (ECONOMIC_SHARE_KINDS as readonly string[]).includes(c.distribution_type ?? "") ? (c.distribution_type as EconomicShareKind) : null
    const cc = toCents(c.calculated_amount)
    const ref = cite({ table: "commission_distributions", id: c.id })
    if (!kind || isVoided(c)) { voidedCents += isVoided(c) ? cc : 0; continue }
    if ((c.entry_type ?? "") === "reversal") reversalCents += cc; else adjustmentCents += cc
    byKind[kind] += cc
    shares.push({ kind, agentId: c.agent_id ?? null, teamId: c.team_id ?? null, sourceOfFunds: c.source_of_funds ?? null, entryCents: 0, correctionCents: cc, netCents: cc, paidCents: 0, status: c.status ?? null, capStatus: c.cap_status ?? null, refs: [ref] })
  }

  // GROSS — the frozen amount of record, else the posted entries' sum (the step-11
  // identity makes them equal on a healthy closing); never transactions.commission_amount.
  let grossCents = 0
  let grossSource: TransactionEconomics["grossSource"] = "none"
  if (calc) { grossCents = toCents(calc.total_commission); grossSource = "commission_calculations"; cite({ table: "commission_calculations", id: calc.id }) }
  else if (entries.length > 0) { grossCents = entrySumCents; grossSource = "distribution_entries" }
  const conservationDelta = grossCents - entrySumCents
  const conservation = { ok: grossSource !== "none" && conservationDelta === 0, deltaCents: conservationDelta }

  const obligations = inTenant(input.obligations).filter((o) => !isVoided(o))
  let companyObligationCents = 0
  for (const o of obligations) { companyObligationCents += toCents(o.calculated_amount); cite({ table: "company_books_obligations", id: o.id }) }

  const costRows = inTenant(input.costs)
  const costs: EconomicCost[] = []
  let tenantCostCents = 0, platformCoveredCostCents = 0
  for (const c of costRows) {
    const kind: EconomicCostKind = c.table === "ai_tool_usage" ? "ai_tool" : c.table === "vendor_usage_tracking" ? "vendor_data" : c.table === "agent_action_ledger" ? "provider_action" : "vendor_invoice"
    const ref = cite({ table: c.table, id: c.id })
    if (c.platform_paid) platformCoveredCostCents += c.cents; else tenantCostCents += c.cents
    costs.push({ kind, cents: c.cents, platformCovered: c.platform_paid, agentId: c.agent_id, transactionId: c.transaction_id, refs: [ref] })
  }

  const netShares = shares.reduce((s, x) => s + x.netCents, 0)
  const unpaidCents = netShares - paidCents
  const contributionMarginCents = byKind.brokerage - tenantCostCents - companyObligationCents

  const relationships = inTenant(input.relationships, false)
  const expected = resolveResidualTree(relationships, input.agentId, input.closeDate, brokerageId)
  const recorded = shares.filter((s) => s.kind === "residual")
  const residuals: ResidualResolution = {
    expected, recorded,
    missing: expected.filter((x) => !recorded.some((r) => r.agentId === x.sponsorAgentId)),
    unexpected: recorded.filter((r) => !expected.some((x) => x.sponsorAgentId === r.agentId)),
  }
  for (const x of expected) cite(x.ref)

  return {
    transactionId, brokerageId, agentId: input.agentId, closeDate: input.closeDate,
    grossCents, grossSource, shares, byKind,
    adjustmentCents, reversalCents, voidedCents, paidCents, unpaidCents,
    companyObligationCents, costs, tenantCostCents, platformCoveredCostCents, contributionMarginCents,
    conservation, residuals, foreignRowsDropped, evidence,
  }
}

// ─── ROLL-UPS: per transaction → agent / team / brokerage / period ─────────────

export interface EconomicRollup {
  key: string
  transactions: number
  grossCents: number
  brokerageShareCents: number
  agentShareCents: number
  teamShareCents: number
  referralShareCents: number
  residualShareCents: number
  royaltyShareCents: number
  feeShareCents: number
  adjustmentCents: number
  reversalCents: number
  paidCents: number
  unpaidCents: number
  companyObligationCents: number
  tenantCostCents: number
  platformCoveredCostCents: number
  contributionMarginCents: number
  conservationFailures: number
  residualFindings: number
  evidenceRows: number
}

const emptyRollup = (key: string): EconomicRollup => ({
  key, transactions: 0, grossCents: 0, brokerageShareCents: 0, agentShareCents: 0, teamShareCents: 0, referralShareCents: 0,
  residualShareCents: 0, royaltyShareCents: 0, feeShareCents: 0, adjustmentCents: 0, reversalCents: 0, paidCents: 0, unpaidCents: 0,
  companyObligationCents: 0, tenantCostCents: 0, platformCoveredCostCents: 0, contributionMarginCents: 0,
  conservationFailures: 0, residualFindings: 0, evidenceRows: 0,
})

/** PURE: fold transaction traces by a key (producing agent / team / month / brokerage).  * @proofSeam the fold the proof checks for agreement with the trace; product code reaches it through assembleEconomicGraph
 */
export function rollupEconomics(txns: readonly TransactionEconomics[], keyOf: (t: TransactionEconomics) => string | null): EconomicRollup[] {
  const acc = new Map<string, EconomicRollup>()
  for (const t of txns) {
    const key = keyOf(t)
    if (key == null) continue
    const r = acc.get(key) ?? emptyRollup(key)
    r.transactions++
    r.grossCents += t.grossCents
    r.brokerageShareCents += t.byKind.brokerage
    r.agentShareCents += t.byKind.agent
    r.teamShareCents += t.byKind.team_member
    r.referralShareCents += t.byKind.referral
    r.residualShareCents += t.byKind.residual
    r.royaltyShareCents += t.byKind.royalty
    r.feeShareCents += t.byKind.fee
    r.adjustmentCents += t.adjustmentCents
    r.reversalCents += t.reversalCents
    r.paidCents += t.paidCents
    r.unpaidCents += t.unpaidCents
    r.companyObligationCents += t.companyObligationCents
    r.tenantCostCents += t.tenantCostCents
    r.platformCoveredCostCents += t.platformCoveredCostCents
    r.contributionMarginCents += t.contributionMarginCents
    if (!t.conservation.ok) r.conservationFailures++
    r.residualFindings += t.residuals.missing.length + t.residuals.unexpected.length
    r.evidenceRows += t.evidence.length
    acc.set(key, r)
  }
  return Array.from(acc.values()).sort((a, b) => b.grossCents - a.grossCents)
}

/** PURE: a team key for a closing = the team on its team_member share (null when none). */
const teamKeyOf = (t: TransactionEconomics): string | null => t.shares.find((s) => s.kind === "team_member" && s.teamId)?.teamId ?? null
/** PURE: period key = YYYY-MM of the close date. */
const periodKeyOf = (t: TransactionEconomics): string | null => (t.closeDate ? t.closeDate.slice(0, 7) : null)

export interface MarketplaceEconomics {
  /** Platform → this brokerage referral payouts actually received (referral_payouts.received_at). */
  referralPayoutsReceivedCents: number
  /** Vendor invoices billed to the brokerage and paid (tenant cost — already folded into costs when transaction-keyed). */
  vendorInvoicesPaidCents: number
  /** Payouts the brokerage initiated to vendors that completed. */
  vendorPayoutsCompletedCents: number
  refs: LedgerRef[]
}

export interface EconomicGraph {
  brokerageId: string
  since: string
  until: string
  transactions: TransactionEconomics[]
  brokerage: EconomicRollup
  byAgent: EconomicRollup[]
  byTeam: EconomicRollup[]
  byPeriod: EconomicRollup[]
  /** Costs in the window that no transaction claims (agent / brokerage overhead). */
  unattributedCosts: { tenantCostCents: number; platformCoveredCostCents: number; byAgent: Array<{ agentId: string | null; tenantCostCents: number; platformCoveredCostCents: number }>; refs: LedgerRef[] }
  marketplace: MarketplaceEconomics
  /** Brokerage contribution margin for the window: Σ closings' margin − unattributed tenant costs + referral payouts received. */
  contributionMarginCents: number
  /** false when ANY ledger read was refused — every figure is then a floor, not the truth (§4 fail closed). */
  measured: boolean
  warnings: string[]
}

/** PURE: the cost rows a transaction claims — subject-keyed ledgers, never guessed. */
function costRowsForTransaction(costs: readonly CostRow[], transactionId: string): CostRow[] {
  return costs.filter((c) => c.transaction_id === transactionId)
}

/**
 * Tenant-scoped loader. `brokerageId` is an IN-PROCESS contract: the caller is a
 * gated server surface (the finance page's isBrokerageFinanceAdmin gate, the broker
 * brief, the admin command center) — never a request body (§4).
 */
export async function loadEconomicGraph(
  svc: Client,
  params: { brokerageId: string; sinceIso?: string; untilIso?: string },
): Promise<EconomicGraph> {
  const { brokerageId } = params
  const since = params.sinceIso ?? new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).toISOString()
  const until = params.untilIso ?? new Date().toISOString()
  const sinceDate = since.slice(0, 10), untilDate = until.slice(0, 10)
  const warnings: string[] = []
  let measured = true
  const refuse = (what: string, msg: string) => { measured = false; warnings.push(`${what} read refused: ${msg}`) }

  const { data: txnRows, error: txnErr } = await svc.from("transactions")
    .select("id, agent_id, close_date")
    .eq("brokerage_id", brokerageId).eq("status", "closed")
    .gte("close_date", sinceDate).lte("close_date", untilDate).limit(5000)
  if (txnErr) refuse("transactions", txnErr.message)
  const txns = (txnRows ?? []) as Array<{ id: string; agent_id: string | null; close_date: string | null }>
  const txnIds = txns.map((t) => t.id)

  let calcs: CalculationRow[] = [], dists: DistributionRow[] = [], obligations: ObligationRow[] = []
  if (txnIds.length > 0) {
    const [c, d, o] = await Promise.all([
      svc.from("commission_calculations").select("id, brokerage_id, transaction_id, total_commission").eq("brokerage_id", brokerageId).in("transaction_id", txnIds),
      svc.from("commission_distributions").select("id, brokerage_id, transaction_id, distribution_type, entry_type, adjusts_distribution_id, agent_id, team_id, source_of_funds, calculated_amount, status, cap_status, paid_at").eq("brokerage_id", brokerageId).in("transaction_id", txnIds),
      svc.from("company_books_obligations").select("id, brokerage_id, transaction_id, calculated_amount, status").eq("brokerage_id", brokerageId).in("transaction_id", txnIds),
    ])
    if (c.error) refuse("commission_calculations", c.error.message); else calcs = (c.data ?? []) as CalculationRow[]
    if (d.error) refuse("commission_distributions", d.error.message); else dists = (d.data ?? []) as DistributionRow[]
    if (o.error) refuse("company_books_obligations", o.error.message); else obligations = (o.data ?? []) as ObligationRow[]
  }

  const { data: relRows, error: relErr } = await svc.from("agent_relationships").select("*").eq("brokerage_id", brokerageId).limit(5000)
  if (relErr) refuse("agent_relationships", relErr.message)
  const relationships = (relRows ?? []) as RelationshipRow[]

  // The three cost ledgers, window on created_at; transaction attribution by the
  // subject each ledger already carries (never inferred from timing).
  const costs: CostRow[] = []
  const [ai, vendor, actions, invoices] = await Promise.all([
    svc.from("ai_tool_usage").select("id, brokerage_id, agent_id, cost_cents, platform_paid, context_json").eq("brokerage_id", brokerageId).gte("created_at", since).lte("created_at", until).limit(20000),
    svc.from("vendor_usage_tracking").select("id, brokerage_id, agent_id, total_cost, request_metadata").eq("brokerage_id", brokerageId).gte("created_at", since).lte("created_at", until).limit(20000),
    svc.from("agent_action_ledger").select("id, brokerage_id, actor_agent_id, subject_type, subject_id, cost_usd").eq("brokerage_id", brokerageId).not("cost_usd", "is", null).gte("created_at", since).lte("created_at", until).limit(20000),
    svc.from("vendor_invoices").select("id, brokerage_id, transaction_id, billed_to, total_amount, status, paid_at").eq("brokerage_id", brokerageId).gte("invoice_date", sinceDate).lte("invoice_date", untilDate).limit(5000),
  ])
  if (ai.error) refuse("ai_tool_usage", ai.error.message)
  else for (const r of (ai.data ?? []) as Array<Record<string, any>>) {
    const ctx = (r.context_json ?? {}) as Record<string, unknown>
    costs.push({ table: "ai_tool_usage", id: String(r.id), brokerage_id: r.brokerage_id ?? null, agent_id: r.agent_id ?? null, transaction_id: (ctx.transactionId as string | undefined) ?? (ctx.transaction_id as string | undefined) ?? null, cents: Math.round(Number(r.cost_cents) || 0), platform_paid: r.platform_paid === true })
  }
  if (vendor.error) refuse("vendor_usage_tracking", vendor.error.message)
  else for (const r of (vendor.data ?? []) as Array<Record<string, any>>) {
    const meta = (r.request_metadata ?? {}) as Record<string, unknown>
    costs.push({ table: "vendor_usage_tracking", id: String(r.id), brokerage_id: r.brokerage_id ?? null, agent_id: r.agent_id ?? null, transaction_id: (meta.transactionId as string | undefined) ?? null, cents: toCents(r.total_cost), platform_paid: false })
  }
  if (actions.error) refuse("agent_action_ledger", actions.error.message)
  else for (const r of (actions.data ?? []) as Array<Record<string, any>>) {
    costs.push({ table: "agent_action_ledger", id: String(r.id), brokerage_id: r.brokerage_id ?? null, agent_id: r.actor_agent_id ?? null, transaction_id: r.subject_type === "transaction" ? (r.subject_id ?? null) : null, cents: toCents(r.cost_usd), platform_paid: false })
  }
  const marketplaceRefs: LedgerRef[] = []
  let vendorInvoicesPaidCents = 0
  if (invoices.error) refuse("vendor_invoices", invoices.error.message)
  else for (const r of (invoices.data ?? []) as Array<Record<string, any>>) {
    if (r.billed_to !== "brokerage" || (r.status ?? "") !== "paid") continue
    const cents = toCents(r.total_amount)
    vendorInvoicesPaidCents += cents
    marketplaceRefs.push({ table: "vendor_invoices", id: String(r.id) })
    costs.push({ table: "vendor_invoices", id: String(r.id), brokerage_id: r.brokerage_id ?? null, agent_id: null, transaction_id: r.transaction_id ?? null, cents, platform_paid: false })
  }

  const [payoutsIn, payoutsOut] = await Promise.all([
    svc.from("referral_payouts").select("id, amount_cents, received_at").eq("recipient_brokerage_id", brokerageId).not("received_at", "is", null).gte("received_at", since).lte("received_at", until).limit(5000),
    svc.from("vendor_payouts").select("id, amount, status, completed_at").eq("brokerage_id", brokerageId).eq("status", "paid").gte("completed_at", since).lte("completed_at", until).limit(5000),
  ])
  let referralPayoutsReceivedCents = 0, vendorPayoutsCompletedCents = 0
  if (payoutsIn.error) refuse("referral_payouts", payoutsIn.error.message)
  else for (const r of (payoutsIn.data ?? []) as Array<Record<string, any>>) { referralPayoutsReceivedCents += Math.round(Number(r.amount_cents) || 0); marketplaceRefs.push({ table: "referral_payouts", id: String(r.id) }) }
  if (payoutsOut.error) refuse("vendor_payouts", payoutsOut.error.message)
  else for (const r of (payoutsOut.data ?? []) as Array<Record<string, any>>) { vendorPayoutsCompletedCents += toCents(r.amount); marketplaceRefs.push({ table: "vendor_payouts", id: String(r.id) }) }

  return assembleEconomicGraph({ brokerageId, since, until, txns, calcs, dists, obligations, relationships, costs, marketplace: { referralPayoutsReceivedCents, vendorInvoicesPaidCents, vendorPayoutsCompletedCents, refs: marketplaceRefs }, measured, warnings })
}

/** PURE: the graph from already-loaded rows (the loader's second half; the proof feeds it fixtures).  * @proofSeam the loader's pure second half - the proof assembles a graph from fixtures without a database; product code reaches it through loadEconomicGraph
 */
export function assembleEconomicGraph(input: {
  brokerageId: string
  since: string
  until: string
  txns: ReadonlyArray<{ id: string; agent_id: string | null; close_date: string | null }>
  calcs: readonly CalculationRow[]
  dists: readonly DistributionRow[]
  obligations: readonly ObligationRow[]
  relationships: readonly RelationshipRow[]
  costs: readonly CostRow[]
  marketplace: MarketplaceEconomics
  measured: boolean
  warnings: string[]
}): EconomicGraph {
  const { brokerageId } = input
  const calcByTxn = new Map<string, CalculationRow>()
  for (const c of input.calcs) if (c.transaction_id) calcByTxn.set(c.transaction_id, c)
  const claimed = new Set<string>()
  const transactions: TransactionEconomics[] = input.txns.map((t) => {
    const txnCosts = costRowsForTransaction(input.costs, t.id)
    for (const c of txnCosts) claimed.add(`${c.table}:${c.id}`)
    return deriveTransactionEconomics({
      transactionId: t.id, brokerageId, agentId: t.agent_id, closeDate: t.close_date,
      calculation: calcByTxn.get(t.id) ?? null,
      distributions: input.dists.filter((d) => d.transaction_id === t.id),
      obligations: input.obligations.filter((o) => o.transaction_id === t.id),
      costs: txnCosts, relationships: input.relationships,
    })
  })

  const unattributed = input.costs.filter((c) => c.brokerage_id === brokerageId && !claimed.has(`${c.table}:${c.id}`))
  const perAgent = new Map<string | null, { agentId: string | null; tenantCostCents: number; platformCoveredCostCents: number }>()
  let uTenant = 0, uPlatform = 0
  const uRefs: LedgerRef[] = []
  for (const c of unattributed) {
    const a = perAgent.get(c.agent_id) ?? { agentId: c.agent_id, tenantCostCents: 0, platformCoveredCostCents: 0 }
    if (c.platform_paid) { a.platformCoveredCostCents += c.cents; uPlatform += c.cents } else { a.tenantCostCents += c.cents; uTenant += c.cents }
    perAgent.set(c.agent_id, a)
    uRefs.push({ table: c.table, id: c.id })
  }

  const brokerage = rollupEconomics(transactions, () => brokerageId)[0] ?? emptyRollup(brokerageId)
  const byAgent = rollupEconomics(transactions, (t) => t.agentId)
  // Unattributed costs land on the agent that incurred them (margin per agent is
  // what the agent COST the brokerage, not only what they closed).
  for (const a of perAgent.values()) {
    if (!a.agentId) continue
    let node = byAgent.find((n) => n.key === a.agentId)
    if (!node) { node = emptyRollup(a.agentId); byAgent.push(node) }
    node.tenantCostCents += a.tenantCostCents
    node.platformCoveredCostCents += a.platformCoveredCostCents
    node.contributionMarginCents -= a.tenantCostCents
  }
  byAgent.sort((x, y) => y.grossCents - x.grossCents)

  return {
    brokerageId, since: input.since, until: input.until, transactions, brokerage,
    byAgent, byTeam: rollupEconomics(transactions, teamKeyOf), byPeriod: rollupEconomics(transactions, periodKeyOf).sort((a, b) => a.key.localeCompare(b.key)),
    unattributedCosts: { tenantCostCents: uTenant, platformCoveredCostCents: uPlatform, byAgent: Array.from(perAgent.values()), refs: uRefs },
    marketplace: input.marketplace,
    contributionMarginCents: brokerage.contributionMarginCents - uTenant + input.marketplace.referralPayoutsReceivedCents,
    measured: input.measured, warnings: input.warnings,
  }
}

// ─── the twin seam (lib/kernel/brokerage-twin.ts registerTwinSeam) ──────────
// Registered AT MODULE LOAD (lane 104F): the Command Center's twin build lazy-imports this module
// before buildBrokerageTwin, so economic.contributionMargin reads "present" with the ledger-derived
// year-to-date margin. A refused ledger read makes the graph unmeasured — the seam then hands back
// cents: null with the refusal named (a floor is not a margin), and the twin degrades honestly.
registerTwinSeam("contributionMargin", async (svc, brokerageId, teamId) => {
  const graph = await loadEconomicGraph(svc as Client, { brokerageId })
  const source = "lib/kernel/economic-graph.ts loadEconomicGraph (commission_distributions + cost ledgers, YTD)"
  if (!graph.measured) return { cents: null, source: `${source} — unmeasured: ${graph.warnings.join("; ")}` }
  if (teamId) {
    const team = graph.byTeam.find((t) => t.key === teamId)
    return { cents: team ? team.contributionMarginCents : 0, source: `${source} — team ${teamId} roll-up` }
  }
  return { cents: graph.contributionMarginCents, source }
})
