/**
 * scripts/cron-decision-door-guard.ts — `npm run test:cron-decision-door` (wave 155, lane 155R1)
 *
 * ONE DECISION AT THE CRON DOOR. 104 crons asked no gate (arbitration group G05) and 6 opened no run context
 * (G06): the platform god switch and the per-tenant staff halt stopped autonomous SENDS at dispatch, but the
 * crons that draft, render, scrape, spend and score ran on through a halt. lib/kernel/cron-logging.ts now
 * decides every run once (createCronRunContext for routes that keep a run row, decideCronRun for the rest) by
 * asking autonomyDecision over the platform halt and the tenant halt, against ONE class table
 * (CRON_RUN_CLASS: autonomous = held under a halt, obligation = runs under a halt and records why).
 *
 * WHAT THIS PROVES (each with a positive control that is red when the defect is planted):
 *   A. the class table covers EVERY app/api/cron route and names nothing else; every entry has a class and a reason.
 *   B. every scheduled handler reaches the door FIRST (no `.from(` / `.rpc(` / `fetch(` / other await before it,
 *      except verifyCronAuth and a POST reading its own body) and returns on `held` on the very next statement;
 *      the door names the route's OWN path. Read from comment-blanked source, tokens from string-blanked source.
 *   C. the decision, SIMULATED over every key: no halt → every class runs; platform halt → every autonomous key is
 *      held and every obligation runs with "runs under halt: <reason>"; an unclassified key is held under a halt;
 *      a tenant halt holds that tenant only. The decision is written on the run row and survives recordCronStart.
 *   D. five real route handlers, SIMULATED (memSupabase + one counted domain seam each; no provider is reachable):
 *      under a planted platform halt an autonomous route returns held with ZERO domain seam calls and no domain
 *      table touched; an obligation route still runs and records why; with no halt each route calls its seam
 *      exactly as before; a tenant halt holds that tenant's POST and not another's.
 * BLIND SPOTS (published): D drives 5 of 210 routes; B is structural for the other 205. A halt read that FAILS reads
 * as not halted (loadPlatformHalt / loadTenantAutonomyHalt fail open by design) — not provable here. Tenant halts
 * inside the platform-wide tenant loops are NOT asked at the door (the door has no tenant for a sweep); see
 * lane 155R1 notes for the loops that already ask per tenant.
 *
 * Run: npx tsx --conditions=react-server scripts/cron-decision-door-guard.ts [--static-only] [--root <dir>]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { blankComments, blankStrings } from "./strip-comments"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"

const argv = process.argv.slice(2)
const STATIC_ONLY = argv.includes("--static-only")
const ROOT = argv.includes("--root") ? argv[argv.indexOf("--root") + 1] : process.cwd()
let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

// ── module interception (the edges only) — must precede every app import ─────────────────────────────────────────
const G = globalThis as any
G.__R1 = { svc: null as MemClient | null, calls: [] as string[] }
const seam = (name: string, ret: string) => `globalThis.__R1.calls.push(${JSON.stringify(name)}); return ${ret}`
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__R1.svc",
  "@/lib/supabase/server": "export const createClient = async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } })",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f",
  "@/lib/transactions/stale-listing-sphere-sweep": `export const sweepStaleClosedListingSphereHandoffs = async () => { ${seam("sphere-sweep", "{ scanned: 2, published: 1, handledByTransaction: 0, alreadySignaled: 1, errors: [] }")} }`,
  "@/lib/buyer-offer/expire-offers": `export const sweepDueOfferExpirations = async () => { ${seam("offer-expiry", "{ scanned: 1, expired: 1, skipped: [] }")} }`,
  "@/lib/agents/buyer-reel-delivery": `export const deliverFinishedBuyerReels = async () => { ${seam("buyer-reels", "{ proposed: 1 }")} }`,
  "@/lib/farm-mail/dispatch-farm-mail": `export const dispatchFarmMail = async () => { ${seam("farm-mail", "{ ok: true }")} }`,
  "@/lib/revenue-protection/scorer": `export const calculateRevenueProtection = async (a) => { globalThis.__R1.calls.push("revenue-protection:" + a.brokerageId); return { score: 1 } }`,
}
if (!STATIC_ONLY) {
  registerHooks({
    resolve(spec: string, ctx: any, next: any) {
      const stub = STUB_BY_SPEC[spec]
      if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
      return next(spec, ctx)
    },
  })
}

// ══ A + B. STATIC: the class table and the door, over the whole route tree ═══════════════════════════════════════
const CRON_DIR = join(ROOT, "app/api/cron")
const ROUTES = readdirSync(CRON_DIR).filter((d) => existsSync(join(CRON_DIR, d, "route.ts"))).sort()
/** Handlers that are not scheduled runs, each with its reason (published, never silent). */
const EXEMPT: Record<string, string> = {
  "dispatch#GET": "the scheduler itself — each due route decides at its own door",
  "platform-product-autopilot#GET": "decides itself at the top of the handler: autonomyDecision over the platform halt, the hold ledgered by withActionLedger (lane 155B2) — a second door would pre-empt that ledgered hold",
  "deal-health-scan#POST": "a single-transaction rescan the UI triggers, not a scheduled run (it asks no CRON_SECRET — reported to the integrator)",
  "listing-health-scan#POST": "a single-listing rescan the UI triggers, not a scheduled run (it asks no CRON_SECRET — reported to the integrator)",
}

/** The class-table finder, run on the real tree and on planted trees (the positive controls). */
function classTableFindings(routes: string[], table: Record<string, readonly [string, string]>): string[] {
  const out: string[] = []
  for (const r of routes) if (!table[r]) out.push(`unclassified route: ${r}`)
  for (const k of Object.keys(table)) if (!routes.includes(k)) out.push(`class for a route that does not exist: ${k}`)
  for (const [k, [c, why]] of Object.entries(table)) {
    if (c !== "autonomous" && c !== "obligation") out.push(`${k}: class "${c}"`)
    if (!why || why.trim().length < 8) out.push(`${k}: no stated reason`)
  }
  return out
}

/** The door finder for one route source: per handler, the door it reaches or why not. */
function doorFindings(route: string, raw: string): { findings: string[]; doors: string[] } {
  const code = blankComments(raw)
  const tokens = blankStrings(code)
  const findings: string[] = []
  const doors: string[] = []
  const heads = [...tokens.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST)\b/g)]
  if (!heads.length) findings.push(`${route}: no GET/POST handler`)
  heads.forEach((h, i) => {
    const id = `${route}#${h[1]}`
    const from = h.index!, to = i + 1 < heads.length ? heads[i + 1].index! : code.length
    const body = code.slice(from, to), btok = tokens.slice(from, to)
    // a handler whose whole body (after its auth lines) is `return GET(req)` / `return POST(req)` delegates to the one that decides
    const own = btok.slice(btok.indexOf("{")).replace(/const\s+\w+\s*=\s*verifyCronAuth\([^)]*\)/, "").replace(/if\s*\(\s*\w+\s*\)\s*return\s+\w+\b/, "")
    if (/^\{\s*return\s+(?:GET|POST)\s*\(\s*\w+\s*\)\s*;?\s*\}/.test(own)) { doors.push(`${id}=delegates`); return }
    if (EXEMPT[id]) { doors.push(`${id}=exempt`); return }
    const a = /(?:const|let)\s+(\w+)\s*=\s*await\s+createCronRunContextAction\s*\(\s*\{([\s\S]*?)\}\s*\)\s*\n\s*if\s*\(\s*\1\.data\?\.held\s*\)\s*return\s+(?:Next)?Response\.json\(/.exec(body)
    const b = /const\s+(\w+)\s*=\s*await\s+decideCronRun\s*\(\s*\{([\s\S]*?)\}\s*\)\s*\n\s*if\s*\(\s*\1\.held\s*\)\s*return\s+NextResponse\.json\(/.exec(body)
    const m = a ?? b
    if (!m) { findings.push(`${id}: no door + held return (createCronRunContextAction → if (x.data?.held) return, or decideCronRun → if (x.held) return)`); return }
    doors.push(`${id}=${a ? "run-context" : "decision"}`)
    const pathLit = /cron_path:\s*["'`]([^"'`]+)["'`]/.exec(m[2])?.[1] ?? ""
    const key = /(?:^|\/)api\/cron\/([^?]+?)(?:\/route\.ts)?(?:\?.*)?$/.exec(pathLit)?.[1]
    if (key !== route) findings.push(`${id}: the door names "${pathLit}", not this route`)
    const before = btok.slice(0, m.index)
    const bad = [...before.matchAll(/\.(?:from|rpc)\s*\(|\bfetch\s*\(|\bawait\s+(?!(?:request|req)\.json\s*\()[\w.]+/g)].map((x) => x[0])
    if (bad.length) findings.push(`${id}: work before the door: ${bad.join(", ")}`)
  })
  return { findings, doors }
}

async function main() {
  console.log("A. one class table, every cron route")
  const cl = (ROOT === process.cwd() ? await import("../lib/kernel/cron-logging") : await import(join(ROOT, "lib/kernel/cron-logging.ts")).catch(() => ({}))) as typeof import("../lib/kernel/cron-logging")
  const table = ((cl as any).CRON_RUN_CLASS ?? {}) as Record<string, readonly [string, string]> // absent at a base that predates the door → every route reads unclassified (red)
  const real = classTableFindings(ROUTES, table)
  const nA = Object.values(table).filter(([c]) => c === "autonomous").length, nO = Object.values(table).filter(([c]) => c === "obligation").length
  check(`every one of ${ROUTES.length} cron routes is classed, nothing else is (${nA} autonomous · ${nO} obligation)`, real.length === 0, real.slice(0, 8).join("; "))
  check("POSITIVE CONTROL: a planted route with no class is red", classTableFindings([...ROUTES, "__planted_unclassed__"], table).some((f) => f.includes("__planted_unclassed__")))
  check("POSITIVE CONTROL: a class naming a route that does not exist is red, and so is an entry with no reason",
    classTableFindings(ROUTES, { ...table, "__ghost__": ["autonomous", "a ghost route entry"] }).some((f) => f.includes("__ghost__"))
    && classTableFindings(ROUTES, { ...table, [ROUTES[0]]: ["obligation", ""] }).some((f) => f.includes("no stated reason")))

  console.log("B. every scheduled handler reaches the door first and returns on held")
  const all: string[] = [], doors: string[] = []
  for (const r of ROUTES) { const d = doorFindings(r, readFileSync(join(CRON_DIR, r, "route.ts"), "utf8")); all.push(...d.findings); doors.push(...d.doors) }
  const n = (k: string) => doors.filter((d) => d.endsWith(`=${k}`)).length
  check(`every handler of ${ROUTES.length} routes passes the door (run-context ${n("run-context")} · decision-only ${n("decision")} · delegating ${n("delegates")} · exempt ${n("exempt")}: ${Object.keys(EXEMPT).join(", ")})`, all.length === 0, `${all.length} finding(s): ${all.slice(0, 6).join("; ")}`)
  const sample = readFileSync(join(CRON_DIR, "stale-listing-sphere-sweep", "route.ts"), "utf8")
  check("POSITIVE CONTROL: the held return removed → red", doorFindings("stale-listing-sphere-sweep", sample.replace(/\n\s*if \(contextResult\.data\?\.held\)[^\n]*/, "")).findings.length > 0)
  check("POSITIVE CONTROL: a table read planted before the door → red", doorFindings("stale-listing-sphere-sweep", sample.replace("  const contextResult = await", "  await svc.from(\"listings\").select(\"id\")\n  const contextResult = await")).findings.some((f) => f.includes("work before the door")))
  check("POSITIVE CONTROL: the door naming another route's path → red", doorFindings("stale-listing-sphere-sweep", sample.replace("/app/api/cron/stale-listing-sphere-sweep/route.ts", "/app/api/cron/offer-expiry/route.ts")).findings.some((f) => f.includes("not this route")))
  check("CONTROL: a comment or a string that only MENTIONS the door does not count as one", doorFindings("x", 'export async function GET(r) {\n  // const c = await createCronRunContextAction({ cron_path: "/api/cron/x" })\n  const s = "if (c.data?.held) return NextResponse.json("\n}').findings.length === 1)
  if (STATIC_ONLY) return

  console.log("C. the decision (SIMULATED over every key)")
  const pc = await import("../lib/platform/platform-controls")
  const ag = await import("../lib/managers/autonomy-gate")
  const B1 = "b1000000-0000-4000-8000-000000000001", B2 = "b2000000-0000-4000-8000-000000000002"
  const world = (halt: boolean, extra: Record<string, Row[]> = {}): MemClient => {
    pc.__clearPlatformHaltCache(); ag.__clearAutonomyCache(); G.__R1.calls = []
    const m = memSupabase({
      platform_settings: [{ id: "ps-1", ai_enabled: true, emergency_mode: halt, created_at: "2026-01-01T00:00:00Z" }],
      feature_access_overrides: [{ id: "fo-1", brokerage_id: B1, feature_key: "autonomy", override_type: "disable", user_id: null, team_id: null, disabled_reason: "staff paused this tenant", created_at: "2026-01-02T00:00:00Z" }],
      ...extra,
    })
    const touched: string[] = []
    const from = m.from.bind(m)
    ;(m as any).from = (t: string) => { touched.push(t); return from(t) }
    ;(m as any).touched = touched
    G.__R1.svc = m
    return m
  }
  const keys = Object.keys(table)
  const decide = async (k: string, brokerage_id?: string) => cl.resolveCronDecision({ cron_path: `/app/api/cron/${k}/route.ts`, brokerage_id }, G.__R1.svc)
  let svc = world(false)
  const calm = await Promise.all(keys.map((k) => decide(k)))
  check(`no halt: all ${keys.length} keys RUN, each decision names its class, manager and rule`, calm.every((d, i) => d.outcome === "runs" && d.run_class === table[keys[i]][0] && !!d.manager && d.reason === "no halt in force" && d.rule.includes("decideCronRun")))
  svc = world(true)
  const halted = await Promise.all(keys.map((k) => decide(k)))
  const autoHeld = halted.filter((d, i) => table[keys[i]][0] === "autonomous" && d.outcome === "held").length
  const oblRun = halted.filter((d, i) => table[keys[i]][0] === "obligation" && d.outcome === "runs" && d.reason.startsWith("runs under halt: ") && d.platform_halt).length
  check(`platform halt: every autonomous key is HELD (${autoHeld}/${nA})`, autoHeld === nA)
  check(`platform halt: every obligation key RUNS and records why (${oblRun}/${nO})`, oblRun === nO)
  const ghost = await decide("__planted_unclassed__")
  check("POSITIVE CONTROL: an unclassified key under a halt is held, not waved through", ghost.outcome === "held" && ghost.run_class === "unclassified")
  svc = world(false)
  const t1 = await decide("brokerage-intelligence-mine", B1), t2 = await decide("brokerage-intelligence-mine", B2), t3 = await decide("offer-expiry", B1)
  check("tenant halt: the halted tenant's autonomous run is held, another tenant's runs, the halted tenant's obligation runs and says why",
    t1.outcome === "held" && t1.tenant_halt === true && t2.outcome === "runs" && t2.tenant_halt === false && t3.outcome === "runs" && t3.reason.startsWith("runs under halt: "), JSON.stringify([t1.reason, t2.reason, t3.reason]))

  svc = world(true)
  const held = await cl.createCronRunContext({ cron_name: "ads-manager-sweep", cron_path: "/app/api/cron/ads-manager-sweep/route.ts" })
  const hRow = svc.tables.cron_execution_logs?.[0]
  check("the run row of a held run: terminal at once, outcome held on metadata.decision, no 'running' snapshot stamped",
    held.data?.held === true && hRow?.status === "completed" && hRow?.metadata?.decision?.outcome === "held" && !(svc.tables.cron_health_snapshot ?? []).length, JSON.stringify(hRow))
  svc = world(true)
  const ob = await cl.createCronRunContext({ cron_name: "offer-expiry", cron_path: "/app/api/cron/offer-expiry/route.ts" })
  await cl.recordCronStart({ context_id: ob.data!.context_id, input_count: 3 })
  const oRow = svc.tables.cron_execution_logs?.[0]
  check("an obligation run under a halt opens a normal run row whose decision says why, and recordCronStart keeps it",
    ob.data?.held === false && oRow?.status === "started" && oRow?.metadata?.input_count === 3 && String(oRow?.metadata?.decision?.reason).startsWith("runs under halt: "), JSON.stringify(oRow?.metadata))
  svc = world(false)
  const quiet = await cl.decideCronRun({ cron_name: "farm-mail-weekly", cron_path: "/app/api/cron/farm-mail-weekly/route.ts" })
  check("decideCronRun with no halt writes NOTHING (a route without a run row behaves exactly as before)", !quiet.held && svc.writes.length === 0, JSON.stringify(svc.writes))
  svc = world(true)
  await cl.decideCronRun({ cron_name: "farm-mail-weekly", cron_path: "/app/api/cron/farm-mail-weekly/route.ts" })
  check("decideCronRun under a halt records the hold as ONE terminal row", svc.writes.length === 1 && svc.tables.cron_execution_logs?.[0]?.metadata?.decision?.outcome === "held")

  console.log("D. real route handlers (SIMULATED: memSupabase, one counted domain seam each, no provider reachable)")
  process.env.CRON_SECRET = "r1-door-test-secret"
  const req = (path: string, init: RequestInit = {}) => new Request(`http://localhost${path}`, { ...init, headers: { authorization: "Bearer r1-door-test-secret", ...(init.headers ?? {}) } })
  const DOMAIN = (m: MemClient) => ((m as any).touched as string[]).filter((t) => !["platform_settings", "feature_access_overrides", "managed_agents", "cron_execution_logs", "cron_health_snapshot"].includes(t))
  const sphere = await import("../app/api/cron/stale-listing-sphere-sweep/route")
  svc = world(true); let res = await (await sphere.GET(req("/api/cron/stale-listing-sphere-sweep"))).json()
  check("halt → stale-listing-sphere-sweep (autonomous, run row) returns held: 0 domain seam calls, 0 domain tables, its run row says held",
    res.held === true && G.__R1.calls.length === 0 && DOMAIN(svc).length === 0 && svc.tables.cron_execution_logs?.[0]?.metadata?.decision?.outcome === "held", JSON.stringify({ res, calls: G.__R1.calls, d: DOMAIN(svc) }))
  svc = world(false); res = await (await sphere.GET(req("/api/cron/stale-listing-sphere-sweep"))).json()
  check("no halt → the same route runs exactly as before: the seam once, the same response body, its run row completed with the decision on it",
    G.__R1.calls.join() === "sphere-sweep" && JSON.stringify(res) === JSON.stringify({ success: true, scanned: 2, published: 1, handledByTransaction: 0, alreadySignaled: 1, errors: [] })
    && svc.tables.cron_execution_logs?.[0]?.status === "completed" && svc.tables.cron_execution_logs?.[0]?.metadata?.decision?.outcome === "runs", JSON.stringify({ res, row: svc.tables.cron_execution_logs?.[0] }))
  const farm = await import("../app/api/cron/farm-mail-weekly/route")
  svc = world(true); res = await (await farm.GET(req("/api/cron/farm-mail-weekly") as any)).json()
  check("halt → farm-mail-weekly (autonomous, decision-only) returns held: 0 seam calls, never reads brokerages or agents",
    res.held === true && G.__R1.calls.length === 0 && DOMAIN(svc).length === 0, JSON.stringify({ calls: G.__R1.calls, d: DOMAIN(svc) }))
  svc = world(false, { brokerages: [] }); const farmRes = await farm.GET(req("/api/cron/farm-mail-weekly") as any)
  check("no halt → farm-mail-weekly reads its tenants as before and writes NO decision row (200, brokerages read, 0 cron_execution_logs)",
    farmRes.status === 200 && DOMAIN(svc).includes("brokerages") && !(svc.tables.cron_execution_logs ?? []).length, JSON.stringify({ status: farmRes.status, d: DOMAIN(svc) }))
  const reels = await import("../app/api/cron/buyer-reel-deliver/route")
  svc = world(true); res = await (await reels.GET(req("/api/cron/buyer-reel-deliver"))).json()
  const heldReels = res.held === true && G.__R1.calls.length === 0
  svc = world(false); res = await (await reels.GET(req("/api/cron/buyer-reel-deliver"))).json()
  check("G06 buyer-reel-deliver now keeps a run row: halt → held with 0 seam calls; no halt → seam once, same body, row completed",
    heldReels && G.__R1.calls.join() === "buyer-reels" && res.proposed === 1 && typeof res.ran_at === "string" && svc.tables.cron_execution_logs?.[0]?.status === "completed", JSON.stringify({ res, rows: svc.tables.cron_execution_logs }))
  const expiry = await import("../app/api/cron/offer-expiry/route")
  svc = world(true); res = await (await expiry.GET(req("/api/cron/offer-expiry"))).json()
  check("halt → offer-expiry (obligation: an offer expires on its own terms) STILL RUNS and its run row records why",
    res.ok === true && G.__R1.calls.join() === "offer-expiry" && String(svc.tables.cron_execution_logs?.[0]?.metadata?.decision?.reason).startsWith("runs under halt: legal"), JSON.stringify({ res, row: svc.tables.cron_execution_logs?.[0]?.metadata }))
  const rp = await import("../app/api/cron/revenue-protection-rollup/route")
  const post = (b: string) => req("/api/cron/revenue-protection-rollup", { method: "POST", body: JSON.stringify({ brokerage_id: b }), headers: { "content-type": "application/json" } }) as any
  svc = world(false); const r1 = await (await rp.POST(post(B1))).json(); const r2 = await (await rp.POST(post(B2))).json()
  check("tenant halt → the halted tenant's run is held, the other tenant's runs (seam called for B2 only)",
    r1.held === true && r2.success === true && !r2.held && G.__R1.calls.join() === `revenue-protection:${B2}`, JSON.stringify({ r1, r2, calls: G.__R1.calls }))
}

main().then(() => {
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log("❌ CRON_DECISION_DOOR_FAIL"); process.exit(1) }
  console.log("✅ CRON_DECISION_DOOR_PASS — every cron decides once at the door; a halt holds the autonomous class and records why each obligation runs")
  process.exit(0)
}).catch((e) => { console.error(e); console.log("❌ CRON_DECISION_DOOR_FAIL (threw)"); process.exit(1) })
