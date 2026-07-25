/**
 * scripts/voice-registry-coverage-simulator.ts
 *
 * VOICE-REGISTRY COVERAGE GUARD (phase 1 of the voice-admin consolidation).
 *
 * lib/voice/tool-registry.ts (`voiceTools`) is the DECLARED single source of
 * truth for voice-admin commands — its own header calls the hardcoded per-stack
 * command maps "a future-bug factory." The canonical dispatcher, Stack C
 * (app/api/agent-assistant/tool-call/route.ts `runTool`), already imports the
 * registry for its authority check. This guard makes that relationship an
 * ENFORCED invariant: every tool the canonical dispatcher handles must be
 * registered in voiceTools, so the registry can't silently fall behind the
 * dispatcher again.
 *
 * The tools the dispatcher handles but hasn't been registered yet are the
 * consolidation BACKLOG — baselined here as a burn-down. A NEW unregistered
 * dispatch fails CI; registering a backlog tool must SHRINK the baseline (the
 * ratchet), so the registry converges to complete as the phased merge proceeds.
 *
 * Pure source scan (readFileSync) — no DB, no network.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const REGISTRY = join(ROOT, "lib/voice/tool-registry.ts")
const DISPATCHER = join(ROOT, "app/api/agent-assistant/tool-call/route.ts")
const STACK_A_COMMAND_MAP = join(ROOT, "app/actions/voice-assistant/helpers/command-map.ts")

// `case "x":` labels in the dispatcher file that are NOT voice tools — they are
// param-type coercion cases in a sibling switch. Excluded from the tool set.
const NON_TOOL_CASES = new Set([
  "boolean", "date", "enum", "list", "money", "number", "percent", "string",
])
// The text-command bridge tool (parses free text → dispatchTeamCommand); it is a
// dispatcher mechanism, not a registered capability.
const BRIDGE_CASES = new Set(["run_team_command"])

// BURN-DOWN BASELINE — tools the canonical dispatcher handles but which are not
// yet in voiceTools. This list may only SHRINK: registering one in voiceTools
// removes it here; a NEW unregistered dispatch is a CI failure. (Do not grow this
// list to silence a new tool — register it in voiceTools instead.)
//
// Phase 2 registered all 11 original backlog tools (the reads, the CRM status
// write, and the 8 content-staging tools) into voiceTools, so the registry now
// covers every tool the canonical dispatcher handles — the baseline is EMPTY and
// the guard enforces full registry⊇dispatcher coverage exactly.
const BASELINE_UNREGISTERED = new Set<string>([])

function registryKeys(): Set<string> {
  const src = readFileSync(REGISTRY, "utf8")
  const start = src.indexOf("export const voiceTools")
  const body = start >= 0 ? src.slice(start) : src
  const keys = new Set<string>()
  for (const m of body.matchAll(/^ {2}([a-z_]+):\s*\{/gm)) keys.add(m[1])
  return keys
}

function dispatchedTools(): Set<string> {
  const src = readFileSync(DISPATCHER, "utf8")
  const tools = new Set<string>()
  for (const m of src.matchAll(/case\s+"([a-z_]+)"\s*:/g)) {
    const t = m[1]
    if (NON_TOOL_CASES.has(t) || BRIDGE_CASES.has(t)) continue
    tools.add(t)
  }
  return tools
}

let failed = 0
let passed = 0
const fail = (msg: string) => { console.log(`  ✗ ${msg}`); failed++ }
const pass = (msg: string) => { console.log(`  ✓ ${msg}`); passed++ }

function stackACommands(): Set<string> {
  const src = readFileSync(STACK_A_COMMAND_MAP, "utf8")
  const start = src.indexOf("export const COMMAND_MAP")
  const body = start >= 0 ? src.slice(start) : src
  const keys = new Set<string>()
  for (const m of body.matchAll(/^ {2}([a-z_]+):\s*\{/gm)) keys.add(m[1])
  return keys
}

// STACK A FOLD-IN BACKLOG — the seller-listing / CMA / buyer-execution commands
// Stack A (app/actions/voice-assistant/) executes through its OWN command map +
// authority matrix, NOT the canonical voiceTools registry. They are NOT added to
// voiceTools yet: the registry forbids "aspirational rows" (voice-command-coverage
// requires every registry entry be dispatched by the canonical route), and some A
// commands (e.g. lender_confirm_financials → [vendor]) can't be expressed in the
// coarse ToolAuthority enum. So they are baselined here to FREEZE Stack A drift:
// a NEW Stack A command must go through the canonical registry (be dispatchable +
// registered), and folding an A command into the canonical dispatcher must move it
// out of this baseline into voiceTools (the ratchet).
const STACK_A_BASELINE = new Set([
  "generate_cma", "generate_net_sheet", "generate_presentation",
  "schedule_appointment", "schedule_media", "approve_media", "activate_coming_soon",
  "submit_to_mls", "activate_mls", "schedule_open_house", "approve_open_house_marketing",
  "query_buyer_stage", "configure_buyer_search", "lender_confirm_financials",
  "admin_override_financial_gate", "query_listing_status",
])

console.log("══════════════════════════════════════════════════")
console.log(" Voice-registry coverage guard (voiceTools is the single source)")
console.log("══════════════════════════════════════════════════\n")

const registry = registryKeys()
const dispatched = dispatchedTools()

console.log(`[registry ⇄ canonical dispatcher]`)
console.log(`  registry tools: ${registry.size} · dispatcher tools: ${dispatched.size} · backlog baseline: ${BASELINE_UNREGISTERED.size}`)

if (registry.size < 20) fail(`registry parse looks wrong (${registry.size} keys) — check the regex/anchor`)
else pass(`registry parsed (${registry.size} tools)`)

if (dispatched.size < 20) fail(`dispatcher parse looks wrong (${dispatched.size} cases) — check the regex`)
else pass(`dispatcher parsed (${dispatched.size} tools)`)

// 1. Every dispatched tool is either registered OR a known backlog entry.
const unregistered = [...dispatched].filter((t) => !registry.has(t))
const newDrift = unregistered.filter((t) => !BASELINE_UNREGISTERED.has(t))
if (newDrift.length === 0) {
  pass(`no NEW unregistered dispatch (every dispatcher tool is in voiceTools or the backlog)`)
} else {
  fail(`NEW unregistered tool(s) dispatched but not in voiceTools: ${newDrift.join(", ")} — register in lib/voice/tool-registry.ts`)
}

// 2. Ratchet: a baseline entry that has since been registered must be removed
//    from the baseline (keeps the burn-down honest / monotonic).
const staleBaseline = [...BASELINE_UNREGISTERED].filter((t) => registry.has(t))
if (staleBaseline.length === 0) {
  pass(`backlog baseline is honest (no already-registered entries lingering)`)
} else {
  fail(`backlog baseline lists tool(s) now in voiceTools — remove from BASELINE_UNREGISTERED: ${staleBaseline.join(", ")}`)
}

// 3. Report the remaining C-dispatcher backlog for visibility (not a failure).
const remaining = unregistered.filter((t) => BASELINE_UNREGISTERED.has(t))
console.log(`\n[canonical-dispatcher backlog — register these in voiceTools as the merge proceeds]`)
console.log(`  ${remaining.length ? remaining.sort().join(", ") : "(none — registry covers the whole dispatcher!)"}`)

// ── Stack A drift-freeze: A's command map must be registered OR baselined ──
console.log(`\n[Stack A ⇄ canonical registry (fold-in backlog)]`)
const stackA = stackACommands()
console.log(`  Stack A commands: ${stackA.size} · fold-in baseline: ${STACK_A_BASELINE.size}`)
if (stackA.size < 10) fail(`Stack A command-map parse looks wrong (${stackA.size}) — check the regex/anchor`)
else pass(`Stack A command map parsed (${stackA.size} commands)`)

const aUnregistered = [...stackA].filter((c) => !registry.has(c))
const aNewDrift = aUnregistered.filter((c) => !STACK_A_BASELINE.has(c))
if (aNewDrift.length === 0) {
  pass(`no NEW Stack A command outside the canonical registry (each is registered or baselined for fold-in)`)
} else {
  fail(`NEW Stack A command(s) not in voiceTools and not baselined: ${aNewDrift.join(", ")} — route it through the canonical registry`)
}
// Ratchet: an A command folded into the registry (now dispatchable) must leave the baseline.
const aStaleBaseline = [...STACK_A_BASELINE].filter((c) => registry.has(c))
if (aStaleBaseline.length === 0) {
  pass(`Stack A baseline is honest (nothing folded-in still lingering)`)
} else {
  fail(`Stack A baseline lists command(s) now in voiceTools — remove from STACK_A_BASELINE: ${aStaleBaseline.join(", ")}`)
}

console.log("\n──────────────────────────────────────────────────")
if (failed === 0) {
  console.log(` RESULT: ${passed} passed, 0 failed`)
  console.log(` ✅ Voice registry is the enforced source of truth — no new drift (C dispatcher + Stack A frozen); backlogs shrink only.`)
  console.log(` VOICE_REGISTRY_COVERAGE_PASS`)
} else {
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(` ✗ Voice-registry coverage FAILED`)
  process.exit(1)
}
