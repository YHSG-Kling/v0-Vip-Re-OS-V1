// lib/calculators/buyer-payment.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE "MONTHLY PAYMENT FOR THIS HOME" HELPER (wave 156, lane 156H, round 2) — the survivor of
// lib/buyer-offers/affordability.ts estimateMonthlyPayment (tombstone there). A thin, PURE adapter over the engine's
// "buyer_payment" calculator (lib/calculators/engine.ts): it converts the buyer's down-payment PERCENT into dollars for one price
// and otherwise passes the buyer's own figures through. Nothing is defaulted: a blank rate, term, tax or insurance figure comes
// back as "Enter a value", and the result carries its assumptions and disclaimers like every calculator.

import { runCalculator, type CalculatorOutcome } from "./engine"

/** The buyer's own loan figures, as typed (numbers or numeric strings). Every one may be blank — the engine says which to enter. */
export interface LoanAssumptionInputs {
  downPaymentPct?: number | string | null
  ratePct?: number | string | null
  termYears?: number | string | null
  propertyTaxRatePct?: number | string | null
  annualInsurance?: number | string | null
  hoaMonthly?: number | string | null
  mortgageInsuranceMonthly?: number | string | null
}

const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim())

/**
 * PURE. The engine's monthly-payment result for one price under the buyer's own assumptions. `annualPropertyTax`, when the
 * caller holds the property's own county bill, replaces the rate and is labelled as the property's public record.
 */
export function buyerPaymentFor(
  price: number,
  a: LoanAssumptionInputs,
  opts: { annualPropertyTax?: number | null; taxCitation?: string; recordHoaMonthly?: number | null; audience?: "public" | "internal"; estimateKeys?: string[] } = {},
): CalculatorOutcome {
  const pct = blank(a.downPaymentPct) ? null : Number(String(a.downPaymentPct).replace(/[%\s,]/g, ""))
  const downPayment = pct === null ? undefined : Number.isFinite(pct) && pct >= 0 && pct <= 100 ? (price * pct) / 100 : String(a.downPaymentPct)
  const bill = typeof opts.annualPropertyTax === "number" && opts.annualPropertyTax > 0 ? opts.annualPropertyTax : null
  return runCalculator("buyer_payment", {
    price, downPayment, ratePct: a.ratePct, termYears: a.termYears,
    ...(bill !== null ? { annualPropertyTax: bill } : { propertyTaxRatePct: a.propertyTaxRatePct }),
    annualInsurance: a.annualInsurance, hoaMonthly: a.hoaMonthly, mortgageInsuranceMonthly: a.mortgageInsuranceMonthly,
  }, {
    audience: opts.audience ?? "public",
    estimateKeys: opts.estimateKeys ?? [],
    inputSources: {
      ...(bill !== null ? { annualPropertyTax: { basis: "property_record" as const, citation: opts.taxCitation ?? "This home's county tax bill (public record)" } } : {}),
      ...(typeof opts.recordHoaMonthly === "number" && opts.recordHoaMonthly > 0 ? { hoaMonthly: { basis: "property_record" as const, citation: "This home's HOA dues (public record)" } } : {}),
    },
  })
}

/** PURE. "Enter a value…" lines for a refusal (or [] for a result) — one wording for every card. */
export function calculatorNeeds(o: CalculatorOutcome): string[] {
  return o.ok ? [] : [...o.missing.map((m) => m.message), ...o.refused.map((r) => `${r.label}: ${r.reason}`)]
}
