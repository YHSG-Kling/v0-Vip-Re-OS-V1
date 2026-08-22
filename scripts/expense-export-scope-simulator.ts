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
import {
  EXPENSE_CSV_HEADERS,
  RECEIPT_ON_FILE,
  RECEIPT_MISSING,
  buildExpenseCsv,
  hasReceipt,
  type ExpenseCsvInput,
} from "../lib/finance/expense-csv"
import {
  findCredentialsInCsv,
  redactCredentials,
  CSV_CREDENTIAL_PATTERNS,
  CREDENTIAL_REDACTED,
} from "../lib/security/export-credential-scan"
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

// ─── NO CREDENTIAL IN THE FILE ───────────────────────────────────────────────
//
// OWNER RULING (finding #294), verbatim: "294 no credentials should be listed in
// csv."
//
// The gate above answers WHO MAY EXPORT. This layer answers WHAT LEAVES — and the
// two are independent failures: a perfectly gated export that ships a 365-day
// signed URL has handed the file's holder a key that outlives every check the
// gate made. `receipt_url` was that key: minted by attachExpenseReceipt with
// bucket "receipts", public:false, signedTtlSeconds 60*60*24*365.
//
// BUILT AS AN ABSENCE ASSERTION WITH ITS CONTROL ATTACHED (CLAUDE.md §2). The
// claim is "0 credentials in the built CSV". A broken finder reports 0 too, so
// every claim below is paired with the same finder re-run over the PRE-RULING
// column, which must go RED.

/** Shaped exactly like what attachExpenseReceipt writes: signed, tokened, JWT. */
const REAL_SHAPED_SIGNED_URL =
  "https://hrvaqgvukzxfskkcrwbt.supabase.co/storage/v1/object/sign/receipts/" +
  "1f7d2b30-0a4e-4c11-b8d9-6a5e3c9f2ab1/9c8b7a65-4321-4fed-cba9-876543210fed/1755820800000.pdf" +
  "?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
  ".eyJ1cmwiOiJyZWNlaXB0cy8xZjdkMmIzMC0wYTRlLmpwZyIsImlhdCI6MTc1NTgyMDgwMCwiZXhwIjoxNzg3MzU2ODAwfQ" +
  ".9tQb3Xk1Zr4mN7pL0sV2wC5yD8fG1hJ3kM6nP9qR2sT"

const SAMPLE_ROWS: ExpenseCsvInput[] = [
  { id: "9c8b7a65-4321-4fed-cba9-876543210fed", expense_date: "2026-03-04", category: "marketing",
    description: 'Yard signs, "premium" stock', amount: 412.5, receipt_url: REAL_SHAPED_SIGNED_URL },
  { id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", expense_date: "2026-02-11", category: "mileage",
    description: "Showings, north county", amount: 88, receipt_url: null },
  { id: "5f6e7d8c-9b0a-4c1d-8e2f-3a4b5c6d7e8f", expense_date: "2026-01-09", category: "dues",
    description: "MLS quarterly", amount: 175.25, receipt_url: "   " },
]

/** The export as it was BEFORE the ruling: the same five columns, URL verbatim. */
function preRulingCsv(rows: ExpenseCsvInput[]): string {
  const headers = ["Date", "Category", "Description", "Amount", "Receipt URL"]
  const body = rows.map((e) => [
    e.expense_date ?? "", e.category ?? "", e.description ?? "",
    (Number(e.amount ?? 0)).toFixed(2), e.receipt_url ?? "",
  ])
  return [headers, ...body]
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n")
}

/**
 * `receipt_url` EMITTED as a value, as opposed to merely NAMED in a `.select()`.
 * The discriminator is the leading dot: a projection list is the bare word inside
 * a string literal, an emission is a property read off a row.
 */
const emitsReceiptUrl = (code: string) => /\.\s*receipt_url\b|\breceiptUrl\s*\?\?/.test(code)

function credentialLayer() {
  console.log("\n[what leaves · the ruling — \"no credentials should be listed in csv\"]")

  // POSITIVE CONTROLS FIRST. A finder that recognises nothing passes every
  // absence claim vacuously, and this whole layer is one absence claim.
  const before = preRulingCsv(SAMPLE_ROWS)
  const beforeFindings = findCredentialsInCsv(before)
  check("RED — the PRE-RULING column is caught: the finder still recognises a signed URL in a CSV",
    beforeFindings.length > 0)
  check("RED — ...and it is caught on the shapes that make it a BEARER credential, not just on 'it is a URL'",
    ["supabase_signed_object", "query_token", "jwt", "storage_object_url"]
      .every((p) => beforeFindings.some((f) => f.pattern === p)))
  console.log(`      pre-ruling CSV: ${beforeFindings.length} credential finding(s) over ${SAMPLE_ROWS.length} rows`)

  // Every pattern in the finder must be a pattern that FIRES. A regex that can
  // never match is a line of prose pretending to be a check.
  const SHAPES: Array<[string, string]> = [
    ["supabase_signed_object", "https://x.supabase.co/storage/v1/object/sign/receipts/a/b.pdf"],
    ["query_token", "https://example.com/r?token=abc123"],
    ["aws_sigv4", "https://b.r2.dev/o?X-Amz-Signature=deadbeef"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig"],
    ["bearer", "Authorization: Bearer abcdefghijklmnop0123"],
    ["vos_token", "vos_abcdefghijklmnop0123456789"],
    ["webhook_secret", "whsec_abcdefghijklmnop0123456789"],
    ["stripe_secret", "sk_live_abcdefghijklmnop0123"],
    ["storage_object_url", "https://x.supabase.co/storage/v1/object/public/documents/a.pdf"],
    ["vercel_blob_url", "https://abc123.public.blob.vercel-storage.com/reports/summary.html"],
  ]
  check("RED — every pattern in the finder actually fires on its own shape (no dead regexes)",
    CSV_CREDENTIAL_PATTERNS.every((p) => {
      const s = SHAPES.find(([n]) => n === p.name)
      return !!s && findCredentialsInCsv(`"cell","${s[1]}"`).some((f) => f.pattern === p.name)
    }) && SHAPES.length === CSV_CREDENTIAL_PATTERNS.length)

  // ...and the finder is not simply screaming at everything: the columns that
  // REPLACED the URL must come back clean, or "0 findings" below would be luck.
  check("GREEN — a uuid, a date, a money amount and free-text prose are NOT read as credentials",
    findCredentialsInCsv(
      '"2026-03-04","marketing","Signs — see https://app.example.com/dashboard/financials/expenses","412.50","on file","9c8b7a65-4321-4fed-cba9-876543210fed"',
    ).length === 0)

  // ─── THE CLAIM ───────────────────────────────────────────────────────────
  const after = buildExpenseCsv(SAMPLE_ROWS)
  const afterFindings = findCredentialsInCsv(after)
  console.log(`      shipped CSV:    ${afterFindings.length} credential finding(s) over the SAME ${SAMPLE_ROWS.length} rows`)
  check("the shipped builder emits NO credential, fed a row carrying a REAL-shaped 365-day signed URL",
    afterFindings.length === 0)
  if (afterFindings.length) for (const f of afterFindings) console.log(`      LEAKED: ${f.pattern} — ${f.sample}`)

  check("...and the signed URL is absent VERBATIM too, not merely unrecognised by a pattern",
    !after.includes(REAL_SHAPED_SIGNED_URL) && !after.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"))
  check("...and no column NAME invites one back in",
    !EXPENSE_CSV_HEADERS.some((h) => /url|link|token|signed|secret/i.test(h)))

  // THE EXPORT MUST STILL BE USEFUL. Removing a column is only a fix if the
  // bookkeeping question it was answering is still answered.
  check("the reader can still tell a receipt EXISTS — presence survives the credential's removal",
    EXPENSE_CSV_HEADERS.includes("Receipt" as never) &&
    after.split("\n")[1].includes(`"${RECEIPT_ON_FILE}"`) &&
    after.split("\n")[2].includes(`"${RECEIPT_MISSING}"`))
  check("...and whitespace is not a receipt — a blank string reads as missing, not as on file",
    after.split("\n")[3].includes(`"${RECEIPT_MISSING}"`))

  // ─── THE RULE ITSELF, NOT ONLY ITS SHADOW IN A CSV CELL ──────────────────
  //
  // The three checks above infer the presence rule from a composed 6-column
  // file, so a change of column ORDER, of quoting, or of the RECEIPT_* words
  // would move them for a reason that has nothing to do with the rule. These
  // drive the predicate directly, which is both stricter and narrower — and it
  // is the predicate the DASHBOARD now shares, so it has to be right in more
  // than one place.
  check("hasReceipt — a real signed URL is a receipt",
    hasReceipt({ receipt_url: REAL_SHAPED_SIGNED_URL }) === true)
  check("hasReceipt — null, undefined and the empty string are NOT receipts",
    hasReceipt({ receipt_url: null }) === false
    && hasReceipt({}) === false
    && hasReceipt({ receipt_url: "" }) === false)
  check("hasReceipt — WHITESPACE-ONLY is not a receipt (the spelling the panel used to get wrong)",
    hasReceipt({ receipt_url: "   " }) === false
    && hasReceipt({ receipt_url: "\t\n " }) === false)
  check("  ↳ POSITIVE CONTROL: bare truthiness — the rule this REPLACED — disagrees on exactly that row",
    Boolean(("   " as unknown as string)) === true
    && hasReceipt({ receipt_url: "   " }) === false)
  check("hasReceipt — a non-string (a legacy jsonb blob) is not a receipt either",
    hasReceipt({ receipt_url: 0 as unknown as string }) === false
    && hasReceipt({ receipt_url: {} as unknown as string }) === false)

  // ─── ONE VOCABULARY: THE DASHBOARD ASKS THE SAME QUESTION (CLAUDE.md §6) ──
  //
  // "Missing Receipts" on the deduction-readiness panel and the CSV's `Receipt`
  // column are the same bookkeeping fact. While the panel spelled it
  // `e.receipt_url` an agent could read 100% receipt completeness on screen and
  // mail a CSV saying the same row has none.
  const PANEL = join(
    ROOT, "app", "dashboard", "financials", "components", "planning",
    "deduction-readiness-panel.tsx",
  )
  const panelSrc = readFileSync(PANEL, "utf8")
  check("POSITIVE CONTROL — the deduction-readiness panel's source is visible to this scan",
    panelSrc.length > 0 && /missingReceipts/.test(panelSrc))
  check("the panel imports the ONE presence predicate from the audited builder",
    /import\s*\{\s*hasReceipt\s*\}\s*from\s*"@\/lib\/finance\/expense-csv"/.test(panelSrc))
  check("...and both of its receipt tallies route through it",
    /withReceipts\s*=\s*expenses\.filter\(\(e\)\s*=>\s*hasReceipt\(e\)\)/.test(panelSrc)
    && /missingReceipts\s*=\s*expenses\.filter\(\(e\)\s*=>\s*!hasReceipt\(e\)\)/.test(panelSrc))
  // A finder that cannot see the defect it was written for is decoration.
  const TRUTHINESS = /expenses\.filter\(\(e\)\s*=>\s*!?e\.receipt_url\)/
  check("  ↳ POSITIVE CONTROL: the truthiness finder still recognises the pre-fix spelling",
    TRUTHINESS.test("const missingReceipts = expenses.filter((e) => !e.receipt_url)")
    && TRUTHINESS.test("const withReceipts = expenses.filter((e) => e.receipt_url).length"))
  check("  ↳ ...and that spelling is gone from the panel",
    !TRUTHINESS.test(panelSrc))
  check("the reader can still FIND the receipt — the row's own id is the in-app locator",
    EXPENSE_CSV_HEADERS.includes("Expense ID" as never) &&
    SAMPLE_ROWS.every((r) => after.includes(`"${r.id}"`)))
  check("every row still carries every column — the fix removed a credential, not data",
    after.split("\n").length === SAMPLE_ROWS.length + 1 &&
    after.split("\n").every((l) => l.split('","').length === EXPENSE_CSV_HEADERS.length))

  // ─── IS THE RULE WHAT SHIPS? ─────────────────────────────────────────────
  const src = readFileSync(FINANCIALS, "utf8")
  const v = functionViews(src, "exportExpensesCSV")
  check("POSITIVE CONTROL — exportExpensesCSV's body is visible to this scan",
    v !== null && v.code.length > 0)
  check("the shipped action builds its CSV through the ONE audited builder",
    !!v && /buildExpenseCsv\s*\(/.test(v.code))
  check("...and EMITS no receipt_url of its own (naming it in .select() for presence is not emitting it)",
    !!v && !emitsReceiptUrl(v.code))

  // The same structural check, re-run on the body that DID emit it.
  const histView = functionViews(UNGATED_HISTORICAL, "exportExpensesCSV")
  check("RED — a body that emits `e.receipt_url` into its rows is caught by that same check",
    !!histView && emitsReceiptUrl(
      histView.code + '\n  const rows = expenses.map((e: any) => [e.receipt_url ?? ""])'))
  check("RED — ...and the check is not blind to the sibling spelling `receiptUrl ??` either",
    emitsReceiptUrl('const cell = row.receiptUrl ?? ""'))

  // ─── THE SHARED SINK REDACTION ───────────────────────────────────────────
  //
  // The same finder guards app/api/admin/audit-events/route.ts, whose
  // `metadata_json` column passes lifecycle_events.metadata through wholesale —
  // an OPEN writer set, so an allowlist is impossible and the sink is where it
  // has to be caught. lib/kernel/reporting.ts#exportReportPdf already writes a
  // permanent public blob URL into exactly that metadata.
  const REAL_METADATA = JSON.stringify({
    reportType: "summary",
    blobUrl: "https://abc123.public.blob.vercel-storage.com/reports/summary-2026-08-22.html",
    rowCount: 42,
  })
  check("RED — an audit metadata blob carrying a permanent public blob URL is caught unredacted",
    findCredentialsInCsv(REAL_METADATA).some((f) => f.pattern === "vercel_blob_url"))
  const redacted = redactCredentials(REAL_METADATA)
  check("the sink redaction removes it",
    findCredentialsInCsv(redacted).length === 0 && !redacted.includes("blob.vercel-storage.com"))
  check("...and NAMES the hole rather than blanking it — withheld must not look like empty",
    redacted.includes(CREDENTIAL_REDACTED))
  check("...and leaves every non-credential field of the blob intact",
    redacted.includes('"reportType":"summary"') && redacted.includes('"rowCount":42'))
  check("...and does not eat an ordinary in-app URL that authorizes nothing",
    redactCredentials('{"link":"https://app.example.com/dashboard/financials/expenses"}')
      === '{"link":"https://app.example.com/dashboard/financials/expenses"}')

  console.log("      BLIND SPOTS: this layer proves what the BUILDER emits, over rows it is handed.")
  console.log("      It does not read the database, so a credential pasted by a user into")
  console.log("      `description` would ride out as free text — bounded by the finder above,")
  console.log("      which scans the WHOLE built CSV, not just the receipt column. It also says")
  console.log("      nothing about exports outside this file; those are swept separately.")
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
  credentialLayer()
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
