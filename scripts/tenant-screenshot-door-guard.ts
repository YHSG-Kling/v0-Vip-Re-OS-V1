#!/usr/bin/env tsx
/**
 * scripts/tenant-screenshot-door-guard.ts   (npm run test:tenant-screenshot-door)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TENANT DOOR ONTO THE SCREENSHOT SEAM, PROVED OFFLINE (wave 80, lane 80D,
 * owner verbatim: "tenant can pick zestimate & co. I believe we have already
 * coded for a screenshot of a zestimate as a campaign. screenshots can be used
 * by tenants.").
 *
 * What it holds (CLAUDE.md §2 — every absence assertion carries a positive
 * control; every code-token scan reads STRIPPED source; nothing here reaches
 * the network — the seam runs on counting stubs and never navigates; a real
 * capture is a smoke run in a host that can reach the portals, not this proof):
 *   1. THE SOURCE VOCABULARY is closed and every host is on the seam's
 *      PUBLIC_PAGE_HOSTS; each source carries a ToS note; an unknown source
 *      refuses by name.
 *   2. TENANT GATE FROM THE SESSION — every export of the tenant action awaits
 *      requireTenantAdminOrSoloOwner() before the service client; the file
 *      never imports the PLATFORM door (requireMarketing / platform-guard) and
 *      never reads a brokerageId off its input.
 *   3. THE STUBBED CAPTURE — search restricted to the ONE source host (an
 *      off-source portal hit is skipped: control); the row lands in the
 *      tenant's assets (visibility_scope=brokerage, brokerage_id from the
 *      gate, PENDING), tagged use:marketing_campaign ONLY (83C — "zestimate is
 *      marketing campaigns strictly"), with estimate_source/address provenance and
 *      customer_facing_value:false; the cache read carries the tenant
 *      predicate; an os_surface capture with an owner refuses; a host off the
 *      allowlist refuses.
 *   4. NEVER A CUSTOMER-FACING VALUE — no customer-facing module imports the
 *      door (specimen-controlled), nothing reads text off the page, every pick
 *      is customerFacingValue:false, pickApprovedStill never returns a pending
 *      row.
 *   5. THE PLAYBOOK CONSUMES IT — installCreativePlaybook calls
 *      ensureZestimateChallengeStill and prefers the APPROVED still for the
 *      postcard art; the video stages screenshotUrls; the director stages
 *      tenant stills for a composition whose treatments row renders
 *      `screenshot` (derived from COMPOSITION_TREATMENTS).
 *   6. THE APPROVAL RAIL is the existing one — the UI imports approveAsset /
 *      rejectAsset from marketing-studio, whose update is tenant-predicated.
 *   7. REGISTRATION — package.json after test:scrapers (ordering), the
 *      registry entry with coOwners, the row shape on live columns/CHECKs.
 *
 * Run: npx tsx --conditions=react-server scripts/tenant-screenshot-door-guard.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments, blankStrings } from "./strip-comments"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { ESTIMATE_SOURCES, ESTIMATE_SOURCE_KEYS, estimateSource, DEFAULT_ESTIMATE_SOURCE } from "../lib/marketing/estimate-sources"
import {
  PUBLIC_PAGE_HOSTS, isPublicPageHost, planScreenshotCapture, screenshotAssetRow, captureScreenshot, capturePublicPropertyPage,
  listScreenshotStillsForUse, setScreenshotUses, SCREENSHOT_USES,
  type ScreenshotProvider, type ProviderCaptureInput,
} from "../lib/assets/screenshot-capture"
import {
  planTenantStill, captureTenantEstimateStill, pickApprovedStill, ensureZestimateChallengeStill,
} from "../lib/marketing/tenant-screenshot-door"
import { COMPOSITION_TREATMENTS } from "../lib/video/body-visual-model"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const rel = (p: string) => p.replace(root + "/", "")
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(p.startsWith("/") ? p : join(root, p), "utf8")
const stripped = (p: string) => blankStrings(stripComments(src(p)))
const strippedKeepStrings = (p: string) => stripComments(src(p))
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p)
  }
  return out
}
const DOOR = "lib/marketing/tenant-screenshot-door.ts"
const ACTION = "app/actions/marketing/tenant-screenshots.ts"
const SEAM = "lib/assets/screenshot-capture.ts"
const CARD = "app/settings/campaign-bundles/estimate-stills-card.tsx"
const PLAYBOOK_ACTION = "app/actions/creative-playbooks.ts"
const TENANT = "11111111-1111-4111-8111-111111111111"
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222"

process.env.NEXT_PUBLIC_APP_URL = "https://os.example.test"
delete process.env.VERCEL; delete process.env.AWS_LAMBDA_FUNCTION_NAME; delete process.env.SCREENSHOT_PROVIDER

// ── Stubs (no browser, no network, no DB) ────────────────────────────────────
function countingProvider(): ScreenshotProvider & { calls: ProviderCaptureInput[] } {
  const calls: ProviderCaptureInput[] = []
  // A stubbed provider CONFIRMS every readiness label (wave 81D: the seam refuses a public page
  // whose provider did not confirm the property photo + the Zestimate on screen).
  return { name: "puppeteer", calls, async capture(input) { calls.push(input); return { png: Buffer.from("png-bytes"), satisfied: input.readyWhen.map((r) => r.label) } } }
}
interface Row { id: string; brokerage_id: string | null; visibility_scope: string; approval_status: string | null; asset_url: string; asset_name: string | null; tags: string[] | null; metadata: Record<string, unknown> | null; updated_at: string | null }
function makeSvc(rows: Row[] = [], opts: { insertId?: string } = {}) {
  const calls: string[] = []
  const inserted: Array<Record<string, unknown>> = []
  const predicates: Array<Array<[string, unknown]>> = []
  const chain = (table: string) => {
    const eqs: Array<[string, unknown]> = []
    const q: any = { _op: "select", _eqs: eqs }
    q.select = () => q
    q.eq = (k: string, v: unknown) => { eqs.push([k, v]); return q }
    for (const m of ["is", "lt", "in", "order", "limit", "not", "or", "gte", "neq"]) q[m] = () => q
    q.insert = (row: Record<string, unknown>) => { q._op = "insert"; inserted.push(row); return q }
    q.update = (patch: Record<string, unknown>) => { q._op = "update"; q._patch = patch; return q }
    q.delete = () => { q._op = "delete"; return q }
    const matches = () => rows.filter((r) => eqs.every(([k, v]) => {
      if (k === "metadata->>asset_kind") return r.metadata?.asset_kind === v
      if (k === "metadata->>cache_key") return r.metadata?.cache_key === v
      if (k === "metadata->>screenshot_kind") return r.metadata?.screenshot_kind === v
      if (k === "asset_type") return true
      return (r as any)[k] === v
    }))
    q.maybeSingle = async () => { predicates.push([...eqs]); const m = table === "marketing_assets" && q._op === "select" ? matches() : []; return { data: m[0] ?? null, error: null } }
    q.single = async () => ({ data: { id: opts.insertId ?? "row-new" }, error: null })
    q.then = (res: any, rej: any) => {
      predicates.push([...eqs])
      const data = table === "marketing_assets" ? (q._op === "update" ? matches().map((r) => { Object.assign(r, q._patch); return { id: r.id } }) : matches()) : []
      return Promise.resolve({ data, error: null }).then(res, rej)
    }
    return q
  }
  return {
    calls, inserted, predicates,
    from: (t: string) => { calls.push(`from:${t}`); return chain(t) },
    storage: { from: (b: string) => ({
      upload: async (p: string) => { calls.push(`upload:${b}/${p}`); return { error: null } },
      getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.example.test/${b}/${p}` } }),
    }) },
  }
}
const robotsAllow = async () => "User-agent: *\nAllow: /"
const zillowHit = "https://www.zillow.com/homedetails/123-Main-St-Austin-TX-78701/1_zpid/"
const redfinHit = "https://www.redfin.com/TX/Austin/123-Main-St-78701/home/1"

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[1 · the source vocabulary — closed, on the allowlist, ToS-noted]")
// Wave 81D (owner: "the zestimate screenshot is the only property page screenshot"): ONE source.
check("ONE source — zillow_zestimate — its key unique and typed (the three portal siblings are tombstoned)", ESTIMATE_SOURCE_KEYS.length === 1 && ESTIMATE_SOURCE_KEYS[0] === "zillow_zestimate" && ESTIMATE_SOURCES.length === 1 && ESTIMATE_SOURCES.every((s) => (ESTIMATE_SOURCE_KEYS as readonly string[]).includes(s.key)))
check("every source host is on the seam's PUBLIC_PAGE_HOSTS (a source can never name a host the seam refuses)", ESTIMATE_SOURCES.every((s) => (PUBLIC_PAGE_HOSTS as readonly string[]).includes(s.host)), ESTIMATE_SOURCES.filter((s) => !(PUBLIC_PAGE_HOSTS as readonly string[]).includes(s.host)).map((s) => s.host).join(","))
check("CONTROL: the subset check would catch an off-list host", !(PUBLIC_PAGE_HOSTS as readonly string[]).includes("example.com") && !isPublicPageHost("example.com"))
check("every source carries a ToS note naming the mark and the approval step, and a search hint", ESTIMATE_SOURCES.every((s) => s.tosNote.length > 80 && /approv/i.test(s.tosNote) && s.searchHint.length > 0))
check("an unknown source is refused by name; the default is a registered key", estimateSource("mls_avm") === null && estimateSource(null) === null && estimateSource(DEFAULT_ESTIMATE_SOURCE) !== null)
check("the vocabulary module is PURE (no imports) so the client card and the door read ONE list", !/^import\s/m.test(stripComments(src("lib/marketing/estimate-sources.ts"))) && strippedKeepStrings(CARD).includes("@/lib/marketing/estimate-sources") && strippedKeepStrings(DOOR).includes("@/lib/marketing/estimate-sources"))
{
  const r = planTenantStill({ brokerageId: TENANT, userId: "u", source: "mls_avm", address: "123 Main St" })
  check("planTenantStill refuses an unknown source naming the vocabulary", !r.ok && /zillow_zestimate/.test(r.reason))
  const short = planTenantStill({ brokerageId: TENANT, userId: "u", source: "zillow_zestimate", address: "12" })
  const noTenant = planTenantStill({ brokerageId: "", userId: "u", source: "zillow_zestimate", address: "123 Main St, Austin TX" })
  check("planTenantStill refuses a short address and a missing tenant (fail closed)", !short.ok && !noTenant.ok)
  // WAVE 83C (owner: "zestimate is marketing campaigns strictly"): the 80D product_video opt-in is retired.
  const ok = planTenantStill({ brokerageId: TENANT, userId: "u", source: "zillow_zestimate", address: "  123  Main St, Austin TX ", alsoForVideo: true } as any)
  check("a valid plan restricts to the source host, normalises the address, and tags marketing_campaign ONLY — a stale alsoForVideo is ignored", ok.ok && ok.source.host === "zillow.com" && ok.mustShow.join("+") === "property_photo+zestimate" && ok.address === "123 Main St, Austin TX" && ok.uses.join() === "marketing_campaign" && /zestimate/.test(ok.query))
}

console.log("\n[2 · tenant gate from the SESSION — never the platform door, never a body tenant]")
{
  const action = strippedKeepStrings(ACTION)
  const exportsOf = action.split(/(?=export async function )/).filter((c) => c.startsWith("export async function "))
  const gatedFirst = exportsOf.every((chunk) => {
    const gate = chunk.indexOf("await requireTenantAdminOrSoloOwner()")
    const svcAt = chunk.indexOf("createServiceClient()")
    return gate !== -1 && (svcAt === -1 || gate < svcAt)
  })
  check(`the tenant action gates EVERY export (${exportsOf.length}) with requireTenantAdminOrSoloOwner before the service client, is 'use server', async exports only`,
    src(ACTION).startsWith('"use server"') && exportsOf.length >= 4 && !/export (const|function|let)/.test(action) && gatedFirst)
  check("CONTROL: an export reaching the service client before the gate is caught",
    !(["export async function bad() {\n  const svc = createServiceClient()\n  const auth = await requireTenantAdminOrSoloOwner()\n}"].every((chunk) => { const g = chunk.indexOf("await requireTenantAdminOrSoloOwner()"); const s = chunk.indexOf("createServiceClient()"); return g !== -1 && (s === -1 || g < s) })))
  const PLATFORM_DOOR_RE = /requireMarketing|@\/lib\/auth\/platform-guard|platformStaffCan/
  check("the tenant action and the door never import the PLATFORM door (requireMarketing / platform-guard)", !PLATFORM_DOOR_RE.test(action) && !PLATFORM_DOOR_RE.test(strippedKeepStrings(DOOR)))
  check("CONTROL: the platform-door finder recognises a specimen", PLATFORM_DOOR_RE.test(stripComments(`import { requireMarketing } from "@/lib/auth/platform-guard"`)))
  check("the tenant action never reads a brokerageId off its input — the tenant is auth.brokerageId from the gate", !/input\.brokerageId|brokerageId: input/.test(action) && (action.match(/auth\.brokerageId/g) ?? []).length >= 3)
  check("the gate is the SAME tenant door marketing-ai-approvals uses (lib/auth/require-caller.ts::requireTenantAdminOrSoloOwner)", /requireTenantAdminOrSoloOwner/.test(strippedKeepStrings("app/actions/marketing-ai-approvals.ts")) && /export async function requireTenantAdminOrSoloOwner/.test(strippedKeepStrings("lib/auth/require-caller.ts")))
}

console.log("\n[3 · the stubbed capture — source-restricted search, tenant-owned PENDING row, tenant cache]")
{
  const provider = countingProvider(); const svc = makeSvc([], { insertId: "still-1" })
  const searched: string[][] = []
  const r = await captureTenantEstimateStill(
    { brokerageId: TENANT, userId: "user-1", source: "zillow_zestimate", address: "123 Main St, Austin TX", listingId: "lst-1" },
    { svc, provider, fetchRobots: robotsAllow, now: new Date("2026-09-23T10:00:00Z"), search: async (_q, domains) => { searched.push(domains); return [{ url: redfinHit }, { url: "https://example.com/x" }, { url: zillowHit }] } },
  )
  const row = svc.inserted[0] as any
  check("the search is restricted to the ONE host of the chosen source", searched[0]?.join() === "zillow.com")
  check("CONTROL: a portal hit OFF the chosen source (redfin, first in the results) is skipped and the zillow page is what gets captured", r.ok && r.sourceUrl === zillowHit && provider.calls.length === 1 && provider.calls[0].url === zillowHit)
  check("the row lands in the TENANT's marketing assets: visibility_scope=brokerage, brokerage_id from the gate, created_by, PENDING", !!row && row.visibility_scope === "brokerage" && row.brokerage_id === TENANT && row.created_by === "user-1" && row.approval_status === "pending")
  check("tags carry use:marketing_campaign (and NO other use), screenshot, third_party_page, estimate_still", !!row && ["use:marketing_campaign", "screenshot", "third_party_page", "estimate_still"].every((t) => row.tags.includes(t)) && (row.tags as string[]).filter((t) => t.startsWith("use:")).length === 1)
  check("metadata records provenance (estimate_source, address, listing_id, source_url, captured_at) and customer_facing_value:false with the disclaimer", !!row && row.metadata.estimate_source === "zillow_zestimate" && row.metadata.address === "123 Main St, Austin TX" && row.metadata.listing_id === "lst-1" && row.metadata.source_url === zillowHit && row.metadata.captured_at === "2026-09-23T10:00:00.000Z" && row.metadata.customer_facing_value === false && /not an appraisal/.test(String(row.metadata.disclaimer)))
  check("the result itself says pending + never a customer-facing value", r.ok && r.approvalStatus === "pending" && r.customerFacingValue === false && r.source === "zillow_zestimate")
  const cacheRead = svc.predicates.find((p) => p.some(([k]) => k === "metadata->>cache_key"))
  check("the URL+day cache read carries the TENANT predicate (brokerage_id + visibility_scope=brokerage) — one tenant's still is never another's", !!cacheRead && cacheRead.some(([k, v]) => k === "brokerage_id" && v === TENANT) && cacheRead.some(([k, v]) => k === "visibility_scope" && v === "brokerage"))
  check("the tenant row uses only live marketing_assets columns and CHECK'd values", (() => {
    const cols = new Set(SCHEMA_SNAPSHOT.marketing_assets); const v = CHECK_VOCABULARIES.marketing_assets
    return !!row && Object.keys(row).every((k) => cols.has(k)) && v.approval_status.includes(row.approval_status) && v.visibility_scope.includes(row.visibility_scope) && v.asset_type.includes(row.asset_type)
  })())
}
{
  const provider = countingProvider(); const svc = makeSvc()
  const r = await captureScreenshot({ kind: "os_surface", surfaceId: "command_center", owner: { brokerageId: TENANT, createdBy: null } }, { svc, provider, findDemo: async () => ({ id: "demo" }) })
  check("an os_surface capture with a tenant owner REFUSES before the provider (OS stills stay demo-tenant-only)", !r.ok && /demo-tenant-only/.test(r.reason) && provider.calls.length === 0)
  const off = await capturePublicPropertyPage("123 Main St Austin", { svc, provider, search: async () => [{ url: zillowHit }] }, { domains: ["example.com"] })
  check("a search domain off PUBLIC_PAGE_HOSTS refuses before searching (fail closed)", !off.ok && /not on PUBLIC_PAGE_HOSTS/.test(off.reason) && provider.calls.length === 0)
  const none = await captureTenantEstimateStill({ brokerageId: TENANT, userId: null, source: "zillow_zestimate", address: "9 Nowhere Ln, Austin TX" }, { svc, provider, search: async () => [{ url: redfinHit }] })
  check("no Zillow hit (only an off-list portal page) → honest refusal, nothing captured", !none.ok && /found no public property page on zillow\.com/.test(none.reason) && provider.calls.length === 0)
  const pub = planScreenshotCapture({ kind: "public_page", url: zillowHit }, { siteOrigin: "", now: new Date("2026-09-23T00:00:00Z") })
  const platformRow = pub.ok ? screenshotAssetRow(pub, "https://cdn/x.png", "2026-09-23T00:00:00.000Z", "puppeteer") : null
  check("without an owner the seam still writes the PLATFORM row (brokerage_id null, visibility platform) — the platform door is unchanged", !!platformRow && platformRow.brokerage_id === null && platformRow.visibility_scope === "platform" && platformRow.approval_status === "pending")
}

console.log("\n[4 · never a customer-facing value]")
{
  const customerFacingDirs = ["lib/ai-isa", "lib/voice", "lib/portal", "app/portal", "app/api/portal", "app/api/public", "app/api/widget", "lib/customer-portal", "lib/platform"]
  const customerFiles = customerFacingDirs.flatMap((d) => walk(join(root, d)))
  const offenders = customerFiles.filter((f) => /tenant-screenshot-door|estimate-sources/.test(strippedKeepStrings(f))).map(rel)
  check(`no customer-facing module (${customerFiles.length} files under ${customerFacingDirs.join(", ")}) imports the tenant door or the source vocabulary`, offenders.length === 0, offenders.join(", "))
  check("CONTROL: the importer finder recognises a specimen", /tenant-screenshot-door/.test(stripComments(`const { approvedTenantStill } = await import("@/lib/marketing/tenant-screenshot-door")`)))
  const READ_OFF_PAGE_RE = /page\.evaluate\(|\$eval\(|innerText|textContent|page\.content\(/
  check("neither the door nor the seam reads text off a captured page (pixels only — no evaluate/$eval/innerText/content)", !READ_OFF_PAGE_RE.test(stripped(DOOR)) && !READ_OFF_PAGE_RE.test(stripped(SEAM)))
  check("CONTROL: the read-off-page finder recognises a specimen", READ_OFF_PAGE_RE.test(`const v = await page.$eval(".zestimate", (e) => e.textContent)`))
  const stills = [
    { id: "p", url: "https://c/p.png", label: "", kind: "public_page" as const, uses: ["marketing_campaign" as const], approvalStatus: "pending", sourceUrl: null, capturedAt: null, estimateSource: "zillow_zestimate", address: "123 Main St", customerFacingValue: false as const },
    { id: "a", url: "https://c/a.png", label: "", kind: "public_page" as const, uses: ["marketing_campaign" as const], approvalStatus: "approved", sourceUrl: null, capturedAt: null, estimateSource: "zillow_zestimate", address: "123 main st", customerFacingValue: false as const },
    { id: "r", url: "https://c/r.png", label: "", kind: "public_page" as const, uses: ["marketing_campaign" as const], approvalStatus: "approved", sourceUrl: null, capturedAt: null, estimateSource: "redfin_estimate", address: "9 Elm", customerFacingValue: false as const },
  ]
  check("pickApprovedStill never returns a pending row; matches source + address case/space-insensitively", pickApprovedStill(stills, { source: "zillow_zestimate", address: " 123  MAIN st" })?.id === "a" && pickApprovedStill([stills[0]], { source: "zillow_zestimate" }) === null && pickApprovedStill(stills, { source: "homes_estimate" }) === null)
  check("CONTROL: the picker does return an approved row when the filter is open", pickApprovedStill(stills)?.id === "a")
}

console.log("\n[5 · the autonomous ensure + the playbook consumes the still]")
{
  const mk = (approval: string, address = "123 Main St, Austin TX"): Row => ({ id: `row-${approval}`, brokerage_id: TENANT, visibility_scope: "brokerage", approval_status: approval, asset_url: `https://c/${approval}.png`, asset_name: "Zestimate — 123 Main", tags: ["screenshot", "use:marketing_campaign", "use:product_video"], metadata: { asset_kind: "screenshot", screenshot_kind: "public_page", estimate_source: "zillow_zestimate", address, cache_key: "k" }, updated_at: "2026-09-23T00:00:00Z" })
  const deps = (svc: any) => ({ svc, provider: countingProvider(), fetchRobots: robotsAllow, search: async () => [{ url: zillowHit }] })
  {
    const svc = makeSvc([mk("approved")])
    const o = await ensureZestimateChallengeStill({ svc, brokerageId: TENANT, userId: "u", address: "123 Main St, Austin TX" }, deps(svc))
    check("approved still exists → state approved with its url, nothing captured", o.state === "approved" && o.url === "https://c/approved.png" && svc.inserted.length === 0)
  }
  {
    const svc = makeSvc([mk("pending")])
    const o = await ensureZestimateChallengeStill({ svc, brokerageId: TENANT, userId: "u", address: "123 Main St, Austin TX" }, deps(svc))
    check("pending still exists → state pending, url null (never used), nothing captured (idempotent)", o.state === "pending" && o.url === null && svc.inserted.length === 0)
  }
  {
    const svc = makeSvc([mk("approved", "9 Elm St, Austin TX")], { insertId: "fresh" })
    const d = deps(svc)
    const o = await ensureZestimateChallengeStill({ svc, brokerageId: TENANT, userId: "u", address: "123 Main St, Austin TX", listingId: "lst-9" }, d)
    check("no still for THIS address → the OS captures one (pending) and reports captured, url null", o.state === "captured" && o.assetId === "fresh" && o.url === null && svc.inserted.length === 1 && (svc.inserted[0] as any).approval_status === "pending" && (svc.inserted[0] as any).metadata.listing_id === "lst-9" && d.provider.calls.length === 1)
    check("the autonomous capture defaults to the play's own source (zillow) and tags marketing_campaign only (83C)", o.source === "zillow_zestimate" && !(svc.inserted[0] as any).tags.includes("use:product_video") && (svc.inserted[0] as any).tags.includes("use:marketing_campaign"))
  }
  {
    const svc = makeSvc([])
    const o = await ensureZestimateChallengeStill({ svc, brokerageId: TENANT, userId: "u", address: null }, deps(svc))
    check("no address → no_address, nothing captured (never a fabricated page)", o.state === "no_address" && svc.inserted.length === 0)
    const other = makeSvc([mk("approved")])
    const list = await listScreenshotStillsForUse(other, "marketing_campaign", { brokerageId: OTHER_TENANT, approvedOnly: true })
    check("another tenant's scoped list carries its own brokerage predicate and does not see this tenant's still", list.length === 0 && other.predicates.some((p) => p.some(([k, v]) => k === "brokerage_id" && v === OTHER_TENANT)))
    // 83C: a legacy still tagged use:product_video is never listed for video (the seam clamps public_page rows).
    const vids = await listScreenshotStillsForUse(makeSvc([mk("approved"), mk("pending")]), "product_video", { brokerageId: TENANT, approvedOnly: true })
    const camp = await listScreenshotStillsForUse(makeSvc([mk("approved"), mk("pending")]), "marketing_campaign", { brokerageId: TENANT, approvedOnly: true })
    check("a legacy Zestimate still tagged product_video is listed for NO video; the same row IS listed for marketing_campaign (control)", vids.length === 0 && camp.length >= 1)
    const setOther = await setScreenshotUses(makeSvc([mk("approved")]), "row-approved", ["marketing_campaign"], { brokerageId: OTHER_TENANT })
    check("setScreenshotUses under another tenant's scope matches 0 rows and REFUSES (§3 counted update)", !setOther.ok && /not found/.test(setOther.reason))
    const setMine = await setScreenshotUses(makeSvc([mk("approved")]), "row-approved", ["marketing_campaign"], { brokerageId: TENANT })
    check("CONTROL: the same update under the owning tenant succeeds", setMine.ok && setMine.uses.join() === "marketing_campaign")
  }
  const pb = strippedKeepStrings(PLAYBOOK_ACTION)
  check("installCreativePlaybook ensures the still for zestimate_challenge through the door (autonomous, session tenant)", /playbook\.key === "zestimate_challenge"/.test(pb) && /ensureZestimateChallengeStill\(\{ svc, brokerageId: ctx\.brokerageId/.test(pb) && pb.includes("@/lib/marketing/tenant-screenshot-door"))
  check("the postcard art PREFERS the approved still over the QR, and only an approved one is ever assigned", /property_photo_url: approvedStillUrl \?\? qrImageUrl/.test(pb) && /still\.state === "approved"\) \{ approvedStillUrl = still\.url/.test(pb) && !/approvedStillUrl = still\.url[^\n]*pending/.test(pb))
  check("CONTROL: the postcard-art finder would fail on the pre-lane shape", !/property_photo_url: approvedStillUrl \?\? qrImageUrl/.test("property_photo_url: qrImageUrl,"))
  check("the presentation video stages the approved still as input_props.screenshotUrls (the key assetsFromProps reads)", /screenshotUrls: approvedStillUrl \? \[approvedStillUrl\] : \[\]/.test(pb) && /input_props: \{ screenshotUrls: args\.screenshotUrls \?\? \[\] \}/.test(pb) && /arr\("screenshotUrls"\)/.test(strippedKeepStrings("lib/video/body-visual-model.ts")))
  check("the address comes from the tenant's OWN listings (cheapest rail) with the tenant predicate — never a provider", /from\("listings"\)[^\n]*\.eq\("brokerage_id", ctx\.brokerageId\)/.test(pb) && !/batchdata|rentcast/i.test(pb))
  const director = strippedKeepStrings("lib/video/video-director.ts")
  // WAVE 83C — RE-ANCHORED (owner: "zestimate is marketing campaigns strictly"). 80D's director step 6d
  // staged the tenant's stills into ANY screenshot-treatment video; every tenant still is a Zestimate page,
  // so the step is deleted (tombstone in video-director.ts) and the campaign video above keeps its still.
  check("video-director stages NO tenant still (the 80D step 6d is tombstoned; a Zestimate stays in its campaign)", !/tenantScreenshotUrlsForVideo|tenant-screenshot-door/.test(director) && !/export async function tenantScreenshotUrlsForVideo/.test(strippedKeepStrings(DOOR)))
  check("the treatments registry still carries a screenshot-rendering composition (the campaign video's still has a live renderer)", Object.values(COMPOSITION_TREATMENTS).some((t) => t.includes("screenshot")))
}

console.log("\n[6 · the approval rail is the EXISTING one]")
{
  const card = strippedKeepStrings(CARD)
  check("the tenant card mounts the tenant actions and decides through marketing-studio's approveAsset / rejectAsset — no new approval writer", card.includes("@/app/actions/marketing/tenant-screenshots") && /import \{ approveAsset, rejectAsset \} from "@\/app\/actions\/marketing-studio"/.test(card) && card.includes("captureEstimateStillAction("))
  check("the card is mounted (imported by the campaign-bundles client beside the playbooks)", /EstimateStillsCard/.test(strippedKeepStrings("app/settings/campaign-bundles/client.tsx")) && /<EstimateStillsCard \/>/.test(src("app/settings/campaign-bundles/client.tsx")))
  const studio = strippedKeepStrings("app/actions/marketing-studio.ts")
  const approveChunk = studio.slice(studio.indexOf("export async function approveAsset"), studio.indexOf("export async function rejectAsset"))
  check("marketing-studio approveAsset flips marketing_assets to approved WITH the tenant predicate (.eq brokerage_id)", /approval_status: "approved"/.test(approveChunk) && /\.eq\("brokerage_id", brokerageId\)/.test(approveChunk))
  // REJECTION KEEPS PROVENANCE. marketing_assets.metadata carries the row's provenance (asset_kind,
  // estimate_source, address, source_url, captured_at, customer_facing_value:false); a rejection
  // that REPLACES the jsonb with { rejection_reason } erases it and hides the row from
  // asset_kind-scoped reads. The rule: rejectAsset reads the current metadata under the tenant
  // predicate and SPREADS it into what it writes, and both decisions COUNT their update (§3).
  const rejectChunk = studio.slice(studio.indexOf("export async function rejectAsset"))
  const rejectEnd = rejectChunk.indexOf("\nexport ", 1)
  const reject = rejectEnd > 0 ? rejectChunk.slice(0, rejectEnd) : rejectChunk
  const replacesMetadata = (fn: string) => /metadata:\s*\{\s*rejection_reason/.test(fn)
  const mergesMetadata = (fn: string) =>
    /\.select\("metadata"\)[\s\S]*?\.eq\("id", assetId\)\s*\.eq\("brokerage_id", brokerageId\)/.test(fn)
    && /\.\.\.existing/.test(fn) && /metadata:\s*merged/.test(fn)
  check("rejectAsset MERGES rejection_reason into the row's existing metadata (read under the tenant predicate, spread, then written) — provenance keys survive a rejection",
    mergesMetadata(reject) && !replacesMetadata(reject))
  check("POSITIVE CONTROL: the pre-fix shape (metadata: { rejection_reason … }) IS caught as a replace",
    replacesMetadata(`.update({ approval_status: "rejected", metadata: { rejection_reason: reason ?? "Not specified" }, updated_at: x })`))
  check("POSITIVE CONTROL: a merge that never reads the current row is NOT accepted as a merge",
    !mergesMetadata(`const merged = { ...existing, rejection_reason: r }; await supabase.from("marketing_assets").update({ metadata: merged })`))
  const counted = (fn: string, status: string) =>
    new RegExp(`approval_status: "${status}"[\\s\\S]*?\\.eq\\("brokerage_id", brokerageId\\)\\s*\\.select\\("id"\\)`).test(fn)
    && /length === 0\)/.test(fn)
  check("approveAsset and rejectAsset COUNT their update (.select(\"id\") + zero rows is a refusal, CLAUDE.md §3)",
    counted(approveChunk, "approved") && counted(reject, "rejected"))
  check("POSITIVE CONTROL: an uncounted update is flagged",
    !counted(`.update({ approval_status: "approved" }).eq("id", assetId).eq("brokerage_id", brokerageId)`, "approved"))
  check("approveAsset reads the asset under the tenant predicate before its compliance gate",
    /\.select\("asset_type, preview_text"\)\s*\.eq\("id", assetId\)\s*\.eq\("brokerage_id", brokerageId\)/.test(approveChunk))
  check("no writer in the door/action/card flips approval_status itself", !/approval_status: "approved"/.test(strippedKeepStrings(DOOR)) && !/approval_status/.test(strippedKeepStrings(ACTION)) && !/approval_status: "approved"/.test(card))
  check("an APPROVED brokerage image row already joins the tenant's image-library picker (approved + brokerage_id.eq) — no second picker", /\.eq\("approval_status", "approved"\)/.test(strippedKeepStrings("app/actions/marketing/image-library.ts")) && /brokerage_id\.eq\.\$\{brokerageId\}/.test(strippedKeepStrings("app/actions/marketing/image-library.ts")))
  const regen = strippedKeepStrings("app/api/cron/marketing-image-regen/route.ts")
  check("the regen cron selects brokerage_id/created_by/tags so a tenant still re-captures INTO its tenant (owner off the row)", /select\("id, brokerage_id, created_by, tags,/.test(regen) && /row\.brokerage_id/.test(strippedKeepStrings(SEAM)))
}

console.log("\n[7 · registration]")
{
  const pkg = JSON.parse(src("package.json")) as { scripts: Record<string, string> }
  check("package.json registers test:tenant-screenshot-door under react-server", /--conditions=react-server scripts\/tenant-screenshot-door-guard\.ts/.test(pkg.scripts["test:tenant-screenshot-door"] ?? ""))
  check("the guard chain runs it after test:scrapers (ordering, not adjacency)", pkg.scripts.guard.indexOf("npm run test:scrapers") > 0 && pkg.scripts.guard.indexOf("npm run test:tenant-screenshot-door") > pkg.scripts.guard.indexOf("npm run test:scrapers"))
  const d = MAINTENANCE_DOMAINS.tenant_screenshot_door
  check("MAINTENANCE_DOMAINS.tenant_screenshot_door → campaign_orchestrator, proof test:tenant-screenshot-door, coOwners asset_manager + compliance_officer (the prose names both)", d?.manager === "campaign_orchestrator" && d?.proof === "test:tenant-screenshot-door" && (d?.coOwners ?? []).includes("asset_manager") && (d?.coOwners ?? []).includes("compliance_officer") && /Already existed|ALREADY EXISTED/.test(d?.what ?? ""))
  // THE RULE, not the waypoint (CLAUDE.md §2): the door rides the existing tags array +
  // metadata jsonb, so NO migration may carry its vocabulary. The old form pinned "no m664
  // file exists" — true only while 80D's reserved number sat unused; wave 81D spent m664 on the
  // QR registry's platform owner, and the door still needs no migration.
  const DOOR_VOCAB_RE = /estimate_still|use:marketing_campaign|use:product_video|customer_facing_value|estimate_source/
  const migrationsDir = join(root, "supabase/migrations")
  const vocabMigrations = readdirSync(migrationsDir).filter((f) => /\.sql$/.test(f) && DOOR_VOCAB_RE.test(readFileSync(join(migrationsDir, f), "utf8")))
  check("no migration carries the door's vocabulary (uses ride tags + metadata — a screenshot still needs no schema)", vocabMigrations.length === 0, vocabMigrations.join(", "))
  check("CONTROL: the vocabulary finder recognises a specimen migration", DOOR_VOCAB_RE.test("ALTER TABLE marketing_assets ADD CONSTRAINT x CHECK (tags @> ARRAY['use:product_video'])"))
  check("SCREENSHOT_USES still carries the two uses the tenant door tags", (SCREENSHOT_USES as readonly string[]).includes("marketing_campaign") && (SCREENSHOT_USES as readonly string[]).includes("product_video"))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed} failed`)
console.log("blind spots: the stubbed runs never navigate (public-page capture is proxy-blocked in this sandbox — a real capture is a smoke run in a host that reaches the portals); the customer-facing scan covers named directories only; the playbook and director wiring are proved by stripped source, not by a live install; approveAsset's brand-compliance step is marketing-studio's own and is not exercised here.")
if (failed) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1) }
