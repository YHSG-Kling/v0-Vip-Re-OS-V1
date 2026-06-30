// ─── CDA PDF FILL VALUES (resolved waterfall → the brokerage's actual PDF) ──────
// The auto-binding (cda-field-classifier) maps each AcroForm field to a source; the
// resolver (cda-template-fields) fills those sources from the live waterfall +
// transaction. THIS turns the resolved, formatted values into the name→value pairs
// fillPdfForm() writes onto the brokerage's real CDA PDF — so the agent/compliance/
// broker/title see the brokerage's own document, filled, not a generic tally.
//
// Pure (no I/O) → unit-testable. Grounded: only fields that carry a real AcroForm
// target (pdf_field) AND a non-empty resolved value are written; nothing invented,
// nothing blanked. The server action feeds the result straight into fillPdfForm().

import type { ResolvedCdaField } from "./cda-template-fields"
import type { PdfFieldValue } from "@/lib/forms/pdf-form-fill"

export interface CdaFillPlan {
  /** name→value pairs to write onto the PDF (fillPdfForm input). */
  values: PdfFieldValue[]
  /** field_keys resolved but NOT written (no pdf_field target or empty value), for honesty. */
  unmapped: string[]
}

/**
 * Build the PDF fill plan from resolved CDA fields. Only fields with a real AcroForm
 * target and a non-empty formatted value are written. Pure.
 */
export function buildCdaFillValues(fields: ResolvedCdaField[]): CdaFillPlan {
  const values: PdfFieldValue[] = []
  const unmapped: string[] = []

  for (const f of fields) {
    const target = (f.pdf_field ?? "").trim()
    const formatted = (f.formatted ?? "").trim()
    if (!target || formatted === "") {
      unmapped.push(f.field_key)
      continue
    }
    values.push({ name: target, value: formatted })
  }

  return { values, unmapped }
}
