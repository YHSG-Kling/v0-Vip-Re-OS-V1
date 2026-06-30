#!/usr/bin/env tsx
/**
 * scripts/cda-field-classifier-simulator.ts   (npm run test:cda-field-classifier)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the CDA field AUTO-BINDING classifier — the autonomous-AI step that turns a
 * brokerage's uploaded CDA PDF AcroForm field names into SUGGESTED source bindings the
 * broker confirms. Pure: tests the deterministic heuristic floor (suggestCdaFieldBindings)
 * + the catalog validator (isValidBinding). No network, no AI key needed: the floor is
 * what the broker always gets when the AI layer is unavailable.
 *
 * Asserts: commission/net/split/fee/team/rev-share map to the right WATERFALL keys;
 * property/closing-date/price map to TRANSACTION keys; unknown labels fall back to
 * agent_input (never fabricated); field_type follows the catalog; field_keys are unique;
 * every suggested binding is catalog-valid (no hallucinated source_key).
 */
import {
  suggestCdaFieldBindings,
  isValidBinding,
  CDA_WATERFALL_KEYS,
  CDA_TRANSACTION_KEYS,
} from "../lib/transactions/cda-field-classifier"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  // A realistic mix of AcroForm field names from different brokerage CDA forms.
  const names = [
    "Agent Commission $",
    "Brokerage Commission Amount",
    "Total Gross Commission",
    "Agent Split %",
    "Franchise Fee",
    "Team Split",
    "Revenue Share",
    "Subject Property Address",
    "Closing Date",
    "Sales Price",
    "Special Instructions",     // → agent_input text
    "Wire Routing Number",      // → agent_input text
    "Bonus Amount",             // → agent_input currency (has 'amount')
  ]
  const s = suggestCdaFieldBindings(names)
  const by = (pdf: string) => s.find((b) => b.pdf_field === pdf)!

  console.log("\n[waterfall bindings]")
  check("Agent Commission $ → waterfall.agent_net (currency)", by("Agent Commission $").source === "waterfall" && by("Agent Commission $").source_key === "agent_net" && by("Agent Commission $").field_type === "currency")
  check("Brokerage Commission Amount → waterfall.brokerage_net", by("Brokerage Commission Amount").source_key === "brokerage_net")
  check("Total Gross Commission → waterfall.gross_commission", by("Total Gross Commission").source_key === "gross_commission")
  check("Agent Split % → waterfall.agent_split_percent (percent)", by("Agent Split %").source_key === "agent_split_percent" && by("Agent Split %").field_type === "percent")
  check("Franchise Fee → waterfall.fees", by("Franchise Fee").source_key === "fees")
  check("Team Split → waterfall.team_split", by("Team Split").source_key === "team_split")
  check("Revenue Share → waterfall.revenue_share", by("Revenue Share").source_key === "revenue_share")

  console.log("\n[transaction bindings]")
  check("Subject Property Address → transaction.property_address (text)", by("Subject Property Address").source === "transaction" && by("Subject Property Address").source_key === "property_address" && by("Subject Property Address").field_type === "text")
  check("Closing Date → transaction.close_date (date)", by("Closing Date").source_key === "close_date" && by("Closing Date").field_type === "date")
  check("Sales Price → transaction.sale_price (currency)", by("Sales Price").source_key === "sale_price" && by("Sales Price").field_type === "currency")

  console.log("\n[agent_input fallback — unknown labels are NOT fabricated]")
  check("Special Instructions → agent_input text", by("Special Instructions").source === "agent_input" && by("Special Instructions").field_type === "text")
  check("Wire Routing Number → agent_input text (no money word)", by("Wire Routing Number").source === "agent_input" && by("Wire Routing Number").field_type === "text")
  check("Bonus Amount → agent_input currency ('amount' hint)", by("Bonus Amount").source === "agent_input" && by("Bonus Amount").field_type === "currency")

  console.log("\n[invariants]")
  check("every binding is catalog-valid (no hallucinated source_key)", s.every((b) => isValidBinding(b.source, b.source_key)))
  check("waterfall/transaction bindings carry a real catalog key", s.filter((b) => b.source === "waterfall").every((b) => (b.source_key ?? "") in CDA_WATERFALL_KEYS) && s.filter((b) => b.source === "transaction").every((b) => (b.source_key ?? "") in CDA_TRANSACTION_KEYS))
  check("agent_input/static bindings have null source_key", s.filter((b) => b.source === "agent_input" || b.source === "static").every((b) => b.source_key === null))
  check("field_keys are unique", new Set(s.map((b) => b.field_key)).size === s.length)
  check("display_order preserves PDF order", s.every((b, i) => b.display_order === i))
  check("waterfall field_type follows the catalog", s.filter((b) => b.source === "waterfall").every((b) => b.field_type === CDA_WATERFALL_KEYS[b.source_key!].field_type))

  console.log("\n[collision handling — duplicate labels get unique keys]")
  const dup = suggestCdaFieldBindings(["Notes", "Notes", "Notes"])
  check("3 identical labels → 3 unique field_keys", new Set(dup.map((b) => b.field_key)).size === 3)

  console.log("\n[empty / honest]")
  check("no fields → empty suggestions", suggestCdaFieldBindings([]).length === 0)
  check("transaction catalog non-empty", Object.keys(CDA_TRANSACTION_KEYS).length === 3)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CDA_FIELD_CLASSIFIER_FAIL"); process.exit(1) }
  console.log(" ✅ CDA_FIELD_CLASSIFIER_PASS — uploaded CDA PDF fields auto-bind to the waterfall, broker confirms")
}
main()
