#!/usr/bin/env tsx
/**
 * scripts/deal-doc-router-simulator.ts   (npm run test:deal-doc-router)
 * ─────────────────────────────────────────────────────────────────────────────
 * INBOUND DEAL-DOC ROUTER — proves any outside-party deal doc is classified by signals and routed to
 * the manager who OWNS that stage (Listing Concierge for offer/listing side, Deal Coordinator for
 * transaction docs). Offers/counters are auto-ingestable; transaction docs are confirm-first. Pure.
 */
import { classifyDealDoc, routeForDocType } from "../lib/inbound-mail/deal-doc-router"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const cls = (subject: string | null, fileNames: string | null = null, body: string | null = null) =>
  classifyDealDoc({ subject, fileNames, body })

function main() {
  console.log("\n[Classification by signals]")
  check("'Purchase Agreement' → offer", cls("Purchase Agreement attached") === "offer")
  check("'counteroffer' → counteroffer", cls("Seller counteroffer for your buyer") === "counteroffer")
  check("'fully executed contract' → signed_contract", cls("Fully executed contract") === "signed_contract")
  check("'home inspection report' → inspection", cls(null, "home_inspection_report.pdf") === "inspection")
  check("'appraisal report' → appraisal", cls("Appraisal report — 123 Oak") === "appraisal")
  check("'clear to close' → lender", cls("Clear to close issued") === "lender")
  check("'seller disclosure' → disclosure", cls(null, "Sellers_Disclosure_TDS.pdf") === "disclosure")
  check("plain newsletter → unknown", cls("Monthly market update", "flyer.pdf") === "unknown")

  console.log("\n[Specificity — most specific wins over generic 'offer']")
  check("counteroffer (has 'offer') → counteroffer, not offer", cls("Counteroffer to your offer") === "counteroffer")
  check("CTC clear-to-close → lender, not unknown", cls("CTC issued by lender") === "lender")

  console.log("\n[Routing — owning manager + auto-ingest policy]")
  check("offer → Listing Concierge, auto-ingestable", (() => { const r = routeForDocType("offer")!; return r.manager === "listing_concierge" && r.autoIngestable })())
  check("counteroffer → Listing Concierge, auto-ingestable", routeForDocType("counteroffer")!.autoIngestable === true)
  check("signed_contract → Deal Coordinator, NOT auto (confirm-first)", (() => { const r = routeForDocType("signed_contract")!; return r.manager === "deal_coordinator" && r.autoIngestable === false })())
  check("inspection → Deal Coordinator, confirm-first", (() => { const r = routeForDocType("inspection")!; return r.manager === "deal_coordinator" && !r.autoIngestable })())
  check("appraisal → Deal Coordinator", routeForDocType("appraisal")!.manager === "deal_coordinator")
  check("lender → Deal Coordinator", routeForDocType("lender")!.manager === "deal_coordinator")
  check("disclosure → Listing Concierge, confirm-first", (() => { const r = routeForDocType("disclosure")!; return r.manager === "listing_concierge" && !r.autoIngestable })())
  check("unknown → no route (falls through to generic handler)", routeForDocType("unknown") === null)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ DEAL_DOC_ROUTER_FAIL"); process.exit(1) }
  console.log(" ✅ DEAL_DOC_ROUTER_PASS — any inbound deal doc routes to the manager who owns that stage")
}

main()
