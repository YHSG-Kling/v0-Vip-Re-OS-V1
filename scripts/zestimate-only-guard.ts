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
 *   2b. THE ONE USE RULE (84B owner: "screenshots can be used for all
 *      marketing/assets/videos/guides/education, etc. only the zillow zestimate
 *      screenshot can be used for marketing campaigns including video.") —
 *      lib/assets/screenshot-uses.ts screenshotUseAllowed, over EVERY subject ×
 *      EVERY known use: a general still serves every screenshot use, the
 *      Zestimate EXACTLY marketing_campaign + campaign_video, another portal's
 *      page nothing, a value use nothing. Positive controls: the 83C shape
 *      (Zestimate out of its campaign video; general stills refused demo /
 *      training / product_video / library) and the 82D shape (Zestimate as
 *      demo / training stock) both FAIL the finder. estimateStillUseVerdict
 *      defers to the rule (never restates it); the rule file is pure.
 *   2c. THE SEAM ENFORCES IT — usesOfRow = recorded ∩ rule (legacy lift for
 *      pre-84B rows); captures are written to the rule; setScreenshotUses
 *      refuses widening; the demo / training / product-video mounts and the
 *      image library each ask the rule; a video path may stage a tenant
 *      still ONLY for campaign_video; the campaign's own video gets it.
 *   2d. GENERAL PUBLIC PAGES (85A owner: "a public page screenshhot can be more
 *      than just zillow zestimate page.") — THE ONE classifier
 *      (estimate-sources.ts classifyPublicPage) over a table of general pages
 *      (listing / own site / city / school / news / HOA) and estimate pages
 *      (every other comparison portal, derived; Trulia; an estimator path);
 *      the seam plans the general page and refuses the estimate pages; the
 *      tenant's general capture lands pending with EVERY use (a general page
 *      now SERVES) while an other-portal estimate page is still REFUSED;
 *      the public-network guard (URL, DNS, every request) with specimens on
 *      both sides; a caller cannot relabel a page; the social auto-post
 *      picker asks the rule for image_library (E2E: the Zestimate, newest in
 *      the library, is passed over for the general still). Positive controls.
 *   6. THE ZESTIMATE CHALLENGE MAY QUOTE THE REAL NUMBER (84B owner: "for the
 *      zestimate challenge it is oky to have a real number as we aren't using
 *      it as our true value") — that play alone, only a human-confirmed
 *      figure, always attributed to Zillow; never reaches the AI ISA / voice.
 *   3. READINESS — a public_page plan on zillow.com carries the host's rules
 *      (photo + Zestimate); an OS-surface plan carries none; the seam REFUSES a
 *      capture whose provider confirmed nothing (nothing hosted, nothing
 *      inserted), refuses one that confirmed only the photo (names the missing
 *      Zestimate), and keeps one that confirmed both (metadata.shows = both).
 *      combinedReadySelector folds the rules into ONE body:has() selector for
 *      the hosted adapter; the puppeteer adapter waits per rule, visible.
 *   4. USES STAY MANY — every owner family (marketing, assets, videos,
 *      guides/education) has a use; the tenant plan + card read the rule.
 *   5. SURFACES — the tenant card has no source picker and names Zillow; the
 *      door's refusal is derived from the vocabulary, not restated.
 *
 * No network, no browser, no DB (counting stubs).
 * Run: npx tsx --conditions=react-server scripts/zestimate-only-guard.ts
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { readdirSync, statSync } from "node:fs"
import { stripComments, blankStrings } from "./strip-comments"
import {
  ESTIMATE_SOURCES, ESTIMATE_SOURCE_KEYS, DEFAULT_ESTIMATE_SOURCE, ZESTIMATE_STILL_MUST_SHOW, ESTIMATE_OF_VALUE_USES, estimateStillUseVerdict,
  ESTIMATE_COMPARISON_USE, COMPARISON_ESTIMATE_SOURCES, ESTIMATE_PAGE_PATH_MARKERS, classifyPublicPage,
} from "../lib/marketing/estimate-sources"
import {
  PUBLIC_PAGE_HOSTS, PUBLIC_PAGE_READY_RULES, readyRulesForHost, combinedReadySelector, unsatisfiedReadyLabels,
  planScreenshotCapture, captureScreenshot, SCREENSHOT_USES, SCREENSHOT_SUBJECTS, ZESTIMATE_SCREENSHOT_USES, SCREENSHOT_USES_RULE_VERSION,
  screenshotUseAllowed, screenshotUseVerdict, screenshotSubjectOfRow, screenshotRowUseAllowed, usesOfRow, setScreenshotUses, listDemoStills,
  screenshotUsesFor, isPublicIpAddress, requestHostRefusal,
  type ScreenshotProvider, type ProviderCaptureInput, type ScreenshotSubject,
} from "../lib/assets/screenshot-capture"
import { isScreenshotRuleRow } from "../lib/assets/screenshot-uses"
import { planTenantStill, planTenantPublicPageStill, captureTenantPublicPageStill } from "../lib/marketing/tenant-screenshot-door"
import { resolveSocialMedia } from "../lib/marketing/social-media-pairing"
import { ZESTIMATE_FIGURE_PLAY_KEYS, playMayQuoteZestimate, zestimateFigureBrief, getPlaybook, CREATIVE_PLAYBOOKS } from "../lib/marketing/creative-playbooks"
import { ESTIMATE_COMPARISON_ASSET_KIND } from "../lib/marketing/estimate-comparison"

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

  console.log("\n[2b · THE ONE USE RULE — general everywhere, the Zestimate for campaigns incl. video, other portals nowhere]")
  // WAVE 84B (owner verbatim: "screenshots can be used for all marketing/assets/videos/guides/education, etc.
  // only the zillow zestimate screenshot can be used for marketing campaigns including video."). The SPEC below
  // is the owner's sentence, not a copy of the code's list: a general still serves every screenshot use; the
  // Zestimate serves a marketing campaign and that campaign's video; another portal's page serves nothing; a
  // value use (CMA, valuation…) or an unknown use is refused for every subject. Asserted over every subject x
  // every use the OS knows (derived — SCREENSHOT_USES + the comparison piece + every value use + a stranger).
  const EVERY_USE = Array.from(new Set<string>([...SCREENSHOT_USES, ESTIMATE_COMPARISON_USE, ...ESTIMATE_OF_VALUE_USES, "seller_portal_value"]))
  const OWNER_CAMPAIGN_FAMILY = (u: string) => u === "marketing_campaign" || u === "campaign_video"
  const spec = (subject: ScreenshotSubject, u: string): boolean =>
    !(SCREENSHOT_USES as readonly string[]).includes(u) ? false
    : subject === "general" ? true
    : subject === "zillow_zestimate" ? OWNER_CAMPAIGN_FAMILY(u)
    : false
  const matchesOwner = (pred: (subject: ScreenshotSubject, use: string) => boolean) =>
    SCREENSHOT_SUBJECTS.every((sub) => EVERY_USE.every((u) => pred(sub, u) === spec(sub, u)))
  console.log(`    denominator: ${SCREENSHOT_SUBJECTS.length} subjects x ${EVERY_USE.length} uses = ${SCREENSHOT_SUBJECTS.length * EVERY_USE.length} verdicts`)
  check("screenshotUseAllowed matches the owner's rule on EVERY subject x use (general: all; Zestimate: campaign + campaign video; other portals: none; value uses: none)", matchesOwner(screenshotUseAllowed))
  check("the owner's campaign family exists in the vocabulary (marketing_campaign + campaign_video) and ZESTIMATE_SCREENSHOT_USES is exactly it", SCREENSHOT_USES.filter(OWNER_CAMPAIGN_FAMILY).length === 2 && [...ZESTIMATE_SCREENSHOT_USES].sort().join() === SCREENSHOT_USES.filter(OWNER_CAMPAIGN_FAMILY).sort().join())
  check("POSITIVE CONTROL: the finder FAILS the 83C shape (Zestimate campaign-only, no campaign video — the owner's correction)", !matchesOwner((sub, u) => sub === "zillow_zestimate" ? u === "marketing_campaign" : spec(sub, u)))
  check("POSITIVE CONTROL: the finder FAILS a shape that refuses general stills demo/training/product_video/library (83C's over-restriction)", !matchesOwner((sub, u) => sub === "general" ? OWNER_CAMPAIGN_FAMILY(u) : spec(sub, u)))
  check("POSITIVE CONTROL: the finder FAILS the 82D shape (the Zestimate as demo / training / product-video stock)", !matchesOwner((sub, u) => sub === "zillow_zestimate" ? (SCREENSHOT_USES as readonly string[]).includes(u) : spec(sub, u)))
  check("POSITIVE CONTROL: the finder FAILS a shape that lets another portal's page be a campaign still", !matchesOwner((sub, u) => sub === "other_portal_estimate" ? u === "marketing_campaign" : spec(sub, u)))
  check("a refusal names why (Zestimate → campaign + video only; other portal → web-searched text; value → never a value)",
    /campaigns including their video only/.test((screenshotUseVerdict("zillow_zestimate", "demo") as { reason: string }).reason ?? "")
    && /web-searched text/.test((screenshotUseVerdict("other_portal_estimate", "marketing_campaign") as { reason: string }).reason ?? "")
    && /never a value/.test((screenshotUseVerdict("general", "cma") as { reason: string }).reason ?? ""))
  // estimateStillUseVerdict is the EVIDENCE rule (value uses, the comparison piece); for a screenshot use it
  // must say what the ONE rule says — never a second list.
  check("estimateStillUseVerdict(zillow) = the ONE rule for every screenshot use + the comparison piece, and refuses every value use",
    EVERY_USE.every((u) => estimateStillUseVerdict("zillow_zestimate", u).ok === (u === ESTIMATE_COMPARISON_USE || screenshotUseAllowed("zillow_zestimate", u)))
    && ESTIMATE_OF_VALUE_USES.every((u) => { const v = estimateStillUseVerdict("zillow_zestimate", u); return !v.ok && /never an estimate of value/.test(v.reason) }))
  const RESTATED_LIST_RE = /["']campaign_video["']|["']product_video["']|ZESTIMATE_STILL_USES\s*=|IMAGE_LIBRARY_USE\s*=/
  check("the vocabulary does not restate the use list — it imports the rule (stripped source)", !RESTATED_LIST_RE.test(stripped(VOCAB)) && /from "@\/lib\/assets\/screenshot-uses"/.test(src(VOCAB)))
  check("CONTROL: the restatement finder catches the 83C constant and a literal use", RESTATED_LIST_RE.test(stripComments(`export const ZESTIMATE_STILL_USES = ["marketing_campaign"]`)) && RESTATED_LIST_RE.test(stripComments(`if (use === "campaign_video") return true`)))
  const RULE = "lib/assets/screenshot-uses.ts"
  const IMPORT_RE = /^\s*import\s|\brequire\(|\bimport\(/m
  check("the rule file is PURE (no imports — the client cards and the pure vocabulary read it in the browser)", !IMPORT_RE.test(blankStrings(stripComments(src(RULE)))))
  check("CONTROL: the purity finder catches a static and a dynamic import", IMPORT_RE.test(`import { x } from "y"`) && IMPORT_RE.test(`const m = await import("z")`))
  const DEMO_CARD = "app/dashboard/superadmin/demo-room/demo-stills-card.tsx"
  const HAND_MIRROR_RE = /\[\s*["']marketing_campaign["']\s*,\s*["'](product_video|campaign_video)["']/
  check("no client card hand-mirrors the use list any more — the demo-room card imports SCREENSHOT_USES from the rule", !HAND_MIRROR_RE.test(stripped(DEMO_CARD)) && /SCREENSHOT_USES/.test(stripped(DEMO_CARD)) && /@\/lib\/assets\/screenshot-uses/.test(src(DEMO_CARD)))
  check("CONTROL: the mirror finder catches the pre-84B literal", HAND_MIRROR_RE.test(`const USES = ["marketing_campaign", "product_video", "demo", "training"] as const`))

  console.log("\n[2c · the seam enforces it where every picker reads]")
  const zRow = (tags: string[], extra: Record<string, unknown> = {}) => ({ tags, metadata: { screenshot_kind: "public_page", estimate_source: "zillow_zestimate", ...extra } })
  const oldFour = ["use:marketing_campaign", "use:product_video", "use:demo", "use:training"]
  check("usesOfRow: a legacy Zestimate row tagged with the old four uses serves campaign + campaign video ONLY (the rule clamps demo/training/product_video)", usesOfRow(zRow(oldFour)).join() === "marketing_campaign,campaign_video")
  check("usesOfRow: an 83C-clamped Zestimate row (use:marketing_campaign) regains its campaign video (legacy lift, pre-84B rows only)", usesOfRow(zRow(["use:marketing_campaign"])).join() === "marketing_campaign,campaign_video")
  check("usesOfRow: an 84B-stamped Zestimate row a person narrowed to marketing_campaign stays narrowed (no lift)", usesOfRow(zRow(["use:marketing_campaign"], { uses_rule: SCREENSHOT_USES_RULE_VERSION })).join() === "marketing_campaign")
  check("usesOfRow: a legacy OS-surface row tagged with the whole old vocabulary serves EVERY current use (it meant 'everywhere')", usesOfRow({ tags: oldFour, metadata: { screenshot_kind: "os_surface" } }).length === SCREENSHOT_USES.length)
  check("usesOfRow: an untagged Zillow page row (source_url on zillow.com) = the Zestimate's uses; another portal's page / a retired comparison row = none",
    usesOfRow({ tags: [], metadata: { screenshot_kind: "public_page", source_url: ZILLOW } }).join() === "marketing_campaign,campaign_video"
    && usesOfRow({ tags: [], metadata: { screenshot_kind: "public_page", source_url: "https://www.redfin.com/x" } }).length === 0
    && usesOfRow({ tags: ["use:marketing_campaign"], metadata: { screenshot_kind: "public_page", comparison_only: true, estimate_source: "redfin_estimate" } }).length === 0)
  check("the comparison COMPOSITE (embeds the Zillow still) is judged as the Zestimate; its asset kind matches estimate-comparison.ts", screenshotSubjectOfRow({ metadata: { asset_kind: ESTIMATE_COMPARISON_ASSET_KIND } }) === "zillow_zestimate" && !screenshotRowUseAllowed({ tags: ["use:marketing_campaign"], metadata: { asset_kind: ESTIMATE_COMPARISON_ASSET_KIND } }, "image_library"))
  {
    const provider = providerConfirming((i) => i.readyWhen.map((r) => r.label)); const svc = makeSvc({ insertId: "still-uses" })
    await captureScreenshot({ kind: "public_page", url: ZILLOW_APEX, dayIso: "2026-09-26", owner: { brokerageId: TENANT, createdBy: null, uses: [...SCREENSHOT_USES] } }, { svc, provider, fetchRobots: robotsAllow, now: new Date("2026-09-26T00:00:00Z") })
    const row = svc.inserted[0] as any
    check("a tenant capture that ASKS for every use is written campaign + campaign video only (tags + metadata.uses), stamped with the rule version", !!row && (row.tags as string[]).filter((t) => t.startsWith("use:")).join() === "use:marketing_campaign,use:campaign_video" && row.metadata?.uses?.join() === "marketing_campaign,campaign_video" && row.metadata?.uses_rule === SCREENSHOT_USES_RULE_VERSION)
    const svcP = makeSvc({ insertId: "plat" }); const providerP = providerConfirming((i) => i.readyWhen.map((r) => r.label))
    await captureScreenshot({ kind: "public_page", url: ZILLOW_APEX, dayIso: "2026-09-27" }, { svc: svcP, provider: providerP, fetchRobots: robotsAllow, now: new Date("2026-09-27T00:00:00Z") })
    const prow = svcP.inserted[0] as any
    check("a PLATFORM Zillow capture is campaign + campaign video too (no demo/training/product-video/library stock)", !!prow && prow.metadata?.uses?.join() === "marketing_campaign,campaign_video" && prow.metadata?.usage === "marketing_campaign_material_never_customer_value")
  }
  {
    const svcW = makeSvc({ readRow: { id: "z1", tags: ["use:marketing_campaign"], metadata: { asset_kind: "screenshot", screenshot_kind: "public_page", estimate_source: "zillow_zestimate" } } })
    const w = await setScreenshotUses(svcW, "z1", ["marketing_campaign", "product_video"], { brokerageId: TENANT })
    check("setScreenshotUses REFUSES widening a Zestimate still to product_video — no update issued", !w.ok && /campaigns including their video only/.test(w.reason) && svcW.updates.length === 0)
    const svcP = makeSvc({ readRow: { id: "p1", tags: [], metadata: { asset_kind: "screenshot", screenshot_kind: "public_page", source_url: ZILLOW } } })
    const p = await setScreenshotUses(svcP, "p1", ["demo"])
    check("a PLATFORM Zillow page still with no recorded source is judged as the Zestimate — widening to demo refused", !p.ok && svcP.updates.length === 0)
    const svcOk = makeSvc({ readRow: { id: "z2", tags: [], metadata: { asset_kind: "screenshot", screenshot_kind: "public_page", estimate_source: "zillow_zestimate" } } })
    await setScreenshotUses(svcOk, "z2", ["marketing_campaign", "campaign_video"], { brokerageId: TENANT })
    check("POSITIVE CONTROL: campaign + campaign video proceeds to the counted update, stamped with the rule version", svcOk.updates.length === 1 && (svcOk.updates[0] as any).metadata?.uses_rule === SCREENSHOT_USES_RULE_VERSION)
    const svcG = makeSvc({ readRow: { id: "g1", tags: [], metadata: { asset_kind: "screenshot", screenshot_kind: "os_surface" } } })
    await setScreenshotUses(svcG, "g1", [...SCREENSHOT_USES])
    check("POSITIVE CONTROL: a GENERAL still may be widened to every use (84B — 83C's over-restriction is gone)", svcG.updates.length === 1)
  }
  {
    const narrowed = { id: "os1", asset_url: "https://cdn.example.test/os1.png", tags: ["use:demo"], metadata: { asset_kind: "screenshot", screenshot_kind: "os_surface", surface_id: "command_center", uses_rule: SCREENSHOT_USES_RULE_VERSION } }
    const forTraining = await listDemoStills(makeSvc({ readRow: narrowed }), { use: "training" })
    const forDemo = await listDemoStills(makeSvc({ readRow: narrowed }), { use: "demo" })
    check("the demo/training mounts obey a person's narrowing: a still narrowed to demo is a demo still, never a training figure", forTraining.size === 0 && forDemo.size === 1)
  }
  const seamCode = stripped(SEAM)
  check("the demo, product-video and training mounts each ask THE RULE for their use (stripped source)",
    /listDemoStills\(svc,\s*\{\s*use:\s*"demo"\s*\}\)/.test(seamCode) && /listDemoStills\(svc,\s*\{\s*use:\s*"product_video"\s*\}\)/.test(seamCode) && /listDemoStills\(svc,\s*\{\s*use:\s*"training"\s*\}\)/.test(stripped("lib/education/onboarding-authoring.ts")))
  const LIB = stripped("app/actions/marketing/image-library.ts")
  check("the image library admits a screenshot only through the rule (screenshotRowUseAllowed(r, \"image_library\")); a Zestimate is refused, a general still admitted",
    /screenshotRowUseAllowed\(r,\s*"image_library"\)/.test(LIB) && !/estimateStillUseVerdict/.test(LIB)
    && !screenshotRowUseAllowed(zRow(["use:marketing_campaign"]), "image_library") && screenshotRowUseAllowed({ tags: [], metadata: { screenshot_kind: "os_surface" } }, "image_library"))
  // A VIDEO path may stage a tenant still only as CAMPAIGN VIDEO material (84B — lane 84A's director
  // consumes approvedTenantStill(…, "campaign_video")). Every still-door call in lib/video must name
  // campaign_video; the 80D "any screenshot video" function never returns. Balanced-paren argument scan
  // over STRIPPED source (a tombstone naming the old function is not a call site).
  const STILL_DOOR_FNS = ["approvedTenantStill", "listTenantScreenshotStills", "tenantScreenshotUrlsForVideo", "listScreenshotStillsForUse", "screenshotUrlsForUse"]
  const callArgs = (code: string, fn: string): string[] => {
    const out: string[] = []; let from = 0
    for (;;) {
      const i = code.indexOf(`${fn}(`, from); if (i < 0) break
      if (/[\w$.]/.test(code[i - 1] ?? "") && code.slice(i - 1, i) !== ".") { from = i + 1; continue }
      let depth = 0, j = i + fn.length
      for (; j < code.length; j++) { if (code[j] === "(") depth++; else if (code[j] === ")") { depth--; if (depth === 0) break } }
      out.push(code.slice(i + fn.length + 1, j)); from = j
    }
    return out
  }
  // WAVE 85A — a tenant listing restricted to the GENERAL subject (`subject: "general"` — approved general
  // public-page stills, owner: "a public page screenshhot can be more than just zillow zestimate page.") may
  // serve any video: a general still serves every use by THE ONE RULE. Only the seam's own listings can carry
  // that filter; the Zestimate doors (approvedTenantStill / listTenantScreenshotStills) still need campaign_video.
  const GENERAL_ONLY_RE = /\bsubject:\s*["']general["']/
  const videoOffenders = (code: string): string[] => STILL_DOOR_FNS.flatMap((fn) => callArgs(code, fn).filter((a) => fn === "tenantScreenshotUrlsForVideo" || !/["']campaign_video["']/.test(a) && (fn !== "screenshotUrlsForUse" && fn !== "listScreenshotStillsForUse" || /includePublicPage:\s*true|brokerageId/.test(a) && !GENERAL_ONLY_RE.test(a))).map((a) => `${fn}(${a.slice(0, 50)})`))
  const walk = (dir: string): string[] => readdirSync(join(root, dir)).flatMap((n) => { const rel = `${dir}/${n}`; return statSync(join(root, rel)).isDirectory() ? walk(rel) : /\.tsx?$/.test(n) ? [rel] : [] })
  const videoFiles = walk("lib/video")
  const vOff = videoFiles.flatMap((f) => videoOffenders(stripComments(src(f))).map((o) => `${f}: ${o}`))
  console.log(`    video files swept: ${videoFiles.length} (lib/video/**)`)
  check("no video path stages a tenant/Zestimate still except as campaign_video (stripped lib/video/**)", vOff.length === 0, vOff.join("; "))
  check("POSITIVE CONTROL: the sweep flags the 80D director shape and a campaign-less door call; it passes the 84A shape",
    videoOffenders(`const urls = await tenantScreenshotUrlsForVideo(svc, b)`).length === 1
    && videoOffenders(`const s = await approvedTenantStill(svc, b, { address: norm(a) })`).length === 1
    && videoOffenders(`const s = await approvedTenantStill(svc, b, { address: norm(a) }, "campaign_video")`).length === 0
    && videoOffenders(`const u = await screenshotUrlsForUse(svc, "product_video", { limit: 8 })`).length === 0
    // 85A: a tenant listing narrowed to the general subject passes; the same listing WITHOUT it is caught.
    && videoOffenders(`const p = await listScreenshotStillsForUse(svc, a.use, { brokerageId: b, approvedOnly: true, subject: "general" })`).length === 0
    && videoOffenders(`const p = await listScreenshotStillsForUse(svc, a.use, { brokerageId: b, approvedOnly: true })`).length === 1
    && videoOffenders(`const s = await approvedTenantStill(svc, b, { address, subject: "general" })`).length === 1)
  const PB = stripped("app/actions/creative-playbooks.ts")
  check("the Zestimate Challenge's OWN campaign video gets the approved still only when the rule + the row admit campaign_video", /screenshotUrls: campaignVideoStillUrl \? \[campaignVideoStillUrl\] : \[\]/.test(PB) && /still\.uses\.includes\("campaign_video"\) && screenshotUseAllowed\("zillow_zestimate", "campaign_video"\)/.test(PB))

  console.log("\n[2d · GENERAL PUBLIC PAGES (85A) — more than the Zestimate page; other portals' estimates still nowhere]")
  // Owner verbatim (2026-09-26): "a public page screenshhot can be more than just zillow zestimate page."
  // THE ONE classifier (lib/marketing/estimate-sources.ts classifyPublicPage) decides; the seam stamps it;
  // the rule reads the stamp. Asserted as a table the owner's sentence implies, with positive controls.
  const GENERAL_PAGES = [
    "https://www.kling-group-homes.com/listings/123-main-st-austin-tx",   // a listing page on the tenant's own site
    "https://www.kling-group-homes.com/",                                  // the tenant's own landing page
    "https://www.austintexas.gov/department/planning",                     // a city page
    "https://www.greatschools.org/texas/austin/",                          // a school page
    "https://www.statesman.com/business/real-estate/",                     // a news / market page
    "https://www.mueller-hoa.org/amenities",                               // an HOA / community page
  ]
  const portalHosts = COMPARISON_ESTIMATE_SOURCES.map((s) => ({ key: s.key, url: `https://www.${s.host}/x/123-main-st` }))
  const ESTIMATE_PAGES = [
    ...portalHosts.filter((p) => p.key !== "zillow_zestimate").map((p) => p.url),     // every other comparison portal (derived)
    "https://www.trulia.com/home/123-main-st-austin-tx-78701-1",                        // Zillow Group's other portal (Trulia Estimate)
    "https://www.somebank.com/tools/home-value-estimator",                              // an estimator on any host (path names an estimate)
    "https://www.kling-group-homes.com/?tool=zestimate",                                // a query naming the Zestimate
    "ftp://files.example.org/x", "not a url",
  ]
  const classify = (u: string) => classifyPublicPage(u).subject
  const tableHolds = (f: (u: string) => ScreenshotSubject) =>
    GENERAL_PAGES.every((u) => f(u) === "general") && ESTIMATE_PAGES.every((u) => f(u) === "other_portal_estimate") && f(ZILLOW) === "zillow_zestimate"
  console.log(`    denominator: ${GENERAL_PAGES.length} general pages, ${ESTIMATE_PAGES.length} estimate / unclassifiable pages, 1 Zillow page`)
  check("classifyPublicPage: listing / own site / city / school / news / HOA pages are GENERAL; every other portal (derived from COMPARISON_ESTIMATE_SOURCES), Trulia, an estimator path and a non-URL are other_portal_estimate; Zillow is the Zestimate", tableHolds(classify),
    [...GENERAL_PAGES, ...ESTIMATE_PAGES, ZILLOW].map((u) => `${u} → ${classify(u)}`).join("; "))
  check("POSITIVE CONTROL: the table FAILS an 'everything public is general' classifier and the 84B 'every non-Zillow page serves nothing' classifier", !tableHolds(() => "general") && !tableHolds((u) => (/zillow\.com/.test(u) ? "zillow_zestimate" : "other_portal_estimate")))
  check("the path markers are DERIVED from the sources' own figure names (every marker carries the estimate stem and occurs in a source name or hint)",
    ESTIMATE_PAGE_PATH_MARKERS.length > 0 && ESTIMATE_PAGE_PATH_MARKERS.every((m) => m.includes("estimat") && COMPARISON_ESTIMATE_SOURCES.some((s) => [...s.estimateNames, s.searchHint].some((n) => n.toLowerCase().includes(m)))))
  const genRow = (extra: Record<string, unknown> = {}) => ({ tags: [] as string[], metadata: { asset_kind: "screenshot", screenshot_kind: "public_page", source_url: GENERAL_PAGES[0], page_subject: "general", ...extra } })
  check("the rule: a public page the seam stamped general serves EVERY use; the same row without the stamp serves NONE (fail closed); a Zillow page with a forged 'general' stamp is still the Zestimate",
    usesOfRow(genRow()).join() === SCREENSHOT_USES.join() && usesOfRow(genRow({ page_subject: undefined })).length === 0
    && usesOfRow(genRow({ source_url: ZILLOW })).join() === ZESTIMATE_SCREENSHOT_USES.join())
  check("a bare capture kind 'public_page' no longer implies the Zestimate — it serves nothing (ask by subject or by row)", screenshotUsesFor("public_page").length === 0 && screenshotUsesFor("os_surface").join() === SCREENSHOT_USES.join())
  {
    const plan = planScreenshotCapture({ kind: "public_page", url: GENERAL_PAGES[2] }, { siteOrigin: "" })
    check("the seam PLANS a general page (pageSubject general, no Zestimate readiness rule)", plan.ok && plan.pageSubject === "general" && plan.readyWhen.length === 0)
    const refusedEstimates = ESTIMATE_PAGES.slice(0, -2).map((u) => planScreenshotCapture({ kind: "public_page", url: u }, { siteOrigin: "" }))
    check("the seam REFUSES every other-portal / estimator page before anything runs (never captured)", refusedEstimates.every((r) => !r.ok && /never captured/.test(r.reason)))
    const SSRF = ["http://127.0.0.1/x", "http://169.254.169.254/latest/meta-data/", "http://localhost:3000/", "https://intranet.corp/x", "https://user:pw@www.statesman.com/", "https://www.statesman.com:8443/", "https://8.8.8.8/", "http://[::1]/"]
    const ssrfPlans = SSRF.map((u) => planScreenshotCapture({ kind: "public_page", url: u }, { siteOrigin: "" }))
    check(`the public-network guard refuses private / loopback / metadata / internal names, credentials, odd ports and IP literals (${SSRF.length} specimens)`, ssrfPlans.every((r) => !r.ok), SSRF.filter((_, i) => ssrfPlans[i].ok).join(", "))
    check("isPublicIpAddress: RFC1918 / loopback / link-local (metadata) / CGNAT / ULA / mapped-loopback are not public; 8.8.8.8 and a global v6 are (both sides controlled)",
      ["10.0.0.1", "172.16.5.4", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"].every((ip) => !isPublicIpAddress(ip))
      && ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"].every((ip) => isPublicIpAddress(ip)))
    check("requestHostRefusal (every browser request): data:/blob: pass; file:, a private literal and an internal name are refused; a public CDN passes",
      requestHostRefusal("data:image/png;base64,AA") === null && requestHostRefusal("file:///etc/passwd") !== null && requestHostRefusal("http://10.1.2.3/x") !== null && requestHostRefusal("https://svc.internal/x") !== null && requestHostRefusal("https://cdn.jsdelivr.net/x.js") === null)
    check("puppeteer enforces it per request (interception on, requestHostRefusal on every request, navigation refusal surfaced)", /setRequestInterception\(true\)/.test(seamCode) && /requestHostRefusal\(req\.url\(\)\)/.test(seamCode) && /publicNetworkOnly: true/.test(seamCode))
  }
  {
    const provider = providerConfirming(() => []); const svc = makeSvc({ insertId: "gen-1" })
    const r = await captureTenantPublicPageStill({ brokerageId: TENANT, userId: "u-1", url: GENERAL_PAGES[4], label: "Market news" }, { svc, provider, fetchRobots: robotsAllow, lookupHost: async () => ["93.184.216.34"], now: new Date("2026-09-26T00:00:00Z") })
    const row = svc.inserted[0] as any
    check("a tenant GENERAL capture lands PENDING in the tenant's assets with EVERY use, stamped page_subject=general, general usage, no estimate tag",
      r.ok && !!row && row.brokerage_id === TENANT && row.approval_status === "pending" && row.metadata?.page_subject === "general" && row.metadata?.usage === "general_material_every_use"
      && (row.tags as string[]).filter((t) => t.startsWith("use:")).length === SCREENSHOT_USES.length && !(row.tags as string[]).includes("estimate_still") && (row.tags as string[]).includes("public_page_still"))
    check("…and the row the seam wrote is general to THE RULE (image library admitted) — a general public page now SERVES", !!row && screenshotRowUseAllowed(row, "image_library") && screenshotRowUseAllowed(row, "training") && screenshotRowUseAllowed(row, "product_video"))
    check("the provider was asked to guard every request (publicNetworkOnly) and given no Zestimate readiness rule", provider.calls.length === 1 && provider.calls[0].publicNetworkOnly === true && provider.calls[0].readyWhen.length === 0)
    const pInward = providerConfirming(() => []); const svcIn = makeSvc()
    const inward = await captureTenantPublicPageStill({ brokerageId: TENANT, userId: null, url: GENERAL_PAGES[5] }, { svc: svcIn, provider: pInward, fetchRobots: robotsAllow, lookupHost: async () => ["93.184.216.34", "10.0.0.7"] })
    check("DNS guard: a host resolving to ANY private address is refused before robots, the browser and the insert", !inward.ok && /non-public address/.test(inward.reason) && pInward.calls.length === 0 && svcIn.inserted.length === 0)
    const pNo = providerConfirming(() => []); const svcNo = makeSvc()
    const nores = await captureTenantPublicPageStill({ brokerageId: TENANT, userId: null, url: GENERAL_PAGES[3] }, { svc: svcNo, provider: pNo, fetchRobots: robotsAllow, lookupHost: async () => { throw new Error("ENOTFOUND") } })
    check("DNS guard fails CLOSED: an unresolvable host is refused", !nores.ok && /did not resolve/.test(nores.reason) && pNo.calls.length === 0)
    const pRb = providerConfirming(() => []); const svcRb = makeSvc()
    const rb = await captureTenantPublicPageStill({ brokerageId: TENANT, userId: null, url: GENERAL_PAGES[1] }, { svc: svcRb, provider: pRb, fetchRobots: async () => "User-agent: *\nDisallow: /", lookupHost: async () => ["93.184.216.34"] })
    check("robots.txt is honoured for a general page exactly as for the Zestimate (the seam's existing gate)", !rb.ok && /robots\.txt/.test(rb.reason) && pRb.calls.length === 0)
    const pD = providerConfirming(() => []); const svcD = makeSvc()
    const viaDoor = await Promise.all([ZILLOW, ESTIMATE_PAGES[0], ESTIMATE_PAGES[ESTIMATE_PAGES.length - 5]].map((u) => captureTenantPublicPageStill({ brokerageId: TENANT, userId: null, url: u }, { svc: svcD, provider: pD, fetchRobots: robotsAllow, lookupHost: async () => ["93.184.216.34"] })))
    check("POSITIVE CONTROL: through the general door a Zillow page is sent to the Zestimate card and another portal / Trulia estimate page is REFUSED — nothing captured", viaDoor.every((x) => !x.ok) && /Zestimate card/.test((viaDoor[0] as { reason: string }).reason) && pD.calls.length === 0 && svcD.inserted.length === 0)
    const tenantPlan = planTenantPublicPageStill({ brokerageId: "", userId: null, url: GENERAL_PAGES[0] })
    check("the general door fails closed without the session tenant", !tenantPlan.ok)
    const pF = providerConfirming((i) => i.readyWhen.map((x) => x.label)); const svcF = makeSvc({ insertId: "forge" })
    // ZILLOW_APEX: section 3 keeps the www. host's per-host rate budget (PUBLIC_PAGE_RATE) for itself.
    await captureScreenshot({ kind: "public_page", url: ZILLOW_APEX, dayIso: "2026-09-28", owner: { brokerageId: TENANT, createdBy: null, provenance: { page_subject: "general" } } }, { svc: svcF, provider: pF, fetchRobots: robotsAllow, now: new Date("2026-09-28T00:00:00Z") })
    const forged = svcF.inserted[0] as any
    check("a caller cannot relabel a page: provenance page_subject='general' on a Zillow capture is overwritten by the seam's verdict (zillow_zestimate)", !!forged && forged.metadata?.page_subject === "zillow_zestimate" && usesOfRow(forged).join() === ZESTIMATE_SCREENSHOT_USES.join())
  }
  {
    // TASK 3 (84A open item): the organic social auto-post picker asks THE ONE RULE — an organic post belongs to
    // no marketing campaign, so it selects screenshots as image-library material; the Zestimate never qualifies.
    const pairing = stripped("lib/marketing/social-media-pairing.ts")
    check("the social auto-post picker asks the rule for image_library (isScreenshotRuleRow → screenshotRowUseAllowed) and selects metadata", /ORGANIC_SOCIAL_STILL_USE: ScreenshotUse = "image_library"/.test(pairing) && /!isScreenshotRuleRow\(r\) \|\| screenshotRowUseAllowed\(r, ORGANIC_SOCIAL_STILL_USE\)/.test(pairing) && /select\("id, asset_url, agent_user_id, tags, asset_name, metadata"\)/.test(pairing))
    const zStill = { id: "z-still", asset_url: "https://cdn.test/zestimate.png", agent_user_id: null, tags: ["screenshot", "use:marketing_campaign", "use:campaign_video"], asset_name: "Zestimate — 1 Main", metadata: { asset_kind: "screenshot", screenshot_kind: "public_page", estimate_source: "zillow_zestimate", uses_rule: SCREENSHOT_USES_RULE_VERSION } }
    const gStill = { id: "g-still", asset_url: "https://cdn.test/market.png", agent_user_id: null, tags: ["screenshot", ...SCREENSHOT_USES.map((u) => `use:${u}`)], asset_name: "Market page", metadata: genRow().metadata }
    const socialSvc = (rows: unknown[]) => ({ from: (t: string) => { const eqs: Record<string, unknown> = {}; const q: any = {}; for (const m of ["select", "not", "order", "limit", "gte", "in"]) q[m] = () => q; q.eq = (k: string, v: unknown) => { eqs[k] = v; return q }; q.maybeSingle = async () => ({ data: null, error: null }); q.then = (res: any, rej: any) => Promise.resolve({ data: t === "marketing_assets" && eqs.asset_type === "image" ? rows : [], error: null }).then(res, rej); return q } })
    const picked = await resolveSocialMedia(socialSvc([zStill, gStill]), { brokerageId: TENANT, platform: "linkedin", topicTitle: null })
    check("E2E: with the Zestimate still NEWEST in the library, the organic post pairs the GENERAL public-page still instead", picked?.assetId === "g-still" && picked?.source === "library")
    check("POSITIVE CONTROL: the unfiltered pick would have been the Zestimate (it is rows[0]); the rule refuses it for image_library", isScreenshotRuleRow(zStill) && !screenshotRowUseAllowed(zStill, "image_library") && screenshotRowUseAllowed(gStill, "image_library"))
  }

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

  console.log("\n[4 · the seam's uses stay many — every owner family has one]")
  // The owner's families: marketing (campaign + its video), assets (the library), videos (product),
  // guides/education (training modules), demos. Each must be a use a general still can serve.
  const FAMILIES: Record<string, string[]> = { marketing: ["marketing_campaign", "campaign_video"], assets: ["image_library"], videos: ["campaign_video", "product_video"], "guides/education": ["training"], demos: ["demo"] }
  check("every owner family (marketing / assets / videos / guides-education / demos) is a use a general still serves", Object.values(FAMILIES).every((us) => us.every((u) => (SCREENSHOT_USES as readonly string[]).includes(u) && screenshotUseAllowed("general", u))))
  const plan = planTenantStill({ brokerageId: TENANT, userId: "u", source: "zillow_zestimate", address: "123 Main St, Austin TX" })
  check("a tenant plan tags the Zestimate's uses (campaign + campaign video — never product_video) and carries mustShow", plan.ok && [...plan.uses].sort().join() === [...ZESTIMATE_SCREENSHOT_USES].sort().join() && !plan.uses.includes("product_video" as never) && plan.mustShow.join("+") === "property_photo+zestimate")
  check("the tenant card offers no product-video opt-in and derives its use list from ZESTIMATE_SCREENSHOT_USES", !/alsoForVideo|product_video/.test(stripped(CARD)) && /ZESTIMATE_SCREENSHOT_USES/.test(stripped(CARD)))

  console.log("\n[5 · surfaces]")
  const card = stripped(CARD)
  check("the tenant card has NO source picker (<select>) and shows the one source as a fixed line", !/<select/.test(card) && /DEFAULT_ESTIMATE_SOURCE/.test(card) && /sourceDef\.label/.test(card))
  const bad = planTenantStill({ brokerageId: TENANT, userId: "u", source: "redfin_estimate", address: "123 Main St, Austin TX" })
  check("the door refuses a retired key and its message is DERIVED from the vocabulary (names zillow_zestimate only)", !bad.ok && /\(zillow_zestimate\)/.test(bad.reason) && /ESTIMATE_SOURCE_KEYS\.join/.test(stripped(DOOR)))


  console.log("\n[6 · the Zestimate Challenge may quote the REAL Zestimate — as Zillow's, never ours]")
  // Owner (84B): "for the zestimate challenge it is oky to have a real number as we aren't using it as our true value".
  check("ZESTIMATE_FIGURE_PLAY_KEYS is the Zestimate Challenge alone, and it resolves to a real play", ZESTIMATE_FIGURE_PLAY_KEYS.length === 1 && ZESTIMATE_FIGURE_PLAY_KEYS.every((k) => !!getPlaybook(k)) && playMayQuoteZestimate("zestimate_challenge"))
  check("every OTHER play (the Estimate Comparison included) may not quote it", CREATIVE_PLAYBOOKS.filter((pb) => pb.key !== "zestimate_challenge").every((pb) => !playMayQuoteZestimate(pb.key)) && !playMayQuoteZestimate("estimate_comparison"))
  const attributed = (t: string, fig: string) => t.includes(fig) && /Zillow's Zestimate/.test(t) && /not an appraisal/.test(t) && /Never present it as the agent's value/.test(t) && /no other dollar value/.test(t)
  const line = zestimateFigureBrief("$512,300", "2026-09-26")
  check("the brief addendum carries the real figure, attributed to Zillow, dated, 'not an appraisal', never the agent's value", attributed(line, "$512,300") && /2026-09-26/.test(line))
  check("CONTROL: a bare figure line fails the attribution check", !attributed("Your home is worth $512,300.", "$512,300"))
  check("the install hands the figure ONLY for that play, ONLY a human-confirmed figure (validated), riding every brief of that install",
    /playMayQuoteZestimate\(playbook\.key\) && still\.figureUsd != null/.test(PB) && /validateConfirmedFigure\(still\.figureUsd\)/.test(PB) && /zestimateFigureLine \? `\$\{brief\}\\n\\n\$\{zestimateFigureLine\}` : brief/.test(PB))
  check("CONTROL: the gate finder rejects an ungated shape", !/playMayQuoteZestimate\(playbook\.key\) && still\.figureUsd != null/.test(stripComments(`if (still.figureUsd != null) zestimateFigureLine = zestimateFigureBrief(x, y)`)))
  // The AI ISA's home-value review CALLBACK still speaks no number: nothing the ISA / voice runs reads the figure.
  const FIGURE_READER_RE = /zestimateFigureBrief|ZESTIMATE_FIGURE_PLAY_KEYS|playMayQuoteZestimate|confirmed_figure_usd|confirmedFigureUsd/
  const isaFiles = [...walk("lib/ai-isa"), ...walk("lib/voice")]
  const isaReaders = isaFiles.filter((f) => FIGURE_READER_RE.test(stripComments(src(f))))
  console.log(`    ISA/voice files swept: ${isaFiles.length}`)
  check("no AI-ISA or voice module reads the Zestimate figure (the value-review callback speaks no number)", isaFiles.length > 0 && isaReaders.length === 0, isaReaders.join(", "))
  check("CONTROL: the reader finder catches a specimen ISA line reading the figure", FIGURE_READER_RE.test(stripComments(`const n = still.confirmedFigureUsd`)))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(" blind spots: no live navigation (the sandbox cannot reach zillow.com) — the selector rule is exercised on stubs that report what a real page would; Zillow can rename its test ids, in which case a live capture REFUSES (fail closed) rather than storing a still without the figure; the hosted adapter's :has() wait is asserted by source, not by a request.")
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ ZESTIMATE_ONLY_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
