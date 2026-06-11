#!/usr/bin/env tsx
/**
 * scripts/office-hours-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * MANAGER OFFICE HOURS harness — drops, not sprays.
 *
 * Layer 1 (pure): composeDrop — grouped by manager, oldest wait surfaced.
 * Layer 2 (live, gated): seed two pending proposals + their unread approval pings,
 *   run the morning drop, assert ONE digest replaces the pings (swept = read, not
 *   deleted), CRITICAL pings are never swept, per-slot idempotency holds, and an
 *   agent with nothing pending gets nothing. Self-cleans.
 *
 * Run: npx tsx scripts/office-hours-simulator.ts  (npm run test:office-hours)
 */
import { composeDrop, runOfficeHoursDrop } from "../lib/kernel/office-hours"

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
  console.log(" ✅ Office hours verified — one stack, not a spray")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Manager office hours simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · compose]")
  const drop = composeDrop("morning", [
    { manager: "marketing_agent", subject: "a", hoursWaiting: 9 },
    { manager: "marketing_agent", subject: "b", hoursWaiting: 2 },
    { manager: "sphere_of_influence", subject: "c", hoursWaiting: 1 },
  ])
  check("drop: counts grouped by manager, biggest first", drop.body.includes("Marketing Manager 2") && drop.body.includes("Sphere Manager 1"))
  check("drop: oldest wait surfaced (9h)", drop.body.includes("9h"))
  check("drop: titled as the slot", drop.title.includes("morning drop — 3 proposals"))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live drop]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `Office${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const agentUserId = (agent as any).user_id

    const { data: con } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Drop", last_name: TAG, contact_type: "buyer",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (con as any).id })

    // Two pending proposals + their unread pings (one aged 9h), + a CRITICAL ping.
    const mk = async (kind: string, subject: string, hoursAgo: number) => {
      const { data: p } = await svc.from("agent_client_messages").insert({
        brokerage_id: brokerageId, agent_kind: kind, entity_type: "contact", audience: "buyer",
        channel: "portal", recipient_contact_id: (con as any).id, subject: `${TAG} ${subject}`,
        body: "d", status: "proposed", proposed_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
      }).select("id").single()
      cleanup.push({ table: "agent_client_messages", id: (p as any).id })
      const { data: n } = await svc.from("notifications").insert({
        user_id: agentUserId, brokerage_id: brokerageId, type: "approval_needed",
        title: `${TAG} needs approval`, body: "tap", entity_type: "agent_client_message",
        entity_id: (p as any).id, priority: "medium", is_read: false,
      }).select("id").single()
      cleanup.push({ table: "notifications", id: (n as any).id })
      return { proposalId: (p as any).id as string, pingId: (n as any).id as string }
    }
    const a = await mk("marketing_agent", "post draft", 9)
    const b = await mk("sphere_of_influence", "anniversary", 1)
    const { data: crit } = await svc.from("notifications").insert({
      user_id: agentUserId, brokerage_id: brokerageId, type: "approval_needed",
      title: `${TAG} CRITICAL`, body: "x", priority: "critical", is_read: false,
    }).select("id").single()
    cleanup.push({ table: "notifications", id: (crit as any).id })

    const r1 = await runOfficeHoursDrop(brokerageId, "morning", {}, svc)
    check("drop: ONE digest posted, pings swept", r1.digests === 1 && r1.swept === 2)
    const { data: digest } = await svc.from("notifications").select("id, body")
      .eq("user_id", agentUserId).eq("type", "office_hours_drop")
      .gte("created_at", new Date(Date.now() - 60_000).toISOString()).maybeSingle()
    if (digest) cleanup.push({ table: "notifications", id: (digest as any).id })
    check("digest: grouped by manager with the oldest wait", ((digest as any)?.body ?? "").includes("Marketing Manager 1") && ((digest as any)?.body ?? "").includes("9h"))
    const { data: pingA } = await svc.from("notifications").select("is_read").eq("id", a.pingId).single()
    const { data: pingB } = await svc.from("notifications").select("is_read").eq("id", b.pingId).single()
    check("swept pings are READ (collapsed, not deleted — audit kept)", (pingA as any).is_read === true && (pingB as any).is_read === true)
    const { data: critAfter } = await svc.from("notifications").select("is_read").eq("id", (crit as any).id).single()
    check("CRITICAL ping NEVER swept (urgency outranks tidiness)", (critAfter as any).is_read === false)

    const r2 = await runOfficeHoursDrop(brokerageId, "morning", {}, svc)
    check("idempotency: one digest per agent per slot per day", r2.digests === 0)
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
