#!/usr/bin/env tsx
/**
 * scripts/cda-template-fields-simulator.ts   (npm run test:cda-template-fields)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the CDA template field resolver — the AGENT fills the brokerage's OWN CDA form
 * (no autofill of the money): waterfall (commission/split/net) fields are NOT pre-filled,
 * the computed value is kept as the `expected` audit baseline; transaction facts + static
 * template constants still pre-fill; every field is editable; required-empty is flagged;
 * currency/percent/date formatting is applied; display order is respected; and the waterfall
 * context derives gross/net/split/fees from the engine output. Pure: no I/O.
 */
import { resolveCdaTemplateFields, cdaWaterfallContext, type CdaFieldDef } from "../lib/transactions/cda-template-fields"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[waterfall context derivation]")
  const wf = cdaWaterfallContext({
    gross_commission: 20000, agent_net: 14000, brokerage_net: 6000,
    distributions: [{ distribution_type: "fee", calculated_amount: 500 }, { distribution_type: "fee", calculated_amount: 250 }, { distribution_type: "team", calculated_amount: 1000 }],
  })
  check("gross/agent/brokerage carried", wf.gross_commission === 20000 && wf.agent_net === 14000 && wf.brokerage_net === 6000)
  check("split % derived (14000/20000 = 70%)", wf.agent_split_percent === 70)
  check("fees summed across distribution rows (500+250=750)", wf.fees === 750)
  check("team split summed", wf.team_split === 1000)
  check("zero gross → split null (no divide-by-zero)", cdaWaterfallContext({ gross_commission: 0, agent_net: 0 }).agent_split_percent === null)

  console.log("\n[field resolution + formatting]")
  const defs: CdaFieldDef[] = [
    { field_key: "agent_comm", label: "Agent Commission", source: "waterfall", source_key: "agent_net", field_type: "currency", display_order: 2 },
    { field_key: "split", label: "Split %", source: "waterfall", source_key: "agent_split_percent", field_type: "percent", display_order: 3 },
    { field_key: "property", label: "Property", source: "transaction", source_key: "property_address", field_type: "text", display_order: 1 },
    { field_key: "close", label: "Closing Date", source: "transaction", source_key: "close_date", field_type: "date", display_order: 4 },
    { field_key: "notes", label: "Agent Notes", source: "agent_input", field_type: "text", required: true, display_order: 6 },
    { field_key: "brokerage_name", label: "Brokerage", source: "static", static_value: "Acme Realty", field_type: "text", display_order: 5 },
  ]
  const ctx = {
    waterfall: wf,
    transaction: { property_address: "123 Oak St, Austin, TX", close_date: "2026-06-15" },
    agentInputs: {} as Record<string, string>,
  }
  const r = resolveCdaTemplateFields(defs, ctx)
  const get = (k: string) => r.fields.find((f) => f.field_key === k)!

  check("MONEY (waterfall) field is NOT auto-filled — agent must type it in", get("agent_comm").value === null && get("agent_comm").formatted === "")
  check("but its computed value is kept as the EXPECTED audit baseline ($14,000)", get("agent_comm").expected === 14000 && get("agent_comm").expectedFormatted === "$14,000.00")
  check("split (waterfall) also blank, expected baseline 70%", get("split").value === null && get("split").expectedFormatted === "70%")
  check("property (transaction fact) still pre-fills as a convenience", get("property").value === "123 Oak St, Austin, TX")
  check("close date (transaction fact) still pre-fills + formatted", get("close").formatted.includes("2026"))
  check("static template constant still resolved", get("brokerage_name").value === "Acme Realty")
  check("EVERY field is editable (agent fills/confirms before e-sign)", r.fields.every((f) => f.editable))
  check("fields sorted by display_order", r.fields[0].field_key === "property" && r.fields[r.fields.length - 1].field_key === "notes")

  console.log("\n[agent enters the money; the entry is what the CDA carries]")
  const overridden = resolveCdaTemplateFields(defs, { ...ctx, agentInputs: { agent_comm: "$13,500", split: "67.5%", property: "456 Elm St" } })
  const og = (k: string) => overridden.fields.find((f) => f.field_key === k)!
  check("agent-entered commission parsed ($13,500 → 13500) + reformatted", og("agent_comm").value === 13500 && og("agent_comm").formatted === "$13,500.00")
  check("  … expected baseline still $14,000 (so the audit can flag the $500 gap)", og("agent_comm").expected === 14000)
  check("agent-entered split parsed (67.5% → 67.5)", og("split").value === 67.5 && og("split").formatted === "67.5%")
  check("text override replaces the transaction value", og("property").value === "456 Elm St")
  check("un-entered transaction/static fields still pre-fill from the source", og("brokerage_name").value === "Acme Realty")

  console.log("\n[required agent input gating]")
  check("empty required agent input → flagged missing", r.missingRequired.includes("notes"))
  const r2 = resolveCdaTemplateFields(defs, { ...ctx, agentInputs: { notes: "Reviewed and correct" } })
  check("provided required input → not missing + value set", !r2.missingRequired.includes("notes") && r2.fields.find((f) => f.field_key === "notes")!.value === "Reviewed and correct")

  console.log("\n[honest blanks — a money field the agent hasn't filled stays empty, never fabricated]")
  const blank = resolveCdaTemplateFields(
    [{ field_key: "agent_comm", source: "waterfall", source_key: "agent_net", field_type: "currency" }],
    { waterfall: {}, transaction: {}, agentInputs: {} },
  )
  check("no agent entry + no baseline → empty string, value null, expected null", blank.fields[0].value === null && blank.fields[0].formatted === "" && blank.fields[0].expected === null)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CDA_TEMPLATE_FIELDS_FAIL"); process.exit(1) }
  console.log(" ✅ CDA_TEMPLATE_FIELDS_PASS — the agent fills the money in (no autofill); computed value is the audit baseline; facts/static pre-fill")
}
main()
