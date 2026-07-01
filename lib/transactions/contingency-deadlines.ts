// lib/transactions/contingency-deadlines.ts
//
// CONTINGENCY DEADLINE TRACKING — the silent-killer fix. An accepted offer's contingencies
// (offers.contingencies, a text[]) drive real deadlines, but the milestone seeder only tracks the
// STANDARD ones (inspection / financing / appraisal already become watched milestones). The
// NON-STANDARD contingencies — home-sale, HOA-doc review, title review, insurance/insurability,
// survey, attorney review — were UNTRACKED: their deadline could pass silently and stall or kill the
// deal. This turns each recognized non-standard contingency into a real row in the EXISTING
// transaction_deadlines table (NOT a parallel system), so the existing deadline-watcher escalates it
// like any other deadline. Standard contingencies are deliberately EXCLUDED here to avoid duplicating
// the milestone deadlines (no drift).
//
// The planner is PURE (unit-tested); ensureContingencyDeadlines does the idempotent I/O.

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

interface ContingencyRule { deadlineType: string; defaultDays: number }

// NON-STANDARD contingencies only. inspection / financing / appraisal / loan are intentionally
// omitted — they're already tracked as milestone deadlines (INSPECTION_DEADLINE, FINANCING_DEADLINE,
// APPRAISAL_DEADLINE), and re-seeding them here would create duplicate deadlines.
const CONTINGENCY_RULES: Record<string, ContingencyRule> = {
  home_sale:        { deadlineType: "contingency_home_sale",       defaultDays: 45 },
  hoa_review:       { deadlineType: "contingency_hoa_review",      defaultDays: 10 },
  title_review:     { deadlineType: "contingency_title_review",    defaultDays: 10 },
  insurance:        { deadlineType: "contingency_insurance",       defaultDays: 14 },
  survey:           { deadlineType: "contingency_survey",          defaultDays: 14 },
  lead_paint:       { deadlineType: "contingency_lead_paint",      defaultDays: 10 },
  well_septic:      { deadlineType: "contingency_well_septic",     defaultDays: 14 },
  attorney_review:  { deadlineType: "contingency_attorney_review", defaultDays: 5 },
}

// Map the many ways a contingency is written to a canonical rule key. Returns null for standard /
// unrecognized contingencies (which are milestone-tracked or have no default period).
export function normalizeContingencyType(raw: string): string | null {
  const s = (raw ?? "").toLowerCase().replace(/[\s-]+/g, "_").replace(/_contingency$/, "").replace(/_+/g, "_").trim()
  const alias: Record<string, string> = {
    home_sale: "home_sale", sale_of_home: "home_sale", sale_of_buyer_home: "home_sale", homesale: "home_sale",
    hoa: "hoa_review", hoa_review: "hoa_review", hoa_docs: "hoa_review", hoa_document_review: "hoa_review", condo_docs: "hoa_review",
    title: "title_review", title_review: "title_review", title_search: "title_review",
    insurance: "insurance", insurability: "insurance", homeowners_insurance: "insurance", hazard_insurance: "insurance",
    survey: "survey",
    lead_paint: "lead_paint", lead_based_paint: "lead_paint",
    well_septic: "well_septic", septic: "well_septic", well: "well_septic", well_and_septic: "well_septic",
    attorney: "attorney_review", attorney_review: "attorney_review", attorney_approval: "attorney_review",
  }
  const key = alias[s] ?? null
  return key && CONTINGENCY_RULES[key] ? key : null
}

export interface PlannedContingencyDeadline { deadlineType: string; deadlineDate: string; contingency: string }

/**
 * PURE: turn an accepted offer's contingencies + the contract date into deadline rows. Only recognized
 * NON-STANDARD contingencies produce a deadline (calendar-day default period the agent can adjust);
 * deduped by deadline_type. Returns [] when there's no contract date or no trackable contingency.
 */
export function planContingencyDeadlines(
  contingencies: string[] | null | undefined,
  contractDate: string | null | undefined,
): PlannedContingencyDeadline[] {
  if (!contractDate) return []
  const base = Date.parse(`${contractDate.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(base)) return []
  const seen = new Set<string>()
  const out: PlannedContingencyDeadline[] = []
  for (const raw of contingencies ?? []) {
    const key = normalizeContingencyType(raw)
    if (!key) continue
    const rule = CONTINGENCY_RULES[key]
    if (seen.has(rule.deadlineType)) continue
    seen.add(rule.deadlineType)
    const d = new Date(base + rule.defaultDays * 86_400_000)
    out.push({ deadlineType: rule.deadlineType, deadlineDate: d.toISOString().slice(0, 10), contingency: key })
  }
  return out
}

/**
 * Seed the accepted offer's non-standard contingency deadlines into transaction_deadlines (the same
 * table the deadline-watcher escalates). Idempotent — dedupes by (transaction_id, deadline_type), so a
 * re-run (or a deadline the milestone system already owns) is never duplicated. Best-effort.
 */
export async function ensureContingencyDeadlines(
  svc: Svc,
  params: { transactionId: string; brokerageId: string },
): Promise<{ planned: number; inserted: number }> {
  const { data: txn } = await svc
    .from("transactions")
    .select("id, contract_date")
    .eq("id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!txn) return { planned: 0, inserted: 0 }

  const { data: offer } = await svc
    .from("offers")
    .select("contingencies")
    .eq("transaction_id", params.transactionId)
    .order("responded_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  const plan = planContingencyDeadlines(
    (offer as { contingencies?: string[] | null } | null)?.contingencies ?? null,
    (txn as { contract_date?: string | null }).contract_date ?? null,
  )
  if (plan.length === 0) return { planned: 0, inserted: 0 }

  // Which of these deadline_types already exist for the transaction (dedupe against ourselves + any
  // milestone-owned deadline that happens to share the type)?
  const { data: existing } = await svc
    .from("transaction_deadlines")
    .select("deadline_type")
    .eq("transaction_id", params.transactionId)
    .in("deadline_type", plan.map((p) => p.deadlineType))
  const have = new Set(((existing ?? []) as Array<{ deadline_type: string }>).map((r) => r.deadline_type))

  const rows = plan
    .filter((p) => !have.has(p.deadlineType))
    .map((p) => ({
      transaction_id: params.transactionId,
      brokerage_id: params.brokerageId,
      deadline_type: p.deadlineType,
      deadline_date: p.deadlineDate,
      status: "pending" as const,
      notes: `Auto-tracked from the accepted offer's ${p.contingency.replace(/_/g, " ")} contingency (default period — adjust to the contract).`,
    }))
  if (rows.length === 0) return { planned: plan.length, inserted: 0 }

  const { error } = await svc.from("transaction_deadlines").insert(rows)
  if (error) return { planned: plan.length, inserted: 0 }
  return { planned: plan.length, inserted: rows.length }
}
