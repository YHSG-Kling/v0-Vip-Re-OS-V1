#!/usr/bin/env tsx
/**
 * scripts/tenant-policy-versions-guard.ts   (npm run test:tenant-policy-versions)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE VERSIONED TENANT OPERATING CONSTITUTION (wave 101, lane 101A; m696; gap map rows 21/22).
 *
 * BEHAVIOUR (in-memory supabase, the REAL kernel + survivor writers + server actions, module edges
 * stubbed — no network, no live rows):
 *   1. a policy write creates version n+1 carrying the previous value; a no-op write appends
 *      nothing; a non-policy key appends nothing; an unattributed write is versioned as 'system';
 *   2. each version leaves an auditOnly kernel event (LAW 5);
 *   3. revertPolicy writes a NEW version through the survivor writer (history never rewritten);
 *   4. a cross-tenant read / revert is refused (positive control: the owning tenant reads it);
 *   5. a non-admin is refused; a tenant with NO versions keeps the live/default values and the
 *      settings write still lands when m696 is absent;
 *   6. authority level (managed_agents.config) and ISA settings are versioned by their writers.
 * MIGRATION (m696 text, SQL comments removed): append-only trigger refuses UPDATE and DELETE with
 *   the cascade pass-through; RLS tenant-scoped read, no write policy — each with a mutated-text
 *   positive control.
 * CENSUS (stripped source): every policy writer goes through the one appender — every
 *   mergeBrokerageSettings call that writes a registered key names `policy:`; the policy columns,
 *   managed_agents authority/autonomy, ai_isa_settings and default_assignment_method writers each
 *   reach appendTenantPolicyVersion; the appender is the only tenant_policy_versions inserter —
 *   each with a positive control fixture.
 *
 *   10. (wave 102, 102D) the three stores 101A left unversioned — assignment_rules rows, the
 *      *_cadence_policy rows and brokerages.farm_mail_* — are versioned by their EXISTING server
 *      actions (create / edit / toggle / delete = v1..v4, null once deleted; cadence upserts;
 *      farm mail with the columns before as `previous`), shown by the constitution + history, and
 *      reverted through the same actions (a deleted rule is refused, said).
 *
 * BLIND SPOTS (published): the trigger is proven on its SQL text, not executed (m696 is written,
 * not applied); a writer that reaches brokerage_settings through an .rpc() or a dynamic table name
 * is invisible to the census; `active_listing_sources` is platform-governed and not a tenant policy.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"

const G = globalThis as any
G.__101A = { svc: null as MemClient | null, caller: null as any, events: [] as any[] }
const STUB: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__101A.svc",
  "@/lib/supabase/server": "export const createClient = async () => globalThis.__101A.svc",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}",
  "@/lib/kernel/emit": "export async function emitKernelEvent(i){ globalThis.__101A.events.push(i); return { inserted: true, lifecycleEventId: 'ev-' + globalThis.__101A.events.length, fanOutOk: true, error: null } }",
  "@/lib/auth/require-caller": "export async function requireCallerTenant(){ const c = globalThis.__101A.caller; return c ? { ok: true, ...c } : { ok: false, reason: 'unauthenticated', error: 'Not authenticated' } }",
  "@/lib/identity": "export async function getAgentContext(){ const c = globalThis.__101A.caller; return c ? { isAuthenticated: true, userId: c.userId, brokerageId: c.brokerageId, userType: c.userType, agentId: null, teamId: null } : { isAuthenticated: false } }",
  "@/lib/managers/autonomy-gate": "export function __clearAutonomyCache(){}",
  // 102D — the row-policy writers' gates (session-shaped, from the same caller fixture).
  "@/lib/identity/get-agent-context": "export async function getAgentContext(){ const c = globalThis.__101A.caller; return c ? { isAuthenticated: true, userId: c.userId, brokerageId: c.brokerageId, userType: c.userType, agentId: null, teamId: null } : { isAuthenticated: false } }",
  "@/lib/identity/policy-scope": "export async function resolvePolicyScopeAccess(){ const c = globalThis.__101A.caller; const admin = !!c && c.userType === 'broker'; return { tier: admin ? 'brokerage' : 'agent', canEditAgent: !!c, canEditTeam: false, canEditBrokerage: admin, agentScopeId: null, teamScopeIds: [], brokerageScopeId: admin ? c.brokerageId : null } }",
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
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const src = (p: string) => stripComments(raw(p))

const A = "00000000-0000-4000-8000-00000000000a"
const B = "00000000-0000-4000-8000-00000000000b"
const UA = "00000000-0000-4000-8000-0000000000a1"
const UB = "00000000-0000-4000-8000-0000000000b1"

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = `${dir}/${name}`
    const st = statSync(join(ROOT, p))
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

/** Balanced-paren slice of a call starting at `open` (the index of its "("). */
function callText(s: string, open: number): string {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++
    else if (s[i] === ")") { depth--; if (depth === 0) return s.slice(open, i + 1) }
  }
  return s.slice(open)
}

/** 102D — the row-policy stores the constitution now reads (empty = nothing configured). */
const ROW_POLICY_TABLES = () => ({ assignment_rules: [], agents: [], teams: [], blog_cadence_policy: [], newsletter_cadence_policy: [], social_cadence_policy: [] })
const AG = "00000000-0000-4000-8000-0000000000a9"

function versionsOf(svc: MemClient, brokerageId: string, key: string) {
  return (svc.tables.tenant_policy_versions ?? []).filter((r) => r.brokerage_id === brokerageId && r.policy_key === key).sort((a, b) => a.version - b.version)
}

async function main() {
  const tp = await import("../lib/kernel/tenant-policy")
  const { mergeBrokerageSettings } = await import("../lib/settings/brokerage-settings-merge")
  const actions = await import("../app/actions/admin/tenant-policy")

  // ── 1. a write creates version n+1 carrying the previous value ──────────────────────────────
  console.log("\n[1 — a policy write appends version n+1 carrying the previous value]")
  const svc = memSupabase({ brokerage_settings: [], tenant_policy_versions: [], brokerages: [{ id: A, default_assignment_method: "load_balance" }, { id: B }], managed_agents: [], ai_isa_settings: [], users: [], ...ROW_POLICY_TABLES() }, { stampCreatedAt: true })
  G.__101A.svc = svc
  const v1 = { disabled: ["send_sms"], custom: [] }
  const v2 = { disabled: [], custom: [] }
  const actor = { type: "user" as const, userId: UA, reason: "proof" }
  const w1 = await mergeBrokerageSettings(svc, A, { ai_agent_capabilities: v1 }, { policy: actor })
  check("first write ok and reports version 1", w1.ok && w1.policyVersions.length === 1 && w1.policyVersions[0].version === 1)
  const w2 = await mergeBrokerageSettings(svc, A, { ai_agent_capabilities: v2 }, { policy: actor })
  check("second write reports version 2", w2.ok && w2.policyVersions[0]?.version === 2)
  let rows = versionsOf(svc, A, "ai_agent_capabilities")
  check("2 version rows, numbered 1,2", rows.length === 2 && rows[0].version === 1 && rows[1].version === 2)
  check("v1.previous is null (no stored value before)", rows[0].previous === null)
  check("v2.previous carries v1's value", tp.samePolicyValue(rows[1].previous, v1) && tp.samePolicyValue(rows[1].value, v2))
  check("changed_by + actor_type are the named session actor", rows[1].changed_by === UA && rows[1].actor_type === "user")
  const w3 = await mergeBrokerageSettings(svc, A, { ai_agent_capabilities: { custom: [], disabled: [] } }, { policy: actor })
  check("a no-op write (same value, other key order) appends NOTHING", w3.ok && w3.policyVersions.length === 0 && versionsOf(svc, A, "ai_agent_capabilities").length === 2)
  const w4 = await mergeBrokerageSettings(svc, A, { business_registration: { ein: "x" } })
  check("a non-policy key appends NOTHING (positive: the write itself landed)", w4.ok && w4.policyVersions.length === 0 && (svc.tables.tenant_policy_versions as any[]).every((r) => r.policy_key !== "business_registration"))
  await mergeBrokerageSettings(svc, A, { contact_fatigue_weights: { a: 1 } })
  check("an UNATTRIBUTED policy write is still versioned, as actor 'system'", versionsOf(svc, A, "contact_fatigue_weights")[0]?.actor_type === "system")
  check("the live value stays in brokerage_settings (reads unchanged)", tp.samePolicyValue((svc.tables.brokerage_settings[0].settings as any).ai_agent_capabilities, v2))

  // ── 2. evidence ────────────────────────────────────────────────────────────────────────────
  console.log("\n[2 — every version leaves an auditOnly kernel event (LAW 5)]")
  const evs = G.__101A.events as any[]
  const vIds = (svc.tables.tenant_policy_versions as any[]).map((r) => r.id)
  check(`one tenant_policy.changed event per version (${evs.length} events / ${vIds.length} versions)`, evs.length === vIds.length && evs.every((e) => e.event === "tenant_policy.changed"))
  check("every event is auditOnly and names its version row", evs.every((e) => e.auditOnly === true && e.entityType === "tenant_policy_version" && vIds.includes(e.entityId)))

  // ── 3. revert writes a NEW version ─────────────────────────────────────────────────────────
  console.log("\n[3 — revertPolicy writes a NEW version through the survivor writer]")
  G.__101A.caller = { userId: UA, brokerageId: A, userType: "broker", platformRole: null, teamId: null }
  const rv = await actions.revertPolicy("ai_agent_capabilities", 1)
  rows = versionsOf(svc, A, "ai_agent_capabilities")
  check("revert ok → new version 3", rv.ok && (rv as any).newVersion === 3 && rows.length === 3)
  check("v3.value == v1.value, v3.previous == v2.value", tp.samePolicyValue(rows[2].value, v1) && tp.samePolicyValue(rows[2].previous, v2))
  check("v1 and v2 untouched (history never rewritten)", tp.samePolicyValue(rows[0].value, v1) && tp.samePolicyValue(rows[1].value, v2))
  check("the live value is v1's again", tp.samePolicyValue((svc.tables.brokerage_settings[0].settings as any).ai_agent_capabilities, v1))
  check("the revert is attributed to the session user with its reason", rows[2].changed_by === UA && /revert ai_agent_capabilities to v1/.test(rows[2].reason))
  const rvSame = await actions.revertPolicy("ai_agent_capabilities", 3)
  check("reverting to the value already live appends nothing", rvSame.ok && (rvSame as any).unchanged === true && versionsOf(svc, A, "ai_agent_capabilities").length === 3)
  const rvMissing = await actions.revertPolicy("ai_agent_capabilities", 99)
  check("a version that does not exist is refused", !rvMissing.ok)
  const rvBogus = await actions.revertPolicy("not_a_policy", 1)
  check("an unregistered key is refused", !rvBogus.ok)

  // ── 4. cross-tenant ────────────────────────────────────────────────────────────────────────
  console.log("\n[4 — a cross-tenant read / revert is refused]")
  ;(svc.tables.tenant_policy_versions as any[]).push({ id: "b-v5", brokerage_id: B, policy_key: "vendor_tier_pricing", version: 5, value: { basic: 1 }, previous: null, changed_by: UB, actor_type: "user", reason: "B", created_at: new Date().toISOString() })
  const hA = await actions.policyHistory("vendor_tier_pricing")
  check("tenant A's history of B's key is EMPTY", hA.ok && hA.rows.length === 0)
  const rvB = await actions.revertPolicy("vendor_tier_pricing", 5)
  check("tenant A cannot revert to tenant B's version", !rvB.ok && !(svc.tables.brokerage_settings[0].settings as any).vendor_tier_pricing)
  const cA = await actions.getTenantOperatingConstitution()
  check("A's constitution never shows B's version", cA.ok && cA.entries.find((e) => e.policyKey === "vendor_tier_pricing")?.version === 0)
  G.__101A.caller = { userId: UB, brokerageId: B, userType: "broker", platformRole: null, teamId: null }
  const hB = await actions.policyHistory("vendor_tier_pricing")
  check("POSITIVE CONTROL: tenant B reads its own version", hB.ok && hB.rows.length === 1 && hB.rows[0].version === 5)
  check("the actions take NO tenant argument (session only)", !/brokerageId/.test((actions.policyHistory as any).toString().split("{")[0]) && actions.revertPolicy.length === 2)

  // ── 5. non-admin refused; no versions keeps defaults ────────────────────────────────────────
  console.log("\n[5 — non-admin refused; a tenant with no versions keeps the defaults]")
  G.__101A.caller = { userId: UA, brokerageId: A, userType: "agent", platformRole: null, teamId: null }
  check("agent: history refused", !(await actions.policyHistory("ai_agent_capabilities")).ok)
  check("agent: revert refused", !(await actions.revertPolicy("ai_agent_capabilities", 1)).ok)
  check("agent: constitution refused", !(await actions.getTenantOperatingConstitution()).ok)
  const fresh = memSupabase({ brokerage_settings: [], tenant_policy_versions: [], brokerages: [{ id: A }], managed_agents: [], ai_isa_settings: [], users: [], ...ROW_POLICY_TABLES() })
  G.__101A.svc = fresh
  G.__101A.caller = { userId: UA, brokerageId: A, userType: "broker", platformRole: null, teamId: null }
  const c0 = await actions.getTenantOperatingConstitution()
  check("no versions: every registered key shows version 0 and default", c0.ok && c0.entries.length >= Object.keys(tp.TENANT_POLICY_SETTINGS_KEYS).length && c0.entries.every((e) => e.version === 0 && e.isDefault))
  const absent = memSupabase({ brokerage_settings: [], brokerages: [{ id: A }], managed_agents: [], ai_isa_settings: [], ...ROW_POLICY_TABLES() }, { missingTables: ["tenant_policy_versions"] })
  G.__101A.svc = absent
  const wAbsent = await mergeBrokerageSettings(absent, A, { lead_routing: { prefer_mailbox_owner: false } }, { policy: actor })
  check("m696 absent: the settings write still LANDS, the lost version is reported", wAbsent.ok && wAbsent.policyVersions[0]?.version === null && !!wAbsent.policyVersions[0]?.error && (absent.tables.brokerage_settings[0].settings as any).lead_routing.prefer_mailbox_owner === false)
  const cAbsent = await actions.getTenantOperatingConstitution()
  check("m696 absent: constitution still shows live values (versionsAvailable=false)", cAbsent.ok && cAbsent.versionsAvailable === false)
  const refused = memSupabase({ brokerage_settings: [], brokerages: [{ id: A }], managed_agents: [], ai_isa_settings: [], tenant_policy_versions: [] }, { refuse: { brokerage_settings: "permission denied" } })
  G.__101A.svc = refused
  check("a REFUSED live read refuses the constitution (never 'all defaults')", !(await actions.getTenantOperatingConstitution()).ok)

  // ── 6. other stores' writers ───────────────────────────────────────────────────────────────
  console.log("\n[6 — authority level and ISA settings are versioned by their survivor writers]")
  const mgr = memSupabase({ managed_agents: [{ id: "ma1", brokerage_id: A, agent_kind: "ai_isa", config: { authority_level: 4 }, archived_at: null }], tenant_policy_versions: [] })
  G.__101A.svc = mgr
  const evals = await import("../app/actions/admin/manager-evals")
  const sa = await evals.setManagerAuthorityLevel("ai_isa", 2 as any)
  const av = versionsOf(mgr, A, "authority_level:ai_isa")
  check("setManagerAuthorityLevel → version 1, previous 4, value 2", sa.ok && av.length === 1 && av[0].previous === 4 && av[0].value === 2 && av[0].changed_by === UA)
  await evals.setManagerAuthorityLevel("ai_isa", 5 as any)
  const ra = await actions.revertPolicy("authority_level:ai_isa", 1)
  const av3 = versionsOf(mgr, A, "authority_level:ai_isa")
  check("revert of authority level is a NEW version (3: value 2, previous 5) through setManagerAuthorityLevel",
    ra.ok && av3.length === 3 && av3[2].value === 2 && av3[2].previous === 5 && (mgr.tables.managed_agents[0].config as any).authority_level === 2)
  const isaSvc = memSupabase({ ai_isa_settings: [], tenant_policy_versions: [] })
  G.__101A.svc = isaSvc
  const { writeIsaSettings } = await import("../lib/ai-isa/resolve-isa-settings")
  const wi = await writeIsaSettings({ owner: { ownerType: "brokerage", ownerId: A }, brokerageId: A, updates: { max_touches_lead: 3 }, actor })
  const iv = versionsOf(isaSvc, A, "ai_isa_settings")
  check("writeIsaSettings (brokerage tier) → version 1, previous null (inherited)", wi.success && iv.length === 1 && iv[0].previous === null && (iv[0].value as any).max_touches_lead === 3)
  const wp = await writeIsaSettings({ owner: { ownerType: "platform", ownerId: null }, brokerageId: null, updates: { max_touches_lead: 9 } })
  check("the PLATFORM tier is not a tenant policy (no version)", wp.success && (isaSvc.tables.tenant_policy_versions as any[]).length === 1)

  // ── 7. migration m696 ─────────────────────────────────────────────────────────────────────
  console.log("\n[7 — m696: append-only trigger, RLS tenant read, service-role write]")
  const migFile = readdirSync(join(ROOT, "supabase/migrations")).find((f) => /^m696-/.test(f))
  check("m696 migration file exists", !!migFile)
  const sql = migFile ? raw(`supabase/migrations/${migFile}`).replace(/--[^\n]*/g, "") : ""
  const appendOnly = (s: string) =>
    /BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+public\.tenant_policy_versions/i.test(s) &&
    /RAISE\s+EXCEPTION/i.test(s) && /pg_trigger_depth\(\)\s*>\s*1/i.test(s)
  check("trigger refuses UPDATE and DELETE (cascade pass-through kept)", appendOnly(sql))
  check("POSITIVE CONTROL: a trigger without DELETE is flagged", !appendOnly(sql.replace(/UPDATE\s+OR\s+DELETE/i, "UPDATE")))
  const rls = (s: string) =>
    /ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(s) && /FOR\s+SELECT[\s\S]{0,80}has_brokerage_access\(brokerage_id\)/i.test(s) &&
    !/CREATE\s+POLICY[^;]*FOR\s+(INSERT|UPDATE|DELETE|ALL)/i.test(s)
  check("RLS: tenant-scoped SELECT, no write policy (service-role write only)", rls(sql))
  check("POSITIVE CONTROL: an added INSERT policy is flagged", !rls(sql + "\nCREATE POLICY x ON public.tenant_policy_versions FOR INSERT TO authenticated WITH CHECK (true);"))
  check("UNIQUE (brokerage_id, policy_key, version) + FKs brokerages / users",
    /UNIQUE\s*\(\s*brokerage_id\s*,\s*policy_key\s*,\s*version\s*\)/i.test(sql) && /REFERENCES\s+public\.brokerages\(id\)/i.test(sql) && /changed_by[^,]*REFERENCES\s+public\.users\(id\)/i.test(sql))
  const actorCheck = /actor_type_check\s+CHECK\s*\(actor_type IN \(([^)]*)\)\)/i.exec(sql)?.[1]
  const ledgerMig = raw("supabase/migrations/m687-action-ledger-and-event-causation.sql")
  const ledgerActor = /agent_action_ledger_actor_type_check\s+CHECK\s*\(actor_type IN \(([^)]*)\)\)/i.exec(ledgerMig)?.[1]
  check("actor_type vocabulary == agent_action_ledger's (one spelling, §6)", !!actorCheck && actorCheck === ledgerActor)
  const tsActor = /type:\s*("[a-z]+"(?:\s*\|\s*"[a-z]+")*)/.exec(src("lib/kernel/tenant-policy.ts"))?.[1]
  const sqlSet = new Set((actorCheck ?? "").match(/'([a-z]+)'/g)?.map((x) => x.slice(1, -1)))
  const tsSet = new Set((tsActor ?? "").match(/"([a-z]+)"/g)?.map((x) => x.slice(1, -1)))
  check("PolicyActor.type == the m696 CHECK (derived both sides)", sqlSet.size > 0 && sqlSet.size === tsSet.size && Array.from(tsSet).every((x) => sqlSet.has(x)))

  // ── 10. (102D) rows + farm mail are versioned by their existing actions ─────────────────────
  console.log("\n[10 — 102D: assignment rules, cadence rows and farm mail are versioned by their existing actions]")
  const rowSvc = memSupabase({
    brokerage_settings: [], tenant_policy_versions: [], managed_agents: [], ai_isa_settings: [], users: [],
    brokerages: [{ id: A, default_assignment_method: "load_balance", farm_mail_enabled: false, farm_mail_max_per_week: null, lob_fallback_template_id: null }],
    ...ROW_POLICY_TABLES(), agents: [{ id: AG, brokerage_id: A, user_id: UA }],
  }, { stampCreatedAt: true })
  G.__101A.svc = rowSvc
  G.__101A.caller = { userId: UA, brokerageId: A, userType: "broker", platformRole: null, teamId: null }
  const rules = await import("../app/actions/admin/assignment-rules")
  const created = await rules.saveAssignmentRuleAction({ name: "Round robin", ruleType: "round_robin", conditions: {}, agentIds: [AG], priority: 5 })
  const rid = created.ok ? created.id : ""
  const ruleKey = tp.assignmentRulePolicyKey(rid)
  let rv10 = versionsOf(rowSvc, A, ruleKey)
  check("creating a rule appends v1 (previous null, value = the rule's policy columns, actor = session user)",
    created.ok && rv10.length === 1 && rv10[0].previous === null && (rv10[0].value as any).name === "Round robin" && (rv10[0].value as any).priority === 5 && rv10[0].changed_by === UA)
  check("the key grammar: assignment_rule:<id> parses as kind rule, store assignment_rules", tp.parsePolicyKey(ruleKey)?.kind === "rule" && tp.parsePolicyKey(ruleKey)?.def.store === "assignment_rules")
  await rules.saveAssignmentRuleAction({ id: rid, name: "Round robin", ruleType: "round_robin", conditions: {}, agentIds: [AG], priority: 7 })
  rv10 = versionsOf(rowSvc, A, ruleKey)
  check("editing the rule appends v2 whose previous is v1's value", rv10.length === 2 && (rv10[1].previous as any).priority === 5 && (rv10[1].value as any).priority === 7)
  await rules.toggleAssignmentRuleAction(rid, false)
  rv10 = versionsOf(rowSvc, A, ruleKey)
  check("deactivating appends v3 (is_active false, previous active)", rv10.length === 3 && (rv10[2].value as any).is_active === false && (rv10[2].previous as any).is_active === true)
  const del = await rules.deleteAssignmentRuleAction(rid)
  rv10 = versionsOf(rowSvc, A, ruleKey)
  check("deleting appends v4 with value NULL and the row is gone (delete counted)", del.ok && rv10.length === 4 && rv10[3].value === null && (rowSvc.tables.assignment_rules as any[]).length === 0)
  G.__101A.caller = { userId: UB, brokerageId: B, userType: "broker", platformRole: null, teamId: null }
  const cross = await rules.saveAssignmentRuleAction({ id: rid, name: "x", ruleType: "round_robin", conditions: {}, agentIds: [], priority: 1 })
  check("another tenant cannot touch the rule (and no version is written under B)", !cross.ok && versionsOf(rowSvc, B, ruleKey).length === 0)
  G.__101A.caller = { userId: UA, brokerageId: A, userType: "broker", platformRole: null, teamId: null }

  const dm = await import("../app/actions/direct-mail-settings")
  const fm1 = await dm.saveFarmMailConfig({ farm_mail_enabled: true, farm_mail_max_per_week: 50, lob_fallback_template_id: "tmpl_1" })
  let fv = versionsOf(rowSvc, A, tp.FARM_MAIL_POLICY_KEY)
  check("farm mail: v1 carries the columns BEFORE as previous (off) and the saved config as value", fm1.success && fv.length === 1 && (fv[0].previous as any).farm_mail_enabled === false && (fv[0].value as any).farm_mail_max_per_week === 50 && fv[0].changed_by === UA)
  await dm.saveFarmMailConfig({ farm_mail_enabled: true, farm_mail_max_per_week: 50, lob_fallback_template_id: "tmpl_1" })
  check("farm mail: saving the same config appends NOTHING", versionsOf(rowSvc, A, tp.FARM_MAIL_POLICY_KEY).length === 1)
  await dm.saveFarmMailConfig({ farm_mail_enabled: true, farm_mail_max_per_week: 20, lob_fallback_template_id: "tmpl_1" })
  const rvFm = await actions.revertPolicy(tp.FARM_MAIL_POLICY_KEY, 1)
  fv = versionsOf(rowSvc, A, tp.FARM_MAIL_POLICY_KEY)
  check("farm mail: revert to v1 writes v3 THROUGH saveFarmMailConfig (live column back to 50)", rvFm.ok && rvFm.newVersion === 3 && fv.length === 3 && (fv[2].value as any).farm_mail_max_per_week === 50 && (rowSvc.tables.brokerages as any[])[0].farm_mail_max_per_week === 50)

  const mc = await import("../app/actions/marketing-cadence-policy")
  const nlKey = tp.cadencePolicyKey("newsletter_cadence_policy", "brokerage", A)
  const nl1 = await mc.upsertMarketingCadencePolicy({ channel: "newsletter", cadence: "weekly", fireDay: 1, scopeType: "brokerage" })
  await mc.upsertMarketingCadencePolicy({ channel: "newsletter", cadence: "monthly", fireDay: 3, scopeType: "brokerage" })
  const nv = versionsOf(rowSvc, A, nlKey)
  check("newsletter cadence (brokerage scope): v1 previous null, v2 previous = weekly", nl1.success && nv.length === 2 && nv[0].previous === null && (nv[1].previous as any).cadence === "weekly" && (nv[1].value as any).cadence === "monthly")
  check("the cadence key parses (table, scope type, scope id)", tp.parsePolicyKey(nlKey)?.kind === "cadence" && (tp.parsePolicyKey(nlKey) as any).table === "newsletter_cadence_policy")
  const bc = await import("../app/actions/blog-cadence-policy")
  const bl = await bc.upsertBlogCadencePolicy({ cadence: "biweekly", fireDay: 2, preferredCategories: null, preferredPersona: null, scopeType: "brokerage" })
  check("blog cadence (no brokerage_id column): v1 under the session tenant", bl.success && versionsOf(rowSvc, A, tp.cadencePolicyKey("blog_cadence_policy", "brokerage", A)).length === 1)

  const c10 = await actions.getTenantOperatingConstitution()
  const entry = (k: string) => c10.ok ? c10.entries.find((e) => e.policyKey === k) : undefined
  check("the constitution shows farm mail v3, newsletter cadence v2, blog cadence v1 and the deleted rule (v4, default)",
    c10.ok && entry(tp.FARM_MAIL_POLICY_KEY)?.version === 3 && entry(nlKey)?.version === 2 && entry(tp.cadencePolicyKey("blog_cadence_policy", "brokerage", A))?.version === 1
      && entry(ruleKey)?.version === 4 && entry(ruleKey)?.isDefault === true && entry(ruleKey)?.store === "assignment_rules")
  const h10 = await actions.policyHistory(ruleKey)
  check("history of the rule key is readable (4 versions, newest first)", h10.ok && h10.rows.length === 4 && h10.rows[0].version === 4)
  const rvRule = await actions.revertPolicy(ruleKey, 2)
  check("reverting a DELETED rule is refused and says why (never a silent new id)", !rvRule.ok && /no longer exists/.test(rvRule.ok ? "" : rvRule.error) && versionsOf(rowSvc, A, ruleKey).length === 4)
  const rvNl = await actions.revertPolicy(nlKey, 1)
  check("reverting the newsletter cadence writes v3 through the upsert action (live row weekly again)", rvNl.ok && rvNl.newVersion === 3 && (rowSvc.tables.newsletter_cadence_policy as any[])[0].cadence === "weekly")
  check("every row-policy version left its auditOnly evidence event", (G.__101A.events as any[]).filter((e) => e.event === "tenant_policy.changed" && e.brokerageId === A).length >= 10)

  // ── 8. census: every policy writer goes through the one appender ─────────────────────────────
  console.log("\n[8 — census: every policy writer reaches the one appender]")
  const files = [...walk("app"), ...walk("lib")]
  const keyConsts = new Map<string, string>()
  for (const f of walk("lib")) {
    for (const m of src(f).matchAll(/export const (\w+_KEY)\s*=\s*"([a-z_]+)"/g)) if (Object.prototype.hasOwnProperty.call(tp.TENANT_POLICY_SETTINGS_KEYS, m[2])) keyConsts.set(m[1], m[2])
  }
  const policyKeyRe = new RegExp(`\\b(${[...Object.keys(tp.TENANT_POLICY_SETTINGS_KEYS), ...keyConsts.keys()].join("|")})\\b`)
  const classify = (text: string) => ({ writesPolicy: policyKeyRe.test(text), attributed: /\bpolicy\s*:/.test(text) })
  const calls: Array<{ file: string; writesPolicy: boolean; attributed: boolean }> = []
  for (const f of files) {
    if (f === "lib/settings/brokerage-settings-merge.ts") continue
    const s = src(f)
    for (const m of s.matchAll(/mergeBrokerageSettings\s*\(/g)) {
      const t = callText(s, m.index! + m[0].length - 1)
      if (/^\(\s*\)$/.test(t)) continue
      calls.push({ file: f, ...classify(t) })
    }
  }
  const policyCalls = calls.filter((c) => c.writesPolicy)
  const unattributed = policyCalls.filter((c) => !c.attributed)
  console.log(`    mergeBrokerageSettings call sites: ${calls.length} (${policyCalls.length} write a policy key, ${calls.length - policyCalls.length} do not; derived key constants: ${Array.from(keyConsts.keys()).join(", ") || "none"})`)
  check(`every policy-key merge names its session actor (unattributed: ${unattributed.map((c) => c.file).join(", ") || "0"})`, policyCalls.length > 0 && unattributed.length === 0)
  check("POSITIVE CONTROL: a policy-key merge without `policy:` is flagged",
    classify(`(svc, b, { ai_agent_capabilities: x })`).writesPolicy && !classify(`(svc, b, { ai_agent_capabilities: x })`).attributed &&
    classify(`(svc, b, { [CONTACT_FATIGUE_WEIGHTS_KEY]: w })`).writesPolicy === keyConsts.has("CONTACT_FATIGUE_WEIGHTS_KEY"))

  // Direct writes that bypass the survivors.
  const bsWriters: string[] = [], maWriters: string[] = [], isaWriters: string[] = [], tpvInserters: string[] = [], damWriters: string[] = []
  for (const f of files) {
    const s = src(f)
    for (const m of s.matchAll(/\.from\(\s*"brokerage_settings"\s*\)/g)) {
      const tail = s.slice(m.index!, m.index! + 400)
      if (/^[\s\S]{0,40}\.(update|upsert|insert)\(/.test(tail.replace(/\s+/g, " ")) || /\.\s*(update|upsert|insert)\(\s*\{[^}]*\b(settings|review_request_delay_days|live_agent_face_provider_order)\s*:/.test(tail.slice(0, 260))) bsWriters.push(f)
    }
    if (/\bcfg\.(authority_level|autonomy_tier)\s*=/.test(s)) maWriters.push(f)
    for (const m of s.matchAll(/\.from\(\s*"ai_isa_settings"\s*\)/g)) if (/^\s*\.(update|upsert|insert|delete)\(/.test(s.slice(m.index! + m[0].length, m.index! + m[0].length + 40))) isaWriters.push(f)
    for (const m of s.matchAll(/\.from\(\s*"tenant_policy_versions"\s*\)/g)) if (/^\s*\.(insert|upsert|update|delete)\(/.test(s.slice(m.index! + m[0].length, m.index! + m[0].length + 40))) tpvInserters.push(f)
    if (/default_assignment_method\s*:\s*method/.test(s) && /\.update\(/.test(s)) damWriters.push(f)
  }
  const uniq = (a: string[]) => Array.from(new Set(a)).sort()
  const BS_ALLOWED = new Map([
    ["lib/settings/brokerage-settings-merge.ts", "THE jsonb writer (versions every changed policy key)"],
    ["lib/settings/brokerage-settings-columns.ts", "the two policy columns (versionColumn on each)"],
    ["app/actions/superadmin/active-listing-sources.ts", "active_listing_sources: PLATFORM-governed (superadmin), not tenant operating policy"],
  ])
  const bsOut = uniq(bsWriters).filter((f) => !BS_ALLOWED.has(f))
  check(`brokerage_settings is written only by its classified writers (unclassified: ${bsOut.join(", ") || "0"})`, bsOut.length === 0 && uniq(bsWriters).includes("lib/settings/brokerage-settings-merge.ts"))
  const cols = src("lib/settings/brokerage-settings-columns.ts")
  check("both policy-column writers append a version", (cols.match(/await versionColumn\(/g) ?? []).length === 2 && /appendTenantPolicyVersion\(/.test(cols))
  check(`managed_agents authority/autonomy is set only in manager-evals.ts (${uniq(maWriters).join(", ")})`, uniq(maWriters).join() === "app/actions/admin/manager-evals.ts")
  const me = src("app/actions/admin/manager-evals.ts")
  const fnBody = (s: string, name: string) => { const i = s.indexOf(`export async function ${name}(`); const j = s.indexOf("\nexport ", i + 10); return s.slice(i, j < 0 ? undefined : j) }
  check("setManagerAuthorityLevel + setManagerAutonomy each append a version", /appendTenantPolicyVersion\(/.test(fnBody(me, "setManagerAuthorityLevel")) && /appendTenantPolicyVersion\(/.test(fnBody(me, "setManagerAutonomy")))
  check(`ai_isa_settings is written only by resolve-isa-settings.ts (${uniq(isaWriters).join(", ")})`, uniq(isaWriters).join() === "lib/ai-isa/resolve-isa-settings.ts")
  const wis = fnBody(src("lib/ai-isa/resolve-isa-settings.ts"), "writeIsaSettings")
  check("writeIsaSettings versions BOTH its update and insert branch", (wis.match(/await versionIsaSettings\(/g) ?? []).length === 2)
  check(`default_assignment_method is written only in lead-routing-settings.ts, which appends a version (${uniq(damWriters).join(", ")})`,
    uniq(damWriters).join() === "app/actions/admin/lead-routing-settings.ts" && /appendTenantPolicyVersion\(/.test(fnBody(src("app/actions/admin/lead-routing-settings.ts"), "setDefaultAssignmentMethod")))
  check(`the ONE appender is the only tenant_policy_versions writer (${uniq(tpvInserters).join(", ")})`, uniq(tpvInserters).join() === "lib/kernel/tenant-policy.ts")
  check("POSITIVE CONTROL: the writer scan sees a fixture direct insert",
    /^\s*\.(insert|upsert|update|delete)\(/.test(`.insert({ brokerage_id: x })`) && /\bcfg\.(authority_level|autonomy_tier)\s*=/.test("cfg.authority_level = 3"))
  const isaCalls = src("app/actions/ai-isa-settings.ts").match(/writeIsaSettings\(\{[\s\S]*?\}\)/g) ?? []
  const isaTenant = isaCalls.filter((c) => !/ownerType:\s*'platform'/.test(c))
  check(`every tenant-tier writeIsaSettings call names its actor (${isaTenant.filter((c) => /actor:/.test(c)).length}/${isaTenant.length})`, isaTenant.length > 0 && isaTenant.every((c) => /actor:/.test(c)))
  const rp = fnBody(src("app/actions/admin/tenant-policy.ts"), "revertPolicy")
  check("revertPolicy writes only through survivor writers (never inserts a version itself)",
    /mergeBrokerageSettings\(/.test(rp) && /setManagerAuthorityLevel\(/.test(rp) && /writeIsaSettings\(/.test(rp) && /setDefaultAssignmentMethod\(/.test(rp) && !/\.insert\(/.test(rp))

  // ── 9. wired ───────────────────────────────────────────────────────────────────────────────
  console.log("\n[9 — wired on the EXISTING governance page]")
  check("manager-trust page renders TenantConstitutionPanel", /<TenantConstitutionPanel\b/.test(src("app/dashboard/admin/manager-trust/page.tsx")))
  const panel = src("app/dashboard/admin/manager-trust/tenant-constitution-panel.tsx")
  check("the panel reads the constitution + history and links History per key", /getTenantOperatingConstitution\(\)/.test(panel) && /policyHistory\(/.test(panel) && /\?policy=/.test(panel))
  check("the revert button calls revertPolicy", /revertPolicy\(/.test(src("app/dashboard/admin/manager-trust/revert-policy-button.tsx")))

  // ── 10. wave 102C (owner answer 4): the direct-mail bandit kill switch is a versioned policy key ──
  console.log("\n[10 — wave 102C: direct_mail_exploration — the bandit kill switch, versioned like experiments]")
  check("direct_mail_exploration is a registered settings policy key (beside experiments)",
    !!tp.TENANT_POLICY_SETTINGS_KEYS.direct_mail_exploration && !!tp.TENANT_POLICY_SETTINGS_KEYS.experiments && tp.parsePolicyKey("direct_mail_exploration")?.kind === "settings")
  {
    // The bandit on a fake client: policy + arms + outcomes in memory; the real pickVariantArm runs.
    const bandit = await import("../lib/direct-mail/variant-bandit")
    const T = A
    type Arm = { id: string; composition_id: string; copy_style: string; layout_variant: string; outcomes: Array<{ sends_count: number; scans_count: number; leads_count: number; last_send_at: string | null; last_scan_at: string | null }> }
    const now = new Date("2026-10-05T12:00:00Z")
    const fresh = now.toISOString()
    const arms: Arm[] = [
      { id: "arm-cold",  composition_id: "PostcardFront4x6", copy_style: "direct-fact",   layout_variant: "default", outcomes: [] },
      { id: "arm-weak",  composition_id: "PostcardFront4x6", copy_style: "question-hook", layout_variant: "default", outcomes: [{ sends_count: 200, scans_count: 4,  leads_count: 0, last_send_at: fresh, last_scan_at: fresh }] },
      { id: "arm-best",  composition_id: "PostcardFront4x6", copy_style: "social-proof",  layout_variant: "default", outcomes: [{ sends_count: 200, scans_count: 40, leads_count: 0, last_send_at: fresh, last_scan_at: fresh }] },
    ]
    const banditClient = (settings: unknown, opts: { refuseSettings?: boolean } = {}) => {
      const refused = { data: null, error: { code: "42501", message: "permission denied" } }
      return {
        from(table: string) {
          const b: any = {
            select: () => b, eq: () => b, order: () => b, limit: () => b,
            upsert: () => Promise.resolve({ data: null, error: null }),
            maybeSingle: () => Promise.resolve(table === "brokerage_settings" ? (opts.refuseSettings ? refused : { data: { settings }, error: null }) : { data: null, error: null }),
            then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
              Promise.resolve(table === "direct_mail_variants" ? { data: arms, error: null } : { data: [], error: null }).then(res, rej),
          }
          return b
        },
      }
    }
    const cohort = { brokerageId: T, persona: "first_time" as const, useKind: "farm_mail" as const, size: "4x6" as const }
    const frozenPicks = new Set<string>()
    for (let i = 0; i < 25; i++) frozenPicks.add((await bandit.pickVariantArm(cohort, { client: banditClient({ direct_mail_exploration: { frozen: true } }), now }))!.variantId)
    check("FROZEN: 25 picks all exploit the best-evidenced arm (highest posterior mean) — never the cold arm, never the weak one",
      frozenPicks.size === 1 && frozenPicks.has("arm-best"))
    const frozenPick = await bandit.pickVariantArm(cohort, { client: banditClient({ direct_mail_exploration: { frozen: true } }), now })
    check("FROZEN: the pick says so (policy.frozen, readable) and is not exploration", frozenPick?.policy.frozen === true && frozenPick?.policy.readable === true && frozenPick?.isExploration === false)
    const exploringPicks = new Set<string>()
    for (let i = 0; i < 400; i++) exploringPicks.add((await bandit.pickVariantArm(cohort, { client: banditClient({}), now }))!.variantId)
    check("POSITIVE CONTROL — EXPLORING (no policy): Thompson sampling still reaches the cold arm over 400 picks, and the best arm too",
      exploringPicks.has("arm-cold") && exploringPicks.has("arm-best"))
    const offPicks = new Set<string>()
    for (let i = 0; i < 400; i++) offPicks.add((await bandit.pickVariantArm(cohort, { client: banditClient({ direct_mail_exploration: { frozen: false } }), now }))!.variantId)
    check("frozen:false explores exactly like no policy", offPicks.has("arm-cold") && (await bandit.pickVariantArm(cohort, { client: banditClient({ direct_mail_exploration: { frozen: false } }), now }))?.policy.frozen === false)
    const refusedPick = await bandit.pickVariantArm(cohort, { client: banditClient({}, { refuseSettings: true }), now })
    check("FAIL CLOSED: a refused policy read freezes (readable:false, frozen:true → the best arm, no exploration spend)",
      refusedPick?.policy.readable === false && refusedPick?.policy.frozen === true && refusedPick?.variantId === "arm-best")
    const loaded = await bandit.loadDirectMailExplorationPolicy(banditClient({ direct_mail_exploration: { frozen: true } }) as any, T)
    check("loadDirectMailExplorationPolicy is the ONE reader (frozen:true read back; empty brokerageId → frozen, unreadable)",
      loaded.frozen === true && loaded.readable === true && (await bandit.loadDirectMailExplorationPolicy(banditClient({}) as any, "")).frozen === true)
  }
  {
    // The writer: ONE server action → mergeBrokerageSettings with the session actor → a version row.
    const fr = src("app/actions/flight-recorder.ts")
    const setFn = fr.slice(fr.indexOf("export async function setDirectMailExplorationFrozen"))
    check("setDirectMailExplorationFrozen: gate first (gateTenantAdmin), then mergeBrokerageSettings with `policy:` (versioned, attributed) — no tenant argument",
      /gateTenantAdmin\(\)/.test(setFn.slice(0, 400)) && /mergeBrokerageSettings\(/.test(setFn) && /policy:\s*\{\s*type:\s*"user",\s*userId:\s*gate\.userId/.test(setFn) && !/brokerageId\s*[:,]/.test(setFn.slice(0, setFn.indexOf("{"))))
    const svcK = memSupabase({ brokerage_settings: [], tenant_policy_versions: [], brokerages: [{ id: A }], users: [] }, { stampCreatedAt: true })
    const w = await mergeBrokerageSettings(svcK, A, (s: any) => ({ direct_mail_exploration: { ...(s.direct_mail_exploration ?? {}), frozen: true } }), { policy: { type: "user", userId: UA, reason: "direct-mail exploration frozen" } })
    const dv = (svcK.tables.tenant_policy_versions as any[]).filter((r) => r.policy_key === "direct_mail_exploration")
    check("freezing through the one writer appends direct_mail_exploration v1 (value frozen:true, previous null, the session user, its reason)",
      w.ok && w.policyVersions[0]?.key === "direct_mail_exploration" && dv.length === 1 && dv[0].value.frozen === true && dv[0].previous === null && dv[0].changed_by === UA && /frozen/.test(dv[0].reason))
    const w2 = await mergeBrokerageSettings(svcK, A, (s: any) => ({ direct_mail_exploration: { ...(s.direct_mail_exploration ?? {}), frozen: false } }), { policy: { type: "user", userId: UA, reason: "direct-mail exploration resumed" } })
    const dv2 = (svcK.tables.tenant_policy_versions as any[]).filter((r) => r.policy_key === "direct_mail_exploration")
    check("resuming appends v2 carrying v1 as previous (history, never a rewrite)", w2.ok && dv2.length === 2 && dv2[1].version === 2 && dv2[1].previous.frozen === true && dv2[1].value.frozen === false)
    const c = await tp.buildTenantOperatingConstitution(svcK, A)
    check("the Operating Constitution lists direct_mail_exploration with its version and changer (beside experiments)",
      c.ok && c.entries.some((e) => e.policyKey === "direct_mail_exploration" && e.version === 2 && e.changedBy === UA) && c.entries.some((e) => e.policyKey === "experiments"))
    // The toggle: on the Manager Trust page's constitution panel, beside the experiments toggle.
    const panelK = src("app/dashboard/admin/manager-trust/tenant-constitution-panel.tsx")
    check("Manager Trust panel toggles BOTH kill switches in place (setExperimentKillSwitch + setDirectMailExplorationFrozen) keyed by the constitution row",
      /setDirectMailExplorationFrozen\(/.test(panelK) && /setExperimentKillSwitch\(/.test(panelK) && /policyKey === "direct_mail_exploration"/.test(panelK) && /policyKey === "experiments"/.test(panelK) && /<KillSwitchToggle policyKey=\{e\.policyKey\}/.test(panelK))
    check("the bandit reads the policy on every pick (loadDirectMailExplorationPolicy inside pickVariantArm, before sampling)",
      (() => { const vb = src("lib/direct-mail/variant-bandit.ts"); const pick = vb.slice(vb.indexOf("export async function pickVariantArm")); return pick.indexOf("loadDirectMailExplorationPolicy(") > 0 && pick.indexOf("loadDirectMailExplorationPolicy(") < pick.indexOf("sampleBeta(") })())
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log(`FAILED:\n  - ${fails.join("\n  - ")}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
