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
 * ── WAVE 21: THE SAME INVARIANT, THE OTHER THREE TABLES ──────────────────────
 *
 * This guard was EXTENDED rather than copied, because "no writer in this file
 * files a row without its tenant" is ONE invariant, and wave 20's own sweep of
 * `ai-predictions.ts` had already found the other three tables it applies to.
 * Three overlapping guards would each have to be kept in step with the same
 * scanner; one cannot drift from itself.
 *
 * The three tables fail in DIFFERENT directions, which is why they are asserted
 * together and described separately — measured on the live database, not assumed:
 *
 *   · `ai_predictions` CARRIES the escape. Its SELECT policy is
 *     `is_platform_admin() OR (brokerage_id IS NULL) OR has_brokerage_access(…)`,
 *     so an untenanted prediction is readable by EVERY tenant — the `ai_insights`
 *     exposure class exactly, on rows holding a named deal's close probability
 *     and a brokerage's negotiation band.
 *   · `ai_autopilot_plans` and `conversation_intelligence` do NOT carry it. Both
 *     are `is_platform_admin() OR has_brokerage_access(brokerage_id) OR
 *     (is_agent_role() AND agent_id = current_user_agent_id())`, and
 *     `has_brokerage_access` guards `target_brokerage_id IS NOT NULL` — so on an
 *     untenanted row THE BROKERAGE LANE IS DEAD. These rows do not leak; they are
 *     INVISIBLE to the broker and to platform admin, readable only by the one
 *     agent who wrote them. Stamping revives the lane the policy was written to
 *     provide; it takes nothing away.
 *
 *   B1  ZERO BASELINE ON ALL FOUR TABLES. Same construct, same depth-1 rule.
 *   B2  THE WRITERS STILL EXIST, per table and per file — a floor each, for the
 *       A2 reason: deleting a writer is not fixing it.
 *   B3  `getLeadPredictions` ANDs a brokerage predicate. It filtered
 *       `.eq("entity_id", leadId).in("entity_type", […])` and carried NO
 *       brokerage predicate at all, so with the escape in the policy the only
 *       boundary between one tenant's prediction and another's was a uuid.
 *   B4  ITS `entity_type` WIDENING SURVIVES. `predictLeadConversion` stamps
 *       either "lead" or "contact" depending on which class the id resolved to,
 *       so narrowing to one would hide half of what the writer writes. Recorded
 *       for the A4 reason.
 *   B5  `captureWinProbabilitySnapshot`'s dedupe read is TENANT-SCOPED and reads
 *       its `error`. The other two readers in that module are only ever reached
 *       with a SERVICE client (BYPASSRLS) — this one is not: its sole caller
 *       hands it the SESSION client, so it runs under the escape. A foreign
 *       untenanted snapshot matching on probability would report "unchanged
 *       claim" and silently suppress this tenant's frozen snapshot.
 *
 * ── WHY A SOURCE GUARD, WHEN THE DATABASE ALREADY BACK-FILLS ─────────────────
 *
 * Found by reading the live database rather than the migrations: all three
 * wave-21 tables carry a BEFORE INSERT trigger (`<table>_set_brokerage`) that
 * fills `brokerage_id` from the record the row is filed against when it is NULL.
 * That is a real net, and it is the reason these tables are not as exposed as the
 * audit assumed. It is NOT a boundary, and this guard does not stand down for it:
 *
 *   · `ai_predictions_set_brokerage` has branches for lead / contact /
 *     transaction / agent and NONE for `property` — which is exactly the row
 *     `predictWinningOffer` writes. Proven live: brokerage_id NULL, and the
 *     tenant-A read that carried no brokerage predicate returned tenant B's rows.
 *   · Every one of the three is SECURITY INVOKER, so its lookup runs under the
 *     INSERTING caller's RLS and yields NULL — silently — whenever that caller
 *     cannot read the anchor record. Also proven live.
 *   · All three fire only `IF NEW.brokerage_id IS NULL`, so an application stamp
 *     always wins and the two mechanisms never contradict each other.
 *
 * A guard that trusted the trigger would be a comment asserting a gate, which is
 * the exact defect wave 20 named. The stamp is asserted in the source.
 *
 * ── WAVE 23: THE TWO HEAVIEST TABLES, AND A READER EVERY USER SEES ───────────
 *
 * EXTENDED AGAIN rather than copied, for wave 21's reason: "no writer files a row
 * without its tenant" is ONE invariant and this file already owns its scanner.
 * `notifications` and `automation_errors` are the two heaviest escape tables in
 * W22-4's census (16 and 17 unstamped sites), and both are TENANT-CLASS — decided
 * by reading their readers, never their names.
 *
 * BOTH FAIL THE SAME WAY, AND IT IS NOT THE LEAK. Both carry the escape
 * (`brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`), so RLS
 * admits an untenanted row to everyone. But every application reader ANDs an
 * EQUALITY predicate, and `NULL = <uuid>` is NULL, never true — so the row is
 * filtered out of the surface that owns it:
 *
 *   · `app/api/dashboard/badge-counts/route.ts` — THE UNREAD BADGE COUNT EVERY
 *     USER SEES. It resolves `brokerage_id` from the SESSION USER's `users` row
 *     and then filters `.eq("brokerage_id", …).eq("user_id", …).eq("is_read", false)`.
 *     An unstamped notification is written and never counted: the row exists, the
 *     bell stays dark.
 *   · `app/api/cron/qbr-invitations/route.ts` and
 *     `lib/transactions/stranded-offer-reaper.ts` use their reads to decide
 *     "have we already told them?", so an unstamped row ALSO FAILS TO SUPPRESS —
 *     the same QBR invitation and the same stranded-offer alert fire again.
 *   · `app/actions/workflows.ts:retryFailedWorkflow` reads `automation_errors`
 *     `.eq("brokerage_id", brokerageId)` as an OWNERSHIP CHECK and returns
 *     "Forbidden" on a miss. An untenanted automation error is therefore invisible
 *     in the automations console AND UN-RESOLVABLE THROUGH IT, forever.
 *   · `app/actions/system-health.ts:getAutomationErrors` filters the same way, and
 *     its `HEALTH_READER_ROLES` is ["superadmin","admin","broker"] — broker is a
 *     TENANT role, which is what settles the class.
 *
 * NEITHER TABLE HAS A BACK-FILL TRIGGER. Measured live: `pg_trigger` returns zero
 * non-internal triggers for both. Unlike the wave-21 tables there is no net at
 * all — the application stamp is the only mechanism.
 *
 *   C1  ZERO BASELINE ON BOTH TABLES, across app/ and lib/. Same construct, same
 *       depth-1 rule. Scoped to the production surfaces on purpose: the
 *       `scripts/*-simulator.ts` proofs carry defective inserts as STRING
 *       FIXTURES (their own negative-control patch text), and a source scan that
 *       blanked string contents could not find `.from("<table>")` at all. That is
 *       a scoping decision with a reason, not an exemption of a real writer —
 *       specificity control S3 keeps it honest.
 *   C2  THE WRITERS STILL EXIST, per file. A2's reason on both tables.
 *   C3  THE BADGE COUNT STILL NARROWS BY BROKERAGE, and its `users` read
 *       destructures `error`. That read produces the value every writer stamps;
 *       refused, it yields `brokerageId = null` and EVERY badge silently reports
 *       zero.
 *   C4  BOTH SUPPRESSION READS still AND a brokerage predicate AND destructure
 *       `error`. A refused dedupe read that arrives as "no prior row" duplicates
 *       the message — the identical outcome to the unstamped row this wave fixed,
 *       reached by the other door.
 *   C5  THE AUTOMATIONS-CONSOLE OWNERSHIP CHECK still ANDs its brokerage
 *       predicate. Dropping it would turn "Forbidden" into "any brokerage may
 *       resolve any error".
 *   C6  THE EXPLICITLY-UNTENANTED SITES ARE EXACTLY THE DEFENDED SIX.
 *       `brokerage_id: null` at depth 1 counts as a stamp for C1 — an explicit,
 *       greppable decision is not the same thing as an omission — which would
 *       otherwise make `brokerage_id: null` a way to turn C1 green without
 *       thinking. C6 pins the allow-list so a seventh cannot appear quietly.
 *   C7  NO `notifications` WRITER PUTS AN AGENT ID IN `user_id`.
 *       `notifications.user_id` is `REFERENCES users(id)`, and `agents.id` is a
 *       DISJOINT space — three sites were passing one (widget intake, agent
 *       certification, the portal learn client), so those inserts were refused
 *       23503 and the refusals were discarded. Asserted on the VALUE EXPRESSION at
 *       depth 1, which is where the id space is visible.
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
const OUTCOMES = "lib/analytics/ai-prediction-outcomes.ts"

/** The eleven sites wave 20 stamped. The writers may grow; they may not vanish. */
const WRITER_SITE_FLOOR = 11

/**
 * Every table in this file's blast radius whose tenant policy makes an
 * unstamped row wrong — in EITHER direction. Zero baseline on all of them.
 */
const TENANT_TABLES = ["ai_insights", "ai_predictions", "ai_autopilot_plans", "conversation_intelligence"] as const

/**
 * Per-table writer floors, per file. A2's reason, applied per table: A1/B1 go
 * green just as happily against a file with no writers left in it.
 */
const WRITER_FLOORS: Array<{ file: string; table: string; floor: number }> = [
  { file: WRITERS, table: "ai_predictions", floor: 3 },
  { file: WRITERS, table: "ai_autopilot_plans", floor: 1 },
  { file: WRITERS, table: "conversation_intelligence", floor: 1 },
  { file: OUTCOMES, table: "ai_predictions", floor: 1 },
]

/**
 * This guard quotes `.from("<table>")` in its own negative-control patches, so
 * it would otherwise scan itself. Excluded by construction rather than by luck.
 */
const SELF = "scripts/ai-insight-tenant-guard.ts"

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

/**
 * The properties declared at DEPTH 1 of the object literal opening at `open`,
 * with the source text of each value.
 *
 * SHORTHAND COUNTS. `{ brokerage_id, type, title }` stamps the tenant exactly as
 * `{ brokerage_id: brokerage_id, … }` does, and requiring the colon reported
 * `app/api/widget/intake/route.ts` as unstamped when it was not — a FALSE RED,
 * which is the failure mode that gets a guard switched off. An identifier at key
 * position followed by `,` or `}` is a shorthand property; its value text is the
 * identifier itself.
 */
function topLevelProps(src: string, open: number): Array<{ key: string; value: string }> {
  const props: Array<{ key: string; value: string }> = []
  let depth = 0
  let i = open
  let atKeyPosition = false
  let pending: { key: string; from: number } | null = null
  const closePending = (end: number) => {
    if (pending) {
      props.push({ key: pending.key, value: src.slice(pending.from, end).trim() })
      pending = null
    }
  }
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
      if (depth === 0) { closePending(i); return props }
      i++
      continue
    }
    if (depth === 1) {
      if (c === ",") { closePending(i); atKeyPosition = true; i++; continue }
      if (atKeyPosition && /[A-Za-z_$]/.test(c)) {
        const m = /^[A-Za-z0-9_$]+/.exec(src.slice(i))
        if (m) {
          const rest = src.slice(i + m[0].length)
          if (/^\s*:/.test(rest)) {
            const colon = i + m[0].length + rest.indexOf(":")
            pending = { key: m[0], from: colon + 1 }
          } else if (/^\s*[,}]/.test(rest)) {
            // Shorthand property — the identifier IS both key and value.
            props.push({ key: m[0], value: m[0] })
          }
          i += m[0].length
          atKeyPosition = false
          continue
        }
      }
      if (!/\s/.test(c)) atKeyPosition = false
    }
    i++
  }
  closePending(i)
  return props
}

/** The keys declared at DEPTH 1 of the object literal opening at `open`. */
function topLevelKeys(src: string, open: number): string[] {
  return topLevelProps(src, open).map((p) => p.key)
}

interface InsertSite {
  file: string
  line: number
  keys: string[]
  props: Array<{ key: string; value: string }>
  hasObjectArg: boolean
  /** True when the row object was reached through a `.map(… => ({…}))` fan-out. */
  viaRowMapper: boolean
}

/**
 * The body of `function <name>(…)`, as a `[start, end)` span into `src`.
 *
 * THE BRACE-MATCHING TRAP: "the first `{` after the name" is wrong twice over —
 * a DESTRUCTURED PARAMETER (`function f({ a, b })`) puts a `{` before the
 * parameter list even closes, and a RETURN TYPE (`function f(): { a: number }`)
 * puts one after it. So the parameter list is skipped as a balanced group first,
 * and then the candidate `{` is disambiguated by what FOLLOWS it: if the next
 * non-space character after the balanced group is another `{`, the group just
 * skipped was the return type and the body is the next one.
 */
function functionBody(src: string, name: string): [number, number] | null {
  const decl = new RegExp(`function\\s+${name}\\s*(?=[(<])`).exec(src)
  if (!decl) return null
  let i = decl.index + decl[0].length
  // A generic parameter list, if any, before the value parameters.
  while (i < src.length && /\s/.test(src[i])) i++
  if (src[i] === "<") i = skipBalancedAngle(src, i)
  while (i < src.length && /\s/.test(src[i])) i++
  if (src[i] !== "(") return null
  i = skipBalanced(src, i) // past the parameter list, destructuring and all
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++
    if (i >= src.length) return null
    if (src[i] === "<") {
      // A type-argument list in the return type. It is skipped WHOLE, because
      // `Promise<{ captured: boolean }>` hides a brace that is not the body —
      // stepping into it returns the type object as the function body.
      i = skipBalancedAngle(src, i)
      continue
    }
    if (src[i] !== "{") {
      // A return-type annotation with no brace of its own (`: Promise<void>`),
      // or modifiers — step over one character and look again.
      if (src[i] === ";") return null
      i++
      continue
    }
    const close = skipBalanced(src, i)
    let j = close
    while (j < src.length && /\s/.test(src[j])) j++
    if (src[j] === "{") { i = j; continue } // that was the return type
    return [i, close]
  }
}

/** Index just past the `<…>` group opening at `open`. */
function skipBalancedAngle(src: string, open: number): number {
  let depth = 0
  let i = open
  while (i < src.length) {
    const c = src[i]
    if (c === "<") depth++
    else if (c === ">") { depth--; if (depth === 0) return i + 1 }
    else if (c === '"' || c === "'" || c === "`") { i = skipString(src, i); continue }
    i++
  }
  return i
}

/**
 * Every `.from("<table>") … .insert(<object>)` in a file, with the keys the
 * object declares at depth 1.
 *
 * The `.insert(` is found by walking FORWARD from the `.from(` — the two are
 * usually adjacent but are freely allowed to be split across chained lines, and
 * anchoring on "the next `{`" would land inside `.select("…")` arguments or a
 * type annotation. The scan stops at the end of the statement.
 */
function insertSites(file: string, table: string): InsertSite[] {
  const src = blankComments(raw(file))
  const sites: InsertSite[] = []
  const from = new RegExp(`\\.from\\(\\s*["']${table}["']\\s*\\)`, "g")
  let m: RegExpExecArray | null
  while ((m = from.exec(src)) !== null) {
    const after = m.index + m[0].length
    // The chain that follows, bounded so a `.insert(` many statements later is
    // never mistaken for this one's — AND CUT AT THE NEXT `.from(`, because a
    // READ on this table followed by an INSERT on a DIFFERENT one otherwise gets
    // attributed here. That produced 26 phantom sites across the two wave-23
    // tables, each of them "unstamped" rows belonging to another table entirely.
    let window = src.slice(after, after + 4000)
    const nextFrom = window.search(/\.\s*from\s*\(/)
    if (nextFrom !== -1) window = window.slice(0, nextFrom)
    const ins = /^[\s\S]{0,400}?\.\s*(?:insert|upsert)\s*\(/.exec(window)
    if (!ins) continue
    const openParen = after + ins[0].length - 1
    const line = src.slice(0, m.index).split("\n").length
    const resolved = resolveRowObject(src, openParen)
    if (resolved === null) {
      sites.push({ file, line, keys: [], props: [], hasObjectArg: false, viaRowMapper: false })
      continue
    }
    const props = topLevelProps(src, resolved.open)
    sites.push({ file, line, keys: props.map((p) => p.key), props, hasObjectArg: true, viaRowMapper: resolved.viaRowMapper })
  }
  return sites
}

/**
 * The `{` that opens the ROW object of an insert whose argument list starts at
 * `openParen`.
 *
 * Three shapes reach a row object, and a fan-out insert is a real writer:
 *   1. `.insert({ … })` / `.insert([{ … }])`  — the direct object.
 *   2. `.insert(xs.map((x) => ({ … })))`      — an INLINE row mapper.
 *   3. `.insert(rows)` where `const rows = xs.map((x) => ({ … }))` earlier in
 *      the file — a NAMED row mapper.
 *
 * Shapes 2 and 3 are how ten of this tree's `notifications` writers are spelled
 * (every multi-recipient fan-out), and treating them as "argument is not an
 * object literal — cannot prove the stamp" would have made the zero baseline
 * unachievable for a correctly-stamped tree. `null` still means genuinely
 * unresolvable, which stays an offender: a stamp that cannot be seen is not a
 * stamp that can be trusted.
 */
function resolveRowObject(src: string, openParen: number): { open: number; viaRowMapper: boolean } | null {
  const close = skipBalanced(src, openParen)
  const argText = src.slice(openParen + 1, close - 1)

  // 1 — the direct object, optionally inside an array literal.
  let i = openParen + 1
  while (i < close && /[\s[]/.test(src[i])) i++
  if (src[i] === "{") return { open: i, viaRowMapper: false }

  // 2 — an inline `… => ({ … })` row mapper anywhere in the argument.
  const inline = findArrowObject(src, openParen + 1, close - 1)
  if (inline !== null) return { open: inline, viaRowMapper: true }

  // 3 — a bare identifier argument, bound earlier to a row mapper.
  const ident = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(argText)
  if (!ident) return null
  const decl = new RegExp(`(?:const|let|var)\\s+${ident[1]}\\s*(?::[^=]*)?=`, "g")
  let d: RegExpExecArray | null
  let best: number | null = null
  while ((d = decl.exec(src)) !== null) {
    if (d.index >= openParen) break
    const bodyStart = d.index + d[0].length
    const bodyEnd = initializerEnd(src, bodyStart)
    const arrow = findArrowObject(src, bodyStart, bodyEnd)
    if (arrow !== null) best = arrow
  }
  return best === null ? null : { open: best, viaRowMapper: true }
}

/**
 * The end of the initializer expression that starts at `start` (just past an
 * `=`), as an index into `src`. DEPTH-TRACKED, not line-oriented.
 *
 * The line-oriented version this replaced cut the initializer at the first
 * newline followed by `const` / `let` / `var` / `return` / `await` / `if` — which
 * is inside the mapper for any row builder with a block body, because such a body
 * opens with exactly those keywords. `lib/social/orchestrate-social-preset-
 * publish.ts` binds `const rowsToInsert = preset.target_platforms.map((platform)
 * => { const raw = … ; return { brokerage_id: …, … } })`, and the cut landed on
 * that inner `const`, three lines before the row object. The scan then reported a
 * correctly-stamped writer as unprovable.
 *
 * Depth tracking gets it right for free: everything between `.map(` and its
 * matching `)` is at depth ≥ 1, so no newline inside the mapper can end the
 * statement. A `;`, or a newline at depth 0, does.
 */
function initializerEnd(src: string, start: number): number {
  const cap = Math.min(src.length, start + 8000)
  let i = start
  let depth = 0
  while (i < cap) {
    const c = src[i]
    if (c === '"' || c === "'" || c === "`") { i = skipString(src, i); continue }
    if (c === "(" || c === "{" || c === "[") { depth++; i++; continue }
    if (c === ")" || c === "}" || c === "]") {
      if (depth === 0) return i // the enclosing group closed — the statement is over
      depth--; i++; continue
    }
    if (depth === 0 && c === ";") return i
    if (depth === 0 && c === "\n") return i
    i++
  }
  return cap
}

/**
 * The `{` of the first row object produced by an arrow function between `lo` and
 * `hi`, string-aware. TWO SPELLINGS, because both are real in this tree:
 *
 *   · `=> ({ … })`                 — the concise body.
 *   · `=> { … return { … } }`      — the BLOCK body, whose row object is behind a
 *                                    `return`, not behind the arrow.
 *
 * Wave 24 added the second. `lib/social/orchestrate-social-preset-publish.ts`
 * expands a preset into one `social_posts` row per platform with
 * `preset.target_platforms.map((platform) => { … return { brokerage_id: …, … } })`
 * — CORRECTLY STAMPED, and reported by the concise-body-only scan as "insert
 * argument resolves to no object literal", i.e. an offender. A guard that calls a
 * correct writer broken is the failure mode that gets a guard switched off, and
 * it is the same class as the shorthand-property false red wave 23 found.
 *
 * The block body's `{` is skipped WHOLE and the search resumes after it when no
 * `return {` is found inside, so an arrow that returns something other than an
 * object literal does not swallow the rest of the window.
 */
function findArrowObject(src: string, lo: number, hi: number): number | null {
  let i = lo
  while (i < hi) {
    const c = src[i]
    if (c === '"' || c === "'" || c === "`") { i = skipString(src, i); continue }
    if (c === "=" && src[i + 1] === ">") {
      let j = i + 2
      while (j < hi && /\s/.test(src[j])) j++
      if (src[j] === "(") {
        let k = j + 1
        while (k < hi && /\s/.test(src[k])) k++
        if (src[k] === "{") return k
      }
      if (src[j] === "{") {
        // A BLOCK body. Its row object is whatever a `return` hands back, so the
        // search is scoped to the block and anchored on `return {` rather than on
        // the arrow. Bounded by the block's own extent, never past it.
        const blockEnd = Math.min(skipBalanced(src, j), hi)
        const ret = findReturnObject(src, j + 1, blockEnd)
        if (ret !== null) return ret
        i = blockEnd
        continue
      }
      i = j
      continue
    }
    i++
  }
  return null
}

/**
 * The `{` of the first `return { … }` (or `return ({ … })`) between `lo` and
 * `hi`, string-aware. The parenthesised form is accepted because it is the same
 * row object with a redundant wrapper — rejecting it would make a correct writer
 * unprovable on a formatting choice, which is the false-red class again.
 */
function findReturnObject(src: string, lo: number, hi: number): number | null {
  let i = lo
  while (i < hi) {
    const c = src[i]
    if (c === '"' || c === "'" || c === "`") { i = skipString(src, i); continue }
    if (c === "r" && /^return\b/.test(src.slice(i, i + 7)) && !/[A-Za-z0-9_$.]/.test(src[i - 1] ?? " ")) {
      let j = i + 6
      while (j < hi && /\s/.test(src[j])) j++
      if (src[j] === "(") { j++; while (j < hi && /\s/.test(src[j])) j++ }
      if (src[j] === "{") return j
      i = j
      continue
    }
    i++
  }
  return null
}

/** The `ai_insights` sites — A1/A2 keep their exact original meaning. */
const aiInsightInsertSites = (file: string): InsertSite[] => insertSites(file, "ai_insights")

/** Every tracked source file that mentions the table. */
function filesTouching(table: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["grep", "-l", "--", `from("${table}")`, "--", "app", "lib", "scripts"],
      { cwd: ROOT, encoding: "utf8" },
    )
    return out
      .split("\n")
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
      .filter((f) => f !== SELF)
  } catch {
    return [WRITERS]
  }
}

const filesTouchingAiInsights = (): string[] => filesTouching("ai_insights")

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

/**
 * The `.method(…)` links following a `.from("<table>")` in `file`, optionally
 * restricted to the body of one named function — which is how the ONE read that
 * belongs to `getLeadPredictions` is separated from the three other
 * `.from("ai_predictions")` chains in the same file.
 */
function tableChain(
  file: string,
  table: string,
  fnName?: string,
): { links: ChainLink[]; fromIndex: number; src: string } | null {
  const full = blankComments(raw(file))
  let lo = 0
  let hi = full.length
  if (fnName) {
    const span = functionBody(full, fnName)
    if (!span) return null
    ;[lo, hi] = span
  }
  const re = new RegExp(`\\.from\\(\\s*["']${table}["']\\s*\\)`, "g")
  re.lastIndex = lo
  const m = re.exec(full)
  if (!m || m.index >= hi) return null
  const src = full
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

const readerChain = (file: string) => tableChain(file, "ai_insights")

/** `.eq` / `.in` / `.filter` / `.match` links AND together in PostgREST. */
const CONJUNCTIVE = new Set(["eq", "in", "filter", "match", "is", "neq"])

/**
 * A brokerage predicate that ANDs. Shared by A3 and B3 so the two cannot drift:
 * a term inside `.or()` WIDENS, which is the fix inverted and reads almost
 * identically at a glance.
 */
function brokeragePredicateVerdict(
  chain: { links: ChainLink[] },
): { narrowed: boolean; detail: string } {
  const narrowing = chain.links.filter((l) => CONJUNCTIVE.has(l.method) && /["']brokerage_id["']/.test(l.args))
  const widening = chain.links.filter((l) => l.method === "or" && /brokerage_id/.test(l.args))
  if (narrowing.length > 0) return { narrowed: true, detail: "" }
  return {
    narrowed: false,
    detail:
      widening.length > 0
        ? "brokerage_id appears only inside .or(), which WIDENS — it must be its own .eq/.in/.filter link"
        : `chain has no brokerage predicate: ${chain.links.map((l) => l.method).join(".")}`,
  }
}

/**
 * Does the assignment owning the read at `fromIndex` destructure `error`?
 *
 * THE LAST OPEN ASSIGNMENT, NOT THE FIRST. `.exec` returns the earliest match,
 * and this tree writes no semicolons — so `[^;]*$` let an assignment from an
 * EARLIER statement stretch all the way to the read and answer on its behalf.
 * Measured on `app/actions/seller-open-house.ts:endOpenHouseEvent`, where the
 * attendee read was NOT destructured and the helper reported `{error: updateErr}`
 * from the `open_house_events` update three lines above it: a false GREEN on the
 * exact property the assertion exists to catch. Wave 24 takes the LAST `const {…}
 * = await` in the window and requires no `;` between it and the read.
 */
function destructuresError(src: string, fromIndex: number): { ok: boolean; bindings: string } {
  const before = src.slice(Math.max(0, fromIndex - 400), fromIndex)
  const decl = /const\s*\{([^}]*)\}\s*=\s*await\b/g
  let m: RegExpExecArray | null
  let last: RegExpExecArray | null = null
  while ((m = decl.exec(before)) !== null) last = m
  let bindings = ""
  if (last && !/;/.test(before.slice(last.index + last[0].length))) bindings = last[1]
  return { ok: /\berror\b/.test(bindings), bindings }
}

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
// B1 — the same zero baseline across ALL FOUR tenant tables
// ─────────────────────────────────────────────────────────────────────────────
function assertEveryTenantTableInsertStampsTenant(): boolean {
  const offenders: string[] = []
  let total = 0
  for (const table of TENANT_TABLES) {
    for (const f of filesTouching(table)) {
      if (!existsSync(resolve(ROOT, f))) continue
      for (const s of insertSites(f, table)) {
        total++
        if (!s.hasObjectArg) {
          offenders.push(`${f}:${s.line} ${table} (insert argument is not an object literal — cannot prove the stamp)`)
          continue
        }
        if (!s.keys.includes("brokerage_id")) offenders.push(`${f}:${s.line} ${table}`)
      }
    }
  }
  return check(
    `B1  all ${total} insert site(s) across ${TENANT_TABLES.length} tenant table(s) declare brokerage_id at the TOP LEVEL of the row`,
    offenders.length === 0,
    offenders.length === 0 ? "" : `unstamped: ${offenders.join(", ")}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// B2 — per-table, per-file writer floors
// ─────────────────────────────────────────────────────────────────────────────
function assertWaveTwentyOneWritersStillExist(): boolean {
  const short: string[] = []
  for (const { file, table, floor } of WRITER_FLOORS) {
    const n = existsSync(resolve(ROOT, file)) ? insertSites(file, table).length : 0
    if (n < floor) short.push(`${file} ${table}: ${n} < ${floor}`)
  }
  return check(
    `B2  every wave-21 writer still exists (${WRITER_FLOORS.length} table/file floors)`,
    short.length === 0,
    short.length === 0 ? "" : `writers disappeared rather than being stamped — ${short.join("; ")}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// B3 — getLeadPredictions ANDs a brokerage predicate onto the ai_predictions read
// ─────────────────────────────────────────────────────────────────────────────
function assertLeadPredictionsReaderNarrows(): boolean {
  const chain = tableChain(WRITERS, "ai_predictions", "getLeadPredictions")
  if (!chain) {
    return check("B3  getLeadPredictions narrows by brokerage", false, `no ai_predictions read found in getLeadPredictions (${WRITERS})`)
  }
  const v = brokeragePredicateVerdict(chain)
  return check("B3  getLeadPredictions ANDs a brokerage predicate onto the ai_predictions read", v.narrowed, v.detail)
}

// ─────────────────────────────────────────────────────────────────────────────
// B4 — its entity_type widening survives, inside the tenant
// ─────────────────────────────────────────────────────────────────────────────
function assertLeadPredictionsEntityTypeWideningKept(): boolean {
  const chain = tableChain(WRITERS, "ai_predictions", "getLeadPredictions")
  if (!chain) {
    return check("B4  getLeadPredictions keeps its entity_type widening", false, `no ai_predictions read found in getLeadPredictions`)
  }
  const widened = chain.links.some(
    (l) =>
      CONJUNCTIVE.has(l.method) &&
      /["']entity_type["']/.test(l.args) &&
      /["']lead["']/.test(l.args) &&
      /["']contact["']/.test(l.args),
  )
  return check(
    'B4  both id classes still read ("lead" AND "contact") — predictLeadConversion stamps either, now within a tenant',
    widened,
    widened ? "" : "the entity_type widening was narrowed; that hides half of what the writer writes — a product decision, not a cleanup",
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// B5 — the ONE ai_predictions read that is NOT on the service client
// ─────────────────────────────────────────────────────────────────────────────
function assertSnapshotDedupeIsTenantScoped(): boolean {
  const chain = tableChain(OUTCOMES, "ai_predictions", "captureWinProbabilitySnapshot")
  if (!chain) {
    return check("B5  the win-probability dedupe read is tenant-scoped", false, `no ai_predictions read found in captureWinProbabilitySnapshot (${OUTCOMES})`)
  }
  const v = brokeragePredicateVerdict(chain)
  const narrowed = check(
    "B5a the win-probability dedupe read ANDs a brokerage predicate (its caller passes the SESSION client, not the service one)",
    v.narrowed,
    v.detail,
  )
  const e = destructuresError(chain.src, chain.fromIndex)
  const errored = check(
    "B5b that read destructures `error` (a refused dedupe must not read as 'no prior snapshot')",
    e.ok,
    e.ok ? "" : `bindings were: {${e.bindings.trim()}}`,
  )
  return narrowed && errored
}

// ─────────────────────────────────────────────────────────────────────────────
// B6 — getLeadPredictions destructures `error`
// ─────────────────────────────────────────────────────────────────────────────
function assertLeadPredictionsReaderDestructuresError(): boolean {
  const chain = tableChain(WRITERS, "ai_predictions", "getLeadPredictions")
  if (!chain) {
    return check("B6  getLeadPredictions destructures error", false, "no ai_predictions read found in getLeadPredictions")
  }
  const e = destructuresError(chain.src, chain.fromIndex)
  return check(
    "B6  the getLeadPredictions read destructures `error` (a refusal is not an empty history)",
    e.ok,
    e.ok ? "" : `bindings were: {${e.bindings.trim()}}`,
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// WAVE 23 — notifications · automation_errors
// ═════════════════════════════════════════════════════════════════════════════

const BADGE_READER = "app/api/dashboard/badge-counts/route.ts"
const QBR_READER = "app/api/cron/qbr-invitations/route.ts"
const STRANDED_READER = "lib/transactions/stranded-offer-reaper.ts"
const CONSOLE_OWNERSHIP = "app/actions/workflows.ts"

/** The two heaviest escape tables in W22-4's census. Both tenant-class BY THEIR READERS. */
const W23_TABLES = ["notifications", "automation_errors"] as const

/**
 * Writer floors, per file and table. A2's reason: C1 is just as green against a
 * file with no writers left in it, and "we deleted the feature" is not "we fixed
 * it". One floor per file this wave touched.
 */
const W23_WRITER_FLOORS: Array<{ file: string; table: string; floor: number }> = [
  { file: "app/actions/ai-agent-onboarding.ts", table: "notifications", floor: 1 },
  { file: "app/actions/assistant.ts", table: "notifications", floor: 1 },
  { file: "app/actions/copilot.ts", table: "notifications", floor: 2 },
  { file: "app/actions/credit-copilot.ts", table: "notifications", floor: 3 },
  { file: "app/actions/social-publishing.ts", table: "notifications", floor: 1 },
  { file: "app/actions/video-content.ts", table: "notifications", floor: 3 },
  { file: "app/actions/portal-education.ts", table: "notifications", floor: 1 },
  { file: "app/api/widget/intake/route.ts", table: "notifications", floor: 1 },
  { file: "lib/kernel/onboarding-reminders.ts", table: "notifications", floor: 1 },
  { file: "lib/notifications/platform-staff.ts", table: "notifications", floor: 1 },
  { file: "lib/platform/prospect-sourcer.ts", table: "notifications", floor: 1 },
  { file: "app/actions/lead-governance/govern-lead.ts", table: "automation_errors", floor: 1 },
  { file: "lib/ai-isa/direct-mail-trigger.ts", table: "automation_errors", floor: 1 },
  { file: "lib/communication-spine/ingest-message-service.ts", table: "automation_errors", floor: 1 },
  { file: "lib/communication-spine/message-persister.ts", table: "automation_errors", floor: 1 },
  { file: "lib/contact-promotion/promote-lead-to-contact.ts", table: "automation_errors", floor: 2 },
  { file: "lib/lead-promotion/initial-scorer.ts", table: "automation_errors", floor: 1 },
  { file: "lib/lead-readiness/readiness-logger.ts", table: "automation_errors", floor: 2 },
  { file: "lib/vendor-governance/usage-logger.ts", table: "automation_errors", floor: 2 },
]

/**
 * THE ONLY SITES ALLOWED TO STAMP `brokerage_id: null` ON PURPOSE.
 *
 * Six writes, one class: an OUTER catch on a sweep that spans every brokerage
 * (five cron routes), plus Engine 1's platform lead-distribution failure, which
 * is about a lead deliberately created with `brokerage_id: null` and which no
 * tenant is permitted to see. There is no record to resolve a tenant through, and
 * inventing one would file a platform outage inside one brokerage's console.
 *
 * These rows are NOT unreadable, which is what makes the exception defensible
 * rather than a loophole. Measured: `lib/platform/ai-ops.ts:73` reads
 * `automation_errors` cross-tenant on the service client with NO brokerage
 * predicate and its row type carries `brokerageId: string | null`; and
 * `app/actions/superadmin/ai-ops.ts:resolveAutomationErrorAction` resolves by id
 * with no brokerage predicate either. So the platform AI-ops console — the right
 * audience for a platform-wide failure — both sees and resolves them.
 *
 * The list is pinned because C1 counts `brokerage_id: null` as a stamp (an
 * explicit decision is not an omission), which would otherwise make `: null` a
 * way to turn C1 green without thinking.
 */
const EXPLICIT_NULL_TENANT_SITES: ReadonlySet<string> = new Set([
  "app/api/cron/earnings-rollup/route.ts",
  "app/api/cron/engagement-scores/route.ts",
  "app/api/cron/referral-asks/route.ts",
  "app/api/cron/seller-updates/route.ts",
  "app/api/cron/team-heatmap-snapshot/route.ts",
  "lib/lead-pipeline/pipeline-processor.ts",
])

/**
 * Production surfaces only — `app/` and `lib/`.
 *
 * `scripts/*-simulator.ts` are excluded BY CONSTRUCTION, with a reason: they
 * carry defective `.from("<table>").insert({…})` calls as STRING FIXTURES (their
 * own negative-control patch text, e.g. `scripts/wave11-slice-loops-simulator.ts`
 * and `scripts/automation-error-collection-simulator.ts`). Those are not writers,
 * and a scanner cannot tell them apart without blanking string contents — which
 * would also blank the `"<table>"` argument this scan matches on. Specificity
 * control S3 proves the exclusion is scoped to `scripts/` and does not quietly
 * cover a real writer under `app/` or `lib/`.
 */
function filesTouchingProd(table: string): string[] {
  // BOTH QUOTE STYLES. `filesTouching` greps only `from("<table>")`, and this
  // tree writes `from('automation_errors')` with SINGLE quotes in six of the
  // seventeen files — including every one in lib/communication-spine,
  // lib/vendor-governance and lib/lead-promotion. Greppping one style silently
  // dropped those files from the scan, and C1 then went green over writers it had
  // never looked at. Caught by a negative control staying green, which is exactly
  // what the applied-check and the control discipline are for.
  const found = new Set<string>()
  for (const needle of [`from("${table}")`, `from('${table}')`]) {
    try {
      const out = execFileSync("git", ["grep", "-l", "--", needle, "--", "app", "lib"], {
        cwd: ROOT,
        encoding: "utf8",
      })
      for (const f of out.split("\n")) {
        if (f.endsWith(".ts") || f.endsWith(".tsx")) found.add(f)
      }
    } catch {
      /* no match for this quote style */
    }
  }
  return [...found].sort()
}

// ─────────────────────────────────────────────────────────────────────────────
// C1 — zero baseline on notifications + automation_errors
// ─────────────────────────────────────────────────────────────────────────────
function assertWaveTwentyThreeInsertsStampTenant(): boolean {
  const offenders: string[] = []
  let total = 0
  for (const table of W23_TABLES) {
    for (const f of filesTouchingProd(table)) {
      if (!existsSync(resolve(ROOT, f))) continue
      for (const s of insertSites(f, table)) {
        total++
        if (!s.hasObjectArg) {
          offenders.push(`${f}:${s.line} ${table} (insert argument resolves to no object literal — cannot prove the stamp)`)
          continue
        }
        if (!s.keys.includes("brokerage_id")) offenders.push(`${f}:${s.line} ${table}`)
      }
    }
  }
  return check(
    `C1  all ${total} insert site(s) across ${W23_TABLES.length} wave-23 table(s) declare brokerage_id at the TOP LEVEL of the row`,
    offenders.length === 0,
    offenders.length === 0 ? "" : `unstamped: ${offenders.join(", ")}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// C2 — the wave-23 writers still exist
// ─────────────────────────────────────────────────────────────────────────────
function assertWaveTwentyThreeWritersStillExist(): boolean {
  const short: string[] = []
  for (const { file, table, floor } of W23_WRITER_FLOORS) {
    const n = existsSync(resolve(ROOT, file)) ? insertSites(file, table).length : 0
    if (n < floor) short.push(`${file} ${table}: ${n} < ${floor}`)
  }
  return check(
    `C2  every wave-23 writer still exists (${W23_WRITER_FLOORS.length} table/file floors)`,
    short.length === 0,
    short.length === 0 ? "" : `writers disappeared rather than being stamped — ${short.join("; ")}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// C3 — the badge count: the reader every user sees
// ─────────────────────────────────────────────────────────────────────────────
function assertBadgeCountNarrowsByBrokerage(): boolean {
  const chain = tableChain(BADGE_READER, "notifications")
  if (!chain) {
    return check("C3  the badge count narrows by brokerage", false, `no notifications read found in ${BADGE_READER}`)
  }
  const v = brokeragePredicateVerdict(chain)
  const narrowed = check(
    "C3a the unread-badge count ANDs a brokerage predicate onto the notifications read (the value every writer must stamp)",
    v.narrowed,
    v.detail,
  )
  // The `users` read that PRODUCES that value. Refused, it yields brokerageId
  // null and every badge on the page silently reports zero.
  const src = blankComments(raw(BADGE_READER))
  const usersFrom = src.indexOf('.from("users")')
  const e = usersFrom === -1 ? { ok: false, bindings: "" } : destructuresError(src, usersFrom)
  const errored = check(
    "C3b the `users` read that resolves that brokerage destructures `error` (a refusal must not read as 'no brokerage, all badges zero')",
    e.ok,
    e.ok ? "" : `bindings were: {${e.bindings.trim()}}`,
  )
  return narrowed && errored
}

// ─────────────────────────────────────────────────────────────────────────────
// C4 — the two suppression reads
// ─────────────────────────────────────────────────────────────────────────────
function assertSuppressionReadsAreTenantScoped(): boolean {
  let all = true
  for (const [label, file] of [
    ["QBR invitation de-duplication", QBR_READER],
    ["stranded-offer re-notify suppression", STRANDED_READER],
  ] as const) {
    const chain = tableChain(file, "notifications")
    if (!chain) {
      all = check(`C4  ${label} read found`, false, `no notifications read found in ${file}`) && all
      continue
    }
    const v = brokeragePredicateVerdict(chain)
    all = check(`C4  ${label} ANDs a brokerage predicate (${file})`, v.narrowed, v.detail) && all
    const e = destructuresError(chain.src, chain.fromIndex)
    all = check(
      `C4  ${label} destructures \`error\` (a refused suppression read must not read as "we have not told them yet")`,
      e.ok,
      e.ok ? "" : `bindings were: {${e.bindings.trim()}}`,
    ) && all
  }
  return all
}

// ─────────────────────────────────────────────────────────────────────────────
// C5 — the automations-console ownership check
// ─────────────────────────────────────────────────────────────────────────────
function assertConsoleOwnershipCheckNarrows(): boolean {
  const chain = tableChain(CONSOLE_OWNERSHIP, "automation_errors", "retryFailedWorkflow")
  if (!chain) {
    return check(
      "C5  the automations-console ownership check narrows by brokerage",
      false,
      `no automation_errors read found in retryFailedWorkflow (${CONSOLE_OWNERSHIP})`,
    )
  }
  const v = brokeragePredicateVerdict(chain)
  return check(
    'C5  retryFailedWorkflow ANDs a brokerage predicate — without it "Forbidden" becomes "any brokerage may resolve any error"',
    v.narrowed,
    v.detail,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// C6 — the explicitly-untenanted allow-list is exactly the defended six
// ─────────────────────────────────────────────────────────────────────────────
function assertExplicitNullTenantsAreAllowListed(): boolean {
  const found = new Set<string>()
  const strays: string[] = []
  for (const table of W23_TABLES) {
    for (const f of filesTouchingProd(table)) {
      if (!existsSync(resolve(ROOT, f))) continue
      for (const s of insertSites(f, table)) {
        const stamp = s.props.find((p) => p.key === "brokerage_id")
        if (!stamp) continue
        if (!/^null$/.test(stamp.value.trim())) continue
        found.add(f)
        if (!EXPLICIT_NULL_TENANT_SITES.has(f)) strays.push(`${f}:${s.line} ${table}`)
      }
    }
  }
  const missing = [...EXPLICIT_NULL_TENANT_SITES].filter((f) => !found.has(f))
  const ok = strays.length === 0 && missing.length === 0
  return check(
    `C6  exactly the ${EXPLICIT_NULL_TENANT_SITES.size} defended sites stamp \`brokerage_id: null\` on purpose`,
    ok,
    ok
      ? ""
      : [
          strays.length ? `NEW untenanted write not on the allow-list: ${strays.join(", ")}` : "",
          missing.length ? `allow-listed site no longer writes untenanted (update the list deliberately): ${missing.join(", ")}` : "",
        ].filter(Boolean).join(" · "),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// C7 — no notifications writer puts an AGENT id in `user_id`
// ─────────────────────────────────────────────────────────────────────────────
function assertNoAgentIdInNotificationRecipient(): boolean {
  const columnOffenders: string[] = []
  const fallbackOffenders: string[] = []
  for (const f of filesTouchingProd("notifications")) {
    if (!existsSync(resolve(ROOT, f))) continue
    for (const s of insertSites(f, "notifications")) {
      const recipient = s.props.find((p) => p.key === "user_id")
      if (!recipient) continue
      const v = recipient.value

      // C7a — A COLUMN READ, not a variable name. `contacts.agent_id`,
      // `transactions.agent_id` and `listings.agent_id` are all
      // `REFERENCES agents(id)` on the live schema, so `<row>.agent_id` in a
      // `REFERENCES users(id)` column is an id-space crossing established by the
      // SCHEMA rather than by spelling. `agents.user_id` (`.user_id` present) is
      // the RESOLVED form and is correct.
      //
      // Deliberately NOT flagged: a bare local named `agentId`. Three of those
      // exist in this tree and all three hold a users.id resolved a line earlier
      // (lib/kernel/manager-signals.ts, lib/kernel/stalled-deferrals-runner.ts).
      // A guard that flags names rather than constructs is the defect wave 20
      // named, pointed at identifiers instead of comments.
      if (/(?:^|[^A-Za-z0-9_$.])[A-Za-z0-9_$]+(?:\?)?\.agent_id\b/.test(v) && !/\.user_id\b/.test(v)) {
        columnOffenders.push(`${f}:${s.line} → user_id: ${v.slice(0, 60)}`)
      }

      // C7b — RESOLVE, never `??`. `certAgent?.user_id ?? params.agentId` was the
      // actual shape at the agent-certification site: a resolved users.id with a
      // fallback into the agents space, so the moment the resolve came back empty
      // (or was refused — the read destructured no `error`) the row carried an
      // agents.id and was refused 23503. A `??` whose left side is a resolved
      // `.user_id` and whose right side is not is that defect exactly.
      const nullish = v.split("??")
      if (nullish.length > 1 && /\.user_id\b|\buserId\b/.test(nullish[0])) {
        const tail = nullish.slice(1).join("??")
        if (!/\.user_id\b|\buserId\b|\buser\.id\b/.test(tail)) {
          fallbackOffenders.push(`${f}:${s.line} → user_id: ${v.slice(0, 80)}`)
        }
      }
    }
  }
  const a = check(
    "C7a no notifications writer passes a `<row>.agent_id` as `user_id` (agents.id is DISJOINT from users.id — the FK refuses it 23503)",
    columnOffenders.length === 0,
    columnOffenders.join(", "),
  )
  const b = check(
    "C7b no notifications writer `??`s a resolved users.id into a non-users fallback (RESOLVE between id spaces, never default across them)",
    fallbackOffenders.length === 0,
    fallbackOffenders.join(", "),
  )
  return a && b
}

// ═════════════════════════════════════════════════════════════════════════════
// WAVE 24 — six more tables, every one triaged by READING ITS READER
// ═════════════════════════════════════════════════════════════════════════════
//
// Same invariant, extended again rather than copied. Six tables were dispatched;
// reading them corrected the brief in BOTH directions, which is the whole reason
// the class is decided by the reader and the count by the scanner:
//
//   · `smart_assistant_suggestions` — 3 unstamped, as briefed. Reader:
//     `app/actions/contact-details.ts:getContactCopilotSuggestions`, which pairs
//     `.eq("agent_id", ctx.agentId)` with `.eq("brokerage_id", ctx.brokerageId)`
//     from ONE `getAgentContext()` — so the value to stamp is the OWNING AGENT'S
//     `users.brokerage_id`, resolved through `agents.user_id`, not the caller's
//     brokerage and not `agents.brokerage_id`. (Wave 23's badge-count lesson: a
//     wrong tenant hides the row exactly as NULL does.)
//   · `sequence_step_executions` — 4 unstamped, as briefed, all in one file.
//     Reader: `lib/campaign-sequences/channel-order-runner.ts`, which counts
//     `status='sent'` and `replied_at` within `.eq("brokerage_id", …)`. Every
//     execution was outside that window, so the channel-order advisory was
//     computed over an empty set for every brokerage. The tenant comes off
//     `sequence_enrollments.brokerage_id`, already read at step 1.
//   · `open_house_attendees` — TWO unstamped, not four. Reader:
//     `app/actions/seller-open-house.ts:endOpenHouseEvent`, `.eq("event_id", …)
//     .eq("brokerage_id", <caller's users.brokerage_id>)`. The tenant is the
//     EVENT'S, which is also the ownership check.
//   · `cron_execution_logs` — FIVE unstamped, not four, and the important one is
//     not a missing key: `lib/kernel/cron-logging.ts:createCronRunContext`
//     ACCEPTED `brokerage_id` and dropped it, so the column no caller could fill
//     was the one `system-health.ts:getCronExecutionLogs` filters on.
//   · `social_posts` — ZERO unstamped, not three. All 22 insert sites across 51
//     files already stamp. The brief's 3 came from W22-4's proximity heuristic;
//     reading them, the table is clean.
//   · `system_health_checks` — ZERO unstamped. One writer, and it already stamps
//     `service.brokerage_id` off the `service_status` row it is checking.
//
// NEITHER a back-fill trigger NOR a net anywhere: `pg_trigger` returns zero
// non-internal triggers for all six, measured live. The application stamp is the
// only mechanism, as it was for the wave-23 pair.
//
//   D1  ZERO BASELINE ON ALL SIX. Same construct, same depth-1 rule, same app/
//       + lib/ scoping (S3's reason).
//   D2  THE WRITERS STILL EXIST, per file and table — A2's reason.
//   D3  EVERY CONFIRMED READER STILL ANDS ITS BROKERAGE PREDICATE, and reads its
//       `error` where the owning assignment is visible to the scanner. These are
//       the six predicates that decide what a stamped row is worth.
//   D4  THE UNTENANTED CRON ROWS ARE EXACTLY THE DEFENDED ONES. `brokerage_id:
//       null` counts as a stamp for D1 (an explicit decision is not an omission),
//       so the allow-list is what stops `: null` becoming a way to turn D1 green
//       without thinking. Three writes, two files, one class: a run that swept
//       EVERY brokerage.
//   D5  …AND THE PLATFORM READERS THAT MAKE THOSE ROWS READABLE STILL CARRY NO
//       BROKERAGE PREDICATE. This is D4's defence asserted rather than claimed:
//       `pl-truth-engine.ts:getCronHealth` and `scraping.ts:
//       loadScrapingDiagnostics` both read this ledger cross-tenant, which is
//       what makes an untenanted platform run VISIBLE rather than lost. The day
//       either one gains a brokerage predicate, the allow-list stops being
//       defensible — so the assertion is on the ABSENCE of one.
//   D6  `createCronRunContext` STAMPS THE TENANT IT WAS GIVEN. D1 is satisfied by
//       any value; the defect here was specifically that the accepted input never
//       reached the row, so this asserts the VALUE EXPRESSION carries it.
//   D7  THE BLOCK-BODIED ROW MAPPER IS RESOLVED, NOT MERELY ABSENT. A writer the
//       scanner cannot resolve is an offender, so "unstamped: 0" is only worth
//       something if the scan can actually see through every fan-out shape in the
//       tree. `lib/social/orchestrate-social-preset-publish.ts` uses `.map(x => {
//       … return {…} })`, which the wave-23 scanner could not follow — it called
//       a correctly-stamped writer unprovable.

const W24_TABLES = [
  "smart_assistant_suggestions",
  "sequence_step_executions",
  "open_house_attendees",
  "cron_execution_logs",
  "social_posts",
  "system_health_checks",
] as const

/** A2's reason, per table and file: D1 is green against a file with no writers left. */
const W24_WRITER_FLOORS: Array<{ file: string; table: string; floor: number }> = [
  { file: "app/actions/ai-reply-coach.ts", table: "smart_assistant_suggestions", floor: 1 },
  { file: "lib/fatigue/fatigue-calculator.ts", table: "smart_assistant_suggestions", floor: 1 },
  { file: "lib/property-alerts/alert-notifier.ts", table: "smart_assistant_suggestions", floor: 1 },
  { file: "lib/campaign-sequences/step-executor.ts", table: "sequence_step_executions", floor: 4 },
  { file: "app/actions/open-house-automation.ts", table: "open_house_attendees", floor: 2 },
  { file: "lib/kernel/cron-logging.ts", table: "cron_execution_logs", floor: 2 },
  { file: "app/api/cron/health-check/route.ts", table: "cron_execution_logs", floor: 2 },
  { file: "app/api/cron/contact-enrichment/route.ts", table: "cron_execution_logs", floor: 1 },
  { file: "lib/social/orchestrate-social-preset-publish.ts", table: "social_posts", floor: 1 },
  { file: "app/actions/social-publishing.ts", table: "social_posts", floor: 2 },
  { file: "app/api/cron/health-check/route.ts", table: "system_health_checks", floor: 1 },
]

/**
 * THE ONLY WAVE-24 SITES ALLOWED TO STAMP `brokerage_id: null` ON PURPOSE.
 *
 * Three writes, two files, one class: the run swept EVERY brokerage, so no
 * brokerage is what it is about. `contact-enrichment` iterates every active
 * tenant and reports their sum; `health-check` polls `service_status` for all of
 * them, once on the success path and once from the OUTER CATCH — where the
 * failure can fire before any service row is even known.
 *
 * Defensible rather than lost, and D5 is what keeps that true: both platform
 * readers of this ledger carry NO brokerage predicate, so these rows are read by
 * the surface that should see a platform-wide run. The per-tenant findings of
 * both crons are written elsewhere and ARE stamped — `system_health_checks` rows
 * carry each `service_status` row's own brokerage.
 *
 * Note what is NOT here: `lib/kernel/cron-logging.ts`. Its `?? null` is the
 * absence of a tenant the CALLER declared, not a decision this file makes — D6
 * asserts it carries the input, and a bare `null` there would be a stray.
 */
const W24_EXPLICIT_NULL_TENANT_SITES: ReadonlySet<string> = new Set([
  "app/api/cron/contact-enrichment/route.ts",
  "app/api/cron/health-check/route.ts",
])

interface TenantReaderCase {
  label: string
  file: string
  table: string
  fn: string
  /**
   * False ONLY where the read is built in stages (`let q = supabase.from(…)` …
   * `const { data, error } = await q`), which the walk-back to the owning
   * assignment cannot see. Asserting it there would report the PREVIOUS
   * statement's bindings — a false GREEN on the exact property being asserted,
   * which is worse than no assertion. The predicate is still asserted.
   */
  assertError: boolean
}

/** The readers that decide whether a stamped row is worth anything. */
const W24_READERS: TenantReaderCase[] = [
  {
    label: "the contact copilot suggestion queue",
    file: "app/actions/contact-details.ts",
    table: "smart_assistant_suggestions",
    fn: "getContactCopilotSuggestions",
    // Staged query builder — see TenantReaderCase.assertError. The real read IS
    // destructured (`const { data, error } = await query`).
    assertError: false,
  },
  {
    label: "the channel-order learner",
    file: "lib/campaign-sequences/channel-order-runner.ts",
    table: "sequence_step_executions",
    fn: "runChannelOrderLearning",
    assertError: true,
  },
  {
    label: "the open-house attendee scorer",
    file: "app/actions/seller-open-house.ts",
    table: "open_house_attendees",
    fn: "endOpenHouseEvent",
    assertError: true,
  },
  {
    label: "the broker cron-run history",
    file: "app/actions/system-health.ts",
    table: "cron_execution_logs",
    fn: "getCronExecutionLogs",
    assertError: true,
  },
  {
    label: "the service health history",
    file: "app/actions/system-health.ts",
    table: "system_health_checks",
    fn: "getServiceHealthHistory",
    assertError: true,
  },
  {
    label: "the social-post brand-compliance ownership check",
    file: "app/actions/social/generate-social-post.ts",
    table: "social_posts",
    fn: "stampPostBrandCompliance",
    assertError: true,
  },
]

/**
 * The cross-tenant readers that make an untenanted `cron_execution_logs` row
 * readable. Asserted to have NO brokerage predicate — see D5.
 */
const W24_PLATFORM_READERS: Array<{ label: string; file: string; fn: string }> = [
  { label: "getCronHealth (7-day run/failure counts)", file: "app/actions/pl-truth-engine.ts", fn: "getCronHealth" },
  { label: "loadScrapingDiagnostics (cron run history)", file: "lib/kernel/scraping.ts", fn: "loadScrapingDiagnostics" },
]

const PRESET_FANOUT = "lib/social/orchestrate-social-preset-publish.ts"

// ─────────────────────────────────────────────────────────────────────────────
// D1 — zero baseline across all six wave-24 tables
// ─────────────────────────────────────────────────────────────────────────────
function assertWaveTwentyFourInsertsStampTenant(): boolean {
  const offenders: string[] = []
  let total = 0
  for (const table of W24_TABLES) {
    for (const f of filesTouchingProd(table)) {
      if (!existsSync(resolve(ROOT, f))) continue
      for (const s of insertSites(f, table)) {
        total++
        if (!s.hasObjectArg) {
          offenders.push(`${f}:${s.line} ${table} (insert argument resolves to no object literal — cannot prove the stamp)`)
          continue
        }
        if (!s.keys.includes("brokerage_id")) offenders.push(`${f}:${s.line} ${table}`)
      }
    }
  }
  return check(
    `D1  all ${total} insert site(s) across ${W24_TABLES.length} wave-24 table(s) declare brokerage_id at the TOP LEVEL of the row`,
    offenders.length === 0,
    offenders.length === 0 ? "" : `unstamped: ${offenders.join(", ")}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// D2 — the wave-24 writers still exist
// ─────────────────────────────────────────────────────────────────────────────
function assertWaveTwentyFourWritersStillExist(): boolean {
  const short: string[] = []
  for (const { file, table, floor } of W24_WRITER_FLOORS) {
    const n = existsSync(resolve(ROOT, file)) ? insertSites(file, table).length : 0
    if (n < floor) short.push(`${file} ${table}: ${n} < ${floor}`)
  }
  return check(
    `D2  every wave-24 writer still exists (${W24_WRITER_FLOORS.length} table/file floors)`,
    short.length === 0,
    short.length === 0 ? "" : `writers disappeared rather than being stamped — ${short.join("; ")}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// D3 — every confirmed reader still narrows, and reads its error
// ─────────────────────────────────────────────────────────────────────────────
function assertWaveTwentyFourReadersNarrow(): boolean {
  let all = true
  for (const r of W24_READERS) {
    const chain = tableChain(r.file, r.table, r.fn)
    if (!chain) {
      all = check(`D3  ${r.label} read found`, false, `no ${r.table} read found in ${r.fn} (${r.file})`) && all
      continue
    }
    const v = brokeragePredicateVerdict(chain)
    all = check(`D3  ${r.label} ANDs a brokerage predicate on ${r.table} (${r.fn})`, v.narrowed, v.detail) && all
    if (!r.assertError) continue
    const e = destructuresError(chain.src, chain.fromIndex)
    all = check(
      `D3  ${r.label} destructures \`error\` (supabase-js RESOLVES a refusal — it must not read as "nothing there")`,
      e.ok,
      e.ok ? "" : `bindings were: {${e.bindings.trim()}}`,
    ) && all
  }
  return all
}

// ─────────────────────────────────────────────────────────────────────────────
// D4 — the untenanted cron rows are exactly the defended ones
// ─────────────────────────────────────────────────────────────────────────────
function assertWaveTwentyFourExplicitNullsAreAllowListed(): boolean {
  const found = new Set<string>()
  const strays: string[] = []
  for (const table of W24_TABLES) {
    for (const f of filesTouchingProd(table)) {
      if (!existsSync(resolve(ROOT, f))) continue
      for (const s of insertSites(f, table)) {
        const stamp = s.props.find((p) => p.key === "brokerage_id")
        if (!stamp) continue
        if (!/^null$/.test(stamp.value.trim())) continue
        found.add(f)
        if (!W24_EXPLICIT_NULL_TENANT_SITES.has(f)) strays.push(`${f}:${s.line} ${table}`)
      }
    }
  }
  const missing = [...W24_EXPLICIT_NULL_TENANT_SITES].filter((f) => !found.has(f))
  const ok = strays.length === 0 && missing.length === 0
  return check(
    `D4  exactly the ${W24_EXPLICIT_NULL_TENANT_SITES.size} defended file(s) stamp \`brokerage_id: null\` on purpose`,
    ok,
    ok
      ? ""
      : [
          strays.length ? `NEW untenanted write not on the allow-list: ${strays.join(", ")}` : "",
          missing.length ? `allow-listed site no longer writes untenanted (update the list deliberately): ${missing.join(", ")}` : "",
        ].filter(Boolean).join(" · "),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// D5 — D4's defence: the platform readers carry NO brokerage predicate
// ─────────────────────────────────────────────────────────────────────────────
function assertPlatformCronReadersStayCrossTenant(): boolean {
  let all = true
  for (const p of W24_PLATFORM_READERS) {
    const chain = tableChain(p.file, "cron_execution_logs", p.fn)
    if (!chain) {
      all = check(`D5  ${p.label} read found`, false, `no cron_execution_logs read found in ${p.fn} (${p.file})`) && all
      continue
    }
    const narrowed = chain.links.some((l) => CONJUNCTIVE.has(l.method) && /["']brokerage_id["']/.test(l.args))
    all = check(
      `D5  ${p.label} still reads cron_execution_logs WITHOUT a brokerage predicate — which is what makes the allow-listed untenanted rows readable`,
      !narrowed,
      narrowed
        ? "a brokerage predicate appeared here: the three deliberately-untenanted platform-sweep rows are now invisible to their own surface, so the D4 allow-list is no longer defensible and those writes must be reconsidered — not silently kept"
        : "",
    ) && all
  }
  return all
}

// ─────────────────────────────────────────────────────────────────────────────
// D6 — createCronRunContext stamps the tenant it was GIVEN
// ─────────────────────────────────────────────────────────────────────────────
function assertCronContextCarriesItsInputTenant(): boolean {
  const file = "lib/kernel/cron-logging.ts"
  const sites = existsSync(resolve(ROOT, file)) ? insertSites(file, "cron_execution_logs") : []
  const carriers = sites.filter((s) => {
    const stamp = s.props.find((p) => p.key === "brokerage_id")
    return stamp ? /\binput\s*\.\s*brokerage_id\b/.test(stamp.value) : false
  })
  return check(
    `D6  both cron-kernel writers stamp the tenant their INPUT declared (found ${carriers.length}/${sites.length})`,
    carriers.length === sites.length && sites.length >= 2,
    carriers.length === sites.length && sites.length >= 2
      ? ""
      : "the accepted `brokerage_id` is being dropped again — CreateCronRunContextInput has always carried it and the row never did, which is why the broker health page could not show a scoped run",
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// D7 — the block-bodied row mapper is RESOLVED, not merely absent
// ─────────────────────────────────────────────────────────────────────────────
function assertBlockBodiedRowMapperResolves(): boolean {
  const sites = existsSync(resolve(ROOT, PRESET_FANOUT)) ? insertSites(PRESET_FANOUT, "social_posts") : []
  const resolved = sites.filter((s) => s.hasObjectArg && s.viaRowMapper)
  return check(
    `D7  the \`.map(x => { … return {…} })\` fan-out in ${PRESET_FANOUT} RESOLVES to its row object (${resolved.length}/${sites.length})`,
    sites.length >= 1 && resolved.length === sites.length,
    sites.length === 0
      ? "the fan-out writer is gone — D1's zero baseline no longer proves the block-body shape can be seen at all"
      : "a correctly-stamped writer is unprovable again: the scan cannot follow a BLOCK arrow body to its `return {…}`, and D1 reports it as an offender rather than reading it",
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
  console.log(
    "TENANT-STAMP GUARD — ai_insights · ai_predictions · ai_autopilot_plans · conversation_intelligence · notifications · " +
      "automation_errors · smart_assistant_suggestions · sequence_step_executions · open_house_attendees · cron_execution_logs · " +
      "social_posts · system_health_checks\n",
  )

  console.log("ASSERTIONS")
  assertEveryInsertStampsTenant()
  assertWritersStillExist()
  assertReaderNarrowsByBrokerage()
  assertUnattributedWideningKept()
  assertReaderDestructuresError()
  assertEveryTenantTableInsertStampsTenant()
  assertWaveTwentyOneWritersStillExist()
  assertLeadPredictionsReaderNarrows()
  assertLeadPredictionsEntityTypeWideningKept()
  assertLeadPredictionsReaderDestructuresError()
  assertSnapshotDedupeIsTenantScoped()
  assertWaveTwentyThreeInsertsStampTenant()
  assertWaveTwentyThreeWritersStillExist()
  assertBadgeCountNarrowsByBrokerage()
  assertSuppressionReadsAreTenantScoped()
  assertConsoleOwnershipCheckNarrows()
  assertExplicitNullTenantsAreAllowListed()
  assertNoAgentIdInNotificationRecipient()
  assertWaveTwentyFourInsertsStampTenant()
  assertWaveTwentyFourWritersStillExist()
  assertWaveTwentyFourReadersNarrow()
  assertWaveTwentyFourExplicitNullsAreAllowListed()
  assertPlatformCronReadersStayCrossTenant()
  assertCronContextCarriesItsInputTenant()
  assertBlockBodiedRowMapperResolves()

  for (const table of TENANT_TABLES) {
    const files = filesTouching(table)
    const n = files.reduce((acc, f) => acc + (existsSync(resolve(ROOT, f)) ? insertSites(f, table).length : 0), 0)
    console.log(`\n  ${table}: ${files.length} file(s) · ${n} insert site(s)`)
  }
  for (const table of [...W23_TABLES, ...W24_TABLES]) {
    const files = filesTouchingProd(table)
    const sites = files.flatMap((f) => (existsSync(resolve(ROOT, f)) ? insertSites(f, table) : []))
    const mapped = sites.filter((s) => s.viaRowMapper).length
    console.log(`\n  ${table}: ${files.length} app/lib file(s) · ${sites.length} insert site(s) (${mapped} via a row mapper)`)
  }

  if (RUN_NEGATIVE) {
    console.log("\nNEGATIVE CONTROLS")

    // 1. One writer loses its stamp. This is the wave-20 defect exactly.
    //
    //    The find-string reaches into `insight_type` deliberately. Wave 21 gave
    //    the ai_predictions insert in the SAME function the SAME anchor variable
    //    at a shallower indent, and a plain-substring find of just the
    //    `brokerage_id: dealBrokerageId,` line then lands on THAT one — leaving
    //    A1 (which scans ai_insights only) green and the control proving nothing.
    //    The guard caught exactly that, which is the applied-check earning its
    //    keep; the fix is to anchor on a key only this row has.
    controlled(
      "one ai_insights insert loses brokerage_id",
      {
        file: WRITERS,
        find: "            brokerage_id: dealBrokerageId,\n            insight_type: \"risk\",",
        replace: "            insight_type: \"risk\",",
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

    // ── WAVE 21 ──────────────────────────────────────────────────────────────

    // 10. The ai_predictions row this wave stamped loses its tenant. This is the
    //     W21-1 defect exactly, on the table that CARRIES the escape.
    controlled(
      "the deal-close ai_predictions insert loses brokerage_id",
      {
        file: WRITERS,
        find: "          brokerage_id: dealBrokerageId,\n          prediction_type: \"deal_close_probability\",",
        replace: "          prediction_type: \"deal_close_probability\",",
      },
      assertEveryTenantTableInsertStampsTenant,
    )

    // 11. THE SPELLING TRAP, on ai_predictions. `brokerage_id` demoted into the
    //     nested `prediction_value` payload — the three letters are still in the
    //     call, at the wrong depth, stamping nothing. A substring match cannot
    //     tell this from a fix. THE CONTROL THE BRIEF NAMES.
    controlled(
      "ai_predictions: brokerage_id demoted into a NESTED object (present as text, absent as a stamp)",
      {
        file: WRITERS,
        find: "      brokerage_id: offerBrokerageId,\n      prediction_type: \"winning_offer\",",
        replace: "      prediction_type: \"winning_offer\",",
      },
      () => {
        const p = resolve(ROOT, WRITERS)
        const cur = readFileSync(p, "utf8")
        const nested = cur.replace(
          "      prediction_value: offerStrategy.data,",
          "      prediction_value: { brokerage_id: offerBrokerageId, ...offerStrategy.data },",
        )
        if (nested === cur) {
          failures.push("ai_predictions nested-stamp control second patch did not apply")
          return false
        }
        writeFileSync(p, nested)
        return assertEveryTenantTableInsertStampsTenant()
      },
    )

    // 12. THE SPECIFICITY CONTROL. The same ai_predictions insert split across
    //     chained lines — a line-oriented scan anchored on "the line after
    //     .insert(" sails past this. The construct scan must still find the stamp
    //     and stay GREEN. A guard that flags everything proves nothing.
    {
      const c: Control = {
        file: WRITERS,
        find: "    const { error: offerPredictionError } = await supabase.from(\"ai_predictions\").insert({\n      brokerage_id: offerBrokerageId,",
        replace:
          "    const { error: offerPredictionError } = await supabase\n      .from(\"ai_predictions\")\n\n      .insert({\n      brokerage_id: offerBrokerageId,",
      }
      const before = raw(c.file)
      const patched = before.replace(c.find, c.replace)
      if (patched === before) {
        console.log("  ✗ NEGATIVE CONTROL the ai_predictions insert split across chained lines — PATCH DID NOT APPLY")
        failures.push("negative control did not apply: wrapped ai_predictions insert")
      } else {
        const beforeSha = sha(c.file)
        writeFileSync(resolve(ROOT, c.file), patched)
        let stillGreen = false
        try {
          const marker = failures.length
          stillGreen = assertEveryTenantTableInsertStampsTenant()
          while (failures.length > marker) failures.pop()
        } finally {
          writeFileSync(resolve(ROOT, c.file), before)
          if (sha(c.file) !== beforeSha) {
            failures.push(`FAILED TO RESTORE ${c.file}`)
            console.log(`  ✗ FAILED TO RESTORE ${c.file}`)
          }
        }
        if (stillGreen) {
          console.log("  ✓ NEGATIVE CONTROL the ai_predictions insert split across chained lines — stayed GREEN (statement-level, as required)")
        } else {
          console.log("  ✗ NEGATIVE CONTROL the ai_predictions insert split across chained lines — went RED; the scan is line-oriented")
          failures.push("wrapped ai_predictions control went red: scan is line-oriented")
        }
      }
    }

    // 13. The autopilot plan loses its tenant — the row goes invisible to the
    //     broker and to platform admin, which is the W21-2 defect.
    controlled(
      "the ai_autopilot_plans insert loses brokerage_id",
      {
        file: WRITERS,
        find: "        brokerage_id: autopilotBrokerageId,\n        lead_id: data.leadId,",
        replace: "        lead_id: data.leadId,",
      },
      assertEveryTenantTableInsertStampsTenant,
    )

    // 14. Same, for conversation_intelligence. The find-string reaches past the
    //     shared identifier into `lead_id` so it cannot land on one of the two
    //     OTHER writers in the same function that use the same anchor variable.
    controlled(
      "the conversation_intelligence insert loses brokerage_id",
      {
        file: WRITERS,
        find: "          brokerage_id: conversationBrokerageId,\n          lead_id: data.leadId,",
        replace: "          lead_id: data.leadId,",
      },
      assertEveryTenantTableInsertStampsTenant,
    )

    // 15. A NEW unstamped writer on a wave-21 table, added the way the originals
    //     got there: by copying a neighbour into a real call position.
    controlled(
      "a NEW unstamped ai_predictions insert added to the writers file",
      {
        file: WRITERS,
        find: "    // Save negotiation strategy",
        replace:
          "    await supabase.from(\"ai_predictions\").insert({\n" +
          "      prediction_type: \"nc_probe\",\n" +
          "      entity_type: \"transaction\",\n" +
          "    })\n" +
          "    // Save negotiation strategy",
      },
      assertEveryTenantTableInsertStampsTenant,
    )

    // 16. A wave-21 writer DELETED rather than stamped — B1 alone goes green.
    controlled(
      "the conversation_intelligence writer removed rather than stamped",
      {
        file: WRITERS,
        find: '.from("conversation_intelligence")\n        .insert({',
        replace: '.from("conversation_intelligence_disabled")\n        .insert({',
      },
      assertWaveTwentyOneWritersStillExist,
    )

    // 17. getLeadPredictions loses its brokerage predicate — the W21-1 read
    //     exactly, with the escape in the policy standing behind it.
    controlled(
      "getLeadPredictions' brokerage predicate removed",
      {
        file: WRITERS,
        find: '    .eq("brokerage_id", readerBrokerageId)\n',
        replace: "",
      },
      assertLeadPredictionsReaderNarrows,
    )

    // 18. The brokerage term moved INTO an .or() — it now WIDENS instead of
    //     narrowing. The fix inverted, reading almost identically.
    controlled(
      "getLeadPredictions' brokerage term moved inside .or() (widens instead of narrowing)",
      {
        file: WRITERS,
        find: '    .eq("brokerage_id", readerBrokerageId)\n    .eq("entity_id", leadId)',
        replace: '    .or(`brokerage_id.eq.${readerBrokerageId},entity_id.eq.${leadId}`)',
      },
      assertLeadPredictionsReaderNarrows,
    )

    // 19. The entity_type widening narrowed to one class — half of what
    //     predictLeadConversion writes silently stops being read.
    controlled(
      "getLeadPredictions narrowed to a single entity_type",
      {
        file: WRITERS,
        find: '.in("entity_type", ["lead", "contact"])',
        replace: '.eq("entity_type", "lead")',
      },
      assertLeadPredictionsEntityTypeWideningKept,
    )

    // 20. getLeadPredictions stops destructuring `error` — a refused history
    //     renders as "this lead has never been predicted on".
    controlled(
      "getLeadPredictions stops destructuring `error`",
      {
        file: WRITERS,
        find: "  const { data, error } = await supabase\n    .from(\"ai_predictions\")",
        replace: "  const { data } = await supabase\n    .from(\"ai_predictions\")",
      },
      assertLeadPredictionsReaderDestructuresError,
    )

    // 21. The one ai_predictions read NOT on the service client loses its tenant
    //     scope — a foreign untenanted snapshot can then suppress this tenant's.
    controlled(
      "the win-probability dedupe read loses its brokerage predicate",
      {
        file: OUTCOMES,
        find: '    .eq("brokerage_id", input.brokerageId)\n',
        replace: "",
      },
      assertSnapshotDedupeIsTenantScoped,
    )

    // 22. …and stops reading its `error`, so a refusal reads as "no prior snapshot".
    controlled(
      "the win-probability dedupe read stops destructuring `error`",
      {
        file: OUTCOMES,
        find: "const { data: latest, error: latestError } = await svc",
        replace: "const { data: latest } = await svc",
      },
      assertSnapshotDedupeIsTenantScoped,
    )

    // ── WAVE 23 ──────────────────────────────────────────────────────────────

    // 23. A DIRECT notifications writer loses its stamp — the W23-1 defect
    //     exactly, on the table whose reader is the unread badge count.
    controlled(
      "a direct notifications insert loses brokerage_id",
      {
        file: "app/actions/video-content.ts",
        find: '        brokerage_id: readyTenant.brokerageId,\n        type: "video_ready",',
        replace: '        type: "video_ready",',
      },
      assertWaveTwentyThreeInsertsStampTenant,
    )

    // 24. THE DEPTH-1 DEMOTION CONTROL, on notifications. `brokerage_id` moved
    //     into the nested `entity_id`-adjacent payload — the three letters are
    //     still in the call, at the wrong depth, stamping nothing. A substring
    //     match cannot tell this from a fix.
    controlled(
      "notifications: brokerage_id demoted into a NESTED object (present as text, absent as a stamp)",
      {
        file: "app/actions/video-content.ts",
        find: '        brokerage_id: publishedTenant.brokerageId,\n        type: "video_published",',
        replace: '        type: "video_published",',
      },
      () => {
        const p = resolve(ROOT, "app/actions/video-content.ts")
        const cur = readFileSync(p, "utf8")
        const nested = cur.replace(
          '        entity_type: "video",\n        entity_id: video_id,\n      })\n      if (publishedNotifyError) {',
          '        entity_type: "video",\n        entity_id: { brokerage_id: publishedTenant.brokerageId, id: video_id },\n      })\n      if (publishedNotifyError) {',
        )
        if (nested === cur) {
          failures.push("notifications nested-stamp control second patch did not apply")
          return false
        }
        writeFileSync(p, nested)
        return assertWaveTwentyThreeInsertsStampTenant()
      },
    )

    // 25. A MAPPED (fan-out) notifications writer loses its stamp. Ten of this
    //     tree's notifications writers are spelled `.insert(rows)` with
    //     `const rows = xs.map(x => ({ … }))` elsewhere — if the scan cannot see
    //     through that shape, every one of them is invisible to C1 and the zero
    //     baseline means nothing. This control proves it CAN.
    controlled(
      "a MAPPED notifications insert loses brokerage_id (the .map(… => ({…})) fan-out shape)",
      {
        file: "lib/notifications/brokerage-admins.ts",
        find: "    user_id:      id,\n    brokerage_id: brokerageId,",
        replace: "    user_id:      id,",
      },
      assertWaveTwentyThreeInsertsStampTenant,
    )

    // 26. An automation_errors writer loses its stamp — the W23-2 defect, on the
    //     table whose reader returns "Forbidden" when the predicate misses.
    controlled(
      "an automation_errors insert loses brokerage_id",
      {
        file: "lib/vendor-governance/usage-logger.ts",
        find: "        brokerage_id: event.brokerageId,\n        workflow_name: 'vendor_usage_logging',",
        replace: "        workflow_name: 'vendor_usage_logging',",
      },
      assertWaveTwentyThreeInsertsStampTenant,
    )

    // 27. THE DEPTH-1 DEMOTION CONTROL, on automation_errors — and this is the
    //     shape the real defect had: `brokerageId` was ALREADY in the call,
    //     serialized inside `context_json`, stamping nothing.
    controlled(
      "automation_errors: brokerage_id demoted into the context_json payload (present as text, absent as a stamp)",
      {
        file: "lib/communication-spine/message-persister.ts",
        find: "      brokerage_id: context.brokerageId,\n      workflow_name: 'communication_spine_persist_message',",
        replace: "      workflow_name: 'communication_spine_persist_message',",
      },
      () => {
        const p = resolve(ROOT, "lib/communication-spine/message-persister.ts")
        const cur = readFileSync(p, "utf8")
        const nested = cur.replace(
          "      context_json: JSON.stringify({\n        contactId: context.contactId,",
          "      context_json: JSON.stringify({\n        brokerage_id: context.brokerageId,\n        contactId: context.contactId,",
        )
        if (nested === cur) {
          failures.push("automation_errors nested-stamp control second patch did not apply")
          return false
        }
        writeFileSync(p, nested)
        return assertWaveTwentyThreeInsertsStampTenant()
      },
    )

    // 28. A wave-23 writer DELETED rather than stamped — C1 alone goes green.
    controlled(
      "a wave-23 writer removed rather than stamped",
      {
        file: "lib/lead-readiness/readiness-logger.ts",
        find: 'from("automation_errors")',
        replace: 'from("automation_errors_disabled")',
      },
      assertWaveTwentyThreeWritersStillExist,
    )

    // 29. The badge count loses its brokerage predicate — the read that made the
    //     unstamped rows invisible in the first place.
    controlled(
      "the unread-badge count loses its brokerage predicate",
      {
        file: BADGE_READER,
        find: '.eq("brokerage_id", brokerageId)\n        .eq("user_id", user.id)',
        replace: '.eq("user_id", user.id)',
      },
      assertBadgeCountNarrowsByBrokerage,
    )

    // 30. …and the `users` read that PRODUCES that brokerage stops destructuring
    //     `error`, so a refusal renders every badge as zero.
    controlled(
      "the badge route's `users` read stops destructuring `error`",
      {
        file: BADGE_READER,
        find: "const { data: userData, error: userLookupError } = await supabase",
        replace: "const { data: userData } = await supabase",
      },
      assertBadgeCountNarrowsByBrokerage,
    )

    // 31. The QBR suppression read loses its brokerage predicate — it would then
    //     dedupe against every tenant's invitations at once.
    controlled(
      "the QBR suppression read loses its brokerage predicate",
      {
        file: QBR_READER,
        find: '.select("user_id").eq("brokerage_id", b.id)',
        replace: '.select("user_id")',
      },
      assertSuppressionReadsAreTenantScoped,
    )

    // 32. The stranded-offer suppression read stops destructuring `error`, so a
    //     refusal reads as "we have not told them yet" and re-alerts.
    controlled(
      "the stranded-offer suppression read stops destructuring `error`",
      {
        file: STRANDED_READER,
        find: "const { data: prior, error: priorError } = await svc",
        replace: "const { data: prior } = await svc",
      },
      assertSuppressionReadsAreTenantScoped,
    )

    // 33. The automations-console OWNERSHIP check loses its brokerage predicate —
    //     "Forbidden" becomes "any brokerage may resolve any error".
    controlled(
      "retryFailedWorkflow's ownership predicate removed",
      {
        file: CONSOLE_OWNERSHIP,
        find: '      .eq("id", workflowId)\n      .eq("brokerage_id", brokerageId)\n      .maybeSingle()',
        replace: '      .eq("id", workflowId)\n      .maybeSingle()',
      },
      assertConsoleOwnershipCheckNarrows,
    )

    // 34. A SEVENTH untenanted write appears — `brokerage_id: null` used as a way
    //     to turn C1 green without thinking. C1 stays green by design (an explicit
    //     decision is not an omission); C6 is what must catch it.
    controlled(
      "a NEW site starts stamping `brokerage_id: null` (C1 green by design — C6 must go red)",
      {
        file: "lib/vendor-governance/usage-logger.ts",
        find: "        brokerage_id: event.brokerageId,\n        workflow_name: 'vendor_usage_anomaly',",
        replace: "        brokerage_id: null,\n        workflow_name: 'vendor_usage_anomaly',",
      },
      assertExplicitNullTenantsAreAllowListed,
    )

    // 35. A `<row>.agent_id` column read is passed as `notifications.user_id`
    //     again — the crossing that made these writers fail 23503 on every call,
    //     invisibly, because the refusal was never destructured.
    controlled(
      "a <row>.agent_id column read is written into notifications.user_id",
      {
        file: "lib/property-alerts/alert-notifier.ts",
        find: "        user_id:     alertRecipient.userId,",
        replace: "        user_id:     contact.agent_id ?? null,",
      },
      assertNoAgentIdInNotificationRecipient,
    )

    // 36. The `??`-across-id-spaces shape returns — a resolved users.id with an
    //     agents.id fallback, which is what the agent-certification writer had.
    controlled(
      "a resolved users.id is `??`'d into a non-users fallback",
      {
        file: "app/actions/ai-agent-onboarding.ts",
        find: "        user_id: certRecipient.userId,",
        replace: "        user_id: certRecipient.userId ?? params.agentId,",
      },
      assertNoAgentIdInNotificationRecipient,
    )

    // S4. THE SPECIFICITY CONTROL FOR C7. A bare local named `agentId` that HOLDS
    //     a users.id — the shape lib/kernel/manager-signals.ts and
    //     lib/kernel/stalled-deferrals-runner.ts both use after resolving — must
    //     stay GREEN. C7 asserts a schema fact, not a naming convention; a guard
    //     that flagged the name would have demanded "fixes" to two already-correct
    //     writers and taught everyone to ignore it.
    {
      const c: Control = {
        file: "app/actions/video-content.ts",
        find: "        user_id: user_id,\n        brokerage_id: readyTenant.brokerageId,",
        replace: "        user_id: agentId,\n        brokerage_id: readyTenant.brokerageId,",
      }
      const before = raw(c.file)
      const patched = before.replace(c.find, c.replace)
      if (patched === before) {
        console.log("  ✗ SPECIFICITY CONTROL S4 a bare local named agentId — PATCH DID NOT APPLY")
        failures.push("specificity control did not apply: bare agentId local")
      } else {
        const beforeSha = sha(c.file)
        writeFileSync(resolve(ROOT, c.file), patched)
        let stillGreen = false
        try {
          const marker = failures.length
          stillGreen = assertNoAgentIdInNotificationRecipient()
          while (failures.length > marker) failures.pop()
        } finally {
          writeFileSync(resolve(ROOT, c.file), before)
          if (sha(c.file) !== beforeSha) {
            failures.push(`FAILED TO RESTORE ${c.file}`)
            console.log(`  ✗ FAILED TO RESTORE ${c.file}`)
          }
        }
        if (stillGreen) {
          console.log("  ✓ SPECIFICITY CONTROL S4 a bare local named `agentId` — stayed GREEN (C7 asserts a schema fact, not a naming convention)")
        } else {
          console.log("  ✗ SPECIFICITY CONTROL S4 — went RED; C7 is flagging names rather than constructs")
          failures.push("C7 specificity control went red: the assertion is name-based")
        }
      }
    }

    // ── WAVE 24 ──────────────────────────────────────────────────────────────

    // 37. A `sequence_step_executions` writer loses its stamp — the W24 defect on
    //     the ledger the channel-order learner counts. The find-string reaches
    //     into `sequence_id` because THREE writers in this file use the same
    //     `brokerageId` anchor; the 8-space indent belongs to the authority-gate
    //     one alone.
    controlled(
      "a sequence_step_executions insert loses brokerage_id",
      {
        file: "lib/campaign-sequences/step-executor.ts",
        find: "        brokerage_id: brokerageId,\n        sequence_id: enrollment.sequence_id,",
        replace: "        sequence_id: enrollment.sequence_id,",
      },
      assertWaveTwentyFourInsertsStampTenant,
    )

    // 38. THE DEPTH-1 DEMOTION CONTROL, on smart_assistant_suggestions — and this
    //     is the shape the real row already had: the alert and contact ids are
    //     serialized into `action_payload_json`, so `brokerage_id` sitting beside
    //     them looks exactly like a stamp and is one level too deep to be one.
    controlled(
      "smart_assistant_suggestions: brokerage_id demoted into the action_payload_json object (present as text, absent as a stamp)",
      {
        file: "lib/property-alerts/alert-notifier.ts",
        find: "      brokerage_id:        alertRecipient.brokerageId,\n",
        replace: "",
      },
      () => {
        const p = resolve(ROOT, "lib/property-alerts/alert-notifier.ts")
        const cur = readFileSync(p, "utf8")
        const nested = cur.replace(
          "JSON.stringify({ alert_id: alert.id, contact_id: alert.contact_id })",
          "JSON.stringify({ brokerage_id: alertRecipient.brokerageId, alert_id: alert.id, contact_id: alert.contact_id })",
        )
        if (nested === cur) {
          failures.push("smart_assistant_suggestions nested-stamp control second patch did not apply")
          return false
        }
        writeFileSync(p, nested)
        return assertWaveTwentyFourInsertsStampTenant()
      },
    )

    // 39. THE BLOCK-BODIED FAN-OUT loses its stamp. Ten notifications writers are
    //     the concise `=> ({…})` shape and control 25 covers those; this is the
    //     OTHER one — `=> { … return {…} }` — and if the scan could not follow it,
    //     D1 would be red for the wrong reason and this control would prove
    //     nothing. D7 is what separates the two, and it is asserted above.
    controlled(
      "the BLOCK-bodied social_posts fan-out loses brokerage_id (`.map(x => { … return {…} })`)",
      {
        file: PRESET_FANOUT,
        find: "      brokerage_id:   args.brokerageId,\n",
        replace: "",
      },
      assertWaveTwentyFourInsertsStampTenant,
    )

    // 40. THE ARGUMENT BECOMES UNPROVABLE. `.insert(rowsToInsert)` resolves to a
    //     row object; `.insert(rowsToInsert.slice(0))` does not. A stamp that
    //     cannot be seen is not a stamp that can be trusted, so D1 must call this
    //     an offender rather than pass over it — and D7 must say WHICH shape
    //     stopped resolving.
    controlled(
      "a social_posts insert argument stops resolving to a row object (unprovable is an OFFENDER, not a pass)",
      {
        file: PRESET_FANOUT,
        find: ".insert(rowsToInsert)",
        replace: ".insert(rowsToInsert.slice(0))",
      },
      () => assertWaveTwentyFourInsertsStampTenant() && assertBlockBodiedRowMapperResolves(),
    )

    // 41. An `open_house_attendees` writer loses its stamp — the row then falls
    //     out of `endOpenHouseEvent`'s `.eq("event_id", …).eq("brokerage_id", …)`
    //     and the attendee is never scored.
    controlled(
      "an open_house_attendees insert loses brokerage_id",
      {
        file: "app/actions/open-house-automation.ts",
        find: "          brokerage_id: event.brokerage_id,\n          contact_id: params.contactId,",
        replace: "          contact_id: params.contactId,",
      },
      assertWaveTwentyFourInsertsStampTenant,
    )

    // 42. A wave-24 writer DELETED rather than stamped — D1 alone goes green.
    controlled(
      "a wave-24 writer removed rather than stamped",
      {
        file: "lib/campaign-sequences/step-executor.ts",
        find: 'from("sequence_step_executions")',
        replace: 'from("sequence_step_executions_disabled")',
      },
      assertWaveTwentyFourWritersStillExist,
    )

    // 43. The channel-order learner loses its brokerage predicate — it would then
    //     rank channels over every tenant's sends at once and advise each
    //     brokerage from the platform's aggregate.
    controlled(
      "the channel-order learner loses its brokerage predicate",
      {
        file: "lib/campaign-sequences/channel-order-runner.ts",
        find: '    .eq("brokerage_id", brokerageId)\n',
        replace: "",
      },
      assertWaveTwentyFourReadersNarrow,
    )

    // 44. The broker cron-run history loses its brokerage predicate.
    controlled(
      "the broker cron-run history loses its brokerage predicate",
      {
        file: "app/actions/system-health.ts",
        find: '    .eq("brokerage_id", ctx.brokerageId)\n    .order("started_at", { ascending: false })',
        replace: '    .order("started_at", { ascending: false })',
      },
      assertWaveTwentyFourReadersNarrow,
    )

    // 45. THE CONTROL THAT PROVES THE `destructuresError` FIX. The attendee read
    //     stops destructuring `error`. Under the OLD walk-back — first match,
    //     `[^;]*$` in a tree with no semicolons — this stayed GREEN, because the
    //     `open_house_events` UPDATE three lines above answered on its behalf.
    //     That was a false green on the exact property being asserted.
    controlled(
      "the open-house attendee read stops destructuring `error` (the false-green the last-match walk-back closed)",
      {
        file: "app/actions/seller-open-house.ts",
        find: "const { data: attendees, error: attendeesError } = await supabase",
        replace: "const { data: attendees } = await supabase",
      },
      assertWaveTwentyFourReadersNarrow,
    )

    // 46. A FOURTH untenanted cron write appears — `brokerage_id: null` used to
    //     turn D1 green without thinking. D1 stays green BY DESIGN (an explicit
    //     decision is not an omission); D4 is what must catch it.
    controlled(
      "a NEW cron site starts stamping `brokerage_id: null` (D1 green by design — D4 must go red)",
      {
        file: "lib/kernel/cron-logging.ts",
        find: "        brokerage_id: input.brokerage_id ?? null,",
        replace: "        brokerage_id: null,",
      },
      assertWaveTwentyFourExplicitNullsAreAllowListed,
    )

    // 47. …and the same patch is the D6 defect: the accepted tenant dropped again,
    //     which is exactly how this column came to be NULL for every caller.
    controlled(
      "createCronRunContext stops carrying the brokerage_id it was given",
      {
        file: "lib/kernel/cron-logging.ts",
        find: "        brokerage_id: input.brokerage_id ?? null,",
        replace: "        brokerage_id: null,",
      },
      assertCronContextCarriesItsInputTenant,
    )

    // 48. D4'S DEFENCE GOES AWAY. `getCronHealth` gains a brokerage predicate, so
    //     the three deliberately-untenanted platform-sweep rows stop being visible
    //     anywhere — at which point keeping them untenanted is no longer a
    //     defensible decision, it is just a hole. D5 must notice.
    controlled(
      "the platform cron reader gains a brokerage predicate (the untenanted sweep rows go dark)",
      {
        file: "app/actions/pl-truth-engine.ts",
        find: '      .gte("started_at", sevenDaysAgo)',
        replace: '      .eq("brokerage_id", auth.brokerageId)\n      .gte("started_at", sevenDaysAgo)',
      },
      assertPlatformCronReadersStayCrossTenant,
    )

    // ── SPECIFICITY CONTROLS (these must stay GREEN) ─────────────────────────

    // S1. THE STATEMENT-LEVEL CONTROL, on a wave-23 table. The same stamped
    //     insert split across chained lines — a line-oriented scan anchored on
    //     "the line after .insert(" sails past this. The construct scan must
    //     still find the stamp and stay GREEN.
    {
      const c: Control = {
        file: "lib/vendor-governance/usage-logger.ts",
        find: "      const { error: usageLogError } = await supabase.from('automation_errors').insert({\n        brokerage_id: event.brokerageId,",
        replace:
          "      const { error: usageLogError } = await supabase\n        .from('automation_errors')\n\n        .insert({\n        brokerage_id: event.brokerageId,",
      }
      const before = raw(c.file)
      const patched = before.replace(c.find, c.replace)
      if (patched === before) {
        console.log("  ✗ SPECIFICITY CONTROL S1 the automation_errors insert split across chained lines — PATCH DID NOT APPLY")
        failures.push("specificity control did not apply: wrapped automation_errors insert")
      } else {
        const beforeSha = sha(c.file)
        writeFileSync(resolve(ROOT, c.file), patched)
        let stillGreen = false
        try {
          const marker = failures.length
          stillGreen = assertWaveTwentyThreeInsertsStampTenant()
          while (failures.length > marker) failures.pop()
        } finally {
          writeFileSync(resolve(ROOT, c.file), before)
          if (sha(c.file) !== beforeSha) {
            failures.push(`FAILED TO RESTORE ${c.file}`)
            console.log(`  ✗ FAILED TO RESTORE ${c.file}`)
          }
        }
        if (stillGreen) {
          console.log("  ✓ SPECIFICITY CONTROL S1 the automation_errors insert split across chained lines — stayed GREEN (statement-level, as required)")
        } else {
          console.log("  ✗ SPECIFICITY CONTROL S1 — went RED; the scan is line-oriented")
          failures.push("wrapped automation_errors control went red: scan is line-oriented")
        }
      }
    }

    // S2. THE WINDOW-BOUNDARY CONTROL. A READ on a wave-23 table immediately
    //     followed by an INSERT on a DIFFERENT table must NOT be attributed here.
    //     Without the `.from(` cut this produced 26 phantom "unstamped" sites.
    {
      const c: Control = {
        file: "lib/lead-readiness/readiness-logger.ts",
        find: '  console.error("[ReadinessLogger] Readiness anomaly detected for lead:", leadId, anomalyDescription)',
        replace:
          '  await supabase.from("automation_errors").select("id").eq("id", leadId)\n' +
          '  await supabase.from("some_other_table").insert({ id: leadId })\n' +
          '  console.error("[ReadinessLogger] Readiness anomaly detected for lead:", leadId, anomalyDescription)',
      }
      const before = raw(c.file)
      const patched = before.replace(c.find, c.replace)
      if (patched === before) {
        console.log("  ✗ SPECIFICITY CONTROL S2 read-then-other-table-insert — PATCH DID NOT APPLY")
        failures.push("specificity control did not apply: window boundary")
      } else {
        const beforeSha = sha(c.file)
        writeFileSync(resolve(ROOT, c.file), patched)
        let stillGreen = false
        try {
          const marker = failures.length
          stillGreen = assertWaveTwentyThreeInsertsStampTenant()
          while (failures.length > marker) failures.pop()
        } finally {
          writeFileSync(resolve(ROOT, c.file), before)
          if (sha(c.file) !== beforeSha) {
            failures.push(`FAILED TO RESTORE ${c.file}`)
            console.log(`  ✗ FAILED TO RESTORE ${c.file}`)
          }
        }
        if (stillGreen) {
          console.log("  ✓ SPECIFICITY CONTROL S2 a READ on the table followed by an INSERT on another — stayed GREEN (window cut at the next .from()")
        } else {
          console.log("  ✗ SPECIFICITY CONTROL S2 — went RED; the insert window runs past the next .from()")
          failures.push("window-boundary control went red")
        }
      }
    }

    // S3. THE SCOPE CONTROL. C1 excludes `scripts/` because the simulators carry
    //     defective inserts as STRING FIXTURES. That exclusion must be scoped to
    //     scripts/ and must NOT quietly cover a real writer under app/ or lib/ —
    //     so an unstamped insert added to a lib/ file goes RED while the identical
    //     text added to a scripts/ file stays GREEN.
    {
      const libFile = "lib/vendor-governance/usage-logger.ts"
      const scriptFile = "scripts/ai-ops-simulator.ts"
      const stub = '\nawait supabase.from("automation_errors").insert({ workflow_name: "s3_probe" })\n'
      const libBefore = raw(libFile)
      const scriptBefore = raw(scriptFile)
      const libSha = sha(libFile)
      const scriptSha = sha(scriptFile)
      let scriptStayedGreen = false
      let libWentRed = false
      try {
        writeFileSync(resolve(ROOT, scriptFile), scriptBefore + stub)
        const m1 = failures.length
        scriptStayedGreen = assertWaveTwentyThreeInsertsStampTenant()
        while (failures.length > m1) failures.pop()
        writeFileSync(resolve(ROOT, libFile), libBefore + stub)
        const m2 = failures.length
        libWentRed = !assertWaveTwentyThreeInsertsStampTenant()
        while (failures.length > m2) failures.pop()
      } finally {
        writeFileSync(resolve(ROOT, scriptFile), scriptBefore)
        writeFileSync(resolve(ROOT, libFile), libBefore)
        if (sha(scriptFile) !== scriptSha || sha(libFile) !== libSha) {
          failures.push("FAILED TO RESTORE the S3 control files")
          console.log("  ✗ FAILED TO RESTORE the S3 control files")
        }
      }
      if (scriptStayedGreen && libWentRed) {
        console.log("  ✓ SPECIFICITY CONTROL S3 the scripts/ exclusion is scoped — identical defect GREEN in scripts/, RED in lib/")
      } else {
        console.log(
          `  ✗ SPECIFICITY CONTROL S3 — scripts/ stayed green: ${scriptStayedGreen}, lib/ went red: ${libWentRed}`,
        )
        failures.push("scope control failed: the scripts/ exclusion is not scoped as described")
      }
    }
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
