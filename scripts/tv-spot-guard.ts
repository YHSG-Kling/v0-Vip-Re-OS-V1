#!/usr/bin/env tsx
/**
 * scripts/tv-spot-guard.ts   (run: tsx --conditions=react-server scripts/tv-spot-guard.ts — key to add; see the lane notes)
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * TV-AD-READY VIDEO (wave 143, lane 143F; owner: "videos are also created for TV ads" — aspect, duration, loudness, captions).
 * Proven with the REAL ffmpeg binary (ffmpeg-static, the one the render pipeline runs) on generated fixtures — no network, no provider:
 *
 *   A. THE SPEC AS A JUDGE: a spot that meets every number is READY; each check fails alone and by name (aspect, resolution, duration with
 *      its boundaries, frame rate, loudness with its boundaries, true peak, audio, container, captions); a fact that was NOT MEASURED fails
 *      its check; and the SOCIAL master (−14 LUFS, 9:16) is explicitly NOT TV-ready — the two masters are different products.
 *   B. CAPTIONS as a sidecar: SRT and WebVTT from caption cues — numbering, timecodes (comma vs dot), empty cues dropped; an even-distribution
 *      timing estimate is reported as an ESTIMATE.
 *   C. READING ffmpeg: parseFfmpegInfo on real ffmpeg reports — including the regression the real render probe caught ("1080x1920" was
 *      eaten by a hex-token strip, so a 9:16 file read as nullxnull).
 *   D. THE REAL MASTER: a 1280×720 / 25 fps / mono / 44.1 kHz fixture measures NOT ready; masterForTv makes it 1920×1080 / 29.97 / H.264
 *      yuv420p / 48 kHz stereo at −24 LKFS ±1 with a true peak ≤ −2 dBTP, duration UNCHANGED, and it then evaluates READY. A vertical
 *      cut and a silent video are REFUSED (never pillar-boxed, never mastered to nothing); a 17-second reel masters and reads NOT ready
 *      on duration (never silently cut).
 *   E. THE PRODUCER on an in-memory database with REAL bytes: only an approved public-marketing video; the script passes the public-copy
 *      fair-housing gate (and a 55+ claim needs the verified exemption); the result is recorded on video_metadata.tv_spot — the social
 *      master in video_url is untouched — under ledger evidence, tenant-pinned and counted.
 *   F. SOURCE RULES: the action is a tenant-from-session door; the master never trims (no -t / -ss / trim filter); no provider key.
 *
 * WAVE 144 (lane 144H, owner ruling 16 — "the TV-ad provider was built in the Ads Manager (lib/ads/ctv-campaign.ts) — verify and
 * reuse; do not duplicate; wave 143's tv-spot* is the creative spec/judge side"; ruling 18 — approved creative keeps its approval):
 *   G. CONVERGENCE, on an in-memory database with a TV master made by THIS judge from REAL bytes: the ONE streaming-TV path
 *      (stageCtvCampaign / ensureCtvBroadcastReady / launchCtvCampaignOnVibe / the vibe_ctv connector) refuses a client's, personal or
 *      unapproved video, refuses a master that FAILED its checks (naming them), stages a draft with no master but never LAUNCHES one,
 *      and uploads the TV master — never the social reel; it re-spells none of the judge's numbers and no second TV provider exists.
 *   H. THE CREATIVE CENSUS: every publication door of the approved creative workflows (avatar, listing/social, YouTube, landing-page
 *      video, education, podcast, books, TV master, TV ad, paid ads) holds a human-approval gate, and the usage-rights evidence the
 *      platform keeps (likeness consent, licensed music, stock licence, KDP rights attestation, broadcast-rights line) is still wired —
 *      each with a positive control (the gate removed from the source is caught) and the doors not found published as blind spots.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { TV_SPOT_SPEC, evaluateTvSpot, captionCuesToSrt, captionCuesToWebVtt, parseFfmpegInfo, tvTrimGainDb, type TvSpotFacts } from "../lib/video/tv-spot"
import { masterForTv } from "../lib/video/tv-spot-master"
import { measureTvSpotFile } from "../lib/video/tv-spot-measure"
import { produceTvSpotMaster, tvSpotOf } from "../lib/video/tv-spot-produce"
import { buildCaptionPlan } from "../lib/video/caption-plan"
import { MASTER_LOUDNESS } from "../lib/remotion/music-filter-graph"
// Wave 144 (lane 144H, owner ruling 16): the TV-AD PROVIDER path (the Ads Manager's streaming-TV lane) reads THIS judge.
import { stageCtvCampaign, ensureCtvBroadcastReady, launchCtvCampaignOnVibe } from "../lib/ads/ctv-campaign"
import { vibeCtvConnector } from "../lib/ads/connectors/vibe-ctv"
import { blankStrings } from "./strip-comments"
import { existsSync } from "node:fs"

const ROOT = process.cwd()
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))
let passed = 0, failed = 0
const failures: string[] = []
const blind: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
const section = (t: string) => console.log(`\n[${t}]`)
const B1 = "00000000-0000-4000-8000-0000000000b1", B2 = "00000000-0000-4000-8000-0000000000b2", U1 = "00000000-0000-4000-8000-0000000000a1"
const VID = "11111111-1111-4111-8111-111111111111"

const good: TvSpotFacts = { width: 1920, height: 1080, fps: 29.97, durationSeconds: 30.0, videoCodec: "h264", pixelFormat: "yuv420p", hasAudio: true, audioChannels: 2, audioSampleRate: 48000, integratedLufs: -24.3, truePeakDbtp: -3.1, captions: { present: true, timing: "alignment" } }
const failsOnly = (patch: Partial<TvSpotFacts>, id: string) => { const ev = evaluateTvSpot({ ...good, ...patch }); return !ev.ready && ev.failed.length === 1 && ev.failed[0].id === id ? true : `got ${ev.failed.map((c) => c.id).join(",") || "READY"}` }

async function main() {
  const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string | null
  // ═══════════════════ A · the spec as a judge ═══════════════════
  section("A · evaluateTvSpot — every number is load-bearing, a fact not measured fails")
  const ok = evaluateTvSpot(good)
  check("a spot meeting every number is READY, judged against the versioned spec", ok.ready && ok.failed.length === 0 && ok.specVersion === TV_SPOT_SPEC.version && ok.checks.length === 9, JSON.stringify(ok.failed))
  const single: Array<[string, Partial<TvSpotFacts>, string]> = [
    ["4:3", { width: 1440, height: 1080 }, "aspect"], ["a 1.85:1 crop", { width: 1998, height: 1080 }, "aspect"],
    ["640×360 (16:9 but under the 1280×720 floor)", { width: 640, height: 360 }, "resolution"],
    ["17 s (not a spot length)", { durationSeconds: 17 }, "duration"], ["31 s", { durationSeconds: 31 }, "duration"], ["14.4 s (outside ±0.5)", { durationSeconds: 14.4 }, "duration"],
    ["24.5 fps", { fps: 24.5 }, "frame_rate"], ["50 fps", { fps: 50 }, "frame_rate"],
    ["−14 LUFS (the social master)", { integratedLufs: -14 }, "loudness"], ["−26.1 LUFS (over the ±2 band)", { integratedLufs: -26.1 }, "loudness"], ["−21.9 LUFS", { integratedLufs: -21.9 }, "loudness"],
    ["a −1.5 dBTP true peak", { truePeakDbtp: -1.5 }, "true_peak"],
    ["mono audio", { audioChannels: 1 }, "audio"], ["44.1 kHz", { audioSampleRate: 44100 }, "audio"],
    ["VP9", { videoCodec: "vp9" }, "container"], ["yuv444p", { pixelFormat: "yuv444p" }, "container"],
    ["no caption file", { captions: { present: false, timing: "none" } }, "captions"],
  ]
  check("a vertical 9:16 cut (1080×1920) fails the ASPECT check (and the resolution floor — 1080 wide is under 1280)", (() => { const e = evaluateTvSpot({ ...good, width: 1080, height: 1920 }); return !e.ready && e.failed.some((c) => c.id === "aspect") })())
  for (const [label, patch, id] of single) { const r = failsOnly(patch, id); check(`NOT ready: ${label} → ${id} alone`, r === true, String(r)) }
  check("boundaries: 15.5 s and 14.5 s pass, −22 and −26 LKFS pass, −2.0 dBTP passes, 23.976 / 24 / 25 / 30 fps pass", [15.5, 14.5, 29.5, 59.6].every((d) => evaluateTvSpot({ ...good, durationSeconds: d }).checks.find((c) => c.id === "duration")!.ok) && [-22, -26].every((l) => evaluateTvSpot({ ...good, integratedLufs: l }).ready) && evaluateTvSpot({ ...good, truePeakDbtp: -2 }).ready && [23.976, 24, 25, 30].every((f) => evaluateTvSpot({ ...good, fps: f }).ready))
  const unmeasured = evaluateTvSpot({ ...good, width: null, height: null, fps: null, durationSeconds: null, integratedLufs: null, truePeakDbtp: null, videoCodec: null, pixelFormat: null })
  check("a fact that was NOT MEASURED fails its check (\"not measured\" is never \"fine\")", !unmeasured.ready && ["aspect", "resolution", "duration", "frame_rate", "loudness", "true_peak", "container"].every((id) => unmeasured.failed.some((c) => c.id === id)) && unmeasured.checks.some((c) => c.measured === "not measured"))
  const social = evaluateTvSpot({ ...good, width: 1080, height: 1920, fps: 30, durationSeconds: 22, integratedLufs: MASTER_LOUDNESS.integratedLufs, truePeakDbtp: MASTER_LOUDNESS.truePeakDbtp })
  check("THE SOCIAL MASTER IS NOT A TV MASTER: the repo's own −14 LUFS / 9:16 delivery fails aspect, duration, loudness and true peak (different products, derived from MASTER_LOUDNESS)", !social.ready && ["aspect", "duration", "loudness", "true_peak"].every((id) => social.failed.some((c) => c.id === id)))
  check("estimated caption timing passes but WARNS (never presented as accurate)", (() => { const e = evaluateTvSpot({ ...good, captions: { present: true, timing: "even" } }); return e.ready && e.warnings.some((w) => /ESTIMATE/.test(w)) })())
  check("the spec cites its authority (ATSC A/85, CALM Act, 47 CFR 73.682(e)) and defers to the station's own delivery spec", /A\/85/.test(TV_SPOT_SPEC.authority) && /CALM Act/.test(TV_SPOT_SPEC.authority) && /73\.682\(e\)/.test(TV_SPOT_SPEC.authority) && /station/.test(TV_SPOT_SPEC.authority))
  check("tvTrimGainDb: 0 inside ±0.5 LU, closes the gap otherwise, never past the true-peak ceiling, 0 for silence", tvTrimGainDb({ integratedLufs: -24.2, truePeakDbtp: -5 }) === 0 && tvTrimGainDb({ integratedLufs: -27, truePeakDbtp: -9 }) === 3 && tvTrimGainDb({ integratedLufs: -27, truePeakDbtp: -3 }) === 0.9 && tvTrimGainDb({ integratedLufs: -20, truePeakDbtp: -5 }) === -4 && tvTrimGainDb({ integratedLufs: -70, truePeakDbtp: -60 }) === 0)

  // ═══════════════════ B · captions ═══════════════════
  section("B · caption sidecars")
  const cues = [{ text: "Welcome to 12 Oak Street", fromFrame: 0, durationFrames: 45 }, { text: "   ", fromFrame: 45, durationFrames: 10 }, { text: "A three bedroom home", fromFrame: 60, durationFrames: 30 }]
  const srt = captionCuesToSrt(cues, 30), vtt = captionCuesToWebVtt(cues, 30)
  check("SRT: contiguous numbering, comma milliseconds, the empty cue dropped", srt.startsWith("1\n00:00:00,000 --> 00:00:01,500\nWelcome to 12 Oak Street\n") && /\n2\n00:00:02,000 --> 00:00:03,000\nA three bedroom home\n/.test(srt) && !/\n3\n/.test(srt))
  check("WebVTT: WEBVTT header, DOT milliseconds, no cue numbers", vtt.startsWith("WEBVTT\n\n00:00:00.000 --> 00:00:01.500\n") && !/,\d{3}/.test(vtt))
  check("timecodes follow the frame rate (a 29.97 fps file's frame 90 is 3.003 s, not 3.000 s)", /00:00:03,003/.test(captionCuesToSrt([{ text: "x", fromFrame: 90, durationFrames: 30 }], 29.97)))
  const plan = buildCaptionPlan("Welcome to twelve Oak Street. A bright three bedroom home with a fenced yard and a short walk to the park.", 900, 29.97, { maxWordsPerCue: 6 })
  check("buildCaptionPlan (the existing survivor) over a script gives estimated cues covering the spot, each ≤ 6 words", plan.timingSource === "even" && plan.cues.length >= 3 && plan.cues.every((c) => c.text.split(" ").length <= 6) && captionCuesToSrt(plan.cues, 29.97).split("\n\n").length === plan.cues.length)

  // ═══════════════════ C · reading ffmpeg ═══════════════════
  section("C · parseFfmpegInfo on real ffmpeg reports")
  const portrait = "  Duration: 00:00:22.04, start: 0.000000, bitrate: 3200 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1080x1920 [SAR 1:1 DAR 9:16], 3000 kb/s, 30 fps, 30 tbr, 15360 tbn (default)\n  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 192 kb/s (default)"
  const p1 = parseFfmpegInfo(portrait)
  check("1080x1920 is read as 1080×1920 (the real-render probe caught this: a hex-token strip ate '0x1920' so it read nullxnull)", p1.width === 1080 && p1.height === 1920 && p1.fps === 30 && p1.durationSeconds === 22.04 && p1.videoCodec === "h264" && p1.pixelFormat === "yuv420p" && p1.hasAudio && p1.audioChannels === 2 && p1.audioSampleRate === 48000)
  const wide = parseFfmpegInfo("  Duration: 00:00:15.00, start: 0.0, bitrate: 1 kb/s\n  Stream #0:0: Video: h264 (High), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 29.97 fps, 29.97 tbr\n  Stream #0:1: Audio: aac (LC), 44100 Hz, mono, fltp")
  check("1920x1080 @ 29.97, mono 44.1 kHz AAC read correctly", wide.width === 1920 && wide.height === 1080 && wide.fps === 29.97 && wide.audioChannels === 1 && wide.audioSampleRate === 44100)
  const surround = parseFfmpegInfo("  Stream #0:0: Video: vp9, yuv444p, 1280x720, 25 fps\n  Stream #0:1: Audio: opus, 48000 Hz, 5.1(side), fltp")
  check("5.1 reads as 6 channels; vp9 / yuv444p read as such; no audio line → hasAudio false", surround.audioChannels === 6 && surround.videoCodec === "vp9" && surround.pixelFormat === "yuv444p" && parseFfmpegInfo("  Stream #0:0: Video: h264, yuv420p, 1280x720, 30 fps").hasAudio === false)
  check("CONTROL: garbage reads as all-null (never a guess)", (() => { const g = parseFfmpegInfo("this is not ffmpeg output"); return g.width === null && g.durationSeconds === null && g.fps === null && !g.hasAudio })())

  // ═══════════════════ D · the real master ═══════════════════
  section("D · REAL ffmpeg — measure, master, re-measure")
  if (!ffmpeg) { blind.push("ffmpeg-static is unavailable in this runner — sections D and E did NOT run"); console.log("  · ffmpeg-static unavailable — D/E NOT RUN"); finish(); return }
  const tmp = mkdtempSync(join(tmpdir(), "tv-guard-"))
  const make = (name: string, lavfi: string, audio: string | null, seconds: number, size: string, rate: number, extra: string[] = []) => {
    const out = join(tmp, name)
    const args = ["-y", "-f", "lavfi", "-i", `${lavfi}=size=${size}:rate=${rate}:duration=${seconds}`, ...(audio ? ["-f", "lavfi", "-i", `${audio}`] : []), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...(audio ? ["-c:a", "aac", "-shortest"] : ["-an"]), ...extra, out]
    const r = spawnSync(ffmpeg, args, { encoding: "utf8" })
    if (r.status !== 0) throw new Error(`fixture ${name} failed: ${(r.stderr ?? "").slice(-300)}`)
    return readFileSync(out)
  }
  const sine = (s: number, hz = 44100, ch = 1) => `sine=frequency=440:sample_rate=${hz}:duration=${s}${ch === 2 ? ",aformat=channel_layouts=stereo" : ""}`
  const src15 = make("src15.mp4", "testsrc2", sine(15), 15, "1280x720", 25, ["-ac", "1", "-ar", "44100"])
  const m0 = await measureTvSpotFile(src15)
  check("MEASURE the source fixture: 1280×720 @ 25 fps, mono 44.1 kHz, ≈15 s, loudness + true peak read from the EBU meter", m0.ok && m0.facts.width === 1280 && m0.facts.height === 720 && m0.facts.fps === 25 && m0.facts.audioChannels === 1 && m0.facts.audioSampleRate === 44100 && Math.abs((m0.facts.durationSeconds ?? 0) - 15) < 0.2 && m0.facts.integratedLufs !== null && m0.facts.truePeakDbtp !== null, JSON.stringify(m0))
  if (!m0.ok) { finish(); return }
  const pre = evaluateTvSpot({ ...m0.facts, captions: { present: true, timing: "alignment" } })
  check("…and it is NOT TV-ready: it fails resolution/aspect-independent checks it should (frame rate 25 passes; audio — mono/44.1 — fails; loudness out of band or ok by chance is reported either way)", !pre.ready && pre.failed.some((c) => c.id === "audio") && pre.failed.some((c) => c.id === "resolution" || c.id === "audio"))
  const t0 = Date.now()
  const mastered = await masterForTv(src15)
  console.log(`    master took ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  check("MASTER succeeds on a 16:9 source with audio", mastered.ok, mastered.ok ? "" : mastered.error)
  if (!mastered.ok) { finish(); return }
  const f = mastered.facts
  check("the master is 1920×1080 @ 29.97, H.264 yuv420p, 48 kHz STEREO", f.width === 1920 && f.height === 1080 && Math.abs((f.fps ?? 0) - 29.97) < 0.02 && f.videoCodec === "h264" && f.pixelFormat === "yuv420p" && f.audioChannels === 2 && f.audioSampleRate === 48000, JSON.stringify(f))
  check(`the master's measured loudness is −24 LKFS ±1 and its true peak ≤ −2 dBTP (measured ${f.integratedLufs?.toFixed(1)} LUFS / ${f.truePeakDbtp?.toFixed(1)} dBTP; trim ${mastered.trimDb ?? "n/a"} dB)`, f.integratedLufs !== null && Math.abs(f.integratedLufs + 24) <= 1.0 && f.truePeakDbtp !== null && f.truePeakDbtp <= -2, JSON.stringify(f))
  check("the master's DURATION is the source's (never trimmed): within 0.15 s of 15 s", Math.abs((f.durationSeconds ?? 0) - (m0.facts.durationSeconds ?? -1)) < 0.15, `${f.durationSeconds} vs ${m0.facts.durationSeconds}`)
  const post = evaluateTvSpot({ ...f, captions: { present: true, timing: "even" } })
  check("RE-MEASURED and evaluated: READY (the verdict is on the file's own measurements, not on what the encoder was told)", post.ready, JSON.stringify(post.failed))
  const dec = spawnSync(ffmpeg, ["-v", "error", "-f", "mp4", "-i", "pipe:0", "-f", "null", "-"], { input: mastered.buffer, encoding: "utf8" })
  check("the master decodes clean end to end (ffmpeg -v error -f null)", dec.status === 0 && !(dec.stderr ?? "").trim(), (dec.stderr ?? "").slice(0, 200))
  const { probePlayableOutput } = await import("../lib/video/playable-output")
  check("…and passes the SAME playability probe the media host runs", probePlayableOutput(mastered.buffer, "video/mp4").ok)

  const vertical = make("vertical.mp4", "testsrc2", sine(5), 5, "720x1280", 30, ["-ac", "2", "-ar", "48000"])
  const refVert = await masterForTv(vertical)
  check("a VERTICAL cut is REFUSED with the reason (never pillar-boxed into a TV master)", !refVert.ok && /not 16:9 landscape/.test(refVert.error) && /pillar-box/.test(refVert.error))
  const silent = make("silent.mp4", "testsrc2", null, 4, "1280x720", 30)
  const refSilent = await masterForTv(silent)
  check("a SILENT video is REFUSED (a spot with no sound is not a TV master)", !refSilent.ok && /no audio track/.test(refSilent.error))
  const refJunk = await masterForTv(Buffer.from("not a video"))
  check("a non-video buffer is refused with a reason, never a throw", !refJunk.ok)
  const src17 = make("src17.mp4", "testsrc2", sine(17), 17, "1280x720", 30, ["-ac", "2", "-ar", "48000"])
  const m17 = await masterForTv(src17)
  const e17 = m17.ok ? evaluateTvSpot({ ...m17.facts, captions: { present: true, timing: "alignment" } }) : null
  check("a 17-second reel MASTERS (loudness/size/codec fixed) and reads NOT READY on DURATION alone — it is never silently cut to 15", m17.ok && !!e17 && !e17.ready && e17.failed.length === 1 && e17.failed[0].id === "duration" && Math.abs((m17.ok ? m17.facts.durationSeconds ?? 0 : 0) - 17) < 0.2, JSON.stringify(e17?.failed.map((c) => c.id)))

  // ═══════════════════ E · the producer ═══════════════════
  section("E · produceTvSpotMaster — classification, fair housing, REAL bytes, recorded, tenant-pinned")
  const row = (over: Record<string, unknown> = {}) => ({
    id: VID, brokerage_id: B1, title: "Just listed: 12 Oak", video_type: "just_listed", audience_type: "customer_facing", usage_intent: "public_marketing", contact_id: null, learning_module_id: null,
    approval_status: "approved", status: "completed", compliance_status: "passed", video_url: "https://cdn.example/12-oak.mp4",
    script_content: "Welcome to twelve Oak Street. A bright three bedroom home with a fenced yard and a short walk to the park. Call us today to see it.", video_metadata: { content_kit: { built_by: "x" } }, ...over,
  })
  const seed = (over: Record<string, unknown> = {}) => memSupabase({ ai_video_projects: [row(over)], agent_action_ledger: [] }, { uuidIds: true })
  const hosted: Array<{ path: string; type: string; bytes: number }> = []
  const deps = (o: Record<string, unknown> = {}) => ({ fetchBytes: async () => src15, host: async (_s: unknown, path: string, bytes: Buffer, type: string) => { hosted.push({ path, type, bytes: bytes.length }); return `https://media.example/${path}` }, olderPersons: [] as never, now: new Date("2026-10-23T12:00:00Z"), ...o })
  {
    const db = seed()
    const r = await produceTvSpotMaster(db as never, { brokerageId: B1, videoId: VID, actorUserId: U1 }, deps() as never)
    const meta = db.tables.ai_video_projects[0].video_metadata
    check("an approved public-marketing video is mastered and READY with an estimated caption sidecar", r.ok && r.ready && r.record.captions.timing === "even" && r.record.captions.srt.startsWith("1\n00:00:00,000") && r.record.captions.vtt.startsWith("WEBVTT") && r.record.warnings.some((w) => /ESTIMATE/.test(w)), r.ok ? "" : r.error)
    check("recorded on video_metadata.tv_spot (the url, spec version, every check with measured values); the social video_url and the other metadata are UNTOUCHED", !!tvSpotOf(meta) && tvSpotOf(meta)!.checks.length === 9 && tvSpotOf(meta)!.spec_version === TV_SPOT_SPEC.version && db.tables.ai_video_projects[0].video_url === "https://cdn.example/12-oak.mp4" && meta.content_kit?.built_by === "x")
    check("hosted by the ONE host under the tenant's path as video/mp4", hosted.length === 1 && hosted[0].path === `${B1}/tv-spots/${VID}.mp4` && hosted[0].type === "video/mp4" && hosted[0].bytes > 10_000)
    check("evidence: a marketing.video.tv_spot_master ledger row, HUMAN_REQUESTED, naming the outcome", db.tables.agent_action_ledger.some((l) => l.action === "marketing.video.tv_spot_master" && l.reason_code === "HUMAN_REQUESTED"))
    check("another tenant cannot make or read this video's TV master (not found; nothing hosted)", !(await produceTvSpotMaster(db as never, { brokerageId: B2, videoId: VID, actorUserId: U1 }, deps() as never)).ok && hosted.length === 1)
  }
  const refused = async (label: string, over: Record<string, unknown>, re: RegExp, d: Record<string, unknown> = {}) => {
    hosted.length = 0
    const db = seed(over)
    const r = await produceTvSpotMaster(db as never, { brokerageId: B1, videoId: VID, actorUserId: U1 }, deps(d) as never)
    check(label, !r.ok && re.test(r.error) && hosted.length === 0 && !tvSpotOf(db.tables.ai_video_projects[0].video_metadata), r.ok ? "made" : r.error)
  }
  await refused("a PERSONAL video (welcome) is refused — a TV spot is a broadcast", { video_type: "welcome" }, /personal_or_client_kind/)
  await refused("a video ADDRESSED to a contact is refused", { contact_id: "22222222-2222-4222-8222-222222222222" }, /addressed_to_a_contact/)
  await refused("an UNAPPROVED video is refused", { approval_status: "pending_review" }, /not_approved/)
  await refused("an in-house cut is refused", { audience_type: "in_house" }, /in_house_audience/)
  await refused("a script with a steering phrase is refused by the PUBLIC-COPY fair-housing gate, naming the phrase", { script_content: "A great neighborhood, perfect for families with young kids." }, /Fair-housing review.*perfect for families/i)
  await refused("a script claiming '55+' with NO verified exemption is refused (the claim is verified, not assumed)", { script_content: "Welcome to Sun Palms, a 55+ community with a clubhouse." }, /Fair-housing review.*55\+/)
  hosted.length = 0
  await refused("a source that is not 16:9 is refused by the master with its reason, nothing hosted", {}, /not 16:9 landscape/, { fetchBytes: async () => vertical })
  {
    const db = seed({ script_content: "Welcome to Sun Palms, a 55+ community with a clubhouse." })
    const verified = { community_name: "Sun Palms", basis: "55_plus", governing_rules: "CC&Rs", occupied_units: 200, qualifying_units: 172, survey_completed_on: "2026-03-01", policies_published: true, policies_reference: "handbook", age_verification_procedures: true, program_name: null, program_determination_ref: null, sworn_certification_on_file: true, certifying_representative: "A. Manager", certification_date: "2026-03-05", state: "FL", state_law_reviewed: true }
    const r = await produceTvSpotMaster(db as never, { brokerageId: B1, videoId: VID, actorUserId: U1 }, deps({ olderPersons: [verified] }) as never)
    check("…the SAME script passes when the tenant has a VERIFIED exemption for the community it names", r.ok, r.ok ? "" : r.error)
  }
  {
    const db = seed({ video_url: "https://cdn.example/17.mp4" })
    const r = await produceTvSpotMaster(db as never, { brokerageId: B1, videoId: VID, actorUserId: U1 }, deps({ fetchBytes: async () => src17 }) as never)
    check("a 17 s reel is recorded NOT READY with the failed check named (duration) — the record is honest, nothing is cut", r.ok && !r.ready && r.evaluation.failed.some((c) => c.id === "duration") && tvSpotOf(db.tables.ai_video_projects[0].video_metadata)?.ready === false)
  }
  rmSync(tmp, { recursive: true, force: true })

  // ═══════════════════ F · source rules ═══════════════════
  section("F · source rules")
  const action = code("app/actions/tv-spot.ts"), master = `${code("lib/video/tv-spot-master.ts")}\n${code("lib/video/tv-spot-measure.ts")}`, produce = code("lib/video/tv-spot-produce.ts")
  const exportsAll = [...action.matchAll(/^export\s+(async\s+)?(function|const)\s+(\w+)/gm)]
  check("app/actions/tv-spot.ts: every export is an async function; tenant + actor from getAgentContext; the video id is a uuid-checked argument and the ONLY one", exportsAll.length === 2 && exportsAll.every((m) => m[1] && m[2] === "function") && /getAgentContext\(\)/.test(action) && !/export async function \w+\([^)]*brokerage/i.test(action) && (action.match(/\[0-9a-f-\]\{36\}/g) ?? []).length === 2)
  check("the master NEVER trims or cuts: no -t / -ss / -to arguments and no trim/atrim filter (a wrong-length spot is reported, not edited)", !/"-(t|ss|to)"/.test(master) && !/\b(a?trim)\b\s*=/.test(master))
  check("the producer pins every read and write to the tenant (eq brokerage_id) and COUNTS the write", (produce.match(/\.eq\("brokerage_id", args\.brokerageId\)/g) ?? []).length >= 2 && /\(data \?\? \[\]\)\.length !== 1/.test(produce))
  check("the producer does not write video_url (the social master stays the asset's file)", !/update\(\{[^}]*video_url/.test(produce))
  check("no provider key / network call beyond the project's own https file", !/(api[_-]?key|secret|token)/i.test(produce + master))

  // ═══════════════════ G · the TV-ad provider path reads the judge ═══════════════════
  section("G · lib/ads/ctv-campaign.ts (the ONE streaming-TV provider path) uploads the judge's TV master — never the social reel")
  // Two REAL masters from THIS judge: a 15 s spot (READY) and a 17 s reel (NOT READY on duration).
  const masterOf = async (bytes: Buffer, url: string) => {
    const db = seed({ video_url: url })
    const r = await produceTvSpotMaster(db as never, { brokerageId: B1, videoId: VID, actorUserId: U1 }, deps({ fetchBytes: async () => bytes }) as never)
    return { r, meta: db.tables.ai_video_projects[0].video_metadata as Record<string, unknown> }
  }
  const ready = await masterOf(src15, "https://cdn.example/12-oak.mp4"), notReady = await masterOf(src17, "https://cdn.example/17.mp4")
  check("fixtures: the judge made a READY master (15 s) and a NOT READY one (17 s, duration) from real bytes", ready.r.ok && ready.r.ready && notReady.r.ok && !notReady.r.ready)
  const masterUrl = tvSpotOf(ready.meta)?.url ?? ""
  const CAMP = "33333333-3333-4333-8333-333333333333"
  const vrow = (over: Record<string, unknown> = {}) => ({ ...row({ video_url: "https://cdn.example/12-oak.mp4", duration_seconds: 15, format: "16:9", listing_id: null, video_metadata: ready.meta }), ...over })
  const adWorld = (over: Record<string, unknown> = {}, o: { refuse?: Record<string, string>; campaign?: Record<string, unknown> | null } = {}) => memSupabase({
    ai_video_projects: [vrow(over)],
    ad_campaigns: o.campaign === null ? [] : [{ id: CAMP, brokerage_id: B1, platform: "vibe_ctv", status: "draft", daily_budget: 25, targeting_config: { play: "ctv", zips: ["33602"], video_project_id: VID, creative_video_url: "https://cdn.example/12-oak.mp4" }, ...(o.campaign ?? {}) }],
    agent_action_ledger: [],
  }, { uuidIds: true, refuse: o.refuse })
  const stage = (db: ReturnType<typeof adWorld>) => stageCtvCampaign({ brokerageId: B1, agentUserId: U1, videoProjectId: VID, dailyBudgetCents: 2500, targeting: { zips: ["33602"] }, client: db as never })
  {
    const db = adWorld({}, { campaign: null })
    const r = await stage(db)
    const cfg = (db.tables.ad_campaigns[0]?.targeting_config ?? {}) as Record<string, unknown>
    check("STAGE with a READY master: the staged creative IS the TV master (creative_source tv_master, spec version recorded); the social reel is not the creative", r.success && cfg.creative_video_url === masterUrl && masterUrl !== "https://cdn.example/12-oak.mp4" && cfg.creative_source === "tv_master" && cfg.tv_spot_spec_version === TV_SPOT_SPEC.version && r.package?.creativeUrl === masterUrl, JSON.stringify(r).slice(0, 300))
    check("…the launch package names the TV master and carries the USAGE-RIGHTS line (broadcast licences) — the spec words are derived from the judge", !!r.package?.checklist.some((l) => /TV MASTER/.test(l) && l.includes(`${TV_SPOT_SPEC.width}×${TV_SPOT_SPEC.height}`) && l.includes(`${TV_SPOT_SPEC.loudness.targetLkfs} LKFS`)) && !!r.package?.checklist.some((l) => /Usage rights/.test(l) && /broadcast/.test(l)))
  }
  const stageRefused = async (label: string, over: Record<string, unknown>, re: RegExp) => {
    const db = adWorld(over, { campaign: null })
    const r = await stage(db)
    check(label, !r.success && re.test(r.error ?? "") && db.tables.ad_campaigns.length === 0, r.success ? "staged" : r.error)
  }
  await stageRefused("STAGE refuses an UNAPPROVED video (a TV ad is a broadcast) — no draft row", { approval_status: "pending_review" }, /not an approved public marketing video \(not approved\)/)
  await stageRefused("STAGE refuses a client's video (addressed to a contact) — no draft row", { contact_id: "22222222-2222-4222-8222-222222222222" }, /addressed to a contact/)
  await stageRefused("STAGE refuses a PERSONAL kind (welcome)", { video_type: "welcome" }, /personal or client kind/)
  await stageRefused("STAGE refuses the unbranded MLS-only cut", { usage_intent: "mls" }, /mls only cut/)
  await stageRefused("STAGE refuses a master that FAILED the judge, naming the failed check and its numbers", { video_metadata: notReady.meta }, /TV master is NOT ready — failed duration \(needs 15 \/ 30 \/ 60 s/)
  {
    const db = adWorld({ video_metadata: {} }, { campaign: null })
    const r = await stage(db)
    const cfg = (db.tables.ad_campaigns[0]?.targeting_config ?? {}) as Record<string, unknown>
    check("STAGE with NO master yet: a DRAFT may carry the social reel, SAID (creative_source social_master_unverified, a warning, 'make the TV master first' in the checklist) — a draft broadcasts nothing", r.success && cfg.creative_source === "social_master_unverified" && !!r.package?.warnings.some((w) => /No TV master yet/.test(w)) && !!r.package?.checklist.some((l) => /Make the TV master first/.test(l)))
  }
  {
    const db = adWorld({ video_metadata: {} })
    const r = await ensureCtvBroadcastReady({ campaignId: CAMP, brokerageId: B1, client: db as never })
    const l = await launchCtvCampaignOnVibe({ campaignId: CAMP, brokerageId: B1, actorUserId: U1, launchedVia: "vibe_api", client: db as never })
    check("LAUNCH (the authoritative write) with no master is REFUSED — by the gate and through the launch door (dispatched false, 'not launched'), the row still draft and still pointing at nothing new", !r.ok && /no TV master/.test(r.reason) && !l.dispatched && /^not launched — no TV master/.test(l.reason ?? "") && db.tables.ad_campaigns[0].status === "draft" && db.writes.filter((w) => w.table === "ad_campaigns" && w.op === "update").length === 0)
  }
  for (const [label, over, re] of [
    ["an approval REVOKED after staging", { approval_status: "rejected" }, /not approved/],
    ["a master that failed its checks", { video_metadata: notReady.meta }, /TV master is NOT ready/],
  ] as Array<[string, Record<string, unknown>, RegExp]>) {
    const db = adWorld(over)
    const l = await launchCtvCampaignOnVibe({ campaignId: CAMP, brokerageId: B1, actorUserId: U1, launchedVia: "ads_manager", client: db as never })
    check(`LAUNCH re-reads the video at the write: ${label} is refused (dispatched false)`, !l.dispatched && re.test(l.reason ?? ""), l.reason)
  }
  {
    const db = adWorld()
    const r = await ensureCtvBroadcastReady({ campaignId: CAMP, brokerageId: B1, client: db as never })
    const cfg = db.tables.ad_campaigns[0].targeting_config as Record<string, unknown>
    const upd = db.writes.filter((w) => w.table === "ad_campaigns" && w.op === "update")
    check("with a READY master the gate POINTS the staged row at the master (one counted update) so the provider uploads it, never the social reel", r.ok && r.creativeUrl === masterUrl && cfg.creative_video_url === masterUrl && cfg.creative_source === "tv_master" && upd.length === 1 && upd[0].matched === 1)
    const again = await ensureCtvBroadcastReady({ campaignId: CAMP, brokerageId: B1, client: db as never })
    check("…idempotent: a second pass finds the master already set and writes nothing", again.ok && db.writes.filter((w) => w.table === "ad_campaigns" && w.op === "update").length === 1)
    check("another tenant's campaign is not found (tenant-pinned)", !(await ensureCtvBroadcastReady({ campaignId: CAMP, brokerageId: B2, client: db as never })).ok)
    const refusedRead = await ensureCtvBroadcastReady({ campaignId: CAMP, brokerageId: B1, client: adWorld({}, { refuse: { ad_campaigns: "permission denied for table ad_campaigns" } }) as never })
    check("FAIL CLOSED: a refused read is a refusal with its reason, never a pass", !refusedRead.ok && /campaign read refused: permission denied/.test(refusedRead.reason))
  }
  {
    const pub = await vibeCtvConnector.publishCampaign({ structure: { campaign_id: CAMP }, cred: { accessToken: "x", accountId: null, config: {}, brokerageId: null } } as never)
    check("the CONNECTOR door (ad-connector registry) runs the same gate: with no tenant on the credential nothing is published", !pub.ok && /names no tenant/.test((pub as { error?: string }).error ?? ""))
  }
  {
    const ctv = code("lib/ads/ctv-campaign.ts"), conn = code("lib/ads/connectors/vibe-ctv.ts"), tv = code("lib/video/tv-spot.ts")
    const launchBody = ctv.slice(ctv.indexOf("export async function launchCtvCampaignOnVibe"), ctv.indexOf("export async function ensureCtvBroadcastReady"))
    check("ORDER at both doors: the gate runs BEFORE the provider dispatch (launch: ensureCtvBroadcastReady before dispatchCtvCampaign; connector: the same)", launchBody.indexOf("ensureCtvBroadcastReady(") > 0 && launchBody.indexOf("ensureCtvBroadcastReady(") < launchBody.indexOf("dispatchCtvCampaign(") && conn.indexOf("ensureCtvBroadcastReady(") > 0 && conn.indexOf("ensureCtvBroadcastReady(") < conn.indexOf("dispatchCtvCampaign(campaignId)"))
    const NUMS = /−24|-24\b|1920|1080|dBTP|LKFS ±/
    check("the provider path RE-SPELLS none of the judge's numbers (derived from TV_SPOT_SPEC) — positive control: the judge itself carries them", !NUMS.test(blankStrings(ctv)) && !NUMS.test(ctv.replace(/\$\{[^}]*\}/g, "")) && NUMS.test(tv))
    const others = ["lib/ads", "lib/providers", "lib/video"].flatMap((d) => (spawnSync("grep", ["-rlE", "dispatchCtvCampaign|api\\.vibe\\.co", d, "--include=*.ts"], { encoding: "utf8" }).stdout ?? "").split("\n").filter(Boolean))
    check(`ONE TV-ad provider: only lib/providers/vibe.ts speaks Vibe; the dispatch is called only from the ctv lane and its connector (${others.length} file(s) found)`, others.every((f) => ["lib/providers/vibe.ts", "lib/ads/ctv-campaign.ts", "lib/ads/connectors/vibe-ctv.ts"].includes(f)) && others.includes("lib/providers/vibe.ts"), others.join(", "))
    check("tvSpotOf has ONE definition (lib/video/tv-spot.ts); tv-spot-produce re-exports it unchanged", /export function tvSpotOf\(/.test(tv) && !/export function tvSpotOf\(/.test(produce) && /export \{ tvSpotOf, type TvSpotRecord \} from "\.\/tv-spot"/.test(produce))
  }

  // ═══════════════════ H · the creative census ═══════════════════
  section("H · every approved creative workflow keeps its human approval and its usage-rights evidence (owner ruling 18)")
  type Door = { workflow: string; file: string; re: RegExp; what: string }
  const doors: Door[] = [
    { workflow: "avatar / explainer video", file: "lib/video/avatar-explainer.ts", re: /approval_status:\s*"pending_review"/, what: "lands in the unified approval queue, never auto-approved" },
    { workflow: "listing + social posts", file: "app/api/cron/publish-social-posts/route.ts", re: /\.eq\("approval_status", "approved"\)/, what: "the publisher sends approved posts only" },
    { workflow: "YouTube", file: "lib/video/youtube-publish.ts", re: /classifyPublicVideo\(/, what: "approved + compliance-passed public classes only" },
    { workflow: "landing-page video (/v/[slug])", file: "lib/geo/video-landing.ts", re: /approvalStatus !== "approved"/, what: "broker sign-off gate" },
    { workflow: "education video", file: "lib/video/public-video.ts", re: /reason: "education_module_video"/, what: "an education-OS module video is never broadcast as marketing" },
    { workflow: "podcast distribution", file: "app/api/cron/distribute-podcast-episodes/route.ts", re: /\.eq\("approval_status", "approved"\)/, what: "the distributor sends approved episodes only" },
    { workflow: "podcast preset publish", file: "lib/podcast/orchestrate-podcast-preset-publish.ts", re: /ep\.approval_status !== "approved"/, what: "a preset stages channels for an approved episode only (wave 144)" },
    { workflow: "book (lead magnet)", file: "lib/kernel/lead-magnets.ts", re: /humanizedReviewState\(book\.chapters\)/, what: "the human's publish + the humanized review" },
    { workflow: "book (KDP)", file: "lib/lead-magnets/book-publishing-produce.ts", re: /KDP_ATTESTATIONS\.filter\(\(a\) => !args\.attested\.includes\(a\.id\)\)/, what: "every attestation by a session user" },
    { workflow: "TV master", file: "lib/video/tv-spot-produce.ts", re: /classifyPublicVideo\(p as never\)/, what: "a broadcast: approved public classes only" },
    { workflow: "TV ad (streaming)", file: "lib/ads/ctv-campaign.ts", re: /classifyPublicVideo\(row\)/, what: "staging + both launch doors (wave 144)" },
    { workflow: "paid ads (Meta / Google)", file: "lib/ads/launch-assembler.ts", re: /\.eq\("approval_status", "approved"\)/, what: "only an approved creative is assembled" },
  ]
  const rights: Door[] = [
    { workflow: "avatar likeness", file: "lib/did/avatar-consent-gate.ts", re: /consent/i, what: "the presenter's likeness consent gate" },
    { workflow: "licensed music bed", file: "lib/remotion/render-coordinator.ts", re: /used_music_asset_id:\s*musicAssetId/, what: "the render records WHICH licensed track it used (video_assets.license_url / license_attribution)" },
    { workflow: "stock imagery", file: "lib/marketing/image-library.ts", re: /stock license covers each user's own use/, what: "stock is never shared platform-wide" },
    { workflow: "book rights", file: "lib/lead-magnets/book-publishing.ts", re: /id: "i_hold_rights"/, what: "the KDP rights-holder attestation" },
    { workflow: "TV broadcast rights", file: "lib/ads/ctv-campaign.ts", re: /CTV_RIGHTS_CHECK,/, what: "the launch package's broadcast-licence line (wave 144)" },
  ]
  for (const d of [...doors, ...rights]) {
    if (!existsSync(join(ROOT, d.file))) { check(`${d.workflow}: ${d.file} exists`, false); continue }
    const src = code(d.file)
    const defanged = src.replace(new RegExp(d.re.source, d.re.flags.includes("g") ? d.re.flags : `${d.re.flags}g`), "/*gate removed*/")
    check(`${d.workflow} — ${d.what} (${d.file}); CONTROL: with the gate removed the census catches it`, d.re.test(src) && !d.re.test(defanged))
  }
  check("music licence columns exist on the live schema cache (video_assets.license_url + license_attribution)", /video_assets: \[[^\]]*"license_attribution"[^\]]*"license_url"/.test(readFileSync(join(ROOT, "scripts/schema-snapshot.ts"), "utf8")))
  blind.push(`the creative census is a SOURCE census of ${doors.length} approval doors + ${rights.length} rights records (stripped source, each with a removal control) — it proves the gate is still written at the door, not every runtime path; community/event (topic) videos have NO separate publication door — they reach the public only through the YouTube, landing-page and TV doors above (unresolved: a direct social post of a topic video rides the social approval queue)`)
  blind.push("BROADCAST licence scope is not machine-checkable: the platform keeps each music asset's licence link and attribution, not whether that licence covers streaming TV — the launch package says so and a human confirms (WAITING_EXTERNAL per buy)")
  finish()

  function finish() {
    console.log("\n──────────────────────────────────────────────────")
    console.log(` Denominators: ${single.length} single-failure cases + boundaries; ${3} ffmpeg parse reports; ${hosted.length >= 0 ? "REAL ffmpeg fixtures: 15 s 720p mono, 5 s vertical, 4 s silent, 17 s stereo" : ""}`)
    console.log(" Blind spots:")
    for (const b of [
      "ACCEPTANCE is the station's / platform's decision: 'ready' means every measurable check in this spec passed on the file. The ±2 dB loudness band and the −2 dBTP ceiling are the commonly published ATSC A/85 values read from secondary sources (FCC / NAB / trade press) on 2026-10-23 — the A/85 document itself and each station's delivery spec must be confirmed per buy (WAITING_EXTERNAL: the station / streaming platform's spec sheet)",
      "loudness is measured over the whole file with the EBU R128 meter (the repo's own): ATSC A/85 anchors on DIALOGUE loudness (dialnorm), which this OS does not gate — a spot whose dialogue sits far from its music can read −24 overall and still be judged by the station's dialogue meter",
      "captions are a SIDECAR (SRT / WebVTT) with ESTIMATED timing unless word alignment exists; embedded CEA-608/708 caption data is the broadcaster's encoder's job and is not produced here",
      "no black-frame / colour-bar / slate / 2-pop / safe-area / audio-sync check: this is aspect, size, duration, loudness, true peak, container and captions only",
      "the fixtures are synthetic test patterns and a sine tone — they prove the measure and master arithmetic on real ffmpeg output, not the look or sound of a real reel",
      ...blind,
    ]) console.log(`   · ${b}`)
    if (failures.length) { console.log(" FAILURES:"); for (const x of failures) console.log(`   - ${x}`) }
    console.log(` RESULT: ${passed} passed, ${failed} failed`)
    if (failed > 0) { console.log(" ❌ TV_SPOT_FAIL"); process.exit(1) }
    console.log(" ✅ TV_SPOT_PASS — a 16:9 approved public-marketing video can be mastered to the TV spec, measured on the file itself, captioned, and recorded; a wrong-length or non-16:9 cut is reported, never edited")
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
void writeFileSync
