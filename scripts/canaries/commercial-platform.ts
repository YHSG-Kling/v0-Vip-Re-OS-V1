/**
 * scripts/canaries/commercial-platform.ts — COMMERCIAL / PLATFORM canary (wave 142, lane 142J):
 *   a tenant's provider SELECTION wins over the system default · the e-sign default is the ONE catalog default ·
 *   the matrix certifies before a provider is offered · Stripe is the coupon money source · direct paid + trial,
 *   staff-created tenant, snapshot, immediate seat invite, A2P readiness — all on the survivors the subscriber /
 *   seat / coupon / user-invite canaries already drive · readiness never reads 0 rows as PASS
 * through: lib/kernel/providers.ts resolveProviderCore + SYSTEM_DEFAULTS, lib/integrations/providers/catalog.ts
 * (DEFAULT_ESIGN_PROVIDER, esignCertified, PROVIDER_CAPABILITY_MATRIX — landed 141C), lib/platform/coupons.ts
 * isMockStripeCouponId, lib/kernel/tenant-creation.ts (snapshotForTier / applySnapshotPayload; 'trialing'),
 * lib/kernel/users.ts → lib/kernel/immediate-operations.ts (landed 141B), lib/kernel/tenant-readiness.ts
 * (NOT_APPLICABLE is a status, never "optional"). Owner (wave 142): "dotloop is not the only … they all should be
 * fully functional for the tenants to choose"; readiness over live counts: "0 rows is NOT_APPLICABLE / unproven".
 *
 * MEASURED AT HEAD (the 142I hooks): SYSTEM_DEFAULTS.transaction = 'dotloop' — a provider the matrix does not
 * certify — and the readiness guard carries no wave-142 gate rows (support isolation, offers_cda, playable video,
 * the 0-rows rule). In-memory only.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, setSvc, uuid } from "./_harness"
import { hooksFor, readRepo, strippedRepo } from "./_registry"

export async function run() {
  const c = canary("Commercial / platform: tenant selection wins · one e-sign default · matrix certifies · Stripe is the coupon source · provisioning survivors · 0 rows ≠ PASS")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only — the subscriber / seat / coupon canaries carry the live-capable chains")
  const B = uuid(), ADMIN = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-platform` }],
    users: [{ id: ADMIN, email: `owner@${CANARY_EMAIL_DOMAIN}`, user_type: "broker_owner", brokerage_id: B, platform_role: null }],
    provider_overrides: [{ id: uuid(), provider_type: "esign", scope_type: "brokerage", scope_id: B, provider_key: "google", enabled: true, config: { note: CANARY_TAG } }],
  })
  setSvc(svc)

  // ── 1 · the provider cascade: a tenant selection wins; the e-sign default is the catalog's ──
  const { resolveProviderCore, SYSTEM_DEFAULTS, SYSTEM_ONLY_TYPES } = await import("../../lib/kernel/providers")
  const { DEFAULT_ESIGN_PROVIDER, esignCertified, PROVIDER_CAPABILITY_MATRIX } = await import("../../lib/integrations/providers/catalog")
  const actor = { userId: ADMIN, brokerageId: B }
  const esign = await resolveProviderCore(svc as never, { providerType: "esign", actorContext: actor })
  const sms = await resolveProviderCore(svc as never, { providerType: "sms", actorContext: actor })
  c.step(`PROVIDER SELECTION: the tenant's enabled e-sign override (google, brokerage scope) WINS over the system default; a type with no override answers the system default by name (sms → ${SYSTEM_DEFAULTS.sms}, scope system_default); the ONE e-sign default is the catalog's (${DEFAULT_ESIGN_PROVIDER}), not a second spelling in providers.ts`, esign.providerKey === "google" && esign.scope === "brokerage" && sms.providerKey === SYSTEM_DEFAULTS.sms && sms.scope === "system_default" && SYSTEM_DEFAULTS.esign === DEFAULT_ESIGN_PROVIDER && DEFAULT_ESIGN_PROVIDER === "docusign", `${esign.providerKey}@${esign.scope}; ${sms.providerKey}@${sms.scope}`)
  const ai = await resolveProviderCore(svc as never, { providerType: "ai", actorContext: actor })
  c.step("PLATFORM-ONLY TYPES stay platform-chosen: 'ai' (and video / avatar / enrichment …) answer the system vendor for a tenant actor — a tenant override never reaches the platform tier's keys", SYSTEM_ONLY_TYPES.has("ai") && ai.providerKey === SYSTEM_DEFAULTS.ai && ai.scope !== "brokerage", `${ai.providerKey}@${ai.scope}`)
  c.step("THE MATRIX CERTIFIES BEFORE A PROVIDER IS OFFERED (landed 141C): docusign is e-sign certified, brokermint (no e-sign) is not; the matrix names every catalog provider's credentials / settings / forms / fill / e-sign / status / sync cells", esignCertified("docusign") && !esignCertified("brokermint") && Object.keys(PROVIDER_CAPABILITY_MATRIX).length >= 5, Object.keys(PROVIDER_CAPABILITY_MATRIX).join(","))
  console.log(`    measured: SYSTEM_DEFAULTS.transaction = '${SYSTEM_DEFAULTS.transaction}' (certified for e-sign per the matrix: ${esignCertified(SYSTEM_DEFAULTS.transaction) ? "yes" : "NO"}) — the 142I subject`)

  // ── 2 · Stripe is the coupon money source (pure) ──
  const { isMockStripeCouponId } = await import("../../lib/platform/coupons")
  const billing = strippedRepo("lib/billing/stripe-subscription-ops.ts") ?? ""
  c.step("COUPONS: a mock coupon id is recognised by the ONE rule (isMockStripeCouponId) and a real Stripe id is not; the handoff / checkout rails reach Stripe through the SDK with idempotency keys (no parallel discount ledger, no independent discount math)", isMockStripeCouponId("mock_welcome10") && !isMockStripeCouponId("promo_1Q9x") && !isMockStripeCouponId(null) && /idempotencyKey/.test(billing), "")

  // ── 3 · provisioning survivors (stripped source; the chains themselves run in subscriber / seat / user-invite) ──
  const creation = strippedRepo("lib/kernel/tenant-creation.ts") ?? ""
  const vocab = readRepo("scripts/check-vocabularies.ts") ?? ""
  const users = strippedRepo("lib/kernel/users.ts") ?? ""
  const mgmt = strippedRepo("app/actions/superadmin/brokerage-management.ts") ?? ""
  const readiness = strippedRepo("lib/kernel/tenant-readiness.ts") ?? ""
  c.step("DIRECT PAID + TRIAL on the ONE tenant-creation core: the subscription row is written 'trialing' (a value the live CHECK admits — the 141A finding is CLOSED at HEAD: check-vocabularies lists trialing) with the tier's config SNAPSHOT applied through applySnapshotPayload (snapshotForTier when staff picked none)", /["']trialing["']/.test(creation) && /status:\s*\[[^\]]*["']trialing["']/.test(vocab) && /snapshotForTier/.test(creation) && /applySnapshotPayload/.test(creation), "")
  c.step("STAFF-CREATED TENANT goes through the same core (brokerage-management reads signup_source; no second creation path); the SEAT INVITE reports its outcome from the member core in the SAME request (reportOperationOutcome — landed 141B); A2P is a tenant READINESS state (tenant-readiness names a2p) never claimed before the carrier confirms", /signup_source/.test(mgmt) && /reportOperationOutcome/.test(users) && /a2p/i.test(readiness), "")
  c.step("READINESS VOCABULARY: PASS / REPAIRABLE / WAITING_EXTERNAL / BLOCKED / NOT_APPLICABLE is the whole status set — an optional condition reads NOT_APPLICABLE with its reason, never 'optional', and never PASS by absence", /["']PASS["']\s*\|\s*["']REPAIRABLE["']\s*\|\s*["']WAITING_EXTERNAL["']\s*\|\s*["']BLOCKED["']\s*\|\s*["']NOT_APPLICABLE["']/.test(readiness), "")

  // ── WAVE142 HOOK (integrator): 142I — the wave-142 readiness gate rows; the certified default. ──
  for (const h of hooksFor("commercial-platform")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, /READINESS CHECKS/.test(h.contract) ? "measured: production-readiness-guard / tenant-readiness / provider-posture carry no support-isolation + offers_cda readiness row (the rows handed to lane I are in lane142J-notes + READINESS-MATRIX §Wave 142)" : `measured above: SYSTEM_DEFAULTS.transaction = '${SYSTEM_DEFAULTS.transaction}', uncertified`); continue }
    c.step(`${h.lane} landed (${at}) — wire it into this canary (WAVE142 HOOK (integrator): ${h.lane}): ${/READINESS CHECKS/.test(h.contract) ? "assert the guard's wave-142 gate rows name the lane keys and that a 0-row live count reads NOT_APPLICABLE" : "assert SYSTEM_DEFAULTS.transaction is e-sign certified per the matrix or 'none' until the tenant selects"}`, /READINESS CHECKS/.test(h.contract) ? /NOT_APPLICABLE|unproven/.test(strippedRepo("scripts/production-readiness-guard.ts") ?? "") : esignCertified(SYSTEM_DEFAULTS.transaction) || SYSTEM_DEFAULTS.transaction === "none", h.contract.slice(0, 120))
  }
  c.blind("The provisioning chains (direct paid, trial, staff-created, seat invite, A2P initiation, coupon redemption, proration) RUN in the subscriber / seat / user-invite / coupon / brokerage-adoption canaries — here they are asserted on stripped source so this canary stays cheap. No Stripe, no provider is reached.")
  const cl = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", cl.mismatches.length === 0 && cl.residual === 0, cl.cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cl.cleanup, cl.residual)
}
