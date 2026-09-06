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
 * A SIXTH ROUND (lane S1, 2026-09-02): JSX TEXT. The scanner was not JSX-aware, so
 * a slash-star inside the TEXT of an element opened a block comment. Reproduced on
 * app/settings/developers/developers-client.tsx:326, which renders
 * `<code>/api/agentic-os/` + star + `</code>`: that slash-star ran to the
 * star-slash of the next real JSX comment and swallowed 5,352 characters — 27 code tokens, lines
 * ~330-355 — from EVERY guard that reads the file through this module. Blast radius
 * on that day was zero (no import or export in the swallowed region); the class is
 * not: any capability whose only call site moves into such a block becomes
 * invisible. The same blindness cost blankStrings an apostrophe: `<p>Don't forget
 * {props.name}</p>` opened a "string" at the apostrophe and blanked `{props.name}`
 * to the end of the line, so a reference in JSX text after a contraction read as
 * absent. The scanner now tracks JSX: a `<` that OPENS AN ELEMENT (decided by what
 * precedes it and CONFIRMED by a matching `</name>` or `/>` ahead — a `<T>(x)`
 * generic or a `<Foo>bar` assertion has neither and stays code), the TAG (attribute
 * strings, `{…}` expressions back in code), and the TEXT between tags, where
 * nothing but `{` and `<` is significant. See the jsxTag/jsxText arms of scan() and
 * the STATED BLIND SPOTS beside scannerSelfTest() at the bottom of this file.
 *
 * TWO EXPORTS, one scanner: stripComments() DELETES comments (line numbers survive);
 * blankComments() replaces them with SPACES (line numbers AND character offsets survive).
 * Analyzers that compute a position from a match index need the second one.
 */

/**
 * Options shared by the four exports.
 *
 * `jsx` (default true) — whether a `<` may open a JSX element. Pass `false` when
 * the text handed in is NOT a TS/TSX module but a program EMBEDDED in one: the
 * opposite-missing census re-enters every template literal's body as a span of
 * its own, because the blog view tracker, the embed loader and the tracking pixel
 * ship generated client-side JS (`<script>fetch("/api/track/pixel")</script>`)
 * inside a template. Read as TSX, `<script>` opens an element and the quoted route
 * inside it becomes element TEXT — no literal is reported and the route reads as
 * having no caller. MEASURED 2026-09-02: census control C6 went 160/160 → 159/160
 * the day the JSX modes landed, on exactly that shape. Such a span is HTML-with-
 * script, where `<` never means a JSX element; with `jsx: false` the scanner is the
 * pre-round-six scanner for that span and the quote is a literal again.
 */
export interface ScanOptions {
  jsx?: boolean
}

/** Comments removed, line numbers intact, strings untouched. */
export function stripComments(src: string, opts?: ScanOptions): string {
  return scan(src, false, false, undefined, opts?.jsx ?? true)
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
export function blankComments(src: string, opts?: ScanOptions): string {
  return scan(src, true, false, undefined, opts?.jsx ?? true)
}

/**
 * Comments AND string/template CONTENTS blanked to spaces. Delimiters kept, so
 * `"…"` stays `"…"` with spaces inside; `${ … }` interpolations stay CODE,
 * because a name inside one is a real reference. Line numbers and character
 * offsets both survive, exactly as blankComments preserves them.
 *
 * ── WHY THIS EXISTS, AND WHAT IT COST TO LEARN (round four) ─────────────────
 *
 * Every analyzer that asks "is this name a USE or merely a MENTION" has to blank
 * string contents — an export name inside a narrative string is documentation,
 * not wiring, and orphan-export-guard once classed 240 exports as "referenced"
 * on exactly that mistake. So each of them grew its own masker, and each grew
 * the SAME one:
 *
 *     src.replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
 *        .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""')
 *        .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")
 *
 * That is the block-comments-first defect wearing a different hat, and it fails
 * the same way: a lone backtick INSIDE a double-quoted string opens a template
 * for the first regex, which then runs to the next backtick anywhere below and
 * blanks every line in between — code included. Measured, not theorised: in
 * lib/agents/generate-client-message.ts the backtick pass deleted the region
 * containing `export async function generateClientMessage`, so a scanner built
 * on it concluded the module does not export it — and duly reported the twenty
 * `await import("@/lib/agents/generate-client-message")` call sites across
 * lib/agents, lib/ai-isa and lib/kernel as importing a name that does not exist.
 * Twenty false accusations against working code, from one stray backtick.
 *
 * Swapping the regex order only moves the bug, for the same reason it did for
 * comments: a quote inside a template would then end the template early. Strings,
 * templates, comments and regex literals nest in ways no sequence of regexes can
 * decide. The scanner below already tracks all four correctly — it has to, in
 * order to know where a comment is — so masking is a THIRD output of the one
 * scan rather than a fourth hand-rolled approximation of it.
 */
export function blankStrings(src: string, opts?: ScanOptions): string {
  return scan(src, true, true, undefined, opts?.jsx ?? true)
}

/**
 * One string or template literal, as the scanner saw it.
 *
 * `start` is the offset of the OPENING delimiter and `end` is one past the CLOSING
 * one, so `src.slice(start, end)` is the literal including its quotes — the same
 * offset a `/"…"/g` match index would have reported, which is what callers that
 * compute a line number or look BACKWARD for a call opener need.
 */
export interface StringLiteral {
  start: number
  end: number
  kind: "single" | "double" | "template"
  /**
   * The literal's CONTENT, delimiters excluded, escapes left raw — identical to
   * what the capture group of the three-regex idiom would have held, with ONE
   * deliberate difference: in a template every top-level `${…}` interpolation is
   * canonicalised to `${}`. The interior of an interpolation is CODE, not text
   * (it may itself contain a whole nested template), and any caller that wants
   * to normalise `${…}` → `*` gets the same answer from `${}` while a nested
   * literal is reported as its OWN entry rather than smeared into its parent's.
   */
  text: string
}

/**
 * Every properly-closed string and template literal, in the order each one CLOSES,
 * from the same single left-to-right scan that decides where a comment is.
 *
 * ── WHY THIS EXISTS, AND WHAT IT COST TO LEARN (round five) ─────────────────
 *
 * The mirror of blankStrings: some analyzers do not want string contents blanked,
 * they want to READ them — an `/api/…` path, a table name, a route. Every one of
 * them grew the same three-regex idiom the blankStrings header dissects, this time
 * to COLLECT rather than to mask:
 *
 *     for (const re of [ /"((?:\\.|[^"\\\n])*)"/g, /'…'/g, /`…`/g ]) …
 *
 * It fails identically and for the identical reason — the backtick regex pairs
 * left to right and cannot see nesting, so one desynchronising backtick shifts
 * every pairing after it. Measured on lib/elevenlabs/conv-ai.ts: 25 backticks
 * precede line 403's `${appUrl}/api/agent-assistant/tool-call`, the match before
 * it opens at line 388 and CLOSES on that literal's OPENING backtick, and the URL
 * therefore appears in no match at all. scripts/opposite-missing-census.ts's
 * category 6 read that file as naming zero `/api/` literals when it names one —
 * a same-origin self-call, which CLAUDE.md §1 names as reachability evidence — and
 * the route it registers had to be exempted BY NAME to stop the census accusing a
 * live provider webhook of having no caller.
 *
 * Comments are skipped for free, because the scanner already knows it is in one.
 */
export function stringLiterals(src: string, opts?: ScanOptions): StringLiteral[] {
  const out: StringLiteral[] = []
  // `blank`/`mask` govern the returned TEXT only, which this caller discards; the
  // literal sink is filled the same way whichever is passed.
  scan(src, true, false, out, opts?.jsx ?? true)
  return out
}

/**
 * @param blank  replace comments with SPACES (offsets survive) rather than deleting them
 * @param mask   additionally blank string and template CONTENTS (delimiters kept,
 *               `${…}` interpolations left as code)
 * @param sink   optional: every closed string/template literal is pushed here as it
 *               closes. Purely additive — when it is absent this scan behaves, and
 *               returns, exactly as it did before the sink existed, which is what
 *               keeps stripComments/blankComments/blankStrings unchanged.
 * @param jsx    whether a `<` may open a JSX element (see ScanOptions). With it
 *               off, the jsxTag/jsxText arms are never entered and the scanner is
 *               exactly the pre-round-six one.
 */
function scan(src: string, blank: boolean, mask = false, sink?: StringLiteral[], jsx = true): string {
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
  //
  // ── JSX (round six) ─────────────────────────────────────────────────────────
  // Two more modes. `jsxTag` is the inside of `<… >`: attribute strings are
  // literals, `{…}` is code, and the `>` (or `/>`) ends it. `jsxText` is the
  // children between an opening and a closing tag: NOTHING there is code except
  // `{`, which opens an expression, and `<`, which opens a child or closes the
  // element. A `/*`, a `//`, a quote or a backtick in text is text and is copied
  // through untouched — that is the whole fix for the developers-client swallow.
  //
  // The one real question is whether a `<` in code OPENS AN ELEMENT or is a
  // comparison / type argument. jsxOpensAt() answers it from what precedes the
  // `<` (a value — identifier, `)`, `]`, a quote, a digit — means comparison or
  // generic; an operator, a delimiter or `return`/`case`/… means an element) and
  // then CONFIRMS the guess by finding the element's `/>` or a matching `</name>`
  // ahead. A `<T,>(…)` generic arrow, a `<T extends X>`, a `<Foo>bar` assertion
  // or a `<T>(x: T) => T` function type has none of those and stays code. A wrong
  // "yes" here would put the rest of the file into text mode — the desync this
  // header keeps describing — which is why the guess is confirmed, not trusted.
  let mode: "code" | "template" | "jsxTag" | "jsxText" = "code"
  // One frame per `${` or JSX `{` currently open: the brace depth at which it
  // opened, and the mode a `}` at that depth returns to. (Was `tmplStack`, a bare
  // list of depths, when templates were the only way back out of code.)
  const exprStack: Array<{ back: "template" | "jsxText" | "jsxTag"; depth: number }> = []
  let braceDepth = 0
  // One entry per JSX element currently open, innermost last: exprStack.length at
  // the moment it opened. Closing an element returns to its parent's TEXT when the
  // parent opened at this same expression level, and to CODE otherwise — the
  // `<li>` produced inside `{items.map(i => <li/>)}` must hand control back to the
  // arrow function, not to the `<ul>`'s children.
  const elemStack: number[] = []
  // `<Select<Option> …>` — type arguments inside a tag; their `>` must not end it.
  let angleDepth = 0
  // Last non-space character seen inside the current tag, so `/>` is recognised.
  let tagPrev = ""

  // Open template literals, innermost last — one entry per unclosed backtick, so a
  // template opened INSIDE an interpolation collects its own text and is emitted as
  // its own literal instead of being smeared into its parent. Only maintained when a
  // sink was passed; with no sink these stay empty and cost one length check per
  // template character.
  const openTmpl: Array<{ start: number; parts: string[] }> = []

  /** Same span, every character a space except the newlines (offsets AND lines survive). */
  const blanked = (text: string) => text.replace(/[^\n]/g, " ")

  /** Where control goes once the innermost element has closed. */
  const afterElementClose = (): "code" | "jsxText" => {
    const parent = elemStack.length > 0 ? elemStack[elemStack.length - 1] : undefined
    return parent !== undefined && parent === exprStack.length ? "jsxText" : "code"
  }

  while (i < n) {
    if (mode === "template") {
      const t = src[i]
      const top = openTmpl.length > 0 ? openTmpl[openTmpl.length - 1] : null
      if (t === "\\") {
        const esc = src[i] + (src[i + 1] ?? "")
        out += mask ? blanked(esc) : esc
        top?.parts.push(esc)
        i += 2
        continue
      }
      if (t === "`") {
        out += t
        i++
        mode = "code"
        prevSignificant = "`"
        if (sink && top) { openTmpl.pop(); sink.push({ start: top.start, end: i, kind: "template", text: top.parts.join("") }) }
        continue
      }
      if (t === "$" && src[i + 1] === "{") {
        out += "${"
        i += 2
        exprStack.push({ back: "template", depth: braceDepth })
        mode = "code"
        prevSignificant = "{"
        // The interpolation's INTERIOR is code and is deliberately not collected as
        // this template's text; anything quoted inside it arrives in the sink on its
        // own. `${}` keeps the shape a `${…}` → `*` normaliser expects.
        top?.parts.push("${}")
        continue
      }
      let k = i
      while (k < n && src[k] !== "\\" && src[k] !== "`" && !(src[k] === "$" && src[k + 1] === "{")) k++
      if (k > i) {
        const span = src.slice(i, k)
        out += mask ? blanked(span) : span
        top?.parts.push(span)
        i = k
        continue
      }
      out += mask ? blanked(t) : t
      top?.parts.push(t)
      i++
      continue
    }

    if (mode === "jsxText") {
      const t = src[i]
      if (t === "{") {
        exprStack.push({ back: "jsxText", depth: braceDepth })
        out += t
        i++
        mode = "code"
        prevSignificant = "{"
        continue
      }
      if (t === "<") {
        const u = src[i + 1] ?? ""
        if (u === "/") {
          // Closing tag — copied through its `>`; the element it closes is popped.
          const end = src.indexOf(">", i)
          const stop = end === -1 ? n : end + 1
          out += src.slice(i, stop)
          i = stop
          elemStack.pop()
          mode = afterElementClose()
          prevSignificant = ">"
          continue
        }
        if (/[A-Za-z_$>]/.test(u)) {
          // A child element (or fragment) — no guess needed here: in text, `<`
          // followed by a name can only be a tag.
          elemStack.push(exprStack.length)
          out += t
          i++
          mode = "jsxTag"
          angleDepth = 0
          tagPrev = ""
          continue
        }
      }
      // Text, verbatim, up to the next `{` or `<`. Deliberately NOT masked in
      // blankStrings mode — see STATED BLIND SPOTS at the bottom of this file.
      let k = i + 1
      while (k < n && src[k] !== "{" && src[k] !== "<") k++
      out += src.slice(i, k)
      i = k
      continue
    }

    if (mode === "jsxTag") {
      const t = src[i]
      const u = src[i + 1]
      // Comments are legal between attributes and are stripped like any other.
      if (t === "/" && u === "*") {
        const end = src.indexOf("*/", i + 2)
        const stop = end === -1 ? n : end + 2
        for (let k = i; k < stop; k++) out += src[k] === "\n" ? "\n" : blank ? " " : ""
        i = stop
        continue
      }
      if (t === "/" && u === "/") {
        while (i < n && src[i] !== "\n") { if (blank) out += " "; i++ }
        continue
      }
      if (t === '"' || t === "'") {
        // A JSX attribute string: no escapes, may span lines, ends at the same quote.
        const litStart = i
        out += t
        i++
        let k = i
        while (k < n && src[k] !== t) k++
        const span = src.slice(i, k)
        out += mask ? blanked(span) : span
        i = k
        if (i < n) {
          out += src[i]
          i++
          if (sink) sink.push({ start: litStart, end: i, kind: t === '"' ? "double" : "single", text: span })
        }
        tagPrev = t
        continue
      }
      if (t === "{") {
        exprStack.push({ back: "jsxTag", depth: braceDepth })
        out += t
        i++
        mode = "code"
        prevSignificant = "{"
        tagPrev = "}"
        continue
      }
      if (t === "<") { angleDepth++; out += t; i++; tagPrev = t; continue }
      if (t === ">") {
        out += t
        i++
        if (angleDepth > 0) { angleDepth--; tagPrev = t; continue }
        prevSignificant = ">"
        if (tagPrev === "/") {
          elemStack.pop()
          mode = afterElementClose()
        } else {
          mode = "jsxText"
        }
        continue
      }
      out += t
      if (!/\s/.test(t)) tagPrev = t
      i++
      continue
    }

    const c = src[i]
    const d = src[i + 1]

    // Closing brace of an interpolation / JSX expression returns us to where it opened.
    if (exprStack.length > 0 && (c === "{" || c === "}")) {
      if (c === "{") {
        braceDepth++
      } else if (braceDepth === exprStack[exprStack.length - 1].depth) {
        const frame = exprStack.pop()!
        out += "}"
        i++
        mode = frame.back
        if (frame.back === "jsxTag") tagPrev = "}"
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
      if (sink) openTmpl.push({ start: i, parts: [] })
      out += c
      i++
      mode = "template"
      continue
    }

    if (c === '"' || c === "'") {
      const quote = c
      const litStart = i
      let closed = false
      out += c
      i++
      while (i < n) {
        if (src[i] === "\\") {
          const esc = src[i] + (src[i + 1] ?? "")
          out += mask ? blanked(esc) : esc
          i += 2
          continue
        }
        if (src[i] === quote) { out += src[i]; i++; closed = true; break }
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
        if (k > i) { const span = src.slice(i, k); out += mask ? blanked(span) : span; i = k; continue }
        out += mask ? blanked(src[i]) : src[i]
        i++
      }
      // An UNCLOSED quote is not a literal — an apostrophe in JSX text ends at the
      // newline above and must not be reported as a string, which is the same ruling
      // the `\n` break in this loop already makes for the returned text.
      if (sink && closed) {
        sink.push({
          start: litStart, end: i,
          kind: quote === '"' ? "double" : "single",
          text: src.slice(litStart + 1, i - 1),
        })
      }
      prevSignificant = quote
      continue
    }

    if (jsx && c === "<" && jsxOpensAt(src, i, prevSignificant)) {
      elemStack.push(exprStack.length)
      out += c
      i++
      mode = "jsxTag"
      angleDepth = 0
      tagPrev = ""
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
    // comment, string, template, regex or JSX element — are copied in a single
    // slice instead. Semantics are identical; only the number of string
    // concatenations changes.
    let j = i
    const tracking = exprStack.length > 0
    while (j < n) {
      const ch = src[j]
      if (ch === "/" || ch === '"' || ch === "'" || ch === "`" || ch === "<") break
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

/** What may stand directly before a `<` that opens a JSX element. */
const JSX_PREV = new Set(["(", ",", "=", ":", "?", "{", "[", "&", "|", ";", ">", "!"])
/** …and the keywords that may: `return <div/>`, `case 1: … default: return`, `yield <X/>`. */
const JSX_KEYWORDS = new Set(["return", "case", "default", "yield", "await", "else", "do", "throw"])

/**
 * Does the `<` at `i` open a JSX element?
 *
 * Two questions, both answered before "yes". WHAT PRECEDES IT: after a value
 * (an identifier, a digit, `)`, `]`, a quote) a `<` is a comparison or a type
 * argument — `a < b`, `useState<string>()`, `Array<Foo>` — and after an operator,
 * a delimiter or one of JSX_KEYWORDS it can be an element. WHAT FOLLOWS IT: the
 * element must be real, meaning the tag is self-closing (`/>`) or a matching
 * `</name>` appears later in the source. The shapes that pass the first test and
 * fail the second are exactly the TypeScript ones — `<T,>(x) =>`, `<T extends X>`,
 * `<Foo>bar` (an angle-bracket assertion, .ts only), `<T>(x: T) => T` (a generic
 * function type) — and each stays code. The lookahead is what keeps a wrong guess
 * from sending the rest of a .ts file into text mode.
 */
function jsxOpensAt(src: string, i: number, prev: string): boolean {
  const n = src.length
  const next = src[i + 1] ?? ""
  const fragment = next === ">"
  if (!fragment && !/[A-Za-z_$]/.test(next)) return false

  if (/[A-Za-z0-9_$]/.test(prev)) {
    // A word precedes. Only a keyword may open an element; read it back from the
    // source. (A comment between the keyword and the `<` defeats this and the
    // `<` is left as code — the pre-round-six behaviour, never anything worse.)
    let j = i - 1
    while (j >= 0 && /\s/.test(src[j])) j--
    let k = j
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--
    if (!JSX_KEYWORDS.has(src.slice(k + 1, j + 1))) return false
  } else if (prev !== "" && !JSX_PREV.has(prev)) {
    return false
  }

  if (fragment) return src.indexOf("</>", i + 2) !== -1

  // The tag name — `Foo.Bar`, `svg:rect`, `my-element` are all names.
  let j = i + 1
  while (j < n && /[A-Za-z0-9_$.:\-]/.test(src[j])) j++
  const name = src.slice(i + 1, j)
  let k = j
  while (k < n && /\s/.test(src[k])) k++
  if (src[k] === ",") return false                                                   // <T,>(x) => …
  if (src.startsWith("extends", k) && !/[A-Za-z0-9_$]/.test(src[k + 7] ?? "")) return false // <T extends X>

  // Find the end of the tag. Quotes and `{…}` are stepped over so a `>` inside an
  // attribute does not end it; a `/` right before the `>` means self-closing.
  let depth = 0
  let angle = 0
  let quote: string | null = null
  let m = j
  while (m < n) {
    const ch = src[m]
    if (quote) { if (ch === quote) quote = null; m++; continue }
    if (ch === '"' || ch === "'") { quote = ch; m++; continue }
    if (ch === "{") depth++
    else if (ch === "}") { if (depth > 0) depth-- }
    else if (depth === 0 && ch === "<") angle++
    else if (depth === 0 && ch === ">") {
      if (angle > 0) { angle--; m++; continue }
      let p = m - 1
      while (p > j && /\s/.test(src[p])) p--
      if (src[p] === "/") return true
      break
    }
    m++
  }
  if (m >= n) return false

  // Not self-closing: a matching closing tag must exist somewhere after it.
  const close = "</" + name
  let p = src.indexOf(close, m)
  while (p !== -1) {
    let e = p + close.length
    while (e < n && /\s/.test(src[e])) e++
    if (src[e] === ">") return true
    p = src.indexOf(close, p + 1)
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// POSITIVE CONTROLS for the scanner itself (§2 — every absence assertion needs a
// control that still recognises the defect it was written for). Run with
// `npx tsx scripts/strip-comments.ts`; returns the failures so a guard can wire
// it in. Each case names the shape it pins, and the JSX cases each carry the
// exact shape that was measured to fail before round six.
//
// STATED BLIND SPOTS (§2 — publish them beside the number):
//   · JSX TEXT IS NOT MASKED by blankStrings. An export name in element text —
//     `<p>Call generateClientMessage</p>` — is prose, and a masker that blanked
//     it would be MORE correct; it is left verbatim so the orphan ledger's
//     classification does not move under a comment-stripping fix. Changing it is
//     a deliberate step with its own measurement, not a side effect of this one.
//   · A `<` opener whose confirming `</name>` or `/>` is inside a string or
//     template later in the file confirms falsely. Not observed in this tree
//     (measured 2026-09-02: zero .ts files changed output under round six).
//   · A keyword separated from its `<` by a comment (`return /* x */ <div/>`)
//     is not recognised as an opener; the element is scanned as code, which is
//     the pre-round-six behaviour for that one expression.
//   · Invalid JSX (an unclosed `<br>`) desynchronises the element stack for the
//     rest of the file. Such a file does not compile, so it cannot ship.
// ─────────────────────────────────────────────────────────────────────────────
export function scannerSelfTest(): string[] {
  const problems: string[] = []
  const expect = (name: string, cond: boolean) => { if (!cond) problems.push(name) }

  // ── round one/two: block-first is the defect, this scanner is not it ──────
  {
    const s = "// a comment mentioning /* here\nconst live = 1\n/* real */ const two = 2\n"
    const o = stripComments(s)
    expect("a `//` line containing `/*` does not swallow the code below it", o.includes("const live = 1") && o.includes("const two = 2") && !o.includes("real"))
  }
  // ── round three: nested templates keep sync ───────────────────────────────
  {
    const s = "const a = `outer ${cond ? `inner` : \"\"} tail`\n// after\nconst b = 2\n"
    const o = stripComments(s)
    expect("a nested template does not desynchronise the literal after it", o.includes("const b = 2") && !o.includes("after"))
  }
  // ── regex literals and strings holding comment syntax ─────────────────────
  {
    const s = "const re = /\\/\\/ not a comment/g\nconst u = \"http://x/*y*/\"\n// gone\nconst z = 1\n"
    const o = stripComments(s)
    expect("`//` inside a regex and `/*` inside a string are not comments", o.includes("not a comment") && o.includes("http://x/*y*/") && !o.includes("gone") && o.includes("const z = 1"))
  }
  // ── round six: the developers-client shape, verbatim in miniature ─────────
  {
    const s = [
      "export function C(props: P) {",
      "  return (",
      "    <section>",
      "      <p>Scoped credentials (<code>vos_…</code>) for the API (<code>/api/agentic-os/*</code>)</p>",
      "      {props.tokenStateError && <p className=\"x\">{props.tokenStateError}</p>}",
      "      {/* a real JSX comment */}",
      "      <button onClick={() => setFreshToken(null)}>done</button>",
      "    </section>",
      "  )",
      "}",
      "// trailing",
      "const after = 1",
      "",
    ].join("\n")
    const o = stripComments(s)
    expect("`/*` in JSX text does not open a block comment (the developers-client swallow)", o.includes("props.tokenStateError") && o.includes("setFreshToken(null)") && o.includes("const after = 1"))
    expect("…while the real `{/* */}` JSX comment IS stripped and so is the trailing `//`", !o.includes("a real JSX comment") && !o.includes("trailing"))
    const b = blankStrings(s)
    expect("blankStrings keeps the reference inside a JSX expression after that text", b.includes("props.tokenStateError") && b.includes("setFreshToken(null)"))
    expect("blankStrings still blanks the attribute string (to a space — offsets survive)", !b.includes('"x"') && b.includes('className=" "'))
    expect("blankStrings preserves offsets across JSX", b.length === s.length)
    expect("blankComments preserves offsets across JSX", blankComments(s).length === s.length)
  }
  // ── round six: an apostrophe in JSX text is text, not a string opener ─────
  {
    const s = "const x = <p>Don't forget {props.name} today</p>\n// c\nconst y = 1\n"
    const b = blankStrings(s)
    expect("an apostrophe in JSX text no longer blanks the `{ref}` after it", b.includes("props.name") && b.includes("const y = 1"))
    expect("…and the comment after the element is still removed", !stripComments(s).includes("// c"))
  }
  // ── round six: TypeScript angle brackets stay code ────────────────────────
  {
    const cases: Array<[string, string]> = [
      ["generic call", "const [a, setA] = useState<string>(\"x\") // c\nconst b = 1\n"],
      ["generic type", "const m: Map<string, Array<Foo>> = new Map() // c\nconst b = 1\n"],
      ["generic arrow <T,>", "const f = <T,>(x: T) => x // c\nconst b = 1\n"],
      ["generic arrow <T extends X>", "const f = <T extends object>(x: T) => x // c\nconst b = 1\n"],
      ["generic function type", "type F = <T>(x: T) => T // c\nconst b = 1\n"],
      ["angle-bracket assertion (.ts)", "const v = <Foo>bar // c\nconst b = 1\n"],
      ["comparison", "if (a < b && c > d) run() // c\nconst b = 1\n"],
      ["return assertion (.ts)", "function g() { return <Foo>bar } // c\nconst b = 1\n"],
    ]
    for (const [name, s] of cases) {
      const o = stripComments(s)
      expect(`${name} is not read as JSX`, !o.includes("// c") && o.includes("const b = 1"))
    }
  }
  // ── round six: nesting, expressions, fragments, self-closing, templates ───
  {
    const s = "const l = <ul>{items.map((i) => <li key={i}>{i} /* text */ it's</li>)}</ul> // c\nconst b = 1\n"
    const o = stripComments(s)
    expect("a child element inside a map() returns to the arrow, then to the parent's text", o.includes("/* text */") && o.includes("it's") && !o.includes("// c") && o.includes("const b = 1"))
  }
  {
    const s = "const a = <a title=\"/* not */\" href={\"/x\" /* c1 */}>t</a> // c2\nconst b = 1\n"
    const o = stripComments(s)
    expect("a `/*` inside an attribute string is not a comment; one inside `{}` is", o.includes("/* not */") && !o.includes("c1") && !o.includes("c2") && o.includes("const b = 1"))
    const lits = stringLiterals(s).map((l) => l.text)
    expect("attribute strings still reach the literal sink", lits.includes("/* not */") && lits.includes("/x"))
  }
  {
    const s = "function R() { return <>{a}<b/></> } // c\nconst b = 1\n"
    expect("a fragment opens and closes", !stripComments(s).includes("// c") && stripComments(s).includes("const b = 1"))
  }
  {
    const s = "const x = <Foo bar={1} baz=\"q\" />\n// c\nconst b = 1\n"
    expect("a self-closing element returns to code", !stripComments(s).includes("// c") && stripComments(s).includes("const b = 1"))
  }
  {
    const s = "const x = <Select<Option> onChange={(v) => v > 1} />\n// c\nconst b = 1\n"
    expect("type arguments on a tag do not end it early", !stripComments(s).includes("// c") && stripComments(s).includes("const b = 1"))
  }
  {
    const s = "const t = `${cond ? <b>/* text */</b> : \"\"}` // c\nconst b = 1\n"
    const o = stripComments(s)
    expect("JSX inside a template interpolation keeps its text and returns to the template", o.includes("/* text */") && !o.includes("// c") && o.includes("const b = 1"))
  }
  {
    const s = "return (\n  <div>\n    text\n  </div>\n) // c\nconst b = 1\n"
    expect("`return (` followed by an element on the next line", !stripComments(s).includes("// c") && stripComments(s).includes("const b = 1"))
  }
  // ── stated blind spot, pinned so a change to it is deliberate ─────────────
  {
    const s = "const p = <p>mentionOnly</p>\n"
    expect("JSX text is NOT masked by blankStrings (documented blind spot)", blankStrings(s).includes("mentionOnly"))
  }
  // ── jsx:false — a template body re-entered as its own program ─────────────
  // The exact census C6 shape: generated client JS inside a template. As TSX the
  // `<script>` is an element and the route inside it is text; as embedded JS it
  // is a literal. BOTH readings are pinned so a change to either is deliberate.
  {
    const s = '<script>fetch("/api/control/inside-generated-js")</script>'
    const asTsx = stringLiterals(s).map((l) => l.text)
    const asJs = stringLiterals(s, { jsx: false }).map((l) => l.text)
    expect("jsx:true reads `<script>…</script>` as an element (no literal)", asTsx.length === 0)
    expect("jsx:false reads the quoted route inside `<script>` as a literal", asJs.length === 1 && asJs[0] === "/api/control/inside-generated-js")
    expect("jsx:false blanks that literal's contents", !blankStrings(s, { jsx: false }).includes("inside-generated-js"))
  }
  return problems
}

// `npx tsx scripts/strip-comments.ts` runs the controls; importing the module does not.
if (typeof process !== "undefined" && /strip-comments\.ts$/.test(process.argv[1] ?? "")) {
  const problems = scannerSelfTest()
  if (problems.length) {
    console.log("✗ strip-comments self-test — the scanner no longer recognises:")
    for (const p of problems) console.log("   - " + p)
    process.exit(1)
  }
  console.log("✓ strip-comments self-test — every control shape classified correctly")
}
