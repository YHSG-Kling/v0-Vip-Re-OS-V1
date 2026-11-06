#!/usr/bin/env tsx
/**
 * scripts/outcome-learning-guard.ts  (npm run test:outcome-learning)
 * ────────────────────────────────────────────────────────────────────────
 * WAVE 150, LANE 150JNAD — directive 150AD: outcome learning by buyer / seller window, source, territory, play, campaign and tenant;
 * attribution and false positives, confirmed seller / buyer moves, independent holdouts, spend per INCREMENTAL outcome.
 * Driven through lib/intelligence/strategy-learning.ts (movementOutcomeLearning, tenantMovementOutcomeLearning, runStrategyLearning)
 * on an in-memory database. Deterministic statistics, no model.
 *
 *   A. THE CELLS — every dimension present; appointments counted beside confirmed moves, never as one; false positives counted;
 *      `source` credits a subject's every record with the subject's ONE outcome (shared attribution, never a sum).
 *   B. HOLDOUTS — thin data is never a verdict; a significant treated-vs-holdout lift yields the incremental rate and the spend per
 *      INCREMENTAL confirmed move (= treated spend / incremental moves); no lift → no figure (positive control both ways).
 *   C. THE TENANT READ — tenant-pinned (a foreign tenant's closed rows never count); campaign = agent_action_ledger.detail.strategy;
 *      territory = contacts.zip_code; spend = the subject's ledger cost_usd; the holdout arm the decision stamped.
 *   D. THE WEEKLY RUN — runStrategyLearning carries the movement summary; a significant holdout verdict becomes ONE improvement
 *      proposal a human approves (idempotent on re-run).
 *   E. SOURCE — no new prediction store: the learning reads movement_signals + ai_predictions survivors only.
 *
 * BLIND SPOTS, published: memSupabase has no RLS; `play` is the movement manager's decision, not the arbiter's chosen experience;
 * `moved` needs a person's mark (the reconciler closes listed / purchased / opted out / no change); platform-scope movement learning
 * (k-anonymous network cells) is not built — tenant scope only.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { stripComments, blankStrings } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function ok(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await f() } finally { console.warn = w; console.error = e } }

const B = "11111111-1111-4111-8111-111111111111", B2 = "22222222-2222-4222-8222-222222222222"
const NOW = new Date("2026-11-06T15:00:00.000Z")
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()

type Row = { subjectId: string; window: string; side: string; sourceKey: string; territory: string; play: string; campaign: string; arm: string; outcome: string; spendUsd: number }
const row = (i: number, x: Partial<Row>): Row => ({ subjectId: `s${i}`, window: "31_90", side: "seller", sourceKey: "fp_calc_seller_net", territory: "78701", play: "offer_help", campaign: "none", arm: "treated", outcome: "no_change", spendUsd: 2, ...x })

async function main() {
  const sl = await import("../lib/intelligence/strategy-learning")
  // Every number is read THROUGH the product path (the weekly runStrategyLearning → tenantMovementOutcomeLearning) over stored rows.
  let rid = 0
  const dbFor = (rows: Row[]) => {
    const subjects = [...new Set(rows.map((r) => r.subjectId))]
    const first = (id: string) => rows.find((r) => r.subjectId === id)!
    return memSupabase({
      movement_signals: rows.map((r) => ({ id: `r${++rid}`, brokerage_id: B, contact_id: r.subjectId, lead_id: null, source_key: r.sourceKey, side: "unknown", outcome: r.outcome, outcome_at: daysAgo(5), next_action: r.play, decision: { holdout: { arm: r.arm } }, decision_window: r.window, moment: { segments: [r.side] } })),
      contacts: subjects.map((id) => ({ id, brokerage_id: B, zip_code: first(id).territory })),
      agent_action_ledger: subjects.map((id) => ({ id: `l-${id}`, brokerage_id: B, subject_type: "contact", subject_id: id, cost_usd: first(id).spendUsd, created_at: daysAgo(20), detail: first(id).campaign !== "none" ? { strategy: first(id).campaign } : {} })),
      improvement_proposals: [],
    } as never, { uuidIds: true, stampCreatedAt: true }) as any
  }
  const learn = async (rows: Row[]) => { const run = await quiet(() => sl.runStrategyLearning(dbFor(rows), B, { windowDays: 90, now: NOW })); if (!run.movement) throw new Error(`no movement learning: ${run.errors.join("; ")}`); return run.movement.learning }

  console.log("\nA. the cells")
  {
    const rows: Row[] = [
      row(1, { outcome: "listed" }), row(1, { outcome: "listed", sourceKey: "pr_permit_activity" }),
      row(2, { outcome: "appointment", side: "buyer", window: "91_180" }), row(3, { outcome: "false_positive" }), row(4, { outcome: "purchased", side: "buyer", territory: "78702", campaign: "spring_guide@v1" }),
      row(5, { outcome: "engaged" }), row(5, { outcome: "declined", sourceKey: "pp_reddit_relocation" }),
    ]
    const L = await learn(rows)
    const dims = [...new Set(L.cells.map((c) => c.dimension))].sort()
    ok(JSON.stringify(dims) === JSON.stringify(["campaign", "play", "side", "source", "tenant", "territory", "window"]), `every dimension present (${dims.join(", ")})`)
    const tenant = L.cells.find((c) => c.dimension === "tenant")!
    ok(tenant.subjects === 5 && tenant.confirmedMoves === 2 && tenant.appointments === 1 && tenant.falsePositives === 1, `tenant: 5 SUBJECTS (not 7 records), 2 confirmed moves, the appointment counted beside them (${tenant.confirmedMoves}/${tenant.appointments})`)
    ok(tenant.confirmedRate === 0.4, "an appointment never raises the confirmed-move rate (2/5 = 0.4)")
    const permit = L.cells.find((c) => c.dimension === "source" && c.key === "pr_permit_activity")!, reddit = L.cells.find((c) => c.dimension === "source" && c.key === "pp_reddit_relocation")!
    ok(permit.confirmedMoves === 1 && reddit.engaged === 1 && reddit.declined === 0, "source cells credit each record with its SUBJECT's one outcome (shared attribution — s5's decline is history beside its engagement)")
    const w = L.cells.find((c) => c.dimension === "window" && c.key === "91_180")!, side = L.cells.find((c) => c.dimension === "side" && c.key === "buyer")!, camp = L.cells.find((c) => c.dimension === "campaign" && c.key === "spring_guide@v1")!
    ok(w.appointments === 1 && w.confirmedMoves === 0 && side.subjects === 2 && camp.confirmedMoves === 1, "window / side / campaign cells read the subject's snapshot")
    ok(L.blindSpots.some((b) => /appointment/.test(b)) && L.blindSpots.length >= 4, "blind spots published beside the numbers")
  }

  console.log("\nB. independent holdouts — incremental lift and spend per incremental move")
  {
    const thin = await learn([row(1, { outcome: "listed" }), row(2, { arm: "holdout" })])
    ok(thin.holdout.significance.verdict === "insufficient_sample" && thin.holdout.spendPerIncrementalMove === null && thin.holdout.incrementalRate === null, "thin data is never a verdict (no lift, no spend figure)")
    const lift: Row[] = [
      ...Array.from({ length: 100 }, (_, i) => row(i, { arm: "treated", outcome: i < 30 ? "listed" : "no_change", spendUsd: 5 })),
      ...Array.from({ length: 100 }, (_, i) => row(1000 + i, { arm: "holdout", outcome: i < 10 ? "listed" : "no_change", spendUsd: 0 })),
    ]
    const L = await learn(lift)
    ok(L.holdout.significance.verdict === "a_better" && L.holdout.incrementalRate === 0.2, `30 % treated vs 10 % holdout → significant lift of 0.2 (${L.holdout.significance.why})`)
    ok(L.holdout.spendPerIncrementalMove === 25, `spend per INCREMENTAL move = $500 / 20 incremental moves = $25 (not $500 / 30 raw moves) — got ${L.holdout.spendPerIncrementalMove}`)
    const none = await learn([
      ...Array.from({ length: 100 }, (_, i) => row(i, { arm: "treated", outcome: i < 20 ? "listed" : "no_change", spendUsd: 5 })),
      ...Array.from({ length: 100 }, (_, i) => row(1000 + i, { arm: "holdout", outcome: i < 20 ? "listed" : "no_change", spendUsd: 0 })),
    ])
    ok(none.holdout.significance.verdict === "no_difference" && none.holdout.spendPerIncrementalMove === null, "(control) no lift over the holdout → no spend-per-incremental figure (outreach is not credited with moves that happen anyway)")
    const appts = await learn([
      ...Array.from({ length: 100 }, (_, i) => row(i, { arm: "treated", outcome: i < 30 ? "appointment" : "no_change" })),
      ...Array.from({ length: 100 }, (_, i) => row(1000 + i, { arm: "holdout", outcome: "no_change" })),
    ])
    ok(appts.holdout.treated.confirmed === 0 && appts.holdout.significance.verdict !== "a_better", "appointments never count as confirmed moves in the lift")
  }

  console.log("\nC. the tenant read")
  {
    const ms = (id: string, b: string, contact: string, outcome: string, arm: string, extra: Record<string, unknown> = {}) => ({ id, brokerage_id: b, contact_id: contact, lead_id: null, source_key: "fp_calc_seller_net", side: "seller", outcome, outcome_at: daysAgo(5), next_action: "offer_help", decision: { holdout: { arm } }, decision_window: "31_90", ...extra })
    const d = memSupabase({
      movement_signals: [ms("a", B, "c1", "listed", "treated"), ms("b", B, "c2", "false_positive", "holdout", { decision_window: "91_180" }), ms("x", B2, "c9", "listed", "treated"), { ...ms("o", B, "c3", "", "treated"), outcome: null, outcome_at: null }],
      contacts: [{ id: "c1", brokerage_id: B, zip_code: "78701-1234" }, { id: "c2", brokerage_id: B, zip_code: "78702" }, { id: "c9", brokerage_id: B2, zip_code: "10001" }],
      agent_action_ledger: [
        { id: "l1", brokerage_id: B, subject_type: "contact", subject_id: "c1", cost_usd: 1.5, created_at: daysAgo(10), detail: { strategy: { key: "seller_equity_letter", version: 2 } } },
        { id: "l2", brokerage_id: B, subject_type: "contact", subject_id: "c1", cost_usd: 0.5, created_at: daysAgo(9), detail: {} },
        { id: "l3", brokerage_id: B2, subject_type: "contact", subject_id: "c1", cost_usd: 99, created_at: daysAgo(9), detail: { strategy: "foreign_play" } },
      ],
    } as never, { uuidIds: true }) as any
    const run = await quiet(() => sl.runStrategyLearning(d, B, { windowDays: 90, now: NOW }))
    ok(!!run.movement && run.movement.rows === 2, `only THIS tenant's CLOSED rows are read (${run.movement ? run.movement.rows : run.errors.join("; ")})`)
    if (run.movement) {
      const L = run.movement.learning
      const camp = L.cells.find((c) => c.dimension === "campaign" && c.key === "seller_equity_letter@v2")
      const terr = L.cells.find((c) => c.dimension === "territory" && c.key === "78701")
      const fp = L.cells.find((c) => c.dimension === "window" && c.key === "91_180")
      ok(!!camp && camp.confirmedMoves === 1 && camp.spendUsd === 2, `campaign = the ledger's strategy ref; spend = the subject's own cost_usd ($2, never the foreign $99) — ${JSON.stringify(camp)}`)
      ok(!!terr && !L.cells.some((c) => c.key === "10001"), "territory = the contact's 5-digit zip; the foreign tenant's zip never appears")
      ok(!!fp && fp.falsePositives === 1 && L.holdout.holdout.subjects === 1 && L.holdout.treated.subjects === 1, "the false positive lands in its window cell; the stamped holdout arm splits treated / holdout")
    }
    const refused = await quiet(() => sl.runStrategyLearning(memSupabase({} as never, { missingTables: ["movement_signals"] }) as any, B, { windowDays: 90, now: NOW }))
    ok(!refused.movement && refused.errors.some((e) => /movement_signals/.test(e)), "a refused read returns the error, never zeros")
  }

  console.log("\nD. the weekly run")
  {
    const closed = [
      ...Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, brokerage_id: B, contact_id: `ct${i}`, lead_id: null, source_key: "fp_calc_seller_net", side: "seller", outcome: i < 30 ? "listed" : "no_change", outcome_at: daysAgo(5), next_action: "offer_help", decision: { holdout: { arm: "treated" } }, decision_window: "31_90" })),
      ...Array.from({ length: 100 }, (_, i) => ({ id: `h${i}`, brokerage_id: B, contact_id: `ch${i}`, lead_id: null, source_key: "fp_calc_seller_net", side: "seller", outcome: i < 10 ? "listed" : "no_change", outcome_at: daysAgo(5), next_action: "wait", decision: { holdout: { arm: "holdout" } }, decision_window: "31_90" })),
    ]
    const d = memSupabase({ movement_signals: closed, contacts: [], agent_action_ledger: [], improvement_proposals: [] } as never, { uuidIds: true, stampCreatedAt: true }) as any
    const run = await quiet(() => sl.runStrategyLearning(d, B, { windowDays: 90, now: NOW }))
    const props = ((await d.from("improvement_proposals").select("*")).data ?? []) as Array<Record<string, any>>
    ok(run.movement?.rows === 200 && run.movement.holdoutVerdict === "a_better", `the weekly run carries the movement summary (${JSON.stringify(run.movement)})`)
    ok(props.length === 1 && props[0].subject_key === "movement_outreach_lift:treated|holdout" && run.proposed === 1, `a significant holdout verdict → ONE improvement proposal a human approves (${props.length}; errors ${run.errors.join("; ")})`)
    const again = await quiet(() => sl.runStrategyLearning(d, B, { windowDays: 90, now: NOW }))
    const props2 = ((await d.from("improvement_proposals").select("*")).data ?? []) as unknown[]
    ok(props2.length === 1 && again.existing >= 1, "(idempotent) a re-run reuses the open proposal")
  }

  console.log("\nE. source — survivors only, no second prediction store")
  {
    const s = blankStrings(stripComments(readFileSync(join(process.cwd(), "lib/intelligence/strategy-learning.ts"), "utf8")))
    const tables = [...s.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1])
    const raw = stripComments(readFileSync(join(process.cwd(), "lib/intelligence/strategy-learning.ts"), "utf8"))
    const named = [...raw.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1])
    ok(tables.length === 0 || named.length > 0, "scan sanity: stripped source still sees .from( calls")
    const allowed = new Set(["agent_action_ledger", "leads", "contact_suppression_list", "movement_signals", "contacts"])
    ok(named.length > 0 && named.every((t) => allowed.has(t)), `strategy-learning reads only survivors (${[...new Set(named)].join(", ")})`)
    ok(!allowed.has("movement_predictions") && !/movement_predictions|window_forecasts/.test(raw), "(control) no second prediction table is named")
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); console.log("❌ OUTCOME_LEARNING_FAIL"); process.exit(1) }
  console.log("✅ OUTCOME_LEARNING_PASS")
}

main().catch((e) => { console.error(e); console.log("❌ OUTCOME_LEARNING_FAIL (threw)"); process.exit(1) })
