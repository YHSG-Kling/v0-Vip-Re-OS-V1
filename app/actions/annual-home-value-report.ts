"use server"

/**
 * app/actions/annual-home-value-report.ts
 *
 * Home-value report generated for every lifetime customer:
 *   - on each closing anniversary (1y / 2y / 3y / ...)
 *   - every quarter in between (3m / 6m / 9m from anniversary)
 *
 * The report is written into lifetime_customer_touchpoints AND emailed to
 * the past client directly. The email is what replaces the agent's
 * HomeBot / Cloze / Cash Offer subscription. Routes through dispatchEmail
 * which handles TCPA / opt-out compliance + records vendor usage so the
 * agent's AI ROI dashboard credits the send.
 *
 * No new tables — uses existing transactions, contacts,
 * lifetime_customer_touchpoints.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { dispatchEmail } from "@/lib/providers/dispatch"
import { buildHomeValueEmailHtml, buildHomeValueEmailSubject } from "@/lib/marketing/home-value-email"

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
      "id, brokerage_id, property_address, close_date, purchase_price, agent_id",
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

  // Prefer a recent home_value_estimates row (this is the live AVM table —
  // there is no `property_valuations` table); fall back to a 4%/yr regional
  // default so the report is never empty.
  const originalPrice = Number(txn.purchase_price ?? 0) || null
  let currentValue: number | null = null
  let comparablesUsed = 0
  let marketSummary = ""

  const { data: latestValuation } = await supabase
    .from("home_value_estimates")
    .select("estimated_value_mid, estimated_value_low, estimated_value_high, estimated_equity, comps_json, ai_narrative, generated_at")
    .eq("contact_id", input.contactId)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latestValuation) {
    currentValue = Number(latestValuation.estimated_value_mid)
    comparablesUsed = Array.isArray(latestValuation.comps_json) ? latestValuation.comps_json.length : 0
    marketSummary = (latestValuation.ai_narrative as string) ?? ""
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

  // home_value_estimates already carries the equity column when available.
  const estimatedEquity =
    latestValuation?.estimated_equity != null
      ? Number(latestValuation.estimated_equity)
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

    // Idempotency check — lifetime_customer_touchpoints actual columns are
    // touchpoint_type / scheduled_date / sent_date / engagement_data (no
    // `payload` column, no `scheduled_for` column).
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

    // Ship the email AND record the touchpoint. The touchpoint engagement_data
    // carries the dispatch result so the agent's ROI dashboard can credit it.
    const emailResult = await sendHomeValueReportEmail({
      report,
      brokerageId:   c.brokerage_id as string,
      agentUserId:   c.agent_id as string | null,
      contactId:     c.buyer_contact_id as string,
      cadence:       "anniversary",
    })

    await supabase.from("lifetime_customer_touchpoints").insert({
      brokerage_id:           c.brokerage_id,
      agent_id:               c.agent_id,
      contact_id:             c.buyer_contact_id,
      touchpoint_type:        "annual_home_value_report",
      channel:                emailResult.sent ? "email" : "in_app",
      status:                 emailResult.sent ? "sent" : "pending_review",
      scheduled_date:         new Date().toISOString().slice(0, 10),
      sent_date:              emailResult.sent ? new Date().toISOString().slice(0, 10) : null,
      related_transaction_id: c.id,
      engagement_data:        { ...report, email_dispatch: emailResult },
    })

    generated.push({ contactId: c.buyer_contact_id as string, transactionId: c.id as string, ok: true })
  }

  return { processed: generated.length, generated }
}

// ────────────────────────────────────────────────────────────────────────────
// Email dispatch helper — shared between the annual + quarterly crons
// ────────────────────────────────────────────────────────────────────────────

interface EmailDispatchResult {
  sent:        boolean
  providerKey?: string
  error?:      string
}

async function sendHomeValueReportEmail(args: {
  report:        AnnualHomeValueReport
  brokerageId:   string
  agentUserId:   string | null
  contactId:     string
  cadence:       "anniversary" | "quarterly"
}): Promise<EmailDispatchResult> {
  const svc = createServiceClient()

  // Need the contact's email + the agent's display info + the brokerage brand.
  const [{ data: contact }, { data: brokerage }, { data: agentUser }] = await Promise.all([
    svc.from("contacts").select("email, first_name, last_name").eq("id", args.contactId).maybeSingle(),
    svc.from("brokerages").select("name, logo_url, primary_color, license_number, license_state").eq("id", args.brokerageId).maybeSingle(),
    args.agentUserId
      ? svc.from("users").select("first_name, last_name, email, phone").eq("id", args.agentUserId).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  if (!contact?.email)        return { sent: false, error: "contact has no email" }
  if (!brokerage?.name)       return { sent: false, error: "brokerage missing name" }

  // Build the HTML + subject using the brand-compliant template
  const ctx = {
    report:    args.report,
    brokerage: {
      name:          brokerage.name,
      logoUrl:       brokerage.logo_url ?? null,
      licenseNumber: brokerage.license_number ?? null,
      licenseState:  brokerage.license_state ?? null,
      primaryColor:  brokerage.primary_color ?? null,
    },
    agent: {
      firstName: agentUser?.first_name ?? null,
      lastName:  agentUser?.last_name ?? null,
      email:     agentUser?.email ?? null,
      phone:     agentUser?.phone ?? null,
      photoUrl:  null,  // future: pull from agents.profile_photo_url
    },
    cadence: args.cadence,
  }

  const subject = buildHomeValueEmailSubject(ctx)
  const html    = buildHomeValueEmailHtml(ctx)

  // dispatchEmail handles: TCPA opt-out gate, assembleEmail (unsubscribe link
  // injection + signature + legal), provider selection, vendor usage logging.
  const dispatchResult = await dispatchEmail({
    brokerageId:   args.brokerageId,
    userId:        args.agentUserId ?? args.brokerageId,
    agentId:       args.agentUserId ?? undefined,
    contactId:     args.contactId,
    from:          agentUser?.email ?? `noreply@${brokerage.name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.com`,
    to:            contact.email,
    subject,
    html,
    channelPurpose: "update",
    systemSource:   "home_value_report",
    metadata: {
      cadence:           args.cadence,
      years_owned:       args.report.yearsOwned,
      property_address:  args.report.propertyAddress,
      estimated_value:   args.report.currentEstimatedValue,
    },
  })

  return {
    sent:        dispatchResult.success,
    providerKey: dispatchResult.providerKey,
    error:       dispatchResult.error,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Quarterly cron — sends a fresh value check-in every 90 days BETWEEN
// closing anniversaries, so past clients hear from the agent ~4×/year
// instead of just once. This is what makes the platform a HomeBot replacement.
// ────────────────────────────────────────────────────────────────────────────

export async function generateQuarterlyHomeValueReportsCronTick() {
  const supabase = createServiceClient()
  const today = new Date()
  const todayMD = `${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`

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

  const generated: Array<{ contactId: string; transactionId: string; ok: boolean; cadence: "quarterly"; reason?: string }> = []

  for (const c of candidates ?? []) {
    const close = new Date(c.close_date as string)

    // Quarterly cadence: send at +3mo, +6mo, +9mo from the close date.
    // Annual (+12mo) is handled by the anniversary cron — skip it here so
    // a contact doesn't get two emails on the same day.
    const monthsSinceClose =
      (today.getFullYear() - close.getFullYear()) * 12 + (today.getMonth() - close.getMonth())
    const dayMatch = close.getDate() === today.getDate()
    const isQuarterMark = dayMatch && monthsSinceClose > 0 && monthsSinceClose % 3 === 0 && monthsSinceClose % 12 !== 0
    if (!isQuarterMark) continue

    // Idempotency: did we already send a quarterly report this period?
    // Use a period key like "2026-Q1-3mo" baked into engagement_data.period_key.
    const periodKey = `${today.getFullYear()}-m${monthsSinceClose}`
    const { data: existing } = await supabase
      .from("lifetime_customer_touchpoints")
      .select("id, engagement_data")
      .eq("contact_id", c.buyer_contact_id as string)
      .eq("touchpoint_type", "quarterly_home_value_report")
      .gte("created_at", new Date(today.getTime() - 10 * 86_400_000).toISOString())
    const alreadySent = (existing ?? []).some(
      (e: any) => (e.engagement_data?.period_key as string | undefined) === periodKey
    )
    if (alreadySent) continue

    const report = await buildAnnualHomeValueReport({
      contactId: c.buyer_contact_id as string,
      closedTransactionId: c.id as string,
    })
    if (!report) {
      generated.push({ contactId: c.buyer_contact_id as string, transactionId: c.id as string, ok: false, cadence: "quarterly", reason: "no report" })
      continue
    }

    const emailResult = await sendHomeValueReportEmail({
      report,
      brokerageId:  c.brokerage_id as string,
      agentUserId:  c.agent_id as string | null,
      contactId:    c.buyer_contact_id as string,
      cadence:      "quarterly",
    })

    await supabase.from("lifetime_customer_touchpoints").insert({
      brokerage_id:           c.brokerage_id,
      agent_id:               c.agent_id,
      contact_id:             c.buyer_contact_id,
      touchpoint_type:        "quarterly_home_value_report",
      channel:                emailResult.sent ? "email" : "in_app",
      status:                 emailResult.sent ? "sent" : "pending_review",
      scheduled_date:         new Date().toISOString().slice(0, 10),
      sent_date:              emailResult.sent ? new Date().toISOString().slice(0, 10) : null,
      related_transaction_id: c.id,
      engagement_data:        { ...report, period_key: periodKey, email_dispatch: emailResult },
    })

    generated.push({
      contactId:     c.buyer_contact_id as string,
      transactionId: c.id as string,
      ok:            emailResult.sent,
      cadence:       "quarterly",
      reason:        emailResult.sent ? undefined : emailResult.error,
    })
  }

  return { processed: generated.length, generated }
}
