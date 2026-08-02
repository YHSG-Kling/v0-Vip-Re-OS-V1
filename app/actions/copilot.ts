"use server"

import { createServerClient, createClient } from "@/lib/supabase/server"
import { agentIdForUser } from "@/lib/agents/agent-for-user"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { incrementUsage } from "@/lib/usage"

// =====================================================
// EVENT HANDLERS - Called by orchestrator
// =====================================================
//
// REMOVED (orphan burn-down): handleSuggestionAccepted, handleCoachingSessionBooked,
// handleMorningKickoff. All three were `(payload: any)` handlers for events with
// no emitter — no entry in EVENT_HANDLERS (lib/orchestrator/internal.ts), no
// event type in lib/orchestrator/event-types.ts, no case in the agent tool-call
// dispatcher, no cron. Each also duplicated a lane that IS wired:
//
//   · handleSuggestionAccepted → smart_assistant_suggestions status write. The
//     survivor is completeSuggestion / dismissSuggestion in app/actions/assistant.ts,
//     wired to the coaching dashboard's Execute / dismiss buttons. Its one extra
//     behaviour — recording WHO acted and WHAT action in metadata — was worth
//     keeping and has been folded into completeSuggestion, with the actor derived
//     from the SESSION rather than from a caller-supplied user_id.
//   · handleMorningKickoff → a "you have N tasks today" notification. The survivor
//     is the real morning lane: app/api/cron/daily-briefing runs at 06:00 for every
//     active agent through lib/intelligence/daily-briefing-generator, and the ranked
//     action queue (lib/agent-action-queue/composer) feeds both the dashboard card
//     and the spoken get_morning_briefing tool.
//   · handleCoachingSessionBooked → booked a calendar_event against a `coach_id`.
//     There is no coach entity in this product: `coach_id` and
//     `event_type: "coaching"` appeared nowhere else in app/ or lib/, there is no
//     coaches table and no booking surface. Coaching here is the AI brief loop
//     (lib/kernel/agent-coaching + /dashboard/coaching), not human sessions.

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
  // ONE INSERT, AND THE RESULT IS READ. Both writes below used to be awaited
  // with the result thrown away, and the function then returned
  // `tasksCreated: tasks.length` — the length of the hardcoded template array
  // above. That is 7 whether seven rows landed or zero did. It matters here
  // more than most: the orchestrator fires this on lead.created, and a leads.id
  // is not a contacts.id — tasks.contact_id FKs contacts, so a lead id makes
  // every insert FK-reject and the contacts update match nothing, while the
  // caller is told a seven-touch nurture plan is running.
  const { data: created, error: taskErr } = await supabase
    .from("tasks")
    .insert(
      tasks.map((task) => ({
        brokerage_id: nurtureAgent.brokerage_id,
        contact_id,
        assigned_to_agent_id: nurtureAgent.id, // agents.id — tasks.assigned_to_agent_id FKs agents
        title: task.title,
        due_date: new Date(Date.now() + task.day * 24 * 60 * 60 * 1000).toISOString(),
        priority: task.priority,
        auto_generated: true,
        source: "lead_nurture",
      })),
    )
    .select("id")

  if (taskErr) {
    return { success: false, error: `Nurture plan not created: ${taskErr.message}` }
  }

  const { data: marked, error: statusErr } = await supabase
    .from("contacts")
    .update({ nurture_status: "7_day_plan_active" })
    .eq("id", contact_id)
    .select("id")

  if (statusErr) {
    return { success: false, error: `Tasks created, but the contact was not marked: ${statusErr.message}` }
  }
  if (!marked?.length) {
    return { success: false, error: "No contact matched that id — the nurture plan has no owner" }
  }

  // The number of rows that actually landed.
  return { success: true, tasksCreated: created?.length ?? 0 }
}

// =====================================================
// COPILOT SERVER ACTIONS
// Transaction milestone tracking and automation
// =====================================================

// REMOVED (orphan burn-down): createTransactionMilestone, checkOverdueMilestones.
// Both were drifted twins of the canonical, kernel-integrated milestone lane in
// lib/transactions/, and both were broken in ways that only stayed invisible
// because nothing called them:
//
//   · createTransactionMilestone took a `listing_id` it never wrote and never
//     wrote `transaction_id` either, so every milestone it inserted belonged to
//     no transaction and would have rendered in no transaction's milestone list.
//     The canonical creation lane is lib/transactions/milestone-service.ts
//     (seedJourneyMilestones / ensureRequiredMilestones), which stamps the
//     transaction, seeds the matching deadlines and fans out to the lifecycle
//     kernel. It IS called (app/actions/transaction-milestones.ts, title-portal,
//     transaction-inspections).
//   · checkOverdueMilestones only logged an event. The canonical overdue path is
//     lib/transactions/deadline-monitor.ts:checkTransactionDeadlines, which marks
//     the row overdue, transitions lifecycle state through the kernel
//     (transitionLifecycle), files an urgent activity and notifies agent + TC +
//     broker on the critical milestones. That is the advanced path, so it is the
//     one that survives. KNOWN GAP, reported not fixed: checkTransactionDeadlines
//     itself has no cron route calling it — it is exported from
//     lib/transactions/index.ts and never invoked, so nothing currently sweeps for
//     overdue milestones on a schedule.

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
  //
  // RESOLVE, NEVER SUBSTITUTE. This was `?? userId` — falling back to the USERS
  // id when no agents row resolved, then filtering four agents-class columns
  // (contacts.agent_id, tasks.assigned_to_agent_id, video_scripts_library.agent_id)
  // by it. Those are different id spaces, so every query silently matched nothing
  // and the agent was shown an empty gameplan as if their day were clear. An
  // unresolvable agent gets the same honest empty shape as a missing brokerage.
  const gameplanAgentId = await agentIdForUser(supabase, userId)
  if (!gameplanAgentId) {
    return {
      people_to_call: [],
      deals_to_protect: [],
      content_to_post: [],
      ai_summary: null,
      generated_at: new Date().toISOString(),
    }
  }

  // Get hot leads (score > 70)
  // communications was a writer-less legacy table (burn-down round 6 repoint) — recent replies now read from messages (direction='inbound')
  const { data: hotLeadRows } = await supabase
    .from("contacts")
    .select("*, property_interactions(*)")
    .eq("agent_id", gameplanAgentId)
    .eq("brokerage_id", profile.brokerage_id)
    .gte("lead_score", 70)
    .order("lead_score", { ascending: false })
    .limit(10)

  const hotLeadIds = (hotLeadRows ?? []).map((l: any) => l.id)
  const { data: hotLeadReplies } = hotLeadIds.length
    ? await supabase
        .from("messages")
        .select("id, contact_id, direction, type, body, created_at")
        .in("contact_id", hotLeadIds)
        .eq("direction", "inbound")
    : { data: [] as any[] }
  const hotLeads = (hotLeadRows ?? []).map((l: any) => ({
    ...l,
    communications: (hotLeadReplies ?? []).filter((m: any) => m.contact_id === l.id),
  }))

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
      // No agent id passed: the canonical calling lane derives the agent from
      // the session, which is where user.id came from anyway.
      return await initiateCall(params.contactId)

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

// REMOVED (orphan burn-down): analyzeContactPriority, suggestNextActions.
//
//   · analyzeContactPriority was a SECOND lead scorer. It read contacts.lead_score
//     and then added its own weights (+20 recent activity, +15 recent reply, +25
//     urgent timeline, +20 pre-approved) into its own priority bands, producing a
//     number that would disagree with the canonical one for the same contact.
//     lib/services/lead-management.service.ts:calculateLeadScore is the single
//     canonical implementation — it documents that EVERY write to
//     contacts.lead_score / leads.lead_score must go through it (see
//     lib/lead-scoring/LAYERING.md) and it is called from the contact pipeline,
//     lead governance, enrichment orchestration and the acquisition handlers.
//     Lead scoring has ONE implementation; this was the second.
//   · suggestNextActions was the simpler twin of the ranked agent action queue.
//     lib/agent-action-queue/composer.ts:composeAgentActionQueue unions seven
//     sources, ranks them with $ impact and severity, and drives BOTH the agent
//     dashboard queue card and the spoken get_morning_briefing voice tool. The
//     deleted version was three hand-rolled queries with no ranking and no
//     disposition. Its own header note already ruled: "If it is still unused when
//     the surface is reviewed, delete it — do not leave it half-alive."

// Helper functions for task execution
async function initiateCall(contactId: string) {
  // NOTHING HERE EVER DIALLED A PHONE. This function used to insert a
  // voice_calls row with status "initiated" and started_at = now(), plus an
  // activities row titled "Outbound call initiated" with status "completed",
  // and return { success: true, message: "Call initiated" } — with no provider
  // call anywhere in it. The agent was told the call was placed, the contact's
  // timeline said they had been rung, and the kernel's conversation memory read
  // that activities row as fact and suppressed the real follow-up.
  //
  // The OS already has exactly one agent→contact calling lane that works:
  // initiateWhisperBridge places the call through Twilio, checks the provider
  // result, and only then writes voice_calls with the real vendor_call_id.
  // Delegating rather than re-implementing also satisfies the standing rule
  // that a provider gets one caller, not two. It derives the agent from the
  // session, which is the same actor `agentId` came from (executeCopilotTask
  // passes the authenticated user's own id).
  const { initiateWhisperBridge } = await import("@/app/actions/voice-call-bridge")
  const bridge = await initiateWhisperBridge({
    contactId,
    context: "call requested from the copilot",
  })

  if (!bridge.success) {
    return { success: false, error: bridge.error ?? "The call was not placed" }
  }

  return {
    success: true,
    message: "Calling you now — we'll connect the contact when you pick up",
    callSid: bridge.callSid,
  }
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
  // tenant anchor (scope burn-down): matches come from the contact's own brokerage
  let query = supabase
    .from("listings")
    .select("*")
    .eq("brokerage_id", contact.brokerage_id)
    .eq("status", "active")

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
  
  // video_assets is the canonical video store (video_content was a writer-less
  // legacy twin — burn-down round 3 repoint; same column names).
  const { data: video } = await supabase
    .from("video_assets")
    .select("id, agent_id, brokerage_id, title, video_url, thumbnail_url")
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
