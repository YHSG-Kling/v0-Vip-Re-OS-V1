#!/usr/bin/env tsx
/**
 * scripts/dashboard-data-layer-simulator.ts   (tsx scripts/dashboard-data-layer-simulator.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DASHBOARD DATA LANE — A GATED ENDPOINT NOTHING HAD EVER EXERCISED.
 *
 * `hooks/use-dashboard-data.ts` exposes 19 hooks over one generic
 * `useDashboardData`, all hitting `/api/dashboard/data`. Nothing imported the
 * hooks and nothing else called the route: the lane's only referrer was itself.
 * That is not a reason to delete it, and this proof is not about the import
 * count. It stands over three things.
 *
 * 1. THE ROUTE IS A PUBLIC DOOR AND HAD A HOLE IN IT. An HTTP route is reachable
 *    by anyone with a URL bar, wired or not. The `communications` branch let a
 *    caller-supplied `contact_id` REPLACE the session's agent filter — so
 *    `?type=communications&contact_id=<any uuid>` returned another brokerage's
 *    buyer's message history to any signed-in browser, in direct contradiction
 *    of the invariant written in the route's own header. It had never been hit
 *    because nothing called it. The invariant this proof enforces is the general
 *    one: a query parameter may NARROW a branch, never replace or widen the
 *    session scope, and no identity column is ever filtered by caller input.
 *
 * 2. A REFUSED READ MUST NOT RENDER AS AN EMPTY LIST. supabase-js RESOLVES a
 *    refused query, so `const { data }` makes "permission denied" and "you have
 *    no transactions" the same screen. Every one of the nineteen reads
 *    destructured only `data`. Pre-rollout every table is EMPTY, which is
 *    exactly when that lie is invisible.
 *
 * 3. THE VERDICT IS ENFORCED, NOT ASSERTED IN PROSE. The read-both verdict is
 *    DUPLICATE-and-this-lane-loses: every branch is a strict subset of a live
 *    server action, and the one capability the lane appeared to add — SWR +
 *    `mutate` — is available over those richer readers already
 *    (hooks/use-contact-dashboard.ts does exactly that, with no HTTP hop). The
 *    lane is not deleted yet because three scoping properties it carries are not
 *    yet merged onto their survivors (see MERGE DEBT in the hook header), and
 *    the method is MERGE FIRST. So the verdict is recorded as data:
 *    `DASHBOARD_DATA_SURVIVOR` names a survivor for every data type, and this
 *    proof requires every name to resolve to a function that really exists and
 *    every route branch to have one. A verdict that only lives in a comment is
 *    documentation masquerading as a decision — this tree has been burned by
 *    that before.
 *
 * HOW THIS PROOF IS BUILT
 *   · Assertions read the CONSTRUCT, never a spelling. "No `.eq` on an identity
 *     column takes a value that traces to `searchParams`", "every case block
 *     contains an UNCONDITIONAL filter whose value is not caller-supplied",
 *     "every awaited query destructures an error" — a rename or a reordering
 *     keeps them green; a regression does not.
 *   · Every assertion carries NEGATIVE CONTROLS: the defect is written back into
 *     the real file, the mutation is VERIFIED TO HAVE APPLIED (a find-string
 *     that no longer matches is theatre, not a control), the check is required
 *     to flip RED, and the file is restored and re-verified by sha256.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const F = {
  route: "app/api/dashboard/data/route.ts",
  hook: "hooks/use-dashboard-data.ts",
}

/** Read fresh every time — the negative layer rewrites these files. */
const raw = (p: string) => readFileSync(resolve(ROOT, p), "utf8")
/** Comment-stripped source: prose must never satisfy a structural assertion. */
const code = (p: string) =>
  raw(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

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

/** The body of the `switch` that dispatches on the request's data type. */
function switchBody(src: string): string | null {
  const m = /switch\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*\{/.exec(src)
  if (!m) return null
  const open = src.indexOf("{", m.index)
  const close = matchBrace(src, open)
  return close === -1 ? null : src.slice(open + 1, close)
}

/** Each `case "<label>":` block of the dispatch switch, label → source. */
function caseBlocks(src: string): Map<string, string> {
  const out = new Map<string, string>()
  const body = switchBody(src)
  if (!body) return out
  const starts: Array<{ label: string; at: number }> = []
  for (const m of body.matchAll(/case\s+"([^"]+)"\s*:/g)) {
    starts.push({ label: m[1], at: m.index! + m[0].length })
  }
  const defaultAt = body.search(/\bdefault\s*:/)
  for (let i = 0; i < starts.length; i++) {
    const end =
      i + 1 < starts.length
        ? body.lastIndexOf("case", starts[i + 1].at)
        : defaultAt === -1 ? body.length : defaultAt
    out.set(starts[i].label, body.slice(starts[i].at, end))
  }
  return out
}

/** The `default:` arm of the dispatch switch. */
function defaultArm(src: string): string | null {
  const body = switchBody(src)
  if (!body) return null
  const at = body.search(/\bdefault\s*:/)
  if (at === -1) return null
  return body.slice(at)
}

/**
 * Identifiers whose value traces to the request URL — the ONLY caller-controlled
 * input a GET handler has. Includes one hop of aliasing, so renaming the binding
 * does not launder the taint.
 */
function callerSuppliedNames(src: string): Set<string> {
  const tainted = new Set<string>()
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)/g)) {
    if (/searchParams\s*\.\s*get\s*\(/.test(m[2])) tainted.add(m[1])
  }
  // One aliasing hop: `const x = <taintedName>` / `const x = <taintedName> ?? ...`
  for (let pass = 0; pass < 3; pass++) {
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)/g)) {
      for (const t of tainted) {
        if (new RegExp(`\\b${t}\\b`).test(m[2])) tainted.add(m[1])
      }
    }
  }
  return tainted
}

interface EqCall { col: string; value: string; at: number }

/** Every `.eq("<column>", <value>)` in a chunk of source. */
function eqCalls(chunk: string): EqCall[] {
  const out: EqCall[] = []
  for (const m of chunk.matchAll(/\.eq\(\s*"([^"]+)"\s*,\s*([^),]+)\)/g)) {
    out.push({ col: m[1], value: m[2].trim(), at: m.index! })
  }
  return out
}

/** Character ranges inside a chunk that sit within an `if (...) { ... }` body. */
function conditionalRanges(chunk: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const m of chunk.matchAll(/\bif\s*\(/g)) {
    const paren = chunk.indexOf("(", m.index!)
    let depth = 0, i = paren
    for (; i < chunk.length; i++) {
      if (chunk[i] === "(") depth++
      else if (chunk[i] === ")") { depth--; if (depth === 0) break }
    }
    const brace = chunk.indexOf("{", i)
    if (brace === -1) continue
    const close = matchBrace(chunk, brace)
    if (close !== -1) out.push([brace, close])
  }
  return out
}

const isConditional = (ranges: Array<[number, number]>, at: number) =>
  ranges.some(([a, b]) => at > a && at < b)

/** Columns that decide WHOSE rows come back. Caller input may never set one. */
const IDENTITY_COLUMNS = new Set([
  "agent_id", "brokerage_id", "user_id", "assigned_to_agent_id", "uploaded_by",
])

/** Does `file` declare a function called `name`? (declaration or const arrow.) */
function declaresFunction(file: string, name: string): boolean {
  const abs = resolve(ROOT, file)
  if (!existsSync(abs)) return false
  const src = readFileSync(abs, "utf8")
  return (
    new RegExp(`function\\s+${name}\\s*[(<]`).test(src) ||
    new RegExp(`(?:const|let|var)\\s+${name}\\s*[:=]`).test(src)
  )
}

/**
 * The verdict ledger, READ FROM SOURCE rather than imported.
 *
 * This is not a stylistic choice. An `import` binds once at module load, so a
 * negative control that rewrites the map on disk would leave the assertion
 * inspecting the ORIGINAL object and reporting green over a defect it never
 * saw — a control that proves nothing. Parsing the file on every call is what
 * makes the control real.
 */
function survivorLedger(hookSrc: string): Record<string, string> {
  const m = /DASHBOARD_DATA_SURVIVOR\s*=\s*\{([\s\S]*?)\n\}\s*as\s+const/.exec(hookSrc)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const e of m[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*"([^"]+)"\s*,?\s*$/gm)) {
    out[e[1]] = e[2]
  }
  return out
}

/** Members of the DashboardDataType union, read from the hook source. */
function dataTypeMembers(src: string): string[] {
  const m = /type\s+DashboardDataType\s*=([\s\S]*?)(?:\n\s*\n|\ninterface|\nconst|\nexport)/.exec(src)
  if (!m) return []
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion harness
// ─────────────────────────────────────────────────────────────────────────────
type Outcome = { ok: boolean; detail?: string }
interface Assertion {
  id: string
  what: string
  run: () => Outcome | Promise<Outcome>
  /** Source mutations that MUST flip this assertion to failure. */
  breaks: Array<{ file: string; find: string; replace: string }>
}

const A: Assertion[] = []

// ═════════════════════════════════════════════════════════════════════════════
// SCOPE — the session decides whose rows come back, never the URL
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "route.the-url-is-the-only-caller-input-and-it-cannot-name-an-identity",
  what:
    "the handler reads no request body and no request header, so `searchParams` is the whole of the caller's influence — and it is never asked for an identity column, so there is nothing to accidentally honour",
  run: () => {
    const src = code(F.route)
    if (/request\s*\.\s*(json|text|formData|blob|arrayBuffer)\s*\(/.test(src)) {
      return { ok: false, detail: "the handler reads a request body" }
    }
    if (/request\s*\.\s*headers/.test(src)) {
      return { ok: false, detail: "the handler reads a request header — a second caller-controlled input" }
    }
    const asked: string[] = []
    for (const m of src.matchAll(/searchParams\s*\.\s*get\s*\(\s*"([^"]+)"\s*\)/g)) {
      if (IDENTITY_COLUMNS.has(m[1])) asked.push(m[1])
    }
    return asked.length === 0
      ? { ok: true, detail: `${[...src.matchAll(/searchParams\s*\.\s*get\s*\(/g)].length} url parameter read(s), none an identity` }
      : { ok: false, detail: `the url is asked for an identity column: ${asked.join(", ")}` }
  },
  breaks: [
    {
      file: F.route,
      find: `    const { searchParams } = new URL(request.url)`,
      replace: `    const { searchParams } = new URL(request.url)\n    const impersonated = request.headers.get("x-agent-id")`,
    },
    {
      file: F.route,
      find: `    const contactIdFilter = searchParams.get("contact_id")`,
      replace: `    const contactIdFilter = searchParams.get("contact_id")\n    const agentIdOverride = searchParams.get("agent_id")`,
    },
  ],
})

A.push({
  id: "route.no-identity-column-is-filtered-by-caller-supplied-input",
  what:
    "for every `.eq(\"<column>\", <value>)` in the route, if the value traces to the request URL then the column is NOT one that decides whose rows come back — the taint trace follows aliasing, so renaming the binding does not launder it",
  run: () => {
    const src = code(F.route)
    const tainted = callerSuppliedNames(src)
    if (tainted.size === 0) return { ok: false, detail: "no url-derived binding found at all — the trace is not reaching the source" }
    const offenders: string[] = []
    for (const e of eqCalls(src)) {
      const base = e.value.split(/[.?\s]/)[0]
      if (IDENTITY_COLUMNS.has(e.col) && (tainted.has(base) || tainted.has(e.value))) {
        offenders.push(`${e.col} ← ${e.value}`)
      }
    }
    return offenders.length === 0
      ? { ok: true, detail: `${eqCalls(src).length} filters checked against ${tainted.size} url-derived binding(s)` }
      : { ok: false, detail: `identity filtered by caller input: ${offenders.join(", ")}` }
  },
  breaks: [
    {
      file: F.route,
      find: `        query = supabase
          .from("transactions")
          .select("*, listings(*), contacts(*)")
          .eq("agent_id", agentId)`,
      replace: `        query = supabase
          .from("transactions")
          .select("*, listings(*), contacts(*)")
          .eq("agent_id", contactIdFilter)`,
    },
  ],
})

A.push({
  id: "route.every-branch-is-unconditionally-session-scoped-and-a-parameter-can-only-narrow",
  what:
    "every case block applies at least one UNCONDITIONAL filter whose value is not caller-supplied, and any caller-supplied filter in that block appears strictly AFTER it — so a url parameter narrows a scope that is already the caller's own, and can never stand in place of one",
  run: () => {
    const src = code(F.route)
    const tainted = callerSuppliedNames(src)
    const blocks = caseBlocks(src)
    if (blocks.size === 0) return { ok: false, detail: "the dispatch switch was not found" }

    const problems: string[] = []
    for (const [label, block] of blocks) {
      const ranges = conditionalRanges(block)
      const eqs = eqCalls(block)
      const isTainted = (v: string) => tainted.has(v.split(/[.?\s]/)[0]) || tainted.has(v)

      const anchors = eqs.filter((e) => !isTainted(e.value) && !isConditional(ranges, e.at))
      if (anchors.length === 0) {
        problems.push(`${label}: no unconditional non-caller-supplied filter`)
        continue
      }
      const firstAnchor = Math.min(...anchors.map((a) => a.at))
      for (const e of eqs) {
        if (isTainted(e.value) && e.at < firstAnchor) {
          problems.push(`${label}: caller-supplied ${e.col} applied before the session scope`)
        }
      }
    }
    return problems.length === 0
      ? { ok: true, detail: `${blocks.size} branches, each anchored on a session-derived filter` }
      : { ok: false, detail: problems.join(" | ") }
  },
  breaks: [
    {
      // The original defect, written back verbatim in shape: contact_id REPLACES
      // the agent filter instead of narrowing it.
      file: F.route,
      find: `        query = supabase
          .from("messages")
          .select("*, contacts(*)")
          .eq("agent_id", agentId)
          .order("created_at", { ascending: false })
          .limit(100)

        if (contactIdFilter) {
          query = query.eq("contact_id", contactIdFilter)
        }`,
      replace: `        query = supabase
          .from("messages")
          .select("*, contacts(*)")
          .order("created_at", { ascending: false })
          .limit(100)

        if (contactIdFilter) {
          query = query.eq("contact_id", contactIdFilter)
        } else {
          query = query.eq("agent_id", agentId)
        }`,
    },
    {
      // Drop the tenant filter from the roster branch: brokerage-level entity,
      // still must be scoped by something session-derived.
      file: F.route,
      find: `        query = supabase
          .from("agents")
          .select("*")
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })`,
      replace: `        query = supabase
          .from("agents")
          .select("*")
          .order("created_at", { ascending: false })`,
    },
  ],
})

A.push({
  id: "route.the-agent-id-is-resolved-inside-the-session-brokerage",
  what:
    "the agent id is resolved by a call that also receives the brokerage the session resolved — the unscoped resolver picks the OLDEST agents row for a user who holds rows in two brokerages, which pairs an agent id with a tenant it does not belong to and makes every branch return zero rows while reporting success",
  run: () => {
    const src = code(F.route)
    // Which binding holds the tenant? The one read off the users row.
    const tenant = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\??\.\s*brokerage_id/.exec(src)
    if (!tenant) return { ok: false, detail: "no binding is read from the users row's tenant column" }
    const m = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g
    let found: string | null = null
    for (const call of src.matchAll(m)) {
      if (!/agent/i.test(call[2])) continue
      found = call[2]
      if (new RegExp(`\\b${tenant[1]}\\b`).test(call[3])) {
        return { ok: true, detail: `${call[2]}(…, ${tenant[1]})` }
      }
    }
    return { ok: false, detail: found ? `${found} is called without the session tenant` : "no agent resolution call found" }
  },
  breaks: [
    {
      file: F.route,
      find: `    const agentId = await resolveAgentIdInBrokerage(supabase, user.id, brokerageId)`,
      replace: `    const agentId = await resolveAgentId(supabase, user.id)`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// REFUSAL — a denied read is a failure, not an empty book
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "route.every-awaited-read-destructures-its-error",
  what:
    "supabase-js RESOLVES a refused query, so a read that destructures only `data` reports 'permission denied' and 'you have nothing' identically — every awaited read in this route destructures `error`, and pre-rollout every table is empty, which is exactly when the difference is invisible",
  run: () => {
    const src = code(F.route)
    const reads = [...src.matchAll(/const\s*(\{[^}]*\})\s*=\s*await\s+(supabase[^\n]*|[A-Za-z_$][\w$]*)/g)]
    if (reads.length === 0) return { ok: false, detail: "no awaited read found — the shape changed, re-read the route" }
    const naked = reads.filter((r) => !/\berror\b/.test(r[1]))
    return naked.length === 0
      ? { ok: true, detail: `${reads.length} awaited read(s), all with an error binding` }
      : { ok: false, detail: `${naked.length} read(s) destructure data without error: ${naked.map((n) => n[1].replace(/\s+/g, " ")).join(", ")}` }
  },
  breaks: [
    {
      file: F.route,
      find: `    const { data: rows, error: readError } = await query`,
      replace: `    const { data: rows } = await query`,
    },
    {
      file: F.route,
      find: `    const { data: userRow, error: identityError } = await supabase`,
      replace: `    const { data: userRow } = await supabase`,
    },
  ],
})

A.push({
  id: "route.a-refused-read-returns-a-failure-and-never-reaches-the-success-body",
  what:
    "EVERY error binding in the route is guarded, the guard RETURNS, and it sits before the success response — checking only the first such binding is how a proof reports green over the read that actually matters, so all of them are required to hold",
  run: () => {
    const src = code(F.route)
    const reads = [...src.matchAll(/const\s*\{[^}]*\berror:\s*([A-Za-z_$][\w$]*)[^}]*\}\s*=\s*await\b/g)]
    if (reads.length === 0) return { ok: false, detail: "no awaited read binds an error" }
    const success = src.search(/success:\s*true/)
    if (success === -1) return { ok: false, detail: "no success response found" }

    const problems: string[] = []
    for (const r of reads) {
      const errName = r[1]
      const guard = src.indexOf(`if (${errName})`, r.index!)
      if (guard === -1) { problems.push(`${errName} is bound but never checked`); continue }
      const open = src.indexOf("{", guard)
      const branch = src.slice(open, matchBrace(src, open) + 1)
      if (!/\breturn\b/.test(branch)) { problems.push(`${errName}'s guard does not return — execution falls through to the success body`); continue }
      if (guard > success) problems.push(`${errName} is examined only after the success body is reachable`)
    }
    return problems.length === 0
      ? { ok: true, detail: `${reads.length} error binding(s), each refusing before the success body` }
      : { ok: false, detail: problems.join(" | ") }
  },
  breaks: [
    {
      file: F.route,
      find: `    if (readError) {
      return refuse(502, \`Read refused for "\${dataType}": \${readError.message}\`)
    }`,
      replace: `    if (readError) {
      console.warn(\`[Dashboard Data API] read refused: \${readError.message}\`)
    }`,
    },
  ],
})

A.push({
  id: "route.an-unknown-type-refuses-rather-than-returning-something",
  what:
    "the dispatch has a `default` arm that returns a client-error refusal and assigns no query — a default that falls through would await whatever the previous branch left behind, or answer success with nothing",
  run: () => {
    const src = code(F.route)
    const arm = defaultArm(src)
    if (!arm) return { ok: false, detail: "the dispatch has no default arm" }
    if (!/\breturn\b/.test(arm)) return { ok: false, detail: "the default arm does not return" }
    if (/=\s*supabase/.test(arm)) return { ok: false, detail: "the default arm builds a query" }
    if (!/\b4\d\d\b/.test(arm)) return { ok: false, detail: "the default arm does not refuse with a client-error status" }
    return { ok: true }
  },
  breaks: [
    {
      file: F.route,
      find: `      default:
        return refuse(400, \`Unknown data type: \${dataType}\`)`,
      replace: `      default:
        break`,
    },
  ],
})

A.push({
  id: "route.an-unprivileged-roster-request-is-refused-not-handed-an-empty-list",
  what:
    "the role check on the team roster returns a refusal — `[]` because you may not see this and `[]` because the brokerage has no agents must not render as the same screen, and this branch used to answer both with the second",
  run: () => {
    const src = code(F.route)
    const block = caseBlocks(src).get("agents")
    if (!block) return { ok: false, detail: "the roster branch was not found" }
    if (!/user_type|role/.test(block)) return { ok: false, detail: "the roster branch performs no role check" }
    if (/=\s*\[\s*\]/.test(block) || /data:\s*\[\s*\]/.test(block)) {
      return { ok: false, detail: "the roster branch can answer with an empty list instead of refusing" }
    }
    if (/success:\s*true/.test(block)) return { ok: false, detail: "the roster branch has a success exit that skips the read" }
    if (!/\breturn\b/.test(block)) return { ok: false, detail: "the role check does not refuse" }
    return { ok: true }
  },
  breaks: [
    {
      file: F.route,
      find: `        if (role !== "broker" && role !== "admin" && role !== "superadmin") {
          return refuse(403, "Team roster requires a broker or admin role")
        }`,
      replace: `        if (role !== "broker" && role !== "admin" && role !== "superadmin") {
          return NextResponse.json({ success: true, data: [], count: 0 })
        }`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// THE VERDICT — recorded as data, and required to resolve
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "verdict.every-data-type-this-lane-serves-names-a-survivor-that-exists",
  what:
    "the read-both verdict is DUPLICATE-and-this-lane-loses, so every member of DashboardDataType carries a survivor as `file:functionName`, every named file exists, and every named function is really declared in it — a survivor that resolves to nothing is the same failure as no verdict at all",
  run: () => {
    const hookSrc = code(F.hook)
    const members = dataTypeMembers(hookSrc)
    if (members.length === 0) return { ok: false, detail: "DashboardDataType could not be read from the hook source" }

    const map = survivorLedger(hookSrc)
    if (Object.keys(map).length === 0) return { ok: false, detail: "the survivor ledger could not be read from the hook source" }
    const missing = members.filter((m) => !map[m])
    if (missing.length > 0) return { ok: false, detail: `no survivor named for: ${missing.join(", ")}` }

    const extra = Object.keys(map).filter((k) => !members.includes(k))
    if (extra.length > 0) return { ok: false, detail: `survivor named for a type this lane does not serve: ${extra.join(", ")}` }

    const unresolved: string[] = []
    for (const [type, entry] of Object.entries(map)) {
      const idx = entry.lastIndexOf(":")
      if (idx === -1) { unresolved.push(`${type}: not file:functionName`); continue }
      const file = entry.slice(0, idx)
      const fn = entry.slice(idx + 1)
      if (!existsSync(resolve(ROOT, file))) { unresolved.push(`${type}: ${file} does not exist`); continue }
      if (!declaresFunction(file, fn)) unresolved.push(`${type}: ${file} does not declare ${fn}`)
    }
    return unresolved.length === 0
      ? { ok: true, detail: `${members.length} types, ${members.length} survivors, all resolving` }
      : { ok: false, detail: unresolved.join(" | ") }
  },
  breaks: [
    {
      file: F.hook,
      find: `  vendors:        "app/actions/vendor-marketplace.ts:searchVendors",\n`,
      replace: ``,
    },
    {
      file: F.hook,
      find: `  tasks:          "app/actions/tasks.ts:getTasks",`,
      replace: `  tasks:          "app/actions/tasks.ts:getTasksFromTheSurvivorThatIsNotThere",`,
    },
  ],
})

A.push({
  id: "verdict.the-route-serves-exactly-the-types-the-verdict-covers",
  what:
    "the set of case labels in the route equals the set of DashboardDataType members — a branch with no named survivor is an unruled-on capability, and a declared type with no branch is a hook that would 400 on every call",
  run: () => {
    const labels = [...caseBlocks(code(F.route)).keys()].sort()
    const members = dataTypeMembers(code(F.hook)).sort()
    if (labels.length === 0) return { ok: false, detail: "no case labels found in the route" }
    const onlyRoute = labels.filter((l) => !members.includes(l))
    const onlyType = members.filter((m) => !labels.includes(m))
    if (onlyRoute.length || onlyType.length) {
      return { ok: false, detail: `route-only: [${onlyRoute.join(", ")}] type-only: [${onlyType.join(", ")}]` }
    }
    return { ok: true, detail: `${labels.length} branches, one per declared type` }
  },
  breaks: [
    {
      file: F.route,
      find: `      case "referrals": {`,
      replace: `      case "referrals_v2": {`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// THE HOOK SIDE — it must not put back what the route refuses to honour
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "hook.no-identity-is-forwarded-to-a-route-that-would-ignore-it",
  what:
    "the hook never puts an identity column on the query string. The route resolves the agent and the tenant from the session and ignores such a parameter; sending one anyway implies to every future reader that it is honoured, which is how a caller-supplied scope gets 'restored' by someone making the two sides agree",
  run: () => {
    const src = code(F.hook)
    const set = [...src.matchAll(/params\s*\.\s*set\s*\(\s*"([^"]+)"/g)].map((m) => m[1])
    const bad = set.filter((k) => IDENTITY_COLUMNS.has(k))
    if (bad.length > 0) return { ok: false, detail: `identity forwarded on the query string: ${bad.join(", ")}` }
    if (!/URLSearchParams/.test(src)) return { ok: false, detail: "the hook no longer builds a query string — re-read it" }
    return { ok: true, detail: `forwards ${set.length} parameter(s), none an identity` }
  },
  breaks: [
    {
      file: F.hook,
      find: `  if (contactId) params.set("contact_id", contactId)`,
      replace: `  if (contactId) params.set("contact_id", contactId)\n  if (options.agentId) params.set("agent_id", options.agentId)`,
    },
  ],
})

A.push({
  id: "hook.a-failed-read-is-never-reported-as-an-empty-result",
  what:
    "the fetcher throws when the envelope is not a success, and `isEmpty` is false whenever there is an error — otherwise the route's careful refusal is converted back into 'you have nothing here' at the last possible moment",
  run: () => {
    const src = code(F.hook)
    const fetcher = /const\s+fetcher\s*=[\s\S]*?\n\}/.exec(src)
    if (!fetcher) return { ok: false, detail: "the fetcher was not found" }
    if (!/\bthrow\b/.test(fetcher[0])) return { ok: false, detail: "the fetcher never throws — a failure envelope would resolve as data" }
    if (!/success/.test(fetcher[0])) return { ok: false, detail: "the fetcher does not inspect the success envelope" }

    const m = /isEmpty:\s*([^\n,]+)/.exec(src)
    if (!m) return { ok: false, detail: "isEmpty is no longer reported" }
    if (!/\berror\b/.test(m[1])) return { ok: false, detail: `isEmpty ignores the error term: ${m[1].trim()}` }
    return { ok: true, detail: m[1].trim() }
  },
  breaks: [
    {
      file: F.hook,
      find: `    isEmpty: !isLoading && !error && (!data || data.length === 0),`,
      replace: `    isEmpty: !isLoading && (!data || data.length === 0),`,
    },
    {
      file: F.hook,
      find: `  if (!res.ok || !json?.success) {`,
      replace: `  if (false) {`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// RUN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  let pass = 0, fail = 0
  const failures: string[] = []

  console.log("\n─── ASSERTIONS ───────────────────────────────────────────────────")
  for (const a of A) {
    const r = await a.run()
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
        // Confirm the patched text is really on disk before believing anything
        // the assertion says about it.
        const onDisk = readFileSync(path, "utf8")
        const applied = onDisk !== before && (b.replace === "" || onDisk.includes(b.replace.split("\n")[0]))
        let broke = false, detail = ""
        try { const r = await a.run(); broke = !r.ok; detail = r.detail ?? "" }
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

  if (fail > 0 || negFail > 0) { console.log("\n ❌ DASHBOARD_DATA_LAYER_FAIL"); process.exit(1) }
  console.log("\n ✅ DASHBOARD_DATA_LAYER_PASS — no branch of this endpoint takes its scope from the caller, a refused read cannot render as an empty book, and every type it serves names a survivor that exists")
}
main()
