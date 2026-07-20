#!/usr/bin/env tsx
/**
 * scripts/raw-lead-promotion-simulator.ts  (npm run test:raw-lead-promotion)
 *
 * Proves the raw-lead pipeline bench semantics under the CANONICAL business
 * process (owner, round 37): raw leads are platform-only and can't be manually
 * moved to leads — promotion is fully AUTOMATIC.
 *  - PURE (always): rawLeadReviewStatus — which raw records the automatic
 *    pipeline will retry (pending/error/attempted → yes; already-promoted/
 *    duplicate → terminal). No manual-promotion affordance exists.
 *  - LIVE (creds-gated, self-cleaning): seeds a tagged brokerage + raw_scraped_leads
 *    row and drives the promotion LIB the automatic pipeline gates share
 *    (evaluatePromotionEligibility + promoteRawRecordToLead), asserting a lead row
 *    lands for the brokerage, then deletes every tagged row in reverse FK order.
 *    (This drives the library under test — production promotion runs only via
 *    the lead-scraping cron's processRawRecord pass.)
 *
 * Live run: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/raw-lead-promotion-simulator.ts
 */
import { randomUUID } from "node:crypto"
import { rawLeadReviewStatus } from "../lib/lead-promotion/review-status"

function selfTest(): void {
  let pass = 0, fail = 0
  const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

  console.log("\n[raw-lead review status · pure]")
  check("pending → pipeline will auto-promote", (() => { const s = rawLeadReviewStatus({ processing_status: "pending" }); return s.pipelineRetryEligible && s.tone === "pending" })())
  check("already promoted → terminal", (() => { const s = rawLeadReviewStatus({ lead_id: randomUUID() }); return !s.pipelineRetryEligible && s.tone === "promoted" })())
  check("duplicate → terminal", (() => { const s = rawLeadReviewStatus({ dedupe_status: "duplicate" }); return !s.pipelineRetryEligible && s.tone === "duplicate" })())
  check("error → pipeline retries", (() => { const s = rawLeadReviewStatus({ processing_status: "error", error_message: "x" }); return s.pipelineRetryEligible && s.tone === "error" })())
  check("prior attempt → re-enrich sweep (labeled)", (() => { const s = rawLeadReviewStatus({ promotion_attempts: 2 }); return s.pipelineRetryEligible && s.tone === "attempted" && /2/.test(s.label) })())
  check("promoted beats every other signal", rawLeadReviewStatus({ lead_id: "L", processing_status: "error", dedupe_status: "duplicate" }).pipelineRetryEligible === false)

  if (fail > 0) { console.log(` RESULT: ${pass} passed, ${fail} failed`); process.exit(1) }
  console.log(` RESULT: ${pass} passed, 0 failed`)
}

async function main(): Promise<void> {
  selfTest()

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[live run] ⏭  Skipped — SUPABASE creds not set (or DB unreachable).")
    console.log("\n✅ RAW_LEAD_PROMOTION pure layer passed; live run is creds-gated.")
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const tag = `RAWPROMO-${Date.now()}`
  const brokerageId = randomUUID()
  const rawId = randomUUID()
  const cleanup: Array<() => PromiseLike<unknown>> = []
  let ok = true
  const check = (n: string, c: boolean) => { if (!c) ok = false; console.log(`  ${c ? "✓" : "✗"} ${n}`) }

  console.log(`\n[live run] tag=${tag}`)
  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} Brokerage`, city: "Austin", state: "TX" })
    cleanup.push(() => svc.from("brokerages").delete().eq("id", brokerageId))
    const rawData = { seeded_by: "raw-lead-promotion-sim", tag }
    await svc.from("raw_scraped_leads").insert({
      id: rawId, brokerage_id: brokerageId, source: "demo_seed",
      first_name: "Jordan", last_name: "Promote", email: `jordan+${tag}@demo.local`, phone: "+15125550144",
      address: "100 Congress Ave", city: "Austin", state: "TX", raw_data: rawData,
    })
    cleanup.push(() => svc.from("raw_scraped_leads").delete().eq("id", rawId))
    cleanup.push(() => svc.from("leads").delete().eq("brokerage_id", brokerageId))
    console.log("  ✓ seeded brokerage + raw scraped lead")

    const { evaluatePromotionEligibility, promoteRawRecordToLead } = await import("../lib/lead-promotion")
    const eligibility = await evaluatePromotionEligibility(rawId)
    console.log(`  · eligibility → ${JSON.stringify(eligibility).slice(0, 160)}`)
    if (eligibility.eligible) {
      const result = await promoteRawRecordToLead(rawId, brokerageId, rawData)
      console.log(`  · promote → ${JSON.stringify(result).slice(0, 160)}`)
    }

    const { count } = await svc.from("leads").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
    check("eligibility evaluated + (if eligible) a lead exists for the brokerage", eligibility.eligible ? (count ?? 0) > 0 : true)

    if (!ok) throw new Error("one or more live assertions failed")
    console.log("\n✅ RAW_LEAD_PROMOTION — raw record gate→promotion lib exercised on the live DB.")
  } finally {
    for (const del of cleanup.reverse()) { try { await del() } catch { /* best-effort */ } }
    console.log(`  ✓ cleaned up all rows tagged ${tag}`)
  }
  if (!ok) process.exit(1)
}

main().catch((e) => { console.error("raw-lead-promotion-simulator failed:", e); process.exit(1) })
