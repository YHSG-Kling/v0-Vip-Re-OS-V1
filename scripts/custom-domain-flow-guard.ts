#!/usr/bin/env tsx
/**
 * scripts/custom-domain-flow-guard.ts   (npm run test:custom-domain-flow) — wave 141G.
 * ─────────────────────────────────────────────────────────────────────────────
 * BASELINE WEBSITE → CONNECT A DOMAIN THE TENANT OWNS (no registrar, ever).
 * Pure: no network, no live DB, no env. Runs under --conditions=react-server because
 * the baseline-path survivor (lib/kernel/tenant-creation.ts) sits behind server-only
 * modules. Every absence assertion carries a POSITIVE CONTROL (CLAUDE.md §2); every
 * code-token scan reads STRIPPED source (a tombstone is not a call site).
 *
 * PROVES
 *   A. baseline — the system URL is ONE spelling (/site/<slug>); the readiness `website`
 *      check reads the slug and never tenant_custom_domains (a custom domain is never
 *      required to be READY); the operating baseline lists website as required.
 *   B. validation — host-only input; *.vercel.app and platform hosts refused; apex and www
 *      stay DISTINCT.
 *   C. per-provider instructions — GoDaddy / Cloudflare / Namecheap / Squarespace Domains /
 *      other each yield steps, cautions, a console path and the EXACT standard values from
 *      the one source (dnsInstructionsFor); Cloudflare carries the proxy-off trap.
 *   D. DNS probe — immediate feedback with an injected resolver; a resolver that cannot
 *      answer FAILS CLOSED (checked:false, matches:false); reasons are tenant-safe.
 *   E. state machine — the whole status × signal table stays inside the live CHECK
 *      vocabulary; only a verified routing signal reaches active; routing-unavailable is the
 *      identity; removed is absorbing except revive; the connect post-condition set is
 *      DERIVED from the table, not hard-coded.
 *   F. tenant-sanitized errors — no provider name, env key, API code or credential in any
 *      tenant message; the staff note is a different string that DOES name the env keys; the
 *      actions never forward the staff note or the raw error_detail to the tenant view.
 *   G. no registrar path — a stripped-source census of the rail (lib + actions + card +
 *      proxy) finds no buy/purchase/register endpoint or affordance; every routing-layer
 *      call is a project-domain endpoint; positive control on the finder.
 *   H. routing — proxy.ts serves a vanity host only from an ACTIVE row and never another
 *      tenant's slug.
 *   I. wiring — events (CUSTOM_DOMAIN_* members, emitted by the one reporter, read by the
 *      webhook catalogue + the bus), ledger (withActionLedger HUMAN_REQUESTED on exactly
 *      attach/verify/detach), entitlement (mayUseAndAfford), post-condition re-read, DNS
 *      probe on connect AND check, roster-derived gate (no retyped role list), tenant from
 *      the session, counted removal, every "use server" export async.
 *   K. landing pages INSIDE the tenant website (wave 143G) — /site/<slug>/lm/<form> proves the form
 *      belongs to the site's tenant (tenant in the QUERY, a foreign form is a 404, an unreadable read fails
 *      closed), renders the lead-magnet survivor (no second renderer), the storefront links to it, and a
 *      connected domain's /lm/<form> is rewritten to it from the HOST's tenant (never the path's).
 *   J. registration — package.json script + guard-chain MEMBERSHIP (word boundary, never a
 *      position), MAINTENANCE_DOMAINS owner = TABLE_MANAGER of the table, co-owners named in
 *      prose and licensed by canRefer, the readiness matrix names this proof.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  validateCustomDomain, dnsInstructionsFor, dnsProviderGuide, DNS_PROVIDERS, probeDomainDns,
  nextCustomDomainStatus, CUSTOM_DOMAIN_STATUSES, CONNECT_POST_CONDITION_STATUSES, tenantFacingDomainMessage,
  VERCEL_APEX_A_TARGET, VERCEL_CNAME_TARGET, ROUTING_UNAVAILABLE_TENANT_NOTE,
  type CustomDomainSignal, type CustomDomainStatus,
} from "../lib/platform/custom-domains"

/** The probe's resolver seam, structurally (the interface is file-local to the survivor by design). */
type DnsProbeResolver = NonNullable<Parameters<typeof probeDomainDns>[1]>["resolver"] & object
import { tenantWebsitePath } from "../lib/kernel/tenant-creation"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { MAINTENANCE_DOMAINS, MANAGERS, TABLE_MANAGER, canRefer, type ManagerKey } from "../lib/kernel/manager-registry"
import { KernelEvent } from "../lib/kernel/events"
import { WEBHOOK_EVENT_CATALOG } from "../lib/platform/tenant-webhooks-core"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"

const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(raw(p))
let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function section(t: string) { console.log(`\n── ${t}`) }

const LIB = "lib/platform/custom-domains.ts"
const ACTIONS = "app/actions/custom-domains.ts"
const CARD = "app/components/settings/YourWebsiteCard.tsx"
const PROXY = "proxy.ts"
const READINESS = "lib/kernel/tenant-readiness.ts"
const BASELINE = "lib/kernel/tenant-operating-baseline.ts"
const SITE_PAGE = "app/site/[slug]/page.tsx"

/** Every string literal ("…", '…', `…`) in a stripped source — the tenant-facing surface of a file. */
function stringLiterals(src: string): string[] {
  const re = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g
  return (src.match(re) ?? []).map((s) => s.slice(1, -1))
}
/** What a tenant must never read: a provider name, an env key, an API host/code, a credential word. */
const TENANT_LEAK = /vercel|VERCEL_|api\.|http_\d|\btoken\b|credential|project ?id/i

// ── A. BASELINE SITE ─────────────────────────────────────────────────────────
section("A. baseline website → system URL (custom domain never required)")
check("tenantWebsitePath is the ONE spelling: /site/<slug>", tenantWebsitePath("acme-1a2b") === "/site/acme-1a2b")
check("app/site/[slug]/page.tsx exists and resolves the brokerage by its slug", existsSync(join(ROOT, SITE_PAGE)) && /\.from\("brokerages"\)[\s\S]{0,400}\.eq\("slug",\s*slug\)/.test(code(SITE_PAGE)))
{
  const r = code(READINESS)
  const websiteCheck = r.slice(r.indexOf("website: async"), r.indexOf("website: async") + 1200)
  check("readiness `website` check reads the slug through tenantWebsitePath", /tenantWebsitePath\(/.test(websiteCheck))
  const tcdFinder = /tenant_custom_domains/
  check("readiness never reads tenant_custom_domains — a custom domain is never required to be READY", !tcdFinder.test(r))
  check("POSITIVE CONTROL: the finder sees the table name in a fixture", tcdFinder.test(`svc.from("tenant_custom_domains").select("id")`))
  const b = code(BASELINE)
  check("operating baseline lists `website` among REQUIRED_BASELINE_ITEMS and no custom-domain item", /REQUIRED_BASELINE_ITEMS[^\n]*"website"/.test(b) && !/custom_domain|tenant_custom_domains/.test(b))
}

// ── B. VALIDATION ────────────────────────────────────────────────────────────
section("B. validation — a host the tenant owns, nothing else")
const reserved = ["app.example-platform.test"]
for (const bad of ["https://www.acme.com", "acme.com/path", "acme.com:8080", "foo.vercel.app", "vercel.app", "www.app.example-platform.test", "acme", "", "ac me.com"]) {
  check(`refuses ${JSON.stringify(bad)}`, validateCustomDomain(bad, reserved).ok === false)
}
check("accepts www.acme.com unchanged", (() => { const v = validateCustomDomain("www.acme.com", reserved); return v.ok && v.domain === "www.acme.com" })())
check("normalizes case + trailing dot (Acme.COM. → acme.com)", (() => { const v = validateCustomDomain("Acme.COM.", reserved); return v.ok && v.domain === "acme.com" })())
check("apex and www stay DISTINCT hosts (www is never folded)", (() => { const a = validateCustomDomain("acme.com"); const w = validateCustomDomain("www.acme.com"); return a.ok && w.ok && a.domain !== w.domain })())

// ── C. PER-PROVIDER INSTRUCTIONS ────────────────────────────────────────────
section("C. per-provider DNS instructions (same values, each console's own steps)")
check("the provider roster is GoDaddy / Cloudflare / Namecheap / Squarespace Domains / other", [...DNS_PROVIDERS].sort().join(",") === ["cloudflare", "godaddy", "namecheap", "other", "squarespace"].join(","))
for (const host of ["acme.com", "www.acme.com"]) {
  const base = dnsInstructionsFor(host)
  for (const p of DNS_PROVIDERS) {
    const g = dnsProviderGuide(p, host)
    const apex = host === "acme.com"
    check(`${p} / ${host}: label + console path + ≥1 step + ≥1 caution`, g.provider === p && g.label.length > 0 && g.consolePath.length > 0 && g.steps.length >= 1 && g.cautions.length >= 1)
    check(`${p} / ${host}: exact standard value from the one source`, g.records.length === base.length && g.records.every((r, i) => r.value === base[i].value && r.type === base[i].type)
      && (apex ? g.records[0].type === "A" && g.records[0].value === VERCEL_APEX_A_TARGET && g.records[0].name === "@" : g.records[0].type === "CNAME" && g.records[0].value === VERCEL_CNAME_TARGET && g.records[0].name === "www"))
    check(`${p} / ${host}: guide text is tenant-safe (no provider internals)`, ![g.consolePath, ...g.steps, ...g.cautions].some((t) => /VERCEL_|api\.vercel|token/i.test(t)))
  }
}
check("Cloudflare guide carries the DNS-only (proxy off) trap", (() => { const g = dnsProviderGuide("cloudflare", "www.acme.com"); return /DNS only/i.test([...g.steps, ...g.cautions].join(" ")) })())
check("an unknown provider key gets the generic guide, never a refusal", dnsProviderGuide("not-a-provider", "acme.com").provider === "other" && dnsProviderGuide("??", "acme.com").label === dnsProviderGuide("other", "acme.com").label)

// ── D. DNS PROBE ─────────────────────────────────────────────────────────────
section("D. DNS probe — immediate feedback, fail closed")
const dnsErr = (c: string) => Object.assign(new Error(c), { code: c })
const resolver = (a: string[] | string, cname: string[] | string): DnsProbeResolver => ({
  resolve4: async () => { if (typeof a === "string") throw dnsErr(a); return a },
  resolveCname: async () => { if (typeof cname === "string") throw dnsErr(cname); return cname },
})
const now = new Date("2026-10-14T12:00:00.000Z")
await (async () => {
  const apexOk = await probeDomainDns("acme.com", { resolver: resolver([VERCEL_APEX_A_TARGET], "ENODATA"), now })
  check("apex with the A target → checked + matches", apexOk.checked && apexOk.matches && apexOk.checkedAt === now.toISOString())
  const wwwOk = await probeDomainDns("www.acme.com", { resolver: resolver("ENODATA", [`${VERCEL_CNAME_TARGET.toUpperCase()}.`]), now })
  check("www CNAME target (mixed case, trailing dot) → matches", wwwOk.checked && wwwOk.matches)
  const wwwA = await probeDomainDns("www.acme.com", { resolver: resolver([VERCEL_APEX_A_TARGET], "ENODATA"), now })
  check("www pointed by A at the apex target also matches (either standard target routes)", wwwA.checked && wwwA.matches)
  const wrong = await probeDomainDns("acme.com", { resolver: resolver(["203.0.113.9"], "ENODATA"), now })
  check("wrong value → checked, no match, reason names the expected record", wrong.checked && !wrong.matches && wrong.reason.includes(VERCEL_APEX_A_TARGET) && wrong.reason.includes("203.0.113.9"))
  const none = await probeDomainDns("www.acme.com", { resolver: resolver("ENOTFOUND", "ENOTFOUND"), now })
  check("no record at all → checked, no match, 'not visible yet' with the record to add", none.checked && !none.matches && /No DNS record is visible yet/.test(none.reason) && none.reason.includes(VERCEL_CNAME_TARGET))
  const broken = await probeDomainDns("acme.com", { resolver: resolver("ETIMEOUT", "ESERVFAIL"), now })
  check("FAIL CLOSED: a resolver that cannot answer → checked:false AND matches:false", broken.checked === false && broken.matches === false)
  const half = await probeDomainDns("acme.com", { resolver: resolver("ETIMEOUT", "ENODATA"), now })
  check("FAIL CLOSED: one lookup timed out, the other had no data → not checked (never 'looks fine')", half.checked === false && half.matches === false)
  // The standard DNS VALUES (the public record the tenant must type) are not a leak — they are the
  // instruction. Everything else in a reason is held to the tenant rule.
  const minusTargets = (t: string) => t.split(VERCEL_CNAME_TARGET).join("").split(VERCEL_APEX_A_TARGET).join("")
  check("every probe reason is tenant-safe (beyond the public record values themselves)", ![apexOk, wwwOk, wwwA, wrong, none, broken, half].some((p) => TENANT_LEAK.test(minusTargets(p.reason))))
  check("POSITIVE CONTROL: the leak finder sees a provider name / env key", TENANT_LEAK.test(minusTargets("Vercel API error")) && TENANT_LEAK.test(minusTargets("VERCEL_TOKEN is not set")))
})()

// ── E. STATE MACHINE ─────────────────────────────────────────────────────────
section("E. state machine — one table over the live CHECK vocabulary")
const SIGNALS: CustomDomainSignal[] = ["attach_ok_verified", "attach_ok_unverified", "attach_failed", "check_verified", "check_unverified", "check_failed", "routing_unavailable", "remove", "revive"]
const live = (CHECK_VOCABULARIES.tenant_custom_domains?.status ?? []).slice().sort()
check("CUSTOM_DOMAIN_STATUSES == the live CHECK vocabulary (one vocabulary, generated cache)", live.length > 0 && live.join(",") === [...CUSTOM_DOMAIN_STATUSES].sort().join(","), `live=${live.join(",")}`)
{
  let inside = 0, total = 0
  const promoters = new Set<CustomDomainSignal>()
  for (const s of CUSTOM_DOMAIN_STATUSES) for (const g of SIGNALS) {
    total++
    const n = nextCustomDomainStatus(s, g)
    if ((CUSTOM_DOMAIN_STATUSES as readonly string[]).includes(n)) inside++
    if (n === "active" && s !== "active") promoters.add(g)
  }
  check(`every transition lands inside the vocabulary (${inside}/${total})`, inside === total)
  check("ONLY a verified routing signal promotes to active (attach_ok_verified, check_verified)", [...promoters].sort().join(",") === "attach_ok_verified,check_verified")
  check("routing_unavailable is the identity on every status (fail closed: nothing learned, nothing promoted)", CUSTOM_DOMAIN_STATUSES.every((s) => nextCustomDomainStatus(s, "routing_unavailable") === s))
  check("removed is absorbing except revive → pending_dns", SIGNALS.filter((g) => g !== "revive").every((g) => nextCustomDomainStatus("removed", g) === "removed") && nextCustomDomainStatus("removed", "revive") === "pending_dns")
  check("remove from any non-removed status → removed", CUSTOM_DOMAIN_STATUSES.filter((s) => s !== "removed").every((s) => nextCustomDomainStatus(s, "remove") === "removed"))
  check("an unverified check demotes an active row to verifying (honest: DNS broke)", nextCustomDomainStatus("active", "check_unverified") === "verifying")
  // DERIVED post-condition: what pending_dns can reach by an attach signal or no routing.
  const derived = new Set<CustomDomainStatus>(["attach_ok_verified", "attach_ok_unverified", "attach_failed", "routing_unavailable"].map((g) => nextCustomDomainStatus("pending_dns", g as CustomDomainSignal)))
  check("CONNECT_POST_CONDITION_STATUSES == the set DERIVED from the table (no hard-coded drift)", [...derived].sort().join(",") === [...CONNECT_POST_CONDITION_STATUSES].sort().join(","), `derived=${[...derived].join(",")} declared=${[...CONNECT_POST_CONDITION_STATUSES].join(",")}`)
}

// ── F. TENANT-SANITIZED ERRORS ──────────────────────────────────────────────
section("F. tenant-sanitized errors — capability status only")
{
  const codes = [null, "domain_taken", "domain_already_in_use", "conflict", "not_found", "network_error", "http_500", "forbidden", "invalid_domain", "routing_unavailable", "some_unknown_code", "replay"]
  let leaky: string[] = [], empty = 0
  for (const s of CUSTOM_DOMAIN_STATUSES) for (const c of codes) {
    const m = tenantFacingDomainMessage(s, c)
    if (!m) empty++
    if (TENANT_LEAK.test(m)) leaky.push(`${s}/${c}: ${m}`)
  }
  check(`every status × code yields a non-empty tenant sentence (${CUSTOM_DOMAIN_STATUSES.length * codes.length} cells)`, empty === 0)
  check("no tenant sentence names a provider, env key, API code or credential", leaky.length === 0, leaky.slice(0, 2).join(" | "))
  check("active → the live sentence; error with an unknown code → the generic error line (never the raw code)", /^Live/.test(tenantFacingDomainMessage("active")) && !/some_unknown_code/.test(tenantFacingDomainMessage("error", "some_unknown_code")))
  // The staff note is module-private (its only reader is the routing client's `instructions`) — read from
  // the stripped source: the `const VERCEL_NOT_CONFIGURED_NOTE = "…" + "…"` concatenation, literals joined.
  const libSrc = code(LIB)
  const staffStart = libSrc.indexOf("const VERCEL_NOT_CONFIGURED_NOTE")
  const staffDecl = libSrc.slice(staffStart, libSrc.indexOf("const ROUTING_UNAVAILABLE_TENANT_NOTE", staffStart))
  const staffNote = stringLiterals(staffDecl).join("")
  check("POSITIVE CONTROL: the staff-note slice is non-empty (the declaration was found)", staffStart >= 0 && staffNote.length > 40)
  check("the STAFF note names the env keys; the TENANT note does not (two strings, two audiences)", /VERCEL_TOKEN/.test(staffNote) && !TENANT_LEAK.test(ROUTING_UNAVAILABLE_TENANT_NOTE))
  check("the staff note is module-private — no export, no reader outside the routing client", !/export const VERCEL_NOT_CONFIGURED_NOTE/.test(libSrc) && (libSrc.match(/VERCEL_NOT_CONFIGURED_NOTE/g) ?? []).length >= 3)
  check("neither note says 'registration' (the platform attaches a domain the tenant owns; it never registers one)", !/registration/i.test(staffNote) && !/registration/i.test(ROUTING_UNAVAILABLE_TENANT_NOTE))
  const a = code(ACTIONS)
  check("actions forward the TENANT note to the panel and never the staff note", /routingNote:\s*routing \? null : ROUTING_UNAVAILABLE_TENANT_NOTE/.test(a) && !/VERCEL_NOT_CONFIGURED_NOTE/.test(a))
  const viewShape = a.slice(a.indexOf("export interface CustomDomainView"), a.indexOf("export interface CustomDomainsPanel"))
  const viewBuilder = a.slice(a.indexOf("function rowToView"), a.indexOf("const ROW_COLUMNS"))
  check("the tenant view carries tenantMessage (mapper) and no raw errorDetail / vercelConfigured field", /tenantMessage:\s*tenantFacingDomainMessage\(/.test(viewBuilder) && !/errorDetail/.test(viewShape + viewBuilder) && !/vercelConfigured/.test(a))
  check("POSITIVE CONTROL: the view finder would see a raw error_detail forwarded", /errorDetail/.test(`errorDetail: row.error_detail ?? null,`))
  const actionLits = stringLiterals(a).filter((s) => /Vercel|VERCEL_/.test(s))
  check("no string literal in the actions names the provider (identifiers may; tenant-visible text may not)", actionLits.length === 0, actionLits.join(" | "))
  const cardLits = stringLiterals(code(CARD))
  check("the card's strings never name the provider or say platform-covered", !cardLits.some((s) => /Vercel|VERCEL_|platform-covered/.test(s)))
  check("POSITIVE CONTROL: the literal extractor sees a leaking string", stringLiterals(`const x = "Vercel rejected it"`).some((s) => /Vercel/.test(s)))
}

// ── G. NO REGISTRAR PATH ────────────────────────────────────────────────────
section("G. no registrar / purchase path — the platform never sells, registers or hosts a domain")
{
  const REGISTRAR = /\bbuy_domain\b|\bbuyDomain\b|\bpurchase_domain\b|\bpurchaseDomain\b|\bregisterDomain\b|\/domains\/(?:buy|purchase|register)\b|\bregistrar\b|\bbuy a domain\b|\bpurchase a domain\b/i
  const files = [LIB, ACTIONS, CARD, PROXY]
  const hits = files.filter((f) => REGISTRAR.test(code(f)))
  check(`no registrar/purchase endpoint or affordance across ${files.length} rail files (stripped)`, hits.length === 0, hits.join(", "))
  check("POSITIVE CONTROL: the finder catches a purchase endpoint and a buy affordance", REGISTRAR.test(`await vercelFetch(cfg, "/v4/domains/buy", { method: "POST" })`) && REGISTRAR.test(`mcp.buy_domain({ name })`) && REGISTRAR.test(`<Button>Buy a domain</Button>`))
  const lib = code(LIB)
  // `${base}/verify` composes from the status call's own base path — resolve it before judging.
  const baseLit = (lib.match(/const base = `([^`]*)`/) ?? [])[1] ?? ""
  const paths = [...lib.matchAll(/vercelFetch\(\s*cfg,\s*`([^`]*)`/g)].map((m) => m[1].split("${base}").join(baseLit))
  const PROJECT_DOMAIN_PATH = /^\/v\d+\/projects\/\$\{cfg\.projectId\}\/domains/
  check(`every routing-layer call is a PROJECT-domain endpoint (${paths.length} calls)`, paths.length >= 3 && paths.every((p) => PROJECT_DOMAIN_PATH.test(p)), paths.join(" | "))
  check("POSITIVE CONTROL: the endpoint rule refuses a registrar path", !PROJECT_DOMAIN_PATH.test("/v4/domains/buy") && !PROJECT_DOMAIN_PATH.test("/v5/domains/${domain}"))
  // Ownership stays with the tenant: the rail writes ONE tenant-anchored table and no platform asset.
  const a = code(ACTIONS)
  check("the rail writes no platform asset table", !/\.from\("platform_[a-z_]*"\)\s*\.(insert|update|upsert)/.test(a))
  const writeChunks = (src: string) => src.split(`.from("tenant_custom_domains")`).slice(1).filter((c) => /^\s*\.(insert|update)\(/.test(c))
  const chunks = writeChunks(a)
  check(`every tenant_custom_domains write carries the SESSION tenant (${chunks.length} writes)`, chunks.length >= 4 && chunks.every((c) => /brokerage_id/.test(c.slice(0, 700))))
  check("POSITIVE CONTROL: the write finder sees a tenant-less update", (() => { const w = writeChunks(`svc.from("tenant_custom_domains").update({ status: "active" }).eq("id", id)`); return w.length === 1 && !/brokerage_id/.test(w[0]) })())
}

// ── H. ROUTING ──────────────────────────────────────────────────────────────
section("H. routing — a vanity host serves only an ACTIVE row, never another tenant")
{
  const p = code(PROXY)
  const lookup = p.slice(p.indexOf("async function customDomainSiteSlug"))
  check("proxy resolves the host from tenant_custom_domains with status = active only", /\.from\("tenant_custom_domains"\)[\s\S]{0,300}\.eq\("status",\s*"active"\)/.test(lookup))
  check("proxy never serves another tenant's /site under a vanity host", /requested !== slug/.test(p))
  check("proxy engages only for non-platform hosts", /!isPlatformHost\(host\)/.test(p))
  check("POSITIVE CONTROL: the active-only finder would see a status-less lookup as missing", !/\.from\("tenant_custom_domains"\)[\s\S]{0,300}\.eq\("status",\s*"active"\)/.test(`svc.from("tenant_custom_domains").select("brokerage_id").eq("domain", host).maybeSingle()`))
}

// ── I. WIRING ────────────────────────────────────────────────────────────────
section("I. wiring — event, ledger, entitlement, post-condition, roster, session")
{
  const lib = code(LIB)
  const a = code(ACTIONS)
  const reporter = lib.slice(lib.indexOf("export async function reportCustomDomainOutcome"))
  check("KernelEvent has CUSTOM_DOMAIN_CONNECTED / _VERIFIED / _ERROR", KernelEvent.CUSTOM_DOMAIN_CONNECTED === "custom_domain_connected" && KernelEvent.CUSTOM_DOMAIN_VERIFIED === "custom_domain_verified" && KernelEvent.CUSTOM_DOMAIN_ERROR === "custom_domain_error")
  check("the ONE reporter emits all three through emitKernelEvent (audit row, client seam)", ["CUSTOM_DOMAIN_CONNECTED", "CUSTOM_DOMAIN_VERIFIED", "CUSTOM_DOMAIN_ERROR"].every((e) => reporter.includes(`KernelEvent.${e}`)) && /emitKernelEvent\(\{/.test(reporter) && /auditOnly:\s*true/.test(reporter) && /client:\s*params\.client/.test(reporter))
  check("the event metadata carries the error CODE, never the raw message", /error_code:\s*params\.errorCode/.test(reporter.slice(0, reporter.indexOf("publishManagerSignal"))) && !/errorDetail/.test(reporter.slice(reporter.indexOf("emitKernelEvent({"), reporter.indexOf("} catch"))))
  const reader = WEBHOOK_EVENT_CATALOG.find((d) => d.internalTypes.includes(KernelEvent.CUSTOM_DOMAIN_VERIFIED))
  check("READER: the tenant webhook catalogue fans CUSTOM_DOMAIN_VERIFIED out as website.domain_verified with a primitive-only allow-list", !!reader && reader.event === "website.domain_verified" && reader.payloadFields.every((f) => ["domain", "status"].includes(f)))
  check("READER: the governed bus catalogues custom_domain_verified + custom_domain_error", !!SIGNAL_REGISTRY["custom_domain_verified"] && !!SIGNAL_REGISTRY["custom_domain_error"])
  check("actions report connected after the post-condition, verified on active, error on failure", /outcome:\s*"connected"/.test(a) && (a.match(/outcome:\s*"verified"/g) ?? []).length >= 2 && (a.match(/outcome:\s*"error"/g) ?? []).length >= 3)
  const ledgerActions = new Set([...a.matchAll(/action:\s*"custom_domain\.(attach|verify|detach)"/g)].map((m) => m[1]))
  check("LAW 5: exactly attach / verify / detach are ledgered (withActionLedger, HUMAN_REQUESTED, the human as actor)", [...ledgerActions].sort().join(",") === "attach,detach,verify" && /withActionLedger/.test(a) && (a.match(/reasonCode:\s*"HUMAN_REQUESTED"/g) ?? []).length >= 2 && /actor:\s*\{\s*type:\s*"user",\s*userId/.test(a))
  check("LAW 2: mayUseAndAfford gates connect and remove (app.access)", /mayUseAndAfford\(\{[^}]*capability:\s*"app\.access"/.test(a) && (a.match(/tenantMayChangeDomains\(gate\)/g) ?? []).length >= 2)
  check("IMMEDIATE post-condition: the row is re-read under its tenant after connect AND verify", (a.match(/await confirmDomainRowPostCondition\(/g) ?? []).length >= 2 && /\.eq\("id",\s*id\)\.eq\("brokerage_id",\s*brokerageId\)\.maybeSingle\(\)/.test(a.slice(a.indexOf("async function confirmDomainRowPostCondition"))))
  check("the connect post-condition uses the DERIVED admitted set; a verify demands exactly the chosen status", /confirmDomainRowPostCondition\(svc,\s*gate\.brokerageId,\s*rowId,\s*CONNECT_POST_CONDITION_STATUSES\)/.test(a) && /confirmDomainRowPostCondition\(svc,\s*gate\.brokerageId,\s*id,\s*new Set\(\[nextStatus\]\)\)/.test(a))
  check("a failed post-condition returns the refusal (never ok:true past it)", /const post = await confirmDomainRowPostCondition[\s\S]{0,120}if \(!post\.ok\) return post/.test(a))
  check("DNS probe runs on connect AND on check; the state machine decides every status", (a.match(/await probeDomainDns\(domain\)/g) ?? []).length >= 2 && (a.match(/nextCustomDomainStatus\(/g) ?? []).length >= 3)
  const retyped = /new Set\(\[\s*"(broker|admin|broker_owner|broker_admin|team_lead)"/
  check("the admin gate is DERIVED from the roster (BROKERAGE_FINANCE_ADMIN_USER_TYPES), no retyped role list", /import \{ BROKERAGE_FINANCE_ADMIN_USER_TYPES \} from "@\/lib\/auth\/resolve-user-role"/.test(a) && /const ADMIN_TYPES[^\n]*=\s*BROKERAGE_FINANCE_ADMIN_USER_TYPES/.test(a) && !retyped.test(a))
  check("POSITIVE CONTROL: the retyped-roster finder sees a literal list", retyped.test(`const ADMIN_TYPES = new Set(["broker", "broker_owner", "broker_admin", "admin"])`))
  check("tenant from the SESSION: resolveWriteContextForTenant() takes no claimed tenant", /resolveWriteContextForTenant\(\)/.test(a) && !/resolveWriteContextForTenant\([^)]/.test(a))
  check("removal is COUNTED (CLAUDE.md §3): .select(\"id\") on the update and a zero-row refusal", /\.update\(\{\s*status:\s*nextCustomDomainStatus\(current,\s*"remove"\)[\s\S]{0,400}\.select\("id"\)/.test(a) && /\(removedRows \?\? \[\]\)\.length === 0/.test(a))
  const exportsAll = [...a.matchAll(/^export\s+(async\s+)?function\s+(\w+)/gm)]
  check(`every "use server" export is async (${exportsAll.length} exports)`, /^\s*"use server"/.test(raw(ACTIONS)) && exportsAll.length >= 4 && exportsAll.every((m) => !!m[1]))
  const card = code(CARD)
  check("the card renders provider guides, the DNS feedback and the tenant message (wired, not shelved)", /providerGuides/.test(card) && /d\.dns\b/.test(card) && /tenantMessage/.test(card) && /routingNote/.test(card))
}

// ── K. LANDING PAGES INSIDE THE TENANT WEBSITE (wave 143G) ───────────────────
section("K. landing pages live INSIDE the tenant website — tenant-proven, one renderer, served on the connected domain")
{
  const { memSupabase } = await import("./in-memory-supabase")
  const { resolveTenantLandingForm } = await import("../lib/tenant-site/landing-page")
  const { tenantLandingPagePath } = await import("../lib/kernel/tenant-creation")
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", GONE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
  const seed = () => ({
    brokerages: [
      { id: A, name: "Alpha Realty", slug: "alpha-1a2b", logo_url: null, primary_color: "#112233", deleted_at: null },
      { id: B, name: "Beta Homes", slug: "beta-3c4d", logo_url: "https://cdn.test/b.png", primary_color: null, deleted_at: null },
      { id: GONE, name: "Gone Co", slug: "gone-9z9z", logo_url: null, primary_color: null, deleted_at: "2026-01-01T00:00:00Z" },
    ],
    lead_capture_forms: [
      { id: "f-a", slug: "home-value-aaa", brokerage_id: A, is_active: true },
      { id: "f-b", slug: "buyer-guide-bbb", brokerage_id: B, is_active: true },
      { id: "f-gone", slug: "orphan-ccc", brokerage_id: GONE, is_active: true },
    ],
  })
  const svc = () => memSupabase(seed() as any)
  const own = await resolveTenantLandingForm(svc(), "alpha-1a2b", "home-value-aaa")
  check("a tenant's own landing page resolves through ITS website (site + form id returned)", own.ok && own.site.id === A && own.formId === "f-a" && own.site.name === "Alpha Realty" && own.site.primaryColor === "#112233")
  const cross = await resolveTenantLandingForm(svc(), "alpha-1a2b", "buyer-guide-bbb")
  check("ANOTHER tenant's landing page through this tenant's website is refused as not-found (no enumeration: same answer as a missing slug)", !cross.ok && cross.reason === "no_form", JSON.stringify(cross))
  const crossOwn = await resolveTenantLandingForm(svc(), "beta-3c4d", "buyer-guide-bbb")
  check("POSITIVE CONTROL: the same form through ITS OWN site resolves — the refusal above is the tenant predicate, not a missing row", crossOwn.ok && crossOwn.site.id === B && crossOwn.formId === "f-b")
  const missing = await resolveTenantLandingForm(svc(), "alpha-1a2b", "does-not-exist")
  check("an unknown landing slug on a real site is not-found", !missing.ok && missing.reason === "no_form")
  const noSite = await resolveTenantLandingForm(svc(), "nobody-0000", "home-value-aaa")
  check("an unknown site slug is no_site (the page 404s)", !noSite.ok && noSite.reason === "no_site")
  const deleted = await resolveTenantLandingForm(svc(), "gone-9z9z", "orphan-ccc")
  check("a DELETED brokerage's website serves no landing page (deleted_at honoured)", !deleted.ok && deleted.reason === "no_site")
  const blank = await resolveTenantLandingForm(svc(), "  ", "home-value-aaa")
  check("a blank site slug is refused before any read", !blank.ok)
  const refusedSite = await resolveTenantLandingForm(memSupabase(seed() as any, { refuse: { brokerages: "RLS refused" } }), "alpha-1a2b", "home-value-aaa")
  const refusedForm = await resolveTenantLandingForm(memSupabase(seed() as any, { refuse: { lead_capture_forms: "RLS refused" } }), "alpha-1a2b", "home-value-aaa")
  check("FAIL CLOSED: a refused tenant read OR a refused form read is `unreadable` — never rendered as checked-and-fine", !refusedSite.ok && refusedSite.reason === "unreadable" && !refusedForm.ok && refusedForm.reason === "unreadable")
  check("the in-website path is ONE spelling: /site/<slug>/lm/<form>, slug encoded", tenantLandingPagePath("alpha-1a2b", "home-value-aaa") === "/site/alpha-1a2b/lm/home-value-aaa" && tenantLandingPagePath("alpha-1a2b", "a b") === "/site/alpha-1a2b/lm/a%20b")

  // SOURCE (stripped): the route, the resolver's predicate, the storefront links, the proxy rewrite.
  const ROUTE = "app/site/[slug]/lm/[formSlug]/page.tsx", RESOLVER = "lib/tenant-site/landing-page.ts"
  check("the route exists", existsSync(join(ROOT, ROUTE)) && existsSync(join(ROOT, RESOLVER)))
  const route = code(ROUTE), resolver = code(RESOLVER)
  const TENANT_IN_QUERY = /from\("lead_capture_forms"\)[\s\S]{0,200}\.eq\("brokerage_id",\s*row\.id\)/
  check("the form is read WITH the site's brokerage in the predicate (tenant in the query, not compared after)", TENANT_IN_QUERY.test(resolver))
  check("POSITIVE CONTROL: the predicate finder rejects a slug-only read (the detached /lm/[slug] shape)", !TENANT_IN_QUERY.test(`svc.from("lead_capture_forms").select("id").eq("slug", form).maybeSingle()`))
  check("the route resolves through resolveTenantLandingForm and 404s on anything not ok", /resolveTenantLandingForm\(/.test(route) && /if \(!resolved\.ok\) notFound\(\)/.test(route))
  check("ONE renderer: the route renders the lead-magnet survivor's own page and imports no capture form of its own", /import LeadMagnetLandingPage, \{ generateMetadata as leadMagnetMetadata \} from "@\/app\/lm\/\[slug\]\/page"/.test(route) && /await LeadMagnetLandingPage\(/.test(route) && !/GenericCaptureForm|HomeValueForm|lead_capture_forms/.test(route))
  check("the page's canonical URL is the in-website path (search and AI search attribute it to the tenant's site)", /alternates:\s*\{\s*canonical:[\s\S]{0,120}tenantLandingPagePath\(/.test(route))
  const site = code(SITE_PAGE)
  const BARE_LM_HREF = /href=\{[^}]*`\/lm\//
  check("the storefront links its landing pages INSIDE the website (tenantLandingPagePath), never to the bare /lm/ host", /tenantLandingPagePath\(b\.slug,/.test(site) && !BARE_LM_HREF.test(site))
  check("POSITIVE CONTROL: the bare-/lm/ finder catches the retired link", BARE_LM_HREF.test("<a href={`/lm/${m.slug}`} className=\"x\">") && BARE_LM_HREF.test("href={valuationMagnet ? `/lm/${valuationMagnet.slug}` : \"#\"}"))
  const p = code(PROXY)
  const vanity = p.slice(p.indexOf("const slug = await customDomainSiteSlug(host)"), p.indexOf("// ── 1) Embed-blog CSP path"))
  check("proxy: a connected domain's /lm/<form> is rewritten to /site/<HOST's slug>/lm/<form> (single segment)", /\/\^\\\/lm\\\/\(\[\^\/\]\+\)\\\/\?\$\/\.exec\(pathname\)/.test(vanity) && /NextResponse\.rewrite\(new URL\(`\/site\/\$\{slug\}\/lm\/\$\{landing\[1\]\}\$\{request\.nextUrl\.search\}`/.test(vanity))
  check("proxy: the tenant in that rewrite is the host's mapped slug, never a value parsed from the path", !/\/site\/\$\{landing\[1\]\}/.test(vanity) && vanity.indexOf("landing") > vanity.indexOf("customDomainSiteSlug"))
  check("readiness `website` check states the landing capability (pattern in evidence) — no second key, the capability IS the website", /landingPagePattern:\s*tenantLandingPagePath\(slug,/.test(code(READINESS)))
}

// ── J. REGISTRATION ──────────────────────────────────────────────────────────
section("J. registration — chain membership, ownership, docs")
{
  const pkg = JSON.parse(raw("package.json")) as { scripts: Record<string, string> }
  check("package.json registers test:custom-domain-flow", /custom-domain-flow-guard\.ts/.test(pkg.scripts["test:custom-domain-flow"] ?? ""))
  check("the guard chain CONTAINS the proof (membership, never a position)", new RegExp("npm run test:custom-domain-flow(\\s|&|$)").test(pkg.scripts.guard ?? ""))
  const entry = Object.entries(MAINTENANCE_DOMAINS).find(([, d]) => d.proof === "test:custom-domain-flow")
  check("MAINTENANCE_DOMAINS names an owner for this proof", !!entry)
  if (entry) {
    const [, d] = entry
    check("the owner is the TABLE_MANAGER of tenant_custom_domains (one steward)", d.manager === TABLE_MANAGER["tenant_custom_domains"], `${d.manager} vs ${TABLE_MANAGER["tenant_custom_domains"]}`)
    const co = d.coOwners ?? []
    check("co-owners declared, real, not the owner, named in the entry's prose, licensed by canRefer", co.length >= 1 && co.every((k) => k in MANAGERS && k !== d.manager && d.what.includes(k) && canRefer(d.manager as ManagerKey, k as ManagerKey)))
  }
  check("the readiness matrix names this proof for the custom-domain row", /Custom domain for the website[^\n]*test:custom-domain-flow/.test(raw("docs/architecture/READINESS-MATRIX.md")))
}

console.log(`\n${pass} passed, ${fail} failed`)
console.log(`  denominators: ${CUSTOM_DOMAIN_STATUSES.length} statuses × ${SIGNALS.length} signals · ${DNS_PROVIDERS.length} providers × 2 hosts · rail files ${[LIB, ACTIONS, CARD, PROXY].length}`)
console.log("  blind spots: the actions layer is proven by stripped-source census + the pure functions it calls, not mounted (it is a \"use server\" module behind a session); the real DNS resolver and the routing API are never called here (resolver injected, routing proven by endpoint census); the proxy's host cache TTL is not exercised. K (wave 143G): the in-website landing ROUTE and the proxy rewrite are proven by stripped source + the resolver's behaviour over an in-memory client, NOT mounted in a running Next server (no browser, no real vanity-host request); the survivor page's own rendering is test:lead-magnet-* territory; app/sitemap.ts and the lead-magnet URL producers still emit the bare /lm/<slug> (other lanes' files).")
if (fail > 0) { console.log(`\nFAILED:\n  - ${fails.join("\n  - ")}`); process.exit(1) }
console.log("RESULT: custom-domain-flow PASS")
