/**
 * lib/video/playable-output.ts — IS THIS RENDER OUTPUT ACTUALLY PLAYABLE? (wave 142, lane 142F)
 *
 * OWNER (2026-10-18): "a render is complete only when the output is PLAYABLE, never
 * because a status column says success."
 *
 * WHAT WAS TRUE BEFORE THIS FILE. Every render path in the OS ended the same way:
 * bytes → lib/remotion/media-host.ts hostRenderedMedia → `render_status: "succeeded"`
 * (render-coordinator :433, render-composition :260) or `status: "completed"`
 * (render-just-listed, render-newsletter-video, poll-did-videos). The host read the
 * storage refusal (CLAUDE.md §3) — so a file that did not LAND was loud — but nothing
 * ever looked at what the bytes WERE. A zero-byte file, an ffmpeg pass that wrote a
 * partial container (the lane-86B measurements: a silent sting made `[i:a]` invalid
 * and the stitch failed — and before the coordinator's `concat.outputBuffer.length > 0`
 * guard a failed pass could hand back an empty buffer), a D-ID download cut off
 * mid-transfer, or an MP4 with no `moov` box (the player cannot locate a single
 * track) all hosted fine, were stamped succeeded, and reached a client as a dead
 * link. lib/video/playable-video.ts resolvePlayableVideo resolves a URL from a status
 * column; it never probes the file (its header says so).
 *
 * THIS IS THE PROBE, and it is PURE: no I/O, no ffmpeg, no server-only, so
 * scripts/video-pipeline-truth-guard.ts proves it on synthetic containers and the
 * host runs it on the bytes it is about to store (lib/remotion/media-host.ts — the
 * ONE host every finished render, still, voiceover and D-ID re-host goes through).
 *
 * WHY A HEADER PARSE AND NOT ffprobe: `ffmpeg-static` ships NO ffprobe
 * (lib/video/stitch-graph.ts:135 records it; every probe in this tree parses
 * `ffmpeg -i` stderr), ffmpeg itself is a best-effort dependency the mixers skip
 * when absent, and a spawn per hosted file would add seconds to a route already
 * capped at 300 s. The container header answers the question the owner asked —
 * "will a player open this?" — in microseconds:
 *   · MP4 / MOV (ISO BMFF): the first box is `ftyp`, a `moov` box exists (track
 *     + sample tables — without it nothing plays), an `mdat` box exists (the
 *     samples themselves), every box's declared size fits in the file (a box that
 *     runs past EOF is a truncated upload), and `moov/mvhd` carries a duration
 *     > 0 (timescale + duration, version 0 or 1).
 *   · WebM / Matroska: the EBML magic 1A 45 DF A3 opens the file and a Segment
 *     (18 53 80 67) follows; the Info Duration (44 89, float32/64) is read when
 *     it sits in the first 64 KiB (best-effort — a live-muxed file may omit it).
 *   · Anything that is not a video content type is SKIPPED (ok, not_video): the
 *     host also stores PNGs, PDFs and MP3s, and this probe only ever judges video.
 *
 * STATED BLIND SPOTS (§2): a header-complete file with a corrupt codec payload
 * passes — the probe proves the container, not every frame; the optional
 * `ffmpeg -i` duration probe (lib/video/composite-attribution.ts
 * probeRemoteVideoDurationSeconds) is the deeper check and stays best-effort.
 */

type PlayableContainer = "mp4" | "webm" | "not_video" | "unknown"

interface PlayableProbe {
  /** True when a player can be expected to open the file. Always true for non-video types. */
  ok: boolean
  container: PlayableContainer
  bytes: number
  /** Seconds from the container header when it carries one; null when it does not. */
  durationSeconds: number | null
  /** Every reason the probe refused, in the order found. Empty when ok. */
  reasons: string[]
  /** ISO BMFF facts, present for mp4 probes. */
  mp4?: { firstBox: string | null; hasMoov: boolean; hasMdat: boolean; boxes: string[] }
}

/** The content types the probe judges. Everything else is skipped as not_video. */
export function isVideoContentType(contentType: string): boolean {
  return /^video\//i.test((contentType ?? "").trim())
}

/** The one place a refused probe's reason is spelled — the failure census keys on this token.
 * @proofSeam scripts/video-pipeline-truth-guard.ts asserts describeUnplayable carries the token the census classifies on. */
export const UNPLAYABLE_OUTPUT_TOKEN = "output not playable"

/**
 * Probe the bytes a render path is about to host. PURE and total: never throws —
 * a parser surprise is a refusal with the reason, never a crash in a completion path.
 */
export function probePlayableOutput(bytes: Uint8Array | Buffer | null | undefined, contentType: string): PlayableProbe {
  const size = bytes?.byteLength ?? 0
  if (!isVideoContentType(contentType)) {
    return { ok: true, container: "not_video", bytes: size, durationSeconds: null, reasons: [] }
  }
  if (!bytes || size === 0) {
    return { ok: false, container: "unknown", bytes: 0, durationSeconds: null, reasons: ["empty output (0 bytes)"] }
  }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ct = contentType.trim().toLowerCase()
  try {
    if (ct === "video/webm" || ct === "video/x-matroska") return probeWebm(buf)
    return probeMp4(buf)
  } catch (e) {
    return {
      ok: false, container: "unknown", bytes: size, durationSeconds: null,
      reasons: [`container parse failed: ${(e as Error).message}`],
    }
  }
}

// ── ISO BMFF (MP4 / MOV) ───────────────────────────────────────────────────────

const BOX_TYPE_RE = /^[A-Za-z0-9 ©\-_.]{4}$/

function boxType(buf: Buffer, at: number): string {
  return buf.toString("latin1", at + 4, at + 8)
}

/** Walk the top-level boxes; returns null when a box is malformed (type or size). */
function walkBoxes(buf: Buffer, from: number, to: number): Array<{ type: string; start: number; size: number; headerSize: number }> | { malformed: string } {
  const out: Array<{ type: string; start: number; size: number; headerSize: number }> = []
  let i = from
  while (i + 8 <= to) {
    let boxSize: number = buf.readUInt32BE(i)
    const type = boxType(buf, i)
    let headerSize = 8
    if (!BOX_TYPE_RE.test(type)) return { malformed: `box type ${JSON.stringify(type)} at offset ${i} is not a four-character code` }
    if (boxSize === 1) {
      if (i + 16 > to) return { malformed: `box '${type}' at offset ${i} declares a 64-bit size the file is too short to carry` }
      const large = buf.readBigUInt64BE(i + 8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return { malformed: `box '${type}' at offset ${i} declares an unrepresentable size` }
      boxSize = Number(large)
      headerSize = 16
    } else if (boxSize === 0) {
      boxSize = to - i // extends to end of file
    }
    if (boxSize < headerSize) return { malformed: `box '${type}' at offset ${i} declares ${boxSize} bytes, smaller than its own header` }
    if (i + boxSize > to) return { malformed: `box '${type}' at offset ${i} declares ${boxSize} bytes but only ${to - i} remain (truncated upload)` }
    out.push({ type, start: i, size: boxSize, headerSize })
    i += boxSize
  }
  return out
}

function probeMp4(buf: Buffer): PlayableProbe {
  const reasons: string[] = []
  const walked = walkBoxes(buf, 0, buf.length)
  if ("malformed" in walked) {
    const firstBox = buf.length >= 8 && BOX_TYPE_RE.test(boxType(buf, 0)) ? boxType(buf, 0) : null
    return {
      ok: false, container: "mp4", bytes: buf.length, durationSeconds: null,
      reasons: [walked.malformed],
      mp4: { firstBox, hasMoov: false, hasMdat: false, boxes: [] },
    }
  }
  const boxes = walked.map((b) => b.type)
  const first = boxes[0] ?? null
  if (first !== "ftyp") reasons.push(`not an ISO BMFF file: first box is ${first ? `'${first}'` : "absent"}, expected 'ftyp'`)
  const moov = walked.find((b) => b.type === "moov")
  const hasMdat = walked.some((b) => b.type === "mdat")
  if (!moov) reasons.push("no 'moov' box — the player cannot locate a track or a sample table")
  if (!hasMdat) reasons.push("no 'mdat' box — the file carries no media samples")

  let durationSeconds: number | null = null
  if (moov) {
    const children = walkBoxes(buf, moov.start + moov.headerSize, moov.start + moov.size)
    if ("malformed" in children) {
      reasons.push(`'moov' is malformed: ${children.malformed}`)
    } else {
      const mvhd = children.find((b) => b.type === "mvhd")
      if (!mvhd) {
        reasons.push("'moov' carries no 'mvhd' (movie header) — no timescale or duration")
      } else {
        const p = mvhd.start + mvhd.headerSize
        const version = buf.readUInt8(p)
        if (version === 0 && p + 28 <= buf.length) {
          const timescale = buf.readUInt32BE(p + 12)
          const duration = buf.readUInt32BE(p + 16)
          durationSeconds = timescale > 0 ? duration / timescale : null
        } else if (version === 1 && p + 40 <= buf.length) {
          const timescale = buf.readUInt32BE(p + 20)
          const duration = Number(buf.readBigUInt64BE(p + 24))
          durationSeconds = timescale > 0 ? duration / timescale : null
        } else {
          reasons.push(`'mvhd' version ${version} is unreadable or truncated`)
        }
        if (durationSeconds !== null && !(durationSeconds > 0)) {
          reasons.push("'mvhd' duration is 0 — a player would open a zero-length movie")
        }
      }
    }
  }
  return {
    ok: reasons.length === 0, container: "mp4", bytes: buf.length, durationSeconds, reasons,
    mp4: { firstBox: first, hasMoov: !!moov, hasMdat, boxes },
  }
}

// ── WebM / Matroska (EBML) ────────────────────────────────────────────────────

const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
const EBML_SEGMENT = Buffer.from([0x18, 0x53, 0x80, 0x67])
const EBML_INFO = Buffer.from([0x15, 0x49, 0xa9, 0x66])
const EBML_DURATION = Buffer.from([0x44, 0x89])
const WEBM_SCAN_BYTES = 64 * 1024

function probeWebm(buf: Buffer): PlayableProbe {
  const reasons: string[] = []
  if (buf.length < 4 || !buf.subarray(0, 4).equals(EBML_MAGIC)) {
    reasons.push("not an EBML (WebM / Matroska) file: the 1A 45 DF A3 magic is absent")
    return { ok: false, container: "webm", bytes: buf.length, durationSeconds: null, reasons }
  }
  const head = buf.subarray(0, Math.min(buf.length, WEBM_SCAN_BYTES))
  if (head.indexOf(EBML_SEGMENT) < 0) reasons.push("no Segment element in the first 64 KiB — no clusters can follow")
  let durationSeconds: number | null = null
  const info = head.indexOf(EBML_INFO)
  if (info >= 0) {
    const d = head.indexOf(EBML_DURATION, info)
    if (d >= 0 && d + 3 <= head.length) {
      const sizeByte = head.readUInt8(d + 2)
      // Duration is a float: 0x84 → 4-byte float32, 0x88 → 8-byte float64 (in TimestampScale units, default 1 ms).
      if (sizeByte === 0x84 && d + 7 <= head.length) durationSeconds = head.readFloatBE(d + 3) / 1000
      else if (sizeByte === 0x88 && d + 11 <= head.length) durationSeconds = head.readDoubleBE(d + 3) / 1000
      if (durationSeconds !== null && !(durationSeconds > 0)) reasons.push("Info Duration is 0")
    }
  }
  return { ok: reasons.length === 0, container: "webm", bytes: buf.length, durationSeconds, reasons }
}

/** One line for a log or an error_message: `output not playable — <reasons>`. */
export function describeUnplayable(probe: PlayableProbe): string {
  return `${UNPLAYABLE_OUTPUT_TOKEN} (${probe.container}, ${probe.bytes} bytes) — ${probe.reasons.join("; ")}`
}
