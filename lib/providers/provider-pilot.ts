// lib/providers/provider-pilot.ts
//
// THE 2,400-CANDIDATE MATCHED PILOT — DESIGN AS AN EXECUTABLE SIMULATION (wave 150, lane 150HIAB — contract C39, owner
// ruling R9, directive canary 9). It runs over a supabase-shaped client the caller hands it (an in-memory one in the
// proof), READS ONLY, and never reaches a vendor: there is no transport in this file, every provider answer comes from
// the caller's `simulate` function, and the result says `paidCalls: 0` / `liveCalls: 0` because none can happen.
//
// C39 pilot design, as the owner wrote it: "2,400 matched candidates (600 consented inbound / 600 owners missing
// right-party contact / 600 independently evidenced possible sellers / 600 controls) across solo, team, office,
// multi-office; sandbox / no-cost first; identical input cohort; per-field new coverage, right-party verified contact,
// seller-score lift over the public-property baseline, suppression, freshness, 30/90-day outcomes, true marginal cost,
// cost per newly usable legally eligible person / qualified appointment; holdouts and provenance. 50k/month is a
// SIMULATION target." Directive: "Never rank DataZapp score's 4x labels numerically as Tracerfy 0–100; calibrate both
// against observed results." A proposed PAID pilot cap of $1,000 is NOT approved (spec): this file cannot spend.
//
// What it decides: whether the cohort is a valid matched design (deduplicated, balanced per stratum × tenant shape), and
// — given simulated answers — the per-arm scorecard. What it never decides: activation. activationVerdict stays false for
// every provider whose licence is unknown, and the simulation runs anyway (licence unknown blocks ACTIVATION, not offline
// testing).

import { planProviderWaterfall, activationVerdict, labelSellerSignal, compareSellerSignals, PROVIDER_FIELD_SCORECARD, type ScoreField, type ScorecardProvider, type SellerSignalName } from "@/lib/providers/provider-scorecard"
import { mapDormantProviderResponse, type DormantProduct } from "@/lib/providers/dormant-adapters"

type PilotStratum = "consented_inbound" | "owner_missing_contact" | "evidenced_possible_seller" | "control"
type TenantShape = "solo" | "team" | "office" | "multi_office"
const PILOT_STRATA: readonly PilotStratum[] = ["consented_inbound", "owner_missing_contact", "evidenced_possible_seller", "control"]
const TENANT_SHAPES: readonly TenantShape[] = ["solo", "team", "office", "multi_office"]
const PER_STRATUM = 600
const PER_CELL = PER_STRATUM / TENANT_SHAPES.length // 150 per stratum × tenant shape
/** 50,000 records a month is a SIMULATION target (directive) — arithmetic only, never a request size. */
const SIMULATED_MONTHLY_RECORDS = 50_000

/** The matched pair R9 names; each non-control candidate is the IDENTICAL input to both arms. */
const PILOT_ARMS: readonly ScorecardProvider[] = ["tracerfy", "datazapp"]
const ARM_SELLER_FIELD: Readonly<Partial<Record<ScorecardProvider, SellerSignalName>>> = Object.freeze({
  tracerfy: "tracerfy_lead_builder_seller_score",
  datazapp: "datazapp_signal_seller_score",
})

interface PilotCandidate {
  rawId: string
  brokerageId: string
  tenantShape: TenantShape
  stratum: PilotStratum
  identityKey: string
  missing: ScoreField[]
  /** Already contacted / suppressed records are never counted as newly usable. */
  suppressed: boolean
  /** Consented inbound only: the right-party contact we already hold, to verify a provider's answer against. */
  truth: { phone: string | null; email: string | null } | null
  /** The public-property baseline signal (e.g. absentee / tax-delinquent from public facts) — the lift's reference. */
  publicBaseline: boolean
  /** Simulated outcomes (qualified appointment — an appointment is not a closing). */
  outcome30: boolean
  outcome90: boolean
}

/** What a simulated provider answers for one candidate (the caller's deterministic fake — never a live call). */
export interface SimulatedAnswer { hit: boolean; phone?: string | null; email?: string | null; dnc?: boolean; sellerValue?: number | string | null; retries?: number; ageDays?: number | null }

interface ArmScore {
  provider: ScorecardProvider
  attempted: number
  calls: number
  hits: number
  perFieldNewCoverage: Partial<Record<ScoreField, number>>
  rightPartyVerified: { checked: number; verified: number }
  newlyUsableEligible: number
  suppressedExcluded: number
  medianAgeDays: number | null
  simulatedCostUsd: number
  costPerNewlyUsable: number | null
  sellerSignal: { field: SellerSignalName | null; labelled: number; refused: number; topBucketOutcome90: number | null; baselineOutcome90: number | null; lift: number | null; why: string }
  outcomes: { appt30: number; appt90: number }
  costPerQualifiedAppointment: number | null
}

export interface PilotScorecard {
  valid: boolean
  designProblems: string[]
  cohort: { candidates: number; duplicatesDropped: number; perCell: Record<string, number> }
  holdout: { candidates: number; appt30: number; appt90: number }
  arms: ArmScore[]
  /** Seller signals are compared WITHIN a provider's own unit only. */
  crossProviderRanking: null
  activation: Array<{ provider: ScorecardProvider; mayActivate: boolean; blockers: string[] }>
  projection: { monthlyRecords: number; costUsdByArm: Record<string, number | null>; basis: "SIMULATION" }
  paidCalls: 0
  liveCalls: 0
  blindSpots: string[]
}

function identityKeyOf(r: { first_name?: string | null; last_name?: string | null; address?: string | null; zip_code?: string | null }): string {
  const n = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
  return `${n(r.first_name)}|${n(r.last_name)}|${n(r.address)}|${n(r.zip_code)}`
}

/** The lowest value of each field's TOP bucket, in the vendor's own documented order. Absent = no documented order. */
const TOP_BUCKET_FLOOR: Readonly<Partial<Record<SellerSignalName, string>>> = Object.freeze({ datazapp_signal_seller_score: "3x" })

/**
 * Top bucket in a provider's OWN documented order — ordered by compareSellerSignals against the floor labelled in the SAME
 * field, so the order is the scorecard's one definition; an undocumented scale has none (lift needs calibration first).
 */
function inTopBucket(field: SellerSignalName, value: number | string): boolean | null {
  const floor = TOP_BUCKET_FLOOR[field]
  if (floor === undefined) return null
  const at = "1970-01-01T00:00:00.000Z"
  const a = labelSellerSignal(field, value, at), f = labelSellerSignal(field, floor, at)
  if (!a.ok || !f.ok) return null
  const c = compareSellerSignals(a.signal, f.signal)
  return c === null ? null : c >= 0
}

/** PURE — a recorded documented-shape response → the answer the pilot scores. The dormant mappers map NO contact
 *  fields (Tracerfy documents only hit / credits; DataZapp's per-row email key is undocumented), so a replayed answer can
 *  only carry the hit and a labelled seller signal — a replay never invents a phone or an email. */
function answerFromRecorded(product: DormantProduct, raw: unknown, at: string): SimulatedAnswer {
  const mapped = mapDormantProviderResponse(product, raw, at)
  return { hit: mapped.billing.hit === true, phone: null, email: null, sellerValue: mapped.sellerSignals[0]?.value ?? null }
}

/**
 * THE SIMULATION. Reads the cohort from `raw_scraped_leads` rows whose `evidence.pilot` names the stratum, tenant shape,
 * the fields missing, suppression, the consented truth, the public baseline and the simulated outcomes; validates the
 * matched design; runs both arms over the identical input; scores them. Writes nothing.
 * @proofSeam the C39 pilot is a DESIGN executed on an in-memory client by scripts/provider-scorecard-guard.ts — no
 * product surface runs a pilot until the owner approves a no-cost sandbox or a bounded paid test
 */
export async function simulateProviderPilot(
  svc: { from: (t: string) => any },
  deps: {
    simulate: (provider: ScorecardProvider, c: Readonly<PilotCandidate>) => SimulatedAnswer
    now: Date
    /** A RECORDED documented-shape response (a sandbox / mock reply the owner saved — never a live call) for this
     *  candidate: it is replayed through the dormant mapper (documented fields only), so the pilot scores what the
     *  provider's own response shape would yield. Absent or null → `simulate` answers. */
    replay?: (provider: ScorecardProvider, c: Readonly<PilotCandidate>) => { product: DormantProduct; raw: unknown } | null
  },
): Promise<PilotScorecard> {
  const designProblems: string[] = []
  const blindSpots: string[] = [
    "outcomes are SIMULATED fixtures — real 30/90-day appointment outcomes need the live cohort",
    "the providers' answers are the caller's deterministic fakes — they prove the scoring, not the data",
    "Tracerfy's seller-score scale is undocumented: its lift is not computed until it is calibrated against outcomes",
  ]
  const { data, error } = await svc.from("raw_scraped_leads").select("id, brokerage_id, first_name, last_name, address, zip_code, evidence")
  if (error) {
    return { valid: false, designProblems: [`cohort read refused: ${error.message}`], cohort: { candidates: 0, duplicatesDropped: 0, perCell: {} }, holdout: { candidates: 0, appt30: 0, appt90: 0 }, arms: [], crossProviderRanking: null, activation: [], projection: { monthlyRecords: SIMULATED_MONTHLY_RECORDS, costUsdByArm: {}, basis: "SIMULATION" }, paidCalls: 0, liveCalls: 0, blindSpots }
  }
  // C36 dedup: one candidate per identity (name + address + ZIP); a repeat is dropped, never double-counted.
  const seen = new Set<string>()
  let duplicatesDropped = 0
  const cohort: PilotCandidate[] = []
  for (const r of (data ?? []) as Array<Record<string, any>>) {
    const p = r?.evidence?.pilot
    if (!p || !PILOT_STRATA.includes(p.stratum) || !TENANT_SHAPES.includes(p.tenantShape) || !r.brokerage_id) continue
    const key = identityKeyOf(r)
    if (seen.has(key)) { duplicatesDropped++; continue }
    seen.add(key)
    cohort.push({
      rawId: String(r.id), brokerageId: String(r.brokerage_id), tenantShape: p.tenantShape, stratum: p.stratum, identityKey: key,
      missing: Array.isArray(p.missing) ? p.missing : [], suppressed: p.suppressed === true,
      truth: p.stratum === "consented_inbound" && p.truth ? { phone: p.truth.phone ?? null, email: p.truth.email ?? null } : null,
      publicBaseline: p.publicBaseline === true, outcome30: p.outcome30 === true, outcome90: p.outcome90 === true,
    })
  }
  const perCell: Record<string, number> = {}
  for (const s of PILOT_STRATA) for (const t of TENANT_SHAPES) perCell[`${s}×${t}`] = cohort.filter((c) => c.stratum === s && c.tenantShape === t).length
  for (const [cell, n] of Object.entries(perCell)) if (n !== PER_CELL) designProblems.push(`${cell}: ${n} candidates (the matched design needs ${PER_CELL})`)
  if (cohort.length !== PER_STRATUM * PILOT_STRATA.length) designProblems.push(`cohort is ${cohort.length} deduplicated candidates (the design needs ${PER_STRATUM * PILOT_STRATA.length})`)

  const control = cohort.filter((c) => c.stratum === "control")
  const treated = cohort.filter((c) => c.stratum !== "control")
  const rate = (xs: PilotCandidate[], f: (c: PilotCandidate) => boolean) => (xs.length === 0 ? null : Math.round((xs.filter(f).length / xs.length) * 1000) / 1000)
  const at = deps.now.toISOString()

  const arms: ArmScore[] = PILOT_ARMS.map((provider) => {
    const sellerField = ARM_SELLER_FIELD[provider] ?? null
    const arm: ArmScore = {
      provider, attempted: 0, calls: 0, hits: 0, perFieldNewCoverage: {}, rightPartyVerified: { checked: 0, verified: 0 }, newlyUsableEligible: 0,
      suppressedExcluded: 0, medianAgeDays: null, simulatedCostUsd: 0, costPerNewlyUsable: null,
      sellerSignal: { field: sellerField, labelled: 0, refused: 0, topBucketOutcome90: null, baselineOutcome90: null, lift: null, why: "" },
      outcomes: { appt30: 0, appt90: 0 }, costPerQualifiedAppointment: null,
    }
    const ages: number[] = []
    const top: PilotCandidate[] = []
    for (const c of treated) {
      arm.attempted++
      // Ask only for what is missing, through the ONE waterfall, in OFFLINE mode (the dormant arm is offline-only).
      const plan = planProviderWaterfall({ capability: "owner_contact", missingFields: c.missing, mode: "offline_simulation" })
      const step = plan.steps.find((s) => s.provider === provider)
      const wantsScore = c.stratum === "evidenced_possible_seller" && sellerField !== null
      if (!step && !wantsScore) continue
      if (step && step.mayCallLive) designProblems.push(`${provider} planned as live-callable — a pilot arm must be offline`)
      const recorded = deps.replay?.(provider, c) ?? null
      const a: SimulatedAnswer = recorded ? answerFromRecorded(recorded.product, recorded.raw, at) : deps.simulate(provider, c)
      arm.calls++
      const retries = Math.max(0, a.retries ?? 0)
      // True marginal cost: per-match products bill hits only; retries and per-record products bill every attempt.
      const contactRow = PROVIDER_FIELD_SCORECARD.find((r) => r.provider === provider && r.capability === "owner_contact")
      if (step && contactRow?.unitUsd != null) arm.simulatedCostUsd += contactRow.unit === "per_match" ? (a.hit ? contactRow.unitUsd : 0) : contactRow.unitUsd * (1 + retries)
      const scoreRow = PROVIDER_FIELD_SCORECARD.find((r) => r.provider === provider && r.capability === "seller_signal_score")
      if (wantsScore && scoreRow?.unitUsd != null) arm.simulatedCostUsd += scoreRow.unitUsd
      if (a.hit) arm.hits++
      if (typeof a.ageDays === "number") ages.push(a.ageDays)
      const filled: ScoreField[] = []
      if (c.missing.includes("owner_phone") && a.phone) filled.push("owner_phone")
      if (c.missing.includes("owner_email") && a.email) filled.push("owner_email")
      for (const f of filled) arm.perFieldNewCoverage[f] = (arm.perFieldNewCoverage[f] ?? 0) + 1
      if (c.truth) {
        arm.rightPartyVerified.checked++
        if ((a.phone && a.phone === c.truth.phone) || (a.email && a.email === c.truth.email)) arm.rightPartyVerified.verified++
      }
      const usable = filled.length > 0 && !(filled.length === 1 && filled[0] === "owner_phone" && a.dnc === true)
      if (usable && c.suppressed) arm.suppressedExcluded++
      else if (usable) {
        arm.newlyUsableEligible++
        if (c.outcome30) arm.outcomes.appt30++
        if (c.outcome90) arm.outcomes.appt90++
      }
      if (wantsScore && sellerField && a.sellerValue !== undefined && a.sellerValue !== null) {
        const l = labelSellerSignal(sellerField, a.sellerValue, at)
        if (!l.ok) arm.sellerSignal.refused++
        else {
          arm.sellerSignal.labelled++
          if (inTopBucket(sellerField, l.signal.value) === true) top.push(c)
        }
      }
    }
    arm.simulatedCostUsd = Math.round(arm.simulatedCostUsd * 100) / 100
    ages.sort((x, y) => x - y)
    arm.medianAgeDays = ages.length ? ages[Math.floor(ages.length / 2)] : null
    arm.costPerNewlyUsable = arm.newlyUsableEligible > 0 ? Math.round((arm.simulatedCostUsd / arm.newlyUsableEligible) * 100) / 100 : null
    arm.costPerQualifiedAppointment = arm.outcomes.appt90 > 0 ? Math.round((arm.simulatedCostUsd / arm.outcomes.appt90) * 100) / 100 : null
    const sellers = treated.filter((c) => c.stratum === "evidenced_possible_seller")
    const baseline = rate(sellers.filter((c) => c.publicBaseline), (c) => c.outcome90)
    arm.sellerSignal.baselineOutcome90 = baseline
    if (!sellerField || inTopBucket(sellerField, "4x") === null) {
      arm.sellerSignal.why = `${sellerField}: the vendor scale is undocumented — no top bucket, no lift until calibrated against outcomes`
    } else {
      const topRate = rate(top, (c) => c.outcome90)
      arm.sellerSignal.topBucketOutcome90 = topRate
      arm.sellerSignal.lift = topRate !== null && baseline !== null ? Math.round((topRate - baseline) * 1000) / 1000 : null
      arm.sellerSignal.why = `${sellerField}: 90-day appointment rate in the vendor's own top labels (3x–4x) minus the public-property baseline — an observed difference in this cohort, not a probability`
    }
    return arm
  })

  const costPerAttempt = (a: ArmScore) => (a.attempted > 0 ? a.simulatedCostUsd / a.attempted : null)
  return {
    valid: designProblems.length === 0,
    designProblems,
    cohort: { candidates: cohort.length, duplicatesDropped, perCell },
    holdout: { candidates: control.length, appt30: control.filter((c) => c.outcome30).length, appt90: control.filter((c) => c.outcome90).length },
    arms,
    crossProviderRanking: null,
    activation: PILOT_ARMS.map((p) => { const v = activationVerdict(p); return { provider: p, mayActivate: v.mayActivate, blockers: v.blockers } }),
    projection: {
      monthlyRecords: SIMULATED_MONTHLY_RECORDS,
      costUsdByArm: Object.fromEntries(arms.map((a) => { const c = costPerAttempt(a); return [a.provider, c === null ? null : Math.round(c * SIMULATED_MONTHLY_RECORDS * 100) / 100] })),
      basis: "SIMULATION",
    },
    paidCalls: 0,
    liveCalls: 0,
    blindSpots,
  }
}
