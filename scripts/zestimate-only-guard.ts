#!/usr/bin/env tsx
/**
 * scripts/zestimate-only-guard.ts   (npm run test:zestimate-only)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ZESTIMATE IS THE ONLY PROPERTY-PAGE STILL (wave 81, lane 81D — owner
 * verbatim: "the zestimate screenshot is the only property page screenshot so
 * get rid of the other site mentions because the zestimate marketing strategy
 * only uses zillow zestimate property page screenshots with the picture of the
 * property on zillow with the zestimate showing … there can be many uses for
 * the screenshots").
 *
 * Asserts the RULE (never a waypoint):
 *   1. VOCABULARY — lib/marketing/estimate-sources.ts holds exactly one source,
 *      zillow_zestimate, on host zillow.com, with mustShow property_photo +
 *      zestimate; the three portal siblings are tombstoned, not merely removed.
 *   2. ZILLOW ALONE FOR CAMPAIGNS (re-anchored wave 82D) — the seam's
 *      PUBLIC_PAGE_HOSTS is zillow.com only; the campaign door and card name no
 *      other portal; in the vocabulary and the seam another portal appears ONLY
 *      inside a marked COMPARISON-ONLY block (the 82D estimate comparison piece,
 *      proven by scripts/estimate-comparison-guard.ts). Positive controls.
 *   2b. MARKETING CAMPAIGNS STRICTLY (82D owner: "the zillow zestimate
 *      screenshot should only be used for campaigns and not other estimate of
 *      value"; 83C owner: "zestimate is marketing campaigns strictly") —
 *      estimateStillUseVerdict admits EXACTLY marketing_campaign + the
 *      comparison piece across every known use; the 82D shape (demo /
 *      training / product_video / image library admitted) is the positive
 *      control the finder must fail.
 *   2c. THE SEAM ENFORCES IT — PUBLIC_PAGE_STILL_USES == ZESTIMATE_STILL_USES;
 *      usesOfRow clamps legacy rows; a capture asking for more is written
 *      campaign-only; setScreenshotUses refuses widening; no generic video path
 *      stages a tenant still; the campaign's own video still gets it.
 *   3. READINESS — a public_page plan on zillow.com carries the host's rules
 *      (photo + Zestimate); an OS-surface plan carries none; the seam REFUSES a
 *      capture whose provider confirmed nothing (nothing hosted, nothing
 *      inserted), refuses one that confirmed only the photo (names the missing
 *      Zestimate), and keeps one that confirmed both (metadata.shows = both).
 *      combinedReadySelector folds the rules into ONE body:has() selector for
 *      the hosted adapter; the puppeteer adapter waits per rule, visible.
 *   4. USES STAY MANY — SCREENSHOT_USES is unchanged (≥4, campaign + video).
 *   5. SURFACES — the tenant card has no source picker and names Zillow; the
 *      door's refusal is derived from the vocabulary, not restated.
 *
 * No network, no browser, no DB (counting stubs).
 * Run: npx tsx --conditions=react-server scripts/zestimate-only-guard.ts
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import {
  ESTIMATE_SOURCES, ESTIMATE_SOURCE_KEYS, DEFAULT_ESTIMATE_SOURCE, ZESTIMATE_STILL_MUST_SHOW, ESTIMATE_OF_VALUE_USES, estimateStillUseVerdict,
  ZESTIMATE_STILL_USES, IMAGE_LIBRARY_USE, ESTIMATE_COMPARISON_USE,
} from "../lib/marketing/estimate-sources"
import {
  PUBLIC_PAGE_HOSTS, PUBLIC_PAGE_READY_RULES, readyRulesForHost, combinedReadySelector, unsatisfiedReadyLabels,
  planScreenshotCapture, captureScreenshot, SCREENSHOT_USES, PUBLIC_PAGE_STILL_USES, defaultScreenshotUses, usesOfRow, setScreenshotUses,
  type ScreenshotProvider, type ProviderCaptureInput,
} from "../lib/assets/screenshot-capture"
import { planTenantStill } from "../lib/marketing/tenant-screenshot-door"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(root, p), "utf8")
const stripped = (p: string) => stripComments(src(p))

const VOCAB = "lib/marketing/estimate-sources.ts"
const DOOR = "lib/marketing/tenant-screenshot-door.ts"
const SEAM = "lib/assets/screenshot-capture.ts"
const CARD = "app/settings/campaign-bundles/estimate-stills-card.tsx"
const TENANT = "11111111-1111-4111-8111-111111111111"

process.env.NEXT_PUBLIC_APP_URL = "https://os.example.test"
delete process.env.VERCEL; delete process.env.AWS_LAMBDA_FUNCTION_NAME; delete process.env.SCREENSHOT_PROVIDER

// ── Stubs ────────────────────────────────────────────────────────────────────
function providerConfirming(labels: (input: ProviderCaptureInput) => string[] | undefined): ScreenshotProvider & { calls: ProviderCaptureInput[] } {
  const calls: ProviderCaptureInput[] = []
  return { name: "puppeteer", calls, async capture(input) { calls.push(input); const s = labels(input); return s ? { png: Buffer.from("png"), satisfied: s } : { png: Buffer.from("png") } } }
}
function makeSvc(opts: { insertId?: string; readRow?: Record<string, unknown> | null } = {}) {
  const calls: string[] = []
  const inserted: Array<Record<string, unknown>> = []
  const updates: Array<Record<string, unknown>> = []
  const chain = (table: string) => {
    const q: any = {}
    for (const m of ["select", "eq", "is", "lt", "in", "order", "limit", "not", "or", "gte", "neq"]) q[m] = () => q
    q.insert = (row: Record<string, unknown>) => { inserted.push(row); return q }
    q.update = (row: Record<string, unknown>) => { updates.push(row); return q }
    q.maybeSingle = async () => ({ data: null, error: null })
    q.single = async () => ({ data: { id: opts.insertId ?? "row-new" }, error: null })
    q.then = (res: any, rej: any) => Promise.resolve({ data: opts.readRow ? [opts.readRow] : [], error: null }).then(res, rej)
    void table
    return q
  }
  return {
    calls, inserted, updates,
    from: (t: string) => { calls.push(`from:${t}`); return chain(t) },
    storage: { from: (b: string) => ({
      upload: async (p: string) => { calls.push(`upload:${b}/${p}`); return { error: null } },
      getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.example.test/${b}/${p}` } }),
    }) },
  }
}
const robotsAllow = async () => "User-agent: *\nAllow: /"
const ZILLOW = "https://www.zillow.com/homedetails/123-Main-St-Austin-TX-78701/1_zpid/"
// The apex host is a separate per-host rate-limiter key (PUBLIC_PAGE_RATE) from www. — section 2c's
// captures use it so section 3's readiness captures keep their own budget.
const ZILLOW_APEX = "https://zillow.com/homedetails/456-Oak-Ave-Austin-TX-78702/2_zpid/"

async function main() {
  console.log("\n[1 · ONE source — the Zillow Zestimate property page]")
  check("ESTIMATE_SOURCE_KEYS is exactly [zillow_zestimate] and the default is that key", ESTIMATE_SOURCE_KEYS.length === 1 && ESTIMATE_SOURCE_KEYS[0] === "zillow_zestimate" && DEFAULT_ESTIMATE_SOURCE === "zillow_zestimate")
  const z = ESTIMATE_SOURCES[0]
  check("the source rides zillow.com and must show property_photo + zestimate", ESTIMATE_SOURCES.length === 1 && z.host === "zillow.com" && z.mustShow.join("+") === "property_photo+zestimate" && ZESTIMATE_STILL_MUST_SHOW.join("+") === "property_photo+zestimate")
  const vocabRaw = src(VOCAB)
  check("the three portal siblings are TOMBSTONED (named in a comment with the ruling), not silently dropped", /TOMBSTONE/.test(vocabRaw) && /realtor_estimate/.test(vocabRaw) && /redfin_estimate/.test(vocabRaw) && /homes_estimate/.test(vocabRaw) && /is the only[\s/]*property page screenshot/.test(vocabRaw))
  check("the ToS note says the still is shown WHOLE — photo and Zestimate together, as the portal's figure", /whole/i.test(z.tosNote) && /photo/i.test(z.tosNote) && /Zestimate/.test(z.tosNote) && /approv/i.test(z.tosNote))

  console.log("\n[2 · no other site mentions in live code]")
  const OTHER_SITES_RE = /\b(redfin|realtor|trulia|homes)\.com\b|\b(realtor|redfin|homes)_estimate\b/i
  check("PUBLIC_PAGE_HOSTS is zillow.com only", PUBLIC_PAGE_HOSTS.length === 1 && PUBLIC_PAGE_HOSTS[0] === "zillow.com")
  // RE-ANCHORED (wave 82D — owner: "the zillow zestimate screenshot should only be used for
  // campaigns" + the multi-site estimate COMPARISON piece). The rule is now: Zillow ALONE for
  // campaign stills; the other portals live ONLY inside the marked COMPARISON-ONLY blocks of the
  // vocabulary and the seam (scripts/estimate-comparison-guard.ts owns what those blocks may do).
  // The campaign door and the Zestimate card still name no other portal at all.
  const outsideComparisonBlock = (p: string): number[] => {
    const raw = src(p).split("\n"); const code = stripped(p).split("\n")
    let inside = false; const hits: number[] = []
    raw.forEach((line, i) => {
      if (/BEGIN COMPARISON-ONLY BLOCK/.test(line)) inside = true
      if (/END COMPARISON-ONLY BLOCK/.test(line)) inside = false
      if (!inside && OTHER_SITES_RE.test(code[i] ?? "")) hits.push(i + 1)
    })
    return hits
  }
  const doorCardOffenders = [DOOR, CARD].filter((p) => OTHER_SITES_RE.test(stripped(p)))
  check("the campaign door and the Zestimate card name no other portal in live code (stripped source)", doorCardOffenders.length === 0, doorCardOffenders.join(", "))
  const blockLeaks = [VOCAB, SEAM].map((p) => ({ p, lines: outsideComparisonBlock(p) })).filter((x) => x.lines.length)
  check("in the vocabulary and the seam, another portal appears ONLY inside a COMPARISON-ONLY block", blockLeaks.length === 0, blockLeaks.map((x) => `${x.p}:${x.lines.join(",")}`).join("; "))
  check("the campaign vocabulary ESTIMATE_SOURCES names no other portal (Zillow alone for campaigns)", ESTIMATE_SOURCES.every((s) => !OTHER_SITES_RE.test(`${s.host} ${s.key}`)))
  check("CONTROL: the other-site finder catches a specimen host and a specimen key", OTHER_SITES_RE.test(stripComments(`const hosts = ["zillow.com", "redfin.com"]`)) && OTHER_SITES_RE.test(stripComments(`key: "homes_estimate"`)) && !OTHER_SITES_RE.test(stripComments(`// redfin.com was retired\nconst h = "zillow.com"`)))
  check("CONTROL: a portal token OUTSIDE a comparison block is a leak; inside one it is not", (() => {
    const spec = ["const a = \"zillow.com\"", "// ── BEGIN COMPARISON-ONLY BLOCK", "const b = \"redfin.com\"", "// ── END COMPARISON-ONLY BLOCK", "const c = \"homes.com\""]
    let inside = false; const hits: number[] = []
    spec.forEach((l, i) => { if (/BEGIN COMPARISON-ONLY BLOCK/.test(l)) inside = true; if (/END COMPARISON-ONLY BLOCK/.test(l)) inside = false; if (!inside && OTHER_SITES_RE.test(stripComments(l))) hits.push(i + 1) })
    return hits.join() === "5"
  })())

  console.log("\n[2b · a Zestimate still is MARKETING-CAMPAIGN material, strictly — never an estimate of value]")
  // WAVE 83C (owner verbatim: "zestimate is marketing campaigns strictly"): the 82D rule admitted every
  // SCREENSHOT_USES entry (demo / training / product_video too) plus the image library. The RULE now:
  // the Zestimate is admitted for marketing_campaign and the comparison piece (itself a campaign) and
  // NOTHING else. Asserted over every use the OS knows, derived — never a hand list.
  const EVERY_USE = Array.from(new Set<string>([...SCREENSHOT_USES, IMAGE_LIBRARY_USE, ESTIMATE_COMPARISON_USE, ...ESTIMATE_OF_VALUE_USES, "seller_portal_value"]))
  const CAMPAIGN_ONLY = new Set<string>([...ZESTIMATE_STILL_USES, ESTIMATE_COMPARISON_USE])
  const admitsExactlyCampaign = (verdict: (src: string, use: string) => { ok: boolean }) => EVERY_USE.every((u) => verdict("zillow_zestimate", u).ok === CAMPAIGN_ONLY.has(u))
  check(`the Zestimate is admitted for EXACTLY ${[...CAMPAIGN_ONLY].join(" + ")} across all ${EVERY_USE.length} known uses (demo, training, product_video, image_library, every value use refused)`, admitsExactlyCampaign(estimateStillUseVerdict))
  check("ZESTIMATE_STILL_USES is marketing_campaign alone and names a real seam use", ZESTIMATE_STILL_USES.join() === "marketing_campaign" && ZESTIMATE_STILL_USES.every((u) => (SCREENSHOT_USES as readonly string[]).includes(u)))
  check("every estimate-of-value use is refused with the value reason", ESTIMATE_OF_VALUE_USES.every((u) => { const v = estimateStillUseVerdict("zillow_zestimate", u); return !v.ok && /never an estimate of value/.test(v.reason) }))
  check("POSITIVE CONTROL: the finder FAILS the 82D rule shape (a verdict admitting every seam use + the library)", !admitsExactlyCampaign((src, u) => ({ ok: src === "zillow_zestimate" && ((SCREENSHOT_USES as readonly string[]).includes(u) || u === IMAGE_LIBRARY_USE || u === ESTIMATE_COMPARISON_USE) })))
  check("CONTROL: an unknown non-campaign use is refused for the Zestimate (fail closed)", !estimateStillUseVerdict("zillow_zestimate", "seller_portal_value").ok)

  console.log("\n[2c · the seam enforces it where every picker reads]")
  check("the seam's PUBLIC_PAGE_STILL_USES equals the vocabulary's ZESTIMATE_STILL_USES (one rule, two readers)", [...PUBLIC_PAGE_STILL_USES].sort().join() === [...ZESTIMATE_STILL_USES].sort().join())
  check("defaultScreenshotUses: a public_page still is born marketing_campaign only; an OS-surface still keeps every use", defaultScreenshotUses("public_page").join() === "marketing_campaign" && defaultScreenshotUses("os_surface").length === SCREENSHOT_USES.length)
  const legacyZ = { tags: ["use:marketing_campaign", "use:product_video", "use:demo", "use:training"], metadata: { screenshot_kind: "public_page", estimate_source: "zillow_zestimate" } }
  const untagged = { tags: [], metadata: { screenshot_kind: "public_page" } }
  check("usesOfRow CLAMPS a legacy Zestimate row tagged product_video/demo/training to marketing_campaign (so no video/demo/training picker lists it)", usesOfRow(legacyZ).join() === "marketing_campaign" && usesOfRow(untagged).join() === "marketing_campaign")
  check("POSITIVE CONTROL: an OS-surface row with the same tags keeps all four (the clamp is public_page only)", usesOfRow({ tags: legacyZ.tags, metadata: { screenshot_kind: "os_surface" } }).length === 4)
  {
    const provider = providerConfirming((i) => i.readyWhen.map((r) => r.label)); const svc = makeSvc({ insertId: "still-uses" })
    await captureScreenshot({ kind: "public_page", url: ZILLOW_APEX, dayIso: "2026-09-26", owner: { brokerageId: TENANT, createdBy: null, uses: ["marketing_campaign", "product_video", "demo", "training"] } }, { svc, provider, fetchRobots: robotsAllow, now: new Date("2026-09-26T00:00:00Z") })
    const row = svc.inserted[0] as any
    check("a tenant capture that ASKS for product_video/demo/training is written marketing_campaign only (tags + metadata.uses)", !!row && (row.tags as string[]).filter((t) => t.startsWith("use:")).join() === "use:marketing_campaign" && row.metadata?.uses?.join() === "marketing_campaign")
    const svcP = makeSvc({ insertId: "plat" }); const providerP = providerConfirming((i) => i.readyWhen.map((r) => r.label))
    await captureScreenshot({ kind: "public_page", url: ZILLOW_APEX, dayIso: "2026-09-27" }, { svc: svcP, provider: providerP, fetchRobots: robotsAllow, now: new Date("2026-09-27T00:00:00Z") })
    const prow = svcP.inserted[0] as any
    check("a PLATFORM Zillow capture is marketing_campaign only too (no demo/training/video stock)", !!prow && prow.metadata?.uses?.join() === "marketing_campaign" && prow.metadata?.usage === "marketing_campaign_material_never_customer_value")
  }
  {
    const svcW = makeSvc({ readRow: { id: "z1", tags: ["use:marketing_campaign"], metadata: { asset_kind: "screenshot", screenshot_kind: "public_page", estimate_source: "zillow_zestimate" } } })
    const w = await setScreenshotUses(svcW, "z1", ["marketing_campaign", "product_video"], { brokerageId: TENANT })
    check("setScreenshotUses REFUSES widening a Zestimate still to product_video — no update issued", !w.ok && /marketing campaigns strictly/.test(w.reason) && svcW.updates.length === 0)
    const svcP = makeSvc({ readRow: { id: "p1", tags: [], metadata: { asset_kind: "screenshot", screenshot_kind: "public_page" } } })
    const p = await setScreenshotUses(svcP, "p1", ["demo"])
    check("a PLATFORM public_page still with no recorded source is judged as the Zillow page — widening to demo refused", !p.ok && svcP.updates.length === 0)
    const svcOk = makeSvc({ readRow: { id: "z2", tags: [], metadata: { asset_kind: "screenshot", screenshot_kind: "public_page", estimate_source: "zillow_zestimate" } } })
    await setScreenshotUses(svcOk, "z2", ["marketing_campaign"], { brokerageId: TENANT })
    check("POSITIVE CONTROL: marketing_campaign alone proceeds to the counted update", svcOk.updates.length === 1)
  }
  check("the image library refuses every estimate still (verdict for image_library is NO for the Zestimate)", !estimateStillUseVerdict("zillow_zestimate", IMAGE_LIBRARY_USE).ok && /estimateStillUseVerdict\(src, IMAGE_LIBRARY_USE\)/.test(stripped("app/actions/marketing/image-library.ts")))
  const DIRECTOR = "lib/video/video-director.ts"
  const STILL_INTO_VIDEO_RE = /tenant-screenshot-door|tenantScreenshotUrlsForVideo|screenshotUrlsForUse\([^)]*product_video/
  check("no generic video path stages a tenant still any more (video-director reads no still door — stripped source)", !STILL_INTO_VIDEO_RE.test(stripped(DIRECTOR)) && !/export async function tenantScreenshotUrlsForVideo/.test(stripped(DOOR)))
  check("POSITIVE CONTROL: the finder catches the 80D director shape", STILL_INTO_VIDEO_RE.test(stripComments(`const { tenantScreenshotUrlsForVideo } = await import("@/lib/marketing/tenant-screenshot-door")`)))
  check("the Zestimate Challenge's OWN campaign video still gets the approved still (install rail → createPlaybookVideo screenshotUrls)", /screenshotUrls: approvedStillUrl \? \[approvedStillUrl\] : \[\]/.test(stripped("app/actions/creative-playbooks.ts")))

  console.log("\n[3 · readiness — the still must show the photo AND the Zestimate]")
  const rules = readyRulesForHost("www.zillow.com")
  check("readyRulesForHost(zillow subdomain) = the host's rules: property_photo + zestimate, each a CSS selector", rules.map((r) => r.label).join("+") === "property_photo+zestimate" && rules.every((r) => r.selector.length > 10) && readyRulesForHost("example.com").length === 0)
  check("every mustShow label of the source is covered by the seam's rule for its host", z.mustShow.every((l) => readyRulesForHost(z.host).some((r) => r.label === l)) && Object.keys(PUBLIC_PAGE_READY_RULES).every((h) => (PUBLIC_PAGE_HOSTS as readonly string[]).includes(h)))
  const pub = planScreenshotCapture({ kind: "public_page", url: ZILLOW }, { siteOrigin: "" })
  const os = planScreenshotCapture({ kind: "os_surface", surfaceId: "command_center" }, { siteOrigin: "https://os.example.test" })
  check("a public_page plan on zillow carries the rules; an os_surface plan carries none", pub.ok && pub.readyWhen.length === 2 && os.ok && os.readyWhen.length === 0)
  const combined = combinedReadySelector(rules)
  check("combinedReadySelector folds every rule into ONE body:has() chain (hosted adapter)", !!combined && combined.startsWith("body:has(") && (combined.match(/:has\(/g) ?? []).length === 2 && combinedReadySelector([]) === null)
  check("unsatisfiedReadyLabels: no report = every label missing; a full report = none (fail closed)", unsatisfiedReadyLabels(rules, undefined).join("+") === "property_photo+zestimate" && unsatisfiedReadyLabels(rules, ["property_photo"]).join() === "zestimate" && unsatisfiedReadyLabels(rules, ["property_photo", "zestimate"]).length === 0)
  {
    const provider = providerConfirming(() => undefined); const svc = makeSvc()
    const r = await captureScreenshot({ kind: "public_page", url: ZILLOW }, { svc, provider, fetchRobots: robotsAllow })
    check("a provider that confirms NOTHING → refused naming both labels; nothing hosted, nothing inserted", !r.ok && /did not show property_photo \+ zestimate/.test(r.reason) && provider.calls.length === 1 && svc.inserted.length === 0 && !svc.calls.some((c) => c.startsWith("upload:")))
  }
  {
    const provider = providerConfirming(() => ["property_photo"]); const svc = makeSvc()
    const r = await captureScreenshot({ kind: "public_page", url: ZILLOW, dayIso: "2026-09-24" }, { svc, provider, fetchRobots: robotsAllow })
    check("a page with the photo but NO Zestimate on screen → refused naming zestimate; nothing inserted", !r.ok && /did not show zestimate/.test(r.reason) && svc.inserted.length === 0)
  }
  {
    const provider = providerConfirming((i) => i.readyWhen.map((r) => r.label)); const svc = makeSvc({ insertId: "still-z" })
    const r = await captureScreenshot({ kind: "public_page", url: ZILLOW, dayIso: "2026-09-25", owner: { brokerageId: TENANT, createdBy: null, uses: ["marketing_campaign", "product_video"] } }, { svc, provider, fetchRobots: robotsAllow, now: new Date("2026-09-25T00:00:00Z") })
    const row = svc.inserted[0] as any
    check("both confirmed → captured once; the row records shows=[property_photo, zestimate], pending, tenant-owned", r.ok && provider.calls.length === 1 && provider.calls[0].readyWhen.length === 2 && !!row && Array.isArray(row.metadata?.shows) && row.metadata.shows.join("+") === "property_photo+zestimate" && row.approval_status === "pending" && row.brokerage_id === TENANT)
  }
  const seam = stripped(SEAM)
  check("puppeteer adapter waits per rule, VISIBLE, and reports satisfied; hosted adapter sends wait_for_selector", /waitForSelector\(rule\.selector,\s*\{\s*visible:\s*true/.test(seam) && /satisfied\.push\(rule\.label\)/.test(seam) && /wait_for_selector/.test(seam))
  check("the seam still reads nothing off the page (no evaluate/$eval/innerText/textContent/content())", !/page\.evaluate\(|\$eval\(|innerText|textContent|page\.content\(/.test(seam))

  console.log("\n[4 · the seam's uses stay many — a Zestimate still carries one]")
  check("SCREENSHOT_USES unchanged — ≥4 uses (OS-surface stills still serve demos, training, product videos)", SCREENSHOT_USES.length >= 4 && SCREENSHOT_USES.includes("marketing_campaign") && SCREENSHOT_USES.includes("product_video"))
  const plan = planTenantStill({ brokerageId: TENANT, userId: "u", source: "zillow_zestimate", address: "123 Main St, Austin TX" })
  check("a tenant plan tags marketing_campaign ONLY (83C — the 80D product_video opt-in is retired) and carries mustShow", plan.ok && plan.uses.join() === "marketing_campaign" && plan.mustShow.join("+") === "property_photo+zestimate")
  check("the tenant card offers no video opt-in and derives its use list from ZESTIMATE_STILL_USES", !/alsoForVideo|usable in videos|product_video/.test(stripped(CARD)) && /ZESTIMATE_STILL_USES/.test(stripped(CARD)))

  console.log("\n[5 · surfaces]")
  const card = stripped(CARD)
  check("the tenant card has NO source picker (<select>) and shows the one source as a fixed line", !/<select/.test(card) && /DEFAULT_ESTIMATE_SOURCE/.test(card) && /sourceDef\.label/.test(card))
  const bad = planTenantStill({ brokerageId: TENANT, userId: "u", source: "redfin_estimate", address: "123 Main St, Austin TX" })
  check("the door refuses a retired key and its message is DERIVED from the vocabulary (names zillow_zestimate only)", !bad.ok && /\(zillow_zestimate\)/.test(bad.reason) && /ESTIMATE_SOURCE_KEYS\.join/.test(stripped(DOOR)))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(" blind spots: no live navigation (the sandbox cannot reach zillow.com) — the selector rule is exercised on stubs that report what a real page would; Zillow can rename its test ids, in which case a live capture REFUSES (fail closed) rather than storing a still without the figure; the hosted adapter's :has() wait is asserted by source, not by a request.")
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ ZESTIMATE_ONLY_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
