// lib/kernel/tenant-readiness.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE TENANT READINESS CONTRACT (wave 140, lanes 140B + 140K; owner ruling: "one structured contract …
// each check PASS / REPAIRABLE / WAITING_EXTERNAL / BLOCKED / NOT_APPLICABLE with reason, evidence, owner,
// lastChecked, remediation-if-allowed; READY = every required item PASS or legitimate NOT_APPLICABLE;
// never one opaque score. REPAIRABLE gaps route through the EXISTING self-healing engine … to the owning
// service, then RE-VERIFY; money / security / credentials / cross-tenant / destructive → escalate").
//
// AUDITED FIRST (LAW 1) — nothing at HEAD answered "is THIS TENANT provisioned and ready to operate":
//   · lib/onboarding/setup-readiness.ts + critical-setup.ts   per-ROLE "what must this USER configure"
//     checklists (human-configured items, a %); they are consumed by the onboarding cards and stay.
//   · lib/platform/go-live-readiness.ts + launch-checklist.ts  the PLATFORM's configuration (env, vendors).
//   · lib/platform/provider-posture.ts getBrokerageProviderReadiness  ONE key of this contract
//     (providerState) — REUSED below, never re-derived.
//   · lib/kernel/os-health.ts  RUNTIME incidents; its supervisor is the tick this contract's sweep rides
//     (HEALTH_DETECTORS tenant_readiness → the retry rail → runDeclaredPlaybook).
//   · scripts/tenant-provisioning-loops-simulator.ts  a PROOF of the four provisioning loops, not a reader.
// So this file is the MISSING half: every check reads the OWNING service's truth (the brokerage row,
// billing-access, the plan catalogue, tenant capabilities, the healing / tenant policy, settings, the tier
// snapshot, the storefront slug, the admin seat + the provisioning spec, seat usage, managed agents, the
// carrier-registration loop, Stripe linkage on the subscription row, provider posture, secret-crypto).
//
// REPAIR (140K) — `opts.repair` routes each REPAIRABLE check's DECLARED remediation through
// lib/kernel/self-healing.ts runDeclaredPlaybook (hard gate → healing policy: attempt cap + allowed
// classes → the provisioning executor over the owning service → VERIFY → self_heal_events row + ledger +
// event → proposal + human at the cap), then RE-RUNS the check. A repair fills ABSENT defaults only
// (fillAbsentDefaults is the pure rule; applyAbsentSnapshotDefaults applies it through the ONE snapshot
// writer applySnapshotPayload) — tenant customization is never overwritten. Money (subscription, plan,
// billing, seats over cap), security (secrets posture), credentials, cross-tenant and destructive
// (duplicate slugs) findings are BLOCKED with evidence and an owner — never routed to a playbook.
//
// Other lanes CONSUME this contract (import its types); `// READINESS HOOK (integrator)` marks their
// convergence points. One contract — never a second.

import type { ManagerKey } from "@/lib/kernel/manager-registry"
import type { HealthIncident } from "@/lib/kernel/os-health"
import type { TroubleshootDeps } from "@/lib/kernel/self-healing"
import type { SnapshotPayload } from "@/lib/platform/config-snapshots"
import type { A2pState } from "@/lib/voice/a2p-registration"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { ownerNeedsTeamRow, requiresAgentRow } from "@/lib/kernel/tenant-provisioning-spec"
import { isCanonicalTier, tenantWebsitePath } from "@/lib/kernel/tenant-creation"

type Svc = any

// ── 1. The contract ───────────────────────────────────────────────────────────────────────────

/** @proofSeam the proof iterates the keys to assert every one is evaluated on every report */
export const READINESS_KEYS = [
  "tenantCore", "subscription", "plan", "entitlements", "policies", "settings", "snapshot", "website",
  "adminUser", "seats", "managers", "communications", "billing", "providerState", "requiredSecurityState",
] as const
export type ReadinessKey = (typeof READINESS_KEYS)[number]
export type ReadinessStatus = "PASS" | "REPAIRABLE" | "WAITING_EXTERNAL" | "BLOCKED" | "NOT_APPLICABLE"

export interface ReadinessCheck {
  key: ReadinessKey
  status: ReadinessStatus
  required: boolean
  reason: string
  evidence: Record<string, unknown>
  owner: ManagerKey | "platform"
  lastChecked: string
  /** The DECLARED self-healing playbook that fills this gap (REPAIRABLE only); null = nothing autonomous may run. */
  remediation: { playbook: string; params: Record<string, unknown> } | null
}

interface ReadinessRepairOutcome {
  key: ReadinessKey
  playbook: string
  /** The engine ran the executor (false = refused / gated / exhausted before running). */
  ran: boolean
  ok: boolean
  /** The check's status after the re-run (the RE-VERIFY). */
  after: ReadinessStatus
  /** The engine escalated (hard gate, policy, exhausted attempts) — a human has it, with the evidence. */
  escalated: boolean
  outcome: string
}

export interface TenantReadinessReport {
  brokerageId: string
  ready: boolean
  checkedAt: string
  checks: ReadinessCheck[]
  blockers: string[]
  /** Present only when `opts.repair` ran: one row per REPAIRABLE check routed to the engine. */
  repairs?: ReadinessRepairOutcome[]
}

/** Who answers for each check (the manager accountable for the owning service; `platform` = staff). */
/** @proofSeam the proof asserts every key names an owner */
export const READINESS_OWNER: Readonly<Record<ReadinessKey, ManagerKey | "platform">> = Object.freeze({
  tenantCore: "data_steward", subscription: "finance_manager", plan: "finance_manager", entitlements: "finance_manager",
  policies: "compliance_officer", settings: "data_steward", snapshot: "data_steward", website: "campaign_orchestrator",
  adminUser: "data_steward", seats: "finance_manager", managers: "cron_manager", communications: "ai_isa",
  billing: "finance_manager", providerState: "platform", requiredSecurityState: "platform",
})

/** Every key is required: an optional condition reads NOT_APPLICABLE with its reason, never "optional". */
const REQUIRED: ReadonlySet<ReadinessKey> = new Set(READINESS_KEYS)

/** Provider categories a tenant cannot operate without (platform-dark here BLOCKS; other lanes are evidence).
 *  The proof drives a dark required lane (voice_sms) and a dark optional lane (accounting) through the seam. */
const REQUIRED_PROVIDER_CATEGORIES: ReadonlySet<string> = new Set(["voice_sms", "email", "payments", "ai_llm"])

// ── 2. Seams (production resolves every survivor by dynamic import; a proof injects the ones that reach env / network) ──

export interface ReadinessDeps {
  now?: () => Date
  /** lib/platform/provider-posture.ts getBrokerageProviderReadiness (reads env + the registry). */
  providerReadiness?: (svc: Svc, brokerageId: string) => Promise<{ ready: number; needsConnection: number; platformDark: number; readinessPct: number; rows: Array<{ provider: string; category: string; state: string; ready: boolean }> }>
  /** lib/security/secret-crypto.ts isEncryptionConfigured (reads SECRETS_ENCRYPTION_KEY). */
  encryptionConfigured?: () => boolean
  /** lib/voice/a2p-registration.ts resolveA2pProfile (reads the registration sources + NEXT_PUBLIC_APP_URL). */
  a2pProfile?: (svc: Svc, brokerageId: string) => Promise<{ ok: boolean; missing?: string[] }>
  /** lib/platform/trial-funnel.ts snapshotForTier (the tier's canonical snapshot). */
  snapshotForTier?: (tier: string, svc: Svc) => Promise<{ id: string; name: string; createdAt: string; payload: SnapshotPayload } | null>
  /** lib/kernel/seat-usage.ts resolveSeatUsage / resolveCatalogSeatLimits / resolveTenantSeatTerms fold. */
  seatPosture?: (svc: Svc, brokerageId: string, tier: string, seatOverride: number | null) => Promise<{ ok: boolean; seatCount: number; limit: number | null; error: string | null }>
  /** The self-healing engine's seams (ledger / emit / propose / notify / policy / executor services). */
  healing?: TroubleshootDeps
  /** The sweep cycle id the ledger keys carry (default: the minute). */
  cycle?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Partial_ = Omit<ReadinessCheck, "key" | "owner" | "lastChecked" | "required">
const pass = (reason: string, evidence: Record<string, unknown> = {}): Partial_ => ({ status: "PASS", reason, evidence, remediation: null })
const blocked = (reason: string, evidence: Record<string, unknown> = {}): Partial_ => ({ status: "BLOCKED", reason, evidence, remediation: null })
const waiting = (reason: string, evidence: Record<string, unknown> = {}): Partial_ => ({ status: "WAITING_EXTERNAL", reason, evidence, remediation: null })
const notApplicable = (reason: string, evidence: Record<string, unknown> = {}): Partial_ => ({ status: "NOT_APPLICABLE", reason, evidence, remediation: null })
const repairable = (reason: string, playbook: string, params: Record<string, unknown>, evidence: Record<string, unknown> = {}): Partial_ => ({ status: "REPAIRABLE", reason, evidence, remediation: { playbook, params } })

interface BrokerageRow { id: string; name: string | null; slug: string | null; plan_tier: string | null; deleted_at: string | null; archived_at: string | null; onboarding_status: string | null; ai_isa_system_user_id: string | null; email: string | null; billing_metadata: Record<string, unknown> | null }
interface SubRow { id: string; tier_id: string | null; status: string | null; stripe_customer_id: string | null; stripe_subscription_id: string | null }

interface Ctx {
  svc: Svc
  b: string
  now: Date
  deps: ReadinessDeps
  brk: BrokerageRow | null
  tier: string | null
  sub: SubRow | null
  /** loadBillingAccess state, resolved once for subscription + billing. */
  access: { state: string; reason: string; trialDaysLeft: number | null } | null
  gs: Record<string, unknown> | null | undefined
}

// ── 3. The checks (each reads the OWNING service's truth) ────────────────────────────────────

type Check = (c: Ctx) => Promise<Partial_>

const CHECKS: Record<ReadinessKey, Check> = {
  tenantCore: async (c) => {
    if (!c.brk) return blocked("no brokerage row for this tenant — nothing downstream can be evaluated", { brokerageId: c.b })
    const b = c.brk
    if (b.deleted_at || b.archived_at) return blocked("the tenant is archived / deleted — not an operating tenant", { deleted_at: b.deleted_at, archived_at: b.archived_at })
    if (!(b.name ?? "").trim()) return blocked("the brokerage row has no name", {})
    if (!isCanonicalTier(b.plan_tier)) return blocked(`plan_tier "${b.plan_tier ?? "null"}" is not a canonical tier`, { plan_tier: b.plan_tier })
    return pass("brokerage row present, named, on a canonical tier", { name: b.name, tier: b.plan_tier, onboardingStatus: b.onboarding_status })
  },

  subscription: async (c) => {
    if (!c.access) return blocked("subscription state unreadable (billing-access refused)", {})
    const a = c.access
    if (a.state === "active" || a.state === "trialing") return pass(`subscription ${a.state}${a.trialDaysLeft !== null ? ` (${a.trialDaysLeft} trial day(s) left)` : ""}`, { state: a.state, trialDaysLeft: a.trialDaysLeft, subscriptionId: c.sub?.id ?? null })
    if (a.state === "none") return blocked("no subscription row — provisioning never wrote it; a money object, Finance decides (never auto-created)", { state: a.state, reason: a.reason })
    return blocked(`subscription ${a.state} — ${a.reason}; dunning / renewal is Finance's, never auto-corrected`, { state: a.state, reason: a.reason })
  },

  plan: async (c) => {
    const tier = c.tier
    if (!tier) return blocked("no canonical plan tier on the brokerage row", {})
    const { data: tierRow, error } = await c.svc.from("subscription_tiers").select("id, tier_name, is_active").eq("tier_name", tier).eq("is_active", true).maybeSingle()
    if (error) return blocked(`plan catalogue unreadable: ${error.message}`, { tier })
    if (!tierRow) return blocked(`no active subscription_tiers row for "${tier}" — the platform catalogue is incomplete`, { tier })
    if (!c.sub?.tier_id) return blocked("the subscription row names no tier — Finance decides", { tier, subscriptionId: c.sub?.id ?? null })
    const { data: subTier, error: stErr } = await c.svc.from("subscription_tiers").select("id, tier_name").eq("id", c.sub.tier_id).maybeSingle()
    if (stErr) return blocked(`subscription tier unreadable: ${stErr.message}`, { tier })
    const billedTier = (subTier as { tier_name?: string } | null)?.tier_name ?? null
    if (billedTier !== tier) return blocked(`plan drift — brokerage says "${tier}", the subscription bills "${billedTier ?? "unknown"}"; an entitlement-vs-invoice question, Finance decides`, { tier, billedTier })
    return pass(`plan ${tier} — catalogue row active, subscription bills the same tier`, { tier, tierId: (tierRow as { id: string }).id })
  },

  entitlements: async (c) => {
    const tier = c.tier
    if (!tier) return blocked("no canonical plan tier — entitlements cannot be resolved", {})
    const { data: flags, error } = await c.svc.from("feature_flags").select("feature_key").eq("enabled", true).eq(`${tier}_access`, true).limit(500)
    if (error) return blocked(`feature catalogue unreadable: ${error.message}`, { tier })
    const keys = ((flags ?? []) as Array<{ feature_key: string }>).map((f) => f.feature_key)
    if (!keys.length) return blocked(`the feature catalogue grants the ${tier} tier nothing — a platform catalogue gap (feature_flags.${tier}_access)`, { tier, catalogued: 0 })
    const { resolveTenantCapabilities } = await import("@/lib/entitlements/tenant-capabilities")
    const r = await resolveTenantCapabilities(c.svc, c.b, keys)
    if (!r.ok) return blocked(`entitlements unresolvable: ${r.reason}`, { tier, catalogued: keys.length })
    if (r.allowed.size === 0) return blocked("every catalogued feature is refused for this tenant (overrides) — Finance reviews", { tier, catalogued: keys.length, refused: [...r.refusedBecause.entries()].slice(0, 5) })
    return pass(`${r.allowed.size}/${keys.length} catalogued ${tier} features entitled`, { tier, catalogued: keys.length, allowed: r.allowed.size })
  },

  policies: async (c) => {
    const { loadHealingPolicy } = await import("@/lib/kernel/healing-policy")
    const policy = await loadHealingPolicy(c.svc, c.b)
    if (!policy.readable) return blocked(`operating policy unreadable: ${policy.note ?? "no detail"} — nothing autonomous may act for this tenant`, {})
    const { count, error } = await c.svc.from("tenant_policy_versions").select("id", { count: "exact", head: true }).eq("brokerage_id", c.b)
    if (error) return blocked(`policy version history unreadable: ${error.message}`, { healingSource: policy.source })
    return pass(`policy resolvable (healing: tenant ${policy.source.tenant} / ceiling ${policy.source.ceiling}); ${count ?? 0} versioned change(s)`, { healingSource: policy.source, policyVersions: count ?? 0, maxAttemptsPerDay: policy.maxAttemptsPerDay })
  },

  settings: async (c) => {
    if (c.gs === undefined) return blocked("operating defaults (global_settings) unreadable", {})
    const { data: bs, error } = await c.svc.from("brokerage_settings").select("id").eq("brokerage_id", c.b).maybeSingle()
    if (error) return blocked(`brokerage_settings unreadable: ${error.message}`, {})
    if (!c.gs) return repairable("operating defaults (global_settings: timezone, date format, currency, app name) absent — fill the tier snapshot's global layer, absent keys only", "fill_settings_defaults", {}, { hasGlobalSettings: false, hasSettingsRow: !!bs })
    return pass("operating defaults present", { hasGlobalSettings: true, hasSettingsRow: !!bs, timezone: c.gs.timezone ?? null })
  },

  snapshot: async (c) => {
    const tier = c.tier
    if (!tier) return blocked("no canonical plan tier — no snapshot can be chosen", {})
    const snap = await (c.deps.snapshotForTier ?? (async (t, s) => (await import("@/lib/platform/trial-funnel")).snapshotForTier(t, s)))(tier, c.svc)
    if (!snap) return blocked(`no canonical config snapshot catalogued for the ${tier} tier (platform_config_snapshots payload.recommendedTier) — platform staff capture one`, { tier })
    const [brand, voice] = await Promise.all([
      c.svc.from("brokerage_brand_settings").select("id").eq("brokerage_id", c.b).maybeSingle(),
      c.svc.from("brand_voice_profile").select("id").eq("brokerage_id", c.b).is("agent_id", null).is("team_id", null).eq("is_active", true).limit(1),
    ])
    if (brand.error || voice.error) return blocked(`snapshot evidence unreadable: ${(brand.error ?? voice.error).message}`, { snapshotId: snap.id })
    const missing: string[] = []
    if (!brand.data) missing.push("brand")
    if (!((voice.data ?? []) as unknown[]).length) missing.push("voice")
    const evidence = { snapshotId: snap.id, snapshotName: snap.name, snapshotVersion: snap.createdAt, missingLayers: missing }
    if (missing.length) return repairable(`snapshot "${snap.name}" not evidenced on the tenant (${missing.join(", ")} layer(s) absent) — re-apply those layers, absent keys only`, "apply_snapshot_defaults", { layers: missing.join(",") }, evidence)
    return pass(`snapshot "${snap.name}" (${snap.createdAt}) evidenced: brand + voice layers present`, evidence)
  },

  website: async (c) => {
    const slug = (c.brk?.slug ?? "").trim()
    if (!slug) return repairable("no storefront slug — the website cannot be served (app/site/[slug]); mint one through resolveUniqueTenantSlug", "ensure_website_slug", {}, { slug: null })
    const { data: same, error } = await c.svc.from("brokerages").select("id").eq("slug", slug).is("deleted_at", null).limit(2)
    if (error) return blocked(`storefront uniqueness unreadable: ${error.message}`, { slug })
    const n = ((same ?? []) as unknown[]).length
    if (n > 1) return blocked(`slug "${slug}" is shared by ${n} live brokerages — resolving it re-homes a storefront (destructive); a human decides`, { slug, holders: n })
    return pass(`website served at ${tenantWebsitePath(slug)}`, { slug, path: tenantWebsitePath(slug) })
  },

  adminUser: async (c) => {
    const { data: admins, error } = await c.svc.from("users").select("id, user_type, created_at").eq("brokerage_id", c.b).is("deleted_at", null)
      .in("user_type", [...TENANT_ADMIN_USER_TYPES]).order("created_at", { ascending: true }).limit(20)
    if (error) return blocked(`admin seat unreadable: ${error.message}`, {})
    const rows = (admins ?? []) as Array<{ id: string; user_type: string }>
    if (!rows.length) return blocked("no admin seat on this tenant — inviting an owner needs a human's email (provisionTenantOwner); never fabricated", { adminUsers: 0 })
    const owner = rows[0]
    const tier = c.tier
    const needsAgent = requiresAgentRow(owner.user_type, tier)
    const needsTeam = !!tier && ownerNeedsTeamRow(tier)
    const [agent, team] = await Promise.all([
      needsAgent ? c.svc.from("agents").select("id").eq("user_id", owner.id).eq("brokerage_id", c.b).limit(1) : Promise.resolve({ data: null, error: null }),
      needsTeam ? c.svc.from("teams").select("id").eq("brokerage_id", c.b).is("deleted_at", null).limit(1) : Promise.resolve({ data: null, error: null }),
    ])
    if (agent.error || team.error) return blocked(`owner domain records unreadable: ${(agent.error ?? team.error).message}`, { ownerUserId: owner.id })
    const agentRow = needsAgent ? ((agent.data ?? []) as unknown[]).length > 0 : null
    const teamRow = needsTeam ? ((team.data ?? []) as unknown[]).length > 0 : null
    const evidence = { adminUsers: rows.length, ownerUserId: owner.id, ownerType: owner.user_type, tier, agentRow, teamRow }
    if (agentRow === false || teamRow === false) {
      return repairable(`the owner (${owner.user_type}, ${tier}) is missing ${[agentRow === false ? "an agents row" : null, teamRow === false ? "a teams row" : null].filter(Boolean).join(" + ")} the provisioning spec requires — repair through the one provisioning brain (createOrRepairUserDomainRecords)`, "repair_user_records", { userId: owner.id }, evidence)
    }
    return pass(`${rows.length} admin seat(s); the owner's tier-required records are present`, evidence)
  },

  seats: async (c) => {
    const tier = c.tier
    if (!tier) return blocked("no canonical plan tier — the seat band cannot be resolved", {})
    const bm = c.brk?.billing_metadata ?? null
    const rawOverride = bm && typeof bm === "object" ? (bm as Record<string, unknown>).seat_override : null
    const seatOverride = typeof rawOverride === "number" && Number.isInteger(rawOverride) ? rawOverride : null
    const posture = await (c.deps.seatPosture ?? defaultSeatPosture)(c.svc, c.b, tier, seatOverride)
    if (!posture.ok) return blocked(`seat usage unreadable: ${posture.error ?? "refused"} — a refused count never reads as zero`, { tier })
    if (posture.limit !== null && posture.seatCount > posture.limit) return blocked(`${posture.seatCount} producing seats on a ${posture.limit}-seat band — upgrade / buy seats is a money decision; Finance (and the tenant) decide`, { tier, seatCount: posture.seatCount, limit: posture.limit })
    return pass(`${posture.seatCount} producing seat(s) within the ${posture.limit === null ? "unlimited" : String(posture.limit)} band`, { tier, seatCount: posture.seatCount, limit: posture.limit })
  },

  managers: async (c) => {
    const { data, error } = await c.svc.from("managed_agents").select("agent_kind, archived_at").eq("brokerage_id", c.b).limit(100)
    if (error) return blocked(`manager configuration unreadable: ${error.message}`, {})
    const rows = (data ?? []) as Array<{ agent_kind: string; archived_at: string | null }>
    const live = [...new Set(rows.filter((r) => !r.archived_at).map((r) => r.agent_kind))]
    // Managers are SPAWNED on first use by lib/agents/spawn-helper.ts (adopt-or-insert per agent_kind) and
    // their config defaults apply in code when absent (autonomy gate) — an empty roster on a new tenant is by design.
    return pass(`${live.length} manager(s) configured (${live.join(", ") || "none yet — spawned on first session, defaults apply in code"})`, { configured: live, archived: rows.length - rows.filter((r) => !r.archived_at).length })
  },

  communications: async (c) => {
    const fromEmail = (c.gs?.from_email as string | null | undefined) ?? null
    const replyTo = (c.brk?.email ?? "").trim() || null
    if (!fromEmail && !replyTo) return blocked("no sender identity — neither global_settings.from_email nor the brokerage email is set; a human supplies it", {})
    const { data: nums, error } = await c.svc.from("tenant_phone_numbers").select("phone_number").eq("brokerage_id", c.b).eq("is_active", true).limit(20)
    if (error) return blocked(`phone inventory unreadable: ${error.message}`, { fromEmail: !!fromEmail, replyTo: !!replyTo })
    const numbers = (nums ?? []) as Array<{ phone_number: string }>
    const emailEv = { fromEmail: !!fromEmail, replyTo: !!replyTo }
    if (!numbers.length) return pass("email defaults present; no phone number provisioned yet (carrier registration starts automatically when one is)", { ...emailEv, numbers: 0, carrier: "not_applicable" })
    const { loadA2pState } = await import("@/lib/voice/a2p-registration")
    const { carrierRegistrationPhase } = await import("@/lib/voice/carrier-registration-loop")
    let state: A2pState
    try { state = (await loadA2pState(c.svc, c.b)).state } catch (e) { return blocked(`carrier registration state unreadable: ${(e as Error).message}`, { ...emailEv, numbers: numbers.length }) }
    const profile = await (c.deps.a2pProfile ?? (async (s, b) => (await import("@/lib/voice/a2p-registration")).resolveA2pProfile(s, b)))(c.svc, c.b)
    const view = carrierRegistrationPhase(state, numbers, profile.ok ? [] : (profile.missing ?? []))
    const ev = { ...emailEv, numbers: numbers.length, carrierPhase: view.phase, testUnlocked: view.testUnlocked }
    switch (view.phase) {
      case "approved": return pass("email defaults present; carrier registration approved (phone test unlocked)", ev)
      case "carrier_review": return waiting("carrier registration submitted — waiting on Twilio / TCR / carrier review; never claimed approved before the provider confirms", ev)
      case "filing": return repairable("carrier registration has steps left to submit — run the owning registration loop (advanceTenantCarrier)", "sync_carrier_registration", {}, ev)
      case "needs_input": case "rejected": return blocked(`carrier registration ${view.phase.replace("_", " ")} — ${view.needs.join("; ").slice(0, 300)}; a human supplies / corrects the business profile`, { ...ev, needs: view.needs.slice(0, 5) })
      default: return blocked(`carrier registration phase ${view.phase} with numbers present`, ev)
    }
  },

  billing: async (c) => {
    const bm = c.brk?.billing_metadata ?? null
    const bmCustomer = bm && typeof bm === "object" ? (bm as Record<string, unknown>).stripe_customer_id : null
    const customer = c.sub?.stripe_customer_id ?? (typeof bmCustomer === "string" ? bmCustomer : null)
    if (customer) return pass(`Stripe customer linked${c.sub?.stripe_subscription_id ? " + subscription id" : ""}`, { stripeCustomer: true, stripeSubscription: !!c.sub?.stripe_subscription_id })
    if (c.access?.state === "trialing") return notApplicable("trial — the Stripe customer attaches at activation; a trial never requires it", { stripeCustomer: false, state: "trialing" })
    return blocked(`subscription ${c.access?.state ?? "unknown"} with no Stripe linkage — a money object; Finance reconciles (read-only diagnosis, never auto-linked)`, { stripeCustomer: false, state: c.access?.state ?? null })
  },

  providerState: async (c) => {
    const r = await (c.deps.providerReadiness ?? (async (s, b) => (await import("@/lib/platform/provider-posture")).getBrokerageProviderReadiness(s, b)))(c.svc, c.b)
    const darkRequired = r.rows.filter((x) => !x.ready && x.state === "platform_dark" && REQUIRED_PROVIDER_CATEGORIES.has(x.category))
    const ev = { ready: r.ready, needsConnection: r.needsConnection, platformDark: r.platformDark, readinessPct: r.readinessPct, darkRequired: darkRequired.map((x) => x.provider) }
    if (darkRequired.length) return blocked(`required provider lane(s) dark at the platform level: ${darkRequired.map((x) => `${x.provider} (${x.category})`).join(", ")} — platform staff light them; nothing the tenant can do`, ev)
    return pass(`${r.ready}/${r.rows.length} provider lanes usable now; ${r.needsConnection} optional lane(s) the tenant may connect`, ev)
  },

  requiredSecurityState: async (c) => {
    const configured = c.deps.encryptionConfigured ? c.deps.encryptionConfigured() : (await import("@/lib/security/secret-crypto")).isEncryptionConfigured()
    if (!configured) return blocked("secrets encryption key absent — provider credential writes refuse (fail closed); a platform production blocker, never auto-remediated", { secretsEncryption: false })
    return pass("secrets encryption configured (credential writes encrypt at rest)", { secretsEncryption: true })
  },
}

async function defaultSeatPosture(svc: Svc, brokerageId: string, tier: string, seatOverride: number | null) {
  const { resolveSeatUsage, resolveCatalogSeatLimits, resolveTenantSeatTerms } = await import("@/lib/kernel/seat-usage")
  const { effectiveSeatLimit } = await import("@/lib/kernel/tier-role-matrix")
  const [usage, catalog, terms] = await Promise.all([resolveSeatUsage(svc, brokerageId), resolveCatalogSeatLimits(svc), resolveTenantSeatTerms(svc, brokerageId)])
  if (!usage.ok) return { ok: false, seatCount: 0, limit: null, error: "seat count refused" }
  if (!catalog.ok) return { ok: false, seatCount: usage.seatCount, limit: null, error: catalog.error ?? "catalogue refused" }
  if (!terms.ok) return { ok: false, seatCount: usage.seatCount, limit: null, error: terms.error ?? "seat terms refused" }
  return { ok: true, seatCount: usage.seatCount, limit: effectiveSeatLimit(tier, seatOverride, catalog.limits, terms.terms).limit, error: null }
}

// ── 4. The evaluator ──────────────────────────────────────────────────────────────────────────

async function loadCtx(svc: Svc, b: string, deps: ReadinessDeps): Promise<Ctx> {
  const now = (deps.now ?? (() => new Date()))()
  const { data: brk, error } = await svc.from("brokerages")
    .select("id, name, slug, plan_tier, deleted_at, archived_at, onboarding_status, ai_isa_system_user_id, email, billing_metadata").eq("id", b).maybeSingle()
  const row = error ? null : ((brk as BrokerageRow | null) ?? null)
  const tier = row && isCanonicalTier(row.plan_tier) ? row.plan_tier : null
  let sub: SubRow | null = null, access: Ctx["access"] = null, gs: Ctx["gs"] = undefined
  if (row) {
    const [subRes, gsRes] = await Promise.all([
      svc.from("subscriptions").select("id, tier_id, status, stripe_customer_id, stripe_subscription_id").eq("brokerage_id", b).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      svc.from("global_settings").select("id, timezone, date_format, currency_symbol, app_name, from_email, from_name").eq("brokerage_id", b).maybeSingle(),
    ])
    sub = subRes.error ? null : ((subRes.data as SubRow | null) ?? null)
    gs = gsRes.error ? undefined : ((gsRes.data as Record<string, unknown> | null) ?? null)
    try {
      const { loadBillingAccess } = await import("@/lib/billing/billing-access")
      const a = await loadBillingAccess(svc, b, now)
      access = { state: a.state, reason: a.reason, trialDaysLeft: a.trialDaysLeft }
    } catch (e) { access = null; console.error(`[tenant-readiness] billing access unreadable for ${b}: ${(e as Error).message}`) }
  }
  return { svc, b, now, deps, brk: row, tier, sub, access, gs }
}

async function runCheck(key: ReadinessKey, c: Ctx): Promise<ReadinessCheck> {
  const lastChecked = c.now.toISOString()
  const base = { key, owner: READINESS_OWNER[key], required: REQUIRED.has(key), lastChecked }
  if (!c.brk && key !== "tenantCore") return { ...base, status: "BLOCKED", reason: "tenant row unresolved — see tenantCore", evidence: {}, remediation: null }
  try {
    return { ...base, ...(await CHECKS[key](c)) }
  } catch (e) {
    // A check that THREW is unreadable, never "checked and fine" (fail closed).
    return { ...base, status: "BLOCKED", reason: `check threw: ${(e as Error).message}`.slice(0, 400), evidence: {}, remediation: null }
  }
}

/** PURE — the READY rule: every required check PASS or NOT_APPLICABLE. Never a score. */
/** @proofSeam the proof drives READY true/false through this rule */
export function readinessVerdict(checks: readonly ReadinessCheck[]): { ready: boolean; blockers: string[] } {
  const open = checks.filter((c) => c.required && c.status !== "PASS" && c.status !== "NOT_APPLICABLE")
  return { ready: checks.length > 0 && open.length === 0, blockers: open.map((c) => `${c.key}: ${c.status} — ${c.reason}`) }
}

/**
 * THE CONTRACT. Evaluate every key for ONE tenant (tenant from the caller's SESSION — the doors pass
 * the session tenant; a service caller passes the tenant it is sweeping). With `repair`, each
 * REPAIRABLE check's declared playbook runs through the self-healing engine and the check is re-run.
 */
export async function evaluateTenantReadiness(svc: Svc, brokerageId: string, opts: { repair?: boolean; deps?: ReadinessDeps } = {}): Promise<TenantReadinessReport> {
  const deps = opts.deps ?? {}
  const checkedAt = (deps.now ?? (() => new Date()))().toISOString()
  if (!UUID_RE.test(String(brokerageId ?? ""))) {
    const checks = READINESS_KEYS.map((key): ReadinessCheck => ({ key, status: "BLOCKED", required: true, reason: "no tenant id — refused", evidence: {}, owner: READINESS_OWNER[key], lastChecked: checkedAt, remediation: null }))
    return { brokerageId: String(brokerageId ?? ""), ready: false, checkedAt, checks, blockers: readinessVerdict(checks).blockers }
  }
  const ctx = await loadCtx(svc, brokerageId, deps)
  const checks: ReadinessCheck[] = []
  for (const key of READINESS_KEYS) checks.push(await runCheck(key, ctx))

  let repairs: ReadinessRepairOutcome[] | undefined
  if (opts.repair) {
    repairs = []
    for (let i = 0; i < checks.length; i++) {
      const check = checks[i]
      if (check.status !== "REPAIRABLE" || !check.remediation) continue
      const outcome = await repairReadinessCheck(svc, brokerageId, check, deps)
      // RE-VERIFY — the check is re-run against a FRESH context (the repair may have changed the rows it reads).
      const fresh = await loadCtx(svc, brokerageId, deps)
      const after = await runCheck(check.key, fresh)
      checks[i] = after
      repairs.push({ ...outcome, after: after.status })
    }
  }
  const verdict = readinessVerdict(checks)
  return { brokerageId, ready: verdict.ready, checkedAt, checks, blockers: verdict.blockers, ...(repairs ? { repairs } : {}) }
}

// ── 5. Routing a REPAIRABLE check through the self-healing engine ────────────────────────────

/** The os-health incident shape for one REPAIRABLE check (the supervisor's retry rail + runDeclaredPlaybook read it). */
/** @proofSeam the proof asserts the incident is transient + idempotent and carries the declared remediation */
export function readinessIncident(brokerageId: string, check: ReadinessCheck): HealthIncident {
  return {
    detector: "tenant_readiness", class: "transient", brokerageId,
    subjectKey: `readiness:${check.key}`, subjectId: null, subjectType: "tenant_readiness_check",
    summary: `tenant readiness: ${check.key} is REPAIRABLE — ${check.reason}`.slice(0, 400),
    idempotent: true, retryOwner: null,
    evidence: { check: check.key, remediation: check.remediation, ...check.evidence },
  }
}

/** How many declared-playbook runs this subject already had in 24h (self_heal_events os_health_playbook:* rows). */
async function playbookAttempts24h(svc: Svc, i: HealthIncident, now: Date): Promise<number> {
  const { data, error } = await svc.from("self_heal_events").select("id, action").eq("brokerage_id", i.brokerageId)
    .eq("subject", `os_health:${i.detector}:${i.subjectKey}`).gte("created_at", new Date(now.getTime() - 24 * 3_600_000).toISOString()).limit(200)
  if (error) return Number.MAX_SAFE_INTEGER // unreadable → treated as exhausted (fail closed: nothing runs)
  return ((data ?? []) as Array<{ action: string }>).filter((r) => String(r.action).startsWith("os_health_playbook:")).length
}

async function repairReadinessCheck(svc: Svc, brokerageId: string, check: ReadinessCheck, deps: ReadinessDeps): Promise<Omit<ReadinessRepairOutcome, "after">> {
  const now = (deps.now ?? (() => new Date()))()
  const i = readinessIncident(brokerageId, check)
  const attempts = await playbookAttempts24h(svc, i, now)
  const { runDeclaredPlaybook } = await import("@/lib/kernel/self-healing")
  const r = await runDeclaredPlaybook(svc, i, check.remediation!, { playbookAttempts24h: attempts, cycle: deps.cycle ?? now.toISOString().slice(0, 16), attempt: attempts + 1 }, deps.healing ?? {})
  if (r.kind === "escalate") return { key: check.key, playbook: check.remediation!.playbook, ran: false, ok: false, escalated: true, outcome: r.reason }
  return { key: check.key, playbook: r.playbook, ran: true, ok: r.ok, escalated: false, outcome: r.outcome }
}

/** The os-health supervisor's RETRY for a tenant_readiness incident (lib/kernel/os-health.ts defaultRetry). */
export async function retryReadinessRepair(svc: Svc, i: HealthIncident, deps: ReadinessDeps = {}): Promise<{ ok: boolean; outcome: string }> {
  const rem = (i.evidence as { remediation?: { playbook?: string; params?: Record<string, unknown> } | null }).remediation
  if (!rem?.playbook) return { ok: false, outcome: "readiness incident carries no declared remediation — nothing runs" }
  const now = (deps.now ?? (() => new Date()))()
  const attempts = await playbookAttempts24h(svc, i, now)
  const { runDeclaredPlaybook } = await import("@/lib/kernel/self-healing")
  const r = await runDeclaredPlaybook(svc, i, { playbook: rem.playbook, params: rem.params ?? {} }, { playbookAttempts24h: attempts, cycle: deps.cycle ?? now.toISOString().slice(0, 16), attempt: attempts + 1 }, deps.healing ?? {})
  if (r.kind === "escalate") return { ok: false, outcome: r.reason }
  return { ok: r.ok, outcome: `${r.playbook}: ${r.outcome}` }
}

// ── 6. Absent-defaults-only snapshot application (the repair rule) ───────────────────────────

export const SNAPSHOT_LAYERS = ["global", "brand", "voice", "features"] as const
export type SnapshotLayer = (typeof SNAPSHOT_LAYERS)[number]

interface ExistingSnapshotState {
  global: Record<string, unknown> | null
  brand: Record<string, unknown> | null
  /** A brokerage-level active voice row exists → the voice layer is the tenant's, never replaced. */
  voiceExists: boolean
  /** Feature keys that already carry a brokerage-level override. */
  featureKeys: ReadonlySet<string>
}

const isAbsent = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "")

/** The four repairable layers, always present on a filtered payload (the site layer is never part of a repair). */
type FilledSnapshotPayload = Required<Pick<SnapshotPayload, "global" | "brand" | "voice" | "features">>

/**
 * PURE — THE NEVER-OVERWRITE RULE. Keep only the snapshot keys the tenant has NOT set: a present value
 * (even one equal to the default) is the tenant's and stays; the voice layer is skipped entirely when
 * the tenant has an active brokerage voice; a feature override that exists is never re-applied.
 * @proofSeam the proof drives a customized row against a different default and asserts the default is dropped
 */
export function fillAbsentDefaults(payload: SnapshotPayload, existing: ExistingSnapshotState, layers: readonly SnapshotLayer[]): { payload: FilledSnapshotPayload; kept: Record<SnapshotLayer, string[]>; skipped: string[] } {
  const out: FilledSnapshotPayload = { global: {}, brand: {}, voice: {}, features: [] }
  const kept: Record<SnapshotLayer, string[]> = { global: [], brand: [], voice: [], features: [] }
  const skipped: string[] = []
  const pick = (src: Record<string, unknown> | undefined, row: Record<string, unknown> | null, layer: "global" | "brand") => {
    for (const [k, v] of Object.entries(src ?? {})) {
      if (isAbsent(v)) continue
      if (row && !isAbsent(row[k])) { skipped.push(`${layer}.${k}`); continue }
      out[layer][k] = v
      kept[layer].push(k)
    }
  }
  if (layers.includes("global")) pick(payload.global, existing.global, "global")
  if (layers.includes("brand")) pick(payload.brand, existing.brand, "brand")
  if (layers.includes("voice")) {
    if (existing.voiceExists) skipped.push("voice.*")
    else { out.voice = { ...(payload.voice ?? {}) }; kept.voice = Object.keys(payload.voice ?? {}) }
  }
  if (layers.includes("features")) {
    for (const f of payload.features ?? []) {
      if (existing.featureKeys.has(f.feature_key)) { skipped.push(`features.${f.feature_key}`); continue }
      out.features.push(f); kept.features.push(f.feature_key)
    }
  }
  // The site layer is never part of a repair: it shapes identity-adjacent brokerage fields the tenant owns.
  return { payload: out, kept, skipped }
}

/**
 * Apply the tier's canonical snapshot to ONE tenant, ABSENT KEYS ONLY, through the ONE snapshot writer
 * (lib/platform/config-snapshots.ts applySnapshotPayload). Idempotent: a second run keeps nothing.
 * The acting user is the tenant's AI-ISA system actor, else its first admin (feature overrides need a creator).
 */
export async function applyAbsentSnapshotDefaults(svc: Svc, brokerageId: string, layers: readonly SnapshotLayer[], deps: Pick<ReadinessDeps, "snapshotForTier"> = {}): Promise<{ ok: boolean; applied: string[]; refused: string[]; kept: Record<SnapshotLayer, string[]>; skipped: string[]; snapshot: { id: string; name: string } | null; error: string | null }> {
  const none: Record<SnapshotLayer, string[]> = { global: [], brand: [], voice: [], features: [] }
  if (!UUID_RE.test(brokerageId)) return { ok: false, applied: [], refused: [], kept: none, skipped: [], snapshot: null, error: "no tenant id — refused" }
  const { data: brk, error } = await svc.from("brokerages").select("id, plan_tier, ai_isa_system_user_id").eq("id", brokerageId).maybeSingle()
  if (error || !brk) return { ok: false, applied: [], refused: [], kept: none, skipped: [], snapshot: null, error: `brokerage unreadable: ${error?.message ?? "no row"}` }
  const tier = (brk as { plan_tier?: string | null }).plan_tier ?? null
  if (!isCanonicalTier(tier)) return { ok: false, applied: [], refused: [], kept: none, skipped: [], snapshot: null, error: `plan_tier ${tier ?? "null"} is not canonical` }
  const snap = await (deps.snapshotForTier ?? (async (t, s) => (await import("@/lib/platform/trial-funnel")).snapshotForTier(t, s)))(tier, svc)
  if (!snap) return { ok: false, applied: [], refused: [], kept: none, skipped: [], snapshot: null, error: `no canonical snapshot for the ${tier} tier` }
  const [gs, bs, voice, overrides] = await Promise.all([
    svc.from("global_settings").select("*").eq("brokerage_id", brokerageId).maybeSingle(),
    svc.from("brokerage_brand_settings").select("*").eq("brokerage_id", brokerageId).maybeSingle(),
    svc.from("brand_voice_profile").select("id").eq("brokerage_id", brokerageId).is("agent_id", null).is("team_id", null).eq("is_active", true).limit(1),
    svc.from("feature_access_overrides").select("feature_key").eq("brokerage_id", brokerageId).is("user_id", null).is("team_id", null).limit(500),
  ])
  const firstErr = gs.error ?? bs.error ?? voice.error ?? overrides.error
  if (firstErr) return { ok: false, applied: [], refused: [], kept: none, skipped: [], snapshot: { id: snap.id, name: snap.name }, error: `tenant state unreadable: ${firstErr.message} — nothing applied (a refused read is never "absent")` }
  const existing: ExistingSnapshotState = {
    global: (gs.data as Record<string, unknown> | null) ?? null, brand: (bs.data as Record<string, unknown> | null) ?? null,
    voiceExists: ((voice.data ?? []) as unknown[]).length > 0,
    featureKeys: new Set(((overrides.data ?? []) as Array<{ feature_key: string }>).map((o) => o.feature_key)),
  }
  const filtered = fillAbsentDefaults(snap.payload, existing, layers)
  let actor = (brk as { ai_isa_system_user_id?: string | null }).ai_isa_system_user_id ?? null
  if (!actor) {
    const { data: admin } = await svc.from("users").select("id").eq("brokerage_id", brokerageId).is("deleted_at", null).in("user_type", [...TENANT_ADMIN_USER_TYPES]).order("created_at", { ascending: true }).limit(1).maybeSingle()
    actor = (admin as { id?: string } | null)?.id ?? null
  }
  if (!actor && filtered.payload.features.length) { filtered.skipped.push("features.* (no acting user on the tenant)"); filtered.payload.features = [] }
  const { applySnapshotPayload } = await import("@/lib/platform/config-snapshots")
  const r = await applySnapshotPayload(filtered.payload, brokerageId, actor ?? brokerageId, svc)
  return { ok: r.refused.length === 0, applied: r.applied, refused: r.refused, kept: filtered.kept, skipped: filtered.skipped, snapshot: { id: snap.id, name: snap.name }, error: r.refused.length ? r.refused.join("; ") : null }
}
