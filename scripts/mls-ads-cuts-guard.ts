#!/usr/bin/env tsx
/**
 * scripts/mls-ads-cuts-guard.ts   (npm run test:mls-ads-cuts)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE PLAN, TWO CUTS, PROVEN. Owner (wave 81, verbatim): "the listing videos
 * have to be mls compliant. you can create one for mls and one for posting/ads."
 *
 * WHAT THIS PROVES
 *   §strip      MLS_CUT_STRIP (lib/video/render-cut.ts) is the ONE strip list:
 *               every element the field names (logo, agent name, contact,
 *               brokerage name, tracked QR, CTA, lower-third, brand bookends,
 *               share thumbnail, verbal disclosure) with a rule and a source;
 *               mlsCutProps removes every path and flags mlsClean
 *   §control    POSITIVE CONTROL — the finder (brandedElementsIn) names every
 *               branded path on the ads props, refuses a name re-added to an
 *               MLS cut, refuses an unflagged cut, and a lower_third segment
 *   §registry   compositionHasMlsCut is DERIVED: the five presenter-less
 *               property reels have one; an open-house / coming-soon (agent
 *               name required), an avatar reel and a data reel do not; the
 *               denominator is published
 *   §finish     finishForCut: the MLS cut drops bookends / QR / thumbnail and
 *               keeps the bed, captions, b-roll; the ads cut is untouched
 *   §remotion   every MLS-cut composition's STRIPPED source reads mlsClean,
 *               forwards it to the QR badge, and guards logo / name / phone /
 *               CTA on it (or routes them through EndCard's own flag); the
 *               band burn and the QR badge honour the flag; a control fixture
 *               with an unguarded name is caught; the three PiP reels mount
 *               the ONE per-segment backdrop and it switches on a mixed plan
 *   §director   the Director refuses an MLS cut on a composition without one
 *               BEFORE the QR mint, keys the MLS row separately, scans the MLS
 *               narration for fair-housing red flags, proves the strip clean
 *               before the insert, stamps usage_intent from the cut; the
 *               experiment path refuses an MLS variant; commissionListingCuts
 *               is the ONE door and both listing producers call it
 *   §attach     the MLS-number nudge hands over the MLS cut's video_url for
 *               the unbranded virtual-tour field
 *   §upload     lane 80C's memory-card file picker rides the signed-upload
 *               survivor with a tenant-prefixed purpose; the D-ID V4 keyed
 *               live check is on the launch checklist
 *   §registered package.json + guard ordering + MAINTENANCE_DOMAINS
 *
 * No network. PURE modules + stripped-source scans (CLAUDE.md §2).
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import {
  MLS_CUT_STRIP, MLS_STRIPPED_PROP_PATHS, MLS_CUT_PURPOSES, RENDER_CUTS, CUT_USAGE_INTENT,
  compositionHasMlsCut, cutsForComposition, mlsCutCompositions, finishForCut, mlsCutProps, brandedElementsIn, assertMlsCutClean,
  cutDiscriminator, mlsNeutralTitle,
} from "../lib/video/render-cut"
import { finishForVideo } from "../lib/video/finish-spec"
import { COMPOSITION_DURATION_RULES, compositionPurposes, planCompositionDuration } from "../lib/video/duration-model"
import { planBodyVisual, COMPOSITION_BACKGROUNDS, BACKGROUND_MARKS, type BodyVisualAssets, type BodyVisualPlan } from "../lib/video/body-visual-model"
import { backdropKindAt } from "../remotion/components/SegmentBackdrop"
import { shouldRenderQrBadge } from "../remotion/components/QrOutroBadge"
import { UPLOAD_PURPOSES, buildUploadObjectPath } from "../lib/storage/signed-upload-url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string): string => readFileSync(join(root, rel), "utf8")
const readStripped = (rel: string): string => stripComments(read(rel))

let passed = 0, failed = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §strip · the ONE strip list, every path gone ──")
const EXPECTED_ELEMENTS = ["brand_logo", "agent_name", "agent_contact", "brokerage_name", "tracked_qr", "cta", "lower_third", "brand_bookends", "share_thumbnail", "verbal_disclosure"]
{
  const elements = MLS_CUT_STRIP.map((r) => r.element)
  check(`MLS_CUT_STRIP names every element the field strips (${EXPECTED_ELEMENTS.length})`, EXPECTED_ELEMENTS.every((e) => elements.includes(e as never)), `missing: ${EXPECTED_ELEMENTS.filter((e) => !elements.includes(e as never)).join(", ")}`)
  check("every strip rule carries a reason and a source", MLS_CUT_STRIP.every((r) => r.why.length > 10 && r.source.length > 10))
  check("RENDER_CUTS is exactly ads + mls; usage_intent maps mls→mls, ads→public_marketing (the CHECK's own literals)",
    RENDER_CUTS.join() === "ads,mls" && CUT_USAGE_INTENT.mls === "mls" && CUT_USAGE_INTENT.ads === "public_marketing")
  const vocab = read("scripts/check-vocabularies.ts")
  check("both usage_intent literals exist in the live CHECK cache", /usage_intent: \["both", "mls", "public_marketing"\]/.test(vocab))
}

const ADS_PROPS = (): Record<string, unknown> => ({
  hook: "Just Listed", address: "12 Oak St", cityState: "Naples, FL", price: "$742,500", bedrooms: "4", bathrooms: "3", sqft: "2,410",
  imageUrls: ["https://x/1.jpg", "https://x/2.jpg", "https://x/3.jpg", "https://x/4.jpg"],
  brand: { primaryColor: "#0F172A", accentColor: "#F59E0B", logoUrl: "https://x/logo.png", agentName: "Dana Reyes", agentPhone: "(239) 555-0184", brokerageName: "Harbour & Co.", showEhoMark: true, licenseLine: "Lic 123" },
  agentName: "Dana Reyes", agentPhone: "(239) 555-0184",
  qrCodeDataUrl: "data:image/png;base64,AAAA", qrCaption: "Scan to tour",
  ctaLabel: "DM me to tour.",
  intro: { brand: true, hook: "Just Listed", agentPhotoSlot: "agents.avatar_image_url" },
  outro: { brand: true, agentContact: true, qrCodeDataUrl: "data:image/png;base64,AAAA", qrDestinationType: "listing_detail", qrSlug: "abc", mlsClean: false },
  thumbnail_props: { line1: "12 Oak St", line2: "$742,500" },
  mlsClean: false, music_mood: "sophisticated", captionScript: "Four bedrooms on a corner lot with a new roof.",
  bodyVisualPlan: { segments: [{ index: 0, kind: "hook", treatment: "property_photos" }, { index: 1, kind: "beat", treatment: "lower_third" }, { index: 2, kind: "cta", treatment: "brand_card" }] },
})
{
  const ads = ADS_PROPS()
  const derived = mlsCutProps(ads)
  const p = derived.props
  const present = MLS_STRIPPED_PROP_PATHS.filter((path) => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), ads) !== undefined)
  check(`mlsCutProps strips every branded path present on the ads props (${present.length} of ${MLS_STRIPPED_PROP_PATHS.length} registered paths present)`, present.every((path) => derived.stripped.includes(path)), `not stripped: ${present.filter((x) => !derived.stripped.includes(x)).join(", ")}`)
  check("the MLS cut is flagged mlsClean:true and renderCut:mls; the outro's claims are turned off, not missing", p.mlsClean === true && p.renderCut === "mls" && (p.outro as Record<string, unknown>).brand === false && (p.outro as Record<string, unknown>).agentContact === false && p.qrCodeDataUrl === null)
  check("the SAME script, photos and facts survive (one plan)", p.captionScript === ads.captionScript && Array.isArray(p.imageUrls) && (p.imageUrls as unknown[]).length === 4 && p.address === ads.address && p.price === ads.price)
  check("the brand block keeps its colours and the EHO mark (not branding) and loses logo / name / phone / brokerage / licence",
    (p.brand as Record<string, unknown>).primaryColor === "#0F172A" && (p.brand as Record<string, unknown>).showEhoMark === true && ["logoUrl", "agentName", "agentPhone", "brokerageName", "licenseLine"].every((k) => !(k in (p.brand as Record<string, unknown>))))
  check("a lower_third segment in the plan becomes kinetic text", (p.bodyVisualPlan as { segments: Array<{ treatment: string }> }).segments[1].treatment === "kinetic_text")
  check("the ads props are NOT mutated (the ads cut still renders branded)", (ads.brand as Record<string, unknown>).agentName === "Dana Reyes" && ads.qrCodeDataUrl !== null && ads.mlsClean === false)
  check("assertMlsCutClean passes the derived cut", assertMlsCutClean(p).ok)
  check("cutDiscriminator keys the MLS row apart; mlsNeutralTitle prints the address (descriptive) and never a CTA", cutDiscriminator("mls") === "cut:mls" && mlsNeutralTitle("12 Oak St", "Naples, FL") === "12 Oak St, Naples, FL" && mlsNeutralTitle("", "") === "Property tour")
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §control · the finder recognises the defect it was written for ──")
{
  const ads = ADS_PROPS()
  const found = brandedElementsIn(ads)
  check("CONTROL: the ads props are named on every branded path the finder registers (incl. mlsClean!==true and the lower_third segment)",
    ["brand.logoUrl", "brand.agentName", "brand.agentPhone", "brand.brokerageName", "qrCodeDataUrl", "ctaLabel", "intro.brand", "outro.agentContact", "thumbnail_props", "mlsClean!==true", "bodyVisualPlan.segments[].lower_third"].every((k) => found.includes(k)), found.join(", "))
  const tampered = mlsCutProps(ads).props
  ;(tampered.brand as Record<string, unknown>).agentName = "Dana Reyes"
  const v = assertMlsCutClean(tampered)
  check("CONTROL: an agent name re-added to an MLS cut is refused, naming the path", !v.ok && v.found.join() === "brand.agentName")
  const unflagged = mlsCutProps(ads).props
  unflagged.mlsClean = false
  check("CONTROL: an MLS cut whose flag is false is refused (the compositions gate on the flag)", !assertMlsCutClean(unflagged).ok)
  const qr = mlsCutProps(ads).props
  qr.qrCodeDataUrl = "data:image/png;base64,BBBB"
  check("CONTROL: a tracked QR re-added is refused", !assertMlsCutClean(qr).ok)
  check("CONTROL: brandedElementsIn on an empty prop set reports only the missing flag (no phantom path)", brandedElementsIn({}).join() === "mlsClean!==true")
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §registry · which compositions have an MLS cut is DERIVED ──")
{
  const withCut = mlsCutCompositions()
  console.log(`  denominator: ${Object.keys(COMPOSITION_DURATION_RULES).length} registered compositions; MLS-cut compositions: ${withCut.join(", ")}`)
  for (const id of ["JustListedReel", "JustListedReelSquare", "JustListedReelHorizontal", "JustSoldReelSquare", "PhotoWalkthroughReel"]) {
    check(`${id} has an MLS cut (purposes ${compositionPurposes(id).join("/")} ⊆ MLS purposes, presenter none, no branded required key)`, compositionHasMlsCut(id) && cutsForComposition(id).join() === "ads,mls")
  }
  check("OpenHouseAnnounceReel has NO MLS cut — its contract REQUIRES agentName + agentPhone (an invitation to meet the agent)", !compositionHasMlsCut("OpenHouseAnnounceReel") && cutsForComposition("OpenHouseAnnounceReel").join() === "ads")
  check("ComingSoonReel has NO MLS cut — its contract requires agentName", !compositionHasMlsCut("ComingSoonReel"))
  check("MarketUpdateReel / AgentTalkingHeadReel / TestimonialReel / NeighborhoodSpotlightReel have NO MLS cut (not property purposes / a presenter)", ["MarketUpdateReel", "AgentTalkingHeadReel", "TestimonialReel", "NeighborhoodSpotlightReel", "MemoryVideoReel"].every((id) => !compositionHasMlsCut(id)))
  check("every MLS-cut composition serves ONLY MLS purposes and has presenter none — the rule, re-derived here", withCut.every((id) => compositionPurposes(id).every((p) => MLS_CUT_PURPOSES.has(p)) && finishForVideo(id).presenter === "none"))
  check("an unregistered composition has no MLS cut", !compositionHasMlsCut("NoSuchReel") && cutsForComposition("NoSuchReel").join() === "ads")
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §finish · the cut refines the finish ──")
{
  const base = finishForVideo("JustListedReel")
  const mls = finishForCut(base, "mls")
  check("the MLS cut drops the brand bookends, the tracked QR and the share thumbnail", !mls.bookends && !mls.qr && !mls.thumbnail && mls.presenter === "none")
  check("the MLS cut keeps the licensed music bed, the captions and the b-roll verdict", mls.music === base.music && mls.captions === base.captions && mls.broll === base.broll)
  check("the ads cut IS the composition's own finish (byte-identical)", JSON.stringify(finishForCut(base, "ads")) === JSON.stringify(base))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §remotion · the compositions honour the flag; the backdrop switches ──")
{
  const GUARD = /!mlsClean|!props\.mlsClean|mlsClean \?|mlsClean\}|mlsClean=\{|<EndCard|=\{mlsClean|=\{props\.mlsClean|mlsNeutralTitle|logoUrl: undefined|mlsClean \? undefined/
  /**
   * Every RENDER of a branded key (`{brand.agentName}`, `src={brand.logoUrl}`,
   * a `brand.agentPhone && (` block opener, `{agentName}`) must be guarded:
   * on a guard line, within three lines under one, or inside a component
   * function that returns early on `if (mlsClean)` (JustListedReel's CTA
   * frame). Helper components fed a bare `logoUrl` prop are guarded at their
   * call sites (`logoUrl={mlsClean ? undefined : brand.logoUrl}`). Returns the
   * offending lines so a failure names them.
   */
  const unguardedRenders = (src: string, key: string): string[] => {
    const chunks = src.split(/\n(?=(?:export )?(?:const|function) \w+)/)
    const out: string[] = []
    for (const chunk of chunks) {
      if (/if \((props\.)?mlsClean\) \{/.test(chunk)) continue // early-return MLS branch guards the rest
      if (/\(\{\s*logoUrl\s*\}\)/.test(chunk)) continue // a bare-logo helper (BrandHeader) — guarded at its call sites below
      const lines = chunk.split("\n")
      lines.forEach((l, i) => {
        const render = new RegExp(`\\{(brand\\.)?${key}\\}|src=\\{brand\\.${key}\\}|\\{(brand\\.)?${key} && \\($`).test(l)
        if (!render) return
        if (GUARD.test(l)) return
        if (lines.slice(Math.max(0, i - 3), i).some((prev) => GUARD.test(prev))) return
        out.push(l.trim())
      })
      // A helper that takes `logoUrl` bare must be called with the flag at every call site.
      if (key === "logoUrl") for (const m of chunk.matchAll(/<\w+ logoUrl=\{([^}]+)\}/g)) if (!/mlsClean/.test(m[1])) out.push(m[0])
    }
    return out
  }
  const guarded = (src: string, key: string): boolean => unguardedRenders(src, key).length === 0
  for (const id of mlsCutCompositions()) {
    const src = readStripped(`remotion/${id}.tsx`)
    check(`${id}: declares mlsClean and forwards it to the QR badge / end card`, /mlsClean\?: boolean/.test(src) && (/mlsClean=\{(props\.)?mlsClean\}/.test(src)))
    const offenders = [...unguardedRenders(src, "agentName"), ...unguardedRenders(src, "agentPhone"), ...unguardedRenders(src, "logoUrl")]
    check(`${id}: every agentName / agentPhone / logoUrl render is guarded on mlsClean (or routed through EndCard's flag)`, offenders.length === 0, offenders.join(" | "))
    check(`${id}: the MLS opening / closing copy is the address (mlsNeutralTitle), not a hook or a CTA`, /mlsNeutralTitle\(/.test(src))
  }
  const fixture = "const X = ({ brand }) => <div>{brand.agentName && (<p>{brand.agentName}</p>)}</div>"
  check("CONTROL: a fixture that prints brand.agentName without a guard fails the guard scan", !guarded(fixture, "agentName"))
  check("QrOutroBadge renders nothing on the MLS cut even with a data URL (the survivor flag)", shouldRenderQrBadge({ qrCodeDataUrl: "data:image/png;base64,AAAA", mlsClean: true }) === false && shouldRenderQrBadge({ qrCodeDataUrl: "data:image/png;base64,AAAA", mlsClean: false }) === true)
  const attribution = readStripped("lib/video/composite-attribution.ts")
  check("the ffmpeg attribution band (a lower-third strap) is skipped on mlsClean — the MLS geometry has no band", /if \(opts\.brand\.mlsClean\) \{\s*return await passthrough\(opts\.inputVideoUrl, "mls_clean"/.test(attribution))
  const disclosure = readStripped("lib/video/verbal-disclosure.ts")
  check("the spoken brokerage disclosure is skipped for usage_intent 'mls'", /usageIntent !== "mls"/.test(disclosure))

  // The per-segment backdrop (lane 80C's open item).
  for (const id of ["AgentExplainerReel", "MarketUpdateReel", "EquityReportReel"]) {
    const src = readStripped(`remotion/${id}.tsx`)
    const mounts = (src.match(/<SegmentBackdrop\b/g) ?? []).length
    // One mount inside a `panels.map` covers every panel; the equity reel writes its three panels out.
    const everyPanel = mounts >= 3 || (mounts >= 1 && /panels\.map\(/.test(src))
    check(`${id}: mounts <SegmentBackdrop> behind every panel (${mounts} mount${mounts === 1 ? " in the panels.map" : "s"}) with plan + frameOffset, and its registry row claims gradient + drift`, everyPanel && /frameOffset=\{COVER \+ (p|panels\[\d\])\.from\}/.test(src) && COMPOSITION_BACKGROUNDS[id].includes("brand_gradient") && COMPOSITION_BACKGROUNDS[id].includes("subtle_motion") && BACKGROUND_MARKS.brand_gradient.test(src) && BACKGROUND_MARKS.subtle_motion.test(src))
  }
  check("CONTROL: a source without the mount is still refused brand_gradient / subtle_motion", !BACKGROUND_MARKS.brand_gradient.test("style={{ backgroundColor: brand.primaryColor }}") && !BACKGROUND_MARKS.subtle_motion.test("style={{ backgroundColor: brand.primaryColor }}"))
  const assets: BodyVisualAssets = { avatarClip: true, brollClips: 0, propertyPhotos: 0, screenshots: 0, statCards: 3, chartData: true }
  const plan: BodyVisualPlan = planBodyVisual({ compositionId: "MarketUpdateReel", duration: planCompositionDuration({ compositionId: "MarketUpdateReel", wordCount: 60 }), script: "Rates moved. Inventory rose. Prices held. Days on market fell. Call for the block picture.", assets })
  const mixed: BodyVisualPlan = { ...plan, segments: plan.segments.map((s, i) => ({ ...s, background: i % 2 === 0 ? "brand_gradient" as const : "subtle_motion" as const })) }
  const kinds = mixed.segments.map((s) => backdropKindAt(mixed, s.from))
  check("backdropKindAt follows the plan segment by segment (a mixed plan switches), paints solid in the bookends and without a plan",
    kinds.join() === mixed.segments.map((s) => s.background).join() && backdropKindAt(mixed, 0) === "solid_brand" && backdropKindAt(null, 100) === "solid_brand")
  console.log("  blind spot (published): planBodyVisual emits the purpose's FIRST allowed background for every non-full-frame segment today — the backdrop switches whenever the plan does; a learned reorder or a producer's pre-cut segments is what makes it vary")
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §director · one rail, the cut before the spend ──")
{
  const d = readStripped("lib/video/video-director.ts")
  const at = (re: RegExp): number => { const m = re.exec(d); return m ? m.index : -1 }
  const cutRefusal = at(/if \(cut === "mls" && !compositionHasMlsCut\(format\.compositionId\)\)/)
  const mint = at(/const \{ mintVideoQr \} = await import\("@\/lib\/video\/video-qr"\)/)
  const fh = at(/detectFairHousingRedFlags\(narrationForVisual, "seller"\)/)
  const clean = at(/const clean = assertMlsCutClean\(derived\.props\)/)
  const insert = at(/\.from\("ai_video_projects"\)\s*\.insert\(\{\s*brokerage_id: opts\.brokerageId,\s*agent_id: directorAgentId,/)
  check("CommissionOpts carries `cut` and derives mlsClean from it (the ONE flag the compositions read)", /cut\?: RenderCut/.test(d) && /const mlsClean = cut === "mls" \|\| \(opts\.mlsClean \?\? false\)/.test(d))
  check("the MLS cut is refused on a composition without one BEFORE the QR mint", cutRefusal > 0 && mint > cutRefusal)
  check("the finish is refined by the cut", /finishForCut\(finishForVideo\(format\.compositionId\), cut\)/.test(d))
  check("the MLS row is keyed apart (cut:mls on director_key) and stamped video_metadata.render_cut", /cutDiscriminator\(cut\)/.test(d) && /render_cut: cut,/.test(d))
  check("the MLS cut's narration is scanned for fair-housing red flags and a red flag BLOCKS, before the insert", fh > 0 && insert > fh && /violations: \["mls_cut_fair_housing", \.\.\.redFlags\]/.test(d))
  check("the MLS props are DERIVED from the ads props (mlsCutProps) and proven clean (assertMlsCutClean) before the insert; a survivor blocks", clean > 0 && insert > clean && /mlsCutProps\(providerMetadataAds\.input_props/.test(d) && /input_props:\s*\{\s*\.\.\.contentProps/.test(d) && /violations: \["mls_cut_branded", \.\.\.clean\.found\]/.test(d))
  check("usage_intent is stamped from the cut (never a second literal)", /usage_intent: CUT_USAGE_INTENT\[cut\],/.test(d))
  check("the QR mint and the outro flag read the derived mlsClean, not the raw option", /if \(!mlsClean && finish\.qr\) \{/.test(d) && /qrSlug: qr\?\.slug \?\? null,\s*mlsClean,/.test(d))
  check("commissionVideoExperiment refuses an MLS variant (the A/B is the posting cut)", /if \(opts\.cut === "mls"\) \{\s*return \{ ok: false, status: "blocked"/.test(d))
  check("commissionListingCuts: ads first, then the MLS cut only when the registry says the composition has one", /export async function commissionListingCuts\(/.test(d) && /cut: "ads" \}, client\)/.test(d) && /if \(!cuts\.includes\("mls"\)\) return/.test(d) && /cut: "mls" \}, client\)/.test(d))
  const lv = readStripped("app/actions/listing-video.ts")
  const vp = readStripped("lib/video/video-plays.ts")
  check("both listing producers commission through commissionListingCuts (the button and the autonomous premiere)", /commissionListingCuts\(situation, commissionOpts\)/.test(lv) && /const res = await commissionListingCuts\(/.test(vp))
  check("the listing-video action reports the MLS cut beside the ads cut (never hidden)", /mlsProjectId: cuts\.mls\?\.videoProjectId/.test(lv) && /mlsReason: cuts\.mls && !cuts\.mls\.ok \? cuts\.mls\.reason/.test(lv))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §attach · the MLS cut reaches the MLS hand-off ──")
{
  const r = readStripped("lib/listings/mls-number-reminder.ts")
  check("the MLS-number nudge looks up the listing's MLS cut (usage_intent 'mls', a rendered video_url), reads the error, and hands the link over for the unbranded virtual-tour field",
    /\.eq\("usage_intent", "mls"\)\.not\("video_url", "is", null\)/.test(r) && /mlsCutError/.test(r) && /unbranded virtual-tour \/ media field/.test(r) && /\$\{mlsCutLine\}/.test(r))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §upload · 80C's open items closed on the survivors ──")
{
  const spec = UPLOAD_PURPOSES.memory_video_media
  const path = buildUploadObjectPath({ purpose: "memory_video_media", identity: { brokerageId: "tenant-a", userId: "user-1" } as never, fileName: "chapter1.m4a" } as never)
  check("memory_video_media is a registered signed-upload purpose on video-assets with a tenant+user prefix and audio/video/image types",
    !!spec && spec.bucket === "video-assets" && spec.prefix({ brokerageId: "tenant-a", userId: "user-1" } as never).startsWith("tenant-a/memory-video/user-1") && (spec.contentTypePrefixes ?? []).join() === "audio/,video/,image/" && String(path).includes("tenant-a/memory-video/user-1"))
  const card = readStripped("app/crm/contacts/[contactId]/components/memory-video-card.tsx")
  check("the memory card's file picker uploads through uploadViaSignedUrl with that purpose (no path, no bucket, no tenant sent from the browser) and measures the recording's length on upload",
    /uploadViaSignedUrl\(\{ purpose: "memory_video_media", file \}\)/.test(card) && /onloadedmetadata/.test(card) && /type="file"/.test(card) && !/bucket:|objectPath|brokerageId/.test(card))
  const lc = readStripped("lib/platform/launch-checklist.ts")
  check("the launch checklist carries the D-ID V4 TransparentBackground LIVE CHECK (kept flagged, verified on the first keyed submit)", /key: "did_v4_transparent_background"/.test(lc) && /result_format is webm/.test(lc))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── §registered · package.json, ordering, MAINTENANCE_DOMAINS ──")
{
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
  const guard = pkg.scripts.guard ?? ""
  check("package.json: test:mls-ads-cuts runs this file and sits in the guard chain after test:scrapers (ordering only)",
    pkg.scripts["test:mls-ads-cuts"] === "tsx scripts/mls-ads-cuts-guard.ts" && guard.indexOf("npm run test:scrapers") !== -1 && guard.indexOf("npm run test:mls-ads-cuts") > guard.indexOf("npm run test:scrapers"))
  const registry = readStripped("lib/kernel/manager-registry.ts")
  check("manager-registry: MAINTENANCE_DOMAINS.mls_ads_cuts names asset_manager with compliance_officer / listing_concierge / campaign_orchestrator co-owners", /mls_ads_cuts:\s*\{ manager: "asset_manager", proof: "test:mls-ads-cuts", coOwners: \["compliance_officer", "listing_concierge", "campaign_orchestrator"\]/.test(registry))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log("\nFAILURES:"); for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
