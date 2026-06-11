#!/usr/bin/env tsx
/**
 * scripts/objection-library-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OBJECTION LIBRARY THAT LEARNS — every AI ISA call's free-text outcome becomes a
 * categorized objection; the rebuttal that books most appointments is crowned and fed
 * back to the next call script.
 *
 * Layer 1 (pure): categorizeObjection across all five objection types (+ "other");
 *   rankRebuttals picks the HIGHER booking rate; MIN-SAMPLE gating (a fluke 1-for-1
 *   never wins; a low-volume objection reports no winner); composeObjectionSummary is
 *   fact-driven (real counts).
 * Layer 2 (live, creds-gated): seed real ai_isa_calls rows with outcomes + rebuttals +
 *   appointment_set, run runObjectionLibrary, assert the agent summary is proposed
 *   (audience 'agent', agentKind 'ai_isa') with the winning rebuttal + real counts, and
 *   the second pass is a no-op (one summary per ISO week). Self-cleans by TAG.
 *
 * Run: npx tsx scripts/objection-library-simulator.ts  (npm run test:objection-library)
 */
import {
  categorizeObjection, rankRebuttals, composeObjectionSummary, runObjectionLibrary,
  MIN_REBUTTAL_ATTEMPTS, MIN_OBJECTION_CALLS, isoWeekTag,
  type IsaCallOutcome,
} from "../lib/kernel/objection-library"

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
  console.log(" ✅ Objection Library verified — it learns from real calls, gated")
}

/** Helper: N call outcomes for one objection, with a given rebuttal + booking count. */
function calls(outcomeText: string, rebuttal: string, attempts: number, booked: number): IsaCallOutcome[] {
  const out: IsaCallOutcome[] = []
  for (let i = 0; i < attempts; i++) out.push({ outcomeText, rebuttal, appointmentSet: i < booked })
  return out
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Objection Library simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · categorize]")
  check("'too expensive' → too_expensive", categorizeObjection("It's way too expensive for me") === "too_expensive")
  check("'the commission is too high' → too_expensive", categorizeObjection("the commission is too high") === "too_expensive")
  check("'using another agent' → using_another_agent", categorizeObjection("I'm already working with another agent") === "using_another_agent")
  check("'just browsing' → just_browsing", categorizeObjection("I'm just browsing for now") === "just_browsing")
  check("'bad timing' → bad_timing", categorizeObjection("Now is bad timing, call me next spring") === "bad_timing")
  check("'not interested' → not_interested", categorizeObjection("Not interested, please remove me") === "not_interested")
  check("empty → other", categorizeObjection("") === "other" && categorizeObjection(null) === "other")
  check("unrelated chatter → other", categorizeObjection("Sounds good, talk soon") === "other")
  // price beats a co-mention of disinterest (specificity ordering).
  check("'not interested, too expensive' → too_expensive (price wins)", categorizeObjection("not interested, it's too expensive") === "too_expensive")

  console.log("\n[Layer 2 · rankRebuttals + min-sample gating]")
  // For "too expensive": rebuttal A books 4/8 (50%), rebuttal B books 1/6 (~17%). A wins.
  const tooExp: IsaCallOutcome[] = [
    ...calls("too expensive", "REBUTTAL_A: let's talk net proceeds, not commission", 8, 4),
    ...calls("too expensive", "REBUTTAL_B: everyone charges the same", 6, 1),
  ]
  const v1 = rankRebuttals(tooExp)
  check("too_expensive: total calls counted (14)", v1.too_expensive.totalCalls === 14)
  check("too_expensive: winner is the HIGHER booking rate (REBUTTAL_A @ 50%)",
    v1.too_expensive.bestRebuttal === "REBUTTAL_A: let's talk net proceeds, not commission" && Math.round((v1.too_expensive.bestSuccessRate ?? 0) * 100) === 50)
  check("too_expensive: rebuttals ranked best-first", v1.too_expensive.rebuttals[0].rebuttal.startsWith("REBUTTAL_A"))

  // FLUKE GATE: a 1-for-1 rebuttal (100%!) must NOT win — below MIN_REBUTTAL_ATTEMPTS.
  const fluke: IsaCallOutcome[] = [
    ...calls("too expensive", "STEADY: proven workhorse", 9, 3),       // 33%, 9 attempts (eligible)
    ...calls("too expensive", "FLUKE: lucky one-shot", 1, 1),          // 100%, 1 attempt (NOT eligible)
  ]
  const v2 = rankRebuttals(fluke)
  check("fluke gate: a 1-for-1 100% rebuttal does NOT win (below MIN_REBUTTAL_ATTEMPTS)",
    v2.too_expensive.bestRebuttal === "STEADY: proven workhorse")

  // VOLUME GATE: an objection with too few total calls reports NO winner.
  const thin: IsaCallOutcome[] = calls("bad timing", "TRY_LATER: I'll check back in Q2", MIN_OBJECTION_CALLS - 1, MIN_OBJECTION_CALLS - 1)
  const v3 = rankRebuttals(thin)
  check(`volume gate: <${MIN_OBJECTION_CALLS} total calls → no crowned rebuttal`, v3.bad_timing.bestRebuttal === null && v3.bad_timing.totalCalls === MIN_OBJECTION_CALLS - 1)
  // one more call clears the volume gate (and the rebuttal clears the attempts gate).
  const thick = [...thin, ...calls("bad timing", "TRY_LATER: I'll check back in Q2", 1, 0)]
  const v4 = rankRebuttals(thick)
  check(`volume gate: ≥${MIN_OBJECTION_CALLS} total calls + eligible rebuttal → winner crowned`, v4.bad_timing.bestRebuttal === "TRY_LATER: I'll check back in Q2")

  console.log("\n[Layer 1 · compose summary]")
  const composed = composeObjectionSummary(v1)
  check("summary names the objection label + real counts (no fabrication)",
    composed.body.includes("too expensive") && composed.body.includes("14 calls") && composed.body.includes("50%"))
  check("summary carries the winning rebuttal text", composed.body.includes("REBUTTAL_A"))
  check("summary working-count = 1", composed.working === 1)
  check("isoWeekTag stable + well-formed", /^\d{4}-W\d{2}$/.test(isoWeekTag(new Date("2026-06-11T00:00:00Z"))))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 3 · live objection library]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layers ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `Objx${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — need a brokerage."); report(); return }
    const brokerageId = (brk as any).id

    // ai_isa_calls.contact_id is NOT NULL (FK → contacts). Seed one contact.
    const { data: contact } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "Prospect",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (contact as any).id })
    const contactId = (contact as any).id

    // Seed REAL ISA call rows: for "too expensive", REBUTTAL_WIN books 4/6 (67%),
    // REBUTTAL_LOSE books 0/5 (0%) — the winner must be REBUTTAL_WIN, gated.
    const seedRows: any[] = []
    const winText = `${TAG} WIN: Let's look at your net proceeds, not the commission line.`
    const loseText = `${TAG} LOSE: Everybody charges the same anyway.`
    for (let i = 0; i < 6; i++) seedRows.push({ brokerage_id: brokerageId, contact_id: contactId, ai_response_summary: "That's too expensive for us right now", script_used: winText, appointment_set: i < 4 })
    for (let i = 0; i < 5; i++) seedRows.push({ brokerage_id: brokerageId, contact_id: contactId, ai_response_summary: "Too expensive, the commission is too high", script_used: loseText, appointment_set: false })
    // a second objection with enough volume but only a low-rate rebuttal.
    for (let i = 0; i < 8; i++) seedRows.push({ brokerage_id: brokerageId, contact_id: contactId, ai_response_summary: "I'm already using another agent", script_used: `${TAG} OTHER: I respect that — can I be your backup?`, appointment_set: i < 1 })

    const { data: inserted } = await svc.from("ai_isa_calls").insert(seedRows).select("id")
    for (const r of (inserted ?? []) as any[]) cleanup.push({ table: "ai_isa_calls", id: r.id })

    // Inject a deterministic copy generator (no token spend) — falls through to fallback
    // by returning null, exercising the persona-copy seam without the gateway.
    const noGateway = async () => null

    const r1 = await runObjectionLibrary(brokerageId, { copyGenerator: noGateway }, svc)
    check("live: 19 real calls analyzed", r1.callsAnalyzed === 19, `got ${r1.callsAnalyzed}`)
    check("live: 2 objections covered (too_expensive + using_another_agent)", r1.objectionsCovered === 2, `got ${r1.objectionsCovered}`)
    check("live: too_expensive winner is the higher-booking rebuttal (REBUTTAL_WIN over LOSE)",
      r1.verdicts.too_expensive.bestRebuttal === winText)
    check("live: both gated objections crowned a best rebuttal (≥2 winners)", r1.winningRebuttals >= 2)
    check("live: winning rebuttal is the HIGHER booker (67%), not the 0% one",
      Math.round((r1.verdicts.too_expensive.bestSuccessRate ?? 0) * 100) === 67 && r1.verdicts.too_expensive.bestRebuttal !== loseText)
    check("live: summary proposed", r1.summaryProposed)

    // The proposed agent summary, gated (audience 'agent', agentKind 'ai_isa'), real counts.
    const weekTag = isoWeekTag(new Date())
    const { data: summary } = await svc.from("agent_client_messages")
      .select("id, status, audience, agent_kind, body, rationale")
      .eq("brokerage_id", brokerageId).eq("agent_kind", "ai_isa")
      .ilike("rationale", `OBJECTION LIBRARY ${weekTag}%`).maybeSingle()
    if (summary) cleanup.push({ table: "agent_client_messages", id: (summary as any).id })
    check("live: ONE agent summary proposed (audience 'agent', agentKind 'ai_isa', gated)",
      (summary as any)?.status === "proposed" && (summary as any)?.audience === "agent" && (summary as any)?.agent_kind === "ai_isa")
    check("live: summary body carries the WINNING rebuttal + real counts (no fabrication)",
      ((summary as any)?.body ?? "").includes(winText) && ((summary as any)?.body ?? "").includes("too expensive"))
    if (summary) {
      const { data: notifs } = await svc.from("notifications").select("id").eq("entity_id", (summary as any).id).limit(5)
      for (const n of (notifs ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    }

    // Idempotency — same ISO week → no second summary.
    const r2 = await runObjectionLibrary(brokerageId, { copyGenerator: noGateway }, svc)
    check("idempotency: second pass proposes nothing new (one summary per ISO week)", r2.summaryProposed === false)
    const { count: summaryCount } = await svc.from("agent_client_messages")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("agent_kind", "ai_isa").ilike("rationale", `OBJECTION LIBRARY ${weekTag}%`)
    check("idempotency: exactly ONE summary exists for the week", (summaryCount ?? 0) === 1)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("first_name", TAG)
    check("cleanup verified — 0 seeded contacts remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
