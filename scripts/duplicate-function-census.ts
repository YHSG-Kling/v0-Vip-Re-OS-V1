// scripts/duplicate-function-census.ts (lane BD, 2026-09-08) — CLAUDE.md §1 same-name /
// same-body duplicate sweep across app/ lib/ remotion/ hooks/.
//
// Read-only. `--list` prints every hit; exit code is always 0 — this is a finder, not a
// guard, and adjudication (merge-then-delete-with-tombstone vs "record: cross-boundary" vs
// "different shape, rename per §6") is a human/lane judgment call this script does not make.
//
// TWO KINDS OF HIT:
//   SAME NAME — `function NAME(` / `export function NAME(` / `const NAME = (` (arrow or
//               function-expression) declared in >=2 DISTINCT FILES. Overloads, re-exports
//               and legitimately different shapes under one name all show up here too — the
//               verdict hint just flags same-name-and-same-arity as worth a closer look.
//   SAME BODY — a block-bodied function/arrow (>=6 source lines) whose body, normalised
//               (comments stripped, all whitespace collapsed to single spaces — CLAUDE.md
//               task scope says whitespace+comments only, NOT identifier renaming), is
//               byte-identical to another one in a DIFFERENT file. This is the strong signal:
//               two functions can share a name without sharing a body (overloads) or share a
//               body without sharing a name (copy-paste under a new name) — SAME BODY catches
//               the second case SAME NAME cannot.
//
// MEASUREMENT DISCIPLINE (CLAUDE.md §2):
//   · Comments are stripped via scripts/strip-comments.ts — never hand-rolled.
//   · Brace/paren matching walks `blankStrings(src)` (comments AND string/template CONTENTS
//     blanked to spaces, same length/offsets as `src`) so a `{`/`(` quoted in a string or
//     template literal is never counted as real code structure — offsets found there index
//     directly into the original `src` because blankStrings preserves length.
//   · POSITIVE CONTROL: selfTest() below runs two independent planted fixtures — one same-
//     name pair, one same-body-different-name pair — through the real declaration finder and
//     hasher before any repo file is read, and asserts both are caught. If this scanner is
//     accidentally broken (e.g. reverted to a hand-rolled comment strip), the control fails
//     LOUD instead of the census quietly reporting fewer files.
//   · STATED BLIND SPOTS:
//       - A regex literal's contents are copied verbatim by the shared scanner (never
//         blanked), so a stray unbalanced `{`/`(` inside a `/…/` literal can desynchronise
//         this file's brace counter for the rest of that declaration. Rare in practice; not
//         hit by any of the CLAUDE.md-listed collision names as of this run.
//       - A `function` whose return-type annotation itself contains an object-type literal
//         (`function f(): { a: number } { ... }`) can have its FIRST `{` misread as the body
//         open. Not observed in this repo's collision list.
//       - Expression-bodied arrows (`const f = (x) => x + 1`, no block) are recorded for
//         SAME NAME but have no body to hash, so they never appear in SAME BODY.
//       - Overloaded/ambient `function` signatures with no body (`;` instead of `{`) are
//         skipped entirely — nothing to extract.
import { readFileSync } from "node:fs"
import { globSync } from "glob"
import { stripComments, blankStrings } from "./strip-comments"

const ROOT = process.cwd()

interface Decl {
  name: string
  file: string
  line: number
  kind: "function" | "arrow" | "func-expr"
  bodyRaw: string | null // exclusive of the braces; null when no block body found
}

// ── declaration finder ────────────────────────────────────────────────────────────────────

const IDENT = "[A-Za-z_$][\\w$]*"

/** Index of the char matching the opener at `openIdx` (masked src: only real-code brackets
 *  count), or -1 if the source ends unmatched. Works for any single-char bracket pair. */
function matchBracket(masked: string, openIdx: number, open: string, close: string): number {
  let depth = 0
  for (let i = openIdx; i < masked.length; i++) {
    const c = masked[i]
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function lineOf(src: string, idx: number): number {
  let n = 1
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") n++
  return n
}

/** First non-whitespace index at or after `idx`, skipping ONLY whitespace (masked src). */
function skipWs(masked: string, idx: number): number {
  let i = idx
  while (i < masked.length && /\s/.test(masked[i])) i++
  return i
}

function findDeclarations(src: string, relPath: string): Decl[] {
  const masked = blankStrings(src) // same length/offsets as src; comments+string contents blanked
  const out: Decl[] = []

  // `function NAME(` — with or without a leading `export`/`export default`/`async`.
  {
    const re = new RegExp(`\\bfunction\\s+(${IDENT})\\s*\\(`, "g")
    let m: RegExpExecArray | null
    while ((m = re.exec(masked))) {
      const name = m[1]
      const parenOpen = m.index + m[0].length - 1
      const parenClose = matchBracket(masked, parenOpen, "(", ")")
      if (parenClose === -1) continue
      // Skip past an optional return-type annotation to the body's `{`. Bail (no body) if we
      // hit `;` or `=>`-free end-of-statement before any `{` within a short lookahead — covers
      // ambient/overload signatures with no block.
      let i = skipWs(masked, parenClose + 1)
      if (masked[i] === ":") {
        // crude type-skip: advance to the next top-level `{` or `;`, whichever comes first,
        // not crossing an unmatched `<`/`(`/`[` depth (rare in return types here; acceptable
        // per stated blind spots above).
        let depth = 0
        while (i < masked.length) {
          const c = masked[i]
          if (c === "<" || c === "(" || c === "[") depth++
          else if (c === ">" || c === ")" || c === "]") depth = Math.max(0, depth - 1)
          else if (depth === 0 && (c === "{" || c === ";")) break
          i++
        }
      }
      if (masked[i] !== "{") { out.push({ name, file: relPath, line: lineOf(src, m.index), kind: "function", bodyRaw: null }); continue }
      const braceClose = matchBracket(masked, i, "{", "}")
      const bodyRaw = braceClose === -1 ? null : src.slice(i + 1, braceClose)
      out.push({ name, file: relPath, line: lineOf(src, m.index), kind: "function", bodyRaw })
    }
  }

  // `const NAME = (...) => { ... }` and `const NAME = function (...) { ... }`
  {
    const re = new RegExp(`\\bconst\\s+(${IDENT})\\s*(?::[^=]+)?=\\s*(async\\s+)?(\\(|function\\b)`, "g")
    let m: RegExpExecArray | null
    while ((m = re.exec(masked))) {
      const name = m[1]
      const declLine = lineOf(src, m.index)
      const startedWithFunctionKw = m[3] === "function"
      let parenOpen: number
      if (startedWithFunctionKw) {
        const fnIdx = masked.indexOf("(", m.index + m[0].length - 1)
        if (fnIdx === -1) continue
        parenOpen = fnIdx
      } else {
        parenOpen = m.index + m[0].length - 1
      }
      const parenClose = matchBracket(masked, parenOpen, "(", ")")
      if (parenClose === -1) continue
      let i = skipWs(masked, parenClose + 1)
      if (!startedWithFunctionKw) {
        // optional `: ReturnType` then must reach `=>`
        if (masked[i] === ":") {
          let depth = 0
          while (i < masked.length) {
            const c = masked[i]
            if (c === "<" || c === "(" || c === "[") depth++
            else if (c === ">" || c === ")" || c === "]") depth = Math.max(0, depth - 1)
            else if (depth === 0 && c === "=" && masked[i + 1] === ">") break
            i++
          }
        }
        if (masked[i] !== "=" || masked[i + 1] !== ">") continue // not actually an arrow
        i = skipWs(masked, i + 2)
      }
      if (masked[i] !== "{") {
        // expression-bodied arrow — record name, no body to hash
        out.push({ name, file: relPath, line: declLine, kind: "arrow", bodyRaw: null })
        continue
      }
      const braceClose = matchBracket(masked, i, "{", "}")
      const bodyRaw = braceClose === -1 ? null : src.slice(i + 1, braceClose)
      out.push({ name, file: relPath, line: declLine, kind: startedWithFunctionKw ? "func-expr" : "arrow", bodyRaw })
    }
  }

  return out
}

/** Comments stripped, all whitespace runs collapsed to one space, trimmed. Whitespace +
 *  comments ONLY — CLAUDE.md task scope explicitly stops short of identifier renaming. */
function normalizeBody(bodyRaw: string): string {
  return stripComments(bodyRaw).replace(/\s+/g, " ").trim()
}

function countLines(s: string): number {
  return s.split("\n").length
}

// ── grouping ─────────────────────────────────────────────────────────────────────────────

interface CensusResult {
  sameName: Map<string, Decl[]> // name -> decls across >=2 distinct files
  sameBody: Map<string, Decl[]> // normalized body -> decls across >=2 distinct files
}

function census(decls: Decl[]): CensusResult {
  const byName = new Map<string, Decl[]>()
  for (const d of decls) {
    if (!byName.has(d.name)) byName.set(d.name, [])
    byName.get(d.name)!.push(d)
  }
  const sameName = new Map<string, Decl[]>()
  for (const [name, ds] of byName) {
    const files = new Set(ds.map(d => d.file))
    if (files.size >= 2) sameName.set(name, ds)
  }

  const byBody = new Map<string, Decl[]>()
  for (const d of decls) {
    if (!d.bodyRaw) continue
    if (countLines(d.bodyRaw) < 6) continue
    const norm = normalizeBody(d.bodyRaw)
    if (norm.length === 0) continue
    if (!byBody.has(norm)) byBody.set(norm, [])
    byBody.get(norm)!.push(d)
  }
  const sameBody = new Map<string, Decl[]>()
  for (const [norm, ds] of byBody) {
    const files = new Set(ds.map(d => d.file))
    if (files.size >= 2) sameBody.set(norm, ds)
  }

  return { sameName, sameBody }
}

// ── positive control (CLAUDE.md §2) ─────────────────────────────────────────────────────

function selfTest() {
  const fixtureA = `
export function plantedDup(a: number, b: number): number {
  // six-plus-line planted body, deliberately padded so it clears the >=6 line floor
  const x = a + b
  const y = a - b
  const z = x * y
  return z + 1
}
function plantedSameNameOnly(x: number) { return x + 1 }
`
  const fixtureB = `
function differentNameSameBody(a: number, b: number): number {
  // identical body to plantedDup above, under a DIFFERENT name — the copy-paste case
  const x = a + b
  const y = a - b
  const z = x * y
  return z + 1
}
const plantedSameNameOnly = (x: number) => x + 1
`
  const declsA = findDeclarations(fixtureA, "fixture/a.ts")
  const declsB = findDeclarations(fixtureB, "fixture/b.ts")
  const { sameName, sameBody } = census([...declsA, ...declsB])

  const nameHit = sameName.has("plantedSameNameOnly")
  const bodyHit = [...sameBody.values()].some(
    ds => ds.some(d => d.name === "plantedDup") && ds.some(d => d.name === "differentNameSameBody"),
  )
  if (!nameHit || !bodyHit) {
    console.error(
      `duplicate-function-census: POSITIVE CONTROL FAILED (nameHit=${nameHit} bodyHit=${bodyHit}) — ` +
      `the scanner cannot see planted duplicates it was written to catch. Fix before trusting any 0.`,
    )
    process.exit(1)
  }
}

// ── main ─────────────────────────────────────────────────────────────────────────────────

function main() {
  selfTest()

  const listMode = process.argv.includes("--list")

  const files = globSync("{app,lib,remotion,hooks}/**/*.{ts,tsx}", {
    cwd: ROOT,
    ignore: ["**/node_modules/**", "**/.claude/**", "**/*.test.ts", "**/*.test.tsx", "**/*.d.ts"],
  })

  const allDecls: Decl[] = []
  let readErrors = 0
  for (const rel of files) {
    let raw: string
    try {
      raw = readFileSync(`${ROOT}/${rel}`, "utf8")
    } catch {
      readErrors++
      continue
    }
    allDecls.push(...findDeclarations(raw, rel))
  }

  const { sameName, sameBody } = census(allDecls)

  if (listMode) {
    console.log(`\n=== SAME NAME (declared in >=2 files): ${sameName.size} names ===`)
    for (const [name, ds] of [...sameName.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`  ${name}`)
      for (const d of ds.sort((a, b) => a.file.localeCompare(b.file))) {
        console.log(`    ${d.file}:${d.line}  [${d.kind}]${d.bodyRaw ? "" : " (no block body)"}`)
      }
      const arities = new Set(ds.map(d => d.kind))
      const hint = ds.length === 2 && arities.size === 1
        ? "verdict hint: same name, same declaration shape — inspect for true duplicate"
        : "verdict hint: mixed shapes/kinds or >2 sites — check for overload vs duplicate"
      console.log(`    ${hint}`)
    }
    console.log(`\n=== SAME BODY (>=6 lines, byte-identical after comment+whitespace normalization): ${sameBody.size} groups ===`)
    for (const [norm, ds] of sameBody) {
      const names = [...new Set(ds.map(d => d.name))]
      console.log(`  [${ds.length} sites, names: ${names.join(", ")}]`)
      for (const d of ds.sort((a, b) => a.file.localeCompare(b.file))) {
        console.log(`    ${d.file}:${d.line}  ${d.name}`)
      }
      const hint = names.length > 1
        ? "verdict hint: SAME BODY, DIFFERENT NAME — copy-paste, not an overload; strong merge candidate"
        : "verdict hint: same name AND same body across files — near-certain true duplicate"
      console.log(`    ${hint}`)
    }
    console.log(
      `\nfiles scanned: ${files.length} (read errors: ${readErrors}) | declarations found: ${allDecls.length} | ` +
      `same-name groups: ${sameName.size} | same-body groups: ${sameBody.size}\n`,
    )
  } else {
    console.log(
      `duplicate-function-census: files=${files.length} declarations=${allDecls.length} ` +
      `sameNameGroups=${sameName.size} sameBodyGroups=${sameBody.size} (run with --list for detail)`,
    )
  }

  process.exit(0)
}

main()
