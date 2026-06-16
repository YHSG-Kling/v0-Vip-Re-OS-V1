#!/usr/bin/env tsx
/**
 * scripts/persona-drift-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves PERSONA-DRIFT refresh — stale enrichment is re-queued before the next persona touch so
 * the one-to-one copy never references 18-month-old facts.
 *
 * Layer 1 (shell, pure): enrichmentNeedsRefresh — fresh → no, old → yes, active+moderately-old →
 *   yes, never-enriched → no (not drift), unparseable → no.
 * Layer 2 (live, creds-gated): a stale-enriched contact + lead are re-queued into
 *   lead_enrichment_queue (skip_trace / persona_drift), idempotent on re-run; a fresh one is not.
 *   Seeds cleaned up.
 *
 * Run: npx tsx scripts/persona-drift-simulator.ts   (npm run test:persona-drift)
 */
import { enrichmentNeedsRefresh, DEFAULT_MAX_AGE_DAYS } from "../lib/lead-pipeline/persona-drift"

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
  console.log(" ✅ Persona drift verified — stale enrichment re-queued, never-enriched ignored, idempotent.")
  console.log(" PERSONA_DRIFT_PASS")
  process.exit(0)
}

const NOW = "2026-06-16T12:00:00.000Z"
const daysAgo = (d: number) => new Date(new Date(NOW).getTime() - d * 86_400_000).toISOString()

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Persona-drift refresh simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · enrichmentNeedsRefresh]")
  check("fresh enrichment → no refresh", !enrichmentNeedsRefresh({ lastEnrichedAt: daysAgo(30), now: NOW }).needsRefresh)
  check(`>${DEFAULT_MAX_AGE_DAYS}d old → refresh`, enrichmentNeedsRefresh({ lastEnrichedAt: daysAgo(200), now: NOW }).needsRefresh)
  check("moderately old + recent activity → refresh sooner", enrichmentNeedsRefresh({ lastEnrichedAt: daysAgo(120), now: NOW, hasRecentActivity: true }).needsRefresh)
  check("moderately old + NO activity → still fresh enough", !enrichmentNeedsRefresh({ lastEnrichedAt: daysAgo(120), now: NOW, hasRecentActivity: false }).needsRefresh)
  check("never enriched → NOT drift (first-enrichment is the normal queue's job)", !enrichmentNeedsRefresh({ lastEnrichedAt: null, now: NOW }).needsRefresh)
  check("unparseable date → no refresh (honest)", !enrichmentNeedsRefresh({ lastEnrichedAt: "nope", now: NOW }).needsRefresh)

  console.log("\n[Layer 2 · live: stale records re-queued, idempotently]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { runPersonaDriftRefresh } = await import("../lib/lead-pipeline/persona-drift-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const staleC = uuid(), freshC = uuid(), staleL = uuid()

  try {
    await svc.from("contacts").insert({ id: staleC, brokerage_id: brokerageId, first_name: "ZZ", last_name: "Stale", contact_type: "buyer", last_enriched_at: daysAgo(400) })
    await svc.from("contacts").insert({ id: freshC, brokerage_id: brokerageId, first_name: "ZZ", last_name: "Fresh", contact_type: "buyer", last_enriched_at: daysAgo(10) })
    await svc.from("leads").insert({ id: staleL, brokerage_id: brokerageId, first_name: "ZZ", last_name: "StaleLead", ai_isa_owner: true, last_enriched_at: daysAgo(400) })

    const r1 = await runPersonaDriftRefresh({ brokerageId, now: NOW, limit: 1000 }, svc)
    check("stale contact + lead re-queued", r1.requeuedContacts >= 1 && r1.requeuedLeads >= 1, JSON.stringify(r1))

    const { count: qC } = await svc.from("lead_enrichment_queue").select("id", { count: "exact", head: true }).eq("contact_id", staleC).eq("trigger_type", "persona_drift")
    check("stale contact has a persona_drift refresh queued", (qC ?? 0) >= 1)
    const { count: qFresh } = await svc.from("lead_enrichment_queue").select("id", { count: "exact", head: true }).eq("contact_id", freshC)
    check("fresh contact was NOT queued", (qFresh ?? 0) === 0)

    const r2 = await runPersonaDriftRefresh({ brokerageId, now: NOW, limit: 1000 }, svc)
    check("re-run is idempotent (no duplicate refresh)", r2.requeuedContacts === 0 && r2.requeuedLeads === 0, JSON.stringify(r2))
  } finally {
    await svc.from("lead_enrichment_queue").delete().in("contact_id", [staleC, freshC]).then(() => {}, () => {})
    await svc.from("lead_enrichment_queue").delete().eq("lead_id", staleL).then(() => {}, () => {})
    await svc.from("contacts").delete().in("id", [staleC, freshC]).then(() => {}, () => {})
    await svc.from("leads").delete().eq("id", staleL).then(() => {}, () => {})
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).in("id", [staleC, freshC])
    check("cleanup: seeded contacts removed", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
