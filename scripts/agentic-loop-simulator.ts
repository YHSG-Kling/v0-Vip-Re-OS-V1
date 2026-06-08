#!/usr/bin/env tsx
/**
 * scripts/agentic-loop-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 39 — proves the CLOSED agentic loop for the pre-listing presentation:
 *
 *     manager PROPOSES → Command Center surfaces it → human APPROVES →
 *     manager EXECUTES (materializes the seller-facing drip) → nothing reached
 *     the seller until the human approved.
 *
 *   Layer 1 — propose() idempotency contract (pure-ish, gated on DB): a built
 *     presentation yields exactly ONE open proposal; re-proposing is a no-op.
 *   Layer 2 — live round-trip (gated): seed a presentation, propose the drip,
 *     assert loadCommandCenter surfaces it as a proposed approval (with NO
 *     sections materialized yet — the seller has seen nothing), approve via
 *     executeAction (stamps approved_by), assert the handler materialized the
 *     seller-safe sections + flipped the action to succeeded, prove re-approve
 *     is a no-op, then cascade-clean up.
 *
 * This is the loop the owner asked to close — and the template for closing it
 * on every other feature: managers propose, humans approve, managers execute.
 *
 * Run:  npx tsx scripts/agentic-loop-simulator.ts   (npm run test:agentic-loop)
 */
import { SECTION_SEQUENCE } from "../lib/listing-presentation/section-drip"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

async function testLive() {
  console.log("\n[Live · governed propose → approve → execute round-trip]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { proposePrelistingDrip } = await import("../lib/listing-presentation/propose-prelisting-drip")
  const { loadCommandCenter } = await import("../lib/kernel/command-center")
  const { executeAction } = await import("../lib/agents/marketing-agent-actions")
  const svc = createServiceClient()

  let presId: string | null = null
  let actionId: string | null = null
  const TAG = `__loopsim_${Date.now()}__`
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as { id: string }).id

    // A human approver (the owner clicking "approve" in the Command Center).
    const { data: approver } = await svc.from("users")
      .select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
    const approverUserId = (approver as { id: string } | null)?.id ?? null

    // 1. A presentation has just been built (the agent's copy is saved).
    const { data: pres, error: pErr } = await svc.from("listing_presentations").insert({
      brokerage_id: brokerageId, state: "FL", property_address: `${TAG} 742 Evergreen Ter`,
      built_at: new Date().toISOString(), appointment_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      cma_mid_value: 675000, cma_narrative: "Strong market, low inventory.",
      net_sheet: {}, marketing_plan: {}, slide_deck: { slides: [] }, status: "ready",
    }).select("id").single()
    check("seed listing_presentations", !pErr && !!pres, pErr?.message)
    if (!pres) throw new Error("presentation seed failed")
    presId = (pres as { id: string }).id

    // 2. The manager PROPOSES the drip (does NOT auto-fire it).
    const proposal = await proposePrelistingDrip({ presentationId: presId!, brokerageId }, svc)
    check("manager proposes the drip", proposal.proposed === true && !!proposal.actionId, proposal.reason)
    actionId = proposal.actionId ?? null

    // The proposal is parked as 'proposed' — awaiting a human.
    const { data: parked } = await svc.from("marketing_agent_actions")
      .select("status, approved_by, action_input").eq("id", actionId!).single()
    check("proposal sits as 'proposed' (no human yet)", (parked as { status: string }).status === "proposed")
    check("proposal carries the presentation_id", (parked as { action_input: { presentation_id?: string } }).action_input?.presentation_id === presId)

    // 3. CRITICAL governance assertion: NOTHING has reached the seller yet —
    //    no sections were materialized by merely proposing.
    const { count: preCount } = await svc.from("presentation_sections")
      .select("id", { count: "exact", head: true }).eq("presentation_id", presId!)
    check("NO sections materialized before approval (nothing reached the seller)", (preCount ?? 0) === 0)

    // 4. The Command Center surfaces it in the approval queue.
    const cc = await loadCommandCenter({ brokerageId })
    const surfaced = cc.pendingActions.find((a) => a.id === actionId)
    check("Command Center surfaces the proposal in the approval queue", !!surfaced)
    check("surfaced as a proposed start_prelisting_drip", !!surfaced && surfaced.actionType === "start_prelisting_drip" && surfaced.status === "proposed")
    check("approval queue count reflects the pending proposal", cc.summary.pendingApprovals >= 1)

    // 5. Re-proposing while one is open is idempotent (no duplicate approvals).
    const dup = await proposePrelistingDrip({ presentationId: presId!, brokerageId }, svc)
    check("re-propose is idempotent (same action, not a new one)", dup.proposed === false && dup.actionId === actionId)

    // 6. A human APPROVES — executeAction stamps approved_by and runs the handler.
    if (!approverUserId) {
      console.log("  ⏭  No user in this brokerage to act as approver — skipping execute half.")
    } else {
      const outcome = await executeAction(actionId!, approverUserId)
      check("approval executes the handler (succeeded)", outcome.status === "succeeded", JSON.stringify(outcome.result))
      check("handler reports the full section set scheduled", (outcome.result as { sections_scheduled?: number }).sections_scheduled === SECTION_SEQUENCE.length)

      // 7. The ledger row records the human in the loop + terminal state.
      const { data: done } = await svc.from("marketing_agent_actions")
        .select("status, approved_by").eq("id", actionId!).single()
      check("action flipped proposed → succeeded", (done as { status: string }).status === "succeeded")
      check("approved_by stamps the human approver (audit trail)", (done as { approved_by: string | null }).approved_by === approverUserId)

      // 8. Only NOW are the seller-safe sections materialized.
      const { data: sections } = await svc.from("presentation_sections")
        .select("section_key, status, price_withheld").eq("presentation_id", presId!)
      const list = sections ?? []
      check("approval materialized the full seller-safe section set", list.length === SECTION_SEQUENCE.length && list.every((r: { price_withheld: boolean }) => r.price_withheld === true))

      // 9. Re-approving a terminal action is a no-op (no double-fire).
      const replay = await executeAction(actionId!, approverUserId)
      check("re-approve is a no-op (row not in proposed/approved)", replay.status === "skipped")

      // After execution the proposal leaves the pending queue.
      const cc2 = await loadCommandCenter({ brokerageId })
      check("executed proposal no longer in the pending queue", !cc2.pendingActions.find((a) => a.id === actionId))
    }
  } finally {
    if (actionId) { try { await svc.from("marketing_agent_actions").delete().eq("id", actionId) } catch { /* noop */ } }
    if (presId)   { try { await svc.from("listing_presentations").delete().eq("id", presId) } catch { /* noop */ } }
    const { count: secLeft } = await svc.from("presentation_sections")
      .select("id", { count: "exact", head: true }).eq("presentation_id", presId ?? "00000000-0000-0000-0000-000000000000")
    check("cleanup verified — 0 sections remain (cascade)", (secLeft ?? 0) === 0)
    const { count: actLeft } = await svc.from("marketing_agent_actions")
      .select("id", { count: "exact", head: true }).eq("id", actionId ?? "00000000-0000-0000-0000-000000000000")
    check("cleanup verified — proposal row removed", (actLeft ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Agentic loop simulator (propose → approve → execute)")
  console.log("══════════════════════════════════════════════════")
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Agentic loop closed — managers propose, humans approve, managers execute")
}
main().catch((e) => { console.error(e); process.exit(1) })
