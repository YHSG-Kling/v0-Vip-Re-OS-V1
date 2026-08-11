#!/usr/bin/env tsx
/**
 * scripts/buyer-offer-request-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUYER'S OFFER BUTTON — proves the three places where it used to promise something it
 * did not deliver are closed, as CONSTRUCTS (never spellings — a re-word must not fail this):
 *
 *   W1  the brief the AGENT receives is about the property the buyer actually clicked.
 *       (It was built from the top of the buyer's SAVED list while the agent's alert named a
 *       different address.)
 *   W2  idempotency is per (buyer, PROPERTY): the second property produces a second brief,
 *       the same property twice produces one — no duplicate alert, no silent nothing.
 *   W3  the buyer is never told a plan is being prepared when none was, and the recommended
 *       price never reaches them un-approved (the agent approves the brief and delivers it).
 *
 * Layers
 *   · PURE     — buildOfferHelpAcknowledgement across EVERY outcome.
 *   · BEHAVIOR — the real produceOfferStrategyBrief run against an in-memory Supabase stub
 *                (no creds, no network): what it reads, what it writes, and what it refuses.
 *   · SOURCE   — the wiring the behaviour layer cannot see (the button's ordering, the rail
 *                the durable message rides, no swallowed supabase error on this path).
 *
 * NEGATIVE CONTROLS: run with no flag and this harness re-introduces each defect INTO THE
 * SOURCE, greps to confirm the patch actually applied, re-runs itself in a child process and
 * requires RED, restores, and requires GREEN. A control that silently fails to apply proves
 * nothing, so the patch confirmation is printed for each.
 *
 * Run: npx tsx scripts/buyer-offer-request-simulator.ts
 *      npx tsx scripts/buyer-offer-request-simulator.ts --assert-only   (skip the controls)
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { spawnSync } from "node:child_process"

// `server-only` is a build marker that throws outside a React Server Component. The producer
// pulls in modules that carry it, so it is neutralised here — this is the ONLY way to execute
// the real production function in a plain script instead of asserting about it from the outside.
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (spec === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true }
    return next(spec, ctx)
  },
})

const ROOT = process.cwd()
const CHILD = process.env.BOR_SIM_CHILD === "1"
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ── Constructs (not spellings) ───────────────────────────────────────────────
/** Any claim that work on a plan is under way. */
const PROMISES_A_PLAN = /(prepar|draft|work)\w*\s+(your|their|the)?\s*(offer\s+)?plan|plan\s+is\s+(being\s+)?(prepar|draft)/i
/** Any money figure — a recommended price, a range bound, an earnest amount. */
const MONEY_FIGURE = /\$\s?[\d,]+|\b\d{1,3}(,\d{3})+\b|\b\d{4,}\b/

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — PURE: what the buyer is told, for every outcome the run can have
// ─────────────────────────────────────────────────────────────────────────────
async function pureLayer() {
  console.log("\n[pure · buildOfferHelpAcknowledgement — the promise matches what happened]")
  const { buildOfferHelpAcknowledgement } = await import("../lib/agents/offer-strategy-producer")
  const OUTCOMES = [
    "proposed", "already_proposed", "invalid_input", "contact_unreadable", "contact_not_found",
    "wrong_tenant", "dedupe_unreadable", "propose_failed", "no_tenant", "accelerator_error",
  ] as const

  const ADDRESS = "123 Oak Lane"
  const acks = OUTCOMES.map((outcome) => ({
    outcome, ack: buildOfferHelpAcknowledgement({ buyerFirstName: "Rio", propertyAddress: ADDRESS, outcome }),
  }))

  check("a plan is claimed to the buyer ONLY on the outcome that wrote one",
    acks.every(({ ack }) => PROMISES_A_PLAN.test(ack.buyerMessage) === ack.planPrepared),
    acks.filter(({ ack }) => PROMISES_A_PLAN.test(ack.buyerMessage) !== ack.planPrepared).map(a => a.outcome).join(", "))
  check("…and the agent's alert makes the same claim as the buyer's message (they cannot disagree)",
    acks.every(({ ack }) => PROMISES_A_PLAN.test(ack.agentBody) === ack.planPrepared ||
      (ack.planPrepared && /queue|waiting/i.test(ack.agentBody))))
  check("exactly one outcome sets planPrepared — the one that proposed a brief",
    acks.filter(({ ack }) => ack.planPrepared).map(a => a.outcome).join(",") === "proposed")
  check("NO variant carries a money figure — the recommended price is the agent's to deliver",
    acks.every(({ ack }) => !MONEY_FIGURE.test(ack.buyerMessage)),
    acks.filter(({ ack }) => MONEY_FIGURE.test(ack.buyerMessage)).map(a => a.outcome).join(", "))
  check("every variant names the home the buyer asked about",
    acks.every(({ ack }) => ack.buyerMessage.includes(ADDRESS)))
  check("every variant says the offer has NOT been sent to the seller (a click is a signal, not a legal act)",
    acks.every(({ ack }) => /not been sent|haven't sent|writes and submits/i.test(ack.buyerMessage)))
  check("a repeat ask is flagged as a duplicate and says no second alert went out",
    acks.find(a => a.outcome === "already_proposed")!.ack.duplicate &&
    /already/i.test(acks.find(a => a.outcome === "already_proposed")!.ack.buyerMessage))
  check("only the repeat ask is a duplicate",
    acks.filter(({ ack }) => ack.duplicate).map(a => a.outcome).join(",") === "already_proposed")

  const noAddress = buildOfferHelpAcknowledgement({ buyerFirstName: null, outcome: "proposed" })
  check("a missing address degrades honestly (no dangling 'on undefined')", !/undefined|null|\son\s*\./i.test(noAddress.buyerMessage))
  const poisoned = buildOfferHelpAcknowledgement({
    buyerFirstName: "Rio", propertyAddress: "12 Elm — perfect for christian families", outcome: "proposed",
  })
  check("a poisoned address is sanitized before it reaches the buyer or the agent",
    !/perfect for|christian families/i.test(poisoned.buyerMessage + poisoned.agentBody))
  check("the button's toast and the durable thread message are the SAME sentence",
    acks.every(({ ack }) => ack.clientMessage === ack.buyerMessage))
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — BEHAVIOUR: the real producer, against an in-memory Supabase stub
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
      neq: () => api,
      not: () => api,
      gte: () => api,
      in: (c: string, v: any[]) => { ins.push([c, v]); return api },
      order: () => api,
      limit: () => api,
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
const PROP_A = "33333333-3333-4333-8333-333333333333" // saved most recently
const PROP_B = "44444444-4444-4444-8444-444444444444" // saved earlier — the one they click
const ADDR_A = "9 Newest Save Road"
const ADDR_B = "123 Oak Lane"

function seedStore(): Record<string, Row[]> {
  return {
    contacts: [{ id: BUYER, brokerage_id: BROKERAGE, agent_id: "agent-1", first_name: "Rio", timeline: "asap" }],
    agents: [{ id: "agent-1", user_id: "user-1" }],
    users: [{ id: "user-1", first_name: "Dana", last_name: "Kling" }],
    buyer_financial_profiles: [],
    saved_properties: [
      { id: PROP_A, brokerage_id: BROKERAGE, contact_id: BUYER, property_address: ADDR_A, list_price: 700000, saved_at: "2026-08-10T00:00:00Z", dismissed: false, listing_id: null, external_property_id: "ext-a", source: "rentcast", listing_url: null, listings: null },
      { id: PROP_B, brokerage_id: BROKERAGE, contact_id: BUYER, property_address: ADDR_B, list_price: 600000, saved_at: "2026-08-01T00:00:00Z", dismissed: false, listing_id: null, external_property_id: "ext-b", source: "rentcast", listing_url: null, listings: null },
    ],
    agent_client_messages: [],
    notifications: [],
    manager_signals: [],
  }
}

async function behaviourLayer() {
  console.log("\n[behaviour · produceOfferStrategyBrief against an in-memory store]")
  const { produceOfferStrategyBrief, OFFER_STRATEGY_BRIEF_ENTITY_TYPE } =
    await import("../lib/agents/offer-strategy-producer")

  const briefs = (store: Record<string, Row[]>) =>
    (store.agent_client_messages ?? []).filter(r => r.entity_type === OFFER_STRATEGY_BRIEF_ENTITY_TYPE)

  // ── W1 — the buyer clicks the OLDER save. The brief must be about THAT home. ──
  {
    const { client, log, store } = makeFakeSupabase(seedStore())
    const r = await produceOfferStrategyBrief(BROKERAGE, BUYER, client, { savedPropertyId: PROP_B, propertyAddress: ADDR_B })
    const row = briefs(store)[0]
    check("W1 · the click produces one brief", r.proposed === 1 && r.outcome === "proposed" && !!row, `outcome=${r.outcome}`)
    check("W1 · the brief is keyed to the property that was asked about, not the buyer",
      row?.entity_id === PROP_B, `entity_id=${row?.entity_id}`)
    check("W1 · the agent's plan NAMES the home that was clicked",
      typeof row?.rationale === "string" && row.rationale.includes(ADDR_B), row?.rationale)
    check("W1 · …and does NOT describe the buyer's most-recently-saved OTHER home",
      typeof row?.rationale === "string" && !row.rationale.includes(ADDR_A), row?.rationale)
    check("W1 · the property read is scoped to the clicked row (not a scan of the saved list)",
      log.some(q => q.table === "saved_properties" && q.filters.some(([c, v]) => c === "id" && v === PROP_B)))
    check("W1 · the result reports the address the brief is actually about", r.propertyAddress === ADDR_B)

    // ── the gate survives: agent-facing plan, buyer-facing copy, nothing sent ──
    check("gate · the brief lands as a PROPOSAL for the agent, addressed to the buyer",
      row?.status === "proposed" && row?.audience === "buyer" && row?.recipient_contact_id === BUYER)
    check("gate · the producer writes nothing to the buyer's portal message thread",
      !log.some(q => q.table === "client_portal_messages" && q.op === "insert"))
    check("gate · the buyer-facing body of the brief carries no money figure",
      typeof row?.body === "string" && !MONEY_FIGURE.test(row.body), row?.body)
  }

  // ── W2 — same home twice is one brief; a second home is a second brief ──
  {
    const { client, store } = makeFakeSupabase(seedStore())
    const first = await produceOfferStrategyBrief(BROKERAGE, BUYER, client, { savedPropertyId: PROP_B, propertyAddress: ADDR_B })
    const again = await produceOfferStrategyBrief(BROKERAGE, BUYER, client, { savedPropertyId: PROP_B, propertyAddress: ADDR_B })
    check("W2 · asking twice about the SAME home does not write a second brief",
      first.proposed === 1 && again.proposed === 0 && briefs(store).length === 1, `again=${again.outcome}`)
    check("W2 · …and the repeat is reported as a duplicate, never as a plain failure",
      again.outcome === "already_proposed", again.outcome)

    const other = await produceOfferStrategyBrief(BROKERAGE, BUYER, client, { savedPropertyId: PROP_A, propertyAddress: ADDR_A })
    check("W2 · a DIFFERENT home produces its own brief",
      other.proposed === 1 && other.outcome === "proposed" && briefs(store).length === 2, `outcome=${other.outcome}`)
    check("W2 · the two briefs are keyed to the two different homes",
      new Set(briefs(store).map(r => r.entity_id)).size === 2)
  }

  // ── the journey-stage lane (no property named) is unchanged: one per buyer ──
  {
    const { client, store } = makeFakeSupabase(seedStore())
    const j1 = await produceOfferStrategyBrief(BROKERAGE, BUYER, client)
    const j2 = await produceOfferStrategyBrief(BROKERAGE, BUYER, client)
    check("journey lane · still one brief per buyer journey when no property is named",
      j1.proposed === 1 && j2.proposed === 0 && briefs(store).length === 1)
    check("journey lane · still keyed on the buyer", briefs(store)[0]?.entity_id === BUYER)
  }

  // ── honesty — a refused read is not "this buyer has no saved homes" ──
  {
    const { client, store } = makeFakeSupabase(seedStore(), [{ table: "contacts", op: "select", message: "permission denied" }])
    const r = await produceOfferStrategyBrief(BROKERAGE, BUYER, client, { savedPropertyId: PROP_B, propertyAddress: ADDR_B })
    check("honesty · a REFUSED contact read is reported as unreadable, not as an absent buyer",
      r.proposed === 0 && r.outcome === "contact_unreadable", r.outcome)
    check("honesty · …and nothing is proposed on a refused read", briefs(store).length === 0)
  }
  {
    const { client } = makeFakeSupabase({ ...seedStore(), contacts: [] })
    const r = await produceOfferStrategyBrief(BROKERAGE, BUYER, client, { savedPropertyId: PROP_B, propertyAddress: ADDR_B })
    check("honesty · a genuinely missing buyer is a DIFFERENT outcome from a refused read",
      r.outcome === "contact_not_found", r.outcome)
  }
  {
    const { client, store } = makeFakeSupabase(seedStore(), [{ table: "agent_client_messages", op: "select", message: "permission denied" }])
    const r = await produceOfferStrategyBrief(BROKERAGE, BUYER, client, { savedPropertyId: PROP_B, propertyAddress: ADDR_B })
    check("honesty · a refused idempotency probe FAILS CLOSED (no risk of a duplicate alert)",
      r.outcome === "dedupe_unreadable" && briefs(store).length === 0, r.outcome)
  }
  {
    const { client } = makeFakeSupabase(seedStore(), [{ table: "agent_client_messages", op: "insert", message: "permission denied" }])
    const r = await produceOfferStrategyBrief(BROKERAGE, BUYER, client, { savedPropertyId: PROP_B, propertyAddress: ADDR_B })
    check("honesty · a refused gate WRITE is reported as a failure, never as 'already briefed'",
      r.proposed === 0 && r.outcome === "propose_failed", r.outcome)
  }
  {
    const { client } = makeFakeSupabase(seedStore())
    const r = await produceOfferStrategyBrief(BROKERAGE, BUYER, client, { savedPropertyId: "not-a-uuid", propertyAddress: ADDR_B })
    check("honesty · a property reference that cannot key the gate is refused, not collapsed onto the buyer",
      r.proposed === 0 && r.outcome === "invalid_input", r.outcome)
  }
  {
    const { client } = makeFakeSupabase(seedStore())
    const r = await produceOfferStrategyBrief("99999999-9999-4999-8999-999999999999", BUYER, client, { savedPropertyId: PROP_B })
    check("tenancy · another brokerage's caller gets nothing, named as such", r.outcome === "wrong_tenant", r.outcome)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 3 — SOURCE: the wiring around the producer
// ─────────────────────────────────────────────────────────────────────────────
function sourceLayer() {
  console.log("\n[source · the button's wiring]")
  const tools = src("app/actions/buyer-offer-tools.ts")
  const fnStart = tools.indexOf("export async function requestOfferHelp")
  const fn = fnStart > 0 ? tools.slice(fnStart) : ""
  check("requestOfferHelp exists", fn.length > 0)

  check("the clicked property is handed to the producer (the plan is about THAT home)",
    /produceOfferStrategyBrief\([\s\S]{0,220}savedPropertyId:\s*input\.propertyId/.test(fn))
  const acceleratorIdx = fn.indexOf("produceOfferStrategyBrief")
  const ackIdx = fn.indexOf("buildOfferHelpAcknowledgement")
  const notifyIdx = fn.indexOf("notifyAgent(")
  const threadIdx = fn.indexOf("writeBuyerThreadMessage(")
  check("what anyone is told is DERIVED from the run's outcome, not asserted up front",
    acceleratorIdx > 0 && ackIdx > acceleratorIdx && notifyIdx > ackIdx)
  check("a duplicate ask returns BEFORE the agent is alerted again",
    /ack\.duplicate[\s\S]{0,200}return[\s\S]{0,400}notifyAgent\(/.test(fn))
  check("the durable buyer message rides the EXISTING portal thread rail",
    /\.from\("client_portal_messages"\)[\s\S]{0,300}direction:\s*"agent_to_client"/.test(tools))
  check("…and is exactly the acknowledgement sentence — nothing appended to it",
    threadIdx > 0 && /body:\s*ack\.buyerMessage,/.test(fn))
  check("the buyer is not told their agent was alerted when the alert failed",
    /!notified\.ok[\s\S]{0,400}success:\s*false/.test(fn))
  check("the caller is authorized before anything is written on their behalf",
    /requireContactAccess\(input\.contactId\)/.test(fn) && fn.indexOf("requireContactAccess") < acceleratorIdx)

  console.log("\n[source · no swallowed supabase errors on this path]")
  const writes = [...tools.matchAll(/await\s+supabase\s*\n?\s*\.from\([^)]*\)\s*\n?\s*\.(insert|update|upsert|delete)\(/g)]
  const bare = writes.filter(m => !/const\s*\{[^}]*error[^}]*\}\s*=\s*$/.test(tools.slice(Math.max(0, m.index! - 90), m.index!)))
  check(`every supabase write in the file destructures its error (${writes.length} writes, ${bare.length} bare)`, bare.length === 0)
  check("no bare try/catch is left standing in for a supabase error check",
    !/try\s*\{\s*\n\s*await supabase/.test(tools))

  console.log("\n[source · the producer keeps the price on the agent's side]")
  const producer = src("lib/agents/offer-strategy-producer.ts")
  check("the concrete plan (with numbers) goes into the agent-facing rationale",
    /baseRationale\s*=\s*strategySummary/.test(producer))
  check("…and never into the buyer-facing body",
    !/body:\s*[^,\n]*strategySummary/.test(producer) && /body:\s*msg\.body/.test(producer))
  check("the buyer-facing copy is generated with numbers disallowed", /allowNumbers:\s*false/.test(producer))
  check("the gate row is written as a PROPOSAL for a human to approve", /status:\s*"proposed"/.test(src("lib/agents/agent-client-messages.ts")))

  console.log("\n[source · the card no longer promises a plan unconditionally]")
  const card = src("app/portal/[contactId]/properties/[propertyId]/BuyerOfferToolsCard.tsx")
  const helpFn = card.slice(card.indexOf("function helpMakeOffer"))
  check("the toast branches on what the server actually did",
    /r\.duplicate/.test(helpFn) && /r\.accelerated/.test(helpFn))
  check("…and shows the server's own sentence rather than a hard-coded promise",
    /description:\s*r\.message/.test(helpFn))
}

// ─────────────────────────────────────────────────────────────────────────────
// NEGATIVE CONTROLS — re-introduce each defect, CONFIRM the patch applied, require RED
// ─────────────────────────────────────────────────────────────────────────────
interface Control { name: string; file: string; find: string; replace: string; expect: string }

const CONTROLS: Control[] = [
  {
    name: "W1 — target reverts to the buyer's most-recently-saved home",
    file: "lib/agents/offer-strategy-producer.ts",
    find: "    let savedRows: any[] = []\n    if (savedPropertyId) {",
    replace: "    let savedRows: any[] = []\n    if (false && savedPropertyId) {",
    expect: "the agent's plan NAMES the home that was clicked",
  },
  {
    name: "W2 — idempotency key reverts to one brief per BUYER",
    file: "lib/agents/offer-strategy-producer.ts",
    find: "  const briefEntityId = savedPropertyId ?? contactId",
    replace: "  const briefEntityId = contactId",
    expect: "a DIFFERENT home produces its own brief",
  },
  {
    name: "W3 — the buyer is promised a plan on every outcome",
    file: "lib/agents/offer-strategy-producer.ts",
    find: "    : `${asked} ${inTouch} ${notSubmitted}`",
    replace: "    : `${asked} ${inTouch} They're preparing your offer plan now. ${notSubmitted}`",
    expect: "a plan is claimed to the buyer ONLY on the outcome that wrote one",
  },
  {
    name: "EGRESS — the recommended price is quoted to the buyer un-approved",
    file: "lib/agents/offer-strategy-producer.ts",
    find: '  const notSubmitted = "Nothing has been sent to the seller',
    replace: '  const notSubmitted = "Your recommended offer is $612,000. Nothing has been sent to the seller',
    expect: "NO variant carries a money figure",
  },
  {
    name: "HONESTY — the durable buyer message stops riding the portal thread rail",
    file: "app/actions/buyer-offer-tools.ts",
    find: '  const { error } = await supabase.from("client_portal_messages").insert({',
    replace: '  const { error } = await supabase.from("__no_such_rail__").insert({',
    expect: "the durable buyer message rides the EXISTING portal thread rail",
  },
]

function runChild(): { code: number; out: string } {
  const r = spawnSync("npx", ["tsx", "scripts/buyer-offer-request-simulator.ts", "--assert-only"], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, BOR_SIM_CHILD: "1" },
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
    if (!original.includes(c.find)) {
      console.log(`\n✗ ${c.name}\n   PATCH DID NOT APPLY — anchor not found in ${c.file}. Control proves nothing.`)
      allOk = false
      continue
    }
    writeFileSync(path, original.replace(c.find, c.replace))
    const patched = readFileSync(path, "utf8")
    const applied = patched.includes(c.replace) && !patched.includes(c.find)
    console.log(`\n· ${c.name}`)
    console.log(`   patch applied: ${applied ? "CONFIRMED (defect text present, fixed text absent)" : "NOT CONFIRMED"}`)
    if (!applied) { writeFileSync(path, original); allOk = false; continue }

    const red = runChild()
    const named = red.out.includes(`✗ ${c.expect}`) || red.out.split("\n").some(l => l.startsWith("  ✗ ") && l.includes(c.expect))
    console.log(`   observed: ${red.code !== 0 ? "RED" : "GREEN"} (exit ${red.code})${named ? ` — assertion "${c.expect}" failed as designed` : ""}`)
    if (red.code === 0 || !named) { allOk = false; console.log("   ✗ control did not turn the intended assertion red") }

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
  console.log("BUYER OFFER REQUEST — the button's promise matches what it does")
  console.log("═".repeat(78))
  await pureLayer()
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
