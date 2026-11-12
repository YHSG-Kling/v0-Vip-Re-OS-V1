#!/usr/bin/env tsx
/**
 * scripts/qr-registry-guard.ts   (npm run test:qr-registry)
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY QR THE OS CREATES IS IN THE QR MANAGEMENT REGISTRY (wave 81, lane 81D —
 * owner verbatim: "the qrcode system agent needs to make sure that any qrcode
 * that gets created for assets are added to the qrcode management which is
 * wired to the platform if used for platform or tenants dashboard").
 *
 * THE SURVIVOR: qr_codes, written ONLY by lib/marketing/tracked-qr.ts
 * mintTrackedQr, scanned ONLY through /api/qr/scan (qr_scan_events). Two
 * boards read it: the tenant board (app/dashboard/agent/qr-codes) and the
 * platform board (app/dashboard/superadmin/qr-codes); ONE classifier
 * (qrOwnerKind) says who owns a row.
 *
 * THE SWEEP (registration by construction, proved on stripped source):
 *   Every live file (lib/, app/, remotion/) that EMITS a QR image — a token of
 *   QRCode.toDataURL / QRCode.toCanvas / renderQrPng / a third-party renderer
 *   URL — must be one of:
 *     · the registry itself (tracked-qr.ts),
 *     · a caller of the minter (mintTrackedQr(),
 *     · an encoder of the tracked resolver (`/api/qr/scan?slug=` — a code that
 *       already exists in the registry, re-encoded for display/print), or
 *     · a consumer of a `qrScanUrl` field whose PRODUCER derives it from a
 *       minted scan_url (the direct-mail render chain), or
 *     · on the EXEMPT list with its reason (the per-recipient unsubscribe QR —
 *       a compliance affordance encoding /unsubscribe/<token>, not a marketing
 *       asset; registering one row per recipient would turn the registry into
 *       a mailing list).
 *   A third-party renderer (api.qrserver.com) in live code fails outright.
 *   POSITIVE CONTROLS: a specimen raw-URL emitter is caught; a specimen
 *   qrserver URL is caught.
 *
 * Plus: the studio's QR asset registers (createAsset mints + links); the
 * platform/tenant owner model and the platform mint path on a stub client
 * (label namespaced, brokerage null, honest null on refusal); both boards and
 * the home link exist; m664 is applied live (2026-09-24) and names the same
 * prefix the code uses; registration in package.json + MAINTENANCE_DOMAINS.
 *
 * No network, no DB. Run: npx tsx --conditions=react-server scripts/qr-registry-guard.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments, blankStrings } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { memSupabase } from "./in-memory-supabase"
import { mintTrackedQr, qrOwnerKind, PLATFORM_QR_LABEL_PREFIX, QR_PURPOSES, qrScanEvidence } from "../lib/marketing/tracked-qr"
import { summarizeQrRegistry } from "../lib/marketing/qr-registry-board"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
// WAVE 152 (lane 152C) — the governed doors and the pure contract they decide with, driven for real on the in-memory client.
import { mintGovernedQr, editQrDestination, changeQrLifecycle, duplicateQrDesign, loadQrActivity, classifyScanForCode, type QrActor } from "../lib/marketing/qr-governance"
import {
  QR_TOKEN_SHAPE, QR_RETIRED_REASONS, QR_TRAFFIC_CLASSES, QR_DEVICE_CLASSES, QR_PLACEMENT_TYPES, QR_REPEAT_WINDOW_MS,
  validateQrDestination, resolveQrScanDestination, qrLifecycleState, qrUnavailableNotice, classifyQrScan, summarizeQrScans,
  appendQrDestinationVersion, coarseNetworkPrefix, qrDeviceClass, qrLabelKind, isAbsentColumnRefusal,
} from "../lib/marketing/qr-contract"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const rel = (p: string) => p.replace(root + "/", "")
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(p.startsWith("/") ? p : join(root, p), "utf8")
const stripped = (p: string) => stripComments(src(p))
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

const REGISTRY = "lib/marketing/tracked-qr.ts"
/** Prose registries whose STRING literals document code (MAINTENANCE_DOMAINS
 *  names emitters and the retired renderer by name) — documentation, not
 *  emission; excluded from the token scans by name, never by pattern. */
const PROSE = new Set(["lib/kernel/manager-registry.ts"])
// WAVE 152 (152C): + QRCode.toString( — the SVG encoder (the letter's print region, the board's SVG download) was a
// blind spot of this sweep; it now counts as an emission and must be registered like every other.
const EMIT_RE = /QRCode\.toDataURL\(|QRCode\.toCanvas\(|QRCode\.toString\(|renderQrPng\(|qrserver\.com|create-qr-code/
const THIRD_PARTY_RE = /qrserver\.com|create-qr-code/
const MINTS_RE = /mintTrackedQr\(/
const TRACKED_RESOLVER_RE = /\/api\/qr\/scan\?slug=/
const CONSUMES_SCAN_URL_RE = /\bqrScanUrl\b/
/** Files that emit a QR image outside the registry ON PURPOSE, each with its reason. */
const EXEMPT: Record<string, string> = {
  "lib/direct-mail/mail-opt-out-affordance.ts": "per-recipient UNSUBSCRIBE QR (/unsubscribe/<token>) — a compliance affordance, not a marketing asset; one registry row per recipient would make qr_codes a mailing list",
}

function classify(file: string, code: string): "registry" | "mints" | "encodes_tracked" | "consumes_scan_url" | "exempt" | "unregistered" {
  const r = rel(file)
  if (r === REGISTRY) return "registry"
  if (EXEMPT[r]) return "exempt"
  if (MINTS_RE.test(code)) return "mints"
  if (TRACKED_RESOLVER_RE.test(code)) return "encodes_tracked"
  if (CONSUMES_SCAN_URL_RE.test(code)) return "consumes_scan_url"
  return "unregistered"
}

// A stub qr_codes client: records predicates + inserts; `refuseInsert` simulates the live NOT NULL.
function stubClient(opts: { existing?: { id: string; slug: string } | null; refuseInsert?: boolean } = {}) {
  const inserts: Array<Record<string, unknown>> = []
  const preds: Array<[string, unknown]> = []
  const chain = () => {
    const q: any = {}
    q.select = () => q
    q.eq = (k: string, v: unknown) => { preds.push([k, v]); return q }
    q.is = (k: string, v: unknown) => { preds.push([`is:${k}`, v]); return q }
    q.in = () => q
    q.update = () => q
    q.maybeSingle = async () => (q._inserted
      ? (opts.refuseInsert ? { data: null, error: { message: "null value in column \"brokerage_id\" violates not-null constraint" } } : { data: { id: "qr-new", slug: q._inserted.slug }, error: null })
      : { data: opts.existing ?? null, error: null })
    q.insert = (row: Record<string, unknown>) => { inserts.push(row); q._inserted = row; return q }
    q.then = (res: any, rej: any) => Promise.resolve({ data: [], error: null }).then(res, rej)
    return q
  }
  return { inserts, preds, from: () => chain() } as any
}

async function main() {
  console.log("\n[1 · the sweep — every QR emitter in live code is registered by construction]")
  const files = ["lib", "app", "remotion"].flatMap((d) => walk(join(root, d))).filter((f) => !PROSE.has(rel(f)))
  const emitters = files.map((f) => ({ f, code: stripped(f) })).filter((x) => EMIT_RE.test(x.code))
  const unregistered = emitters.filter((x) => classify(x.f, x.code) === "unregistered").map((x) => rel(x.f))
  const thirdParty = emitters.filter((x) => THIRD_PARTY_RE.test(blankStrings(x.code) + x.code) && THIRD_PARTY_RE.test(x.code)).map((x) => rel(x.f))
  const byClass = emitters.reduce<Record<string, string[]>>((m, x) => { const c = classify(x.f, x.code); (m[c] ??= []).push(rel(x.f)); return m }, {})
  console.log(`    denominator: ${files.length} files scanned, ${emitters.length} QR emitters — ${Object.entries(byClass).map(([k, v]) => `${k}=${v.length}`).join(", ")}`)
  check("every QR emitter is the registry, mints through it, encodes a registered code's scan link, consumes a minted qrScanUrl, or is exempt with a reason", unregistered.length === 0, unregistered.join(", "))
  check("no live file renders a QR through a third-party service (api.qrserver.com / create-qr-code)", thirdParty.length === 0, thirdParty.join(", "))
  check("CONTROL: a specimen raw-URL emitter is caught as unregistered", classify(join(root, "lib/x/specimen.ts"), stripComments(`import QRCode from "qrcode"\nexport async function badge() { return QRCode.toDataURL("https://example.com/flyer") }`)) === "unregistered")
  check("CONTROL: a specimen third-party renderer is caught; a comment mentioning it is not", THIRD_PARTY_RE.test(stripComments(`const s = "https://api.qrserver.com/v1/create-qr-code/?data=x"`)) && !THIRD_PARTY_RE.test(stripComments(`// it used to be api.qrserver.com\nconst s = 1`)))
  check("every exempt file exists and still emits (an exemption for nothing is a stale rule)", Object.keys(EXEMPT).every((p) => existsSync(join(root, p)) && EMIT_RE.test(stripped(p))))
  check("the direct-mail chain's qrScanUrl PRODUCERS derive it from a minted scan_url (never a typed URL)", (() => {
    // A PRODUCER assigns the field from a value (not a pass-through of args/params/input/opts,
    // not a type annotation `qrScanUrl: string | null`, not a null literal).
    const PASSTHROUGH_RE = /^(args|params|input|opts|preset|presetArgs)\.|^null\b|^string\b/
    const producers = files.map((f) => ({ f, code: stripped(f) })).filter((x) =>
      [...x.code.matchAll(/\bqrScanUrl:\s*([^\n,]+)/g)].some((m) => !PASSTHROUGH_RE.test(m[1].trim())))
    // FINDING, published (2026-09-24): ZERO producers existed — orchestrate-send / -bundle-send /
    // -preset-send all pass args.qrScanUrl through and every caller omitted it, so a PRINTED
    // postcard carried no tracked QR even though ai-direct-mail minted one for the campaign
    // (direct_mail_campaigns.qr_code_id). CLOSED (wave 82D): the approved-campaign drain
    // (lib/direct-mail/campaign-drain.ts) and the CRM bundle send (app/actions/
    // campaign-bundle-dispatch.ts) now mint/reuse the campaign's code through mintTrackedQr and
    // pass its scanUrl — the count moved 0 → 2 BECAUSE the defect was fixed. scripts/
    // estimate-comparison-guard.ts holds the producers ≥ the two drains (a rule, not a count).
    // WAVE 83C: 2 → 6 — the four senders 82D named (agent client messages, listing-appointment prep,
    // the lifecycle reactor, farm mail) now mint through mintTrackedQr and pass its scanUrl; the
    // count moved UP because the defect was fixed (estimate-comparison-guard section 7 holds each).
    console.log(`    qrScanUrl producers (non-passthrough, non-null): ${producers.length} — ${producers.map((x) => rel(x.f)).join(", ") || "none (printed postcards carry no tracked QR — a regression of the 82D fix)"}`)
    return producers.every((x) => /scan_url|scanUrl|mintTrackedQr\(/.test(x.code))
  })())
  check("the registry is the ONLY writer of qr_codes (no other live file inserts into it)", files.filter((f) => rel(f) !== REGISTRY && /from\("qr_codes"\)[\s\S]{0,200}\.insert\(/.test(blankStrings(stripped(f)))).length === 0)
  check("scans are tracked through the ONE resolver (app/api/qr/scan writes qr_scan_events)", /from\(['"]qr_scan_events['"]\)/.test(stripped("app/api/qr/scan/route.ts")))

  console.log("\n[2 · the studio's QR asset is a REGISTERED code]")
  const studio = stripped("app/actions/marketing-studio.ts")
  const studioClient = stripped("app/dashboard/marketing/studio/marketing-studio-client.tsx")
  check("createAsset(assetType=qr) mints through mintTrackedQr, stores the tracked PNG, and links the code to the asset", /params\.assetType === "qr"[\s\S]{0,900}mintTrackedQr\(\{[\s\S]{0,600}assetUrl = minted\.qrCodeDataUrl[\s\S]{0,1600}from\("marketing_asset_qr_links"\)[\s\S]{0,200}\.insert\(/.test(studio))
  check("the asset link uses a LIVE placement_type (CHECK'd), never qr-asset-linker's stale 'other'", (() => { const m = studio.match(/qr_code_id: mintedQrId, placement_type: "([a-z_]+)"/); return !!m && CHECK_VOCABULARIES.marketing_asset_qr_links.placement_type.includes(m[1]) })())
  check("the studio client no longer pre-renders a raw-URL QR (no renderQrImageAction import; qrTargetUrl rides to the action)", !/renderQrImageAction/.test(studioClient) && /qrTargetUrl: newAsset\.assetType === "qr"/.test(studioClient))
  check("renderQrImageAction (an unregistered raw-URL emitter) is retired with a tombstone naming the survivor", !/export async function renderQrImageAction/.test(studio) && /TOMBSTONE[\s\S]{0,400}renderQrImageAction[\s\S]{0,1200}Survivor: createAsset/.test(src("app/actions/marketing-studio.ts")))
  const review = stripped("app/dashboard/marketing/review/actions.ts")
  check("the review board renders its QR PNGs server-side from the tracked scan URL (renderQrPng), not via a third party", /renderQrPng\(`\$\{scanOrigin\}\/api\/qr\/scan\?slug=/.test(review) && !/qrserver/.test(stripped("app/dashboard/marketing/review/review-client.tsx")))

  console.log("\n[3 · owner model — platform vs tenant, one classifier, one minter]")
  check("qrOwnerKind: a row with a brokerage is tenant-owned; a row without one is platform-owned", qrOwnerKind({ brokerage_id: "b1" }) === "tenant" && qrOwnerKind({ brokerage_id: null }) === "platform" && qrOwnerKind({}) === "platform")
  check("summarizeQrRegistry counts by owner + activity + scans", (() => { const s = summarizeQrRegistry([{ brokerage_id: "b", is_active: true, scan_count: 3 }, { brokerage_id: null, is_active: false, scan_count: null }]); return s.total === 2 && s.platform === 1 && s.tenant === 1 && s.active === 1 && s.scans === 3 })())
  {
    const c = stubClient()
    const r = await mintTrackedQr({ brokerageId: null, owner: "platform", label: "prospect_funnel", targetUrl: "https://os.example.test/get-started", purpose: "campaign", origin: "https://os.example.test" }, c)
    const ins = c.inserts[0] as any
    check("a PLATFORM mint looks the key up under brokerage_id IS NULL, namespaces the label, and inserts with brokerage_id null", !!r && r.created && c.preds.some(([k, v]: [string, unknown]) => k === "is:brokerage_id" && v === null) && !!ins && ins.brokerage_id === null && ins.label === `${PLATFORM_QR_LABEL_PREFIX}prospect_funnel` && r.scanUrl.startsWith("https://os.example.test/api/qr/scan?slug="))
  }
  {
    const c = stubClient({ refuseInsert: true })
    const r = await mintTrackedQr({ brokerageId: null, owner: "platform", label: "prospect_funnel", targetUrl: "https://x/y", purpose: "campaign" }, c)
    check("a platform mint the database REFUSES (the pre-m664 NOT NULL shape, or any future refusal) returns null — honest, never a row under some tenant", r === null && c.inserts.length === 1 && (c.inserts[0] as any).brokerage_id === null)
  }
  {
    const c = stubClient()
    const t = await mintTrackedQr({ brokerageId: "b1", label: "listing:L1", targetUrl: "https://x/l/1", purpose: "listing" }, c)
    const none = await mintTrackedQr({ brokerageId: null, label: "listing:L1", targetUrl: "https://x/l/1", purpose: "listing" }, stubClient())
    check("a TENANT mint predicates the lookup on its brokerage and refuses without one (fail closed)", !!t && c.preds.some(([k, v]: [string, unknown]) => k === "brokerage_id" && v === "b1") && (c.inserts[0] as any).brokerage_id === "b1" && none === null)
  }
  check("QR_PURPOSES matches the live qr_codes.purpose CHECK (one vocabulary)", [...QR_PURPOSES].sort().join() === [...CHECK_VOCABULARIES.qr_codes.purpose].sort().join())

  console.log("\n[4 · two boards, wired: tenant dashboard + platform dashboard]")
  const tenantBoard = "app/dashboard/agent/qr-codes/page.tsx"
  const platformBoard = "app/dashboard/superadmin/qr-codes/page.tsx"
  check("the tenant board exists and reads through the session-scoped loader (loadQrCodesForCaller)", existsSync(join(root, tenantBoard)) && /loadQrCodesForCaller/.test(stripped(tenantBoard)))
  const pb = stripped(platformBoard)
  check("the platform board gates on a platform capability BEFORE the service client, reads qr_codes with NO tenant predicate (platform sees all), and classifies with qrOwnerKind", existsSync(join(root, platformBoard)) && pb.indexOf("requirePlatformCapability(") < pb.indexOf("createServiceClient()") && /from\("qr_codes"\)/.test(pb) && !/\.eq\("brokerage_id"/.test(pb) && /qrOwnerKind\(/.test(pb))
  check("the platform board exports only Next page fields (no stray export)", !/^export (async )?function (?!SuperadminQrRegistryPage)/m.test(pb) && /export default async function SuperadminQrRegistryPage/.test(pb))
  check("the superadmin home links the platform board (no orphan route)", /\/dashboard\/superadmin\/qr-codes/.test(stripped("app/dashboard/superadmin/home/page.tsx")))

  console.log("\n[5 · migration m664 — applied live 2026-09-24; consistent with the code]")
  const mig = "supabase/migrations/m664-qr-codes-platform-owner.sql"
  const migSrc = existsSync(join(root, mig)) ? src(mig) : ""
  check("m664 exists, states its status once (APPLIED LIVE — never a waypoint pin on the pre-apply header), relaxes qr_codes + qr_scan_events brokerage_id, and CHECKs the platform label prefix the code uses", /APPLIED LIVE/.test(migSrc) && !/WRITTEN, NOT APPLIED/.test(migSrc) && /qr_codes ALTER COLUMN brokerage_id DROP NOT NULL/.test(migSrc) && /qr_scan_events ALTER COLUMN brokerage_id DROP NOT NULL/.test(migSrc) && migSrc.includes(`label LIKE '${PLATFORM_QR_LABEL_PREFIX}%'`))

  console.log("\n[6 · registration]")
  const pkg = JSON.parse(src("package.json"))
  check("package.json registers test:qr-registry and the guard chain runs it after test:scrapers (ordering)", typeof pkg.scripts["test:qr-registry"] === "string" && pkg.scripts.guard.indexOf("npm run test:scrapers") < pkg.scripts.guard.indexOf("npm run test:qr-registry"))
  const dom = (MAINTENANCE_DOMAINS as any).qr_registry
  check("MAINTENANCE_DOMAINS.qr_registry names a manager, this proof, and coOwners", !!dom && dom.proof === "test:qr-registry" && Array.isArray(dom.coOwners) && dom.coOwners.length >= 1)

  await wave152Sections()

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(` blind spots: the sweep recognises QR emission by the tokens QRCode.toDataURL/toCanvas/toString, renderQrPng and third-party renderer URLs (a hand-rolled QR encoder would not be seen); "encodes a registered code" is proved by the /api/qr/scan?slug= literal, not by tracing the slug to a row; scripts/ are out of the denominator; the platform mint runs on a stub client — the live NOT NULL refusal is asserted by simulation until m664 is applied. WAVE 152: the governed doors run on the in-memory client (no CHECKs, no RLS, no trigger — m945's trigger rules are read from the SQL, the code's append-only behavior is driven); the session gates (resolveWriteContext) are proved on stripped source, not executed; the optimistic-concurrency conflict branch of the destination edit is asserted by construction (the in-memory client cannot interleave two writers); token unpredictability is the CSPRNG's (node:crypto randomBytes), sampled here for uniqueness and alphabet coverage, not proven statistically; the scan door's end-to-end run lives in scripts/marketing-qr-simulator.ts.`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ QR_REGISTRY_PASS")
}

// ─── WAVE 152 (lane 152C) — ONE REGISTRY: UNIQUE MINT, SAFE DESTINATION, MANAGEMENT, EVIDENCE ─────────────────────
// Owner (verbatim, 2026-11-11): "qr minted bar code has a destination url and each bar code needs is unique and needs
// tracking, creating one and managing." Directive 152C proofs (line 312) — each driven on the REAL exported survivors.

const ORIGIN = "https://app.example.test"
const A: QrActor = { brokerageId: "bA", userId: "uA", agentId: "agA", userType: "agent" }
const B: QrActor = { brokerageId: "bB", userId: "uB", agentId: "agB", userType: "agent" }
const LEAD: QrActor = { brokerageId: "bA", userId: "uLead", agentId: "agLead", userType: "agent" }
const CONTACT_UUID = "7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f"

function registryDb(opts: { missingColumns?: Record<string, string[]> } = {}) {
  return memSupabase({
    brokerages: [{ id: "bA", website: null }, { id: "bB", website: null }],
    users: [{ id: "uA", brokerage_id: "bA", first_name: "Ann", last_name: "Agent" }, { id: "uB", brokerage_id: "bB" }, { id: "uLead", brokerage_id: "bA" }],
    agents: [{ id: "agA", user_id: "uA", brokerage_id: "bA", team_id: null, location_id: null }, { id: "agLead", user_id: "uLead", brokerage_id: "bA", team_id: "tA", location_id: null }, { id: "agB", user_id: "uB", brokerage_id: "bB" }],
    teams: [{ id: "tA", brokerage_id: "bA", team_lead_id: "uLead" }],
    locations: [{ id: "oA", brokerage_id: "bA", managing_broker_user_id: "uLead" }],
    marketing_campaigns: [{ id: "cA", brokerage_id: "bA" }],
    listings: [{ id: "LA", brokerage_id: "bA" }],
    tenant_custom_domains: [{ brokerage_id: "bA", domain: "homes.alder.example", status: "active" }, { brokerage_id: "bA", domain: "pending.alder.example", status: "pending_dns" }],
    brokerage_brand_settings: [{ brokerage_id: "bA", website_url: "https://alderrealty.example/about" }],
    qr_codes: [], qr_scan_events: [], agent_action_ledger: [],
  }, { uuidIds: true, stampCreatedAt: true, missingColumns: opts.missingColumns, unique: { agent_action_ledger: [["idempotency_key"]], qr_codes: [["slug"]] } })
}
const deps = (db: ReturnType<typeof registryDb>) => ({ client: db, ledgerClient: db, origin: ORIGIN, appOrigins: [ORIGIN] })
const ledgerRows = (db: ReturnType<typeof registryDb>, action: string, status = "executed") => db.tables.agent_action_ledger.filter((r: any) => r.action === action && r.status === status)
const baseMint = { purpose: "general" as const, destinationType: "landing_page" as const }

async function wave152Sections() {
  console.log("\n[7 · THE UNIQUE TOKEN — unpredictable, never the label, never a person]")
  {
    const db = registryDb()
    const tokenRe = new RegExp(`^[${QR_TOKEN_SHAPE.alphabet}]{${QR_TOKEN_SHAPE.length}}$`)
    const a = await mintTrackedQr({ brokerageId: "bA", label: `pre_listing_kit:${CONTACT_UUID}`, purpose: "campaign", origin: ORIGIN }, db as never)
    const b = await mintTrackedQr({ brokerageId: "bA", label: "estimate_comparison:123-main-st-springfield", purpose: "lead_capture", origin: ORIGIN }, db as never)
    // The finder this section relies on: does a printed URL carry any 8+-symbol run of the label's entity?
    const leaksEntity = (url: string, entity: string) => entity.replace(/[^a-z0-9]/gi, "-").toLowerCase().split("-").filter((p) => p.length >= 4).some((p) => url.toLowerCase().includes(p))
    check("an automatic mint draws a CSPRNG token of the contract's shape (22 symbols, the 32-symbol alphabet), not the label + a timestamp", !!a && tokenRe.test(a.slug) && !!b && tokenRe.test(b.slug) && a.slug !== b.slug)
    check("a Contact id in a minter's LABEL never reaches the printed URL (pre_listing_kit:<contactId>)", !!a && !leaksEntity(a.scanUrl, CONTACT_UUID) && a.scanUrl === `${ORIGIN}/api/qr/scan?slug=${a.slug}`)
    check("a home address in a minter's LABEL never reaches the printed URL (estimate_comparison:<street>)", !!b && !leaksEntity(b.scanUrl, "123-main-st-springfield"))
    check("CONTROL: the finder catches the OLD recipe (`<label lower-cased, 40>-<Date.now() base36>`) leaking the Contact id", leaksEntity(`${ORIGIN}/api/qr/scan?slug=${`pre_listing_kit:${CONTACT_UUID}`.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 40)}-${Date.now().toString(36)}`, CONTACT_UUID))
    check("the label stays a SERVER-side key (stored as typed; the code's own landing is its default destination)", !!a && (db.tables.qr_codes.find((r: any) => r.id === a.qrCodeId) as any)?.label === `pre_listing_kit:${CONTACT_UUID}` && a.targetUrl === `${ORIGIN}/qr/${a.slug}`)
    const many = new Set<string>()
    const symbols = new Set<string>()
    for (let i = 0; i < 150; i++) { const m = await mintTrackedQr({ brokerageId: "bA", label: `material:flyer:${i}`, purpose: "campaign", origin: ORIGIN }, db as never); if (m) { many.add(m.slug); for (const ch of m.slug) symbols.add(ch) } }
    check(`150 mints → 150 distinct tokens; ${symbols.size}/32 alphabet symbols seen (sampling sanity, not a statistic)`, many.size === 150 && symbols.size >= 30)
    check("an automatic mint stays idempotent per label (the same listing reuses its one code)", (await mintTrackedQr({ brokerageId: "bA", label: `pre_listing_kit:${CONTACT_UUID}`, purpose: "campaign", origin: ORIGIN }, db as never))?.slug === a?.slug)
    const legacy = resolveQrScanDestination({ slug: "listing-3f2a-lx1abc", targetUrl: "/listings/LA", appOrigins: [ORIGIN] })
    check("a code minted BEFORE wave 152 (label-shaped slug) still resolves — the resolver keys on the slug, whatever its shape", legacy.kind === "in_app" && legacy.path === "/listings/LA?qr=listing-3f2a-lx1abc")
    const row = db.tables.qr_codes.find((r: any) => r.id === a?.qrCodeId) as any
    check("every automatic mint carries provenance: minted_via automated, its label kind, token scope, tracking, and destination v1", row?.mint_context?.minted_via === "automated" && row?.mint_context?.label_kind === "pre_listing_kit" && row?.mint_context?.token_scope === "per_design" && row?.mint_context?.tracking === "enabled" && row?.destination_history?.[0]?.version === 1 && row?.destination_history?.[0]?.kind === "minted")
    check("qrLabelKind: `<kind>:<id>` → kind; a typed label → manual; a platform label keeps its kind", qrLabelKind("listing:L1") === "listing" && qrLabelKind("Spring flyer") === "manual" && qrLabelKind("platform:prospect_funnel:x") === "prospect_funnel")
  }

  console.log("\n[8 · THE GOVERNED MINT — session tenant, idempotency, provenance, refusals]")
  {
    const db = registryDb()
    const m1 = await mintGovernedQr({ ...baseMint, idempotencyKey: "req-0001-aaaa", label: "Spring flyer", placement: "flyer", printSizeIn: 1.25, marketingCampaignId: "cA" }, A, deps(db))
    const m2 = await mintGovernedQr({ ...baseMint, idempotencyKey: "req-0002-bbbb", label: "Spring flyer" }, A, deps(db))
    const again = await mintGovernedQr({ ...baseMint, idempotencyKey: "req-0001-aaaa", label: "Spring flyer", placement: "flyer", printSizeIn: 1.25, marketingCampaignId: "cA" }, A, deps(db))
    check("TWO minted requests (two keys, the SAME label) → two codes with two different tokens", m1.ok && m2.ok && m1.code.id !== m2.code.id && m1.code.slug !== m2.code.slug)
    check("the SAME idempotency key → the SAME minted record (replayed: true), never a third row", again.ok && m1.ok && again.replayed && again.code.id === m1.code.id && again.code.slug === m1.code.slug && db.tables.qr_codes.length === 2)
    check("each mint is LEDGERED once (marketing.qr.mint · HUMAN_REQUESTED · LOW_RISK_WRITE · provider_ref = the code), the replay adds none", (() => { const rows = ledgerRows(db, "marketing.qr.mint"); return rows.length === 2 && rows.every((r: any) => r.reason_code === "HUMAN_REQUESTED" && r.risk_class === "LOW_RISK_WRITE" && r.actor_user_id === "uA" && r.brokerage_id === "bA") && m1.ok && rows.some((r: any) => r.provider_ref === m1.code.id) })())
    const r1 = db.tables.qr_codes.find((r: any) => m1.ok && r.id === m1.code.id) as any
    check("ROI PROVENANCE on the row: tenant + creator (users.id from the session) + agent + campaign + placement + print size + key + token scope", r1?.brokerage_id === "bA" && r1?.created_by_user_id === "uA" && r1?.agent_id === "agA" && r1?.marketing_campaign_id === "cA" && r1?.mint_context?.placement === "flyer" && r1?.mint_context?.print_size_in === 1.25 && r1?.mint_context?.idempotency_key === "req-0001-aaaa" && r1?.mint_context?.minted_via === "governed" && r1?.mint_context?.token_scope === "per_design")
    check("the code's own landing asks for consent, so its consent context says so (consented_form) — said only where known", r1?.mint_context?.consent_context === "consented_form")
    const before = db.tables.qr_codes.length
    const cross = await mintGovernedQr({ ...baseMint, idempotencyKey: "req-b-0001", label: "Borrowed", marketingCampaignId: "cA" }, B, deps(db))
    const crossListing = await mintGovernedQr({ ...baseMint, idempotencyKey: "req-b-0002", label: "Borrowed", listingId: "LA" }, B, deps(db))
    check("ADVERSE: tenant B cannot file a code under tenant A's campaign or listing — refused, nothing written, nothing ledgered", !cross.ok && cross.code === "not_permitted" && !crossListing.ok && db.tables.qr_codes.length === before && ledgerRows(db, "marketing.qr.mint").every((r: any) => r.brokerage_id !== "bB"))
    const notLead = await mintGovernedQr({ ...baseMint, idempotencyKey: "req-team-0001", label: "Team sign", teamId: "tA" }, A, deps(db))
    const lead = await mintGovernedQr({ ...baseMint, idempotencyKey: "req-team-0002", label: "Team sign", teamId: "tA", locationId: "oA" }, LEAD, deps(db))
    check("office/team under EXISTING permission: an agent outside team tA is refused; its lead (teams.team_lead_id) and the office's managing broker may file", !notLead.ok && notLead.code === "not_permitted" && lead.ok && (db.tables.qr_codes.find((r: any) => lead.ok && r.id === lead.code.id) as any)?.mint_context?.team_id === "tA")
    const bad = await Promise.all([
      mintGovernedQr({ ...baseMint, idempotencyKey: "x", label: "Short key" }, A, deps(db)),
      mintGovernedQr({ ...baseMint, idempotencyKey: "req-bad-0001", label: "listing:LA" }, A, deps(db)),
      mintGovernedQr({ ...baseMint, idempotencyKey: "req-bad-0002", label: "Tiny", printSizeIn: 0.5 }, A, deps(db)),
      mintGovernedQr({ ...baseMint, idempotencyKey: "req-bad-0003", label: "Past", expiresAt: "2020-01-01T00:00:00Z" }, A, deps(db)),
      mintGovernedQr({ ...baseMint, idempotencyKey: "req-bad-0004", label: "No URL", destinationType: "video_avatar_tour" }, A, deps(db)),
      mintGovernedQr({ ...baseMint, idempotencyKey: "req-bad-0005", label: "Bad place", placement: "billboard" }, A, deps(db)),
    ])
    check("the instruction's own rules refuse: a missing key, a reserved `<kind>:` label, a print size under 0.8 in, a past end date, an external type with no URL, a placement outside the live vocabulary", bad.every((r) => !r.ok && r.code === "invalid"))
    const unsafe = await mintGovernedQr({ ...baseMint, idempotencyKey: "req-unsafe-01", label: "Bad link", destinationType: "other", targetUrl: "javascript:alert(1)" }, A, deps(db))
    check("ADVERSE: an unsafe destination is refused at MINT — no row, no executed ledger row, the tenant told what to do", !unsafe.ok && unsafe.code === "unsafe_destination" && /https:\/\//.test(unsafe.message) && !db.tables.qr_codes.some((r: any) => r.label === "Bad link"))
    check("every refusal is a tenant-facing sentence (no SQL, no stack, no provider string)", [cross, notLead, unsafe, ...bad].every((r) => !r.ok && r.message.length > 20 && !/(PGRST|23505|42703|supabase|postgres|stack|undefined|null)/i.test(r.message)))
    const pre = registryDb({ missingColumns: { qr_codes: ["created_by_user_id", "mint_context", "destination_history"] } })
    const gov = await mintGovernedQr({ ...baseMint, idempotencyKey: "req-pre-0001", label: "Before m945" }, A, deps(pre))
    const auto = await mintTrackedQr({ brokerageId: "bA", label: "listing:LA", purpose: "listing", origin: ORIGIN }, pre as never)
    check("BEFORE m945 is applied: a GOVERNED mint refuses (its provenance is the point) and writes nothing; an AUTOMATIC mint degrades once and still mints its code", !gov.ok && gov.code === "refused" && !!auto && pre.tables.qr_codes.length === 1 && (pre.tables.qr_codes[0] as any).mint_context === undefined)
    const dup = m1.ok ? await duplicateQrDesign({ sourceQrCodeId: m1.code.id, idempotencyKey: "dup-0001-aaaa" }, A, deps(db)) : null
    const dupRow = dup?.ok ? db.tables.qr_codes.find((r: any) => r.id === dup.code.id) as any : null
    check("DUPLICATE mints a NEW unique token for the same design (destination, campaign, placement kept; duplicated_from names the source)", !!dup?.ok && m1.ok && dup.code.slug !== m1.code.slug && dupRow?.mint_context?.duplicated_from === m1.code.id && dupRow?.marketing_campaign_id === "cA" && dupRow?.mint_context?.placement === "flyer")
    const dupB = m1.ok ? await duplicateQrDesign({ sourceQrCodeId: m1.code.id, idempotencyKey: "dup-b-00001" }, B, deps(db)) : null
    check("ADVERSE: tenant B cannot duplicate tenant A's code (reads as not in your account)", !!dupB && !dupB.ok && dupB.code === "not_found")
  }

  console.log("\n[9 · DESTINATION SAFETY — https, verified tenant hosts + the allow-list, no loop, no personal data]")
  {
    const v = (url: string, ownSlug?: string) => validateQrDestination({ url, appOrigins: [ORIGIN], tenantHosts: ["homes.alder.example", "alderrealty.example"], ownSlug })
    const ok: Array<[string, string]> = [
      [`${ORIGIN}/listings/LA`, "in_app"], ["/open-house/E1/signin", "in_app"], ["/home-value/jane-doe", "in_app"],
      ["https://homes.alder.example/featured", "tenant_site"], ["https://www.alderrealty.example/team", "tenant_site"],
      ["https://www.youtube.com/watch?v=abc123", "allowed_external"], ["https://calendly.com/jane/30min", "allowed_external"],
      // NEGATIVE CONTROL for the phone rule: a long listing number is not a phone number (a bare 10-digit value is
      // treated as one — a published blind spot, privacy-first).
      ["https://homes.alder.example/?mls=24681357", "tenant_site"],
      ["/qr/own-token", "in_app"],
    ]
    for (const [url, kind] of ok) { const r = v(url, "own-token"); check(`accepted: ${url} → ${kind}`, r.ok && r.kind === kind) }
    const refused: Array<[string, string]> = [
      ["javascript:alert(1)", "unsafe_scheme"], ["data:text/html,<b>x</b>", "unsafe_scheme"], ["mailto:a@b.co", "unsafe_scheme"],
      ["http://homes.alder.example/x", "not_https"], ["//evil.example/x", "unsafe_scheme"], ["https://user:pw@homes.alder.example/", "credentials_in_url"],
      ["https://192.168.1.20/admin", "ip_or_local_host"], ["https://localhost/x", "ip_or_local_host"],
      ["/api/qr/scan?slug=abc", "redirect_loop"], ["/qr/someone-elses-code", "redirect_loop"], ["https://homes.alder.example/api/qr/scan?slug=x", "redirect_loop"],
      ["/dashboard/leads", "not_public_page"], ["/listings/../dashboard", "not_public_page"],
      ["/listings/LA?email=jane@doe.com", "personal_data_in_url"], ["https://homes.alder.example/x?contact_id=" + CONTACT_UUID, "personal_data_in_url"],
      ["https://homes.alder.example/x?ref=555-201-4433", "personal_data_in_url"], ["/forms/x?token=abc", "personal_data_in_url"],
      ["https://evil.example/phish", "host_not_allowed"], ["https://notyoutube.com/watch", "host_not_allowed"], ["https://youtube.com.evil.example/x", "host_not_allowed"],
      ["https://pending.alder.example/x", "host_not_allowed"], ["", "empty"], [`https://homes.alder.example/${"a".repeat(2100)}`, "too_long"],
    ]
    for (const [url, code] of refused) { const r = v(url); check(`refused: ${url.slice(0, 70) || "(empty)"} → ${code}`, !r.ok && r.code === code, r.ok ? `accepted as ${r.kind}` : r.code) }
    check("CONTROL: the host rule is a dot-boundary suffix — youtube.com matches www.youtube.com and NOT notyoutube.com (both proved above)", v("https://m.youtube.com/x").ok && !v("https://xyoutube.com/x").ok)
    check("a pending (unverified) custom domain is not a tenant host — only ACTIVE verified domains are read (loadQrTenantHosts on the in-memory client)", await (async () => { const db = registryDb(); const r = await mintGovernedQr({ ...baseMint, idempotencyKey: "req-pend-0001", label: "Pending", destinationType: "other", targetUrl: "https://pending.alder.example/x" }, A, deps(db)); const r2 = await mintGovernedQr({ ...baseMint, idempotencyKey: "req-act-00001", label: "Active", destinationType: "other", targetUrl: "https://homes.alder.example/x" }, A, deps(db)); return !r.ok && r.ok === false && r2.ok })())
  }

  console.log("\n[10 · DESTINATION EDIT — versions kept, old printed codes keep resolving, tenant isolation]")
  {
    const db = registryDb()
    const m = await mintGovernedQr({ ...baseMint, idempotencyKey: "req-edit-0001", label: "Listing sign", destinationType: "listing_detail", targetUrl: `${ORIGIN}/listings/LA` }, A, deps(db))
    if (!m.ok) { check("mint for the edit section", false, m.message); return }
    const e1 = await editQrDestination({ qrCodeId: m.code.id, targetUrl: "/open-house/E1/signin", destinationType: "book_meeting", reason: "Open house this weekend" }, A, deps(db))
    const row = () => db.tables.qr_codes.find((r: any) => r.id === m.code.id) as any
    check("an edit appends a version: v1 (the minted destination, unchanged) + v2 (the new one, with who and why)", e1.ok && !e1.unchanged && e1.history.length === 2 && e1.history[0].target_url === `${ORIGIN}/listings/LA` && e1.history[0].kind === "minted" && e1.history[1].version === 2 && e1.history[1].target_url === "/open-house/E1/signin" && e1.history[1].changed_by_user_id === "uA" && e1.history[1].reason === "Open house this weekend")
    const printed = resolveQrScanDestination({ slug: m.code.slug, targetUrl: row().target_url, appOrigins: [ORIGIN] })
    check("the OLD PRINTED token resolves to the NEW destination after the allowed edit (same slug, next scan)", row().slug === m.code.slug && printed.kind === "in_app" && printed.path === `/open-house/E1/signin?qr=${m.code.slug}`)
    const e2 = await editQrDestination({ qrCodeId: m.code.id, targetUrl: "https://homes.alder.example/featured" }, A, deps(db))
    check("history is APPEND-ONLY: a second edit keeps v1 and v2 byte-for-byte and adds v3", e2.ok && e2.history.length === 3 && e1.ok && JSON.stringify(e2.history.slice(0, 2)) === JSON.stringify(e1.history) && e2.history[2].version === 3)
    check("every applied edit is ledgered (marketing.qr.destination_edit, from → to, version)", ledgerRows(db, "marketing.qr.destination_edit").length === 2 && ledgerRows(db, "marketing.qr.destination_edit").every((r: any) => r.subject_id === m.code.id && r.detail?.from && r.detail?.to && r.idempotency_key === `qr_dest:${m.code.id}:v${r.detail.version}`))
    const snapshot = JSON.stringify(row())
    const hijack = await editQrDestination({ qrCodeId: m.code.id, targetUrl: "https://homes.alder.example/x" }, B, deps(db))
    check("ADVERSE: tenant B cannot alter tenant A's code — answered 'not in your account' (same as missing), the row byte-identical", !hijack.ok && hijack.code === "not_found" && JSON.stringify(row()) === snapshot)
    const unsafe = await editQrDestination({ qrCodeId: m.code.id, targetUrl: "http://homes.alder.example/x" }, A, deps(db))
    check("ADVERSE: an unsafe edit is refused and changes nothing", !unsafe.ok && unsafe.code === "unsafe_destination" && JSON.stringify(row()) === snapshot)
    const same = await editQrDestination({ qrCodeId: m.code.id, targetUrl: "https://homes.alder.example/featured" }, A, deps(db))
    check("re-saving the same destination is a no-op (unchanged, no new version, no ledger row)", same.ok && same.unchanged && row().destination_history.length === 3 && ledgerRows(db, "marketing.qr.destination_edit").length === 2)
    db.tables.qr_codes.push({ id: "legacy-1", brokerage_id: "bA", slug: "listing-la-l0ld", label: "listing:LA", target_url: `${ORIGIN}/listings/LA`, destination_type: "listing_detail", is_active: true, destination_history: [] })
    const legacy = await editQrDestination({ qrCodeId: "legacy-1", targetUrl: "/listings/LA" }, A, deps(db))
    check("a code minted BEFORE version history: its first edit records the old URL as legacy_initial, then the edit — nothing is lost", legacy.ok && legacy.history.length === 2 && legacy.history[0].kind === "legacy_initial" && legacy.history[0].target_url === `${ORIGIN}/listings/LA` && legacy.history[1].kind === "edited")
    check("appendQrDestinationVersion never rewrites an earlier entry (pure, positive control on a mutated copy)", (() => { const h = appendQrDestinationVersion([{ version: 1, target_url: "/a", destination_type: null, kind: "minted", changed_at: "t0", changed_by_user_id: null, reason: null }], { target_url: "/a", destination_type: null }, { target_url: "/b", destination_type: null, changed_at: "t1", changed_by_user_id: "u", reason: null }); return h.length === 2 && h[0].target_url === "/a" && h[1].version === 2 && JSON.stringify(h[0]) !== JSON.stringify({ ...h[0], target_url: "/z" }) })())
    const pre = registryDb({ missingColumns: { qr_codes: ["destination_history", "retired_at", "retired_reason"] } })
    pre.tables.qr_codes.push({ id: "q-pre", brokerage_id: "bA", slug: "tok", target_url: "/listings/LA", is_active: true })
    const preEdit = await editQrDestination({ qrCodeId: "q-pre", targetUrl: "/home-value" }, A, deps(pre))
    check("BEFORE m945: a destination edit REFUSES (history could not be kept) and says so — never an unversioned change", !preEdit.ok && preEdit.code === "unavailable" && (pre.tables.qr_codes[0] as any).target_url === "/listings/LA")
  }

  console.log("\n[11 · LIFECYCLE — pause · resume · retire · turn off; terminal; helpful pages, never a raw 500]")
  {
    const db = registryDb()
    const m = await mintGovernedQr({ ...baseMint, idempotencyKey: "req-life-0001", label: "Postcard run" }, A, deps(db))
    if (!m.ok) { check("mint for the lifecycle section", false, m.message); return }
    const id = m.code.id
    const row = () => db.tables.qr_codes.find((r: any) => r.id === id) as any
    const p = await changeQrLifecycle({ qrCodeId: id, action: "pause" }, A, deps(db))
    const s1 = qrLifecycleState(row())
    const r = await changeQrLifecycle({ qrCodeId: id, action: "resume" }, A, deps(db))
    check("pause → paused (routing stops), resume → active", p.ok && p.state === "paused" && s1 === "paused" && r.ok && r.state === "active" && qrLifecycleState(row()) === "active")
    const crossLife = await changeQrLifecycle({ qrCodeId: id, action: "pause" }, B, deps(db))
    check("ADVERSE: tenant B cannot pause tenant A's code", !crossLife.ok && crossLife.code === "not_found" && qrLifecycleState(row()) === "active")
    const noReason = await changeQrLifecycle({ qrCodeId: id, action: "revoke_unsafe" }, A, deps(db))
    check("turning a code off as UNSAFE requires a reason (it goes on the record)", !noReason.ok && noReason.code === "invalid")
    const ret = await changeQrLifecycle({ qrCodeId: id, action: "retire" }, A, deps(db))
    const resumeAfter = await changeQrLifecycle({ qrCodeId: id, action: "resume" }, A, deps(db))
    const editAfter = await editQrDestination({ qrCodeId: id, targetUrl: "/home-value" }, A, deps(db))
    check("retire is TERMINAL: it never resumes and its destination never changes (duplicate to print a new code)", ret.ok && ret.state === "retired" && !resumeAfter.ok && resumeAfter.code === "terminal" && !editAfter.ok && editAfter.code === "terminal" && row().is_active === false && !!row().retired_at)
    check("a retired code's ROW IS KEPT — proof of a mailed campaign is never deleted (no delete was issued)", db.tables.qr_codes.some((x: any) => x.id === id) && !db.writes.some((w) => w.table === "qr_codes" && w.op === "delete"))
    const m2 = await mintGovernedQr({ ...baseMint, idempotencyKey: "req-life-0002", label: "Unsafe page" }, A, deps(db))
    const rev = m2.ok ? await changeQrLifecycle({ qrCodeId: m2.code.id, action: "revoke_unsafe", reason: "the landing host was taken over" }, A, deps(db)) : null
    check("turn off (unsafe) → revoked; the reason is on the ledger row", !!rev?.ok && rev.state === "revoked" && ledgerRows(db, "marketing.qr.lifecycle").some((x: any) => x.detail?.action === "revoke_unsafe" && x.detail?.reason === "the landing host was taken over"))
    check("qrLifecycleState: terminal beats paused beats expired; an active code past its end date is expired", qrLifecycleState({ is_active: false, retired_at: "t", retired_reason: "revoked_unsafe" }) === "revoked" && qrLifecycleState({ is_active: false, expires_at: "2020-01-01T00:00:00Z" }) === "paused" && qrLifecycleState({ is_active: true, expires_at: "2020-01-01T00:00:00Z" }) === "expired" && qrLifecycleState({ is_active: true }) === "active")
    const states = ["paused", "expired", "retired", "revoked", "missing", "error"] as const
    check("every unavailable state has a tenant-facing notice (what happened · nothing saved · ONE action) with no technical string", states.every((s) => { const n = qrUnavailableNotice(s); return n.heading.length > 5 && /Nothing about you was saved/.test(n.detail) && n.action.split(/[.!?]\s/).length === 1 && !/(500|error code|stack|supabase|postgres|PGRST|brokerage pays|provider)/i.test(`${n.heading} ${n.detail} ${n.action}`) }))
    const scan = stripped("app/api/qr/scan/route.ts")
    const RAW_FAILURE_RE = /NextResponse\.json\(\s*\{\s*error|redirect\(new URL\('\/'/
    check("the scan door answers every non-routing case with the helpful page — no raw JSON 500, no silent bounce to /", !RAW_FAILURE_RE.test(scan) && /catch \(err\) \{[\s\S]{0,300}refusalPage\(503, qrUnavailableNotice\('error'\)\)/.test(scan) && /refusalPage\(404, qrUnavailableNotice\('missing'\)\)/.test(scan) && /refusalPage\(UNAVAILABLE_STATUS\[state\], qrUnavailableNotice\(state\)\)/.test(scan))
    check("CONTROL: the finder catches the old raw 500 and the old bounce", RAW_FAILURE_RE.test(stripComments("return NextResponse.json({ error: 'Internal error' }, { status: 500 })")) && RAW_FAILURE_RE.test(stripComments("return NextResponse.redirect(new URL('/', req.url))")))
    const landing = stripped("app/qr/[slug]/page.tsx")
    check("the landing page (the other door) gives the same notices — a missing code is a helpful page, never notFound()", !/notFound\(/.test(landing) && /qrUnavailableNotice\('missing'\)/.test(landing) && /qrLifecycleState\(/.test(landing))
    check("the capture door refuses paused / expired / retired / revoked codes with the same words", /qrLifecycleState\(qr\)/.test(stripped("app/api/qr/submit/route.ts")) && /qrUnavailableNotice\(state\)/.test(stripped("app/api/qr/submit/route.ts")))
  }

  console.log("\n[12 · TRACKING — permitted context only; raw scans ≠ visits ≠ unique visitors ≠ consented submissions]")
  {
    const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    const bots = ["facebookexternalhit/1.1", "Slackbot-LinkExpanding 1.0", "curl/8.4.0", "Mozilla/5.0 (compatible; Googlebot/2.1)", "WhatsApp/2.23", "python-requests/2.31", ""]
    check("bots and link previewers (facebookexternalhit, Slackbot, curl, Googlebot, WhatsApp, python-requests, an empty browser) are classified bot", bots.every((ua) => classifyQrScan({ userAgent: ua }) === "bot"))
    const now = Date.parse("2026-11-11T15:00:00Z")
    check("the same visitor within 30 min is a REPEAT; after the window a new visit; a phone with no prior scan a visit", classifyQrScan({ userAgent: IPHONE, lastSameVisitorScanAt: new Date(now - 5 * 60_000).toISOString(), nowMs: now }) === "repeat" && classifyQrScan({ userAgent: IPHONE, lastSameVisitorScanAt: new Date(now - QR_REPEAT_WINDOW_MS - 1).toISOString(), nowMs: now }) === "human_likely" && classifyQrScan({ userAgent: IPHONE, nowMs: now }) === "human_likely")
    const k = (ip: string, code = "q1", t = now, ua = IPHONE) => qrScanEvidence({ qrCodeId: code, ip, userAgent: ua, referrer: "https://l.facebook.com/l.php?u=x&h=secret", nowMs: t }).visitorKey
    check("the visitor key: same phone + same /24 + same day + same code → same key; another code, another day or another network → another key", k("203.0.113.7") === k("203.0.113.99") && k("203.0.113.7") !== k("203.0.113.7", "q2") && k("203.0.113.7") !== k("203.0.113.7", "q1", now + 86_400_000) && k("203.0.113.7") !== k("198.51.100.7"))
    const ev = qrScanEvidence({ qrCodeId: "q1", ip: "203.0.113.7", userAgent: IPHONE, referrer: "https://l.facebook.com/l.php?u=x&h=secret", nowMs: now })
    check("PERMITTED CONTEXT: the key is a 32-hex hash (no IP inside), the device is coarse (mobile), the referrer is its HOST only", /^[0-9a-f]{32}$/.test(ev.visitorKey) && !ev.visitorKey.includes("203") && ev.deviceClass === "mobile" && ev.referrerHost === "l.facebook.com" && coarseNetworkPrefix("203.0.113.7") === "203.0.113" && coarseNetworkPrefix("2001:db8:abcd:12::1") === "2001:db8:abcd")
    check("coarse device classes: iPhone → mobile, iPad → tablet, a Windows desktop → desktop, nothing → unknown", qrDeviceClass(IPHONE) === "mobile" && qrDeviceClass("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)") === "tablet" && qrDeviceClass("Mozilla/5.0 (Windows NT 10.0; Win64; x64)") === "desktop" && qrDeviceClass(null) === "unknown")
    const s = summarizeQrScans([
      { traffic_class: "human_likely", visitor_key: "k1" }, { traffic_class: "repeat", visitor_key: "k1" }, { traffic_class: "bot", visitor_key: "kb" },
      { traffic_class: "human_likely", visitor_key: "k2", contact_id: "c1" }, { traffic_class: null, visitor_key: null },
    ])
    check("the four counts stay apart: raw 5 · visits 2 · unique visitor-days 2 (bots excluded) · consented submissions 1 · 1 unclassified older row", s.rawScans === 5 && s.humanLikelyVisits === 2 && s.botScans === 1 && s.repeatScans === 1 && s.uniqueVisitorDays === 2 && s.consentedSubmissions === 1 && s.unclassified === 1)
    check("unique visitors are NOT claimed where unmeasured (no key on any row → null, shown as 'not measured')", summarizeQrScans([{ traffic_class: null }, { traffic_class: null }]).uniqueVisitorDays === null)
    const db = registryDb()
    db.tables.qr_scan_events.push({ qr_code_id: "q1", visitor_key: ev.visitorKey, scanned_at: new Date(now - 60_000).toISOString() })
    check("classifyScanForCode reads the repeat window on the in-memory client (same key, 1 min ago → repeat)", (await classifyScanForCode(db, { qrCodeId: "q1", visitorKey: ev.visitorKey, userAgent: IPHONE, nowMs: now })) === "repeat")
    const pre = registryDb({ missingColumns: { qr_scan_events: ["visitor_key"] } })
    check("before m946 the window read is refused and the class falls back to the browser test alone (never a guess at a repeat)", (await classifyScanForCode(pre, { qrCodeId: "q1", visitorKey: ev.visitorKey, userAgent: IPHONE, nowMs: now })) === "human_likely")
    const scan = stripped("app/api/qr/scan/route.ts")
    const insertWindow = scan.slice(scan.indexOf("const baseScan"), scan.indexOf("const baseScan") + 600)
    check("the scan door writes no raw IP and no browser string — only the referring host, the coarse device, the traffic class and the key", insertWindow.length > 0 && !/ip_address:|user_agent:/.test(insertWindow) && /visitor_key: evidence\.visitorKey/.test(insertWindow) && /device_class: evidence\.deviceClass/.test(insertWindow) && /referrer: evidence\.referrerHost/.test(insertWindow))
    check("CONTROL: the finder sees a raw-IP write", /ip_address:|user_agent:/.test("{ qr_code_id: qr.id, ip_address: ip, user_agent: userAgent }"))
    const CONTACT_WRITE_RE = /from\(['"](contacts|leads)['"]\)[\s\S]{0,120}\.(insert|upsert)\(|captureContact\(|captureConsentedContact\(/
    check("A SCAN CREATES NO CONTACT: the scan door never writes contacts / leads and never calls the capture path", !CONTACT_WRITE_RE.test(scan))
    check("CONTROL: the finder sees a contact write and a capture call", CONTACT_WRITE_RE.test("svc.from('contacts').insert({})") && CONTACT_WRITE_RE.test("await captureContact({ brokerageId })"))
    check("a bot never becomes a mail response or a lead's timeline entry; tracking OFF writes no per-scan row", /qr\.purpose === 'campaign' && trackScan && trafficClass !== 'bot'/.test(scan) && /if \(trackScan\) \{[\s\S]{0,500}from\('qr_scan_events'\)\.insert\(/.test(scan))
    const submit = stripped("app/api/qr/submit/route.ts")
    const OWN_SCAN_RE = /from\('qr_scan_events'\)[\s\S]{0,120}\.eq\('qr_code_id', qr\.id\)[\s\S]{0,80}\.eq\('visitor_key', submitEvidence\.visitorKey\)[\s\S]{0,120}\.gte\('scanned_at'/
    check("a consented submission may claim ONLY its own scan (same visitor key, inside the window) — never 'the most recent unlinked scan' of a shared code", OWN_SCAN_RE.test(submit) && /captureConsentedContact\(/.test(submit))
    check("CONTROL: the old stranger-linking query does not satisfy the rule", !OWN_SCAN_RE.test(stripComments(".from('qr_scan_events').select('id').eq('qr_code_id', qr.id).is('contact_id', null).order('scanned_at', { ascending: false })")))
    const act = registryDb()
    const mm = await mintGovernedQr({ ...baseMint, idempotencyKey: "req-act-0001", label: "Activity" }, A, deps(act))
    if (mm.ok) act.tables.qr_scan_events.push({ qr_code_id: mm.code.id, brokerage_id: "bA", traffic_class: "human_likely", visitor_key: "VISITOR-KEY-SENTINEL", contact_id: "CONTACT-ID-SENTINEL", referrer: "https://l.instagram.com/x?u=y", scanned_at: "2026-11-11T10:00:00Z" }, { qr_code_id: mm.code.id, brokerage_id: "bA", traffic_class: "bot", visitor_key: "BOT-KEY-SENTINEL", scanned_at: "2026-11-11T10:01:00Z" })
    const activity = mm.ok ? await loadQrActivity(mm.code.id, A, deps(act)) : null
    const leaked = activity?.ok ? JSON.stringify(activity.activity) : ""
    check("the board's activity: summary + recent scans + history, and NO visitor key or contact id leaves the server (referrer as host only)", !!activity?.ok && activity.activity.summary.rawScans === 2 && activity.activity.summary.consentedSubmissions === 1 && !/SENTINEL/.test(leaked) && activity.activity.recent.some((x) => x.referrerHost === "l.instagram.com" && x.linkedToContact))
    const crossAct = mm.ok ? await loadQrActivity(mm.code.id, B, deps(act)) : null
    check("ADVERSE: tenant B cannot read tenant A's scan history", !!crossAct && !crossAct.ok && crossAct.code === "not_found")
  }

  console.log("\n[13 · MIGRATIONS m945 / m946 — stamps, the columns the code writes, CHECK = the one code constant]")
  {
    const STAMP = "-- WRITTEN, NOT APPLIED (wave 152, lane 152C) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL"
    const m945 = src("supabase/migrations/m945-qr-codes-creator-provenance-destination-history-and-retirement.sql")
    const m946 = src("supabase/migrations/m946-qr-scan-events-coarse-visitor-device-and-traffic-class.sql")
    const sqlCode = (s: string) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")
    const stamped = (s: string) => s.split("\n")[0] === STAMP || /^-- ── APPLIED LIVE \d{4}-\d{2}-\d{2} via Supabase MCP \(project [a-z]+\) — wave 152, lane 152C ──$/.test(s.split("\n")[0])
    check("line 1 of each is the lane stamp OR the integrator's APPLIED LIVE stamp (no migration number on it; the rule, never the pre-apply waypoint)", stamped(m945) && stamped(m946))
    check("POSITIVE CONTROL: a line 1 that is neither stamp is refused", !stamped("-- m945 — applied, trust me\n") && !stamped("\n"))
    check("m945 adds every qr_codes column the code writes (created_by_user_id → users, mint_context, destination_history, retired_at, retired_reason)", ["created_by_user_id  uuid REFERENCES public.users(id)", "mint_context", "destination_history", "retired_at", "retired_reason"].every((c) => sqlCode(m945).includes(c)))
    check("m946 adds every qr_scan_events column the scan door writes (visitor_key, traffic_class, device_class)", ["visitor_key", "traffic_class", "device_class"].every((c) => sqlCode(m946).includes(`ADD COLUMN IF NOT EXISTS ${c}`)))
    const inList = (sql: string, col: string) => { const m = new RegExp(`${col} IN \\(([^)]*)\\)`).exec(sqlCode(sql)); return m ? m[1].split(",").map((x) => x.trim().replace(/'/g, "")).sort().join() : "" }
    check("each new CHECK equals its ONE code constant (retired_reason = QR_RETIRED_REASONS, traffic_class = QR_TRAFFIC_CLASSES, device_class = QR_DEVICE_CLASSES)", inList(m945, "retired_reason") === [...QR_RETIRED_REASONS].sort().join() && inList(m946, "traffic_class") === [...QR_TRAFFIC_CLASSES].sort().join() && inList(m946, "device_class") === [...QR_DEVICE_CLASSES].sort().join())
    check("m945's trigger holds the rules the code relies on: retirement terminal, history append-only, a target change carries a version", /CREATE OR REPLACE TRIGGER qr_codes_guard_history_and_retirement/.test(m945) && /a retired code stays retired/.test(m945) && /destination history is append-only/.test(m945) && /must append a version/.test(m945))
    check("no owner SQL in either file (no DROP COLUMN / DROP INDEX / storage.objects) and each names its ROLLBACK", ![m945, m946].some((s) => /DROP COLUMN|DROP INDEX|storage\.objects/i.test(sqlCode(s))) && /-- ROLLBACK:/.test(m945) && /-- ROLLBACK:/.test(m946))
    check("the placement vocabulary a code names is the LIVE marketing_asset_qr_links.placement_type CHECK (one vocabulary)", [...QR_PLACEMENT_TYPES].sort().join() === [...CHECK_VOCABULARIES.marketing_asset_qr_links.placement_type].sort().join())
    check("isAbsentColumnRefusal recognises PGRST204 / 42703 and not an ordinary refusal (the pre-apply degrade is keyed on it)", isAbsentColumnRefusal({ code: "PGRST204" }) && isAbsentColumnRefusal({ code: "42703" }) && !isAbsentColumnRefusal({ code: "23505", message: "duplicate key" }) && !isAbsentColumnRefusal(null))
  }

  console.log("\n[14 · WIRING — every QR write a person makes goes through a governed door]")
  {
    const admin = stripped("app/api/admin/qr-codes/route.ts")
    const mgmt = stripped("app/actions/qr-management.ts")
    const board = stripped("app/dashboard/agent/qr-codes/QRCodesClient.tsx")
    const gov = stripped("lib/marketing/qr-governance.ts")
    check("the board's create (POST) is the governed mint, tenant from the session; the edit (PATCH) is the versioned editor + the lifecycle door", /mintGovernedQr\(\{/.test(admin) && /brokerageId: ctx\.brokerageId/.test(admin) && /editQrDestination\(/.test(admin) && /changeQrLifecycle\(/.test(admin))
    const RAW_TARGET_WRITE_RE = /patch\.target_url\s*=|patch\.is_active\s*=|\.update\(\{\s*is_active/
    check("no raw target_url / is_active write is left in the board's doors (admin route + management actions)", !RAW_TARGET_WRITE_RE.test(admin) && !RAW_TARGET_WRITE_RE.test(mgmt))
    check("CONTROL: the finder sees the old raw writes", RAW_TARGET_WRITE_RE.test("patch.target_url = trimmed") && RAW_TARGET_WRITE_RE.test(".update({ is_active: input.isActive })"))
    check("the management actions gate FIRST (resolveWriteContext / resolveActingContext), then call the governed doors (pause/resume and retire share ONE gate)", /async function gatedLifecycle[\s\S]{0,300}resolveWriteContext\(\)[\s\S]{0,400}changeQrLifecycle\(/.test(mgmt) && /export async function setQrCodeActive[\s\S]{0,400}gatedLifecycle\(/.test(mgmt) && /export async function retireQrCode[\s\S]{0,400}gatedLifecycle\(/.test(mgmt) && /export async function duplicateQrCode[\s\S]{0,400}resolveWriteContext\(\)[\s\S]{0,400}duplicateQrDesign\(/.test(mgmt) && /export async function loadQrCodeActivity[\s\S]{0,300}resolveActingContext\(\)[\s\S]{0,300}loadQrActivity\(/.test(mgmt))
    check("the board: one idempotency key per create form, pause/resume/retire/turn off, duplicate, details (scan history), PNG + SVG download, copy the TRACKING link", /idempotencyKey: createKey\.current/.test(board) && /setQrCodeActive\(/.test(board) && /retireQrCode\(/.test(board) && /duplicateQrCode\(/.test(board) && /loadQrCodeActivity\(/.test(board) && /type: 'svg'/.test(board) && /navigator\.clipboard\.writeText\(getQRUrl\(slug\)\)/.test(board))
    check("every governed write is ledgered under a literal domain.entity.action name (mint · destination_edit · lifecycle)", ["marketing.qr.mint", "marketing.qr.destination_edit", "marketing.qr.lifecycle"].every((a) => new RegExp(`withActionLedger<\\w+>\\(\\s*\\{\\s*brokerageId: actor\\.brokerageId,\\s*action: "${a.replace(/\./g, "\\.")}"`).test(gov)))
    const outside = files.filter((f) => !["lib/marketing/qr-governance.ts", REGISTRY].includes(rel(f))).filter((f) => /from\(['"]qr_codes['"]\)[\s\S]{0,240}\.update\(\{[^}]*\b(target_url|retired_at|destination_history)\b/.test(blankStrings(stripped(f))))
    check("only the governed doors and the minter write target_url / retirement / history (no other live file)", outside.length === 0, outside.map(rel).join(", "))
  }
}

const files = ["lib", "app", "remotion"].flatMap((d) => walk(join(root, d))).filter((f) => !PROSE.has(rel(f)))

main().catch((e) => { console.error(e); process.exit(1) })
