// lib/kernel/deal-play-outcomes.ts
// ─────────────────────────────────────────────────────────────────────────────
// DEAL PLAY → OUTCOMES LEARNING LOOP — does the AI-team play actually move
// listings? Compares PLAYED listings (a deal_play_prep_ready signal exists for
// the listing) against same-tenant CONTROL listings on:
//   1. days-to-under-contract  = transactions.contract_date − listings.go_live_date
//      (medians — robust on small N; censored listings are EXCLUDED, never imputed)
//   2. engagement              = listing_metrics views+saves+inquiries+showings
// HONESTY (mirrors lib/video/format-learning.ts): a lift is claimed ONLY when
// both cohorts clear MIN_COHORT contracted listings AND the played median beats
// control by a clear margin; below that the tile says "still learning" with the
// real Ns. Observational, not randomized — the why-string says so (agents may
// run the play on already-hot listings).

export const MIN_COHORT = 10
/** Played median must beat control by max(2 days, 10% of control) to claim lift. */
export const DAYS_MARGIN_FLOOR = 2
export const DAYS_MARGIN_PCT = 0.1

export interface OutcomeRow {
  played: boolean
  /** contract_date − market start, in days; null when not (yet) under contract. */
  daysToContract: number | null
  /** views+saves+inquiries+showings from listing_metrics (null = no metrics row). */
  engagement: number | null
}

export interface DealPlayLift {
  verdict: "lift" | "no_lift" | "insufficient"
  why: string
  playedContracted: number
  controlContracted: number
  playedMedianDays: number | null
  controlMedianDays: number | null
  playedMedianEngagement: number | null
  controlMedianEngagement: number | null
  playedTotal: number
  controlTotal: number
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** PURE: fold outcome rows into the honest lift verdict. */
export function scoreDealPlayOutcomes(rows: OutcomeRow[]): DealPlayLift {
  const played = rows.filter((r) => r.played)
  const control = rows.filter((r) => !r.played)
  const pDays = played.map((r) => r.daysToContract).filter((d): d is number => d != null && d >= 0)
  const cDays = control.map((r) => r.daysToContract).filter((d): d is number => d != null && d >= 0)
  const pEng = played.map((r) => r.engagement).filter((e): e is number => e != null)
  const cEng = control.map((r) => r.engagement).filter((e): e is number => e != null)

  const base: Omit<DealPlayLift, "verdict" | "why"> = {
    playedContracted: pDays.length,
    controlContracted: cDays.length,
    playedMedianDays: median(pDays),
    controlMedianDays: median(cDays),
    playedMedianEngagement: median(pEng),
    controlMedianEngagement: median(cEng),
    playedTotal: played.length,
    controlTotal: control.length,
  }

  if (pDays.length < MIN_COHORT || cDays.length < MIN_COHORT) {
    return {
      ...base, verdict: "insufficient",
      why: `Still learning — ${pDays.length} played / ${cDays.length} control listings under contract; ` +
        `need ≥${MIN_COHORT} in each before a trustworthy read. No claim made from thin data.`,
    }
  }

  const pMed = base.playedMedianDays!
  const cMed = base.controlMedianDays!
  const margin = Math.max(DAYS_MARGIN_FLOOR, cMed * DAYS_MARGIN_PCT)
  if (pMed <= cMed - margin) {
    return {
      ...base, verdict: "lift",
      why: `Played listings reached contract in a median of ${pMed} days vs ${cMed} for control ` +
        `(${pDays.length}/${cDays.length} contracted; margin cleared). Observational — not a randomized test; ` +
        `agents may run the play on stronger listings.`,
    }
  }
  return {
    ...base, verdict: "no_lift",
    why: `No clear lift yet: played median ${pMed} days vs control ${cMed} (needs ≥${margin.toFixed(1)}-day gap; ` +
      `${pDays.length}/${cDays.length} contracted). Counts reported, no claim invented.`,
  }
}

/** Load + score for one tenant. Read-only. */
export async function loadDealPlayLift(svc: any, brokerageId: string): Promise<DealPlayLift> {
  const [{ data: playedSignals }, { data: listings }] = await Promise.all([
    svc.from("manager_signals").select("entity_id")
      .eq("brokerage_id", brokerageId).eq("signal_type", "deal_play_prep_ready").limit(2000),
    svc.from("listings").select("id, status, go_live_date, listing_date, created_at")
      .eq("brokerage_id", brokerageId)
      .in("status", ["coming_soon", "active", "pending", "sold"]).limit(2000),
  ])
  const playedIds = new Set(((playedSignals ?? []) as any[]).map((s) => s.entity_id).filter(Boolean))
  const listingRows = (listings ?? []) as any[]
  const ids = listingRows.map((l) => l.id)

  const [{ data: txns }, { data: metrics }] = ids.length
    ? await Promise.all([
        svc.from("transactions").select("listing_id, contract_date").in("listing_id", ids).not("contract_date", "is", null).limit(2000),
        svc.from("listing_metrics").select("listing_id, views, saves, inquiries, showings").in("listing_id", ids).limit(2000),
      ])
    : [{ data: [] }, { data: [] }]

  const contractByListing = new Map<string, string>()
  for (const t of (txns ?? []) as any[]) {
    if (t.listing_id && (!contractByListing.has(t.listing_id) || t.contract_date < contractByListing.get(t.listing_id)!)) {
      contractByListing.set(t.listing_id, t.contract_date)
    }
  }
  const engByListing = new Map<string, number>()
  for (const m of (metrics ?? []) as any[]) {
    engByListing.set(m.listing_id, Number(m.views ?? 0) + Number(m.saves ?? 0) + Number(m.inquiries ?? 0) + Number(m.showings ?? 0))
  }

  const rows: OutcomeRow[] = listingRows.map((l) => {
    const start = l.go_live_date ?? l.listing_date ?? l.created_at
    const contract = contractByListing.get(l.id)
    const daysToContract = start && contract
      ? Math.round((new Date(contract).getTime() - new Date(start).getTime()) / 86_400_000)
      : null
    return {
      played: playedIds.has(l.id),
      daysToContract: daysToContract != null && daysToContract >= 0 ? daysToContract : null,
      engagement: engByListing.get(l.id) ?? null,
    }
  })
  return scoreDealPlayOutcomes(rows)
}
