#!/usr/bin/env tsx
/**
 * scripts/brokerage-identity-guard.ts   (npm run test:brokerage-identity)
 * ─────────────────────────────────────────────────────────────────────────────
 * BROKERAGE IDENTITY + THE ONE SUBSCRIBER → BROKERAGE-LOCATION TRANSFER RAIL (wave 141, lane 141A).
 * Owner, 2026-10-14: "BROKERAGE NAME MATCH IS NEVER PROOF OF SAME TENANT; never merge by name;
 * identity uses canonical IDs + verified relationships … a deliberate relationship transfer …
 * idempotent, cannot cross to the wrong brokerage/location … provenance preserved."
 *
 * In memory (scripts/in-memory-supabase.ts: update()/delete() + .select() return the MATCHED rows —
 * writers COUNT, CLAUDE.md §3). The REAL createTenantCore, the REAL ledger (withActionLedger), the
 * REAL rail and the REAL default billing handoff run against the fake; the seams are the env-bound
 * services (users.ts movers, seat gate, entitlements, readiness, event bus, notifiers).
 *
 *  A. STATIC — no `.from("brokerages")` read in lib/ + app/ filters on `name` (stripped source,
 *     POSITIVE CONTROL); nothing filters on declared_affiliation; the voice-command name router is gone.
 *  B. SAME NAME, TWO TENANTS — createTenantCore with one brokerage name and two owners mints two
 *     tenants, two slugs, no cross-link; a third same-name tenant is a third.
 *  C. DECLARED AFFILIATION — tenant keys refused; stored on the declarer's row ONLY (one update, one
 *     column); the same-name neighbour untouched; degrades honestly without m765 (column missing).
 *  D. THE RAIL — request refusals (unknown email, already a member, a brokerage's agent, a solo
 *     target, a non-owner); the happy path end to end (members, every family, same-name decoy
 *     byte-untouched, trial billing closed by the REAL handoff, source ARCHIVED not deleted, readiness
 *     recorded, evidence + events + manager-routed bells); consent-missing refusal; wrong-actor /
 *     wrong-target refusals; a second run changes NOTHING (zero writes); a Stripe-billed source stalls
 *     at billing BEFORE archive and resumes without re-running finished steps; decline; a verification
 *     failure moves nothing.
 *  E. REGISTRATION + DERIVED VOCABULARIES — package.json + guard membership (regex, never a position),
 *     MAINTENANCE_DOMAINS (owner + co-owners in prose), TABLE_MANAGER, m765 header + CHECKs mirror the
 *     code vocabularies, every TRANSFER_DATA_FAMILIES table is live and carries brokerage_id, every
 *     human route is a registered MANAGERS key, the rail's only billing call is the seam, doors gated,
 *     cards wired, no "platform-covered" in tenant copy.
 *     E2 (wave 143G) FK CLOSURE — a moved family's FK children follow it: the landing-page tables are a
 *     zero-exception rule (positive control); the rest is a published FROZEN ceiling that only goes down.
 *  F. ARCHIVED SOURCE FORWARDS (wave 143G) — an archived workspace has no public surface of its own: its storefront
 *     redirects, and its website chat is served, by the brokerage of its COMPLETED transfer (one hop, fail closed:
 *     unreadable ⇒ 503, no transfer ⇒ 404); a same-name decoy is never the successor (positive control).
 * BLIND SPOTS (published): scripts/ is not scanned in A (its simulators look their own tagged test
 * brokerages up by name); the Stripe half of the handoff is lane 141H's (stubbed here); readiness is
 * a counted seam; RLS is not exercised (the fake has no policies); the FK-closure census reads the
 * GENERATED caches (a table created since the last regeneration is invisible to it); F proves the
 * storefront redirect by stripped source, not by a mounted Next request.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { stripComments } from "./strip-comments"
import { walkTs } from "./runtime-roots"
import { memSupabase, type Row, type MemClient } from "./in-memory-supabase"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { SCHEMA_FK_MAP } from "./schema-fk-map"
import { LIVE_TABLES } from "./live-tables"
import { MANAGERS, MAINTENANCE_DOMAINS, TABLE_MANAGER } from "../lib/kernel/manager-registry"
import { createTenantCore, type TenantCreationDeps } from "../lib/kernel/tenant-creation"
import { normalizeDeclaredAffiliation, declareBrokerageAffiliation, readDeclaredAffiliation, AFFILIATION_FORBIDDEN_KEYS } from "../lib/kernel/brokerage-identity"
// Wave 142 (lane 142A): the REAL billing orchestrator and the REAL Stripe-side gate run in D7 / D7b with only
// Stripe itself and the ledger client seamed — the actor the Stripe side is handed is the thing under proof.
import { handoffSubscriberBillingToBrokerage as orchestrateBillingHandoff } from "../lib/billing/subscriber-billing-handoff"
import { handoffSubscriberBillingToBrokerage as stripeSideHandoff } from "../lib/billing/subscriber-handoff"
import {
  requestBrokerageTransfer, recordBrokerageTransferConsent, runBrokerageTransferMigration, cancelBrokerageTransferRequest,
  listBrokerageTransferRequests, transferMigrationComplete, transferStepsPending, memberTargetRole,
  TRANSFER_DATA_FAMILIES, TRANSFER_HUMAN_ROUTES, TRANSFER_MIGRATION_STEPS, TRANSFER_STATUSES, TRANSFER_TARGET_ROLES,
  type BrokerageTransferDeps, type TransferRequestRow,
} from "../lib/kernel/brokerage-transfer"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const root = process.cwd()
const raw = (p: string) => readFileSync(join(root, p), "utf8")
const stripped = (p: string) => stripComments(raw(p))

// ═════════════════════════════════════════════════════════════════════════════
// A. STATIC — a name never selects a tenant
// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[A · no name-equality tenant routing in lib/ + app/ (stripped source)]")
const NAME_ROUTER = /\.from\(\s*["']brokerages["']\s*\)[\s\S]{0,400}?\.(ilike|like|eq|neq|in)\(\s*["']name["']/
const AFFILIATION_FILTER = /\.(ilike|like|eq|neq|in|contains)\(\s*["']declared_affiliation/
const files = [...walkTs(join(root, "lib")), ...walkTs(join(root, "app"))]
const nameRouters: string[] = []
const affiliationFilters: string[] = []
for (const f of files) {
  const s = stripComments(readFileSync(f, "utf8"))
  if (NAME_ROUTER.test(s)) nameRouters.push(f.slice(root.length + 1))
  if (AFFILIATION_FILTER.test(s)) affiliationFilters.push(f.slice(root.length + 1))
}
check(`CONTROL: the finder recognises a name router`, NAME_ROUTER.test(`const { data } = await svc.from("brokerages").select("id, name").ilike("name", \`%\${x}%\`).limit(1)`))
check(`CONTROL: a tombstone comment is not a call site`, !NAME_ROUTER.test(stripComments(`// used to be svc.from("brokerages").select("id").ilike("name", n)\nconst a = 1`)))
check(`0 brokerages reads filter on name across ${files.length} files (found ${nameRouters.length})`, nameRouters.length === 0, nameRouters.join(", "))
check(`0 reads filter on declared_affiliation (found ${affiliationFilters.length})`, affiliationFilters.length === 0, affiliationFilters.join(", "))
const voice = stripped("app/api/internal/voice-command/route.ts")
check("voice-command: the spoken-name router is gone; a named brokerage is refused with the act-as route", !/ilike\(\s*["']name["']/.test(voice) && /isn't an identity/.test(voice))

// ═════════════════════════════════════════════════════════════════════════════
// Fixture helpers
// ═════════════════════════════════════════════════════════════════════════════
const NOW = new Date("2026-10-14T12:00:00.000Z")
const TIERS = ["solo_agent", "team", "brokerage", "multi_location"]
function coreSeed(): Record<string, Row[]> {
  return {
    subscription_tiers: TIERS.map((t) => ({ id: `tier-${t}`, tier_name: t, is_active: true })),
    platform_config_snapshots: [], learning_modules: [], learning_assignments: [], platform_prospects: [], agent_action_ledger: [],
    lifecycle_events: [], ai_identity_profiles: [], agents: [], notifications: [], superadmin_audit_log: [], brokerages: [], users: [], subscriptions: [],
  }
}
function coreDeps(svc: MemClient): TenantCreationDeps {
  return {
    provisionOwner: async (p) => { const id = randomUUID(); await svc.from("users").insert({ id, email: p.email, first_name: p.firstName, last_name: p.lastName, user_type: "admin", brokerage_id: p.brokerageId }); return { success: true, userId: id, agentId: null, teamId: null, inviteSent: true } },
    domainRecords: async (p) => { await svc.from("agents").insert({ user_id: p.userId, brokerage_id: p.brokerageId }); return { success: true, agentId: "agt", coordinatorId: null, domainRecordsCreated: ["agents"] } },
    isaActor: async () => ({}), starterAssistant: async () => ({}), emitEvent: async () => ({ inserted: true }),
    curriculum: async () => ({ authored: 0, topics: 0 }), checkout: async () => ({ ok: true, url: "x", sessionId: "cs", setupFeeCents: 0, setupFeeWaived: false, recurringCents: 0 }) as any,
    accountRepair: async () => ({ success: true, repaired: [] }),
    operatingBaseline: async (_s, id) => ({ ok: true, websitePath: `/site/${id}`, snapshotVersion: null, items: [], refused: [], preserved: [] }),
    readiness: async () => ({ ready: true, blockers: [], checkedAt: NOW.toISOString() }),
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// B. SAME NAME, TWO TENANTS — the ONE core never merges by name
// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[B · a same-name second tenant is a second tenant (createTenantCore, in memory)]")
{
  const svc = memSupabase(coreSeed(), { uuidIds: true, stampCreatedAt: true })
  const deps = coreDeps(svc)
  const one = await createTenantCore(svc, { brokerageName: "Harbor Realty", adminEmail: "dana@solo.test", adminFirstName: "Dana", adminLastName: "Lee", tier: "solo_agent", signupSource: "self_serve", billing: { mode: "trial" }, callerUserId: null, declaredAffiliation: { name: "Harbor Realty", licenseState: "fl" } }, deps)
  const two = await createTenantCore(svc, { brokerageName: "Harbor Realty", adminEmail: "owner@harbor.test", adminFirstName: "Max", adminLastName: "Ng", tier: "brokerage", signupSource: "self_serve", billing: { mode: "trial" }, callerUserId: null }, deps)
  const three = await createTenantCore(svc, { brokerageName: "Harbor Realty", adminEmail: "team@harbor-north.test", adminFirstName: "Ivy", adminLastName: "Ko", tier: "team", signupSource: "self_serve", billing: { mode: "trial" }, callerUserId: null }, deps)
  check("three same-name signups all succeed", one.ok && two.ok && three.ok, [one.error, two.error, three.error].filter(Boolean).join(" | "))
  const ids = new Set([one.brokerageId, two.brokerageId, three.brokerageId])
  check("three DISTINCT tenants (ids)", ids.size === 3)
  const named = svc.tables.brokerages.filter((b) => b.name === "Harbor Realty")
  check("three brokerages rows named 'Harbor Realty'", named.length === 3)
  check("three distinct storefront slugs", new Set(named.map((b) => b.slug)).size === 3)
  const ownerOf = (id?: string) => svc.tables.users.filter((u) => u.brokerage_id === id)
  check("each owner sits in their OWN tenant (no owner re-pinned by name)", ownerOf(one.brokerageId).length === 1 && ownerOf(two.brokerageId).length === 1 && ownerOf(three.brokerageId).length === 1 && ownerOf(one.brokerageId)[0].email === "dana@solo.test")
  check("one subscription row per tenant, none shared", [one, two, three].every((r) => svc.tables.subscriptions.filter((s) => s.brokerage_id === r.brokerageId).length === 1))
  const solo = svc.tables.brokerages.find((b) => b.id === one.brokerageId)!
  check("the solo signup's declared affiliation is stored on ITS row (name + FL), the same-name brokerage's row carries none", solo.declared_affiliation?.name === "Harbor Realty" && solo.declared_affiliation?.license_state === "FL" && solo.declared_affiliation?.source === "signup" && !svc.tables.brokerages.find((b) => b.id === two.brokerageId)!.declared_affiliation)
  check("an org-tier signup never gets a declaration (it IS the brokerage)", !svc.tables.brokerages.find((b) => b.id === two.brokerageId)!.declared_affiliation)
  const core = stripped("lib/kernel/tenant-creation.ts")
  check("source: the core's pre-insert lookups are by users.email and brokerages.slug — never by name", /\.from\("users"\)\.select\("id, brokerage_id"\)\.eq\("email"/.test(core) && /\.eq\("slug", slug\)/.test(core) && !NAME_ROUTER.test(core))
}

// ═════════════════════════════════════════════════════════════════════════════
// C. DECLARED AFFILIATION — context only
// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[C · a declaration describes a brokerage, never points at one]")
{
  const refused = normalizeDeclaredAffiliation({ name: "Harbor Realty", brokerage_id: randomUUID() } as any, { userId: "u", source: "settings", now: NOW })
  check("a declaration carrying a tenant key is refused", !refused.ok && /never a tenant link/.test(refused.ok ? "" : refused.error))
  check(`every forbidden key is refused (${AFFILIATION_FORBIDDEN_KEYS.length})`, AFFILIATION_FORBIDDEN_KEYS.every((k) => !normalizeDeclaredAffiliation({ name: "X Realty", [k]: "y" } as any, { userId: "u", source: "settings" }).ok))
  const okN = normalizeDeclaredAffiliation({ name: "  Harbor Realty ", dba: "harbor realty", licenseState: "fl", state: "FL", externalRef: "OFF-12" }, { userId: "u", source: "settings", now: NOW })
  check("normalized: trimmed name, a DBA equal to the name dropped, states upper-cased, stamp + source", okN.ok && okN.affiliation.name === "Harbor Realty" && okN.affiliation.dba === null && okN.affiliation.license_state === "FL" && okN.affiliation.declared_at === NOW.toISOString() && okN.affiliation.source === "settings")
  check("a bad state code is refused", !normalizeDeclaredAffiliation({ name: "X Realty", state: "Florida" }, { userId: "u", source: "settings" }).ok)

  const A = randomUUID(), B = randomUUID()
  const svc = memSupabase({ brokerages: [{ id: A, name: "Harbor Realty", plan_tier: "solo_agent", declared_affiliation: null }, { id: B, name: "Harbor Realty", plan_tier: "brokerage", declared_affiliation: null }], users: [{ id: "u1", brokerage_id: A }], lifecycle_events: [] })
  const before = JSON.stringify(svc.tables.brokerages.find((b) => b.id === B))
  const events: Row[] = []
  const w0 = svc.writes.length
  const r = await declareBrokerageAffiliation(svc, A, { name: "Harbor Realty", city: "Tampa", state: "FL" }, { userId: "u1", source: "settings", now: NOW }, { emit: async (e) => { events.push(e); return {} } })
  check("declaration stored on the declarer's row", r.ok && svc.tables.brokerages.find((b) => b.id === A)!.declared_affiliation?.city === "Tampa")
  check("exactly ONE write: brokerages.declared_affiliation (+updated_at) on the declarer — no other table, no other row", svc.writes.length === w0 + 1 && svc.writes[w0].table === "brokerages" && svc.writes[w0].matched === 1 && Object.keys(svc.writes[w0].payload).sort().join(",") === "declared_affiliation,updated_at")
  check("the same-name brokerage tenant is byte-identical (no tenancy effect)", JSON.stringify(svc.tables.brokerages.find((b) => b.id === B)) === before)
  check("the declarer's own tenancy is unchanged", svc.tables.users[0].brokerage_id === A)
  check("audited: BROKERAGE_AFFILIATION_DECLARED on the declarer's tenant", events.length === 1 && events[0].event === "brokerage_affiliation_declared" && events[0].brokerageId === A && events[0].auditOnly === true)
  const read = await readDeclaredAffiliation(svc, A)
  check("read back", read.ok && read.affiliation?.name === "Harbor Realty")
  const svcNoCol = memSupabase({ brokerages: [{ id: A, name: "Harbor Realty" }] }, { missingColumns: { brokerages: ["declared_affiliation"] } })
  const miss = await declareBrokerageAffiliation(svcNoCol, A, { name: "Harbor Realty" }, { userId: "u1", source: "settings" }, { emit: async () => ({}) })
  check("without m765 the write is REFUSED and reported as column-missing (never swallowed; tenant untouched)", !miss.ok && miss.columnMissing === true)
}

// ═════════════════════════════════════════════════════════════════════════════
// D. THE RAIL
// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[D · the transfer rail end to end (in memory, real ledger, real default billing handoff)]")

interface Fixture { T: string; S: string; D: string; B2: string; A: string; O: string; ISA: string; DO: string; B2A: string; B2AG: string; S2: string; O2: string }
function railSeed(): { seed: Record<string, Row[]>; f: Fixture } {
  const f: Fixture = { T: randomUUID(), S: randomUUID(), D: randomUUID(), B2: randomUUID(), A: randomUUID(), O: randomUUID(), ISA: randomUUID(), DO: randomUUID(), B2A: randomUUID(), B2AG: randomUUID(), S2: randomUUID(), O2: randomUUID() }
  const seed: Record<string, Row[]> = {
    brokerages: [
      { id: f.T, name: "Harbor Realty", plan_tier: "brokerage", status: "active", deleted_at: null, archived_at: null, ai_isa_system_user_id: null },
      { id: f.S, name: "Harbor Realty", plan_tier: "solo_agent", status: "active", deleted_at: null, archived_at: null, ai_isa_system_user_id: f.ISA },
      { id: f.D, name: "Harbor Realty", plan_tier: "solo_agent", status: "active", deleted_at: null, archived_at: null, ai_isa_system_user_id: null },
      { id: f.B2, name: "Other Brokerage", plan_tier: "brokerage", status: "active", deleted_at: null, archived_at: null, ai_isa_system_user_id: null },
      { id: f.S2, name: "Harbor Realty", plan_tier: "team", status: "active", deleted_at: null, archived_at: null, ai_isa_system_user_id: null },
    ],
    users: [
      { id: f.A, email: "max@harbor.test", brokerage_id: f.T, user_type: "broker_owner", platform_role: null, first_name: "Max", last_name: "Ng", team_id: null },
      { id: f.O, email: "dana@solo.test", brokerage_id: f.S, user_type: "admin", platform_role: null, first_name: "Dana", last_name: "Lee", team_id: null },
      { id: f.ISA, email: "isa@solo.test", brokerage_id: f.S, user_type: "isa", platform_role: "ai_isa_system", first_name: "ISA", last_name: "", team_id: null },
      { id: f.DO, email: "decoy@solo.test", brokerage_id: f.D, user_type: "admin", platform_role: null, first_name: "Dee", last_name: "Coy", team_id: null },
      { id: f.B2A, email: "admin@other.test", brokerage_id: f.B2, user_type: "broker_owner", platform_role: null, first_name: "Al", last_name: "Bee", team_id: null },
      { id: f.B2AG, email: "agent@other.test", brokerage_id: f.B2, user_type: "agent", platform_role: null, first_name: "Ag", last_name: "Ent", team_id: null },
      { id: f.O2, email: "ivy@team.test", brokerage_id: f.S2, user_type: "admin", platform_role: null, first_name: "Ivy", last_name: "Ko", team_id: "team-s2" },
      { id: randomUUID(), email: "member@team.test", brokerage_id: f.S2, user_type: "agent", platform_role: null, first_name: "Mem", last_name: "Ber", team_id: "team-s2" },
    ],
    agents: [{ id: "ag-o", user_id: f.O, brokerage_id: f.S, team_id: null }, { id: "ag-do", user_id: f.DO, brokerage_id: f.D, team_id: null }, { id: "ag-o2", user_id: f.O2, brokerage_id: f.S2, team_id: "team-s2" }],
    teams: [{ id: "team-s2", brokerage_id: f.S2, team_lead_id: f.O2, name: "Harbor North" }],
    user_role_assignments: [{ id: "ura-o", user_id: f.O, role: "admin", brokerage_id: f.S }, { id: "ura-do", user_id: f.DO, role: "admin", brokerage_id: f.D }, { id: "ura-o2", user_id: f.O2, role: "admin", brokerage_id: f.S2 }],
    subscriptions: [
      { id: "sub-t", brokerage_id: f.T, status: "active", stripe_subscription_id: "sub_T", stripe_customer_id: "cus_T", trial_end: null, current_period_end: "2026-11-01", created_at: "2026-01-01" },
      { id: "sub-s", brokerage_id: f.S, status: "trialing", stripe_subscription_id: null, stripe_customer_id: null, trial_end: "2026-10-28", current_period_end: "2026-10-28", created_at: "2026-10-01" },
      { id: "sub-d", brokerage_id: f.D, status: "trialing", stripe_subscription_id: null, stripe_customer_id: null, trial_end: "2026-10-28", current_period_end: "2026-10-28", created_at: "2026-10-01" },
      { id: "sub-s2", brokerage_id: f.S2, status: "active", stripe_subscription_id: "sub_S2", stripe_customer_id: "cus_S2", trial_end: null, current_period_end: "2026-11-01", created_at: "2026-09-01" },
      { id: "sub-b2", brokerage_id: f.B2, status: "active", stripe_subscription_id: "sub_B2", stripe_customer_id: "cus_B2", trial_end: null, current_period_end: "2026-11-01", created_at: "2026-01-01" },
    ],
    brokerage_transfer_requests: [], agent_action_ledger: [], notifications: [], lifecycle_events: [],
  }
  for (const fam of TRANSFER_DATA_FAMILIES) seed[fam.table] = []
  // The source's business rows + the same-name decoy's — every family gets one of each so the move is total.
  for (const fam of TRANSFER_DATA_FAMILIES) {
    seed[fam.table].push({ id: `${fam.table}-s`, brokerage_id: f.S, agent_id: "ag-o", label: `S ${fam.table}` })
    seed[fam.table].push({ id: `${fam.table}-d`, brokerage_id: f.D, agent_id: "ag-do", label: `D ${fam.table}` })
    seed[fam.table].push({ id: `${fam.table}-s2`, brokerage_id: f.S2, agent_id: "ag-o2", label: `S2 ${fam.table}` })
  }
  seed.contacts.push({ id: "contacts-s-2", brokerage_id: f.S, agent_id: "ag-o", label: "S second contact" })
  return { seed, f }
}

interface Spies { moved: string[]; roles: Array<{ userId: string; newRole: string; brokerageId: string }>; domain: number; events: Row[]; admins: Row[]; staff: Row[]; readiness: number; billing: number }
const spies = (): Spies => ({ moved: [], roles: [], domain: 0, events: [], admins: [], staff: [], readiness: 0, billing: 0 })
function railDeps(svc: MemClient, s: Spies, over: Partial<BrokerageTransferDeps> & { ready?: boolean } = {}): BrokerageTransferDeps {
  return {
    now: () => NOW,
    assignUserToBrokerage: async (p) => {
      s.moved.push(p.userId)
      await svc.from("users").update({ brokerage_id: p.brokerageId }).eq("id", p.userId)
      await svc.from("agents").update({ brokerage_id: p.brokerageId }).eq("user_id", p.userId)
      await svc.from("user_role_assignments").update({ brokerage_id: p.brokerageId }).eq("user_id", p.userId)
      return { success: true }
    },
    assignRole: async (p) => {
      s.roles.push({ userId: p.userId, newRole: p.newRole, brokerageId: p.brokerageId })
      await svc.from("users").update({ user_type: p.newRole }).eq("id", p.userId)
      await svc.from("user_role_assignments").upsert({ user_id: p.userId, role: p.newRole, brokerage_id: p.brokerageId, team_id: p.teamId ?? null }, { onConflict: "user_id,role" })
      return { success: true }
    },
    domainRecords: async (p) => {
      s.domain++
      const { data } = await svc.from("agents").select("id").eq("user_id", p.userId).maybeSingle()
      if (!data) await svc.from("agents").insert({ user_id: p.userId, brokerage_id: p.brokerageId })
      return { success: true, agentId: "ag", coordinatorId: null, domainRecordsCreated: [] }
    },
    seatGate: async () => ({ allowed: true, reason: "within_limit", message: null }),
    mayUseAndAfford: async () => ({ allowed: true, reason: "ok" }),
    readiness: async () => { s.readiness++; return { ready: over.ready ?? true, blockers: over.ready === false ? ["seats: fixture blocker"] : [], checkedAt: NOW.toISOString() } },
    emit: async (e) => { s.events.push(e); return {} },
    notifyAdmins: async (_c, brokerageId, n) => { s.admins.push({ brokerageId, ...n }); return 2 },
    notifyStaff: async (_c, n) => { s.staff.push(n); return 1 },
    ...over,
  }
}
const ledgerRows = (svc: MemClient, action: string) => svc.tables.agent_action_ledger.filter((r) => r.action === action)

// ── D1 · request refusals ────────────────────────────────────────────────────
{
  const { seed, f } = railSeed()
  const svc = memSupabase(seed, { uuidIds: true })
  const s = spies(); const deps = railDeps(svc, s)
  const base = { targetBrokerageId: f.T, initiatedByUserId: f.A, targetRole: "agent" as const }
  const r1 = await requestBrokerageTransfer(svc, { ...base, subjectEmail: "nobody@nowhere.test" }, deps)
  check("refused: unknown account email", !r1.ok && /No account/.test(r1.ok ? "" : r1.error))
  const r2 = await requestBrokerageTransfer(svc, { ...base, subjectEmail: "max@harbor.test" }, deps)
  check("refused: already a member of the target", !r2.ok && /already a member/.test(r2.ok ? "" : r2.error))
  const r3 = await requestBrokerageTransfer(svc, { ...base, subjectEmail: "agent@other.test" }, deps)
  check("refused: a brokerage-tier tenant's agent is not an independent subscriber (cannot be adopted away)", !r3.ok && /not an independent/.test(r3.ok ? "" : r3.error))
  const r4 = await requestBrokerageTransfer(svc, { ...base, subjectEmail: "member@team.test" }, deps)
  check("refused: a team member who is not the team tenant's owner", !r4.ok && /not the owner/.test(r4.ok ? "" : r4.error))
  const r5 = await requestBrokerageTransfer(svc, { targetBrokerageId: f.S, initiatedByUserId: f.O, subjectEmail: "decoy@solo.test", targetRole: "agent" }, deps)
  check("refused: a solo workspace cannot adopt", !r5.ok && /solo workspace cannot adopt/.test(r5.ok ? "" : r5.error))
  const r6 = await requestBrokerageTransfer(svc, { ...base, subjectEmail: "dana@solo.test", targetRole: "broker_owner" as any }, deps)
  check("refused: an admin seat by adoption", !r6.ok && /must be one of/.test(r6.ok ? "" : r6.error))
  const r7 = await requestBrokerageTransfer(svc, { ...base, subjectEmail: "dana@solo.test" }, railDeps(svc, s, { seatGate: async () => ({ allowed: false, reason: "over_limit", message: "No seat left (fixture)" }) }))
  check("refused: the target has no seat (seatGate fails closed)", !r7.ok && /No seat left/.test(r7.ok ? "" : r7.error))
  const r8 = await requestBrokerageTransfer(svc, { ...base, subjectEmail: "dana@solo.test" }, railDeps(svc, s, { mayUseAndAfford: async () => ({ allowed: false, reason: "past_due" }) }))
  check("refused: the target cannot use the platform (mayUseAndAfford)", !r8.ok && /past_due/.test(r8.ok ? "" : r8.error))
  check("no request row and no ledger row was written by a refusal", svc.tables.brokerage_transfer_requests.length === 0 && svc.tables.agent_action_ledger.length === 0)
}

// ── D2–D6 · the happy path, consent-missing, wrong actors, idempotency ───────
{
  const { seed, f } = railSeed()
  const svc = memSupabase(seed, { uuidIds: true })
  const s = spies(); const deps = railDeps(svc, s)
  const decoyBefore = JSON.stringify(Object.fromEntries(Object.entries(svc.tables).map(([t, rows]) => [t, rows.filter((r) => r.brokerage_id === f.D || r.id === f.D || r.user_id === f.DO)])))
  const b2Before = JSON.stringify(Object.fromEntries(Object.entries(svc.tables).map(([t, rows]) => [t, rows.filter((r) => r.brokerage_id === f.B2 || r.id === f.B2)])))

  const req = await requestBrokerageTransfer(svc, { targetBrokerageId: f.T, initiatedByUserId: f.A, subjectEmail: "Dana@Solo.test", targetRole: "agent", reason: "Welcome aboard" }, deps)
  check("request filed by the target admin, keyed on the owner's email (case-insensitive)", req.ok, req.ok ? "" : req.error)
  const row = req.ok ? req.request : (null as unknown as TransferRequestRow)
  check("request row: tenant pin = target, source = the owner's tenant, status requested, subject = the owner", row.brokerage_id === f.T && row.target_brokerage_id === f.T && row.source_brokerage_id === f.S && row.status === "requested" && row.subject_user_id === f.O)
  check("the subject was belled on THEIR tenant through the Recruiting Manager (consent_requested)", svc.tables.notifications.some((n) => n.user_id === f.O && n.brokerage_id === f.S && n.type === "brokerage_transfer_consent_requested" && /Recruiting Manager/.test(n.title)))
  check("evidence: one ledger row tenant.transfer.request (executed) + the requested event", ledgerRows(svc, "tenant.transfer.request").length === 1 && ledgerRows(svc, "tenant.transfer.request")[0].status === "executed" && s.events.some((e) => e.event === "brokerage_transfer_requested" && e.brokerageId === f.T))
  const dup = await requestBrokerageTransfer(svc, { targetBrokerageId: f.B2, initiatedByUserId: f.B2A, subjectEmail: "dana@solo.test", targetRole: "agent" }, deps)
  check("a second brokerage cannot open a competing request while one is open", !dup.ok && /already has an open adoption request/.test(dup.ok ? "" : dup.error))

  // consent-missing refusal
  const w = svc.writes.length
  const early = await runBrokerageTransferMigration(svc, { requestId: row.id, actor: { userId: f.A, brokerageId: f.T, kind: "target_admin" } }, deps)
  check("CONSENT MISSING: migration refused before consent, zero writes", !early.ok && /not consented/.test(early.ok ? "" : early.error) && svc.writes.length === w)
  // wrong actors
  const wrongConsent = await recordBrokerageTransferConsent(svc, { requestId: row.id, actor: { userId: f.DO, brokerageId: f.D, kind: "subject" }, decision: "consent", statement: "I consent to this adoption.", channel: "settings_ui" }, deps)
  check("WRONG ACTOR: the same-name decoy's owner cannot consent to a request addressed to another owner", !wrongConsent.ok && /Only the owner/.test(wrongConsent.ok ? "" : wrongConsent.error))
  const wrongCancel = await cancelBrokerageTransferRequest(svc, { requestId: row.id, actor: { userId: f.B2A, brokerageId: f.B2, kind: "target_admin" } }, deps)
  check("WRONG TARGET: another brokerage's admin cannot cancel it", !wrongCancel.ok && /another brokerage/.test(wrongCancel.error ?? ""))
  const wrongRun = await runBrokerageTransferMigration(svc, { requestId: row.id, actor: { userId: f.B2A, brokerageId: f.B2, kind: "target_admin" } }, deps)
  check("WRONG TARGET: another brokerage's admin cannot run it", !wrongRun.ok && /another brokerage/.test(wrongRun.ok ? "" : wrongRun.error))
  const shortStatement = await recordBrokerageTransferConsent(svc, { requestId: row.id, actor: { userId: f.O, brokerageId: f.S, kind: "subject" }, decision: "consent", statement: "ok", channel: "settings_ui" }, deps)
  check("consent needs the owner's own statement (evidence)", !shortStatement.ok)
  check("nothing moved under the refusals: the owner still sits in the source", svc.tables.users.find((u) => u.id === f.O)!.brokerage_id === f.S && svc.tables.brokerage_transfer_requests[0].status === "requested")

  // THE CONSENT → immediate migration
  const consent = await recordBrokerageTransferConsent(svc, { requestId: row.id, actor: { userId: f.O, brokerageId: f.S, kind: "subject" }, decision: "consent", statement: "I, Dana Lee, consent to moving my workspace into Harbor Realty.", channel: "settings_ui" }, deps)
  check("consent recorded and the migration ran in the same call", consent.ok && consent.migration?.ok === true, consent.ok ? (consent.migration && !consent.migration.ok ? consent.migration.error : "") : consent.error)
  const after = svc.tables.brokerage_transfer_requests.find((r) => r.id === row.id)!
  check("request: completed, consent evidence (statement, channel, snapshot of both ids + role), verification recorded, effective + completed stamps", after.status === "completed" && after.consent?.decision === "consent" && /Dana Lee/.test(after.consent?.statement ?? "") && after.consent?.request_snapshot?.target_brokerage_id === f.T && after.verification?.ok === true && !!after.effective_at && !!after.completed_at)
  check("every migration step done", transferMigrationComplete(after.migration) && transferStepsPending(after.migration).length === 0)
  const owner = svc.tables.users.find((u) => u.id === f.O)!
  check("MEMBERSHIP: the owner is in the target as an agent (not an admin), through the canonical movers", owner.brokerage_id === f.T && owner.user_type === "agent" && s.moved.includes(f.O) && s.roles.some((r) => r.userId === f.O && r.newRole === "agent" && r.brokerageId === f.T) && s.domain >= 1)
  check("the source's 'admin' grant was RETIRED before the move — no admin grant re-pinned to the target", !svc.tables.user_role_assignments.some((g) => g.user_id === f.O && g.role === "admin") && svc.tables.user_role_assignments.some((g) => g.user_id === f.O && g.role === "agent" && g.brokerage_id === f.T))
  check("the ISA system actor never moves", svc.tables.users.find((u) => u.id === f.ISA)!.brokerage_id === f.S)
  check("the agents row followed (same id)", svc.tables.agents.find((a) => a.id === "ag-o")!.brokerage_id === f.T)
  const moved = TRANSFER_DATA_FAMILIES.filter((fam) => svc.tables[fam.table].filter((r) => r.brokerage_id === f.T && String(r.id).startsWith(`${fam.table}-s`)).length === (fam.table === "contacts" ? 2 : 1) && !svc.tables[fam.table].some((r) => r.brokerage_id === f.S))
  check(`DATA: every family moved to the target and none left in the source (${moved.length}/${TRANSFER_DATA_FAMILIES.length})`, moved.length === TRANSFER_DATA_FAMILIES.length, TRANSFER_DATA_FAMILIES.filter((x) => !moved.includes(x)).map((x) => x.table).join(","))
  check("counts are exact (contacts=2, every other family=1, members=1, grants_retired=1)", after.migration?.counts.contacts === 2 && after.migration?.counts.members === 1 && after.migration?.counts.grants_retired === 1 && TRANSFER_DATA_FAMILIES.filter((x) => x.table !== "contacts").every((x) => after.migration?.counts[x.table] === 1))
  check("provenance: moved rows keep their ids, agent_id and content (only brokerage_id changed)", svc.tables.contacts.find((r) => r.id === "contacts-s")!.label === "S contacts" && svc.tables.contacts.find((r) => r.id === "contacts-s")!.agent_id === "ag-o")
  const decoyAfter = JSON.stringify(Object.fromEntries(Object.entries(svc.tables).map(([t, rows]) => [t, rows.filter((r) => r.brokerage_id === f.D || r.id === f.D || r.user_id === f.DO)])))
  check("CANNOT CROSS: the same-name decoy tenant is byte-identical (every table)", decoyAfter === decoyBefore)
  const b2After = JSON.stringify(Object.fromEntries(Object.entries(svc.tables).map(([t, rows]) => [t, rows.filter((r) => r.brokerage_id === f.B2 || r.id === f.B2)])))
  check("CANNOT CROSS: the other brokerage is byte-identical", b2After === b2Before)
  check("BILLING: the REAL default handoff closed the trial (no Stripe object) at the effective time, counted", after.billing_handoff?.ok === true && after.billing_handoff?.mode === "trial_closed" && svc.tables.subscriptions.find((x) => x.id === "sub-s")!.status === "cancelled" && svc.tables.subscriptions.find((x) => x.id === "sub-s")!.cancel_at === after.effective_at)
  check("the target's subscription is untouched (it owns the seat relationship)", svc.tables.subscriptions.find((x) => x.id === "sub-t")!.status === "active")
  const src = svc.tables.brokerages.find((b) => b.id === f.S)!
  check("ARCHIVED, NOT DELETED: the source row exists with status 'archived' + archived_at", !!src && src.status === "archived" && src.archived_at === NOW.toISOString() && svc.tables.brokerages.length === 5)
  check("READINESS verdict recorded on the request (seam counted once)", after.readiness?.ready === true && s.readiness === 1)
  const eventNames = s.events.map((e) => e.event)
  check("EVENTS: requested, consented, archived (on the source), completed (on the target)", ["brokerage_transfer_requested", "brokerage_transfer_consented", "brokerage_archived", "brokerage_transfer_completed"].every((e) => eventNames.includes(e)) && s.events.find((e) => e.event === "brokerage_archived")!.brokerageId === f.S && s.events.find((e) => e.event === "brokerage_transfer_completed")!.brokerageId === f.T)
  check("LEDGER: request + consent + migration attempt 1, every row executed, under the target tenant", ledgerRows(svc, "tenant.transfer.consent").length === 1 && ledgerRows(svc, "tenant.transfer.migrate").length === 1 && ledgerRows(svc, "tenant.transfer.migrate")[0].status === "executed" && svc.tables.agent_action_ledger.every((r) => r.brokerage_id === f.T))
  check("HUMANS through registered managers: target admins told (consent_recorded, completed) by the Recruiting Manager; the owner belled on completion", s.admins.some((n) => n.type === "brokerage_transfer_consent_recorded" && /Recruiting Manager/.test(n.title)) && s.admins.some((n) => n.type === "brokerage_transfer_completed") && svc.tables.notifications.some((n) => n.user_id === f.O && n.type === "brokerage_transfer_completed"))
  check("no platform-staff escalation on a clean run", s.staff.length === 0)

  // IDEMPOTENT
  const w2 = svc.writes.length
  const again = await runBrokerageTransferMigration(svc, { requestId: row.id, actor: { userId: f.A, brokerageId: f.T, kind: "target_admin" } }, deps)
  check("IDEMPOTENT: a second run reports already completed and performs ZERO writes", again.ok && again.alreadyCompleted === true && svc.writes.length === w2 && ledgerRows(svc, "tenant.transfer.migrate").length === 1)
  const consentAgain = await recordBrokerageTransferConsent(svc, { requestId: row.id, actor: { userId: f.O, brokerageId: f.T, kind: "subject" }, decision: "consent", statement: "I consent again, twice.", channel: "settings_ui" }, deps)
  check("a completed request cannot be consented again", !consentAgain.ok)
  const lt = await listBrokerageTransferRequests(svc, { brokerageId: f.T, side: "target" })
  const ls = await listBrokerageTransferRequests(svc, { brokerageId: f.S, side: "source" })
  const lb = await listBrokerageTransferRequests(svc, { brokerageId: f.B2, side: "target" })
  check("lists: the target and the source each see the request; another brokerage sees nothing", lt.requests.length === 1 && ls.requests.length === 1 && lb.requests.length === 0)
}

// ── D7 · a Stripe-billed source stalls at billing BEFORE archive, then resumes ──
// THE REAL orchestrator (lib/billing/subscriber-billing-handoff.ts) over THE REAL Stripe-side gate
// (lib/billing/subscriber-handoff.ts): only the Stripe SDK call and the ledger client are seamed. The
// actor the Stripe side is HANDED is recorded — wave 142 (owner): the APPROVING brokerage admin, never
// the subject whose consent runs the migration.
type StripeStub = () => Promise<{ applied: boolean; skipped: boolean; mode?: "scheduled_cancel" | "cancelled_now"; finalInvoiceId?: string | null }>
const realBillingDeps = (c: MemClient, s: Spies, actors: Array<string | null>, stripe: StripeStub, over: Partial<BrokerageTransferDeps> = {}) => railDeps(c, s, {
  billingHandoff: (c2, i) => orchestrateBillingHandoff(c2, i, {
    stripeSide: async (c3, i3) => {
      actors.push(i3.actorUserId)
      const r = await stripeSideHandoff(c3, { sourceBrokerageId: i3.sourceBrokerageId, targetBrokerageId: i3.targetBrokerageId, effectiveAt: i3.effectiveAt, actorUserId: i3.actorUserId ?? "", reason: `brokerage transfer ${i3.transferRequestId}` }, { ledgerClient: c3, endSubscription: stripe, emit: async () => ({}), now: NOW })
      return r.ok
        ? { ok: true, evidence: { stripe_mode: r.source.mode, proration: r.source.proration, replay: r.replay, ledger_action: r.evidence.ledgerAction } }
        : { ok: false, error: r.error, evidence: { stripe_refusal: r.refused } }
    },
  }),
  ...over,
})
{
  const { seed, f } = railSeed()
  const svc = memSupabase(seed, { uuidIds: true })
  const s = spies()
  const stripeActors: Array<string | null> = []
  // Stripe answers "not configured" → the handoff stalls for the honest reason.
  const deps = realBillingDeps(svc, s, stripeActors, async () => ({ applied: false, skipped: true }))
  const req = await requestBrokerageTransfer(svc, { targetBrokerageId: f.T, initiatedByUserId: f.A, subjectEmail: "ivy@team.test", targetRole: "team_lead" }, deps)
  check("a TEAM tenant's owner can be adopted as a team lead", req.ok, req.ok ? "" : req.error)
  const id = req.ok ? req.request.id : ""
  const c = await recordBrokerageTransferConsent(svc, { requestId: id, actor: { userId: f.O2, brokerageId: f.S2, kind: "subject" }, decision: "consent", statement: "Our team consents to joining Harbor Realty.", channel: "settings_ui" }, deps)
  const m = c.ok ? c.migration : null
  check("BILLING PENDING: the Stripe-billed source stalls at billing_handoff for the HONEST reason (Stripe unconfigured) — not the actor", !!m && !m.ok && m.stalledAt === "billing_handoff" && /stripe_handoff_pending/.test(m.error) && /not configured/.test(m.error) && !/actor_not_authorized|Only an admin of the adopting/.test(m.error), m && !m.ok ? m.error : "")
  check("THE ACTOR RULE (wave 142): the consent ran as the SUBJECT, yet the Stripe side was handed the APPROVING target admin (initiated_by_user_id) — never the subject", stripeActors.length === 1 && stripeActors[0] === f.A && !stripeActors.includes(f.O2), stripeActors.join(","))
  const mid = svc.tables.brokerage_transfer_requests.find((r) => r.id === id)!
  check("the stalled handoff's evidence names the approver and the Stripe refusal", mid.billing_handoff?.ok === false && (mid.billing_handoff as any)?.evidence?.approved_by_user_id === f.A && (mid.billing_handoff as any)?.evidence?.stripe_refusal === "stripe_unconfigured")
  // POSITIVE CONTROL: the Stripe side's tenancy gate REFUSES a source-side owner as actor — so the pre-fix
  // rail (handing the subject over) could never have completed a Stripe-linked adoption.
  const subjectAsActor = await stripeSideHandoff(svc, { sourceBrokerageId: f.S, targetBrokerageId: f.T, effectiveAt: NOW.toISOString(), actorUserId: f.O }, { ledgerClient: svc, endSubscription: async () => ({ applied: true, skipped: false, mode: "scheduled_cancel" as const }), emit: async () => ({}), now: NOW })
  check("POSITIVE CONTROL: the Stripe side refuses the adopted OWNER as actor (actor_not_authorized) — the subject can never be the billing actor", !subjectAsActor.ok && subjectAsActor.refused === "actor_not_authorized")
  check("membership + data already done; billing failed; archive + readiness pending; status migrating", mid.status === "migrating" && mid.migration?.steps.membership?.status === "done" && mid.migration?.steps.data?.status === "done" && mid.migration?.steps.billing_handoff?.status === "failed" && transferStepsPending(mid.migration).join(",") === "billing_handoff,archive_source,target_readiness")
  check("the team moved as a unit (same id) with both members; the member stays an agent, the owner is the team lead", svc.tables.teams[0].brokerage_id === f.T && svc.tables.users.filter((u) => u.brokerage_id === f.S2 && !u.platform_role).length === 0 && svc.tables.users.find((u) => u.id === f.O2)!.user_type === "team_lead" && svc.tables.users.find((u) => u.email === "member@team.test")!.user_type === "agent" && mid.migration?.counts.members === 2 && mid.migration?.counts.teams === 1)
  check("NOT ARCHIVED while billing is pending (no double billing by omission); the Stripe row untouched", svc.tables.brokerages.find((b) => b.id === f.S2)!.status === "active" && svc.tables.subscriptions.find((x) => x.id === "sub-s2")!.status === "active")
  check("the Finance Manager route carried the pending handoff to staff AND the target admins; a stalled event was recorded", s.staff.some((n) => n.type === "brokerage_transfer_billing_pending" && /Finance Manager/.test(n.title)) && s.admins.some((n) => n.type === "brokerage_transfer_billing_pending") && s.events.some((e) => e.event === "brokerage_transfer_stalled" && e.metadata?.step === "billing_handoff"))
  check("the stalled attempt's ledger row is failed (never 'executed')", ledgerRows(svc, "tenant.transfer.migrate").length === 1 && ledgerRows(svc, "tenant.transfer.migrate")[0].status === "failed")
  // RESUME with the Stripe side present (lane 141H's seam, stubbed): finished steps are not re-run.
  const movedBefore = s.moved.length, domainBefore = s.domain
  const resumeDeps = railDeps(svc, s, { billingHandoff: async (c2, i) => { s.billing++; await c2.from("subscriptions").update({ status: "cancelled", cancel_at: i.effectiveAt }).eq("id", "sub-s2").eq("brokerage_id", i.sourceBrokerageId); return { ok: true, mode: "stripe_prorated", sourceSubscriptionId: "sub-s2", targetSubscriptionId: "sub-t", effectiveAt: i.effectiveAt, evidence: { proration: "fixture" } } } })
  const resumed = await runBrokerageTransferMigration(svc, { requestId: id, actor: { userId: f.A, brokerageId: f.T, kind: "target_admin" } }, resumeDeps)
  check("RESUME completes once the Stripe side answers", resumed.ok && resumed.completed, resumed.ok ? "" : resumed.error)
  const done = svc.tables.brokerage_transfer_requests.find((r) => r.id === id)!
  check("finished steps were NOT re-run (no second member move, no second domain repair); billing called once", s.moved.length === movedBefore && s.domain === domainBefore && s.billing === 1 && done.migration?.attempts === 2)
  check("now archived, billing evidence recorded (stripe_prorated), readiness recorded, completed", svc.tables.brokerages.find((b) => b.id === f.S2)!.status === "archived" && done.billing_handoff?.ok === true && done.billing_handoff?.mode === "stripe_prorated" && done.readiness?.ready === true && done.status === "completed")
  check("two migration ledger rows (one per attempt): failed, then executed", ledgerRows(svc, "tenant.transfer.migrate").map((r) => r.status).join(",") === "failed,executed")
}

// ── D7b · a Stripe-billed source COMPLETES on consent once Stripe answers — the approver is the actor ──
{
  const { seed, f } = railSeed()
  const svc = memSupabase(seed, { uuidIds: true })
  const s = spies()
  const stripeActors: Array<string | null> = []
  const deps = realBillingDeps(svc, s, stripeActors, async () => ({ applied: true, skipped: false, mode: "scheduled_cancel" as const, finalInvoiceId: null }))
  const req = await requestBrokerageTransfer(svc, { targetBrokerageId: f.T, initiatedByUserId: f.A, subjectEmail: "ivy@team.test", targetRole: "team_lead" }, deps)
  const id = req.ok ? req.request.id : ""
  const c = await recordBrokerageTransferConsent(svc, { requestId: id, actor: { userId: f.O2, brokerageId: f.S2, kind: "subject" }, decision: "consent", statement: "Our team consents to joining Harbor Realty.", channel: "settings_ui" }, deps)
  check("STRIPE-LINKED ADOPTION COMPLETES IN THE CONSENT CALL (no stall at stripe_handoff_pending)", c.ok && c.migration?.ok === true, c.ok ? (c.migration && !c.migration.ok ? c.migration.error : "") : c.error)
  const done = svc.tables.brokerage_transfer_requests.find((r) => r.id === id)!
  check("the Stripe side was handed the APPROVING admin exactly once; the subject never", stripeActors.length === 1 && stripeActors[0] === f.A)
  check("billing evidence: stripe_prorated, the approver recorded, Stripe's scheduled cancel + proration", done.billing_handoff?.ok === true && done.billing_handoff?.mode === "stripe_prorated" && (done.billing_handoff as any).evidence?.approved_by_user_id === f.A && (done.billing_handoff as any).evidence?.stripe_mode === "stripe_scheduled_cancel")
  const srcSub = svc.tables.subscriptions.find((x) => x.id === "sub-s2")!
  check("the source subscription mirrors INTENT only (cancel_at = effective_at, COUNTED); status stays Stripe's to write; no fabricated refund", srcSub.cancel_at === done.effective_at && srcSub.status === "active" && svc.tables.subscriptions.find((x) => x.id === "sub-t")!.status === "active")
  check("the Stripe-side ledger row is FINANCIAL, under the SOURCE tenant, with the approver as actor", svc.tables.agent_action_ledger.some((r) => r.action === "billing.subscription.handoff_to_brokerage" && r.brokerage_id === f.S2 && r.actor_user_id === f.A && r.status === "executed"))
  check("archived + completed + readiness recorded", svc.tables.brokerages.find((b) => b.id === f.S2)!.status === "archived" && done.status === "completed" && done.readiness?.ready === true)
  check("the migrate ledger row records BOTH the running actor (the subject) and the approving admin", ledgerRows(svc, "tenant.transfer.migrate").some((r) => r.actor_user_id === f.O2 && (r.detail ?? r.details ?? r.metadata ?? {})?.approving_admin_user_id === f.A) || ledgerRows(svc, "tenant.transfer.migrate").some((r) => JSON.stringify(r).includes(f.A) && r.actor_user_id === f.O2))
  // A target admin RETRYING a finished transfer: nothing acts, and the approver would be that admin.
  const w = svc.writes.length
  const again = await runBrokerageTransferMigration(svc, { requestId: id, actor: { userId: f.A, brokerageId: f.T, kind: "target_admin" } }, deps)
  check("IDEMPOTENT after a Stripe-linked completion: a retry acts on nothing (zero writes, Stripe not called again)", again.ok && again.alreadyCompleted === true && svc.writes.length === w && stripeActors.length === 1)
}

// ── D8 · decline · D9 · verification failure moves nothing · D10 · pure ──────
{
  const { seed, f } = railSeed()
  const svc = memSupabase(seed, { uuidIds: true })
  const s = spies(); const deps = railDeps(svc, s)
  const req = await requestBrokerageTransfer(svc, { targetBrokerageId: f.T, initiatedByUserId: f.A, subjectEmail: "decoy@solo.test", targetRole: "agent" }, deps)
  const id = req.ok ? req.request.id : ""
  const d = await recordBrokerageTransferConsent(svc, { requestId: id, actor: { userId: f.DO, brokerageId: f.D, kind: "subject" }, decision: "decline", statement: "No thanks.", channel: "settings_ui" }, deps)
  check("DECLINE: recorded, no migration, the target admins told via the Recruiting Manager", d.ok && d.migration === null && svc.tables.brokerage_transfer_requests.find((r) => r.id === id)!.status === "declined" && s.admins.some((n) => n.type === "brokerage_transfer_declined") && s.events.some((e) => e.event === "brokerage_transfer_declined"))
  const run = await runBrokerageTransferMigration(svc, { requestId: id, actor: { userId: f.A, brokerageId: f.T, kind: "target_admin" } }, deps)
  check("a declined request cannot be migrated", !run.ok && /declined/.test(run.ok ? "" : run.error))
  check("the decoy owner still sits in their own tenant", svc.tables.users.find((u) => u.id === f.DO)!.brokerage_id === f.D)
  const cancelled = await requestBrokerageTransfer(svc, { targetBrokerageId: f.T, initiatedByUserId: f.A, subjectEmail: "dana@solo.test", targetRole: "agent" }, deps)
  const cid = cancelled.ok ? cancelled.request.id : ""
  const cx = await cancelBrokerageTransferRequest(svc, { requestId: cid, actor: { userId: f.A, brokerageId: f.T, kind: "target_admin" }, reason: "changed plans" }, deps)
  check("CANCEL by the target admin before consent: cancelled + ledgered + event", cx.ok && svc.tables.brokerage_transfer_requests.find((r) => r.id === cid)!.status === "cancelled" && ledgerRows(svc, "tenant.transfer.cancel").length === 1 && s.events.some((e) => e.event === "brokerage_transfer_cancelled"))

  // VERIFICATION FAILURE: the target is suspended between consent and migration → nothing moves.
  const req2 = await requestBrokerageTransfer(svc, { targetBrokerageId: f.T, initiatedByUserId: f.A, subjectEmail: "dana@solo.test", targetRole: "agent" }, deps)
  const id2 = req2.ok ? req2.request.id : ""
  await svc.from("brokerage_transfer_requests").update({ status: "consented", consent: { user_id: f.O, at: NOW.toISOString(), decision: "consent", statement: "I consent to this adoption.", channel: "settings_ui", request_snapshot: { source_brokerage_id: f.S, target_brokerage_id: f.T, target_role: "agent", source_name: null, target_name: null } } }).eq("id", id2)
  await svc.from("brokerages").update({ status: "suspended" }).eq("id", f.T)
  const usersBefore = JSON.stringify(svc.tables.users), contactsBefore = JSON.stringify(svc.tables.contacts)
  const v = await runBrokerageTransferMigration(svc, { requestId: id2, actor: { userId: f.A, brokerageId: f.T, kind: "target_admin" } }, deps)
  check("VERIFICATION FAILURE (target suspended): stalled at verification with the failed check named; status stays consented", !v.ok && v.stalledAt === "verification" && /target_tenant/.test(v.ok ? "" : v.error) && svc.tables.brokerage_transfer_requests.find((r) => r.id === id2)!.status === "consented")
  check("nothing moved: users and contacts byte-identical; the Data Steward route told the target admins", JSON.stringify(svc.tables.users) === usersBefore && JSON.stringify(svc.tables.contacts) === contactsBefore && s.admins.some((n) => n.type === "brokerage_transfer_verification_failed" && /Data Steward/.test(n.title)))

  // pure
  check("memberTargetRole: subject takes the requested role; an admin-class member becomes an agent; a TC stays a TC", memberTargetRole("admin", true, "team_lead") === "team_lead" && memberTargetRole("broker_owner", false, "agent") === "agent" && memberTargetRole("tc", false, "agent") === "tc" && memberTargetRole("agent", false, "team_lead") === "agent")
  check("step algebra: an empty record pends every step; a full record pends none", transferStepsPending(null).length === TRANSFER_MIGRATION_STEPS.length && transferMigrationComplete({ steps: Object.fromEntries(TRANSFER_MIGRATION_STEPS.map((k) => [k, { status: "done", at: "x" }])) as any }))
  // readiness NOT READY → the Data Steward route tells the target admins, the transfer still completes (repairs are the engine's)
  const { seed: seed3, f: f3 } = railSeed()
  const svc3 = memSupabase(seed3, { uuidIds: true }); const s3 = spies(); const deps3 = railDeps(svc3, s3, { ready: false })
  const r3 = await requestBrokerageTransfer(svc3, { targetBrokerageId: f3.T, initiatedByUserId: f3.A, subjectEmail: "dana@solo.test", targetRole: "agent" }, deps3)
  const c3 = await recordBrokerageTransferConsent(svc3, { requestId: r3.ok ? r3.request.id : "", actor: { userId: f3.O, brokerageId: f3.S, kind: "subject" }, decision: "consent", statement: "I consent to this adoption.", channel: "settings_ui" }, deps3)
  check("a NOT READY target completes the transfer with the verdict recorded and the admins told (target_not_ready)", c3.ok && c3.migration?.ok === true && c3.request.readiness?.ready === false && s3.admins.some((n) => n.type === "brokerage_transfer_target_not_ready" && /Data Steward/.test(n.title)))
}

// ═════════════════════════════════════════════════════════════════════════════
// E. REGISTRATION + DERIVED VOCABULARIES + WIRING
// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[E · registration, derived vocabularies, wiring]")
{
  const pkg = JSON.parse(raw("package.json"))
  check("package.json registers test:brokerage-identity", typeof pkg.scripts["test:brokerage-identity"] === "string" && /brokerage-identity-guard/.test(pkg.scripts["test:brokerage-identity"]))
  check("guard chain membership (regex, never a position)", new RegExp("npm run test:brokerage-identity(\\s|&|$)").test(pkg.scripts.guard ?? ""))
  const dom = MAINTENANCE_DOMAINS.brokerage_identity
  check("MAINTENANCE_DOMAINS.brokerage_identity: data_steward accountable, proof named, co-owners recruiting / finance / compliance named in the prose", !!dom && dom.manager === "data_steward" && dom.proof === "test:brokerage-identity" && ["recruiting_manager", "finance_manager", "compliance_officer"].every((k) => dom.coOwners?.includes(k as any) && dom.what.includes(k)))
  check("TABLE_MANAGER.brokerage_transfer_requests is owned", TABLE_MANAGER.brokerage_transfer_requests === "data_steward")
  check("TRANSFER_HUMAN_ROUTES: every route is a registered MANAGERS key and the Recruiting Manager carries the roster side (owner correction 2026-10-14)", Object.values(TRANSFER_HUMAN_ROUTES).every((k) => k in MANAGERS) && TRANSFER_HUMAN_ROUTES.consent_requested === "recruiting_manager" && TRANSFER_HUMAN_ROUTES.billing_pending === "finance_manager")
  check("no route names a superadmin or an unregistered manager (control)", !Object.values(TRANSFER_HUMAN_ROUTES).some((k) => /superadmin/.test(k)) && !("broker_ops" in MANAGERS))
  const live = new Set(LIVE_TABLES)
  const fams = TRANSFER_DATA_FAMILIES.map((f) => ({ table: f.table, live: live.has(f.table), hasTenant: (SCHEMA_SNAPSHOT[f.table] ?? []).includes("brokerage_id") }))
  const bad = fams.filter((f) => !f.live || !f.hasTenant)
  check(`TRANSFER_DATA_FAMILIES: ${fams.length} tables, every one live and carrying brokerage_id (derived from the caches)`, bad.length === 0, bad.map((b) => `${b.table}${b.live ? "" : " !live"}${b.hasTenant ? "" : " !brokerage_id"}`).join(","))
  check("CONTROL: a table with no brokerage_id would be caught", !(SCHEMA_SNAPSHOT.subscription_tiers ?? []).includes("brokerage_id"))
  check("families are unique and never name a money / settings / evidence table", new Set(fams.map((f) => f.table)).size === fams.length && !fams.some((f) => /commission|subscriptions|billing|ledger|settings|policy|lifecycle_events|notifications|ai_tool_usage/.test(f.table)))

  // FK CLOSURE (wave 143G). A transferred family's CHILDREN must follow it into the target: a row left behind in
  // the archived source still references a parent that now lives in another tenant, and every target-side read
  // (`.eq("brokerage_id", target)`) misses it. The closure is DERIVED from the generated caches — tables that
  // carry brokerage_id AND have an FK into a moved family and are not themselves moved.
  const famSet = new Set(TRANSFER_DATA_FAMILIES.map((f) => f.table))
  const unmovedChildren = (families: ReadonlySet<string>) => Object.entries(SCHEMA_FK_MAP as Record<string, Record<string, string>>)
    .filter(([t, fks]) => !families.has(t) && (SCHEMA_SNAPSHOT[t] ?? []).includes("brokerage_id") && Object.values(fks).some((parent) => families.has(parent)))
    .map(([t]) => t).sort()
  // (1) THE WEBSITE'S LANDING PAGES: a RULE, zero exceptions — nothing that FKs to a moved landing page stays behind.
  const landingParents = new Set(["lead_capture_forms"])
  const landingLeft = unmovedChildren(famSet).filter((t) => Object.values(SCHEMA_FK_MAP[t] ?? {}).some((parent) => landingParents.has(parent)))
  check("LANDING PAGES: lead_capture_forms moves, and no table that FKs to it is left in the source tenant", famSet.has("lead_capture_forms") && landingLeft.length === 0, landingLeft.join(","))
  const withoutSubmissions = new Set([...famSet].filter((t) => t !== "form_submissions"))
  check("  POSITIVE CONTROL: with form_submissions dropped from the families, the closure finder names it (the rule is not vacuous)", unmovedChildren(withoutSubmissions).includes("form_submissions"))
  // (2) THE REST: FROZEN DEBT, a ratchet that only goes DOWN. Published: the denominator is every table in the
  // generated FK cache that carries brokerage_id; the exclusions are the families themselves. Money (commission_*,
  // agent_commissions) is MEANT to stay (m765's rationale: money never crosses tenants); the remainder is deal /
  // contact state that the owner has not yet ruled on — see lane 143G notes "Still open".
  const FROZEN_UNMOVED_FK_CHILDREN = 286
  const debt = unmovedChildren(famSet)
  check(`FK-closure debt does not GROW: ${debt.length} unmoved child tables (frozen ceiling ${FROZEN_UNMOVED_FK_CHILDREN}; lower the ceiling when a family is added — a count that moves is the finding)`, debt.length <= FROZEN_UNMOVED_FK_CHILDREN, `grew by ${debt.length - FROZEN_UNMOVED_FK_CHILDREN}: ${debt.slice(0, 8).join(",")}`)
  console.log(`    (published) FK-closure census: ${Object.keys(SCHEMA_FK_MAP).filter((t) => (SCHEMA_SNAPSHOT[t] ?? []).includes("brokerage_id")).length} tables in the FK cache carry brokerage_id; ${famSet.size} are moved families; ${debt.length} are unmoved children of a moved family; ${debt.filter((t) => /commission/.test(t)).length} of those are commission money that stays by design.`)


  const mig = "supabase/migrations/m765-brokerage-identity-declared-affiliation-and-transfer-requests.sql"
  check("m765 exists with a status header on line 1 (the lane stamp or APPLIED LIVE)", existsSync(join(root, mig)) && /WRITTEN, NOT APPLIED|APPLIED LIVE/.test(raw(mig).split("\n")[0]))
  const sql = raw(mig).replace(/--[^\n]*/g, "")
  const statusCheck = sql.match(/status IN \(([^)]*)\)/)?.[1] ?? ""
  const roleCheck = sql.match(/target_role IN \(([^)]*)\)/)?.[1] ?? ""
  const sqlList = (s: string) => s.split(",").map((x) => x.trim().replace(/'/g, "")).filter(Boolean).sort().join(",")
  check("m765 status CHECK mirrors TRANSFER_STATUSES exactly", sqlList(statusCheck) === [...TRANSFER_STATUSES].sort().join(","), `${sqlList(statusCheck)} vs ${[...TRANSFER_STATUSES].sort().join(",")}`)
  check("m765 target_role CHECK mirrors TRANSFER_TARGET_ROLES exactly", sqlList(roleCheck) === [...TRANSFER_TARGET_ROLES].sort().join(","))
  check("m765 pins the tenant to the target and forbids source = target, with a source-side SELECT policy", /brokerage_id = target_brokerage_id/.test(sql) && /source_brokerage_id <> target_brokerage_id/.test(sql) && /has_brokerage_access\(source_brokerage_id\)/.test(sql) && /declared_affiliation jsonb/.test(sql))
  const claim = stripped("scripts/migration-claim-guard.ts")
  check("migration-claim baseline raised deliberately for m765 (named)", /m765/.test(raw("scripts/migration-claim-guard.ts")) && /NOT_APPLIED_BASELINE = \d+/.test(claim))

  const rail = stripped("lib/kernel/brokerage-transfer.ts")
  check("the rail's ONLY billing edge is the seam (no stripe import, no subscriptions write)", /subscriber-billing-handoff/.test(rail) && !/from ["']stripe["']|lib\/stripe|stripe-subscription-ops/.test(rail) && !/\.from\("subscriptions"\)/.test(rail))
  // THE ACTOR RULE (wave 142): the seam is handed the APPROVING admin — derived from the request's
  // initiated_by_user_id (or the retrying target admin) — never the running actor by shorthand.
  const handoffCall = rail.match(/handoff\(svc,\s*\{[^}]*\}/)?.[0] ?? ""
  check("the ONE billing call passes actorUserId: approvingAdminUserId, and that id derives from req.initiated_by_user_id", /actorUserId:\s*approvingAdminUserId/.test(handoffCall) && /approvingAdminUserId\s*=[^\n]*req\.initiated_by_user_id/.test(rail) && !/\bactorUserId\s*[,}]/.test(handoffCall))
  check("CONTROL: the pre-fix shorthand (the running actor) would be caught", /\bactorUserId\s*[,}]/.test("handoff(svc, { sourceBrokerageId: sourceId, targetBrokerageId: targetId, effectiveAt, transferRequestId: req.id, actorUserId })"))
  const rehomes = (rail.match(/\.update\(\{ brokerage_id: targetId \}\)\.eq\("brokerage_id", sourceId\)/g) ?? []).length
  const anyRehome = (rail.match(/\.update\(\{ brokerage_id: targetId \}\)/g) ?? []).length
  check(`every re-home update is pinned to the source tenant (${rehomes}/${anyRehome})`, anyRehome >= 2 && rehomes === anyRehome)
  check("CONTROL: an unpinned re-home would be caught", (("x.update({ brokerage_id: targetId }).select()".match(/\.update\(\{ brokerage_id: targetId \}\)\.eq\("brokerage_id", sourceId\)/g) ?? []).length) === 0)
  check("the rail never writes users.brokerage_id itself (the users.ts movers do)", !/\.from\("users"\)\.update/.test(rail))
  check("the rail archives, never deletes, a brokerage", /status: "archived", archived_at/.test(rail) && !/\.from\("brokerages"\)\.delete/.test(rail))

  const doors = stripped("app/actions/brokerage-transfer.ts")
  check("doors: 'use server', requireCaller + resolveTenantAdmin (adopting side), requireTenantAdminOrSoloOwner (adopted side), no brokerage id from the body", /^"use server"/.test(raw("app/actions/brokerage-transfer.ts")) && /requireCaller\(\)/.test(doors) && /resolveTenantAdmin\(/.test(doors) && /requireTenantAdminOrSoloOwner\(\)/.test(doors) && !/input\??\.brokerageId|input\??\.targetBrokerageId|input\??\.sourceBrokerageId/.test(doors))
  const affDoor = stripped("app/actions/settings/brokerage-affiliation.ts")
  check("affiliation door: gated by requireTenantAdminOrSoloOwner, writes through the kernel's one writer, org tiers refused", /requireTenantAdminOrSoloOwner\(\)/.test(affDoor) && /declareBrokerageAffiliation\(/.test(affDoor) && /isIndependentSubscriberTier/.test(affDoor))
  check("wired: Settings → Users renders the adoption card; Settings → General renders the affiliation card", /BrokerageAdoptionCard/.test(stripped("app/settings/users/page.tsx")) && /BrokerageAffiliationCard/.test(stripped("app/settings/general/page.tsx")) && /requestBrokerageAdoptionAction/.test(stripped("app/settings/users/brokerage-adoption-card.tsx")) && /respondToBrokerageTransferAction/.test(stripped("app/settings/general/brokerage-affiliation-card.tsx")))
  check("wired: the signup door passes the declaration to the core; the core writes it through the one writer", /declaredAffiliation: input\.affiliatedBrokerage/.test(stripped("app/actions/auth/signup-brokerage.ts")) && /declareBrokerageAffiliation\(service, brokerageId, input\.declaredAffiliation/.test(stripped("lib/kernel/tenant-creation.ts")) && /affiliatedBrokerage/.test(stripped("app/get-started/trial-funnel-form.tsx")))
  const tenantCopy = [raw("app/settings/users/brokerage-adoption-card.tsx"), raw("app/settings/general/brokerage-affiliation-card.tsx"), raw("app/get-started/trial-funnel-form.tsx")].join("\n")
  check("tenant-facing copy never says 'platform-covered'", !/platform-covered/i.test(tenantCopy))
  check("events declared once in KernelEvent (requested / consented / declined / cancelled / stalled / completed / archived / affiliation declared)", ["brokerage_transfer_requested", "brokerage_transfer_consented", "brokerage_transfer_declined", "brokerage_transfer_cancelled", "brokerage_transfer_stalled", "brokerage_transfer_completed", "brokerage_archived", "brokerage_affiliation_declared"].every((e) => new RegExp(`'${e}'`).test(stripped("lib/kernel/events.ts"))))
}

// ═══════════════════════════════════════════════════════════════════════════════
// F · AN ARCHIVED SOURCE HAS NO PUBLIC SURFACE OF ITS OWN (wave 143G)
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n[F · an archived workspace forwards to the brokerage that adopted it — the storefront and the website chat]")
{
  const { resolveArchivedSiteSuccessor } = await import("../lib/tenant-site/successor")
  const { resolveWidgetTenant } = await import("../lib/widget/resolve-widget-tenant")
  const S = "s0000000-0000-4000-8000-000000000001", T = "t0000000-0000-4000-8000-000000000002", D = "d0000000-0000-4000-8000-000000000003", S2 = "s0000000-0000-4000-8000-000000000004", T2 = "t0000000-0000-4000-8000-000000000005"
  const seedF = (): Record<string, Row[]> => ({
    brokerages: [
      { id: S, name: "Solo Sam", slug: "solo-sam-1", status: "archived", archived_at: "2026-10-01", deleted_at: null, widget_enabled: true },
      { id: T, name: "Target Realty", slug: "target-realty-2", status: "active", archived_at: null, deleted_at: null, widget_enabled: true },
      { id: D, name: "Solo Sam", slug: "solo-sam-3", status: "active", archived_at: null, deleted_at: null, widget_enabled: true },
      { id: S2, name: "Solo Two", slug: "solo-two-4", status: "archived", archived_at: "2026-10-01", deleted_at: null, widget_enabled: true },
      { id: T2, name: "Gone Target", slug: "gone-target-5", status: "archived", archived_at: "2026-10-02", deleted_at: null, widget_enabled: true },
    ],
    brokerage_transfer_requests: [
      { id: "r1", source_brokerage_id: S, target_brokerage_id: T, status: "completed", completed_at: "2026-10-01" },
      { id: "r2", source_brokerage_id: S2, target_brokerage_id: T2, status: "completed", completed_at: "2026-10-01" },
    ],
    agents: [
      { id: "ag-t", brokerage_id: T, is_active: true },
      { id: "ag-s", brokerage_id: S, is_active: true },
    ],
  })
  const svcF = (over: Record<string, Row[]> = {}, opts: Record<string, unknown> = {}) => memSupabase({ ...seedF(), ...over } as any, opts as any)
  const ok1 = await resolveArchivedSiteSuccessor(svcF(), S)
  check("the archived source resolves to the target of ITS completed transfer (by the request row, not by name)", ok1.ok && ok1.successor.id === T && ok1.successor.slug === "target-realty-2", JSON.stringify(ok1))
  check("  POSITIVE CONTROL: a same-name decoy tenant is never the successor (the request row is the proof)", ok1.ok && ok1.successor.id !== D)
  const none = await resolveArchivedSiteSuccessor(svcF({ brokerage_transfer_requests: [] }), S)
  check("no completed transfer ⇒ no successor", !none.ok && none.reason === "none")
  const pending = await resolveArchivedSiteSuccessor(svcF({ brokerage_transfer_requests: [{ id: "r1", source_brokerage_id: S, target_brokerage_id: T, status: "migrating", completed_at: null }] }), S)
  check("a transfer that is not COMPLETED forwards nowhere", !pending.ok && pending.reason === "none")
  const targetArchived = await resolveArchivedSiteSuccessor(svcF(), S2)
  check("a target that is itself archived is not a successor (one hop, never a chain — a loop is impossible)", !targetArchived.ok && targetArchived.reason === "none")
  const refused = await resolveArchivedSiteSuccessor(svcF({}, { refuse: { brokerage_transfer_requests: "RLS refused" } }), S)
  check("FAIL CLOSED: a refused request read is `unreadable`, not `none`", !refused.ok && refused.reason === "unreadable")

  const w1 = await resolveWidgetTenant(svcF() as any, { brokerageSlug: "solo-sam-1" })
  check("the website chat on the ARCHIVED workspace's slug is served by the adopting brokerage (leads land where the agent now works)", w1.ok && w1.tenant.brokerageId === T && w1.tenant.brokerageSlug === "target-realty-2", JSON.stringify(w1))
  const w2 = await resolveWidgetTenant(svcF() as any, { brokerageSlug: "target-realty-2" })
  check("  control: an ACTIVE workspace's chat is unchanged", w2.ok && w2.tenant.brokerageId === T)
  const w3 = await resolveWidgetTenant(svcF({ brokerage_transfer_requests: [] }) as any, { brokerageSlug: "solo-sam-1" })
  check("an archived workspace with NO completed transfer serves no chat (404, the same message as an unknown slug)", !w3.ok && w3.status === 404)
  const w4 = await resolveWidgetTenant(svcF({}, { refuse: { brokerage_transfer_requests: "RLS refused" } }) as any, { brokerageSlug: "solo-sam-1" })
  check("an unreadable successor lookup is a 503 (an outage is not a 404)", !w4.ok && w4.status === 503)
  const w5 = await resolveWidgetTenant(svcF() as any, { brokerageSlug: "solo-sam-1", agentId: "ag-t" })
  const w6 = await resolveWidgetTenant(svcF() as any, { brokerageSlug: "solo-sam-1", agentId: "ag-s" })
  check("an agent-scoped widget on the archived slug resolves the agent in the SUCCESSOR tenant; an agent id of the archived tenant finds nothing", w5.ok && w5.tenant.agentId === "ag-t" && !w6.ok && w6.status === 404)

  const sitePage = stripComments(raw("app/site/[slug]/page.tsx"))
  check("the storefront: an archived brokerage forwards (permanentRedirect to the successor's site) or 404s — never a hollow page", /status\s*===\s*"archived"/.test(sitePage) && /resolveArchivedSiteSuccessor\(/.test(sitePage) && /permanentRedirect\(tenantWebsitePath\(data\.successorSlug\)\)/.test(sitePage))
  check("  POSITIVE CONTROL: the finder sees a storefront that never reads the archive", !/status\s*===\s*"archived"/.test(stripComments(`const { data: b } = await svc.from("brokerages").select("id, slug").eq("slug", slug).maybeSingle()`)))
}

console.log(`\nBLIND SPOTS: scripts/ not scanned in A (simulators look up their own tagged brokerages by name); the Stripe SDK call is stubbed in D7/D7b (the Stripe-side tenancy gate, seat verdict and ledger run for real against the in-memory client); readiness is a counted seam; RLS not exercised.`)
console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.map((f) => `   ✗ ${f}`).join("\n")); process.exit(1) }
