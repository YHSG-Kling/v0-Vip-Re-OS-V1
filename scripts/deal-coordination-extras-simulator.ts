#!/usr/bin/env tsx
/**
 * scripts/deal-coordination-extras-simulator.ts  (npm run test:deal-coordination-extras)
 *
 * Proves two "publish to the bus / close the loop" completions from the deep-gap batch:
 *  A) Closing pending-action ESCALATION — an URGENT/HIGH pending action owned by the lender or a
 *     deadline-bearing vendor goes to the right manager (Finance / Compliance), not just a TC
 *     dashboard. PURE: the recipient→manager routing. LIVE: the Finance handler opens a gated task.
 *  B) Format-learning → Marketing snapshot — the Video Director's learned format winners are
 *     summarized for the Marketing Agent. PURE: summarizeTopFormats picks the proven winners.
 */
import { randomUUID } from "node:crypto"
import { closingActionManager } from "../lib/transactions/closing-orchestration"
import { summarizeTopFormats } from "../lib/video/format-learning"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

function pureLayer(): void {
  console.log("\n[closing escalation routing · pure — the right manager, not just the TC dashboard]")
  check("lender item ⇒ Finance Manager", closingActionManager("lender") === "finance_manager")
  check("title item ⇒ Compliance Officer", closingActionManager("title") === "compliance_officer")
  check("escrow item ⇒ Compliance Officer", closingActionManager("escrow") === "compliance_officer")
  check("inspection item ⇒ Compliance Officer", closingActionManager("inspector") === "compliance_officer")
  check("buyer item stays with the TC (UI, no escalation)", closingActionManager("buyer") === null)
  check("agent item stays with the TC", closingActionManager("agent") === null)

  console.log("\n[format learning → Marketing snapshot · pure]")
  const scored = {
    maxMeanSignal: 50,
    cells: {
      a: { kind: "just_listed", channel: "tiktok", compositionId: "JustListedReelSquare", mood: "energetic", sample: 4, totalScans: 180, totalEngagement: 20, meanSignal: 50, score: 1 },
      b: { kind: "just_listed", channel: "instagram", compositionId: "JustListedReelSquare", mood: "calm", sample: 3, totalScans: 60, totalEngagement: 6, meanSignal: 22, score: 0.44 },
      c: { kind: "just_sold", channel: "tiktok", compositionId: "JustSoldReelSquare", mood: "warm", sample: 1, totalScans: 99, totalEngagement: 9, meanSignal: 108, score: 1 }, // sample too small
      d: { kind: "open_house", channel: "facebook", compositionId: "OpenHouseAnnounceReel", mood: "neutral", sample: 5, totalScans: 0, totalEngagement: 0, meanSignal: 0, score: 0 }, // no signal
    },
  }
  const top = summarizeTopFormats(scored, { limit: 3, minSample: 2 })
  check("ranks the strongest cell first (just_listed/tiktok)", top[0]?.composition === "JustListedReelSquare" && top[0]?.channel === "tiktok")
  check("excludes the under-sampled cell (just_sold n=1) despite high signal", !top.some((t) => t.kind === "just_sold"))
  check("excludes the zero-signal cell", !top.some((t) => t.channel === "facebook"))
  check("returns at most `limit` winners", summarizeTopFormats(scored, { limit: 1, minSample: 2 }).length === 1)
  check("empty scored ⇒ no winners (silent until there's data)", summarizeTopFormats({ cells: {}, maxMeanSignal: 0 }).length === 0)
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[closing escalation · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the routing")
    return
  }
  console.log("\n[closing escalation · live — Finance handler opens a gated task]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { SIGNAL_HANDLERS } = await import("../lib/kernel/manager-signals")
  const svc = createServiceClient()
  const tag = `dce-sim-${randomUUID().slice(0, 8)}`
  const brokerageId = randomUUID()
  const txnId = randomUUID()
  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} (closing-escalation test)` })
    await svc.from("transactions").insert({ id: txnId, brokerage_id: brokerageId, deal_name: `${tag} deal`, status: "active" })
    const out = await SIGNAL_HANDLERS["finance_manager:transaction_action_pending"](
      { id: randomUUID(), toManager: "finance_manager", signalType: "transaction_action_pending",
        message: "Clear-to-close not received, 5 days out", entityType: "transaction", entityId: txnId, contactId: null,
        payload: { actionType: "clear_to_close_overdue", severity: "urgent", recipient: "lender", headline: "Clear-to-close not received, 5 days out", detail: "Confirm CTC ETA with the lender." } } as never,
      { brokerageId, supabase: svc },
    )
    check("Finance handler opened a gated closing task", !!out && /closing task/i.test(out))
    const { count } = await svc.from("transaction_tasks").select("id", { count: "exact", head: true })
      .eq("transaction_id", txnId).ilike("title", "[Closing · Finance]%")
    check("the financing closing task persisted", (count ?? 0) >= 1)
  } finally {
    await svc.from("transaction_tasks").delete().eq("transaction_id", txnId)
    await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId)
    await svc.from("transactions").delete().eq("id", txnId)
    await svc.from("brokerages").delete().eq("id", brokerageId)
    const { count } = await svc.from("transaction_tasks").select("id", { count: "exact", head: true }).eq("transaction_id", txnId)
    check("cleanup complete", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ DEAL_COORDINATION_EXTRAS_FAIL"); process.exit(1) }
  console.log(" ✅ DEAL_COORDINATION_EXTRAS_PASS — closing actions reach the right manager; format winners reach Marketing")
}

main().catch((e) => { console.error(e); process.exit(1) })
