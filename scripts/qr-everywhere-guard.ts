#!/usr/bin/env tsx
/**
 * scripts/qr-everywhere-guard.ts   (npm run test:qr-everywhere)   — WAVE 155, lane 155E. SIMULATED.
 *
 * Owner (verbatim, 2026-11-19): "qr code is missing from remotion, blogs, newsletter, etc." Ruling R5: ONE QR authority
 * (lib/marketing/tracked-qr.ts) everywhere it fits — real destination, real tracked scan, no second generator.
 *
 * What runs (no network, no database, no render farm — every seam is in-process and SIMULATED):
 *   · the REAL minter (mintTrackedQr / mintVideoQr / resolveArtifactQrSlot) on the in-memory client;
 *   · the REAL governance doors (editQrDestination / changeQrLifecycle) with the in-memory action ledger;
 *   · the REAL scan handler (GET of app/api/qr/scan/route.ts) through node:module registerHooks seams — the service
 *     client resolves to the in-memory client and lib/kernel/emit to a recorder (the pattern of
 *     scripts/marketing-qr-simulator.ts);
 *   · the REAL Remotion components (QrOutroBadge, EndCard, ListingFlyer, ProductPromoReel) rendered to an element tree
 *     with a stub `remotion` runtime (frame / video config from this proof; <Sequence> renders its children so the end
 *     card is visible) — the drawn <img> is compared BYTE-FOR-BYTE with renderQrPng(scanUrl): the encoder is
 *     deterministic, so equality proves the end card encodes the tracked scan URL (and inequality with the raw
 *     destination's PNG proves it does not encode that);
 *   · the REAL newsletter assembler and the REAL letter renderer (its seams, as scripts/direct-mail-rendering-guard.ts);
 *   · a census on STRIPPED source (scripts/strip-comments.ts) with positive controls.
 *
 * RED AT 9d9626b9 (each item below fails there): resolveArtifactQrSlot / qrModuleCount / blogPrintQrArgs /
 * mint/openQrPersonalGrant / qrPlacementFit / QR_ARTIFACT_SLOTS do not exist (the import fails — every section is red);
 * mintVideoQr wrote a users.id into qr_codes.agent_id (the FK check in §3 is red); "/blog/" was not a public scan
 * destination (§6 red: the scan landed on /qr/<slug>); a refused scan wrote no event (§8 red); a paused slot code was
 * bypassed by a fresh mint (§7 red: mintTrackedQr's reuse filters is_active); ProductPromoReel had no QR prop (§4 red);
 * the newsletter had no slot (§5 red); a scan could never name a person except through a 1:1 mail campaign (§9 red).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const rel = (p: string) => p.replace(root + "/", "")
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(root, p), "utf8")
const stripped = (p: string) => stripComments(src(p))
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p)
  }
  return out
}

// ─── SEAMS (registered before any product import) ────────────────────────────
const ORIGIN = "https://app.example.test"
process.env.NEXT_PUBLIC_APP_URL = ORIGIN
// A throwaway proof key for the sealer (lib/security/secret-crypto.ts) — generated here, never printed, never real.
process.env.SECRETS_ENCRYPTION_KEY = (await import("node:crypto")).randomBytes(32).toString("hex")
type Seam = { client: () => unknown; emit: (e: { event: string; contactId?: string; metadata?: Record<string, unknown> }) => Promise<unknown>; frame: number; config: { width: number; height: number; fps: number; durationInFrames: number } }
const seam: Seam = { client: () => { throw new Error("no client seeded") }, emit: async () => ({ inserted: false, lifecycleEventId: null, fanOutOk: true, error: null }), frame: 90, config: { width: 1080, height: 1920, fps: 30, durationInFrames: 900 } }
const g = globalThis as Record<string, unknown>
g.__qrEverywhereSeam = seam
g.__qrEverywhereReact = (await import("react")).default
const REMOTION_STUB = `
const R = () => globalThis.__qrEverywhereReact
const S = () => globalThis.__qrEverywhereSeam
export const useCurrentFrame = () => S().frame
export const useVideoConfig = () => S().config
export const interpolate = (x, inp, out, o) => { const [a, b] = inp; const [c, d] = out; let t = (x - a) / ((b - a) || 1); if (!o || o.extrapolateLeft === "clamp") t = Math.max(t, 0); if (!o || o.extrapolateRight === "clamp") t = Math.min(t, 1); return c + (d - c) * t }
export const spring = () => 1
export const Easing = { bezier: () => (x) => x, inOut: (f) => f, in: (f) => f, out: (f) => f, ease: (x) => x, cubic: (x) => x, quad: (x) => x, linear: (x) => x }
export const delayRender = () => 0
export const continueRender = () => {}
export const cancelRender = (e) => { throw e }
export const staticFile = (s) => s
export const AbsoluteFill = (p) => R().createElement("div", { "data-absolute-fill": "1", style: p.style }, p.children)
export const Img = (p) => R().createElement("img", { src: p.src, style: p.style, alt: p.alt })
export const Sequence = (p) => R().createElement("section", { "data-from": p.from }, p.children)
`
const STUB: Record<string, string> = {
  "server-only": "export {}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__qrEverywhereSeam.client()",
  "@/lib/kernel/emit": "export const emitKernelEvent = (e) => globalThis.__qrEverywhereSeam.emit(e)",
}
registerHooks({
  resolve(spec: string, ctx: { parentURL?: string }, next: (s: string, c: unknown) => unknown) {
    if (STUB[spec] !== undefined) return { url: `data:text/javascript,${encodeURIComponent(STUB[spec])}`, shortCircuit: true }
    // `remotion` is stubbed for FIRST-PARTY importers only — node_modules packages keep the real runtime.
    if (spec === "remotion" && ctx.parentURL && !ctx.parentURL.includes("/node_modules/")) return { url: `data:text/javascript,${encodeURIComponent(REMOTION_STUB)}`, shortCircuit: true }
    return next(spec, ctx)
  },
} as never)

const { memSupabase } = await import("./in-memory-supabase")
const tracked = await import("../lib/marketing/tracked-qr")
const contract = await import("../lib/marketing/qr-contract")
const gov = await import("../lib/marketing/qr-governance")
const { mintVideoQr } = await import("../lib/video/video-qr")
const { encryptSecret, decryptSecret, isEncrypted } = await import("../lib/security/secret-crypto")
const sealer = { seal: encryptSecret as (s: string) => string, open: decryptSecret, isSealed: isEncrypted }
const { renderQrPng, resolveArtifactQrSlot, qrModuleCount, blogPrintQrArgs } = tracked
const { qrPlacementFit, QR_ARTIFACT_SLOTS, QR_PLACEMENT_MINIMUMS, QR_IN_APP_PUBLIC_PREFIXES } = contract
type Mem = ReturnType<typeof memSupabase>

function seedDb(): Mem {
  return memSupabase({
    brokerages: [{ id: "bA", website: null }, { id: "bB", website: null }],
    users: [{ id: "uA", brokerage_id: "bA", first_name: "Ann" }, { id: "uA2", brokerage_id: "bA", first_name: "Ari" }, { id: "uB", brokerage_id: "bB" }],
    agents: [{ id: "agA", user_id: "uA", brokerage_id: "bA", team_id: null, location_id: null }, { id: "agA2", user_id: "uA2", brokerage_id: "bA", team_id: null, location_id: null }, { id: "agB", user_id: "uB", brokerage_id: "bB" }],
    teams: [], locations: [], marketing_campaigns: [{ id: "cA", brokerage_id: "bA" }], listings: [{ id: "LA", brokerage_id: "bA" }],
    tenant_custom_domains: [], brokerage_brand_settings: [],
    contacts: [{ id: "ctA", brokerage_id: "bA" }, { id: "ctB", brokerage_id: "bB" }], leads: [],
    qr_codes: [], qr_scan_events: [], agent_action_ledger: [], lifecycle_events: [], marketing_asset_qr_links: [],
    direct_mail_campaigns: [], direct_mail_responses: [], mail_response_tracking: [],
  }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]], qr_codes: [["slug"]] } })
}
const A = { brokerageId: "bA", userId: "uA", agentId: "agA", userType: "agent" }
const deps = (db: Mem) => ({ client: db as never, ledgerClient: db as never, origin: ORIGIN, appOrigins: [ORIGIN] })

async function renderTree(el: unknown): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server")
  return renderToStaticMarkup(el as never)
}
const imgSrcs = (html: string) => [...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"))

async function main() {
  // ── 1 · census on STRIPPED source ──────────────────────────────────────────
  console.log("\n[1 · census — one QR authority; every emission encodes the tracked scan URL (stripped source, positive controls)]")
  const files = ["lib", "app", "remotion"].flatMap((d) => walk(join(root, d))).map(rel).filter((f) => f !== "lib/kernel/manager-registry.ts")
  const EMIT_CALL_RE = /(QRCode\.(toDataURL|toCanvas|toString|toBuffer|toFile)|renderQrPng)\(/g
  const TRACKED_ARG_RE = /\/api\/qr\/scan\?slug=|[sS]canUrl\b|getQRUrl\(|qrScanUrl\(/
  const THIRD_PARTY_IMPORT_RE = /from\s+["'](qrcode\.react|react-qr-code|qr-code-styling|qrcode-generator|kjua|easyqrcodejs|qr-image|node-qrcode)["']|qrserver\.com|create-qr-code|chart\.googleapis\.com\/chart\?[^"']*cht=qr/
  // The one declared exception, named with its reason (the same exemption scripts/qr-registry-guard.ts EXEMPT holds).
  const EXEMPT: Record<string, string> = { "lib/direct-mail/mail-opt-out-affordance.ts": "per-recipient UNSUBSCRIBE QR — a compliance affordance, not a marketing code" }
  const firstArg = (code: string, at: number, skip: number): string => {
    let depth = 0, args: string[] = [], cur = ""
    for (let i = at; i < code.length && i < at + 400; i++) {
      const ch = code[i]
      if ("([{".includes(ch)) depth++
      if (")]}".includes(ch)) { if (depth === 0) { args.push(cur); break } depth-- }
      if (ch === "," && depth === 0) { args.push(cur); cur = ""; continue }
      cur += ch
    }
    return (args[skip] ?? "").trim()
  }
  function judge(file: string, code: string): string[] {
    if (file === "lib/marketing/tracked-qr.ts" || EXEMPT[file]) return []
    const bad: string[] = []
    if (THIRD_PARTY_IMPORT_RE.test(code)) bad.push(`${file}: a second QR generator (third-party library or renderer)`)
    for (const m of code.matchAll(EMIT_CALL_RE)) {
      const arg = firstArg(code, (m.index ?? 0) + m[0].length, m[2] === "toCanvas" ? 1 : 0)
      if (TRACKED_ARG_RE.test(arg)) continue
      // A canvas COMPONENT encodes its `url` prop: every caller in the file must hand it a tracked scan URL.
      if (/^url$/.test(arg)) {
        const callers = [...code.matchAll(/<\w+\s+url=\{([^}]*)\}/g)].map((c) => c[1])
        if (callers.length > 0 && callers.every((c) => TRACKED_ARG_RE.test(c))) continue
      }
      bad.push(`${file}: encodes \`${arg.slice(0, 60)}\` — not the tracked scan URL`)
    }
    return bad
  }
  const sources = files.map((f) => ({ f, code: stripComments(src(f)) }))
  const emitters = sources.filter((x) => { EMIT_CALL_RE.lastIndex = 0; return EMIT_CALL_RE.test(x.code) || THIRD_PARTY_IMPORT_RE.test(x.code) })
  const violations = sources.flatMap((x) => judge(x.f, x.code))
  check(`no second QR generator and no emission of a raw destination — ${emitters.length} emitting files of ${files.length} scanned (lib, app, remotion)`, violations.length === 0, violations.join("; "))
  check("CONTROL: a raw-destination encoder is caught", judge("lib/x/specimen.ts", stripComments(`import QRCode from "qrcode"\nexport const a = () => QRCode.toDataURL(listing.publicUrl, opts)`)).length === 1)
  check("CONTROL: a canvas component fed a raw URL is caught; fed qrScanUrl(...) it passes", judge("app/x.tsx", stripComments(`QRCode.toCanvas(ref.current, url, o)\nconst v = <QRCanvas url={listing.url} />`)).length === 1 && judge("app/y.tsx", stripComments(`QRCode.toCanvas(ref.current, url, o)\nconst v = <QRCanvas url={qrScanUrl(code.slug)} />`)).length === 0)
  check("CONTROL: a third-party QR library is caught; a COMMENT naming one (a tombstone) is not", judge("app/z.tsx", stripComments(`import { QRCodeSVG } from "qrcode.react"`)).length === 1 && judge("app/w.tsx", stripComments(`// it used to import { QRCodeSVG } from "qrcode.react" and QRCode.toDataURL(rawUrl)\nexport const x = 1`)).length === 0)
  const pkg = JSON.parse(src("package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  const qrDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => /qr/i.test(d))
  check(`the only QR dependency is the vendored encoder (found: ${qrDeps.join(", ") || "none"})`, qrDeps.every((d) => d === "qrcode" || d === "@types/qrcode"))

  // E1 inventory: every Remotion composition either carries a QR slot or is declared with the exact reason it does not.
  const NO_SLOT: Record<string, string> = {
    "remotion/VideoCoverThumb.tsx": "a thumbnail — under the screen minimum and never scanned",
    "remotion/NewsletterDigestThumb.tsx": "a thumbnail — under the screen minimum and never scanned",
    "remotion/CarouselSlide.tsx": "a social carousel slide — viewed on the phone that would scan it; its post links instead",
    "remotion/LeadMagnetCard.tsx": "a social / OG share card — viewed on the phone that would scan it; the share URL is the link",
    "remotion/ListingPresentationSlide.tsx": "a slide COMPONENT reused inside ListingSectionReel, whose end card carries the code",
    "remotion/PostcardBack6x9.tsx": "the 6x9 postcard's code prints on its FRONT (PostcardFront6x9) — one code per piece",
    "remotion/PostcardBack4x6.tsx": "the 4x6 postcard's response code prints on its FRONT (PostcardFront4x6); the back carries only the per-recipient opt-out QR (the declared compliance exemption)",
    "remotion/_BrollLayer.tsx": "a background layer, not an artifact",
    "remotion/Root.tsx": "the registry of compositions", "remotion/index.ts": "the bundle entry",
  }
  const comps = readdirSync(join(root, "remotion")).filter((n) => /\.tsx?$/.test(n)).map((n) => `remotion/${n}`)
  const slotless = comps.filter((f) => !/qrCodeDataUrl|QrOutroBadge|EndCard\b/.test(stripped(f)) && !NO_SLOT[f])
  check(`every Remotion composition carries a QR slot or a declared reason (${comps.length} files; ${Object.keys(NO_SLOT).length} declared without)`, slotless.length === 0, slotless.join(", "))
  check("CONTROL: an undeclared composition with no slot is caught", ["remotion/NewReel.tsx"].filter((f) => !NO_SLOT[f]).length === 1)
  check("the declared list names only real files (a retired name cannot sit in it reading as enforced)", Object.keys(NO_SLOT).every((f) => existsSync(join(root, f))))

  // ── 2 · placement minimums from the REAL module count ──────────────────────
  console.log("\n[2 · never forced: minimum module size / quiet zone / visible time, from the real scan URL]")
  const scanSample = `${ORIGIN}/api/qr/scan?slug=${"a".repeat(contract.QR_TOKEN_SHAPE.length)}`
  const modules = qrModuleCount(scanSample)
  const { QR_OUTRO_BADGE } = await import("../lib/video/cinema-finish")
  const { compositionBookends } = await import("../lib/video/duration-model")
  const promoOutro = (compositionBookends as (id: string) => { outroFrames: number })("ProductPromoReel").outroFrames
  check(`the scan URL encodes as ${modules} modules incl. the 4-module quiet zone (ISO/IEC 18004)`, modules >= 21 + 8 && contract.QR_RENDER_DEFAULTS.margin === 4)
  check(`the video end-card badge (${QR_OUTRO_BADGE.code} px) clears ${QR_PLACEMENT_MINIMUMS.screenModulePx} px/module; ProductPromoReel's CTA scene is on screen ${promoOutro} frames (≥ ${QR_PLACEMENT_MINIMUMS.videoMinVisibleSeconds} s)`, qrPlacementFit("video_end_card", modules, { sidePx: QR_OUTRO_BADGE.code, visibleFrames: promoOutro, fps: 30 }).ok)
  check("a 0.8 in print code fits (0.45 mm/module); 0.5 in is refused; the governed mint and every mail layout hold the SAME 0.8 in", qrPlacementFit("flyer_panel", modules, { sideInches: 0.8 }).ok && !qrPlacementFit("flyer_panel", modules, { sideInches: 0.5 }).ok && QR_PLACEMENT_MINIMUMS.printMinSideIn === 0.8 && /QR_PLACEMENT_MINIMUMS\.printMinSideIn/.test(stripped("lib/marketing/qr-governance.ts")))
  check("CONTROL: a 64 px thumbnail, a 1-second flash and a size-less image slot are all refused", !qrPlacementFit("video_end_card", modules, { sidePx: 64, visibleFrames: 300 }).ok && !qrPlacementFit("video_end_card", modules, { sidePx: 200, visibleFrames: 30, fps: 30 }).ok && !qrPlacementFit("print_footer", modules, null).ok)
  check("contrast by construction: every encode is #000 on #fff (21:1); a link slot draws no image", contract.QR_RENDER_DEFAULTS.dark === "#000000" && contract.QR_RENDER_DEFAULTS.light === "#ffffff" && QR_ARTIFACT_SLOTS.email_link.medium === "link")
  {
    const png = await renderQrPng(scanSample, 600)
    // pngjs ships no type declarations; loaded through require so the proof adds no ambient module.
    const { PNG } = (await import("node:module")).createRequire(import.meta.url)("pngjs") as { PNG: { sync: { read: (b: Buffer) => { width: number; height: number; data: Uint8Array } } } }
    const img = PNG.sync.read(Buffer.from(png.split(",")[1], "base64"))
    const quietPx = Math.floor((img.width * 4) / modules) - 1
    let quietWhite = true, anyDark = false
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const v = img.data[(y * img.width + x) * 4]
      if (v < 128) anyDark = true
      if ((x < quietPx || y < quietPx || x >= img.width - quietPx || y >= img.height - quietPx) && v < 128) quietWhite = false
    }
    check(`the rendered PNG's quiet zone is white on every side (${quietPx} px of ${img.width}) and the symbol is dark`, quietWhite && anyDark)
  }

  // ── 3 · Remotion: the video mint, re-render reuse, distinct creators / tenants, the drawn end card ─────────────
  console.log("\n[3 · Remotion / D-ID end card — the props carry the tracked code and the end card draws it]")
  let db = seedDb()
  seam.client = () => db
  const v1 = await mintVideoQr({ brokerageId: "bA", agentUserId: "uA", kind: "just_listed", listingId: "LA", origin: ORIGIN }, db as never)
  const v1again = await mintVideoQr({ brokerageId: "bA", agentUserId: "uA", kind: "just_listed", listingId: "LA", origin: ORIGIN }, db as never)
  const v2 = await mintVideoQr({ brokerageId: "bA", agentUserId: "uA2", kind: "just_listed", listingId: "LA", origin: ORIGIN }, db as never)
  const vB = await mintVideoQr({ brokerageId: "bB", agentUserId: "uB", kind: "just_listed", listingId: "LA", origin: ORIGIN }, db as never)
  const row = (id: string | undefined) => (db.tables.qr_codes as any[]).find((r) => r.id === id)
  const agentIds = new Set((db.tables.agents as any[]).map((a) => a.id))
  check("FIXED: the video code's agent_id is an agents.id (FK-valid) and the creator's users.id is created_by_user_id — at 9d9626b9 agent_id was the users.id (23503 live → no code, no QR)", !!v1 && agentIds.has(row(v1.qrCodeId)?.agent_id) && row(v1.qrCodeId)?.agent_id === "agA" && row(v1.qrCodeId)?.created_by_user_id === "uA")
  check("a RE-RENDER of the same video reuses the same code (one row, same slug)", !!v1again && v1again.slug === v1?.slug && (db.tables.qr_codes as any[]).filter((r) => r.label?.startsWith("video:just_listed:LA")).length === 3)
  check("two CREATORS of one listing's video get two codes; two TENANTS never share one", !!v2 && !!vB && new Set([v1?.slug, v2.slug, vB.slug]).size === 3 && row(vB.qrCodeId)?.brokerage_id === "bB")
  check("the image encodes /api/qr/scan?slug=<token> — never the raw listing page", !!v1 && v1.qrCodeDataUrl === (await renderQrPng(v1.scanUrl)) && v1.qrCodeDataUrl !== (await renderQrPng(row(v1.qrCodeId)?.target_url ?? "")))
  {
    const React = (await import("react")).default
    const { QrOutroBadge } = await import("../remotion/components/QrOutroBadge")
    const { EndCard } = await import("../remotion/components/EndCard")
    seam.frame = 60; seam.config = { width: 1080, height: 1920, fps: 30, durationInFrames: 900 }
    const badge = await renderTree(React.createElement(QrOutroBadge, { qrCodeDataUrl: v1?.qrCodeDataUrl ?? null }))
    check("the end-card badge DRAWS the minted code (element tree <img> === renderQrPng(scanUrl))", imgSrcs(badge).includes(v1?.qrCodeDataUrl ?? "-"))
    const ec = await renderTree(React.createElement(EndCard as never, { agentName: "Ann Agent", qrCodeDataUrl: v1?.qrCodeDataUrl ?? null, brand: { primaryColor: "#0F172A", accentColor: "#F59E0B" } } as never))
    check("the shared EndCard (most reels' outro) draws the same code", imgSrcs(ec).includes(v1?.qrCodeDataUrl ?? "-"))
    const none = await renderTree(React.createElement(QrOutroBadge, { qrCodeDataUrl: null }))
    const mls = await renderTree(React.createElement(QrOutroBadge, { qrCodeDataUrl: v1?.qrCodeDataUrl ?? null, mlsClean: true }))
    check("CONTROL: no code chosen → no badge; an MLS-clean cut → no badge (branding rule)", imgSrcs(none).length === 0 && imgSrcs(mls).length === 0)

    // ProductPromoReel (the platform's promo) — the new slot, rendered.
    // The promo loads its bundled font through the browser FontFace API (Chromium has it; node does not). A face whose
    // load never settles is enough for an element tree — nothing here waits on the font.
    ;(globalThis as Record<string, unknown>).FontFace ??= class { load() { return new Promise(() => {}) } }
    const { ProductPromoReel } = await import("../remotion/ProductPromoReel")
    const platform = await tracked.mintTrackedQr({ brokerageId: null, owner: "platform", label: "product_promo:demo", destinationType: "landing_page", targetUrl: `${ORIGIN}/site/vip`, origin: ORIGIN, mintContext: { artifact_slot: "video_end_card", placement: "video_endcard" } }, db as never)
    const promoProps = { hook: "An AI team.", proofs: ["One", "Two", "Three"], cta: "Book a demo", brand: { primaryColor: "#0F172A", accentColor: "#F59E0B", name: "VIP Agents" } }
    const promo = await renderTree(React.createElement(ProductPromoReel as never, { ...promoProps, qrCodeDataUrl: platform?.qrCodeDataUrl ?? null } as never))
    const promoNone = await renderTree(React.createElement(ProductPromoReel as never, promoProps as never))
    check("ProductPromoReel's CTA end card draws the PLATFORM code from its props (no brokerage on the row)", !!platform && imgSrcs(promo).includes(platform.qrCodeDataUrl) && row(platform.qrCodeId)?.brokerage_id === null)
    check("CONTROL: ProductPromoReel without the prop draws no code (default off)", imgSrcs(promoNone).every((s) => !s.startsWith("data:image/png")))
    check("with a code the capability chips stop short of the badge column (the code never covers readable text)", /maxWidth: width - pad \* 2 - \(qrCodeDataUrl \? qrOutroBadgeWidth\(\) \+ pad : 0\)/.test(stripped("remotion/ProductPromoReel.tsx")))

    // Flyer print preview (ListingFlyer still, 2625 px = 8.75 in at 300 dpi; the code is 300 px = 1 in).
    const { ListingFlyer } = await import("../remotion/ListingFlyer")
    const flyerSlot = await resolveArtifactQrSlot({ brokerageId: "bA", sourceTable: "listings", sourceId: "LA", slot: "flyer_panel", destinationUrl: `${ORIGIN}/listings/LA`, destinationType: "listing_detail", purpose: "listing", creatorUserId: "uA", listingId: "LA", size: { sideInches: 1 }, origin: ORIGIN }, db as never)
    seam.frame = 0; seam.config = { width: 2625, height: 3375, fps: 30, durationInFrames: 1 }
    const flyer = flyerSlot.status === "placed" ? await renderTree(React.createElement(ListingFlyer as never, { address: "1 Main", cityState: "Naples, FL", price: "$1", beds: "3", baths: "2", sqft: "1", propertyType: "SFH", highlights: [], heroImageUrl: null, photoUrls: [], agentName: "Ann", agentPhone: null, agentPhotoUrl: null, qrCodeDataUrl: flyerSlot.qrCodeDataUrl, qrCaption: "Scan to tour", statusLine: "JUST LISTED", brand: { primaryColor: "#0F172A", accentColor: "#F59E0B", logoUrl: null, brokerageName: "Alder", licenseLine: null, showEhoMark: true } } as never)) : ""
    check("the FLYER print preview draws the slot's tracked code (1 in on the 8.75 in still) and the slot row names its source + placement", flyerSlot.status === "placed" && imgSrcs(flyer).includes(flyerSlot.qrCodeDataUrl ?? "-") && row(flyerSlot.qrCodeId)?.mint_context?.placement === "flyer" && row(flyerSlot.qrCodeId)?.mint_context?.source_table === "listings")
    check("the flyer's agent_id is the creator's agents row (resolved from users.id under the tenant)", flyerSlot.status === "placed" && row(flyerSlot.qrCodeId)?.agent_id === "agA" && row(flyerSlot.qrCodeId)?.created_by_user_id === "uA")
  }

  // Mail print preview — the REAL letter renderer with a slot-minted mail code (seams as direct-mail-rendering-guard §L).
  {
    const { renderLetterHtml } = await import("../lib/direct-mail/render-letter")
    const mail = await resolveArtifactQrSlot({ brokerageId: "bA", sourceTable: "direct_mail_campaigns", sourceId: "dm-1", slot: "mail_panel", destinationUrl: `${ORIGIN}/listings/LA`, creatorUserId: "uA", size: { sideInches: 1 }, origin: ORIGIN }, db as never)
    const brand = { displayName: "The Alder Team", brokerageName: "Alder Realty LLC", visual: { primaryColor: "#0F172A", accentColor: "#F59E0B" }, display: { websiteWordmark: "alder.example", phone: "404-555-0100", licenseLine: "GA License # 1" }, fairHousing: { longDisclosure: "Alder Realty LLC is committed to the Fair Housing Act." } }
    const seams = { resolveBrand: (async () => brand) as never, draftCopy: (async () => ({ ok: true, copy: { greeting: "Hi {{first_name}},", body: "Spring is a good time to look.", signoff: "Warmly," }, complianceEventId: null })) as never }
    const args = { brokerageId: "bA", copyCtx: { brokerageId: "bA", teamId: null, agentUserId: null } as never, recipientFirstName: "Jordan", recipientLastName: "Lee", recipientStreet: "9 Elm St", recipientCityState: "Atlanta, GA", recipientZip: "30303", agentName: "Ann", agentTitle: null }
    const letter = mail.status === "placed" ? await renderLetterHtml({ ...args, qrScanUrl: mail.scanUrl, qrCodeState: "active" }, seams) : null
    const held = mail.status === "placed" ? await renderLetterHtml({ ...args, qrScanUrl: mail.scanUrl, qrCodeState: "paused" }, seams) : null
    check("the MAIL print preview prints the slot's tracked code (its token in the region) and keeps the disclosure", !!letter?.ok && letter.qrRegion?.print === true && mail.status === "placed" && letter.qrRegion?.token === mail.slug && /Fair Housing/.test(letter.html ?? ""))
    check("CONTROL: the same letter with the code paused prints NO code (the region is blank, the letter still renders)", !!held?.ok && held.qrRegion?.print === false)
  }

  // ── 4/5 · newsletter: clickable tracked link in the email, the QR in print ──
  console.log("\n[5 · newsletter — email carries the clickable tracked link; the print form carries the QR]")
  {
    const { assembleNewsletterHtml, newsletterQrBlock } = await import("../lib/kernel/newsletter/assemble")
    const nl = { brokerageId: "bA", sourceTable: "newsletter_campaigns", sourceId: "nl-1", destinationUrl: `${ORIGIN}/site/alder`, destinationType: "landing_page" as const, creatorUserId: "uA", marketingCampaignId: "cA", origin: ORIGIN }
    const email = await resolveArtifactQrSlot({ ...nl, slot: "email_link" }, db as never)
    const print = await resolveArtifactQrSlot({ ...nl, slot: "print_footer", size: { sideInches: 1 } }, db as never)
    const ctx = { campaignId: "nl-1", brokerageId: "bA", newsletterId: "nl-1", campaignSubject: "Spring", campaignBodyHtml: "<p>Hello</p>" }
    const sections = [{ id: "s1", newsletter_id: "nl-1", brokerage_id: "bA", title: "Market", content: "<p>Inventory rose.</p>", order_index: 1, target_personas: null, section_type: null, target_locations: null }]
    const e = email.status === "placed" ? assembleNewsletterHtml({ context: ctx, sections: sections as never, qr: { form: "email", scanUrl: email.scanUrl } }) : null
    const p = print.status === "placed" ? assembleNewsletterHtml({ context: ctx, sections: sections as never, qr: { form: "print", scanUrl: print.scanUrl, qrCodeDataUrl: print.qrCodeDataUrl } }) : null
    check("the EMAIL body carries the code's tracked scan URL as a clickable link and NO image", email.status === "placed" && email.qrCodeDataUrl === null && !!e && e.html.includes(`href="${email.scanUrl}"`) && imgSrcs(e.html).length === 0)
    check("the PRINT form draws the QR (=== renderQrPng(scanUrl)) after the sections — the disclosures assembleEmail appends come after it", print.status === "placed" && !!p && imgSrcs(p.html).includes(print.qrCodeDataUrl ?? "-") && p.html.indexOf("Inventory rose") < p.html.indexOf("data-qr-slot"))
    check("email link and print QR are two LOGICAL codes (clicks and scans are measured apart) on the same campaign", email.status === "placed" && print.status === "placed" && email.slug !== print.slug && row(email.qrCodeId)?.marketing_campaign_id === "cA" && row(print.qrCodeId)?.marketing_campaign_id === "cA")
    check("CONTROL: a raw destination handed in as the URL renders NOTHING (only a tracked scan URL is placed); no slot → no block", newsletterQrBlock({ form: "email", scanUrl: `${ORIGIN}/site/alder` }).html === "" && assembleNewsletterHtml({ context: ctx, sections: sections as never }).html.indexOf("data-qr-slot") === -1)
  }

  // ── 6 · blog: the print QR resolves to the real post ──────────────────────
  console.log("\n[6 · blog — the post's print QR scans to the real post]")
  const { GET } = await import("../app/api/qr/scan/route")
  const { NextRequest } = await import("next/server")
  const emitted: Array<{ event: string; contactId?: string; metadata?: Record<string, unknown> }> = []
  seam.emit = async (ev) => { emitted.push(ev); return { inserted: false, lifecycleEventId: null, fanOutOk: true, error: null } }
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
  const scan = async (qs: string) => {
    const res = await GET(new NextRequest(`${ORIGIN}/api/qr/scan${qs}`, { headers: { "user-agent": IPHONE, "x-forwarded-for": "203.0.113.9" } }))
    for (const ev of db.tables.qr_scan_events as any[]) if (!ev.scanned_at) ev.scanned_at = new Date().toISOString()
    return { status: res.status, location: res.headers.get("location"), body: res.status >= 300 && res.status < 400 ? "" : await res.text() }
  }
  const post = { id: "bp-1", brokerage_id: "bA", slug: "spring-market", agent_user_id: "uA", marketing_campaign_id: "cA" }
  const blog = await resolveArtifactQrSlot(blogPrintQrArgs(post, ORIGIN), db as never)
  const blogAgain = await resolveArtifactQrSlot(blogPrintQrArgs(post, ORIGIN), db as never)
  const blogScan = blog.status === "placed" ? await scan(`?slug=${blog.slug}`) : null
  check("FIXED: a blog's print QR redirects to the real post /blog/<slug> with qr=<token> (at 9d9626b9 '/blog/' was not a public destination → /qr/<slug>)", !!blogScan && blogScan.status === 302 && blogScan.location === `${ORIGIN}/blog/spring-market?qr=${blog.status === "placed" ? blog.slug : ""}` && QR_IN_APP_PUBLIC_PREFIXES.includes("/blog/") && existsSync(join(root, "app/blog/[slug]/page.tsx")))
  check("the editor preview and the public page resolve the SAME logical code (built from the post, not the viewer)", blog.status === "placed" && blogAgain.status === "placed" && blogAgain.reused && blogAgain.slug === blog.slug && /blogPrintQrArgs\(\{ \.\.\.post, brokerage_id: userData\.brokerage_id \}\)/.test(stripped("app/dashboard/marketing/blog/[id]/page.tsx")) && /blogPrintQrArgs\(post, baseUrl \|\| null\)/.test(stripped("app/blog/[slug]/page.tsx")))
  check("the public post prints the code ONLY on paper (print-only block) and never covers the article", /className="hidden print:flex[^"]*"/.test(stripped("app/blog/[slug]/page.tsx")))
  check("CONTROL: a path outside the allow-list (/blogx/) still lands on the code's own landing, never a redirect into it", contract.resolveQrScanDestination({ slug: "t", targetUrl: `${ORIGIN}/blogx/y`, appOrigins: [ORIGIN] }).kind !== "in_app")

  // ── 7 · edit destination moves every linked artifact; paused HOLDS ────────
  console.log("\n[7 · governance — edit destination keeps the slug (linked artifacts follow); a paused code HOLDS the piece]")
  if (blog.status === "placed") {
    const edit = await gov.editQrDestination({ qrCodeId: blog.qrCodeId, targetUrl: `${ORIGIN}/site/alder`, destinationType: "landing_page", reason: "Point at the storefront" }, A as never, deps(db) as never)
    const after = await resolveArtifactQrSlot(blogPrintQrArgs(post, ORIGIN), db as never)
    const rescan = await scan(`?slug=${blog.slug}`)
    check("edit destination → a NEW version on the SAME code: the re-rendered piece keeps its slug and every printed copy now opens the new destination", edit.ok && after.status === "placed" && after.slug === blog.slug && (row(blog.qrCodeId)?.destination_history ?? []).length === 2 && rescan.location === `${ORIGIN}/site/alder?qr=${blog.slug}`)
    const pause = await gov.changeQrLifecycle({ qrCodeId: blog.qrCodeId, action: "pause" }, A as never, deps(db) as never)
    const before = (db.tables.qr_codes as any[]).length
    const heldSlot = await resolveArtifactQrSlot(blogPrintQrArgs(post, ORIGIN), db as never)
    check("FIXED: re-rendering a piece whose code is PAUSED is HELD (no silent replacement code pointing at the same offer)", pause.ok && heldSlot.status === "held" && heldSlot.state === "paused" && (db.tables.qr_codes as any[]).length === before)
    await gov.changeQrLifecycle({ qrCodeId: blog.qrCodeId, action: "resume" }, A as never, deps(db) as never)
    check("resume → the same slot places the same code again", (await resolveArtifactQrSlot(blogPrintQrArgs(post, ORIGIN), db as never)).status === "placed")
  }
  {
    const otherTenant = vB ? await resolveArtifactQrSlot({ brokerageId: "bA", sourceTable: "blog_posts", sourceId: "bp-2", slot: "print_footer", destinationUrl: `${ORIGIN}/blog/x`, size: { sideInches: 1 }, choice: { mode: "existing", qrCodeId: vB.qrCodeId }, origin: ORIGIN }, db as never) : null
    const none = await resolveArtifactQrSlot({ brokerageId: "bA", sourceTable: "blog_posts", sourceId: "bp-2", slot: "print_footer", destinationUrl: `${ORIGIN}/blog/x`, size: { sideInches: 1 }, choice: { mode: "none" } }, db as never)
    const tiny = await resolveArtifactQrSlot({ brokerageId: "bA", sourceTable: "blog_posts", sourceId: "bp-2", slot: "print_footer", destinationUrl: `${ORIGIN}/blog/x`, size: { sideInches: 0.4 } }, db as never)
    check("a code CHOSEN from another tenant is refused (cross_tenant) — no cross-tenant attribution", otherTenant?.status === "refused" && /cross_tenant/.test((otherTenant as { reason: string }).reason))
    check("tenant chose NONE → absent; a 0.4 in placement → too_small; neither mints a row", none.status === "absent" && tiny.status === "too_small" && !(db.tables.qr_codes as any[]).some((r) => String(r.label).includes("bp-2")))
  }

  // ── 8 · refused scans: friendly page + an event, never a person ────────────
  console.log("\n[8 · paused / expired / unknown / retired — the friendly state AND an event; never the retired destination]")
  {
    db.tables.qr_codes.push({ id: "q-exp", brokerage_id: "bA", slug: "tokexpired000000000001", label: "x", target_url: `${ORIGIN}/listings/LA`, purpose: "listing", is_active: true, scan_count: 0, expires_at: "2020-01-01T00:00:00Z", mint_context: {} } as never)
    db.tables.qr_codes.push({ id: "q-pz", brokerage_id: "bA", slug: "tokpaused0000000000001", label: "y", target_url: `${ORIGIN}/listings/LA`, purpose: "listing", is_active: false, scan_count: 0, mint_context: {} } as never)
    const scansBefore = (db.tables.qr_scan_events as any[]).length
    const exp = await scan("?slug=tokexpired000000000001")
    const pz = await scan("?slug=tokpaused0000000000001")
    const unk = await scan("?slug=tokunknown000000000001")
    const refusedEvents = (db.tables.lifecycle_events as any[]).filter((e) => e.event_type === "qr_scan_refused")
    check("expired → 410 'expired', paused → 403 'paused', unknown → 404 — each the friendly page, none redirects", exp.status === 410 && /has expired/.test(exp.body) && pz.status === 403 && /is paused/.test(pz.body) && unk.status === 404 && /don't recognize/.test(unk.body) && !exp.location && !pz.location && !unk.location)
    check("FIXED: each refused scan of a REAL code leaves ONE lifecycle event naming the code + state (at 9d9626b9: none)", refusedEvents.length === 2 && refusedEvents.map((e) => e.metadata?.state).sort().join() === "expired,paused" && refusedEvents.find((e) => e.metadata?.state === "expired")?.entity_id === "q-exp" && refusedEvents.every((e) => !!e.brokerage_id && !!e.entity_id))
    check("an UNKNOWN slug leaves NO row — lifecycle_events requires a tenant and an entity (live NOT NULL), so a stranger's random slug can neither write an event nor fill the failure ledger", !refusedEvents.some((e) => e.metadata?.state === "missing") && !(db.tables.lifecycle_events as any[]).some((e) => e.brokerage_id == null || e.entity_id == null))
    check("the refused-scan event holds NOTHING about the scanner (no visitor key, network, browser, raw slug) and no scan row is written", refusedEvents.every((e) => Object.keys(e.metadata ?? {}).sort().join() === "slug_hash,state" && !JSON.stringify(e).includes("tokunknown") && !JSON.stringify(e).includes("203.0.113")) && (db.tables.qr_scan_events as any[]).length === scansBefore)
    check("CONTROL: an over-long slug is refused before any lookup (never stored)", (await scan(`?slug=${"z".repeat(200)}`)).status === 404 && !(db.tables.lifecycle_events as any[]).some((e) => JSON.stringify(e).includes("zzzz")))
  }

  // ── 9 · a scan is not an identity (PRIV-005); a sealed grant is the only lawful person ──
  console.log("\n[9 · PRIV-005 — an anonymous scan stays anonymous; only a sealed, expiring grant names a Contact]")
  if (blog.status === "placed") {
    const contactsBefore = (db.tables.contacts as any[]).length
    emitted.length = 0
    await scan(`?slug=${blog.slug}`)
    const anon = (db.tables.qr_scan_events as any[]).filter((e) => e.qr_code_id === blog.qrCodeId).at(-1)
    check("an ANONYMOUS scan: contact_id null, no Contact / Lead created, the kernel event names no person ('anonymous')", !!anon && anon.contact_id === null && (db.tables.contacts as any[]).length === contactsBefore && (db.tables.leads as any[]).length === 0 && emitted.at(-1)?.contactId === undefined && emitted.at(-1)?.metadata?.personal === "anonymous")
    const personal = await resolveArtifactQrSlot({ ...blogPrintQrArgs(post, ORIGIN), personal: { sealer, subject: { kind: "contact", id: "ctA" } }, size: { sideInches: 1.5 } }, db as never)
    const purl = personal.status === "placed" ? personal.personalScanUrl ?? "" : ""
    check("a PERSONAL piece carries a sealed grant on the SAME logical code; the URL holds no Contact id", personal.status === "placed" && personal.slug === blog.slug && /&g=/.test(purl) && !purl.includes("ctA"))
    emitted.length = 0
    await scan(purl.replace(ORIGIN + "/api/qr/scan", ""))
    const named = (db.tables.qr_scan_events as any[]).filter((e) => e.qr_code_id === blog.qrCodeId).at(-1)
    check("a valid grant → the scan row names that Contact and the arbiter event carries contactId (opportunity only when lawfully resolved)", named?.contact_id === "ctA" && emitted.at(-1)?.contactId === "ctA" && emitted.at(-1)?.metadata?.personal === "grant")
    const forged = tracked.mintQrPersonalGrant(sealer, { qrCodeId: blog.qrCodeId, brokerageId: "bB", subject: { kind: "contact", id: "ctB" } })
    const otherCode = tracked.mintQrPersonalGrant(sealer, { qrCodeId: "q-other", brokerageId: "bA", subject: { kind: "contact", id: "ctA" } })
    const expired = tracked.mintQrPersonalGrant(sealer, { qrCodeId: blog.qrCodeId, brokerageId: "bA", subject: { kind: "contact", id: "ctA" }, nowMs: Date.now() - 40 * 24 * 3600 * 1000 })
    const results: Array<string | null> = []
    for (const gr of [forged, otherCode, expired]) {
      emitted.length = 0
      if (gr.ok) await scan(`?slug=${blog.slug}&g=${encodeURIComponent(gr.grant)}`)
      results.push((db.tables.qr_scan_events as any[]).filter((e) => e.qr_code_id === blog.qrCodeId).at(-1)?.contact_id ?? null)
    }
    await scan(`?slug=${blog.slug}&g=not-a-grant`)
    const junk = (db.tables.qr_scan_events as any[]).filter((e) => e.qr_code_id === blog.qrCodeId).at(-1)?.contact_id ?? null
    check("CONTROL: another tenant's grant, another code's grant, an expired grant and junk all stay ANONYMOUS", forged.ok && otherCode.ok && expired.ok && results.every((r) => r === null) && junk === null)
    check("the 1.5 in personal print still fits (the longer sealed URL is re-checked); 0.8 in does not, and says why", personal.status === "placed" && (await resolveArtifactQrSlot({ ...blogPrintQrArgs(post, ORIGIN), personal: { sealer, subject: { kind: "contact", id: "ctA" } }, size: { sideInches: 0.8 } }, db as never)).status === "too_small")
  }

  // ── 10 · registry: provenance, lead visibility, the duplicate's state transition ──
  console.log("\n[10 · registry (QR board) — source artifact shown; a Lead only to lead-desk viewers; duplicate reaches the list]")
  {
    const mgmt = stripped("app/actions/qr-management.ts")
    check("the board projects the source artifact, the Contact, and the LEAD only when the viewer is lead-desk staff (agents see Contacts only)", /lead_id:\s+viewerSeesLeads \? ctx\.lead_id \?\? null : null/.test(mgmt) && /provenanceOf\(c, creatorNames, !!ctx\.userType && LEAD_DESK_USER_TYPES\.has\(ctx\.userType\)\)/.test(mgmt) && /source_artifact:/.test(mgmt))
    check("CONTROL: the projection rule would catch an unconditional lead (the finder sees the bad shape)", !/lead_id:\s+viewerSeesLeads \? ctx\.lead_id \?\? null : null/.test("lead_id: ctx.lead_id ?? null"))
    const client = stripped("app/dashboard/agent/qr-codes/QRCodesClient.tsx")
    check("click-path: Duplicate adds the new code to the list (it used to say 'reload to see it' and never did)", /const dup = res\.code\s+setCodes\(\(prev\)/.test(client) && !/reload to see it in the list/.test(client))
    const slotRow = (db.tables.qr_codes as any[]).find((r) => r.mint_context?.source_table === "blog_posts")
    check("every slot code records tenant, creator (users.id + agents.id), campaign, source table + id, slot, placement, destination history", !!slotRow && slotRow.brokerage_id === "bA" && slotRow.created_by_user_id === "uA" && slotRow.agent_id === "agA" && slotRow.marketing_campaign_id === "cA" && slotRow.mint_context.asset_id === "bp-1" && slotRow.mint_context.artifact_slot === "print_footer" && Array.isArray(slotRow.destination_history))
  }

  console.log(`\n blind spots: SIMULATED throughout — the in-memory client enforces no FK, CHECK, RLS or trigger (the agent_id FK is asserted against the seeded agents table; m945's history trigger is not run). The Remotion components render on a stub runtime (no Chromium, no real frame timing); the drawn code is proved by byte-equality with the deterministic encoder, not by decoding a camera image. Whether lifecycle_events.brokerage_id admits NULL for an unknown slug is UNRESOLVED from the repo caches (the write is sentinel-wrapped). The census sees QRCode.* / renderQrPng / named third-party libraries and renderers — a hand-rolled encoder would not be seen; scripts/ are out of the denominator. Generators wired to the slot here: Remotion end cards (video-qr + ProductPromoReel prop), ListingFlyer, the letter, the newsletter assembler, the blog page + editor preview; callers that do not yet pass a slot are named PARTIAL in the lane notes.`)
  console.log(`\nqr-everywhere-guard: ${passed} passed, ${failed} failed`)
  if (failed > 0) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1) }
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
