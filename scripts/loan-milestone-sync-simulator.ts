#!/usr/bin/env tsx
/**
 * scripts/loan-milestone-sync-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves LOAN-MILESTONE SYNC — the AI team keeps the buyer + agent on the same page through the loan.
 * Each financing milestone routes the right play: reassure the buyer (application/appraisal), celebrate
 * (approval/clear-to-close/funded), or escalate (denial/delay). A DENIAL never auto-messages the buyer
 * — it routes to the agent's judgment.
 *
 * Layer 1 (shell, pure): the plan per milestone + the denial guard. Layer 2 (live, creds-gated):
 * publish a clear-to-close milestone for a real buyer → the Deal Coordinator proposes a GATED buyer
 * update → assert 'proposed' → a denial publishes NO buyer message → idempotent → clean up.
 *
 * Run: npx tsx scripts/loan-milestone-sync-simulator.ts   (npm run test:loan-milestone-sync)
 */
import { planLoanMilestoneSync } from "../lib/intelligence/loan-milestone-sync"

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
  console.log(" ✅ Loan-milestone sync verified — buyer + agent kept in the loop; a denial never auto-messages the buyer.")
  console.log(" LOAN_MILESTONE_SYNC_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Loan-milestone sync simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · plan per milestone]")
  const app = planLoanMilestoneSync({ milestone: "application_submitted", daysToClose: 30 })
  check("application → reassure the buyer", app.notify && app.audience === "buyer" && app.tone === "reassure" && !!app.buyerMessage)
  const ctc = planLoanMilestoneSync({ milestone: "clear_to_close", daysToClose: 7 })
  check("clear-to-close → celebrate to BOTH with closing prep", ctc.audience === "both" && ctc.tone === "celebrate" && /clear to close/i.test(ctc.buyerMessage ?? ""))
  const funded = planLoanMilestoneSync({ milestone: "funded", daysToClose: 0 })
  check("funded → celebrate (keys are yours)", funded.tone === "celebrate" && /keys are yours|funded/i.test(funded.buyerMessage ?? ""))

  const denied = planLoanMilestoneSync({ milestone: "denied", daysToClose: 10 })
  check("DENIED → agent only, NEVER an automated buyer message", denied.audience === "agent" && denied.buyerMessage === null && /do NOT auto-message/i.test(denied.agentNote ?? ""))

  const delaySoon = planLoanMilestoneSync({ milestone: "delay", daysToClose: 5 })
  const delayFar = planLoanMilestoneSync({ milestone: "delay", daysToClose: 40 })
  check("delay near closing → urgent; far → action", delaySoon.tone === "urgent" && delayFar.tone === "action" && !!delaySoon.buyerMessage)

  console.log("\n[Layer 2 · live: clear-to-close → gated buyer update + agent notify]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { syncLoanMilestone } = await import("../lib/intelligence/loan-milestone-sync-runner")
  const { consumeManagerSignals } = await import("../lib/kernel/manager-signals")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  let contactId: string | null = null
  try {
    const { data: c } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "ZZLoan", last_name: `${Date.now()}`,
      email: `zz-loan-${Date.now()}@example.com`, contact_type: "buyer",
    }).select("id").single()
    contactId = (c as any)?.id ?? null
    if (contactId) cleanup.push({ table: "contacts", id: contactId })

    const r = await syncLoanMilestone({ brokerageId, contactId: contactId!, milestone: "clear_to_close", daysToClose: 7, propertyAddress: "8 Loan Ln" }, svc)
    check("clear-to-close sync published", r.published && r.audience === "both", JSON.stringify(r))

    await consumeManagerSignals({ brokerageId, toManager: "deal_coordinator", limit: 20 }, svc)
    const { data: msg } = await svc.from("agent_client_messages")
      .select("id, status, audience, agent_kind").eq("brokerage_id", brokerageId).eq("recipient_contact_id", contactId)
      .order("proposed_at", { ascending: false }).limit(1).maybeSingle()
    check("a GATED buyer loan update was proposed ('proposed', buyer)", (msg as any)?.status === "proposed" && (msg as any)?.audience === "buyer" && (msg as any)?.agent_kind === "deal_coordinator", JSON.stringify(msg))
    if ((msg as any)?.id) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })

    const again = await syncLoanMilestone({ brokerageId, contactId: contactId!, milestone: "clear_to_close", daysToClose: 7 }, svc)
    check("re-syncing the same milestone is idempotent", again.published === false)

    // A DENIAL must publish but propose NO buyer message.
    const den = await syncLoanMilestone({ brokerageId, contactId: contactId!, milestone: "denied", daysToClose: 10 }, svc)
    check("denial publishes (agent audience)", den.published && den.audience === "agent")
    await consumeManagerSignals({ brokerageId, toManager: "deal_coordinator", limit: 20 }, svc)
    const { count: buyerMsgs } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("recipient_contact_id", contactId).eq("audience", "buyer")
    check("the denial added NO new buyer message (still just the clear-to-close one)", (buyerMsgs ?? 0) === 1)
  } finally {
    await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId).eq("contact_id", contactId ?? "none").eq("signal_type", "loan_milestone").then(() => {}, () => {})
    await svc.from("notifications").delete().eq("brokerage_id", brokerageId).eq("entity_id", contactId ?? "none").eq("type", "loan_milestone").then(() => {}, () => {})
    for (const c of [...cleanup].reverse()) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {})
    const { count } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("contact_id", contactId ?? "none").eq("signal_type", "loan_milestone")
    check("cleanup: signals + seeds removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
