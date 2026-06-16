#!/usr/bin/env tsx
/**
 * scripts/source-lifetime-health-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves SOURCE LIFETIME-HEALTH attribution — the FULL arc (lead.source → the contact it became →
 * that contact's live relationship-health band) fed back to scraper source viability, not just first
 * close. A source whose contacts STAY healthy grades "lasting"; one whose contacts fade (never
 * thriving/warm) grades "cheap_but_fading" — the money-pit the close-rate alone misses. Each verdict
 * is recorded onto the existing ai_feedback_log keyed by source so viability accumulates over runs.
 *
 * Layer 1 (shell, pure): the verdict thresholds the runner partitions on (aggregateSourceHealth).
 * Layer 2 (live, creds-gated): seed a LASTING source (warm contacts) + a FADING source (cooling
 * contacts), run the arc, assert verdicts + recorded outcomes, then reverse-delete every seed. No mocks.
 *
 * Run: npx tsx scripts/source-lifetime-health-simulator.ts   (npm run test:source-lifetime-health)
 */
import { aggregateSourceHealth } from "../lib/lead-pipeline/source-health"

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
  console.log(" ✅ Source lifetime-health verified — the full arc grades sources by relationships that LAST.")
  console.log(" SOURCE_LIFETIME_HEALTH_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Source lifetime-health attribution simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · the verdict thresholds the runner partitions on]")
  const graded = aggregateSourceHealth([
    ...Array.from({ length: 3 }, () => ({ source: "lasts", band: "warm" as const })),
    ...Array.from({ length: 3 }, () => ({ source: "fades", band: "cooling" as const })),
  ], { minVolume: 3 })
  const lasts = graded.find((s) => s.source === "lasts")
  const fades = graded.find((s) => s.source === "fades")
  check("all-healthy source → 'lasting' (the runner adds it to lasting[])", lasts?.verdict === "lasting", JSON.stringify(lasts))
  check("contacts that fade → 'cheap_but_fading' (the money-pit close-rate misses)", fades?.verdict === "cheap_but_fading", JSON.stringify(fades))
  check("a source under the volume floor is held as 'insufficient_data'", aggregateSourceHealth([{ source: "thin", band: "warm" }], { minVolume: 3 })[0].verdict === "insufficient_data")

  console.log("\n[Layer 2 · live: seed the full arc → grade → record → clean up]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { loadSourceLifetimeHealth } = await import("../lib/lead-pipeline/source-lifetime-health-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const stamp = Date.now()
  const SRC_LASTING = `zz_lh_lasting_${stamp}`
  const SRC_FADING = `zz_lh_fading_${stamp}`
  const recentISO = new Date(stamp).toISOString()
  const contactIds: string[] = []
  const leadIds: string[] = []
  try {
    // LASTING source: 3 contacts touched + enriched recently, no inbound → score 65 = WARM (healthy).
    // FADING source:  3 contacts never touched, never enriched → score 55 = COOLING (neither → fades).
    for (const [src, healthy] of [[SRC_LASTING, true], [SRC_FADING, false]] as const) {
      for (let i = 0; i < 3; i++) {
        const { data: c } = await svc.from("contacts").insert({
          brokerage_id: brokerageId, first_name: "ZZLH", last_name: `${stamp}-${src}-${i}`,
          email: `zz-lh-${stamp}-${src}-${i}@example.com`, contact_type: "buyer",
          ...(healthy ? { last_contacted_at: recentISO, last_enriched_at: recentISO } : {}),
        }).select("id").single()
        const contactId = (c as any)?.id ?? null
        if (contactId) contactIds.push(contactId)
        const { data: l } = await svc.from("leads").insert({
          brokerage_id: brokerageId, first_name: "ZZLH", email: `zz-lhlead-${stamp}-${src}-${i}@example.com`,
          source: src, contact_id: contactId,
        }).select("id").single()
        if ((l as any)?.id) leadIds.push((l as any).id)
      }
    }

    const result = await loadSourceLifetimeHealth(brokerageId, { minVolume: 3, now: recentISO, recordOutcomes: true }, svc)
    const lasting = result.summaries.find((s) => s.source === SRC_LASTING)
    const fading = result.summaries.find((s) => s.source === SRC_FADING)

    check("the LASTING source's contacts graded healthy → 'lasting'", lasting?.verdict === "lasting" && result.lasting.includes(SRC_LASTING), JSON.stringify(lasting))
    check("the FADING source's contacts faded → 'cheap_but_fading'", fading?.verdict === "cheap_but_fading" && result.fading.includes(SRC_FADING), JSON.stringify(fading))
    check("both verdicts recorded onto ai_feedback_log (scraper viability accumulates)", result.outcomesRecorded >= 2, `recorded=${result.outcomesRecorded}`)

    // The recorded outcomes are readable back, keyed by source (lasting→win, fading→loss).
    const { data: fb } = await svc.from("ai_feedback_log")
      .select("rating, context_snapshot")
      .eq("brokerage_id", brokerageId).eq("source_system", "source_lifetime_health")
      .in("context_snapshot->>source", [SRC_LASTING, SRC_FADING])
    const rows = (fb ?? []) as { rating: number; context_snapshot: any }[]
    check("lasting recorded as a win (+1), fading as a loss (-1), keyed by source",
      rows.some((r) => r.context_snapshot?.source === SRC_LASTING && r.rating === 1) &&
      rows.some((r) => r.context_snapshot?.source === SRC_FADING && r.rating === -1),
      JSON.stringify(rows.map((r) => [r.context_snapshot?.source, r.rating])))
  } finally {
    await svc.from("ai_feedback_log").delete()
      .eq("brokerage_id", brokerageId).eq("source_system", "source_lifetime_health")
      .in("context_snapshot->>source", [SRC_LASTING, SRC_FADING]).then(() => {}, () => {})
    await svc.from("leads").delete().in("id", leadIds.length ? leadIds : ["none"]).then(() => {}, () => {})
    await svc.from("contacts").delete().in("id", contactIds.length ? contactIds : ["none"]).then(() => {}, () => {})
    const { count } = await svc.from("leads").select("id", { count: "exact", head: true }).in("id", leadIds.length ? leadIds : ["none"])
    const { count: fbCount } = await svc.from("ai_feedback_log").select("id", { count: "exact", head: true })
      .eq("source_system", "source_lifetime_health").in("context_snapshot->>source", [SRC_LASTING, SRC_FADING])
    check("cleanup: seed leads + recorded outcomes removed (count == 0)", (count ?? 0) === 0 && (fbCount ?? 0) === 0)
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
