#!/usr/bin/env tsx
/**
 * scripts/offer-lifecycle-batch-derivation-simulator.ts
 *   (npm run test:offer-batch-derivation)
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO WAYS TO ASK THE SAME QUESTION MUST NEVER GIVE TWO ANSWERS.
 *
 * `lib/buyer-offer/offer-lifecycle.ts` exists because there were once THREE
 * rival derivations of "what state is this offer in", over two vocabularies on
 * two different keys. Wave 16 gave that module a SECOND entry point —
 * `deriveOfferStatesFromActivities`, which answers for many offers in one
 * `activities` read — and a second entry point is exactly how a fourth rival
 * derivation gets born.
 *
 * So the single most valuable thing this proof asserts is AGREEMENT: for one
 * synthetic activity set, the state derived ONE OFFER AT A TIME and the state
 * derived IN A BATCH are identical — same `state`, same `at`, same `history`
 * length, and same `reason`/`actorAgentId` on every history entry. It asserts
 * that structurally too: both exported derivations route through ONE private
 * reducer, and neither one contains any row→state logic of its own.
 *
 * The second thing it asserts is that the batch FAILS CLOSED. supabase-js
 * RESOLVES a refused query, so `const { data }` reports "permission denied"
 * identically to "no rows". The batch reports a refusal ONCE, for the whole
 * call, in a field no per-offer answer can occupy — and the pending-offer cap
 * downstream therefore refuses rather than reporting a count of zero. A limit
 * gate that fails open is the exact defect the offer lane consolidated this
 * module to prevent.
 *
 * HOW THIS PROOF IS BUILT — the rules it does not get to skip:
 *   · Assertions read the CONSTRUCT, never a spelling. The reducer is resolved
 *     as "the non-exported function that owns the EVENT_TO_STATE lookup"; the
 *     multi-offer fan-out is resolved as "the non-exported function that calls
 *     the batch entry point"; the refusal guards are found through the variable
 *     the call is actually bound to. A rename keeps them green.
 *   · Structural assertions run over COMMENT-STRIPPED source. Prose that
 *     describes a defect is not the defect, and prose that describes a fix must
 *     never be able to satisfy a check.
 *   · EVERY assertion carries negative controls: the defect is written back into
 *     the real file, the mutation is VERIFIED TO HAVE LANDED ON DISK (a
 *     find-string that silently no longer matches is theatre, not a control),
 *     the assertion is required to flip RED, and the file is restored and
 *     re-verified by sha256.
 *   · Behavioural assertions reach the library through a CACHE-BUSTED dynamic
 *     import (`?v=<n>`). Without that, a patched module is never re-loaded and
 *     every control reports green over code it never ran. That has bitten this
 *     repo before.
 *
 * NO CREDENTIALS, NO LIVE ROWS. The library is driven against an injected
 * supabase-shaped stub that also COUNTS the queries issued, because "one read
 * for N offers" is the change under test and a count is the only honest way to
 * assert it. Nothing is written to any table, so there is nothing to clean up.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const F = {
  lib: "lib/buyer-offer/offer-lifecycle.ts",
  multi: "app/actions/buyer-offer/handle-multi-offer.ts",
}

for (const p of Object.values(F)) {
  if (!existsSync(resolve(ROOT, p))) {
    console.log(` ❌ OFFER_BATCH_DERIVATION_FAIL — missing subject: ${p}`)
    process.exit(1)
  }
}

/** Read fresh every time — the negative layer rewrites these files on disk. */
const raw = (p: string) => readFileSync(resolve(ROOT, p), "utf8")
/** Comment-stripped source: prose must never satisfy a structural assertion. */
const code = (p: string) =>
  stripComments(raw(p))

// ═════════════════════════════════════════════════════════════════════════════
// CACHE-BUSTED MODULE LOADING
//
// An `import` binds once. The negative layer rewrites offer-lifecycle.ts on
// disk, so a cached module would leave every behavioural assertion inspecting
// the ORIGINAL code and reporting green over a defect it never executed. The
// query string forces Node to treat each load as a distinct specifier.
// ═════════════════════════════════════════════════════════════════════════════
const LIB_URL = pathToFileURL(resolve(ROOT, F.lib)).href
let loadCounter = 0
type LifecycleModule = typeof import("../lib/buyer-offer/offer-lifecycle")
async function loadLifecycle(): Promise<LifecycleModule> {
  loadCounter += 1
  return (await import(`${LIB_URL}?v=${loadCounter}`)) as LifecycleModule
}

// ═════════════════════════════════════════════════════════════════════════════
// A supabase-shaped stub over `activities` — and a query COUNTER.
//
// Only the chain the two derivations actually use. A refusal is injectable
// because supabase-js RESOLVES a refused query and neither derivation may read
// that as "empty". `queries` records one entry per `.from(...)`, which is what
// makes "ONE read for N offers" an assertion rather than a claim.
// ═════════════════════════════════════════════════════════════════════════════
type Row = Record<string, any>

interface Stub {
  client: any
  queries: Array<{ table: string; eq: Record<string, any>; ins: Array<{ col: string; vals: any[] }> }>
}

function makeActivitiesStub(rows: Row[], opts: { readError?: string } = {}): Stub {
  const queries: Stub["queries"] = []
  const client = {
    from(table: string) {
      const st = {
        table,
        eq: {} as Record<string, any>,
        ins: [] as Array<{ col: string; vals: any[] }>,
        order: null as string | null,
        asc: true,
      }
      queries.push({ table, eq: st.eq, ins: st.ins })
      const b: any = {
        select() { return b },
        eq(c: string, v: any) { st.eq[c] = v; return b },
        in(c: string, vals: any[]) { st.ins.push({ col: c, vals }); return b },
        order(c: string, o?: { ascending?: boolean }) { st.order = c; st.asc = o?.ascending !== false; return b },
        limit() { return b },
        then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej) },
      }
      function run() {
        if (opts.readError) return { data: null, error: { message: opts.readError } }
        let hit = rows.filter((r) => {
          for (const [k, v] of Object.entries(st.eq)) if (r[k] !== v) return false
          for (const f of st.ins) if (!f.vals.includes(r[f.col])) return false
          return true
        })
        if (st.order) {
          const col = st.order
          hit = [...hit].sort((a, c) =>
            st.asc
              ? String(a[col]).localeCompare(String(c[col]))
              : String(c[col]).localeCompare(String(a[col])))
        }
        return { data: hit, error: null }
      }
      return b
    },
  }
  return { client, queries }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE SYNTHETIC ACTIVITY SET
//
// Five offers, deliberately interleaved in time so that a batch which grouped
// rows without preserving order, or which read the FIRST event instead of the
// last, would disagree with the single-offer path on `state` AND on `at`.
// One offer carries no rows at all; one carries only an AUDIT event, which the
// canonical `.in(activity_type, …)` filter excludes — both must still come back
// with an answer that says so.
// ═════════════════════════════════════════════════════════════════════════════
const OFFER_A = "11111111-1111-4111-8111-111111111111"
const OFFER_B = "22222222-2222-4222-8222-222222222222"
const OFFER_C = "33333333-3333-4333-8333-333333333333"
const OFFER_NO_ROWS = "44444444-4444-4444-8444-444444444444"
const OFFER_AUDIT_ONLY = "55555555-5555-4555-8555-555555555555"
const ALL_OFFERS = [OFFER_A, OFFER_B, OFFER_C, OFFER_NO_ROWS, OFFER_AUDIT_ONLY]

const AGENT_1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
const AGENT_2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"

const row = (
  offerId: string,
  activityType: string,
  at: string,
  agentId: string | null = null,
  notes: string | null = null,
): Row => ({
  entity_type: "offer",
  entity_id: offerId,
  activity_type: activityType,
  created_at: at,
  agent_id: agentId,
  notes,
})

async function syntheticRows(): Promise<Row[]> {
  const { OFFER_EVENT, OFFER_AUDIT_EVENT } = await loadLifecycle()
  return [
    // Interleaved on purpose — one global ascending order, three offers.
    row(OFFER_A, OFFER_EVENT.DRAFT_CREATED, "2026-01-01T00:00:00.000Z", AGENT_1),
    row(OFFER_B, OFFER_EVENT.DRAFT_CREATED, "2026-01-01T01:00:00.000Z", AGENT_2),
    row(OFFER_C, OFFER_EVENT.DRAFT_CREATED, "2026-01-01T02:00:00.000Z", null),
    row(OFFER_A, OFFER_EVENT.SUBMITTED, "2026-01-02T00:00:00.000Z", AGENT_1),
    row(OFFER_B, OFFER_EVENT.SUBMITTED, "2026-01-02T01:00:00.000Z", AGENT_2),
    row(OFFER_C, OFFER_EVENT.SUBMITTED, "2026-01-02T02:00:00.000Z", AGENT_1),
    row(OFFER_A, OFFER_EVENT.COUNTER_RECEIVED, "2026-01-03T00:00:00.000Z", AGENT_2,
      JSON.stringify({ response_type: "counter" })),
    row(OFFER_B, OFFER_EVENT.WITHDRAWN, "2026-01-04T00:00:00.000Z", AGENT_1,
      JSON.stringify({ reason: "buyer changed their mind" })),
    // Malformed notes must yield a null reason, never a thrown error.
    row(OFFER_C, OFFER_EVENT.ACCEPTED, "2026-01-05T00:00:00.000Z", null, "{not json"),
    // An AUDIT event is not a transition. The canonical filter excludes it, so
    // this offer must read as "no lifecycle events" on BOTH paths.
    row(OFFER_AUDIT_ONLY, OFFER_AUDIT_EVENT.BLOCKED, "2026-01-01T00:00:00.000Z", AGENT_1),
  ]
}

/**
 * The CANONICAL comparison of one offer's answer, both paths.
 *
 * Compares the whole `DerivedOfferState` including every history entry's event,
 * state, timestamp, actor and parsed reason — not just the headline state, which
 * two disagreeing derivations can easily share.
 */
function normaliseState(s: any): string {
  if (!s) return "MISSING"
  if (s.ok === false) return JSON.stringify({ ok: false, reason: s.reason })
  return JSON.stringify({
    ok: true,
    state: s.state,
    at: s.at,
    historyLength: s.history.length,
    history: s.history.map((h: any) => ({
      event: h.event, state: h.state, at: h.at,
      actorAgentId: h.actorAgentId, reason: h.reason,
    })),
  })
}

/**
 * What `checkPendingOfferLimit` does with a batch result, expressed over the
 * batch's own contract: a refusal has NO count (null), never zero.
 *
 * This is not a second derivation — it decides nothing about any offer's state.
 * It reads the states the library produced and counts the PENDING ones, which is
 * exactly `handle-multi-offer.ts`'s `derived.states.filter(s => s.state ===
 * "PENDING").length` with the refusal branch kept honest.
 */
function pendingCountFrom(batch: any): number | null {
  if (!batch.ok) return null
  let n = 0
  for (const [, s] of batch.states as Map<string, any>) if (s.ok && s.state === "PENDING") n++
  return n
}

// ═════════════════════════════════════════════════════════════════════════════
// Structural helpers — constructs, resolved out of the code
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Top-level function bodies, each sliced to the next top-level function.
 *
 * Deliberately NOT brace-matched from the signature: these signatures carry
 * return types containing `{`, and a brace matcher would close on the type
 * rather than on the body. Slicing is the house pattern here and is sufficient,
 * because every function in both subjects is top-level and sequential.
 */
function functionBodies(src: string): Map<string, { body: string; exported: boolean }> {
  const out = new Map<string, { body: string; exported: boolean }>()
  const starts: Array<{ name: string; at: number; exported: boolean }> = []
  const re = /(?:^|\n)(export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    starts.push({ name: m[2], at: m.index, exported: Boolean(m[1]) })
  }
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].at : src.length
    out.set(starts[i].name, { body: src.slice(starts[i].at, end), exported: starts[i].exported })
  }
  return out
}

/** The private reducer: the non-exported function that owns the state lookup. */
function reducerOf(src: string): string | null {
  const hits = [...functionBodies(src).entries()]
    .filter(([, f]) => !f.exported && /EVENT_TO_STATE\s*\[/.test(f.body))
    .map(([n]) => n)
  return hits.length === 1 ? hits[0] : null
}

/** The two exported derivations, resolved by what they return, not by name. */
function derivationNames(src: string): { single: string | null; batch: string | null } {
  const bodies = functionBodies(src)
  let single: string | null = null
  let batch: string | null = null
  for (const [name, f] of bodies) {
    if (!f.exported) continue
    if (/Promise<DerivedOfferState>/.test(f.body)) single = name
    if (/Promise<BatchDerivedOfferStates>/.test(f.body)) batch = name
  }
  return { single, batch }
}

// ═════════════════════════════════════════════════════════════════════════════
// ASSERTIONS
// ═════════════════════════════════════════════════════════════════════════════
interface Break { file: string; find: string; replace: string }
interface Assertion {
  id: string
  what: string
  run: () => Promise<{ ok: boolean; detail?: string }>
  breaks: Break[]
}
const A: Assertion[] = []

// ── 1 · AGREEMENT ────────────────────────────────────────────────────────────
A.push({
  id: "agreement.single-and-batch-derive-identical-states",
  what:
    "for one synthetic activity set, every offer's state derived ONE AT A TIME and derived IN A BATCH is byte-identical — state, `at`, history length, and every entry's event/actor/parsed reason. This is the assertion that stops the batch becoming a fourth rival derivation",
  run: async () => {
    const lib = await loadLifecycle()
    const rows = await syntheticRows()

    const singles = new Map<string, string>()
    for (const id of ALL_OFFERS) {
      const s = await lib.deriveOfferStateFromActivities(makeActivitiesStub(rows).client, id)
      singles.set(id, normaliseState(s))
    }

    const batch: any = await lib.deriveOfferStatesFromActivities(
      makeActivitiesStub(rows).client, ALL_OFFERS)
    if (!batch.ok) return { ok: false, detail: `the batch refused a readable trail: ${batch.reason}` }

    const disagreements: string[] = []
    for (const id of ALL_OFFERS) {
      const b = normaliseState(batch.states.get(id))
      if (b !== singles.get(id)) disagreements.push(`${id.slice(0, 8)}: single=${singles.get(id)} batch=${b}`)
    }
    if (disagreements.length) return { ok: false, detail: disagreements.join(" | ") }

    // The comparison must not be vacuous: at least one offer needs a multi-entry
    // history, a non-null actor and a parsed reason, or "identical" proves only
    // that both paths returned the same empty answer.
    const a: any = batch.states.get(OFFER_A)
    const b: any = batch.states.get(OFFER_B)
    if (!a?.ok || a.history.length < 3) return { ok: false, detail: "the sample carries no multi-event history" }
    if (!a.history.some((h: any) => h.actorAgentId)) return { ok: false, detail: "no actorAgentId exercised" }
    if (!b?.ok || !b.history.some((h: any) => h.reason)) return { ok: false, detail: "no parsed reason exercised" }
    if (a.state !== "COUNTERED" || b.state !== "WITHDRAWN") {
      return { ok: false, detail: `latest-event-wins broken: A=${a.state} B=${b.state}` }
    }
    return { ok: true, detail: `${ALL_OFFERS.length} offers agree; A history=${a.history.length}` }
  },
  breaks: [
    {
      // The fourth derivation, minted inside the batch: it folds the rows itself
      // and reads the FIRST event rather than the last.
      file: F.lib,
      find: `    states.set(id, reduceOfferLifecycleRows(byOffer.get(id) ?? []))`,
      replace:
        `    const rival = byOffer.get(id) ?? []\n` +
        `    states.set(id, rival.length === 0\n` +
        `      ? { ok: false, reason: "Offer has no lifecycle events" }\n` +
        `      : { ok: true, state: EVENT_TO_STATE[rival[0].activity_type as OfferEvent], at: rival[0].created_at, history: [] })`,
    },
    {
      // The batch stops applying the canonical event filter, so audit rows enter
      // the fold and the two paths part company on the offer that has only one.
      file: F.lib,
      find:
        `    .in("activity_type", OFFER_LIFECYCLE_EVENT_TYPES as string[])\n` +
        `    .order("created_at", { ascending: true })\n\n  if (error) {`,
      replace: `    .order("created_at", { ascending: true })\n\n  if (error) {`,
    },
  ],
})

A.push({
  id: "agreement.one-reducer-owns-every-row-to-state-decision",
  what:
    "the construct behind the agreement: exactly ONE non-exported function in the module performs the EVENT_TO_STATE lookup, and BOTH exported derivations call it — neither contains a history fold, a `parseReason` call or a state lookup of its own",
  run: async () => {
    const src = code(F.lib)
    const reducer = reducerOf(src)
    if (!reducer) return { ok: false, detail: "no single private owner of the EVENT_TO_STATE lookup" }

    const { single, batch } = derivationNames(src)
    if (!single || !batch) return { ok: false, detail: `derivations unresolved (single=${single}, batch=${batch})` }

    const bodies = functionBodies(src)
    const problems: string[] = []
    for (const name of [single, batch]) {
      const body = bodies.get(name)!.body
      if (!new RegExp(`\\b${reducer}\\s*\\(`).test(body)) problems.push(`${name} does not call ${reducer}`)
      if (/EVENT_TO_STATE\s*\[/.test(body)) problems.push(`${name} does its own state lookup`)
      if (/history\.push\s*\(/.test(body)) problems.push(`${name} builds its own history`)
      if (/parseReason\s*\(/.test(body)) problems.push(`${name} parses notes itself`)
    }
    if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${reducer}\\b`).test(src)) {
      problems.push(`${reducer} is exported — an exported reducer invites a third fetch path`)
    }
    return problems.length
      ? { ok: false, detail: problems.join("; ") }
      : { ok: true, detail: `reducer=${reducer}; single=${single}; batch=${batch}` }
  },
  breaks: [
    {
      file: F.lib,
      find: `    states.set(id, reduceOfferLifecycleRows(byOffer.get(id) ?? []))`,
      replace:
        `    const rival = byOffer.get(id) ?? []\n` +
        `    states.set(id, rival.length === 0\n` +
        `      ? { ok: false, reason: "Offer has no lifecycle events" }\n` +
        `      : { ok: true, state: EVENT_TO_STATE[rival[0].activity_type as OfferEvent], at: rival[0].created_at, history: [] })`,
    },
    {
      // The single-offer path grows its own fold — the rival in the other
      // direction, which is how `deriveOfferStateFromActivities` stops being the
      // batch's face and becomes its competitor.
      file: F.lib,
      find: `  return reduceOfferLifecycleRows((data ?? []) as unknown as OfferActivityRow[])`,
      replace:
        `  const rival = (data ?? []) as unknown as OfferActivityRow[]\n` +
        `  if (rival.length === 0) return { ok: false, reason: "Offer has no lifecycle events" }\n` +
        `  const last = rival[rival.length - 1]\n` +
        `  return { ok: true, state: EVENT_TO_STATE[last.activity_type as OfferEvent], at: last.created_at, history: [] }`,
    },
  ],
})

// ── 2 · THE BATCH FAILS CLOSED ───────────────────────────────────────────────
A.push({
  id: "batch.a-refused-read-is-reported-once-and-never-as-per-offer-absence",
  what:
    "with the `activities` read refused, the batch returns `{ ok: false }` for the WHOLE CALL carrying the refusal wording, and hands back no per-offer map at all — because supabase-js resolves a refused query and a refusal folded into N × 'this offer has no events' is a gate failing open",
  run: async () => {
    const lib = await loadLifecycle()
    const rows = await syntheticRows()
    const refused: any = await lib.deriveOfferStatesFromActivities(
      makeActivitiesStub(rows, { readError: "permission denied for table activities" }).client,
      ALL_OFFERS,
    )
    if (refused.ok !== false) return { ok: false, detail: "a refused read did not refuse" }
    if (!/could not read offer lifecycle/i.test(refused.reason ?? "")) {
      return { ok: false, detail: `refusal wording lost: ${refused.reason}` }
    }
    if (refused.states !== undefined) {
      return { ok: false, detail: "a refusal still handed back a per-offer map to sift" }
    }

    // …and the wording is the SAME sentence the single-offer path uses, so no
    // caller ever has to tell two refusals apart.
    const singleRefused: any = await lib.deriveOfferStateFromActivities(
      makeActivitiesStub(rows, { readError: "permission denied for table activities" }).client,
      OFFER_A,
    )
    if (singleRefused.ok !== false || singleRefused.reason !== refused.reason) {
      return { ok: false, detail: `single/batch refusals differ: "${singleRefused.reason}" vs "${refused.reason}"` }
    }

    // A readable-but-empty trail is a DIFFERENT answer, not the same one.
    const emptyTrail: any = await lib.deriveOfferStatesFromActivities(
      makeActivitiesStub([]).client, ALL_OFFERS)
    if (!emptyTrail.ok) return { ok: false, detail: "an empty (readable) trail was reported as a refusal" }
    const one: any = emptyTrail.states.get(OFFER_A)
    if (one?.ok !== false || /could not read/i.test(one?.reason ?? "")) {
      return { ok: false, detail: "'no events' and 'refused' are no longer distinguishable" }
    }
    return { ok: true, detail: refused.reason }
  },
  breaks: [
    {
      file: F.lib,
      find: `  if (error) {\n    return refusedRead(error.message)\n  }`,
      replace: `  if (false) {\n    return refusedRead(error.message)\n  }`,
    },
  ],
})

A.push({
  id: "limit-gate.a-refused-trail-yields-no-pending-count-rather-than-zero",
  what:
    "the pending-offer cap's input: counting PENDING over a REFUSED batch produces NO COUNT (the caller must refuse), while counting it over a batch that swallowed the read error produces a confident 0 — which is a buyer at the cap being told they may submit",
  run: async () => {
    const lib = await loadLifecycle()
    const rows = await syntheticRows()

    const refused: any = await lib.deriveOfferStatesFromActivities(
      makeActivitiesStub(rows, { readError: "permission denied for table activities" }).client,
      ALL_OFFERS,
    )
    const countOnRefusal = pendingCountFrom(refused)
    if (countOnRefusal !== null) {
      return { ok: false, detail: `a refused trail produced a pending count of ${countOnRefusal}` }
    }

    // Sanity in the other direction: when the trail IS readable the count is
    // real, so `null` is signalling refusal and not simply never being produced.
    const good: any = await lib.deriveOfferStatesFromActivities(makeActivitiesStub(rows).client, ALL_OFFERS)
    const countWhenReadable = pendingCountFrom(good)
    if (countWhenReadable === null) return { ok: false, detail: "a readable trail produced no count either" }
    if (countWhenReadable !== 0) {
      return { ok: false, detail: `expected 0 PENDING in this sample, got ${countWhenReadable}` }
    }
    return { ok: true, detail: "refused ⇒ no count; readable ⇒ a real count" }
  },
  breaks: [
    {
      file: F.lib,
      find: `  if (error) {\n    return refusedRead(error.message)\n  }`,
      replace: `  if (false) {\n    return refusedRead(error.message)\n  }`,
    },
  ],
})

// ── 3 · THE BATCH DROPS NOBODY, AND QUERIES NOTHING IT NEED NOT ──────────────
A.push({
  id: "batch.every-requested-offer-gets-an-answer-including-the-empty-ones",
  what:
    "an offer id passed in with ZERO rows still gets an entry saying so — a missing key and a key meaning 'nothing here' read differently at every call site, and silently dropping ids is how an offer stops being counted",
  run: async () => {
    const lib = await loadLifecycle()
    const rows = await syntheticRows()
    const batch: any = await lib.deriveOfferStatesFromActivities(makeActivitiesStub(rows).client, ALL_OFFERS)
    if (!batch.ok) return { ok: false, detail: `refused: ${batch.reason}` }
    if (batch.states.size !== ALL_OFFERS.length) {
      return { ok: false, detail: `asked about ${ALL_OFFERS.length} offers, got ${batch.states.size} answers` }
    }
    for (const id of [OFFER_NO_ROWS, OFFER_AUDIT_ONLY]) {
      const s: any = batch.states.get(id)
      if (!s) return { ok: false, detail: `${id.slice(0, 8)} was dropped` }
      if (s.ok !== false || !/no lifecycle events/i.test(s.reason ?? "")) {
        return { ok: false, detail: `${id.slice(0, 8)} answered "${JSON.stringify(s)}"` }
      }
    }
    // Duplicated ids collapse rather than producing duplicate answers.
    const dup: any = await lib.deriveOfferStatesFromActivities(
      makeActivitiesStub(rows).client, [OFFER_A, OFFER_A, OFFER_B])
    if (!dup.ok || dup.states.size !== 2) {
      return { ok: false, detail: `duplicate ids produced ${dup.ok ? dup.states.size : "a refusal"}` }
    }
    return { ok: true, detail: `${batch.states.size} answers for ${ALL_OFFERS.length} ids` }
  },
  breaks: [
    {
      file: F.lib,
      find: `    states.set(id, reduceOfferLifecycleRows(byOffer.get(id) ?? []))`,
      replace:
        `    const bucket = byOffer.get(id)\n` +
        `    if (!bucket) continue\n` +
        `    states.set(id, reduceOfferLifecycleRows(bucket))`,
    },
  ],
})

A.push({
  id: "batch.an-empty-id-list-issues-no-query-at-all",
  what:
    "`.in(\"entity_id\", [])` is a trap — a pointless round trip whose result is shaped exactly like a refusal's. An empty request is answered locally with an empty map and ZERO queries",
  run: async () => {
    const lib = await loadLifecycle()
    const stub = makeActivitiesStub(await syntheticRows())
    const empty: any = await lib.deriveOfferStatesFromActivities(stub.client, [])
    if (!empty.ok) return { ok: false, detail: "an empty request was answered with a refusal" }
    if (empty.states.size !== 0) return { ok: false, detail: `empty request produced ${empty.states.size} answers` }
    if (stub.queries.length !== 0) {
      return { ok: false, detail: `${stub.queries.length} query(s) issued for an empty id list` }
    }
    return { ok: true, detail: "0 queries" }
  },
  breaks: [
    {
      file: F.lib,
      find: `  if (uniqueIds.length === 0) return { ok: true, states: new Map() }\n`,
      replace: ``,
    },
  ],
})

A.push({
  id: "batch.one-activities-read-serves-every-offer",
  what:
    "the whole point of the entry point: N offers cost ONE `activities` read, keyed `entity_type='offer'` + `entity_id IN (…)` and filtered to the canonical event vocabulary. A buyer with five offers no longer costs eleven reads to render one card",
  run: async () => {
    const lib = await loadLifecycle()
    const stub = makeActivitiesStub(await syntheticRows())
    const batch: any = await lib.deriveOfferStatesFromActivities(stub.client, ALL_OFFERS)
    if (!batch.ok) return { ok: false, detail: `refused: ${batch.reason}` }
    if (stub.queries.length !== 1) {
      return { ok: false, detail: `${ALL_OFFERS.length} offers cost ${stub.queries.length} reads` }
    }
    const q = stub.queries[0]
    if (q.table !== "activities") return { ok: false, detail: `read ${q.table}, not activities` }
    if (q.eq.entity_type !== "offer") return { ok: false, detail: "the canonical entity_type key is not on the read" }
    const idFilter = q.ins.find((f) => f.col === "entity_id")
    const typeFilter = q.ins.find((f) => f.col === "activity_type")
    if (!idFilter || idFilter.vals.length !== ALL_OFFERS.length) {
      return { ok: false, detail: "the read is not filtered to the requested offer ids" }
    }
    if (!typeFilter || typeFilter.vals.length === 0) {
      return { ok: false, detail: "the read is not filtered to the canonical event vocabulary" }
    }
    return { ok: true, detail: `1 read for ${ALL_OFFERS.length} offers` }
  },
  breaks: [
    {
      // The probe read, put back — inside the library this time. It is the exact
      // extra round trip this wave removed.
      file: F.lib,
      find:
        `  const { data, error } = await client\n` +
        `    .from("activities")\n` +
        `    .select(OFFER_LIFECYCLE_SELECT)\n` +
        `    .eq("entity_type", "offer")\n` +
        `    .in("entity_id", uniqueIds)`,
      replace:
        `  await client.from("activities").select("id").eq("entity_type", "offer").in("entity_id", uniqueIds).limit(1)\n` +
        `  const { data, error } = await client\n` +
        `    .from("activities")\n` +
        `    .select(OFFER_LIFECYCLE_SELECT)\n` +
        `    .eq("entity_type", "offer")\n` +
        `    .in("entity_id", uniqueIds)`,
    },
  ],
})

// ── 4 · THE CALL SITE: the probe is gone, and nothing got weaker ─────────────
A.push({
  id: "multi-offer.the-fan-out-issues-no-read-of-its-own",
  what:
    "the multi-offer module's fan-out (resolved as the non-exported function that calls the batch entry point) contains NO `.from(...)` of its own — the probe read is gone — and no per-offer `Promise.all` fan-out either",
  run: async () => {
    const src = code(F.multi)
    const bodies = functionBodies(src)
    const hits = [...bodies.entries()].filter(
      ([, f]) => !f.exported && /deriveOfferStatesFromActivities\s*\(/.test(f.body))
    if (hits.length !== 1) return { ok: false, detail: `${hits.length} private callers of the batch entry point` }
    const [name, f] = hits[0]
    if (/\.from\s*\(/.test(f.body)) {
      return { ok: false, detail: `${name} still issues its own query — the probe is back` }
    }
    if (/Promise\.all\s*\(/.test(f.body)) {
      return { ok: false, detail: `${name} still fans out per offer` }
    }
    const calls = f.body.match(/deriveOfferStatesFromActivities\s*\(/g) ?? []
    if (calls.length !== 1) return { ok: false, detail: `${calls.length} batch calls in ${name}` }
    // And the single-offer export is no longer reached from this file at all.
    if (/deriveOfferStateFromActivities\s*\(/.test(src)) {
      return { ok: false, detail: "the per-offer derivation is still called here" }
    }
    return { ok: true, detail: `fan-out=${name}, 1 batch call, 0 local reads` }
  },
  breaks: [
    {
      file: F.multi,
      find: `  const derived = await deriveOfferStatesFromActivities(supabase as any, offerIds);`,
      replace:
        `  const { error: probeError } = await supabase\n` +
        `    .from("activities")\n` +
        `    .select("id")\n` +
        `    .eq("entity_type", "offer")\n` +
        `    .in("entity_id", offerIds)\n` +
        `    .limit(1);\n` +
        `  if (probeError) return { ok: false, error: probeError.message };\n` +
        `  const derived = await deriveOfferStatesFromActivities(supabase as any, offerIds);`,
    },
    {
      file: F.multi,
      find: `  const derived = await deriveOfferStatesFromActivities(supabase as any, offerIds);`,
      replace:
        `  const perOffer = await Promise.all(offerIds.map(async (offerId) => offerId));\n` +
        `  void perOffer;\n` +
        `  const derived = await deriveOfferStatesFromActivities(supabase as any, offerIds);`,
    },
  ],
})

A.push({
  id: "multi-offer.every-reader-refuses-on-an-unreadable-trail",
  what:
    "removing the probe did not weaken the guarantee: the fan-out returns `{ ok: false }` whenever the batch is not ok, and EVERY exported reader that uses it guards on that BEFORE touching `.states` and answers `success: false`. A limit gate that fails open is the defect this module was built to prevent",
  run: async () => {
    const src = code(F.multi)
    const bodies = functionBodies(src)

    const fanOut = [...bodies.entries()].find(
      ([, f]) => !f.exported && /deriveOfferStatesFromActivities\s*\(/.test(f.body))
    if (!fanOut) return { ok: false, detail: "no private fan-out found" }
    const [fanName, fan] = fanOut

    const batchVar = (/const\s+(\w+)\s*=\s*await\s+deriveOfferStatesFromActivities\s*\(/.exec(fan.body) ?? [])[1]
    if (!batchVar) return { ok: false, detail: "the batch result is not bound to a variable" }
    const fanGuard = new RegExp(`if\\s*\\(\\s*!${batchVar}\\.ok\\s*\\)`)
    if (!fanGuard.test(fan.body)) return { ok: false, detail: `${fanName} does not guard on the batch refusal` }
    const guardAt = fan.body.search(fanGuard)
    const usesAt = fan.body.indexOf(`${batchVar}.states`)
    if (usesAt !== -1 && guardAt > usesAt) {
      return { ok: false, detail: `${fanName} reads .states before checking the refusal` }
    }
    if (!/return\s*\{\s*ok:\s*false/.test(fan.body.slice(guardAt))) {
      return { ok: false, detail: `${fanName} does not propagate the refusal` }
    }

    const readers = [...bodies.entries()].filter(
      ([n, f]) => f.exported && new RegExp(`\\b${fanName}\\s*\\(`).test(f.body) && n !== fanName)
    if (readers.length < 3) return { ok: false, detail: `only ${readers.length} exported readers found` }

    const problems: string[] = []
    for (const [name, f] of readers) {
      const v = (new RegExp(`const\\s+(\\w+)\\s*=\\s*await\\s+${fanName}\\s*\\(`).exec(f.body) ?? [])[1]
      if (!v) { problems.push(`${name}: fan-out result not bound`); continue }
      const guard = new RegExp(`if\\s*\\(\\s*!${v}\\.ok\\s*\\)`)
      if (!guard.test(f.body)) { problems.push(`${name}: no refusal guard`); continue }
      const gi = f.body.search(guard)
      const si = f.body.indexOf(`${v}.states`)
      if (si !== -1 && gi > si) { problems.push(`${name}: uses .states before guarding`); continue }
      // The guarded branch must REFUSE, not fall through to a confident answer.
      const branch = f.body.slice(gi, si === -1 ? f.body.length : si)
      if (!/success:\s*false/.test(branch)) problems.push(`${name}: the refusal branch does not answer success:false`)
    }
    return problems.length
      ? { ok: false, detail: problems.join("; ") }
      : { ok: true, detail: `${fanName} → ${readers.map(([n]) => n).join(", ")}` }
  },
  breaks: [
    {
      // The fan-out swallows the refusal and reports an empty, confident set.
      file: F.multi,
      find: `    return { ok: false, error: derived.reason };`,
      replace: `    return { ok: true, states: [] };`,
    },
    {
      // THE LIMIT GATE fails open — a refused trail read as zero pending.
      file: F.multi,
      find:
        `    const derived = await deriveStatesForOffers(supabase, (offers ?? []).map((o) => o.id));\n` +
        `    if (!derived.ok) {`,
      replace:
        `    const derived = await deriveStatesForOffers(supabase, (offers ?? []).map((o) => o.id));\n` +
        `    if (false) {`,
    },
    {
      // The duplicate scan fails open — a refused trail read as "no conflict".
      file: F.multi,
      find:
        `    const derived = await deriveStatesForOffers(supabase, offers.map((o) => o.id));\n` +
        `    if (!derived.ok) {`,
      replace:
        `    const derived = await deriveStatesForOffers(supabase, offers.map((o) => o.id));\n` +
        `    if (false) {`,
    },
    {
      // The buyer's active-offer list fails open — a refused trail read as "no
      // live offers", which is what the multi-offer banner renders.
      file: F.multi,
      find: `    if (!derived.ok) return { success: false, error: derived.error };`,
      replace: `    if (false) return { success: false, error: derived.error };`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// RUN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log("══════════════════════════════════════════════════════════════════════")
  console.log(" The offer lifecycle batch derivation — one reducer, one read,")
  console.log(" and a refusal that cannot be mistaken for an empty trail")
  console.log("══════════════════════════════════════════════════════════════════════")

  let pass = 0, fail = 0
  const failures: string[] = []

  console.log("\n─── ASSERTIONS ───────────────────────────────────────────────────────")
  for (const a of A) {
    let r: { ok: boolean; detail?: string }
    try { r = await a.run() }
    catch (e) { r = { ok: false, detail: `threw: ${(e as Error).message}` } }
    if (r.ok) { pass++; console.log(`  ✔ ${a.id}\n      ${a.what}${r.detail ? `\n      → ${r.detail}` : ""}`) }
    else { fail++; failures.push(`${a.id}: ${r.detail ?? ""}`); console.log(`  ✘ ${a.id}\n      ${a.what}\n      → ${r.detail ?? ""}`) }
  }

  let negPass = 0, negFail = 0
  const negProblems: string[] = []
  if (RUN_NEGATIVE) {
    console.log("\n─── NEGATIVE CONTROLS (the defect is written back on purpose) ────────")
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
        const firstReplacedLine = b.replace.split("\n")[0]
        const applied =
          onDisk !== before &&
          (firstReplacedLine === "" ? !onDisk.includes(b.find) : onDisk.includes(firstReplacedLine))
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
          console.log(`  ✘ ${a.id}[${i}] ${!applied ? " patch not observed" : ""}${!broke ? " did NOT flip" : ""}${!restored ? " FILE NOT RESTORED" : ""}${detail ? ` (${detail})` : ""}`)
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

  if (fail > 0 || negFail > 0) {
    console.log("\n ❌ OFFER_BATCH_DERIVATION_FAIL — the batch and the single-offer derivation must never be able to disagree, and a refused trail must never read as an empty one")
    process.exit(1)
  }
  console.log("\n ✅ OFFER_BATCH_DERIVATION_PASS — one reducer decides every state, one read serves every offer, no requested offer is dropped, and a refused lifecycle read refuses the whole count instead of reporting zero pending")
}

main()
