#!/usr/bin/env tsx
/**
 * scripts/appointment-noshow-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * APPOINTMENT NO-SHOW / RESCHEDULE AUTOPILOT harness.
 *
 * Layer 1 (pure): classifyAppointment boundaries — upcoming-due vs not-yet; missed past
 *   grace vs within grace; completed/cancelled/no_show → ok. rebookPlan / reminderPlan
 *   proposal shape.
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY): seed a contact + a MISSED appt
 *   (past start, status scheduled) → run → assert no_show recorded on the calendar_event
 *   + audit lifecycle_event + ONE gated re-book proposal + re-engage eligibility fired +
 *   idempotent rerun (no duplicate proposal, no second no_show); an UPCOMING appt → ONE
 *   reminder, idempotent; a COMPLETED appt → no action. Reverse-delete + cleanup count==0.
 *
 * Run: npx tsx scripts/appointment-noshow-simulator.ts  (npm run test:appointment-noshow)
 */
import {
  classifyAppointment,
  rebookPlan,
  reminderPlan,
  runAppointmentNoShowAutopilot,
  DEFAULT_GRACE_MINUTES,
  DEFAULT_REMINDER_WINDOW_HOURS,
} from "../lib/kernel/appointment-noshow-autopilot"

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
  console.log(" ✅ Appointment no-show autopilot verified")
}

const now = new Date("2026-06-13T18:00:00Z")
const min = (n: number) => new Date(now.getTime() + n * 60_000).toISOString()
const hr = (n: number) => new Date(now.getTime() + n * 3_600_000).toISOString()

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Appointment No-Show Autopilot simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · classifyAppointment boundaries + proposal shapes]")

  // MISSED: past start by more than grace, still scheduled.
  check("missed: start past by > grace AND scheduled → missed_noshow",
    classifyAppointment(now, { start_at: min(-(DEFAULT_GRACE_MINUTES + 30)), status: "scheduled" }) === "missed_noshow")
  // Within grace: late but not yet a no-show.
  check("within grace: start past but < grace → ok (merely late, not a no-show)",
    classifyAppointment(now, { start_at: min(-(DEFAULT_GRACE_MINUTES - 30)), status: "scheduled" }) === "ok")
  // Exactly at grace boundary → missed (<= -grace).
  check("grace boundary: exactly -grace → missed_noshow",
    classifyAppointment(now, { start_at: min(-DEFAULT_GRACE_MINUTES), status: null }) === "missed_noshow")
  // null status is treated as scheduled.
  check("missed: null status past grace → missed_noshow (null = scheduled)",
    classifyAppointment(now, { start_at: min(-(DEFAULT_GRACE_MINUTES + 60)), status: null }) === "missed_noshow")

  // UPCOMING reminder due: inside the reminder window and beyond min lead.
  check("upcoming: start in 5h (inside 24h window) → upcoming_reminder_due",
    classifyAppointment(now, { start_at: hr(5), status: "scheduled" }) === "upcoming_reminder_due")
  // Not yet: start beyond the reminder window.
  check("not-yet: start in (window+5)h → ok (outside reminder window)",
    classifyAppointment(now, { start_at: hr(DEFAULT_REMINDER_WINDOW_HOURS + 5), status: "scheduled" }) === "ok")
  // Too soon (under min lead): about to start, no reminder.
  check("min-lead: start in 10 min (< 30 min lead) → ok (no last-second reminder)",
    classifyAppointment(now, { start_at: min(10), status: "scheduled" }) === "ok")
  check("upcoming boundary: start in exactly 30 min → upcoming_reminder_due",
    classifyAppointment(now, { start_at: min(30), status: "scheduled" }) === "upcoming_reminder_due")

  // Terminal statuses → ok regardless of time.
  check("completed past appt → ok", classifyAppointment(now, { start_at: min(-300), status: "completed" }) === "ok")
  check("cancelled upcoming appt → ok", classifyAppointment(now, { start_at: hr(5), status: "cancelled" }) === "ok")
  check("already no_show → ok (terminal, won't re-fire)", classifyAppointment(now, { start_at: min(-300), status: "no_show" }) === "ok")

  // Proposal shapes.
  const apptStub = { id: "appt-1", brokerage_id: "brk-1", title: "Buyer Consultation" }
  const contactStub = { id: "ct-1", first_name: "Dana", contact_type: "buyer_lead" }
  const rb = rebookPlan(apptStub, contactStub)
  check("rebookPlan: deal_coordinator + calendar_event + portal + NO-SHOW rationale + warm copy",
    rb.agentKind === "deal_coordinator" && rb.entityType === "calendar_event" && rb.entityId === "appt-1" &&
    rb.recipientContactId === "ct-1" && rb.channel === "portal" && rb.audience === "buyer" &&
    rb.rationale.startsWith("APPOINTMENT NO-SHOW") && /reschedule|new times?/i.test(rb.body) && rb.body.includes("Dana"))
  const rem = reminderPlan(apptStub, contactStub, { firstName: "Dana", title: "Buyer Consultation", startAt: hr(5) })
  check("reminderPlan: gated portal reminder, REMINDER rationale, names client + appt",
    rem.agentKind === "deal_coordinator" && rem.channel === "portal" &&
    rem.rationale.startsWith("APPOINTMENT REMINDER") && rem.body.includes("Dana") && /reminder/i.test(rem.subject))
  const seller = rebookPlan(apptStub, { id: "ct-2", first_name: null, contact_type: "seller" })
  check("rebookPlan: seller contact_type → seller audience, graceful no-name copy",
    seller.audience === "seller" && seller.body.includes("there"))

  // ── Layer 2 ──
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live autopilot]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `ApptNS${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []
  const liveNow = new Date()
  const lmin = (n: number) => new Date(liveNow.getTime() + n * 60_000).toISOString()

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const agentUserId = (agent as any).user_id
    const agentRowId = (agent as any).id

    console.log("\n[Layer 2 · live autopilot]")

    // Helper to seed a contact.
    async function seedContact(suffix: string, extra: Record<string, unknown> = {}): Promise<string> {
      const { data } = await svc.from("contacts").insert({
        brokerage_id: brokerageId, first_name: `${TAG}${suffix}`, last_name: "NoShowTest",
        contact_type: "buyer", agent_id: agentRowId, isa_reengage_allowed: true,
        dnc_status: false, ...extra,
      }).select("id").single()
      cleanup.push({ table: "contacts", id: (data as any).id })
      return (data as any).id
    }
    // Helper to seed a calendar_event appointment.
    async function seedAppt(contactId: string, startAt: string, status: string, title: string): Promise<string> {
      const { data } = await svc.from("calendar_events").insert({
        brokerage_id: brokerageId, agent_user_id: agentUserId,
        entity_type: "contact", entity_id: contactId, event_type: "buyer_consultation",
        title, start_at: startAt, end_at: new Date(new Date(startAt).getTime() + 3_600_000).toISOString(),
        timezone_name: "America/New_York", is_system_generated: true, status,
      }).select("id").single()
      cleanup.push({ table: "calendar_events", id: (data as any).id })
      return (data as any).id
    }

    // MISSED appt: start 3h ago, scheduled.
    const missedContact = await seedContact("Missed")
    const missedAppt = await seedAppt(missedContact, lmin(-180), "scheduled", `${TAG} Missed Consult`)
    // UPCOMING appt: start in 5h, scheduled.
    const upcomingContact = await seedContact("Upcoming")
    const upcomingAppt = await seedAppt(upcomingContact, new Date(liveNow.getTime() + 5 * 3_600_000).toISOString(), "scheduled", `${TAG} Upcoming Consult`)
    // COMPLETED appt: start 3h ago, completed → no action.
    const doneContact = await seedContact("Done")
    const doneAppt = await seedAppt(doneContact, lmin(-180), "completed", `${TAG} Done Consult`)

    // Injected re-engage seam — NO real outreach spend.
    let reengageCalls = 0
    const fakeReengage = async (_contactId: string) => { reengageCalls++; return { success: true } }

    const r1 = await runAppointmentNoShowAutopilot(brokerageId, { now: liveNow, reengage: fakeReengage }, svc)
    check("run: ≥1 no-show marked, ≥1 re-book proposed, ≥1 reminder proposed",
      r1.noShowsMarked >= 1 && r1.rebooksProposed >= 1 && r1.remindersProposed >= 1)
    check("run: re-engage loop fired for the missed contact", reengageCalls >= 1)

    // MISSED: calendar_event flipped to no_show.
    const { data: missedRow } = await svc.from("calendar_events").select("status, metadata").eq("id", missedAppt).single()
    check("MISSED: calendar_event.status === 'no_show' (canonical record)",
      (missedRow as any)?.status === "no_show" && !!(missedRow as any)?.metadata?.no_show_marked_at)

    // MISSED: audit lifecycle_event written.
    const { data: le } = await svc.from("lifecycle_events").select("id")
      .eq("entity_id", missedContact).eq("event_type", "appointment_no_show").maybeSingle()
    if (le) cleanup.push({ table: "lifecycle_events", id: (le as any).id })
    check("MISSED: audit lifecycle_event 'appointment_no_show' recorded", !!le)

    // MISSED: exactly ONE gated re-book proposal.
    const { data: rebooks } = await svc.from("agent_client_messages")
      .select("id, status, agent_kind, audience")
      .eq("entity_type", "calendar_event").eq("entity_id", missedAppt).ilike("rationale", "APPOINTMENT NO-SHOW%")
    for (const m of (rebooks ?? []) as any[]) cleanup.push({ table: "agent_client_messages", id: m.id })
    check("MISSED: exactly ONE gated re-book proposal (deal_coordinator, proposed)",
      (rebooks ?? []).length === 1 && (rebooks as any)[0].status === "proposed" && (rebooks as any)[0].agent_kind === "deal_coordinator")

    // UPCOMING: exactly ONE reminder proposal.
    const { data: reminders } = await svc.from("agent_client_messages")
      .select("id, status").eq("entity_type", "calendar_event").eq("entity_id", upcomingAppt).ilike("rationale", "APPOINTMENT REMINDER%")
    for (const m of (reminders ?? []) as any[]) cleanup.push({ table: "agent_client_messages", id: m.id })
    check("UPCOMING: exactly ONE gated reminder proposal", (reminders ?? []).length === 1)

    // COMPLETED: no action — no proposals, status unchanged.
    const { data: doneProps } = await svc.from("agent_client_messages").select("id")
      .eq("entity_type", "calendar_event").eq("entity_id", doneAppt)
    const { data: doneRow } = await svc.from("calendar_events").select("status").eq("id", doneAppt).single()
    check("COMPLETED: no proposal AND status stays 'completed' (no action)",
      (doneProps ?? []).length === 0 && (doneRow as any)?.status === "completed")

    // Clean up approval_needed notifications proposeClientMessage may have written.
    for (const m of [...(rebooks ?? []), ...(reminders ?? [])] as any[]) {
      const { data: ns } = await svc.from("notifications").select("id").eq("entity_id", m.id).eq("type", "approval_needed").limit(3)
      for (const n of (ns ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    }

    // IDEMPOTENT rerun — no new proposals, no second no_show flip.
    reengageCalls = 0
    const r2 = await runAppointmentNoShowAutopilot(brokerageId, { now: liveNow, reengage: fakeReengage }, svc)
    const { data: rebooks2 } = await svc.from("agent_client_messages").select("id")
      .eq("entity_type", "calendar_event").eq("entity_id", missedAppt).ilike("rationale", "APPOINTMENT NO-SHOW%")
    const { data: reminders2 } = await svc.from("agent_client_messages").select("id")
      .eq("entity_type", "calendar_event").eq("entity_id", upcomingAppt).ilike("rationale", "APPOINTMENT REMINDER%")
    check("IDEMPOTENT: rerun marks no new no-shows + adds no duplicate proposals",
      r2.noShowsMarked === 0 && (rebooks2 ?? []).length === 1 && (reminders2 ?? []).length === 1)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("first_name", `${TAG}%`)
    check("cleanup verified — 0 seeded contacts remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
