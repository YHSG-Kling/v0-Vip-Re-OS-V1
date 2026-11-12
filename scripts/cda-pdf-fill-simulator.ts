#!/usr/bin/env tsx
/**
 * scripts/cda-pdf-fill-simulator.ts   (npm run test:cda-pdf-fill)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the CDA auto-binding produces a REAL artifact: the resolved waterfall values
 * are written onto the brokerage's actual CDA PDF (its AcroForm fields, by name).
 *
 *   PURE: buildCdaFillValues maps resolved fields → name/value pairs, writing ONLY
 *         fields with a real AcroForm target AND a non-empty value (nothing invented,
 *         nothing blanked); the rest come back in `unmapped`.
 *   LIVE: build a genuine AcroForm PDF (pdf-lib), resolve the bindings against a
 *         waterfall, fill the PDF, read the values back out, assert they round-trip.
 *
 * No external creds needed — pdf-lib runs headless. No mocks; the filled bytes ARE
 * the artifact.
 */
import { PDFDocument } from "pdf-lib"
import { resolveCdaTemplateFields, cdaWaterfallContext, type CdaFieldDef } from "../lib/transactions/cda-template-fields"
import { buildCdaFillValues } from "../lib/transactions/cda-pdf-fill"
import { fillPdfForm } from "../lib/forms/pdf-form-fill"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

// Bindings that target real AcroForm field names on the brokerage PDF.
const defs: CdaFieldDef[] = [
  { field_key: "agent_comm", label: "Agent Commission", source: "waterfall", source_key: "agent_net", field_type: "currency", display_order: 0, pdf_field: "Agent Commission $" },
  { field_key: "split", label: "Split %", source: "waterfall", source_key: "agent_split_percent", field_type: "percent", display_order: 1, pdf_field: "Agent Split %" },
  { field_key: "property", label: "Property", source: "transaction", source_key: "property_address", field_type: "text", display_order: 2, pdf_field: "Property Address" },
  { field_key: "notes", label: "Notes", source: "agent_input", field_type: "text", display_order: 3, pdf_field: "Special Instructions" }, // empty → unmapped
  { field_key: "no_target", label: "Ghost", source: "waterfall", source_key: "gross_commission", field_type: "currency", display_order: 4, pdf_field: null }, // no AcroForm target
]

async function main() {
  const wf = cdaWaterfallContext({ gross_commission: 20000, agent_net: 14000, brokerage_net: 6000, distributions: [] })
  const resolution = resolveCdaTemplateFields(defs, {
    waterfall: wf,
    transaction: { property_address: "123 Oak St, Austin, TX" },
    agentInputs: {},
  })

  console.log("\n[pure: MONEY IS NEVER AUTOFILLED onto a CDA]")
  // resolveCdaTemplateFields deliberately refuses to pre-fill a waterfall field:
  // "the agent must type it in, and the computed value is retained only as the
  // EXPECTED baseline the AI audits the entry against". A CDA is a disbursement
  // authorization — the figures on it have to be the agent's own entry, not a
  // number the system quietly wrote for them. Objective transaction facts
  // (address, dates) and static template constants still pre-fill.
  //
  // This file used to assert the OPPOSITE — that agent_net auto-filled as
  // "$14,000.00" — and had been failing 6/13 ever since the rule landed. It now
  // guards the rule instead of the behaviour the rule replaced.
  const plan = buildCdaFillValues(resolution.fields)
  const byName = (n: string) => plan.values.find((v) => v.name === n)
  const byKey = (k: string) => resolution.fields.find((f) => f.field_key === k)
  check("a waterfall money field is NOT pre-filled", !byName("Agent Commission $") && plan.unmapped.includes("agent_comm"))
  check("a waterfall percent field is NOT pre-filled", !byName("Agent Split %") && plan.unmapped.includes("split"))
  check("but the computed baseline is retained for the audit hint",
    byKey("agent_comm")?.expectedFormatted === "$14,000.00" && byKey("split")?.expectedFormatted === "70%")
  check("an objective transaction fact still pre-fills", byName("Property Address")?.value === "123 Oak St, Austin, TX")
  check("empty agent input → NOT written, listed unmapped", !byName("Special Instructions") && plan.unmapped.includes("notes"))
  check("binding with no AcroForm target → NOT written, listed unmapped", plan.unmapped.includes("no_target"))
  check("only the pre-fillable field is written", plan.values.length === 1)

  // The agent's OWN entry is what reaches the PDF — same bindings, values typed in.
  const entered = resolveCdaTemplateFields(defs, {
    waterfall: wf,
    transaction: { property_address: "123 Oak St, Austin, TX" },
    agentInputs: { agent_comm: "14000", split: "70" },
  })
  const enteredPlan = buildCdaFillValues(entered.fields)
  const enteredBy = (n: string) => enteredPlan.values.find((v) => v.name === n)
  check("agent-entered commission IS written, formatted as currency", enteredBy("Agent Commission $")?.value === "$14,000.00")
  check("agent-entered split IS written, formatted as percent", enteredBy("Agent Split %")?.value === "70%")

  console.log("\n[live: fill a genuine AcroForm PDF and read it back]")
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const form = doc.getForm()
  let y = 700
  for (const name of ["Agent Commission $", "Agent Split %", "Property Address", "Unrelated Field"]) {
    form.createTextField(name).addToPage(page, { x: 50, y, width: 220, height: 18 }); y -= 30
  }
  const blankBytes = await doc.save()

  // Fill from the AGENT-ENTERED plan — an empty CDA is the correct output of the
  // un-entered one, which the pure section above already proves.
  const result = await fillPdfForm(blankBytes, enteredPlan.values, { flatten: false })
  check("all 3 entered values were filled onto the PDF", result.filled.length === 3)
  check("no requested field was skipped (all targets exist)", result.skipped.length === 0)

  // Read the values back out of the filled PDF — the real round-trip.
  const reopened = await PDFDocument.load(result.bytes)
  const rform = reopened.getForm()
  const readBack = (n: string) => rform.getTextField(n).getText()
  check("agent commission round-trips through the PDF", readBack("Agent Commission $") === "$14,000.00")
  check("split round-trips through the PDF", readBack("Agent Split %") === "70%")
  check("property round-trips through the PDF", readBack("Property Address") === "123 Oak St, Austin, TX")
  check("unrelated field left untouched (empty)", (readBack("Unrelated Field") ?? "") === "")

  console.log("\n[honest: a value targeting a non-existent field is skipped, not invented]")
  const ghost = await fillPdfForm(blankBytes, [{ name: "Does Not Exist", value: "x" }], {})
  check("missing AcroForm field → skipped, never created", ghost.skipped.includes("Does Not Exist") && ghost.filled.length === 0)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CDA_PDF_FILL_FAIL"); process.exit(1) }
  console.log(" ✅ CDA_PDF_FILL_PASS — money is never autofilled; the agent's own entry fills the real CDA PDF and round-trips")
}
main()
