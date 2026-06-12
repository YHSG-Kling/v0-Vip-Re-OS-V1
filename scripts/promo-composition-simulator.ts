#!/usr/bin/env tsx
/**
 * scripts/promo-composition-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROMO-COMPOSITION ROUTER harness — the DRIFT FIX guard.
 *
 * render-just-listed hardcoded compositionId="JustListedReel" for EVERY
 * listing_promo_videos.event_type, so just_sold / open_house / coming_soon
 * promos rendered with the WRONG composition + the wrong prop shape. This
 * simulator proves the pure router (compositionForPromoEvent) + the pure
 * prop builder (buildPromoProps) that the route now uses instead:
 *
 * Layer 1 (pure):
 *   · compositionForPromoEvent maps EVERY listing-promo event_type to the
 *     right composition + Director SituationKind (just_listed/price_reduction/
 *     under_contract → legacy vertical JustListedReel; just_sold →
 *     JustSoldReelSquare; open_house_* → OpenHouseAnnounceReel; coming_soon →
 *     ComingSoonReel).
 *   · buildPromoProps produces the REQUIRED props per composition from sample
 *     facts (just_sold → soldPrice + daysOnMarket; open_house → dateLabel +
 *     timeLabel; coming_soon → teaser/whenString) AND the safe FALLBACK to
 *     JustListedReel when those facts are missing (honest, no broken render).
 *
 * Layer 2 (live, gated by SUPABASE creds): read REAL listing_promo_videos
 *   rows (read-only) and assert the router resolves a VALID composition for
 *   every distinct event_type actually present in the table. No render spend,
 *   no writes — purely asserts the pure layer against production data shapes.
 *
 * Run: npx tsx scripts/promo-composition-simulator.ts  (npm run test:promo-composition)
 * Exit: 0 = all checks pass, 1 = any failure (CI gate).
 */
import {
  compositionForPromoEvent,
  buildPromoProps,
  buildComingSoonTeaser,
  computeDaysOnMarket,
  type PromoListingFacts,
  type PromoBrand,
  type PromoCompositionId,
  type PromoCompositionChoice,
} from "../lib/video/promo-composition"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Promo-composition router verified — every event_type routes to the right reel + required props, safe fallback when facts are thin")
}

const BRAND: PromoBrand = {
  primaryColor:  "#0F172A",
  accentColor:   "#F59E0B",
  logoUrl:       "https://x/logo.png",
  agentName:     "Jane Agent",
  agentPhone:    "(555) 555-1212",
  showEhoMark:   true,
  brokerageName: "Acme Realty",
}

/** Full-fact sample — a sold listing with every optional field populated. */
function richFacts(over: Partial<PromoListingFacts> = {}): PromoListingFacts {
  return {
    address:       "123 Main Street",
    city_state:    "Miami, FL",
    price:         "$625,000",
    bedrooms:      "3",
    bathrooms:     "2",
    sqft:          "1,850",
    property_type: "condo",
    images:        ["https://x/1.jpg", "https://x/2.jpg"],
    soldPrice:     "$640,000",
    daysOnMarket:  7,
    openHouseDate: "This Saturday",
    openHouseTime: "12:00 - 2:00 PM",
    ...over,
  }
}

/** Thin-fact sample — list facts only, no sale outcome / no open-house schedule
 *  (mirrors what render-just-listed actually loads for a live on-market listing). */
function thinFacts(over: Partial<PromoListingFacts> = {}): PromoListingFacts {
  return {
    address:       "123 Main Street",
    city_state:    "Miami, FL",
    price:         "$625,000",
    bedrooms:      "3",
    bathrooms:     "2",
    sqft:          "1,850",
    property_type: "condo",
    images:        ["https://x/1.jpg"],
    soldPrice:     "",
    daysOnMarket:  null,
    openHouseDate: "",
    openHouseTime: "",
    ...over,
  }
}

function build(choice: PromoCompositionChoice, facts: PromoListingFacts) {
  return buildPromoProps({
    choice,
    facts,
    brand:         BRAND,
    voiceoverUrl:  "https://x/vo.mp3",
    qrCodeDataUrl: "data:image/png;base64,QR",
    qrCaption:     "Scan",
    hook:          "Just Listed",
  })
}

// Every listing-promo event_type (lib/kernel/lifecycle-promo-policy LifecycleEventType).
const ALL_EVENTS = [
  "coming_soon",
  "just_listed",
  "open_house_announce",
  "open_house_reminder",
  "price_reduction",
  "under_contract",
  "just_sold",
] as const

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Promo-composition router simulator")
  console.log("══════════════════════════════════════════════════")

  // ── 1. compositionForPromoEvent maps every event_type ──────────────────────
  console.log("\n[Layer 1 · compositionForPromoEvent maps every event_type → composition + SituationKind]")
  const expected: Record<string, { id: PromoCompositionId; kind: string }> = {
    just_listed:         { id: "JustListedReel",        kind: "new_listing" },
    price_reduction:     { id: "JustListedReel",        kind: "price_drop" },
    under_contract:      { id: "JustListedReel",        kind: "just_sold" },
    just_sold:           { id: "JustSoldReelSquare",    kind: "just_sold" },
    open_house_announce: { id: "OpenHouseAnnounceReel", kind: "open_house" },
    open_house_reminder: { id: "OpenHouseAnnounceReel", kind: "open_house" },
    coming_soon:         { id: "ComingSoonReel",        kind: "coming_soon" },
  }
  for (const ev of ALL_EVENTS) {
    const got = compositionForPromoEvent(ev)
    const exp = expected[ev]
    check(`${ev} → ${exp.id} (${exp.kind})`,
      got.compositionId === exp.id && got.situationKind === exp.kind,
      `got ${got.compositionId}/${got.situationKind}`)
  }
  // Exhaustiveness — no event_type silently falls through to a wrong default.
  check("every event_type has an explicit mapping (no gaps)",
    ALL_EVENTS.every((ev) => !!expected[ev]))
  // Unknown event → safe legacy default (the documented pre-fix behavior).
  check("unknown event_type → safe JustListedReel default",
    compositionForPromoEvent("totally_unknown").compositionId === "JustListedReel")

  // ── 2. just_listed builds the legacy vertical reel (ZERO behavior change) ──
  console.log("\n[Layer 1 · just_listed → JustListedReel, legacy prop shape unchanged]")
  const jl = build(compositionForPromoEvent("just_listed"), thinFacts())
  check("just_listed renders JustListedReel", jl.compositionId === "JustListedReel" && !jl.fellBack)
  check("just_listed props: legacy shape (hook/address/price/imageUrls/brand/voiceover/qr)",
    jl.inputProps.hook === "Just Listed" &&
    jl.inputProps.address === "123 Main Street" &&
    jl.inputProps.price === "$625,000" &&
    Array.isArray(jl.inputProps.imageUrls) &&
    !!jl.inputProps.brand &&
    jl.inputProps.voiceoverUrl === "https://x/vo.mp3" &&
    jl.inputProps.qrCodeDataUrl === "data:image/png;base64,QR")
  check("just_listed props carry NO sold/date fields (legacy reel doesn't read them)",
    !("soldPrice" in jl.inputProps) && !("dateLabel" in jl.inputProps))

  // ── 3. just_sold → JustSoldReelSquare with REQUIRED soldPrice/daysOnMarket ──
  console.log("\n[Layer 1 · just_sold → JustSoldReelSquare with soldPrice + daysOnMarket present]")
  const js = build(compositionForPromoEvent("just_sold"), richFacts())
  check("just_sold renders JustSoldReelSquare (not the legacy reel)",
    js.compositionId === "JustSoldReelSquare" && !js.fellBack)
  check("just_sold props: soldPrice PRESENT", js.inputProps.soldPrice === "$640,000")
  check("just_sold props: daysOnMarket PRESENT", js.inputProps.daysOnMarket === 7)
  check("just_sold props: listPrice carried (drives ABOVE-ASKING badge)",
    js.inputProps.listPrice === "$625,000")
  check("just_sold props: seller-intent CTA", js.inputProps.ctaLabel === "List your home with me")
  check("just_sold props carry NO 'hook' (square sold cut has its own SOLD treatment)",
    !("hook" in js.inputProps))

  // just_sold FALLBACK — no sold price available → legacy reel, flagged honest.
  const jsFallback = build(compositionForPromoEvent("just_sold"), thinFacts())
  check("just_sold FALLBACK: no sold_price → JustListedReel",
    jsFallback.compositionId === "JustListedReel" && jsFallback.fellBack)
  check("just_sold FALLBACK: reason flagged (observability)",
    !!jsFallback.fallbackReason && jsFallback.fallbackReason.includes("sold_price"))
  check("just_sold FALLBACK: props are the legacy shape (renders, never broken)",
    jsFallback.inputProps.hook === "Just Listed" && Array.isArray(jsFallback.inputProps.imageUrls))

  // ── 4. open_house → OpenHouseAnnounceReel with REQUIRED date + time ─────────
  console.log("\n[Layer 1 · open_house → OpenHouseAnnounceReel with dateLabel + timeLabel present]")
  for (const ev of ["open_house_announce", "open_house_reminder"] as const) {
    const oh = build(compositionForPromoEvent(ev), richFacts())
    check(`${ev} renders OpenHouseAnnounceReel`,
      oh.compositionId === "OpenHouseAnnounceReel" && !oh.fellBack)
    check(`${ev} props: dateLabel PRESENT`, oh.inputProps.dateLabel === "This Saturday")
    check(`${ev} props: timeLabel PRESENT`, oh.inputProps.timeLabel === "12:00 - 2:00 PM")
    check(`${ev} props: nested brand carries brokerageName (disclosure line)`,
      !!(oh.inputProps.brand as { brokerageName?: string }).brokerageName)
    check(`${ev} props: agentName resolved`, oh.inputProps.agentName === "Jane Agent")
  }

  // open_house FALLBACK — no schedule available (the route loads none today).
  const ohFallback = build(compositionForPromoEvent("open_house_announce"), thinFacts())
  check("open_house FALLBACK: no date/time → JustListedReel",
    ohFallback.compositionId === "JustListedReel" && ohFallback.fellBack)
  check("open_house FALLBACK: reason flagged",
    !!ohFallback.fallbackReason && ohFallback.fallbackReason.includes("date/time"))

  // Partial open-house facts (date but no time) still falls back — both required.
  const ohPartial = build(compositionForPromoEvent("open_house_announce"),
    thinFacts({ openHouseDate: "This Saturday", openHouseTime: "" }))
  check("open_house FALLBACK: date without time still falls back (both required)",
    ohPartial.compositionId === "JustListedReel" && ohPartial.fellBack)

  // ── 5. coming_soon → ComingSoonReel with teaser + whenString ───────────────
  console.log("\n[Layer 1 · coming_soon → ComingSoonReel with teaser built from facts]")
  const cs = build(compositionForPromoEvent("coming_soon"), thinFacts())
  check("coming_soon renders ComingSoonReel (never a fallback — builds from list facts)",
    cs.compositionId === "ComingSoonReel" && !cs.fellBack)
  check("coming_soon props: whenString headline present", cs.inputProps.whenString === "Coming Soon")
  check("coming_soon props: teaser built from beds/baths/type",
    cs.inputProps.teaser === "3 BD · 2 BA · condo")
  check("coming_soon props: heroImageUrl is the first photo",
    cs.inputProps.heroImageUrl === "https://x/1.jpg")
  check("coming_soon props: DM CTA", cs.inputProps.ctaLabel === "DM me to be first in line")
  check("coming_soon props: brollClips defaults to [] (B-roll is an enhancement)",
    Array.isArray(cs.inputProps.brollClips) && (cs.inputProps.brollClips as unknown[]).length === 0)

  // coming_soon with no facts → still renders ComingSoonReel, teaser null (leans on visuals).
  const csBare = build(compositionForPromoEvent("coming_soon"),
    thinFacts({ bedrooms: "", bathrooms: "", property_type: "", images: [] }))
  check("coming_soon with no facts: still ComingSoonReel, teaser null, heroImage null",
    csBare.compositionId === "ComingSoonReel" && !csBare.fellBack &&
    csBare.inputProps.teaser === null && csBare.inputProps.heroImageUrl === null)

  // ── 6. price_reduction / under_contract → legacy vertical reel ─────────────
  console.log("\n[Layer 1 · price_reduction / under_contract → legacy JustListedReel (script-carried intent)]")
  const pr = build(compositionForPromoEvent("price_reduction"), thinFacts())
  check("price_reduction → JustListedReel, no fallback flag (deliberate target)",
    pr.compositionId === "JustListedReel" && !pr.fellBack)
  const uc = build(compositionForPromoEvent("under_contract"), thinFacts())
  check("under_contract → JustListedReel, no fallback flag (deliberate target)",
    uc.compositionId === "JustListedReel" && !uc.fellBack)

  // ── 7. Pure helpers ────────────────────────────────────────────────────────
  console.log("\n[Layer 1 · pure helpers — teaser builder + days-on-market]")
  check("buildComingSoonTeaser: full → '3 BD · 2 BA · condo'",
    buildComingSoonTeaser(thinFacts()) === "3 BD · 2 BA · condo")
  check("buildComingSoonTeaser: nothing usable → null",
    buildComingSoonTeaser(thinFacts({ bedrooms: "", bathrooms: "", property_type: "" })) === null)
  check("computeDaysOnMarket: 2026-01-01 → 2026-01-08 = 7",
    computeDaysOnMarket("2026-01-01T00:00:00Z", "2026-01-08") === 7)
  check("computeDaysOnMarket: missing sold_date → null",
    computeDaysOnMarket("2026-01-01T00:00:00Z", null) === null)
  check("computeDaysOnMarket: negative (sold before listed) → null",
    computeDaysOnMarket("2026-02-01T00:00:00Z", "2026-01-01") === null)

  // ── Layer 2 (live, read-only) ──────────────────────────────────────────────
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live read-only assertion]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }
  liveLayer().then(report).catch((e) => {
    console.log(`  ✗ Layer 2 threw: ${(e as Error).message}`)
    failed++; failures.push("Layer 2 threw")
    report()
  })
}

/** Layer 2 — READ-ONLY. Pull real listing_promo_videos rows and assert the
 *  router resolves a registered composition for every distinct event_type the
 *  table actually carries. No writes, no render spend. */
async function liveLayer() {
  console.log("\n[Layer 2 · live: real listing_promo_videos event_types route to valid compositions]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()

  const REGISTERED: PromoCompositionId[] = [
    "JustListedReel", "JustSoldReelSquare", "OpenHouseAnnounceReel", "ComingSoonReel",
  ]

  const { data, error } = await svc
    .from("listing_promo_videos")
    .select("event_type")
    .limit(500)
  if (error) {
    check("live: listing_promo_videos read", false, error.message)
    return
  }
  const rows = (data ?? []) as Array<{ event_type: string | null }>
  const distinct = Array.from(new Set(rows.map((r) => r.event_type).filter(Boolean) as string[]))
  if (distinct.length === 0) {
    console.log("  ⏭  No listing_promo_videos rows present — pure layer is authoritative.")
    return
  }
  for (const ev of distinct) {
    const choice = compositionForPromoEvent(ev)
    check(`live: event_type '${ev}' → registered composition ${choice.compositionId}`,
      REGISTERED.includes(choice.compositionId))
  }
}

main()
