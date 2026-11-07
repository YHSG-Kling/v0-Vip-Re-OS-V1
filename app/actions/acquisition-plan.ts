"use server"

// app/actions/acquisition-plan.ts — THE SOURCE DISCOVERY PLANNER'S DOORS (wave 150, lane 150EFG; directive lane 150E).
//
// Every export is a PUBLIC endpoint (CLAUDE.md §4): each one resolves the tenant from the SESSION (never a body), gates
// on the seat, and only then uses the service client. Reading and proposing is tenant-admin work
// (TENANT_ADMIN_USER_TYPES via requireBrokerageAdmin); APPROVING obligates the tenant to pay a vendor, so it needs a
// TENANT_COMMERCE_ADMIN seat (compliance_officer reads the plan and never commits the spend). Approval is ledgered
// (withActionLedger — LAW 5: who, why, which policy, what it may cost).
//
// The planner is pure (lib/lead-pipeline/source-discovery-planner.ts); these doors only read its inputs from the
// tenant's own data and persist its verdict (acquisition_plans, m962). The paid pooled pull reads the approvals back
// (lib/lead-pipeline/pooled-pull.ts productionPooledBatchDataDeps → paidPullApproval).

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireBrokerageAdmin } from "@/lib/auth/require-brokerage-admin"
import { TENANT_COMMERCE_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { resolveSourceKey, SOURCE_MAP, SOURCE_VENDOR, expandEnabledSources, type SourceKey } from "@/lib/lead-pipeline/source-intent-map"
import {
  planSourceDiscovery,
  approvePlanLines,
  type AcquisitionPlan,
  type PlanLine,
  type SourceHistory,
  type SourcePreview,
  type SourceQuote,
} from "@/lib/lead-pipeline/source-discovery-planner"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The window of the territory's own history the planner learns from (an analysis window, not a schedule). */
const HISTORY_DAYS = 180
/** BatchData's published per-record Property Search price (lib/external/batchdata-client.ts) — the catalogue quote. */
const BATCHDATA_CATALOGUE_UNIT_USD = 0.05

interface AcquisitionTerritoryView { id: string; label: string; monthlyBudgetUsd: number | null }
interface StoredAcquisitionPlan {
  id: string
  territoryId: string | null
  territoryLabel: string | null
  status: string
  budgetUsd: number
  totalQuoteUsd: number
  marketMode: string
  tilt: string
  lines: PlanLine[]
  blindSpots: string[]
  approvedAt: string | null
  validUntil: string | null
  createdAt: string
}
export interface AcquisitionPlanView {
  territories: AcquisitionTerritoryView[]
  plans: StoredAcquisitionPlan[]
  mayApprove: boolean
  error: string | null
}

async function sessionGate(): Promise<{ userId: string; brokerageId: string; userType: string }> {
  const supabase = await createClient()
  const { data: auth, error } = await supabase.auth.getUser()
  if (error || !auth?.user) throw new Error("Not signed in")
  const ctx = await requireBrokerageAdmin(supabase, auth.user.id)
  return { userId: auth.user.id, brokerageId: ctx.brokerageId, userType: ctx.userType }
}

function toStored(r: Record<string, any>): StoredAcquisitionPlan {
  return {
    id: r.id, territoryId: r.territory_id ?? null, territoryLabel: r.territory_label ?? null, status: r.status,
    budgetUsd: Number(r.budget_usd ?? 0), totalQuoteUsd: Number(r.total_quote_usd ?? 0), marketMode: r.market_mode, tilt: r.tilt,
    lines: Array.isArray(r.lines) ? r.lines : [], blindSpots: Array.isArray(r.blind_spots) ? r.blind_spots : [],
    approvedAt: r.approved_at ?? null, validUntil: r.valid_until ?? null, createdAt: r.created_at,
  }
}

/** The tenant's territories and its latest plans (Settings → Territories, the acquisition panel). */
export async function getAcquisitionPlanView(): Promise<AcquisitionPlanView> {
  try {
    const ctx = await sessionGate()
    const svc = createServiceClient()
    const [terr, plans] = await Promise.all([
      svc.from("lead_scraping_markets").select("id, name, city, state, monthly_budget_usd").eq("brokerage_id", ctx.brokerageId).eq("is_active", true).limit(50),
      svc.from("acquisition_plans").select("*").eq("brokerage_id", ctx.brokerageId).order("created_at", { ascending: false }).limit(20),
    ])
    if (terr.error) return { territories: [], plans: [], mayApprove: false, error: `Territories could not be read: ${terr.error.message}` }
    if (plans.error) return { territories: [], plans: [], mayApprove: false, error: `Acquisition plans could not be read: ${plans.error.message}` }
    return {
      territories: (terr.data ?? []).map((t: any) => ({ id: t.id, label: t.name || [t.city, t.state].filter(Boolean).join(", ") || "Territory", monthlyBudgetUsd: t.monthly_budget_usd ?? null })),
      plans: (plans.data ?? []).map(toStored),
      mayApprove: TENANT_COMMERCE_ADMIN_USER_TYPES.has(ctx.userType.toLowerCase()),
      error: null,
    }
  } catch (e) {
    return { territories: [], plans: [], mayApprove: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Build and store a PROPOSED plan for one of the tenant's territories. Reads the territory's own history (raw rows,
 * promotions, duplicates, cost per record) as reach / yield / quote; first-party lines need no preview. No vendor is
 * called and nothing is bought — the plan only becomes spendable through approveAcquisitionPlan.
 */
export async function proposeAcquisitionPlan(input: { territoryId: string; budgetUsd: number }): Promise<{ success: true; plan: AcquisitionPlan; planId: string } | { success: false; error: string }> {
  try {
    const ctx = await sessionGate()
    if (!UUID_RE.test(String(input?.territoryId ?? ""))) return { success: false, error: "Pick a territory" }
    const budget = Number(input?.budgetUsd)
    if (!Number.isFinite(budget) || budget < 0 || budget > 1_000_000) return { success: false, error: "Enter a budget between $0 and $1,000,000" }
    const svc = createServiceClient()
    // Tenant-pinned: a territory id from the browser is only a NAME for one of THIS tenant's rows.
    const { data: terr, error: terrErr } = await svc.from("lead_scraping_markets")
      .select("id, name, city, state, enabled_sources, zip_codes").eq("id", input.territoryId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
    if (terrErr) return { success: false, error: `Territory could not be read: ${terrErr.message}` }
    if (!terr) return { success: false, error: "That territory is not one of yours" }

    const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString()
    const { data: rows, error: histErr } = await svc.from("raw_scraped_leads")
      .select("source, lead_id, processing_status, cost_per_record").eq("market_id", terr.id).gte("created_at", since).limit(10000)
    if (histErr) return { success: false, error: `Territory history could not be read: ${histErr.message}` }
    const history: Partial<Record<SourceKey, SourceHistory>> = {}
    for (const r of (rows ?? []) as Array<{ source: string; lead_id: string | null; processing_status: string | null; cost_per_record: number | null }>) {
      const key = resolveSourceKey(r.source)
      if (!(key in SOURCE_MAP)) continue
      const h = (history[key] ??= { rawRows: 0, promoted: 0, duplicates: 0, costUsd: 0 })
      h.rawRows++
      if (r.lead_id || r.processing_status === "promoted") h.promoted++
      if (r.processing_status === "duplicate_pre_enrich" || r.processing_status === "duplicate_post_enrich") h.duplicates++
      h.costUsd += Number(r.cost_per_record ?? 0)
    }
    const quotes: Partial<Record<SourceKey, SourceQuote>> = {}
    const previews: Partial<Record<SourceKey, SourcePreview>> = {}
    const nowIso = new Date().toISOString()
    for (const key of Object.keys(SOURCE_MAP) as SourceKey[]) {
      const h = history[key]
      if (h && h.rawRows > 0 && h.costUsd > 0) quotes[key] = { unitUsd: Math.round((h.costUsd / h.rawRows) * 10000) / 10000, basis: "history" }
      else if (SOURCE_VENDOR[key] === "batchdata") quotes[key] = { unitUsd: BATCHDATA_CATALOGUE_UNIT_USD, basis: "catalogue" }
      // The only FREE preview this door can take without a provider call is the territory's own observed count.
      if (h && h.rawRows > 0) previews[key] = { count: h.rawRows, at: nowIso, via: `own history (${HISTORY_DAYS} days)` }
    }
    const enabled = [...expandEnabledSources((terr as any).enabled_sources ?? [])].map((s) => resolveSourceKey(s)).filter((k) => k in SOURCE_MAP)
    const label = (terr as any).name || [(terr as any).city, (terr as any).state].filter(Boolean).join(", ") || "Territory"
    // VERIFIED MARKET CONTEXT (wave 150, lane 150Z — lane 150KLMO Outside-lane 1 / lane 150EFG Still open 1): the Market
    // Twin's observed months of supply for THIS territory's zips, from STORED readings only (allowProviderRead:false — a
    // proposal never spends on a provider). Absent / unobserved = null with the twin's reason, and the planner says
    // "balanced" in its blind spots — never a derived number.
    const { loadMarketTwin } = await import("@/lib/market-reports/market-twin")
    const twin = await loadMarketTwin(svc, { brokerageId: ctx.brokerageId, zips: (((terr as any).zip_codes ?? []) as string[]), cities: (terr as any).city ? [String((terr as any).city)] : [], allowProviderRead: false })
    const plan = planSourceDiscovery({
      territory: { id: terr.id, brokerageId: ctx.brokerageId, label },
      budgetUsd: budget,
      enabledSources: enabled.length > 0 ? [...new Set(enabled)] : null,
      history, previews, quotes,
      marketGap: twin.marketGap.monthsOfSupply === null ? null : { monthsOfSupply: twin.marketGap.monthsOfSupply, asOf: twin.marketGap.asOf, source: twin.marketGap.source },
      distressPreviewCount: null,
    })
    const { data: inserted, error: insErr } = await svc.from("acquisition_plans").insert({
      brokerage_id: ctx.brokerageId,
      territory_id: terr.id,
      territory_label: label,
      status: "proposed",
      budget_usd: plan.budgetUsd,
      total_quote_usd: plan.totalQuoteUsd,
      market_mode: plan.marketMode,
      tilt: plan.tilt,
      lines: plan.lines,
      blind_spots: plan.blindSpots,
      planner_version: plan.plannerVersion,
      created_by_user_id: ctx.userId,
    }).select("id").maybeSingle()
    if (insErr || !inserted) return { success: false, error: `The plan could not be saved: ${insErr?.message ?? "no row returned"}` }
    return { success: true, plan, planId: (inserted as { id: string }).id }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Approve named PROPOSED lines of one of the tenant's plans — the only thing that lets a paid pull buy that tenant's
 * share. Commerce-admin seats only; ledgered; the update is tenant-pinned, status-pinned ('proposed') and COUNTED.
 */
export async function approveAcquisitionPlan(input: { planId: string; sources: string[] }): Promise<{ success: true; approved: string[]; validUntil: string } | { success: false; error: string }> {
  try {
    const ctx = await sessionGate()
    if (!UUID_RE.test(String(input?.planId ?? ""))) return { success: false, error: "Unknown plan" }
    const sources = Array.isArray(input?.sources) ? input.sources.filter((s) => typeof s === "string").slice(0, 50) : []
    if (sources.length === 0) return { success: false, error: "Pick at least one line to approve" }
    const svc = createServiceClient()
    const { data: row, error: readErr } = await svc.from("acquisition_plans").select("id, status, lines").eq("id", input.planId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
    if (readErr) return { success: false, error: `The plan could not be read: ${readErr.message}` }
    if (!row) return { success: false, error: "That plan is not one of yours" }
    if ((row as any).status !== "proposed") return { success: false, error: `This plan is ${(row as any).status} — propose a fresh one` }
    const verdict = approvePlanLines((row as any).lines ?? [], sources, { userId: ctx.userId, mayCommitSpend: TENANT_COMMERCE_ADMIN_USER_TYPES.has(ctx.userType.toLowerCase()) })
    if (!verdict.ok) return { success: false, error: `Not approved — ${verdict.reason}` }
    const maxSpend = verdict.lines.filter((l) => l.status === "approved").reduce((s, l) => s + (l.maxSpendUsd ?? 0), 0)

    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    const nowIso = new Date().toISOString()
    const done = await withActionLedger(
      {
        brokerageId: ctx.brokerageId, action: "acquisition.plan.approve", actor: { type: "user", userId: ctx.userId },
        subject: { type: "acquisition_plan", id: input.planId }, reasonCode: "HUMAN_REQUESTED", systemSource: "settings_territories_acquisition",
        reasonDetail: `approved ${verdict.approved.join(", ")} — up to $${Math.round(maxSpend * 100) / 100} (preview + quote shown first; owner rule 7: no autonomous purchases)`,
        riskClass: "FINANCIAL", cycle: `acquisition_plan_approve:${input.planId}`,
        detail: { approved: verdict.approved, max_spend_usd: maxSpend, valid_until: verdict.validUntil },
      },
      async () => {
        const { data, error } = await svc.from("acquisition_plans")
          .update({ status: "approved", lines: verdict.lines, approved_by_user_id: ctx.userId, approved_at: nowIso, valid_until: verdict.validUntil, updated_at: nowIso })
          .eq("id", input.planId).eq("brokerage_id", ctx.brokerageId).eq("status", "proposed")
          .select("id")
        if (error) return { n: 0, error: error.message as string }
        return { n: (data ?? []).length, error: null as string | null }
      },
      {
        settle: (r) => r.n === 1 ? { status: "executed", outcome: "acquisition_plan_approved", costUsd: null } : { status: "failed", outcome: "approval_matched_nothing", error: r.error ?? "0 rows matched" },
        // A refused ledger claim is NOT a replay: say which it was (the evidence census reads this hook).
        replay: (claim) => ({ n: 0, error: claim.kind === "refused" ? `the approval could not be recorded on the action ledger (${claim.error}) — nothing was approved` : "this approval was already recorded" }),
      },
      { client: svc },
    )
    if (done.n !== 1) return { success: false, error: `Not approved — ${done.error ?? "the plan changed underneath you"}` }
    return { success: true, approved: verdict.approved, validUntil: verdict.validUntil }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}
