#!/usr/bin/env tsx
/**
 * scripts/unread-state-census.ts   (npm run test:unread-state — NOT YET
 * REGISTERED, see the report that shipped this file for the exact
 * package.json/guard/MAINTENANCE_DOMAINS lines an integrator must add)
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE SHAPES OF A "use client" COMPONENT TALKING TO ITSELF AND NOT LISTENING:
 *
 *   1. `const [x, setX] = useState(...)` where `setX` is never called again in
 *      the file — a piece of state nothing can ever change after mount.
 *   2. The same pair where `x` is never READ again — a setter fires into a
 *      value nothing renders or branches on.
 *   3. `useEffect(() => { … }, [depA, depB])` naming a dependency that is
 *      declared NOWHERE in the file — almost always a stale entry left behind
 *      by a rename/refactor (the effect now depends on a name that no longer
 *      exists) rather than a real closure-over-undefined, since the latter
 *      would not compile.
 *
 * Scope, on purpose: only files under `app/` whose FIRST statement is the
 * `"use client"` directive — server components have no hooks to mis-wire, and
 * `lib/` hooks are reused across many callers so "never called in this file"
 * is not a meaningful question there.
 *
 * ── MEASUREMENT DISCIPLINE (§2) ────────────────────────────────────────────
 * All three checks run on `blankStrings(src)` — comments blanked AND string/
 * template CONTENTS blanked, but every identifier that is real code (JSX
 * expressions included) stays. A setter name mentioned only inside an error
 * string or a comment must not read as "called"; blankStrings is what removes
 * that vocabulary before either search runs. Declarations are found on the
 * same masked text so byte offsets line up for the "used elsewhere" search
 * (the declaration's own span is excised first, exactly as
 * dead-import-census.ts excises the import clause before asking whether the
 * name appears again).
 *
 * BLIND SPOTS, published beside the number:
 *   · Checks 1/2 are WORD-BOUNDARY, not scope-aware: a setter/value shadowed
 *     by an inner closure with the same local name reads as "used" even if the
 *     OUTER binding specifically is dead. Under-accusing.
 *   · A setter handed to a child as `onChange={setX}` or spread into an object
 *     counts as used — it is. A setter captured in a ref and invoked through
 *     the ref (`refToSetX.current = setX`) then called only via the ref's
 *     `.current(...)` also reads as used, correctly (the name `setX` still
 *     appears at the assignment).
 *   · Check 3's declared-name extraction is A SET OF BINDING SITES (const/let/
 *     var LHS, function/arrow params, `catch`, `for`, class names, import
 *     specifiers), token-broadened rather than scope-precise — every
 *     identifier text inside a binding site's LHS/param list is added,
 *     including a destructured KEY that is not itself the bound local name
 *     (`{ a: renamed }` adds both `a` and `renamed`). This is deliberately
 *     OVER-INCLUSIVE: it can only shrink the finding list, never grow it with
 *     a name that is not really in scope, so it cannot manufacture a false
 *     accusation — it can only miss a genuinely-undefined name that happens to
 *     share a word with something declared elsewhere in the file (an
 *     unrelated `id` local, say, masking a `useEffect` deps array's dangling
 *     `id`). Under-accusing.
 *   · Check 3 only reads a deps array that is a LITERAL closing the call
 *     (`useEffect(fn, [a, b])`); a deps array passed as a named variable
 *     (`useEffect(fn, depsRef)`) is invisible to this check (nothing to
 *     tokenise). Only bare-identifier deps entries are checked; a member
 *     expression (`props.value`) or a call (`fn()`) entry is skipped — the
 *     ROOT of a member expression is still checked (`props` in `props.value`).
 *   · Global/browser identifiers (`window`, `document`, `fetch`, …) are
 *     allow-listed so they never read as undefined; a project-specific global
 *     ambient declaration outside that list would still be flagged.
 *
 * SCRAPING IS FROZEN (wave 55 lane rules): findings under any path this
 * repo's scraping freeze names are reported separately as excluded debt,
 * never counted against PASS/FAIL, never auto-fixed by this file. (In
 * practice none of the frozen paths are "use client" component files, but the
 * filter is applied for the same reason every other census in this wave
 * applies it — consistency a future diff can grep for.)
 */
import { readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { walkTs } from "./runtime-roots"
import { stripComments, blankStrings } from "./strip-comments"

const root = process.cwd()

const SCRAPING_PATH_PREFIXES = [
  "lib/lead-pipeline/",
  "lib/external/",
  "app/actions/lead-intelligence.ts",
  "lib/kernel/intent-campaign.ts",
  "lib/kernel/scraping.ts",
  "app/actions/lead-scraping-config.ts",
  "app/api/cron/lead-scraping/",
]
function isScrapingPath(relPath: string): boolean {
  return SCRAPING_PATH_PREFIXES.some((p) => relPath === p || relPath.startsWith(p))
}

/** Omit distributed over the union — a plain Omit<Finding,"file"> collapses to the common keys. */
export type FindingBody = Finding extends infer F ? (F extends { file: string } ? Omit<F, "file"> : never) : never
export type Finding =
  | { kind: "setter-never-called"; file: string; line: number; state: string; setter: string }
  | { kind: "state-never-read"; file: string; line: number; state: string; setter: string }
  | { kind: "effect-dep-undefined"; file: string; line: number; dep: string }

function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++
  return line
}

/** Is this file's FIRST statement the "use client" directive? Checked on the
 *  comment-stripped (not string-masked) source, so the directive's own quoted
 *  text is still legible. */
function isUseClientFile(stripped: string): boolean {
  return /^\s*["']use client["']\s*;?/.test(stripped)
}

// ── RESERVED WORDS excluded from every token-broadened extraction ───────────
const RESERVED = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch",
  "case", "default", "break", "continue", "new", "delete", "typeof", "instanceof", "in", "of",
  "this", "super", "class", "extends", "import", "export", "from", "as", "async", "await",
  "yield", "try", "catch", "finally", "throw", "void", "null", "undefined", "true", "false",
  "static", "get", "set", "public", "private", "protected", "readonly", "interface", "type",
  "enum", "namespace", "declare", "module", "implements", "abstract", "is", "keyof", "infer",
  "never", "unknown", "any", "string", "number", "boolean", "object", "symbol", "bigint",
])

// ── GLOBALS never flagged as an undefined useEffect dependency ──────────────
const GLOBAL_ALLOWLIST = new Set([
  "window", "document", "navigator", "console", "localStorage", "sessionStorage", "history",
  "location", "process", "globalThis", "self", "top", "parent", "crypto", "Intl", "fetch",
  "alert", "confirm", "prompt", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "queueMicrotask", "structuredClone",
  "Math", "JSON", "Object", "Array", "Promise", "Date", "Number", "String", "Boolean", "RegExp",
  "Map", "Set", "WeakMap", "WeakSet", "Error", "TypeError", "RangeError", "Infinity", "NaN",
  "WebSocket", "FormData", "Headers", "Request", "Response", "URL", "URLSearchParams", "Blob",
  "File", "FileReader", "AbortController", "IntersectionObserver", "ResizeObserver",
  "MutationObserver", "performance", "CustomEvent", "Event", "undefined",
])

/** Index of the char matching `s[openIdx]`, scanning FORWARD (same bracket type only). */
function matchBracketForward(s: string, openIdx: number): number {
  const open = s[openIdx]
  const close = open === "(" ? ")" : open === "[" ? "]" : "}"
  let depth = 0
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === open) depth++
    else if (s[i] === close) { depth--; if (depth === 0) return i }
  }
  return -1
}

/** Index of the char matching `s[closeIdx]`, scanning BACKWARD (same bracket type only). */
function matchBracketBackward(s: string, closeIdx: number): number {
  const close = s[closeIdx]
  const open = close === ")" ? "(" : close === "]" ? "[" : "{"
  let depth = 0
  for (let i = closeIdx; i >= 0; i--) {
    if (s[i] === close) depth++
    else if (s[i] === open) { depth--; if (depth === 0) return i }
  }
  return -1
}

function addTokens(text: string, into: Set<string>): void {
  for (const t of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (!RESERVED.has(t[0])) into.add(t[0])
  }
}

/**
 * Every name this file BINDS somewhere: import specifiers, const/let/var LHS
 * (destructuring included, token-broadened per the header's blind-spot note),
 * function/arrow parameter lists, `catch (e)`, `for (const x …)`, `class Name`.
 * Deliberately over-inclusive — see header.
 */
function declaredNamesInFile(masked: string): Set<string> {
  const names = new Set<string>()

  // imports: default, namespace, and named clauses (all three optionally combined).
  const importRe = /import\s+(?:type\s+)?(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s*as\s+([\w$]+))?\s*from\s*["'][^"']+["']/g
  for (const m of masked.matchAll(importRe)) {
    if (m[1]) names.add(m[1])
    if (m[2]) addTokens(m[2], names)
    if (m[3]) names.add(m[3])
  }

  // const/let/var: everything in the LHS up to the first top-level `=` (or
  // statement end for a bare `let x;`), token-broadened.
  const bindRe = /\b(?:const|let|var)\s+/g
  let bm: RegExpExecArray | null
  while ((bm = bindRe.exec(masked))) {
    let i = bm.index + bm[0].length
    let depth = 0
    let j = i
    while (j < masked.length) {
      const ch = masked[j]
      if (ch === "{" || ch === "[" || ch === "(") depth++
      else if (ch === "}" || ch === "]" || ch === ")") { if (depth === 0) break; depth-- }
      else if (ch === "=" && depth === 0 && masked[j + 1] !== "=" && masked[j - 1] !== "=" && masked[j - 1] !== "!" && masked[j - 1] !== "<" && masked[j - 1] !== ">") break
      else if ((ch === ";" || ch === "\n") && depth === 0) break
      j++
    }
    addTokens(masked.slice(i, j), names)
  }

  // function declarations/expressions: `function name(params)`
  const fnRe = /\bfunction\s*[\w$]*\s*\(/g
  let fm: RegExpExecArray | null
  while ((fm = fnRe.exec(masked))) {
    const open = fm.index + fm[0].length - 1
    const close = matchBracketForward(masked, open)
    if (close === -1) continue
    addTokens(masked.slice(open + 1, close), names)
  }

  // arrow function params: a `(...)` or a single bare identifier immediately
  // before `=>`.
  const arrowRe = /=>/g
  let am: RegExpExecArray | null
  while ((am = arrowRe.exec(masked))) {
    let k = am.index - 1
    while (k >= 0 && /\s/.test(masked[k])) k--
    if (masked[k] === ")") {
      const open = matchBracketBackward(masked, k)
      if (open !== -1) addTokens(masked.slice(open + 1, k), names)
    } else {
      // single bare identifier param, e.g. `x => x + 1`
      let s = k
      while (s >= 0 && /[\w$]/.test(masked[s])) s--
      const ident = masked.slice(s + 1, k + 1)
      if (/^[A-Za-z_$][\w$]*$/.test(ident) && !RESERVED.has(ident)) names.add(ident)
    }
  }

  // catch (e)
  for (const m of masked.matchAll(/\bcatch\s*\(\s*([\w$]+)\s*\)/g)) names.add(m[1])

  // for (const x of …) / for (let i = 0; …)
  for (const m of masked.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([\w$]+)/g)) names.add(m[1])
  for (const m of masked.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s*\[([^\]]*)\]/g)) addTokens(m[1], names)

  // class Name
  for (const m of masked.matchAll(/\bclass\s+([\w$]+)/g)) names.add(m[1])

  return names
}

/** All findings in one file's source, `relFile` used only for reporting. */
export function findingsInSource(src: string): FindingBody[] {
  const stripped = stripComments(src)
  if (!isUseClientFile(stripped)) return []
  const masked = blankStrings(src)
  const out: FindingBody[] = []

  // ── 1/2: useState pairs ────────────────────────────────────────────────
  const useStateRe = /const\s*\[\s*([\w$]+)\s*,\s*([\w$]+)\s*\]\s*=\s*useState(?:<[^>]*>)?\s*\(/g
  let sm: RegExpExecArray | null
  while ((sm = useStateRe.exec(masked))) {
    const [full, stateName, setterName] = sm
    const start = sm.index
    const end = start + full.length
    const rest = masked.slice(0, start) + masked.slice(end)
    const line = lineOf(masked, start)
    const usedRe = (name: string) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(rest)
    if (setterName !== "_" && !usedRe(setterName)) {
      out.push({ kind: "setter-never-called", line, state: stateName, setter: setterName })
    }
    if (stateName !== "_" && !usedRe(stateName)) {
      out.push({ kind: "state-never-read", line, state: stateName, setter: setterName })
    }
  }

  // ── 3: useEffect deps naming an undefined identifier ──────────────────
  const declared = declaredNamesInFile(masked)
  const effectRe = /\buseEffect\s*\(/g
  let em: RegExpExecArray | null
  while ((em = effectRe.exec(masked))) {
    const open = em.index + em[0].length - 1
    const close = matchBracketForward(masked, open)
    if (close === -1) continue
    const callBody = masked.slice(open + 1, close)
    const trimmed = callBody.replace(/\s+$/, "")
    if (!trimmed.endsWith("]")) continue // no literal deps array — out of scope, see header
    const closeBracketRel = trimmed.length - 1
    const openBracketRel = matchBracketBackward(trimmed, closeBracketRel)
    if (openBracketRel === -1) continue
    const depsBody = trimmed.slice(openBracketRel + 1, closeBracketRel)
    const depsStart = open + 1 + openBracketRel

    // split on top-level commas
    let depth = 0
    let entryStart = 0
    const entries: Array<{ text: string; offset: number }> = []
    for (let i = 0; i <= depsBody.length; i++) {
      const ch = depsBody[i]
      if (i === depsBody.length || (ch === "," && depth === 0)) {
        entries.push({ text: depsBody.slice(entryStart, i), offset: entryStart })
        entryStart = i + 1
      } else if (ch === "{" || ch === "[" || ch === "(") depth++
      else if (ch === "}" || ch === "]" || ch === ")") depth--
    }

    for (const entry of entries) {
      const trimmedEntry = entry.text.trim()
      if (!trimmedEntry) continue
      if (trimmedEntry.includes("(")) continue // a call — not a bare name, out of scope
      const rootMatch = trimmedEntry.match(/^[A-Za-z_$][\w$]*/)
      if (!rootMatch) continue
      const root = rootMatch[0]
      if (GLOBAL_ALLOWLIST.has(root) || declared.has(root)) continue
      const absOffset = depsStart + entry.offset + entry.text.indexOf(root)
      out.push({ kind: "effect-dep-undefined", line: lineOf(masked, absOffset), dep: root })
    }
  }

  return out
}

function scan(dirs: string[]): Finding[] {
  const findings: Finding[] = []
  for (const dir of dirs) {
    for (const abs of walkTs(join(root, dir))) {
      const rel = relative(root, abs).split(sep).join("/")
      let src: string
      try { src = readFileSync(abs, "utf8") } catch { continue }
      for (const f of findingsInSource(src)) findings.push({ ...(f as any), file: rel })
    }
  }
  return findings
}

// ─────────────────────────────────────────────────────────────────────────────
// POSITIVE CONTROLS (§2 — an absence claim is worthless without one)
// ─────────────────────────────────────────────────────────────────────────────
function positiveControls(): string[] {
  const problems: string[] = []
  const expect = (name: string, cond: boolean) => { if (!cond) problems.push(name) }

  const wrap = (body: string) => `"use client"\nimport { useState, useEffect } from "react"\n${body}`

  // 1. setter never called
  expect(
    "a setter never called again is flagged",
    findingsInSource(wrap('function C() { const [x, setX] = useState(0); return <div>{x}</div> }')).some(
      (f) => f.kind === "setter-never-called" && (f as any).setter === "setX",
    ),
  )
  expect(
    "a setter that IS called is not flagged",
    !findingsInSource(wrap('function C() { const [x, setX] = useState(0); return <button onClick={() => setX(1)}>{x}</button> }')).some(
      (f) => f.kind === "setter-never-called",
    ),
  )
  expect(
    "a setter passed as a prop (not literally called) still counts as used",
    !findingsInSource(wrap('function C() { const [x, setX] = useState(0); return <Child onChange={setX} value={x} /> }')).some(
      (f) => f.kind === "setter-never-called",
    ),
  )

  // 2. state never read
  expect(
    "a state value never read again is flagged",
    findingsInSource(wrap('function C() { const [x, setX] = useState(0); return <button onClick={() => setX(1)}>go</button> }')).some(
      (f) => f.kind === "state-never-read" && (f as any).state === "x",
    ),
  )
  expect(
    "a state value that IS rendered is not flagged",
    !findingsInSource(wrap('function C() { const [x, setX] = useState(0); return <div onClick={() => setX(1)}>{x}</div> }')).some(
      (f) => f.kind === "state-never-read",
    ),
  )

  // mention inside a string/comment does not count as a use
  expect(
    "a mention of the setter inside a STRING does not count as a call",
    findingsInSource(wrap('function C() { const [x, setX] = useState(0); const msg = "call setX to change"; return <div>{x}{msg}</div> }')).some(
      (f) => f.kind === "setter-never-called",
    ),
  )
  expect(
    "a mention inside a COMMENT does not count as a use",
    findingsInSource(wrap('function C() { const [x, setX] = useState(0);\n// setX(1) used to be called here\nreturn <div>{x}</div> }')).some(
      (f) => f.kind === "setter-never-called",
    ),
  )

  // 3. useEffect deps
  expect(
    "an undefined dependency is flagged",
    findingsInSource(wrap('function C() { useEffect(() => { doThing(ghostVar) }, [ghostVar]); return null }')).some(
      (f) => f.kind === "effect-dep-undefined" && (f as any).dep === "ghostVar",
    ),
  )
  expect(
    "a dependency that IS a local const is not flagged",
    !findingsInSource(wrap('function C() { const real = 1; useEffect(() => { doThing(real) }, [real]); return null }')).some(
      (f) => f.kind === "effect-dep-undefined",
    ),
  )
  expect(
    "a dependency that is a component PROP is not flagged",
    !findingsInSource(wrap('function C({ propVal }: { propVal: number }) { useEffect(() => { doThing(propVal) }, [propVal]); return null }')).some(
      (f) => f.kind === "effect-dep-undefined",
    ),
  )
  expect(
    "a member expression's ROOT is checked, not the whole path",
    !findingsInSource(wrap('function C() { const props = useProps(); useEffect(() => { doThing(props.value) }, [props.value]); return null }')).some(
      (f) => f.kind === "effect-dep-undefined",
    ),
  )
  expect(
    "a global (window) is never flagged as an undefined dependency",
    !findingsInSource(wrap('function C() { useEffect(() => { doThing(window) }, [window]); return null }')).some(
      (f) => f.kind === "effect-dep-undefined",
    ),
  )
  expect(
    "a call-shaped entry is skipped, not flagged",
    !findingsInSource(wrap('function C() { useEffect(() => { doThing() }, [computeKey()]); return null }')).some(
      (f) => f.kind === "effect-dep-undefined",
    ),
  )

  // scope: server components are excluded entirely
  expect(
    "a file with no \"use client\" directive is never scanned",
    findingsInSource('import { useState } from "react"\nfunction C() { const [x, setX] = useState(0); return null }').length === 0,
  )

  return problems
}

// ─────────────────────────────────────────────────────────────────────────────
if (typeof process !== "undefined" && /unread-state-census\.ts$/.test(process.argv[1] ?? "")) {
  const listMode = process.argv.includes("--list")
  const problems = positiveControls()
  if (problems.length) {
    console.log("✗ unread-state-census positive controls — the scanner no longer recognises:")
    for (const p of problems) console.log("   - " + p)
    process.exit(1)
  }

  const findings = scan(["app"]).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  const scraping = findings.filter((f) => isScrapingPath(f.file))
  const live = findings.filter((f) => !isScrapingPath(f.file))

  const describe = (f: Finding): string => {
    if (f.kind === "setter-never-called") return `setter '${f.setter}' (state '${f.state}') never called again`
    if (f.kind === "state-never-read") return `state '${f.state}' (setter '${f.setter}') never read again`
    return `useEffect dep '${f.dep}' names nothing declared in this file`
  }

  console.log("═".repeat(70))
  console.log(" UNREAD-STATE CENSUS — useState/useEffect halves a \"use client\" file never wires")
  console.log("═".repeat(70))
  console.log(`  ${findings.length} finding(s) across app/ "use client" files`)
  console.log(`  ${scraping.length} under the wave-55 scraping freeze — excluded from PASS/FAIL, never auto-fixed`)
  console.log(`  ${live.length} live (non-scraping) — the burn-down list`)
  console.log("")
  console.log("  BLIND SPOTS: word-boundary, not scope-aware (checks 1/2 under-accuse on")
  console.log("  shadowed locals); check 3's declared-name set is token-broadened and can")
  console.log("  only shrink findings, never manufacture one; a non-literal deps array or a")
  console.log("  call-shaped/member-expression dep entry is out of scope for check 3.")

  if (findings.length > 0 || listMode) {
    console.log("")
    for (const f of live) console.log(`  ✗ ${f.file}:${f.line}  ${describe(f)}`)
    for (const f of scraping) console.log(`  ⏭ ${f.file}:${f.line}  ${describe(f)} — FROZEN, excluded`)
  }

  console.log("")
  if (live.length > 0) {
    console.log(`✗ UNREAD_STATE_CENSUS_FAIL — ${live.length} non-scraping finding(s) to wire or remove`)
    process.exit(listMode ? 0 : 1)
  }
  console.log("✅ UNREAD_STATE_CENSUS_PASS — no non-scraping unread state/setter/effect-dep found")
}
