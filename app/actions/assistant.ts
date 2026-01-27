"use server"

import { createServerClient } from "@/lib/supabase/server"
import { generateText } from "ai"

// =====================================================
// EVENT HANDLERS - Called by orchestrator
// =====================================================

export async function handleAssistantQuery(payload: any) {
  const supabase = await createServerClient()
  const { user_id, query, context } = payload

  // Log query for analytics
  await supabase.from("assistant_queries").insert({
    user_id,
    query,
    context,
    timestamp: new Date().toISOString(),
  })

  return { success: true }
}

export async function handleTaskDelegated(payload: any) {
  const supabase = await createServerClient()
  const { task_id, from_user_id, to_user_id, task_title } = payload

  // Update task assignment
  await supabase
    .from("tasks")
    .update({ assigned_to: to_user_id, delegated_by: from_user_id })
    .eq("id", task_id)

  // Notify assignee
  await supabase.from("notifications").insert({
    recipient_id: to_user_id,
    notification_type: "task_delegated",
    title: "New Task Assigned",
    message: `You've been assigned: ${task_title}`,
    related_entity_type: "task",
    related_entity_id: task_id,
  })

  return { success: true }
}

export async function handleAutomationTriggered(payload: any) {
  const supabase = await createServerClient()
  const { automation_id, trigger_type, user_id, result } = payload

  // Log automation execution
  await supabase.from("automation_logs").insert({
    automation_id,
    user_id,
    trigger_type,
    result,
    executed_at: new Date().toISOString(),
  })

  return { success: true }
}

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

  const { error } = await supabase.from("smart_assistant_suggestions").insert([
    {
      brokerage_id: input.brokerage_id,
      user_id: input.user_id,
      context_type: input.context_type,
      context_id: input.context_id,
      suggestion_type: input.suggestion_type,
      title: input.title,
      description: input.description,
      action_payload: input.action_payload,
      status: "pending",
    },
  ])

  if (error) {
    console.error("[v0] Error creating suggestion:", error)
    throw error
  }
}

export async function dismissSuggestion(suggestionId: string): Promise<void> {
  const supabase = await createServerClient()

  await supabase
    .from("smart_assistant_suggestions")
    .update({
      status: "dismissed",
      actioned_at: new Date().toISOString(),
    })
    .eq("id", suggestionId)
}

export async function completeSuggestion(suggestionId: string): Promise<void> {
  const supabase = await createServerClient()

  await supabase
    .from("smart_assistant_suggestions")
    .update({
      status: "actioned",
      actioned_at: new Date().toISOString(),
    })
    .eq("id", suggestionId)
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
      maxTokens: 150,
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
    .gte("showing_date", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())

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
    .eq("attended", true)
    .is("feedback_received", null)

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
    .from("video_scripts")
    .select("*", { count: "exact" })
    .eq("agent_id", agentId)
    .eq("approval_status", "pending")

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
    .eq("assigned_to", agentId)
    .eq("auto_generated", true)
    .eq("agent_approved", false)

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
