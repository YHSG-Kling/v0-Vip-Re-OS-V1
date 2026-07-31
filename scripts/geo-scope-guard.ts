/**
 * scripts/geo-scope-guard.ts
 *
 * test:geo-scope — GEO IS FOR AGENTS, TEAMS AND BROKERAGES (owner rule).
 *
 * The AI-search citation rail was brokerage-scoped at every layer, and the cost
 * compounded downward:
 *
 *   · THE ROW could not say whose it was. Observations carried brokerage_id plus
 *     a page id — so no read could ask "how am I doing" or "how is my team
 *     doing", only "how is the company doing".
 *   · THE DETECTION never looked for the agent. The reel loop's own comment said
 *     "agent attribution for the brand targets" while `brands` carried the
 *     BROKERAGE name alone. An AI answer that named the agent — the single most
 *     valuable citation a real-estate agent can get — was recorded as
 *     `not_cited`. That is worse than incomplete: the score asserted a miss that
 *     never happened, and the GEO loop then optimised against a lie.
 *   · THE PAGE showed the company. An agent opened GEO to every reel in the
 *     brokerage, none identifiable as theirs, and no number they could move.
 *
 * This guard EXECUTES the scope resolver rather than pattern-matching a JSX
 * tree: the rule is a pure function precisely so it can be run.
 */
import { readFileSync, existsSync } from "node:fs"
import { allowedScopes, defaultScope, resolveScope, emptyScopeMessage } from "../lib/geo/citation-scope"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")
/** Comments stripped — an assertion must target CODE, never prose. */
const code = (p: string) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")

const BROK = "b0000000-0000-0000-0000-000000000001"
const MONITOR = "lib/kernel/ai-search-citation-monitor.ts"
const PAGE = "app/dashboard/marketing/seo/page.tsx"

console.log("\n═══ 1. The scope resolver offers only what the viewer HAS ═══")
{
  const soloAgent = allowedScopes({ role: "agent", agentId: "a1", teamId: null }, BROK)
  ok("an agent on NO team is offered exactly one scope: their own",
    soloAgent.length === 1 && soloAgent[0].scope === "agent",
    JSON.stringify(soloAgent.map((c) => c.scope)))
  ok("...and is NOT offered a team tab that would filter team_id = NULL and show\n    every unassigned page in the company",
    !soloAgent.some((c) => c.scope === "team"))
  ok("...nor a brokerage tab, which is not theirs to read",
    !soloAgent.some((c) => c.scope === "brokerage"))

  const teamAgent = allowedScopes({ role: "agent", agentId: "a1", teamId: "t1" }, BROK)
  ok("an agent ON a team gets Mine + My Team, most specific first",
    teamAgent.map((c) => c.scope).join(",") === "agent,team", JSON.stringify(teamAgent.map((c) => c.scope)))

  const lead = allowedScopes({ role: "team_lead", agentId: "a2", teamId: "t1" }, BROK)
  ok("a team lead gets all three — their own pages, their team, and the company\n    they report into",
    lead.map((c) => c.scope).join(",") === "agent,team,brokerage", JSON.stringify(lead.map((c) => c.scope)))

  const broker = allowedScopes({ role: "broker", agentId: null, teamId: null }, BROK)
  ok("a broker with no agent row is NOT offered \"Mine\" — there is no row to\n    filter on, and the tab would read every page with a null agent",
    broker.length === 1 && broker[0].scope === "brokerage", JSON.stringify(broker.map((c) => c.scope)))

  const orphan = allowedScopes({ role: "vendor", agentId: null, teamId: null }, BROK)
  ok("a viewer who is neither staff nor an agent still gets a coherent surface\n    (their tenant) rather than an empty switcher",
    orphan.length === 1 && orphan[0].scope === "brokerage")
}

console.log("\n═══ 2. Each scope carries its own filter, so no caller invents one ═══")
{
  const lead = allowedScopes({ role: "team_lead", agentId: "a2", teamId: "t1" }, BROK)
  const byScope = Object.fromEntries(lead.map((c) => [c.scope, c]))
  ok("agent scope filters agent_id with the viewer's agent id",
    byScope.agent.column === "agent_id" && byScope.agent.value === "a2")
  ok("team scope filters team_id with the viewer's team id",
    byScope.team.column === "team_id" && byScope.team.value === "t1")
  ok("brokerage scope filters brokerage_id with the tenant",
    byScope.brokerage.column === "brokerage_id" && byScope.brokerage.value === BROK)
}

console.log("\n═══ 3. A scope request can never widen the read ═══")
{
  const agent = allowedScopes({ role: "agent", agentId: "a1", teamId: null }, BROK)
  ok("an agent asking for ?scope=brokerage lands back on their own",
    resolveScope(agent, "brokerage", "agent").scope === "agent")
  ok("...and ?scope=team likewise, since they have no team",
    resolveScope(agent, "team", "agent").scope === "agent")
  ok("garbage degrades to the default rather than throwing or widening",
    resolveScope(agent, "'; drop table--", "agent").scope === "agent")
  ok("an absent scope param picks the default",
    resolveScope(agent, null, "agent").scope === "agent")
}

console.log("\n═══ 4. Defaults land on the number the viewer can move ═══")
{
  const agent = allowedScopes({ role: "agent", agentId: "a1", teamId: "t1" }, BROK)
  ok("an agent opens on THEIR OWN geo, not a company aggregate they cannot\n    influence",
    defaultScope(agent, "agent") === "agent")
  const broker = allowedScopes({ role: "broker", agentId: "a9", teamId: "t1" }, BROK)
  ok("a broker opens on the brokerage — the scope they are accountable for —\n    even though they also hold the narrower ones",
    defaultScope(broker, "broker") === "brokerage")
  ok("every scope has its own empty-state sentence: 'you published nothing\n    citable yet' is a different fact from 'the company has no data'",
    new Set(["agent", "team", "brokerage"].map((s) => emptyScopeMessage(s as any))).size === 3)
}

console.log("\n═══ 5. The observation row knows whose it is ═══")
{
  const m = code(MONITOR)
  ok("the reel pass selects the page's agent", /select\("id, title, listing_id, public_slug, published_at, agent_id"\)/.test(m))
  ok("the landing pass selects the page's agent", /select\("id, name, slug, landing_content, agent_id"\)/.test(m))
  ok("both passes resolve the owner ONCE per pass, not once per page —\n    a per-page read would multiply the query count by the page count",
    (m.match(/await loadPageOwners\(/g) ?? []).length === 2)
  // THE TRAP THIS CATCHES. ai_video_projects.agent_id FKs USERS;
  // lead_capture_forms.agent_id FKs AGENTS — the same column name, two identity
  // classes. The observation's agent_id FKs agents, so stamping either source
  // column straight through would raise a foreign-key violation on every reel
  // write. Found by inserting a real row against the live schema, not by
  // reading the column name and trusting it.
  ok("the reel pass declares its ids are USERS-class",
    /loadPageOwners\(supabase, pages\.map\(\(p\) => p\.agent_id \?\? ""\), "users", brokerageId\)/.test(m), MONITOR)
  ok("the landing pass declares its ids are AGENTS-class",
    /loadPageOwners\(supabase, pages\.map\(\(p\) => p\.agent_id \?\? ""\), "agents", brokerageId\)/.test(m), MONITOR)
  ok("both upserts stamp the CANONICAL agents.id, never the raw source column",
    (m.match(/agent_id:\s+owner\?\.agentId \?\? null/g) ?? []).length === 2 &&
    !/agent_id:\s+page\.agent_id/.test(m))
  ok("...and team alongside it", (m.match(/team_id:\s+owner\?\.teamId \?\? null/g) ?? []).length === 2)
  ok("the owner lookup is TENANT-SCOPED — an id that somehow crossed tenants\n    would otherwise stamp a stranger's name and team onto our observation",
    /\.eq\("brokerage_id", brokerageId\)\s*\n\s*\.in\(keyColumn, unique\)/.test(m), MONITOR)
  ok("team is stamped from the agent's row AS OF the observation, so an agent\n    changing teams does not rewrite last quarter's GEO history",
    // The resolver's field is `teamId` (camelCase, the PageOwner shape); the
    // COLUMN is team_id. Asserting the column name here matched nothing —
    // pattern wrong, code right, same trap as before.
    /teamId: r\.team_id \?\? null/.test(m))
}

console.log("\n═══ 6. Detection finally looks for the AGENT'S name ═══")
{
  const m = code(MONITOR)
  ok("both detection targets carry the brokerage brand AND the agent's own name",
    (m.match(/brands:\s+\[brandName, owner\?\.name \?\? null\]/g) ?? []).length === 2, MONITOR)
  ok("...the brokerage brand is KEPT, since a brokerage-level page has no agent\n    and an answer naming the company is still a real citation",
    /\[brandName, owner\?\.name/.test(m))
  ok("no target is built from the brokerage name alone any more",
    !/brands:\s+\[brandName\]\.filter/.test(m), MONITOR)
  ok("the stale comment that CLAIMED agent attribution was already happening is\n    corrected rather than left to mislead the next reader",
    !/agent attribution for the brand targets\./.test(src(MONITOR)) &&
    /this comment used to claim it/.test(src(MONITOR)))
}

console.log("\n═══ 7. The page is wired to the resolver, and the tenant filter survives ═══")
{
  const p = code(PAGE)
  ok("the GEO tab resolves its scopes through lib/geo/citation-scope",
    /allowedScopes\(\{ role: userType, agentId, teamId \}, brokerageId\)/.test(p), PAGE)
  ok("...and honours the ?scope param through resolveScope",
    /resolveScope\(choices, requestedScope, userType\)/.test(p))
  ok("the brokerage filter ALWAYS applies — the scope filter narrows within the\n    tenant and never replaces it",
    /\.eq\("brokerage_id", brokerageId\)/.test(p) &&
    /if \(active\.column !== "brokerage_id" && active\.value\)/.test(p))
  ok("the switcher only renders when there is a real choice to make",
    /choices\.length > 1 \?/.test(p))
  ok("the empty state is scope-specific rather than one generic sentence",
    /emptyScopeMessage\(active\.scope/.test(p))
}

console.log("\n═══ 8. The schema carries the scope, with a covered read ═══")
{
  const mig = src("supabase/migrations/m335-geo-agent-team-scope.sql")
  ok("m335 adds agent_id + team_id to BOTH observation tables",
    (mig.match(/ADD COLUMN IF NOT EXISTS agent_id/g) ?? []).length === 2 &&
    (mig.match(/ADD COLUMN IF NOT EXISTS team_id/g) ?? []).length === 2)
  ok("...both are NULLABLE, because a brokerage-level page genuinely has no\n    agent and NULL is the honest value rather than an invented placeholder",
    !/agent_id uuid NOT NULL/.test(mig) && !/team_id uuid NOT NULL/.test(mig))
  ok("...and each scope has an index, so the narrow read is not a table scan",
    (mig.match(/CREATE INDEX IF NOT EXISTS/g) ?? []).length === 4)
  ok("the schema snapshot lists the new columns, so drift detection agrees",
    /"agent_id"[\s\S]{0,400}ai_search_citation_observations|ai_search_citation_observations: \[[^\]]*"agent_id"/.test(
      src("scripts/schema-snapshot.ts")))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`GEO SCOPE — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nGEO is for agents, teams and brokerages. An observation that knows only")
  console.log("its tenant can answer only the brokerage's question.")
  process.exit(1)
}
console.log("Every citation knows whose it is, and every viewer sees the scope they can move.")
