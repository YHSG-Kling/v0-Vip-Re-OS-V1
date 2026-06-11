#!/usr/bin/env tsx
/**
 * scripts/bidding-war-concierge-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BIDDING-WAR CONCIERGE (buyer-side, vs an OUTSIDE listing agent).
 *
 *   Layer 1 — pure: escalationPlan (ceiling math + cap rationale), strengthenTerms
 *     (term-tightening logic with tradeoffs), inferMarketHeat (competitive detection),
 *     composeEscalationBrief — all deterministic, no creds, no fabrication.
 *   Layer 2 — live (creds-gated): seed OUR buyer + an EXTERNAL listing + a pre-acceptance
 *     competitive offer, run runBiddingWarConcierge with an INJECTED copyGenerator, and
 *     assert the GATED bundle exists: the Shopping Agent escalation brief (audience 'agent'),
 *     the buyer-voice cover-letter DRAFT (audience 'buyer'), the outside-agent note
 *     (audience 'agent'); idempotent; SELF-CLEANS via a unique TAG.
 *
 * Run: npx tsx scripts/bidding-war-concierge-simulator.ts  (npm run test:bidding-war)
 */
import {
  escalationPlan,
  strengthenTerms,
  inferMarketHeat,
  composeEscalationBrief,
  type OfferTermsSnapshot,
} from "../lib/kernel/bidding-war-concierge"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testPure() {
  console.log("\n[Layer 1 · escalation math + term levers + competitive detection]")

  // Market heat detection
  check("escalation clause → hot market", inferMarketHeat({ offerPrice: 500_000, listPrice: 500_000, escalationClause: true }) === "hot")
  check("offer at/above list → hot", inferMarketHeat({ offerPrice: 510_000, listPrice: 500_000, escalationClause: false }) === "hot")
  check("offer just under list → warm", inferMarketHeat({ offerPrice: 488_000, listPrice: 500_000, escalationClause: false }) === "warm")
  check("offer well under list → balanced", inferMarketHeat({ offerPrice: 450_000, listPrice: 500_000, escalationClause: false }) === "balanced")

  // Escalation ceiling
  const hot = escalationPlan(500_000, 500_000, "hot")
  const balanced = escalationPlan(500_000, 500_000, "balanced")
  check("ceiling sits above the anchor", hot.ceiling > 500_000, `ceiling=${hot.ceiling}`)
  check("hotter market → higher ceiling than balanced", hot.ceiling > balanced.ceiling, `hot=${hot.ceiling} balanced=${balanced.ceiling}`)
  check("increment is a meaningful, rounded beat (≥ $1,000)", hot.increment >= 1000 && hot.increment % 500 === 0, `inc=${hot.increment}`)
  check("ceiling rounds to a clean $1,000", hot.ceiling % 1000 === 0)
  check("rationale explains the cap (no chasing past ceiling)", /cap/i.test(hot.rationale) && /ceiling/i.test(hot.rationale))
  check("overListPct computed when list known", hot.overListPct !== null && hot.overListPct > 0)

  // Term levers — only suggest what's actually loose
  const weakOffer: OfferTermsSnapshot = {
    offerPrice: 500_000, earnestMoney: 5_000 /* 1% — low */, financingType: "conventional",
    closingDate: null, inspectionPeriodDays: 14 /* long */, financingContingencyDays: 30 /* long */,
    appraisalContingencyDays: 21, appraisalGap: null, contingencies: ["inspection", "financing", "appraisal"],
  }
  const levers = strengthenTerms(weakOffer)
  const terms = levers.map((l) => l.term)
  check("suggests raising low earnest money", terms.includes("Earnest money"))
  check("suggests shortening long inspection period", terms.includes("Inspection period"))
  check("suggests tightening long financing contingency", terms.includes("Financing contingency"))
  check("suggests an appraisal gap when none offered", terms.includes("Appraisal gap"))
  check("always offers close-timeline / rent-back leverage", terms.includes("Close timeline & rent-back"))
  check("every lever carries a tradeoff note", levers.every((l) => l.tradeoff.length > 10))

  const strongOffer: OfferTermsSnapshot = {
    offerPrice: 500_000, earnestMoney: 25_000 /* 5% */, financingType: "cash",
    closingDate: null, inspectionPeriodDays: 5, financingContingencyDays: null,
    appraisalContingencyDays: null, appraisalGap: 20_000, contingencies: [],
  }
  const strongLevers = strengthenTerms(strongOffer).map((l) => l.term)
  check("does NOT push earnest/financing/appraisal when already strong/cash", !strongLevers.includes("Earnest money") && !strongLevers.includes("Financing contingency") && !strongLevers.includes("Appraisal gap"))

  // Composed brief — Fair-Housing clean, no protected-class steering
  const brief = composeEscalationBrief({
    buyerName: "Dana Kling", propertyAddress: "44 Birch Ln", offer: weakOffer, listPrice: 500_000, marketHeat: "hot",
  })
  check("brief references the property + ceiling + terms", /44 Birch Ln/.test(brief.agentBriefBody) && /ceiling/i.test(brief.agentBriefBody) && /TERMS TO STRENGTHEN/.test(brief.agentBriefBody))
  check("brief is Fair-Housing clean (no steering)", !/perfect for|families|good schools|safe neighborhood|raise our kids/i.test(brief.agentBriefBody))
  const poisoned = composeEscalationBrief({ buyerName: "Dana — perfect for christian families", propertyAddress: null, offer: weakOffer, listPrice: 500_000, marketHeat: "hot" })
  check("poisoned buyer name sanitized in brief", !/perfect for|christian families/i.test(poisoned.agentBriefBody))
}

async function testLive() {
  console.log("\n[Layer 2 · live bidding-war concierge — gated bundle]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure layer ran)."); return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runBiddingWarConcierge } = await import("../lib/kernel/bidding-war-concierge")
  const svc = createServiceClient()
  const TAG = `__bw_${Date.now()}__`

  // Injected copy generator — deterministic, no tokens; tags body so we can prove the seam.
  const copyGenerator = async (req: any) => ({ subject: undefined, body: `${TAG}COPY ${req.goal.slice(0, 40)}` })

  let buyerId: string | null = null
  let listingId: string | null = null
  let offerId: string | null = null
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as { id: string }).id

    // OUR buyer
    const { data: c } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: `${TAG}Buyer`, last_name: "Test", email: `${TAG}b@example.com`, contact_type: "buyer",
    }).select("id").maybeSingle()
    buyerId = (c as { id: string } | null)?.id ?? null
    if (!buyerId) { console.log("  ⏭  contact seed failed — skipped"); return }

    // An EXTERNAL listing: agent_id NULL + a named outside listing agent (not ours).
    const { data: l } = await svc.from("listings").insert({
      brokerage_id: brokerageId, address: `${TAG} 99 Rival Rd`, city: "Austin", list_price: 500_000,
      status: "active", agent_id: null, listing_agent_name: "Outside Agent Pat",
    }).select("id").maybeSingle()
    listingId = (l as { id: string } | null)?.id ?? null
    if (!listingId) { console.log("  ⏭  listing seed failed — skipped"); return }

    // OUR buyer's pre-acceptance competitive offer (escalation clause → hot).
    const { data: o } = await svc.from("offers").insert({
      brokerage_id: brokerageId, contact_id: buyerId, listing_id: listingId,
      offer_price: 505_000, earnest_money: 5_000, financing_type: "conventional",
      inspection_period_days: 14, financing_contingency_days: 30, appraisal_gap: null,
      escalation_clause: true, contingencies: ["inspection", "financing", "appraisal"],
      property_address: `${TAG} 99 Rival Rd`, status: "submitted",
    }).select("id").maybeSingle()
    offerId = (o as { id: string } | null)?.id ?? null
    if (!offerId) { console.log("  ⏭  offer seed failed — skipped"); return }

    const r = await runBiddingWarConcierge(brokerageId, { copyGenerator }, svc)
    check("convenes exactly one bundle for the competitive offer", r.bundles === 1, `bundles=${r.bundles}`)
    check("all three pieces proposed", r.escalationBriefs === 1 && r.coverLetters === 1 && r.outsideAgentNotes === 1, `briefs=${r.escalationBriefs} letters=${r.coverLetters} notes=${r.outsideAgentNotes}`)

    const { data: msgs } = await svc.from("agent_client_messages")
      .select("entity_type, audience, status, agent_kind, recipient_contact_id, body")
      .eq("brokerage_id", brokerageId).eq("entity_id", offerId)
    const rows = (msgs ?? []) as Array<{ entity_type: string; audience: string; status: string; agent_kind: string; recipient_contact_id: string | null; body: string }>

    const brief = rows.find((m) => m.entity_type === "bidding_war_escalation")
    check("escalation brief → audience 'agent', Shopping Agent, proposed", !!brief && brief.audience === "agent" && brief.agent_kind === "shopping_agent" && brief.status === "proposed")

    const letter = rows.find((m) => m.entity_type === "bidding_war_cover_letter")
    check("buyer cover-letter DRAFT → audience 'buyer', recipient is the buyer, proposed", !!letter && letter.audience === "buyer" && letter.recipient_contact_id === buyerId && letter.status === "proposed")

    const note = rows.find((m) => m.entity_type === "bidding_war_outside_agent_note")
    check("outside-agent note → audience 'agent', proposed", !!note && note.audience === "agent" && note.status === "proposed")

    check("copy came through the INJECTED generator seam (no hardcoded body)", rows.every((m) => m.body.startsWith(TAG)))

    // Idempotent — re-run proposes nothing new.
    const r2 = await runBiddingWarConcierge(brokerageId, { copyGenerator }, svc)
    check("concierge bundle is idempotent (one per offer)", r2.bundles === 0, `re-bundles=${r2.bundles}`)
  } finally {
    if (offerId) {
      try { await svc.from("agent_client_messages").delete().eq("entity_id", offerId) } catch {}
      try { await svc.from("manager_signals").delete().eq("entity_id", offerId).eq("signal_type", "bidding_war_convened") } catch {}
      try { await svc.from("offers").delete().eq("id", offerId) } catch {}
    }
    if (listingId) { try { await svc.from("listings").delete().eq("id", listingId) } catch {} }
    if (buyerId) { try { await svc.from("contacts").delete().eq("id", buyerId) } catch {} }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("first_name", `${TAG}%`)
    check("cleanup verified — 0 test contacts remain", (count ?? 0) === 0)
    const { count: lc } = await svc.from("listings").select("id", { count: "exact", head: true }).like("address", `${TAG}%`)
    check("cleanup verified — 0 test listings remain", (lc ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Bidding-War Concierge simulator (buyer-side vs an outside listing)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Bidding-war prep convened + GATED: escalation brief, buyer-voice cover letter, outside-agent note")
}
main().catch((e) => { console.error(e); process.exit(1) })
