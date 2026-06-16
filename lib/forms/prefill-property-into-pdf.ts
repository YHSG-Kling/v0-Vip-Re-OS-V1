// lib/forms/prefill-property-into-pdf.ts
//
// Bridge the property-only prefill (lib/intelligence/offer-property-prefill) to a real PDF: read a
// storage form's AcroForm field names, decide which are KNOWN property-identification fields, and
// fill ONLY those into the PDF — leaving offer-term fields (and unknown property facts) blank for the
// agent. The result is a filled PDF the wizard previews. Provider-agnostic; pdf-lib runs in Node so
// it's headlessly testable. No fabrication — only known property facts touch only property fields.

import { listPdfFields, fillPdfForm, type PdfFillResult } from "./pdf-form-fill"
import { buildPropertyPrefill, type KnownPropertyFacts } from "@/lib/intelligence/offer-property-prefill"

export interface PropertyPdfPrefillResult extends PdfFillResult {
  /** recognized property fields the PDF has but we had no known value for → left blank for the agent. */
  unresolvedProperty: string[]
}

/**
 * Fill a storage form PDF with KNOWN property identification only. Reads the PDF's field names,
 * maps the known facts onto the property-identification fields (buildPropertyPrefill — never an
 * offer term, never a bare buyer field), and fills just those. Returns the filled PDF + which
 * property fields were left blank.
 */
export async function prefillPropertyIntoPdf(
  pdfBytes: Uint8Array | ArrayBuffer,
  facts: KnownPropertyFacts,
  opts: { flatten?: boolean } = {},
): Promise<PropertyPdfPrefillResult> {
  const fields = await listPdfFields(pdfBytes)
  const prefill = buildPropertyPrefill(fields, facts)
  const result = await fillPdfForm(
    pdfBytes,
    prefill.filled.map((f) => ({ name: f.formField, value: f.value })),
    opts,
  )
  return { ...result, unresolvedProperty: prefill.unresolved }
}
