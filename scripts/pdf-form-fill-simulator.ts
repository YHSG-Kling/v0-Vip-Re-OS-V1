#!/usr/bin/env tsx
/**
 * scripts/pdf-form-fill-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the in-app PDF FORM FILL — a storage/offer-packet PDF's AcroForm fields are filled in-app
 * (the filled bytes ARE the preview), provider-agnostic, with the property-only prefill: KNOWN
 * property identification fills its fields; offer-TERM fields and unknown property facts are left
 * BLANK for the agent. Fully headless (pdf-lib runs in Node) — no browser, no mocks: it builds a REAL
 * PDF with form fields, fills it, then RE-READS the filled PDF to verify the values landed.
 *
 * Run: npx tsx scripts/pdf-form-fill-simulator.ts   (npm run test:pdf-form-fill)
 */
import { PDFDocument } from "pdf-lib"
import { listPdfFields, fillPdfForm } from "../lib/forms/pdf-form-fill"
import { prefillPropertyIntoPdf } from "../lib/forms/prefill-property-into-pdf"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ PDF form fill verified — property prefilled into a real PDF; terms left to the agent.")
  console.log(" PDF_FORM_FILL_PASS")
  process.exit(0)
}

/** Build a REAL offer-form PDF with named AcroForm text fields. */
async function makeOfferPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const form = doc.getForm()
  const fieldNames = ["Property Address", "Legal Description", "Property City", "Property State", "Offer Price", "Earnest Money", "Buyer City"]
  let y = 740
  for (const name of fieldNames) {
    const tf = form.createTextField(name)
    tf.addToPage(page, { x: 200, y, width: 360, height: 18 })
    y -= 28
  }
  return doc.save()
}

/** Read back a single text field's value from filled PDF bytes. */
async function readField(bytes: Uint8Array, name: string): Promise<string> {
  const doc = await PDFDocument.load(bytes)
  return doc.getForm().getTextField(name).getText() ?? ""
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" PDF form fill simulator")
  console.log("══════════════════════════════════════════════════\n")

  const pdf = await makeOfferPdf()

  console.log("[field discovery]")
  const fields = await listPdfFields(pdf)
  check("lists all AcroForm fields on the PDF", fields.includes("Property Address") && fields.includes("Offer Price") && fields.length === 7, JSON.stringify(fields))

  console.log("\n[property-only prefill into the real PDF]")
  const result = await prefillPropertyIntoPdf(pdf, {
    address: "742 Evergreen Ter", legalDescription: "LOT 4 BLK 2", propertyCity: "Springfield", propertyState: "MA",
  })
  check("property identification fields were filled", result.filled.includes("Property Address") && result.filled.includes("Legal Description") && result.filled.includes("Property City"))
  check("OFFER-TERM fields were NOT filled (agent's job)", !result.filled.includes("Offer Price") && !result.filled.includes("Earnest Money"))
  check("a bare 'Buyer City' was NOT mis-filled with the property city", !result.filled.includes("Buyer City"))

  // RE-READ the filled PDF — the values actually landed in the document (the preview is real).
  check("re-read: Property Address holds the value in the saved PDF", (await readField(result.bytes, "Property Address")) === "742 Evergreen Ter")
  check("re-read: Legal Description holds the value", (await readField(result.bytes, "Legal Description")) === "LOT 4 BLK 2")
  check("re-read: Offer Price is BLANK (agent fills it)", (await readField(result.bytes, "Offer Price")) === "")

  console.log("\n[unknown facts → blank; missing fields → skipped, not invented]")
  const partial = await prefillPropertyIntoPdf(pdf, { address: "1 Main St" /* legal description unknown */ })
  check("known address fills; unknown legal description left blank (unresolved)", partial.filled.includes("Property Address") && partial.unresolvedProperty.includes("Legal Description"))
  const direct = await fillPdfForm(pdf, [{ name: "Nonexistent Field", value: "x" }, { name: "Property Address", value: "9 Oak Ave" }])
  check("a requested field the PDF lacks is skipped, not invented", direct.skipped.includes("Nonexistent Field") && direct.filled.includes("Property Address"))

  console.log("\n[flatten locks the filled values]")
  const flat = await fillPdfForm(pdf, [{ name: "Property Address", value: "5 Cedar Ct" }], { flatten: true })
  const flatDoc = await PDFDocument.load(flat.bytes)
  check("flattened PDF has no editable form fields left", flatDoc.getForm().getFields().length === 0)

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
