"use server"

import { createServerClient, createClient } from "@/lib/supabase/server"
import { agentIdForUser } from "@/lib/agents/agent-for-user"
import { logMilestoneOverdue } from "@/lib/events"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { incrementUsage } from "@/lib/usage"

// =====================================================
// EVENT HANDLERS - Called by orchestrator
// =====================================================

export async function handleSuggestionAccepted(payload: any) {
  const supabase = await createServerClient()
  const { suggestion_id, user_id, action_type } = payload

  // Mark suggestion as accepted
  await supabase
    .from("smart_assistant_suggestions")
    .update({ status: "accepted" })
    .eq("id", suggestion_id)

  // pass 14: suggestion_outcomes was a PHANTOM table — the acceptance already
  // lands on the canonical smart_assistant_suggestions row above (status +
  // metadata carry the outcome); the dead second write is removed.
  await supabase
    .from("smart_assistant_suggestions")
    .update({ metadata: { outcome: "accepted", action_taken: action_type, acted_by: user_id } })
    .eq("id", suggestion_id)

  return { success: true }
}

export async function handleCoachingSessionBooked(payload: any) {
  const supabase = await createServerClient()
  const { user_id, session_date, coach_id, topic } = payload

  // calendar_events requires brokerage_id + entity_type/entity_id (NOT NULL,
  // pass 5 live catch — this insert ALWAYS failed without them) and tasks
  // requires brokerage_id. Resolve both from the agent row once.
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", user_id)
    .maybeSingle()
  if (!agentRow?.brokerage_id) {
    return { success: false, error: "No agent profile for this user — cannot book the session" }
  }

  // Create calendar event
  await supabase.from("calendar_events").insert({
    brokerage_id: agentRow.brokerage_id,
    entity_type: "agent",
    entity_id: agentRow.id,
    agent_user_id: user_id,
    title: `Coaching Session: ${topic}`,
    start_at: session_date,
    end_at: new Date(new Date(session_date).getTime() + 60 * 60 * 1000).toISOString(),
    event_type: "coaching",
    attendees: [coach_id],
  })

  // Create reminder task (assignment keys on agents.id, payload carries users.id)
  await supabase.from("tasks").insert({
    brokerage_id: agentRow.brokerage_id,
    assigned_to_agent_id: agentRow.id,
    title: `Prepare for coaching session: ${topic}`,
    due_date: new Date(new Date(session_date).getTime() - 24 * 60 * 60 * 1000).toISOString(),
    priority: "medium",
  })

  return { success: true }
}

export async function handleMorningKickoff(payload: any) {
  const supabase = await createServerClient()
  const { user_id, brokerage_id } = payload

  // Generate daily priorities
  const { data: todayTasks } = await supabase
    .from("tasks")
    .select("*")
    .eq("assigned_to_agent_id", await agentIdForUser(supabase, user_id))
    .gte("due_date", new Date().toISOString().split("T")[0])
    .lte("due_date", new Date().toISOString().split("T")[0] + "T23:59:59")
    .order("priority", { ascending: false })

  // Create daily summary notification
  // notifications' real shape is user_id/type/body (the phantom recipient_id/
  // notification_type/message insert failed silently — no kickoff ever delivered).
  await supabase.from("notifications").insert({
    user_id: user_id,
    type: "morning_kickoff",
    title: "Good Morning! Here's Your Day",
    body: `You have ${todayTasks?.length || 0} tasks today. Let's make it productive!`,
    priority: "medium",
  })

  return { success: true, taskCount: todayTasks?.length || 0 }
}

export async function generate7DayPlan(payload: any) {
  const supabase = await createServerClient()
  const { contact_id, user_id, lead_source, contact_name } = payload

  // Create 7-day nurture sequence tasks
  const tasks = [
    { day: 0, title: `Welcome call to ${contact_name || "new lead"}`, priority: "urgent" },
    { day: 1, title: "Send personalized property recommendations", priority: "high" },
    { day: 2, title: "Follow up on property interest", priority: "high" },
    { day: 3, title: "Send market update", priority: "medium" },
    { day: 4, title: "Check in - any questions?", priority: "medium" },
    { day: 5, title: "Share neighborhood guide", priority: "medium" },
    { day: 6, title: "Schedule next steps call", priority: "high" },
  ]

  // tasks.brokerage_id is NOT NULL (pass 5) — resolve it with the assignee.
  const { data: nurtureAgent } = await supabase
    .from("agents").select("id, brokerage_id").eq("user_id", user_id).maybeSingle()
  if (!nurtureAgent?.id || !nurtureAgent?.brokerage_id) {
    return { success: false, error: "No agent profile for this user — nurture plan not created" }
  }
  for (const task of tasks) {
    await supabase.from("tasks").insert({
      brokerage_id: nurtureAgent.brokerage_id,
      contact_id,
      assigned_to_agent_id: nurtureAgent.id,
      title: task.title,
      due_date: new Date(Date.now() + task.day * 24 * 60 * 60 * 1000).toISOString(),
      priority: task.priority,
      auto_generated: true,
      source: "lead_nurture",
    })
  }

  // Update contact with nurture status
  await supabase
    .from("contacts")
    .update({ nurture_status: "7_day_plan_active" })
    .eq("id", contact_id)

  return { success: true, tasksCreated: tasks.length }
}

// =====================================================
// COPILOT SERVER ACTIONS
// Transaction milestone tracking and automation
// =====================================================

export async function createTransactionMilestone(params: {
  listing_id: string
  milestone_type: string
  title: string
  due_date: string
  responsible_party?: string
  description?: string
}) {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()
  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  // Create milestone
  const { data, error } = await supabase
    .from("transaction_milestones")
    .insert({
      brokerage_id: profile.brokerage_id,
      milestone_name: params.milestone_type, // NOT NULL on transaction_milestones
      milestone_type: params.milestone_type,
      title: params.title,
      target_date: params.due_date, // real column is target_date (not due_date)
      description: params.description,
      status: "pending",
    })
    .select()
    .single()

  if (error) throw error

  return { success: true, milestone: data }
}

export async function checkOverdueMilestones() {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()
  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  // Find overdue milestones
  const { data: overdueMilestones } = await supabase
    .from("transaction_milestones")
    .select("*")
    .eq("brokerage_id", profile.brokerage_id)
    .eq("status", "pending")
    .lt("target_date", new Date().toISOString())

  if (!overdueMilestones || overdueMilestones.length === 0) {
    return { success: true, count: 0 }
  }

  for (const milestone of overdueMilestones) {
    const daysOverdue = Math.floor((Date.now() - new Date(milestone.target_date).getTime()) / (1000 * 60 * 60 * 24))

    await logMilestoneOverdue({
      brokerage_id: profile.brokerage_id,
      user_id: user.id,
      milestone_id: milestone.id,
      milestone_title: milestone.title,
      days_overdue: daysOverdue,
      listing_id: null, // transaction_milestones links via transaction_id, not listing_id
    })
  }

  return { success: true, count: overdueMilestones.length }
}

export async function completeMilestone(params: { milestone_id: string; completion_notes?: string }) {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  // Mark milestone as complete
  const { data, error } = await supabase
    .from("transaction_milestones")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      notes: params.completion_notes, // real column is notes (not completion_notes)
    })
    .eq("id", params.milestone_id)
    .select()
    .single()

  if (error) throw error

  return { success: true, milestone: data }
}

export async function generateDailyGameplan(userId: string) {
  const supabase = await createServerClient()

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, first_name, last_name")
    .eq("id", userId)
    .single()

  if (!profile?.brokerage_id) {
    return {
      people_to_call: [],
      deals_to_protect: [],
      content_to_post: [],
      ai_summary: null,
      generated_at: new Date().toISOString(),
    }
  }

  // pass 12: contacts.agent_id and video_scripts_library.agent_id FK agents(id);
  // the dashboard calls this with users.id — resolve once (tasks below already did).
  const gameplanAgentId = (await agentIdForUser(supabase, userId)) ?? userId

  // Get hot leads (score > 70)
  const { data: hotLeads } = await supabase
    .from("contacts")
    .select("*, property_interactions(*), communications(*)")
    .eq("agent_id", gameplanAgentId)
    .eq("brokerage_id", profile.brokerage_id)
    .gte("lead_score", 70)
    .order("lead_score", { ascending: false })
    .limit(10)

  // Get at-risk transactions (overdue or due soon)
  const { data: atRiskDeals } = await supabase
    .from("transaction_milestones")
    .select("*, listings(*)")
    .eq("brokerage_id", profile.brokerage_id)
    .eq("status", "pending")
    .lt("target_date", new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString())
    .order("target_date", { ascending: true })
    .limit(10)

  // Get overdue tasks
  const { data: overdueTasks } = await supabase
    .from("tasks")
    .select("*, contacts(*)")
    .eq("assigned_to_agent_id", gameplanAgentId)
    .eq("status", "pending")
    .lt("due_date", new Date().toISOString())
    .order("priority", { ascending: false })
    .limit(10)

  // Get approved content ready to post
  const { data: contentReady } = await supabase
    .from("video_scripts_library")
    .select("*, generated_videos(*), contacts(*)")
    .eq("agent_id", gameplanAgentId)
    .eq("brokerage_id", profile.brokerage_id)
    .eq("approval_status", "approved")
    .is("generated_videos.published_at", null)
    .limit(5)

  // Generate AI-powered gameplan summary
  const { text: aiSummary } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt: `You are an AI real estate copilot helping agents prioritize their day.

Generate a daily gameplan for ${profile.first_name}. Organize into 3 columns:

**PEOPLE TO CALL (Priority Contacts):**
${hotLeads?.map((lead) => `- ${lead.first_name} ${lead.last_name} (Score: ${lead.lead_score}) - Stage: ${lead.stage}`).join("\n") || "No hot leads today"}

**DEALS TO PROTECT (At-Risk Transactions):**
${atRiskDeals?.map((deal) => `- ${deal.listings?.property_address || "Property"} - ${deal.title} (Due: ${new Date(deal.target_date).toLocaleDateString()})`).join("\n") || "No at-risk deals"}

**CONTENT TO POST (Ready to Publish):**
${contentReady?.map((content) => `- Video: ${content.title || "Untitled"} for ${content.contacts?.first_name || "social media"}`).join("\n") || "No content ready"}

**OVERDUE ITEMS:**
${overdueTasks?.map((task) => `- ${task.title} (${task.contacts?.first_name || "No contact"})`).join("\n") || "Nothing overdue"}

Format as actionable priorities with time estimates and recommended order of execution.`,
    temperature: 0.7,
  })

  // Track usage
  await incrementUsage(profile.brokerage_id, "llm_calls", 1)

  return {
    people_to_call: hotLeads || [],
    deals_to_protect: atRiskDeals || [],
    content_to_post: contentReady || [],
    overdue_tasks: overdueTasks || [],
    ai_summary: aiSummary,
    generated_at: new Date().toISOString(),
  }
}

export async function executeCopilotTask(taskId: string, taskType: string, params: any) {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  switch (taskType) {
    case "call_hot_lead":
      return await initiateCall(params.contactId, user.id)

    case "send_property_alert":
      return await sendPropertyMatches(params.contactId)

    case "follow_up_showing":
      return await requestShowingFeedback(params.showingId)

    case "check_transaction_status":
      return await checkTransactionDeadlines(params.transactionId)

    case "post_content":
      return await postVideoContent(params.videoId, params.platforms)

    default:
      return { success: false, error: "Unknown task type" }
  }
}

export async function analyzeContactPriority(contactId: string) {
  const supabase = await createServerClient()

  const { data: contact } = await supabase
    .from("contacts")
    .select("*, property_interactions(*), communications(*)")
    .eq("id", contactId)
    .single()

  if (!contact) return { priority: "low", score: 0, factors: [], recommended_action: "Continue nurture" }

  let score = contact.lead_score || 0
  const factors = []

  // Recent engagement (last 7 days)
  const last7Days = contact.property_interactions?.filter(
    (i: any) => new Date(i.created_at) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  )

  if (last7Days && last7Days.length >= 5) {
    score += 20
    factors.push("High recent activity")
  }

  // Responded to agent recently
  const recentReplies = contact.communications?.filter(
    (c: any) => c.direction === "inbound" && new Date(c.created_at) > new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
  )

  if (recentReplies && recentReplies.length > 0) {
    score += 15
    factors.push("Recently engaged with agent")
  }

  // Timeline urgency
  if (contact.timeline === "asap" || contact.timeline === "urgent") {
    score += 25
    factors.push("Urgent timeline")
  }

  // Financial readiness
  if (contact.pre_approved) {
    score += 20
    factors.push("Pre-approved")
  }

  const priority = score >= 80 ? "critical" : score >= 60 ? "high" : score >= 40 ? "medium" : "low"

  return {
    priority,
    score,
    factors,
    recommended_action:
      score >= 80
        ? "Call immediately"
        : score >= 60
          ? "Send property matches today"
          : score >= 40
            ? "Check in this week"
            : "Continue nurture sequence",
  }
}

export async function suggestNextActions(agentId: string) {
  const supabase = await createServerClient()

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", agentId).single()

  if (!profile?.brokerage_id) return { suggestions: [] }

  // Get agent's recent activity
  const { data: recentActivity } = await supabase
    .from("messages")
    .select("*, contacts(*)")
    .eq("agent_id", agentId)
    .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })

  const suggestions = []

  // Check for unanswered messages
  const unansweredMessages = recentActivity?.filter((comm: any) => comm.direction === "inbound" && !comm.replied_at)

  if (unansweredMessages && unansweredMessages.length > 0) {
    suggestions.push({
      type: "reply_to_client",
      priority: "high",
      action: `Reply to ${unansweredMessages.length} unanswered messages`,
      contact_ids: unansweredMessages.map((m: any) => m.contact_id),
    })
  }

  // Check for showings without feedback
  const { data: showingsNoFeedback } = await supabase
    .from("showings")
    .select("*, contacts(*)")
    .eq("agent_id", agentId)
    .eq("status", "completed")
    .is("feedback", null)
    .gte("scheduled_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())

  if (showingsNoFeedback && showingsNoFeedback.length > 0) {
    suggestions.push({
      type: "collect_feedback",
      priority: "medium",
      action: `Get feedback on ${showingsNoFeedback.length} recent showings`,
      showing_ids: showingsNoFeedback.map((s: any) => s.id),
    })
  }

  // Check for stale contacts (no contact in 14+ days)
  const { data: staleContacts } = await supabase
    .from("contacts")
    .select("*")
    .eq("agent_id", agentId)
    .eq("brokerage_id", profile.brokerage_id)
    .in("status", ["active_client", "hot_lead"])
    .lt("last_contacted_at", new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString())
    .limit(5)

  if (staleContacts && staleContacts.length > 0) {
    suggestions.push({
      type: "check_in",
      priority: "medium",
      action: `Check in with ${staleContacts.length} contacts (no contact in 14+ days)`,
      contact_ids: staleContacts.map((c: any) => c.id),
    })
  }

  return { suggestions }
}

// Helper functions for task execution
async function initiateCall(contactId: string, agentId: string) {
  const supabase = await createClient()

  // voice_calls requires brokerage_id + phone_to (NOT NULL) and agent_id is a FK
  // to agents(id) — but `agentId` here is a users.id, so resolve the agents row.
  const { data: agentUser } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", agentId)
    .maybeSingle()
  const agentsId = await agentIdForUser(supabase, agentId)
  const { data: contactRow } = await supabase
    .from("contacts")
    .select("phone")
    .eq("id", contactId)
    .maybeSingle()

  if (!agentUser?.brokerage_id) {
    return { success: false, error: "Agent has no brokerage scope" }
  }
  if (!agentsId) {
    return { success: false, error: "No agent profile for current user" }
  }
  if (!contactRow?.phone) {
    return { success: false, error: "Contact has no phone number on file" }
  }

  // Create call log entry (real columns: direction='outbound', call_type='agent_call',
  // started_at; phone_to + brokerage_id are NOT NULL)
  const { data: callLog, error } = await supabase
    .from("voice_calls")
    .insert({
      contact_id: contactId,
      agent_id: agentsId,
      brokerage_id: agentUser.brokerage_id,
      phone_to: contactRow.phone,
      direction: "outbound",
      call_type: "agent_call",
      status: "initiated",
      started_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) {
    console.error("[copilot] Failed to create call log:", error)
    return { success: false, error: "Failed to initiate call" }
  }

  await supabase.from("activities").insert({
    brokerage_id: agentUser?.brokerage_id ?? null,
    agent_id: agentId,
    contact_id: contactId,
    activity_type: "call_initiated",
    title: "Outbound call initiated",
    description: "Outbound call initiated via copilot",
    status: "completed",
    entity_type: "contact",
  })
  
  return { success: true, message: "Call initiated", callLogId: callLog?.id }
}

async function sendPropertyMatches(contactId: string) {
  const supabase = await createClient()
  
  // Criteria live in property_preferences (NOT contacts) — read via the single normalized
  // reader. The old code selected preferred_* columns off contacts (non-existent) and
  // filtered listings by `price` (the column is list_price), so it matched nothing.
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, agent_id, brokerage_id")
    .eq("id", contactId)
    .single()

  if (!contact) {
    return { success: false, error: "Contact not found" }
  }

  const { loadBuyerCriteria } = await import("@/lib/buyer-search/buyer-criteria")
  const criteria = await loadBuyerCriteria(supabase as unknown as Parameters<typeof loadBuyerCriteria>[0], contactId)

  // Find matching properties based on preferences
  let query = supabase.from("listings").select("*").eq("status", "active")

  if (criteria?.minPrice) {
    query = query.gte("list_price", criteria.minPrice)
  }
  if (criteria?.maxPrice) {
    query = query.lte("list_price", criteria.maxPrice)
  }
  if (criteria?.minBeds) {
    query = query.gte("bedrooms", criteria.minBeds)
  }
  
  const { data: matches } = await query.limit(10)
  
  // Create property match notification
  if (matches && matches.length > 0) {
    await supabase.from("notifications").insert({
      contact_id: contactId,
      type: "property_matches",
      title: `${matches.length} New Property Matches`,
      body: `We found ${matches.length} properties matching your preferences.`,
      entity_type: "property_match",
    })
  }
  
  return { success: true, message: `Sent ${matches?.length || 0} property matches`, matchCount: matches?.length || 0 }
}

async function requestShowingFeedback(showingId: string) {
  const supabase = await createClient()

  // Get showing details — need brokerage_id since showing_feedback_requests
  // is brokerage-scoped (NOT NULL).
  const { data: showing } = await supabase
    .from("showing_requests")
    .select("id, brokerage_id, contact_id, property_address")
    .eq("id", showingId)
    .single()

  if (!showing) {
    return { success: false, error: "Showing not found" }
  }

  if (!showing.brokerage_id) {
    return { success: false, error: "Showing missing brokerage scope" }
  }

  // Resolve the contact's email so we can dispatch the feedback request.
  // Without an email there is no recipient; fail explicitly rather than
  // writing a row that can never be delivered.
  const { data: contact } = await supabase
    .from("contacts")
    .select("email")
    .eq("id", showing.contact_id)
    .maybeSingle()

  if (!contact?.email) {
    return { success: false, error: "Contact has no email on file" }
  }

  const feedbackToken = crypto.randomUUID()
  const { error } = await supabase.from("showing_feedback_requests").insert({
    brokerage_id: showing.brokerage_id,
    showing_id: showingId,
    feedback_token: feedbackToken,
    sent_to_email: contact.email,
    sent_at: new Date().toISOString(),
  })

  if (error) {
    console.error("[copilot] Failed to create feedback request:", error)
    return { success: false, error: "Failed to request feedback" }
  }

  return { success: true, message: "Feedback requested" }
}

async function checkTransactionDeadlines(transactionId: string) {
  const supabase = await createClient()
  
  // Get transaction with milestones
  const { data: transaction } = await supabase
    .from("transactions")
    .select("*, milestones:transaction_milestones(*)")
    .eq("id", transactionId)
    .single()
  
  if (!transaction) {
    return { success: false, error: "Transaction not found" }
  }
  
  const now = new Date()
  const upcomingDeadlines = []
  const overdueDeadlines = []
  
  // Check milestone deadlines
  for (const milestone of (transaction.milestones || [])) {
    if (milestone.status !== "completed" && milestone.due_date) {
      const dueDate = new Date(milestone.due_date)
      const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      
      if (daysUntilDue < 0) {
        overdueDeadlines.push({ ...milestone, daysOverdue: Math.abs(daysUntilDue) })
      } else if (daysUntilDue <= 7) {
        upcomingDeadlines.push({ ...milestone, daysUntilDue })
      }
    }
  }
  
  return { 
    success: true, 
    message: `${overdueDeadlines.length} overdue, ${upcomingDeadlines.length} upcoming deadlines`,
    overdueDeadlines,
    upcomingDeadlines,
  }
}

async function postVideoContent(videoId: string, platforms: string[]) {
  const supabase = await createClient()
  
  // Get video details
  const { data: video } = await supabase
    .from("video_content")
    .select("*, agent_id, brokerage_id, title, video_url, thumbnail_url")
    .eq("id", videoId)
    .single()
  
  if (!video) {
    return { success: false, error: "Video not found" }
  }
  
  // Create scheduled posts for each platform
  const posts = []
  for (const platform of platforms) {
    // social_posts has no video_id/thumbnail_url columns; the video is linked via
    // post_brief (the pattern used by distribute-video.ts / lib/kernel/video.ts).
    const { data: post } = await supabase.from("social_posts").insert({
      brokerage_id: video.brokerage_id,
      agent_id: video.agent_id,
      platform,
      post_type: "custom",
      content: video.title,
      media_urls: [video.video_url],
      post_brief: `video:${videoId}`,
      status: "scheduled",
      scheduled_for: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 mins from now
    }).select().single()
    
    if (post) posts.push(post)
  }
  
  return { success: true, message: `Content scheduled for ${posts.length} platforms`, posts }
}
