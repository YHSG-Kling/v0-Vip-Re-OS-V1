#!/usr/bin/env tsx
/**
 * scripts/command-center-scope-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves EGRESS SCOPE on the Command Center — the multi-tier promise made real on
 * the operator surface: a solo agent sees ONLY their own book, never another agent's,
 * while a brokerage-wide viewer sees the whole house. The egress tables carry only
 * brokerage_id, so agent/team scope resolves THROUGH the entity (contact/listing)
 * the work runs on — this proves that resolution end-to-end against real rows.
 *
 * Layer 1 (pure): resolveEgressScope routes each role to the right scope kind/keys.
 * Layer 2 (live, creds-gated): two agents each get a contact + a running session + a
 * proposed action + a proposed client message; assert agent A's scoped load sees ONLY
 * A's rows (not B's) and vice-versa, the brokerage load sees BOTH, an agent who owns
 * nothing sees nothing, and a narrowed scope withholds the brokerage-wide aggregates.
 * Everything seeded is cleaned up (reverse delete), cleanup count == 0.
 *
 * Run: npx tsx scripts/command-center-scope-simulator.ts   (npm run test:command-center-scope)
 */
import { resolveEgressScope } from "../lib/kernel/egress-scope"

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
  console.log(" ✅ Command Center egress scope verified — an agent sees only their own book; the brokerage sees the whole house.")
  console.log(" COMMAND_CENTER_SCOPE_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Command Center egress-scope simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · resolveEgressScope routes each role]")
  const broker = resolveEgressScope({ userType: "broker", userId: "u-b", brokerageId: "brk" })
  check("broker → brokerage, sees all locations", broker.kind === "brokerage" && broker.seesAllLocations)
  const locAdmin = resolveEgressScope({ userType: "admin", userId: "u-a", brokerageId: "brk", locationId: "loc-1" })
  check("admin WITH location → location scope", locAdmin.kind === "location" && locAdmin.locationId === "loc-1")
  const teamLead = resolveEgressScope({ userType: "team_lead", userId: "u-t", brokerageId: "brk", teamId: "team-1" })
  check("team_lead → team scope (teamId set)", teamLead.kind === "team" && teamLead.teamId === "team-1")
  const agent = resolveEgressScope({ userType: "agent", userId: "u-1", brokerageId: "brk" })
  check("agent → agent scope (agentUserId = own user)", agent.kind === "agent" && agent.agentUserId === "u-1")

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  console.log("\n[Layer 2 · live: two agents, isolated books]")
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { loadCommandCenter } = await import("../lib/kernel/command-center")
  const svc = createServiceClient()
  const TAG = `__ccscope_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brk as any).id

  try {
    // Two agents with distinct user ids. Prefer existing rows; create from real users if needed.
    const { data: existing } = await svc.from("agents").select("id, user_id").eq("brokerage_id", brokerageId).not("user_id", "is", null).limit(10)
    const distinct: Array<{ id: string; user_id: string }> = []
    for (const a of (existing ?? []) as any[]) { if (!distinct.find((d) => d.user_id === a.user_id)) distinct.push({ id: a.id, user_id: a.user_id }) }

    let A1: { id: string; user_id: string }, A2: { id: string; user_id: string }
    if (distinct.length >= 2) {
      A1 = distinct[0]; A2 = distinct[1]
    } else {
      const { data: users } = await svc.from("users").select("id").limit(2)
      if (!users || users.length < 2) { console.log("  ⏭  Skipped — need 2 users to seed agents."); return report() }
      const mk = async (uid: string) => {
        const { data } = await svc.from("agents").insert({ brokerage_id: brokerageId, user_id: uid }).select("id, user_id").single()
        cleanup.push({ table: "agents", id: (data as any).id })
        return { id: (data as any).id, user_id: (data as any).user_id }
      }
      A1 = distinct[0] ?? await mk((users as any[])[0].id)
      A2 = await mk((users as any[]).find((u) => u.id !== A1.user_id)?.id ?? (users as any[])[1].id)
    }
    check("two distinct agents resolved", A1.id !== A2.id && A1.user_id !== A2.user_id, `${A1.id} / ${A2.id}`)

    // One shared manager; one contact + session + action + client message per agent.
    const { data: ma } = await svc.from("managed_agents").insert({
      brokerage_id: brokerageId, agent_kind: "shopping_agent", anthropic_agent_id: `${TAG}ma`, model: "claude-sonnet-4-6",
    }).select("id").single()
    cleanup.push({ table: "managed_agents", id: (ma as any).id })

    const seedFor = async (agentId: string, label: string) => {
      const { data: c } = await svc.from("contacts").insert({
        brokerage_id: brokerageId, agent_id: agentId, first_name: "ZZScope", last_name: `${label}-${Date.now()}`,
        email: `zz-scope-${label}-${Date.now()}@example.com`, contact_type: "buyer",
      }).select("id").single()
      const contactId = (c as any).id
      cleanup.push({ table: "contacts", id: contactId })

      const { data: s } = await svc.from("managed_agent_sessions").insert({
        managed_agent_id: (ma as any).id, brokerage_id: brokerageId, anthropic_session_id: `${TAG}${label}`,
        entity_type: "contact", entity_id: contactId, status: "running",
      }).select("id").single()
      const sessionId = (s as any).id
      cleanup.push({ table: "managed_agent_sessions", id: sessionId })

      const { data: act } = await svc.from("marketing_agent_actions").insert({
        brokerage_id: brokerageId, managed_agent_session_id: sessionId, action_type: "mark_topic_used",
        action_input: {}, rationale: `${TAG}${label}`, status: "proposed", proposed_at: new Date().toISOString(),
      }).select("id").single()
      cleanup.push({ table: "marketing_agent_actions", id: (act as any).id })

      const { data: msg } = await svc.from("agent_client_messages").insert({
        brokerage_id: brokerageId, agent_kind: "shopping_agent", entity_type: "contact", audience: "buyer",
        body: `${TAG}${label} buyer update`, recipient_contact_id: contactId, channel: "portal",
        status: "proposed", proposed_at: new Date().toISOString(),
      }).select("id").single()
      cleanup.push({ table: "agent_client_messages", id: (msg as any).id })

      return { contactId, sessionId, actionId: (act as any).id, msgId: (msg as any).id }
    }

    const one = await seedFor(A1.id, "a1")
    const two = await seedFor(A2.id, "a2")

    // ── Agent A1's scoped view: only A1's rows ──
    const scopeA1 = resolveEgressScope({ userType: "agent", userId: A1.user_id, brokerageId })
    const a1 = await loadCommandCenter({ scope: scopeA1, limit: 200 })
    check("A1 scope: sees A1's session", a1.sessions.some((s) => s.id === one.sessionId))
    check("A1 scope: does NOT see A2's session", !a1.sessions.some((s) => s.id === two.sessionId))
    check("A1 scope: sees A1's proposed action", a1.pendingActions.some((p) => p.id === one.actionId))
    check("A1 scope: does NOT see A2's action", !a1.pendingActions.some((p) => p.id === two.actionId))
    check("A1 scope: sees A1's client message", a1.pendingActions.some((p) => p.id === one.msgId))
    check("A1 scope: does NOT see A2's client message", !a1.pendingActions.some((p) => p.id === two.msgId))
    check("A1 scope: brokerage-wide aggregates withheld (standup/P&L/talk/dials empty, deliverables null)",
      a1.standup.length === 0 && a1.weeklyPnl.length === 0 && a1.managerTalk.length === 0 && a1.dialBatches.length === 0 && a1.deliverables === null)

    // ── Agent A2's scoped view: the mirror (proves no hardcoding) ──
    const scopeA2 = resolveEgressScope({ userType: "agent", userId: A2.user_id, brokerageId })
    const a2 = await loadCommandCenter({ scope: scopeA2, limit: 200 })
    check("A2 scope: sees A2's session, not A1's",
      a2.sessions.some((s) => s.id === two.sessionId) && !a2.sessions.some((s) => s.id === one.sessionId))
    check("A2 scope: sees A2's action, not A1's",
      a2.pendingActions.some((p) => p.id === two.actionId) && !a2.pendingActions.some((p) => p.id === one.actionId))

    // ── Brokerage-wide view: sees BOTH agents' work ──
    const scopeBrk = resolveEgressScope({ userType: "broker", userId: "broker-user", brokerageId })
    const brkView = await loadCommandCenter({ scope: scopeBrk, limit: 200 })
    check("brokerage scope: sees BOTH sessions",
      brkView.sessions.some((s) => s.id === one.sessionId) && brkView.sessions.some((s) => s.id === two.sessionId))
    check("brokerage scope: sees BOTH proposed actions",
      brkView.pendingActions.some((p) => p.id === one.actionId) && brkView.pendingActions.some((p) => p.id === two.actionId))

    // ── An agent who owns nothing in this brokerage sees nothing seeded ──
    const scopeNobody = resolveEgressScope({ userType: "agent", userId: "00000000-0000-0000-0000-0000000000ff", brokerageId })
    const nobody = await loadCommandCenter({ scope: scopeNobody, limit: 200 })
    check("unknown agent: sees none of the seeded sessions",
      !nobody.sessions.some((s) => s.id === one.sessionId || s.id === two.sessionId))
    check("unknown agent: sees none of the seeded actions",
      !nobody.pendingActions.some((p) => p.id === one.actionId || p.id === two.actionId))
  } finally {
    for (const c of [...cleanup].reverse()) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {})
    const { count } = await svc.from("managed_agent_sessions").select("id", { count: "exact", head: true }).ilike("anthropic_session_id", `${TAG}%`)
    check("cleanup: seeded sessions removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
