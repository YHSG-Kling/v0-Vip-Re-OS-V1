#!/usr/bin/env tsx
/**
 * scripts/video-pipeline-truth-guard.ts   (npm run test:video-pipeline-truth)
 * ─────────────────────────────────────────────────────────────────────────────
 * VIDEO PIPELINE TRUTH (wave 142, lane 142F) — three owner rules, proven without rendering a
 * frame, calling YouTube, or touching the database:
 *
 *   A. A RENDER IS COMPLETE ONLY WHEN ITS OUTPUT IS PLAYABLE. The pure probe
 *      (lib/video/playable-output.ts) on synthetic MP4 / WebM containers, with POSITIVE
 *      CONTROLS for every defect it was written for (empty, truncated, no ftyp, no moov, no
 *      mdat, zero duration, garbage), and the wiring: the ONE host (media-host) runs it before
 *      the bytes move; the coordinator and the render route escalate an unplayable output to the
 *      Asset Manager in the same request; the signal is catalogued.
 *   B. THE RECURRING FAILURES ARE NAMED. Every recorded root-cause signature classifies the
 *      message it was written for (and a decoy does not); the census folds rows; the queue cron
 *      READS it; the live census runs only with a service key and otherwise says NOT RUN.
 *   C. EVERY PUBLIC LANDING PAGE CARRIES THE ONE VIDEO SLOT with a functional fallback, and no
 *      page renders a bare <video> any more (with a control that the finder still sees one).
 *   D. APPROVED NON-PERSONAL VIDEOS GO TO YOUTUBE THROUGH THE EXISTING RAIL — the classification
 *      matrix, the vocabulary agreement (public ⊂ CHECK, disjoint from the orchestrator's personal
 *      list), the tenant switch (default on; an unreadable read refuses), queue idempotency and
 *      every refusal on an in-memory client, the write-back of the YouTube id onto the asset, the
 *      approval / render-landed / cron wiring, and no-unapproved-publish on the rail.
 *   D9. WAVE 146 (lane 146F — owner ruling 4, contract C5): NON-LISTING VIDEOS ARE STAGED — generated → playable →
 *      rights/branding → audience/channel → approver (C5) → approved → published (lib/video/video-staging.ts); the YouTube
 *      queue and the /v landing door publish a non-listing video only staged and approved BY its assigned approver; a
 *      personal video never reaches a public page.
 *   E. REGISTRATION: package.json key + chain MEMBERSHIP (never a position), MAINTENANCE_DOMAINS.
 *
 * Pure: readFileSync + stripped source (scripts/strip-comments.ts) + scripts/in-memory-supabase.ts.
 * Denominators and blind spots are printed beside the numbers.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { probePlayableOutput, isVideoContentType, describeUnplayable, UNPLAYABLE_OUTPUT_TOKEN } from "../lib/video/playable-output"
import {
  classifyRenderFailure, censusRenderFailures, describeRenderFailureCensus,
  RENDER_FAILURE_SIGNATURES, LIVE_RENDER_FAILURE_CENSUS_SQL,
} from "../lib/remotion/render-failure-census"
import { escalateRenderFailure, RENDER_UNPLAYABLE_SIGNAL } from "../lib/remotion/render-escalation"
import {
  classifyPublicVideo, PUBLIC_MARKETING_VIDEO_TYPES, readVideoAutoPublishPolicy, pickSiteHeroVideo,
  VIDEO_AUTO_PUBLISH_POLICY_KEY, DEFAULT_VIDEO_AUTO_PUBLISH_POLICY,
} from "../lib/video/public-video"
import {
  queueYouTubeAutoPublish, recordYouTubePublishOnAsset, youtubeAutoPublishBrief, videoProjectIdFromBrief, youtubePostTypeFor,
  resolveYouTubePrivacy, backfillYouTubeAutoPublish, sweepYouTubeBackfill,
} from "../lib/video/youtube-publish"
import { CLIENT_FACING_VIDEO_TYPES } from "../lib/video/client-video-delivery"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { classifyCoordination } from "../lib/kernel/coordination-kind"
import { TENANT_POLICY_SETTINGS_KEYS } from "../lib/kernel/tenant-policy"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import {
  NON_LISTING_PUBLIC_VIDEO_TYPES, LISTING_VIDEO_TYPES, VIDEO_STAGES, stagedPublicationVerdict, stageVideoForPublication,
  approveStagedVideo, listStagedVideos,
} from "../lib/video/video-staging"

const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(raw(p))
const masked = (p: string) => blankStrings(raw(p))

let passed = 0, failed = 0
const failures: string[] = []
const blind: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
const section = (t: string) => console.log(`\n[${t}]`)

// ── Synthetic containers ──────────────────────────────────────────────────────
function box(type: string, payload: Buffer): Buffer {
  const h = Buffer.alloc(8); h.writeUInt32BE(8 + payload.length, 0); h.write(type, 4, "latin1"); return Buffer.concat([h, payload])
}
function box64(type: string, payload: Buffer): Buffer {
  const h = Buffer.alloc(16); h.writeUInt32BE(1, 0); h.write(type, 4, "latin1"); h.writeBigUInt64BE(BigInt(16 + payload.length), 8); return Buffer.concat([h, payload])
}
function mvhd0(timescale: number, duration: number): Buffer {
  const b = Buffer.alloc(100); b.writeUInt8(0, 0); b.writeUInt32BE(timescale, 12); b.writeUInt32BE(duration, 16); return box("mvhd", b)
}
function mvhd1(timescale: number, duration: number): Buffer {
  const b = Buffer.alloc(112); b.writeUInt8(1, 0); b.writeUInt32BE(timescale, 20); b.writeBigUInt64BE(BigInt(duration), 24); return box("mvhd", b)
}
const ftyp = box("ftyp", Buffer.from("isom\0\0\0\x01isomavc1", "latin1"))
const mdat = box("mdat", Buffer.alloc(64, 1))
const goodMp4 = Buffer.concat([ftyp, box("moov", mvhd0(30000, 90000)), mdat])
function webm(withSegment: boolean, durationMs: number | null): Buffer {
  const parts: Buffer[] = [Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01])]
  if (withSegment) parts.push(Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))
  if (durationMs !== null) {
    const d = Buffer.alloc(3 + 8); d[0] = 0x44; d[1] = 0x89; d[2] = 0x88; d.writeDoubleBE(durationMs, 3)
    parts.push(Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x8b]), d)
  }
  parts.push(Buffer.alloc(32, 0x1f))
  return Buffer.concat(parts)
}

async function main() {
  // ═══════════════════════════ A · THE PLAYABLE-OUTPUT PROBE ═══════════════════════════
  section("A1 · probe — synthetic containers + positive controls")
  const good = probePlayableOutput(goodMp4, "video/mp4")
  check("a well-formed MP4 (ftyp + moov/mvhd + mdat) is playable", good.ok && good.container === "mp4" && good.mp4?.hasMoov === true && good.mp4?.hasMdat === true, JSON.stringify(good))
  check("…and its duration is read from mvhd (90000/30000 = 3 s)", good.durationSeconds === 3)
  check("mvhd version 1 (64-bit duration) reads the same way", probePlayableOutput(Buffer.concat([ftyp, box("moov", mvhd1(1000, 12500)), mdat]), "video/mp4").durationSeconds === 12.5)
  check("a 64-bit-size box walks correctly", probePlayableOutput(Buffer.concat([ftyp, box("moov", mvhd0(1000, 2000)), box64("mdat", Buffer.alloc(16, 2))]), "video/mp4").ok)
  const empty = probePlayableOutput(Buffer.alloc(0), "video/mp4")
  check("CONTROL: 0 bytes is refused", !empty.ok && empty.reasons[0] === "empty output (0 bytes)")
  check("CONTROL: null bytes are refused, never thrown on", !probePlayableOutput(null, "video/mp4").ok)
  const noFtyp = probePlayableOutput(Buffer.concat([box("free", Buffer.alloc(4)), box("moov", mvhd0(1000, 1000)), mdat]), "video/mp4")
  check("CONTROL: a file whose first box is not ftyp is refused and the box is named", !noFtyp.ok && /first box is 'free'/.test(noFtyp.reasons.join()))
  const noMoov = probePlayableOutput(Buffer.concat([ftyp, mdat]), "video/mp4")
  check("CONTROL: no moov box is refused (no track table — nothing can play)", !noMoov.ok && /no 'moov'/.test(noMoov.reasons.join()))
  const noMdat = probePlayableOutput(Buffer.concat([ftyp, box("moov", mvhd0(1000, 1000))]), "video/mp4")
  check("CONTROL: no mdat box is refused (no samples)", !noMdat.ok && /no 'mdat'/.test(noMdat.reasons.join()))
  const truncated = probePlayableOutput(goodMp4.subarray(0, goodMp4.length - 10), "video/mp4")
  check("CONTROL: a truncated upload is refused and says so", !truncated.ok && /truncated/.test(truncated.reasons.join()))
  const zeroDur = probePlayableOutput(Buffer.concat([ftyp, box("moov", mvhd0(1000, 0)), mdat]), "video/mp4")
  check("CONTROL: a zero-duration movie is refused", !zeroDur.ok && /duration is 0/.test(zeroDur.reasons.join()))
  const garbage = probePlayableOutput(Buffer.from("<html>not a video at all, really not</html>"), "video/mp4")
  check("CONTROL: garbage bytes under video/mp4 are refused", !garbage.ok)
  const wGood = probePlayableOutput(webm(true, 4200), "video/webm")
  check("a WebM with EBML magic + Segment is playable; the Info Duration is read (4.2 s)", wGood.ok && wGood.container === "webm" && wGood.durationSeconds === 4.2, JSON.stringify(wGood))
  check("CONTROL: a WebM without a Segment is refused", !probePlayableOutput(webm(false, null), "video/webm").ok)
  check("CONTROL: MP4 bytes labelled video/webm are refused (no EBML magic)", !probePlayableOutput(goodMp4, "video/webm").ok)
  const png = probePlayableOutput(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png")
  check("a non-video content type is SKIPPED (ok, not_video) — the host also stores PNG/PDF/MP3", png.ok && png.container === "not_video")
  check("isVideoContentType: video/* only", isVideoContentType("video/mp4") && isVideoContentType("VIDEO/webm") && !isVideoContentType("image/png") && !isVideoContentType("audio/mpeg"))
  check("describeUnplayable carries the ONE token the census keys on", describeUnplayable(noMoov).includes(UNPLAYABLE_OUTPUT_TOKEN) && classifyRenderFailure(`[media-host] refusing to host video-assets/x.mp4: ${describeUnplayable(noMoov)}`).bucket === "unplayable_output")

  section("A2 · wiring — the ONE host probes before the bytes move; the failure is owned in-request")
  const host = code("lib/remotion/media-host.ts")
  const probeIdx = host.indexOf("probePlayableOutput(bytes, contentType)")
  const gateIdx = host.indexOf("checkUpload({")
  const uploadIdx = host.indexOf(".upload(path, bytes")
  check("media-host runs probePlayableOutput on video/* BEFORE the limit gate and the upload", probeIdx > 0 && gateIdx > probeIdx && uploadIdx > gateIdx && /if \(isVideoContentType\(contentType\)\)\s*\{\s*const probe = probePlayableOutput\(bytes, contentType\)\s*if \(!probe\.ok\)\s*\{\s*throw new Error\(`\[media-host\] refusing to host \$\{bucket\}\/\$\{path\}[^`]*\$\{describeUnplayable\(probe\)\}`\)/.test(host))
  check("CONTROL: the finder would still see the old host shape (no probe)", !/probePlayableOutput\(/.test("export async function hostRenderedMedia(svc, path, bytes, contentType) { const gate = checkUpload({ bucket }) }"))
  const coord = code("lib/remotion/render-coordinator.ts")
  const cFail = coord.indexOf('status:        "failed"')
  const cEsc = coord.indexOf("escalateRenderFailure(svc, {")
  const cRet = coord.indexOf("return { ok: false, error: (e as Error).message }")
  check("render-coordinator: the catch marks the row failed, THEN escalates, THEN returns ok:false", cFail > 0 && cEsc > cFail && cRet > cEsc && /brokerageId: intent\.brokerageId, renderId, compositionId: composition\.composition_id, error: \(e as Error\)\.message/.test(coord))
  const route = code("app/api/internal/remotion/render-composition/route.ts")
  check("render-composition: the outer catch escalates with the row's tenant + ids", /escalateRenderFailure\(svc, \{ brokerageId: row\.brokerage_id, renderId: row\.id, compositionId: row\.composition_id, error: msg \}\)/.test(route))
  const spec = SIGNAL_REGISTRY[RENDER_UNPLAYABLE_SIGNAL]
  check(`the signal '${RENDER_UNPLAYABLE_SIGNAL}' is catalogued, feed-only, and classifies as an escalation`, !!spec && spec.disposition === "feed_only" && spec.kind === "escalation" && classifyCoordination(RENDER_UNPLAYABLE_SIGNAL) === "escalation")
  const notUnplayable = await escalateRenderFailure(memSupabase({ manager_signals: [] }), { brokerageId: "b", renderId: "r", compositionId: "JustListedReel", error: "claim_refused: PGRST204" })
  check("escalateRenderFailure leaves every OTHER class to the queue retry + the OS-health sweep (no signal)", !notUnplayable.escalated && notUnplayable.bucket === "claim_refused")
  try {
    const mem = memSupabase({ manager_signals: [] }, { uuidIds: true })
    const esc = await escalateRenderFailure(mem, { brokerageId: "00000000-0000-4000-8000-000000000001", renderId: "00000000-0000-4000-8000-00000000000a", compositionId: "JustListedReel", error: `[media-host] refusing to host x: ${describeUnplayable(noMoov)}` })
    const row = mem.tables.manager_signals?.[0]
    check("an UNPLAYABLE failure publishes ONE manager signal to asset_manager with the render as entity", esc.escalated && !!row && row.to_manager === "asset_manager" && row.signal_type === RENDER_UNPLAYABLE_SIGNAL && row.entity_type === "remotion_composition_render" && row.payload?.bucket === "unplayable_output", JSON.stringify({ esc, row }))
  } catch (e) {
    blind.push(`escalation executed end-to-end: NOT RUN — lib/kernel/manager-signals could not load here (${(e as Error).message.slice(0, 120)}); the wiring + catalogue checks above hold the rule`)
    console.log("  · escalation end-to-end: NOT RUN (manager-signals graph not loadable in this runner) — stated as a blind spot, not a pass")
  }

  // ═══════════════════════════ B · THE FAILURE CENSUS ═══════════════════════════
  section("B1 · every recorded root-cause signature classifies its own message")
  const samples: Array<[string, string]> = [
    ["unplayable_output", "[media-host] refusing to host video-assets/compositions/x.mp4: output not playable (mp4, 12 bytes) — no 'moov' box"],
    ["content_contract", "content_props_missing: JustListedReel is missing address, price"],
    ["claim_refused", "claim_refused: column \"retry_count\" does not exist"],
    ["asset_load_timeout", "A delayRender() \"Loading <Img> with src=https://cdn/photo.jpg\" was called but not cleared after 30000ms. See https://remotion.dev/docs/timeout for help."],
    ["browser_network", "NetworkError: A network error occurred."],
    ["browser_network", "Failed to load resource: net::ERR_CERT_AUTHORITY_INVALID https://fonts.gstatic.com/s/inter/v20/UcC73Fwr.woff2"],
    ["media_decode", "Error loading image with src: https://cdn/listing/404.jpg (cancelRender after 1 retry)"],
    ["bundle_resolve", "Module not found: Error: Can't resolve '@/lib/format/math' in '/vercel/path0/remotion/components'"],
    ["chromium_launch", "Failed to launch the browser process! /tmp/chromium: error while loading shared libraries"],
    ["frame_interpolation", "inputRange must be strictly monotonically increasing but got [0,10,36,36]"],
    ["ffmpeg_stitch", "ffmpeg exited 1: [AVFilterGraph] Error initializing filters: Invalid argument"],
    ["function_timeout", "Task timed out after 300.00 seconds (FUNCTION_INVOCATION_TIMEOUT)"],
    ["memory", "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory"],
    ["host_refused", "[media-host] video-assets/compositions/x.mp4 upload refused: The resource was not found (bucket)"],
    ["provider", "D-ID talk failed: InsufficientCreditsError"],
    ["not_renderable", "composition_not_reachable_at_tier:solo_agent"],
  ]
  for (const [bucket, msg] of samples) {
    const c = classifyRenderFailure(msg)
    check(`'${bucket}' ← ${msg.slice(0, 60)}…`, c.bucket === bucket, `got ${c.bucket}`)
  }
  check("an empty / null message is 'unknown' (printed, never hidden)", classifyRenderFailure("").bucket === "unknown" && classifyRenderFailure(null).bucket === "unknown")
  check("CONTROL: a decoy message matches no signature", classifyRenderFailure("the composition rendered and the client loved it").bucket === "unknown")
  check("every signature names its root cause, its evidence (a file, note or commit) and its fix", RENDER_FAILURE_SIGNATURES.every((s) => s.rootCause.length > 40 && /lib\/|app\/|lane|commit|build\.yml|remotion\//.test(s.evidence) && s.fix.length > 20) && RENDER_FAILURE_SIGNATURES.length >= 12)
  const census = censusRenderFailures([
    { id: "r1", composition_id: "JustListedReel", error_message: samples[0][1], retry_count: 2 },
    { id: "r2", composition_id: "JustListedReel", error_message: samples[0][1], retry_count: 0 },
    { id: "r3", composition_id: "MarketUpdateReel", error_message: samples.find((s) => s[0] === "function_timeout")![1], retry_count: 1 },
    { id: "r4", composition_id: null, error_message: null, retry_count: null },
  ])
  check("censusRenderFailures folds rows by bucket with retry-exhausted counts and compositions", census.total === 4 && census.byBucket.unplayable_output?.count === 2 && census.byBucket.unplayable_output?.retryExhausted === 1 && census.byBucket.function_timeout?.count === 1 && census.byBucket.unknown?.count === 1 && census.byBucket.unplayable_output?.compositions.join() === "JustListedReel", JSON.stringify(census))
  check("an empty input is an honest empty census (0, no buckets)", censusRenderFailures([]).total === 0 && Object.keys(censusRenderFailures([]).byBucket).length === 0)
  check("describeRenderFailureCensus prints one line per bucket", describeRenderFailureCensus(census).length === 3)
  // WAVE 143 (lane 143F): the bucket list is DERIVED from the signatures, not copied here — a hard-coded list is a waypoint that
  // went stale the day a bucket (browser_network) was added; the rule is "the SQL names every bucket the code can emit".
  const emitted = [...new Set(RENDER_FAILURE_SIGNATURES.map((s) => s.bucket))]
  check(`the integrator's SQL names every bucket the code classifies (${emitted.length} derived from the signatures — one vocabulary)`, emitted.length >= 15 && emitted.every((b) => LIVE_RENDER_FAILURE_CENSUS_SQL.includes(`'${b}'`)) && /from remotion_composition_renders/.test(LIVE_RENDER_FAILURE_CENSUS_SQL))
  check("CONTROL: the derivation would catch a bucket the SQL forgot", !LIVE_RENDER_FAILURE_CENSUS_SQL.replace("'browser_network'", "'x'").includes("'browser_network'") && emitted.includes("browser_network"))
  check("the browser_network signature records the MEASURED root cause (the module-scope font load that failed every composition) and the real-render evidence", (() => { const s = RENDER_FAILURE_SIGNATURES.find((x) => x.bucket === "browser_network"); return !!s && /MODULE scope/.test(s.rootCause) && /remotion-real-render-probe/.test(s.evidence) && /ProductPromoReel/.test(s.evidence) })())
  const promo = code("remotion/ProductPromoReel.tsx")
  check("THE FIX HOLDS: remotion/ProductPromoReel.tsx requests the Inter font only when the composition renders — no module-scope loadFont (it failed every composition's bundle)", /let interFamily: string \| null = null/.test(promo) && /function loadedInter\(\)/.test(promo) && !/^const \{[^}]*\} = loadFont\(/m.test(promo) && !/^loadFont\(/m.test(promo))
  check("CONTROL: the old module-scope shape would still be found", /^const \{ fontFamily: loadedInterFamily \} = loadFont\(/m.test('const { fontFamily: loadedInterFamily } = loadFont("normal", { weights: ["400"] })'))
  // A font loader at module scope = a line that starts in column 0 (not an import) and calls loadFont( — stripped source, so a comment naming it is not one.
  const MODULE_SCOPE_FONT = /^(?!import\b)\S.*\bloadFont\(/m
  check("CONTROL: the module-scope finder sees a column-0 loadFont call and ignores an indented one and an import", MODULE_SCOPE_FONT.test('const { fontFamily } = loadFont("normal", {})') && !MODULE_SCOPE_FONT.test('function f() {\n  if (x === null) x = loadFont("normal", {})\n}') && !MODULE_SCOPE_FONT.test('import { loadFont } from "@remotion/google-fonts/Inter"'))
  const moduleScopeFonts = ["remotion"].flatMap((d) => { const out: string[] = []; const w = (x: string) => { for (const n of readdirSync(join(ROOT, x))) { const p = `${x}/${n}`; if (statSync(join(ROOT, p)).isDirectory()) w(p); else if (/\.tsx?$/.test(n)) out.push(p) } }; w(d); return out }).filter((f) => MODULE_SCOPE_FONT.test(code(f)))
  check(`NO composition file under remotion/ calls a font loader at module scope (${moduleScopeFonts.length} found)`, moduleScopeFonts.length === 0, moduleScopeFonts.join(", "))

  section("B2 · the reader — the queue cron folds the week's failures on every tick")
  const cron = code("app/api/cron/composition-render-queue/route.ts")
  check("composition-render-queue reads failed rows (7 d) through censusRenderFailures and reports failure_census", /censusRenderFailures\(/.test(cron) && /\.eq\("render_status", "failed"\)\s*\.gte\("created_at", since\)/.test(cron) && (cron.match(/failure_census: failureCensus/g) ?? []).length === 2)
  check("…and a refused read is REPORTED (error on the census), never read as zero", /census read refused: \$\{censusErr\.message\}/.test(cron))

  section("B3 · LIVE census (read-only, gated on a service key)")
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (url && key) {
    try {
      const { createClient } = await import("@supabase/supabase-js")
      const live = createClient(url, key, { auth: { persistSession: false } })
      const { data, error } = await live.from("remotion_composition_renders").select("id, composition_id, error_message, retry_count").in("render_status", ["failed", "cancelled"]).limit(500)
      if (error) { blind.push(`live census: read refused — ${error.message}`); console.log(`  · live census: read refused — ${error.message}`) }
      else {
        const c = censusRenderFailures((data ?? []) as Array<{ id: string; composition_id: string | null; error_message: string | null; retry_count: number | null }>)
        console.log(`  · live census: ${c.total} failed/cancelled rows — ${describeRenderFailureCensus(c).join(" | ") || "(none)"}`)
        if (c.total === 0) blind.push("live census: 0 failed/cancelled rows — the platform has not rendered in production (integrator census 2026-10-19: every video table empty); nothing here is PROVEN from production data")
      }
    } catch (e) { blind.push(`live census: NOT RUN — ${(e as Error).message.slice(0, 120)}`); console.log(`  · live census NOT RUN: ${(e as Error).message.slice(0, 120)}`) }
  } else {
    blind.push("live census: NOT RUN — no service key in this runner; the integrator's 2026-10-19 census read remotion_composition_renders at 0 rows (LIVE_RENDER_FAILURE_CENSUS_SQL is the query)")
    console.log("  · live census NOT RUN — no service key here (the live table held 0 rows on 2026-10-19 per the integrator; LIVE_RENDER_FAILURE_CENSUS_SQL is the SQL-editor query)")
  }

  // ═══════════════════════════ C · THE LANDING VIDEO SLOT ═══════════════════════════
  section("C · one video slot, functional fallback, no bare <video> on any public landing page")
  const slot = raw("app/components/public-site/LandingVideo.tsx")
  const slotCode = stripComments(slot)
  check("LandingVideo is a client component with onError → fallback state", /^"use client"/.test(slot) && /onError=\{\(\) => setFailed\(true\)\}/.test(slotCode))
  check("…renders the fallback (poster or still + optional link) BEFORE any <video>, so a missing/dead source never shows a broken player", slotCode.indexOf("if (!playable)") > 0 && slotCode.indexOf("if (!playable)") < slotCode.indexOf("<video") && /data-landing-video-fallback="true"/.test(slotCode) && /fallbackHref && \(/.test(slotCode))
  check("…never autoplays unless the caller says so (a landing page must not start sound on load)", /autoPlay=\{autoPlay \?\? false\}/.test(slotCode))
  const pages: Array<[string, RegExp]> = [
    ["app/lm/[slug]/page.tsx", /<LandingVideo\s[\s\S]{0,200}poster=\{videoPoster\}/],
    ["app/site/[slug]/page.tsx", /<LandingVideo\s[\s\S]{0,300}fallbackHref=\{heroVideo\.youtubeUrl \?\? `\/v\/\$\{heroVideo\.slug\}`\}/],
    ["app/listings/[listingId]/page.tsx", /<LandingVideo\s[\s\S]{0,200}poster=\{video\.thumbnail_url \?\? null\}/],
    ["app/components/listing-landing/ListingHero.tsx", /<LandingVideo\s[\s\S]{0,200}autoPlay/],
  ]
  for (const [p, re] of pages) {
    const src = code(p)
    check(`${p}: mounts LandingVideo (poster / fallback wired) and renders NO bare <video>`, re.test(src) && !/<video[\s>]/.test(src), `bare <video> count ${(src.match(/<video[\s>]/g) ?? []).length}`)
  }
  check("CONTROL: the bare-<video> finder still sees the old page shape", /<video[\s>]/.test('{landing.videoUrl && (<video controls src={landing.videoUrl} />)}'))
  check("app/lm/[slug]: the poster is the reel's own thumbnail, read in the form's tenant", /from\("ai_video_projects"\)[\s\S]{0,120}\.eq\("id", videoProjectId\)\s*\.eq\("brokerage_id", brokerageId\)/.test(code("app/lm/[slug]/page.tsx")))
  const site = code("app/site/[slug]/page.tsx")
  check("app/site/[slug]: the slot is fed by pickSiteHeroVideo and rendered ONLY when a reel exists", /pickSiteHeroVideo\(svc, b\.id\)/.test(site) && /\{heroVideo && \(/.test(site))
  check("app/site/[slug]: the YouTube write-back HAS A READER — the player's fallback link prefers the channel copy and a 'Watch on YouTube' link renders when one exists", /fallbackHref=\{heroVideo\.youtubeUrl \?\? `\/v\/\$\{heroVideo\.slug\}`\}/.test(site) && /heroVideo\.youtubeUrl && \(/.test(site) && /rel="noopener noreferrer"/.test(site))
  {
    const old = "2026-01-01T00:00:00Z", newer = "2026-02-01T00:00:00Z", newest = "2026-03-01T00:00:00Z"
    const base = { brokerage_id: "b1", is_published: true, audience_type: "customer_facing", usage_intent: "public_marketing", approval_status: "approved", status: "published", compliance_status: "passed", thumbnail_url: "https://cdn/t.png" }
    const mem = memSupabase({ ai_video_projects: [
      { id: "p-old", ...base, video_type: "listing_promo", contact_id: null, video_url: "https://cdn/old.mp4", public_slug: "old-reel", published_at: old, title: "Old reel" },
      { id: "p-client", ...base, video_type: "market_update", contact_id: "c1", video_url: "https://cdn/client.mp4", public_slug: "client-reel", published_at: newest, title: "Client's market update" },
      { id: "p-unpub", ...base, is_published: false, video_type: "just_listed", contact_id: null, video_url: "https://cdn/unpub.mp4", public_slug: null, published_at: newest, title: "Unpublished" },
      { id: "p-other", ...base, brokerage_id: "b2", video_type: "just_listed", contact_id: null, video_url: "https://cdn/other.mp4", public_slug: "other", published_at: newest, title: "Other tenant" },
      { id: "p-new", ...base, video_type: "just_sold", contact_id: null, video_url: "https://cdn/new.mp4", public_slug: "new-reel", published_at: newer, title: "Just sold", video_metadata: { youtube: { video_id: "abc", url: "https://www.youtube.com/watch?v=abc" } } },
    ] })
    const pick = await pickSiteHeroVideo(mem, "b1")
    check("pickSiteHeroVideo picks the NEWEST published PUBLIC reel of THIS tenant — never a client-addressed, unpublished or other-tenant row", pick?.projectId === "p-new" && pick.slug === "new-reel" && pick.videoUrl === "https://cdn/new.mp4", JSON.stringify(pick))
    check("…and READS the YouTube write-back off the asset (video_metadata.youtube.url) for the storefront's working fallback link", pick?.youtubeUrl === "https://www.youtube.com/watch?v=abc")
    const unpublished = await pickSiteHeroVideo(memSupabase({ ai_video_projects: [{ id: "p-nyt", ...base, video_type: "just_sold", contact_id: null, video_url: "https://cdn/n.mp4", public_slug: "n", published_at: newer, title: "No YouTube yet", video_metadata: { youtube: { queued_social_post_id: "x" } } }] }), "b1")
    check("…and youtubeUrl is null until the cron has recorded a url (a queued-only stamp is not a link)", unpublished?.projectId === "p-nyt" && unpublished.youtubeUrl === null)
    check("…and resolves null (no slot) for a tenant with none, and on a refused read", (await pickSiteHeroVideo(mem, "b3")) === null && (await pickSiteHeroVideo(memSupabase({}, { refuse: { ai_video_projects: "RLS" } }), "b1")) === null)
  }

  // ═══════════════════════════ D · YOUTUBE ═══════════════════════════
  section("D1 · classification — public marketing vs personal / client / in-house / unapproved")
  const pub = { video_type: "just_listed", audience_type: "customer_facing", usage_intent: "public_marketing", contact_id: null, approval_status: "approved", status: "completed", compliance_status: "passed", video_url: "https://cdn/v.mp4" }
  check("an approved, finished, compliant, unaddressed just_listed is PUBLIC (privacy public)", classifyPublicVideo(pub).public === true)
  check("…and `both` usage + approval_status 'published' + status 'published' are public too", classifyPublicVideo({ ...pub, usage_intent: "both", approval_status: "published", status: "published" }).public)
  const refusals: Array<[string, Record<string, unknown>, string]> = [
    ["a welcome video (personal kind)", { video_type: "welcome" }, "personal_or_client_kind"],
    ["a memory film (personal kind)", { video_type: "memory_video" }, "personal_or_client_kind"],
    ["a presentation chapter (one seller's)", { video_type: "presentation_chapter" }, "personal_or_client_kind"],
    ["a listing_tour addressed to a client", { video_type: "listing_tour", contact_id: "c" }, "personal_or_client_kind"],
    ["a market_update ADDRESSED to a contact (client media)", { contact_id: "c1" }, "addressed_to_a_contact"],
    ["an in-house cut", { audience_type: "in_house" }, "in_house_audience"],
    ["the MLS-only cut", { usage_intent: "mls" }, "mls_only_cut"],
    ["pending review", { approval_status: "pending_review" }, "not_approved"],
    ["rejected", { approval_status: "rejected" }, "not_approved"],
    ["still generating", { status: "generating" }, "not_finished"],
    ["compliance needs_review", { compliance_status: "needs_review" }, "compliance_not_passed"],
    ["compliance failed", { compliance_status: "failed" }, "compliance_not_passed"],
    ["no file", { video_url: null }, "not_rendered"],
  ]
  for (const [label, patch, reason] of refusals) {
    const v = classifyPublicVideo({ ...pub, ...patch })
    check(`NEVER public: ${label} → ${reason}`, !v.public && v.reason === reason, JSON.stringify(v))
  }
  const checkTypes = CHECK_VOCABULARIES.ai_video_projects?.video_type ?? []
  check(`PUBLIC_MARKETING_VIDEO_TYPES ⊂ the live ai_video_projects.video_type CHECK (${PUBLIC_MARKETING_VIDEO_TYPES.length} of ${checkTypes.length})`, checkTypes.length > 0 && PUBLIC_MARKETING_VIDEO_TYPES.every((t) => checkTypes.includes(t)))
  const orch = code("lib/orchestrator/internal.ts")
  const personal = (/personalVideoTypes\s*=\s*\[([^\]]*)\]/.exec(orch)?.[1] ?? "").split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean)
  check(`PUBLIC ∩ the orchestrator's personalVideoTypes (${personal.join(", ")}) = ∅`, personal.length >= 3 && !PUBLIC_MARKETING_VIDEO_TYPES.some((t) => personal.includes(t)))
  const overlap = PUBLIC_MARKETING_VIDEO_TYPES.filter((t) => (CLIENT_FACING_VIDEO_TYPES as readonly string[]).includes(t))
  // WAVE 143 (lane 143F): re-asserted as the RULE, not the waypoint. The overlap used to be {market_update} only; the owner's
  // "all approved non-personal videos → YouTube" admits avatar_explainer and education too (made for nobody = broadcast; made
  // for a contact = that contact's). The invariant that matters: EVERY overlapping kind is refused the moment it is addressed,
  // and an education-OS module video is never marketing. The overlap list is DERIVED and each member is driven both ways.
  check(`PUBLIC ∩ CLIENT_FACING_VIDEO_TYPES = [${overlap.join(", ")}] — each is public only when unaddressed (driven both ways below); listing_tour / presentation_chapter / pre_appointment / welcome stay OUT`, overlap.length >= 1 && overlap.every((t) => classifyPublicVideo({ ...pub, video_type: t }).public === true && classifyPublicVideo({ ...pub, video_type: t, contact_id: "c1" }).public === false) && !PUBLIC_MARKETING_VIDEO_TYPES.some((t) => ["listing_tour", "presentation_chapter", "pre_appointment", "welcome", "memory_video", "home_anniversary"].includes(t)))
  check("…the owner's two new broadcast kinds (avatar_explainer, education) are in, unaddressed → PUBLIC; addressed → addressed_to_a_contact", overlap.includes("avatar_explainer") && overlap.includes("education") && (classifyPublicVideo({ ...pub, video_type: "avatar_explainer", contact_id: "c" }) as { reason?: string }).reason === "addressed_to_a_contact")
  const moduleVideo = classifyPublicVideo({ ...pub, video_type: "education", learning_module_id: "m1" }) as { public: boolean; reason?: string }
  check("…and an education-OS MODULE video (learning_module_id) is platform training, never marketing → education_module_video", !moduleVideo.public && moduleVideo.reason === "education_module_video")

  section("D2 · the tenant switch — default on, explicit off honoured, unreadable refuses")
  check(`'${VIDEO_AUTO_PUBLISH_POLICY_KEY}' is a registered tenant policy key (the constitution lists it)`, !!TENANT_POLICY_SETTINGS_KEYS[VIDEO_AUTO_PUBLISH_POLICY_KEY] && TENANT_POLICY_SETTINGS_KEYS[VIDEO_AUTO_PUBLISH_POLICY_KEY].store === "brokerage_settings.settings")
  check("no settings row → DEFAULT ON", (await readVideoAutoPublishPolicy(memSupabase({ brokerage_settings: [] }), "b1")).youtube === true && DEFAULT_VIDEO_AUTO_PUBLISH_POLICY.youtube === true)
  check("a row without the key → default on; { youtube: false } → OFF", (await readVideoAutoPublishPolicy(memSupabase({ brokerage_settings: [{ brokerage_id: "b1", settings: {} }] }), "b1")).youtube === true && (await readVideoAutoPublishPolicy(memSupabase({ brokerage_settings: [{ brokerage_id: "b1", settings: { [VIDEO_AUTO_PUBLISH_POLICY_KEY]: { youtube: false } } }] }), "b1")).youtube === false)
  const refused = await readVideoAutoPublishPolicy(memSupabase({}, { refuse: { brokerage_settings: "permission denied" } }), "b1")
  check("a REFUSED settings read fails CLOSED (readable:false, youtube:false, reason named)", !refused.readable && !refused.youtube && /permission denied/.test(refused.reason ?? ""))

  section("D3 · queueYouTubeAutoPublish on an in-memory client — one post, idempotent, every refusal named")
  const B = "00000000-0000-4000-8000-0000000000b1", A = "00000000-0000-4000-8000-0000000000a1", U = "00000000-0000-4000-8000-0000000000e1"
  const VID = "11111111-1111-4111-8111-111111111111"
  const project = (patch: Record<string, unknown> = {}) => ({
    id: VID, brokerage_id: B, agent_id: A, listing_id: null, marketing_campaign_id: null, title: "Just listed: 12 Oak",
    video_type: "just_listed", audience_type: "customer_facing", usage_intent: "public_marketing", contact_id: null,
    approval_status: "approved", status: "completed", compliance_status: "passed", video_url: "https://cdn/12-oak.mp4",
    script_content: "Welcome to 12 Oak Street — a three-bedroom home now on the market.", video_metadata: { content_kit: { built_by: "x" } }, ...patch,
  })
  const seed = (patch: Record<string, unknown> = {}, extra: Record<string, any[]> = {}) => memSupabase({
    ai_video_projects: [project(patch)],
    agents: [{ id: A, brokerage_id: B, user_id: U }],
    social_media_accounts: [{ id: "acct-yt", brokerage_id: B, agent_id: A, platform: "youtube", is_active: true }, { id: "acct-fb", brokerage_id: B, agent_id: A, platform: "facebook", is_active: true }],
    social_posts: [], brokerage_settings: [], marketing_assets: [],
    ...extra,
  }, { uuidIds: true })
  {
    const mem = seed()
    const r1 = await queueYouTubeAutoPublish(mem, VID)
    const post = mem.tables.social_posts[0]
    check("an approved public video with a connected YouTube account queues ONE social_posts row on the rail", r1.queued && !("alreadyQueued" in r1 && r1.alreadyQueued) && mem.tables.social_posts.length === 1, JSON.stringify(r1))
    check("…platform youtube, approved + scheduled (the cron's own gate), the YouTube account, the file, the brief key", !!post && post.platform === "youtube" && post.approval_status === "approved" && post.status === "scheduled" && post.social_account_id === "acct-yt" && post.media_urls?.[0] === "https://cdn/12-oak.mp4" && post.post_brief === youtubeAutoPublishBrief(VID) && post.post_type === "new_listing", JSON.stringify(post))
    check("…agents.id crossed to users.id for social_posts.user_id (§3 — disjoint id spaces)", post?.agent_id === A && post?.user_id === U)
    check("…the decision's evidence is stamped on the asset (video_metadata.youtube.queued_social_post_id, rule, policy key)", mem.tables.ai_video_projects[0].video_metadata?.youtube?.queued_social_post_id === post?.id && mem.tables.ai_video_projects[0].video_metadata?.youtube?.rule === "auto_publish_after_approval" && mem.tables.ai_video_projects[0].video_metadata?.content_kit?.built_by === "x")
    const r2 = await queueYouTubeAutoPublish(mem, VID)
    check("a second call (approval hook + render-landed hook both fire) is IDEMPOTENT — same post, still one row", r2.queued && "alreadyQueued" in r2 && r2.alreadyQueued && r2.socialPostId === post?.id && mem.tables.social_posts.length === 1)
  }
  {
    const mem = seed({ contact_id: "22222222-2222-4222-8222-222222222222", video_type: "market_update" })
    const r = await queueYouTubeAutoPublish(mem, VID)
    check("a CLIENT video (addressed to a contact) is refused with its reason and nothing is queued", !r.queued && /addressed_to_a_contact/.test(r.reason) && mem.tables.social_posts.length === 0)
  }
  {
    const mem = seed({ video_type: "welcome" })
    const r = await queueYouTubeAutoPublish(mem, VID)
    check("a PERSONAL kind (welcome) is refused and nothing is queued", !r.queued && /personal_or_client_kind/.test(r.reason) && mem.tables.social_posts.length === 0)
  }
  {
    const mem = seed({ approval_status: "pending_review" })
    const r = await queueYouTubeAutoPublish(mem, VID)
    check("an UNAPPROVED video never reaches the rail", !r.queued && /not_approved/.test(r.reason) && mem.tables.social_posts.length === 0)
  }
  {
    const mem = seed({}, { brokerage_settings: [{ brokerage_id: B, settings: { [VIDEO_AUTO_PUBLISH_POLICY_KEY]: { youtube: false } } }] })
    const r = await queueYouTubeAutoPublish(mem, VID)
    check("the tenant switch OFF refuses (reason names the key) and nothing is queued", !r.queued && r.reason.includes(VIDEO_AUTO_PUBLISH_POLICY_KEY) && mem.tables.social_posts.length === 0)
  }
  {
    const mem = seed({}, { social_media_accounts: [{ id: "acct-fb", brokerage_id: B, agent_id: A, platform: "facebook", is_active: true }, { id: "acct-yt-off", brokerage_id: B, agent_id: A, platform: "youtube", is_active: false }] })
    const r = await queueYouTubeAutoPublish(mem, VID)
    check("no ACTIVE YouTube account → refused with an actionable reason, nothing queued", !r.queued && /YouTube account/.test(r.reason) && mem.tables.social_posts.length === 0)
  }
  {
    const mem = seed({}, { social_media_accounts: [{ id: "acct-yt-other", brokerage_id: "00000000-0000-4000-8000-0000000000b2", agent_id: A, platform: "youtube", is_active: true }] })
    const r = await queueYouTubeAutoPublish(mem, VID)
    check("another tenant's YouTube account is never used (tenant-pinned read)", !r.queued && mem.tables.social_posts.length === 0)
  }
  {
    const mem = memSupabase({ ai_video_projects: [project()], agents: [], social_media_accounts: [], social_posts: [] }, { refuse: { brokerage_settings: "permission denied" } })
    const r = await queueYouTubeAutoPublish(mem, VID)
    check("an UNREADABLE policy refuses (fail closed) — never publishes on a guess", !r.queued && /unreadable/.test(r.reason) && mem.tables.social_posts.length === 0)
  }
  check("youtubePostTypeFor maps onto the live social_posts.post_type CHECK", ["just_listed", "listing_promo", "just_sold", "coming_soon", "open_house_promo", "market_update", "testimonial", null].every((t) => (CHECK_VOCABULARIES.social_posts?.post_type ?? []).includes(youtubePostTypeFor(t))) && youtubePostTypeFor("testimonial") === "custom")
  check("videoProjectIdFromBrief reads back only this module's brief with a uuid", videoProjectIdFromBrief(youtubeAutoPublishBrief(VID)) === VID && videoProjectIdFromBrief("FARM PLAY — Asset Manager") === null && videoProjectIdFromBrief(youtubeAutoPublishBrief("not-a-uuid")) === null)

  section("D4 · the write-back — the YouTube id + url land on the asset")
  {
    const mem = seed({ status: "completed" }, { marketing_assets: [{ id: "ma-1", brokerage_id: B, asset_url: "https://cdn/12-oak.mp4", metadata: { composition_id: "JustListedReel" } }, { id: "ma-other", brokerage_id: "00000000-0000-4000-8000-0000000000b2", asset_url: "https://cdn/12-oak.mp4", metadata: {} }] })
    const rec = await recordYouTubePublishOnAsset(mem, { id: "post-1", brokerage_id: B, platform: "youtube", external_post_id: "dQw4w9WgXcQ", media_urls: ["https://cdn/12-oak.mp4"], post_brief: youtubeAutoPublishBrief(VID), published_at: "2026-10-19T00:00:00Z" })
    const p = mem.tables.ai_video_projects[0]
    check("the project carries video_metadata.youtube {video_id, url, social_post_id} and moves completed → published", rec.ok && rec.projectId === VID && p.video_metadata?.youtube?.video_id === "dQw4w9WgXcQ" && p.video_metadata?.youtube?.url === "https://www.youtube.com/watch?v=dQw4w9WgXcQ" && p.video_metadata?.youtube?.social_post_id === "post-1" && p.status === "published", JSON.stringify({ rec, yt: p.video_metadata?.youtube, status: p.status }))
    check("every marketing_assets copy of the file IN THIS TENANT is stamped (metadata.youtube), never another tenant's", rec.assetsStamped === 1 && mem.tables.marketing_assets[0].metadata?.youtube?.video_id === "dQw4w9WgXcQ" && mem.tables.marketing_assets[0].metadata?.composition_id === "JustListedReel" && !mem.tables.marketing_assets[1].metadata?.youtube)
  }
  {
    const mem = seed()
    const rec = await recordYouTubePublishOnAsset(mem, { id: "post-2", brokerage_id: B, platform: "youtube", external_post_id: "abc123", media_urls: ["https://cdn/12-oak.mp4"], post_brief: "a human's own post" })
    check("a post WITHOUT the brief (a human queued it) is still matched by the file it carries", rec.ok && rec.projectId === VID)
    check("a non-YouTube post or a missing provider id records nothing", !(await recordYouTubePublishOnAsset(mem, { id: "p", brokerage_id: B, platform: "facebook", external_post_id: "x", media_urls: [], post_brief: null })).ok && !(await recordYouTubePublishOnAsset(mem, { id: "p", brokerage_id: B, platform: "youtube", external_post_id: null, media_urls: [], post_brief: null })).ok)
  }

  section("D5 · wiring — approval, render-landed, the cron's write-back, the publisher, the platform channel")
  const approval = code("lib/kernel/approval-queue-aggregator.ts")
  const vBranch = approval.indexOf('if (kind === "video")'), vEnd = approval.indexOf('if (kind === "video_script")')
  check("applyMarketingAssetApproval('video') queues YouTube AFTER the client delivery, inside the video branch", vBranch > 0 && vEnd > vBranch && approval.slice(vBranch, vEnd).indexOf("deliverApprovedClientVideo(svc as any, id)") < approval.slice(vBranch, vEnd).indexOf("queueYouTubeAutoPublish(svc as any, id)"))
  check("handleVideoGenerated (render landed) queues YouTube for a video approved before its render finished", /queueYouTubeAutoPublish\(svc as any, video_id\)/.test(orch))
  const pubCron = code("app/api/cron/publish-social-posts/route.ts")
  check("publish-social-posts records the YouTube id on the asset in BOTH success branches (single post + fan-out leg)", (pubCron.match(/recordYouTubePublishOnAsset\(supabase, \{/g) ?? []).length === 2 && /String\(post\.platform \?\? ""\)\.toLowerCase\(\) === "youtube"/.test(pubCron) && /String\(acct\.platform \?\? ""\)\.toLowerCase\(\) === "youtube"/.test(pubCron))
  check("NO UNAPPROVED PUBLISH: the rail's cron selects approval_status 'approved' only (the gate the queue rides)", /\.eq\("status", "scheduled"\)\s*\.eq\("approval_status", "approved"\)/.test(pubCron))
  check("the action ledger's own pin still holds (two (post, platform, account) cycles — nothing added, nothing lost)", (pubCron.match(/cycle:\s*`\$\{post\.id\}:/g) ?? []).length === 2)
  const publisher = code("lib/social/publisher.ts")
  // WAVE 143 (lane 143F; the 142K open item) — re-asserted as the RULE: the privacy is EXPLICIT. No default of any kind in
  // the publisher (neither the old literal nor the `?? "public"` default that replaced it); a call without one is refused
  // before any byte leaves; both cron call sites name it from the send-time classification.
  check("publishToYouTube takes the privacy EXACTLY as the caller named it — no literal, no `?? \"public\"` default", /privacyStatus: params\.privacyStatus,/.test(publisher) && !/privacyStatus: "public"/.test(publisher) && !/privacyStatus\s*\?\?\s*["']/.test(publisher) && !/params\.privacyStatus\s*\?\?/.test(publisher))
  check("…and REFUSES an upload that names none (fail closed before the init call)", /params\.privacyStatus !== "public" && params\.privacyStatus !== "unlisted" && params\.privacyStatus !== "private"[\s\S]{0,200}throw new Error\("YouTube upload requires an explicit privacyStatus/.test(publisher) && publisher.indexOf("requires an explicit privacyStatus") < publisher.indexOf('path: "/upload/youtube/v3/videos"'))
  check("CONTROL: the old hard-coded literal AND the old default would both still be found", /privacyStatus: "public",/.test('status: { privacyStatus: "public", selfDeclaredMadeForKids: false }') && /params\.privacyStatus\s*\?\?\s*"public"/.test('privacyStatus: params.privacyStatus ?? "public",'))
  check("the tenant cron NAMES the privacy at BOTH publish sites (single post + the fan-out's YouTube leg) from resolveYouTubePrivacy, and a refused resolution holds the post", (pubCron.match(/resolveYouTubePrivacy\(supabase, post\)/g) ?? []).length === 2 && (pubCron.match(/privacyStatus: (youtubePrivacy|fanYoutubePrivacy),/g) ?? []).length === 2 && /YouTube privacy could not be resolved — post held/.test(pubCron))
  check("the cron runs the connect BACKFILL net before the due posts (sweepYouTubeBackfill, best-effort)", /sweepYouTubeBackfill\(supabase\)/.test(pubCron) && pubCron.indexOf("sweepYouTubeBackfill(supabase)") < pubCron.indexOf('.from("social_posts")'))
  const platformLib = code("lib/platform/platform-social.ts")
  check("the platform channel's YouTube is WIRED (supported, requiresVideo) and still honest about text drafts", /case "youtube":[\s\S]{0,900}supported: true,\s*publisherPlatform: "youtube",\s*requiresVideo: true/.test(platformLib))
  const platformAction = code("app/actions/superadmin/platform-social.ts")
  check("publishProductDraftAction uploads a VIDEO draft's video_url to YouTube (privacy public) and refuses a video draft on a text channel / a text draft on YouTube / a draft with no file", /mediaUrls: \[draftVideoUrl\], privacyStatus: "public"/.test(platformAction) && /isVideoDraft && !support\.requiresVideo/.test(platformAction) && /support\.requiresVideo && !isVideoDraft/.test(platformAction) && /has no video_url yet/.test(platformAction))

  // ═══════════════════════════ D6 · WAVE 143 — send-time privacy + the connect backfill ═══════════════════════════
  section("D6 · resolveYouTubePrivacy — decided at SEND time from the file's classification")
  {
    const mem = seed()
    const pub1 = await resolveYouTubePrivacy(mem, { brokerage_id: B, media_urls: ["https://cdn/12-oak.mp4"], post_brief: youtubeAutoPublishBrief(VID) })
    check("a public-marketing video's post → PUBLIC (classified_public_marketing)", pub1.ok && pub1.privacyStatus === "public" && pub1.basis === "classified_public_marketing", JSON.stringify(pub1))
    const byFile = await resolveYouTubePrivacy(mem, { brokerage_id: B, media_urls: ["https://cdn/12-oak.mp4"], post_brief: "a human's own post" })
    check("…matched by the FILE when the post has no brief (a human drafted it) — same verdict", byFile.ok && byFile.privacyStatus === "public" && byFile.basis === "classified_public_marketing")
    const personal = seed({ video_type: "welcome" })
    const priv = await resolveYouTubePrivacy(personal, { brokerage_id: B, media_urls: ["https://cdn/12-oak.mp4"], post_brief: "a human's own post" })
    check("a human drafting a YouTube post of a PERSONAL video (welcome) → PRIVATE — client media is never broadcast (the 142F finding, closed)", priv.ok && priv.privacyStatus === "private" && priv.basis === "held_private_not_public_marketing" && /personal_or_client_kind/.test(priv.detail), JSON.stringify(priv))
    const addressed = await resolveYouTubePrivacy(seed({ contact_id: "22222222-2222-4222-8222-222222222222" }), { brokerage_id: B, media_urls: ["https://cdn/12-oak.mp4"], post_brief: null })
    check("…an ADDRESSED video → private; an UNAPPROVED cut (changed after it was queued) → private", addressed.ok && addressed.privacyStatus === "private" && (await resolveYouTubePrivacy(seed({ approval_status: "pending_review" }), { brokerage_id: B, media_urls: ["https://cdn/12-oak.mp4"], post_brief: youtubeAutoPublishBrief(VID) }) as { privacyStatus?: string }).privacyStatus === "private")
    const unknownFile = await resolveYouTubePrivacy(mem, { brokerage_id: B, media_urls: ["https://cdn/some-other-upload.mp4"], post_brief: null })
    check("a file that is NOT one of the tenant's video projects → public, basis human_post_unclassified_file (a person approved that post)", unknownFile.ok && unknownFile.privacyStatus === "public" && unknownFile.basis === "human_post_unclassified_file")
    check("another tenant's identical file is never matched (tenant-pinned): the other tenant's post has no project → unclassified, NOT classified as ours", ((await resolveYouTubePrivacy(mem, { brokerage_id: "00000000-0000-4000-8000-0000000000b2", media_urls: ["https://cdn/12-oak.mp4"], post_brief: null })) as { basis?: string }).basis === "human_post_unclassified_file")
    const refusedRead = await resolveYouTubePrivacy(memSupabase({}, { refuse: { ai_video_projects: "RLS" } }), { brokerage_id: B, media_urls: ["https://cdn/12-oak.mp4"], post_brief: null })
    check("a REFUSED read gives NO answer (ok:false) — the cron holds the post; never a guessed 'public'", !refusedRead.ok && /refused/.test((refusedRead as { reason: string }).reason))
    check("a post with no tenant cannot be classified (ok:false)", !(await resolveYouTubePrivacy(mem, { brokerage_id: null, media_urls: [], post_brief: null })).ok)
  }

  section("D7 · the connect backfill — videos approved BEFORE the channel was connected reach YouTube once it is")
  {
    const VID2 = "33333333-3333-4333-8333-333333333333", VID3 = "44444444-4444-4444-8444-444444444444", VID4 = "55555555-5555-4555-8555-555555555555"
    const rows = [project(), project({ id: VID2, title: "Just sold: 9 Elm", video_type: "just_sold", video_url: "https://cdn/9-elm.mp4" }),
      project({ id: VID3, video_type: "welcome", video_url: "https://cdn/welcome.mp4" }), project({ id: VID4, approval_status: "pending_review", video_url: "https://cdn/pending.mp4" })]
    const noChannel = memSupabase({ ai_video_projects: rows, agents: [{ id: A, brokerage_id: B, user_id: U }], social_media_accounts: [], social_posts: [], brokerage_settings: [], marketing_assets: [] }, { uuidIds: true })
    const before = await backfillYouTubeAutoPublish(noChannel, B)
    check("BEFORE the channel is connected the backfill does nothing and says why (no active YouTube account)", before.queued === 0 && /no active YouTube account/.test(before.note ?? "") && noChannel.tables.social_posts.length === 0)
    noChannel.tables.social_media_accounts.push({ id: "acct-yt", brokerage_id: B, agent_id: A, platform: "youtube", is_active: true })
    const after = await backfillYouTubeAutoPublish(noChannel, B)
    check("AFTER the connect: the two approved public-marketing videos are queued (2 posts); the personal (welcome) and the unapproved are NOT considered", after.queued === 2 && after.examined === 2 && noChannel.tables.social_posts.length === 2 && !noChannel.tables.social_posts.some((p) => /welcome|pending/.test(String(p.media_urls?.[0]))), JSON.stringify(after))
    const again = await backfillYouTubeAutoPublish(noChannel, B)
    check("running it again queues NOTHING more (the video_metadata.youtube stamp sets the queued ones aside; the brief key backs it) — idempotent", again.queued === 0 && again.examined === 0 && noChannel.tables.social_posts.length === 2)
    const lim = memSupabase({ ai_video_projects: rows, agents: [{ id: A, brokerage_id: B, user_id: U }], social_media_accounts: [{ id: "acct-yt", brokerage_id: B, agent_id: A, platform: "youtube", is_active: true }], social_posts: [], brokerage_settings: [], marketing_assets: [] }, { uuidIds: true })
    check("bounded: `limit: 1` queues one video per call, newest first", (await backfillYouTubeAutoPublish(lim, B, { limit: 1 })).queued === 1 && lim.tables.social_posts.length === 1)
    const off = memSupabase({ ai_video_projects: rows, agents: [], social_media_accounts: [{ id: "a", brokerage_id: B, platform: "youtube", is_active: true }], social_posts: [], brokerage_settings: [{ brokerage_id: B, settings: { [VIDEO_AUTO_PUBLISH_POLICY_KEY]: { youtube: false } } }], marketing_assets: [] }, { uuidIds: true })
    check("the tenant switch OFF → nothing queued, reason names the key", (await backfillYouTubeAutoPublish(off, B)).queued === 0 && /video_auto_publish/.test((await backfillYouTubeAutoPublish(off, B)).note ?? "") && off.tables.social_posts.length === 0)
    const unreadable = memSupabase({ ai_video_projects: rows, social_media_accounts: [{ id: "a", brokerage_id: B, platform: "youtube", is_active: true }], social_posts: [] }, { refuse: { brokerage_settings: "RLS" } })
    check("an UNREADABLE policy → nothing queued (fail closed)", (await backfillYouTubeAutoPublish(unreadable, B)).queued === 0 && /unreadable/.test((await backfillYouTubeAutoPublish(unreadable, B)).note ?? ""))
    const other = memSupabase({ ai_video_projects: rows, agents: [{ id: A, brokerage_id: B, user_id: U }], social_media_accounts: [{ id: "a", brokerage_id: "00000000-0000-4000-8000-0000000000b2", platform: "youtube", is_active: true }], social_posts: [] }, { uuidIds: true })
    check("another tenant's connected channel does not backfill THIS tenant (tenant-pinned)", (await backfillYouTubeAutoPublish(other, B)).queued === 0 && other.tables.social_posts.length === 0)
    const sweep = memSupabase({ ai_video_projects: rows, agents: [{ id: A, brokerage_id: B, user_id: U }], social_media_accounts: [{ id: "acct-yt", brokerage_id: B, agent_id: A, platform: "youtube", is_active: true }], social_posts: [], brokerage_settings: [], marketing_assets: [] }, { uuidIds: true })
    const sw = await sweepYouTubeBackfill(sweep)
    check("the cron-side net: sweepYouTubeBackfill walks tenants that HAVE an active channel and queues their videos", sw.tenants === 1 && sw.queued === 2 && sweep.tables.social_posts.length === 2, JSON.stringify(sw))
    check("…and a sweep with no connected channel anywhere does nothing", (await sweepYouTubeBackfill(memSupabase({ social_media_accounts: [] }))).tenants === 0)
    check("CONTROL: a backfill that ignored classification would have queued the personal video — the welcome row is in the seed and was refused", rows.some((r) => r.video_type === "welcome") && !noChannel.tables.social_posts.some((p) => String(p.media_urls?.[0]).includes("welcome")))
  }

  section("D8 · the reel page (app/v/[slug]) mounts THE ONE SLOT — no bare <video>, a working fallback, the view counter intact")
  {
    const player = code("app/v/[slug]/video-player.tsx"), pageV = code("app/v/[slug]/page.tsx"), slotSrc = code("app/components/public-site/LandingVideo.tsx")
    check("video-player.tsx renders <LandingVideo> and NO bare <video>", /<LandingVideo\b/.test(player) && !/<video[\s>]/.test(player), `bare <video> count ${(player.match(/<video[\s>]/g) ?? []).length}`)
    check("…with the poster, the title, the YouTube copy as the fallback link, and the SAME one-view-per-mount counter (onPlay → trackVideoView)", /fallbackHref=\{youtubeUrl \?\? null\}/.test(player) && /poster=\{poster\}/.test(player) && /onPlay=\{handlePlay\}/.test(player) && /trackVideoView\(projectId\)/.test(player) && /fired\.current/.test(player))
    check("LandingVideo forwards onPlay to the <video> (the slot is the only player; the counter rides it)", /onPlay\?: \(\) => void/.test(slotSrc) && /onPlay=\{onPlay\}/.test(slotSrc))
    check("the page reads the YouTube write-back (https only) and hands the player title + youtubeUrl", /video_metadata\?\.youtube as \{ url\?: unknown \}/.test(pageV) && /\^https:\\\/\\\//.test(pageV) && /title=\{data\.title\}/.test(pageV) && /youtubeUrl=\{data\.youtubeUrl\}/.test(pageV))
    const publicBare = ["app/lm", "app/site", "app/listings", "app/listing", "app/components/public-site", "app/components/listings", "app/v"].flatMap((d) => { const out: string[] = []; const walkDir = (x: string) => { for (const n of readdirSync(join(ROOT, x))) { const p = `${x}/${n}`; if (statSync(join(ROOT, p)).isDirectory()) walkDir(p); else if (/\.tsx$/.test(n)) out.push(p) } }; try { walkDir(d) } catch { /* directory absent */ } return out }).filter((f) => /<video[\s>]/.test(code(f)) && f !== "app/components/public-site/LandingVideo.tsx")
    check(`NO public landing surface (lm / site / listings / public-site / v) renders a bare <video> outside the slot itself (${publicBare.length} found)`, publicBare.length === 0, publicBare.join(", "))
  }

  // ═══════════════════════════ D9 · WAVE 146 (lane 146F) — RULING 4: NON-LISTING VIDEOS ARE STAGED ═══════════════════════════
  section("D9 · ruling 4 — generated → playable → rights/branding → audience/channel → approver (C5) → approved → published")
  {
    const NL = new Set<string>(NON_LISTING_PUBLIC_VIDEO_TYPES), LI = new Set<string>(LISTING_VIDEO_TYPES)
    check("the non-listing broadcast kinds are DERIVED: public minus listing, disjoint, together exactly the public set", [...NL].every((t) => (PUBLIC_MARKETING_VIDEO_TYPES as readonly string[]).includes(t)) && [...LI].every((t) => (PUBLIC_MARKETING_VIDEO_TYPES as readonly string[]).includes(t)) && [...NL].every((t) => !LI.has(t)) && NL.size + LI.size === PUBLIC_MARKETING_VIDEO_TYPES.length && NL.has("market_update") && NL.has("education") && !NL.has("just_listed"))
    check("the stage ladder is the ruling's order", VIDEO_STAGES.join(">") === "generated>playable>rights_branding_checked>audience_channel_chosen>approver_assigned>approved>published")
    const APPROVER = "00000000-0000-4000-8000-0000000000e9", OTHER = "00000000-0000-4000-8000-0000000000ef"
    const NLV = "66666666-6666-4666-8666-666666666666"
    const nonListing = (patch: Record<string, unknown> = {}) => ({
      id: NLV, brokerage_id: B, agent_id: A, listing_id: null, marketing_campaign_id: null, title: "Rates this week, explained", video_type: "market_update",
      audience_type: "customer_facing", usage_intent: "public_marketing", contact_id: null, approval_status: "draft", approved_by: null, status: "completed",
      compliance_status: "passed", video_url: "https://cdn/rates.mp4", video_provider: "did", script_content: "Here is what moved mortgage rates this week, and what it means if you are planning a move.", video_metadata: {}, ...patch,
    })
    const stagingFor = (channels: string[], approvers: string[]) => ({ staging: { version: 1, staged_at: "2026-10-29T12:00:00Z", playable: { ok: true, basis: "x" }, rights: { ok: true, checks: [] }, branding: { ok: true, violations: [], basis: "x" }, audience: "public_marketing", channels, approver: { user_ids: approvers, basis: "seam", assigned_at: "2026-10-29T12:00:00Z" }, blockers: [] } })
    // ── the pure verdict every automatic door calls
    check("a LISTING video keeps its own rail: approved + public → ok, unstaged by design", (() => { const v = stagedPublicationVerdict({ ...project() }, "youtube"); return v.ok && !v.staged })())
    check("a NON-LISTING video approved through a queue that records no approver, never staged → REFUSED (not staged)", (() => { const v = stagedPublicationVerdict(nonListing({ approval_status: "approved" }), "youtube"); return !v.ok && /not staged/.test(v.reason) })())
    check("staged + approved BY an assigned approver → ok on a chosen channel", stagedPublicationVerdict(nonListing({ approval_status: "approved", approved_by: APPROVER, video_metadata: stagingFor(["landing_page", "youtube"], [APPROVER]) }), "youtube").ok)
    check("…approved with NO recorded approver → refused, and the reason says where to approve", (() => { const v = stagedPublicationVerdict(nonListing({ approval_status: "approved", approved_by: null, video_metadata: stagingFor(["youtube"], [APPROVER]) }), "youtube"); return !v.ok && /without a recorded approver/.test(v.reason) })())
    check("…approved by someone the hierarchy did NOT assign → refused", (() => { const v = stagedPublicationVerdict(nonListing({ approval_status: "approved", approved_by: OTHER, video_metadata: stagingFor(["youtube"], [APPROVER]) }), "youtube"); return !v.ok && /did not assign/.test(v.reason) })())
    check("…a channel the staging did not choose → refused (the tenant switched YouTube off)", (() => { const v = stagedPublicationVerdict(nonListing({ approval_status: "approved", approved_by: APPROVER, video_metadata: stagingFor(["landing_page"], [APPROVER]) }), "youtube"); return !v.ok && /did not choose the youtube channel/.test(v.reason) })())
    check("POSITIVE CONTROL — a PERSONAL / ADDRESSED video is refused on every door even when 'staged' and approved", ["welcome", "home_anniversary"].every((t) => !stagedPublicationVerdict(nonListing({ video_type: t, approval_status: "approved", approved_by: APPROVER, video_metadata: stagingFor(["landing_page"], [APPROVER]) }), "landing_page").ok) && !stagedPublicationVerdict(nonListing({ contact_id: "22222222-2222-4222-8222-222222222222", approval_status: "approved", approved_by: APPROVER, video_metadata: stagingFor(["landing_page"], [APPROVER]) }), "landing_page").ok)
    {
      const board = await listStagedVideos(memSupabase({ ai_video_projects: [nonListing(), nonListing({ id: "77777777-7777-4777-8777-777777777777", status: "generating", video_url: null }), project()] }), { brokerageId: B })
      const stageOfId = (id: string) => board.videos.find((v) => v.id === id)?.stage
      check("the staging board walks the ladder: a draft render is 'playable' (not staged), an unrendered one 'generated'; listing videos are not on it", !board.error && stageOfId(NLV) === "playable" && stageOfId("77777777-7777-4777-8777-777777777777") === "generated" && !board.videos.some((v) => v.id === VID), JSON.stringify(board))
    }

    // ── staging on an in-memory client (the brand survivor and C5 are seams; the bell is real)
    const seedNL = (patch: Record<string, unknown> = {}, extra: Record<string, any[]> = {}) => memSupabase({
      ai_video_projects: [nonListing(patch)], agents: [{ id: A, brokerage_id: B, user_id: U, team_id: "team-1" }],
      social_media_accounts: [{ id: "acct-yt", brokerage_id: B, agent_id: A, platform: "youtube", is_active: true }], social_posts: [], brokerage_settings: [], marketing_assets: [], notifications: [],
      ...extra,
    }, { uuidIds: true })
    const asked: any[] = []
    const approverFor = async (req: any) => { asked.push(req); return { ok: true, userIds: [APPROVER], basis: "seam: approverFor" } }
    const brandOk = async (): Promise<{ passed: boolean; violations: string[] }> => { return { passed: true, violations: [] } }
    {
      const mem = seedNL()
      const st = await stageVideoForPublication(mem, { brokerageId: B, videoId: NLV }, { approverFor, brand: brandOk })
      const row = mem.tables.ai_video_projects[0]
      const s = row.video_metadata?.staging
      check("STAGING a rendered market update: rights + branding recorded, audience public, channels per policy (landing page + YouTube), the approver from C5, the row enters the ONE queue (pending_review)", st.ok && st.staged && s?.audience === "public_marketing" && s?.channels.join() === "landing_page,youtube" && s?.approver?.user_ids?.[0] === APPROVER && s?.rights?.checks?.some((c: any) => c.key === "likeness_consent") && row.approval_status === "pending_review" && (st as any).stage === "approver_assigned", JSON.stringify({ st, s }))
      check("…C5 was asked with the asset kind 'video' and the video's own agent as the owner scope (in this tenant)", asked.length === 1 && asked[0].brokerageId === B && asked[0].assetKind === "video" && asked[0].scope.agentId === A && asked[0].scope.teamId === undefined)
      check("…the ASSIGNED approver is told at once (one bell, video_staged_for_approval, on the video); re-staging rings no second bell", mem.tables.notifications.length === 1 && mem.tables.notifications[0].user_id === APPROVER && mem.tables.notifications[0].type === "video_staged_for_approval" && mem.tables.notifications[0].entity_id === NLV
        && (await stageVideoForPublication(mem, { brokerageId: B, videoId: NLV }, { approverFor, brand: brandOk })).ok && mem.tables.notifications.length === 1)
      const before = await queueYouTubeAutoPublish(mem, NLV)
      check("NOTHING publishes before the assigned approver approves (the YouTube queue refuses a staged, unapproved video)", !before.queued && mem.tables.social_posts.length === 0, JSON.stringify(before))
      const released: string[] = []
      const wrong = await approveStagedVideo(mem, { brokerageId: B, videoId: NLV, approverUserId: OTHER }, { release: async (id) => { released.push(id); return { ok: true } } })
      check("a person the hierarchy did NOT assign cannot approve it (nothing written, no cascade)", !wrong.ok && /not an approver/.test((wrong as { error: string }).error) && mem.tables.ai_video_projects[0].approval_status === "pending_review" && released.length === 0)
      const revoked = await approveStagedVideo(mem, { brokerageId: B, videoId: NLV, approverUserId: APPROVER }, { approverFor: async () => ({ ok: true, userIds: [OTHER], basis: "seam: authority changed" }), release: async (id) => { released.push(id); return { ok: true } } })
      check("authority is re-read AT approval: an approver assigned at staging whose authority was revoked since cannot approve", !revoked.ok && /no longer an approver/.test((revoked as { error: string }).error) && mem.tables.ai_video_projects[0].approval_status === "pending_review" && released.length === 0)
      const ok = await approveStagedVideo(mem, { brokerageId: B, videoId: NLV, approverUserId: APPROVER }, { approverFor, release: async (id) => { released.push(id); return { ok: true } } })
      check("the ASSIGNED approver approves: approved_by + approved_at recorded, the ONE approval cascade runs once", ok.ok && mem.tables.ai_video_projects[0].approval_status === "approved" && mem.tables.ai_video_projects[0].approved_by === APPROVER && !!mem.tables.ai_video_projects[0].approved_at && released.join() === NLV)
      const after = await queueYouTubeAutoPublish(mem, NLV)
      check("…and NOW the YouTube queue takes it (approved public non-personal, staged, the youtube channel chosen)", after.queued && mem.tables.social_posts.length === 1, JSON.stringify(after))
    }
    {
      const mem = seedNL({ approval_status: "approved", approved_by: null })
      await stageVideoForPublication(mem, { brokerageId: B, videoId: NLV }, { approverFor, brand: brandOk })
      const r = await queueYouTubeAutoPublish(mem, NLV)
      check("a video approved in a queue that records no approver stays OFF the rail until the assigned approver approves it on the staging screen", !r.queued && /without a recorded approver/.test(r.reason) && mem.tables.social_posts.length === 0, JSON.stringify(r))
    }
    {
      const mem = seedNL({ video_type: "testimonial" })
      const st = await stageVideoForPublication(mem, { brokerageId: B, videoId: NLV }, { approverFor, brand: brandOk })
      check("RIGHTS: a testimonial without the client's verified consent on record is BLOCKED (and nobody is asked to approve it)", st.ok && st.staged && st.blockers.some((b) => /verified consent/.test(b)) && mem.tables.notifications.length === 0)
      mem.tables.ai_video_projects[0].video_metadata = { ...mem.tables.ai_video_projects[0].video_metadata, testimonial_consent: { verified: true, recorded_at: "2026-10-20" } }
      const st2 = await stageVideoForPublication(mem, { brokerageId: B, videoId: NLV }, { approverFor, brand: brandOk })
      check("…with the consent recorded the rights check passes and the approver is told", st2.ok && st2.staged && st2.blockers.length === 0 && mem.tables.notifications.length === 1)
    }
    {
      const mem = seedNL()
      const st = await stageVideoForPublication(mem, { brokerageId: B, videoId: NLV }, { approverFor, brand: async () => ({ passed: false, violations: ["Public-marketing video missing brokerage verbal disclosure — required by real-estate advertising law"] }) })
      check("BRANDING: the brand survivor's violation (verbal disclosure / overlay) BLOCKS staging — no bell, the reason recorded", st.ok && st.staged && st.blockers.some((b) => /verbal disclosure/.test(b)) && mem.tables.notifications.length === 0 && mem.tables.ai_video_projects[0].video_metadata?.staging?.branding?.ok === false)
    }
    {
      const mem = seedNL()
      const st = await stageVideoForPublication(mem, { brokerageId: B, videoId: NLV }, { approverFor: async () => ({ ok: false, userIds: [], basis: "seam", reason: "no delegated approver for this team" }), brand: brandOk })
      check("no approver from the hierarchy → blocked at 'audience_channel_chosen', never auto-approved", st.ok && st.staged && st.stage === "audience_channel_chosen" && st.blockers.some((b) => /no approver assigned/.test(b)) && mem.tables.ai_video_projects[0].approval_status === "pending_review")
    }
    {
      const listing = memSupabase({ ai_video_projects: [project()] })
      const personal = memSupabase({ ai_video_projects: [nonListing({ video_type: "welcome", contact_id: "22222222-2222-4222-8222-222222222222" })] })
      const l = await stageVideoForPublication(listing, { brokerageId: B, videoId: VID }, { approverFor, brand: brandOk })
      const p = await stageVideoForPublication(personal, { brokerageId: B, videoId: NLV }, { approverFor, brand: brandOk })
      check("a LISTING video and a PERSONAL video are not staged for broadcast — nothing written to either", l.ok && !l.staged && p.ok && !p.staged && !listing.tables.ai_video_projects[0].video_metadata?.staging && !personal.tables.ai_video_projects[0].video_metadata?.staging)
      const foreign = await stageVideoForPublication(seedNL(), { brokerageId: "00000000-0000-4000-8000-0000000000b2", videoId: NLV }, { approverFor, brand: brandOk })
      check("another tenant cannot stage this tenant's video (tenant-pinned read)", !foreign.ok)
    }
    {
      // THE REAL C5 (lib/kernel/approval-authority.ts approverFor — lane 146E) on the in-memory tenant: the video's own agent is
      // ASKED (primary), their team lead and the brokerage roster may approve as oversight; another agent / tenant never.
      const users = [{ id: "u-admin", brokerage_id: B, user_type: "broker_owner" }, { id: "u-agent", brokerage_id: B, user_type: "agent" }, { id: "u-other", brokerage_id: "00000000-0000-4000-8000-0000000000b2", user_type: "broker" }]
      const c5 = memSupabase({
        ai_video_projects: [nonListing()], agents: [{ id: A, brokerage_id: B, user_id: U }], users, user_role_assignments: [],
        team_members: [{ team_id: "team-1", agent_id: A, brokerage_id: B, is_active: true }], teams: [{ id: "team-1", brokerage_id: B, team_lead_id: "u-lead", deleted_at: null }],
        brokerage_settings: [], notifications: [],
      }, { uuidIds: true })
      const d = await stageVideoForPublication(c5, { brokerageId: B, videoId: NLV }, { brand: brandOk })
      const ids = d.ok && d.staged ? [...d.approverUserIds].sort().join() : ""
      check("C5 WIRED: the owner agent (asked — the only bell), their team lead and the brokerage roster may approve; never another agent, never another tenant", ids === ["u-admin", "u-lead", U].sort().join() && c5.tables.notifications.length === 1 && c5.tables.notifications[0].user_id === U, JSON.stringify({ d, bells: c5.tables.notifications }))
      const reqd = memSupabase({
        ai_video_projects: [nonListing()], agents: [{ id: A, brokerage_id: B, user_id: U }], users, user_role_assignments: [], team_members: [], teams: [],
        brokerage_settings: [{ brokerage_id: B, settings: { publication_approval: { require_brokerage_approval: { video: { basis: "brokerage_policy" } } } } }], notifications: [],
      }, { uuidIds: true })
      const r2 = await stageVideoForPublication(reqd, { brokerageId: B, videoId: NLV }, { brand: brandOk })
      check("…the BROKERAGE is the approver only where the tenant's policy says so (ruling 9): with the policy set, only the roster", r2.ok && r2.staged && r2.approverUserIds.join() === "u-admin")
      const refusedRoster = memSupabase({ ai_video_projects: [nonListing()], agents: [{ id: A, brokerage_id: B, user_id: U }], brokerage_settings: [], notifications: [] }, { refuse: { users: "RLS" } })
      const r = await stageVideoForPublication(refusedRoster, { brokerageId: B, videoId: NLV }, { brand: brandOk })
      check("…an unreadable roster assigns NOBODY (fail closed: no approver, no publication)", r.ok && r.staged && r.approverUserIds.length === 0 && r.blockers.some((b) => /no approver assigned/.test(b)), JSON.stringify(r))
    }
    // ── the other automatic door and the hook
    const landing = code("lib/geo/publish-video-landing.ts")
    const fn = landing.slice(landing.indexOf("export async function publishVideoProjectLanding"))
    check("the /v landing door asks stagedPublicationVerdict(p, 'landing_page') BEFORE it flips is_published (a personal video never becomes a public page)", /stagedPublicationVerdict\(p, "landing_page"\)/.test(fn) && fn.indexOf("stagedPublicationVerdict(p,") < fn.indexOf("is_published: true") && /contact_id/.test(fn.slice(0, fn.indexOf("stagedPublicationVerdict(p,"))))
    check("the render-landed reaction (video.generated) STAGES the video and records a refusal on the reaction", /stageVideoForPublication\(svc, \{ brokerageId, videoId: project\.row\.id \}\)/.test(code("lib/video/video-event-reactions.ts")))
    check("the YouTube queue asks stagedPublicationVerdict(p, 'youtube') after the public classification", /stagedPublicationVerdict\(p, "youtube"\)/.test(code("lib/video/youtube-publish.ts")))
    check("the staging screen's doors take the tenant and the approver from the SESSION", /approveStagedVideo\(createServiceClient\(\), \{ brokerageId: ctx\.brokerageId, videoId, approverUserId: ctx\.userId \}\)/.test(code("app/dashboard/marketing/video-staging/actions.ts")))
    blind.push("ruling 4's approver is contract C5 (lib/kernel/approval-authority.ts approverFor — lane 146E's file): most checks drive it as a seam; the C5-WIRED checks run the real module on the in-memory tenant, so this proof needs lane 146E's file in the tree")
    blind.push("the human 'Publish to web' door for RENDERS (lib/geo/publish-video-landing.ts publishVideoLanding) and app/actions/video/distribute-video.ts are HUMAN publish actions, not automatic — not staged here (the person publishing is the decision)")
  }

  // ═══════════════════════════ E · REGISTRATION ═══════════════════════════
  section("E · registration — package.json key, chain MEMBERSHIP, MAINTENANCE_DOMAINS owner")
  const pkg = raw("package.json")
  check("package.json registers test:video-pipeline-truth", /"test:video-pipeline-truth":\s*"tsx scripts\/video-pipeline-truth-guard\.ts"/.test(pkg))
  check("the proof is on the guard chain (membership, never a position)", new RegExp("npm run test:video-pipeline-truth(\\s|&|$)").test(pkg))
  const dom = MAINTENANCE_DOMAINS.video_pipeline_truth
  check("MAINTENANCE_DOMAINS.video_pipeline_truth: asset_manager accountable, campaign_orchestrator + cron_manager co-own, both named in the prose", !!dom && dom.manager === "asset_manager" && dom.proof === "test:video-pipeline-truth" && (dom.coOwners ?? []).includes("campaign_orchestrator") && (dom.coOwners ?? []).includes("cron_manager") && /CROSS-COOPERATED[\s\S]*campaign_orchestrator[\s\S]*cron_manager/.test(dom.what))
  check("the registry prose records that the live tables were EMPTY (never claims a live census)", !!dom && /ALL EMPTY|empty/i.test(dom.what) && /2026-10-19/.test(dom.what))
  check("the lane did not touch the lead-magnet kernel (lane E's survivor)", !/queueYouTubeAutoPublish|LandingVideo|playable-output/.test(masked("lib/kernel/lead-magnets.ts")) && existsSync(join(ROOT, "lib/kernel/lead-magnets.ts")))

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n──────────────────────────────────────────────────")
  console.log(` Denominators: ${samples.length} failure signatures sampled of ${RENDER_FAILURE_SIGNATURES.length}; ${PUBLIC_MARKETING_VIDEO_TYPES.length} public kinds of ${checkTypes.length} CHECK values; ${pages.length} landing surfaces; ${refusals.length} refusal cases`)
  console.log(" Blind spots:")
  for (const b of [
    "the probe proves the container header, not every frame — a header-complete file with a corrupt codec payload passes (the ffmpeg -i duration probe stays best-effort)",
    "the fan-out branch records only the YouTube leg's id (its privacy is now resolved per leg at send time — D6)",
    "social_posts has no row-level privacy column: the privacy is derived at send time from the file's classification (D6), not stored on the post — a human-composed YouTube post of a file that is NOT one of the tenant's video projects uploads 'public' (a person approved that post)",
    "no YouTube call is made: the backfill, the queue and the privacy resolution are proven on an in-memory database; the channel authorization itself is WAITING_EXTERNAL (the tenant's own OAuth connection, Settings → Connections)",
    ...blind,
  ]) console.log(`   · ${b}`)
  if (failures.length) { console.log(" FAILURES:"); for (const f of failures) console.log(`   - ${f}`) }
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ❌ VIDEO_PIPELINE_TRUTH_FAIL"); process.exit(1) }
  console.log(" ✅ VIDEO_PIPELINE_TRUTH_PASS — playable output is the completion rule, every landing page carries the one video slot, approved non-personal videos ride the one YouTube rail")
}

main().catch((e) => { console.error(e); process.exit(1) })
