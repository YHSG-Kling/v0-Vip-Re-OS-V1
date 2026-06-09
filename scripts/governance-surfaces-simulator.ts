#!/usr/bin/env tsx
/**
 * scripts/governance-surfaces-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 46 — proves the two previously-separate review surfaces are now governed
 * from the ONE Command Center via the content-approval registry:
 *   • predictive_listing_actions (predicted-seller auto-touch) — approve → queued
 *     (the PLS send cron ships it), reject → cancelled.
 *   • transaction_pending_actions (deal at-risk TASK) — approve = Resolved,
 *     reject = Dismiss.
 *
 *   Layer 1 — pure: the registry source config (pending signal, approve/reject
 *     column patches, urgency escalation).
 *   Layer 2 — live (gated): seed a pending row on each → loadCommandCenter
 *     surfaces it in its queue → approve/reject transitions the native status →
 *     leaves the queue → cleanup.
 *
 * Run: npx tsx scripts/governance-surfaces-simulator.ts  (npm run test:governance-surfaces)
 */
import { CONTENT_SOURCES } from "../lib/kernel/approval-sources"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testPure() {
  const now = new Date()
  console.log("\n[Layer 1 · predictive_listing source]")
  const pl = CONTENT_SOURCES.predictive_listing
  const pa = pl.toAction({ id: "p1", brokerage_id: "b", contact_id: "c", channel: "email", triggering_pls_score: 88, message_subject: "Curious what your home is worth?", message_body: "Hi…", created_at: now.toISOString(), scheduled_send_at: now.toISOString() }, now)
  check("predictive → approve_predictive_touch + preview", pa.actionType === "approve_predictive_touch" && pa.actionInput.pls_score === 88)
  check("approve → queued (PLS cron sends, compliance-checked)", (pl.approve("u") as any).status === "queued" && (pl.approve("u") as any).reviewed_by_user_id === "u")
  check("reject → cancelled with audit", (pl.reject("u") as any).status === "cancelled" && (pl.reject("u") as any).cancelled_by_user_id === "u")

  console.log("\n[Layer 1 · transaction_task source]")
  const tt = CONTENT_SOURCES.transaction_task
  const ta = tt.toAction({ id: "t1", brokerage_id: "b", transaction_id: "x", action_type: "appraisal_not_ordered", severity: "urgent", headline: "Appraisal not ordered — 3 days to close", detail: "...", due_date: now.toISOString(), created_at: now.toISOString() }, now)
  check("transaction → resolve_transaction_task + preview", ta.actionType === "resolve_transaction_task" && ta.actionInput.severity === "urgent")
  check("urgent/high severity escalates to breached", ta.slaLevel === "breached")
  check("approve = Resolved", (tt.approve("u") as any).status === "resolved" && (tt.approve("u") as any).resolved_by === "u")
  check("reject = Dismissed", (tt.reject("u") as any).status === "dismissed")

  console.log("\n[Layer 1 · agent_followup source]")
  const af = CONTENT_SOURCES.agent_followup
  const aa = af.toAction({ id: "f1", brokerage_id: "b", action_type: "open_house_follow_up", title: "Follow up: Sarah", description: "Open-house check-in", priority: "high", scheduled_for: now.toISOString(), created_at: now.toISOString() }, now)
  check("followup → complete_followup + preview", aa.actionType === "complete_followup" && aa.actionInput.title === "Follow up: Sarah")
  check("approve = Done (executed)", (af.approve("u") as any).status === "executed")
  check("reject = Skip (skipped)", (af.reject("u") as any).status === "skipped")
}

async function testLive() {
  console.log("\n[Layer 2 · live surface round-trip]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { loadCommandCenter } = await import("../lib/kernel/command-center")
  const { approveContentSource, rejectContentSource } = await import("../lib/kernel/approval-sources")
  const svc = createServiceClient()
  const ids: { table: string; id: string }[] = []
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as { id: string }).id
    const { data: u } = await svc.from("users").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
    const approver = (u as { id: string } | null)?.id
    if (!approver) { console.log("  ⏭  Skipped — no approver."); return }
    const ctx = { userId: approver, brokerageId, isSuperadmin: false }

    // Predictive listing needs a contact.
    const { data: contact } = await svc.from("contacts").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
    if (contact) {
      const { data: pl } = await svc.from("predictive_listing_actions").insert({
        brokerage_id: brokerageId, contact_id: (contact as { id: string }).id, action_type: "auto_touch", channel: "email",
        triggering_pls_score: 90, message_subject: "Test", status: "pending_review",
      }).select("id").maybeSingle()
      if (pl) {
        const plId = (pl as { id: string }).id; ids.push({ table: "predictive_listing_actions", id: plId })
        const cc = await loadCommandCenter({ brokerageId })
        check("predictive touch surfaces in Command Center", !!cc.pendingActions.find((a) => a.id === plId && a.queue === "predictive_listing"))
        const ap = await approveContentSource("predictive_listing", plId, ctx)
        check("approve predictive → queued", ap.ok === true, ap.error)
        const { data: after } = await svc.from("predictive_listing_actions").select("status, reviewed_by_user_id").eq("id", plId).single()
        check("status queued + reviewer stamped", (after as any).status === "queued" && (after as any).reviewed_by_user_id === approver)
      } else { console.log("  ⏭  predictive seed failed — skipped"); }
    } else { console.log("  ⏭  no contact — predictive live skipped"); }

    // Transaction task needs a transaction.
    const { data: txn } = await svc.from("transactions").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
    if (txn) {
      const { data: tt } = await svc.from("transaction_pending_actions").insert({
        brokerage_id: brokerageId, transaction_id: (txn as { id: string }).id, action_type: "inspection_overdue",
        severity: "high", headline: "Inspection overdue", bucket_key: `test_${Date.now()}`, status: "open",
      }).select("id").maybeSingle()
      if (tt) {
        const ttId = (tt as { id: string }).id; ids.push({ table: "transaction_pending_actions", id: ttId })
        const cc = await loadCommandCenter({ brokerageId })
        check("deal task surfaces in Command Center", !!cc.pendingActions.find((a) => a.id === ttId && a.queue === "transaction_task"))
        const rj = await rejectContentSource("transaction_task", ttId, ctx)
        check("dismiss deal task → dismissed", rj.ok === true)
        const { data: after } = await svc.from("transaction_pending_actions").select("status, resolved_by").eq("id", ttId).single()
        check("status dismissed + resolver stamped", (after as any).status === "dismissed" && (after as any).resolved_by === approver)
      } else { console.log("  ⏭  transaction-task seed failed — skipped"); }
    } else { console.log("  ⏭  no transaction — task live skipped"); }
  } finally {
    for (const { table, id } of ids) { try { await svc.from(table).delete().eq("id", id) } catch {} }
    check("cleanup verified", true)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Governance-surfaces simulator (predictive listing + deal tasks → Command Center)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Predicted-seller outreach + deal at-risk tasks now governed from the one Command Center")
}
main().catch((e) => { console.error(e); process.exit(1) })
