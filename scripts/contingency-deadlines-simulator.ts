#!/usr/bin/env tsx
/**
 * scripts/contingency-deadlines-simulator.ts   (npm run test:contingency-deadlines)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the silent-killer fix: an accepted offer's NON-STANDARD contingencies become watched
 * deadlines in the EXISTING transaction_deadlines table (reused, no parallel system), so none passes
 * silently. Standard inspection/financing/appraisal are EXCLUDED (already milestone-tracked → no drift).
 *
 * PURE: normalizeContingencyType (folds spellings; standard/unknown → null) + planContingencyDeadlines
 * (default periods off contract_date, deduped, honest empty without a date).
 * SOURCE: the offer→deal bridge seeds them after back-linking the offer; idempotent dedupe.
 * LIVE (creds-gated): seed a txn + linked offer, ensure, assert only the non-standard deadlines land,
 * second run inserts 0, clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { normalizeContingencyType, planContingencyDeadlines } from "../lib/transactions/contingency-deadlines"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[normalizeContingencyType · pure — fold spellings; standard/unknown → null]")
  check("'home sale' → home_sale", normalizeContingencyType("home sale") === "home_sale")
  check("'Sale of Home' → home_sale", normalizeContingencyType("Sale of Home") === "home_sale")
  check("'HOA Review' → hoa_review", normalizeContingencyType("HOA Review") === "hoa_review")
  check("'Title-Review' → title_review", normalizeContingencyType("Title-Review") === "title_review")
  check("'attorney approval' → attorney_review", normalizeContingencyType("attorney approval") === "attorney_review")
  check("STANDARD 'inspection' → null (milestone-tracked, excluded)", normalizeContingencyType("inspection") === null)
  check("STANDARD 'financing' → null", normalizeContingencyType("financing") === null)
  check("STANDARD 'appraisal' → null", normalizeContingencyType("appraisal") === null)
  check("unknown → null", normalizeContingencyType("unicorn clause") === null)

  console.log("\n[planContingencyDeadlines · pure — default period off the contract date]")
  const plan = planContingencyDeadlines(["home_sale", "inspection", "Title Review", "financing"], "2026-03-01")
  check("only the NON-standard contingencies produce deadlines (2 of 4)", plan.length === 2)
  const home = plan.find((p) => p.deadlineType === "contingency_home_sale")
  const title = plan.find((p) => p.deadlineType === "contingency_title_review")
  check("home-sale deadline = contract + 45d (2026-04-15)", home?.deadlineDate === "2026-04-15")
  check("title-review deadline = contract + 10d (2026-03-11)", title?.deadlineDate === "2026-03-11")
  check("inspection/financing are NOT planned here (no drift with milestones)", !plan.some((p) => /inspection|financing/.test(p.deadlineType)))
  check("no contract date ⇒ [] (honest empty)", planContingencyDeadlines(["home_sale"], null).length === 0)
  check("only standard contingencies ⇒ [] (nothing to add)", planContingencyDeadlines(["inspection", "appraisal"], "2026-03-01").length === 0)
  check("deduped by deadline_type", planContingencyDeadlines(["home_sale", "sale of home"], "2026-03-01").length === 1)
}

function sourceLayer() {
  console.log("\n[wiring — offer→deal bridge seeds them; reuses the existing deadline table]")
  const bridge = src("lib/transactions/offer-bridge.ts")
  check("the offer→deal bridge calls ensureContingencyDeadlines (after back-linking the offer)",
    /transaction_id:\s*transaction\.id[\s\S]*?ensureContingencyDeadlines/.test(bridge))
  const mod = src("lib/transactions/contingency-deadlines.ts")
  check("writes to the EXISTING transaction_deadlines table (no parallel system)", /from\("transaction_deadlines"\)/.test(mod))
  check("idempotent — dedupes by (transaction_id, deadline_type)", /transaction_deadlines[\s\S]*?deadline_type[\s\S]*?have\.has/.test(mod))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by deal_coordinator with a runnable proof", /contingency_deadline_tracking:\s*\{\s*manager:\s*"deal_coordinator",\s*proof:\s*"test:contingency-deadlines"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed txn + linked offer → ensure → assert non-standard deadlines → idempotent → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  const { data: txn } = await svc.from("transactions").select("id, brokerage_id").limit(1).maybeSingle()
  if (!brk || !txn) { console.log("  ⊘ no brokerage/transaction — skipping"); return }
  const brokerageId = (txn as any).brokerage_id, transactionId = (txn as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    // seed a throwaway offer linked to the txn with mixed contingencies + set the txn contract_date.
    await svc.from("transactions").update({ contract_date: "2099-03-01" }).eq("id", transactionId) // sentinel date
    const { data: offer } = await svc.from("offers").insert({
      transaction_id: transactionId, brokerage_id: brokerageId,
      contingencies: ["home_sale", "inspection", "Title Review"], responded_at: new Date().toISOString(),
    }).select("id").single()
    if (offer) cleanup.push({ table: "offers", id: (offer as any).id })

    const { ensureContingencyDeadlines } = await import("../lib/transactions/contingency-deadlines")
    const r1 = await ensureContingencyDeadlines(svc as any, { transactionId, brokerageId })
    check("live: seeded the 2 non-standard contingency deadlines (home-sale + title)", r1.inserted === 2)
    const { data: dls } = await svc.from("transaction_deadlines").select("id, deadline_type").eq("transaction_id", transactionId).in("deadline_type", ["contingency_home_sale", "contingency_title_review"])
    for (const d of dls ?? []) cleanup.push({ table: "transaction_deadlines", id: (d as any).id })
    check("live: both are real transaction_deadlines rows", (dls ?? []).length === 2)
    const r2 = await ensureContingencyDeadlines(svc as any, { transactionId, brokerageId })
    check("live: idempotent — second run inserts 0", r2.inserted === 0)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    await svc.from("transactions").update({ contract_date: null }).eq("id", transactionId).eq("contract_date", "2099-03-01")
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CONTINGENCY_DEADLINES_FAIL"); process.exit(1) }
  console.log(" ✅ CONTINGENCY_DEADLINES_PASS — non-standard contingencies become watched deadlines; standard ones excluded (no drift)")
}
main()
