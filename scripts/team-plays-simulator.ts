#!/usr/bin/env tsx
/**
 * scripts/team-plays-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * TEAM PLAYS (the huddle) harness — managers co-authoring ONE coordinated play per
 * client instead of spamming fragments.
 *
 * Layer 1 (pure): detectConferences (≥2 DISTINCT managers on one contact; one manager
 *   with two items is NOT a huddle) + composeTeamPlay (per-manager briefing sections,
 *   merged client message).
 * Layer 2 (live, gated): seed a contact with business from THREE managers — an open
 *   AI ISA signal + a Shopping Agent proposal + a Sphere proposal — run runTeamPlays,
 *   assert ONE play proposed (Campaign Orchestrator coordinates), the two fragment
 *   proposals are machine-superseded (rejected, send_error carries the play id, NO
 *   forged approver), the signal is folded in, and a second run is a no-op. Self-cleans.
 *
 * Run: npx tsx scripts/team-plays-simulator.ts  (npm run test:team-plays)
 */
import { detectConferences, composeTeamPlay, runTeamPlays, type PlayFragment } from "../lib/kernel/team-plays"

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
  console.log(" ✅ Team Plays (the huddle) verified")
}

const frag = (manager: PlayFragment["manager"], kind: PlayFragment["kind"], line: string, body?: string): PlayFragment =>
  ({ kind, id: `${manager}-${line}`, manager, managerLabel: String(manager), line, body })

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Team Plays (the huddle) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · detect + compose]")
  const conferences = detectConferences([
    { contactId: "c1", fragment: frag("ai_isa", "signal", "booked an appointment") },
    { contactId: "c1", fragment: frag("shopping_agent", "proposal", "price improved", "Price improved on a home you saved.") },
    { contactId: "c2", fragment: frag("sphere_of_influence", "proposal", "anniversary") },          // one manager only
    { contactId: "c2", fragment: frag("sphere_of_influence", "signal", "anniversary signal") },     // same manager again
    { contactId: null, fragment: frag("ai_isa", "signal", "no contact") },
  ])
  check("conference detected only where ≥2 DISTINCT managers (c1)", conferences.length === 1 && conferences[0].contactId === "c1")
  check("one manager with two items is NOT a huddle (c2 excluded)", !conferences.some((c) => c.contactId === "c2"))
  const play = composeTeamPlay(conferences[0], "Jordan Henderson")
  check("briefing names the convened managers + each contribution", play.briefing.includes("TEAM PLAY for Jordan Henderson") && play.briefing.includes("booked an appointment") && play.briefing.includes("price improved"))
  check("client message merges the proposal bodies into ONE note", play.body.includes("one note") && play.body.includes("Price improved on a home you saved."))
  check("briefing states the consolidation (replaces N touches)", /replaces 2 separate touches/.test(play.briefing))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live huddle]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__huddle_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    const brokerageId = (brk as any).id
    const { data: con } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Huddle", last_name: TAG, contact_type: "buyer",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (con as any).id })
    const contactId = (con as any).id

    // Business from THREE managers on the same client.
    const { data: sig } = await svc.from("manager_signals").insert({
      brokerage_id: brokerageId, from_manager: "ai_isa", to_manager: "shopping_agent",
      signal_type: "isa_call_appointment_unhandled", message: `${TAG} ISA booked Tuesday`, contact_id: contactId,
    }).select("id").single()
    cleanup.push({ table: "manager_signals", id: (sig as any).id })
    const { data: p1 } = await svc.from("agent_client_messages").insert({
      brokerage_id: brokerageId, agent_kind: "shopping_agent", entity_type: "listing", audience: "buyer",
      channel: "portal", recipient_contact_id: contactId, subject: `${TAG} price improved`,
      body: "Price improved on a home you saved.", status: "proposed", proposed_at: new Date().toISOString(),
    }).select("id").single()
    cleanup.push({ table: "agent_client_messages", id: (p1 as any).id })
    const { data: p2 } = await svc.from("agent_client_messages").insert({
      brokerage_id: brokerageId, agent_kind: "sphere_of_influence", entity_type: "contact", audience: "buyer",
      channel: "portal", recipient_contact_id: contactId, subject: `${TAG} anniversary`,
      body: "Happy one-year home anniversary!", status: "proposed", proposed_at: new Date().toISOString(),
    }).select("id").single()
    cleanup.push({ table: "agent_client_messages", id: (p2 as any).id })

    // THE HUDDLE.
    const r1 = await runTeamPlays(brokerageId, svc)
    check("huddle: a conference was detected", r1.conferences >= 1)
    check("huddle: exactly one play proposed for the contact", r1.playsProposed === 1)
    check("huddle: all three fragments absorbed", r1.fragmentsSuperseded >= 3)

    const { data: playMsg } = await svc.from("agent_client_messages")
      .select("id, agent_kind, status, rationale, body").eq("recipient_contact_id", contactId)
      .eq("agent_kind", "campaign_orchestrator").eq("status", "proposed").maybeSingle()
    if (playMsg) cleanup.push({ table: "agent_client_messages", id: (playMsg as any).id })
    check("play: ONE coordinated proposal (Campaign Orchestrator coordinates)", !!playMsg)
    check("play: briefing names the managers' contributions", ((playMsg as any)?.rationale ?? "").includes("TEAM PLAY") && ((playMsg as any)?.rationale ?? "").includes("ISA booked Tuesday"))
    check("play: client message merges both proposal bodies", ((playMsg as any)?.body ?? "").includes("Price improved") && ((playMsg as any)?.body ?? "").includes("anniversary"))
    if (playMsg) {
      const { data: rtN } = await svc.from("notifications").select("id").eq("entity_id", (playMsg as any).id).eq("type", "approval_needed").maybeSingle()
      if (rtN) cleanup.push({ table: "notifications", id: (rtN as any).id })
    }

    // Fragments machine-superseded — auditable, no forged human approval.
    const { data: p1After } = await svc.from("agent_client_messages").select("status, send_error, approved_by").eq("id", (p1 as any).id).single()
    check("fragment: superseded (rejected) with the play id recorded", (p1After as any).status === "rejected" && ((p1After as any).send_error ?? "").includes("superseded by team play"))
    check("fragment: NO forged human approver (approved_by stays null)", (p1After as any).approved_by === null)
    const { data: sigAfter } = await svc.from("manager_signals").select("status, consumed_action").eq("id", (sig as any).id).single()
    check("signal: folded into the play (consumed with the play id)", (sigAfter as any).status === "consumed" && ((sigAfter as any).consumed_action ?? "").includes("folded into team play"))

    // Idempotency — a second huddle does nothing (open play exists, fragments gone).
    const r2 = await runTeamPlays(brokerageId, svc)
    check("idempotency: second huddle proposes nothing", r2.playsProposed === 0)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("last_name", `${TAG}%`)
    check("cleanup verified — 0 seeded contacts remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
