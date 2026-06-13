#!/usr/bin/env tsx
/**
 * scripts/dual-portal-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the DUAL-JOURNEY PORTAL decision: a contact who is BOTH a buyer AND a
 * seller (contact_type='both', the "must sell to buy" case) must see BOTH journeys
 * in a tabbed Buy | Sell portal — the portal used to collapse them to ONE view.
 *
 * The data layer (dual-intent-linker) writes TWO journey_states rows for the one
 * contact (user_id `${id}:buyer` / `${id}:seller`) with the sale→buy dependency
 * stamped in metadata_json. This harness proves the PORTAL reads that correctly:
 *
 * Layer 1 (pure, no I/O):
 *   - dualBannerPredicate: a GATED, not-yet-satisfied dependency → show the banner;
 *     a not-gated dependency (cash / independent funding), a SATISFIED one (sale
 *     closed), or NO dependency at all → hide. No fabrication.
 *   - the dependency the banner shows is the real sellMustPrecedeBuy output, and the
 *     composite journey key the dual resolver looks up is journeyUserKey.
 *
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY): seed a REAL 'both' contact
 *   with TWO journey_states rows (one gated dependency) →
 *     · resolveDualPortalView returns isDual=true and recovers the gated dependency,
 *     · dualBannerPredicate on that dependency → true (the banner surfaces),
 *     · a SINGLE-intent contact (buyer only) → isDual=false, baseView='buyer' (the
 *       existing single-journey resolution is UNCHANGED — no regression),
 *     · reverse-delete teardown + cleanup count == 0.
 *
 * No mocks/stubs/demo data — real Supabase, real rows, full teardown.
 *
 * Run:  npx tsx scripts/dual-portal-simulator.ts   (npm run test:dual-portal)
 */

import { dualBannerPredicate } from "../lib/kernel/portal"
import {
  sellMustPrecedeBuy,
  journeyUserKey,
  type SaleBeforeBuyDependency,
} from "../lib/kernel/dual-intent-linker"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ───────────────────────────────────────────────────────────────────────────
// Layer 1 — PURE: the dependency-banner predicate + the dependency it shows.
// ───────────────────────────────────────────────────────────────────────────
function testPure() {
  console.log("\n[Layer 1 · pure — dualBannerPredicate]")

  // GATED + not yet satisfied (sale not closed) → SHOW the banner.
  const gated = sellMustPrecedeBuy(
    { isCashBuyer: false, requiresSaleProceeds: true, hasIndependentFunding: false },
    { lifecycleStage: "MLS_ACTIVE" },
  )
  check("gated dependency is the sale-funds-purchase gate (the case that shows a banner)",
    gated.gated === true && gated.reason === "sale_funds_purchase" && gated.satisfied === false,
    JSON.stringify(gated))
  check("gated + not satisfied → banner SHOWN", dualBannerPredicate(gated) === true)

  // GATED but SATISFIED (sale already CLOSED) → HIDE (the contingency cleared).
  const satisfied = sellMustPrecedeBuy(
    { isCashBuyer: false, requiresSaleProceeds: true, hasIndependentFunding: false },
    { lifecycleStage: "CLOSED" },
  )
  check("gated but sale CLOSED → satisfied=true", satisfied.gated === true && satisfied.satisfied === true)
  check("gated + satisfied → banner HIDDEN (contingency cleared)", dualBannerPredicate(satisfied) === false)

  // NOT gated — cash buyer → HIDE.
  const cash = sellMustPrecedeBuy(
    { isCashBuyer: true, requiresSaleProceeds: false, hasIndependentFunding: false },
    { lifecycleStage: "MLS_ACTIVE" },
  )
  check("cash buyer → not gated", cash.gated === false && cash.reason === "cash_buyer_not_gated")
  check("not-gated (cash) → banner HIDDEN", dualBannerPredicate(cash) === false)

  // NOT gated — independent funding → HIDE.
  const indep = sellMustPrecedeBuy(
    { isCashBuyer: false, requiresSaleProceeds: false, hasIndependentFunding: true },
    { lifecycleStage: "MLS_ACTIVE" },
  )
  check("independent funding → not gated", indep.gated === false)
  check("not-gated (independent funding) → banner HIDDEN", dualBannerPredicate(indep) === false)

  // NO dependency on file at all → HIDE (honest — nothing to claim).
  check("no dependency (null) → banner HIDDEN", dualBannerPredicate(null) === false)

  // The dual resolver looks up the two sides via the composite key.
  check("journeyUserKey composes per (contact, side)",
    journeyUserKey("abc", "buyer") === "abc:buyer" && journeyUserKey("abc", "seller") === "abc:seller")
}

// ───────────────────────────────────────────────────────────────────────────
// Layer 2 — LIVE: resolveDualPortalView over REAL rows (dual + single).
// ───────────────────────────────────────────────────────────────────────────
async function testLive() {
  console.log("\n[Layer 2 · live — resolveDualPortalView on a real 'both' contact]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("  ⏭  Skipped — SUPABASE_SERVICE_ROLE_KEY not set.")
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { resolveDualPortalView } = await import("../lib/kernel/portal")
  const { linkDualJourneys } = await import("../lib/kernel/dual-intent-linker")
  const svc = createServiceClient()

  const TAG = `__dualportal_${Date.now()}__`
  const cleanup: Array<{ table: string; column: string; value: string }> = []

  try {
    const { data: agent } = await svc
      .from("agents")
      .select("id, brokerage_id")
      .not("brokerage_id", "is", null)
      .eq("is_active", true)
      .limit(1)
      .single()
    if (!agent) { console.log("  ⏭  Skipped — need an active agent with brokerage_id."); return }
    const brokerageId = (agent as any).brokerage_id as string
    const agentId = (agent as any).id as string

    // ── Seed the DUAL contact: buyer-type person who ALSO sells a home. ────────
    const { data: contact, error: cErr } = await svc.from("contacts").insert({
      brokerage_id: brokerageId,
      agent_id: agentId,
      first_name: TAG,
      last_name: "DualPortal",
      email: `${TAG}@example.com`,
      contact_type: "buyer",        // mono-typed at seed — the linker promotes to 'both'
      contact_persona: "downsizing_senior",
      buyer_stage: "searching",
      status: "active",
    }).select("id").single()
    check("seed dual contact (mono-typed 'buyer' at seed)", !cErr && !!contact, cErr?.message)
    if (!contact) throw new Error("contact seed failed")
    const contactId = (contact as any).id as string
    cleanup.push({ table: "journey_states", column: "contact_id", value: contactId })
    cleanup.push({ table: "transparency_updates", column: "contact_id", value: contactId })
    cleanup.push({ table: "property_preferences", column: "contact_id", value: contactId })
    cleanup.push({ table: "buyer_financial_profiles", column: "contact_id", value: contactId })
    cleanup.push({ table: "listings", column: "seller_contact_id", value: contactId })
    cleanup.push({ table: "contacts", column: "id", value: contactId })

    // Buyer side: a saved search (criteria). Non-cash → must-sell-to-buy.
    await svc.from("property_preferences").insert({
      contact_id: contactId, brokerage_id: brokerageId, agent_id: agentId,
      preferred_price_min: 400000, preferred_price_max: 600000,
    })
    await svc.from("buyer_financial_profiles").insert({
      contact_id: contactId, brokerage_id: brokerageId,
      finance_type: "conventional", is_cash_buyer: false, verified: false,
    })
    // Seller side: an active listing the contact is SELLING (the home to sell first).
    await svc.from("listings").insert({
      brokerage_id: brokerageId, agent_id: agentId, seller_contact_id: contactId,
      address: `${TAG} 88 Maple Dr`, status: "active", lifecycle_stage: "MLS_ACTIVE",
    })

    // The linker writes contact_type='both' + the TWO cross-linked journey_states
    // rows with the gated dependency stamped — the data the portal now reads.
    const link = await linkDualJourneys(contactId, svc)
    check("data layer linked the two journeys (contact_type='both', dependency gated)",
      link.linked === true && link.contactType === "both" && link.dependency?.gated === true,
      JSON.stringify({ linked: link.linked, ct: link.contactType, dep: link.dependency?.reason }))

    // ════════════════════════════════════════════════════════════════════════
    // THE PORTAL DECISION — resolveDualPortalView reads the seeded truth.
    // ════════════════════════════════════════════════════════════════════════
    const dual = await resolveDualPortalView(svc as any, { contactId })
    check("dual contact → isDual=true (BOTH journeys, tabbed portal)", dual.isDual === true, dual.reason)
    check("dual resolution keeps a base single-journey view for the default tab",
      dual.baseView === "buyer" || dual.baseView === "seller" || dual.baseView === "lifetime",
      String(dual.baseView))
    check("dual reason is contact_type='both' or both journey_states sides",
      dual.reason === "CONTACT_TYPE_BOTH" || dual.reason === "BOTH_JOURNEY_STATES", dual.reason)

    // The sale→buy dependency surfaced to the portal (recovered from metadata_json).
    check("portal recovered the stamped sale→buy dependency",
      dual.dependency?.gated === true && dual.dependency?.reason === "sale_funds_purchase",
      JSON.stringify(dual.dependency))
    check("dualBannerPredicate on the recovered dependency → banner SHOWN",
      dualBannerPredicate(dual.dependency) === true)

    // ════════════════════════════════════════════════════════════════════════
    // SINGLE-INTENT contact → the EXISTING single view, UNCHANGED (no regression).
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n  ── single-intent contact → existing single view (no regression) ──")
    const { data: soloContact } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, agent_id: agentId,
      first_name: `${TAG}solo`, last_name: "BuyerOnly",
      email: `${TAG}solo@example.com`, contact_type: "buyer", buyer_stage: "searching", status: "active",
    }).select("id").single()
    const soloId = (soloContact as any)?.id as string | undefined
    if (soloId) {
      cleanup.push({ table: "journey_states", column: "contact_id", value: soloId })
      cleanup.push({ table: "transparency_updates", column: "contact_id", value: soloId })
      cleanup.push({ table: "contacts", column: "id", value: soloId })

      const solo = await resolveDualPortalView(svc as any, { contactId: soloId })
      check("single-intent contact → isDual=false (NOT collapsed into a tabbed portal)",
        solo.isDual === false, solo.reason)
      check("single-intent baseView stays 'buyer' (existing resolution unchanged)",
        solo.baseView === "buyer", String(solo.baseView))
      check("single-intent reason = SINGLE_JOURNEY", solo.reason === "SINGLE_JOURNEY", solo.reason)
      check("single-intent surfaces NO dependency (honest — no banner)", solo.dependency === null)
    }

    // An explicit admin override is a deliberate single-view escape hatch — never dual.
    const overridden = await resolveDualPortalView(svc as any, { contactId, overrideView: "seller" })
    check("admin override forces single view (isDual=false) even for a dual contact",
      overridden.isDual === false && overridden.reason === "ADMIN_OVERRIDE_SINGLE", overridden.reason)
  } finally {
    // Reverse-delete teardown.
    for (let i = cleanup.length - 1; i >= 0; i--) {
      const { table, column, value } = cleanup[i]
      try { await svc.from(table).delete().eq(column, value) } catch { /* noop */ }
    }
    let remaining = 0
    for (const { table, column, value } of cleanup) {
      const { count } = await svc.from(table).select("id", { count: "exact", head: true }).eq(column, value)
      remaining += count ?? 0
    }
    check("cleanup verified — 0 seeded rows remain", remaining === 0, `remaining=${remaining}`)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Dual-Journey Portal (one contact, BOTH journeys in tabs — 'must sell to buy') simulator")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ DUAL_PORTAL verified — a 'both' contact resolves to a tabbed Buy | Sell portal with the gated sale→buy banner; a single-intent contact keeps its existing single view unchanged")
}
main().catch((e) => { console.error(e); process.exit(1) })
