/**
 * scripts/canaries/crm-outbound.ts — CRM OUTBOUND canary (wave 141, lane 141J):
 *   tenant → external CRM (VIPAgents canonical → mapping → the tenant's CRM, tenant credentials)
 * through lib/crm/sync.ts syncContactToCRM (the ONE sync-out entry: egress gate → the tenant's provider from
 * brokerage_integrations / platform_credentials → the provider adapter → the connector gateway). The gateway's
 * egress door is REPLACED by a recorder (scripts/canaries/_connector-gateway-stub.ts, installed through
 * _harness.ts stubModule BEFORE lib/crm/sync.ts loads) so the request is asserted, never sent. Owner (wave
 * 141): "Tenants may SYNC OUT to supported external CRMs … tenant-controlled in settings, tenant credentials,
 * booked usage, errors shown to the tenant as actionable." Airtable's retirement (lane 141D) is a WAVE141 HOOK.
 */
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, stubModule, uuid } from "./_harness"
import { ROOT, hooksFor } from "./_registry"

export async function run() {
  const c = canary("CRM outbound: tenant → external CRM (canonical mapping, tenant credentials, honest errors)")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: an outbound sync is a third-party write — in-memory only")
  // THE RECORDER, before the sync graph is first imported (a stub installed later misses loaded modules).
  stubModule("@/lib/agentic-os/connector-gateway", pathToFileURL(join(ROOT, "scripts/canaries/_connector-gateway-stub.ts")).href)
  const { connectorRecorder } = await import("./_connector-gateway-stub")
  const rec = connectorRecorder()
  rec.calls.length = 0
  const B = uuid(), B2 = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-crm` }, { id: B2, name: `${CANARY_TAG} Other`, plan_tier: "team", slug: `${CANARY_TAG}-crm2` }],
    // The tenant's CRM choice (settings) and the tenant's OWN credential.
    brokerage_integrations: [{ id: uuid(), brokerage_id: B, provider_type: "crm", provider_name: "followupboss", status: "connected", created_at: nowIso() }],
    platform_credentials: [{ id: uuid(), brokerage_id: B, owner_type: "brokerage", owner_id: B, platform: "followupboss", api_key: "fub-canary-tenant-key", is_active: true, created_at: nowIso() }],
  })
  setSvc(svc)
  const { syncContactToCRM } = await import("../../lib/crm/sync")
  const r = await syncContactToCRM({ firstName: "Jordan", lastName: "Canary", email: `jordan@${CANARY_EMAIL_DOMAIN}`, phone: "5125550123", brokerageId: B, source: CANARY_TAG, tags: [CANARY_TAG] })
  const call = rec.calls[0]
  c.step("tenant-controlled: the sync resolves the TENANT's selected CRM (Follow Up Boss) and reports the provider by key", r.success && r.providerKey === "followupboss" && r.action === "created" && r.contactId === "canary-remote-1", JSON.stringify(r))
  c.step("egress recorded, never sent: exactly ONE gateway call, to the FUB people endpoint, through the connector gateway", rec.calls.length === 1 && call?.connector === "followupboss" && /followupboss\.com/.test(String(call?.baseUrl)) && call?.path === "people", JSON.stringify({ n: rec.calls.length, connector: call?.connector, path: call?.path }))
  const auth = (call?.auth ?? {}) as { style?: string; username?: string }
  c.step("tenant credentials: the request is signed with the TENANT's own key from platform_credentials (owner brokerage) — never a platform key", auth.style === "basic" && auth.username === "fub-canary-tenant-key", JSON.stringify({ style: auth.style, username: auth.username }))
  const body = (call?.body ?? {}) as Record<string, unknown>
  c.step("canonical mapping: the payload is the vendor's shape built from canonical fields (firstName/lastName/emails/phones) — no raw contact row, no brokerage_id, no internal ids", body.firstName === "Jordan" && Array.isArray(body.emails) && (body.emails as Array<{ value: string }>)[0]?.value === `jordan@${CANARY_EMAIL_DOMAIN}` && !("brokerage_id" in body) && !("id" in body) && !("agent_id" in body), Object.keys(body).join(","))
  rec.calls.length = 0
  const junk = await syncContactToCRM({ firstName: "Nobody", lastName: "Canary", brokerageId: B })
  c.step("POSITIVE CONTROL (good data out): a contact with no reachable identifier is REFUSED at the egress gate — no request leaves, the refusal is ledgered on the tenant", !junk.success && junk.providerKey === "egress_gate" && rec.calls.length === 0 && (svc.tables.self_heal_events ?? []).some((e) => e.brokerage_id === B), junk.error ?? "sent")
  rec.calls.length = 0
  const none = await syncContactToCRM({ firstName: "Dana", lastName: "Canary", email: `dana@${CANARY_EMAIL_DOMAIN}`, brokerageId: B2 })
  c.step("honest unavailability: a tenant with NO CRM connected gets requiresConfiguration (actionable to the tenant) and nothing leaves", !none.success && none.requiresConfiguration === true && rec.calls.length === 0, none.error ?? "")
  rec.respond = () => ({ ok: false, status: 401, data: null, error: "401 Unauthorized — invalid API key" })
  const bad = await syncContactToCRM({ firstName: "Sam", lastName: "Canary", email: `sam@${CANARY_EMAIL_DOMAIN}`, brokerageId: B })
  c.step("tenant-actionable error: the provider's refusal (401 from the tenant's own key) is returned as the tenant's integration error — not swallowed, not a platform incident", !bad.success && bad.providerKey === "followupboss" && /401|Unauthorized/.test(bad.error ?? ""), bad.error ?? "")
  rec.respond = () => ({ ok: true, status: 201, data: { id: "canary-remote-1" } })
  // WAVE141 HOOK (integrator): 141D — Airtable retired.
  for (const h of hooksFor("crm-outbound")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, "runtime files still name airtable (global_settings.airtable_api_key + readers)"); continue }
    c.step(`${h.lane} landed: no runtime path under lib/, app/ or services/ names Airtable (stripped source)`, true, at)
  }
  c.blind("Usage booking for an outbound sync is the connector gateway's (meterVendorSpend inside callConnector) — replaced by the recorder here, so booking is lane 139C's test:cost-completeness, not this canary.")
  c.blind("GHL and HubSpot sync-out take the same entry (providerKey ghl / hubspot); only the FUB adapter's request is asserted.")
  const a = await cleanupCanary(svc, B), b = await cleanupCanary(svc, B2)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", a.mismatches.length + b.mismatches.length === 0 && a.residual + b.residual === 0, [...a.cleanup, ...b.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...a.cleanup, ...b.cleanup], a.residual + b.residual)
}
