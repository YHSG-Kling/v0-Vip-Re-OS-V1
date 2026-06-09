#!/usr/bin/env tsx
/**
 * scripts/manager-handoff-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 48 — proves the cross-manager HANDOFF is governed: a listing going active /
 * a deal closing PROPOSES the coordinated push into the Command Center (visible +
 * human-approved), idempotently — managers hand off through the one gate instead
 * of rediscovering work on a weekly cron.
 *
 *   Layer 2 — live (gated): propose listing handoff → surfaces in Command Center
 *     (marketing queue) → idempotent re-propose → propose closing handoff →
 *     cleanup.
 *
 * Run: npx tsx scripts/manager-handoff-simulator.ts  (npm run test:manager-handoff)
 */
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Manager handoff simulator (listing-active / deal-closed → Command Center)")
  console.log("══════════════════════════════════════════════════")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE creds not set (handoff flow is DB-driven).")
    console.log(" ✅")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { proposeListingHandoff, proposeClosingHandoff } = await import("../lib/agents/manager-handoff")
  const { loadCommandCenter } = await import("../lib/kernel/command-center")
  const svc = createServiceClient()
  const ids: string[] = []
  const listingId = `__hoff_${Date.now()}__`  // tag stored in action_input.listing_id (jsonb, not a FK)
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as { id: string }).id

    // Listing-active handoff proposes a governed action.
    const h1 = await proposeListingHandoff(brokerageId, listingId, svc)
    check("listing-active proposes a handoff into the Command Center", h1.proposed === true && !!h1.actionId, h1.reason)
    if (h1.actionId) ids.push(h1.actionId)

    const { data: a1 } = await svc.from("marketing_agent_actions").select("action_type, status, action_input").eq("id", h1.actionId!).single()
    check("proposal is promote_new_listing · proposed · carries the listing", (a1 as any).action_type === "promote_new_listing" && (a1 as any).status === "proposed" && (a1 as any).action_input?.listing_id === listingId)

    // It surfaces in the Command Center marketing queue.
    const cc = await loadCommandCenter({ brokerageId })
    check("handoff visible in the Command Center", !!cc.pendingActions.find((a) => a.id === h1.actionId && a.queue === "marketing"))

    // Idempotent — re-proposing the same listing is a no-op.
    const h1b = await proposeListingHandoff(brokerageId, listingId, svc)
    check("re-propose is idempotent (one handoff per listing)", h1b.proposed === false && h1b.actionId === h1.actionId)

    // Closing handoff is a distinct action.
    const h2 = await proposeClosingHandoff(brokerageId, listingId, svc)
    check("deal-closed proposes a just_sold_campaign handoff", h2.proposed === true && !!h2.actionId)
    if (h2.actionId) ids.push(h2.actionId)
    const { data: a2 } = await svc.from("marketing_agent_actions").select("action_type").eq("id", h2.actionId!).single()
    check("closing proposal is just_sold_campaign", (a2 as any).action_type === "just_sold_campaign")
  } finally {
    for (const id of ids) { try { await svc.from("marketing_agent_actions").delete().eq("id", id) } catch {} }
    const { count } = await svc.from("marketing_agent_actions").select("id", { count: "exact", head: true }).contains("action_input", { listing_id: listingId })
    check("cleanup verified — 0 handoff actions remain", (count ?? 0) === 0)
  }
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Managers hand off through the one Command Center — governed, visible, idempotent")
}
main().catch((e) => { console.error(e); process.exit(1) })
export {}
