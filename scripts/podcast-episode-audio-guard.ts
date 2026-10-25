#!/usr/bin/env tsx
/**
 * scripts/podcast-episode-audio-guard.ts   (run: tsx --conditions=react-server scripts/podcast-episode-audio-guard.ts — key to add; see the lane notes)
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * PODCAST AUDIO PRODUCTION (wave 143, lane 143F). The audit's one hole: the manual studio path published the FIRST script segment's
 * audio as the whole episode (and recorded the sum of the segments' ESTIMATED durations). Proven with the REAL ffmpeg binary on
 * generated MP3 segments — no provider, no network:
 *
 *   A. THE MP3 PROBE refuses what a failed TTS call hands back (a JSON error body, an empty / tiny / non-audio buffer) and accepts a real
 *      MP3 with and without an ID3v2 tag, reading its rate / channels / bitrate from the first frame.
 *   B. THE SPEC AS A JUDGE (−16 LUFS ±1, ≤ −1 dBTP, 44.1/48 kHz, bitrate bands, mp3/aac) — each check fails alone and by name; a fact not
 *      measured fails.
 *   C. THE REAL ASSEMBLY: three segments (4 s, 6 s, 3 s at three different levels) become ONE mono 44.1 kHz 128 kbps MP3 of ≈ 13 s —
 *      NOT the first segment's 4 s (the old defect, held as a positive control) — levelled to −16 LUFS ±1 with a true peak ≤ −1 dBTP,
 *      decoding clean, and evaluating READY; a JSON segment is refused BY INDEX before ffmpeg runs; zero segments is refused.
 *   D. THE DOORS: the manual action joins the segments and records the file's own duration (no `audioSegments[0].url` as the episode, no
 *      buffer written to the row, an assembly failure FAILS the generation); the weekly auto-producer probes the TTS bytes BEFORE hosting,
 *      levels them, records the measured duration, and says so on the run when the level was skipped.
 *   E. THE PRESET DOOR (wave 144, lane 144H — approved creative keeps its human approval): a preset stages distribution only for an
 *      APPROVED, finished episode of its own tenant; refused reads are reported as refusals.
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { stripComments } from "./strip-comments"
import { PODCAST_AUDIO_SPEC, probeMp3, evaluatePodcastAudio, parseAudioInfo, podcastTrimGainDb, type PodcastAudioFacts } from "../lib/podcast/episode-audio-spec"
import { assemblePodcastEpisode } from "../lib/podcast/episode-audio"
import { measurePodcastAudio } from "../lib/podcast/episode-audio-measure"
// Wave 144 (lane 144H): the preset publish door, driven on an in-memory database.
import { orchestratePodcastPresetPublish } from "../lib/podcast/orchestrate-podcast-preset-publish"
import { memSupabase } from "./in-memory-supabase"

const ROOT = process.cwd()
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
const section = (t: string) => console.log(`\n[${t}]`)

const good: PodcastAudioFacts = { durationSeconds: 300, integratedLufs: -16.2, truePeakDbtp: -1.6, sampleRate: 44100, channels: 1, bitrateKbps: 128, codec: "mp3" }

async function main() {
  const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string | null
  if (!ffmpeg) { console.log("  · ffmpeg-static unavailable — NOT RUN"); console.log(" RESULT: 0 passed, 0 failed (NOT RUN)"); return }
  const tmp = mkdtempSync(join(tmpdir(), "podcast-guard-"))
  const mp3 = (name: string, seconds: number, volume: number, extra: string[] = []) => {
    const out = join(tmp, name)
    const r = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", `sine=frequency=${200 + seconds * 20}:sample_rate=44100:duration=${seconds}`, "-af", `volume=${volume}`, "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", ...extra, out], { encoding: "utf8" })
    if (r.status !== 0) throw new Error(`fixture ${name}: ${(r.stderr ?? "").slice(-200)}`)
    return readFileSync(out)
  }
  const s1 = mp3("s1.mp3", 4, 0.9), s2 = mp3("s2.mp3", 6, 0.1), s3 = mp3("s3.mp3", 3, 0.4, ["-metadata", "title=Outro"])

  section("A · probeMp3")
  const p1 = probeMp3(s1)
  check("a real MP3: ok, mono 44.1 kHz 64 kbps read from the first frame, ≈ 4 s CBR estimate", p1.ok && p1.channels === 1 && p1.sampleRate === 44100 && p1.bitrateKbps === 64 && Math.abs((p1.estimatedSeconds ?? 0) - 4) < 0.6, JSON.stringify(p1))
  const withId3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0x04, 0x00]), Buffer.alloc(0x200, 0), s3])
  check("an MP3 behind an ID3v2 tag (the tag is skipped by its own size) is ok and says it had one", probeMp3(withId3).ok && probeMp3(withId3).hadId3)
  const errBody = Buffer.from(JSON.stringify({ detail: { status: "quota_exceeded", message: "You have exceeded your character quota." } }))
  check("a TTS 200 with a JSON ERROR body is refused BY NAME (looks like an error body)", !probeMp3(errBody).ok && /error body/.test(probeMp3(errBody).reasons.join()) && /quota_exceeded/.test(probeMp3(errBody).reasons.join()))
  check("empty, undefined, 100 plain-text bytes, and 4 KB of zeros are each refused (CONTROLS: the probe is not a blanket pass)", !probeMp3(Buffer.alloc(0)).ok && !probeMp3(undefined).ok && !probeMp3(Buffer.from("x".repeat(100))).ok && !probeMp3(Buffer.alloc(4096)).ok && /no MPEG audio frame/.test(probeMp3(Buffer.alloc(4096)).reasons.join()))
  check("an HTML error page is refused as an error body", /error body/.test(probeMp3(Buffer.from("<html><body>502 Bad Gateway</body></html>")).reasons.join()))
  check("a frame header that is not Layer III / reserved bitrate is skipped (a PNG is not an MP3)", !probeMp3(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(4000, 0xff)])).ok)

  section("B · evaluatePodcastAudio — the spec as a judge")
  check("a −16.2 LUFS / −1.6 dBTP / 44.1 kHz / mono 128 kbps mp3 episode is READY", evaluatePodcastAudio(good).ready)
  const single: Array<[string, Partial<PodcastAudioFacts>, string]> = [
    ["−14 LUFS (the social-video level)", { integratedLufs: -14 }, "loudness"], ["−18 LUFS", { integratedLufs: -18 }, "loudness"], ["true peak −0.5 dBTP", { truePeakDbtp: -0.5 }, "true_peak"],
    ["22.05 kHz", { sampleRate: 22050 }, "sample_rate"], ["mono at 64 kbps (under the recommended 96)", { bitrateKbps: 64 }, "bitrate"], ["stereo at 96 kbps", { channels: 2, bitrateKbps: 96 }, "bitrate"], ["wav", { codec: "pcm_s16le" }, "codec"], ["0.5 s long", { durationSeconds: 0.5 }, "duration"],
  ]
  for (const [label, patch, id] of single) { const e = evaluatePodcastAudio({ ...good, ...patch }); check(`NOT ready: ${label} → ${id} alone`, !e.ready && e.failed.length === 1 && e.failed[0].id === id, e.failed.map((c) => c.id).join()) }
  check("boundaries: −15 and −17 LUFS pass, −1.0 dBTP passes, 48 kHz passes, aac passes", [-15, -17].every((l) => evaluatePodcastAudio({ ...good, integratedLufs: l }).ready) && evaluatePodcastAudio({ ...good, truePeakDbtp: -1 }).ready && evaluatePodcastAudio({ ...good, sampleRate: 48000 }).ready && evaluatePodcastAudio({ ...good, codec: "aac" }).ready)
  check("a fact not measured fails its check", !evaluatePodcastAudio({ ...good, integratedLufs: null, truePeakDbtp: null, durationSeconds: null }).ready && evaluatePodcastAudio({ ...good, integratedLufs: null }).checks.find((c) => c.id === "loudness")!.measured === "not measured")
  check("podcastTrimGainDb: 0 inside ±0.3 LU, closes the gap, never past the −1 dBTP ceiling, 0 for silence", podcastTrimGainDb({ integratedLufs: -16.2, truePeakDbtp: -3 }) === 0 && podcastTrimGainDb({ integratedLufs: -19, truePeakDbtp: -9 }) === 3 && podcastTrimGainDb({ integratedLufs: -19, truePeakDbtp: -2.5 }) === 1.4 && podcastTrimGainDb({ integratedLufs: -80, truePeakDbtp: -70 }) === 0)
  check("the spec cites its authority and defers to the directory's own spec", /Apple/.test(PODCAST_AUDIO_SPEC.authority) && /directory's own spec governs/.test(PODCAST_AUDIO_SPEC.authority))
  const info = parseAudioInfo("  Duration: 00:00:13.07, start: 0.025057, bitrate: 128 kb/s\n  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, mono, fltp, 128 kb/s")
  check("parseAudioInfo reads a real ffmpeg audio report (duration, codec, rate, mono, bitrate)", info.durationSeconds === 13.07 && info.codec === "mp3" && info.sampleRate === 44100 && info.channels === 1 && info.bitrateKbps === 128)

  section("C · REAL ffmpeg — three segments become ONE levelled episode")
  const t0 = Date.now()
  const out = await assemblePodcastEpisode([s1, s2, s3], { title: "Weekly — 2026-W43" })
  console.log(`    assemble took ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  check("assemblePodcastEpisode succeeds on three real MP3 segments", out.ok, out.ok ? "" : out.error)
  if (!out.ok) { rmSync(tmp, { recursive: true, force: true }); finish(); return }
  const f = out.facts
  const first = await measurePodcastAudio(s1)
  const firstSeconds = first.ok ? first.facts.durationSeconds ?? 0 : 0
  check(`the episode is ONE file of ≈ 13 s (the three segments), measured at ${f.durationSeconds?.toFixed(2)} s — NOT the first segment's ${firstSeconds.toFixed(2)} s`, out.segments === 3 && Math.abs((f.durationSeconds ?? 0) - 13) < 0.6 && (f.durationSeconds ?? 0) > firstSeconds + 6, JSON.stringify(f))
  check("CONTROL (the old defect): publishing audioSegments[0] alone would have been ≈ 4 s while the row claimed the 13 s sum — the guard sees the difference", firstSeconds > 3 && firstSeconds < 5 && (f.durationSeconds ?? 0) / firstSeconds > 2.5)
  check(`mono, 44.1 kHz, 128 kbps MP3 (read back from the file: ${f.codec} ${f.sampleRate} Hz ${f.channels}ch ${f.bitrateKbps} kbps)`, f.codec === "mp3" && f.sampleRate === 44100 && f.channels === 1 && f.bitrateKbps === 128)
  check(`levelled to −16 LUFS ±1 (measured ${f.integratedLufs?.toFixed(1)}) with a true peak ≤ −1 dBTP (measured ${f.truePeakDbtp?.toFixed(1)}); trim ${out.trimDb ?? "n/a"} dB — three segments recorded at three different levels are now one level`, f.integratedLufs !== null && Math.abs(f.integratedLufs + 16) <= 1 && f.truePeakDbtp !== null && f.truePeakDbtp <= -1)
  check("the assembled file evaluates READY on ITS OWN measurements", evaluatePodcastAudio(f).ready, JSON.stringify(evaluatePodcastAudio(f).failed))
  check("…probes as an MP3 and decodes clean end to end (ffmpeg -v error -f null)", probeMp3(out.buffer).ok && (() => { const r = spawnSync(ffmpeg, ["-v", "error", "-i", "pipe:0", "-f", "null", "-"], { input: out.buffer, encoding: "utf8" }); return r.status === 0 && !(r.stderr ?? "").trim() })())
  check("the title rides in the ID3 tag", out.buffer.subarray(0, 3).toString("latin1") === "ID3" && out.buffer.includes(Buffer.from("Weekly")))
  const quiet = await assemblePodcastEpisode([mp3("quiet.mp3", 5, 0.02)])
  check("a single very QUIET segment (the weekly auto-producer's one-TTS-call case) is levelled UP to the target — the same function, one input", quiet.ok && quiet.facts.integratedLufs !== null && Math.abs(quiet.facts.integratedLufs + 16) <= 1, quiet.ok ? String(quiet.facts.integratedLufs) : quiet.error)
  const bad = await assemblePodcastEpisode([s1, errBody, s3])
  check("a JSON error body as segment 2 is refused BY INDEX before ffmpeg is asked to decode it", !bad.ok && /segment 2 of 3 is not playable audio/.test(bad.error) && /quota_exceeded/.test(bad.error))
  check("zero segments is refused", !(await assemblePodcastEpisode([])).ok)
  rmSync(tmp, { recursive: true, force: true })

  section("D · the doors")
  const action = code("app/actions/podcast-generation.ts"), producer = code("lib/podcast/auto-producer.ts")
  check("manual studio: the episode is the ASSEMBLED file — `audioSegments[0].url` is no longer the episode's audio", !/finalAudioUrl\s*=\s*audioSegments\[0\]/.test(action) && /assemblePodcastEpisode\(audioSegments\.map\(\(s\) => s\.buffer\)/.test(action) && /const finalAudioUrl = await hostRenderedMedia\(/.test(action))
  check("…the duration is the file's OWN measurement (the sum of estimates is only the fallback)", /const totalDuration = \(assembled\.ok \? assembled\.facts\.durationSeconds : null\) \?\? audioSegments\.reduce/.test(action))
  check("…an assembly that fails FAILS the generation (thrown into the existing failure path: status failed + the reason + the kernel failure event) — except a ONE-segment script whose lone segment probes as an MP3, which needs no assembly (logged as un-levelled)", /if \(!assembled\.ok && !\(loneProbe && loneProbe\.ok\)\) throw new Error\(`Podcast audio could not be assembled/.test(action) && /const loneProbe = audioSegments\.length === 1 \? probeMp3\(audioSegments\[0\]\.buffer\) : null/.test(action) && /WITHOUT loudness levelling/.test(action))
  check("…and the audio buffers never reach the episode row (segments are mapped to {url, duration})", /segments: audioSegments\.map\(\(\{ url, duration \}\) => \(\{ url, duration \}\)\)/.test(action))
  check("auto-producer: the TTS bytes are PROBED before anything is hosted, and a refusal throws (the run is marked failed with the reason)", producer.indexOf("probeMp3(tts.audioBuffer)") > 0 && producer.indexOf("probeMp3(tts.audioBuffer)") < producer.indexOf("hostRenderedMedia(") && /ElevenLabs returned audio that is not playable/.test(producer))
  check("auto-producer: the audio is levelled + measured; a SKIPPED level is recorded on the run's error_message, never silent; the duration is the measured one", /assemblePodcastEpisode\(\[tts\.audioBuffer\]/.test(producer) && /audio not loudness-levelled/.test(producer) && /\.\.\.\(masterNote \? \{ error_message: masterNote \} : \{\}\)/.test(producer) && /mastered\.facts\.durationSeconds/.test(producer))

  // ═══════════════════ E · the preset door keeps the human approval (wave 144, lane 144H, owner ruling 18) ═══════════════════
  // Measured at 967a4866: orchestratePodcastPresetPublish READ the episode's status and never checked it, and swallowed both reads'
  // errors — a preset staged distribution rows for an episode still pending_review. The distributor cron filtered on approval, so the
  // egress held; the authoritative WRITE did not.
  section("E · the podcast preset door — approved, finished, tenant-pinned, refusals read")
  {
    const B = "00000000-0000-4000-8000-0000000000b1", B2 = "00000000-0000-4000-8000-0000000000b2", EP = "44444444-4444-4444-8444-444444444444", PRE = "55555555-5555-4555-8555-555555555555"
    const world = (ep: Record<string, unknown>, o: { refuse?: Record<string, string> } = {}) => memSupabase({
      podcast_episode_presets: [{ id: PRE, brokerage_id: B, name: "Monthly show", podcast_episode_id: EP, target_distribution_channels: ["spotify", "apple"], is_active: true }],
      podcast_episodes: [{ id: EP, brokerage_id: B, status: "completed", approval_status: "approved", ...ep }],
      podcast_distribution_log: [],
    }, { uuidIds: true, refuse: o.refuse })
    const run = (db: ReturnType<typeof world>, tenant = B) => orchestratePodcastPresetPublish({ brokerageId: tenant, presetId: PRE }, { client: db as never })
    const okDb = world({})
    const ok = await run(okDb)
    check("an APPROVED, finished episode is staged to every target channel (one pending log row each)", ok.success && ok.channelsCount === 2 && okDb.tables.podcast_distribution_log.length === 2 && okDb.tables.podcast_distribution_log.every((r) => r.distribution_status === "pending" && r.podcast_episode_id === EP))
    for (const [label, ep, re] of [
      ["an episode still PENDING REVIEW (the auto-producer's state)", { approval_status: "pending_review" }, /episode_not_approved/],
      ["an episode with NO approval recorded", { approval_status: null }, /episode_not_approved/],
      ["an approved episode that is not finished (generating)", { status: "generating" }, /episode_not_ready/],
    ] as Array<[string, Record<string, unknown>, RegExp]>) {
      const db = world(ep)
      const r = await run(db)
      check(`REFUSED: ${label} — no distribution row written`, !r.success && re.test(r.error ?? "") && db.tables.podcast_distribution_log.length === 0, r.error)
    }
    check("another tenant's preset is refused (tenant_mismatch), nothing written", (await run(world({}), B2)).error === "tenant_mismatch")
    const refusedEp = await run(world({}, { refuse: { podcast_episodes: "permission denied for table podcast_episodes" } }))
    const refusedPre = await run(world({}, { refuse: { podcast_episode_presets: "permission denied for table podcast_episode_presets" } }))
    check("a REFUSED read is reported as a refusal (never 'not found'), for the preset and for the episode (§3)", !refusedEp.success && /episode_read_refused: permission denied/.test(refusedEp.error ?? "") && !refusedPre.success && /preset_read_refused: permission denied/.test(refusedPre.error ?? ""))
    const presetSrc = code("lib/podcast/orchestrate-podcast-preset-publish.ts"), cron = code("app/api/cron/distribute-podcast-episodes/route.ts")
    check("ONE approval vocabulary: the preset door and the distributor both gate on approval_status 'approved' (positive control: the distributor carries it)", /ep\.approval_status !== "approved"/.test(presetSrc) && /\.eq\("approval_status", "approved"\)/.test(cron))
  }
  finish()

  function finish() {
    console.log("\n──────────────────────────────────────────────────")
    console.log(` Denominators: 6 probe cases + ${single.length} single-failure cases; real fixtures: 3 MP3 segments (4/6/3 s at three levels) + 1 quiet 5 s + 1 JSON body`)
    console.log(" Blind spots:")
    for (const b of [
      "the MP3 probe reads the FIRST frame header, not every frame — a file with a valid head and a corrupt body passes the probe and is caught only by the assembly's re-measure (which decodes it) or by the directory",
      "the −16 LUFS ±1 / −1 dBTP figures are the commonly published podcast targets (Apple guidance via Podnews / Descript, read 2026-10-23); Apple's own page could not be read for the loudness wording, and the distributor / directory's own spec governs (WAITING_EXTERNAL: Transistor and the directories it feeds)",
      "the fixtures are sine tones, not speech: they prove the assemble / level arithmetic on real ffmpeg output, not how a cloned voice sounds; no ElevenLabs call is made",
      "segments are concatenated back to back (no crossfade or room-tone gap): TTS segments carry their own tail silence; a produced intro/outro stinger or music bed is NOT added here",
      "the weekly auto-producer's spoken script is ONE TTS call, so there is nothing to assemble there — only the probe, the level and the measured duration apply",
      "distribution (Transistor → Spotify / Apple / YouTube Music / RSS) is built and honest about a missing connection; it was not exercised here — it needs the tenant's Transistor connection (WAITING_EXTERNAL)",
    ]) console.log(`   · ${b}`)
    if (failures.length) { console.log(" FAILURES:"); for (const x of failures) console.log(`   - ${x}`) }
    console.log(` RESULT: ${passed} passed, ${failed} failed`)
    if (failed > 0) { console.log(" ❌ PODCAST_EPISODE_AUDIO_FAIL"); process.exit(1) }
    console.log(" ✅ PODCAST_EPISODE_AUDIO_PASS — an episode is the whole show, levelled and measured; unplayable audio never becomes one")
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
