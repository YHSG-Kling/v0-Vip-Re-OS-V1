#!/usr/bin/env tsx
/**
 * scripts/plan-asset-readiness-guard.ts  (npm run test:plan-asset-readiness) — pure, no network, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTONOMOUS VIDEOS READ THE PLAN, CHECK THE BUCKETS FIRST, CREATE ONLY WHAT IS
 * MISSING (wave 84, lane 84A). OWNER (2026-09-26, verbatim): "autonomous videos
 * need to read the plan and create whatever assets that are needed, first check
 * the buckets to see if assets are there."
 *
 * Asserted (the RULE; every number derived from the registries — CLAUDE.md §2):
 *   §plan      the wished plan is cut for EVERY registered composition that has a
 *              duration rule, and every asset-bound segment of it yields a
 *              requirement of the kind treatmentAssetNeed names (the ONE table);
 *              the finish's needs (music / brand logo / bookend stock) follow
 *              finish-spec × render-cut (the MLS cut requires no brand) (+ controls).
 *   §policy    every asset kind has a create policy; only photos (non-listing) and
 *              OS-surface screenshots are ever creatable; facts, the client's
 *              footage, licensed stock and the logo never are.
 *   §ladder    buckets BEFORE creation, on counting stubs: a full library means
 *              zero generation; a shortfall is generated, BOOKED and CAPTURED; a
 *              LISTING is never given a generated photo; a refused library read
 *              generates nothing (fail closed); an estimate still is never a photo
 *              (+ positive control that the still finder recognises one).
 *   §campaign  the Zestimate still reaches a video ONLY when the video is a
 *              verified campaign of this tenant AND the ONE use rule
 *              (lib/assets/screenshot-uses.ts screenshotUseAllowed — lane 84B's,
 *              re-exported by the seam) admits "campaign_video"; the still comes
 *              through 84B's door approvedTenantStill(…, "campaign_video"); a
 *              non-campaign video never even reads the tenant's stills.
 *   §degrade   end to end: a segment whose asset is neither found nor created
 *              falls to an allowed treatment, the fall is RECORDED with why, and the
 *              final plan passes the ONE gate — never silently empty.
 *   §wiring    every autonomous path goes through it: the director's two commission
 *              paths (before the row insert, stamped on the row), the topic runner
 *              (counted), the campaign playbook video (provenance stamped); the
 *              director's b-roll scope is agents.id, never users.id (+ control).
 *
 * BLIND SPOTS (published): the bucket reads and the image rail are exercised on
 * stubs (their SQL shape is proven by source, not against the live DB); the
 * wished inventory treats photos/screenshots/b-roll as obtainable, so a purpose
 * whose preferred visual is one of them always ASKS — whether a real tenant's
 * buckets hold it is only known at run time (the stamp records it).
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import {
  ASSET_CREATE_POLICY, CAMPAIGN_VIDEO_STILL_USE, MAX_CREATED_IMAGES_PER_VIDEO, READINESS_ASSET_KINDS,
  campaignStillProvenance, degradationsBetween, isStillRow, readinessStamp, readyVisualPlanForDispatch, requirementsFromPlan,
  resolvePlanAssets, wishfulInventory,
  type AssetRequirement, type ReadinessContext, type ReadinessDeps,
} from "../lib/video/plan-asset-readiness"
import {
  BROLL_PHOTO_SCARCITY, COMPOSITION_TREATMENTS, assetsFromProps, gateVisualPlanForDispatch, stageBodyVisualPlan, treatmentAssetNeed,
  type BodyVisualAssets,
} from "../lib/video/body-visual-model"
import { COMPOSITION_DURATION_RULES } from "../lib/video/duration-model"
import { finishForVideo } from "../lib/video/finish-spec"
import { finishForCut } from "../lib/video/render-cut"
import { screenshotUseAllowed } from "../lib/assets/screenshot-capture"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string): string => readFileSync(join(root, rel), "utf8")
const code = (rel: string): string => stripComments(read(rel))

let passed = 0, failed = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const SCRIPT = "Thinking about selling this spring? Here is what matters most. Buyers compare photos first. Pricing sets the pace of showings. Clean, bright rooms sell faster. Call me and we will map your plan together."
const ctxBase: ReadinessContext = { brokerageId: "b-1", agentId: "agent-row-1", agentUserId: "user-1", cut: "ads", subject: "spring selling tips" }

/** Counting stubs — every bucket and every creation door records its calls. */
function stubs(over: Partial<ReadinessDeps> & { library?: Array<{ id: string; url: string; tags: string[] | null; metadata: Record<string, unknown> | null }>; libraryError?: string | null; listing?: string[]; bookOk?: boolean } = {}) {
  const calls = { listing: 0, library: 0, generate: 0, book: 0, capture: 0, verify: 0, campaignStill: 0, os: 0, seed: 0, broll: 0, stock: 0 }
  const deps: ReadinessDeps = {
    readListingPhotos: async () => { calls.listing++; return { urls: over.listing ?? [], error: null } },
    readLibraryImages: async () => { calls.library++; return { rows: over.library ?? [], error: over.libraryError ?? null } },
    generateImage: async () => { calls.generate++; return { success: true, imageUrl: `https://cdn.test/gen-${calls.generate}.png`, cost: 0.04 } },
    bookImageSpend: async () => { calls.book++; return over.bookOk === false ? { ok: false, reason: "refused by stub" } : { ok: true, reason: null } },
    captureLibraryImage: async () => { calls.capture++; return { id: `lib-${calls.capture}`, reason: null } },
    verifyCampaign: async () => { calls.verify++; return { ok: true, reason: null } },
    campaignStill: async () => { calls.campaignStill++; return { id: "still-1", url: "https://cdn.test/zestimate.png" } },
    osStills: async () => { calls.os++; return [] },
    seedOsStill: async () => { calls.seed++; return { id: null, url: null, reason: "sandbox: no demo tenant" } },
    pickBroll: async () => { calls.broll++; return [] },
    pickStock: async () => { calls.stock++; return null },
    stockCategories: async () => ({ intro: "intro", outro: "outro" }),
    ...over,
  }
  return { deps, calls }
}
const svc = {} as unknown

async function main() {
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n── §plan · the plan is READ: every asset-bound segment becomes a requirement ──")
  {
    const ids = Object.keys(COMPOSITION_DURATION_RULES).filter((id) => COMPOSITION_TREATMENTS[id])
    let planned = 0, mismatches: string[] = []
    const kindsSeen = new Set<string>()
    for (const id of ids) {
      const spec = COMPOSITION_DURATION_RULES[id]
      const avatar = spec.host === "avatar"
      const empty: BodyVisualAssets = { avatarClip: avatar, brollClips: 0, propertyPhotos: 0, screenshots: 0 }
      // chapters: [] — MemoryVideoReel measures its body from its chapters (an empty memory still plans).
      const wished = stageBodyVisualPlan({ compositionId: id, props: { narrationScript: SCRIPT, chapters: [] }, avatarClip: avatar, script: SCRIPT, assets: wishfulInventory(empty, { cut: "ads" }) })
      if (!wished.ok) { mismatches.push(`${id}: ${wished.reason}`); continue }
      planned++
      const reqs = requirementsFromPlan(wished.plan, finishForVideo(id))
      for (const s of wished.plan.segments) {
        const need = treatmentAssetNeed(s.treatment)
        const want = need === "photos" ? "photos" : need === "screenshots" ? "screenshots" : need === "stats" ? "stat_cards" : need === "chart" ? "chart_data" : need === "broll" ? "broll" : need === "footage" ? "client_footage" : null
        if (!want) continue
        kindsSeen.add(want)
        const r = reqs.find((x) => x.kind === want)
        if (!r || !r.segments.includes(s.index)) mismatches.push(`${id} #${s.index} ${s.treatment} → no ${want} requirement`)
      }
      const f = finishForVideo(id)
      if (f.music !== reqs.some((r) => r.kind === "music")) mismatches.push(`${id}: music requirement ≠ finish.music`)
      if (f.bookends !== reqs.some((r) => r.kind === "bookend_stock")) mismatches.push(`${id}: bookend requirement ≠ finish.bookends`)
    }
    console.log(`    denominator: ${planned}/${ids.length} registered compositions planned; asset kinds the wished plans ask for: ${[...kindsSeen].sort().join(", ")}`)
    check("RULE: every registered composition's wished plan is cut, and every asset-bound segment yields a requirement of the kind treatmentAssetNeed names", planned === ids.length && mismatches.length === 0, mismatches.slice(0, 5).join(" | "))
    check("the wished plans actually ASK for photos and screenshots somewhere (the reader is not blind)", kindsSeen.has("photos") && kindsSeen.has("screenshots"))
    // POSITIVE CONTROL: a plan with a property_photos segment → a photos requirement ≥ BROLL_PHOTO_SCARCITY.
    const pw = stageBodyVisualPlan({ compositionId: "PhotoWalkthroughReel", props: {}, avatarClip: false, script: SCRIPT, assets: wishfulInventory({ avatarClip: false, brollClips: 0, propertyPhotos: 0, screenshots: 0 }, { cut: "ads" }) })
    const pwReq = pw.ok ? requirementsFromPlan(pw.plan, finishForVideo("PhotoWalkthroughReel")) : []
    check(`POSITIVE CONTROL: PhotoWalkthroughReel asks for ≥ ${BROLL_PHOTO_SCARCITY} photos ("enough photos" is the b-roll scarcity line, derived)`, (pwReq.find((r) => r.kind === "photos")?.count ?? 0) >= BROLL_PHOTO_SCARCITY)
    // NEGATIVE: a kinetic-text-only composition asks for no segment asset.
    const nl = stageBodyVisualPlan({ compositionId: "NewsletterDigestVideo", props: {}, avatarClip: false, script: SCRIPT, assets: wishfulInventory({ avatarClip: false, brollClips: 0, propertyPhotos: 0, screenshots: 0 }, { cut: "ads" }) })
    const nlReq = nl.ok ? requirementsFromPlan(nl.plan, finishForVideo("NewsletterDigestVideo")) : [{ kind: "photos" } as AssetRequirement]
    check("CONTROL: NewsletterDigestVideo (kinetic text + brand card) asks for no segment asset", nlReq.every((r) => r.segments.length === 0))
    // The MLS cut carries no brand → no brand logo / bookend stock requirement.
    const mlsReq = pw.ok ? requirementsFromPlan(pw.plan, finishForCut(finishForVideo("PhotoWalkthroughReel"), "mls")) : []
    const adsReq = pwReq
    check("the MLS cut requires no stock bookends (finishForCut drops them); the ads cut does", !mlsReq.some((r) => r.kind === "bookend_stock") && adsReq.some((r) => r.kind === "bookend_stock"))
    check("wishfulInventory never wishes for facts or the client's footage (stat cards / chart data / client clips stay as staged)", (() => {
      const w = wishfulInventory({ avatarClip: false, brollClips: 0, propertyPhotos: 0, screenshots: 0, statCards: 0, clientFootage: 0, chartData: false }, { cut: "ads" })
      return w.statCards === 0 && w.clientFootage === 0 && w.chartData === false && w.propertyPhotos >= BROLL_PHOTO_SCARCITY && w.screenshots >= 1
    })())
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n── §policy · where creating is honest ──")
  {
    check("every readiness asset kind has a create policy with a reason", READINESS_ASSET_KINDS.every((k) => !!ASSET_CREATE_POLICY[k] && ASSET_CREATE_POLICY[k].why.length > 20))
    const creatable = READINESS_ASSET_KINDS.filter((k) => ASSET_CREATE_POLICY[k].create !== "never")
    console.log(`    creatable: ${creatable.map((k) => `${k} (${ASSET_CREATE_POLICY[k].create})`).join(", ")}`)
    check("RULE: facts (stat cards, chart data), the client's own footage, licensed stock (b-roll, music, bookends) and the logo are NEVER created",
      (["stat_cards", "chart_data", "client_footage", "broll", "music", "bookend_stock", "brand_logo"] as const).every((k) => ASSET_CREATE_POLICY[k].create === "never"))
    check("photos are creatable for NON-listing videos only; screenshots only as platform OS surfaces", ASSET_CREATE_POLICY.photos.create === "non_listing_only" && ASSET_CREATE_POLICY.screenshots.create === "platform_os_surface")
    check(`cost-down: at most ${MAX_CREATED_IMAGES_PER_VIDEO} images are generated per video`, MAX_CREATED_IMAGES_PER_VIDEO > 0 && MAX_CREATED_IMAGES_PER_VIDEO <= BROLL_PHOTO_SCARCITY)
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n── §ladder · the buckets BEFORE creation (counting stubs) ──")
  const photoReq: AssetRequirement[] = [{ kind: "photos", count: BROLL_PHOTO_SCARCITY, segments: [1], wantedBy: "property_photos" }]
  {
    const lib = Array.from({ length: BROLL_PHOTO_SCARCITY }, (_, i) => ({ id: `a${i}`, url: `https://cdn.test/lib-${i}.jpg`, tags: ["reusable"], metadata: {} }))
    const s = stubs({ library: lib })
    const r = await resolvePlanAssets(svc, "AffordabilitySnapshotReel", {}, photoReq, ctxBase, s.deps)
    check("a library that already holds enough images → REUSED, zero images generated, zero spend booked", s.calls.library === 1 && s.calls.generate === 0 && s.calls.book === 0 && r.ledger.some((e) => e.kind === "photos" && e.status === "reused" && e.source === "marketing_assets") && (r.propsPatch.imageUrls as string[]).length === BROLL_PHOTO_SCARCITY)
  }
  {
    const zestimate = { id: "z1", url: "https://cdn.test/zestimate.png", tags: ["library", "screenshot", "public_page", "third_party_page", "estimate_still", "use:marketing_campaign"], metadata: { asset_kind: "screenshot", screenshot_kind: "public_page", estimate_source: "zillow_zestimate" } }
    check("POSITIVE CONTROL: the still finder recognises a Zestimate still row (and passes a plain library photo)", isStillRow(zestimate) && !isStillRow({ tags: ["reusable"], metadata: {} }))
    const s = stubs({ library: [zestimate, { id: "p1", url: "https://cdn.test/photo.jpg", tags: ["reusable"], metadata: {} }] })
    const r = await resolvePlanAssets(svc, "AffordabilitySnapshotReel", {}, photoReq, ctxBase, s.deps)
    const urls = (r.propsPatch.imageUrls as string[] | undefined) ?? []
    const created = r.ledger.find((e) => e.kind === "photos" && e.status === "created")
    check("an estimate still is NEVER used as a photo (the library pick skips it)", !urls.includes(zestimate.url))
    check("the shortfall is CREATED: generated, spend BOOKED and CAPTURED once per image, cost carried on the ledger",
      s.calls.generate === BROLL_PHOTO_SCARCITY - 1 && s.calls.book === s.calls.generate && s.calls.capture === s.calls.generate && !!created && created.count === s.calls.generate && (created.costCents ?? 0) === 4 * s.calls.generate,
      `generate ${s.calls.generate}, book ${s.calls.book}, capture ${s.calls.capture}`)
    check("reused and created are separate provenance entries (library first, then generated)", r.ledger.some((e) => e.status === "reused" && e.source === "marketing_assets") && r.ledger.some((e) => e.status === "created" && e.source === "generated:image") && urls.length === BROLL_PHOTO_SCARCITY)
  }
  {
    const s = stubs({ listing: [] })
    const r = await resolvePlanAssets(svc, "PhotoWalkthroughReel", {}, photoReq, { ...ctxBase, listingId: "listing-1" }, s.deps)
    check("RULE: a LISTING video is never given a generated photo — the listing's media bucket is read, nothing is generated, the gap is recorded",
      s.calls.listing === 1 && s.calls.generate === 0 && s.calls.library === 0 && r.ledger.some((e) => e.kind === "photos" && e.status === "missing" && /media bucket/.test(e.reason ?? "")))
    const s2 = stubs({ listing: ["https://cdn.test/l1.jpg", "https://cdn.test/l2.jpg", "https://cdn.test/l3.jpg"] })
    const r2 = await resolvePlanAssets(svc, "PhotoWalkthroughReel", { imageUrls: ["https://cdn.test/l1.jpg"] }, photoReq, { ...ctxBase, listingId: "listing-1" }, s2.deps)
    check("a listing with photos in listing_media → REUSED and merged with the staged ones (deduplicated)", (r2.propsPatch.imageUrls as string[]).length === 3 && r2.ledger.some((e) => e.status === "reused" && /listing_media/.test(e.source)))
  }
  {
    const s = stubs({ libraryError: "marketing_assets read refused: permission denied" })
    const r = await resolvePlanAssets(svc, "AffordabilitySnapshotReel", {}, photoReq, ctxBase, s.deps)
    check("FAIL CLOSED: a refused library read generates NOTHING (never pay against a library we could not see) and records the refusal", s.calls.generate === 0 && r.ledger.some((e) => e.status === "missing" && /permission denied/.test(e.reason ?? "")))
    const s2 = stubs({ bookOk: false })
    const r2 = await resolvePlanAssets(svc, "AffordabilitySnapshotReel", {}, photoReq, ctxBase, s2.deps)
    check("a refused spend booking is never silent — the created entry carries 'spend NOT booked'", r2.ledger.some((e) => e.status === "created" && /spend NOT booked/.test(e.reason ?? "")))
  }
  {
    // The DEFAULT listing_media reader: MLS cut keeps mls|both, unbranded only.
    const rows = [
      { file_url: "https://cdn.test/mls.jpg", usage_intent: "mls", has_logo_overlay: false, has_brokerage_attribution: false },
      { file_url: "https://cdn.test/both.jpg", usage_intent: "both", has_logo_overlay: false, has_brokerage_attribution: false },
      { file_url: "https://cdn.test/branded.jpg", usage_intent: "both", has_logo_overlay: true, has_brokerage_attribution: false },
      { file_url: "https://cdn.test/ads.jpg", usage_intent: "public_marketing", has_logo_overlay: false, has_brokerage_attribution: true },
    ]
    const preds: string[] = []
    const q: Record<string, unknown> = {}
    const chain = new Proxy(q, { get: (_t, k: string) => k === "then" ? (res: (v: unknown) => void) => res({ data: rows, error: null }) : (...a: unknown[]) => { preds.push(`${k}(${a.map(String).join(",")})`); return chain } })
    const fake = { from: (t: string) => { preds.push(`from(${t})`); return chain } }
    const mls = await resolvePlanAssets(fake, "PhotoWalkthroughReel", {}, photoReq, { ...ctxBase, listingId: "L", cut: "mls" }, { generateImage: async () => { throw new Error("must not generate") } })
    const mlsUrls = (mls.propsPatch.imageUrls as string[] | undefined) ?? []
    check("the listing_media read is tenant + listing scoped, approved photos only (source shape)", preds.includes("from(listing_media)") && preds.includes("eq(brokerage_id,b-1)") && preds.includes("eq(listing_id,L)") && preds.includes("eq(media_type,photo)") && preds.includes("eq(is_approved,true)"))
    check("MLS cut: only mls|both media with no logo overlay and no brokerage attribution", mlsUrls.length === 2 && mlsUrls.includes("https://cdn.test/mls.jpg") && mlsUrls.includes("https://cdn.test/both.jpg"), mlsUrls.join(","))
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n── §campaign · the Zestimate still reaches a CAMPAIGN video only, through the ONE rule ──")
  const shotReq: AssetRequirement[] = [{ kind: "screenshots", count: 1, segments: [1], wantedBy: "screenshot" }]
  {
    const ruleAdmits = screenshotUseAllowed("zillow_zestimate", CAMPAIGN_VIDEO_STILL_USE)
    console.log(`    the live rule today: screenshotUseAllowed("zillow_zestimate", "${CAMPAIGN_VIDEO_STILL_USE}") → ${ruleAdmits ? "admits" : "refuses"}`)
    check("the use this module asks for is 84B's campaign-video use, spelled once (the literal \"campaign_video\")", CAMPAIGN_VIDEO_STILL_USE === "campaign_video")
    check("CONTROL: the same rule refuses the Zestimate for a non-campaign use (product_video) — the predicate discriminates", !screenshotUseAllowed("zillow_zestimate", "product_video"))
    const s = stubs()
    const r = await resolvePlanAssets(svc, "ProductPromoReel", {}, shotReq, { ...ctxBase, campaignId: "camp-1" }, s.deps)
    const staged = ((r.propsPatch.imageUrls as string[] | undefined) ?? []).includes("https://cdn.test/zestimate.png")
    check("RULE: a verified campaign video stages the approved Zestimate still EXACTLY when the ONE use rule admits it (derived from the live rule, not pinned)", staged === ruleAdmits && s.calls.verify === 1 && s.calls.campaignStill === (ruleAdmits ? 1 : 0))
    const s2 = stubs()
    await resolvePlanAssets(svc, "ProductPromoReel", {}, shotReq, { ...ctxBase, campaignId: null }, s2.deps)
    check("a NON-campaign video never even reads the tenant's stills (verify 0, still door 0) — it falls to the OS stills / capture", s2.calls.verify === 0 && s2.calls.campaignStill === 0 && s2.calls.os === 1)
    const s3 = stubs({ stillUseAllowed: () => false })
    const r3 = await resolvePlanAssets(svc, "ProductPromoReel", {}, shotReq, { ...ctxBase, campaignId: "camp-1" }, s3.deps)
    check("POSITIVE CONTROL: when the rule refuses, the still is NOT staged even on a campaign video (the predicate is consumed, not bypassed)", !((r3.propsPatch.imageUrls as string[] | undefined) ?? []).includes("https://cdn.test/zestimate.png") && r3.ledger.some((e) => /use rule refuses the Zestimate/.test(e.reason ?? "") && s3.calls.campaignStill === 0))
    const s4 = stubs({ verifyCampaign: async () => ({ ok: false, reason: "campaign camp-x is not a marketing campaign of this brokerage" }) })
    const r4 = await resolvePlanAssets(svc, "ProductPromoReel", {}, shotReq, { ...ctxBase, campaignId: "camp-x" }, s4.deps)
    check("an unverified campaign id (another tenant's, a newsletter's) stages no still — FAIL CLOSED", s4.calls.campaignStill === 0 && !((r4.propsPatch.imageUrls as string[] | undefined) ?? []).length)
    const s5 = stubs({ osStills: async () => [{ id: "os-1", url: "https://cdn.test/os.png" }] })
    const r5 = await resolvePlanAssets(svc, "ProductPromoReel", {}, shotReq, ctxBase, s5.deps)
    check("OS stills are REUSED before any capture", s5.calls.seed === 0 && r5.ledger.some((e) => e.source === "os_surface_still" && e.status === "reused"))
    let seeded = 0
    const s6 = stubs({ seedOsStill: async () => { seeded++; return { id: "cap-1", url: "https://cdn.test/cap.png", reason: null } } })
    const r6 = await resolvePlanAssets(svc, "ProductPromoReel", {}, shotReq, ctxBase, s6.deps)
    check("no OS still → one is CAPTURED through the seam (created, platform OS surface), after the OS bucket was checked", s6.calls.os === 1 && seeded === 1 && r6.ledger.some((e) => e.status === "created" && e.source === "captured:os_surface"))
    check("the campaign playbook's still provenance: approved → reused; pending/captured → missing (never staged before approval)",
      campaignStillProvenance({ state: "approved", url: "u", assetId: "a" }).status === "reused" && campaignStillProvenance({ state: "captured", url: null, assetId: "a" }).status === "missing" && campaignStillProvenance({ state: "pending", url: null, assetId: null }).status === "missing"
      && campaignStillProvenance({ state: "approved", url: "u", assetId: "a" }, { forCampaignVideo: false }).status === "missing")
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n── §degrade · never silently empty: the fall is recorded, the gate holds ──")
  {
    const props = { narrationScript: SCRIPT, hook: "What the market is doing", beats: ["a", "b", "c"], cta: "Book a call" }
    const empty = stubs()
    const r = await readyVisualPlanForDispatch({ svc, compositionId: "ProductPromoReel", props, avatarClip: false, script: SCRIPT, ctx: { ...ctxBase, probeFinish: false }, deps: empty.deps })
    const wantedShots = r.stamp.wanted.filter((t) => t === "screenshot").length
    console.log(`    ProductPromoReel wanted [${r.stamp.wanted.join(", ")}] → final [${r.stamp.final.join(", ")}]; degradations ${r.stamp.degradations.length}`)
    check("with every bucket empty and capture refused, the plan still dispatches (ok) — the screenshot segments FELL to allowed treatments", r.ok && wantedShots > 0 && !r.stamp.final.includes("screenshot"))
    check("every fall is RECORDED with the ledger's why (missing screenshots + the reason)", r.stamp.degradations.length === r.stamp.wanted.filter((t, i) => t !== r.stamp.final[i]).length && r.stamp.degradations.every((d) => d.why.length > 10) && r.stamp.degradations.some((d) => /screenshots missing/.test(d.why)))
    const found = stubs({ osStills: async () => [{ id: "os-1", url: "https://cdn.test/os1.png" }, { id: "os-2", url: "https://cdn.test/os2.png" }] })
    const r2 = await readyVisualPlanForDispatch({ svc, compositionId: "ProductPromoReel", props, avatarClip: false, script: SCRIPT, ctx: { ...ctxBase, probeFinish: false }, deps: found.deps })
    check("with the OS stills in the bucket, the wanted screenshot segments are KEPT and the stills ride the props the composition reads (imageUrls)", r2.ok && r2.stamp.final.includes("screenshot") && Array.isArray(r2.props.imageUrls) && r2.stamp.degradations.length === 0)
    if (r2.ok) check("the final plan passes the ONE dispatch gate against the merged props", gateVisualPlanForDispatch(r2.plan, assetsFromProps(r2.props, { avatarClip: false, compositionId: "ProductPromoReel" })).ok)
    const boom = await readyVisualPlanForDispatch({ svc, compositionId: "ProductPromoReel", props, avatarClip: false, script: SCRIPT, ctx: { ...ctxBase, probeFinish: false }, deps: { ...empty.deps, osStills: async () => { throw new Error("bucket exploded") } } })
    check("a THROWING bucket is contained: recorded as missing with the error, the plan degrades, nothing is assumed", boom.ok && boom.stamp.ledger.some((e) => e.status === "missing" && /bucket exploded/.test(e.reason ?? "")))
    const unknown = await readyVisualPlanForDispatch({ svc, compositionId: "NoSuchReel", props, avatarClip: false, ctx: ctxBase, deps: empty.deps })
    check("an unregistered composition is BLOCKED (body_visual_unplanned), never rendered unplanned", !unknown.ok && unknown.violations.includes("body_visual_unplanned"))
    const stamp = readinessStamp(null, null, [{ kind: "photos", status: "created", source: "generated:image", count: 2, urls: [], assetIds: [], costCents: 8 }], [])
    check("the stamp counts reused / created / missing and sums the creation spend", stamp.created === 1 && stamp.cost_cents === 8 && stamp.reused === 0)
    check("degradationsBetween is empty for identical plans (control)", r2.ok && degradationsBetween(r2.plan, r2.plan, []).length === 0)
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n── §wiring · every autonomous path goes through it (stripped source) ──")
  {
    const director = code("lib/video/video-director.ts")
    const insertAt = [...director.matchAll(/\.from\("ai_video_projects"\)\s*\.insert\(/g)].map((m) => m.index ?? -1)
    const readyAt = [...director.matchAll(/readyVisualPlanForDispatch\(\{/g)].map((m) => m.index ?? -1)
    check("the director's two commission paths call readyVisualPlanForDispatch, each BEFORE its ai_video_projects insert", readyAt.length === 2 && insertAt.length >= 2 && readyAt.every((g, i) => insertAt[i] !== undefined && g < insertAt[i]), `ready ${readyAt.join(",")} insert ${insertAt.join(",")}`)
    check("both paths stamp asset_readiness on the row and stage the readiness props patch", (director.match(/asset_readiness: readiness\.stamp/g) ?? []).length === 2 && (director.match(/\.\.\.readyPatch,|\.\.\.readiness\.propsPatch,/g) ?? []).length === 2)
    check("the director hands the readiness pass agents.id (directorAgentId) and the verified campaign id", (director.match(/agentId: directorAgentId, agentUserId: opts\.agentUserId/g) ?? []).length === 2 && (director.match(/campaignId: opts\.campaignId \?\? null/g) ?? []).length >= 2)
    const usersScope = /scopeType:\s*"agent",\s*scopeId:\s*opts\.agentUserId/
    check("IDENTITY: the director's b-roll pick no longer scopes an agent by users.id", !usersScope.test(director) && /scopeType:\s*"agent",\s*scopeId:\s*directorAgentId/.test(director))
    check("POSITIVE CONTROL: the identity finder recognises the users.id shape it replaced", usersScope.test(`scopeType:   "agent",\n          scopeId:     opts.agentUserId,`))
    const topic = code("lib/video/topic-video-runner.ts")
    check("the topic runner COUNTS the readiness outcome of every commission (reused / created / missing / degraded / spend)", /r\.assetReadiness/.test(topic) && /out\.assets\.created \+= r\.assetReadiness\.created/.test(topic) && /degradations\.length/.test(topic))
    const playbooks = code("app/actions/creative-playbooks.ts")
    check("the campaign playbook video stamps its still's provenance (campaignStillProvenance → asset_readiness)", /campaignStillProvenance\(still, \{ forCampaignVideo: !!campaignVideoStillUrl \}\)/.test(playbooks) && /asset_readiness:/.test(playbooks) && /stillLedger,/.test(playbooks))
    const mod = code("lib/video/plan-asset-readiness.ts")
    check("the module CONSUMES 84B's rule (screenshotUseAllowed from the seam) and door (approvedTenantStill(…, \"campaign_video\")), restating no use list", /import \{ screenshotUseAllowed \} from "@\/lib\/assets\/screenshot-capture"/.test(mod) && /approvedTenantStill\(svc, a\.brokerageId, \{ address: a\.address \}, "campaign_video"\)/.test(mod) && !/ZESTIMATE_SCREENSHOT_USES|ZESTIMATE_STILL_USES|PUBLIC_PAGE_STILL_USES|SCREENSHOT_USE_RULE/.test(mod))
    check("creation books on the cost ledger (ai_tool_usage insert, counted) and captures into the library", /\.from\("ai_tool_usage"\)\.insert\(/.test(mod) && /\.select\("id"\)/.test(mod) && /\.from\("marketing_assets"\)\.insert\(/.test(mod))
    check("the readiness module reuses the survivors (pickBrollClips, pickStockAsset, listScreenshotStillsForUse, seedMissingDemoStill, generateImage, approvedTenantStill)",
      ["pickBrollClips", "pickStockAsset", "listScreenshotStillsForUse", "seedMissingDemoStill", "generateImage", "approvedTenantStill"].every((f) => new RegExp(`\\b${f}\\b`).test(mod)))
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(`FAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
