#!/usr/bin/env tsx
/**
 * scripts/comment-strip-discipline-guard.ts   (npm run test:comment-strip-discipline)
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY ANALYZER IN scripts/ REMOVES COMMENTS — AND MASKS STRING AND TEMPLATE
 * LITERALS — THROUGH scripts/strip-comments.ts, OR THIS GOES RED.
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
 * ── AND THEN A FOURTH VARIANT, WHICH THIS GUARD REPORTED AS CLEAN ───────────
 * The first version of this guard only knew how to recognise a REGEX. Twenty-two
 * analyzers in this directory removed comments with a hand-rolled CHARACTER SCANNER
 * instead, and it passed the tree at zero offenders while they sat in front of it:
 * its scanner rule demanded a state variable literally named inS/inD/inString/
 * inBlockComment, and theirs were called mask, mode, lastSig, comment. It also read
 * only the top level of scripts/, so anything one directory down was never opened.
 *
 * Measured after those twenty-two were converted, against the files they actually
 * judge: their scanners disagreed with strip-comments.ts on 152 of 4,515 files under
 * lib/ app/ services/ — 68,637 characters of comment PROSE handed to the analyzer as
 * code, and 1,399 characters of LIVE CODE blanked out of its view. Eight of the
 * twenty-two were demonstrably reading a corrupted version of a file they assert on.
 *
 * Rules 5-7 and the recursive scan exist because of that. They are keyed to the SHAPE
 * of a hand-rolled scan — comparing a character against a slash and a star, hunting a
 * delimiter with indexOf/split, hoisting the regex into a variable, filtering trimmed
 * lines — and not to the names inside it, which are exactly what let the class hide.
 *
 * ── AND THEN A FIFTH VARIANT, WHICH THIS GUARD WAS NOT EVEN LOOKING FOR ─────
 * (lane K6, 2026-08-29)
 *
 * Comments are only half of what an analyzer has to remove before it can judge
 * code. The other half is STRING AND TEMPLATE CONTENTS — an export name inside a
 * narrative string is documentation, not wiring — and scripts/strip-comments.ts
 * grew `blankStrings()` for exactly that, with a header dissecting the idiom every
 * analyzer had independently reinvented:
 *
 *     .replace(TEMPLATE_PAIRER, "").replace(DOUBLE_PAIRER, "").replace(SINGLE_PAIRER, "")
 *
 * That is the block-comments-first defect wearing its second hat, and it fails the
 * same way: the backtick pass pairs LEFT TO RIGHT and cannot see that a backtick is
 * TEXT inside a quoted string. An ODD number of such backticks before any point
 * leaves the pairer inside a phantom template from there on, and everything to the
 * next backtick — code included — is masked away. Ordering the three passes
 * differently only moves the bug, for the identical reason it did for comments.
 *
 * THIS GUARD POLICED COMMENT STRIPPING ONLY, so the population it would have
 * caught sat in front of it and it reported the tree clean. Three analyzers were
 * hand-rolling the pairer, and one of them was scripts/orphan-export-guard.ts —
 * the instrument that produces this repo's orphan ledger. Measured at conversion,
 * on the shape every model-response parser here carries:
 *
 *     if (s.startsWith("```json")) s = s.slice(7)   ← nine backticks of string
 *     if (s.startsWith("```"))     s = s.slice(3)     CONTENT, an ODD count
 *     if (s.endsWith("```"))       s = s.slice(0, -3)
 *
 * In lib/agents/generate-client-message.ts that swallowed 917 characters including
 * `export async function generateClientMessage`, and the same shape hid four more
 * exported functions in lib/ai/generate.ts and lib/video/avatar-explainer.ts. It
 * also blanked the `await import(...)` call sites in
 * app/api/internal/voice-command/route.ts, so five live, wired capabilities were
 * reported as referenced by nothing. Across the corpus the retired masker and
 * blankStrings disagreed on 1,693 of 4,641 files, in BOTH directions at once —
 * blind to real identifiers, and leaking quoted prose back in as code.
 *
 * RULES 8 and 9 exist because of that. They are keyed to the SHAPE of a quote
 * pairer — a regex that opens on a quote, closes on the same quote, and runs to it
 * through a negated class and an escape alternation — and not to what the function
 * around it is called.
 *
 * STATED BLIND SPOT (§2 — publish blind spots beside the number): a hand-rolled
 * CHARACTER SCANNER that masks literals without ever writing a regex is caught by
 * RULE 4 only if it also compares a character to a slash and a star, i.e. only if
 * it strips comments too. A pure literal-masking scanner is not currently
 * detected. No such file exists in scripts/ today; that is measured, not assumed.
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

// The scanners themselves. strip-comments.ts is the one for TypeScript;
// strip-sql-comments.ts is its SQL sibling, and SQL's comment syntax (`--`,
// dollar-quoting) is not something strip-comments.ts implements, so it has to
// own a scan of its own. Everything else in scripts/ routes through one of them.
const CANONICAL = new Set(["strip-comments.ts", "strip-sql-comments.ts"])

// Built, never typed, so this guard can scan its own directory without its own
// examples registering as offenders.
const SLASH = String.fromCharCode(47)
const STAR = String.fromCharCode(42)
// The three quote delimiters, built the same way and for the same reason: RULES 8
// and 9 below hunt regexes that pair these, and a guard that spells its own
// offence literally becomes an offender in its own directory scan.
const BTICK = String.fromCharCode(96)
const DQUOTE = String.fromCharCode(34)
const SQUOTE = String.fromCharCode(39)

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
  {
    file: "content-contract-guard.ts",
    must: SLASH + "\\" + SLASH + "\\" + SLASH + "[^\\n]*[A-Za-z]{6}" + SLASH,
    why:
      "asserts that NO comment survived its own code() — the pattern is a DETECTOR " +
      "run over already-stripped text, and the comment is the thing being looked for",
  },
  {
    file: "deletion-audit-guard.ts",
    must: "([\\w\\-./[\\]]+" + "\\" + SLASH + ")\\r?\\n",
    why:
      "joinWrappedPaths fuses a survivor path wrapped across two comment lines so " +
      "PATH_RE can see it whole; it runs ONLY on tombstone-block text that " +
      "extractBlocks already reduced to comment lines — the comment is the subject " +
      "being read (the credential-cascade / team-lead-split class), not source code " +
      "where a desynchronising quote could shift the parse",
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
const BLOCK_CLOSE = "\\" + STAR + "\\" + SLASH // …and how the closer is spelled
const LINE_DELIM = "\\" + SLASH + "\\" + SLASH // how `//` is spelled inside a regex literal

/** Every rule this guard enforces. Each one must have a fixture that isolates it. */
const ALL_RULES = [
  "regex removes BLOCK comments",
  "regex removes LINE comments",
  "comment regex ASSEMBLED from char codes (grep-invisible)",
  "line-comment filter by startsWith",
  "hand-rolled comment SCANNER (re-implements strip-comments.ts)",
  "comment DELIMITER searched by indexOf/split (hand-rolled scanner)",
  "comment regex HOISTED into a variable",
  "line-comment filter inside a LOOP (trimmed line startsWith)",
  "regex PAIRS QUOTES to mask literals (re-implements blankStrings)",
  "quote-pairing regex ASSEMBLED from char codes (grep-invisible)",
] as const

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE LAST THREE RULES ARE FOR — finding #250, and why the first five were
// not enough.
//
// The first version of this guard reported the tree CLEAN. It was not. Twenty-one
// analyzers in scripts/ removed comments with a hand-rolled CHARACTER SCANNER
// rather than a regex, and every one of them slipped through:
//
//   · RULE 1 only reads a regex literal written INLINE in `.replace(` — a scanner
//     has no regex at all, and a regex hoisted into a `const` is invisible to it.
//   · RULE 4 (as written) demanded a quote-state variable literally named
//     `inS` / `inD` / `inString` / `inBlockComment`. The twenty-one used `mask[]`,
//     `mode`, `lastSig`, `comment[]` — same scanner, different nouns, no match.
//
// So the population the guard existed to hold at zero sat in front of it, and it
// said zero. Measured after conversion: those scanners disagreed with
// strip-comments.ts on 152 of 4,515 files under lib/ app/ services/ — 68,637
// characters of COMMENT PROSE read as code, and 1,399 characters of LIVE CODE
// blanked away. One of the second kind, in lib/listing-presentation/prelisting-delivery.ts:173:
//
//     ON DISK   const portalUrl = `${(process.env.NEXT_PUBLIC_APP_URL ?? "https://app.example.com").replace(…)}…`
//     IT SAW    const portalUrl = `${(process.env.NEXT_PUBLIC_APP_URL ?? "https:
//
// The rules below are therefore about the SHAPE of a hand-rolled scanner rather
// than the names inside it: comparing a character to a slash and to a star,
// hunting a comment delimiter with indexOf/split, hoisting the regex into a
// variable, or filtering trimmed lines that start with a comment marker.
// ─────────────────────────────────────────────────────────────────────────────

// Every pattern below is BUILT from SLASH/STAR rather than typed, for the same
// reason the originals were: a guard that spells the offence literally becomes an
// offender in its own directory scan.
//
// They are assembled through `re()` rather than by naming the RegExp constructor
// on each line, because RULE 2 — which exists to catch a comment regex hidden
// behind String.fromCharCode — cannot tell a DETECTOR built that way from a
// STRIPPER built that way, and flagged all three of these. Routing the
// construction through one helper keeps RULE 2 at full strength (it still fires
// on any other file that does it) instead of weakening the rule to spare this
// file. The helper is the single audited place where it happens.
const re = (source: string, flags = "") => new RegExp(source, flags)

/** `ch === "/"` or `"/" !== ch` — a character compared against a comment slash. */
const SLASH_CHAR = re(`[=!]==\\s*(?:SLASH|["']${SLASH}["'])|["']${SLASH}["']\\s*[=!]==`)

/** `ch === "*"` or `"*" !== ch` — the other half of a block delimiter. */
const STAR_CHAR = re(`[=!]==\\s*(?:STAR|["']\\${STAR}["'])|["']\\${STAR}["']\\s*[=!]==`)

/** A comment delimiter hunted by string search rather than by scanning. */
const DELIM_SEARCH = re(
  `(?:indexOf|lastIndexOf|includes|startsWith|split)\\(\\s*["'](?:\\${STAR}${SLASH}|${SLASH}\\${STAR})["']`,
)

/** Any regex literal in the file, wherever it was written — hoisted or inline. */
const ANY_REGEX = re(
  `(?<![\\${STAR}${SLASH}\\w)\\]])${SLASH}(?:[^${SLASH}\\\\\\n[]|\\\\.|\\[(?:[^\\]\\\\]|\\\\.)*\\])+${SLASH}[gimsuy]*`,
  "g",
)

/**
 * A line-comment pattern in a SHAPE THAT EATS THE REST OF THE LINE.
 *
 * The shape test is what keeps `^https?:` + two slashes — a URL scheme, four of
 * which are already allowlisted here — out of this rule. A URL strip is followed
 * by a host pattern; a comment strip is followed by `.*` or a negated newline
 * class, because eating the line is the whole point of it.
 */
const LINE_EATER = re(`\\\\${SLASH}\\\\${SLASH}(?:\\.\\${STAR}|\\[\\^)`)

/** `l.trim().startsWith("//")` — the loop form of the whole-line filter. */
const TRIMMED_LINE_FILTER = re(`trim\\(\\)\\s*\\.\\s*startsWith\\(\\s*["']${SLASH}${SLASH}["']`)

/**
 * Is this regex literal a QUOTE PAIRER — the string/template half of the defect?
 *
 * Keyed to the shape, not to the surrounding function's name, because the name is
 * exactly what let the character-scanner class hide for a whole wave. A masker's
 * pattern IS the literal it wants to consume: it OPENS on a quote, CLOSES on the
 * same quote, and gets between them by running through a NEGATED CLASS naming that
 * quote plus an ESCAPE alternation. All four together, or it is some other regex
 * that merely happens to mention a quote.
 *
 * That conjunction is what keeps ordinary patterns out. `/"([A-Za-z_]+)"/` matches
 * a quoted word and has no negated class; `/[^"]+/` has the class but does not open
 * or close on the quote; `/"(?:x|y)"/` has neither escape nor class. None of them
 * is trying to consume an arbitrary literal, and none of them is flagged.
 *
 * Returns the quote character it pairs, or null.
 */
function literalPairer(lit: string): string | null {
  const m = /^\/([\s\S]*)\/[gimsuy]*$/.exec(lit)
  if (!m) return null
  const body = m[1]
  for (const q of [BTICK, DQUOTE, SQUOTE]) {
    // The same prefix peel RULE 6 does: a pattern may legitimately open with an
    // anchor, leading whitespace or a group before the delimiter it is really
    // about. A backslash before the quote is allowed too — authors write \" out of
    // habit even though a quote needs no escaping in a regex.
    const opens = re(`^(?:\\^|\\\\s\\*|\\(\\?:|\\()*\\\\?${q}`).test(body)
    const closes = re(`\\\\?${q}$`).test(body)
    const negated = body.includes(`[^${q}`) || body.includes(`[^\\${q}`)
    const escapes = body.includes("\\\\")
    if (opens && closes && negated && escapes) return q
  }
  return null
}

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
  //
  // The trigger is now the SHAPE of the scan — a character compared against a
  // slash and against a star — and no longer the NAMES of its state variables.
  // It used to also require a variable literally called inS/inD/inString/
  // inBlockComment, and twenty-one scanners in this directory simply called
  // theirs `mask`, `mode`, `lastSig` or `comment` and walked straight past.
  if (SLASH_CHAR.test(src) && STAR_CHAR.test(src)) {
    const at = src.search(STAR_CHAR)
    add(at < 0 ? 0 : at, "hand-rolled comment SCANNER (re-implements strip-comments.ts)", "char-by-char comment scan")
  }

  // ── RULE 5 — a comment delimiter hunted with indexOf/split ─────────────────
  // The other half of the same scanner: `const end = src.indexOf(CLOSE, i + 2)`
  // finds where a block comment ends without ever asking whether the OPEN it
  // matched was inside a string. Nothing legitimate searches for these two
  // characters as a pair; the canonical scanners are excluded by name.
  {
    const m = DELIM_SEARCH.exec(src)
    if (m) add(m.index, "comment DELIMITER searched by indexOf/split (hand-rolled scanner)", m[0])
  }

  // ── RULE 6 — the comment regex, hoisted out of the .replace() ──────────────
  // RULE 1 only reads a pattern written INLINE in `.replace(`. Lift the same
  // regex into a `const` one line earlier and RULE 1 goes blind, while the
  // behaviour — and the bug — is identical.
  //
  // A pattern that merely CONTAINS comment syntax is not a stripper: a proof that
  // looks for the literal snippet `} catch { /* enrichment only */ }`, or for a
  // doc-block header, has to spell those characters and is not removing anything.
  // The discriminator is that a STRIPPER's pattern IS the comment — the delimiter
  // is the first thing it matches (after an anchor), and for a block strip the
  // closing delimiter is in there too.
  for (const m of src.matchAll(ANY_REGEX)) {
    const inlineReplace = /\.replace\(\s*$/.test(src.slice(Math.max(0, m.index! - 40), m.index!))
    if (inlineReplace) continue // RULE 1 owns that one
    // Peel the prefixes a comment pattern is allowed to open with — a start
    // anchor, leading whitespace, a group — until the first thing it actually
    // matches is visible. `^\s*(?:BLOCK|LINE)*` (a directive-position scan that
    // skips leading comments) is the same class as `^[ \t]*LINE`, and one loop
    // reaches both.
    let head = m[0].replace(re(`^${SLASH}`), "")
    for (let peeled = true; peeled; ) {
      const before = head
      head = head.replace(/^(?:\^|\\s\*|\[ \\t\]\*|\(\?:|\()/, "")
      peeled = head !== before
    }
    const opensOnComment = head.startsWith(BLOCK_DELIM) || head.startsWith(LINE_DELIM)
    if (!opensOnComment) continue
    if (head.startsWith(BLOCK_DELIM) && m[0].includes(BLOCK_CLOSE)) {
      add(m.index!, "comment regex HOISTED into a variable", m[0])
    } else if (head.startsWith(LINE_DELIM) && LINE_EATER.test(m[0])) {
      add(m.index!, "comment regex HOISTED into a variable", m[0])
    }
  }

  // ── RULE 7 — the whole-line filter, written as a loop ──────────────────────
  // RULE 3 wants `.filter(` / `.map(` nearby. `for (const l of lines) { if
  // (l.trim().startsWith(LINE)) continue }` is the same defect with no such
  // call in sight — and it drops only comments that BEGIN a line, so every
  // trailing comment survives into text the caller believes is code.
  {
    const m = TRIMMED_LINE_FILTER.exec(src)
    if (m) {
      const around = src.slice(Math.max(0, m.index - 120), m.index + 60)
      if (!/\.(filter|map|some|every)\(/.test(around)) {
        add(m.index, "line-comment filter inside a LOOP (trimmed line startsWith)", around.slice(-90))
      }
    }
  }

  // ── RULE 8 — a hand-rolled STRING/TEMPLATE masker ──────────────────────────
  // The other half of what an analyzer must remove before it judges code, and the
  // half this guard could not see until 2026-08-29. Three analyzers were pairing
  // quotes with regexes, one of them the orphan ledger itself; the header above
  // records what it cost. Inline or hoisted makes no difference here — unlike
  // RULE 1/RULE 6 for comments, the pattern alone is conclusive, so both forms are
  // caught by the same sweep over every regex literal in the file.
  for (const m of src.matchAll(ANY_REGEX)) {
    if (literalPairer(m[0])) {
      add(m.index!, "regex PAIRS QUOTES to mask literals (re-implements blankStrings)", m[0])
    }
  }

  // ── RULE 9 — the same pairer, assembled so no grep finds it ────────────────
  // RULE 2's sibling, and it exists for the same recorded reason: the comment
  // idiom hid from every grep once by being built out of String.fromCharCode, and
  // a rule that any author can dodge by concatenation is not a rule. Shape-keyed
  // like RULE 8 — a regex CONSTRUCTED in a file that manufactures a quote
  // character, whose source carries a negated class — never keyed to what the
  // variables holding those characters are called.
  const quoteBuilt = /fromCharCode\(\s*(?:96|34|39)\s*\)/.test(src)
  if (quoteBuilt && /new RegExp\(/.test(src)) {
    for (const m of src.matchAll(/new RegExp\([^)\n]*\[\^[^)\n]*\)/g)) {
      add(m.index!, "quote-pairing regex ASSEMBLED from char codes (grep-invisible)", m[0])
    }
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// SCAN
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Every .ts under scripts/, RECURSIVELY. The first version read only the top
 * level, so a scanner one directory down (scripts/shared/, scripts/flow-tests/)
 * was outside the guard entirely — and "the guard is green" would have meant
 * "the guard did not look".
 */
function scriptFiles(dir = SCRIPTS, prefix = ""): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...scriptFiles(join(dir, e.name), rel))
    else if (e.name.endsWith(".ts") && !CANONICAL.has(e.name)) out.push(rel)
  }
  return out
}

function scanTree(): Offence[] {
  const out: Offence[] = []
  for (const f of scriptFiles()) {
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
    // The variant that was live in twenty-one files here and that the NAME-based
    // version of RULE 4 could not see: identical scan, state kept in a mask array.
    name: "the same scanner with its state in a mask[] — no inS/inD in sight",
    src: [
      `const mask = new Array<boolean>(s.length).fill(false)`,
      `if (c === "${SLASH}" && s[i + 1] === "${SLASH}") { while (s[i] !== "\\n") mask[i++] = true }`,
      `else if (c === "${SLASH}" && s[i + 1] === "${STAR}") { mask[i++] = true }`,
    ].join("\n"),
    mustFlag: true,
    rule: "hand-rolled comment SCANNER (re-implements strip-comments.ts)",
  },
  {
    name: "a block-comment END hunted with indexOf (isolates the DELIMITER rule)",
    src: `const end = src.indexOf("${STAR}${SLASH}", i + 2)`,
    mustFlag: true,
    rule: "comment DELIMITER searched by indexOf/split (hand-rolled scanner)",
  },
  {
    name: "the comment regex HOISTED into a const, applied a line later",
    src: [
      `const BLOCK = /\\${SLASH}\\${STAR}[\\s\\S]*?\\${STAR}\\${SLASH}/g`,
      `const code = (s: string) => s.replace(BLOCK, "")`,
    ].join("\n"),
    mustFlag: true,
    rule: "comment regex HOISTED into a variable",
  },
  {
    // The LINE half of the hoisted rule, paired with the URL fixture below:
    // both spell two slashes in a const, and only one of them eats the line.
    name: "a LINE-comment regex hoisted into a const",
    src: [
      `const LINE_RE = /\\${SLASH}\\${SLASH}[^\\n]*/g`,
      `const code = (s: string) => s.replace(LINE_RE, "")`,
    ].join("\n"),
    mustFlag: true,
    rule: "comment regex HOISTED into a variable",
  },
  {
    // The directive-position form: a regex that SKIPS leading comments to reach
    // `"use client"`. It opens with `^\s*(?:` before the delimiter, which is why
    // RULE 6 peels prefixes rather than testing the first character.
    name: "a regex that skips leading comments to find a directive",
    src: [
      `const first = (s: string) =>`,
      `  s.match(/^\\s*(?:\\${SLASH}\\${STAR}[\\s\\S]*?\\${STAR}\\${SLASH}\\s*)*["'](use client)["']/)`,
    ].join("\n"),
    mustFlag: true,
    rule: "comment regex HOISTED into a variable",
  },
  {
    name: "the whole-line filter written as a LOOP, with no .filter( anywhere",
    src: [
      `for (const l of src.split("\\n")) {`,
      `  if (l.trim().startsWith("${LINE}")) continue`,
      `  emit(l)`,
      `}`,
    ].join("\n"),
    mustFlag: true,
    rule: "line-comment filter inside a LOOP (trimmed line startsWith)",
  },
  {
    // The four allowlisted files strip a URL SCHEME. If the new hoisted-regex
    // rule cannot tell that from a comment strip, it re-flags all of them.
    name: "a URL-scheme strip is not a comment strip",
    src: [
      `const HOST = /^https?:\\${SLASH}\\${SLASH}(www\\.)?/i`,
      `const bare = (u: string) => u.replace(HOST, "")`,
    ].join("\n"),
    mustFlag: false,
  },
  {
    // RULE 8. Built by interpolation rather than typed, exactly as the comment
    // fixtures are: written out, this line would make the guard an offender in its
    // own directory scan. The interpolation happens at RUNTIME, so the fixture
    // STRING holds the real idiom while this file never does.
    name: "the template-literal pairer — the masker half of the same defect",
    src: `const mask = (s) => s.replace(/${BTICK}(?:\\\\.|[^${BTICK}\\\\])*${BTICK}/g, "")`,
    mustFlag: true,
    rule: "regex PAIRS QUOTES to mask literals (re-implements blankStrings)",
  },
  {
    name: "the same pairer for double quotes, HOISTED into a const",
    src: [
      `const DOUBLE = /${DQUOTE}(?:\\\\.|[^${DQUOTE}\\\\])*${DQUOTE}/g`,
      `const mask = (s: string) => s.replace(DOUBLE, "")`,
    ].join("\n"),
    mustFlag: true,
    rule: "regex PAIRS QUOTES to mask literals (re-implements blankStrings)",
  },
  {
    name: "…and for single quotes, so no one quote style is the only one policed",
    src: `const mask = (s) => s.replace(/${SQUOTE}(?:\\\\.|[^${SQUOTE}\\\\])*${SQUOTE}/g, "")`,
    mustFlag: true,
    rule: "regex PAIRS QUOTES to mask literals (re-implements blankStrings)",
  },
  {
    // RULE 9, the assembled form. Same construction trick RULE 2's fixture uses.
    name: "the quote pairer assembled from char codes, which no grep finds",
    src: [
      `const Q = String.fromCharCode(96)`,
      `const TPL = ${["new", "RegExp"].join(" ")}(Q + "(?:\\\\\\\\.|[^" + Q + "\\\\\\\\])*" + Q, "g")`,
    ].join("\n"),
    mustFlag: true,
    rule: "quote-pairing regex ASSEMBLED from char codes (grep-invisible)",
  },
  {
    // The near-misses RULE 8 must NOT sweep up. Every analyzer in scripts/ matches
    // quoted arguments — a table name, a route, a column — and none of those is a
    // masker. If the rule cannot tell them apart it is unusable.
    name: "matching a quoted WORD is not masking literals",
    src: [
      `const TABLE = /\\.from\\(${DQUOTE}([A-Za-z_]+)${DQUOTE}\\)/g`,
      `const NEG = /[^${DQUOTE}]+/g`,
      `const ALT = /${SQUOTE}(?:contacts|leads)${SQUOTE}/g`,
    ].join("\n"),
    mustFlag: false,
  },
  {
    name: "the correct thing — routed through strip-comments.ts",
    src: [
      `import { stripComments, blankComments, blankStrings } from "./strip-comments"`,
      `const code = (p) => stripComments(raw(p))`,
      `const masked = (p) => blankStrings(raw(p))`,
      `const offsets = (p) => blankComments(raw(p))`,
    ].join("\n"),
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
  // BOTH idioms, because this guard now polices both. Writing only the comment one
  // would leave the string-masking rules proven by fixtures alone — and a fixture
  // proves the detector matches a string, not that the DIRECTORY SCAN reacts.
  const body = [
    `${SLASH}${SLASH} Written by comment-strip-discipline-guard.ts as its negative control.`,
    `${SLASH}${SLASH} If you are reading this on disk, the guard died mid-run — delete it.`,
    `export const code = (s: string) =>`,
    `  s.replace(/\\${SLASH}\\${STAR}[\\s\\S]*?\\${STAR}\\${SLASH}/g, "").replace(/^[ \\t]*\\${SLASH}\\${SLASH}.*$/gm, "")`,
    `export const mask = (s: string) =>`,
    `  s.replace(/${BTICK}(?:\\\\.|[^${BTICK}\\\\])*${BTICK}/g, "").replace(/${DQUOTE}(?:\\\\.|[^${DQUOTE}\\\\])*${DQUOTE}/g, "")`,
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
    // BY RULE, not merely by count: the comment idiom fires several rules at once,
    // so "something fired" would have been satisfied with the string-masking rules
    // dead — which is exactly how a dead rule hid behind a live one here before.
    for (const wanted of ["regex removes BLOCK comments", "regex PAIRS QUOTES to mask literals (re-implements blankStrings)"]) {
      if (!hit.some((h) => h.rule === wanted)) {
        return `the probe was written into scripts/ but the scan never reported "${wanted}" — that rule is not reaching the tree`
      }
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

  const scanned = scriptFiles().length
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
    console.log(`\n  ✗ ${live.length} file(s) strip comments or mask literals without scripts/strip-comments.ts:\n`)
    for (const o of live) console.log(`    scripts/${o.file}:${o.line}  [${o.rule}]\n      ${o.text}`)
    console.log("\n  Fix: import from \"./strip-comments\" — stripComments when you report LINE")
    console.log("  NUMBERS, blankComments when you compute positions from match indices, and")
    console.log("  blankStrings when a quoted literal would confuse the parse. Pairing quotes with")
    console.log("  regexes fails the same way pairing comment delimiters does: one desynchronising")
    console.log("  backtick shifts every literal after it and the scan goes confidently wrong.")
    console.log("\n ❌ COMMENT_STRIP_DISCIPLINE_FAIL")
    process.exit(1)
  }

  console.log("\n ✅ COMMENT_STRIP_DISCIPLINE_PASS — every analyzer in scripts/ removes comments AND")
  console.log("    masks string/template literals through scripts/strip-comments.ts, and the")
  console.log("    detector proved it can still fail.")
}

main()
