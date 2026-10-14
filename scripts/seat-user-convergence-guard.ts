#!/usr/bin/env tsx
/**
 * scripts/seat-user-convergence-guard.ts   (npm run test:seat-user-convergence)
 * ─────────────────────────────────────────────────────────────────────────────
 * SEAT → USER → TENANT → ROLE → AGENT/STAFF RECORD → TEAM → AUTHORITY → ENTITLEMENTS → USABLE,
 * for a TENANT-ADMIN-added member and a PLATFORM-STAFF-added member, idempotently, IN MEMORY
 * (wave 140F; owner: "seats/users added by a tenant admin OR platform staff become usable
 * automatically … first login is never a hidden repair").
 *
 * The survivor under test is the REAL lib/kernel/users.ts (inviteTenantMember →
 * createOrRepairUserDomainRecords → resolveUserWorkspaceContext) and the REAL seat gate
 * (lib/kernel/seat-usage.ts), driven against an in-memory Supabase fake that models the live
 * constraints the chain depends on: users.id === auth.users.id (the trigger seed), users.email
 * UNIQUE, agents UNIQUE(user_id), user_role_assignments UNIQUE(user_id, role),
 * agent_onboarding UNIQUE(agent_id), `.maybeSingle()` over several rows is an ERROR that
 * supabase-js RESOLVES, and every write + `.select()` returns the matched rows (writers COUNT,
 * CLAUDE.md §3). `createServiceClient` is stubbed in the require cache (the idiom
 * scripts/cron-auth-fail-closed-guard.ts uses for `server-only`).
 *
 * Every prevention carries a POSITIVE CONTROL (§2): the detector that reports zero is shown to
 * flag an injected defect; the gate that refuses is shown to admit without the defect.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"

const ROOT = process.cwd()
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* nothing to shim */ }

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")

// ─── IN-MEMORY SUPABASE ──────────────────────────────────────────────────────
type Row = Record<string, any>
const UNIQUE: Record<string, string[][]> = {
  users: [["id"], ["email"]],
  agents: [["id"], ["user_id"]],
  user_role_assignments: [["id"], ["user_id", "role"]],
  agent_onboarding: [["id"], ["agent_id"]],
  transaction_coordinators: [["id"], ["user_id"]],
  agent_commission_profiles: [["id"]],
}
let seq = 0
const newId = (p = "id") => `${p}-${(++seq).toString(36).padStart(4, "0")}`

class Store {
  tables = new Map<string, Row[]>()
  authUsers: Array<{ id: string; email: string }> = []
  refuse = new Set<string>()
  t(name: string): Row[] { if (!this.tables.has(name)) this.tables.set(name, []); return this.tables.get(name)! }
  clone(): Store {
    const s = new Store()
    for (const [k, v] of this.tables) s.tables.set(k, v.map((r) => ({ ...r })))
    s.authUsers = this.authUsers.map((u) => ({ ...u }))
    return s
  }
}

type Filter = (r: Row) => boolean
class Query implements PromiseLike<any> {
  private filters: Filter[] = []
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select"
  private payload: any = null
  private onConflict: string[] | null = null
  private wantSelect = false
  private mode: "many" | "maybeSingle" | "single" = "many"
  private max: number | null = null
  constructor(private store: Store, private table: string) {}
  select(_cols?: string) { if (this.op !== "select") this.wantSelect = true; return this }
  insert(rows: Row | Row[]) { this.op = "insert"; this.payload = Array.isArray(rows) ? rows : [rows]; return this }
  upsert(rows: Row | Row[], opts?: { onConflict?: string }) {
    this.op = "upsert"; this.payload = Array.isArray(rows) ? rows : [rows]
    this.onConflict = opts?.onConflict ? opts.onConflict.split(",").map((s) => s.trim()) : ["id"]
    return this
  }
  update(patch: Row) { this.op = "update"; this.payload = patch; return this }
  delete() { this.op = "delete"; return this }
  eq(c: string, v: any) { this.filters.push((r) => r[c] === v); return this }
  neq(c: string, v: any) { this.filters.push((r) => r[c] !== v); return this }
  is(c: string, v: any) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this }
  in(c: string, vs: any[]) { this.filters.push((r) => vs.includes(r[c])); return this }
  not(c: string, op: string, v: any) { if (op === "is" && v === null) this.filters.push((r) => r[c] != null); return this }
  ilike(c: string, pat: string) {
    const re = new RegExp("^" + pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i")
    this.filters.push((r) => re.test(String(r[c] ?? ""))); return this
  }
  gte(c: string, v: any) { this.filters.push((r) => r[c] >= v); return this }
  lte(c: string, v: any) { this.filters.push((r) => r[c] <= v); return this }
  order() { return this }
  limit(n: number) { this.max = n; return this }
  maybeSingle() { this.mode = "maybeSingle"; return this }
  single() { this.mode = "single"; return this }
  private violates(rows: Row[], candidate: Row, skip?: Row): string | null {
    for (const key of UNIQUE[this.table] ?? []) {
      if (key.some((k) => candidate[k] == null)) continue
      if (rows.some((r) => r !== skip && key.every((k) => r[k] === candidate[k]))) return `duplicate key value violates unique constraint (${this.table}: ${key.join(",")})`
    }
    return null
  }
  private run(): { data: any; error: any } {
    if (this.store.refuse.has(`${this.table}:${this.op}`)) return { data: null, error: { message: `refused by test (${this.table}:${this.op})`, code: "42501" } }
    const rows = this.store.t(this.table)
    const matched = () => rows.filter((r) => this.filters.every((f) => f(r)))
    let out: Row[] = []
    if (this.op === "select") {
      out = matched(); if (this.max != null) out = out.slice(0, this.max)
    } else if (this.op === "insert") {
      for (const p of this.payload) {
        const row = { id: newId(this.table.slice(0, 3)), ...p }
        const v = this.violates(rows, row); if (v) return { data: null, error: { message: v, code: "23505" } }
        rows.push(row); out.push(row)
      }
    } else if (this.op === "upsert") {
      for (const p of this.payload) {
        const hit = rows.find((r) => this.onConflict!.every((k) => p[k] != null && r[k] === p[k]))
        if (hit) { const next = { ...hit, ...p }; const v = this.violates(rows, next, hit); if (v) return { data: null, error: { message: v, code: "23505" } }; Object.assign(hit, p); out.push(hit) }
        else { const row = { id: newId(this.table.slice(0, 3)), ...p }; const v = this.violates(rows, row); if (v) return { data: null, error: { message: v, code: "23505" } }; rows.push(row); out.push(row) }
      }
    } else if (this.op === "update") {
      for (const r of matched()) { const next = { ...r, ...this.payload }; const v = this.violates(rows, next, r); if (v) return { data: null, error: { message: v, code: "23505" } }; Object.assign(r, this.payload); out.push(r) }
    } else if (this.op === "delete") {
      out = matched(); for (const r of out) rows.splice(rows.indexOf(r), 1)
    }
    if (this.op !== "select" && !this.wantSelect) return { data: null, error: null }
    if (this.mode === "maybeSingle") {
      if (out.length > 1) return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" } }
      return { data: out[0] ?? null, error: null }
    }
    if (this.mode === "single") {
      if (out.length !== 1) return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" } }
      return { data: out[0], error: null }
    }
    return { data: out.map((r) => ({ ...r })), error: null }
  }
  then<R1 = any, R2 = never>(res?: ((v: any) => R1 | PromiseLike<R1>) | null, rej?: ((e: any) => R2 | PromiseLike<R2>) | null): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(res as any, rej as any)
  }
}

function fakeClient(store: Store) {
  return {
    from: (table: string) => new Query(store, table),
    rpc: async () => ({ data: null, error: null }),
    auth: {
      admin: {
        inviteUserByEmail: async (email: string, opts?: { data?: Row }) => {
          const e = email.toLowerCase()
          if (store.authUsers.some((u) => u.email === e)) return { data: { user: null }, error: { message: "User already registered" } }
          const id = newId("auth")
          store.authUsers.push({ id, email: e })
          // on_auth_user_created: the trigger seeds public.users with the AUTH id + metadata.
          const md = opts?.data ?? {}
          store.t("users").push({ id, email: e, first_name: md.first_name ?? null, last_name: md.last_name ?? null, user_type: md.user_type ?? null, brokerage_id: md.brokerage_id ?? null, team_id: md.team_id ?? null, status: "active", platform_role: null })
          return { data: { user: { id, email: e } }, error: null }
        },
        getUserById: async (id: string) => { const u = store.authUsers.find((x) => x.id === id); return { data: { user: u ?? null }, error: u ? null : { message: "not found" } } },
        listUsers: async () => ({ data: { users: store.authUsers.map((u) => ({ ...u })) }, error: null }),
      },
    },
  }
}

// ─── THE SERVICE CLIENT STUB (before any kernel module loads) ───────────────
// tsx translates app modules through the CJS loader, where module.register
// hooks are not consulted (measured by scripts/next-headers-shim.ts) — so the
// ONE project leaf this proof replaces, lib/supabase/service.ts, is swapped in
// Module._load (the shim's idiom), with the ESM hook registered beside it for
// any module that does arrive through the ESM path. Nothing else is stubbed:
// users.ts, seat-usage.ts, lead-visibility.ts, emit.ts all execute for real.
let ACTIVE = new Store()
;(globalThis as any).__SEAT_PROOF_SERVICE__ = () => fakeClient(ACTIVE)
{
  const isServiceLeaf = (r: string) => r === "@/lib/supabase/service" || /[\\/]lib[\\/]supabase[\\/]service(\.ts)?$/.test(r)
  const nodeModule: any = _require("node:module")
  const realLoad = nodeModule._load
  nodeModule._load = function (request: string, ...rest: unknown[]) {
    if (isServiceLeaf(request)) return { createServiceClient: (globalThis as any).__SEAT_PROOF_SERVICE__ }
    if (request === "server-only" || /[\\/]node_modules[\\/]server-only[\\/]/.test(request)) return {}
    return realLoad.call(this, request, ...rest)
  }
  const SHIM = "vipre-seat-proof:service"
  const loader = `
export async function resolve(specifier, context, next) {
  if (specifier === "@/lib/supabase/service") return { shortCircuit: true, url: ${JSON.stringify(SHIM)} }
  const r = await next(specifier, context)
  if (/[\\\\/]lib[\\\\/]supabase[\\\\/]service\\.ts$/.test(r.url ?? "")) return { shortCircuit: true, url: ${JSON.stringify(SHIM)} }
  return r
}
export async function load(url, context, next) {
  if (url === ${JSON.stringify(SHIM)}) return { shortCircuit: true, format: "module", source: "export const createServiceClient = () => globalThis.__SEAT_PROOF_SERVICE__()" }
  return next(url, context)
}`
  const { register } = await import("node:module")
  try { register(`data:text/javascript,${encodeURIComponent(loader)}`) } catch { /* hooks unavailable — the CJS patch above still holds */ }
}
const users = await import("../lib/kernel/users")
const seatUsage = await import("../lib/kernel/seat-usage")
const leadVis = await import("../lib/auth/lead-visibility")
const roles = await import("../lib/auth/resolve-user-role")
const routes = await import("../lib/kernel/role-routes")
const matrix = await import("../lib/kernel/tier-role-matrix")

// ─── FIXTURE ────────────────────────────────────────────────────────────────
function seed(): Store {
  const s = new Store()
  s.t("brokerages").push({ id: "brk-1", name: "Solo One", plan_tier: "solo_agent", billing_metadata: {} })
  s.t("brokerages").push({ id: "brk-2", name: "Big Two", plan_tier: "brokerage", billing_metadata: {} })
  s.t("subscription_tiers").push(
    { tier_name: "solo_agent", max_agents: 2, is_active: true }, { tier_name: "team", max_agents: 10, is_active: true },
    { tier_name: "brokerage", max_agents: null, is_active: true }, { tier_name: "multi_location", max_agents: null, is_active: true })
  s.t("teams").push({ id: "team-1", brokerage_id: "brk-1", name: "Solo One", team_lead_id: "u-owner", deleted_at: null })
  s.t("teams").push({ id: "team-2", brokerage_id: "brk-2", name: "Two North", team_lead_id: null, deleted_at: null })
  s.t("teams").push({ id: "team-dead", brokerage_id: "brk-1", name: "Gone", team_lead_id: null, deleted_at: "2026-01-01" })
  // The solo OWNER: admin wearing an agents row (the producer the plan is sold to) — seat 1 of 2.
  s.authUsers.push({ id: "u-owner", email: "owner@b1.test" }, { id: "u-staff", email: "staff@platform.test" })
  s.t("users").push({ id: "u-owner", email: "owner@b1.test", user_type: "admin", brokerage_id: "brk-1", team_id: null, status: "active", platform_role: null })
  s.t("agents").push({ id: "agt-owner", user_id: "u-owner", brokerage_id: "brk-1", team_id: null, is_active: true })
  s.t("user_role_assignments").push({ id: "ura-owner", user_id: "u-owner", role: "admin", brokerage_id: "brk-1", team_id: null, agent_id: "agt-owner" })
  s.t("users").push({ id: "u-staff", email: "staff@platform.test", user_type: "admin", brokerage_id: null, team_id: null, status: "active", platform_role: "superadmin" })
  return s
}
const count = (s: Store, t: string, pred: (r: Row) => boolean = () => true) => s.t(t).filter(pred).length

// ─── CHAIN DETECTORS (the preventions, as pure predicates over the store) ───
const SEAT_ROLE_TYPES = new Set(["agent", "team_lead", "isa"])
const TENANT_USER_TYPES = new Set([...roles.TENANT_ADMIN_USER_TYPES, "agent", "tc", "isa"])
const orphanUsers = (s: Store) => s.t("users").filter((u) => u.brokerage_id && SEAT_ROLE_TYPES.has(u.user_type) && !s.t("agents").some((a) => a.user_id === u.id))
const orphanAgents = (s: Store) => s.t("agents").filter((a) => !s.t("users").some((u) => u.id === a.user_id))
const missingRole = (s: Store) => s.t("users").filter((u) => u.brokerage_id && TENANT_USER_TYPES.has(u.user_type) && !s.t("user_role_assignments").some((g) => g.user_id === u.id))
const wrongTenant = (s: Store) => [
  ...s.t("agents").filter((a) => { const u = s.t("users").find((x) => x.id === a.user_id); return u?.brokerage_id && a.brokerage_id !== u.brokerage_id }),
  ...s.t("user_role_assignments").filter((g) => { const u = s.t("users").find((x) => x.id === g.user_id); return u?.brokerage_id && g.brokerage_id && g.brokerage_id !== u.brokerage_id }),
]
const teamLeak = (s: Store) => s.t("users").filter((u) => u.team_id && s.t("teams").find((t) => t.id === u.team_id)?.brokerage_id !== u.brokerage_id)
const dup = (s: Store, t: string, key: string[]) => { const seen = new Set<string>(); return s.t(t).filter((r) => { const k = key.map((x) => r[x]).join("|"); if (seen.has(k)) return true; seen.add(k); return false }) }

async function chainOf(userId: string) {
  const ctx = await users.resolveUserWorkspaceContext(userId)
  const u = ACTIVE.t("users").find((x) => x.id === userId)!
  return { ctx, u, agent: ACTIVE.t("agents").find((a) => a.user_id === userId) ?? null, grants: ACTIVE.t("user_role_assignments").filter((g) => g.user_id === userId) }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[door A — TENANT ADMIN adds an agent on a team: the whole chain, in memory]")
ACTIVE = seed()
const a1 = await users.inviteTenantMember({ brokerageId: "brk-1", teamId: "team-1", email: "Agent1@b1.test", firstName: "Ann", lastName: "Agent", userType: "agent", callerUserId: "u-owner" })
check("the invite succeeds and returns the auth-linked user id", a1.success && !!a1.userId && ACTIVE.authUsers.some((u) => u.id === a1.userId), a1.error)
{
  const { ctx, u, agent, grants } = await chainOf(a1.userId!)
  check("USER: public.users.id === auth.users.id, email lower-cased, user_type agent", u.id === a1.userId && u.email === "agent1@b1.test" && u.user_type === "agent")
  check("TENANT: users.brokerage_id is the inviter's tenant", u.brokerage_id === "brk-1")
  check("ROLE: one user_role_assignments grant (agent) pinned to the same tenant + team + agent", grants.length === 1 && grants[0].role === "agent" && grants[0].brokerage_id === "brk-1" && grants[0].team_id === "team-1" && grants[0].agent_id === agent?.id)
  check("AGENT RECORD: agents row in the same tenant, on the team, active, with commission profile + onboarding", !!agent && agent.brokerage_id === "brk-1" && agent.team_id === "team-1" && agent.is_active === true
    && count(ACTIVE, "agent_commission_profiles", (p) => p.agent_id === agent!.id) === 1 && count(ACTIVE, "agent_onboarding", (o) => o.agent_id === agent!.id && o.user_id === u.id) === 1)
  check("TEAM: users.team_id and agents.team_id both name a team OF THIS TENANT", u.team_id === "team-1" && teamLeak(ACTIVE).length === 0)
  check("INVITATION LEDGER: exactly one pending user_invitations row for (tenant, email)", count(ACTIVE, "user_invitations", (i) => i.brokerage_id === "brk-1" && i.email === "agent1@b1.test" && i.status === "pending") === 1)
  check("RESOLVED WORKSPACE: complete, no setup required, grant seen, agent id seen", ctx.isComplete && !ctx.requiresSetup && ctx.hasRoleAssignment && ctx.agentId === agent?.id && ctx.brokerageId === "brk-1" && ctx.teamId === "team-1")
  check("AUTHORITY: the role resolves on the roster (an agent is NOT a tenant admin; the owner is)", !roles.TENANT_ADMIN_USER_TYPES.has(ctx.userType) && roles.TENANT_ADMIN_USER_TYPES.has("admin"))
  check("USABLE: the role has a dashboard route", typeof routes.roleDashboardRoute(ctx.userType) === "string" && routes.roleDashboardRoute(ctx.userType).startsWith("/"))
  const seats = await seatUsage.resolveSeatUsage(fakeClient(ACTIVE) as any, "brk-1")
  check("SEAT ALLOCATED: the meter counts the new producer (owner + agent = 2 of the solo band of 2)", seats.ok && seats.seatCount === 2 && seats.seatHolderIds.includes(u.id))
  check("ENTITLEMENT: the seat is a producer seat the plan sells (roleConsumesSeat) and the band comes from the catalogue", matrix.roleConsumesSeat("agent") === true && matrix.TIER_SEAT_LIMITS.solo_agent === 2)
  const lv = await leadVis.resolveLeadVisibility(fakeClient(ACTIVE) as any, { userId: u.id, userType: "agent", brokerageId: "brk-1", platformRole: null })
  check("LEADS: the agent is REFUSED the lead desk (owner: agents see CONTACTS only — leads are brokerage-only)", lv.allowed === false)
  const lvOwner = await leadVis.resolveLeadVisibility(fakeClient(ACTIVE) as any, { userId: "u-owner", userType: "admin", brokerageId: "brk-1", platformRole: null })
  check("  control: the brokerage admin IS admitted to the lead desk", lvOwner.allowed === true)
  check("EVIDENCE: the provisioning left a lifecycle_events row for the user (LAW 5)", count(ACTIVE, "lifecycle_events", (e) => e.entity_id === u.id) >= 1)
}

console.log("\n[idempotency — the same invite again, on a FULL tenant]")
{
  const before = { users: count(ACTIVE, "users"), agents: count(ACTIVE, "agents"), grants: count(ACTIVE, "user_role_assignments"), onb: count(ACTIVE, "agent_onboarding"), comm: count(ACTIVE, "agent_commission_profiles"), inv: count(ACTIVE, "user_invitations"), auth: ACTIVE.authUsers.length }
  const a1b = await users.inviteTenantMember({ brokerageId: "brk-1", teamId: "team-1", email: "agent1@b1.test", firstName: "Ann", lastName: "Agent", userType: "agent", callerUserId: "u-owner" })
  const after = { users: count(ACTIVE, "users"), agents: count(ACTIVE, "agents"), grants: count(ACTIVE, "user_role_assignments"), onb: count(ACTIVE, "agent_onboarding"), comm: count(ACTIVE, "agent_commission_profiles"), inv: count(ACTIVE, "user_invitations"), auth: ACTIVE.authUsers.length }
  check("the retry succeeds against the SAME auth id", a1b.success && a1b.userId === a1.userId, a1b.error)
  check("NO DUPLICATES: users/agents/grants/onboarding/commission/invitations/auth counts are unchanged", JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }))
  check("  control: the duplicate detector sees a planted second grant", dup((() => { const s = ACTIVE.clone(); s.t("user_role_assignments").push({ ...s.t("user_role_assignments")[0], id: "dup" }); return s })(), "user_role_assignments", ["user_id", "role"]).length === 1)
  const svc = fakeClient(ACTIVE) as any
  const subject = await users.seatSubjectForEmail(svc, "brk-1", "Agent1@b1.test")
  check("seatSubjectForEmail resolves the seated member on THIS tenant (case-insensitive) and not across tenants", subject === a1.userId && (await users.seatSubjectForEmail(svc, "brk-2", "agent1@b1.test")) === null)
  const withSubject = await seatUsage.seatGate(svc, "brk-1", "agent", { subjectUserId: subject })
  check("the seat gate passes the retry through as already_seated on a full solo tenant", withSubject.allowed && withSubject.reason === "already_seated")
  const withoutSubject = await seatUsage.seatGate(svc, "brk-1", "agent")
  check("  control (the defect the doors carried): the same gate WITHOUT a subject refuses the retry as a 3rd seat", !withoutSubject.allowed && withoutSubject.reason === "over_limit")
}

console.log("\n[seat overflow — refused with a clear message, by the gate the doors call]")
{
  const svc = fakeClient(ACTIVE) as any
  const v = await seatUsage.seatGate(svc, "brk-1", "agent", { subjectUserId: await users.seatSubjectForEmail(svc, "brk-1", "agent2@b1.test") })
  check("a 3rd producer on the solo band of 2 is refused (over_limit)", !v.allowed && v.reason === "over_limit" && v.seatCount === 2)
  check("the refusal is a sentence that names the way through (upgrade tier / seats), not a bare 'denied'", typeof v.message === "string" && v.message.length > 40 && !!v.decision && (v.decision.upgradeTo === "team" || v.decision.paths.length > 0), v.message ?? "")
  const free = await seatUsage.seatGate(svc, "brk-2", "agent")
  check("  control: the same add on the unlimited brokerage band is admitted", free.allowed && free.reason === "within_limit")
  const staff = await seatUsage.seatGate(svc, "brk-1", "tc")
  check("  control: free staff (tc) on the full solo tenant is not a seat and is admitted", staff.allowed && staff.reason === "not_a_seat")
}

console.log("\n[door B — PLATFORM STAFF adds a TC and an agent into another tenant]")
{
  const b1 = await users.inviteTenantMember({ brokerageId: "brk-2", email: "tc@b2.test", firstName: "Tom", lastName: "Coordinator", userType: "tc", callerUserId: "u-staff", redirectTo: "http://x/auth/callback?next=/dashboard/onboarding" })
  check("staff-created TC: user created into the TARGET tenant", b1.success && ACTIVE.t("users").find((u) => u.id === b1.userId)?.brokerage_id === "brk-2", b1.error)
  const { ctx, grants } = await chainOf(b1.userId!)
  check("STAFF RECORD: transaction_coordinators row, NO agents row (tc is staff), grant tc on brk-2, workspace complete", count(ACTIVE, "transaction_coordinators", (t) => t.user_id === b1.userId && t.brokerage_id === "brk-2") === 1 && !ACTIVE.t("agents").some((a) => a.user_id === b1.userId) && grants.length === 1 && grants[0].role === "tc" && grants[0].brokerage_id === "brk-2" && ctx.isComplete && ctx.coordinatorId !== null)
  const seats2 = await seatUsage.resolveSeatUsage(fakeClient(ACTIVE) as any, "brk-2")
  check("SEATS: the TC is free staff — 0 seats, 1 free staff on brk-2", seats2.ok && seats2.seatCount === 0 && seats2.freeStaffCount === 1)
  const b2 = await users.inviteTenantMember({ brokerageId: "brk-2", teamId: "team-2", email: "agent@b2.test", firstName: "Bea", lastName: "Two", userType: "agent", callerUserId: "u-staff" })
  const c2 = await chainOf(b2.userId!)
  check("staff-created agent on brk-2's own team: full chain (tenant, grant, agents row, team, complete)", b2.success && c2.u.brokerage_id === "brk-2" && c2.agent?.brokerage_id === "brk-2" && c2.agent?.team_id === "team-2" && c2.grants.length === 1 && c2.ctx.isComplete, b2.error)
  const b2again = await users.inviteTenantMember({ brokerageId: "brk-2", teamId: "team-2", email: "agent@b2.test", firstName: "Bea", lastName: "Two", userType: "agent", callerUserId: "u-staff" })
  check("staff door retry is idempotent too (same id, one agents row, one grant)", b2again.success && b2again.userId === b2.userId && count(ACTIVE, "agents", (a) => a.user_id === b2.userId) === 1 && count(ACTIVE, "user_role_assignments", (g) => g.user_id === b2.userId) === 1)
}

console.log("\n[preventions over everything both doors produced — each with a positive control]")
{
  check("no ORPHAN USER (seat-role user without an agent record)", orphanUsers(ACTIVE).length === 0)
  check("  control: a planted agent-type user with no agents row is flagged", orphanUsers((() => { const s = ACTIVE.clone(); s.t("users").push({ id: "x1", email: "x1@b1.test", user_type: "agent", brokerage_id: "brk-1" }); return s })()).length === 1)
  check("no ORPHAN AGENT (agents row whose user is gone)", orphanAgents(ACTIVE).length === 0)
  check("  control: a planted agents row with no users row is flagged", orphanAgents((() => { const s = ACTIVE.clone(); s.t("agents").push({ id: "x2", user_id: "nobody", brokerage_id: "brk-1" }); return s })()).length === 1)
  check("no MISSING ROLE (tenant user without a grant)", missingRole(ACTIVE).length === 0)
  check("  control: a planted tenant user with no grant is flagged", missingRole((() => { const s = ACTIVE.clone(); s.t("users").push({ id: "x3", email: "x3@b1.test", user_type: "tc", brokerage_id: "brk-1" }); return s })()).length === 1)
  check("no WRONG TENANT (agents / grants in a different tenant than their user)", wrongTenant(ACTIVE).length === 0)
  check("  control: a planted cross-tenant grant is flagged", wrongTenant((() => { const s = ACTIVE.clone(); s.t("user_role_assignments").push({ id: "x4", user_id: a1.userId, role: "tc", brokerage_id: "brk-2" }); return s })()).length === 1)
  check("no TEAM LEAKAGE (users.team_id outside the user's tenant)", teamLeak(ACTIVE).length === 0)
  check("  control: a planted foreign team_id is flagged", teamLeak((() => { const s = ACTIVE.clone(); s.t("users").find((u) => u.id === a1.userId)!.team_id = "team-2"; return s })()).length === 1)
  check("no DUPLICATE records on any keyed table", ["users", "agents", "user_role_assignments", "agent_onboarding"].every((t) => dup(ACTIVE, t, UNIQUE[t][1]).length === 0))
}

console.log("\n[team / location leakage — refused at the ONE convergence point, fail closed]")
{
  const leak = await users.inviteTenantMember({ brokerageId: "brk-1", teamId: "team-2", email: "leak@b1.test", firstName: "L", lastName: "Eak", userType: "agent", callerUserId: "u-owner" })
  check("a team id from ANOTHER tenant is refused with a sentence, and no user is minted", !leak.success && /not part of this workspace/i.test(leak.error ?? "") && !ACTIVE.t("users").some((u) => u.email === "leak@b1.test") && !ACTIVE.authUsers.some((u) => u.email === "leak@b1.test"), leak.error)
  const dead = await users.inviteTenantMember({ brokerageId: "brk-1", teamId: "team-dead", email: "leak2@b1.test", firstName: "L", lastName: "Eak", userType: "agent", callerUserId: "u-owner" })
  check("a soft-deleted team of this tenant is refused too", !dead.success && !ACTIVE.t("users").some((u) => u.email === "leak2@b1.test"))
  ACTIVE.refuse.add("teams:select")
  const refused = await users.inviteTenantMember({ brokerageId: "brk-1", teamId: "team-1", email: "leak3@b1.test", firstName: "L", lastName: "Eak", userType: "agent", callerUserId: "u-owner" })
  ACTIVE.refuse.delete("teams:select")
  check("FAIL CLOSED: a refused teams read refuses the invite (never 'no such team', never a seat)", !refused.success && /could not be verified/i.test(refused.error ?? "") && !ACTIVE.t("users").some((u) => u.email === "leak3@b1.test"))
  check("  control: the same tenant's live team was accepted above (door A linked team-1)", ACTIVE.t("users").find((u) => u.id === a1.userId)?.team_id === "team-1")
}

console.log("\n[wrong tenant — a tenant admin cannot capture another tenant's member by email]")
{
  const cap = await users.inviteTenantMember({ brokerageId: "brk-1", email: "tc@b2.test", firstName: "Tom", lastName: "C", userType: "tc", callerUserId: "u-owner" })
  check("refused with the cross-tenant sentence; the member stays on brk-2", !cap.success && /another brokerage/i.test(cap.error ?? "") && ACTIVE.t("users").find((u) => u.email === "tc@b2.test")?.brokerage_id === "brk-2", cap.error)
}

console.log("\n[missing role is REPORTED, never success — the dropped result]")
{
  ACTIVE.refuse.add("user_role_assignments:upsert")
  const r = await users.inviteTenantMember({ brokerageId: "brk-2", email: "norole@b2.test", firstName: "N", lastName: "R", userType: "tc", callerUserId: "u-staff" })
  ACTIVE.refuse.delete("user_role_assignments:upsert")
  check("a refused role grant makes the invite report FAILURE with the user id and a retry sentence", !r.success && r.userId !== null && /workspace records were not completed/i.test(r.error ?? ""), r.error)
  const r2 = await users.inviteTenantMember({ brokerageId: "brk-2", email: "norole@b2.test", firstName: "N", lastName: "R", userType: "tc", callerUserId: "u-staff" })
  check("  control: the idempotent retry without the refusal completes the chain on the SAME id (grant now present)", r2.success && r2.userId === r.userId && count(ACTIVE, "user_role_assignments", (g) => g.user_id === r.userId) === 1 && missingRole(ACTIVE).length === 0, r2.error)
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[the doors converge on the ONE provisioner + the ONE gate (stripped source)]")
{
  const strip = (p: string) => blankStrings(stripComments(src(p)))
  const invite = strip("app/actions/admin/invite-user.ts"), god = strip("app/actions/superadmin/tenant-users.ts"), recruit = strip("app/api/recruiting/provision-agent/route.ts"), staff = strip("app/actions/superadmin/platform-staff.ts")
  check("tenant invite: seatGate(…subjectUserId) then inviteTenantMember(", /seatGate\([^)]*subjectUserId/.test(invite) && /inviteTenantMember\(/.test(invite) && /seatSubjectForEmail\(/.test(invite))
  check("god console: seatGate(…subjectUserId) then inviteTenantMember(", /seatGate\([^)]*subjectUserId/.test(god) && /inviteTenantMember\(/.test(god) && /seatSubjectForEmail\(/.test(god))
  check("recruiting door: calls inviteTenantMember( and no longer hand-rolls users/agents/onboarding writes", /inviteTenantMember\(/.test(recruit) && !/\.from\(\s*\)\s*\.upsert\(/.test(recruit.replace(/from\("users"\)/g, "from()")) && !/auth\.admin\.inviteUserByEmail/.test(recruit) && !/from\("agent_onboarding"\)/.test(recruit))
  check("  control: the recruiting tombstone still NAMES the retired writes in a comment (raw source), proving the scan is comment-blind", /users\.upsert\(onConflict:"email"\)/.test(src("app/api/recruiting/provision-agent/route.ts")))
  check("platform-staff door: promotion refuses an email that belongs to a tenant member (brokerage_id set) and READS the invite error", /existing\?\.brokerage_id/.test(staff) && /error:\s*invErr/.test(staff))
  // Comment-stripped but NOT string-blanked: this check pins the column names in the query shape.
  const kernel = stripComments(src("lib/kernel/users.ts"))
  check("inviteTenantMember verifies the team belongs to the tenant (teams · id · brokerage_id · deleted_at) before any write", /from\("teams"\)[\s\S]{0,200}\.eq\("id",\s*teamId\)[\s\S]{0,80}\.eq\("brokerage_id",\s*brokerageId\)[\s\S]{0,80}\.is\("deleted_at",\s*null\)/.test(kernel))
  check("inviteTenantMember propagates a failed domain-record run (no silent success)", /if \(!domain\.success\)\s*\{[\s\S]{0,400}success:\s*false/.test(kernel))
}

console.log("\n[no lazy repair on the login / session path — detection + evidence + visible route only]")
{
  const LOGIN_PATH = [
    "app/dashboard/page.tsx", "app/dashboard/onboarding/page.tsx", "app/auth/callback/route.ts", "app/actions/auth.ts",
    "lib/identity/get-agent-context.ts", "proxy.ts", "lib/supabase/middleware.ts", "lib/supabase/server.ts",
  ].filter((p) => existsSync(join(ROOT, p)))
  const REPAIR_CALL = /\b(repairIncompleteAccountSetup|ensureAgentBrokerage|ensureAgentContextInPlace|createOrRepairUserDomainRecords|inviteTenantMember|provisionTenantOwner)\s*\(/
  const LAZY_WRITE = /\.from\(\s*"(agents|users|user_role_assignments|agent_onboarding|brokerages|subscriptions|teams)"\s*\)\s*\.\s*(insert|upsert)\s*\(/
  const offenders: string[] = []
  for (const p of LOGIN_PATH) {
    const s = stripComments(src(p))
    const m = s.match(REPAIR_CALL) ?? s.match(LAZY_WRITE)
    if (m) offenders.push(`${p}: ${m[0]}`)
  }
  check(`no login-path file calls a repair or writes an identity row (${LOGIN_PATH.length} files scanned: ${LOGIN_PATH.join(", ")})`, offenders.length === 0, offenders.join("; "))
  check("  control: the finder flags a live repair call", REPAIR_CALL.test(stripComments(`export default async function P() {\n  await repairIncompleteAccountSetup(ctx.userId)\n}`)))
  check("  control: the finder flags a lazy identity write", LAZY_WRITE.test(stripComments(`const r = await svc.from("agents").insert({ user_id: id })`)))
  check("  control: a tombstone naming the retired call is NOT flagged (comment-blind)", !REPAIR_CALL.test(stripComments(`// this page used to call repairIncompleteAccountSetup() on every visit\nconst x = 1`)))
  const dash = stripComments(src("app/dashboard/page.tsx"))
  check("the dashboard router DETECTS (resolveUserWorkspaceContext) and EVIDENCES (USER_ACCOUNT_INCOMPLETE) an incomplete account", /resolveUserWorkspaceContext\(/.test(dash) && /USER_ACCOUNT_INCOMPLETE/.test(dash) && /determineFirstLoginDestination\(/.test(dash))
  check("both landings route a detected account gap through the readiness contract — evaluateTenantReadiness(…, { repair: true }) — never a bare lazy repair", /evaluateTenantReadiness\([\s\S]{0,120}repair:\s*true/.test(src("app/dashboard/page.tsx")) && /evaluateTenantReadiness\([\s\S]{0,120}repair:\s*true/.test(src("app/dashboard/onboarding/page.tsx")))
  check("the repair executor survives for the readiness repair (exported, documented as not-a-login-hook)", /export async function repairIncompleteAccountSetup\(/.test(src("lib/kernel/users.ts")) && /NOT A LOGIN HOOK/.test(src("lib/kernel/users.ts")))
}

console.log("\n[live backlog shape (lane 140O) — users with no role grant + seat-role users without an agents row, cleared by the executor the readiness playbook runs]")
{
  // The two classes observed live (10 users with no grant, 4 seat-role users with no agents row),
  // planted in memory on brk-2. The readiness contract routes `repair_user_records`
  // (lib/kernel/self-healing.ts) to lib/kernel/users.ts repairIncompleteAccountSetup — the ONE
  // provisioning brain — so that executor is what must clear both classes, per user.
  ACTIVE.authUsers.push({ id: "u-norole", email: "norole@b2.test" }, { id: "u-noagent", email: "noagent@b2.test" })
  ACTIVE.t("users").push(
    { id: "u-norole", email: "norole@b2.test", first_name: "No", last_name: "Grant", user_type: "tc", brokerage_id: "brk-2", team_id: null, status: "active", platform_role: null },
    { id: "u-noagent", email: "noagent@b2.test", first_name: "No", last_name: "Agent", user_type: "agent", brokerage_id: "brk-2", team_id: "team-2", status: "active", platform_role: null },
  )
  check("  control: both detectors see the planted backlog (1 missing grant, 1 seat-role user without an agents row)", missingRole(ACTIVE).some((u) => u.id === "u-norole") && orphanUsers(ACTIVE).some((u) => u.id === "u-noagent") && missingRole(ACTIVE).some((u) => u.id === "u-noagent"))
  const r1 = await users.repairIncompleteAccountSetup("u-norole")
  const r2 = await users.repairIncompleteAccountSetup("u-noagent")
  check("repairIncompleteAccountSetup (the repair_user_records executor) succeeds for both users", r1.success && r2.success, `${r1.error ?? ""} ${r2.error ?? ""}`)
  check("after repair: NO missing role and NO orphan user remain anywhere in the store", missingRole(ACTIVE).length === 0 && orphanUsers(ACTIVE).length === 0, JSON.stringify({ missingRole: missingRole(ACTIVE).map((u) => u.id), orphanUsers: orphanUsers(ACTIVE).map((u) => u.id) }))
  const tcGrants = ACTIVE.t("user_role_assignments").filter((g) => g.user_id === "u-norole")
  const agGrants = ACTIVE.t("user_role_assignments").filter((g) => g.user_id === "u-noagent")
  const ag = ACTIVE.t("agents").find((a) => a.user_id === "u-noagent")
  check("the tc now holds exactly one grant (tc) on ITS tenant + a coordinator row; the agent holds one grant + an agents row on its tenant and team", tcGrants.length === 1 && tcGrants[0].role === "tc" && tcGrants[0].brokerage_id === "brk-2" && count(ACTIVE, "transaction_coordinators", (t) => t.user_id === "u-norole" && t.brokerage_id === "brk-2") === 1
    && agGrants.length === 1 && agGrants[0].role === "agent" && agGrants[0].brokerage_id === "brk-2" && !!ag && ag.brokerage_id === "brk-2" && ag.team_id === "team-2" && wrongTenant(ACTIVE).length === 0 && teamLeak(ACTIVE).length === 0)
  check("EVIDENCE: each repair left a USER_ACCOUNT_REPAIRED lifecycle row (LAW 5)", count(ACTIVE, "lifecycle_events", (e) => e.entity_id === "u-norole") >= 1 && count(ACTIVE, "lifecycle_events", (e) => e.entity_id === "u-noagent") >= 1)
  const before = { users: count(ACTIVE, "users"), agents: count(ACTIVE, "agents"), grants: count(ACTIVE, "user_role_assignments"), tcs: count(ACTIVE, "transaction_coordinators"), onb: count(ACTIVE, "agent_onboarding") }
  const r3 = await users.repairIncompleteAccountSetup("u-noagent")
  const after = { users: count(ACTIVE, "users"), agents: count(ACTIVE, "agents"), grants: count(ACTIVE, "user_role_assignments"), tcs: count(ACTIVE, "transaction_coordinators"), onb: count(ACTIVE, "agent_onboarding") }
  check("idempotent: a second repair of a now-complete user repairs nothing and creates nothing", r3.success && r3.repaired.length === 0 && JSON.stringify(before) === JSON.stringify(after))
  // The ROUTING (read-only pins; lane N owns the contract): the playbook executor is this function, and the
  // contract's adminUser check routes it for the OWNER only — a non-owner backlog needs the executor per user.
  const heal = stripComments(src("lib/kernel/self-healing.ts")), contract = stripComments(src("lib/kernel/tenant-readiness.ts"))
  const exec = heal.slice(heal.indexOf("repair_user_records: async"), heal.indexOf("sync_carrier_registration: async"))
  check("self-healing's repair_user_records executor runs repairIncompleteAccountSetup behind a same-tenant check (every id pinned to i.brokerageId BEFORE the repairer runs; a foreign id is a boundary stop)", exec.indexOf('.eq("brokerage_id", i.brokerageId)') > -1 && exec.indexOf('.eq("brokerage_id", i.brokerageId)') < exec.indexOf("repairIncompleteAccountSetup") && /tenant_boundary/.test(exec))
  check("the readiness contract routes repair_user_records for the owner (adminUser) AND for every incomplete seat user (seats → userIds list) — the live 9 + 4 backlog is cleared by the contract, not by hand", /"repair_user_records",\s*\{\s*userId:\s*owner\.id\s*\}/.test(contract) && /"repair_user_records",\s*\{\s*userIds:/.test(contract) && /userIds/.test(exec))
}

console.log("\n[registration]")
{
  const reg = src("lib/kernel/manager-registry.ts"), pkg = src("package.json")
  check("MAINTENANCE_DOMAINS owns seat_user_convergence with this proof", /seat_user_convergence:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:seat-user-convergence"/.test(reg))
  check("package.json runs this file", /"test:seat-user-convergence":\s*"(?:NODE_OPTIONS=[^\s"]+\s+)?tsx scripts\/seat-user-convergence-guard\.ts"/.test(pkg))
  check("the guard chain includes it (membership, not position)", new RegExp("npm run test:seat-user-convergence(\\s|&|$)").test(pkg))
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
console.log("BLIND SPOTS: in-memory fake (no RLS, no triggers beyond the auth→users seed, no FK on agents.user_id — the live FK 23503 is the orphan-agent prevention); the server actions' auth gates (requireSuperadmin / isTenantCommerceAdmin) are proved by source, not executed; the login-path census is the named login/session files that exist, not every page that renders after login (the in-place work-page heal, lib/identity/ensure-agent-context.ts, is a separate ruling — identity_self_heal).")
if (failed > 0) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1) }
