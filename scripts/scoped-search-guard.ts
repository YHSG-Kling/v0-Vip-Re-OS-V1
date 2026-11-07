/**
 * scripts/scoped-search-guard.ts — `npm run test:scoped-search`   (wave 150, lane 150QTV — owner ruling R6)
 * ─────────────────────────────────────────────────────────────────────────────
 * R6, verbatim: "Global search finds contacts, listings AND leads — scoped strictly to what the signed-in user may see (tenant,
 * office, team, assignment, role; agents never see raw tenant leads merely because they exist)."
 *
 * EXECUTED on the in-memory client through the REAL modules (lib/search/scoped-record-search.ts → resolveViewerHierarchy,
 * resolveLeadVisibility, applyLeadRowScope). Two tenants: a single-office brokerage (A) and a multi-location brokerage (M) whose
 * office head manages office 1 only, plus a foreign tenant (B) holding a same-name contact.
 *   1  single-office broker: every contact / lead (incl. the unassigned pool) / listing of the tenant, nothing of tenant B.
 *   2  agent: their OWN contacts, ONLY leads assigned to their agents row (never the pool, never a colleague's), tenant listings.
 *   3  multi-location office head: office-1 contacts / listings / leads only — never office 2, never the pool.
 *   4  fail closed: a contact seat, a refused scope read, a missing session tenant; the typed query cannot inject a filter.
 *   5  census on STRIPPED source: the "use server" door takes only the words, the tenant from requireCaller, never the service
 *      client; the header box calls it; each absence check has a POSITIVE CONTROL.
 *   6  mutation: an agent searched with the lead-desk rule (the defect R6 forbids) WOULD see the raw pool — the finder sees it.
 *
 * BLIND SPOTS (published): memSupabase has no RLS, so the RLS layer under the session client is judged by
 * scripts/cross-office-rls-guard.ts, not here; the UI is proven by source census (no browser); team_members-based team rosters
 * are exercised only through resolveLeadVisibility's own proof (test:lead-visibility); ranking/relevance is not measured.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"

const STUB: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => { throw new Error('the scoped search must never reach the service client') }",
  "@/lib/supabase/server": "export const createClient = async () => globalThis.__150QTV_search",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const body = STUB[spec]
    if (body !== undefined) return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const ROOT = process.cwd()
const raw = (p: string) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : "")
const src = (p: string) => stripComments(raw(p))

const A = "00000000-0000-4000-8000-0000000000a0", M = "00000000-0000-4000-8000-0000000000d0", B = "00000000-0000-4000-8000-0000000000b0"
const O1 = "00000000-0000-4000-8000-0000000000e1", O2 = "00000000-0000-4000-8000-0000000000e2"

function world(opts: { refuse?: Record<string, string> } = {}): MemClient {
  return memSupabase({
    brokerages: [{ id: A, plan_tier: "brokerage" }, { id: M, plan_tier: "multi_location" }, { id: B, plan_tier: "brokerage" }],
    users: [
      { id: "u-broker", brokerage_id: A, user_type: "broker", location_id: null },
      { id: "u-a1", brokerage_id: A, user_type: "agent", location_id: null },
      { id: "u-a2", brokerage_id: A, user_type: "agent", location_id: null },
      { id: "u-noagent", brokerage_id: A, user_type: "agent", location_id: null },
      { id: "u-contact", brokerage_id: A, user_type: "contact", location_id: null },
      { id: "u-head", brokerage_id: M, user_type: "broker", location_id: null },
      { id: "u-m1", brokerage_id: M, user_type: "agent", location_id: O1 },
      { id: "u-bb", brokerage_id: B, user_type: "broker", location_id: null },
    ],
    locations: [
      { id: O1, brokerage_id: M, status: "active", managing_broker_user_id: "u-head" },
      { id: O2, brokerage_id: M, status: "active", managing_broker_user_id: null },
    ],
    teams: [], organization_members: [], user_role_assignments: [], team_members: [],
    agents: [
      { id: "ag-a1", brokerage_id: A, user_id: "u-a1", location_id: null, team_id: null },
      { id: "ag-a2", brokerage_id: A, user_id: "u-a2", location_id: null, team_id: null },
      { id: "ag-m1", brokerage_id: M, user_id: "u-m1", location_id: O1, team_id: null },
      { id: "ag-m2", brokerage_id: M, user_id: "u-m2", location_id: O2, team_id: null },
    ],
    contacts: [
      { id: "c-a1", brokerage_id: A, agent_id: "ag-a1", location_id: null, team_id: null, first_name: "Ann", last_name: "Smith", email: "ann@x.test", phone: null, city: "Austin", deleted_at: null },
      { id: "c-a2", brokerage_id: A, agent_id: "ag-a2", location_id: null, team_id: null, first_name: "Anna", last_name: "Jones", email: "anna@x.test", phone: null, city: "Austin", deleted_at: null },
      { id: "c-b", brokerage_id: B, agent_id: null, location_id: null, team_id: null, first_name: "Ann", last_name: "Other", email: "ann@b.test", phone: null, city: "Dallas", deleted_at: null },
      { id: "c-m1", brokerage_id: M, agent_id: "ag-m1", location_id: O1, team_id: null, first_name: "Annika", last_name: "One", email: "a1@m.test", phone: null, city: "Tampa", deleted_at: null },
      { id: "c-m2", brokerage_id: M, agent_id: "ag-m2", location_id: O2, team_id: null, first_name: "Annette", last_name: "Two", email: "a2@m.test", phone: null, city: "Miami", deleted_at: null },
    ],
    leads: [
      { id: "l-pool", brokerage_id: A, agent_id: null, first_name: "Annie", last_name: "Pool", email: "pool@x.test", phone: null, city: "Austin", lead_stage: "new" },
      { id: "l-a1", brokerage_id: A, agent_id: "ag-a1", first_name: "Annabel", last_name: "Mine", email: "mine@x.test", phone: null, city: "Austin", lead_stage: "qualified" },
      { id: "l-a2", brokerage_id: A, agent_id: "ag-a2", first_name: "Annalise", last_name: "Theirs", email: "theirs@x.test", phone: null, city: "Austin", lead_stage: "qualified" },
      { id: "l-mpool", brokerage_id: M, agent_id: null, first_name: "Anneliese", last_name: "MPool", email: "mp@m.test", phone: null, city: "Tampa", lead_stage: "new" },
      { id: "l-m1", brokerage_id: M, agent_id: "ag-m1", first_name: "Annora", last_name: "Office1", email: "o1@m.test", phone: null, city: "Tampa", lead_stage: "qualified" },
      { id: "l-m2", brokerage_id: M, agent_id: "ag-m2", first_name: "Annis", last_name: "Office2", email: "o2@m.test", phone: null, city: "Miami", lead_stage: "qualified" },
    ],
    listings: [
      { id: "ls-a2", brokerage_id: A, agent_id: "ag-a2", location_id: null, team_id: null, address: "12 Annapolis St", city: "Austin", state: "TX", zip: "78701", status: "active", mls_number: "M1", deleted_at: null },
      { id: "ls-b", brokerage_id: B, agent_id: null, location_id: null, team_id: null, address: "9 Annapolis Rd", city: "Dallas", state: "TX", zip: "75001", status: "active", mls_number: "M9", deleted_at: null },
      { id: "ls-m1", brokerage_id: M, agent_id: "ag-m1", location_id: O1, team_id: null, address: "1 Annex Way", city: "Tampa", state: "FL", zip: "33601", status: "active", mls_number: "M2", deleted_at: null },
      { id: "ls-m2", brokerage_id: M, agent_id: "ag-m2", location_id: O2, team_id: null, address: "2 Annex Way", city: "Miami", state: "FL", zip: "33101", status: "active", mls_number: "M3", deleted_at: null },
    ],
  }, { refuse: opts.refuse })
}

const ids = (hits: Array<{ id: string }>) => hits.map((h) => h.id).sort().join(",")

async function main() {
  const mod = await import("../lib/search/scoped-record-search")
  const run = (db: MemClient, userId: string, brokerageId: string, userType: string | null, q = "ann") =>
    mod.searchScopedRecords(db as never, { userId, brokerageId, userType, platformRole: null }, q)

  console.log("\n[1 — single-office broker: the whole tenant, nothing foreign]")
  const br = await run(world(), "u-broker", A, "broker")
  check("the broker's search succeeds", br.ok, JSON.stringify(br))
  if (br.ok) {
    check("contacts: both of tenant A's, never tenant B's same-name contact", ids(br.contacts) === "c-a1,c-a2", ids(br.contacts))
    check("leads: the lead desk sees every lead of the tenant, the unassigned pool included", ids(br.leads) === "l-a1,l-a2,l-pool", ids(br.leads))
    check("listings: the tenant's listing, never tenant B's", ids(br.listings) === "ls-a2", ids(br.listings))
    check("each hit links to the record's own page", br.contacts.every((h) => h.href === `/crm/contacts/${h.id}`) && br.leads.every((h) => h.href === `/leads/${h.id}`) && br.listings.every((h) => h.href === `/dashboard/listings/${h.id}`))
  }

  console.log("\n[2 — agent: own contacts, ONLY assigned leads (never the raw pool), tenant listings]")
  const ag = await run(world(), "u-a1", A, "agent")
  check("the agent's search succeeds", ag.ok, JSON.stringify(ag))
  if (ag.ok) {
    check("contacts: ONLY the agent's own (contacts.agent_id = their agents row), not a colleague's", ids(ag.contacts) === "c-a1", ids(ag.contacts))
    check("leads: ONLY the lead assigned to them — the unassigned pool and a colleague's lead are invisible", ids(ag.leads) === "l-a1", ids(ag.leads))
    check("…and the reach says so in words", /assigned to you/.test(ag.reach.leads), ag.reach.leads)
    check("listings: the tenant's inventory on a single-office tenant", ids(ag.listings) === "ls-a2", ids(ag.listings))
  }
  const na = await run(world(), "u-noagent", A, "agent")
  check("an agent seat with no agents row sees NO leads and NO contacts, and is told why (never the pool)",
    na.ok && na.leads.length === 0 && na.contacts.length === 0 && /lead desk/.test(na.reach.leads), JSON.stringify(na))

  console.log("\n[3 — multi-location office head: office 1 only (resolveViewerHierarchy)]")
  const hd = await run(world(), "u-head", M, "broker")
  check("the office head's search succeeds", hd.ok, JSON.stringify(hd))
  if (hd.ok) {
    check("contacts: office 1 only — office 2's contact is invisible although the seat is a broker", ids(hd.contacts) === "c-m1", ids(hd.contacts))
    check("listings: office 1 only", ids(hd.listings) === "ls-m1", ids(hd.listings))
    check("leads: only leads worked by office-1 agents — never office 2, never the tenant's unassigned pool", ids(hd.leads) === "l-m1", ids(hd.leads))
  }
  const m1 = await run(world(), "u-m1", M, "agent")
  check("a multi-location agent: own contact, own lead, own office's listings", m1.ok && ids(m1.contacts) === "c-m1" && ids(m1.leads) === "l-m1" && ids(m1.listings) === "ls-m1", JSON.stringify(m1))

  console.log("\n[4 — fail closed + the typed words cannot become a filter]")
  const ct = await run(world(), "u-contact", A, "contact")
  check("a CONTACT seat is refused (search is the team's workspace)", !ct.ok)
  const refused = await run(world({ refuse: { organization_members: "permission denied for table organization_members" } }), "u-broker", A, "broker")
  check("a REFUSED scope read refuses the whole search (never 'nothing found')", !refused.ok && /could not confirm/.test(refused.error), JSON.stringify(refused))
  const refusedLeads = await run(world({ refuse: { leads: "permission denied for table leads" } }), "u-broker", A, "broker")
  check("a refused LEADS read refuses, said in words", !refusedLeads.ok && /Lead search was refused/.test(refusedLeads.error), JSON.stringify(refusedLeads))
  const noTenant = await mod.searchScopedRecords(world() as never, { userId: "u-broker", brokerageId: "", userType: "broker", platformRole: null }, "ann")
  check("no session tenant → refused", !noTenant.ok)
  const foreign = await run(world(), "u-broker", B, "broker")
  check("a claimed tenant the seat does not sit in → refused by the hierarchy (not a member of this workspace)", !foreign.ok, JSON.stringify(foreign))
  const inj = await run(world(), "u-a1", A, "agent", "ann,agent_id.is.null")
  check("an injected filter in the typed words is neutralised (the pool stays invisible to the agent)", inj.ok && !inj.leads.some((l) => l.id === "l-pool"), JSON.stringify(inj))
  const short = await run(world(), "u-broker", A, "broker", "a")
  check("one letter searches nothing (and says so)", short.ok && short.contacts.length === 0 && /two letters/.test(short.reach.contacts))

  console.log("\n[5 — census on stripped source]")
  const action = raw("app/actions/global-search.ts")
  const actionCode = src("app/actions/global-search.ts")
  const lib = src("lib/search/scoped-record-search.ts")
  const box = src("app/components/layout/global-search.tsx")
  check("the door is a \"use server\" module whose every export is async", /^"use server"/.test(action) && !/export\s+(?!async\s+function)(const|function|let|class)\s/.test(actionCode))
  check("…takes ONLY the typed words; the tenant + seat come from requireCaller (the session)", /searchWorkspaceRecords\(query: string\)/.test(actionCode) && /requireCaller\(\)/.test(actionCode) && /caller\.brokerageId/.test(actionCode) && !/brokerageId:\s*query|params\.brokerageId|body\./.test(actionCode))
  const SERVICE = /createServiceClient|@\/lib\/supabase\/service/
  check("…and neither the door nor the search reaches the SERVICE client (RLS stays underneath, lane 150BAA)", !SERVICE.test(actionCode) && !SERVICE.test(lib))
  check("POSITIVE CONTROL — the service-client finder sees an import", SERVICE.test(`import { createServiceClient } from "@/lib/supabase/service"`))
  check("the search composes the scope SURVIVORS (resolveViewerHierarchy, resolveLeadVisibility, applyLeadRowScope) — no second scope engine",
    /resolveViewerHierarchy\(/.test(lib) && /resolveLeadVisibility\(/.test(lib) && /applyLeadRowScope\(/.test(lib))
  check("every supabase read in the search reads its error", (lib.match(/const \{ data(?:: \w+)?, error(?:: \w+)? \} = await/g) ?? []).length >= 4)
  check("the header box calls the door and says each empty kind in words (\"No … yet\")", /searchWorkspaceRecords\(/.test(box) && /No contacts match yet/.test(raw("app/components/layout/global-search.tsx")) && /No leads match yet/.test(raw("app/components/layout/global-search.tsx")))
  check("…and keeps the ⌘K palette one click away", /openCommandPalette\(\)/.test(box))

  console.log("\n[6 — mutation: the defect R6 forbids is VISIBLE to this proof]")
  const mutant = await run(world(), "u-a1", A, "broker") // an agent searched as if on the lead desk
  check("MUTANT — an agent read through the lead-desk rule WOULD see the raw pool (so assertion 2 is not vacuous)", mutant.ok && mutant.leads.some((l) => l.id === "l-pool"), JSON.stringify(mutant.ok ? ids(mutant.leads) : mutant))

  console.log("\nBLIND SPOTS: memSupabase enforces no RLS (judged by test:cross-office-rls); the UI is source-censused, not rendered; team_members rosters are proven by the lead-visibility suite; relevance ranking is not measured.")
  console.log(`\nRESULT: ${pass} passed, ${fail} failed${fail === 0 ? " ✅ SCOPED_SEARCH_PASS" : ""}`)
  if (fail > 0) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
