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
    for (const m of s.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
      if (out.some((e) => e.spec === m[1])) continue
      out.push({ spec: m[1], names: "*" })
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
  return { entries, reachedModules: parent.size, targetModules: [...edges.keys()].sort(), checkedExports, findings }
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
  ...group([
    "app/actions/copilot.ts::analyzeContactPriority",
    "app/actions/copilot.ts::checkOverdueMilestones",
    "app/actions/copilot.ts::completeMilestone",
    "app/actions/copilot.ts::createTransactionMilestone",
    "app/actions/copilot.ts::executeCopilotTask",
    "app/actions/copilot.ts::generate7DayPlan",
    "app/actions/copilot.ts::generateDailyGameplan",
    "app/actions/copilot.ts::handleCoachingSessionBooked",
    "app/actions/copilot.ts::suggestNextActions",
    "app/actions/credit-copilot.ts::advanceCreditFlow",
    "app/actions/credit-copilot.ts::createCreditAccount",
    "app/actions/credit-copilot.ts::getCreditPipelineStats",
    "app/actions/credit-copilot.ts::handlePartnerReferral",
    "app/actions/credit-copilot.ts::handlePartnerStatusUpdate",
    "app/actions/credit-copilot.ts::handleTargetReached",
    "app/actions/credit-copilot.ts::referToCreditPartner",
    "app/actions/credit-copilot.ts::updateContactCreditStatus",
    "app/actions/journey-tasks.ts::handleAllTasksCompletedEvent",
    "app/actions/journey-tasks.ts::handleStageCompletedEvent",
    "app/actions/journey-tasks.ts::handleTaskCompletedEvent",
    "app/actions/listing-lifecycle.ts::advanceListingStage",
    "app/actions/listing-lifecycle.ts::completeListingTask",
    "app/actions/listing-lifecycle.ts::scheduleListingAppointment",
    "app/actions/listing-lifecycle.ts::sendReviewRequest",
    "app/actions/listing-lifecycle.ts::setMilestonePortalVisibility",
    "app/actions/assistant.ts::generateSmartSuggestion",
    "app/actions/ai-cma.ts::generateAICMA",
  ], { kind: "open", owner: "orchestrator event-bus lane (owner ruling first)", why: `THE HUB — ${HUB}'s EVENT_HANDLERS dispatch these from emitEventFromCron (app/api/cron/poll-did-videos and the other cron emitters) on a SERVICE credential with no session; the file says so itself ("session-gated handlers refuse every unattended dispatch — is true and unchanged"). Each handler needs a server-only core like lib/transactions/dotloop-document-sync.ts; 27 handlers is a lane of its own, not a census round.` }),
  ...group([
    "app/actions/video-content.ts::approveAndGenerateVideo",
    "app/actions/video-content.ts::handleHighEngagement",
    "app/actions/video-content.ts::handleVideoGenerated",
    "app/actions/video-content.ts::handleVideoPublished",
  ], { kind: "open", owner: "86B (video)", why: `the same ${HUB} dispatch, onto video-content handlers — video creation/publish paths are lane 86B's.` }),
  ...group([
    "app/actions/lead-scraping-config.ts::createScrapingJob",
    "app/actions/lead-scraping-config.ts::updateScrapingJob",
  ], { kind: "open", owner: "scraping (left open by ruling)", why: "app/api/cron/lead-scraping calls these cookie-client job writers directly, so its lead_scraping_jobs rows are written through an empty session. Scraping is excluded from census lanes (owner: 'burned down with only scraping left opened')." }),
  "app/actions/ai-listing-intake.ts::aiGenerateListingDescription": { kind: "open", owner: "unowned — queued as a follow-up task", why: "app/api/cron/listing-presentation-prep → lib/workflow/intelligence/listing-presentation-builder.ts calls it with no session, so getAgentContext refuses 'Unauthorized' and the deck falls back to an auto-summary every time. A SECOND defect sits behind the first: the builder reads descRes.description / .descriptions.long / .descriptions.standard — keys this action never returns (it returns descriptions.mlsDescription / marketingDescription …) — so even a session call yields no description. Fix = server-only core (compliance guard + brand voice on the service client, tenant from the builder's input.brokerageId, agents.id resolved from input.agentUserId) and read the real keys." },
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

console.log("\n═══ 3. FIXED (lane 86E) — the three sessionless callers now reach a server-only core, not the cookie door ═══")
{
  const FIXED: Array<{ door: string; caller: string; core: string }> = [
    { door: "app/actions/dotloop-integration.ts::syncDotloopDocuments", caller: "app/api/cron/dotloop-sync/route.ts", core: "lib/transactions/dotloop-document-sync.ts" },
    { door: "app/actions/ai-review-automation.ts::aiGenerateReviewRequest", caller: "app/api/cron/review-request-on-close/route.ts", core: "lib/reputation/review-request-draft.ts" },
    { door: "app/actions/ai-sphere-management.ts::aiGenerateTouchpoint", caller: "lib/sphere-resonance/run-resonance-scan.ts", core: "lib/sphere-resonance/touchpoint-draft.ts" },
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

console.log(`\n${"═".repeat(70)}`)
console.log(`SESSIONLESS "use server" CENSUS — ${pass} passed, ${fail} failed · ${r.findings.length} findings (${r.findings.filter((f) => LEDGER[key(f)]?.kind === "adjudicated").length} adjudicated, ${r.findings.filter((f) => LEDGER[key(f)]?.kind === "open").length} open, ${newFindings.length} new)`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log("✅ SESSIONLESS_USE_SERVER_PASS — no new cookie-session read on a cron/webhook/voice path; the ledger is current.")
