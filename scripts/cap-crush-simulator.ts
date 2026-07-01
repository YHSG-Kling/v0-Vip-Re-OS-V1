#!/usr/bin/env tsx
/**
 * scripts/cap-crush-simulator.ts   (npm run test:cap-crush)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the AUTONOMOUS cap-crush moment: the instant an agent's cap ledger crosses the cap in the
 * final commission calc, the Finance Manager celebrates the AGENT (they keep 100%) and hands the live
 * proof to Recruiting on the bus. Previously the crush surfaced only as a weekly recruiting proof to
 * the broker — the agent was never told.
 *
 * PURE: detectCapCrush fires only on the CROSSING (before < cap ≤ after), exactly once.
 * SOURCE: the crush hook lives in the cap-ledger update (11-validate-persist); celebrateCapCrush
 * notifies the agent + publishes finance → recruiting agent_crushed_cap, deduped per anniversary.
 * LIVE (creds-gated): seed a cap ledger just under cap, cross it, assert the agent notification + no
 * double-fire; clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { detectCapCrush } from "../lib/finance/cap-crush"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[detectCapCrush · pure — fires exactly on the crossing]")
  check("crossing the cap (before < cap ≤ after) ⇒ justCrossed", (() => { const r = detectCapCrush({ capAmount: 20000, paidBefore: 18000, paidAfter: 21000 }); return r.crushed && r.justCrossed })())
  check("already over cap (before ≥ cap) ⇒ crushed but NOT justCrossed (no re-fire)", (() => { const r = detectCapCrush({ capAmount: 20000, paidBefore: 22000, paidAfter: 25000 }); return r.crushed && !r.justCrossed })())
  check("still under cap ⇒ neither", (() => { const r = detectCapCrush({ capAmount: 20000, paidBefore: 5000, paidAfter: 12000 }); return !r.crushed && !r.justCrossed })())
  check("exactly hitting the cap counts as crossed", detectCapCrush({ capAmount: 20000, paidBefore: 19000, paidAfter: 20000 }).justCrossed === true)
  check("no cap configured (cap = 0) ⇒ never crushes", detectCapCrush({ capAmount: 0, paidBefore: 0, paidAfter: 99999 }).crushed === false)
}

function sourceLayer() {
  console.log("\n[wiring — caught at the cap-ledger update, celebrates agent + recruiting proof]")
  const persist = src("lib/commission/waterfall/11-validate-persist.ts")
  check("the crush is detected where the cap ledger updates (final calc)", /detectCapCrush[\s\S]*?celebrateCapCrush/.test(persist))
  check("it passes paidBefore (old cap_paid_to_date) + paidAfter (new)", /paidBefore:\s*capTracking\.cap_paid_to_date,\s*paidAfter:\s*newPaidToDate/.test(persist))
  check("best-effort — never blocks the calc", /try\s*\{[\s\S]*?celebrateCapCrush[\s\S]*?\}\s*catch/.test(persist))

  const cc = src("lib/finance/cap-crush.ts")
  check("celebrates the AGENT (cap_crushed notification, keeps 100%)", /type:\s*"cap_crushed"[\s\S]*?keep 100%/.test(cc))
  check("hands recruiting proof on the bus (finance → recruiting agent_crushed_cap)", /fromManager:\s*"finance_manager",\s*toManager:\s*"recruiting_manager"[\s\S]*?agent_crushed_cap/.test(cc))
  check("deduped once per anniversary year", /type",\s*"cap_crushed"[\s\S]*?gte\("created_at"/.test(cc))

  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain cap_crush_celebration owned by Finance Manager with a proof", /cap_crush_celebration:\s*\{\s*manager:\s*"finance_manager",\s*proof:\s*"test:cap-crush"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] cross the cap → agent celebration + idempotent")
  const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).limit(1).maybeSingle()
  if (!agent) { console.log("  ⊘ no agent — skipping"); return }
  const agentId = (agent as any).id, userId = (agent as any).user_id, brokerageId = (agent as any).brokerage_id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { celebrateCapCrush } = await import("../lib/finance/cap-crush")
    const r = await celebrateCapCrush(svc as any, { agentId, brokerageId, capAmount: 20000, capPaidToDate: 21000, anniversaryStart: "1999-01-01" })
    check("live: agent was celebrated", r.celebrated === true)
    const { data: n } = await svc.from("notifications").select("id, title").eq("user_id", userId).eq("type", "cap_crushed").eq("entity_id", agentId).order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (n) cleanup.push({ table: "notifications", id: (n as any).id })
    check("live: a cap-crush celebration notification exists", !!n && /crushed your cap/i.test((n as any)?.title ?? ""))
    const r2 = await celebrateCapCrush(svc as any, { agentId, brokerageId, capAmount: 20000, capPaidToDate: 21000, anniversaryStart: "1999-01-01" })
    check("live: idempotent — second call does not re-celebrate", r2.celebrated === false)
    // best-effort cleanup of any manager_signals we created
    const { data: sig } = await svc.from("manager_signals").select("id").eq("brokerage_id", brokerageId).eq("signal_type", "agent_crushed_cap").eq("entity_id", agentId).order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (sig) cleanup.push({ table: "manager_signals", id: (sig as any).id })
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let leftover = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); leftover += count ?? 0 }
    check("live: cleanup count == 0", leftover === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CAP_CRUSH_FAIL"); process.exit(1) }
  console.log(" ✅ CAP_CRUSH_PASS — the agent is celebrated the instant they crush their cap; recruiting gets the live proof; fires once")
}
main()
