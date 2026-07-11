#!/usr/bin/env tsx
/**
 * scripts/signal-integrity-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SIGNAL-INTEGRITY PROOF — the bus's "zero orphans" guard, exactly as test:egress-coverage
 * guards the egress burn-domains. The Command Center's differentiator is that managers COORDINATE on
 * manager_signals; this proves that coordination stays GOVERNED:
 *   1. every signal_type PUBLISHED in lib/ + app/ is catalogued in SIGNAL_REGISTRY (no orphan signal),
 *   2. every "handled" catalog entry has a REAL SIGNAL_HANDLERS consumer (no dead promise),
 *   3. every SIGNAL_HANDLERS key is catalogued with that consumer (no undeclared handler),
 *   4. the declared coordination KIND matches the live classifyCoordination (the feed renders it right),
 *   5. every catalogued type classifies to a real kind (the feed never gets an unknown).
 * Pure: scans the source tree with readFileSync (no DB). No mocks.
 *
 * Run: npx tsx scripts/signal-integrity-simulator.ts   (npm run test:signal-integrity)
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { SIGNAL_REGISTRY, registeredSignalTypes } from "../lib/kernel/signal-registry"
import { classifyCoordination, type CoordinationKind } from "../lib/kernel/coordination-kind"
import { SIGNAL_HANDLERS } from "../lib/kernel/manager-signals"

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
  console.log(` ✅ Signal integrity whole — ${registeredSignalTypes().length} signal types catalogued, every published signal owned, zero orphans.`)
  console.log(" SIGNAL_INTEGRITY_PASS")
  process.exit(0)
}

const ROOT = process.cwd()
const VALID_KINDS: CoordinationKind[] = ["deferral", "handoff", "escalation", "alert", "update"]

/** Recursively collect *.ts files under a dir (skip node_modules / .next). */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full)
  }
  return out
}

/** Every signal_type literal PUBLISHED on the manager bus in production source, with its file.
 *  Scoped to files that actually call publishManagerSignal so an unrelated `signalType:` field
 *  (e.g. a UI retraining-signal union) is never mistaken for a bus publication. */
function scanPublishedSignals(): Map<string, string> {
  const found = new Map<string, string>()
  const files = [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app"))]
  const re = /signalType:\s*["']([a-z_]+)["']/g
  for (const f of files) {
    const src = readFileSync(f, "utf8")
    if (!src.includes("publishManagerSignal")) continue // only true bus publishers
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      if (!found.has(m[1])) found.set(m[1], f.replace(ROOT + "/", ""))
    }
  }
  return found
}

/** Every (toManager, signalType) STATIC pair published on the bus — pairs each
 *  `toManager: "x"` with the next `signalType: "y"` in the same publish object (the
 *  codebase always orders fromManager → toManager → signalType). Dynamic routes
 *  (toManager is a variable, e.g. the video_ready fan-out) carry no string literal and
 *  are skipped — they can't be statically verified here. */
function scanRoutedPairs(): Array<{ to: string; type: string; file: string }> {
  const out: Array<{ to: string; type: string; file: string }> = []
  const files = [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app"))]
  const fieldRe = /(toManager|signalType):\s*["']([a-z_]+)["']/g
  for (const f of files) {
    const src = readFileSync(f, "utf8")
    if (!src.includes("publishManagerSignal")) continue
    let pendingTo: string | null = null
    let m: RegExpExecArray | null
    while ((m = fieldRe.exec(src)) !== null) {
      if (m[1] === "toManager") pendingTo = m[2]
      else if (pendingTo) { out.push({ to: pendingTo, type: m[2], file: f.replace(ROOT + "/", "") }); pendingTo = null }
    }
  }
  return out
}

/**
 * INTENTIONAL feed-only HANDOFF ANNOUNCEMENTS — a signal whose coordination kind is "handoff"
 * but that is correctly feed_only because the actual work runs ELSEWHERE (a complementary
 * pipeline) or INLINE in the publishing runner; the bus signal only makes the hand-off VISIBLE
 * on the feed. Every entry is a conscious decision, verified against the runner. Anything else
 * that is a feed_only HANDOFF routed to a manager with no consumer is an unintended SILENT DROP
 * (the receiving manager skips it) — the exact bug that killed the ISA call hand-offs.
 */
const HANDOFF_ANNOUNCEMENTS = new Set<string>([
  "first_touch_claimed",     // a coordination RECORD — the bullpen race resolved (no further action)
  "listing_marketing_ready", // the kernel-event fanout enrolls the marketing sequences; this only announces
  "offer_docs_ready",        // the runner notifies the Deal Coordinator + agent INLINE; signal is the record
  "stage_advance_candidate", // resolved by the HUMAN on the feed (approveStageAdvanceAction / dismiss) — the buttons ARE the consumer; verified by test:doc-kernel
])

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Signal integrity simulator (bus zero-orphans guard)")
  console.log("══════════════════════════════════════════════════\n")

  // 1. Zero orphans — every PUBLISHED signal_type is catalogued.
  console.log("[1 · every published signal_type is catalogued]")
  const published = scanPublishedSignals()
  const orphans = [...published.entries()].filter(([t]) => !SIGNAL_REGISTRY[t])
  check(`all ${published.size} published signal types are in SIGNAL_REGISTRY (zero orphans)`,
    orphans.length === 0, orphans.map(([t, f]) => `${t} (${f})`).join(", "))

  // 2. Every "handled" catalog entry has a REAL handler.
  console.log("\n[2 · every 'handled' entry has a real SIGNAL_HANDLERS consumer]")
  const handlerKeys = new Set(Object.keys(SIGNAL_HANDLERS))
  const deadHandled: string[] = []
  for (const [type, spec] of Object.entries(SIGNAL_REGISTRY)) {
    if (spec.disposition !== "handled") continue
    if (spec.consumers.length === 0) { deadHandled.push(`${type} (handled but no consumers)`); continue }
    for (const c of spec.consumers) if (!handlerKeys.has(`${c}:${type}`)) deadHandled.push(`${c}:${type}`)
  }
  check("every handled (consumer:type) has a SIGNAL_HANDLERS entry (no dead promise)", deadHandled.length === 0, deadHandled.join(", "))

  // 3. Every SIGNAL_HANDLERS key is catalogued with that consumer.
  console.log("\n[3 · every SIGNAL_HANDLERS key is catalogued]")
  const undeclared: string[] = []
  for (const key of handlerKeys) {
    const [consumer, ...rest] = key.split(":")
    const type = rest.join(":")
    const spec = SIGNAL_REGISTRY[type]
    if (!spec) { undeclared.push(`${key} (type not catalogued)`); continue }
    if (spec.disposition !== "handled" || !spec.consumers.includes(consumer)) undeclared.push(`${key} (not declared handled for ${consumer})`)
  }
  check("every SIGNAL_HANDLERS key is declared in the registry (no undeclared handler)", undeclared.length === 0, undeclared.join(", "))

  // 4. Declared kind matches the live classifier.
  console.log("\n[4 · declared kind matches classifyCoordination]")
  const kindMismatch: string[] = []
  for (const [type, spec] of Object.entries(SIGNAL_REGISTRY)) {
    const actual = classifyCoordination(type)
    if (actual !== spec.kind) kindMismatch.push(`${type}: declared ${spec.kind} ≠ classifier ${actual}`)
  }
  check("every declared kind matches classifyCoordination (the feed renders it as declared)", kindMismatch.length === 0, kindMismatch.join("; "))

  // 5. Every catalogued kind is a real CoordinationKind.
  console.log("\n[5 · every catalogued kind is valid]")
  const badKind = Object.entries(SIGNAL_REGISTRY).filter(([, s]) => !VALID_KINDS.includes(s.kind)).map(([t]) => t)
  check("every catalogued kind is one of the 5 coordination kinds", badKind.length === 0, badKind.join(", "))

  // 6. NO SILENT DROP — a signal routed to a SPECIFIC manager that is feed_only with no
  //    handler (and not a declared advisory) is a hand-off the manager silently skips
  //    (consumeManagerSignals: `if (!handler) skipped++`). This is the exact blind spot
  //    that killed four ISA call hand-offs — guard 6 makes the class un-reintroducible.
  console.log("\n[6 · no manager-routed HANDOFF is a silent drop]")
  const handlerKeys6 = new Set(Object.keys(SIGNAL_HANDLERS))
  const silentDrops = scanRoutedPairs().filter(({ to, type }) => {
    const spec = SIGNAL_REGISTRY[type]
    if (!spec || spec.disposition !== "feed_only" || spec.kind !== "handoff") return false // only a feed_only HANDOFF is suspicious
    if (handlerKeys6.has(`${to}:${type}`)) return false           // actually consumed
    if (HANDOFF_ANNOUNCEMENTS.has(type)) return false             // a verified visible-announcement (work runs elsewhere)
    return true                                                   // SILENT DROP — the manager skips this hand-off
  })
  check("no feed_only HANDOFF routed to a manager lacks a handler (or a verified announcement declaration)",
    silentDrops.length === 0,
    silentDrops.map((d) => `${d.to}:${d.type} (${d.file}) — add a handler or declare it in HANDOFF_ANNOUNCEMENTS`).join("; "))

  report()
}

main()
