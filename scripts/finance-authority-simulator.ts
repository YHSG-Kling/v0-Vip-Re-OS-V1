#!/usr/bin/env tsx
/**
 * scripts/finance-authority-simulator.ts   (npm run test:finance-authority)
 * ─────────────────────────────────────────────────────────────────────────────
 * ADMIN SURFACES, BUT NOT BROKERAGE-WIDE MONEY.
 *
 * Owner ruling, verbatim:
 *
 *   "Admin surfaces, but NOT brokerage-wide money. team_lead joins the roster for
 *    operational admin gates (support, onboarding, assignment rules, roster,
 *    marketing). Hold it OUT of the ~18 brokerage-wide financial gates —
 *    financial-kernel, brokerage-fees, accounting-sync, income-engine, billing,
 *    revenue-share, CDA storage, net-sheet overrides — which stay
 *    broker/broker_owner/admin. Also add team_lead to is_brokerage_admin() so app
 *    and DB agree on the non-money gates."
 *
 * Two sentences that pull in opposite directions, over ONE predicate that 226
 * policies compose. m472 split it in two — is_brokerage_admin() widened to admit
 * team_lead for operational admin, is_brokerage_finance_admin() created at the
 * previous three roles for the 49 finance tables — and lib/auth/resolve-user-role.ts
 * carries the same split for the app.
 *
 * ── THE DEFECT THIS PROOF EXISTS TO PREVENT ─────────────────────────────────
 *
 * A gate that ADMITS in the app and REFUSES in RLS does not raise. supabase-js
 * RESOLVES a refused write: zero rows matched, `error` is null, and the surface
 * reports SUCCESS over a change that never happened. So "the app roster" and "the
 * database roster" being the same two sets is not tidiness, it is the whole
 * safety property. The inverse is worse: several of these gates write through the
 * SERVICE client, which bypasses RLS entirely, and there the app predicate is the
 * ONLY gate — admitting team_lead would be a real write to the brokerage's books.
 *
 * PURE:   the two app predicates. The claim is not "these roles" — it is that the
 *         two tiers differ by EXACTLY team_lead and nothing else, which is the
 *         ruling stated as a set operation. Plus the async grant halves, because
 *         m466 made a role grant an administering fact and a finance gate that
 *         read only user_type would refuse the ruling's second seat.
 * SOURCE: a shape scan over the tree for a RETYPED finance roster — the drift the
 *         owner's earlier ruling forbids ("more than one vocab over the same
 *         function or feature is dangerous"). Keyed to the SHAPE of a role-array
 *         membership test over a per-character string mask, never to a file path,
 *         a variable name, or any prose.
 * NEGATIVE CONTROLS: every absence claim above is re-run against a synthetic
 *         source that SHOULD trip it, and the proof fails if the trip does not
 *         happen. An absence that cannot be made to fail is not evidence.
 * LIVE (creds-gated): calls public.finance_authority_facts() (m472), which
 *         EXTRACTS the role lists out of the live pg_proc bodies, and compares
 *         them against the app sets. The proof does not restate the roles on
 *         either side — restating them would let both sides be wrong together.
 *         Self-skips without SUPABASE creds. Seeds nothing, so residue is 0 by
 *         construction.
 */
import { readFileSync } from "node:fs"
import { walkTs } from "./runtime-roots"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"
import {
  TENANT_ADMIN_USER_TYPES,
  BROKERAGE_FINANCE_ADMIN_USER_TYPES,
  isAdminOrBroker,
  isBrokerageFinanceAdmin,
  isTenantAdminGrantRole,
  isBrokerageFinanceAdminGrantRole,
  resolveTenantAdmin,
  resolveBrokerageFinanceAdmin,
} from "../lib/auth/resolve-user-role"
import { ROLE_WORDS } from "./shared/role-words"
import { blankComments, blankStrings } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}

const ROOT = process.cwd()
const SELF = fileURLToPath(import.meta.url)

/** The role the ruling moves, and the only one that may differ between the tiers. */
const THE_ROLE_HELD_OUT = "team_lead"

const setOf = (s: Set<string>) => [...s].sort()
const minus = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort()

// ─── PURE ────────────────────────────────────────────────────────────────────

function pureLayer() {
  console.log("\n[the two tiers · pure — one roster, asked a narrower question]")

  // THE RULING, AS A SET OPERATION. This is the claim; every role-by-role check
  // below is a consequence of it. Written this way so that adding a role to the
  // tenant roster tomorrow cannot quietly change which tier it lands in without
  // this line noticing.
  check("the two tiers differ by EXACTLY one role, and it is the one the ruling holds out",
    minus(TENANT_ADMIN_USER_TYPES, BROKERAGE_FINANCE_ADMIN_USER_TYPES).join(",") === THE_ROLE_HELD_OUT)
  check("...and the finance tier adds NOTHING the tenant roster does not already have",
    minus(BROKERAGE_FINANCE_ADMIN_USER_TYPES, TENANT_ADMIN_USER_TYPES).length === 0)
  check("...so finance is a STRICT subset — the narrow gate can never admit where the wide one refuses",
    BROKERAGE_FINANCE_ADMIN_USER_TYPES.size === TENANT_ADMIN_USER_TYPES.size - 1)

  // The ruling's own sentence, one role at a time, through the predicates the
  // call sites actually use.
  check("team_lead IS an admin surface", isAdminOrBroker({ user_type: THE_ROLE_HELD_OUT }))
  check("team_lead is NOT brokerage-wide money", !isBrokerageFinanceAdmin({ user_type: THE_ROLE_HELD_OUT }))

  for (const r of ["admin", "broker", "broker_owner"]) {
    check(`${r} keeps BOTH tiers — the finance side of m472 is a no-op for the roles it kept`,
      isAdminOrBroker({ user_type: r }) && isBrokerageFinanceAdmin({ user_type: r }))
  }
  // broker_owner is called out because several of the LOCAL literals this change
  // replaced omitted it — the person who OWNS the brokerage was refused by the
  // gate guarding their own brokerage's money.
  check("broker_owner reaches the books (the local literals m472 replaced refused them)",
    isBrokerageFinanceAdmin({ user_type: "broker_owner" }))

  for (const r of ["agent", "isa", "tc", "vendor", "lender", "contact", "compliance_officer", "title_agent"]) {
    check(`${r} reaches neither tier`,
      !isAdminOrBroker({ user_type: r }) && !isBrokerageFinanceAdmin({ user_type: r }))
  }

  // A predicate that throws on a missing value fails OPEN at the call site that
  // forgot a try/catch, so the empty answers are asserted rather than assumed.
  check("absent / null / unknown values answer FALSE on both tiers, and never throw",
    !isBrokerageFinanceAdmin({}) && !isBrokerageFinanceAdmin({ user_type: null }) &&
    !isBrokerageFinanceAdmin({ user_type: undefined }) && !isBrokerageFinanceAdmin({ user_type: "" }) &&
    !isBrokerageFinanceAdmin({ user_type: "nonsense_role" }) && !isAdminOrBroker({ user_type: "nonsense_role" }))

  // users.role is legacy free-form and MEASURED live holds 'Admin' and 'Lender'.
  check("both tiers are case-insensitive, matching the legacy free-form values live on users.role",
    isBrokerageFinanceAdmin({ user_type: "Broker" }) && isBrokerageFinanceAdmin({ user_type: "ADMIN" }) &&
    isAdminOrBroker({ user_type: "Team_Lead" }) && !isBrokerageFinanceAdmin({ user_type: "Team_Lead" }))

  // The GRANT vocabulary is the same vocabulary. m466 made a grant an
  // administering fact, so a grant spelling that disagreed with the user_type
  // spelling would be the same app/DB gap in a second place.
  check("the grant predicates answer identically to the user_type predicates, on both tiers",
    setOf(TENANT_ADMIN_USER_TYPES).every((r) => isTenantAdminGrantRole(r) === isAdminOrBroker({ user_type: r })) &&
    setOf(TENANT_ADMIN_USER_TYPES).every((r) =>
      isBrokerageFinanceAdminGrantRole(r) === isBrokerageFinanceAdmin({ user_type: r })))
  check("a team_lead GRANT is an admin surface and is still not money",
    isTenantAdminGrantRole(THE_ROLE_HELD_OUT) && !isBrokerageFinanceAdminGrantRole(THE_ROLE_HELD_OUT))
}

// ─── PURE · THE GRANT HALF ───────────────────────────────────────────────────

/**
 * A stand-in for the queries resolveBrokerageFinanceAdmin makes. It is not a
 * mock of supabase-js: it answers exactly the shapes the shared readers use, and
 * it can also answer a REFUSAL, which is the case the boolean-returning version
 * of this rule got wrong.
 *
 * ── WIDENED, AND TABLE-AWARE, BY m526 ───────────────────────────────────────
 *
 * This fake used to be TABLE-BLIND — `from: () => ...` returned the grant rows
 * for whatever table was asked — and answered only `.select().eq()`. That was a
 * faithful model of the rule while the rule read exactly one table.
 *
 * m526 gave `resolveBrokerageFinanceAdmin` a THIRD disjunct (the tier-conditioned
 * tenant principal: on TEAM/SOLO tier the lead of the tenant's one team keeps its
 * books; on BROKERAGE tier they still do not), which reads `teams` with `.is()`
 * and `brokerages` via readPlanTier. The old fake threw `.is is not a function`
 * — which is the RIGHT failure: an incomplete model of the client silently
 * answering for a table it was never given is how a proof passes while the code
 * is wrong. So the fake now dispatches BY TABLE and answers `.is()` /
 * `.maybeSingle()` too.
 *
 * `teams` answers EMPTY by default, so every assertion in this layer keeps its
 * original meaning: nobody here leads a team, so the new disjunct can only ever
 * return false and the grant rule is measured exactly as before. The principal
 * branch has its own proof — scripts/tenant-principal-books-simulator.ts.
 */
function fakeGrantsClient(
  rows: Array<Record<string, unknown>> | null,
  error: string | null,
  opts: { teams?: Array<Record<string, unknown>>; planTier?: string | null } = {},
) {
  const builder = (table: string) => {
    const answer = async () => {
      if (table === "teams") return { data: opts.teams ?? [], error: null }
      if (table === "brokerages") return { data: { plan_tier: opts.planTier ?? null }, error: null }
      if (table === "subscriptions") return { data: null, error: null }
      // user_role_assignments — the original behaviour, refusal included.
      return error ? { data: null, error: { message: error } } : { data: rows, error: null }
    }
    const api: Record<string, unknown> = {}
    for (const m of ["select", "eq", "in", "is", "order", "limit", "not"]) api[m] = () => api
    api.maybeSingle = answer
    api.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => answer().then(res, rej)
    return api
  }
  return { from: builder } as never
}

async function grantLayer() {
  console.log("\n[the grant half · pure — a grant administers, but not everything]")

  const OWN = "b-own", OTHER = "b-other"
  const grant = (role: string, brokerage: string | null) =>
    ({ role, brokerage_id: brokerage, vendor_id: null, agent_id: null })
  const profile = { user_type: "agent", brokerage_id: OWN }

  // The ruling's SECOND SEAT, live on this database: user_type 'agent' holding an
  // 'admin' grant alongside 'agent' and 'isa'. Three grants, which is why the
  // shared reader may never take a single row.
  const secondSeat = fakeGrantsClient([grant("admin", OWN), grant("agent", OWN), grant("isa", OWN)], null)
  const seatFin = await resolveBrokerageFinanceAdmin(secondSeat, "u1", profile)
  check("the second seat (an admin GRANT on their own brokerage) reaches the books",
    seatFin.ok && seatFin.isFinanceAdmin && seatFin.via === "grant")

  // The same multi-grant shape must not be answered by "read one grant".
  const seatWide = await resolveTenantAdmin(secondSeat, "u1", profile)
  check("...and the wide tier agrees about them, so the two tiers do not disagree about a NON-team_lead",
    seatWide.ok && seatWide.isTenantAdmin)

  const leadGrant = fakeGrantsClient([grant(THE_ROLE_HELD_OUT, OWN), grant("contact", null)], null)
  const leadFin = await resolveBrokerageFinanceAdmin(leadGrant, "u2", profile)
  const leadWide = await resolveTenantAdmin(leadGrant, "u2", profile)
  check("a team_lead GRANT is an admin surface in the app",
    leadWide.ok && leadWide.isTenantAdmin && leadWide.via === "grant")
  check("...and the SAME grant does not reach the books — the ruling, through the grant path",
    leadFin.ok && !leadFin.isFinanceAdmin && leadFin.via === "none")

  // The tenant pin. A grant administering someone else's brokerage authorises
  // nothing — not there, not here.
  const foreign = fakeGrantsClient([grant("broker", OTHER)], null)
  const foreignFin = await resolveBrokerageFinanceAdmin(foreign, "u3", profile)
  check("a broker grant on ANOTHER brokerage reaches nothing",
    foreignFin.ok && !foreignFin.isFinanceAdmin)

  // MEASURED live: the `contact` and `lender` grants both carry a NULL
  // brokerage_id. `NULL = x` is never true in SQL, and it must not be true here.
  const untenanted = fakeGrantsClient([grant("broker", null)], null)
  const untenantedFin = await resolveBrokerageFinanceAdmin(untenanted, "u4", { user_type: "agent", brokerage_id: null })
  check("an untenanted grant (brokerage_id NULL) can never satisfy the tenant pin",
    untenantedFin.ok && !untenantedFin.isFinanceAdmin)

  // The reason this returns a RESULT and not a boolean.
  const refused = fakeGrantsClient(null, "permission denied for table user_role_assignments")
  const refusedFin = await resolveBrokerageFinanceAdmin(refused, "u5", profile)
  check("a REFUSED grant read is reported as a refusal, never collapsed into 'not a finance admin'",
    !refusedFin.ok && typeof (refusedFin as { error: string }).error === "string")

  // user_type wins before any I/O, so a broker never pays for a round trip.
  const wouldThrow = fakeGrantsClient(null, "this read must never happen")
  const byType = await resolveBrokerageFinanceAdmin(wouldThrow, "u6", { user_type: "broker", brokerage_id: OWN })
  check("a user_type finance admin is answered without reading grants at all",
    byType.ok && byType.isFinanceAdmin && byType.via === "user_type")
}

// ─── SOURCE ──────────────────────────────────────────────────────────────────

// TOMBSTONE (orphan doctrine §1.1) — the private walker that stood here was one of
// 82 copies of the same readdirSync walker. The survivor is
// scripts/runtime-roots.ts:61 (`walkTs`), imported above.
//
// This one was NOT blind to the repository root — it walked ROOT itself, so
// `proxy.ts` and `types.ts` were already in its corpus. It is DEDUPLICATED here,
// not corrected, and the corpus is preserved exactly: `runtimeFiles()` would have
// been the wrong survivor to reach for, because NON_RUNTIME_ROOTS excludes
// `scripts/` and `e2e/` and swapping it in would have SHRUNK this scan while
// looking like a cleanup. Narrowing a corpus in order to deduplicate a walker is
// the same defect as the blindness being fixed, pointed the other way — so the
// recursion is the survivor's and every exclusion below is this file's own.
function walk(dir: string): string[] {
  return walkTs(dir).filter((p) => p !== SELF && !p.split("/").includes("dist"))
}

/**
 * A per-character mask: true where the character sits INSIDE a string literal,
 * a template literal, or a comment.
 *
 * ── WHY A TOKENISER AND NOT A BLANKER ───────────────────────────────────────
 *
 * A role array IS a run of string literals, so the usual trick of blanking every
 * string before scanning would blind this scan completely — the quotes are the
 * SIGNAL here, not the noise. But prose still has to be excluded, and prose
 * containing a role array hides in string literals as readily as in comments:
 * this repo's manager registry quotes several role arrays inside one enormous
 * string, and that is a DESCRIPTION of a gate, not a gate.
 *
 * The mask separates them structurally rather than by wording. In a real array
 * literal the BRACKETS, the commas and the `.includes(` are CODE — outside every
 * string — while the role names sit inside their own short literals. In a
 * quotation the whole thing, brackets included, sits inside ONE literal. So every
 * scan below requires the BRACKETS to be unmasked, and no rewording of any
 * comment, registry entry or docstring can change the result either way.
 *
 * Same construction as scripts/admin-vocabulary-simulator.ts, deliberately: this
 * proof asks the same structural question about the same vocabulary, and a second
 * tokeniser answering it slightly differently is the very drift being tested for.
 */
function stringMask(s: string): { mask: boolean[]; comment: boolean[] } {
  // DERIVED, not hand-rolled (finding #250). scripts/strip-comments.ts holds the
  // one correct scanner; both masks fall straight out of it because it preserves
  // every character offset:
  //   · blankComments() blanks COMMENT content only  → the `comment` mask;
  //   · blankStrings()  blanks comments AND string/template content → `mask`.
  // A character it changed is exactly a character it judged to be prose. The
  // hand-rolled scanner this replaces could not see `${…}` interpolations (which
  // are CODE and can hold a real call), regex literals, or an apostrophe in JSX
  // text — each desynchronises the scan and masks live code.
  const noComments = blankComments(s)
  const noStrings = blankStrings(s)
  const mask = new Array<boolean>(s.length)
  const comment = new Array<boolean>(s.length)
  for (let i = 0; i < s.length; i++) {
    comment[i] = noComments[i] !== s[i]
    mask[i] = noStrings[i] !== s[i]
  }
  return { mask, comment }
}

/**
 * The vocabulary a role array may be built from. Anything else is not a roster.
 *
 * IMPORTED, not restated. This scan forbids any module asking the shared finance
 * predicate from also keeping a role array — and this module asks it. It escaped
 * its own rule only through the self-exemption in the walk below; a second proof
 * that copied this set did NOT escape, and the scan caught it. One definition.
 */

/**
 * Every ARRAY LITERAL OF ROLE NAMES used as a MEMBERSHIP TEST.
 *
 * Pinned to three structural facts at once, none of them a name or a path:
 *   · the array's brackets are CODE (unmasked) — so a quotation cannot match;
 *   · every element is a bare string literal from the role vocabulary — so
 *     `["id","name"]` is not a roster;
 *   · the array is immediately consumed by `.includes(`, wrapped in `new Set(`,
 *     or handed to a PostgREST `.in(` — so a dropdown's option list or a type's
 *     enumeration is not a GATE.
 */
function roleArrayGates(src: string): Array<{ roles: string[]; index: number }> {
  const { mask, comment } = stringMask(src)
  /** Whitespace, or a comment sitting between two elements of the array. */
  const skippable = (k: number) => /\s/.test(src[k]) || comment[k]
  const hits: Array<{ roles: string[]; index: number }> = []
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "[" || mask[i]) continue
    let j = i + 1
    const roles: string[] = []
    let ok = true
    for (;;) {
      while (j < src.length && skippable(j)) j++
      if (src[j] === "]") break
      const q = src[j]
      if (q !== '"' && q !== "'") { ok = false; break }
      const close = src.indexOf(q, j + 1)
      if (close === -1) { ok = false; break }
      const word = src.slice(j + 1, close)
      if (!/^[a-z_]+$/.test(word)) { ok = false; break }
      roles.push(word)
      j = close + 1
      while (j < src.length && skippable(j)) j++
      if (src[j] === ",") { j++; continue }
      if (src[j] === "]") break
      ok = false; break
    }
    if (!ok || src[j] !== "]" || roles.length === 0) continue
    if (!roles.every((r) => ROLE_WORDS.has(r))) continue

    const after = src.slice(j + 1, j + 24)
    const before = src.slice(Math.max(0, i - 10), i)
    const consumed = /^\s*\.includes\s*\(/.test(after) || /new\s+Set\s*\(\s*$/.test(before) || /\.\s*in\s*\(\s*$/.test(before.replace(/["'\w]+,\s*$/, ""))
    if (!consumed) continue
    hits.push({ roles, index: i })
  }
  return hits
}

/**
 * True when the hit is the finance roster written out BY HAND — the same set the
 * canonical module DERIVES. Built from the live set, never from a literal here,
 * so this predicate cannot drift away from what it is policing.
 */
const isRetypedFinanceRoster = (roles: string[]) => {
  const got = new Set(roles)
  return got.size === BROKERAGE_FINANCE_ADMIN_USER_TYPES.size &&
    [...BROKERAGE_FINANCE_ADMIN_USER_TYPES].every((r) => got.has(r))
}

/** Does this source DEFINE the finance predicate — i.e. is it the canonical module? */
function definesFinancePredicate(src: string): boolean {
  const { mask } = stringMask(src)
  const at = src.indexOf("export function isBrokerageFinanceAdmin")
  return at !== -1 && !mask[at]
}

/** Does this source CALL the finance predicate, as code rather than in prose? */
function callsFinancePredicate(src: string): boolean {
  const { mask } = stringMask(src)
  for (const name of ["isBrokerageFinanceAdmin", "resolveBrokerageFinanceAdmin"]) {
    let from = 0
    for (;;) {
      const at = src.indexOf(name, from)
      if (at === -1) break
      from = at + name.length
      if (mask[at]) continue                       // a mention in a comment or a string
      if (/^\s*\(/.test(src.slice(from))) return true  // an actual call
    }
  }
  return false
}

function sourceLayer() {
  console.log("\n[the tree · source — the finance roster exists once, or it will drift]")

  const files = walk(ROOT)
  const all: Array<{ file: string; roles: string[] }> = []
  const repointed: Array<{ file: string; localRosters: string[][] }> = []
  for (const f of files) {
    let src: string
    try { src = readFileSync(f, "utf8") } catch { continue }
    if (!src.includes("[")) continue
    const gates = roleArrayGates(src)
    for (const h of gates) all.push({ file: relative(ROOT, f), roles: h.roles })
    // The module that DEFINES the predicate is exempt: it is the one place the
    // roster is supposed to live, and the claim below is about COPIES of it.
    // Keyed to the export that defines it, so the exemption follows the
    // definition if it ever moves rather than pinning a path.
    if (definesFinancePredicate(src)) continue
    if (callsFinancePredicate(src)) {
      repointed.push({ file: relative(ROOT, f), localRosters: gates.map((h) => h.roles) })
    }
  }

  // POSITIVE CONTROLS, first — an absence claim over a scanner that sees nothing
  // passes vacuously, and a broken regex and a clean tree report the same zero.
  check("POSITIVE CONTROL — the scanner still finds role-array gates in the tree at all",
    all.length > 0)
  check("POSITIVE CONTROL — ...including admin-class ones, which is the family being policed",
    all.some((h) => h.roles.includes("broker") && h.roles.includes("admin")))
  check("POSITIVE CONTROL — modules that CALL the finance predicate are found, so the next claim is not empty",
    repointed.length > 0)

  // THE ABSENCE CLAIM, scoped to where it is actually a defect. The owner's
  // earlier ruling: "having more than one vocab over the same function or feature
  // is dangerous." A module that asks the shared finance predicate and ALSO keeps
  // a role array of its own has two answers to one question — and the local copy
  // is the one that will not be updated, because nothing points at it. That is
  // exactly what m472 removed from the money surfaces, one file at a time.
  //
  // It is NOT asserted tree-wide: an operational gate whose roster happens to
  // omit team_lead is not a finance roster, it is an unrelated rule that looks
  // alike, and failing on those would train the next reader to ignore this proof.
  const shadowed = repointed.filter((r) => r.localRosters.length > 0)
  check("no module that asks the shared finance predicate ALSO keeps a role array of its own",
    shadowed.length === 0)
  if (shadowed.length) for (const r of shadowed.slice(0, 8)) {
    console.log(`      ${r.file}: ${r.localRosters.map((x) => "[" + x.join(", ") + "]").join(" ")}`)
  }

  // The canonical module must hold exactly ONE role array: the tenant roster.
  // A second one there would mean the finance set stopped being a subtraction and
  // started being a copy — the drift, at its source.
  const modPath = join(ROOT, "lib", "auth", "resolve-user-role.ts")
  const mod = readFileSync(modPath, "utf8")
  const modGates = roleArrayGates(mod)
  check("POSITIVE CONTROL — the canonical module's own roster is visible to the scanner",
    modGates.length >= 1)
  check("...and it is the ONLY role array there, so the finance tier can only be a subtraction",
    modGates.length === 1)
  check("...and that one array is the WIDE roster — it contains the role the finance tier removes",
    modGates.length === 1 && modGates[0].roles.includes(THE_ROLE_HELD_OUT))
  check("...so the finance roster is NOT written out anywhere in the canonical module",
    !modGates.some((h) => isRetypedFinanceRoster(h.roles)))
}

// ─── NEGATIVE CONTROLS ───────────────────────────────────────────────────────

/**
 * Every absence asserted above, re-run against source that SHOULD trip it. A
 * check that cannot be made to fail is not evidence.
 *
 * The synthetic sources are BUILT from the live sets rather than typed out, so a
 * change to either roster cannot leave a control quietly testing the old one.
 */
function negativeControls() {
  console.log("\n[negative controls · each must go RED, or the check above proves nothing]")

  const FIN = [...BROKERAGE_FINANCE_ADMIN_USER_TYPES]
  const arr = (xs: string[]) => "[" + xs.map((x) => `"${x}"`).join(", ") + "]"

  const retypedSrc = `if (${arr(FIN)}.includes(t)) { grantMoney() }`
  const hits = roleArrayGates(retypedSrc)
  check("RED — a hand-retyped finance roster IS caught by the scanner",
    hits.length === 1 && isRetypedFinanceRoster(hits[0].roles))

  const setHits = roleArrayGates(`const F = new Set(${arr([...FIN].reverse())})`)
  check("RED — ...in `new Set(...)` form too, and regardless of the order the roles are written in",
    setHits.length === 1 && isRetypedFinanceRoster(setHits[0].roles))

  // A multi-line roster with a comment beside one entry is the ORDINARY shape in
  // this repo — the canonical roster itself is written that way. A walker that
  // gave up at the comment would report zero everywhere and pass every absence
  // claim vacuously, which is precisely how this scan failed on its first run.
  const withComment = `const F = new Set([\n  ${FIN.slice(0, -1).map((x) => `"${x}",`).join("\n  ")}\n  // legacy input spelling\n  "${FIN[FIN.length - 1]}",\n])`
  const cHits = roleArrayGates(withComment)
  check("RED — a role array with a COMMENT between its elements is still parsed, not skipped",
    cHits.length === 1 && isRetypedFinanceRoster(cHits[0].roles))

  // The mask is what separates a gate from a description of a gate. Both
  // directions are controlled: a mask that swallowed everything would make every
  // absence claim pass while seeing nothing.
  const quoted = `const note = "the old gate was ${arr(FIN).replace(/"/g, '\\"')}.includes(t)"`
  check("RED — a role array QUOTED inside prose is NOT counted as a gate",
    roleArrayGates(quoted).length === 0)
  const commented = `// legacy: ${arr(FIN)}.includes(t)\nconst x = 1`
  check("RED — ...nor one sitting in a comment",
    roleArrayGates(commented).length === 0)
  check("RED — ...but a REAL gate written beside that prose is still caught, so the mask did not blind the scan",
    roleArrayGates(`${quoted}\n${commented}\n${retypedSrc}`).length === 1)

  // The vocabulary and consumption filters, both ways.
  check("RED — an array of non-role strings is not mistaken for a roster",
    roleArrayGates(`const cols = ["id", "name", "status"]\nif (cols.includes(x)) {}`).length === 0)
  check("RED — ...and an UNCONSUMED role array (a type's enumeration, a dropdown) is not a GATE",
    roleArrayGates(`const OPTIONS = ${arr(FIN)}`).length === 0)

  // The predicate-call detector, which scopes the shadow-roster claim. If it
  // could not tell a call from a mention, that claim would be scoped to nothing.
  check("RED — a CALL to the finance predicate is detected",
    callsFinancePredicate(`isBrokerageFinanceAdmin({ user_type: t })`) &&
    callsFinancePredicate(`await resolveBrokerageFinanceAdmin(db, id, p)`))
  check("RED — ...and a MENTION of it in prose or a comment is not",
    !callsFinancePredicate(`// see isBrokerageFinanceAdmin for the roster`) &&
    !callsFinancePredicate(`const doc = "call isBrokerageFinanceAdmin(x) here"`))

  // The set claims. If the tiers were built wrong, the pure layer must notice.
  const wrongFinance = new Set([...TENANT_ADMIN_USER_TYPES])
  check("RED — a finance tier that kept team_lead fails the exactly-one-role-apart claim",
    minus(TENANT_ADMIN_USER_TYPES, wrongFinance).join(",") !== THE_ROLE_HELD_OUT)
  const overNarrow = new Set([...BROKERAGE_FINANCE_ADMIN_USER_TYPES].filter((r) => r !== "broker_owner"))
  check("RED — a finance tier that ALSO dropped broker_owner fails it as well (a silent revocation)",
    minus(TENANT_ADMIN_USER_TYPES, overNarrow).join(",") !== THE_ROLE_HELD_OUT)
  const widened = new Set([...BROKERAGE_FINANCE_ADMIN_USER_TYPES, "isa"])
  check("RED — a finance tier holding a role the tenant roster lacks is caught as a superset",
    minus(widened, TENANT_ADMIN_USER_TYPES).length !== 0)
}

// ─── LIVE ────────────────────────────────────────────────────────────────────

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("\n[live] SKIPPED — no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env")
    return
  }
  console.log("\n[live · the app and the database, compared — not restated]")

  const svc = createClient(url, key, { auth: { persistSession: false } })

  // supabase-js RESOLVES a failed call: `const { data }` alone would read a
  // missing function as "no facts" and every assertion below would pass over
  // nothing. The error is destructured and checked.
  const { data, error } = await svc.rpc("finance_authority_facts")
  if (error) {
    check(`live facts RPC readable (m472 applied?) — ${error.message}`, false)
    return
  }
  const f = data as Record<string, unknown>
  const dbWide = ((f.wide_roles as string[]) ?? []).slice().sort()
  const dbNarrow = ((f.narrow_roles as string[]) ?? []).slice().sort()

  // The proof reads the roles OUT OF the live function bodies. It does not carry
  // its own copy of them — a copy would let the app and the database be wrong
  // together while this file agreed with both.
  check("POSITIVE CONTROL — the live bodies yielded role lists at all",
    dbWide.length > 0 && dbNarrow.length > 0)

  // Stated as containment plus the ONE documented extra, because the app tolerates
  // a legacy INPUT spelling the database has no reason to store: `broker_admin` is
  // not a storable user_type (users_user_type_check admits fourteen values, that is
  // not one of them, and it is VALIDATED), so it matches no row on either side and
  // cannot make the app wider than RLS in practice.
  check("...every role the DB wide tier admits, the app wide tier admits",
    dbWide.every((r) => isAdminOrBroker({ user_type: r })))
  check("...and the app adds nothing over it but the documented non-storable input spelling",
    minus(TENANT_ADMIN_USER_TYPES, new Set(dbWide)).join(",") === "broker_admin")

  check("every role the DB finance tier admits, the app finance tier admits",
    dbNarrow.every((r) => isBrokerageFinanceAdmin({ user_type: r })))
  check("...and the app finance tier adds nothing over it but that same input spelling",
    minus(BROKERAGE_FINANCE_ADMIN_USER_TYPES, new Set(dbNarrow)).join(",") === "broker_admin")

  // THE RULING, measured on the database rather than asserted about it.
  check("the DB's two tiers differ by EXACTLY the role the app's two tiers differ by",
    minus(new Set(dbWide), new Set(dbNarrow)).join(",") === THE_ROLE_HELD_OUT &&
    minus(new Set(dbNarrow), new Set(dbWide)).length === 0)
  check("...and the DB finance tier refuses that role, which is the ruling itself",
    !dbNarrow.includes(THE_ROLE_HELD_OUT) && dbWide.includes(THE_ROLE_HELD_OUT))

  // BOTH branches, on BOTH predicates. user_type='team_lead' and a 'team_lead'
  // GRANT are both live on this database; a predicate carrying the role list in
  // only one branch would admit one spelling of the same seat and refuse the other.
  check("both predicates carry their role list in BOTH branches (user_type AND the grant)",
    f.wide_branches === 2 && f.narrow_branches === 2)

  // The partition. A table on both predicates, or on neither, means the split is
  // not a split — and a finance table left on the wide predicate is the defect
  // this whole change exists to prevent.
  const fin = f.finance_tables as number, ops = f.ops_tables as number
  const finP = f.finance_policies as number, opsP = f.ops_policies as number
  console.log(`      FINANCE ${fin} tables / ${finP} policies · OPERATIONAL ${ops} tables / ${opsP} policies`)
  check("no table sits under BOTH predicates — the split is a partition",
    f.tables_in_both === 0)
  check("the partition still covers every table and policy the wide predicate governed",
    fin + ops === 113 && finP + opsP === 226)
  check("both tiers actually govern something (neither repoint silently emptied)",
    fin > 0 && ops > 0 && finP > 0 && opsP > 0)

  // A boolean function composed by 226 policies that can answer NULL is a trap
  // for anything that composes it — a NOT, a coalesce with a different default,
  // a join. RLS hiding a NULL behind fail-closed is how that survives an apply.
  check("with NO identity established, both predicates answer a strict FALSE, never NULL",
    f.wide_no_identity === false && f.narrow_no_identity === false)

  // Seeded nothing, so there is nothing to clean up.
  console.log("      seeded rows: 0 · residue: 0 (this layer reads the catalogue only)")
}

// ─── RUN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═".repeat(78))
  console.log(" FINANCE AUTHORITY — admin surfaces admit team_lead, the books do not (m472)")
  console.log("═".repeat(78))

  pureLayer()
  await grantLayer()
  sourceLayer()
  negativeControls()
  await liveLayer()

  console.log("\n" + "═".repeat(78))
  console.log(` ${pass} passed · ${fail} failed`)
  if (fail) {
    console.log("\nFAILED:")
    for (const f of fails) console.log(`  ✗ ${f}`)
  }
  console.log("═".repeat(78))
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
