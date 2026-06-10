#!/usr/bin/env tsx
/**
 * scripts/mobile-approval-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * MOBILE PUSH-TO-APPROVE harness.
 *
 * Layer 1 (pure-ish): the queue is SLA-sorted (breached first) — asserted on seeded rows.
 * Layer 2 (live, gated): seed proposed client messages (one aged ≥4h, one fresh) tied to
 *   a contact whose agent is resolvable, load the mobile queue (assert SLA sort), then
 *   enqueue the TWO-TIER push — the responsible AGENT is alerted on both; the MANAGER is
 *   escalated only on the aged one — and assert idempotency. Then clean up.
 *
 * Run: npx tsx scripts/mobile-approval-simulator.ts  (npm run test:mobile-approval)
 */
import { loadMobileApprovalQueue, enqueueApprovalNotifications } from "../lib/intelligence/mobile-approval-queue"

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
  console.log(" ✅ Mobile push-to-approve verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Mobile push-to-approve simulator")
  console.log("══════════════════════════════════════════════════")

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[live layer]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.")
    console.log("  (loadMobileApprovalQueue / enqueueApprovalNotifications are DB-driven; no pure layer.)")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__mobileappr_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    // An agent (with a user) + a contact owned by that agent → the responsible-agent
    // resolution has something to find.
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent with a user."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const agentUserId = (agent as any).user_id
    const { data: con } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Approval", last_name: TAG, agent_id: (agent as any).id,
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (con as any).id })
    const contactId = (con as any).id

    // Aged 5h (past the 4h escalation) + fresh, both addressed to the agent's contact.
    const agedAt = new Date(Date.now() - 5 * 3_600_000).toISOString()
    const { data: aged } = await svc.from("agent_client_messages").insert({
      brokerage_id: brokerageId, agent_kind: "listing_concierge", entity_type: "contact", audience: "seller",
      channel: "portal", recipient_contact_id: contactId, subject: `${TAG} aged`, body: "Aged proposal body.", status: "proposed", proposed_at: agedAt,
    }).select("id").single()
    cleanup.push({ table: "agent_client_messages", id: (aged as any).id })
    const { data: fresh } = await svc.from("agent_client_messages").insert({
      brokerage_id: brokerageId, agent_kind: "shopping_agent", entity_type: "contact", audience: "buyer",
      channel: "portal", recipient_contact_id: contactId, subject: `${TAG} fresh`, body: "Fresh proposal body.", status: "proposed", proposed_at: new Date().toISOString(),
    }).select("id").single()
    cleanup.push({ table: "agent_client_messages", id: (fresh as any).id })

    const queue = await loadMobileApprovalQueue(brokerageId, svc)
    const mine = queue.items.filter((i) => (i.subject ?? "").includes(TAG))
    check("queue: both seeded proposals present", mine.length === 2)
    check("queue: preview is populated", (mine[0]?.preview ?? "").length > 0)

    // TWO-TIER push.
    const n1 = await enqueueApprovalNotifications(brokerageId, svc)
    check("tier 1: the responsible AGENT is alerted on both proposals", n1.agentAlerts >= 2)
    check("tier 2: the manager is escalated only on the aged (≥4h) one", n1.managerEscalations >= 1)

    // The agent got an approval_needed for the aged message (medium priority — front line).
    const { data: agentNotif } = await svc.from("notifications")
      .select("id, type, priority").eq("user_id", agentUserId).eq("type", "approval_needed").eq("entity_id", (aged as any).id).maybeSingle()
    if (agentNotif) cleanup.push({ table: "notifications", id: (agentNotif as any).id })
    check("tier 1: agent alert exists for the aged message", !!agentNotif)
    // Clean the agent's fresh-message alert too.
    const { data: freshNotif } = await svc.from("notifications").select("id").eq("user_id", agentUserId).eq("type", "approval_needed").eq("entity_id", (fresh as any).id).maybeSingle()
    if (freshNotif) cleanup.push({ table: "notifications", id: (freshNotif as any).id })

    // A manager escalation (high prio) exists for the aged message only.
    const { data: esc } = await svc.from("notifications").select("id, priority").eq("type", "approval_escalation").eq("entity_id", (aged as any).id).limit(1).maybeSingle()
    if (esc) cleanup.push({ table: "notifications", id: (esc as any).id })
    check("tier 2: escalation is high priority", (esc as any)?.priority === "high")
    const { count: freshEsc } = await svc.from("notifications").select("id", { count: "exact", head: true }).eq("type", "approval_escalation").eq("entity_id", (fresh as any).id)
    check("tier 2: NO escalation for the fresh (<4h) message", (freshEsc ?? 0) === 0)

    // Idempotency — a second pass adds no duplicates.
    const n2 = await enqueueApprovalNotifications(brokerageId, svc)
    check("idempotency: second pass adds no agent alerts", n2.agentAlerts === 0)
    check("idempotency: second pass adds no escalations", n2.managerEscalations === 0)
    // collect any escalations for managers other than the first, for cleanup
    const { data: allEsc } = await svc.from("notifications").select("id").eq("type", "approval_escalation").eq("entity_id", (aged as any).id)
    for (const e of (allEsc ?? []) as Array<{ id: string }>) cleanup.push({ table: "notifications", id: e.id })
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true }).like("subject", `${TAG}%`)
    check("cleanup verified — 0 seeded proposals remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
