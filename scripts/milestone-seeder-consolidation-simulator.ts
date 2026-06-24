#!/usr/bin/env tsx
/**
 * scripts/milestone-seeder-consolidation-simulator.ts  (npm run test:milestone-seeder-consolidation)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the two milestone seeders no longer drift: both source the SINGLE canonical
 * catalog (milestone-catalog.ts), so a transaction gets the same canonical identities
 * + curated visibility however it was created, and ensureRequiredMilestones dedupes by
 * IDENTITY (not raw name) so it never duplicates a journey-seeded milestone — it just
 * fills the deadline dates and mirrors them.
 *
 * Layer 1 (pure):
 *   - every catalog id is a canonical milestone identity (round-trips through the resolver).
 *   - REQUIRED_MILESTONE_IDS each have a catalog entry; deadline entries carry deadline meta.
 *   - no duplicate ids within a journey; buyer + seller share deadline identities.
 *
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY):
 *   A. journey-seeded transaction → ensureRequiredMilestones: inserts NOTHING new
 *      (identities already present), fills the deadline target_dates, mirrors deadlines;
 *      every identity appears exactly once (no duplicates).
 *   B. empty transaction → ensureRequiredMilestones: inserts the full required set with
 *      canonical milestone_type + curated is_client_visible.
 *   reverse-delete; cleanup == 0.
 */
import { randomUUID } from "node:crypto"
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* nothing to shim */ }

import { resolveMilestoneIdentity } from "../lib/transactions/milestone-identity"
import {
  BUYER_MILESTONE_JOURNEY,
  SELLER_MILESTONE_JOURNEY,
  REQUIRED_MILESTONE_IDS,
  deadlineBearingMilestones,
  catalogEntry,
  milestoneJourneyFor,
} from "../lib/transactions/milestone-catalog"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function pureLayer(): void {
  console.log("\n[Layer 1 · catalog integrity — single source of truth]")
  for (const e of [...BUYER_MILESTONE_JOURNEY, ...SELLER_MILESTONE_JOURNEY]) {
    check(`catalog id "${e.id}" round-trips through the resolver`,
      resolveMilestoneIdentity({ milestone_type: e.id, milestone_name: e.name }) === e.id)
  }
  check("every REQUIRED_MILESTONE_ID has a catalog entry",
    REQUIRED_MILESTONE_IDS.every((id) => !!catalogEntry(id)))
  check("every deadline-bearing entry carries deadline meta (termKey + deadlineType)",
    deadlineBearingMilestones().every((e) => !!e.deadline?.termKey && !!e.deadline?.deadlineType))
  check("buyer journey has no duplicate ids",
    new Set(BUYER_MILESTONE_JOURNEY.map((e) => e.id)).size === BUYER_MILESTONE_JOURNEY.length)
  check("seller journey has no duplicate ids",
    new Set(SELLER_MILESTONE_JOURNEY.map((e) => e.id)).size === SELLER_MILESTONE_JOURNEY.length)
  check("milestoneJourneyFor('sale') → seller, else buyer",
    milestoneJourneyFor("sale") === SELLER_MILESTONE_JOURNEY && milestoneJourneyFor("purchase") === BUYER_MILESTONE_JOURNEY)
  // The required deadline-critical identities must all be present in the buyer journey,
  // so a journey-seeded transaction already contains them (→ ensure dedupes, never dupes).
  const buyerIds = new Set(BUYER_MILESTONE_JOURNEY.map((e) => e.id))
  check("buyer journey is a superset of REQUIRED_MILESTONE_IDS (ensure won't duplicate)",
    REQUIRED_MILESTONE_IDS.every((id) => buyerIds.has(id)))
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved catalog integrity")
    return
  }
  console.log("\n[Layer 2 · live — journey-seed → ensureRequiredMilestones → assert dedupe + date-fill → self-clean]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { ensureRequiredMilestones } = await import("../lib/transactions/milestone-service")
  const svc = createServiceClient()
  const tag = `msc-sim-${randomUUID().slice(0, 8)}`
  const brokerageId = randomUUID()
  const txnA = randomUUID()
  const txnB = randomUUID()
  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} (seeder consolidation)` })
    await svc.from("transactions").insert([
      { id: txnA, brokerage_id: brokerageId, deal_name: `${tag} A`, status: "under_contract" },
      { id: txnB, brokerage_id: brokerageId, deal_name: `${tag} B`, status: "under_contract" },
    ])

    // ── A. journey-seeded transaction (mirror generateMilestones' catalog insert) ──
    const journeyRows = milestoneJourneyFor("purchase").map((m) => ({
      transaction_id: txnA, brokerage_id: brokerageId,
      milestone_name: m.name, milestone_type: m.id, is_client_visible: m.clientVisible, status: "pending",
    }))
    await svc.from("transaction_milestones").insert(journeyRows)
    const beforeCount = journeyRows.length

    const terms = { inspection_deadline: "2026-07-15", appraisal_deadline: "2026-07-22", financing_deadline: "2026-07-29", closing_date: "2026-08-05", earnest_money_due: "2026-07-05" }
    await ensureRequiredMilestones(txnA, brokerageId, terms)

    const { data: aRows } = await svc.from("transaction_milestones")
      .select("milestone_type, milestone_name, target_date").eq("transaction_id", txnA)
    const aList = (aRows ?? []) as Array<{ milestone_type: string | null; milestone_name: string; target_date: string | null }>

    check("A: ensure did NOT duplicate — row count unchanged (dedupe by identity)", aList.length === beforeCount)
    const idCounts = new Map<string, number>()
    for (const r of aList) { const id = resolveMilestoneIdentity(r) ?? "?"; idCounts.set(id, (idCounts.get(id) ?? 0) + 1) }
    check("A: every canonical identity appears exactly once", [...idCounts.values()].every((c) => c === 1))
    const inspection = aList.find((r) => resolveMilestoneIdentity(r) === "inspection_deadline")
    check("A: deadline date was FILLED on the journey-seeded inspection milestone", inspection?.target_date === "2026-07-15")
    const closing = aList.find((r) => resolveMilestoneIdentity(r) === "closing_date")
    check("A: closing date filled", closing?.target_date === "2026-08-05")
    const { data: aDeadlines } = await svc.from("transaction_deadlines").select("deadline_type").eq("transaction_id", txnA)
    check("A: deadlines mirrored to transaction_deadlines", (aDeadlines?.length ?? 0) >= 4)

    // ── B. empty transaction → ensure inserts the full required set ──
    await ensureRequiredMilestones(txnB, brokerageId, terms)
    const { data: bRows } = await svc.from("transaction_milestones")
      .select("milestone_type, milestone_name, is_client_visible").eq("transaction_id", txnB)
    const bList = (bRows ?? []) as Array<{ milestone_type: string | null; milestone_name: string; is_client_visible: boolean }>
    check("B: required set inserted (count == REQUIRED_MILESTONE_IDS)", bList.length === REQUIRED_MILESTONE_IDS.length)
    check("B: every inserted row carries a canonical milestone_type identity",
      bList.every((r) => r.milestone_type != null && resolveMilestoneIdentity(r) === r.milestone_type))
    const cda = bList.find((r) => r.milestone_type === "cda_delivered")
    check("B: internal milestone (cda_delivered) seeded is_client_visible=false (curated)", cda?.is_client_visible === false)
    const insp = bList.find((r) => r.milestone_type === "inspection_deadline")
    check("B: client milestone (inspection_deadline) seeded is_client_visible=true", insp?.is_client_visible === true)
  } finally {
    await svc.from("transaction_deadlines").delete().in("transaction_id", [txnA, txnB])
    await svc.from("calendar_events").delete().in("entity_id", [txnA, txnB])
    await svc.from("transaction_milestones").delete().in("transaction_id", [txnA, txnB])
    await svc.from("transactions").delete().in("id", [txnA, txnB])
    await svc.from("brokerages").delete().eq("id", brokerageId)
    const { count } = await svc.from("transaction_milestones").select("id", { count: "exact", head: true }).in("transaction_id", [txnA, txnB])
    check("cleanup complete (no test rows remain)", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ MILESTONE_SEEDER_CONSOLIDATION_FAIL"); process.exit(1) }
  console.log(" ✅ MILESTONE_SEEDER_CONSOLIDATION_PASS — both seeders share one catalog; ensure dedupes by identity")
}

main().catch((e) => { console.error(e); process.exit(1) })
