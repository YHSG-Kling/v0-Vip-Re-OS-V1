#!/usr/bin/env tsx
/**
 * scripts/buyer-welcome-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 58 — proves the buyer "go-live" AUTO-handoff (BBA signed → AI-generated
 * welcome into the client_message gate, Shopping Agent owns it). The PRIMARY copy is
 * AI-generated + brand-voiced via generateClientMessage; this tests the deterministic
 * resilience FALLBACK (Fair-Housing clean) + the live propose/idempotency contract.
 *
 *   Layer 1 — pure: buildBuyerWelcomeFallback (buyer-safe, signed, sanitized).
 *   Layer 2 — live (gated): seed a buyer → produceBuyerWelcome proposes one client
 *     message that surfaces in the Command Center client_message queue; idempotent; cleanup.
 *
 * Run: npx tsx scripts/buyer-welcome-simulator.ts  (npm run test:buyer-welcome)
 */
import { buildBuyerWelcomeFallback } from "../lib/agents/buyer-welcome-producer"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testPure() {
  console.log("\n[Layer 1 · buildBuyerWelcomeFallback]")
  const m = buildBuyerWelcomeFallback("Dana Kling")
  check("welcomes + orients to next steps, signed by agent", /welcome|represent/i.test(m.body) && /Dana Kling/.test(m.body))
  check("offers concrete next steps (criteria / financing / tours)", /criteria|financing|tour/i.test(m.body))
  check("Fair-Housing clean — no steering phrase", !/adults only|no children|families only|perfect for|safe neighborhood/i.test(m.body))
  check("poisoned agent name sanitized to neutral", !/adults only|no children/i.test(buildBuyerWelcomeFallback("Dana — adults only, no children").body))
}

async function testLive() {
  console.log("\n[Layer 2 · live BBA-signed welcome auto-handoff]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure layer ran)."); return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { produceBuyerWelcome } = await import("../lib/agents/buyer-welcome-producer")
  const { loadCommandCenter } = await import("../lib/kernel/command-center")
  const svc = createServiceClient()
  const TAG = `__bw_${Date.now()}__`
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

    const r = await produceBuyerWelcome(brokerageId, buyerId, svc)
    check("BBA signed → auto-proposes one buyer welcome", r.proposed === 1, `proposed=${r.proposed}`)
    const { data: msgs } = await svc.from("agent_client_messages")
      .select("id, audience, status, agent_kind").eq("brokerage_id", brokerageId)
      .eq("entity_type", "buyer_welcome").eq("entity_id", buyerId)
    const rows = (msgs ?? []) as Array<{ id: string; audience: string; status: string; agent_kind: string }>
    check("one proposed buyer message owned by the Shopping Agent", rows.length === 1 && rows[0].status === "proposed" && rows[0].audience === "buyer" && rows[0].agent_kind === "shopping_agent")
    const cc = await loadCommandCenter({ brokerageId })
    const surfaced = cc.pendingActions.find((a) => a.id === rows[0]?.id && a.queue === "client_message")
    check("welcome surfaces in the client_message queue, owned by Shopping Agent", !!surfaced && surfaced.managerLabel === "Shopping Agent")
    const r2 = await produceBuyerWelcome(brokerageId, buyerId, svc)
    check("auto-handoff is idempotent (one per buyer)", r2.proposed === 0, `re-proposed=${r2.proposed}`)
  } finally {
    if (buyerId) {
      try { await svc.from("agent_client_messages").delete().eq("entity_id", buyerId).eq("entity_type", "buyer_welcome") } catch {}
      try { await svc.from("contacts").delete().eq("id", buyerId) } catch {}
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("first_name", `${TAG}%`)
    check("cleanup verified — 0 test contacts remain", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Buyer-broker-agreement signed → welcome AUTO-handoff simulator (deliverable-gated)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Buyer welcome: AI-generated + brand-voiced primary, neutral fallback, human-gated")
}
main().catch((e) => { console.error(e); process.exit(1) })
