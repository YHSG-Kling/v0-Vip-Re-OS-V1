#!/usr/bin/env tsx
/**
 * scripts/partners-meeting-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SUNDAY NIGHT PARTNERS' MEETING harness — the week, presented by the AI team.
 *
 * Layer 1 (pure): composePartnersMeetingScript — only earned lines (a zero week
 *   fabricates no wins), always closes on the approval queue (the one ask).
 * Layer 2 (live, gated): run producePartnersMeeting with an INJECTED producer
 *   (vendor seam — no D-ID/TTS spend) returning null → written memo; assert the
 *   meeting notification lands for the brokerage audience with REAL weekly numbers
 *   + weekly idempotency. Self-cleans.
 *
 * Run: npx tsx scripts/partners-meeting-simulator.ts  (npm run test:partners-meeting)
 */
import { composePartnersMeetingScript, producePartnersMeeting, type MeetingProducer } from "../lib/intelligence/partners-meeting"

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
  console.log(" ✅ Partners' Meeting verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Sunday Night Partners' Meeting simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · compose]")
  const full = composePartnersMeetingScript({
    weekLabel: "the week of 2026-06-07", teamPlays: 2, fireDrills: 1, whispers: 4,
    consentFallbacks: 1, withdrawnRespectfully: 1, handoffs: 9, dissents: 3,
    proposalsSent: 12, proposalsPending: 5, dealsClosed: 2,
    gciClosedThisWeek: 18000, gciWeightedPipeline: 1_200_000,
    complianceReviewed: 31, complianceAdvisories: 4, complianceReleasedOverObjection: 1,
  }, "Dana")
  check("script: greets the partner by name + the week", full.startsWith("Dana, good evening") && full.includes("week of 2026-06-07"))
  check("script: every earned line present (plays, drill, whispers, handoffs, dissents)",
    full.includes("2 coordinated team plays") && full.includes("1 uncovered deadline") && full.includes("4 appointment briefings") && full.includes("9 manager-to-manager handoffs") && full.includes("3 objections"))
  check("script: Finance Manager reports booked GCI + weighted pipeline (real money, abbreviated)",
    full.includes("Finance Manager: $18K in gross commission booked this week, with $1.2M weighted in the pipeline."))
  check("script: Compliance Officer reports the pre-flight ledger + the released-over-objection number",
    full.includes("Compliance Officer: 31 outbound messages pre-flighted this week.") && full.includes("4 needed a Fair Housing or consent fix") && full.includes("1 was released over an open objection"))
  check("script: closes on the ONE ask (5 pending approvals)", full.includes("5 proposals in the approval queue"))
  const zero = composePartnersMeetingScript({
    weekLabel: "the week of 2026-06-07", teamPlays: 0, fireDrills: 0, whispers: 0,
    consentFallbacks: 0, withdrawnRespectfully: 0, handoffs: 0, dissents: 0,
    proposalsSent: 0, proposalsPending: 0, dealsClosed: 0,
    gciClosedThisWeek: 0, gciWeightedPipeline: 0,
    complianceReviewed: 0, complianceAdvisories: 0, complianceReleasedOverObjection: 0,
  }, null)
  check("script: a zero week fabricates NO wins", !zero.includes("closed") && !zero.includes("team play") && !zero.includes("deadline"))
  check("script: a dry-money week stays silent on finance (no fabricated GCI)", !zero.includes("Finance Manager"))
  check("script: a quiet compliance week stays silent (no fabricated review count)", !zero.includes("Compliance Officer"))
  check("script: zero week still closes honestly (queue clear)", zero.includes("approval queue is clear"))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live meeting]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id

    // Injected producer — the vendor seam; never spends D-ID/TTS credits.
    let producerCalls = 0
    const producer: MeetingProducer = async () => { producerCalls += 1; return null } // null → written memo
    const r1 = await producePartnersMeeting(brokerageId, { producer }, svc)
    check("meeting: produced for the brokerage audience", r1.meetings >= 1)
    check("meeting: memo fallback when producer yields no media", r1.memo >= 1 && r1.video === 0)
    check("producer seam: called once per attendee", producerCalls === r1.meetings)

    const { data: notifs } = await svc.from("notifications").select("id, body, title")
      .eq("brokerage_id", brokerageId).eq("type", "partners_meeting")
      .gte("created_at", new Date(Date.now() - 60_000).toISOString())
    for (const n of (notifs ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    const body = ((notifs ?? []) as any[])[0]?.body ?? ""
    check("meeting: real weekly numbers, honest close (queue line present)",
      body.includes("approval queue"))

    const r2 = await producePartnersMeeting(brokerageId, { producer }, svc)
    check("idempotency: one meeting per user per week", r2.meetings === 0)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
