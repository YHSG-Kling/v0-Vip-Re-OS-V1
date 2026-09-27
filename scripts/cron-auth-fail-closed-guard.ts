#!/usr/bin/env tsx
/**
 * scripts/cron-auth-fail-closed-guard.ts   (npm run test:cron-auth-fail-closed)
 *
 * WAVE 86 (lane 86G) — EVERY CRON_SECRET GATE UNDER app/api FAILS CLOSED.
 * lib/cron-auth.ts names the fail-open classes; this proves none survive.
 *
 *   A "Bearer undefined" — `h !== \`Bearer ${process.env.CRON_SECRET}\`` with the
 *     secret unset compares against the guessable literal "Bearer undefined".
 *   B skip-when-unset — `if (process.env.CRON_SECRET && h !== …)` skips the whole
 *     check when the secret is unset: the endpoint is public.
 *   C unguarded raw compare — `if (x !== process.env.CRON_SECRET)` with no earlier
 *     `if (!secret)` refusal. When `x` can be undefined (an optional-chained
 *     `?.replace(...)`), unset env + no credential is `undefined !== undefined`
 *     → false → PASSES. (app/api/fatigue/calculate did exactly this.)
 *
 *   G1 the helper — verifyCronAuth: unset → 500, missing/wrong → 401, right → null;
 *      x-cron-secret admitted ONLY by explicit opt-in (one spelling, §6).
 *   G2 POSITIVE CONTROL — the three OLD compares, replayed verbatim, PASS an
 *      unset-env request the new gate REFUSES.
 *   G3 each touched route, invoked for real — refuses (500) when CRON_SECRET is
 *      unset, refuses (401) a missing/wrong credential, and a right credential
 *      gets PAST the gate (the handler then fails on its own, un-networked).
 *   G4 census over app/api/** — strip comments AND strings first (a tombstone or a
 *      fixture is not a call site, CLAUDE.md §2); fixture positive controls prove
 *      the finder still sees each shape; negative controls prove a commented /
 *      quoted specimen and the fail-closed idioms are NOT flagged.
 *   G5 one spelling — no route reads `x-cron-secret` itself; the dropped `?secret=`
 *      query credential on fatigue/cron stays dropped.
 *   G6 the fatigue doors (lane 86G2) — every CRON_REGISTRY path resolves to a route
 *      that exports GET (the dispatcher GETs; app/api/fatigue/calculate was
 *      POST-only → 405 every run); no "use client" module reads
 *      process.env.CRON_SECRET (the fatigue dashboard did → always "" → 401); the
 *      duplicate sweep is merged onto ONE core and the dashboard reaches it through
 *      a session door. POSITIVE CONTROLS: a POST-only route and a client module
 *      reading the secret are each flagged by the same finders.
 *
 * BLIND SPOTS (published, §2): the census is lexical. A guard `!secret` anywhere
 * EARLIER in the file counts as guarding a later compare (function scope is not
 * tracked). A secret reached through a helper in another module, or through
 * `process.env["CRON_SECRET"]`, is not an alias the census follows. Scope is
 * app/api/** (the task's population); app/actions and lib are reported, not held.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"
import { blankComments, blankStrings } from "./strip-comments"

// Several routes import `server-only`, which throws outside a Server Component.
// Neutralize it in the require cache BEFORE any route loads (the established
// idiom — scripts/accounting-scopes-simulator.ts).
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* not resolvable — nothing to shim */ }

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(p, "utf8")

const { NextRequest } = await import("next/server")
const cronAuth = await import("../lib/cron-auth")
const { verifyCronAuth, CRON_SECRET_HEADER } = cronAuth

const SECRET = "s3cr3t-86g-" + Math.random().toString(36).slice(2)
const withEnv = async <T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> => {
  const prev = process.env.CRON_SECRET
  if (value === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = value
  try { return await fn() } finally {
    if (prev === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = prev
  }
}
const req = (headers: Record<string, string> = {}, opts: { method?: string; url?: string; body?: string } = {}) =>
  new NextRequest(opts.url ?? "https://example.test/api/x", {
    method: opts.method ?? "GET", headers, ...(opts.body !== undefined ? { body: opts.body } : {}),
  })

// Diagnostic mode: `--census-root=<dir>` runs ONLY the G4 census over <dir>/app/api
// (e.g. a `git archive` of an older commit) and prints what it finds — how a lane
// shows the count MOVED (CLAUDE.md §2). It never holds; the normal run does.
const censusRoot = process.argv.find((a) => a.startsWith("--census-root="))?.slice("--census-root=".length)
if (censusRoot) {
  const files = walk(join(censusRoot, "app/api"))
  const findings = files.flatMap((f) => censusSource(f.slice(censusRoot.length).replace(/^\/+/, ""), read(f)))
  console.log(`[census-only] ${censusRoot}: ${files.length} files under app/api, ${findings.length} finding(s)`)
  for (const f of findings) console.log(`  ${f.file}:${f.line} [${f.shape}] ${f.text}`)
  process.exit(0)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[G1 · the ONE helper — unset → 500, missing/wrong → 401, right → pass]")
{
  const unset = await withEnv(undefined, () => verifyCronAuth(req()))
  check("CRON_SECRET unset → 500 (fail closed)", unset?.status === 500)
  const unsetBU = await withEnv(undefined, () => verifyCronAuth(req({ authorization: "Bearer undefined" })))
  check("CRON_SECRET unset + 'Bearer undefined' → 500", unsetBU?.status === 500)
  const unsetX = await withEnv(undefined, () => verifyCronAuth(req({ [CRON_SECRET_HEADER]: "" }), { acceptCronSecretHeader: true }))
  check("CRON_SECRET unset + empty x-cron-secret (opted in) → 500", unsetX?.status === 500)
  const emptyEnv = await withEnv("", () => verifyCronAuth(req({ authorization: "Bearer " })))
  check("CRON_SECRET empty-string → 500 (empty is unset)", emptyEnv?.status === 500)

  const none = await withEnv(SECRET, () => verifyCronAuth(req()))
  check("secret set, no credential → 401", none?.status === 401)
  const wrong = await withEnv(SECRET, () => verifyCronAuth(req({ authorization: "Bearer nope" })))
  check("secret set, wrong Bearer → 401", wrong?.status === 401)
  const bare = await withEnv(SECRET, () => verifyCronAuth(req({ authorization: SECRET })))
  check("secret set, secret WITHOUT 'Bearer ' → 401", bare?.status === 401)
  const right = await withEnv(SECRET, () => verifyCronAuth(req({ authorization: `Bearer ${SECRET}` })))
  check("secret set, right Bearer → null (pass)", right === null)

  const xNotOpted = await withEnv(SECRET, () => verifyCronAuth(req({ [CRON_SECRET_HEADER]: SECRET })))
  check("x-cron-secret is NOT admitted without the explicit opt-in → 401", xNotOpted?.status === 401)
  const xOpted = await withEnv(SECRET, () => verifyCronAuth(req({ [CRON_SECRET_HEADER]: SECRET }), { acceptCronSecretHeader: true }))
  check("x-cron-secret admitted WITH the opt-in → null", xOpted === null)
  const xWrong = await withEnv(SECRET, () => verifyCronAuth(req({ [CRON_SECRET_HEADER]: "nope" }), { acceptCronSecretHeader: true }))
  check("opted in, wrong x-cron-secret → 401", xWrong?.status === 401)
  const bearerOpted = await withEnv(SECRET, () => verifyCronAuth(req({ authorization: `Bearer ${SECRET}` }), { acceptCronSecretHeader: true }))
  check("opted in, Bearer still admitted → null", bearerOpted === null)
  check("the header name is the ONE spelling 'x-cron-secret'", CRON_SECRET_HEADER === "x-cron-secret")
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[G2 · POSITIVE CONTROL — the old compares pass an unset-env request; the new gate refuses it]")
{
  // Verbatim replays of the three removed gates. `true` = the request got through.
  const oldFatigueCalculate = (r: Request) => {
    const secret = r.headers.get("x-cron-secret") ?? r.headers.get("authorization")?.replace("Bearer ", "")
    return !(secret !== process.env.CRON_SECRET)
  }
  const oldRemotionSkip = (r: Request) => {
    const headerSecret = r.headers.get("authorization")?.replace("Bearer ", "")
    return !(process.env.CRON_SECRET && headerSecret !== process.env.CRON_SECRET)
  }
  const oldBearerTemplate = (r: Request) => !(r.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
  const newGate = (r: Request, x = false) => verifyCronAuth(r, { acceptCronSecretHeader: x }) === null

  await withEnv(undefined, () => {
    const noCred = req()
    check("OLD fatigue/calculate compare PASSES unset env + no headers (undefined !== undefined is false)", oldFatigueCalculate(noCred) === true)
    check("NEW gate REFUSES that same request", newGate(noCred, true) === false)
    check("OLD remotion skip-when-unset PASSES unset env + no headers", oldRemotionSkip(noCred) === true)
    check("NEW gate REFUSES that same request", newGate(noCred) === false)
    const bu = req({ authorization: "Bearer undefined" })
    check("OLD `Bearer ${process.env.CRON_SECRET}` compare PASSES 'Bearer undefined' when unset", oldBearerTemplate(bu) === true)
    check("NEW gate REFUSES that same request", newGate(bu) === false)
  })
  await withEnv(SECRET, () => {
    const good = req({ authorization: `Bearer ${SECRET}` })
    check("control on the control: with the secret set, old AND new both admit the right Bearer",
      oldRemotionSkip(good) && oldBearerTemplate(good) && oldFatigueCalculate(good) && newGate(good))
  })
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[G3 · each touched route, invoked for real]")
{
  // Un-network the handlers: past the gate, every one of them reaches for Supabase
  // (or parses a body) and fails ON ITS OWN — which is how we see it got past.
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) delete process.env[k]

  type Route = { file: string; method: "GET" | "POST"; xHeader: boolean; queryDropped?: boolean }
  const ROUTES: Route[] = [
    // app/api/fatigue/calculate — DELETED (lane 86G2, duplicate sweep); G6 proves it stays gone.
    { file: "app/api/fatigue/cron/route.ts", method: "GET", xHeader: true, queryDropped: true },
    { file: "app/api/internal/remotion/render-just-listed/route.ts", method: "POST", xHeader: false },
    { file: "app/api/internal/remotion/render-newsletter-video/route.ts", method: "POST", xHeader: false },
    { file: "app/api/internal/remotion/render-composition/route.ts", method: "POST", xHeader: false },
    { file: "app/api/deal-health/cron/route.ts", method: "GET", xHeader: false },
    { file: "app/api/admin/scrape-test/route.ts", method: "GET", xHeader: false },
    { file: "app/api/cron/sphere-resonance/route.ts", method: "GET", xHeader: false },
    { file: "app/api/cron/wealth-opportunity-scan/route.ts", method: "GET", xHeader: false },
    { file: "app/api/cron/health-check/route.ts", method: "POST", xHeader: true },
  ]

  type Outcome = { kind: "response"; status: number; error?: string } | { kind: "threw"; message: string } | { kind: "timeout" }
  const invoke = async (handler: (r: any) => Promise<Response>, r: Request): Promise<Outcome> => {
    const run = (async (): Promise<Outcome> => {
      try {
        const res = await handler(r)
        let error: string | undefined
        try { error = ((await res.clone().json()) as { error?: string })?.error } catch { /* non-JSON */ }
        return { kind: "response", status: res.status, error }
      } catch (e) { return { kind: "threw", message: String((e as Error)?.message ?? e) } }
    })()
    const timeout = new Promise<Outcome>((res) => setTimeout(() => res({ kind: "timeout" }), 20_000).unref())
    return Promise.race([run, timeout])
  }
  const isNotConfigured = (o: Outcome) => o.kind === "response" && o.status === 500 && o.error === "Cron secret not configured"
  const isUnauthorized = (o: Outcome) => o.kind === "response" && o.status === 401
  const pastGate = (o: Outcome) => o.kind !== "timeout" && !isUnauthorized(o) && !isNotConfigured(o)
  const show = (o: Outcome) => JSON.stringify(o).slice(0, 160)

  for (const rt of ROUTES) {
    const mod = await import("../" + rt.file)
    const handler = mod[rt.method] as (r: any) => Promise<Response>
    const name = rt.file.replace(/^app\/api\//, "").replace(/\/route\.ts$/, "")
    const mk = (headers: Record<string, string>, url?: string) =>
      req(headers, { method: rt.method, url, ...(rt.method === "POST" ? { body: "{not json" } : {}) })

    const u1 = await withEnv(undefined, () => invoke(handler, mk({})))
    check(`${name}: CRON_SECRET unset, no credential → 500 not-configured`, isNotConfigured(u1), show(u1))
    const u2 = await withEnv(undefined, () => invoke(handler, mk({ authorization: "Bearer undefined", [CRON_SECRET_HEADER]: "undefined" })))
    check(`${name}: CRON_SECRET unset, 'Bearer undefined' / 'undefined' → 500 not-configured`, isNotConfigured(u2), show(u2))

    const m = await withEnv(SECRET, () => invoke(handler, mk({})))
    check(`${name}: credential missing → 401`, isUnauthorized(m), show(m))
    const w = await withEnv(SECRET, () => invoke(handler, mk({ authorization: "Bearer wrong", [CRON_SECRET_HEADER]: "wrong" })))
    check(`${name}: credential wrong → 401`, isUnauthorized(w), show(w))

    const ok = await withEnv(SECRET, () => invoke(handler, mk({ authorization: `Bearer ${SECRET}` })))
    check(`${name}: right Bearer → past the gate`, pastGate(ok), show(ok))
    const x = await withEnv(SECRET, () => invoke(handler, mk({ [CRON_SECRET_HEADER]: SECRET })))
    if (rt.xHeader) check(`${name}: right x-cron-secret (opted in) → past the gate`, pastGate(x), show(x))
    else check(`${name}: x-cron-secret NOT opted in → 401 even when right`, isUnauthorized(x), show(x))
    if (rt.queryDropped) {
      const q = await withEnv(SECRET, () => invoke(handler, mk({}, `https://example.test/api/fatigue/cron?secret=${SECRET}`)))
      check(`${name}: dropped ?secret= query credential → 401 even when right`, isUnauthorized(q), show(q))
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
type Finding = { file: string; line: number; shape: "A:bearer-undefined" | "B:skip-when-unset" | "C:unguarded-raw-compare"; text: string }

/** Census of fail-open CRON_SECRET compares in one module's source. */
function censusSource(file: string, src: string): Finding[] {
  const code = blankComments(src)       // offsets intact, strings intact
  const mask = blankStrings(src)        // offsets intact, string CONTENTS blanked
  const live = (i: number) => mask[i] === code[i] && code[i] !== " "
  const lineOf = (i: number) => code.slice(0, i).split("\n").length
  const out: Finding[] = []
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

  const exprs: string[] = [String.raw`process\.env\.CRON_SECRET\b`]
  const aliasRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*process\.env\.CRON_SECRET\b/g
  for (const m of code.matchAll(aliasRe)) {
    if (live(m.index!)) exprs.push(String.raw`(?<![\w$.])` + esc(m[1]) + String.raw`\b`)
  }
  const seen = new Set<string>()
  const push = (idx: number, shape: Finding["shape"]) => {
    const line = lineOf(idx)
    const key = `${line}:${shape}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ file, line, shape, text: code.split("\n")[line - 1].trim().slice(0, 140) })
  }
  for (const E of exprs) {
    let guardAt = Infinity
    for (const g of code.matchAll(new RegExp(String.raw`!\s*` + E, "g"))) {
      if (live(g.index!)) { guardAt = g.index!; break }
    }
    const shapes: Array<[RegExp, Finding["shape"]]> = [
      [new RegExp(String.raw`[!=]==\s*\`Bearer \$\{\s*` + E + String.raw`\s*\}\``, "g"), "A:bearer-undefined"],
      [new RegExp(String.raw`\`Bearer \$\{\s*` + E + String.raw`\s*\}\`\s*[!=]==`, "g"), "A:bearer-undefined"],
      [new RegExp(String.raw`(?<![!])` + E + String.raw`\s*&&[^;{}]*?!==`, "g"), "B:skip-when-unset"],
      [new RegExp(String.raw`[!=]==\s*` + E + String.raw`(?!\s*[?.\[(])`, "g"), "C:unguarded-raw-compare"],
      [new RegExp(E + String.raw`\s*[!=]==(?!\s*(?:undefined|null)\b)`, "g"), "C:unguarded-raw-compare"],
    ]
    for (const [re, shape] of shapes) {
      for (const m of code.matchAll(re)) {
        const at = m.index!
        // The secret expression itself must be live code (not inside a string or comment).
        const e = new RegExp(E).exec(m[0])
        if (!e || !live(at + e.index)) continue
        if (guardAt < at) continue
        push(at, shape)
      }
    }
  }
  return out.sort((a, b) => a.line - b.line)
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

console.log("\n[G4 · census over stripped app/api/** — fixture controls first]")
{
  const fx = (body: string) => censusSource("fixture.ts", body)
  const A = fx("export async function GET(r: Request) {\n  if (r.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return new Response(null, { status: 401 })\n}\n")
  check("POSITIVE CONTROL A: `!== \\`Bearer ${process.env.CRON_SECRET}\\`` is flagged", A.length === 1 && A[0].shape === "A:bearer-undefined", JSON.stringify(A))
  const A2 = fx("const cronSecret = process.env.CRON_SECRET\nif (auth !== `Bearer ${cronSecret}`) deny()\n")
  check("POSITIVE CONTROL A (alias): `Bearer ${cronSecret}` with no `!cronSecret` refusal is flagged", A2.some((f) => f.shape === "A:bearer-undefined"), JSON.stringify(A2))
  const B = fx("export async function POST(req: Request) {\n  const headerSecret = req.headers.get('authorization')?.replace('Bearer ', '')\n  if (process.env.CRON_SECRET && headerSecret !== process.env.CRON_SECRET) return deny()\n}\n")
  check("POSITIVE CONTROL B: `if (process.env.CRON_SECRET && h !== …)` is flagged", B.some((f) => f.shape === "B:skip-when-unset"), JSON.stringify(B))
  const B2 = fx("const cronSecret = process.env.CRON_SECRET\nif (cronSecret && authHeader !== `Bearer ${cronSecret}`) deny()\n")
  check("POSITIVE CONTROL B (alias): `if (cronSecret && …)` is flagged", B2.some((f) => f.shape === "B:skip-when-unset"), JSON.stringify(B2))
  const C = fx("const secret = req.headers.get('x-cron-secret') ?? req.headers.get('authorization')?.replace('Bearer ', '')\nif (secret !== process.env.CRON_SECRET) deny()\n")
  check("POSITIVE CONTROL C: unguarded `x !== process.env.CRON_SECRET` is flagged", C.some((f) => f.shape === "C:unguarded-raw-compare"), JSON.stringify(C))

  const neg1 = fx("// was: if (auth !== `Bearer ${process.env.CRON_SECRET}`) — TOMBSTONE, survivor lib/cron-auth.ts\n/* if (process.env.CRON_SECRET && h !== process.env.CRON_SECRET) */\nconst denied = verifyCronAuth(req)\n")
  check("NEGATIVE CONTROL: the shapes inside COMMENTS (a tombstone) are not flagged", neg1.length === 0, JSON.stringify(neg1))
  const neg2 = fx("const specimen = \"if (process.env.CRON_SECRET && h !== process.env.CRON_SECRET) deny()\"\nconst s2 = 'x !== process.env.CRON_SECRET'\n")
  check("NEGATIVE CONTROL: the shapes inside STRING literals (fixtures) are not flagged", neg2.length === 0, JSON.stringify(neg2))
  const neg3 = fx("const expected = process.env.CRON_SECRET\nif (!expected) return skip()\nif (auth !== `Bearer ${expected}` && qs !== expected) return deny()\n")
  check("NEGATIVE CONTROL: the guarded idiom (`if (!expected) return …` first) is not flagged", neg3.length === 0, JSON.stringify(neg3))
  const neg4 = fx("const cronSecret = process.env.CRON_SECRET\nconst ok = !!cronSecret && !!given && given === cronSecret\n")
  check("NEGATIVE CONTROL: the admit-positive idiom (`!!secret && x === secret`) is not flagged", neg4.length === 0, JSON.stringify(neg4))

  const files = walk("app/api")
  const findings = files.flatMap((f) => censusSource(f, read(f)))
  const byShape = (s: Finding["shape"]) => findings.filter((f) => f.shape === s).length
  const mentioning = files.filter((f) => /CRON_SECRET|verifyCronAuth/.test(read(f))).length
  console.log(`    denominator: ${files.length} .ts/.tsx files under app/api; ${mentioning} mention CRON_SECRET or verifyCronAuth`)
  console.log(`    found: A=${byShape("A:bearer-undefined")} B=${byShape("B:skip-when-unset")} C=${byShape("C:unguarded-raw-compare")}`)
  for (const f of findings) console.log(`      ${f.file}:${f.line} [${f.shape}] ${f.text}`)
  check("app/api/**: ZERO fail-open CRON_SECRET compares of any shape", findings.length === 0, `${findings.length} found`)

  // Reported, not held — outside the task's population (published blind spot).
  const wider = [...walk("app").filter((f) => !f.startsWith("app/api/")), ...walk("lib")]
  const wf = wider.flatMap((f) => censusSource(f, read(f)))
  console.log(`    (reported, not held) app/** outside api + lib/**: ${wider.length} files, ${wf.length} finding(s)`)
  for (const f of wf) console.log(`      ${f.file}:${f.line} [${f.shape}] ${f.text}`)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[G5 · one spelling — routes do not read x-cron-secret or ?secret= themselves]")
{
  const helper = blankStrings(read("lib/cron-auth.ts"))
  check("lib/cron-auth.ts reads the alternate header through the CRON_SECRET_HEADER constant",
    /headers\.get\(\s*CRON_SECRET_HEADER\s*\)/.test(helper))
  const readers = walk("app/api").filter((f) => /headers\.get\(\s*["'`]x-cron-secret["'`]\s*\)/i.test(blankComments(read(f))))
  check("no app/api route reads `x-cron-secret` itself (opt in via verifyCronAuth instead)", readers.length === 0, readers.join(", "))
  const fcron = blankComments(read("app/api/fatigue/cron/route.ts"))
  check("fatigue/cron no longer reads a `secret` query parameter", !/searchParams\.get\(\s*["']secret["']\s*\)/.test(fcron))
  check("positive control: that finder sees the dropped read in a specimen",
    /searchParams\.get\(\s*["']secret["']\s*\)/.test(`const s = req.nextUrl.searchParams.get("secret")`))
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
  check("registered: test:cron-auth-fail-closed", pkg.scripts["test:cron-auth-fail-closed"] === "tsx scripts/cron-auth-fail-closed-guard.ts")
  check("chained after test:scrapers in the guard chain",
    Object.values(pkg.scripts).some((s) => /npm run test:scrapers && [^"]*npm run test:cron-auth-fail-closed/.test(s)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[G6 · the fatigue doors — every dispatched path answers GET; no secret in a client module]")
{
  const exportsGet = (src: string) =>
    /export\s+(?:async\s+)?function\s+GET\b|export\s+const\s+GET\b|export\s*\{[^}]*\bGET\b[^}]*\}/.test(blankStrings(src))
  check("POSITIVE CONTROL: a POST-only route is flagged as not answering GET",
    !exportsGet(`export async function POST(req: Request) { return new Response() }\n// export async function GET() {}\nconst s = "export async function GET"`))
  check("...and a GET route (function, const alias, re-export) is recognised",
    exportsGet("export async function GET(r: Request) {}") && exportsGet("export const GET = POST") && exportsGet("export { handler as GET }"))

  const { CRON_REGISTRY } = await import("../lib/kernel/cron-dispatch")
  const routeFor = (p: string) => `app${p.split("?")[0]}/route.ts`
  const missing: string[] = [], noGet: string[] = []
  for (const e of CRON_REGISTRY) {
    const f = routeFor(e.path)
    let src: string
    try { src = read(f) } catch { missing.push(e.path); continue }
    if (!exportsGet(src)) noGet.push(e.path)
  }
  console.log(`    denominator: ${CRON_REGISTRY.length} registry entries (query strings stripped to the route file)`)
  check("every CRON_REGISTRY path has a route file", missing.length === 0, missing.join(", "))
  check("every CRON_REGISTRY path's route exports GET — the dispatcher's method (no 405 by construction)",
    noGet.length === 0, noGet.join(", "))
  check("the dispatcher still GETs (realFetcher passes no method) — the rule above is the right rule",
    /fetch\(\s*url\s*,\s*\{\s*headers\s*,/.test(blankStrings(read("lib/kernel/cron-dispatch.ts"))))

  // No client module may read the secret: Next inlines only NEXT_PUBLIC_*, so it is
  // always undefined in the browser (a dead credential) — and if it ever were
  // exposed, it would be the platform's cron key in every visitor's bundle.
  // Leading comments blanked by the ONE scanner, then the directive must be first.
  const isClient = (src: string) => /^\s*["']use client["']/.test(blankComments(src))
  const readsSecret = (src: string) => {
    const code = blankComments(src), mask = blankStrings(src)
    for (const m of code.matchAll(/process\.env\.CRON_SECRET\b/g)) if (mask[m.index!] === code[m.index!]) return true
    return false
  }
  const clientFixture = `"use client"\nexport function B() { fetch("/x", { headers: { "x-cron-secret": process.env.CRON_SECRET ?? "" } }) }\n`
  check("POSITIVE CONTROL: a \"use client\" module reading process.env.CRON_SECRET is flagged",
    isClient(clientFixture) && readsSecret(clientFixture))
  check("...and a mention in a comment or string is NOT (a tombstone is not a read)",
    !readsSecret(`"use client"\n// was process.env.CRON_SECRET\nconst s = "process.env.CRON_SECRET"\n`))
  const clientFiles = ["app", "components", "lib"].flatMap((d) => { try { return walk(d) } catch { return [] } })
    .filter((f) => isClient(read(f)))
  const leaking = clientFiles.filter((f) => readsSecret(read(f)))
  console.log(`    denominator: ${clientFiles.length} "use client" modules under app/ components/ lib/`)
  check("no \"use client\" module reads process.env.CRON_SECRET", leaking.length === 0, leaking.join(", "))

  // The duplicate sweep is merged onto ONE core (CLAUDE.md §1) and stays merged.
  let calculateGone = false
  try { read("app/api/fatigue/calculate/route.ts") } catch { calculateGone = true }
  check("app/api/fatigue/calculate is gone (duplicate sweep, merged)", calculateGone)
  check("...and is not in CRON_REGISTRY", !CRON_REGISTRY.some((e) => e.path.startsWith("/api/fatigue/calculate")))
  check("the one scheduled sweep /api/fatigue/cron is still registered", CRON_REGISTRY.some((e) => e.path === "/api/fatigue/cron"))

  const core = blankStrings(read("lib/fatigue/fatigue-calculator.ts"))
  const sweepAt = core.indexOf("export async function calculateAllBuyerFatigue(")
  const sweep = sweepAt >= 0 ? core.slice(sweepAt) : ""
  check("the core takes a declared TenantScope and applies it", /calculateAllBuyerFatigue\(\s*scope:\s*TenantScope\s*\)/.test(sweep) && /applyTenantScope\(/.test(sweep))
  check("the core reads its refusal (§3) and throws rather than reading as 'no buyers'", /\{\s*data:\s*contacts\s*,\s*error\s*\}/.test(sweep) && /if\s*\(\s*error\s*\)\s*\{\s*throw/.test(sweep))
  check("the core carries the cron loop's recovery plan for high/critical", /generateRecoveryPlan\(\s*scored\s*\)/.test(sweep))
  check("the core uses the ONE active-buyer ladder, excludes soft-deleted and tenantless rows",
    /\.in\(\s*"\s*"\s*,\s*ACTIVE_BUYER_STAGES\s*\)/.test(sweep) && /\.is\(\s*"\s*"\s*,\s*null\s*\)/.test(sweep) && /\.not\(/.test(sweep))

  const cronSrc = blankStrings(read("app/api/fatigue/cron/route.ts"))
  check("fatigue/cron runs the core with a platformScope(reason) after the gate",
    /verifyCronAuth\(/.test(cronSrc) && /calculateAllBuyerFatigue\(\s*platformScope\(/.test(cronSrc)
      && cronSrc.indexOf("verifyCronAuth(") < cronSrc.indexOf("calculateAllBuyerFatigue("))
  check("fatigue/cron no longer inlines a second loop or a second 'terminal stages' spelling",
    !/calculateFatigue\(/.test(cronSrc) && !/TERMINAL_STAGES/.test(cronSrc))

  const action = blankStrings(read("app/actions/buyer-fatigue.ts"))
  const door = action.slice(action.indexOf("export async function recalculateBrokerageFatigue("))
  const doorBody = door.slice(0, door.indexOf("\n}\n") + 2)
  check("the session door exists, is async, and takes NO parameter (tenant never from the caller)",
    /export async function recalculateBrokerageFatigue\(\s*\)/.test(action))
  check("the door gates FIRST (requireTenantAdminOrSoloOwner) and refuses on !ok",
    /requireTenantAdminOrSoloOwner\(\)/.test(doorBody) && /if\s*\(\s*!auth\.ok\s*\)\s*return/.test(doorBody)
      && doorBody.indexOf("requireTenantAdminOrSoloOwner(") < doorBody.indexOf("calculateAllBuyerFatigue("))
  check("the door scopes the core to the SESSION brokerage", /calculateAllBuyerFatigue\(\s*tenantScope\(\s*auth\.brokerageId/.test(doorBody))
  check("the door returns the counted result", /return\s*\{\s*success:\s*true\s*,\s*data\s*\}/.test(doorBody))

  const page = read("app/dashboard/buyers/fatigue/page.tsx")
  const pageCode = blankStrings(page)
  check("the dashboard button calls the session door", /await\s+recalculateBrokerageFatigue\(\s*\)/.test(pageCode))
  check("the dashboard sends no cron secret and no client-chosen brokerageId",
    !readsSecret(page) && !/DEMO_BROKERAGE_ID/.test(pageCode) && !/fetch\(/.test(pageCode))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) {
  console.log("FAILURES:\n  " + failures.join("\n  "))
  process.exit(1)
}
process.exit(0)
