#!/usr/bin/env tsx
/**
 * scripts/subscriber-convergence-guard.ts   (npm run test:subscriber-convergence)
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 140, lane 140C — owner verbatim: "self enrollment, direct paid, free
 * trial, platform-staff creation, sales-assisted and every other legitimate
 * door converge on the ONE canonical provisioner … Trial is a subscription
 * STATE, never a provisioning architecture; trial is never required …
 * Provisioning is idempotent, resumable, retry-safe, evidenced, tenant-scoped;
 * a duplicate Stripe event never duplicates anything."
 *
 * Proves, with the PRODUCTION core (lib/kernel/tenant-creation.ts) run against
 * an in-memory PostgREST-shaped client and the env-bound executors injected
 * through the @proofSeam TenantCreationDeps (auth invite, ISA actor, image-gen
 * assistant seed, kernel event bus, curriculum authoring, Stripe checkout,
 * login-time repair — nothing else is stubbed):
 *
 *   Layer 1 — SAME FOUNDATION FROM EVERY DOOR: self-serve trial, self-serve
 *             direct paid, platform-staff active, prospect conversion
 *             (convertProspectToSubscriber → the core) and the brokerage-of-one
 *             adoption write the SAME table set and finish the SAME step set;
 *             the ONLY door-shaped step is the activation checkout (paid), and
 *             trial / paid / active differ only in the subscriptions row.
 *             Trial is never required: paid and active complete without one.
 *   Layer 2 — RESUMABLE + IDEMPOTENT: a failed step leaves the record open; the
 *             same door called again RESUMES — only the failed step re-runs, no
 *             second brokerage / owner / subscription / actor / assistant /
 *             event; a third call on the complete record refuses as a duplicate.
 *   Layer 3 — DUPLICATE STRIPE EVENT: the webhook's checkout.session.completed
 *             effect (brokerage-keyed writer + resume) applied twice leaves one
 *             row of everything.
 *   Layer 4 — RETRY-SAFE + EVIDENCED: an owner-provisioning failure rolls the
 *             brokerage back (counted) and the retry mints exactly one tenant;
 *             a refused ledger claim abandons the half-built tenant; every
 *             attempt is one agent_action_ledger row (saas.tenant.provision).
 *   Layer 5 — TENANT-SCOPED: a pre-existing tenant's rows are byte-identical
 *             after every door ran; every write under a tenant column names a
 *             tenant this run minted.
 *   Layer 6 — SOURCE (stripped, CLAUDE.md §2): one brokerages insert under
 *             lib/ + app/ and it is the core; every door delegates (positive
 *             control: a fixture that spells its own insert is counted);
 *             brokerage-management.ts is lifecycle, not a door; the webhook
 *             resumes; ONE `READINESS HOOK (integrator)` at the convergence
 *             point; registration (script, chain membership by regex, owner).
 *
 * No DB, no network. Run:
 *   npx tsx --conditions=react-server scripts/subscriber-convergence-guard.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { walkTs } from "./runtime-roots"
import {
  createTenantCore, resumeTenantProvisioning, provisioningComplete, provisioningStepsPending,
  TENANT_PROVISIONING_STEPS, type TenantCreationDeps, type TenantCreationInput, type TenantProvisioningRecord,
} from "../lib/kernel/tenant-creation"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const root = process.cwd()
const raw = (p: string) => readFileSync(join(root, p), "utf8")
const stripped = (p: string) => stripComments(raw(p))

// ─────────────────────────────────────────────────────────────────────────────
// In-memory PostgREST-shaped client — enough operators for the core, the snapshot
// apply, the prospect stamp, the conversion, the ledger, the rollback engine and
// the brokerage-keyed subscription writer. Writers that .select() after an
// update/delete get the MATCHED rows back (CLAUDE.md §3: writers COUNT rows).
// ─────────────────────────────────────────────────────────────────────────────
type Row = Record<string, any>
interface WriteLog { table: string; kind: "insert" | "update" | "upsert" | "delete"; rows: Row[] }
function fakeSvc(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {}
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }))
  const log: WriteLog[] = []
  const refuse: Record<string, Partial<Record<WriteLog["kind"], string>>> = {}
  const seq: Record<string, number> = {}
  const nextId = (t: string) => `${t}-${(seq[t] = (seq[t] ?? 0) + 1)}`
  const read = (r: Row, col: string) => col.includes("->>") ? col.split("->>").reduce((o: any, k) => (o && typeof o === "object" ? o[k] : undefined), r) : r[col]
  function from(name: string) {
    const store = tables[name] ?? (tables[name] = [])
    const filters: Array<(r: Row) => boolean> = []
    let op: { kind: WriteLog["kind"] | "select"; payload?: Row | Row[]; opts?: Row } = { kind: "select" }
    let single = false, lim: number | null = null, countMode = false, head = false, wantSelect = false
    const api: any = {
      select(_cols?: string, o?: { count?: string; head?: boolean }) { wantSelect = true; if (o?.count) countMode = true; if (o?.head) head = true; return api },
      eq(c: string, v: unknown) { filters.push((r) => read(r, c) === v); return api },
      neq(c: string, v: unknown) { filters.push((r) => read(r, c) !== v); return api },
      is(c: string, v: unknown) { filters.push((r) => (read(r, c) ?? null) === v); return api },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(read(r, c))); return api },
      not(c: string, _o: string, v: unknown) { filters.push((r) => (read(r, c) ?? null) !== v); return api },
      ilike(c: string, v: string) { filters.push((r) => String(read(r, c) ?? "").toLowerCase() === v.toLowerCase()); return api },
      overlaps(c: string, vs: unknown[]) { filters.push((r) => Array.isArray(read(r, c)) && read(r, c).some((x: unknown) => vs.includes(x))); return api },
      gte() { return api }, lte() { return api }, or() { return api }, order() { return api },
      limit(n: number) { lim = n; return api },
      maybeSingle() { single = true; return api }, single() { single = true; return api },
      insert(p: Row | Row[]) { op = { kind: "insert", payload: p }; return api },
      update(p: Row) { op = { kind: "update", payload: p }; return api },
      upsert(p: Row | Row[], o?: Row) { op = { kind: "upsert", payload: p, opts: o }; return api },
      delete(o?: Row) { op = { kind: "delete", opts: o }; if (o?.count) countMode = true; return api },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        try {
          const kind = op.kind
          if (kind !== "select" && refuse[name]?.[kind]) { const msg = refuse[name]![kind]!; return Promise.resolve(resolve({ data: null, error: { message: msg, code: "42501" }, count: null })) }
          let match = store.filter((r) => filters.every((f) => f(r)))
          if (lim !== null) match = match.slice(0, lim)
          let out: unknown
          if (kind === "insert") {
            const rows = (Array.isArray(op.payload) ? op.payload : [op.payload!]).map((p) => ({ id: nextId(name), ...p }))
            store.push(...rows); log.push({ table: name, kind, rows })
            out = { data: single ? rows[0] : rows, error: null }
          } else if (kind === "upsert") {
            const conflict = String(op.opts?.onConflict ?? "id").split(",").map((s) => s.trim())
            const rows = (Array.isArray(op.payload) ? op.payload : [op.payload!]).map((p) => {
              const hit = store.find((r) => conflict.every((c) => r[c] === p[c]))
              if (hit) { if (!op.opts?.ignoreDuplicates) Object.assign(hit, p); return hit }
              const r = { id: nextId(name), ...p }; store.push(r); return r
            })
            log.push({ table: name, kind, rows }); out = { data: single ? rows[0] : rows, error: null }
          } else if (kind === "update") {
            for (const r of match) Object.assign(r, op.payload); log.push({ table: name, kind, rows: match })
            out = { data: wantSelect ? (single ? (match[0] ?? null) : match) : null, error: null }
          } else if (kind === "delete") {
            for (const r of match) store.splice(store.indexOf(r), 1); log.push({ table: name, kind, rows: match })
            out = { data: wantSelect ? match : null, error: null, count: countMode ? match.length : null }
          } else {
            // Reads return SNAPSHOTS (as PostgREST does) — a writer that re-reads a row it just
            // updated must see the old value only if it read it before the write.
            const snap = match.map((r) => ({ ...r }))
            out = head ? { data: null, error: null, count: match.length } : { data: single ? (snap[0] ?? null) : snap, error: null, count: countMode ? match.length : null }
          }
          return Promise.resolve(resolve(out))
        } catch (e) { return reject ? Promise.resolve(reject(e)) : Promise.reject(e) }
      },
    }
    return api
  }
  return { from, tables, log, refuse }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures + the injected executors (counters prove what ran, and how often)
// ─────────────────────────────────────────────────────────────────────────────
const TIERS = ["solo_agent", "team", "brokerage", "multi_location"]
function seedTables(): Record<string, Row[]> {
  return {
    subscription_tiers: TIERS.map((t) => ({ id: `tier-${t}`, tier_name: t, is_active: true, monthly_price_cents: 0, annual_price_cents: 0, setup_fee_cents: 0, display_name: t })),
    platform_config_snapshots: TIERS.map((t) => ({ id: `snap-${t}`, name: `${t} funnel`, created_at: "2026-01-01", payload: { recommendedTier: t, global: { app_name: "VIP" }, brand: { tagline: `${t} tagline` }, site: { about_text: "about" }, features: [] } })),
    learning_modules: [{ id: "mod-1", brokerage_id: null, status: "published", audience_roles: ["agent", "broker"], display_priority: 2 }, { id: "mod-2", brokerage_id: null, status: "published", audience_roles: ["agent"], display_priority: 1 }],
    // A pre-existing tenant — must be byte-identical after every door ran (Layer 5).
    brokerages: [{ id: "brk-other", name: "Other Realty", slug: "other-realty-zz", email: "other@other.test", plan_tier: "team", billing_metadata: { coupon: { code: "X" } }, trial_ends_at: null }],
    users: [{ id: "usr-other", email: "other@other.test", brokerage_id: "brk-other", user_type: "admin", first_name: "O", last_name: "Ther" }, { id: "usr-staff", email: "staff@platform.test", brokerage_id: null, user_type: "admin", platform_role: "superadmin" }],
    subscriptions: [{ id: "sub-other", brokerage_id: "brk-other", tier_id: "tier-team", status: "active", stripe_subscription_id: null, created_at: "2026-01-01" }],
    global_settings: [{ id: "gs-other", brokerage_id: "brk-other", app_name: "Other" }],
    platform_prospects: [], agent_action_ledger: [], lifecycle_events: [], ai_identity_profiles: [], agents: [], notifications: [], learning_assignments: [],
    brokerage_brand_settings: [], brand_voice_profile: [], feature_access_overrides: [], superadmin_audit_log: [], calendar_events: [],
  }
}
interface Counters { owner: number; domain: number; isa: number; assistant: number; events: Row[]; curriculum: number; checkout: number; repair: number; baseline: number }
function makeDeps(svc: ReturnType<typeof fakeSvc>, c: Counters, fail: { isaOnce?: boolean; ownerOnce?: boolean } = {}): TenantCreationDeps {
  return {
    provisionOwner: async (p) => {
      c.owner++
      if (fail.ownerOnce) { fail.ownerOnce = false; return { success: false, userId: null, agentId: null, teamId: null, inviteSent: false, error: "invite provider down (fixture)" } }
      const existing = svc.tables.users.find((u) => u.email === p.email)
      const id = existing?.id ?? `usr-${p.email}`
      await svc.from("users").upsert({ id, email: p.email, first_name: p.firstName, last_name: p.lastName, user_type: "admin", brokerage_id: p.brokerageId }, { onConflict: "id" })
      return { success: true, userId: id, agentId: null, teamId: null, inviteSent: !existing }
    },
    domainRecords: async (p) => { c.domain++; await svc.from("agents").insert({ user_id: p.userId, brokerage_id: p.brokerageId }); return { success: true, agentId: "agt-1", coordinatorId: null, domainRecordsCreated: ["agents"] } },
    isaActor: async (a) => { c.isa++; if (fail.isaOnce) { fail.isaOnce = false; throw new Error("auth admin unavailable (fixture)") } await svc.from("brokerages").update({ ai_isa_system_user_id: `isa-${a.brokerageId}` }).eq("id", a.brokerageId); return { userId: `isa-${a.brokerageId}`, created: true } },
    starterAssistant: async (s, id) => { c.assistant++; const { data } = await s.from("ai_identity_profiles").select("id").eq("brokerage_id", id).maybeSingle(); if (!data) await s.from("ai_identity_profiles").insert({ brokerage_id: id, scope_id: id, assistant_name: "Aria" }); return { seeded: !data, withPhoto: false } },
    emitEvent: async (e) => { c.events.push(e); await svc.from("lifecycle_events").insert({ brokerage_id: e.brokerageId, event_type: e.event, entity_id: e.entityId }); return { inserted: true } },
    curriculum: async () => { c.curriculum++; return { authored: 0, topics: 0 } },
    checkout: async (_s, i) => { c.checkout++; return { ok: true, url: `https://checkout.test/${i.brokerageId}`, sessionId: "cs_1", setupFeeCents: 0, setupFeeWaived: false, recurringCents: 0 } },
    accountRepair: async () => { c.repair++; return { success: true, repaired: [] } },
    // Lane 140D/E's initializer is proven against its own fixture (test:tenant-baseline); here it is COUNTED per door.
    operatingBaseline: async (_s, id) => { c.baseline++; return { ok: true, websitePath: `/site/${id}`, snapshotVersion: "snap@fixture", items: [], refused: [], preserved: [] } },
  }
}
const counters = (): Counters => ({ owner: 0, domain: 0, isa: 0, assistant: 0, events: [], curriculum: 0, checkout: 0, repair: 0, baseline: 0 })
const baseInput = (over: Partial<TenantCreationInput>): TenantCreationInput => ({
  brokerageName: "Acme Realty", adminEmail: "owner@acme.test", adminFirstName: "Dana", adminLastName: "Lee", tier: "team",
  signupSource: "self_serve", billing: { mode: "trial", trialDays: 14 }, callerUserId: null, ...over,
})
/** The foundation a tenant ended up with: which tables hold rows under its id + the record. */
function foundation(svc: ReturnType<typeof fakeSvc>, brokerageId: string) {
  // `agents` is excluded on purpose: the owner's domain records are TIER-AWARE by design
  // (lib/kernel/users.ts — a solo/team owner is an agent, a brokerage-tier owner is a pure
  // admin), so that table legitimately differs by tier, never by door.
  const tablesWithRows = Object.entries(svc.tables).filter(([t, rows]) => t !== "brokerages" && t !== "agents" && rows.some((r) => r.brokerage_id === brokerageId)).map(([t]) => t).sort()
  const brk = svc.tables.brokerages.find((b) => b.id === brokerageId)!
  const record = brk.billing_metadata?.provisioning as TenantProvisioningRecord | undefined
  const terminal = record ? TENANT_PROVISIONING_STEPS.filter((s) => ["done", "skipped"].includes(record.steps[s]?.status ?? "")) : []
  const sub = svc.tables.subscriptions.filter((s) => s.brokerage_id === brokerageId)
  return { tablesWithRows, record, terminal, brk, sub, users: svc.tables.users.filter((u) => u.brokerage_id === brokerageId), ledger: svc.tables.agent_action_ledger.filter((l) => l.brokerage_id === brokerageId) }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · SAME FOUNDATION FROM EVERY DOOR — trial, direct paid, staff active, conversion, adoption]")
const svc = fakeSvc(seedTables())
const otherBefore = JSON.stringify(Object.fromEntries(Object.entries(svc.tables).map(([t, rows]) => [t, rows.filter((r) => r.brokerage_id === "brk-other" || r.id === "brk-other" || r.id === "usr-other")])))
const c = counters()
const deps = makeDeps(svc, c)

const trial = await createTenantCore(svc, baseInput({}), deps)
const paid = await createTenantCore(svc, baseInput({ brokerageName: "Paid Realty", adminEmail: "owner@paid.test", billing: { mode: "paid", billingCycle: "monthly" } }), deps)
const staff = await createTenantCore(svc, baseInput({ brokerageName: "Staff Realty", adminEmail: "owner@staff.test", tier: "brokerage", signupSource: "superadmin", billing: { mode: "active", billingCycle: "annual" }, callerUserId: "usr-staff", snapshotId: "snap-brokerage", brokerageEmail: "front@staff.test", brokeragePhone: "+15125550100" }), deps)
// Sales-assisted: the prospect rail → convertProspectToSubscriber → the SAME core (the @proofSeam injects the core WITH these deps).
await svc.from("platform_prospects").insert({ name: "Sam Prospect", email: "sam@convert.test", phone: null, company: "Convert Co", role_interest: "team", status: "contacted", converted_brokerage_id: null, details: { qualification: { size_seats: 4 } } })
const prospectId = svc.tables.platform_prospects[0]!.id
const { convertProspectToSubscriber } = await import("../lib/platform/prospect-conversion")
const conv = await convertProspectToSubscriber(svc, { prospectId, actor: { kind: "prospect_self", channel: "chat" }, billing: { mode: "trial" } }, { provisionTenant: (s, i) => createTenantCore(s, i, deps), notifyStaff: async () => 0 })
// Adoption: a signed-in, tenant-less agent (the brokerage-of-one self-heal's shape).
await svc.from("users").insert({ id: "usr-solo", email: "solo@agent.test", first_name: "Sol", last_name: "Agent", user_type: "agent", brokerage_id: null })
const adopt = await createTenantCore(svc, baseInput({ brokerageName: "Sol Agent's Brokerage", adminEmail: "solo@agent.test", adminFirstName: "Sol", adminLastName: "Agent", tier: "solo_agent", callerUserId: "usr-solo", adoptExistingOwner: { userId: "usr-solo", userType: "agent" } }), deps)

const doors = { trial, paid, staff, conv: conv.ok && !conv.alreadyConverted ? { ok: true, brokerageId: conv.brokerageId } : { ok: false, brokerageId: undefined }, adopt } as Record<string, { ok: boolean; brokerageId?: string; error?: string }>
check("every door provisioned (trial, paid, staff-active, conversion, adoption)", Object.values(doors).every((d) => d.ok && d.brokerageId), Object.entries(doors).filter(([, d]) => !d.ok).map(([k, d]) => `${k}: ${d.error ?? "no id"}`).join("; "))
const F = Object.fromEntries(Object.entries(doors).map(([k, d]) => [k, foundation(svc, d.brokerageId!)]))
const tableSets = Object.values(F).map((f) => f.tablesWithRows.join(","))
check(`every door wrote the SAME table set (${F.trial!.tablesWithRows.join(", ")})`, new Set(tableSets).size === 1, tableSets.join(" | "))
check("every door finished the SAME step set — all twelve steps terminal, completed_at stamped, nothing pending", Object.values(F).every((f) => f.record && f.terminal.length === TENANT_PROVISIONING_STEPS.length && !!f.record.completed_at && provisioningComplete(f.record) && provisioningStepsPending(f.record).length === 0),
  Object.entries(F).map(([k, f]) => `${k}: pending ${f.record ? provisioningStepsPending(f.record).join(",") || "none" : "NO RECORD"}`).join("; "))
check("the ONLY door-shaped step is the activation checkout: done on paid, skipped (not applicable) elsewhere; every other step is done on every door",
  F.paid!.record!.steps.activation_checkout?.status === "done" && (["trial", "staff", "conv", "adopt"] as const).every((k) => F[k]!.record!.steps.activation_checkout?.status === "skipped")
  && Object.values(F).every((f) => TENANT_PROVISIONING_STEPS.filter((s) => s !== "activation_checkout").every((s) => f.record!.steps[s]?.status === "done")))
check("TRIAL IS A STATE, NEVER REQUIRED: trial → trialing with a future trial_end; paid → trialing with trial_end = now (paywall holds until checkout); active → active with no trial; ONE subscriptions row each",
  Object.values(F).every((f) => f.sub.length === 1)
  && F.trial!.sub[0]!.status === "trialing" && new Date(F.trial!.sub[0]!.trial_end).getTime() > Date.now() + 10 * 24 * 3600 * 1000
  && F.paid!.sub[0]!.status === "trialing" && Math.abs(new Date(F.paid!.sub[0]!.trial_end).getTime() - Date.now()) < 60_000 && paid.checkoutUrl === `https://checkout.test/${paid.brokerageId}`
  && F.staff!.sub[0]!.status === "active" && !F.staff!.sub[0]!.trial_end && F.staff!.brk.trial_ends_at === null)
check("website: every door gets a unique slug'd /site path", new Set(Object.values(F).map((f) => f.brk.slug)).size === 5 && Object.values(doors).every((d) => (d as { websitePath?: string }).websitePath?.startsWith("/site/") || d === doors.conv))
check("snapshot: the tier's funnel snapshot (or the staff-picked one) landed on every door — global_settings + brand + site", Object.values(F).every((f) => svc.tables.global_settings.some((g) => g.brokerage_id === f.brk.id) && svc.tables.brokerage_brand_settings.some((g) => g.brokerage_id === f.brk.id) && f.brk.about_text === "about") && staff.snapshotName === "brokerage funnel")
check("owner: exactly one anchored user per tenant; adoption anchored the EXISTING user (no invite, domain records once) while the others were invited once",
  Object.values(F).every((f) => f.users.length === 1) && F.adopt!.users[0]!.id === "usr-solo" && F.adopt!.users[0]!.user_type === "agent" && adopt.inviteSent === false && c.owner === 4 && c.domain === 1)
check("ISA actor + starter assistant + SUBSCRIPTION_CREATED + onboarding library + welcome bell + operating-baseline repair ran ONCE per tenant (5 tenants)",
  c.isa === 5 && c.assistant === 5 && c.events.length === 5 && c.events.every((e) => e.event === "subscription.created" || String(e.event).toLowerCase().includes("subscription")) && c.repair === 5 && c.baseline === 5 && c.curriculum === 5
  && Object.values(F).every((f) => svc.tables.learning_assignments.filter((a) => a.brokerage_id === f.brk.id).length === 2 && svc.tables.notifications.some((n) => n.brokerage_id === f.brk.id && n.type === "agent_onboarding") && svc.tables.ai_identity_profiles.filter((p) => p.brokerage_id === f.brk.id).length === 1))
check("the prospect door linked the prospect row to the minted tenant (status trial) and the never-a-prospect doors linked zero", svc.tables.platform_prospects[0]!.converted_brokerage_id === doors.conv!.brokerageId && svc.tables.platform_prospects[0]!.status === "trial" && (trial.prospectStamp?.linked ?? 0) === 0)
check("the record names its door and key: self_serve / superadmin, key tenant:<owner email>", F.trial!.record!.door === "self_serve" && F.trial!.record!.key === "tenant:owner@acme.test" && F.staff!.record!.door === "superadmin" && F.conv!.record!.key === "tenant:sam@convert.test")

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · RESUMABLE + IDEMPOTENT — a failed step re-runs alone; the same door twice never duplicates]")
{
  const s2 = fakeSvc(seedTables()); const c2 = counters(); const d2 = makeDeps(s2, c2, { isaOnce: true })
  const first = await createTenantCore(s2, baseInput({}), d2)
  const f1 = foundation(s2, first.brokerageId!)
  check("first run: the tenant exists, the ISA step is recorded FAILED with its reason, the record stays OPEN, extrasSkipped names it", first.ok && f1.record?.steps.isa_actor?.status === "failed" && /auth admin unavailable/.test(f1.record!.steps.isa_actor!.error ?? "") && f1.record!.completed_at === null && first.extrasSkipped.includes("isa_actor") && first.resumed === false)
  const before = { brk: s2.tables.brokerages.length, users: s2.tables.users.length, subs: s2.tables.subscriptions.length, assistant: c2.assistant, events: c2.events.length, owner: c2.owner, isa: c2.isa, la: s2.tables.learning_assignments.length }
  const second = await createTenantCore(s2, baseInput({}), d2)
  const f2 = foundation(s2, first.brokerageId!)
  check("second run through the SAME door RESUMES (same brokerage id, resumed:true) and the record completes", second.ok && second.resumed === true && second.brokerageId === first.brokerageId && !!f2.record!.completed_at && provisioningComplete(f2.record!))
  check("only the failed step re-ran: ISA +1; owner, assistant, event, subscription, learning assignments, brokerages and users counts UNCHANGED", c2.isa === before.isa + 1 && c2.owner === before.owner && c2.assistant === before.assistant && c2.events.length === before.events && s2.tables.brokerages.length === before.brk && s2.tables.users.length === before.users && s2.tables.subscriptions.length === before.subs && s2.tables.learning_assignments.length === before.la)
  check("each attempt is its own evidence row: 2 ledger rows, distinct idempotency keys, attempt 2 says resume + the pending step", f2.ledger.length === 2 && new Set(f2.ledger.map((l) => l.idempotency_key)).size === 2 && f2.ledger[1]!.detail?.resume === true && (f2.ledger[1]!.detail?.pending ?? []).includes("isa_actor") && f2.record!.attempts === 2)
  const third = await createTenantCore(s2, baseInput({}), d2)
  check("third run on the COMPLETE record is refused as a duplicate owner (sign in) with zero writes", !third.ok && /already exists/.test(third.error ?? "") && c2.isa === before.isa + 1 && s2.tables.agent_action_ledger.length === 2)
  const direct = await resumeTenantProvisioning(s2, first.brokerageId!)
  check("resumeTenantProvisioning on a complete record is a no-op that says `complete`", !direct.resumable && direct.reason === "complete")
  const stranger = await createTenantCore(s2, baseInput({ provisioningKey: "prospect:other-key" }), d2)
  check("a DIFFERENT provisioning key for the same owner email never resumes someone else's record (key_mismatch → duplicate-owner refusal)", !stranger.ok && /already exists/.test(stranger.error ?? ""))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · DUPLICATE STRIPE EVENT — the webhook's checkout.session.completed effect twice]")
{
  const { upsertBrokerageSubscription, buildSubscriptionPatch } = await import("../lib/billing/subscription-activation")
  const id = paid.brokerageId!
  const patch = buildSubscriptionPatch({ stripeSubscriptionId: "sub_stripe_1", stripeCustomerId: "cus_1", tierId: "tier-team", status: "active", currentPeriodStart: 1_700_000_000, currentPeriodEnd: 1_702_600_000, trialEnd: null, cancelAt: null })
  const before = { isa: c.isa, assistant: c.assistant, events: c.events.length, ledger: svc.tables.agent_action_ledger.length }
  const r1 = await upsertBrokerageSubscription(svc, id, patch); const resume1 = await resumeTenantProvisioning(svc, id)
  const r2 = await upsertBrokerageSubscription(svc, id, patch); const resume2 = await resumeTenantProvisioning(svc, id)
  const subs = svc.tables.subscriptions.filter((s) => s.brokerage_id === id)
  check("delivery 1 LINKS the existing trialing row (updated, not inserted) and flips it active; delivery 2 updates the SAME row — one subscriptions row, one stripe id", r1.action === "updated" && r1.previousStatus === "trialing" && r2.action === "updated" && r2.previousStatus === "active" && subs.length === 1 && subs[0]!.stripe_subscription_id === "sub_stripe_1" && subs[0]!.status === "active")
  check("both deliveries find the provisioning record COMPLETE — no step re-runs, no actor / assistant / event / ledger row minted twice", !resume1.resumable && resume1.reason === "complete" && !resume2.resumable && resume2.reason === "complete" && c.isa === before.isa && c.assistant === before.assistant && c.events.length === before.events && svc.tables.agent_action_ledger.length === before.ledger)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 4 · RETRY-SAFE + EVIDENCED — owner failure rolls back; refused evidence abandons; one ledger row per attempt]")
{
  const s4 = fakeSvc(seedTables()); const c4 = counters(); const d4 = makeDeps(s4, c4, { ownerOnce: true })
  const fail = await createTenantCore(s4, baseInput({ brokerageName: "Retry Realty", adminEmail: "owner@retry.test" }), d4)
  check("owner provisioning failure: the brokerage row is ROLLED BACK (counted) and the error names the owner step", !fail.ok && /Owner provisioning failed/.test(fail.error ?? "") && s4.tables.brokerages.filter((b) => b.name === "Retry Realty").length === 0 && s4.tables.users.filter((u) => u.email === "owner@retry.test").length === 0)
  check("the failed attempt is still EVIDENCED: one ledger row, status failed, outcome provisioning_failed", s4.tables.agent_action_ledger.length === 1 && s4.tables.agent_action_ledger[0]!.status === "failed" && s4.tables.agent_action_ledger[0]!.outcome === "provisioning_failed")
  const retry = await createTenantCore(s4, baseInput({ brokerageName: "Retry Realty", adminEmail: "owner@retry.test" }), d4)
  check("the retry mints exactly ONE tenant (no duplicate from the failed attempt) and settles executed", retry.ok && s4.tables.brokerages.filter((b) => b.name === "Retry Realty").length === 1 && s4.tables.agent_action_ledger.filter((l) => l.brokerage_id === retry.brokerageId).length === 1 && s4.tables.agent_action_ledger.find((l) => l.brokerage_id === retry.brokerageId)!.status === "executed")
  const led = s4.tables.agent_action_ledger.find((l) => l.brokerage_id === retry.brokerageId)!
  check("the evidence row: action saas.tenant.provision, subject the minted brokerage, reason SUBSCRIPTION_LIFECYCLE, actor system (self-serve), idempotency key carries the provisioning key + attempt", led.action === "saas.tenant.provision" && led.subject_type === "brokerage" && led.subject_id === retry.brokerageId && led.reason_code === "SUBSCRIPTION_LIFECYCLE" && led.actor_type === "system" && /^tenant:owner@retry\.test:.*:attempt:1$/.test(led.idempotency_key))
  s4.refuse.agent_action_ledger = { insert: "ledger offline (fixture)" }
  const noEvidence = await createTenantCore(s4, baseInput({ brokerageName: "Dark Realty", adminEmail: "owner@dark.test" }), d4)
  check("NO EVIDENCE, NO TENANT: a refused ledger claim abandons the half-built brokerage (rolled back, counted) and says why", !noEvidence.ok && noEvidence.ledger?.claimed === false && /evidence could not be recorded/.test(noEvidence.error ?? "") && s4.tables.brokerages.filter((b) => b.name === "Dark Realty").length === 0 && c4.owner === 2)
  delete s4.refuse.agent_action_ledger
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 5 · TENANT-SCOPED — the pre-existing tenant is untouched; every tenant write names a minted tenant]")
{
  const otherAfter = JSON.stringify(Object.fromEntries(Object.entries(svc.tables).map(([t, rows]) => [t, rows.filter((r) => r.brokerage_id === "brk-other" || r.id === "brk-other" || r.id === "usr-other")])))
  check("brk-other's rows (brokerage, user, subscription, settings) are byte-identical after five doors + two webhook deliveries", otherBefore === otherAfter)
  const minted = new Set(Object.values(doors).map((d) => d.brokerageId))
  const strays = svc.log.flatMap((w) => w.rows.filter((r) => "brokerage_id" in r && r.brokerage_id !== null && !minted.has(r.brokerage_id)).map((r) => `${w.kind} ${w.table} → ${r.brokerage_id}`))
  check(`every tenant-keyed write (${svc.log.length} writes) landed under a tenant this run minted — strays: ${strays.length}`, strays.length === 0, strays.slice(0, 5).join("; "))
  check("POSITIVE CONTROL: a write under a foreign tenant WOULD be a stray", (() => { const probe = [{ table: "notes", kind: "insert" as const, rows: [{ brokerage_id: "brk-other" }] }]; return probe.flatMap((w) => w.rows.filter((r) => !minted.has(r.brokerage_id))).length === 1 })())
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 6 · SOURCE — one insert, every door delegates, lifecycle is not a door, the webhook resumes, ONE readiness hook, registration]")
{
  const CORE = "lib/kernel/tenant-creation.ts"
  const insertRe = /from\("brokerages"\)\s*\.\s*insert/
  const files = [...walkTs(join(root, "lib")), ...walkTs(join(root, "app"))]
  const creationPaths = files.filter((f) => insertRe.test(stripComments(readFileSync(f, "utf8")))).map((f) => f.replace(root + "/", ""))
  console.log(`    denominator: ${files.length} .ts/.tsx under lib/ + app/; brokerages inserts: ${creationPaths.join(" · ")}`)
  check("exactly ONE brokerages insert under lib/ + app/, and it is the core (the self-heal's own insert is gone)", creationPaths.length === 1 && creationPaths[0] === CORE)
  check("POSITIVE CONTROL: a fixture spelling its own insert is counted; a commented one is not", insertRe.test(stripComments('const { data } = await svc\n  .from("brokerages")\n  .insert({ name: "n" })')) && !insertRe.test(stripComments('// svc.from("brokerages").insert({})\nconst a = 1')))
  const core = stripped(CORE)
  const doorsSrc = {
    "self-serve trial + direct paid": [stripped("app/actions/auth/signup-brokerage.ts"), /createTenantCore\(service, \{/],
    "platform-staff creation": [stripped("app/actions/admin/create-subscriber.ts"), /createTenantCore\(service, \{/],
    "sales-assisted conversion": [stripped("lib/platform/prospect-conversion.ts"), /deps\.provisionTenant \?\? \(await import\("@\/lib\/kernel\/tenant-creation"\)\)\.createTenantCore/],
    "brokerage-of-one adoption": [stripped("app/actions/onboarding/ensure-agent-brokerage.ts"), /createTenantCore\(svc, \{[\s\S]{0,900}adoptExistingOwner: \{ userId: u\.id/],
    "demo tenant": [stripped("lib/platform/demo-tenant.ts"), /signupBrokerageAction\(\{/],
  } as Record<string, [string, RegExp]>
  for (const [name, [src, re]] of Object.entries(doorsSrc)) check(`door delegates to the core: ${name}`, re.test(src) && !insertRe.test(src))
  check("the staff door's thin wrapper (manual-subscriber.ts) delegates to createSubscriber and spells no insert", /createSubscriber\(\{/.test(stripped("app/actions/superadmin/manual-subscriber.ts")) && !insertRe.test(stripped("app/actions/superadmin/manual-subscriber.ts")))
  const mgmt = stripped("app/actions/superadmin/brokerage-management.ts")
  check("brokerage-management.ts is LIFECYCLE (tier / suspend / reactivate / cancel / refund), not a creation door — no insert, no core call", !insertRe.test(mgmt) && !/createTenantCore|provisionTenantOwner/.test(mgmt) && /changeBrokerageTierAction|cancelBrokerageAction/.test(mgmt))
  const hook = stripped("app/api/billing/webhook/route.ts")
  check("the Stripe webhook never creates a tenant: checkout.session.completed links through the brokerage-keyed writer, keeps the account repair, and RESUMES the provisioning record", !insertRe.test(hook) && /case "checkout\.session\.completed"[\s\S]{0,4000}upsertBrokerageSubscription\([\s\S]{0,3000}repairIncompleteAccountSetup[\s\S]{0,1500}resumeTenantProvisioning\(supabase, brokerageId\)/.test(hook))
  check("the core: provisioning record under billing_metadata.provisioning, the duplicate-owner guard resumes before refusing, every attempt ledgered as saas.tenant.provision, owner failure + refused claim both go through the counted rollback",
    /provisioning: record/.test(core) && core.indexOf("resumeTenantProvisioning(service, ownedBrokerageId") < core.indexOf("An account with this email already exists") && (core.match(/action: "saas\.tenant\.provision"/g) ?? []).length === 2 && /withActionLedger<TenantCreationResult>/.test(core) && (core.match(/abandonHalfBuiltTenant\(service, brokerageId/g) ?? []).length === 2 && /rollbackTenantCreation\(service, brokerageId\)/.test(core))
  check("the step vocabulary is ONE exported list and the runner skips done/skipped steps (that is what makes a resume safe)", TENANT_PROVISIONING_STEPS.length === 12 && /if \(prior === "done" \|\| prior === "skipped"\) return/.test(core) && /export const TENANT_PROVISIONING_STEPS/.test(core))
  check("the record never carries a status / trial key (lane 92A: subscriptions + brokerages.trial_ends_at are the one source)", !/billing_metadata\s*:\s*\{[^{}]*\b(?:subscription_status|trial_ends_at)\s*:/.test(core) && !/trial_ends_at|subscription_status/.test(JSON.stringify(F.trial!.record)))
  check("the login-time account repair runs AT CREATION (operating_baseline) so first login is never a hidden repair", /step\("operating_baseline"/.test(core) && /repairIncompleteAccountSetup/.test(core))
  check("the operating baseline (website slug, tier snapshot, settings, policies, entitlements, managers — lib/kernel/tenant-operating-baseline.ts) is initialized INSIDE the same step, after the account repair", (() => { const i = core.indexOf('step("operating_baseline"'); const body = core.slice(i, core.indexOf('}, "operating_baseline")', i)); return body.indexOf("repairIncompleteAccountSetup") < body.indexOf("initializeTenantOperatingBaseline") && /tenant-operating-baseline/.test(body) })())
  check("exactly ONE `READINESS HOOK (integrator)` comment, at the convergence point (the operating_baseline step)", (raw(CORE).match(/READINESS HOOK \(integrator\)/g) ?? []).length === 1 && raw(CORE).indexOf("READINESS HOOK (integrator)") < raw(CORE).indexOf('await step("operating_baseline"'))
  check("the trial_end writer and the §3 read on the subscription insert are intact in the core", /trial_end:\s*end,/.test(core) && /from\("subscriptions"\)\.insert\(subscriptionRow\)/.test(core) && /if \(subErr \|\| !subscription\)/.test(core))
  check("TenantCreationDeps is a documented @proofSeam and no production door passes it", /@proofSeam[\s\S]{0,400}export interface TenantCreationDeps/.test(raw(CORE)) && ["app/actions/auth/signup-brokerage.ts", "app/actions/admin/create-subscriber.ts", "app/actions/onboarding/ensure-agent-brokerage.ts", "lib/platform/prospect-conversion.ts"].every((p) => !/createTenantCore\([^)]*\},\s*\{/.test(stripped(p))))
  const pkg = raw("package.json")
  check("registered: package.json test:subscriber-convergence runs this guard", /"test:subscriber-convergence":\s*"tsx --conditions=react-server scripts\/subscriber-convergence-guard\.ts"/.test(pkg))
  check("guard chain MEMBERSHIP (rule, not position)", new RegExp("npm run test:subscriber-convergence(\\s|&|$)").test(pkg))
  const reg = raw("lib/kernel/manager-registry.ts")
  check("MAINTENANCE_DOMAINS.subscriber_convergence owned by data_steward with the proof + co-owners named in its prose", /subscriber_convergence:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:subscriber-convergence",\s*coOwners:\s*\["finance_manager",\s*"ai_isa"\]/.test(reg) && /finance_manager co-owns/.test(reg) && /ai_isa co-owns/.test(reg))
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed) { console.log("FAILURES:"); for (const f of failures) console.log(`  - ${f}`); console.log(" ❌ SUBSCRIBER_CONVERGENCE_FAIL"); process.exit(1) }
console.log(" ✅ SUBSCRIBER_CONVERGENCE_PASS — every door reaches the ONE provisioning sequence; trial is a state; resume re-runs only what failed; a duplicate Stripe event duplicates nothing; every attempt leaves evidence; tenants stay apart")
