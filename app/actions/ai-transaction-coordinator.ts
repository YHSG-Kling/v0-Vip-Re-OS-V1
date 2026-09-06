"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"
import { TRANSACTION_STATUSES_IN_ESCROW } from "@/lib/transactions/transaction-status"
import { DEADLINE_STATUSES } from "@/lib/transactions/coordination-status"
import { getAgentContext } from "@/lib/identity/get-agent-context"

// ============================================
// HELPERS
// ============================================

/**
 * THE LIVE `transaction_tasks_priority_check` VOCABULARY.
 *
 * Verified against pg_constraint on 2026-08-04:
 *   CHECK (priority = ANY (ARRAY['critical','high','medium','low']))
 *
 * The generator used to emit `urgent`, which this CHECK REJECTS. Because the
 * insert was an unchecked `await supabase...insert()` (supabase-js RESOLVES a
 * refused write rather than throwing), every single urgent task was silently
 * discarded and the action still reported success. Probed live: inserting
 * priority 'urgent' returns
 *   "violates check constraint transaction_tasks_priority_check".
 * The AI schema below is now generated FROM this constant so the two can never
 * drift apart again.
 */
// NOTE: NOT exported as a value — a "use server" module may only export async
// functions. The surface keeps its own copy and the wiring simulator asserts the
// two are identical.
const TRANSACTION_TASK_PRIORITIES = ["critical", "high", "medium", "low"] as const
type TransactionTaskPriority = (typeof TRANSACTION_TASK_PRIORITIES)[number]

// TOMBSTONE (wave 26, CLAUDE.md §6): `TRANSACTION_DEADLINE_STATUSES` was declared
// here as ["pending","completed","extended","missed","waived"] — BYTE-IDENTICAL to
// the list that already existed at lib/transactions/coordination-status.ts:49.
// Two spellings of one vocabulary is a defect, not a style choice: a scorer
// cannot match a writer across them, and the guard that holds code and database
// in agreement can only see the one the module exports. SURVIVOR:
// `DEADLINE_STATUSES` (lib/transactions/coordination-status.ts:49), imported
// above together with its `isDeadlineStatus` predicate. Do not redeclare it here.

/** The live `transaction_communications_status_check` vocabulary (pg_constraint). */
const TRANSACTION_COMMUNICATION_STATUSES = ["draft", "sent", "delivered", "failed"] as const

/** The live `scheduled_touchpoints_status_check` vocabulary (pg_constraint). */
const SCHEDULED_TOUCHPOINT_STATUSES = ["scheduled", "sent", "completed", "skipped", "failed"] as const

/**
 * Coerce whatever the model produced into a `date` column value (YYYY-MM-DD).
 * `new Date("sometime next week").toISOString()` THROWS RangeError, which used
 * to abort the entire deadline run on one bad string. Returns null when the
 * value cannot be read as a date — the caller then skips that row instead of
 * writing a NOT NULL violation.
 */
function toDateOnly(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  const t = Date.parse(value.trim())
  if (!Number.isFinite(t)) return null
  return new Date(t).toISOString().slice(0, 10)
}

/** Add `days` to today and return a `date` column value. */
function dateOnlyFromNow(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + (Number.isFinite(days) ? days : 0))
  return d.toISOString().slice(0, 10)
}

interface CoordinatorScope {
  ok: boolean
  error?: string
  userId?: string
  agentId?: string | null
  brokerageId?: string
}

/**
 * AUTH + TENANCY for every transaction-scoped coordinator action.
 *
 * These actions all took a caller-supplied `agentId` and a caller-supplied
 * `transactionId` with NO gate at all — any authenticated (or unauthenticated)
 * caller could drive AI writes onto any deal in any brokerage. The identity
 * classes are also distinct and must not be substituted:
 *   · transactions.agent_id  FK-> agents(id)   (verified via pg_constraint)
 *   · users.id                                  (auth.uid())
 * so the context carries BOTH and each write picks the one its column means.
 */
async function scopeTransaction(transactionId: string): Promise<CoordinatorScope> {
  if (!isValidUUID(transactionId)) return { ok: false, error: "Invalid transaction ID" }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }

  const supabase = await createClient()
  // Destructure `error` — a REFUSED read here used to look like "transaction
  // not found" and, worse, a clean gate.
  const { data: txn, error } = await supabase
    .from("transactions")
    .select("id, brokerage_id")
    .eq("id", transactionId)
    .maybeSingle()

  if (error) return { ok: false, error: `Could not verify the transaction: ${error.message}` }
  if (!txn) return { ok: false, error: "Transaction not found" }
  if (txn.brokerage_id !== ctx.brokerageId) {
    return { ok: false, error: "Forbidden: transaction not in your brokerage" }
  }

  return { ok: true, userId: ctx.userId, agentId: ctx.agentId, brokerageId: ctx.brokerageId }
}

function normalizeZip(zip?: string) {
  if (!zip) return undefined

  const cleaned = zip.replace(/\s+/g, '').replace(/[^0-9]/g, '')

  if (cleaned.length === 5) return cleaned
  if (cleaned.length === 9) return `${cleaned.slice(0, 5)}-${cleaned.slice(5)}`

  return zip
}

// ============================================
// AI TRANSACTION COORDINATOR
// Smart transaction management with AI insights
// ============================================

/**
 * AI-powered transaction health analysis
 * Analyzes all aspects of a transaction and provides recommendations
 */
export async function analyzeTransactionHealth(params: {
  transactionId: string
  agentId: string
}) {
  try {
    if (!isValidUUID(params.transactionId)) {
      return { success: false, error: "Invalid transaction ID" }
    }

    const supabase = await createClient()

    // Get comprehensive transaction data.
    //
    // The `contacts(*)` embed that used to close this list made the read fail every
    // time. `transactions` has THREE foreign keys to `contacts`
    // (transactions_contact_id_fkey, transactions_buyer_contact_id_fkey,
    // transactions_seller_contact_id_fkey), so PostgREST could not resolve a bare
    // `contacts(...)` and refused the ENTIRE request with PGRST201 — which the guard
    // below reported as "Transaction not found". Deal-health analysis has never run
    // from this path.
    //
    // Removed rather than disambiguated: nothing in this function reads
    // `transaction.contacts`, so there is no party for it to mean. If the health
    // prompt ever needs our client, add
    // `contacts!transactions_contact_id_fkey(first_name, last_name)` — contact_id is
    // the side WE represent (lib/transactions/offer-bridge.ts:302).
    //
    // `listings(*)` is left as-is (unambiguous, one FK on transactions.listing_id)
    // but it is also unread here; it belongs to the wildcard-embed sweep, defect #214.
    const { data: transaction, error } = await supabase
      .from("transactions")
      .select(`
        *,
        transaction_milestones(*),
        transaction_participants(*),
        transaction_deadlines(*),
        transaction_documents(*),
        listings(*)
      `)
      .eq("id", params.transactionId)
      .single()

    if (error) {
      return { success: false, error: `Could not read the transaction: ${error.message}` }
    }
    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }

    const { object: analysis } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      schema: z.object({
        healthScore: z.number().min(0).max(100),
        riskLevel: z.enum(["low", "medium", "high", "critical"]),
        winProbability: z.number().min(0).max(100),
        daysToClose: z.number(),
        criticalIssues: z.array(z.object({
          issue: z.string(),
          severity: z.enum(["low", "medium", "high", "critical"]),
          recommendation: z.string(),
          deadline: z.string().optional(),
        })),
        missingDocuments: z.array(z.string()),
        upcomingDeadlines: z.array(z.object({
          task: z.string(),
          dueDate: z.string(),
          daysRemaining: z.number(),
          priority: z.enum(["low", "medium", "high", "urgent"]),
        })),
        nextBestActions: z.array(z.object({
          action: z.string(),
          reason: z.string(),
          priority: z.number(),
        })),
        communicationSuggestions: z.array(z.object({
          recipient: z.string(),
          message: z.string(),
          timing: z.string(),
        })),
        potentialDelays: z.array(z.object({
          cause: z.string(),
          likelihood: z.number(),
          mitigation: z.string(),
        })),
      }),
      prompt: `Analyze this real estate transaction and provide a comprehensive health assessment:

Transaction Details:
- Property: ${transaction.property_address}
- Sale Price: $${transaction.purchase_price?.toLocaleString()}
- Status: ${transaction.status}
- Type: ${transaction.deal_type}
- Contract Date: ${transaction.contract_date}
- Target Close: ${transaction.estimated_close_date}
- Days on Market: ${transaction.days_on_market || 'N/A'}

Milestones:
${JSON.stringify(transaction.transaction_milestones, null, 2)}

Participants:
${JSON.stringify(transaction.transaction_participants, null, 2)}

Deadlines:
${JSON.stringify(transaction.transaction_deadlines, null, 2)}

Documents:
${JSON.stringify(transaction.transaction_documents, null, 2)}

Analyze for:
1. Overall health score (0-100)
2. Risk assessment
3. Win probability
4. Missing documents for ${(transaction.property_state || 'FL').toUpperCase()} compliance
5. Critical deadlines approaching
6. Communication needs
7. Potential delays and mitigations
8. Next best actions for the agent`,
    })

    // Update transaction with AI insights.
    // CHECKED — this was an unchecked `await supabase…update()`. The health score
    // it writes is what the deal card, the pipeline colour and the risk panel all
    // read, so a refused update meant the agent kept looking at a stale score
    // while this action reported a fresh analysis. `applied` says which it was.
    const { error: insightsError } = await supabase
      .from("transactions")
      .update({
        health_score: analysis.healthScore,
        win_probability: analysis.winProbability,
        ai_risk_level: analysis.riskLevel,
        ai_analysis: analysis,
        last_ai_analysis: new Date().toISOString(),
      })
      .eq("id", params.transactionId)

    if (insightsError) {
      return {
        success: false,
        error: `The analysis ran but could not be saved to the deal (${insightsError.message}). The score you see elsewhere is still the old one.`,
      }
    }

    // ── WIN-PROBABILITY FREEZER (owner round 36) ────────────────────────────
    // transactions.win_probability is mutable and converges toward the outcome,
    // so the accuracy flywheel refused to grade it. Freeze THIS claim as an
    // immutable ai_predictions snapshot at the moment it's made — the close-time
    // grader stamps the real outcome later and the deal_outcome rail grades the
    // FIRST pre-outcome claim per deal. Best-effort; never blocks the analysis.
    try {
      const { captureWinProbabilitySnapshot } = await import("@/lib/analytics/ai-prediction-outcomes")
      if (transaction.brokerage_id) {
        await captureWinProbabilitySnapshot(supabase as any, {
          transactionId: params.transactionId,
          brokerageId: transaction.brokerage_id,
          winProbability: analysis.winProbability,
          moment: "ai_health_analysis",
        })
      }
    } catch (e) {
      console.error("[AI Transaction Coordinator] win-probability snapshot failed:", e)
    }

    revalidatePath(`/transactions/${params.transactionId}`)
    return { success: true, analysis }
  } catch (error) {
    console.error("[AI Transaction Coordinator] Error:", error)
    return handleError(error, "analyzeTransactionHealth")
  }
}

/**
 * AI-powered deadline prediction and management
 */
export async function predictAndManageDeadlines(params: {
  transactionId: string
  /** Ignored — identity comes from the session (see scopeTransaction). */
  agentId?: string
}) {
  try {
    const scope = await scopeTransaction(params.transactionId)
    if (!scope.ok) return { success: false, error: scope.error }

    const supabase = await createClient()

    const { data: transaction, error: txnError } = await supabase
      .from("transactions")
      .select(`
        *,
        transaction_deadlines(*),
        transaction_milestones(*)
      `)
      .eq("id", params.transactionId)
      .maybeSingle()

    if (txnError) return { success: false, error: `Could not load the transaction: ${txnError.message}` }
    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }

    const { object: deadlineAnalysis } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      schema: z.object({
        predictedCloseDate: z.string(),
        confidence: z.number(),
        criticalPath: z.array(z.object({
          milestone: z.string(),
          deadline: z.string(),
          dependencies: z.array(z.string()),
          riskOfDelay: z.number(),
        })),
        suggestedDeadlines: z.array(z.object({
          task: z.string(),
          suggestedDate: z.string(),
          reason: z.string(),
          autoReminder: z.boolean(),
        })),
        bufferRecommendations: z.array(z.object({
          phase: z.string(),
          currentBuffer: z.number(),
          recommendedBuffer: z.number(),
          reason: z.string(),
        })),
      }),
      prompt: `Analyze this transaction's timeline and predict deadlines:

Transaction: ${transaction.property_address}
Contract Date: ${transaction.contract_date}
Target Close: ${transaction.estimated_close_date}
State: ${(transaction.property_state || 'FL').toUpperCase()}
Transaction Type: ${transaction.deal_type}

Current Milestones:
${JSON.stringify(transaction.transaction_milestones, null, 2)}

Current Deadlines:
${JSON.stringify(transaction.transaction_deadlines, null, 2)}

Based on typical ${(transaction.property_state || 'Florida')} real estate timelines:
1. Predict realistic close date
2. Identify critical path items
3. Suggest missing deadlines
4. Recommend buffer times for each phase`,
    })

    // ── AUTO-CREATE SUGGESTED DEADLINES ──────────────────────────────────────
    // transaction_deadlines canonical columns: deadline_type (was task_name),
    // deadline_date (date, NOT NULL, was due_date). No ai_suggested/auto_reminder
    // columns exist — reminders fire off calendar_events, not this table.
    //
    // THREE THINGS WERE WRONG HERE AND ALL THREE WERE INVISIBLE:
    //  1. brokerage_id came off the embedded transaction row, which is right,
    //     but nothing verified it was the CALLER's brokerage. Now gated above.
    //  2. `new Date(deadline.suggestedDate).toISOString()` THROWS RangeError on
    //     any unparseable model output, aborting the whole run — one bad string
    //     lost every other deadline. Now coerced, and an unreadable date SKIPS
    //     that single row.
    //  3. The insert was unchecked. `trx_agent_transaction_deadlines` has
    //     WITH CHECK (brokerage_id = current_user_brokerage_id()) — a missing or
    //     wrong stamp is REFUSED, and supabase-js resolves that refusal, so the
    //     action reported a clean run over zero rows.
    //
    // The dedup is now a DATABASE read, not a scan of the embedded array: the
    // embedded list is a snapshot and (with PostgREST's default embed cap) is
    // not guaranteed to hold every existing deadline.
    const { data: existingDeadlines, error: existingError } = await supabase
      .from("transaction_deadlines")
      .select("deadline_type")
      .eq("transaction_id", params.transactionId)

    if (existingError) {
      return { success: false, error: `Could not read existing deadlines: ${existingError.message}` }
    }

    const known = new Set(
      (existingDeadlines ?? []).map((d: any) => String(d.deadline_type ?? "").trim().toLowerCase()),
    )

    let createdCount = 0
    const skipped: string[] = []

    for (const deadline of deadlineAnalysis.suggestedDeadlines) {
      const key = String(deadline.task ?? "").trim().toLowerCase()
      if (!key || known.has(key)) continue

      const deadlineDate = toDateOnly(deadline.suggestedDate)
      if (!deadlineDate) {
        skipped.push(`${deadline.task} (unreadable date "${deadline.suggestedDate}")`)
        continue
      }

      const { error: insertError } = await supabase.from("transaction_deadlines").insert({
        transaction_id: params.transactionId,
        brokerage_id: scope.brokerageId,
        deadline_type: deadline.task,
        deadline_date: deadlineDate,
        // DEADLINE_STATUSES[0] is 'pending' — the first, open state of the live
        // transaction_deadlines_status_check vocabulary, taken from the one
        // module that declares it rather than a local copy.
        status: DEADLINE_STATUSES[0],
        notes: deadline.reason,
      })

      if (insertError) {
        skipped.push(`${deadline.task} (${insertError.message})`)
        continue
      }

      known.add(key)
      createdCount += 1
    }

    revalidatePath(`/dashboard/transactions/${params.transactionId}`)
    return {
      success: true,
      deadlineAnalysis,
      // proposedCount is what the model suggested; createdCount is what the
      // DATABASE now agrees with. Reporting both is the difference between
      // "we planned 6 deadlines" and "6 deadlines exist".
      proposedCount: deadlineAnalysis.suggestedDeadlines.length,
      createdCount,
      skipped,
    }
  } catch (error) {
    return handleError(error, "predictAndManageDeadlines")
  }
}

/**
 * AI-powered smart task generation based on transaction stage
 */
export async function generateSmartTasks(params: {
  transactionId: string
  /** Ignored — identity comes from the session (see scopeTransaction). */
  agentId?: string
  stage?: string
}) {
  try {
    const scope = await scopeTransaction(params.transactionId)
    if (!scope.ok) return { success: false, error: scope.error }

    const supabase = await createClient()

    // AMBIGUOUS EMBED — the `!transactions_contact_id_fkey` hint is load-bearing.
    // `transactions` carries THREE foreign keys to `contacts`
    // (transactions_contact_id_fkey, transactions_buyer_contact_id_fkey,
    // transactions_seller_contact_id_fkey). Without naming one, PostgREST refuses the
    // WHOLE request with PGRST201, txnError fires, and this action reports "Could not
    // load the transaction" for a transaction that exists — so no smart task has ever
    // been generated from this path.
    //
    // `contact_id` is the party WE represent on the deal (documented on the canonical
    // writer, lib/transactions/offer-bridge.ts:302). The prompt line below is labelled
    // "Buyer/Seller" precisely because it wants whichever side is ours — one name that
    // is populated on every deal. buyer_contact_id is null on seller-side deals and
    // seller_contact_id is null on buyer-side ones, so either would blank the name on
    // half the book.
    //
    // Columns are named rather than `*` so the schema guard can see drift (defect #214).
    const { data: transaction, error: txnError } = await supabase
      .from("transactions")
      .select(`
        *,
        transaction_milestones(*),
        listings(*),
        contacts!transactions_contact_id_fkey(first_name, last_name)
      `)
      .eq("id", params.transactionId)
      .maybeSingle()

    if (txnError) return { success: false, error: `Could not load the transaction: ${txnError.message}` }
    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }

    const currentStage = params.stage || transaction.status

    const { object: tasks } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      schema: z.object({
        tasks: z.array(z.object({
          title: z.string(),
          description: z.string(),
          // BUILT FROM THE LIVE CHECK VOCABULARY, not hand-typed. The old literal
          // list was ["low","medium","high","urgent"]; the database CHECK is
          // ['critical','high','medium','low']. Every 'urgent' task the model
          // produced was refused and silently dropped.
          priority: z.enum(TRANSACTION_TASK_PRIORITIES),
          category: z.enum(["document", "communication", "inspection", "financial", "legal", "closing"]),
          suggestedDeadline: z.string(),
          assignTo: z.enum(["agent", "buyer", "seller", "lender", "title", "attorney"]),
          automatable: z.boolean(),
          dependencies: z.array(z.string()),
        })),
        stageProgress: z.number(),
        nextStage: z.string(),
        stageCompletionCriteria: z.array(z.string()),
      }),
      prompt: `Generate smart tasks for this real estate transaction:

Property: ${transaction.property_address}
Price: $${transaction.purchase_price?.toLocaleString()}
Current Stage: ${currentStage}
Transaction Type: ${transaction.deal_type}
State: ${(transaction.property_state || 'FL').toUpperCase()}
Buyer/Seller: ${transaction.contacts?.first_name} ${transaction.contacts?.last_name}

Completed Milestones:
${transaction.transaction_milestones?.filter((m: any) => m.status === 'completed').map((m: any) => m.milestone_name).join('\n')}

Generate appropriate tasks for the ${currentStage} stage considering:
1. State-specific requirements for ${(transaction.property_state || 'Florida')}
2. Transaction type (${transaction.deal_type})
3. Already completed items
4. Typical timeline expectations
5. Compliance requirements

Priority MUST be one of: ${TRANSACTION_TASK_PRIORITIES.join(", ")}.`,
    })

    // ── SAVE GENERATED TASKS ─────────────────────────────────────────────────
    // Two silent killers lived here:
    //  · brokerage_id was NEVER stamped, and the only policy on this table is
    //    brok_transaction_tasks with
    //      WITH CHECK (brokerage_id = current_user_brokerage_id())
    //    which is FALSE for NULL — so RLS refused every insert.
    //  · the insert was unchecked, so that refusal (and the priority CHECK
    //    violation above) resolved as success and the panel reported N tasks
    //    generated over an empty table.
    // The dedup read is likewise checked now: a refused SELECT used to come back
    // `{ data: null }`, which read as "no duplicate" and invited a re-insert.
    const { data: existingTasks, error: existingError } = await supabase
      .from("transaction_tasks")
      .select("title")
      .eq("transaction_id", params.transactionId)
      .eq("ai_generated", true)

    if (existingError) {
      return { success: false, error: `Could not read existing tasks: ${existingError.message}` }
    }

    const known = new Set((existingTasks ?? []).map((t: any) => String(t.title ?? "").trim().toLowerCase()))

    let createdCount = 0
    const skipped: string[] = []

    for (const task of tasks.tasks) {
      const key = String(task.title ?? "").trim().toLowerCase()
      if (!key || known.has(key)) continue

      // due_date is a `date` column — an unparseable model string is a NOT NULL /
      // cast failure, so fall back to a week out rather than losing the task.
      const dueDate = toDateOnly(task.suggestedDeadline) ?? dateOnlyFromNow(7)

      const { error: insertError } = await supabase.from("transaction_tasks").insert({
        transaction_id: params.transactionId,
        brokerage_id: scope.brokerageId,
        title: task.title,
        description: task.description,
        priority: task.priority,
        category: task.category,
        due_date: dueDate,
        assigned_to: task.assignTo,
        ai_generated: true,
        automatable: task.automatable,
        // 'pending' is in the live transaction_tasks_status_check vocabulary.
        status: "pending",
      })

      if (insertError) {
        skipped.push(`${task.title} (${insertError.message})`)
        continue
      }

      known.add(key)
      createdCount += 1
    }

    revalidatePath(`/dashboard/transactions/${params.transactionId}`)
    return {
      success: true,
      tasks,
      proposedCount: tasks.tasks.length,
      createdCount,
      skipped,
    }
  } catch (error) {
    return handleError(error, "generateSmartTasks")
  }
}

/**
 * AI-powered communication drafting for transaction participants
 */
export async function draftTransactionCommunication(params: {
  transactionId: string
  /** Ignored — identity comes from the session (see scopeTransaction). */
  agentId?: string
  recipientRole: "buyer" | "seller" | "lender" | "title" | "attorney" | "other_agent"
  communicationType: "update" | "request" | "reminder" | "negotiation" | "congratulations"
  context?: string
}) {
  try {
    const scope = await scopeTransaction(params.transactionId)
    if (!scope.ok) return { success: false, error: scope.error }

    const supabase = await createClient()

    // The `contacts(*)` embed that used to sit here refused the entire read.
    // `transactions` has THREE foreign keys to `contacts` (contact_id /
    // buyer_contact_id / seller_contact_id), so PostgREST cannot resolve a bare
    // `contacts(...)` and answers PGRST201 for the WHOLE request — txnError fired and
    // no communication was ever drafted from this path.
    //
    // Removed rather than disambiguated: the recipient's name comes from
    // `transaction_participants` (see `recipient` below), and nothing reads
    // `transaction.contacts`.
    //
    // NOTE for anyone adding a fallback here: this action takes an explicit
    // `recipientRole`, so the role-correct FK is the ROLE slot —
    // `contacts!transactions_buyer_contact_id_fkey` for "buyer",
    // `contacts!transactions_seller_contact_id_fkey` for "seller" — NOT contact_id.
    // contact_id is whichever side we represent, which on a seller-side deal is the
    // seller; addressing them as the buyer would put the wrong person's name on the
    // letter. This is exactly the case where the most common FK is the wrong answer.
    const { data: transaction, error: txnError } = await supabase
      .from("transactions")
      .select(`
        *,
        transaction_participants(*),
        transaction_milestones(*),
        listings(*)
      `)
      .eq("id", params.transactionId)
      .maybeSingle()

    if (txnError) return { success: false, error: `Could not load the transaction: ${txnError.message}` }
    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }

    // IDENTITY CLASS. `users` is keyed by users.id (auth.uid()); the caller-supplied
    // params.agentId was ALSO being written to transaction_communications.agent_id.
    // That is the self-contradiction scripts/identity-class-guard.ts flags for this
    // function. The session is authoritative for both: userId reads `users`,
    // agentId (agents.id — the class transactions.agent_id FKs) is stamped on the row.
    const { data: agent, error: agentError } = await supabase
      .from("users")
      .select("first_name, last_name, phone, email")
      .eq("id", scope.userId!)
      .maybeSingle()

    if (agentError) {
      return { success: false, error: `Could not load your profile: ${agentError.message}` }
    }

    const recipient = transaction.transaction_participants?.find(
      (p: any) => p.role === params.recipientRole
    )

    const { text: communication } = await generateText({
      brokerageId: scope.brokerageId ?? null,
      userId: scope.userId ?? null,
      agentId: scope.agentId ?? null,
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      prompt: `Draft a professional ${params.communicationType} communication for a real estate transaction:

From: ${agent?.first_name} ${agent?.last_name} (Agent)
To: ${recipient?.name || params.recipientRole} (${params.recipientRole})

Property: ${transaction.property_address}
Transaction Status: ${transaction.status}
Sale Price: $${transaction.purchase_price?.toLocaleString()}

Recent Milestones:
${transaction.transaction_milestones?.slice(-3).map((m: any) => `- ${m.milestone_name}: ${m.status}`).join('\n')}

Communication Type: ${params.communicationType}
${params.context ? `Additional Context: ${params.context}` : ''}

Generate a professional, warm, and effective ${params.communicationType} message that:
1. Is appropriate for the ${params.recipientRole}
2. Maintains professionalism while being personable
3. Includes specific next steps if applicable
4. References relevant transaction details
5. Is compliant with real estate communication standards

Format as both email and SMS versions.`,
    })

    // ── LOG THE DRAFT — THE ROW THE NEXT READER LOOKS FOR ────────────────────
    // brok_transaction_communications is the ONLY policy on this table and it
    // applies to ALL commands with
    //   WITH CHECK (brokerage_id = current_user_brokerage_id())
    // The old insert never stamped brokerage_id, so RLS refused EVERY row — and
    // because the write was unchecked, the action handed the agent a draft and
    // reported success while transaction_communications stayed permanently
    // empty (live count: 0). This is a HARD failure now: the draft is the record
    // of what was said to whom, and a draft that was never recorded is a draft
    // the agent will send twice.
    const { data: logged, error: logError } = await supabase
      .from("transaction_communications")
      .insert({
        transaction_id: params.transactionId,
        brokerage_id: scope.brokerageId,
        agent_id: scope.agentId,
        recipient_role: params.recipientRole,
        communication_type: params.communicationType,
        ai_draft: communication,
        // 'draft' is in the live transaction_communications_status_check vocabulary.
        status: TRANSACTION_COMMUNICATION_STATUSES[0],
      })
      .select("id, status, created_at")
      .single()

    if (logError || !logged) {
      return {
        success: false,
        error: `The draft was written but could not be recorded (${logError?.message ?? "no row returned"}). Nothing was saved — retry.`,
      }
    }

    revalidatePath(`/dashboard/transactions/${params.transactionId}`)
    return {
      success: true,
      communication,
      draftId: logged.id,
      status: logged.status,
      recipientName: recipient?.name ?? null,
      recipientEmail: recipient?.email ?? null,
    }
  } catch (error) {
    return handleError(error, "draftTransactionCommunication")
  }
}

/**
 * Read the recorded communication drafts for a transaction — the reader that
 * makes draftTransactionCommunication's write visible. Without this the drafts
 * were write-only and no surface could ever show them back.
 */
export async function listTransactionCommunications(transactionId: string) {
  const scope = await scopeTransaction(transactionId)
  if (!scope.ok) return { success: false as const, error: scope.error, communications: [] }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_communications")
    .select("id, recipient_role, communication_type, ai_draft, final_content, status, sent_at, created_at")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", scope.brokerageId!)
    .order("created_at", { ascending: false })
    .limit(25)

  if (error) return { success: false as const, error: error.message, communications: [] }
  return { success: true as const, communications: data ?? [] }
}

/**
 * SEND A RECORDED DRAFT — the half `draftTransactionCommunication` never had.
 *
 * The drafter wrote `ai_draft` and status 'draft' and stopped there. Nothing in
 * the tree ever moved a row past that, which is why `final_content` and
 * `sent_at` — both selected by listTransactionCommunications above and both
 * typed on the panel's CommunicationRow — were read on a live surface and
 * written by NOBODY. Every recorded communication rendered as a permanent
 * "draft, never sent", and the vocabulary's other three states ('sent',
 * 'delivered', 'failed') were unreachable.
 *
 * THE TWO COLUMNS ARE NOT THE SAME TEXT. `ai_draft` is what the model wrote;
 * `final_content` is what the human actually sent after editing it. Recording
 * only the first would make the file a record of what was PROPOSED, not of what
 * was said to a client — and this row is the thing an agent goes back to when a
 * party disputes what they were told.
 *
 * Tenant from the SESSION via scopeTransaction (§4), and the row is re-read
 * inside that tenant so a communication id from another brokerage cannot be
 * driven through this door. Egress rides dispatchEmail — the one consent-gated
 * send — so a suppressed or DNC recipient is refused here exactly as anywhere
 * else, and that refusal is recorded as 'failed' rather than reported as sent.
 */
export async function sendTransactionCommunication(params: {
  transactionId: string
  communicationId: string
  finalContent: string
}) {
  try {
    if (!isValidUUID(params.communicationId)) {
      return { success: false, error: "Invalid communication ID" }
    }
    const body = (params.finalContent ?? "").trim()
    if (!body) {
      return { success: false, error: "Nothing to send — the message body is empty." }
    }

    const scope = await scopeTransaction(params.transactionId)
    if (!scope.ok) return { success: false, error: scope.error }

    const supabase = await createClient()

    // Re-read inside the caller's own tenant. `.eq("brokerage_id", …)` is the
    // gate, not the id: an id proves a row exists, never that it is ours.
    const { data: comm, error: commError } = await supabase
      .from("transaction_communications")
      .select("id, recipient_role, communication_type, status, transaction_id")
      .eq("id", params.communicationId)
      .eq("transaction_id", params.transactionId)
      .eq("brokerage_id", scope.brokerageId!)
      .maybeSingle()
    if (commError) {
      return { success: false, error: `Could not load that communication: ${commError.message}` }
    }
    if (!comm) return { success: false, error: "Communication not found" }
    if (comm.status !== "draft") {
      return { success: false, error: `Already ${comm.status} — a sent communication is not re-sent.` }
    }

    // The recipient is the transaction participant holding the drafted role —
    // the same slot the drafter addressed. No fallback to transactions.contact_id:
    // that is whichever side we represent, which on a seller-side deal is the
    // seller, and mailing the seller a letter addressed to the buyer is the
    // exact error the drafter's own note warns about.
    const { data: participants, error: partError } = await supabase
      .from("transaction_participants")
      .select("role, name, email")
      .eq("transaction_id", params.transactionId)
    if (partError) {
      return { success: false, error: `Could not load the participants: ${partError.message}` }
    }
    const recipient = ((participants ?? []) as Array<{ role: string | null; name: string | null; email: string | null }>)
      .find((p) => p.role === comm.recipient_role)
    if (!recipient?.email) {
      return {
        success: false,
        error: `No email on file for the ${String(comm.recipient_role ?? "recipient").replace(/_/g, " ")} on this transaction.`,
      }
    }

    const { dispatchEmail } = await import("@/lib/providers/dispatch")
    const { resolveOutboundSender, formatSenderOrUndefined } = await import("@/lib/providers/outbound-sender")
    const sender = await resolveOutboundSender(supabase, scope.brokerageId!)
    const result = await dispatchEmail({
      brokerageId: scope.brokerageId!,
      userId: scope.userId ?? undefined,
      agentId: scope.agentId ?? undefined,
      from: formatSenderOrUndefined(sender),
      to: recipient.email,
      subject: `${String(comm.communication_type ?? "Update").replace(/_/g, " ")} — your transaction`,
      html: body.replace(/\n/g, "<br />"),
      channelPurpose: "transactional",
      systemSource: "transaction_communication",
      metadata: { transaction_id: params.transactionId, transaction_communication_id: comm.id },
    })

    // RECORD WHAT ACTUALLY HAPPENED, both ways. A gate refusal and a provider
    // rejection both land as 'failed' with the reason attached, because a
    // communication that reads 'sent' when nothing left the building is the
    // failure this whole lane exists to stop. `final_content` is stamped either
    // way — the agent wrote it and the record of what they intended to send
    // survives the send failing.
    const nowIso = new Date().toISOString()
    const { data: updated, error: updateError } = await supabase
      .from("transaction_communications")
      .update({
        final_content: body,
        status: result.success ? "sent" : "failed",
        sent_at: result.success ? nowIso : null,
      })
      .eq("id", comm.id)
      .eq("brokerage_id", scope.brokerageId!)
      .select("id, status, sent_at")
    if (updateError) {
      return { success: false, error: `The message was handled but the record could not be updated: ${updateError.message}` }
    }
    // An UPDATE that matched nothing RESOLVES with error null and an empty
    // array — byte-identical to one that worked (CLAUDE.md §3). Count it.
    if (!updated || updated.length === 0) {
      return { success: false, error: "The communication record was not updated — nothing was saved." }
    }

    revalidatePath(`/dashboard/transactions/${params.transactionId}`)
    if (!result.success) {
      return { success: false, error: result.error ?? "The provider did not accept the message.", status: "failed" }
    }
    return { success: true, status: "sent", sentAt: nowIso, recipientEmail: recipient.email }
  } catch (error) {
    return handleError(error, "sendTransactionCommunication")
  }
}

/**
 * AI-powered transaction risk monitoring
 */
export async function monitorTransactionRisks(agentId: string) {
  try {
    if (!isValidUUID(agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()

    // Get all active transactions
    const { data: transactions } = await supabase
      .from("transactions")
      .select(`
        *,
        transaction_milestones(*),
        transaction_deadlines(*)
      `)
      .eq("agent_id", agentId)
      .in("status", [...TRANSACTION_STATUSES_IN_ESCROW])

    if (!transactions || transactions.length === 0) {
      return { success: true, risks: [], summary: "No active transactions" }
    }

    const { object: riskAnalysis } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      schema: z.object({
        overallRiskLevel: z.enum(["low", "medium", "high", "critical"]),
        transactionRisks: z.array(z.object({
          transactionId: z.string(),
          propertyAddress: z.string(),
          riskLevel: z.enum(["low", "medium", "high", "critical"]),
          primaryRisk: z.string(),
          daysToDeadline: z.number(),
          recommendedAction: z.string(),
          urgency: z.enum(["routine", "attention_needed", "urgent", "critical"]),
        })),
        immediateActions: z.array(z.object({
          transactionId: z.string(),
          action: z.string(),
          deadline: z.string(),
        })),
        weeklyFocus: z.array(z.string()),
      }),
      prompt: `Analyze risks across all active transactions:

${transactions.map((t: any) => `
Transaction: ${t.property_address}
Status: ${t.status}
Target Close: ${t.estimated_close_date}
Health Score: ${t.health_score || 'Unknown'}
Milestones: ${t.transaction_milestones?.length || 0} total, ${t.transaction_milestones?.filter((m: any) => m.status === 'completed').length || 0} completed
Upcoming Deadlines: ${t.transaction_deadlines?.filter((d: any) => new Date(d.due_date) > new Date()).length || 0}
`).join('\n---\n')}

Identify:
1. Overall portfolio risk level
2. Specific risks per transaction
3. Immediate actions needed
4. Weekly focus priorities`,
    })

    // Write the risk level back onto each transaction, and COUNT what actually
    // landed. supabase-js resolves a rejected update rather than throwing, so
    // the previous loop could fail on every row and still report a clean scan —
    // the panel would show risk the deals themselves never recorded.
    let appliedCount = 0
    for (const risk of riskAnalysis.transactionRisks) {
      const { error: applyError } = await supabase
        .from("transactions")
        .update({
          ai_risk_level: risk.riskLevel,
          ai_primary_risk: risk.primaryRisk,
        })
        .eq("id", risk.transactionId)
      if (applyError) {
        console.error(
          `[transaction-coordinator] risk not written to ${risk.transactionId}:`,
          applyError.message,
        )
        continue
      }
      appliedCount += 1
    }

    // scannedCount is the book we actually looked at; appliedCount is what the
    // database now agrees with. Reporting them separately is the difference
    // between "we analysed 12 deals" and "12 deals now carry that analysis".
    return {
      success: true,
      riskAnalysis,
      scannedCount: transactions.length,
      appliedCount,
    }
  } catch (error) {
    return handleError(error, "monitorTransactionRisks")
  }
}

/**
 * AI-powered closing preparation checklist
 *
 * ── DELIBERATELY NOT WIRED TO A SURFACE ──────────────────────────────────────
 * transaction_closing_prep is UNIQUE on transaction_id (pg_constraint:
 * transaction_closing_prep_transaction_id_key), i.e. ONE row per deal, and it
 * already has a live writer reached from a real page:
 *
 *     app/actions/ai-closing-workflow.ts : aiGenerateClosingChecklist
 *       -> called by app/crm/components/closing-workflow-tab.tsx:192
 *       -> upserts transaction_closing_prep with { onConflict: "transaction_id" },
 *          stamps brokerage_id, and ALSO populates closing_checklist_items,
 *          which app/actions/ai-closing-workflow.ts:getClosingPrepSummary reads.
 *
 * Wiring this function to a second button would give one row two independent
 * authors writing different `checklist` shapes and different `readiness_score`
 * scales, and whichever ran last would win silently. So it stays unwired — but
 * NOT unfixed: the three defects below were real and are corrected, so the
 * capability is whole for whoever consolidates the two.
 */
export async function prepareForClosing(params: {
  transactionId: string
  /** Ignored — identity comes from the session (see scopeTransaction). */
  agentId?: string
  closingDate: string
}) {
  try {
    const scope = await scopeTransaction(params.transactionId)
    if (!scope.ok) return { success: false, error: scope.error }

    const supabase = await createClient()

    const { data: transaction, error: txnError } = await supabase
      .from("transactions")
      .select(`
        *,
        transaction_documents(*),
        transaction_participants(*),
        listings(*)
      `)
      .eq("id", params.transactionId)
      .maybeSingle()

    if (txnError) return { success: false, error: `Could not load the transaction: ${txnError.message}` }
    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }

    const { object: closingPrep } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      schema: z.object({
        readinessScore: z.number(),
        daysUntilClosing: z.number(),
        documentChecklist: z.array(z.object({
          document: z.string(),
          status: z.enum(["received", "pending", "missing", "needs_signature"]),
          responsibleParty: z.string(),
          deadline: z.string(),
          notes: z.string().optional(),
        })),
        participantReadiness: z.array(z.object({
          participant: z.string(),
          role: z.string(),
          ready: z.boolean(),
          pendingItems: z.array(z.string()),
        })),
        financialItems: z.array(z.object({
          item: z.string(),
          amount: z.number().optional(),
          status: z.string(),
          dueBy: z.string(),
        })),
        dayOfClosingChecklist: z.array(z.object({
          item: z.string(),
          timing: z.string(),
          responsible: z.string(),
        })),
        potentialIssues: z.array(z.object({
          issue: z.string(),
          resolution: z.string(),
          timeToResolve: z.string(),
        })),
      }),
      prompt: `Prepare comprehensive closing checklist for:

Property: ${transaction.property_address}
Sale Price: $${transaction.purchase_price?.toLocaleString()}
Closing Date: ${params.closingDate}
State: ${(transaction.property_state || 'FL').toUpperCase()}
Transaction Type: ${transaction.deal_type}

Current Documents:
${JSON.stringify(transaction.transaction_documents, null, 2)}

Participants:
${JSON.stringify(transaction.transaction_participants, null, 2)}

Generate a comprehensive closing preparation plan including:
1. Document checklist for ${(transaction.property_state || 'Florida')}
2. Participant readiness assessment
3. Financial items (earnest money, closing costs, etc.)
4. Day-of-closing checklist
5. Potential issues and resolutions`,
    })

    // ── SAVE CLOSING PREPARATION ─────────────────────────────────────────────
    // THREE DEFECTS, all verified against the live database:
    //  1. NO onConflict. supabase-js defaults the arbiter to the PRIMARY KEY
    //     (id), and no id was supplied — so this "upsert" was a plain INSERT and
    //     the SECOND call for a deal hit
    //       duplicate key value violates unique constraint
    //       "transaction_closing_prep_transaction_id_key"
    //     (probed live). onConflict is now the real unique key.
    //  2. brokerage_id was never stamped, and brok_transaction_closing_prep is
    //     the only policy on the table: WITH CHECK (brokerage_id =
    //     current_user_brokerage_id()) — FALSE for NULL, so even the first call
    //     was refused by RLS.
    //  3. Unchecked write: both of the above resolved as success.
    //  Also: `created_at` was being re-stamped on every upsert, which rewrites
    //  when prep STARTED. updated_at is the column that means "last touched".
    const { error: prepError } = await supabase
      .from("transaction_closing_prep")
      .upsert(
        {
          transaction_id: params.transactionId,
          brokerage_id: scope.brokerageId,
          closing_date: toDateOnly(params.closingDate),
          // readiness_score has CHECK (>= 0 AND <= 100) — clamp rather than let a
          // model overshoot refuse the whole row.
          readiness_score: Math.max(0, Math.min(100, Math.round(closingPrep.readinessScore ?? 0))),
          checklist: closingPrep,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "transaction_id" },
      )

    if (prepError) {
      return { success: false, error: `Closing prep could not be saved: ${prepError.message}` }
    }

    revalidatePath(`/dashboard/transactions/${params.transactionId}`)
    return { success: true, closingPrep }
  } catch (error) {
    return handleError(error, "prepareForClosing")
  }
}

/**
 * AI-powered post-closing follow-up automation
 */
export async function generatePostClosingPlan(params: {
  transactionId: string
  /** Ignored — identity comes from the session (see scopeTransaction). */
  agentId?: string
}) {
  try {
    const scope = await scopeTransaction(params.transactionId)
    if (!scope.ok) return { success: false, error: scope.error }

    const supabase = await createClient()

    // AMBIGUOUS EMBED — keep the `!transactions_contact_id_fkey` hint.
    // `transactions` has THREE foreign keys to `contacts`
    // (transactions_contact_id_fkey, transactions_buyer_contact_id_fkey,
    // transactions_seller_contact_id_fkey). A bare `contacts(...)` is PGRST201 on the
    // WHOLE request, so txnError fired and no post-closing plan was ever produced.
    //
    // `contact_id` is not a guess here — it is FORCED by the rest of this function.
    // The touchpoints written below go to `transaction.contact_id` (see `contactId`),
    // so the client the plan is ADDRESSED to must be the same person the plan is
    // DELIVERED to. Naming buyer_contact_id or seller_contact_id would put one name
    // in the letter and schedule it to somebody else.
    const { data: transaction, error: txnError } = await supabase
      .from("transactions")
      .select(`
        *,
        contacts!transactions_contact_id_fkey(first_name, last_name),
        listings(*)
      `)
      .eq("id", params.transactionId)
      .maybeSingle()

    if (txnError) return { success: false, error: `Could not load the transaction: ${txnError.message}` }
    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }

    const { object: postClosingPlan } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      schema: z.object({
        immediateFollowUp: z.array(z.object({
          action: z.string(),
          timing: z.string(),
          channel: z.enum(["email", "call", "text", "mail", "gift"]),
          template: z.string(),
        })),
        thirtyDayPlan: z.array(z.object({
          day: z.number(),
          action: z.string(),
          purpose: z.string(),
        })),
        ninetyDayPlan: z.array(z.object({
          week: z.number(),
          action: z.string(),
          purpose: z.string(),
        })),
        anniversaryPlan: z.object({
          date: z.string(),
          giftSuggestions: z.array(z.string()),
          messageSuggestion: z.string(),
        }),
        referralStrategy: z.object({
          askTiming: z.string(),
          approach: z.string(),
          incentive: z.string().optional(),
        }),
        reviewRequest: z.object({
          timing: z.string(),
          platform: z.array(z.string()),
          messageDraft: z.string(),
        }),
      }),
      prompt: `Create a post-closing follow-up plan for:

Client: ${transaction.contacts?.first_name} ${transaction.contacts?.last_name}
Property: ${transaction.property_address}
Sale Price: $${transaction.purchase_price?.toLocaleString()}
Transaction Type: ${transaction.deal_type}
Close Date: ${transaction.close_date || transaction.estimated_close_date}

Create a comprehensive plan including:
1. Immediate follow-up (closing day/week)
2. 30-day touchpoint plan
3. 90-day relationship building
4. Anniversary reminder
5. Referral generation strategy
6. Review request timing and approach`,
    })

    // ── SCHEDULE THE IMMEDIATE FOLLOW-UPS ────────────────────────────────────
    // scheduled_touchpoints is governed by ONE policy, stp_agent:
    //   USING      (agent_id = auth.uid() OR brokerage_id = current_user_brokerage_id())
    //   WITH CHECK (brokerage_id = current_user_brokerage_id())
    // Two consequences the old code got wrong, both silently:
    //  · brokerage_id was never stamped, so WITH CHECK was FALSE for every row
    //    and RLS refused all of them (live count: 0).
    //  · agent_id is compared to auth.uid() by that policy, so this column is
    //    the USERS class — not agents.id. The old code wrote the caller-supplied
    //    params.agentId, which for an agent-class id would make the row
    //    invisible to its own owner on the agent_id leg.
    // The write is also checked now; a refused touchpoint is reported, not lost.
    const contactId = transaction.contact_id as string | null

    if (!contactId) {
      return {
        success: false,
        error: "This transaction has no contact, so post-closing touchpoints have nobody to go to.",
      }
    }

    let scheduledCount = 0
    const skipped: string[] = []

    for (const followUp of postClosingPlan.immediateFollowUp) {
      const { error: touchError } = await supabase.from("scheduled_touchpoints").insert({
        contact_id: contactId,
        agent_id: scope.userId,
        brokerage_id: scope.brokerageId,
        touchpoint_type: followUp.channel,
        // `scheduled_date` is a DATE column — send an ISO timestamp and Postgres
        // truncates it anyway, so be explicit about what is actually stored.
        scheduled_date: dateOnlyFromNow(0),
        message_template: followUp.template,
        ai_generated: true,
        // 'scheduled' is in the live scheduled_touchpoints_status_check vocabulary.
        status: SCHEDULED_TOUCHPOINT_STATUSES[0],
      })

      if (touchError) {
        skipped.push(`${followUp.action} (${touchError.message})`)
        continue
      }
      scheduledCount += 1
    }

    revalidatePath(`/dashboard/transactions/${params.transactionId}`)
    return {
      success: true,
      postClosingPlan,
      proposedCount: postClosingPlan.immediateFollowUp.length,
      scheduledCount,
      skipped,
    }
  } catch (error) {
    return handleError(error, "generatePostClosingPlan")
  }
}

// Backward compatibility alias — wrapped because "use server" rejects `const = fn`.
// Shares prepareForClosing's "not wired, second writer" verdict; see the note there.
export async function getClosingPrep(...args: Parameters<typeof prepareForClosing>) {
  return prepareForClosing(...args)
}
