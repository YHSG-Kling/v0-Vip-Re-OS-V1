"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"

// ============================================
// HELPERS
// ============================================

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

    // Get comprehensive transaction data
    const { data: transaction, error } = await supabase
      .from("transactions")
      .select(`
        *,
        transaction_milestones(*),
        transaction_participants(*),
        transaction_deadlines(*),
        transaction_documents(*),
        listings(*),
        contacts(*)
      `)
      .eq("id", params.transactionId)
      .single()

    if (error || !transaction) {
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

    // Update transaction with AI insights
    await supabase
      .from("transactions")
      .update({
        health_score: analysis.healthScore,
        win_probability: analysis.winProbability,
        ai_risk_level: analysis.riskLevel,
        ai_analysis: analysis,
        last_ai_analysis: new Date().toISOString(),
      })
      .eq("id", params.transactionId)

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
  agentId: string
}) {
  try {
    const supabase = await createClient()

    const { data: transaction } = await supabase
      .from("transactions")
      .select(`
        *,
        transaction_deadlines(*),
        transaction_milestones(*)
      `)
      .eq("id", params.transactionId)
      .single()

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

    // Auto-create suggested deadlines
    for (const deadline of deadlineAnalysis.suggestedDeadlines) {
      const existing = transaction.transaction_deadlines?.find(
        (d: any) => d.deadline_type?.toLowerCase() === deadline.task.toLowerCase()
      )

      if (!existing) {
        // transaction_deadlines canonical columns: deadline_type (was task_name),
        // deadline_date (date, was due_date). No ai_suggested/auto_reminder columns
        // exist — reminders fire off calendar_events, not this table.
        await supabase.from("transaction_deadlines").insert({
          transaction_id: params.transactionId,
          brokerage_id: transaction.brokerage_id,
          deadline_type: deadline.task,
          deadline_date: new Date(deadline.suggestedDate).toISOString().slice(0, 10),
          status: "pending",
          notes: deadline.reason,
        })
      }
    }

    revalidatePath(`/transactions/${params.transactionId}`)
    return { success: true, deadlineAnalysis }
  } catch (error) {
    return handleError(error, "predictAndManageDeadlines")
  }
}

/**
 * AI-powered smart task generation based on transaction stage
 */
export async function generateSmartTasks(params: {
  transactionId: string
  agentId: string
  stage?: string
}) {
  try {
    const supabase = await createClient()

    const { data: transaction } = await supabase
      .from("transactions")
      .select(`
        *,
        transaction_milestones(*),
        listings(*),
        contacts(*)
      `)
      .eq("id", params.transactionId)
      .single()

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
          priority: z.enum(["low", "medium", "high", "urgent"]),
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
5. Compliance requirements`,
    })

    // Save generated tasks
    for (const task of tasks.tasks) {
      // Check for duplicate task before inserting
      const existingTask = await supabase
        .from("transaction_tasks")
        .select("id")
        .eq("transaction_id", params.transactionId)
        .eq("title", task.title)
        .eq("ai_generated", true)
        .maybeSingle()

      if (existingTask.data) {
        // Skip duplicate task
        continue
      }

      await supabase.from("transaction_tasks").insert({
        transaction_id: params.transactionId,
        title: task.title,
        description: task.description,
        priority: task.priority,
        category: task.category,
        due_date: task.suggestedDeadline,
        assigned_to: task.assignTo,
        ai_generated: true,
        automatable: task.automatable,
        status: "pending",
      })
    }

    revalidatePath(`/transactions/${params.transactionId}`)
    return { success: true, tasks }
  } catch (error) {
    return handleError(error, "generateSmartTasks")
  }
}

/**
 * AI-powered communication drafting for transaction participants
 */
export async function draftTransactionCommunication(params: {
  transactionId: string
  agentId: string
  recipientRole: "buyer" | "seller" | "lender" | "title" | "attorney" | "other_agent"
  communicationType: "update" | "request" | "reminder" | "negotiation" | "congratulations"
  context?: string
}) {
  try {
    const supabase = await createClient()

    const { data: transaction } = await supabase
      .from("transactions")
      .select(`
        *,
        transaction_participants(*),
        transaction_milestones(*),
        listings(*),
        contacts(*)
      `)
      .eq("id", params.transactionId)
      .single()

    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }

    const { data: agent } = await supabase
      .from("users")
      .select("first_name, last_name, phone, email")
      .eq("id", params.agentId)
      .single()

    const recipient = transaction.transaction_participants?.find(
      (p: any) => p.role === params.recipientRole
    )

    const { text: communication } = await generateText({
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

    // Log the communication draft
    await supabase.from("transaction_communications").insert({
      transaction_id: params.transactionId,
      agent_id: params.agentId,
      recipient_role: params.recipientRole,
      communication_type: params.communicationType,
      ai_draft: communication,
      status: "draft",
    })

    return { success: true, communication }
  } catch (error) {
    return handleError(error, "draftTransactionCommunication")
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
      .in("status", ["under_contract", "inspection", "financing", "appraisal", "closing"])

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

    // Update each transaction with risk level
    for (const risk of riskAnalysis.transactionRisks) {
      await supabase
        .from("transactions")
        .update({
          ai_risk_level: risk.riskLevel,
          ai_primary_risk: risk.primaryRisk,
        })
        .eq("id", risk.transactionId)
    }

    return { success: true, riskAnalysis }
  } catch (error) {
    return handleError(error, "monitorTransactionRisks")
  }
}

/**
 * AI-powered closing preparation checklist
 */
export async function prepareForClosing(params: {
  transactionId: string
  agentId: string
  closingDate: string
}) {
  try {
    const supabase = await createClient()

    const { data: transaction } = await supabase
      .from("transactions")
      .select(`
        *,
        transaction_documents(*),
        transaction_participants(*),
        listings(*)
      `)
      .eq("id", params.transactionId)
      .single()

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

    // Save closing preparation
    await supabase.from("transaction_closing_prep").upsert({
      transaction_id: params.transactionId,
      closing_date: params.closingDate,
      readiness_score: closingPrep.readinessScore,
      checklist: closingPrep,
      created_at: new Date().toISOString(),
    })

    revalidatePath(`/transactions/${params.transactionId}`)
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
  agentId: string
}) {
  try {
    const supabase = await createClient()

    const { data: transaction } = await supabase
      .from("transactions")
      .select(`
        *,
        contacts(*),
        listings(*)
      `)
      .eq("id", params.transactionId)
      .single()

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

    // Create follow-up tasks
    const contactId = transaction.contact_id

    // Schedule immediate follow-ups
    for (const followUp of postClosingPlan.immediateFollowUp) {
      await supabase.from("scheduled_touchpoints").insert({
        contact_id: contactId,
        agent_id: params.agentId,
        touchpoint_type: followUp.channel,
        scheduled_date: new Date().toISOString(),
        message_template: followUp.template,
        ai_generated: true,
        status: "scheduled",
      })
    }

    return { success: true, postClosingPlan }
  } catch (error) {
    return handleError(error, "generatePostClosingPlan")
  }
}

// Backward compatibility alias — wrapped because "use server" rejects `const = fn`
export async function getClosingPrep(...args: Parameters<typeof prepareForClosing>) {
  return prepareForClosing(...args)
}
