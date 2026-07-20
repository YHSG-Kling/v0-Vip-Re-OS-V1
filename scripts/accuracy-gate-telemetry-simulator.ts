#!/usr/bin/env tsx
/**
 * scripts/accuracy-gate-telemetry-simulator.ts
 *   run: npx tsx --conditions=react-server scripts/accuracy-gate-telemetry-simulator.ts
 *   suggested npm script (NOT added here — package.json is owned elsewhere):
 *     "test:accuracy-gate-telemetry": "tsx --conditions=react-server scripts/accuracy-gate-telemetry-simulator.ts"
 *
 * ROUND 37 PROOF (owner-approved rec 3) — accuracy-gate HOLD TELEMETRY:
 * round 36 wired the accuracy gate into dispatch, so holds HAPPEN but weren't
 * surfaced. This proves the surfacing end to end:
 *
 *  Layer 1 (pure): verdict → ledger-event shape. The EXISTING self_heal_events
 *    idiom is reused (the budget-gate egress-block precedent): domain
 *    'data_flow', outcome 'escalated', a subject that COLLAPSES per
 *    domain+brokerage (a burst of held sends folds into ONE Exception Center
 *    item), the measured reason verbatim in detail.
 *  Layer 2 (pure): only a 'supervised' verdict holds — earned / no_signal /
 *    not_applicable never record (nothing to surface, nothing invented).
 *  Layer 3 (pure): the rollup fold — holds per manager/domain per period with
 *    the MOST RECENT measured reason; foreign ledger rows are ignored.
 *  Layer 4 (behavioral, stubbed I/O): recordAccuracyGateHold writes the exact
 *    row to self_heal_events; loadAccuracyHoldRollup reads it back scoped to
 *    the brokerage; a failed ledger read returns null (honest unavailable),
 *    never a fake zero.
 *  Layer 5 (source locks): dispatch records fire-and-forget INSIDE the
 *    fail-open try (telemetry can never fail a send), the manager-trust page
 *    loads the rollup, and the panel renders honest empty + unavailable states.
 */

import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import {
  ACCURACY_GATE_POLICIES,
  ACCURACY_HOLD_FLOW,
  ACCURACY_HOLD_SUBJECT_PREFIX,
  accuracyGateVerdict,
  accuracyHold,
  buildAccuracyHoldEvent,
  foldAccuracyHolds,
  recordAccuracyGateHold,
  loadAccuracyHoldRollup,
} from "../lib/managers/accuracy-gate"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function section(title: string) { console.log(`\n■ ${title}`) }

// Fixture verdicts through the REAL policy engine (never hand-built states).
const thinRail: any = { available: true, observations: 2, label: "Listing price", medianError: null, withinRate: null }
const strongRail: any = { available: true, observations: 12, label: "Listing price", medianError: { value: 0.03, unit: "pct_of_sale" }, withinRate: null }
const supervised = accuracyGateVerdict(ACCURACY_GATE_POLICIES.pricing, thinRail)
const earned = accuracyGateVerdict(ACCURACY_GATE_POLICIES.pricing, strongRail)
const noSignal = accuracyGateVerdict(ACCURACY_GATE_POLICIES.pricing, null)

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 1 — verdict → the exact self-heal ledger event (budget-gate idiom)")

const evt = buildAccuracyHoldEvent({ brokerageId: "b-1", managerKey: "listing_concierge", verdict: supervised, systemSource: "sequence" })
check("subject collapses per domain+brokerage under the accuracy_gate: prefix",
  evt.subject === `${ACCURACY_HOLD_SUBJECT_PREFIX}pricing:b-1`)
check("outcome is 'escalated' (an open Exception Center item — a human is being routed in)",
  evt.outcome === "escalated" && evt.action === "none")
check("detail carries the flow discriminator + manager/domain/rail/observations",
  evt.detail.flow === ACCURACY_HOLD_FLOW && evt.detail.manager_key === "listing_concierge"
  && evt.detail.domain === "pricing" && evt.detail.rail === "listing_price" && evt.detail.observations === 2)
check("detail.reason is the MEASURED reason verbatim (the same numbers dispatch stated)",
  evt.detail.reason === supervised.reason && /2 graded outcome/.test(evt.detail.reason))
check("system_source rides along (defaults to 'dispatch' when absent)",
  evt.detail.system_source === "sequence"
  && buildAccuracyHoldEvent({ brokerageId: "b-1", managerKey: "listing_concierge", verdict: supervised }).detail.system_source === "dispatch")

const evt2 = buildAccuracyHoldEvent({ brokerageId: "b-1", managerKey: "listing_concierge", verdict: supervised })
const evtOtherDomain = buildAccuracyHoldEvent({ brokerageId: "b-1", managerKey: "campaign_orchestrator", verdict: accuracyGateVerdict(ACCURACY_GATE_POLICIES.marketing_content, thinRail) })
const evtOtherTenant = buildAccuracyHoldEvent({ brokerageId: "b-2", managerKey: "listing_concierge", verdict: supervised })
check("a burst of holds in one domain folds to ONE subject; other domains/tenants do not",
  evt.subject === evt2.subject && evt.subject !== evtOtherDomain.subject && evt.subject !== evtOtherTenant.subject)

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 2 — only 'supervised' holds (earned / no-signal never record)")

check("supervised verdict → held with the measured reason", accuracyHold(supervised).held === true && accuracyHold(supervised).reason === supervised.reason)
check("earned verdict → not held (nothing to ledger)", accuracyHold(earned).held === false)
check("no_signal (rail unreadable) → not held — fail-open, an infra hiccup never freezes outbound",
  accuracyHold(noSignal).held === false && noSignal.state === "no_signal")

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 3 — the rollup fold (holds per manager/domain + latest measured reason)")

{
  const rows = [
    { detail: { flow: ACCURACY_HOLD_FLOW, manager_key: "listing_concierge", domain: "pricing", reason: "older reason" }, created_at: "2026-07-10T00:00:00Z" },
    { detail: { flow: ACCURACY_HOLD_FLOW, manager_key: "listing_concierge", domain: "pricing", reason: "newest reason" }, created_at: "2026-07-18T00:00:00Z" },
    { detail: { flow: ACCURACY_HOLD_FLOW, manager_key: "campaign_orchestrator", domain: "marketing_content", reason: "content thin" }, created_at: "2026-07-12T00:00:00Z" },
    // a foreign self-heal row that happens to share the window — must be ignored
    { detail: { flow: "egress_budget_blocked", reason: "budget" }, created_at: "2026-07-15T00:00:00Z" },
    { detail: null, created_at: "2026-07-15T00:00:00Z" },
  ]
  const roll = foldAccuracyHolds(rows, 30)
  check("counts holds per manager/domain (2 pricing + 1 content = 3 total; foreign rows ignored)",
    roll.totalHolds === 3 && roll.rows.length === 2 && roll.rows[0].holds === 2)
  check("carries the MOST RECENT measured reason per row",
    roll.rows[0].lastReason === "newest reason" && roll.rows[0].lastAt === "2026-07-18T00:00:00Z")
  check("sorted most-held first; window preserved on the rollup",
    roll.rows[0].managerKey === "listing_concierge" && roll.rows[1].managerKey === "campaign_orchestrator" && roll.windowDays === 30)
}
check("an empty ledger folds to the honest zero (not null, not invented rows)",
  foldAccuracyHolds([], 30).totalHolds === 0 && foldAccuracyHolds([], 30).rows.length === 0)

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 4 — behavioral (stubbed I/O): write the row, read the rollup, honest failure")

{
  // recordAccuracyGateHold → the exact self_heal_events insert.
  const inserted: Array<{ table: string; row: any }> = []
  const writeSvc: any = {
    from: (table: string) => ({
      insert: (row: any) => ({ then: (res: any) => { inserted.push({ table, row }); res?.(); return Promise.resolve() } }),
    }),
  }
  await recordAccuracyGateHold({ brokerageId: "b-1", managerKey: "listing_concierge", verdict: supervised, systemSource: "sequence" }, writeSvc)
  const w = inserted[0]
  check("recordAccuracyGateHold appends ONE self_heal_events row (no new table)",
    inserted.length === 1 && w.table === "self_heal_events")
  check("…with domain data_flow / outcome escalated / the collapsing subject / the flow key",
    w.row.domain === "data_flow" && w.row.outcome === "escalated"
    && w.row.subject === `${ACCURACY_HOLD_SUBJECT_PREFIX}pricing:b-1` && w.row.detail?.flow === ACCURACY_HOLD_FLOW)
  check("…brokerage-scoped (the rollup and the Exception Center read it back per tenant)",
    w.row.brokerage_id === "b-1")
}
{
  // recordAccuracyGateHold NEVER throws — a broken ledger client is swallowed (fail-open).
  const brokenSvc: any = { from: () => { throw new Error("ledger down") } }
  let threw = false
  try {
    await recordAccuracyGateHold({ brokerageId: "b-1", managerKey: "listing_concierge", verdict: supervised }, brokenSvc)
  } catch { threw = true }
  check("recording is fail-open: a broken ledger never throws into the dispatch path", threw === false)
}
{
  // loadAccuracyHoldRollup: brokerage-scoped read → folded rollup.
  const filters: Record<string, unknown> = {}
  const rows = [
    { detail: { flow: ACCURACY_HOLD_FLOW, manager_key: "listing_concierge", domain: "pricing", reason: "rail thin" }, created_at: "2026-07-18T00:00:00Z" },
  ]
  const readSvc: any = {
    from: (table: string) => {
      const b: any = {
        select: () => b,
        eq: (k: string, v: unknown) => { filters[k] = v; return b },
        like: (k: string, v: unknown) => { filters[`like:${k}`] = v; return b },
        gte: () => b,
        order: () => b,
        limit: () => b,
        then: (res: any) => Promise.resolve({ data: rows, error: null }).then(res),
      }
      filters.__table = table
      return b
    },
  }
  const roll = await loadAccuracyHoldRollup("b-1", 30, readSvc)
  check("rollup read is tenant-scoped to self_heal_events by the subject prefix",
    filters.__table === "self_heal_events" && filters.brokerage_id === "b-1"
    && filters.domain === "data_flow" && filters["like:subject"] === `${ACCURACY_HOLD_SUBJECT_PREFIX}%`)
  check("rollup returns the folded counts + measured reason",
    !!roll && roll.totalHolds === 1 && roll.rows[0].lastReason === "rail thin")
}
{
  const errSvc: any = { from: () => { throw new Error("read failed") } }
  const roll = await loadAccuracyHoldRollup("b-1", 30, errSvc)
  check("a failed ledger read returns null (rendered 'unavailable') — never a fake zero", roll === null)
}

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 5 — source locks (the recording is wired where the hold happens)")

const dispatchSrc = src("lib/providers/dispatch.ts")
check("dispatch ARMS telemetry at the enforcement site (record: true on the SAME gate call)",
  dispatchSrc.includes("loadAccuracyHoldForManager") && /record:\s*true/.test(dispatchSrc))
check("…passing the send's systemSource through for attribution",
  /systemSource:\s*args\.systemSource/.test(dispatchSrc))
check("…inside the fail-open try (a telemetry error can never fail a send)",
  dispatchSrc.includes("} catch { accuracyGate = undefined }"))
const gateHelperSrc = src("lib/managers/accuracy-gate.ts")
check("the helper records FIRE-AND-FORGET (void), guarded to HELD verdicts with telemetry armed",
  /if \(hold\.held && telemetry\?\.record\) \{[\s\S]{0,200}void recordAccuracyGateHold\(/.test(gateHelperSrc))
check("enforced hold and ledgered hold derive from the SAME verdict (no drift)",
  gateHelperSrc.includes("const hold = accuracyHold(verdict)")
  && gateHelperSrc.includes("recordAccuracyGateHold({ brokerageId, managerKey, verdict"))

const trustPageSrc = src("app/dashboard/admin/manager-trust/page.tsx")
check("manager-trust page loads the hold rollup beside the accuracy verdicts",
  trustPageSrc.includes("loadAccuracyHoldRollup"))
const trustClientSrc = src("app/dashboard/admin/manager-trust/manager-trust-client.tsx")
check("the panel renders the throttle counts ('sends held by the accuracy gate')",
  trustClientSrc.includes("sends held by the accuracy gate"))
check("…with an HONEST empty state (zero holds is a stated fact, not a hidden card)",
  trustClientSrc.includes("No autonomous sends were held by the accuracy gate"))
check("…and an HONEST unavailable state when the ledger read fails",
  trustClientSrc.includes("Hold telemetry could not be read"))

const gateSrc = src("lib/managers/accuracy-gate.ts")
check("no new table: recording rides recordSelfHeal on self_heal_events",
  gateSrc.includes('await import("@/lib/kernel/self-heal-ledger")') && gateSrc.includes("recordSelfHeal(svc"))

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}\n${fail === 0 ? "✅" : "❌"} accuracy-gate telemetry simulator: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
