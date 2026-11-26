#!/usr/bin/env tsx
/**
 * scripts/wave156-f-visitor-truth-guard.ts — wave 156, lane 156F (canaries C12, C18; directive 156F).
 *
 * CAPABILITY TRUTH FOR WEBSITE VISITORS. Owner: "the anonymous visitor sometimes can be identified using a provider, and
 * if you can't do it, we don't need to include it." The decision (docs/operations/WAVE156-VISITOR-IDENTITY-DECISION.md)
 * is DO NOT OFFER: no provider qualified. So the product must never simulate an identification — an anonymous visit stays
 * anonymous, only a first-party act links a visit to a record the tenant already holds, and only a certain match links.
 *
 * Every rule below DRIVES the real exported product code against the in-memory client (scripts/in-memory-supabase.ts),
 * with the network (globalThis.fetch) and every non-visitor seam replaced by COUNTED stubs. String scans are used only
 * where noted, always on comment-stripped source and with a positive control.
 *
 * §A  C12 — AN ANONYMOUS VISIT STAYS ANONYMOUS. The pixel records a session with no person on it; the site-visitor
 *     acquisition lane yields NO raw record and nothing that names the browser (RED at base: it minted a Raw Lead with
 *     `username = session_id`, which the RawData gates read as a person); an unknown email on a form creates no Contact,
 *     no Lead and links nothing; the territory-intelligence phase writes no off-site "view" onto an anonymous visitor
 *     (RED at base: it attributed a Zillow listing view to every visitor whose city matched).
 * §B  C18 — A FIRST-PARTY OPT-IN CREATES EXACTLY WHAT THE CAPTURE RULES DEFINE. A form submit carrying an email the
 *     tenant holds once links the session to that Contact (and creates nothing); a consented capture stores the email
 *     with its consent artifact and identifies the one matching contact; a capture without consent stores nothing.
 * §C  AN UNAPPROVED MATCH NEVER CALLS A VENDOR. Across every drive: 0 network calls (counted fetch). Census (comment-
 *     stripped app/ + lib/): no code names a visitor-identification vendor host; the one catalogd visitor-to-company
 *     endpoint (Versium ip2domain) is NOT_APPLICABLE with no caller. Positive controls for both finders.
 * §D  A LOW-CONFIDENCE / WRONG-PERSON MATCH IS SUPPRESSED. A household email held by two contacts, an email and a phone
 *     that point at two different people, an ambiguous contact that would fall through to the leads table, and the
 *     consented-capture match on a shared address — none links (RED at base: `.limit(1)` linked the first row).
 * §E  NO CROSS-TENANT IDENTIFIER LINKING. A session id fired under a second tenant's id does not move the session (RED at
 *     base: the upsert rewrote brokerage_id and carried the first tenant's contact link across); identify matches only
 *     inside the session's own tenant; the snippet keeps its id in the site's own storage and sets no cookie.
 * §F  DELETION AND OPT-OUT PROPAGATE. The DSAR erasure deletes the subject's visitor rows in its tenant and nothing else,
 *     fails closed on a refusal, and runs before the request is marked fulfilled (RED at base: the visitor rows survived
 *     an "anonymized" request). The identified-visitor reaction's newsletter enrollment honors email_opt_out and an
 *     earlier unsubscribe.
 *
 * ROUND 2 (integrator):
 *     §F also DRIVES the right-to-know export (fulfillExportRequestAction: the subject's visitor rows and evidence are in
 *     the bundle, nobody else's; a refused read aborts it) and the right-to-delete door itself (fulfillDeleteRequestAction:
 *     closes only after every delete — contact, visitor rows, identification evidence, a person row that existed only
 *     through it — and stays OPEN when one is refused), with the session seat as a fixture and the real role gate.
 * §G  A PUBLIC HIT IS BOUND TO THE TENANT'S OWN SITE. The pixel records a hit only when its Referer is a host the named
 *     tenant registered (active verified custom domain or declared website, via loadQrTenantHosts); the widget visit
 *     route only when a browser Origin is present and the Referer is that tenant's own widget page. trackBehavior is no
 *     longer a "use server" export (a public endpoint taking a tenant id); only the two tenant-deciding routes import it.
 *
 * ROOT override: VISITOR_TRUTH_ROOT=<tree> runs every drive against that tree's modules (red-at-base control).
 *
 * BLIND SPOTS (published). The in-memory client has no row security, no UNIQUE constraint on website_visitors.session_id
 * (the pixel's own read-then-write is what is proven) and no foreign keys. The DSAR doors are driven with the session
 * seat as a fixture (the session client is the in-memory client answering auth.getUser) and the ledger wrapper as a
 * pass-through; `update(…, { count: "exact" })` is answered by this guard's own client wrapper from the fake's write log
 * (the shared fake is unchanged). trackBehavior is driven only through the widget visit route; its model wrapper is a
 * counted stub (in production it refuses without a session). The Referer / Origin binding stops a BROWSER on another
 * site; a server-side caller can forge both headers — it can then write only into a tenant whose registered host or
 * widget page it names, and the per-IP throttle still applies; a shared secret per site would be the next step (not
 * built). The snippet is checked as text (it runs in a stranger's browser), not executed. The vendor census matches a
 * fixed list of known visitor-ID hosts and endpoint names (VISITOR_ID_VENDOR_MARKERS): a vendor not on the list is not
 * seen — §C's fetch counter is the behavioral half.
 */
import { registerHooks } from "node:module"
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

const WT = process.cwd()
const ROOT = process.env.VISITOR_TRUTH_ROOT || WT
let passed = 0, failed = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; fails.push(name); console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 300)}`}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const raw = (f: string, root = ROOT): string => { const p = join(root, f); return existsSync(p) ? readFileSync(p, "utf8") : "" }
const code = (f: string, root = ROOT): string => stripComments(raw(f, root))

// ═══ fixture world ════════════════════════════════════════════════════════════════════════════════════════════════════
const u = (p: string, n: number) => `${p}${String(n).padStart(7, "0")}-0000-4000-8000-000000000156`
const B1 = u("b", 1), B2 = u("b", 2), B3 = u("b", 3)
const U_BROKER = u("a", 1)
const C_ANN = u("c", 1), C_HOUSE1 = u("c", 2), C_HOUSE2 = u("c", 3), C_BOB = u("c", 4), C_X = u("c", 9)
const L_LEE = u("d", 1)
const ANN = "ann@example.test", HOUSE = "family@example.test", BOB_PHONE = "5551230000", LEE = "lee@example.test"

function world(extra: Record<string, Row[]> = {}, opts: Record<string, unknown> = {}): MemClient {
  return memSupabase({
    // ROUND 2: each tenant's REGISTERED site (the declared brand website) and public widget slug.
    brokerages: [{ id: B1, slug: "alpha", name: "Alpha", widget_enabled: true, status: "active", deleted_at: null, website: null }, { id: B2, slug: "beta", name: "Beta", widget_enabled: true, status: "active", deleted_at: null, website: null }, { id: B3, slug: "gamma", name: "Gamma", widget_enabled: true, status: "active", deleted_at: null, website: null }],
    brokerage_brand_settings: [{ id: "bbs-1", brokerage_id: B1, website_url: "https://tenant.example" }, { id: "bbs-2", brokerage_id: B2, website_url: "other.example" }],
    tenant_custom_domains: [{ id: "tcd-1", brokerage_id: B2, domain: "homes.beta.test", status: "active" }, { id: "tcd-2", brokerage_id: B2, domain: "pending.beta.test", status: "pending_dns" }],
    users: [{ id: U_BROKER, brokerage_id: B1, user_type: "broker", email: "broker@alpha.test" }],
    person_identities: [], person_identity_evidence: [], data_subject_requests: [], audit_log: [],
    contacts: [
      { id: C_ANN, brokerage_id: B1, email: ANN, phone: null, first_name: "Ann", last_name: "A", email_opt_out: false },
      { id: C_HOUSE1, brokerage_id: B1, email: HOUSE, phone: null, first_name: "P1", last_name: "H" },
      { id: C_HOUSE2, brokerage_id: B1, email: HOUSE, phone: null, first_name: "P2", last_name: "H" },
      { id: C_BOB, brokerage_id: B1, email: "bob@example.test", phone: BOB_PHONE, first_name: "Bob", last_name: "B" },
      { id: C_X, brokerage_id: B2, email: "only-in-b2@example.test", phone: null, first_name: "X", last_name: "X" },
    ],
    leads: [{ id: L_LEE, brokerage_id: B1, email: LEE, phone: null, is_active: true, contact_id: null }],
    website_visitors: [], behavioral_signals: [], site_activity: [], external_behavior: [], raw_scraped_leads: [],
    contact_consent_events: [], newsletter_subscribers: [], self_heal_events: [], agent_action_ledger: [],
    ...extra,
  }, { uuidIds: true, ...opts } as any)
}

// ═══ seams (installed BEFORE any app module loads) ════════════════════════════════════════════════════════════════════
const G = globalThis as any
G.__VT = { mem: world() as MemClient, seat: null as string | null, calls: { fetch: 0, kernelEvents: 0, trackExternal: 0, consentWrites: 0, ledger: 0, model: 0, trackStub: 0 } }
/**
 * The service client the product sees: the in-memory client, plus supabase-js's `update(patch, { count: "exact" })`
 * answer (the matched-row count the DSAR doors close on), added HERE rather than in the shared fake so no other proof's
 * behavior moves. The count is the update's own matched rows (the fake's write log), never assumed.
 */
G.__VT.svc = () => {
  const m = G.__VT.mem as MemClient
  return new Proxy(m, { get(t: any, k) {
    if (k === "auth") return { getUser: async () => ({ data: { user: G.__VT.seat ? { id: G.__VT.seat, email: "seat@example.test" } : null }, error: null }) }
    if (k !== "from") return t[k]
    return (table: string) => {
      const inner = t.from(table)
      let counted = false
      const wrap: any = new Proxy(inner, { get(bt: any, bk) {
        if (bk === "update") return (p: any, o?: { count?: string }) => { counted = o?.count === "exact"; bt.update(p); return wrap }
        if (bk === "then") return (res: any, rej: any) => bt.then((r: any) => res(counted && r && !r.error ? { ...r, count: m.writes[m.writes.length - 1]?.matched ?? 0 } : r), rej)
        const v = bt[bk]
        return typeof v === "function" ? (...a: unknown[]) => { const out = v.apply(bt, a); return out === bt ? wrap : out } : v
      } })
      return wrap
    }
  } })
}
const realFetch = globalThis.fetch
globalThis.fetch = (async (...a: unknown[]) => { G.__VT.calls.fetch++; throw new Error(`network refused in proof: ${String(a[0]).slice(0, 80)}`) }) as typeof fetch
void realFetch

const realUrl = (p: string) => pathToFileURL(join(ROOT, p)).href
const OVERRIDE: Record<string, string> = {
  "lib/supabase/service.ts": "export function createServiceClient(){ return globalThis.__VT.svc() }",
  "lib/supabase/server.ts": "export async function createClient(){ return globalThis.__VT.svc() }; export async function createServerClient(){ return globalThis.__VT.svc() }",
}
const REPLACE: Record<string, string> = {
  "lib/kernel/index.ts": "export async function processKernelEvent(){ globalThis.__VT.calls.kernelEvents++; return { ok: true } }",
  "lib/kernel/action-ledger.ts": "export async function withActionLedger(_m, fn){ globalThis.__VT.calls.ledger++; return await fn() }; export async function ledgerSessionAction(_m, fn){ return await fn() }",
  "lib/kernel/compliance/require-contact-consent.ts": "export async function persistContactConsent(p){ globalThis.__VT.calls.consentWrites++; const id = 'consent-' + globalThis.__VT.calls.consentWrites; globalThis.__VT.mem.tables.contact_consent_events.push({ id, brokerage_id: p.brokerageId, consented: p.consented, consent_text: p.consentText }); return { consentEventId: id } }",
  "lib/kernel/person-identity.ts": "export async function resolvePerson(){ return { ok: false, reason: 'no_identity_anchor' } }; export async function linkPersonEvidence(){ return { ok: true } }",
  "lib/errors/collect-error.ts": "export async function collectError(){ return null }",
  // The model wrapper refuses without a session in production; here it is a COUNTED stub (no provider is reached).
  "app/actions/ai-generate.ts": "export async function generateAIJSON(){ globalThis.__VT.calls.model++; return { data: null, error: 'fixture' } }",
  "lib/enrichment/protected-research-store.ts": "export async function readProtectedAttributes(){ return { ok: true, attributes: [] } }",
  "lib/lead-pipeline/scrape-territories.ts": `export async function resolveActiveScrapeTerritories(){ return { noOp: false, territories: [{ id: 'terr-1', brokerage_id: ${JSON.stringify(B1)}, city: 'Pace', state: 'FL', zip_codes: ['32571'] }] } }`,
  "app/actions/lead-intelligence.ts": "const c = () => globalThis.__VT.calls; export async function scrapeSocialSignalsWithZenRows(){ return { rawIngested: 0 } }; export async function scrapeExternalBehavior(){ return { rawIngested: 0, discoveredAddresses: ['12 Oak St, Pace, FL'] } }; export async function analyzeGoogleSearchIntent(){ return { success: false } }; export async function enrichPropertyIntelligence(){ return { success: false } }; export async function trackBehavior(d){ c().trackStub++; globalThis.__VT.mem.tables.behavioral_signals.push({ id: 'bs-stub-' + c().trackStub, brokerage_id: d.brokerage_id, visitor_id: d.visitor_id }); return { success: true } }; export async function trackExternalActivity(d){ c().trackExternal++; globalThis.__VT.mem.tables.external_behavior.push({ id: 'eb-' + c().trackExternal, brokerage_id: " + JSON.stringify(B1) + ", activity_type: d.behaviorType, property_addresses_viewed: [d.propertyAddress] }); return { success: true } }",
}
const BY_SPEC: Record<string, string> = {
  "server-only": "export {}",
  "next/cache": "export function revalidatePath(){}; export function revalidateTag(){}",
  "next/headers": "export async function headers(){ return new Map() }; export async function cookies(){ return { get(){}, getAll(){ return [] } } }",
}
const dataUrl = (c: string) => `data:text/javascript,${encodeURIComponent(c)}`
function aliasPath(rel: string): string | null {
  for (const c of [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`, `${rel}/index.tsx`]) {
    const p = join(ROOT, c)
    if (existsSync(p) && !statSync(p).isDirectory()) return p
  }
  return null
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (BY_SPEC[spec] !== undefined) return { url: dataUrl(BY_SPEC[spec]), shortCircuit: true }
    const aliased = spec.startsWith("@/") ? aliasPath(spec.slice(2)) : null
    const r = aliased ? { url: pathToFileURL(aliased).href, shortCircuit: true } : next(spec, ctx)
    if (String(ctx?.parentURL ?? "").startsWith("data:")) return r
    const path = String(r.url ?? "").split("?")[0]
    const rep = Object.keys(REPLACE).find((k) => path === realUrl(k))
    if (rep) return { url: dataUrl(REPLACE[rep]), shortCircuit: true }
    const ov = Object.keys(OVERRIDE).find((k) => path === realUrl(k))
    if (ov) return { url: dataUrl(`export * from ${JSON.stringify(realUrl(ov))}; ${OVERRIDE[ov]}`), shortCircuit: true }
    return r
  },
})

const load = async (p: string): Promise<any> => { try { return await import(pathToFileURL(join(ROOT, p)).href) } catch (e) { return { __loadError: (e as Error).message } } }
function fresh(extra: Record<string, Row[]> = {}, opts: Record<string, unknown> = {}): MemClient {
  G.__VT.mem = world(extra, opts)
  return G.__VT.mem
}
const quiet = async <X,>(fn: () => Promise<X>): Promise<X> => {
  const w = console.warn, e = console.error, l = console.log
  console.warn = () => {}; console.error = () => {}; console.log = () => {}
  try { return await fn() } finally { console.warn = w; console.error = e; console.log = l }
}
async function drive<X>(fn: () => Promise<X>): Promise<{ r: X | undefined; threw: string | null }> {
  try { return { r: await quiet(fn), threw: null } } catch (e) { return { r: undefined, threw: (e as Error)?.message ?? String(e) } }
}
function walk(dir: string, out: string[] = []): string[] {
  const p = join(ROOT, dir)
  if (!existsSync(p)) return out
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(rel, out) }
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(rel)
  }
  return out
}
let ipN = 0
const nextIp = () => `203.0.113.${(++ipN % 250) + 1}`

async function main() {
  const { NextRequest } = await import("next/server")
  const pixel = await load("app/api/track/pixel/route.ts")
  const identify = await load("app/api/track/identify/route.ts")
  const sourcer = await load("lib/lead-pipeline/site-visitor-sourcer.ts")
  const rawTypes = await load("lib/lead-pipeline/raw-record-types.ts")
  const capture = await load("lib/lead-intelligence/visitor-email-capture.ts")
  const linkRule = await load("lib/lead-intelligence/visitor-link-decision.ts")
  const erasure = await load("lib/privacy/visitor-data-erasure.ts")
  const newsletter = await load("lib/content/newsletter-enrollment.ts")
  const intentCampaign = await load("lib/kernel/intent-campaign.ts")

  const firePixel = (b: string, s: string, page = "https://tenant.example/listings/12-oak", referer?: string | null) =>
    pixel.GET(new NextRequest(`https://app.test/api/track/pixel?b=${b}&s=${s}&p=${encodeURIComponent(page)}`, { headers: { "x-forwarded-for": nextIp(), ...(referer === null ? {} : { referer: referer ?? page }) } }))
  const postIdentify = (body: Record<string, unknown>) =>
    identify.POST(new NextRequest("https://app.test/api/track/identify", { method: "POST", body: JSON.stringify(body), headers: { "x-forwarded-for": nextIp() } }))
  const visitorRow = (s: string) => G.__VT.mem.tables.website_visitors.find((r: Row) => r.session_id === s)
  const count = (t: string) => (G.__VT.mem.tables[t] ?? []).length

  // ═══ §A ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§A  C12 — an anonymous visit stays anonymous")
  fresh()
  const contactsBefore = count("contacts"), leadsBefore = count("leads")
  const pa = await drive(() => firePixel(B1, "sess-anon-1"))
  const anonRow = visitorRow("sess-anon-1")
  check("A1 the pixel records the anonymous session in its tenant (positive: the door works)", !pa.threw && anonRow?.brokerage_id === B1, pa.threw ?? anonRow)
  check("A2 that session carries no person — contact_id, lead_id and identified_at all empty", !!anonRow && !anonRow.contact_id && !anonRow.lead_id && !anonRow.identified_at, anonRow)
  check("A3 an anonymous page view creates no Contact, no Lead and no Raw Lead row", count("contacts") === contactsBefore && count("leads") === leadsBefore && count("raw_scraped_leads") === 0)

  // The acquisition lane over a qualifying anonymous session (long dwell, listing page, campaign, return visit).
  const now = new Date("2026-11-25T12:00:00Z")
  fresh({ website_visitors: [
    { id: "wv-1", brokerage_id: B1, session_id: "sess-anon-2", page_url: "https://tenant.example/listings/12-oak?email=ann%40example.test", referrer: "https://google.com", time_on_page_seconds: 240, first_seen_at: "2026-11-25T08:00:00Z", last_seen_at: "2026-11-25T11:30:00Z", utm_source: "google", utm_medium: "cpc", utm_campaign: null, agent_id: null, contact_id: null, lead_id: null, identified_at: null },
    { id: "wv-x", brokerage_id: B2, session_id: "sess-b2", page_url: "https://other.example/listings/1", referrer: null, time_on_page_seconds: 300, first_seen_at: "2026-11-25T11:00:00Z", last_seen_at: "2026-11-25T11:40:00Z", utm_source: null, utm_medium: null, utm_campaign: null, agent_id: null, contact_id: null, lead_id: null, identified_at: null },
  ] })
  const sv = await drive(() => sourcer.sourceSiteVisitorIntent(G.__VT.mem, B1, { now }))
  const svr = sv.r as any
  check("A4 the site-visitor lane READ the qualifying session (positive: it is not blind)", !sv.threw && svr?.rowsExamined === 1, sv.threw ?? svr?.rowsExamined)
  check("A5 the site-visitor lane hands the RawData producer NOTHING — an anonymous session is never a Raw Lead (RED at base: one record, username = session id)", Array.isArray(svr?.records) && svr.records.length === 0, svr?.records?.length)
  const viable = (svr?.records ?? []).filter((r: any) => rawTypes.isViableRecord?.(r))
  check("A6 nothing it returns clears the RawData viability gate as a person", viable.length === 0, viable.length)
  check("A7 nothing it returns names the browser — no session id, no typed email from the page's query string", !JSON.stringify(svr ?? {}).includes("sess-anon-2") && !JSON.stringify(svr ?? {}).includes("ann%40example.test"))
  check("A8 the aggregate value survives — the session is counted as a listing-page, return, campaign-referred reader", svr?.aggregate?.sessions === 1 && svr.aggregate.listingPageSessions === 1 && svr.aggregate.returnSessions === 1 && svr.aggregate.campaignReferredSessions === 1, svr?.aggregate)
  check("A9 POSITIVE CONTROL — the RawData gate DOES take a session id carried as `username` for a person (the shape this lane used to emit)", rawTypes.isViableRecord?.({ source: "site_visitor_intent", username: "sess-anon-2", sourceUrl: "https://tenant.example/listings/12-oak" }) === true)

  // A form that carries an email this tenant does not hold: nothing is created, nothing is linked.
  fresh({ website_visitors: [{ id: "wv-2", brokerage_id: B1, session_id: "sess-unknown", page_url: "https://tenant.example/", contact_id: null, lead_id: null, identified_at: null }] })
  G.__VT.calls.kernelEvents = 0
  const cB = count("contacts"), lB = count("leads")
  const iu = await drive(() => postIdentify({ sessionId: "sess-unknown", email: "stranger@example.test" }))
  const ur = visitorRow("sess-unknown")
  check("A10 an email the tenant does not hold creates no Contact and no Lead (no invented person)", !iu.threw && count("contacts") === cB && count("leads") === lB, iu.threw)
  check("A11 …and the session stays anonymous, no identification event", !ur?.contact_id && !ur?.lead_id && !ur?.identified_at && G.__VT.calls.kernelEvents === 0, ur)

  // The territory-intelligence phase must not write an off-site view nobody observed onto an anonymous visitor.
  fresh({ behavioral_signals: [{ id: "bs-1", brokerage_id: B1, visitor_id: "v-anon", city: "Pace", contact_id: null, identified: false }] })
  G.__VT.calls.trackExternal = 0
  const prevSecret = process.env.CRON_SECRET
  process.env.CRON_SECRET = "proof-secret"
  const tp = await drive(() => intentCampaign.runTerritoryIntelligencePhase(G.__VT.mem))
  process.env.CRON_SECRET = prevSecret
  check("A12 the territory phase ran over the territory (positive: the drive reached it)", !tp.threw && (tp.r as any)?.territoriesProcessed === 1, tp.threw ?? tp.r)
  check("A13 it attributes NO off-site listing view to an anonymous visitor by a shared city (RED at base: trackExternalActivity per city match)", G.__VT.calls.trackExternal === 0 && count("external_behavior") === 0, { calls: G.__VT.calls.trackExternal, rows: count("external_behavior") })

  const page = code("app/dashboard/admin/visitor-tracking/page.tsx")
  check("A14 the visitor page SAYS anonymous sessions stay anonymous and nothing is identified from an IP, device, location or provider", /Anonymous sessions stay anonymous/.test(page) && /does not identify visitors from an IP address/.test(page))

  // ═══ §B ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§B  C18 — a first-party opt-in creates exactly the record the capture rules define")
  fresh({ website_visitors: [{ id: "wv-3", brokerage_id: B1, session_id: "sess-ann", page_url: "https://tenant.example/", contact_id: null, lead_id: null, identified_at: null }] })
  G.__VT.calls.kernelEvents = 0
  const cB2 = count("contacts"), lB2 = count("leads")
  const ia = await drive(() => postIdentify({ sessionId: "sess-ann", email: ANN.toUpperCase() }))
  const ar = visitorRow("sess-ann")
  check("B1 a form submit with an email the tenant holds ONCE links the session to that Contact and stamps identified_at", !ia.threw && ar?.contact_id === C_ANN && !!ar?.identified_at && !ar?.lead_id, ia.threw ?? ar)
  check("B2 …creating nothing: no new Contact, no new Lead", count("contacts") === cB2 && count("leads") === lB2)
  check("B3 …and the one identification event fires", G.__VT.calls.kernelEvents === 1, G.__VT.calls.kernelEvents)
  fresh({ website_visitors: [{ id: "wv-4", brokerage_id: B1, session_id: "sess-lee", page_url: "https://tenant.example/", contact_id: null, lead_id: null, identified_at: null }] })
  await drive(() => postIdentify({ sessionId: "sess-lee", email: LEE }))
  check("B4 an email held by one active Lead (and no Contact) links the session to that Lead", visitorRow("sess-lee")?.lead_id === L_LEE && !visitorRow("sess-lee")?.contact_id, visitorRow("sess-lee"))

  fresh({ behavioral_signals: [{ id: "bs-2", brokerage_id: B1, visitor_id: "v-2", email_captured: null, consent_event_id: null, identified: false, contact_id: null }] })
  G.__VT.calls.consentWrites = 0
  const cc = await drive(() => capture.captureConsentedVisitorEmail(G.__VT.mem, { brokerageId: B1, signalId: "bs-2", email: ANN, consent: { consented: true, consentText: "Email me about this home.", consentSource: "/listings/12-oak" }, actorUserId: null }))
  const ccr = cc.r as any
  const sig = G.__VT.mem.tables.behavioral_signals.find((r: Row) => r.id === "bs-2")
  check("B5 a consented capture stores the email WITH its consent artifact", !cc.threw && ccr?.stored === true && sig?.email_captured === ANN && !!sig?.consent_event_id && G.__VT.calls.consentWrites === 1, cc.threw ?? ccr)
  check("B6 …and identifies the one contact holding it", ccr?.identity?.identified === true && sig?.contact_id === C_ANN, ccr?.identity)
  fresh({ behavioral_signals: [{ id: "bs-3", brokerage_id: B1, visitor_id: "v-3", email_captured: null, consent_event_id: null, identified: false, contact_id: null }] })
  G.__VT.calls.consentWrites = 0
  const nc = await drive(() => capture.captureConsentedVisitorEmail(G.__VT.mem, { brokerageId: B1, signalId: "bs-3", email: ANN, consent: { consented: false, consentText: "x", consentSource: "/" }, actorUserId: null }))
  const sig3 = G.__VT.mem.tables.behavioral_signals.find((r: Row) => r.id === "bs-3")
  check("B7 POSITIVE CONTROL — a capture WITHOUT consent stores nothing and identifies no one", (nc.r as any)?.stored === false && !sig3?.email_captured && !sig3?.contact_id && G.__VT.calls.consentWrites === 0, nc.r)

  // ═══ §D ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§D  a low-confidence / wrong-person match is suppressed")
  fresh({ website_visitors: [{ id: "wv-5", brokerage_id: B1, session_id: "sess-house", page_url: "/", contact_id: null, lead_id: null, identified_at: null }] })
  await drive(() => postIdentify({ sessionId: "sess-house", email: HOUSE }))
  check("D1 an email two contacts share (a household inbox) links NOBODY (RED at base: the first row was linked)", !visitorRow("sess-house")?.contact_id && !visitorRow("sess-house")?.identified_at, visitorRow("sess-house"))
  fresh({ website_visitors: [{ id: "wv-6", brokerage_id: B1, session_id: "sess-mixed", page_url: "/", contact_id: null, lead_id: null, identified_at: null }] })
  await drive(() => postIdentify({ sessionId: "sess-mixed", email: ANN, phone: BOB_PHONE }))
  check("D2 one person's email beside ANOTHER person's phone links nobody (RED at base: the email's contact was linked)", !visitorRow("sess-mixed")?.contact_id && !visitorRow("sess-mixed")?.identified_at, visitorRow("sess-mixed"))
  fresh({
    website_visitors: [{ id: "wv-7", brokerage_id: B1, session_id: "sess-fall", page_url: "/", contact_id: null, lead_id: null, identified_at: null }],
    leads: [{ id: L_LEE, brokerage_id: B1, email: HOUSE, phone: null, is_active: true, contact_id: null }],
  })
  await drive(() => postIdentify({ sessionId: "sess-fall", email: HOUSE }))
  check("D3 an ambiguous contact match does not fall through to a Lead holding the same address (a second guess)", !visitorRow("sess-fall")?.lead_id && !visitorRow("sess-fall")?.contact_id, visitorRow("sess-fall"))
  fresh({ behavioral_signals: [{ id: "bs-4", brokerage_id: B1, visitor_id: "v-4", email_captured: null, consent_event_id: null, identified: false, contact_id: null }] })
  const sh = await drive(() => capture.captureConsentedVisitorEmail(G.__VT.mem, { brokerageId: B1, signalId: "bs-4", email: HOUSE, consent: { consented: true, consentText: "Email me.", consentSource: "/" }, actorUserId: null }))
  const sig4 = G.__VT.mem.tables.behavioral_signals.find((r: Row) => r.id === "bs-4")
  check("D4 a consented capture of a SHARED address stores the consented email but identifies nobody (RED at base: the first contact)", (sh.r as any)?.stored === true && (sh.r as any)?.identity?.identified === false && !sig4?.contact_id, sh.r)
  const decide = linkRule.decideVisitorLink
  check("D5 the rule links exactly one certain match (positive control)", typeof decide === "function" && decide([{ ids: ["x"], refused: false }, { ids: [], refused: false }]).link === true, linkRule.__loadError)
  check("D6 the rule refuses ambiguity, disagreement and a refused read (fail closed)", typeof decide === "function"
    && decide([{ ids: ["x", "y"], refused: false }]).reason === "ambiguous_identifier"
    && decide([{ ids: ["x"], refused: false }, { ids: ["y"], refused: false }]).reason === "identifiers_disagree"
    && decide([{ ids: ["x"], refused: false }, { ids: [], refused: true }]).reason === "lookup_refused"
    && decide([]).reason === "no_match")
  const ruleSrc = code("lib/lead-intelligence/visitor-link-decision.ts")
  check("D7 the rule takes no inferred signal — its input names no IP, device, fingerprint or geolocation", ruleSrc.length > 0 && !/\b(ip_?address|ipAddress|fingerprint|device_?id|geoloc|user_?agent)\b/i.test(ruleSrc))
  check("D8 POSITIVE CONTROL — that finder DOES see an IP-shaped input", /\b(ip_?address|ipAddress|fingerprint|device_?id|geoloc|user_?agent)\b/i.test("function decide(ipAddress: string)"))

  // ═══ §E ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§E  no cross-tenant identifier linking")
  fresh({ website_visitors: [{ id: "wv-8", brokerage_id: B1, session_id: "sess-b1", page_url: "https://tenant.example/", contact_id: C_ANN, lead_id: null, identified_at: "2026-11-24T00:00:00Z", first_seen_at: "2026-11-24T00:00:00Z" }] })
  await drive(() => firePixel(B2, "sess-b1", "https://other.example/"))
  const moved = visitorRow("sess-b1")
  check("E1 a session id fired under ANOTHER tenant's id stays in its own tenant (RED at base: the upsert moved it, contact link and all)", moved?.brokerage_id === B1 && moved?.contact_id === C_ANN, moved)
  check("E2 …and the other tenant's page is not written onto it; first_seen_at is untouched", moved?.page_url === "https://tenant.example/" && moved?.first_seen_at === "2026-11-24T00:00:00Z", moved)
  await drive(() => firePixel(B1, "sess-b1", "https://tenant.example/listings/9"))
  check("E3 POSITIVE CONTROL — the owner tenant's own next hit DOES refresh the session", visitorRow("sess-b1")?.page_url === "https://tenant.example/listings/9" && visitorRow("sess-b1")?.brokerage_id === B1, visitorRow("sess-b1"))
  fresh({ website_visitors: [{ id: "wv-9", brokerage_id: B1, session_id: "sess-cross", page_url: "/", contact_id: null, lead_id: null, identified_at: null }] })
  await drive(() => postIdentify({ sessionId: "sess-cross", email: "only-in-b2@example.test" }))
  check("E4 identify matches only inside the session's own tenant — another tenant's contact is never linked", !visitorRow("sess-cross")?.contact_id && !visitorRow("sess-cross")?.identified_at, visitorRow("sess-cross"))
  fresh({ website_visitors: [{ id: "wv-x2", brokerage_id: B2, session_id: "sess-only-b2", page_url: "https://other.example/listings/1", referrer: null, time_on_page_seconds: 300, first_seen_at: "2026-11-25T11:00:00Z", last_seen_at: "2026-11-25T11:40:00Z", utm_source: null, contact_id: null, lead_id: null, identified_at: null }] })
  const svx = await drive(() => sourcer.sourceSiteVisitorIntent(G.__VT.mem, B1, { now }))
  check("E5 one tenant's acquisition lane never reads another tenant's sessions", (svx.r as any)?.rowsExamined === 0, svx.r)
  const snippetSrc = raw("app/dashboard/admin/visitor-tracking/page.tsx")
  const snippet = /const snippet = [\s\S]*?<\/script>`/.exec(snippetSrc)?.[0] ?? ""
  check("E6 the snippet keeps its session id in the installer site's OWN storage (localStorage, per origin) and sets no cookie", /localStorage\.getItem\('_vip'\)/.test(snippet) && !/document\.cookie/.test(snippet))
  check("E7 POSITIVE CONTROL — the cookie finder DOES see a cookie write", /document\.cookie/.test("document.cookie='_vip='+s"))
  check("E8 the snippet never lifts a password or hidden field off a form", /ty==='password'\|\|ty==='hidden'/.test(snippet))

  // ═══ §F ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§F  deletion and opt-out propagate")
  const subjectWorld = () => fresh({
    leads: [{ id: L_LEE, brokerage_id: B1, email: LEE, phone: null, is_active: true, contact_id: C_ANN }],
    website_visitors: [
      { id: "wv-a", brokerage_id: B1, session_id: "s-a", contact_id: C_ANN, lead_id: null },
      { id: "wv-l", brokerage_id: B1, session_id: "s-l", contact_id: null, lead_id: L_LEE },
      { id: "wv-other", brokerage_id: B1, session_id: "s-o", contact_id: C_BOB, lead_id: null },
      { id: "wv-anon", brokerage_id: B1, session_id: "s-n", contact_id: null, lead_id: null },
    ],
    behavioral_signals: [
      { id: "bs-a", brokerage_id: B1, visitor_id: "va", contact_id: C_ANN, email_captured: ANN, ip_address: "198.51.100.7" },
      { id: "bs-e", brokerage_id: B1, visitor_id: "ve", contact_id: null, email_captured: ANN, ip_address: "198.51.100.8" },
      { id: "bs-o", brokerage_id: B1, visitor_id: "vo", contact_id: C_BOB, email_captured: "bob@example.test" },
      { id: "bs-x", brokerage_id: B2, visitor_id: "vx", contact_id: null, email_captured: ANN },
    ],
    site_activity: [{ id: "sa-a", brokerage_id: B1, behavioral_signal_id: "bs-a", contact_id: C_ANN, page_visited: "/listings/12-oak" }, { id: "sa-o", brokerage_id: B1, behavioral_signal_id: "bs-o", contact_id: C_BOB, page_visited: "/" }],
    external_behavior: [{ id: "eb-a", brokerage_id: B1, behavioral_signal_id: "bs-e", contact_id: null }],
  })
  subjectWorld()
  const er = await drive(() => erasure.eraseVisitorDataForSubject(G.__VT.mem, { brokerageId: B1, contactIds: [C_ANN], email: ANN.toUpperCase() }))
  const t = G.__VT.mem.tables
  const ids = (tb: string) => (t[tb] as Row[]).map((r) => r.id).sort()
  check("F1 the erasure deletes the subject's sessions (by contact AND by the subject's lead), signals (linked AND email-captured), pages read and off-site rows (RED at base: no erasure of visitor data exists)",
    (er.r as any)?.ok === true && !ids("website_visitors").includes("wv-a") && !ids("website_visitors").includes("wv-l") && !ids("behavioral_signals").includes("bs-a") && !ids("behavioral_signals").includes("bs-e") && !ids("site_activity").includes("sa-a") && !ids("external_behavior").includes("eb-a"),
    er.threw ?? er.r ?? erasure.__loadError)
  check("F2 …and NOTHING else: another person's rows, the anonymous session and ANOTHER tenant's capture of the same email survive",
    ids("website_visitors").includes("wv-other") && ids("website_visitors").includes("wv-anon") && ids("behavioral_signals").includes("bs-o") && ids("behavioral_signals").includes("bs-x") && ids("site_activity").includes("sa-o"))
  check("F3 the erasure reports what it deleted, counted from the rows (not assumed)", (er.r as any)?.deleted?.website_visitors === 2 && (er.r as any)?.deleted?.behavioral_signals === 2, (er.r as any)?.deleted)
  subjectWorld()
  G.__VT.mem = world(G.__VT.mem.tables, { refuse: { site_activity: "permission denied (fixture)" } })
  const erRef = await drive(() => erasure.eraseVisitorDataForSubject(G.__VT.mem, { brokerageId: B1, contactIds: [C_ANN], email: ANN }))
  check("F4 a REFUSED delete fails the erasure closed (ok:false) — never a silent partial success", (erRef.r as any)?.ok === false, erRef.r ?? erasure.__loadError)
  const dsar = code("app/actions/privacy/data-subject-requests.ts")
  const fulfil = dsar.slice(dsar.indexOf("export async function fulfillDeleteRequestAction"), dsar.indexOf("export async function denyDSARRequestAction"))
  const iErase = fulfil.indexOf("eraseVisitorDataForSubject("), iClose = fulfil.indexOf('status:              "fulfilled"')
  check("F5 the DSAR delete runs the visitor erasure BEFORE marking the request fulfilled, and returns on its refusal", iErase > 0 && iClose > iErase && /if \(!visitorErasure\.ok\) \{\s*return \{ ok: false/.test(fulfil), { iErase, iClose })
  check("F6 POSITIVE CONTROL — the order finder sees the close statement it orders against", iClose > 0)
  fresh({ contacts: [
    { id: "c-opt", brokerage_id: B1, email: "opt@example.test", email_opt_out: true, first_name: "O", last_name: "O", agent_id: null },
    { id: "c-uns", brokerage_id: B1, email: "uns@example.test", email_opt_out: false, first_name: "U", last_name: "U", agent_id: null },
    { id: "c-ok", brokerage_id: B1, email: "ok@example.test", email_opt_out: false, first_name: "K", last_name: "K", agent_id: null },
  ], newsletter_subscribers: [{ id: "ns-1", brokerage_id: B1, email: "uns@example.test", status: "unsubscribed" }] })
  const o1 = await drive(() => newsletter.enrollContactInNewsletter({ contactId: "c-opt", brokerageId: B1 }, G.__VT.mem))
  const o2 = await drive(() => newsletter.enrollContactInNewsletter({ contactId: "c-uns", brokerageId: B1 }, G.__VT.mem))
  const o3 = await drive(() => newsletter.enrollContactInNewsletter({ contactId: "c-ok", brokerageId: B1 }, G.__VT.mem))
  check("F7 an identified visitor who OPTED OUT is not enrolled by the identification reaction", (o1.r as any)?.enrolled === false && (o1.r as any)?.reason === "email_opt_out", o1.r ?? o1.threw)
  check("F8 an identified visitor who UNSUBSCRIBED earlier is not re-subscribed", (o2.r as any)?.enrolled === false && (o2.r as any)?.reason === "previously_unsubscribed", o2.r ?? o2.threw)
  check("F9 POSITIVE CONTROL — an opted-in identified visitor IS enrolled (the reaction is not simply dead)", (o3.r as any)?.enrolled === true, o3.r ?? o3.threw)
  const reaction = code("lib/kernel/manager-signals.ts")
  check("F10 the identified-visitor reaction reaches exactly that opt-out-honoring enrollment", /"campaign_orchestrator:website_visitor_identified"[\s\S]{0,900}enrollContactInNewsletter/.test(reaction))

  // ── ROUND 2 — identification evidence, the right-to-know export, and the DSAR delete DRIVEN ───────────────────────
  const P_VISIT = "pi-visitor-only", P_SHARED = "pi-shared"
  const dsarWorld = (opts: Record<string, unknown> = {}) => {
    subjectWorld()
    const t0 = G.__VT.mem.tables
    t0.person_identities.push({ id: P_VISIT, brokerage_id: B1, email_normalized: ANN }, { id: P_SHARED, brokerage_id: B1, email_normalized: "bob@example.test" })
    t0.person_identity_evidence.push(
      { id: "pe-sig", brokerage_id: B1, person_id: P_VISIT, entity_type: "behavioral_signal", entity_id: "bs-a", source: "visitor_identify" },
      { id: "pe-con", brokerage_id: B1, person_id: P_VISIT, entity_type: "contact", entity_id: C_ANN, source: "visitor_identify" },
      { id: "pe-cap", brokerage_id: B1, person_id: P_VISIT, entity_type: "contact", entity_id: C_ANN, source: "contact_capture" },
      { id: "pe-bob", brokerage_id: B1, person_id: P_SHARED, entity_type: "behavioral_signal", entity_id: "bs-o", source: "visitor_identify" },
      { id: "pe-bob2", brokerage_id: B1, person_id: P_SHARED, entity_type: "contact", entity_id: C_BOB, source: "contact_capture" },
    )
    t0.data_subject_requests.push(
      { id: "dsr-del", brokerage_id: B1, subject_email: ANN, identity_verified: true, request_type: "delete", status: "in_progress" },
      { id: "dsr-acc", brokerage_id: B1, subject_email: ANN, identity_verified: true, request_type: "access", status: "in_progress" },
    )
    if (Object.keys(opts).length > 0) G.__VT.mem = world(t0, opts)
    G.__VT.seat = U_BROKER
  }
  dsarWorld()
  // Without the contact-capture evidence the person exists ONLY through the visitor identification.
  G.__VT.mem.tables.person_identity_evidence = G.__VT.mem.tables.person_identity_evidence.filter((r: Row) => r.id !== "pe-cap")
  const ev = await drive(() => erasure.eraseVisitorDataForSubject(G.__VT.mem, { brokerageId: B1, contactIds: [C_ANN], email: ANN }))
  const tv = G.__VT.mem.tables
  check("F11 the erasure removes the identification EVIDENCE the visitor-identify loop wrote for the subject (signal + contact rows), counted (RED at base: kept)",
    (ev.r as any)?.ok === true && !tv.person_identity_evidence.some((r: Row) => r.id === "pe-sig" || r.id === "pe-con") && (ev.r as any)?.deleted?.person_identity_evidence === 2, ev.r ?? erasure.__loadError)
  check("F12 …and the person row that existed ONLY because of it; another person's evidence and person row survive",
    !tv.person_identities.some((r: Row) => r.id === P_VISIT) && tv.person_identities.some((r: Row) => r.id === P_SHARED) && tv.person_identity_evidence.some((r: Row) => r.id === "pe-bob2"), tv.person_identities)
  dsarWorld()
  const ev2 = await drive(() => erasure.eraseVisitorDataForSubject(G.__VT.mem, { brokerageId: B1, contactIds: [C_ANN], email: ANN }))
  check("F13 POSITIVE CONTROL — a person other evidence still names (a contact capture) is KEPT; only the visitor evidence goes",
    (ev2.r as any)?.ok === true && G.__VT.mem.tables.person_identities.some((r: Row) => r.id === P_VISIT) && G.__VT.mem.tables.person_identity_evidence.some((r: Row) => r.id === "pe-cap"), ev2.r)
  dsarWorld({ refuse: { person_identity_evidence: "permission denied (fixture)" } })
  const ev3 = await drive(() => erasure.eraseVisitorDataForSubject(G.__VT.mem, { brokerageId: B1, contactIds: [C_ANN], email: ANN }))
  check("F14 a refused evidence read/delete fails the erasure closed — and nothing was deleted before it", (ev3.r as any)?.ok === false && G.__VT.mem.tables.behavioral_signals.some((r: Row) => r.id === "bs-a"), ev3.r ?? erasure.__loadError)

  const dsarMod = await load("app/actions/privacy/data-subject-requests.ts")
  dsarWorld()
  const ex = await drive(() => dsarMod.fulfillExportRequestAction("dsr-acc"))
  const bundle = (ex.r as any)?.bundle
  const wvd = bundle?.website_visitor_data
  const idsIn = (k: string) => ((wvd?.[k] ?? []) as Row[]).map((r) => r.id).sort()
  check("F15 the right-to-know export (driven) carries the subject's website visitor data — sessions, signals (incl. the captured email), pages, off-site rows, evidence (RED at base: absent)",
    (ex.r as any)?.ok === true && JSON.stringify(idsIn("website_visitors")) === JSON.stringify(["wv-a", "wv-l"]) && JSON.stringify(idsIn("behavioral_signals")) === JSON.stringify(["bs-a", "bs-e"])
    && idsIn("site_activity").includes("sa-a") && idsIn("external_behavior").includes("eb-a") && idsIn("person_identity_evidence").includes("pe-sig"), ex.threw ?? (ex.r as any)?.error ?? Object.keys(bundle ?? {}))
  check("F16 …and NOTHING of anyone else's: another person's sessions / signals / evidence and another tenant's capture are absent",
    !idsIn("website_visitors").includes("wv-other") && !idsIn("behavioral_signals").includes("bs-o") && !idsIn("behavioral_signals").includes("bs-x") && !idsIn("person_identity_evidence").includes("pe-bob"))
  dsarWorld({ refuse: { site_activity: "permission denied (fixture)" } })
  const exr = await drive(() => dsarMod.fulfillExportRequestAction("dsr-acc"))
  check("F17 a refused visitor-data read ABORTS the export (never a silently short bundle) and the request stays open",
    (exr.r as any)?.ok === false && /website visitor data/.test((exr.r as any)?.error ?? "") && G.__VT.mem.tables.data_subject_requests.find((r: Row) => r.id === "dsr-acc")?.status === "in_progress", exr.r ?? exr.threw)

  dsarWorld()
  const fd = await drive(() => dsarMod.fulfillDeleteRequestAction("dsr-del"))
  const reqDel = G.__VT.mem.tables.data_subject_requests.find((r: Row) => r.id === "dsr-del")
  check("F18 fulfillDeleteRequestAction (DRIVEN) anonymizes the contact, deletes the subject's visitor rows and evidence, and ONLY THEN closes the request (RED at base: closed with the visitor rows still on file)",
    (fd.r as any)?.ok === true && reqDel?.status === "fulfilled" && !G.__VT.mem.tables.website_visitors.some((r: Row) => r.id === "wv-a") && !G.__VT.mem.tables.behavioral_signals.some((r: Row) => r.id === "bs-e") && !G.__VT.mem.tables.person_identity_evidence.some((r: Row) => r.id === "pe-sig")
    && G.__VT.mem.tables.contacts.find((r: Row) => r.id === C_ANN)?.last_name === "[deleted]", fd.threw ?? fd.r ?? dsarMod.__loadError)
  check("F19 …another person's visitor rows are untouched by that request", G.__VT.mem.tables.website_visitors.some((r: Row) => r.id === "wv-other") && G.__VT.mem.tables.behavioral_signals.some((r: Row) => r.id === "bs-o"))
  dsarWorld({ refuse: { site_activity: "permission denied (fixture)" } })
  const fdr = await drive(() => dsarMod.fulfillDeleteRequestAction("dsr-del"))
  const reqOpen = G.__VT.mem.tables.data_subject_requests.find((r: Row) => r.id === "dsr-del")
  check("F20 a FAILING visitor delete leaves the request OPEN (not fulfilled) and says why (RED at base: marked fulfilled)",
    (fdr.r as any)?.ok === false && reqOpen?.status === "in_progress" && /visitor data was NOT erased/.test((fdr.r as any)?.error ?? ""), fdr.r ?? fdr.threw)
  G.__VT.seat = null
  dsarWorld(); G.__VT.seat = null
  const anon = await drive(() => dsarMod.fulfillDeleteRequestAction("dsr-del"))
  check("F21 POSITIVE CONTROL — with no session the DSAR door refuses and deletes nothing (the drive reaches the real gate)",
    (anon.r as any)?.ok === false && G.__VT.mem.tables.website_visitors.some((r: Row) => r.id === "wv-a"), anon.r ?? anon.threw)

  // ═══ §G ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§G  ROUND 2 — a public hit is bound to the tenant's OWN site; the visit writer is no public endpoint")
  fresh()
  await drive(() => firePixel(B1, "sess-g1", "https://tenant.example/listings/1"))
  check("G1 a pixel hit from tenant A's registered website, naming tenant A, is recorded (positive)", visitorRow("sess-g1")?.brokerage_id === B1, visitorRow("sess-g1"))
  await drive(() => firePixel(B2, "sess-g2", "https://tenant.example/listings/1"))
  check("G2 a hit from tenant A's site naming tenant B writes NOTHING into B (RED at base: any page could write into any tenant by its id)", !visitorRow("sess-g2") && !G.__VT.mem.tables.website_visitors.some((r: Row) => r.brokerage_id === B2), visitorRow("sess-g2"))
  await drive(() => firePixel(B1, "sess-g3", "https://tenant.example/", null))
  check("G3 a hit with NO Referer (nothing says which site fired it) records nothing — fail closed", !visitorRow("sess-g3"))
  await drive(() => firePixel(B1, "sess-g4", "https://www.tenant.example/a"))
  await drive(() => firePixel(B2, "sess-g5", "https://homes.beta.test/a"))
  check("G4 the registered host's www twin and an ACTIVE verified custom domain are the tenant's site (positive)", visitorRow("sess-g4")?.brokerage_id === B1 && visitorRow("sess-g5")?.brokerage_id === B2)
  await drive(() => firePixel(B2, "sess-g6", "https://pending.beta.test/a"))
  await drive(() => firePixel(B2, "sess-g7", "https://evil-other.example/a"))
  check("G5 a custom domain that is NOT active, and a look-alike host, are not the tenant's site", !visitorRow("sess-g6") && !visitorRow("sess-g7"))
  await drive(() => firePixel(B3, "sess-g8", "https://tenant.example/"))
  check("G6 a tenant that registered no website records nothing (fail closed)", !visitorRow("sess-g8"))

  const visitorRoute = await load("app/api/track/visitor/route.ts")
  const postVisit = (slug: string, headers: Record<string, string>) => visitorRoute.POST(new NextRequest("https://app.test/api/track/visitor", {
    method: "POST", body: JSON.stringify({ brokerage_slug: slug, visitor_id: `v-${slug}-${ipN}`, page_visited: "https://tenant.example/", time_spent: 3 }),
    headers: { "x-forwarded-for": nextIp(), host: "app.test", "content-type": "application/json", ...headers },
  }))
  const prevApp = process.env.NEXT_PUBLIC_APP_URL
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test"
  fresh(); G.__VT.calls.trackStub = 0
  const vOk = await drive(() => postVisit("beta", { origin: "https://app.test", referer: "https://app.test/widget/beta" }))
  check("G7 a visit from tenant B's own widget page, naming B, is recorded in B (positive)", (vOk.r as any)?.status === 200 && G.__VT.mem.tables.behavioral_signals.some((r: Row) => r.brokerage_id === B2), vOk.threw ?? (vOk.r as any)?.status)
  fresh(); G.__VT.calls.trackStub = 0
  const vX = await drive(() => postVisit("beta", { origin: "https://app.test", referer: "https://app.test/widget/alpha" }))
  check("G8 a visit from tenant A's widget page naming tenant B is REFUSED and writes nothing into B (RED at base: the slug alone decided)",
    (vX.r as any)?.status === 403 && !G.__VT.mem.tables.behavioral_signals.some((r: Row) => r.brokerage_id === B2) && G.__VT.calls.trackStub === 0, (vX.r as any)?.status)
  fresh(); G.__VT.calls.trackStub = 0
  const vNo = await drive(() => postVisit("beta", {}))
  check("G9 a visit with no browser Origin / Referer (a script naming a slug) is refused, nothing written (RED at base: no Origin passed)",
    (vNo.r as any)?.status === 403 && G.__VT.mem.tables.behavioral_signals.length === 0 && G.__VT.calls.trackStub === 0, (vNo.r as any)?.status)
  process.env.NEXT_PUBLIC_APP_URL = prevApp

  const leadActions = code("app/actions/lead-intelligence.ts")
  check("G10 the 'use server' lead-intelligence file no longer EXPORTS trackBehavior (a public endpoint taking a tenant id) (RED at base)", leadActions.length > 0 && !/export\s+async\s+function\s+trackBehavior\s*\(/.test(leadActions))
  check("G11 POSITIVE CONTROL — the export finder DOES see the shape", /export\s+async\s+function\s+trackBehavior\s*\(/.test("export async function trackBehavior(sessionData: {"))
  const tbLib = code("lib/lead-intelligence/track-behavior.ts")
  check("G12 the writer survives as a plain module (not 'use server') — nothing deleted", /export\s+async\s+function\s+trackBehavior\s*\(/.test(tbLib) && !/^\s*["']use server["']/.test(tbLib))
  const importers = [...walk("app"), ...walk("lib")].filter((f) => /lead-intelligence\/track-behavior["']/.test(code(f))).sort()
  check("G13 ONLY the two public routes that decide the tenant themselves reach it", JSON.stringify(importers) === JSON.stringify(["app/api/track/visitor/route.ts", "app/api/widget/capture-lead/route.ts"]), importers)
  check("G14 0 network calls across every ROUND 2 drive (no provider reached)", G.__VT.calls.fetch === 0)

  // ═══ §C ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§C  an unapproved match never calls a vendor")
  check("C1 across every drive above: 0 network calls (the counted fetch seam)", G.__VT.calls.fetch === 0, G.__VT.calls.fetch)
  const VISITOR_ID_VENDOR_MARKERS = [/\brb2b\.com/i, /\bretention\.com/i, /\bopensend\.com/i, /\bcustomers\.ai/i, /\bleadfeeder\b/i, /\bdealfront\b/i, /reveal\.clearbit/i, /\bwarmly\.ai/i, /\bvector\.co\b/i, /\bidentitymatrix\b/i, /\bunghost\b/i, /\bgetuntitled\.ai/i, /\bidentified\.ai/i, /\/v2\/ip2domain/i, /hemToBusinessDomain/i, /\bip2location\b/i, /\bipinfo\.io/i, /\bmaxmind\b/i]
  const hits: string[] = []
  for (const f of [...walk("app"), ...walk("lib")]) {
    const s = code(f)
    for (const m of VISITOR_ID_VENDOR_MARKERS) if (m.test(s)) hits.push(`${f} ~ ${m.source}`)
  }
  const catalogOnly = hits.filter((h) => !h.startsWith("lib/external/versium-client.ts"))
  check("C2 census (comment-stripped app/ + lib/): no code names a visitor-identification vendor or IP-geolocation host — the only mention is the Versium catalog", catalogOnly.length === 0, catalogOnly.slice(0, 6))
  const versium = code("lib/external/versium-client.ts")
  const entry = /id: "visitor_to_company"[\s\S]*?note:/.exec(versium)?.[0] ?? ""
  check("C3 that catalog entry (IP-to-company) is NOT_APPLICABLE with NO capability and NO caller", /status: "NOT_APPLICABLE"/.test(entry) && /capability: null/.test(entry) && /caller: null/.test(entry), entry.slice(0, 200))
  check("C4 POSITIVE CONTROL — the census finder DOES see a vendor host in code", VISITOR_ID_VENDOR_MARKERS.some((m) => m.test(stripComments(`const u = "https://api.rb2b.com/v1/visitors"`))) && !VISITOR_ID_VENDOR_MARKERS.some((m) => m.test(stripComments(`// see rb2b.com in the decision doc\nconst x = 1`))))
  const decision = raw("docs/operations/WAVE156-VISITOR-IDENTITY-DECISION.md", WT)
  check("C5 the decision is written down and says the product does NOT offer anonymous-visitor identification", /do not offer/i.test(decision) && /does not include it/i.test(decision))

  console.log(`\n${"═".repeat(72)}\nWAVE 156F VISITOR TRUTH — ${passed} passed, ${failed} failed  (root: ${ROOT === WT ? "worktree" : ROOT})`)
  if (failed > 0) { for (const f of fails) console.log(`  · ${f}`); process.exit(1) }
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1) })
