/**
 * scripts/strip-comments.ts — the ONE correct way to remove comments from TypeScript here.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS, AND WHAT IT COST TO LEARN
 *
 * Every static analyzer in scripts/ removes comments before it looks for code, and 126 of them
 * did it the same wrong way:
 *
 *     src.replace(/\/\*[\s\S]*?\*\//g, "")     // block comments FIRST
 *        .replace(/^[ \t]*\/\/.*$/gm, "")      // then line comments
 *
 * Block-first is the defect. A slash followed by a star INSIDE A LINE COMMENT opens a block
 * comment for that first regex, which then runs to the next `*` + `/` anywhere below — deleting
 * every line in between, code included. Nothing errors. The analyzer simply cannot see the code,
 * and reports on what is left.
 *
 * It has now happened twice, and the second time it produced FALSE ACCUSATIONS:
 *
 *   1. `app/dashboard/marketing/blog/**` written in a `//` comment swallowed ~670 lines from
 *      every analyzer built on this idiom.
 *   2. `// Imported via dynamic import → "use server" RPC stubs. Keeps kernel/* +` in
 *      app/dashboard/listings/[id]/offers/components/compliance-bridge-panel.tsx swallowed 5,936
 *      of that file's 12,967 characters — including the three `await import(...)` call sites
 *      immediately below it. The orphan census therefore reported `emitCompliancePassedAction`
 *      and `loadComplianceBridgeStatusAction` as "referenced NOWHERE", when both are called by a
 *      panel that ships. A burn-down agent was one step from deleting live, wired server actions
 *      because the instrument said nobody used them.
 *
 * That is the failure mode that matters: an analyzer that under-reads does not go quiet, it goes
 * CONFIDENTLY WRONG, and here it was pointing at working code.
 *
 * Swapping the two regexes is NOT the fix — it only trades one bug for its mirror, since `//`
 * inside a block comment would then end it early. Comments and strings can nest inside each other
 * in ways no pair of regexes can decide. So this is a single left-to-right scan that tracks which
 * of the five states it is in, which is the only thing that actually answers the question.
 *
 * WHAT IS PRESERVED, deliberately:
 *   · newlines, so every reported line number still matches the file on disk;
 *   · string and template contents, because callers mask those separately when they want to (an
 *     export name inside a string is a mention, not a call) — and a stripper that also blanked
 *     strings would take that choice away from them. A `//` INSIDE a template literal is string
 *     content and stays: generated-JS templates (the blog view tracker, the embed loader) are
 *     full of them, and deleting them would be editing data, not stripping comments.
 *
 * A THIRD ROUND OF THE SAME LESSON, found by converting a guard to this file and watching it
 * accuse live code: `${ … }` puts the scanner back into CODE, where nested templates are legal.
 * A scanner that treats a template as "everything up to the next backtick" reads the nested
 * backtick as the closing one and every literal after it pairs up off-by-one — in
 * lib/kernel/marketing.ts that left `//` comments 900 lines downstream unstripped, and the
 * vendor-retirement guard duly reported a comment as a live reference to a retired vendor.
 * Interpolation depth is tracked; see the mode/tmplStack block in scan().
 *
 * TWO EXPORTS, one scanner: stripComments() DELETES comments (line numbers survive);
 * blankComments() replaces them with SPACES (line numbers AND character offsets survive).
 * Analyzers that compute a position from a match index need the second one.
 */

/** Comments removed, line numbers intact, strings untouched. */
export function stripComments(src: string): string {
  return scan(src, false)
}

/**
 * Comments blanked to SPACES — line numbers AND character offsets both intact,
 * strings untouched.
 *
 * Same single left-to-right scanner as stripComments; the only difference is what a
 * comment is replaced WITH. Several analyzers report a hit's position by counting
 * newlines up to a match index (`lineOf(code, idx)`) or slice around that index, so
 * they blanked comments to spaces rather than deleting them, to keep every offset
 * aligned with the text they matched against. Handing those callers stripComments()
 * would silently shift every offset they compute. This gives them the correct
 * scanner WITHOUT changing their position arithmetic — so converting them is a pure
 * fix to what the analyzer can SEE, with nothing else moving underneath it.
 */
export function blankComments(src: string): string {
  return scan(src, true)
}

function scan(src: string, blank: boolean): string {
  let out = ""
  let i = 0
  const n = src.length
  // Kept so a regex literal's contents (which may hold // or /*) are not read as a comment.
  // A `/` opens a regex only where a value cannot already have appeared.
  let prevSignificant = ""

  // ── TEMPLATE INTERPOLATION ──────────────────────────────────────────────────
  // Inside `${ … }` we are back in CODE: comments, strings, and further nested
  // templates are all legal there. Treating a template as "everything up to the
  // next backtick" is therefore wrong, and wrong in the expensive direction —
  // the first backtick of a NESTED template was read as the CLOSING backtick of
  // the outer one, after which every literal in the file paired up off-by-one and
  // whole regions came through unstripped. lib/kernel/marketing.ts (nested HTML
  // template literals) desynchronised at line 593 and left `//` comments 900 lines
  // later intact — which made a converted vendor guard accuse lib/kernel/marketing.ts
  // of naming a retired vendor in live code when all three mentions are comments.
  // Same lesson as the block-first strip: a stripper that loses sync does not go
  // quiet, it goes confidently wrong.
  let mode: "code" | "template" = "code"
  const tmplStack: number[] = [] // brace depth captured at each open `${`
  let braceDepth = 0

  while (i < n) {
    if (mode === "template") {
      const t = src[i]
      if (t === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue }
      if (t === "`") { out += t; i++; mode = "code"; prevSignificant = "`"; continue }
      if (t === "$" && src[i + 1] === "{") {
        out += "${"
        i += 2
        tmplStack.push(braceDepth)
        mode = "code"
        prevSignificant = "{"
        continue
      }
      let k = i
      while (k < n && src[k] !== "\\" && src[k] !== "`" && !(src[k] === "$" && src[k + 1] === "{")) k++
      if (k > i) { out += src.slice(i, k); i = k; continue }
      out += t
      i++
      continue
    }

    const c = src[i]
    const d = src[i + 1]

    // Closing brace of an interpolation returns us to template text.
    if (tmplStack.length > 0 && (c === "{" || c === "}")) {
      if (c === "{") {
        braceDepth++
      } else if (braceDepth === tmplStack[tmplStack.length - 1]) {
        tmplStack.pop()
        out += "}"
        i++
        mode = "template"
        continue
      } else {
        braceDepth--
      }
      out += c
      prevSignificant = c
      i++
      continue
    }

    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2)
      const stop = end === -1 ? n : end + 2
      // Newlines survive so line numbers do not shift. In blank mode every other
      // character becomes a space, so character offsets do not shift either.
      for (let k = i; k < stop; k++) out += src[k] === "\n" ? "\n" : blank ? " " : ""
      i = stop
      continue
    }

    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") { if (blank) out += " "; i++ }
      continue
    }

    if (c === "`") {
      out += c
      i++
      mode = "template"
      continue
    }

    if (c === '"' || c === "'") {
      const quote = c
      out += c
      i++
      while (i < n) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue }
        if (src[i] === quote) { out += src[i]; i++; break }
        // A single- or double-quoted literal cannot span a newline; if one appears, the quote was
        // not a string at all (an apostrophe in JSX text, say) and swallowing to EOF would repeat
        // the very bug this file exists to end.
        if (src[i] === "\n") { break }
        // Same slice-don't-append fast path as the code branch below: run to the next
        // character that can end or escape this literal and copy the span in one go.
        let k = i
        while (k < n) {
          const ch = src[k]
          if (ch === "\\" || ch === quote || ch === "\n") break
          k++
        }
        if (k > i) { out += src.slice(i, k); i = k; continue }
        out += src[i]
        i++
      }
      prevSignificant = quote
      continue
    }

    if (c === "/" && canStartRegex(prevSignificant)) {
      // Copy the regex literal verbatim, including its class ranges.
      let j = i + 1
      let inClass = false
      let closed = false
      while (j < n) {
        const r = src[j]
        if (r === "\\") { j += 2; continue }
        if (r === "\n") break              // unterminated — not a regex after all
        if (r === "[") inClass = true
        else if (r === "]") inClass = false
        else if (r === "/" && !inClass) { closed = true; j++; break }
        j++
      }
      if (closed) {
        out += src.slice(i, j)
        i = j
        prevSignificant = "/"
        continue
      }
    }

    // Fast path. Appending one character at a time made this ~40x slower than the
    // (wrong) regex idiom it replaces, which matters when a repo-wide guard runs it
    // over thousands of files. Ordinary characters — anything that cannot open a
    // comment, string, template or regex — are copied in a single slice instead.
    // Semantics are identical; only the number of string concatenations changes.
    let j = i
    const tracking = tmplStack.length > 0
    while (j < n) {
      const ch = src[j]
      if (ch === "/" || ch === '"' || ch === "'" || ch === "`") break
      if (tracking && (ch === "{" || ch === "}")) break
      j++
    }
    if (j > i) {
      out += src.slice(i, j)
      for (let k = j - 1; k >= i; k--) {
        const ch = src[k]
        if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r" && ch !== "\f" && ch !== "\v") {
          prevSignificant = ch
          break
        }
      }
      i = j
      continue
    }

    out += c
    if (!/\s/.test(c)) prevSignificant = c
    i++
  }

  return out
}

/**
 * Whether a `/` at this point opens a REGEX rather than a division.
 * After a value — identifier char, `)`, `]`, a quote — it is division.
 */
function canStartRegex(prev: string): boolean {
  if (prev === "") return true
  if (/[A-Za-z0-9_$)\]"'`]/.test(prev)) return false
  return true
}
