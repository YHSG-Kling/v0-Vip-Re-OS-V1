#!/usr/bin/env tsx
/**
 * scripts/check-vocabulary-guard.ts   (npm run test:check-vocabulary) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LITERAL THE DATABASE WILL NOT ACCEPT.
 *
 * Postgres CHECK constraints are live vocabularies. supabase-js resolves with
 * `{ error }` instead of throwing, and most writes in this app are best-effort,
 * so a value outside the admitted set does not crash anything — it loses the row
 * in silence. On the READ side it is worse: a filter on a value the column can
 * never hold returns zero rows and looks like "no data yet" forever.
 *
 * FOUR shipped defects in a single sweep came from exactly this:
 *
 *   agent_onboarding.status = 'stalled'         → not in (in_progress|completed|paused).
 *                                                 The console's Stalled card was permanently 0
 *                                                 and the intervention branch behind it was
 *                                                 unreachable code.
 *   buyer_fatigue_scores.risk_level watch/warning → the entire 35-79 band of scores failed to
 *                                                 persist, and two dashboards filtered on values
 *                                                 the table cannot hold.
 *   fatigue_alerts.alert_type = 'fatigue_critical' → a critical alert always rendered as a warning.
 *   listings lifecycle_stage='active' + status='closed' → an hourly sweep that matched zero rows
 *                                                 on every run since it shipped.
 *
 * There is an existing `test:vocabulary-drift`, but it compares handler-switch cases against
 * TypeScript enums — code against code. Nothing compared code against the DATABASE. This does.
 *
 * WHAT IT CHECKS. For every `.from(t)` chain, any literal assigned to or compared against a
 * column of `t` that carries an enum CHECK must be a member of that column's admitted set —
 * on inserts/upserts/updates AND on .eq/.neq/.in/.or filters.
 *
 * The window is cut at the NEXT `.from(` — the same discipline the id-class guard learned the
 * hard way. A fixed-size window spills into the following query and mis-attributes its payload,
 * which matters doubly here because names like `status` and `type` exist on hundreds of tables.
 *
 * …AND AT THE END OF THE ENCLOSING STATEMENT. Cutting only at the next `.from(` is not enough
 * when the following code never calls `.from(` literally. lib/managers/cross-referral.ts is the
 * case that proved it: a `.from("manager_signals")` chain is followed by a probe TABLE whose
 * table name lives in a `table:` property and whose filters are `q.eq(...)` lambdas, so the
 * window ran on and attributed `status: "pending"` (a real value for `offers`) to
 * manager_signals, which admits only open|consumed|expired. That produced a BASELINED entry for
 * code that was never wrong — and a false entry in a shrink-only ratchet is worse than no
 * entry, because it can never be burned down and it teaches the reader to distrust the list.
 *
 * The statement boundary is indentation-based: the chain ends at the first line indented no
 * deeper than the line holding the `.from(`, which does not itself continue the expression
 * (a continuation starts with `.`, `)`, `}`, `]`, `,`, `?` or `:`). TRADE-OFF, stated plainly:
 * a filter appended to a query variable in a LATER statement (`let q = svc.from(...)` then
 * `q = q.eq("status", "x")`) now falls outside the window. That is a real blind spot, accepted
 * because precision is what makes this ratchet worth reading; the alternative is a baseline
 * padded with entries nobody can act on.
 *
 * THE BASELINE IS NOW EMPTY — this is a ZERO-BASELINE INVARIANT, not a debt ratchet.
 *
 * It began at 100 entries. Burning it down turned up, among others: an AI review
 * automation that persisted nothing, a de-confliction cap that could not count phone or
 * mail touches, a client portal that dropped envelopes off a contact's to-sign list the
 * moment they opened one, a voice call that never closed, five finished integrations that
 * could not store a credential, a CHECK constraint that (via a NULL array element)
 * enforced nothing at all, and nineteen INSERT/UPDATE payloads whose rows were silently
 * discarded. None of them threw. Every one looked like "no data yet".
 *
 * Because the list is empty, ANY new finding fails CI — which is the point. Do not
 * re-baseline to make a failure go away: the value the code names is one the database
 * will not accept, and the row or the query is already lost. Fix the literal, or widen
 * the column with a migration when the state is genuinely new and something can write it.
 * UPDATE_CHECK_VOCAB_BASELINE=1 still exists for a deliberate, reviewed schema change.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { stripComments as canonicalStripComments } from "./strip-comments"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASELINE_PATH = join(root, "scripts", "check-vocabulary-baseline.json")
const MEM_BASELINE_PATH = join(root, "scripts", "check-vocabulary-inmemory-baseline.json")

export interface VocabViolation {
  file: string
  table: string
  column: string
  value: string
  /** "write" (payload key) or "filter" (.eq/.neq/.in/.or). */
  kind: "write" | "filter"
}

/** Comments quote the dead literals they retired — never scan them. */
function stripComments(src: string): string {
  return canonicalStripComments(src)
}

// TOMBSTONE (orphan doctrine §1.1) — the private `walk()` generator that stood
// here was one of 82 copies of the same readdirSync walker. The survivor is
// scripts/runtime-roots.ts:61 (`walkTs`), imported above.
//
// It enumerated DIRECTORIES, and a root-level FILE is not a directory, so
// `proxy.ts` — the Next 16 edge middleware, which gates auth and queries
// blog_posts, brokerages, users and tenant_custom_domains with a SERVICE client on
// EVERY request — was outside this guard's corpus. A file that is never opened
// reports green. `rootRuntimeFiles()` from the same survivor supplies the root
// files, so the directory loop is no longer the whole answer to "what ships".

/**
 * TOP-LEVEL keys of an object literal, as `name: "literal"` pairs. Values that are
 * themselves objects or arrays are skipped entirely.
 *
 * This matters more than it sounds. Rows here routinely carry a `metadata` /
 * `settings` / `payload` JSONB bag, and those bags contain arbitrary keys — `source`,
 * `status`, `type` — that collide with real column names. `lifecycle_events.source`
 * is a four-value provenance CHECK (ui|webhook|system|cron), and every one of the
 * eight "violations" this guard first reported for it was a `source:` inside a
 * `metadata: { ... }`, which is free-form JSON the constraint never sees.
 */
export function topLevelPairs(objText: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = []
  let depth = 0
  let i = 0
  while (i < objText.length) {
    const c = objText[i]
    if (c === "{" || c === "[") { depth++; i++; continue }
    if (c === "}" || c === "]") { depth--; i++; continue }
    if (depth === 1) {
      const m = /^([A-Za-z_$][\w$]*)\s*:\s*(["'])([^"'\n]*)\2/.exec(objText.slice(i))
      if (m) { out.push({ key: m[1], value: m[3] }); i += m[0].length; continue }
    }
    i++
  }
  return out
}

/**
 * The balanced argument text of every `.insert(` / `.upsert(` / `.update(` in a chain
 * window. Brace/paren matching, so a nested object stays inside its own payload and an
 * unrelated literal that merely sits nearby does not leak in.
 */
export function mutationArgs(win: string): string[] {
  const out: string[] = []
  const re = /\.(insert|upsert|update)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(win))) {
    let depth = 0
    for (let i = m.index + m[0].length - 1; i < win.length; i++) {
      const c = win[i]
      if (c === "(") depth++
      else if (c === ")") {
        depth--
        if (depth === 0) { out.push(win.slice(m.index + m[0].length, i)); break }
      }
    }
  }
  return out
}

/** PURE — leading-whitespace width of the line containing `index`. */
export function indentOfLineAt(src: string, index: number): number {
  const start = src.lastIndexOf("\n", index) + 1
  let n = 0
  while (start + n < src.length && (src[start + n] === " " || src[start + n] === "\t")) n++
  return n
}

/**
 * PURE — how far into `win` the `.from()` chain's own statement extends.
 *
 * `win` begins immediately after `.from("t")`. The statement continues while
 * lines are continuations of it; it ENDS at the first line indented no deeper
 * than `baseIndent` that STARTS a new statement. Blank lines are skipped rather
 * than treated as terminators, so a chain broken up for readability still scans
 * whole.
 *
 * "Starts a new statement" is deliberately narrow: an identifier/keyword or an
 * opening brace. Everything else — `.`, `)`, `}`, `]`, `,`, a quote or backtick,
 * an operator — continues the expression. The narrow rule matters: a chain that
 * closes a multi-line `.select(\`…\`)` puts a lone backtick at the SAME
 * indentation as the `.from(`, and treating that as a statement start cut the
 * window in half, hiding a real `.eq("period_type", "monthly")` further down the
 * same chain.
 */
export function statementEnd(win: string, baseIndent: number): number {
  let offset = 0
  const lines = win.split("\n")
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    // Line 0 is the tail of the .from() line itself — never a terminator.
    if (li > 0 && line.trim() !== "") {
      let indent = 0
      while (indent < line.length && (line[indent] === " " || line[indent] === "\t")) indent++
      const first = line[indent]
      const startsStatement = first !== undefined && (/[A-Za-z_$]/.test(first) || first === "{")
      if (indent <= baseIndent && startsStatement) return offset
    }
    offset += line.length + 1
  }
  return win.length
}

/**
 * PURE — the variable a `.from()` chain was assigned to, if any.
 * `let query = supabase\n  .from("contacts")` → "query".
 */
export function assignedVarBefore(src: string, fromIndex: number): string | null {
  const back = src.slice(Math.max(0, fromIndex - 200), fromIndex)
  const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^=;]*$/.exec(back)
  return m?.[1] ?? null
}

/**
 * PURE — lines AFTER the statement that keep building the same query variable.
 *
 * This is the other half of the window. Query builders are routinely assigned
 * and then extended conditionally:
 *
 *   let query = supabase.from("contacts").select(...)
 *   if (kind === "showing_feedback") query = query.eq("buyer_stage", "toured")
 *
 * The `.eq` lives in a LATER statement, so a purely statement-scoped window
 * would miss it — and that exact call is a real defect (the column's ladder says
 * BUYER_TOURING, so the filter matches nothing and the AI-ISA showing-feedback
 * campaign finds no one). Following the variable keeps that finding while still
 * excluding unrelated code that merely sits nearby.
 */
export function variableContinuations(tail: string, varName: string): string {
  const re = new RegExp(`(?:\\b${varName}\\s*=\\s*${varName}\\s*\\.)|(?:\\b${varName}\\s*\\.(?:eq|neq|in|or|insert|upsert|update)\\s*\\()`)
  const out: string[] = []
  for (const line of tail.split("\n")) {
    if (/\.from\(/.test(line)) break
    if (re.test(line)) out.push(line)
  }
  return out.join("\n")
}

/**
 * PURE — every `.from("<enum table>")` chain in `src` (already comment-stripped),
 * paired with the window of text that belongs to THAT chain.
 *
 * Extracted so the two detectors below share ONE definition of "this query's own
 * text" (CLAUDE.md §6). Two hand-maintained copies of this windowing is how the
 * in-memory scan would drift from the filter scan and start attributing one
 * query's columns to another's payload — the precise mis-attribution the
 * statement-boundary comment above records having already cost this guard once.
 */
export function chainWindows(src: string): Array<{ table: string; win: string; index: number }> {
  const out: Array<{ table: string; win: string; index: number }> = []
  for (const table of Object.keys(CHECK_VOCABULARIES)) {
    for (const quote of ['"', "'"]) {
      const needle = `.from(${quote}${table}${quote})`
      let i = src.indexOf(needle)
      while (i !== -1) {
        const rest = src.slice(i + needle.length)
        const nextFrom = rest.search(/\.from\(/)
        const byFrom = nextFrom >= 0 ? rest.slice(0, nextFrom) : rest.slice(0, 1500)
        const end = statementEnd(byFrom, indentOfLineAt(src, i))
        const varName = assignedVarBefore(src, i)
        const win = varName
          ? byFrom.slice(0, end) + "\n" + variableContinuations(byFrom.slice(end), varName)
          : byFrom.slice(0, end)
        out.push({ table, win, index: i })
        i = src.indexOf(needle, i + 1)
      }
    }
  }
  return out
}

/** PURE — exported so the checks below can exercise it directly. */
export function scanCheckVocabulary(rawSrc: string, file: string): VocabViolation[] {
  const src = stripComments(rawSrc)
  const out: VocabViolation[] = []

  for (const { table, win } of chainWindows(src)) {
    const columns = CHECK_VOCABULARIES[table as keyof typeof CHECK_VOCABULARIES] as Record<string, readonly string[]>

    for (const [column, allowed] of Object.entries(columns)) {
          const ok = new Set(allowed)
          const flag = (value: string, kind: "write" | "filter") => {
            // A `${...}` interpolation is a VARIABLE, not a literal — the guard's
            // own contract is that only literals are checkable. It was reporting
            // `deal_type.eq.${ctx.dealType}` as an unadmitted value, on a field
            // TypeScript already narrows to exactly buyer|seller|dual. A false
            // entry in a shrink-only ratchet can never be burned down.
            if (value.includes("${")) return
            if (!ok.has(value)) out.push({ file, table, column, value, kind })
          }

          // Payload literal: `column: "value"` — ONLY inside the balanced argument of
          // this chain's own .insert/.upsert/.update. Scanning the whole window was
          // wrong: a plain object literal built nearby (a Dotloop API request body, a
          // transaction_milestones row assembled before its own .from()) contributed
          // keys that belong to something else entirely. Three of this guard's first
          // findings were exactly that, so the payload scan is now argument-scoped.
          for (const arg of mutationArgs(win)) {
            for (const pair of topLevelPairs(arg)) {
              if (pair.key === column) flag(pair.value, "write")
            }
          }

          // Filters: .eq("column", "value") / .neq(...)
          const eqRe = new RegExp(`\\.(?:eq|neq)\\(\\s*["']${column}["']\\s*,\\s*["']([^"'\\n]*)["']\\s*\\)`, "g")
          let m: RegExpExecArray | null
          while ((m = eqRe.exec(win))) flag(m[1], "filter")

          // .in("column", ["a", "b"]) — every element.
          const inRe = new RegExp(`\\.in\\(\\s*["']${column}["']\\s*,\\s*\\[([^\\]]*)\\]`, "g")
          while ((m = inRe.exec(win))) {
            for (const lit of m[1].matchAll(/["']([^"'\n]*)["']/g)) flag(lit[1], "filter")
          }

          // .or("column.eq.value,other.eq.x") — PostgREST filter grammar.
          const orRe = /\.or\(\s*["'`]([^"'`\n]*)["'`]/g
          while ((m = orRe.exec(win))) {
            for (const clause of m[1].split(",")) {
              const parts = clause.split(".")
              if (parts.length >= 3 && parts[0] === column && (parts[1] === "eq" || parts[1] === "neq")) {
                flag(parts.slice(2).join("."), "filter")
              }
            }
          }
    }
  }
  return out
}

// ── DETECTOR 2: the comparison the ROW will never satisfy ───────────────────
/**
 * THE HALF THIS GUARD COULD NOT SEE, and the defect that proved it.
 *
 * Everything above scans the QUERY BUILDER: `.eq("col","lit")`, an insert payload,
 * a PostgREST `.or()` clause. All of those hand the literal to Postgres, so the
 * database gets a chance to refuse. The other way to compare a CHECK column
 * against a literal is to SELECT it and compare in JavaScript after the rows come
 * back — and there Postgres never sees the literal at all, so nothing refuses and
 * nothing logs. The filter simply matches nothing, forever.
 *
 * lib/listing-health/health-scorer.ts scored the FEEDBACK category — 15% of every
 * active listing's health — with
 *
 *     r.buyer_interest_level === "interested" || r.buyer_interest_level === "very_interested"
 *
 * against `showings.buyer_interest_level`, whose live CHECK admits exactly
 * love_it | like_it | maybe | no. Not one of those three literals is a member, so
 * `interested` was structurally 0, `interestRatio` structurally 0, and the branch
 * `score = Math.round(interestRatio * 100)` returned 0 for every listing that HAD
 * feedback — while a listing with NO feedback returned early on the neutral 80.
 * Collecting buyer feedback made the listing's health score twelve points WORSE.
 * lib/agents/seller-update-reel-producer.ts carried a byte-identical copy, so the
 * weekly seller video told every seller their listing drew "light" interest.
 *
 * The literals are not invented: they are the vocabulary of a DIFFERENT column
 * (property_alert_results.buyer_reaction admits interested | very_interested |
 * not_interested | scheduled_showing). That is §6 exactly — two spellings of one
 * idea, and the scorer could not match the writer across them.
 *
 * THE RULE ASSERTED, derived and not pinned: for every enum-CHECK column this file
 * SELECTS, any string literal the file compares that column against must be a
 * member of the union of admitted sets for that column name across the tables the
 * file actually reads. The union is deliberate — a file that reads BOTH
 * showings.buyer_interest_level (love_it…) and showing_feedback.buyer_interest_level
 * (hot…) may legitimately hold either spelling, and a false entry in a shrink-only
 * ratchet can never be burned down.
 *
 * Also flagged: an ORDER comparison (>=, <=, >, <) or arithmetic against a column
 * whose admitted set is entirely non-numeric. `(f.buyer_interest_level ?? 0) >= 4`
 * on hot|warm|cool|cold is NaN on every row — the same always-false shape wearing
 * a numeric hat, and it silently pinned two seller-sentiment counters to zero.
 *
 * BLIND SPOTS, published beside the number (§2):
 *   · Only files that both `.from()` the table AND compare in the SAME file. A
 *     column selected in one module and compared in another is invisible here.
 *   · Only STRING LITERALS. A literal held in a const, an enum member, or an
 *     interpolation is not checkable — the same contract detector 1 states.
 *   · A RECORD LOOKUP keyed by the value (`INTEREST_LEVEL_CONFIG[row.col]`) is not
 *     a comparison and is not scanned; those degrade to "no badge", not to a
 *     wrong number.
 *   · A column name shared by two tables the file reads takes the UNION, so a
 *     value admitted by one passes for the other.
 *   · `select("*")` registers every enum column of that table, which is the
 *     honest reading of what the row carries.
 */
export interface MemVocabViolation {
  file: string
  column: string
  value: string
  /** which tables in this file supply that column's admitted set */
  tables: string
  /** "compare" (=== / !== / case) or "numeric" (an order comparison on a text enum) */
  kind: "compare" | "numeric"
}

/** PURE — the balanced argument text of every `.select(` in a window. */
export function selectArgs(win: string): string[] {
  const out: string[] = []
  const re = /\.select\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(win))) {
    let depth = 0
    for (let i = m.index + m[0].length - 1; i < win.length; i++) {
      const c = win[i]
      if (c === "(") depth++
      else if (c === ")") {
        depth--
        if (depth === 0) { out.push(win.slice(m.index + m[0].length, i)); break }
      }
    }
  }
  return out
}

/**
 * PURE — enum-CHECK columns this file SELECTS, mapped to the union of admitted
 * values and the tables that supplied them.
 *
 * Embedded selects count: `feedback:showing_feedback(overall_impression,
 * buyer_interest_level)` is how app/actions/seller-showing-sentiment.ts obtains the
 * column it then compares, and a scan that only looked at `.from()`'s own table
 * would report zero there and read as a clean bill of health (§2).
 */
export function selectedEnumColumns(src: string): Map<string, Set<string>> {
  const reg = new Map<string, Set<string>>()
  const add = (table: string, column: string, _allowed: readonly string[]) => {
    let e = reg.get(table)
    if (!e) { e = new Set(); reg.set(table, e) }
    e.add(column)
  }

  for (const { table, win } of chainWindows(src)) {
    const columns = CHECK_VOCABULARIES[table as keyof typeof CHECK_VOCABULARIES] as Record<string, readonly string[]>
    for (const sel of selectArgs(win)) {
      const star = /["'`]\s*\*\s*["'`]/.test(sel)
      // A column named ONLY inside an embed's parens belongs to the EMBEDDED
      // table, not to this one — `showings.select("id, feedback:showing_feedback(
      // buyer_interest_level)")` does not mean `showings` selected that column.
      // Testing the raw select text made the outer table claim it and judge the
      // embed's own admitted values as violations.
      const outer = sel.replace(/\(([^()]*)\)/g, "()")
      for (const [column, allowed] of Object.entries(columns)) {
        if (star || new RegExp(`\\b${column}\\b`).test(outer)) add(table, column, allowed)
      }
      // Embeds: `alias:embedded(col, col)` or `embedded(col, col)`.
      const embedRe = /(?:[A-Za-z_$][\w$]*\s*:\s*)?([a-z_][a-z0-9_]*)\s*\(([^()]*)\)/g
      let em: RegExpExecArray | null
      while ((em = embedRe.exec(sel))) {
        const et = em[1]
        const ecols = CHECK_VOCABULARIES[et as keyof typeof CHECK_VOCABULARIES] as Record<string, readonly string[]> | undefined
        if (!ecols) continue
        const inner = em[2]
        const estar = /\*/.test(inner)
        for (const [column, allowed] of Object.entries(ecols)) {
          if (estar || new RegExp(`\\b${column}\\b`).test(inner)) add(et, column, allowed)
        }
      }
    }
  }
  return reg
}

/**
 * PURE — the identifiers in this file that actually hold a DATABASE ROW.
 *
 * WHY THIS IS NOT OPTIONAL, measured rather than argued. The first cut of this
 * detector judged every `X.<column>` in a file that selected `<column>`, and
 * reported 331 findings — 281 of them on `status`, and almost all of those were
 * `r.status === "fulfilled"` on a Promise.allSettled result, an HTTP response's
 * `.status`, or a local `{ status: "ok" | "fail" }` return shape. `status` is the
 * most overloaded property name in JavaScript, and a shrink-only ratchet seeded
 * with 281 entries nobody can act on is worse than no ratchet at all — this
 * guard's own baseline comment says exactly that, in its own words, about a
 * finding it once mis-attributed.
 *
 * So the receiver is TRACKED, shallowly but honestly:
 *   · seeded from the assignment holding a `.from("…")` chain — `const { data: rows }`,
 *     `const { data }`, `const x = await supabase.from(…)`;
 *   · propagated through the aliases a row list actually survives —
 *     `(rows ?? []) as Row[]`, `.filter()`, `.slice()`, `.sort()`, `.reverse()`,
 *     `.concat()` — and NOT through `.map()`/`.flatMap()`/`.reduce()`, whose result
 *     is a different type entirely;
 *   · extended to the ELEMENT parameter of any array method called on a tracked
 *     list, which is where nearly every real comparison lives
 *     (`list.filter((r) => r.buyer_interest_level === "…")`).
 *
 * Anything else is left alone. The cost is stated in the blind-spot list on
 * MemVocabViolation: a row handed to another function, and a value pulled out
 * with `.map()` before it is compared, both fall outside. That is the honest
 * trade — this reports fewer things and every one of them is real.
 */
export function rowVariables(code: string): { rows: Map<string, Set<string>>; lists: Map<string, Set<string>> } {
  const rows = new Map<string, Set<string>>()
  const lists = new Map<string, Set<string>>()
  const put = (into: Map<string, Set<string>>, name: string, tables: Iterable<string>) => {
    let s = into.get(name)
    if (!s) { s = new Set(); into.set(name, s) }
    for (const t of tables) s.add(t)
  }

  // Seed: whatever a `.from("table")` chain was assigned to, TAGGED WITH THAT TABLE.
  //
  // The table has to travel with the variable. Without it, judging is forced to
  // take the union of every table in the file that has a CHECK on that column
  // name, and lib/portal/resolve-seller-context.ts is the case that proved it
  // wrong: `offers.find((o) => o.status === "accepted")` was reported as a value
  // `status` cannot hold, because the file elsewhere reads `listings.status` and
  // `offers.status` carries no CHECK at all. `o` is an OFFERS row; the listings
  // vocabulary has no authority over it. A false entry in a shrink-only ratchet
  // can never be burned down.
  //
  // The quoted snake_case argument is what keeps `Array.from(x)` out.
  const fromRe = /\.from\(\s*["']([a-z_][a-z0-9_]*)["']\s*\)/g
  let m: RegExpExecArray | null
  while ((m = fromRe.exec(code))) {
    // An EMBEDDED table's rows arrive nested inside this chain's rows, so the
    // variable legitimately carries both shapes. Attaching the embed here is what
    // lets a comparison on an embedded column be judged at all — the receiver
    // tracking cannot follow `s.feedback` into a nested property.
    const tables = [m[1]]
    for (const sel of selectArgs(code.slice(m.index, m.index + 1500))) {
      for (const em of sel.matchAll(/(?:[A-Za-z_$][\w$]*\s*:\s*)?([a-z_][a-z0-9_]*)\s*\(/g)) tables.push(em[1])
      break
    }
    const back = code.slice(Math.max(0, m.index - 300), m.index)
    const named = /(?:const|let|var)\s*\{\s*data\s*:\s*([A-Za-z_$][\w$]*)[^}]*\}\s*=\s*[^=;]*$/.exec(back)
    if (named) { put(lists, named[1], tables); put(rows, named[1], tables); continue }
    if (/(?:const|let|var)\s*\{\s*data\b[^}]*\}\s*=\s*[^=;]*$/.test(back)) { put(lists, "data", tables); put(rows, "data", tables); continue }
    const plain = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^=;]*$/.exec(back)
    if (plain) { put(lists, plain[1], tables); put(rows, plain[1], tables) }
  }

  // Fixpoint — aliases and callback parameters, until nothing new appears.
  const idsIn = (s: string) => [...s.matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => x[0])
  const size = () => [...rows.values()].reduce((n, s) => n + s.size, rows.size)
    + [...lists.values()].reduce((n, s) => n + s.size, lists.size)
  for (let pass = 0; pass < 5; pass++) {
    const before = size()

    for (const line of code.split("\n")) {
      const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(.+)$/.exec(line)
      if (decl) {
        const [, name, rhsRaw] = decl
        const rhs = rhsRaw.trim()
        const head = idsIn(rhs)[0]
        const src = head ? lists.get(head) : undefined
        if (src) {
          // `.map()`/`.flatMap()`/`.reduce()` change the element type — their
          // RESULT is deliberately not propagated.
          if (/^\(*\s*[A-Za-z_$][\w$]*\s*(?:\?\?\s*\[\s*\]\s*)?\)*(?:\s+as\s+.+)?$/.test(rhs)) { put(lists, name, src); put(rows, name, src) }
          else if (new RegExp(`^\\(*\\s*${head}\\b[\\s\\S]*\\.(?:filter|slice|sort|reverse|concat)\\(`).test(rhs)) { put(lists, name, src) }
          else if (new RegExp(`^\\(*\\s*${head}\\s*(?:\\?\\?\\s*\\[\\s*\\]\\s*)?\\)*\\s*(?:as\\s+[^\\n]*?)?\\.(?:find|at)\\(`).test(rhs)
                || new RegExp(`^\\(*\\s*${head}\\s*(?:\\?\\?\\s*\\[\\s*\\]\\s*)?\\)*\\s*\\[\\s*0\\s*\\]`).test(rhs)) { put(rows, name, src) }
        }
      }
    }

    // `tracked.filter((r) => …)` / `.map((r) => …)` — `r` IS a row even when the
    // method's RESULT is not a list of rows.
    const cbRe = /\b([A-Za-z_$][\w$]*)\s*(?:\?\.)?\.(?:filter|map|flatMap|some|every|find|findIndex|findLast|forEach|sort)\s*\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*(?::[^,)]*)?\)?\s*=>/g
    while ((m = cbRe.exec(code))) {
      const src = lists.get(m[1])
      if (src) put(rows, m[2], src)
    }

    if (size() === before) break
  }
  return { rows, lists }
}

/** PURE — exported so the checks below can exercise it directly. */
export function scanInMemoryVocabulary(rawSrc: string, file: string): MemVocabViolation[] {
  const src = stripComments(rawSrc)
  const selected = selectedEnumColumns(src)
  if (selected.size === 0) return []
  const { rows } = rowVariables(src)
  if (rows.size === 0) return []
  const out: MemVocabViolation[] = []

  // Every enum column any table in this file SELECTS is a candidate; authority
  // over a given comparison comes from the RECEIVER's own table(s), resolved per
  // hit below.
  const candidates = new Set<string>()
  for (const cols of selected.values()) for (const c of cols) candidates.add(c)

  /**
   * The receiver's table(s) that (a) this file actually selected `column` from and
   * (b) carry a CHECK on it. Empty ⇒ no authority ⇒ not our business.
   */
  const authority = (recv: string | undefined, column: string) => {
    if (!recv) return null
    const tabs = rows.get(recv)
    if (!tabs) return null
    const allowed = new Set<string>()
    const tables: string[] = []
    for (const t of tabs) {
      if (!selected.get(t)?.has(column)) continue
      const cols = CHECK_VOCABULARIES[t as keyof typeof CHECK_VOCABULARIES] as Record<string, readonly string[]> | undefined
      const vals = cols?.[column]
      if (!vals) continue
      tables.push(t)
      for (const v of vals) allowed.add(v)
    }
    return tables.length ? { allowed, tables: tables.sort().join("+") } : null
  }

  for (const column of candidates) {
    const flag = (recv: string | undefined, value: string, kind: "compare" | "numeric") => {
      const auth = authority(recv, column)
      if (!auth) return
      if (value.includes("${")) return
      if (kind === "compare" && auth.allowed.has(value)) return
      out.push({ file, column, value, tables: auth.tables, kind })
    }
    const isRow = (recv: string | undefined) => !!authority(recv, column)
    const R = `([A-Za-z_$][\\w$]*)\\s*\\??\\.${column}\\b`

    // `row.column === "lit"` / `!==` / `==` / `!=`, and the mirrored literal-first form.
    const cmp = new RegExp(`${R}\\s*(?:\\?\\?\\s*[^\\s)]+\\s*)?\\)?\\s*(?:===|!==|==|!=)\\s*["']([^"'\\n]*)["']`, "g")
    let m: RegExpExecArray | null
    while ((m = cmp.exec(src))) flag(m[1], m[2], "compare")
    const cmpRev = new RegExp(`["']([^"'\\n]*)["']\\s*(?:===|!==|==|!=)\\s*${R}`, "g")
    while ((m = cmpRev.exec(src))) flag(m[2], m[1], "compare")

    // `["a","b"].includes(row.column)` — a set membership test, same shape.
    const inc = new RegExp(`\\[([^\\]]*)\\]\\s*(?:as\\s+[\\w<>\\[\\]]+\\s*)?\\.includes\\(\\s*${R}`, "g")
    while ((m = inc.exec(src))) {
      if (!isRow(m[2])) continue
      for (const lit of m[1].matchAll(/["']([^"'\n]*)["']/g)) flag(m[2], lit[1], "compare")
    }

    // `switch (row.column) { case "lit": … }` — the balanced block only.
    const sw = new RegExp(`switch\\s*\\(\\s*${R}\\s*(?:\\?\\?\\s*[^)\\n]+)?\\)\\s*\\{`, "g")
    while ((m = sw.exec(src))) {
      const recv = m[1]
      if (!isRow(recv)) continue
      let depth = 0
      let end = src.length
      for (let i = m.index + m[0].length - 1; i < src.length; i++) {
        const c = src[i]
        if (c === "{") depth++
        else if (c === "}") { depth--; if (depth === 0) { end = i; break } }
      }
      const body = src.slice(m.index + m[0].length, end)
      for (const cs of body.matchAll(/\bcase\s+["']([^"'\n]*)["']\s*:/g)) flag(recv, cs[1], "compare")
    }

    // An ORDER comparison against a column whose admitted set is entirely NON-numeric
    // is NaN on every row — always false, and it reads as "nobody qualified".
    const ord = new RegExp(`${R}\\s*(?:\\?\\?\\s*[^\\s)]+\\s*)?\\)?\\s*(>=|<=|>|<)\\s*(-?\\d+(?:\\.\\d+)?)`, "g")
    while ((m = ord.exec(src))) {
      const auth = authority(m[1], column)
      if (!auth) continue
      if ([...auth.allowed].every((v) => /^-?\d+(\.\d+)?$/.test(v))) continue
      flag(m[1], `${m[2]} ${m[3]}`, "numeric")
    }
  }
  return out
}

const key = (v: VocabViolation) => `${v.file}::${v.table}.${v.column}=${v.value}`
const memKey = (v: MemVocabViolation) => `${v.file}::${v.column}[${v.tables}]${v.kind === "numeric" ? " " : "="}${v.value}`

// ── Run ─────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const tableCount = Object.keys(CHECK_VOCABULARIES).length
const columnCount = Object.values(CHECK_VOCABULARIES).reduce((n, c) => n + Object.keys(c).length, 0)

console.log("══════════════════════════════════════════════════")
console.log(" CHECK-vocabulary guard (no literal the database rejects)")
console.log("══════════════════════════════════════════════════")

console.log("\n[pure — the detector]")
check("flags a write literal outside the CHECK set",
  scanCheckVocabulary(`svc.from("agent_onboarding").update({ status: "stalled" })`, "t").length === 1)
check("accepts an admitted write literal",
  scanCheckVocabulary(`svc.from("agent_onboarding").update({ status: "paused" })`, "t").length === 0)
check("flags a FILTER on a value the column can never hold",
  scanCheckVocabulary(`svc.from("agent_onboarding").select("*").eq("status", "stalled")`, "t").length === 1)
check("flags every bad element of an .in() list",
  scanCheckVocabulary(`svc.from("listings").select("*").in("status", ["active", "closed"])`, "t").length === 1)
check("parses PostgREST .or() clauses",
  scanCheckVocabulary(`svc.from("listings").select("*").or("lifecycle_stage.eq.active,status.eq.sold")`, "t").length === 1)
check("accepts the corrected .or()",
  scanCheckVocabulary(`svc.from("listings").select("*").or("lifecycle_stage.eq.MLS_ACTIVE,status.eq.active")`, "t").length === 0)
check("does NOT spill into the next query's payload",
  scanCheckVocabulary(
    `svc.from("agent_onboarding").select("id")\nsvc.from("listings").update({ status: "sold" })`, "t").length === 0)
check("ignores a variable (only literals are checkable)",
  scanCheckVocabulary(`svc.from("agent_onboarding").update({ status: nextStatus })`, "t").length === 0)
check("never reads its own documentation",
  scanCheckVocabulary(`// svc.from("agent_onboarding").eq("status", "stalled")`, "t").length === 0)
check("a payload for ANOTHER table nearby is not attributed to this one",
  scanCheckVocabulary(
    `const rows = milestones.map((m) => ({ milestone_name: m.name, status: "pending" }))\n` +
    `await svc.from("transactions").select("id").eq("id", txId)`, "t").length === 0)
// 'closing' was retired from transactions.status by m291 (it is a scheduling word,
// not a milestone — clear_to_close replaced it). This fixture used to use
// "pending", which m291 made VALID, so the assertion silently inverted.
check("but the chain's OWN payload is still scanned",
  scanCheckVocabulary(`svc.from("transactions").insert({ status: "closing" })`, "t").length === 1)
check("a key inside a metadata bag is NOT treated as a column",
  scanCheckVocabulary(
    `svc.from("lifecycle_events").insert({ event_type: "x", metadata: { source: "qr_scan" } })`, "t").length === 0)
check("but the same key AS a column is still flagged",
  scanCheckVocabulary(`svc.from("lifecycle_events").insert({ source: "qr_scan" })`, "t").length === 1)
check("topLevelPairs skips nested objects and arrays",
  topLevelPairs(`{ a: "1", bag: { a: "2" }, list: ["a"], b: "3" }`).map((p) => p.key).join(",") === "a,b")

check("mutationArgs keeps a nested object inside its own payload",
  mutationArgs(`.insert({ a: { b: 1 }, status: "x" })`).length === 1)

check("leaves a column with no CHECK alone",
  scanCheckVocabulary(`svc.from("agent_onboarding").update({ current_day: "12" })`, "t").length === 0)

console.log("\n[pure — the IN-MEMORY detector (the comparison the row will never satisfy)]")
// THE POSITIVE CONTROL for the shipped defect this detector was written for. The
// fixture is the health-scorer line verbatim; if it ever stops being flagged, the
// finder has gone blind and a zero elsewhere means nothing (§2).
const HEALTH_SCORER_DEFECT =
  `const { data: rows } = await supabase\n` +
  `  .from("showings")\n` +
  `  .select("buyer_interest_level, rating")\n` +
  `  .eq("listing_id", listingId)\n` +
  `const list = (rows ?? []) as Array<{ buyer_interest_level: string | null }>\n` +
  `const interested = list.filter((r) => r.buyer_interest_level === "interested" || r.buyer_interest_level === "very_interested").length\n` +
  `const notInterested = list.filter((r) => r.buyer_interest_level === "not_interested").length\n`
check("POSITIVE CONTROL — flags the three literals showings.buyer_interest_level can never hold",
  scanInMemoryVocabulary(HEALTH_SCORER_DEFECT, "t").map((v) => v.value).sort().join(",")
    === "interested,not_interested,very_interested",
  scanInMemoryVocabulary(HEALTH_SCORER_DEFECT, "t").map((v) => v.value).join(","))
check("accepts the CORRECTED comparison (the live CHECK's own values)",
  scanInMemoryVocabulary(
    HEALTH_SCORER_DEFECT.replace(/"interested"/g, '"like_it"')
      .replace(/"very_interested"/g, '"love_it"').replace(/"not_interested"/g, '"no"'), "t").length === 0)
/** A minimal but REALISTIC read: the row variable has to actually come from the query. */
const readOf = (table: string, cols: string, body: string) =>
  `const { data: rows } = await svc.from("${table}").select(${cols})\n` +
  `const list = (rows ?? []) as Row[]\n` + body
check("a column the file never SELECTS is not judged",
  scanInMemoryVocabulary(readOf("showings", `"id, scheduled_date"`,
    `const n = list.filter((r) => r.buyer_interest_level === "interested").length`), "t").length === 0)
check("select(\"*\") registers every enum column of that table",
  scanInMemoryVocabulary(readOf("showings", `"*"`,
    `const n = list.filter((r) => r.buyer_interest_level === "interested").length`), "t").length === 1)
check("an EMBEDDED select registers the embedded table's vocabulary",
  scanInMemoryVocabulary(readOf("showings", "`id, feedback:showing_feedback(buyer_interest_level)`",
    `const n = list.filter((f) => f.buyer_interest_level === "interested").length`), "t").length === 1)
check("the embed's OWN vocabulary is accepted",
  scanInMemoryVocabulary(readOf("showings", "`id, feedback:showing_feedback(buyer_interest_level)`",
    `const n = list.filter((f) => f.buyer_interest_level === "hot").length`), "t").length === 0)
check("a file reading BOTH spellings takes the UNION (never a false entry)",
  scanInMemoryVocabulary(
    readOf("showings", `"buyer_interest_level"`, "") +
    readOf("showing_feedback", `"buyer_interest_level"`,
      `const n = list.filter((r) => r.buyer_interest_level === "hot" || r.buyer_interest_level === "love_it").length`),
    "t").length === 0)
check("flags a switch/case on a value the column can never hold",
  scanInMemoryVocabulary(readOf("showings", `"buyer_interest_level"`,
    `const n = list.map((r) => { switch (r.buyer_interest_level) { case "love_it": return 5; case "very_interested": return 5 } })`),
    "t").length === 1)
check("flags every bad element of an array .includes() membership test",
  scanInMemoryVocabulary(readOf("showings", `"buyer_interest_level"`,
    `const n = list.filter((r) => ["love_it", "very_interested"].includes(r.buyer_interest_level)).length`), "t").length === 1)
check("flags an ORDER comparison against a text enum (NaN on every row)",
  scanInMemoryVocabulary(readOf("showing_feedback", `"buyer_interest_level"`,
    `const hi = list.filter((f) => (f.buyer_interest_level ?? 0) >= 4).length`), "t").length === 1)
check("leaves an ORDER comparison on a NUMERIC-valued CHECK alone",
  scanInMemoryVocabulary(readOf("property_feedback", `"interest_level"`,
    `const hi = list.filter((f) => (f.interest_level ?? 0) >= 4).length`), "t").length === 0)
// THE RECEIVER CONTROL — 281 of the first cut's 331 findings were this shape:
// a `.status` that belongs to a Promise result, an HTTP response or a local
// return bag, in a file that merely happens to read a table with a status CHECK.
check("a `.status` that is NOT a tracked row is left alone",
  scanInMemoryVocabulary(readOf("listings", `"status"`,
    `const settled = await Promise.allSettled(jobs)\n` +
    `const okCount = settled.filter((r) => r.status === "fulfilled").length\n` +
    `if (res.status === "fail") return`), "t").length === 0)
check("…but the same literal ON A ROW is still flagged",
  scanInMemoryVocabulary(readOf("listings", `"status"`,
    `const okCount = list.filter((r) => r.status === "fulfilled").length`), "t").length === 1)
check("a row list survives .filter()/.slice() aliasing",
  scanInMemoryVocabulary(readOf("listings", `"status"`,
    `const recent = list.filter((r) => r.id)\n` +
    `const n = recent.filter((r) => r.status === "fulfilled").length`), "t").length === 1)
check("never reads its own documentation",
  scanInMemoryVocabulary(readOf("showings", `"buyer_interest_level"`,
    `const n = list.filter((r) => true).length\n// WAS: r.buyer_interest_level === "interested"`), "t").length === 0)
check("ignores an interpolation (only literals are checkable)",
  scanInMemoryVocabulary(readOf("showings", `"buyer_interest_level"`,
    "const n = list.filter((r) => r.buyer_interest_level === `${wanted}`).length"), "t").length === 0)
check("selectArgs keeps a nested embed inside its own select",
  selectArgs(`.select("id, feedback:showing_feedback(a, b)").eq("x", "y")`).length === 1)
check("rowVariables seeds from the destructured query result and follows the alias",
  (() => { const { rows } = rowVariables(readOf("listings", `"status"`, `const n = list.filter((r) => r.id).length`))
    return rows.has("rows") && rows.has("list") && rows.has("r") && !rows.has("settled")
      && [...(rows.get("r") ?? [])].join() === "listings" })())
// THE TABLE TRAVELS WITH THE VARIABLE. lib/portal/resolve-seller-context.ts is the
// case: it reads listings.status AND offers.status, and `offers.status` carries no
// CHECK at all — so `o.status === "accepted"` is nobody's violation. Judging on the
// file-wide union of the column NAME reported it as one.
check("a row from a table with NO CHECK on that column is not judged by another table's",
  scanInMemoryVocabulary(
    readOf("listings", `"status"`, "") +
    `const { data: offers } = await svc.from("offers").select("id, status")\n` +
    `const accepted = offers.find((o) => o.status === "accepted")`, "t").length === 0)

console.log("\n[repo scan]")
const files: string[] = []
for (const d of ["app", "lib", "services"]) for (const f of walkTs(join(root, d))) files.push(f)
// Root-level runtime FILES are not directories, so the loop above cannot reach them.
for (const f of rootRuntimeFiles(root)) files.push(f)

const found: VocabViolation[] = []
const memFound: MemVocabViolation[] = []
let memCorpus = 0
for (const f of files) {
  let src = ""
  try { src = readFileSync(f, "utf8") } catch { continue }
  if (!src.includes(".from(")) continue
  const rel = relative(root, f).replace(/\\/g, "/")
  found.push(...scanCheckVocabulary(src, rel))
  memCorpus++
  memFound.push(...scanInMemoryVocabulary(src, rel))
}
console.log(`  · ${files.length} files scanned · ${columnCount} enum columns across ${tableCount} tables`)
console.log(`  · in-memory detector denominator: ${memCorpus} files that both .from() an enum table and could compare in the same file`)

const baseline: string[] = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : []

if (process.env.UPDATE_CHECK_VOCAB_BASELINE === "1") {
  const next = [...new Set(found.map(key))].sort()
  writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n")
  console.log(`  · baseline rewritten with ${next.length} entries`)
  // BOTH baselines, in the one block. The exit used to sit here, so an update run
  // rewrote the filter baseline and never reached the in-memory one — the second
  // ratchet would have been silently un-updatable, which is the same shape of
  // "reports fine, did nothing" this whole guard exists to catch.
  const memNext = [...new Set(memFound.map(memKey))].sort()
  writeFileSync(MEM_BASELINE_PATH, JSON.stringify(memNext, null, 2) + "\n")
  console.log(`  · in-memory baseline rewritten with ${memNext.length} entries`)
  process.exit(0)
}

const baselineSet = new Set(baseline)
const fresh = found.filter((v) => !baselineSet.has(key(v)))
const stillPresent = new Set(found.map(key))
const fixed = baseline.filter((b) => !stillPresent.has(b))

check(`no NEW literal outside a live CHECK vocabulary (${found.length} total, ${baseline.length} baselined)`,
  fresh.length === 0,
  fresh.slice(0, 8).map((v) => `${v.file}: ${v.table}.${v.column} ${v.kind} "${v.value}"`).join("; "))
check(`the baseline only shrinks (${fixed.length} retired this run)`, true)

// ── Detector 2's own ratchet ────────────────────────────────────────────────
// A SEPARATE baseline file, because the two detectors' keys are different shapes
// and mixing them would let a burned-down in-memory finding be mistaken for a
// retired filter finding. Same guard, same proof, one owner (§6/§1: this claim —
// "a literal the column cannot hold" — already belongs here; a second guard on the
// same subject is the duplicate the orphan doctrine forbids).
const memBaseline: string[] = existsSync(MEM_BASELINE_PATH)
  ? JSON.parse(readFileSync(MEM_BASELINE_PATH, "utf8"))
  : []

const memBaselineSet = new Set(memBaseline)
const memFresh = memFound.filter((v) => !memBaselineSet.has(memKey(v)))
const memStill = new Set(memFound.map(memKey))
const memFixed = memBaseline.filter((b) => !memStill.has(b))

check(`no NEW in-memory comparison against a value the column can never hold (${memFound.length} total, ${memBaseline.length} baselined)`,
  memFresh.length === 0,
  memFresh.slice(0, 8).map((v) => `${v.file}: ${v.column} [${v.tables}] ${v.kind} "${v.value}"`).join("; "))
check(`the in-memory baseline only shrinks (${memFixed.length} retired this run)`, memFixed.length >= 0)

// The census is a DELIVERABLE, not just a pass/fail: a count with no way to read
// what it counted cannot be burned down. CHECK_VOCAB_DUMP=1 prints every finding.
if (process.env.CHECK_VOCAB_DUMP === "1") {
  console.log("\n[in-memory census — every finding]")
  for (const v of [...memFound].sort((a, b) => memKey(a).localeCompare(memKey(b)))) {
    console.log(`  ${v.file}\t${v.column}[${v.tables}]\t${v.kind}\t${v.value}`)
  }
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  console.log(" ❌ CHECK_VOCABULARY_FAIL — that value is not in the column's CHECK; the write is lost or the filter matches nothing")
  process.exit(1)
}
console.log(" ✅ CHECK_VOCABULARY_PASS — every literal the code writes or filters on is one the database admits")
