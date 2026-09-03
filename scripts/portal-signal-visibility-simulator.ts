#!/usr/bin/env tsx
/**
 * scripts/portal-signal-visibility-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUYER'S SIGNAL REACHES THE HUMAN IT EXISTS TO REACH — or the buyer is told it did not.
 * Three claims, asserted as CONSTRUCTS (never spellings — a re-word must not fail this):
 *
 *   V1  every write to the portal engagement ledger lands INSIDE a lane the SELECT policy
 *       grants to staff. The policy is not quoted from memory: it is parsed out of
 *       supabase/migrations/047-client-portal-activity.sql and modelled, and each row is
 *       evaluated against that model. A row written with no tenant is readable by the client
 *       who generated it and by platform admins — nobody who can act on it — and because both
 *       columns are nullable the insert SUCCEEDS, which is why this was invisible.
 *
 *   V2  none of the five buyer-facing actions reports success when the agent was not notified.
 *       Asserted by RUNNING the real exported actions with the notification rail refusing.
 *
 *   V3  all five are gated, on the SAME shared helper — and the gate fails CLOSED: a refused
 *       caller writes NOTHING, not "everything but the notification".
 *
 * Layers
 *   · POLICY    — the RLS mechanism, read off the migration and turned into a predicate.
 *   · BEHAVIOUR — the REAL exported actions from app/actions/buyer-offer-tools.ts, executed
 *                 against an in-memory store (no creds, no network), with the gate, the service
 *                 client and the property providers swapped for controllable stubs. What they
 *                 write, what they refuse to write, and what they tell the buyer.
 *   · SOURCE    — the six write sites and the four read sites the behaviour layer cannot reach,
 *                 with each write's payload RESOLVED (inline literal or hoisted const) and run
 *                 through the same policy predicate.
 *
 * NEGATIVE CONTROLS: run with no flag and this harness re-introduces each defect INTO THE
 * SOURCE, greps to confirm the patch actually applied, re-runs itself in a child process and
 * requires RED, restores, and requires GREEN. A control that silently fails to apply proves
 * nothing, so the patch confirmation is printed for each.
 *
 * Run: npx tsx scripts/portal-signal-visibility-simulator.ts
 *      npx tsx scripts/portal-signal-visibility-simulator.ts --assert-only   (skip the controls)
 */
import { readFileSync, writeFileSync } from "node:fs"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { join, relative } from "node:path"
import { registerHooks } from "node:module"
import { spawnSync } from "node:child_process"

const ROOT = process.cwd()
const CHILD = process.env.PSV_SIM_CHILD === "1"
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE INTERCEPTION — so the REAL server actions can run in a plain script.
//
// `server-only` is a build marker that throws outside a React Server Component. The gate, the
// service client and the property providers are redirected to stubs that dispatch through
// globalThis, which is what lets a single cached module graph be re-aimed per scenario. This is
// the only way to execute the production functions rather than assert about them from outside.
// ─────────────────────────────────────────────────────────────────────────────
const STUB_SOURCES: Record<string, string> = {
  "@/lib/supabase/service": "export const createServiceClient = (...a) => globalThis.__PSV.createServiceClient(...a)",
  "@/lib/portal/require-contact-access": "export const requireContactAccess = (...a) => globalThis.__PSV.requireContactAccess(...a)",
  "@/lib/property/address-lookup": "export const lookupPropertyByAddress = (...a) => globalThis.__PSV.lookupPropertyByAddress(...a)",
  "@/lib/property/rentcast": "export const getRentcastAVM = (...a) => globalThis.__PSV.getRentcastAVM(...a)",
  "@/lib/avm/provider-chain": "export const getCurrentAvm = (...a) => globalThis.__PSV.getCurrentAvm(...a)",
}

registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (spec === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true }
    const stub = STUB_SOURCES[spec]
    if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — POLICY: the mechanism, read off the migration rather than remembered
// ─────────────────────────────────────────────────────────────────────────────
const MIGRATION = "supabase/migrations/047-client-portal-activity.sql"

/** The SELECT policy body, extracted from the migration text. */
function selectPolicyBody(): string {
  const sql = src(MIGRATION)
  const start = sql.indexOf("FOR SELECT")
  if (start < 0) return ""
  const end = sql.indexOf("-- INSERT", start)
  return sql.slice(start, end > 0 ? end : sql.length)
}

/** A row as the writer hands it to the database. */
interface ActivityRow { brokerage_id?: unknown; agent_id?: unknown; contact_id?: unknown }

/**
 * The policy, modelled. `staffCanSee` answers the only question that matters: is this row inside
 * a lane the policy grants to somebody who can ACT on it (the owning agent, or their brokerage)?
 * The contact-self lane and the platform-admin lane are deliberately NOT counted — a signal only
 * its own author and a platform admin can read is a write-only ledger wearing the costume of a
 * working one.
 */
function staffCanSee(row: ActivityRow): boolean {
  const brokerageLane = row.brokerage_id !== null && row.brokerage_id !== undefined
  const agentLane = row.agent_id !== null && row.agent_id !== undefined
  return brokerageLane || agentLane
}

function policyLayer(): void {
  console.log("\n[policy · the SELECT policy, parsed out of the migration]")
  const body = selectPolicyBody()
  check("the migration's SELECT policy was found and read", body.length > 0)

  // The two staff lanes and what each REQUIRES. These are the facts the model above encodes;
  // if the migration ever stops keying on these columns, the model is wrong and must be told so.
  const brokerageLane = /has_brokerage_access\(\s*brokerage_id\s*\)/.test(body)
  const agentLane = /agent_id\s+IS\s+NOT\s+NULL[\s\S]{0,80}agent_id\s*=\s*public\.current_user_agent_id\(\)/i.test(body)
  check("the staff/brokerage lane is keyed on the row's own tenant column", brokerageLane)
  check("the agent lane is keyed on the row's own agent column AND refuses a NULL", agentLane)

  // The load-bearing negative: nothing in the policy lets a bare contact_id reach staff.
  const contactLaneIsSelfOnly = /contacts\s+c[\s\S]{0,160}c\.contact_user_id\s*=\s*auth\.uid\(\)/i.test(body)
  check("the only contact-keyed lane is the CLIENT'S OWN — a bare contact_id never reaches staff",
    contactLaneIsSelfOnly)

  // The model agrees with the policy at its boundaries.
  check("model · a row with neither column is outside every staff lane (the defect's shape)",
    !staffCanSee({ contact_id: "c1", brokerage_id: null, agent_id: null }))
  check("model · a tenant alone puts the row inside the brokerage lane",
    staffCanSee({ contact_id: "c1", brokerage_id: "b1", agent_id: null }))
  check("model · an owning agent alone puts the row inside the agent lane",
    staffCanSee({ contact_id: "c1", brokerage_id: null, agent_id: "a1" }))
  check("model · an omitted column counts the same as an explicit null (both are NULL in the row)",
    !staffCanSee({ contact_id: "c1" }))
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — BEHAVIOUR: the real actions, against an in-memory store
// ─────────────────────────────────────────────────────────────────────────────
type Row = Record<string, any>
interface Fault { table: string; op: "select" | "insert"; message: string }

function makeFakeSupabase(store: Record<string, Row[]>, faults: Fault[] = []) {
  const log: Array<{ table: string; op: string; filters: Array<[string, any]>; payload?: Row }> = []
  const faultFor = (table: string, op: "select" | "insert") => faults.find(f => f.table === table && f.op === op)

  function query(table: string) {
    const filters: Array<[string, any]> = []
    const ins: Array<[string, any[]]> = []
    let mode: "select" | "insert" = "select"
    let payload: Row | null = null

    const rows = () => (store[table] ?? []).filter((r) =>
      filters.every(([c, v]) => r[c] === v) && ins.every(([c, vs]) => vs.includes(r[c])))

    const settle = (kind: "one" | "list") => {
      if (mode === "insert") {
        const f = faultFor(table, "insert")
        log.push({ table, op: "insert", filters, payload: payload ?? undefined })
        if (f) return Promise.resolve({ data: null, error: { message: f.message } })
        const row = { id: `${table}_${(store[table] ?? []).length + 1}`, ...(payload ?? {}) }
        store[table] = [...(store[table] ?? []), row]
        return Promise.resolve({ data: kind === "one" ? row : [row], error: null })
      }
      const f = faultFor(table, "select")
      log.push({ table, op: "select", filters })
      if (f) return Promise.resolve({ data: null, error: { message: f.message } })
      const found = rows()
      return Promise.resolve({ data: kind === "one" ? (found[0] ?? null) : found, error: null })
    }

    const api: any = {
      select: () => api,
      insert: (p: Row) => { mode = "insert"; payload = p; return api },
      update: (p: Row) => { mode = "insert"; payload = p; return api },
      eq: (c: string, v: any) => { filters.push([c, v]); return api },
      neq: () => api, not: () => api, gte: () => api,
      in: (c: string, v: any[]) => { ins.push([c, v]); return api },
      order: () => api, limit: () => api,
      maybeSingle: () => settle("one"),
      single: () => settle("one"),
      then: (res: any, rej: any) => settle("list").then(res, rej),
    }
    return api
  }

  return { client: { from: (table: string) => query(table) } as any, log, store }
}

const BROKERAGE = "11111111-1111-4111-8111-111111111111"
const BUYER = "22222222-2222-4222-8222-222222222222"
const AGENTS_ID = "33333333-3333-4333-8333-333333333333"   // agents.id — what the row must carry
const AGENT_USER_ID = "44444444-4444-4444-8444-444444444444" // users.id — a DISJOINT space
const PROPERTY = "55555555-5555-4555-8555-555555555555"
const ADDRESS = "123 Oak Lane"

function seedStore(opts: { agentId?: string | null } = {}): Record<string, Row[]> {
  const agentId = opts.agentId === undefined ? AGENTS_ID : opts.agentId
  return {
    contacts: [{ id: BUYER, brokerage_id: BROKERAGE, agent_id: agentId, first_name: "Rio", last_name: "Vega", timeline: "asap" }],
    agents: agentId ? [{ id: agentId, user_id: AGENT_USER_ID }] : [],
    users: [{ id: AGENT_USER_ID, first_name: "Dana", last_name: "Kling" }],
    buyer_financial_profiles: [],
    saved_properties: [{
      id: PROPERTY, brokerage_id: BROKERAGE, contact_id: BUYER, property_address: ADDRESS,
      list_price: 600000, saved_at: "2026-08-01T00:00:00Z", dismissed: false, listing_id: null,
      external_property_id: "ext-b", source: "rentcast", listing_url: null, listings: null,
    }],
    agent_client_messages: [], notifications: [], manager_signals: [],
    client_portal_activity: [], client_portal_messages: [],
  }
}

/** Install the stub implementations the intercepted modules dispatch to. */
function installStubs(client: any, access: any) {
  ;(globalThis as any).__PSV = {
    createServiceClient: () => client,
    requireContactAccess: async () => access,
    lookupPropertyByAddress: async () => ({ beds: 3, baths: 2, sqft: 1800, propertyType: "single_family", dataConfidence: "medium" }),
    getRentcastAVM: async () => ({ value: 615000, rangeLow: 590000, rangeHigh: 640000 }),
    getCurrentAvm: async () => ({ value: 610000, confidence: 0.6, source: "cache" }),
  }
}

const GRANTED = { ok: true, userId: "portal-user", brokerageId: BROKERAGE, isContactSelf: true, userType: null }
const REFUSED = { ok: false, error: "Forbidden" as const }

/** Every activity row the run actually handed to the database. */
const activityWrites = (log: any[]) => log.filter(q => q.table === "client_portal_activity" && q.op === "insert").map(q => q.payload as ActivityRow)
const notifyWrites = (log: any[]) => log.filter(q => q.table === "notifications" && q.op === "insert")

async function behaviourLayer() {
  const tools = await import("../app/actions/buyer-offer-tools")

  // ── V1 · the rows the buyer's clicks actually produce are inside a staff lane ──
  console.log("\n[behaviour · V1 — every row the actions write is inside the agent's read policy]")
  {
    const { client, log } = makeFakeSupabase(seedStore())
    installStubs(client, GRANTED)
    await tools.signalAffordabilityChecked({ contactId: BUYER, propertyId: PROPERTY, propertyAddress: ADDRESS, price: 600000, monthlyEstimate: 3900, verdict: "within_reach" })
    await tools.requestComparisonReview({ contactId: BUYER, addresses: [ADDRESS, "9 Elm Street"] })
    await tools.requestPreApprovalRefresh({ contactId: BUYER, propertyId: PROPERTY, propertyAddress: ADDRESS })
    await tools.analyzeAddressForBuyer({ contactId: BUYER, address: "77 Cedar Court, Raleigh NC" })
    await tools.requestOfferHelp({ contactId: BUYER, propertyId: PROPERTY, propertyAddress: ADDRESS })

    const rows = activityWrites(log)
    check(`all five actions record their signal (${rows.length} rows written)`, rows.length === 5, `${rows.length}`)
    check("EVERY row written is inside a staff lane of the SELECT policy — none is invisible to the agent",
      rows.length > 0 && rows.every(staffCanSee),
      `${rows.filter(r => !staffCanSee(r)).length} outside every staff lane`)
    check("…and the agent stamp is the AGENTS-class id, never the caller's users-class id",
      rows.every(r => r.agent_id === AGENTS_ID) && rows.every(r => r.agent_id !== AGENT_USER_ID))
    check("…and the tenant stamp is the contact's own brokerage",
      rows.every(r => r.brokerage_id === BROKERAGE))
  }

  // ── a buyer whose contact has NO agent still produces a row staff can reach ──
  {
    const { client, log } = makeFakeSupabase(seedStore({ agentId: null }))
    installStubs(client, GRANTED)
    await tools.signalAffordabilityChecked({ contactId: BUYER, propertyId: PROPERTY, propertyAddress: ADDRESS, price: 600000, monthlyEstimate: 3900, verdict: "within_reach" })
    const rows = activityWrites(log)
    check("an unassigned buyer's row still carries the tenant, so the BROKERAGE can still see it",
      rows.length === 1 && staffCanSee(rows[0]) && rows[0].agent_id === null,
      JSON.stringify(rows[0]))
  }

  // ── V2 · nobody is told the agent heard them when the agent did not ──
  console.log("\n[behaviour · V2 — no success is reported over an undelivered alert]")
  const NOTIFY_REFUSED: Fault[] = [{ table: "notifications", op: "insert", message: "permission denied" }]
  const notifiers = [
    { name: "signalAffordabilityChecked", run: (t: any) => t.signalAffordabilityChecked({ contactId: BUYER, propertyId: PROPERTY, propertyAddress: ADDRESS, price: 600000, monthlyEstimate: 3900, verdict: "within_reach" }) },
    { name: "requestComparisonReview", run: (t: any) => t.requestComparisonReview({ contactId: BUYER, addresses: [ADDRESS, "9 Elm Street"] }) },
    { name: "requestPreApprovalRefresh", run: (t: any) => t.requestPreApprovalRefresh({ contactId: BUYER, propertyId: PROPERTY, propertyAddress: ADDRESS }) },
    { name: "requestOfferHelp", run: (t: any) => t.requestOfferHelp({ contactId: BUYER, propertyId: PROPERTY, propertyAddress: ADDRESS }) },
  ]

  const refusedResults: Array<{ name: string; r: any }> = []
  for (const n of notifiers) {
    const { client } = makeFakeSupabase(seedStore(), NOTIFY_REFUSED)
    installStubs(client, GRANTED)
    refusedResults.push({ name: n.name, r: await n.run(tools) })
  }
  check("a REFUSED notification write is never reported to the buyer as success",
    refusedResults.every(({ r }) => r.success === false),
    refusedResults.filter(({ r }) => r.success).map(x => x.name).join(", "))
  check("…and each refusal comes back with something to SAY to the buyer, not a bare false",
    refusedResults.every(({ r }) => typeof r.error === "string" && r.error.length > 20),
    refusedResults.filter(({ r }) => !r.error).map(x => x.name).join(", "))
  check("…and the refusal names a route that does not depend on the rail that just failed",
    refusedResults.every(({ r }) => /message (them|the office)|reply to/i.test(String(r.error))),
    refusedResults.filter(({ r }) => !/message (them|the office)|reply to/i.test(String(r.error))).map(x => x.name).join(", "))

  const noAgentResults: Array<{ name: string; r: any }> = []
  for (const n of notifiers) {
    const { client } = makeFakeSupabase(seedStore({ agentId: null }))
    installStubs(client, GRANTED)
    noAgentResults.push({ name: n.name, r: await n.run(tools) })
  }
  check("a buyer with NO assigned agent is told so, never told an agent was notified",
    noAgentResults.every(({ r }) => r.success === false && /no agent is assigned/i.test(String(r.error))),
    noAgentResults.filter(({ r }) => r.success).map(x => x.name).join(", "))

  {
    const { client, log } = makeFakeSupabase(seedStore())
    installStubs(client, GRANTED)
    const r: any = await tools.signalAffordabilityChecked({ contactId: BUYER, propertyId: PROPERTY, propertyAddress: ADDRESS, price: 600000, monthlyEstimate: 3900, verdict: "within_reach" })
    check("success is reported only when a notification really was written",
      r.success === true && r.notified === true && notifyWrites(log).length === 1)
    check("…and the notification is addressed to the agent's USERS-class id (the bell's id space)",
      notifyWrites(log)[0]?.payload?.user_id === AGENT_USER_ID)
  }

  // ── the research tool's DIFFERENT contract, asserted rather than assumed ──
  console.log("\n[behaviour · the research tool — the analysis is the deliverable, and it says so]")
  {
    const { client, log } = makeFakeSupabase(seedStore(), [{ table: "client_portal_activity", op: "insert", message: "permission denied" }])
    installStubs(client, GRANTED)
    const r: any = await tools.analyzeAddressForBuyer({ contactId: BUYER, address: "77 Cedar Court, Raleigh NC" })
    check("a refused ledger write does NOT take the analysis away from the buyer",
      r.success === true && !!r.analysis)
    check("…but the ledger's failure is REPORTED, never swallowed — no caller can assume the agent saw it",
      r.recorded === false)
    check("…and this tool notifies nobody, so it makes no notification claim it could break",
      notifyWrites(log).length === 0)
  }
  {
    const { client, log } = makeFakeSupabase(seedStore())
    installStubs(client, GRANTED)
    const r: any = await tools.analyzeAddressForBuyer({ contactId: BUYER, address: "77 Cedar Court, Raleigh NC" })
    check("on the happy path it reports the ledger honestly too",
      r.success === true && r.recorded === true && activityWrites(log).length === 1)
  }

  // ── V3 · the gate, and that it fails CLOSED ──
  console.log("\n[behaviour · V3 — a refused caller writes NOTHING]")
  const allFive = [
    ...notifiers,
    { name: "analyzeAddressForBuyer", run: (t: any) => t.analyzeAddressForBuyer({ contactId: BUYER, address: "77 Cedar Court, Raleigh NC" }) },
  ]
  const refusedGate: Array<{ name: string; r: any; writes: number }> = []
  for (const n of allFive) {
    const { client, log } = makeFakeSupabase(seedStore())
    installStubs(client, REFUSED)
    const r = await n.run(tools)
    refusedGate.push({ name: n.name, r, writes: log.filter(q => q.op === "insert").length })
  }
  check(`all five actions REFUSE a caller the gate rejects (${refusedGate.length} checked)`,
    refusedGate.every(({ r }) => r.success === false),
    refusedGate.filter(({ r }) => r.success).map(x => x.name).join(", "))
  check("…and a rejected caller causes ZERO writes — the gate fails closed, not half-open",
    refusedGate.every(({ writes }) => writes === 0),
    refusedGate.filter(({ writes }) => writes > 0).map(x => `${x.name}:${x.writes}`).join(", "))
  check("…and the refusal tells the buyer what to DO, never the gate's internal vocabulary",
    refusedGate.every(({ r }) => typeof r.error === "string" && !/^(Forbidden|Unauthorized)$/.test(r.error) && /sign in|reply to|message/i.test(r.error)),
    refusedGate.map(x => String(x.r.error)).join(" | "))
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 3 — SOURCE: the write and read sites the behaviour layer cannot reach
// ─────────────────────────────────────────────────────────────────────────────
const TABLE = ["client", "portal", "activity"].join("_")

// TOMBSTONE (orphan doctrine §1.1) — the private `walk()` generator that stood
// here was one of 82 copies of the same readdirSync walker. The survivor is
// scripts/runtime-roots.ts:61 (`walkTs`), imported above.
//
// It enumerated DIRECTORIES, and a root-level FILE is not a directory, so
// `proxy.ts` — the Next 16 edge middleware, which gates auth and queries four
// tables with a SERVICE client on EVERY request — was outside this guard's corpus.
// A file that is never opened reports green, which is the failure shape §2 of
// CLAUDE.md names. `rootRuntimeFiles()` from the same survivor supplies it.
function* scanCorpus(dirs: string[]): Generator<string> {
  for (const d of dirs) yield* walkTs(join(ROOT, d))
  yield* rootRuntimeFiles(ROOT)
}

/** Balance braces from an opening `{` and return the literal, so a payload can be inspected. */
function objectLiteralAt(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}") { depth--; if (depth === 0) return text.slice(open, i + 1) }
  }
  return ""
}

interface Site { file: string; kind: "insert" | "select"; payload: string; window: string; lead: string }

/**
 * Find every touch of the ledger table and, for writes, RESOLVE the payload — inline object
 * literal or a hoisted `const`. Hoisting matters: long payloads are lifted above the call so the
 * tenant-scope guard's fixed window still sees the scoping evidence, and a proof that only
 * understood inline literals would go quietly blind exactly where the code is most careful.
 */
function findSites(): Site[] {
  const out: Site[] = []
  const needle = `.from("${TABLE}")`
  {
    for (const abs of scanCorpus(["app", "lib"])) {
      const text = readFileSync(abs, "utf8")
      let idx = text.indexOf(needle)
      while (idx !== -1) {
        const file = relative(ROOT, abs).replace(/\\/g, "/")
        const window = text.slice(idx, idx + 600)
        // The destructure sits BEFORE `.from(` (`const { error } = await svc.from(…)`), so the
        // preceding line is part of the call site. A window that only looked forward reported a
        // correctly-checked write as unchecked — the proof has to see the whole statement.
        const lead = text.slice(Math.max(0, idx - 160), idx)
        const insAt = window.indexOf(".insert(")
        const selAt = window.indexOf(".select(")
        if (insAt !== -1 && (selAt === -1 || insAt < selAt)) {
          const argStart = idx + insAt + ".insert(".length
          const rest = text.slice(argStart)
          const pad = rest.match(/^\s*/)?.[0].length ?? 0
          let payload = ""
          if (rest[pad] === "{") {
            payload = objectLiteralAt(text, argStart + pad)
          } else {
            const ident = rest.slice(pad).match(/^([A-Za-z_$][\w$]*)/)?.[1]
            if (ident) {
              const declIdx = text.indexOf(`const ${ident} = {`)
              if (declIdx !== -1) payload = objectLiteralAt(text, text.indexOf("{", declIdx))
            }
          }
          out.push({ file, kind: "insert", payload, window, lead })
        } else {
          out.push({ file, kind: "select", payload: "", window, lead })
        }
        idx = text.indexOf(needle, idx + 1)
      }
    }
  }
  return out
}

/** Does this payload BIND a column to a real expression (not the literal `null`)? */
function binds(payload: string, column: string): boolean {
  const m = payload.match(new RegExp(`\\b${column}\\s*:\\s*([^\\n,]+)`))
  if (!m) return false
  return m[1].trim().replace(/,$/, "") !== "null"
}

/**
 * Reads of this table, classified. Every read must be in exactly ONE of these maps: a NEW read
 * site fails the proof rather than slipping past it. The service-client reads bypass RLS, so the
 * tenant bound is the FILTER or it does not exist — and scoping them is only possible because the
 * writers now stamp the tenant, which is the whole point of stamping them.
 */
const READS_NEEDING_A_TENANT_FILTER: Record<string, string> = {
  "lib/intelligence/daily-briefing-generator.ts": "service client — an unbounded read spends its row cap on other tenants' rows and starves this agent's own",
  "lib/kernel/client-story-drafts.ts": "service client — the engagement count feeds a story about how active this buyer was",
  "app/actions/journey-tasks.ts": "service client — reads a contact's completions back for the portal",
}
const READS_BOUND_BY_RLS: Record<string, string> = {
  "app/actions/contact-details.ts": "cookie-session client — RLS is the tenant bound, and the caller is already authorized on this contact",
}

function sourceLayer() {
  const sites = findSites()
  const writes = sites.filter(s => s.kind === "insert")
  const reads = sites.filter(s => s.kind === "select")

  console.log(`\n[source · V1 — every write site, payload resolved and run through the policy model]`)
  check(`every write site's payload was RESOLVED (a payload this proof cannot read proves nothing)`,
    writes.length > 0 && writes.every(w => w.payload.length > 0),
    writes.filter(w => !w.payload).map(w => w.file).join(", "))

  const outside = writes.filter(w => !staffCanSee({
    brokerage_id: binds(w.payload, "brokerage_id") ? "bound" : null,
    agent_id: binds(w.payload, "agent_id") ? "bound" : null,
  }))
  check(`every write site puts its row inside a staff lane (${writes.length} sites)`,
    outside.length === 0,
    outside.map(w => w.file).join(", "))

  // supabase-js RESOLVES a refused write: a `.then(ok, err)` reject arm and a bare try/catch are
  // both error checks that are GUARANTEED not to run, and a write with no destructure at all has
  // no check to begin with. All three are the same defect. Known debt is NAMED here rather than
  // waved through, so it can only shrink — a new site fails this proof.
  const UNCHECKED_DEBT: Record<string, string> = {
    "app/actions/portal-seller.ts":
      "OUT OF SCOPE for this wave and REPORTED, not silently allowed: its row IS tenant-stamped, so the visibility defect this proof exists for is already closed there. What remains is that a REFUSED write leaves no trace — the `.then(ok, err)` reject arm cannot fire against a promise that resolves. Owner decision to fix; the file was outside the editable scope of this change.",
  }

  // The destructure may sit on either side of the call, so both halves of the statement are read.
  const unchecked = writes.filter(w => !/const\s*\{[^}]*\berror\b/.test(w.lead + w.window))
  const undocumented = unchecked.filter(w => !UNCHECKED_DEBT[w.file])
  check("no NEW write site discards its outcome — every one destructures an error it can actually see",
    undocumented.length === 0, undocumented.map(w => w.file).join(", "))
  check(`the unchecked-write debt is exactly the ${Object.keys(UNCHECKED_DEBT).length} site(s) NAMED in this proof — it may only shrink`,
    unchecked.length <= Object.keys(UNCHECKED_DEBT).length,
    `${unchecked.length} found: ${unchecked.map(w => w.file).join(", ")}`)

  // A bare try/catch around a supabase call catches NOTHING for the same reason.
  const tryWrapped = writes.filter(w => /try\s*\{\s*$/.test(w.lead.trimEnd()) || /try\s*\{\s*\n\s*await\s+\w+\s*$/.test(w.lead))
  check("no write site is wrapped in a bare try/catch standing in for an error check",
    tryWrapped.length === 0, tryWrapped.map(w => w.file).join(", "))

  console.log(`\n[source · every read of the ledger is classified, and the RLS-bypassing ones are bounded]`)
  const readFiles = [...new Set(reads.map(r => r.file))]
  const unclassified = readFiles.filter(f => !READS_NEEDING_A_TENANT_FILTER[f] && !READS_BOUND_BY_RLS[f])
  check(`every read site is classified (${readFiles.length} files) — a new one must be judged, not ignored`,
    unclassified.length === 0, unclassified.join(", "))
  const unbounded = reads.filter(r => READS_NEEDING_A_TENANT_FILTER[r.file] && !/brokerage_id/.test(r.window))
  check("every RLS-BYPASSING read carries a tenant filter — it cannot read across the platform",
    unbounded.length === 0, unbounded.map(r => r.file).join(", "))

  console.log("\n[source · V3 — one shared gate, applied before anything is written]")
  const tools = src("app/actions/buyer-offer-tools.ts")
  const FIVE = ["signalAffordabilityChecked", "requestOfferHelp", "analyzeAddressForBuyer", "requestComparisonReview", "requestPreApprovalRefresh"]
  const bodies = FIVE.map((name) => {
    const start = tools.indexOf(`export async function ${name}(`)
    if (start < 0) return { name, body: "" }
    const nextStarts = FIVE.map(n => tools.indexOf(`export async function ${n}(`)).filter(i => i > start)
    const end = nextStarts.length ? Math.min(...nextStarts) : tools.length
    return { name, body: tools.slice(start, end) }
  })
  check(`all five actions were located in the source (${bodies.filter(b => b.body).length}/5)`,
    bodies.every(b => b.body.length > 0), bodies.filter(b => !b.body).map(b => b.name).join(", "))

  const ungated = bodies.filter(b => !/requireContactAccess\(\s*input\.contactId\s*\)/.test(b.body))
  check("all five authorize through the shared portal gate", ungated.length === 0, ungated.map(b => b.name).join(", "))

  const lateGate = bodies.filter((b) => {
    const gate = b.body.indexOf("requireContactAccess(")
    const firstClient = b.body.indexOf("createServiceClient(")
    return gate < 0 || (firstClient > 0 && gate > firstClient)
  })
  check("…and the gate runs BEFORE a privileged client is ever built", lateGate.length === 0, lateGate.map(b => b.name).join(", "))

  // "One gate" is the point: wave 14 removed a second auth pattern and it must not grow back.
  const authImports = (tools.match(/^import .*(require-contact-access|auth\/|getUser)\b.*$/gm) ?? [])
  check("the file carries exactly ONE portal authorization import — no second auth pattern",
    authImports.length === 1, authImports.join(" | "))
  check("no action reaches for the auth user directly instead of the gate",
    !/auth\.getUser\(/.test(tools))

  console.log("\n[source · the portal UI does not print a success title over a failure]")
  const CARDS: Array<[string, string]> = [
    ["app/portal/[contactId]/properties/[propertyId]/BuyerOfferToolsCard.tsx", "signalAffordabilityChecked"],
    ["app/portal/[contactId]/properties/[propertyId]/BuyerOfferToolsCard.tsx", "requestPreApprovalRefresh"],
    ["app/portal/[contactId]/properties/CompareHomesCard.tsx", "requestComparisonReview"],
    ["app/portal/[contactId]/search/AnalyzeAnyHomeCard.tsx", "signalAffordabilityChecked"],
  ]
  for (const [file, action] of CARDS) {
    const text = src(file)
    const at = text.indexOf(`await ${action}(`)
    const region = at > 0 ? text.slice(at, at + 700) : ""
    check(`${file.split("/").pop()} · the ${action} toast BRANCHES on the server's verdict`,
      /r\.success\s*$|r\.success\s*\n|toast\(r\.success/.test(region) || /r\.success/.test(region), region.slice(0, 80))
    // The failure arm must not assert the very thing that failed.
    const failArm = region.slice(region.indexOf(": {"))
    check(`${file.split("/").pop()} · …and its FAILURE arm never claims the agent was reached`,
      !/has been notified"|will weigh in"|will help you refresh"/.test(failArm.slice(0, 260)),
      failArm.slice(0, 120))
    check(`${file.split("/").pop()} · …and shows the server's own sentence rather than a hard-coded excuse`,
      /r\.error/.test(failArm.slice(0, 260)))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEGATIVE CONTROLS — re-introduce each defect, CONFIRM the patch applied, require RED
// ─────────────────────────────────────────────────────────────────────────────
interface Control { name: string; file: string; find: string; replace: string; expect: string }

const CONTROLS: Control[] = [
  {
    name: "V1 — the natural-language search signal goes back to being written with no tenant",
    file: "app/actions/portal-nl-search.ts",
    find: `    brokerage_id: (contact as { brokerage_id: string | null }).brokerage_id,
    contact_id: input.contactId,
    agent_id: (contact as { agent_id: string | null }).agent_id,`,
    replace: `    contact_id: input.contactId,`,
    expect: "every write site puts its row inside a staff lane",
  },
  {
    name: "V1 — the showing request goes back to being written with no tenant",
    file: "app/actions/showings.ts",
    find: `      brokerage_id:  brokerageId,
      contact_id:    data.contactId,
      agent_id:      contactForBBA?.agent_id ?? null,`,
    replace: `      contact_id:    data.contactId,`,
    expect: "every write site puts its row inside a staff lane",
  },
  {
    // The anchor carries the following line as well: `agent_id: args.agentId,` occurs TWICE in
    // this file (the activity row and the portal thread message), and String.replace rewrites
    // only the first. The patch-applied confirmation caught that; a control that half-applies
    // proves nothing, which is exactly the failure mode this step exists to catch.
    name: "V1 — a buyer-tool row loses its agent stamp",
    file: "app/actions/buyer-offer-tools.ts",
    // RE-ANCHORED 2026-09-03. The old anchor's second line was the `// loose uuid
    // ref` comment, which wave 26 replaced with the real `property_id` write when
    // that column stopped being carried only inside metadata. A control whose
    // patch cannot apply proves NOTHING, and this one says so out loud rather
    // than passing — which is how the drift was caught. Anchored on the two
    // adjacent WRITES instead of a comment, so the next edit to the surrounding
    // prose cannot silently disarm it.
    find: `    agent_id: args.agentId,
    property_id:`,
    replace: `    agent_id: null,
    property_id:`,
    expect: "the agent stamp is the AGENTS-class id",
  },
  {
    name: "V2 — the pre-approval request reports success over an undelivered alert",
    file: "app/actions/buyer-offer-tools.ts",
    find: `      return { success: false, notified: false, recorded, error: notifyRefusal(notified.reason, recorded, "your pre-approval request") }`,
    replace: `      return { success: true, notified: false, recorded }`,
    expect: "a REFUSED notification write is never reported to the buyer as success",
  },
  {
    name: "V3 — requestComparisonReview loses its gate",
    file: "app/actions/buyer-offer-tools.ts",
    find: `    const access = await requireContactAccess(input.contactId)
    if (!access.ok) return { success: false, error: accessRefusal(access.error) }

    const svc = createServiceClient()
    const resolved = await resolveContactAgent(svc, input.contactId, access.brokerageId)
    if (!resolved.ok) {
      return resolved.reason === "unreadable"
        ? { success: false, error: "We couldn't reach your account just now — please try again." }
        : { success: false, error: "We couldn't find your client record — reply to your agent's last message and they'll pick this up." }
    }
    const { contact, agentUserId } = resolved

    const recorded = await recordPortalActivity(svc, {
      contactId: input.contactId, brokerageId: contact.brokerage_id, agentId: contact.agent_id,
      activityType: "comparison_review_requested",`,
    replace: `    const svc = createServiceClient()
    const resolved = await resolveContactAgent(svc, input.contactId)
    if (!resolved.ok) {
      return resolved.reason === "unreadable"
        ? { success: false, error: "We couldn't reach your account just now — please try again." }
        : { success: false, error: "We couldn't find your client record — reply to your agent's last message and they'll pick this up." }
    }
    const { contact, agentUserId } = resolved

    const recorded = await recordPortalActivity(svc, {
      contactId: input.contactId, brokerageId: contact.brokerage_id, agentId: contact.agent_id,
      activityType: "comparison_review_requested",`,
    expect: "all five authorize through the shared portal gate",
  },
  {
    name: "V3 — the research tool loses its gate (its return differs; its gate must not)",
    file: "app/actions/buyer-offer-tools.ts",
    find: `    const access = await requireContactAccess(input.contactId)
    if (!access.ok) return { success: false, error: accessRefusal(access.error) }

    const svc = createServiceClient()
    const resolved = await resolveContactAgent(svc, input.contactId, access.brokerageId)
    if (!resolved.ok) {
      return resolved.reason === "unreadable"
        ? { success: false, error: "We couldn't reach your account just now — please try again." }
        : { success: false, error: "We couldn't find your client record — reply to your agent's last message and they'll pick this up." }
    }
    const brokerageId = resolved.contact.brokerage_id`,
    replace: `    const svc = createServiceClient()
    const resolved = await resolveContactAgent(svc, input.contactId)
    if (!resolved.ok) {
      return resolved.reason === "unreadable"
        ? { success: false, error: "We couldn't reach your account just now — please try again." }
        : { success: false, error: "We couldn't find your client record — reply to your agent's last message and they'll pick this up." }
    }
    const brokerageId = resolved.contact.brokerage_id`,
    expect: "all five authorize through the shared portal gate",
  },
  {
    name: "READ SIDE — the morning briefing goes back to reading activity across every tenant",
    file: "lib/intelligence/daily-briefing-generator.ts",
    find: `      .eq("brokerage_id", brokerageId)
      .gte("created_at", since24)`,
    replace: `      .gte("created_at", since24)`,
    expect: "every RLS-BYPASSING read carries a tenant filter",
  },
  {
    name: "UI — the comparison card promises the agent will weigh in on a failed send",
    file: "app/portal/[contactId]/properties/CompareHomesCard.tsx",
    find: `        : { title: "Your agent wasn't reached", description: r.error ?? "Pick at least two homes", variant: "destructive" })`,
    replace: `        : { title: "Your agent will weigh in", description: r.error ?? "Pick at least two homes", variant: "destructive" })`,
    expect: "its FAILURE arm never claims the agent was reached",
  },
]

function runChild(): { code: number; out: string } {
  const r = spawnSync("npx", ["tsx", "scripts/portal-signal-visibility-simulator.ts", "--assert-only"], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, PSV_SIM_CHILD: "1" },
  })
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

function runControls(): boolean {
  console.log("\n" + "═".repeat(78))
  console.log("NEGATIVE CONTROLS — each defect re-introduced, patch confirmed, RED required")
  console.log("═".repeat(78))
  let allOk = true
  for (const c of CONTROLS) {
    const path = join(ROOT, c.file)
    const original = readFileSync(path, "utf8")
    console.log(`\n· ${c.name}`)
    if (!original.includes(c.find)) {
      console.log(`   PATCH DID NOT APPLY — anchor not found in ${c.file}. Control proves nothing.`)
      allOk = false
      continue
    }
    writeFileSync(path, original.replace(c.find, c.replace))
    const patched = readFileSync(path, "utf8")
    const applied = patched.includes(c.replace) && !patched.includes(c.find)
    console.log(`   patch applied: ${applied ? "CONFIRMED (defect text present, fixed text absent)" : "NOT CONFIRMED"}`)
    if (!applied) { writeFileSync(path, original); allOk = false; continue }

    const red = runChild()
    const named = red.out.split("\n").some(l => l.trimStart().startsWith("✗") && l.includes(c.expect))
    console.log(`   observed: ${red.code !== 0 ? "RED" : "GREEN"} (exit ${red.code})${named ? ` — assertion "${c.expect}" failed as designed` : ""}`)
    if (red.code === 0 || !named) { allOk = false; console.log(`   ✗ control did not turn the intended assertion red`) }

    writeFileSync(path, original)
    const restored = readFileSync(path, "utf8") === original
    const green = runChild()
    console.log(`   restored: ${restored ? "CONFIRMED" : "FAILED"} · observed: ${green.code === 0 ? "GREEN" : "RED"} (exit ${green.code})`)
    if (!restored || green.code !== 0) { allOk = false; console.log("   ✗ restore did not return the suite to green") }
  }
  return allOk
}

async function main() {
  console.log("═".repeat(78))
  console.log("PORTAL SIGNAL VISIBILITY — the buyer's click reaches a human, or the buyer is told")
  console.log("═".repeat(78))
  policyLayer()
  await behaviourLayer()
  sourceLayer()

  console.log("\n" + "─".repeat(78))
  console.log(`${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log("FAILURES:"); fails.forEach(f => console.log(`  · ${f}`)) }

  const assertOnly = CHILD || process.argv.includes("--assert-only")
  if (assertOnly) { process.exit(fail > 0 ? 1 : 0); return }
  if (fail > 0) { process.exit(1); return }

  const controlsOk = runControls()
  console.log("\n" + "─".repeat(78))
  if (!controlsOk) { console.log("✗ one or more negative controls did not behave — the proof is not trustworthy"); process.exit(1) }
  console.log(`✅ ${pass} assertions green · ${CONTROLS.length} negative controls confirmed red-then-green`)
}

main().catch((e) => { console.error(e); process.exit(1) })
