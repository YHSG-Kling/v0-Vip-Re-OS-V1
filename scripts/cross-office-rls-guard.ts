#!/usr/bin/env tsx
/**
 * scripts/cross-office-rls-guard.ts   (tsx --conditions=react-server scripts/cross-office-rls-guard.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 150, lane 150BAA (directive 150B + 150AA, canary 2).
 *
 * TWO QUESTIONS, ONE PROOF, because they are the same boundary seen from two sides:
 *
 *   (1) SELF-HEAL AUTHORITY. "The OS may self-heal safe, scoped, tested configuration or code changes …
 *       never let a model silently alter authority rules, migrations, entitlements, legal terms,
 *       money/payouts or tenant visibility." The survivors are lib/kernel/self-healing.ts
 *       (classifyForbidden — the hard gate that runs before any model or playbook;
 *       governedChangeForDiagnosis) and lib/kernel/improvement-proposals.ts (classifyGovernedChange,
 *       promotionDecision, the PROPOSED → EVALUATED → APPROVED → PROMOTED → ROLLED_BACK machine).
 *       Section A drives each of the six named surfaces through EVERY door (incident text, the model's own
 *       flags, the diagnosis class, a learner's proposal, a manager's promotion) and asserts the refusal,
 *       with the positive controls that prove the gate is not blanket.
 *
 *   (2) CROSS-TENANT / CROSS-OFFICE / CROSS-BRAND RLS over the canary-2 surfaces: contacts, raw leads,
 *       offices, media, mail, QR, support tickets, portals, search logs, events, provider tokens, brand
 *       settings, seat rosters and every view.
 *
 * WHY THE RLS HALF READS POLICY TEXT, NOT ROWS. memSupabase (scripts/in-memory-supabase.ts) has no RLS, and
 * supabase-js can neither read pg_policies nor become a seat. So:
 *   · Section B proves the CODE-side office boundary (lib/kernel/egress-scope.ts) purely;
 *   · Section C holds the MIGRATION text (m999 — the fix this lane wrote — and the office-predicate census);
 *   · Section D judges the LIVE CATALOGUE: a JSON the integrator captures with the read-only SQL in
 *     $S/lane150BAA-notes.md "## Integrator SQL" Q1 and passes as CROSS_OFFICE_RLS_CATALOGUE=<path>.
 *     Absent → Section D is SKIPPED and says so (a blind spot, never a pass). Section D also PROJECTS
 *     m999 onto the captured catalogue (its ALTER POLICY / ALTER VIEW / REVOKE statements, parsed from the
 *     stripped file) and re-judges, so "m999 closes exactly these findings" is measured, not asserted.
 *
 * Blind spots are printed beside the numbers (end of run).
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripSqlComments } from "./strip-sql-comments"
import { classifyForbidden, governedChangeForDiagnosis } from "../lib/kernel/self-healing"
import { classifyGovernedChange, promotionDecision, canTransition, type ProposalActor } from "../lib/kernel/improvement-proposals"
import type { HealthIncident } from "../lib/kernel/os-health"
import { resolveEgressScope, scopeFilter } from "../lib/kernel/egress-scope"
import { SECRET_STORE_COLUMNS } from "../lib/security/credential-rotation"
import { LIVE_TABLES } from "./live-tables"

let pass = 0, fail = 0
const fails: string[] = []
const open: string[] = []
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; fails.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const publish = (line: string) => { open.push(line); console.log(`  · OPEN ${line}`) }

const ROOT = process.cwd()
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const SUB = "55555555-5555-4555-8555-555555555555"

// ── A. SELF-HEAL AUTHORITY ──────────────────────────────────────────────────
const inc = (x: Partial<HealthIncident>): HealthIncident => ({
  detector: "failed_webhooks", class: "unknown", brokerageId: A, subjectKey: `webhook_subscription:${SUB}`, subjectId: SUB,
  subjectType: "tenant_webhook_subscription", summary: "3 webhook deliveries dead after the drain's retries — 503 Service Unavailable",
  idempotent: false, evidence: { dead: 3, last_error: "503 Service Unavailable" }, ...x,
})

/** The directive's six "never silently alter" surfaces, each with the doors it must be refused at. */
const SIX: ReadonlyArray<{
  surface: string
  incidentSummary: string; gate: string
  flag: Record<string, boolean>
  dxClass: string
  proposalKey: string; patch: Record<string, unknown>; proposalClass: string
}> = [
  { surface: "authority rules", incidentSummary: "the ISA manager's authority level looks too low to clear the queue", gate: "authority", flag: { authority: true }, dxClass: "tenant_authority", proposalKey: "authority_level:ai_isa", patch: { level: 5 }, proposalClass: "tenant_authority" },
  { surface: "migrations", incidentSummary: "sync keeps failing until a migration adds the missing column", gate: "schema_migration", flag: { migration: true }, dxClass: "production_source_edit", proposalKey: "schema_migration:add_column", patch: { sql: "x" }, proposalClass: "production_source_edit" },
  { surface: "entitlements", incidentSummary: "renders blocked by the plan's entitlements for video", gate: "entitlement", flag: { entitlement: true }, dxClass: "financial_calculation", proposalKey: "tenant_entitlements", patch: { video_minutes: 999 }, proposalClass: "financial_calculation" },
  { surface: "legal terms", incidentSummary: "the SMS consent text fails the carrier's review", gate: "legal_terms", flag: { legalTerms: true }, dxClass: "legal_compliance", proposalKey: "sms_disclosures", patch: { footer: "x" }, proposalClass: "legal_compliance" },
  { surface: "money / payouts", incidentSummary: "commission payout events stuck in the queue", gate: "money", flag: { money: true }, dxClass: "money_movement", proposalKey: "payout_schedule", patch: { day: 1 }, proposalClass: "financial_calculation" },
  { surface: "tenant visibility", incidentSummary: "an office admin sees a cross-office contact list", gate: "tenant_boundary", flag: { tenantBoundary: true }, dxClass: "rls_security", proposalKey: "lead_visibility", patch: { agents_see_raw_leads: true }, proposalClass: "rls_security" },
]

const MANAGER: ProposalActor = { type: "manager", managerKey: "os_health_supervisor" }
const HIGH_GATE = { actorAuthority: 5 as const, autonomy: { allow: true, held: false, posture: null, reason: null } }

function sectionA() {
  console.log("\n[A · self-heal authority — the six surfaces refuse at every door]")
  const clean = classifyForbidden(inc({}))
  check("POSITIVE CONTROL a clean transient webhook incident is NOT gated (the gate is not blanket)", !clean.forbidden)
  check("POSITIVE CONTROL a clean diagnosis is a SAFE self_healing_repair", governedChangeForDiagnosis({ rootCause: "transient" }).verdict === "safe")
  for (const s of SIX) {
    const g = classifyForbidden(inc({ summary: s.incidentSummary }))
    check(`${s.surface}: incident text → hard gate ${s.gate} (before any model or playbook)`, g.forbidden && (g as { class: string }).class === s.gate, JSON.stringify(g))
    const gf = classifyForbidden(inc({}), s.flag as never)
    check(`${s.surface}: the model's own flag alone gates it (a model can only ADD a gate)`, gf.forbidden)
    const dx = governedChangeForDiagnosis({ rootCause: "configuration", touches: s.flag })
    check(`${s.surface}: diagnosis → CONSEQUENTIAL ${s.dxClass} (a change request for a human, never a playbook)`, dx.verdict === "consequential" && dx.class === s.dxClass && dx.managerMay === "propose_only", `${dx.class}/${dx.verdict}`)
    const row = { subject_kind: "policy", subject_key: s.proposalKey, proposer: "strategy_learning", proposed_change: { patch: s.patch } }
    const gc = classifyGovernedChange(row)
    check(`${s.surface}: a learner's proposal is CONSEQUENTIAL and NAMED (${s.proposalClass}, never "unlisted")`, gc.verdict === "consequential" && gc.class === s.proposalClass, `${gc.class}/${gc.verdict}: ${gc.reason}`)
    // A row written with a LOW stored rung by another path cannot smuggle it past the manager (the class is derived).
    const pd = promotionDecision({ status: "APPROVED", verdict: "pass", authorityRequired: 4, actor: MANAGER, gate: HIGH_GATE, governedChange: gc })
    check(`${s.surface}: a governed manager at rung 5, evaluation PASSED, autonomy allowing, low stored rung — still REFUSED`, !pd.allow, pd.reason)
  }
  // Positive controls for the promotion door (the gate refuses the class, not every promotion).
  const variant = classifyGovernedChange({ subject_kind: "variant", subject_key: "seller_sequence:step_2", proposer: "copy_learning", proposed_change: { winner: "b" } })
  check("POSITIVE CONTROL a sequence variant is SAFE (content_channel_selection)", variant.verdict === "safe", `${variant.class}`)
  check("POSITIVE CONTROL …and the governed manager MAY promote it within authority", promotionDecision({ status: "APPROVED", verdict: "pass", authorityRequired: 4, actor: MANAGER, gate: HIGH_GATE, governedChange: variant }).allow)
  const human = classifyGovernedChange({ subject_kind: "policy", subject_key: "lead_visibility", proposer: "human", proposed_change: { patch: { x: 1 } } })
  check("approval per risk: a tenant-admin HUMAN decides a consequential change (human authority, not the model)", promotionDecision({ status: "APPROVED", verdict: "inconclusive", authorityRequired: 6, actor: { type: "user", userId: "u", isTenantAdmin: true }, governedChange: human }).allow)
  check("…a non-admin human may not", !promotionDecision({ status: "APPROVED", verdict: "pass", authorityRequired: 6, actor: { type: "user", userId: "u", isTenantAdmin: false }, governedChange: human }).allow)
  check("…and an AI agent never promotes anything (LAW 4), even a safe variant", !promotionDecision({ status: "APPROVED", verdict: "pass", authorityRequired: 4, actor: { type: "agent" }, gate: HIGH_GATE, governedChange: variant }).allow)
  check("…and a FAILED test never promotes, whoever asks", !promotionDecision({ status: "APPROVED", verdict: "fail", authorityRequired: 4, actor: { type: "user", isTenantAdmin: true }, governedChange: variant }).allow)
  check("proposal → test → approval → promote: no state skips the test or the approval (PROPOSED ↛ APPROVED/PROMOTED, EVALUATED ↛ PROMOTED)", !canTransition("PROPOSED", "APPROVED") && !canTransition("PROPOSED", "PROMOTED") && !canTransition("EVALUATED", "PROMOTED") && canTransition("EVALUATED", "APPROVED"))
  check("rollback: a PROMOTED change can be ROLLED_BACK, and a rollback is terminal", canTransition("PROMOTED", "ROLLED_BACK") && !canTransition("ROLLED_BACK", "PROMOTED"))
}

// ── B. THE CODE-SIDE OFFICE / TEAM BOUNDARY (lib/kernel/egress-scope.ts) ────
function sectionB() {
  console.log("\n[B · office, team and seat scope — the code-side boundary, two same-name locations]")
  const L1: string = "11111111-1111-4111-8111-111111111111", L2: string = "22222222-2222-4222-8222-222222222222", T1 = "33333333-3333-4333-8333-333333333333"
  // Two offices BOTH named "Downtown" — the resolver keys on the id, never on a name.
  const offices = [{ id: L1, name: "Downtown" }, { id: L2, name: "Downtown" }]
  const head1 = scopeFilter(resolveEgressScope({ userType: "admin", userId: "h1", brokerageId: A, locationId: L1 }))
  const head2 = scopeFilter(resolveEgressScope({ userType: "admin", userId: "h2", brokerageId: A, locationId: L2 }))
  check("NEGATIVE same-name offices: office head 1 is pinned to ITS office id, not the other 'Downtown'", head1.location_id === L1 && head1.location_id !== L2 && offices[0].name === offices[1].name)
  check("NEGATIVE …and office head 2 to the other — the two filters never coincide", head2.location_id === L2 && head1.location_id !== head2.location_id)
  check("a compliance officer pinned to an office is office-scoped too (lane 90A admin tier)", scopeFilter(resolveEgressScope({ userType: "compliance_officer", userId: "c", brokerageId: A, locationId: L1 })).location_id === L1)
  const owner = resolveEgressScope({ userType: "broker_owner", userId: "o", brokerageId: A, locationId: L1 })
  check("aggregated view only with leadership access: broker / broker_owner / broker_admin see ALL locations", owner.seesAllLocations && !scopeFilter(owner).location_id)
  const lead = scopeFilter(resolveEgressScope({ userType: "team_lead", userId: "t", brokerageId: A, teamId: T1, locationId: L1 }))
  check("a team lead sees their TEAM (not the office, not the brokerage)", lead.team_id === T1 && !lead.location_id)
  const agent = scopeFilter(resolveEgressScope({ userType: "agent", userId: "ag", brokerageId: A, locationId: L1, teamId: T1 }))
  check("an agent sees their own work only (no office or team widening)", agent.agent_user_id === "ag" && !agent.location_id && !agent.team_id)
  const legacy = resolveEgressScope({ userType: "superadmin", userId: "s", brokerageId: A })
  check("NEGATIVE a global user_type ('superadmin') never widens a scope — it falls to own work", legacy.kind === "agent" && !legacy.seesAllLocations)
  check("every scope is tenant-scoped first (brokerage_id always present)", [head1, head2, lead, agent].every((f) => f.brokerage_id === A))
  const unpinned = resolveEgressScope({ userType: "admin", userId: "a", brokerageId: A, locationId: null })
  publish(`an admin with NO office (users.location_id NULL) sees the whole brokerage (m423 design: "NULL = not pinned"; kind=${unpinned.kind}) — office narrowing is an explicit admin act; 150C owns office membership`)
}

// ── C. THE MIGRATION TEXT ───────────────────────────────────────────────────
const M999 = "supabase/migrations/m999-views-stop-bypassing-rls-and-credential-stores-admit-staff-seats-only.sql"
const ESCAPE = /brokerage_id\s+IS\s+NULL\s*\)?\s*OR\b/i
const STAFF_GATE = /\b(is_tenant_staff_seat|is_platform_staff|is_platform_admin|is_brokerage_admin)\s*\(/
/** The credential stores: the four secret stores (the ONE list) + the calendar OAuth link beside them. */
const CREDENTIAL_TABLES = [...SECRET_STORE_COLUMNS.map((s) => s.table), "calendar_provider_accounts"]

interface ParsedAlter { kind: "policy"; policy: string; table: string; using: string | null; withCheck: string | null }
interface ParsedView { kind: "view_invoker" | "revoke"; view: string; role?: string }

/** Balanced-paren read of `KEYWORD ( … )` starting at idx; returns the inner text. */
function balanced(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++
    else if (src[i] === ")") { depth--; if (depth === 0) return src.slice(open + 1, i) }
  }
  return src.slice(open + 1)
}

function parseM999(sql: string): { policies: ParsedAlter[]; views: ParsedView[] } {
  const policies: ParsedAlter[] = []
  const views: ParsedView[] = []
  for (const stmt of sql.split(";")) {
    const s = stmt.trim()
    const ap = s.match(/^ALTER\s+POLICY\s+(\w+)\s+ON\s+(?:public\.)?(\w+)/i)
    if (ap) {
      const u = s.search(/\bUSING\s*\(/i), w = s.search(/\bWITH\s+CHECK\s*\(/i)
      policies.push({ kind: "policy", policy: ap[1], table: ap[2], using: u >= 0 ? balanced(s, s.indexOf("(", u)) : null, withCheck: w >= 0 ? balanced(s, s.indexOf("(", w)) : null })
      continue
    }
    const av = s.match(/^ALTER\s+VIEW\s+(?:public\.)?(\w+)\s+SET\s*\(\s*security_invoker\s*=\s*true\s*\)/i)
    if (av) { views.push({ kind: "view_invoker", view: av[1] }); continue }
    const rv = s.match(/^REVOKE\s+ALL\s+ON\s+(?:public\.)?(\w+)\s+FROM\s+(\w+)/i)
    if (rv) views.push({ kind: "revoke", view: rv[1], role: rv[2] })
  }
  return { policies, views }
}

function sectionC(): { policies: ParsedAlter[]; views: ParsedView[] } | null {
  console.log("\n[C · the migration text — m999 and the office-predicate census]")
  check("CONTROL the escape finder matches the 029/030 shape", ESCAPE.test("((brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id()))"))
  check("CONTROL …and not the bare tenant predicate", !ESCAPE.test("(brokerage_id = current_user_brokerage_id())"))
  check("CONTROL a SQL comment quoting the escape cannot manufacture a finding (stripped first)", !ESCAPE.test(stripSqlComments("-- was: (brokerage_id IS NULL) OR …\nALTER POLICY p ON public.t USING (true);")))
  check("CONTROL the m999 parser reads USING and WITH CHECK with nested parentheses", (() => {
    const p = parseM999("ALTER POLICY p ON public.t USING ((a = f()) AND g()) WITH CHECK ((b = h()));")
    return p.policies.length === 1 && p.policies[0].using === "(a = f()) AND g()" && p.policies[0].withCheck === "(b = h())"
  })())
  check(`the credential-store list is derived from SECRET_STORE_COLUMNS (${CREDENTIAL_TABLES.length}: ${CREDENTIAL_TABLES.join(", ")})`, CREDENTIAL_TABLES.length >= 5 && CREDENTIAL_TABLES.every((t) => (LIVE_TABLES as readonly string[]).includes(t)))

  if (!existsSync(join(ROOT, M999))) { check(`${M999} exists`, false); return null }
  const raw = readFileSync(join(ROOT, M999), "utf8")
  const line1 = raw.split("\n")[0]
  check("m999 line 1 is the APPLIED LIVE stamp (applied 2026-11-06 via Supabase MCP; the lane stamp retired with it — the rule, not a waypoint)", line1.startsWith("-- ── APPLIED LIVE "))
  const sql = stripSqlComments(raw)
  check("m999 is MCP-applicable and strictly narrowing: no DROP / CREATE POLICY, no DROP TABLE / VIEW, no GRANT", !/\b(DROP|CREATE)\s+POLICY\b|\bDROP\s+(TABLE|VIEW)\b|\bGRANT\b/i.test(sql))
  check("m999 introduces no untenanted-row escape", !ESCAPE.test(sql))
  const parsed = parseM999(sql)
  check(`m999 is non-degenerate (${parsed.policies.length} ALTER POLICY, ${parsed.views.filter((v) => v.kind === "view_invoker").length} security_invoker views, ${parsed.views.filter((v) => v.kind === "revoke").length} revokes)`, parsed.policies.length > 0 && parsed.views.length > 0)
  const credReads = parsed.policies.filter((p) => CREDENTIAL_TABLES.includes(p.table) && /_select$/.test(p.policy))
  check(`every credential store's SELECT is rewritten (${credReads.length}/${CREDENTIAL_TABLES.length})`, CREDENTIAL_TABLES.every((t) => credReads.some((p) => p.table === t)))
  check("…and each rewritten credential predicate carries a STAFF seat gate and the tenant predicate", credReads.every((p) => !!p.using && STAFF_GATE.test(p.using) && /current_user_brokerage_id\(\)/.test(p.using)))
  const invokers = new Set(parsed.views.filter((v) => v.kind === "view_invoker").map((v) => v.view))
  const anonRevoked = new Set(parsed.views.filter((v) => v.kind === "revoke" && v.role === "anon").map((v) => v.view))
  check("every view m999 makes security_invoker is also revoked from anon", [...invokers].every((v) => anonRevoked.has(v)))

  // The office-predicate census over EVERY migration (stripped): how many policies ever reference location_id.
  const files = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql"))
  let officePolicies = 0, policyStmts = 0
  for (const f of files) {
    const s = stripSqlComments(readFileSync(join(ROOT, "supabase/migrations", f), "utf8"))
    for (const stmt of s.split(";")) {
      if (!/\b(CREATE|ALTER)\s+POLICY\b/i.test(stmt)) continue
      policyStmts++
      if (/\blocation_id\b/.test(stmt)) officePolicies++
    }
  }
  check(`office-predicate census is non-degenerate (${policyStmts} policy statements over ${files.length} migrations)`, policyStmts > 500)
  publish(`${officePolicies} of ${policyStmts} migration policy statements reference location_id — the OFFICE boundary is enforced in CODE (egress-scope), not in RLS; an office-pinned admin's session client reads brokerage-wide`)
  return parsed
}

// ── D. THE LIVE CATALOGUE ───────────────────────────────────────────────────
interface Catalogue {
  captured_at: string
  tables: Array<{ table: string; rls: boolean; has_location_id: boolean; has_brokerage_id: boolean }>
  policies: Array<{ table: string; policy: string; cmd: string; permissive: string; roles: string[]; qual: string; with_check: string }>
  views: Array<{ view: string; security_invoker: boolean; anon_select: boolean; authenticated_select: boolean; owner_bypasses_rls: boolean }>
  seat_brokerage: Array<{ user_type: string; n: number; with_brokerage: number }>
}

/** Canary 2's surfaces → the live tables that carry them. */
const SURFACES: Record<string, string[]> = {
  contacts: ["contacts"],
  raw_leads: ["leads", "raw_scraped_leads"],
  offices: ["locations"],
  media: ["marketing_assets", "listing_media", "video_assets"],
  mail: ["direct_mail_campaigns", "direct_mail_recipients", "mail_tracking"],
  qr: ["qr_codes", "qr_scan_events", "marketing_asset_qr_links"],
  support_tickets: ["support_tickets", "support_ticket_messages"],
  portals: ["portal_contact_invites", "portal_access_logs", "portal_event_stream"],
  search: ["property_search_log", "lead_property_searches"],
  events: ["open_house_events", "calendar_events"],
  provider_tokens: CREDENTIAL_TABLES,
  brand: ["brokerage_brand_settings", "brand_templates", "teams"],
  seats: ["users", "agents", "team_members"],
}
/** Helpers whose body carries the tenant boundary (bodies read via pg_get_functiondef; the same list as
 *  scripts/cross-tenant-read-simulator.ts TENANT_HELPERS, plus the self-scoping ones). */
const CONFINING = /\b(current_user_brokerage_id|user_brokerage_ids|has_brokerage_access|can_access_support_ticket|vendor_has_contact_access|is_platform_admin|is_platform_staff)\s*\(|auth\.uid\(\)/
const LEAD_GATE = /\b(is_lead_visible_role|is_ai_isa_system|is_platform_admin)\s*\(/
/** raw_scraped_leads: its escape sits INSIDE is_ai_isa_system() — the platform ISA's own pool, no tenant seat reaches it. */
const ESCAPE_CARVE_OUT = new Set(["raw_scraped_leads.raw_scraped_leads_select"])

interface Judgement { unconfined: string[]; escapes: string[]; credentialUngated: string[]; leadsUngated: string[]; viewsBypassing: string[]; teamLeadBrokerageWide: string[] }

function judge(c: Catalogue): Judgement {
  const reads = c.policies.filter((p) => p.cmd === "SELECT" || p.cmd === "ALL")
  const key = (p: { table: string; policy: string }) => `${p.table}.${p.policy}`
  return {
    unconfined: reads.filter((p) => !CONFINING.test(p.qual)).map(key),
    escapes: reads.filter((p) => (ESCAPE.test(p.qual) || ESCAPE.test(p.with_check)) && !ESCAPE_CARVE_OUT.has(key(p))).map(key),
    credentialUngated: reads.filter((p) => CREDENTIAL_TABLES.includes(p.table) && !STAFF_GATE.test(p.qual)).map(key),
    leadsUngated: reads.filter((p) => SURFACES.raw_leads.includes(p.table) && !LEAD_GATE.test(p.qual)).map(key),
    viewsBypassing: c.views.filter((v) => v.owner_bypasses_rls && !v.security_invoker && (v.anon_select || v.authenticated_select)).map((v) => v.view),
    teamLeadBrokerageWide: reads.filter((p) => p.table === "contacts" && /'team_lead'/.test(p.qual) && !/\b(team_id|current_user_led_team_id|current_user_team_id|team_members)\b/.test(p.qual)).map(key),
  }
}

/** PURE — the catalogue as it reads once m999's statements are applied. */
function project(c: Catalogue, m: { policies: ParsedAlter[]; views: ParsedView[] }): Catalogue {
  const policies = c.policies.map((p) => {
    const a = m.policies.find((x) => x.table === p.table && x.policy === p.policy)
    return a ? { ...p, qual: a.using ?? p.qual, with_check: a.withCheck ?? p.with_check } : p
  })
  const views = c.views.map((v) => ({
    ...v,
    security_invoker: v.security_invoker || m.views.some((x) => x.kind === "view_invoker" && x.view === v.view),
    anon_select: v.anon_select && !m.views.some((x) => x.kind === "revoke" && x.view === v.view && x.role === "anon"),
    authenticated_select: v.authenticated_select && !m.views.some((x) => x.kind === "revoke" && x.view === v.view && x.role === "authenticated"),
  }))
  return { ...c, policies, views }
}

function sectionD(m999: { policies: ParsedAlter[]; views: ParsedView[] } | null) {
  const path = process.env.CROSS_OFFICE_RLS_CATALOGUE
  console.log("\n[D · the live catalogue — canary 2, cross-tenant / cross-office / cross-brand]")
  // Pure controls of the judge itself, run whether or not a catalogue is supplied.
  const fixture: Catalogue = {
    captured_at: "fixture", tables: [], seat_brokerage: [],
    policies: [
      { table: "platform_credentials", policy: "x_select", cmd: "SELECT", permissive: "PERMISSIVE", roles: ["authenticated"], qual: "((brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id()))", with_check: "" },
      { table: "leads", policy: "y_select", cmd: "SELECT", permissive: "PERMISSIVE", roles: ["public"], qual: "(brokerage_id = current_user_brokerage_id())", with_check: "" },
      { table: "user_catalogue", policy: "z", cmd: "SELECT", permissive: "PERMISSIVE", roles: ["authenticated"], qual: "true", with_check: "" },
    ],
    views: [{ view: "v_x", security_invoker: false, anon_select: true, authenticated_select: true, owner_bypasses_rls: true }],
  }
  const jf = judge(fixture)
  check("CONTROL the judge flags an escape, an ungated credential read, a tenant-only raw-lead read, an unconfined `true` and a bypassing view", jf.escapes.length === 1 && jf.credentialUngated.length === 1 && jf.leadsUngated.length === 1 && jf.unconfined.includes("user_catalogue.z") && jf.viewsBypassing.length === 1)
  const fixed = judge(project(fixture, { policies: [{ kind: "policy", table: "platform_credentials", policy: "x_select", using: "(brokerage_id = current_user_brokerage_id()) AND is_tenant_staff_seat()", withCheck: null }], views: [{ kind: "view_invoker", view: "v_x" }, { kind: "revoke", view: "v_x", role: "anon" }] }))
  check("CONTROL …and the projection clears exactly what it rewrites (escape, credential gate, view) while the raw-lead read stays flagged", fixed.escapes.length === 0 && fixed.credentialUngated.length === 0 && fixed.viewsBypassing.length === 0 && fixed.leadsUngated.length === 1)

  if (!path) { console.log("  · SKIPPED — CROSS_OFFICE_RLS_CATALOGUE not set (capture it with notes ## Integrator SQL Q1). The live half is a BLIND SPOT this run, never a pass."); return }
  if (!existsSync(path)) { check(`catalogue file ${path} exists`, false); return }
  const c = JSON.parse(readFileSync(path, "utf8")) as Catalogue
  console.log(`  · catalogue captured ${c.captured_at} — ${c.tables.length} tables, ${c.policies.length} read policies, ${c.views.length} views`)
  const present = new Set(c.tables.map((t) => t.table))
  const missing = Object.entries(SURFACES).flatMap(([s, ts]) => ts.filter((t) => !present.has(t)).map((t) => `${s}:${t}`))
  check(`every canary-2 surface's tables are in the catalogue (${Object.values(SURFACES).flat().length} tables over ${Object.keys(SURFACES).length} surfaces; missing ${missing.length})`, missing.length === 0, missing.join(", "))
  const noRls = c.tables.filter((t) => !t.rls).map((t) => t.table)
  check(`RLS is enabled on every canary table (${noRls.length} without)`, noRls.length === 0, noRls.join(", "))
  const noRead = c.tables.filter((t) => !c.policies.some((p) => p.table === t.table)).map((t) => t.table)
  check(`every canary table has a read policy (${noRead.length} have none — a table no session can read is a different bug)`, noRead.length === 0, noRead.join(", "))

  const contactAgent = c.policies.find((p) => p.table === "contacts" && /'agent'/.test(p.qual) && !/ARRAY/.test(p.qual))
  check("agents see CONTACTS only — their own: the agent contacts policy ties agent_id to auth.uid()", !!contactAgent && /agent_id\s*=/.test(contactAgent.qual) && /auth\.uid\(\)/.test(contactAgent.qual))
  check("support tickets are scoped by lane through can_access_support_ticket (tickets AND messages)", c.policies.filter((p) => SURFACES.support_tickets.includes(p.table)).every((p) => /can_access_support_ticket\(/.test(p.qual)))
  check("offices (locations) are tenant-confined", c.policies.filter((p) => p.table === "locations").every((p) => CONFINING.test(p.qual)))
  check("brand settings / templates / team branding are tenant-confined (cross-brand reads refused at the tenant line)", c.policies.filter((p) => SURFACES.brand.includes(p.table)).every((p) => /current_user_brokerage_id\(\)|users\.id = auth\.uid\(\)/.test(p.qual)))
  const nonStaffWithBrokerage = c.seat_brokerage.filter((s) => ["contact", "vendor"].includes(s.user_type) && s.with_brokerage > 0)
  check(`POSITIVE CONTROL non-staff seats carry users.brokerage_id (${nonStaffWithBrokerage.map((s) => `${s.user_type} ${s.with_brokerage}/${s.n}`).join(", ")}) — so a tenant-only predicate ADMITS them; the staff gate is load-bearing`, nonStaffWithBrokerage.length > 0)

  const j = judge(c)
  check(`no canary read policy is unconfined (${j.unconfined.length})`, j.unconfined.length === 0, j.unconfined.join(", "))
  check(`raw leads: every read is gated to lead-visible roles / the AI ISA / platform — agents never see raw leads (${j.leadsUngated.length} ungated)`, j.leadsUngated.length === 0, j.leadsUngated.join(", "))
  check(`no untenanted-row escape on a canary read (${j.escapes.length})`, j.escapes.length === 0, j.escapes.join(", "))
  check(`provider tokens: every credential-store read carries a STAFF seat gate (${j.credentialUngated.length} admit contacts / vendors)`, j.credentialUngated.length === 0, j.credentialUngated.join(", "))
  check(`nested seat views: no view runs as an RLS-bypassing owner for anon / authenticated (${j.viewsBypassing.length})`, j.viewsBypassing.length === 0, j.viewsBypassing.join(", "))
  check(`CLAUDE.md §4 "teams see only their own board": the team-lead contacts read names the team (${j.teamLeadBrokerageWide.length} read brokerage-wide)`, j.teamLeadBrokerageWide.length === 0, j.teamLeadBrokerageWide.join(", "))

  const officeTables = c.tables.filter((t) => t.has_location_id).map((t) => t.table)
  const officeReads = c.policies.filter((p) => officeTables.includes(p.table) && /\blocation_id\b/.test(p.qual))
  publish(`office columns live on ${officeTables.length} canary tables (${officeTables.join(", ")}); ${officeReads.length} read policies reference location_id — DB-level cross-office isolation does not exist; only the code-side egress scope (section B) separates offices`)
  const usersRead = c.policies.find((p) => p.table === "users" && /current_user_brokerage_id\(\)/.test(p.qual) && !STAFF_GATE.test(p.qual.replace(/is_platform_staff\(\)\s*OR/, "")))
  if (usersRead) publish(`PII: ${usersRead.table}.${usersRead.policy} lets every seat of the tenant (contacts and vendors included) read every users row of that tenant — integrator SQL S4`)

  if (!m999) return
  const after = judge(project(c, m999))
  check(`PROJECTED (m999 applied to this catalogue): escapes ${j.escapes.length} → ${after.escapes.length}, ungated credential reads ${j.credentialUngated.length} → ${after.credentialUngated.length}, bypassing views ${j.viewsBypassing.length} → ${after.viewsBypassing.length}`, after.escapes.length === 0 && after.credentialUngated.length === 0 && after.viewsBypassing.length === 0, JSON.stringify(after))
  check("PROJECTED m999 confines nothing it should not: no read policy becomes unconfined", after.unconfined.length <= j.unconfined.length)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Cross-office RLS + self-heal authority (wave 150, lane 150BAA)")
  console.log("══════════════════════════════════════════════════")
  sectionA()
  sectionB()
  const m = sectionC()
  sectionD(m)
  console.log("\n[blind spots — published beside the numbers]")
  for (const b of [
    "memSupabase has no RLS: sections C/D judge policy TEXT; only the integrator's anon probe (notes Q3) EXECUTES a policy",
    "helper BODIES (can_access_support_ticket, vendor_has_contact_access, is_tenant_staff_seat) are trusted as read once via pg_get_functiondef, not re-derived here",
    "RESTRICTIVE policies are not judged (none on the canary tables at capture); column grants are not judged either — at capture anon and authenticated held SELECT on every credential column, so RLS is the ONLY barrier in front of a token",
    "storage buckets (media / mail-proof files) are lane 150AAF's O1 owner SQL — not in this catalogue",
    "mail PROOFS have no dedicated table: the proof URL rides the direct_mail_* rows judged here",
    "global record search (contacts / listings / leads) has no survivor yet — app/components/layout/global-search.tsx searches pages only; lane 150QTV owns it, the RLS it must read through is judged here",
    "INSERT / UPDATE / DELETE policies are judged only where m999 rewrites them",
  ]) console.log(`  · ${b}`)
  console.log("\n──────────────────────────────────────────────────")
  if (open.length) { console.log(`OPEN (published, not failed): ${open.length}`) }
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" CROSS_OFFICE_RLS_FAIL"); process.exit(1) }
  console.log(" CROSS_OFFICE_RLS_PASS — the six never-alter surfaces refuse at every door, offices are separated by id in the code-side scope, and every canary read judged is tenant-confined")
}

main().catch((e) => { console.error(e); process.exit(1) })
