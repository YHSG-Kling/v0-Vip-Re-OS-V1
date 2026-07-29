// lib/kernel/financing-pit-stop.ts
//
// FINANCING PIT STOP — the Deal Coordinator's RATE/LENDER layer on the financing window.
//
// The Title & Closing Watchtower (lib/kernel/title-closing-watchtower.ts) watches the
// DATE chain — including the financing milestone — and alerts when a date MOVES. This play
// is COMPLEMENTARY: it works the RATE / LENDER side. The moment a deal enters the FINANCING
// WINDOW (the financing milestone approaching, OR the buyer's pre-approval going stale) it
// fires a parallel rate-refresh "race" across the brokerage's PREFERRED LENDER BENCH,
// ranks the returned/known quotes by lowest EFFECTIVE COST, and surfaces it as:
//   (a) ONE gated Deal Coordinator agent summary (agent_client_messages, audience 'agent',
//       proposed — never auto-sent), and
//   (b) a read-only buyer-portal VALUE card ("your financing is being refreshed — here's
//       where it stands") via pushPortalValueCard (transparency_updates).
// Financing becomes a managed pit stop, not a black box. NOTHING auto-sends to a lender:
// the "race" is a set of GATED rate-request DRAFTS the agent approves — exactly the bench +
// ranking + gated-draft pattern lib/kernel/vendor-orchestration.ts already uses for the
// Lender category, reused here as the financing-specific orchestration on top.
//
// REAL SIGNALS (verified against the live schema — NO new tables, nothing fabricated):
//   · transactions.financing_deadline (date) — the financing-milestone-approaching trigger.
//   · buyer_financial_profiles.pre_approval_expires_at (date) — the stale-pre-approval
//     trigger (skipped for cash buyers: is_cash_buyer). pre_approval_lender / pre_approval_amount
//     give the known incumbent quote context.
//   · transaction_lenders — the deal's existing lender quote(s). REAL columns: lender_name,
//     loan_amount, interest_rate (NOT "rate"), loan_term_years, pre_approval_amount,
//     underwriting_status (NOT "status"), clear_to_close_date. There are NO points/fees
//     columns, so the live effective-cost comparison ranks on interest_rate; the PURE core
//     accepts optional points/fees so the comparison is fully documented + testable.
//   · vendors (category 'Lender') — the PREFERRED LENDER BENCH (same table + ranking the
//     vendor-orchestration Lender path uses; rankVendors is preferred-first then rating).
//
// HONESTY: a deal with NEITHER a financing_deadline NOR a buyer pre-approval expiry date has
// no computable financing window — it is SKIPPED (counted in skippedNoSignal), never given a
// fabricated trigger. FAIR-HOUSING: all copy describes RATES + PROCESS only, labels rates as
// ESTIMATES (not commitments / not offers), and carries no lending-discrimination or steering
// language — the deterministic fallbacks below are written that way and the AI generator's
// system prompt enforces the same.
//
// NOT server-only (simulator-driven). Pure helpers carry the math; the runner does the I/O.

import type { createServiceClient } from "@/lib/supabase/service"
import { VENDOR_CATEGORY_LENDER } from "@/lib/kernel/vendor-categories"
import type { CopyGenerator } from "@/lib/kernel/ai-copy"
import { rankVendors, type BenchVendor } from "@/lib/kernel/vendor-orchestration"

type Svc = ReturnType<typeof createServiceClient>

// ─── Financing window detection ──────────────────────────────────────────────

/** The dates that put a deal in the financing window (any present → computable). */
export interface FinancingDates {
  /** transactions.financing_deadline — the financing milestone date. */
  financingDeadline: string | null
  /** buyer_financial_profiles.pre_approval_expires_at — when the pre-approval goes stale. */
  preApprovalExpiresAt: string | null
  /** Cash buyers have no financing to refresh — skip the pre-approval signal for them. */
  isCashBuyer?: boolean | null
}

/** Which trigger(s) put the deal in the window + the binding (soonest-pressure) one. */
export type FinancingTrigger = "financing_deadline" | "preapproval_stale"

export interface FinancingWindow {
  inWindow: boolean
  /** Every trigger that fired (a deal can hit both). */
  triggers: FinancingTrigger[]
  /** The trigger driving the most urgency (soonest date / already-stale first). */
  primaryTrigger: FinancingTrigger | null
  /** Days until the financing deadline (negative = passed); null when no deadline. */
  daysToFinancingDeadline: number | null
  /** Days until the pre-approval expires (negative = already stale); null when none. */
  daysToPreApprovalExpiry: number | null
}

/** Default windows (days): financing milestone within this many days → enter the window;
 *  pre-approval within this many days of expiry (or already expired) → enter the window.
 *  Documented planning constants — a rate refresh is worth firing this far out. */
export const FINANCING_DEADLINE_WINDOW_DAYS = 21
export const PREAPPROVAL_STALE_WINDOW_DAYS = 14

function utcDay(iso: string): number {
  return Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86_400_000)
}

/** Whole calendar days from `now` to `iso` (positive = iso is in the future). */
export function daysUntil(iso: string, now: Date): number {
  const today = Math.floor(Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) / 86_400_000)
  return utcDay(iso) - today
}

/**
 * Pure: is this deal in the FINANCING WINDOW, and which trigger(s) put it there?
 *
 * Triggers (documented):
 *   · financing_deadline — the financing milestone is within FINANCING_DEADLINE_WINDOW_DAYS
 *     and has NOT passed (a passed financing deadline is the Watchtower's at-risk territory,
 *     not a rate-refresh opportunity).
 *   · preapproval_stale — a NON-cash buyer's pre-approval expires within
 *     PREAPPROVAL_STALE_WINDOW_DAYS OR has already expired (stale = refresh now).
 *
 * primaryTrigger is the one under the most time pressure: an already-stale pre-approval wins;
 * otherwise the soonest of the two dates. Returns inWindow=false (no triggers) when neither
 * date qualifies — and the caller SKIPS deals with no dates at all (honest, never fabricated).
 */
export function financingWindow(
  dates: FinancingDates,
  now: Date,
  opts: { financingWindowDays?: number; preApprovalWindowDays?: number } = {},
): FinancingWindow {
  const finWin = opts.financingWindowDays ?? FINANCING_DEADLINE_WINDOW_DAYS
  const preWin = opts.preApprovalWindowDays ?? PREAPPROVAL_STALE_WINDOW_DAYS

  const dFin = dates.financingDeadline ? daysUntil(dates.financingDeadline, now) : null
  const dPre =
    dates.preApprovalExpiresAt && !dates.isCashBuyer ? daysUntil(dates.preApprovalExpiresAt, now) : null

  const triggers: FinancingTrigger[] = []
  // Financing milestone approaching (not yet passed).
  if (dFin !== null && dFin >= 0 && dFin <= finWin) triggers.push("financing_deadline")
  // Pre-approval stale (within window OR already expired).
  if (dPre !== null && dPre <= preWin) triggers.push("preapproval_stale")

  // primaryTrigger: the most time-pressured. An already-stale pre-approval (dPre < 0) is the
  // most urgent; otherwise pick whichever date is sooner.
  let primaryTrigger: FinancingTrigger | null = null
  if (triggers.length === 1) {
    primaryTrigger = triggers[0]
  } else if (triggers.length === 2) {
    if (dPre !== null && dPre < 0) primaryTrigger = "preapproval_stale"
    else primaryTrigger = (dPre as number) <= (dFin as number) ? "preapproval_stale" : "financing_deadline"
  }

  return {
    inWindow: triggers.length > 0,
    triggers,
    primaryTrigger,
    daysToFinancingDeadline: dFin,
    daysToPreApprovalExpiry: dPre,
  }
}

// ─── Lender quote ranking (effective cost) ───────────────────────────────────

/**
 * A single lender quote for ranking. `rate` is the annual interest rate (percent, e.g. 6.5).
 * `points` and `fees` are OPTIONAL — the live transaction_lenders row carries neither column,
 * so the live path passes rate only (points/fees default to 0); the PURE core supports them so
 * the effective-cost comparison is fully documented + testable.
 */
export interface LenderQuote {
  /** Stable id for the quote (transaction_lenders.id, or a bench-vendor id for a known bench quote). */
  id: string
  lenderName: string | null
  /** Annual interest rate in PERCENT (e.g. 6.5 means 6.5%). null = no rate on file (ranked last). */
  rate: number | null
  /** Discount points (percent of loan, e.g. 1 = 1 point). Optional — defaults to 0. */
  points?: number | null
  /** Flat lender fees in dollars. Optional — defaults to 0. */
  fees?: number | null
  /** Loan amount (transaction_lenders.loan_amount) — used to amortize fees into an effective rate. */
  loanAmount?: number | null
  /** Where the quote came from — a known on-file quote vs a bench lender we're racing. */
  source: "on_file" | "bench"
}

export interface RankedLenderQuote extends LenderQuote {
  /**
   * EFFECTIVE COST as an effective annual rate (percent). DOCUMENTED comparison:
   *   effectiveRate = rate + points + (fees / loanAmount × 100 amortized over the loan term).
   * Because lender fees are a one-time cost, we amortize them across the loan term (years)
   * to express them on the SAME per-year basis as the rate, then add discount points (which
   * are already a one-time percentage of the loan). When loanAmount/term are unknown, fees
   * fall back to a raw percent-of-loan add (no amortization) so a quote is never unranked for
   * missing context. A quote with NO rate sorts LAST (effectiveRate = +Infinity).
   */
  effectiveRate: number
}

/** Default loan term (years) used to amortize one-time fees into an effective annual rate. */
export const DEFAULT_AMORTIZE_YEARS = 30

/**
 * Pure: effective annual cost (percent) for ONE quote. See RankedLenderQuote.effectiveRate
 * for the documented formula. Lower is better.
 */
export function effectiveRate(quote: LenderQuote, opts: { amortizeYears?: number } = {}): number {
  if (quote.rate == null) return Number.POSITIVE_INFINITY
  const years = opts.amortizeYears ?? DEFAULT_AMORTIZE_YEARS
  const points = quote.points ?? 0
  const fees = quote.fees ?? 0
  const loanAmount = quote.loanAmount ?? 0
  // Fees → percent of loan; amortized over the term when we know the loan amount.
  let feePct = 0
  if (fees > 0) {
    if (loanAmount > 0) {
      const feePctOfLoan = (fees / loanAmount) * 100
      feePct = years > 0 ? feePctOfLoan / years : feePctOfLoan
    } else {
      // No loan amount — can't amortize honestly; treat the raw fee as a tiny rate nudge is
      // not meaningful, so leave feePct 0 (rate + points still rank it). Documented: fees only
      // influence ranking when the loan amount is known.
      feePct = 0
    }
  }
  return quote.rate + points + feePct
}

/**
 * Pure: rank lender quotes by lowest EFFECTIVE COST (effectiveRate ascending). Returns a NEW
 * sorted array (input not mutated) of RankedLenderQuote (each carries its effectiveRate).
 * Ties break by: lower raw rate, then on-file before bench (known quote preferred over a
 * to-be-raced one at equal cost), then lender name for determinism. Quotes with no rate sort
 * last.
 */
export function rankLenderQuotes(
  quotes: LenderQuote[],
  opts: { amortizeYears?: number } = {},
): RankedLenderQuote[] {
  return quotes
    .map((q) => ({ ...q, effectiveRate: effectiveRate(q, opts) }))
    .sort((a, b) => {
      if (a.effectiveRate !== b.effectiveRate) return a.effectiveRate - b.effectiveRate
      const ra = a.rate ?? Number.POSITIVE_INFINITY
      const rb = b.rate ?? Number.POSITIVE_INFINITY
      if (ra !== rb) return ra - rb
      if (a.source !== b.source) return a.source === "on_file" ? -1 : 1
      return (a.lenderName ?? "").localeCompare(b.lenderName ?? "")
    })
}

// ─── Deterministic fallback copy (Fair-Housing safe) ─────────────────────────

function fmtRate(n: number): string {
  return `${n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%`
}

function triggerPhrase(w: FinancingWindow): string {
  if (w.primaryTrigger === "preapproval_stale") {
    if ((w.daysToPreApprovalExpiry ?? 0) < 0) return "the buyer's pre-approval has gone stale"
    return `the buyer's pre-approval expires in ${w.daysToPreApprovalExpiry} day${w.daysToPreApprovalExpiry === 1 ? "" : "s"}`
  }
  if (w.primaryTrigger === "financing_deadline") {
    return `the financing milestone is ${w.daysToFinancingDeadline} day${w.daysToFinancingDeadline === 1 ? "" : "s"} out`
  }
  return "this deal entered the financing window"
}

export interface FinancingSummaryArgs {
  dealName: string
  window: FinancingWindow
  ranked: RankedLenderQuote[]
  /** Count of preferred bench lenders the rate-refresh race is being sent to (gated drafts). */
  benchRaceCount: number
}

/**
 * Pure deterministic FALLBACK copy. Earned lines only — every fact comes from the real window
 * + the ranked quotes + the bench race count. RATES ARE LABELED ESTIMATES (not offers / not
 * commitments). Fair-Housing safe: process + rates only, no borrower characteristics, no
 * steering. The AI generator personalizes this; the fallback guarantees real, safe copy.
 */
export function composeFinancingSummary(
  args: FinancingSummaryArgs,
): { agentSubject: string; agentSummary: string; buyerCardBody: string } {
  const { dealName, window: w, ranked, benchRaceCount } = args
  const best = ranked.find((q) => q.rate != null) ?? null
  const trigger = triggerPhrase(w)

  const agentSubject = `Financing Pit Stop — ${dealName}: ${trigger}; rate refresh fired across ${benchRaceCount} preferred lender${benchRaceCount === 1 ? "" : "s"}`

  const quoteLines = ranked.length > 0
    ? ranked.map((q, i) => {
        const rank = i === 0 ? " ← lowest effective cost" : ""
        const where = q.source === "on_file" ? "on file" : "bench"
        const rateTxt = q.rate != null
          ? `${fmtRate(q.rate)} (≈${fmtRate(q.effectiveRate)} effective)`
          : "rate not yet on file"
        return `· ${q.lenderName ?? "Lender"} [${where}]: ${rateTxt}${rank}`
      }).join("\n")
    : "· No quotes on file yet — the rate-refresh race will surface them as lenders respond."

  const agentSummary = [
    `${dealName} entered the financing window — ${trigger}.`,
    `Ranked by lowest effective cost (rate + points + amortized fees — all figures are ESTIMATES, not commitments):`,
    quoteLines,
    best
      ? `Best estimate so far: ${best.lenderName ?? "a preferred lender"} at ${fmtRate(best.rate as number)}.`
      : `No rate is on file yet — the refresh race will fill this in.`,
    `A rate-refresh race went out as ${benchRaceCount} GATED quote-request draft${benchRaceCount === 1 ? "" : "s"} to the preferred lender bench — approve each to send; nothing reaches a lender without you.`,
    `The buyer received a plain-language portal card that their financing is being refreshed. This summary is for you — nothing else goes to the buyer without your approval.`,
  ].join("\n")

  const buyerCardBody = [
    `Your financing is being refreshed — here's where it stands. ${capitalize(trigger)}, so your agent kicked off a rate check across our preferred lenders.`,
    best
      ? `The best estimate so far is around ${fmtRate(best.rate as number)} — an estimate only, not a final offer, and your agent will walk you through the numbers.`
      : `As lenders respond with current estimates, your agent will walk you through the numbers.`,
    `Nothing is needed from you right now — this page updates as your financing comes together.`,
  ].join(" ")

  return { agentSubject, agentSummary, buyerCardBody }
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s
}

/** Pure deterministic FALLBACK for ONE gated rate-request draft to a bench lender. Labels the
 *  request as a CURRENT-ESTIMATE refresh (not a commitment), Fair-Housing safe. */
export function composeRateRequestFallback(args: {
  lenderName: string
  dealName: string | null
  propertyAddress: string | null
  loanAmount: number | null
}): { subject: string; body: string } {
  const where = args.propertyAddress ? ` for ${args.propertyAddress}` : ""
  const deal = args.dealName ? ` (${args.dealName})` : ""
  const amount = args.loanAmount && args.loanAmount > 0
    ? ` on an approximate loan amount of ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(args.loanAmount)}`
    : ""
  const subject = `Current rate estimate request — ${args.lenderName}`
  const body = [
    `Hi ${args.lenderName},`,
    `We have an active transaction${deal} entering its financing window${where} and would like to refresh the current rate picture${amount}.`,
    `Could you share a CURRENT rate estimate (with any points and lender fees) at your earliest convenience? We understand this is an estimate, not a commitment — we're comparing current options for the client.`,
    `Thank you.`,
  ].join("\n\n")
  return { subject, body }
}

// ─── Idempotency signature ───────────────────────────────────────────────────

/** Stable signature of the financing window so a NEW window (different trigger/date set)
 *  re-triggers, but the same window inside the lookback does not. One race per (deal,
 *  financing-window) — keyed in the gated summary's rationale, NOT per cron tick. */
export function financingWindowSignature(w: FinancingWindow): string {
  return [
    `fin:${w.daysToFinancingDeadline ?? "x"}`,
    `pre:${w.daysToPreApprovalExpiry ?? "x"}`,
    `t:${[...w.triggers].sort().join("+") || "none"}`,
  ].join("|")
}

// ─── Live runner ─────────────────────────────────────────────────────────────

export interface FinancingPitStopResult {
  /** Active deals scanned. */
  scanned: number
  /** Deals that entered the financing window. */
  inWindow: number
  /** Gated agent summaries proposed (one per deal-window). */
  summariesProposed: number
  /** Gated rate-request drafts proposed to preferred lenders (the parallel race). */
  raceDraftsProposed: number
  /** Buyer portal value cards pushed. */
  portalCardsPushed: number
  /** Deals skipped because NEITHER a financing date NOR a pre-approval expiry is recorded. */
  skippedNoSignal: number
  /** Deals in-window but with no preferred lender bench to race (still summarized). */
  benchMisses: number
  errors: string[]
}

/** Lookback for the gated-summary idempotency check (matches the 6h cron cadence × a day). */
export const PIT_STOP_WINDOW_HOURS = 24

/** Active stages we run the pit stop for (financing is live pre-close). CLOSED/LOST excluded. */
const ACTIVE_STATUSES = ["active", "under_contract", "closing"]

/**
 * Run the Financing Pit Stop for one brokerage: for each active deal, decide if it is in the
 * financing window (REAL financing_deadline and/or buyer pre-approval expiry), and if so —
 *   1. rank the deal's known lender quote(s) by lowest effective cost,
 *   2. fire the rate-refresh RACE: one GATED rate-request draft per preferred Lender on the
 *      bench (vendors category 'Lender', preferred-first ranking), parallel,
 *   3. propose ONE gated Deal Coordinator agent summary of the window + ranked quotes,
 *   4. push a read-only buyer-portal value card.
 *
 * Idempotency: one race per (deal, financing-window) — keyed on the financing-window signature
 * stored in the summary's rationale (PIT STOP — sig:<sig>). A NEW window re-fires; the same one
 * inside the lookback is a no-op. Nothing auto-sends to a lender or the buyer's inbox.
 */
export async function runFinancingPitStop(
  brokerageId: string,
  opts: {
    now?: Date
    copyGenerator?: CopyGenerator
    windowHours?: number
    financingWindowDays?: number
    preApprovalWindowDays?: number
  } = {},
  client?: Svc,
): Promise<FinancingPitStopResult> {
  const supabase = client ?? (await import("@/lib/supabase/service")).createServiceClient()
  const now = opts.now ?? new Date()
  const windowHours = opts.windowHours ?? PIT_STOP_WINDOW_HOURS
  const sinceIso = new Date(now.getTime() - windowHours * 3_600_000).toISOString()
  const result: FinancingPitStopResult = {
    scanned: 0, inWindow: 0, summariesProposed: 0, raceDraftsProposed: 0,
    portalCardsPushed: 0, skippedNoSignal: 0, benchMisses: 0, errors: [],
  }

  // The PREFERRED LENDER BENCH — same table + ranking the vendor-orchestration Lender path
  // uses (vendors category 'Lender'). rankVendors is preferred-first then rating.
  const { data: benchRows } = await supabase.from("vendors")
    .select("id, name, category, email, rating")
    .eq("brokerage_id", brokerageId).eq("category", VENDOR_CATEGORY_LENDER).limit(200)
  const bench: BenchVendor[] = (benchRows ?? []) as BenchVendor[]
  const preferredBench = rankVendors(bench, {})

  // Active deals for this brokerage.
  const { data: txns } = await supabase.from("transactions")
    .select("id, deal_name, property_address, status, deleted_at, financing_deadline, buyer_contact_id, contact_id, listing_id, loan_amount")
    .eq("brokerage_id", brokerageId).in("status", ACTIVE_STATUSES).limit(300)

  for (const t of (txns ?? []) as any[]) {
    if (t.deleted_at) continue
    result.scanned += 1
    try {
      const buyerContactId: string | null = t.buyer_contact_id ?? t.contact_id ?? null

      // Buyer pre-approval signal (the stale-pre-approval trigger) — REAL columns.
      let preApprovalExpiresAt: string | null = null
      let isCashBuyer: boolean | null = null
      let preApprovalLender: string | null = null
      let preApprovalAmount: number | null = null
      if (buyerContactId) {
        const { data: fin } = await supabase.from("buyer_financial_profiles")
          .select("pre_approval_expires_at, is_cash_buyer, pre_approval_lender, pre_approval_amount")
          .eq("contact_id", buyerContactId).maybeSingle()
        preApprovalExpiresAt = (fin as any)?.pre_approval_expires_at ?? null
        isCashBuyer = (fin as any)?.is_cash_buyer ?? null
        preApprovalLender = (fin as any)?.pre_approval_lender ?? null
        preApprovalAmount = (fin as any)?.pre_approval_amount != null ? Number((fin as any).pre_approval_amount) : null
      }

      const dates: FinancingDates = {
        financingDeadline: t.financing_deadline ?? null,
        preApprovalExpiresAt,
        isCashBuyer,
      }

      // HONESTY: no financing date AND no pre-approval expiry → nothing computable; skip.
      if (!dates.financingDeadline && !dates.preApprovalExpiresAt) {
        result.skippedNoSignal += 1
        continue
      }

      const w = financingWindow(dates, now, {
        financingWindowDays: opts.financingWindowDays,
        preApprovalWindowDays: opts.preApprovalWindowDays,
      })
      if (!w.inWindow) continue
      result.inWindow += 1

      const sig = financingWindowSignature(w)

      // IDEMPOTENCY — one race per (deal, financing-window). Keyed on the window signature in
      // the gated summary's rationale within the lookback.
      const { data: existing } = await supabase.from("agent_client_messages")
        .select("id")
        .eq("brokerage_id", brokerageId)
        .eq("entity_type", "transaction")
        .eq("entity_id", t.id)
        .ilike("rationale", `PIT STOP — sig:${sig} %`)
        .gte("created_at", sinceIso)
        .limit(1)
        .maybeSingle()
      if (existing) continue

      // The deal's KNOWN lender quote(s) — transaction_lenders (real columns). interest_rate
      // is the rate; there are NO points/fees columns, so the live rank is rate-driven (points
      // /fees default 0). loan_amount lets the pure core amortize fees when they ever exist.
      const { data: lenderRows } = await supabase.from("transaction_lenders")
        .select("id, lender_name, interest_rate, loan_amount, loan_term_years")
        .eq("transaction_id", t.id).limit(50)
      const onFileQuotes: LenderQuote[] = ((lenderRows ?? []) as any[]).map((r) => ({
        id: r.id,
        lenderName: r.lender_name ?? null,
        rate: r.interest_rate != null ? Number(r.interest_rate) : null,
        loanAmount: r.loan_amount != null ? Number(r.loan_amount) : (t.loan_amount != null ? Number(t.loan_amount) : null),
        source: "on_file" as const,
      }))

      // Known incumbent from the pre-approval (lender named, no rate on file) — surfaces the
      // incumbent in the ranking even before the race returns. Deduped by lender name vs
      // transaction_lenders so we don't double-list the same lender.
      const onFileNames = new Set(onFileQuotes.map((q) => (q.lenderName ?? "").toLowerCase()).filter(Boolean))
      const incumbentQuotes: LenderQuote[] = []
      if (preApprovalLender && !onFileNames.has(preApprovalLender.toLowerCase())) {
        incumbentQuotes.push({
          id: `preapproval:${buyerContactId}`,
          lenderName: preApprovalLender,
          rate: null, // pre-approval carries an amount, not a live rate — ranked after rated quotes
          loanAmount: preApprovalAmount,
          source: "on_file",
        })
      }

      const ranked = rankLenderQuotes([...onFileQuotes, ...incumbentQuotes])

      // THE RACE — one GATED rate-request draft per preferred bench lender (parallel). Nothing
      // auto-sends. Reuses the vendor-orchestration gated-draft pattern, financing-specialized.
      let raceDrafts = 0
      if (preferredBench.length === 0) {
        result.benchMisses += 1
      } else {
        const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
        const { generatePersonaCopy } = await import("@/lib/kernel/ai-copy")
        const loanAmount = t.loan_amount != null ? Number(t.loan_amount)
          : (onFileQuotes.find((q) => q.loanAmount != null)?.loanAmount ?? preApprovalAmount ?? null)
        for (const lender of preferredBench) {
          const fallback = composeRateRequestFallback({
            lenderName: lender.name,
            dealName: t.deal_name ?? null,
            propertyAddress: t.property_address ?? null,
            loanAmount,
          })
          const facts = [
            `Lender: ${lender.name}`,
            `An active transaction is entering its financing window`,
            t.property_address ? `Property: ${t.property_address}` : "Property on file",
            loanAmount && loanAmount > 0
              ? `Approximate loan amount: ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(loanAmount)}`
              : "Loan amount on file",
            "We are requesting a CURRENT rate ESTIMATE (with any points and fees) — an estimate, not a commitment",
            "We are comparing current options for the client; nothing is decided here",
          ]
          const copy = await generatePersonaCopy(
            {
              goal: "a courteous request to a preferred lender for a CURRENT rate estimate (with points/fees) to refresh a deal's financing — make clear this is an estimate, not a commitment or an offer",
              facts,
              channel: "email",
              persona: { name: lender.name, audience: "vendor", situation: "preferred lender on a real-estate deal entering its financing window", tone: "professional, concise, courteous" },
              words: 80,
            },
            fallback,
            { generator: opts.copyGenerator },
          )
          const res = await proposeClientMessage({
            brokerageId,
            agentKind: "deal_coordinator",
            entityType: "transaction",
            entityId: t.id,
            recipientContactId: null, // audience 'agent' — internal gated draft (the agent sends)
            audience: "agent",
            subject: copy.subject ?? fallback.subject,
            body: copy.body,
            rationale: `PIT STOP RACE — sig:${sig} — rate-refresh request to preferred lender ${lender.name}${lender.rating != null ? ` (rating ${lender.rating})` : ""}; deal ${t.deal_name ?? t.id} in financing window (${w.primaryTrigger}); estimate request, nothing auto-sends.`,
            channel: "portal",
          }, supabase)
          if (res.ok) raceDrafts += 1
        }
      }
      result.raceDraftsProposed += raceDrafts

      // (a) ONE gated Deal Coordinator agent summary — the ranked pit-stop status.
      const dealName = t.deal_name ?? t.property_address ?? "this deal"
      const fallback = composeFinancingSummary({ dealName, window: w, ranked, benchRaceCount: raceDrafts })
      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const summaryRes = await proposeClientMessage({
        brokerageId,
        agentKind: "deal_coordinator",
        entityType: "transaction",
        entityId: t.id,
        recipientContactId: null,
        audience: "agent",
        subject: fallback.agentSubject,
        body: fallback.agentSummary,
        rationale: `PIT STOP — sig:${sig} — deal entered the financing window (${w.triggers.join("+")}; primary ${w.primaryTrigger}); ${ranked.length} known quote(s) ranked by effective cost; rate-refresh race to ${raceDrafts} preferred lender(s); buyer portal card pushed. RATES ARE ESTIMATES, not commitments.`,
        channel: "portal",
      }, supabase)
      if (summaryRes.ok) result.summariesProposed += 1

      // (b) Buyer-portal VALUE card — read-only, plain language, rates labeled estimates.
      if (buyerContactId) {
        const { pushPortalValueCard } = await import("@/lib/kernel/portal-value")
        const { generatePersonaCopy, loadContactPersona } = await import("@/lib/kernel/ai-copy")
        const persona = await loadContactPersona(supabase, buyerContactId).catch(() => ({ audience: "buyer" as const }))
        const best = ranked.find((q) => q.rate != null) ?? null
        const facts = [
          `Your financing is being refreshed (${w.primaryTrigger === "preapproval_stale" ? "your pre-approval is approaching its refresh point" : "your financing milestone is approaching"})`,
          `Your agent started a rate check across our preferred lenders`,
          best ? `The best current ESTIMATE so far is around ${fmtRate(best.rate as number)} — an estimate, not a final offer` : "Estimates will appear here as lenders respond",
          "Nothing is needed from you right now — your agent will walk you through every number",
        ]
        const body = (await generatePersonaCopy(
          {
            goal: "a short, calm portal update telling the buyer their financing is being refreshed and roughly where the best current rate ESTIMATE stands (estimate not commitment, no pressure, no jargon, no lending-eligibility or steering language)",
            facts,
            channel: "portal",
            persona: { ...persona, audience: "buyer", situation: "home buyer in the financing window" },
            words: 70,
          },
          { body: fallback.buyerCardBody },
          { generator: opts.copyGenerator },
        )).body
        const pushed = await pushPortalValueCard({
          brokerageId,
          contactId: buyerContactId,
          listingId: t.listing_id ?? null,
          title: "Your financing is being refreshed",
          summary: body,
          updateType: "financing_pit_stop",
          metadata: {
            transaction_id: t.id,
            triggers: w.triggers,
            primary_trigger: w.primaryTrigger,
            days_to_financing_deadline: w.daysToFinancingDeadline,
            days_to_preapproval_expiry: w.daysToPreApprovalExpiry,
            window_signature: sig,
            bench_race_count: raceDrafts,
            ranked_quotes: ranked.map((q) => ({
              lender_name: q.lenderName,
              rate: q.rate,
              effective_rate: Number.isFinite(q.effectiveRate) ? q.effectiveRate : null,
              source: q.source,
            })),
            best_estimate_rate: best?.rate ?? null,
            rates_are_estimates: true,
            agent_summary_id: summaryRes.id ?? null,
          },
          now,
        }, supabase)
        if (pushed.pushed) result.portalCardsPushed += 1
      }
    } catch (e: any) {
      result.errors.push(`${t.id}: ${e?.message ?? String(e)}`)
    }
  }

  return result
}
