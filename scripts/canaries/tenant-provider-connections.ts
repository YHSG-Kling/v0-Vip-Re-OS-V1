/**
 * scripts/canaries/tenant-provider-connections.ts — TENANT-OWNED ACQUISITION PROVIDER canary (wave 151, lane 151F; directive
 * 151F steps 3, 9, 10, 12, 13, 14):
 *   two tenants connect the SAME provider (BatchData) with DIFFERENT tokens → each resolves only its own (the vault's
 *   ownership cascade), a third tenant resolves none; a signed push delivery for tenant 1 hydrates under tenant 1's token
 *   ONLY, lands as tenant 1's RawData (source_origin brokerage), books tenant_paid spend on tenant 1 — and the identical
 *   delivery for tenant 2 touches tenant 2 alone; the same delivery replayed is ONE observation (m961 key, counted
 *   `replayed`); a revoked connection refuses before any hydrate; a token the provider refuses (401) marks the connection
 *   revoked, parks the delivery, ingests nothing; the connection's own daily cap holds the overflow; an unconfigured /
 *   unsupported / unknown provider reports its honest state; disconnect stops polls, revokes our secret, keeps history.
 * In-memory only (no network, no provider): the hydrate is a recording stub that returns a fixture; everything else is the
 * REAL code — resolve-scoped, ingestRawSourceBatch, meterVendorSpend, parkIngressEvent, the pure module.
 */
import { CANARY_TAG, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"

export async function run() {
  const c = canary("Tenant-owned provider connections: two tenants, same provider, different keys — no crossover; replay = one observation; honest states")
  // A throwaway IN-PROCESS encryption key for the proof (never a real value; set only when the process has none).
  if (!process.env.SECRETS_ENCRYPTION_KEY) process.env.SECRETS_ENCRYPTION_KEY = "wave151-canary-throwaway-key"
  const T1 = uuid(), T2 = uuid(), T3 = uuid(), U1 = uuid(), U2 = uuid()
  const tp = await import("../../lib/providers/tenant-provider-connections")
  const { encryptSecret, decryptSecret } = await import("../../lib/security/secret-crypto")

  const agreementInput = { scopes: ["motivated_seller_list"], license_acknowledged: true, retention_days: 365, ai_processing_permitted: true, redistribution: "prohibited", cost_payer: "tenant" }
  const territory = { state: "FL", zip_codes: ["32501", "32502"], city: "Pensacola" }
  const bd = tp.tenantAcquisitionProvider("batchdata")!
  const mkRow = (brokerageId: string, userId: string, apiKey: string, secret: string, over: Record<string, unknown> = {}): Record<string, any> => {
    const a = tp.validateProviderAgreement("batchdata", agreementInput, { userId })
    const t = tp.validateProviderTerritory(territory)
    if (!a.ok || !t.ok) throw new Error("fixture agreement/territory invalid")
    const built = tp.buildTenantProviderCredentialRow(bd, { brokerageId, fields: { apiKey, accountLabel: `${CANARY_TAG} ${brokerageId.slice(0, 4)}` }, agreement: a.agreement, territory: t.territory, frequency: "push", rateLimitPerDay: 0, webhookSecret: secret, sandbox: false, encrypt: encryptSecret })
    if (!built.ok) throw new Error(built.problems.join("; "))
    return { id: uuid(), ...built.row, ...over, test_status: "pass", created_at: nowIso(), notes: CANARY_TAG }
  }
  const K1 = "canary-token-tenant-one-xxxxxxxx", K2 = "canary-token-tenant-two-yyyyyyyy"
  const S1 = "canary-secret-one", S2 = "canary-secret-two"
  const row1 = mkRow(T1, U1, K1, S1), row2 = mkRow(T2, U2, K2, S2)
  // Health already verified for both (the proof drives the webhook door; the connect action's live wallet read is stubbed out of scope).
  for (const r of [row1, row2]) (r.config as Record<string, unknown>).last_health = { kind: "wallet_balance", status: "ok", at: nowIso(), detail: null }

  const svc = canaryClient({
    brokerages: [T1, T2, T3].map((id, i) => ({ id, name: `${CANARY_TAG} Brokerage ${i + 1}`, plan_tier: "brokerage", slug: `${CANARY_TAG}-tpc-${i}` })),
    platform_credentials: [row1, row2],
    raw_scraped_leads: [], scraper_executions: [], lifecycle_events: [], lead_scraping_markets: [], vendor_usage_tracking: [], ingress_dead_letters: [],
  }, { unique: { raw_scraped_leads: [["idempotency_key"]] } })
  setSvc(svc)

  // ── step 3 / 14: the vault isolates the two tenants' tokens ──────────────────────────────────────────────────────
  c.step("both rows store the token and OUR push secret ENCRYPTED (enc:v1), never plaintext", [row1, row2].every((r) => String(r.api_key).startsWith("enc:v1:") && String((r.config as { webhook_secret: string }).webhook_secret).startsWith("enc:v1:")), "")
  const { resolveScopedConnectionResult } = await import("../../lib/connections/resolve-scoped")
  const r1 = await resolveScopedConnectionResult("batchdata", { brokerageId: T1 })
  const r2 = await resolveScopedConnectionResult("batchdata", { brokerageId: T2 })
  const r3 = await resolveScopedConnectionResult("batchdata", { brokerageId: T3 })
  c.step("tenant 1 resolves ITS token through the ownership cascade", r1.status === "connected" && r1.connection.apiKey === K1 && r1.connection.ownerId === T1, r1.status)
  c.step("tenant 2 resolves ITS token — never tenant 1's", r2.status === "connected" && r2.connection.apiKey === K2 && r2.connection.ownerId === T2, r2.status)
  c.step("a third tenant resolves NOTHING (not_connected, no platform key substituted)", r3.status === "not_connected", r3.status)

  // ── step 11: honest states ───────────────────────────────────────────────────────────────────────────────────────
  c.step("unconfigured: a tenant with no row is told so with the actionable next step", tp.deriveTenantProviderConnectionState("batchdata", null).state === "unconfigured", "")
  c.step("unsupported: PropertyRadar (dormant, no transport) is never offered a key field", tp.deriveTenantProviderConnectionState("propertyradar", null).state === "unsupported", "")
  c.step("unavailable: an unknown provider has no generic API field", tp.deriveTenantProviderConnectionState("someapi", null).state === "unavailable", "")
  const facts1 = { exists: true, isActive: true, testStatus: "pass" as const, hasApiKey: true, config: row1.config as never }
  c.step("healthy: tenant 1's verified connection", tp.deriveTenantProviderConnectionState("batchdata", facts1).state === "healthy", "")

  // ── steps 9 + 10 + 14: a signed push for each tenant, hydrated under ITS OWN token, landing in ITS OWN RawData ─────
  const { ingestRawSourceBatch } = await import("../../lib/kernel/scraping")
  const { normalizeBatchDataRecord } = await import("../../lib/lead-pipeline/scraper-parsers")
  const { meterVendorSpend } = await import("../../lib/vendor-governance/meter-vendor")
  const { parkIngressEvent } = await import("../../lib/kernel/ingress-continuity")
  const hydrateCalls: Array<{ key: string; ids: string[] }> = []
  const fixture = (propertyId: string) => ({ propertyId, _id: propertyId, address: { street: "12 Palafox St", city: "Pensacola", state: "FL", zip: "32501" }, owner: { fullName: "Dana Whitfield" }, propertyAddress: "12 Palafox St", city: "Pensacola", state: "FL", zip: "32501", first_name: "Dana", last_name: "Whitfield", email: "dana.whitfield@example.org", quickLists: ["pre-foreclosure"] })
  const deps = (expectKey: string, answer: { ok: boolean; httpStatus?: number | null; error?: string } = { ok: true }) => ({
    hydrate: async (ids: string[], key: string) => { hydrateCalls.push({ key, ids }); if (!answer.ok) return { ok: false, properties: [], cost: 0, error: answer.error ?? "refused", httpStatus: answer.httpStatus ?? null }; if (key !== expectKey) return { ok: false, properties: [], cost: 0, error: "WRONG KEY", httpStatus: 401 }; return { ok: true, properties: ids.map(fixture), cost: ids.length * 0.02 } },
    normalize: (raw: Record<string, unknown>, geo: { city: string | null; state: string | null }) => normalizeBatchDataRecord(raw, geo),
    ingest: (p: Parameters<typeof ingestRawSourceBatch>[0]) => ingestRawSourceBatch(p),
    book: (input: Parameters<typeof meterVendorSpend>[0]) => meterVendorSpend(input),
    park: (p: { provider: string; eventKind: string; externalRef: string; payload: Record<string, unknown> }) => parkIngressEvent(svc as never, p),
  })
  const conn = (row: typeof row1, brokerageId: string, key: string, over: Partial<Parameters<typeof tp.ingestTenantWebhookDelivery>[1]> = {}) => ({ id: row.id as string, brokerage_id: brokerageId, platform: "batchdata", is_active: true, test_status: "pass" as const, apiKey: key, config: row.config as never, ...over })
  const events = [{ eventId: "evt-1001", propertyId: "P-1", addedToSubscriptionIds: ["sub-a"], propertyChangedAt: nowIso() }, { eventId: "evt-1002", propertyId: "P-2", addedToSubscriptionIds: ["sub-a"], propertyChangedAt: nowIso() }]

  const d1 = await tp.ingestTenantWebhookDelivery(svc as never, conn(row1, T1, K1), events, deps(K1))
  c.step("tenant 1 delivery: hydrated under tenant 1's token ONLY, two raw rows inserted as tenant 1's (source_origin brokerage)", d1.ok && d1.inserted === 2 && hydrateCalls.length === 1 && hydrateCalls[0].key === K1 && (svc.tables.raw_scraped_leads ?? []).filter((r) => r.brokerage_id === T1).length === 2 && (svc.tables.raw_scraped_leads ?? []).every((r) => r.source_origin === "brokerage"), JSON.stringify({ d1: { ok: d1.ok, inserted: d1.inserted, refused: d1.refused }, hydrate: hydrateCalls.map((h) => h.key.slice(-3)) }))
  // The key is TENANT-scoped and anchored on the provider's eventId (the rule). Its middle segment is the RECORD's own source
  // (normalizeBatchDataRecord labels every BatchData record batchdata_motivated; the push door is source_channel) — asserted
  // as the rule, never as that spelling.
  c.step("the rows name the door (producer_actor_id tenant:<connection>, source_channel batchdata_smart_search) and the provider's eventId anchors a TENANT-scoped idempotency key", (svc.tables.raw_scraped_leads ?? []).filter((r) => r.brokerage_id === T1).every((r) => r.producer_actor_id === `tenant:${row1.id}` && r.source_channel === "batchdata_smart_search" && String(r.idempotency_key).startsWith(`t:${T1}|`) && /\|evt:evt-\d+$/.test(String(r.idempotency_key))), (svc.tables.raw_scraped_leads ?? []).map((r) => r.idempotency_key).join(" "))
  const replay = await tp.ingestTenantWebhookDelivery(svc as never, conn(row1, T1, K1), events, deps(K1))
  c.step("REPLAY: the same delivery again → 0 inserted, 2 counted as replays — one observation, exactly-once promotion", replay.ok && replay.inserted === 0 && replay.replayed === 2 && (svc.tables.raw_scraped_leads ?? []).filter((r) => r.brokerage_id === T1).length === 2, JSON.stringify({ inserted: replay.inserted, replayed: replay.replayed }))
  const d2 = await tp.ingestTenantWebhookDelivery(svc as never, conn(row2, T2, K2), events, deps(K2))
  c.step("tenant 2's identical delivery: hydrated under tenant 2's token, lands as tenant 2's own rows — no crossover in calls or records", d2.ok && d2.inserted === 2 && hydrateCalls.at(-1)?.key === K2 && (svc.tables.raw_scraped_leads ?? []).filter((r) => r.brokerage_id === T2).length === 2 && (svc.tables.raw_scraped_leads ?? []).filter((r) => r.brokerage_id === T1).length === 2, JSON.stringify({ inserted: d2.inserted }))
  const ledger = (svc.tables.vendor_usage_tracking ?? [])
  const payer = (r: Record<string, any>) => r.request_metadata?.coverage
  c.step("COSTS: each tenant's hydrate is booked on ITS OWN ledger row as tenant_paid — never platform_paid, never a platform lead purchase", ledger.length === 2 && ledger.every((r) => payer(r) === "tenant_paid" && !r.request_metadata?.platform_paid && r.brokerage_id !== null) && ledger.some((r) => r.brokerage_id === T1) && ledger.some((r) => r.brokerage_id === T2) && ledger.every((r) => r.request_metadata?.cost_payer === "tenant"), JSON.stringify(ledger.map((r) => ({ b: String(r.brokerage_id).slice(0, 4), c: payer(r), usd: r.total_cost }))))

  // ── step 12 + 13: refusal / recovery ─────────────────────────────────────────────────────────────────────────────
  const before = hydrateCalls.length
  const revoked = await tp.ingestTenantWebhookDelivery(svc as never, conn(row1, T1, K1, { is_active: false }), events, deps(K1))
  c.step("a REVOKED (disconnected) connection refuses BEFORE any hydrate — no provider call, no row", !revoked.ok && revoked.connectionState === "revoked" && hydrateCalls.length === before && revoked.inserted === 0, revoked.refused ?? "")
  const badKeyEvents = [{ eventId: "evt-2001", propertyId: "P-9", addedToSubscriptionIds: ["sub-b"] }]
  const auth = await tp.ingestTenantWebhookDelivery(svc as never, conn(row2, T2, "stale-token-zzzzzzzzzz"), badKeyEvents, deps(K2, { ok: false, httpStatus: 401, error: "Unauthorized Bearer stale-token-zzzzzzzzzz" }))
  c.step("a token the provider REFUSES (401): connection marked revoked (health fail), delivery PARKED, nothing ingested, the tenant told without the token", !auth.ok && auth.connectionState === "revoked" && auth.healthPatch?.test_status === "fail" && auth.healthPatch.last_health.status === "auth_failed" && auth.parked === 1 && auth.inserted === 0 && auth.notify === "tenant_admin" && !/stale-token/.test(auth.refused ?? "") && (svc.tables.ingress_dead_letters ?? []).length === 1, JSON.stringify({ state: auth.connectionState, parked: auth.parked, refused: auth.refused?.slice(0, 80) }))
  const quota = await tp.ingestTenantWebhookDelivery(svc as never, conn(row2, T2, K2), badKeyEvents, deps(K2, { ok: false, httpStatus: 429, error: "rate limited" }))
  c.step("a QUOTA refusal (429): connection degraded, delivery held + parked, queue preserved for the next cycle", !quota.ok && quota.connectionState === "degraded" && quota.healthPatch?.last_health.status === "quota" && quota.held === 1, quota.refused ?? "")
  const capped = conn(row1, T1, K1, { config: { ...(row1.config as object), rate_limit_per_day: 2 } as never })
  const over = await tp.ingestTenantWebhookDelivery(svc as never, capped, [{ eventId: "evt-3001", propertyId: "P-3", addedToSubscriptionIds: ["sub-a"] }], deps(K1))
  c.step("the connection's OWN daily cap (2) holds the third record: held + parked, nothing bought, nothing inserted", over.ok && over.held === 1 && over.inserted === 0 && hydrateCalls.at(-1)?.ids.join() !== "P-3", JSON.stringify({ held: over.held, refused: over.refused?.slice(0, 60) }))
  const patch = tp.tenantProviderDisconnectPatch(row1.config as never)
  c.step("DISCONNECT: polls stop (inactive), OUR push secret is revoked (null), history rows stay; the door then refuses the secret", patch.is_active === false && (patch.config as { webhook_secret: unknown }).webhook_secret === null && tp.verifyTenantWebhookSecret(null, S1) === "no_secret_configured" && (svc.tables.raw_scraped_leads ?? []).length === 4, "")
  c.step("the push secret verifies timing-safe against THIS connection's secret only", tp.verifyTenantWebhookSecret(decryptSecret((row1.config as { webhook_secret: string }).webhook_secret), S1) === "ok" && tp.verifyTenantWebhookSecret(decryptSecret((row1.config as { webhook_secret: string }).webhook_secret), S2) === "mismatch", "")

  c.blind("The provider is never called: the hydrate is a recording stub answering a fixture; the live wallet-balance health read the connect action performs is outside this canary (it needs a session and a provider).")
  c.blind("RLS is not modelled by the in-memory client — tenant isolation here is the ownership cascade's predicates and the producer's brokerage pin, which is exactly what the steps assert.")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, null)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, cleanup.map((x) => `${x.table}:${x.deleted}`).join(" ") + (mismatches.length ? ` mismatches: ${mismatches.join("; ")}` : ""))
  return c.report(cleanup, residual)
}
