// lib/video/living-video.ts
// ─────────────────────────────────────────────────────────────────────────────
// SELF-UPDATING VIDEO — the pure core.
//
// A living video is one whose CONTENT is a claim about facts that move: "three
// showings this week", "listed at $545,000", "your equity is $180,000". Every
// other CRM ships that as a static file that starts rotting the moment it
// renders. This makes the video a function of the facts, and re-renders it when
// the facts stop matching.
//
// WHAT THE AUDIT FOUND, and why this is a fix rather than a feature:
// requestSellerUpdateReel is gated by a SEVEN-DAY idempotency window — one
// render per listing per week, full stop. So a price drop on Tuesday reaches the
// seller the following Monday, in a video that opens by telling them the old
// price. The OS is currently designed NOT to update. The cadence is not wrong;
// it is just blind to events, and a fact-keyed refresh is what makes it see.
//
// ── WHY NOT frame_key? ──────────────────────────────────────────────────────
// The render cache's frame_key is a hash of ALL input props, which is right for
// "may I reuse this file" and wrong for "is this video out of date". Props carry
// cosmetics — a QR data URL, the listing photo array, the agent's phone string —
// and a video does not become stale because someone reordered two photos. Using
// frame_key as the oracle would churn renders and, worse, re-send video to
// clients for no reason. The facts key is deliberately NARROW: only the fields a
// human would call the point of the video.
//
// ── MATERIALITY: not every change deserves a re-render ──────────────────────
// This is the judgment that separates useful from annoying. daysOnMarket ticks
// every single day and videoScans tick on every scan; keying on those would
// re-render daily forever and mail a client a fresh video about nothing. Each
// fact therefore declares WHY it matters, and immaterial facts are recorded (so
// the diff is legible) but never trigger anything.
//
// PURE — no I/O. Fact providers live in living-video-sweep.ts.

import { canonicalJson } from "@/lib/remotion/composition-cache"
import { createHash } from "node:crypto"

export type LivingFactValue = string | number | boolean | null
export type LivingFacts = Record<string, LivingFactValue>

/**
 * How much a fact has to move before the video is worth remaking.
 *
 *   "always"        any change at all is material (a price, a status, the face
 *                   fronting the video).
 *   {atLeast: n}    numeric, and only material once it moves by n or more.
 *   "never"         tracked for the diff and for a human reading it, but never
 *                   on its own a reason to re-render or re-send.
 */
export type Materiality = "always" | "never" | { atLeast: number }

export interface LivingFactSpec {
  /** Human name, used in the sentence a manager reads. */
  label: string
  materiality: Materiality
  /** Why this rule — so the next reader does not "tidy" it into churn. */
  why: string
}

export interface LivingKindSpec {
  /** Stable key, stamped onto the render row as living_kind. */
  kind: string
  label: string
  /** The composition this kind renders through. */
  compositionId: string
  /** What the render row's entity_type will be. */
  entityType: string
  facts: Record<string, LivingFactSpec>
}

/**
 * The living kinds. One entry per video that is a claim about moving facts.
 *
 * Deliberately small. A kind belongs here only when (a) its facts genuinely
 * move, (b) a provider can re-derive them cheaply without side effects, and
 * (c) a client would actually want the newer cut.
 */
export const LIVING_KINDS: Record<string, LivingKindSpec> = {
  seller_weekly_update: {
    kind: "seller_weekly_update",
    label: "Seller weekly update",
    compositionId: "AgentTalkingHeadReel",
    entityType: "contact",
    facts: {
      listPrice: {
        label: "list price",
        materiality: "always",
        why:
          "The single most important number in the video, and the one a seller " +
          "will notice is wrong. A price change mid-week is exactly the event " +
          "the seven-day window used to swallow.",
      },
      showingsThisWeek: {
        label: "showings this week",
        materiality: "always",
        why:
          "Showings are rare enough that every one is news. 0 → 1 is the " +
          "difference between an anxious seller and a reassured one.",
      },
      interestLabel: {
        label: "buyer interest",
        materiality: "always",
        why: "A qualitative read the seller acts on; it only changes when something real did.",
      },
      avatarId: {
        label: "the agent's avatar",
        materiality: "always",
        why:
          "The agent onboards by recording an avatar from a photo or video, and " +
          "it lands in our own storage bucket. When they re-record it, every " +
          "living video is still fronted by the old face until it re-renders — " +
          "so the avatar is a fact about the video, not a setting beside it.",
      },
      listingAddress: {
        label: "the listing address",
        materiality: "always",
        why: "If this moved, the video is about the wrong property.",
      },
      daysOnMarket: {
        label: "days on market",
        materiality: "never",
        why:
          "Increments every single day. Material-by-default here would re-render " +
          "and re-send this video DAILY, forever, about nothing. The weekly " +
          "cadence already refreshes it; this field rides along for the diff.",
      },
      videoScans: {
        label: "video scans",
        materiality: { atLeast: 25 },
        why:
          "A counter that ticks on every scan. One more scan is not news; a jump " +
          "of 25 means the marketing genuinely broke through and the seller " +
          "should hear the new number.",
      },
    },
  },
}

export function livingKind(kind: string): LivingKindSpec | null {
  return LIVING_KINDS[kind] ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// The key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Identity of the FACTS a living video asserts.
 *
 * Only declared facts are hashed, and unknown keys are dropped rather than
 * silently widening the key — a provider that starts returning an extra field
 * must not invalidate every existing video by accident.
 */
export function computeFactsKey(kind: string, facts: LivingFacts): string {
  const spec = LIVING_KINDS[kind]
  const declared = spec ? Object.keys(spec.facts).sort() : Object.keys(facts).sort()
  const projected: LivingFacts = {}
  for (const k of declared) projected[k] = facts[k] ?? null
  const payload = canonicalJson({ k: kind, f: projected })
  return `fx1_${createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 32)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// The diff — what changed, and does it matter
// ─────────────────────────────────────────────────────────────────────────────

export interface FactChange {
  field: string
  label: string
  from: LivingFactValue
  to: LivingFactValue
  /** True when this change on its own justifies remaking the video. */
  material: boolean
}

export function diffLivingFacts(
  kind: string,
  before: LivingFacts,
  after: LivingFacts,
): FactChange[] {
  const spec = LIVING_KINDS[kind]
  if (!spec) return []
  const out: FactChange[] = []
  for (const [field, fs] of Object.entries(spec.facts)) {
    const a = before[field] ?? null
    const b = after[field] ?? null
    if (a === b) continue
    out.push({ field, label: fs.label, from: a, to: b, material: isMaterial(fs.materiality, a, b) })
  }
  return out
}

function isMaterial(m: Materiality, from: LivingFactValue, to: LivingFactValue): boolean {
  if (m === "never") return false
  if (m === "always") return true
  // A threshold only applies to a real numeric move; anything else (null →
  // number, a type change) is treated as material, because we cannot prove it
  // is small and a wrong video is worse than a wasted render.
  if (typeof from === "number" && typeof to === "number") {
    return Math.abs(to - from) >= m.atLeast
  }
  return true
}

/** Does this set of changes justify remaking and re-sending the video? */
export function isStale(changes: FactChange[]): boolean {
  return changes.some((c) => c.material)
}

/**
 * The sentence a human reads. Names the MATERIAL changes — the immaterial ones
 * are in the payload for anyone who wants them, but a manager's inbox should
 * say why this happened, not everything that is true.
 */
export function describeFactChanges(kind: string, changes: FactChange[]): string {
  const spec = LIVING_KINDS[kind]
  const material = changes.filter((c) => c.material)
  if (material.length === 0) return "Nothing material changed."
  const parts = material.slice(0, 4).map((c) => `${c.label} ${fmt(c.from)} → ${fmt(c.to)}`)
  const more = material.length > 4 ? `, and ${material.length - 4} more` : ""
  return `${spec?.label ?? kind} is out of date: ${parts.join(", ")}${more}.`
}

function fmt(v: LivingFactValue): string {
  if (v === null) return "—"
  if (typeof v === "number") return String(v)
  if (typeof v === "boolean") return v ? "yes" : "no"
  // Avatar ids and urls are long and meaningless in a sentence; say the shape.
  if (v.length > 40) return "changed"
  return v
}

/** The signal a stale living video publishes. Catalogued in signal-registry. */
export const LIVING_VIDEO_STALE_SIGNAL = "living_video_stale" as const

export interface LivingRefreshSummary {
  examined: number
  stale: number
  refreshed: number
  /** Renders that were stale but could NOT be requeued — surfaced, never hidden. */
  failed: number
  /** Changes that were detected but deliberately did not trigger anything. */
  immaterialOnly: number
}

export function summarizeRefresh(
  rows: Array<{ changes: FactChange[]; requeued: boolean | null }>,
): LivingRefreshSummary {
  let stale = 0, refreshed = 0, failed = 0, immaterialOnly = 0
  for (const r of rows) {
    if (isStale(r.changes)) {
      stale++
      if (r.requeued === true) refreshed++
      else if (r.requeued === false) failed++
    } else if (r.changes.length > 0) {
      immaterialOnly++
    }
  }
  return { examined: rows.length, stale, refreshed, failed, immaterialOnly }
}
