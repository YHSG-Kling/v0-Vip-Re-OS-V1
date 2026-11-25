// lib/buyer-offers/home-comparison.ts
// ─────────────────────────────────────────────────────────────────────────────
// SIDE-BY-SIDE HOME COMPARISON — the decision tool buyers obsess over (RealScout's "industry-
// first") that we lacked, so buyers leaked to Zillow to compare their finalists. This keeps them
// deciding in OUR app: their saved homes lined up by the numbers that matter — monthly payment
// (reusing the affordability engine), price-per-sqft, space, beds/baths, match — with the BEST in
// each row flagged so the choice gets clearer, not noisier. PURE: no I/O, exhaustively testable.
//
// Framing stays them-first (clientAffordabilityFraming doctrine): we highlight strengths ("best
// value", "most space"), never rank a home as "worst" — the agent has the nuanced conversation.

// Wave 156 (156H round 2): the payment is the ONE engine's (lib/calculators/buyer-payment.ts) over the buyer's OWN figures.
import { buyerPaymentFor, calculatorNeeds, type LoanAssumptionInputs } from "@/lib/calculators/buyer-payment"

export interface ComparisonHomeInput {
  id: string
  address: string
  price: number
  bedrooms?: number | null
  bathrooms?: number | null
  sqft?: number | null
  /** 0-100 AI fit score, when available. */
  matchScore?: number | null
}

/** The buyer's own loan figures, applied to every home alike (apples to apples). Blank figures are asked for, never defaulted. */
export type ComparisonAssumptions = LoanAssumptionInputs

export interface ComparedHome {
  id: string
  address: string
  price: number
  bedrooms: number | null
  bathrooms: number | null
  sqft: number | null
  matchScore: number | null
  /** Estimated monthly payment under the buyer's shared assumptions — null until they have entered them. */
  monthlyPayment: number | null
  /** Price per sqft (null when sqft unknown — honest, no fabrication). */
  pricePerSqft: number | null
  /** Strength badges this home WINS in the set (them-first: we name strengths, never "worst"). */
  highlights: string[]
}

export interface HomeComparison {
  homes: ComparedHome[]
  /** What the buyer still needs to enter before payments can be compared ("Enter a value: …"); [] when payments are shown. */
  paymentNeeds: string[]
  /** Count of homes compared (2–4 is the sweet spot). */
  count: number
}

const round = (n: number) => Math.round(n)

/**
 * compareHomes — PURE. Line up 2–4 homes by the numbers and flag the BEST in each dimension
 * (lowest payment, lowest $/sqft, most space, best match) as strength highlights. Monthly payment
 * is the engine's (buyerPaymentFor) under the buyer's shared assumptions so the comparison is apples-to-apples.
 * A dimension with no usable data simply isn't flagged — never fabricated.
 */
export function compareHomes(homes: ComparisonHomeInput[], assumptions: ComparisonAssumptions = {}): HomeComparison {
  let needs: string[] = []
  const usable = (homes ?? []).filter((h) => h && h.id && typeof h.price === "number" && h.price > 0).slice(0, 4)
  const computed: ComparedHome[] = usable.map((h) => {
    const pay = buyerPaymentFor(h.price, assumptions)
    if (!pay.ok) needs = calculatorNeeds(pay)
    const monthlyPayment = pay.ok ? round(Number(pay.outputs.monthlyTotal)) : null
    const pricePerSqft = typeof h.sqft === "number" && h.sqft > 0 ? round(h.price / h.sqft) : null
    return {
      id: h.id, address: h.address, price: h.price,
      bedrooms: h.bedrooms ?? null, bathrooms: h.bathrooms ?? null, sqft: h.sqft ?? null,
      matchScore: typeof h.matchScore === "number" ? h.matchScore : null,
      monthlyPayment, pricePerSqft, highlights: [],
    }
  })

  if (computed.length >= 2) {
    // Lowest monthly payment.
    if (computed.every((c) => c.monthlyPayment != null)) {
      const minPay = Math.min(...computed.map((c) => c.monthlyPayment as number))
      flagUniqueWinner(computed, (c) => c.monthlyPayment === minPay, "Lowest payment")
    }
    // Lowest $/sqft (best value) — only among those with sqft.
    const withPpsf = computed.filter((c) => c.pricePerSqft != null)
    if (withPpsf.length >= 2) {
      const minPpsf = Math.min(...withPpsf.map((c) => c.pricePerSqft as number))
      flagUniqueWinner(computed, (c) => c.pricePerSqft === minPpsf, "Best value per sq ft")
    }
    // Most space.
    const withSqft = computed.filter((c) => typeof c.sqft === "number" && (c.sqft as number) > 0)
    if (withSqft.length >= 2) {
      const maxSqft = Math.max(...withSqft.map((c) => c.sqft as number))
      flagUniqueWinner(computed, (c) => c.sqft === maxSqft, "Most space")
    }
    // Best match.
    const withMatch = computed.filter((c) => c.matchScore != null)
    if (withMatch.length >= 2) {
      const maxMatch = Math.max(...withMatch.map((c) => c.matchScore as number))
      flagUniqueWinner(computed, (c) => c.matchScore === maxMatch, "Best fit for you")
    }
  }

  return { homes: computed, count: computed.length, paymentNeeds: needs }
}

/** Flag the winner ONLY when it's unique (a tie names no winner — don't crown arbitrarily). */
function flagUniqueWinner(homes: ComparedHome[], pred: (c: ComparedHome) => boolean, label: string): void {
  const winners = homes.filter(pred)
  if (winners.length === 1) winners[0].highlights.push(label)
}
