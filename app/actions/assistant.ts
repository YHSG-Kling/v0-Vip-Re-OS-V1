"use server"

import { createServerClient } from "@/lib/supabase/server"
import { generateTextRouted as generateText } from "@/lib/ai/models"

// =====================================================
// EVENT HANDLERS — exposed as server actions but no UI currently invokes them.
// They originally had zero auth and would accept arbitrary payloads (any
// authenticated user could delegate any task to anyone, log queries as any
// user, etc.). Hardened: caller must own the relevant user_id, OR be admin.
//
// ORPHAN BURN-DOWN — SETTLED, AS AN OWNER DECISION. They are NOT event handlers,
// and the earlier note that they were "a build line blocked on the orchestrator
// lane" rested on a premise that does not survive reading the orchestrator.
//
// THE DISPROOF, in three checks anyone can repeat:
//   1. `lib/orchestrator/internal.ts:EVENT_HANDLERS` IS NOT A DISPATCH PATH.
//      `orchestrateEvent` routes through `switch (event.event_type)` (internal.ts
//      :158-202); the map is never read at runtime and its own header says so.
//      Adding a name to it changes nothing that runs.
//   2. THERE IS NO EVENT. `lib/events/types.ts:29-54` is the whole EVENT_TYPES
//      vocabulary. It has no member for an assistant query, a task delegation or an
//      automation firing — and no member for the copilot three either. The closest,
//      `AI_SUGGESTION_ACTIONED`, has ZERO emitters repo-wide.
//   3. So the recorded blocker (a service-credentialed dispatcher versus a session
//      gate) is real but MOOT: an internal-caller seam would gate a dispatch that
//      never occurs. Building it would put a door on a wall and make six functions
//      look wired while firing exactly as often as they do now, which is never.
//
// WHAT THEY ARE INSTEAD — each is user-initiated, not event-driven:
//   · handleAssistantQuery / handleAutomationTriggered — TELEMETRY. Each is the SOLE
//     writer of its table (`assistant_queries`, `automation_logs`) and NEITHER table
//     has a reader anywhere in the repo; scripts/orphan-write-sweep.ts:38 already
//     classifies assistant_queries as "assistant usage telemetry". They are kept as
//     the write half of a telemetry pair whose read half was never built. Not
//     deleted (no duplicate, and deleting the only writer of a live table loses the
//     column), not registered (nothing emits an event for them).
//   · handleTaskDelegated — MERGED, THEN DELETED. It was a TASK REASSIGNMENT, and
//     app/actions/tasks.ts:updateTask (`params.assignedTo` → `assigned_to_agent_id`)
//     is the wired survivor of that write. The cross-lane merge this note named is
//     now done: the survivor carries BOTH items this copy held and it did not — the
//     ownership test before a reassignment (current assignee, creator, or
//     broker/admin) and the notice to the new assignee, tenant-stamped through
//     lib/notifications/recipient-tenant.ts. It carries them WITH the tenant
//     predicate this copy never had: handleTaskDelegated read and updated `tasks` by
//     id with NO brokerage scope, so a delegator could probe and reassign a task in
//     another brokerage as long as they happened to be its assignee there.
// =====================================================

// The gate this file grew privately now lives in ONE place and is shared with
// app/actions/copilot.ts, whose identical event handlers had no gate at all. Two behaviours
// moved WITH it rather than being lost:
//   · it destructures `error` on both reads (supabase-js RESOLVES a refused query, so a
//     refusal used to be indistinguishable from "no such user" — in a gate those must differ);
//   · a missing `targetUserId` no longer falls through to the role check by accident — an
//     unstated target now requires the act-for-others role explicitly.
// See lib/auth/authorize-for-user.ts for why it is a plain module (server-only would break
// any plain-tsx guard that transitively imports it).
import { authorizeForUser } from "@/lib/auth/authorize-for-user"

export async function handleAssistantQuery(payload: any) {
  const { user_id, query, context } = payload
  const auth = await authorizeForUser(user_id)
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createServerClient()
  await supabase.from("assistant_queries").insert({
    user_id,
    query,
    context,
    timestamp: new Date().toISOString(),
  })

  return { success: true }
}

export async function handleAutomationTriggered(payload: any) {
  const { automation_id, trigger_type, user_id, result } = payload
  const auth = await authorizeForUser(user_id)
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createServerClient()
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
 * Both of these used to return void and DROP the supabase error. supabase-js
 * resolves a rejected update rather than throwing, so a suggestion that failed
 * to move disappeared from the coaching list anyway and reappeared on the next
 * load with no explanation. The card is the agent's to-do; silently failing to
 * action it is the worst outcome. Return the real result and let the caller say
 * so.
 */
type SuggestionResult = { success: true } | { success: false; error: string }

/**
 * The suggestion-status writer for the two points THIS file's exports move a card to.
 * `accepted` is a third, distinct point — scripts/1082-broaden-smart-assistant-
 * suggestions-status-check.sql:9-14 defines it as "agent agreed but hasn't completed
 * the action yet" — and its writer is app/actions/copilot.ts:handleSuggestionAccepted.
 * It is deliberately NOT folded in here: doing so meant adding a fourth exported
 * server action with no caller, which is a rename of an orphan and not a burn-down.
 */
async function setSuggestionStatus(
  suggestionId: string,
  status: "dismissed" | "actioned",
): Promise<SuggestionResult> {
  const supabase = await createServerClient()

  const { data: updated, error } = await supabase
    .from("smart_assistant_suggestions")
    // no actioned_at column — status is the canonical action record
    .update({ status })
    .eq("id", suggestionId)
    .select("id")

  if (error) {
    console.error(`[assistant] suggestion ${suggestionId} → ${status} failed:`, error.message)
    return { success: false, error: error.message }
  }
  if (!updated?.length) {
    // supabase-js resolves an update that matched nothing exactly like one that
    // matched a row. Without this the card silently reappears on the next load.
    return { success: false, error: `No suggestion ${suggestionId} is visible to you to mark ${status}` }
  }
  return { success: true }
}

export async function dismissSuggestion(suggestionId: string): Promise<SuggestionResult> {
  return setSuggestionStatus(suggestionId, "dismissed")
}

export async function completeSuggestion(suggestionId: string): Promise<SuggestionResult> {
  return setSuggestionStatus(suggestionId, "actioned")
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

  // Both embeds are single-FK pairs (communications_contact_id_fkey,
  // property_interactions_contact_id_fkey), so neither is ambiguous and neither needs
  // a constraint hint. The error is still checked: supabase-js RESOLVES a failed
  // query, so an unchecked read hands back an absence indistinguishable from a
  // contact with nothing to suggest.
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("*, communications(*), property_interactions(*)")
    .eq("id", contactId)
    .single()

  if (contactError) {
    console.error("[assistant] contact suggestions read failed:", contactError)
    return []
  }
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

  // Check for missing info.
  //
  // THIS BRANCH HAS NEVER RUN. Both operands were phantom columns, not renames:
  // `contacts.stage` and `contacts.pre_approved` do not exist and never have. They
  // are property reads off an already-fetched row, so they evaluated to `undefined`
  // instead of throwing — `undefined === "searching"` is false, so the suggestion was
  // silently unreachable for the entire life of the file.
  //
  // Repointed to the real columns, and to values those columns actually take:
  //   • `contacts.buyer_stage` — NOT lifecycle_state. lifecycle_state is real but its
  //     vocabulary is the lead-funnel one (raw, unconsented, consented, isa_qualifying,
  //     assigned, appointment, representation, long_term_nurture); it has no
  //     "searching" value, so pointing here would have left the branch just as dead.
  //     buyer_stage carries BUYER_SEARCHING ("actively searching" —
  //     lib/buyer-lifecycle/lifecycle-definitions.ts), which is the state this
  //     pre-approval nudge is actually about.
  //   • `contacts.lender_status` — vocabulary ["cash","needs_pre_approval",
  //     "pre_approved","unknown"]. "Not pre-approved" is anything that is not already
  //     pre_approved or paying cash, which also covers the null/unknown case the
  //     suggestion's own copy ("Pre-approval status unknown") describes.
  if (
    contact.lender_status !== "pre_approved" &&
    contact.lender_status !== "cash" &&
    contact.buyer_stage === "BUYER_SEARCHING"
  ) {
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
- Buyer Stage: ${contact.buyer_stage || "unknown"}
- Lifecycle: ${contact.lifecycle_state || "unknown"}
- Pre-approval: ${contact.lender_status || "unknown"}
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
