#!/usr/bin/env tsx
/**
 * scripts/offer-gate-enforcement-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A GATE THE UI ENFORCES IS A SUGGESTION, AND A READ WITH NO SESSION IS A LEAK.
 *
 * Two defects sharing one cause (wave 13, L1):
 *
 * L1a — `app/actions/buyer-offers.ts:createOffer`, the only surface in the
 *   product that writes an `offers` row, enforced NEITHER of the two gates that
 *   decide whether a buyer may be making an offer. Three PAGES and one client
 *   banner consulted them to decide what to RENDER; the action that writes the
 *   row consulted nothing, and it is directly invocable.
 *
 * L1b — `checkPendingOfferLimit` (then named `canBuyerSubmitOffer`),
 *   `getBuyerActiveOffers` and
 *   `getOfferLifecycleState` were `"use server"` exports — public HTTP endpoints
 *   — reading through `createServiceClient()` (RLS bypassed) with no
 *   `auth.getUser()` and no tenant check. `getBuyerActiveOffers` is called from
 *   a CLIENT component with a bare `contactId`, so it was reachable from any
 *   signed-in browser with any contact uuid, and it answers with another
 *   brokerage's buyer's live offers.
 *
 * WHAT THIS PROOF ASSERTS: CONSTRUCTS, never spellings.
 *
 *   · The behaviour sections drive the REAL functions — the canonical offer-state
 *     derivation and the pure limit rule — against an injected stub store. No
 *     credentials, no live rows, so "the query returned nothing" is never
 *     mistaken for health.
 *   · The live section IMPORTS AND CALLS the three real `"use server"` exports in
 *     a process with no session and no service credential, and requires a
 *     refusal with no payload. A gate that cannot verify must refuse.
 *   · The source sections resolve every identifier they depend on OUT OF THE
 *     CODE (the gate helper is found by "the non-exported function that calls
 *     auth.getUser()", the blocker vocabulary is read out of the module that
 *     produces it), so a rename or a re-word cannot fake them.
 *
 * EVERY ASSERTION IS NEGATIVE-CONTROLLED. Each one is a PREDICATE, run twice:
 * once against the real subject (must be GREEN) and once against a subject with
 * the defect put back (must be RED). A control that did not actually apply is
 * reported as a FAILURE rather than counted as a pass — three controls silently
 * failed to apply in an earlier wave and proved nothing, so `patched()` verifies
 * the mutation landed before its red result is believed.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  deriveOfferStateFromActivities,
  OFFER_EVENT,
  isTerminalOfferState,
} from "../lib/buyer-offer/offer-lifecycle"
import {
  evaluateOfferLimit,
  limitProximity,
  MAX_PENDING_OFFERS,
} from "../lib/offers/multi-offer-rules"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? `\n      ${detail}` : ""}`) }
}

/**
 * THE CONTROLLED ASSERTION.
 *
 * `predicate` must hold on `real` and must NOT hold on `control`. The control is
 * only believed when `applied` is true — i.e. the mutation that reintroduces the
 * defect is verifiably present in the control subject. A green predicate against
 * a control that never changed proves nothing at all, which is exactly how a
 * previous wave's controls passed while testing nothing.
 */
function controlled<T>(
  name: string,
  predicate: (subject: T) => boolean,
  real: T,
  control: { subject: T; applied: boolean; describe: string },
) {
  check(name, predicate(real))
  const red = !predicate(control.subject)
  check(
    `   ↳ control applied and RED: ${control.describe}`,
    control.applied && red,
    control.applied
      ? "the defect was reintroduced and the assertion STILL passed — it is not testing what it claims"
      : "THE CONTROL NEVER APPLIED — the subject was unchanged, so its red/green result means nothing",
  )
}

const ROOT = process.cwd()
/** Source with comments removed — prose that DESCRIBES a defect is not the defect. */
const stripComments = (t: string) => t
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "")
const src = (p: string) =>
  existsSync(join(ROOT, p)) ? stripComments(readFileSync(join(ROOT, p), "utf8")) : ""

/** Drop every line mentioning `needle`. The generic way to un-wire a call. */
function dropLines(text: string, needle: string): { subject: string; applied: boolean; describe: string } {
  const subject = text.split("\n").filter((l) => !l.includes(needle)).join("\n")
  return {
    subject,
    applied: text.includes(needle) && !subject.includes(needle),
    describe: `every line calling ${needle} removed`,
  }
}

/** Replace once, and report whether the replacement actually landed. */
function patched(text: string, find: string | RegExp, replace: string, describe: string) {
  const subject = text.replace(find as any, replace)
  return { subject, applied: subject !== text, describe }
}

/** Every `export async function` in a module, sliced to the next one. */
function exportedBodies(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const starts: Array<[string, number]> = []
  const re = /export async function (\w+)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) starts.push([m[1], m.index])
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1][1] : text.length
    out.set(starts[i][0], text.slice(starts[i][1], end))
  }
  return out
}

/**
 * The module's SESSION GATE, resolved from the code rather than named here: the
 * non-exported async function whose body proves a session with `auth.getUser()`.
 * A rename cannot slip past this, and neither can "a different helper that also
 * happens to be called first".
 */
function sessionGateOf(text: string): string | null {
  const m = /(?:^|\n)async function (\w+)\s*\([\s\S]{0,800}?auth\.getUser\(\)/.exec(text)
  return m ? m[1] : null
}

/** How the tenant-scope guard reads a query chain: the 500 chars after `.from`. */
const WINDOW = 500
function fromWindows(body: string, table: string): string[] {
  const needle = `.from("${table}")`
  const out: string[] = []
  let i = body.indexOf(needle)
  while (i !== -1) { out.push(body.slice(i, i + WINDOW)); i = body.indexOf(needle, i + 1) }
  return out
}

// ── A supabase-shaped stub over `activities`. Only the chain the canonical
//    derivation actually uses. A refusal is injectable, because supabase-js
//    RESOLVES a refused query and this derivation must not read that as "empty".
type Row = Record<string, any>
function makeActivitiesStub(rows: Row[], opts: { readError?: string } = {}) {
  return {
    from(_table: string) {
      const st: any = { filters: {}, inFilter: null as null | { col: string; vals: string[] }, order: null, asc: true }
      const b: any = {
        select() { return b },
        eq(c: string, v: any) { st.filters[c] = v; return b },
        in(c: string, vals: string[]) { st.inFilter = { col: c, vals }; return b },
        order(c: string, o?: { ascending?: boolean }) { st.order = c; st.asc = o?.ascending !== false; return b },
        limit() { return b },
        then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej) },
      }
      function run() {
        if (opts.readError) return { data: null, error: { message: opts.readError } }
        let hit = rows.filter((r) => {
          for (const [k, v] of Object.entries(st.filters)) if (r[k] !== v) return false
          if (st.inFilter && !st.inFilter.vals.includes(r[st.inFilter.col])) return false
          return true
        })
        if (st.order) hit = [...hit].sort((a, c) =>
          st.asc ? String(a[st.order]).localeCompare(String(c[st.order]))
                 : String(c[st.order]).localeCompare(String(a[st.order])))
        return { data: hit, error: null }
      }
      return b
    },
  } as any
}

const OFFER_A = "11111111-1111-4111-8111-111111111111"
const OFFER_B = "22222222-2222-4222-8222-222222222222"
const CONTACT = "88888888-8888-4888-8888-888888888888"

const activity = (offerId: string, type: string, at: string): Row => ({
  entity_type: "offer", entity_id: offerId, activity_type: type,
  created_at: at, agent_id: null, notes: null,
})

/**
 * THE DEFECT, PUT BACK — a twin of the canonical derivation that swallows the
 * read error, which is what `const { data } = …` does in supabase-js. Used as
 * the negative control for every behavioural claim about failing closed.
 */
async function derivationThatSwallowsRefusals(client: any, offerId: string) {
  const { data } = await client
    .from("activities").select("*")
    .eq("entity_type", "offer").eq("entity_id", offerId)
    .order("created_at", { ascending: true })
  const rows = (data ?? []) as Row[]
  if (rows.length === 0) return { ok: false as const, reason: "Offer has no lifecycle events" }
  return { ok: true as const, state: "DRAFT", at: rows[rows.length - 1].created_at, history: [] }
}

async function main() {
  console.log("══════════════════════════════════════════════════════════")
  console.log(" The offer gates — enforced where the row is written, and")
  console.log(" closed to callers who have not proved who they are")
  console.log("══════════════════════════════════════════════════════════")

  // ══ 1 · BEHAVIOUR: the state the gates count on ═════════════════════════════
  console.log("\n[the canonical derivation — the one source of 'what state is this offer in']")
  {
    const rows = [
      activity(OFFER_A, OFFER_EVENT.DRAFT_CREATED, "2026-01-01T00:00:00.000Z"),
      activity(OFFER_A, OFFER_EVENT.SUBMITTED,     "2026-01-02T00:00:00.000Z"),
      activity(OFFER_B, OFFER_EVENT.DRAFT_CREATED, "2026-01-01T00:00:00.000Z"),
      activity(OFFER_B, OFFER_EVENT.WITHDRAWN,     "2026-01-03T00:00:00.000Z"),
    ]

    const a = await deriveOfferStateFromActivities(makeActivitiesStub(rows), OFFER_A)
    check("the latest event wins — a submitted draft reads PENDING",
      a.ok && a.state === "PENDING")
    check("…and PENDING is what the limit gate counts, so it is NOT terminal",
      a.ok && !isTerminalOfferState(a.state))

    const b = await deriveOfferStateFromActivities(makeActivitiesStub(rows), OFFER_B)
    check("a withdrawn offer reads WITHDRAWN and IS terminal — it frees a slot",
      b.ok && b.state === "WITHDRAWN" && isTerminalOfferState(b.state))

    check("one offer's trail never becomes another's — the key is entity_id",
      a.ok && b.ok && a.state !== b.state)

    // THE ONE THAT DECIDES WHETHER THE CAP CAN BE TRUSTED. A refused read
    // resolves in supabase-js. If it renders as "no events", every offer looks
    // like no offer and the cap counts zero for a buyer who is at the limit.
    const refusalIsNotEmptiness = (r: { ok: boolean; reason?: string }) =>
      r.ok === false && /could not read/i.test(r.reason ?? "")
    const realRefusal = await deriveOfferStateFromActivities(
      makeActivitiesStub(rows, { readError: "permission denied for table activities" }), OFFER_A)
    const swallowed = await derivationThatSwallowsRefusals(
      makeActivitiesStub(rows, { readError: "permission denied for table activities" }), OFFER_A)
    controlled(
      "a REFUSED read is reported as a refusal, never as 'this offer has no events'",
      refusalIsNotEmptiness,
      realRefusal,
      {
        subject: swallowed,
        applied: swallowed.ok === false && !/could not read/i.test((swallowed as any).reason ?? ""),
        describe: "the derivation swallows `error` (`const { data } = …`) as it did before consolidation",
      },
    )

    const empty = await deriveOfferStateFromActivities(makeActivitiesStub([]), OFFER_A)
    check("an offer with no events invents no state — pre-rollout emptiness is not DRAFT",
      empty.ok === false && !/could not read/i.test(empty.reason ?? ""))
  }

  // ══ 2 · BEHAVIOUR: the limit rule itself ════════════════════════════════════
  console.log("\n[the pending-offer cap — the rule createOffer now binds]")
  {
    const bindsAtCap = (f: (n: number) => { can_submit: boolean; reason?: string }) =>
      f(MAX_PENDING_OFFERS).can_submit === false &&
      f(MAX_PENDING_OFFERS - 1).can_submit === true &&
      f(0).can_submit === true
    controlled(
      `the cap refuses at ${MAX_PENDING_OFFERS} pending and allows below it`,
      bindsAtCap,
      evaluateOfferLimit,
      {
        subject: (n: number) => (n > MAX_PENDING_OFFERS
          ? { can_submit: false, reason: "over" }
          : { can_submit: true }),
        applied: true,
        describe: "the off-by-one that lets a 4th offer through (`>` instead of `>=`)",
      },
    )

    const namesTheRule = (f: (n: number) => { reason?: string }) =>
      (f(MAX_PENDING_OFFERS).reason ?? "").includes(String(MAX_PENDING_OFFERS))
    controlled(
      "the refusal states the number it is refusing on — a bare 'no' is a dead end",
      namesTheRule,
      evaluateOfferLimit,
      {
        subject: () => ({ reason: "Not allowed" }),
        applied: true,
        describe: "a refusal that withholds the rule it applied",
      },
    )

    check("the banner's severity classifier agrees with the cap at every boundary",
      limitProximity(0) === "clear" &&
      limitProximity(MAX_PENDING_OFFERS - 1) === "approaching" &&
      limitProximity(MAX_PENDING_OFFERS) === "at_limit")
  }

  // ══ 3 · LIVE: the three exports, called for real, with nothing proved ═══════
  //
  // This section IMPORTS AND EXECUTES the real `"use server"` modules in a
  // process that has no cookie session and no Supabase credentials — the exact
  // position an unauthenticated caller is in. Every one of them must come back
  // as a refusal carrying NO payload. Before this slice all three would have gone
  // straight to a service-role read.
  console.log("\n[the real exports, with no session: refusal, and no data]")
  {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    delete process.env.SUPABASE_SERVICE_ROLE_KEY

    const multi = await import("../app/actions/buyer-offer/handle-multi-offer")
    const track = await import("../app/actions/buyer-offer/track-offer-lifecycle")

    // These three log their own refusal. Captured rather than silenced: a gate
    // that refuses without leaving a trace is its own small defect, so the count
    // is reported instead of the stack traces being swallowed.
    const logged: unknown[] = []
    const realError = console.error
    console.error = (...a: unknown[]) => { logged.push(a) }
    const limit  = await multi.checkPendingOfferLimit(CONTACT)
    const active = await multi.getBuyerActiveOffers(CONTACT)
    const state  = await track.getOfferLifecycleState(OFFER_A)
    console.error = realError
    console.log(`  · ${logged.length} refusal(s) logged server-side while the three ran`)

    /** A refusal is `success:false` AND an empty hand. Either alone is not it. */
    const refusedWithNoData = (r: any) =>
      r?.success === false &&
      r?.offers === undefined && r?.data === undefined &&
      r?.can_submit !== true

    controlled(
      "checkPendingOfferLimit refuses a caller who has proved nothing",
      refusedWithNoData, limit,
      {
        subject: { success: true, can_submit: true, pending_count: 0, pending_offer_ids: [] },
        applied: true,
        describe: "the ungated shape — a confident 'yes, submit away' with no session behind it",
      },
    )
    controlled(
      "getBuyerActiveOffers refuses instead of answering with a buyer's live offers",
      refusedWithNoData, active,
      {
        subject: { success: true, offers: [{ offer_id: OFFER_A, listing_address: "12 Oak", state: "PENDING" }] },
        applied: true,
        describe: "the ungated shape — another tenant's live offers returned to a bare contactId",
      },
    )
    controlled(
      "getOfferLifecycleState refuses instead of reporting another firm's negotiation",
      refusedWithNoData, state,
      {
        subject: { success: true, data: { offer_id: OFFER_A, current_state: "COUNTERED", is_terminal: false } },
        applied: true,
        describe: "the ungated shape — the state of an offer the caller cannot see",
      },
    )

    // A `"use server"` export that THROWS is not a refusal: the caller receives a
    // rejection with no `success` to test, so the failure is unhandled rather
    // than answered. All three must answer.
    check("none of the three throws — a rejection has no `success` for a caller to test",
      [limit, active, state].every((r) => typeof (r as any)?.success === "boolean"))
  }

  // ══ 4 · STRUCTURE: L1b — the gate is in front of the read ═══════════════════
  console.log("\n[handle-multi-offer: every export that reads offers goes through the one door]")
  {
    const MULTI = src("app/actions/buyer-offer/handle-multi-offer.ts")
    const gate = sessionGateOf(MULTI)
    check("the module's session gate is found by what it DOES (proves a session), not by its name",
      !!gate, `resolved: ${gate ?? "(none)"}`)

    /**
     * THE CONSTRUCT: in every exported function that reads `offers`, the gate
     * call appears BEFORE the first read. Order is the whole point — a gate
     * after the query has already leaked the answer.
     */
    const gatedBeforeReading = (text: string) => {
      const g = sessionGateOf(text)
      if (!g) return false
      const bodies = exportedBodies(text)
      const readers = [...bodies.entries()].filter(([, b]) => b.includes('.from("offers")'))
      if (readers.length === 0) return false
      return readers.every(([, b]) => {
        const gi = b.indexOf(`${g}(`)
        const qi = b.indexOf('.from("offers")')
        return gi !== -1 && gi < qi
      })
    }
    controlled(
      "every exported offers-reader proves the caller's tenant BEFORE it reads",
      gatedBeforeReading, MULTI,
      dropLines(MULTI, `${gate}(`),
    )

    const tenantAnchored = (text: string) => {
      const bodies = exportedBodies(text)
      const readers = [...bodies.values()].filter((b) => b.includes('.from("offers")'))
      return readers.length > 0 &&
        readers.every((b) => fromWindows(b, "offers").every((w) => w.includes("brokerage_id")))
    }
    controlled(
      "…and every one of those reads is anchored on the tenant the gate resolved",
      tenantAnchored, MULTI,
      patched(MULTI, /\n\s*\.eq\("brokerage_id", tenant\.brokerageId\)/g,
        "", "the brokerage anchor stripped from the offers reads"),
    )

    // THE N+1, AND WHY IT IS NOT SOLVED BY CALLING A GATED ENDPOINT IN A LOOP.
    const usesCanonicalDerivation = (text: string) =>
      /deriveOfferStateFromActivities/.test(text) &&
      !/from\s*"\.\/track-offer-lifecycle"/.test(text)
    controlled(
      "the per-offer loops read the canonical derivation, not the gated endpoint once per offer",
      usesCanonicalDerivation, MULTI,
      patched(MULTI, 'import {\n  deriveOfferStateFromActivities,',
        'import { getOfferLifecycleState } from "./track-offer-lifecycle";\nimport {\n  deriveOfferStateFromActivities,',
        "the per-offer import of the session-gated lifecycle export put back"),
    )

    // READABILITY IS ESTABLISHED, NOT ASSUMED. The derivation reports "no events"
    // and "refused" through one channel; the module must not tell them apart by
    // matching a sentence, so it probes the trail once with `error` destructured.
    // THE CONSTRUCT: the readability probe destructures `error`, and its refusal
    // returns before any per-offer state is skipped.
    const probesBeforeSkipping = (text: string) => {
      const probeVar = (/const \{ error: (\w+) \} = await[\s\S]{0,300}?\.limit\(1\);/.exec(text) ?? [])[1]
      if (!probeVar) return false
      const declared = text.indexOf(`const { error: ${probeVar} }`)
      const refuses = new RegExp(`if \\(${probeVar}\\) \\{`).test(text)
      const derives = text.indexOf("deriveOfferStateFromActivities(")
      return refuses && declared !== -1 && declared < derives
    }
    controlled(
      "an unreadable lifecycle trail refuses the whole count rather than skipping offers one by one",
      probesBeforeSkipping, MULTI,
      patched(MULTI, "const { error: probeError }", "const { data: probeIgnored }",
        "the probe stops destructuring `error`, so a refusal reads as an empty trail"),
    )
  }

  console.log("\n[track-offer-lifecycle: a gated entry point, an ungated internal, and no double gate]")
  {
    const TRACK = src("app/actions/buyer-offer/track-offer-lifecycle.ts")
    const gate = sessionGateOf(TRACK)
    check("the file's offer gate is found by what it does", !!gate, `resolved: ${gate ?? "(none)"}`)

    /** The internal reader: a NON-exported function that calls the derivation. */
    const internal = (/(?:^|\n)async function (\w+)\s*\([\s\S]{0,1200}?deriveOfferStateFromActivities\(/.exec(TRACK) ?? [])[1]
    check("there is an ungated INTERNAL reader, and it is not exported",
      !!internal && !new RegExp(`export async function ${internal}\\b`).test(TRACK),
      `resolved: ${internal ?? "(none)"}`)

    const exportIsGated = (text: string) => {
      const g = sessionGateOf(text)
      const body = exportedBodies(text).get("getOfferLifecycleState")
      if (!g || !body || !internal) return false
      const gi = body.indexOf(`${g}(`)
      const ri = body.indexOf(`${internal}(`)
      return gi !== -1 && ri !== -1 && gi < ri
    }
    controlled(
      "the EXPORTED entry point proves the session before it reads the offer's state",
      exportIsGated, TRACK,
      dropLines(TRACK, `${gate}(`),
    )

    // The internal callers are not stranded, and not gated twice.
    const writersUseInternal = (text: string) => {
      const bodies = exportedBodies(text)
      const writers = ["submitOffer", "withdrawOffer", "recordSellerResponse"]
      return writers.every((w) => {
        const b = bodies.get(w)
        if (!b || !internal) return false
        const g = sessionGateOf(text)!
        return b.includes(`${g}(`) && b.includes(`${internal}(`) && !b.includes("getOfferLifecycleState(")
      })
    }
    controlled(
      "the writers in this file gate ONCE and then read through the internal, not the endpoint",
      writersUseInternal, TRACK,
      patched(TRACK, new RegExp(`await ${internal}\\(offerId\\)`, "g"),
        "await getOfferLifecycleState(offerId)",
        "the writers routed back through the public endpoint, re-proving the session per call"),
    )

    // The one external caller that keeps using the export runs in a session.
    const CONVERT = src("app/actions/buyer-offer/convert-to-transaction.ts")
    check("its external caller (convertOfferToTransaction) is itself a session action, so the gate cannot strand it",
      /getOfferLifecycleState\(/.test(CONVERT) &&
      /auth\.getUser\(\)/.test(CONVERT) &&
      /brokerage_id/.test(CONVERT))
  }

  // ══ 5 · STRUCTURE: L1a — both gates bind where the row is written ══════════
  //
  // Both gate identifiers are resolved FROM THE IMPORT STATEMENTS, so the
  // assertions follow a rename instead of breaking on one. Hoisted to this scope
  // because the refusal-wording section further down resolves its variables
  // through the same two names.
  const lifecycleGateName =
    (/import \{\s*(\w+)[^}]*\}\s*from\s*"@\/app\/actions\/buyer-lifecycle-core"/.exec(src("app/actions/buyer-offers.ts")) ?? [])[1]
  // Alias or no alias: `x as y` binds the local name y, a bare `x` binds x. The
  // gates used to be named one letter apart (canBuyerSubmitOffer /
  // canBuyerSubmitOffers) and the alias at this call site was the only thing
  // keeping it readable; wave 14 C4 renamed the exports themselves, so the alias
  // is gone and the CONSTRUCT — the LIMIT gate is imported from the multi-offer
  // module and bound before the insert — is what this resolves, not a spelling.
  const limitGateName = ((
    /import \{([^}]*)\}\s*from\s*"@\/app\/actions\/buyer-offer\/handle-multi-offer"/
      .exec(src("app/actions/buyer-offers.ts"))?.[1] ?? ""
  ).split(",")
    .map((s) => s.trim())
    .find((s) => /limit/i.test(s)) ?? "")
    .split(/\s+as\s+/).pop()?.trim()

  console.log("\n[createOffer: the two gates bind before the offer row exists]")
  {
    const OFFERS = src("app/actions/buyer-offers.ts")

    check("the LIFECYCLE gate is imported from the module the three pages use",
      !!lifecycleGateName, `resolved: ${lifecycleGateName ?? "(none)"}`)
    check("the LIMIT gate is imported from the multi-offer module under a name that states its question",
      !!limitGateName, `resolved: ${limitGateName ?? "(none)"}`)

    /** THE CONSTRUCT: both gates are called before the row is inserted. */
    const gatesBeforeInsert = (text: string) => {
      const b = exportedBodies(text).get("createOffer") ?? ""
      const insert = b.indexOf('.from("offers")')
      if (insert === -1 || !lifecycleGateName || !limitGateName) return false
      const l = b.indexOf(`${lifecycleGateName}(`)
      const p = b.indexOf(`${limitGateName}(`)
      return l !== -1 && p !== -1 && l < insert && p < insert
    }
    controlled(
      "the LIFECYCLE gate binds before the offers row is written",
      gatesBeforeInsert, OFFERS,
      dropLines(OFFERS, `await ${lifecycleGateName}(`),
    )
    controlled(
      "the PENDING-LIMIT gate binds before the offers row is written",
      gatesBeforeInsert, OFFERS,
      dropLines(OFFERS, `await ${limitGateName}(`),
    )

    // THEY ARE NOT COLLAPSED. Two calls, two different modules, two questions.
    const bothKept = (text: string) => {
      const b = exportedBodies(text).get("createOffer") ?? ""
      return !!lifecycleGateName && !!limitGateName &&
        b.includes(`${lifecycleGateName}(`) && b.includes(`${limitGateName}(`) &&
        lifecycleGateName !== limitGateName
    }
    controlled(
      "both gates survive as separate checks — lifecycle eligibility is not the pending count",
      bothKept, OFFERS,
      dropLines(OFFERS, `await ${limitGateName}(`),
    )

    // FAILS CLOSED. A limit that could not be checked is not a limit that passed.
    const limitFailsClosed = (text: string) => {
      const b = exportedBodies(text).get("createOffer") ?? ""
      const v = (new RegExp(`const (\\w+) = await ${limitGateName}\\(`).exec(b) ?? [])[1]
      if (!v) return false
      return new RegExp(`if \\(!${v}\\.success\\)`).test(b) && new RegExp(`if \\(!${v}\\.can_submit\\)`).test(b)
    }
    controlled(
      "a limit check that did NOT RUN refuses too — an unverifiable gate is not an open one",
      limitFailsClosed, OFFERS,
      patched(OFFERS, /if \(!limitGate\.success\) \{/, "if (false) {",
        "the could-not-check branch removed, so a refused count reads as 'under the limit'"),
    )
  }

  console.log("\n[the refusals name the reason AND what to do about it]")
  {
    const OFFERS = src("app/actions/buyer-offers.ts")
    const body = exportedBodies(OFFERS).get("createOffer") ?? ""
    // Both variables are found through the identifiers resolved from the IMPORTS
    // above, so a rename of either gate moves this assertion with it.
    const lifecycleVar = lifecycleGateName
      ? (new RegExp(`const (\\w+) = await ${lifecycleGateName}\\(`).exec(body) ?? [])[1]
      : undefined
    const limitVar = limitGateName
      ? (new RegExp(`const (\\w+) = await ${limitGateName}\\(`).exec(body) ?? [])[1]
      : undefined

    const carriesGateReason = (text: string) => {
      const b = exportedBodies(text).get("createOffer") ?? ""
      return !!lifecycleVar && !!limitVar &&
        b.includes(`\${${lifecycleVar}.reason`) && b.includes(`\${${limitVar}.reason`)
    }
    controlled(
      "each refusal carries the GATE'S OWN reason, not a locally invented sentence",
      carriesGateReason, OFFERS,
      patched(OFFERS, `\${lifecycleGate.reason ?? "This buyer is not eligible to submit offers"}`,
        "This buyer is not eligible to submit offers",
        "the lifecycle gate's own reason replaced with a fixed sentence"),
    )

    /**
     * REMEDY COVERAGE — the construct, resolved from the OTHER module. Every
     * blocker `isOfferAllowed` can raise must have a way out recorded here; a
     * refusal that names a rule and withholds the remedy is the dead end this
     * sequence of waves keeps removing.
     */
    const GATING = src("lib/buyer-lifecycle/gating-helpers.ts")
    const offerGateBody = exportedBodies(GATING).get("isOfferAllowed") ?? ""
    const blockers = [...offerGateBody.matchAll(/blockers:\s*\[\s*"([^"]+)"/g)].map((m) => m[1])
    check("the lifecycle gate's blocker vocabulary is read out of the module that produces it",
      blockers.length >= 3, `found: ${blockers.join(", ") || "(none)"}`)

    const everyBlockerHasARemedy = (text: string) => {
      const map = /const \w+: Record<string, string> = \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? ""
      return blockers.length > 0 && blockers.every((b) => new RegExp(`(^|\\s)${b}:`, "m").test(map))
    }
    controlled(
      "EVERY blocker the lifecycle gate can raise has a remedy the agent can act on",
      everyBlockerHasARemedy, OFFERS,
      patched(OFFERS, /\n  financial_verification_required:\n?[\s\S]*?,\n(?=  \})/,
        "\n", "one blocker's remedy deleted — that refusal becomes a dead end"),
    )

    const limitRefusalNamesWhatToResolve = (text: string) => {
      const b = exportedBodies(text).get("createOffer") ?? ""
      const holding = (/const (\w+) = limitGate\.pending_offer_ids/.exec(b) ?? [])[1]
      return !!holding && b.includes(`${holding}.join(`) && /[Ww]ithdraw|resolve/.test(b)
    }
    controlled(
      "the limit refusal names the offers actually holding the slots, not just the number",
      limitRefusalNamesWhatToResolve, OFFERS,
      dropLines(OFFERS, "pending_offer_ids"),
    )
  }

  // ══ 6 · THE SETTLED OVERRIDE IS HONOURED, AND NO SECOND ONE IS MINTED ══════
  console.log("\n[the financing-gate override: one mechanism, already ruled on]")
  {
    const OFFERS = src("app/actions/buyer-offers.ts")
    const MULTIPARTY = src("lib/buyer-execution/multi-party-updates.ts")

    // The ruling's mechanism: authority is resolved in ONE place, and the
    // override is RECORDED STATE that the lifecycle gate reads back — which is
    // why calling that gate at createOffer honours an override automatically.
    check("the override authority rule still lives in exactly one place",
      /export async function resolveFinancialGateOverrideAuthority/.test(MULTIPARTY) &&
      /adminOverrideFinancialGate/.test(MULTIPARTY) &&
      /emitFinancialVerificationEvent\(/.test(MULTIPARTY))
    check("…and it admits the admin family plus the agent OF RECORD, per the owner's ruling",
      /assigned_agent/.test(MULTIPARTY) && /brokerage_wide/.test(MULTIPARTY))

    /**
     * NO SECOND OVERRIDE. createOffer must not grow its own bypass flag: a
     * caller-declared override with no authority check and no audit row would be
     * a weaker copy of a mechanism that already exists and is already ruled on.
     */
    const noLocalBypassFlag = (text: string) => {
      const sig = /export async function createOffer\(([\s\S]*?)\): Promise/.exec(text)?.[1] ?? ""
      const b = exportedBodies(text).get("createOffer") ?? ""
      return !/override|bypass|force|skipGate/i.test(sig) &&
        !/\b(isOverride|allowOverride|bypassGates|skipGates|force)\b/.test(b)
    }
    controlled(
      "createOffer mints NO second override — the settled one is recorded state the gate already reads",
      noLocalBypassFlag, OFFERS,
      patched(OFFERS, "export async function createOffer(\n  contactId: string,",
        "export async function createOffer(\n  contactId: string,\n  isOverride: boolean | undefined,",
        "a caller-declared override parameter added to createOffer"),
    )
  }

  // ══ 7 · THE BANNER: a refusal is never rendered as a clean zero ═════════════
  console.log("\n[the buyer-facing banner: an unreadable count is not a count of zero]")
  {
    const BANNER = src("app/components/offer/multi-offer-status-banner.tsx")

    const refusalIsSurfaced = (text: string) => {
      const errState = (/const \[(\w+), set\w+\] = useState<string \| null>\(null\)/.exec(text) ?? [])[1]
      if (!errState) return false
      // The refusal branch must RETURN before the count is ever rendered.
      const guard = text.indexOf(`if (${errState} !== null)`)
      const count = text.indexOf("MAX_PENDING_OFFERS}")
      return guard !== -1 && count !== -1 && guard < count && /!\w+\.success/.test(text)
    }
    controlled(
      "a refused limit check renders as 'unavailable', ahead of any count — never as 0 pending",
      refusalIsSurfaced, BANNER,
      dropLines(BANNER, "if (limitError !== null)"),
    )

    check("the banner still says out loud that it does not block — the cap binds at createOffer",
      /does not block creation/.test(readFileSync(join(ROOT, "app/components/offer/multi-offer-status-banner.tsx"), "utf8")))
  }

  console.log("\n──────────────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    for (const f of fails) console.log(`   - ${f}`)
    console.log(" ❌ OFFER_GATE_ENFORCEMENT_FAIL — a gate only the UI consults is a suggestion, and a service-role read with no session is a leak")
    process.exit(1)
  }
  console.log(" ✅ OFFER_GATE_ENFORCEMENT_PASS — both gates bind where the offer row is written, and all three lifecycle reads refuse a caller who has proved nothing")
}

main()
