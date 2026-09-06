#!/usr/bin/env tsx
/**
 * scripts/unread-compliance-verdict-guard.ts   (npm run test:unread-compliance-verdict)
 * ─────────────────────────────────────────────────────────────────────────────
 * A COMPLIANCE VERDICT THAT IS COMPUTED AND NEVER READ.
 *
 * THE DEFECT, measured, in app/actions/ai-isa.ts:triggerGhostRecovery:
 *
 *     // Step 2: Compliance gate — hard stop
 *     const compliance = await runAiIsaComplianceCheck({ … })
 *
 *     // Hard stop: blocked lifecycle states
 *     if (["REPRESENTATION", …].includes(contact.lifecycle_state ?? "")) { … }
 *
 *     const dispatchResult = await dispatchEmail({ … })
 *
 * The gate ran. The DNC / TCPA / consent answer came back. `compliance` was
 * never read again, and the email went out. Both sibling send paths in that same
 * file refuse on the identical value — `if (!compliance.allowed) return
 * { success: false, error: … }` — so this was not a policy decision, it was a
 * dropped line, on the ONE path in the file a human triggers by hand.
 *
 * ── WHY THIS NEEDS ITS OWN DETECTOR ──────────────────────────────────────────
 *
 * Nothing in this repo could see it, and each near-miss is instructive:
 *
 *   · `scripts/discarded-outcome-guard.ts` owns the mirror shape one layer out —
 *     a CLIENT caller that drops a server action's `{success:false}` and shows a
 *     toast anyway. It resolves imports from client components; a server file
 *     calling its own module-local gate is not in its corpus at all.
 *   · `scripts/opposite-missing-census.ts` category 4 counts an INERT PARAMETER,
 *     not an inert LOCAL. A `const` nobody reads is invisible to every category
 *     it has.
 *   · TypeScript's `noUnusedLocals` would see it — and it is off for this
 *     project, which is why the binding sat there.
 *
 * So the population is narrow and chosen for consequence rather than for what is
 * easy to parse: the awaited call must be to a COMPLIANCE GATE by name. A
 * general "unused const" sweep over this tree is thousands of hits of noise, and
 * an instrument nobody reads is an instrument that is switched off.
 *
 * ── FALSE ACCUSATION IS THE EXPENSIVE DIRECTION ──────────────────────────────
 *
 * A verdict may legitimately be read in ways this scan must not mistake for
 * absence, so all of these count as a READ and are proved to count in the
 * controls below: a property access (`c.allowed`), a call argument (`f(c)`), a
 * destructure of it, a spread (`...c`), a return, a template interpolation, a
 * negation. Only "the name never appears again inside the enclosing function"
 * is reported. Where the enclosing function cannot be delimited the site is
 * counted UNRESOLVED and never judged — the count is printed beside the finding
 * count, because a coverage number without its denominator rounds up.
 *
 * COMMENTS ARE BLANKED FIRST with scripts/strip-comments.ts (CLAUDE.md §2) —
 * never a hand-rolled pair. A prose mention of the variable must not vouch for a
 * read; that is the entire failure mode being detected, wearing a comment.
 *
 * Run: npx tsx scripts/unread-compliance-verdict-guard.ts
 */
import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { blankComments } from "./strip-comments"
import { runtimeFiles } from "./runtime-roots"

const root = process.cwd()
const rel = (p: string) => relative(root, p).replace(/\\/g, "/")

/**
 * THE GATES. Every name here either IS an exported compliance evaluator in this
 * repo or is a module-local wrapper around one, enumerated from the tree rather
 * than imagined:
 *
 *   grep -rhoP "(const|await)\s+\w+\s*=\s*await\s+\K\w*[Cc]ompliance\w*" app lib
 *
 * The wrapper spellings matter as much as the exported ones — the measured
 * defect called `runAiIsaComplianceCheck`, not `evaluateOutbound`, and a list of
 * only the exported names would have reported zero and read as a clean tree.
 */
const GATE_CALLS = [
  "evaluateOutbound",
  "evaluateKernelOutbound",
  "evaluateOutboundCompliance",
  "evaluateOutboundEligibility",
  "runComplianceGate",
  "runComplianceCheck",
  "runFinalComplianceCheck",
  "runAiIsaComplianceCheck",
  "checkBrandCompliance",
  "checkCompliance",
]
const GATE_RE = new RegExp(
  String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*await\s+(${GATE_CALLS.join("|")})\s*\(`,
  "g",
)

/** Balanced-brace walk. Returns -1 when the source runs out first. */
function matchBrace(src: string, open: number): number {
  let d = 0, q: string | null = null
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (q) { if (ch === q && src[i - 1] !== "\\") q = null; continue }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; continue }
    if (ch === "{") d++
    else if (ch === "}") { d--; if (d === 0) return i }
  }
  return -1
}

/**
 * The body of the function ENCLOSING an offset.
 *
 * Walked outward from the site rather than matched by a signature regex: the
 * gates are called from `export async function`, from arrow consts, from object
 * methods and from inside `try {`, and a signature pattern that understands only
 * the first would silently classify the rest as unresolved — which reads as a
 * clean tree. The innermost brace block that CONTAINS the site and is opened by
 * a function header is the scope a `const` declared at the site can be read in.
 */
function enclosingFunctionBody(src: string, at: number): string | null {
  // Every `{` before the site, innermost-outward, until one whose block contains
  // the site AND whose header looks like a function.
  const opens: number[] = []
  let q: string | null = null
  for (let i = 0; i < at; i++) {
    const ch = src[i]
    if (q) { if (ch === q && src[i - 1] !== "\\") q = null; continue }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; continue }
    if (ch === "{") opens.push(i)
    else if (ch === "}") opens.pop()
  }
  for (let k = opens.length - 1; k >= 0; k--) {
    const open = opens[k]
    const header = src.slice(Math.max(0, open - 300), open)
    if (!/(?:\)\s*(?::[^{;]*)?$)|=>\s*$/.test(header.trimEnd() + (header.endsWith(" ") ? "" : ""))) {
      // Not a function header (a plain `{` block, an object literal, an if-block).
      if (!/\)\s*(?::[\s\S]{0,200})?\s*$/.test(header) && !/=>\s*$/.test(header.trimEnd())) continue
    }
    const close = matchBrace(src, open)
    if (close > at) return src.slice(open, close + 1)
  }
  return null
}

interface Finding { file: string; line: number; name: string; gate: string }
const findings: Finding[] = []
let sitesExamined = 0
let unresolvedScope = 0

/** Does `name` appear as an identifier anywhere in `body` other than at its own declaration? */
function isReadIn(body: string, name: string, declIndexInBody: number, declLen: number): boolean {
  const word = new RegExp(String.raw`\b${name.replace(/\$/g, "\\$")}\b`, "g")
  let m: RegExpExecArray | null
  while ((m = word.exec(body))) {
    if (m.index >= declIndexInBody && m.index < declIndexInBody + declLen) continue
    return true
  }
  return false
}

function scan(file: string, raw: string) {
  const src = blankComments(raw)
  GATE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = GATE_RE.exec(src))) {
    sitesExamined++
    const name = m[1]
    const body = enclosingFunctionBody(src, m.index)
    if (body === null) { unresolvedScope++; continue }
    const declInBody = body.indexOf(m[0])
    if (declInBody < 0) { unresolvedScope++; continue }
    if (!isReadIn(body, name, declInBody, m[0].length)) {
      findings.push({ file, line: src.slice(0, m.index).split("\n").length, name, gate: m[2] })
    }
  }
}

for (const abs of runtimeFiles(root)) {
  let raw = ""
  try { raw = readFileSync(abs, "utf8") } catch { continue }
  scan(rel(abs), raw)
}

// ── POSITIVE CONTROLS ───────────────────────────────────────────────────────
// A broken regex and a clean tree both report zero. Each arm is asserted: the
// DEFECT must be seen, and every legitimate way of reading a verdict must NOT
// be seen. Without the second half this guard could "pass" by never matching.
const controls: Array<[string, boolean, string?]> = []
const control = (n: string, ok: boolean, note?: string) => controls.push([n, ok, note])

function probe(text: string): Finding[] {
  const save = findings.length
  const saveSites = sitesExamined, saveUnres = unresolvedScope
  scan("<control>", text)
  const got = findings.slice(save)
  findings.length = save
  sitesExamined = saveSites
  unresolvedScope = saveUnres
  return got
}

const DEFECT = `export async function send() {
  const compliance = await runAiIsaComplianceCheck({ a: 1 })
  const r = await dispatchEmail({ to: "x" })
  return r
}
`
control("sees a verdict that is bound and never read (the measured defect)",
  probe(DEFECT).length === 1 && probe(DEFECT)[0].name === "compliance",
  probe(DEFECT).map((f) => f.name).join(","))

for (const [label, body] of [
  ["property access", `  if (!compliance.allowed) return { ok: false }`],
  ["negation only", `  if (!compliance) return { ok: false }`],
  ["passed as an argument", `  report(compliance)`],
  ["destructured afterwards", `  const { allowed } = compliance`],
  ["spread into a payload", `  await log({ ...compliance })`],
  ["returned", `  return compliance`],
  ["template interpolation", `  console.log(\`v=\${compliance.allowed}\`)`],
  ["read inside a nested block", `  if (x) { if (!compliance.allowed) return { ok: false } }`],
] as Array<[string, string]>) {
  const src = `export async function send() {\n  const compliance = await runAiIsaComplianceCheck({ a: 1 })\n${body}\n  return 1\n}\n`
  control(`does NOT accuse a verdict read by ${label}`, probe(src).length === 0,
    probe(src).map((f) => f.name).join(","))
}

control("a COMMENT naming the verdict does not vouch for a read",
  probe(`export async function send() {\n  const compliance = await evaluateOutbound({ a: 1 })\n  // compliance is fine here\n  return 1\n}\n`).length === 1)

control("an awaited call that is NOT a compliance gate is not examined",
  probe(`export async function send() {\n  const unrelated = await fetchSomething({ a: 1 })\n  return 1\n}\n`).length === 0)

control("sees a verdict inside an arrow function too, not only a function declaration",
  probe(`export const send = async () => {\n  const c = await evaluateKernelOutbound({ a: 1 })\n  return 1\n}\n`).length === 1,
  String(probe(`export const send = async () => {\n  const c = await evaluateKernelOutbound({ a: 1 })\n  return 1\n}\n`).length))

control("examined a real population in the tree", sitesExamined > 20, `${sitesExamined} gate call sites`)

// ── REPORT ──────────────────────────────────────────────────────────────────
console.log("══════════════════════════════════════════════════")
console.log(" UNREAD COMPLIANCE VERDICT — a gate that ran and was not listened to")
console.log("══════════════════════════════════════════════════")

const failedControls = controls.filter(([, ok]) => !ok)
console.log(`\n[positive controls] ${controls.length - failedControls.length}/${controls.length} passing`)
for (const [n, ok, note] of controls) if (!ok) console.log(`  ✗ ${n}${note ? ` — got: ${note}` : ""}`)
if (failedControls.length > 0) {
  console.log("\n  A FAILED CONTROL MEANS THIS SCANNER IS BLIND, NOT THAT THE TREE IS CLEAN.")
  console.log(" ❌ UNREAD_COMPLIANCE_VERDICT_FAIL — positive control failed")
  process.exit(1)
}

console.log(`\n[coverage] ${sitesExamined} compliance-gate call sites bound to a name`)
console.log(`           ${unresolvedScope} whose enclosing function could not be delimited (counted, never judged)`)
console.log(`           gates watched: ${GATE_CALLS.join(", ")}`)

console.log(`\n[findings] ${findings.length}`)
for (const f of findings) {
  console.log(`  ✗ ${f.file}:${f.line} — \`${f.name}\` holds ${f.gate}()'s verdict and nothing reads it`)
}

console.log("\n──────────────────────────────────────────────────")
if (findings.length > 0) {
  console.log("  A compliance gate whose answer is discarded is worse than no gate:")
  console.log("  the code reads as guarded and the send goes out anyway.")
  console.log("  Refuse on the verdict, or delete the call and say why it is not needed.")
  console.log(" ❌ UNREAD_COMPLIANCE_VERDICT_FAIL")
  process.exit(1)
}
console.log(" ✅ UNREAD_COMPLIANCE_VERDICT_PASS — every compliance verdict computed is read")
