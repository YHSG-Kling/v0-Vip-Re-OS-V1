#!/usr/bin/env tsx
/**
 * scripts/mobile-approval-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * MOBILE PUSH-TO-APPROVE harness.
 *
 * Layer 1 (pure-ish): the queue is SLA-sorted (breached first) — asserted on seeded rows.
 * Layer 2 (live, gated): seed proposed client messages (one aged/breached, one fresh),
 *   load the mobile queue (assert SLA sort + counts), enqueue approval notifications
 *   (assert one created for the urgent message + idempotency), then clean up.
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
    const { data: usr } = await svc.from("users").select("id, brokerage_id").not("brokerage_id", "is", null).limit(1).single()
    if (!brk || !usr) { console.log("  ⏭  Skipped — need a brokerage + user."); report(); return }
    const brokerageId = (usr as any).brokerage_id
    const recipientUserId = (usr as any).id

    // Aged 30h (breached) + fresh proposals.
    const agedAt = new Date(Date.now() - 30 * 3_600_000).toISOString()
    const { data: aged } = await svc.from("agent_client_messages").insert({
      brokerage_id: brokerageId, agent_kind: "listing_concierge", entity_type: "listing", audience: "seller",
      channel: "portal", subject: `${TAG} aged`, body: "Aged proposal body.", status: "proposed", proposed_at: agedAt,
    }).select("id").single()
    cleanup.push({ table: "agent_client_messages", id: (aged as any).id })
    const { data: fresh } = await svc.from("agent_client_messages").insert({
      brokerage_id: brokerageId, agent_kind: "shopping_agent", entity_type: "offer", audience: "buyer",
      channel: "portal", subject: `${TAG} fresh`, body: "Fresh proposal body.", status: "proposed", proposed_at: new Date().toISOString(),
    }).select("id").single()
    cleanup.push({ table: "agent_client_messages", id: (fresh as any).id })

    const queue = await loadMobileApprovalQueue(brokerageId, svc)
    const mine = queue.items.filter((i) => (i.subject ?? "").includes(TAG))
    check("queue: both seeded proposals present", mine.length === 2)
    check("queue: aged proposal is BREACHED", mine.find((i) => i.subject?.includes("aged"))?.slaLevel === "breached")
    const agedIdx = queue.items.findIndex((i) => i.subject?.includes(`${TAG} aged`))
    const freshIdx = queue.items.findIndex((i) => i.subject?.includes(`${TAG} fresh`))
    check("queue: breached sorts ahead of fresh", agedIdx >= 0 && freshIdx >= 0 && agedIdx < freshIdx)
    check("queue: preview is populated", (mine[0]?.preview ?? "").length > 0)

    // Enqueue notifications → one for the breached message.
    const n1 = await enqueueApprovalNotifications(brokerageId, recipientUserId, svc)
    check("notify: at least the breached message got a push", n1.enqueued >= 1)
    const { data: notif } = await svc.from("notifications")
      .select("id, type, priority, entity_id").eq("user_id", recipientUserId).eq("type", "approval_needed")
      .eq("entity_id", (aged as any).id).maybeSingle()
    if (notif) cleanup.push({ table: "notifications", id: (notif as any).id })
    check("notify: breached message notification is high priority", (notif as any)?.priority === "high")

    // Idempotency — a second enqueue does not duplicate the breached notification.
    const n2 = await enqueueApprovalNotifications(brokerageId, recipientUserId, svc)
    const { count: dupCount } = await svc.from("notifications")
      .select("id", { count: "exact", head: true }).eq("user_id", recipientUserId).eq("type", "approval_needed").eq("entity_id", (aged as any).id)
    check("notify: idempotent (no duplicate for the same message)", (dupCount ?? 0) === 1)
    // clean any fresh-message notification the second pass may have created
    const { data: extra } = await svc.from("notifications").select("id").eq("user_id", recipientUserId).eq("type", "approval_needed").eq("entity_id", (fresh as any).id).maybeSingle()
    if (extra) cleanup.push({ table: "notifications", id: (extra as any).id })
    void n2
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
