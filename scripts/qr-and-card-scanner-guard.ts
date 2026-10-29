#!/usr/bin/env tsx
/**
 * scripts/qr-and-card-scanner-guard.ts   (npm run test:qr-and-card-scanner)
 * ─────────────────────────────────────────────────────────────────────────────
 * QR / BARCODE + BUSINESS-CARD SCANNER — THE FULL PRODUCT FLOWS, HELD (wave 141,
 * lane 141F; owner rulings verbatim: "QR / BARCODE: generate → intended encoded
 * destination/action → scan → correct tenant → attribution → intended action →
 * analytics. No cross-tenant resolution, no open redirect, no broken mobile
 * route." · "BUSINESS CARD SCANNER: scan → AI vision extraction → confidence →
 * human confirmation where needed → identity/dedup → canonical contact →
 * attribution/source → follow-up. No second OCR system; never overwrite
 * higher-confidence data with weak extraction.")
 *
 * SURVIVORS (already existed — reused, extended, never rebuilt): qr_codes written
 * only by lib/marketing/tracked-qr.ts mintTrackedQr (scripts/qr-registry-guard.ts
 * holds that), scanned only through app/api/qr/scan (qr_scan_events +
 * QR_SCAN_RECEIVED), captured through app/api/qr/submit → captureContact (the
 * one dedup/merge door every capture shares), landing at app/qr/[slug]; the
 * business-card vision call app/actions/business-card/business-card-actions.ts
 * uploadBusinessCard → gatewayChat (the ONE vision path) → classifyCardSubject
 * (lib/contacts/card-classifier.ts) → captureContact. What this wave ADDED on
 * them: lib/marketing/qr-contract.ts (one encoding contract + the scan
 * destination allow-list), the per-field confidence / hold-for-confirmation /
 * field-level merge rules in card-classifier.ts, confirmBusinessCardScan, the
 * vision call's entitlement gate + cost booking.
 *
 * SECTIONS (each absence assertion carries a positive control — CLAUDE.md §2):
 *   1 ENCODING — one contract (quiet zone ≥ 4 modules, EC ∈ {M,Q,H}, black on
 *     white, print width ≥ 600); every live encoder passes it (stripped-source
 *     sweep; specimen with a hand-rolled `margin: 1` is caught); the longest scan
 *     URL the minter can produce still fits a camera-friendly symbol (≤ version 10
 *     at EC M, computed with the real `qrcode` encoder; a 400-char control exceeds).
 *   2 DESTINATION ALLOW-LIST + OPEN-REDIRECT CONTROL — every allow-listed prefix is
 *     a real public app/<segment> and never /api, /dashboard, /admin, /settings;
 *     the pure resolver sends an in-app path through with `qr=` appended once, holds
 *     a not-allow-listed path, `//host`, `javascript:`, `data:` and plain-http on the
 *     landing with NO external offer, offers only https on the landing, and
 *     normalises `..` before judging.
 *   3 THE SCAN DOOR — reads target_url, decides through the resolver, redirects to
 *     `destination.path` only; tenant from the row (no request-named brokerage);
 *     still records qr_scan_events + QR_SCAN_RECEIVED with the routing verdict in
 *     the metadata (analytics). Specimen `redirect(searchParams.get("to"))` caught.
 *   4 THE CAPTURE DOOR — id AND slug must agree (fail closed), tenant from the row,
 *     rate-limited, captureContact is the identity/dedup layer, source qr_scan.
 *   5 MOBILE — the landing renders under react-dom/server at both states, every
 *     control is ≥ 44 px and inputs are 16 px (no iOS focus zoom), no fixed width
 *     wider than a phone, the root layout exports a viewport, the scan door's
 *     refusal page carries one; an external offer is `rel="noopener noreferrer"`.
 *   6 NO DANGLING DEFAULT — the one default table yields only allow-listed paths;
 *     the admin mint route, the marketing minter and the board's help text name no
 *     `${origin}/<segment>` outside the allow-list (specimen `/book` caught).
 *   7 CARD SCANNER — parse (per-field + legacy flat), assess (viable / needs
 *     confirmation / low fields), confident-fields gate, the field-level merge
 *     rule with positive + negative controls, provenance stamps by value equality;
 *     source: entitlement gate BEFORE the vision call, cost booked after it with
 *     the gateway's usage, the hold path, the confirm action (session tenant,
 *     withActionLedger, the merge rule), exactly ONE captureContact call site,
 *     the review surface's "Report extraction error" is wired (no toast-only
 *     handler), BARCODE (1D) is claimed nowhere in product code or docs.
 *   8 REGISTRATION — package.json key + guard-chain membership (a rule, not a
 *     position) + MAINTENANCE_DOMAINS owner with co-owners.
 *
 * No network, no DB. Run: npx tsx scripts/qr-and-card-scanner-guard.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import QRCode from "qrcode"
import { stripComments, blankStrings } from "./strip-comments"
import {
  QR_RENDER_DEFAULTS, qrEncodeOptions, QR_IN_APP_PUBLIC_PREFIXES, isQrInAppPublicPath,
  qrInAppDefaultPath, resolveQrScanDestination, qrContinueLabel,
} from "../lib/marketing/qr-contract"
import {
  CARD_FIELDS, CARD_FIELD_CONFIDENCE_FLOOR, parseCardExtraction, assessCardExtraction, confidentCardFields,
  unconfirmedCardNote, decideCardFieldWrite, cardStampsForContact, humanConfirmedExtraction, normalizeCardValue,
  CARD_PROVENANCE_SOURCE_VISION, CARD_PROVENANCE_SOURCE_HUMAN,
} from "../lib/contacts/card-classifier"
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

const SCAN_ROUTE = "app/api/qr/scan/route.ts"
const SUBMIT_ROUTE = "app/api/qr/submit/route.ts"
const LANDING_PAGE = "app/qr/[slug]/page.tsx"
const LANDING_CLIENT = "app/qr/[slug]/QRLandingClient.tsx"
const ADMIN_ROUTE = "app/api/admin/qr-codes/route.ts"
const MARKETING_QR = "lib/marketing/marketing-qr.ts"
const TRACKED_QR = "lib/marketing/tracked-qr.ts"
const BOARD_CLIENT = "app/dashboard/agent/qr-codes/QRCodesClient.tsx"
const CARD_ACTIONS = "app/actions/business-card/business-card-actions.ts"
const CARD_PAGE = "app/dashboard/agent/business-cards/page.tsx"
const GATEWAY = "lib/ai/gateway-chat.ts"

/** The `qrcode` package's symbol builder (not in types/qrcode.d.ts — the proof reaches it by cast). */
const qrCreate = (QRCode as unknown as { create: (text: string, opts: { errorCorrectionLevel: string }) => { version: number } }).create

/** The arguments of every `QRCode.toDataURL(` / `QRCode.toCanvas(` call in a stripped source. */
function encoderCallArgs(code: string): string[] {
  const out: string[] = []
  const re = /QRCode\.to(?:DataURL|Canvas)\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    let depth = 1, i = m.index + m[0].length
    for (; i < code.length && depth > 0; i++) { if (code[i] === "(") depth++; else if (code[i] === ")") depth-- }
    out.push(code.slice(m.index + m[0].length, i - 1))
  }
  return out
}
const USES_CONTRACT_RE = /\bqrEncodeOptions\(|\bMAIL_OPT_OUT_QR_OPTIONS\b/
/** A `redirect(` whose ARGUMENT text is chosen by the request (the open-redirect shape). */
const REQUEST_CHOSEN_REDIRECT_RE = /redirect\([^;]*?(searchParams|nextUrl|body\.|formData)/

async function main() {
  console.log("\n[1 · ONE ENCODING — quiet zone, error correction, contrast, size; every live encoder passes it]")
  check("the contract: quiet zone ≥ 4 modules (ISO/IEC 18004), EC ∈ {M,Q,H}, black on white, print width ≥ 600 px",
    QR_RENDER_DEFAULTS.margin >= 4 && ["M", "Q", "H"].includes(QR_RENDER_DEFAULTS.errorCorrectionLevel) && QR_RENDER_DEFAULTS.dark === "#000000" && QR_RENDER_DEFAULTS.light === "#ffffff" && QR_RENDER_DEFAULTS.printWidth >= 600)
  const o = qrEncodeOptions(300)
  check("qrEncodeOptions(width) carries the contract and only the width; a caller may raise EC to Q, never lower it",
    o.width === 300 && o.margin === QR_RENDER_DEFAULTS.margin && o.errorCorrectionLevel === "M" && o.color.dark === "#000000"
    && qrEncodeOptions(280, { errorCorrectionLevel: "Q" }).errorCorrectionLevel === "Q" && qrEncodeOptions(0).width === QR_RENDER_DEFAULTS.printWidth)
  {
    const files = ["lib", "app", "remotion"].flatMap((d) => walk(join(root, d)))
    const offenders: string[] = []
    let calls = 0
    for (const f of files) {
      const code = stripped(f)
      for (const args of encoderCallArgs(code)) { calls++; if (!USES_CONTRACT_RE.test(args)) offenders.push(`${rel(f)} :: ${args.slice(0, 60).replace(/\s+/g, " ")}`) }
    }
    console.log(`    denominator: ${files.length} files, ${calls} QRCode.toDataURL/toCanvas calls`)
    check("every live encoder call passes qrEncodeOptions (or the Q-raised opt-out options built from it) — no hand-rolled option literal", calls > 0 && offenders.length === 0, offenders.join(", "))
    check("CONTROL: a specimen with a hand-rolled `{ width: 200, margin: 1 }` is caught", encoderCallArgs(stripComments(`const a = await QRCode.toDataURL(url, { width: 200, margin: 1 })`)).some((a) => !USES_CONTRACT_RE.test(a)))
    check("CONTROL: the arg extractor sees nested parens (a call inside the options)", encoderCallArgs(`QRCode.toCanvas(el, url, qrEncodeOptions(size(2)))`)[0] === "el, url, qrEncodeOptions(size(2))")
    check("the minter's renderQrPng encodes through the contract (tracked-qr.ts)", /renderQrPng[\s\S]{0,300}qrEncodeOptions\(/.test(stripped(TRACKED_QR)))
  }
  {
    // The longest slug the minter can produce: 40 label chars + "-" + a base36 ms timestamp (8 chars).
    const longestSlug = `${"a".repeat(40)}-${Date.now().toString(36)}`
    const url = `https://app.vipagentos.com/api/qr/scan?slug=${longestSlug}`
    const version = qrCreate(url, { errorCorrectionLevel: QR_RENDER_DEFAULTS.errorCorrectionLevel }).version
    check(`the longest scan URL (${url.length} chars) fits QR version ≤ 10 at EC ${QR_RENDER_DEFAULTS.errorCorrectionLevel} (version ${version}) — a symbol phone cameras read at arm's length`, version <= 10)
    check("CONTROL: a 400-char payload needs more than version 10 (the encoder is measuring)", qrCreate("https://x.example/" + "q".repeat(380), { errorCorrectionLevel: "M" }).version > 10)
  }

  console.log("\n[2 · DESTINATION ALLOW-LIST + OPEN-REDIRECT CONTROL — pure resolver]")
  {
    const bad = QR_IN_APP_PUBLIC_PREFIXES.filter((p) => !existsSync(join(root, "app", p.replace(/\//g, ""))))
    check("every allow-listed prefix is a real app/<segment> directory (a retired route cannot sit in the list)", QR_IN_APP_PUBLIC_PREFIXES.length > 0 && bad.length === 0, bad.join(", "))
    check("the allow-list never admits a session surface (/api, /dashboard, /admin, /settings)", QR_IN_APP_PUBLIC_PREFIXES.every((p) => !/^\/(api|dashboard|admin|settings)\//.test(p)))
    check("isQrInAppPublicPath: allow-listed roots and children pass; a session surface, `//host` and a bare path do not",
      isQrInAppPublicPath("/home-value") && isQrInAppPublicPath("/lm/guide?x=1") && !isQrInAppPublicPath("/dashboard/leads") && !isQrInAppPublicPath("//evil.com/lm/x") && !isQrInAppPublicPath("lm/x"))
    const APP = "https://app.vipagentos.com"
    const origins = [APP, "https://tenant.example.com"]
    const r = (t: string | null) => resolveQrScanDestination({ slug: "s-1", targetUrl: t, appOrigins: origins })
    check("an allow-listed relative path is sent through with qr=<slug> appended once (existing query kept)",
      (() => { const d = r("/lm/buyer-guide?utm=print"); return d.kind === "in_app" && d.path === "/lm/buyer-guide?utm=print&qr=s-1" })())
    check("a same-host absolute URL (the app origin) is an in-app path", (() => { const d = r(`${APP}/open-house/E1/signin`); return d.kind === "in_app" && d.path === "/open-house/E1/signin?qr=s-1" })())
    check("a same-host absolute URL on the TENANT's custom domain is an in-app path too", (() => { const d = r("https://tenant.example.com/listings/L1"); return d.kind === "in_app" && d.path === "/listings/L1?qr=s-1" })())
    check("qr= is never duplicated", (() => { const d = r("/lm/x?qr=s-1"); return d.kind === "in_app" && d.path === "/lm/x?qr=s-1" })())
    check("the code's own landing (/qr/<slug>) and the minter's pre-slug placeholder (/qr) resolve to the landing, no loop",
      (() => { const a = r(`${APP}/qr/s-1`), b = r(`${APP}/qr`); return a.kind === "landing" && a.reason === "landing_is_target" && b.kind === "landing" && b.external === null })())
    check("no target → landing (no_target)", (() => { const d = r(null); return d.kind === "landing" && d.reason === "no_target" && d.path === "/qr/s-1" })())
    check("a same-host path OUTSIDE the allow-list (a dashboard page) → landing, never redirected", (() => { const d = r("/dashboard/leads"); return d.kind === "landing" && d.reason === "not_allow_listed" })())
    check("`..` is normalised BEFORE the allow-list test (/listings/../dashboard is /dashboard)", (() => { const d = r("/listings/../dashboard"); return d.kind === "landing" && d.reason === "not_allow_listed" })())
    check("OPEN-REDIRECT CONTROL: a foreign https host is never redirected to — it is OFFERED on the landing as a link",
      (() => { const d = r("https://evil.example/phish"); return d.kind === "landing" && d.reason === "external_https" && d.external?.host === "evil.example" })())
    check("`//evil.example/x` (scheme-relative) is unsafe → landing with NO external offer", (() => { const d = r("//evil.example/x"); return d.kind === "landing" && d.external === null && d.reason === "unsafe_target" })())
    check("javascript: / data: / plain http: / mailto: / garbage → landing with NO external offer",
      ["javascript:alert(1)", "data:text/html,hi", "http://evil.example/x", "mailto:a@b.c", "not a url"].every((t) => { const d = r(t); return d.kind === "landing" && d.external === null && d.reason === "unsafe_target" }))
    check("the resolver takes NO tenant: its inputs are the slug, the row's target and the app origins (a scanner controls only the slug, which only ever appends itself)",
      !/brokerage/i.test(stripped("lib/marketing/qr-contract.ts").match(/export function resolveQrScanDestination[\s\S]*?\n}/)?.[0] ?? "brokerage"))
    check("continue labels exist for every destination type and never say 'platform-covered'", ["listing_detail", "book_meeting", "cma_form", "video_avatar_tour", "podcast_episode", "anniversary_video", "landing_page", "other", null].every((t) => qrContinueLabel(t, false).length > 0 && !/platform-covered/i.test(qrContinueLabel(t, true))))
  }

  console.log("\n[3 · THE SCAN DOOR — intended action, tenant from the row, attribution + analytics]")
  {
    const scan = stripped(SCAN_ROUTE)
    check("selects target_url and decides through resolveQrScanDestination (app origin + request origin)",
      /from\('qr_codes'\)[\s\S]{0,400}target_url/.test(scan) && /resolveQrScanDestination\(\{[\s\S]{0,300}NEXT_PUBLIC_APP_URL[\s\S]{0,200}new URL\(req\.url\)\.origin/.test(scan))
    check("redirects ONLY to destination.path (resolved against the request URL — never a foreign host) with no-store",
      /NextResponse\.redirect\(redirectTo/.test(scan) && /new URL\(destination\.path, req\.url\)/.test(scan) && /cache-control': 'no-store'/.test(scan) && !REQUEST_CHOSEN_REDIRECT_RE.test(scan))
    check("CONTROL: a specimen `redirect(searchParams.get(\"to\"))` is caught as request-chosen", REQUEST_CHOSEN_REDIRECT_RE.test(stripComments(`return NextResponse.redirect(searchParams.get("to") ?? "/")`)))
    check("tenant comes from the row the slug resolved — the request names no brokerage",
      !/searchParams\.get\(['"]brokerage/.test(scan) && /brokerage_id: qr\.brokerage_id/.test(scan))
    check("attribution + analytics survive: qr_scan_events row, direct-mail response (campaign codes), QR_SCAN_RECEIVED with the routing verdict",
      /from\('qr_scan_events'\)[\s\S]{0,100}\.insert\(/.test(scan) && /from\('direct_mail_responses'\)/.test(scan) && /KernelEvent\.QR_SCAN_RECEIVED/.test(scan) && /routed:\s*destination\.kind/.test(scan) && /routed_reason:\s*destination\.reason/.test(scan))
    check("paused / expired codes are refused out loud with a mobile viewport (the refusal page)", /meta name="viewport" content="width=device-width, initial-scale=1"/.test(src(SCAN_ROUTE)) && /status: 403|403,/.test(scan) && /410/.test(scan))
  }

  console.log("\n[4 · THE CAPTURE DOOR — id + slug agree, tenant from the row, one identity layer]")
  {
    const submit = stripped(SUBMIT_ROUTE)
    check("the qr_codes lookup predicates BOTH id and slug (a mismatched pair is not found)", /from\('qr_codes'\)[\s\S]{0,400}\.eq\('id', qrCodeId\)[\s\S]{0,40}\.eq\('slug', slug\)/.test(submit))
    check("tenant from the row: captureContact gets qr.brokerage_id, never a body value; rate-limited; source qr_scan",
      /captureContact\(\{[\s\S]{0,80}brokerageId: qr\.brokerage_id/.test(submit) && !/body\.brokerageId|brokerageId: body/.test(submit) && /checkPublicRateLimit\(/.test(submit) && /source: 'qr_scan'/.test(submit))
    check("CONTROL: a specimen that captures under body.brokerageId is caught", /body\.brokerageId|brokerageId: body/.test(stripComments(`await captureContact({ brokerageId: body.brokerageId })`)))
    check("the touchpoint and the contact-captured event carry the code (attribution → outcome)", /recordCampaignTouchpointSafe\(/.test(submit) && /KernelEvent\.CONTACT_CAPTURED/.test(submit))
  }

  console.log("\n[5 · MOBILE — the landing renders and works at phone widths]")
  {
    const mod = await import("../app/qr/[slug]/QRLandingClient")
    const Landing = mod.default as unknown as React.ComponentType<Record<string, unknown>>
    const base = { slug: "s-1", qrCodeId: "q-1", label: "123 Main St Open House", purpose: "open_house", agentName: "Jane Doe", agentPhoto: null, listingAddress: "123 Main St" }
    const html = renderToStaticMarkup(React.createElement(Landing, { ...base, continueTo: null }))
    check("renders: the capture form with first/last/email/phone, the consent checkbox and the submit button",
      /name="first_name"/.test(html) && /name="last_name"/.test(html) && /type="email"/.test(html) && /type="tel"/.test(html) && /name="tcpa_checked"/.test(html) && /Get in Touch/.test(html))
    check("every input is 16 px (text-base — no iOS focus zoom) with a 44 px minimum height; the submit is ≥ 44 px",
      (html.match(/<input[^>]*type="(text|email|tel)"[^>]*>/g) ?? []).every((tag) => /text-base/.test(tag) && /min-h-\[44px\]/.test(tag)) && /<button[^>]*min-h-\[44px\][^>]*type="submit"|<button[^>]*type="submit"[^>]*min-h-\[44px\]/.test(html))
    const ext = renderToStaticMarkup(React.createElement(Landing, { ...base, continueTo: { href: "https://video.example/tour", label: "Watch the video tour (video.example)", external: true } }))
    check("an external https offer renders as a tap-through link with rel=\"noopener noreferrer\", never auto-followed", /<a href="https:\/\/video\.example\/tour"[^>]*target="_blank"[^>]*rel="noopener noreferrer"|<a href="https:\/\/video\.example\/tour"[^>]*rel="noopener noreferrer"[^>]*target="_blank"/.test(ext) && !/http-equiv="refresh"|window\.location/.test(ext))
    const inApp = renderToStaticMarkup(React.createElement(Landing, { ...base, continueTo: { href: "/listings/L1?qr=s-1", label: "View the listing", external: false } }))
    check("an in-app offer renders as a same-tab link", /<a href="\/listings\/L1\?qr=s-1"[^>]*>View the listing<\/a>/.test(inApp) && !/<a href="\/listings\/L1\?qr=s-1"[^>]*target="_blank"/.test(inApp))
    const fixed = [LANDING_CLIENT, LANDING_PAGE].flatMap((f) => [...stripped(f).matchAll(/\bw-\[(\d+)px\]/g)].map((m) => Number(m[1])))
    check("no fixed width wider than a phone (every w-[Npx] ≤ 430) — the layout is fluid (w-full max-w-md, 16 px gutters)", fixed.every((n) => n <= 430) && /w-full max-w-md/.test(stripped(LANDING_CLIENT)) && /px-4/.test(stripped(LANDING_CLIENT)))
    check("the root layout exports a viewport (width=device-width is what makes 360–430 px real)", /export const viewport/.test(stripped("app/layout.tsx")))
    check("the landing page offers the code's destination through the SAME resolver as the scan door (two doors, one decision)", /resolveQrScanDestination\(/.test(stripped(LANDING_PAGE)) && /continueTo=\{continueTo\}/.test(stripped(LANDING_PAGE)) && !/searchParams/.test(stripped(LANDING_PAGE)))
  }

  console.log("\n[6 · NO DANGLING DEFAULT — one destination table, every path allow-listed]")
  {
    const combos: Array<{ destinationType: string; listingId?: string | null; agentSlug?: string | null }> = []
    for (const t of ["landing_page", "cma_form", "book_meeting", "listing_detail", "video_avatar_tour", "podcast_episode", "anniversary_video", "other"])
      for (const listingId of [null, "L1"]) for (const agentSlug of [null, "jane-doe"]) combos.push({ destinationType: t, listingId, agentSlug })
    const results = combos.map((c) => ({ c, p: qrInAppDefaultPath(c) }))
    check("qrInAppDefaultPath yields only allow-listed in-app paths or null (external types have no default; landing_page is the minter's own)",
      results.every(({ p }) => p === null || isQrInAppPublicPath(p)) && results.filter(({ p }) => p !== null).length >= 4
      && qrInAppDefaultPath({ destinationType: "listing_detail", listingId: "L1" }) === "/listings/L1"
      && qrInAppDefaultPath({ destinationType: "cma_form", agentSlug: "jane-doe" }) === "/home-value/jane-doe"
      && qrInAppDefaultPath({ destinationType: "book_meeting", agentSlug: "jane-doe" }) === "/p/jane-doe"
      && qrInAppDefaultPath({ destinationType: "book_meeting" }) === null && qrInAppDefaultPath({ destinationType: "landing_page" }) === null
      && qrInAppDefaultPath({ destinationType: "video_avatar_tour" }) === null)
    const SEG_RE = /\$\{origin\}\/([a-z][a-z-]*)/g
    const offenders: string[] = []
    for (const f of [ADMIN_ROUTE, MARKETING_QR]) for (const m of stripped(f).matchAll(SEG_RE)) if (!isQrInAppPublicPath(`/${m[1]}/`)) offenders.push(`${f}: /${m[1]}`)
    check("the admin mint route and the marketing minter name no `${origin}/<segment>` outside the allow-list", offenders.length === 0, offenders.join(", "))
    check("CONTROL: a specimen `${origin}/book?qr=` is caught", [...stripComments("const u = `${origin}/book?qr=${slug}`").matchAll(SEG_RE)].some((m) => !isQrInAppPublicPath(`/${m[1]}/`)))
    const helpPaths = [...src(BOARD_CLIENT).matchAll(/help:\s*'[^']*?\sat \/([a-z][a-z-]*)/g)].map((m) => m[1])
    check("the board's destination help text names only routes that exist", helpPaths.length >= 3 && helpPaths.every((seg) => isQrInAppPublicPath(`/${seg}/`)), helpPaths.join(", "))
    check("the admin route routes defaults through the one table (and keeps the session tenant + claimed-tenant rule)", /qrInAppDefaultPath\(/.test(stripped(ADMIN_ROUTE)) && /decideClaimedTenant\(/.test(stripped(ADMIN_ROUTE)) && /brokerageId: ctx\.brokerageId/.test(stripped(ADMIN_ROUTE)))
  }

  console.log("\n[7 · BUSINESS-CARD SCANNER — confidence, confirmation, dedup, field-level merge, cost]")
  {
    const perField = parseCardExtraction({ first_name: { value: " Jane ", confidence: 0.95 }, last_name: { value: "Doe", confidence: 1.4 }, email: { value: "Jane@Example.COM", confidence: 0.4 }, phone: { value: "+1 (555) 010-2000", confidence: "0.9" }, company: { value: "", confidence: 0.9 } })
    check("parse (per-field shape): values normalised (trim, email lower-cased, phone digits-only), confidence clamped to 0..1, empty value → null confidence",
      perField.fields.first_name === "Jane" && perField.confidence.last_name === 1 && perField.fields.email === "jane@example.com" && perField.confidence.email === 0.4 && perField.fields.phone === "5550102000" && perField.confidence.phone === 0.9 && perField.confidence.company === null)
    const flat = parseCardExtraction({ first_name: "Jane", last_name: "Doe", email: "jane@example.com" })
    check("parse (legacy flat shape): values kept, confidence UNSTATED (null) — never promoted to sure", flat.fields.first_name === "Jane" && flat.confidence.first_name === null && flat.confidence.email === null)
    check("parse (junk): a non-object reads as an empty card", CARD_FIELDS.every((f) => parseCardExtraction("nope").fields[f] === "" && parseCardExtraction(null).confidence[f] === null))
    const sure = parseCardExtraction({ first_name: { value: "Jane", confidence: 0.98 }, last_name: { value: "Doe", confidence: 0.97 }, email: { value: "jane@example.com", confidence: 0.93 }, company: { value: "Acme", confidence: 0.6 } })
    const sureA = assessCardExtraction(sure)
    check("assess: a confident identity → viable, NO confirmation needed (a doubtful non-identity field does not hold the scan)", sureA.viable && !sureA.needsConfirmation && sureA.lowFields.join() === "company" && sureA.overall > 0.8)
    const doubt = assessCardExtraction(perField)
    check("assess: a doubtful identity field (email 0.4) → viable AND needs confirmation; low fields named identity-first", doubt.viable && doubt.needsConfirmation && doubt.lowFields[0] === "email")
    check("assess: an unstated confidence (flat shape) is below the floor → needs confirmation", assessCardExtraction(flat).needsConfirmation)
    check("assess: no contact method → not viable (and not 'needs confirmation')", (() => { const a = assessCardExtraction(parseCardExtraction({ first_name: { value: "Jane", confidence: 0.99 }, company: { value: "Acme", confidence: 0.99 } })); return !a.viable && !a.needsConfirmation })())
    check("confident-fields gate: only readings at/above the floor reach a structured column; the rest ride ONE notes line",
      (() => { const c = confidentCardFields(perField); return c.first_name === "Jane" && c.phone === "5550102000" && !("email" in c) && /email: jane@example\.com \(40%\)/.test(unconfirmedCardNote(perField)) && unconfirmedCardNote(sure).includes("company") })())
    check(`the floor is ${CARD_FIELD_CONFIDENCE_FLOOR} and a human confirmation is 1.0 everywhere it typed something`, CARD_FIELD_CONFIDENCE_FLOOR === 0.75 && humanConfirmedExtraction({ first_name: "Jane", email: "" }).confidence.first_name === 1 && humanConfirmedExtraction({ first_name: "Jane" }).confidence.email === null)

    const vision = (c: number) => ({ source: CARD_PROVENANCE_SOURCE_VISION, matchConfidence: String(c) })
    const d = (p: Parameters<typeof decideCardFieldWrite>[0]) => decideCardFieldWrite(p).reason
    check("MERGE RULE — fill an empty column (fill_empty); keep the same value (same_value); keep when incoming is empty",
      d({ field: "email", existingValue: null, existingStamp: null, incomingValue: "a@b.c", incomingConfidence: 0.9, incomingHuman: false }) === "fill_empty"
      && d({ field: "email", existingValue: "A@B.C", existingStamp: vision(0.5), incomingValue: "a@b.c", incomingConfidence: 0.9, incomingHuman: false }) === "same_value"
      && d({ field: "email", existingValue: "a@b.c", existingStamp: null, incomingValue: "", incomingConfidence: 1, incomingHuman: false }) === "no_incoming")
    check("MERGE RULE — a weak reading never overwrites: below the floor (below_floor), not higher than the existing reading (not_higher_confidence), unknown provenance (unknown_provenance)",
      d({ field: "phone", existingValue: "5550000000", existingStamp: vision(0.6), incomingValue: "5551111111", incomingConfidence: 0.7, incomingHuman: false }) === "below_floor"
      && d({ field: "phone", existingValue: "5550000000", existingStamp: vision(0.9), incomingValue: "5551111111", incomingConfidence: 0.8, incomingHuman: false }) === "not_higher_confidence"
      && d({ field: "phone", existingValue: "5550000000", existingStamp: null, incomingValue: "5551111111", incomingConfidence: 0.99, incomingHuman: false }) === "unknown_provenance")
    check("MERGE RULE — a strictly higher-confidence reading replaces an earlier card reading (higher_confidence); a human beats any card reading or unknown provenance (human_over_card)",
      d({ field: "phone", existingValue: "5550000000", existingStamp: vision(0.8), incomingValue: "5551111111", incomingConfidence: 0.95, incomingHuman: false }) === "higher_confidence"
      && d({ field: "phone", existingValue: "5550000000", existingStamp: vision(0.99), incomingValue: "5551111111", incomingConfidence: null, incomingHuman: true }) === "human_over_card"
      && d({ field: "phone", existingValue: "5550000000", existingStamp: null, incomingValue: "5551111111", incomingConfidence: null, incomingHuman: true }) === "human_over_card")
    check("MERGE RULE — a provider match, a staff edit or the contact's own entry is NEVER overwritten by a card, not even a human confirmation of one (stronger_provenance)",
      ["peopledata", "staff", "contact", "versium"].every((s) => d({ field: "email", existingValue: "real@x.y", existingStamp: { source: s, matchConfidence: "individual" }, incomingValue: "card@x.y", incomingConfidence: 1, incomingHuman: true }) === "stronger_provenance"))
    check("CONTROL (negative): the rule DOES write when it should — the same provider-stamped column with an EMPTY existing value fills", decideCardFieldWrite({ field: "email", existingValue: "", existingStamp: { source: "peopledata", matchConfidence: "individual" }, incomingValue: "card@x.y", incomingConfidence: 0.9, incomingHuman: false }).write)
    const contactRow = { first_name: "Jane", last_name: "Smith", email: "jane@example.com", phone: "(555) 010-2000", address: null }
    const stamps = cardStampsForContact(perField, contactRow, { email: { source: "peopledata" } }, { human: false, actor: null })
    check("provenance by VALUE EQUALITY: stamped only where the contact holds the card's reading and no stamp exists (first_name + phone), never over a provider stamp (email), never a differing value (last_name)",
      Object.keys(stamps).sort().join() === "first_name,phone" && stamps.first_name.source === CARD_PROVENANCE_SOURCE_VISION && stamps.first_name.purpose === "acquisition" && stamps.first_name.matchConfidence === "0.95" && stamps.phone.actor === null)
    const humanStamps = cardStampsForContact(humanConfirmedExtraction({ first_name: "Jane" }), contactRow, {}, { human: true, actor: "user-1" })
    check("a human confirmation stamps staff_edit with the actor and confidence 1", humanStamps.first_name?.source === CARD_PROVENANCE_SOURCE_HUMAN && humanStamps.first_name?.purpose === "staff_edit" && humanStamps.first_name?.actor === "user-1" && humanStamps.first_name?.matchConfidence === "1")
    check("normalizeCardValue: phone keeps the last ten digits, email lower-cases, text collapses whitespace", normalizeCardValue("phone", "+1 555-010-2000") === "5550102000" && normalizeCardValue("email", " A@B.C ") === "a@b.c" && normalizeCardValue("company", "Acme   Inc") === "Acme Inc")

    const actions = stripped(CARD_ACTIONS)
    const upload = actions.slice(actions.indexOf("export async function uploadBusinessCard"), actions.indexOf("async function routeClassifiedCard"))
    check("source: uploadBusinessCard gates the paid vision call with mayUseAndAfford BEFORE gatewayChat (fail closed)", upload.indexOf("mayUseAndAfford(") > 0 && upload.indexOf("mayUseAndAfford(") < upload.indexOf("gatewayChat(") && /if \(!gate\.allowed\)[\s\S]{0,80}throw/.test(upload))
    check("source: the vision call's cost is BOOKED (logAIUsage, feature business_card_vision, manager data_steward) using the gateway's usage when reported and an estimate — labelled — otherwise",
      /logAIUsage\(\{[\s\S]{0,600}feature: "business_card_vision"[\s\S]{0,200}manager: "data_steward"/.test(upload) && /response\.usage\?\.inputTokens \?\? estPromptTokens/.test(upload) && /token_basis/.test(upload))
    check("source: the gateway returns its usage (lib/ai/gateway-chat.ts) — the booked number is the provider's, not a guess", /usage: \{ inputTokens: number; outputTokens: number \} \| null/.test(stripped(GATEWAY)) && /prompt_tokens/.test(stripped(GATEWAY)))
    check("source: the reader is asked for PER-FIELD confidence and the row stores it; a doubtful identity holds the scan as 'pending' (live CHECK) with no routing",
      /confidence\\?": number/.test(src(CARD_ACTIONS)) && /field_confidence: extraction\.confidence/.test(upload) && /needsConfirmation \? "pending" : "approved"/.test(upload) && /if \(needsConfirmation\) \{[\s\S]{0,3000}return \{ \.\.\.base, contactId: null[^\n]*needsConfirmation: true/.test(upload))
    check("source: ONE vision path (gatewayChat), no second OCR system (no tesseract / vision SDK / other OCR import)", /gatewayChat\(/.test(upload) && !/tesseract|@google-cloud\/vision|textract|ocr-space|rekognition/i.test(actions))
    const confirm = actions.slice(actions.indexOf("export async function confirmBusinessCardScan"), actions.indexOf("export async function getRecentScans"))
    check("source: confirmBusinessCardScan exists — session tenant (scan read under .eq(\"brokerage_id\", brokerageId)), ledgered (withActionLedger business_card.scan.confirm, HUMAN_REQUESTED), applies decideCardFieldWrite per column, COUNTS the rows its updates matched",
      confirm.length > 200 && /\.eq\("brokerage_id", brokerageId\)/.test(confirm) && /withActionLedger/.test(confirm) && /action: "business_card\.scan\.confirm"/.test(confirm) && /reasonCode: "HUMAN_REQUESTED"/.test(confirm) && /decideCardFieldWrite\(\{/.test(confirm) && /updated\.length !== 1/.test(confirm) && /approved\.length !== 1/.test(confirm))
    check("source: the confirmed scan stamps reviewed_by (the human) + reviewed_at; a confirmed HELD scan is routed through the SAME routing body as a confident scan", /reviewed_by: auth\.userId/.test(confirm) && /routeClassifiedCard\(\{/.test(confirm) && /human: true/.test(confirm))
    check("source: exactly ONE captureContact call site (the identity/dedup layer), source business_card, only confident readings reach its columns",
      (actions.match(/\bcaptureContact\s*\(/g) ?? []).length === 1 && /source: "business_card"/.test(actions) && /first_name: confident\.first_name \?\? null/.test(actions) && /stampCardProvenance\(supabase, \{ brokerageId, contactId, extraction/.test(actions))
    check("source: the BUSINESS_CARD_APPROVED emits carry human_confirmed (evidence of who decided)", (actions.match(/human_confirmed: args\.human/g) ?? []).length >= 4)
    const page = stripped(CARD_PAGE)
    check("surface: 'Report extraction error' is WIRED to the correction form (confirmBusinessCardScan), not a toast that flags nothing",
      /confirmBusinessCardScan\(/.test(page) && !/toast\(\{ title: "Feedback received"/.test(page) && /Report extraction error/.test(page) && /setConfirmTarget\(\{ scanId: result\.scanId/.test(page))
    check("surface: a held scan opens the confirmation form at once and shows per-field confidence with the doubtful fields marked", /if \(res\.needsConfirmation\)[\s\S]{0,200}setConfirmTarget/.test(page) && /CARD_FIELD_CONFIDENCE_FLOOR/.test(page) && /please check/.test(page))
    check("surface: the history offers 'Needs your confirmation — confirm' on a pending row; the status line never implies a reviewer that did not exist", /review_status === "pending"/.test(page) && /Needs your confirmation/.test(page) && /confirmed by a person/.test(page) && /not reviewed by a person/.test(page))
    // The ownership ledger's prose (lib/kernel/manager-registry.ts) DOCUMENTS this very rule by
    // name ("BARCODE (1D) is claimed nowhere") — documentation, excluded by name, never by pattern
    // (the same exclusion scripts/qr-registry-guard.ts applies to it).
    const PROSE = new Set(["lib/kernel/manager-registry.ts"])
    const claimFiles = ["lib", "app", "docs", "components"].flatMap((d) => walk(join(root, d))).filter((f) => !f.includes("/scripts/") && !PROSE.has(rel(f)))
    const barcodeClaims = claimFiles.filter((f) => /\bbar-?codes?\b|code ?128|ean-?13/i.test(stripped(f))).map(rel)
    console.log(`    barcode (1D) claims scanned across ${claimFiles.length} product files`)
    check("BARCODE (1D) is claimed nowhere in product code — the OS encodes QR (2D) only, and says so", barcodeClaims.length === 0, barcodeClaims.join(", "))
    check("CONTROL: the barcode finder recognises a claim", /\bbar-?codes?\b|code ?128|ean-?13/i.test("Scan the barcode on the flyer"))
  }

  console.log("\n[8 · registration]")
  {
    const pkg = JSON.parse(src("package.json")) as { scripts: Record<string, string> }
    check("package.json registers test:qr-and-card-scanner and the guard chain runs it (membership, not a position)",
      typeof pkg.scripts["test:qr-and-card-scanner"] === "string" && new RegExp("npm run test:qr-and-card-scanner(\\s|&|$)").test(pkg.scripts.guard))
    const dom = (MAINTENANCE_DOMAINS as Record<string, { manager: string; proof: string; coOwners?: string[]; what: string }>).qr_and_card_scanner
    check("MAINTENANCE_DOMAINS.qr_and_card_scanner names a manager, this proof, and co-owners named in its prose", !!dom && dom.proof === "test:qr-and-card-scanner" && Array.isArray(dom.coOwners) && dom.coOwners.length >= 1 && dom.coOwners.every((c) => dom.what.includes(c)))
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(` blind spots: the encoder sweep recognises QRCode.toDataURL/toCanvas tokens only (a hand-rolled encoder or a renderer re-bound under another name is not seen — scripts/qr-registry-guard.ts holds the registry side); the open-redirect scanner judges a redirect() whose ARGUMENT text names the request (a target laundered through a variable assigned from searchParams is not seen); the landing is rendered under react-dom/server (layout at 360–430 px is argued from the fluid classes and the ≤ 430 px fixed-width rule, not from a browser); the card rules run on fixtures — the live vision model's calibration is not measured here, and the image-token estimate is used only when the gateway reports no usage; barcode claims are searched by word in lib/app/docs/components (a claim in marketing copy outside the repo is out of reach).`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ QR_AND_CARD_SCANNER_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
