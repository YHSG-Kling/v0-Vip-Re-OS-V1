#!/usr/bin/env tsx
/**
 * scripts/expense-export-scope-simulator.ts   (npm run test:expense-export-scope)
 * ─────────────────────────────────────────────────────────────────────────────
 * WHO MAY EXPORT WHOSE EXPENSES.
 *
 * Owner ruling, verbatim:
 *
 *   "user should only be able to export their own expenses. brokerages' admins
 *    and owner can export their brokerages' expenses."
 *
 * ── THE DEFECT THIS PROOF EXISTS TO PREVENT ─────────────────────────────────
 *
 * app/actions/financials.ts#exportExpensesCSV checked only that SOMEBODY was
 * signed in, then scoped every row it returned from the caller-supplied
 * `agentId` PARAMETER. It is a "use server" export called from CLIENT components
 * (app/components/features/financial/ExportCSVButton.tsx,
 * app/dashboard/financials/reports/reports-client.tsx), so that parameter crosses
 * the network and is caller-controlled whatever the page passes. Any signed-in
 * user could name any agent id and receive that agent's expense ledger for the
 * year — dates, categories, descriptions, amounts, and receipt links.
 *
 * The fix merged it onto the gate its sibling exportCommissionsCSV already had,
 * rather than inventing a second one (CLAUDE.md §1, §6). This proof is what keeps
 * the two from drifting apart again, and what keeps either from quietly losing a
 * clause.
 *
 * ── HOW THIS PROOF IS BUILT ─────────────────────────────────────────────────
 *
 * PURE:   the roster. The claim is not "these three roles" — it is that the gate
 *         asks BROKERAGE_FINANCE_ADMIN_USER_TYPES, which is the tenant roster
 *         MINUS team_lead, and that this is what the ruling's "admins and owner"
 *         means. Derived from the live sets, never retyped.
 * DECISION: the gate re-expressed as a pure function and driven through every
 *         caller shape the ruling names (own / admin-same-tenant /
 *         admin-other-tenant / non-admin / unknown agent / refused lookup).
 * SOURCE: a structural audit of the two export actions in the tree, asking
 *         whether each gate CLAUSE is present as CODE. Keyed to the shape of the
 *         gate, never to a comment, a string, or a line number.
 * POSITIVE CONTROLS: the source audit is re-run against synthetic bodies that
 *         SHOULD trip it — including the REAL historical ungated body this
 *         defect was found in. An absence assertion that cannot be made to fail
 *         is not evidence (CLAUDE.md §2); a broken finder and a clean tree both
 *         report zero.
 * LIVE (creds-gated): the NULL-tenant census on business_expenses and whether
 *         m516 has been applied. Self-skips without SUPABASE creds. Seeds
 *         nothing, so residue is 0 by construction.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  TENANT_ADMIN_USER_TYPES,
  BROKERAGE_FINANCE_ADMIN_USER_TYPES,
  isAdminOrBroker,
  isBrokerageFinanceAdmin,
} from "../lib/auth/resolve-user-role"
import { blankComments, blankStrings } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}

const ROOT = process.cwd()
const FINANCIALS = join(ROOT, "app", "actions", "financials.ts")

/** The role the ruling holds out of the books. */
const THE_ROLE_HELD_OUT = "team_lead"

/** The two exported actions that hand a whole ledger to a caller as a file. */
const EXPORT_ACTIONS = ["exportExpensesCSV", "exportCommissionsCSV"] as const

// ─── PURE · THE ROSTER ───────────────────────────────────────────────────────

function rosterLayer() {
  console.log("\n[the roster · pure — \"brokerages' admins and owner\", derived not retyped]")

  check("the export roster is the tenant roster MINUS exactly team_lead",
    [...TENANT_ADMIN_USER_TYPES].filter((r) => !BROKERAGE_FINANCE_ADMIN_USER_TYPES.has(r))
      .join(",") === THE_ROLE_HELD_OUT)
  check("...and adds nothing the tenant roster lacks, so it is a STRICT subset",
    [...BROKERAGE_FINANCE_ADMIN_USER_TYPES].every((r) => TENANT_ADMIN_USER_TYPES.has(r)))

  for (const r of ["admin", "broker", "broker_owner"]) {
    check(`${r} may export their brokerage's expenses — the ruling's "admins and owner"`,
      isBrokerageFinanceAdmin({ user_type: r }))
  }
  check("team_lead may NOT export another agent's expenses (the ruling names admins and owner only)",
    !isBrokerageFinanceAdmin({ user_type: THE_ROLE_HELD_OUT }))
  check("...even though team_lead IS a tenant admin elsewhere — the two tiers are different questions",
    isAdminOrBroker({ user_type: THE_ROLE_HELD_OUT }))

  for (const r of ["agent", "isa", "tc", "vendor", "lender", "contact"]) {
    check(`${r} may export nobody else's expenses`, !isBrokerageFinanceAdmin({ user_type: r }))
  }

  // `broker_admin` is an INPUT spelling only: users_user_type_check admits
  // fourteen values and that is not one of them (MEASURED live, and the
  // constraint is VALIDATED), so it matches no row. It must never be compared
  // against a live row as a bare string — the roster is asked instead.
  check("broker_admin is honoured as an input spelling, so a legacy caller is not silently refused",
    isBrokerageFinanceAdmin({ user_type: "broker_admin" }))

  // A predicate that throws on a missing value fails OPEN at the call site that
  // forgot a try/catch.
  check("absent / null / unknown user types answer FALSE, and never throw",
    !isBrokerageFinanceAdmin({}) && !isBrokerageFinanceAdmin({ user_type: null }) &&
    !isBrokerageFinanceAdmin({ user_type: undefined }) && !isBrokerageFinanceAdmin({ user_type: "" }) &&
    !isBrokerageFinanceAdmin({ user_type: "nonsense_role" }))
}

// ─── DECISION · THE GATE AS A PURE FUNCTION ──────────────────────────────────

type Ctx = { isAuthenticated: boolean; brokerageId: string | null; agentId: string | null; userType: string }
type Lookup = { brokerageId: string | null } | null
type Verdict = "allow" | "Unauthorized" | "Forbidden"

/**
 * The gate the two export actions implement, expressed once so its BEHAVIOUR can
 * be driven through every caller shape the ruling names.
 *
 * This is a restatement, and a restatement can drift from the code it describes —
 * which is exactly why the SOURCE layer below audits the real bodies structurally
 * instead of trusting this. The two layers answer different questions: this one
 * asks "is the rule right?", that one asks "is the rule what ships?".
 */
function gate(ctx: Ctx, agentId: string, lookup: Lookup, lookupRefused: boolean): Verdict {
  if (!ctx.isAuthenticated || !ctx.brokerageId) return "Unauthorized"
  if (agentId !== ctx.agentId) {
    if (!isBrokerageFinanceAdmin({ user_type: ctx.userType })) return "Forbidden"
    // supabase-js RESOLVES refusals — a swallowed error would leave `lookup` null
    // and read as "no such agent". FAIL CLOSED.
    if (lookupRefused) return "Forbidden"
    if (!lookup || lookup.brokerageId !== ctx.brokerageId) return "Forbidden"
  }
  return "allow"
}

const OWN = "brokerage-own", OTHER = "brokerage-other"
const ME = "agent-me", PEER = "agent-peer", FOREIGN = "agent-foreign"
const ctxOf = (userType: string, agentId: string | null = ME): Ctx =>
  ({ isAuthenticated: true, brokerageId: OWN, agentId, userType })
const inOwn: Lookup = { brokerageId: OWN }
const inOther: Lookup = { brokerageId: OTHER }

function decisionLayer() {
  console.log("\n[the gate · decision — the ruling, one caller shape at a time]")

  // "user should only be able to export their own expenses"
  check("an agent exporting their OWN expenses is allowed",
    gate(ctxOf("agent"), ME, inOwn, false) === "allow")
  check("...and so is every other role exporting their own — own is never gated on rank",
    ["broker", "broker_owner", "admin", THE_ROLE_HELD_OUT, "isa", "tc"]
      .every((r) => gate(ctxOf(r), ME, inOwn, false) === "allow"))
  check("an agent naming a COLLEAGUE in their own brokerage is REFUSED",
    gate(ctxOf("agent"), PEER, inOwn, false) === "Forbidden")
  check("...and naming an agent in ANOTHER brokerage is refused identically",
    gate(ctxOf("agent"), FOREIGN, inOther, false) === "Forbidden")

  // "brokerages' admins and owner can export their brokerages' expenses"
  for (const r of ["admin", "broker", "broker_owner"]) {
    check(`${r} may export a colleague in their OWN brokerage`,
      gate(ctxOf(r), PEER, inOwn, false) === "allow")
    check(`...but ${r} may NOT reach into ANOTHER brokerage`,
      gate(ctxOf(r), FOREIGN, inOther, false) === "Forbidden")
  }
  check("a team_lead may not export a colleague's expenses, in their own brokerage or any other",
    gate(ctxOf(THE_ROLE_HELD_OUT), PEER, inOwn, false) === "Forbidden" &&
    gate(ctxOf(THE_ROLE_HELD_OUT), FOREIGN, inOther, false) === "Forbidden")

  // THE ID ORACLE. Three different failures must be indistinguishable to the
  // caller, or the refusal itself becomes an enumeration primitive: a caller
  // learns which agent uuids exist without ever being allowed to read a row.
  const notAdmin = gate(ctxOf("agent"), PEER, inOwn, false)
  const noSuchAgent = gate(ctxOf("broker"), "does-not-exist", null, false)
  const otherTenant = gate(ctxOf("broker"), FOREIGN, inOther, false)
  const refused = gate(ctxOf("broker"), PEER, null, true)
  check("no-such-agent and wrong-tenant and not-an-admin all refuse with the IDENTICAL string",
    new Set([notAdmin, noSuchAgent, otherTenant]).size === 1 && notAdmin === "Forbidden")
  check("...and a REFUSED tenant lookup refuses too — fail closed, never 'nobody checked' as 'fine'",
    refused === "Forbidden")

  // Identity that cannot be established is not a pass.
  check("an unauthenticated caller is refused before any row is named",
    gate({ isAuthenticated: false, brokerageId: OWN, agentId: ME, userType: "broker" }, ME, inOwn, false) === "Unauthorized")
  check("...and so is a session with no brokerage — an untenanted admin administers nothing",
    gate({ isAuthenticated: true, brokerageId: null, agentId: ME, userType: "broker" }, ME, inOwn, false) === "Unauthorized")

  // A caller with no agent record must not become "everybody's own".
  check("a session with a NULL agentId cannot match an agentId parameter and fall through as 'own'",
    gate(ctxOf("agent", null), PEER, inOwn, false) === "Forbidden" &&
    gate(ctxOf("agent", null), "null", inOwn, false) === "Forbidden")
}

// ─── SOURCE · IS THE RULE WHAT SHIPS? ────────────────────────────────────────

/**
 * The body of `export async function NAME(...)`, as CODE.
 *
 * Two views of the same span, both from scripts/strip-comments.ts (finding #250 —
 * never hand-roll a stripper), and both offset-preserving so the spans agree:
 *   · `masked`  = blankStrings(src): comments AND string CONTENTS blanked. Brace
 *                 matching runs here, so a `{` inside a string or a comment cannot
 *                 desynchronise the scan and swallow the rest of the file.
 *   · `code`    = blankComments(src): comments blanked, strings INTACT. The clause
 *                 checks run here, because `.eq("brokerage_id", …)` IS a string
 *                 literal — the quotes are the signal, not the noise.
 */
function functionViews(src: string, name: string): { code: string; masked: string } | null {
  const masked = blankStrings(src)
  const code = blankComments(src)
  const sig = `export async function ${name}(`
  const at = masked.indexOf(sig)
  if (at === -1) return null
  const open = masked.indexOf("{", at)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++
    else if (masked[i] === "}") {
      depth--
      if (depth === 0) return { code: code.slice(open, i + 1), masked: masked.slice(open, i + 1) }
    }
  }
  return null
}

/** The `if (agentId !== ctx.agentId) { … }` branch — where the refusals live. */
function ownershipBranch(v: { code: string; masked: string }): string | null {
  const m = /if\s*\(\s*agentId\s*!==\s*ctx\.agentId\s*\)\s*\{/.exec(v.masked)
  if (!m) return null
  const open = v.masked.indexOf("{", m.index)
  let depth = 0
  for (let i = open; i < v.masked.length; i++) {
    if (v.masked[i] === "{") depth++
    else if (v.masked[i] === "}") {
      depth--
      if (depth === 0) return v.code.slice(open, i + 1)
    }
  }
  return null
}

/** Every gate clause the ruling requires, asked of one function body. */
type Clauses = {
  resolvesSessionIdentity: boolean
  refusesUnauthenticated: boolean
  comparesCallerToTarget: boolean
  asksFinanceRoster: boolean
  verifiesTargetTenant: boolean
  readsLookupError: boolean
  pinsTenantOnQuery: boolean
  oneRefusalString: boolean
}

function auditGate(src: string, name: string): Clauses | null {
  const v = functionViews(src, name)
  if (!v) return null
  const { code, masked } = v
  const branch = ownershipBranch(v)

  // Distinct refusal literals inside the ownership branch. More than one is an
  // ID ORACLE. Read off `code` (strings intact) but only inside a branch whose
  // extent was measured on `masked`, so prose cannot contribute a literal.
  const refusals = new Set<string>()
  if (branch) for (const m of branch.matchAll(/error:\s*"([^"]*)"/g)) refusals.add(m[1])

  return {
    // Identity from the SESSION, never the parameter (CLAUDE.md §4).
    resolvesSessionIdentity: /getAgentContext\s*\(/.test(masked),
    refusesUnauthenticated: /!\s*ctx\.isAuthenticated/.test(masked) && /!\s*ctx\.brokerageId/.test(masked),
    comparesCallerToTarget: /agentId\s*!==\s*ctx\.agentId/.test(masked),
    // The ONE shared roster, not a local literal.
    asksFinanceRoster: branch !== null && /\b(isFinanceAdmin|isBrokerageFinanceAdmin)\s*\(/.test(branch),
    verifiesTargetTenant: branch !== null && /brokerage_id\s*!==\s*ctx\.brokerageId/.test(branch),
    // supabase-js RESOLVES refusals — the error must be destructured AND acted on.
    readsLookupError: branch !== null &&
      /\{\s*data:\s*\w+\s*,\s*error:\s*(\w+)\s*\}\s*=\s*await/.test(branch) &&
      /if\s*\(\s*\w*[eE]rror\w*\s*\)/.test(branch),
    // The tenant pinned on the row query itself, not only in the gate.
    pinsTenantOnQuery: /\.eq\(\s*"brokerage_id"\s*,\s*ctx\.brokerageId\s*\)/.test(code),
    oneRefusalString: branch !== null && refusals.size === 1,
  }
}

const allClauses = (c: Clauses) => Object.values(c).every(Boolean)
const missing = (c: Clauses) => Object.entries(c).filter(([, v]) => !v).map(([k]) => k)

function sourceLayer() {
  console.log("\n[the tree · source — the gate that ships, clause by clause]")

  const src = readFileSync(FINANCIALS, "utf8")

  // DENOMINATOR (CLAUDE.md §2 — a count without its denominator is not a
  // measurement). Every exported server action in the file, and how many of them
  // take a caller-supplied agent id at all.
  const masked = blankStrings(src)
  const exported = [...masked.matchAll(/export\s+async\s+function\s+(\w+)\s*\(/g)].map((m) => m[1])
  const takesAgentId = exported.filter((n) => {
    const m = new RegExp(`export\\s+async\\s+function\\s+${n}\\s*\\(([^)]*)`).exec(masked)
    return !!m && /\bagentId\b/.test(m[1])
  })
  console.log(`      denominator: ${exported.length} exported server actions in app/actions/financials.ts`)
  console.log(`      of which ${takesAgentId.length} take an agentId parameter: ${takesAgentId.join(", ")}`)
  console.log(`      audited here: ${EXPORT_ACTIONS.length} — ${EXPORT_ACTIONS.join(", ")}`)
  console.log(`      EXCLUSIONS: actions that derive the agent from the session only; and`)
  console.log(`      generateAIForecast, which takes agentId inside an OBJECT param and is not`)
  console.log(`      an export-a-ledger-as-a-file action — reported separately, not gated here.`)

  // POSITIVE CONTROL FIRST — a finder that sees nothing passes every absence
  // claim vacuously.
  check("POSITIVE CONTROL — the file parses and exported actions are visible to the scanner",
    exported.length > 0 && exported.includes("exportExpensesCSV"))
  check("POSITIVE CONTROL — the two audited actions are found and their bodies extracted",
    EXPORT_ACTIONS.every((n) => functionViews(src, n) !== null))
  check("POSITIVE CONTROL — the ownership branch is located inside each of them",
    EXPORT_ACTIONS.every((n) => {
      const v = functionViews(src, n)
      return !!v && ownershipBranch(v) !== null
    }))

  // THE CLAIM.
  for (const name of EXPORT_ACTIONS) {
    const c = auditGate(src, name)
    if (!c) { check(`${name} — body found`, false); continue }
    check(`${name} carries EVERY gate clause the ruling requires`, allClauses(c))
    if (!allClauses(c)) console.log(`      missing: ${missing(c).join(", ")}`)
  }

  // ONE VOCABULARY (CLAUDE.md §6). Two money exports over the same brokerage must
  // not be able to answer "may you?" differently. Asserted as clause-by-clause
  // equality, so a clause added to one and not the other is caught the same day.
  const a = auditGate(src, "exportExpensesCSV")
  const b = auditGate(src, "exportCommissionsCSV")
  check("the two export gates are clause-for-clause IDENTICAL — one vocabulary, not two",
    !!a && !!b && JSON.stringify(a) === JSON.stringify(b))
}

// ─── POSITIVE CONTROLS · CAN THE FINDER STILL SEE THE DEFECT? ────────────────

/**
 * Every clause asserted above, re-run against a body that SHOULD trip it.
 *
 * The first control is the REAL pre-fix source of exportExpensesCSV, kept
 * verbatim. If the finder cannot catch the body the defect was actually found
 * in, it is not a finder — and the green check above would mean nothing.
 */
const UNGATED_HISTORICAL = `
export async function exportExpensesCSV(agentId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const currentYear = new Date().getFullYear()

  try {
    const { data: expenses, error } = await supabase
      .from("business_expenses")
      .select("id, expense_date, category, description, amount, receipt_url")
      .eq("agent_id", agentId)
      .gte("expense_date", \`\${currentYear}-01-01\`)
      .order("expense_date", { ascending: false })
    if (error) throw error
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message ?? "Export failed" }
  }
}
`

/** The fixed gate, as a template the controls mutate one clause at a time. */
const GATED = `
export async function exportExpensesCSV(agentId: string) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  const supabase = await createClient()
  const svc = createServiceClient()
  if (agentId !== ctx.agentId) {
    if (!isFinanceAdmin(ctx.userType)) {
      return { success: false, error: "Forbidden" }
    }
    const { data: targetAgent, error: targetError } = await svc
      .from("agents").select("brokerage_id").eq("id", agentId).maybeSingle()
    if (targetError) {
      return { success: false, error: "Forbidden" }
    }
    if (!targetAgent || targetAgent.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden" }
    }
  }
  const { data: expenses } = await supabase
    .from("business_expenses")
    .select("id, amount")
    .eq("agent_id", agentId)
    .eq("brokerage_id", ctx.brokerageId)
  return { success: true }
}
`

function positiveControls() {
  console.log("\n[positive controls · each must go RED, or the checks above prove nothing]")

  const N = "exportExpensesCSV"

  // 1. THE REAL DEFECT. This is the body the hole was found in.
  const hist = auditGate(UNGATED_HISTORICAL, N)
  check("RED — the REAL pre-fix ungated body is caught: the finder still recognises the defect",
    !!hist && !allClauses(hist))
  check("RED — ...and it is caught on the clauses that actually made it a hole",
    !!hist && !hist.resolvesSessionIdentity && !hist.comparesCallerToTarget &&
    !hist.asksFinanceRoster && !hist.verifiesTargetTenant && !hist.pinsTenantOnQuery)

  // 2. The template itself must be GREEN, or every mutation below trips for the
  //    wrong reason and the controls test nothing.
  const base = auditGate(GATED, N)
  check("GREEN — the gated template passes every clause (the controls mutate from a clean base)",
    !!base && allClauses(base))

  // 3. One clause removed at a time.
  const drop = (from: string, what: string, to = "") => from.replace(what, to)

  const noPin = auditGate(drop(GATED, `\n    .eq("brokerage_id", ctx.brokerageId)`), N)
  check("RED — a gate that forgets to PIN THE TENANT on the row query is caught",
    !!noPin && !noPin.pinsTenantOnQuery && missing(noPin).join() === "pinsTenantOnQuery")

  const noRoster = auditGate(drop(GATED,
    `    if (!isFinanceAdmin(ctx.userType)) {\n      return { success: false, error: "Forbidden" }\n    }\n`), N)
  check("RED — a gate that never asks the finance roster is caught",
    !!noRoster && !noRoster.asksFinanceRoster)

  const noTenantCheck = auditGate(drop(GATED,
    `if (!targetAgent || targetAgent.brokerage_id !== ctx.brokerageId) {`, `if (!targetAgent) {`), N)
  check("RED — a gate that finds the agent but never compares their BROKERAGE is caught",
    !!noTenantCheck && !noTenantCheck.verifiesTargetTenant)

  // supabase-js RESOLVES refusals: this is the shape that reads a refusal as
  // "no such agent" — right answer, wrong reason, and wrong answer the day the
  // read is refused for an agent who exists.
  const swallowed = auditGate(drop(GATED,
    `const { data: targetAgent, error: targetError } = await svc`, `const { data: targetAgent } = await svc`)
    .replace(`    if (targetError) {\n      return { success: false, error: "Forbidden" }\n    }\n`, ""), N)
  check("RED — a gate that SWALLOWS the tenant-lookup error is caught",
    !!swallowed && !swallowed.readsLookupError)

  // The ID ORACLE: distinct refusal strings let a caller enumerate agent ids.
  const oracle = auditGate(GATED.replace(
    `if (!targetAgent || targetAgent.brokerage_id !== ctx.brokerageId) {\n      return { success: false, error: "Forbidden" }\n    }`,
    `if (!targetAgent) {\n      return { success: false, error: "No such agent" }\n    }\n    if (targetAgent.brokerage_id !== ctx.brokerageId) {\n      return { success: false, error: "Agent is in another brokerage" }\n    }`), N)
  check("RED — a gate whose refusals DIFFER (an id oracle) is caught",
    !!oracle && !oracle.oneRefusalString)

  const noAuth = auditGate(drop(GATED,
    `  if (!ctx.isAuthenticated || !ctx.brokerageId) {\n    return { success: false, error: "Unauthorized" }\n  }\n`), N)
  check("RED — a gate that never refuses an unauthenticated / untenanted session is caught",
    !!noAuth && !noAuth.refusesUnauthenticated)

  // 4. THE BLINDNESS CONTROLS (CLAUDE.md §2). A scanner that reads prose as code
  //    reports a clean bill of health over an ungated function. Both directions.
  const gateInCommentOnly = UNGATED_HISTORICAL.replace(
    "const supabase = await createClient()",
    `// const ctx = await getAgentContext()
  // if (agentId !== ctx.agentId) { if (!isFinanceAdmin(ctx.userType)) return }
  /* .eq("brokerage_id", ctx.brokerageId) */
  const supabase = await createClient()`)
  const commented = auditGate(gateInCommentOnly, N)
  check("RED — a gate that exists only in a COMMENT does not count as a gate",
    !!commented && !allClauses(commented) && !commented.pinsTenantOnQuery && !commented.asksFinanceRoster)

  const gateInStringOnly = UNGATED_HISTORICAL.replace(
    "const supabase = await createClient()",
    `const doc = "if (agentId !== ctx.agentId) isFinanceAdmin(ctx.userType)"
  const supabase = await createClient()`)
  const stringed = auditGate(gateInStringOnly, N)
  check("RED — ...nor one quoted inside a STRING",
    !!stringed && !stringed.comparesCallerToTarget && !stringed.asksFinanceRoster)

  // ...and the scanner is not simply blind to everything: a REAL gate written
  // beside that same prose is still seen.
  const proseAndGate = GATED.replace(
    "const supabase = await createClient()",
    `// historical: no gate at all, see the incident note
  const doc = "the old body had no ctx.agentId comparison"
  const supabase = await createClient()`)
  const both = auditGate(proseAndGate, N)
  check("GREEN — a real gate written BESIDE that prose is still seen, so the mask did not blind the scan",
    !!both && allClauses(both))

  // 5. The brace matcher must not desynchronise on braces inside literals — the
  //    failure mode that makes a scanner swallow the rest of a file.
  const braceTrap = GATED.replace(
    "const supabase = await createClient()",
    `const tricky = "a } brace in a string"
  const tmpl = \`\${"}"} and a } in a template\`
  // a } brace in a comment
  const supabase = await createClient()`)
  const trapped = auditGate(braceTrap, N)
  check("GREEN — braces inside strings, templates and comments do not desynchronise the body scan",
    !!trapped && allClauses(trapped))
}

// ─── LIVE ────────────────────────────────────────────────────────────────────

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("\n[live] SKIPPED — no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env")
    return
  }
  console.log("\n[live · the tenant column this gate pins on]")

  const svc = createClient(url, key, { auth: { persistSession: false } })

  // supabase-js RESOLVES refusals: `const { count }` alone would read a refused
  // read as zero and the census below would pass over nothing.
  const { count: total, error: totalErr } = await svc
    .from("business_expenses").select("id", { count: "exact", head: true })
  if (totalErr) {
    check(`business_expenses readable — ${totalErr.message}`, false)
    return
  }
  const { count: nullTenant, error: nullErr } = await svc
    .from("business_expenses").select("id", { count: "exact", head: true }).is("brokerage_id", null)
  if (nullErr) {
    check(`NULL-tenant census readable — ${nullErr.message}`, false)
    return
  }

  // BOTH numbers, together. A bare "0 NULLs" reads as "already fixed" when it may
  // only say "nothing has been written here yet".
  console.log(`      business_expenses: null_tenant = ${nullTenant} of total = ${total}`)
  check("POSITIVE CONTROL — the census ran and returned a number, rather than silently reading zero",
    typeof total === "number" && typeof nullTenant === "number")

  // Not asserted as a pass/fail on the count: before m516 is applied a NULL is
  // possible and the export REPORTS it (untenantedRowCount) rather than dropping
  // it quietly. This states which world we are in.
  if ((nullTenant ?? 0) > 0) {
    console.log(`      NOTE: ${nullTenant} untenanted row(s) exist. Under policy business_expenses_tenant`)
    console.log(`      these are invisible to their OWN agent (has_brokerage_access(NULL) is false for`)
    console.log(`      every non-platform caller). exportExpensesCSV counts them into untenantedRowCount.`)
    console.log(`      supabase/migrations/m516-*.sql backfills and closes the column. NOT yet applied.`)
  } else {
    console.log(`      no untenanted rows — the tenant pin drops nothing today.`)
  }

  console.log("      seeded rows: 0 · residue: 0 (this layer reads counts only)")
}

// ─── RUN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═".repeat(78))
  console.log(" EXPENSE EXPORT SCOPE — your own always; your brokerage only if you administer it")
  console.log("═".repeat(78))

  rosterLayer()
  decisionLayer()
  sourceLayer()
  positiveControls()
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
