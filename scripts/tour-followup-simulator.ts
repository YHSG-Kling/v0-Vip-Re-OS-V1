#!/usr/bin/env tsx
/**
 * scripts/tour-followup-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 55 — proves the buyer-side tour-completed AUTO-handoff is DELIVERABLE-gated:
 * when a buyer reaches the tour_completed stage (TOUR_COMPLETED), the system
 * auto-proposes a next-steps follow-up into the client_message gate (Shopping Agent
 * owns it) — zero agent effort, idempotent per buyer.
 *
 *   Layer 1 — pure: buildTourFollowUpMessage (buyer-safe, Fair-Housing clean, signed).
 *   Layer 2 — live (gated): seed a buyer contact → produceTourFollowUp proposes one
 *     client message that surfaces in the Command Center client_message queue; idempotent; cleanup.
 *
 * Run: npx tsx scripts/tour-followup-simulator.ts  (npm run test:tour-followup)
 */
import { buildTourFollowUpMessage } from "../lib/agents/tour-followup-producer"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testPure() {
  console.log("\n[Layer 1 · buildTourFollowUpMessage]")
  const m = buildTourFollowUpMessage("Dana Kling")
  check("references touring + next steps, signed by agent", /tour/i.test(m.body) && /next/i.test(m.subject) && /Dana Kling/.test(m.body))
  check("offers concrete CTAs (more tours / comparables / offer)", /tours|comparable|offer/i.test(m.body))
  check("Fair-Housing clean — no protected-class language", !/(famil|kids|children|christian|safe neighborhood|good schools|perfect for)/i.test(m.body))
  check("no price/dollar figures", !/\$\d/.test(m.body))
  const poisoned = buildTourFollowUpMessage("Dana — families only, no kids")
  check("poisoned agent name is sanitized to neutral (no steering language leaks)", !/families only|no kids/i.test(poisoned.body))
}

async function testLive() {
  console.log("\n[Layer 2 · live tour-completed auto-handoff]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure layer ran)."); return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { produceTourFollowUp } = await import("../lib/agents/tour-followup-producer")
  const { loadCommandCenter } = await import("../lib/kernel/command-center")
  const svc = createServiceClient()
  const TAG = `__tf_${Date.now()}__`
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

    const r = await produceTourFollowUp(brokerageId, buyerId, svc)
    check("tour completed → auto-proposes one buyer follow-up", r.proposed === 1, `proposed=${r.proposed}`)

    const { data: msgs } = await svc.from("agent_client_messages")
      .select("id, audience, status, channel, agent_kind, recipient_contact_id")
      .eq("brokerage_id", brokerageId).eq("entity_type", "tour_followup").eq("entity_id", buyerId)
    const rows = (msgs ?? []) as Array<{ id: string; audience: string; status: string; channel: string; agent_kind: string; recipient_contact_id: string }>
    check("one proposed buyer message owned by the Shopping Agent", rows.length === 1 && rows[0].status === "proposed" && rows[0].audience === "buyer" && rows[0].agent_kind === "shopping_agent" && rows[0].channel === "portal")

    const cc = await loadCommandCenter({ brokerageId })
    const surfaced = cc.pendingActions.find((a) => a.id === rows[0]?.id && a.queue === "client_message")
    check("follow-up surfaces in the Command Center client_message queue", !!surfaced)
    check("...and is attributed to the Shopping Agent manager", surfaced?.managerLabel === "Shopping Agent")

    const r2 = await produceTourFollowUp(brokerageId, buyerId, svc)
    check("auto-handoff is idempotent (one per buyer journey)", r2.proposed === 0, `re-proposed=${r2.proposed}`)
  } finally {
    if (buyerId) {
      try { await svc.from("agent_client_messages").delete().eq("entity_id", buyerId).eq("entity_type", "tour_followup") } catch {}
      try { await svc.from("contacts").delete().eq("id", buyerId) } catch {}
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("first_name", `${TAG}%`)
    check("cleanup verified — 0 test contacts remain", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Buyer tour-completed → follow-up AUTO-handoff simulator (deliverable-gated)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Buyer tour-completed: zero agent effort; only the finished follow-up is human-gated")
}
main().catch((e) => { console.error(e); process.exit(1) })
