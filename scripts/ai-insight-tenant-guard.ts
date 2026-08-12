#!/usr/bin/env tsx
/**
 * scripts/ai-insight-tenant-guard.ts   (tsx scripts/ai-insight-tenant-guard.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * ELEVEN WRITERS OMITTED THE TENANT, AND THE READER'S COMMENT SAID OTHERWISE.
 *
 * `app/dashboard/agent/page.tsx` carried this, next to the query it described:
 *
 *     // … RLS scopes reads to the caller's brokerage.
 *
 * RLS did not. The policy on `ai_insights` is the migration-029 tenant shape —
 *
 *     USING (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())
 *
 * — so an UNTENANTED row belongs to everyone. And every one of the eleven
 * `ai_insights` inserts in `app/actions/ai-predictions.ts` omitted
 * `brokerage_id`, which made every insight this system has ever written
 * untenanted: 64 rows, 64 of them NULL, measured on the live database. The read
 * then widened further with `agent_id.is.null` and carried no brokerage
 * predicate at all, so the only tenant boundary in the whole path was the one
 * that was not there.
 *
 * Executed rather than reasoned about, `set local role authenticated` with each
 * tenant's jwt claims, in a transaction that was rolled back and verified
 * (`probe_leftovers = 0`): tenant B writes an insight the OLD way (no
 * brokerage_id), tenant A runs the OLD read → **1 row, tenant B's**. Tenant A
 * runs the NEW read → **0**. The policy's WITH CHECK does hold the stamp honest
 * (tenant A stamping tenant B's brokerage is refused 42501), which is exactly
 * why omitting the stamp — not forging it — was the whole defect.
 *
 * ── WHAT THIS GUARD STANDS OVER ──────────────────────────────────────────────
 *
 *   A1  ZERO BASELINE ON THE WRITE SIDE. No `.from("ai_insights").insert(…)`
 *       anywhere in app/ or lib/ may omit a top-level `brokerage_id` key. Zero,
 *       not a ratchet — there is no acceptable first one, because a single
 *       untenanted row is readable by every tenant on the platform.
 *
 *   A2  THE WRITERS STILL EXIST. At least the eleven sites this wave stamped are
 *       still present in ai-predictions.ts. A1 goes green just as happily
 *       against a file with no writers left in it, and "we deleted the feature"
 *       is not the same result as "we fixed it".
 *
 *   A3  THE READER CARRIES A CONJUNCTIVE BROKERAGE PREDICATE. Not merely the
 *       three letters `brokerage_id` somewhere in the chain: PostgREST's `.or()`
 *       WIDENS, so a brokerage term inside the `.or()` is the defect wearing the
 *       fix's clothes. The predicate must be its own `.eq` / `.in` / `.filter`
 *       link in the chain, which is what ANDs.
 *
 *   A4  THE WIDENING SURVIVES. `agent_id.is.null` is a deliberate product
 *       decision — unattributed insights belong to the desk — and A3 is what
 *       makes it widen WITHIN a tenant. Recorded so a later "tighten it" edit is
 *       a decision somebody makes, not one that happens.
 *
 *   A5  THE READ DESTRUCTURES `error`. supabase-js RESOLVES a refused query, so
 *       `const { data }` alone reads a refusal as an empty feed — and an empty
 *       feed is precisely what this card renders on success.
 *
 * ── HOW THIS PROOF IS BUILT ──────────────────────────────────────────────────
 *   · CONSTRUCTS, never spellings. The insert argument is located by a
 *     string-aware balanced-delimiter scan (template literals, nested objects
 *     and braces inside strings all appear in these call sites), and the key is
 *     required at DEPTH 1 of the object — `brokerage_id` nested inside
 *     `estimated_impact` is not a stamp, and a substring match cannot tell the
 *     difference. That case is negative-control #4.
 *   · Comments are stripped before every structural assertion. The defect this
 *     guard replaces was a COMMENT asserting a gate; prose is never evidence.
 *   · Every assertion carries a NEGATIVE CONTROL: the defect is written into the
 *     real file, THE PATCH IS VERIFIED TO HAVE APPLIED (a find-string that
 *     silently stops matching leaves the file untouched, the assertion green,
 *     and the control proving nothing), the check is required to flip RED, and
 *     the file is restored and re-verified by sha256.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const WRITERS = "app/actions/ai-predictions.ts"
const READER = "app/dashboard/agent/page.tsx"

/** The eleven sites wave 20 stamped. The writers may grow; they may not vanish. */
const WRITER_SITE_FLOOR = 11

const failures: string[] = []
function check(label: string, ok: boolean, detail = ""): boolean {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`)
    failures.push(label)
  }
  return ok
}

const raw = (p: string) => readFileSync(resolve(ROOT, p), "utf8")
const sha = (p: string) => createHash("sha256").update(raw(p)).digest("hex")

// ─────────────────────────────────────────────────────────────────────────────
// A string-aware scanner. Everything below depends on it, because these call
// sites contain template literals holding `${…}`, emoji, quotes and braces —
// a regex over the raw text cannot find the end of the insert argument.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Blank out comments while PRESERVING offsets, so every index computed against
 * the stripped text still points at the same character of the original. Strings
 * and template literals are skipped, so a `//` inside a URL is not a comment.
 */
function blankComments(src: string): string {
  const out = src.split("")
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") { out[i] = " "; i++ }
      continue
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2)
      const stop = end === -1 ? src.length : end + 2
      for (let k = i; k < stop; k++) if (src[k] !== "\n") out[k] = " "
      i = stop
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i)
      continue
    }
    i++
  }
  return out.join("")
}

/** Index just past the string/template starting at `start`. Handles `${…}`. */
function skipString(src: string, start: number): number {
  const quote = src[start]
  let i = start + 1
  while (i < src.length) {
    const c = src[i]
    if (c === "\\") { i += 2; continue }
    if (c === quote) return i + 1
    if (quote === "`" && c === "$" && src[i + 1] === "{") {
      i = skipBalanced(src, i + 1) // the `{ … }` of the interpolation
      continue
    }
    i++
  }
  return i
}

/**
 * Index just past the delimiter pair opening at `open` (which must be one of
 * `(` `{` `[`). String-aware, so braces inside strings never move the depth.
 */
function skipBalanced(src: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" }
  const stack: string[] = [pairs[src[open]]]
  let i = open + 1
  while (i < src.length && stack.length > 0) {
    const c = src[i]
    if (c === '"' || c === "'" || c === "`") { i = skipString(src, i); continue }
    if (c === "(" || c === "{" || c === "[") { stack.push(pairs[c]); i++; continue }
    if (c === stack[stack.length - 1]) { stack.pop(); i++; continue }
    i++
  }
  return i
}

/** The keys declared at DEPTH 1 of the object literal opening at `open`. */
function topLevelKeys(src: string, open: number): string[] {
  const keys: string[] = []
  let depth = 0
  let i = open
  let atKeyPosition = false
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === "`") { i = skipString(src, i); continue }
    if (c === "{" || c === "(" || c === "[") {
      depth++
      if (c === "{" && depth === 1) atKeyPosition = true
      else if (depth > 1) { i = skipBalanced(src, i) ; depth--; continue }
      i++
      continue
    }
    if (c === "}" || c === ")" || c === "]") {
      depth--
      if (depth === 0) return keys
      i++
      continue
    }
    if (depth === 1) {
      if (c === ",") { atKeyPosition = true; i++; continue }
      if (atKeyPosition && /[A-Za-z_$]/.test(c)) {
        const m = /^[A-Za-z0-9_$]+/.exec(src.slice(i))
        if (m) {
          const after = src.slice(i + m[0].length).match(/^\s*:/)
          if (after) keys.push(m[0])
          i += m[0].length
          atKeyPosition = false
          continue
        }
      }
      if (!/\s/.test(c)) atKeyPosition = false
    }
    i++
  }
  return keys
}

interface InsertSite {
  file: string
  line: number
  keys: string[]
  hasObjectArg: boolean
}

/**
 * Every `.from("ai_insights") … .insert(<object>)` in a file, with the keys the
 * object declares at depth 1.
 *
 * The `.insert(` is found by walking FORWARD from the `.from(` — the two are
 * usually adjacent but are freely allowed to be split across chained lines, and
 * anchoring on "the next `{`" would land inside `.select("…")` arguments or a
 * type annotation. The scan stops at the end of the statement.
 */
function aiInsightInsertSites(file: string): InsertSite[] {
  const src = blankComments(raw(file))
  const sites: InsertSite[] = []
  const from = /\.from\(\s*["']ai_insights["']\s*\)/g
  let m: RegExpExecArray | null
  while ((m = from.exec(src)) !== null) {
    const after = m.index + m[0].length
    // The chain that follows, bounded so a `.insert(` many statements later is
    // never mistaken for this one's.
    const window = src.slice(after, after + 4000)
    const ins = /^[\s\S]{0,400}?\.\s*(?:insert|upsert)\s*\(/.exec(window)
    if (!ins) continue
    const openParen = after + ins[0].length - 1
    // The argument. `.insert({…})` and `.insert([{…}])` both reach an object.
    let i = openParen + 1
    while (i < src.length && /[\s[]/.test(src[i])) i++
    const line = src.slice(0, m.index).split("\n").length
    if (src[i] !== "{") {
      sites.push({ file, line, keys: [], hasObjectArg: false })
      continue
    }
    sites.push({ file, line, keys: topLevelKeys(src, i), hasObjectArg: true })
  }
  return sites
}

/** Every tracked source file that mentions the table. */
function filesTouchingAiInsights(): string[] {
  try {
    const out = execFileSync(
      "git",
      ["grep", "-l", "--", 'from("ai_insights")', "--", "app", "lib", "scripts"],
      { cwd: ROOT, encoding: "utf8" },
    )
    return out.split("\n").filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
  } catch {
    return [WRITERS]
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A1 — every ai_insights insert stamps the tenant. Zero baseline.
// ─────────────────────────────────────────────────────────────────────────────
function assertEveryInsertStampsTenant(): boolean {
  const offenders: string[] = []
  let total = 0
  for (const f of filesTouchingAiInsights()) {
    if (!existsSync(resolve(ROOT, f))) continue
    for (const s of aiInsightInsertSites(f)) {
      total++
      if (!s.hasObjectArg) {
        offenders.push(`${f}:${s.line} (insert argument is not an object literal — cannot prove the stamp)`)
        continue
      }
      if (!s.keys.includes("brokerage_id")) offenders.push(`${f}:${s.line}`)
    }
  }
  return check(
    `A1  all ${total} ai_insights insert site(s) declare brokerage_id at the TOP LEVEL of the row`,
    offenders.length === 0,
    offenders.length === 0 ? "" : `unstamped: ${offenders.join(", ")}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// A2 — the writers are still there
// ─────────────────────────────────────────────────────────────────────────────
function assertWritersStillExist(): boolean {
  const n = aiInsightInsertSites(WRITERS).length
  return check(
    `A2  ${WRITERS} still holds >= ${WRITER_SITE_FLOOR} ai_insights writers (found ${n})`,
    n >= WRITER_SITE_FLOOR,
    n >= WRITER_SITE_FLOOR ? "" : `writers disappeared rather than being stamped`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The reader's query chain
// ─────────────────────────────────────────────────────────────────────────────
interface ChainLink {
  method: string
  args: string
}

/** The `.method(…)` links following the `.from("ai_insights")` in `file`. */
function readerChain(file: string): { links: ChainLink[]; fromIndex: number; src: string } | null {
  const src = blankComments(raw(file))
  const m = /\.from\(\s*["']ai_insights["']\s*\)/.exec(src)
  if (!m) return null
  const links: ChainLink[] = []
  let i = m.index + m[0].length
  for (;;) {
    const rest = src.slice(i)
    const next = /^\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(rest)
    if (!next) break
    const openParen = i + next[0].length - 1
    const close = skipBalanced(src, openParen)
    links.push({ method: next[1], args: src.slice(openParen + 1, close - 1) })
    i = close
  }
  return { links, fromIndex: m.index, src }
}

/** `.eq` / `.in` / `.filter` / `.match` links AND together in PostgREST. */
const CONJUNCTIVE = new Set(["eq", "in", "filter", "match", "is", "neq"])

// ─────────────────────────────────────────────────────────────────────────────
// A3 — a CONJUNCTIVE brokerage predicate, not a term inside the .or()
// ─────────────────────────────────────────────────────────────────────────────
function assertReaderNarrowsByBrokerage(): boolean {
  const chain = readerChain(READER)
  if (!chain) return check("A3  reader narrows by brokerage", false, `no ai_insights read found in ${READER}`)

  const narrowing = chain.links.filter(
    (l) => CONJUNCTIVE.has(l.method) && /["']brokerage_id["']/.test(l.args),
  )
  // A brokerage term inside `.or()` would WIDEN — the defect in the fix's
  // clothes. Named explicitly so the failure message says which one happened.
  const widening = chain.links.filter((l) => l.method === "or" && /brokerage_id/.test(l.args))

  return check(
    "A3  the reader ANDs a brokerage predicate onto the ai_insights read",
    narrowing.length > 0,
    narrowing.length > 0
      ? ""
      : widening.length > 0
        ? "brokerage_id appears only inside .or(), which WIDENS — it must be its own .eq/.in/.filter link"
        : `chain has no brokerage predicate: ${chain.links.map((l) => l.method).join(".")}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// A4 — the unattributed-insight widening survives, INSIDE the tenant
// ─────────────────────────────────────────────────────────────────────────────
function assertUnattributedWideningKept(): boolean {
  const chain = readerChain(READER)
  if (!chain) return check("A4  unattributed widening kept", false, `no ai_insights read found in ${READER}`)
  const widened = chain.links.some((l) => l.method === "or" && /agent_id\.is\.null/.test(l.args))
  return check(
    "A4  unattributed rows (agent_id IS NULL) are still included — the product decision, now tenant-bounded",
    widened,
    widened ? "" : "the .or(…agent_id.is.null) widening was dropped; that is a product decision, not a cleanup",
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// A5 — the read destructures `error`
// ─────────────────────────────────────────────────────────────────────────────
function assertReaderDestructuresError(): boolean {
  const chain = readerChain(READER)
  if (!chain) return check("A5  reader destructures error", false, `no ai_insights read found in ${READER}`)
  // Walk back to the assignment that owns this read. supabase-js resolves a
  // refusal, so `const { data }` alone renders a refused feed as an empty one.
  const before = chain.src.slice(Math.max(0, chain.fromIndex - 400), chain.fromIndex)
  const assign = /const\s*\{([^}]*)\}\s*=\s*await\s*[^;]*$/.exec(before)
  const bindings = assign ? assign[1] : ""
  const ok = /\berror\b/.test(bindings)
  return check(
    "A5  the ai_insights read destructures `error` (a refusal is not an empty feed)",
    ok,
    ok ? "" : `bindings were: {${bindings.trim()}}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// NEGATIVE CONTROLS
// ─────────────────────────────────────────────────────────────────────────────
interface Control {
  file: string
  find: string
  replace: string
}

/**
 * Apply a patch, VERIFY IT CHANGED THE FILE, run `fn`, require RED, restore,
 * verify the restore by sha256.
 *
 * The applied-check is the load-bearing part. A control whose find-string no
 * longer matches leaves the file untouched, the assertion stays green, and the
 * green gets read as "the control passed" when nothing was ever tested.
 */
function controlled(label: string, c: Control, fn: () => boolean): void {
  const before = raw(c.file)
  const beforeSha = sha(c.file)
  const after = before.replace(c.find, c.replace)

  if (after === before) {
    console.log(`  ✗ NEGATIVE CONTROL ${label} — PATCH DID NOT APPLY (find-string not found); control proves nothing`)
    failures.push(`negative control did not apply: ${label}`)
    return
  }

  writeFileSync(resolve(ROOT, c.file), after)
  let wentRed = false
  try {
    const marker = failures.length
    const ok = fn()
    wentRed = !ok
    while (failures.length > marker) failures.pop()
  } finally {
    writeFileSync(resolve(ROOT, c.file), before)
    if (sha(c.file) !== beforeSha) {
      failures.push(`FAILED TO RESTORE ${c.file}`)
      console.log(`  ✗ FAILED TO RESTORE ${c.file}`)
      return
    }
  }

  if (wentRed) {
    console.log(`  ✓ NEGATIVE CONTROL ${label} — went RED as required`)
  } else {
    console.log(`  ✗ NEGATIVE CONTROL ${label} — STAYED GREEN with the defect present`)
    failures.push(`negative control stayed green: ${label}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
function main(): void {
  console.log("AI-INSIGHTS TENANT GUARD\n")

  console.log("ASSERTIONS")
  assertEveryInsertStampsTenant()
  assertWritersStillExist()
  assertReaderNarrowsByBrokerage()
  assertUnattributedWideningKept()
  assertReaderDestructuresError()

  const scanned = filesTouchingAiInsights()
  const totalSites = scanned.reduce(
    (n, f) => n + (existsSync(resolve(ROOT, f)) ? aiInsightInsertSites(f).length : 0),
    0,
  )
  console.log(`\n  scanned ${scanned.length} file(s) touching ai_insights · ${totalSites} insert site(s)`)

  if (RUN_NEGATIVE) {
    console.log("\nNEGATIVE CONTROLS")

    // 1. One writer loses its stamp. This is the wave-20 defect exactly.
    controlled(
      "one ai_insights insert loses brokerage_id",
      {
        file: WRITERS,
        find: "          brokerage_id: dealBrokerageId,\n",
        replace: "",
      },
      assertEveryInsertStampsTenant,
    )

    // 2. A NEW unstamped writer is added — the way the eleven got there, by
    //    copying a neighbour. Patched into a real function body so it is real
    //    code in a real call position, not an appended stub.
    controlled(
      "a NEW unstamped ai_insights insert added to the writers file",
      {
        file: WRITERS,
        find: "    // Save negotiation strategy",
        replace:
          "    await supabase.from(\"ai_insights\").insert({\n" +
          "      insight_type: \"recommendation\",\n" +
          "      entity_type: \"transaction\",\n" +
          "      insight_title: \"nc probe\",\n" +
          "    })\n" +
          "    // Save negotiation strategy",
      },
      assertEveryInsertStampsTenant,
    )

    // 3. The stamp is present but WRAPPED across an intervening chained call —
    //    a line-oriented scan anchored on "the line after .insert(" sails past
    //    this. The construct scan must still find it and stay GREEN, so this
    //    control is inverted: it asserts the guard does NOT false-positive.
    {
      const c: Control = {
        file: WRITERS,
        find: "      const { error: negotiationInsightError } = await supabase.from(\"ai_insights\").insert({\n        brokerage_id: negotiationBrokerageId,",
        replace:
          "      const { error: negotiationInsightError } = await supabase\n        .from(\"ai_insights\")\n        .insert({\n        brokerage_id: negotiationBrokerageId,",
      }
      const before = raw(c.file)
      const patched = before.replace(c.find, c.replace)
      if (patched === before) {
        console.log("  ✗ NEGATIVE CONTROL the same insert split across chained lines — PATCH DID NOT APPLY")
        failures.push("negative control did not apply: wrapped insert")
      } else {
        const beforeSha = sha(c.file)
        writeFileSync(resolve(ROOT, c.file), patched)
        let stillGreen = false
        try {
          const marker = failures.length
          stillGreen = assertEveryInsertStampsTenant()
          while (failures.length > marker) failures.pop()
        } finally {
          writeFileSync(resolve(ROOT, c.file), before)
          if (sha(c.file) !== beforeSha) {
            failures.push(`FAILED TO RESTORE ${c.file}`)
            console.log(`  ✗ FAILED TO RESTORE ${c.file}`)
          }
        }
        if (stillGreen) {
          console.log("  ✓ NEGATIVE CONTROL the same insert split across chained lines — stayed GREEN (statement-level, as required)")
        } else {
          console.log("  ✗ NEGATIVE CONTROL the same insert split across chained lines — went RED; the scan is line-oriented")
          failures.push("wrapped-insert control went red: scan is line-oriented")
        }
      }
    }

    // 4. THE SPELLING TRAP. `brokerage_id` moved INSIDE estimated_impact — the
    //    three letters are still in the call, at the wrong depth, stamping
    //    nothing. A substring match cannot tell this from a fix.
    controlled(
      "brokerage_id demoted into a NESTED object (present as text, absent as a stamp)",
      {
        file: WRITERS,
        find: "        brokerage_id: negotiationBrokerageId,\n        insight_type: \"recommendation\",",
        replace: "        insight_type: \"recommendation\",",
      },
      () => {
        const p = resolve(ROOT, WRITERS)
        const cur = readFileSync(p, "utf8")
        const nested = cur.replace(
          "          win_probability: strategy.data.winProbability,",
          "          brokerage_id: negotiationBrokerageId,\n          win_probability: strategy.data.winProbability,",
        )
        if (nested === cur) {
          failures.push("nested-stamp control second patch did not apply")
          return false
        }
        writeFileSync(p, nested)
        return assertEveryInsertStampsTenant()
      },
    )

    // 5. The reader loses its brokerage predicate — the wave-20 read exactly.
    controlled(
      "the reader's brokerage predicate removed",
      {
        file: READER,
        find: '.eq("brokerage_id", agentRow.brokerage_id)\n            ',
        replace: "",
      },
      assertReaderNarrowsByBrokerage,
    )

    // 6. The brokerage term moved INTO the .or() — it now WIDENS instead of
    //    narrowing, which is the fix inverted and reads almost identically.
    controlled(
      "the brokerage term moved inside .or() (widens instead of narrowing)",
      {
        file: READER,
        find:
          '.eq("brokerage_id", agentRow.brokerage_id)\n            .or(`agent_id.eq.${agentRow.id},agent_id.is.null`)',
        replace:
          '.or(`brokerage_id.eq.${agentRow.brokerage_id},agent_id.eq.${agentRow.id},agent_id.is.null`)',
      },
      assertReaderNarrowsByBrokerage,
    )

    // 7. The unattributed widening dropped — a product decision, not a cleanup.
    controlled(
      "the agent_id IS NULL widening dropped",
      {
        file: READER,
        find: ".or(`agent_id.eq.${agentRow.id},agent_id.is.null`)",
        replace: '.eq("agent_id", agentRow.id)',
      },
      assertUnattributedWideningKept,
    )

    // 8. The read stops destructuring `error` — a refused feed becomes an empty
    //    one, silently, which is how this whole class of defect hides.
    controlled(
      "the reader stops destructuring `error`",
      {
        file: READER,
        find: "const { data: insightRows, error: insightsError } = await supabase",
        replace: "const { data: insightRows } = await supabase",
      },
      assertReaderDestructuresError,
    )

    // 9. The writers deleted rather than stamped — A1 alone would go green.
    controlled(
      "the writers file emptied of ai_insights inserts",
      {
        file: WRITERS,
        find: 'from("ai_insights")',
        replace: 'from("ai_insights_disabled")',
      },
      assertWritersStillExist,
    )
  }

  console.log("")
  if (failures.length) {
    console.log(`FAILED (${failures.length})`)
    for (const f of failures) console.log(`  · ${f}`)
    process.exit(1)
  }
  console.log("PASSED")
}

main()
