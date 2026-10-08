#!/usr/bin/env tsx
/**
 * scripts/orphan-readers-percentile-simulator.ts (npm run test:orphan-readers-percentile) — pure, no DB.
 *
 * Proves the pure percentile95 helper (lib/admin/tool-call-metrics.ts) behind
 * TWO orphan-doctrine §1.2 readers built in the same wave — ONE VOCABULARY
 * (§6), not two spellings of the same rank math:
 *   - app/actions/admin/agent-assistant-tool-calls.ts::getAgentAssistantToolCallSummary
 *     (agent_assistant_tool_calls — 6 columns written by
 *     app/api/agent-assistant/tool-call/route.ts, no reader before this lane)
 *   - app/actions/observability/observability-actions.ts::fetchEventProcessingHealth
 *     (event_processing_log — 5 columns written by
 *     lib/orchestrator/internal.ts::logProcessingResults, no reader before this lane)
 *
 * Positive control (§2): a broken percentile pick (e.g. always returning the
 * max, or the median) would fail the "p95 sits at the 95th rank, not lower
 * and not the max" checks below — this is not a finder that can report zero
 * on a hollowed-out implementation.
 */
import { percentile95 } from "../lib/admin/tool-call-metrics"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.log(`  ✗ ${n}`) }
}

console.log("\n[agent_assistant_tool_calls reader · pure]")

check("empty input → null (no divide-by-zero, no fake zero)", percentile95([]) === null)
check("single value → that value", percentile95([42]) === 42)

{
  // 100 latencies, 1..100ms sorted ascending. p95 rank = ceil(100*0.95)=95 → value 95.
  const latencies = Array.from({ length: 100 }, (_, i) => i + 1)
  const p95 = percentile95(latencies)
  check("p95 of 1..100 is 95 (not the max 100, not the median 50)", p95 === 95)
  check("p95 is strictly less than the max for a spread sample", p95! < 100)
  check("p95 is strictly greater than the median for a spread sample", p95! > 50)
}

{
  // All-identical latencies: p95 must equal the constant, not drift.
  const flat = Array.from({ length: 20 }, () => 250)
  check("p95 of a flat distribution equals the constant", percentile95(flat) === 250)
}

{
  // Small sample (5 values): rank = ceil(5*0.95)=5 → the max (index 4).
  const small = [10, 20, 30, 40, 50]
  check("p95 of a 5-value sample is the max (rank rounds up to the last)", percentile95(small) === 50)
}

console.log("\n──────────────────────────────────────────────────")
if (fail > 0) {
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  process.exit(1)
}
console.log(` RESULT: ${pass} passed, 0 failed`)
console.log(" ✅ ORPHAN_READERS_PERCENTILE_PASS — p95 helper behind both new observability readers holds")
