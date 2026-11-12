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
 *
 * ── THE RULE, RE-ANCHORED (wave 89, lane 89E — census round 34) ─────────────────────────
 * Ten "known gaps" sat in the baseline for waves. Read one by one, they were three
 * different things and the guard could tell none of them apart:
 *   · FALSE GAPS from a blind finder: `image.generated` IS handled — by
 *     `case EVENT_TYPES.IMAGE_GENERATED:` in the switch, a spelling this guard never
 *     resolved (it only read dotted keys of the HANDLERS map); `tour.completed` is
 *     emitted by NOBODY — the only `event_type: 'tour.completed'` left is a TOMBSTONE
 *     comment (CLAUDE.md §2: a tombstone is not a call site; this guard read raw source).
 *   · AUDIT ROWS: `offer.created`, `tour.planned`, `tour.confirmed`,
 *     `listing.stage_overridden`, `transaction.stage_overridden` are inserted STRAIGHT
 *     INTO lifecycle_events (`.from("lifecycle_events").insert({event_type})` behind
 *     sentinelWrite). Those rows never reach orchestrateEvent — by construction there is
 *     no reaction to miss; they are the timeline's audit trail (read generically by
 *     lib/kernel/continuity-receipt.ts and the person timeline, never by type).
 *   · REAL GAPS: `onboarding.stalled` and `agent.delegated_to_ai` were audit rows too,
 *     but each carried a stated downstream intent ("so downstream surfaces can act",
 *     "so AI ISA / draft generators can pick it up") and nothing acted — handlers BUILT
 *     (lib/onboarding/stalled-onboarding-reaction.ts, lib/portal-stream/ai-delegation-
 *     reaction.ts) and the emitters moved onto the dispatching helpers.
 *     `transaction.documents_complete` was a duplicate of `provider.signatures.complete`
 *     with no reader — deleted onto its survivor (tombstone in the dotloop webhook).
 *
 * So the guard now:
 *   1. reads STRIPPED source (scripts/strip-comments.ts) — a comment cannot emit;
 *   2. counts a `case EVENT_TYPES.X:` label as a handler, resolving X through
 *      lib/events/types.ts (the same resolution scripts/event-dispatch-invariant-guard.ts
 *      uses);
 *   3. classifies each emit site by its ENCLOSING CALL: a dispatching helper
 *      (emitEventFromCron / recordLifecycleEvent / emitEvent / logEventAndTrigger /
 *      emitKernelEvent) is an EMIT that wants a handler; a bare
 *      `.from("lifecycle_events"|"events").insert(` is an AUDIT ROW, published under its own
 *      heading and never accused of missing a handler. A site whose enclosure cannot be
 *      decided is counted as an EMIT (the accusing direction) and its count is printed.
 * Every finder carries a POSITIVE CONTROL below; a control that fails exits non-zero and
 * reports nothing (a blind scanner's zero is a lie).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { stripComments } from "./strip-comments"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASELINE_PATH = join(root, "scripts", "event-flow-baseline.json")

// TOMBSTONE (orphan doctrine §1.1) — the private `walk(dir, out)` that stood here
// was one of 82 copies of the same readdirSync walker. Survivor:
// scripts/runtime-roots.ts:61 (`walkTs`), imported above. It enumerated
// DIRECTORIES, so the root-level runtime files (`proxy.ts`, the Next 16 edge
// middleware) could never be reached — an `event_type:` emitted from the edge
// would have read as "emitted by nobody". `rootRuntimeFiles()` supplies them.
const all = [
  ...walkTs(join(root, "app")),
  ...walkTs(join(root, "lib")),
  ...rootRuntimeFiles(root),
].map((p) => relative(root, p).replace(/\\/g, "/"))

// ── PURE FINDERS (each with a control below) ───────────────────────────────────────────

/** Emitted events: `event_type: "x.y"` (the canonical emit shape used by logEvent* helpers). */
const emitRe = /event_type\s*:\s*["']([a-z_]+\.[a-z_]+)["']/g

const DISPATCHING_HELPERS = /\b(emitEventFromCron|recordLifecycleEvent|logEventAndTrigger|emitKernelEvent|emitEvent)\s*\(/g
const AUDIT_INSERT = /\.from\(\s*["'](?:lifecycle_events|events)["']\s*\)\s*\.insert\s*\(/g

export type EmitKind = "dispatched" | "audit_row" | "undecided"

/**
 * PURE — classify one `event_type:` site by the NEAREST enclosing call opener before it:
 * a dispatching helper → "dispatched"; a bare lifecycle_events/events insert → "audit_row";
 * neither within the window → "undecided" (counted as an emit — the accusing direction).
 */
export function classifyEmitSite(stripped: string, index: number, window = 600): EmitKind {
  const from = Math.max(0, index - window)
  const before = stripped.slice(from, index)
  let lastDispatch = -1
  let lastAudit = -1
  for (const m of before.matchAll(DISPATCHING_HELPERS)) lastDispatch = m.index ?? -1
  for (const m of before.matchAll(AUDIT_INSERT)) lastAudit = m.index ?? -1
  if (lastDispatch < 0 && lastAudit < 0) return "undecided"
  return lastDispatch > lastAudit ? "dispatched" : "audit_row"
}

/** PURE — every emit site in one stripped source, with its kind. */
export function emitSitesIn(stripped: string): Array<{ event: string; kind: EmitKind }> {
  const out: Array<{ event: string; kind: EmitKind }> = []
  for (const m of stripped.matchAll(emitRe)) out.push({ event: m[1], kind: classifyEmitSite(stripped, m.index ?? 0) })
  return out
}

/** PURE — the dotted keys of the HANDLERS map. */
export function handlerMapKeys(orchStripped: string): string[] {
  return [...orchStripped.matchAll(/["']([a-z_]+\.[a-z_]+)["']\s*:/g)].map((m) => m[1])
}

/** PURE — `case EVENT_TYPES.X:` labels resolved to their string values through lib/events/types.ts. */
export function switchCaseEvents(orchStripped: string, typesStripped: string): string[] {
  const names = [...orchStripped.matchAll(/case\s+EVENT_TYPES\.([A-Z0-9_]+)\s*:/g)].map((m) => m[1])
  const out: string[] = []
  for (const n of names) {
    const m = new RegExp(`\\b${n}\\s*:\\s*["']([a-z_]+\\.[a-z_]+)["']`).exec(typesStripped)
    if (m) out.push(m[1])
  }
  return out
}

/** PURE — every workflow chain's triggerEvent: orchestrateEvent starts each chain registered for an event. */
export function chainTriggers(src: string): string[] {
  return [...src.matchAll(/triggerEvent:\s*"([^"]+)"/g)].map((x) => x[1])
}

// ── POSITIVE CONTROLS — a blind finder reports nothing, so it must first see the shape ──
function control(name: string, ok: boolean): void {
  if (!ok) {
    console.error(` ❌ EVENT_FLOW_FAIL — POSITIVE CONTROL: ${name}`)
    process.exit(1)
  }
}
control("the chain-trigger finder recognises a chain trigger and nothing else",
  chainTriggers(`triggerEvent: "x.y"`).join() === "x.y" && chainTriggers(`eventType: "x.y"`).length === 0)
control("a dispatching-helper emit is classified dispatched",
  emitSitesIn(`await emitEventFromCron({ brokerage_id: b, event_type: "a.b", source: "cron", payload: {} })`)[0]?.kind === "dispatched")
control("a bare lifecycle_events insert is classified an audit row",
  emitSitesIn(`await sentinelWrite(svc, svc.from("lifecycle_events").insert({ brokerage_id: b, event_type: "a.b", metadata: {} }), { table: "lifecycle_events" })`)[0]?.kind === "audit_row")
control("recordLifecycleEvent is dispatching even with a .from() read earlier in the window",
  emitSitesIn(`const { data } = await svc.from("lifecycle_events").select("id")\nconst r = await recordLifecycleEvent(svc, b, { event_type: "a.b", payload: {}, source: "webhook" })`)[0]?.kind === "dispatched")
control("a site with no recognisable enclosure is undecided (counted as an emit, never dropped)",
  emitSitesIn(`const row = { event_type: "a.b" }`)[0]?.kind === "undecided")
control("a comment-only emit is NOT an emit (stripped source)",
  emitSitesIn(stripComments(`// the old event_type: 'tour.completed' insert this replaces\nconst x = 1`)).length === 0)
control("a switch-case handler resolves through EVENT_TYPES",
  switchCaseEvents(`switch (t) { case EVENT_TYPES.IMAGE_GENERATED: go() }`, `export const EVENT_TYPES = { IMAGE_GENERATED: "image.generated" } as const`).join() === "image.generated")
control("a case inside a comment is not a handler",
  switchCaseEvents(stripComments(`// case EVENT_TYPES.GHOST:\nswitch (t) {}`), `GHOST: "g.host"`).length === 0)
control("a HANDLERS-map key is a handler",
  handlerMapKeys(`const H = { "lead.created": async () => {} }`).join() === "lead.created")

// ── REPO SCAN ──────────────────────────────────────────────────────────────────────────
const dispatched = new Set<string>()
const auditOnly = new Set<string>()
let undecidedSites = 0
let auditSites = 0
let dispatchedSites = 0
for (const f of all) {
  const stripped = stripComments(readFileSync(join(root, f), "utf8"))
  for (const site of emitSitesIn(stripped)) {
    if (site.kind === "audit_row") { auditSites++; auditOnly.add(site.event); continue }
    if (site.kind === "undecided") undecidedSites++
    else dispatchedSites++
    dispatched.add(site.event)
  }
}
// An event that is dispatched anywhere is judged as an emit; audit-only means EVERY site is an audit row.
for (const e of dispatched) auditOnly.delete(e)

const orch = stripComments(readFileSync(join(root, "lib/orchestrator/internal.ts"), "utf8"))
const types = stripComments(readFileSync(join(root, "lib/events/types.ts"), "utf8"))
const handled = new Set<string>([...handlerMapKeys(orch), ...switchCaseEvents(orch, types)])
const chainsDir = join(root, "lib/workflow-orchestrator/chains")
for (const f of readdirSync(chainsDir)) {
  if (!f.endsWith(".ts") || f === "index.ts") continue
  for (const ev of chainTriggers(stripComments(readFileSync(join(chainsDir, f), "utf8")))) handled.add(ev)
}

const unhandled = Array.from(dispatched).filter((e) => !handled.has(e)).sort()

let baseline: string[] = []
try { baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as string[] } catch { /* none yet */ }
const baseSet = new Set(baseline)
const newGaps = unhandled.filter((e) => !baseSet.has(e))
const closed = baseline.filter((b) => !unhandled.includes(b)) // now-handled, audit-only, or no longer emitted

console.log("\n[event-flow guard — every DISPATCHED event must be handled (or baselined)]")
console.log(`  emitted (dispatched): ${dispatched.size} across ${dispatchedSites} helper sites + ${undecidedSites} undecided site(s) · handled: ${handled.size} · unhandled (debt): ${unhandled.length}`)
console.log(`  audit rows (inserted straight into lifecycle_events/events, dispatched to nobody by construction — the timeline's trail, never a missing handler): ${auditOnly.size} type(s) across ${auditSites} site(s)`)
for (const a of Array.from(auditOnly).sort()) console.log(`     · ${a}`)
console.log(`  BLIND SPOTS: a 3-segment event type (provider.signatures.complete) does not match the 2-segment finder; an emit whose event_type is a constant (KernelEvent.X) is the event-dispatch guard's domain, not this one's; enclosure is read within ${600} chars before the literal`)

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
  console.log(`  ✗ ${newGaps.length} NEW dispatched event(s) with no orchestrator handler — add a handler or baseline:`)
  for (const g of newGaps) console.log(`     - ${g}`)
  console.log("\n──────────────────────────────────────────────────")
  console.log(" RESULT: 0 passed, 1 failed")
  process.exit(1)
}

console.log("\n──────────────────────────────────────────────────")
console.log(" RESULT: 1 passed, 0 failed")
console.log(unhandled.length === 0
  ? " ✅ EVENT_FLOW_PASS — every dispatched event has an orchestrator handler"
  : ` ✅ NO_NEW_FLOW_GAPS — no new unhandled events (${unhandled.length} known, chain-handled or audit-only)`)
