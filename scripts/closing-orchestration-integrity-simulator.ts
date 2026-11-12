#!/usr/bin/env tsx
/**
 * scripts/closing-orchestration-integrity-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * "NOTHING TO DO" MUST NEVER BE WHAT A REFUSED READ LOOKS LIKE.
 *
 * lib/transactions/closing-orchestration.ts is the cron that turns tracked
 * milestones into "do this today". It reads the transactions table, five
 * evidence tables per deal, and the open-actions table — and it checked `error`
 * on exactly ONE of them. supabase-js RESOLVES a refused query, so a denied read
 * arrives as an empty list: a denied `transactions` scan reported
 * `{ scanned: 0 }` — "nothing to do" — on the lane that drives closings, and
 * pre-rollout every table is EMPTY, so the output of a dead engine and a healthy
 * one were the same three zeroes.
 *
 * Two other shapes of the same defect are proved here:
 *   · DETECTORS FIRE ON ABSENCE. `detectTitleCommitmentLate` opens an URGENT
 *     action when no title-commitment date is on file — so a REFUSED
 *     transaction_title_escrow read used to fabricate an alarm off a read that
 *     never ran.
 *   · A DEAL WITH NO MILESTONES IS INVISIBLE to five of the nine detectors. The
 *     offer→transaction bridge commits the transaction row BEFORE seeding and
 *     the seeder throws on a refused insert, so a deal whose seeding failed sits
 *     silent forever. The kernel's idempotent retry
 *     (lib/kernel/transactions.ts:seedTransactionMilestones) is wired here, and
 *     a retry that FAILS is reported as a refusal rather than healing silently.
 *
 * HOW IT IS PROVED — REAL CODE, REAL supabase-js, FAKE DATABASE.
 *
 * The engine builds its own client from `createServiceClient()`, so there is no
 * stub to inject and no honest way to fake the property under test with one:
 * "does a refusal RESOLVE?" is a supabase-js behaviour, not ours. So this proof
 * points NEXT_PUBLIC_SUPABASE_URL at a local HTTP server that speaks enough
 * PostgREST to answer the engine's real queries, and makes a table refuse by
 * replying 403 the way Postgres does. Every function under test is the real one;
 * only the database is fake.
 *
 * ASSERTIONS ARE CONSTRUCTS, NEVER SPELLINGS. Nothing below matches a headline,
 * a message or a source string: each check drives the engine and reads the
 * VALUE it returned and the ROWS it wrote.
 *
 * EVERY ASSERTION IS NEGATIVE-CONTROLLED. Each control puts the original defect
 * back in the real source file, CONFIRMS THE PATCH LANDED (the new text present,
 * the old text gone — a control that silently fails to apply proves nothing and
 * has bitten this repo before), re-imports the module with a cache-busting query
 * so the patched code actually runs, requires RED, restores the file, and
 * requires GREEN again.
 */
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "module"

// The kernel graph imports `server-only`, which throws outside a Server
// Component. tsx is neither — neutralise it in the require cache BEFORE the
// system under test loads.
const _require = createRequire(import.meta.url)
try {
  const so = _require.resolve("server-only")
  _require.cache[so] = { id: so, filename: so, loaded: true, exports: {} } as never
} catch { /* nothing to shim */ }

import { resolveMilestoneIdentity } from "../lib/transactions/milestone-identity"

const root = process.cwd()

// ─────────────────────────────────────────────────────────────────────────────
// Bookkeeping
// ─────────────────────────────────────────────────────────────────────────────
let pass = 0
const failures: string[] = []
function check(label: string, ok: boolean, why?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else { failures.push(label); console.log(`  ✗ ${label}${why ? `\n      ${why}` : ""}`) }
}

// ─────────────────────────────────────────────────────────────────────────────
// A FAKE POSTGREST. Enough of it for the engine's real queries — and, crucially,
// a way to make one table REFUSE while the rest answer.
// ─────────────────────────────────────────────────────────────────────────────
type Row = Record<string, any>
interface FakeDb {
  tables: Record<string, Row[]>
  /** `${METHOD}:${table}` or `*:${table}` — replied to with 403. */
  refuse: Set<string>
}
let DB: FakeDb = { tables: {}, refuse: new Set() }

/** PostgREST reserved query params — everything else is a column filter. */
const RESERVED = new Set(["select", "order", "limit", "offset", "columns", "on_conflict"])

function matchesFilter(row: Row, column: string, raw: string): boolean {
  let expr = raw
  let negate = false
  if (expr.startsWith("not.")) { negate = true; expr = expr.slice(4) }
  const dot = expr.indexOf(".")
  const op = dot === -1 ? expr : expr.slice(0, dot)
  const val = dot === -1 ? "" : expr.slice(dot + 1)
  const v = row[column]
  let ok: boolean
  switch (op) {
    case "eq":  ok = String(v) === val; break
    case "neq": ok = String(v) !== val; break
    case "is":  ok = val === "null" ? v === null || v === undefined : String(v) === val; break
    case "in": {
      const list = val.replace(/^\(/, "").replace(/\)$/, "").split(",").map((s) => s.replace(/^"|"$/g, ""))
      ok = list.includes(String(v))
      break
    }
    case "gte": ok = String(v) >= val; break
    case "lte": ok = String(v) <= val; break
    case "gt":  ok = String(v) >  val; break
    case "lt":  ok = String(v) <  val; break
    default:    ok = true
  }
  return negate ? !ok : ok
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = ""
    req.on("data", (c) => { raw += c })
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : null) } catch { resolve(null) } })
  })
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  const table = url.pathname.replace(/^\/rest\/v1\//, "")
  const method = req.method ?? "GET"
  const send = (code: number, body?: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" })
    if (body === undefined) res.end()
    else res.end(JSON.stringify(body))
  }

  // THE REFUSAL. A denied query in Postgres is a 403 with a body — and
  // supabase-js RESOLVES it. That is the whole point of this proof.
  if (DB.refuse.has(`${method}:${table}`) || DB.refuse.has(`*:${table}`)) {
    return send(403, {
      code: "42501",
      message: `permission denied for table ${table}`,
      details: null,
      hint: null,
    })
  }

  const rows = (DB.tables[table] ??= [])

  if (method === "GET") {
    let out = rows.filter((r) =>
      [...url.searchParams.entries()].every(([k, v]) => RESERVED.has(k) || matchesFilter(r, k, v)),
    )
    const limit = url.searchParams.get("limit")
    if (limit) out = out.slice(0, Number(limit))
    return send(200, out)
  }

  const body = await readBody(req)

  if (method === "POST") {
    const incoming: Row[] = Array.isArray(body) ? body : body ? [body] : []
    const stamped = incoming.map((r, i) => ({ id: r.id ?? `${table}-row-${rows.length + i + 1}`, ...r }))
    rows.push(...stamped)
    const prefer = String(req.headers["prefer"] ?? "")
    return prefer.includes("return=representation") ? send(201, stamped) : send(201)
  }

  if (method === "PATCH") {
    for (const r of rows) {
      const hit = [...url.searchParams.entries()].every(([k, v]) => RESERVED.has(k) || matchesFilter(r, k, v))
      if (hit) Object.assign(r, body ?? {})
    }
    return send(204)
  }

  return send(200, [])
})

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const port = (server.address() as AddressInfo).port
process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`
process.env.SUPABASE_SERVICE_ROLE_KEY = "closing-orchestration-integrity-simulator"

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────
const BROKERAGE = "11111111-1111-4111-8111-111111111111"
const TXN       = "22222222-2222-4222-8222-222222222222"

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

/**
 * One active deal, 30 days post-contract, closing in 20.
 *
 * Chosen so exactly ONE detector fires with full evidence — title_commitment_late
 * (day 30 > 14, no title row). Every other detector is out of its window or
 * needs a lender/title row that is deliberately absent, so `opened` is a signal
 * about the engine rather than about the fixture.
 */
function baseDb(opts: { milestones: boolean }): FakeDb {
  const tables: Record<string, Row[]> = {
    transactions: [{
      id:                  TXN,
      brokerage_id:        BROKERAGE,
      agent_id:            null,
      status:              "under_contract",
      contract_date:       day(-30),
      close_date:          day(20),
      property_address:    "12 Oak Street",
      deal_type:           "buyer",
      inspection_deadline: day(5),
      appraisal_deadline:  day(9),
      financing_deadline:  day(14),
      updated_at:          new Date().toISOString(),
    }],
    transaction_inspections:     [],
    transaction_lenders:         [],
    transaction_title_escrow:    [],
    transaction_milestones:      [],
    transaction_vendor_services: [],
    transaction_pending_actions: [],
    transaction_deadlines:       [],
    calendar_events:             [],
  }
  if (opts.milestones) {
    tables.transaction_milestones.push({
      id: "m-existing", transaction_id: TXN, brokerage_id: BROKERAGE,
      milestone_name: "Offer Accepted", milestone_type: "offer_accepted",
      status: "pending", completed_at: null, target_date: null,
    })
  }
  return { tables, refuse: new Set() }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fresh imports. The query string busts the ESM cache so a patched file is what
// actually runs during a negative control.
// ─────────────────────────────────────────────────────────────────────────────
const ENGINE = "lib/transactions/closing-orchestration.ts"
const KERNEL = "lib/kernel/transactions.ts"
const SEEDER = "lib/transactions/milestone-service.ts"
let version = 0
const fresh = async (relPath: string): Promise<any> =>
  await import(`${pathToFileURL(join(root, relPath)).href}?v=${++version}`)

/** The engine logs its refusals. Captured so the transcript stays readable and
 *  so a silent refusal (no log at all) is still visible in the counts. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const real = console.error
  console.error = () => {}
  try { return await fn() } finally { console.error = real }
}

/**
 * The shapes the assertions read. Declared locally because the modules are
 * imported through a cache-busting dynamic specifier (which TypeScript cannot
 * resolve to a type) — NOT as a contract: every assertion below still reads the
 * VALUE the real function returned, and a missing field reads as undefined and
 * fails the check rather than passing quietly.
 */
interface Refusal { transactionId: string | null; read: string; error: string }
interface EngineResult {
  outcome: string
  error: string | null
  scanned: number
  opened: number
  superseded: number
  reseeded: number
  skipped: number
  refusals: Refusal[]
}
interface AutopsyResult { outcome: string; scanned: number; autopsied: number; skipped: number; errors: string[] }
interface ReseedResult { success: boolean; error?: string; data?: { count: number; seeded: boolean; outcome: string } }

async function runEngine(db: FakeDb, opts?: { limit?: number }): Promise<EngineResult> {
  DB = db
  const mod = await fresh(ENGINE)
  return await quiet<EngineResult>(() => mod.runClosingOrchestration(opts ?? {}))
}

async function runAutopsies(db: FakeDb): Promise<AutopsyResult> {
  DB = db
  const mod = await fresh(ENGINE)
  return await quiet<AutopsyResult>(() => mod.runLostTransactionAutopsies({ sinceHours: 0 }))
}

async function runKernelReseed(db: FakeDb): Promise<ReseedResult> {
  DB = db
  const mod = await fresh(KERNEL)
  return await quiet<ReseedResult>(() => mod.seedTransactionMilestones({
    transactionId: TXN,
    brokerageId:   BROKERAGE,
    dealType:      "buyer",
    contractTerms: { inspectionDeadline: day(5), closingDate: day(20) },
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// The negative-control harness.
// ─────────────────────────────────────────────────────────────────────────────
interface Control { file: string; find: string; replace: string; describe: string }

/**
 * A control may need to patch MORE THAN ONE FILE.
 *
 * Some properties here are held by defence in depth: the kernel retry refuses on
 * an unreadable existence check, AND milestone-service refuses on its own. Wave
 * 14 added the second layer, which immediately made a single-file control
 * USELESS — it removed the kernel's guard, the deeper guard still refused, the
 * assertion stayed green, and the control reported failure. That is the control
 * doing its job: it detected that it was no longer reproducing the defect.
 *
 * The honest repair is to make the control remove EVERY layer that holds the
 * property, so RED means "with all of these gone the hole is genuinely open"
 * — and the restore proves all of them came back. A control that can only reach
 * one of two guards proves nothing about either.
 */
async function controlled(label: string, predicate: () => Promise<boolean>, control: Control | Control[]) {
  const controls = Array.isArray(control) ? control : [control]
  const describe = controls.map(c => c.describe).join(" + ")

  const green = await predicate()
  check(label, green, green ? undefined : "the assertion is RED against the REAL code — read this before reading anything else")
  if (!green) return

  const originals: Array<{ path: string; text: string }> = []
  for (const c of controls) {
    const path = join(root, c.file)
    const text = readFileSync(path, "utf8")
    originals.push({ path, text })
    const occurrences = text.split(c.find).length - 1
    if (occurrences !== 1) {
      check(`   ↳ control target is unambiguous (${c.describe})`, false,
        `the patch target appears ${occurrences} time(s) in ${c.file} — the control cannot be trusted`)
      for (const o of originals) writeFileSync(o.path, o.text)
      return
    }
  }

  try {
    // ACCUMULATE PER FILE. Two controls can target the SAME file — this property
    // is held by three guards, two of which live in milestone-service.ts — and
    // writing each patch from the file's ORIGINAL text silently discards the
    // previous one. The applied-check below caught exactly that, which is the
    // whole reason it exists.
    const pending = new Map<string, string>()
    for (const o of originals) if (!pending.has(o.path)) pending.set(o.path, o.text)
    for (let i = 0; i < controls.length; i++) {
      const path = originals[i].path
      pending.set(path, (pending.get(path) as string).replace(controls[i].find, controls[i].replace))
    }
    for (const [path, text] of pending) writeFileSync(path, text)

    // CONFIRM EVERY PATCH LANDED. A control that silently fails to apply is worse
    // than no control: it reports GREEN twice and calls that proof.
    for (let i = 0; i < controls.length; i++) {
      const patched = readFileSync(originals[i].path, "utf8")
      const applied = patched.includes(controls[i].replace) && !patched.includes(controls[i].find)
      if (!applied) {
        check(`   ↳ control applied (${controls[i].describe})`, false, "the patch did not land — this control proves NOTHING")
        return
      }
    }
    const red = await predicate()
    check(`   ↳ control applied and RED: ${describe}`, red === false,
      red ? "the defect was put back and the assertion still passed — it is not testing what it claims" : undefined)
  } finally {
    for (const o of originals) writeFileSync(o.path, o.text)
  }

  // EVERY patched file must come back byte-identical, not just the last one —
  // a control that half-restores leaves the defect in the tree and the next
  // assertion measures a codebase nobody wrote.
  const notRestored = originals.filter(o => readFileSync(o.path, "utf8") !== o.text).map(o => o.path)
  const greenAgain = await predicate()
  check(`   ↳ restored and GREEN again`, notRestored.length === 0 && greenAgain,
    notRestored.length > 0
      ? `these files were NOT restored: ${notRestored.join(", ")}`
      : greenAgain ? undefined : "still RED after restore")
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("══════════════════════════════════════════════════")
console.log(" CLOSING ORCHESTRATION · A REFUSED READ IS NOT 'NOTHING TO DO'")
console.log("══════════════════════════════════════════════════")

// ── 1 · THE SCAN ITSELF ─────────────────────────────────────────────────────
console.log("\n[the transactions scan: refused and empty are different facts]")
{
  const refusedScan = async () => {
    const db = baseDb({ milestones: true })
    db.refuse.add("GET:transactions")
    const r = await runEngine(db)
    // Positively "read_refused" — and therefore, by the type's construction, NOT
    // the "nothing_to_orchestrate" this used to be reported as. The two are
    // compared head-to-head a few lines below.
    return r.outcome === "read_refused"
      && r.refusals.some((f: Refusal) => f.read === "transactions")
      && typeof r.error === "string" && r.error.length > 0
  }
  await controlled(
    "a REFUSED transactions scan reports a refusal — never 'nothing to orchestrate'",
    refusedScan,
    {
      file: ENGINE,
      find: "  const { data: txns, error: txnsError } = await svc",
      replace: "  const txnsError = null as unknown as { message: string } | null\n  const { data: txns } = await svc",
      describe: "the scan's error dropped on the floor, the way it was before",
    },
  )

  const emptyScan = async () => {
    const db = baseDb({ milestones: true })
    db.tables.transactions = []
    const r = await runEngine(db)
    return r.outcome === "nothing_to_orchestrate" && r.error === null && r.refusals.length === 0
  }
  check("an EMPTY scan that actually ran says so with its own outcome", await emptyScan())

  // THE LOAD-BEARING SHAPE: the two results are numerically IDENTICAL. Anything
  // that reports health off the counts alone cannot tell them apart — which is
  // precisely why the discriminant has to be a required field.
  const dbRefused = baseDb({ milestones: true }); dbRefused.refuse.add("GET:transactions")
  const refused = await runEngine(dbRefused)
  const dbEmpty = baseDb({ milestones: true }); dbEmpty.tables.transactions = []
  const empty = await runEngine(dbEmpty)
  check("the two are indistinguishable by COUNT — scanned/opened/superseded are identical",
    refused.scanned === empty.scanned && refused.opened === empty.opened && refused.superseded === empty.superseded)
  check("…and distinguishable ONLY by the required discriminant",
    refused.outcome !== empty.outcome && typeof refused.outcome === "string" && typeof empty.outcome === "string",
    "a caller can still read the numbers, but it cannot report health without reading `outcome`")
}

// ── 2 · THE PER-DEAL EVIDENCE READS ─────────────────────────────────────────
console.log("\n[every evidence read: a refusal is named, and the deal is skipped rather than half-judged]")
{
  const EVIDENCE: Array<[string, string]> = [
    ["transaction_inspections",     "inspections"],
    ["transaction_lenders",         "lender"],
    ["transaction_title_escrow",    "title/escrow"],
    ["transaction_milestones",      "milestones"],
    ["transaction_vendor_services", "hazard insurance"],
  ]

  for (const [table, human] of EVIDENCE) {
    const db = baseDb({ milestones: true })
    db.refuse.add(`GET:${table}`)
    const r = await runEngine(db)
    check(`a refused ${human} read is reported as a refusal, not as a quiet healthy deal`,
      r.outcome === "orchestrated"
        && r.refusals.some((f: Refusal) => f.read === table && f.transactionId === TXN)
        && r.skipped === 1
        && r.opened === 0,
      `got outcome=${r.outcome} refusals=${JSON.stringify(r.refusals)} skipped=${r.skipped} opened=${r.opened}`)
  }

  // FABRICATION. detectTitleCommitmentLate fires on the ABSENCE of a commitment
  // date, so a refused title read used to open an urgent alarm off a read that
  // never happened. This is the assertion the evidence gate exists for.
  const noFabrication = async () => {
    const db = baseDb({ milestones: true })
    db.refuse.add("GET:transaction_title_escrow")
    const r = await runEngine(db)
    return r.opened === 0
      && (db.tables.transaction_pending_actions ?? []).length === 0
      && r.refusals.some((f: Refusal) => f.read === "transaction_title_escrow")
  }
  await controlled(
    "a refused title read opens NO action — an alarm is never raised off a read that did not run",
    noFabrication,
    {
      file: ENGINE,
      find: "      .filter((e) => e.res.error)",
      replace: "      .filter((e) => false && e.res.error)",
      describe: "the evidence-refusal gate removed, so absent evidence is judged as evidence of absence",
    },
  )

  // The control above must not be passing merely because nothing ever opens.
  const opensWhenEvidenceIsReal = async () => {
    const db = baseDb({ milestones: true })
    const r = await runEngine(db)
    return r.outcome === "orchestrated" && r.scanned === 1 && r.opened === 1 && r.skipped === 0
      && r.refusals.length === 0
      && (db.tables.transaction_pending_actions ?? []).some((a) => a.action_type === "title_commitment_late")
  }
  check("with every read answered, the engine still detects and opens (the gate is not a mute button)",
    await opensWhenEvidenceIsReal())
}

// ── 3 · THE OPEN-ACTIONS READ ───────────────────────────────────────────────
console.log("\n[the open-actions read: an unreadable worklist is not an empty one]")
{
  const refusedOpenRows = async () => {
    const db = baseDb({ milestones: true })
    db.refuse.add("GET:transaction_pending_actions")
    const r = await runEngine(db)
    return r.outcome === "orchestrated"
      && r.refusals.some((f: Refusal) => f.read === "transaction_pending_actions")
      && r.opened === 0 && r.superseded === 0 && r.skipped === 1
      && (db.tables.transaction_pending_actions ?? []).length === 0
  }
  await controlled(
    "a refused open-actions read refuses the deal instead of re-opening rows that may already exist",
    refusedOpenRows,
    {
      file: ENGINE,
      find: "    const { data: openRows, error: openError } = await svc",
      replace: "    const openError = null as unknown as { message: string } | null\n    const { data: openRows } = await svc",
      describe: "the open-actions error dropped, so an unreadable worklist reads as an empty one",
    },
  )
}

// ── 4 · THE DEAL WITH NO MILESTONES ─────────────────────────────────────────
console.log("\n[a milestone-less deal is re-seeded through the kernel, and a failed retry is a refusal]")
{
  const reseedsAndSees = async () => {
    const db = baseDb({ milestones: false })
    const r = await runEngine(db)
    const seeded = db.tables.transaction_milestones ?? []
    // CONSTRUCT, not spelling: every seeded row must resolve to a CANONICAL
    // milestone identity. That is the property the deleted template seeder could
    // not hold (display titles + null types → milestones that never complete).
    const allCanonical = seeded.length > 0 && seeded.every((m) => !!resolveMilestoneIdentity(m as any))
    const inspection = seeded.find((m) => resolveMilestoneIdentity(m as any) === "inspection_deadline")
    return r.outcome === "orchestrated"
      && r.reseeded === 1
      && r.skipped === 0
      && allCanonical
      // The dates come off the DEAL, not out of the air.
      && inspection?.target_date === day(5)
  }
  await controlled(
    "a deal with NO milestones is re-seeded from the canonical catalog, with the deal's own dates",
    reseedsAndSees,
    {
      file: ENGINE,
      find: "    if (milestoneRows.length === 0) {",
      replace: "    if (false && milestoneRows.length === 0) {",
      describe: "the re-seed wiring removed — the deal stays invisible to five detectors",
    },
  )

  // Idempotent: a second pass over the same database seeds nothing more.
  const db = baseDb({ milestones: false })
  const first = await runEngine(db)
  const afterFirst = (db.tables.transaction_milestones ?? []).length
  const second = await runEngine(db)
  const afterSecond = (db.tables.transaction_milestones ?? []).length
  check("…and the retry is idempotent — a second pass re-seeds nothing and duplicates nothing",
    first.reseeded === 1 && second.reseeded === 0 && afterFirst === afterSecond && afterFirst > 0,
    `first=${first.reseeded} second=${second.reseeded} rows ${afterFirst} → ${afterSecond}`)

  const failedReseedIsARefusal = async () => {
    const fdb = baseDb({ milestones: false })
    fdb.refuse.add("POST:transaction_milestones")
    const r = await runEngine(fdb)
    return r.outcome === "orchestrated"
      && r.reseeded === 0
      && r.skipped === 1
      && r.refusals.some((f: Refusal) => f.read.startsWith("transaction_milestones") && f.transactionId === TXN)
  }
  check("a re-seed that FAILS is a named refusal, never a silent heal", await failedReseedIsARefusal())
}

// ── 5 · THE KERNEL RETRY, DRIVEN DIRECTLY ───────────────────────────────────
console.log("\n[the kernel retry: idempotent, tenant-scoped, and closed on an unreadable check]")
{
  // THE ASSERTION NAMES THE KERNEL'S OWN REFUSAL, not merely "it failed".
  //
  // Three guards now hold this property — the kernel's idempotency check and two
  // in milestone-service — so "success === false" is satisfied by whichever
  // fires first and cannot tell us the kernel's guard is doing anything. Worse,
  // the kernel reaches milestone-service through `await import(...)` with NO
  // cache-buster, while this harness only busts the kernel's own URL: a patched
  // milestone-service is never re-loaded, so a control that patches it proves
  // nothing at all. That is a limit of the harness, and pretending otherwise
  // would be a control that reports GREEN twice and calls it proof.
  //
  // So the predicate matches the kernel's OWN refusal text. With the kernel
  // guard removed the call still fails — at the deeper layer — but with a
  // different message, and this goes RED. One layer, isolated, honestly.
  const failsClosedOnUnreadableCheck = async () => {
    const db = baseDb({ milestones: false })
    db.refuse.add("GET:transaction_milestones")
    const r = await runKernelReseed(db)
    return r.success === false
      && /could not read existing milestones/i.test(String(r.error ?? ""))
      && (db.tables.transaction_milestones ?? []).length === 0
  }
  await controlled(
    "the retry REFUSES when it cannot read what is already there — it never seeds on an unreadable check",
    failsClosedOnUnreadableCheck,
    {
      file: KERNEL,
      find: "  if (existingError) {\n    return { success: false, error: `Could not read existing milestones: ${existingError.message}` }\n  }",
      replace: "  if (false && existingError) {\n    return { success: false, error: \"unreachable\" }\n  }",
      describe: "the kernel's own existence check dropped, so its refusal is no longer the one that fires",
    },
  )

  const dbSeed = baseDb({ milestones: false })
  const seedResult = await runKernelReseed(dbSeed)
  check("an empty deal is seeded and the call reports what it did",
    seedResult.success === true && seedResult.data?.seeded === true
      && seedResult.data?.outcome === "seeded" && (seedResult.data?.count ?? 0) > 0)

  const again = await runKernelReseed(dbSeed)
  check("a deal that already has milestones is left alone, and says so",
    again.success === true && again.data?.seeded === false && again.data?.outcome === "already_seeded"
      && again.data?.count === (dbSeed.tables.transaction_milestones ?? []).length)

  // The guard is TENANT-SCOPED: milestones filed under another brokerage must not
  // count as "this deal is already seeded".
  const dbOtherTenant = baseDb({ milestones: false })
  dbOtherTenant.tables.transaction_milestones.push({
    id: "m-other-tenant", transaction_id: TXN, brokerage_id: "99999999-9999-4999-8999-999999999999",
    milestone_name: "Offer Accepted", milestone_type: "offer_accepted", status: "pending", target_date: null,
  })
  const crossTenant = await runKernelReseed(dbOtherTenant)
  check("another brokerage's row on the same transaction id does NOT count as seeded",
    crossTenant.success === true && crossTenant.data?.seeded === true)
}

// ── 6 · THE LOST-DEAL AUTOPSY SCAN ──────────────────────────────────────────
console.log("\n[the lost-transaction scan: 'no deal fell through' is a claim, not a default]")
{
  const refusedLostScan = async () => {
    const db = baseDb({ milestones: true })
    db.refuse.add("GET:transactions")
    const r = await runAutopsies(db)
    return r.outcome === "read_refused" && r.errors.length > 0
  }
  await controlled(
    "a refused lost-deal scan reports a refusal, not 'nothing lost'",
    refusedLostScan,
    {
      file: ENGINE,
      find: "  const { data: lostTxns, error: lostError } = await q",
      replace: "  const lostError = null as unknown as { message: string } | null\n  const { data: lostTxns } = await q",
      describe: "the lost-scan error dropped, so a denied read reads as 'no deal fell through'",
    },
  )

  const db = baseDb({ milestones: true })
  const r = await runAutopsies(db)
  check("a scan that ran and found no lost deal says THAT instead",
    r.outcome === "nothing_lost" && r.errors.length === 0)
}

// ─────────────────────────────────────────────────────────────────────────────
server.close()
console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  console.log(" ❌ CLOSING_ORCHESTRATION_INTEGRITY_FAIL — a refused read can still be read as 'nothing to do'")
  process.exit(1)
}
console.log(" ✅ CLOSING_ORCHESTRATION_INTEGRITY_PASS — every read that did not run is reported as a refusal, and a milestone-less deal is re-seeded rather than ignored")
process.exit(0)
