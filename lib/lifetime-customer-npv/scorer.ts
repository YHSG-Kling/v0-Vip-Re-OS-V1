/**
 * Lifetime Customer NPV Scorer
 *
 * Computes the projected 5-year referral GCI ("NPV $") for every closed
 * contact, plus a normalized 0-100 score and tier. Replaces the agent's
 * guesswork about who to call this month with a calibrated number.
 *
 * Inputs (all audit-confirmed columns in the live schema):
 *   - contacts.contact_type ('past_client'|'lifetime_customer'|'sphere')
 *   - contacts.engagement_score / intent_score / referral_potential
 *   - contacts.home_value_estimate / equity_estimate / household_income
 *   - contacts.last_contacted_at
 *   - sphere_engagement_scores.score / touchpoints_count / referrals_given /
 *     last_interaction (latest per contact)
 *   - referrals (count + Σ commission_amount where status='converted'
 *     filtered to this agent's contacts)
 *   - lifetime_customer_touchpoints (count of completed touchpoints by
 *     contact_id over last 12 months)
 *   - wealth_advisor_recommendations (any open recs = wealth signal)
 *
 * Outputs:
 *   - 0-100 npv_score (component-weighted)
 *   - 5-year dollar NPV ("you can expect $N over 5 years from this contact")
 *   - tier (platinum / gold / silver / bronze / dormant)
 *   - signals[]  (transparent why-this-score chips)
 *   - recommended_action / cadence / next_touchpoint_due
 *
 * Persisted in lifetime_customer_npv_scores (migration 1036). Drives the
 * NPV-ranked sphere panel on /lifetime-customers and the Income Forecast
 * sphere-contribution input.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

// ─── Tunables (in one place so the model can be refined per brokerage) ────

/** Weight of each component in the final NPV score (sum to 1.0) */
const WEIGHTS = {
  transaction: 0.30,   // past closed deals
  referral:    0.30,   // referrals previously made
  engagement:  0.20,   // recent interactions + touchpoints
  wealth:      0.10,   // home value / equity / wealth signals
  recency:     0.10,   // freshness of last interaction
} as const

/** Average GCI per referral, used to multiply expected referral counts.
 *  Replaced per brokerage when historical referral GCI data is robust. */
const FALLBACK_AVG_REFERRAL_GCI = 8500

/** Projection horizon in years for the NPV $ figure */
const HORIZON_YEARS = 5

/** Annual referral conversion rate by tier (probability that a tier contact
 *  generates ≥1 referral in a year). Calibrated from common industry data. */
const ANNUAL_REFERRAL_RATE: Record<NpvTier, number> = {
  platinum: 1.10,   // > 1: high-value contacts often refer multiple times/year
  gold:     0.50,
  silver:   0.20,
  bronze:   0.07,
  dormant:  0.01,
}

/** Recommended touchpoint cadence by tier */
const CADENCE_DAYS: Record<NpvTier, number> = {
  platinum: 30,
  gold:     60,
  silver:   90,
  bronze:   180,
  dormant:  365,
}

// ─── Types ────────────────────────────────────────────────────────────────

export type NpvTier = "platinum" | "gold" | "silver" | "bronze" | "dormant"

export interface NpvSignal {
  label:   string
  weight:  number
  dollars?: number
}

export interface NpvScoreResult {
  contactId:               string
  brokerageId:             string
  agentId:                 string | null
  npvScore:                number
  npvDollars:              number
  tier:                    NpvTier
  components: {
    transactionHistory:    number
    referralHistory:       number
    engagement:            number
    wealth:                number
    recency:               number
  }
  signals:                 NpvSignal[]
  recommendedAction:       string | null
  recommendedCadence:      string
  nextTouchpointDue:       string  // YYYY-MM-DD
  previousScore:           number | null
  scoreDelta:              number | null
}

// ─── Per-contact compute ──────────────────────────────────────────────────

export async function scoreContactNpv(input: {
  contactId:   string
  brokerageId: string
  /** Average referral GCI specific to this agent/brokerage when available */
  avgReferralGci?: number
}): Promise<NpvScoreResult> {
  const supabase = createServiceClient()
  const avgRefGci = input.avgReferralGci ?? FALLBACK_AVG_REFERRAL_GCI

  // ── Load contact + related signal rows in parallel ───────────────────────
  const [contactRes, sphereRes, referralsRes, touchpointsRes, txnsRes, wealthRes] = await Promise.all([
    supabase.from("contacts")
      .select("id, agent_id, brokerage_id, contact_type, engagement_score, intent_score, referral_potential, home_value_estimate, equity_estimate, household_income, home_owner_status, last_contacted_at, created_at")
      .eq("id", input.contactId)
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle(),
    supabase.from("sphere_engagement_scores")
      .select("score, last_interaction, touchpoints_count, referrals_given")
      .eq("contact_id", input.contactId)
      .order("calculated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from("referrals")
      .select("id, status, commission_amount, commission_potential, value_estimate")
      .eq("brokerage_id", input.brokerageId)
      .or(`referred_contact_id.eq.${input.contactId},source_contact_name.eq.`),
    supabase.from("lifetime_customer_touchpoints")
      .select("id, status, sent_date")
      .eq("contact_id", input.contactId)
      .eq("brokerage_id", input.brokerageId)
      .gte("sent_date", new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)),
    supabase.from("transactions")
      .select("id, purchase_price, commission_amount, estimated_commission, status, close_date")
      .eq("contact_id", input.contactId)
      .eq("brokerage_id", input.brokerageId),
    supabase.from("wealth_advisor_recommendations")
      .select("id, opportunity_type, monthly_savings_estimate, one_time_proceeds_estimate, status")
      .eq("contact_id", input.contactId)
      .eq("brokerage_id", input.brokerageId)
      .in("status", ["new", "pushed", "reviewed", "acknowledged"]),
  ])

  const contact = contactRes.data
  if (!contact) {
    throw new Error(`Contact ${input.contactId} not found in brokerage ${input.brokerageId}`)
  }

  const sphere = sphereRes.data as { score: number | null; last_interaction: string | null; touchpoints_count: number | null; referrals_given: number | null } | null
  const referrals = (referralsRes.data ?? []) as Array<{ id: string; status: string; commission_amount: number | null; commission_potential: number | null; value_estimate: number | null }>
  const touchpoints = (touchpointsRes.data ?? []) as Array<{ id: string; status: string; sent_date: string | null }>
  const closedTxns = ((txnsRes.data ?? []) as Array<{ id: string; commission_amount: number | null; estimated_commission: number | null; status: string }>)
    .filter((t) => t.status === "closed")
  const wealthRecs = (wealthRes.data ?? []) as Array<{ id: string; opportunity_type: string | null; monthly_savings_estimate: number | null; one_time_proceeds_estimate: number | null }>

  const signals: NpvSignal[] = []

  // ── Component 1: Transaction history ───────────────────────────────────
  const closedCount = closedTxns.length
  const totalHistoricGci = closedTxns.reduce(
    (s, t) => s + Number(t.commission_amount ?? t.estimated_commission ?? 0),
    0,
  )
  const transactionHistory =
    closedCount === 0 ? 10 :
    closedCount === 1 ? 50 :
    closedCount === 2 ? 75 :
    closedCount === 3 ? 90 :
                        100
  if (closedCount > 0) signals.push({ label: `${closedCount} closed deal${closedCount === 1 ? "" : "s"}`, weight: WEIGHTS.transaction, dollars: totalHistoricGci })

  // ── Component 2: Referral history ──────────────────────────────────────
  const convertedReferrals = referrals.filter((r) => r.status === "converted" || r.status === "closed")
  const totalReferralGci = convertedReferrals.reduce(
    (s, r) => s + Number(r.commission_amount ?? r.commission_potential ?? r.value_estimate ?? 0),
    0,
  )
  const referralsGiven = Math.max(
    convertedReferrals.length,
    sphere?.referrals_given ?? 0,
  )
  const referralHistory =
    referralsGiven === 0 ? 5 :
    referralsGiven === 1 ? 50 :
    referralsGiven === 2 ? 80 :
                           100
  if (referralsGiven > 0) signals.push({ label: `${referralsGiven} past referral${referralsGiven === 1 ? "" : "s"}`, weight: WEIGHTS.referral, dollars: totalReferralGci })

  // ── Component 3: Engagement ────────────────────────────────────────────
  const sphereScore = Math.min(Math.max(sphere?.score ?? contact.engagement_score ?? 0, 0), 100)
  const completedTouchpoints = touchpoints.filter((t) => t.status === "completed" || t.status === "sent").length
  const touchpointBoost = Math.min(completedTouchpoints * 5, 30)  // up to +30 for 6+ completed
  const engagement = Math.min(sphereScore + touchpointBoost, 100)
  if (completedTouchpoints > 0) signals.push({ label: `${completedTouchpoints} touchpoint${completedTouchpoints === 1 ? "" : "s"} (12 mo)`, weight: WEIGHTS.engagement })

  // ── Component 4: Wealth ────────────────────────────────────────────────
  const homeValue = Number(contact.home_value_estimate ?? 0)
  const equity    = Number(contact.equity_estimate ?? 0)
  let wealthScore = 0
  if (homeValue >= 1_500_000) wealthScore = 100
  else if (homeValue >= 800_000) wealthScore = 75
  else if (homeValue >= 500_000) wealthScore = 55
  else if (homeValue >= 300_000) wealthScore = 35
  else if (homeValue > 0)        wealthScore = 20
  if (equity >= 500_000)         wealthScore = Math.max(wealthScore, 85)
  if (wealthRecs.length > 0)     wealthScore = Math.max(wealthScore, 70)  // active opportunity → wealth signal
  const wealth = wealthScore
  if (homeValue >= 500_000)  signals.push({ label: `Home value ${formatUsd(homeValue)}`, weight: WEIGHTS.wealth, dollars: homeValue })
  if (wealthRecs.length > 0) signals.push({ label: `${wealthRecs.length} open wealth opp${wealthRecs.length === 1 ? "" : "s"}`, weight: WEIGHTS.wealth })

  // ── Component 5: Recency (decay) ───────────────────────────────────────
  const lastInteractionIso = sphere?.last_interaction ?? contact.last_contacted_at ?? contact.created_at
  const daysSince = lastInteractionIso
    ? Math.floor((Date.now() - new Date(lastInteractionIso).getTime()) / 86_400_000)
    : 9999
  const recency =
    daysSince <= 30  ? 100 :
    daysSince <= 60  ? 85  :
    daysSince <= 90  ? 70  :
    daysSince <= 180 ? 50  :
    daysSince <= 365 ? 25  :
                       10
  if (daysSince <= 60)      signals.push({ label: `Engaged ${daysSince}d ago`, weight: WEIGHTS.recency })
  else if (daysSince <= 365) signals.push({ label: `Last touch ${daysSince}d ago`, weight: WEIGHTS.recency })
  else                       signals.push({ label: `Dormant ${daysSince}d`, weight: WEIGHTS.recency })

  // ── Weighted final score ───────────────────────────────────────────────
  const npvScore = Math.round(
    transactionHistory * WEIGHTS.transaction
    + referralHistory  * WEIGHTS.referral
    + engagement       * WEIGHTS.engagement
    + wealth           * WEIGHTS.wealth
    + recency          * WEIGHTS.recency,
  )

  // ── Tier ───────────────────────────────────────────────────────────────
  const tier: NpvTier =
    npvScore >= 85 ? "platinum" :
    npvScore >= 70 ? "gold"     :
    npvScore >= 50 ? "silver"   :
    npvScore >= 25 ? "bronze"   :
                     "dormant"

  // ── 5-year dollar NPV ──────────────────────────────────────────────────
  // Expected referrals/year × avg referral GCI × horizon × engagement adjust
  const annualRate = ANNUAL_REFERRAL_RATE[tier]
  const engagementAdjust = engagement / 100   // 0..1
  const recencyAdjust    = recency / 100      // 0..1
  const npvDollars = Math.round(
    annualRate * avgRefGci * HORIZON_YEARS * Math.max(engagementAdjust * 0.6 + recencyAdjust * 0.4, 0.2),
  )

  // ── Recommended action + cadence + next touchpoint date ───────────────
  const cadenceDays = CADENCE_DAYS[tier]
  const nextTouchpointDue = new Date(
    new Date(lastInteractionIso ?? Date.now()).getTime() + cadenceDays * 86_400_000,
  ).toISOString().slice(0, 10)

  let recommendedAction: string | null = null
  if (tier === "platinum")      recommendedAction = "Send personalized market update + schedule a coffee"
  else if (tier === "gold")     recommendedAction = "Send anniversary card or local market snapshot"
  else if (tier === "silver")   recommendedAction = "Drop a value-add (recipe, local event, holiday card)"
  else if (tier === "bronze")   recommendedAction = "Single light-touch — postcard or social engagement"
  else if (tier === "dormant")  recommendedAction = "Reactivation campaign or remove from active sphere"

  // ── Previous score → delta ─────────────────────────────────────────────
  const { data: prev } = await supabase
    .from("lifetime_customer_npv_scores")
    .select("npv_score")
    .eq("contact_id", input.contactId)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  const previousScore: number | null = prev?.npv_score ?? null
  const scoreDelta = previousScore != null ? npvScore - Number(previousScore) : null

  const result: NpvScoreResult = {
    contactId:   input.contactId,
    brokerageId: input.brokerageId,
    agentId:     (contact.agent_id as string | null) ?? null,
    npvScore,
    npvDollars,
    tier,
    components: {
      transactionHistory,
      referralHistory,
      engagement,
      wealth,
      recency,
    },
    signals,
    recommendedAction,
    recommendedCadence: tierCadenceLabel(tier),
    nextTouchpointDue,
    previousScore,
    scoreDelta,
  }

  // Persist
  await supabase.from("lifetime_customer_npv_scores").insert({
    contact_id:                 result.contactId,
    brokerage_id:               result.brokerageId,
    agent_id:                   result.agentId,
    npv_score:                  result.npvScore,
    npv_dollars:                result.npvDollars,
    tier:                       result.tier,
    transaction_history_score:  result.components.transactionHistory,
    referral_history_score:     result.components.referralHistory,
    engagement_score:           result.components.engagement,
    wealth_score:               result.components.wealth,
    recency_score:              result.components.recency,
    signals:                    result.signals,
    recommended_action:         result.recommendedAction,
    recommended_cadence:        result.recommendedCadence,
    next_touchpoint_due:        result.nextTouchpointDue,
    previous_score:             result.previousScore,
    score_delta:                result.scoreDelta,
  })

  return result
}

function tierCadenceLabel(tier: NpvTier): string {
  if (tier === "platinum") return "monthly"
  if (tier === "gold")     return "bi-monthly"
  if (tier === "silver")   return "quarterly"
  if (tier === "bronze")   return "bi-annual"
  return "annual"
}

function formatUsd(n: number): string {
  return `$${Math.round(n).toLocaleString()}`
}

// ─── Brokerage-wide rollup helper ─────────────────────────────────────────

/**
 * Sphere referral expected value over the next N days for an agent.
 * Used by the Income Forecast snapshot to add a sphere-contribution figure
 * on top of pipeline-only projections.
 */
export async function projectAgentSphereReferralValue(input: {
  agentId:     string
  brokerageId: string
  horizonDays?: number
}): Promise<number> {
  const supabase = createServiceClient()
  const horizonDays = input.horizonDays ?? 90

  // Latest NPV row per contact for this agent. Bound the lookup to recent
  // computations to avoid loading old/duplicate rows.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data: rows } = await supabase
    .from("lifetime_customer_npv_scores")
    .select("contact_id, npv_dollars, tier, computed_at")
    .eq("agent_id", input.agentId)
    .eq("brokerage_id", input.brokerageId)
    .gte("computed_at", since)
    .order("computed_at", { ascending: false })
    .limit(5000)

  const latestByContact = new Map<string, { npv_dollars: number; tier: NpvTier }>()
  for (const r of (rows ?? []) as Array<{ contact_id: string; npv_dollars: number; tier: NpvTier }>) {
    if (!latestByContact.has(r.contact_id)) {
      latestByContact.set(r.contact_id, { npv_dollars: r.npv_dollars, tier: r.tier })
    }
  }

  // Pro-rate the 5-year NPV $ to the requested horizon and apply the tier's
  // annual referral rate as the conversion probability per year.
  const fraction = horizonDays / 365
  let expected = 0
  for (const { npv_dollars, tier } of latestByContact.values()) {
    const annualRate = ANNUAL_REFERRAL_RATE[tier]
    expected += (Number(npv_dollars) / HORIZON_YEARS) * fraction * Math.min(annualRate, 1.0)
  }
  return Math.round(expected)
}
