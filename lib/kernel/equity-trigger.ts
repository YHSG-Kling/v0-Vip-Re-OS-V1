// lib/kernel/equity-trigger.ts
//
// PAST-CLIENT EQUITY TRIGGER — the Sphere's recurring-revenue engine.
//
// The Anniversary Equity play (lib/kernel/anniversary-equity.ts) fires on the yearly
// CALENDAR moment. This play fires on a MATH moment instead: it watches every past
// client's home value AND the rate environment, and when the numbers cross a real
// threshold — meaningful equity GAINED ("you could pull $X in cash") or current rates
// materially below the client's ORIGINAL locked rate ("a refi could save $Y/mo") — the
// Sphere Manager fires ONE gated agent note + a Director-commissioned equity/refi reel +
// a portal value card. The lifetime database becomes recurring transactions.
//
// REUSE (no duplicated math):
//   · computeEquityLine (anniversary-equity.ts) is the ONE valuation→equity calculator —
//     est. value vs basis, ~1.5%/yr principal-paydown approximation, honest appreciation-
//     only degrade when the original loan amount is unknown. We import it; we never
//     re-derive equity here.
//   · proposeClientMessage (the gate), pushPortalValueCard (the portal primitive),
//     commissionVideo (the Director / EquityReportReel) — same rails the siblings ride.
//
// THE TRIGGER (this module's net-new contribution) is a THRESHOLD CROSSING, not a date:
//   · CASH-OUT angle — est. equity ≥ CASH_OUT_MIN_EQUITY ($150k) AND ≥ CASH_OUT_MIN_PCT
//     (35%) of estimated value. The pullable figure is a conservative slice of equity
//     (CASH_OUT_PULL_PCT, capped so we never claim a client can pull their whole house).
//   · REFI angle — the client's ORIGINAL rate is on file AND current market rate is ≥
//     REFI_MIN_RATE_DELTA_BPS (75 bps) below it AND the modeled monthly saving on the
//     remaining balance is ≥ REFI_MIN_MONTHLY_SAVINGS ($150/mo).
//
// HONESTY (non-negotiable, mirrors the siblings):
//   · No estimatedValue → no signal at all (the runner SKIPS — never a fabricated value).
//   · No original loan amount → no equity/cash-out figure (computeEquityLine returns null);
//     the cash-out angle cannot fire without real equity.
//   · No original rate OR no AUTHORITATIVE current-rate source → refiMonthlySavings stays
//     NULL and the refi angle NEVER fires. Rate fabrication is forbidden. The equity/cash-
//     out angle still fires on its own when the equity math crosses.
//   · Every figure is an ESTIMATE; the copy says "not an appraisal", no financial advice.
//
// IDEMPOTENT: one trigger per (contact, trigger-type, quarter). The proposal's rationale
// carries `EQUITY TRIGGER [<type>] [<YYYY-Qn>]`, so a re-run inside the same quarter
// dedupes. Withdrawn contacts are never touched.
//
// NOT server-only (simulator-driven). Pure core carries the threshold math; the runner
// does I/O. Valuation fetcher, current-rate source, copy generator, and video dispatcher
// are injectable seams (the simulator injects fixed numbers — no vendor spend).

import { createServiceClient } from "@/lib/supabase/service"
import { computeEquityLine, type EquityLine } from "@/lib/kernel/anniversary-equity"
import type { CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = ReturnType<typeof createServiceClient>

// ─── Thresholds (documented, deterministic) ──────────────────────────────────────

/** CASH-OUT: estimated equity must be at least this many dollars to be worth the call. */
export const CASH_OUT_MIN_EQUITY = 150_000

/** CASH-OUT: estimated equity must also be at least this FRACTION of estimated value
 *  (a high-value home with a fresh large mortgage shouldn't trigger on dollars alone). */
export const CASH_OUT_MIN_PCT = 0.35

/** CASH-OUT: the conservative slice of equity we model as pullable (banks cap cash-out
 *  refis well under 100% LTV; this keeps the headline number honest, not aspirational). */
export const CASH_OUT_PULL_PCT = 0.5

/** REFI: current market rate must be at least this many bps BELOW the client's original
 *  rate (75 bps ≈ the rule-of-thumb floor where a refi starts to pencil out). */
export const REFI_MIN_RATE_DELTA_BPS = 75

/** REFI: the modeled monthly saving on the remaining balance must clear this floor. */
export const REFI_MIN_MONTHLY_SAVINGS = 150

/** The rationale tag prefix that carries the per-(contact, type, quarter) idempotency key. */
export const EQUITY_TRIGGER_TAG = "EQUITY TRIGGER"

/** Non-authoritative rate source sentinel (matches the Wealth Advisor's cold-start guard):
 *  a placeholder benchmark is NOT a market quote — the refi dollar-claim is suppressed for it. */
export const NON_AUTHORITATIVE_RATE_SOURCE = "seed_default"

export type EquityTriggerType = "cash_out" | "refi"

// ─── Pure core ────────────────────────────────────────────────────────────────────

export interface EquityTriggerInput {
  /** What the client paid (transactions.purchase_price) — the basis. */
  purchasePrice: number
  /** Optional explicit close price when it differs from purchase_price. */
  closePrice?: number | null
  /** REAL estimated current value (from the valuation fetcher — never fabricated). */
  estimatedValue: number
  /** ORIGINAL loan amount when known (transaction_lenders.loan_amount); null → no
   *  equity figure is possible (computeEquityLine degrades to appreciation-only). */
  originalLoanAmount?: number | null
  /** Whole years since closing (drives the paydown approximation). */
  yearsHeld: number
  /** The client's ORIGINAL note rate in PERCENT (transaction_lenders.interest_rate),
   *  e.g. 6.75. Null/absent → the refi angle cannot fire (no fabricated rate). */
  originalRate?: number | null
  /** Today's AUTHORITATIVE market rate in PERCENT, e.g. 6.0. Null/absent → the refi
   *  angle cannot fire (rate fabrication forbidden). */
  currentMarketRate?: number | null
  /** Optional explicit remaining balance; when absent we reuse computeEquityLine's
   *  ~1.5%/yr paydown estimate. */
  remainingBalance?: number | null
}

export interface EquityTriggerSignal {
  /** The reused honest equity line (appreciation, equity-or-null, basis flag). */
  line: EquityLine
  /** Conservative pullable cash when the cash-out threshold crosses; null otherwise
   *  (never a fabricated number — requires REAL equity). */
  cashOutOpportunity: number | null
  /** Modeled monthly saving when the refi threshold crosses; null otherwise (requires
   *  BOTH a real original rate AND a real current market rate). */
  refiMonthlySavings: number | null
  /** The remaining-balance figure the refi math used (real or paydown-estimated). */
  remainingBalanceUsed: number | null
  /** The rate gap in bps (original − current), null when either rate is missing. */
  rateDeltaBps: number | null
  /** Did ANY angle cross its threshold this evaluation? */
  crosses: boolean
  /** Which angles crossed (may be both). */
  triggerTypes: EquityTriggerType[]
  /** Plain-language why — the agent-readable reason (honest about what was/wasn't computable). */
  reason: string
}

/**
 * PURE: evaluate the equity/refi threshold crossing for one past client. Deterministic,
 * no I/O. Honest nulls when inputs are missing — computes ONLY what's real:
 *   · cashOutOpportunity is null unless the original loan amount yielded real equity AND
 *     that equity clears BOTH the dollar and the percent-of-value thresholds.
 *   · refiMonthlySavings is null unless BOTH the original rate AND the current market rate
 *     are present AND the gap + modeled monthly saving clear their floors. NEVER fabricated.
 */
export function equityTriggerSignal(input: EquityTriggerInput): EquityTriggerSignal {
  const line = computeEquityLine({
    purchasePrice: input.purchasePrice,
    closePrice: input.closePrice ?? null,
    estimatedValue: input.estimatedValue,
    originalLoanAmount: input.originalLoanAmount ?? null,
    yearsHeld: input.yearsHeld,
  })

  // The remaining balance for the refi math: an explicit real one wins, else reuse the
  // honest paydown estimate computeEquityLine already produced (null only when no loan).
  const remainingBalanceUsed =
    input.remainingBalance != null && input.remainingBalance > 0
      ? input.remainingBalance
      : line.estimatedRemainingBalance

  // ── CASH-OUT angle ── requires REAL equity (loan data on file).
  let cashOutOpportunity: number | null = null
  const equity = line.estimatedEquity
  if (equity != null && equity >= CASH_OUT_MIN_EQUITY) {
    const equityPct = input.estimatedValue > 0 ? equity / input.estimatedValue : 0
    if (equityPct >= CASH_OUT_MIN_PCT) {
      cashOutOpportunity = Math.round(equity * CASH_OUT_PULL_PCT)
    }
  }

  // ── REFI angle ── requires BOTH a real original rate AND a real current market rate.
  let refiMonthlySavings: number | null = null
  let rateDeltaBps: number | null = null
  const orig = input.originalRate
  const curr = input.currentMarketRate
  if (
    orig != null && orig > 0 &&
    curr != null && curr > 0 &&
    remainingBalanceUsed != null && remainingBalanceUsed > 0
  ) {
    rateDeltaBps = Math.round((orig - curr) * 100) // percent → bps
    if (rateDeltaBps >= REFI_MIN_RATE_DELTA_BPS) {
      // Interest-only first-order saving on the remaining balance:
      //   monthly ≈ balance × (rateDelta_fraction) / 12.  A conservative, transparent
      //   proxy (same shape as the Wealth Advisor's refi estimate) — labeled an estimate.
      const monthly = (remainingBalanceUsed * ((orig - curr) / 100)) / 12
      if (monthly >= REFI_MIN_MONTHLY_SAVINGS) {
        refiMonthlySavings = Math.round(monthly)
      }
    }
  }

  const triggerTypes: EquityTriggerType[] = []
  if (cashOutOpportunity != null) triggerTypes.push("cash_out")
  if (refiMonthlySavings != null) triggerTypes.push("refi")
  const crosses = triggerTypes.length > 0

  const reason = buildReason({
    line, cashOutOpportunity, refiMonthlySavings, rateDeltaBps,
    hasOriginalRate: orig != null && orig > 0,
    hasCurrentRate: curr != null && curr > 0,
  })

  return {
    line, cashOutOpportunity, refiMonthlySavings, remainingBalanceUsed,
    rateDeltaBps, crosses, triggerTypes, reason,
  }
}

function buildReason(a: {
  line: EquityLine
  cashOutOpportunity: number | null
  refiMonthlySavings: number | null
  rateDeltaBps: number | null
  hasOriginalRate: boolean
  hasCurrentRate: boolean
}): string {
  const parts: string[] = []
  if (a.cashOutOpportunity != null) {
    parts.push(`cash-out crosses — est. equity ${fmtUsd(a.line.estimatedEquity ?? 0)} ≥ ${fmtUsd(CASH_OUT_MIN_EQUITY)} and ≥ ${Math.round(CASH_OUT_MIN_PCT * 100)}% of value → ~${fmtUsd(a.cashOutOpportunity)} conservatively pullable`)
  } else if (a.line.estimatedEquity == null) {
    parts.push(`cash-out not computed — no original loan amount on file (appreciation-only, no equity figure)`)
  } else {
    parts.push(`cash-out below threshold — est. equity ${fmtUsd(a.line.estimatedEquity)}`)
  }
  if (a.refiMonthlySavings != null) {
    parts.push(`refi crosses — ${a.rateDeltaBps} bps below the original rate → ~${fmtUsd(a.refiMonthlySavings)}/mo modeled saving`)
  } else if (!a.hasOriginalRate) {
    parts.push(`refi not computed — no original rate on file (no fabricated rate)`)
  } else if (!a.hasCurrentRate) {
    parts.push(`refi not computed — no authoritative current-rate source (no fabricated rate)`)
  } else if (a.rateDeltaBps != null && a.rateDeltaBps < REFI_MIN_RATE_DELTA_BPS) {
    parts.push(`refi below threshold — only ${a.rateDeltaBps} bps below the original rate`)
  } else {
    parts.push(`refi below threshold`)
  }
  return parts.join("; ")
}

function fmtUsd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
}

/** Pure: the idempotency quarter key for a date — "YYYY-Qn". */
export function quarterKey(now: Date): string {
  const q = Math.floor(now.getUTCMonth() / 3) + 1
  return `${now.getUTCFullYear()}-Q${q}`
}

// ─── Pure copy ──────────────────────────────────────────────────────────────────

export interface TriggerNoteArgs {
  firstName: string | null
  address: string | null
  signal: EquityTriggerSignal
  estimatedValue: number
}

/**
 * PURE: the deterministic FALLBACK note (the persona generator may override). Warm,
 * Fair-Housing-safe, no financial-advice claims; leads with whichever angle crossed.
 * Every number is labeled an ESTIMATE and the note says "not an appraisal".
 */
export function composeTriggerNote(args: TriggerNoteArgs): { subject: string; body: string } {
  const first = args.firstName?.trim() ? ` ${args.firstName.trim()}` : ""
  const home = args.address?.trim() ? args.address.trim() : "your home"
  const s = args.signal
  const leadCash = s.cashOutOpportunity != null
  const leadRefi = s.refiMonthlySavings != null

  const lines: string[] = []
  lines.push(
    `Based on an automated estimate, ${home} is now worth about ${fmtUsd(args.estimatedValue)}` +
    (s.line.estimatedEquity != null ? `, with roughly ${fmtUsd(s.line.estimatedEquity)} in estimated equity.` : `.`),
  )
  if (leadCash) {
    lines.push(`That's enough that you could likely access around ${fmtUsd(s.cashOutOpportunity!)} in cash — for a renovation, an investment, or to consolidate higher-interest debt — without selling.`)
  }
  if (leadRefi) {
    lines.push(`Rates have also moved: refinancing could save you on the order of ${fmtUsd(s.refiMonthlySavings!)} a month compared with your current loan.`)
  }
  const subjectAngle = leadCash && leadRefi ? "your equity and a possible refinance"
    : leadCash ? `the ~${fmtUsd(s.cashOutOpportunity!)} in equity you could tap`
    : `a refinance that could save ~${fmtUsd(s.refiMonthlySavings!)}/mo`

  const body =
    `Hi${first} — a quick heads-up about ${home}. ` +
    `${lines.join(" ")} ` +
    `These are estimates, not an appraisal, and not financial advice — if you'd like a precise picture or want to run the numbers, I'm glad to walk through it with you.`

  return { subject: `${home} — ${subjectAngle}`, body }
}

/** PURE: the agent brief that rides the proposal's rationale — who, which angle(s), the
 *  honest numbers, and what approving delivers. */
export function composeTriggerBrief(args: {
  fullName: string
  address: string | null
  signal: EquityTriggerSignal
  estimatedValue: number
  valuationSource: string
  rateSource: string | null
}): string {
  const who = args.fullName.trim() || "a past client"
  const home = args.address?.trim() ? ` (${args.address.trim()})` : ""
  const s = args.signal
  const angles: string[] = []
  if (s.cashOutOpportunity != null) angles.push(`CASH-OUT ~${fmtUsd(s.cashOutOpportunity)} pullable (est. equity ${fmtUsd(s.line.estimatedEquity ?? 0)})`)
  if (s.refiMonthlySavings != null) angles.push(`REFI ~${fmtUsd(s.refiMonthlySavings)}/mo (${s.rateDeltaBps} bps below original${args.rateSource ? `, source ${args.rateSource}` : ""})`)
  return (
    `Equity-trigger crossing for ${who}${home}. Est. value ${fmtUsd(args.estimatedValue)} (source: ${args.valuationSource}). ` +
    `${angles.join(" · ")}. ${s.reason}. All figures are estimates, not an appraisal. ` +
    `Approve to deliver the heads-up to their portal — a lifetime relationship turns into a live transaction conversation.`
  )
}

// ─── Injectable seams ─────────────────────────────────────────────────────────────

/** REAL valuation seam (same contract as anniversary-equity's). Default RentCast-backed;
 *  null → the runner SKIPS the contact (never invents a value). Simulator injects fixed numbers. */
export type ValuationFetcher = (args: { brokerageId: string; address: string }) => Promise<{
  value: number
  source: string
} | null>

/** AUTHORITATIVE current-rate seam. Default reads market_rate_snapshots (today, else latest);
 *  a non-authoritative row (source 'seed_default') returns null so the refi angle stays off.
 *  Returns the 30yr fixed rate in PERCENT + the source. Null → equity-only (no fabricated rate). */
export type CurrentRateFetcher = (args: { brokerageId: string }) => Promise<{
  ratePct: number
  source: string
} | null>

/** Director-commissioned reel seam (mirrors voice-delegation's CommissionDispatcher).
 *  Default rides commissionVideo → EquityReportReel (D-ID + ElevenLabs, NEVER HeyGen).
 *  Simulator injects a recorder (no render spend). */
export type ReelDispatcher = (args: {
  brokerageId: string
  agentUserId: string
  contactId: string
  estimatedValue: number
  line: EquityLine
}) => Promise<{ ok: boolean; status: string }>

// ─── Live runner ──────────────────────────────────────────────────────────────────

export interface EquityTriggerResult {
  /** Past clients (closed transactions) examined. */
  scanned: number
  /** Contacts where a REAL valuation resolved and a signal was evaluated. */
  evaluated: number
  /** Threshold crossings detected (cash-out and/or refi). */
  triggersDetected: number
  /** Gated agent notes proposed (one per contact per quarter). */
  notesProposed: number
  /** Director equity/refi reels commissioned. */
  reelsCommissioned: number
  /** Portal value cards pushed (updateType "equity_trigger"). */
  portalCardsPushed: number
  /** Honest skips — no REAL valuation (no key / no result / no address). */
  skippedNoValuation: number
  /** Skips — no purchase price on file (no basis, no fabrication). */
  skippedNoPurchasePrice: number
  /** Evaluated but below every threshold — nothing fired. */
  skippedBelowThreshold: number
  /** Withdrawn contacts are never touched. */
  skippedWithdrawn: number
  /** Same (contact, type, quarter) already triggered — idempotent re-run. */
  skippedDuplicate: number
  /** Reel skipped because the transaction had no agent (no agentUserId to attribute). */
  skippedNoAgent: number
}

interface TxRow {
  id: string
  deal_name: string | null
  property_address: string | null
  purchase_price: number | string | null
  close_date: string | null
  buyer_contact_id: string | null
  contact_id: string | null
  listing_id: string | null
  agent_id: string | null
}

/**
 * One Equity-Trigger pass for a brokerage. For each CLOSED transaction with a resolvable
 * REAL valuation, evaluate the equity/refi threshold crossing (pure equityTriggerSignal);
 * when it crosses, propose ONE gated agent note, commission a Director equity/refi reel,
 * and push the portal value card. Idempotent per (contact, trigger-type, quarter).
 * Withdrawn excluded. Rate fabrication forbidden — no authoritative rate → equity-only.
 */
export async function runEquityTrigger(
  brokerageId: string,
  opts: {
    now?: Date
    valuationFetcher?: ValuationFetcher
    currentRateFetcher?: CurrentRateFetcher
    copyGenerator?: CopyGenerator
    reelDispatcher?: ReelDispatcher
    /** Scope the pass to ONE contact's closed transactions (voice "check the Garcias'
     *  equity"). Same logic, same gate, same idempotency. */
    contactId?: string
  } = {},
  client?: Svc,
): Promise<EquityTriggerResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const result: EquityTriggerResult = {
    scanned: 0, evaluated: 0, triggersDetected: 0, notesProposed: 0, reelsCommissioned: 0,
    portalCardsPushed: 0, skippedNoValuation: 0, skippedNoPurchasePrice: 0,
    skippedBelowThreshold: 0, skippedWithdrawn: 0, skippedDuplicate: 0, skippedNoAgent: 0,
  }

  // REAL RentCast-backed default valuation (same as anniversary-equity). Null → honest skip.
  const fetchValuation: ValuationFetcher = opts.valuationFetcher ?? (async ({ brokerageId: bid, address }) => {
    const { getRentcastAVM } = await import("@/lib/property/rentcast")
    const avm = await getRentcastAVM({ brokerageId: bid, address })
    if (!avm.value || avm.value <= 0) return null
    return { value: avm.value, source: "rentcast" }
  })

  // AUTHORITATIVE current-rate default — market_rate_snapshots (today, else latest). A
  // non-authoritative row (source 'seed_default') is treated as NO rate (refi stays off).
  const fetchRate: CurrentRateFetcher = opts.currentRateFetcher ?? (async () => {
    const today = now.toISOString().slice(0, 10)
    const { data: todayRow } = await supabase
      .from("market_rate_snapshots")
      .select("rate_30yr_fixed_bps, source, rate_date")
      .eq("rate_date", today)
      .maybeSingle()
    const row = (todayRow as { rate_30yr_fixed_bps?: number | null; source?: string | null } | null) ?? null
    let chosen = row
    if (!chosen) {
      const { data: latest } = await supabase
        .from("market_rate_snapshots")
        .select("rate_30yr_fixed_bps, source, rate_date")
        .order("rate_date", { ascending: false })
        .limit(1)
        .maybeSingle()
      chosen = (latest as { rate_30yr_fixed_bps?: number | null; source?: string | null } | null) ?? null
    }
    if (!chosen || chosen.rate_30yr_fixed_bps == null) return null
    if ((chosen.source ?? "") === NON_AUTHORITATIVE_RATE_SOURCE) return null // not a real quote → refi off
    return { ratePct: chosen.rate_30yr_fixed_bps / 100, source: chosen.source ?? "market_rate_snapshots" }
  })

  // Director equity/refi reel default — commissionVideo (anniversary kind → EquityReportReel).
  const dispatchReel: ReelDispatcher = opts.reelDispatcher ?? (async (d) => {
    const { commissionVideo } = await import("@/lib/video/video-director")
    const r = await commissionVideo(
      {
        kind: "anniversary",
        tier: "solo_agent",
        targetChannel: "portal",
        facts: {
          contactId: d.contactId,
          estimatedValue: d.estimatedValue,
          purchasePrice: d.line.basisPrice,
          appreciation: d.line.appreciation,
          appreciationPct: d.line.appreciationPct,
          estimatedEquity: d.line.estimatedEquity,
          source: "equity_trigger",
        },
      },
      { brokerageId: d.brokerageId, agentUserId: d.agentUserId, contactId: d.contactId },
    )
    return { ok: r.ok, status: r.status }
  })

  // Past clients = CLOSED transactions (the closed deal IS the proof of the relationship).
  let query = supabase
    .from("transactions")
    .select("id, deal_name, property_address, purchase_price, close_date, buyer_contact_id, contact_id, listing_id, agent_id")
    .eq("brokerage_id", brokerageId)
    .eq("status", "closed")
    .not("close_date", "is", null)
    .limit(500)
  if (opts.contactId) {
    query = query.or(`buyer_contact_id.eq.${opts.contactId},contact_id.eq.${opts.contactId}`)
  }
  const { data: rows } = await query
  const txns = (rows ?? []) as TxRow[]

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const { generatePersonaCopy } = await import("@/lib/kernel/ai-copy")
  const { pushPortalValueCard } = await import("@/lib/kernel/portal-value")

  const qKey = quarterKey(now)
  const handledThisPass = new Set<string>() // (contact:quarter)

  // Resolve the brokerage's current authoritative rate ONCE per pass (it's a feed, not
  // per-client). Null → the refi angle is universally off this pass (no fabricated rate).
  let currentRate: { ratePct: number; source: string } | null = null
  try { currentRate = await fetchRate({ brokerageId }) } catch { currentRate = null }

  for (const t of txns) {
    result.scanned += 1
    const contactId = t.buyer_contact_id ?? t.contact_id
    if (!contactId) continue

    const passKey = `${contactId}:${qKey}`
    if (handledThisPass.has(passKey)) { result.skippedDuplicate += 1; continue }

    // Contact — withdrawn never touched.
    const { data: c } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, nurture_status")
      .eq("id", contactId)
      .maybeSingle()
    if (!c) continue
    if (((c as { nurture_status?: string | null }).nurture_status ?? "").toLowerCase() === "withdrawn") {
      result.skippedWithdrawn += 1
      continue
    }

    // Purchase basis — no purchase price means no honest comparison; skip.
    const purchasePrice = t.purchase_price != null ? Number(t.purchase_price) : null
    if (!purchasePrice || purchasePrice <= 0) { result.skippedNoPurchasePrice += 1; continue }

    // Address — the transaction's, else the linked listing's. No address → no valuation.
    let address = t.property_address?.trim() || null
    if (!address && t.listing_id) {
      const { data: lst } = await supabase.from("listings").select("address").eq("id", t.listing_id).maybeSingle()
      address = (lst as { address?: string | null } | null)?.address?.trim() || null
    }
    if (!address) { result.skippedNoValuation += 1; continue }

    // REAL valuation — or an honest skip. NEVER fabricated.
    let valuation: Awaited<ReturnType<ValuationFetcher>> = null
    try { valuation = await fetchValuation({ brokerageId, address }) } catch { valuation = null }
    if (!valuation || !valuation.value || valuation.value <= 0) { result.skippedNoValuation += 1; continue }

    // Original loan amount + ORIGINAL RATE when on file (transaction_lenders).
    const { data: lender } = await supabase
      .from("transaction_lenders")
      .select("loan_amount, interest_rate")
      .eq("transaction_id", t.id)
      .maybeSingle()
    const lenderRow = lender as { loan_amount?: number | string | null; interest_rate?: number | string | null } | null
    const originalLoanAmount = lenderRow?.loan_amount != null ? Number(lenderRow.loan_amount) : null
    const originalRate = lenderRow?.interest_rate != null ? Number(lenderRow.interest_rate) : null

    // Years held (whole years since closing) — drives the paydown approximation.
    const closeMs = new Date(t.close_date as string).getTime()
    const yearsHeld = Number.isNaN(closeMs)
      ? 0
      : Math.max(0, Math.floor((now.getTime() - closeMs) / (365.25 * 86_400_000)))

    // ── PURE signal ── rate fabrication forbidden: currentRate is null unless the feed
    // is authoritative, so the refi angle simply can't fire without a real quote.
    const signal = equityTriggerSignal({
      purchasePrice,
      estimatedValue: valuation.value,
      originalLoanAmount,
      yearsHeld,
      originalRate,
      currentMarketRate: currentRate?.ratePct ?? null,
    })
    result.evaluated += 1

    if (!signal.crosses) { result.skippedBelowThreshold += 1; continue }
    result.triggersDetected += 1

    // IDEMPOTENCY — one trigger per (contact, type, quarter). The proposal's rationale
    // carries the type+quarter tag. We dedupe at the contact+quarter level (a contact who
    // already got their equity heads-up this quarter is not re-touched), keyed per type so
    // a cash-out and a later refi in different quarters each get their own moment.
    const typeKey = signal.triggerTypes.join("+")
    const tag = `${EQUITY_TRIGGER_TAG} [${typeKey}] [${qKey}]`
    const { data: dup } = await supabase
      .from("agent_client_messages")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("recipient_contact_id", contactId)
      .ilike("rationale", `${EQUITY_TRIGGER_TAG} %[${qKey}]%`)
      .limit(1)
      .maybeSingle()
    if (dup) { result.skippedDuplicate += 1; handledThisPass.add(passKey); continue }

    const firstName = (c as { first_name?: string | null }).first_name ?? null
    const fullName = [
      (c as { first_name?: string | null }).first_name,
      (c as { last_name?: string | null }).last_name,
    ].filter(Boolean).join(" ").trim()

    // Persona-aware note (deterministic fallback). Facts are the REAL computed numbers only.
    const fallback = composeTriggerNote({ firstName, address, signal, estimatedValue: valuation.value })
    const facts: string[] = [
      `Estimated current value: ${fmtUsd(valuation.value)} (an estimate, not an appraisal)`,
    ]
    if (signal.line.estimatedEquity != null) facts.push(`Estimated equity: ${fmtUsd(signal.line.estimatedEquity)}`)
    if (signal.cashOutOpportunity != null) facts.push(`Could likely access about ${fmtUsd(signal.cashOutOpportunity)} in cash without selling`)
    if (signal.refiMonthlySavings != null) facts.push(`A refinance could save on the order of ${fmtUsd(signal.refiMonthlySavings)} a month`)
    facts.push(`These figures are estimates, not an appraisal, and not financial advice`)

    const draft = await generatePersonaCopy(
      {
        goal: "a warm heads-up to a PAST client that their home equity (or the rate environment) has crossed a threshold worth a conversation — cash-out or refinance — estimates clearly labeled; explicitly 'not an appraisal'; no financial advice; no pressure",
        facts,
        channel: "portal",
        persona: { name: fullName || null, audience: "past_client", situation: "equity/refi opportunity crossed a threshold" },
        words: 110,
      },
      fallback,
      { generator: opts.copyGenerator },
    )

    // (1) ONE GATED agent-facing proposal — BODY is the ready-to-send note; RATIONALE
    // carries the type+quarter tag + the agent brief. Never auto-sends.
    const brief = composeTriggerBrief({
      fullName, address, signal, estimatedValue: valuation.value,
      valuationSource: valuation.source, rateSource: currentRate?.source ?? null,
    })
    const proposed = await proposeClientMessage({
      brokerageId,
      agentKind: "sphere_of_influence",
      entityType: "contact",
      entityId: contactId,
      recipientContactId: contactId,
      audience: "agent",
      subject: draft.subject ?? fallback.subject,
      body: draft.body,
      rationale: `${tag} — Sphere Manager: ${brief}`,
      channel: "portal",
    }, supabase)
    if (!proposed.ok) continue
    result.notesProposed += 1
    handledThisPass.add(passKey)

    // (2) PORTAL VALUE CARD — the same REAL equity/refi story on the portal. CLIENT-FRAMING
    // DOCTRINE: end with a warm, conversation-starting line that routes to the agent (a cash-out/
    // refi is a decision to TALK THROUGH, never a stark number that pressures the homeowner).
    const { valueNewsTone, clientSafeCtaLine } = await import("@/lib/kernel/client-framing")
    const trigTone = valueNewsTone({ value: signal.line.estimatedEquity ?? signal.line.appreciation ?? null })
    const trigSummary = `${draft.body}\n\n${clientSafeCtaLine(trigTone, "your equity options")}`
    const card = await pushPortalValueCard({
      brokerageId,
      contactId,
      listingId: t.listing_id ?? null,
      title: draft.subject ?? fallback.subject,
      summary: trigSummary,
      updateType: "equity_trigger",
      metadata: {
        source: "equity_trigger",
        trigger_types: signal.triggerTypes,
        quarter: qKey,
        transaction_id: t.id,
        purchase_price: signal.line.basisPrice,
        estimated_value: valuation.value,
        valuation_source: valuation.source,
        estimated_equity: signal.line.estimatedEquity,
        cash_out_opportunity: signal.cashOutOpportunity,
        refi_monthly_savings: signal.refiMonthlySavings,
        rate_delta_bps: signal.rateDeltaBps,
        rate_source: currentRate?.source ?? null,
        equity_basis: signal.line.equityBasis,
        not_an_appraisal: true,
        agent_summary_id: proposed.id ?? null,
      },
      now,
    }, supabase)
    if (card.pushed) result.portalCardsPushed += 1

    // (3) Director-commissioned equity/refi reel — EquityReportReel via commissionVideo
    // (D-ID + ElevenLabs, NEVER HeyGen). Requires an agent on the transaction to attribute
    // the render to (agents.user_id). A render failure NEVER fails the note.
    if (t.agent_id) {
      const { data: ag } = await supabase
        .from("agents")
        .select("user_id")
        .eq("id", t.agent_id)
        .maybeSingle()
      const agentUserId = (ag as { user_id?: string | null } | null)?.user_id ?? null
      if (agentUserId) {
        try {
          const v = await dispatchReel({
            brokerageId, agentUserId, contactId,
            estimatedValue: valuation.value, line: signal.line,
          })
          if (v.ok && (v.status === "staged" || v.status === "already_staged")) result.reelsCommissioned += 1
        } catch { /* the reel is a bonus — never fail the note */ }
      } else {
        result.skippedNoAgent += 1
      }
    } else {
      result.skippedNoAgent += 1
    }
  }

  return result
}
