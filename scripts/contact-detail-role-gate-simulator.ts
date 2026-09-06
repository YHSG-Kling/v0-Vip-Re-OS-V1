#!/usr/bin/env tsx
/**
 * scripts/contact-detail-role-gate-simulator.ts  (npm run test:contact-detail-role-gate)
 * ─────────────────────────────────────────────────────────────────────────────
 * A TENANT CHECK WITH NO ROLE CHECK IS NOT A GATE — IT IS A DIRECTORY.
 *
 * `app/actions/contact-details.ts` exports seven server actions over one
 * person's most sensitive rows: the contact record itself (`select("*")`), their
 * credit accounts, their transactions, their documents, their whole activity
 * timeline, their video engagement, and the copilot queue about them. Every
 * export of a `"use server"` file is a public HTTP endpoint (CLAUDE.md §4).
 *
 * Until wave 26 the single gate behind all seven asked exactly one question:
 * does the caller's `users.brokerage_id` equal the contact's? It asked NOTHING
 * about the caller's ROLE. Measured on the production project
 * (hrvaqgvukzxfskkcrwbt): 4 users with `user_type='contact'` carry a
 * brokerage_id, plus 2 `vendor` and 2 `lender`. So a signed-in client, vendor or
 * lender could POST any contactId in their own brokerage and read that person's
 * file — which CLAUDE.md §5 forbids in one sentence: "Contacts, lenders and
 * vendors see no financials — only their own."
 *
 * It also discarded `error` on BOTH of its reads. supabase-js RESOLVES a refusal
 * (§3), so an RLS refusal of the caller's `users` row arrived as "Unauthorized"
 * and a refused `contacts` read arrived as "Contact not found" — an outage
 * dressed as a decision, which is the shape §4's "fail closed" rule exists to
 * forbid.
 *
 * ── WHAT THIS PROVES ────────────────────────────────────────────────────────
 * Six properties, each a CONSTRUCT rather than a spelling, so renaming the gate,
 * the roster or the local bindings keeps them green and regressing the SHAPE
 * does not:
 *
 *  1. THE ROLE TEST EXISTS AND REFUSES. The gate consults a role predicate and
 *     the refusal branch returns `ok: false`.
 *  2. IT RUNS BEFORE ANY PRIVILEGE IS TAKEN. The role test precedes the first
 *     `createServiceClient()` and the first `.from(...)` in the gate body — an
 *     unauthorized seat is turned away having read nothing.
 *  3. IDENTITY COMES FROM THE SURVIVOR, NOT A HAND-ROLLED COPY. `requireCaller`
 *     is IMPORTED, awaited, and refused on; the file declares no local
 *     `auth.getUser()` + `users` read of its own (the 32-copy shape that
 *     lib/auth/require-caller.ts exists to end, 22 of which drop the error).
 *  4. THE OWNERSHIP READ READS ITS ERROR, AND AN OUTAGE STAYS APART FROM A
 *     DECISION. `error` is destructured and returned on, and the refused-read
 *     sentence is DISTINCT from both "not found" and "forbidden".
 *  5. EVERY EXPORT IS GATED — ENUMERATED, NOT LISTED. The exports are discovered
 *     from the source, so an export added tomorrow is covered without editing
 *     this guard, and each must reach a role refusal before its first `.from(`.
 *  6. THE ROSTER IS DERIVED, LEGAL AND CORRECTLY SHAPED. It spreads the ONE
 *     exported contact-scope roster (§6 — no second spelling); every member is a
 *     value the LIVE users.user_type CHECK admits (a member the column cannot
 *     hold is a permission that never fires); it EXCLUDES the three seats §5
 *     names; and it INCLUDES `agent`, because a gate narrower than the surface
 *     it protects breaks /crm for the people it was built for.
 *
 * HOW IT IS BUILT
 *   · Every structural assertion reads COMMENT-STRIPPED source
 *     (scripts/strip-comments.ts — the one correct scanner, CLAUDE.md §2). This
 *     file's own subject carries a long doc-comment that names `vendor`,
 *     `lender` and `contact` verbatim; unstripped, assertion 6 would pass on
 *     prose and assertion 1 would pass on a tombstone.
 *   · Every assertion carries NEGATIVE CONTROLS that write the real defect back
 *     into the real file, VERIFY the patch landed on disk, require the assertion
 *     to flip RED, then restore and re-verify by sha256. A mutation whose find
 *     string no longer matches is reported as theatre, not as a pass.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import { blankComments, blankStrings } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const F = {
  action: "app/actions/contact-details.ts",
  roster: "lib/portal/require-contact-access.ts",
}

/** Read fresh every time — the negative layer rewrites these files. */
const raw = (p: string) => readFileSync(resolve(ROOT, p), "utf8")

/**
 * TWO OFFSET-ALIGNED VIEWS OF THE SAME FILE, both from the ONE correct scanner
 * (scripts/strip-comments.ts, CLAUDE.md §2). Both BLANK to spaces rather than
 * delete, so every index computed on one indexes the other identically — which
 * is what lets the brace walk run on the safe view and the assertions read the
 * sentences from the honest one.
 *
 *   masked  comments AND string/template contents blanked. The corpus for brace
 *           and paren walking: a `}` inside a string literal is not a closing
 *           brace, and a hand-rolled masker is exactly the defect §2 names —
 *           this one is a third output of the scanner that already tracks
 *           strings, templates, regexes and JSX in one left-to-right pass.
 *   plain   comments blanked, string literals INTACT. The corpus for the
 *           assertions that must read a value: the refusal SENTENCES, the
 *           roster MEMBERS, an import PATH. Comments are still gone, so this
 *           file's own doc-comment — which names `vendor`, `lender` and
 *           `contact` verbatim, and quotes the refusal strings — can never
 *           satisfy an assertion about the code.
 */
const masked = (p: string) => blankStrings(raw(p))
const plain = (p: string) => blankComments(raw(p))

// ─────────────────────────────────────────────────────────────────────────────
// Structural helpers
// ─────────────────────────────────────────────────────────────────────────────

function matchBrace(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") { depth--; if (depth === 0) return i }
  }
  return -1
}

function matchParen(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++
    else if (src[i] === ")") { depth--; if (depth === 0) return i }
  }
  return -1
}

/**
 * The BODY of a function declaration, braces excluded.
 *
 * TWO THINGS HERE ARE NOT DECORATION, and both were found by this proof reading
 * its own subject wrong:
 *
 *   · The PARAMETER list is walked by paren depth, so a destructured or
 *     object-typed parameter cannot be mistaken for the body's opening brace.
 *   · The RETURN TYPE is skipped by ANGLE depth and then by trial. The gate this
 *     file exists to judge is declared
 *     `async function authorizeContactAccess(id: string): Promise<\n | { ok: true; … }\n | { ok: false; … }\n> {`
 *     — so "the first `{` after the parameter list" is a TYPE, not a body, and a
 *     naive extractor would hand every assertion the union's members and then
 *     report, quite calmly, that the gate contains no role test. A guard that
 *     cannot see the code it judges reports zero and reads as a clean bill of
 *     health (CLAUDE.md §2). Braces inside `<…>` are skipped; a bare object
 *     return type (`): { a: string } {`) is caught by the trial below, which
 *     rejects a candidate whose matching `}` is immediately followed by another
 *     `{` — that pair was the annotation, and the next one is the body.
 */
function functionRange(src: string, name: string): { open: number; close: number } | null {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src)
  if (!m) return null
  const openParen = src.indexOf("(", m.index)
  const closeParen = matchParen(src, openParen)
  if (closeParen === -1) return null

  let angle = 0
  for (let i = closeParen + 1; i < src.length; i++) {
    const c = src[i]
    if (c === "<") { angle++; continue }
    if (c === ">") { if (angle > 0) angle--; continue }
    if (c !== "{" || angle > 0) continue
    const close = matchBrace(src, i)
    if (close === -1) return null
    // Was that the body, or a bare object return type followed by the body?
    const rest = src.slice(close + 1).replace(/^\s+/, "")
    if (rest.startsWith("{")) { i = close; continue }
    return { open: i, close }
  }
  return null
}

/**
 * The body of `name`, taken from the file at `p`.
 *
 * The RANGE is computed on `masked` (braces inside a string cannot mislead the
 * walk) and the TEXT is sliced from whichever view the caller needs — the two
 * are the same length, so one index serves both.
 */
function bodyOf(p: string, name: string, view: "masked" | "plain"): string | null {
  const r = functionRange(masked(p), name)
  if (!r) return null
  return (view === "masked" ? masked(p) : plain(p)).slice(r.open + 1, r.close)
}

const GATE = "authorizeContactAccess"
const gateBody = () => bodyOf(F.action, GATE, "masked")
const gateBodyPlain = () => bodyOf(F.action, GATE, "plain")

/** Every `export async function <name>` in the action module, in source order. */
function exportedActions(src: string): string[] {
  return [...src.matchAll(/export\s+async\s+function\s+([A-Za-z0-9_$]+)/g)].map((m) => m[1])
}

/** The identifier of the role predicate the gate calls, or null. */
function rolePredicateName(body: string): string | null {
  const m = /if\s*\(\s*!\s*([A-Za-z_$][\w$]*)\s*\(/.exec(body)
  return m ? m[1] : null
}

/**
 * The set literal a `const <name>: ... = new Set([...])` declares, resolving one
 * level of spread against another Set declared in `src` (or in `otherSrc`).
 * Returns null when the declaration cannot be parsed — a guard that silently
 * reads an empty set would report "excludes vendor" about nothing at all.
 */
function setMembers(src: string, name: string, otherSrc?: string): string[] | null {
  const m = new RegExp(`(?:const|let)\\s+${name}\\b[^=]*=\\s*new Set\\(\\s*\\[`).exec(src)
  if (!m) return null
  const openBracket = src.indexOf("[", m.index + m[0].length - 1)
  if (openBracket === -1) return null
  let depth = 0, close = -1
  for (let i = openBracket; i < src.length; i++) {
    if (src[i] === "[") depth++
    else if (src[i] === "]") { depth--; if (depth === 0) { close = i; break } }
  }
  if (close === -1) return null
  const inner = src.slice(openBracket + 1, close)
  const out = [...inner.matchAll(/"([^"]*)"/g)].map((x) => x[1])
  for (const s of inner.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) {
    const nested =
      setMembers(src, s[1]) ?? (otherSrc ? setMembers(otherSrc, s[1]) : null)
    if (nested === null) return null // an unresolvable spread is not an empty one
    out.push(...nested)
  }
  return out
}

/** The live users.user_type CHECK, from the generated cache — never retyped. */
const LIVE_USER_TYPES = new Set(CHECK_VOCABULARIES.users?.user_type ?? [])

// ─────────────────────────────────────────────────────────────────────────────
// Assertion harness
// ─────────────────────────────────────────────────────────────────────────────
type Outcome = { ok: boolean; detail?: string }
interface Assertion {
  id: string
  what: string
  run: () => Outcome
  /** Source mutations that MUST flip this assertion to failure. */
  breaks: Array<{ file: string; find: string; replace: string }>
}

const A: Assertion[] = []

// ═════════════════════════════════════════════════════════════════════════════
// 1 — THE ROLE TEST EXISTS AND REFUSES
// ═════════════════════════════════════════════════════════════════════════════
A.push({
  id: "gate.asks-about-the-role-and-refuses-on-the-answer",
  what:
    "the gate body consults a role predicate and the negated branch RETURNS `ok: false` — the whole defect was a gate that compared two brokerage ids and asked nothing else, so a `contact`, `vendor` or `lender` seat holding a brokerage_id read every contact in it",
  run: () => {
    const body = gateBody()
    if (!body) return { ok: false, detail: `the ${GATE} body could not be parsed` }
    const pred = rolePredicateName(body)
    if (!pred) return { ok: false, detail: "no `if (!<predicate>(...))` refusal in the gate body" }
    const m = new RegExp(`if\\s*\\(\\s*!\\s*${pred}\\s*\\([^)]*\\)\\s*\\)\\s*\\{?[^}]*ok:\\s*false`).exec(body)
    if (!m) return { ok: false, detail: `\`${pred}\` is called but its negation does not return ok: false` }
    return { ok: true, detail: `role predicate \`${pred}\`, refusing with ok: false` }
  },
  breaks: [
    {
      // The defect, verbatim: the role question deleted, tenant match left alone.
      file: F.action,
      find: `  if (!isCrmContactStaff(caller.userType)) {
    return { ok: false, error: "Forbidden" }
  }`,
      replace: ``,
    },
    {
      // Subtler and more realistic: the predicate is still called, and the answer
      // is thrown away.
      file: F.action,
      find: `  if (!isCrmContactStaff(caller.userType)) {
    return { ok: false, error: "Forbidden" }
  }`,
      replace: `  if (!isCrmContactStaff(caller.userType)) {
    console.warn("non-staff caller")
  }`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 2 — IT RUNS BEFORE ANY PRIVILEGE IS TAKEN
// ═════════════════════════════════════════════════════════════════════════════
A.push({
  id: "gate.role-test-precedes-the-service-client-and-the-first-read",
  what:
    "inside the gate body the role refusal comes BEFORE the first `createServiceClient()` and before the first `.from(...)` — a gate that runs after the RLS-bypassing client has already read the row is an audit note, not a gate",
  run: () => {
    const body = gateBody()
    if (!body) return { ok: false, detail: `the ${GATE} body could not be parsed` }
    const pred = rolePredicateName(body)
    if (!pred) return { ok: false, detail: "no role refusal in the gate body" }
    const roleAt = body.search(new RegExp(`!\\s*${pred}\\s*\\(`))
    const marks: Array<[string, number]> = [
      ["createServiceClient()", body.search(/createServiceClient\s*\(/)],
      [".from(", body.search(/\.from\s*\(/)],
    ]
    const missing = marks.filter(([, i]) => i === -1).map(([n]) => n)
    if (missing.length) {
      return { ok: false, detail: `the gate no longer contains: ${missing.join(", ")} — re-read it, this proof is aimed at the wrong shape` }
    }
    const early = marks.filter(([, i]) => i < roleAt).map(([n]) => n)
    return early.length === 0
      ? { ok: true, detail: `role@${roleAt}, then ${marks.map(([n, i]) => `${n}@${i}`).join(", ")}` }
      : { ok: false, detail: `these run BEFORE the role test: ${early.join(", ")}` }
  },
  breaks: [
    {
      // NOT a deletion — assertion 1 already covers that. The privileged client is
      // HOISTED above the gate, so the role test still exists and still refuses,
      // and it now runs after the RLS bypass was taken. Only an ORDER assertion
      // catches this, which is what makes it this assertion's own control.
      file: F.action,
      find: `  if (!isCrmContactStaff(caller.userType)) {`,
      replace: `  const early = createServiceClient()
  void early
  if (!isCrmContactStaff(caller.userType)) {`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 3 — IDENTITY COMES FROM THE SURVIVOR, NOT A HAND-ROLLED COPY
// ═════════════════════════════════════════════════════════════════════════════
A.push({
  id: "gate.identity-is-the-shared-requireCaller-not-a-thirty-third-copy",
  what:
    "`requireCaller` is IMPORTED (not declared here), awaited in the gate, and refused on — and this module hand-rolls no `auth.getUser()` + `users` read of its own. lib/auth/require-caller.ts documents 32 file-local copies of that read, 22 of which drop the error and 9 of which default a missing user_type to \"agent\"; a role gate built on a copy that defaults to \"agent\" grants the very seat it is meant to refuse",
  run: () => {
    // `plain`: the import PATH is a string literal, so the masked view would hand
    // this an empty specifier and the existsSync check would judge nothing.
    const src = plain(F.action)
    const imported = /import\s*\{[^}]*\brequireCaller\b[^}]*\}\s*from\s*["']([^"']+)["']/.exec(src)
    if (!imported) return { ok: false, detail: "requireCaller is not imported" }
    const target = resolve(ROOT, imported[1].replace(/^@\//, "") + ".ts")
    if (!existsSync(target)) return { ok: false, detail: `the survivor does not exist at ${imported[1]}` }
    if (/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+requireCaller\s*\(/.test(src)) {
      return { ok: false, detail: "requireCaller is DECLARED in this file — a 33rd copy" }
    }
    const body = gateBody()
    if (!body) return { ok: false, detail: `the ${GATE} body could not be parsed` }
    if (!/await\s+requireCaller\s*\(/.test(body)) return { ok: false, detail: "the gate does not await requireCaller()" }
    if (!/if\s*\(\s*!\s*[A-Za-z_$][\w$]*\.ok\s*\)/.test(body)) {
      return { ok: false, detail: "the gate does not refuse on the identity verdict" }
    }
    // The hand-rolled shape, anywhere in the module: a session read paired with a
    // users read is the copy this survivor replaces.
    if (/auth\.getUser\s*\(/.test(src) && /\.from\(\s*["']users["']\s*\)/.test(src)) {
      return { ok: false, detail: "this module hand-rolls auth.getUser() + a users read — the copy shape" }
    }
    return { ok: true, detail: `imported from ${imported[1]}, awaited and refused on` }
  },
  breaks: [
    {
      file: F.action,
      find: `import { requireCaller } from "@/lib/auth/require-caller"`,
      replace: `import { requireCaller } from "@/lib/auth/require-caller-that-is-not-there"`,
    },
    {
      // The 33rd copy, reintroduced — and it is the fail-open variant.
      file: F.action,
      find: `  const caller = await requireCaller()
  if (!caller.ok) {`,
      replace: `  const sessionClient = await createClient()
  const { data: { user } } = await sessionClient.auth.getUser()
  const { data: row } = await sessionClient.from("users").select("brokerage_id, user_type").eq("id", user?.id ?? "").maybeSingle()
  const caller = { ok: !!row, reason: "unauthenticated" as const, error: "", userId: user?.id ?? "", brokerageId: row?.brokerage_id as string, userType: (row?.user_type ?? "agent") as string }
  if (!caller.ok) {`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 4 — THE OWNERSHIP READ READS ITS ERROR, AND AN OUTAGE IS NOT A DECISION
// ═════════════════════════════════════════════════════════════════════════════
A.push({
  id: "gate.a-refused-ownership-read-refuses-and-says-so",
  what:
    "the `contacts` ownership read destructures `error`, returns on it, and answers with a sentence DISTINCT from both the not-found and the forbidden sentence. supabase-js RESOLVES a refusal (§3): `const { data }` alone reports \"permission denied\" as \"no such contact\", and a gate that cannot run must refuse rather than describe a clean negative (§4)",
  run: () => {
    // `plain`: this assertion is ABOUT the sentences, and about the table name in
    // `.from("contacts")` — both string literals, both blanked in the masked view.
    // Comments are still blanked, so the doc-comment above the gate, which quotes
    // all three sentences verbatim, cannot satisfy any clause here.
    const body = gateBodyPlain()
    if (!body) return { ok: false, detail: `the ${GATE} body could not be parsed` }
    const d = /\{\s*data:\s*[A-Za-z_$][\w$]*\s*,\s*error:\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*await[\s\S]{0,200}?\.from\(\s*["']contacts["']\s*\)/.exec(body)
    if (!d) return { ok: false, detail: "the contacts read does not destructure `error`" }
    const errName = d[1]
    const onErr = new RegExp(`if\\s*\\(\\s*${errName}\\s*\\)\\s*return[^\\n]*error:\\s*"([^"]+)"`).exec(body)
    if (!onErr) return { ok: false, detail: `\`${errName}\` is bound but never returned on` }
    const others = [...body.matchAll(/ok:\s*false\s*,\s*error:\s*"([^"]+)"/g)].map((m) => m[1])
    const distinct = others.filter((s) => s === onErr[1]).length === 1
    return distinct
      ? { ok: true, detail: `refused read → "${onErr[1]}", distinct from ${[...new Set(others.filter((s) => s !== onErr[1]))].map((s) => `"${s}"`).join(", ")}` }
      : { ok: false, detail: `the refused-read sentence "${onErr[1]}" is reused for another verdict — an outage is being reported as a decision` }
  },
  breaks: [
    {
      // The original defect: the error dropped, so a refused read becomes "not found".
      file: F.action,
      find: `  const { data: contact, error: contactErr } = await svc`,
      replace: `  const { data: contact } = await svc`,
    },
    {
      // The subtler one: the error IS read, and then laundered into the clean negative.
      file: F.action,
      find: `  if (contactErr) return { ok: false, error: "Access check failed" }`,
      replace: `  if (contactErr) return { ok: false, error: "Contact not found" }`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 5 — EVERY EXPORT IS GATED (ENUMERATED FROM SOURCE, NOT LISTED HERE)
// ═════════════════════════════════════════════════════════════════════════════
A.push({
  id: "actions.every-use-server-export-reaches-a-role-refusal-before-its-first-read",
  what:
    "each exported action either awaits the shared gate and returns on `!ok`, or applies the role predicate itself — and does so BEFORE its first `.from(...)`. The export list is DISCOVERED from the source rather than written here, so an eighth action added tomorrow is covered by this guard without anyone remembering to edit it; a hardcoded list of seven would go green over a new hole",
  run: () => {
    // `masked` throughout: every token this clause looks for (`.from(`, the gate
    // call, the predicate call) is code, and masking is what stops a `}` inside a
    // template literal — getContactActivity has several — from ending a body early
    // and turning "the rest of this function is unreachable to me" into "gated".
    const src = masked(F.action)
    const names = exportedActions(src)
    if (names.length === 0) return { ok: false, detail: "the module exports no async function — aimed at the wrong shape" }
    const pred = rolePredicateName(gateBody() ?? "")
    const ungated: string[] = []
    for (const n of names) {
      const body = bodyOf(F.action, n, "masked")
      if (body === null) { ungated.push(`${n} (body unparseable)`); continue }
      const firstRead = body.search(/\.from\s*\(/)
      const viaGate = body.search(new RegExp(`await\\s+${GATE}\\s*\\(`))
      const gateRefuses = viaGate !== -1 && /if\s*\(\s*!\s*[A-Za-z_$][\w$]*\.ok\s*\)\s*return/.test(body)
      const viaPred = pred ? body.search(new RegExp(`!\\s*${pred}\\s*\\(`)) : -1
      const predRefuses = viaPred !== -1 && new RegExp(`!\\s*${pred}\\s*\\([^)]*\\)\\s*\\)\\s*\\{[^}]*return`).test(body)
      const at = gateRefuses ? viaGate : predRefuses ? viaPred : -1
      if (at === -1) { ungated.push(`${n} (no role refusal at all)`); continue }
      if (firstRead !== -1 && firstRead < at) ungated.push(`${n} (reads at ${firstRead} before refusing at ${at})`)
    }
    return ungated.length === 0
      ? { ok: true, detail: `${names.length} exported action(s) gated: ${names.join(", ")}` }
      : { ok: false, detail: `UNGATED: ${ungated.join("; ")}` }
  },
  breaks: [
    {
      // One sibling loses its gate — the exact way six of these seven were
      // ungated before the file grew a shared authorizeContactAccess at all.
      file: F.action,
      find: `export async function getContactCreditAccounts(contactId: string) {
  const gate = await authorizeContactAccess(contactId)
  if (!gate.ok) return { accounts: [], error: gate.error }`,
      replace: `export async function getContactCreditAccounts(contactId: string) {
  const gate = { ok: true as const, brokerageId: "", userType: null, contact: { id: "", brokerage_id: "" } }`,
    },
    {
      // The copilot queue loses its role test but keeps its tenant filter — the
      // exact half-gate this wave found.
      file: F.action,
      find: `  if (!isCrmContactStaff(userType)) {
    return { suggestions: [], error: "Forbidden" }
  }`,
      replace: ``,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 6 — THE ROSTER IS DERIVED, LEGAL, AND CORRECTLY SHAPED IN BOTH DIRECTIONS
// ═════════════════════════════════════════════════════════════════════════════
A.push({
  id: "roster.one-definition-every-member-storable-the-three-refused-absent-and-agent-present",
  what:
    "the admitted set SPREADS the one exported contact-scope roster (§6 — a second hand-typed list is how two answers to one question are born); every member is a value the LIVE users.user_type CHECK admits, read from scripts/check-vocabularies.ts rather than retyped, because a member the column cannot hold is a permission that can never fire; `contact`, `vendor` and `lender` are ABSENT (§5, and the eight live seats that made this exploitable); and `agent` is PRESENT, because /crm is an agent surface and a gate narrower than the surface it protects breaks the feature for the people it was built for while leaving nothing safer",
  run: () => {
    // `plain`: the roster's members ARE string literals. Comments blanked, so the
    // long header above the set — which names contact, vendor and lender verbatim
    // as the seats it REFUSES — cannot be read as members.
    const src = plain(F.action)
    const rosterSrc = plain(F.roster)
    if (!/import\s*\{[^}]*\bCONTACT_SCOPE_STAFF_USER_TYPES\b[^}]*\}\s*from/.test(src)) {
      return { ok: false, detail: "the shared roster is not imported — this is a second, local list" }
    }
    // IMPORTED IS NOT ENOUGH: the import could stand while the members are typed
    // out again beside it, which is the §6 defect wearing the fix's clothes.
    if (!/\.\.\.\s*CONTACT_SCOPE_STAFF_USER_TYPES/.test(src)) {
      return { ok: false, detail: "the shared roster is imported but not SPREAD — the members are retyped, so the two lists can drift" }
    }
    const members = setMembers(src, "CRM_CONTACT_STAFF_USER_TYPES", rosterSrc)
    if (members === null) return { ok: false, detail: "CRM_CONTACT_STAFF_USER_TYPES could not be resolved (unparsed declaration or unresolvable spread)" }
    if (members.length === 0) return { ok: false, detail: "the admitted set resolved EMPTY — a roster nobody is in is not a proof" }
    if (LIVE_USER_TYPES.size === 0) return { ok: false, detail: "the live user_type vocabulary cache is empty — this proof cannot run" }
    const illegal = members.filter((m) => !LIVE_USER_TYPES.has(m))
    if (illegal.length) return { ok: false, detail: `member(s) the live CHECK cannot store: ${illegal.join(", ")}` }
    const forbidden = ["contact", "vendor", "lender"].filter((r) => members.includes(r))
    if (forbidden.length) return { ok: false, detail: `§5 seat(s) admitted: ${forbidden.join(", ")}` }
    if (!members.includes("agent")) return { ok: false, detail: "`agent` is absent — every agent is locked out of /crm" }
    return { ok: true, detail: `${members.length} seat(s), all storable, §5's three absent: ${members.join(", ")}` }
  },
  breaks: [
    {
      // The defect in its purest form: the seat §5 names, admitted.
      file: F.action,
      find: `  "broker_admin",
  "isa",`,
      replace: `  "broker_admin",
  "lender",
  "isa",`,
    },
    {
      // The opposite failure: the gate narrowed to admin-class, which refuses the
      // agent whose CRM this is. A guard that only catches widening is half a guard.
      file: F.roster,
      find: `  "agent",
  "team_lead",`,
      replace: `  "team_lead",`,
    },
    {
      // A second, hand-typed roster — the §6 defect. The spread is what makes the
      // two answers one answer.
      file: F.action,
      find: `  ...CONTACT_SCOPE_STAFF_USER_TYPES,`,
      replace: `  "agent", "team_lead", "tc", "admin", "broker", "broker_owner",`,
    },
    {
      // A member the column cannot hold: `super_admin` is not one of the fifteen,
      // so it matches nobody, forever, while reading as an admitted role.
      file: F.action,
      find: `  "broker_admin",
  "isa",`,
      replace: `  "broker_admin",
  "super_admin",
  "isa",`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// RUN
// ═════════════════════════════════════════════════════════════════════════════
function main() {
  let pass = 0, fail = 0
  const failures: string[] = []

  console.log("\n══════════════════════════════════════════════════════════════════")
  console.log(" Contact detail role gate — a tenant check with no role check is a directory")
  console.log("══════════════════════════════════════════════════════════════════")

  console.log("\n─── ASSERTIONS ───────────────────────────────────────────────────")
  for (const a of A) {
    const r = a.run()
    if (r.ok) { pass++; console.log(`  ✔ ${a.id}\n      ${a.what}${r.detail ? `\n      → ${r.detail}` : ""}`) }
    else { fail++; failures.push(`${a.id}: ${r.detail ?? ""}`); console.log(`  ✘ ${a.id}\n      ${a.what}\n      → ${r.detail ?? ""}`) }
  }

  let negPass = 0, negFail = 0
  const negProblems: string[] = []
  if (RUN_NEGATIVE) {
    console.log("\n─── NEGATIVE CONTROLS (the defect is written back on purpose) ────")
    for (const a of A) {
      if (a.breaks.length === 0) {
        negFail++
        negProblems.push(`${a.id}: assertion with NO negative control`)
        console.log(`  ✘ ${a.id}  no negative control defined`)
        continue
      }
      for (let i = 0; i < a.breaks.length; i++) {
        const b = a.breaks[i]
        const path = resolve(ROOT, b.file)
        const before = readFileSync(path, "utf8")
        const digest = createHash("sha256").update(before).digest("hex")
        const after = before.replace(b.find, b.replace)
        if (after === before) {
          negFail++
          negProblems.push(`${a.id}[${i}]: the mutation DID NOT APPLY to ${b.file} — the control is theatre`)
          console.log(`  ✘ ${a.id}[${i}]  mutation did not apply — fix the find string`)
          continue
        }
        writeFileSync(path, after, "utf8")
        const onDisk = readFileSync(path, "utf8")
        const applied = onDisk !== before && (b.replace === "" || onDisk.includes(b.replace.split("\n")[0]))
        let broke = false, detail = ""
        try { const r = a.run(); broke = !r.ok; detail = r.detail ?? "" }
        catch (e) { broke = true; detail = `threw: ${(e as Error).message}` }
        finally { writeFileSync(path, before, "utf8") }
        const restored = createHash("sha256").update(readFileSync(path)).digest("hex") === digest
        if (broke && restored && applied) {
          negPass++
          console.log(`  ✔ ${a.id}[${i}]  patch verified on disk, flipped RED as required, file restored (sha256 verified)`)
        } else {
          negFail++
          if (!applied) negProblems.push(`${a.id}[${i}]: the patched text was NOT observed on disk`)
          if (!broke) negProblems.push(`${a.id}[${i}]: still PASSED with the defect reintroduced — the assertion is worthless as written`)
          if (!restored) negProblems.push(`${a.id}[${i}]: FILE NOT RESTORED (${b.file})`)
          console.log(`  ✘ ${a.id}[${i}]  ${!applied ? "patch not observed" : ""}${!broke ? " did NOT flip" : ""}${!restored ? " FILE NOT RESTORED" : ""}${detail ? ` (${detail})` : ""}`)
        }
      }
    }
  }

  console.log("\n" + "═".repeat(70))
  console.log(` ASSERTIONS  ${pass} passed, ${fail} failed`)
  if (RUN_NEGATIVE) console.log(` CONTROLS    ${negPass} flipped RED as required, ${negFail} did not`)
  console.log("═".repeat(70))
  if (failures.length) { console.log("\nFailures:"); failures.forEach((f) => console.log("  · " + f)) }
  if (negProblems.length) { console.log("\nControl problems:"); negProblems.forEach((f) => console.log("  · " + f)) }

  if (fail > 0 || negFail > 0) { console.log("\n ❌ CONTACT_DETAIL_ROLE_GATE_FAIL"); process.exit(1) }
  console.log("\n ✅ CONTACT_DETAIL_ROLE_GATE_PASS — every contact-PII export in app/actions/contact-details.ts refuses a non-staff seat before it reads anything, identity comes from the one session survivor, a refused ownership read stays a refusal instead of becoming \"not found\", and the admitted roster is one derived list of storable seats with §5's three absent and the agent still in it")
}
main()
