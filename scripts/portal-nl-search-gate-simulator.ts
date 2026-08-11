#!/usr/bin/env tsx
/**
 * scripts/portal-nl-search-gate-simulator.ts  (tsx scripts/portal-nl-search-gate-simulator.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FIFTH SIBLING — A PAID SEARCH ANY SIGNED-IN USER COULD BILL TO A STRANGER.
 *
 * `portalNaturalSearchAction` is a "use server" export that took a bare
 * `contactId` straight onto `createServiceClient()`. Wave 15 gated the four
 * buyer-facing tools in buyer-offer-tools.ts against `requireContactAccess` and
 * recorded this one as out of scope; the defect is the same class, verbatim.
 * Holding any contact uuid was enough to:
 *   · run a RentCast/IDX natural-language search BILLED to that contact's
 *     brokerage (searchPropertiesCore is tenant-keyed), and
 *   · stamp a `client_portal_activity` row on someone else's client that their
 *     agent reads as their buyer's search intent.
 *
 * This proof stands over four properties, and each is a CONSTRUCT rather than a
 * spelling — renaming the gate binding, the mapper or the local variables keeps
 * every one of them green; regressing the shape does not.
 *
 *  1. THE GATE RUNS BEFORE ANYTHING IS SPENT. The awaited authorization call
 *     precedes the first `createServiceClient()`, the first `.from(...)` and the
 *     provider call, in the function body — so refusing costs nothing. A gate
 *     that runs after the privileged read is not a gate, it is an audit note.
 *
 *  2. IT FAILS CLOSED, AND THE TWO REFUSAL CLASSES STAY APART. The refusal
 *     branch is the statement immediately after the gate, it RETURNS, and it
 *     returns `ok: false`. `requireContactAccess` distinguishes "Access check
 *     failed" (a REFUSED READ — an outage) from "Forbidden" (a DECISION), and
 *     the proof requires every refusal token declared by the gate module to
 *     resolve to a DISTINCT buyer-readable sentence. Collapsing the outage into
 *     the decision sends a legitimate buyer to fix an account that was never
 *     wrong; and the single success exit is required to sit after the provider
 *     call, so no refusal can be answered with a cheerful empty result set.
 *
 *  3. WHAT WAS ALREADY CORRECT IS NOT WEAKENED. The contacts read still
 *     destructures `error` and returns on it (supabase-js RESOLVES a refused
 *     query, so `const { data }` alone reports "permission denied" exactly like
 *     "no rows", and pre-rollout every table is EMPTY — precisely when that lie
 *     is invisible). The activity row still carries `brokerage_id` AND
 *     `agent_id`: the row's SELECT policy admits the agent side only through
 *     those two columns, so an unstamped row is a signal nobody can see.
 *
 *  4. THE ID CLASSES ARE NOT CROSSED. `agents.id`, `users.id` and `contacts.id`
 *     are DISJOINT spaces. The gate returns a `users.id`, which is why the
 *     contact read survives the gate rather than being replaced by it — the
 *     activity row needs an AGENTS-class owner the gate does not carry. The
 *     proof fails if the gate's user id is ever used inside the action body.
 *
 * HOW IT IS BUILT
 *   · Every structural assertion reads COMMENT-STRIPPED source. Prose must never
 *     satisfy a check — this file's own header says `userId`, and assertion 4
 *     would pass on prose alone if comments counted.
 *   · Every assertion carries NEGATIVE CONTROLS: the defect is written back into
 *     the real file, the mutation is VERIFIED TO HAVE APPLIED (a find-string
 *     that no longer matches is theatre, not a control), the check is required
 *     to flip RED, and the file is restored and re-verified by sha256.
 *   · ONE assertion (the caller side) carries a SYNTHETIC control instead, and
 *     says so in its output: its subject file is outside this slice's write
 *     scope, and a proof does not get to edit files its author may not edit.
 *     The control there exercises the assertion's own logic against a defective
 *     input, which is weaker than a real mutation and is labelled as such.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const F = {
  action: "app/actions/portal-nl-search.ts",
  gate: "lib/portal/require-contact-access.ts",
  caller: "app/portal/[contactId]/search/PortalNlSearch.tsx",
}

/** Read fresh every time — the negative layer rewrites these files. */
const raw = (p: string) => readFileSync(resolve(ROOT, p), "utf8")
/** Comment-stripped source: prose must never satisfy a structural assertion. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
const code = (p: string) => strip(raw(p))

// ─────────────────────────────────────────────────────────────────────────────
// Structural helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Index of the matching close brace for the `{` at `open`. */
function matchBrace(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") { depth--; if (depth === 0) return i }
  }
  return -1
}

/** Index of the matching close paren for the `(` at `open`. */
function matchParen(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++
    else if (src[i] === ")") { depth--; if (depth === 0) return i }
  }
  return -1
}

/**
 * The BODY of a top-level function declaration, braces excluded. The parameter
 * list is walked by paren depth so a destructured/object-typed parameter (which
 * this action has) cannot be mistaken for the body's opening brace.
 */
function functionBody(src: string, name: string): string | null {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src)
  if (!m) return null
  const openParen = src.indexOf("(", m.index)
  const closeParen = matchParen(src, openParen)
  if (closeParen === -1) return null
  const openBrace = src.indexOf("{", closeParen)
  if (openBrace === -1) return null
  const closeBrace = matchBrace(src, openBrace)
  if (closeBrace === -1) return null
  return src.slice(openBrace + 1, closeBrace)
}

const ACTION = "portalNaturalSearchAction"
const actionBody = () => functionBody(code(F.action), ACTION)

/** The identifier bound to the awaited authorization call, or null. */
function gateBinding(body: string): string | null {
  const m = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+requireContactAccess\s*\(/.exec(body)
  return m ? m[1] : null
}

/** Non-empty, non-blank lines of a body, with their offset into it. */
function statements(body: string): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = []
  let at = 0
  for (const line of body.split("\n")) {
    if (line.trim().length > 0) out.push({ text: line, at })
    at += line.length + 1
  }
  return out
}

/**
 * The guard that immediately follows the gate call: its source text, taken to
 * the end of its line or to its matching close brace when it opens a block.
 * Returns null when the statement after the gate is not a guard at all — which
 * is itself the failure this exists to catch.
 */
function refusalGuard(body: string, binding: string): string | null {
  const lines = statements(body)
  const i = lines.findIndex((l) => /await\s+requireContactAccess\s*\(/.test(l.text))
  if (i === -1 || i + 1 >= lines.length) return null
  const next = lines[i + 1]
  const guardRe = new RegExp(`^\\s*if\\s*\\(\\s*(?:!\\s*${binding}\\.ok|${binding}\\.ok\\s*===\\s*false)\\s*\\)`)
  if (!guardRe.test(next.text)) return null
  const braceOnLine = next.text.indexOf("{", next.text.indexOf(")"))
  if (braceOnLine === -1) return next.text
  const abs = next.at + braceOnLine
  const close = matchBrace(body, abs)
  return close === -1 ? next.text : body.slice(next.at, close + 1)
}

/** The refusal tokens the gate module itself declares, read from its source. */
function gateRefusalTokens(): string[] {
  const m = /ok:\s*false\s*;\s*error:\s*((?:\s*"[^"]*"\s*\|?)+)/.exec(code(F.gate))
  if (!m) return []
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1])
}

/** `case "<token>": return "<sentence>"` pairs plus the default, from a mapper body. */
function refusalSentences(mapperBody: string): { cases: Map<string, string>; fallback: string | null } {
  const cases = new Map<string, string>()
  for (const m of mapperBody.matchAll(/case\s+"([^"]*)"\s*:\s*return\s+"((?:[^"\\]|\\.)*)"/g)) {
    cases.set(m[1], m[2])
  }
  const d = /default\s*:\s*return\s+"((?:[^"\\]|\\.)*)"/.exec(mapperBody)
  return { cases, fallback: d ? d[1] : null }
}

/**
 * PURE — does a caller of the action branch on the discriminant and keep a
 * refusal OUT of the results state? Extracted as a function over source text so
 * it can be exercised against a defective input (see the synthetic control).
 */
export function callerKeepsRefusalOutOfResults(src: string, actionName: string): { ok: boolean; detail: string } {
  const at = src.indexOf(`await ${actionName}(`)
  if (at === -1) return { ok: false, detail: "the caller does not await the action" }
  const region = src.slice(at, at + 600)
  const binding = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await/.exec(src.slice(Math.max(0, at - 40), at + 20))
  const name = binding ? binding[1] : "r"
  if (!new RegExp(`\\b${name}\\.ok\\b`).test(region)) {
    return { ok: false, detail: "the caller does not branch on the ok discriminant" }
  }
  const elseAt = region.indexOf("else")
  if (elseAt === -1) return { ok: false, detail: "the caller has no refusal arm" }
  const failArm = region.slice(elseAt, elseAt + 200)
  if (!new RegExp(`\\b${name}\\.error\\b`).test(failArm)) {
    return { ok: false, detail: "the refusal arm does not surface the server's own sentence" }
  }
  if (/setResults\s*\(\s*(?:\[\s*\]|r\.results)/.test(failArm)) {
    return { ok: false, detail: "the refusal arm puts a result set on screen — a refusal rendering as 'nothing matched'" }
  }
  return { ok: true, detail: "branches on ok, shows the server's sentence, sets no results" }
}

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
  /**
   * A control that does NOT touch the tree: the assertion's own logic run
   * against a defective synthetic input. Only used where the subject file is
   * outside this slice's write scope, and reported as SYNTHETIC so the weaker
   * guarantee is visible rather than hidden.
   */
  synthetic?: { why: string; run: () => Outcome }
}

const A: Assertion[] = []

// ═════════════════════════════════════════════════════════════════════════════
// 1 — THE GATE RUNS FIRST, SO REFUSING COSTS NOTHING
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "gate.precedes-every-privileged-read-and-every-paid-call",
  what:
    "inside the action body the awaited authorization call comes BEFORE the first `createServiceClient()`, before the first `.from(...)` and before the provider search — an unauthorized caller is turned away having cost the contact's brokerage nothing",
  run: () => {
    const body = actionBody()
    if (!body) return { ok: false, detail: `the ${ACTION} body could not be parsed` }
    const gateAt = body.search(/await\s+requireContactAccess\s*\(/)
    if (gateAt === -1) return { ok: false, detail: "the action awaits no authorization call at all" }
    const marks: Array<[string, number]> = [
      ["createServiceClient()", body.search(/createServiceClient\s*\(/)],
      [".from(", body.search(/\.from\s*\(/)],
      ["searchPropertiesCore(", body.search(/searchPropertiesCore\s*\(/)],
    ]
    const missing = marks.filter(([, i]) => i === -1).map(([n]) => n)
    if (missing.length) return { ok: false, detail: `the action no longer contains: ${missing.join(", ")} — re-read it, this proof is aimed at the wrong shape` }
    const late = marks.filter(([, i]) => i < gateAt).map(([n]) => n)
    return late.length === 0
      ? { ok: true, detail: `gate at ${gateAt}, then ${marks.map(([n, i]) => `${n}@${i}`).join(", ")}` }
      : { ok: false, detail: `these run BEFORE the gate: ${late.join(", ")}` }
  },
  breaks: [
    {
      // The gate demoted below the service client: the privileged read is now
      // built before anyone has been proven to belong to this contact.
      file: F.action,
      find: `  const access = await requireContactAccess(input.contactId)
  if (!access.ok) return { ok: false, error: accessRefusal(access.error) }

  const svc = createServiceClient()`,
      replace: `  const svc = createServiceClient()

  const access = await requireContactAccess(input.contactId)
  if (!access.ok) return { ok: false, error: accessRefusal(access.error) }`,
    },
    {
      // The wave-15-era shape: no gate at all.
      file: F.action,
      find: `  const access = await requireContactAccess(input.contactId)
  if (!access.ok) return { ok: false, error: accessRefusal(access.error) }
`,
      replace: ``,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 2 — IT FAILS CLOSED
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "gate.the-refusal-branch-returns-a-failure-and-nothing-runs-between",
  what:
    "the statement IMMEDIATELY after the gate is a guard on its discriminant, that guard RETURNS, and what it returns is `ok: false` — a guard that only logs falls through into the spend, and a guard with a read wedged in front of it is a gate that has already leaked",
  run: () => {
    const body = actionBody()
    if (!body) return { ok: false, detail: `the ${ACTION} body could not be parsed` }
    const binding = gateBinding(body)
    if (!binding) return { ok: false, detail: "no binding is taken from an awaited authorization call" }
    const guard = refusalGuard(body, binding)
    if (!guard) return { ok: false, detail: `the statement after the gate is not a guard on \`${binding}.ok\`` }
    if (!/\breturn\b/.test(guard)) return { ok: false, detail: "the refusal guard does not return — execution continues into the spend" }
    if (!/ok:\s*false/.test(guard)) return { ok: false, detail: `the refusal guard returns something that is not ok:false: ${guard.trim().slice(0, 90)}` }
    if (/ok:\s*true/.test(guard)) return { ok: false, detail: "the refusal guard answers a refusal with a SUCCESS envelope" }
    return { ok: true, detail: guard.trim().slice(0, 100) }
  },
  breaks: [
    {
      file: F.action,
      find: `  if (!access.ok) return { ok: false, error: accessRefusal(access.error) }`,
      replace: `  if (!access.ok) console.error("[portal-nl-search] access refused:", access.error)`,
    },
    {
      // The cheerful lie: a refusal dressed as a search that found nothing.
      file: F.action,
      find: `  if (!access.ok) return { ok: false, error: accessRefusal(access.error) }`,
      replace: `  if (!access.ok) return { ok: true, results: [] }`,
    },
    {
      // A read wedged between the gate and its guard — the classic way a gate
      // becomes decorative without anyone deleting it.
      file: F.action,
      find: `  const access = await requireContactAccess(input.contactId)
  if (!access.ok)`,
      replace: `  const access = await requireContactAccess(input.contactId)
  const early = createServiceClient()
  if (!access.ok)`,
    },
  ],
})

A.push({
  id: "gate.every-refusal-the-gate-can-give-reaches-the-buyer-as-a-DISTINCT-sentence",
  what:
    "the tokens are read from the GATE MODULE'S own union, and each one resolves through the action's mapper to a different buyer-readable sentence — 'Access check failed' is a refused read and 'Forbidden' is a decision, so answering both with one sentence tells a locked-out buyer to fix an account that was never wrong, and a token the mapper has never been taught is an untranslated internal word on a self-serve screen",
  run: () => {
    const src = code(F.action)
    const body = actionBody()
    if (!body) return { ok: false, detail: `the ${ACTION} body could not be parsed` }
    const binding = gateBinding(body)
    const guard = binding ? refusalGuard(body, binding) : null
    if (!guard) return { ok: false, detail: "no refusal guard to read the mapper out of" }

    const called = /error:\s*([A-Za-z_$][\w$]*)\s*\(/.exec(guard)
    if (!called) return { ok: false, detail: "the refusal's error is not produced by a mapping function" }
    const mapper = functionBody(src, called[1])
    if (!mapper) return { ok: false, detail: `${called[1]} is not a function declared in this file` }

    const tokens = gateRefusalTokens()
    if (tokens.length === 0) return { ok: false, detail: "the gate module's refusal union could not be read" }

    const { cases, fallback } = refusalSentences(mapper)
    const resolved = new Map<string, string>()
    const untranslated: string[] = []
    for (const t of tokens) {
      const s = cases.get(t) ?? fallback
      if (!s) { untranslated.push(t); continue }
      resolved.set(t, s)
    }
    if (untranslated.length) return { ok: false, detail: `no sentence for: ${untranslated.join(", ")}` }

    const seen = new Map<string, string>()
    for (const [t, s] of resolved) {
      const prior = seen.get(s)
      if (prior) return { ok: false, detail: `"${prior}" and "${t}" are answered with the SAME sentence — a refused read is being reported as a decision` }
      seen.set(s, t)
    }
    return { ok: true, detail: `${tokens.length} gate refusal(s), ${seen.size} distinct sentence(s)` }
  },
  breaks: [
    {
      // Launder the DECISION into the OUTAGE sentence: both now read the same.
      file: F.action,
      find: `    case "Forbidden":
      return "You're signed in with a different account than this page belongs to — sign in with the email your agent invited you at, or reply to their last message."`,
      replace: `    case "Forbidden":
      return "We couldn't verify your account just now — please try again in a moment."`,
    },
    {
      // Drop the arm that covers "Access check failed": the token becomes
      // untranslated, which is how internal vocabulary reaches a buyer.
      file: F.action,
      find: `    default:
      return "We couldn't verify your account just now — please try again in a moment."
`,
      replace: ``,
    },
  ],
})

A.push({
  id: "gate.the-one-success-exit-sits-after-the-provider-call",
  what:
    "the action body contains exactly ONE `ok: true` return and it comes after the provider search — every other exit is a refusal, so no branch can hand back an empty result set that reads to a buyer as a real search that found nothing",
  run: () => {
    const body = actionBody()
    if (!body) return { ok: false, detail: `the ${ACTION} body could not be parsed` }
    const wins = [...body.matchAll(/return\s*\{\s*ok:\s*true/g)]
    if (wins.length === 0) return { ok: false, detail: "the action has no success exit at all" }
    if (wins.length > 1) return { ok: false, detail: `${wins.length} success exits — only the one after the search may exist` }
    const spend = body.search(/searchPropertiesCore\s*\(/)
    if (spend === -1) return { ok: false, detail: "the provider call is gone — re-read the action" }
    return wins[0].index! > spend
      ? { ok: true, detail: `single success exit at ${wins[0].index}, after the provider call at ${spend}` }
      : { ok: false, detail: "the success exit precedes the provider call — it answers success without searching" }
  },
  breaks: [
    {
      file: F.action,
      find: `  const svc = createServiceClient()`,
      replace: `  if (!access.ok) return { ok: true, results: [] }
  const svc = createServiceClient()`,
    },
    {
      file: F.action,
      find: `  if (!r?.success) return { ok: false, error: "That search didn't run — try rephrasing (beds, price, area)." }`,
      replace: `  if (!r?.success) return { ok: true, results: [] }`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 3 — WHAT WAS ALREADY CORRECT IS NOT WEAKENED
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "read.every-awaited-supabase-call-binds-its-error",
  what:
    "supabase-js RESOLVES a refused query rather than throwing, so a call that destructures only `data` reports 'permission denied' and 'no rows' identically — and pre-rollout every table is EMPTY, which is exactly when that lie is invisible. Every awaited supabase call in the action binds `error`",
  run: () => {
    const body = actionBody()
    if (!body) return { ok: false, detail: `the ${ACTION} body could not be parsed` }
    const calls = [...body.matchAll(/const\s*(\{[^}]*\})\s*=\s*await\s+([A-Za-z_$][\w$]*)\s*\.\s*from\s*\(/g)]
    if (calls.length === 0) return { ok: false, detail: "no awaited supabase call found — the shape changed, re-read the action" }
    const naked = calls.filter((c) => !/\berror\b/.test(c[1]))
    return naked.length === 0
      ? { ok: true, detail: `${calls.length} awaited supabase call(s), all binding an error` }
      : { ok: false, detail: `${naked.length} destructure data without error: ${naked.map((n) => n[1].replace(/\s+/g, " ")).join(", ")}` }
  },
  breaks: [
    {
      file: F.action,
      find: `  const { data: contact, error: contactError } = await svc.from("contacts")`,
      replace: `  const { data: contact } = await svc.from("contacts")`,
    },
    {
      file: F.action,
      find: `  const { error: activityError } = await svc.from("client_portal_activity").insert(searchActivityRow)`,
      replace: `  const { data: activityRows } = await svc.from("client_portal_activity").insert(searchActivityRow)`,
    },
  ],
})

A.push({
  id: "read.a-refused-contact-read-returns-before-any-money-is-spent",
  what:
    "the contact read's error binding is guarded, the guard RETURNS a failure, and it sits before the provider call — a refused read must not fall through into a paid search, and must not be reported as 'contact not found', which reads as a clean negative for what is actually an outage",
  run: () => {
    const body = actionBody()
    if (!body) return { ok: false, detail: `the ${ACTION} body could not be parsed` }
    const read = /const\s*\{[^}]*\berror:\s*([A-Za-z_$][\w$]*)[^}]*\}\s*=\s*await\s+[A-Za-z_$][\w$]*\s*\.\s*from\s*\(\s*"contacts"/.exec(body)
    if (!read) return { ok: false, detail: "the contact read no longer binds an error" }
    const errName = read[1]
    const guardAt = body.indexOf(`if (${errName})`, read.index!)
    if (guardAt === -1) return { ok: false, detail: `${errName} is bound but never checked` }
    const open = body.indexOf("{", guardAt)
    const close = open === -1 ? -1 : matchBrace(body, open)
    const branch = open === -1 || close === -1 ? body.slice(guardAt, body.indexOf("\n", guardAt)) : body.slice(open, close + 1)
    if (!/\breturn\b/.test(branch)) return { ok: false, detail: `${errName}'s guard does not return — a refused read falls through into the search` }
    if (!/ok:\s*false/.test(branch)) return { ok: false, detail: `${errName}'s guard does not return a failure` }
    const spend = body.search(/searchPropertiesCore\s*\(/)
    return guardAt < spend
      ? { ok: true, detail: `${errName} refuses at ${guardAt}, before the provider call at ${spend}` }
      : { ok: false, detail: `${errName} is examined only after the provider has been paid` }
  },
  breaks: [
    {
      file: F.action,
      find: `  if (contactError) {
    console.error("[portal-nl-search] contact read refused:", contactError.message)
    return { ok: false, error: "We couldn't reach your account just now — please try again." }
  }`,
      replace: `  if (contactError) {
    console.error("[portal-nl-search] contact read refused:", contactError.message)
  }`,
    },
    {
      file: F.action,
      find: `    return { ok: false, error: "We couldn't reach your account just now — please try again." }`,
      replace: `    return { ok: true, results: [] }`,
    },
  ],
})

A.push({
  id: "signal.the-activity-row-keeps-both-stamps-and-takes-them-from-the-contact-row",
  what:
    "the row written to the portal engagement ledger carries `brokerage_id` AND `agent_id`, both traced to the contact row rather than to a literal or to the session — that row's SELECT policy admits the agent side only through `has_brokerage_access(brokerage_id)` or `agent_id = current_user_agent_id()`, so a row missing either column is a search signal the buyer's own agent cannot see, and both columns are nullable so the insert succeeds and the loss is silent",
  run: () => {
    const body = actionBody()
    if (!body) return { ok: false, detail: `the ${ACTION} body could not be parsed` }
    const ins = /\.\s*from\s*\(\s*"client_portal_activity"\s*\)\s*\.\s*insert\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(body)
    if (!ins) return { ok: false, detail: "the ledger insert is not a named row object any more — re-read the action" }
    const decl = new RegExp(`(?:const|let)\\s+${ins[1]}\\s*=\\s*\\{`).exec(body)
    if (!decl) return { ok: false, detail: `${ins[1]} is inserted but not declared as an object literal here` }
    const open = body.indexOf("{", decl.index)
    const close = matchBrace(body, open)
    if (close === -1) return { ok: false, detail: "the row literal could not be parsed" }
    const row = body.slice(open + 1, close)

    const contactBinding = /const\s*\{[^}]*\bdata:\s*([A-Za-z_$][\w$]*)[^}]*\}\s*=\s*await\s+[A-Za-z_$][\w$]*\s*\.\s*from\s*\(\s*"contacts"/.exec(body)
    if (!contactBinding) return { ok: false, detail: "no binding is taken from the contact read" }

    const problems: string[] = []
    for (const col of ["brokerage_id", "agent_id"]) {
      const f = new RegExp(`\\b${col}\\s*:\\s*([^,\\n]+)`).exec(row)
      if (!f) { problems.push(`${col} is not stamped at all`); continue }
      const v = f[1].trim()
      if (/^(null|undefined)\b/.test(v)) { problems.push(`${col} is written as ${v}`); continue }
      if (!new RegExp(`\\b${contactBinding[1]}\\b`).test(v)) problems.push(`${col} does not come from the contact row: ${v}`)
    }
    return problems.length === 0
      ? { ok: true, detail: `both stamps read off \`${contactBinding[1]}\`` }
      : { ok: false, detail: problems.join(" | ") }
  },
  breaks: [
    {
      file: F.action,
      find: `    brokerage_id: (contact as { brokerage_id: string | null }).brokerage_id,`,
      replace: `    brokerage_id: null,`,
    },
    {
      file: F.action,
      find: `    agent_id: (contact as { agent_id: string | null }).agent_id,
`,
      replace: ``,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 4 — THE ID CLASSES ARE NOT CROSSED
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "identity.the-gates-user-id-is-never-used-inside-the-action",
  what:
    "`agents.id`, `users.id` and `contacts.id` are DISJOINT id spaces. The gate resolves a USERS-class id; the ledger row needs an AGENTS-class owner. The gate's user id therefore appears nowhere in the action body — which is also the reason the contact read survives the gate instead of being deleted by it, since the gate returns the tenant but not the agent",
  run: () => {
    const body = actionBody()
    if (!body) return { ok: false, detail: `the ${ACTION} body could not be parsed` }
    const binding = gateBinding(body)
    if (!binding) return { ok: false, detail: "no binding is taken from an awaited authorization call" }
    const used = [...body.matchAll(new RegExp(`\\b${binding}\\s*\\.\\s*(\\w+)`, "g"))].map((m) => m[1])
    const forbidden = used.filter((p) => /^(userId|user_id)$/.test(p))
    if (forbidden.length) return { ok: false, detail: `the action reads ${binding}.${forbidden[0]} — a users.id in a tree where the columns nearby are agents-class` }
    if (!used.includes("brokerageId")) return { ok: false, detail: "the action never uses the tenant the gate resolved — the gate's answer is being discarded" }
    return { ok: true, detail: `${binding}.{${[...new Set(used)].join(", ")}}` }
  },
  breaks: [
    {
      file: F.action,
      find: `    agent_id: (contact as { agent_id: string | null }).agent_id,`,
      replace: `    agent_id: access.userId,`,
    },
    {
      // The gate's tenant discarded: the privileged read stops being bounded by
      // anything the gate actually decided.
      file: F.action,
      find: `    .eq("brokerage_id", access.brokerageId)
`,
      replace: ``,
    },
  ],
})

A.push({
  id: "read.the-privileged-read-is-bounded-by-the-tenant-the-gate-resolved",
  what:
    "the contact read filters on the tenant the gate returned, not merely on the caller-supplied id — the service client bypasses RLS, so the bound has to be written down; the same shape wave 15 gave `resolveContactAgent(svc, contactId, access.brokerageId)`",
  run: () => {
    const body = actionBody()
    if (!body) return { ok: false, detail: `the ${ACTION} body could not be parsed` }
    const binding = gateBinding(body)
    if (!binding) return { ok: false, detail: "no binding is taken from an awaited authorization call" }
    const at = body.search(/\.\s*from\s*\(\s*"contacts"\s*\)/)
    if (at === -1) return { ok: false, detail: "the contact read is gone — re-read the action" }
    const end = body.indexOf("maybeSingle", at)
    const chain = body.slice(at, end === -1 ? at + 400 : end)
    const eqs = [...chain.matchAll(/\.eq\(\s*"([^"]+)"\s*,\s*([^)]+)\)/g)]
    const tenant = eqs.find((e) => e[1] === "brokerage_id")
    if (!tenant) return { ok: false, detail: `the read filters on ${eqs.map((e) => e[1]).join(", ") || "nothing"} — no tenant bound` }
    return new RegExp(`\\b${binding}\\b`).test(tenant[2])
      ? { ok: true, detail: `.eq("brokerage_id", ${tenant[2].trim()})` }
      : { ok: false, detail: `the tenant filter does not come from the gate: ${tenant[2].trim()}` }
  },
  breaks: [
    {
      file: F.action,
      find: `    .eq("brokerage_id", access.brokerageId)
`,
      replace: ``,
    },
    {
      // A tenant bound taken from the caller instead of from the gate is not a
      // bound at all — it is the same trust that made this action exploitable.
      file: F.action,
      find: `    .eq("brokerage_id", access.brokerageId)`,
      replace: `    .eq("brokerage_id", (input as any).brokerageId)`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 5 — THE MODULE STAYS BUILDABLE, AND THE GATE STAYS THE SHARED ONE
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "module.a-use-server-file-exports-only-async-functions",
  what:
    "gating this action added a non-async local helper to a \"use server\" module. Next.js fails page-data collection on any value export from such a file (\"a use server file can only export async functions\") and the compile step does NOT surface it — so every export here is an async function, and types/interfaces, which are erased",
  run: () => {
    const src = code(F.action)
    if (!/^\s*["']use server["']/m.test(src.split("\n").slice(0, 3).join("\n"))) {
      return { ok: false, detail: "the file no longer carries the \"use server\" directive — this proof is aimed at the wrong shape" }
    }
    const bad: string[] = []
    for (const line of src.split("\n")) {
      const m = /^export\s+(const|class|let|var|enum|function)\s+([A-Za-z0-9_$]+)/.exec(line)
      if (!m) continue
      if (m[1] === "function") { bad.push(`export function ${m[2]} — not async`); continue }
      if (!/=\s*async\b/.test(line)) bad.push(`export ${m[1]} ${m[2]}`)
    }
    const asyncFns = [...src.matchAll(/^export\s+async\s+function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1])
    if (asyncFns.length === 0) return { ok: false, detail: "the file exports no async function at all" }
    return bad.length === 0
      ? { ok: true, detail: `${asyncFns.length} async export(s): ${asyncFns.join(", ")}` }
      : { ok: false, detail: `build-breaking export(s): ${bad.join(", ")}` }
  },
  breaks: [
    {
      file: F.action,
      find: `function accessRefusal(error: PortalAccessRefusal): string {`,
      replace: `export const PORTAL_NL_SEARCH_REFUSALS = 4\nfunction accessRefusal(error: PortalAccessRefusal): string {`,
    },
    {
      file: F.action,
      find: `export async function portalNaturalSearchAction(input: {`,
      replace: `export function portalNaturalSearchAction(input: {`,
    },
  ],
})

A.push({
  id: "gate.the-authorization-is-the-shared-helper-not-a-local-one",
  what:
    "the gate identifier is IMPORTED and is not declared in this file — five portal actions authorize through one helper, and a local re-implementation is how a second auth pattern is born and then drifts away from the one the portal page actually enforces",
  run: () => {
    const src = code(F.action)
    const imported = /import\s*\{[^}]*\brequireContactAccess\b[^}]*\}\s*from\s*["']([^"']+)["']/.exec(src)
    if (!imported) return { ok: false, detail: "requireContactAccess is not imported" }
    if (/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+requireContactAccess\s*\(/.test(src)) {
      return { ok: false, detail: "requireContactAccess is DECLARED in this file — a second gate" }
    }
    if (/(?:const|let|var)\s+requireContactAccess\s*[:=]/.test(src)) {
      return { ok: false, detail: "requireContactAccess is re-bound locally in this file" }
    }
    const target = resolve(ROOT, imported[1].replace(/^@\//, "") + ".ts")
    if (!existsSync(target)) return { ok: false, detail: `the gate module does not exist at ${imported[1]}` }
    return { ok: true, detail: `imported from ${imported[1]}` }
  },
  breaks: [
    {
      file: F.action,
      find: `function accessRefusal(error: PortalAccessRefusal): string {`,
      replace: `async function requireContactAccess(_id: string) {\n  return { ok: true as const, userId: "", brokerageId: "", isContactSelf: true, userType: null }\n}\nfunction accessRefusal(error: PortalAccessRefusal): string {`,
    },
    {
      file: F.action,
      find: `import { requireContactAccess } from "@/lib/portal/require-contact-access"`,
      replace: `import { requireContactAccess } from "@/lib/portal/require-contact-access-that-is-not-there"`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 6 — THE CALLER (synthetic control: its file is outside this slice's scope)
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "caller.the-sole-caller-branches-on-the-verdict-and-never-renders-a-refusal-as-results",
  what:
    "the one component that calls this action branches on the `ok` discriminant, shows the SERVER'S OWN sentence on the failure arm, and puts no result set on screen there — a client component passing a contactId it got from the page is fine, because the gate proves the SESSION and not the parameter; what would not be fine is the gate's careful refusal being converted back into 'nothing matched' at the last moment",
  run: () => {
    if (!existsSync(resolve(ROOT, F.caller))) return { ok: false, detail: `${F.caller} does not exist` }
    const src = strip(raw(F.caller))
    if (!src.includes(ACTION)) return { ok: false, detail: "the caller no longer imports the action" }
    return callerKeepsRefusalOutOfResults(src, ACTION)
  },
  breaks: [],
  synthetic: {
    why: `${F.caller} is outside this slice's write scope, so each defect is written into a copy of the caller's shape rather than into the tree`,
    run: () => {
      const shape = (failArm: string) => `
      const run = () => {
        startTransition(async () => {
          const r = await ${ACTION}({ contactId, query })
          if (r.ok) setResults(r.results)
          else { ${failArm} }
        })
      }`
      // Each clause of the assertion gets its OWN defective input: a control
      // that only ever trips the first clause proves nothing about the rest.
      const cases: Array<[string, string]> = [
        ["a refusal rendered as an empty result set", `setResults([]); setError(r.error)`],
        ["the server's sentence swallowed for a hard-coded one", `setResults(null); setError("Search unavailable")`],
      ]
      const stillGreen: string[] = []
      const reds: string[] = []
      for (const [label, arm] of cases) {
        const out = callerKeepsRefusalOutOfResults(shape(arm), ACTION)
        if (out.ok) stillGreen.push(label)
        else reds.push(`${label} → ${out.detail}`)
      }
      // And the un-defected shape must still pass, or the logic is simply
      // rejecting everything and its RED verdicts mean nothing.
      const control = callerKeepsRefusalOutOfResults(shape(`setResults(null); setError(r.error)`), ACTION)
      if (!control.ok) return { ok: false, detail: `the assertion's logic rejects a HEALTHY caller too: ${control.detail}` }
      return stillGreen.length === 0
        ? { ok: true, detail: reds.join(" | ") }
        : { ok: false, detail: `stayed green on: ${stillGreen.join(", ")}` }
    },
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// RUN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  let pass = 0, fail = 0
  const failures: string[] = []

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
      if (a.breaks.length === 0 && !a.synthetic) {
        negFail++
        negProblems.push(`${a.id}: assertion with NO negative control`)
        console.log(`  ✘ ${a.id}  no negative control defined`)
        continue
      }
      if (a.synthetic) {
        const r = a.synthetic.run()
        if (r.ok) { negPass++; console.log(`  ✔ ${a.id}[synthetic]  the assertion's logic goes RED on a defective input — SYNTHETIC CONTROL, weaker than a tree mutation\n      why: ${a.synthetic.why}\n      → ${r.detail ?? ""}`) }
        else { negFail++; negProblems.push(`${a.id}[synthetic]: the logic did NOT go red on a defective input`); console.log(`  ✘ ${a.id}[synthetic]  did not go red`) }
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
        // Confirm the patched text is really on disk before believing anything
        // the assertion says about it.
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

  if (fail > 0 || negFail > 0) { console.log("\n ❌ PORTAL_NL_SEARCH_GATE_FAIL"); process.exit(1) }
  console.log("\n ✅ PORTAL_NL_SEARCH_GATE_PASS — the buyer's natural-language search proves the session before it reads a row or spends a cent, a refused access check stays a refusal instead of becoming a decision or an empty result set, and the signal it writes still lands in the agent's lane")
}
main()
