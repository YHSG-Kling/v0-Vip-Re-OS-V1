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
    platform_config_snapshots: [{ id: SNAP, name: `${CANARY_TAG} snapshot`, payload: { global: { timezone: "America/Chicago" }, brand: { primary_color: "#0f766e" } } }],
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
  c.step("idempotency: the same owner email a second time is REFUSED (never a duplicate tenant)", !again.ok && (svc.tables.brokerages ?? []).filter((x) => x.name === input.brokerageName).length === 1, again.error ?? "created twice")
  // READINESS HOOK (integrator): replace the proxy below with
  //   const readiness = await evaluateTenantReadiness(svc, B!, { repair: false })
  //   c.step("READY: every required ReadinessCheck PASS", readiness.ready, readiness.blockers.join("; "))
  // once lib/kernel/tenant-readiness.ts (lane 140B) is merged — do not import it before.
  c.step("READY (pre-contract proxy): tenantCore, subscription, snapshot, website, adminUser all PASS", c.allOk(), "replaced by evaluateTenantReadiness at merge")
  c.blind("Supabase Auth is stubbed: the invite email is never sent; the on_auth_user_created trigger is modelled in the canary client.")
  c.blind("Stripe is never called (billing mode active = staff-invoiced); the paid/trial doors are proven by subscriber-door-simulator, not here.")
  c.blind("extrasSkipped reported by the core: " + (r.extrasSkipped.join(",") || "none") + " — best-effort day-one extras that need providers.")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, `${cleanup.map((x) => `${x.table}:${x.deleted}`).join(" ")}${mismatches.length ? ` MISMATCH ${mismatches.join("; ")}` : ""}`)
  return c.report(cleanup, residual)
}
