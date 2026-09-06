/**
 * Sprint 9 cont. — Marketing attribution engine.
 *
 * When a transaction closes, attribute its GCI to the marketing campaigns
 * whose touchpoints touched the contact within the lookback window. We
 * write one marketing_attribution_credits row per (campaign × transaction
 * × model). The supported models:
 *
 *   first_touch — 100% to the earliest campaign that touched the contact
 *   last_touch  — 100% to the latest campaign
 *   linear      — equal split across all touching campaigns
 *   time_decay  — weight by 0.5^(days_before_close / half_life_days)
 *
 * Each model writes its own row; broker dashboards can pick the model
 * they trust (or display side-by-side).
 *
 * Idempotency: UNIQUE(campaign_id, transaction_id, attribution_model)
 * means re-running this for the same close is a no-op. On rerun we use
 * upsert with ON CONFLICT DO UPDATE to refresh credit_dollars if GCI
 * changed.
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

export type AttributionModel = "first_touch" | "last_touch" | "linear" | "time_decay"

export interface AttributionResult {
  transactionId:    string
  totalCredits:     number
  perModelTotals:   Record<AttributionModel, number>
}

const LOOKBACK_DAYS  = 180
const TIME_DECAY_HALF_LIFE_DAYS = 30

/**
 * Run attribution for a single transaction. Service-role; caller enforces
 * any auth check. Idempotent — safe to re-run.
 */
export async function attributeTransactionSafe(
  svc: SupabaseClient,
  transactionId: string,
  models: AttributionModel[] = ["first_touch", "last_touch", "linear", "time_decay"],
): Promise<AttributionResult | null> {
  // 1. Load the transaction + its GCI + the contact(s) we're attributing for
  const { data: txn } = await svc
    .from("transactions")
    .select("id, brokerage_id, status, stage, buyer_contact_id, seller_contact_id, contact_id, contract_date, close_date, commission_amount, estimated_commission, purchase_price")
    .eq("id", transactionId)
    .maybeSingle()
  if (!txn) return null

  // Only attribute closed / under-contract transactions
  const eligibleStatuses = new Set(["closed", "completed", "under_contract"])
  if (!eligibleStatuses.has(txn.status as string) && !eligibleStatuses.has((txn.stage as string)?.toLowerCase?.() ?? "")) {
    return null
  }

  const gci = Number(txn.commission_amount ?? txn.estimated_commission ?? 0)
  if (gci <= 0) return null

  const contactIds = [
    txn.buyer_contact_id,
    txn.seller_contact_id,
    txn.contact_id,
  ].filter((c): c is string => !!c)
  if (contactIds.length === 0) return null

  // Anchor date = contract_date or close_date; fall back to today
  const anchorIso = (txn.contract_date as string | null) ?? (txn.close_date as string | null) ?? new Date().toISOString()
  const anchor    = new Date(anchorIso)
  const lookbackStart = new Date(anchor.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString()

  // 2. Pull all touchpoints for these contacts in the lookback window
  const { data: touchpoints } = await svc
    .from("marketing_campaign_touchpoints")
    .select("campaign_id, sent_at")
    .in("contact_id", contactIds)
    .gte("sent_at", lookbackStart)
    .lte("sent_at", anchor.toISOString())
    .order("sent_at", { ascending: true })

  const tps = (touchpoints ?? []) as Array<{ campaign_id: string; sent_at: string }>
  if (tps.length === 0) return null

  // 3. Group by campaign
  const perCampaign = new Map<string, { firstSentAt: string; lastSentAt: string; count: number }>()
  for (const tp of tps) {
    const cur = perCampaign.get(tp.campaign_id)
    if (!cur) {
      perCampaign.set(tp.campaign_id, { firstSentAt: tp.sent_at, lastSentAt: tp.sent_at, count: 1 })
    } else {
      cur.lastSentAt = tp.sent_at
      cur.count     += 1
    }
  }

  const campaignIds = Array.from(perCampaign.keys())
  const earliest    = campaignIds.reduce<{ id: string; t: number } | null>((best, id) => {
    const t = new Date(perCampaign.get(id)!.firstSentAt).getTime()
    if (!best || t < best.t) return { id, t }
    return best
  }, null)
  const latest = campaignIds.reduce<{ id: string; t: number } | null>((best, id) => {
    const t = new Date(perCampaign.get(id)!.lastSentAt).getTime()
    if (!best || t > best.t) return { id, t }
    return best
  }, null)

  const perModelTotals: Record<AttributionModel, number> = {
    first_touch: 0, last_touch: 0, linear: 0, time_decay: 0,
  }

  // 4. Compute weights per model and upsert credits
  for (const model of models) {
    const weights = computeWeights(model, perCampaign, earliest?.id, latest?.id, anchor)

    for (const [campaignId, weight] of weights.entries()) {
      const credit = Math.round(gci * weight * 100) / 100
      perModelTotals[model] += credit
      const tp = perCampaign.get(campaignId)!
      await svc
        .from("marketing_attribution_credits")
        .upsert({
          brokerage_id:        txn.brokerage_id as string,
          campaign_id:         campaignId,
          transaction_id:      transactionId,
          contact_id:          contactIds[0] ?? null,
          attribution_model:   model,
          attribution_weight:  weight,
          credit_dollars:      credit,
          first_touchpoint_at: tp.firstSentAt,
          last_touchpoint_at:  tp.lastSentAt,
          touchpoint_count:    tp.count,
        }, { onConflict: "campaign_id,transaction_id,attribution_model" })
    }
  }

  // 5. Roll up the LINEAR model into marketing_campaigns.attributed_gci_total
  //    (linear is the "default" reporting model)
  for (const campaignId of campaignIds) {
    const { data: linearRow } = await svc
      .from("marketing_attribution_credits")
      .select("credit_dollars")
      .eq("campaign_id", campaignId)
      .eq("attribution_model", "linear")
    const total = (linearRow ?? []).reduce(
      (s, r) => s + Number((r as { credit_dollars: number | null }).credit_dollars ?? 0),
      0,
    )
    await svc
      .from("marketing_campaigns")
      .update({
        attributed_gci_total:   total,
        attribution_synced_at:  new Date().toISOString(),
        updated_at:             new Date().toISOString(),
      })
      .eq("id", campaignId)
  }

  const totalCredits: number = (Object.values(perModelTotals) as number[])
    .reduce((s, v) => s + v, 0)

  return {
    transactionId,
    totalCredits,
    perModelTotals,
  }
}

function computeWeights(
  model:        AttributionModel,
  perCampaign:  Map<string, { firstSentAt: string; lastSentAt: string; count: number }>,
  earliestId:   string | undefined,
  latestId:     string | undefined,
  anchor:       Date,
): Map<string, number> {
  const out = new Map<string, number>()
  const ids = Array.from(perCampaign.keys())

  if (model === "first_touch") {
    for (const id of ids) out.set(id, id === earliestId ? 1 : 0)
    return out
  }
  if (model === "last_touch") {
    for (const id of ids) out.set(id, id === latestId ? 1 : 0)
    return out
  }
  if (model === "linear") {
    const w = 1 / ids.length
    for (const id of ids) out.set(id, w)
    return out
  }
  // time_decay
  const decay = ids.map((id) => {
    const last = new Date(perCampaign.get(id)!.lastSentAt).getTime()
    const daysAgo = Math.max(0, (anchor.getTime() - last) / 86_400_000)
    return { id, weight: Math.pow(0.5, daysAgo / TIME_DECAY_HALF_LIFE_DAYS) }
  })
  const sum = decay.reduce((s, d) => s + d.weight, 0) || 1
  for (const d of decay) out.set(d.id, d.weight / sum)
  return out
}

/**
 * Returns recent transactions that need attribution (closed within the
 * last N days, no existing linear credit row). Used by the attribution
 * cron to find work.
 */
export async function findTransactionsNeedingAttribution(
  svc: SupabaseClient,
  lookbackDays: number = 14,
): Promise<string[]> {
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString()
  const { data: txns } = await svc
    .from("transactions")
    .select("id")
    .in("status", ["closed", "under_contract"])
    .gte("updated_at", since)
    .limit(200)
  const candidateIds = ((txns ?? []) as Array<{ id: string }>).map(t => t.id)
  if (candidateIds.length === 0) return []

  // Filter out ones we've already attributed (any model row exists)
  const { data: existing } = await svc
    .from("marketing_attribution_credits")
    .select("transaction_id")
    .in("transaction_id", candidateIds)
  const done = new Set(((existing ?? []) as Array<{ transaction_id: string }>).map(r => r.transaction_id))
  return candidateIds.filter(id => !done.has(id))
}
