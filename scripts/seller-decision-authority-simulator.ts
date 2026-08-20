#!/usr/bin/env tsx
/**
 * scripts/seller-decision-authority-simulator.ts  (npm run test:seller-decision-authority)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OVERRIDE ON A SELLER-DECISION GATE IS AN AUTHORITY, AND THE ACTOR IS NOT
 * SOMETHING THE CLIENT GETS TO SAY.
 *
 * Owner ruling, verbatim, on the vocabulary half:
 *
 *   "i think having more than one vocab over the same function or feature is
 *    dangerous."
 *
 * and on the money half (m472):
 *
 *   "Admin surfaces, but NOT brokerage-wide money. ... Hold it OUT of the ~18
 *    brokerage-wide financial gates — ... net-sheet overrides — which stay
 *    broker/broker_owner/admin."
 *
 * ── THE THREE DEFECTS THIS PROOF EXISTS TO PREVENT ──────────────────────────
 *
 * (1) THE OVERRIDE HAD NO GATE. The offers screen rendered "Override & Accept
 *     Anyway" for every user who could see it. Pressing it logged
 *     `override_flag: true` and proceeded — the CMA / net-sheet override
 *     authority that lib/seller-decision-governance implements with
 *     isBrokerageFinanceAdmin was never consulted on that path AT ALL. An
 *     authority that no code path asks is not an authority.
 *
 * (2) THE AUDIT TRAIL NAMED ITS OWN SUBJECT. Three server actions took
 *     `authority_role` as an ARGUMENT, and the one live caller passed the string
 *     literal "agent" at all three — from a component that already held the real
 *     role in a prop. So every seller-decision transition and reversal on this
 *     database claimed an agent made it, whoever actually did, and any client
 *     could have named any role it liked.
 *
 * (3) ONE VOCABULARY, FOUR COPIES. The role union for this feature was written
 *     out by hand in four places. Three were widened to admit broker_owner when
 *     the override became a real authority test; the fourth — the LOGGER — was
 *     not, so the evaluators admitted a broker_owner the audit trail could not
 *     record. A restated union is not a type, it is a second vocabulary.
 *
 * PURE:   the roster claim, through the SAME predicates the action uses. The
 *         claim is not "these roles" — it is that the override tier is the
 *         finance tier, so team_lead is refused and broker_owner admitted.
 * SOURCE: shape scans, over a per-character string mask so that this very file's
 *         prose cannot satisfy them:
 *           · no action in the governance module accepts the actor as an input;
 *           · the override path in that module CALLS the finance authority;
 *           · the client passes no role literal to those actions;
 *           · the governance lib restates no role union — it imports one.
 * NEGATIVE CONTROLS: every absence claim is re-run against synthetic source that
 *         SHOULD trip it. An absence that cannot be made to fail is not evidence.
 * LIVE (creds-gated): the app rule is run over EVERY real users row and compared
 *         against the database's own public.is_brokerage_finance_admin(), so the
 *         two cannot drift into two answers. Seeds nothing; residue 0 by
 *         construction. Self-skips without SUPABASE creds.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  BROKERAGE_FINANCE_ADMIN_USER_TYPES,
  isAdminOrBroker,
  isBrokerageFinanceAdmin,
  isBrokerageFinanceAdminGrantRole,
} from "../lib/auth/resolve-user-role"
// The scanner vocabulary is SHARED, never restated — finance-authority's scan
// forbids a module that asks the finance predicate from also keeping a role
// array, and this module asks it. That scan is what caught the copy this import
// replaces.
import { ROLE_WORDS } from "./shared/role-words"
import { blankComments, blankStrings } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}

const ROOT = process.cwd()
const ACTION = "app/actions/seller-decision-governance.ts"
const CLIENT = "app/dashboard/listings/[id]/offers/offers-manager-client.tsx"
const PAGE = "app/dashboard/listings/[id]/offers/page.tsx"
const LIB = [
  "lib/seller-decision-governance/decision-readiness-engine.ts",
  "lib/seller-decision-governance/cma-quality-evaluator.ts",
  "lib/seller-decision-governance/net-sheet-validator.ts",
  "lib/seller-decision-governance/decision-logger.ts",
]
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

/**
 * Per-character mask: true where the character is inside a comment or a string
 * literal. Every scan below runs over this, because this file describes the very
 * shapes it forbids — without the mask the proof would fail on its own prose,
 * and, worse, a future edit could satisfy a scan by mentioning it in a comment.
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

/** Occurrences of `needle` that are CODE — not a mention in prose or a literal. */
function codeHits(src: string, needle: string): number[] {
  const { mask } = stringMask(src)
  const out: number[] = []
  let from = 0
  for (;;) {
    const at = src.indexOf(needle, from)
    if (at === -1) return out
    from = at + needle.length
    if (!mask[at]) out.push(at)
  }
}



/**
 * Every RESTATED ROLE UNION — a type position spelling out `"a" | "b" | "c"` from
 * the role vocabulary. Pinned to the shape (quoted role words joined by CODE
 * pipes), not to any particular set of roles, so it catches the next restatement
 * whatever roles it happens to carry. The pipes must be unmasked, which is what
 * separates a real type annotation from this comment describing one.
 */
function restatedRoleUnions(src: string): string[][] {
  const { mask } = stringMask(src)
  const out: string[][] = []
  const re = /(["'])([a-z_]+)\1/g
  let m: RegExpExecArray | null
  let claimed = -1
  while ((m = re.exec(src))) {
    if (m.index <= claimed) continue
    if (!ROLE_WORDS.has(m[2])) continue
    // Walk forward collecting `| "role"` while every pipe between them is CODE.
    const roles = [m[2]]
    let j = m.index + m[0].length
    for (;;) {
      let k = j
      while (k < src.length && /\s/.test(src[k])) k++
      if (src[k] !== "|" || mask[k]) break
      k++
      while (k < src.length && /\s/.test(src[k])) k++
      const q = src[k]
      if (q !== '"' && q !== "'") break
      const close = src.indexOf(q, k + 1)
      if (close === -1) break
      const word = src.slice(k + 1, close)
      if (!ROLE_WORDS.has(word)) break
      roles.push(word)
      j = close + 1
    }
    if (roles.length >= 2) { out.push(roles); claimed = j }
  }
  return out
}

// ─── PURE ────────────────────────────────────────────────────────────────────

function pureLayer() {
  console.log("\n[the override tier · pure — it is the money tier, not the admin tier]")

  // THE CLAIM, as the ruling states it. Not a role list: a statement about WHICH
  // of the two tiers this authority sits in. Asked through the same predicate the
  // action calls, so the proof cannot agree with a rule the code does not use.
  check("team_lead may NOT override a seller-decision gate (m472 holds the books closed to them)",
    isBrokerageFinanceAdmin({ user_type: "team_lead" }) === false)
  check("...while team_lead REMAINS admin-class everywhere else, so this is a tier and not a demotion",
    isAdminOrBroker({ user_type: "team_lead" }) === true)

  for (const r of ["broker", "broker_owner", "admin"]) {
    // broker_owner is called out: the four-value union this feature restated in
    // four places omitted it, so the person who OWNS the brokerage was refused
    // at the gate guarding their own brokerage's seller documents.
    check(`${r} may override a seller-decision gate`, isBrokerageFinanceAdmin({ user_type: r }))
  }
  for (const r of ["agent", "isa", "tc", "compliance_officer", "contact", "lender", "vendor"]) {
    check(`${r} may not override`, !isBrokerageFinanceAdmin({ user_type: r }))
  }

  // The grant half. m466 made a role grant an administering fact, and the action
  // reads it with this predicate — the SAME roster, asked of a
  // user_role_assignments.role value rather than a users.user_type one.
  check("a GRANT of an override-tier role qualifies (the ruling's second seat)",
    [...BROKERAGE_FINANCE_ADMIN_USER_TYPES].every(isBrokerageFinanceAdminGrantRole))
  check("...and a grant of team_lead or agent does not",
    !isBrokerageFinanceAdminGrantRole("team_lead") && !isBrokerageFinanceAdminGrantRole("agent"))
  check("absent / null / unknown answer FALSE rather than throwing (a throw fails OPEN upstream)",
    !isBrokerageFinanceAdmin({}) && !isBrokerageFinanceAdmin({ user_type: null }) &&
    !isBrokerageFinanceAdminGrantRole(null) && !isBrokerageFinanceAdminGrantRole(""))
}

// ─── SOURCE ──────────────────────────────────────────────────────────────────

function sourceLayer() {
  console.log("\n[the wiring · source — the actor is resolved, never accepted]")

  const action = read(ACTION)
  const client = read(CLIENT)
  const page = read(PAGE)

  // (2) THE AUDIT TRAIL MUST NOT NAME ITS OWN SUBJECT.
  //
  // Keyed to the field appearing as a DECLARED INPUT of this module — an
  // `authority_role:` or `overrideByRole:` in a type position that is code. The
  // module still USES both names (it builds the logger's event and the engine's
  // input), so the claim cannot be "the string never appears"; it is "it is never
  // something a caller supplies". `Omit<…, "authority_role">` puts the name
  // inside a string literal, which the mask correctly ignores.
  const declaresActorInput = (src: string, field: string) => {
    const { mask } = stringMask(src)
    let from = 0
    for (;;) {
      const at = src.indexOf(field, from)
      if (at === -1) return false
      from = at + field.length
      if (mask[at]) continue
      // A LOCAL VARIABLE is not an input. `let overrideByRole: UserRole` is
      // exactly how the module holds the value it resolved for itself, and an
      // earlier version of this scan counted it — reporting the fix as the
      // defect. Keyed to the declarator keyword immediately before the name.
      if (/\b(let|const|var)\s+$/.test(src.slice(Math.max(0, at - 8), at))) continue
      // An INPUT is `field?: T` / `field: T` in a TYPE position. Require the
      // colon to be followed by a role union, a named role type, or `string` —
      // not by an identifier the module computed for itself.
      const tail = src.slice(from).match(/^\??\s*:\s*([^\n,;}]+)/)
      if (!tail) continue
      const t = tail[1].trim()
      if (/^(string|UserRole|"[a-z_]+"|'[a-z_]+')/.test(t)) return true
    }
  }
  check("the governance actions declare NO authority_role input — the seat is stamped from the session",
    !declaresActorInput(action, "authority_role"))
  check("...and NO overrideByRole input — a client cannot name the authority it is overriding with",
    !declaresActorInput(action, "overrideByRole"))

  // NEGATIVE CONTROL: the scan must actually trip on the shape it forbids,
  // otherwise both claims above are vacuous.
  check("NEGATIVE CONTROL — the actor-input scan trips on a declared authority_role",
    declaresActorInput('export async function f(input: { authority_role: "agent" | "admin" }) {}', "authority_role"))
  check("NEGATIVE CONTROL — ...and on a declared overrideByRole typed as UserRole",
    declaresActorInput("export async function f(input: { overrideByRole?: UserRole }) {}", "overrideByRole"))
  check("NEGATIVE CONTROL — ...and is NOT fooled by the name inside an Omit<> string literal",
    !declaresActorInput('export async function f(i: Omit<E, "authority_role">) {}', "authority_role"))
  check("NEGATIVE CONTROL — ...nor by the module's OWN resolved local (the fix must not read as the defect)",
    !declaresActorInput("let overrideByRole: UserRole | undefined", "overrideByRole"))

  // (1) THE OVERRIDE PATH MUST ASK THE AUTHORITY.
  check("the governance module CALLS the finance authority (user_type half)",
    codeHits(action, "isBrokerageFinanceAdmin(").length > 0)
  check("...and the GRANT half, so the ruling's second seat is not refused by the app alone",
    codeHits(action, "isBrokerageFinanceAdminGrantRole(").length > 0)
  check("...and reads grants through the SHARED reader (user_role_assignments is UNIQUE on (user_id, role))",
    codeHits(action, "readRoleGrants(").length > 0)
  check("...and never through maybeSingle(), which is the wrong shape for a multi-grant user",
    codeHits(action, "user_role_assignments").every(() => true) &&
    !/user_role_assignments[\s\S]{0,200}?maybeSingle/.test(action))
  check("the caller's own identity comes from the session, not from the input",
    codeHits(action, "auth.getUser(").length > 0)

  // (2) again, from the CALLER's side: no role literal may travel to these actions.
  const govCalls = ["logSellerDecisionTransition", "logSellerDecisionReversal", "evaluateSellerDecisionReadiness"]
  const passesRoleLiteral = govCalls.some((fn) => {
    for (const at of codeHits(client, fn + "(")) {
      // The argument object ends at the first `})` after the call.
      const end = client.indexOf("})", at)
      const arg = client.slice(at, end === -1 ? at + 600 : end)
      if (/\b(authority_role|overrideByRole|approved_by_role)\s*:/.test(arg)) return true
    }
    return false
  })
  check("the offers screen passes NO role to the governance actions (it used to pass the literal \"agent\")",
    !passesRoleLiteral)
  check("...and the override button re-enters the SERVER gate rather than proceeding on its own",
    /requestOverride\s*:\s*true/.test(client) && codeHits(client, "requestOverride").length > 0)

  // The client-side hide is a courtesy; the claim is that it is not the ONLY
  // gate, and that it is resolved with BOTH halves rather than from user_type.
  check("the override control is gated by a flag RESOLVED ON THE SERVER, not derived in the client",
    codeHits(client, "canOverrideDecisionGate").length > 0 &&
    codeHits(page, "resolveBrokerageFinanceAdmin(").length > 0)
  check("...and that server resolution FAILS CLOSED on a refused grant read",
    /financeAdmin\.ok\s*&&\s*financeAdmin\.isFinanceAdmin/.test(page))

  // The platform/tenant vocabularies stay apart: a platform_role must not be fed
  // into a slot every consumer reads as a users.user_type.
  check("the offers page no longer falls back to platform_role for the tenant role slot",
    !/userRole=\{[^}]*platform_role/.test(page))

  // (3) ONE VOCABULARY. The governance lib must not restate the role union.
  const restated: Array<{ file: string; roles: string[] }> = []
  for (const f of [...LIB, ACTION]) {
    for (const roles of restatedRoleUnions(read(f))) restated.push({ file: f, roles })
  }
  check("the seller-decision governance lib restates NO role union — every one is imported",
    restated.length === 0)
  if (restated.length) {
    for (const r of restated) console.log(`      ${r.file}: ${r.roles.join(" | ")}`)
  }
  check("NEGATIVE CONTROL — the restated-union scan trips on a real inline union",
    restatedRoleUnions('type X = { r?: "agent" | "team_lead" | "broker" | "admin" }').length === 1)
  check("NEGATIVE CONTROL — ...and ignores the same words written in prose",
    restatedRoleUnions('// overrideByRole is "agent" | "team_lead" | "broker" | "admin"').length === 0)

  // POSITIVE CONTROL: the union scanner must still see unions somewhere in the
  // tree, or its silence over the lib means nothing.
  check("POSITIVE CONTROL — the union scanner still finds role unions elsewhere (it is not simply blind)",
    restatedRoleUnions(read("lib/listing-lifecycle/lifecycle-definitions.ts")).length > 0)

  // The logger's field must be the SHARED vocabulary, reached by import.
  const logger = read("lib/seller-decision-governance/decision-logger.ts")
  check("the logger's authority_role is the imported user_type vocabulary (it could not record broker_owner before)",
    /authority_role\s*:\s*UserRole/.test(logger) && codeHits(logger, "resolve-user-role").length === 0 &&
    /import type \{ UserRole \} from "@\/lib\/auth\/resolve-user-role"/.test(logger))

  // AN AUDIT TRAIL MUST NOT REPORT A ROW IT DID NOT WRITE.
  //
  // Every logger returned `void` and destructured no `error` — not on the
  // listing read, not on the insert. supabase-js RESOLVES a refused query, so an
  // RLS denial reached the action as silence and the action answered
  // `{ success: true }`. The override branch in the client now HALTS on a failed
  // write, which is only meaningful if that failure can actually be observed.
  check("no logger returns void — each reports whether the audit row was written",
    !/export async function log[A-Za-z]+\([^)]*\)\s*:\s*Promise<void>/.test(logger))
  check("...the listing read destructures its error (a refusal is not 'listing not found')",
    /const \{ data: listing, error: \w+ \}/.test(logger))
  check("...and the INSERT destructures its error (a refused write is not a written row)",
    /const \{ error: \w+ \} = await supabase\.from\("activities"\)\.insert/.test(logger))
  check("the actions RELAY that answer instead of asserting success over it",
    codeHits(action, "if (!wrote.ok)").length >= 5)
  check("...and the override path HALTS when its own justification was not recorded",
    /if \(isOverride\)[\s\S]{0,400}?Override NOT recorded/.test(client))
}

// ─── LIVE ────────────────────────────────────────────────────────────────────

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("\n[live] SKIPPED — no SUPABASE_URL / SERVICE_ROLE_KEY in env")
    return
  }
  console.log("\n[live · app and database must answer the override question identically]")
  const db = createClient(url, key, { auth: { persistSession: false } })

  const { data: users, error: uErr } = await db
    .from("users").select("id, email, user_type, brokerage_id")
  // DESTRUCTURE: supabase-js resolves a refused read, so `data` alone would turn
  // an outage into "zero disagreements" — a vacuous pass.
  check("the users roster is READABLE (a refused read must not read as agreement)", !uErr && !!users)
  if (uErr || !users) return

  const { data: grants, error: gErr } = await db
    .from("user_role_assignments").select("user_id, role, brokerage_id")
  check("the grants table is READABLE", !gErr && !!grants)
  if (gErr || !grants) return

  // The APP's rule, run exactly as resolveOverrideRole runs it: the user_type
  // half, then a grant PINNED to the caller's own brokerage.
  const appSaysYes = (u: { id: string; user_type: string | null; brokerage_id: string | null }) => {
    if (isBrokerageFinanceAdmin({ user_type: u.user_type })) return true
    if (!u.brokerage_id) return false
    return grants.some((g: any) =>
      g.user_id === u.id && g.brokerage_id && g.brokerage_id === u.brokerage_id &&
      isBrokerageFinanceAdminGrantRole(g.role))
  }

  // THE DATABASE'S OWN ROSTER, NOT A COPY OF IT.
  //
  // public.is_brokerage_finance_admin() takes no arguments and keys on
  // auth.uid(), which is NULL under the service role — so it cannot be asked
  // "is THIS user a finance admin" from here. finance_authority_facts() (m472)
  // EXTRACTS the role list out of the live pg_proc body instead, which is
  // stronger than calling it per-user would be: this proof restates the roles on
  // NEITHER side, so both sides cannot be wrong together.
  const { data: facts, error: fErr } = await db.rpc("finance_authority_facts")
  check("the database can state its own finance roster (m472's facts RPC)", !fErr && !!facts)
  if (fErr || !facts) return
  const dbRoles: string[] = (facts as any).narrow_roles ?? []
  check("POSITIVE CONTROL — the database roster is non-empty (an empty one would agree with anything)",
    dbRoles.length > 0)
  check("the database's finance roster and the app's are the SAME SET — neither is a copy of the other",
    dbRoles.slice().sort().join(",") === [...BROKERAGE_FINANCE_ADMIN_USER_TYPES]
      .filter((r) => r !== "broker_admin")   // input-only spelling, not storable, so never in pg_proc
      .sort().join(","))

  // Now apply BOTH rosters to the REAL population and require the same verdict
  // per row. A set comparison alone would miss a disagreement in how the two
  // sides pin a grant to a tenant, which is where the second seat lives.
  const dbSaysYes = (u: any) => {
    if (u.user_type && dbRoles.includes(String(u.user_type).toLowerCase())) return true
    if (!u.brokerage_id) return false
    return grants.some((g: any) =>
      g.user_id === u.id && g.brokerage_id && g.brokerage_id === u.brokerage_id &&
      g.role && dbRoles.includes(String(g.role).toLowerCase()))
  }

  const disagreements: string[] = []
  let appYes = 0
  for (const u of users as any[]) {
    const a = appSaysYes(u)
    if (a) appYes++
    if (a !== dbSaysYes(u)) disagreements.push(`${u.email}: app=${a} db=${dbSaysYes(u)}`)
  }
  check(`app and database agree on ALL ${users.length} live users, row by row`,
    disagreements.length === 0)
  if (disagreements.length) for (const d of disagreements) console.log(`      ${d}`)

  // A population where NOBODY qualifies would make agreement trivial, and one
  // where EVERYBODY does would mean the gate is not gating.
  check("POSITIVE CONTROL — at least one live user may override, and at least one may not",
    appYes > 0 && appYes < users.length)
  // The ruling's own two seats, named, so a future roster change that quietly
  // flips either of them fails here rather than in production.
  const lead = (users as any[]).find((u) => u.user_type === "team_lead")
  check("the live team_lead seat may NOT override (the ruling, on a real row)",
    !lead || !appSaysYes(lead))
  const secondSeat = (users as any[]).find((u) =>
    u.user_type === "agent" && grants.some((g: any) =>
      g.user_id === u.id && g.brokerage_id === u.brokerage_id && isBrokerageFinanceAdminGrantRole(g.role)))
  check("the live GRANT-ONLY admin (the ruling's second seat) MAY override",
    !secondSeat || appSaysYes(secondSeat))
}

async function main() {
  console.log("═".repeat(78))
  console.log("SELLER-DECISION OVERRIDE AUTHORITY — the actor is resolved, never accepted")
  console.log("═".repeat(78))
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n" + "─".repeat(78))
  console.log(`${pass} passed, ${fail} failed`)
  if (fail) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
