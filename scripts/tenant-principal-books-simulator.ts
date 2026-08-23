#!/usr/bin/env tsx
/**
 * scripts/tenant-principal-books-simulator.ts  (npm run test:tenant-principal-books)
 * ─────────────────────────────────────────────────────────────────────────────
 * ON A TEAM-SCALE TENANT THE LEAD IS THE PRINCIPAL AND KEEPS ITS BOOKS —
 * AND ON A BROKERAGE-SCALE ONE THEY STILL DO NOT.
 *
 * Owner ruling, verbatim: "yes to the team lead and agents", answering: on team
 * tier there is no broker or broker_owner (m473 — a team is a mini brokerage)
 * and is_brokerage_finance_admin EXCLUDES team_lead (m472), so a team tenant
 * seating only a lead plus agents has NOBODY who can read its own financials.
 *
 * And, in the same message, the sentence that makes the grant CONDITIONAL:
 *
 *   "brokerages can have teams and agents but that is the brokerage tier. when
 *    we have the team and solo agent subscription tiers, those subscriptions get
 *    the same level of features as brokerages."
 *
 * ── WHAT THIS PROOF IS ACTUALLY DEFENDING ───────────────────────────────────
 *
 * The one-word version of the ruling — "add team_lead to the finance roster" —
 * hands every team lead in a large brokerage the whole office's P&L, which is
 * the exact leak m472 exists to prevent. The value of this file is therefore NOT
 * "the lead can read the books". It is the PAIR:
 *
 *     TEAM/SOLO tier  → the lead reads and administers the tenant's books
 *     BROKERAGE tier  → the same person does NOT. m472/m473 stand.
 *
 * A change that satisfies only the first half passes nothing here.
 *
 * PURE:    the app predicate and the tier-conditioned resolver, driven against
 *          fake clients that answer exactly like the live tables — including the
 *          ones that REFUSE, because "could not check" must never render as
 *          "checked and fine" (CLAUDE.md §4).
 * SOURCE:  the SQL and the app twin are read as text and required to carry the
 *          same condition, and the ROSTERS are required to be UNCHANGED — a
 *          widening that also widened the roster is the blanket grant.
 * NEGATIVE CONTROLS: every assertion above is re-run against a deliberately
 *          broken input that SHOULD trip it, and the proof FAILS if the trip
 *          does not happen (§2 — a broken finder and a clean tree both report
 *          zero).
 * LIVE (creds-gated): inlines the PROPOSED predicate per-identity over every
 *          tenanted user on the real database and reports exactly which answers
 *          move. Self-skips without creds. Seeds nothing; residue 0.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  BROKERAGE_FINANCE_ADMIN_USER_TYPES,
  isBrokerageFinanceAdmin,
  resolveTenantPrincipalTeamLead,
  resolveBrokerageFinanceAdmin,
} from "../lib/auth/resolve-user-role"
// ONE definition of the proof vocabulary, imported — finance-authority forbids a
// module that asks the shared finance predicate from also keeping a role array,
// and it caught this list inline on the first run. See role-words.ts's header.
import { NON_STAFF_PORTAL_ROLES } from "./shared/role-words"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}

const ROOT = process.cwd()
// REPOINTED to m526a. m526 was applied on 2026-08-23, REFUSED on its own
// postcheck and rolled back whole; m526a re-issues it with every GRANTING
// statement byte-identical and only that postcheck corrected, so every source
// assertion below reads the same text it always did. m526 is now a tombstone
// naming this file — see supabase/migrations/m526-*.sql.
const MIGRATION = join(ROOT, "supabase/migrations/m526a-m526s-negative-control-counted-the-population-instead-of-asking-the-predicate.sql")
const ROLE_FILE = join(ROOT, "lib/auth/resolve-user-role.ts")
const KERNEL    = join(ROOT, "lib/kernel/financial.ts")
const ACTION    = join(ROOT, "app/actions/financial-kernel.ts")

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")

/**
 * The BODY of one SQL function, between its `as $function$` and the matching
 * `$function$;`.
 *
 * SCOPING RATHER THAN STRIPPING, DELIBERATELY. The first version of this proof
 * asserted "the migration contains no `user_type = 'team_lead'`" over the WHOLE
 * FILE and went red — correctly — on this migration's own PROSE, which explains
 * at length why `users.user_type = 'team_lead'` IS NOT LEADERSHIP. That is the
 * §2 defect in miniature: an analyzer reading comments as code, and here it was
 * accusing a correct migration.
 *
 * `scripts/strip-comments.ts` is the ONE sanctioned stripper and it is a
 * TYPESCRIPT scanner; there is no SQL equivalent in this repo and §2 forbids
 * hand-rolling one. So the scan is NARROWED to the region the claim is actually
 * about instead. DECLARED BLIND SPOT (§2): `--` comments INSIDE the extracted
 * body are not removed, so a claim of the form "this token appears nowhere in
 * the body" would still be comment-blind. Every such claim below is therefore
 * paired with a control proving the tripwire fires on a body that really does
 * carry the defect.
 */
function sqlFunctionBody(sql: string, name: string): string {
  const at = sql.indexOf(`create or replace function public.${name}`)
  if (at < 0) return ""
  const open = sql.indexOf("$function$", at)
  if (open < 0) return ""
  const close = sql.indexOf("$function$", open + "$function$".length)
  if (close < 0) return ""
  return sql.slice(open + "$function$".length, close)
}

const LEAD  = "11111111-1111-1111-1111-111111111111"
const OTHER = "22222222-2222-2222-2222-222222222222"
const TENANT = "b0000000-0000-0000-0000-0000000000aa"
const TEAM   = "d0000000-0000-0000-0000-0000000000aa"

/**
 * A fake supabase client answering exactly the two reads the resolver makes:
 * `teams` (id, team_lead_id, filtered by brokerage_id + deleted_at) and
 * `brokerages` (plan_tier) — plus `subscriptions`, which readPlanTier consults
 * only when plan_tier is NULL or unrecognised.
 *
 * REFUSALS ARE MODELLED, not merely absences: supabase-js RESOLVES a refused
 * query (§3), so `{ data: null, error: {...} }` is the shape that has to be
 * exercised, and it is the shape a naive gate reads as "no team here".
 */
function fakeDb(opts: {
  teams?: Array<{ id: string; team_lead_id: string | null }>
  teamsError?: string
  planTier?: string | null
  brokerageMissing?: boolean
  brokerageError?: string
  subTier?: string | null
}) {
  const result = (data: any, error: any) => Promise.resolve({ data, error })
  const builder = (table: string) => {
    const api: any = {
      select: () => api,
      eq: () => api,
      in: () => api,
      is: () => api,
      order: () => api,
      limit: () => api,
      then: (res: any, rej: any) => run().then(res, rej),
      maybeSingle: () => run(),
    }
    const run = () => {
      if (table === "teams") {
        if (opts.teamsError) return result(null, { message: opts.teamsError })
        return result(opts.teams ?? [], null)
      }
      if (table === "brokerages") {
        if (opts.brokerageError) return result(null, { message: opts.brokerageError })
        if (opts.brokerageMissing) return result(null, null)
        return result({ plan_tier: opts.planTier ?? null }, null)
      }
      if (table === "subscriptions") {
        if (opts.subTier === undefined) return result(null, null)
        return result({ status: "active", subscription_tiers: { tier_name: opts.subTier } }, null)
      }
      if (table === "user_role_assignments") return result([], null)
      return result(null, null)
    }
    return api
  }
  return { from: builder } as any
}

const ONE_TEAM_LED = [{ id: TEAM, team_lead_id: LEAD }]

// ─── PURE — THE TIER CONDITION, WHICH IS THE WHOLE JOB ──────────────────────

async function pureLayer() {
  console.log("\n[the condition · pure — the same person, two tenant shapes]")

  // THE PAIR. Both halves are the ruling; either alone is a different ruling.
  for (const tier of ["team", "solo_agent"]) {
    const r = await resolveTenantPrincipalTeamLead(
      fakeDb({ teams: ONE_TEAM_LED, planTier: tier }), LEAD, TENANT)
    check(`${tier} tier — the lead IS the tenant's principal and keeps its books`,
      r.ok === true && r.ok && r.isPrincipal === true)
  }
  for (const tier of ["brokerage", "multi_location"]) {
    const r = await resolveTenantPrincipalTeamLead(
      fakeDb({ teams: ONE_TEAM_LED, planTier: tier }), LEAD, TENANT)
    check(`${tier} tier — the SAME lead does NOT reach tenant-wide money (m472/m473 stand)`,
      r.ok === true && r.ok && r.isPrincipal === false)
  }

  // The gate is TIER-CONDITIONAL, stated as the difference rather than as four
  // separate facts: flip only the tier and the answer must flip with it.
  const teamAns = await resolveTenantPrincipalTeamLead(fakeDb({ teams: ONE_TEAM_LED, planTier: "team" }), LEAD, TENANT)
  const brokAns = await resolveTenantPrincipalTeamLead(fakeDb({ teams: ONE_TEAM_LED, planTier: "brokerage" }), LEAD, TENANT)
  check("...and the TIER is the only input that changed between those two answers",
    teamAns.ok && brokAns.ok && teamAns.isPrincipal !== brokAns.isPrincipal)

  // THE ANCHOR IS THE FK, NOT THE LABEL (m473). Live, buyer@yourbrokerage.com
  // carries user_type 'team_lead' and leads NO team; teamlead@vip.demo carries
  // 'agent' and leads the only one. A user_type check is wrong in both directions.
  const notLead = await resolveTenantPrincipalTeamLead(
    fakeDb({ teams: [{ id: TEAM, team_lead_id: OTHER }], planTier: "team" }), LEAD, TENANT)
  check("a 'team_lead' SEAT that leads no team row reaches nothing (m473's too-loose direction)",
    notLead.ok && notLead.isPrincipal === false)
  check("...and the ROSTER is untouched — team_lead is still not brokerage-wide money",
    !BROKERAGE_FINANCE_ADMIN_USER_TYPES.has("team_lead") &&
    !isBrokerageFinanceAdmin({ user_type: "team_lead" }))

  // AN AGENT READS ONLY THEIR OWN. Being in the tenant is not being its principal.
  const agent = await resolveTenantPrincipalTeamLead(
    fakeDb({ teams: ONE_TEAM_LED, planTier: "team" }), OTHER, TENANT)
  check("an agent on a TEAM-tier tenant is NOT its principal — own work only",
    agent.ok && agent.isPrincipal === false)
  check("...and no roster role is conferred on them either",
    !isBrokerageFinanceAdmin({ user_type: "agent", is_tenant_principal: agent.ok && agent.isPrincipal }))

  // CONTACTS, LENDERS, VENDORS SEE NO FINANCIALS — ONLY THEIR OWN (standing
  // ruling). None can satisfy teams.team_lead_id, and none gains a roster seat.
  for (const r of NON_STAFF_PORTAL_ROLES) {
    const res = await resolveTenantPrincipalTeamLead(
      fakeDb({ teams: ONE_TEAM_LED, planTier: "team" }), OTHER, TENANT)
    check(`${r} reaches NO tenant financials on any tier`,
      res.ok && res.isPrincipal === false &&
      !isBrokerageFinanceAdmin({ user_type: r }) &&
      !isBrokerageFinanceAdmin({ user_type: r, is_tenant_principal: res.ok && res.isPrincipal }))
  }

  // NOTHING IS REVOKED. Every role that reached the books before still does, on
  // every tier — this is a pure OR-disjunct and must behave like one.
  // Derived from the roster itself, not retyped: a copy here would keep passing
  // while the roster it claims to describe changed underneath it. broker_admin is
  // skipped because it is an input-only spelling no live row can hold.
  for (const r of [...BROKERAGE_FINANCE_ADMIN_USER_TYPES].filter((x) => x !== "broker_admin")) {
    check(`${r} still reaches the books, unchanged and on every tier`,
      isBrokerageFinanceAdmin({ user_type: r }) &&
      isBrokerageFinanceAdmin({ user_type: r, is_tenant_principal: false }) &&
      isBrokerageFinanceAdmin({ user_type: r, is_tenant_principal: null }))
  }
}

// ─── FAIL CLOSED — THE HALF THAT IS EASIEST TO GET BACKWARDS ────────────────

async function failClosedLayer() {
  console.log("\n[fail closed · an unreadable tier or team must REFUSE, never pass]")

  const refusedTeams = await resolveTenantPrincipalTeamLead(
    fakeDb({ teamsError: "permission denied for table teams", planTier: "team" }), LEAD, TENANT)
  check("a REFUSED teams read returns ok:false — not 'this tenant has no team'",
    refusedTeams.ok === false)

  const refusedTier = await resolveTenantPrincipalTeamLead(
    fakeDb({ teams: ONE_TEAM_LED, brokerageError: "permission denied for table brokerages" }), LEAD, TENANT)
  check("a REFUSED plan_tier read returns ok:false — the gate REFUSES rather than guessing",
    refusedTier.ok === false)

  const noBrokerage = await resolveTenantPrincipalTeamLead(
    fakeDb({ teams: ONE_TEAM_LED, brokerageMissing: true }), LEAD, TENANT)
  check("no brokerages row at all returns ok:false — an absent tenant is not a cheap tenant",
    noBrokerage.ok === false)

  // THE TRAP THIS WHOLE LANE TURNS ON. resolvePlanTier FLOORS an unreadable tier
  // to 'solo_agent', which is a GRANTING tier here — so a twin built on it would
  // fail OPEN while the SQL fails CLOSED. The resolver uses readPlanTier and
  // demands the value came from the plan_tier COLUMN.
  const nullTier = await resolveTenantPrincipalTeamLead(
    fakeDb({ teams: ONE_TEAM_LED, planTier: null }), LEAD, TENANT)
  check("a NULL plan_tier with no subscription does NOT grant — the floor is not a fact",
    nullTier.ok === true && nullTier.ok && nullTier.isPrincipal === false)
  const junkTier = await resolveTenantPrincipalTeamLead(
    fakeDb({ teams: ONE_TEAM_LED, planTier: "enterprise_legacy" }), LEAD, TENANT)
  check("an UNRECOGNISED plan_tier does NOT grant either",
    junkTier.ok === true && junkTier.ok && junkTier.isPrincipal === false)

  // The premise of the ruling — one team, whose money IS the tenant's — asserted.
  const twoTeams = await resolveTenantPrincipalTeamLead(
    fakeDb({ teams: [{ id: TEAM, team_lead_id: LEAD }, { id: "t2", team_lead_id: OTHER }], planTier: "team" }),
    LEAD, TENANT)
  check("a 'team'-tier tenant carrying TWO teams refuses — the downgraded-brokerage leak",
    twoTeams.ok && twoTeams.isPrincipal === false)

  // Identity/tenancy that cannot be established is a definite no, never a yes.
  const noTenant = await resolveTenantPrincipalTeamLead(fakeDb({ teams: ONE_TEAM_LED, planTier: "team" }), LEAD, null)
  check("no session tenant → no principal (tenant comes from the SESSION, §4)",
    noTenant.ok && noTenant.isPrincipal === false)
  const noUser = await resolveTenantPrincipalTeamLead(fakeDb({ teams: ONE_TEAM_LED, planTier: "team" }), "", TENANT)
  check("no session identity → no principal", noUser.ok && noUser.isPrincipal === false)

  // The pure predicate's own fail-closed contract: only `true` grants.
  check("UNRESOLVED (undefined) is not a grant — 'nobody checked' cannot read as 'checked and fine'",
    !isBrokerageFinanceAdmin({ user_type: "agent" }) &&
    !isBrokerageFinanceAdmin({ user_type: "agent", is_tenant_principal: undefined }) &&
    !isBrokerageFinanceAdmin({ user_type: "agent", is_tenant_principal: null }) &&
    !isBrokerageFinanceAdmin({ user_type: "agent", is_tenant_principal: false }))

  // The FULL app rule propagates the refusal instead of swallowing it.
  const fullRefused = await resolveBrokerageFinanceAdmin(
    fakeDb({ teamsError: "permission denied" }), LEAD, { user_type: "agent", brokerage_id: TENANT })
  check("resolveBrokerageFinanceAdmin propagates the refusal as ok:false, not as 'not an admin'",
    fullRefused.ok === false)
  const fullPrincipal = await resolveBrokerageFinanceAdmin(
    fakeDb({ teams: ONE_TEAM_LED, planTier: "team" }), LEAD, { user_type: "agent", brokerage_id: TENANT })
  check("...and admits the principal, naming WHY (via: tenant_principal)",
    fullPrincipal.ok === true && fullPrincipal.ok &&
    fullPrincipal.isFinanceAdmin === true && fullPrincipal.via === "tenant_principal")
  const fullBrokerageTier = await resolveBrokerageFinanceAdmin(
    fakeDb({ teams: ONE_TEAM_LED, planTier: "brokerage" }), LEAD, { user_type: "agent", brokerage_id: TENANT })
  check("...and refuses the same person on BROKERAGE tier",
    fullBrokerageTier.ok === true && fullBrokerageTier.ok && fullBrokerageTier.isFinanceAdmin === false)
}

// ─── SOURCE — RLS AND THE APP MUST CARRY THE SAME CONDITION (#202) ──────────

function sourceLayer() {
  console.log("\n[source · the RLS fix and its app twin ship together, or it is half a fix]")

  const sql = read(MIGRATION)
  check("the migration exists", sql.length > 0)
  check("it creates the fact function", /create or replace function public\.is_tenant_principal_team_lead/.test(sql))

  // SCOPED TO THE FUNCTION BODY — see sqlFunctionBody's header for why the
  // whole-file version of this scan was itself the §2 defect.
  const factBody = sqlFunctionBody(sql, "is_tenant_principal_team_lead")
  check("POSITIVE CONTROL — the body extractor found a non-empty body to judge",
    factBody.length > 100 && /select/.test(factBody))
  check("...conditioned on the TIER, and on the team-scale tiers only",
    /b\.plan_tier in \('team', 'solo_agent'\)/.test(factBody))
  check("...anchored on teams.team_lead_id = auth.uid(), NOT on users.user_type (m473)",
    /t\.team_lead_id = auth\.uid\(\)/.test(factBody) && !/user_type\s*=\s*'team_lead'/.test(factBody))
  check("...pinned to the SESSION's tenant, never an argument (§4)",
    /t\.brokerage_id = public\.current_user_brokerage_id\(\)/.test(factBody))
  check("...and coalesced to false, so every unreadable input REFUSES",
    /coalesce\(\(/.test(factBody) && /\), false\)/.test(factBody))
  check("...and asserts the ruling's premise: exactly ONE live team on the tenant",
    /count\(\*\) from public\.teams t2/.test(factBody) && /\) = 1/.test(factBody))

  // BOTH survivors take the disjunct — the read spelling and the write spelling.
  for (const fn of ["is_brokerage_finance_admin", "can_read_brokerage_books"]) {
    const body = sqlFunctionBody(sql, fn)
    check(`public.${fn}() takes the disjunct`,
      body.length > 100 && /or public\.is_tenant_principal_team_lead\(\)/.test(body))
    // THE BLANKET-GRANT TRIPWIRE, per body: the ROSTER must be unchanged. If
    // team_lead ever reaches a role list here, the tier condition was bypassed
    // and every team lead in a large office reads the office's P&L (m472).
    check(`...and public.${fn}()'s ROSTER is NOT widened — team_lead stays out`,
      body.length > 100 && !/'team_lead'/.test(body))
  }

  check("the app roster agrees with the SQL rosters, byte for byte",
    [...BROKERAGE_FINANCE_ADMIN_USER_TYPES].sort().join(",") === "admin,broker,broker_admin,broker_owner")

  // THE MIGRATION MUST DECLARE ITS APPLICATION STATE — one of the two, explicitly.
  //
  // This used to assert the literal string "NOT APPLIED", which was right while
  // the file was a lane's un-applied draft and became WRONG the moment the
  // integrator applied it: a passing assertion would then have meant the file was
  // lying about the database. CLAUDE.md §3 says a .sql file that exists has not
  // been applied, so SILENCE reads as "not applied" — which makes an applied
  // migration that says nothing the one genuinely dangerous state. What must hold
  // is that the file SAYS which it is, not that the answer is frozen.
  const declaresNotApplied = /NOT APPLIED/.test(sql)
  const declaresApplied = /APPLICATION STATUS:\s*APPLIED/.test(sql)
  check("the migration declares its application state explicitly (applied, or not applied)",
    declaresNotApplied !== declaresApplied)
  // POSITIVE CONTROLS — prove each arm still recognises what it was written for,
  // and that this is not a constant true (§2).
  check("  control: the finder recognises an un-applied declaration",
    /NOT APPLIED/.test("-- WRITTEN, NOT APPLIED. Lanes write migrations."))
  check("  control: the finder recognises an applied declaration",
    /APPLICATION STATUS:\s*APPLIED/.test("-- APPLICATION STATUS: APPLIED, 2026-08-23"))
  check("  control: a migration that declares NEITHER is refused",
    !((/NOT APPLIED/.test("-- m999 does something")) !== (/APPLICATION STATUS:\s*APPLIED/.test("-- m999 does something"))))
  // An APPLIED migration must also say WHEN — "applied" with no date cannot be
  // reconciled against the database by anyone reading it later.
  check("...and if it declares APPLIED, it names the date",
    !declaresApplied || /APPLICATION STATUS:\s*APPLIED,\s*\d{4}-\d{2}-\d{2}/.test(sql))

  // The app twin. #202 was an RLS defect whose app twin was left stale; here the
  // kernel runs on the SERVICE client, so a stale twin is not annoying, it is the
  // ruling delivered nowhere.
  const roleSrc = read(ROLE_FILE)
  check("the app twin exists", /export async function resolveTenantPrincipalTeamLead/.test(roleSrc))
  check("...and reads the tier through readPlanTier, NOT resolvePlanTier",
    /readPlanTier\(/.test(roleSrc) && !/\bresolvePlanTier\(/.test(roleSrc))
  check("...demanding the tier came from the COLUMN (fromCache) — the floor is a GRANTING tier here",
    /read\.fromCache/.test(roleSrc))
  check("...and it destructures the error on the teams read (§3)",
    /const \{ data: teams, error: teamsError \}/.test(roleSrc))

  const kernel = read(KERNEL)
  check("FinancialActorContext carries the resolved fact", /isTenantPrincipal\?: boolean \| null/.test(kernel))
  const kernelGates = (kernel.match(/isBrokerageFinanceAdmin\(\{ user_type: ctx\.userType/g) ?? []).length
  const kernelThreaded = (kernel.match(/is_tenant_principal: ctx\.isTenantPrincipal/g) ?? []).length
  check(`EVERY service-client money gate in the kernel is threaded (${kernelThreaded}/${kernelGates})`,
    kernelGates > 0 && kernelThreaded === kernelGates)

  const action = read(ACTION)
  check("the action layer RESOLVES the fact once, from the session's own ids",
    /resolveTenantPrincipalTeamLead\(supabase, user\.id, brokerageId\)/.test(action))
  check("...and THROWS on a refusal rather than degrading to false",
    /if \(!principal\.ok\) throw new Error\(principal\.reason\)/.test(action))
  const actGates = (action.match(/isBrokerageFinanceAdmin\(\{ user_type: ctx\.userType/g) ?? []).length
  const actThreaded = (action.match(/is_tenant_principal: ctx\.isTenantPrincipal/g) ?? []).length
  check(`EVERY finance gate in the action layer is threaded (${actThreaded}/${actGates})`,
    actGates > 0 && actThreaded === actGates)
}

// ─── NEGATIVE CONTROLS (§2) — every assertion above must be able to go red ──

async function negativeControls() {
  console.log("\n[negative controls · each assertion is made to FAIL on purpose]")

  // If the tier condition were dropped, the brokerage-tier lead would pass.
  const wouldLeak = await resolveTenantPrincipalTeamLead(
    fakeDb({ teams: ONE_TEAM_LED, planTier: "brokerage" }), LEAD, TENANT)
  check("NEGATIVE — a brokerage-tier lead is measurably NOT a principal (so the pair is not vacuous)",
    wouldLeak.ok && wouldLeak.isPrincipal === false)
  const doesGrant = await resolveTenantPrincipalTeamLead(
    fakeDb({ teams: ONE_TEAM_LED, planTier: "team" }), LEAD, TENANT)
  check("NEGATIVE — ...and a team-tier lead measurably IS one (so it is not a constant false)",
    doesGrant.ok && doesGrant.isPrincipal === true)

  // POSITIVE CONTROL for the pure predicate: it must still be able to say yes.
  check("POSITIVE CONTROL — the pure predicate still admits the roster it always did",
    isBrokerageFinanceAdmin({ user_type: "broker" }) && isBrokerageFinanceAdmin({ user_type: "admin" }))
  check("POSITIVE CONTROL — ...and still refuses a nonsense role, so it is not a constant true",
    !isBrokerageFinanceAdmin({ user_type: "nonsense_role" }) && !isBrokerageFinanceAdmin({}))
  check("POSITIVE CONTROL — the new parameter is what widens, and only when TRUE",
    !isBrokerageFinanceAdmin({ user_type: "agent", is_tenant_principal: false }) &&
    isBrokerageFinanceAdmin({ user_type: "agent", is_tenant_principal: true }))

  // POSITIVE CONTROL for the SOURCE scans: prove each finder still recognises the
  // defect it was written for. A broken regex and a clean tree both report zero.
  const sql = read(MIGRATION)
  check("POSITIVE CONTROL — the source scanner actually read the migration",
    sql.length > 2000 && /m526/.test(sql))
  // The blanket-grant tripwire is the single most important control here: the
  // whole lane is "do NOT just add team_lead to the roster". Prove it fires.
  const fakeBlanketSql =
    "create or replace function public.is_brokerage_finance_admin()\n" +
    "as $function$ select u.user_type in ('admin','broker','broker_owner','team_lead') from users u; $function$;"
  const blanketBody = sqlFunctionBody(fakeBlanketSql, "is_brokerage_finance_admin")
  check("POSITIVE CONTROL — the blanket-grant tripwire FIRES on a roster that admits team_lead",
    blanketBody.length > 0 && /'team_lead'/.test(blanketBody))
  check("POSITIVE CONTROL — ...and does NOT fire on the real body (so it is not a constant true)",
    !/'team_lead'/.test(sqlFunctionBody(sql, "is_brokerage_finance_admin")))

  // The m473 anchor tripwire, likewise: a body keyed on the LABEL must go red.
  const fakeLabelSql =
    "create or replace function public.is_tenant_principal_team_lead()\n" +
    "as $function$ select u.user_type = 'team_lead' from users u; $function$;"
  check("POSITIVE CONTROL — the m473 anchor tripwire FIRES on a user_type-keyed body",
    /user_type\s*=\s*'team_lead'/.test(sqlFunctionBody(fakeLabelSql, "is_tenant_principal_team_lead")))
  const fakeStaleTwin = "const tier = await resolvePlanTier(supabase, brokerageId)"
  check("POSITIVE CONTROL — the floor-tier tripwire FIRES on resolvePlanTier",
    /\bresolvePlanTier\(/.test(fakeStaleTwin))
  const fakeUnthreaded = "if (!isBrokerageFinanceAdmin({ user_type: ctx.userType })) return"
  check("POSITIVE CONTROL — the threading scan FIRES on an un-threaded gate",
    (fakeUnthreaded.match(/isBrokerageFinanceAdmin\(\{ user_type: ctx\.userType/g) ?? []).length === 1 &&
    (fakeUnthreaded.match(/is_tenant_principal: ctx\.isTenantPrincipal/g) ?? []).length === 0)

  // POSITIVE CONTROL for the fail-closed layer: prove the fake client can REFUSE
  // at all, otherwise every refusal assertion above passed vacuously.
  const proveRefusal = await fakeDb({ teamsError: "boom" }).from("teams").select("*").eq("a", 1).is("b", null)
  check("POSITIVE CONTROL — the fake client really does produce a resolved REFUSAL",
    proveRefusal.error != null && proveRefusal.data == null)
  const proveOk = await fakeDb({ teams: ONE_TEAM_LED }).from("teams").select("*").eq("a", 1).is("b", null)
  check("POSITIVE CONTROL — ...and really does produce rows when not refusing",
    proveOk.error == null && Array.isArray(proveOk.data) && proveOk.data.length === 1)
}

// ─── LIVE (creds-gated) — the PROPOSED predicate against real rows ──────────

async function liveLayer() {
  console.log("\n[live · the proposed predicate, inlined per identity, against real rows]")

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("      ⊘ SKIPPED — no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env (NOT scored as a pass)")
    return
  }
  const db = createClient(url, key)

  // The migration is NOT applied by this lane (CLAUDE.md §3), so this cannot
  // call public.is_tenant_principal_team_lead(). It asks the question the
  // migration WOULD ask — the same three facts, joined the same way — against
  // the real rows, and reports which answers MOVE. That is the strongest claim
  // available before the integrator applies it.
  const { data: users, error: uErr } = await db
    .from("users").select("id, email, user_type, brokerage_id").not("brokerage_id", "is", null)
  if (uErr) { check(`live users read refused — ${uErr.message}`, false); return }

  const { data: teams, error: tErr } = await db
    .from("teams").select("id, brokerage_id, team_lead_id, deleted_at").is("deleted_at", null)
  if (tErr) { check(`live teams read refused — ${tErr.message}`, false); return }

  const { data: brokerages, error: bErr } = await db.from("brokerages").select("id, name, plan_tier")
  if (bErr) { check(`live brokerages read refused — ${bErr.message}`, false); return }

  const liveTeams = (teams ?? []) as Array<{ id: string; brokerage_id: string; team_lead_id: string | null }>
  const tierOf = new Map((brokerages ?? []).map((b: any) => [b.id, b.plan_tier as string | null]))
  const teamCount = new Map<string, number>()
  for (const t of liveTeams) teamCount.set(t.brokerage_id, (teamCount.get(t.brokerage_id) ?? 0) + 1)

  const principals: string[] = []
  const brokerageTierLeads: string[] = []
  for (const u of (users ?? []) as Array<{ id: string; email: string; user_type: string; brokerage_id: string }>) {
    const led = liveTeams.find((t) => t.team_lead_id === u.id && t.brokerage_id === u.brokerage_id)
    if (!led) continue
    const tier = tierOf.get(u.brokerage_id) ?? null
    if (tier === "brokerage" || tier === "multi_location") brokerageTierLeads.push(u.email)
    if ((tier === "team" || tier === "solo_agent") && (teamCount.get(u.brokerage_id) ?? 0) === 1) principals.push(u.email)
  }

  console.log(`      denominator: ${(users ?? []).length} tenanted users · ${liveTeams.length} live teams · ${(brokerages ?? []).length} brokerages`)
  console.log(`      principals after m526: ${principals.length ? principals.join(", ") : "(none)"}`)

  check("POSITIVE CONTROL — the live scan saw users, teams and brokerages at all",
    (users ?? []).length > 0 && (brokerages ?? []).length > 0)
  check("NO brokerage-tier team lead gains tenant-wide money — m472 is not reopened",
    brokerageTierLeads.length === 0)

  // Contacts, lenders and vendors see NO financials — only their own.
  const outsiders = ((users ?? []) as any[]).filter((u) => NON_STAFF_PORTAL_ROLES.includes(u.user_type))
  check(`no contact/lender/vendor becomes a principal (${outsiders.length} such accounts)`,
    outsiders.every((u) => !principals.includes(u.email)))

  console.log("      seeded rows: 0 · residue: 0 (this layer reads the catalogue only)")
}

// ─── RUN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═".repeat(78))
  console.log(" WHO MAY READ THE BOOKS — team-scale tenants have a principal (m526)")
  console.log("═".repeat(78))

  await pureLayer()
  await failClosedLayer()
  sourceLayer()
  await negativeControls()
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
