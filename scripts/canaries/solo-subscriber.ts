/**
 * scripts/canaries/solo-subscriber.ts — SOLO SUBSCRIBER canary (wave 141, lane 141J):
 *   independent agent subscribes → declares a brokerage NAME for context → own tenant → READY
 * through the ONE provisioner (lib/kernel/tenant-creation.ts createTenantCore, tier solo_agent →
 * lib/kernel/users.ts provisionTenantOwner) and the ONE readiness contract (lib/kernel/tenant-readiness.ts).
 * Owner (wave 141): "a solo agent/team may subscribe independently and DECLARE an affiliated brokerage name
 * for business context — the brokerage is not a subscriber, the location is not on the platform …
 * BROKERAGE NAME MATCH IS NEVER PROOF OF SAME TENANT." At HEAD the declared name is brokerages.name on the
 * solo's OWN row with brokerage_on_platform / team_on_platform = false (platformMembershipFlags); the
 * structured declaration (declared_affiliation, lane 141A) is a WAVE141 HOOK.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor } from "./_registry"

export async function run() {
  const c = canary("Solo subscriber: independent agent → brokerage-name context → own tenant → READY")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: provisioning invites an auth user (an outbound email) — in-memory only")
  const TIER = uuid(), SNAP = uuid()
  // The brokerage the agent hangs their license with — NOT a subscriber, NOT on the platform.
  const AFFILIATED = `${CANARY_TAG} Harbor Realty`
  const svc = canaryClient({
    subscription_tiers: [{ id: TIER, tier_name: "solo_agent", is_active: true, display_name: "Solo Agent" }],
    platform_config_snapshots: [{ id: SNAP, name: `${CANARY_TAG} solo snapshot`, created_at: nowIso(), payload: { recommendedTier: "solo_agent", global: { timezone: "America/Chicago" }, brand: { tagline: `${CANARY_TAG} tagline`, accent_color: "#0f766e" }, voice: { tone: "warm", tagline: `${CANARY_TAG} voice` } } }],
    // feature_flags' per-tier access columns are solo_agent_access … multi_location_access (READINESS-MATRIX, feature flags row).
    feature_flags: [{ id: uuid(), feature_key: `${CANARY_TAG}_crm`, enabled: true, brokerage_access: true, team_access: true, enterprise_access: true, solo_agent_access: true, multi_location_access: true }],
  })
  setSvc(svc)
  const { createTenantCore, platformMembershipFlags } = await import("../../lib/kernel/tenant-creation")
  const input = {
    brokerageName: AFFILIATED, adminEmail: `solo@${CANARY_EMAIL_DOMAIN}`, adminFirstName: "Canary", adminLastName: "Solo",
    tier: "solo_agent" as const, signupSource: "self_serve" as const, billing: { mode: "trial" as const },
    brokerageOnPlatform: false, teamOnPlatform: false, snapshotId: SNAP, callerUserId: null, redirectTo: "/dashboard/onboarding",
  }
  const r = await createTenantCore(svc, input)
  c.step("subscribe: createTenantCore(solo_agent, self-serve trial) mints the agent's OWN tenant", r.ok && !!r.brokerageId, r.error ?? `brokerage ${r.brokerageId} slug ${r.slug}`)
  const B = r.brokerageId ?? null
  const brokerage = svc.tables.brokerages?.find((x) => x.id === B)
  c.step("context: the declared brokerage name is CONTEXT on the solo's own row — brokerage_on_platform=false, team_on_platform=false (platformMembershipFlags)", !!brokerage && brokerage.name === AFFILIATED && brokerage.brokerage_on_platform === false && brokerage.team_on_platform === false && brokerage.plan_tier === "solo_agent", JSON.stringify(platformMembershipFlags(input)))
  c.step("context: declaring a brokerage mints NO second tenant and NO membership — exactly one brokerages row, the solo's", (svc.tables.brokerages ?? []).length === 1, `${(svc.tables.brokerages ?? []).length} brokerages`)
  const owner = svc.tables.users?.find((u) => u.id === r.userId)
  c.step("owner: a solo owner is the PRODUCING seat — users row pinned to the tenant + an agents row (tenant-provisioning-spec requiresAgentRow)", !!owner && owner.brokerage_id === B && (svc.tables.agents ?? []).some((a) => a.user_id === r.userId && a.brokerage_id === B), `user ${r.userId}`)
  const subs = (svc.tables.subscriptions ?? []).filter((s) => s.brokerage_id === B)
  c.step("subscription: ONE trialing row with trial_end written (trial is a STATE on the same path, never a second architecture)", subs.length === 1 && subs[0].status === "trialing" && !!subs[0].trial_end, `status ${subs[0]?.status} trial_end ${String(subs[0]?.trial_end).slice(0, 10)}`)
  c.step("website: the solo's storefront is provisioned by the slug (/site/<slug>) — no custom domain required", !!r.slug && r.websitePath === `/site/${r.slug}`, r.websitePath ?? "")
  const { evaluateTenantReadiness } = await import("../../lib/kernel/tenant-readiness")
  const readiness = await evaluateTenantReadiness(svc, B!, { repair: false })
  const status = (k: string) => readiness.checks.find((x) => x.key === k)?.status ?? "MISSING"
  const owned = ["tenantCore", "subscription", "plan", "adminUser", "website", "settings", "seats"]
  c.step("readiness: every check the solo creation path owns PASSES (tenantCore, subscription, plan, adminUser, website, settings, seats)", owned.every((k) => status(k) === "PASS"), owned.map((k) => `${k}=${status(k)}`).join(" "))
  const tenantBlockers = readiness.checks.filter((x) => x.owner !== "platform" && x.required && x.status !== "PASS" && x.status !== "NOT_APPLICABLE")
  const platformBlockers = readiness.checks.filter((x) => x.owner === "platform" && x.status === "BLOCKED")
  c.step(`READY: tenant side ${tenantBlockers.length === 0 ? "READY" : "NOT READY"} — ${tenantBlockers.length} tenant blocker(s); ${platformBlockers.length} platform-configuration blocker(s)`, tenantBlockers.length === 0, [...tenantBlockers.map((x) => `${x.key}: ${x.reason}`), ...platformBlockers.map((x) => `[platform] ${x.key}: ${x.reason}`)].join("; ").slice(0, 500) || "READY")
  if (platformBlockers.length) c.blind(`platform configuration still required for a READY verdict: ${platformBlockers.map((x) => x.key).join(", ")} (env-bound — the release checklist, not the tenant).`)
  // WAVE141 HOOK (integrator): 141A — the structured declaration. When the lane lands, the integrator
  // passes its declaration input here; the invariant this canary holds is that it mints nothing.
  for (const h of hooksFor("solo-subscriber")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract); continue }
    c.step(`${h.lane} landed (${at}): a declared affiliation is a column the core writes on the solo's OWN row and still mints nothing — one tenant, no membership`, (svc.tables.brokerages ?? []).length === 1 && !!brokerage, `declared_affiliation=${JSON.stringify(brokerage?.declared_affiliation ?? null).slice(0, 120)}`)
  }
  c.blind("Supabase Auth is stubbed: the invite email is never sent; the on_auth_user_created trigger is modelled in the canary client.")
  c.blind("The declared brokerage is a NAME here (brokerages.name on the solo's row); nothing at HEAD reads it as a key — proven by the same-name-brokerage canary's source rule.")
  c.blind("extrasSkipped reported by the core: " + (r.extrasSkipped.join(",") || "none") + " — best-effort day-one extras that need providers.")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, `${cleanup.map((x) => `${x.table}:${x.deleted}`).join(" ")}${mismatches.length ? ` MISMATCH ${mismatches.join("; ")}` : ""}`)
  return c.report(cleanup, residual)
}
