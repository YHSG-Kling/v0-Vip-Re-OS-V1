// lib/seller-equity/move-readiness.ts
// ─────────────────────────────────────────────────────────────────────────────
// MOVE-READINESS SCORE — the seller's "where do I stand at a glance?" number (Fello's frontier, and
// the RealScout wishlist). Blends the three forces that actually decide whether NOW is a good time to
// list: EQUITY (can they afford to move?), MARKET (is it a seller's market for their home?), and
// ENGAGEMENT (are they actually leaning in?). PURE — takes normalized 0..1 inputs the caller resolves
// from real data (equity ratio, market tightness, engagement), returns a 0..100 score + honest drivers.
// Never a hard "list now!" push — it's a conversation-starter that routes to the agent.

export interface MoveReadinessInput {
  /** 0..1 — equity as a share of value (computeEquityRatio). null when unknown. */
  equityRatio: number | null
  /** 0..1 — how much it's a SELLER'S market for this home: low inventory + rising prices + low DOM. */
  marketTightness: number | null
  /** 0..1 — the homeowner's engagement (portal visits, value-alert opens, replies). null when unknown. */
  engagement: number | null
}

export type MoveReadinessBand = "ready" | "warming" | "early" | "unknown"

export interface MoveReadiness {
  /** 0..100, or null when we have nothing real to score. */
  score: number | null
  band: MoveReadinessBand
  /** The biggest positive + the biggest gap, plain-language, them-first. */
  drivers: string[]
  /** Warm headline + agent-routing line. */
  headline: string
  line: string
}

// Weights — equity matters most (you can't move without it), then market timing, then engagement.
const W_EQUITY = 40, W_MARKET = 35, W_ENGAGE = 25

/** PURE. Compute the move-readiness score from normalized signals. Honest about missing data. */
export function computeMoveReadiness(input: MoveReadinessInput): MoveReadiness {
  const parts: Array<{ key: string; weight: number; value: number; label: string }> = []
  if (input.equityRatio != null) parts.push({ key: "equity", weight: W_EQUITY, value: clamp01(input.equityRatio), label: "Equity" })
  if (input.marketTightness != null) parts.push({ key: "market", weight: W_MARKET, value: clamp01(input.marketTightness), label: "Market timing" })
  if (input.engagement != null) parts.push({ key: "engagement", weight: W_ENGAGE, value: clamp01(input.engagement), label: "Your interest" })

  if (parts.length === 0) {
    return { score: null, band: "unknown", drivers: [],
      headline: "Let's find out where you stand", line: "Your agent can pull your equity and the market for your home in a quick chat." }
  }

  // Weighted average over the signals we actually have (so missing data doesn't tank the score).
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0)
  const score = Math.round((parts.reduce((s, p) => s + p.weight * p.value, 0) / totalWeight) * 100)

  const band: MoveReadinessBand = score >= 70 ? "ready" : score >= 45 ? "warming" : "early"
  const sorted = [...parts].sort((a, b) => b.value - a.value)
  const top = sorted[0], low = sorted[sorted.length - 1]
  const drivers: string[] = []
  if (top) drivers.push(`${top.label} is working in your favor`)
  if (low && low.key !== top?.key && low.value < 0.5) drivers.push(`${low.label} is the piece to firm up`)

  const headline =
    band === "ready" ? "The pieces are lining up"
    : band === "warming" ? "You're getting close"
    : "Worth keeping an eye on"
  const line =
    band === "ready"
      ? "Equity, market, and timing look favorable — your agent can map a plan whenever you're ready."
      : "A few things are still firming up — your agent can show you exactly what would move the needle."

  return { score, band, drivers, headline, line }
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)) }
