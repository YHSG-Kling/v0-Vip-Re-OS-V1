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
 *
 * WAVE 152 (lane 152B) — credits are REVERSIBLE and REFRESHED, not write-once:
 *   · eligibility reads the ONE status vocabulary (lib/transactions/transaction-status.ts): in escrow, closed or
 *     funded. The old list named "completed" (no such status — the live CHECK never admitted it) and missed
 *     `funded`, `pending` and `clear_to_close`, so a funded deal was never credited at all;
 *   · a deal that falls through (`lost` / `archived`) or is deleted has its credits RETRACTED (deleted, counted
 *     with .select() — a delete that matches nothing also resolves) and its campaigns' rollups recomputed;
 *   · findTransactionsNeedingAttribution returns NEW work and STALE work: a credited deal whose commission
 *     changed (an under-contract estimate replaced by the final amount, a correction) or that reversed. It used
 *     to skip any deal that already had a credit row, so neither a cancel nor a correction ever propagated;
 *   · a re-run removes the rows of campaigns that no longer touch the deal (an upsert alone left them behind);
 *   · every read's error is READ (a refused read throws to the cron, which records it — never "not eligible").
 * The ROI reader (lib/intelligence/roi-ledger.ts loadRoiOutcomeLedger) does not trust credit_dollars: it re-reads
 * each deal's CURRENT money and status and splits it by these WEIGHTS, so a reversal shows at read time even
 * before this cron runs. credit_dollars stays the cache the other readers sum.
 */

import "server-only"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { inPipelineColumn, isInEscrow, TRANSACTION_STATUSES_TERMINAL } from "@/lib/transactions/transaction-status"
import { applyTenantScope, type TenantScope } from "@/lib/kernel/tenant-scope"
import type { SupabaseClient } from "@supabase/supabase-js"

export type AttributionModel = "first_touch" | "last_touch" | "linear" | "time_decay"

export interface AttributionResult {
  transactionId:    string
  totalCredits:     number
  perModelTotals:   Record<AttributionModel, number>
  /** What this run did: credited (first time or refreshed) or retracted (the deal fell through / was deleted). */
  outcome:          "credited" | "retracted"
  /** Credit rows deleted — a retraction, or campaigns that no longer touch the deal on a refresh. */
  removedRows:      number
}

/** PURE — may a deal carry marketing credit right now? Under contract through funded, and not deleted. */
function isCreditableDeal(d: { status?: string | null; deleted_at?: string | null }): boolean {
  return !d.deleted_at && (isInEscrow(d.status) || inPipelineColumn(d.status, "closed"))
}

/** PURE — has the deal fallen through (lost / archived) or been deleted? Its credit is then retracted. */
function isReversedDeal(d: { status?: string | null; deleted_at?: string | null }): boolean {
  if (d.deleted_at) return true
  return (TRANSACTION_STATUSES_TERMINAL as readonly string[]).includes(String(d.status ?? "")) && !inPipelineColumn(d.status, "closed")
}

/** Recompute marketing_campaigns.attributed_gci_total (the LINEAR rollup) for these campaigns. */
async function rollUpCampaigns(svc: SupabaseClient, campaignIds: string[]): Promise<void> {
  for (const campaignId of campaignIds) {
    const { data: linearRow, error } = await svc
      .from("marketing_attribution_credits")
      .select("credit_dollars")
      .eq("campaign_id", campaignId)
      .eq("attribution_model", "linear")
    if (error) throw new Error(`attribution rollup read refused for campaign ${campaignId}: ${error.message}`)
    const total = (linearRow ?? []).reduce(
      (s, r) => s + Number((r as { credit_dollars: number | null }).credit_dollars ?? 0),
      0,
    )
    await sentinelWrite(svc, svc
      .from("marketing_campaigns")
      .update({
        attributed_gci_total:   total,
        attribution_synced_at:  new Date().toISOString(),
        updated_at:             new Date().toISOString(),
      })
      .eq("id", campaignId), { table: "marketing_campaigns", flow: "attribution_rollup", reason: "rollup cache recomputed on every attribution run" })
  }
}

/** Delete this deal's credits (all, or all but `keepCampaignIds`), COUNTED. Returns the campaigns touched and the rows removed. */
async function removeCredits(svc: SupabaseClient, txn: { id: string; brokerage_id: string }, keepCampaignIds?: Set<string>): Promise<{ removed: number; campaigns: string[] }> {
  const { data: existing, error } = await svc
    .from("marketing_attribution_credits")
    .select("id, campaign_id")
    .eq("brokerage_id", txn.brokerage_id)
    .eq("transaction_id", txn.id)
  if (error) throw new Error(`attribution credits read refused for ${txn.id}: ${error.message}`)
  const doomed = ((existing ?? []) as Array<{ id: string; campaign_id: string }>).filter((r) => !keepCampaignIds || !keepCampaignIds.has(r.campaign_id))
  if (doomed.length === 0) return { removed: 0, campaigns: [] }
  const { data: gone, error: delError } = await svc
    .from("marketing_attribution_credits")
    .delete()
    .eq("brokerage_id", txn.brokerage_id)
    .in("id", doomed.map((r) => r.id))
    .select("id")
  if (delError) throw new Error(`attribution credits NOT retracted for ${txn.id}: ${delError.message}`)
  return { removed: (gone ?? []).length, campaigns: [...new Set(doomed.map((r) => r.campaign_id))] }
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
  // 1. Load the transaction + its GCI + the contact(s) we're attributing for. purchase_price is NOT read: sale price
  //    is never commission revenue (directive 152B).
  const { data: txn, error: txnError } = await svc
    .from("transactions")
    .select("id, brokerage_id, status, deleted_at, buyer_contact_id, seller_contact_id, contact_id, contract_date, close_date, commission_amount, estimated_commission")
    .eq("id", transactionId)
    .maybeSingle()
  if (txnError) throw new Error(`transaction read refused for ${transactionId}: ${txnError.message}`)
  if (!txn) return null
  const emptyTotals: Record<AttributionModel, number> = { first_touch: 0, last_touch: 0, linear: 0, time_decay: 0 }

  // REVERSAL: a deal that fell through or was deleted keeps no credit. Retract, count, re-roll the campaigns.
  if (isReversedDeal(txn as { status: string | null; deleted_at: string | null })) {
    const gone = await removeCredits(svc, txn as { id: string; brokerage_id: string })
    if (gone.removed > 0) await rollUpCampaigns(svc, gone.campaigns)
    return { transactionId, totalCredits: 0, perModelTotals: emptyTotals, outcome: "retracted", removedRows: gone.removed }
  }

  // Only attribute deals under contract through funded (the ONE status vocabulary).
  if (!isCreditableDeal(txn as { status: string | null; deleted_at: string | null })) return null

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

  // 2. Pull all touchpoints for these contacts in the lookback window — the DEAL's tenant only (a mis-stamped
  //    touchpoint of another tenant can never earn credit here).
  const { data: touchpoints, error: tpError } = await svc
    .from("marketing_campaign_touchpoints")
    .select("campaign_id, sent_at")
    .eq("brokerage_id", txn.brokerage_id as string)
    .in("contact_id", contactIds)
    .gte("sent_at", lookbackStart)
    .lte("sent_at", anchor.toISOString())
    .order("sent_at", { ascending: true })
  if (tpError) throw new Error(`touchpoints read refused for ${transactionId}: ${tpError.message}`)

  const tps = (touchpoints ?? []) as Array<{ campaign_id: string; sent_at: string }>
  if (tps.length === 0) {
    // Nothing touches the deal any more (a touchpoint was removed): any earlier credit is stale — retract it.
    const gone = await removeCredits(svc, txn as { id: string; brokerage_id: string })
    if (gone.removed > 0) await rollUpCampaigns(svc, gone.campaigns)
    return gone.removed > 0 ? { transactionId, totalCredits: 0, perModelTotals: emptyTotals, outcome: "retracted", removedRows: gone.removed } : null
  }

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
      await sentinelWrite(svc, svc
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
        }, { onConflict: "campaign_id,transaction_id,attribution_model" }), { table: "marketing_attribution_credits", flow: "marketing_attribution_credit", brokerageId: txn.brokerage_id as string, reason: "per-model credit rows are recomputed idempotently (upsert on campaign+transaction+model) on the next attribution run; a loss is ledgered" })
    }
  }

  // 4b. A refresh removes the rows of campaigns that no longer touch the deal (an upsert alone leaves them behind,
  //     and they would keep a share of commission the new split already gave away).
  const stale = await removeCredits(svc, txn as { id: string; brokerage_id: string }, new Set(campaignIds))

  // 5. Roll up the LINEAR model into marketing_campaigns.attributed_gci_total
  //    (linear is the "default" reporting model) — for every campaign this run touched, kept or removed.
  await rollUpCampaigns(svc, [...new Set([...campaignIds, ...stale.campaigns])])

  const totalCredits: number = (Object.values(perModelTotals) as number[])
    .reduce((s, v) => s + v, 0)

  return {
    transactionId,
    totalCredits,
    perModelTotals,
    outcome: "credited",
    removedRows: stale.removed,
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
 * Returns recent transactions that need attribution work (changed within the last N days). Used by the
 * attribution cron to find work. WAVE 152 (152B): NEW work (a creditable deal with no credit yet) AND STALE work
 * — a credited deal that has since reversed (lost / archived / deleted → retract), or whose commission no longer
 * matches its linear credit (an estimate replaced by the final amount, a correction → refresh). It used to drop
 * every deal that already carried any credit row, so nothing after the first run ever propagated. Refused reads
 * throw (the cron records the failure) — never an empty "nothing to do".
 *
 * `scope` is REQUIRED and stated by the caller (lib/kernel/tenant-scope.ts): the CRON_SECRET-verified daily cron
 * passes platformScope(<why>) — the scan is platform-wide by design, and each candidate is then credited only inside
 * its own tenant (attributeTransactionSafe pins every write to the deal's brokerage); a tenant-side caller passes
 * tenantScope(brokerageId, where). A missing tenant can never silently widen the read.
 */
export async function findTransactionsNeedingAttribution(
  svc: SupabaseClient,
  scope: TenantScope,
  lookbackDays: number = 14,
): Promise<string[]> {
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString()
  const txQuery = svc
    .from("transactions")
    .select("id, brokerage_id, status, deleted_at, commission_amount, estimated_commission")
    .gte("updated_at", since)
  // Mutates the builder in place (the lib/kernel/command-center.ts / lib/property-alerts/alert-engine.ts shape — the
  // generic return form instantiates too deeply against the generated transactions types).
  applyTenantScope(txQuery, scope)
  const { data: txns, error: txError } = await txQuery.limit(500)
  if (txError) throw new Error(`attribution candidates read refused: ${txError.message}`)
  const rows = (txns ?? []) as Array<{ id: string; status: string | null; deleted_at: string | null; commission_amount: number | null; estimated_commission: number | null }>
  const relevant = rows.filter((t) => isCreditableDeal(t) || isReversedDeal(t))
  if (relevant.length === 0) return []

  // What each candidate is credited today (the linear rows sum to the deal's GCI when current).
  const linearSum = new Map<string, { sum: number; rows: number }>()
  const credited = new Set<string>()
  const ids = relevant.map((t) => t.id)
  for (let i = 0; i < ids.length; i += 200) {
    const { data: existing, error: credError } = await svc
      .from("marketing_attribution_credits")
      .select("transaction_id, attribution_model, credit_dollars")
      .in("transaction_id", ids.slice(i, i + 200))
    if (credError) throw new Error(`attribution credits read refused: ${credError.message}`)
    for (const r of (existing ?? []) as Array<{ transaction_id: string; attribution_model: string; credit_dollars: number | null }>) {
      credited.add(r.transaction_id)
      if (r.attribution_model !== "linear") continue
      const cur = linearSum.get(r.transaction_id) ?? { sum: 0, rows: 0 }
      linearSum.set(r.transaction_id, { sum: cur.sum + Number(r.credit_dollars ?? 0), rows: cur.rows + 1 })
    }
  }
  return relevant.filter((t) => {
    if (isReversedDeal(t)) return credited.has(t.id)                       // retract what a dead deal still carries
    if (!credited.has(t.id)) return true                                   // new work
    const gci = Number(t.commission_amount ?? t.estimated_commission ?? 0)
    const cur = linearSum.get(t.id)
    if (!cur) return true                                                  // credited, but no linear split — redo
    return Math.abs(cur.sum - gci) > 0.005 * cur.rows + 0.001              // money moved since the split — refresh
  }).map((t) => t.id)
}
