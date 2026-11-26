#!/usr/bin/env tsx
/**
 * scripts/ai-routing-coverage-guard.ts  (npm run test:ai-routing-coverage)
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY ROUTED MODEL CALL NAMES A FEATURE THE ROUTING TABLE KNOWS.
 *
 * Lane 86D (wave 86, owner: "keep provider cost down … Vercel AI SDK + AI
 * Gateway"; lane brief: "cheapest adequate model per step").
 *
 * THE DEFECT THIS RATCHETS. lib/ai/models.ts's generateTextRouted /
 * generateObjectRouted / streamTextRouted choose the model from
 * AI_TASK_ROUTING[feature] and fall back to `unspecified` (claude-sonnet —
 * the most expensive default lane) for any feature string the table does not
 * know. Nothing warned. Measured at base ad8339de: 57 of 120 routed call sites (this guard run over the base tree:
 * 55 unrouted + 2 featureless) named no routing row, so they ALL ran on Sonnet whatever their own
 * header or docs/ai-agent-surfaces-2026-09.md said — the live phone
 * receptionist included (doc: "Haiku-class brain"; code: Sonnet every turn).
 * The two featureless sites passed `model: "openai/gpt-4o-mini"`, a field the routed
 * lanes IGNORE (RoutedTextRequest.model — "Ignored — routing table governs"),
 * so their authors' cheap pin was fiction and they ran on Sonnet too.
 *
 * THE RULES (asserted, never a count of today's rows — §2 "rule, not waypoint"):
 *   R1 every routed call site passes a LITERAL `feature:` and that literal is a
 *      key of AI_TASK_ROUTING (a site with no feature at all is the same defect:
 *      it silently rides `unspecified`);
 *   R2 no routed call site passes `model:` (the lane ignores it — a pin that
 *      reads as enforced and is not);
 *   R3 every AI_TASK_ROUTING row's model AND fallback are MODEL_CONFIG keys
 *      (a typo'd model id resolves to the claude-sonnet default at runtime);
 *   R4 the real-time conversational lanes (spoken voice turns, live chat with
 *      tools) never ride the Sonnet/Opus class — the surfaces doc's own
 *      per-surface picks, derived from the rows by name, not re-typed here.
 *
 * DELIBERATELY TEXTUAL: lib/ai/models.ts is server-only and cannot be
 * imported from a plain script (scripts/content-lane-ledger-simulator.ts's
 * note). Call sites are read through scripts/strip-comments.ts — blankComments
 * so a tombstone quoting an old `feature: "x"` or `model:` is never a call
 * site (CLAUDE.md §2), blankStrings for paren balancing so a ")" inside a
 * prompt string cannot end the argument span early.
 *
 * POSITIVE CONTROLS (§2): the scanner is run over in-memory specimens that
 * carry each defect (unknown feature, no feature, ignored `model:`), and over
 * a specimen whose defect lives only in a comment (must NOT be flagged).
 *
 * BLIND SPOTS (published beside the number): a routed function re-bound under
 * another name (`const gen = generateTextRouted; gen({...})`) is not seen —
 * the only such alias in the tree today is lib/voice/twilio-voice.ts's
 * `generateFn`, which is scanned by name; a feature passed as a variable
 * reads as <dynamic> and is counted, not judged; generateAIResponse (the
 * compliance lane) and runPipeline* are NOT in scope — their callers mostly
 * pin a model explicitly, which that lane honours.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { blankComments, blankStrings } from "./strip-comments"

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

let passed = 0
let failed = 0
const check = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { console.log(`  ✓ ${name}`); passed++ }
  else { console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); failed++ }
}

// ── The routing table, parsed by brace-matching the COMMENT-BLANKED source ──
function objectBody(src: string, marker: string): string {
  const decl = src.indexOf(marker)
  if (decl < 0) return ""
  const open = src.indexOf("= {", decl)
  if (open < 0) return ""
  let depth = 0
  for (let i = open + 2; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(open + 3, i) }
  }
  return ""
}

const modelsSrc = blankComments(read("lib/ai/models.ts"))
const routingBody = objectBody(modelsSrc, "export const AI_TASK_ROUTING")
const ROUTES = new Map<string, { model: string; fallback: string }>()
for (const m of routingBody.matchAll(/^\s*([a-z0-9_]+):\s*\{\s*model:\s*"([a-z0-9.-]+)",\s*fallback:\s*"([a-z0-9.-]+)"/gm)) {
  ROUTES.set(m[1], { model: m[2], fallback: m[3] })
}
const configBody = objectBody(modelsSrc, "const MODEL_CONFIG")
const MODELS = new Set([...configBody.matchAll(/^\s*"([a-z0-9.-]+)":\s*\{\s*provider:/gm)].map((m) => m[1]))

// ── The call-site scanner ────────────────────────────────────────────────────
const ROUTED_CALL = /\b(generateTextRouted|generateObjectRouted|streamTextRouted|generateFn)\s*(<[^()]*>)?\s*\(/g

interface Site { file: string; line: number; fn: string; feature: string | null; dynamic: boolean; passesModel: boolean }

function scanSource(file: string, raw: string): Site[] {
  const nc = blankComments(raw)
  const ns = blankStrings(nc)
  const out: Site[] = []
  ROUTED_CALL.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ROUTED_CALL.exec(ns))) {
    // Skip declarations (`function generateTextRouted(`, `async function …(`)
    // and type positions (`typeof generateTextRouted`).
    const before = ns.slice(Math.max(0, m.index - 24), m.index)
    if (/function\s*$|typeof\s*$/.test(before)) continue
    let i = m.index + m[0].length
    let depth = 1
    while (i < ns.length && depth > 0) {
      const c = ns[i]
      if (c === "(") depth++
      else if (c === ")") depth--
      i++
    }
    const argsNc = nc.slice(m.index + m[0].length, i - 1)
    const argsNs = ns.slice(m.index + m[0].length, i - 1)
    const feat = /\bfeature\s*:\s*["'`]([A-Za-z0-9_]+)["'`]/.exec(argsNc)
    out.push({
      file, line: nc.slice(0, m.index).split("\n").length, fn: m[1],
      feature: feat ? feat[1] : null,
      dynamic: !feat && /\bfeature\b/.test(argsNs),
      // `model:` as an OWN property of the argument object — at depth 1 of the
      // blanked argument text, so a nested schema/object literal cannot match.
      passesModel: topLevelKeys(argsNs).has("model"),
    })
  }
  return out
}

/** Keys at brace depth 1 of the first object literal in an argument span. */
function topLevelKeys(argsNs: string): Set<string> {
  const keys = new Set<string>()
  const start = argsNs.indexOf("{")
  if (start < 0) return keys
  let depth = 0
  let seg = ""
  for (let i = start; i < argsNs.length; i++) {
    const c = argsNs[i]
    if (c === "{" || c === "(" || c === "[") { depth++; if (depth === 1) { seg = ""; continue } }
    if (c === "}" || c === ")" || c === "]") { depth--; if (depth === 0) { harvest(seg, keys); break } }
    if (depth === 1) {
      if (c === ",") { harvest(seg, keys); seg = "" } else seg += c
    }
  }
  return keys
}
function harvest(seg: string, keys: Set<string>): void {
  const k = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(seg)
  if (k) keys.add(k[1])
  else {
    const shorthand = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(seg)
    if (shorthand) keys.add(shorthand[1])
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

console.log("\n══════════════════════════════════════════════════════════════")
console.log(" AI ROUTING COVERAGE — every routed call names a routed feature")
console.log("══════════════════════════════════════════════════════════════\n")

console.log("[0 · the instruments are sound]")
check(`AI_TASK_ROUTING parsed (${ROUTES.size} rows)`, ROUTES.size >= 40, "brace-match of AI_TASK_ROUTING returned too few rows — the PARSE is broken, not the code")
check("AI_TASK_ROUTING carries the `unspecified` default the fallback names", ROUTES.has("unspecified"))
check(`MODEL_CONFIG parsed (${MODELS.size} models)`, MODELS.size >= 5 && MODELS.has("claude-haiku") && MODELS.has("claude-sonnet"))

// POSITIVE CONTROLS — each defect in a specimen must be seen; a comment-only
// defect must not.
const spec = (src: string) => scanSource("<specimen>", src)
{
  const unknown = spec(`await generateTextRouted({ feature: "no_such_row_86d", prompt: "a (paren) inside a string", brokerageId })`)
  check("control: scanner sees an unknown literal feature", unknown.length === 1 && unknown[0].feature === "no_such_row_86d" && !ROUTES.has(unknown[0].feature!))
  const none = spec(`const { text } = await generateTextRouted({ brokerageId: b, model: "openai/gpt-4o-mini", prompt: \`x\` })`)
  check("control: scanner sees a site with NO feature (the pre-86D open-house.ts shape)", none.length === 1 && none[0].feature === null && !none[0].dynamic)
  check("control: scanner sees the ignored `model:` argument (same specimen)", none.length === 1 && none[0].passesModel)
  const nested = spec(`await generateObjectRouted({ feature: "generate_json", schema: z.object({ model: z.string() }), prompt })`)
  check("control: a nested `model:` (schema field) is NOT the ignored argument", nested.length === 1 && !nested[0].passesModel)
  const tomb = spec(`await generateTextRouted({\n  // was: model: "openai/gpt-4o-mini", feature: "no_such_row_86d"\n  feature: "compliance_check", prompt })`)
  check("control: a tombstone comment inside the call is not read as code (§2)", tomb.length === 1 && tomb[0].feature === "compliance_check" && !tomb[0].passesModel)
  const decl = spec(`export async function generateTextRouted(request: RoutedTextRequest) {}`)
  check("control: the declaration itself is not a call site", decl.length === 0)
}

// ── Scan the tree ────────────────────────────────────────────────────────────
const files = [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app"))]
const sites: Site[] = []
for (const f of files) {
  const raw = readFileSync(f, "utf8")
  if (!/generateTextRouted|generateObjectRouted|streamTextRouted/.test(raw)) continue
  sites.push(...scanSource(relative(ROOT, f), raw))
}
const unrouted = sites.filter((s) => s.feature !== null && !ROUTES.has(s.feature))
const featureless = sites.filter((s) => s.feature === null && !s.dynamic)
const dynamic = sites.filter((s) => s.dynamic)
const modelArg = sites.filter((s) => s.passesModel)
const fmt = (s: Site) => `${s.file}:${s.line} (${s.fn}${s.feature ? ` feature="${s.feature}"` : ""})`

console.log(`\n[1 · R1 — every literal feature is a routing row]  denominator: ${sites.length} routed call sites in lib/ + app/`)
check("routed call sites found (instrument sanity)", sites.length >= 60, `only ${sites.length} — the scanner is blind`)
check("every literal feature at a routed call site is an AI_TASK_ROUTING key (no silent `unspecified`)",
  unrouted.length === 0, unrouted.slice(0, 40).map(fmt).join("\n      "))
check("no routed call site omits `feature:` (an omitted feature IS the silent `unspecified`)",
  featureless.length === 0, featureless.slice(0, 40).map(fmt).join("\n      "))
console.log(`    blind spot: ${dynamic.length} site(s) pass a non-literal feature — counted, not judged${dynamic.length ? `: ${dynamic.map(fmt).join(", ")}` : ""}`)

console.log("\n[2 · R2 — no routed call site passes the ignored `model:`]")
check("no `model:` argument at a routed call site (RoutedTextRequest.model is ignored — a pin that reads as enforced and is not)",
  modelArg.length === 0, modelArg.map(fmt).join("\n      "))

console.log("\n[3 · R3 — every row names real models]")
const badRows = [...ROUTES.entries()].filter(([, r]) => !MODELS.has(r.model) || !MODELS.has(r.fallback))
check("every AI_TASK_ROUTING model and fallback is a MODEL_CONFIG key", badRows.length === 0, badRows.map(([k, r]) => `${k}: ${r.model} / ${r.fallback}`).join(", "))
const selfFallback = [...ROUTES.entries()].filter(([, r]) => r.model === r.fallback)
check("no row falls back to itself (a fallback that cannot help)", selfFallback.length === 0, selfFallback.map(([k]) => k).join(", "))

console.log("\n[4 · R4 — real-time conversational lanes ride a fast/cheap model]")
// Derived by NAME from the rows, never a hand list of today's keys: a spoken
// turn (…_turn), a live avatar/chat stream (…_conversation, …_chat, …_chat_stream).
const REALTIME = /(^voice_.*_turn$|_turn$|live_avatar_conversation$|_chat$|_chat_stream$)/
const EXPENSIVE = new Set(["claude-sonnet", "claude-opus", "gpt-4-turbo"])
const realtime = [...ROUTES.entries()].filter(([k]) => REALTIME.test(k))
check(`real-time lanes found by name (${realtime.map(([k]) => k).join(", ")})`, realtime.length >= 3)
const slow = realtime.filter(([, r]) => EXPENSIVE.has(r.model))
check("no real-time conversational lane is routed to the Sonnet/Opus class", slow.length === 0, slow.map(([k, r]) => `${k} → ${r.model}`).join(", "))
check("the phone receptionist turn is a routing row (was the Sonnet default)", ROUTES.has("voice_reception_turn") && !EXPENSIVE.has(ROUTES.get("voice_reception_turn")!.model))
// Positive control for R4's filter: a specimen Sonnet real-time row is caught.
check("control: R4's filter flags a specimen real-time row on Sonnet",
  [["specimen_voice_turn", { model: "claude-sonnet", fallback: "gpt-4o" }] as const].filter(([k, r]) => REALTIME.test(k) && EXPENSIVE.has(r.model)).length === 1)

console.log(`\n${passed} passed, ${failed} failed`)
console.log(`census: ${sites.length} routed call sites · ${new Set(sites.map((s) => s.feature).filter(Boolean)).size} distinct features · ${ROUTES.size} routing rows · ${unrouted.length} unrouted · ${featureless.length} featureless · ${modelArg.length} ignored-model`)
process.exit(failed > 0 ? 1 : 0)
