/**
 * scripts/lifetime-ledger-guard.ts
 *
 * test:lifetime-ledger — AN APPEND-ONLY LEDGER IS READ AS STATE, NOT AS HISTORY.
 *
 * lifetime_customer_npv_scores is a LEDGER by design: scoreContactNpv INSERTs a
 * row per run and carries previous_score / score_delta, so a relationship's value
 * over time is kept on purpose. That makes one rule mandatory for every reader —
 * THE CURRENT VALUE IS THE NEWEST ROW PER CONTACT — and it was written out by
 * hand in three places and missed in a fourth.
 *
 * The fourth was the income engine's Rule 4, which puts sphere-nurture actions on
 * an agent's queue with a dollar figure attached:
 *
 *     .order("npv_dollars", { ascending: false }).limit(10)
 *
 * Ranking an append-only ledger by VALUE reads history as if it were state, and
 * fails three ways at once: the same contact appears once per historical row, so
 * the agent gets the same action repeatedly; each contact is picked at their
 * HISTORIC PEAK rather than their current standing, carrying a stale figure into
 * estimated_gci_impact_cents; and because the limit counts ROWS, one
 * well-scored contact's history can consume the whole rule and hide every other
 * client who is genuinely due.
 *
 * The rule now has ONE implementation (lib/lifetime-customer-npv/current.ts) and
 * this guard keeps it that way.
 */
import { readFileSync } from "node:fs"
import { latestByContact, isNewestFirst, topByValue } from "../lib/lifetime-customer-npv/current"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(p, "utf8")
/** Comments stripped — an assertion must target CODE, never prose. */
const code = (p: string) =>
  stripComments(src(p))

console.log("\n═══ 1. latestByContact keeps the newest and drops the history ═══")
{
  const ledger = [
    { contact_id: "a", npv_dollars: 20_000, computed_at: "2026-07-01T00:00:00Z" },
    { contact_id: "b", npv_dollars: 50_000, computed_at: "2026-06-01T00:00:00Z" },
    { contact_id: "a", npv_dollars: 90_000, computed_at: "2026-01-01T00:00:00Z" },
    { contact_id: "a", npv_dollars: 60_000, computed_at: "2025-10-01T00:00:00Z" },
  ]
  const current = latestByContact(ledger)
  ok("one row per contact", current.length === 2)
  ok("...and it is the NEWEST row, not the biggest",
    current.find((r) => r.contact_id === "a")?.npv_dollars === 20_000,
    String(current.find((r) => r.contact_id === "a")?.npv_dollars))
  ok("a contact whose value COLLAPSED reports the collapse, not the peak —\n    this is the whole point; the old code reported $90,000 forever",
    current.find((r) => r.contact_id === "a")?.npv_dollars !== 90_000)
  ok("order of first appearance is preserved", current[0].contact_id === "a")
  ok("an empty ledger is empty, not a crash", latestByContact([]).length === 0)
  ok("rows with no contact_id are skipped rather than keyed on undefined",
    latestByContact([{ contact_id: "" } as any, { contact_id: "z" }]).length === 1)
}

console.log("\n═══ 2. The precondition is checkable ═══")
{
  ok("newest-first is recognised", isNewestFirst([
    { contact_id: "a", computed_at: "2026-07-01T00:00:00Z" },
    { contact_id: "b", computed_at: "2026-06-01T00:00:00Z" },
  ]))
  ok("oldest-first is REJECTED — deduping an unordered set would silently keep\n    the wrong row", !isNewestFirst([
    { contact_id: "a", computed_at: "2026-01-01T00:00:00Z" },
    { contact_id: "b", computed_at: "2026-06-01T00:00:00Z" },
  ]))
  ok("rows missing computed_at do not fail the check", isNewestFirst([{ contact_id: "a" }, { contact_id: "b" }]))
}

console.log("\n═══ 3. topByValue dedupes BEFORE it ranks ═══")
{
  // The exact defect: contact 'a' has a huge historical row. Rank-then-limit
  // puts 'a' at the top three times over and starves everyone else.
  const ledger = [
    { contact_id: "a", npv_dollars: 10_000, computed_at: "2026-07-01T00:00:00Z" },
    { contact_id: "a", npv_dollars: 99_000, computed_at: "2026-05-01T00:00:00Z" },
    { contact_id: "a", npv_dollars: 98_000, computed_at: "2026-04-01T00:00:00Z" },
    { contact_id: "b", npv_dollars: 40_000, computed_at: "2026-07-01T00:00:00Z" },
  ]
  const top = topByValue(ledger, 2)
  ok("no contact appears twice", new Set(top.map((r) => r.contact_id)).size === top.length)
  ok("the CURRENT leader wins, not the historic peak",
    top[0].contact_id === "b" && top[0].npv_dollars === 40_000,
    JSON.stringify(top[0]))
  ok("...and the collapsed contact ranks below at its real value",
    top[1].contact_id === "a" && top[1].npv_dollars === 10_000)
  ok("the limit counts CONTACTS, not ledger rows — history cannot starve the\n    list", top.length === 2)
  ok("a limit of 0 returns nothing rather than everything", topByValue(ledger, 0).length === 0)
}

console.log("\n═══ 4. Every reader uses the one implementation ═══")
{
  const sites: Array<[string, string]> = [
    ["lib/income-engine/action-recommender.ts", "income engine Rule 4 (the one that was wrong)"],
    ["lib/agent-action-queue/composer.ts", "agent action queue"],
    ["lib/lifetime-customer-npv/scorer.ts", "sphere-contribution rollup"],
    ["app/actions/lifetime-npv.ts", "the /lifetime-customers panel"],
  ]
  for (const [path, label] of sites) {
    const s = code(path)
    ok(`${label} imports the shared rule`,
      /from "(@\/lib\/lifetime-customer-npv\/current|\.\/current)"/.test(s), path)
  }

  // Nobody may hand-roll it again.
  for (const [path, label] of sites) {
    const s = code(path)
    ok(`${label} no longer builds its own newest-per-contact map`,
      !/new Map<string,[^>]*>\(\)[\s\S]{0,200}if \(!?\w*[Ll]atest\w*\.has\(/.test(s))
  }
}

console.log("\n═══ 5. Nobody ranks the raw ledger by value again ═══")
{
  // The signature of the original defect: ordering lifetime_customer_npv_scores
  // by npv_dollars in the QUERY, which can only ever rank history.
  const readers = [
    "lib/income-engine/action-recommender.ts", "lib/agent-action-queue/composer.ts",
    "lib/lifetime-customer-npv/scorer.ts", "app/actions/lifetime-npv.ts",
    "lib/lifetime-customer-npv/current.ts",
  ]
  const offenders = readers.filter((p) =>
    /from\("lifetime_customer_npv_scores"\)[\s\S]{0,600}?\.order\("npv_dollars"/.test(code(p)))
  ok("no query orders the ledger by npv_dollars — ranking must happen AFTER the\n    dedupe, in topByValue",
    offenders.length === 0, offenders.join(", "))

  const cur = code("lib/lifetime-customer-npv/current.ts")
  ok("the shared loader orders by computed_at", cur.includes('.order("computed_at", { ascending: false })'))
  ok("...and returns already-deduped rows", /return latestByContact\(/.test(cur))
  ok("...and scopes by brokerage when the caller has it — an agent id is not a\n    tenant boundary", cur.includes('query.eq("brokerage_id"'))
  ok("...and never throws, because every consumer is an additive surface",
    /catch \{[\s\S]{0,40}return \[\]/.test(cur))
}

console.log("\n═══ 6. The ledger really is append-only (so the rule is required) ═══")
{
  const scorer = code("lib/lifetime-customer-npv/scorer.ts")
  ok("scoreContactNpv INSERTs rather than upserting — history is deliberate",
    /from\("lifetime_customer_npv_scores"\)\s*\.insert\(/.test(scorer.replace(/\s+/g, " ").replace(/ \./g, "."))
    || scorer.includes('from("lifetime_customer_npv_scores").insert('))
  ok("...and records the previous score so a delta is meaningful",
    scorer.includes("previous_score") && scorer.includes("score_delta"))
}

console.log("\n═══ 7. The LIVE rows, through the shipped functions ═══")
{
  // Exactly what the production query returned for a test agent with a real
  // ledger history — a contact who peaked at $99,000 in January and collapsed
  // to $10,000 by July, alongside a steady one. Captured, asserted, deleted.
  const LIVE = [
    { contact_id: "a0000320-...-0002", npv_dollars: 40000, tier: "gold",     recommended_action: "Annual equity review", computed_at: "2026-07-25T00:00:00+00:00" },
    { contact_id: "a0000320-...-0001", npv_dollars: 10000, tier: "silver",   recommended_action: "Reactivation",         computed_at: "2026-07-25T00:00:00+00:00" },
    { contact_id: "a0000320-...-0001", npv_dollars: 98000, tier: "platinum", recommended_action: "Quarterly check-in",   computed_at: "2026-04-15T00:00:00+00:00" },
    { contact_id: "a0000320-...-0001", npv_dollars: 99000, tier: "platinum", recommended_action: "Quarterly check-in",   computed_at: "2026-01-15T00:00:00+00:00" },
  ]
  ok("the ledger query really does arrive newest-first", isNewestFirst(LIVE))

  const current = topByValue(LIVE, 10)
  ok("four ledger rows collapse to two contacts", current.length === 2)
  ok("the collapsed contact appears ONCE — the old code queued her three times",
    current.filter((r) => r.contact_id.endsWith("0001")).length === 1)
  ok("the genuinely-highest CURRENT client ranks first",
    current[0].contact_id.endsWith("0002") && current[0].npv_dollars === 40000)
  ok("...and the collapsed one reports $10,000, not her $99,000 January peak",
    current[1].npv_dollars === 10000)
  ok("...at her current SILVER tier and current action, not the stale platinum\n    'Quarterly check-in'",
    current[1].tier === "silver" && current[1].recommended_action === "Reactivation")

  // estimated_gci_impact_cents = npv_dollars * 100 / 12 (the monthly slice the
  // recommender attaches to the action).
  const oldTop = Math.round(99000 * 100 / 12), newTop = Math.round(current[1].npv_dollars * 100 / 12)
  ok(`the dollar figure on the agent's action drops from $${Math.round(oldTop / 100)}/mo to\n    $${Math.round(newTop / 100)}/mo — the old one was a ten-fold overstatement`,
    newTop < oldTop / 5)
}

console.log("\n═══ 8. Rule 4 is given the id class the ledger actually keys on ═══")
{
  // FLIPPED BY m366. lifetime_customer_npv_scores.agent_id USED to FK users(id)
  // while contacts, transactions and listings all FK agents(id) — Rule 4 was passed
  // the agents.id, matched ZERO rows, and the sphere-nurture action had never once
  // reached an agent's queue. The fix then was to pass the USERS id. m366 re-pointed
  // the ledger column at agents(id), which makes that fix the new zero-match: the
  // scorer writes contacts.agent_id (agents-class) and this reader must filter on
  // the same class or Rule 4 goes silent again, in exactly the way it did before.
  const rec = code("lib/income-engine/action-recommender.ts")
  ok("the recommender takes BOTH ids", /agentUserId:\s*string/.test(rec) && /agentId:\s*string/.test(rec))
  ok("...and the ledger query uses the AGENTS one, matching what the scorer writes",
    /agentId: params\.agentId/.test(rec) && !/agentId: params\.agentUserId/.test(rec))
  const caller = code("app/actions/income-engine.ts")
  ok("the caller passes the resolved user id", /agentUserId: userId/.test(caller))
  ok("...which it resolves from agents.user_id", /from\("agents"\)[\s\S]{0,80}select\("user_id"\)/.test(caller))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`LIFETIME LEDGER — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nReading lifetime_customer_npv_scores? Use loadCurrentLedger/latestByContact.")
  console.log("It is append-only: ordering it by value ranks history, not clients.")
  process.exit(1)
}
console.log("The lifetime ledger is read as current state everywhere it is read.")
