#!/usr/bin/env tsx
/**
 * scripts/manager-deliberation-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * MANAGER DELIBERATION harness (round 35 — "the managers should also argue a
 * solution and work through the reason why that solution is the best for the
 * situation").
 *
 * Layer 1 (pure): the registry's deliberate flags land ONLY on genuine-tradeoff
 *   domains; refusals for non-collaboration pairs still hold; the grounding guard
 *   (filterEvidenceToCitations) drops invented evidence; deliberate() produces
 *   grounded positions, a resolution that states the WHY, honest dissent only on
 *   merit, and an honest 'unavailable' record on an unreachable/junk engine (never
 *   canned arguments); teamwork rollup math (counts, odd/even median, dissents) and
 *   omit-when-empty on both the QBR section and the teamwork lines; a fact loader
 *   exists for every participant of every deliberative domain; the referral handler
 *   source actually escalates (wiring check, doc-kernel idiom).
 * Layer 2 (live, creds-gated): a real referral is raised on the bus
 *   (listing_demand_bridge), runDeliberation grounds briefs from the tenant's own
 *   tables, persists the record onto the referral row (payload.deliberation), the
 *   metrics loader rolls it up, and a retried deliberation NEVER re-argues (the
 *   persisted record is reused even with a throwing engine). Self-cleans.
 *
 * Run: npx tsx scripts/manager-deliberation-simulator.ts
 * Suggested npm script: "test:manager-deliberation": "tsx scripts/manager-deliberation-simulator.ts"
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  MANAGERS, MANAGER_COLLABORATIONS, canRefer, type ManagerKey,
} from "../lib/kernel/manager-registry"
import { validateReferral } from "../lib/managers/cross-referral"
import {
  isDeliberativeDomain, deliberativeDomains, filterEvidenceToCitations,
  validResolutionWinner, summarizeDeliberation, parseDeliberation, deliberate,
  MANAGER_FACT_LOADERS, DELIBERATION_UNAVAILABLE,
  type ManagerBrief, type DeliberationEngine, type DeliberationRecord,
} from "../lib/managers/deliberation"
import {
  rollupTeamwork, median, composeTeamworkLines, type ReferralLedgerRow,
} from "../lib/managers/teamwork-metrics"
import { composeQuarterlyReview } from "../lib/intelligence/quarterly-review"

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
  console.log(" ✅ Manager Deliberation (argued teamwork) verified")
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

// A deterministic engine: argues from the brief (with deliberately invented evidence
// mixed in, to prove the grounding guard), resolves to the first position, dissents
// for the second — every behavior asserted below is the CODE's, not the model's.
function fixtureEngine(overrides: Partial<DeliberationEngine> = {}): DeliberationEngine {
  return {
    argue: async ({ manager, brief, ask }) => ({
      proposal: `${MANAGERS[manager].label}'s solution to: ${ask.slice(0, 60)}`,
      reasoning: brief.facts[0] ? `Grounded in: ${brief.facts[0]}` : "No domain rows in the window — arguing from the situation alone.",
      risks: ["could be wrong"],
      evidence: [...(brief.citations[0] ? [brief.citations[0]] : []), "totally.invented=42 (made.up.id=999)"],
    }),
    resolve: async ({ positions }) => ({
      winner: positions[0].manager,
      why: `it addresses the situation's facts directly while the other ${positions.length - 1} position(s) optimize a narrower slice`,
      dissent: positions[1] ? { manager: positions[1].manager, note: "the losing position correctly flags real demand-side risk" } : null,
    }),
    ...overrides,
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Manager Deliberation simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1a · the deliberate flags — argument only where the overlap is a real tradeoff]")
  const flagged = deliberativeDomains().map((d) => d.key).sort()
  check("exactly the three tradeoff domains are deliberative (pricing dispute, closing money+risk, organic-vs-paid budget)",
    JSON.stringify(flagged) === JSON.stringify(["closing_money_and_risk", "listing_demand_bridge", "organic_paid_content"]), flagged.join(","))
  check("isDeliberativeDomain: listing_demand_bridge (a pricing dispute by construction) → true",
    isDeliberativeDomain("listing_demand_bridge"))
  check("isDeliberativeDomain: approval_queue_slo (an SLA nag — one obvious action, nothing to argue) → false",
    !isDeliberativeDomain("approval_queue_slo"))
  check("isDeliberativeDomain: unknown/null domains → false",
    !isDeliberativeDomain("no_such_domain") && !isDeliberativeDomain(null))
  check("deliberate flags did NOT change the collaboration map's membership (no stewardship drift)",
    MANAGER_COLLABORATIONS.listing_demand_bridge.managers.length === 2
    && MANAGER_COLLABORATIONS.closing_money_and_risk.managers.length === 3
    && MANAGER_COLLABORATIONS.organic_paid_content.managers.length === 2
    && Object.keys(MANAGER_COLLABORATIONS).length === 9)

  console.log("\n[Layer 1b · refusals for non-collaboration pairs still hold]")
  check("recruiting_manager → ads_manager shares NO collaboration domain → canRefer false",
    !canRefer("recruiting_manager", "ads_manager"))
  const badEdge = validateReferral({ fromManager: "marketing_agent", toManager: "deal_coordinator", collabDomain: "organic_paid_content" })
  check("a deliberative domain still refuses an undeclared edge (marketing → deal_coordinator on organic_paid_content)",
    !badEdge.ok && (badEdge as { reason: string }).reason.includes("MANAGER_COLLABORATIONS"))
  const goodEdge = validateReferral({ fromManager: "listing_concierge", toManager: "shopping_agent", collabDomain: "listing_demand_bridge" })
  check("the declared edge on the deliberative domain still validates", goodEdge.ok)

  console.log("\n[Layer 1c · the grounding guard — evidence can never be invented]")
  const cits = ["listings.list_price=799000 (listings.id=a1)", "listings.showing_count=3 (listings.id=a1)"]
  check("invented evidence is dropped; verbatim citations survive",
    JSON.stringify(filterEvidenceToCitations(["totally.invented=42", cits[0]], cits)) === JSON.stringify([cits[0]]))
  check("all-invented evidence falls back to the loader's REAL citations (never stands on fiction)",
    JSON.stringify(filterEvidenceToCitations(["fake.a=1", "fake.b=2"], cits)) === JSON.stringify(cits))
  check("no citations at all → honest empty evidence",
    filterEvidenceToCitations(["fake.a=1"], []).length === 0)

  console.log("\n[Layer 1d · deliberate() — argued positions, the stated why, dissent on merit]")
  const domain = MANAGER_COLLABORATIONS.listing_demand_bridge
  const briefs: ManagerBrief[] = [
    { manager: "listing_concierge", facts: ["12 Oak St — list price $799,000, 41 days on market, 3 showings"], citations: cits },
    { manager: "shopping_agent", facts: ["9 buyer saves on this listing (2 high-interest)", "1 live offer, best $749,000"], citations: ["saved_properties.count=9 (saved_properties.listing_id=a1)", "offers.offer_price=749000 (offers.id=o1)"] },
  ]
  const rec = await deliberate({
    domain, ask: "41 days on market with demand evidence piling up — argue the price move.",
    raisedBy: "listing_concierge", briefs, brokerageId: "b-test", engine: fixtureEngine(), now: new Date("2026-07-20T12:00:00Z"),
  })
  check("every participating manager argued a position", rec.status === "resolved" && rec.positions.length === 2
    && rec.positions.map((p) => p.manager).sort().join(",") === "listing_concierge,shopping_agent")
  check("positions are GROUNDED — the invented citation was filtered from every position",
    rec.positions.every((p) => p.evidence.every((e) => !e.includes("invented"))))
  check("each position's evidence is field-level citations from its OWN manager's loader",
    rec.positions[0].evidence[0] === cits[0] && rec.positions[1].evidence[0].startsWith("saved_properties."))
  check("the resolution names a winner who actually argued", rec.winner !== null && validResolutionWinner(rec.winner!, rec.positions))
  check("the resolution states WHY the winner beats the others",
    (rec.resolution ?? "").includes("addresses the situation's facts"))
  check("dissent recorded honestly for the losing position with merit",
    rec.dissent?.manager === "shopping_agent" && rec.dissent.note.includes("demand-side risk"))
  const summary = summarizeDeliberation(rec)
  check("the consumed-action summary carries positions count + winner + the why + the dissent",
    summary.includes("2 positions argued") && summary.includes("won:") && summary.includes("DISSENT on the record"))

  // Dissent hygiene: a dissent naming the WINNER (or a non-participant) is discarded.
  const recNoDissent = await deliberate({
    domain, ask: "same", raisedBy: "listing_concierge", briefs, brokerageId: "b-test",
    engine: fixtureEngine({
      resolve: async ({ positions }) => ({ winner: positions[0].manager, why: "clear win", dissent: { manager: positions[0].manager, note: "self-dissent?" } }),
    }),
  })
  check("a dissent naming the WINNER is discarded — dissent only ever attaches to a losing position",
    recNoDissent.status === "resolved" && recNoDissent.dissent === null)

  console.log("\n[Layer 1e · honest refusal — an unreachable model NEVER yields canned arguments]")
  const recDown = await deliberate({
    domain, ask: "same", raisedBy: "listing_concierge", briefs, brokerageId: "b-test",
    engine: fixtureEngine({ argue: async () => { throw new Error("gateway unreachable (ECONNREFUSED)") } }),
  })
  check("unreachable model → status 'unavailable', ZERO positions (no canned arguments)",
    recDown.status === "unavailable" && recDown.positions.length === 0 && recDown.winner === null && recDown.resolution === null)
  check("the unavailable record carries the honest reason", (recDown.unavailableReason ?? "").includes("unreachable"))
  check("its summary says 'deliberation unavailable' and disclaims substitution",
    summarizeDeliberation(recDown).startsWith(DELIBERATION_UNAVAILABLE) && summarizeDeliberation(recDown).includes("no canned arguments"))
  const recJunk = await deliberate({
    domain, ask: "same", raisedBy: "listing_concierge", briefs, brokerageId: "b-test",
    engine: fixtureEngine({ resolve: async () => ({ winner: "not_a_manager", why: "x", dissent: null }) }),
  })
  check("a junk winner from the model → honest 'unavailable', never a fabricated resolution",
    recJunk.status === "unavailable" && (recJunk.unavailableReason ?? "").includes("not_a_manager"))
  check("parseDeliberation roundtrips a record off a payload (and rejects non-records)",
    parseDeliberation({ deliberation: rec as unknown as Record<string, unknown> })?.winner === rec.winner
    && parseDeliberation({ deliberation: { status: "weird" } }) === null && parseDeliberation(null) === null)

  console.log("\n[Layer 1f · a REAL fact loader exists for every deliberative participant]")
  for (const d of deliberativeDomains()) {
    check(`every co-manager of '${d.key}' has a domain fact loader (${d.managers.join(", ")})`,
      d.managers.every((m: ManagerKey) => typeof MANAGER_FACT_LOADERS[m] === "function"))
  }

  console.log("\n[Layer 1g · teamwork metrics — the pure rollup math + omit-when-empty]")
  check("median: odd count picks the middle", median([10, 2, 4]) === 4)
  check("median: even count averages the middle pair", median([1, 2, 10, 20]) === 6)
  check("median: empty → null (never a fabricated stat)", median([]) === null)
  const t0 = new Date("2026-07-01T00:00:00Z").getTime()
  const iso = (h: number) => new Date(t0 + h * 3_600_000).toISOString()
  const fixtureRows: ReferralLedgerRow[] = [
    { status: "consumed", created_at: iso(0), consumed_at: iso(2), payload: { deliberation: rec as unknown as Record<string, unknown> } },
    { status: "consumed", created_at: iso(0), consumed_at: iso(4), payload: { deliberation: recDown as unknown as Record<string, unknown> } },
    { status: "consumed", created_at: iso(0), consumed_at: iso(10), payload: {} },
    { status: "open", created_at: iso(0), consumed_at: null, payload: null },
    { status: "expired", created_at: iso(0), consumed_at: null, payload: {} },
  ]
  const m = rollupTeamwork(fixtureRows, 90)
  check("handed-off / resolved counts", m.handedOff === 5 && m.resolved === 3)
  check("median time-to-pickup over resolved rows (2h, 4h, 10h → 4h)", m.medianPickupHours === 4)
  check("deliberations held counts only RESOLVED arguments; unavailable counted separately",
    m.deliberationsHeld === 1 && m.deliberationsUnavailable === 1)
  check("dissents recorded", m.dissentsRecorded === 1)
  const lines = composeTeamworkLines(m)
  check("teamwork lines state the numbers + the argued-why framing",
    lines.length >= 2 && lines[0].includes("5 cross-manager referrals") && lines[0].includes("median pickup 4 hours")
    && lines[1].includes("1 deliberation held") && lines[1].includes("1 honest dissent"))
  const empty = rollupTeamwork([], 90)
  check("OMIT-WHEN-EMPTY: a silent period composes ZERO teamwork lines", composeTeamworkLines(empty).length === 0)
  const baseFacts = {
    windowLabel: "Apr 21 – Jul 20", planTier: "team", closedDeals: 1, closedVolume: 500_000, activeDeals: 2,
    newContacts: 5, approvals: 3, autonomousActs: 0, grantsHeld: 0, conflictsCaught: 0, giftsOrdered: 0,
    briefingsOpened: 4, unusedRails: [], trustIncidents: 0, expansion: null,
  }
  const qbrWith = composeQuarterlyReview({ ...baseFacts, teamworkLines: lines })
  const qbrWithout = composeQuarterlyReview(baseFacts)
  check("QBR mounts the teamwork section from the rollup lines", (qbrWith.teamwork ?? []).length === lines.length)
  check("QBR omits the teamwork section when the quarter had none", (qbrWithout.teamwork ?? []).length === 0)

  console.log("\n[Layer 1h · wiring — the referral handler escalates deliberative domains (source check, doc-kernel idiom)]")
  const handlerSrc = src("lib/kernel/manager-signals.ts")
  check("handleCrossManagerReferral escalates on domain.deliberate === true via runDeliberation",
    handlerSrc.includes("domain.deliberate === true") && handlerSrc.includes("runDeliberation")
    && handlerSrc.includes("summarizeDeliberation"))
  check("the escalation reuses the referral's own payload (idempotent — a retry never re-argues)",
    handlerSrc.includes("existingPayload: signal.payload"))
  check("the governance surface renders the argument (positions, winner, why, dissent) + the teamwork card",
    src("app/dashboard/admin/manager-trust/manager-trust-client.tsx").includes("DeliberationBlock")
    && src("app/dashboard/admin/manager-trust/manager-trust-client.tsx").includes("winning position")
    && src("app/dashboard/admin/manager-trust/manager-trust-client.tsx").includes("Dissents recorded"))
  check("the QBR loader feeds composeTeamworkLines (mounted, not orphaned)",
    src("lib/intelligence/quarterly-review-loader.ts").includes("composeTeamworkLines")
    && src("app/dashboard/admin/command-center/quarterly-review-card.tsx").includes(`section("Teamwork"`))
  check("the deliberation ledger write rides sentinelWrite (no silent loss)",
    src("lib/managers/deliberation.ts").includes("sentinelWrite"))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live deliberation]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  console.log("\n[Layer 2 · live — grounded briefs, ledger persistence, idempotent reuse]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { raiseCrossManagerReferral } = await import("../lib/managers/cross-referral")
  const { runDeliberation, loadManagerBrief } = await import("../lib/managers/deliberation")
  const { loadTeamworkMetrics } = await import("../lib/managers/teamwork-metrics")
  const svc = createServiceClient()
  const TAG = `__delib_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    const brokerageId = (brk as { id: string }).id

    // Grounded briefs: every deliberative participant's loader runs against REAL tables.
    for (const d of deliberativeDomains()) {
      const briefsLive = await Promise.all(d.managers.map((mk: ManagerKey) =>
        loadManagerBrief(mk, { brokerageId, ask: "sim", entityType: null, entityId: null }, svc)))
      check(`'${d.key}': every participant loads a brief from its own stewarded tables (no throw, arrays returned)`,
        briefsLive.every((b) => Array.isArray(b.facts) && Array.isArray(b.citations)))
      check(`'${d.key}': citations are field-level (table.column=...) when facts exist`,
        briefsLive.every((b) => b.facts.length === 0 || b.citations.every((c) => /^[a-z_]+\.[a-z_]+.*=/.test(c))))
    }

    // Raise a REAL referral on the deliberative pricing-dispute domain.
    const raised = await raiseCrossManagerReferral({
      brokerageId, fromManager: "listing_concierge", toManager: "shopping_agent",
      collabDomain: "listing_demand_bridge",
      ask: `${TAG} 41 days on market and buyer demand disagrees with the price — argue the move.`,
    }, svc)
    check("live: the referral publishes on the governed bus", raised.ok && !!raised.signalId, raised.reason)
    if (raised.signalId) cleanup.push({ table: "manager_signals", id: raised.signalId })

    const { data: sigRow } = await svc.from("manager_signals").select("payload").eq("id", raised.signalId!).single()
    const live = await runDeliberation({
      brokerageId, collabDomain: "listing_demand_bridge",
      ask: `${TAG} argue the price move`, fromManager: "listing_concierge",
      signalId: raised.signalId!, existingPayload: (sigRow as { payload: Record<string, unknown> }).payload,
    }, svc, fixtureEngine())
    check("live: the deliberation resolves with a winner + the stated why",
      live?.status === "resolved" && !!live.winner && (live.resolution ?? "").length > 0)

    const { data: after } = await svc.from("manager_signals").select("payload").eq("id", raised.signalId!).single()
    const persisted = parseDeliberation((after as { payload: Record<string, unknown> }).payload)
    check("live: the record persisted onto the EXISTING referral ledger row (payload.deliberation)",
      persisted?.status === "resolved" && persisted.winner === live?.winner)
    check("live: the merge kept the referral's original payload keys (collab_domain survives)",
      ((after as { payload: Record<string, unknown> }).payload)["collab_domain"] === "listing_demand_bridge")

    // Idempotent reuse: a retry with a THROWING engine returns the persisted record untouched.
    const reused = await runDeliberation({
      brokerageId, collabDomain: "listing_demand_bridge",
      ask: `${TAG} argue the price move`, fromManager: "listing_concierge",
      signalId: raised.signalId!, existingPayload: (after as { payload: Record<string, unknown> }).payload,
    }, svc, fixtureEngine({ argue: async () => { throw new Error("must not be called on a retry") } }))
    check("live: a retried deliberation REUSES the persisted record — never re-argues (no double gateway spend)",
      reused?.status === "resolved" && reused.winner === live?.winner && reused.deliberatedAt === live?.deliberatedAt)

    // Metrics loader folds the live row (deliberationsHeld counts it while it exists).
    const liveMetrics = await loadTeamworkMetrics(brokerageId, { days: 1 }, svc)
    check("live: the teamwork loader rolls the referral + deliberation off the one ledger",
      liveMetrics.handedOff >= 1 && liveMetrics.deliberationsHeld >= 1)

    // Non-deliberative + unknown domains refuse escalation at runDeliberation itself.
    const notDelib = await runDeliberation({
      brokerageId, collabDomain: "approval_queue_slo", ask: "x", fromManager: "cron_manager",
    }, svc, fixtureEngine())
    check("live: a non-deliberative domain never deliberates (runDeliberation → null)", notDelib === null)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).like("message", `%${TAG}%`)
    check("cleanup verified — 0 seeded signals remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
