#!/usr/bin/env tsx
/**
 * scripts/mailbox-owner-preference-guard.ts   (npm run test:mailbox-owner-preference)
 *
 * WAVE 86 FOLLOW-UP (lane 86A2) built the MAILBOX-OWNER PREFERENCE; WAVE 87 (lane 87A) makes it the
 * RULE. Owner, verbatim: "since the email was from the agents' mailbox, it should lead back to the
 * agent." A lead that landed RAW from an agent's or team lead's own mailbox (wave 86: "yes all
 * mailboxes should be configured the same.") goes back to that mailbox's owner when it is qualified
 * and assigned. It FALLS THROUGH to the normal rules ONLY when the owner is inactive / no longer in
 * the brokerage, off the team's board, or on an open book transfer — and then the COVERING agent per
 * the transfer takes it when able. No capacity fall-through; no on/off setting (both retired, 87A).
 * A rung of THE router (lib/lead-assignment/tier-routing.ts), never a second one. No network, no DB.
 *
 *   M1 retired halves stay retired — no setting key / settings read / settings doors / panel switch;
 *      no capacity input. POSITIVE CONTROLS: the finders see the 86A2 shapes.
 *   M2 the decision — the all-good fact set routes to the OWNER (positive control); an open transfer
 *      with an able covering agent routes to the COVERING agent; every fall-through branch is proven
 *      to be THE cause by flipping only that fact back; a busy owner is NOT a fall-through.
 *   M3 the loader, against an in-memory double — tenant-anchored reads; refused reads → normal rules;
 *      a brokerage-mailbox lead stops after one read; the transfer names the covering agent, who is
 *      checked active in this brokerage (and on the team board).
 *   M4 wiring — the rung sits AHEAD of the rule pass on the team and brokerage tiers, AFTER the
 *      qualification gate, never on the solo tier; the module writes nothing (no second router,
 *      positive control); the ledger method is CHECK-legal.
 *   M5 the panel STATES the rule; the provenance the rung reads HAS a writer.
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
const mopStripped = stripped("lib/lead-assignment/mailbox-owner-preference.ts")

console.log("\n[M1 · the retired halves stay retired — no on/off setting, no capacity fall-through]")
const SETTING_READ = /\.from\("brokerage_settings"\)|prefer_mailbox_owner|mailboxOwnerPreferenceFromSettings/
const CAPACITY_READ = /agentHasHeadroom|capacity-pick|HIGH_LOAD/
check("the rung reads no brokerage setting (the direction is a ruling, not an option)", !SETTING_READ.test(mopStripped))
check("the rung reads no capacity (a busy agent is still the sender's agent)", !CAPACITY_READ.test(mopStripped))
check("POSITIVE CONTROL: both finders see the 86A2 shapes",
  SETTING_READ.test(`await supabase.from("brokerage_settings").select("settings")`) && CAPACITY_READ.test(`const { agentHasHeadroom } = await import("./capacity-pick")`))
check("the setting exports are gone from the module", !("mailboxOwnerPreferenceFromSettings" in mop) && !("MAILBOX_OWNER_PREFERENCE_KEY" in mop) && !("MAILBOX_OWNER_PREFERENCE_DEFAULT" in mop))
const lrs = blankStrings(stripped("app/actions/admin/lead-routing-settings.ts"))
check("the settings doors are gone (no get/setMailboxOwnerPreference export)", !/export async function (get|set)MailboxOwnerPreference/.test(lrs))
check("capacity-pick no longer exports agentHasHeadroom (its only caller was the retired fall-through)",
  !/export async function agentHasHeadroom/.test(blankStrings(stripped("lib/lead-assignment/capacity-pick.ts"))))
const panelCode = stripped("app/dashboard/settings/components/lead-routing-panel.tsx")
check("the Lead Routing panel carries no switch and calls no retired door",
  !/id="prefer-mailbox-owner"/.test(panelCode) && !/(get|set)MailboxOwnerPreference\(/.test(panelCode))

console.log("\n[M2 · the decision — back to the owner (or the covering agent), or name exactly why the normal rules decide]")
type Facts = Parameters<typeof mop.decideMailboxOwnerPreference>[0]
const GOOD: Facts = {
  ownerKind: "agent", ownerAgentId: "ag-1", ownerActive: true, ownerOnTeamBoard: null,
  ownerOnBookTransfer: false, coveringAgentId: null, coveringActive: null, coveringOnTeamBoard: null,
}
const good = mop.decideMailboxOwnerPreference(GOOD)
check("POSITIVE CONTROL: the all-good fact set routes to the MAILBOX OWNER (so every skip below is not vacuous)",
  good.prefer === true && (good as any).agentId === "ag-1" && (good as any).via === "owner", JSON.stringify(good))
const teamLead = mop.decideMailboxOwnerPreference({ ...GOOD, ownerKind: "team_lead", ownerOnTeamBoard: true })
check("a team lead's mailbox goes to the team lead, on a team-tier board", teamLead.prefer === true && /team lead's/.test(teamLead.reason))
const COVER: Facts = { ...GOOD, ownerOnBookTransfer: true, coveringAgentId: "ag-7", coveringActive: true }
const cover = mop.decideMailboxOwnerPreference(COVER)
check("an OPEN book transfer routes to the COVERING agent per the transfer",
  cover.prefer === true && (cover as any).agentId === "ag-7" && (cover as any).via === "covering_agent" && /covering agent per the transfer/.test(cover.reason), JSON.stringify(cover))
const SKIPS: Array<[string, Facts, Partial<Facts>, RegExp]> = [
  ["the BROKERAGE mailbox (not an agent's)", GOOD, { ownerKind: "brokerage" }, /did not land from an agent or team-lead mailbox/],
  ["a lead that never came from a mailbox", GOOD, { ownerKind: null }, /did not land/],
  ["no owner agents row", GOOD, { ownerAgentId: null }, /no agents row/],
  ["owner INACTIVE / no longer in this brokerage", GOOD, { ownerActive: false }, /inactive or no longer in this brokerage/],
  ["owner row unreadable", GOOD, { ownerActive: null }, /could not be read/],
  ["owner OFF the team's board (team tier)", GOOD, { ownerOnTeamBoard: false }, /not on the routing team's board/],
  ["transfer ledger unreadable", GOOD, { ownerOnBookTransfer: null }, /could not be read/],
  ["provenance read refused", GOOD, { provenanceError: "permission denied" }, /could not be read/],
  ["open transfer names NO covering agent", COVER, { coveringAgentId: null }, /names no covering agent/],
  ["covering agent INACTIVE / gone", COVER, { coveringActive: false }, /covering agent is inactive/],
  ["covering agent row unreadable", COVER, { coveringActive: null }, /could not be read/],
  ["covering agent OFF the team's board", COVER, { coveringOnTeamBoard: false }, /covering agent is not on the routing team's board/],
]
for (const [name, base, bad, why] of SKIPS) {
  const d = mop.decideMailboxOwnerPreference({ ...base, ...bad })
  check(`fall through → normal rules: ${name}`, d.prefer === false && why.test(d.reason) && /^mailbox-owner rule skipped/.test(d.reason), d.reason)
}
check(`each fall-through is THE cause: flipping only that fact back routes again (${SKIPS.length} flips)`,
  SKIPS.every(([, base, bad]) => {
    const flipped: Facts = { ...base, ...bad }
    for (const k of Object.keys(bad) as Array<keyof Facts>) (flipped as any)[k] = (base as any)[k]
    return mop.decideMailboxOwnerPreference(flipped).prefer === true
  }))
check("NO CAPACITY FALL-THROUGH: the decision has no load input, so a busy owner still gets the lead",
  !Object.keys(GOOD).some((k) => /headroom|capacity|load/i.test(k))
    && mop.decideMailboxOwnerPreference({ ...GOOD, ...({ ownerHasHeadroom: false } as any) }).prefer === true)

console.log("\n[M3 · the loader — tenant-anchored reads; a refused read is 'the normal rules decide']")
type Call = { table: string; filters: Record<string, unknown> }
function fakeSvc(tables: Record<string, any[] | { error: string }>, agentsById?: Record<string, boolean>) {
  const calls: Call[] = []
  return {
    calls,
    from(table: string) {
      const filters: Record<string, unknown> = {}
      const result = () => {
        calls.push({ table, filters: { ...filters } })
        const t = tables[table]
        if (t && !Array.isArray(t)) return { data: null, error: { message: t.error }, count: null }
        if (table === "agents" && agentsById) return { data: agentsById[String(filters.id)] ? [{ id: filters.id }] : [], error: null, count: null }
        return { data: t ?? [], error: null, count: 0 }
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
  const svc = fakeSvc({ raw_scraped_leads: PROV, agents: [{ id: "ag-1" }], agent_book_transfers: [] })
  const f = await mop.loadMailboxOwnerFacts(svc as any, "b-1", "lead-1", null)
  const d = mop.decideMailboxOwnerPreference(f)
  check("an agent-mailbox lead, owner active, no transfer → routed to the OWNER", d.prefer === true && (d as any).agentId === "ag-1", JSON.stringify(f))
  check("every read the loader made is anchored on THIS brokerage (§4)", svc.calls.length > 0 && svc.calls.every((c) => c.filters.brokerage_id === "b-1"), JSON.stringify(svc.calls.filter((c) => c.filters.brokerage_id !== "b-1")))
  check("provenance is read by lead_id + source inbound_email_unknown; the transfer ledger by from_agent_id + status active",
    svc.calls.some((c) => c.table === "raw_scraped_leads" && c.filters.lead_id === "lead-1" && c.filters.source === "inbound_email_unknown")
    && svc.calls.some((c) => c.table === "agent_book_transfers" && c.filters.from_agent_id === "ag-1" && c.filters.status === "active"))
  check("the loader reads NO setting and NO load (contacts / leads / transactions counts)",
    !svc.calls.some((c) => ["brokerage_settings", "contacts", "leads", "transactions"].includes(c.table)))
}
{
  const svc = fakeSvc({ raw_scraped_leads: [{ mailbox_owner_kind: "brokerage", mailbox_owner_agent_id: null }] })
  const d = mop.decideMailboxOwnerPreference(await mop.loadMailboxOwnerFacts(svc as any, "b-1", "lead-2", null))
  check("a BROKERAGE-mailbox lead stops after ONE read and falls through", d.prefer === false && svc.calls.length === 1)
}
{
  const svc = fakeSvc({ raw_scraped_leads: PROV, agent_book_transfers: [{ to_agent_id: "ag-7" }] }, { "ag-1": true, "ag-7": true })
  const d = mop.decideMailboxOwnerPreference(await mop.loadMailboxOwnerFacts(svc as any, "b-1", "lead-4", null))
  check("the owner's book is on an OPEN transfer → the COVERING agent (to_agent_id), checked active in THIS brokerage",
    d.prefer === true && (d as any).agentId === "ag-7"
      && svc.calls.some((c) => c.table === "agents" && c.filters.id === "ag-7" && c.filters.brokerage_id === "b-1" && c.filters.is_active === true), JSON.stringify(d))
}
{
  const svc = fakeSvc({ raw_scraped_leads: PROV, agent_book_transfers: [{ to_agent_id: "ag-7" }] }, { "ag-1": true, "ag-7": false })
  const d = mop.decideMailboxOwnerPreference(await mop.loadMailboxOwnerFacts(svc as any, "b-1", "lead-4b", null))
  check("an open transfer whose covering agent is gone → normal rules", d.prefer === false && /covering agent is inactive/.test(d.reason))
}
{
  const svc = fakeSvc({ raw_scraped_leads: PROV, agent_book_transfers: [{ to_agent_id: "ag-7" }] }, { "ag-1": true, "ag-7": true })
  const d = mop.decideMailboxOwnerPreference(await mop.loadMailboxOwnerFacts(svc as any, "b-1", "lead-4c", { memberIds: ["ag-1"], teamLeadAgentId: "ag-8" }))
  check("TEAM tier: a covering agent OFF the team's board → normal rules (teams see only their own board)", d.prefer === false && /covering agent is not on the routing team's board/.test(d.reason))
}
{
  const svc = fakeSvc({ raw_scraped_leads: PROV, agents: [] })
  const d = mop.decideMailboxOwnerPreference(await mop.loadMailboxOwnerFacts(svc as any, "b-1", "lead-5", null))
  check("the owner is not an ACTIVE agent of this brokerage (read returned nothing) → normal rules", d.prefer === false && /inactive or no longer in this brokerage/.test(d.reason))
}
{
  const svc = fakeSvc({ raw_scraped_leads: PROV, agents: [{ id: "ag-1" }], agent_book_transfers: [] })
  const d = mop.decideMailboxOwnerPreference(await mop.loadMailboxOwnerFacts(svc as any, "b-1", "lead-7", { memberIds: ["ag-9"], teamLeadAgentId: "ag-8" }))
  check("TEAM tier: an owner off the routing team's board → normal rules, and the ledger is not even asked",
    d.prefer === false && /team's board/.test(d.reason) && !svc.calls.some((c) => c.table === "agent_book_transfers"))
}
for (const [table, label] of [["raw_scraped_leads", "provenance"], ["agents", "owner row"], ["agent_book_transfers", "transfer ledger"]] as const) {
  const tables: Record<string, any> = { raw_scraped_leads: PROV, agents: [{ id: "ag-1" }], agent_book_transfers: [] }
  tables[table] = { error: "permission denied" }
  const d = mop.decideMailboxOwnerPreference(await mop.loadMailboxOwnerFacts(fakeSvc(tables) as any, "b-1", "lead-x", null))
  check(`FAIL CLOSED: a refused ${label} read → the normal rules decide`, d.prefer === false, d.reason)
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
const mopCode = blankStrings(mopStripped)
check("NO SECOND ROUTER: the rung module writes nothing and commits nothing", !WRITES.test(mopCode))
check("POSITIVE CONTROL: the write finder sees an assignment write", WRITES.test(`await svc.from("leads").update({ agent_id })`) && WRITES.test(`await handleLeadAssigned({ leadId })`))
const { CHECK_VOCABULARIES } = await import("./check-vocabularies")
const prefMethods = [...resolveFn.matchAll(/agentId: mailboxPref\.agentId, method: "(\w+)"/g)].map((m) => m[1])
check("the ledger method is CHECK-legal (assignment_log.assignment_method, live vocabulary cache) — no migration",
  prefMethods.length === 2 && prefMethods.every((m) => CHECK_VOCABULARIES.assignment_log.assignment_method.includes(m)), prefMethods.join(","))

console.log("\n[M5 · the panel states the rule; the provenance writer]")
const panel = stripped("app/dashboard/settings/components/lead-routing-panel.tsx")
check("the Lead Routing panel STATES the rule (back to the agent; covering agent on an open transfer; no capacity clause)",
  /data-rule="mailbox-owner"/.test(panel) && /covering agent/.test(panel) && !/at capacity/.test(panel))
const usi = stripped("lib/lead-pipeline/unknown-sender-identification.ts")
check("the provenance the rung READS has a WRITER (landUnknownSenderRaw stamps both keys)",
  /mailbox_owner_kind: mailboxOwner\.ownerKind/.test(usi) && /mailbox_owner_agent_id: mailboxOwner\.agentId/.test(usi))

console.log("\n[M6 · registration]")
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
check("package.json registers test:mailbox-owner-preference", pkg.scripts["test:mailbox-owner-preference"] === "tsx scripts/mailbox-owner-preference-guard.ts")
check("the guard chain runs it AFTER test:scrapers", (pkg.scripts.guard ?? "").indexOf("npm run test:mailbox-owner-preference") > (pkg.scripts.guard ?? "").indexOf("npm run test:scrapers") && (pkg.scripts.guard ?? "").indexOf("npm run test:scrapers") >= 0)
const { MAINTENANCE_DOMAINS } = await import("../lib/kernel/manager-registry")
check("MAINTENANCE_DOMAINS owns it", Object.values(MAINTENANCE_DOMAINS).some((d: any) => d.proof === "test:mailbox-owner-preference"))

console.log(`\n  denominators: ${SKIPS.length} fall-through branches (each flipped back) · 3 refused-read cases · 2 tiers wired · 2 routed outcomes (owner, covering agent)`)
console.log("  blind spots: a lead whose raw row was merged away by dedup keeps no mailbox provenance and is routed by the normal rules; with SEVERAL open transfers from one owner the newest names the covering agent; a PERMANENT transfer (status 'permanent') is not an open one — the owner then usually reads inactive and the normal rules decide; coverage mode (agents.covering_agent_id) still runs after the rung in autoAssignLead; the loader is run against an in-memory double, not the live database")
console.log("\n" + "─".repeat(50))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log(failed === 0 ? " ✅ MAILBOX_OWNER_PREFERENCE_PASS" : " ❌ MAILBOX_OWNER_PREFERENCE_FAIL")
if (failed) for (const f of failures) console.log(`   · ${f}`)
process.exit(failed === 0 ? 0 : 1)
