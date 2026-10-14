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
  // WAVE141 HOOKS (integrator): 141G — per-provider instructions + state machine; 141G — the kernel event.
  for (const h of hooksFor("custom-domain")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract); continue }
    c.step(`${h.lane} landed (${at}) — wire the per-provider instructions / state machine / kernel event into this canary (WAVE141 HOOK (integrator): 141G)`, false, "")
  }
  c.blind("The Vercel Domains API is never called (unconfigured by design in-memory): the live add/verify/SSL loop is test:domain-api's; the session-gated action (addCustomDomainAction) is modelled by writing the row shape it writes.")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cleanup, residual)
}
