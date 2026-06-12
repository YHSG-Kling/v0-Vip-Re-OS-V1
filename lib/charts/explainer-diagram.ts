/**
 * lib/charts/explainer-diagram.ts
 *
 * Pure, deterministic diagram spec for the ANIMATED EXPLAINER reel
 * (remotion/ExplainerAnimReel.tsx). This is the in-stack answer to Manim:
 * the explainer's *content* — the year/value points of an equity curve, the
 * payment bars of a rate-buydown, the milestone steps of a closing timeline —
 * computed as plain data here, then ANIMATED by the Remotion composition with
 * interpolate()/spring(). No React, no Remotion, no Python: the whole concept
 * engine is unit-testable in scripts/explainer-anim-simulator.ts before a
 * single frame renders.
 *
 * Why native (not live Manim): there is no Python render service in this repo
 * (manim exists only as a Claude *skill*, never in the request path). Manim
 * needs Python+LaTeX+cairo — not serverless-friendly on Vercel. The existing
 * render rail is 100% Remotion/Chromium (see lib/charts/geometry.ts + CMAReel).
 * So we do what Manim does — animate math/diagrams — natively and deterministic.
 *
 * Topics the OS needs (real-estate concepts a static stat-card can't teach):
 *   · equity_over_time   — equity building as the loan amortizes + value grows
 *   · rate_buydown       — monthly payment at the note rate vs a bought-down rate
 *   · closing_timeline    — the escrow/closing milestones as a stepped path
 *   · what_monthly_buys   — what a target monthly payment buys across price tiers
 *
 * Topic + facts ride on situation.facts (the Director already chose the
 * explainer kind upstream — this module never imports the Director). When a
 * topic has NO usable facts, we return an honest `hasData:false` spec with a
 * reason string so the composition can render a graceful "ask me" fallback
 * instead of fabricating numbers.
 */

export type ExplainerTopic =
  | "equity_over_time"
  | "rate_buydown"
  | "closing_timeline"
  | "what_monthly_buys"

/** Loose bag of facts as it arrives from situation.facts. Values may be
 *  strings (most Director facts are) or numbers; we coerce defensively. */
export type ExplainerFacts = Record<string, unknown>

/** A point on the animated equity curve. */
export interface EquityPoint {
  year:    number
  /** Estimated property value that year. */
  value:   number
  /** Remaining loan balance that year. */
  balance: number
  /** value − balance (the equity wedge height). */
  equity:  number
}

export interface EquityOverTimeData {
  kind:       "equity_over_time"
  points:     EquityPoint[]
  startValue: number
  startLoan:  number
  /** Annual appreciation rate used (decimal, e.g. 0.04). */
  apr:        number
  /** Mortgage note rate used (decimal). */
  rate:       number
  termYears:  number
  /** Equity at the final year — the headline payoff. */
  finalEquity: number
}

/** One payment bar in the rate-buydown comparison. */
export interface PaymentBar {
  label:   string
  /** Mortgage rate for this bar (decimal). */
  rate:    number
  /** Monthly principal+interest. */
  payment: number
}

export interface RateBuydownData {
  kind:        "rate_buydown"
  bars:        PaymentBar[]
  loanAmount:  number
  termYears:   number
  /** Dollars saved per month at the bought-down rate vs the note rate. */
  monthlySavings: number
  /** First-year savings (monthlySavings × 12). */
  annualSavings:  number
}

export interface TimelineStep {
  index:  number
  label:  string
  /** Day offset from contract acceptance (day 0). */
  day:    number
}

export interface ClosingTimelineData {
  kind:      "closing_timeline"
  steps:     TimelineStep[]
  totalDays: number
}

export interface PriceTier {
  /** Monthly payment that buys this tier. */
  monthly: number
  /** Approx. purchase price at that monthly payment. */
  price:   number
  label:   string
}

export interface WhatMonthlyBuysData {
  kind:        "what_monthly_buys"
  tiers:       PriceTier[]
  rate:        number
  termYears:   number
  /** Down-payment fraction assumed (decimal). */
  downPct:     number
  /** The headline target monthly the lead asked about. */
  targetMonthly: number
}

export type DiagramData =
  | EquityOverTimeData
  | RateBuydownData
  | ClosingTimelineData
  | WhatMonthlyBuysData

export interface ExplainerDiagramSpec {
  topic:   ExplainerTopic
  /** True when we had enough real facts to compute an honest diagram. */
  hasData: boolean
  /** Present only when hasData. */
  data?:   DiagramData
  /** Human-readable headline for the diagram slide. */
  title:   string
  /** Short caption / assumptions line (always honest about estimates). */
  caption: string
  /** When hasData is false, why — so the composition can be honest. */
  reason?: string
}

// ── coercion helpers ────────────────────────────────────────────────────────

/** Pull a finite number out of a loose fact value. Strips $ , % and spaces
 *  so "$420,000", "6.5%", "  7 " all coerce. Returns undefined when unusable. */
export function coerceNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined
  if (typeof v === "string") {
    const cleaned = v.replace(/[$,%\s]/g, "")
    if (cleaned === "") return undefined
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** First defined coercible number among the given fact keys. */
function pickNum(facts: ExplainerFacts, keys: string[]): number | undefined {
  for (const k of keys) {
    const n = coerceNumber(facts[k])
    if (n !== undefined) return n
  }
  return undefined
}

/** A rate fact may arrive as 6.5 (percent) or 0.065 (decimal). Normalize to a
 *  decimal in [0,1). Anything ≥ 1 is treated as a percent. */
function asRate(n: number): number {
  return n >= 1 ? n / 100 : n
}

/** Standard amortized monthly P&I. Guards a zero rate (straight division) and
 *  non-positive principal/term. */
export function monthlyPayment(principal: number, annualRate: number, termYears: number): number {
  if (principal <= 0 || termYears <= 0) return 0
  const n = termYears * 12
  const r = annualRate / 12
  if (r === 0) return principal / n
  const f = Math.pow(1 + r, n)
  return (principal * r * f) / (f - 1)
}

/** Remaining loan balance after `monthsPaid` of an amortized loan. */
export function remainingBalance(principal: number, annualRate: number, termYears: number, monthsPaid: number): number {
  if (principal <= 0 || termYears <= 0) return 0
  const n = termYears * 12
  const m = Math.min(Math.max(0, monthsPaid), n)
  if (m === 0) return principal      // exact: nothing paid yet
  const r = annualRate / 12
  if (r === 0) return Math.max(0, principal * (1 - m / n))
  const f = Math.pow(1 + r, n)
  const fm = Math.pow(1 + r, m)
  return Math.max(0, principal * (f - fm) / (f - 1))
}

function round(n: number): number { return Math.round(n) }

// ── per-topic spec builders ─────────────────────────────────────────────────

function buildEquityOverTime(facts: ExplainerFacts): ExplainerDiagramSpec {
  const value = pickNum(facts, ["purchasePrice", "price", "homeValue", "value", "estimatedValue"])
  if (value === undefined || value <= 0) {
    return {
      topic: "equity_over_time", hasData: false,
      title: "How your equity grows",
      caption: "Estimates only — share a price to see your numbers.",
      reason: "no purchase price / home value in facts",
    }
  }
  const downPct = (() => {
    const d = pickNum(facts, ["downPaymentPct", "downPct"])
    if (d !== undefined) return asRate(d)
    const dollars = pickNum(facts, ["downPayment", "downPaymentAmount"])
    if (dollars !== undefined && dollars > 0 && dollars < value) return dollars / value
    return 0.2
  })()
  const startLoan = Math.max(0, value * (1 - downPct))
  const rate = asRate(pickNum(facts, ["rate", "interestRate", "mortgageRate"]) ?? 6.5)
  const apr = asRate(pickNum(facts, ["appreciationRate", "apr", "appreciationPct"]) ?? 4)
  const termYears = Math.round(pickNum(facts, ["termYears", "loanTerm", "term"]) ?? 30)
  const horizon = Math.min(Math.round(pickNum(facts, ["horizonYears", "years"]) ?? 10), termYears)

  const points: EquityPoint[] = []
  for (let y = 0; y <= horizon; y++) {
    const v = value * Math.pow(1 + apr, y)
    const bal = remainingBalance(startLoan, rate, termYears, y * 12)
    points.push({ year: y, value: round(v), balance: round(bal), equity: round(v - bal) })
  }
  const finalEquity = points[points.length - 1].equity
  return {
    topic: "equity_over_time", hasData: true,
    data: { kind: "equity_over_time", points, startValue: round(value), startLoan: round(startLoan), apr, rate, termYears, finalEquity },
    title: "How your equity grows",
    caption: `Assumes ${(apr * 100).toFixed(1)}% appreciation, ${(rate * 100).toFixed(1)}% / ${termYears}yr loan — estimates, not a guarantee.`,
  }
}

function buildRateBuydown(facts: ExplainerFacts): ExplainerDiagramSpec {
  const loanAmount = (() => {
    const l = pickNum(facts, ["loanAmount", "loan"])
    if (l !== undefined && l > 0) return l
    const price = pickNum(facts, ["purchasePrice", "price", "homeValue", "value"])
    if (price !== undefined && price > 0) {
      const dp = pickNum(facts, ["downPaymentPct", "downPct"])
      return price * (1 - (dp !== undefined ? asRate(dp) : 0.2))
    }
    return undefined
  })()
  if (loanAmount === undefined || loanAmount <= 0) {
    return {
      topic: "rate_buydown", hasData: false,
      title: "What a rate buydown saves you",
      caption: "Estimates only — share a price to see the payment math.",
      reason: "no loan amount / price in facts",
    }
  }
  const noteRate = asRate(pickNum(facts, ["rate", "interestRate", "noteRate", "mortgageRate"]) ?? 7)
  const boughtRate = (() => {
    const b = pickNum(facts, ["buydownRate", "boughtDownRate"])
    if (b !== undefined) return asRate(b)
    const pts = pickNum(facts, ["buydownPoints", "points"])
    // Convention: ~0.25% rate reduction per point (estimate).
    const reduction = pts !== undefined ? Math.min(pts * 0.0025, noteRate) : 0.01
    return Math.max(0, noteRate - reduction)
  })()
  const termYears = Math.round(pickNum(facts, ["termYears", "loanTerm", "term"]) ?? 30)

  const noteP = monthlyPayment(loanAmount, noteRate, termYears)
  const boughtP = monthlyPayment(loanAmount, boughtRate, termYears)
  const bars: PaymentBar[] = [
    { label: `${(noteRate * 100).toFixed(2)}% (market)`, rate: noteRate, payment: round(noteP) },
    { label: `${(boughtRate * 100).toFixed(2)}% (bought down)`, rate: boughtRate, payment: round(boughtP) },
  ]
  const monthlySavings = round(Math.max(0, noteP - boughtP))
  return {
    topic: "rate_buydown", hasData: true,
    data: { kind: "rate_buydown", bars, loanAmount: round(loanAmount), termYears, monthlySavings, annualSavings: monthlySavings * 12 },
    title: "What a rate buydown saves you",
    caption: `On a $${round(loanAmount).toLocaleString()} loan, ${termYears}yr — estimated P&I only.`,
  }
}

const DEFAULT_CLOSING_STEPS: { label: string; day: number }[] = [
  { label: "Offer accepted", day: 0 },
  { label: "Earnest money deposited", day: 3 },
  { label: "Inspection", day: 10 },
  { label: "Appraisal", day: 18 },
  { label: "Loan approval", day: 25 },
  { label: "Final walkthrough", day: 29 },
  { label: "Closing day", day: 30 },
]

function buildClosingTimeline(facts: ExplainerFacts): ExplainerDiagramSpec {
  // Closing timeline is always renderable — it teaches the standard escrow path.
  // If the facts carry a real closeDays / total, scale the canonical steps to it.
  const closeDays = pickNum(facts, ["closeDays", "closingDays", "escrowDays", "daysToClose"])
  let steps: TimelineStep[]
  if (closeDays !== undefined && closeDays > 0) {
    const span = DEFAULT_CLOSING_STEPS[DEFAULT_CLOSING_STEPS.length - 1].day || 30
    const scale = closeDays / span
    steps = DEFAULT_CLOSING_STEPS.map((s, i) => ({ index: i, label: s.label, day: Math.round(s.day * scale) }))
  } else {
    steps = DEFAULT_CLOSING_STEPS.map((s, i) => ({ index: i, label: s.label, day: s.day }))
  }
  const totalDays = steps[steps.length - 1].day
  return {
    topic: "closing_timeline", hasData: true,
    data: { kind: "closing_timeline", steps, totalDays },
    title: "Your path to closing",
    caption: `A typical ${totalDays}-day escrow — timelines vary by deal.`,
  }
}

function buildWhatMonthlyBuys(facts: ExplainerFacts): ExplainerDiagramSpec {
  const targetMonthly = pickNum(facts, ["monthlyBudget", "targetMonthly", "monthly", "payment"])
  if (targetMonthly === undefined || targetMonthly <= 0) {
    return {
      topic: "what_monthly_buys", hasData: false,
      title: "What your monthly payment buys",
      caption: "Estimates only — share a monthly budget to see what it buys.",
      reason: "no monthly budget in facts",
    }
  }
  const rate = asRate(pickNum(facts, ["rate", "interestRate", "mortgageRate"]) ?? 6.5)
  const termYears = Math.round(pickNum(facts, ["termYears", "loanTerm", "term"]) ?? 30)
  const downPct = asRate(pickNum(facts, ["downPaymentPct", "downPct"]) ?? 20)

  // Invert the amortization: a monthly P&I → max loan → price (loan/(1-down)).
  const loanFromPayment = (pmt: number): number => {
    const n = termYears * 12
    const r = rate / 12
    if (r === 0) return pmt * n
    const f = Math.pow(1 + r, n)
    return (pmt * (f - 1)) / (r * f)
  }
  const priceFromMonthly = (m: number): number => {
    const loan = loanFromPayment(m)
    const denom = 1 - downPct
    return denom > 0 ? loan / denom : loan
  }
  const factors = [0.85, 1, 1.15]
  const tiers: PriceTier[] = factors.map((fct) => {
    const m = targetMonthly * fct
    return { monthly: round(m), price: round(priceFromMonthly(m)), label: `$${round(m).toLocaleString()}/mo` }
  })
  return {
    topic: "what_monthly_buys", hasData: true,
    data: { kind: "what_monthly_buys", tiers, rate, termYears, downPct, targetMonthly: round(targetMonthly) },
    title: "What your monthly payment buys",
    caption: `At ${(rate * 100).toFixed(1)}% / ${termYears}yr / ${(downPct * 100).toFixed(0)}% down — P&I estimate, excludes taxes/insurance.`,
  }
}

/** Normalize an arbitrary topic string from facts to a known topic. Returns
 *  undefined for unknown values so the caller can decide a default. */
export function normalizeTopic(raw: unknown): ExplainerTopic | undefined {
  if (typeof raw !== "string") return undefined
  const t = raw.trim().toLowerCase().replace(/[\s-]+/g, "_")
  const known: Record<string, ExplainerTopic> = {
    equity_over_time: "equity_over_time",
    equity: "equity_over_time",
    equity_growth: "equity_over_time",
    rate_buydown: "rate_buydown",
    buydown: "rate_buydown",
    rate_buy_down: "rate_buydown",
    closing_timeline: "closing_timeline",
    closing: "closing_timeline",
    escrow_timeline: "closing_timeline",
    timeline: "closing_timeline",
    what_monthly_buys: "what_monthly_buys",
    what_x_mo_buys: "what_monthly_buys",
    affordability: "what_monthly_buys",
    monthly_buys: "what_monthly_buys",
  }
  return known[t]
}

/**
 * The pure entry point: topic + facts → diagram spec. Topic may be passed
 * explicitly or read from facts.topic / facts.explainerTopic. Unknown topics
 * fall back to the always-renderable closing timeline.
 */
export function explainerDiagramSpec(topic: ExplainerTopic | string | undefined, facts: ExplainerFacts = {}): ExplainerDiagramSpec {
  const resolved =
    normalizeTopic(topic) ??
    normalizeTopic(facts.topic) ??
    normalizeTopic(facts.explainerTopic) ??
    "closing_timeline"

  switch (resolved) {
    case "equity_over_time":  return buildEquityOverTime(facts)
    case "rate_buydown":      return buildRateBuydown(facts)
    case "closing_timeline":  return buildClosingTimeline(facts)
    case "what_monthly_buys": return buildWhatMonthlyBuys(facts)
  }
}
