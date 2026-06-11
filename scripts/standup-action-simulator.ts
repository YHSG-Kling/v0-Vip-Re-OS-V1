#!/usr/bin/env tsx
/**
 * scripts/standup-action-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * "KNOCK OUT NUMBER TWO" harness — one-breath delegation on a ranked stand-up item.
 *
 * Layer 1 (pure): parseOrdinal across spoken forms ("number two", "the second one",
 *   "#3", "do 1", "first"); rejects out-of-range / no-number.
 * Layer 2 (live, gated): seed an agent's day so the stand-up ranks [fire #1,
 *   approval #2, reengage #3]; "do 2" APPROVES the proposal AS the agent through the
 *   gate (approved_by = real human); "do 3" sends the re-engage follow-up; "do 1"
 *   (fire) is REFUSED (human judgment); out-of-range answers honestly. Self-cleans.
 *
 * Run: npx tsx scripts/standup-action-simulator.ts  (npm run test:standup-action)
 */
import { parseOrdinal, actOnStandupItem, runStandupAction } from "../lib/kernel/standup-action"
import type { StandupItem } from "../lib/kernel/morning-standup"

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
  console.log(" ✅ Stand-up action (the 'do it' verb) verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Stand-up action simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · ordinal parse]")
  check("'knock out number two' → 2", parseOrdinal("knock out number two") === 2)
  check("'do the first one' → 1", parseOrdinal("do the first one") === 1)
  check("'handle #3' → 3", parseOrdinal("handle #3") === 3)
  check("'approve item 2' → 2", parseOrdinal("approve item 2") === 2)
  check("'just do it' → null (no rank)", parseOrdinal("just do it") === null)
  check("out-of-set number ignored ('do number 9' → null)", parseOrdinal("do number 9") === null)

  // Pure routing: a fire item is NEVER auto-resolved.
  const fireItem: StandupItem = { rank: 1, manager: "deal_coordinator", kind: "fire", entityId: "t1", line: "a fire drill is open — 123 Maple." }
  const fireRes = await actOnStandupItem({ brokerageId: "b", agentUserId: "u", item: fireItem })
  check("fire item → REFUSED (human judgment), offers the calming-note draft", !fireRes.ok && fireRes.actedKind === "fire" && fireRes.spoken.includes("won't auto-resolve"))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live delegation]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `Doit${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const agentUserId = (agent as any).user_id

    // A cold high-propensity contact (re-engage #3) that also holds the approval (#2).
    const { data: cold } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Doit", last_name: TAG, contact_type: "buyer",
      agent_id: agentUserId, intent_score: 92, engagement_score: 80,
      last_contacted_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (cold as any).id })
    // Fire (#1).
    const { data: fireN } = await svc.from("notifications").insert({
      user_id: agentUserId, brokerage_id: brokerageId, type: "fire_drill",
      title: `${TAG} 123 Maple — financing uncovered`, entity_type: "transaction",
      entity_id: (cold as any).id, priority: "critical", is_read: false,
    }).select("id").single()
    cleanup.push({ table: "notifications", id: (fireN as any).id })
    // Aging approval (#2).
    const { data: prop } = await svc.from("agent_client_messages").insert({
      brokerage_id: brokerageId, agent_kind: "campaign_orchestrator", entity_type: "contact",
      audience: "buyer", channel: "portal", recipient_contact_id: (cold as any).id,
      subject: `${TAG} Overdue recap`, body: "Draft.", status: "proposed",
      proposed_at: new Date(Date.now() - 6 * 3_600_000).toISOString(),
    }).select("id").single()
    cleanup.push({ table: "agent_client_messages", id: (prop as any).id })
    const { data: rtN } = await svc.from("notifications").select("id").eq("entity_id", (prop as any).id).eq("type", "approval_needed").maybeSingle()
    if (rtN) cleanup.push({ table: "notifications", id: (rtN as any).id })

    // "Do number 2" → approve the proposal AS the agent (the gate).
    const r2 = await runStandupAction({ brokerageId, agentUserId, ordinal: 2, firstName: "Dana" }, svc)
    check("'do 2' approved the proposal", r2.ok && r2.actedKind === "approval")
    const { data: after } = await svc.from("agent_client_messages").select("status, approved_by").eq("id", (prop as any).id).single()
    check("approval routed through the gate AS the agent (approved_by = real human)", (after as any).approved_by === agentUserId && (after as any).status !== "proposed")
    const { data: tu } = await svc.from("transparency_updates").select("id").eq("contact_id", (cold as any).id).limit(5)
    for (const t of (tu ?? []) as any[]) cleanup.push({ table: "transparency_updates", id: t.id })

    // "Do number 1" (fire) → refused, never auto-resolved.
    const r1 = await runStandupAction({ brokerageId, agentUserId, ordinal: 1, firstName: "Dana" }, svc)
    check("'do 1' (fire) refused — deal-threatening item never auto-resolved", !r1.ok && r1.actedKind === "fire")

    // "Do number 3" (re-engage) → the follow-up goes out (now that #2 is approved, the
    // stand-up re-ranks; re-engage is the surviving move). Assert a follow-up landed.
    const r3 = await runStandupAction({ brokerageId, agentUserId, ordinal: 2, firstName: "Dana" }, svc)
    // After #2 approved, ranks shift: #1 fire, #2 reengage. "do 2" now hits reengage.
    const { data: followups } = await svc.from("agent_client_messages")
      .select("id, status, approved_by").eq("recipient_contact_id", (cold as any).id)
      .neq("id", (prop as any).id).limit(5)
    for (const f of (followups ?? []) as any[]) cleanup.push({ table: "agent_client_messages", id: f.id })
    check("re-engage verb sent a follow-up through the gate", r3.ok && r3.actedKind === "reengage" && (followups ?? []).length >= 1)

    // Out-of-range answers honestly.
    const r9 = await runStandupAction({ brokerageId, agentUserId, ordinal: 3, firstName: "Dana" }, svc)
    check("out-of-range rank → honest answer, no action", !r9.ok && /no number 3|priorit/i.test(r9.spoken))
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
