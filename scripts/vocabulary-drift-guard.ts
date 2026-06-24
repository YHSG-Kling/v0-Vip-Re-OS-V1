#!/usr/bin/env tsx
/**
 * scripts/vocabulary-drift-guard.ts  (npm run test:vocabulary-drift) — pure, no DB.
 *
 * VOCABULARY-DRIFT RATCHET. A whole class of silent gaps in this app is "a string-keyed handler
 * switches on a value that no longer exists in the canonical source-of-truth vocabulary" — so it
 * falls through to default and the automation quietly stops firing. We hit it twice:
 *   · dotted EVENT_HANDLERS keys vs underscore KernelEvents (the listing-appointment event),
 *   · UPPERCASE canonical lifecycle stages vs the lowercase legacy triggerStageActions switch.
 *
 * This guard turns "a human happened to search end-to-end" into an INVARIANT. For each registered
 * (handler switch → canonical enum) pair it asserts:
 *   A) a LIVE mapping (mustBeCanonical) — EVERY case string exists in the canonical set, else FAIL.
 *      This is what keeps the action-layer stage automations wired to the real stages.
 *   B) a LEGACY switch (baselined) — non-canonical cases are allowed ONLY if already in the baseline;
 *      a NEW non-canonical case FAILS. The baseline is the documented dead-branch list for the
 *      triggerStageActions reconciliation — it can shrink (as branches are fixed) but never grow.
 *
 * Run UPDATE_VOCAB_BASELINE=1 to (re)write the baseline after intentionally changing the legacy set.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (p: string) => readFileSync(join(root, p), "utf8")
const BASELINE_PATH = join(root, "scripts", "vocabulary-drift-baseline.json")

/** Pull the body of a named function via brace matching (handles nested braces). */
function functionBody(src: string, fnName: string): string {
  const sig = new RegExp(`function\\s+${fnName}\\b`).exec(src)
  if (!sig) return ""
  let i = src.indexOf("{", sig.index)
  if (i === -1) return ""
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(i, j + 1) }
  }
  return src.slice(i)
}

/** Every `case "X":` string in a function body. */
function caseStrings(src: string, fnName: string): string[] {
  const body = functionBody(src, fnName)
  const out: string[] = []
  const re = /case\s+"([^"]+)":/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) out.push(m[1])
  return out
}

// ── Canonical vocabularies ──────────────────────────────────────────────────

/** Canonical listing stages — the `stage: "X"` values in LISTING_LIFECYCLE_STAGES. */
function canonicalListingStages(): Set<string> {
  const src = read("lib/listing-lifecycle/lifecycle-definitions.ts")
  const set = new Set<string>()
  const re = /\bstage:\s*"([A-Za-z][A-Za-z0-9_]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) set.add(m[1])
  return set
}

// ── Registered checks ───────────────────────────────────────────────────────

interface Check {
  name: string
  file: string
  fn: string
  canonical: () => Set<string>
  /** true = a LIVE mapping (every case MUST be canonical). false = a LEGACY switch (baselined). */
  mustBeCanonical: boolean
}

const CHECKS: Check[] = [
  {
    name: "stageAutomationFor (LIVE action-layer stage → automation map)",
    file: "lib/listing-lifecycle/stage-automations.ts",
    fn: "stageAutomationFor",
    canonical: canonicalListingStages,
    mustBeCanonical: true,
  },
  // The legacy triggerStageActions switch was RETIRED (dead lowercase vocabulary, redundant with the
  // canonical flows) — its baseline entry is gone. Add the next vocabulary here as it's hardened
  // (orchestrator EVENT_HANDLERS keys → EVENT_TYPES; manager-signal handler keys → signal-registry).
]

// ── Run ─────────────────────────────────────────────────────────────────────

type Baseline = Record<string, string[]>
let baseline: Baseline = {}
try { baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline } catch { /* none yet */ }

const update = process.env.UPDATE_VOCAB_BASELINE === "1"
const newBaseline: Baseline = {}
let pass = 0, fail = 0
const fails: string[] = []

console.log("\n[vocabulary-drift guard — handler case strings must resolve to the canonical vocabulary]")

for (const c of CHECKS) {
  const src = read(c.file)
  const cases = caseStrings(src, c.fn)
  const canon = c.canonical()
  const nonCanonical = cases.filter((s) => !canon.has(s))

  if (c.mustBeCanonical) {
    if (nonCanonical.length === 0) {
      pass++
      console.log(`  ✓ ${c.name} — all ${cases.length} case(s) are canonical`)
    } else {
      fail++
      fails.push(`${c.name}: non-canonical case(s) ${JSON.stringify(nonCanonical)} — the live mapping would silently stop firing`)
      console.log(`  ✗ ${c.name} — NON-CANONICAL: ${JSON.stringify(nonCanonical)}`)
    }
    continue
  }

  // Legacy switch — ratchet against the baseline.
  newBaseline[c.name] = nonCanonical.sort()
  const baseSet = new Set(baseline[c.name] ?? [])
  const newDrift = nonCanonical.filter((s) => !baseSet.has(s))
  const healed = (baseline[c.name] ?? []).filter((s) => canon.has(s) || !cases.includes(s))
  if (newDrift.length === 0) {
    pass++
    console.log(`  ✓ ${c.name} — ${nonCanonical.length} known-legacy dead case(s), no NEW drift`)
    if (healed.length) console.log(`     ↓ ${healed.length} baseline case(s) now reconciled/removed — run UPDATE_VOCAB_BASELINE=1 to shrink`)
  } else {
    fail++
    fails.push(`${c.name}: NEW non-canonical case(s) ${JSON.stringify(newDrift)} — add to the canonical enum or fix the case`)
    console.log(`  ✗ ${c.name} — NEW drift: ${JSON.stringify(newDrift)}`)
  }
}

// ── Chain-trigger check: every workflow chain's triggerEvent must be EMITTED somewhere ──────────
// A chain that listens for an event no one emits is a DEAD flagship automation — the managers
// silently skip it (exactly the listing-appt-prep risk: the chain only fires if its triggerEvent
// string matches what callers pass to triggerChainsForEvent). This asserts every chain trigger is a
// real, emitted event.
function walkTs(dirs: string[]): string[] {
  const out: string[] = []
  const rec = (d: string) => {
    let entries: string[]
    try { entries = readdirSync(d) } catch { return }
    for (const n of entries) {
      if (n === "node_modules" || n.startsWith(".")) continue
      const p = join(d, n)
      if (statSync(p).isDirectory()) rec(p)
      else if (/\.(ts|tsx)$/.test(n)) out.push(p)
    }
  }
  for (const d of dirs) rec(join(root, d))
  return out
}

const CHAINS_DIR_FRAG = "workflow-orchestrator/chains/"

function chainTriggerEvents(): Array<{ event: string; file: string }> {
  const dir = join(root, "lib/workflow-orchestrator/chains")
  const out: Array<{ event: string; file: string }> = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts") || f === "index.ts") continue
    const m = /triggerEvent:\s*"([^"]+)"/.exec(readFileSync(join(dir, f), "utf8"))
    if (m) out.push({ event: m[1], file: `chains/${f}` })
  }
  return out
}

/** Every event string a caller can dispatch a chain on: EVENT_TYPES values + every `eventType:`/
 *  `triggerEvent:` literal OUTSIDE the chain definitions (those are listeners, not emits). */
function emittedEventStrings(): Set<string> {
  const set = new Set<string>()
  const types = read("lib/events/types.ts")
  let m: RegExpExecArray | null
  const tv = /:\s*"([a-z][a-z0-9._]+)"/g
  while ((m = tv.exec(types))) set.add(m[1])
  for (const f of walkTs(["app", "lib"])) {
    if (f.replace(/\\/g, "/").includes(CHAINS_DIR_FRAG)) continue
    const src = readFileSync(f, "utf8")
    const re = /(?:eventType|triggerEvent):\s*"([^"]+)"/g
    while ((m = re.exec(src))) set.add(m[1])
  }
  return set
}

{
  const emitted = emittedEventStrings()
  const triggers = chainTriggerEvents()
  const dead = triggers.filter((t) => !emitted.has(t.event))
  if (dead.length === 0) {
    pass++
    console.log(`  ✓ workflow chains — all ${triggers.length} triggerEvent(s) are emitted somewhere (no dead chain)`)
  } else {
    fail++
    for (const d of dead) fails.push(`chain ${d.file}: triggerEvent "${d.event}" is never emitted — the chain is dead (managers skip it)`)
    console.log(`  ✗ workflow chains — DEAD trigger(s): ${JSON.stringify(dead.map((d) => `${d.file}:${d.event}`))}`)
  }
}

if (update) {
  writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2) + "\n")
  console.log(`\n  ✎ baseline rewritten.`)
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0 && !update) {
  for (const f of fails) console.log(`   - ${f}`)
  console.log(" ❌ VOCABULARY_DRIFT_FAIL")
  process.exit(1)
}
console.log(" ✅ VOCABULARY_DRIFT_PASS — handler case strings resolve to the canonical vocabulary (legacy drift ratcheted)")
