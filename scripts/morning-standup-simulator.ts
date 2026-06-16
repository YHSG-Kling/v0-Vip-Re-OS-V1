#!/usr/bin/env tsx
/**
 * scripts/morning-standup-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * "HEY TEAM, WHAT SHOULD I DO TODAY?" harness — the managers rank the day's top 3.
 *
 * Layer 1 (pure): rankStandup — fires ALWAYS lead; overdue approvals (past the 4h
 *   SLA) outrank fresh drafts; the warmest cooling lead fills the last slot; capped
 *   at 3. composeStandup — manager-attributed; honest when the day is clear.
 * Layer 2 (live, gated): seed a fire-drill notification + two proposals (one 6h old,
 *   one fresh) on the agent's contacts + a cold high-propensity contact; run
 *   runMorningStandup; assert the ranked spoken answer leads with the fire, names
 *   the overdue approval, surfaces the cooling lead, and writes NOTHING. Self-cleans.
 *
 * Run: npx tsx scripts/morning-standup-simulator.ts  (npm run test:morning-standup)
 */
import { rankStandup, composeStandup, runMorningStandup, APPROVAL_SLA_HOURS } from "../lib/kernel/morning-standup"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Morning stand-up verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Morning stand-up simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · rank + compose]")
  const full = rankStandup({
    fireDrills: [{ entityId: "t1", title: "123 Maple — financing uncovered" }],
    approvals: [
      { id: "fresh", subject: "Fresh draft", hoursWaiting: 1 },
      { id: "old", subject: "Old draft", hoursWaiting: 6 },
    ],
    slippingClient: null,
    reengage: { contactId: "c9", name: "Avery Stone", reasons: ["high intent"], daysCold: 21 },
  })
  check("fire ALWAYS ranks #1", full[0].kind === "fire" && full[0].rank === 1)
  check("approvals rank #2, overdue (6h) chosen over fresh (1h)", full[1].kind === "approval" && full[1].entityId === "old")
  check("re-engage fills #3", full[2].kind === "reengage" && full[2].entityId === "c9")
  check("capped at 3 moves", full.length === 3)
  check("overdue count surfaced past the SLA", full[1].line.includes(`past the ${APPROVAL_SLA_HOURS}-hour`))

  // A slipping LIFETIME relationship (health-scored) outranks a propensity cooling lead.
  const slipping = rankStandup({
    fireDrills: [],
    approvals: [],
    slippingClient: { contactId: "vip1", name: "Pat Rivera", band: "at_risk", score: 28 },
    reengage: { contactId: "c9", name: "Avery Stone", reasons: ["high intent"], daysCold: 21 },
  })
  check("slipping lifetime client (health) outranks the propensity re-engage", slipping[0].kind === "health" && slipping[0].entityId === "vip1")
  check("health line names the band + score", /at_risk/.test(slipping[0].line) && /28\/100/.test(slipping[0].line))
  check("the propensity re-engage still follows", slipping.some((i) => i.kind === "reengage"))

  const noFire = rankStandup({
    fireDrills: [],
    approvals: [{ id: "a", subject: "Only draft", hoursWaiting: 2 }],
    slippingClient: null,
    reengage: null,
  })
  check("no fire → approvals lead; fresh draft still surfaces", noFire[0].kind === "approval" && !noFire[0].line.includes("past the"))
  const clear = rankStandup({ fireDrills: [], approvals: [], slippingClient: null, reengage: null })
  check("a clear day ranks nothing", clear.length === 0)
  check("compose: clear day is honest + encouraging", composeStandup("Dana", clear).includes("Go list something"))
  check("compose: ranked + manager-attributed", composeStandup("Dana", full).includes("1. Deal Coordinator:") && composeStandup("Dana", full).includes("2. Campaign Orchestrator:"))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live stand-up]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `Standup${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const agentUserId = (agent as any).user_id

    // A cold, high-propensity contact owned by this agent.
    const { data: cold } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Cooling", last_name: TAG, contact_type: "buyer",
      agent_id: agentUserId, intent_score: 92, engagement_score: 80,
      last_contacted_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (cold as any).id })

    // A fire-drill notification + a fake transaction id it points to.
    const { data: fireN } = await svc.from("notifications").insert({
      user_id: agentUserId, brokerage_id: brokerageId, type: "fire_drill",
      title: `${TAG} 123 Maple — financing uncovered`, entity_type: "transaction",
      entity_id: (cold as any).id, priority: "critical", is_read: false,
    }).select("id").single()
    cleanup.push({ table: "notifications", id: (fireN as any).id })

    // Two proposals on the agent's contact: one 6h old (overdue), one fresh.
    const mk = async (subject: string, hoursAgo: number) => {
      const { data } = await svc.from("agent_client_messages").insert({
        brokerage_id: brokerageId, agent_kind: "campaign_orchestrator", entity_type: "contact",
        audience: "buyer", channel: "portal", recipient_contact_id: (cold as any).id,
        subject: `${TAG} ${subject}`, body: "Draft.", status: "proposed",
        proposed_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
      }).select("id").single()
      cleanup.push({ table: "agent_client_messages", id: (data as any).id })
      const { data: rtN } = await svc.from("notifications").select("id").eq("entity_id", (data as any).id).eq("type", "approval_needed").maybeSingle()
      if (rtN) cleanup.push({ table: "notifications", id: (rtN as any).id })
      return (data as any).id as string
    }
    const oldId = await mk("Overdue recap", 6)
    await mk("Fresh recap", 1)

    const beforeWrites = await svc.from("notifications").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)

    const s = await runMorningStandup(brokerageId, agentUserId, { firstName: "Dana" }, svc)
    check("stand-up: leads with the fire drill", s.items[0]?.kind === "fire" && s.spoken.includes("financing uncovered"))
    check("stand-up: names the OVERDUE approval (6h), not the fresh one", s.items.some((i) => i.kind === "approval" && i.entityId === oldId) && s.spoken.includes("Overdue recap"))
    check("stand-up: surfaces the cooling high-propensity lead", s.items.some((i) => i.kind === "reengage" && i.entityId === (cold as any).id) && s.spoken.includes(`Cooling ${TAG}`))
    check("stand-up: ranked + manager-attributed + greets by name", s.spoken.startsWith("Dana, here's your day") && s.spoken.includes("1. Deal Coordinator:"))

    const afterWrites = await svc.from("notifications").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
    check("read-only: the stand-up wrote nothing", (afterWrites.count ?? 0) === (beforeWrites.count ?? 0))
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("last_name", TAG)
    check("cleanup verified — 0 seeded contacts remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
