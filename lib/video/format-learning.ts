// lib/video/format-learning.ts
//
// FORMAT LEARNING — the Video Director becomes SELF-IMPROVING. The Director's
// selectVideoFormat + musicMoodForSituation are EXPERT RULES (a sensible default
// per situation). This module is the learning loop that lets REAL outcomes tune
// those choices PER BROKERAGE — but only once the data is strong, and never by
// fabricating a signal or overriding the expert default on thin evidence.
//
// It mirrors the gating PHILOSOPHY of lib/kernel/outcome-learning.ts exactly:
//   · outcome-learning trusts a manager UNTIL a real sample (≥ MIN_DECISIONS=10)
//     proves it below TRUST_THRESHOLD. Trusted-until-proven, honest on thin data.
//   · format-learning keeps the expert DEFAULT format UNTIL a competing option
//     for the same situation has a real sample (≥ MIN_FORMAT_SAMPLE) AND beats the
//     default by a clear MARGIN. Default-until-out-performed, honest on thin data.
//
// THE REAL SIGNALS (no fabrication — every number traces to a row):
//   (a) QR SCANS — the Director stamps video_metadata.qr_code_id on each staged
//       ai_video_projects row (commissionVideo). qr_scan_events accrue to that
//       qr_codes row. Scans = real audience action (someone pointed a phone at the
//       outro and tapped through). Counted per qr_code_id, tenant-scoped.
//   (b) SOCIAL ENGAGEMENT — when the video's video_url is distributed, the post's
//       engagement_data accrues on social_posts (lib/kernel/video.ts
//       loadVideoPerformance reads exactly this: media_urls contains video_url →
//       sum engagement_data.{views,engagement,comments,shares}). Same source here.
//
// THE DIMENSIONS we group by are the ones the Director already stamps on the row:
//   video_type (kind), video_metadata.target_channels (channel), composition_id,
//   music_mood — so a learned recommendation is "for THIS kind on THIS channel,
//   composition X with mood Y has out-converted the default".
//
// PURITY: scoreFormatOutcomes + recommendFormatAdjustment are PURE (no I/O). Only
// loadFormatOutcomes touches the DB (read-only, tenant-scoped). NOT server-only —
// the simulator imports the pure functions directly (tsx is not a Server Component).

import type { createServiceClient } from "@/lib/supabase/service"
import type { SelectedFormat, TargetChannel, MusicMood } from "@/lib/video/video-director"

type Svc = ReturnType<typeof createServiceClient>

// ── GATES (mirror outcome-learning's MIN_DECISIONS / TRUST_THRESHOLD) ─────────

/** A competing format needs at least this many sampled VIDEOS before it can
 *  override the expert default. Mirrors MIN_DECISIONS=10 — a real sample, not a
 *  lucky single hit. */
export const MIN_FORMAT_SAMPLE = 10

/** The learned winner must beat the default's performance by at least this much
 *  (absolute, on the 0..1 normalized score) before we override. A clear signal,
 *  not noise — analogous to demanding the rate fall clearly under TRUST_THRESHOLD
 *  before pausing initiative. */
export const FORMAT_MARGIN = 0.1

// ── CONTRACTS ────────────────────────────────────────────────────────────────

/** One raw, already-attributed video outcome — the row shape loadFormatOutcomes
 *  produces and scoreFormatOutcomes folds. Every field traces to a real row;
 *  scans + engagement are the measured signals. */
export interface VideoOutcomeRow {
  /** ai_video_projects.video_type — the Director's SituationKind, mapped. */
  kind: string
  /** The primary target channel this cut shipped for (first of target_channels). */
  channel: TargetChannel | string
  /** The Remotion composition id the Director chose. */
  compositionId: string
  /** The music mood the Director assigned. */
  mood: MusicMood | string
  /** Real QR scans accrued to this video's stamped qr_code_id. */
  scans: number
  /** Real social engagement summed from the distributed post(s) (views +
   *  engagement + comments + shares — the same fields loadVideoPerformance reads). */
  engagement: number
}

/** A scored (kind × channel × composition × mood) cell. `score` is normalized
 *  0..1 over the brokerage's own outcomes so it's comparable across cells. */
export interface FormatScore {
  kind: string
  channel: string
  compositionId: string
  mood: string
  /** Number of real videos that fell in this cell (the sample). */
  sample: number
  /** Total scans + engagement across the cell's videos (the raw signal). */
  totalScans: number
  totalEngagement: number
  /** Mean raw signal (scans + engagement) per video in this cell. */
  meanSignal: number
  /** meanSignal normalized to 0..1 against the busiest cell (max-scaled). The
   *  recommender compares cells on this — a relative measure of what converts. */
  score: number
}

/** The full scored map: keyed by the cell key, plus the max meanSignal used to
 *  normalize (so callers can reason about absolute strength too). */
export interface ScoredFormats {
  cells: Record<string, FormatScore>
  /** The largest meanSignal observed — the denominator for `score`. 0 = no data. */
  maxMeanSignal: number
}

/** What recommendFormatAdjustment returns: either the untouched default or a
 *  learned override, ALWAYS with a human-readable WHY for the audit trail. */
export interface FormatRecommendation {
  /** "default" = expert rule kept (thin/tied data). "learned" = a real, gated win. */
  source: "default" | "learned"
  /** The composition id to actually use (default's, unless overridden). */
  compositionId: string
  /** The mood to actually use (default's, unless a learned mood override fires). */
  mood: MusicMood
  /** Human-readable explanation — rides video_metadata so the choice is auditable. */
  why: string
}

// ── KEYS ─────────────────────────────────────────────────────────────────────

/** Deterministic cell key. Lowercased so live-DB casing variance never splits a
 *  cell. */
export function formatCellKey(
  kind: string, channel: string, compositionId: string, mood: string,
): string {
  return `${kind}|${channel}|${compositionId}|${mood}`.toLowerCase()
}

// ── LAYER 1 · PURE: SCORE ────────────────────────────────────────────────────

/**
 * scoreFormatOutcomes — PURE. Fold raw, attributed video outcomes into a scored
 * (kind × channel × composition × mood) map.
 *
 * The signal per video is scans + engagement — both REAL counts. We sum per cell,
 * take the MEAN per video (so a cell with many mediocre videos doesn't beat a cell
 * with a few great ones just on volume), then MAX-SCALE to 0..1 so cells are
 * comparable within the brokerage. No fabrication: an empty input → empty map,
 * maxMeanSignal 0 (the recommender then always returns the default).
 */
export function scoreFormatOutcomes(rows: VideoOutcomeRow[]): ScoredFormats {
  const acc: Record<string, FormatScore> = {}
  for (const r of rows) {
    const key = formatCellKey(r.kind, String(r.channel), r.compositionId, String(r.mood))
    const cell = acc[key] ?? {
      kind: r.kind, channel: String(r.channel), compositionId: r.compositionId, mood: String(r.mood),
      sample: 0, totalScans: 0, totalEngagement: 0, meanSignal: 0, score: 0,
    }
    cell.sample += 1
    cell.totalScans += Math.max(0, r.scans || 0)
    cell.totalEngagement += Math.max(0, r.engagement || 0)
    acc[key] = cell
  }

  let maxMeanSignal = 0
  for (const cell of Object.values(acc)) {
    cell.meanSignal = cell.sample > 0 ? (cell.totalScans + cell.totalEngagement) / cell.sample : 0
    if (cell.meanSignal > maxMeanSignal) maxMeanSignal = cell.meanSignal
  }
  for (const cell of Object.values(acc)) {
    cell.score = maxMeanSignal > 0 ? cell.meanSignal / maxMeanSignal : 0
  }

  return { cells: acc, maxMeanSignal }
}

// ── LAYER 1 · PURE: RECOMMEND (the gate) ─────────────────────────────────────

function fmtScore(n: number): string { return n.toFixed(2) }

/**
 * recommendFormatAdjustment — PURE, and the heart of the honesty contract.
 *
 * Returns the EXPERT DEFAULT unless a COMPETING option for THIS (kind × channel)
 * — a different composition than the default — has:
 *   1. a real sample (≥ MIN_FORMAT_SAMPLE), AND
 *   2. a score that beats the default cell by ≥ FORMAT_MARGIN.
 * Only then does it return the learned pick + a WHY naming the sample + the delta.
 *
 * Trust-the-default rules (every one returns source:"default"):
 *   · no scored data at all → default ("learning from real outcomes; none yet").
 *   · the default itself was never sampled and nothing clears the bar → default.
 *   · a competitor leads but on a thin sample (< MIN) → default (honest: not enough).
 *   · a competitor has the sample but the margin is thin/tied → default (noise).
 *
 * The default's own performance is read from its cell when present; when the
 * default was never run, the competitor must still clear MIN sample AND FORMAT_MARGIN
 * on the absolute normalized score (it must be a genuinely strong, well-sampled cell,
 * not merely "better than an unobserved default").
 */
export function recommendFormatAdjustment(
  situation: { kind: string; channel: TargetChannel | string },
  scored: ScoredFormats,
  fallback: { compositionId: string; mood: MusicMood },
): FormatRecommendation {
  const def: FormatRecommendation = {
    source: "default",
    compositionId: fallback.compositionId,
    mood: fallback.mood,
    why: "Using the expert default — learning from real video outcomes; not enough data to override yet.",
  }

  const cells = Object.values(scored.cells)
  if (cells.length === 0 || scored.maxMeanSignal <= 0) return def

  // The competing field: every cell for THIS (kind × channel), regardless of mood.
  const kind = situation.kind.toLowerCase()
  const channel = String(situation.channel).toLowerCase()
  const field = cells.filter((c) => c.kind.toLowerCase() === kind && c.channel.toLowerCase() === channel)
  if (field.length === 0) return def

  // The default's own observed performance (0 if the default was never run).
  const defaultCells = field.filter((c) => c.compositionId.toLowerCase() === fallback.compositionId.toLowerCase())
  const defaultScore = defaultCells.reduce((m, c) => Math.max(m, c.score), 0)

  // The strongest WELL-SAMPLED competitor (a DIFFERENT composition than the default).
  const competitors = field
    .filter((c) => c.compositionId.toLowerCase() !== fallback.compositionId.toLowerCase())
    .filter((c) => c.sample >= MIN_FORMAT_SAMPLE)
    .sort((a, b) => b.score - a.score)

  const top = competitors[0]
  if (!top) return def // no competitor with a real sample — keep the default, honestly.

  // The clear-margin gate: the learned pick must beat the default by ≥ FORMAT_MARGIN.
  if (top.score - defaultScore < FORMAT_MARGIN) return def

  // A real, well-sampled, clearly-better winner. Override — and explain why.
  const why =
    `Learned from ${top.sample} real ${situation.kind} videos on ${situation.channel}: ` +
    `${top.compositionId} (mood ${top.mood}) out-converted the default ` +
    `${fallback.compositionId} — score ${fmtScore(top.score)} vs ${fmtScore(defaultScore)} ` +
    `(${top.totalScans} scans + ${top.totalEngagement} engagement across the sample). ` +
    `Override gate: ≥${MIN_FORMAT_SAMPLE} sample AND ≥${FORMAT_MARGIN} margin met.`

  return {
    source: "learned",
    compositionId: top.compositionId,
    mood: (top.mood as MusicMood),
    why,
  }
}

// ── LAYER 2 · LIVE: LOAD (read-only, tenant-scoped) ──────────────────────────

/** Map ai_video_projects.video_type (the Director's stamp) back to a stable kind
 *  label for grouping. The Director stamps video_type via videoTypeForSituation;
 *  we group on it directly (the round-trip back to SituationKind is unnecessary —
 *  the cell key only needs to be STABLE per situation, and video_type is). */
function rowKind(videoType: string | null | undefined): string {
  return (videoType ?? "unknown").toLowerCase()
}

/**
 * loadFormatOutcomes — read-only, tenant-scoped. Join the Director-staged
 * ai_video_projects rows (which carry kind=video_type + video_metadata.{composition_id,
 * target_channels, music_mood, qr_code_id} + video_url) with their REAL outcomes:
 *   · scans  — COUNT(qr_scan_events) per the row's stamped qr_code_id.
 *   · engagement — SUM of engagement_data fields on social_posts whose media_urls
 *                  contains this row's video_url (same attribution as loadVideoPerformance).
 * Returns the scored shape (via scoreFormatOutcomes). Honest on empty: no rows →
 * empty ScoredFormats (recommender then always returns the default).
 *
 * Only Director-staged rows participate — we require video_metadata.composition_id
 * (stamped by commissionVideo). Rows without it (legacy/manual projects) are skipped
 * so the learning signal stays attributable to a real format choice.
 */
export async function loadFormatOutcomes(
  brokerageId: string,
  client?: Svc,
): Promise<ScoredFormats> {
  if (!brokerageId) return { cells: {}, maxMeanSignal: 0 }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc: Svc = client ?? createServiceClient()

  // 1. The Director-staged projects for this tenant (read-only, tenant-scoped).
  const { data: projects } = await svc
    .from("ai_video_projects")
    .select("id, video_type, video_url, video_metadata")
    .eq("brokerage_id", brokerageId)
    .not("video_metadata", "is", null)
    .limit(2000)

  const rows: VideoOutcomeRow[] = []
  for (const p of (projects ?? []) as Array<{
    video_type: string | null
    video_url: string | null
    video_metadata: Record<string, unknown> | null
  }>) {
    const meta = p.video_metadata ?? {}
    const compositionId = typeof meta.composition_id === "string" ? meta.composition_id : null
    if (!compositionId) continue // only the Director's staged rows carry this stamp.

    const channels = Array.isArray(meta.target_channels) ? (meta.target_channels as string[]) : []
    const channel = (channels[0] ?? "unknown")
    const mood = typeof meta.music_mood === "string" ? meta.music_mood : "none"
    const qrCodeId = typeof meta.qr_code_id === "string" ? meta.qr_code_id : null

    // (a) Real QR scans accrued to this video's stamped qr_code_id.
    let scans = 0
    if (qrCodeId) {
      const { count } = await svc
        .from("qr_scan_events")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
        .eq("qr_code_id", qrCodeId)
      scans = count ?? 0
    }

    // (b) Real social engagement — the same attribution loadVideoPerformance uses:
    //     posts whose media_urls contains this row's video_url.
    let engagement = 0
    if (p.video_url) {
      const { data: posts } = await svc
        .from("social_posts")
        .select("engagement_data")
        .eq("brokerage_id", brokerageId)
        .contains("media_urls", [p.video_url])
      for (const post of (posts ?? []) as Array<{ engagement_data: Record<string, number> | null }>) {
        const m = post.engagement_data ?? {}
        engagement += (m.views || 0) + (m.engagement || 0) + (m.comments || 0) + (m.shares || 0)
      }
    }

    rows.push({
      kind: rowKind(p.video_type),
      channel,
      compositionId,
      mood,
      scans,
      engagement,
    })
  }

  return scoreFormatOutcomes(rows)
}
