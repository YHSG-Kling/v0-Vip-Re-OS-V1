"use server"

import { createServerClient } from "@/lib/supabase/server"
import { agentIdForUser } from "@/lib/agents/agent-for-user"
import { logCreditStatusUpdated } from "@/lib/events"
import { sendSMS } from "@/lib/providers/messaging"

// =====================================================
// CREDIT COPILOT SERVER ACTIONS
// Integrated with event system for automation
// =====================================================

export async function updateContactCreditStatus(params: {
  contact_id: string
  credit_status: string
  credit_score_band?: string
  lender_status?: string
  credit_pipeline_stage?: string
  notes?: string
}) {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()
  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  // Get current contact to compare old status
  const { data: currentContact } = await supabase
    .from("contacts")
    .select("credit_status, credit_score_band")
    .eq("id", params.contact_id)
    .single()

  // Update contact credit fields
  const { data, error } = await supabase
    .from("contacts")
    .update({
      credit_status: params.credit_status,
      credit_score_band: params.credit_score_band,
      lender_status: params.lender_status,
      credit_pipeline_stage: params.credit_pipeline_stage,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.contact_id)
    .select()
    .single()

  if (error) throw error

  if (currentContact && currentContact.credit_status !== params.credit_status) {
    await logCreditStatusUpdated({
      brokerage_id: profile.brokerage_id,
      user_id: user.id,
      contact_id: params.contact_id,
      old_status: currentContact.credit_status || "unknown",
      new_status: params.credit_status,
      score_band: params.credit_score_band,
    })
  }

  return { success: true, contact: data }
}

export async function logCreditConversation(params: {
  contact_id: string
  agent_id: string
  conversation_type: string
  summary: string
  recommendations?: string[]
  next_steps?: string
}) {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  // Insert credit conversation log
  const { data, error } = await supabase
    .from("credit_conversation_log")
    .insert({
      contact_id: params.contact_id,
      agent_id: params.agent_id,
      conversation_type: params.conversation_type,
      summary: params.summary,
      recommendations: params.recommendations,
      next_steps: params.next_steps,
    })
    .select()
    .single()

  if (error) throw error

  return { success: true, log: data }
}

export async function referToCreditPartner(params: {
  contact_id: string
  partner_id: string
  referral_notes?: string
  expected_timeline?: string
}) {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()
  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  // Create partner referral record. CHECK on status allows
  //   referred | in_progress | completed | declined.
  // 'pending' (the legacy value) gets rejected; map to 'referred'.
  const { data, error } = await supabase
    .from("credit_partner_referrals")
    .insert({
      contact_id: params.contact_id,
      partner_id: params.partner_id,
      referring_agent_id: user.id,
      referral_notes: params.referral_notes,
      expected_timeline: params.expected_timeline,
      status: "referred",
      brokerage_id: profile.brokerage_id,
    })
    .select()
    .single()

  if (error) throw error

  return { success: true, referral: data }
}

// =====================================================
// EVENT HANDLERS - Called by orchestrator
// =====================================================

export async function handlePartnerStatusUpdate(payload: any) {
  const supabase = await createServerClient()
  const { contact_id, partner_id, old_status, new_status, user_id } = payload

  // Create notification
  if (user_id) {
    await supabase.from("notifications").insert({
      user_id: user_id,
      type: "partner_status_update",
      title: "Partner Status Updated",
      body: `Credit partner status changed from ${old_status} to ${new_status}.`,
      entity_type: "contact",
      entity_id: contact_id,
    })
  }

  // Create follow-up task based on new status
  if (new_status === "approved") {
    await supabase.from("tasks").insert({
      contact_id,
      assigned_to_agent_id: await agentIdForUser(supabase, user_id),
      title: "Schedule credit program kickoff",
      due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      priority: "high",
    })
  }

  return { success: true }
}

export async function handleTargetReached(payload: any) {
  const supabase = await createServerClient()
  const { contact_id, target_score, actual_score, user_id } = payload

  // Update contact to ready for home buying
  await supabase
    .from("contacts")
    .update({
      credit_status: "good",
      credit_pipeline_stage: "target_score_reached",
    })
    .eq("id", contact_id)

  // Create celebration notification
  if (user_id) {
    await supabase.from("notifications").insert({
      user_id: user_id,
      type: "credit_target_reached",
      title: "Client Reached Credit Target!",
      body: `Your client reached their target credit score of ${target_score}. Time to re-engage for home buying!`,
      entity_type: "contact",
      entity_id: contact_id,
      priority: "high",
    })
  }

  // Create follow-up task
  await supabase.from("tasks").insert({
    contact_id,
    assigned_to_agent_id: await agentIdForUser(supabase, user_id),
    title: "Re-engage client for home buying",
    description: "Client has reached target credit score and is ready to start looking at homes!",
    due_date: new Date().toISOString(),
    priority: "urgent",
  })

  return { success: true }
}

export async function handlePartnerReferral(payload: any) {
  const supabase = await createServerClient()
  const { contact_id, partner_id, partner_name, user_id } = payload

  // Create tracking record. status CHECK = referred|in_progress|completed|declined.
  await supabase.from("credit_partner_referrals").insert({
    contact_id,
    partner_id,
    referring_agent_id: user_id,
    status: "referred",
    referred_at: new Date().toISOString(),
  })

  // Create follow-up task
  await supabase.from("tasks").insert({
    contact_id,
    assigned_to_agent_id: await agentIdForUser(supabase, user_id),
    title: `Follow up on ${partner_name} referral`,
    due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    priority: "medium",
  })

  return { success: true }
}

export async function getCreditPipelineStats(agentId: string) {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  // Get all accounts for this agent
  const { data: accounts, error } = await supabase
    .from("credit_accounts")
    .select("*, contact:contacts(*)")
    .eq("contact.agent_id", agentId)

  if (error) throw error

  // Calculate stats
  const totalValue = accounts?.reduce((sum, acc) => sum + (acc.credit_amount || 0), 0) || 0
  const totalAccounts = accounts?.length || 0

  // Calculate average time to close (simplified - you'd calculate from stage_history)
  const avgTimeToClose = 45 // placeholder

  // Count by stage
  const byStage = {
    flow_a: accounts?.filter((a) => a.current_stage === "flow_a").length || 0,
    flow_b: accounts?.filter((a) => a.current_stage === "flow_b").length || 0,
    flow_c: accounts?.filter((a) => a.current_stage === "flow_c").length || 0,
    flow_d: accounts?.filter((a) => a.current_stage === "flow_d").length || 0,
    flow_e: accounts?.filter((a) => a.current_stage === "flow_e").length || 0,
  }

  return {
    total_value: totalValue,
    total_accounts: totalAccounts,
    avg_time_to_close: avgTimeToClose,
    by_stage: byStage,
    accounts: accounts || [],
  }
}

export async function advanceCreditFlow(accountId: string, toStage: string, notes?: string) {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  // Get current account with related data
  const { data: currentAccount } = await supabase
    .from("credit_accounts")
    .select("*, contact:contacts(*)")
    .eq("id", accountId)
    .single()

  if (!currentAccount) throw new Error("Account not found")

  // Build updated stage history
  const stageHistory = currentAccount.stage_history || []
  stageHistory.push({
    from_stage: currentAccount.current_stage,
    to_stage: toStage,
    changed_at: new Date().toISOString(),
    changed_by: user.id,
    notes: notes,
  })

  // Update account
  const { data, error } = await supabase
    .from("credit_accounts")
    .update({
      current_stage: toStage,
      stage_history: stageHistory,
      updated_at: new Date().toISOString(),
    })
    .eq("id", accountId)
    .select()
    .single()

  if (error) throw error

  // Trigger stage-specific actions
  await triggerCreditFlowActions(accountId, toStage, currentAccount)

  return { success: true, account: data }
}

async function triggerCreditFlowActions(accountId: string, stage: string, account: any) {
  const supabase = await createServerClient()

  switch (stage) {
    case "flow_a": // Initial Lead
      // Create follow-up task
      await supabase.from("tasks").insert({
        contact_id: account.contact_id,
        title: "Send credit info packet to lead",
        description: `Follow up with ${account.contact.first_name} about credit repair options`,
        due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        priority: "high",
        source: "credit_followup",
      })
      break

    case "flow_b": // Application Started
      // Create application completion reminder
      await supabase.from("tasks").insert({
        contact_id: account.contact_id,
        title: "Follow up on application completion",
        description: "Check if client needs help completing credit application",
        due_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        priority: "high",
        source: "credit_followup",
      })

      // Send encouragement SMS
      if (account.contact.phone) {
        await sendSMS({
          to: account.contact.phone,
          contactId: account.contact_id,
          message: `Hi ${account.contact.first_name}! Just checking in on your credit application. Let me know if you need any help completing it. I'm here to support you!`,
        })
      }
      break

    case "flow_c": // Application Submitted
      // Notify partner if configured
      if (account.partner_name) {
        // notifications requires a user recipient and external credit partners have
        // no platform user — record the submission on the contact's activity
        // timeline instead (the phantom recipient_type insert failed silently).
        await supabase.from("activities").insert({
          contact_id: account.contact_id,
          activity_type: "credit_application_submitted",
          title: "Credit application submitted to partner",
          description: `Application submitted for ${account.contact.first_name} ${account.contact.last_name} (partner: ${account.partner_name})`,
          status: "completed",
          created_at: new Date().toISOString(),
        })
      }

      // Update contact credit pipeline stage
      await supabase.from("contacts").update({ credit_pipeline_stage: "in_program" }).eq("id", account.contact_id)
      break

    case "flow_d": // Approved
      // Send congratulations SMS
      if (account.contact.phone) {
        await sendSMS({
          to: account.contact.phone,
          contactId: account.contact_id,
          message: `🎉 Great news ${account.contact.first_name}! Your credit application has been approved. Next steps coming soon!`,
        })
      }

      // Create task to schedule next meeting
      await supabase.from("tasks").insert({
        contact_id: account.contact_id,
        title: "Schedule credit program kickoff call",
        description: "Schedule call to review credit improvement program",
        due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        priority: "high",
        source: "credit_meeting",
      })
      break

    case "flow_e": // Funded/Closed
      // Mark as complete
      await supabase
        .from("credit_accounts")
        .update({
          account_status: "closed",
          closed_at: new Date().toISOString(),
        })
        .eq("id", accountId)

      // Update contact status
      await supabase
        .from("contacts")
        .update({
          credit_pipeline_stage: "target_score_reached",
          credit_status: "good",
        })
        .eq("id", account.contact_id)

      // Create celebration task
      await supabase.from("tasks").insert({
        contact_id: account.contact_id,
        title: "Send credit success celebration message",
        description: `Congratulate ${account.contact.first_name} on reaching credit goals!`,
        due_date: new Date().toISOString(),
        priority: "high",
        source: "credit_celebration",
      })
      break
  }
}

export async function trackCreditUsage(agentId: string, amount: number) {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  // Get current month's usage
  const currentMonth = new Date().getMonth() + 1
  const currentYear = new Date().getFullYear()

  const { data: usage } = await supabase
    .from("agent_metrics")
    .select("credit_budget_used, credit_budget_limit")
    .eq("agent_id", agentId)
    .gte("period_start", `${currentYear}-${currentMonth.toString().padStart(2, "0")}-01`)
    .single()

  const newUsed = (usage?.credit_budget_used || 0) + amount
  const limit = usage?.credit_budget_limit || 5000 // default limit

  // Update usage
  await supabase.from("agent_metrics").upsert({
    agent_id: agentId,
    credit_budget_used: newUsed,
    credit_budget_limit: limit,
    period_start: `${currentYear}-${currentMonth.toString().padStart(2, "0")}-01`,
    updated_at: new Date().toISOString(),
  })

  // Check if approaching limit
  const percentUsed = (newUsed / limit) * 100

  if (percentUsed >= 80) {
    // Send warning notification
    await supabase.from("notifications").insert({
      user_id: agentId,
      type: "credit_budget_warning",
      title: "Credit Budget Alert",
      body: `You've used ${percentUsed.toFixed(0)}% of your monthly credit budget ($${newUsed.toLocaleString()} of $${limit.toLocaleString()})`,
      // priority check allows low|medium|high|critical ('urgent' violated it)
      priority: percentUsed >= 100 ? "critical" : "high",
    })
  }

  return {
    success: true,
    usage: {
      used: newUsed,
      limit: limit,
      percent_used: percentUsed,
      remaining: limit - newUsed,
    },
  }
}

export async function createCreditAccount(params: {
  contact_id: string
  partner_name: string
  credit_amount: number
  initial_stage?: string
}) {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data, error } = await supabase
    .from("credit_accounts")
    .insert({
      contact_id: params.contact_id,
      partner_name: params.partner_name,
      credit_amount: params.credit_amount,
      current_stage: params.initial_stage || "flow_a",
      account_status: "lead",
      stage_history: [
        {
          to_stage: params.initial_stage || "flow_a",
          changed_at: new Date().toISOString(),
          changed_by: user.id,
        },
      ],
    })
    .select()
    .single()

  if (error) throw error

  // Track credit usage
  await trackCreditUsage(user.id, params.credit_amount)

  return { success: true, account: data }
}
