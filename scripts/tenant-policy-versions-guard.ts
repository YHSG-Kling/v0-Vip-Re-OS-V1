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
 * BLIND SPOTS (published): the trigger is proven on its SQL text, not executed (m696 is written,
 * not applied); a writer that reaches brokerage_settings through an .rpc() or a dynamic table name
 * is invisible to the census; policy-like stores NOT registered (assignment_rules rows, *_cadence_policy
 * tables, brokerages.farm_mail_*) are out of scope and listed, not versioned.
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

function versionsOf(svc: MemClient, brokerageId: string, key: string) {
  return (svc.tables.tenant_policy_versions ?? []).filter((r) => r.brokerage_id === brokerageId && r.policy_key === key).sort((a, b) => a.version - b.version)
}

async function main() {
  const tp = await import("../lib/kernel/tenant-policy")
  const { mergeBrokerageSettings } = await import("../lib/settings/brokerage-settings-merge")
  const actions = await import("../app/actions/admin/tenant-policy")

  // ── 1. a write creates version n+1 carrying the previous value ──────────────────────────────
  console.log("\n[1 — a policy write appends version n+1 carrying the previous value]")
  const svc = memSupabase({ brokerage_settings: [], tenant_policy_versions: [], brokerages: [{ id: A, default_assignment_method: "load_balance" }, { id: B }], managed_agents: [], ai_isa_settings: [], users: [] }, { stampCreatedAt: true })
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
  const fresh = memSupabase({ brokerage_settings: [], tenant_policy_versions: [], brokerages: [{ id: A }], managed_agents: [], ai_isa_settings: [], users: [] })
  G.__101A.svc = fresh
  G.__101A.caller = { userId: UA, brokerageId: A, userType: "broker", platformRole: null, teamId: null }
  const c0 = await actions.getTenantOperatingConstitution()
  check("no versions: every registered key shows version 0 and default", c0.ok && c0.entries.length >= Object.keys(tp.TENANT_POLICY_SETTINGS_KEYS).length && c0.entries.every((e) => e.version === 0 && e.isDefault))
  const absent = memSupabase({ brokerage_settings: [], brokerages: [{ id: A }], managed_agents: [], ai_isa_settings: [] }, { missingTables: ["tenant_policy_versions"] })
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

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log(`FAILED:\n  - ${fails.join("\n  - ")}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
