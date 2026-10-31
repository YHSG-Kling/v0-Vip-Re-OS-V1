// lib/podcast/episode-audio-spec.ts
//
// WHAT A PODCAST EPISODE'S AUDIO MUST BE, AS NUMBERS AND A PURE JUDGE (wave 143, lane 143F; owner: podcasts are public marketing —
// "audit scripting, audio production, storage, approval, authorized distribution; build the smallest missing half").
// The audit (lib/podcast/*, app/actions/podcast-generation.ts, app/api/cron/distribute-podcast-episodes) found script → voice →
// storage → approval → distribution all built, and ONE hole in the audio step: the manual studio path synthesised each script
// segment as its own file and then published `audioSegments[0].url` — the INTRO alone — as the episode while recording the SUM of
// the segments' ESTIMATED durations ("in production, use FFmpeg or similar. For now, we'll just use the first segment"). A listener
// of a manual episode heard thirty seconds of a three-minute show. The cure is lib/podcast/episode-audio.ts (assemble + level the
// segments into ONE file and MEASURE it); this file is its pure half so the numbers are proven without ffmpeg.
//
// THE TARGET (read 2026-10-23): podcast loudness has settled on −16 LUFS integrated with a −1 dBTP true-peak ceiling (Apple's podcast
// guidance as quoted by Podnews / Descript / German podcast sites; Apple's own page confirms the file formats: MP3 or AAC, MP3 stereo
// 44.1/48 kHz at 128–256 kbps recommended, mono 96–128 kbps, 64 / 32 kbps the floors). The exact loudness wording on Apple's page was not
// readable in this session — the ±1 LU tolerance is the commonly published figure, and a directory's own spec governs (WAITING_EXTERNAL:
// the distributor — Transistor — and the directories it feeds).
//
// PURE: no I/O, no server-only.

export const PODCAST_AUDIO_SPEC = {
  version: "2026-10-23",
  loudness: { targetLufs: -16, toleranceLu: 1, maxTruePeakDbtp: -1 },
  sampleRates: [44100, 48000] as readonly number[],
  /** MP3 recommended ranges (kbps): mono 96–128 (floor 32), stereo 128–256 (floor 64). */
  bitrateKbps: { mono: { floor: 32, min: 96, max: 128 }, stereo: { floor: 64, min: 128, max: 256 } },
  authority: "podcast loudness −16 LUFS / −1 dBTP (Apple Podcasts guidance via Podnews, Descript); MP3 44.1/48 kHz per Apple's audio requirements page; the directory's own spec governs",
} as const

export interface Mp3Probe {
  ok: boolean
  reasons: string[]
  sampleRate: number | null
  channels: number | null
  bitrateKbps: number | null
  /** CBR estimate from the first frame (null for VBR-looking files / unreadable) — a hint, the measured duration is the truth. */
  estimatedSeconds: number | null
  hadId3: boolean
}

// MPEG-1 Layer III bitrates (kbps) and sample rates; MPEG-2/2.5 Layer III tables.
const BR_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const BR_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] } as const

/**
 * PURE. Is this buffer an MP3 (optionally behind an ID3v2 tag) with a valid first Layer III frame header? Refuses: empty / tiny
 * buffers, a JSON or HTML error body (what a failed TTS call returns with a 200), text, and a buffer with no frame sync in the first
 * 64 KB. It reads the header, not every frame — the full decode is ffmpeg's job (episode-audio.ts measures the file it makes).
 */
export function probeMp3(bytes: Uint8Array | Buffer | null | undefined): Mp3Probe {
  const none = (reasons: string[], hadId3 = false): Mp3Probe => ({ ok: false, reasons, sampleRate: null, channels: null, bitrateKbps: null, estimatedSeconds: null, hadId3 })
  if (!bytes || bytes.length === 0) return none(["empty buffer (0 bytes)"])
  if (bytes.length < 2048) {
    const head = Buffer.from(bytes.subarray(0, 120)).toString("latin1")
    return none([/^\s*[{<]/.test(head) ? `looks like an error body, not audio: ${head.replace(/\s+/g, " ").slice(0, 80)}` : `only ${bytes.length} bytes — too small to be an episode`])
  }
  let p = 0
  let hadId3 = false
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) { // "ID3"
    hadId3 = true
    p = 10 + (((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f))
  }
  const limit = Math.min(bytes.length - 4, p + 65536)
  for (let i = p; i < limit; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue
    const version = (bytes[i + 1] >> 3) & 0x3 // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5, 1 = reserved
    const layer = (bytes[i + 1] >> 1) & 0x3 // 1 = Layer III
    const brIdx = (bytes[i + 2] >> 4) & 0xf, srIdx = (bytes[i + 2] >> 2) & 0x3
    if (version === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue
    const sampleRate = (SR as Record<number, readonly number[]>)[version][srIdx]
    const bitrateKbps = (version === 3 ? BR_V1_L3 : BR_V2_L3)[brIdx]
    const channels = ((bytes[i + 3] >> 6) & 0x3) === 3 ? 1 : 2
    const audioBytes = bytes.length - i
    return { ok: true, reasons: [], sampleRate, channels, bitrateKbps, estimatedSeconds: bitrateKbps > 0 ? (audioBytes * 8) / (bitrateKbps * 1000) : null, hadId3 }
  }
  return none([`no MPEG audio frame found in the first 64 KB${hadId3 ? " after the ID3 tag" : ""} — not an MP3`], hadId3)
}

export interface PodcastAudioFacts {
  durationSeconds: number | null
  integratedLufs: number | null
  truePeakDbtp: number | null
  sampleRate: number | null
  channels: number | null
  bitrateKbps: number | null
  codec: string | null
}

export interface PodcastAudioCheck { id: "duration" | "loudness" | "true_peak" | "sample_rate" | "bitrate" | "codec"; ok: boolean; required: string; measured: string }
export interface PodcastAudioEvaluation { ready: boolean; checks: PodcastAudioCheck[]; failed: PodcastAudioCheck[]; specVersion: string }

const has = (n: number | null): n is number => n !== null && Number.isFinite(n)

/** PURE. Judge measured facts against the spec. A fact not measured FAILS its check. */
export function evaluatePodcastAudio(f: PodcastAudioFacts, spec: typeof PODCAST_AUDIO_SPEC = PODCAST_AUDIO_SPEC): PodcastAudioEvaluation {
  const l = spec.loudness
  const mono = f.channels === 1
  const br = mono ? spec.bitrateKbps.mono : spec.bitrateKbps.stereo
  const checks: PodcastAudioCheck[] = [
    { id: "duration", required: "> 0 s", measured: has(f.durationSeconds) ? `${f.durationSeconds.toFixed(1)} s` : "not measured", ok: has(f.durationSeconds) && f.durationSeconds > 1 },
    { id: "loudness", required: `${l.targetLufs} LUFS ±${l.toleranceLu}`, measured: has(f.integratedLufs) ? `${f.integratedLufs.toFixed(1)} LUFS` : "not measured", ok: has(f.integratedLufs) && Math.abs(f.integratedLufs - l.targetLufs) <= l.toleranceLu },
    { id: "true_peak", required: `≤ ${l.maxTruePeakDbtp} dBTP`, measured: has(f.truePeakDbtp) ? `${f.truePeakDbtp.toFixed(1)} dBTP` : "not measured", ok: has(f.truePeakDbtp) && f.truePeakDbtp <= l.maxTruePeakDbtp },
    { id: "sample_rate", required: spec.sampleRates.join(" / ") + " Hz", measured: has(f.sampleRate) ? `${f.sampleRate} Hz` : "not measured", ok: has(f.sampleRate) && spec.sampleRates.includes(f.sampleRate) },
    { id: "bitrate", required: `${mono ? "mono" : "stereo"} ${br.min}–${br.max} kbps (floor ${br.floor})`, measured: has(f.bitrateKbps) ? `${f.bitrateKbps} kbps` : "not measured", ok: has(f.bitrateKbps) && f.bitrateKbps >= br.min && f.bitrateKbps <= br.max },
    { id: "codec", required: "mp3 (or aac)", measured: f.codec ?? "not measured", ok: f.codec === "mp3" || f.codec === "aac" },
  ]
  const failed = checks.filter((c) => !c.ok)
  return { ready: failed.length === 0, checks, failed, specVersion: spec.version }
}

/** PURE. Read an audio-only `ffmpeg -i` report: duration, codec, rate, channel layout, bitrate. Unreadable fields stay null. */
export function parseAudioInfo(stderr: string): Pick<PodcastAudioFacts, "durationSeconds" | "sampleRate" | "channels" | "bitrateKbps" | "codec"> {
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const a = /Stream #\d+:\d+[^\n]*Audio:\s*([a-z0-9_]+)[^\n]*?,\s*(\d{4,6}) Hz,\s*([^,\n]+)(?:,[^\n]*?(\d+) kb\/s)?/i.exec(stderr)
  const layout = a?.[3]?.trim().toLowerCase() ?? ""
  const channels = layout === "mono" ? 1 : layout === "stereo" ? 2 : /^(\d+)\.(\d+)/.test(layout) ? Number(/^(\d+)\.(\d+)/.exec(layout)![1]) + Number(/^(\d+)\.(\d+)/.exec(layout)![2]) : null
  return {
    durationSeconds: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null,
    sampleRate: a ? Number(a[2]) : null,
    channels,
    bitrateKbps: a?.[4] ? Number(a[4]) : null,
    codec: a ? a[1].toLowerCase() : null,
  }
}

/** PURE. The linear gain (dB) that brings a measured episode onto −16 LUFS without crossing the −1 dBTP ceiling; 0 inside ±0.3 LU. */
export function podcastTrimGainDb(m: { integratedLufs: number; truePeakDbtp: number }, spec: typeof PODCAST_AUDIO_SPEC = PODCAST_AUDIO_SPEC): number {
  if (!Number.isFinite(m.integratedLufs) || m.integratedLufs < -60) return 0
  let gain = spec.loudness.targetLufs - m.integratedLufs
  if (Math.abs(gain) <= 0.3) return 0
  const room = spec.loudness.maxTruePeakDbtp - 0.1 - m.truePeakDbtp
  if (gain > room) gain = Math.max(0, room)
  return Number(gain.toFixed(1))
}
