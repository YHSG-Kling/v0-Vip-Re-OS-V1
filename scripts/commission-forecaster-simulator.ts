#!/usr/bin/env tsx
/**
 * scripts/commission-forecaster-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * COMMISSION & CAP FORECASTER harness.
 *
 * Layer 1 (pure, always runs):
 *   · forecastGci — closed YTD + probability-weighted pipeline → projected annual GCI,
 *     run-rate pace, and goal delta.
 *   · capDistance — distance to cap, capped flag, progress; cap-UNCONFIGURED path.
 *   · dealsToPush — picks the 1-2 highest-leverage near-close deals that close the gap.
 *   · composeForecastSummary — earned-line summary incl. the cap-unconfigured honesty.
 *   · normalizeWinProbability / dealCommission / toPipeline helpers.
 *
 * Layer 2 (live, creds-gated): seed an agent with CLOSED + IN-PROGRESS deals, run
 *   runCommissionForecaster, assert a gated agent-facing forecast proposal exists with
 *   real numbers (closed YTD reflected, cap distance reflected). SELF-CLEANS via a unique
 *   TAG; verifies zero seeded rows remain.
 *
 * Run: npx tsx scripts/commission-forecaster-simulator.ts  (npm run test:commission-forecaster)
 */
import {
  forecastGci, capDistance, dealsToPush, composeForecastSummary,
  normalizeWinProbability, dealCommission, toPipeline, stageWinProbability,
  runCommissionForecaster, type PipelineDeal,
} from "../lib/kernel/commission-forecaster"

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
  console.log(" ✅ Commission & Cap Forecaster verified")
}

const deal = (over: Partial<PipelineDeal>): PipelineDeal => ({
  id: over.id ?? "d", name: over.name ?? "Deal", estimatedCommission: over.estimatedCommission ?? 0,
  winProbability: over.winProbability ?? 0.5, stage: over.stage ?? "UNDER_CONTRACT",
  expectedCloseDate: over.expectedCloseDate ?? null,
})

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Commission & Cap Forecaster simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure forecasting math]")

  // normalizeWinProbability: 0..1 passthrough, 0..100 scaling, null → stage fallback.
  check("normalizeWinProbability: 0.7 stays 0.7", normalizeWinProbability(0.7, "INSPECTION") === 0.7)
  check("normalizeWinProbability: 80 → 0.8", normalizeWinProbability(80, "INSPECTION") === 0.8)
  check("normalizeWinProbability: null → stage default", normalizeWinProbability(null, "CLOSING_PREP") === stageWinProbability("CLOSING_PREP"))
  check("normalizeWinProbability: clamps >1 (after /100 still >1 → 1)", normalizeWinProbability(150, null) === 1)

  // dealCommission: estimated → amount → price×pct → 0.
  check("dealCommission: prefers estimated_commission", dealCommission({ estimated_commission: 9000, commission_amount: 5000, commission_percentage: 3, purchase_price: 100000 }) === 9000)
  check("dealCommission: falls back to commission_amount", dealCommission({ estimated_commission: null, commission_amount: 5000, commission_percentage: 3, purchase_price: 100000 }) === 5000)
  check("dealCommission: derives from price × pct", dealCommission({ estimated_commission: null, commission_amount: null, commission_percentage: 3, purchase_price: 500000 }) === 15000)
  check("dealCommission: 0 when nothing known", dealCommission({ estimated_commission: null, commission_amount: null, commission_percentage: null, purchase_price: null }) === 0)

  // forecastGci: closed 60k + pipeline (20k@0.9 + 30k@0.5 = 18k + 15k = 33k) → 93k projected.
  const now = new Date(Date.UTC(2026, 5, 11)) // 2026-06-11, ~44.4% through the year
  const pipeline = [
    deal({ id: "a", name: "123 Oak", estimatedCommission: 20000, winProbability: 0.9, stage: "CLOSING_PREP" }),
    deal({ id: "b", name: "456 Elm", estimatedCommission: 30000, winProbability: 0.5, stage: "UNDER_CONTRACT" }),
  ]
  const f = forecastGci(60000, pipeline, now, 150000)
  check("forecastGci: weighted pipeline = 33000 (18k+15k)", f.weightedPipeline === 33000, String(f.weightedPipeline))
  check("forecastGci: projected annual GCI = 93000", f.projectedAnnualGci === 93000, String(f.projectedAnnualGci))
  check("forecastGci: pace annualizes closed YTD (> closed)", f.paceAnnualizedGci > 60000 && f.paceAnnualizedGci < 200000, String(f.paceAnnualizedGci))
  check("forecastGci: projectedVsGoal = 93000-150000 = -57000", f.projectedVsGoal === -57000, String(f.projectedVsGoal))
  check("forecastGci: yearElapsed in (0.4, 0.5)", f.yearElapsed > 0.4 && f.yearElapsed < 0.5, String(f.yearElapsed))
  const fNoGoal = forecastGci(60000, pipeline, now, null)
  check("forecastGci: projectedVsGoal null when no goal", fNoGoal.projectedVsGoal === null)
  check("forecastGci: empty pipeline → weighted 0", forecastGci(60000, [], now).weightedPipeline === 0)

  // capDistance: cap 80k, gci 60k → 20k to cap, 75% progress, not capped.
  const cap = capDistance(60000, 80000)
  check("capDistance: distance = 20000", cap.distanceToCap === 20000, String(cap.distanceToCap))
  check("capDistance: progress = 0.75", cap.progress === 0.75, String(cap.progress))
  check("capDistance: not capped at 60k/80k", cap.isCapped === false)
  const capped = capDistance(90000, 80000)
  check("capDistance: capped when gci ≥ cap", capped.isCapped === true && capped.distanceToCap === 0)
  // cap UNCONFIGURED path.
  const noCap = capDistance(60000, null)
  check("capDistance: UNCONFIGURED — cap null", noCap.cap === null)
  check("capDistance: UNCONFIGURED — distance null", noCap.distanceToCap === null)
  check("capDistance: UNCONFIGURED — progress null, not capped", noCap.progress === null && noCap.isCapped === false)
  check("capDistance: cap ≤ 0 treated as unconfigured", capDistance(60000, 0).cap === null)

  // dealsToPush: gap 20k. Deal "a" (18k weighted, CLOSING_PREP) doesn't single-handedly
  // close 20k → top-2 by leverage. With a smaller gap a single deal suffices.
  const pushTop2 = dealsToPush(pipeline, 20000)
  check("dealsToPush: returns up to 2 deals", pushTop2.length >= 1 && pushTop2.length <= 2)
  check("dealsToPush: top pick is highest-leverage CLOSING_PREP deal", pushTop2[0].id === "a")
  const pushSingle = dealsToPush(pipeline, 15000)
  check("dealsToPush: one deal when it closes the gap alone", pushSingle.length === 1 && pushSingle[0].id === "a")
  check("dealsToPush: empty when gap ≤ 0 (already there)", dealsToPush(pipeline, 0).length === 0)
  check("dealsToPush: empty when no pipeline", dealsToPush([], 50000).length === 0)
  // Leverage: a near-close small deal can outrank a far-off big one for the push.
  const mixed = [
    deal({ id: "near", estimatedCommission: 12000, winProbability: 0.9, stage: "CLOSING_PREP" }),
    deal({ id: "far", estimatedCommission: 13000, winProbability: 0.5, stage: "UNDER_CONTRACT" }),
  ]
  check("dealsToPush: stage leverage favors the near-close deal", dealsToPush(mixed, 50000)[0].id === "near")

  // composeForecastSummary: cap-configured vs cap-unconfigured honesty.
  const sumCap = composeForecastSummary("Dana", f, cap, pushTop2)
  check("summary: states GCI booked YTD", /booked \$60,000 GCI year-to-date/.test(sumCap.body))
  check("summary: states distance to cap", /\$20,000 from your \$80,000 commission cap/.test(sumCap.body))
  check("summary: recommends a push", /Highest-leverage move: push/.test(sumCap.body))
  check("summary: subject reflects cap distance", /from your cap/.test(sumCap.subject))
  const sumNoCap = composeForecastSummary("Dana", fNoGoal, noCap, [])
  check("summary: honest cap-unconfigured line", /commission cap isn't configured yet/.test(sumNoCap.body))
  check("summary: no-cap subject falls back to pace", /On pace for/.test(sumNoCap.subject))
  const sumCapped = composeForecastSummary("Dana", f, capped, [])
  check("summary: capped agent gets the post-cap line", /HIT your \$80,000 cap/.test(sumCapped.body))

  // toPipeline: raw rows → normalized deals.
  const tp = toPipeline([
    { id: "x", deal_name: "Deal X", property_address: null, estimated_commission: 10000, commission_amount: null, commission_percentage: null, purchase_price: null, win_probability: 75, stage: "INSPECTION", status: "under_contract", close_date: null, estimated_close_date: "2026-07-01" },
  ])
  check("toPipeline: maps commission + normalizes win prob", tp[0].estimatedCommission === 10000 && tp[0].winProbability === 0.75)
  check("toPipeline: carries name + expected close", tp[0].name === "Deal X" && tp[0].expectedCloseDate === "2026-07-01")

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live forecast]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  console.log("\n[Layer 2 · live forecast]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__cfsim_${Date.now()}__`
  const now2 = new Date()
  const year = now2.getUTCFullYear()
  const yearStart = new Date(Date.UTC(year, 0, 1)).toISOString().slice(0, 10)
  const cleanup: Array<{ table: string; id: string }> = []
  // The cap is seeded into agent_cap_tracking — the LEDGER. Either the agent
  // already has a window covering today (m461 backfilled four), in which case its
  // cap_amount is borrowed and restored, or a window is created and deleted.
  let savedCap: number | null | undefined
  let borrowedCapRowId: string | null = null
  let seededCapRowId: string | null = null
  let agentId: string | null = null

  try {
    const { data: agent } = await svc.from("agents").select("id, brokerage_id").not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    agentId = (agent as any).id

    // ── CONFIGURE A KNOWN CAP, IN THE PLACE THE ENGINE READS ─────────────────
    //
    // This used to write `agents.cap_amount = 100000` — and resolveCap used to
    // PREFER that column over the ledger, so the simulator was proving the
    // forecaster agreed with a copy the commission engine never applies. Once
    // resolveCap was corrected to read agent_cap_tracking only, seeding the
    // agents row would have proved nothing at all: the assertion below would
    // have failed for the right reason, and the fix is to seed the right table,
    // not to relax the assertion.
    //
    // The window MUST CONTAIN `now2` — that is stage 07's filter and resolveCap
    // uses the same one — so it is anchored on the run date rather than a fixed
    // date that could fall outside it.
    const today2 = now2.toISOString().slice(0, 10)
    const { data: liveCapRows, error: liveCapErr } = await svc
      .from("agent_cap_tracking")
      .select("id, cap_amount")
      .eq("agent_id", agentId).eq("brokerage_id", brokerageId)
      .lte("anniversary_start", today2).gte("anniversary_end", today2)
      .limit(1)
    if (liveCapErr) { console.log(`  ⏭  Skipped — could not read the cap ledger: ${liveCapErr.message}`); report(); return }

    const liveCapRow = (liveCapRows ?? [])[0] as { id: string; cap_amount: number | null } | undefined
    if (liveCapRow) {
      // Borrow the existing window rather than inserting a second overlapping
      // one: resolveCap takes .limit(1) over a date range, so two matching rows
      // would make which cap it sees a matter of ordering luck.
      borrowedCapRowId = liveCapRow.id
      savedCap = liveCapRow.cap_amount
      await svc.from("agent_cap_tracking").update({ cap_amount: 100000 }).eq("id", liveCapRow.id)
    } else {
      const { data: seeded } = await svc.from("agent_cap_tracking").insert({
        agent_id: agentId, brokerage_id: brokerageId,
        anniversary_start: `${now2.getUTCFullYear()}-01-01`,
        anniversary_end: `${now2.getUTCFullYear()}-12-31`,
        cap_amount: 100000, cap_paid_to_date: 0, is_capped: false,
      }).select("id").single()
      seededCapRowId = (seeded as any)?.id ?? null
    }

    const { data: con } = await svc.from("contacts").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
    const contactId = (con as any)?.id ?? null

    // Two CLOSED deals this year → 40000 + 20000 = 60000 GCI YTD.
    for (const amt of [40000, 20000]) {
      const { data: t } = await svc.from("transactions").insert({
        brokerage_id: brokerageId, agent_id: agentId, contact_id: contactId,
        deal_name: `${TAG} closed ${amt}`, deal_type: "buyer", status: "closed", stage: "CLOSED",
        property_address: `${TAG} ${amt} Closed Ave`, commission_amount: amt,
        close_date: new Date().toISOString().slice(0, 10),
      }).select("id").single()
      cleanup.push({ table: "transactions", id: (t as any).id })
    }

    // Two IN-PROGRESS deals: 25000 @ CLOSING_PREP (~0.9), 30000 @ UNDER_CONTRACT (0.5).
    for (const d of [
      { amt: 25000, stage: "CLOSING_PREP", wp: 0.9 },
      { amt: 30000, stage: "UNDER_CONTRACT", wp: 0.5 },
    ]) {
      const { data: t } = await svc.from("transactions").insert({
        brokerage_id: brokerageId, agent_id: agentId, contact_id: contactId,
        deal_name: `${TAG} pipe ${d.amt}`, deal_type: "buyer", status: "under_contract", stage: d.stage,
        property_address: `${TAG} ${d.amt} Pipe Ave`, estimated_commission: d.amt, win_probability: d.wp,
      }).select("id").single()
      cleanup.push({ table: "transactions", id: (t as any).id })
    }

    // Run the forecaster (injected no-op synthesizer → text path; no TTS credits spent).
    const r = await runCommissionForecaster(brokerageId, { now: now2, synthesizer: async () => null }, svc)
    check("run: at least one forecast proposed", r.forecastsProposed >= 1, JSON.stringify({ ...r, errors: r.errors.slice(0, 3) }))
    check("run: cap counted as configured", r.capsConfigured >= 1)
    check("run: text path used (no voice/synth)", r.textBriefs >= 1)
    check("run: no fatal errors", r.errors.length === 0, r.errors.slice(0, 3).join(" | "))

    // Assert the gated agent-facing proposal exists with REAL numbers from the seeds.
    const { data: msg } = await svc.from("agent_client_messages")
      .select("id, audience, agent_kind, entity_type, status, subject, body, rationale")
      .eq("brokerage_id", brokerageId).eq("agent_kind", "deal_coordinator").eq("audience", "agent")
      .ilike("rationale", `%agent:${agentId}%`).order("created_at", { ascending: false }).limit(1).maybeSingle()
    check("proposal: exists, gated (status 'proposed')", !!msg && (msg as any).status === "proposed")
    check("proposal: audience 'agent', entity 'transaction'", !!msg && (msg as any).audience === "agent" && (msg as any).entity_type === "transaction")
    // closed YTD = 60000 from the seeds (other pre-existing closed deals only add to it).
    check("proposal: body reflects ≥ $60,000 booked YTD", !!msg && /booked \$([6-9]\d|\d{3,}),\d{3} GCI year-to-date/.test((msg as any).body), (msg as any)?.body?.slice(0, 160))
    check("proposal: body cites the commission cap distance", !!msg && /from your \$100,000 commission cap/.test((msg as any).body), (msg as any)?.body?.slice(0, 220))
    check("proposal: rationale records the computed numbers", !!msg && /COMMISSION FORECAST \d{4}-W\d{2}/.test((msg as any).rationale) && /closed YTD/.test((msg as any).rationale))
    if (msg) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })

    // Idempotency — a second run in the same week proposes nothing new for this agent.
    const r2 = await runCommissionForecaster(brokerageId, { now: now2, synthesizer: async () => null }, svc)
    const { count: msgCount } = await svc.from("agent_client_messages")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("agent_kind", "deal_coordinator")
      .ilike("rationale", `%agent:${agentId}%`)
    check("idempotent: one forecast per agent per week (no duplicate)", (msgCount ?? 0) === 1, `count=${msgCount}, secondRunProposed=${r2.forecastsProposed}`)
  } finally {
    // Put the cap ledger back exactly as it was: a BORROWED window keeps its
    // original cap_amount, a SEEDED one is deleted outright. Money rows are not
    // left behind, and a borrowed row is never deleted — cap_paid_to_date on it
    // is real collections history.
    if (borrowedCapRowId) {
      try { await svc.from("agent_cap_tracking").update({ cap_amount: savedCap ?? null }).eq("id", borrowedCapRowId) } catch { /* noop */ }
    }
    if (seededCapRowId) {
      try { await svc.from("agent_cap_tracking").delete().eq("id", seededCapRowId) } catch { /* noop */ }
    }
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("transactions").select("id", { count: "exact", head: true }).like("property_address", `${TAG}%`)
    check("cleanup verified — 0 seeded transactions remain", (count ?? 0) === 0)
    if (seededCapRowId) {
      const { count: capLeft } = await svc.from("agent_cap_tracking")
        .select("id", { count: "exact", head: true }).eq("id", seededCapRowId)
      check("cleanup verified — the seeded cap ledger row is gone", (capLeft ?? 0) === 0)
    }
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
