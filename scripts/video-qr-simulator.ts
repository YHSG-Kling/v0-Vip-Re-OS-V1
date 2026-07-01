#!/usr/bin/env tsx
/**
 * scripts/video-qr-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE VIDEO OUTRO QR harness — a SCANNABLE, TRACKED QR on the OUTRO of AI-made
 * reels, REUSING the existing qr_codes / qr_scan_events backend (no new tables).
 *
 * Mirrors scripts/offer-net-sheet-simulator.ts: a pure Layer 1 always runs; a
 * live Layer 2 runs only when SUPABASE_SERVICE_ROLE_KEY is set, seeds REAL rows,
 * asserts, then reverse-deletes everything and verifies the cleanup count is 0.
 *
 * Layer 1 (pure, no I/O):
 *   · qrDestinationForKind(kind) maps every kind to the right m148
 *     destination_type + a target-URL builder (just_listed/just_sold→
 *     listing_detail; open_house→book_meeting; presentation_chapter→
 *     video_avatar_tour; anniversary→anniversary_video; newsletter→landing_page).
 *   · QrOutroBadge renders NOTHING without a data URL (and when mlsClean), and
 *     renders the <Img> when a data URL is present.
 *
 * Layer 2 (live, guarded by SUPABASE_SERVICE_ROLE_KEY):
 *   · mintVideoQr inserts ONE real qr_codes row with the correct
 *     destination_type and a resolvable /api/qr/scan?slug= scan URL.
 *   · QRCode.toDataURL returned a valid `data:` URL.
 *   · A second mint for the same (entity, kind) REUSES the same row
 *     (idempotent — scans accrue to one tracked code across re-renders).
 *   · Reverse-delete every seeded row; assert the cleanup count is 0.
 *
 * Run: npx tsx scripts/video-qr-simulator.ts   (npm run test:video-qr)
 */
// lib/video/video-qr.ts imports `server-only`, which throws when loaded
// outside a Server Component (tsx is neither). Neutralize that guard module in
// the require cache BEFORE importing the system under test. This shims ONLY the
// external guard; video-qr itself runs for real.
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* server-only not resolvable — nothing to shim */ }
// ─────────────────────────────────────────────────────────────────────────────

// Types are erased at runtime (safe as static imports); the runtime values are
// imported lazily AFTER the server-only shim above.
import type { VideoQrKind } from "../lib/video/video-qr"
import { shouldRenderQrBadge } from "../remotion/components/QrOutroBadge"

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
  console.log(" ✅ VIDEO_QR_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Video outro QR simulator")
  console.log("══════════════════════════════════════════════════")

  // Lazy-load the runtime values AFTER the server-only shim has registered.
  const { qrDestinationForKind } = await import("../lib/video/video-qr")

  // ── Layer 1 · pure mapping + null-render guard ────────────────────────────
  console.log("\n[Layer 1 · pure kind→destination map + QrOutroBadge null-guard]")

  const ORIGIN = "https://app.example.com"
  const refs = { listingId: "L-1", contactId: "C-1", campaignId: "K-1" }

  const expected: Record<VideoQrKind, { dt: string; urlPart: string }> = {
    just_listed:          { dt: "listing_detail",    urlPart: "/listings/L-1" },
    just_sold:            { dt: "listing_detail",    urlPart: "/listings/L-1" },
    open_house:           { dt: "book_meeting",      urlPart: "/listings/L-1/rsvp" },
    presentation_chapter: { dt: "video_avatar_tour", urlPart: "/tour/L-1" },
    anniversary:          { dt: "anniversary_video", urlPart: "/portal/equity/C-1" },
    newsletter:           { dt: "landing_page",      urlPart: "/n/K-1" },
    lead_intro:           { dt: "book_meeting",      urlPart: "/book" },
    coming_soon:          { dt: "listing_detail",    urlPart: "/listings/L-1" },
    market_update:        { dt: "landing_page",      urlPart: "" },
    cma:                  { dt: "book_meeting",      urlPart: "/home-value" },
    explainer:            { dt: "book_meeting",      urlPart: "/book" },
    testimonial:          { dt: "book_meeting",      urlPart: "/book" },
    neighborhood:         { dt: "landing_page",      urlPart: "" },
  }
  for (const kind of Object.keys(expected) as VideoQrKind[]) {
    const d = qrDestinationForKind(kind)
    const url = d.buildTargetUrl(ORIGIN, refs)
    check(`qrDestinationForKind('${kind}') → destination_type '${expected[kind].dt}'`,
      d.destinationType === expected[kind].dt, `got ${d.destinationType}`)
    check(`qrDestinationForKind('${kind}') target URL contains '${expected[kind].urlPart}'`,
      url.startsWith(ORIGIN) && url.includes(expected[kind].urlPart), `got ${url}`)
  }

  // Every emitted destination_type must be a member of the m148 enum.
  const M148_ENUM = new Set([
    "landing_page", "video_avatar_tour", "cma_form", "listing_detail",
    "book_meeting", "podcast_episode", "anniversary_video", "other",
  ])
  const allInEnum = (Object.keys(expected) as VideoQrKind[]).every(
    (k) => M148_ENUM.has(qrDestinationForKind(k).destinationType))
  check("every emitted destination_type is a valid m148 enum value", allInEnum)

  // ── Layer 1b · the Director threads the QR FLAT + maps every situation + the compositions render it ─
  console.log("\n[Layer 1b · flat threading + situation coverage + composition wiring]")
  const { readFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
  const director = src("lib/video/video-director.ts")
  // THE BUG FIX: commissionVideo must stage qrCodeDataUrl FLAT in input_props (the compositions read it
  // flat, not under `outro`) — otherwise a Director-commissioned reel never shows its tracked QR.
  check("Director stages qrCodeDataUrl FLAT in input_props (both paths)",
    (director.match(/input_props:\s*\{[\s\S]*?qrCodeDataUrl:/g) ?? []).length >= 2)
  check("Director stages a per-situation qrCaption", /qrCaption:\s*qrCaptionForSituation\(situation\.kind\)/.test(director))
  check("qrKindForSituation maps the non-listing kinds to their OWN destination (not the just_listed fallback)",
    /case "market_update": return "market_update"/.test(director) && /case "cma":\s*return "cma"/.test(director) && /case "neighborhood":\s*return "neighborhood"/.test(director))
  for (const comp of ["MarketUpdateReel", "CMAReel", "AgentExplainerReel", "TestimonialReel", "NeighborhoodSpotlightReel", "ComingSoonReel"]) {
    const c = src(`remotion/${comp}.tsx`)
    check(`${comp} renders <QrOutroBadge> reading the flat qrCodeDataUrl prop`,
      /import \{ QrOutroBadge \}/.test(c) && /<QrOutroBadge[\s\S]*?qrCodeDataUrl=\{/.test(c))
  }

  // Builders degrade gracefully when the entity ref is missing (no crash, still a URL).
  const noRefs = {}
  const safeUrls = (Object.keys(expected) as VideoQrKind[]).every((k) => {
    const u = qrDestinationForKind(k).buildTargetUrl(ORIGIN, noRefs)
    return typeof u === "string" && u.startsWith(ORIGIN)
  })
  check("target-URL builders never crash when entity refs are absent", safeUrls)

  // QrOutroBadge null-render contract (pure decision — shouldRenderQrBadge is
  // the exact guard the component runs after its useCurrentFrame() hook, so
  // asserting it needs no Remotion render context):
  //   · renders NOTHING without a data URL
  //   · renders NOTHING when mlsClean (MLS cuts carry no agent QR)
  //   · renders SOMETHING only when a data URL is present and not mlsClean
  check("QrOutroBadge renders null without a data URL",
    shouldRenderQrBadge({ qrCodeDataUrl: null }) === false)
  check("QrOutroBadge renders null with undefined data URL",
    shouldRenderQrBadge({}) === false)
  check("QrOutroBadge renders null when mlsClean=true (no QR on MLS cuts)",
    shouldRenderQrBadge({ qrCodeDataUrl: "data:image/png;base64,AAAA", mlsClean: true }) === false)
  check("QrOutroBadge renders the badge when a data URL is present and not mlsClean",
    shouldRenderQrBadge({ qrCodeDataUrl: "data:image/png;base64,AAAA" }) === true)

  // ── Layer 2 · live mint (REAL qr_codes row, idempotent, reverse-clean) ─────
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live mint]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  console.log("\n[Layer 2 · live mintVideoQr → real qr_codes row]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { mintVideoQr } = await import("../lib/video/video-qr")
  const svc = createServiceClient()
  const cleanup: string[] = [] // qr_codes ids
  const TAG = `vidqr-${Date.now()}`

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id as string
    const agentUserId = (agent as any).user_id as string
    const listingId = `${TAG}-listing` // synthetic ref — qr_codes.listing_id is nullable + un-FK-enforced for this path is fine; use a real listing if available

    // Prefer a real listing for the FK if one exists; otherwise null the ref.
    const { data: realListing } = await svc.from("listings").select("id")
      .eq("brokerage_id", brokerageId).limit(1).maybeSingle()
    const refListingId = (realListing as any)?.id ?? null

    // First mint — just_listed → listing_detail.
    const m1 = await mintVideoQr({
      brokerageId, agentUserId, kind: "just_listed",
      listingId: refListingId, origin: "https://app.example.com",
    }, svc)
    check("mintVideoQr returned a minted code (non-null)", !!m1, m1 ? "" : "got null")
    if (m1) cleanup.push(m1.qrCodeId)

    if (m1) {
      // The row exists with the right destination_type.
      const { data: row } = await svc.from("qr_codes")
        .select("id, slug, target_url, destination_type, is_active, brokerage_id, agent_id")
        .eq("id", m1.qrCodeId).maybeSingle()
      check("qr_codes row persisted with destination_type 'listing_detail'",
        (row as any)?.destination_type === "listing_detail", `got ${(row as any)?.destination_type}`)
      check("qr_codes row is active + tenant-scoped to the brokerage",
        (row as any)?.is_active === true && (row as any)?.brokerage_id === brokerageId)
      check("qr_codes.target_url is the resolvable /api/qr/scan?slug= redirector",
        typeof (row as any)?.target_url === "string" &&
        (row as any).target_url.includes(`/api/qr/scan?slug=${(row as any).slug}`),
        `got ${(row as any)?.target_url}`)
      check("scanUrl encodes the slug redirector (never goes stale)",
        m1.scanUrl.includes(`/api/qr/scan?slug=${m1.slug}`), `got ${m1.scanUrl}`)
      check("QRCode.toDataURL returned a valid data: URL",
        m1.qrCodeDataUrl.startsWith("data:image/png;base64,") && m1.qrCodeDataUrl.length > 100)

      // Idempotent re-mint — SAME (entity, kind) reuses the SAME row.
      const m2 = await mintVideoQr({
        brokerageId, agentUserId, kind: "just_listed",
        listingId: refListingId, origin: "https://app.example.com",
      }, svc)
      check("idempotent re-mint reuses the SAME qr_codes row (one tracked code per entity×kind)",
        !!m2 && m2.qrCodeId === m1.qrCodeId && m2.slug === m1.slug,
        m2 ? `id ${m2.qrCodeId} vs ${m1.qrCodeId}` : "got null")

      // Exactly one active row exists for this label — no duplicate minted.
      const label = `video:just_listed:${refListingId ?? brokerageId}`
      const { count: rowCount } = await svc.from("qr_codes")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId).eq("label", label).eq("is_active", true)
      check("exactly ONE active qr_codes row exists for this (entity, kind)", (rowCount ?? 0) === 1, `count ${rowCount}`)
    }
  } finally {
    for (const id of [...cleanup].reverse()) {
      try { await svc.from("qr_codes").delete().eq("id", id) } catch { /* noop */ }
    }
    // Reverse-delete verified — 0 seeded rows remain for this run's ids.
    let remaining = 0
    for (const id of cleanup) {
      const { count } = await svc.from("qr_codes").select("id", { count: "exact", head: true }).eq("id", id)
      remaining += count ?? 0
    }
    check("cleanup verified — 0 seeded qr_codes rows remain", remaining === 0, `remaining ${remaining}`)
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
