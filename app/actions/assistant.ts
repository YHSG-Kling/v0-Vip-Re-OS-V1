"use server"

import { createServerClient } from "@/lib/supabase/server"
import { generateTextRouted as generateText } from "@/lib/ai/models"

// =====================================================
// REMOVED (orphan burn-down): handleAssistantQuery, handleAutomationTriggered,
// handleTaskDelegated.
//
// All three were webhook-shaped `(payload: any)` handlers for events this
// codebase does not emit and never has: there is no `assistant.query`,
// `automation.triggered` or `task.delegated` event type in lib/orchestrator,
// no entry for them in the EVENT_HANDLERS map in lib/orchestrator/internal.ts,
// and no case for them in the agent tool-call dispatcher
// (app/api/agent-assistant/tool-call/route.ts). Nothing could reach them.
//
//   · handleAssistantQuery wrote only to `assistant_queries` and
//     handleAutomationTriggered only to `automation_logs` — two tables with no
//     other writer and NO READER anywhere in app/, lib/ or hooks/. Write-only
//     logging for a webhook that does not exist.
//   · handleTaskDelegated reassigned a task. The canonical, wired reassignment
//     path is `updateTask({ taskId, assignedTo })` in app/actions/tasks.ts —
//     this was its drifted webhook twin. KNOWN GAP kept out of scope: updateTask
//     does not notify the new assignee, which is the one thing the deleted
//     handler additionally did. No delegation UI exists today, so nothing
//     regressed — but a task-delegation surface will need that notification.
// =====================================================
// =====================================================
// SMART ASSISTANT SUGGESTIONS
// =====================================================

interface SuggestionInput {
  brokerage_id: string
  user_id: string
  context_type: string
  context_id: string
  suggestion_type: string
  title: string
  description: string
  action_payload: Record<string, any>
}

export async function generateSmartSuggestion(input: SuggestionInput): Promise<void> {
  const supabase = await createServerClient()

  const { data: sugAgentRow } = await supabase
    .from("agents").select("id").eq("user_id", input.user_id).eq("brokerage_id", input.brokerage_id).maybeSingle()
  const suggestionAgentId = (sugAgentRow as { id?: string } | null)?.id ?? null
  if (!suggestionAgentId) return

  // pass 14 (array-literal sweep): the live columns are agent_id /
  // action_payload_json, and context_id rides metadata (no such column) —
  // the old user_id/context_id/action_payload keys errored every insert.
  const { error } = await supabase.from("smart_assistant_suggestions").insert([
    {
      brokerage_id: input.brokerage_id,
      // IDENTITY CLASS (m365). pass 14 fixed the COLUMN NAMES here — its
      // comment above records that the old user_id/context_id keys "errored
      // every insert" — and left the users id in the renamed agents-class
      // column. So the insert still errored, just for a different reason: a
      // rename that moved the bug rather than removing it.
      agent_id: suggestionAgentId,
      context_type: input.context_type,
      suggestion_type: input.suggestion_type,
      title: input.title,
      description: input.description,
      action_payload_json: input.action_payload,
      metadata: { context_id: input.context_id },
      status: "pending",
    },
  ])

  if (error) {
    console.error("[v0] Error creating suggestion:", error)
    throw error
  }
}

/**
 * Suggestion disposition — the two writes behind the accept/dismiss buttons on
 * the coaching dashboard.
 *
 * Both READ their outcome and report the row count. They returned `void`
 * before, so an id that does not exist (or a row RLS hides) was indistinguishable
 * from a successful update — which is exactly how the client-side twin these
 * replace reported "Suggestion dismissed" for a write that never landed.
 */
export async function dismissSuggestion(
  suggestionId: string,
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createServerClient()

  const { data, error } = await supabase
    .from("smart_assistant_suggestions")
    .update({
      // no actioned_at column — status is the canonical action record
      status: "dismissed",
    })
    .eq("id", suggestionId)
    .select("id")

  if (error) return { success: false, error: error.message }
  if (!data?.length) return { success: false, error: "That suggestion no longer exists, or you cannot change it" }
  return { success: true }
}

export async function completeSuggestion(
  suggestionId: string,
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createServerClient()

  // WHO acted is recorded, and it comes from the SESSION — never from a
  // caller-supplied user id. (This audit stamp is the one behaviour worth
  // keeping from copilot.ts's deleted handleSuggestionAccepted twin, which took
  // `acted_by` straight off an unauthenticated webhook payload.)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  // Read-then-merge: metadata carries the suggestion's own context, so replacing
  // it wholesale would destroy it.
  const { data: current } = await supabase
    .from("smart_assistant_suggestions")
    .select("metadata")
    .eq("id", suggestionId)
    .maybeSingle()

  const { data, error } = await supabase
    .from("smart_assistant_suggestions")
    .update({
      // no actioned_at column — status is the canonical action record
      status: "actioned",
      metadata: {
        ...((current?.metadata as Record<string, unknown> | null) ?? {}),
        outcome: "actioned",
        acted_by: user.id,
        acted_at: new Date().toISOString(),
      },
    })
    .eq("id", suggestionId)
    .select("id")

  if (error) return { success: false, error: error.message }
  if (!data?.length) return { success: false, error: "That suggestion no longer exists, or you cannot change it" }
  return { success: true }
}

export async function generateAssistantSuggestions(
  agentId: string,
  context: {
    page: string
    entity_id?: string
    entity_type?: string
  },
) {
  const supabase = await createServerClient()

  const suggestions = []

  switch (context.page) {
    case "contact_detail":
      if (context.entity_id) {
        suggestions.push(...(await getContactSuggestions(context.entity_id)))
      }
      break

    case "listing_detail":
      if (context.entity_id) {
        suggestions.push(...(await getListingSuggestions(context.entity_id)))
      }
      break

    case "dashboard":
      suggestions.push(...(await getDashboardSuggestions(agentId)))
      break

    case "transaction_detail":
      if (context.entity_id) {
        suggestions.push(...(await getTransactionSuggestions(context.entity_id)))
      }
      break
  }

  return { suggestions }
}

async function getContactSuggestions(contactId: string) {
  const supabase = await createServerClient()

  const { data: contact } = await supabase
    .from("contacts")
    .select("*, communications(*), property_interactions(*)")
    .eq("id", contactId)
    .single()

  if (!contact) return []

  const suggestions = []

  // Check last contact date
  const daysSinceContact = contact.last_contact_date
    ? Math.floor((Date.now() - new Date(contact.last_contact_date).getTime()) / (1000 * 60 * 60 * 24))
    : 999

  if (daysSinceContact > 7) {
    suggestions.push({
      type: "action",
      priority: "high",
      icon: "📞",
      title: "Time for a check-in",
      description: `It's been ${daysSinceContact} days since you last connected`,
      action: "send_message",
      action_params: { contact_id: contactId },
    })
  }

  // Check for recent property views
  const recentViews = contact.property_interactions?.filter(
    (i: any) => new Date(i.created_at) > new Date(Date.now() - 24 * 60 * 60 * 1000),
  )

  if (recentViews && recentViews.length >= 3) {
    suggestions.push({
      type: "insight",
      priority: "high",
      icon: "🔥",
      title: "Hot lead alert!",
      description: `${contact.first_name} viewed ${recentViews.length} properties in last 24 hours`,
      action: "call_contact",
      action_params: { contact_id: contactId },
    })
  }

  // Check for missing info
  if (!contact.pre_approved && contact.stage === "searching") {
    suggestions.push({
      type: "reminder",
      priority: "medium",
      icon: "📋",
      title: "Pre-approval status unknown",
      description: "Ask about pre-approval to qualify better",
      action: "update_contact",
      action_params: { contact_id: contactId, field: "pre_approved" },
    })
  }

  // AI-generated suggestion
  try {
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Based on this contact data, suggest ONE specific action the agent should take:
- Name: ${contact.first_name} ${contact.last_name}
- Stage: ${contact.stage}
- Lead Score: ${contact.lead_score || "unknown"}
- Timeline: ${contact.timeline || "unknown"}
- Last Contact: ${daysSinceContact} days ago
- Recent Activity: ${recentViews?.length || 0} property views in 24hrs

Suggest a specific, actionable next step in 1-2 sentences.`,
      temperature: 0.7,
      maxTokens: 400,
    })

    suggestions.push({
      type: "ai_suggestion",
      priority: "medium",
      icon: "💡",
      title: "AI Recommendation",
      description: text,
      action: null,
    })
  } catch (error) {
    console.error("[v0] Error generating AI suggestion:", error)
  }

  return suggestions
}

async function getListingSuggestions(listingId: string) {
  const supabase = await createServerClient()

  const { data: listing } = await supabase.from("listings").select("*").eq("id", listingId).single()

  if (!listing) return []

  const suggestions = []

  // Check days on market
  const daysOnMarket = listing.listing_date
    ? Math.floor((Date.now() - new Date(listing.listing_date).getTime()) / (1000 * 60 * 60 * 24))
    : 0

  if (daysOnMarket > 30 && listing.status === "active") {
    suggestions.push({
      type: "alert",
      priority: "high",
      icon: "⚠️",
      title: "30+ days on market",
      description: "Consider price adjustment or enhanced marketing",
      action: "review_pricing",
      action_params: { listing_id: listingId },
    })
  }

  // Check showing activity
  const { data: recentShowings } = await supabase
    .from("showings")
    .select("*")
    .eq("listing_id", listingId)
    .gte("scheduled_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())

  if ((!recentShowings || recentShowings.length === 0) && listing.status === "active") {
    suggestions.push({
      type: "action",
      priority: "medium",
      icon: "📸",
      title: "Low showing activity",
      description: "Refresh photos or create new video tour",
      action: "schedule_photos",
      action_params: { listing_id: listingId },
    })
  }

  // Check for missing feedback
  const { data: showingsNoFeedback } = await supabase
    .from("showings")
    .select("*")
    .eq("listing_id", listingId)
    .eq("status", "completed")
    .is("feedback", null)

  if (showingsNoFeedback && showingsNoFeedback.length > 0) {
    suggestions.push({
      type: "reminder",
      priority: "high",
      icon: "💬",
      title: `${showingsNoFeedback.length} showings without feedback`,
      description: "Collect feedback to improve showing results",
      action: "request_feedback",
      action_params: { showing_ids: showingsNoFeedback.map((s: any) => s.id) },
    })
  }

  return suggestions
}

async function getTransactionSuggestions(transactionId: string) {
  const supabase = await createServerClient()

  const { data: transaction } = await supabase.from("transactions").select("*").eq("id", transactionId).single()

  if (!transaction) return []

  const suggestions = []

  // Check for overdue documents
  const { data: overdueDocuments } = await supabase
    .from("document_requests")
    .select("*")
    .eq("transaction_id", transactionId)
    .eq("status", "pending")
    .lt("due_date", new Date().toISOString())

  if (overdueDocuments && overdueDocuments.length > 0) {
    suggestions.push({
      type: "alert",
      priority: "critical",
      icon: "🚨",
      title: `${overdueDocuments.length} documents overdue`,
      description: "Follow up with client immediately",
      action: "send_document_reminder",
      action_params: { transaction_id: transactionId },
    })
  }

  // Check closing date proximity
  const daysToClose = transaction.estimated_close_date
    ? Math.floor((new Date(transaction.estimated_close_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : 999

  if (daysToClose <= 7 && daysToClose > 0) {
    suggestions.push({
      type: "reminder",
      priority: "high",
      icon: "📅",
      title: `Closing in ${daysToClose} days`,
      description: "Verify all contingencies removed and final walkthrough scheduled",
      action: "review_checklist",
      action_params: { transaction_id: transactionId },
    })
  }

  return suggestions
}

async function getDashboardSuggestions(agentId: string) {
  const supabase = await createServerClient()
  const suggestions = []

  // Check for pending video approvals
  const { data: pendingVideos, count: videoCount } = await supabase
    .from("video_scripts_library")
    .select("*", { count: "exact" })
    .eq("agent_id", agentId)
    .eq("approval_status", "pending_review")  // the column has no bare 'pending'

  if (videoCount && videoCount > 0) {
    suggestions.push({
      type: "action",
      priority: "medium",
      icon: "🎥",
      title: `${videoCount} videos awaiting approval`,
      description: "Review and approve to send to clients",
      action: "review_videos",
      action_params: { agent_id: agentId },
    })
  }

  // Check for unapproved auto-tasks
  const { data: autoTasks, count: taskCount } = await supabase
    .from("tasks")
    .select("*", { count: "exact" })
    .eq("assigned_to_agent_id", agentId)
    .eq("auto_generated", true)
    .eq("status", "pending")

  if (taskCount && taskCount > 0) {
    suggestions.push({
      type: "action",
      priority: "medium",
      icon: "✅",
      title: `${taskCount} AI-suggested tasks to review`,
      description: "Approve or dismiss AI recommendations",
      action: "review_tasks",
      action_params: { agent_id: agentId },
    })
  }

  return suggestions
}

export async function getCoachingTips(agentId: string) {
  const supabase = await createServerClient()

  // Get recent call coaching insights
  const { data: recentCalls } = await supabase
    .from("call_coaching_insights")
    .select("*")
    .eq("agent_id", agentId)
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(5)

  const tips = []

  if (recentCalls && recentCalls.length > 0) {
    const avgThemFirstScore =
      recentCalls.reduce((sum: number, c: any) => sum + (c.them_first_score || 0), 0) / recentCalls.length

    if (avgThemFirstScore < 0.6) {
      tips.push({
        category: "communication",
        priority: "high",
        tip: 'Focus on "Them First" approach - lead with empathy before solutions',
        improvement_area: "Increase empathy moments in conversations",
      })
    }

    const avgTalkRatio =
      recentCalls.reduce((sum: number, c: any) => sum + (c.talk_listen_ratio || 0.5), 0) / recentCalls.length

    if (avgTalkRatio > 0.6) {
      tips.push({
        category: "communication",
        priority: "medium",
        tip: "You're talking more than listening - aim for 40/60 ratio",
        improvement_area: "Ask more open-ended questions",
      })
    }
  }

  return { tips }
}
