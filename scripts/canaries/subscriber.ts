/**
 * scripts/canaries/subscriber.ts — SUBSCRIBER canary:
 *   create → provision → snapshot → website → admin → entitlement → READY
 * through the ONE canonical provisioner (lib/kernel/tenant-creation.ts createTenantCore →
 * lib/kernel/users.ts provisionTenantOwner → lib/platform/config-snapshots.ts
 * applySnapshotPayload) with Supabase Auth stubbed (the invite is outbound email).
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, setSvc, uuid } from "./_harness"

export async function run() {
  const c = canary("Subscriber: create → provision → snapshot → website → admin → entitlement → READY")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: provisioning invites an auth user (an outbound email) — in-memory only")
  const TIER = uuid(), STAFF = uuid(), SNAP = uuid()
  const svc = canaryClient({
    subscription_tiers: [{ id: TIER, tier_name: "brokerage", is_active: true, display_name: "Brokerage" }],
    users: [{ id: STAFF, email: `staff@${CANARY_EMAIL_DOMAIN}`, platform_role: "superadmin", user_type: "admin", brokerage_id: null }],
    // The PLATFORM CATALOGUE a real platform carries: the tier's canonical snapshot (payload.recommendedTier is how
    // snapshotForTier finds it) and a feature the tier is entitled to — without them the tenant-side verdict cannot be READY.
    platform_config_snapshots: [{ id: SNAP, name: `${CANARY_TAG} snapshot`, created_at: new Date().toISOString(), payload: { recommendedTier: "brokerage", global: { timezone: "America/Chicago" }, brand: { tagline: `${CANARY_TAG} tagline`, accent_color: "#0f766e" }, voice: { tone: "warm", tagline: `${CANARY_TAG} voice` } } }],
    feature_flags: [{ id: uuid(), feature_key: `${CANARY_TAG}_crm`, enabled: true, brokerage_access: true, team_access: true, enterprise_access: true, solo_access: true }],
  })
  setSvc(svc)
  const { createTenantCore, tenantWebsitePath } = await import("../../lib/kernel/tenant-creation")
  const input = {
    brokerageName: `${CANARY_TAG} Brokerage`, adminEmail: `owner@${CANARY_EMAIL_DOMAIN}`, adminFirstName: "Canary", adminLastName: "Owner",
    tier: "brokerage" as const, signupSource: "superadmin" as const, billing: { mode: "active" as const, billingCycle: "monthly" as const },
    snapshotId: SNAP, callerUserId: STAFF, redirectTo: "/dashboard/onboarding",
  }
  const r = await createTenantCore(svc, input)
  c.step("create: createTenantCore (staff door, active subscription, no Stripe) returns ok", r.ok, r.error ?? `brokerage ${r.brokerageId} slug ${r.slug}`)
  const B = r.brokerageId ?? null
  const brokerage = svc.tables.brokerages?.find((x) => x.id === B)
  const sub = svc.tables.subscriptions?.find((s) => s.brokerage_id === B)
  c.step("provision: brokerages row (signup_source superadmin) + subscriptions row status active", !!brokerage && brokerage.signup_source === "superadmin" && sub?.status === "active", `subscription ${sub?.id ?? "none"}${r.subscriptionError ? ` err=${r.subscriptionError}` : ""}`)
  c.step("snapshot: the staff-picked snapshot applied — global_settings + brand rows land on THIS tenant", (r.snapshotApplied ?? []).includes("global_settings") && !!svc.tables.global_settings?.some((g) => g.brokerage_id === B && g.timezone === "America/Chicago") && !!svc.tables.brokerage_brand_settings?.some((g) => g.brokerage_id === B), `applied=${JSON.stringify(r.snapshotApplied)} name=${r.snapshotName}${r.snapshotError ? ` err=${r.snapshotError}` : ""}`)
  c.step("website: websitePath === tenantWebsitePath(slug) and the slug is unique across brokerages", !!r.slug && r.websitePath === tenantWebsitePath(r.slug) && (svc.tables.brokerages ?? []).filter((x) => x.slug === r.slug).length === 1, r.websitePath ?? "no path")
  const owner = svc.tables.users?.find((u) => u.id === r.userId)
  c.step("admin: owner users.id === auth id, pinned to the tenant, user_type admin", !!owner && owner.brokerage_id === B && owner.user_type === "admin", `user ${r.userId}`)
  c.step("admin: RBAC grant (user_role_assignments) for the owner on this brokerage", !!svc.tables.user_role_assignments?.some((g) => g.user_id === r.userId && g.brokerage_id === B), "")
  c.step("admin: a brokerage-tier owner is a pure admin — NO agents row (tenant-provisioning-spec)", !(svc.tables.agents ?? []).some((a) => a.user_id === r.userId), "")
  const { mayUseAndAfford } = await import("../../lib/billing/billing-access")
  const ent = await mayUseAndAfford({ brokerageId: B, capability: "lead.scrape", client: svc })
  c.step("entitlement: mayUseAndAfford answers for the new tenant (a boolean read from its rows, never assumed)", typeof ent.allowed === "boolean", JSON.stringify(ent).slice(0, 180))
  // emitKernelEvent's one table is lifecycle_events (lib/kernel/emit.ts) — the subscription.created
  // hook the onboarding curriculum and every downstream reactor key on.
  const evidence = (svc.tables.lifecycle_events ?? []).filter((e) => e.brokerage_id === B).map((e) => String(e.event_type))
  c.step("evidence: the creation emitted kernel events on THIS tenant (lifecycle_events, incl. subscription created)", evidence.length > 0 && evidence.some((e) => /subscription/i.test(e)), `events=${evidence.join(",") || "none"}`)
  const again = await createTenantCore(svc, input)
  // A complete record is REFUSED as a duplicate owner; an incomplete one (a best-effort step needing a provider
  // failed in-memory) RESUMES the SAME brokerage — either way never a second tenant.
  c.step("idempotency: the same owner email a second time never mints a second tenant (refused as duplicate, or resumes the same brokerage id)", (!again.ok || again.brokerageId === B) && (svc.tables.brokerages ?? []).filter((x) => x.name === input.brokerageName).length === 1, again.ok ? `resumed ${again.brokerageId}${again.provisioning?.completed_at ? "" : " (record still open: " + Object.entries(again.provisioning?.steps ?? {}).filter(([, v]) => (v as { status: string }).status === "failed").map(([k]) => k).join(",") + ")"}` : again.error ?? "")
  // THE READINESS CONTRACT (lib/kernel/tenant-readiness.ts): the verdict the creation stamped on the
  // provisioning record, then a fresh evaluation — the checks the creation path OWNS must PASS, and the
  // verdict is reported with its blockers (platform-catalogue blockers name what staff still configure).
  const { evaluateTenantReadiness } = await import("../../lib/kernel/tenant-readiness")
  const readiness = await evaluateTenantReadiness(svc, B!, { repair: false })
  const status = (k: string) => readiness.checks.find((x) => x.key === k)?.status ?? "MISSING"
  const owned = ["tenantCore", "subscription", "plan", "adminUser", "website", "settings", "seats"]
  c.step("readiness: every check the creation path owns PASSES (tenantCore, subscription, plan, adminUser, website, settings, seats)", owned.every((k) => status(k) === "PASS"), owned.map((k) => `${k}=${status(k)}`).join(" "))
  c.step("readiness: the creation stamped the SAME verdict on the provisioning record (billing_metadata.provisioning.readiness)", !!r.readiness && typeof r.readiness.ready === "boolean" && r.readiness.ready === readiness.ready, `record.ready=${String(r.readiness?.ready)} fresh.ready=${String(readiness.ready)}`)
  c.step("readiness: no check is BLOCKED by a REFUSED read (an unreadable row is a blocker that names itself, never silence)", !readiness.checks.some((x) => x.status === "BLOCKED" && /unreadable|refused/i.test(x.reason)), readiness.checks.filter((x) => x.status !== "PASS").map((x) => `${x.key}=${x.status}`).join(" ") || "all PASS")
  // THE VERDICT. Tenant-side (every check a manager owns) must be clear — that is what the creation path
  // certifies. A PLATFORM-owned blocker (provider lanes dark, secrets key absent) is production
  // configuration the owner performs; the canary reports it by name and does not call it a tenant defect.
  const tenantBlockers = readiness.checks.filter((x) => x.owner !== "platform" && x.required && x.status !== "PASS" && x.status !== "NOT_APPLICABLE")
  const platformBlockers = readiness.checks.filter((x) => x.owner === "platform" && x.status === "BLOCKED")
  c.step(`verdict: tenant side ${tenantBlockers.length === 0 ? "READY" : "NOT READY"} — ${tenantBlockers.length} tenant blocker(s); ${platformBlockers.length} platform-configuration blocker(s)`, tenantBlockers.length === 0, [...tenantBlockers.map((x) => `${x.key}: ${x.reason}`), ...platformBlockers.map((x) => `[platform] ${x.key}: ${x.reason}`)].join("; ").slice(0, 500) || "READY")
  if (platformBlockers.length) c.blind(`platform configuration still required for a READY verdict: ${platformBlockers.map((x) => x.key).join(", ")} (env-bound — the release checklist, not the tenant).`)
  c.blind("Supabase Auth is stubbed: the invite email is never sent; the on_auth_user_created trigger is modelled in the canary client.")
  c.blind("Stripe is never called (billing mode active = staff-invoiced); the paid/trial doors are proven by subscriber-door-simulator, not here.")
  c.blind("extrasSkipped reported by the core: " + (r.extrasSkipped.join(",") || "none") + " — best-effort day-one extras that need providers.")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, `${cleanup.map((x) => `${x.table}:${x.deleted}`).join(" ")}${mismatches.length ? ` MISMATCH ${mismatches.join("; ")}` : ""}`)
  return c.report(cleanup, residual)
}
