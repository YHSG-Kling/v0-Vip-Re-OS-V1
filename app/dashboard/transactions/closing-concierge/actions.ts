"use server"

/**
 * /dashboard/transactions/closing-concierge — server actions.
 *
 * The page that shows the agent every typed orchestration action across
 * every active transaction they own, sorted by severity then due date.
 * Inline actions: draft email to the suggested recipient (via AI),
 * dispatch the email through the agent's provider, or mark the action
 * resolved.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"
import { dispatchEmail } from "@/lib/providers/dispatch"

export type Severity = "low" | "medium" | "high" | "urgent"
export type Recipient = "buyer" | "seller" | "lender" | "inspector" | "title" | "escrow" | "co_agent" | "agent"

export interface ConciergeAction {
  id:                 string
  transactionId:      string
  transactionLabel:   string
  closeDate:          string | null
  contractDate:       string | null
  actionType:         string
  severity:           Severity
  dueDate:            string | null
  headline:           string
  detail:             string | null
  suggestedRecipient: Recipient | null
  createdAt:          string
}

export interface ConciergeBoard {
  actions: ConciergeAction[]
  summary: { urgent: number; high: number; medium: number; low: number }
}

const SEV_ORDER: Record<Severity, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

export async function loadClosingConciergeBoard(): Promise<ConciergeBoard | { error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: agentRow } = await svc.from("agents").select("id, brokerage_id").eq("user_id", user.id).maybeSingle()
  if (!agentRow?.id) return { error: "No agent profile" }

  // Pull open actions for this agent, join transaction metadata for display
  const { data: actions } = await svc
    .from("transaction_pending_actions")
    .select(`
      id, transaction_id, action_type, severity, due_date, headline, detail,
      suggested_recipient, created_at,
      transaction:transaction_id (id, deal_name, property_address, close_date, contract_date)
    `)
    .eq("agent_id", agentRow.id)
    .eq("status", "open")
    .order("severity", { ascending: false })
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(100)

  const rows: ConciergeAction[] = (actions ?? []).map((a: any) => ({
    id:                 a.id,
    transactionId:      a.transaction_id,
    transactionLabel:   a.transaction?.deal_name ?? a.transaction?.property_address ?? "Transaction",
    closeDate:          a.transaction?.close_date ?? null,
    contractDate:       a.transaction?.contract_date ?? null,
    actionType:         a.action_type,
    severity:           a.severity as Severity,
    dueDate:            a.due_date ?? null,
    headline:           a.headline,
    detail:             a.detail ?? null,
    suggestedRecipient: a.suggested_recipient ?? null,
    createdAt:          a.created_at,
  }))

  // Defensive re-sort (Supabase severity ordering is lexicographic)
  rows.sort((a, b) => {
    const s = SEV_ORDER[a.severity] - SEV_ORDER[b.severity]
    if (s !== 0) return s
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate)
    if (a.dueDate) return -1
    if (b.dueDate) return 1
    return 0
  })

  const summary = rows.reduce(
    (acc, r) => { acc[r.severity] = (acc[r.severity] ?? 0) + 1; return acc },
    { urgent: 0, high: 0, medium: 0, low: 0 } as Record<Severity, number>
  )

  return { actions: rows, summary }
}

export async function resolveConciergeAction(
  actionId: string,
  note: string | null
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }
  const svc = createServiceClient()
  const { error } = await svc
    .from("transaction_pending_actions")
    .update({
      status:          "resolved",
      resolved_at:     new Date().toISOString(),
      resolved_by:     user.id,
      resolution_note: note,
    })
    .eq("id", actionId)
    .eq("status", "open")
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function dismissConciergeAction(
  actionId: string,
  note: string | null
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }
  const svc = createServiceClient()
  const { error } = await svc
    .from("transaction_pending_actions")
    .update({ status: "dismissed", resolved_at: new Date().toISOString(), resolved_by: user.id, resolution_note: note })
    .eq("id", actionId)
    .eq("status", "open")
  if (error) return { success: false, error: error.message }
  return { success: true }
}

/**
 * AI-draft an email to the suggested recipient about this action. The action's
 * headline + detail + transaction context fly straight into the prompt. The
 * agent reviews + sends from their own inbox via mailto OR the dispatch
 * helper below.
 */
export async function draftConciergeActionEmail(
  actionId: string
): Promise<{ success: boolean; subject?: string; body?: string; suggestedRecipientEmail?: string | null; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()

  const { data: action } = await svc
    .from("transaction_pending_actions")
    .select("id, action_type, headline, detail, suggested_recipient, transaction_id, due_date, brokerage_id, agent_id")
    .eq("id", actionId)
    .maybeSingle()
  if (!action) return { success: false, error: "Action not found" }

  // Pull transaction + recipient contact info in parallel
  const [{ data: txn }, { data: lender }, { data: title }, { data: insp }, { data: agentUser }] = await Promise.all([
    svc.from("transactions").select("id, deal_name, property_address, close_date, contract_date, buyer_contact_id, seller_contact_id").eq("id", action.transaction_id).maybeSingle(),
    svc.from("transaction_lenders").select("lender_name, loan_officer_name, loan_officer_email").eq("transaction_id", action.transaction_id).maybeSingle(),
    svc.from("transaction_title_escrow").select("title_company_name, title_officer_name, title_officer_email, escrow_officer_name, escrow_officer_email").eq("transaction_id", action.transaction_id).maybeSingle(),
    svc.from("transaction_inspections").select("inspector_name, inspector_email, inspector_company").eq("transaction_id", action.transaction_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    svc.from("users").select("first_name, last_name").eq("id", user.id).maybeSingle(),
  ])

  // Pull buyer / seller contacts if needed
  let buyerEmail: string | null = null
  let sellerEmail: string | null = null
  if (txn?.buyer_contact_id) {
    const { data: c } = await svc.from("contacts").select("email").eq("id", txn.buyer_contact_id).maybeSingle()
    buyerEmail = c?.email ?? null
  }
  if (txn?.seller_contact_id) {
    const { data: c } = await svc.from("contacts").select("email").eq("id", txn.seller_contact_id).maybeSingle()
    sellerEmail = c?.email ?? null
  }

  // Pick the most likely email + readable name based on suggested_recipient
  let recipientEmail: string | null = null
  let recipientName: string | null = null
  switch (action.suggested_recipient) {
    case "buyer":     recipientEmail = buyerEmail; recipientName = "buyer"; break
    case "seller":    recipientEmail = sellerEmail; recipientName = "seller"; break
    case "lender":    recipientEmail = lender?.loan_officer_email ?? null; recipientName = lender?.loan_officer_name ?? "loan officer"; break
    case "inspector": recipientEmail = insp?.inspector_email ?? null; recipientName = insp?.inspector_name ?? "inspector"; break
    case "title":     recipientEmail = title?.title_officer_email ?? null; recipientName = title?.title_officer_name ?? "title officer"; break
    case "escrow":    recipientEmail = title?.escrow_officer_email ?? null; recipientName = title?.escrow_officer_name ?? "escrow officer"; break
    case "co_agent":  recipientName = "the listing agent"; break
    default:          recipientName = "the team"
  }

  const agentName = [agentUser?.first_name, agentUser?.last_name].filter(Boolean).join(" ") || "the agent"
  const propertyLabel = txn?.property_address ?? txn?.deal_name ?? "the transaction"
  const closeLabel = txn?.close_date ? `, closing ${txn.close_date}` : ""

  const prompt = `You are a residential real-estate agent named ${agentName}. Write a SHORT, professional email to ${recipientName} about the following situation. Be specific and courteous; ask for the next action clearly. Maximum 130 words.

PROPERTY: ${propertyLabel}${closeLabel}
SITUATION: ${action.headline}
DETAIL: ${action.detail ?? ""}
${action.due_date ? `DUE DATE: ${action.due_date}` : ""}

Write the email body only (no subject). End with: "Thanks — ${agentName}".`

  try {
    const result = await generateTextRouted({
      feature:     "closing_concierge_email",
      brokerageId: action.brokerage_id,
      system:      "You write concise, professional real-estate transaction emails. Direct but warm.",
      prompt,
      temperature: 0.4,
    })
    const body = result.text.trim()
    const subject = `${action.headline} — ${propertyLabel}`
    return { success: true, subject, body, suggestedRecipientEmail: recipientEmail }
  } catch (err: any) {
    return { success: false, error: err?.message ?? "AI draft failed" }
  }
}

/**
 * Dispatch the (reviewed) email through the platform's provider stack.
 * Stamps dispatched_email_id back on the action row so the audit trail
 * shows the agent actually sent something.
 */
export async function dispatchConciergeActionEmail(args: {
  actionId:       string
  recipientEmail: string
  subject:        string
  body:           string
}): Promise<{ success: boolean; error?: string; providerKey?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: action } = await svc
    .from("transaction_pending_actions")
    .select("id, brokerage_id, transaction_id, agent_id")
    .eq("id", args.actionId)
    .maybeSingle()
  if (!action) return { success: false, error: "Action not found" }

  const { data: agentUser } = await svc.from("users").select("email").eq("id", user.id).maybeSingle()
  const fromEmail = agentUser?.email ?? "noreply@example.com"

  const result = await dispatchEmail({
    brokerageId:    action.brokerage_id,
    userId:         user.id,
    agentId:        user.id,
    from:           fromEmail,
    to:             args.recipientEmail,
    subject:        args.subject,
    html:           args.body.replace(/\n/g, "<br/>"),
    text:           args.body,
    channelPurpose: "conversation",
    systemSource:   "closing_concierge",
    metadata:       { action_id: action.id, transaction_id: action.transaction_id },
  })

  if (!result.success) return { success: false, error: result.error }

  // Stamp the dispatch on the action so the agent's resolve UI can show it
  await svc
    .from("transaction_pending_actions")
    .update({ dispatched_email_id: action.id, updated_at: new Date().toISOString() })
    .eq("id", action.id)

  return { success: true, providerKey: result.providerKey }
}
