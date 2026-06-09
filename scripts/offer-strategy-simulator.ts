#!/usr/bin/env tsx
/**
 * scripts/offer-strategy-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 57 — proves the buyer offer-strategy AUTO-handoff is DELIVERABLE-gated: when a
 * buyer reaches the offer_strategy stage (OFFER_STRATEGY_RECOMMENDED), the system
 * auto-proposes an offer game-plan into the client_message gate (Shopping Agent owns
 * it) — zero agent effort, idempotent per buyer, no fabricated price.
 *
 *   Layer 1 — pure: buildOfferStrategyMessage (buyer-safe, Fair-Housing clean, no $).
 *   Layer 2 — live (gated): seed a buyer → produceOfferStrategyBrief proposes one
 *     client message that surfaces in the Command Center client_message queue; idempotent; cleanup.
 *
 * Run: npx tsx scripts/offer-strategy-simulator.ts  (npm run test:offer-strategy)
 */
import { buildOfferStrategyMessage } from "../lib/agents/offer-strategy-producer"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testPure() {
  console.log("\n[Layer 1 · buildOfferStrategyMessage]")
  const m = buildOfferStrategyMessage("Dana Kling")
  check("references offer + comps + terms, signed by agent", /offer/i.test(m.body) && /comparable|comps/i.test(m.body) && /terms/i.test(m.body) && /Dana Kling/.test(m.body))
  check("no fabricated price/number (agent fills comps in review)", !/\$\d|\b\d{3,}\b/.test(m.body))
  check("Fair-Housing clean — no steering phrase", !/perfect for|families only|safe neighborhood|good schools/i.test(m.body))
  const poisoned = buildOfferStrategyMessage("Dana — perfect for christian families")
  check("poisoned agent name sanitized to neutral", !/perfect for|christian families/i.test(poisoned.body))
  check("legitimate common name preserved in sign-off", /Christian Lee/.test(buildOfferStrategyMessage("Christian Lee").body))
}

async function testLive() {
  console.log("\n[Layer 2 · live offer-strategy auto-handoff]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure layer ran)."); return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { produceOfferStrategyBrief } = await import("../lib/agents/offer-strategy-producer")
  const { loadCommandCenter } = await import("../lib/kernel/command-center")
  const svc = createServiceClient()
  const TAG = `__os_${Date.now()}__`
  let buyerId: string | null = null
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as { id: string }).id

    const { data: c } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: `${TAG}Buyer`, last_name: "Test", email: `${TAG}b@example.com`, contact_type: "buyer",
    }).select("id").maybeSingle()
    buyerId = (c as { id: string } | null)?.id ?? null
    if (!buyerId) { console.log("  ⏭  contact seed failed — skipped"); return }

    const r = await produceOfferStrategyBrief(brokerageId, buyerId, svc)
    check("offer-strategy stage → auto-proposes one buyer brief", r.proposed === 1, `proposed=${r.proposed}`)

    const { data: msgs } = await svc.from("agent_client_messages")
      .select("id, audience, status, agent_kind").eq("brokerage_id", brokerageId)
      .eq("entity_type", "offer_strategy_brief").eq("entity_id", buyerId)
    const rows = (msgs ?? []) as Array<{ id: string; audience: string; status: string; agent_kind: string }>
    check("one proposed buyer message owned by the Shopping Agent", rows.length === 1 && rows[0].status === "proposed" && rows[0].audience === "buyer" && rows[0].agent_kind === "shopping_agent")

    const cc = await loadCommandCenter({ brokerageId })
    const surfaced = cc.pendingActions.find((a) => a.id === rows[0]?.id && a.queue === "client_message")
    check("brief surfaces in the Command Center client_message queue, owned by Shopping Agent", !!surfaced && surfaced.managerLabel === "Shopping Agent")

    const r2 = await produceOfferStrategyBrief(brokerageId, buyerId, svc)
    check("auto-handoff is idempotent (one per buyer journey)", r2.proposed === 0, `re-proposed=${r2.proposed}`)
  } finally {
    if (buyerId) {
      try { await svc.from("agent_client_messages").delete().eq("entity_id", buyerId).eq("entity_type", "offer_strategy_brief") } catch {}
      try { await svc.from("contacts").delete().eq("id", buyerId) } catch {}
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("first_name", `${TAG}%`)
    check("cleanup verified — 0 test contacts remain", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Buyer offer-strategy → brief AUTO-handoff simulator (deliverable-gated)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Buyer offer-strategy: zero agent effort; only the finished brief is human-gated")
}
main().catch((e) => { console.error(e); process.exit(1) })
