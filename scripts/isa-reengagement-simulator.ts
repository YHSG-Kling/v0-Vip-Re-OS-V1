#!/usr/bin/env tsx
/**
 * scripts/isa-reengagement-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AI ISA RE-ENGAGEMENT LOOP harness — proves the "dormant until they ghost,
 * then follow up on cadence" assistant that drives ghost-detection (lead-side) and
 * stale-contact-monitor (contact-side). The DECISIONS now live in one pure module
 * (lib/ai-isa/reengagement-policy.ts) shared by both production runners, so this
 * proof locks the exact behavior the crons execute.
 *
 * Layer 1 (pure, always runs):
 *   · CADENCE — shouldSendGhostOutreach: Phase 1 (≤14d) Mon/Wed/Fri only; Phase 2
 *     (>14d) first-send-anytime then every 30 days; off-days + too-soon are skipped.
 *   · STOP CONDITIONS — ghostReengagementStopReason: representation / inactive /
 *     reengage-disallowed / opted-out / reply-received, in the right precedence; a
 *     live, replying-but-not-stopped lead returns null (keep going).
 *   · STALE ELIGIBILITY — staleContactEligibility: every exclusion (dnc / paused /
 *     reengage-disallowed / do-not-contact / deleted / active-transaction / not-yet-
 *     stale) and the honest never-contacted (999d) sentinel.
 *   · resolveStaleThreshold falls back honestly on bad input.
 *
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY): seed a REAL ISA-owned ghost
 *   lead (lifecycle_state='isa_qualifying', last_activity_at old) and assert
 *   detectGhostLeads finds it; flip reengagement_status='opted_out' and assert it is
 *   excluded; then reverse-delete + cleanup count == 0. No mocks, real rows.
 *
 * Run: npx tsx scripts/isa-reengagement-simulator.ts  (npm run test:isa-reengagement)
 */
import {
  shouldSendGhostOutreach,
  ghostReengagementStopReason,
  staleContactEligibility,
  resolveStaleThreshold,
  DEFAULT_MAX_GHOST_ATTEMPTS,
  PHASE1_WINDOW_DAYS,
  PHASE2_SPACING_DAYS,
  DEFAULT_STALE_DAYS,
} from "../lib/ai-isa/reengagement-policy"

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
  console.log(" ✅ AI ISA re-engagement loop verified — cadence (Mon/Wed/Fri → every 30d), stop conditions, stale eligibility")
  console.log(" ISA_REENGAGEMENT_PASS")
}

const DAY = 86_400_000
function daysAgo(n: number, from: Date): Date { return new Date(from.getTime() - n * DAY) }

// Known weekdays (UTC) to drive getDay() deterministically.
const MON = new Date("2026-06-15T12:00:00Z") // Monday
const TUE = new Date("2026-06-16T12:00:00Z") // Tuesday
const WED = new Date("2026-06-17T12:00:00Z") // Wednesday
const THU = new Date("2026-06-18T12:00:00Z") // Thursday
const FRI = new Date("2026-06-19T12:00:00Z") // Friday
const SAT = new Date("2026-06-20T12:00:00Z") // Saturday
const SUN = new Date("2026-06-21T12:00:00Z") // Sunday

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" AI ISA re-engagement loop simulator")
  console.log("══════════════════════════════════════════════════")

  // ── Layer 1a: CADENCE — Phase 1 (fresh ghost, ≤14 days) ────────────────────
  console.log("\n[Layer 1a · cadence — Phase 1: Mon/Wed/Fri only]")
  // First outreach 2 days ago → still Phase 1 on each weekday.
  for (const [label, day, expect] of [
    ["Monday", MON, true], ["Wednesday", WED, true], ["Friday", FRI, true],
    ["Tuesday", TUE, false], ["Thursday", THU, false],
    ["Saturday", SAT, false], ["Sunday", SUN, false],
  ] as const) {
    const d = shouldSendGhostOutreach({ firstSentAt: daysAgo(2, day), lastSentAt: daysAgo(2, day), now: day })
    check(`Phase 1 ${label} → ${expect ? "SEND" : "skip"}`, d.phase === 1 && d.shouldSend === expect, `${d.phase}/${d.reason}`)
  }
  // No prior send at all → phase starts now (day 0, Phase 1): Mon sends, Tue doesn't.
  check("Phase 1 day-0 (no prior send) Monday → SEND",
    shouldSendGhostOutreach({ firstSentAt: null, lastSentAt: null, now: MON }).shouldSend === true)
  check("Phase 1 day-0 (no prior send) Tuesday → skip",
    shouldSendGhostOutreach({ firstSentAt: null, lastSentAt: null, now: TUE }).shouldSend === false)
  // Boundary: exactly 14 days since first is still Phase 1.
  check("boundary: 14 days since first is still Phase 1",
    shouldSendGhostOutreach({ firstSentAt: daysAgo(PHASE1_WINDOW_DAYS, WED), lastSentAt: daysAgo(1, WED), now: WED }).phase === 1)

  // ── Layer 1b: CADENCE — Phase 2 (long-haul, >14 days, every 30 days) ───────
  console.log("\n[Layer 1b · cadence — Phase 2: every 30 days]")
  // 15 days since first → Phase 2. On a Tuesday (an off-day for Phase 1) it can still send.
  check("Phase 2 first-send (never sent) → SEND even on a Tuesday",
    (() => { const d = shouldSendGhostOutreach({ firstSentAt: daysAgo(15, TUE), lastSentAt: null, now: TUE }); return d.phase === 2 && d.shouldSend && d.reason === "phase2_first_send" })())
  check("Phase 2 last sent 30 days ago → SEND (due)",
    (() => { const d = shouldSendGhostOutreach({ firstSentAt: daysAgo(60, TUE), lastSentAt: daysAgo(PHASE2_SPACING_DAYS, TUE), now: TUE }); return d.phase === 2 && d.shouldSend && d.reason === "phase2_due" })())
  check("Phase 2 last sent 29 days ago → skip (too soon)",
    (() => { const d = shouldSendGhostOutreach({ firstSentAt: daysAgo(60, TUE), lastSentAt: daysAgo(29, TUE), now: TUE }); return d.phase === 2 && !d.shouldSend && d.reason === "phase2_too_soon" })())
  check("Phase 2 weekday-independent (Sunday, 40d since last) → SEND",
    shouldSendGhostOutreach({ firstSentAt: daysAgo(50, SUN), lastSentAt: daysAgo(40, SUN), now: SUN }).shouldSend === true)

  // ── Layer 1c: STOP CONDITIONS ──────────────────────────────────────────────
  console.log("\n[Layer 1c · stop conditions + precedence]")
  const base = { lifecycle_state: "isa_qualifying", is_active: true, reengagement_status: "active", contactReengageAllowed: null, replyReceived: false }
  check("no stop → continue (null)", ghostReengagementStopReason(base) === null)
  check("representation → stop", ghostReengagementStopReason({ ...base, lifecycle_state: "representation" }) === "representation")
  check("is_active=false → stop (inactive)", ghostReengagementStopReason({ ...base, is_active: false }) === "inactive")
  check("contact isa_reengage_allowed=false → stop", ghostReengagementStopReason({ ...base, contactReengageAllowed: false }) === "reengage_disallowed")
  check("reengagement_status=opted_out → stop", ghostReengagementStopReason({ ...base, reengagement_status: "opted_out" }) === "opted_out")
  check("reply received → stop", ghostReengagementStopReason({ ...base, replyReceived: true }) === "reply_received")
  check("precedence: representation outranks reply", ghostReengagementStopReason({ ...base, lifecycle_state: "representation", replyReceived: true }) === "representation")
  check("contact reengage_allowed=true (explicit) → continue", ghostReengagementStopReason({ ...base, contactReengageAllowed: true }) === null)

  // ── Layer 1d: EXHAUSTED terminal (give up + escalate, never loop forever) ──
  console.log("\n[Layer 1d · exhausted terminal]")
  check("below max attempts → continue (null)", ghostReengagementStopReason({ ...base, outreachAttempts: DEFAULT_MAX_GHOST_ATTEMPTS - 1 }) === null)
  check("THE GAP: at max attempts with no reply → 'exhausted'", ghostReengagementStopReason({ ...base, outreachAttempts: DEFAULT_MAX_GHOST_ATTEMPTS }) === "exhausted")
  check("past max attempts → 'exhausted'", ghostReengagementStopReason({ ...base, outreachAttempts: DEFAULT_MAX_GHOST_ATTEMPTS + 5 }) === "exhausted")
  check("a reply at the last attempt WINS over exhausted (success, not give-up)", ghostReengagementStopReason({ ...base, outreachAttempts: DEFAULT_MAX_GHOST_ATTEMPTS, replyReceived: true }) === "reply_received")
  check("representation outranks exhausted", ghostReengagementStopReason({ ...base, outreachAttempts: 99, lifecycle_state: "representation" }) === "representation")
  check("custom maxAttempts honored", ghostReengagementStopReason({ ...base, outreachAttempts: 3 }, { maxAttempts: 3 }) === "exhausted")

  // ── Layer 1d: STALE-CONTACT ELIGIBILITY ─────────────────────────────────────
  console.log("\n[Layer 1d · stale-contact eligibility — every exclusion]")
  const now = new Date("2026-06-15T12:00:00Z")
  const eligibleBase = {
    last_contacted_at: daysAgo(20, now).toISOString(),
    dnc_status: false, ai_outreach_paused: false, isa_reengage_allowed: true,
    status: "active", deleted_at: null, hasActiveTransaction: false,
  }
  check("stale + eligible → eligible", staleContactEligibility(eligibleBase, { now }).eligible === true)
  check("never contacted (null) → 999 days, eligible", (() => { const r = staleContactEligibility({ ...eligibleBase, last_contacted_at: null }, { now }); return r.eligible && r.daysSinceContact === 999 })())
  check("dnc_status=true → ineligible (dnc)", staleContactEligibility({ ...eligibleBase, dnc_status: true }, { now }).reason === "dnc")
  check("ai_outreach_paused=true → ineligible", staleContactEligibility({ ...eligibleBase, ai_outreach_paused: true }, { now }).reason === "outreach_paused")
  check("isa_reengage_allowed=false → ineligible", staleContactEligibility({ ...eligibleBase, isa_reengage_allowed: false }, { now }).reason === "reengage_disallowed")
  check("status=do_not_contact → ineligible", staleContactEligibility({ ...eligibleBase, status: "do_not_contact" }, { now }).reason === "do_not_contact_status")
  check("deleted_at set → ineligible", staleContactEligibility({ ...eligibleBase, deleted_at: now.toISOString() }, { now }).reason === "deleted")
  check("active transaction → ineligible", staleContactEligibility({ ...eligibleBase, hasActiveTransaction: true }, { now }).reason === "active_transaction")
  check("contacted 5 days ago (< 14) → not yet stale", staleContactEligibility({ ...eligibleBase, last_contacted_at: daysAgo(5, now).toISOString() }, { now }).reason === "not_yet_stale")
  check("custom staleDays=30: 20-days-ago → not yet stale", staleContactEligibility(eligibleBase, { now, staleDays: 30 }).reason === "not_yet_stale")
  // Precedence: a DNC contact that is also not-yet-stale reports dnc (hard exclusion first).
  check("precedence: dnc outranks not-yet-stale", staleContactEligibility({ ...eligibleBase, dnc_status: true, last_contacted_at: daysAgo(1, now).toISOString() }, { now }).reason === "dnc")

  // ── Layer 1e: threshold resolution ──────────────────────────────────────────
  console.log("\n[Layer 1e · threshold resolution]")
  check("numeric setting honored", resolveStaleThreshold(21) === 21)
  check("undefined → default", resolveStaleThreshold(undefined) === DEFAULT_STALE_DAYS)
  check("zero → default (invalid)", resolveStaleThreshold(0) === DEFAULT_STALE_DAYS)
  check("string → default (invalid)", resolveStaleThreshold("14") === DEFAULT_STALE_DAYS)

  // ── Layer 2: LIVE (gated) — real ghost lead detection + opt-out exclusion ────
  console.log("\n[Layer 2 · live ghost-lead detection (gated)]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { detectGhostLeads } = await import("../lib/ai-isa/ghost-reengagement")
  const supabase = createServiceClient()

  // A real brokerage to scope the seed.
  const { data: brokerage } = await supabase.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) {
    console.log("  ⏭  Skipped — no brokerage row to scope a real seed.")
    return report()
  }
  const brokerageId = (brokerage as { id: string }).id
  const oldActivity = new Date(Date.now() - 40 * DAY).toISOString()
  let leadId: string | null = null

  try {
    const { data: lead, error } = await supabase
      .from("leads")
      .insert({
        brokerage_id: brokerageId,
        first_name: "ZZ_ISA_REENGAGE_TEST",
        last_name: "Ghost",
        email: `isa-reengage-test+${Date.now()}@example.com`,
        lifecycle_state: "isa_qualifying",
        is_active: true,
        ai_isa_owner: true,
        last_activity_at: oldActivity,
        created_at: oldActivity,
      })
      .select("id")
      .single()
    if (error || !lead) { console.log(`  ⏭  Skipped — seed insert failed: ${error?.message}`); return report() }
    leadId = (lead as { id: string }).id

    const ghosts1 = await detectGhostLeads(brokerageId, 21)
    check("live: seeded ghost lead is detected", ghosts1.includes(leadId))

    // Opt out → must be excluded by the detector's reengagement_status filter.
    await supabase.from("leads").update({ reengagement_status: "opted_out" }).eq("id", leadId)
    const ghosts2 = await detectGhostLeads(brokerageId, 21)
    check("live: opted-out ghost lead is excluded", !ghosts2.includes(leadId))
  } finally {
    // Reverse-delete + assert cleanup.
    if (leadId) {
      await supabase.from("leads").delete().eq("id", leadId)
      const { count } = await supabase.from("leads").select("id", { count: "exact", head: true }).eq("id", leadId)
      check("live: cleanup count == 0", (count ?? 0) === 0)
    }
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
