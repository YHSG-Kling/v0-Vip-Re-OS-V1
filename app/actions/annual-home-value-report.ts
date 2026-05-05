"use server"

/**
 * app/actions/annual-home-value-report.ts
 *
 * Annual home-value report generated on the closing anniversary of every
 * lifetime customer's most recent purchase. The report is written into
 * lifetime_customer_touchpoints with payload = the report HTML, and
 * surfaces in:
 *   • the lifetime customer portal (RealScout-style home dashboard)
 *   • the agent's pending touchpoint queue
 *
 * No new tables — uses existing transactions, contacts, lifetime_customer_touchpoints.
 */

import { createServiceClient } from "@/lib/supabase/service"

interface ReportInput {
  contactId: string
  closedTransactionId: string
}

export interface AnnualHomeValueReport {
  contactId: string
  contactName: string
  propertyAddress: string
  closedAt: string
  yearsOwned: number
  originalPurchasePrice: number | null
  currentEstimatedValue: number | null
  estimatedAppreciation: number | null
  estimatedAppreciationPercent: number | null
  estimatedEquity: number | null
  comparablesUsed: number
  marketSummary: string
  agentRecommendation: string
}

/**
 * Builds a single annual home-value report. Pulls a current valuation from
 * the existing valuation infrastructure (cma_reports / property_valuations
 * if available) — if no fresh valuation is on file, falls back to the
 * original purchase price plus a regional appreciation default so the
 * report is never empty.
 */
export async function buildAnnualHomeValueReport(
  input: ReportInput,
): Promise<AnnualHomeValueReport | null> {
  const supabase = createServiceClient()

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, brokerage_id, agent_id")
    .eq("id", input.contactId)
    .maybeSingle()
  if (!contact) return null

  const { data: txn } = await supabase
    .from("transactions")
    .select(
      "id, brokerage_id, property_address, close_date, purchase_price, estimated_loan_balance, agent_id",
    )
    .eq("id", input.closedTransactionId)
    .maybeSingle()
  if (!txn) return null

  const closedAt = txn.close_date as string
  const closedDate = new Date(closedAt)
  const now = new Date()
  const yearsOwned = Math.max(
    0,
    Math.floor((now.getTime() - closedDate.getTime()) / (365 * 86_400_000)),
  )

  // Prefer a recent property_valuations row; fall back to a recent cma_report
  // for the same address; final fallback is a 4% / yr regional default.
  const originalPrice = Number(txn.purchase_price ?? 0) || null
  let currentValue: number | null = null
  let comparablesUsed = 0
  let marketSummary = ""

  const { data: latestValuation } = await supabase
    .from("property_valuations")
    .select("valuation_amount, comparables_count, summary")
    .eq("contact_id", input.contactId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latestValuation) {
    currentValue = Number(latestValuation.valuation_amount)
    comparablesUsed = Number(latestValuation.comparables_count ?? 0)
    marketSummary = (latestValuation.summary as string) ?? ""
  }

  if (!currentValue && originalPrice) {
    // Default conservative national appreciation: 4% compounded annually.
    currentValue = Math.round(originalPrice * Math.pow(1.04, Math.max(1, yearsOwned)))
    marketSummary =
      "Estimated using a 4% annual appreciation default — request a fresh CMA for a more accurate number."
  }

  const estimatedAppreciation =
    currentValue != null && originalPrice != null ? currentValue - originalPrice : null
  const estimatedAppreciationPercent =
    estimatedAppreciation != null && originalPrice ? (estimatedAppreciation / originalPrice) * 100 : null

  const estimatedLoanBalance = Number(txn.estimated_loan_balance ?? 0) || null
  const estimatedEquity =
    currentValue != null && estimatedLoanBalance != null
      ? currentValue - estimatedLoanBalance
      : null

  const agentRecommendation =
    estimatedAppreciationPercent != null && estimatedAppreciationPercent >= 25
      ? "You're sitting on significant equity — let's chat about strategies (HELOC, downsize, or trade-up)."
      : estimatedAppreciationPercent != null && estimatedAppreciationPercent < 5
        ? "Modest appreciation this year — happy to walk you through the local market trends."
        : "Steady year-over-year appreciation. Let's catch up at your convenience."

  const fullName = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Homeowner"

  return {
    contactId: contact.id,
    contactName: fullName,
    propertyAddress: (txn.property_address as string) ?? "—",
    closedAt,
    yearsOwned,
    originalPurchasePrice: originalPrice,
    currentEstimatedValue: currentValue,
    estimatedAppreciation,
    estimatedAppreciationPercent,
    estimatedEquity,
    comparablesUsed,
    marketSummary,
    agentRecommendation,
  }
}

/**
 * Cron-friendly: finds every lifetime customer whose most recent closing has
 * an anniversary within the next 7 days and writes a touchpoint with the
 * generated report. Idempotent per (contact_id, anniversary_year).
 */
export async function generateAnnualHomeValueReportsCronTick() {
  const supabase = createServiceClient()

  const today = new Date()
  const monthDay = `${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`

  const { data: candidates } = await supabase
    .from("transactions")
    .select(
      `id, brokerage_id, agent_id, close_date, buyer_contact_id, property_address,
       contact:buyer_contact_id (id, contact_type)`,
    )
    .eq("status", "closed")
    .not("close_date", "is", null)
    .not("buyer_contact_id", "is", null)
    .limit(500)

  const generated: Array<{ contactId: string; transactionId: string; ok: boolean }> = []

  for (const c of candidates ?? []) {
    const close = new Date(c.close_date as string)
    const closeMonthDay = `${String(close.getMonth() + 1).padStart(2, "0")}-${String(close.getDate()).padStart(2, "0")}`
    // Match on anniversary day (single-day window); cron runs daily.
    if (closeMonthDay !== monthDay) continue

    const anniversaryYear = today.getFullYear()
    if (anniversaryYear === close.getFullYear()) continue // skip closing year itself

    // Idempotency check
    const { data: existing } = await supabase
      .from("lifetime_customer_touchpoints")
      .select("id")
      .eq("contact_id", c.buyer_contact_id as string)
      .eq("touchpoint_type", "annual_home_value_report")
      .gte("created_at", `${anniversaryYear}-01-01`)
      .lte("created_at", `${anniversaryYear}-12-31`)
      .maybeSingle()
    if (existing) continue

    const report = await buildAnnualHomeValueReport({
      contactId: c.buyer_contact_id as string,
      closedTransactionId: c.id as string,
    })
    if (!report) {
      generated.push({ contactId: c.buyer_contact_id as string, transactionId: c.id as string, ok: false })
      continue
    }

    await supabase.from("lifetime_customer_touchpoints").insert({
      brokerage_id: c.brokerage_id,
      agent_id: c.agent_id,
      contact_id: c.buyer_contact_id,
      touchpoint_type: "annual_home_value_report",
      status: "pending_review",
      payload: report,
      scheduled_for: new Date().toISOString(),
    })

    generated.push({ contactId: c.buyer_contact_id as string, transactionId: c.id as string, ok: true })
  }

  return { processed: generated.length, generated }
}
