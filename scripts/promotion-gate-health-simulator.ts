#!/usr/bin/env tsx
/**
 * scripts/promotion-gate-health-simulator.ts   (npm run test:promotion-gate-health)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves raw records that can NEVER promote are SURFACED, not silently accumulated.
 *
 * The re-enrich sweep retries stranded raws only while promotion_attempts < cap; once
 * a record hits the cap it's dropped forever, and territory_mismatch records are never
 * retried. The Data Steward now reports both to platform staff (once/day, deduped).
 *
 * Layer 1 (pure): isPermanentlyStuck fires only when a record is stranded AND has
 *   exhausted its retries; the sweep cap + stranded vocab are the single source.
 * Layer 2 (live, gated): seed cap-exhausted stranded + territory_mismatch + healthy
 *   raws → reportStuckRawLeads counts them and alerts platform staff → a second pass
 *   is deduped (already alerted today). Reverse-delete; cleanup == 0.
 */
import { randomUUID } from "node:crypto"
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* nothing to shim */ }

import {
  isPermanentlyStuck,
  MAX_PROMOTION_ATTEMPTS,
  STRANDED_STATUSES,
} from "../lib/lead-pipeline/promotion-gate-health"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function pureLayer(): void {
  console.log(`\n[Layer 1 · isPermanentlyStuck — stranded AND attempts >= ${MAX_PROMOTION_ATTEMPTS}]`)
  check("stranded + at cap ⇒ permanently stuck",
    isPermanentlyStuck({ processing_status: "insufficient_identity", promotion_attempts: MAX_PROMOTION_ATTEMPTS }) === true)
  check("stranded + over cap ⇒ permanently stuck",
    isPermanentlyStuck({ processing_status: "insufficient_contact_data", promotion_attempts: MAX_PROMOTION_ATTEMPTS + 5 }) === true)
  check("stranded + below cap ⇒ still retrying (NOT stuck)",
    isPermanentlyStuck({ processing_status: "insufficient_identity", promotion_attempts: MAX_PROMOTION_ATTEMPTS - 1 }) === false)
  check("non-stranded (promoted) at cap ⇒ NOT stuck",
    isPermanentlyStuck({ processing_status: "promoted", promotion_attempts: 99 }) === false)
  check("pending at cap ⇒ NOT stuck (it's in flight, not stranded)",
    isPermanentlyStuck({ processing_status: "pending", promotion_attempts: 99 }) === false)
  check("null attempts ⇒ NOT stuck",
    isPermanentlyStuck({ processing_status: "insufficient_identity", promotion_attempts: null }) === false)
  check("every stranded status is recognised",
    (STRANDED_STATUSES as readonly string[]).every((s) => isPermanentlyStuck({ processing_status: s, promotion_attempts: MAX_PROMOTION_ATTEMPTS })))
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the stuck rule")
    return
  }
  console.log("\n[Layer 2 · live — seed stuck + mismatch + healthy → report → alert platform staff → deduped]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { reportStuckRawLeads } = await import("../lib/lead-pipeline/promotion-gate-health")
  const svc = createServiceClient()
  const tag = `pgh-sim-${randomUUID().slice(0, 8)}`
  const staffId = randomUUID()
  const rawIds: string[] = []
  try {
    await svc.from("users").insert({ id: staffId, email: `${tag}@example.com`, user_type: "superadmin" })

    // 2 cap-exhausted stranded, 1 territory_mismatch, 1 still-retrying, 1 promoted.
    const seed = [
      { processing_status: "insufficient_identity", promotion_attempts: MAX_PROMOTION_ATTEMPTS },
      { processing_status: "insufficient_contact_data", promotion_attempts: MAX_PROMOTION_ATTEMPTS + 2 },
      { processing_status: "territory_mismatch", promotion_attempts: 0 },
      { processing_status: "insufficient_identity", promotion_attempts: MAX_PROMOTION_ATTEMPTS - 1 }, // still retrying
      { processing_status: "promoted", promotion_attempts: 99 },                                       // healthy
    ].map((r) => {
      const id = randomUUID(); rawIds.push(id)
      return { id, source: `${tag}`, raw_data: { tag }, ...r }
    })
    await svc.from("raw_scraped_leads").insert(seed)

    const nowMs = Date.now()
    const r1 = await reportStuckRawLeads(svc, { nowMs })
    check("counts the 2 cap-exhausted stranded records", r1.stuckCount === 2)
    check("counts the 1 territory_mismatch record", r1.territoryMismatchCount === 1)
    check("alerted platform staff (the superadmin)", r1.notified === 1)

    const { data: notif } = await svc.from("notifications").select("type, priority, user_id")
      .eq("type", "raw_leads_stuck").eq("user_id", staffId).maybeSingle()
    check("a raw_leads_stuck notification reached the platform staffer", !!notif && (notif as any).user_id === staffId)

    // Deduped: a second pass the same day does not re-alert.
    const r2 = await reportStuckRawLeads(svc, { nowMs })
    check("a second pass the same day is deduped (no re-alert)", r2.notified === 0 && r2.reason === "already alerted today")
  } finally {
    await svc.from("notifications").delete().eq("user_id", staffId)
    await svc.from("raw_scraped_leads").delete().in("id", rawIds)
    await svc.from("users").delete().eq("id", staffId)
    const { count } = await svc.from("raw_scraped_leads").select("id", { count: "exact", head: true }).in("id", rawIds)
    check("cleanup complete (no test rows remain)", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ PROMOTION_GATE_HEALTH_FAIL"); process.exit(1) }
  console.log(" ✅ PROMOTION_GATE_HEALTH_PASS — permanently-stuck raws reach platform staff (no silent accumulation)")
}

main().catch((e) => { console.error(e); process.exit(1) })
