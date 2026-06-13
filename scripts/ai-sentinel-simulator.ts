#!/usr/bin/env tsx
/**
 * scripts/ai-sentinel-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AI SENTINEL (license-risk sentiment escalation) harness — the live-kernel
 * equivalent of the legacy workflows/negative-feedback-escalation.json.
 *
 * Layer 1 (pure): classifyLicenseRisk —
 *   · critical phrases (lawyer / "report you to the board" / discrimination) → 'critical'
 *   · strong dissatisfaction / "speak to your manager" → 'elevated'
 *   · normal / positive → 'none' (HONEST no-op — never fabricates a risk)
 *   · Fair-Housing protected-class grievance (REUSED FAIR_HOUSING_PATTERNS) → 'critical'
 *
 * Layer 2 (live, guarded): seed a contact + a CRITICAL-risk inbound message →
 *   runSentinelOnInbound → assert automation HALTED (contacts.isa_reengage_allowed=false
 *   + dnc_status) + a broker-escalation notification carrying the signals + a recorded
 *   incident on the activities ledger + NO auto-reply; a 'none' message → no-op; an
 *   idempotent rerun → no duplicate escalation; reverse-delete + cleanup count == 0.
 *
 * No mocks / stubs / demo data — real Supabase rows, self-cleaning.
 *
 * Run: npx tsx scripts/ai-sentinel-simulator.ts  (npm run test:ai-sentinel)
 */
import { classifyLicenseRisk, runSentinelOnInbound } from "../lib/kernel/ai-sentinel"

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
  console.log(" ✅ AI Sentinel (license-risk escalation) verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" AI Sentinel (license-risk sentiment escalation) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · classifyLicenseRisk — pure]")

  // ── CRITICAL: explicit legal / regulatory / discrimination moves ──
  const lawyer = classifyLicenseRisk("This is unacceptable. My lawyer will be in touch about this.")
  check("legal threat (lawyer) → critical", lawyer.tier === "critical" && lawyer.signals.some(s => s.includes("lawyer")))

  const board = classifyLicenseRisk("I'm going to report you to the state real estate commission.")
  check("board complaint → critical", board.tier === "critical" && board.signals.some(s => s.includes("board") || s.includes("complaint")))

  const sue = classifyLicenseRisk("I will sue your brokerage for breach of contract.")
  check("sue / breach → critical", sue.tier === "critical" && (sue.signals.some(s => s.includes("sue")) || sue.signals.some(s => s.includes("breach"))))

  const discrim = classifyLicenseRisk("You discriminated against me and steered me away from that neighborhood.")
  check("discrimination accusation → critical", discrim.tier === "critical" && discrim.signals.some(s => s.includes("discrimination")))

  const filed = classifyLicenseRisk("I'm filing a formal complaint with HUD.")
  check("HUD formal complaint → critical", filed.tier === "critical")

  // ── CRITICAL via REUSED Fair-Housing patterns (protected-class grievance) ──
  const fhFamilial = classifyLicenseRisk("You only showed me places because you said it was perfect for families — I have kids and feel targeted.")
  check("Fair-Housing protected-class grievance → critical (reused patterns)",
    fhFamilial.tier === "critical" && fhFamilial.signals.some(s => s.startsWith("fair-housing grievance")))

  const fhProtectedClass = classifyLicenseRisk("I believe you treated me differently because of my familial status.")
  check("explicit protected-class ('familial status') → critical",
    fhProtectedClass.tier === "critical")

  // ── ELEVATED: strong dissatisfaction / escalation, not yet legal ──
  const manager = classifyLicenseRisk("I want to speak to your manager immediately.")
  check("'speak to your manager' → elevated", manager.tier === "elevated" && manager.signals.some(s => s.includes("escalation")))

  const furious = classifyLicenseRisk("I am absolutely furious — this is the worst service I have ever received.")
  check("severe dissatisfaction → elevated", furious.tier === "elevated")

  const lied = classifyLicenseRisk("You lied to me about the closing costs.")
  check("accusation of dishonesty → elevated", lied.tier === "elevated")

  // ── NONE: normal / positive / plain opt-out (Sentinel is honest, no false alarms) ──
  const positive = classifyLicenseRisk("Thanks so much, this looks great! When can we tour it?")
  check("positive reply → none", positive.tier === "none" && positive.signals.length === 0)

  const neutral = classifyLicenseRisk("What's the square footage and the HOA fee?")
  check("neutral question → none", neutral.tier === "none")

  const optOut = classifyLicenseRisk("Not interested, please stop emailing me.")
  check("plain opt-out (not a license risk) → none (the seed's halt owns this)", optOut.tier === "none")

  const empty = classifyLicenseRisk("")
  check("empty text → none", empty.tier === "none")

  // ── Tier precedence: critical wins over co-present elevated language ──
  const mixed = classifyLicenseRisk("This is outrageous and unacceptable — my attorney will be calling you.")
  check("critical wins when both tiers' language is present", mixed.tier === "critical")

  // ── Layer 2: live ──
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live halt + escalate]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__sentinel_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    // A real brokerage with at least one broker/admin/compliance recipient to escalate to.
    const { data: recipient } = await svc.from("users")
      .select("id, brokerage_id")
      .in("user_type", ["broker", "admin", "compliance_officer"])
      .not("brokerage_id", "is", null)
      .limit(1).maybeSingle()
    if (!recipient) { console.log("\n[Layer 2] ⏭  Skipped — need a broker/admin/compliance user."); report(); return }
    const brokerageId = (recipient as any).brokerage_id

    console.log("\n[Layer 2 · live halt + escalate]")

    // ── Seed a CONTACT, ISA-engageable (isa_reengage_allowed=true) ──
    const { data: contact } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Sentinel", last_name: TAG,
      isa_reengage_allowed: true, dnc_status: false,
    }).select("id, isa_reengage_allowed, dnc_status").single()
    cleanup.push({ table: "contacts", id: (contact as any).id })
    const contactId = (contact as any).id
    check("seed: contact starts ISA-engageable", (contact as any).isa_reengage_allowed === true && (contact as any).dnc_status === false)

    // ── A CRITICAL-risk inbound message → run the Sentinel ──
    const criticalMsg = "You discriminated against me and my lawyer will be reporting your brokerage to the real estate board."
    const r1 = await runSentinelOnInbound({ contactId, text: criticalMsg, brokerageId }, svc)
    check("run: classified CRITICAL", r1.tier === "critical")
    check("run: automation halted", r1.halted === true)
    check("run: escalated to ≥1 broker/compliance recipient", r1.escalated >= 1)
    check("run: NOT flagged already-handled on first pass", r1.alreadyHandled === false)

    // ── Assert the HALT landed on the contact (reused opt-out fields) ──
    const { data: halted } = await svc.from("contacts").select("isa_reengage_allowed, dnc_status").eq("id", contactId).single()
    check("halt: contacts.isa_reengage_allowed=false (ISA dormant)", (halted as any).isa_reengage_allowed === false)
    check("halt: critical → dnc_status=true (hard suppression like opt-out)", (halted as any).dnc_status === true)

    // ── Assert the broker ESCALATION notification carries the signals + the message + NO auto-reply ──
    const { data: notif } = await svc.from("notifications")
      .select("id, type, title, body, priority, entity_type, entity_id")
      .eq("type", "ai_sentinel_license_risk").eq("entity_type", "contact").eq("entity_id", contactId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle()
    // collect ALL escalations for cleanup (one per recipient)
    const { data: allNotifs } = await svc.from("notifications").select("id")
      .eq("type", "ai_sentinel_license_risk").eq("entity_id", contactId)
    for (const n of (allNotifs ?? []) as Array<{ id: string }>) cleanup.push({ table: "notifications", id: n.id })
    check("escalation: a broker notification exists", !!notif)
    check("escalation: priority CRITICAL", (notif as any)?.priority === "critical")
    check("escalation: carries the matched signals", ((notif as any)?.body ?? "").toLowerCase().includes("discrimination") && ((notif as any)?.body ?? "").includes("lawyer"))
    check("escalation: carries the message + states no auto-reply", ((notif as any)?.body ?? "").includes("No automated reply was sent"))

    // ── Assert the INCIDENT was recorded on the canonical activities ledger ──
    const { data: incident } = await svc.from("activities")
      .select("id, activity_type, status, notes, contact_id")
      .eq("activity_type", "ai_sentinel_license_risk").eq("contact_id", contactId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (incident) cleanup.push({ table: "activities", id: (incident as any).id })
    check("incident: recorded on the activities ledger", !!incident && (incident as any).status === "open")
    check("incident: notes flag no_auto_reply + tier", (() => {
      try { const n = JSON.parse((incident as any)?.notes ?? "{}"); return n.no_auto_reply === true && n.tier === "critical" } catch { return false }
    })())

    // ── Audit line on the manager bus, consumed inline ──
    const { data: sig } = await svc.from("manager_signals").select("id, status, consumed_action")
      .eq("entity_id", contactId).eq("signal_type", "license_risk_escalated")
      .order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (sig) cleanup.push({ table: "manager_signals", id: (sig as any).id })
    check("bus: license-risk audit line published + consumed inline",
      (sig as any)?.status === "consumed" && ((sig as any)?.consumed_action ?? "").includes("license-risk escalation executed"))

    // ── IDEMPOTENT rerun on the same open incident → NO duplicate escalation ──
    const r2 = await runSentinelOnInbound({ contactId, text: criticalMsg, brokerageId }, svc)
    check("idempotent: rerun reports already-handled", r2.alreadyHandled === true)
    check("idempotent: rerun escalates to nobody new", r2.escalated === 0)
    const { count: notifCount } = await svc.from("notifications").select("id", { count: "exact", head: true })
      .eq("type", "ai_sentinel_license_risk").eq("entity_id", contactId)
    check("idempotent: notification count unchanged after rerun", (notifCount ?? 0) === (allNotifs ?? []).length)

    // ── A 'none' message on a fresh contact → pure no-op (no halt, no escalation) ──
    const { data: contact2 } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "SentinelNone", last_name: TAG,
      isa_reengage_allowed: true, dnc_status: false,
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (contact2 as any).id })
    const r3 = await runSentinelOnInbound({ contactId: (contact2 as any).id, text: "Thanks! This looks perfect, when can we see it?", brokerageId }, svc)
    check("none: tier none → no-op (not halted, not escalated)", r3.tier === "none" && r3.halted === false && r3.escalated === 0)
    const { data: stillLive } = await svc.from("contacts").select("isa_reengage_allowed, dnc_status").eq("id", (contact2 as any).id).single()
    check("none: contact stays ISA-engageable (normal flow continues)", (stillLive as any).isa_reengage_allowed === true && (stillLive as any).dnc_status === false)
    const { count: noneNotifs } = await svc.from("notifications").select("id", { count: "exact", head: true })
      .eq("type", "ai_sentinel_license_risk").eq("entity_id", (contact2 as any).id)
    check("none: no escalation notification for a normal message", (noneNotifs ?? 0) === 0)

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
