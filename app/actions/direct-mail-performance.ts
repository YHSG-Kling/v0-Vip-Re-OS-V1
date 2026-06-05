"use server"

/**
 * app/actions/direct-mail-performance.ts
 *
 * Wave 36 — read-only server action for the Direct Mail Performance
 * dashboard. Brokerage-tier gated through resolvePolicyScopeAccess.
 *
 * Returns three views:
 *   1. Channel overview — 28d sends / scans / cost / cost-per-scan,
 *      exploration ratio (% of sends to cold bandit arms)
 *   2. Top variant arms — per (composition × copy_style × persona ×
 *      use_kind × size) cell with sends, scans, scan rate, CPS,
 *      Beta posterior mean. Sorted by scan rate DESC, gated at >= 5
 *      sends to avoid small-N noise.
 *   3. Recent campaigns — last 25 direct_mail_campaigns rows with
 *      variant + compliance check status + outcome
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolvePolicyScopeAccess } from "@/lib/identity/policy-scope"

export interface ChannelOverview {
  sent_28d:          number
  scans_28d:         number
  cost_spent_28d:    number
  cost_per_scan:     number | null
  exploration_ratio: number   // (cold arm sends / total sends) — bandit telemetry
}

export interface VariantArmRow {
  variant_id:     string
  composition_id: string
  copy_style:     string
  layout_variant: string
  persona:        string
  use_kind:       string
  postcard_size:  string
  sends_count:    number
  scans_count:    number
  scan_rate:      number
  cost_per_scan:  number | null
  posterior_mean: number       // E[Beta(scans+1, sends-scans+1)]
}

export interface RecentCampaignRow {
  id:                 string
  campaign_name:      string | null
  target_audience:    string | null
  piece_type:         string | null
  status:             string | null
  mailing_date:       string | null
  lob_order_id:       string | null
  variant_summary:    string | null  // "PostcardFront4x6 · direct-fact"
  compliance_status:  "passed" | "blocked" | "unknown"
  contact_id:         string | null
}

export async function getDirectMailPerformance(): Promise<
  | { success: true; overview: ChannelOverview; topVariants: VariantArmRow[]; recentCampaigns: RecentCampaignRow[] }
  | { success: false; error: string }
> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) {
    return { success: false, error: "Brokerage admin scope required" }
  }
  const svc = createServiceClient()
  const brokerageId = access.brokerageScopeId
  const since28d = new Date(Date.now() - 28 * 86_400_000).toISOString().slice(0, 10)

  // ── 1. Channel overview ─────────────────────────────────────────────────
  const [sentResp, costScansResp] = await Promise.all([
    svc.from("direct_mail_campaigns")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("status", "sent")
      .gte("mailing_date", since28d),
    svc.from("direct_mail_variant_outcomes")
      .select("sends_count, scans_count, cost_spent_cents")
      .eq("brokerage_id", brokerageId),
  ])
  type OutRow = { sends_count: number; scans_count: number; cost_spent_cents: number }
  const outcomes = (costScansResp.data ?? []) as OutRow[]
  const sends_all     = outcomes.reduce((a, o) => a + (o.sends_count ?? 0), 0)
  const scans_all     = outcomes.reduce((a, o) => a + (o.scans_count ?? 0), 0)
  const cost_all_cents = outcomes.reduce((a, o) => a + (o.cost_spent_cents ?? 0), 0)

  // Exploration ratio: rows where sends_count is small (≤ 5) approximate
  // "still in exploration territory". Cleaner than parsing per-dispatch
  // isExploration since we don't persist that flag.
  const exploring = outcomes.reduce((a, o) => a + ((o.sends_count ?? 0) <= 5 ? (o.sends_count ?? 0) : 0), 0)
  const exploration_ratio = sends_all > 0 ? exploring / sends_all : 0

  const overview: ChannelOverview = {
    sent_28d:          sentResp.count ?? 0,
    scans_28d:         scans_all,
    cost_spent_28d:    Math.round((cost_all_cents / 100) * 100) / 100,
    cost_per_scan:     scans_all > 0 ? Math.round((cost_all_cents / 100 / scans_all) * 100) / 100 : null,
    exploration_ratio: Math.round(exploration_ratio * 1000) / 1000,
  }

  // ── 2. Top variant arms ─────────────────────────────────────────────────
  const { data: variantJoinData } = await svc
    .from("direct_mail_variant_outcomes")
    .select(`
      variant_id, sends_count, scans_count, cost_spent_cents,
      variant:direct_mail_variants!direct_mail_variant_outcomes_variant_id_fkey(composition_id, copy_style, layout_variant, persona, use_kind, postcard_size)
    `)
    .eq("brokerage_id", brokerageId)
    .gte("sends_count", 5)
    .order("scans_count", { ascending: false })
    .limit(25)

  type ArmJoin = {
    variant_id: string
    sends_count: number
    scans_count: number
    cost_spent_cents: number
    variant: {
      composition_id: string
      copy_style: string
      layout_variant: string
      persona: string
      use_kind: string
      postcard_size: string
    } | null
  }

  const topVariants: VariantArmRow[] = ((variantJoinData ?? []) as unknown as ArmJoin[])
    .filter((r) => !!r.variant)
    .map((r) => {
      const v = r.variant!
      const scanRate = r.sends_count > 0 ? r.scans_count / r.sends_count : 0
      const cps = r.scans_count > 0 ? (r.cost_spent_cents / 100) / r.scans_count : null
      const alpha = r.scans_count + 1
      const beta  = Math.max(0, r.sends_count - r.scans_count) + 1
      const posteriorMean = alpha / (alpha + beta)
      return {
        variant_id:     r.variant_id,
        composition_id: v.composition_id,
        copy_style:     v.copy_style,
        layout_variant: v.layout_variant,
        persona:        v.persona,
        use_kind:       v.use_kind,
        postcard_size:  v.postcard_size,
        sends_count:    r.sends_count,
        scans_count:    r.scans_count,
        scan_rate:      Math.round(scanRate * 10000) / 10000,
        cost_per_scan:  cps == null ? null : Math.round(cps * 100) / 100,
        posterior_mean: Math.round(posteriorMean * 10000) / 10000,
      }
    })
    .sort((a, b) => b.scan_rate - a.scan_rate)

  // ── 3. Recent campaigns ─────────────────────────────────────────────────
  const { data: recentRows } = await svc
    .from("direct_mail_campaigns")
    .select(`
      id, campaign_name, target_audience, piece_type, status, mailing_date,
      lob_order_id, contact_id, compliance_event_id,
      variant:direct_mail_variants!direct_mail_campaigns_variant_id_fkey(composition_id, copy_style),
      compliance:compliance_events!direct_mail_campaigns_compliance_event_id_fkey(allowed)
    `)
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(25)
  type RecentJoin = {
    id: string
    campaign_name: string | null
    target_audience: string | null
    piece_type: string | null
    status: string | null
    mailing_date: string | null
    lob_order_id: string | null
    contact_id: string | null
    variant: { composition_id: string; copy_style: string } | null
    compliance: { allowed: boolean } | null
  }
  const recentCampaigns: RecentCampaignRow[] = ((recentRows ?? []) as unknown as RecentJoin[]).map((r) => ({
    id: r.id,
    campaign_name:   r.campaign_name,
    target_audience: r.target_audience,
    piece_type:      r.piece_type,
    status:          r.status,
    mailing_date:    r.mailing_date,
    lob_order_id:    r.lob_order_id,
    contact_id:      r.contact_id,
    variant_summary: r.variant ? `${r.variant.composition_id} · ${r.variant.copy_style}` : null,
    compliance_status: r.compliance == null
      ? "unknown"
      : (r.compliance.allowed ? "passed" : "blocked"),
  }))

  return { success: true, overview, topVariants, recentCampaigns }
}
