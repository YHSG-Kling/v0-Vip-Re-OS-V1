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
 * WAVE 83C (owner: "we should use ai to search the internet for the property
 * and what realtor.com, homes.com and redfin [show]" · "there can be more than
 * one 'estimate' type play. zestimate is marketing campaigns strictly."),
 * re-anchored — the RULE, not the 82D waypoint:
 *   1. only Zillow is a still source; the three portals are web-searched, with
 *      no seam host, readiness rule or mustShow;
 *   3. the seam screenshots no other portal in any scope (the retired 82D
 *      scope is refused; a stripped-source finder + positive control);
 *   4. an 82D screenshot of a portal never makes a card; a typed fallback does;
 *   6. every ESTIMATE_PLAY_KEYS play resolves with its install branch (positive
 *      control: a catalogue without the Zestimate Challenge fails);
 *   7. the four direct-mail senders mint + print a tracked QR (control: the
 *      pre-83C farm shape fails).
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
  PUBLIC_PAGE_HOSTS, readyRulesForHost, planScreenshotCapture, captureScreenshot, capturePublicPropertyPage,
  usesOfRow, setScreenshotUses, SCREENSHOT_USES, type ScreenshotProvider, type ProviderCaptureInput,
} from "../lib/assets/screenshot-capture"
import {
  composeEstimateComparison, planComparisonCards, comparisonCopy, validateConfirmedFigure, COMPARISON_HOOKS, COMPARISON_SUBHEAD, COMPARISON_CTAS,
  COMPARISON_SOCIAL_CAPTION, COMPARISON_EMAIL_SUBJECT, COMPARISON_VIDEO_BEATS, COMPARISON_FORMATS, MIN_COMPARISON_CARDS, type ComparisonEvidence,
} from "../lib/marketing/estimate-comparison"
import { getPlaybook, ESTIMATE_PLAY_KEYS } from "../lib/marketing/creative-playbooks"

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
  // WAVE 83C (owner: "we should use ai to search the internet for the property and what realtor.com,
  // homes.com and redfin [show]"): ONLY the still source (Zillow) is screenshotted; the three portals'
  // figures arrive by AI web search. Derived from the vocabulary's evidenceVia, never a hand list.
  const stillSources = COMPARISON_ESTIMATE_SOURCES.filter((s) => s.evidenceVia === "still")
  const webSources = COMPARISON_ESTIMATE_SOURCES.filter((s) => s.evidenceVia === "web_search")
  check("the still sources are exactly the seam's hosts (Zillow), each mustShow covered by its readiness rule",
    stillSources.map((s) => s.key).join() === "zillow_zestimate" && stillSources.every((s) => (PUBLIC_PAGE_HOSTS as readonly string[]).includes(s.host) && s.mustShow.length > 0 && s.mustShow.every((l) => readyRulesForHost(s.host).some((r) => r.label === l))))
  check("the web-searched sources are the three portals; none is a seam host, none has a readiness rule or a mustShow (no screenshot of them exists)",
    webSources.map((s) => s.host).sort().join() === "homes.com,realtor.com,redfin.com" && webSources.every((s) => !(PUBLIC_PAGE_HOSTS as readonly string[]).includes(s.host) && readyRulesForHost(s.host).length === 0 && s.mustShow.length === 0 && s.estimateNames.length > 0))
  check("PUBLIC_PAGE_HOSTS is still zillow.com alone", PUBLIC_PAGE_HOSTS.join() === "zillow.com")
  check("ONLY the Zillow still may appear as a picture (still_with_attribution); the three portals are figure_only (their terms bar reproducing their pages)",
    COMPARISON_ESTIMATE_SOURCES.filter((s) => s.posture === "still_with_attribution").map((s) => s.key).join() === "zillow_zestimate"
    && COMPARISON_ESTIMATE_SOURCES.filter((s) => s.key !== "zillow_zestimate").every((s) => s.posture === "figure_only" && /no screenshot, no logo/.test(s.tosNote) && /web search/.test(s.tosNote)))
  check("card labels are plain nominative text (no ®/™ glyph, no 'logo' word on the card)", COMPARISON_ESTIMATE_SOURCES.every((s) => !/[®™]|logo/i.test(s.cardLabel)))

  console.log("\n[2 · the ONE use rule — campaigns yes, estimate of value never]")
  const others = COMPARISON_ESTIMATE_SOURCES.filter((s) => s.key !== "zillow_zestimate").map((s) => s.key)
  check("a comparison-only source admits estimate_comparison and NOTHING else (every seam use, the image library, every value use refused)",
    others.every((k) => estimateStillUseVerdict(k, ESTIMATE_COMPARISON_USE).ok
      && [...SCREENSHOT_USES, IMAGE_LIBRARY_USE, ...ESTIMATE_OF_VALUE_USES].every((u) => !estimateStillUseVerdict(k, u).ok)))
  check("the Zestimate admits marketing_campaign + the comparison ONLY (83C) and refuses every estimate-of-value use (the full sweep + control is test:zestimate-only 2b)",
    estimateStillUseVerdict("zillow_zestimate", "marketing_campaign").ok && estimateStillUseVerdict("zillow_zestimate", ESTIMATE_COMPARISON_USE).ok
    && ["product_video", "demo", "training", IMAGE_LIBRARY_USE].every((u) => !estimateStillUseVerdict("zillow_zestimate", u).ok)
    && ESTIMATE_OF_VALUE_USES.every((u) => !estimateStillUseVerdict("zillow_zestimate", u).ok))
  check("CONTROL: an unknown source is refused for every use; the value-use list names CMA and valuation", !estimateStillUseVerdict("trulia_estimate", ESTIMATE_COMPARISON_USE).ok && !estimateStillUseVerdict(null, "marketing_campaign").ok && (ESTIMATE_OF_VALUE_USES as readonly string[]).includes("cma") && (ESTIMATE_OF_VALUE_USES as readonly string[]).includes("valuation"))

  console.log("\n[3 · the seam screenshots NO other portal (83C — the comparison scope is retired)]")
  const plain = planScreenshotCapture({ kind: "public_page", url: REDFIN }, { siteOrigin: "" })
  const legacyScope = planScreenshotCapture({ kind: "public_page", url: REDFIN, hostScope: "estimate_comparison" } as any, { siteOrigin: "" })
  check("a Redfin / Realtor.com / Homes.com page is refused by the seam — with or without the retired 82D scope", !plain.ok && !legacyScope.ok && webSources.every((s) => !planScreenshotCapture({ kind: "public_page", url: `https://www.${s.host}/x/123-main-st`, hostScope: "estimate_comparison" } as any, { siteOrigin: "" }).ok))
  {
    const provider = providerConfirming((i) => i.readyWhen.map((r) => r.label)); const svc = makeSvc()
    const r = await captureScreenshot({ kind: "public_page", url: REDFIN, hostScope: "estimate_comparison", owner: { brokerageId: TENANT, createdBy: null, uses: [] } } as any, { svc, provider, fetchRobots: robotsAllow })
    check("a tenant-owned capture of a portal page is refused before the browser (nothing hosted, nothing inserted)", !r.ok && provider.calls.length === 0 && svc.inserted.length === 0)
    const off = await capturePublicPropertyPage("123 Main St Austin TX", { svc, provider, fetchRobots: robotsAllow, search: async () => [{ url: REDFIN }] }, { domains: ["redfin.com"], hostScope: "estimate_comparison" } as any)
    check("the search-tool capture entry refuses a portal domain whatever scope it is handed", !off.ok && /not on PUBLIC_PAGE_HOSTS/.test(off.reason) && provider.calls.length === 0)
  }
  const COMPARISON_SCOPE_RE = /\bhostScope\b|COMPARISON_ONLY_PAGE_HOSTS|COMPARISON_PAGE_READY_RULES|isComparisonOnlyPageHost|comparisonOnly/
  const seamCode = blankStrings(stripped("lib/assets/screenshot-capture.ts"))
  check("the seam's live code carries no comparison capture scope (stripped + string-blanked: the tombstone is not a call site)", !COMPARISON_SCOPE_RE.test(seamCode))
  check("POSITIVE CONTROL: the scope finder catches the 82D shape", COMPARISON_SCOPE_RE.test(blankStrings(stripComments(`const comparisonOnly = req.hostScope === "estimate_comparison" && isComparisonOnlyPageHost(u.hostname)`))))
  {
    const svc = makeSvc({ readRow: { id: "a1", tags: ["estimate_comparison"], metadata: { asset_kind: "screenshot", screenshot_kind: "public_page", estimate_source: "redfin_estimate", comparison_only: true } } })
    const r = await setScreenshotUses(svc, "a1", ["marketing_campaign"], { brokerageId: TENANT })
    check("a LEGACY 82D comparison still can never be widened into a campaign use — no update issued; usesOfRow lists it for nothing", !r.ok && /only for the estimate comparison piece/.test(r.reason) && svc.updates.length === 0 && usesOfRow({ tags: ["use:marketing_campaign"], metadata: { screenshot_kind: "public_page", comparison_only: true } }).length === 0)
    const svcZ = makeSvc({ readRow: { id: "z1", tags: [], metadata: { asset_kind: "screenshot", screenshot_kind: "public_page", estimate_source: "zillow_zestimate" } } })
    await setScreenshotUses(svcZ, "z1", ["marketing_campaign"], { brokerageId: TENANT })
    check("CONTROL: a Zestimate still set to marketing_campaign proceeds to the counted update", svcZ.updates.length === 1)
  }

  console.log("\n[4 · composer — approved + confirmed figures, the spread, compliant copy]")
  // 83C: Zillow evidence is a still; the three portals' evidence is a web-searched (or typed) figure.
  const ev = (source: string, fig: number | null, status = "approved", at = "2026-09-25T12:00:00Z", url?: string): ComparisonEvidence => {
    const web = source !== "zillow_zestimate"
    return { assetId: `id-${source}`, source, url: url ?? (web ? `https://www.${source.split("_")[0]}.com/x/123-main-st` : `https://cdn.example.test/${source}.png`), approvalStatus: status, capturedAt: at, confirmedFigureUsd: fig, via: web ? "web_search" : "still" }
  }
  const four = [ev("zillow_zestimate", 512300), ev("realtor_estimate", 498000), ev("redfin_estimate", 531750), ev("homes_estimate", 489900)]
  const plan = planComparisonCards(four)
  check("four approved + confirmed captures → four cards; high = Redfin 531,750, low = Homes 489,900, spread $41,850 (derived, not typed)",
    plan.ok && plan.cards.length === 4 && plan.highUsd === 531750 && plan.lowUsd === 489900 && plan.spreadUsd === 41850 && plan.spreadText === "$41,850"
    && plan.cards.find((c) => c.isHigh)?.source === "redfin_estimate" && plan.cards.find((c) => c.isLow)?.source === "homes_estimate")
  check("only the Zillow card carries a still URL; the figure_only portals print as text (stillUrl null)", plan.ok && plan.cards.filter((c) => c.stillUrl).map((c) => c.source).join() === "zillow_zestimate")
  const mixed = planComparisonCards([ev("zillow_zestimate", 512300), ev("realtor_estimate", 498000, "pending"), ev("redfin_estimate", null), ev("homes_estimate", 489900)])
  check("a PENDING capture and an UNCONFIRMED figure never make a card — each is named in `omitted` with what the human must do",
    mixed.ok && mixed.cards.length === 2 && mixed.omitted.some((o) => o.source === "realtor_estimate" && /approve it first/.test(o.reason)) && mixed.omitted.some((o) => o.source === "redfin_estimate" && /figure not confirmed/.test(o.reason)))
  const one = planComparisonCards([ev("zillow_zestimate", 512300)])
  check(`fewer than ${MIN_COMPARISON_CARDS} usable cards → refused (a comparison of one is not a comparison)`, !one.ok && /at least 2/.test(one.reason))
  // 83C — a SCREENSHOT of a web-searched portal (an 82D capture still on file) never makes a card.
  const legacy = planComparisonCards([ev("zillow_zestimate", 512300), { ...ev("redfin_estimate", 531750), via: "still", url: "https://cdn.example.test/redfin.png" }, ev("homes_estimate", 489900)])
  check("an approved + confirmed 82D SCREENSHOT of Redfin never makes a card — omitted naming the web search / typed fallback",
    legacy.ok && !legacy.cards.some((c) => c.source === "redfin_estimate") && legacy.omitted.some((o) => o.source === "redfin_estimate" && /screenshots of it are no longer used/.test(o.reason)))
  const typed = planComparisonCards([ev("zillow_zestimate", 512300), { ...ev("homes_estimate", 489900), via: "human_typed" }])
  check("POSITIVE CONTROL: the typed-figure fallback (human_typed, approved) DOES make a card", typed.ok && typed.cards.some((c) => c.source === "homes_estimate"))
  const detailed = planComparisonCards([ev("zillow_zestimate", 512300), { ...ev("realtor_estimate", 498000), labelDetail: "Cotality™" }])
  check("a named provider on realtor.com's panel rides the card label as plain text (glyph stripped)", detailed.ok && detailed.cards.find((c) => c.source === "realtor_estimate")?.label === "Realtor.com estimate · Cotality")
  check("CONTROL: validateConfirmedFigure accepts '$512,300' and refuses 500, 'abc' and 10^9", (() => { const a = validateConfirmedFigure("$512,300"); return a.ok && a.figureUsd === 512300 })() && !validateConfirmedFigure(500).ok && !validateConfirmedFigure("abc").ok && !validateConfirmedFigure(1e9).ok)
  const qr = "data:image/png;base64,QUJD"
  const creative = composeEstimateComparison(four, { brand: { name: "Acme Realty", primaryColor: "#123456", fairHousingLine: "Equal Housing Opportunity." }, qrDataUrl: qr })
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
    check("the `spread` hook is used only when the sites disagree; a zero spread falls back to the default hook", comparisonCopy(plan as any, { hookKey: "spread" }).headline === "$41,850 apart. Same house. Same day." && (() => { const p = planComparisonCards([ev("zillow_zestimate", 500000), ev("homes_estimate", 500000)]); return p.ok && comparisonCopy(p, { hookKey: "spread" }).hookKey === "four_sites" })())
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
  const STILL_READER_RE = /tenant-screenshot-door|estimate-comparison"|estimate-web-search"|listScreenshotStillsForUse|screenshotUrlsForUse|approvedTenantStill|tenantScreenshotUrlsForVideo|listComparisonEvidence|stageWebEstimateFigures|searchPortalEstimate/
  const valueFiles = files.filter((f) => VALUE_PATH_RE.test(rel(f)))
  const readers = valueFiles.filter((f) => STILL_READER_RE.test(blankStrings(stripComments(readFileSync(f, "utf8"))).replace(/\s+/g, " ")) || /["']@\/lib\/marketing\/(tenant-screenshot-door|estimate-comparison|estimate-web-search)["']/.test(stripComments(readFileSync(f, "utf8"))))
  console.log(`    value surfaces swept: ${valueFiles.length} of ${files.length} live lib/app files (path names cma/valuation/home-value/appraisal/net-sheet/price-advisor/avm)`)
  check("no value surface (CMA, valuation, home-value, appraisal, net sheet, price advisor, AVM) reads a still or the comparison evidence", valueFiles.length > 0 && readers.length === 0, readers.map(rel).join(", "))
  check("CONTROL: the sweep flags a specimen CMA file importing the still door or the web-search stager", VALUE_PATH_RE.test("lib/cma/cma-builder.ts") && /["']@\/lib\/marketing\/(tenant-screenshot-door|estimate-comparison|estimate-web-search)["']/.test(stripComments(`import { approvedTenantStill } from "@/lib/marketing/tenant-screenshot-door"`)) && STILL_READER_RE.test(blankStrings(stripComments(`const { stageWebEstimateFigures } = await import(x)`))))
  const lib = stripped("app/actions/marketing/image-library.ts")
  check("the image library admits an estimate still only through estimateStillUseVerdict(…, IMAGE_LIBRARY_USE) and drops comparison_only rows", /estimateStillUseVerdict\(src, IMAGE_LIBRARY_USE/.test(lib) && /comparison_only === true\) return false/.test(lib) && /assets: admitted\.map/.test(lib))
  const webMod = stripped("lib/marketing/estimate-web-search.ts")
  check("the web-search stager never screenshots (no seam capture entry) and stamps every staged row customer_facing_value:false, comparison-only", !/captureScreenshot\(|capturePublicPropertyPage\(|captureTenantEstimateStill\(/.test(webMod) && /customer_facing_value: false/.test(webMod) && /comparison_only: true/.test(webMod) && /approval_status: "pending"/.test(webMod))

  console.log("\n[6 · surfaces — the play, the install rail, the doors, the card]")
  check("the `estimate_comparison` play exists with capture page, QR, postcard, social, email, video and bundle steps", !!pb && ["lead_magnet", "qr", "direct_mail_postcard", "social_post", "email", "video", "bundle"].every((k) => pb!.steps.some((s) => s.kind === k)))
  const install = stripped("app/actions/creative-playbooks.ts")
  check("the install rail composes from the APPROVED composite (never pending) and otherwise gathers every source (Zillow still + web search), pending", /playbook\.key === "estimate_comparison"/.test(install) && /approvedComparisonCreative\(svc, ctx\.brokerageId, address, "postcard_6x9"\)/.test(install) && /gatherEstimateComparisonEvidence\(\{ svc, brokerageId: ctx\.brokerageId/.test(install))

  // WAVE 83C — MORE THAN ONE ESTIMATE-TYPE PLAY (owner: "you removed the zestimate playbook which you
  // shouldn't have done because there can be more than one 'estimate' type play"). The rule: every key
  // in ESTIMATE_PLAY_KEYS resolves to its own play, the Zestimate Challenge keeps its install branch
  // (autonomous still) and rides Zillow, and neither is folded into the other.
  const playsHold = (keys: readonly string[], lookup: (k: string) => ReturnType<typeof getPlaybook>, installSrc: string) =>
    keys.length >= 2 && new Set(keys).size === keys.length && keys.every((k) => { const p = lookup(k); return !!p && p.key === k && ["qr", "direct_mail_postcard", "bundle"].every((s) => p.steps.some((x) => x.kind === s)) && installSrc.includes(`playbook.key === "${k}"`) })
  check(`every estimate-type play resolves on its own with its install branch (${ESTIMATE_PLAY_KEYS.join(" + ")})`, playsHold(ESTIMATE_PLAY_KEYS, getPlaybook, install))
  const zc = getPlaybook("zestimate_challenge")
  check("the Zestimate Challenge is intact: rides Zillow, has its video step, and its install branch ensures the still autonomously through the tenant door",
    !!zc && /Zillow/.test(zc.ridesOn) && zc.steps.some((s) => s.kind === "video") && /ensureZestimateChallengeStill\(\{ svc, brokerageId: ctx\.brokerageId/.test(install))
  check("POSITIVE CONTROL: the rule FAILS a catalogue with the Zestimate Challenge removed (the owner's complaint)", !playsHold(ESTIMATE_PLAY_KEYS, (k) => (k === "zestimate_challenge" ? null : getPlaybook(k)), install))
  const doors = stripped("app/actions/marketing/tenant-screenshots.ts")
  const newDoors = ["captureEstimateComparisonAction", "listEstimateComparisonAction", "confirmComparisonFigureAction", "composeEstimateComparisonAction", "typeComparisonFigureAction"]
  check("each of the five comparison doors (incl. the 83C typed-figure fallback) is async and gates on requireTenantAdminOrSoloOwner (tenant from the SESSION) before the service client", newDoors.every((n) => {
    const i = doors.indexOf(`export async function ${n}(`); if (i < 0) return false
    const body = doors.slice(i, doors.indexOf("\nexport ", i + 10) > 0 ? doors.indexOf("\nexport ", i + 10) : undefined)
    const g = body.indexOf("requireTenantAdminOrSoloOwner()"), s = body.indexOf("createServiceClient()")
    return g > 0 && s > g && !/input\.brokerageId|params\.brokerageId/.test(body)
  }))
  const comp = stripped("lib/marketing/estimate-comparison.ts")
  check("the figure is confirmed only off an APPROVED capture, tenant-predicated, and the update is COUNTED", /approval_status !== "approved"\) return \{ ok: false, reason: "approve the capture first/.test(comp) && /\.eq\("id", args\.assetId\)\.eq\("brokerage_id", args\.brokerageId\)\.select\("id"\)/.test(comp) && /matched no row/.test(comp))
  check("the composite lands PENDING on the approval rail as campaign material, never an estimate of value", /approval_status: "pending"/.test(comp) && /campaign_material_never_an_estimate_of_value/.test(comp))
  check("the composite carries use:marketing_campaign ONLY (it holds the Zestimate — marketing campaigns strictly)", /tags: \["library", ESTIMATE_COMPARISON_ASSET_KIND, fmt, "use:marketing_campaign"\]/.test(comp) && !/use:product_video/.test(comp))
  check("the comparison card is mounted beside the Zestimate stills card", /<EstimateComparisonCard \/>/.test(stripped("app/settings/campaign-bundles/client.tsx")))

  console.log("\n[7 · 81D open items — printed postcards carry a tracked QR; one placement vocabulary]")
  const drain = stripped("lib/direct-mail/campaign-drain.ts")
  const bundle = stripped("app/actions/campaign-bundle-dispatch.ts")
  check("the approved-campaign drain reuses/mints the campaign's code through mintTrackedQr and passes its scanUrl as qrScanUrl", /mintTrackedQr\(\{ brokerageId: input\.brokerageId/.test(drain) && /qrScanUrl: printedQr\?\.scanUrl \?\? null/.test(drain) && /from\("qr_codes"\)\.select\("label"\)\.eq\("id", row\.qr_code_id\)\.eq\("brokerage_id", input\.brokerageId\)/.test(drain))
  check("the CRM bundle send mints one tenant code per bundle and passes its scanUrl", /mintTrackedQr\(\{ brokerageId, agentId: ctx\.agentId \?\? null, label: `campaign_bundle:\$\{params\.bundleId\}`/.test(bundle) && /qrScanUrl:\s*bundleQr\?\.scanUrl \?\? null/.test(bundle))
  check("CONTROL: the producer finder would fail on the pre-82D shape (no qrScanUrl passed)", !/qrScanUrl: printedQr/.test("unsubscribeToken,\n        systemSource: `campaign_drain`"))
  // WAVE 83C — the four direct-mail senders 82D left without a QR. The RULE, per sender: its stripped
  // source mints through mintTrackedQr AND hands the minted scanUrl to the render call as qrScanUrl.
  const MAIL_SENDERS = ["lib/agents/agent-client-messages.ts", "lib/workflow-orchestrator/chains/listing-appt-prep.ts", "lib/direct-mail/listing-lifecycle-mail-reactor.ts", "lib/farm-mail/dispatch-farm-mail.ts"]
  const printsTrackedQr = (code: string) => /mintTrackedQr\(\{/.test(code) && /\.scanUrl\b/.test(code) && /\bqrScanUrl:\s*(?!null\b)(?!args\.|params\.|input\.)[^\n,]+/.test(code) && /orchestrate(RenderAndSend|PresetSend)\(/.test(code)
  const senderMisses = MAIL_SENDERS.filter((p) => !printsTrackedQr(stripped(p)))
  check(`each of the ${MAIL_SENDERS.length} direct-mail senders (agent client messages, listing-appointment prep, lifecycle reactor, farm mail) mints a tracked QR and passes its scanUrl as qrScanUrl`, senderMisses.length === 0, senderMisses.join(", "))
  check("POSITIVE CONTROL: the sender finder fails the pre-83C farm-mail shape (render call, no qrScanUrl, no mint)", !printsTrackedQr(stripComments(`const result = await orchestrateRenderAndSend({\n  brokerageId: args.brokerageId,\n  fallbackTemplateId: args.fallbackTemplateId,\n  systemSource: "farm_mail",\n})`)))
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
  console.log(" blind spots: no live capture or live web search (the Zillow still and the Exa search for realtor/redfin/homes run only live — the search → extract → verify chain is proven on fixtures by test:estimate-web-search); the SVG→PNG rasterize (sharp) and hosting run only live; the value-surface sweep is PATH-based (a value computation in a file whose path names none of cma/valuation/home-value/appraisal/net-sheet/price-advisor/avm is not swept); fair-housing is checked against the m450 seed catalogue, not tenant-added phrases; the install rail and doors are asserted by stripped source, not executed.")
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ ESTIMATE_COMPARISON_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
