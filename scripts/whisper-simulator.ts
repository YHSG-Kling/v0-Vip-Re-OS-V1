#!/usr/bin/env tsx
/**
 * scripts/whisper-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE WHISPER harness — T-minus-30 hallway briefings in the user's ASSISTANT voice.
 *
 * Layer 1 (pure): whisperTierCapability (AUDIO on every tier — solo included) +
 *   buildWhisperScript (no fabricated sections; only facts the team actually has).
 * Layer 2 (live, gated): seed a contact appointment 30min out with team knowledge
 *   (signals, saved home), run produceAppointmentWhispers with an INJECTED synthesizer
 *   (vendor seam — no TTS spend), assert the whisper notification with the assembled
 *   brief + idempotency. Self-cleans.
 *
 * Run: npx tsx scripts/whisper-simulator.ts  (npm run test:whisper)
 */
import { whisperTierCapability, buildWhisperScript, produceAppointmentWhispers, type WhisperSynthesizer } from "../lib/intelligence/appointment-whisper"

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
  console.log(" ✅ The Whisper verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" The Whisper (T-30 briefing) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure]")
  check("tier: solo_agent → AUDIO whisper (no tier downgrade)", whisperTierCapability("solo_agent") === "audio")
  check("tier: team → audio whisper", whisperTierCapability("team") === "audio")
  check("tier: brokerage → audio whisper", whisperTierCapability("brokerage") === "audio")
  check("tier: multi_location → audio whisper", whisperTierCapability("multi_location") === "audio")

  const full = buildWhisperScript({
    contactName: "Jordan Henderson", appointmentTitle: "buyer consult", minutesUntil: 30,
    propensityReasons: ["high buying/selling intent", "recent life event"],
    savedHomes: 3, latestSave: "12 Oak St",
    managerTalk: ["AI ISA booked this on a dial call."], upcomingVendorVisit: "their inspection visit is scheduled 2026-06-15",
  })
  check("script: opens with who + when", full.startsWith("Heads up — Jordan Henderson in 30 minutes"))
  check("script: includes propensity, saves, talk, vendor", full.includes("high buying/selling intent") && full.includes("3 homes") && full.includes("dial call") && full.includes("inspection visit"))
  const sparse = buildWhisperScript({
    contactName: "Sam", appointmentTitle: null, minutesUntil: 28,
    propensityReasons: [], savedHomes: 0, latestSave: null, managerTalk: [], upcomingVendorVisit: null,
  })
  check("script: sparse facts → NO fabricated sections", !sparse.includes("saved") && !sparse.includes("likely to move") && sparse.includes("Go get them."))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live whisper]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__whisper_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const agentUserId = (agent as any).user_id

    const { data: con } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Whisper", last_name: TAG, intent_score: 90, engagement_score: 80,
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (con as any).id })
    const { data: sp } = await svc.from("saved_properties").insert({
      brokerage_id: brokerageId, contact_id: (con as any).id, user_id: agentUserId,
      property_address: `${TAG} 12 Oak St`, dismissed: false,
    }).select("id").single()
    cleanup.push({ table: "saved_properties", id: (sp as any).id })
    const { data: sig } = await svc.from("manager_signals").insert({
      brokerage_id: brokerageId, from_manager: "ai_isa", to_manager: "shopping_agent",
      signal_type: "note", message: `${TAG} AI ISA booked this on a dial call.`, contact_id: (con as any).id,
    }).select("id").single()
    cleanup.push({ table: "manager_signals", id: (sig as any).id })
    const { data: ev } = await svc.from("calendar_events").insert({
      brokerage_id: brokerageId, entity_type: "contact", entity_id: (con as any).id,
      event_type: "isa_appointment", title: `${TAG} buyer consult`, agent_user_id: agentUserId,
      start_at: new Date(Date.now() + 30 * 60_000).toISOString(), end_at: new Date(Date.now() + 90 * 60_000).toISOString(),
      deadline_notified: true,
    }).select("id").single()
    cleanup.push({ table: "calendar_events", id: (ev as any).id })

    // Injected synthesizer — the vendor seam; never spends TTS credits.
    let synthCalls = 0
    const synthesizer: WhisperSynthesizer = async () => { synthCalls += 1; return null }  // null → text fallback
    const r1 = await produceAppointmentWhispers(brokerageId, { synthesizer }, svc)
    check("whisper: produced for the 30-min-out appointment", r1.whispers >= 1)
    check("whisper: text fallback when synthesis yields no audio", r1.text >= 1)

    const { data: notif } = await svc.from("notifications").select("id, title, body, priority")
      .eq("user_id", agentUserId).eq("type", "whisper_brief").eq("entity_id", (ev as any).id).maybeSingle()
    if (notif) cleanup.push({ table: "notifications", id: (notif as any).id })
    check("whisper: notification delivered to the agent (high priority)", (notif as any)?.priority === "high")
    check("whisper: brief carries the team's actual knowledge (save + ISA talk)",
      ((notif as any)?.body ?? "").includes("12 Oak St") && ((notif as any)?.body ?? "").includes("dial call"))

    // Idempotency — a second run produces nothing for the same event.
    const r2 = await produceAppointmentWhispers(brokerageId, { synthesizer }, svc)
    check("idempotency: second run whispers nothing for the same event", r2.whispers === 0)
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
