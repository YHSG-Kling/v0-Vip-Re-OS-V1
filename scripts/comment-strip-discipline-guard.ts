#!/usr/bin/env tsx
/**
 * scripts/comment-strip-discipline-guard.ts   (npm run test:comment-strip-discipline)
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY ANALYZER IN scripts/ REMOVES COMMENTS THROUGH scripts/strip-comments.ts,
 * OR THIS GOES RED.
 *
 * WHY THIS GUARD EXISTS
 *
 * scripts/strip-comments.ts documents the defect and what it cost. The short form:
 * an analyzer that removes comments with
 *
 *     src.replace(BLOCK_COMMENT_REGEX, "").replace(LINE_COMMENT_REGEX, "")
 *
 * cannot see the code it is judging. A slash-star sequence appearing inside a line
 * comment — or inside a STRING, which is how it actually bites here — opens a block
 * comment for the first regex, which then runs to the next star-slash anywhere below
 * and deletes every line in between. Nothing throws. The analyzer reports on what is
 * left, confidently and wrongly.
 *
 * Measured on this tree at conversion time, the worst single instance: the string
 * `"…42 legacy scripts/*.sql files…"` in lib/kernel/manager-registry.ts:453 opened a
 * phantom block comment that swallowed 359,572 characters — lines 453 through 619 —
 * from every analyzer built on that idiom. Ninety-two files in scripts/ used it.
 *
 * Swapping the two regexes is not a fix; it trades the bug for its mirror. Neither is
 * "be careful": three separate variants of the same class were already in the tree —
 *   · block-comments-first (the classic), including copies assembled from
 *     String.fromCharCode so the regex never appeared literally and no grep found it;
 *   · a per-line scanner that tracked quote state, where an apostrophe in ordinary
 *     prose ("the script's agent") flipped it into "inside a string" so the `//` that
 *     actually opened the comment went unrecognised;
 *   · anchored line-comment regexes that only ever saw a comment starting a line, so
 *     every TRAILING comment survived into the "comment-stripped" text.
 *
 * So the rule is structural rather than advisory: in scripts/, comment removal happens
 * in exactly one module. This guard fails when any other file does it by hand.
 *
 * ── HOW THIS PROOF IS BUILT ─────────────────────────────────────────────────
 * A detector that is broken and a tree that is clean both report zero offenders, and
 * only one of those is good news. This guard therefore refuses to report a pass on
 * the strength of "found nothing":
 *
 *   POSITIVE CONTROL — the detector is run against fixtures of every known variant
 *     and MUST flag each one, and against a correct file it must NOT flag. If the
 *     detector has stopped detecting, this guard goes red before it ever looks at
 *     the tree.
 *
 *   NEGATIVE CONTROL — the block-first idiom is written into a real file inside
 *     scripts/, the WHOLE directory scan is re-run, and it must go red. The file is
 *     then restored and verified by sha256. This proves the end-to-end scan reacts,
 *     not merely that a regex matches a string.
 *
 * Run: npx tsx scripts/comment-strip-discipline-guard.ts
 */
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { stripComments } from "./strip-comments"

const SCRIPTS = join(process.cwd(), "scripts")
const CANONICAL = "strip-comments.ts"

// Built, never typed, so this guard can scan its own directory without its own
// examples registering as offenders.
const SLASH = String.fromCharCode(47)
const STAR = String.fromCharCode(42)

type Offence = { file: string; line: number; rule: string; text: string }

// ─────────────────────────────────────────────────────────────────────────────
// ALLOWLIST
//
// Each entry names a file, a substring that must still be present, and why it is
// not a comment stripper. A stale entry — one whose `must` no longer appears — is
// itself a failure, so the allowlist cannot quietly outlive the code it excuses.
// ─────────────────────────────────────────────────────────────────────────────
const ALLOW: { file: string; must: string; why: string }[] = [
  {
    file: "mail-unsubscribe-simulator.ts",
    must: "replace(/^https?:\\" + SLASH + "\\" + SLASH + "/",
    why: "strips a URL scheme, not a comment — the two slashes belong to the address",
  },
  {
    file: "newsletter-template-create-simulator.ts",
    must: "return null \\" + SLASH + "\\" + SLASH + " prose, not a blueprint",
    why: "a negative-control MUTATION that writes a comment into a file on purpose",
  },
  {
    file: "credential-cascade-refusal-simulator.ts",
    must: "replace(/\\n\\s*\\" + SLASH + "\\" + SLASH + "\\s*/g",
    why: "joins comment prose into one line in order to READ it; the comment is the subject",
  },
  {
    file: "team-lead-split-simulator.ts",
    must: "replace(/^[ \\t]*\\" + SLASH + "\\" + SLASH + "[ \\t]?/gm",
    why: "removes the comment MARKER to read the prose behind it; the comment is the subject",
  },
]

const allowKey = (f: string, text: string) =>
  ALLOW.some((a) => a.file === f && text.includes(a.must.slice(0, 24)))

// ─────────────────────────────────────────────────────────────────────────────
// QUARANTINE — known offenders NOT yet converted, and why.
//
// Different from ALLOW: these ARE the defect. They are listed only so the guard can
// be wired into `npm run guard` today without going red on debt it was not permitted
// to pay. The list is bounded and cannot grow silently — anything not named here
// still fails, and a file listed here that has since been CONVERTED also fails, so
// the list shrinks to empty and then deletes itself.
// ─────────────────────────────────────────────────────────────────────────────
// EMPTY, and that is the point: `one-cma-engine-simulator.ts` was the only entry and
// it was converted on integration (it now imports `stripComments` from strip-comments.ts).
// The list deleting itself is the guard's success condition, not a gap in it — an
// unconverted offender that is not named here still fails, so empty means clean.
const QUARANTINE: { file: string; why: string }[] = []

// ─────────────────────────────────────────────────────────────────────────────
// THE DETECTOR
// ─────────────────────────────────────────────────────────────────────────────

const BLOCK_DELIM = "\\" + SLASH + "\\" + STAR // how `/*` is spelled inside a regex literal
const LINE_DELIM = "\\" + SLASH + "\\" + SLASH // how `//` is spelled inside a regex literal

/** Every rule this guard enforces. Each one must have a fixture that isolates it. */
const ALL_RULES = [
  "regex removes BLOCK comments",
  "regex removes LINE comments",
  "comment regex ASSEMBLED from char codes (grep-invisible)",
  "line-comment filter by startsWith",
  "hand-rolled comment SCANNER (re-implements strip-comments.ts)",
] as const

/**
 * Offences in ONE file's source. Runs on comment-stripped text, so a file that
 * merely DESCRIBES the defect (this one, and strip-comments.ts) is not an offender.
 */
export function detect(file: string, rawSrc: string): Offence[] {
  const src = stripComments(rawSrc)
  const out: Offence[] = []
  const lineOf = (i: number) => src.slice(0, i).split("\n").length
  const add = (i: number, rule: string, text: string) => {
    if (allowKey(file, text)) return
    out.push({ file, line: lineOf(i), rule, text: text.replace(/\s+/g, " ").slice(0, 92) })
  }

  // ── RULE 1 — a .replace() whose pattern is comment syntax ──────────────────
  const reReplace = /\.replace\(\s*(\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*)/g
  for (const m of src.matchAll(reReplace)) {
    const pat = m[1]
    if (pat.includes(BLOCK_DELIM)) add(m.index!, "regex removes BLOCK comments", m[0])
    else if (pat.includes(LINE_DELIM)) add(m.index!, "regex removes LINE comments", m[0])
  }

  // ── RULE 2 — comment delimiters assembled from char codes ──────────────────
  // The block-first idiom hid here once already: built out of String.fromCharCode,
  // it was invisible to every grep for the regex while behaving identically.
  const codeBuilt =
    /fromCharCode\(\s*47\s*\)/.test(src) && /fromCharCode\(\s*42\s*\)/.test(src)
  if (codeBuilt && /new RegExp\(/.test(src)) {
    for (const m of src.matchAll(/new RegExp\([^)\n]*(SLASH|STAR)[^)\n]*\)/g)) {
      add(m.index!, "comment regex ASSEMBLED from char codes (grep-invisible)", m[0])
    }
  }

  // ── RULE 3 — whole-line comment filters ────────────────────────────────────
  // `.filter((l) => !l.trim().startsWith("//"))` drops only comments that BEGIN a
  // line; every trailing comment survives into text the caller believes is code.
  for (const m of src.matchAll(/startsWith\(\s*["']\/\/["']\s*\)/g)) {
    const around = src.slice(Math.max(0, m.index! - 120), m.index! + 60)
    if (/\.(filter|map|some|every)\(/.test(around)) {
      add(m.index!, "line-comment filter by startsWith", around.slice(-90))
    }
  }

  // ── RULE 4 — a hand-rolled character scanner ───────────────────────────────
  // Re-implementing the scanner re-implements its bugs. The two that were live here:
  // an apostrophe read as a string opener, and a canStartRegex that let `)` open a
  // regex literal — each desynchronises the scan and takes real code with it.
  const tracksSlashStar =
    /[=!]==\s*(?:SLASH|["']\/["'])/.test(src) && /[=!]==\s*(?:STAR|["']\*["'])/.test(src)
  const tracksQuoteState = /\binS\b|\binD\b|\binB\b|inString|inBlockComment/.test(src)
  if (tracksSlashStar && tracksQuoteState) {
    const at = src.search(/[=!]==\s*(?:STAR|["']\*["'])/)
    add(at < 0 ? 0 : at, "hand-rolled comment SCANNER (re-implements strip-comments.ts)", "char-by-char comment scan")
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// SCAN
// ─────────────────────────────────────────────────────────────────────────────
function scanTree(): Offence[] {
  const out: Offence[] = []
  for (const f of readdirSync(SCRIPTS).sort()) {
    if (!f.endsWith(".ts") || f === CANONICAL) continue
    out.push(...detect(f, readFileSync(join(SCRIPTS, f), "utf8")))
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// POSITIVE CONTROL — the detector still detects
// ─────────────────────────────────────────────────────────────────────────────
const OPEN = SLASH + STAR
const CLOSE = STAR + SLASH
const LINE = SLASH + SLASH

/**
 * Each fixture names the RULE it must trigger, not merely that something fired.
 *
 * The first version of this control only asserted "flagged / not flagged", and it
 * passed with the block-comment rule deliberately disabled: the classic pair contains
 * a line-comment regex too, so the line rule covered for the dead one. A control that
 * a broken detector can satisfy is not a control. Every rule now has at least one
 * fixture that ISOLATES it, and the expected rule must be the one that fires.
 */
const FIXTURES: { name: string; src: string; mustFlag: boolean; rule?: string }[] = [
  {
    name: "a block-comment strip on its own (isolates the BLOCK rule)",
    src: `const c = src.replace(/\\${SLASH}\\${STAR}[\\s\\S]*?\\${STAR}\\${SLASH}/g, "")`,
    mustFlag: true,
    rule: "regex removes BLOCK comments",
  },
  {
    name: "the classic block-comments-first pair",
    src: `const code = (s) => s.replace(/\\${SLASH}\\${STAR}[\\s\\S]*?\\${STAR}\\${SLASH}/g, "").replace(/^[ \\t]*\\${SLASH}\\${SLASH}.*$/gm, "")`,
    mustFlag: true,
    rule: "regex removes BLOCK comments",
  },
  {
    name: "the mirror (line comments first) — same class, other direction",
    src: `const code = (s) => s.replace(/^[ \\t]*\\${SLASH}\\${SLASH}.*$/gm, "").replace(/\\${SLASH}\\${STAR}[\\s\\S]*?\\${STAR}\\${SLASH}/g, "")`,
    mustFlag: true,
  },
  {
    name: "a lone trailing-line-comment strip (isolates the LINE rule)",
    src: `const c = src.replace(/\\${SLASH}\\${SLASH}[^\\n]*/g, "")`,
    mustFlag: true,
    rule: "regex removes LINE comments",
  },
  {
    name: "the char-code-assembled variant that no grep finds",
    // Assembled here too, rather than written out: a fixture spelling the offence
    // literally would make this guard an offender in its own directory scan.
    src: [
      `const SLASH = String.fromCharCode(47)`,
      `const STAR = String.fromCharCode(42)`,
      `const BLOCK = ${["new", "RegExp"].join(" ")}(SLASH + "\\\\" + STAR + "[\\\\s\\\\S]*?\\\\" + STAR + SLASH, "g")`,
    ].join("\n"),
    mustFlag: true,
    rule: "comment regex ASSEMBLED from char codes (grep-invisible)",
  },
  {
    name: "the whole-line comment filter",
    src: `const c = s.split("\\n").filter((l) => !l.trim().startsWith("${LINE}")).join("\\n")`,
    mustFlag: true,
    rule: "line-comment filter by startsWith",
  },
  {
    name: "a hand-rolled char scanner tracking quotes",
    src: [
      `let inS = false, inD = false`,
      `if (ch === "${SLASH}" && next === "${STAR}") { skip() }`,
      `if (c === "'") inS = !inS`,
    ].join("\n"),
    mustFlag: true,
    rule: "hand-rolled comment SCANNER (re-implements strip-comments.ts)",
  },
  {
    name: "the correct thing — routed through strip-comments.ts",
    src: [`import { stripComments } from "./strip-comments"`, `const code = (p) => stripComments(raw(p))`].join("\n"),
    mustFlag: false,
  },
  {
    name: "prose DESCRIBING the idiom must not be an offence",
    src: `${OPEN} we used to call .replace(/\\${SLASH}\\${STAR}...\\${STAR}\\${SLASH}/g, "") here ${CLOSE}\nexport const x = 1`,
    mustFlag: false,
  },
]

function positiveControl(): string[] {
  const problems: string[] = []
  for (const fx of FIXTURES) {
    const hits = detect("fixture.ts", fx.src)
    const flagged = hits.length > 0
    if (flagged !== fx.mustFlag) {
      problems.push(
        `${fx.mustFlag ? "MISSED" : "FALSE POSITIVE"}: ${fx.name} — detector said ${flagged ? "offence" : "clean"}`,
      )
      continue
    }
    // A fixture caught by the WRONG rule proves nothing about the rule it was
    // written for — that is exactly how a dead rule hid behind a live one here.
    if (fx.rule && !hits.some((h) => h.rule === fx.rule)) {
      problems.push(
        `WRONG RULE: ${fx.name} — expected "${fx.rule}", got ${hits.map((h) => `"${h.rule}"`).join(", ")}`,
      )
    }
  }
  const covered = new Set(FIXTURES.map((f) => f.rule).filter(Boolean))
  for (const r of ALL_RULES) {
    if (!covered.has(r)) problems.push(`UNCOVERED RULE: "${r}" has no fixture that isolates it`)
  }
  return problems
}

// ─────────────────────────────────────────────────────────────────────────────
// NEGATIVE CONTROL — re-introducing the idiom into scripts/ turns the scan red
// ─────────────────────────────────────────────────────────────────────────────
const PROBE = join(SCRIPTS, "comment-strip-negative-control.probe.ts")

function negativeControl(baseline: number): string | null {
  const body = [
    `${SLASH}${SLASH} Written by comment-strip-discipline-guard.ts as its negative control.`,
    `${SLASH}${SLASH} If you are reading this on disk, the guard died mid-run — delete it.`,
    `export const code = (s: string) =>`,
    `  s.replace(/\\${SLASH}\\${STAR}[\\s\\S]*?\\${STAR}\\${SLASH}/g, "").replace(/^[ \\t]*\\${SLASH}\\${SLASH}.*$/gm, "")`,
    "",
  ].join("\n")
  writeFileSync(PROBE, body)
  const sha = createHash("sha256").update(body).digest("hex")
  try {
    const after = scanTree()
    const hit = after.filter((o) => o.file === "comment-strip-negative-control.probe.ts")
    if (hit.length === 0) {
      return "the block-first idiom was written into scripts/ and the SCAN DID NOT GO RED — this guard cannot be trusted"
    }
    if (after.length !== baseline + hit.length) {
      return `scan moved unexpectedly: ${baseline} → ${after.length} with ${hit.length} probe offences`
    }
    return null
  } finally {
    if (existsSync(PROBE)) {
      const onDisk = createHash("sha256").update(readFileSync(PROBE)).digest("hex")
      unlinkSync(PROBE)
      if (onDisk !== sha) return "the probe file changed underneath the control — result not trustworthy"
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" Comment-strip discipline — one scanner, or red")
  console.log("══════════════════════════════════════════════════════════════")

  if (existsSync(PROBE)) unlinkSync(PROBE) // left over from a killed run

  console.log("\n[1 · positive control — the detector still detects]")
  const broken = positiveControl()
  for (const fx of FIXTURES) console.log(`  · ${fx.mustFlag ? "must flag  " : "must pass  "} ${fx.name}`)
  if (broken.length) {
    console.log("\n  ✗ THE DETECTOR IS BROKEN — a clean report here would mean nothing:")
    for (const b of broken) console.log("    - " + b)
    console.log("\n ❌ COMMENT_STRIP_DISCIPLINE_FAIL (detector)")
    process.exit(1)
  }
  console.log(`  ✓ all ${FIXTURES.length} control fixtures classified correctly`)

  console.log("\n[2 · the tree]")
  const offences = scanTree()

  console.log("\n[3 · negative control — writing the idiom back turns the scan red]")
  const ncProblem = negativeControl(offences.length)
  if (ncProblem) {
    console.log("  ✗ " + ncProblem)
    console.log("\n ❌ COMMENT_STRIP_DISCIPLINE_FAIL (negative control)")
    process.exit(1)
  }
  console.log("  ✓ the idiom written into scripts/ was caught, and the probe was removed")

  const scanned = readdirSync(SCRIPTS).filter((f) => f.endsWith(".ts") && f !== CANONICAL).length
  console.log(`\n  ${scanned} files scanned, ${ALLOW.length} allowlisted exceptions`)

  const stale = ALLOW.filter((a) => {
    const p = join(SCRIPTS, a.file)
    return !existsSync(p) || !readFileSync(p, "utf8").includes(a.must)
  })
  if (stale.length) {
    console.log("\n  ✗ STALE ALLOWLIST — these exceptions no longer describe the code they excuse:")
    for (const s of stale) console.log(`    - ${s.file}: expected ${JSON.stringify(s.must)}`)
    console.log("\n ❌ COMMENT_STRIP_DISCIPLINE_FAIL (stale allowlist)")
    process.exit(1)
  }
  console.log(`  ✓ every allowlisted exception is still present and still accurate`)

  // Quarantined files are still offences; they are just not NEW ones.
  const quarantined = new Set(QUARANTINE.map((q) => q.file))
  const held = offences.filter((o) => quarantined.has(o.file))
  const live = offences.filter((o) => !quarantined.has(o.file))

  const cleared = QUARANTINE.filter((q) => !held.some((h) => h.file === q.file))
  if (cleared.length) {
    console.log("\n  ✗ QUARANTINE IS STALE — these files no longer offend, so remove them from the list:")
    for (const c of cleared) console.log(`    - ${c.file}`)
    console.log("\n ❌ COMMENT_STRIP_DISCIPLINE_FAIL (stale quarantine)")
    process.exit(1)
  }
  if (held.length) {
    const files = new Set(held.map((h) => h.file)).size
    console.log(`\n  ⚠ ${held.length} known offence(s) across ${files} file(s) held in quarantine — debt, not health:`)
    for (const q of QUARANTINE) console.log(`    - scripts/${q.file}: ${q.why}`)
  }

  if (live.length) {
    console.log(`\n  ✗ ${live.length} file(s) remove comments without scripts/strip-comments.ts:\n`)
    for (const o of live) console.log(`    scripts/${o.file}:${o.line}  [${o.rule}]\n      ${o.text}`)
    console.log("\n  Fix: import { stripComments } from \"./strip-comments\" — or blankComments if the")
    console.log("  analyzer computes positions from match indices and needs character offsets to hold.")
    console.log("\n ❌ COMMENT_STRIP_DISCIPLINE_FAIL")
    process.exit(1)
  }

  console.log("\n ✅ COMMENT_STRIP_DISCIPLINE_PASS — every analyzer in scripts/ removes comments")
  console.log("    through scripts/strip-comments.ts, and the detector proved it can still fail.")
}

main()
