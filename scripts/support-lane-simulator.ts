#!/usr/bin/env tsx
/**
 * scripts/support-lane-simulator.ts   (npm run test:support-lane)
 * ─────────────────────────────────────────────────────────────────────────────
 * SUPPORT IS TWO CONVERSATIONS, AND THE SCHEMA COULD NOT TELL THEM APART.
 *
 * Owner ruling, verbatim: "support is for submitting support tickets to platform
 * from tenant and also agents and vendors support ticket to the brokerage office
 * staff. the platform has support and marketing roles which last time i mentioned
 * them for the tenants which i was incorrect."
 *
 *   LANE 1  tenant_to_platform   — a brokerage raising a ticket TO the platform,
 *           answered by platform staff holding platform_role 'support'.
 *   LANE 2  user_to_brokerage  — an agent or a vendor raising a ticket to their
 *           OWN brokerage's office staff. THE PLATFORM IS NOT A PARTY TO IT.
 *
 * THREE DEFECTS, all measured on the live database before m468 was written:
 *   (1) no lane column at all, so neither lane could be routed, listed or scoped —
 *       the platform's console, its SLA clock, its sentinel and its home badge all
 *       read EVERY ticket in the database, and the brokerage's own office queue
 *       read its tickets to the platform as though they were its own work;
 *   (2) no vendor_id, so a vendor could not be recorded as a submitter at all;
 *   (3) all four RLS policies were the SAME tenant-wide predicate, so one agent
 *       read another agent's ticket and a `contact` account read the ticket its
 *       brokerage raised to the platform. MEASURED under both identities: the
 *       superseded predicate answered TRUE, the new one answers FALSE.
 *
 * PURE:     ticketAnsweredBy / isTicketLane — the one place "who owes a reply" is
 *           decided, asserted total, closed over the stored vocabulary, and
 *           REFUSING to guess for anything else.
 * SOURCE:   three scans, keyed to QUERY SHAPE rather than to any file, name or
 *           spelling: no ticket LIST may be blind to the lane; no ticket INSERT may
 *           omit it; no ticket read may be destructured without `error`.
 * NEGATIVE: every scan is run against deliberately broken source that it MUST
 *           report, and against near-misses it must NOT — a scan that has never
 *           gone red is indistinguishable from a scan that cannot.
 * LIVE (creds-gated): the constraints and the boolean helpers on the real database
 *           — lane NOT NULL, the lane CHECK, both lanes storable, and the two RLS
 *           helper functions answering a STRICT false (never NULL) with no
 *           identity. Seeds, proves, deletes, and asserts residue 0. Self-skips.
 *
 * WHAT THIS PROOF DOES NOT COVER, said plainly: the per-ticket lane refusals in the
 * platform support console (reply / assign / set-status on a lane 2 ticket) are
 * behavioural and need an authenticated SESSION, which neither this script nor CI
 * has — the service-role key bypasses RLS. Those were measured by hand through the
 * Supabase MCP by impersonating real accounts, and the results are recorded in the
 * MEASURED AFTER APPLYING footer of the migration. They are NOT asserted here, and
 * pinning a scan to the helper's NAME would assert its spelling rather than its
 * behaviour.
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { runtimeFiles, walkTs } from "./runtime-roots"
import {
  TICKET_LANES,
  isTicketLane,
  ticketAnsweredBy,
  type TicketLane,
} from "../lib/support/ticket-constants"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}

const ROOT = process.cwd()
const rel = (p: string) => relative(ROOT, p)

/**
 * THIS FILE IS EXCLUDED FROM ITS OWN SCANS, and that is not a file-path pin.
 *
 * The scans below are keyed to a QUOTED TABLE NAME, so — unlike a scan keyed to
 * identifiers — they cannot blank string literals without blinding themselves
 * completely: every `.from("support_tickets")` would become `.from(   )` and the
 * scan would go on reporting a confident zero. That trade-off is the same one
 * scripts/multi-role-seat-simulator.ts records for its own table-name scan, and it
 * excludes itself for the same reason.
 *
 * What is excluded is the HARNESS'S OWN FIXTURES — the deliberately-broken source
 * the negative control feeds to the scanners, which is input data, not code that
 * ships. No CLAIM is pinned here: a defect written in any other file, including one
 * that does not exist yet, is still caught by shape.
 */
const SELF = fileURLToPath(import.meta.url)

// ─── PURE ────────────────────────────────────────────────────────────────────

function pureLayer() {
  console.log("\n[the lane vocabulary · pure — what the database will actually store]")

  check("both lanes the owner described are storable values",
    TICKET_LANES.length === 2 &&
    (TICKET_LANES as readonly string[]).includes("tenant_to_platform") &&
    (TICKET_LANES as readonly string[]).includes("user_to_brokerage"))
  check("every declared lane passes its own guard",
    TICKET_LANES.every((l) => isTicketLane(l)))
  check("a value outside the vocabulary is refused, and so are the non-strings",
    !isTicketLane("platform") && !isTicketLane("") && !isTicketLane(null) &&
    !isTicketLane(undefined) && !isTicketLane(0) && !isTicketLane(["tenant_to_platform"]))

  console.log("\n[who owes a reply · pure — the routing decision, made in ONE place]")

  check("a tenant_to_platform ticket is answered by PLATFORM support",
    ticketAnsweredBy("tenant_to_platform") === "platform_support")
  check("a user_to_brokerage ticket is answered by the BROKERAGE office",
    ticketAnsweredBy("user_to_brokerage") === "brokerage_office")
  check("the two lanes never resolve to the same answerer — that is the whole ruling",
    ticketAnsweredBy("tenant_to_platform") !== ticketAnsweredBy("user_to_brokerage"))
  check("the function is TOTAL over the stored vocabulary (no lane falls through)",
    TICKET_LANES.every((l) => ticketAnsweredBy(l) !== null))

  // The failure mode this exists to prevent is not "wrong answer", it is
  // "confident answer". A support conversation delivered to the wrong organisation
  // because an unknown lane fell through to a default is a disclosure, not a bug.
  check("an UNKNOWN lane routes NOWHERE rather than defaulting to either side",
    ticketAnsweredBy("something_else") === null &&
    ticketAnsweredBy("") === null &&
    ticketAnsweredBy(null) === null &&
    ticketAnsweredBy(undefined) === null)

  // NEGATIVE CONTROL for the pure layer: the shape the code had before the lane
  // existed — one answerer for everything — must FAIL the assertions above. If a
  // constant function could satisfy them, they assert nothing.
  const preLaneBehaviour = (_lane: string | null | undefined) => "platform_support" as const
  check("NEGATIVE CONTROL the pre-lane behaviour (everything → platform) FAILS the two-answerer test",
    preLaneBehaviour("tenant_to_platform") === preLaneBehaviour("user_to_brokerage"))
  check("NEGATIVE CONTROL …and FAILS the routes-nowhere test for an unknown lane",
    preLaneBehaviour("something_else") !== null)
}

// ─── SOURCE ──────────────────────────────────────────────────────────────────

/**
 * Source with comments blanked, newlines preserved so reported line numbers survive.
 *
 * Every scan below must pin to a LIVE QUERY, never to a sentence about one. This
 * file's own header quotes the shapes it forbids, and so do the notes left at the
 * call sites that no longer have them.
 */
function codeOnly(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length))
}

const lineOf = (s: string, i: number) => s.slice(0, i).split("\n").length

/**
 * Every `.from("support_tickets")` chain in a file, as [startIndex, chain].
 *
 * Uses codeOnly and DELIBERATELY NOT a string-blanking variant: this scan matches on
 * a STRING ARGUMENT — the table name itself — so blanking string literals would turn
 * every `.from("support_tickets")` into `.from(                  )` and blind the
 * scan completely while it went on reporting zero. Which text to ignore is a
 * per-scan judgement: here the quotation IS the signal.
 */
export function ticketChains(code: string): Array<[number, string]> {
  const out: Array<[number, string]> = []
  const re = /\.from\(\s*["'`]support_tickets["'`]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    const from = m.index + m[0].length
    const tail = code.slice(from, from + 900)
    const next = tail.indexOf(".from(")
    out.push([m.index, next === -1 ? tail : tail.slice(0, next)])
  }
  return out
}

/** A chain narrowed to ONE ticket by primary key — it cannot span lanes. */
const pinnedToOneTicket = (chain: string) => /\.eq\(\s*["'`]id["'`]/.test(chain)
/** A chain that writes rather than reads. */
const isWrite = (chain: string) => /^\s*\.?\s*(insert|upsert|update|delete)\s*\(/.test(chain) || /\.(insert|upsert|update|delete)\s*\(/.test(chain.slice(0, 40))

/**
 * LANE-BLIND LISTS. A read that can return MORE THAN ONE ticket must either filter
 * on the lane or select the lane column — one of the two, so that the caller can
 * either restrict to a lane or decide per row.
 *
 * The rule is deliberately NOT "every list filters by lane": runSupportSlaSweep
 * legitimately reads both lanes at once precisely so it can route each breach to the
 * side that owes it. Forbidding that would be forbidding the fix. What must never
 * exist again is a multi-row ticket query that cannot tell the two conversations
 * apart at all — the shape every platform surface had before m468.
 */
export function laneBlindLists(files: string[]): string[] {
  const hits: string[] = []
  for (const file of files) {
    const code = codeOnly(readFileSync(file, "utf8"))
    for (const [at, chain] of ticketChains(code)) {
      if (isWrite(chain)) continue
      if (pinnedToOneTicket(chain)) continue
      const filtersLane = /\.eq\(\s*["'`]lane["'`]/.test(chain) || /\.in\(\s*["'`]lane["'`]/.test(chain)
      const selectsLane = /\blane\b/.test(chain)
      if (filtersLane || selectsLane) continue
      hits.push(`${rel(file)}:${lineOf(code, at)}`)
    }
  }
  return hits.sort()
}

/**
 * LANE-LESS INSERTS. support_tickets.lane is NOT NULL with NO DEFAULT, so a writer
 * that omits it gets 23502 at runtime. This catches it at the source instead, and
 * covers scripts as well as runtime because a seed that cannot insert is a proof
 * that cannot run.
 */
export function laneLessInserts(files: string[]): string[] {
  const hits: string[] = []
  for (const file of files) {
    const code = codeOnly(readFileSync(file, "utf8"))
    for (const [at, chain] of ticketChains(code)) {
      const ins = /\.(insert|upsert)\s*\(/.exec(chain)
      if (!ins) continue
      // The object literal handed to insert(), up to the closing of the chain.
      const body = chain.slice(ins.index, ins.index + 700)
      // `lane: x` AND the shorthand `lane,` / `lane }` — both name the column.
      // A key that merely starts with the word (`laneless:`) does not.
      if (/(^|[\s{,])lane\s*[:,}]/.test(body)) continue
      hits.push(`${rel(file)}:${lineOf(code, at)}`)
    }
  }
  return hits.sort()
}

/**
 * UNCHECKED TICKET READS. supabase-js RESOLVES a failed query: `const { data }`
 * reads "permission denied" as "there are no tickets". Every destructured
 * support_tickets result must bind `error` (a head COUNT binds `count`, whose
 * null IS the refusal signal the caller sees).
 *
 * Reports what it could NOT attribute alongside what it checked. A chain that is
 * not owned by a `const { … } = await` — an element of a Promise.all array, a
 * fire-and-forget `.then()` — is counted as unattributed rather than silently
 * passed, because a coverage number that hides its exclusions rounds up.
 */
export function uncheckedTicketReads(files: string[]): { hits: string[]; unattributed: string[] } {
  const hits: string[] = []
  const unattributed: string[] = []
  for (const file of files) {
    const code = codeOnly(readFileSync(file, "utf8"))
    for (const [at, chain] of ticketChains(code)) {
      if (isWrite(chain) && !/\.select\s*\(/.test(chain)) continue
      const before = code.slice(Math.max(0, at - 400), at)

      // (a) the chain is awaited straight into a destructure.
      const direct = /const\s*\{([^}]*)\}\s*=\s*await\s*[^;]*$/.exec(before)
      if (direct) {
        if (/\berror\b/.test(direct[1]) || /\bcount\b/.test(direct[1])) continue
        hits.push(`${rel(file)}:${lineOf(code, at)}`)
        continue
      }

      // (b) the chain is BUILT into a variable first and awaited later — the shape
      // every conditionally-filtered query in this codebase uses
      // (`let q = svc.from(…); if (x) q = q.eq(…); const { data, error } = await q`).
      // Counting those as unattributable would have excluded most of the real
      // queries from the very scan that exists to check them.
      const built = /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?[\w.]*\s*$/.exec(before)
      if (built) {
        const varName = built[1]
        const awaited = new RegExp(`\\{([^}]*)\\}\\s*=\\s*await\\s+${varName}\\b`).exec(code.slice(at))
        if (awaited) {
          if (/\berror\b/.test(awaited[1]) || /\bcount\b/.test(awaited[1])) continue
          hits.push(`${rel(file)}:${lineOf(code, at)}`)
          continue
        }
      }

      unattributed.push(`${rel(file)}:${lineOf(code, at)}`)
    }
  }
  return { hits: hits.sort(), unattributed: unattributed.sort() }
}

function sourceLayer(): { runtime: string[]; all: string[] } {
  console.log("\n[shape scan · source — no ticket query may be blind to the lane]")

  // resolve() both sides: runtimeFiles/walkTs return paths relative to cwd while
  // import.meta.url is absolute, and comparing them raw silently excludes nothing.
  const notSelf = (f: string) => resolve(ROOT, f) !== resolve(SELF)
  const runtime = runtimeFiles(ROOT).filter(notSelf)
  const all = [...runtime, ...walkTs("scripts").filter(notSelf)]

  const blind = laneBlindLists(runtime)
  check(`no multi-row ticket read is lane-blind (found ${blind.length})`, blind.length === 0)
  for (const h of blind) console.log(`      · ${h}`)

  const noLane = laneLessInserts(all)
  check(`no ticket insert omits the lane (found ${noLane.length})`, noLane.length === 0)
  for (const h of noLane) console.log(`      · ${h}`)

  const { hits, unattributed } = uncheckedTicketReads(runtime)
  check(`every destructured ticket read binds \`error\` (found ${hits.length} that do not)`, hits.length === 0)
  for (const h of hits) console.log(`      · ${h}`)
  console.log(`      (chains not owned by a destructure, so not checked here: ${unattributed.length}${unattributed.length ? " — " + unattributed.join(", ") : ""})`)

  check("the scans actually reached the code — the ticket chains were found, not zero of them",
    runtime.some((f) => ticketChains(codeOnly(readFileSync(f, "utf8"))).length > 0))

  return { runtime, all }
}

// ─── NEGATIVE CONTROL ────────────────────────────────────────────────────────
//
// Each scan above reports 0. A scan that has never gone red on anything is
// indistinguishable from a scan that cannot go red — so each one is run here
// against source written to be exactly the defect it forbids, and against
// near-misses it must stay green on.

function negativeControlLayer() {
  console.log("\n[NEGATIVE CONTROL · every scan is run against source it MUST report]")

  const tmp = `${ROOT}/.support-lane-negative-control.tmp.ts`
  const write = (src: string) => { writeFileSync(tmp, src) }
  const cleanup = () => { try { unlinkSync(tmp) } catch { /* ignore */ } }

  try {
    // ── lane-blind list ──
    write(`const q = await svc.from("support_tickets").select("id, subject, status").in("status", ["open"]).limit(500)`)
    check("NEGATIVE CONTROL a multi-row ticket read with no lane anywhere is REPORTED",
      laneBlindLists([tmp]).length === 1)

    write(`const q = await svc.from("support_tickets").select("id, subject").eq("lane", "tenant_to_platform").limit(500)`)
    check("…and the same read WITH a lane filter is not (a filter is a real answer)",
      laneBlindLists([tmp]).length === 0)

    write(`const q = await svc.from("support_tickets").select("id, lane, subject").limit(500)`)
    check("…and a read that SELECTS the lane is not (it can route per row — the SLA sweep)",
      laneBlindLists([tmp]).length === 0)

    write(`const q = await svc.from("support_tickets").select("id, subject").eq("id", ticketId).maybeSingle()`)
    check("…and a read pinned to ONE ticket by id is not (it cannot span lanes)",
      laneBlindLists([tmp]).length === 0)

    write(`const q = await svc.from("other_tickets").select("id, subject").limit(500)`)
    check("…and a DIFFERENT table is never reported, however similar its name",
      laneBlindLists([tmp]).length === 0)

    // PROSE IS NOT CODE. The scan blanks comments; a quoted description of the
    // forbidden shape must be invisible, and a real query beside it must not be.
    write([
      `// const q = await svc.from("support_tickets").select("id, subject").limit(500)`,
      `/* svc.from("support_tickets").select("id").limit(500) — the shape we removed */`,
    ].join("\n"))
    check("NEGATIVE CONTROL a quoted occurrence in a comment is NOT a query (green on prose)",
      laneBlindLists([tmp]).length === 0)
    write([
      `// const q = await svc.from("support_tickets").select("id").limit(500)`,
      `const real = await svc.from("support_tickets").select("id, subject").limit(500)`,
    ].join("\n"))
    check("NEGATIVE CONTROL …and a REAL query beside that prose IS still caught, so blanking did not blind it",
      laneBlindLists([tmp]).length === 1)
    check("blanking preserves line numbers, so a reported hit points at the right line",
      codeOnly("// a\n// b\nc").split("\n").length === 3)

    // ── lane-less insert ──
    write(`await svc.from("support_tickets").insert({ brokerage_id: b, subject: "x", status: "open" }).select("id")`)
    check("NEGATIVE CONTROL an insert with no lane key is REPORTED",
      laneLessInserts([tmp]).length === 1)
    write(`await svc.from("support_tickets").insert({ brokerage_id: b, lane: "user_to_brokerage", subject: "x" }).select("id")`)
    check("…and the same insert naming a lane is not",
      laneLessInserts([tmp]).length === 0)
    write(`await svc.from("support_tickets").insert({ brokerage_id: b, laneless: true, subject: "x" })`)
    check("…and a key that merely STARTS with the word is not mistaken for it",
      laneLessInserts([tmp]).length === 1)

    // ── unchecked read ──
    write(`const { data } = await svc.from("support_tickets").select("id, lane").limit(10)`)
    check("NEGATIVE CONTROL a ticket read destructured without `error` is REPORTED",
      uncheckedTicketReads([tmp]).hits.length === 1)
    write(`const { data, error } = await svc.from("support_tickets").select("id, lane").limit(10)`)
    check("…and the same read binding `error` is not",
      uncheckedTicketReads([tmp]).hits.length === 0)
    write(`const { data: t, error: readErr } = await svc.from("support_tickets").select("id, lane").limit(10)`)
    check("…and a RENAMED error binding is still recognised (the binding, not its spelling)",
      uncheckedTicketReads([tmp]).hits.length === 0)
    write(`const { count } = await svc.from("support_tickets").select("id", { count: "exact", head: true }).eq("lane", "tenant_to_platform")`)
    check("…and a head COUNT is not (a null count IS the refusal the caller sees)",
      uncheckedTicketReads([tmp]).hits.length === 0)
    write(`svc.from("support_tickets").select("id, lane").limit(10)`)
    check("…and a chain owned by no destructure is REPORTED AS UNATTRIBUTED, never silently passed",
      uncheckedTicketReads([tmp]).hits.length === 0 && uncheckedTicketReads([tmp]).unattributed.length === 1)

    // The build-then-await shape, both ways round. This is how most real queries in
    // this codebase are written, and treating it as unattributable would have
    // excluded them from the scan that exists to check them.
    write([
      `let q = svc.from("support_tickets").select("id, lane")`,
      `if (s) q = q.eq("status", s)`,
      `const { data } = await q`,
    ].join("\n"))
    check("NEGATIVE CONTROL a query BUILT into a variable and awaited later without `error` is REPORTED",
      uncheckedTicketReads([tmp]).hits.length === 1 && uncheckedTicketReads([tmp]).unattributed.length === 0)
    write([
      `let q = svc.from("support_tickets").select("id, lane")`,
      `if (s) q = q.eq("status", s)`,
      `const { data, error: qErr } = await q`,
    ].join("\n"))
    check("…and the same shape binding `error` is not",
      uncheckedTicketReads([tmp]).hits.length === 0 && uncheckedTicketReads([tmp]).unattributed.length === 0)
  } finally {
    cleanup()
  }
}

// ─── LIVE ────────────────────────────────────────────────────────────────────

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    console.log("\n[live] SKIPPED — no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env")
    console.log("       (the pure + source + negative-control layers ran; the RLS cases are")
    console.log("        recorded in supabase/migrations/m468-*.sql under MEASURED AFTER APPLYING)")
    return
  }
  const svc = createClient(url, key, { auth: { persistSession: false } })
  console.log("\n[live · the lane constraint and the RLS helpers on the real database]")

  const seeded: string[] = []
  try {
    const { data: brk, error: brkErr } = await svc.from("brokerages").select("id").limit(1)
    if (brkErr) { console.log(`[live] SKIPPED — brokerages read refused: ${brkErr.message}`); return }
    const brokerageId = brk?.[0]?.id
    if (!brokerageId) { console.log("[live] SKIPPED — no brokerage to anchor on"); return }

    // NOT NULL with no default: omitting the lane must FAIL, loudly, at the write.
    // That is the whole reason there is no default — a silently-defaulted lane is a
    // ticket delivered to the wrong organisation.
    const noLane = await svc.from("support_tickets")
      .insert({ brokerage_id: brokerageId, subject: "support-lane-proof no lane", status: "open", priority: "low" })
      .select("id")
    // `.select("id")` on a rejected insert types `data` as `never`, so reading
    // `.length` off it does not compile. Name the shape we actually selected —
    // and keep asserting the ROW COUNT, never just the presence of an error,
    // because a zero-row refusal comes back as error:null.
    const noLaneRows = (noLane.data ?? []) as Array<{ id: string }>
    check("live: an insert that omits the lane is REFUSED (not_null_violation)",
      noLane.error !== null && noLaneRows.length === 0)
    for (const r of noLaneRows) seeded.push(r.id)

    const badLane = await svc.from("support_tickets")
      .insert({ brokerage_id: brokerageId, lane: "platform", subject: "support-lane-proof bad lane", status: "open", priority: "low" })
      .select("id")
    const badLaneRows = (badLane.data ?? []) as Array<{ id: string }>
    check("live: a lane outside the vocabulary is REFUSED by the CHECK constraint",
      badLane.error !== null && badLaneRows.length === 0)
    for (const r of badLaneRows) seeded.push(r.id)

    // Both lanes are genuinely storable, and the value round-trips. Proven with
    // `.select("id")` + a length check, because a zero-row refusal is error:null.
    for (const lane of TICKET_LANES as readonly TicketLane[]) {
      const { data, error } = await svc.from("support_tickets")
        .insert({ brokerage_id: brokerageId, lane, subject: `support-lane-proof ${lane}`, status: "open", priority: "low" })
        .select("id, lane")
      check(`live: lane '${lane}' is storable and reads back as itself`,
        error === null && (data?.length ?? 0) === 1 && (data?.[0] as { lane?: string })?.lane === lane)
      for (const r of data ?? []) seeded.push((r as { id: string }).id)
    }

    // THE HELPERS ANSWER A STRICT BOOLEAN, NOT NULL. The service role carries no
    // auth.uid(), which is exactly the identity-less case that made m465's first
    // predicate return NULL through an OR chain. RLS reads NULL as unsatisfied, so
    // it fails closed either way — but a boolean helper that answers NULL is a trap
    // for anything that composes it, and can_access_support_ticket composes
    // is_support_ticket_submitter.
    const submitter = await svc.rpc("is_support_ticket_submitter", {
      p_agent_id: null, p_vendor_id: null, p_submitted_by_user_id: null,
    })
    check("live: is_support_ticket_submitter with no identity answers false, and NOT null",
      submitter.error === null && submitter.data === false)

    const access = await svc.rpc("can_access_support_ticket", {
      p_lane: "user_to_brokerage",
      p_brokerage_id: brokerageId,
      p_agent_id: null,
      p_vendor_id: null,
      p_submitted_by_user_id: null,
      p_assigned_to: null,
    })
    check("live: can_access_support_ticket with no identity answers false, and NOT null",
      access.error === null && access.data === false)

    // An unrecognised lane reaches NEITHER branch of the predicate. The CHECK makes
    // such a value unstorable; this proves the predicate would still fail closed if
    // that constraint were ever dropped, rather than falling through to the wider
    // of the two lanes.
    const unknownLane = await svc.rpc("can_access_support_ticket", {
      p_lane: "something_else",
      p_brokerage_id: brokerageId,
      p_agent_id: null,
      p_vendor_id: null,
      p_submitted_by_user_id: null,
      p_assigned_to: null,
    })
    check("live: an unrecognised lane reaches no branch of the predicate — false, not null",
      unknownLane.error === null && unknownLane.data === false)
  } finally {
    if (seeded.length) await svc.from("support_tickets").delete().in("id", seeded)
    const { count, error: cErr } = await svc
      .from("support_tickets").select("id", { count: "exact", head: true })
      .like("subject", "support-lane-proof%")
    check(`live: cleanup residue == 0 (proof tickets left: ${cErr ? "unreadable" : count ?? 0})`,
      cErr === null && (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Support lanes — tenant→platform and member→brokerage are not one queue")
  console.log("══════════════════════════════════════════════════")
  pureLayer()
  sourceLayer()
  negativeControlLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SUPPORT_LANE_FAIL"); process.exit(1) }
  console.log(" ✅ SUPPORT_LANE_PASS — every ticket states which conversation it is, no multi-row read is blind to it, no read reports a refusal as an empty queue, and the lane routes to the side that owes the answer")
}
main()
