/**
 * scripts/canaries/custom-domain.ts — CUSTOM DOMAIN canary (wave 141, lane 141J):
 *   baseline site → external domain the tenant owns → DNS instructions → verification → tenant site
 * through lib/platform/custom-domains.ts (validateCustomDomain — syntax only, never *.vercel.app, never the
 * platform's own hosts; dnsInstructionsFor — Vercel's standard A / CNAME targets with exact values;
 * addDomainToProject — MOCK-SAFE: without VERCEL_TOKEN/VERCEL_PROJECT_ID the row stays pending_dns and the
 * answer says so; reportCustomDomainOutcome — the governed bus + self-heal ledger) and the row lifecycle the
 * action writes (tenant_custom_domains pending_dns → verifying → active | error | removed). Owner (wave 141):
 * "VIPAgents does NOT sell/register/host domains … Clear DNS instructions; custom domain never required
 * before the tenant can work." Per-provider instructions + ONE state machine, and the kernel event on
 * connect/verify (lane 141G) are WAVE141 HOOKS.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor, strippedRepo } from "./_registry"

/** PURE: registrar / purchase affordances in a stripped source (the platform never sells domains). */
export function registrarTokens(stripped: string): string[] {
  return [...stripped.matchAll(/\b(buy_domain|buyDomain|purchaseDomain|registerDomain|create_or_transfer_domain|domain_purchase|registrar)\b/g)].map((m) => m[1])
}

export async function run() {
  const c = canary("Custom domain: baseline site → external domain → DNS instructions → verification → tenant site")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: a domain row is a tenant's live routing — in-memory only")
  const { validateCustomDomain, platformReservedHosts, dnsInstructionsFor, addDomainToProject, getVercelDomainsConfig, reportCustomDomainOutcome, VERCEL_APEX_A_TARGET, VERCEL_CNAME_TARGET } = await import("../../lib/platform/custom-domains")
  const reserved = platformReservedHosts()
  c.step("validation: a host the tenant owns is accepted exactly (lowercased, trailing dot stripped; apex and www are DISTINCT rows)", (() => { const a = validateCustomDomain(" WWW.Canary-Realty.com. ", reserved); const b = validateCustomDomain("canary-realty.com", reserved); return a.ok && a.domain === "www.canary-realty.com" && b.ok && b.domain === "canary-realty.com" })(), "")
  c.step("validation refusals (immediate, specific): a scheme, a path, a port, a single label, *.vercel.app and the PLATFORM's own host are each refused by name", !validateCustomDomain("https://x.com", reserved).ok && !validateCustomDomain("x.com/site", reserved).ok && !validateCustomDomain("x.com:8080", reserved).ok && !validateCustomDomain("localhost", reserved).ok && !validateCustomDomain("tenant.vercel.app", reserved).ok && reserved.length > 0 && !validateCustomDomain(reserved.find((h) => h.includes(".")) ?? "vipagents.ai", reserved).ok, `reserved: ${reserved.join(",")}`)
  const apex = dnsInstructionsFor("canary-realty.com"), sub = dnsInstructionsFor("www.canary-realty.com")
  c.step("DNS instructions with EXACT values: apex → A @ 76.76.21.21; subdomain → CNAME www cname.vercel-dns.com", apex.length === 1 && apex[0].type === "A" && apex[0].name === "@" && apex[0].value === VERCEL_APEX_A_TARGET && sub.length === 1 && sub[0].type === "CNAME" && sub[0].name === "www" && sub[0].value === VERCEL_CNAME_TARGET, JSON.stringify([apex, sub]))
  const B = uuid(), ADMIN = uuid(), D = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-site` }],
    users: [{ id: ADMIN, email: `admin@${CANARY_EMAIL_DOMAIN}`, user_type: "broker_owner", brokerage_id: B }],
  })
  setSvc(svc)
  // THE ROW LIFECYCLE the action writes (app/actions/custom-domains.ts addCustomDomainAction) — the shape, in-memory.
  const { error: insErr } = await svc.from("tenant_custom_domains").insert({ id: D, brokerage_id: B, domain: "www.canary-realty.com", status: "pending_dns", verification: { challenges: [] }, added_by: ADMIN, created_at: nowIso() })
  const cfg = getVercelDomainsConfig()
  const add = await addDomainToProject("www.canary-realty.com")
  const row = () => (svc.tables.tenant_custom_domains ?? []).find((r) => r.id === D)
  c.step("connect: the row is pending_dns; without the platform's Vercel credentials the adapter answers configured=false WITH instructions and the row STAYS pending_dns (nothing pretends to verify)", !insErr && row()?.status === "pending_dns" && cfg.configured === false && add.configured === false && !!(add as { instructions?: string }).instructions, (add as { instructions?: string }).instructions?.slice(0, 120) ?? "")
  c.step("fail closed: verification never flips the row without the provider's verdict (status is not 'active' and verified_at is null)", row()?.status !== "active" && !row()?.verified_at, "")
  await reportCustomDomainOutcome({ brokerageId: B, domainRowId: D, domain: "www.canary-realty.com", outcome: "error", phase: "verify", errorCode: "dns_not_propagated", errorDetail: "CNAME not found yet" })
  const signal = (svc.tables.manager_signals ?? []).find((s) => s.brokerage_id === B && /custom_domain_error/.test(String(s.signal_type)))
  const heal = (svc.tables.self_heal_events ?? []).find((e) => e.brokerage_id === B)
  c.step("immediate feedback on a refusal: a verification error is announced on the governed bus to the registered owner (campaign_orchestrator) and ledgered — the tenant is told what to fix", !!signal && !!heal, `signal=${signal?.signal_type ?? "none"} heal=${heal ? "yes" : "no"}`)
  c.step("tenant-sanitized: the signal's message tells the tenant WHERE to fix DNS, not an internal credential or Vercel config", /Settings/.test(String(signal?.message)) && !/VERCEL_TOKEN|projectId|token/i.test(String(signal?.message)), String(signal?.message).slice(0, 140))
  const readiness = strippedRepo("lib/kernel/tenant-readiness.ts") ?? ""
  c.step("never required: the tenant readiness contract never reads tenant_custom_domains — the /site/<slug> storefront is the website check", readiness.length > 0 && !/tenant_custom_domains/.test(readiness), "")
  c.step("routing: proxy.ts rewrites a host to the tenant's site ONLY from an 'active' tenant_custom_domains row", /tenant_custom_domains/.test(strippedRepo("proxy.ts") ?? "") && /["']active["']/.test((strippedRepo("proxy.ts") ?? "").slice((strippedRepo("proxy.ts") ?? "").indexOf("tenant_custom_domains"), (strippedRepo("proxy.ts") ?? "").indexOf("tenant_custom_domains") + 600)), "")
  const regTokens = ["lib/platform/custom-domains.ts", "app/actions/custom-domains.ts"].flatMap((f) => registrarTokens(strippedRepo(f) ?? "").map((t) => `${f}:${t}`))
  c.step("no registrar path: neither the adapter nor the action carries a buy/register/transfer affordance (the platform never sells or hosts domains)", regTokens.length === 0, regTokens.join(",") || "0 tokens")
  c.step("POSITIVE CONTROL: the finder catches a specimen `buy_domain(` call", registrarTokens(`const r = await vercel.buy_domain({ name })`).length === 1)
  // WAVE141 HOOKS (integrator): 141G — per-provider instructions + ONE state machine; 141G — the kernel event and its
  // readers. Both wired 141K against lib/platform/custom-domains.ts (the two hooks share a probe; the contract text
  // tells them apart).
  const { dnsProviderGuide, DNS_PROVIDERS, probeDomainDns, nextCustomDomainStatus, CUSTOM_DOMAIN_STATUSES, CONNECT_POST_CONDITION_STATUSES, tenantFacingDomainMessage } = await import("../../lib/platform/custom-domains")
  for (const h of hooksFor("custom-domain")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract); continue }
    if (/KERNEL EVENT/.test(h.contract)) {
      type EvMeta = { phase?: string; error_code?: string | null; outcome?: string }
      const ev = (type: string) => (svc.tables.lifecycle_events ?? []).filter((e) => e.brokerage_id === B && e.event_type === type && e.entity_id === D)
      const err = ev("custom_domain_error")
      const errMeta = (err[0]?.metadata ?? {}) as EvMeta
      c.step(`${h.lane} landed (${at}): the verify FAILURE above emitted KernelEvent.CUSTOM_DOMAIN_ERROR on this tenant for the domain row, with evidence (phase, the error CODE, the DNS verdict) — and NEVER the routing layer's raw text`, err.length === 1 && errMeta.phase === "verify" && errMeta.error_code === "dns_not_propagated" && !/CNAME not found/.test(JSON.stringify(err[0])), JSON.stringify(errMeta))
      await reportCustomDomainOutcome({ brokerageId: B, domainRowId: D, domain: "www.canary-realty.com", outcome: "verified", phase: "verify", status: "active", dns: { checked: true, matches: true }, actorUserId: ADMIN, client: svc })
      await reportCustomDomainOutcome({ brokerageId: B, domainRowId: D, domain: "www.canary-realty.com", outcome: "connected", phase: "add", status: "pending_dns", actorUserId: ADMIN, client: svc })
      const ok = ev("custom_domain_verified"), conn = ev("custom_domain_connected")
      const verifiedSignal = (svc.tables.manager_signals ?? []).find((s) => s.brokerage_id === B && s.signal_type === "custom_domain_verified")
      c.step("141G success is evidenced too (immediate post-condition → event): verify → CUSTOM_DOMAIN_VERIFIED (actor = the human who clicked, source ui) + the bus line to the registered brand owner (campaign_orchestrator); connect → CUSTOM_DOMAIN_CONNECTED, event-only (no feed noise)", ok.length === 1 && ok[0].actor_user_id === ADMIN && ok[0].source === "ui" && !!verifiedSignal && verifiedSignal.to_manager === "campaign_orchestrator" && conn.length === 1 && !(svc.tables.manager_signals ?? []).some((s) => s.brokerage_id === B && /connected/.test(String(s.signal_type))), `verified=${ok.length} connected=${conn.length} signal=${verifiedSignal?.signal_type ?? "none"}`)
      const { WEBHOOK_EVENT_CATALOG } = await import("../../lib/platform/tenant-webhooks-core")
      const { KernelEvent } = await import("../../lib/kernel/events")
      const { SIGNAL_REGISTRY } = await import("../../lib/kernel/signal-registry")
      const { MANAGERS } = await import("../../lib/kernel/manager-registry")
      const reader = WEBHOOK_EVENT_CATALOG.find((e) => e.internalTypes.includes(KernelEvent.CUSTOM_DOMAIN_VERIFIED))
      c.step("141G consumed by the canonical service and a registered manager: CUSTOM_DOMAIN_VERIFIED is read by the tenant webhook rail (website.domain_verified — the host and its status only, never the routing error text) and both bus lines are catalogued for the registered campaign_orchestrator", reader?.event === "website.domain_verified" && reader.payloadFields.join() === "domain,status" && !!SIGNAL_REGISTRY.custom_domain_verified && !!SIGNAL_REGISTRY.custom_domain_error && "campaign_orchestrator" in MANAGERS, reader?.event ?? "no reader")
      continue
    }
    const hosts = ["canary-realty.com", "www.canary-realty.com"]
    const guides = DNS_PROVIDERS.flatMap((p) => hosts.map((d) => ({ p, d, g: dnsProviderGuide(p, d) })))
    c.step(`${h.lane} landed (${at}): per-provider DNS instructions for GoDaddy, Cloudflare, Namecheap, Squarespace Domains and any other DNS — each with a console path, ordered steps, the EXACT record from the one source (apex A ${VERCEL_APEX_A_TARGET} / www CNAME ${VERCEL_CNAME_TARGET}) and the provider's trap (Cloudflare grey cloud, GoDaddy forwarding/parked, Namecheap redirect record, Squarespace presets); an unknown provider gets the generic guide, never a refusal`, guides.length === DNS_PROVIDERS.length * 2 && guides.every(({ d, g }) => g.steps.length >= 1 && g.cautions.length >= 1 && g.consolePath.length > 0 && g.records.length === 1 && g.records[0].value === (d.startsWith("www.") ? VERCEL_CNAME_TARGET : VERCEL_APEX_A_TARGET) && g.records[0].name === (d.startsWith("www.") ? "www" : "@")) && /DNS only|grey cloud/i.test(dnsProviderGuide("cloudflare", hosts[1]).cautions.join(" ")) && /Forwarding/i.test(dnsProviderGuide("godaddy", hosts[0]).cautions.join(" ")) && /Redirect/i.test(dnsProviderGuide("namecheap", hosts[1]).cautions.join(" ")) && /preset/i.test(dnsProviderGuide("squarespace", hosts[1]).cautions.join(" ")) && dnsProviderGuide("route53", hosts[0]).provider === "other", DNS_PROVIDERS.join(","))
    const resolver = (cname: () => Promise<string[]>, a: () => Promise<string[]>) => ({ resolveCname: cname, resolve4: a })
    const fail = (code: string) => () => Promise.reject(Object.assign(new Error(code), { code }))
    const broken = await probeDomainDns(hosts[1], { resolver: resolver(fail("SERVFAIL"), fail("ETIMEOUT")) })
    const empty = await probeDomainDns(hosts[1], { resolver: resolver(fail("ENODATA"), fail("ENOTFOUND")) })
    const wrong = await probeDomainDns(hosts[1], { resolver: resolver(async () => ["parked.example."], fail("ENODATA")) })
    const good = await probeDomainDns(hosts[1], { resolver: resolver(async () => ["CNAME.VERCEL-DNS.COM."], fail("ENODATA")) })
    c.step("141G immediate DNS feedback, FAIL CLOSED: a resolver that cannot answer → checked:false (never 'looks fine'); no record → an ANSWER ('No DNS record is visible yet' + the exact record to add); a wrong record → named with the fix; the standard target (case / trailing-dot insensitive) → matches; no sentence names a provider or an env key", !broken.checked && !broken.matches && empty.checked && !empty.matches && /No DNS record is visible yet/.test(empty.reason) && wrong.checked && !wrong.matches && /currently resolves to CNAME parked\.example/.test(wrong.reason) && good.checked && good.matches && !/VERCEL_TOKEN|projectId|vercel api/i.test(broken.reason + empty.reason + wrong.reason + good.reason), `${broken.reason.slice(0, 80)} | ${empty.reason.slice(0, 80)}`)
    const signals = ["attach_ok_verified", "attach_ok_unverified", "attach_failed", "check_verified", "check_unverified", "check_failed", "routing_unavailable", "remove", "revive"] as const
    const table = CUSTOM_DOMAIN_STATUSES.flatMap((s) => signals.map((g) => ({ s, g, n: nextCustomDomainStatus(s, g) })))
    const reachActive = table.filter((t) => t.n === "active" && t.s !== "active")
    const fromPending = new Set(table.filter((t) => t.s === "pending_dns" && /^attach_|^routing_unavailable$/.test(t.g)).map((t) => t.n))
    c.step("141G ONE state machine (pending_dns → verifying → active | error | removed), derived here cell by cell: only a VERIFIED signal reaches active; routing_unavailable never promotes or demotes; removed is absorbing except revive → pending_dns; the connect post-condition set equals exactly what an attach can leave from pending_dns", table.length === CUSTOM_DOMAIN_STATUSES.length * signals.length && table.every((t) => (CUSTOM_DOMAIN_STATUSES as readonly string[]).includes(t.n)) && reachActive.length > 0 && reachActive.every((t) => t.g === "attach_ok_verified" || t.g === "check_verified") && table.filter((t) => t.g === "routing_unavailable").every((t) => t.n === t.s) && table.filter((t) => t.s === "removed").every((t) => t.n === (t.g === "revive" ? "pending_dns" : "removed")) && [...fromPending].sort().join() === [...CONNECT_POST_CONDITION_STATUSES].sort().join(), `from pending_dns: ${[...fromPending].join(",")}`)
    const msgs = CUSTOM_DOMAIN_STATUSES.flatMap((s) => [null, "domain_taken", "network_error", "routing_unavailable", "weird_code"].map((code) => tenantFacingDomainMessage(s, code)))
    c.step("141G tenant-sanitized by construction: no state × code sentence names a provider, an env key, an HTTP code or a credential; 'active' reads Live", msgs.every((m) => m.length > 0 && !/vercel|VERCEL_|token|projectId|\b4\d\d\b|\b5\d\d\b/i.test(m)) && /Live/.test(tenantFacingDomainMessage("active")), `${msgs.length} sentences`)
    const act = strippedRepo("app/actions/custom-domains.ts") ?? ""
    c.step("141G the session action runs the rail: DNS probe → ledgered routing call (withActionLedger) → the machine (nextCustomDomainStatus) → IMMEDIATE post-condition re-read (confirmDomainRowPostCondition against the DERIVED set) → events (reportCustomDomainOutcome); gated by mayUseAndAfford and the derived admin roster; no env note reaches a tenant field", /probeDomainDns\(/.test(act) && /withActionLedger/.test(act) && /nextCustomDomainStatus\(/.test(act) && /confirmDomainRowPostCondition\(/.test(act) && /CONNECT_POST_CONDITION_STATUSES/.test(act) && /reportCustomDomainOutcome\(/.test(act) && /mayUseAndAfford\(/.test(act) && /BROKERAGE_FINANCE_ADMIN_USER_TYPES/.test(act) && !/VERCEL_NOT_CONFIGURED_NOTE|vercelConfigured/.test(act), "")
  }
  c.blind("The Vercel Domains API is never called (unconfigured by design in-memory): the live add/verify/SSL loop is test:domain-api's; the session-gated action (addCustomDomainAction) is modelled by writing the row shape it writes.")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cleanup, residual)
}
