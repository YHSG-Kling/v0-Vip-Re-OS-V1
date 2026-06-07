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
}

export function buildCmaReelInputProps(input: BuildCmaReelInput): Record<string, unknown> {
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

  // Comps bar — subject first (highlighted), then comparables with a usable price.
  const usableComps = input.comparables.filter((c) => compPrice(c) > 0).slice(0, maxComps)
  const comps = [
    { label: "Subject", value: Math.max(0, Math.round(input.subject.estimatedPrice)), isSubject: true },
    ...usableComps.map((c) => ({ label: shortAddress(c.address), value: Math.round(compPrice(c)), isSubject: false })),
  ]

  // Price trend — chronological price history (fallback: derive from comps mean).
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

  // Affordability donut — monthly payment split for the subject's estimate.
  const pay = monthlyPaymentBreakdown(input.subject.estimatedPrice, input.affordability)
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
    priceTrend,
    comps,
    daysOnMarket,
    affordability,
    ctaLabel:       "Want this analysis for your home?",
    brand,
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────
function clamp01(v: number): number { return Math.min(1, Math.max(0, v)) }
function shortAddress(addr: string): string {
  const first = (addr ?? "").split(",")[0].trim()
  return first.length > 22 ? first.slice(0, 21) + "…" : first || "—"
}
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
function monthLabel(iso: string): string {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? "—" : MONTHS[d.getUTCMonth()]
}
