// lib/external/batchdata-batchrank.ts
//
// OPTIONAL BatchRank ranking seam (wave 68, owner ruling — RESEARCHED at batchdata.io/
// buy-box-api + batchdata.io/batchrank, 2026-09-16): a Buy Box takes ONE property and
// returns the INVESTORS likely to buy it (what runBuyBoxMatchingForMarket already uses to
// find buyer LEADS for our listings — a DIFFERENT capability, not this one). BatchRank is
// an AI sale-propensity score PER PROPERTY (High/Medium/Low or numeric), custom-priced,
// contact-sales-only — so the investor's portal buy-box maps to plain Property Search
// FILTERS (see fetchIncrementalPropertySearch), and BatchRank is an OPTIONAL add-on
// ranking layer on top of those candidates, never the source of the candidates themselves.
//
// FAIL CLOSED BY DEFAULT: unless BOTH `BATCHDATA_BATCHRANK_ENABLED=true` AND a BatchRank
// search token is provisioned (the "batchrank" purpose on
// lib/external/batchdata-tokens.ts::resolveBatchDataToken), this returns every candidate
// UNCHANGED with `{ ranked: false, reason }` — never a fabricated score, never a thrown
// error into the caller. Document in .env.example: BatchRank is custom-priced; contact
// BatchData sales before turning this on.

import { resolveBatchDataToken } from "@/lib/external/batchdata-tokens"

export interface BatchRankCandidate {
  addressKey: string
  address?: string | null
}

export interface BatchRankedCandidate extends BatchRankCandidate {
  batchrankScore: number | null
  batchrankBand: "high" | "medium" | "low" | null
}

export interface RankCandidatesWithBatchRankResult {
  ranked: boolean
  reason: string | null
  candidates: BatchRankedCandidate[]
}

const BATCHRANK_ENABLED_ENV = "BATCHDATA_BATCHRANK_ENABLED"

/** PURE, module-private: a raw BatchRank score/band pair (whatever the provider returns) →
 *  our two-column shape. A numeric score is bucketed High/Medium/Low on the documented
 *  thresholds; a band string passed straight through is normalized to our lowercase
 *  vocabulary. The ONE caller is rankCandidatesWithBatchRank below, in this same file. */
function normalizeBatchRankVerdict(raw: { score?: number | null; band?: string | null }): {
  batchrankScore: number | null
  batchrankBand: "high" | "medium" | "low" | null
} {
  const score = typeof raw.score === "number" && Number.isFinite(raw.score) ? raw.score : null
  let band: "high" | "medium" | "low" | null = null
  if (typeof raw.band === "string") {
    const b = raw.band.trim().toLowerCase()
    if (b === "high" || b === "medium" || b === "low") band = b
  }
  if (!band && score != null) {
    band = score >= 70 ? "high" : score >= 40 ? "medium" : "low"
  }
  return { batchrankScore: score, batchrankBand: band }
}

/**
 * Rank off-market candidates with BatchData's BatchRank sale-propensity score. FAIL CLOSED:
 * returns candidates unchanged (ranked:false) unless the feature flag is on AND a
 * "batchrank" token is provisioned. Never throws — a per-candidate provider failure leaves
 * that candidate's score/band null rather than aborting the whole batch.
 */
export async function rankCandidatesWithBatchRank(
  candidates: readonly BatchRankCandidate[],
): Promise<RankCandidatesWithBatchRankResult> {
  const unchanged = (reason: string): RankCandidatesWithBatchRankResult => ({
    ranked: false,
    reason,
    candidates: candidates.map((c) => ({ ...c, batchrankScore: null, batchrankBand: null })),
  })

  if (process.env[BATCHRANK_ENABLED_ENV] !== "true") {
    return unchanged(`BatchRank is disabled (set ${BATCHRANK_ENABLED_ENV}=true to enable — custom-priced, contact BatchData sales first)`)
  }
  const token = resolveBatchDataToken("batchrank")
  if (!token) {
    return unchanged("No BatchRank search token provisioned (set BATCHDATA_BATCHRANK_TOKEN)")
  }
  if (candidates.length === 0) return { ranked: true, reason: null, candidates: [] }

  try {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    const out: BatchRankedCandidate[] = []
    for (const c of candidates) {
      if (!c.address) { out.push({ ...c, batchrankScore: null, batchrankBand: null }); continue }
      try {
        const res = await callConnector<any>({
          connector: "batchdata_batchrank",
          baseUrl: "https://api.batchdata.com/api/v1",
          path: "property/search",
          method: "POST",
          auth: { style: "bearer", token },
          body: { searchCriteria: { query: c.address }, options: { take: 1, skip: 0 }, datasets: ["batchrank"] },
        })
        const row = res.ok ? (res.data?.results?.properties?.[0] ?? res.data?.results?.[0] ?? null) : null
        const rank = row?.batchRank ?? row?.batchrank ?? null
        out.push({ ...c, ...normalizeBatchRankVerdict({ score: rank?.score, band: rank?.band }) })
      } catch {
        out.push({ ...c, batchrankScore: null, batchrankBand: null })
      }
    }
    return { ranked: true, reason: null, candidates: out }
  } catch (e) {
    return unchanged(`BatchRank call failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
