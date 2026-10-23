// lib/video/tv-spot.ts
//
// THE TV-AD-READY SPECIFICATION AND ITS EVALUATOR (wave 143, lane 143F; owner 2026-10-22: "videos are also created
// for TV ads"). PURE — no I/O, no ffmpeg, no server-only — so the numbers are proven without rendering a frame.
// The measuring half is lib/video/tv-spot-measure.ts and the mastering half lib/video/tv-spot-master.ts; the door that records the result on the asset is
// lib/video/tv-spot-produce.ts.
//
// WHAT "TV-READY" MEANS HERE, AND WHAT IT DOES NOT. A finished social/web reel is mastered for the feed: -14 LUFS
// (lib/remotion/music-filter-graph.ts MASTER_LOUDNESS), any aspect, no caption file. A spot a station or a streaming-TV
// platform airs is judged on four things the owner named — aspect, duration, loudness, captions — plus the container
// facts a delivery desk rejects on sight:
//   · ASPECT — 16:9 landscape, 1920×1080 (1280×720 is accepted as the floor). A vertical or square cut is NOT letterboxed
//     into a TV master; it is refused, because pillarboxing a phone reel is the "amateur" tell the stations reject.
//   · DURATION — the standard spot lengths, 15 / 30 / 60 s, within half a second (broadcast spots are frame-accurate; the
//     CTV staging pre-check in lib/ads/ctv-campaign.ts is looser by design — it is a hint, this is the master).
//   · LOUDNESS — −24 LKFS (±2) integrated and a true peak at or under −2 dBTP: ATSC A/85, which the FCC applies to
//     commercials through the CALM Act (47 U.S.C. § 621; 47 CFR § 73.682(e) for stations, § 76.607 for MVPDs). Read
//     2026-10-23 from secondary sources (FCC / NAB / trade press) — the ±2 dB and −2 dBTP figures are the commonly
//     published A/85 values; the STATION'S OWN delivery spec governs and must be confirmed per buy (WAITING_EXTERNAL).
//   · CAPTIONS — a caption file exists. Embedded CEA-608/708 data is the broadcaster's encoder's job; a caption SIDECAR
//     (SRT / WebVTT) is what this OS can make. Timing is from real alignment when the project carries it, else an
//     ESTIMATE — and an estimated caption file is reported as such, never as accurate.
//   · CONTAINER — H.264, yuv420p, progressive, 29.97 (or 23.976 / 24 / 25 / 30) fps, 48 kHz stereo AAC.
//
// Nothing here says a spot will be ACCEPTED: acceptance is the station's / platform's call. "ready" means every measurable
// check passed on the file.

import type { CaptionCue } from "./caption-plan"

/** The spec, versioned so a recorded result says which numbers it was judged against. */
export const TV_SPOT_SPEC = {
  version: "2026-10-23",
  width: 1920,
  height: 1080,
  minWidth: 1280,
  minHeight: 720,
  /** 16:9 within 1% — a 1920×1080 or 1280×720 frame, not a 1.85 crop. */
  aspectRatio: 16 / 9,
  aspectTolerance: 0.01,
  lengthsSeconds: [15, 30, 60] as readonly number[],
  lengthToleranceSeconds: 0.5,
  /** Broadcast frame rates (NTSC-family and film/PAL-family), within 0.02 fps. */
  frameRates: [23.976, 24, 25, 29.97, 30] as readonly number[],
  frameRateTolerance: 0.02,
  loudness: { targetLkfs: -24, toleranceLu: 2, maxTruePeakDbtp: -2 },
  audio: { channels: 2, sampleRate: 48000 },
  video: { codec: "h264", pixelFormat: "yuv420p" },
  /** Where the numbers come from — printed beside every verdict. */
  authority: "ATSC A/85 via the CALM Act (47 U.S.C. § 621; 47 CFR § 73.682(e), § 76.607); station / platform delivery spec governs",
} as const

/** What was measured on the file (the probe's output, or a fixture's). */
export interface TvSpotFacts {
  width: number | null
  height: number | null
  fps: number | null
  durationSeconds: number | null
  videoCodec: string | null
  pixelFormat: string | null
  hasAudio: boolean
  audioChannels: number | null
  audioSampleRate: number | null
  integratedLufs: number | null
  truePeakDbtp: number | null
  /** The caption sidecar: present, and whether its timing is real alignment or an even-distribution estimate. */
  captions: { present: boolean; timing: "alignment" | "even" | "none" }
}

export interface TvSpotCheck {
  id: "aspect" | "resolution" | "duration" | "frame_rate" | "loudness" | "true_peak" | "audio" | "container" | "captions"
  ok: boolean
  required: string
  measured: string
}

export interface TvSpotEvaluation {
  /** Every measurable check passed. NOT a promise of acceptance by a station. */
  ready: boolean
  checks: TvSpotCheck[]
  failed: TvSpotCheck[]
  /** Passes that deserve a human's eye (estimated caption timing). */
  warnings: string[]
  specVersion: string
}

const fmt = (n: number | null, digits = 2) => (n === null || !Number.isFinite(n) ? "not measured" : Number(n.toFixed(digits)).toString())

/** PURE. Judge measured facts against the spec. A fact that was not measured FAILS its check — "not measured" is not "fine". */
export function evaluateTvSpot(f: TvSpotFacts, spec: typeof TV_SPOT_SPEC = TV_SPOT_SPEC): TvSpotEvaluation {
  const checks: TvSpotCheck[] = []
  const warnings: string[] = []
  const has = (n: number | null): n is number => n !== null && Number.isFinite(n)

  const ratio = has(f.width) && has(f.height) && f.height > 0 ? f.width / f.height : null
  checks.push({
    id: "aspect", required: `16:9 (±${spec.aspectTolerance * 100}%)`, measured: ratio === null ? "not measured" : `${fmt(f.width, 0)}×${fmt(f.height, 0)} = ${ratio.toFixed(3)}`,
    ok: ratio !== null && Math.abs(ratio - spec.aspectRatio) / spec.aspectRatio <= spec.aspectTolerance,
  })
  checks.push({
    id: "resolution", required: `≥ ${spec.minWidth}×${spec.minHeight} (target ${spec.width}×${spec.height})`, measured: has(f.width) && has(f.height) ? `${f.width}×${f.height}` : "not measured",
    ok: has(f.width) && has(f.height) && f.width >= spec.minWidth && f.height >= spec.minHeight,
  })
  const nearLength = has(f.durationSeconds) ? spec.lengthsSeconds.find((s) => Math.abs((f.durationSeconds as number) - s) <= spec.lengthToleranceSeconds) : undefined
  checks.push({
    id: "duration", required: `${spec.lengthsSeconds.join(" / ")} s (±${spec.lengthToleranceSeconds} s)`, measured: has(f.durationSeconds) ? `${fmt(f.durationSeconds)} s` : "not measured",
    ok: nearLength !== undefined,
  })
  const rate = has(f.fps) ? spec.frameRates.find((r) => Math.abs((f.fps as number) - r) <= spec.frameRateTolerance) : undefined
  checks.push({ id: "frame_rate", required: `${spec.frameRates.join(" / ")} fps`, measured: has(f.fps) ? `${fmt(f.fps, 3)} fps` : "not measured", ok: rate !== undefined })
  const l = spec.loudness
  checks.push({
    id: "loudness", required: `${l.targetLkfs} LKFS ±${l.toleranceLu}`, measured: has(f.integratedLufs) ? `${fmt(f.integratedLufs, 1)} LUFS` : "not measured",
    ok: f.hasAudio && has(f.integratedLufs) && Math.abs(f.integratedLufs - l.targetLkfs) <= l.toleranceLu,
  })
  checks.push({
    id: "true_peak", required: `≤ ${l.maxTruePeakDbtp} dBTP`, measured: has(f.truePeakDbtp) ? `${fmt(f.truePeakDbtp, 1)} dBTP` : "not measured",
    ok: f.hasAudio && has(f.truePeakDbtp) && f.truePeakDbtp <= l.maxTruePeakDbtp,
  })
  checks.push({
    id: "audio", required: `${spec.audio.channels} ch, ${spec.audio.sampleRate} Hz`, measured: !f.hasAudio ? "no audio stream" : `${fmt(f.audioChannels, 0)} ch, ${fmt(f.audioSampleRate, 0)} Hz`,
    ok: f.hasAudio && f.audioChannels === spec.audio.channels && f.audioSampleRate === spec.audio.sampleRate,
  })
  checks.push({
    id: "container", required: `${spec.video.codec}, ${spec.video.pixelFormat}`, measured: `${f.videoCodec ?? "not measured"}, ${f.pixelFormat ?? "not measured"}`,
    ok: f.videoCodec === spec.video.codec && f.pixelFormat === spec.video.pixelFormat,
  })
  checks.push({
    id: "captions", required: "a caption file (SRT / WebVTT)", measured: f.captions.present ? `present (${f.captions.timing} timing)` : "none",
    ok: f.captions.present,
  })
  if (f.captions.present && f.captions.timing === "even") warnings.push("The caption file's timing is an even-distribution ESTIMATE from the script (no word-level alignment on this project) — review it against the audio before it airs.")

  const failed = checks.filter((c) => !c.ok)
  return { ready: failed.length === 0, checks, failed, warnings, specVersion: spec.version }
}

// ── Captions as a sidecar ────────────────────────────────────────────────────────────────────────

function pad(n: number, w = 2): string { return String(Math.floor(n)).padStart(w, "0") }
function clock(seconds: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(seconds * 1000))
  return `${pad(ms / 3_600_000)}:${pad((ms % 3_600_000) / 60_000)}:${pad((ms % 60_000) / 1000)}${sep}${pad(ms % 1000, 3)}`
}

/** PURE. SRT from caption cues (frames at `fps`). A cue with no text is dropped; numbering is contiguous from 1. */
export function captionCuesToSrt(cues: readonly CaptionCue[], fps: number): string {
  const f = fps > 0 ? fps : 30
  return cues.filter((c) => c.text.trim()).map((c, i) =>
    `${i + 1}\n${clock(c.fromFrame / f, ",")} --> ${clock((c.fromFrame + Math.max(1, c.durationFrames)) / f, ",")}\n${c.text.trim()}\n`,
  ).join("\n")
}

/** PURE. WebVTT from caption cues. */
export function captionCuesToWebVtt(cues: readonly CaptionCue[], fps: number): string {
  const f = fps > 0 ? fps : 30
  const body = cues.filter((c) => c.text.trim()).map((c) =>
    `${clock(c.fromFrame / f, ".")} --> ${clock((c.fromFrame + Math.max(1, c.durationFrames)) / f, ".")}\n${c.text.trim()}\n`,
  ).join("\n")
  return `WEBVTT\n\n${body}`
}

// ── Reading ffmpeg's own report (the probe ffmpeg-static allows: it ships no ffprobe) ─────────────

/** PURE. Container facts from `ffmpeg -i` stderr (Duration / Video / Audio lines). Anything it cannot read stays null. */
export function parseFfmpegInfo(stderr: string): Pick<TvSpotFacts, "width" | "height" | "fps" | "durationSeconds" | "videoCodec" | "pixelFormat" | "hasAudio" | "audioChannels" | "audioSampleRate"> {
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const durationSeconds = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null
  const vLine = /Stream #\d+:\d+[^\n]*Video:[^\n]*/.exec(stderr)?.[0] ?? ""
  const dims = /\b(\d{3,5})x(\d{3,5})\b/.exec(vLine.replace(/\b0x[0-9a-f]+\b/gi, ""))
  const fps = /([\d.]+)\s*fps/.exec(vLine)
  const vCodec = /Video:\s*([a-z0-9_]+)/i.exec(vLine)
  const pix = /,\s*(yuvj?\d{3}p\d*(?:le|be)?|nv12|nv21|gbrp\d*|rgb24|bgr24|gray\d*)\b/i.exec(vLine)
  const aLine = /Stream #\d+:\d+[^\n]*Audio:[^\n]*/.exec(stderr)?.[0] ?? ""
  const hz = /(\d{4,6})\s*Hz/.exec(aLine)
  const layout = /Hz,\s*([^,\n]+)/.exec(aLine)?.[1]?.trim().toLowerCase() ?? ""
  const channels = layout === "mono" ? 1 : layout === "stereo" ? 2 : /^(\d+)\.(\d+)/.test(layout) ? Number(/^(\d+)\.(\d+)/.exec(layout)![1]) + Number(/^(\d+)\.(\d+)/.exec(layout)![2]) : /^(\d+) channels/.test(layout) ? Number(/^(\d+)/.exec(layout)![1]) : null
  return {
    width: dims ? Number(dims[1]) : null,
    height: dims ? Number(dims[2]) : null,
    fps: fps ? Number(fps[1]) : null,
    durationSeconds,
    videoCodec: vCodec ? vCodec[1].toLowerCase() : null,
    pixelFormat: pix ? pix[1].toLowerCase() : null,
    hasAudio: aLine.length > 0,
    audioChannels: aLine ? channels : null,
    audioSampleRate: hz ? Number(hz[1]) : null,
  }
}

/** PURE. The linear gain (dB) that brings a measured master onto −24 LKFS without crossing the true-peak ceiling; 0 inside ±0.5 LU. */
export function tvTrimGainDb(measured: { integratedLufs: number; truePeakDbtp: number }, spec: typeof TV_SPOT_SPEC = TV_SPOT_SPEC): number {
  if (!Number.isFinite(measured.integratedLufs) || measured.integratedLufs < -60) return 0
  let gain = spec.loudness.targetLkfs - measured.integratedLufs
  if (Math.abs(gain) <= 0.5) return 0
  const room = spec.loudness.maxTruePeakDbtp - 0.1 - measured.truePeakDbtp
  if (gain > room) gain = Math.max(0, room)
  return Number(gain.toFixed(1))
}
