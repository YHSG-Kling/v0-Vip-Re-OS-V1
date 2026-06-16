#!/usr/bin/env tsx
/**
 * scripts/listing-marketing-handoff-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the LISTING MARKETING HANDOFF — when a listing reaches coming-soon or goes live, the
 * Listing Concierge → Campaign Orchestrator marketing handoff is announced on the bus, so the
 * marketing pickup is a VISIBLE coordinated team play (it complements, never re-produces, the
 * kernel-event sequence enrollment).
 *
 * Layer 1 (shell, pure): the stage → handoff decision (coming-soon / live / neither). Layer 2 (live,
 * creds-gated): announce a real handoff → assert the bus signal to campaign_orchestrator → idempotent
 * → clean up.
 *
 * Run: npx tsx scripts/listing-marketing-handoff-simulator.ts   (npm run test:listing-marketing-handoff)
 */
import { marketingHandoffForStage } from "../lib/intelligence/listing-marketing-handoff"

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
  console.log(" ✅ Listing marketing handoff verified — coming-soon/live announce the handoff on the bus.")
  console.log(" LISTING_MARKETING_HANDOFF_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Listing marketing handoff simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · stage → handoff]")
  check("COMING_SOON_ACTIVE → announce coming_soon (teasers)", (() => { const h = marketingHandoffForStage("COMING_SOON_ACTIVE"); return h.announce && h.stage === "coming_soon" && h.play === "coming_soon_teasers" })())
  check("ACTIVE → announce live (just-listed push)", (() => { const h = marketingHandoffForStage("ACTIVE"); return h.announce && h.stage === "live" && h.play === "just_listed_push" })())
  check("MLS_ACTIVE → announce live", marketingHandoffForStage("MLS_ACTIVE").stage === "live")
  check("UNDER_CONTRACT → no handoff", !marketingHandoffForStage("UNDER_CONTRACT").announce)
  check("PRE_LISTING → no handoff", !marketingHandoffForStage("PRE_LISTING").announce)

  console.log("\n[Layer 2 · live: announce the handoff on the bus]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { announceListingMarketingHandoff } = await import("../lib/intelligence/listing-marketing-handoff-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const listingId = uuid()
  try {
    const r = await announceListingMarketingHandoff({ brokerageId, listingId, targetStage: "ACTIVE", propertyAddress: "88 Maple Ave" }, svc)
    check("a marketing handoff was announced (live)", r.announced && r.stage === "live", JSON.stringify(r))

    const { data: sig } = await svc.from("manager_signals")
      .select("to_manager, signal_type, payload").eq("brokerage_id", brokerageId).eq("entity_id", listingId)
      .eq("signal_type", "listing_marketing_ready").maybeSingle()
    check("a handoff signal exists to campaign_orchestrator", (sig as any)?.to_manager === "campaign_orchestrator" && (sig as any)?.payload?.stage === "live", JSON.stringify(sig))

    const again = await announceListingMarketingHandoff({ brokerageId, listingId, targetStage: "ACTIVE", propertyAddress: "88 Maple Ave" }, svc)
    check("re-announcing the same (listing, stage) is idempotent", again.announced === false)

    // A different stage on the same listing CAN announce (coming_soon vs live are distinct handoffs).
    const cs = await announceListingMarketingHandoff({ brokerageId, listingId, targetStage: "COMING_SOON_ACTIVE", propertyAddress: "88 Maple Ave" }, svc)
    check("a distinct stage (coming_soon) announces separately", cs.announced && cs.stage === "coming_soon")
  } finally {
    await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId).eq("entity_id", listingId).eq("signal_type", "listing_marketing_ready").then(() => {}, () => {})
    const { count } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("entity_id", listingId).eq("signal_type", "listing_marketing_ready")
    check("cleanup: handoff signals removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
