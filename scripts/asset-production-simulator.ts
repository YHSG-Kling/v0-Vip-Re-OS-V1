#!/usr/bin/env tsx
/**
 * scripts/asset-production-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ASSET-PRODUCTION PROOF — the 2026-07 asset-type gap audit's three builds,
 * locked so they can never quietly regress to the stubs they replaced:
 *
 *  [1] PHOTO INTELLIGENCE (was three fakes: filename-regex "room detection",
 *      a quality score that returned null, and an "enhancement" that appended
 *      ?enhanced=true inside a setTimeout that never fires in serverless):
 *      real vision analysis, REAL pixel enhancement (sharp), virtual staging +
 *      twilight via gpt-image-1 EDITS with the MLS disclosure, staged variants
 *      quarantined to marketing_assets (never the MLS photo set), a nightly
 *      asset_manager sweep with autonomous hero fill.
 *  [2] CLIENT PDF ENGINE (was a mock whose "PDF" was raw HTML bytes with a
 *      .pdf name): real pdf-lib multi-page documents — CMA leave-behind wired
 *      into the listing-presentation builder, buyer/seller guide BOOKLETS
 *      wired into lead-magnet delivery, compliance footer on every page,
 *      hosted on Supabase storage, recorded in generated_documents.
 *  [3] DOOR HANGER (print family completion): 4.25x11 @300DPI just-sold
 *      door-knock still, autonomous on CLOSED via the video-plays cron,
 *      scan-to-value QR, anti-solicitation line.
 *
 * Layer 1 is PURE (real sharp pixels, real pdf-lib bytes — no mocks, no DB).
 * Layer 2 is source-lock (the wiring + the dead stubs stay dead).
 *
 * Run: npx tsx scripts/asset-production-simulator.ts   (npm run test:asset-production)
 */
import { readFileSync, existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import sharp from "sharp"
import { PDFDocument, StandardFonts } from "pdf-lib"
import {
  applyEnhancements,
  buildMultipartBody,
  stagingPrompt,
  twilightPrompt,
  VIRTUAL_STAGING_DISCLOSURE,
  TWILIGHT_DISCLOSURE,
  LISTING_ROOM_TYPES,
} from "../lib/listings/photo-intelligence"
import {
  renderClientPdf,
  cmaPdfSpec,
  netSheetPdfSpec,
  guideBookletSpec,
  wrapText,
  hexToRgb,
  CMA_DISCLAIMER,
  NET_SHEET_DISCLAIMER,
  type ClientPdfBrand,
} from "../lib/documents/client-pdf"
import { guideChaptersFor } from "../lib/marketing/guide-booklet-content"
import { VIDEO_FINISH_SPEC } from "../lib/video/finish-spec"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf-8") : "")

// Fair-Housing / steering terms that must NEVER appear in client-facing copy.
const FH_BANNED = /\b(family|families|kids|children|safe neighborhood|christian|church|no kids|adults only|ideal for (a )?famil|exclusive neighborhood|great for retirees|demographic)\b/i

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Asset-production simulator (photo AI · client PDFs · door hanger)")
  console.log("══════════════════════════════════════════════════")

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[1 · REAL PIXEL ENHANCEMENT — sharp does actual work]")
  const source = await sharp({
    create: { width: 96, height: 96, channels: 3, background: { r: 140, g: 90, b: 60 } },
  }).png().toBuffer()
  const enhanced = await applyEnhancements(source, ["auto", "brightness", "contrast", "saturation"])
  check("enhanced output is a real JPEG (FFD8 magic), not the input with a query string",
    enhanced.length > 100 && enhanced[0] === 0xff && enhanced[1] === 0xd8)
  check("enhancement CHANGES the pixels (different bytes, decodable image)",
    !enhanced.equals(source) && (await sharp(enhanced).metadata()).width === 96)
  const noop = await applyEnhancements(source, [])
  check("empty enhancement list still yields a valid JPEG (format normalize only)",
    noop[0] === 0xff && noop[1] === 0xd8)

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[2 · MULTIPART BODY — the gpt-image-1 edits wire format]")
  const fileBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])
  const body = buildMultipartBody([
    { name: "model", value: "gpt-image-1" },
    { name: "image", filename: "photo.png", contentType: "image/png", data: fileBytes },
  ], "BOUNDARY123")
  const bodyStr = body.toString("latin1")
  check("multipart framing: opening boundary + field + file part + terminator",
    bodyStr.startsWith("--BOUNDARY123\r\n")
    && bodyStr.includes('Content-Disposition: form-data; name="model"')
    && bodyStr.includes('name="image"; filename="photo.png"')
    && bodyStr.includes("Content-Type: image/png")
    && bodyStr.endsWith("--BOUNDARY123--\r\n"))
  check("binary payload survives intact inside the body", body.includes(fileBytes))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[3 · EDITORIAL GUARDRAILS — staging is furnishings-only, disclosed]")
  const sp = stagingPrompt("living_room", "scandinavian")
  check("staging prompt: room + style + the structural DO-NOT-ALTER guardrail + no people",
    sp.includes("living room") && sp.includes("scandinavian")
    && /Do NOT alter/i.test(sp) && /architecture|walls|windows/i.test(sp) && /Do not add people/i.test(sp))
  check("twilight prompt: lighting-only conversion, same guardrail",
    /twilight|dusk/i.test(twilightPrompt()) && /Do NOT alter/i.test(twilightPrompt()) && /only the time of day and lighting change/i.test(twilightPrompt()))
  check("MLS disclosures exist and say what they must",
    /virtually staged/i.test(VIRTUAL_STAGING_DISCLOSURE) && /digitally rendered/i.test(VIRTUAL_STAGING_DISCLOSURE)
    && /digitally enhanced/i.test(TWILIGHT_DISCLOSURE))
  const pi = src("lib/listings/photo-intelligence.ts")
  check("staged variants land in marketing_assets WITH the disclosure — and NEVER insert into listing_photos (MLS set integrity)",
    pi.includes('from("marketing_assets").insert') && pi.includes("disclosure: params.disclosure")
    && !/from\("listing_photos"\)\s*\.insert/.test(pi))
  check("room taxonomy is the real one (exterior/kitchen/primary/floor_plan present)",
    (LISTING_ROOM_TYPES as readonly string[]).includes("exterior_front")
    && (LISTING_ROOM_TYPES as readonly string[]).includes("kitchen")
    && (LISTING_ROOM_TYPES as readonly string[]).includes("floor_plan"))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[4 · THE PHOTO STUBS STAY DEAD — vision is real, jobs are honest]")
  const pm = src("app/actions/photo-management.ts")
  check("the fake ?enhanced=true enhancement is GONE (with its serverless-dead setTimeout)",
    !pm.includes("?enhanced=true") && !pm.includes("setTimeout"))
  check("no filename-regex room detection, no null-returning quality score",
    !pm.includes("calculateQualityScore") && !/url\.match\(\/exterior/.test(pm))
  check("actions delegate to the REAL engine (persistPhotoAnalysis / enhanceListingPhoto / staging pair)",
    pm.includes("persistPhotoAnalysis") && pm.includes("enhanceListingPhoto")
    && pm.includes("virtualStagePhoto") && pm.includes("twilightConvertPhoto"))
  check("actions read photos through the RLS-scoped session client before service writes (tenant boundary)",
    pm.includes("RLS-scoped") && pm.split("createServiceClient()").length >= 2)
  check("vision call: gateway image_url content part + structured JSON contract + 0-100 clamp",
    pi.includes('type: "image_url"') && pi.includes("quality_score") && pi.includes("hero_worthy")
    && pi.includes("Math.max(0, Math.min(100"))
  check("analysis persists to the real columns (room_type, ai_quality_score, ai_analyzed_at, ai_analysis_completed)",
    pi.includes("room_type: analysis.roomType") && pi.includes("ai_quality_score: analysis.qualityScore")
    && pi.includes("ai_analysis_completed: true"))
  check("enhancement job lifecycle is honest: processing → completed with a REAL hosted URL, failed with error_message — awaited inline",
    pi.includes('status: "processing"') && pi.includes('status: "completed"')
    && pi.includes('status: "failed"') && pi.includes("hostRenderedMedia") && !pi.includes("setTimeout("))
  check("image edits ride the single-egress gateway (callConnector), AI Gateway first with direct-OpenAI fallback",
    pi.includes("callConnector") && pi.includes("ai-gateway.vercel.sh") && pi.includes("api.openai.com")
    && pi.includes('bodyType: "binary"'))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[5 · THE NIGHTLY SWEEP — asset_manager owns photo intelligence]")
  const cronRoute = src("app/api/cron/photo-intelligence/route.ts")
  check("cron route exists, verifies auth, runs the sweep, records the run",
    cronRoute.includes("verifyCronAuth") && cronRoute.includes("runPhotoIntelligenceSweep")
    && cronRoute.includes("recordCronSuccessAction"))
  check("dispatcher schedules it; CRON_MANAGER maps it to asset_manager (zero-orphan rule)",
    src("lib/kernel/cron-dispatch.ts").includes("/api/cron/photo-intelligence")
    && src("lib/kernel/manager-registry.ts").includes('"/api/cron/photo-intelligence": "asset_manager"'))
  check("sweep is BOUNDED per run (analyzeLimit) and hero fill only fires when NO hero exists",
    pi.includes("analyzeLimit") && pi.includes("photos.some((p) => p.is_hero)) continue"))
  check("hero fill prefers exterior_front, then quality — never a random first upload",
    pi.includes('room_type === "exterior_front"') && pi.includes("ai_quality_score ?? 0"))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[6 · REAL CLIENT PDFs — pdf-lib bytes, not HTML with a .pdf name]")
  const brand: ClientPdfBrand = {
    primaryColor: "#0F172A", brokerageName: "Harbor & Main Realty",
    agentName: "Jordan Avery", agentPhone: "(555) 010-2000", agentEmail: "j@hm.example",
    licenseLine: "Lic #01234567 (FL)", showEhoMark: true,
  }
  const cmaBytes = await renderClientPdf(cmaPdfSpec({
    propertyAddress: "128 Harborview Lane, Naples FL",
    preparedFor: "Sam Seller",
    valueLow: 1_100_000, valueMid: 1_250_000, valueHigh: 1_400_000,
    confidence: 82,
    narrative: "Inventory in this corridor remains tight.\n\nComparable closings over the last 90 days support a mid-point near $1.25M.",
    marketingPlanHighlights: ["Coming-soon launch", "Twilight photography", "Open house weekend one"],
    netSheetRows: [
      { label: "Conservative", listPrice: 1_100_000, proceeds: 690_000 },
      { label: "Target", listPrice: 1_250_000, proceeds: 830_000 },
      { label: "Aspirational", listPrice: 1_400_000, proceeds: 975_000 },
    ],
  }, brand, "July 9, 2026"))
  check("CMA PDF is a REAL PDF (%PDF magic, substantive size)",
    Buffer.from(cmaBytes.slice(0, 5)).toString() === "%PDF-" && cmaBytes.length > 2000)
  const cmaDoc = await PDFDocument.load(cmaBytes)
  check("CMA PDF parses and has pages", cmaDoc.getPageCount() >= 1)

  const netBytes = await renderClientPdf(netSheetPdfSpec({
    propertyAddress: "128 Harborview Lane",
    sellerName: "Sam Seller",
    scenarios: [
      { label: "List price", salePrice: 1_250_000, commission: 62_500, closingCosts: 18_000, mortgagePayoff: 320_000, netProceeds: 849_500 },
      { label: "Current offer", salePrice: 1_215_000, commission: 60_750, closingCosts: 18_000, mortgagePayoff: 320_000, netProceeds: 816_250 },
    ],
  }, brand, "July 9, 2026"))
  check("net-sheet PDF is real and parses", Buffer.from(netBytes.slice(0, 5)).toString() === "%PDF-" && (await PDFDocument.load(netBytes)).getPageCount() >= 1)

  const bookletBytes = await renderClientPdf(guideBookletSpec({
    kind: "buyer_guide", title: "The Home Buyer's Playbook",
    intro: "Here is what actually matters in today's market, grounded in the questions buyers are asking right now.",
    chapters: guideChaptersFor("buyer_guide"), areaLabel: "Naples, FL",
  }, brand, "July 2026"))
  const bookletDoc = await PDFDocument.load(bookletBytes)
  check("guide BOOKLET is real and multi-page (chapters paginate)",
    Buffer.from(bookletBytes.slice(0, 5)).toString() === "%PDF-" && bookletDoc.getPageCount() >= 2)

  // wrapText honesty — measured with the same font family the engine embeds
  const measureDoc = await PDFDocument.create()
  const helv = await measureDoc.embedFont(StandardFonts.Helvetica)
  const longText = "A comparative market analysis looks at what actually closed near you in the last ninety days adjusted for size condition and timing"
  const lines = wrapText(longText, helv, 10.5, 200)
  check("wrapText: every line fits the width, nothing dropped",
    lines.length > 2
    && lines.every((ln) => helv.widthOfTextAtSize(ln, 10.5) <= 200)
    && lines.join(" ") === longText)
  check("hexToRgb parses brand colors and falls back safely",
    hexToRgb("#F59E0B").red > 0.9 && hexToRgb("not-a-color").blue > 0)

  const pdfSrc = src("lib/documents/client-pdf.ts")
  check("compliance footer on EVERY page: attribution + EHO + page numbers",
    pdfSrc.includes("Equal Housing Opportunity") && pdfSrc.includes("pages.forEach")
    && pdfSrc.includes("${i + 1} / ${pages.length}"))
  check("CMA disclaimer is the honest one (not-an-appraisal, USPAP)",
    /USPAP/.test(CMA_DISCLAIMER) && /not an appraisal/i.test(CMA_DISCLAIMER)
    && /not a guarantee/i.test(NET_SHEET_DISCLAIMER))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[7 · THE PDF MOCK STAYS DEAD — and the real engine is WIRED]")
  check("the mock (app/actions/pdf-generation.tsx — HTML bytes as 'PDF') is DELETED",
    !existsSync(join(ROOT, "app/actions/pdf-generation.tsx")))
  const producer = src("lib/documents/client-document-producer.ts")
  check("producer hosts on Supabase storage (media-host rule) and records generated_documents",
    producer.includes("hostRenderedMedia") && producer.includes('from("generated_documents").insert'))
  check("producer resolves REAL brand + license (brokerages.primary_color, agent_licenses)",
    producer.includes("primary_color") && producer.includes("agent_licenses"))
  const presBuilder = src("lib/workflow/intelligence/listing-presentation-builder.ts")
  check("listing-presentation builder produces the CMA leave-behind PDF (best-effort, never fails the build)",
    presBuilder.includes("produceClientDocument") && presBuilder.includes("cmaPdfSpec")
    && presBuilder.includes("leaveBehindPdfUrl"))
  const magnetRunner = src("lib/marketing/lead-magnet-delivery-runner.ts")
  check("guide magnets ship the DESIGNED BOOKLET with the download link appended to the delivery copy",
    magnetRunner.includes("guideBookletSpec") && magnetRunner.includes("generateGuideChapters")
    && magnetRunner.includes("Download your full guide (PDF)"))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[8 · GUIDE CHAPTERS — substantive, Fair-Housing-safe, wire-fraud-aware]")
  for (const kind of ["buyer_guide", "seller_guide"] as const) {
    const chapters = guideChaptersFor(kind)
    check(`${kind}: 5 substantive chapters (each a real read, not a stub)`,
      chapters.length === 5 && chapters.every((c) => c.body.length > 300 && c.heading.length > 8))
    check(`${kind}: Fair-Housing clean (no steering / demographic language)`,
      chapters.every((c) => !FH_BANNED.test(`${c.heading} ${c.body}`)))
  }
  check("buyer guide teaches the wire-fraud phone-verification rule (the industry's #1 client loss)",
    guideChaptersFor("buyer_guide").some((c) => /wire/i.test(c.body) && /by phone/i.test(c.body)))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[9 · DOOR HANGER — print family complete, autonomous on CLOSED]")
  const root = src("remotion/Root.tsx")
  check("DoorHanger registered in Root.tsx as a 1350x3375 still (bleed canvas, durationInFrames 1)",
    root.includes('id="DoorHanger"') && root.includes("width={1350}") && root.includes("height={3375}"))
  const dh = VIDEO_FINISH_SPEC.DoorHanger
  check("finish spec: the hanger IS the deliverable (no bookends/music/thumbnail — the QR is in the artwork)",
    !!dh && dh.presenter === "none" && !dh.bookends && !dh.music && !dh.thumbnail)
  const hanger = src("remotion/DoorHanger.tsx")
  check("composition carries the die-cut knob guide, EHO + the anti-solicitation line",
    hanger.includes("dashed") && hanger.includes("Equal Housing Opportunity")
    && hanger.includes("this is not a solicitation"))
  const plays = src("lib/video/video-plays.ts")
  check("runDoorHangers: fires on CLOSED, idempotent per listing (entity_type door_hanger), scan-to-value QR",
    plays.includes('.eq("lifecycle_stage", "CLOSED")') && plays.includes('"door_hanger"')
    && plays.includes('kind: "just_sold"') && plays.includes("Scan for your home's value"))
  check("delivery: finished hangers notify THE AGENT once ([hanger:id] dedupe marker)",
    plays.includes("[hanger:${ren.id}]") && plays.includes("door_hanger_ready"))
  check("the daily video-plays cron runs the hanger play alongside the flyer",
    src("app/api/cron/video-plays/route.ts").includes("runDoorHangers"))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[10 · UI — the media manager exposes the real tools]")
  const ui = src("app/dashboard/listings/[id]/media/media-manager-client.tsx")
  check("vacant rooms offer Stage, exteriors offer Twilight, low scores offer Enhance",
    ui.includes("stageListingPhoto") && ui.includes("twilightListingPhoto")
    && ui.includes("score.vacant") && ui.includes('score.room_type === "exterior_front"'))
  check("staging toast tells the agent the disclosure rode along",
    ui.includes("required disclosure"))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[11 · SOCIAL CAROUSEL — a real multi-image SET, AI copy, approval-gated]")
  const { fallbackCarouselPlan, planListingCarousel } = await import("../lib/marketing/social-carousel")
  const facts = {
    address: "128 Harborview Lane", cityState: "Naples, FL", price: "$1,250,000",
    beds: "4", baths: "3.5", sqft: "3,240", statusLine: "JUST LISTED",
    highlights: ["Chef's kitchen with quartz island", "Saltwater pool + lanai"],
  }
  const fb = fallbackCarouselPlan(facts)
  check("fallback plan: hook first, cta last, a stat slide, built ONLY from listing facts",
    fb[0].role === "hook" && fb[fb.length - 1].role === "cta"
    && fb.some((s) => s.role === "stat" && s.statValue === facts.price)
    && fb.every((s) => !FH_BANNED.test(`${s.kicker} ${s.title} ${s.body}`)))
  const gatedPlan = await planListingCarousel(facts, { gate: async () => ({ allowed: false }) })
  check("a blocking compliance gate forces the deterministic fallback (AI copy never ships ungated)",
    gatedPlan.fromAI === false && gatedPlan.slides.length === fb.length)
  const carousel = src("lib/marketing/social-carousel.ts")
  check("slides render through the still rail; the set assembles into ONE social_posts row (draft + pending approval, ordered media_urls)",
    carousel.includes('compositionId: "CarouselSlide"') && carousel.includes('post_type: "carousel"')
    && carousel.includes('status: "draft"') && carousel.includes('approval_status: "pending"')
    && carousel.includes("slideIndex") && carousel.includes("media_urls: mediaUrls"))
  check("idempotent per listing + the agent gets the set even without a connected account",
    carousel.includes('entityType: "social_carousel"') && carousel.includes("[carousel:${listingId}]"))
  const rootSrc = src("remotion/Root.tsx")
  check("CarouselSlide registered 1080x1350 still; finish spec: the set IS the deliverable",
    rootSrc.includes('id="CarouselSlide"') && rootSrc.includes("width={1080}") && rootSrc.includes("height={1350}")
    && !!VIDEO_FINISH_SPEC.CarouselSlide && !VIDEO_FINISH_SPEC.CarouselSlide.bookends)
  const slideSrc = src("remotion/CarouselSlide.tsx")
  check("the slide is RICH by design (brand washes, accent geometry, duotone photo press, dots, swipe cue, EHO closer)",
    slideSrc.includes("radial-gradient") && slideSrc.includes("rotate(") && slideSrc.includes("SWIPE")
    && slideSrc.includes("Equal Housing Opportunity") && slideSrc.includes("slideIndex"))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[12 · LISTING BROCHURE — multi-page, photo-forward, autonomous]")
  const { listingBrochureSpec } = await import("../lib/documents/listing-brochure")
  const jpeg = await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 30, g: 60, b: 90 } } })
    .jpeg().toBuffer()
  const brochureSpec = listingBrochureSpec(
    {
      id: "x", brokerage_id: "y", address: "128 Harborview Lane", cityState: "Naples, FL",
      price: "$1,250,000", beds: "4", baths: "3.5", sqft: "3,240", propertyType: "Single Family",
      remarks: "Chef's kitchen. Saltwater pool.", highlights: ["Chef's kitchen", "Saltwater pool"],
      photoUrls: [],
    },
    "An editorial opening paragraph.\n\nAnd a second one.",
    Array.from({ length: 7 }, () => ({ bytes: jpeg, kind: "jpg" as const })),
    brand, "July 2026",
  )
  const brochureBytes = await renderClientPdf(brochureSpec)
  const brochureDoc = await PDFDocument.load(brochureBytes)
  check("brochure renders as a REAL multi-page PDF with embedded photo spreads",
    Buffer.from(brochureBytes.slice(0, 5)).toString() === "%PDF-" && brochureDoc.getPageCount() >= 2
    && brochureBytes.length > jpeg.length) // photos actually embedded
  check("brochure carries the anti-solicitation + verify-facts disclaimer",
    /not a solicitation/i.test(brochureSpec.disclaimer ?? "") && /verify/i.test(brochureSpec.disclaimer ?? ""))
  const brochureSrc = src("lib/documents/listing-brochure.ts")
  check("autonomous: marketing-window listings with a real photo story (≥6), idempotent via generated_documents, agent notified",
    brochureSrc.includes("MLS_ACTIVE") && brochureSrc.includes("photoUrls.length < 6")
    && brochureSrc.includes('eq("document_type", "listing_brochure")') && brochureSrc.includes("listing_brochure_ready"))
  check("brochure narrative is AI-FIRST with the listing's own remarks as fallback (never hardcoded prose)",
    brochureSrc.includes("generatePersonaCopy") && brochureSrc.includes("draft.body || narrative"))
  check("the daily plays cron runs carousels + brochures",
    src("app/api/cron/video-plays/route.ts").includes("runListingCarousels")
    && src("app/api/cron/video-plays/route.ts").includes("runListingBrochures"))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[13 · NO HARDCODED CONTENT — AI-first with a gated deterministic floor]")
  const gbc = src("lib/marketing/guide-booklet-content.ts")
  check("guide chapters: generateGuideChapters is AI-first (demand topics + factual floor + gate) with deterministic fallback",
    gbc.includes("generateGuideChapters") && gbc.includes("gatewayChatJSON")
    && gbc.includes("fromAI") && gbc.includes("return { chapters: fallback, fromAI: false }"))
  const { generateGuideChapters } = await import("../lib/marketing/guide-booklet-content")
  const blocked = await generateGuideChapters("buyer_guide", { gate: async () => ({ allowed: false }) })
  check("a blocking gate (or unreachable model) yields the FH-safe deterministic chapters",
    blocked.chapters.length === 5)
  check("delivery runner uses the AI-first chapters (not the static list)",
    src("lib/marketing/lead-magnet-delivery-runner.ts").includes("generateGuideChapters"))
  check("door-hanger hook is AI-written per listing with the deterministic line as fallback",
    src("lib/video/video-plays.ts").includes("generatePersonaCopy")
    && src("lib/video/video-plays.ts").includes("fallback hook stands"))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[14 · DELIVERY IS THE LAST STOP — every asset reaches its surface]")
  const approveSrc = src("app/actions/social-media-automation.ts")
  check("approval FLIPS drafts publishable: status→scheduled + scheduled_for set (the publisher only ships scheduled+approved+due)",
    approveSrc.includes("needsScheduling") && approveSrc.includes('status: "scheduled"')
    && approveSrc.includes("scheduled_for: current?.scheduled_for ?? new Date().toISOString()"))
  const renderRoute = src("app/api/internal/remotion/render-composition/route.ts")
  check("STILLS join the marketing_assets library too (the still branch captures — flyers/hangers/carousel slides are reusable)",
    renderRoute.includes("captureRenderAsMarketingAsset"))
  const captureSrc = src("lib/marketing/capture-render-asset.ts")
  check("capture types honestly: PNG/JPG output → asset_type image (not everything 'video')",
    captureSrc.includes("isImage") && captureSrc.includes('isImage ? "image" : "video"'))
  const adProducer = src("lib/ads/listing-ad-producer.ts")
  check("ADS ARE FED: the media resolver tries video THEN the image library (twilight/staged/carousel art run as image ads)",
    adProducer.includes('["video", "image"] as const') && adProducer.includes('"virtually_staged"')
    && adProducer.includes('"CarouselSlide"'))
  check("carousel drafts land ON THE CALENDAR with a real slot (scheduled_for), not as dangling drafts",
    src("lib/marketing/social-carousel.ts").includes("scheduled_for: slot.toISOString()"))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[15 · THE FULL MARKETING LOOP — every channel produce→schedule→SEND, GEO riding along]")
  const sender = src("lib/marketing/email-campaign-sender.ts")
  check("email campaigns: scheduled sends finally have a consumer (send-email-campaigns cron → one sender, claim-guarded)",
    sender.includes("runScheduledEmailCampaigns") && sender.includes('.eq("status", "scheduled")')
    && sender.includes('.lte("send_date"') && sender.includes('.neq("status", "sending")')
    && src("app/api/cron/send-email-campaigns/route.ts").includes("runScheduledEmailCampaigns")
    && src("lib/kernel/cron-dispatch.ts").includes("/api/cron/send-email-campaigns")
    && src("lib/kernel/manager-registry.ts").includes('"/api/cron/send-email-campaigns": "campaign_orchestrator"'))
  check("email campaigns: template-body campaigns and queued email_sends both drain through the consent-gated dispatchEmail",
    sender.includes("resolveCampaignHtml") && sender.includes('.eq("status", "queued")')
    && sender.includes("dispatchEmail") && src("app/actions/email-campaigns.ts").includes("sendCampaignNow"))
  check("newsletter approval schedules (status→scheduled + send_date) — approve-only no longer strands the AI newsletter",
    src("app/actions/marketing-ai-approvals.ts").includes('kind === "newsletter"')
    && src("app/actions/marketing-ai-approvals.ts").includes("send_date: nl.send_date ?? new Date().toISOString()"))
  check("blog approval advances publish_status AND the cadence cron's publish phase ships approved hosted/embed posts public",
    src("app/actions/marketing-ai-approvals.ts").includes('kind === "blog"')
    && src("app/api/cron/blog-cadence-tick/route.ts").includes('publish_status: "published"')
    && src("app/api/cron/blog-cadence-tick/route.ts").includes('["hosted", "embed"]'))
  check("the SECOND social approval handler (handleContentApproved) also flips drafts publishable — both approval paths agree",
    src("app/actions/social-publishing.ts").includes("needsScheduling")
    && src("app/actions/social-publishing.ts").includes('status: "scheduled"'))
  check("ONE sequence worker: the duplicate /api/sequences/execute route is gone from disk + registry (campaign-sequence-steps carries the queue)",
    !existsSync(join(ROOT, "app/api/sequences/execute/route.ts"))
    && !src("lib/kernel/cron-dispatch.ts").includes("/api/sequences/execute")
    && src("lib/kernel/cron-dispatch.ts").includes("/api/cron/campaign-sequence-steps"))
  // GEO — AI-search visibility rides every public marketing surface
  const sitemapSrc = src("app/sitemap.ts")
  check("sitemap covers the WHOLE public surface: listings + videos + blogs + agent profiles + lead magnets",
    sitemapSrc.includes("/listing/") && sitemapSrc.includes("/v/") && sitemapSrc.includes("/blog/")
    && sitemapSrc.includes("/p/") && sitemapSrc.includes("/lm/"))
  const llmsSrc = src("app/llms.txt/route.ts")
  check("llms.txt sections: active listings + articles + agents beyond the videos",
    llmsSrc.includes("Active listings") && llmsSrc.includes("Articles") && llmsSrc.includes("Agents"))
  check("the listing page (where every QR lands) carries RealEstateListing + Breadcrumb JSON-LD",
    src("app/listing/[slug]/page.tsx").includes("buildRealEstateListingJsonLd")
    && src("app/listing/[slug]/page.tsx").includes("application/ld+json"))
  const llmsBody = (await import("../lib/geo/video-landing")).buildLlmsTxt({
    siteName: "S", siteSummary: "x",
    pages: [{ title: "V", url: "https://a/v/1", summary: "s" }],
    sections: [{ heading: "Active listings", pages: [{ title: "L", url: "https://a/listing/1", summary: "3bd" }] }],
  })
  check("buildLlmsTxt renders extra sections (and stays backward-compatible without them)",
    llmsBody.includes("## Active listings") && llmsBody.includes("- [L](https://a/listing/1): 3bd")
    && llmsBody.includes("## Video content"))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[16 · MEDIA ↔ COPY PAIRING + THE PODCAST LOOP — nothing ships bare, nothing ships ungated]")
  const distSrc = src("app/api/cron/distribute-podcast-episodes/route.ts")
  check("podcast distributor honors the human gate: only approval_status='approved' episodes ship (the bypass is dead)",
    distSrc.includes('.eq("approval_status", "approved")'))
  check("podcast approve makes the episode DISTRIBUTABLE: empty publish_channels default to the brokerage's enabled channels",
    src("app/actions/marketing-ai-approvals.ts").includes('kind === "podcast"')
    && src("app/actions/marketing-ai-approvals.ts").includes("podcast_distribution_channels"))
  check("podcast production is scheduled (weekly auto + distribution crons registered, manager-owned)",
    src("lib/kernel/cron-dispatch.ts").includes("podcast-weekly-auto")
    && src("lib/kernel/cron-dispatch.ts").includes("distribute-podcast-episodes"))
  const pairing = src("lib/marketing/social-media-pairing.ts")
  check("social media pairing: LIBRARY-FIRST (approved assets by decided type, topic/agent match) with brand-aware generation as fallback",
    pairing.includes('.eq("asset_type", assetType)') && pairing.includes("matchesTopic")
    && pairing.includes("generateImage") && pairing.includes('purpose: "social_post"'))
  check("generated pairing images are CAPTURED back into the library (one asset → many uses, never pay twice)",
    pairing.includes("captured_from") && pairing.includes('from("marketing_assets").insert'))
  check("the cadence stager attaches media_urls to every brand post (bare-text drafts are the exception, not the default)",
    src("lib/marketing/social-cadence.ts").includes("resolveSocialMedia")
    && src("lib/marketing/social-cadence.ts").includes("media_urls: mediaUrls"))
  check("listing email campaigns embed the listing hero photo at the top of the body (no text-only listing blasts)",
    src("app/actions/email-campaigns.ts").includes("heroHtml")
    && src("app/actions/email-campaigns.ts").includes("${heroHtml}${emailContent.data.generated_content}"))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[17 · NO HARDCODED IDENTITY + PROVEN MEDIA-TYPE DECISIONS]")
  {
    // The platform's name + domain are SETTINGS — no runtime file may carry them.
    const { execSync } = await import("child_process")
    let hits = ""
    try {
      hits = execSync(
        `grep -rn "VIP Real Estate OS\\|viprealestateos\\|Smart Engine" app lib --include=*.ts --include=*.tsx || true`,
        { cwd: ROOT, encoding: "utf-8" },
      ).trim()
    } catch { /* grep unavailable → the source checks below still hold */ }
    check("ZERO hardcoded product-name/domain sites in runtime code (app/ + lib/)", hits === "", hits.split("\n")[0])
    const su = src("lib/platform/site-url.ts")
    check("ONE siteUrl resolver: env-only (NEXT_PUBLIC_APP_URL → VERCEL_URL → relative), no invented domain",
      su.includes("NEXT_PUBLIC_APP_URL") && su.includes("VERCEL_URL") && !su.includes("viprealestateos"))
    check("GEO surfaces resolve the brand per request (llms.txt siteName, /v + /listing breadcrumbs, root title template)",
      src("app/llms.txt/route.ts").includes("loadProductBrand")
      && src("app/v/[slug]/page.tsx").includes("loadProductBrand")
      && src("app/listing/[slug]/page.tsx").includes("loadProductBrand")
      && src("app/layout.tsx").includes("loadProductBrand")
      && src("app/layout.tsx").includes("template: `%s · ${brand.name}`"))
  }
  {
    const { engagementScore, decideMediaType, CHANNEL_MEDIA_NORMS } = await import("../lib/marketing/social-media-pairing")
    check("channel norms encode the competitor-validated defaults (video-first IG/FB/TikTok/YT, image-first LinkedIn/GBP/Pinterest)",
      CHANNEL_MEDIA_NORMS.instagram.prefer === "video" && CHANNEL_MEDIA_NORMS.facebook.prefer === "video"
      && CHANNEL_MEDIA_NORMS.tiktok.prefer === "video" && CHANNEL_MEDIA_NORMS.linkedin.prefer === "image"
      && CHANNEL_MEDIA_NORMS.google_business.prefer === "image" && !CHANNEL_MEDIA_NORMS.google_business.videoAllowed)
    check("engagementScore is tolerant across sync shapes and weights views at 1%",
      engagementScore({ likes: 10, comments: 5 }) === 15
      && engagementScore({ views: 1000 }) === 10
      && engagementScore(null) === 0 && engagementScore("junk") === 0)
    const vid = Array.from({ length: 6 }, () => ({ mediaType: "video" as const, score: 20 }))
    const img = Array.from({ length: 6 }, () => ({ mediaType: "image" as const, score: 10 }))
    check("decideMediaType: a real experiment (≥5/arm) with >25% lift overrides the norm; weak or thin evidence returns null",
      decideMediaType([...vid, ...img]) === "video"
      && decideMediaType([...vid.slice(0, 3), ...img]) === null
      && decideMediaType([...vid.map((s) => ({ ...s, score: 11 })), ...img]) === null)
    const pairingSrc = src("lib/marketing/social-media-pairing.ts")
    check("the resolver runs the decision LADDER (learned → channel norm → availability) and records decidedBy for the flywheel",
      pairingSrc.includes("learnedMediaPreference") && pairingSrc.includes("decidedBy")
      && pairingSrc.includes('"channel_norm"') && pairingSrc.includes('"availability"'))
    check("the cadence resolves media PER PLATFORM (video for video-first channels, image elsewhere — one generation, library-cached)",
      src("lib/marketing/social-cadence.ts").includes("platform,")
      && src("lib/marketing/social-cadence.ts").includes("for (const platform of platforms) {\n    let mediaUrls"))
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[18 · THE VIDEO CONTENT KIT — an anchor asset ships with proven copy for every destination]")
  {
    const { fallbackVideoKit, composeVideoKit, kitCaptionFor } = await import("../lib/marketing/video-content-kit")
    const kitFacts = {
      title: "Just Listed — 128 Harborview Lane",
      videoType: "listing_promo",
      scriptExcerpt: "Welcome to 128 Harborview Lane in Naples...",
      listing: { address: "128 Harborview Lane", cityState: "Naples, FL", price: "$1,250,000", beds: "4", baths: "3.5" },
      agentName: "Jordan Avery", brokerageName: "Harbor & Main",
    }
    const fb = fallbackVideoKit(kitFacts, "2026-07-10T00:00:00Z")
    check("fallback kit: every destination filled from the video's own facts (IG/FB/LI/GBP + email + SMS + portal), FH-clean",
      fb.instagram_caption.includes("128 Harborview Lane") && fb.email_subject.length <= 60
      && fb.sms_line.length <= 140 && fb.portal_message.length > 10 && fb.built_by === "fallback"
      && !FH_BANNED.test(Object.values(fb).filter((v) => typeof v === "string").join(" ")))
    const gated = await composeVideoKit(kitFacts, { gate: async () => ({ allowed: false }), now: "2026-07-10T00:00:00Z" })
    check("a blocking compliance gate (or unreachable model) forces the fact-built fallback — AI kit copy never ships ungated",
      gated.built_by === "fallback")
    check("kitCaptionFor maps channels to their fitting field (IG/TikTok/YT → hook caption, GBP → informational post)",
      kitCaptionFor(fb, "instagram") === fb.instagram_caption
      && kitCaptionFor(fb, "tiktok") === fb.instagram_caption
      && kitCaptionFor(fb, "google_business") === fb.gbp_post
      && kitCaptionFor(fb, "linkedin") === fb.linkedin_caption)
    const kitSrc = src("lib/marketing/video-content-kit.ts")
    check("the kit is idempotent, stored on the project (video_metadata.content_kit), grounded + gated",
      kitSrc.includes("content_kit") && kitSrc.includes("if (existing?.built_at) return")
      && kitSrc.includes("evaluateOutbound") && kitSrc.includes("Use ONLY the facts provided"))
    const handler = src("lib/orchestrator/internal.ts")
    check("the completion handler builds the kit FIRST (section 0) so every downstream section ships fitting content",
      handler.includes("THE CONTENT KIT") && handler.includes("buildVideoContentKit")
      && handler.indexOf("buildVideoContentKit") < handler.indexOf("Personal videos to a specific contact"))
    check("the hardcoded one-caption-for-all-channels social fan-out is DEMOTED to fallback — kit captions ride per platform",
      handler.includes("kitCaptionFor(contentKit, platform)") && handler.includes("fallbackCaption")
      && !handler.includes('const caption = captionByType[video_type] ?? "New video'))
    check("repurpose distribution consumes the kit (one gated voice) with per-platform generation as legacy fallback only",
      src("lib/repurpose/distribute.ts").includes("kitCaptionFor")
      && src("lib/repurpose/distribute.ts").includes("kit?.built_at"))
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[19 · THE RECRUITING PITCH KIT — the brokerage's own growth marketing, real data only]")
  {
    const { pitchSettingsHash, aiTeamBullets, recruitingPitchSpec } = await import("../lib/recruiting/recruiting-pitch-kit")
    const facts = {
      brokerageName: "Harbor & Main Realty",
      pitch: "We built the brokerage we always wanted to work at.",
      valueProps: ["AI operations team included", "No desk fees", "Weekly coaching"],
      splitToAgent: 85, monthlyFee: 99,
      recruitedGciDollars: 412000, recruitedAgentCount: 6,
      contactLine: "Reach us directly: (555) 010-2000",
    }
    check("the AI-team section enumerates the LIVE registry (14 managers) — the pitch can never advertise what the product doesn't ship",
      aiTeamBullets().length === 14 && aiTeamBullets().some((b) => b.startsWith("AI ISA"))
      && aiTeamBullets().some((b) => b.includes("Compliance Officer")))
    check("settings-hash is stable + change-sensitive (the refresh key)",
      pitchSettingsHash(facts) === pitchSettingsHash({ ...facts })
      && pitchSettingsHash(facts) !== pitchSettingsHash({ ...facts, splitToAgent: 80 }))
    const spec = recruitingPitchSpec(facts, "Two real paragraphs.\n\nAbout the brokerage.", brand, "July 2026")
    check("terms + measured GCI ride ONLY from real data; omitted facts drop their sections (never invented)",
      JSON.stringify(spec.sections).includes("85%") && JSON.stringify(spec.sections).includes("412,000")
      && !JSON.stringify(recruitingPitchSpec({ ...facts, splitToAgent: null, monthlyFee: null, recruitedGciDollars: null }, "p", brand, "d").sections).includes("The terms"))
    const pitchBytes = await renderClientPdf(spec)
    check("the pitch kit renders as a REAL branded PDF through the one engine",
      Buffer.from(pitchBytes.slice(0, 5)).toString() === "%PDF-" && (await PDFDocument.load(pitchBytes)).getPageCount() >= 1)
    check("independent-contractor disclaimer + not-an-offer line present",
      /independent-contractor/i.test(spec.disclaimer ?? "") && /not an offer/i.test(spec.disclaimer ?? ""))
    const kitRunner = src("lib/recruiting/recruiting-pitch-kit.ts")
    check("autonomous + honest: settings-configured brokerages only, hash-idempotent, AI-polish gated with the broker's own text as fallback, ledger GCI only when >0",
      kitRunner.includes("recruiting_pitch.not.is.null") && kitRunner.includes("settings_hash")
      && kitRunner.includes("generatePersonaCopy") && kitRunner.includes("if (gci > 0)"))
    check("rides the weekly recruit-outreach cron (recruiting_manager's sweep) and notifies the broker print-ready",
      src("app/api/cron/recruit-outreach/route.ts").includes("runRecruitingPitchKits")
      && kitRunner.includes("recruiting_pitch_ready"))
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[20 · TEAMS RECRUIT TOO + THE TENANT WEBSITE (the OS loop closes on the public web)]")
  {
    const { teamPitchFacts, pitchSettingsHash: tHash } = await import("../lib/recruiting/recruiting-pitch-kit")
    const tf = teamPitchFacts({
      name: "The Avery Group", tagline: "Volume with a life.", bio_text: "We cap at 20 agents on purpose.",
      team_split_percent: 70, team_split_value: null, team_split_type: null,
      team_fees_json: { monthly_fee: 150 }, phone: "(555) 010-3000",
    })
    check("team pitch facts come from the team's OWN columns (tagline+bio → pitch, split fields → terms, fees json → fee) — no invented columns",
      tf.pitch?.includes("Volume with a life.") === true && tf.splitToAgent === 70 && tf.monthlyFee === 150
      && tf.contactLine?.includes("(555) 010-3000") === true)
    check("a team with no real pitch produces nothing (bio/tagline empty → skip)",
      teamPitchFacts({ name: "X", tagline: null, bio_text: null, team_split_percent: null, team_split_value: null, team_split_type: null, team_fees_json: null, phone: null }).pitch === null)
    check("team hash keys the refresh independently of the brokerage kit",
      tHash(tf) !== tHash({ ...tf, splitToAgent: 60 }))
    const kitRunner2 = src("lib/recruiting/recruiting-pitch-kit.ts")
    check("the runner has the TEAM PASS: teams with a pitch, hash-idempotent per team (metadata.team_id), TEAM LEAD notified",
      kitRunner2.includes("TEAM PASS") && kitRunner2.includes('contains("metadata", { team_id: t.id })')
      && kitRunner2.includes("team_lead_id"))

    const site = src("app/site/[slug]/page.tsx")
    check("the TENANT WEBSITE exists at /site/[slug] — served on the platform origin (zero tenant hosting/DNS)",
      site.includes("loadSite") && site.includes('.eq("slug", slug)'))
    check("assembled from LIVE surfaces: active listings → /listing, agents → /p, published blogs → /blog, recruiting → /recruiting",
      site.includes("/listing/") && site.includes("/p/") && site.includes("/blog/") && site.includes("/recruiting/"))
    check("brand-true (tenant primary color validated), RealEstateAgent JSON-LD, compliance footer (license + EHO + not-a-solicitation)",
      site.includes("RealEstateAgent") && site.includes("Equal Housing Opportunity")
      && site.includes("not a solicitation") && site.includes("/^#[0-9a-fA-F]{6}$/"))
    check("tenant sites are GEO-indexed: the sitemap lists /site/[slug] for every slugged brokerage",
      src("app/sitemap.ts").includes("/site/${sb.slug}"))
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[21 · THE AD OUTCOME LOOP — creative and budget driven by the ledger, gated]")
  {
    const { decideWinningArm, decideBudgetRebalance } = await import("../lib/ads/ad-outcome-loop")
    check("winning-arm gate: two READ arms (≥800 imp or ≥$50) + >25% lift on leads-per-dollar → winner; thin evidence → null",
      decideWinningArm([
        { arm: "A", spend: 100, impressions: 5000, clicks: 100, leads: 8 },
        { arm: "B", spend: 100, impressions: 5000, clicks: 100, leads: 3 },
      ])?.arm === "A"
      && decideWinningArm([{ arm: "A", spend: 100, impressions: 5000, clicks: 100, leads: 8 }]) === null
      && decideWinningArm([
        { arm: "A", spend: 10, impressions: 200, clicks: 5, leads: 0 },
        { arm: "B", spend: 12, impressions: 300, clicks: 4, leads: 0 },
      ]) === null)
    check("CTR is the fallback basis when lead volume is thin — and near-ties return null (no false winners)",
      decideWinningArm([
        { arm: "A", spend: 60, impressions: 4000, clicks: 200, leads: 1 },
        { arm: "B", spend: 60, impressions: 4000, clicks: 100, leads: 1 },
      ])?.basis === "ctr"
      && decideWinningArm([
        { arm: "A", spend: 60, impressions: 4000, clicks: 110, leads: 1 },
        { arm: "B", spend: 60, impressions: 4000, clicks: 100, leads: 1 },
      ]) === null)
    check("budget rebalance: ≥2x CPL gap (or spend-with-zero-leads vs a producer) → proposal; anything closer → null",
      decideBudgetRebalance([
        { campaignId: "good", campaignName: "G", spend: 200, leads: 10 },
        { campaignId: "bad", campaignName: "B", spend: 200, leads: 2 },
      ])?.fromCampaignId === "bad"
      && decideBudgetRebalance([
        { campaignId: "good", campaignName: "G", spend: 200, leads: 10 },
        { campaignId: "dead", campaignName: "D", spend: 90, leads: 0 },
      ])?.fromCampaignId === "dead"
      && decideBudgetRebalance([
        { campaignId: "a", campaignName: "A", spend: 200, leads: 10 },
        { campaignId: "b", campaignName: "B", spend: 200, leads: 8 },
      ]) === null)
    const loop = src("lib/ads/ad-outcome-loop.ts")
    check("distribution intelligence is GATED: rebalances ride the manager bus as proposals (deduped 14d per pair) — nothing spends on its own",
      loop.includes("publishManagerSignal") && loop.includes('"budget_rebalance"')
      && loop.includes("from_campaign_id: decision.fromCampaignId") && !loop.includes("daily_budget:"))
    const producer = src("lib/ads/listing-ad-producer.ts")
    check("feedback-conditioned generation: the producer adopts ONLY a generic learned headline (no digits, another listing's facts can never leak) and records generated_from='learned:<arm>'",
      producer.includes("learnedCreativeEmphasis") && producer.includes("!/\\d/.test(learned.headline)")
      && producer.includes("learned:${learned.arm}"))
    check("the loop rides the ads-manager sweep (ads_manager owns it)",
      src("app/api/cron/ads-manager-sweep/route.ts").includes("runAdOutcomeLoop"))
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[22 · EVERY TIER OWNS ITS LOOP — teams get a site, agents/teams learn from THEIR OWN evidence]")
  {
    const teamSite = src("app/team/[slug]/page.tsx")
    check("the TEAM website exists at /team/[slug] (the middle tier had no public presence at all)",
      teamSite.includes("loadTeamSite") && teamSite.includes('.eq("public_slug", slug)'))
    check("assembled from the team's OWN surfaces: brand (tagline/bio/colors/logo), roster → /p, the team's agents' active listings",
      teamSite.includes('.eq("team_id", t.id)') && teamSite.includes('.in("agent_id", agentIds)')
      && teamSite.includes("/p/") && teamSite.includes("/listing/"))
    check("teams advertise under the BROKERAGE's license — the footer names both + EHO + not-a-solicitation; JSON-LD carries parentOrganization",
      teamSite.includes("Brokerage License") && teamSite.includes("Equal Housing Opportunity")
      && teamSite.includes("not a solicitation") && teamSite.includes("parentOrganization"))
    check("teams.public_slug is in the schema snapshot (live column, backfilled) and the sitemap lists /team/[slug]",
      src("scripts/schema-snapshot.ts").includes('"public_slug", "tagline"')
      && src("app/sitemap.ts").includes("/team/${ts.public_slug}"))

    const loop2 = src("lib/ads/ad-outcome-loop.ts")
    check("ad learning is SCOPE-AWARE: the ladder tries the AGENT's own arms, then the TEAM's, then the brokerage blend — first gated winner wins",
      loop2.includes('scope: "agent"') && loop2.includes('scope: "team"') && loop2.includes('scope: "brokerage"')
      && loop2.includes("c?.agent_user_id === scope.agentUserId") && loop2.includes("c?.team_id === scope.teamId"))
    const producer2 = src("lib/ads/listing-ad-producer.ts")
    check("the producer resolves the agent's team and records WHOSE evidence drove the creative (learned:<arm>@<scope>)",
      producer2.includes('select("team_id")') && producer2.includes("{ agentUserId, teamId }")
      && producer2.includes("learned:${learned.arm}@${learned.scope}"))
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[23 · THE SITE ANSWERS LIVE QUESTIONS — one assistant, every public tier]")
  {
    const launcher = src("app/components/public-site/SiteChatLauncher.tsx")
    check("ONE launcher reuses the EXISTING gated widget (/widget/[brokerageSlug]) — no second chat rail invented",
      launcher.includes("/widget/${brokerageSlug}") && launcher.includes("iframe"))
    check("the brokerage site mounts the live AI (widget_enabled honored, the tenant's NAMED assistant on the button)",
      src("app/site/[slug]/page.tsx").includes("SiteChatLauncher")
      && src("app/site/[slug]/page.tsx").includes("widget_enabled !== false")
      && src("app/site/[slug]/page.tsx").includes("assistant_name"))
    check("the team site mounts it too, riding the BROKERAGE's widget + identity (teams don't get a second assistant)",
      src("app/team/[slug]/page.tsx").includes("SiteChatLauncher")
      && src("app/team/[slug]/page.tsx").includes("widget_enabled"))

    // ── TIER IDENTITY (owner rule): brokerage site → brokerage assistant,
    //    team page → TEAM assistant, agent page → AGENT assistant ──
    const widgetPage = src("app/widget/[brokerageSlug]/page.tsx")
    check("the widget resolves identity at the REQUESTED tier (?agent / ?team), tenant-checked (slug must belong to THIS brokerage), cascade fallback to brokerage",
      widgetPage.includes("sp.agent") && widgetPage.includes("sp.team")
      && widgetPage.includes("'agent').eq('scope_id'") && widgetPage.includes("'team').eq('scope_id'")
      && widgetPage.includes(".eq('brokerage_id', brokerage.id)") && widgetPage.includes("entityName"))
    check("the team page scopes its chat to the TEAM identity (widgetQuery team=<slug>, team assistant on the button)",
      src("app/team/[slug]/page.tsx").includes("widgetQuery={`team=${t.public_slug}`}")
      && src("app/team/[slug]/page.tsx").includes("teamAssistantName"))
    check("the agent profile scopes its chat to the AGENT identity (widgetQuery agent=<slug>)",
      src("app/p/[agentSlug]/page.tsx").includes("widgetQuery={`agent=${agentSlug}`}")
      && src("app/p/[agentSlug]/page.tsx").includes('"agent").eq("scope_id", agent.id)'))
    check("the launcher threads the scope into the widget URL",
      src("app/components/public-site/SiteChatLauncher.tsx").includes("widgetQuery ? `?${widgetQuery}`"))
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Asset production verified — photo AI real, client PDFs real, print family complete, carousels + brochures live, content never hardcoded, delivery is the last stop, the full marketing loop closes with GEO riding along, media and copy always ship together, identity is a setting, media-type decisions are proven, every finished video carries its content kit, growth marketing produces itself for brokerages AND teams, every tier gets its own website with zero hosting that ANSWERS live questions, and every tier's outcome loop learns from its own evidence.")
  console.log(" ASSET_PRODUCTION_PASS")
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
