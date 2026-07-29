#!/usr/bin/env tsx
/**
 * scripts/event-dispatch-invariant-guard.ts   (npm run test:event-dispatch) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO EMITTERS. ONLY ONE OF THEM DISPATCHES.
 *
 * This codebase has two ways to write a lifecycle event, and they are not
 * interchangeable:
 *
 *   emitEvent()            app/actions/orchestrator.ts — inserts the row AND calls
 *                          orchestrateEvent(), which routes it through the
 *                          `switch (event.event_type)` in lib/orchestrator/internal.ts.
 *                          8 call sites.
 *   emitLifecycleEvent()   lib/kernel/helpers.ts — inserts the row (and an
 *                          activity) and returns. Nothing is dispatched.
 *                          20 call sites.
 *
 * Both are legitimate. Most lifecycle events are an AUDIT TRAIL — written so a
 * timeline can render them, read generically, never routed. Using the
 * non-dispatching emitter for those is correct and cheaper.
 *
 * THE SILENT FAILURE MODE is emitting one of the types the orchestrator DOES
 * route through the non-dispatching emitter. The row lands, the timeline shows
 * it, the audit trail looks complete — and the handler never runs. Nothing
 * errors, nothing is logged, and the feature simply does not happen. That is the
 * exact shape of every defect this sweep has found.
 *
 * THE INVARIANT: no emitLifecycleEvent() call site may emit an event type that
 * the orchestrator's switch routes.
 *
 * Measured at the time of writing: ZERO violations. This guard has NO BASELINE
 * on purpose — it is a true invariant, not a debt ratchet. A baseline here would
 * be a licence to add the first one.
 *
 * WHAT THIS GUARD DELIBERATELY DOES NOT CHECK. I first proposed asserting that
 * every emitted KernelEvent has a consumer. Measured: 308 of 315 emitted events
 * have no literal consumer — because most are audit-trail writes read generically
 * by timeline queries that never name a specific type. A guard demanding a
 * subscriber for each would have produced a 308-entry baseline that asserts
 * nothing and would have to be rebaselined forever. It was the wrong idea and it
 * is not implemented.
 *
 * Related but distinct: lib/orchestrator/internal.ts also declares EVENT_HANDLERS,
 * a 23-key map that is referenced nowhere — orchestrateEvent routes via the
 * type-safe switch instead. That is acknowledged in the file's own header with an
 * activation plan, so it is documented debt, not a finding.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) }
}
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

/** PURE — the event-type constants the orchestrator's switch routes. */
export function routedEventNames(internalSrc: string): string[] {
  return [...strip(internalSrc).matchAll(/case\s+EVENT_TYPES\.([A-Z0-9_]+)\s*:/g)].map((m) => m[1])
}

/** PURE — resolve those constant NAMES to their string values. */
export function resolveEventValues(names: string[], eventTypesSrc: string): string[] {
  const src = strip(eventTypesSrc)
  return names.map((n) => {
    const m = new RegExp(`\\b${n}\\s*:\\s*["']([\\w.]+)["']`).exec(src)
    return m?.[1] ?? n
  })
}

/**
 * PURE — emitLifecycleEvent() call sites whose argument object names one of the
 * routed types. The window is the balanced-ish argument object, so a routed type
 * appearing elsewhere in the file is not attributed to this call.
 */
export function bypassingCallSites(
  text: string,
  routedValues: string[],
): string[] {
  const out: string[] = []
  for (const m of strip(text).matchAll(/emitLifecycleEvent\(\s*\{[\s\S]{0,600}?\n\s*\}/g)) {
    for (const v of routedValues) {
      if (m[0].includes(`"${v}"`) || m[0].includes(`'${v}'`)) out.push(v)
    }
  }
  return out
}

console.log("══════════════════════════════════════════════════")
console.log(" Event dispatch invariant (the non-dispatching emitter must not route)")
console.log("══════════════════════════════════════════════════")

console.log("\n[pure]")
{
  const internal = `
    switch (event.event_type) {
      case EVENT_TYPES.LEAD_CREATED:
      case EVENT_TYPES.LISTING_SIGNED:
    }`
  const names = routedEventNames(internal)
  check("reads the routed cases", names.length === 2 && names.includes("LEAD_CREATED"))
  check("a case inside a comment is not routed",
    routedEventNames("// case EVENT_TYPES.GHOST:").length === 0)

  const types = `export const EVENT_TYPES = { LEAD_CREATED: "lead.created", LISTING_SIGNED: "listing.signed" }`
  const values = resolveEventValues(names, types)
  check("resolves constants to their string values", values.includes("lead.created"))

  check("flags a bypassing call site",
    bypassingCallSites(`emitLifecycleEvent({\n  event_type: "lead.created",\n})`, ["lead.created"]).length === 1)
  check("ignores a NON-routed type (the normal, correct case)",
    bypassingCallSites(`emitLifecycleEvent({\n  event_type: "home_value_contact_created",\n})`, ["lead.created"]).length === 0)
  check("does not attribute a routed type from elsewhere in the file",
    bypassingCallSites(
      `emitLifecycleEvent({\n  event_type: "audit_only",\n})\nconst other = "lead.created"`,
      ["lead.created"],
    ).length === 0)
}

console.log("\n[repo]")
const internalSrc = readFileSync(join(root, "lib/orchestrator/internal.ts"), "utf8")
// lib/orchestrator/{index,event-types}.ts only re-export; the literal values
// are declared in lib/events/types.ts.
const typesSrc = readFileSync(join(root, "lib/events/types.ts"), "utf8")
const routedNames = routedEventNames(internalSrc)
const routedValues = resolveEventValues(routedNames, typesSrc)
console.log(`  · the orchestrator routes ${routedValues.length}: ${routedValues.join(", ")}`)

check("the orchestrator still routes something (the switch was not gutted)", routedValues.length > 0)
check("every routed case resolved to a real string value",
  routedValues.every((v) => v.includes(".")))

const files: string[] = []
const walk = (d: string) => {
  for (const e of readdirSync(d)) {
    if (["node_modules", ".next", ".git", "scripts"].includes(e)) continue
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.tsx?$/.test(e)) files.push(p)
  }
}
walk(join(root, "app"))
walk(join(root, "lib"))

const violations: string[] = []
let emitSites = 0
for (const f of files) {
  const t = readFileSync(f, "utf8")
  if (!t.includes("emitLifecycleEvent(")) continue
  emitSites += (t.match(/emitLifecycleEvent\(/g) ?? []).length
  for (const v of bypassingCallSites(t, routedValues)) {
    violations.push(`${relative(root, f).replace(/\\/g, "/")} → ${v}`)
  }
}
console.log(`  · ${emitSites} emitLifecycleEvent() call sites scanned`)

check("NO non-dispatching emit uses an orchestrator-routed type (zero-baseline invariant)",
  violations.length === 0, violations.slice(0, 6).join(" | "))

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log(" ✗ Failures:")
  for (const f of fails) console.log(`   - ${f}`)
  console.log(" ❌ EVENT_DISPATCH_FAIL — that event is routed by the orchestrator, so it must be")
  console.log("    emitted with emitEvent() (which dispatches), not emitLifecycleEvent() (which does not).")
  process.exit(1)
}
console.log(" ✅ EVENT_DISPATCH_PASS — every orchestrator-routed event goes through the emitter that dispatches")
