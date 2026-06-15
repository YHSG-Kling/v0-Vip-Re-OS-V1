#!/usr/bin/env tsx
/**
 * scripts/deal-killer-radar-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE DEAL-KILLER RADAR — scans a buyer's TARGET property for red flags BEFORE they offer
 * (title/lien, flood zone, comp gap, days-on-market, price cuts, HOA-to-verify). Pure scorer over
 * already-fetched data (no fabrication — missing fields are silent), gated heads-up to the agent.
 *
 * Layer 1 (pure): the red-flag scoring matrix.
 * Layer 2 (live, gated): a high-risk property proposes a GATED agent card; a clean one proposes
 *   nothing. Seeds reverse-deleted. No mocks.
 *
 * Run: npx tsx scripts/deal-killer-radar-simulator.ts   (npm run test:deal-killer)
 */
import { analyzePropertyRisks } from "../lib/property-risk/buyer-target-analyzer"

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
  console.log(" ✅ Deal-killer radar verified — red flags caught before the offer, no fabrication.")
  console.log(" DEAL_KILLER_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Deal-killer radar simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · red-flag scoring]")
  const lien = analyzePropertyRisks({ listPrice: 500000, quickLists: ["notice-of-lis-pendens", "has-hoa"] })
  check("a lien (lis pendens) is CRITICAL", lien.riskLevel === "critical" && lien.signals[0].key === "title_lien")
  check("critical title flag tanks the score", lien.overallScore <= 55)
  check("HOA present is flagged as VERIFY (info, not a red flag)", lien.signals.some(s => s.key === "hoa" && s.severity === "info") && !lien.redFlags.some(f => /HOA/.test(f)))

  const flood = analyzePropertyRisks({ listPrice: 500000, floodZone: "AE" })
  check("FEMA zone AE → high (special flood hazard)", flood.riskLevel === "high" && flood.signals[0].key === "flood_zone")
  check("flood zone X → no flag (not a hazard area)", analyzePropertyRisks({ listPrice: 500000, floodZone: "X" }).redFlags.length === 0)

  const overpriced = analyzePropertyRisks({ listPrice: 600000, compMedian: 500000 })
  check("listed 20% over comps → high appraisal-gap risk", overpriced.signals.some(s => s.key === "comp_gap" && s.severity === "high"))
  check("listed 5% over comps → no comp-gap flag", analyzePropertyRisks({ listPrice: 525000, compMedian: 500000 }).signals.some(s => s.key === "comp_gap") === false)

  const stale = analyzePropertyRisks({ listPrice: 500000, daysOnMarket: 200, priceCutCount: 3 })
  check("200 DOM + 3 price cuts → flagged (negotiation leverage)", stale.redFlags.length >= 2)

  const clean = analyzePropertyRisks({ listPrice: 500000, floodZone: "X", compMedian: 495000, daysOnMarket: 10 })
  check("a clean property → low risk, score 100, no red flags", clean.riskLevel === "low" && clean.overallScore === 100 && clean.redFlags.length === 0)
  check("no fabrication — absent data contributes nothing", analyzePropertyRisks({ listPrice: 500000 }).signals.length === 0)
  check("signals rank worst-first; sources are real", lien.signals[0].severity === "critical" && lien.sources.includes("BatchData"))

  console.log("\n[Layer 2 · live: a high-risk property proposes a gated agent card]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { runDealKillerRadar } = await import("../lib/property-risk/deal-killer-runner")
  const supabase = createServiceClient()
  const stampGen = async (req: { goal: string }) => ({ subject: "ZZGEN", body: `ZZGEN ${req.goal}` })

  const { data: brokerage } = await supabase.from("brokerages").select("id").limit(1).maybeSingle()
  const { data: agent } = brokerage
    ? await supabase.from("agents").select("id").eq("brokerage_id", (brokerage as any).id).limit(1).maybeSingle()
    : { data: null }
  if (!brokerage || !agent) { console.log("  ⏭  Skipped — need a real brokerage + agent."); return report() }
  const brokerageId = (brokerage as any).id
  const stamp = Date.now()
  const { data: contact } = await supabase.from("contacts").insert({
    brokerage_id: brokerageId, agent_id: (agent as any).id, first_name: "ZZKiller", last_name: `Target${stamp}`,
    email: `zz-killer-${stamp}@example.com`, contact_type: "buyer", source: "test",
  }).select("id").single()
  const contactId = (contact as any)?.id

  try {
    const flagged = await runDealKillerRadar({
      brokerageId, contactId, propertyAddress: "12 Risk Lane",
      risk: { listPrice: 600000, compMedian: 500000, floodZone: "AE", quickLists: ["notice-of-default"] },
      copyGenerator: stampGen,
    }, supabase)
    check("high-risk property is flagged + proposes a gated agent card", flagged.flagged === true && flagged.riskLevel === "critical" && !!flagged.proposalId, JSON.stringify({ f: flagged.flagged, r: flagged.riskLevel }).slice(0, 80))
    const { data: prop } = await supabase.from("agent_client_messages").select("status, body").eq("id", flagged.proposalId ?? "none").maybeSingle()
    check("the card is PROPOSED (gated, not sent) + generated copy", (prop as any)?.status === "proposed" && String((prop as any)?.body ?? "").startsWith("ZZGEN"))

    const clean2 = await runDealKillerRadar({
      brokerageId, contactId, propertyAddress: "1 Clean St",
      risk: { listPrice: 500000, compMedian: 498000, floodZone: "X", daysOnMarket: 8 }, copyGenerator: stampGen,
    }, supabase)
    check("a clean property proposes NOTHING (no noise)", clean2.flagged === false && clean2.proposalId === undefined)
  } finally {
    await supabase.from("agent_client_messages").delete().eq("entity_id", contactId).then(() => {}, () => {})
    await supabase.from("contacts").delete().eq("id", contactId)
    const { count } = await supabase.from("contacts").select("id", { count: "exact", head: true }).eq("id", contactId)
    check("cleanup: seed removed (count == 0)", (count ?? 0) === 0)
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
