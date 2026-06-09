#!/usr/bin/env tsx
/**
 * scripts/client-message-gate-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 45 — proves the deal-critical managers (Listing Concierge, Deal Coordinator)
 * are now GOVERNED: a proposed seller/buyer update surfaces in the Command Center,
 * nothing reaches the client until a human approves (with optional edit), reject
 * never sends, and re-approve is a no-op.
 *
 *   Layer 2 — live (gated): propose → loadCommandCenter surfaces it as
 *     'client_message' (with the real body) → reject one (never sent) → approve one
 *     (status sent, edited body persisted) → re-approve is a no-op → cleanup.
 *
 * Run: npx tsx scripts/client-message-gate-simulator.ts  (npm run test:client-message)
 */
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Client-message gate simulator (listing concierge + deal coordinator)")
  console.log("══════════════════════════════════════════════════")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.")
    console.log(" ✅ (pure layer: none — this flow is DB-driven)")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { proposeClientMessage, approveClientMessage, rejectClientMessage } = await import("../lib/agents/agent-client-messages")
  const { loadCommandCenter } = await import("../lib/kernel/command-center")
  const svc = createServiceClient()
  const TAG = `__cmsg_${Date.now()}__`
  const ids: string[] = []
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as { id: string }).id
    const { data: u } = await svc.from("users").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
    const approver = (u as { id: string } | null)?.id
    if (!approver) { console.log("  ⏭  Skipped — no approver user."); return }

    // Deal Coordinator proposes a buyer update.
    const p1 = await proposeClientMessage({ brokerageId, agentKind: "deal_coordinator", entityType: "transaction", audience: "buyer", body: `${TAG} Your inspection is scheduled for Friday.`, rationale: "Keep buyer informed of milestone" }, svc)
    check("manager proposes a client update", p1.ok && !!p1.id, p1.error)
    if (p1.id) ids.push(p1.id)

    // It is NOT sent yet (no sent_at) and sits proposed.
    const { data: m1 } = await svc.from("agent_client_messages").select("status, sent_at").eq("id", p1.id!).single()
    check("proposed update is NOT sent (held for human)", (m1 as any).status === "proposed" && !(m1 as any).sent_at)

    // Command Center surfaces it as a client_message with the real body.
    const cc = await loadCommandCenter({ brokerageId })
    const surfaced = cc.pendingActions.find((a) => a.id === p1.id)
    check("Command Center surfaces it in the client_message queue", !!surfaced && surfaced.queue === "client_message")
    check("the actual client message is shown for review", !!surfaced && /inspection is scheduled/.test(String(surfaced.actionInput.body)))

    // Reject path: a second message rejected → never sent.
    const p2 = await proposeClientMessage({ brokerageId, agentKind: "listing_concierge", entityType: "contact", audience: "seller", body: `${TAG} reject me`, }, svc)
    if (p2.id) ids.push(p2.id)
    await rejectClientMessage(p2.id!, approver, svc)
    const { data: m2 } = await svc.from("agent_client_messages").select("status, sent_at").eq("id", p2.id!).single()
    check("rejected update is never sent", (m2 as any).status === "rejected" && !(m2 as any).sent_at)

    // Approve with an edit → sent, edited body persisted.
    const edited = `${TAG} Your inspection is confirmed for Friday at 2pm.`
    const appr = await approveClientMessage(p1.id!, approver, edited, svc)
    check("approval SENDS the update", appr.status === "sent", JSON.stringify(appr.result))
    const { data: m3 } = await svc.from("agent_client_messages").select("status, sent_at, body, approved_by").eq("id", p1.id!).single()
    check("status sent + stamped + the human's edit persisted", (m3 as any).status === "sent" && !!(m3 as any).sent_at && (m3 as any).body === edited && (m3 as any).approved_by === approver)

    // Re-approve is a no-op.
    const again = await approveClientMessage(p1.id!, approver, undefined, svc)
    check("re-approve is a no-op (already sent)", again.status === "skipped")

    // Approved message leaves the pending queue.
    const cc2 = await loadCommandCenter({ brokerageId })
    check("sent message leaves the pending queue", !cc2.pendingActions.find((a) => a.id === p1.id))
  } finally {
    for (const id of ids) { try { await svc.from("agent_client_messages").delete().eq("id", id) } catch {} }
    const { count } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true }).like("body", `${TAG}%`)
    check("cleanup verified — 0 test messages remain", (count ?? 0) === 0)
  }
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Deal-critical managers governed — no client update sends without human approval")
}
main().catch((e) => { console.error(e); process.exit(1) })
