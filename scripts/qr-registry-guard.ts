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
 * the home link exist; m664 is written (not applied) and names the same
 * prefix the code uses; registration in package.json + MAINTENANCE_DOMAINS.
 *
 * No network, no DB. Run: npx tsx --conditions=react-server scripts/qr-registry-guard.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments, blankStrings } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { mintTrackedQr, qrOwnerKind, PLATFORM_QR_LABEL_PREFIX, QR_PURPOSES } from "../lib/marketing/tracked-qr"
import { summarizeQrRegistry } from "../lib/marketing/qr-registry-board"
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
const EMIT_RE = /QRCode\.toDataURL\(|QRCode\.toCanvas\(|renderQrPng\(|qrserver\.com|create-qr-code/
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
    // FINDING, published (2026-09-24): ZERO producers exist — orchestrate-send / -bundle-send /
    // -preset-send all pass args.qrScanUrl through and every caller (agent-client-messages,
    // campaign-bundle-dispatch) omits it, so a PRINTED postcard carries no tracked QR even though
    // ai-direct-mail minted one for the campaign (direct_mail_campaigns.qr_code_id). Not an
    // unregistered QR (the registry is intact) — a registered QR that never reaches print. Open
    // item for the direct-mail lane; this check holds the rule for the day a producer appears.
    console.log(`    qrScanUrl producers (non-passthrough, non-null): ${producers.length} — ${producers.map((x) => rel(x.f)).join(", ") || "none (printed postcards carry no tracked QR today — open item)"}`)
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
    check("a platform mint the database REFUSES (live NOT NULL until m664) returns null — honest, never a row under some tenant", r === null && c.inserts.length === 1 && (c.inserts[0] as any).brokerage_id === null)
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

  console.log("\n[5 · migration m664 — written, not applied; consistent with the code]")
  const mig = "supabase/migrations/m664-qr-codes-platform-owner.sql"
  const migSrc = existsSync(join(root, mig)) ? src(mig) : ""
  check("m664 exists with the WRITTEN, NOT APPLIED header, relaxes qr_codes + qr_scan_events brokerage_id, and CHECKs the platform label prefix the code uses", /WRITTEN, NOT APPLIED/.test(migSrc) && /qr_codes ALTER COLUMN brokerage_id DROP NOT NULL/.test(migSrc) && /qr_scan_events ALTER COLUMN brokerage_id DROP NOT NULL/.test(migSrc) && migSrc.includes(`label LIKE '${PLATFORM_QR_LABEL_PREFIX}%'`))

  console.log("\n[6 · registration]")
  const pkg = JSON.parse(src("package.json"))
  check("package.json registers test:qr-registry and the guard chain runs it after test:scrapers (ordering)", typeof pkg.scripts["test:qr-registry"] === "string" && pkg.scripts.guard.indexOf("npm run test:scrapers") < pkg.scripts.guard.indexOf("npm run test:qr-registry"))
  const dom = (MAINTENANCE_DOMAINS as any).qr_registry
  check("MAINTENANCE_DOMAINS.qr_registry names a manager, this proof, and coOwners", !!dom && dom.proof === "test:qr-registry" && Array.isArray(dom.coOwners) && dom.coOwners.length >= 1)

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(` blind spots: the sweep recognises QR emission by the tokens QRCode.toDataURL/toCanvas, renderQrPng and third-party renderer URLs (a hand-rolled QR encoder would not be seen); "encodes a registered code" is proved by the /api/qr/scan?slug= literal, not by tracing the slug to a row; scripts/ are out of the denominator; the platform mint runs on a stub client — the live NOT NULL refusal is asserted by simulation until m664 is applied.`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ QR_REGISTRY_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
