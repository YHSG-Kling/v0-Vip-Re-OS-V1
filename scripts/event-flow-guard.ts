#!/usr/bin/env tsx
/**
 * scripts/event-flow-guard.ts  (npm run test:event-flow) — pure, no DB.
 *
 * FLOW-INTEGRITY RATCHET for the event-driven agentic OS. The business process routes every
 * state change through the `events` table → the orchestrator (lib/orchestrator/internal.ts:
 * HANDLERS map + the chain registry). An event_type that is EMITTED in the code but has NO
 * handler falls through the orchestrator's `default:` (logged, but the intended downstream
 * manager reaction never fires) — a silent broken flow.
 *
 * This scans every emitted `event_type: "x.y"` and fails on any NEW one that isn't handled
 * (HANDLERS map) and isn't in the baseline (the known set, which may be chain-handled or
 * intentionally audit-only). New flow drift can't accumulate.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASELINE_PATH = join(root, "scripts", "event-flow-baseline.json")

function walk(dir: string, out: string[]) {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const n of entries) {
    if (n === "node_modules" || n.startsWith(".")) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(n)) out.push(relative(root, p).replace(/\\/g, "/"))
  }
}

const all: string[] = []
walk(join(root, "app"), all)
walk(join(root, "lib"), all)

// Emitted events: `event_type: "x.y"` (the canonical emit shape used by logEvent* helpers).
const emitRe = /event_type\s*:\s*["']([a-z_]+\.[a-z_]+)["']/g
const emitted = new Set<string>()
for (const f of all) {
  const src = readFileSync(join(root, f), "utf8")
  let m: RegExpExecArray | null
  while ((m = emitRe.exec(src))) emitted.add(m[1])
}

// Handled events: the orchestrator HANDLERS map keys.
const orch = readFileSync(join(root, "lib/orchestrator/internal.ts"), "utf8")
const handled = new Set<string>()
const handlerRe = /["']([a-z_]+\.[a-z_]+)["']\s*:/g
let hm: RegExpExecArray | null
while ((hm = handlerRe.exec(orch))) handled.add(hm[1])

const unhandled = Array.from(emitted).filter((e) => !handled.has(e)).sort()

let baseline: string[] = []
try { baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as string[] } catch { /* none yet */ }
const baseSet = new Set(baseline)
const newGaps = unhandled.filter((e) => !baseSet.has(e))
const closed = baseline.filter((b) => handled.has(b) || !emitted.has(b)) // now-handled or no longer emitted

console.log("\n[event-flow guard — every emitted event must be handled (or baselined)]")
console.log(`  emitted: ${emitted.size} · handled: ${handled.size} · unhandled (debt): ${unhandled.length}`)

if (closed.length > 0) {
  console.log(`  ↓ ${closed.length} baseline gap(s) now closed — run with UPDATE_EVENT_FLOW_BASELINE=1 to shrink:`)
  for (const c of closed) console.log(`     · ${c}`)
}

if (process.env.UPDATE_EVENT_FLOW_BASELINE === "1") {
  writeFileSync(BASELINE_PATH, JSON.stringify(unhandled, null, 2) + "\n")
  console.log(`  ✎ baseline rewritten to ${unhandled.length} entr${unhandled.length === 1 ? "y" : "ies"}.`)
  console.log("\n RESULT: 1 passed, 0 failed")
  process.exit(0)
}

if (newGaps.length > 0) {
  console.log(`  ✗ ${newGaps.length} NEW emitted event(s) with no orchestrator handler — add a handler or baseline:`)
  for (const g of newGaps) console.log(`     - ${g}`)
  console.log("\n──────────────────────────────────────────────────")
  console.log(" RESULT: 0 passed, 1 failed")
  process.exit(1)
}

console.log("\n──────────────────────────────────────────────────")
console.log(" RESULT: 1 passed, 0 failed")
console.log(unhandled.length === 0
  ? " ✅ EVENT_FLOW_PASS — every emitted event has an orchestrator handler"
  : ` ✅ NO_NEW_FLOW_GAPS — no new unhandled events (${unhandled.length} known, chain-handled or audit-only)`)
