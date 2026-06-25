#!/usr/bin/env tsx
/**
 * scripts/agent-deactivation-simulator.ts   (npm run test:agent-deactivation)
 * ─────────────────────────────────────────────────────────────────────────────
 * AGENT OFF-BOARDING — a deactivated agent's book is never orphaned. Proves the
 * ownership split + reassign/archive engine end-to-end.
 *
 * Layer 1 (pure): classifyContactOwnership — agent_book only when the agent personally
 *   sourced it (source_agent_id matches agents.id OR users.id); everything else is the
 *   conservative system_acquired (so archiving requires positive proof of ownership).
 *
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY): seed a target agent + a successor +
 *   a system-acquired contact, an agent-book contact, an agent-book contact WITH an
 *   in-flight deal, and a lead → plan → execute(disposition=archive):
 *     · system-acquired contact  → REASSIGNED to the successor (brokerage asset)
 *     · agent-book (no deal)      → ARCHIVED (status=archived, automation off)
 *     · agent-book (in-flight deal) → FORCE-REASSIGNED (never archived mid-deal)
 *     · lead                       → REASSIGNED to the successor
 *     · agent                      → is_active=false
 *     · successor                  → one 'book_reassigned' notification
 *     · recruiting_manager → deal_coordinator:agent_book_reassigned published
 *   idempotent rerun; reverse-delete every seeded row; cleanup count == 0.
 */
import { classifyContactOwnership } from "../lib/agents/agent-deactivation"

let passed = 0, failed = 0
const failures: string[] = []
const check = (n: string, c: boolean, d?: string) => {
  if (c) { passed++; console.log(`  ✓ ${n}`) } else { failed++; failures.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" AGENT_DEACTIVATION_PASS — no orphaned book; system reassigned, contract book archived, in-flight deals never dropped")
}

function pureLayer() {
  console.log("\n[Layer 1 · pure — ownership classification]")
  const agent = { agentId: "agent-1", userId: "user-1" }
  check("source_agent_id === agents.id → agent_book", classifyContactOwnership({ source_agent_id: "agent-1" }, agent) === "agent_book")
  check("source_agent_id === users.id → agent_book", classifyContactOwnership({ source_agent_id: "user-1" }, agent) === "agent_book")
  check("source_agent_id null → system_acquired (conservative default)", classifyContactOwnership({ source_agent_id: null }, agent) === "system_acquired")
  check("source_agent_id a DIFFERENT agent → system_acquired", classifyContactOwnership({ source_agent_id: "agent-99" }, agent) === "system_acquired")
  check("agent with null userId still matches on agentId", classifyContactOwnership({ source_agent_id: "agent-1" }, { agentId: "agent-1", userId: null }) === "agent_book")
}

async function liveLayer() {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("\n[Layer 2 · live] ⏭  Skipped — SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran)."); return }
  console.log("\n[Layer 2 · live — reassign / archive engine]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { planAgentDeactivation, executeAgentDeactivation } = await import("../lib/agents/agent-deactivation")
  const { consumeManagerSignals } = await import("../lib/kernel/manager-signals")
  const svc = createServiceClient()
  const TAG = `Deact${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    // A brokerage with ≥2 users (two distinct agents need two distinct user_ids).
    const { data: users } = await svc.from("users").select("id, brokerage_id").not("brokerage_id", "is", null).limit(50)
    const byBrokerage = new Map<string, string[]>()
    for (const u of (users ?? []) as Array<{ id: string; brokerage_id: string }>) {
      const arr = byBrokerage.get(u.brokerage_id) ?? []
      arr.push(u.id); byBrokerage.set(u.brokerage_id, arr)
    }
    let brokerageId = ""; let userA = ""; let userB = ""
    for (const [bid, ids] of byBrokerage) { if (ids.length >= 2) { brokerageId = bid; userA = ids[0]; userB = ids[1]; break } }
    if (!brokerageId) { console.log("  ⏭  Skipped — need a brokerage with ≥2 users to seed two agents."); return }

    // Seed the target agent + the successor agent.
    const { data: tgt, error: tgtErr } = await svc.from("agents").insert({ brokerage_id: brokerageId, user_id: userA, is_active: true }).select("id, user_id").single()
    if (tgtErr || !tgt) { console.log(`  ⏭  Skipped — could not seed target agent (${tgtErr?.message}).`); return }
    const agentId = (tgt as any).id as string
    cleanup.push({ table: "agents", id: agentId })
    const { data: succ, error: succErr } = await svc.from("agents").insert({ brokerage_id: brokerageId, user_id: userB, is_active: true }).select("id, user_id").single()
    if (succErr || !succ) { console.log(`  ⏭  Skipped — could not seed successor agent (${succErr?.message}).`); return }
    const successorAgentId = (succ as any).id as string
    const successorUserId = (succ as any).user_id as string
    cleanup.push({ table: "agents", id: successorAgentId })

    const mkContact = async (label: string, sourceAgentId: string | null) => {
      const { data } = await svc.from("contacts").insert({
        brokerage_id: brokerageId, first_name: TAG, last_name: label, contact_type: "buyer",
        status: "active", agent_id: agentId, source_agent_id: sourceAgentId, isa_reengage_allowed: true,
        ai_outreach_paused: false,
      }).select("id").single()
      const id = (data as any).id as string
      cleanup.push({ table: "contacts", id })
      return id
    }
    const systemContact = await mkContact("System", null)          // system-acquired → reassign
    const bookContact = await mkContact("Book", agentId)           // agent-book, no deal → archive
    const dealContact = await mkContact("Deal", agentId)           // agent-book WITH deal → force reassign

    // An in-flight deal on the agent-book deal contact, OWNED by the departing agent.
    const { data: tx } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, contact_id: dealContact, deal_name: `${TAG} deal`, status: "under_contract",
      agent_id: agentId, buyer_agent_id: agentId,
    }).select("id").single()
    const txId = tx ? ((tx as any).id as string) : null
    if (txId) cleanup.push({ table: "transactions", id: txId })

    // A CLOSED deal owned by the departing agent — must STAY attributed (commission history).
    const { data: closedTx } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, contact_id: systemContact, deal_name: `${TAG} closed`, status: "closed",
      agent_id: agentId,
    }).select("id").single()
    const closedTxId = closedTx ? ((closedTx as any).id as string) : null
    if (closedTxId) cleanup.push({ table: "transactions", id: closedTxId })

    // A lead owned by the agent.
    const { data: lead } = await svc.from("leads").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "Lead", agent_id: agentId, lead_stage: "new",
    }).select("id").single()
    const leadId = (lead as any).id as string
    cleanup.push({ table: "leads", id: leadId })

    // ── PLAN (read-only preview) ──
    const plan = await planAgentDeactivation(svc, { brokerageId, agentId, userId: userA })
    check("plan: 1 system-acquired contact", plan.counts.systemAcquired === 1, `got ${plan.counts.systemAcquired}`)
    check("plan: 2 agent-book contacts", plan.counts.agentBook === 2, `got ${plan.counts.agentBook}`)
    check("plan: 1 in-flight deal flagged", plan.counts.activeDeals === 1, `got ${plan.counts.activeDeals}`)
    check("plan: 1 lead", plan.counts.leads === 1, `got ${plan.counts.leads}`)

    // ── EXECUTE (disposition = archive) ──
    const res = await executeAgentDeactivation(svc, {
      brokerageId, agentId, userId: userA, successorAgentId, agentBookDisposition: "archive", actorUserId: userA,
    })
    check("execute: ok", res.ok, res.reason)
    check("execute: 2 contacts reassigned (system + in-flight book)", res.reassignedContacts === 2, `got ${res.reassignedContacts}`)
    check("execute: 1 contact archived (agent book, no deal)", res.archivedContacts === 1, `got ${res.archivedContacts}`)
    check("execute: in-flight book contact force-reassigned (never archived)", res.inFlightForcedReassign === 1, `got ${res.inFlightForcedReassign}`)
    check("execute: 1 lead reassigned", res.reassignedLeads === 1, `got ${res.reassignedLeads}`)
    check("execute: agent deactivated", res.agentDeactivated)

    // Verify the actual rows.
    const { data: sysRow } = await svc.from("contacts").select("agent_id, status").eq("id", systemContact).single()
    check("system contact now belongs to the successor", (sysRow as any).agent_id === successorAgentId)
    check("system contact NOT archived", (sysRow as any).status !== "archived")
    const { data: bookRow } = await svc.from("contacts").select("agent_id, status, ai_outreach_paused, isa_reengage_allowed").eq("id", bookContact).single()
    check("agent-book contact archived (status=archived, automation off)",
      (bookRow as any).status === "archived" && (bookRow as any).ai_outreach_paused === true && (bookRow as any).isa_reengage_allowed === false, JSON.stringify(bookRow))
    const { data: dealRow } = await svc.from("contacts").select("agent_id, status").eq("id", dealContact).single()
    check("in-flight book contact reassigned to successor, NOT archived",
      (dealRow as any).agent_id === successorAgentId && (dealRow as any).status !== "archived", JSON.stringify(dealRow))
    const { data: leadRow } = await svc.from("leads").select("agent_id").eq("id", leadId).single()
    check("lead reassigned to successor", (leadRow as any).agent_id === successorAgentId)
    const { data: agentRow } = await svc.from("agents").select("is_active").eq("id", agentId).single()
    check("agent is_active=false", (agentRow as any).is_active === false)

    // WARM HAND-OFF — a gated re-introduction proposed for each reassigned contact (NOT the
    // archived one). 2 reassigned (system + in-flight book) → 2 re-intros.
    check("re-introductions proposed for the inherited book (2 reassigned, archived excluded)",
      res.reintroductionsProposed === 2, `got ${res.reintroductionsProposed}`)
    const { data: reintros } = await svc.from("agent_client_messages")
      .select("id, recipient_contact_id, audience, channel, agent_kind, status")
      .eq("brokerage_id", brokerageId).eq("subject", "A quick introduction from your new point of contact")
      .in("recipient_contact_id", [systemContact, dealContact, bookContact])
    for (const m of (reintros ?? []) as any[]) {
      cleanup.push({ table: "agent_client_messages", id: m.id })
      const { data: ns } = await svc.from("notifications").select("id").eq("entity_id", m.id)
      for (const n of (ns ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    }
    const reintroRows = (reintros ?? []) as any[]
    check("re-intro is gated (status=proposed) + portal channel", reintroRows.length === 2 && reintroRows.every((r) => r.status === "proposed" && r.channel === "portal"))
    check("NO re-intro for the archived contact (automation off)", !reintroRows.some((r) => r.recipient_contact_id === bookContact))

    // In-flight deal ownership followed the client (agent_id + buyer_agent_id moved); CLOSED stays.
    check("in-flight deal roles reassigned to successor (agent_id + buyer_agent_id)", res.reassignedDealRoles === 2, `got ${res.reassignedDealRoles}`)
    if (txId) {
      const { data: txRow } = await svc.from("transactions").select("agent_id, buyer_agent_id").eq("id", txId).single()
      check("in-flight transaction now owned by the successor", (txRow as any).agent_id === successorAgentId && (txRow as any).buyer_agent_id === successorAgentId)
    }
    if (closedTxId) {
      const { data: closedRow } = await svc.from("transactions").select("agent_id").eq("id", closedTxId).single()
      check("CLOSED deal stays attributed to the original agent (commission history preserved)", (closedRow as any).agent_id === agentId)
    }

    // Successor got a summary notification.
    const { data: notifs } = await svc.from("notifications").select("id, type, priority").eq("user_id", successorUserId).eq("type", "book_reassigned").eq("entity_id", agentId)
    for (const n of (notifs ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    check("successor notified of the inherited book (high priority — in-flight deal)",
      ((notifs ?? []) as any[]).some((n) => n.priority === "high"))

    // The Deal Coordinator coordination signal was published (managers working together).
    const { data: sig } = await svc.from("manager_signals").select("id, from_manager, to_manager, signal_type")
      .eq("entity_id", agentId).eq("signal_type", "agent_book_reassigned").maybeSingle()
    if (sig) cleanup.push({ table: "manager_signals", id: (sig as any).id })
    check("recruiting_manager → deal_coordinator:agent_book_reassigned published",
      !!sig && (sig as any).from_manager === "recruiting_manager" && (sig as any).to_manager === "deal_coordinator")
    // Consuming it is best-effort (depends on broker/admins existing); never throws.
    await consumeManagerSignals({ brokerageId, toManager: "deal_coordinator" }, svc)

    // ── Idempotent rerun ──
    const res2 = await executeAgentDeactivation(svc, {
      brokerageId, agentId, userId: userA, successorAgentId, agentBookDisposition: "archive", actorUserId: userA,
    })
    check("idempotent rerun: ok, nothing left to reassign/archive", res2.ok && res2.reassignedContacts === 0 && res2.archivedContacts === 0, JSON.stringify(res2))
  } finally {
    // Clear FKs first (agent_id) so agents/contacts can delete cleanly.
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("first_name", TAG)
    check("cleanup verified — 0 seeded contacts remain", (count ?? 0) === 0, `got ${count}`)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Agent deactivation (reassign / archive) simulator")
  console.log("══════════════════════════════════════════════════")
  pureLayer()
  await liveLayer()
  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
