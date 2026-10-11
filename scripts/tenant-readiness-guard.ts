#!/usr/bin/env tsx
/**
 * scripts/tenant-readiness-guard.ts   (npm run test:tenant-readiness)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TENANT READINESS CONTRACT + ITS RECONCILIATION THROUGH SELF-HEALING (wave 140, lanes 140B+K).
 * In-memory: a supabase-js stand-in whose update()/delete()/upsert() + .select() return the MATCHED ROWS
 * (writers COUNT, CLAUDE.md §3); the REAL ledger (withActionLedger) and the REAL healing-policy reader run
 * against it; the seams are the services that reach env / auth / a carrier (provider posture, secrets
 * posture, the A2P profile, the seat fold, the user-record repairer, the slug minter, the carrier loop).
 *
 *  1. every key evaluated on every report (READINESS_KEYS, derived), each with owner / evidence / lastChecked
 *  2. READY only when every required check is PASS or NOT_APPLICABLE (a trial's billing is a legitimate N/A)
 *  3. each REPAIRABLE check routes to ITS declared playbook (the owning service) and RE-VERIFIES
 *  4. the never-overwrite rule, with a POSITIVE CONTROL (the raw snapshot writer WOULD overwrite)
 *  5. forbidden classes (cross-tenant evidence, money text), an undeclared playbook, a policy-disallowed
 *     playbook and an exhausted cap ESCALATE with nothing run
 *  6. cross-tenant refusal in the executor (another tenant's user → boundary stop) and at the door (no argument)
 *  7. WAITING_EXTERNAL (carrier review) is not READY and is NOT repaired
 *  8. evidence rows per repair: self_heal_events + agent_action_ledger + the kernel event
 *  9. the scheduled sweep: HEALTH_DETECTORS tenant_readiness → the supervisor's retry rail → the declared run
 * 10. static: registration (package.json, guard membership by regex, MAINTENANCE_DOMAINS), the tenant
 *     predicate on every tenant-row read in the contract (stripped source + positive control), the doors'
 *     gates, no "platform-covered" in tenant-facing copy
 * BLIND SPOTS (published): provider posture / secrets / A2P profile / seat fold / repairer / slug minter /
 * carrier loop are seams (their own proofs cover them); the money checks are read-only by design.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  READINESS_KEYS, READINESS_OWNER, evaluateTenantReadiness, readinessVerdict, readinessIncident, retryReadinessRepair,
  fillAbsentDefaults, applyAbsentSnapshotDefaults, type ReadinessDeps, type ReadinessCheck,
} from "../lib/kernel/tenant-readiness"
import { SELF_HEAL_PLAYBOOKS, DOMAIN_PLAYBOOKS, DETECTOR_DOMAIN, runDeclaredPlaybook, type TroubleshootDeps } from "../lib/kernel/self-healing"
import { HEALTH_DETECTORS, DETECTORS, runOsHealthSupervisor } from "../lib/kernel/os-health"
import { applySnapshotPayload } from "../lib/platform/config-snapshots"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

let pass = 0, fail = 0
const ok = (c: unknown, m: string, extra?: string) => { if (c) { pass++; console.log(`  ✓ ${m}`) } else { fail++; console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`) } }
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const stripped = (p: string) => stripComments(read(p))

// ── in-memory supabase-js stand-in (writers return the matched rows) ─────────
type Row = Record<string, any>
function fakeClient(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(seed))
  let idSeq = 0
  const newId = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`
  const get = (r: Row, c: string) => { const m = /^([a-z_]+)->>([a-z_A-Z]+)$/.exec(c); return m ? r[m[1]]?.[m[2]] : r[c] }
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let mode: "select" | "insert" | "update" | "upsert" | "delete" = "select", payload: any = null, single = false, returning = false, lim = Infinity, head = false, counting = false, conflict: string | null = null
    const run = () => {
      const t = (tables[table] ??= [])
      const stamp = (r: Row) => ({ id: newId(), created_at: new Date().toISOString(), ...r })
      if (mode === "insert") { const rows = (Array.isArray(payload) ? payload : [payload]).map(stamp); t.push(...rows); return { data: returning ? (single ? rows[0] : rows) : null, error: null } }
      if (mode === "upsert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((p: Row) => {
          const hit = conflict ? t.find((r) => r[conflict!] === p[conflict!]) : null
          if (hit) { Object.assign(hit, p); return hit }
          const n = stamp(p); t.push(n); return n
        })
        return { data: returning ? rows : null, error: null }
      }
      const hit = t.filter((r) => filters.every((f) => f(r)))
      if (mode === "update") { hit.forEach((r) => Object.assign(r, payload)); return { data: returning ? hit : null, error: null } }
      if (mode === "delete") { tables[table] = t.filter((r) => !hit.includes(r)); return { data: returning ? hit : null, error: null } }
      if (head) return { data: null, count: counting ? hit.length : null, error: null }
      if (single) return { data: hit[hit.length - 1] ?? null, error: null }
      return { data: hit.slice(0, lim), count: counting ? hit.length : null, error: null }
    }
    const b: any = {
      select: (_c?: string, o?: { count?: string; head?: boolean }) => { if (mode !== "select") returning = true; if (o?.head) head = true; if (o?.count) counting = true; return b },
      insert: (p: any) => { mode = "insert"; payload = p; return b },
      upsert: (p: any, o?: { onConflict?: string }) => { mode = "upsert"; payload = p; conflict = o?.onConflict ?? null; return b },
      update: (p: any) => { mode = "update"; payload = p; return b },
      delete: () => { mode = "delete"; return b },
      eq: (c: string, v: unknown) => { filters.push((r) => get(r, c) === v); return b },
      neq: (c: string, v: unknown) => { filters.push((r) => get(r, c) !== v); return b },
      in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(get(r, c))); return b },
      gte: (c: string, v: any) => { filters.push((r) => get(r, c) >= v); return b },
      gt: (c: string, v: any) => { filters.push((r) => get(r, c) > v); return b },
      lte: (c: string, v: any) => { filters.push((r) => get(r, c) <= v); return b },
      lt: (c: string, v: any) => { filters.push((r) => get(r, c) < v); return b },
      like: (c: string, v: string) => { const pre = v.replace(/%$/, ""); filters.push((r) => String(get(r, c) ?? "").startsWith(pre)); return b },
      is: (c: string, v: unknown) => { filters.push((r) => (get(r, c) ?? null) === v); return b },
      not: (c: string, op: string, v: unknown) => { if (op === "is") filters.push((r) => (get(r, c) ?? null) !== v); return b },
      or: () => b, order: () => b, limit: (n: number) => { lim = n; return b },
      maybeSingle: () => { single = true; return b }, single: () => { single = true; return b },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }
  return { from, tables: () => tables }
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const U_A = "11111111-1111-4111-8111-111111111111", U_B = "22222222-2222-4222-8222-222222222222", U_C = "33333333-3333-4333-8333-333333333333"
const ISA = "44444444-4444-4444-8444-444444444444", TIER = "55555555-5555-4555-8555-555555555555", SNAP = "66666666-6666-4666-8666-666666666666"
const NOW = new Date("2026-10-11T12:00:00.000Z")
const later = new Date(NOW.getTime() + 14 * 86_400_000).toISOString()
const SNAPSHOT = {
  id: SNAP, name: "Solo starter", created_at: "2026-10-01T00:00:00.000Z",
  payload: {
    recommendedTier: "solo_agent",
    global: { timezone: "America/New_York", date_format: "MM/DD/YYYY", currency_symbol: "$", app_name: "VIP Agents" },
    brand: { tagline: "Default tagline", website_url: "https://default.example" },
    voice: { tone: "warm", formality_level: "casual" },
    features: [{ feature_key: "crm", override_type: "grant_trial", trial_ends_at: null }],
  },
}
const tenant = (id: string, uid: string, name: string, slug: string | null) => ({
  brokerage: { id, name, slug, plan_tier: "solo_agent", deleted_at: null, archived_at: null, onboarding_status: "active", ai_isa_system_user_id: ISA, email: `owner@${name.toLowerCase().replace(/\s+/g, "")}.test`, billing_metadata: {}, trial_ends_at: later },
  sub: { id: `${id.slice(0, 8)}-0000-4000-8000-000000000001`, brokerage_id: id, tier_id: TIER, status: "trialing", trial_end: later, stripe_customer_id: null, stripe_subscription_id: null, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z" },
  user: { id: uid, brokerage_id: id, user_type: "admin", deleted_at: null, created_at: "2026-10-01T00:00:00.000Z" },
})
const tA = tenant(A, U_A, "Acme Realty", "acme-realty"), tB = tenant(B, U_B, "Beta Realty", null), tC = tenant(C, U_C, "Gamma Realty", "gamma-realty")

function seed() {
  return {
    brokerages: [tA.brokerage, tB.brokerage, tC.brokerage],
    subscriptions: [tA.sub, tB.sub, tC.sub],
    subscription_tiers: [{ id: TIER, tier_name: "solo_agent", is_active: true, max_agents: 2 }],
    feature_flags: [{ feature_key: "crm", enabled: true, superadmin_only: false, deprecated: false, sunset_date: null, rollout_percentage: 100, solo_agent_access: true, team_access: true, brokerage_access: true, multi_location_access: true }],
    feature_access_overrides: [],
    platform_settings: [{ id: "ps", self_healing_ceilings: null, created_at: "2026-01-01T00:00:00.000Z" }],
    brokerage_settings: [{ id: "bs-a", brokerage_id: A, settings: {} }],
    tenant_policy_versions: [],
    global_settings: [{ id: "gs-a", brokerage_id: A, timezone: "America/Denver", date_format: null, currency_symbol: null, app_name: null, from_email: "hello@acme.test", from_name: "Acme" }, { id: "gs-c", brokerage_id: C, timezone: "America/Chicago", from_email: "hi@gamma.test" }],
    platform_config_snapshots: [SNAPSHOT],
    brokerage_brand_settings: [{ id: "bb-a", brokerage_id: A, tagline: "Acme custom tagline", website_url: null }, { id: "bb-c", brokerage_id: C, tagline: "Gamma" }],
    brand_voice_profile: [{ id: "bv-a", brokerage_id: A, agent_id: null, team_id: null, is_active: true, tone: "bold" }, { id: "bv-c", brokerage_id: C, agent_id: null, team_id: null, is_active: true }],
    users: [tA.user, tB.user, tC.user],
    agents: [{ id: "ag-a", user_id: U_A, brokerage_id: A }, { id: "ag-c", user_id: U_C, brokerage_id: C }],
    teams: [], managed_agents: [], self_heal_events: [], agent_action_ledger: [],
    tenant_phone_numbers: [{ id: "pn-b", brokerage_id: B, phone_number: "+13035550100", is_active: true }, { id: "pn-c", brokerage_id: C, phone_number: "+13035550200", is_active: true }],
    // B: brand filed, number attached, campaign NOT yet filed → "filing" (steps left). C: campaign filed, pending → "carrier_review".
    platform_credentials: [
      { id: "a2p-b", brokerage_id: B, platform: "twilio_a2p", is_active: true, config: { brand_sid: "BN1", brand_status: "APPROVED", number_attached: false } },
      { id: "a2p-c", brokerage_id: C, platform: "twilio_a2p", is_active: true, config: { brand_sid: "BN2", brand_status: "APPROVED", number_attached: true, messaging_service_sid: "MG1", campaign_sid: "CMP1", campaign_status: "PENDING" } },
    ],
  }
}

/** The seams for everything that reaches env / auth / a carrier. */
function deps(svc: ReturnType<typeof fakeClient>, spies: { repaired: string[]; advanced: string[]; minted: string[]; events: any[]; proposals: any[]; belled: string[] }, extra: Partial<ReadinessDeps> = {}): ReadinessDeps {
  const healing: TroubleshootDeps = {
    emit: async (e) => { spies.events.push(e); return { error: null } },
    propose: async (p) => { spies.proposals.push(p); return { id: "prop-1", error: null } },
    notify: async (_s, i) => { spies.belled.push(i.subjectKey) },
    services: {
      now: () => NOW,
      resolveUniqueTenantSlug: async (_s, name) => { spies.minted.push(name); return { ok: true, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-x1` } },
      repairUserRecords: async (userId) => {
        spies.repaired.push(userId)
        const u = svc.tables().users.find((r) => r.id === userId)
        if (!u) return { success: false, repaired: [], error: "User record not found" }
        if (!svc.tables().agents.some((r) => r.user_id === userId)) svc.tables().agents.push({ id: `ag-${userId.slice(0, 4)}`, user_id: userId, brokerage_id: u.brokerage_id })
        return { success: true, repaired: ["agents"] }
      },
      advanceTenantCarrier: async (_s, b) => {
        spies.advanced.push(b)
        const row = svc.tables().platform_credentials.find((r) => r.brokerage_id === b && r.platform === "twilio_a2p")
        if (row) row.config = { ...row.config, number_attached: true, messaging_service_sid: "MG9", campaign_sid: "CMP9", campaign_status: "PENDING" }
        return { before: "filing", after: "carrier_review", ran: ["10dlc"], needs: [] }
      },
    },
  }
  return {
    now: () => NOW,
    providerReadiness: async () => ({ ready: 3, needsConnection: 1, platformDark: 1, readinessPct: 75, rows: [
      { provider: "twilio", category: "voice_sms", state: "live_platform", ready: true }, { provider: "sendgrid", category: "email", state: "live_platform", ready: true },
      { provider: "stripe", category: "payments", state: "live_platform", ready: true }, { provider: "quickbooks", category: "accounting", state: "platform_dark", ready: false },
    ] }),
    encryptionConfigured: () => true,
    a2pProfile: async () => ({ ok: true }),
    seatPosture: async (_s, b) => ({ ok: true, seatCount: svc.tables().agents.filter((r) => r.brokerage_id === b).length, limit: 2, error: null }),
    healing, cycle: "proof",
    ...extra,
  }
}
const spies = () => ({ repaired: [] as string[], advanced: [] as string[], minted: [] as string[], events: [] as any[], proposals: [] as any[], belled: [] as string[] })
const byKey = (checks: readonly ReadinessCheck[]) => Object.fromEntries(checks.map((c) => [c.key, c])) as Record<string, ReadinessCheck>
const rows = (svc: ReturnType<typeof fakeClient>, b: string) => (svc.tables().self_heal_events ?? []).filter((r) => r.brokerage_id === b && String(r.action).startsWith("os_health_playbook:"))
const ledger = (svc: ReturnType<typeof fakeClient>, b: string) => (svc.tables().agent_action_ledger ?? []).filter((r) => r.brokerage_id === b).map((r) => `${r.action}:${r.status}`)

async function main() {
  // ── 1 + 2. every key, READY rule ───────────────────────────────────────────
  console.log("\n1–2. every key evaluated; READY = every required PASS / NOT_APPLICABLE")
  {
    const svc = fakeClient(seed()); const s = spies()
    const rep = await evaluateTenantReadiness(svc, A, { deps: deps(svc, s) })
    const k = byKey(rep.checks)
    ok(rep.checks.length === READINESS_KEYS.length && READINESS_KEYS.every((key) => k[key]), `all ${READINESS_KEYS.length} keys evaluated (derived from READINESS_KEYS)`)
    ok(rep.checks.every((c) => c.lastChecked === NOW.toISOString() && c.owner === READINESS_OWNER[c.key] && typeof c.reason === "string" && c.reason.length > 0 && c.evidence && typeof c.evidence === "object"), "every check carries lastChecked, its owner, a reason and evidence")
    ok(READINESS_KEYS.every((key) => READINESS_OWNER[key]), "every key names an owner (a manager or the platform)")
    ok(rep.ready === true && rep.blockers.length === 0, `a fully provisioned trial tenant is READY (${rep.checks.filter((c) => c.status === "PASS").length} PASS, ${rep.checks.filter((c) => c.status === "NOT_APPLICABLE").length} N/A)`, rep.blockers.join(" | "))
    ok(k.billing.status === "NOT_APPLICABLE" && /trial/i.test(k.billing.reason), "billing on a TRIAL is a legitimate NOT_APPLICABLE (a trial never requires Stripe linkage) — and READY still holds")
    ok(k.providerState.status === "PASS" && (k.providerState.evidence as any).platformDark === 1, "an OPTIONAL dark lane (accounting) is evidence, not a block")
    ok(k.communications.status === "PASS" && (k.communications.evidence as any).carrier === "not_applicable", "no phone number yet → email defaults PASS; carrier registration not applicable (starts when a number is provisioned)")
    ok(!("repairs" in rep), "no repair requested → no repairs field (the contract shape is exactly the five fields)")
    // the rule itself
    const flipped = rep.checks.map((c) => c.key === "settings" ? { ...c, status: "REPAIRABLE" as const } : c)
    const v = readinessVerdict(flipped)
    ok(!v.ready && v.blockers.length === 1 && v.blockers[0].startsWith("settings: REPAIRABLE"), "flip ONE required check → not READY, the blocker names it (never a score)")
    ok(readinessVerdict([]).ready === false, "an empty report is never READY")
    // a required dark lane blocks
    const svc2 = fakeClient(seed()); const s2 = spies()
    const rep2 = await evaluateTenantReadiness(svc2, A, { deps: deps(svc2, s2, { providerReadiness: async () => ({ ready: 0, needsConnection: 0, platformDark: 1, readinessPct: 0, rows: [{ provider: "twilio", category: "voice_sms", state: "platform_dark", ready: false }] }) }) })
    ok(!rep2.ready && byKey(rep2.checks).providerState.status === "BLOCKED" && byKey(rep2.checks).providerState.owner === "platform", "a REQUIRED lane dark at the platform (voice_sms) → BLOCKED, owner platform, not READY")
    const svc3 = fakeClient(seed()); const s3 = spies()
    const rep3 = await evaluateTenantReadiness(svc3, A, { deps: deps(svc3, s3, { encryptionConfigured: () => false }) })
    ok(!rep3.ready && byKey(rep3.checks).requiredSecurityState.status === "BLOCKED" && byKey(rep3.checks).requiredSecurityState.remediation === null, "secrets encryption absent → requiredSecurityState BLOCKED with NO remediation (never auto-remediated)")
    // money stays BLOCKED, never REPAIRABLE
    const svc4 = fakeClient(seed()); svc4.tables().subscriptions = svc4.tables().subscriptions.filter((r) => r.brokerage_id !== A)
    const rep4 = await evaluateTenantReadiness(svc4, A, { deps: deps(svc4, spies()) })
    const k4 = byKey(rep4.checks)
    ok(k4.subscription.status === "BLOCKED" && k4.subscription.remediation === null && k4.subscription.owner === "finance_manager" && k4.plan.status === "BLOCKED" && k4.billing.status === "BLOCKED", "no subscription row → subscription / plan / billing BLOCKED for Finance (money is never REPAIRABLE)")
    const svc5 = fakeClient(seed()); svc5.tables().subscription_tiers.push({ id: "t2", tier_name: "team", is_active: true }); svc5.tables().subscriptions.find((r) => r.brokerage_id === A)!.tier_id = "t2"
    const rep5 = await evaluateTenantReadiness(svc5, A, { deps: deps(svc5, spies()) })
    ok(byKey(rep5.checks).plan.status === "BLOCKED" && /drift/.test(byKey(rep5.checks).plan.reason), "plan drift (brokerage tier ≠ billed tier) → BLOCKED for Finance, never auto-corrected")
    const svc6 = fakeClient(seed()); const rep6 = await evaluateTenantReadiness(svc6, A, { deps: deps(svc6, spies(), { seatPosture: async () => ({ ok: true, seatCount: 3, limit: 2, error: null }) }) })
    ok(byKey(rep6.checks).seats.status === "BLOCKED" && /money/.test(byKey(rep6.checks).seats.reason), "seats over the band → BLOCKED (buy seats / upgrade is money)")
  }

  // ── 3 + 8. REPAIRABLE → declared playbook → re-verify, with evidence rows ───
  console.log("\n3 + 8. each REPAIRABLE routes to its declared playbook, re-verifies, leaves evidence")
  {
    const svc = fakeClient(seed()); const s = spies()
    const before = await evaluateTenantReadiness(svc, B, { deps: deps(svc, s) })
    const kb = byKey(before.checks)
    ok(!before.ready && kb.settings.status === "REPAIRABLE" && kb.settings.remediation?.playbook === "fill_settings_defaults", "no global_settings → settings REPAIRABLE → fill_settings_defaults")
    ok(kb.website.status === "REPAIRABLE" && kb.website.remediation?.playbook === "ensure_website_slug", "no slug → website REPAIRABLE → ensure_website_slug")
    ok(kb.snapshot.status === "REPAIRABLE" && kb.snapshot.remediation?.playbook === "apply_snapshot_defaults" && kb.snapshot.remediation?.params.layers === "brand,voice", "brand + voice layers absent → snapshot REPAIRABLE → apply_snapshot_defaults(layers=brand,voice)")
    ok(kb.adminUser.status === "REPAIRABLE" && kb.adminUser.remediation?.playbook === "repair_user_records" && kb.adminUser.remediation?.params.userId === U_B, "solo owner without an agents row → adminUser REPAIRABLE → repair_user_records(owner)")
    ok(kb.communications.status === "REPAIRABLE" && kb.communications.remediation?.playbook === "sync_carrier_registration", "carrier registration with steps left → communications REPAIRABLE → sync_carrier_registration")
    ok(before.checks.every((c) => c.status !== "REPAIRABLE" || !!c.remediation), "every REPAIRABLE carries a remediation; nothing else does")
    ok(before.checks.filter((c) => c.status === "REPAIRABLE").every((c) => (DOMAIN_PLAYBOOKS.provisioning as readonly string[]).includes(c.remediation!.playbook)), "every declared remediation is a playbook of the provisioning domain")

    const after = await evaluateTenantReadiness(svc, B, { repair: true, deps: deps(svc, s) })
    const ka = byKey(after.checks)
    ok((after.repairs ?? []).length === 5 && after.repairs!.every((r) => r.ran && r.ok && !r.escalated), `5 repairs ran through the engine (${after.repairs!.map((r) => `${r.key}→${r.playbook}`).join(", ")})`, JSON.stringify(after.repairs))
    ok(ka.settings.status === "PASS" && svc.tables().global_settings.some((r) => r.brokerage_id === B && r.timezone === "America/New_York"), "settings RE-VERIFIED PASS — the global layer landed through applySnapshotPayload")
    ok(ka.website.status === "PASS" && svc.tables().brokerages.find((r) => r.id === B)?.slug === "beta-realty-x1" && s.minted.length === 1, "website RE-VERIFIED PASS — the slug was minted through resolveUniqueTenantSlug once")
    ok(ka.snapshot.status === "PASS" && svc.tables().brokerage_brand_settings.some((r) => r.brokerage_id === B) && svc.tables().brand_voice_profile.some((r) => r.brokerage_id === B), "snapshot RE-VERIFIED PASS — brand + voice rows landed")
    ok(ka.adminUser.status === "PASS" && s.repaired.length === 1 && s.repaired[0] === U_B, "adminUser RE-VERIFIED PASS — repairIncompleteAccountSetup ran once for the owner")
    ok(ka.communications.status === "WAITING_EXTERNAL" && s.advanced.length === 1, "communications → the carrier loop ran once → now WAITING_EXTERNAL (carrier review), never claimed approved")
    ok(!after.ready && after.blockers.length === 1 && after.blockers[0].startsWith("communications: WAITING_EXTERNAL"), "after repair the tenant is NOT READY — the one open item is the external wait")
    const ev = rows(svc, B)
    ok(ev.length === 5 && ev.every((r) => r.outcome === "healed" && r.detail?.verification?.verified === true && r.detail?.flow === "os_health_tenant_readiness"), "an Exception-Center row per repair (self_heal_events os_health_playbook:*, verified, tenant B)")
    const acts = ledger(svc, B)
    ok(["fill_settings_defaults", "ensure_website_slug", "apply_snapshot_defaults", "repair_user_records", "sync_carrier_registration"].every((p) => acts.includes(`os_health.tenant_readiness.playbook_${p}:executed`)), `a ledger row per repair (${acts.length} rows)`, acts.join(", "))
    ok(s.events.length === 5 && s.events.every((e) => e.brokerageId === B && e.metadata?.recovery === "playbook"), "a kernel event per repair")
    ok(rows(svc, A).length === 0 && svc.tables().brokerages.find((r) => r.id === A)?.slug === "acme-realty" && svc.tables().global_settings.find((r) => r.brokerage_id === A)?.timezone === "America/Denver", "tenant A untouched by tenant B's repairs")
    // idempotent second pass
    const again = await evaluateTenantReadiness(svc, B, { repair: true, deps: deps(svc, s) })
    ok((again.repairs ?? []).length === 0 && s.minted.length === 1 && s.repaired.length === 1 && rows(svc, B).length === 5, "a second repair pass finds nothing REPAIRABLE — nothing re-runs (idempotent)")
  }

  // ── 4. never overwrite ─────────────────────────────────────────────────────
  console.log("\n4. a repair fills ABSENT defaults only — tenant customization is never overwritten")
  {
    const pure = fillAbsentDefaults(SNAPSHOT.payload as any, { global: { timezone: "America/Denver", app_name: null }, brand: { tagline: "Mine" }, voiceExists: true, featureKeys: new Set(["crm"]) }, ["global", "brand", "voice", "features"])
    ok(!("timezone" in pure.payload.global) && pure.payload.global.app_name === "VIP Agents" && pure.payload.global.date_format === "MM/DD/YYYY", "PURE: a present tenant value (timezone) is dropped; absent keys (app_name, date_format) are kept")
    ok(!("tagline" in pure.payload.brand) && pure.payload.brand.website_url === "https://default.example", "PURE: the customized tagline stays; the absent website_url is filled")
    ok(Object.keys(pure.payload.voice).length === 0 && pure.payload.features.length === 0 && pure.skipped.includes("voice.*") && pure.skipped.includes("features.crm"), "PURE: an active voice row and an existing override are never replaced (skipped, named)")
    const svc = fakeClient(seed())
    const r = await applyAbsentSnapshotDefaults(svc, A, ["global", "brand"], { snapshotForTier: async () => ({ id: SNAP, name: SNAPSHOT.name, createdAt: SNAPSHOT.created_at, payload: SNAPSHOT.payload as any }) })
    const gs = svc.tables().global_settings.find((x) => x.brokerage_id === A)!, bb = svc.tables().brokerage_brand_settings.find((x) => x.brokerage_id === A)!
    ok(r.ok && gs.timezone === "America/Denver" && gs.date_format === "MM/DD/YYYY" && bb.tagline === "Acme custom tagline" && bb.website_url === "https://default.example", `through the writer: timezone + tagline kept, date_format + website_url filled (kept ${JSON.stringify(r.kept)}, skipped ${r.skipped.join(",")})`)
    const r2 = await applyAbsentSnapshotDefaults(svc, A, ["global", "brand"], { snapshotForTier: async () => ({ id: SNAP, name: SNAPSHOT.name, createdAt: SNAPSHOT.created_at, payload: SNAPSHOT.payload as any }) })
    ok(r2.ok && r2.kept.global.length === 0 && r2.kept.brand.length === 0, "a second run keeps nothing (idempotent)")
    // POSITIVE CONTROL — the raw snapshot writer WOULD overwrite the tenant's tagline: the filter is load-bearing.
    const raw = fakeClient(seed())
    await applySnapshotPayload(SNAPSHOT.payload as any, A, U_A, raw as any)
    ok(raw.tables().brokerage_brand_settings.find((x) => x.brokerage_id === A)?.tagline === "Default tagline" && raw.tables().global_settings.find((x) => x.brokerage_id === A)?.timezone === "America/New_York", "POSITIVE CONTROL: applySnapshotPayload alone overwrites tagline + timezone — fillAbsentDefaults is what prevents it")
  }

  // ── 5. forbidden classes / undeclared / policy / cap → escalate, nothing runs ──
  console.log("\n5. forbidden classes, an undeclared playbook, a policy-disallowed playbook and an exhausted cap ESCALATE")
  {
    const base = async () => { const svc = fakeClient(seed()); const s = spies(); const rep = await evaluateTenantReadiness(svc, B, { deps: deps(svc, s) }); return { svc, s, check: byKey(rep.checks).settings } }
    const ctx = { playbookAttempts24h: 0, cycle: "proof", attempt: 1 }
    {
      const { svc, s, check } = await base()
      const i = readinessIncident(B, { ...check, evidence: { ...check.evidence, brokerage_id: A } })
      const r = await runDeclaredPlaybook(svc, i, check.remediation!, ctx, deps(svc, s).healing)
      ok(r.kind === "escalate" && r.gate === "tenant_boundary" && !svc.tables().global_settings.some((x) => x.brokerage_id === B) && rows(svc, B).length === 0, "evidence naming ANOTHER tenant → hard gate tenant_boundary; the executor never ran, no row written")
    }
    {
      const { svc, s, check } = await base()
      const i = readinessIncident(B, { ...check, reason: "operating defaults absent — stripe invoice settings missing" })
      const r = await runDeclaredPlaybook(svc, i, check.remediation!, ctx, deps(svc, s).healing)
      ok(r.kind === "escalate" && r.gate === "money" && rows(svc, B).length === 0, "money in the incident text → hard gate money; nothing ran")
    }
    {
      const { svc, s, check } = await base()
      const r = await runDeclaredPlaybook(svc, readinessIncident(B, check), { playbook: "re_sync", params: { sync: "transaction_documents" } }, ctx, deps(svc, s).healing)
      ok(r.kind === "escalate" && /not declared for the provisioning domain/.test(r.reason) && ledger(svc, B).includes("os_health.tenant_readiness.playbook_refused:failed") && rows(svc, B).length === 0, "a playbook outside the provisioning domain → refused (ledgered), nothing ran")
      const r2 = await runDeclaredPlaybook(svc, readinessIncident(B, check), { playbook: "drop_everything" }, { ...ctx, attempt: 2 }, deps(svc, s).healing)
      ok(r2.kind === "escalate" && /not a declared playbook/.test(r2.reason), "an INVENTED playbook → refused")
      const r3 = await runDeclaredPlaybook(svc, readinessIncident(B, check), { playbook: "apply_snapshot_defaults", params: { layers: "brand; drop table users" } }, { ...ctx, attempt: 3 }, deps(svc, s).healing)
      ok(r3.kind === "escalate" && /SQL/.test(r3.reason), "SQL in a parameter → refused (never LLM → SQL, never caller → SQL)")
    }
    {
      const { svc, s, check } = await base()
      const h = deps(svc, s).healing!
      const policy = { diagnosisCapUsd: 0.05, providerResearchCapUsd: 0.06, lawRuleResearchCapUsd: 0.1, lawRuleResearchMaxCalls: 6, maxAttemptsPerDay: 2, allowedRemediationClasses: ["re_render"], autoFixMinConfidence: 0.5, readable: true as const, source: { tenant: "policy" as const, ceiling: "default" as const }, clamped: [], ignored: [], note: null }
      const r = await runDeclaredPlaybook(svc, readinessIncident(B, check), check.remediation!, ctx, { ...h, policy })
      ok(r.kind === "escalate" && /allowed remediation classes/.test(r.reason) && rows(svc, B).length === 0, "the tenant's policy does not allow this acting playbook → escalate (a human approves), nothing ran")
    }
    {
      const { svc, s, check } = await base()
      const r = await runDeclaredPlaybook(svc, readinessIncident(B, check), check.remediation!, { playbookAttempts24h: 2, cycle: "proof", attempt: 3 }, deps(svc, s).healing)
      ok(r.kind === "escalate" && /exhausted/.test(r.reason) && s.proposals.length === 1 && r.proposalId === "prop-1" && rows(svc, B).length === 0, "the policy's attempt cap (2/day default) reached → proposal + human, no loop")
    }
    {
      // a failing repair keeps its evidence and escalates at the cap
      const svc = fakeClient(seed()); const s = spies()
      const d = deps(svc, s); d.healing!.services!.resolveUniqueTenantSlug = async () => ({ ok: false, error: "slug minter refused" })
      const check = byKey((await evaluateTenantReadiness(svc, B, { deps: d })).checks).website
      const r1 = await runDeclaredPlaybook(svc, readinessIncident(B, check), check.remediation!, { playbookAttempts24h: 0, cycle: "p", attempt: 1 }, d.healing)
      const r2 = await runDeclaredPlaybook(svc, readinessIncident(B, check), check.remediation!, { playbookAttempts24h: 1, cycle: "p", attempt: 2 }, d.healing)
      ok(r1.kind === "playbook" && !r1.ok && r2.kind === "escalate" && s.proposals.length === 1 && rows(svc, B).filter((x) => x.outcome === "failed").length === 2, "a failing repair: attempt 1 fails (retried next tick), attempt 2 = the cap → proposal + human; both failures keep their row")
    }
  }

  // ── 6. cross-tenant refusal ────────────────────────────────────────────────
  console.log("\n6. cross-tenant refusal — in the executor and at the door")
  {
    const svc = fakeClient(seed()); const s = spies()
    const check = byKey((await evaluateTenantReadiness(svc, B, { deps: deps(svc, s) })).checks).adminUser
    const r = await runDeclaredPlaybook(svc, readinessIncident(B, check), { playbook: "repair_user_records", params: { userId: U_C } }, { playbookAttempts24h: 0, cycle: "p", attempt: 1 }, deps(svc, s).healing)
    ok(r.kind === "escalate" && r.gate === "tenant_boundary" && s.repaired.length === 0, "repair_user_records with ANOTHER tenant's user → boundary stop; the repairer never called")
    const r2 = await runDeclaredPlaybook(svc, readinessIncident(B, check), { playbook: "repair_user_records", params: { userId: U_B } }, { playbookAttempts24h: 0, cycle: "p2", attempt: 1 }, deps(svc, s).healing)
    ok(r2.kind === "playbook" && r2.ok && s.repaired.length === 1, "POSITIVE CONTROL: the tenant's own owner repairs")
    const bad = await evaluateTenantReadiness(svc, "not-a-uuid", { deps: deps(svc, s) })
    ok(!bad.ready && bad.checks.length === READINESS_KEYS.length && bad.checks.every((c) => c.status === "BLOCKED" && /refused/.test(c.reason)), "a non-uuid tenant id → every check BLOCKED 'refused' (never an unscoped read)")
    const gone = await evaluateTenantReadiness(svc, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", { deps: deps(svc, s) })
    ok(!gone.ready && byKey(gone.checks).tenantCore.status === "BLOCKED" && gone.checks.filter((c) => c.key !== "tenantCore").every((c) => c.status === "BLOCKED" && /tenantCore/.test(c.reason)), "an unknown tenant → tenantCore BLOCKED and every other check short-circuits (no partial reads)")
    const door = stripped("app/actions/admin/tenant-readiness.ts")
    const doorExports = [...door.matchAll(/export async function (\w+)\(([^)]*)\)/g)]
    ok(/requireCallerTenant\(\)/.test(door) && /isTenantAdminGrantRole\(/.test(door) && doorExports.length === 2 && doorExports.every((m) => m[2].trim() === "") && doorExports.map((m) => m[1]).sort().join(",") === "getMyTenantReadiness,repairMyTenantReadiness", "the TENANT door's two exports take NO argument: session tenant via requireCallerTenant, tenant-admin via isTenantAdminGrantRole")
    const staff = stripped("app/actions/superadmin/tenant-readiness.ts")
    ok(/requirePlatformCapability\("support"\)/.test(staff) && /requireSuperadmin\(\)/.test(staff) && staff.indexOf("requireSuperadmin()") > staff.indexOf("repairTenantReadinessAction"), "the PLATFORM door: reads need the support capability, REPAIRS need superadmin")
  }

  // ── 7. WAITING_EXTERNAL is not READY and not repaired ──────────────────────
  console.log("\n7. WAITING_EXTERNAL (carrier review) is not READY and is NOT repaired")
  {
    const svc = fakeClient(seed()); const s = spies()
    const rep = await evaluateTenantReadiness(svc, C, { repair: true, deps: deps(svc, s) })
    const k = byKey(rep.checks)
    ok(k.communications.status === "WAITING_EXTERNAL" && k.communications.remediation === null && (k.communications.evidence as any).carrierPhase === "carrier_review", "campaign filed + pending → communications WAITING_EXTERNAL with no remediation")
    ok(!rep.ready && rep.blockers.length === 1 && (rep.repairs ?? []).length === 0 && s.advanced.length === 0 && rows(svc, C).length === 0, "not READY; repair:true ran NOTHING for it (no carrier call, no row) — the carrier's word is awaited")
  }

  // ── 9. the scheduled sweep: detector → supervisor retry rail → declared run ──
  console.log("\n9. the sweep rides the os-health supervisor (HEALTH_DETECTORS tenant_readiness → retry rail → runDeclaredPlaybook)")
  {
    ok((HEALTH_DETECTORS as readonly string[]).includes("tenant_readiness") && typeof DETECTORS.tenant_readiness === "function" && DETECTOR_DOMAIN.tenant_readiness === "provisioning", "tenant_readiness is a registered detector mapped to the provisioning domain")
    const svc = fakeClient(seed()); const s = spies()
    const d = deps(svc, s)
    const incidents = await DETECTORS.tenant_readiness(svc, B, { now: NOW })
    ok(incidents.length >= 4 && incidents.every((i) => i.class === "transient" && i.idempotent && i.detector === "tenant_readiness" && i.brokerageId === B && i.subjectKey.startsWith("readiness:") && (i.evidence as any).remediation?.playbook), `the detector emits one transient + idempotent incident per REPAIRABLE check (${incidents.map((i) => i.subjectKey).join(", ")}), each carrying its declared remediation`)
    ok(!incidents.some((i) => i.subjectKey === "readiness:providerState" || i.subjectKey === "readiness:requiredSecurityState"), "BLOCKED checks (provider posture / secrets in this env) are NOT incidents — never an autonomous action")
    const executed: string[] = []
    const rep = await runOsHealthSupervisor(B, svc, { now: NOW, detectors: ["tenant_readiness"], executorDeps: {
      retry: async (c, i) => { executed.push(i.subjectKey); return retryReadinessRepair(c, i, d) },
      emit: async () => ({ error: null }), notifyHuman: async () => {}, troubleshoot: false,
    } as any })
    const settings = rep.outcomes.find((o) => o.incident.subjectKey === "readiness:settings")
    ok(!!settings && settings.decision.action === "retry" && settings.executed && /fill_settings_defaults/.test(settings.outcome) && svc.tables().global_settings.some((x) => x.brokerage_id === B), `the supervisor's RETRY rail runs the declared repair (${settings?.outcome.slice(0, 90)})`)
    ok(executed.includes("readiness:website") && svc.tables().brokerages.find((x) => x.id === B)?.slug === "beta-realty-x1", "the slug repair ran on the same tick")
    const os = stripped("lib/kernel/os-health.ts")
    ok(/i\.detector === "tenant_readiness"/.test(os) && /retryReadinessRepair\(svc, i\)/.test(os), "static: defaultRetry routes a tenant_readiness incident to retryReadinessRepair (the production wire the seam stood in for)")
    const detBody = os.slice(os.indexOf("tenant_readiness: async (svc, b, deps)"), os.indexOf("}", os.indexOf("tenant_readiness: async (svc, b, deps)") + 400))
    ok(/evaluateTenantReadiness\(svc, b,/.test(detBody) && /status === "REPAIRABLE"/.test(detBody), "static: the detector evaluates THIS tenant and emits only REPAIRABLE checks")
  }

  // ── 10. static census ──────────────────────────────────────────────────────
  console.log("\n10. registration, tenant predicates, copy")
  {
    const pkg = JSON.parse(read("package.json"))
    ok(pkg.scripts["test:tenant-readiness"] === "tsx --conditions=react-server scripts/tenant-readiness-guard.ts", "package.json registers test:tenant-readiness")
    ok(new RegExp("npm run test:tenant-readiness(\\s|&|$)").test(pkg.scripts.guard), "the guard chain runs test:tenant-readiness (membership, not position)")
    ok(MAINTENANCE_DOMAINS.tenant_readiness_contract?.proof === "test:tenant-readiness" && MAINTENANCE_DOMAINS.tenant_readiness_contract.manager === "data_steward" && (MAINTENANCE_DOMAINS.tenant_readiness_contract.coOwners ?? []).includes("cron_manager"), "MAINTENANCE_DOMAINS.tenant_readiness_contract names its proof, owner and co-owners")
    const five = ["fill_settings_defaults", "apply_snapshot_defaults", "ensure_website_slug", "repair_user_records", "sync_carrier_registration"] as const
    ok(five.every((p) => SELF_HEAL_PLAYBOOKS[p]?.acts && SELF_HEAL_PLAYBOOKS[p].runner === "owning_rail" && (DOMAIN_PLAYBOOKS.provisioning as readonly string[]).includes(p)), "the five provisioning playbooks are declared, acting, owning-rail, and listed under provisioning")
    ok(DOMAIN_PLAYBOOKS.provisioning.every((k) => (five as readonly string[]).includes(k) || !SELF_HEAL_PLAYBOOKS[k].acts), "provisioning declares no OTHER acting playbook (no re_sync / rebuild / requeue reaches a tenant's provisioning rows)")
    // every tenant-row read in the contract carries the tenant predicate (stripped source; platform catalogues allow-listed with the reason)
    const src = stripped("lib/kernel/tenant-readiness.ts")
    const PLATFORM_CATALOGUES = new Set(["subscription_tiers", "feature_flags"]) // platform-wide rows, no brokerage column by design
    const scan = (body: string): string[] => {
      const out: string[] = []
      // a chain ends at .maybeSingle() / .limit( / a line break that is NOT a continuation ("\n    .select(")
      const re = /\.from\("([a-z_]+)"\)([\s\S]*?)(?=\.maybeSingle\(\)|\.limit\(|\n(?!\s*\.))/g
      let m: RegExpExecArray | null
      while ((m = re.exec(body)) !== null) {
        if (PLATFORM_CATALOGUES.has(m[1])) continue
        if (!/\.eq\("(brokerage_id|id)",\s*(c\.b|b|brokerageId|i\.brokerageId)\)|\.eq\("slug", slug\)|\.eq\("id", c\.sub\.tier_id\)|\.eq\("user_id", owner\.id\)\.eq\("brokerage_id", c\.b\)/.test(m[2])) out.push(m[1])
      }
      return out
    }
    const unscoped = scan(src)
    ok(unscoped.length === 0, `static: every tenant-row read in the contract carries the tenant predicate (${(src.match(/\.from\("/g) ?? []).length} reads scanned; catalogues allow-listed: ${[...PLATFORM_CATALOGUES].join(", ")})`, unscoped.join(", "))
    ok(scan(`svc.from("global_settings").select("id").limit(1)\n`).includes("global_settings"), "POSITIVE CONTROL: the scanner flags a planted unscoped read")
    const tenantCopy = ["app/components/onboarding/tenant-readiness-card.tsx", "app/components/onboarding/tenant-readiness-view.tsx", "app/actions/admin/tenant-readiness.ts"].map(read).join("\n")
    ok(!/platform-covered/i.test(tenantCopy), "tenant-facing copy never says 'platform-covered'")
    ok(/TenantReadinessCard/.test(read("app/dashboard/brokerage/page.tsx")) && /TenantReadinessPanel/.test(read("app/dashboard/superadmin/brokerages/[id]/page.tsx")), "both doors are MOUNTED (broker dashboard card; god-console tenant panel)")
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
