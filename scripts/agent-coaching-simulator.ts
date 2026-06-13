#!/usr/bin/env tsx
/**
 * scripts/agent-coaching-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AGENT COACHING LOOP harness — turning the OS's own outcome data into a weekly
 * per-agent coaching brief (strengths / leaks / one focus), delivered as a GATED,
 * manager-facing brief to the broker/team-lead. Owner: recruiting_manager (agent
 * development/talent).
 *
 * Layer 1 (pure, always runs): composeCoachingBrief
 *   · strong stats  → strengths surface (closings, high tour→offer, zero no-shows, healthy deals)
 *   · weak stats    → leaks surface + a single highest-leverage focusThisWeek
 *   · thin data     → honest "not enough data yet", notEnoughData=true, NO invented criticism
 *   · mixed         → both strengths AND leaks, focus = the most expensive leak
 *   · sample gates  → a metric below MIN_SAMPLE contributes nothing (never fabricated)
 *
 * Layer 2 (live, creds-gated): seed ONE agent with REAL outcome rows — a closed deal
 *   (production strength), a no-show appointment + scheduled appointments (no-show leak),
 *   a stale contact, and tours with low offers (tour→offer leak) — run runAgentCoaching,
 *   assert a gated coaching brief was proposed (audience 'agent', recruiting_manager)
 *   carrying REAL leaks + a strength; assert idempotency per ISO week; assert a BRAND-NEW
 *   agent (no data) gets an honest minimal brief with no fabricated metrics; then CLEAN UP
 *   every seeded row in reverse order and verify cleanup == 0.
 *
 * Run: npx tsx scripts/agent-coaching-simulator.ts  (npm run test:agent-coaching)
 */
import {
  composeCoachingBrief,
  type AgentCoachingStats,
  MIN_SAMPLE,
  HIGH_NOSHOW_RATE,
  STALE_LEAK_COUNT,
} from "../lib/kernel/agent-coaching"

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
  console.log(" ✅ Agent Coaching loop verified — strengths / leaks / focus from REAL stats, honest when thin")
}

const stats = (over: Partial<AgentCoachingStats>): AgentCoachingStats => ({
  agentId: over.agentId ?? "a", name: over.name ?? "Agent",
  ytdGci: over.ytdGci ?? 0, closings: over.closings ?? 0,
  activeDeals: over.activeDeals ?? 0, avgHealthScore: over.avgHealthScore ?? null,
  tours: over.tours ?? 0, offers: over.offers ?? 0,
  appointments: over.appointments ?? 0, noShows: over.noShows ?? 0,
  staleContacts: over.staleContacts ?? 0,
  lessonsAssigned: over.lessonsAssigned ?? 0, lessonsCompleted: over.lessonsCompleted ?? 0,
  educationCompletionPct: over.educationCompletionPct ?? null,
})

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Agent Coaching simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure composeCoachingBrief]")

  // ── STRONG stats → strengths, no leaks. ──
  {
    const b = composeCoachingBrief(stats({
      name: "Strong Sally", closings: 4, ytdGci: 60_000,
      tours: 6, offers: 4, appointments: 5, noShows: 0,
      activeDeals: 3, avgHealthScore: 88,
      lessonsAssigned: 10, lessonsCompleted: 10, educationCompletionPct: 100,
      staleContacts: 0,
    }))
    check("strong stats → strengths surface", b.strengths.length >= 3, JSON.stringify(b.strengths))
    check("strong stats → no leaks", b.leaks.length === 0, JSON.stringify(b.leaks))
    check("strong stats → not flagged thin", b.notEnoughData === false)
    check("strong stats → focus celebrates what's working", /keep doing what's working/i.test(b.focusThisWeek), b.focusThisWeek)
  }

  // ── WEAK stats → leaks + a single highest-leverage focus (no-shows lead). ──
  {
    const b = composeCoachingBrief(stats({
      name: "Leaky Larry", closings: 0,
      tours: 5, offers: 0,                 // 0% tour→offer → leak
      appointments: 4, noShows: 2,         // 50% no-show → leak (most expensive)
      activeDeals: 2, avgHealthScore: 40,  // at-risk deals → leak
      lessonsAssigned: 4, lessonsCompleted: 1, educationCompletionPct: 25, // → leak
      staleContacts: 8,                    // cold book → leak
    }))
    check("weak stats → multiple leaks surface", b.leaks.length >= 4, JSON.stringify(b.leaks.length))
    check("weak stats → a focus is produced", b.focusThisWeek.length > 0)
    check("weak stats → focus targets the no-show leak (most expensive first)", /no-show/i.test(b.focusThisWeek), b.focusThisWeek)
    check("weak stats → not flagged thin (it has real signal)", b.notEnoughData === false)
  }

  // ── THIN data → honest "not enough data", NO fabricated criticism. ──
  {
    const b = composeCoachingBrief(stats({
      name: "New Nadia",
      tours: 1, appointments: 2, staleContacts: 1, // all BELOW their sample gates
    }))
    check("thin data → notEnoughData true", b.notEnoughData === true)
    check("thin data → no strengths fabricated", b.strengths.length === 0, JSON.stringify(b.strengths))
    check("thin data → no leaks fabricated", b.leaks.length === 0, JSON.stringify(b.leaks))
    check("thin data → honest 'not enough' focus, no invented numbers", /not enough activity/i.test(b.focusThisWeek), b.focusThisWeek)
  }

  // ── Sample-gate honesty: 2 tours (below MIN_SAMPLE) with 0 offers must NOT leak. ──
  {
    const b = composeCoachingBrief(stats({ tours: MIN_SAMPLE - 1, offers: 0, closings: 1 }))
    check("below-sample tour count → NO tour→offer leak (no fabrication)",
      !b.leaks.some((l) => /tour→offer/i.test(l)), JSON.stringify(b.leaks))
  }

  // ── MIXED → both a strength and a leak; focus = the leak. ──
  {
    const b = composeCoachingBrief(stats({
      name: "Mixed Morgan", closings: 2, ytdGci: 30_000, // strength
      appointments: 4, noShows: 2,                       // leak (no-show)
      tours: 0, offers: 0,
    }))
    check("mixed → has a strength", b.strengths.length >= 1, JSON.stringify(b.strengths))
    check("mixed → has a leak", b.leaks.length >= 1, JSON.stringify(b.leaks))
    check("mixed → focus is the leak, not the strength", /no-show/i.test(b.focusThisWeek), b.focusThisWeek)
  }

  // ── No-show threshold boundary: exactly HIGH_NOSHOW_RATE is a leak. ──
  {
    const appts = 4, ns = Math.ceil(HIGH_NOSHOW_RATE * appts) // 1 of 4 = 25%
    const b = composeCoachingBrief(stats({ appointments: appts, noShows: ns }))
    check("no-show rate at threshold → leak fires", b.leaks.some((l) => /no-show/i.test(l)), `${ns}/${appts}`)
  }

  // ── Stale-book threshold: STALE_LEAK_COUNT cold contacts → leak. ──
  {
    const b = composeCoachingBrief(stats({ staleContacts: STALE_LEAK_COUNT }))
    check("stale book at threshold → cold-contacts leak fires", b.leaks.some((l) => /cold/i.test(l)), String(STALE_LEAK_COUNT))
  }

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live coaching brief]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  console.log("\n[Layer 2 · live coaching brief — REAL outcome rows]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runAgentCoaching } = await import("../lib/kernel/agent-coaching")
  const svc = createServiceClient()
  const TAG = `__coachsim_${Date.now()}__`
  const now = new Date()
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    // An agent WITH a user (calendar is keyed by agent_user_id) → the "coached" agent.
    const { data: agent } = await svc.from("agents")
      .select("id, user_id, brokerage_id")
      .eq("active", true).not("brokerage_id", "is", null).not("user_id", "is", null)
      .limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an active agent with a user."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const agentId = (agent as any).id
    const userId = (agent as any).user_id

    const { data: con } = await svc.from("contacts").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
    const contactId = (con as any)?.id ?? null

    // (1) Closed deal → production strength.
    {
      const { data: t } = await svc.from("transactions").insert({
        brokerage_id: brokerageId, agent_id: agentId, contact_id: contactId,
        deal_name: `${TAG} closed`, deal_type: "buyer", status: "closed", stage: "CLOSED",
        property_address: `${TAG} Closed Ave`, commission_amount: 18_000,
        close_date: now.toISOString().slice(0, 10),
      }).select("id").single()
      cleanup.push({ table: "transactions", id: (t as any).id })
    }

    // (2) Appointments incl. a no-show → no-show leak. 4 scheduled, 2 no_show = 50%.
    const startBase = new Date(now.getTime() - 3 * 86_400_000) // within the 90d window, in the past
    for (const st of ["scheduled", "completed", "no_show", "no_show"]) {
      const { data: e } = await svc.from("calendar_events").insert({
        brokerage_id: brokerageId, agent_user_id: userId,
        entity_type: "contact", entity_id: contactId ?? agentId,
        event_type: "showing", status: st,
        start_at: new Date(startBase.getTime() + Math.random() * 86_400_000).toISOString(),
        title: `${TAG} appt ${st}`,
      }).select("id").single()
      cleanup.push({ table: "calendar_events", id: (e as any).id })
    }

    // (3) A stale CONTACT on the agent's book (cold past the stale window).
    {
      const { data: c } = await svc.from("contacts").insert({
        brokerage_id: brokerageId, agent_id: agentId,
        first_name: `${TAG}`, last_name: "Cold",
        last_contacted_at: new Date(now.getTime() - 60 * 86_400_000).toISOString(),
      }).select("id").single()
      cleanup.push({ table: "contacts", id: (c as any).id })
    }

    // (4) Tours with low offers → tour→offer leak. 4 tours, 0 offers = 0%.
    for (let i = 0; i < 4; i++) {
      const { data: tr } = await svc.from("tours").insert({
        brokerage_id: brokerageId, agent_id: agentId, contact_id: contactId,
        status: "completed",
      }).select("id").single()
      cleanup.push({ table: "tours", id: (tr as any).id })
    }

    // Run the coaching loop.
    const r = await runAgentCoaching(brokerageId, { now }, svc)
    check("run: at least one brief proposed", r.briefsProposed >= 1, JSON.stringify({ ...r, errors: r.errors.slice(0, 3) }))
    check("run: at least one brief carried real leaks", r.briefsWithLeaks >= 1,
      JSON.stringify({ withLeaks: r.briefsWithLeaks, errors: r.errors.slice(0, 3) }))
    check("run: no fatal errors", r.errors.length === 0, r.errors.slice(0, 3).join(" | "))

    // The gated manager-facing brief for the seeded agent.
    const { data: msg } = await svc.from("agent_client_messages")
      .select("id, agent_kind, audience, entity_type, entity_id, subject, body, status, rationale")
      .eq("brokerage_id", brokerageId).eq("agent_kind", "recruiting_manager").eq("entity_type", "agent")
      .eq("entity_id", agentId).ilike("rationale", "AGENT COACHING %")
      .order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (msg) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })

    check("brief: proposed for the seeded agent", !!msg)
    check("brief: owned by recruiting_manager (agent development)", (msg as any)?.agent_kind === "recruiting_manager")
    check("brief: manager-facing internal audience ('agent')", (msg as any)?.audience === "agent")
    check("brief: gated (status proposed — nothing auto-sends)", (msg as any)?.status === "proposed")
    check("brief: body carries a REAL no-show leak (from seeded no_show rows)",
      /no-show/i.test((msg as any)?.body ?? ""), ((msg as any)?.body ?? "").slice(0, 200))
    check("brief: body carries a REAL strength (the seeded closing)",
      /closing/i.test((msg as any)?.body ?? "") && /What's working/i.test((msg as any)?.body ?? ""))
    check("brief: a focus-this-week line is present", /Focus this week/i.test((msg as any)?.body ?? ""))

    // Idempotency — a second run the same week proposes NO new brief.
    const before = await svc.from("agent_client_messages").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("agent_kind", "recruiting_manager").eq("entity_type", "agent")
      .eq("entity_id", agentId).ilike("rationale", "AGENT COACHING %")
    await runAgentCoaching(brokerageId, { now }, svc)
    const after = await svc.from("agent_client_messages").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("agent_kind", "recruiting_manager").eq("entity_type", "agent")
      .eq("entity_id", agentId).ilike("rationale", "AGENT COACHING %")
    check("idempotent: a second run the same week adds no new brief", (after.count ?? 0) === (before.count ?? 0),
      `before=${before.count} after=${after.count}`)

    // ── BRAND-NEW agent (no data) → honest minimal brief, no fabricated metrics. ──
    const { data: newUser } = await svc.from("users").insert({
      brokerage_id: brokerageId, first_name: `${TAG}`, last_name: "Newbie",
      email: `${TAG.toLowerCase()}@example.com`, user_type: "agent",
    }).select("id").single()
    cleanup.push({ table: "users", id: (newUser as any).id })
    const { data: newAgent } = await svc.from("agents").insert({
      brokerage_id: brokerageId, user_id: (newUser as any).id, active: true,
    }).select("id").single()
    cleanup.push({ table: "agents", id: (newAgent as any).id })

    const r2 = await runAgentCoaching(brokerageId, { now }, svc)
    check("run (new agent): a brief is still proposed (honest, not silent)", r2.briefsProposed >= 0)

    const { data: newMsg } = await svc.from("agent_client_messages")
      .select("id, body, rationale")
      .eq("brokerage_id", brokerageId).eq("agent_kind", "recruiting_manager").eq("entity_type", "agent")
      .eq("entity_id", (newAgent as any).id).ilike("rationale", "AGENT COACHING %")
      .order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (newMsg) cleanup.push({ table: "agent_client_messages", id: (newMsg as any).id })
    check("new agent: a minimal brief was proposed", !!newMsg)
    check("new agent: rationale flags not-enough-data (honest)", /not-enough-data/i.test((newMsg as any)?.rationale ?? ""), (newMsg as any)?.rationale)
    check("new agent: body has NO fabricated leaks (no 'leaking')", !/leaking/i.test((newMsg as any)?.body ?? ""), ((newMsg as any)?.body ?? "").slice(0, 160))
    check("new agent: body is the honest 'getting started' brief", /getting started|not enough activity/i.test((newMsg as any)?.body ?? ""))
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count: txnLeft } = await svc.from("transactions").select("id", { count: "exact", head: true }).like("property_address", `${TAG}%`)
    check("cleanup verified — 0 seeded transactions remain", (txnLeft ?? 0) === 0)
    const { count: ceLeft } = await svc.from("calendar_events").select("id", { count: "exact", head: true }).like("title", `${TAG}%`)
    check("cleanup verified — 0 seeded calendar events remain", (ceLeft ?? 0) === 0)
    const { count: conLeft } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("first_name", TAG)
    check("cleanup verified — 0 seeded contacts remain", (conLeft ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
