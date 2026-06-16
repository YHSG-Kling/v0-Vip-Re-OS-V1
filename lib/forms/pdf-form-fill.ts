// lib/forms/pdf-form-fill.ts
//
// PDF FORM FILL — fill the AcroForm fields of a storage/offer-packet PDF in-app, so the agent works
// in a preview instead of opening the form in another tab. Provider-AGNOSTIC: this operates on the
// PDF bytes themselves, independent of which e-sign provider (Dotloop, DocuSign, SkySlope,
// Authentisign, …) later sends it. Grounded: only fields that actually exist on the PDF are filled;
// a requested field the PDF doesn't have is returned in `skipped`, never invented. pdf-lib runs in
// Node, so the fill is fully unit-testable headlessly (the filled bytes ARE the preview artifact).

import { PDFDocument } from "pdf-lib"

export interface PdfFieldValue {
  name: string
  value: string
}

export interface PdfFillResult {
  /** the filled PDF bytes (ready to preview / save to storage). */
  bytes: Uint8Array
  /** field names that were filled. */
  filled: string[]
  /** requested field names the PDF does not have (not invented). */
  skipped: string[]
  /** all AcroForm field names present on the PDF. */
  available: string[]
}

function toUint8(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
}

/** List the AcroForm field names present on a PDF. */
export async function listPdfFields(pdfBytes: Uint8Array | ArrayBuffer): Promise<string[]> {
  const doc = await PDFDocument.load(toUint8(pdfBytes), { ignoreEncryption: true })
  return doc.getForm().getFields().map((f) => f.getName())
}

/**
 * Fill an AcroForm PDF with the given values. Only TEXT fields that exist are filled; a requested
 * field the PDF lacks (or a non-text field) is returned in `skipped`. Optionally flatten (lock the
 * filled values into the page so they can't be edited downstream). Never throws on a missing field.
 */
export async function fillPdfForm(
  pdfBytes: Uint8Array | ArrayBuffer,
  values: PdfFieldValue[],
  opts: { flatten?: boolean } = {},
): Promise<PdfFillResult> {
  const doc = await PDFDocument.load(toUint8(pdfBytes), { ignoreEncryption: true })
  const form = doc.getForm()
  const available = form.getFields().map((f) => f.getName())
  const availableSet = new Set(available)

  const filled: string[] = []
  const skipped: string[] = []
  for (const { name, value } of values ?? []) {
    if (!availableSet.has(name)) { skipped.push(name); continue }
    try {
      const field = form.getTextField(name) // throws if the field isn't a text field
      field.setText(value ?? "")
      filled.push(name)
    } catch {
      skipped.push(name) // exists but isn't a fillable text field (checkbox/radio/etc.)
    }
  }

  if (opts.flatten) form.flatten()
  const bytes = await doc.save()
  return { bytes, filled, skipped, available }
}
