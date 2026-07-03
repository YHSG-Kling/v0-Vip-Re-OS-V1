#!/usr/bin/env tsx
/**
 * scripts/revenue-share-board-simulator.ts   (npm run test:revenue-share-board)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the REVENUE-SHARE BOARD — the agent-to-agent recruiting growth engine made visible. The
 * commission waterfall already computes residual revenue share to sponsors (commission_distributions,
 * distribution_type 'residual') and the downline lives in agent_relationships; this surfaces both in the
 * one Command Center. No model narration in the numbers; honest zeros when the network is quiet.
 *
 * PURE:   summarizeRevenueShareBoard (earners top-first, paid/pending split, downline size per sponsor).
 * SOURCE: the board is wired into loadCommandCenter (brokerage-wide) + rendered in the client card.
 * LIVE (creds-gated): seed a residual distribution + an active sponsorship → loadCommandCenter surfaces
 *         the earner with their downline size → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { summarizeRevenueShareBoard } from "../lib/intelligence/revenue-share-board"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[summarizeRevenueShareBoard · pure — earners top-first, honest]")
  const names = new Map([["a", "Alice A"], ["b", "Bob B"]])
  const board = summarizeRevenueShareBoard(
    [
      { agent_id: "a", calculated_amount: 500, status: "paid" },
      { agent_id: "a", calculated_amount: 300, status: "pending" },
      { agent_id: "b", calculated_amount: 200, status: "paid" },
      { agent_id: null, calculated_amount: 999, status: "paid" }, // no recipient → ignored
      { agent_id: "a", calculated_amount: 0, status: "paid" },     // $0 → ignored
    ],
    [
      { sponsor_agent_id: "a", is_active: true },
      { sponsor_agent_id: "a", is_active: true },
      { sponsor_agent_id: "b", is_active: true },
      { sponsor_agent_id: "b", is_active: false }, // inactive → not counted
    ],
    names,
  )
  check("total shared = 1000 (a:800 + b:200)", board.totalShared === 1000)
  check("paid/pending split honest (paid 700, pending 300)", board.paidShared === 700 && board.pendingShared === 300)
  check("earners ranked by income (a $800 → b $200)", board.earners[0].agentId === "a" && board.earners[1].agentId === "b")
  check("downline size per sponsor (a:2 active, b:1 active)", board.earners[0].downlineSize === 2 && board.earners[1].downlineSize === 1)
  check("active sponsorships counts only is_active", board.activeRelationships === 3)
  check("earnerCount = distinct earning agents", board.earnerCount === 2)
  check("names resolved; missing → honest fallback", summarizeRevenueShareBoard([{ agent_id: "z", calculated_amount: 10, status: "paid" }], [], new Map()).earners[0].name === "An agent")
  check("quiet network → honest zeros", summarizeRevenueShareBoard([], [], new Map()).totalShared === 0)
}

function sourceLayer() {
  console.log("\n[wiring — loader slice + client card]")
  const cc = src("lib/kernel/command-center.ts")
  check("revenueShareBoard is in the CommandCenterData contract", /revenueShareBoard:\s*import\("@\/lib\/intelligence\/revenue-share-board"\)/.test(cc))
  check("loadCommandCenter generates it (brokerage-wide, best-effort)", /generateRevenueShareBoard\(brokerageId\)/.test(cc) && /revenueShareBoard = revShareRes\.value/.test(cc))
  const client = src("app/dashboard/admin/command-center/command-center-client.tsx")
  check("the client renders the revenue-share board card", /recruiting growth engine/.test(client) && /data\.revenueShareBoard/.test(client))
  const board = src("lib/intelligence/revenue-share-board.ts")
  check("reads the residual distributions the waterfall writes", /distribution_type", "residual"/.test(board))
  check("reads the downline from agent_relationships", /agent_relationships[\s\S]*?sponsor_agent_id/.test(board))
  check("GATED — board returns null unless the brokerage enabled revenue share", /revenue_share_enabled[\s\S]*?return null/.test(board))
  const wf = src("lib/commission/waterfall/09-revenue-share.ts")
  check("GATED — waterfall skips revenue share unless the brokerage enabled it", /revenue_share_enabled[\s\S]*?revenueShareDistributions: \[\]/.test(wf))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed a residual distribution + a sponsorship → loadCommandCenter surfaces the earner → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ags } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).limit(2)
  if (!ags || ags.length < 2) { console.log("  ⊘ need 2 agents — skipping"); return }
  const sponsorId = (ags as any[])[0].id
  const recruitId = (ags as any[])[1].id
  const { data: txn } = await svc.from("transactions").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
  if (!txn) { console.log("  ⊘ no transaction — skipping"); return }
  const txnId = (txn as any).id
  // Preserve + control the opt-in flag around the test.
  const { data: prevFlag } = await svc.from("brokerages").select("revenue_share_enabled").eq("id", brokerageId).maybeSingle()
  const originalEnabled = !!(prevFlag as any)?.revenue_share_enabled
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: dist } = await svc.from("commission_distributions").insert({
      brokerage_id: brokerageId, agent_id: sponsorId, transaction_id: txnId, distribution_type: "residual",
      calculation_type: "percent", calculation_value: 5, calculated_amount: 750, source_of_funds: "brokerage", status: "pending",
    }).select("id").single()
    cleanup.push({ table: "commission_distributions", id: (dist as any).id })
    const { data: rel } = await svc.from("agent_relationships").insert({
      brokerage_id: brokerageId, agent_id: recruitId, sponsor_agent_id: sponsorId,
      revenue_share_percent: 5, depth_level: 1, is_active: true, relationship_type: "sponsor", source_of_funds: "brokerage",
    }).select("id").single()
    cleanup.push({ table: "agent_relationships", id: (rel as any).id })

    const { loadCommandCenter } = await import("../lib/kernel/command-center")

    // DISABLED — the board must be hidden even with real revenue-share data present.
    await svc.from("brokerages").update({ revenue_share_enabled: false }).eq("id", brokerageId)
    const ccOff = await loadCommandCenter({ brokerageId, limit: 100 })
    check("live: GATED OFF — no revenue-share board when the brokerage doesn't offer it", ccOff.revenueShareBoard === null)

    // ENABLED — the broker turns it on; the board appears with the earner.
    await svc.from("brokerages").update({ revenue_share_enabled: true }).eq("id", brokerageId)
    const cc = await loadCommandCenter({ brokerageId, limit: 100 })
    check("live: ENABLED — command center carries a revenue-share board", !!cc.revenueShareBoard)
    check("live: the seeded $750 residual shows in the total", (cc.revenueShareBoard?.totalShared ?? 0) >= 750)
    const earner = cc.revenueShareBoard?.earners.find((e) => e.agentId === sponsorId)
    check("live: the sponsor appears as an earner with their downline size ≥ 1", !!earner && earner!.downlineSize >= 1)
  } finally {
    await svc.from("brokerages").update({ revenue_share_enabled: originalEnabled }).eq("id", brokerageId)
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
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
  if (fail > 0) { console.log(" ❌ REVENUE_SHARE_BOARD_FAIL"); process.exit(1) }
  console.log(" ✅ REVENUE_SHARE_BOARD_PASS — the agent-to-agent revenue-share growth engine is visible in the command center")
}
main()
