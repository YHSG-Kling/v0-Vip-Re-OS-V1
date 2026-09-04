#!/usr/bin/env tsx
/**
 * scripts/contact-scope-role-gate-simulator.ts
 *   (tsx scripts/contact-scope-role-gate-simulator.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE REST OF THE CLASS — TWELVE CONTACT-KEYED GATES THAT CHECKED TENANCY AND
 * NOT ROLE.
 *
 * ── WHY THIS IS A SECOND FILE AND NOT AN EDIT TO SEC2's ─────────────────────
 * Lane SEC2 proved the same rule over app/actions/contact-details.ts in
 * scripts/contact-detail-role-gate-simulator.ts. This lane was told to EXTEND
 * that file. It does not exist in this worktree — SEC2's patch had not landed —
 * so extending it would have meant writing assertions on top of a file this lane
 * cannot read, and a proof that cannot see its own harness is exactly the blind
 * guard CLAUDE.md §2 is about. The sibling proof is therefore standalone, built
 * on the same harness and the same control discipline, and wired on its own so
 * it RUNS rather than waiting for a merge that might not happen. INTEGRATOR:
 * keep both, or fold this file's assertions into SEC2's and delete the
 * `test:contact-scope-role-gate` line — either way keep every assertion and
 * every control from both. Do not resolve the overlap by dropping one.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * A gate that reads the caller's `users.brokerage_id`, reads the target
 * contact's `brokerage_id`, and admits on EQUALITY ALONE has no role test.
 * `users.user_type` can store `contact`, `vendor` and `lender`; those rows carry
 * a brokerage_id; so every one of them passed for EVERY contact in the tenant.
 * CLAUDE.md §5: contacts, lenders and vendors see no financials and see only
 * their own.
 *
 * Twelve sites, and the two worst are WRITES rather than reads:
 *   · updateChannelControls flips `call_stop_flag`, the kill switch that
 *     suppresses a contact's phone, and rewrites the `social_handles` map the AI
 *     ISA dials out against.
 *   · createPropertyAlert with frequency 'instant' pushes SMS to a contact
 *     immediately, billed to the brokerage, filed under the caller's user id.
 *   · sendFirstLookText sends an SMS whose body the caller supplies.
 * Two more are genuinely PORTAL-facing — a buyer reading their OWN matches and
 * their OWN negotiation mirror — and those are gated by `requireContactAccess`,
 * which admits the contact themselves and refuses every other non-staff seat.
 * Ruling one way for all twelve would have been wrong in both directions.
 *
 * ── THE FIVE PROPERTIES, EACH A CONSTRUCT AND NOT A SPELLING ────────────────
 *
 *  1. EVERY SITE ASKS ABOUT THE ROLE AND REFUSES ON THE ANSWER. Calling the
 *     predicate is not enough — the answer has to reach a `return`. A gate that
 *     asks and discards is the same gate it was.
 *
 *  2. THE ROLE TEST PRECEDES THE FIRST PRIVILEGED READ. It sits before the
 *     first `createServiceClient()` and before the first `.from(` in the body, so
 *     a refusal costs nothing and reads nothing. A check that runs after the
 *     privileged read is an audit note, not a gate.
 *
 *  3. NO OWNERSHIP READ DROPS ITS ERROR. supabase-js RESOLVES a refused query
 *     (§3), so `const { data }` alone reports "permission denied" exactly like
 *     "no such row" — and pre-rollout, when every table is empty, that lie is
 *     invisible.
 *
 *  4. A REFUSED READ IS NOT ANSWERED WITH A CLEAN NEGATIVE. Where a contacts
 *     read binds an error, that error is branched on, and its sentence is
 *     DISTINCT from the "not found" sentence beside it. Laundering an outage
 *     into "Contact not found" sends a legitimate user to fix an account that
 *     was never wrong.
 *
 *  5. ONE ROSTER, DERIVED, EVERY MEMBER STORABLE, THE REFUSED SEATS ABSENT.
 *     lib/auth/crm-contact-staff.ts consumes the shared ladder rather than
 *     retyping it; its three extras are checked against the GENERATED live
 *     vocabulary cache rather than a hand-typed list (a role literal the CHECK
 *     cannot store would read as admitted while matching nobody, forever); and
 *     `contact`/`vendor`/`lender` appear in no roster literal in the file.
 *
 * ── HOW IT IS BUILT (CLAUDE.md §2) ──────────────────────────────────────────
 *   · TWO offset-aligned views of every file, both from scripts/strip-comments.ts,
 *     never a hand-rolled masker: `blankStrings` for every brace/paren walk and
 *     every code-token regex, `blankComments` for the two assertions that must
 *     read an actual VALUE. Both blank to spaces, so one index serves both, and
 *     comments are blanked in BOTH — so this file's own header, and the long
 *     doc-comments the fix added to each site (which name `vendor`, `lender` and
 *     `contact` verbatim and quote the refusal sentences), can never satisfy an
 *     assertion about the code. A TOMBSTONE IS NOT A CALL SITE.
 *   · The body extractor SKIPS THE RETURN TYPE by angle depth. Several subjects
 *     are declared `…): Promise<\n | { ok: true; … }\n | { ok: false; … }\n> {`,
 *     so "the first `{` after the parameter list" is a TYPE. A naive extractor
 *     hands every assertion the union's members and then reports, calmly, that
 *     the gate contains no role test — green on a file it never read.
 *   · Every assertion carries NEGATIVE CONTROLS: the defect is written back into
 *     the real file, the patch is VERIFIED ON DISK (a find-string that no longer
 *     matches is theatre, not a control), the assertion must flip RED, and the
 *     file is restored and re-verified by sha256.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import { blankComments, blankStrings } from "./strip-comments"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const ROSTER_MODULE = "lib/auth/crm-contact-staff.ts"
const SHARED_ROSTER_IMPORT = "@/lib/portal/require-contact-access"
const VOCAB_CACHE = "scripts/check-vocabularies.ts"

/** The three §5 seats this whole wave exists to refuse. */
const REFUSED_SEATS = ["contact", "vendor", "lender"] as const

type Kind = "staff" | "portal"

interface Site {
  file: string
  /** The function whose body carries the gate. */
  gate: string
  kind: Kind
  /** Does this body perform its own contacts ownership read? */
  readsContacts: boolean
}

/**
 * The twelve gated bodies. Listed rather than discovered, deliberately: this is
 * a CENSUS OF A FIX, and a discovered list would quietly shrink to zero the day
 * a rename broke the finder. Assertion 0 below is the positive control that
 * keeps this list honest — every entry must resolve to a real body on disk, so a
 * renamed or deleted subject fails loudly instead of being skipped.
 */
const SITES: Site[] = [
  { file: "app/actions/contacts/update-channel-controls.ts", gate: "authorizeContactAccess", kind: "staff", readsContacts: true },
  { file: "app/actions/documents.ts", gate: "getContactDocuments", kind: "staff", readsContacts: true },
  { file: "app/actions/buyer-coaching.ts", gate: "getBuyerCoaching", kind: "staff", readsContacts: true },
  { file: "app/actions/portal-stream.ts", gate: "getAgentPortalStream", kind: "staff", readsContacts: true },
  { file: "app/actions/inbox.ts", gate: "markInboxRead", kind: "staff", readsContacts: true },
  { file: "app/actions/instant-property-alerts.ts", gate: "sendFirstLookText", kind: "staff", readsContacts: true },
  { file: "app/actions/instant-property-alerts.ts", gate: "ensureSmsFirstChannels", kind: "staff", readsContacts: false },
  { file: "app/actions/ai-insights.ts", gate: "draftSmartEmail", kind: "staff", readsContacts: true },
  { file: "app/actions/ai-insights.ts", gate: "generateContactInsights", kind: "staff", readsContacts: false },
  { file: "app/actions/property-alerts/alert-actions.ts", gate: "requireAgent", kind: "staff", readsContacts: false },
  { file: "app/actions/buyer-portal-matches.ts", gate: "getBuyerPortalMatches", kind: "portal", readsContacts: false },
  { file: "app/actions/negotiation-strategy.ts", gate: "getNegotiationStrategyForContactAction", kind: "portal", readsContacts: false },
]

// ─────────────────────────────────────────────────────────────────────────────
// Source views — read FRESH every time, because the negative layer rewrites the
// real files on disk between calls.
// ─────────────────────────────────────────────────────────────────────────────
const raw = (p: string) => readFileSync(resolve(ROOT, p), "utf8")
/** Comments AND string contents blanked to spaces. For code-token scans. */
const codeOf = (p: string) => blankStrings(raw(p))
/** Comments blanked, string CONTENTS intact. For the two value-reading checks. */
const literalsOf = (p: string) => blankComments(raw(p))

function matchParen(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++
    else if (src[i] === ")") { depth--; if (depth === 0) return i }
  }
  return -1
}

function matchBrace(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") { depth--; if (depth === 0) return i }
  }
  return -1
}

/**
 * The [start, end) offsets of a top-level `function <name>(…)` declaration's
 * body, braces excluded.
 *
 * The parameter list is walked by PAREN depth (a destructured or object-typed
 * parameter is not the body's opening brace), and the return-type annotation is
 * then skipped by ANGLE depth — `Promise<{ ok: true } | { ok: false }>` contains
 * two `{` that belong to a TYPE. Without that, every assertion below would be
 * handed a union's members and would report the gate as empty.
 *
 * A RANGE and not a string, on purpose: the range is computed ONCE, on the
 * string-blanked view, and then applied to BOTH views. Walking braces on a view
 * that still has string contents would desync the two, because a `}` inside a
 * template literal is text and not a closing brace — and several of these
 * bodies are full of template literals (the AI prompts).
 */
function functionBodyRange(code: string, name: string): [number, number] | null {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(code)
  if (!m) return null
  const openParen = code.indexOf("(", m.index)
  const closeParen = matchParen(code, openParen)
  if (closeParen === -1) return null

  let angle = 0
  for (let i = closeParen + 1; i < code.length; i++) {
    const c = code[i]
    if (c === "<") angle++
    else if (c === ">") { if (angle > 0) angle-- }
    else if (c === "{" && angle === 0) {
      const close = matchBrace(code, i)
      return close === -1 ? null : [i + 1, close]
    }
  }
  return null
}

/** Both offset-aligned views of one gate's body, or null when it is not there. */
function bodiesOf(s: Site): { code: string; lit: string } | null {
  const code = codeOf(s.file)
  const r = functionBodyRange(code, s.gate)
  if (!r) return null
  return { code: code.slice(r[0], r[1]), lit: literalsOf(s.file).slice(r[0], r[1]) }
}

const bodyOf = (s: Site) => bodiesOf(s)?.code ?? null

/** The role predicate a site of this kind must consult. */
const predicateFor = (k: Kind) => (k === "staff" ? "isCrmContactStaff" : "requireContactAccess")

/**
 * Does `body` ask the predicate AND let the answer reach a `return`?
 *
 * "Reaches a return" is checked structurally, not by spelling: for the staff
 * predicate the call must sit inside an `if (…)` whose consequent returns; for
 * the portal gate the binding it produces must be tested for `.ok` and that test
 * must return. Renaming the local binding keeps this green; discarding the
 * answer does not.
 */
function refusesOnRole(body: string, kind: Kind): { ok: boolean; why: string } {
  const pred = predicateFor(kind)
  if (!new RegExp(`\\b${pred}\\s*\\(`).test(body)) return { ok: false, why: `${pred}( is never called` }

  if (kind === "staff") {
    // if (!isCrmContactStaff(…)) … return
    const re = new RegExp(`if\\s*\\(\\s*!\\s*${pred}\\s*\\(`, "g")
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      const openIf = body.indexOf("(", m.index)
      const closeIf = matchParen(body, openIf)
      if (closeIf === -1) continue
      const tail = body.slice(closeIf + 1, closeIf + 400)
      if (/^\s*(\{[\s\S]{0,300}?)?\breturn\b/.test(tail)) return { ok: true, why: "refuses inside the role branch" }
    }
    return { ok: false, why: `${pred} is called but its answer never reaches a return` }
  }

  const bind = new RegExp(`(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*await\\s+${pred}\\s*\\(`).exec(body)
  if (!bind) return { ok: false, why: `${pred} result is not bound` }
  const id = bind[1]
  const guard = new RegExp(`if\\s*\\(\\s*!\\s*${id}\\.ok\\s*\\)\\s*(\\{[\\s\\S]{0,400}?)?\\breturn\\b`)
  if (!guard.test(body)) return { ok: false, why: `${id}.ok is never tested with a returning branch` }
  return { ok: true, why: `refuses on !${id}.ok` }
}

/** First offset of a regex in `body`, or Infinity. */
function firstAt(body: string, re: RegExp): number {
  const m = re.exec(body)
  return m ? m.index : Number.POSITIVE_INFINITY
}

/** Every `.from(` call in a body, with the table name read from the literal view. */
function tableReads(b: { code: string; lit: string }): Array<{ table: string; at: number }> {
  const out: Array<{ table: string; at: number }> = []
  const re = /\.from\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(b.code)) !== null) {
    const after = m.index + m[0].length
    const t = /^\s*["']([A-Za-z0-9_]+)["']/.exec(b.lit.slice(after, after + 64))
    out.push({ table: t ? t[1] : "", at: m.index })
  }
  return out
}

/**
 * Every `.from("contacts")` read in the body that binds `data`, with whether the
 * same destructuring also binds `error`.
 *
 * Strings are blanked in the code view (so no assertion can be satisfied by a
 * table name that appears in prose or in a fixture), which also means the table
 * cannot be READ there. The destructuring is matched on the code view and the
 * table name is then read from the LITERAL view at the same offset — the two
 * views are offset-aligned by construction, both blanking to spaces.
 */
function contactsReads(b: { code: string; lit: string }): Array<{ bindsError: boolean; errorId: string | null; at: number }> {
  const out: Array<{ bindsError: boolean; errorId: string | null; at: number }> = []
  const re = /const\s*\{([^}]*)\}\s*=\s*await\s+[A-Za-z_$][\w$]*\s*\.from\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(b.code)) !== null) {
    const after = m.index + m[0].length
    const t = /^\s*["']([A-Za-z0-9_]+)["']/.exec(b.lit.slice(after, after + 64))
    if (!t || t[1] !== "contacts") continue
    const destructured = m[1]
    if (!/\bdata\b/.test(destructured)) continue
    const errMatch = /\berror\s*:\s*([A-Za-z_$][\w$]*)/.exec(destructured)
    const bindsError = /\berror\b/.test(destructured)
    out.push({ bindsError, errorId: errMatch ? errMatch[1] : bindsError ? "error" : null, at: m.index })
  }
  return out
}

/**
 * The `users.user_type` vocabulary, from the GENERATED cache, never retyped —
 * so this proof asserts the RULE ("every admitted seat is one the database can
 * store") and DERIVES the number, rather than pinning a hand-copied list that
 * goes stale the next time a migration adds a role (CLAUDE.md §2).
 *
 * Anchored to the `users:` block, not to the first `user_type:` in the file: a
 * bare search would silently answer with some other table's column the day one
 * is added, and the assertion would then be measuring the wrong vocabulary while
 * still reporting green.
 */
function storableUserTypes(): string[] {
  const src = literalsOf(VOCAB_CACHE)
  const block = /\busers:\s*\{([\s\S]*?)\n\s*\},/.exec(src)
  if (!block) return []
  const m = /user_type:\s*\[([^\]]*)\]/.exec(block[1])
  if (!m) return []
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
}

/** Every string literal inside the roster module's Set literals. */
function rosterLiterals(): string[] {
  const src = literalsOf(ROSTER_MODULE)
  const out: string[] = []
  const re = /new\s+Set\s*\(\s*\[/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf("[", m.index)
    let depth = 0
    let close = -1
    for (let i = open; i < src.length; i++) {
      if (src[i] === "[") depth++
      else if (src[i] === "]") { depth--; if (depth === 0) { close = i; break } }
    }
    if (close === -1) continue
    for (const s of src.slice(open, close).matchAll(/"([^"]*)"/g)) out.push(s[1])
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertions
// ─────────────────────────────────────────────────────────────────────────────
type Result = { ok: boolean; detail?: string }
interface Break { file: string; find: string; replace: string }
interface Assertion { id: string; what: string; run: () => Result; breaks: Break[] }

const A: Assertion[] = []

A.push({
  id: "census.every-listed-subject-still-resolves-to-a-body",
  what: "the twelve gated bodies all exist on disk — the POSITIVE CONTROL for every absence assertion below, so a rename cannot turn this proof into a green no-op",
  run: () => {
    const missing = SITES.filter((s) => bodyOf(s) === null).map((s) => `${s.file}#${s.gate}`)
    if (missing.length) return { ok: false, detail: `no body found for: ${missing.join(", ")}` }
    return { ok: true, detail: `${SITES.length}/${SITES.length} bodies resolved (denominator: ${new Set(SITES.map((s) => s.file)).size} files)` }
  },
  breaks: [
    {
      file: "app/actions/buyer-coaching.ts",
      find: "export async function getBuyerCoaching(",
      replace: "export async function getBuyerCoachingRenamed(",
    },
  ],
})

A.push({
  id: "gate.every-site-asks-the-role-and-refuses-on-the-answer",
  what: "each of the twelve consults its role predicate (isCrmContactStaff for the ten back-office sites, requireContactAccess for the two portal ones) AND lets the answer reach a return — asking and discarding is the same gate it was",
  run: () => {
    const bad: string[] = []
    for (const s of SITES) {
      const body = bodyOf(s)
      if (body === null) { bad.push(`${s.file}#${s.gate}: no body`); continue }
      const r = refusesOnRole(body, s.kind)
      if (!r.ok) bad.push(`${s.file}#${s.gate}: ${r.why}`)
    }
    if (bad.length) return { ok: false, detail: bad.join(" | ") }
    return { ok: true, detail: `${SITES.length} gates ask and refuse (10 staff, 2 portal)` }
  },
  breaks: [
    {
      // The role test deleted outright — the pre-wave-26 state of this file.
      file: "app/actions/contacts/update-channel-controls.ts",
      find: "  if (!isCrmContactStaff(caller.userType)) return { ok: false, error: 'Forbidden' }",
      replace: "  void isCrmContactStaff",
    },
    {
      // Asked, and the answer thrown away. The subtler half of the same defect.
      file: "app/actions/inbox.ts",
      find: 'if (!isCrmContactStaff(caller.userType)) return { success: false, error: "Forbidden" }',
      replace: "const _role = isCrmContactStaff(caller.userType)",
    },
    {
      // The portal half: the gate is called, its refusal never returns.
      file: "app/actions/buyer-portal-matches.ts",
      find: "  if (!gate.ok) {",
      replace: "  if (false) {",
    },
  ],
})

A.push({
  id: "gate.the-role-test-precedes-the-first-privileged-read",
  what: "in every back-office body the role test sits BEFORE the first createServiceClient() and before the first read of anything but the caller's own users row — a refusal must cost nothing and read nothing",
  run: () => {
    const bad: string[] = []
    for (const s of SITES.filter((x) => x.kind === "staff")) {
      const b = bodiesOf(s)
      if (b === null) { bad.push(`${s.file}#${s.gate}: no body`); continue }
      const role = firstAt(b.code, /isCrmContactStaff\s*\(/)
      const svc = firstAt(b.code, /createServiceClient\s*\(/)
      // EXCLUSION, stated rather than hidden: a read of `users` is how a gate
      // LEARNS the role, so it cannot be required to come after the role test —
      // alert-actions#requireAgent selects user_type itself. Every OTHER table
      // is another person's record and must wait.
      const firstForeignRead = tableReads(b).find((r) => r.table !== "users")
      const read = firstForeignRead ? firstForeignRead.at : Number.POSITIVE_INFINITY
      if (role === Number.POSITIVE_INFINITY) { bad.push(`${s.file}#${s.gate}: no role test`); continue }
      if (role > svc) bad.push(`${s.file}#${s.gate}: createServiceClient() runs BEFORE the role test`)
      if (role > read) bad.push(`${s.file}#${s.gate}: a read of "${firstForeignRead?.table || "?"}" runs BEFORE the role test`)
    }
    if (bad.length) return { ok: false, detail: bad.join(" | ") }
    return { ok: true, detail: `${SITES.filter((x) => x.kind === "staff").length} back-office gates refuse before they read (excluded: reads of \`users\`, which is where the role comes from)` }
  },
  breaks: [
    {
      // HOISTS the privileged client above the gate rather than deleting
      // anything — this assertion's own control, not a copy of the one above.
      file: "app/actions/documents.ts",
      find: "  // THE TEST THAT WAS MISSING — asked before the service client exists.\n  if (!isCrmContactStaff(ctx.userType)) {",
      replace: "  const _early = createServiceClient()\n  if (!isCrmContactStaff(ctx.userType)) {",
    },
  ],
})

A.push({
  id: "reads.no-contacts-ownership-read-drops-its-error",
  what: "every contacts ownership read inside these gates destructures `error` — supabase-js RESOLVES a refusal, so `const { data }` alone reports 'permission denied' exactly like 'no such row', and pre-rollout that lie is invisible",
  run: () => {
    const bad: string[] = []
    let checked = 0
    for (const s of SITES.filter((x) => x.readsContacts)) {
      const b = bodiesOf(s)
      if (b === null) { bad.push(`${s.file}#${s.gate}: no body`); continue }
      const reads = contactsReads(b)
      if (reads.length === 0) { bad.push(`${s.file}#${s.gate}: expected a contacts ownership read, found none`); continue }
      for (const r of reads) {
        checked++
        if (!r.bindsError) bad.push(`${s.file}#${s.gate}: a contacts read binds data and NOT error`)
      }
    }
    if (bad.length) return { ok: false, detail: bad.join(" | ") }
    return { ok: true, detail: `${checked} reads across ${SITES.filter((x) => x.readsContacts).length} bodies, all binding error` }
  },
  breaks: [
    {
      file: "app/actions/instant-property-alerts.ts",
      find: "  const { data: contact, error: contactError } = await supabase\n    .from(\"contacts\")",
      replace: "  const contactError = null\n  const { data: contact } = await supabase\n    .from(\"contacts\")",
    },
    {
      file: "app/actions/portal-stream.ts",
      find: '  const { data: contact, error: contactError } = await supabase\n    .from("contacts")',
      replace: '  const contactError = null\n  const { data: contact } = await supabase\n    .from("contacts")',
    },
  ],
})

A.push({
  id: "refusal.an-outage-is-never-answered-with-a-clean-negative",
  what: "where a gate binds an error from its contacts read, that error is branched on AND its sentence differs from the 'not found' sentence beside it — laundering a refused read into 'Contact not found' reports an outage as a decision",
  run: () => {
    const bad: string[] = []
    let checked = 0
    for (const s of SITES.filter((x) => x.readsContacts)) {
      const b = bodiesOf(s)
      if (b === null) { bad.push(`${s.file}#${s.gate}: no body`); continue }
      const code = b.code
      const lits = b.lit
      const reads = contactsReads(b)
      const errId = reads.find((r) => r.errorId)?.errorId
      if (!errId) { bad.push(`${s.file}#${s.gate}: no bound error to branch on`); continue }
      // The error must be TESTED.
      if (!new RegExp(`if\\s*\\(\\s*${errId}\\b`).test(code)) {
        bad.push(`${s.file}#${s.gate}: ${errId} is bound but never tested`)
        continue
      }
      // The sentence returned on the error branch must not be the same one
      // returned when the contact simply is not there.
      const errBranch = new RegExp(`if\\s*\\(\\s*${errId}\\b[^)]*\\)\\s*(?:\\{)?[\\s\\S]{0,400}?return[^\\n]*`).exec(lits)
      const notFound = /if\s*\(\s*!\s*(?:contact|c|contactRow|data)\b[\s\S]{0,400}?return[^\n]*/.exec(lits)
      checked++
      if (errBranch && notFound) {
        const a = [...errBranch[0].matchAll(/"([^"]{3,})"|'([^']{3,})'/g)].map((x) => x[1] ?? x[2])
        const b = [...notFound[0].matchAll(/"([^"]{3,})"|'([^']{3,})'/g)].map((x) => x[1] ?? x[2])
        const shared = a.filter((x) => b.includes(x))
        if (a.length > 0 && b.length > 0 && shared.length > 0) {
          bad.push(`${s.file}#${s.gate}: the refused-read branch and the not-found branch return the SAME sentence ${JSON.stringify(shared[0])}`)
        }
      }
    }
    if (bad.length) return { ok: false, detail: bad.join(" | ") }
    return { ok: true, detail: `${checked} gates keep an outage and a clean negative apart` }
  },
  breaks: [
    {
      file: "app/actions/contacts/update-channel-controls.ts",
      find: "  if (contactError) return { ok: false, error: 'Access check failed' }",
      replace: "  if (contactError) return { ok: false, error: 'Contact not found' }",
    },
    {
      file: "app/actions/buyer-coaching.ts",
      find: '  if (contactError) {\n    return { success: false, error: "Access check failed" }\n  }',
      replace: '  if (contactError) {\n    return { success: false, error: "Contact not found" }\n  }',
    },
  ],
})

A.push({
  id: "roster.one-definition-derived-every-member-storable-the-three-refused-absent",
  what: "lib/auth/crm-contact-staff.ts CONSUMES the shared ladder instead of retyping it; every literal in its Set literals is a value the live users.user_type CHECK can store (read from the generated cache, not retyped); and contact/vendor/lender appear in none of them",
  run: () => {
    const code = codeOf(ROSTER_MODULE)
    // The import PATH is a string literal, so it is blanked in the code view and
    // has to be read from the literal view. Reading it from the code view would
    // have made this branch fail forever on a correct file — the mirror of the
    // blindness this proof exists to avoid.
    const lits = literalsOf(ROSTER_MODULE)
    const storable = storableUserTypes()
    if (storable.length === 0) {
      return { ok: false, detail: `${VOCAB_CACHE} yielded no users.user_type vocabulary — this assertion cannot run and must not report green` }
    }
    if (!lits.includes(SHARED_ROSTER_IMPORT) || !/CONTACT_SCOPE_STAFF_USER_TYPES/.test(code)) {
      return { ok: false, detail: `the roster is NOT derived from ${SHARED_ROSTER_IMPORT}:CONTACT_SCOPE_STAFF_USER_TYPES — a second spelling of one idea (§6)` }
    }
    if (!/\.\.\.\s*\[\s*\.\.\.\s*CONTACT_SCOPE_STAFF_USER_TYPES/.test(code)) {
      return { ok: false, detail: "the shared ladder is imported but not spread into the roster — importing a name it does not use is not derivation" }
    }
    const members = rosterLiterals()
    if (members.length === 0) return { ok: false, detail: "no roster members found — the reader is broken, not the file" }
    const unstorable = members.filter((m) => !storable.includes(m))
    if (unstorable.length) {
      return { ok: false, detail: `roster names ${JSON.stringify(unstorable)}, which users.user_type cannot store — an admitted role that matches nobody, forever` }
    }
    const smuggled = members.filter((m) => (REFUSED_SEATS as readonly string[]).includes(m))
    if (smuggled.length) {
      return { ok: false, detail: `roster admits ${JSON.stringify(smuggled)} — the exact seats CLAUDE.md §5 puts on their own record only` }
    }
    return {
      ok: true,
      detail: `${members.length} extras, all storable; base ladder derived; ${REFUSED_SEATS.join("/")} absent (vocabulary denominator: ${storable.length} storable user_type values)`,
    }
  },
  breaks: [
    {
      // WIDENING — the defect this wave exists to close, written back in.
      file: ROSTER_MODULE,
      find: '  "compliance_officer",\n])',
      replace: '  "compliance_officer",\n  "lender",\n])',
    },
    {
      // A role literal the live CHECK cannot store: reads as admitted, matches
      // nobody, and nothing ever goes red about it.
      file: ROSTER_MODULE,
      find: '  "broker_admin",',
      replace: '  "broker_admin",\n  "super_admin",',
    },
    {
      // §6 — the derived spread replaced by a hand-typed second roster.
      file: ROSTER_MODULE,
      find: "  ...[...CONTACT_SCOPE_STAFF_USER_TYPES].map((v) => String(v).toLowerCase()),",
      replace: '  "agent", "team_lead", "tc", "admin", "broker", "broker_owner",',
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// THE SAME §5 RULE, ONE LAYER UP: THE PERMISSION MATRIX ITSELF
// (wave 26, lane PERM2)
// ═════════════════════════════════════════════════════════════════════════════
//
// The twelve assertions above prove that twelve GATES ask who is calling. None
// of them proves anything about what the answer is allowed to be. Nothing in the
// tree did: lib/security/permission-matrix.ts — the file the manager registry
// calls the single source of truth, read by RoleManager.hasPermission
// (lib/security/role-manager.ts:16), by AccessControl.checkPermission
// (lib/security/access-control.ts:9, which the requirePermission decorator at
// lib/security/server-action-guard.ts:101 THROWS on), by UIHelpers
// (lib/security/ui-helpers.ts:13) and by lib/auth/permissions-client.ts:72 —
// granted the `lender` and `title_agent` seats `contacts:view_all`,
// `transactions:view_all`, `transactions:edit`, `transactions:coordinate`,
// `team:view_all` and `analytics:view_all`. An OUTSIDE PARTY held the whole
// tenant's contact roster, every deal in it, the staff roster, tenant-wide
// analytics, and a write on the transaction record — the precise inverse of
// CLAUDE.md §5, and it sat there because no proof asserted what an external seat
// may hold. These four assertions are that proof.
//
// WHY IT LIVES IN THIS FILE: same rule, same three named seats, same wave. This
// simulator's header already quotes §5 verbatim and its own REFUSED_SEATS
// constant is `contact`/`vendor`/`lender`. A separate script would have needed a
// separate line in the guard chain to say the same sentence twice.
//
// HOW IT IS BUILT (§2): the matrix is read as SOURCE, freshly, on every run —
// never imported. An ES import is cached, so a negative control that rewrites
// the file on disk would be invisible to it and every control below would report
// a clean flip it never made. Both offset-aligned views come from
// scripts/strip-comments.ts (`blankStrings` to walk brackets and match code,
// `blankComments` to read the grant literals themselves), so the long §5
// rationale now sitting inside permission-matrix.ts — which names
// `transactions:edit` and `contacts:view_all` verbatim, because a tombstone must
// name what it replaced — cannot satisfy or violate a single assertion here.
// A TOMBSTONE IS NOT A GRANT.

const MATRIX = "lib/security/permission-matrix.ts"

/**
 * The seats CLAUDE.md §5 puts on their own record only, as they are spelled in
 * the matrix's canonical role vocabulary.
 *
 * §5 names "contacts, lenders and vendors". `title_agent` is here on the DATA
 * MODEL and not by analogy: vendors.category is a live CHECK carrying both
 * 'lender' and 'title' (scripts/check-vocabularies.ts:1621, generated from the
 * live database), lib/kernel/lender-linkage.ts:1-4 states "LENDERS ARE VENDORS"
 * in as many words, and the title partner's own dashboard resolves itself
 * through a `vendors` row (app/title/dashboard/page.tsx:38-52). A title agent is
 * a vendor here, so §5's "vendors" reaches it. If the owner rules otherwise,
 * drop the one entry — every other assertion stands unchanged.
 */
const EXTERNAL_SEATS = ["contact", "vendor", "lender", "title_agent"] as const

function matchBracket(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "[") depth++
    else if (src[i] === "]") { depth--; if (depth === 0) return i }
  }
  return -1
}

/** Both offset-aligned views of one `export const <name> = { … }` in the matrix. */
function matrixObject(name: string): { code: string; lit: string } | null {
  const code = codeOf(MATRIX)
  const m = new RegExp(`export\\s+const\\s+${name}\\b`).exec(code)
  if (!m) return null
  const open = code.indexOf("{", m.index)
  if (open === -1) return null
  const close = matchBrace(code, open)
  if (close === -1) return null
  return { code: code.slice(open, close + 1), lit: literalsOf(MATRIX).slice(open, close + 1) }
}

/**
 * The grant literals on one role's `permissions:` array in ROLE_PERMISSIONS, or
 * null when that role has no such block.
 *
 * The role key is located on the CODE view (a role name inside a comment or a
 * string cannot open a block), the array is walked by BRACKET depth, and the
 * literals are then read from the LITERAL view at the same offsets.
 */
function grantsOf(role: string): string[] | null {
  const o = matrixObject("ROLE_PERMISSIONS")
  if (!o) return null
  const m = new RegExp(`\\n\\s{2}${role}:\\s*\\{`).exec(o.code)
  if (!m) return null
  const open = o.code.indexOf("{", m.index)
  const close = matchBrace(o.code, open)
  if (close === -1) return null
  const pm = /permissions:\s*\[/.exec(o.code.slice(open, close))
  if (!pm) return null
  const aOpen = o.code.indexOf("[", open + pm.index)
  const aClose = matchBracket(o.code, aOpen)
  if (aClose === -1) return null
  return [...o.lit.slice(aOpen, aClose + 1).matchAll(/['"]([A-Za-z_]+:[A-Za-z_]+)['"]/g)].map((x) => x[1])
}

/** One role's `canViewData` in ROLE_HIERARCHY, or null. */
function scopeOf(role: string): string | null {
  const o = matrixObject("ROLE_HIERARCHY")
  if (!o) return null
  const m = new RegExp(`\\n\\s{2}${role}:\\s*\\{`).exec(o.code)
  if (!m) return null
  const open = o.code.indexOf("{", m.index)
  const close = matchBrace(o.code, open)
  if (close === -1) return null
  const v = /canViewData:\s*['"]([a-z]+)['"]/.exec(o.lit.slice(open, close))
  return v ? v[1] : null
}

/** Every `group:action` word the matrix DEFINES — the vocabulary, derived. */
function permissionVocabulary(): string[] {
  const o = matrixObject("PERMISSION_DEFINITIONS")
  if (!o) return []
  return [...o.lit.matchAll(/['"]([a-z_]+:[a-z_]+)['"]\s*:/g)].map((x) => x[1])
}

/**
 * The grants an EXTERNAL seat may not hold, DERIVED from the vocabulary rather
 * than hand-listed (§2: assert the RULE and derive the number, so a word added
 * by a later migration is judged the moment it appears instead of quietly
 * falling outside a frozen list).
 *
 * The rule, one clause per sentence of CLAUDE.md §5:
 *   · financials — nothing but `view_own`. "See no financials — only their own."
 *   · transactions — nothing but `view`. An outside party is a party to its own
 *     deal; it does not read the tenant's book of deals and does not WRITE the
 *     transaction record. (The lender's real writes go to transaction_milestones
 *     / transaction_lenders / transaction_documents, gated per-deal by
 *     requireLenderVendorActor — never through this matrix.)
 *   · contacts — nothing but `view`. The roster belongs to the BROKERAGE (§5,
 *     the leads ruling); an outside party sees the people on its own file.
 *   · leads — nothing at all, for the same reason.
 *   · analytics — nothing but `view_own`.
 *   · listings — nothing but `view_all`. The catalogue is the brokerage's
 *     shopfront and `contact` and `vendor` legitimately hold it today; creating
 *     or editing a listing is staff work.
 *   · team, admin, compliance — nothing at all. Staff rosters, platform
 *     administration and the compliance record are not an outside party's.
 *   · settings — nothing but `manage_account`. Your own account, not the team's
 *     and not the brokerage's.
 */
function forbiddenForExternalSeat(): Set<string> {
  const allowed: Record<string, string[]> = {
    financials: ["view_own"],
    transactions: ["view"],
    contacts: ["view"],
    leads: [],
    analytics: ["view_own"],
    listings: ["view_all"],
    team: [],
    admin: [],
    compliance: [],
    settings: ["manage_account"],
  }
  const out = new Set<string>()
  for (const word of permissionVocabulary()) {
    const [group, action] = word.split(":")
    if (!(group in allowed)) continue
    if (!allowed[group].includes(action)) out.add(word)
  }
  return out
}

A.push({
  id: "matrix.the-finder-can-read-the-matrix-at-all",
  what: "POSITIVE CONTROL for the three assertions below: the permission matrix parses, every one of the four external seats resolves to a real grant array and a real canViewData, and the derived forbidden set is non-empty — a broken parser and a clean matrix both report 'no violations', and this is what tells them apart",
  run: () => {
    const vocab = permissionVocabulary()
    if (vocab.length < 40) return { ok: false, detail: `PERMISSION_DEFINITIONS yielded ${vocab.length} words — the parser is not reading the matrix` }
    const forbidden = forbiddenForExternalSeat()
    if (forbidden.size < 15) return { ok: false, detail: `the derived forbidden set has ${forbidden.size} members — the derivation is not seeing the vocabulary` }
    const unresolved: string[] = []
    for (const seat of EXTERNAL_SEATS) {
      const g = grantsOf(seat)
      if (g === null || g.length === 0) unresolved.push(`${seat}: no permissions array`)
      const s = scopeOf(seat)
      if (s === null) unresolved.push(`${seat}: no canViewData`)
    }
    if (unresolved.length) return { ok: false, detail: unresolved.join(" | ") }
    return {
      ok: true,
      detail: `vocabulary ${vocab.length} words, ${forbidden.size} of them forbidden to an external seat; ${EXTERNAL_SEATS.length}/${EXTERNAL_SEATS.length} seats resolved (${EXTERNAL_SEATS.map((s) => `${s}=${grantsOf(s)!.length}`).join(", ")} grants)`,
    }
  },
  breaks: [
    {
      // The table renamed out from under the parser. Every absence assertion
      // below would otherwise report a clean tree it never read.
      file: MATRIX,
      find: "export const ROLE_PERMISSIONS:",
      replace: "export const ROLE_PERMISSIONS_V2:",
    },
    {
      file: MATRIX,
      find: "export const PERMISSION_DEFINITIONS:",
      replace: "export const PERMISSION_DEFINITIONS_V2:",
    },
  ],
})

A.push({
  id: "matrix.no-external-seat-holds-a-brokerage-wide-or-writing-grant",
  what: "CLAUDE.md §5 stated as a matrix rule: contact, vendor, lender and title_agent hold no brokerage-wide financial, contact, lead, transaction, team, analytics, admin or compliance grant and no transaction WRITE — the forbidden set is derived from the matrix's own vocabulary, not hand-listed",
  run: () => {
    const forbidden = forbiddenForExternalSeat()
    if (forbidden.size < 15) return { ok: false, detail: `forbidden set is ${forbidden.size} members — refusing to report a clean tree from a dead derivation` }
    const bad: string[] = []
    for (const seat of EXTERNAL_SEATS) {
      const g = grantsOf(seat)
      if (g === null) { bad.push(`${seat}: no permissions array`); continue }
      const held = g.filter((p) => forbidden.has(p))
      if (held.length) bad.push(`${seat} holds ${JSON.stringify(held)}`)
    }
    if (bad.length) return { ok: false, detail: `${bad.join(" | ")} — CLAUDE.md §5: contacts, lenders and vendors see no financials, only their own` }
    return {
      ok: true,
      detail: `${EXTERNAL_SEATS.length} external seats, 0 forbidden grants (denominator: ${forbidden.size} forbidden words out of ${permissionVocabulary().length}; seats carry ${EXTERNAL_SEATS.map((s) => `${s}:${grantsOf(s)!.join("+")}`).join(" | ")})`,
    }
  },
  breaks: [
    {
      // The pre-wave-26 lender row, written back one grant at a time.
      file: MATRIX,
      find: "  lender: {\n    role: 'lender',\n    permissions: [\n      'contacts:view',",
      replace: "  lender: {\n    role: 'lender',\n    permissions: [\n      'contacts:view_all',",
    },
    {
      // The transaction WRITE — the clearest violation, on a seat that is not
      // the party that owns the record.
      file: MATRIX,
      find: "  title_agent: {\n    role: 'title_agent',\n    permissions: [\n      'contacts:view',",
      replace: "  title_agent: {\n    role: 'title_agent',\n    permissions: [\n      'transactions:edit',\n      'contacts:view',",
    },
    {
      // Brokerage-wide money on the seat §5 names first.
      file: MATRIX,
      find: "    permissions: ['contacts:view', 'transactions:view', 'listings:view_all'],",
      replace: "    permissions: ['contacts:view', 'transactions:view', 'listings:view_all', 'financials:view_all'],",
    },
  ],
})

A.push({
  id: "matrix.no-external-seat-is-scoped-to-the-whole-tenant",
  what: "the ROW half of the same rule: ROLE_HIERARCHY gives every external seat canViewData 'own', never 'brokerage' or 'all' — a grant narrowed in one half of this file and left tenant-wide in the other is the same violation wearing the other hat",
  run: () => {
    const bad: string[] = []
    for (const seat of EXTERNAL_SEATS) {
      const s = scopeOf(seat)
      if (s === null) { bad.push(`${seat}: no canViewData`); continue }
      if (s !== "own") bad.push(`${seat}: canViewData '${s}'`)
    }
    if (bad.length) return { ok: false, detail: `${bad.join(", ")} — an outside party's data scope is its own rows (lib/security/permissions-service.ts:312 already says 'own' for these seats; the two tables must not disagree, §6)` }
    return { ok: true, detail: `${EXTERNAL_SEATS.length}/${EXTERNAL_SEATS.length} external seats at canViewData 'own'` }
  },
  breaks: [
    {
      file: MATRIX,
      find: "  lender: {\n    role: 'lender',\n    level: 3,\n    canManage: [],\n    canViewData: 'own',",
      replace: "  lender: {\n    role: 'lender',\n    level: 3,\n    canManage: [],\n    canViewData: 'brokerage',",
    },
    {
      file: MATRIX,
      find: "  vendor: {\n    role: 'vendor',\n    level: 1,\n    canManage: [],\n    canViewData: 'own',",
      replace: "  vendor: {\n    role: 'vendor',\n    level: 1,\n    canManage: [],\n    canViewData: 'all',",
    },
  ],
})

A.push({
  id: "matrix.one-vocabulary-every-grant-is-a-defined-word",
  what: "§6 over the whole matrix: every grant literal on every role resolves to a key of PERMISSION_DEFINITIONS, so narrowing a seat cannot be done by inventing a third spelling nobody reads (a 'contacts:view_own' that no gate, no UI helper and no definition knows about grants and refuses nothing)",
  run: () => {
    const vocab = new Set(permissionVocabulary())
    if (vocab.size < 40) return { ok: false, detail: `vocabulary is ${vocab.size} words — parser blind, refusing to report clean` }
    const o = matrixObject("ROLE_PERMISSIONS")
    if (!o) return { ok: false, detail: "ROLE_PERMISSIONS did not parse" }
    const roles = [...o.code.matchAll(/\n {2}([a-z_]+):\s*\{/g)].map((m) => m[1])
    if (roles.length < 10) return { ok: false, detail: `only ${roles.length} roles found in ROLE_PERMISSIONS — the walk is broken` }
    const bad: string[] = []
    let counted = 0
    for (const role of roles) {
      for (const g of grantsOf(role) ?? []) {
        counted++
        if (!vocab.has(g)) bad.push(`${role}:${g}`)
      }
    }
    if (bad.length) return { ok: false, detail: `undefined grant words: ${bad.join(", ")}` }
    return { ok: true, detail: `${counted} grants across ${roles.length} roles, all defined (vocabulary: ${vocab.size} words)` }
  },
  breaks: [
    {
      // A third spelling of "their own contacts" that nothing in the tree reads.
      file: MATRIX,
      find: "  lender: {\n    role: 'lender',\n    permissions: [\n      'contacts:view',",
      replace: "  lender: {\n    role: 'lender',\n    permissions: [\n      'contacts:view_own',",
    },
  ],
})

// ─────────────────────────────────────────────────────────────────────────────
function main() {
  console.log("═".repeat(70))
  console.log(" CONTACT-SCOPE ROLE GATE — the twelve sites lane SEC2 could not reach")
  console.log("═".repeat(70))
  console.log(` subjects   ${SITES.length} gated bodies across ${new Set(SITES.map((s) => s.file)).size} files`)
  console.log(` roster     ${ROSTER_MODULE} (derived from ${SHARED_ROSTER_IMPORT})`)
  console.log(` matrix     ${MATRIX} — ${EXTERNAL_SEATS.length} external seats judged against ${forbiddenForExternalSeat().size} forbidden words derived from ${permissionVocabulary().length}`)
  console.log("\n BLIND SPOTS, published beside the number (CLAUDE.md §2):")
  console.log("  · This proof reads SOURCE. It cannot prove the live rows; the seat")
  console.log(`    vocabulary is taken from ${VOCAB_CACHE}, which the integrator regenerates.`)
  console.log("  · The refusal-sentence assertion can only compare sentences that EXIST.")
  console.log("    app/actions/ai-insights.ts#draftSmartEmail returns a bare \"\" for all four")
  console.log("    of its refusals, so it has no sentences to tell apart and passes vacuously.")
  console.log("    Its role test IS covered by the first three assertions; its return SHAPE is")
  console.log("    a known, unfixed defect (three callers in files outside that lane's table).")
  console.log("  · Sites are LISTED, not discovered. A thirteenth gate of this shape would not")
  console.log("    be noticed here — assertion 0 only proves the twelve listed ones still exist.")
  console.log("  · The four matrix assertions prove the DECLARATION, not the runtime. No lender")
  console.log("    or title surface consults the permission matrix at all today — they gate on")
  console.log("    ASSIGNMENT (requireLenderVendorActor / requireTitleActor, lib/kernel/portal-auth.ts")
  console.log("    :61 and :111) — so a green here does not mean any row filter is scoped. It means")
  console.log("    the table a future gate would read no longer declares the §5 violation.")
  console.log("  · EXTERNAL_SEATS is a LIST of four. A fifth outside-party role added to the")
  console.log("    matrix later is judged by nothing here until it is added to that constant.")
  console.log("  · title_agent is judged as a VENDOR on the live data model (vendors.category")
  console.log("    carries 'title'), not because CLAUDE.md §5 names it. That is an argument, and")
  console.log("    it is the owner's to overturn — see the constant's comment.")
  console.log("  · TWO SIBLING ROLE TABLES ARE OUT OF SCOPE HERE and are NOT judged by these")
  console.log("    assertions: lib/security/permissions-service.ts ROLE_UI_PERMISSIONS (verb:surface")
  console.log("    vocabulary) and lib/security/types.ts CANONICAL_ROLE_CONFIG (snake_case). Both")
  console.log("    already scope these seats narrowly; neither is pinned by a proof.")

  let pass = 0, fail = 0
  const failures: string[] = []

  console.log("\n─── ASSERTIONS ───────────────────────────────────────────────────")
  for (const a of A) {
    let r: Result
    try { r = a.run() } catch (e) { r = { ok: false, detail: `threw: ${(e as Error).message}` } }
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
          negProblems.push(`${a.id}[${i}]: the mutation DID NOT APPLY to ${b.file} — the control is theatre, fix the find string`)
          console.log(`  ✘ ${a.id}[${i}]  mutation did not apply to ${b.file}`)
          continue
        }
        writeFileSync(path, after, "utf8")
        const onDisk = readFileSync(path, "utf8")
        const applied = onDisk !== before && onDisk.includes(b.replace.split("\n")[0])
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

  if (fail > 0 || negFail > 0) { console.log("\n ❌ CONTACT_SCOPE_ROLE_GATE_FAIL"); process.exit(1) }
  console.log("\n ✅ CONTACT_SCOPE_ROLE_GATE_PASS — every contact-keyed gate in this census asks WHO is calling before it reads or writes another person's record, a refused read stays a refusal instead of becoming 'not found', the seat roster is one derived definition whose every member the database can actually store, and the permission matrix those gates would consult grants no outside party the brokerage's contacts, deals, staff roster, analytics or a transaction write")
}
main()
