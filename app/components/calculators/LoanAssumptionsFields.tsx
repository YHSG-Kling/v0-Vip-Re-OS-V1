"use client"

// app/components/calculators/LoanAssumptionsFields.tsx — the buyer's OWN loan figures (wave 156, lane 156H, round 2).
// One small form shared by every portal / public payment card that used to fill these from AFFORDABILITY_DEFAULTS. Blank stays
// blank: lib/calculators/buyer-payment.ts buyerPaymentFor answers "Enter a value" for whatever is missing.

import { useState } from "react"
import type { LoanAssumptionInputs } from "@/lib/calculators/buyer-payment"

const FIELDS: Array<{ key: keyof LoanAssumptionInputs; label: string; placeholder: string }> = [
  { key: "downPaymentPct", label: "Down payment (%)", placeholder: "your plan" },
  { key: "ratePct", label: "Interest rate (%)", placeholder: "your lender's quote" },
  { key: "termYears", label: "Loan term (years)", placeholder: "e.g. 30" },
  { key: "propertyTaxRatePct", label: "Property-tax rate (%/yr)", placeholder: "your county's" },
  { key: "annualInsurance", label: "Insurance ($/yr)", placeholder: "from a quote" },
  { key: "hoaMonthly", label: "HOA ($/mo, optional)", placeholder: "0 if none" },
]

export function useLoanAssumptions(initial: LoanAssumptionInputs = {}) {
  const [values, setValues] = useState<LoanAssumptionInputs>(initial)
  return { values, set: (k: keyof LoanAssumptionInputs, v: string) => setValues((p) => ({ ...p, [k]: v })) }
}

export function LoanAssumptionsFields({ values, set, hideTax, idPrefix }: { values: LoanAssumptionInputs; set: (k: keyof LoanAssumptionInputs, v: string) => void; hideTax?: boolean; idPrefix: string }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {FIELDS.filter((f) => !(hideTax && f.key === "propertyTaxRatePct")).map((f) => (
        <label key={f.key} htmlFor={`${idPrefix}-${f.key}`} className="space-y-1 text-xs">
          <span className="block text-muted-foreground">{f.label}</span>
          <input id={`${idPrefix}-${f.key}`} inputMode="decimal" className="w-full rounded-md border bg-background px-2 py-1 text-sm" placeholder={f.placeholder}
            value={values[f.key] == null ? "" : String(values[f.key])} onChange={(e) => set(f.key, e.target.value)} />
        </label>
      ))}
    </div>
  )
}
