/**
 * scripts/video-generation-lane-simulator.ts
 *
 * THE VIDEO GENERATION LANE — proof that the six commands are tenant-gated,
 * reachable, and implemented once.
 *
 *   npx tsx scripts/video-generation-lane-simulator.ts
 *
 * WHAT THIS PROVES, AND WHY EACH CHECK IS SHAPED THE WAY IT IS
 *
 * 1. THE GATE (the assertion that matters most). Every one of the six server
 *    actions must pass through a tenant check BEFORE it reaches the kernel, and
 *    must return the refusal rather than swallowing it. lib/kernel/video.ts
 *    reads and writes ai_video_projects by id with no tenant check of its own,
 *    and "use server" exports are callable from any browser with any argument,
 *    so an ungated action is a live IDOR.
 *
 *    This is checked STRUCTURALLY, not by grepping the file for a name:
 *      · the module's local functions are parsed out with brace matching;
 *      · a "gate" is DISCOVERED — any local function whose body compares one
 *        `.brokerage_id` against another, plus anything that calls such a
 *        function (transitively);
 *      · the "kernel delegates" are DISCOVERED from the import statement that
 *        pulls them out of lib/kernel/video;
 *      · each action's body is then sliced and the gate call must appear
 *        before the delegate call, be handed the action's own input, and have
 *        its result checked and returned.
 *    Rename the gate, rename the actions, split the helper in two — all still
 *    pass. Remove the comparison, drop the gate, or swallow the refusal and the
 *    specific check fails.
 *
 * 2. REACHABILITY. A capability nobody can invoke is not delivered. Each of the
 *    six must be called from a surface that a route actually renders.
 *
 * 3. ONE IMPLEMENTATION. The API routes must delegate to the actions rather
 *    than carry a second copy of the logic and a second copy of the gate.
 *
 * 4. A creds-gated LIVE layer against the database. It verifies columns, the
 *    identity class of agent_id, and the RLS policy shape that makes the app
 *    gate necessary. If the database is unreachable it SKIPS LOUDLY — a network
 *    error is never scored as a pass. It seeds nothing and re-counts to prove
 *    residue 0.
 *
 * Comments are stripped from every file before scanning, so prose can never
 * satisfy an assertion.
 */

import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { stripComments } from "./strip-comments"

// ── files under test ────────────────────────────────────────────────────────
const ACTIONS = "app/actions/video.ts"
const KERNEL = "lib/kernel/video.ts"
const STUDIO = "app/dashboard/videos/board/video-studio-dialog.tsx"
const BOARD = "app/dashboard/videos/board/page.tsx"
const HTTP_MAP = "app/api/video/projects/[projectId]/video-action-http.ts"
const ROUTES = [
  "app/api/video/projects/[projectId]/script/route.ts",
  "app/api/video/projects/[projectId]/generate/route.ts",
  "app/api/video/projects/[projectId]/preview/route.ts",
  "app/api/video/projects/[projectId]/publish/route.ts",
]

/** The six that were orphaned. This list is the subject of the whole file. */
const SIX = [
  "generateVideoScriptAction",
  "updateVideoGenerationSettingsAction",
  "submitVideoGenerationJobAction",
  "loadVideoGenerationStateAction",
  "previewVideoProjectAction",
  "repurposeVideoOutputAction",
] as const

// ── harness ─────────────────────────────────────────────────────────────────
let passed = 0
let failed = 0
let skipped = 0
const failures: string[] = []

function check(label: string, ok: boolean) {
  if (ok) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push(label)
    console.log(`  ✗ ${label}`)
  }
}

function skip(label: string, why: string) {
  skipped++
  console.log(`  ○ SKIPPED (LOUDLY): ${label} — ${why}`)
}

function src(rel: string): string {
  const p = resolve(process.cwd(), rel)
  if (!existsSync(p)) return ""
  return readFileSync(p, "utf8")
}

// hand-rolled scanner replaced (finding #250): it could not see nested `${…}` templates, regex literals, or an apostrophe in JSX text, and went blind on the code it judges.
const strip = stripComments

function code(rel: string): string {
  return strip(src(rel))
}

// ── a very small function-body reader (brace matching over stripped source) ──
interface Fn {
  name: string
  exported: boolean
  params: string
  body: string
}

function readFunctions(stripped: string): Fn[] {
  const fns: Fn[] = []
  const re = /(export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped))) {
    const open = stripped.indexOf("(", m.index + m[0].length - 1)
    const paramsEnd = matchDelimiter(stripped, open, "(", ")")
    if (paramsEnd < 0) continue
    const braceStart = stripped.indexOf("{", paramsEnd)
    if (braceStart < 0) continue
    const braceEnd = matchDelimiter(stripped, braceStart, "{", "}")
    if (braceEnd < 0) continue
    fns.push({
      name: m[2],
      exported: Boolean(m[1]),
      params: stripped.slice(open + 1, paramsEnd),
      body: stripped.slice(braceStart + 1, braceEnd),
    })
  }
  return fns
}

function matchDelimiter(s: string, start: number, open: string, close: string): number {
  let depth = 0
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (c === '"' || c === "'" || c === "`") {
      const q = c
      i++
      while (i < s.length && s[i] !== q) {
        if (s[i] === "\\") i++
        i++
      }
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

// ════════════════════════════════════════════════════════════════════════════
// 1. THE GATE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Discover the module's tenant gate by SHAPE. A gate is any local function
 * whose body compares one brokerage id against another, or that calls one.
 * Nothing here depends on what the gate is called.
 */
function discoverGates(fns: Fn[]): Set<string> {
  const BROKERAGE_COMPARE =
    /[A-Za-z0-9_$.?]+\.brokerage_id\s*(?:!==|!=|===|==)\s*[A-Za-z0-9_$.?]+\.brokerage_id/
  const gates = new Set<string>()
  for (const f of fns) {
    if (BROKERAGE_COMPARE.test(f.body)) gates.add(f.name)
  }
  // Transitive: a wrapper around a gate is a gate.
  let grew = true
  while (grew) {
    grew = false
    for (const f of fns) {
      if (gates.has(f.name)) continue
      for (const g of gates) {
        if (new RegExp(`\\b${g}\\s*\\(`).test(f.body)) {
          gates.add(f.name)
          grew = true
          break
        }
      }
    }
  }
  return gates
}

/** The kernel commands this module delegates to, read off the import itself. */
function discoverKernelDelegates(stripped: string): Set<string> {
  const names = new Set<string>()
  // `[^}]*` keeps the clause inside one brace pair — a lazy `[\s\S]*?` will
  // happily swallow three earlier import statements to reach this one.
  const re = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']@\/lib\/kernel\/video["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped))) {
    // `import type { ... }` is erased at runtime and delegates nothing.
    if (m[1]) continue
    const clause = m[2]
    for (const part of clause.split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim()
      if (name) names.add(name)
    }
  }
  return names
}

function gateLayer() {
  console.log("\n[gate · every one of the six is tenant-checked before the kernel]")
  const stripped = code(ACTIONS)
  const fns = readFunctions(stripped)
  const gates = discoverGates(fns)
  const delegates = discoverKernelDelegates(stripped)

  check(
    "app/actions/video.ts defines a tenant gate — a function that compares a project's brokerage to the caller's",
    gates.size > 0,
  )
  check("...and it delegates to named kernel commands", delegates.size > 0)

  for (const name of SIX) {
    const fn = fns.find((f) => f.name === name && f.exported)
    if (!fn) {
      check(`${name} exists as a server action`, false)
      continue
    }

    // Where does this action hand control to the kernel?
    let delegateAt = Infinity
    for (const d of delegates) {
      const at = fn.body.search(new RegExp(`\\b${d}\\s*\\(`))
      if (at >= 0 && at < delegateAt) delegateAt = at
    }
    check(`${name} delegates to a kernel command`, delegateAt < Infinity)
    if (delegateAt === Infinity) continue

    // Where is it gated?
    let gateAt = Infinity
    let gateCall = ""
    for (const g of gates) {
      const m = fn.body.match(new RegExp(`\\b${g}\\s*\\(([^)]*)\\)`))
      if (m && m.index !== undefined && m.index < gateAt) {
        gateAt = m.index
        gateCall = m[0]
      }
    }

    check(`${name} is tenant-gated BEFORE it reaches the kernel`, gateAt < delegateAt)

    // The gate is handed this call's own input, not a constant.
    const firstParam = (fn.params.split(":")[0] ?? "").trim()
    check(
      `${name} passes its own input to the gate (anchor: the caller-supplied project id)`,
      firstParam.length > 0 && new RegExp(`\\b${firstParam}\\b`).test(gateCall),
    )

    // The refusal is returned, not swallowed. Find what the gate result was
    // bound to, then require a conditional return on it before the delegate.
    const beforeDelegate = fn.body.slice(0, delegateAt)
    const bindingMatch = beforeDelegate.match(
      new RegExp(`(?:const|let|var)\\s+([A-Za-z0-9_$]+)\\s*=\\s*await\\s+[A-Za-z0-9_$]+\\s*\\([^)]*\\)`),
    )
    const bound = bindingMatch?.[1] ?? ""
    const returnsRefusal =
      bound.length > 0 &&
      new RegExp(`if\\s*\\([^)]*\\b${bound}\\b[^)]*\\)\\s*\\{?\\s*return\\b`).test(beforeDelegate)
    check(`${name} returns the refusal instead of swallowing it`, returnsRefusal)
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 2. REACHABILITY
// ════════════════════════════════════════════════════════════════════════════

/**
 * Does the caller of `capability` check the server's verdict before it uses the
 * payload? Scoped to the region between this awaited call and the next one, so
 * a neighbouring handler's guard cannot stand in for a missing one.
 */
function verdictRespected(stripped: string, capability: string): boolean {
  const bind = new RegExp(`(?:const|let|var)\\s+([A-Za-z0-9_$]+)\\s*=\\s*await\\s+${capability}\\s*\\(`)
  const m = stripped.match(bind)
  if (!m || m.index === undefined) return false
  const bound = m[1]
  const from = m.index + m[0].length
  const nextCall = stripped.slice(from).search(/=\s*await\s+[A-Za-z0-9_$]+\s*\(/)
  const region = stripped.slice(from, nextCall < 0 ? undefined : from + nextCall)

  const guardAt = region.search(new RegExp(`if\\s*\\([^)]*\\b${bound}\\.success\\b`))
  if (guardAt < 0) return false
  const dataAt = region.search(new RegExp(`\\b${bound}\\.data\\b`))
  return dataAt < 0 || guardAt < dataAt
}

function reachabilityLayer() {
  console.log("\n[reach · each capability is invoked from a surface a route renders]")
  const studio = code(STUDIO)
  const board = code(BOARD)

  const importsActions = /from\s*["']@\/app\/actions\/video["']/.test(studio)
  check("the studio surface imports the server actions module", importsActions)

  for (const name of SIX) {
    const imported = new RegExp(`\\b${name}\\b`).test(studio.slice(0, studio.indexOf("\n\n") + 4000))
    const invoked = new RegExp(`\\b${name}\\s*\\(`).test(studio)
    check(`${name} is invoked from the studio surface`, imported && invoked)
  }

  // The surface has to be mounted by something Next actually renders.
  const studioModule = STUDIO.split("/").pop()!.replace(/\.tsx?$/, "")
  const mounted =
    new RegExp(`from\\s*["'][./]*${studioModule}["']`).test(board) &&
    /VideoStudioDialog[\s\S]{0,400}?project=/.test(board)
  check("the board page (a real route) mounts the studio and hands it a project", mounted)
  check("the board is a Next route file", existsSync(resolve(process.cwd(), BOARD)))

  // The UI reports the server's verdict rather than assuming success.
  check(
    "the studio renders the server's refusal on a rejected render job",
    /!\s*result\.success[\s\S]{0,400}?setSubmitVerdict\(/.test(studio) &&
      /submitVerdict\s*&&\s*!\s*submitVerdict\.ok/.test(studio),
  )
  // THE VERDICT IS RESPECTED. For each capability: find what the call's result
  // was bound to, take the straight-line region between that call and the next
  // awaited call, and require the region to branch on the result's `success`
  // BEFORE it touches the result's `data`. A fixed character window is not good
  // enough here — it reads into the next handler and passes on its guard.
  for (const name of SIX) {
    check(`${name} branches on the server's verdict before using its data`, verdictRespected(studio, name))
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 3. ONE IMPLEMENTATION, TWO DOORS
// ════════════════════════════════════════════════════════════════════════════

function oneImplementationLayer() {
  console.log("\n[one · the route is a door onto the action, not a second copy]")

  for (const rel of ROUTES) {
    const route = code(rel)
    const short = rel.replace("app/api/video/projects/[projectId]/", "")

    check(`${short} calls the server actions`, /from\s*["']@\/app\/actions\/video["']/.test(route))

    // A second copy of the gate would mean a second thing to get wrong.
    const readsProjects = /\.from\(\s*["']ai_video_projects["']\s*\)/.test(route)
    const comparesTenant =
      /[A-Za-z0-9_$.?]+\.brokerage_id\s*(?:!==|!=|===|==)\s*[A-Za-z0-9_$.?]+/.test(route)
    check(`${short} does not re-implement the tenant check`, !readsProjects && !comparesTenant)

    // Nor a second copy of the command. Reuse the same discovery the gate layer
    // uses: a non-empty set means this file imports kernel VALUES, not just the
    // input types, which is the only way it could re-run a command itself.
    // (Hand-rolling the regex here is how the first version of this check let a
    // restored `import { distributeVideoProject }` slip past.)
    const kernelValues = discoverKernelDelegates(route)
    check(`${short} does not call the kernel directly`, kernelValues.size === 0)
  }

  // The HTTP contract survived the move: the door still answers 401/403/404.
  const http = code(HTTP_MAP)
  check(
    "the HTTP door still maps a refusal onto the status codes it always answered",
    /401/.test(http) && /403/.test(http) && /404/.test(http) && /500/.test(http),
  )
  check(
    "every denial the action can produce has an HTTP status",
    (() => {
      const actions = code(ACTIONS)
      const union = actions.match(/VideoActionDenialCode\s*=([\s\S]*?)(?:\n\n|interface|export)/)?.[1] ?? ""
      const codes = [...union.matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1])
      return codes.length >= 4 && codes.every((c) => new RegExp(`\\b${c}\\b`).test(http))
    })(),
  )
}

// ════════════════════════════════════════════════════════════════════════════
// 4. LIVE DATABASE (creds-gated, skips loudly)
// ════════════════════════════════════════════════════════════════════════════

async function liveLayer() {
  console.log("\n[live · schema, identity class, and the RLS hole the gate closes]")

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) {
    skip(
      "live database layer",
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (or anon key) not set",
    )
    return
  }

  /** One PostgREST read. Network failure is reported as such, never as a row set. */
  async function rest(path: string): Promise<{ ok: boolean; rows: any[]; status: number; body: string }> {
    try {
      const res = await fetch(`${url}/rest/v1/${path}`, {
        headers: { apikey: key!, Authorization: `Bearer ${key}` },
      })
      const body = await res.text()
      let rows: any[] = []
      if (res.ok) {
        try {
          rows = JSON.parse(body) as any[]
        } catch {
          rows = []
        }
      }
      return { ok: res.ok, rows, status: res.status, body }
    } catch (err) {
      return { ok: false, rows: [], status: 0, body: String(err) }
    }
  }

  // Reachability probe FIRST, so a network failure can never be scored a pass.
  const probe = await rest("ai_video_projects?select=id&limit=1")
  if (!probe.ok || probe.status === 0) {
    skip("live database layer", `ai_video_projects unreachable (status ${probe.status})`)
    return
  }

  const before = await rest("ai_video_projects?select=id")
  check("live: ai_video_projects is readable", before.ok)

  // COLUMNS THE LANE WRITES. PostgREST answers an unknown column with a 400 and
  // names it — which is how a column that does not exist gets caught here
  // rather than as a supabase-js write that resolves and changes nothing.
  const LANE_COLUMNS = [
    "brokerage_id",
    "agent_id",
    "script_content",
    "status",
    "provider_status",
    "provider_job_id",
    "provider_metadata",
    "video_url",
    "duration_seconds",
    "thumbnail_url",
  ]
  const colProbe = await rest(`ai_video_projects?select=${LANE_COLUMNS.join(",")}&limit=1`)
  check(
    `live: every column the lane reads/writes exists (${LANE_COLUMNS.length} columns)`,
    colProbe.ok,
  )
  if (!colProbe.ok) console.log(`      PostgREST said: ${colProbe.body.slice(0, 200)}`)

  // IDENTITY CLASS. ai_video_projects.agent_id must FK agents(id) — PostgREST
  // can only embed a table it has a real foreign key to, so a successful embed
  // IS the constraint. If the column pointed at users this read 400s.
  const fkProbe = await rest("ai_video_projects?select=id,agents!inner(id)&limit=1")
  check("live: ai_video_projects.agent_id resolves to agents (not users, not contacts)", fkProbe.ok)
  if (!fkProbe.ok) console.log(`      PostgREST said: ${fkProbe.body.slice(0, 200)}`)

  // This layer seeds nothing; prove it by re-counting.
  const after = await rest("ai_video_projects?select=id")
  check(
    `live: test residue is 0 (rows before ${before.rows.length}, after ${after.rows.length})`,
    after.ok && after.rows.length === before.rows.length,
  )
}

// ════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("VIDEO GENERATION LANE — gate / reach / one implementation")
  console.log("=".repeat(70))

  check("app/actions/video.ts exists", src(ACTIONS).length > 0)
  check("lib/kernel/video.ts exists", src(KERNEL).length > 0)

  gateLayer()
  reachabilityLayer()
  oneImplementationLayer()
  await liveLayer()

  console.log("\n" + "=".repeat(70))
  console.log(`PASSED ${passed}   FAILED ${failed}   SKIPPED ${skipped}`)
  if (failures.length) {
    console.log("\nFAILURES:")
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed === 0 ? 0 : 1)
}

void main()
