#!/usr/bin/env tsx
/**
 * scripts/estimate-comparison-guard.ts   (npm run test:estimate-comparison)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 82, LANE 82D — owner verbatim:
 *   (a) "taking the estimates on every real estate page that we retired as
 *       screenshots, merging to show each value on those pages listing the
 *       property page (on realtorcom, on homes.com....) for a marketing piece
 *       like..finding out what your home is worth in todays market can make
 *       you feel overwhelmed when comparing all of these sites...we can help"
 *   (b) "the zillow zestimate screenshot should only be used for campaigns and
 *       not other estimate of value."
 * plus the two 81D open items it touches (printed postcards carry a tracked
 * QR; qr-asset-linker's placement union = the live CHECK).
 *
 * Asserts the RULE (never a waypoint), each absence with a positive control:
 *   1. VOCABULARY — four comparison sources (Zillow + the three restored),
 *      each host admitted by the seam, each mustShow covered by the host's
 *      readiness rule; Zillow alone may appear as a picture (the others are
 *      figure_only — their terms bar reproducing their pages); the campaign
 *      vocabulary stays Zillow alone.
 *   2. THE ONE USE RULE — estimateStillUseVerdict: comparison-only sources
 *      admit ONLY estimate_comparison; the Zestimate admits campaign uses;
 *      every estimate-of-value use is refused for every source.
 *   3. SEAM SCOPE — a comparison host is refused without
 *      hostScope:"estimate_comparison", admitted with it, owner required,
 *      readiness fail-closed, and the row it writes carries NO campaign use.
 *      setScreenshotUses cannot widen a comparison still (stubbed DB).
 *   4. COMPOSER — only approved + human-confirmed figures make cards; <2 is
 *      refused; spread/high/low derived; every format's SVG carries each
 *      label + figure, the spread, the CTA and the disclaimer, no portal
 *      pixels or logo hosts; copy clean against the shipped fair-housing
 *      catalogue (m450) and never promises a number.
 *   5. NO VALUE SURFACE READS A STILL — a sweep of every live file whose path
 *      names a value surface (cma / valuation / home-value / appraisal /
 *      net-sheet / price) finds no still reader; the image library filters
 *      through the verdict.
 *   6. SURFACES — the playbook, the install rail, the tenant actions (gated),
 *      the card (mounted).
 *   7. 81D OPEN ITEMS — the approved-campaign drain and the CRM bundle send
 *      mint through mintTrackedQr and pass its scanUrl as qrScanUrl; the
 *      placement union equals the live CHECK cache.
 *
 * No network, no browser, no DB (counting stubs).
 * Run: npx tsx --conditions=react-server scripts/estimate-comparison-guard.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, dirname, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments, blankStrings } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import {
  ESTIMATE_SOURCES, COMPARISON_ESTIMATE_SOURCES, COMPARISON_ESTIMATE_SOURCE_KEYS, ESTIMATE_OF_VALUE_USES, ESTIMATE_COMPARISON_USE, IMAGE_LIBRARY_USE,
  estimateStillUseVerdict,
} from "../lib/marketing/estimate-sources"
import {
  PUBLIC_PAGE_HOSTS, COMPARISON_ONLY_PAGE_HOSTS, readyRulesForHost, planScreenshotCapture, captureScreenshot, capturePublicPropertyPage,
  usesOfRow, setScreenshotUses, SCREENSHOT_USES, type ScreenshotProvider, type ProviderCaptureInput,
} from "../lib/assets/screenshot-capture"
import {
  composeEstimateComparison, planComparisonCards, comparisonCopy, validateConfirmedFigure, COMPARISON_HOOKS, COMPARISON_SUBHEAD, COMPARISON_CTAS,
  COMPARISON_SOCIAL_CAPTION, COMPARISON_EMAIL_SUBJECT, COMPARISON_VIDEO_BEATS, COMPARISON_FORMATS, MIN_COMPARISON_CARDS, type ComparisonEvidence,
} from "../lib/marketing/estimate-comparison"
import { getPlaybook } from "../lib/marketing/creative-playbooks"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(root, p), "utf8")
const stripped = (p: string) => stripComments(src(p))
const TENANT = "22222222-2222-4222-8222-222222222222"

process.env.NEXT_PUBLIC_APP_URL = "https://os.example.test"
delete process.env.VERCEL; delete process.env.AWS_LAMBDA_FUNCTION_NAME; delete process.env.SCREENSHOT_PROVIDER

// ── Stubs ────────────────────────────────────────────────────────────────────
function providerConfirming(labels: (input: ProviderCaptureInput) => string[] | undefined): ScreenshotProvider & { calls: ProviderCaptureInput[] } {
  const calls: ProviderCaptureInput[] = []
  return { name: "puppeteer", calls, async capture(input) { calls.push(input); const s = labels(input); return s ? { png: Buffer.from("png"), satisfied: s } : { png: Buffer.from("png") } } }
}
function makeSvc(opts: { readRow?: Record<string, unknown> | null } = {}) {
  const calls: string[] = []
  const inserted: Array<Record<string, unknown>> = []
  const updates: Array<Record<string, unknown>> = []
  const chain = () => {
    const q: any = {}
    for (const m of ["select", "eq", "is", "lt", "in", "order", "not", "or", "gte", "neq"]) q[m] = () => q
    q.limit = () => q
    q.insert = (row: Record<string, unknown>) => { inserted.push(row); return q }
    q.update = (row: Record<string, unknown>) => { updates.push(row); return q }
    q.maybeSingle = async () => ({ data: null, error: null })
    q.single = async () => ({ data: { id: "row-new" }, error: null })
    q.then = (res: any, rej: any) => Promise.resolve({ data: opts.readRow ? [opts.readRow] : [], error: null }).then(res, rej)
    return q
  }
  return {
    calls, inserted, updates,
    from: (t: string) => { calls.push(`from:${t}`); return chain() },
    storage: { from: (b: string) => ({
      upload: async (p: string) => { calls.push(`upload:${b}/${p}`); return { error: null } },
      getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.example.test/${b}/${p}` } }),
    }) },
  }
}
const robotsAllow = async () => "User-agent: *\nAllow: /"
const REDFIN = "https://www.redfin.com/TX/Austin/123-Main-St-78701/home/1"
const ZILLOW = "https://www.zillow.com/homedetails/123-Main-St-Austin-TX-78701/1_zpid/"

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p)
  }
  return out
}

async function main() {
  console.log("\n[1 · vocabulary — four comparison sources, Zillow alone for campaigns]")
  check("COMPARISON_ESTIMATE_SOURCE_KEYS = zillow + realtor + redfin + homes; ESTIMATE_SOURCES (campaign) stays Zillow alone",
    COMPARISON_ESTIMATE_SOURCE_KEYS.join(",") === "zillow_zestimate,realtor_estimate,redfin_estimate,homes_estimate" && ESTIMATE_SOURCES.length === 1 && ESTIMATE_SOURCES[0].key === "zillow_zestimate")
  const admittedHosts = [...PUBLIC_PAGE_HOSTS, ...COMPARISON_ONLY_PAGE_HOSTS] as readonly string[]
  check("every comparison host is admitted by the seam (campaign hosts ∪ COMPARISON_ONLY_PAGE_HOSTS) and every mustShow label is covered by that host's readiness rule",
    COMPARISON_ESTIMATE_SOURCES.every((s) => admittedHosts.includes(s.host) && s.mustShow.every((l) => readyRulesForHost(s.host).some((r) => r.label === l))))
  check("PUBLIC_PAGE_HOSTS is still zillow.com alone; the comparison-only hosts are exactly the three restored portals",
    PUBLIC_PAGE_HOSTS.join() === "zillow.com" && [...COMPARISON_ONLY_PAGE_HOSTS].sort().join() === "homes.com,realtor.com,redfin.com")
  check("ONLY the Zillow still may appear as a picture (still_with_attribution); the three portals are figure_only (their terms bar reproducing their pages)",
    COMPARISON_ESTIMATE_SOURCES.filter((s) => s.posture === "still_with_attribution").map((s) => s.key).join() === "zillow_zestimate"
    && COMPARISON_ESTIMATE_SOURCES.filter((s) => s.key !== "zillow_zestimate").every((s) => s.posture === "figure_only" && /no screenshot, no logo/.test(s.tosNote)))
  check("card labels are plain nominative text (no ®/™ glyph, no 'logo' word on the card)", COMPARISON_ESTIMATE_SOURCES.every((s) => !/[®™]|logo/i.test(s.cardLabel)))

  console.log("\n[2 · the ONE use rule — campaigns yes, estimate of value never]")
  const others = COMPARISON_ESTIMATE_SOURCES.filter((s) => s.key !== "zillow_zestimate").map((s) => s.key)
  check("a comparison-only source admits estimate_comparison and NOTHING else (every campaign use, the image library, every value use refused)",
    others.every((k) => estimateStillUseVerdict(k, ESTIMATE_COMPARISON_USE, SCREENSHOT_USES).ok
      && [...SCREENSHOT_USES, IMAGE_LIBRARY_USE, ...ESTIMATE_OF_VALUE_USES].every((u) => !estimateStillUseVerdict(k, u, SCREENSHOT_USES).ok)))
  check("the Zestimate admits every campaign use + the library + the comparison, and refuses every estimate-of-value use",
    [...SCREENSHOT_USES, IMAGE_LIBRARY_USE, ESTIMATE_COMPARISON_USE].every((u) => estimateStillUseVerdict("zillow_zestimate", u, SCREENSHOT_USES).ok)
    && ESTIMATE_OF_VALUE_USES.every((u) => !estimateStillUseVerdict("zillow_zestimate", u, SCREENSHOT_USES).ok))
  check("CONTROL: an unknown source is refused for every use; the value-use list names CMA and valuation", !estimateStillUseVerdict("trulia_estimate", ESTIMATE_COMPARISON_USE, SCREENSHOT_USES).ok && !estimateStillUseVerdict(null, "marketing_campaign", SCREENSHOT_USES).ok && (ESTIMATE_OF_VALUE_USES as readonly string[]).includes("cma") && (ESTIMATE_OF_VALUE_USES as readonly string[]).includes("valuation"))

  console.log("\n[3 · seam scope — comparison hosts only for the comparison piece]")
  const plain = planScreenshotCapture({ kind: "public_page", url: REDFIN }, { siteOrigin: "" })
  const scoped = planScreenshotCapture({ kind: "public_page", url: REDFIN, hostScope: "estimate_comparison" }, { siteOrigin: "" })
  const zScoped = planScreenshotCapture({ kind: "public_page", url: ZILLOW, hostScope: "estimate_comparison" }, { siteOrigin: "" })
  check("a comparison host WITHOUT the scope is refused (and the refusal says why); WITH it the plan is comparisonOnly with photo + estimate readiness",
    !plain.ok && /only for the estimate comparison piece/.test(plain.reason) && scoped.ok && scoped.comparisonOnly === true && scoped.readyWhen.map((r) => r.label).join("+") === "property_photo+estimate")
  check("Zillow under the comparison scope is NOT comparison-only (a Zestimate still is campaign material)", zScoped.ok && zScoped.comparisonOnly === false)
  {
    const provider = providerConfirming((i) => i.readyWhen.map((r) => r.label)); const svc = makeSvc()
    const r = await captureScreenshot({ kind: "public_page", url: REDFIN, hostScope: "estimate_comparison" }, { svc, provider, fetchRobots: robotsAllow })
    check("a comparison capture with NO owner is refused before the browser (never platform library stock)", !r.ok && /owner required/.test(r.reason) && provider.calls.length === 0 && svc.inserted.length === 0)
  }
  {
    const provider = providerConfirming(() => ["property_photo"]); const svc = makeSvc()
    const r = await captureScreenshot({ kind: "public_page", url: REDFIN, hostScope: "estimate_comparison", dayIso: "2026-09-25", owner: { brokerageId: TENANT, createdBy: null, uses: [] } }, { svc, provider, fetchRobots: robotsAllow })
    check("readiness fails closed: the photo without the portal's estimate → refused naming `estimate`, nothing inserted", !r.ok && /did not show estimate/.test(r.reason) && svc.inserted.length === 0)
  }
  {
    const provider = providerConfirming((i) => i.readyWhen.map((r) => r.label)); const svc = makeSvc()
    const r = await captureScreenshot({ kind: "public_page", url: REDFIN, hostScope: "estimate_comparison", dayIso: "2026-09-26", owner: { brokerageId: TENANT, createdBy: null, uses: ["marketing_campaign", "product_video"] } }, { svc, provider, fetchRobots: robotsAllow, now: new Date("2026-09-26T00:00:00Z") })
    const row = svc.inserted[0] as any
    check("a confirmed comparison capture lands PENDING, tenant-owned, comparison_only, tagged estimate_comparison — with NO campaign use even when the caller asked for some",
      r.ok && !!row && row.approval_status === "pending" && row.brokerage_id === TENANT && row.metadata?.comparison_only === true && Array.isArray(row.metadata?.uses) && row.metadata.uses.length === 0 && (row.tags as string[]).includes("estimate_comparison") && !(row.tags as string[]).some((t) => t.startsWith("use:")))
    check("usesOfRow(that row) is EMPTY — no campaign/video/demo/training picker ever lists it", !!row && usesOfRow(row).length === 0)
  }
  {
    const provider = providerConfirming((i) => i.readyWhen.map((r) => r.label)); const svc = makeSvc()
    const off = await capturePublicPropertyPage("123 Main St Austin TX", { svc, provider, fetchRobots: robotsAllow, search: async () => [{ url: REDFIN }] }, { domains: ["redfin.com"] })
    const on = await capturePublicPropertyPage("123 Main St Austin TX", { svc, provider, fetchRobots: robotsAllow, search: async () => [{ url: REDFIN }] }, { domains: ["redfin.com"], hostScope: "estimate_comparison", request: { owner: { brokerageId: TENANT, createdBy: null, uses: [] }, dayIso: "2026-09-27" } })
    check("the search-tool entry refuses a comparison domain without the scope and captures it with the scope", !off.ok && /not on PUBLIC_PAGE_HOSTS/.test(off.reason) && on.ok && on.sourceUrl === REDFIN)
  }
  {
    const svc = makeSvc({ readRow: { id: "a1", tags: ["estimate_comparison"], metadata: { asset_kind: "screenshot", estimate_source: "redfin_estimate", comparison_only: true } } })
    const r = await setScreenshotUses(svc, "a1", ["marketing_campaign"], { brokerageId: TENANT })
    check("setScreenshotUses REFUSES widening a comparison still into a campaign use — no update issued", !r.ok && /only for the estimate comparison piece/.test(r.reason) && svc.updates.length === 0)
    const svcZ = makeSvc({ readRow: { id: "z1", tags: [], metadata: { asset_kind: "screenshot", estimate_source: "zillow_zestimate" } } })
    const rz = await setScreenshotUses(svcZ, "z1", ["marketing_campaign", "product_video"], { brokerageId: TENANT })
    check("CONTROL: the same call on a Zestimate still with campaign uses proceeds to the counted update", svcZ.updates.length === 1 && (rz.ok || /matched|refused|not found/i.test((rz as any).reason ?? "")))
  }

  console.log("\n[4 · composer — approved + confirmed figures, the spread, compliant copy]")
  const ev = (source: string, fig: number | null, status = "approved", at = "2026-09-25T12:00:00Z", url = `https://cdn.example.test/${source}.png`): ComparisonEvidence => ({ assetId: `id-${source}`, source, url, approvalStatus: status, capturedAt: at, confirmedFigureUsd: fig })
  const four = [ev("zillow_zestimate", 512300), ev("realtor_estimate", 498000), ev("redfin_estimate", 531750), ev("homes_estimate", 489900)]
  const plan = planComparisonCards(four, SCREENSHOT_USES)
  check("four approved + confirmed captures → four cards; high = Redfin 531,750, low = Homes 489,900, spread $41,850 (derived, not typed)",
    plan.ok && plan.cards.length === 4 && plan.highUsd === 531750 && plan.lowUsd === 489900 && plan.spreadUsd === 41850 && plan.spreadText === "$41,850"
    && plan.cards.find((c) => c.isHigh)?.source === "redfin_estimate" && plan.cards.find((c) => c.isLow)?.source === "homes_estimate")
  check("only the Zillow card carries a still URL; the figure_only portals print as text (stillUrl null)", plan.ok && plan.cards.filter((c) => c.stillUrl).map((c) => c.source).join() === "zillow_zestimate")
  const mixed = planComparisonCards([ev("zillow_zestimate", 512300), ev("realtor_estimate", 498000, "pending"), ev("redfin_estimate", null), ev("homes_estimate", 489900)], SCREENSHOT_USES)
  check("a PENDING capture and an UNCONFIRMED figure never make a card — each is named in `omitted` with what the human must do",
    mixed.ok && mixed.cards.length === 2 && mixed.omitted.some((o) => o.source === "realtor_estimate" && /approve it first/.test(o.reason)) && mixed.omitted.some((o) => o.source === "redfin_estimate" && /figure not confirmed/.test(o.reason)))
  const one = planComparisonCards([ev("zillow_zestimate", 512300)], SCREENSHOT_USES)
  check(`fewer than ${MIN_COMPARISON_CARDS} usable cards → refused (a comparison of one is not a comparison)`, !one.ok && /at least 2/.test(one.reason))
  check("CONTROL: validateConfirmedFigure accepts '$512,300' and refuses 500, 'abc' and 10^9", (() => { const a = validateConfirmedFigure("$512,300"); return a.ok && a.figureUsd === 512300 })() && !validateConfirmedFigure(500).ok && !validateConfirmedFigure("abc").ok && !validateConfirmedFigure(1e9).ok)
  const qr = "data:image/png;base64,QUJD"
  const creative = composeEstimateComparison(four, SCREENSHOT_USES, { brand: { name: "Acme Realty", primaryColor: "#123456", fairHousingLine: "Equal Housing Opportunity." }, qrDataUrl: qr })
  check("compose → every format (postcard 6x9, social square, story) as SVG at its own size", creative.ok && Object.keys(COMPARISON_FORMATS).every((f) => (creative as any).svgs[f]?.includes(`width="${(COMPARISON_FORMATS as any)[f].width}"`)))
  if (creative.ok) {
    const all = Object.values(creative.svgs)
    // Copy wraps across <text> lines (emitted in reading order) — join the runs before asserting phrases.
    const svgText = (svg: string) => [...svg.matchAll(/>([^<]+)</g)].map((m) => m[1]).join(" ").replace(/\s+/g, " ")
    check("each SVG carries every card label + figure, the spread line, the disclaimer (not an appraisal) and the EHO line", all.every((svg) => { const t = svgText(svg); return four.every((e) => t.includes(COMPARISON_ESTIMATE_SOURCES.find((s) => s.key === e.source)!.cardLabel) && t.includes(`$${(e.confirmedFigureUsd as number).toLocaleString("en-US")}`)) && t.includes("$41,850") && /not appraisals, and not this brokerage's opinion of value/.test(t) && t.includes("Equal Housing Opportunity") }))
    check("print carries the tracked QR image + the print CTA; social formats carry the DM CTA and no QR", creative.svgs.postcard_6x9.includes(qr) && creative.svgs.postcard_6x9.includes("Scan for a free") && !creative.svgs.social_square.includes(qr) && creative.svgs.social_square.includes("DM &quot;VALUE&quot;"))
    check("no portal pixels or logo hosts in any SVG (the only <image> is the QR data URL)", all.every((svg) => !/rdcpix|cdn-redfin|zillowstatic|homes\.com\/|logo/i.test(svg) && (svg.match(/<image /g) ?? []).length <= 1 && !/<image [^>]*href="http/.test(svg)))
    check("videoStillUrls = the Zillow still alone (the screenshot treatment never shows a figure_only portal's pixels)", creative.videoStillUrls.join() === "https://cdn.example.test/zillow_zestimate.png")
    check("the default hook counts the cards: \"4 websites. 4 different prices. Which one is right?\"", creative.copy.headline === "4 websites. 4 different prices. Which one is right?")
    check("the `spread` hook is used only when the sites disagree; a zero spread falls back to the default hook", comparisonCopy(plan as any, { hookKey: "spread" }).headline === "$41,850 apart. Same house. Same day." && (() => { const p = planComparisonCards([ev("zillow_zestimate", 500000), ev("homes_estimate", 500000)], SCREENSHOT_USES); return p.ok && comparisonCopy(p, { hookKey: "spread" }).hookKey === "four_sites" })())
  }
  // Fair-housing: the SHIPPED catalogue (m450), parsed exactly as test:fair-housing-phrase-gate does.
  const m450 = src("supabase/migrations/m450-seed-the-fair-housing-phrase-catalogue-that-has-never-had-a-row.sql")
  const valuesBlock = m450.slice(m450.indexOf("\nvalues\n"), m450.indexOf("\non conflict"))
  const phrases = [...valuesBlock.matchAll(/^\s*\('([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',/gm)].map((m) => ({ phrase: m[1], pattern: m[2] }))
  const pb = getPlaybook("estimate_comparison")
  const copyTexts = [...COMPARISON_HOOKS.map((h) => h.text), COMPARISON_SUBHEAD, ...Object.values(COMPARISON_CTAS), COMPARISON_SOCIAL_CAPTION, COMPARISON_EMAIL_SUBJECT, ...COMPARISON_VIDEO_BEATS, ...(pb?.steps.map((s) => s.brief) ?? []), pb?.strategy ?? "", pb?.whyItWorks ?? ""]
  const fhHits = copyTexts.flatMap((t) => phrases.filter((p) => { try { return new RegExp(p.pattern, "i").test(t) } catch { return false } }).map((p) => `${p.phrase} in "${t.slice(0, 40)}…"`))
  check(`every word of the piece + the play's briefs is clean against the shipped fair-housing catalogue (${phrases.length} phrases × ${copyTexts.length} texts)`, phrases.length >= 25 && fhHits.length === 0, fhHits.join("; "))
  check("CONTROL: the same catalogue flags a specimen ('perfect for families')", phrases.some((p) => { try { return new RegExp(p.pattern, "i").test("perfect for families near the park") } catch { return false } }))
  const PROMISE_RE = /\b(we('| wi)ll|i('| wi)ll)\s+(tell|give|show)\s+you\s+(what|the\s+(real\s+)?(number|value|price))|guarantee(d)?\b|instant (value|offer|number)|your home is worth \$/i
  const promises = copyTexts.filter((t) => PROMISE_RE.test(t))
  check("no copy promises a number or a value (the CTA is a review, never a figure)", promises.length === 0, promises.map((t) => t.slice(0, 60)).join(" | "))
  check("CONTROL: the promise finder catches \"We'll give you the real number\" and \"Guaranteed value\"", PROMISE_RE.test("We'll give you the real number") && PROMISE_RE.test("Guaranteed value in 24h"))
  check("every CTA names a no-obligation home-value REVIEW", Object.values(COMPARISON_CTAS).every((c) => /no-obligation home-value review/.test(c)))

  console.log("\n[5 · no value surface reads a still; the library filters through the rule]")
  const files = ["lib", "app"].flatMap((d) => walk(join(root, d)))
  const rel = (f: string) => relative(root, f)
  const VALUE_PATH_RE = /(^|[\/_-])(cma|valuation|home-value|home_value|appraisal|appraiser|net-sheet|price-advisor|avm)([\/_.-]|$)/i
  const STILL_READER_RE = /tenant-screenshot-door|estimate-comparison"|listScreenshotStillsForUse|screenshotUrlsForUse|approvedTenantStill|tenantScreenshotUrlsForVideo|listComparisonEvidence/
  const valueFiles = files.filter((f) => VALUE_PATH_RE.test(rel(f)))
  const readers = valueFiles.filter((f) => STILL_READER_RE.test(blankStrings(stripComments(readFileSync(f, "utf8"))).replace(/\s+/g, " ")) || /from\s+["']@\/lib\/marketing\/(tenant-screenshot-door|estimate-comparison)["']/.test(stripComments(readFileSync(f, "utf8"))))
  console.log(`    value surfaces swept: ${valueFiles.length} of ${files.length} live lib/app files (path names cma/valuation/home-value/appraisal/net-sheet/price-advisor/avm)`)
  check("no value surface (CMA, valuation, home-value, appraisal, net sheet, price advisor, AVM) reads a still or the comparison evidence", valueFiles.length > 0 && readers.length === 0, readers.map(rel).join(", "))
  check("CONTROL: the sweep flags a specimen CMA file importing the still door", VALUE_PATH_RE.test("lib/cma/cma-builder.ts") && /from\s+["']@\/lib\/marketing\/(tenant-screenshot-door|estimate-comparison)["']/.test(stripComments(`import { approvedTenantStill } from "@/lib/marketing/tenant-screenshot-door"`)))
  const lib = stripped("app/actions/marketing/image-library.ts")
  check("the image library admits an estimate still only through estimateStillUseVerdict(…, IMAGE_LIBRARY_USE) and drops comparison_only rows", /estimateStillUseVerdict\(src, IMAGE_LIBRARY_USE/.test(lib) && /comparison_only === true\) return false/.test(lib) && /assets: admitted\.map/.test(lib))

  console.log("\n[6 · surfaces — the play, the install rail, the doors, the card]")
  check("the `estimate_comparison` play exists with capture page, QR, postcard, social, email, video and bundle steps", !!pb && ["lead_magnet", "qr", "direct_mail_postcard", "social_post", "email", "video", "bundle"].every((k) => pb!.steps.some((s) => s.kind === k)))
  const install = stripped("app/actions/creative-playbooks.ts")
  check("the install rail composes from the APPROVED composite (never pending) and otherwise captures every source, pending", /playbook\.key === "estimate_comparison"/.test(install) && /approvedComparisonCreative\(svc, ctx\.brokerageId, address, "postcard_6x9"\)/.test(install) && /captureEstimateComparisonStills\(\{ svc, brokerageId: ctx\.brokerageId/.test(install))
  const doors = stripped("app/actions/marketing/tenant-screenshots.ts")
  const newDoors = ["captureEstimateComparisonAction", "listEstimateComparisonAction", "confirmComparisonFigureAction", "composeEstimateComparisonAction"]
  check("each of the four comparison doors is async and gates on requireTenantAdminOrSoloOwner (tenant from the SESSION) before the service client", newDoors.every((n) => {
    const i = doors.indexOf(`export async function ${n}(`); if (i < 0) return false
    const body = doors.slice(i, doors.indexOf("\nexport ", i + 10) > 0 ? doors.indexOf("\nexport ", i + 10) : undefined)
    const g = body.indexOf("requireTenantAdminOrSoloOwner()"), s = body.indexOf("createServiceClient()")
    return g > 0 && s > g && !/input\.brokerageId|params\.brokerageId/.test(body)
  }))
  const comp = stripped("lib/marketing/estimate-comparison.ts")
  check("the figure is confirmed only off an APPROVED capture, tenant-predicated, and the update is COUNTED", /approval_status !== "approved"\) return \{ ok: false, reason: "approve the capture first/.test(comp) && /\.eq\("id", args\.assetId\)\.eq\("brokerage_id", args\.brokerageId\)\.select\("id"\)/.test(comp) && /matched no row/.test(comp))
  check("the composite lands PENDING on the approval rail as campaign material, never an estimate of value", /approval_status: "pending"/.test(comp) && /campaign_material_never_an_estimate_of_value/.test(comp))
  check("the comparison card is mounted beside the Zestimate stills card", /<EstimateComparisonCard \/>/.test(stripped("app/settings/campaign-bundles/client.tsx")))

  console.log("\n[7 · 81D open items — printed postcards carry a tracked QR; one placement vocabulary]")
  const drain = stripped("lib/direct-mail/campaign-drain.ts")
  const bundle = stripped("app/actions/campaign-bundle-dispatch.ts")
  check("the approved-campaign drain reuses/mints the campaign's code through mintTrackedQr and passes its scanUrl as qrScanUrl", /mintTrackedQr\(\{ brokerageId: input\.brokerageId/.test(drain) && /qrScanUrl: printedQr\?\.scanUrl \?\? null/.test(drain) && /from\("qr_codes"\)\.select\("label"\)\.eq\("id", row\.qr_code_id\)\.eq\("brokerage_id", input\.brokerageId\)/.test(drain))
  check("the CRM bundle send mints one tenant code per bundle and passes its scanUrl", /mintTrackedQr\(\{ brokerageId, agentId: ctx\.agentId \?\? null, label: `campaign_bundle:\$\{params\.bundleId\}`/.test(bundle) && /qrScanUrl:\s*bundleQr\?\.scanUrl \?\? null/.test(bundle))
  check("CONTROL: the producer finder would fail on the pre-82D shape (no qrScanUrl passed)", !/qrScanUrl: printedQr/.test("unsubscribeToken,\n        systemSource: `campaign_drain`"))
  const linker = src("lib/marketing/qr-asset-linker.ts")
  const unionBlock = linker.slice(linker.indexOf("export type QrPlacementType ="), linker.indexOf("\n\n", linker.indexOf("export type QrPlacementType =")))
  const union = [...unionBlock.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]).sort()
  const live = [...(CHECK_VOCABULARIES.marketing_asset_qr_links?.placement_type ?? [])].sort()
  const privList = [...(linker.match(/const QR_PLACEMENT_TYPES[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort()
  check(`QrPlacementType == the live CHECK (${live.join("|")}) and the linker's runtime list matches it`, live.length > 0 && union.join() === live.join() && privList.join() === live.join(), `union=${union.join("|")} list=${privList.join("|")}`)
  check("CONTROL: a retired local value ('postcard', 'other') is not in the live CHECK", !live.includes("postcard") && !live.includes("other"))
  const linkerCode = stripComments(linker)
  check("linkQrToAsset refuses an off-vocabulary placement BEFORE any read", (() => { const i = linkerCode.indexOf("export async function linkQrToAsset("); const guard = linkerCode.indexOf("QR_PLACEMENT_TYPES as readonly string[]).includes", i); const ctx = linkerCode.indexOf("getAgentContext()", i); return i > 0 && guard > i && ctx > guard })())

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(" blind spots: no live capture (the sandbox cannot reach the portals; readiness selectors for realtor/redfin/homes are best-effort and a renamed test id REFUSES a capture — fail closed); the SVG→PNG rasterize (sharp) and hosting run only live; the value-surface sweep is PATH-based (a value computation in a file whose path names none of cma/valuation/home-value/appraisal/net-sheet/price-advisor/avm is not swept); fair-housing is checked against the m450 seed catalogue, not tenant-added phrases; the install rail and doors are asserted by stripped source, not executed.")
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ ESTIMATE_COMPARISON_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
