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
 *     strings would take that choice away from them.
 */

/** Comments removed, line numbers intact, strings untouched. */
export function stripComments(src: string): string {
  let out = ""
  let i = 0
  const n = src.length
  // Kept so a regex literal's contents (which may hold // or /*) are not read as a comment.
  // A `/` opens a regex only where a value cannot already have appeared.
  let prevSignificant = ""

  while (i < n) {
    const c = src[i]
    const d = src[i + 1]

    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2)
      const stop = end === -1 ? n : end + 2
      // Newlines survive so line numbers do not shift.
      for (let k = i; k < stop; k++) if (src[k] === "\n") out += "\n"
      i = stop
      continue
    }

    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++
      continue
    }

    if (c === '"' || c === "'" || c === "`") {
      const quote = c
      out += c
      i++
      while (i < n) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue }
        if (src[i] === quote) { out += src[i]; i++; break }
        // A single- or double-quoted literal cannot span a newline; if one appears, the quote was
        // not a string at all (an apostrophe in JSX text, say) and swallowing to EOF would repeat
        // the very bug this file exists to end.
        if (src[i] === "\n" && quote !== "`") { break }
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
