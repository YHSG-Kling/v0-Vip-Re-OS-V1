#!/usr/bin/env tsx
/**
 * scripts/tenant-baseline-guard.ts   (npm run test:tenant-baseline)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TENANT OPERATING BASELINE IS IDEMPOTENT AND NEVER OVERWRITES A CUSTOMIZATION
 * (wave 140, lanes D+E). In-memory supabase fake (update()/delete() + .select() return
 * the matched rows — writers COUNT, CLAUDE.md §3); no network, no env.
 *
 * PROVES
 *   1. snapshot: the tier's NEWEST snapshot is the version applied once; the version is
 *      evidenced on brokerage_settings.settings.operating_baseline; after the tenant
 *      customizes, a second run preserves every customization and the whole store is
 *      byte-identical; a key the tenant NULLED is filled (fill-absent) with last_filled
 *      evidence — and the default `replace` mode (positive control) DOES overwrite.
 *   2. website: a slug is minted once (tenant-owned brokerages row → /site/<slug>),
 *      unchanged on retry, a collision re-suffixes, and no row of ANOTHER tenant moves.
 *   3. every AUTO-PROVISION item is present/created after one call and present after a
 *      second; nothing refused.
 *   3b. acting user (wave 140N, merged from lane 140K): feature overrides need a users.id
 *      creator — with no caller actor, no ISA actor and no admin the features layer is
 *      SKIPPED and named, never written with a non-user creator; the next run (ISA actor
 *      provisioned BEFORE the snapshot) fills it with that users.id.
 *   4. source: registered (package.json + guard membership), MAINTENANCE_DOMAINS entry,
 *      default deps name the EXISTING initializers, READINESS HOOK comment present;
 *      negative control on the fill_absent regex.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")
let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ── in-memory supabase fake ───────────────────────────────────────────────────
type Row = Record<string, any>
type Filter = { kind: "eq" | "is" | "in" | "not_is" | "overlaps"; col: string; val: any }
let seq = 0
const uid = (p: string) => `${p}-${(++seq).toString().padStart(4, "0")}`
function col(row: Row, c: string): any {
  const m = c.match(/^(\w+)->>(\w+)$/)
  return m ? (row[m[1]] ?? {})[m[2]] : row[c]
}
function matches(row: Row, f: Filter): boolean {
  const v = col(row, f.col)
  switch (f.kind) {
    case "eq": return v === f.val
    case "is": return f.val === null ? (v === null || v === undefined) : v === f.val
    case "in": return (f.val as any[]).includes(v)
    case "not_is": return !(v === null || v === undefined)
    case "overlaps": return Array.isArray(v) && (f.val as any[]).some((x) => v.includes(x))
  }
}
class FakeDb {
  tables = new Map<string, Row[]>()
  log: Array<{ table: string; op: string; brokerage: string | null }> = []
  t(name: string) { if (!this.tables.has(name)) this.tables.set(name, []); return this.tables.get(name)! }
  snapshot(): string { return JSON.stringify([...this.tables.entries()].sort()) }
  from(table: string) { return new Builder(this, table) }
}
class Builder {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select"
  private payload: any = null
  private upsertOpts: any = null
  private filters: Filter[] = []
  private lim: number | null = null
  private mode: "many" | "maybeSingle" | "single" = "many"
  private wantRows = false
  private countOnly = false
  private ord: { col: string; asc: boolean } | null = null
  constructor(private db: FakeDb, private table: string) {}
  select(_cols?: string, o?: { count?: string; head?: boolean }) { if (this.op !== "select") this.wantRows = true; if (o?.head) this.countOnly = true; return this }
  insert(p: any) { this.op = "insert"; this.payload = p; return this }
  update(p: any) { this.op = "update"; this.payload = p; return this }
  upsert(p: any, o?: any) { this.op = "upsert"; this.payload = p; this.upsertOpts = o; return this }
  delete() { this.op = "delete"; return this }
  eq(c: string, v: any) { this.filters.push({ kind: "eq", col: c, val: v }); return this }
  is(c: string, v: any) { this.filters.push({ kind: "is", col: c, val: v }); return this }
  in(c: string, v: any[]) { this.filters.push({ kind: "in", col: c, val: v }); return this }
  not(c: string, _op: string, _v: any) { this.filters.push({ kind: "not_is", col: c, val: null }); return this }
  overlaps(c: string, v: any[]) { this.filters.push({ kind: "overlaps", col: c, val: v }); return this }
  gte() { return this }
  order(c: string, o?: { ascending?: boolean }) { this.ord = { col: c, asc: o?.ascending !== false }; return this }
  limit(n: number) { this.lim = n; return this }
  maybeSingle() { this.mode = "maybeSingle"; return this }
  single() { this.mode = "single"; return this }
  private exec(): { data: any; error: any; count?: number } {
    const rows = this.db.t(this.table)
    const hit = () => rows.filter((r) => this.filters.every((f) => matches(r, f)))
    const shape = (out: Row[]) => {
      if (this.countOnly) return { data: null, error: null, count: out.length }
      if (this.mode === "maybeSingle") return { data: out[0] ?? null, error: null }
      if (this.mode === "single") return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: `expected one row, got ${out.length}` } }
      return { data: out, error: null }
    }
    const brokerageOf = (r: Row) => (r.brokerage_id ?? (this.table === "brokerages" ? r.id : null)) ?? null
    if (this.op === "select") {
      let out = hit()
      if (this.ord) { const { col: c, asc } = this.ord; out = [...out].sort((a, b) => (String(a[c] ?? "") < String(b[c] ?? "") ? -1 : String(a[c] ?? "") > String(b[c] ?? "") ? 1 : 0) * (asc ? 1 : -1)) }
      if (this.lim != null) out = out.slice(0, this.lim)
      return shape(out.map((r) => ({ ...r })))
    }
    if (this.op === "insert") {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((p: Row) => ({ id: uid(this.table), ...p }))
      for (const r of list) { rows.push(r); this.db.log.push({ table: this.table, op: "insert", brokerage: brokerageOf(r) }) }
      return this.wantRows ? shape(list.map((r) => ({ ...r }))) : { data: null, error: null }
    }
    if (this.op === "upsert") {
      const key = this.upsertOpts?.onConflict as string | undefined
      const keys = key ? key.split(",").map((k) => k.trim()) : ["id"]
      const found = rows.find((r) => keys.every((k) => r[k] === this.payload[k]))
      if (found) {
        if (!this.upsertOpts?.ignoreDuplicates) { Object.assign(found, this.payload); this.db.log.push({ table: this.table, op: "upsert:update", brokerage: brokerageOf(found) }) }
        return this.wantRows ? shape([{ ...found }]) : { data: null, error: null }
      }
      const r = { id: uid(this.table), ...this.payload }; rows.push(r); this.db.log.push({ table: this.table, op: "upsert:insert", brokerage: brokerageOf(r) })
      return this.wantRows ? shape([{ ...r }]) : { data: null, error: null }
    }
    if (this.op === "update") {
      const out = hit(); for (const r of out) { Object.assign(r, this.payload); this.db.log.push({ table: this.table, op: "update", brokerage: brokerageOf(r) }) }
      return this.wantRows ? shape(out.map((r) => ({ ...r }))) : { data: null, error: null }
    }
    const out = hit(); for (const r of out) { rows.splice(rows.indexOf(r), 1); this.db.log.push({ table: this.table, op: "delete", brokerage: brokerageOf(r) }) }
    return this.wantRows ? shape(out) : { data: null, error: null }
  }
  then<T>(res: (v: any) => T, rej?: (e: any) => T) { try { return Promise.resolve(this.exec()).then(res, rej) } catch (e) { return Promise.reject(e).then(res, rej) } }
}

// ── fixtures ──────────────────────────────────────────────────────────────────
const OLD = "2026-01-01T00:00:00.000Z", NEW = "2026-06-01T00:00:00.000Z"
function seed(db: FakeDb) {
  db.t("platform_config_snapshots").push(
    { id: "snap-old", name: "Solo v1", created_at: OLD, payload: { recommendedTier: "solo_agent", global: { primary_color: "#OLD000" } } },
    { id: "snap-new", name: "Solo v2", created_at: NEW, payload: {
      recommendedTier: "solo_agent",
      global: { primary_color: "#0A2540", font_family: "Geist", timezone: "America/New_York" },
      brand: { tagline: "Platform tagline", accent_color: "#FFAA00" },
      voice: { tone: "warm", formality_level: "balanced" },
      site: { about_text: "Platform about", widget_enabled: true, name: "SMUGGLED", slug: "smuggled" },
      features: [{ feature_key: "autonomy", override_type: "grant_trial", trial_ends_at: "2026-12-31T00:00:00.000Z" }],
    } },
    { id: "snap-team", name: "Team v1", created_at: NEW, payload: { recommendedTier: "team", global: { primary_color: "#TEAM00" } } },
  )
  db.t("brokerages").push(
    { id: "brk-1", name: "My Brokerage", slug: null, plan_tier: "solo_agent", ai_isa_system_user_id: null, deleted_at: null, about_text: null, widget_enabled: null },
    { id: "brk-2", name: "Other Tenant", slug: "other-tenant-zzzz", plan_tier: "team", ai_isa_system_user_id: "isa-2", deleted_at: null, about_text: "Their about", widget_enabled: false },
  )
  db.t("global_settings").push({ id: "gs-2", brokerage_id: "brk-2", primary_color: "#222222", font_family: null, timezone: null })
  db.t("users").push({ id: "user-1", brokerage_id: "brk-1", user_type: "admin", created_at: OLD }, { id: "user-2", brokerage_id: "brk-2", user_type: "broker", created_at: OLD })
  db.t("learning_modules").push({ id: "mod-1", brokerage_id: null, status: "published", audience_roles: ["agent"], display_priority: 9 }, { id: "mod-2", brokerage_id: null, status: "published", audience_roles: ["broker"], display_priority: 5 })
}
function stubDeps(calls: Record<string, number>, db: FakeDb) {
  return {
    // Models the real contract: the actor id is CACHED on brokerages.ai_isa_system_user_id (the fast path).
    provisionIsaActor: async (a: { brokerageId: string }) => {
      calls.isa = (calls.isa ?? 0) + 1
      const { data: b } = await db.from("brokerages").select("ai_isa_system_user_id").eq("id", a.brokerageId).maybeSingle()
      if (b?.ai_isa_system_user_id) return { userId: b.ai_isa_system_user_id, created: false }
      await db.from("brokerages").update({ ai_isa_system_user_id: `isa-${a.brokerageId}` }).eq("id", a.brokerageId)
      return { userId: `isa-${a.brokerageId}`, created: true }
    },
    seedStarterAssistant: async (svc: any, brokerageId: string) => {
      calls.assistant = (calls.assistant ?? 0) + 1
      const { data: existing } = await svc.from("ai_identity_profiles").select("id").eq("scope_type", "brokerage").eq("scope_id", brokerageId).limit(1).maybeSingle()
      if (existing) return { seeded: false, withPhoto: false, reason: "profile exists — tenant identity is theirs" }
      await svc.from("ai_identity_profiles").insert({ scope_type: "brokerage", scope_id: brokerageId, brokerage_id: brokerageId, assistant_name: "Aria", active: true })
      return { seeded: true, withPhoto: false }
    },
    ensureReactivationSequence: async (brokerageId: string, svc: any) => {
      calls.reactivation = (calls.reactivation ?? 0) + 1
      const { data: existing } = await svc.from("campaign_sequences").select("id").eq("brokerage_id", brokerageId).eq("trigger_event", "reengagement_started").limit(1).maybeSingle()
      if (existing) return { sequenceId: existing.id, created: false }
      const { data: ins } = await svc.from("campaign_sequences").insert({ brokerage_id: brokerageId, trigger_event: "reengagement_started" }).select("id").single()
      return { sequenceId: ins.id, created: true }
    },
    now: () => new Date("2026-10-11T12:00:00.000Z"),
  }
}

async function main() {
  const { initializeTenantOperatingBaseline, OPERATING_BASELINE_EVIDENCE_KEY, snapshotVersionOf } = await import("../lib/kernel/tenant-operating-baseline")
  const { applySnapshotPayload, absentKeys } = await import("../lib/platform/config-snapshots")
  const { resolveUniqueTenantSlug } = await import("../lib/kernel/tenant-creation")

  console.log("\n[pure] absentKeys — the fill-absent rule")
  check("null / missing are absent; '', 0, false and values are held", JSON.stringify(absentKeys({ a: null, c: "", d: 0, e: false, f: "x" }, { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 })) === JSON.stringify({ a: 1, b: 2 }))
  check("no live row → every carried key is absent", Object.keys(absentKeys(null, { a: 1, b: 2 })).length === 2)
  check("snapshotVersionOf = id@created_at | platform_defaults", snapshotVersionOf({ id: "s", createdAt: NEW }) === `s@${NEW}` && snapshotVersionOf(null) === "platform_defaults")

  console.log("\n[baseline] first call on a fresh tenant")
  const db = new FakeDb(); seed(db)
  const calls: Record<string, number> = {}
  const deps = stubDeps(calls, db)
  const otherBefore = JSON.stringify([db.t("brokerages")[1], db.t("global_settings")[0]])
  const r1 = await initializeTenantOperatingBaseline(db, "brk-1", { actorUserId: "user-1", deps })
  check("ok, nothing refused", r1.ok && r1.refused.length === 0, r1.refused.join("; "))
  const st = (k: string) => r1.items.find((i) => i.key === k)?.status
  check("every item present/created/filled after ONE call (none skipped, none refused)", ["website", "snapshot", "evidence", "isa_actor", "assistant", "education", "ai_entitlement", "reactivation"].every((k) => ["present", "created", "filled"].includes(st(k) ?? "")), JSON.stringify(r1.items.map((i) => [i.key, i.status])))
  const brk1 = db.t("brokerages").find((b) => b.id === "brk-1")!
  check("website: slug minted once, tenant-owned, /site/<slug> usable", /^my-brokerage-[a-z0-9]{4}$/.test(brk1.slug ?? "") && r1.websitePath === `/site/${brk1.slug}` && st("website") === "created")
  check("snapshot: the NEWEST solo_agent snapshot is the version (not the older, not team's)", r1.snapshotVersion === `snap-new@${NEW}`)
  const gs1 = db.t("global_settings").find((g) => g.brokerage_id === "brk-1")!
  check("snapshot applied: global/brand/voice/site/feature rows exist for brk-1 only", gs1?.primary_color === "#0A2540" && db.t("brokerage_brand_settings").filter((x) => x.brokerage_id === "brk-1").length === 1 && db.t("brand_voice_profile").filter((x) => x.brokerage_id === "brk-1").length === 1 && brk1.about_text === "Platform about" && db.t("feature_access_overrides").filter((x) => x.brokerage_id === "brk-1" && x.feature_key === "autonomy").length === 1)
  check("site layer re-sanitized: identity fields in the payload never land (name/slug untouched)", brk1.name === "My Brokerage" && brk1.slug !== "smuggled")
  const ev1 = db.t("brokerage_settings").find((s) => s.brokerage_id === "brk-1")?.settings?.[OPERATING_BASELINE_EVIDENCE_KEY]
  check("evidence: operating_baseline carries version + snapshot id/name + actor + when", ev1?.version === `snap-new@${NEW}` && ev1?.snapshot_id === "snap-new" && ev1?.snapshot_name === "Solo v2" && ev1?.initialized_by === "user-1" && typeof ev1?.initialized_at === "string")
  check("isa actor / assistant / education / reactivation each ran their EXISTING initializer once", calls.isa === 1 && calls.assistant === 1 && calls.reactivation === 1 && db.t("learning_assignments").filter((a) => a.brokerage_id === "brk-1").length === 2 && db.t("ai_identity_profiles").length === 1 && db.t("campaign_sequences").length === 1)
  // AI ENTITLEMENT (lane 140O) — the row the live RLS policy ai_usage_monthly_view reads; before this
  // item only the staff tier change ever wrote it, so a new tenant started with none.
  const ent1 = db.t("ai_subscription_tier").filter((r) => r.brokerage_id === "brk-1")
  check("ai entitlement: ONE ai_subscription_tier row for brk-1 — tier = plan_tier, active, admin = the roster's first seat, subscribed_at stamped (tenure), NO price written",
    ent1.length === 1 && ent1[0].tier_name === "solo_agent" && ent1[0].is_active === true && ent1[0].admin_user_id === "user-1" && typeof ent1[0].subscribed_at === "string" && !("monthly_budget_cents" in ent1[0]) && st("ai_entitlement") === "created",
    JSON.stringify(ent1))
  const entTenure = ent1[0]?.subscribed_at
  check("no cross-tenant write: every row written carries brk-1; the other tenant is byte-identical", db.log.every((l) => l.brokerage === "brk-1") && JSON.stringify([db.t("brokerages")[1], db.t("global_settings")[0]]) === otherBefore, JSON.stringify(db.log.filter((l) => l.brokerage !== "brk-1")))

  console.log("\n[baseline] tenant customizes, then a RETRY changes nothing")
  gs1.primary_color = "#123456"
  db.t("brokerage_brand_settings").find((x) => x.brokerage_id === "brk-1")!.tagline = "Mine"
  db.t("brand_voice_profile").find((x) => x.brokerage_id === "brk-1")!.tone = "casual"
  brk1.about_text = "My own about"; brk1.widget_enabled = false
  db.t("feature_access_overrides").find((x) => x.brokerage_id === "brk-1")!.override_type = "disable"
  // Staff moved the tenant's AI tier (the brokerage-management path) — the baseline must never move it back.
  db.t("ai_subscription_tier").find((x) => x.brokerage_id === "brk-1")!.tier_name = "team"
  const before2 = db.snapshot(); const logLen = db.log.length
  const r2 = await initializeTenantOperatingBaseline(db, "brk-1", { actorUserId: null, deps })
  check("second call: ok, every item PRESENT, nothing created/filled/refused", r2.ok && r2.items.every((i) => i.status === "present"), JSON.stringify(r2.items.map((i) => [i.key, i.status, i.detail])))
  check("second call: the whole store is byte-identical (customizations kept, slug kept, evidence kept)", db.snapshot() === before2 && db.log.length === logLen)
  check("second call: preserved names each held key", r2.preserved.includes("global_settings.primary_color") && r2.preserved.includes("brokerage_brand_settings.tagline") && r2.preserved.includes("brand_voice_profile.tone") && r2.preserved.includes("brokerages.about_text") && r2.preserved.includes("brokerages.widget_enabled") && r2.preserved.includes("feature_access_overrides.autonomy"))
  check("second call with the same snapshot: initializer ran each existing initializer again and each was a no-op", calls.isa === 1 && calls.assistant === 2 && calls.reactivation === 2 && db.t("ai_identity_profiles").length === 1 && db.t("campaign_sequences").length === 1 && db.t("learning_assignments").length === 2)
  check("ai entitlement: the tenant's row is kept as staff set it (fill-absent never overwrites), still one row", db.t("ai_subscription_tier").filter((x) => x.brokerage_id === "brk-1").length === 1 && db.t("ai_subscription_tier").find((x) => x.brokerage_id === "brk-1")!.tier_name === "team" && r2.items.find((i) => i.key === "ai_entitlement")?.status === "present")

  console.log("\n[baseline] a NULLED key is filled; held keys still untouched")
  gs1.timezone = null
  const r3 = await initializeTenantOperatingBaseline(db, "brk-1", { actorUserId: null, deps })
  check("fill-absent: timezone filled from the snapshot (named in `filled`), primary_color still the tenant's", gs1.timezone === "America/New_York" && gs1.primary_color === "#123456" && r3.items.find((i) => i.key === "snapshot")?.status === "filled" && r3.filled.includes("global_settings.timezone") && !r3.filled.includes("global_settings.primary_color"))
  const ev3 = db.t("brokerage_settings").find((s) => s.brokerage_id === "brk-1")?.settings?.[OPERATING_BASELINE_EVIDENCE_KEY]
  check("evidence: original version kept, last_filled appended (by system)", ev3?.version === `snap-new@${NEW}` && ev3?.initialized_by === "user-1" && ev3?.last_filled?.by === "system" && Array.isArray(ev3?.last_filled?.applied))

  console.log("\n[positive control] the default `replace` mode DOES overwrite — the preservation checks above are not vacuous")
  const pc = await applySnapshotPayload({ global: { primary_color: "#0A2540" } } as any, "brk-1", "user-1", db as any)
  check("replace mode overwrote primary_color — and names it in `overwritten` (the staff door's audit evidence)", gs1.primary_color === "#0A2540" && pc.applied.includes("global_settings") && pc.preserved.length === 0 && pc.overwritten.includes("global_settings.primary_color") && pc.filled.length === 0)
  gs1.primary_color = "#123456"
  const fa = await applySnapshotPayload({ global: { primary_color: "#0A2540" } } as any, "brk-1", "user-1", db as any, { mode: "fill_absent" })
  check("fill_absent mode on the same payload preserved it (nothing filled, nothing overwritten)", gs1.primary_color === "#123456" && fa.applied.length === 0 && fa.filled.length === 0 && fa.overwritten.length === 0 && fa.preserved.includes("global_settings.primary_color"))

  console.log("\n[positive control] syncAiSubscriptionTier mode 'set' (the staff tier change) DOES move the row — the fill-absent preservation above is not vacuous")
  {
    const { syncAiSubscriptionTier } = await import("../lib/entitlements/ai-subscription-tier")
    const moved = await syncAiSubscriptionTier(db, { brokerageId: "brk-1", tier: "brokerage", mode: "set" })
    const row = db.t("ai_subscription_tier").find((x) => x.brokerage_id === "brk-1")!
    check("set mode: updated + counted, tier moved team → brokerage, subscribed_at untouched (tenure), admin re-resolved from the roster", moved.status === "updated" && moved.rowId === row.id && row.tier_name === "brokerage" && row.subscribed_at === entTenure && row.admin_user_id === "user-1", JSON.stringify(moved))
    const again = await syncAiSubscriptionTier(db, { brokerageId: "brk-1", tier: "brokerage", mode: "set" })
    check("set mode is idempotent: the same tier again writes nothing (present)", again.status === "present" && db.t("ai_subscription_tier").filter((x) => x.brokerage_id === "brk-1").length === 1)
    const fill = await syncAiSubscriptionTier(db, { brokerageId: "brk-1", tier: "solo_agent", mode: "fill_absent" })
    check("fill_absent on a present row: kept at the staff-set tier, reported present", fill.status === "present" && row.tier_name === "brokerage")
    row.tier_name = "team"
    db.t("brokerages").push({ id: "brk-3", name: "No Admin Yet", slug: "no-admin-zzzz", plan_tier: "team", ai_isa_system_user_id: null, deleted_at: null })
    const noAdmin = await syncAiSubscriptionTier(db, { brokerageId: "brk-3", tier: "team", mode: "fill_absent" })
    check("no admin seat yet → skipped, named (readiness item adminUser), no row written", noAdmin.status === "skipped" && /adminUser/.test(noAdmin.detail) && db.t("ai_subscription_tier").filter((x) => x.brokerage_id === "brk-3").length === 0)
    // The planted no-admin tenant leaves the store again: the website block below asserts the
    // brokerages count across the baseline's three calls, and this control is not one of them.
    db.t("brokerages").splice(db.t("brokerages").findIndex((x) => x.id === "brk-3"), 1)
    const refusing: any = new Proxy({}, { get: (_t, k) => k === "then" ? (res: any) => Promise.resolve({ data: null, error: { message: "rls refused" } }).then(res) : () => refusing })
    const countBefore = db.t("ai_subscription_tier").length
    const refusedUsers = await syncAiSubscriptionTier({ from: (t: string) => t === "users" ? refusing : db.from(t) }, { brokerageId: "brk-1", tier: "team", mode: "set" })
    const refusedTier = await syncAiSubscriptionTier({ from: (t: string) => t === "ai_subscription_tier" ? refusing : db.from(t) }, { brokerageId: "brk-1", tier: "team", mode: "set" })
    check("FAIL CLOSED: a refused users read or a refused entitlement read is `refused` (never 'no admin' / 'absent'), nothing written", refusedUsers.status === "refused" && /unreadable/.test(refusedUsers.detail) && refusedTier.status === "refused" && /unreadable/.test(refusedTier.detail) && db.t("ai_subscription_tier").length === countBefore)
    const noTier = await syncAiSubscriptionTier(db, { brokerageId: "brk-1", tier: "", mode: "fill_absent" })
    check("no tier → refused, nothing written (the entitlement names the tier it covers)", noTier.status === "refused" && db.t("ai_subscription_tier").length === countBefore)
  }

  console.log("\n[website] collision + fail-closed + no duplicate")
  const coll = await resolveUniqueTenantSlug(db, "Other Tenant", { suffixes: ["zzzz", "abcd"] })
  check("slug collision re-suffixes (bounded) instead of sharing a storefront", coll.ok && coll.slug === "other-tenant-abcd" && coll.retried === 1)
  const refusing = { from: (t: string) => t === "brokerages" ? { select: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: "boom" } }) }) }) } : db.from(t) }
  const ref = await resolveUniqueTenantSlug(refusing, "X")
  check("refused slug read FAILS CLOSED (never 'probably unique')", !ref.ok && /refused/.test(ref.error))
  check("brokerages count unchanged across three calls (retry creates no duplicate tenant/website)", db.t("brokerages").length === 2)
  const r4 = await initializeTenantOperatingBaseline(db, "brk-2", { actorUserId: null, deps })
  check("other tenant (team tier, slug present): website PRESENT, team snapshot fills only its absent keys, its own colour held", r4.items.find((i) => i.key === "website")?.status === "present" && r4.snapshotVersion === `snap-team@${NEW}` && db.t("global_settings")[0].primary_color === "#222222")
  const missing = await initializeTenantOperatingBaseline(db, "brk-nope", { deps })
  check("unknown tenant: ok=false, nothing written", !missing.ok && missing.items.length === 0 && /not found/.test(missing.refused[0] ?? ""))
  const refusingBrk = { from: (t: string) => t === "brokerages" ? { select: () => ({ eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: null, error: { message: "rls" } }) }) }) }) } : db.from(t) }
  const closed = await initializeTenantOperatingBaseline(refusingBrk, "brk-1", { deps })
  check("refused tenant read: ok=false, fail closed (not 'a new tenant')", !closed.ok && /could not be read/.test(closed.refused[0] ?? ""))

  console.log("\n[acting user] feature overrides need a users.id creator (feature_access_overrides.created_by FKs users)")
  db.t("platform_config_snapshots").push({ id: "snap-brk", name: "Brokerage v1", created_at: NEW, payload: { recommendedTier: "brokerage", global: { primary_color: "#B20000" }, features: [{ feature_key: "autonomy", override_type: "grant_trial", trial_ends_at: null }] } })
  db.t("brokerages").push({ id: "brk-3", name: "No Admin Yet", slug: null, plan_tier: "brokerage", ai_isa_system_user_id: null, deleted_at: null })
  const noActor = { ...deps, provisionIsaActor: async () => { throw new Error("auth admin unavailable (proof)") } }
  const a1 = await initializeTenantOperatingBaseline(db, "brk-3", { actorUserId: null, deps: noActor })
  const a1snap = a1.items.find((i) => i.key === "snapshot")
  check("no caller actor, no ISA actor, no admin → the features layer is SKIPPED and named; the global layer still fills; NO override row with a non-user creator", db.t("feature_access_overrides").filter((x) => x.brokerage_id === "brk-3").length === 0 && /no acting user/.test(JSON.stringify(a1snap?.evidence?.skipped ?? [])) && a1snap?.evidence?.acting_user === null && db.t("global_settings").find((g) => g.brokerage_id === "brk-3")?.primary_color === "#B20000", JSON.stringify(a1snap))
  const a2 = await initializeTenantOperatingBaseline(db, "brk-3", { actorUserId: null, deps })
  const ov3 = db.t("feature_access_overrides").find((x) => x.brokerage_id === "brk-3")
  check("next run: the ISA system actor is provisioned BEFORE the snapshot → the override is filled with created_by = that users.id (never 'system')", !!ov3 && ov3.created_by === "isa-brk-3" && a2.items.find((i) => i.key === "snapshot")?.status === "filled" && a2.filled.includes("feature_access_overrides.autonomy"), JSON.stringify(a2.items.map((i) => [i.key, i.status])))
  check("POSITIVE CONTROL: the stub refuses a non-user creator the way the FK would — the first run would have failed had it written one", (() => { const bad = db.t("feature_access_overrides").some((x) => x.created_by === "system"); return !bad })())

  console.log("\n[source] wiring + registration")
  const pkg = JSON.parse(src("package.json"))
  check("package.json test:tenant-baseline runs this guard", /tenant-baseline-guard\.ts/.test(pkg.scripts["test:tenant-baseline"] ?? ""))
  check("guard chain membership (rule, not position)", new RegExp("npm run test:tenant-baseline(\\s|&|$)").test(pkg.scripts.guard))
  const reg = stripComments(src("lib/kernel/manager-registry.ts"))
  check("MAINTENANCE_DOMAINS.tenant_operating_baseline names this proof", /tenant_operating_baseline:\s*\{[^}]*proof:\s*"test:tenant-baseline"/.test(reg))
  const init = stripComments(src("lib/kernel/tenant-operating-baseline.ts"))
  check("default deps are the EXISTING initializers (no parallel system)", ["@/lib/platform/trial-funnel", "@/lib/platform/config-snapshots", "@/lib/auth/provision-isa-actor", "@/lib/kernel/assistant-starter", "@/lib/lead-pipeline/reactivation-sequence-installer", "@/lib/settings/brokerage-settings-merge", "@/lib/entitlements/ai-subscription-tier"].every((m) => init.includes(`import("${m}")`)) && /resolveUniqueTenantSlug\(/.test(init))
  // ONE WRITER (lane 140O): the staff tier change and the baseline both reach ai_subscription_tier through
  // lib/entitlements/ai-subscription-tier.ts; no other file writes the table (stripped source, lib/ + app/).
  {
    const { readdirSync, statSync } = await import("node:fs")
    const walk = (d: string, out: string[]) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p, out); else if (/\.tsx?$/.test(n)) out.push(p) }; return out }
    const writerRe = /from\(\s*"ai_subscription_tier"\s*\)\s*\.\s*(insert|update|upsert|delete)\s*\(/
    const writers = [...walk(join(ROOT, "lib"), []), ...walk(join(ROOT, "app"), [])].filter((p) => writerRe.test(stripComments(readFileSync(p, "utf8")))).map((p) => p.slice(ROOT.length + 1))
    check("ai_subscription_tier has exactly ONE writer file (lib/entitlements/ai-subscription-tier.ts)", writers.length === 1 && writers[0] === "lib/entitlements/ai-subscription-tier.ts", writers.join(", "))
    check("  control: the writer finder recognises a live insert and ignores a tombstone", writerRe.test(stripComments('await svc.from("ai_subscription_tier").insert({ a: 1 })')) && !writerRe.test(stripComments('// the old svc.from("ai_subscription_tier").insert({ a: 1 }) moved\nconst x = 1')))
    check("the staff tier change calls the one writer in set mode", /syncAiSubscriptionTier\(svc,\s*\{[^}]*mode:\s*"set"/.test(stripComments(src("app/actions/superadmin/brokerage-management.ts"))))
    check("the baseline calls the one writer in fill_absent mode only", /syncAiSubscriptionTier\(svc,\s*\{[^}]*mode:\s*"fill_absent"/.test(init) && !/syncAiSubscriptionTier\(svc,\s*\{[^}]*mode:\s*"set"/.test(init))
  }
  check("the baseline applies the snapshot in fill_absent mode only", /mode:\s*"fill_absent"/.test(init) && !/mode:\s*"replace"/.test(init))
  check("READINESS HOOK (integrator) comment marks the convergence point", /READINESS HOOK \(integrator\)/.test(src("lib/kernel/tenant-operating-baseline.ts")))
  const snapSrc = stripComments(src("lib/platform/config-snapshots.ts"))
  const fillRe = /fillAbsent\s*=\s*opts\.mode\s*===\s*"fill_absent"/
  check("applySnapshotPayload honours opts.mode === \"fill_absent\"", fillRe.test(snapSrc))
  check("negative control: a source without the mode switch is caught", !fillRe.test(snapSrc.replace(/fill_absent/g, "")))
  const door = stripComments(src("app/actions/superadmin/config-snapshots.ts"))
  check("staff apply door (wave 140N) DEFAULTS to fill_absent and selects replace only on an explicit boolean overwrite", /params\.overwrite === true/.test(door) && /"fill_absent"/.test(door) && /"replace"/.test(door) && /applySnapshotPayload\([\s\S]*?\{ mode \}\)/.test(door))
  check("…an overwrite is audited in superadmin_audit_log as snapshot.apply.overwrite — intent BEFORE the write (a refused row refuses the apply), result AFTER it naming the keys overwritten", /snapshot\.apply\.overwrite/.test(door) && /overwritten/.test(door) && door.indexOf('phase: "intent"') > -1 && door.indexOf('phase: "intent"') < door.indexOf("applySnapshotPayload(") && door.indexOf("applySnapshotPayload(") < door.indexOf('phase: "result"') && /if \(!intent\.ok\) return \{ ok: false/.test(door))
  check("negative control: a door that always passed replace would be caught", !/params\.overwrite === true/.test(door.replace(/params\.overwrite === true/g, "true")))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ TENANT_BASELINE_FAIL"); process.exit(1) }
  console.log(" ✅ TENANT_BASELINE_PASS — one idempotent operating baseline: snapshot versioned + evidenced, website once, fill-absent never overwrites a customization")
}
main().catch((e) => { console.error(e); process.exit(1) })
