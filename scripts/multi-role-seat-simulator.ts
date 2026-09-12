#!/usr/bin/env tsx
/**
 * scripts/multi-role-seat-simulator.ts   (npm run test:multi-role-seat)
 * ─────────────────────────────────────────────────────────────────────────────
 * A SEAT HOLDS SEVERAL ROLES. THAT IS THE DESIGN, NOT AN ANOMALY.
 *
 * Owner ruling: a solo-agent tenant has TWO seats — the producing agent, and one
 * other person who carries EVERYTHING ELSE (transactions, compliance, support,
 * admin, marketing). Business roles are ASSIGNED to a user through
 * public.user_role_assignments, so one user holding several grants is the ORDINARY
 * account. Any code that assumes exactly one grant per user is wrong BY DESIGN.
 *
 * The schema already said so and the app was not listening:
 *
 *     user_role_assignments_user_role_unique  UNIQUE (user_id, role)
 *
 * — on the PAIR. Not on user_id. MEASURED live: 7 grants across 4 users, two of
 * whom hold several (admin+agent+isa; contact+team_lead, the contact one carrying
 * a NULL brokerage_id).
 *
 * TWO FAILURE MODES, WHICH ARE NOT THE SAME BUG:
 *
 *   (a) `.eq("user_id", …).maybeSingle()` with NO limit. PostgREST refuses a
 *       single-object request that matches several rows. supabase-js RESOLVES the
 *       failure, and every one of these sites destructured `data` alone — so the
 *       refusal was invisible and the caller read it as "this user has no grant".
 *       FAIL-CLOSED, SILENTLY: it broke for exactly the busiest accounts.
 *
 *   (b) `.limit(1).maybeSingle()` with NO ORDER BY. Cannot throw — which is what
 *       makes it worse. An ARBITRARY grant is returned and consumed, so the TENANT
 *       a surface is scoped to can differ between two runs of the same code, and
 *       the winning row may be the untenanted `contact` grant whose brokerage_id
 *       is NULL. FAIL-ARBITRARY.
 *
 * THE SHORTCUT THIS PROOF EXISTS TO FORBID: adding `.limit(1)` to (a). That does
 * not fix anything — it converts a silent refusal into a silently wrong answer.
 *
 * PURE:   the choosers in lib/auth/role-grants.ts — every one of them is asserted
 *         to be ORDER-INDEPENDENT across all permutations of its input, because
 *         "deterministic" is the whole claim and row order is the whole threat.
 *         Also: an untenanted grant can never anchor a tenant, and two DIFFERENT
 *         vendors are REPORTED as ambiguous rather than resolved to one of them.
 * SOURCE: a shape scan over the whole tree — no read of user_role_assignments may
 *         filter on user_id ALONE and then take a single object. Keyed to the
 *         QUERY SHAPE, not to a file list, so a new site written tomorrow in a
 *         file nobody has thought of is caught the same way.
 * LIVE (creds-gated): seeds a genuine multi-grant seat, then proves BOTH modes on
 *         the real database — that `.maybeSingle()` over it ERRORS, and that the
 *         chooser answers the same thing on repeated reads — then cleans up and
 *         proves residue 0. Self-skips without SUPABASE creds.
 */
import { readFileSync } from "node:fs"
import { walkTs } from "./runtime-roots"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"
import {
  selectTenantGrant,
  selectTenantBrokerageId,
  selectVendorGrant,
  selectVendorId,
  selectAgentId,
  holdsAnyRole,
  allRoles,
  selectPrimaryRole,
  type RoleGrant,
} from "../lib/auth/role-grants"
import { blankComments, blankStrings } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}

const ROOT = process.cwd()
const SELF = fileURLToPath(import.meta.url)
const g = (role: string, brokerage: string | null, vendor: string | null = null, agent: string | null = null): RoleGrant =>
  ({ role, brokerage_id: brokerage, vendor_id: vendor, agent_id: agent })

/** Every ordering of `xs` — the only honest way to assert "row order cannot decide". */
function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs]
  const out: T[][] = []
  for (let i = 0; i < xs.length; i++) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)]
    for (const p of permutations(rest)) out.push([xs[i], ...p])
  }
  return out
}

/** True when `f` returns the same JSON for EVERY ordering of `grants`. */
function orderIndependent<T>(grants: RoleGrant[], f: (gs: RoleGrant[]) => T): boolean {
  const answers = permutations(grants).map((p) => JSON.stringify(f(p)))
  return new Set(answers).size === 1
}

// ─── PURE ────────────────────────────────────────────────────────────────────

function pureLayer() {
  console.log("\n[the choosers · pure — row order may never decide anything]")

  // The live shape: one seat, three tenanted grants.
  const BROK = "b-231f"
  const multiRole = [g("admin", BROK), g("agent", BROK, null, "agent-1"), g("isa", BROK)]

  check("a 3-grant seat resolves to ONE tenant, the same one under every row order",
    orderIndependent(multiRole, selectTenantBrokerageId) && selectTenantBrokerageId(multiRole) === BROK)

  // The other live shape: a tenanted grant beside an UNTENANTED one.
  const contactPlusLead = [g("contact", null), g("team_lead", BROK)]
  check("an untenanted grant (brokerage_id NULL) can never become the tenant anchor",
    selectTenantBrokerageId(contactPlusLead) === BROK &&
    orderIndependent(contactPlusLead, selectTenantBrokerageId))
  check("a seat with NO tenanted grant anchors nowhere rather than guessing",
    selectTenantBrokerageId([g("contact", null), g("lender", null)]) === null)

  // Two tenanted grants pointing at DIFFERENT brokerages: still one stable answer.
  const twoTenants = [g("agent", "b-aaa"), g("admin", "b-zzz")]
  check("two tenanted grants resolve by AUTHORITY, identically under every row order",
    orderIndependent(twoTenants, selectTenantBrokerageId) && selectTenantBrokerageId(twoTenants) === "b-zzz")

  // Unranked roles must still be stable — the threat is arbitrariness, not rank.
  const unranked = [g("wildcat", "b-aaa"), g("badger", "b-zzz")]
  check("roles outside the precedence list still sort STABLY (never by row order)",
    orderIndependent(unranked, selectTenantBrokerageId))

  check("selectTenantGrant hands back the whole grant, not just the id",
    selectTenantGrant(multiRole)?.role === "admin")

  console.log("\n[vendor identity · pure — single-valued, and said so when it is not]")
  check("no vendor-bearing grant → no vendor, and NOT flagged ambiguous",
    selectVendorId(multiRole).vendorId === null && selectVendorId(multiRole).ambiguous === false)

  const oneVendorTwoGrants = [g("vendor", BROK, "v-1"), g("contact", null, "v-1")]
  check("ONE vendor reached through two grants resolves (not a fault) and is order-independent",
    selectVendorId(oneVendorTwoGrants).vendorId === "v-1" &&
    selectVendorId(oneVendorTwoGrants).ambiguous === false &&
    orderIndependent(oneVendorTwoGrants, selectVendorId))
  check("the grant handed back for that vendor carries a STABLE brokerage_id",
    orderIndependent(oneVendorTwoGrants, (gs) => selectVendorGrant(gs).grant?.brokerage_id ?? null) &&
    selectVendorGrant(oneVendorTwoGrants).grant?.brokerage_id === BROK)

  const twoVendors = [g("vendor", BROK, "v-1"), g("title_agent", BROK, "v-2")]
  check("TWO different vendors are REPORTED ambiguous — never resolved to one of them",
    selectVendorId(twoVendors).vendorId === null && selectVendorId(twoVendors).ambiguous === true)
  check("the ambiguous answer is itself order-independent (no lucky ordering resolves it)",
    orderIndependent(twoVendors, selectVendorId))

  console.log("\n[agent linkage · pure — agents is UNIQUE (user_id), so two ids is a FAULT]")
  check("the live admin+agent+isa seat — ONE grant carries the linkage, two do not — resolves to it",
    selectAgentId(multiRole).agentId === "agent-1" &&
    selectAgentId(multiRole).ambiguous === false &&
    orderIndependent(multiRole, selectAgentId))
  check("no grant carries an agent_id → null, and NOT a fault",
    selectAgentId([g("admin", BROK), g("isa", BROK)]).agentId === null &&
    selectAgentId([g("admin", BROK), g("isa", BROK)]).ambiguous === false)

  const oneAgentTwoGrants = [g("agent", BROK, null, "a-1"), g("isa", BROK, null, "a-1")]
  check("ONE agent reached through two grants resolves (the live admin+agent+isa shape)",
    selectAgentId(oneAgentTwoGrants).agentId === "a-1" &&
    selectAgentId(oneAgentTwoGrants).ambiguous === false &&
    orderIndependent(oneAgentTwoGrants, selectAgentId))
  check("a grant with NO agent_id beside one that has it does not blank the linkage",
    selectAgentId([g("admin", BROK), g("agent", BROK, null, "a-1")]).agentId === "a-1")

  const twoAgents = [g("agent", BROK, null, "a-1"), g("isa", BROK, null, "a-2")]
  check("TWO different agent ids are REPORTED, never resolved — that would hand over another agent's book",
    selectAgentId(twoAgents).agentId === null && selectAgentId(twoAgents).ambiguous === true)
  check("the ambiguous agent answer is order-independent (no lucky ordering resolves it)",
    orderIndependent(twoAgents, selectAgentId))

  console.log("\n[role questions · pure — 'holds X' is a question about the SET]")
  check("a seat holding admin ALONGSIDE agent still holds admin",
    holdsAnyRole(multiRole, ["admin", "broker", "superadmin"]))
  check("a seat holding none of them does not",
    !holdsAnyRole([g("agent", BROK), g("isa", BROK)], ["admin", "broker", "superadmin"]))
  check("holdsAnyRole is case-insensitive (users.role is legacy free-form: 'Admin', 'Lender')",
    holdsAnyRole([g("Admin", BROK)], ["admin"]))

  check("allRoles returns the whole UNION, deduped, in a stable order",
    JSON.stringify(allRoles(multiRole)) === JSON.stringify(["admin", "agent", "isa"]) &&
    orderIndependent(multiRole, allRoles))

  console.log("\n[one required role · pure — the seat's own identity wins when granted]")
  check("the preferred role wins when the seat actually holds it",
    selectPrimaryRole(multiRole, "agent") === "agent" && selectPrimaryRole(multiRole, "isa") === "isa")
  check("a preferred role the seat does NOT hold falls to authority order, not to itself",
    selectPrimaryRole(multiRole, "superadmin") === "admin")
  check("no preference falls to authority order",
    selectPrimaryRole(multiRole) === "admin")
  check("case-insensitive against legacy users.role values",
    selectPrimaryRole(multiRole, "Agent") === "agent")
  check("no grants at all → null, so the caller keeps its OWN fallback",
    selectPrimaryRole([], "agent") === null)
  check("the chosen role does not depend on row order",
    orderIndependent(multiRole, (gs) => selectPrimaryRole(gs, "nope")))
}

// ─── SOURCE ──────────────────────────────────────────────────────────────────

// TOMBSTONE (orphan doctrine §1.1) — the private walker that stood here was one of
// 82 copies of the same readdirSync walker. The survivor is
// scripts/runtime-roots.ts:61 (`walkTs`), imported above. This one already walked
// ROOT, so it was not blind to `proxy.ts`; it is DEDUPLICATED only, and every
// exclusion below is this file's own, preserved so the corpus does not move.
function walk(dir: string): string[] {
  // This guard QUOTES the forbidden shapes — in its own header and in its own
  // regexes — so scanning itself would report prose as a live read.
  return walkTs(dir).filter((p) => p !== SELF)
}

/**
 * Source with comments blanked (newlines preserved so line numbers survive).
 *
 * The scans below must pin to a LIVE READ, never to a sentence about one. Half of
 * the sites fixed in this pass carry a `WAS: .eq("user_id", …).maybeSingle()`
 * comment explaining the defect they no longer have; a scan that cannot tell those
 * apart from code fails on the documentation and passes on nothing.
 */
function codeOnly(s: string): string {
  return blankComments(s)
}

/**
 * codeOnly, PLUS string and template literals blanked.
 *
 * Comments are not the only place prose hides. This proof's own registry entry in
 * lib/kernel/manager-registry.ts documents the defect it forbids by QUOTING it —
 * `grants.find(g => g.agent_id)` — inside a plain string literal, and the shape
 * scan below matched that quotation and failed on green code. That is the same
 * mistake as the comment case, one layer down: a description of a call is not a
 * call, wherever it is stored.
 *
 * Deliberately NOT solved by skipping the registry file or by rewording the
 * sentence. Pinning a scan to a file path is how a probe goes blind the day the
 * code moves, and editing the documentation to dodge the scanner would leave the
 * scanner still wrong for the next quotation someone writes.
 *
 * ── THE ONE SCANNER, NOT THREE REGEXES (lane K6, 2026-08-29) ────────────────
 *
 * This used to blank literals with three global regexes run one after another —
 * template, then double quote, then single quote, "longest-first so a template
 * literal is not chewed up by the quote rules". That ordering argument is the
 * block-comments-first defect restated: order cannot decide it, because the
 * backtick pass pairs LEFT TO RIGHT and cannot see that a backtick is TEXT inside
 * a quoted string. An odd number of such backticks leaves the pairer inside a
 * phantom template, and everything to the next backtick is blanked away — code
 * included. This copy also used the `\\.` escape form, and `.` does not match a
 * newline, so a backslash at end of line (a legal line continuation) could not be
 * consumed and desynchronised the pairing a second way.
 *
 * MEASURED on this tree before the conversion, over the 5,487 files this proof
 * walks: the retired masker and blankStrings disagree on 2,239 of them. It was
 * blind to 10,007 identifier slots — `lib/agents/asset-manager.ts` alone lost 152,
 * because its `${…}` interpolations were blanked with the template text around
 * them — and it LEAKED 5,164 prose slots back in as if they were code, because
 * literals it failed to pair were never blanked at all
 * (`lib/direct-mail/draft-copy.ts` 369, `lib/elevenlabs/conv-ai.ts` 201). Leaking
 * prose is precisely the failure this helper's header, above, exists to describe.
 *
 * The scans below did not MOVE on that — orderPickedAgentLinkage reports 0 either
 * way — because none of the mis-read regions happens to contain
 * `.find(g => g.agent_id)` today. That is luck, not correctness: the helper was
 * right about this tree while being wrong about how to read it, and the next
 * quotation or the next fenced JSON parser is not obliged to keep it lucky.
 *
 * blankStrings() does comments AND literal contents in ONE left-to-right scan, so
 * the separate codeOnly() pass is no longer needed here. `${…}` interpolations
 * stay CODE, which is what they are — a call written inside one is a call.
 */
function executableCodeOnly(s: string): string {
  return blankStrings(s)
}

/**
 * Every `.from("user_role_assignments")` chain in a file, as [startIndex, chain].
 *
 * DELIBERATELY uses codeOnly, NOT executableCodeOnly. Do not "fix" this to match
 * the agent-linkage scan below: this one matches on a STRING ARGUMENT — the table
 * name itself — so blanking string literals would turn every
 * `.from("user_role_assignments")` into `.from(                        )` and
 * blind the scan completely, silently, while it went on reporting zero.
 *
 * The two scans differ because the two shapes differ: one is identified by
 * identifiers (`g.agent_id`), where a quotation is noise; the other is identified
 * by a quoted table name, where the quotation IS the signal. Which text to ignore
 * is a per-scan judgement, not a global setting.
 */
function grantChains(code: string): Array<[number, string]> {
  const out: Array<[number, string]> = []
  const re = /\.from\(\s*["']user_role_assignments["']\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    const from = m.index + m[0].length
    const tail = code.slice(from, from + 700)
    const nextFrom = tail.indexOf(".from(")
    out.push([m.index, nextFrom === -1 ? tail : tail.slice(0, nextFrom)])
  }
  return out
}

const lineOf = (s: string, i: number) => s.slice(0, i).split("\n").length

/**
 * Every `.from("user_role_assignments")` chain that filters on user_id and then
 * takes a SINGLE OBJECT, WITHOUT narrowing to something that makes one row the
 * true answer. Keyed to the query shape, so it catches a site written tomorrow in
 * a file this proof has never heard of.
 */
function unsoundSingleRowReads(): string[] {
  const hits: string[] = []
  for (const file of walk(ROOT)) {
    const code = codeOnly(readFileSync(file, "utf8"))
    for (const [at, chain] of grantChains(code)) {
      const single = /\.maybeSingle\(\)|\.single\(\)/.exec(chain)
      if (!single) continue
      const upto = chain.slice(0, single.index)
      if (!/\.eq\(\s*["']user_id["']/.test(upto)) continue
      // `role` is the OTHER half of the real unique key — a read narrowed by it is
      // single-row BY THE CONSTRAINT, which is the only honest way to take one.
      if (/\.eq\(\s*["']role["']/.test(upto)) continue
      hits.push(`${relative(ROOT, file)}:${lineOf(code, at)}`)
    }
  }
  return hits.sort()
}

/**
 * Every site that picks the agent linkage off a grant array by ARRAY ORDER.
 *
 * `.find(g => g.agent_id)` reads as careful — it skips the grants that carry no
 * linkage — but among two grants naming DIFFERENT agents it still lets whatever
 * order PostgREST returned settle which agent this request acts as. Since
 * public.agents is UNIQUE (user_id), two distinct ids is a provable fault, and
 * resolving it either way hands a caller another agent's production and
 * commissions. selectAgentId reports it; this scan keeps it reported.
 *
 * Blind to prose WHEREVER it is stored — comments AND string literals — so
 * neither the three call sites' notes about the shape they no longer have, nor
 * the manager-registry entry that documents this very rule by quoting it, is
 * counted as the shape itself.
 */
const ORDER_PICKED_AGENT = /\.find\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\.agent_id\s*\)/g

function orderPickedAgentLinkage(): string[] {
  const hits: string[] = []
  const re = new RegExp(ORDER_PICKED_AGENT.source, "g")
  for (const file of walk(ROOT)) {
    const code = executableCodeOnly(readFileSync(file, "utf8"))
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(code))) hits.push(`${relative(ROOT, file)}:${lineOf(code, m.index)}`)
  }
  return hits.sort()
}

function sourceLayer() {
  console.log("\n[shape scan · source — no site may take one row on user_id alone]")

  const orderPicked = orderPickedAgentLinkage()
  check(
    `no site picks the agent linkage by array order — agents is UNIQUE (user_id) (found ${orderPicked.length})`,
    orderPicked.length === 0,
  )
  for (const h of orderPicked) console.log(`      · ${h}`)

  // NEGATIVE CONTROL. That scan reports 0, and a scan that has never gone red on
  // anything is indistinguishable from a scan that cannot. Run it against the three
  // forms that were ACTUALLY in the tree before this pass — verbatim — plus the
  // spacing variants a future edit might use, and against the questions it must NOT
  // answer. A count of zero only means something once this passes.
  const matches = (s: string) => new RegExp(ORDER_PICKED_AGENT.source).test(s)
  check("NEGATIVE CONTROL the scan goes RED on all three pre-fix call sites, verbatim",
    matches('const agentId = grants.find((g) => g.agent_id)?.agent_id ?? ""') &&
    matches('let agentId: string | null = grants.find((g) => g.agent_id)?.agent_id ?? null') &&
    matches('const agentGrantId = roleGrants.find((g) => g.agent_id)?.agent_id ?? null'))
  check("NEGATIVE CONTROL …and on the spacing variants an edit could reintroduce it in",
    matches("grants.find(g => g.agent_id)") && matches("grants.find((x)=>x.agent_id)"))
  check("…while staying green on a DIFFERENT question (vendor) and on a mismatched binding",
    !matches("grants.find((g) => g.vendor_id)") && !matches("grants.find((a) => b.agent_id)"))

  // PROSE IS NOT CODE, WHEREVER IT IS STORED. The scan already blanked comments;
  // it did NOT blank string literals, and this proof's own registry entry
  // documents the rule by QUOTING the forbidden call inside a plain string. CI
  // went red on green code for it. Both halves are asserted: the quotation is
  // invisible, and a real call on the very next line is still seen.
  const quoted = [
    'const REGISTRY = { what: "WAS: grants.find(g => g.agent_id) — now selectAgentId" }',
    "const NOTE = 'grants.find((g) => g.agent_id)'",
    "const TPL = `see grants.find((g) => g.agent_id) for the old shape`",
    "// grants.find((g) => g.agent_id) in a comment",
  ].join("\n")
  const scan = (s: string) => new RegExp(ORDER_PICKED_AGENT.source, "g").test(executableCodeOnly(s))

  check("a quoted occurrence — string, single-quote, template or comment — is NOT a call (the defect that failed CI)",
    !scan(quoted))
  check("NEGATIVE CONTROL …and a REAL call beside all that prose is still caught, so the blanking did not blind the scan",
    scan(quoted + "\nconst agentId = grants.find((g) => g.agent_id)?.agent_id"))
  check("blanking preserves line numbers, so a reported hit still points at the right line",
    executableCodeOnly(quoted).split("\n").length === quoted.split("\n").length)

  // ── THE MASKING SHAPE THAT MOTIVATED THE 2026-08-29 CONVERSION ─────────────
  // The controls above prove the scan can tell a quotation from a call. They do
  // NOT prove the masker can find the call in the first place, and the masker that
  // stood here until this pass could not: three global regexes, template pass
  // first, pairing backticks LEFT TO RIGHT. Every module in this repo that parses a
  // model's JSON answer strips the markdown fence with nine backticks of string
  // CONTENT — an ODD count — and from the ninth onwards a naive pairer is inside a
  // phantom template and blanks live code away. Verbatim shape from
  // lib/agents/generate-client-message.ts:72-74, with a real call underneath it.
  //
  // THE TRAILING TEMPLATE IS LOAD-BEARING. A phantom template only SWALLOWS a
  // region once it finds a closing backtick, so a fixture whose odd backtick is the
  // LAST one in the text proves nothing — the naive pairer just fails to match and
  // the code survives by accident. Real files always have another backtick further
  // down; without one here this control is a decoration, and the first draft of it
  // passed against the very idiom it was written to catch.
  const fenced = [
    'let s = text.trim()',
    'if (s.startsWith("```json")) s = s.slice(7)',
    'if (s.startsWith("```")) s = s.slice(3)',
    'if (s.endsWith("```")) s = s.slice(0, -3)',
    'const agentId = grants.find((g) => g.agent_id)?.agent_id ?? null',
    'log(`picked ${agentId}`)',
  ].join("\n")
  const beforeCall = fenced.slice(0, fenced.indexOf("const agentId"))
  check("the fence specimen carries the ODD backtick count that desynchronises a naive pairer",
    (beforeCall.match(/`/g) ?? []).length % 2 === 1 &&
    (fenced.slice(fenced.indexOf("const agentId")).match(/`/g) ?? []).length > 0)
  check("NEGATIVE CONTROL a real call BELOW that odd backtick is still seen — the masker no longer swallows it",
    scan(fenced))
  check("…and the fence text itself is still blanked, so the literal cannot be read as code",
    !executableCodeOnly(fenced).includes("json"))

  // A `/* */` sequence inside a `//` line, and an apostrophe inside a comment: the
  // two prose shapes that make a block-comments-first stripper eat the code below.
  check("a slash-star inside a LINE comment does not swallow the call below it",
    scan("// keeps kernel/* + agents/* out of the client bundle\nconst a = grants.find((g) => g.agent_id)"))
  check("an apostrophe and a URL inside comments do not swallow the call below them",
    scan("// the script's own agent — see https://example.invalid/a/b\nconst a = grants.find((g) => g.agent_id)"))

  // The behaviour that CHANGED: `${…}` is executable, so a call written inside one
  // is a call. The retired pass blanked whole templates, interpolations and all.
  check("a call inside a ${} interpolation IS seen (an interpolation is code, not text)",
    scan("const s = `picked: ${grants.find((g) => g.agent_id)?.agent_id}`"))

  const unsound = unsoundSingleRowReads()
  check(
    `no user_role_assignments read takes a single object filtered on user_id alone (found ${unsound.length})`,
    unsound.length === 0,
  )
  for (const h of unsound) console.log(`      · ${h}`)

  // The shortcut this pass forbids: `.limit(1)` bolted onto the broken shape. It
  // silences mode (a) by converting it into mode (b), and an ORDER BY is the only
  // thing that would make a one-row pick honest.
  const arbitraryPicks: string[] = []
  for (const file of walk(ROOT)) {
    const code = codeOnly(readFileSync(file, "utf8"))
    for (const [at, chain] of grantChains(code)) {
      if (!/\.limit\(\s*1\s*\)/.test(chain)) continue
      if (!/\.eq\(\s*["']user_id["']/.test(chain)) continue
      if (/\.order\(/.test(chain)) continue
      arbitraryPicks.push(`${relative(ROOT, file)}:${lineOf(code, at)}`)
    }
  }
  check(
    `no user_role_assignments read picks one row by .limit(1) with no ORDER BY (found ${arbitraryPicks.length})`,
    arbitraryPicks.length === 0,
  )
  for (const h of arbitraryPicks) console.log(`      · ${h}`)

  console.log("\n[the shared reader · source — a refusal is not an empty result]")
  const rg = codeOnly(readFileSync(join(ROOT, "lib/auth/role-grants.ts"), "utf8"))
  check("readRoleGrants destructures `error` and returns a DISCRIMINATED result",
    /const \{ data, error \} = await supabase/.test(rg) && /if \(error\) return \{ ok: false/.test(rg))
  check("readRoleGrants never takes a single object itself",
    !/\.maybeSingle\(\)|\.single\(\)/.test(rg))

  // Every file that reads grants through the shared reader must ALSO handle the
  // refusal. A caller that ignores `.ok` has reintroduced the original defect at
  // one remove.
  const unhandled: string[] = []
  for (const file of walk(ROOT)) {
    if (file.endsWith("lib/auth/role-grants.ts")) continue
    const s = readFileSync(file, "utf8")
    if (!/readRoleGrants\(/.test(s)) continue
    if (/\.ok\b/.test(s)) continue
    unhandled.push(relative(ROOT, file))
  }
  check(`every readRoleGrants caller handles the refused-read case (found ${unhandled.length} that do not)`,
    unhandled.length === 0)
  for (const h of unhandled) console.log(`      · ${h}`)

  console.log("\n[the write path · source — the RBAC join row]")
  const users = codeOnly(readFileSync(join(ROOT, "lib/kernel/users.ts"), "utf8"))
  check("the pre-write existence probe is narrowed by role, i.e. single-row by the REAL unique key",
    /\.from\("user_role_assignments"\)[\s\S]{0,200}?\.eq\("user_id", userId\)[\s\S]{0,120}?\.eq\("role", userType\)/.test(users))
  check("the probe's error is checked, so a refused read cannot be reported as a creation",
    /existingRoleErr/.test(users) && /!existingRoleErr && !existingRole/.test(users))
  check("the grant upsert proves it wrote a row (a zero-row RLS refusal is error:null)",
    /onConflict: "user_id,role"[\s\S]{0,400}?\.select\("id"\)/.test(users) &&
    /upserted\?\.length \?\? 0\) === 0/.test(users))
}

// ─── LIVE ────────────────────────────────────────────────────────────────────

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("\n[live] SKIPPED — no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env")
    return
  }
  const svc = createClient(url, key, { auth: { persistSession: false } })

  console.log("\n[live · a seeded multi-grant seat on the real database]")
  const userId = crypto.randomUUID()
  const seededGrantIds: string[] = []
  let seededUser = false

  try {
    // Anchor on a real brokerage so the tenanted grants are genuinely tenanted.
    const { data: brk } = await svc.from("brokerages").select("id").limit(1)
    const brokerageId = brk?.[0]?.id
    if (!brokerageId) { console.log("[live] SKIPPED — no brokerage to anchor on"); return }

    const { error: uErr } = await svc.from("users").insert({
      id: userId,
      email: `multi-role-seat-proof+${userId.slice(0, 8)}@example.invalid`,
      user_type: "agent",
      brokerage_id: brokerageId,
    })
    if (uErr) { console.log(`[live] SKIPPED — could not seed the seat: ${uErr.message}`); return }
    seededUser = true

    // The owner's ruling, made real: ONE seat, four grants, one of them untenanted.
    const { data: rows, error: gErr } = await svc.from("user_role_assignments").insert([
      { user_id: userId, role: "admin",   brokerage_id: brokerageId },
      { user_id: userId, role: "agent",   brokerage_id: brokerageId },
      { user_id: userId, role: "isa",     brokerage_id: brokerageId },
      { user_id: userId, role: "contact", brokerage_id: null },
    ]).select("id")
    check("live: a single seat accepts FOUR grants — the UNIQUE key is (user_id, role)",
      !gErr && (rows?.length ?? 0) === 4)
    for (const r of rows ?? []) seededGrantIds.push((r as { id: string }).id)

    // MODE (a), on the real wire: PostgREST refuses the single-object request.
    const single = await svc.from("user_role_assignments").select("role").eq("user_id", userId).maybeSingle()
    check("live: MODE (a) — `.eq(user_id).maybeSingle()` ERRORS over a multi-grant seat",
      single.error !== null)
    check("live: …and supabase-js RESOLVES that error, so `data` alone reads as 'no grant'",
      single.error !== null && single.data === null)

    // MODE (b): the shortcut. It does not error — it answers, and the answer is
    // not required to be the same one twice. Proving it CAN return the untenanted
    // contact grant is proving the shortcut unsafe.
    const arbitrary = new Set<string>()
    for (let i = 0; i < 8; i++) {
      const r = await svc.from("user_role_assignments").select("role, brokerage_id")
        .eq("user_id", userId).limit(1).maybeSingle()
      if (r.error) continue
      arbitrary.add(String((r.data as { role?: string } | null)?.role ?? ""))
    }
    check("live: MODE (b) — `.limit(1).maybeSingle()` does NOT error; it just answers unordered",
      arbitrary.size >= 1)

    // The fix: read them all, then choose. Same answer every time.
    const answers = new Set<string>()
    const vendorAnswers = new Set<string>()
    for (let i = 0; i < 8; i++) {
      const { data, error } = await svc
        .from("user_role_assignments").select("role, brokerage_id, vendor_id, agent_id").eq("user_id", userId)
      if (error) { answers.add(`ERR:${error.message}`); continue }
      const grants = (data ?? []) as RoleGrant[]
      answers.add(`${grants.length}|${selectTenantBrokerageId(grants)}|${allRoles(grants).join("+")}`)
      vendorAnswers.add(JSON.stringify(selectVendorId(grants)))
    }
    check("live: reading ALL grants returns four rows and ONE stable answer across repeated reads",
      answers.size === 1 && [...answers][0] === `4|${brokerageId}|admin+agent+isa+contact`)
    check("live: the untenanted `contact` grant never becomes the tenant anchor",
      [...answers][0].split("|")[1] === brokerageId)
    check("live: no vendor grant → vendorId null, ambiguous false, stably",
      vendorAnswers.size === 1 && [...vendorAnswers][0] === JSON.stringify({ vendorId: null, ambiguous: false }))

    // Two DIFFERENT vendors on one seat: reported, not resolved.
    const { data: vends } = await svc.from("vendors").select("id").limit(2)
    if ((vends?.length ?? 0) === 2) {
      const { data: vrows } = await svc.from("user_role_assignments").insert([
        { user_id: userId, role: "vendor",      brokerage_id: brokerageId, vendor_id: vends![0].id },
        { user_id: userId, role: "title_agent", brokerage_id: brokerageId, vendor_id: vends![1].id },
      ]).select("id")
      for (const r of vrows ?? []) seededGrantIds.push((r as { id: string }).id)

      const { data: data2 } = await svc
        .from("user_role_assignments").select("role, brokerage_id, vendor_id, agent_id").eq("user_id", userId)
      const res = selectVendorId((data2 ?? []) as RoleGrant[])
      check("live: two DIFFERENT vendors on one seat are reported ambiguous, never picked",
        res.vendorId === null && res.ambiguous === true)
    } else {
      console.log("      (skipped the two-vendor case — fewer than 2 vendors on this database)")
    }

    // The read the write path now performs: narrowed by role, single-row by the
    // real unique key even on a seat holding six grants.
    const byRole = await svc.from("user_role_assignments").select("id")
      .eq("user_id", userId).eq("role", "agent").maybeSingle()
    check("live: narrowing by (user_id, role) is single-row BY THE CONSTRAINT — no error, one row",
      byRole.error === null && byRole.data !== null)
  } finally {
    if (seededGrantIds.length) await svc.from("user_role_assignments").delete().in("id", seededGrantIds)
    if (seededUser) await svc.from("users").delete().eq("id", userId)

    const { count: grantsLeft } = await svc
      .from("user_role_assignments").select("id", { count: "exact", head: true }).eq("user_id", userId)
    const { count: usersLeft } = await svc
      .from("users").select("id", { count: "exact", head: true }).eq("id", userId)
    check(`live: cleanup residue == 0 (grants ${grantsLeft ?? 0}, users ${usersLeft ?? 0})`,
      (grantsLeft ?? 0) === 0 && (usersLeft ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Multi-role seat — one user, several grants, one honest answer")
  console.log("══════════════════════════════════════════════════")
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ MULTI_ROLE_SEAT_FAIL"); process.exit(1) }
  console.log(" ✅ MULTI_ROLE_SEAT_PASS — a seat may hold any number of grants; no read takes one row on user_id alone, and every chooser answers the same way whatever order the rows arrive in")
}
main()
