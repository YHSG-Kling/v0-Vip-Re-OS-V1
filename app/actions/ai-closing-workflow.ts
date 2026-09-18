"use server"

import { createClient } from "@/lib/supabase/server"
import { resolveWriteContextForTenant } from "@/lib/platform/acting-context"
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
    // AMBIGUOUS EMBED — the `!constraint` hint is load-bearing, DO NOT remove it.
    // `transactions` has THREE foreign keys to `contacts` (transactions_contact_id_fkey,
    // transactions_buyer_contact_id_fkey, transactions_seller_contact_id_fkey). With a
    // bare `contacts(...)` embed PostgREST cannot pick one and refuses the ENTIRE
    // request with PGRST201 — which means `transaction` came back null and this
    // function reported "Transaction not found" for a transaction that plainly exists.
    // Every closing checklist generated from this path was dead for that reason.
    //
    // `contact_id` is the party WE represent on the deal (documented on the canonical
    // writer, lib/transactions/offer-bridge.ts:302). The checklist is the agent's own
    // closing runbook, so the client it names is our client — not the counterparty in
    // buyer_contact_id / seller_contact_id, either of which is null on the other side
    // of a one-sided deal.
    const { data: transaction, error: transactionError } = await supabase
      .from("transactions")
      .select(`
        deal_type, purchase_price, contract_date, close_date,
        contacts!transactions_contact_id_fkey(first_name, last_name),
        transaction_lenders(loan_type, lender_name, clear_to_close_date),
        transaction_title_escrow(title_company_name, closing_scheduled_date)
      `)
      .eq("id", params.transactionId)
      .single()

    // A refused read RESOLVES in supabase-js. Without this the refusal above was
    // reported as "Transaction not found" — an absence, not the hard error it was.
    if (transactionError) {
      return { success: false, error: `Could not read the transaction: ${transactionError.message}` }
    }
    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }

    // The client embed is now actually consumed. It was selected and never read,
    // which is how the ambiguity survived unnoticed for so long.
    //
    // SHAPE: transactions.contact_id -> contacts is MANY-TO-ONE, so PostgREST
    // returns an OBJECT here, not an array. supabase-js's inference widens a
    // hinted embed to an array regardless of direction, so this normalizes both
    // rather than asserting one — an assertion would be a lie in whichever
    // direction it turned out to be wrong.
    const clientEmbed = transaction.contacts as unknown
    const client = (Array.isArray(clientEmbed) ? clientEmbed[0] : clientEmbed) as
      { first_name: string | null; last_name: string | null } | null | undefined
    const clientName = [client?.first_name, client?.last_name].filter(Boolean).join(" ") || "Unknown"

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

Client we represent: ${clientName}
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

    // Map AI output to the LIVE closing_checklist_items schema (pass 13: the old
    // shape wrote five phantom columns that don't exist on this table, so EVERY
    // generate threw and the checklist feature was dead).
    // Real columns: item_name, category, sequence, required, completed, notes.
    // Owner + due date ride in notes (no dedicated columns; the deadline rail is
    // transaction_deadlines/calendar_events, not this table).
    const closeDate = transaction.close_date ? new Date(transaction.close_date) : null
    const rows = checklist.items.map((item, idx) => {
      let dueDate: string | null = null
      if (closeDate && item.due_offset_days) {
        const d = new Date(closeDate)
        d.setDate(d.getDate() + item.due_offset_days)
        dueDate = d.toISOString().split("T")[0]
      }
      const noteBits = [
        `owner: ${item.owner}`,
        dueDate ? `due: ${dueDate}` : null,
        item.notes || null,
      ].filter(Boolean)
      return {
        transaction_id:  params.transactionId,
        brokerage_id:    params.brokerageId,
        item_name:       item.item_name,
        category:        item.category,
        sequence:        Number.isFinite(item.sequence) ? item.sequence : idx,
        required:        item.required,
        completed:       false,
        notes:           noteBits.join(" · "),
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

/**
 * AI deal-health read on a transaction's closing progress.
 *
 * The `resolveWriteContext()` gate is NEW. This is a `"use server"` export and
 * it had no authentication: it accepted `transactionId`, `agentId` AND
 * `brokerageId` from the caller, UUID-shape-checked them, ran a `generateObject`
 * model call, and then INSERTed a `transaction_timeline` row stamped with the
 * caller's own `brokerage_id` and `performed_by`. So it was, in one endpoint:
 *   · unauthenticated, unmetered AI spend anyone could loop; and
 *   · a way to write a forged audit line into another tenant's deal timeline,
 *     attributed to any user id the caller chose.
 *
 * Both identity inputs now come from the session, and the transaction must
 * belong to the caller's brokerage before a single token is spent — the tenant
 * check is deliberately BEFORE the model call, not after.
 *
 * NOTE FOR THE OWNER: the other exports in this file
 * (`aiGenerateClosingChecklist`, `getClosingChecklist`, `completeChecklistItem`,
 * `getClosingPrepSummary`) have the SAME shape — caller-supplied
 * agentId/brokerageId, no session check — and `aiGenerateClosingChecklist` also
 * spends on a model. They are wired, so hardening them is a change with real
 * callers behind it and is left as a deliberate, separate decision rather than
 * smuggled in here.
 */
export async function aiTrackClosingMilestones(params: {
  transactionId: string
  /** ignored — the actor is the authenticated caller */
  agentId?: string
  /** ignored — the tenant is the authenticated caller's */
  brokerageId?: string
}) {
  if (!isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.brokerageId || !ctx.userId) {
    return { success: false, error: "Unauthorized" }
  }
  const brokerageId = ctx.brokerageId
  const actorUserId = ctx.userId

  const supabase = ctx.db

  try {
    // Tenant-anchored, and the error is destructured: a refused read must not
    // fall through to "Transaction not found" and it must certainly not fall
    // through to a paid model call.
    const { data: transaction, error: txErr } = await supabase
      .from("transactions")
      .select(`
        *,
        transaction_milestones(*),
        closing_checklist_items(completed, required)
      `)
      .eq("id", params.transactionId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (txErr) {
      return { success: false, error: "Could not load that transaction." }
    }

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

    // Record a timeline entry for the analysis.
    //
    // performed_by is a users.id, not an agents.id — every other writer in the
    // repo puts `user.id` / `ctx.userId` there (transaction-compliance.ts:79,
    // dotloop-integration.ts:343, and see the explicit note at
    // dotloop-integration.ts:1447 about a contacts id having once landed in this
    // column). This used to write `params.agentId`. agents.id and users.id are
    // disjoint id spaces, so that stamped a meaningless actor on every row.
    // ctx.userId is the resolved authenticated user — the right space, resolved
    // rather than substituted.
    const { error: timelineErr } = await supabase
      .from("transaction_timeline")
      .insert({
        transaction_id: params.transactionId,
        brokerage_id:   brokerageId,
        activity_type:  "ai_closing_analysis",
        description:    analysis.summary,
        performed_by:   actorUserId,
        metadata:       { riskLevel: analysis.riskLevel, onTrack: analysis.onTrack },
      })

    // The analysis is still returned — the model call already happened and the
    // caller should get what it paid for — but a dropped audit line is logged
    // rather than swallowed, which is what an undestructured insert did before.
    if (timelineErr) {
      console.error("[aiTrackClosingMilestones] timeline insert failed:", timelineErr.message)
    }

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
