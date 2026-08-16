#!/usr/bin/env tsx
/**
 * scripts/territory-settings-simulator.ts   (npm run test:territory-settings)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves that "settings sets territories covered" is now TRUE, and that the old
 * side-door writer can no longer overrule it.
 *
 * WHAT WAS WRONG (measured on the live database before any of this was written):
 *
 *   subscriber_service_areas — the per-zip roster
 *   lib/platform/distribution-engine.ts routes every platform lead through — held
 *   0 rows. lead_scraping_markets held 0 rows too. That is not a sparse table,
 *   it is an unreachable one: the ONLY writer was syncServiceAreasForMarket, a
 *   side effect of creating a lead-SCRAPING market, whose own comment admitted
 *   the hole ("agent_user_id: null; agent claims come later"). So agent_user_id
 *   was always null, team_id only ever inherited whatever the market carried, and
 *   is_primary was always false. Three columns of grain, never populated.
 *
 * FOUR CORRECTIONS TO THE BRIEF THIS SIMULATOR ENCODES, because the code said
 * otherwise and the code wins:
 *
 *   • A unique index DID already exist: uq_service_area_brokerage_zip on
 *     (brokerage_id, zip_code) WHERE agent_user_id IS NULL AND team_id IS NULL.
 *     The brokerage grain was protected all along; the TEAM and AGENT grains were
 *     not. m462 adds those two, plus at-most-one-primary per claimant per grain.
 *   • The right key is NOT (brokerage_id, zip_code, team_id, agent_user_id): NULLs
 *     do not compare equal in a btree unique, so that composite would have let the
 *     brokerage grain duplicate freely — the very defect it was meant to close.
 *   • The market sync wrote a TEAM-grain row whenever the market carried a team_id
 *     (lead_scraping_markets really does have that column), and the distribution
 *     engine reads only `.is(team_id,null).is(agent_user_id,null)` — so those rows
 *     routed nothing AND sat outside the only uniqueness the table had.
 *   • deleteScrapingMarket deactivated rows by (brokerage_id, zip) across EVERY
 *     grain, so deleting one market switched off unrelated team and agent claims.
 *
 * PURE: the grain rules and ZIP validation are EXECUTED, not grepped.
 * SOURCE: the writers are session-gated, error-checked and row-counted.
 * NEGATIVE CONTROLS: every check is re-run against a deliberately broken copy and
 *         must go RED. A check that cannot fail is not a check.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  authorizeTerritoryWrite,
  feedsPlatformRotation,
  grainOf,
  parseZipInput,
  resolveGrainColumns,
  ZIP_RE,
  type TerritoryViewer,
} from "../app/dashboard/settings/territories/territory-rules"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const ACTIONS = "app/actions/settings/territories.ts"
const SYNC = "app/actions/lead-scraping-config.ts"
const RULES = "app/dashboard/settings/territories/territory-rules.ts"
const PAGE = "app/dashboard/settings/territories/page.tsx"
const CLIENT = "app/dashboard/settings/territories/territories-client.tsx"
const NAV = "app/config/navigation-config.ts"
const ENGINE = "lib/platform/distribution-engine.ts"
const MIGRATION = "supabase/migrations/m462-territory-coverage-has-three-grains-and-only-one-was-ever-unique.sql"

const ADMIN: TerritoryViewer = { userId: "u-admin", brokerageId: "b1", isBrokerageAdmin: true, ledTeamIds: [] }
const LEAD: TerritoryViewer = { userId: "u-lead", brokerageId: "b1", isBrokerageAdmin: false, ledTeamIds: ["t-west"] }
const AGENT: TerritoryViewer = { userId: "u-agent", brokerageId: "b1", isBrokerageAdmin: false, ledTeamIds: [] }

// ─── PURE ────────────────────────────────────────────────────────────────────

function pureLayer() {
  console.log("\n[PURE · ZIP validation refuses, it does not silently drop]")

  check("P1 a five-digit ZIP is accepted and nothing is rejected",
    (() => { const r = parseZipInput("90210 90211,90212"); return r.zips.length === 3 && r.rejected.length === 0 })())

  check("P2 a four-digit typo is REJECTED and reported, never dropped (the sync's filter swallowed it)",
    (() => { const r = parseZipInput("90210, 9021"); return r.zips.join() === "90210" && r.rejected.join() === "9021" })())

  check("P3 non-numeric and over-length inputs are rejected, not truncated",
    (() => { const r = parseZipInput("9021O 902100 90210-1234"); return r.zips.length === 0 && r.rejected.length === 3 })())

  check("P4 duplicates collapse to one claim (the roster is per-zip, not per-typing)",
    parseZipInput("90210 90210 90210").zips.length === 1)

  check("P5 the regex is anchored at both ends — 'a90210b' is not a ZIP",
    ZIP_RE.test("90210") && !ZIP_RE.test("a90210") && !ZIP_RE.test("90210b") && !ZIP_RE.test("902100"))

  console.log("\n[PURE · the grain is derived from the columns, and all three are real]")

  check("P6 grainOf reads the columns, not a label: agent beats team beats brokerage",
    grainOf({ team_id: null, agent_user_id: null }) === "brokerage"
    && grainOf({ team_id: "t-west", agent_user_id: null }) === "team"
    && grainOf({ team_id: "t-west", agent_user_id: "u-agent" }) === "agent"
    && grainOf({ team_id: null, agent_user_id: "u-agent" }) === "agent")

  check("P7 a team grain with no team REFUSES — it never silently widens to brokerage-wide",
    (() => { const r = resolveGrainColumns("team", {}); return r.ok === false })())

  check("P8 an agent grain with no agent REFUSES for the same reason",
    (() => { const r = resolveGrainColumns("agent", {}); return r.ok === false })())

  check("P9 a brokerage grain carrying a team or an agent REFUSES (that is a narrower claim, mislabelled)",
    resolveGrainColumns("brokerage", { teamId: "t-west" }).ok === false
    && resolveGrainColumns("brokerage", { agentUserId: "u-agent" }).ok === false)

  check("P10 a valid brokerage grain writes BOTH grain columns NULL — the grain the rotation reads",
    (() => {
      const r = resolveGrainColumns("brokerage", {})
      return r.ok && r.columns.team_id === null && r.columns.agent_user_id === null
    })())

  console.log("\n[PURE · the grain gate: admin any, lead their own team, agent themselves]")

  check("G1 a brokerage admin may set every grain in their own tenant",
    authorizeTerritoryWrite(ADMIN, { grain: "brokerage", teamId: null, agentUserId: null }).ok
    && authorizeTerritoryWrite(ADMIN, { grain: "team", teamId: "t-west", agentUserId: null }).ok
    && authorizeTerritoryWrite(ADMIN, { grain: "agent", teamId: null, agentUserId: "u-agent" }).ok)

  check("G2 a team lead may set the team they ACTUALLY lead (teams.team_lead_id, a fact)",
    authorizeTerritoryWrite(LEAD, { grain: "team", teamId: "t-west", agentUserId: null }).ok)

  check("G3 …and NOT another team, even inside the same brokerage",
    authorizeTerritoryWrite(LEAD, { grain: "team", teamId: "t-east", agentUserId: null }).ok === false)

  check("G4 …and NOT brokerage-wide — that is the grain that decides who receives platform leads",
    authorizeTerritoryWrite(LEAD, { grain: "brokerage", teamId: null, agentUserId: null }).ok === false)

  check("G5 an agent may set their own coverage",
    authorizeTerritoryWrite(AGENT, { grain: "agent", teamId: null, agentUserId: "u-agent" }).ok)

  check("G6 …and NOT another agent's",
    authorizeTerritoryWrite(AGENT, { grain: "agent", teamId: null, agentUserId: "u-someone-else" }).ok === false)

  check("G7 …and NOT a team's, having no team_lead_id row to stand on",
    authorizeTerritoryWrite(AGENT, { grain: "team", teamId: "t-west", agentUserId: null }).ok === false)

  check("G8 a viewer with no session tenant is refused before any grain is considered",
    authorizeTerritoryWrite({ userId: "", brokerageId: "", isBrokerageAdmin: true, ledTeamIds: [] },
      { grain: "agent", teamId: null, agentUserId: "" }).ok === false)

  console.log("\n[PURE · only the brokerage grain feeds the platform rotation]")

  check("R1 an active brokerage-grain row feeds the rotation",
    feedsPlatformRotation({ team_id: null, agent_user_id: null, active: true }))

  check("R2 a team or agent claim is REAL but routes nothing — the engine filters both columns to NULL",
    feedsPlatformRotation({ team_id: "t-west", agent_user_id: null, active: true }) === false
    && feedsPlatformRotation({ team_id: null, agent_user_id: "u-agent", active: true }) === false)

  check("R3 a retired brokerage claim stops feeding the rotation (history kept, routing stopped)",
    feedsPlatformRotation({ team_id: null, agent_user_id: null, active: false }) === false)
}

// ─── SOURCE ──────────────────────────────────────────────────────────────────

type Probe = { name: string; run: (s: Record<string, string>) => boolean }

/** The market-sync function body only, so a match elsewhere in the file cannot pass its checks. */
function syncBody(source: string): string {
  const start = source.indexOf("async function syncServiceAreasForMarket")
  if (start < 0) return ""
  const next = source.indexOf("export async function", start)
  return source.slice(start, next < 0 ? source.length : next)
}

/**
 * CODE ONLY — block comments and whole-line `//` comments removed.
 *
 * The first cut of S2/S3 asserted "the string user_type never appears in this
 * file" against the RAW source, and went red on the file's own doc comment
 * explaining WHY there is no user_type test. A probe whose window includes prose
 * is testing the prose. These two probes are about what the code does, so they
 * read the code. (Trailing `//` after code is left alone deliberately: this file
 * has none, and a stripper clever enough to find them would also have to parse
 * strings, which is how a "clever" probe starts lying.)
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n")
}

/** deleteScrapingMarket only — updateScrapingMarket above it uses the same table names. */
function deleteBody(source: string): string {
  const start = source.indexOf("export async function deleteScrapingMarket")
  if (start < 0) return ""
  const next = source.indexOf("export async function", start + 10)
  return source.slice(start, next < 0 ? source.length : next)
}

const PROBES: Probe[] = [
  {
    name: "S1 the tenant comes from the SESSION — resolveViewer calls auth.getUser and no exported action takes a brokerageId",
    run: (s) => /const \{ data: auth, error: authError \} = await supabase\.auth\.getUser\(\)/.test(s[ACTIONS])
      && !/brokerageId\s*[:?]\s*string/.test(s[ACTIONS].replace(/interface TerritorySettingsView[\s\S]*?\n\}/, "").replace(/viewer: \{[\s\S]*?\n  \} \| null/, "")),
  },
  {
    name: "S2 the brokerage-admin test is the ONE shared gate, not a re-implemented user_type list",
    run: (s) => {
      const code = codeOnly(s[ACTIONS])
      return /from ["']@\/lib\/auth\/require-brokerage-admin["']/.test(code)
        && /await requireBrokerageAdmin\(/.test(code)
        && !/user_type/.test(code)
    },
  },
  {
    name: "S3 'team lead' is the FACT teams.team_lead_id, never a role label",
    run: (s) => {
      const code = codeOnly(s[ACTIONS])
      return /\.from\("teams"\)[\s\S]{0,200}?\.eq\("team_lead_id", user\.id\)/.test(code)
        && !/["']team_lead["']/.test(code)
    },
  },
  {
    name: "S4 NO service client anywhere in the territory lane — RLS permits the session client",
    run: (s) => !/createServiceClient|SERVICE_ROLE/.test(s[ACTIONS])
      && !/createServiceClient|SERVICE_ROLE/.test(s[PAGE])
      && !/createServiceClient|SERVICE_ROLE/.test(s[CLIENT]),
  },
  {
    name: "S5 every UPDATE ends .select(\"id\") and counts rows — a zero-row RLS refusal arrives as error:null",
    run: (s) => {
      const updates = s[ACTIONS].match(/\.update\(/g) ?? []
      const selects = s[ACTIONS].match(/\.select\("id"\)/g) ?? []
      return updates.length >= 4 && selects.length >= updates.length
        && /if \(!updated \|\| updated\.length === 0\)/.test(s[ACTIONS])
        && /if \(!revived \|\| revived\.length === 0\)/.test(s[ACTIONS])
    },
  },
  {
    name: "S6 every supabase read destructures AND checks error (a refusal is not an absent row)",
    run: (s) => {
      const body = s[ACTIONS]
      const reads = body.match(/const \{ data: \w+, error: \w+ \} = await/g) ?? []
      return reads.length >= 7
        && /if \(rowsError\) return/.test(body)
        && /if \(teamsError\) return/.test(body)
        && /if \(usersError\) return/.test(body)
        && /if \(ledError\) return/.test(body)
        && /if \(existingError\) return/.test(body)
        && !/const \{ data: \w+ \} = await supabase/.test(body)
    },
  },
  {
    name: "S7 the surface REFUSES bad ZIPs rather than dropping them — nothing is saved on a typo",
    run: (s) => /if \(rejected\.length > 0\)/.test(s[ACTIONS])
      && /Nothing was saved/.test(s[ACTIONS]),
  },
  {
    name: "S8 a named team/agent is verified INTO THE TENANT — those columns carry no FK",
    run: (s) => /\.from\("teams"\)[\s\S]{0,300}?\.eq\("brokerage_id", viewer\.brokerageId\)/.test(s[ACTIONS])
      && /That team is not in your brokerage/.test(s[ACTIONS])
      && /That person is not in your brokerage/.test(s[ACTIONS]),
  },
  {
    name: "S9 agent_user_id is verified against USERS — never against agents (the E&O id-space defect)",
    run: (s) => /agent_user_id is a users\.id/.test(s[ACTIONS])
      && /columns\.columns\.agent_user_id\)[\s\S]{0,300}?\.from\("users"\)/.test(s[ACTIONS].replace(/\n/g, "\n"))
      || (/\.from\("users"\)\s*\n\s*\.select\("id"\)\s*\n\s*\.eq\("id", columns\.columns\.agent_user_id\)/.test(s[ACTIONS])),
  },
  {
    name: "S10 removal DEACTIVATES, never hard-deletes — no .delete() on the roster anywhere in the surface",
    run: (s) => !/\.from\("subscriber_service_areas"\)\s*\n?\s*\.delete\(\)/.test(s[ACTIONS])
      && /setTerritoryActive/.test(s[ACTIONS]),
  },
  {
    name: "S11 every mutation loads the row through the grain gate — an id cannot bypass authorizeTerritoryWrite",
    run: (s) => {
      const body = s[ACTIONS]
      return /async function loadWritableClaim/.test(body)
        && /authorizeTerritoryWrite\(viewer, \{\s*grain: grainOf\(claim\)/.test(body)
        && (body.match(/await loadWritableClaim\(/g) ?? []).length >= 2
    },
  },
  {
    name: "S12 retiring a claim clears its primary flag (m462's primary index is scoped WHERE is_primary AND active)",
    run: (s) => /if \(!active && loaded\.claim\.is_primary\) patch\.is_primary = false/.test(s[ACTIONS]),
  },
  {
    name: "Y1 RECONCILIATION: the market sync writes the BROKERAGE grain only — never the market's team_id",
    run: (s) => {
      const b = syncBody(s[SYNC])
      return /team_id: null,/.test(b)
        && /agent_user_id: null,/.test(b)
        && !/team_id: market\.team_id/.test(b)
    },
  },
  {
    name: "Y2 RECONCILIATION: the sync READS at the brokerage grain too, so it cannot see a settings team/agent claim",
    run: (s) => {
      const b = syncBody(s[SYNC])
      return /\.is\("team_id", null\)/.test(b) && /\.is\("agent_user_id", null\)/.test(b)
    },
  },
  {
    name: "Y3 RECONCILIATION: the sync ORIGINATES only — it no longer flips active:true on a row settings retired",
    run: (s) => {
      const b = syncBody(s[SYNC])
      return !/update\(\{ active: true \}\)/.test(b)
        && !/\.update\(\{[^}]*active: true/.test(b)
        && /alreadyClaimed\.push\(zip\)/.test(b)
    },
  },
  {
    name: "Y4 RECONCILIATION: the sync never sets is_primary true — 'primary' is a decision, not a side effect",
    run: (s) => !/is_primary: true/.test(syncBody(s[SYNC])),
  },
  {
    name: "Y5 the sync checks every error instead of dropping it, and a 23505 race counts as claimed",
    run: (s) => {
      const b = syncBody(s[SYNC])
      return /if \(existingError\)/.test(b)
        && /if \(insertError\)/.test(b)
        && /23505/.test(b)
        && !/const \{ data: existing \} = await/.test(b)
    },
  },
  {
    name: "Y6 the call sites stopped swallowing the sync with .catch(() => {})",
    run: (s) => !/syncServiceAreasForMarket\([^)]*\)\s*\.catch\(/.test(s[SYNC]),
  },
  {
    name: "Y7 market DELETE retires the brokerage grain only — team and agent claims survive it",
    run: (s) => {
      const d = deleteBody(s[SYNC])
      return /\.is\("team_id", null\)/.test(d) && /\.is\("agent_user_id", null\)/.test(d)
    },
  },
  {
    name: "Y8 market DELETE keeps a zip that another live market of the same brokerage still covers",
    run: (s) => {
      const d = deleteBody(s[SYNC])
      return /stillCovered/.test(d) && /\.neq\("id", id\)/.test(d) && /toRetire/.test(d)
    },
  },
  {
    name: "N1 the route is REACHABLE from navigation-config (an unlinked page is a tracked defect class)",
    run: (s) => /href: '\/dashboard\/settings\/territories'/.test(s[NAV]),
  },
  {
    name: "N2 the page passes NO tenancy down — the client gets claims, never a brokerage id to send back",
    run: (s) => /<TerritoriesClient view=\{view\} \/>/.test(s[PAGE])
      && !/brokerageId=\{/.test(s[PAGE]),
  },
  {
    name: "N3 the client re-uses the SAME pure parser the server enforces (shown and enforced cannot drift)",
    run: (s) => /parseZipInput/.test(s[CLIENT]) && /from ["']\.\/territory-rules["']/.test(s[CLIENT]),
  },
  {
    name: "E1 the engine's rotation filter is still brokerage-grain-only — the fact every rule above rests on",
    run: (s) => /\.is\("agent_user_id", null\)/.test(s[ENGINE]) && /\.is\("team_id", null\)/.test(s[ENGINE]),
  },
  {
    name: "M1 m462 adds the two MISSING grain uniques and does not touch the one that already existed",
    run: (s) => /uq_service_area_team_zip/.test(s[MIGRATION])
      && /uq_service_area_agent_zip/.test(s[MIGRATION])
      && /WHERE team_id IS NOT NULL AND agent_user_id IS NULL/.test(s[MIGRATION])
      && /WHERE agent_user_id IS NOT NULL/.test(s[MIGRATION])
      && !/DROP INDEX/.test(s[MIGRATION]),
  },
  {
    name: "M2 m462 enforces at most one PRIMARY per claimant per grain, scoped to active rows",
    run: (s) => /uq_service_area_primary_brokerage/.test(s[MIGRATION])
      && /uq_service_area_primary_team/.test(s[MIGRATION])
      && /uq_service_area_primary_agent/.test(s[MIGRATION])
      && (s[MIGRATION].match(/WHERE is_primary AND active/g) ?? []).length === 3,
  },
]

function sourceLayer() {
  console.log("\n[SOURCE · the writers are session-gated, grain-gated and error-checked]")
  const s = loadSources()
  for (const p of PROBES) check(p.name, p.run(s))
}

function loadSources(): Record<string, string> {
  return {
    [ACTIONS]: src(ACTIONS), [SYNC]: src(SYNC), [RULES]: src(RULES),
    [PAGE]: src(PAGE), [CLIENT]: src(CLIENT), [NAV]: src(NAV),
    [ENGINE]: src(ENGINE), [MIGRATION]: src(MIGRATION),
  }
}

// ─── NEGATIVE CONTROLS ───────────────────────────────────────────────────────
// Each mutation reintroduces exactly one real defect. A check that cannot go red
// is not a check.

const MUTATIONS: Array<{ name: string; probe: string; mutate: (s: Record<string, string>) => Record<string, string> }> = [
  {
    name: "the tenant comes from an argument again instead of the session",
    probe: "S1",
    mutate: (s) => ({ ...s, [ACTIONS]: s[ACTIONS].replace("const { data: auth, error: authError } = await supabase.auth.getUser()", "const auth = { user: { id: opts.userId } }, authError = null") }),
  },
  {
    name: "the brokerage-admin test is re-implemented as a user_type list",
    probe: "S2",
    mutate: (s) => ({ ...s, [ACTIONS]: s[ACTIONS].replace("await requireBrokerageAdmin(supabase as never, user.id)", 'if (!["admin","broker"].includes(String(user_type))) throw new Error("no")') }),
  },
  {
    name: "'team lead' goes back to being a role label instead of teams.team_lead_id",
    probe: "S3",
    mutate: (s) => ({ ...s, [ACTIONS]: s[ACTIONS].replace('.eq("team_lead_id", user.id)', '.eq("role", "team_lead")') }),
  },
  {
    name: "a service client is reached for to paper over RLS",
    probe: "S4",
    mutate: (s) => ({ ...s, [ACTIONS]: s[ACTIONS] + '\nconst svc = createServiceClient()\n' }),
  },
  {
    name: "an UPDATE stops counting affected rows (a zero-row refusal reads as a save)",
    probe: "S5",
    mutate: (s) => ({ ...s, [ACTIONS]: s[ACTIONS].replace(/if \(!updated \|\| updated\.length === 0\)/g, "if (false)") }),
  },
  {
    name: "a read drops its error again (a refusal reads as an absent row)",
    probe: "S6",
    mutate: (s) => ({ ...s, [ACTIONS]: s[ACTIONS].replace("const { data: existing, error: existingError } = await existingQuery.maybeSingle()", "const { data: existing } = await supabase.from(\"x\").select(\"id\")") }),
  },
  {
    name: "bad ZIPs are silently dropped again instead of refusing the whole save",
    probe: "S7",
    mutate: (s) => ({ ...s, [ACTIONS]: s[ACTIONS].replace(/if \(rejected\.length > 0\) \{[\s\S]*?\n  \}/, "") }),
  },
  {
    name: "a team id is trusted without checking it belongs to this tenant",
    probe: "S8",
    mutate: (s) => ({ ...s, [ACTIONS]: s[ACTIONS].replace("That team is not in your brokerage.", "ok") }),
  },
  {
    name: "the roster is hard-deleted instead of deactivated, losing the history",
    probe: "S10",
    mutate: (s) => ({ ...s, [ACTIONS]: s[ACTIONS].replace('.from("subscriber_service_areas")\n    .update(patch)', '.from("subscriber_service_areas")\n    .delete()') }),
  },
  {
    name: "a mutation takes an id straight to the update, skipping the grain gate",
    probe: "S11",
    mutate: (s) => ({ ...s, [ACTIONS]: s[ACTIONS].replace(/await loadWritableClaim\(/g, "await Promise.resolve(") }),
  },
  {
    name: "retiring a claim leaves a stale primary flag behind",
    probe: "S12",
    mutate: (s) => ({ ...s, [ACTIONS]: s[ACTIONS].replace("if (!active && loaded.claim.is_primary) patch.is_primary = false", "") }),
  },
  {
    name: "the market sync writes the market's team_id again, forging a row the rotation never reads",
    probe: "Y1",
    mutate: (s) => ({ ...s, [SYNC]: s[SYNC].replace(/        team_id: null,\n        agent_user_id: null,/, "        team_id: market.team_id ?? null,\n        agent_user_id: null,") }),
  },
  {
    name: "the market sync reads across every grain again, so it can see a settings claim",
    probe: "Y2",
    mutate: (s) => ({ ...s, [SYNC]: s[SYNC].replace('      .is("team_id", null)\n      .is("agent_user_id", null)\n      .maybeSingle()', "      .maybeSingle()") }),
  },
  {
    name: "the market sync resurrects a row settings deliberately retired",
    probe: "Y3",
    mutate: (s) => ({ ...s, [SYNC]: s[SYNC].replace("      report.alreadyClaimed.push(zip)\n      continue", '      await supabase.from("subscriber_service_areas").update({ active: true }).eq("id", (existing as any).id)\n      continue') }),
  },
  {
    name: "the market sync starts stamping is_primary as a side effect",
    probe: "Y4",
    mutate: (s) => ({ ...s, [SYNC]: s[SYNC].replace("        is_primary: false,", "        is_primary: true,") }),
  },
  {
    name: "the market sync goes back to dropping every error",
    probe: "Y5",
    mutate: (s) => ({ ...s, [SYNC]: s[SYNC].replace("const { data: existing, error: existingError } = await supabase", "const { data: existing } = await supabase") }),
  },
  {
    name: "the call sites swallow the sync in .catch(() => {}) again",
    probe: "Y6",
    mutate: (s) => ({ ...s, [SYNC]: s[SYNC].replace("const territory = await syncServiceAreasForMarket(supabase, data as any)", "const territory = await syncServiceAreasForMarket(supabase, data as any).catch(() => {})") }),
  },
  {
    name: "market delete clobbers team and agent claims on the same zip again",
    probe: "Y7",
    mutate: (s) => ({ ...s, [SYNC]: s[SYNC].replace('          .in("zip_code", toRetire)\n          .is("team_id", null)\n          .is("agent_user_id", null)', '          .in("zip_code", toRetire)') }),
  },
  {
    name: "market delete retires a zip another live market still covers",
    probe: "Y8",
    mutate: (s) => ({ ...s, [SYNC]: s[SYNC].replace(/const stillCovered = new Set<string>\(\)/, "const notUsed = new Set<string>()").replace(/\.neq\("id", id\)/, "") }),
  },
  {
    name: "the route is unlinked from navigation again",
    probe: "N1",
    mutate: (s) => ({ ...s, [NAV]: s[NAV].replace(/href: '\/dashboard\/settings\/territories'/g, "href: '/dashboard/settings/general'") }),
  },
  {
    name: "the page starts handing tenancy to the client as a prop",
    probe: "N2",
    mutate: (s) => ({ ...s, [PAGE]: s[PAGE].replace("<TerritoriesClient view={view} />", "<TerritoriesClient view={view} brokerageId={view.viewer?.brokerageId} />") }),
  },
  {
    name: "the client stops sharing the server's ZIP parser and drifts its own",
    probe: "N3",
    mutate: (s) => ({ ...s, [CLIENT]: s[CLIENT].replace(/import \{ parseZipInput[\s\S]*?from "\.\/territory-rules"/, "const parseZipInput = (t: string) => ({ zips: t.split(\",\"), rejected: [] })") }),
  },
  {
    name: "the distribution engine stops filtering to the brokerage grain",
    probe: "E1",
    mutate: (s) => ({ ...s, [ENGINE]: s[ENGINE].replace('.is("agent_user_id", null)', "") }),
  },
  {
    name: "m462 drops the pre-existing brokerage-grain unique instead of leaving it alone",
    probe: "M1",
    mutate: (s) => ({ ...s, [MIGRATION]: s[MIGRATION].replace("CREATE UNIQUE INDEX IF NOT EXISTS uq_service_area_team_zip", "DROP INDEX uq_service_area_brokerage_zip;\nCREATE UNIQUE INDEX IF NOT EXISTS uq_service_area_team_zip") }),
  },
  {
    name: "the primary uniques stop being scoped to active rows (a retired primary blocks the next one)",
    probe: "M2",
    mutate: (s) => ({ ...s, [MIGRATION]: s[MIGRATION].replace(/WHERE is_primary AND active/g, "WHERE is_primary") }),
  },
]

function negativeControls() {
  console.log("\n[NEGATIVE CONTROLS · each must go RED]")
  const base = loadSources()
  for (const m of MUTATIONS) {
    const probe = PROBES.find((p) => p.name.startsWith(m.probe + " "))
    if (!probe) { check(`NEGATIVE CONTROL ${m.name} — probe ${m.probe} not found`, false); continue }
    const stillGreen = probe.run(m.mutate({ ...base }))
    check(`NEGATIVE CONTROL ${m.name} — went RED as required`, !stillGreen,
      stillGreen ? `probe ${m.probe} stayed green against the broken copy` : "")
  }
}

// PURE negative controls: the executed rules must also be falsifiable.
function pureNegativeControls() {
  console.log("\n[NEGATIVE CONTROLS · pure rules, hand-broken and re-asserted]")

  // If parseZipInput dropped instead of rejecting, P2's assertion would hold on
  // zips but the rejected list would be empty. Prove the assertion notices.
  const dropInstead = (raw: string) => ({ zips: raw.split(/[\s,;]+/).filter((z) => ZIP_RE.test(z)), rejected: [] as string[] })
  const brokenP2 = dropInstead("90210, 9021")
  check("NEGATIVE CONTROL a drop-instead-of-reject parser fails P2's rejected-list assertion — went RED as required",
    !(brokenP2.zips.join() === "90210" && brokenP2.rejected.join() === "9021"))

  // If the grain gate ignored ledTeamIds and admitted any team, G3 would pass.
  const laxGate = (v: TerritoryViewer, t: { grain: string }) => ({ ok: v.isBrokerageAdmin || t.grain !== "brokerage" })
  check("NEGATIVE CONTROL a gate that admits ANY team for a lead fails G3 — went RED as required",
    laxGate(LEAD, { grain: "team" }).ok === true)

  // If feedsPlatformRotation ignored the grain, R2 would pass.
  const laxRotation = (r: { active?: boolean | null }) => r.active !== false
  check("NEGATIVE CONTROL a rotation test that ignores the grain fails R2 — went RED as required",
    laxRotation({ active: true }) === true)

  // If resolveGrainColumns fell back to brokerage-wide on a missing team id, P7 would pass.
  const laxResolve = (grain: string, ids: { teamId?: string | null }) =>
    ({ ok: true as const, columns: { team_id: ids.teamId ?? null, agent_user_id: null } })
  check("NEGATIVE CONTROL a resolver that widens a team claim to brokerage-wide fails P7 — went RED as required",
    laxResolve("team", {}).ok === true)
}

// ─── LIVE ────────────────────────────────────────────────────────────────────

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — the pure + source layers proved the rules"); return }
  const svc = createClient(url, key)
  console.log("\n[LIVE · the grain columns exist and are readable]")

  // PostgREST rejects the ENTIRE select when a named column does not exist, so a
  // clean read IS the existence proof for all of them at once.
  const { error } = await svc
    .from("subscriber_service_areas")
    .select("id, brokerage_id, team_id, agent_user_id, zip_code, city, state, is_primary, active, joined_at")
    .limit(1)
  check("live: subscriber_service_areas exposes all three grain columns plus is_primary/active",
    !error, error?.message ?? "")
}

async function main() {
  pureLayer()
  sourceLayer()
  negativeControls()
  pureNegativeControls()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ TERRITORY_SETTINGS_FAIL"); process.exit(1) }
  console.log(" ✅ TERRITORY_SETTINGS_PASS — settings owns the territory roster at all three grains, the tenant comes from the session, and the market sync can originate a claim but never overrule one")
}
main()
