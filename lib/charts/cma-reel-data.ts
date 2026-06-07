/**
 * lib/charts/cma-reel-data.ts
 *
 * Wave 39 — the data→chart bridge for the CMA reel. Pure mappers that turn the
 * real CMA/comps/market shapes the app already assembles (CMAComparable,
 * PricingHistoryPoint, RentcastMarketStats) into the inputProps the Remotion
 * CMAReel composition + its chart layer (lib/charts/geometry) consume. No
 * React, no Remotion, no AI, no network → fully unit-testable; the live
 * RentCast/comps fetch happens upstream and feeds this.
 */

// ── Inputs (subsets of the app's real shapes) ───────────────────────────────
export interface CmaSubject {
  address:        string
  areaName:       string
  estimatedPrice: number
}
export interface CmaComp {
  address:        string
  sale_price?:    number | null
  list_price?:    number | null
  adjusted_price?: number | null
  days_on_market?: number | null
}
export interface CmaPricePoint { price: number; recorded_at: string }

export interface CmaBrand {
  primaryColor?:  string
  accentColor?:   string
  brokerageName?: string
  agentName?:     string
  showEhoMark?:   boolean
}

export interface AffordabilityAssumptions {
  downPct?:      number // 0..1 (default 0.20)
  annualRatePct?: number // default 6.5
  termYears?:    number // default 30
  taxRatePct?:   number // annual, default 1.1
  insRatePct?:   number // annual, default 0.35
  hoaMonthly?:   number // default 0
}

// ── Monthly payment breakdown (standard amortization) ───────────────────────
export interface PaymentBreakdown { pi: number; taxes: number; insurance: number; hoa: number; total: number }

export function monthlyPaymentBreakdown(price: number, a: AffordabilityAssumptions = {}): PaymentBreakdown {
  const downPct = clamp01(a.downPct ?? 0.20)
  const rate    = (a.annualRatePct ?? 6.5) / 100 / 12
  const n       = (a.termYears ?? 30) * 12
  const loan    = Math.max(0, price) * (1 - downPct)
  const pi      = rate === 0 ? (n > 0 ? loan / n : 0) : (loan * rate) / (1 - Math.pow(1 + rate, -n))
  const taxes     = (Math.max(0, price) * (a.taxRatePct ?? 1.1) / 100) / 12
  const insurance = (Math.max(0, price) * (a.insRatePct ?? 0.35) / 100) / 12
  const hoa       = Math.max(0, a.hoaMonthly ?? 0)
  const r2 = (x: number) => Math.round(x * 100) / 100
  const out = { pi: r2(pi), taxes: r2(taxes), insurance: r2(insurance), hoa: r2(hoa) }
  return { ...out, total: r2(out.pi + out.taxes + out.insurance + out.hoa) }
}

// ── The builder ─────────────────────────────────────────────────────────────
export interface BuildCmaReelInput {
  subject:       CmaSubject
  comparables:   CmaComp[]
  priceHistory?: CmaPricePoint[]
  brand?:        CmaBrand
  affordability?: AffordabilityAssumptions
  maxComps?:     number
  /**
   * Who the reel is for. 'customer' (default) is the SELLER-SAFE view: the
   * subject's valuation is NEVER shown (business rule — a suggested list price
   * is withheld until the appointment), and affordability is computed from the
   * MARKET MEDIAN, not the subject's estimate. 'agent' is the internal prep view
   * that includes the subject valuation.
   */
  audience?:     "agent" | "customer"
  /** Market median sale price (public market data) — used for customer-facing
   *  affordability so the subject's value is never revealed. */
  marketMedianPrice?: number
}

export function buildCmaReelInputProps(input: BuildCmaReelInput): Record<string, unknown> {
  const audience = input.audience ?? "customer"
  const maxComps = input.maxComps ?? 4
  const brand = {
    primaryColor:  input.brand?.primaryColor  ?? "#0F172A",
    accentColor:   input.brand?.accentColor   ?? "#F59E0B",
    brokerageName: input.brand?.brokerageName ?? "",
    agentName:     input.brand?.agentName     ?? "",
    showEhoMark:   input.brand?.showEhoMark   ?? true,
  }

  const compPrice = (c: CmaComp): number =>
    Number(c.adjusted_price ?? c.sale_price ?? c.list_price ?? 0)

  // Comps bar — comparables that have a usable price. The SUBJECT's value bar is
  // included ONLY for the agent view; customer-facing reels show market context
  // (what other homes sold for), never a valuation of the seller's own home.
  const usableComps = input.comparables.filter((c) => compPrice(c) > 0).slice(0, maxComps)
  const compBars = usableComps.map((c) => ({ label: shortAddress(c.address), value: Math.round(compPrice(c)), isSubject: false }))
  const comps = audience === "agent"
    ? [{ label: "Subject", value: Math.max(0, Math.round(input.subject.estimatedPrice)), isSubject: true }, ...compBars]
    : compBars

  // Price trend — market price history (public). Falls back to comps for shape.
  const trend = (input.priceHistory ?? [])
    .filter((p) => Number(p.price) > 0 && p.recorded_at)
    .sort((x, y) => x.recorded_at.localeCompare(y.recorded_at))
    .slice(-6)
  const priceTrend = trend.length >= 2
    ? { values: trend.map((p) => Math.round(p.price)), labels: trend.map((p) => monthLabel(p.recorded_at)) }
    : { values: comps.map((c) => c.value), labels: comps.map((c) => c.label) }

  // Days on market — per comparable that reports it.
  const domComps = usableComps.filter((c) => Number(c.days_on_market) > 0)
  const daysOnMarket = {
    values: domComps.map((c) => Math.round(Number(c.days_on_market))),
    labels: domComps.map((c) => shortAddress(c.address)),
  }

  // Affordability donut — for the AGENT view, the subject's estimate; for the
  // CUSTOMER view, the MARKET MEDIAN (never the subject's valuation), so the
  // donut shows a typical payment for the area without revealing a price.
  const marketBase = input.marketMedianPrice
    ?? (trend.length ? trend[trend.length - 1].price : 0)
    ?? 0
  const affordabilityBase = audience === "agent"
    ? input.subject.estimatedPrice
    : (marketBase > 0 ? marketBase : meanOf(compBars.map((c) => c.value)))
  const pay = monthlyPaymentBreakdown(affordabilityBase, input.affordability)
  const affordability = {
    segments: [
      { label: "P&I",       value: pay.pi,        color: brand.accentColor },
      { label: "Taxes",     value: pay.taxes,     color: "#60A5FA" },
      { label: "Insurance", value: pay.insurance, color: "#34D399" },
      ...(pay.hoa > 0 ? [{ label: "HOA", value: pay.hoa, color: "#A78BFA" }] : []),
    ],
    centerValue: `$${Math.round(pay.total).toLocaleString()}`,
  }

  return {
    subjectAddress: input.subject.address,
    areaName:       input.subject.areaName,
    audience,
    priceWithheld:  audience === "customer",
    priceTrend,
    comps,
    daysOnMarket,
    affordability,
    ctaLabel:       audience === "customer"
      ? "Your home's value — revealed at our meeting."
      : "Want this analysis for your home?",
    brand,
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────
function clamp01(v: number): number { return Math.min(1, Math.max(0, v)) }
function meanOf(values: number[]): number {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0)
  return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : 0
}
function shortAddress(addr: string): string {
  const first = (addr ?? "").split(",")[0].trim()
  return first.length > 22 ? first.slice(0, 21) + "…" : first || "—"
}
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
function monthLabel(iso: string): string {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? "—" : MONTHS[d.getUTCMonth()]
}
