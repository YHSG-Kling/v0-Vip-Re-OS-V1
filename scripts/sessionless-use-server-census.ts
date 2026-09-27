#!/usr/bin/env tsx
/**
 * scripts/sessionless-use-server-census.ts  (npm run test:sessionless-use-server-census)
 * — pure, no DB, no network.
 *
 * A "use server" EXPORT THAT READS THE COOKIE SESSION, CALLED FROM A PATH THAT
 * HAS NO COOKIE, READS NOTHING (lane 86E, wave 86).
 *
 * LANE_RULES wave 85: "A lib file with 'use server' is a PUBLIC endpoint AND
 * usually on the cookie client: sessionless callers (cron, webhooks, voice)
 * silently read nothing under RLS." Wave 85 fixed it by hand three times
 * (pipeline-processor, direct mail, five voice stage doors). Nothing looked for
 * the NEXT one. This census does:
 *
 *   ENTRIES   every app/api/{cron,webhooks}/** route, plus every other app/api
 *             route whose handler admits a NON-SESSION credential (a *_SECRET,
 *             an HMAC timingSafeEqual, verifyCronAuth, a provider signature)
 *             and reads no session itself — voice webhooks, the agent-assistant
 *             tool call, provider inbound.
 *   WALK      static imports, `export … from`, and `await import()` from those
 *             entries, transitively through every module that is NOT itself a
 *             "use server" file — so a cron → lib/kernel helper → action chain
 *             is seen, and the chain is printed.
 *   TARGETS   an import edge that lands on a "use server" module (lib/ or
 *             app/actions/ — the doctrine is the same in both).
 *   FINDING   the imported export's BODY — plus every same-file function it
 *             calls, to a fixpoint — reads the session: getAgentContext,
 *             auth.getUser, requireCaller, cookies(), … (scripts/session-
 *             tokens.ts, the SAME spelling list lib-use-server-census uses), or
 *             calls createClient() in a file that imports it from
 *             @/lib/supabase/server (the cookie client).
 *
 * THE LEDGER. Each finding is either FIXED (it leaves the list), ADJUDICATED
 * with evidence (a client seam the sessionless caller fills, a soft check that
 * never blocks, the canonical resolver itself), or OPEN with the lane that owns
 * it. A finding in neither list FAILS; a listed key that is no longer a finding
 * FAILS too (the list only tightens, §2 — a retired name must not sit there
 * reading as enforced).
 *
 * HOW IT READS SOURCE (§2). Import specifiers are read on stripComments() output
 * (a tombstone that names an old import is prose, not an edge — the orphan
 * doctrine REQUIRES such tombstones); tokens and function bodies are read on
 * blankStrings() output (a log line saying "getAgentContext refused" is not a
 * session read, and a brace inside a string cannot unbalance a body). Every one
 * of those choices has a positive control below that goes red if it is undone.
 *
 * STATED BLIND SPOTS (published beside the number):
 *   · REACHABILITY IS MODULE-LEVEL. An importer that is reached is treated as if
 *     every call site in it runs sessionless. A module that imports an action
 *     only for a branch that runs under a session over-reports — the safe
 *     direction; such an edge is ADJUDICATED with its evidence, never hidden.
 *   · A CLIENT SEAM reads as cookie-bound. `opts?.client ?? await createClient()`
 *     is the pattern a cron uses to hand the service client in; the body still
 *     names the cookie client, so the finding is adjudicated by reading the
 *     caller, not waved through by the scanner.
 *   · CROSS-FILE callees are not followed from the target: an action that calls
 *     ANOTHER module's session helper is caught only if that helper's name is a
 *     session token (getAgentContext, requireCaller, …). Under-reports.
 *   · A computed `import(\`${x}\`)` specifier is not an edge.
 *   · A barrel (`export *`, `import * as`) edge is expanded to EVERY export of
 *     the target — over-reports.
 */
import { readFileSync, existsSync, statSync } from "node:fs"
import { join, dirname, normalize } from "node:path"
import { runtimeFiles } from "./runtime-roots"
import { stripComments, blankComments, blankStrings } from "./strip-comments"
import { SESSION_TOKENS, hasUseServerDirective } from "./session-tokens"

// ─── The analyzer, over any file set (the real tree or a fixture) ───────────
export interface SourceSet { files: string[]; read(f: string): string }

interface Views { stripped: string; ids: string; codeKeepStrings: string }
interface Edge { spec: string; names: string[] | "*" }
export interface Finding { target: string; exportName: string; why: string[]; importers: string[]; path: string[] }
export interface CensusResult {
  entries: Array<{ file: string; kind: "cron" | "webhook" | "credential" }>
  reachedModules: number
  targetModules: string[]
  checkedExports: number
  findings: Finding[]
  /** lane 86F — plain (non-"use server") modules reached sessionless that build the
   *  COOKIE client and INSERT lifecycle_events: the emitter half of the event bus. */
  eventWriters: Array<{ file: string; path: string[] }>
}

/** Credentials a browser session cannot produce, as this tree spells them (read on
 *  blankComments output — the header NAME is a string and is the evidence). The
 *  first four mirror opposite-missing-census's NON_SESSION_CREDENTIALS. */
const NON_SESSION_CREDENTIAL = new RegExp([
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_SECRET\b/.source,
  /\btimingSafeEqual\b/.source,
  /x-internal(?:-api)?-secret/.source,
  /\bresolveAgenticCaller\b/.source,
  /\bverifyCronAuth\b/.source,
  /x-twilio-signature/.source,
  /\bvalidateRequest\b/.source,
  /\bconstructEvent(?:Async)?\b/.source,
  /x-elevenlabs-tool-secret/.source,
].join("|"), "i")

const COOKIE_CLIENT_SPECIFIER = /from\s*["']@\/lib\/supabase\/server["']/

export function runCensus(set: SourceSet): CensusResult {
  const fileSet = new Set(set.files.map((f) => normalize(f)))
  const cache = new Map<string, Views>()
  const views = (f: string): Views => {
    let v = cache.get(f)
    if (!v) {
      const raw = set.read(f)
      v = { stripped: stripComments(raw), ids: blankStrings(raw), codeKeepStrings: blankComments(raw) }
      cache.set(f, v)
    }
    return v
  }
  const isUseServer = (f: string) => hasUseServerDirective(views(f).stripped)
  const readsSession = (f: string, text: { ids: string; stripped: string }) =>
    SESSION_TOKENS.some((t) => t.re.test(t.on === "identifiers" ? text.ids : text.stripped))

  const resolve = (from: string, spec: string): string | null => {
    let base: string
    if (spec.startsWith("@/components/")) base = join("app/components", spec.slice("@/components/".length))
    else if (spec.startsWith("@/")) base = spec.slice(2)
    else if (spec.startsWith(".")) base = join(dirname(from), spec)
    else return null
    base = normalize(base)
    for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
      if (fileSet.has(c)) return c
    }
    return null
  }

  /** `ns.foo` / `(ns as any).foo` member reads of a namespace binding — the names a
   *  whole-module import actually uses. None found (the namespace is passed along)
   *  → "*", every export: the over-report direction, stated in the header. */
  const membersOf = (s: string, ns: string): string[] | "*" => {
    const re = new RegExp(`(?:\\(\\s*)?\\b${ns.replace(/\$/g, "\\$")}\\b(?:\\s+as\\s+[^)]{1,40}?\\))?\\s*\\)?\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, "g")
    const names = new Set<string>()
    for (const m of s.matchAll(re)) names.add(m[1])
    return names.size ? [...names] : "*"
  }

  const importsOf = (f: string): Edge[] => {
    const s = views(f).stripped
    const out: Edge[] = []
    for (const m of s.matchAll(/(?:^|[\n;])\s*import\s+(type\s+)?([^;]*?)\s+from\s*["']([^"']+)["']/g)) {
      if (m[1]) continue
      const clause = m[2].trim()
      const brace = /\{([\s\S]*)\}/.exec(clause)
      const named = brace
        ? brace[1].split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("type ")).map((x) => x.split(/\s+as\s+/)[0].trim())
        : []
      const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause)
      if (ns) { out.push({ spec: m[3], names: membersOf(s, ns[1]) }); continue }
      const wholeModule = /^[A-Za-z_$][\w$]*\s*(?:,|$)/.test(clause)
      out.push({ spec: m[3], names: wholeModule ? "*" : named })
    }
    for (const m of s.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g)) {
      out.push({ spec: m[2], names: membersOf(s, m[1]) })
    }
    for (const m of s.matchAll(/export\s+(?:type\s+)?(\*|\{[^}]*\})\s+from\s*["']([^"']+)["']/g)) {
      out.push({ spec: m[2], names: m[1] === "*" ? "*" : m[1].slice(1, -1).split(",").map((x) => x.trim().split(/\s+as\s+/)[0].trim()).filter((x) => x && !x.startsWith("type ")) })
    }
    for (const m of s.matchAll(/(?:const|let|var)\s+\{([^}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g)) {
      out.push({ spec: m[2], names: m[1].split(",").map((x) => x.trim().split(/\s*:\s*/)[0].trim()).filter(Boolean) })
    }
    // `(await import("spec")).member(…)` — the inline shape lib/orchestrator/internal.ts's
    // EVENT_HANDLERS used for every invoker. It READS one member, so only that member is
    // an edge (lane 86F; before this rule it fell to the bare-import line below and
    // expanded to EVERY export of the target — 18 of 86E's 27 hub findings were session
    // actions nothing sessionless ever called). An occurrence of the specifier in any
    // other shape still expands to "*" (the over-report direction), control C12b.
    const inlineMembers = new Map<string, Set<string>>()
    for (const m of s.matchAll(/\(\s*await\s+import\(\s*["']([^"']+)["']\s*\)\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
      if (!inlineMembers.has(m[1])) inlineMembers.set(m[1], new Set())
      inlineMembers.get(m[1])!.add(m[2])
    }
    for (const m of s.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
      if (out.some((e) => e.spec === m[1])) continue
      const esc = m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const total = (s.match(new RegExp(`\\bimport\\(\\s*["']${esc}["']\\s*\\)`, "g")) ?? []).length
      const inline = (s.match(new RegExp(`\\(\\s*await\\s+import\\(\\s*["']${esc}["']\\s*\\)\\s*\\)\\s*\\.\\s*[A-Za-z_$]`, "g")) ?? []).length
      out.push({ spec: m[1], names: inlineMembers.has(m[1]) && inline === total ? [...inlineMembers.get(m[1])!] : "*" })
    }
    return out
  }

  // Function bodies of a module: `function NAME(…) {…}` and `const NAME = (…) => {…}`,
  // found on blankStrings output so a brace inside a string cannot unbalance one.
  const bodyCache = new Map<string, Map<string, { body: string; exported: boolean }>>()
  const bodiesOf = (f: string) => {
    const hit = bodyCache.get(f)
    if (hit) return hit
    const code = views(f).ids
    const out = new Map<string, { body: string; exported: boolean }>()
    const re = /(^|\n)[ \t]*(export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=>{\n]+)?=>\s*\{)/g
    for (const m of code.matchAll(re)) {
      const name = m[3] ?? m[4]
      let open: number
      if (m[3]) {
        // skip the parameter list, then take the first `{`
        let depth = 0, j = code.indexOf("(", m.index! + m[0].length - 1)
        if (j < 0) continue
        for (; j < code.length; j++) {
          const ch = code[j]
          if (ch === "(") depth++
          else if (ch === ")") { depth--; if (depth === 0) break }
        }
        open = code.indexOf("{", j)
      } else open = m.index! + m[0].length - 1
      if (open < 0) continue
      let d = 0, k = open
      for (; k < code.length; k++) {
        if (code[k] === "{") d++
        else if (code[k] === "}") { d--; if (d === 0) break }
      }
      if (!out.has(name)) out.set(name, { body: code.slice(open, k + 1), exported: !!m[2] })
    }
    bodyCache.set(f, out)
    return out
  }

  const cookieReasons = (f: string, exportName: string): string[] => {
    const importsCookie = COOKIE_CLIENT_SPECIFIER.test(views(f).stripped)
    const bodies = bodiesOf(f)
    const seen = new Set<string>()
    const stack = [exportName]
    const why: string[] = []
    while (stack.length) {
      const n = stack.pop()!
      if (seen.has(n)) continue
      seen.add(n)
      const b = bodies.get(n)
      if (!b) continue
      for (const t of SESSION_TOKENS) {
        if (t.on === "identifiers" && t.re.test(b.body)) why.push(`${n}: ${t.name}`)
      }
      if (importsCookie && /\bcreateClient\s*\(/.test(b.body)) why.push(`${n}: createClient() (cookie client)`)
      for (const other of bodies.keys()) {
        if (other !== n && new RegExp(`\\b${other.replace(/\$/g, "\\$")}\\s*\\(`).test(b.body)) stack.push(other)
      }
    }
    return [...new Set(why)]
  }

  // ENTRIES
  const entries: CensusResult["entries"] = []
  for (const f of set.files) {
    if (!/^app\/api\/.+\/route\.tsx?$/.test(f)) continue
    const v = views(f)
    if (/^app\/api\/cron\//.test(f)) { entries.push({ file: f, kind: "cron" }); continue }
    if (/^app\/api\/webhooks\//.test(f)) { entries.push({ file: f, kind: "webhook" }); continue }
    if (NON_SESSION_CREDENTIAL.test(v.codeKeepStrings) && !readsSession(f, v)) entries.push({ file: f, kind: "credential" })
  }

  // WALK
  const parent = new Map<string, string | null>()
  const queue: string[] = []
  for (const e of entries) { parent.set(e.file, null); queue.push(e.file) }
  const edges = new Map<string, Map<string, Set<string>>>() // target → export → importers
  while (queue.length) {
    const f = queue.shift()!
    for (const e of importsOf(f)) {
      const t = resolve(f, e.spec)
      if (!t) continue
      if (isUseServer(t)) {
        if (!edges.has(t)) edges.set(t, new Map())
        const names = e.names === "*" ? [...bodiesOf(t)].filter(([, v]) => v.exported).map(([k]) => k) : e.names
        for (const n of names) {
          if (!edges.get(t)!.has(n)) edges.get(t)!.set(n, new Set())
          edges.get(t)!.get(n)!.add(f)
        }
        continue
      }
      if (!parent.has(t)) { parent.set(t, f); queue.push(t) }
    }
  }
  const pathTo = (f: string): string[] => {
    const out = [f]
    let c: string | null | undefined = parent.get(f)
    while (c) { out.push(c); c = parent.get(c) }
    return out.reverse()
  }

  // FINDINGS
  const findings: Finding[] = []
  let checkedExports = 0
  for (const [target, byName] of [...edges].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [exportName, importers] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
      if (!bodiesOf(target).has(exportName)) continue // a type, a const, or a re-export — not a body to judge
      checkedExports++
      const why = cookieReasons(target, exportName)
      if (!why.length) continue
      const imp = [...importers].sort()
      findings.push({ target, exportName, why, importers: imp, path: [...pathTo(imp[0]), target] })
    }
  }
  // THE EMITTER RULE (lane 86F). A plain module on a sessionless path that builds the
  // cookie client and inserts into lifecycle_events writes NOTHING there (RLS has no
  // session to evaluate) — so the event never lands and never dispatches. The pre-86F
  // lib/events/event-helpers.ts::logEventAndTrigger was exactly this, reached from the
  // zapier/dotloop webhooks. Module-level (over-report direction): the cookie-client
  // import and the insert must both be CODE (comments stripped, strings kept only
  // for the table name). Control C13.
  // The insert's RECEIVER must be a binding the file assigns `await create(Server)Client()`
  // with no `??` seam — a client-injected module (`client ?? await createClient()`) or a
  // service-client insert is not the shape (C13b). Receiver matching is by NAME within
  // the file (stated blind spot: a same-named binding in another function counts).
  const EVENT_INSERT = /([A-Za-z_$][\w$]*)\s*\.from\(\s*["']lifecycle_events["']\s*\)\s*\.insert\(/g
  const eventWriters: CensusResult["eventWriters"] = []
  for (const f of parent.keys()) {
    if (isUseServer(f)) continue
    const v = views(f)
    if (!COOKIE_CLIENT_SPECIFIER.test(v.stripped)) continue
    const code = blankComments(v.stripped)
    const cookieBound = [...code.matchAll(EVENT_INSERT)].some((m) =>
      new RegExp(`(?:const|let)\\s+${m[1].replace(/\$/g, "\\$")}\\s*=\\s*await\\s+create(?:Server)?Client\\s*\\(`).test(code))
    if (!cookieBound) continue
    eventWriters.push({ file: f, path: pathTo(f) })
  }
  eventWriters.sort((a, b) => a.file.localeCompare(b.file))
  return { entries, reachedModules: parent.size, targetModules: [...edges.keys()].sort(), checkedExports, findings, eventWriters }
}

// ─── Reporting ────────────────────────────────────────────────────────────────
let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const key = (f: Finding) => `${f.target}::${f.exportName}`

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n═══ 1. POSITIVE CONTROLS — the finder still recognises the defect it was written for ═══")
{
  const fixture = (files: Record<string, string>): SourceSet => ({ files: Object.keys(files), read: (f) => files[f] })
  const COOKIE_ACTION = `"use server"\nimport { getAgentContext } from "@/lib/identity/get-agent-context"\nexport async function syncThing(id: string) {\n  const ctx = await getAgentContext()\n  if (!ctx.brokerageId) return { success: false, error: "Unauthorized" }\n  return { success: true }\n}\n`
  const SERVICE_ACTION = `"use server"\nimport { createServiceClient } from "@/lib/supabase/service"\nexport async function syncThing(id: string) {\n  return createServiceClient().from("t").select("id").eq("id", id)\n}\n`
  const CRON = (body: string) => `import { verifyCronAuth } from "@/lib/cron-auth"\n${body}\nexport async function GET(req: Request) { const u = verifyCronAuth(req); return syncThing("x") }\n`

  // C1 — the pre-86E dotloop-sync shape: a cron imports a session-gated action.
  const c1 = runCensus(fixture({
    "app/api/cron/thing/route.ts": CRON(`import { syncThing } from "@/app/actions/thing"`),
    "app/actions/thing.ts": COOKIE_ACTION,
  }))
  ok("C1 a cron importing a getAgentContext-gated \"use server\" export IS a finding (the pre-86E dotloop-sync shape)",
    c1.findings.length === 1 && key(c1.findings[0]) === "app/actions/thing.ts::syncThing", JSON.stringify(c1.findings.map(key)))

  // C2 — the same edge onto a service-client body is not.
  const c2 = runCensus(fixture({
    "app/api/cron/thing/route.ts": CRON(`import { syncThing } from "@/app/actions/thing"`),
    "app/actions/thing.ts": SERVICE_ACTION,
  }))
  ok("C2 the SAME edge onto a service-client body is NOT a finding", c2.findings.length === 0 && c2.checkedExports === 1)

  // C3 — a tombstone naming the old import is prose, not an edge.
  const c3 = runCensus(fixture({
    "app/api/cron/thing/route.ts": CRON(`// TOMBSTONE: was import { syncThing } from "@/app/actions/thing"\nimport { syncThing } from "@/lib/thing-core"`),
    "lib/thing-core.ts": `import "server-only"\nexport async function syncThing() { return 1 }\n`,
    "app/actions/thing.ts": COOKIE_ACTION,
  }))
  ok("C3 an import that survives only in a TOMBSTONE comment is not an edge (comments stripped first)", c3.findings.length === 0 && c3.targetModules.length === 0)

  // C4 — a session token inside a string literal is not a session read.
  const c4 = runCensus(fixture({
    "app/api/cron/thing/route.ts": CRON(`import { syncThing } from "@/app/actions/thing"`),
    "app/actions/thing.ts": `"use server"\nexport async function syncThing() { throw new Error("getAgentContext refused: requireCaller()") }\n`,
  }))
  ok("C4 a session token that appears only inside a string is NOT a session read (blankStrings)", c4.findings.length === 0 && c4.checkedExports === 1)

  // C5 — transitive: cron → lib/kernel helper → action, and the path is reported.
  const c5 = runCensus(fixture({
    "app/api/cron/thing/route.ts": CRON(`import { helper as syncThing } from "@/lib/kernel/helper"`),
    "lib/kernel/helper.ts": `import { syncThing } from "../../app/actions/thing"\nexport async function helper() { return syncThing("x") }\n`,
    "app/actions/thing.ts": COOKIE_ACTION,
  }))
  ok("C5 a cron → lib/kernel helper (relative import) → action chain IS a finding, with the chain as its path",
    c5.findings.length === 1 && c5.findings[0].path.join(" > ") === "app/api/cron/thing/route.ts > lib/kernel/helper.ts > app/actions/thing.ts",
    c5.findings[0]?.path.join(" > "))

  // C6 — a session-authed route outside cron/webhooks is not an entry.
  const c6 = runCensus(fixture({
    "app/api/things/route.ts": `import { createClient } from "@/lib/supabase/server"\nimport { syncThing } from "@/app/actions/thing"\nexport async function POST() { const s = await createClient(); return syncThing("x") }\n`,
    "app/actions/thing.ts": COOKIE_ACTION,
  }))
  ok("C6 a SESSION-authed route (no non-session credential) is not a sessionless entry", c6.entries.length === 0 && c6.findings.length === 0)

  // C7 — the cookie read sits in a same-file helper the export calls.
  const c7 = runCensus(fixture({
    "app/api/cron/thing/route.ts": CRON(`import { syncThing } from "@/app/actions/thing"`),
    "app/actions/thing.ts": `"use server"\nimport { createClient } from "@/lib/supabase/server"\nasync function load() { const s = await createClient(); return s.from("t").select("id") }\nexport async function syncThing() { return load() }\n`,
  }))
  ok("C7 a cookie createClient() inside a same-file helper the export CALLS is a finding (callee closure)",
    c7.findings.length === 1 && c7.findings[0].why.some((w) => w.startsWith("load:")), JSON.stringify(c7.findings.map((f) => f.why)))

  // C8 — the edge is a destructured `await import()`.
  const c8 = runCensus(fixture({
    "app/api/webhooks/thing/route.ts": `export async function POST() { const { syncThing } = await import("@/app/actions/thing"); return syncThing("x") }\n`,
    "app/actions/thing.ts": COOKIE_ACTION,
  }))
  ok("C8 a destructured `await import()` from a WEBHOOK route is an edge and a finding", c8.findings.length === 1 && c8.entries[0]?.kind === "webhook")

  // C9 — "use server" only in a comment: the module is a plain module and the walk goes THROUGH it.
  const c9 = runCensus(fixture({
    "app/api/cron/thing/route.ts": CRON(`import { syncThing } from "@/lib/thing-core"`),
    "lib/thing-core.ts": `// this file was "use server" until lane 86E\nimport "server-only"\nimport { syncThing as inner } from "@/app/actions/thing"\nexport async function syncThing() { return inner("x") }\n`,
    "app/actions/thing.ts": COOKIE_ACTION,
  }))
  ok("C9 a \"use server\" that survives only in a comment is not a directive — the walk passes through and finds the action behind it",
    c9.findings.length === 1 && key(c9.findings[0]) === "app/actions/thing.ts::syncThing")

  // C10 — a voice-style route outside cron/webhooks admitted by an HMAC is an entry.
  const c10 = runCensus(fixture({
    "app/api/voice/turn/route.ts": `import { timingSafeEqual } from "node:crypto"\nimport { syncThing } from "@/app/actions/thing"\nexport async function POST() { if (!timingSafeEqual(a, b)) return null; return syncThing("x") }\n`,
    "app/actions/thing.ts": COOKIE_ACTION,
  }))
  ok("C10 a route admitted by a NON-SESSION credential (timingSafeEqual) outside cron/webhooks IS an entry", c10.entries.length === 1 && c10.entries[0].kind === "credential" && c10.findings.length === 1)

  // C11 — a whole-module `await import()` bound to a name: only the members READ count.
  const TWO = `"use server"\nimport { getAgentContext } from "@/lib/identity/get-agent-context"\nexport async function used() { return getAgentContext() }\nexport async function unused() { return getAgentContext() }\n`
  const c11 = runCensus(fixture({
    "app/api/cron/thing/route.ts": `export async function GET() { const mod = await import("@/app/actions/two"); return (mod as any).used() }\n`,
    "app/actions/two.ts": TWO,
  }))
  ok("C11 a whole-module `await import()` counts only the members it READS — `(mod as any).used()` flags `used`, not its unread sibling",
    c11.findings.length === 1 && c11.findings[0].exportName === "used", JSON.stringify(c11.findings.map(key)))
  // …and a namespace passed along unread stays "every export" (the stated over-report).
  const c11b = runCensus(fixture({
    "app/api/cron/thing/route.ts": `import * as mod from "@/app/actions/two"\nexport async function GET() { return run(mod) }\n`,
    "app/actions/two.ts": TWO,
  }))
  ok("C11b a namespace import passed along unread expands to EVERY export (over-report, never a silent pass)", c11b.findings.length === 2)

  // C12 — the inline `(await import("x")).member(…)` shape (lib/orchestrator/internal.ts
  // EVENT_HANDLERS, pre-86F): only the member READ is an edge.
  const c12 = runCensus(fixture({
    "app/api/cron/thing/route.ts": `export async function GET() { return (await import("@/app/actions/two")).used() }\n`,
    "app/actions/two.ts": TWO,
  }))
  ok("C12 an inline `(await import(\"x\")).used()` flags `used` only — its unread sibling is not an edge",
    c12.findings.length === 1 && c12.findings[0].exportName === "used", JSON.stringify(c12.findings.map(key)))
  // …and the SAME specifier also imported bare (not member-read) stays "every export".
  const c12b = runCensus(fixture({
    "app/api/cron/thing/route.ts": `export async function GET() { const p = import("@/app/actions/two"); await (await import("@/app/actions/two")).used(); return p }\n`,
    "app/actions/two.ts": TWO,
  }))
  ok("C12b a specifier ALSO imported in a non-member shape still expands to EVERY export (over-report, never a silent pass)", c12b.findings.length === 2)

  // C13 — the EMITTER shape (pre-86F lib/events/event-helpers.ts): a webhook reaches a
  // plain helper that builds the COOKIE client and inserts lifecycle_events.
  const COOKIE_EMITTER = `import { createServerClient } from "@/lib/supabase/server"\nexport async function logEvent(e: any) { const s = await createServerClient(); return s.from("lifecycle_events").insert([e]).select().single() }\n`
  const c13 = runCensus(fixture({
    "app/api/webhooks/thing/route.ts": `import { logEvent } from "@/lib/events/helpers"\nexport async function POST() { return logEvent({}) }\n`,
    "lib/events/helpers.ts": COOKIE_EMITTER,
  }))
  ok("C13 a webhook reaching a COOKIE-client lifecycle_events insert IS an event-writer finding (the pre-86F logEventAndTrigger shape), with its path",
    c13.eventWriters.length === 1 && c13.eventWriters[0].path.join(" > ") === "app/api/webhooks/thing/route.ts > lib/events/helpers.ts", JSON.stringify(c13.eventWriters))
  // …the same insert on the SERVICE client is not; nor is one that survives only in a tombstone.
  const c13b = runCensus(fixture({
    "app/api/webhooks/thing/route.ts": `import { logEvent } from "@/lib/events/core"\nexport async function POST() { return logEvent({}) }\n`,
    "lib/events/core.ts": `import "server-only"\nimport { createServiceClient } from "@/lib/supabase/service"\n// was: const s = await createServerClient(); s.from("lifecycle_events").insert([e])\nexport async function logEvent(e: any) { return createServiceClient().from("lifecycle_events").insert(e).select("id") }\n`,
  }))
  ok("C13b the same insert on the SERVICE client (with a tombstone quoting the old cookie insert) is NOT an event-writer finding", c13b.eventWriters.length === 0)
}

// ═════════════════════════════════════════════════════════════════════════════
// THE LEDGER — every current finding, with its evidence. FIXED items are not
// here: they left the list (lane 86E: syncDotloopDocuments, aiGenerateReview-
// Request, aiGenerateTouchpoint — see "FIXED" in section 3). An OPEN entry is a
// real defect with the lane that owns it; an adjudicated one names the caller
// evidence that the cookie read is never reached.
type Ruling = { kind: "adjudicated"; why: string } | { kind: "open"; owner: string; why: string }
const HUB = "lib/orchestrator/internal.ts"
/** One ruling, many keys — a group is still ratcheted key by key. */
const group = (keys: string[], rule: Ruling): Record<string, Ruling> => Object.fromEntries(keys.map((k) => [k, rule]))
const LEDGER: Record<string, Ruling> = {
  // ── adjudicated: the sessionless caller does not actually hit the cookie read ──
  ...group([
    "app/actions/cron-kernel.ts::createCronRunContextAction",
    "app/actions/cron-kernel.ts::recordCronStartAction",
    "app/actions/cron-kernel.ts::recordCronSuccessAction",
    "app/actions/cron-kernel.ts::recordCronFailureAction",
    "app/actions/cron-kernel.ts::recordCronProgressAction",
  ], { kind: "adjudicated", why: "SOFT CHECK — softAuthCheck (app/actions/cron-kernel.ts) only WARNS on a missing session and never blocks; the write runs through lib/kernel/cron-logging.ts. The file head documents the /api/cron routes as the expected sessionless caller." }),
  ...group([
    "app/actions/lifetime-customer-touchpoints.ts::sendAnniversaryMessage",
    "app/actions/lifetime-customer-touchpoints.ts::sendBirthdayMessage",
    "app/actions/lifetime-customer-touchpoints.ts::sendReferralRequest",
  ], { kind: "adjudicated", why: "CLIENT SEAM FILLED — resolveTouchpointActor takes opts.client ?? createClient() and opts.agentId ?? auth.getUser(); app/api/cron/lifetime-customer-touchpoints passes { agentId, client: supabase } (service) on every call, so neither cookie read runs." }),
  "app/actions/open-house-automation.ts::processEventFollowups": { kind: "adjudicated", why: "CLIENT SEAM FILLED — processEventFollowups(eventId, client) uses client ?? createClient(); app/api/cron/open-house-followup passes svc. Lane 86E threaded the SAME client into its analytics tail (generateEventAnalytics built its own cookie client and wrote an all-zero open_house_analytics row from the cron)." },
  "app/actions/showings.ts::requestShowing": { kind: "adjudicated", why: "CLIENT SEAM FILLED — requestShowing's sessionless-caller overload (app/actions/showings.ts, `caller?: { client, actorUserId }`); lib/voice/showing-request.ts passes { client: svc, actorUserId }, so the cookie client and auth.getUser are never reached from the voice tool call." },
  "app/actions/ai-isa/initiate-engagement.ts::initiateAIISAEngagement": { kind: "adjudicated", why: "DUAL-MODE GATE WITH A PRESENTED CREDENTIAL — the speed-to-lead cron (lib/ai-isa/speed-to-lead.ts) passes { internalSecret: CRON_SECRET }; getAgentContext answers unauthenticated and the gate admits the matching secret; every read is on the service client with the lead row's tenant. Lane 86E closed the env-PRESENCE trust (any anonymous POST was 'trusted internal' on a real deploy)." },
  "app/actions/ai-isa/handle-inbound-email.ts::processInboundEmail": { kind: "adjudicated", why: "DUAL-MODE GATE WITH A PRESENTED CREDENTIAL — app/api/providers/inbound passes internalSecret: CRON_SECRET (both call sites); getAgentContext is read only when no matching secret is presented. Mailbox territory is lane 86A's." },
  "app/actions/auth/signup-brokerage.ts::signupBrokerageAction": { kind: "adjudicated", why: "MODULE-LEVEL OVER-REPORT — app/api/cron/did-agent-sync reaches lib/platform/demo-tenant.ts only through lib/did/platform-live-agent.ts, which imports and calls findDemoBrokerage alone; signupBrokerageAction is called only by ensureDemoTenant, a superadmin action under a session." },
  "app/actions/buyer-offer/respond-to-counter.ts::respondToCounter": { kind: "adjudicated", why: "MODULE-LEVEL OVER-REPORT through the lib/kernel barrel — app/api/cron/calendar-sync imports only pullCalendarEventsFromProvider from @/lib/kernel; the kernel's respondToCounter wrapper (lib/kernel/offers.ts) has no sessionless caller." },
  "lib/identity/get-agent-context.ts::getAgentContext": { kind: "adjudicated", why: "THE RESOLVER ITSELF — reached only through module-level barrels (lib/identity/index.ts, lib/platform/acting-context.ts). Called sessionless it FAILS CLOSED (isAuthenticated false), which is its contract." },

  // ── OPEN — real, not fixed in lane 86E, each with the lane that owns it ──
  // FIXED in lane 86F (owner ruling "build and fix") — the 27-key "orchestrator
  // event-bus lane" group LEFT this list. 9 were real hub handlers and now reach
  // server-only cores (section 4); 18 were session ACTIONS the hub never called,
  // over-reported because the inline `(await import(x)).member` shape expanded to
  // every export (control C12 now reads only the member). The hub no longer imports
  // copilot / credit-copilot / journey-tasks / listing-lifecycle / assistant at all,
  // and the listing-appt-prep chain reaches the CMA core, not app/actions/ai-cma.ts.
  // FIXED in lane 86F3 — the four app/actions/video-content.ts keys (approveAndGenerateVideo,
  // handleHighEngagement, handleVideoGenerated, handleVideoPublished) LEFT this list: the hub
  // reaches lib/video/video-event-reactions.ts and the "use server" doors are retired.
  ...group([
    "app/actions/lead-scraping-config.ts::createScrapingJob",
    "app/actions/lead-scraping-config.ts::updateScrapingJob",
  ], { kind: "open", owner: "scraping (left open by ruling)", why: "app/api/cron/lead-scraping calls these cookie-client job writers directly, so its lead_scraping_jobs rows are written through an empty session. Scraping is excluded from census lanes (owner: 'burned down with only scraping left opened')." }),
  // FIXED in lane 86F — aiGenerateListingDescription LEFT this list: the
  // listing-presentation builder calls lib/listings/listing-description-core.ts
  // with its verified tenant and reads the real keys (section 4).
}

console.log("\n═══ 2. THE CENSUS — \"use server\" exports that sessionless paths import and that read the session ═══")
const TREE: SourceSet = {
  files: runtimeFiles(".").map((f) => normalize(f)).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts")),
  read: (f) => readFileSync(f, "utf8"),
}
const r = runCensus(TREE)
const byKind = (k: string) => r.entries.filter((e) => e.kind === k).length
const libTargets = r.targetModules.filter((t) => t.startsWith("lib/"))
const appTargets = r.targetModules.filter((t) => !t.startsWith("lib/"))
console.log(`\n  DENOMINATOR: ${TREE.files.length} runtime .ts/.tsx files · ${r.entries.length} sessionless entries (${byKind("cron")} cron · ${byKind("webhook")} webhook · ${byKind("credential")} other routes admitted by a non-session credential)`)
console.log(`               ${r.reachedModules} modules reached from them · ${r.targetModules.length} "use server" modules imported on those paths (${libTargets.length} lib/ · ${appTargets.length} app/) · ${r.checkedExports} imported exports with a body judged`)
console.log(`  FINDINGS: ${r.findings.length} imported exports read the cookie session (${r.findings.filter((f) => f.target.startsWith("lib/")).length} in lib/ "use server" files)`)
for (const f of r.findings) {
  const rule = LEDGER[key(f)]
  const tag = !rule ? "✗ NEW" : rule.kind === "open" ? `· OPEN (${rule.owner})` : "· adjudicated"
  console.log(`    ${tag}  ${key(f)}  [${f.why.slice(0, 3).join("; ")}]`)
  console.log(`        path: ${f.path.join(" > ")}${f.importers.length > 1 ? `  (+${f.importers.length - 1} more importer(s))` : ""}`)
}

ok("the entry finder sees SOMETHING (zero entries would mean the finder is blind, not that the tree is clean)", r.entries.length > 0 && byKind("cron") > 0 && byKind("webhook") > 0)
ok("the walk reaches \"use server\" modules on those paths (zero would mean the import resolver is blind)", r.targetModules.length > 0 && r.checkedExports > 0)

const newFindings = r.findings.filter((f) => !LEDGER[key(f)])
ok(`ZERO unledgered findings — every sessionless-reached cookie read is fixed, adjudicated with evidence, or OPEN with its owner (found ${newFindings.length} new)`,
  newFindings.length === 0,
  newFindings.length ? `NEW: ${newFindings.map(key).join(", ")} — move the body to a server-only core on the service client with the tenant from the verified context (LANE_RULES wave 86; lib/transactions/dotloop-document-sync.ts is the template), or adjudicate it here WITH the caller's evidence` : undefined)
const findingKeys = new Set(r.findings.map(key))
const stale = Object.keys(LEDGER).filter((k) => !findingKeys.has(k))
ok("every LEDGER entry is still a finding (a fixed or retired one must leave the list — it only tightens)", stale.length === 0,
  stale.length ? `no longer a finding — delete from LEDGER in scripts/sessionless-use-server-census.ts: ${stale.join(", ")}` : undefined)

console.log("\n═══ 3. FIXED (lanes 86E, 86F) — sessionless callers now reach a server-only core, not the cookie door ═══")
{
  const FIXED: Array<{ door: string; caller: string; core: string }> = [
    { door: "app/actions/dotloop-integration.ts::syncDotloopDocuments", caller: "app/api/cron/dotloop-sync/route.ts", core: "lib/transactions/dotloop-document-sync.ts" },
    { door: "app/actions/ai-review-automation.ts::aiGenerateReviewRequest", caller: "app/api/cron/review-request-on-close/route.ts", core: "lib/reputation/review-request-draft.ts" },
    { door: "app/actions/ai-sphere-management.ts::aiGenerateTouchpoint", caller: "lib/sphere-resonance/run-resonance-scan.ts", core: "lib/sphere-resonance/touchpoint-draft.ts" },
    // lane 86F
    { door: "app/actions/ai-listing-intake.ts::aiGenerateListingDescription", caller: "lib/workflow/intelligence/listing-presentation-builder.ts", core: "lib/listings/listing-description-core.ts" },
    { door: "app/actions/ai-cma.ts::generateAICMA", caller: "lib/workflow-orchestrator/chains/listing-appt-prep.ts", core: "lib/cma/ai-cma-report.ts" },
  ]
  for (const x of FIXED) {
    ok(`${x.door} is no longer reached by a sessionless path`, !findingKeys.has(x.door))
    const callerSrc = existsSync(x.caller) ? stripComments(readFileSync(x.caller, "utf8")) : ""
    const coreSpec = `@/${x.core.replace(/\.ts$/, "")}`
    ok(`…${x.caller} imports the core (${x.core}) instead`, callerSrc.includes(coreSpec))
    const coreSrc = existsSync(x.core) ? readFileSync(x.core, "utf8") : ""
    const coreStripped = stripComments(coreSrc)
    ok(`…and the core is server-only, never "use server", and builds no cookie client`,
      /^\s*import\s+["']server-only["']/m.test(coreStripped) && !hasUseServerDirective(coreStripped) && !COOKIE_CLIENT_SPECIFIER.test(coreStripped) &&
      !SESSION_TOKENS.some((t) => t.on === "identifiers" && t.re.test(blankStrings(coreSrc))))
    ok(`…and it pins every tenant read to the brokerageId it is handed`, (coreStripped.match(/\.eq\("brokerage_id", brokerageId\)/g) ?? []).length >= 2)
  }
}

console.log("\n═══ 4. THE HUB (lane 86F) — lib/orchestrator/internal.ts reaches server-only cores, not cookie doors ═══")
{
  // The cross-file blind spot stated in the header (a target's cross-file callee is
  // not followed) hid the WORST of the hub: app/actions/listing-lifecycle.ts's
  // handlers read no session themselves — they delegated to lib/application
  // services that built the cookie client. So the hub is pinned here by RULE, not
  // by the finder: every module its source imports is either a server-only core
  // that builds no cookie client, or a "use server" module whose every imported
  // export is on the LEDGER above.
  const HUB_SRC = readFileSync(HUB, "utf8")
  const hubStripped = stripComments(HUB_SRC)
  ok("the hub builds no cookie client (no @/lib/supabase/server import) — markEventProcessed / logProcessingResults / the suggestion cards ride the service client",
    !COOKIE_CLIENT_SPECIFIER.test(hubStripped) && /from\s*["']@\/lib\/supabase\/service["']/.test(hubStripped))
  const hubSpecs = [...new Set([...hubStripped.matchAll(/(?:from\s*|import\(\s*)["'](@\/[^"']+)["']/g)].map((m) => m[1]))]
  const hubUseServer: string[] = []
  for (const spec of hubSpecs) {
    const base = spec.slice(2)
    const file = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((c) => existsSync(c))
    if (file && hasUseServerDirective(stripComments(readFileSync(file, "utf8")))) hubUseServer.push(file)
  }
  const hubFindingTargets = new Set(r.findings.filter((f) => f.path.includes(HUB)).map((f) => f.target))
  const unledgeredHubDoors = hubUseServer.filter((f) => hubFindingTargets.has(f) && r.findings.some((x) => x.target === f && !LEDGER[key(x)]))
  ok(`every "use server" module the hub still imports is either session-free or fully LEDGERED (${hubUseServer.join(", ") || "none"})`,
    unledgeredHubDoors.length === 0, unledgeredHubDoors.join(", "))
  // Positive control (lane 86F3 — the last real hub door, video-content, is closed, so the
  // control can no longer lean on a live finding): a hub-SHAPED fixture — a cron reaching
  // a plain hub module whose EVENT_HANDLERS inline-import a cookie-gated action — IS a
  // finding whose path runs through the hub, so "0 unledgered" above is not a blind 0.
  {
    const hubFixture = runCensus({
      files: ["app/api/cron/poll/route.ts", "lib/orchestrator/internal.ts", "app/actions/video-content.ts"],
      read: (f) => ({
        "app/api/cron/poll/route.ts": `import { emitEventFromCron } from "@/lib/orchestrator/internal"\nexport async function GET() { return emitEventFromCron({}) }\n`,
        "lib/orchestrator/internal.ts": `const EVENT_HANDLERS = { "video.published": async (e: any) => (await import("@/app/actions/video-content")).handleVideoPublished(e.payload) }\nexport async function emitEventFromCron(i: any) { return EVENT_HANDLERS["video.published"](i) }\n`,
        "app/actions/video-content.ts": `"use server"\nimport { createServerClient } from "@/lib/supabase/server"\nexport async function handleVideoPublished(p: any) { const s = await createServerClient(); return s.from("ai_video_projects").update({}).eq("id", p.video_id) }\n`,
      } as Record<string, string>)[f],
    })
    ok("…positive control: a hub-shaped fixture (cron → hub → inline-imported cookie door) IS a finding through the hub",
      hubFixture.findings.length === 1 && hubFixture.findings[0].path.includes("lib/orchestrator/internal.ts") &&
        hubFixture.findings[0].exportName === "handleVideoPublished", JSON.stringify(hubFixture.findings.map((f) => f.path)))
  }

  const HUB_CORES = [
    "lib/assistant/smart-suggestion.ts",
    "lib/listing-lifecycle/lifecycle-event-tasks.ts",
    "lib/credit/credit-event-handlers.ts",
    "lib/portal/journey-event-handlers.ts",
    "lib/copilot/seven-day-plan.ts",
    "lib/video/video-event-reactions.ts",
  ]
  for (const core of HUB_CORES) {
    const raw = existsSync(core) ? readFileSync(core, "utf8") : ""
    const st = stripComments(raw)
    const spec = `@/${core.replace(/\.ts$/, "")}`
    ok(`${core}: imported by the hub`, hubStripped.includes(spec))
    ok(`…server-only, never "use server", builds no cookie client, reads no session`,
      /^\s*import\s+["']server-only["']/m.test(st) && !hasUseServerDirective(st) && !COOKIE_CLIENT_SPECIFIER.test(st) &&
      !SESSION_TOKENS.some((t) => t.on === "identifiers" && t.re.test(blankStrings(raw))))
    ok(`…and pins its tenant reads to the brokerageId it is handed`, (st.match(/\.eq\("brokerage_id", brokerageId\)/g) ?? []).length >= 1)
  }
  // The retired doors are GONE, not merely unreferenced — a "use server" export is a
  // public endpoint, and the hub was their only caller.
  const RETIRED: Array<[string, string]> = [
    ["app/actions/copilot.ts", "generate7DayPlan"],
    ["app/actions/credit-copilot.ts", "handleTargetReached"],
    ["app/actions/credit-copilot.ts", "handlePartnerReferral"],
    ["app/actions/credit-copilot.ts", "handlePartnerStatusUpdate"],
    ["app/actions/journey-tasks.ts", "handleTaskCompletedEvent"],
    ["app/actions/listing-lifecycle.ts", "handleOfferReceived"],
    ["app/actions/listing-lifecycle.ts", "triggerReviewSequence"],
    ["app/actions/assistant.ts", "generateSmartSuggestion"],
    ["app/actions/video-content.ts", "handleVideoGenerated"],
    ["app/actions/video-content.ts", "approveAndGenerateVideo"],
    ["app/actions/video-content.ts", "handleVideoPublished"],
    ["app/actions/video-content.ts", "handleHighEngagement"],
  ]
  const exportedDoor = (fn: string) => new RegExp(`export\\s+async\\s+function\\s+${fn}\\b`)
  // Positive control: the absence test below still recognises a live door, and a
  // TOMBSTONE naming it (every retired door has one) is not read as one.
  ok("…positive control: the retired-door finder recognises a live export and ignores a tombstone naming it",
    exportedDoor("generate7DayPlan").test(blankStrings(stripComments(`"use server"\nexport async function generate7DayPlan(p: any) { return p }\n`))) &&
    !exportedDoor("generate7DayPlan").test(blankStrings(stripComments(`// TOMBSTONE — \`export async function generate7DayPlan(payload)\` LIVED HERE\n`))))
  for (const [file, fn] of RETIRED) {
    const st = existsSync(file) ? blankStrings(stripComments(readFileSync(file, "utf8"))) : ""
    ok(`${file}::${fn} is no longer an exported "use server" door`, existsSync(file) && !exportedDoor(fn).test(st))
  }
}

console.log("\n═══ 5. THE EMITTER (lane 86F) — no sessionless path inserts lifecycle_events on the cookie client ═══")
{
  // The four callers (zapier, dotloop, e-sign finalize, e-sign execution loop) now
  // write through lib/events/lifecycle-event-core.ts on the service client with the
  // verified row's tenant; logEventAndTrigger is a SESSION door. lib/offers/
  // offer-extractor.ts (inbound-mail webhook) took the service client through a seam.
  // What remains is ADJUDICATED with evidence; a NEW writer fails, a stale entry fails.
  const EVENT_LEDGER: Record<string, string> = {
    "lib/kernel/education.ts": "MODULE-LEVEL OVER-REPORT through the lib/kernel barrel — app/api/cron/calendar-sync imports ONLY pullCalendarEventsFromProvider from @/lib/kernel (the same evidence as respondToCounter above); education's session writers have no sessionless caller.",
    "lib/kernel/listings.ts": "MODULE-LEVEL OVER-REPORT through the lib/kernel barrel — reached only via app/api/cron/calendar-sync's `import { pullCalendarEventsFromProvider } from \"@/lib/kernel\"`.",
    "lib/kernel/offers.ts": "MODULE-LEVEL OVER-REPORT through the lib/kernel barrel — calendar-sync imports only pullCalendarEventsFromProvider; offers.ts's cookie insert helper is reached from its session actions.",
  }
  console.log(`  event writers on the cookie client reached sessionless: ${r.eventWriters.length} (${r.eventWriters.filter((w) => EVENT_LEDGER[w.file]).length} adjudicated)`)
  for (const w of r.eventWriters) console.log(`    ${EVENT_LEDGER[w.file] ? "· adjudicated" : "✗ NEW"}  ${w.file}  path: ${w.path.join(" > ")}`)
  const newWriters = r.eventWriters.filter((w) => !EVENT_LEDGER[w.file])
  ok("ZERO unledgered sessionless-reached cookie-client lifecycle_events inserts (C13 proves the finder sees the shape)", newWriters.length === 0,
    newWriters.map((w) => w.file).join(", "))
  const writerFiles = new Set(r.eventWriters.map((w) => w.file))
  const staleWriters = Object.keys(EVENT_LEDGER).filter((f) => !writerFiles.has(f))
  ok("every EVENT_LEDGER entry is still a finding (it only tightens)", staleWriters.length === 0, staleWriters.join(", "))
  const core = "lib/events/lifecycle-event-core.ts"
  const coreRaw = existsSync(core) ? readFileSync(core, "utf8") : ""
  const coreSt = stripComments(coreRaw)
  ok(`${core} is server-only, never "use server", builds no cookie client, reads no session`,
    /^\s*import\s+["']server-only["']/m.test(coreSt) && !hasUseServerDirective(coreSt) && !COOKIE_CLIENT_SPECIFIER.test(coreSt) &&
    !SESSION_TOKENS.some((t) => t.on === "identifiers" && t.re.test(blankStrings(coreRaw))))
  ok("…its dedupe read and actor proof are pinned to the brokerageId it is handed, and the insert is counted",
    (coreSt.match(/\.eq\("brokerage_id", brokerageId\)/g) ?? []).length >= 2 && /from\("lifecycle_events"\)\s*\.insert\([\s\S]{0,700}\.select\(/.test(coreSt))
  for (const caller of ["app/api/webhooks/zapier/route.ts", "app/api/webhooks/dotloop/route.ts", "lib/esign-webhooks/finalize-packet.ts", "lib/forms/esign-execution-loop.ts"]) {
    const st = existsSync(caller) ? stripComments(readFileSync(caller, "utf8")) : ""
    ok(`${caller} writes events through the core, not the cookie-client helper`,
      st.includes("@/lib/events/lifecycle-event-core") && !/\blogEventAndTrigger\s*\(/.test(st))
  }
  const zap = existsSync("app/api/webhooks/zapier/route.ts") ? blankComments(stripComments(readFileSync("app/api/webhooks/zapier/route.ts", "utf8"))) : ""
  ok("the zapier webhook takes its tenant from the connection record (global_settings.zapier_api_key), never the body",
    /from\("global_settings"\)[\s\S]{0,120}\.eq\("zapier_api_key"/.test(zap) && /recordLifecycleEvent\(svc, tenant\.brokerageId/.test(zap) && !/brokerage_id:\s*payload\.brokerage_id/.test(zap))
}

console.log("\n═══ 6. THE JOURNEY EMITTERS (lane 86F2) — every routed journey type has an emitter that dispatches ═══")
{
  // THE RULE, run (pure — lib/portal/journey-utils.ts detectJourneyMilestones).
  const { detectJourneyMilestones } = await import("../lib/portal/journey-utils")
  const STAGES = [
    { id: "s1", name: "Prep", tasks: [{ id: "a" }, { id: "b" }] },
    { id: "s2", name: "Search", tasks: [{ id: "c" }] },
  ]
  const r1 = detectJourneyMilestones(STAGES, new Set(["s1:a"]), "s1:a", true)
  ok("J1 a completion that leaves its stage unfinished finishes nothing", r1.stage === null && !r1.allDone)
  const r2 = detectJourneyMilestones(STAGES, new Set(["s1:a", "s1:b"]), "s1:b", true)
  ok("J2 POSITIVE CONTROL the completion that finishes a stage IS a stage completion, naming the next stage",
    r2.stage?.id === "s1" && r2.stage?.nextName === "Search" && !r2.allDone, JSON.stringify(r2))
  const r3 = detectJourneyMilestones(STAGES, new Set(["s1:a", "s1:b", "s2:c"]), "s2:c", true)
  ok("J3 POSITIVE CONTROL the last task finishes its stage AND the journey", r3.stage?.id === "s2" && r3.stage?.nextName === null && r3.allDone)
  const r4 = detectJourneyMilestones(STAGES, new Set(["s1:a", "s1:b", "s2:c"]), "s1:b", false)
  ok("J4 a RE-SUBMITTED task finishes nothing again (the stage was already done)", r4.stage === null && !r4.allDone)
  const r5 = detectJourneyMilestones(STAGES, new Set(["s1:a", "s1:b", "s2:c"]), "zz:unknown", true)
  ok("J5 an unknown task id finishes nothing", r5.stage === null && !r5.allDone)

  // THE WIRING, read (comments stripped).
  const em = stripComments(existsSync("lib/portal/journey-milestone-events.ts") ? readFileSync("lib/portal/journey-milestone-events.ts", "utf8") : "")
  ok("the emitter is server-only, writes through the DISPATCHING service core, and emits all three journey types",
    /^\s*import\s+["']server-only["']/m.test(em) && /recordLifecycleEvent\(svc, brokerageId/.test(em) &&
      ["JOURNEY_TASK_COMPLETED", "JOURNEY_STAGE_COMPLETED", "JOURNEY_ALL_TASKS_DONE"].every((t) => em.includes(`EVENT_TYPES.${t}`)) &&
      !COOKIE_CLIENT_SPECIFIER.test(em))
  ok("…decides from SERVER facts: the contact's persona and every completion, both tenant-pinned",
    /from\("contacts"\)\.select\("contact_persona"\)[\s\S]{0,80}\.eq\("brokerage_id", brokerageId\)/.test(em) &&
      /from\("client_portal_activity"\)[\s\S]{0,200}\.eq\("brokerage_id", brokerageId\)/.test(em) && /detectJourneyMilestones\(/.test(em))
  const jt = stripComments(readFileSync("app/actions/journey-tasks.ts", "utf8"))
  ok("completeTask (the ONLY journey-completion writer) calls the emitter with the tenant requireContactAccess verified",
    /emitJourneyCompletionEvents\(svc, anchor\.brokerageId/.test(jt) && !/\bemitEvent\s*\(/.test(jt))
  // Every routed journey type has an emitter somewhere in runtime code.
  const hubCases = stripComments(readFileSync(HUB, "utf8"))
  for (const t of ["JOURNEY_TASK_COMPLETED", "JOURNEY_STAGE_COMPLETED", "JOURNEY_ALL_TASKS_DONE"]) {
    ok(`EVENT_TYPES.${t} is routed by the hub AND emitted`, hubCases.includes(`case EVENT_TYPES.${t}:`) && em.includes(`EVENT_TYPES.${t}`))
  }
}

console.log(`\n${"═".repeat(70)}`)
console.log(`SESSIONLESS "use server" CENSUS — ${pass} passed, ${fail} failed · ${r.findings.length} findings (${r.findings.filter((f) => LEDGER[key(f)]?.kind === "adjudicated").length} adjudicated, ${r.findings.filter((f) => LEDGER[key(f)]?.kind === "open").length} open, ${newFindings.length} new)`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log("✅ SESSIONLESS_USE_SERVER_PASS — no new cookie-session read on a cron/webhook/voice path; the ledger is current.")
