"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "@/lib/ai/generate"
import { z } from "zod"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { revalidatePath } from "next/cache"

/**
 * AI Closing Workflow
 * Manages closing checklist generation, milestone tracking, and proactive
 * deal-health interventions. Relies on closing_checklist_items,
 * transaction_milestones, and transaction_closing_prep tables.
 */

// ============================================================================
// AI CLOSING CHECKLIST GENERATION
// ============================================================================

export async function aiGenerateClosingChecklist(params: {
  transactionId: string
  agentId: string
  brokerageId: string
}) {
  if (
    !isValidUUID(params.transactionId) ||
    !isValidUUID(params.agentId) ||
    !isValidUUID(params.brokerageId)
  ) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: transaction } = await supabase
      .from("transactions")
      .select(`
        *,
        contacts(first_name, last_name),
        transaction_lenders(loan_type, lender_name, clear_to_close_date),
        transaction_title_escrow(title_company_name, closing_scheduled_date)
      `)
      .eq("id", params.transactionId)
      .single()

    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }

    const { object: checklist } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        items: z.array(z.object({
          item_name:  z.string(),
          category:   z.enum(["title", "lender", "inspection", "documents", "financial", "agent", "client", "compliance"]),
          sequence:   z.number().int(),
          required:   z.boolean(),
          owner:      z.string().describe("Party responsible: agent, tc, lender, title, buyer, seller"),
          due_offset_days: z.number().int().describe("Days before closing date this must be complete (negative = before closing)"),
          notes:      z.string().optional(),
        })),
        closing_risk: z.enum(["low", "medium", "high"]),
        critical_path: z.array(z.string()).describe("Items that will block closing if incomplete"),
        ai_summary: z.string(),
      }),
      prompt: `Generate a complete closing checklist for this transaction:

Deal type: ${transaction.deal_type}
Purchase price: $${transaction.purchase_price?.toLocaleString() ?? "Unknown"}
Contract date: ${transaction.contract_date}
Close date: ${transaction.close_date}
Loan type: ${transaction.transaction_lenders?.[0]?.loan_type ?? "Unknown"}
Title company: ${transaction.transaction_title_escrow?.[0]?.title_company_name ?? "Unknown"}
Closing scheduled: ${transaction.transaction_title_escrow?.[0]?.closing_scheduled_date ?? "TBD"}
CTC date: ${transaction.transaction_lenders?.[0]?.clear_to_close_date ?? "TBD"}

Generate a comprehensive, ordered closing checklist covering:
- Lender requirements (appraisal, CTC, funding)
- Title requirements (title search, commitment, insurance)
- Inspection resolution
- Required documents
- Financial items (wire instructions, closing disclosure)
- Agent tasks (walk-through, final utilities)
- Client tasks
- Compliance items`,
    })

    // Map AI output to actual DB columns (closing_checklist_items schema)
    const closeDate = transaction.close_date ? new Date(transaction.close_date) : null
    const rows = checklist.items.map((item) => {
      let dueDate: string | null = null
      if (closeDate && item.due_offset_days) {
        const d = new Date(closeDate)
        d.setDate(d.getDate() + item.due_offset_days)
        dueDate = d.toISOString().split("T")[0]
      }
      return {
        transaction_id:  params.transactionId,
        brokerage_id:    params.brokerageId,
        agent_user_id:   params.agentId,
        phase:           item.category,
        item_label:      item.item_name,
        owner:           item.owner,
        due_date:        dueDate,
        completed:       false,
      }
    })

    const { error: insertError } = await supabase
      .from("closing_checklist_items")
      .insert(rows)

    if (insertError) throw insertError

    // Upsert closing prep score
    await supabase
      .from("transaction_closing_prep")
      .upsert(
        {
          transaction_id:   params.transactionId,
          brokerage_id:     params.brokerageId,
          closing_date:     transaction.close_date,
          readiness_score:  checklist.closing_risk === "low" ? 85 : checklist.closing_risk === "medium" ? 55 : 25,
          checklist:        { critical_path: checklist.critical_path, ai_summary: checklist.ai_summary },
        },
        { onConflict: "transaction_id" }
      )

    revalidatePath(`/dashboard/transactions/${params.transactionId}`)
    return {
      success: true,
      data: checklist,
      itemsCreated: rows.length,
    }
  } catch (error) {
    return handleError(error, "aiGenerateClosingChecklist")
  }
}

// ============================================================================
// GET CLOSING CHECKLIST
// ============================================================================

export async function getClosingChecklist(params: {
  transactionId: string
  agentId: string
}) {
  if (!isValidUUID(params.transactionId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: items, error } = await supabase
      .from("closing_checklist_items")
      .select("*")
      .eq("transaction_id", params.transactionId)
      .order("sequence", { ascending: true })

    if (error) throw error

    const total     = items?.length ?? 0
    const completed = items?.filter((i) => i.completed).length ?? 0
    const required  = items?.filter((i) => i.required && !i.completed).length ?? 0

    return {
      success: true,
      data: {
        items:              items ?? [],
        total,
        completed,
        remainingRequired:  required,
        percentComplete:    total > 0 ? Math.round((completed / total) * 100) : 0,
      },
    }
  } catch (error) {
    return handleError(error, "getClosingChecklist")
  }
}

// ============================================================================
// COMPLETE CHECKLIST ITEM
// ============================================================================

export async function completeChecklistItem(params: {
  itemId: string
  completedBy: string
  notes?: string
}) {
  if (!isValidUUID(params.itemId) || !isValidUUID(params.completedBy)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data, error } = await supabase
      .from("closing_checklist_items")
      .update({
        completed:    true,
        completed_at: new Date().toISOString(),
        completed_by: params.completedBy,
        notes:        params.notes ?? null,
      })
      .eq("id", params.itemId)
      .select()
      .single()

    if (error) throw error

    revalidatePath(`/dashboard/transactions`)
    return { success: true, data }
  } catch (error) {
    return handleError(error, "completeChecklistItem")
  }
}

// ============================================================================
// AI MILESTONE TRACKING
// ============================================================================

export async function aiTrackClosingMilestones(params: {
  transactionId: string
  agentId: string
  brokerageId: string
}) {
  if (
    !isValidUUID(params.transactionId) ||
    !isValidUUID(params.agentId) ||
    !isValidUUID(params.brokerageId)
  ) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: transaction } = await supabase
      .from("transactions")
      .select(`
        *,
        transaction_milestones(*),
        closing_checklist_items(completed, required)
      `)
      .eq("id", params.transactionId)
      .single()

    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }

    const completedItems = transaction.closing_checklist_items?.filter((i: any) => i.completed).length ?? 0
    const totalItems     = transaction.closing_checklist_items?.length ?? 0
    const daysToClose    = transaction.close_date
      ? Math.ceil((new Date(transaction.close_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      : null

    const { object: analysis } = await generateObject({
      model: "openai/gpt-4o-mini",
      schema: z.object({
        onTrack:           z.boolean(),
        riskLevel:         z.enum(["low", "medium", "high", "critical"]),
        atRiskMilestones:  z.array(z.string()),
        completedCount:    z.number(),
        nextAction:        z.string(),
        projectedCloseDate: z.string().optional(),
        delayRisk:         z.boolean(),
        summary:           z.string(),
      }),
      prompt: `Analyze closing progress for this transaction:

Close date: ${transaction.close_date}
Days to close: ${daysToClose ?? "Unknown"}
Deal type: ${transaction.deal_type}
Status: ${transaction.status}
Checklist: ${completedItems}/${totalItems} items complete
Milestones: ${JSON.stringify(transaction.transaction_milestones?.slice(0, 5) ?? [])}

Assess:
1. Is the deal on track?
2. What milestones are at risk?
3. What is the next critical action?
4. Is there a delay risk?`,
    })

    // Record a timeline entry for the analysis
    await supabase
      .from("transaction_timeline")
      .insert({
        transaction_id: params.transactionId,
        brokerage_id:   params.brokerageId,
        activity_type:  "ai_closing_analysis",
        description:    analysis.summary,
        performed_by:   params.agentId,
        metadata:       { riskLevel: analysis.riskLevel, onTrack: analysis.onTrack },
      })

    return { success: true, data: analysis }
  } catch (error) {
    return handleError(error, "aiTrackClosingMilestones")
  }
}

// ============================================================================
// GET CLOSING PREP SUMMARY
// ============================================================================

export async function getClosingPrepSummary(params: {
  transactionId: string
}) {
  if (!isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid transaction ID" }
  }

  const supabase = await createClient()

  try {
    const [{ data: prep }, { data: items }] = await Promise.all([
      supabase
        .from("transaction_closing_prep")
        .select("*")
        .eq("transaction_id", params.transactionId)
        .maybeSingle(),
      supabase
        .from("closing_checklist_items")
        .select("completed, required, category")
        .eq("transaction_id", params.transactionId),
    ])

    const byCategory = (items ?? []).reduce((acc, item) => {
      if (!acc[item.category]) acc[item.category] = { total: 0, completed: 0 }
      acc[item.category].total++
      if (item.completed) acc[item.category].completed++
      return acc
    }, {} as Record<string, { total: number; completed: number }>)

    return {
      success: true,
      data: {
        prep,
        byCategory,
        totalItems:         items?.length ?? 0,
        completedItems:     items?.filter((i) => i.completed).length ?? 0,
        requiredRemaining:  items?.filter((i) => i.required && !i.completed).length ?? 0,
      },
    }
  } catch (error) {
    return handleError(error, "getClosingPrepSummary")
  }
}
