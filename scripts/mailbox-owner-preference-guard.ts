#!/usr/bin/env tsx
/**
 * scripts/mailbox-owner-preference-guard.ts   (npm run test:mailbox-owner-preference)
 *
 * WAVE 86 FOLLOW-UP (lane 86A2) — the MAILBOX-OWNER PREFERENCE. A lead that landed RAW from an
 * agent's or team lead's own mailbox (wave 86: "yes all mailboxes should be configured the same.")
 * prefers that mailbox's owner when it is qualified and assigned; DEFAULT ON, switchable off by the
 * brokerage / team lead; the owner inactive, out of capacity, on a book transfer, off the team's board,
 * or any refused read → FALL THROUGH to the normal rules. A rung of THE router
 * (lib/lead-assignment/tier-routing.ts), never a second one. No network, no database.
 *
 *   M1 the setting — absent reads ON; only an explicit false turns it off.
 *   M2 the decision — the all-good fact set PREFERS (positive control), and every skip branch is
 *      proven to be THE cause: flipping only that one fact back to good makes it prefer again.
 *   M3 the loader, against an in-memory double — tenant-anchored reads, refused reads → not
 *      preferred, a brokerage-mailbox lead stops after one read, the book-transfer ledger is asked.
 *   M4 wiring — the rung sits AHEAD of the rule pass on the team and brokerage tiers, AFTER the
 *      qualification gate, never on the solo tier; the module writes nothing (no second router,
 *      positive control); the ledger method is CHECK-legal.
 *   M5 the settings door — admin-gated, read-merge-write, a zero-row write is a failure; the panel's
 *      switch is wired; the provenance the rung reads HAS a writer.
 *   M6 registration.
 */
import { readFileSync } from "node:fs"
import { stripComments, blankStrings } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(p, "utf8")
const stripped = (p: string) => stripComments(read(p))

const mop = await import("../lib/lead-assignment/mailbox-owner-preference")

console.log("\n[M1 · the setting — default ON, only an explicit false turns it off]")
check("absent settings / absent key → ON (the recommended default)",
  mop.mailboxOwnerPreferenceFromSettings(null) === true && mop.mailboxOwnerPreferenceFromSettings({}) === true
  && mop.mailboxOwnerPreferenceFromSettings({ lead_routing: {} }) === true && mop.MAILBOX_OWNER_PREFERENCE_DEFAULT === true)
check("explicit false → OFF; explicit true → ON",
  mop.mailboxOwnerPreferenceFromSettings({ lead_routing: { prefer_mailbox_owner: false } }) === false
  && mop.mailboxOwnerPreferenceFromSettings({ lead_routing: { prefer_mailbox_owner: true } }) === true)
check("a garbage value is not a decision to turn it off", mop.mailboxOwnerPreferenceFromSettings({ lead_routing: { prefer_mailbox_owner: "no" } }) === true)

console.log("\n[M2 · the decision — prefer the owner, or name exactly why the normal rules decide]")
type Facts = Parameters<typeof mop.decideMailboxOwnerPreference>[0]
const GOOD: Facts = {
  enabled: true, ownerKind: "agent", ownerAgentId: "ag-1", ownerActive: true,
  ownerHasHeadroom: true, ownerOnBookTransfer: false, ownerOnTeamBoard: null,
}
const good = mop.decideMailboxOwnerPreference(GOOD)
check("POSITIVE CONTROL: the all-good fact set PREFERS the mailbox owner (so every skip below is not vacuous)",
  good.prefer === true && (good as any).agentId === "ag-1", JSON.stringify(good))
const teamLead = mop.decideMailboxOwnerPreference({ ...GOOD, ownerKind: "team_lead", ownerOnTeamBoard: true })
check("a team lead's mailbox prefers the team lead, on a team-tier board", teamLead.prefer === true && /team lead's/.test(teamLead.reason))
const SKIPS: Array<[string, Partial<Facts>, RegExp]> = [
  ["setting turned OFF", { enabled: false }, /turned off/],
  ["setting unreadable", { enabled: null }, /could not be read/],
  ["the BROKERAGE mailbox (not an agent's)", { ownerKind: "brokerage" }, /did not land from an agent or team-lead mailbox/],
  ["a lead that never came from a mailbox", { ownerKind: null }, /did not land/],
  ["no owner agents row", { ownerAgentId: null }, /no agents row/],
  ["owner INACTIVE", { ownerActive: false }, /not an active agent/],
  ["owner row unreadable", { ownerActive: null }, /could not be read/],
  ["owner on a BOOK TRANSFER", { ownerOnBookTransfer: true }, /book is on an open transfer/],
  ["transfer ledger unreadable", { ownerOnBookTransfer: null }, /could not be read/],
  ["owner OUT OF CAPACITY", { ownerHasHeadroom: false }, /out of capacity/],
  ["owner load unreadable", { ownerHasHeadroom: null }, /could not be read/],
  ["owner OFF the team's board (team tier)", { ownerOnTeamBoard: false }, /not on the routing team's board/],
  ["provenance read refused", { provenanceError: "permission denied" }, /could not be read/],
]
for (const [name, bad, why] of SKIPS) {
  const d = mop.decideMailboxOwnerPreference({ ...GOOD, ...bad })
  check(`skip → normal rules: ${name}`, d.prefer === false && why.test(d.reason) && /^mailbox-owner preference skipped/.test(d.reason), d.reason)
}
check("each skip is THE cause: flipping only that fact back to good prefers again (13 flips)",
  SKIPS.every(([, bad]) => {
    const flipped: Facts = { ...GOOD, ...bad }
    for (const k of Object.keys(bad) as Array<keyof Facts>) (flipped as any)[k] = (GOOD as any)[k]
    return mop.decideMailboxOwnerPreference(flipped).prefer === true
  }))

console.log("\n[M3 · the loader — tenant-anchored reads; a refused read is 'not preferred']")
type Call = { table: string; filters: Record<string, unknown> }
function fakeSvc(tables: Record<string, any[] | { error: string }>, counts: Record<string, number> = {}) {
  const calls: Call[] = []
  return {
    calls,
    from(table: string) {
      const filters: Record<string, unknown> = {}
      const result = () => {
        calls.push({ table, filters: { ...filters } })
        const t = tables[table]
        if (t && !Array.isArray(t)) return { data: null, error: { message: t.error }, count: null }
        return { data: t ?? [], error: null, count: counts[table] ?? 0 }
      }
      const q: any = {
        select: () => q, order: () => q, limit: () => q, is: () => q, in: () => q,
        eq: (c: string, v: unknown) => { filters[c] = v; return q },
        maybeSingle: () => { const r = result(); return Promise.resolve({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }) },
        then: (res: any, rej: any) => Promise.resolve(result()).then(res, rej),
      }
      return q
    },
  }
}
const PROV = [{ mailbox_owner_kind: "agent", mailbox_owner_agent_id: "ag-1" }]
{
  const svc = fakeSvc({ raw_scraped_leads: PROV, brokerage_settings: [], agents: [{ id: "ag-1" }], agent_book_transfers: [] }, { agents: 10, contacts: 0, leads: 0, transactions: 0 })
  const f = await mop.loadMailboxOwnerFacts(svc as any, "b-1", "lead-1", null)
  const d = mop.decideMailboxOwnerPreference(f)
  check("an agent-mailbox lead, owner active with capacity, no transfer, no saved setting → PREFERRED", d.prefer === true && (d as any).agentId === "ag-1", JSON.stringify(f))
  check("every read the loader made is anchored on THIS brokerage (§4)", svc.calls.length > 0 && svc.calls.every((c) => c.filters.brokerage_id === "b-1"), JSON.stringify(svc.calls.filter((c) => c.filters.brokerage_id !== "b-1")))
  check("provenance is read by lead_id + source inbound_email_unknown; the transfer ledger by from_agent_id + status active",
    svc.calls.some((c) => c.table === "raw_scraped_leads" && c.filters.lead_id === "lead-1" && c.filters.source === "inbound_email_unknown")
    && svc.calls.some((c) => c.table === "agent_book_transfers" && c.filters.from_agent_id === "ag-1" && c.filters.status === "active"))
}
{
  const svc = fakeSvc({ raw_scraped_leads: [{ mailbox_owner_kind: "brokerage", mailbox_owner_agent_id: null }] })
  const d = mop.decideMailboxOwnerPreference(await mop.loadMailboxOwnerFacts(svc as any, "b-1", "lead-2", null))
  check("a BROKERAGE-mailbox lead stops after ONE read and falls through", d.prefer === false && svc.calls.length === 1)
}
{
  const svc = fakeSvc({ raw_scraped_leads: PROV, brokerage_settings: [{ settings: { lead_routing: { prefer_mailbox_owner: false } } }] })
  const d = mop.decideMailboxOwnerPreference(await mop.loadMailboxOwnerFacts(svc as any, "b-1", "lead-3", null))
  check("the brokerage turned it OFF → normal rules, and the owner is not even looked up", d.prefer === false && /turned off/.test(d.reason) && !svc.calls.some((c) => c.table === "agents"))
}
{
  const svc = fakeSvc({ raw_scraped_leads: PROV, brokerage_settings: [], agents: [{ id: "ag-1" }], agent_book_transfers: [{ id: "t-1" }] })
  const d = mop.decideMailboxOwnerPreference(await mop.loadMailboxOwnerFacts(svc as any, "b-1", "lead-4", null))
  check("the owner's book is on an OPEN transfer → normal rules", d.prefer === false && /open transfer/.test(d.reason))
}
{
  const svc = fakeSvc({ raw_scraped_leads: PROV, brokerage_settings: [], agents: [] })
  const d = mop.decideMailboxOwnerPreference(await mop.loadMailboxOwnerFacts(svc as any, "b-1", "lead-5", null))
  check("the owner is not an ACTIVE agent of this brokerage (read returned nothing) → normal rules", d.prefer === false && /not an active agent/.test(d.reason))
}
{
  const svc = fakeSvc({ raw_scraped_leads: PROV, brokerage_settings: [], agents: [{ id: "ag-1" }], agent_book_transfers: [] }, { agents: 1, contacts: 40, leads: 0, transactions: 0 })
  const d = mop.decideMailboxOwnerPreference(await mop.loadMailboxOwnerFacts(svc as any, "b-1", "lead-6", null))
  check("the owner is OUT OF CAPACITY (load at the capacity guardian's ceiling) → normal rules", d.prefer === false && /out of capacity/.test(d.reason), d.reason)
}
{
  const svc = fakeSvc({ raw_scraped_leads: PROV, brokerage_settings: [], agents: [{ id: "ag-1" }], agent_book_transfers: [] }, { agents: 10 })
  const d = mop.decideMailboxOwnerPreference(await mop.loadMailboxOwnerFacts(svc as any, "b-1", "lead-7", { memberIds: ["ag-9"], teamLeadAgentId: "ag-8" }))
  check("TEAM tier: an owner off the routing team's board → normal rules (teams see only their own board)", d.prefer === false && /team's board/.test(d.reason))
}
for (const [table, label] of [["raw_scraped_leads", "provenance"], ["brokerage_settings", "setting"], ["agents", "owner row"], ["agent_book_transfers", "transfer ledger"]] as const) {
  const tables: Record<string, any> = { raw_scraped_leads: PROV, brokerage_settings: [], agents: [{ id: "ag-1" }], agent_book_transfers: [] }
  tables[table] = { error: "permission denied" }
  const d = mop.decideMailboxOwnerPreference(await mop.loadMailboxOwnerFacts(fakeSvc(tables, { agents: 10 }) as any, "b-1", "lead-x", null))
  check(`FAIL CLOSED: a refused ${label} read → not preferred (the normal rules decide)`, d.prefer === false, d.reason)
}

console.log("\n[M4 · wiring — a rung of THE router, ahead of the rules, after the gate, never solo]")
const tr = stripped("lib/lead-assignment/tier-routing.ts")
const resolveFn = tr.slice(tr.indexOf("async function resolveTierRouting("), tr.indexOf("export type AssignmentTrigger"))
const soloReturn = resolveFn.indexOf('if (tier === "solo_agent")')
const teamStart = resolveFn.indexOf('if (tier === "team")')
const brokerageStart = resolveFn.indexOf("const tierNote = tier === \"team\"")
const teamPref = resolveFn.indexOf("loadMailboxOwnerFacts(", teamStart)
const teamRules = resolveFn.indexOf("resolveAgentByRules(supabase, brokerageId, lead as never)", teamStart)
const brokPref = resolveFn.indexOf("loadMailboxOwnerFacts(", brokerageStart)
const brokRules = resolveFn.indexOf("resolveAgentByRules(supabase, brokerageId, lead as never)", brokerageStart)
check("TEAM tier: the preference is asked BEFORE the rule pass, with the team's board (pool + team lead)",
  teamPref > teamStart && teamPref < teamRules && /loadMailboxOwnerFacts\(supabase, brokerageId, lead\.id, \{ memberIds: pool, teamLeadAgentId \}\)/.test(resolveFn))
check("BROKERAGE tier: the preference is asked BEFORE the rule pass, across the roster (no team board)",
  brokPref > brokerageStart && brokPref < brokRules && /loadMailboxOwnerFacts\(supabase, brokerageId, lead\.id, null\)/.test(resolveFn.slice(brokerageStart)))
check("SOLO tier never reaches it (the solo branch returns before the first ask)", soloReturn > -1 && soloReturn < resolveFn.indexOf("loadMailboxOwnerFacts("))
const auto = tr.slice(tr.indexOf("export async function autoAssignLead("))
check("it runs only AFTER the qualification / positive-intent gate (autoAssignLead: gate → resolveTierRouting)",
  auto.indexOf("evaluateAssignmentEligibility(") > -1 && auto.indexOf("evaluateAssignmentEligibility(") < auto.indexOf("resolveTierRouting("))
check("a preferred owner still takes coverage mode and the ONE commit (handleLeadAssigned) — nothing is committed in the rung",
  auto.indexOf("resolveTierRouting(") < auto.indexOf("redirectForCoverage(") && auto.indexOf("redirectForCoverage(") < auto.indexOf("handleLeadAssigned({"))
const WRITES = /\.(?:insert|update|upsert|delete)\(|handleLeadAssigned\(|\.rpc\(/
const mopCode = blankStrings(stripped("lib/lead-assignment/mailbox-owner-preference.ts"))
check("NO SECOND ROUTER: the preference module writes nothing and commits nothing", !WRITES.test(mopCode))
check("POSITIVE CONTROL: the write finder sees an assignment write", WRITES.test(`await svc.from("leads").update({ agent_id })`) && WRITES.test(`await handleLeadAssigned({ leadId })`))
const { CHECK_VOCABULARIES } = await import("./check-vocabularies")
const prefMethods = [...resolveFn.matchAll(/agentId: mailboxPref\.agentId, method: "(\w+)"/g)].map((m) => m[1])
check("the ledger method is CHECK-legal (assignment_log.assignment_method, live vocabulary cache) — no migration",
  prefMethods.length === 2 && prefMethods.every((m) => CHECK_VOCABULARIES.assignment_log.assignment_method.includes(m)), prefMethods.join(","))

console.log("\n[M5 · the settings door, the switch, and the provenance writer]")
const act = stripped("app/actions/admin/lead-routing-settings.ts")
const getFn = act.slice(act.indexOf("export async function getMailboxOwnerPreference"), act.indexOf("export async function setMailboxOwnerPreference"))
const setFn = act.slice(act.indexOf("export async function setMailboxOwnerPreference"))
check("both doors gate FIRST on requireRoutingAdmin (broker / admin / team lead) before the service client",
  getFn.indexOf("requireRoutingAdmin()") > -1 && getFn.indexOf("requireRoutingAdmin()") < getFn.indexOf("createServiceClient()")
  && setFn.indexOf("requireRoutingAdmin()") > -1 && setFn.indexOf("requireRoutingAdmin()") < setFn.indexOf("createServiceClient()"))
check("the tenant is the SESSION's (gate.brokerageId), never a parameter",
  /\.eq\("brokerage_id", gate\.brokerageId\)/.test(setFn) && !/brokerageId\s*:\s*string/.test(setFn.slice(0, setFn.indexOf("{"))))
check("read-merge-write keeps every other settings key; a zero-row write is a FAILURE (§3)",
  /\.\.\.prior,/.test(setFn) && /\.\.\.\(prior\.lead_routing \?\? \{\}\)/.test(setFn) && /\.select\("id"\)/.test(setFn) && /write\.data\.length === 0/.test(setFn))
const panel = stripped("app/dashboard/settings/components/lead-routing-panel.tsx")
check("the Lead Routing panel carries the switch, loads it and saves it",
  /id="prefer-mailbox-owner"/.test(panel) && /getMailboxOwnerPreference\(\)/.test(panel) && /setMailboxOwnerPreference\(next\)/.test(panel))
const usi = stripped("lib/lead-pipeline/unknown-sender-identification.ts")
check("the provenance the rung READS has a WRITER (landUnknownSenderRaw stamps both keys)",
  /mailbox_owner_kind: mailboxOwner\.ownerKind/.test(usi) && /mailbox_owner_agent_id: mailboxOwner\.agentId/.test(usi))

console.log("\n[M6 · registration]")
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
check("package.json registers test:mailbox-owner-preference", pkg.scripts["test:mailbox-owner-preference"] === "tsx scripts/mailbox-owner-preference-guard.ts")
check("the guard chain runs it AFTER test:scrapers", (pkg.scripts.guard ?? "").indexOf("npm run test:mailbox-owner-preference") > (pkg.scripts.guard ?? "").indexOf("npm run test:scrapers") && (pkg.scripts.guard ?? "").indexOf("npm run test:scrapers") >= 0)
const { MAINTENANCE_DOMAINS } = await import("../lib/kernel/manager-registry")
check("MAINTENANCE_DOMAINS owns it", Object.values(MAINTENANCE_DOMAINS).some((d: any) => d.proof === "test:mailbox-owner-preference"))

console.log(`\n  denominators: ${SKIPS.length} skip branches (each flipped back) · 4 refused-read cases · 2 tiers wired · 1 settings key`)
console.log("  blind spots: capacity-pick's working-load counts do not read their errors (pre-existing) — a refused count reads as 0 load, i.e. headroom; 'out of seats' is read as CAPACITY (no per-agent seat column exists live — seats are a brokerage-subscription quantity); a lead whose raw row was merged away by dedup keeps no mailbox provenance and is routed by the normal rules; the loader is run against an in-memory double, not the live database")
console.log("\n" + "─".repeat(50))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log(failed === 0 ? " ✅ MAILBOX_OWNER_PREFERENCE_PASS" : " ❌ MAILBOX_OWNER_PREFERENCE_FAIL")
if (failed) for (const f of failures) console.log(`   · ${f}`)
process.exit(failed === 0 ? 0 : 1)
