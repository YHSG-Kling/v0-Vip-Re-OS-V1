"use server"

import { createServerClient } from "@/lib/supabase/server"
import { bestEffort } from "@/lib/db/best-effort"
import { getAgentContext } from "@/lib/identity"
import { agentIdForUser } from "@/lib/agents/agent-for-user"
import { logCreditStatusUpdated } from "@/lib/events"
import { dispatchSms } from "@/lib/providers/dispatch"
// The ONE way a notifications row gets its tenant — the recipient's
// users.brokerage_id, the exact value badge-counts compares against.
import { resolveRecipientBrokerageId, resolveAgentRecipient } from "@/lib/notifications/recipient-tenant"

// =====================================================
// CREDIT COPILOT SERVER ACTIONS
// Integrated with event system for automation
// =====================================================

/**
 * The contact-level credit posture writer (credit_status / credit_score_band /
 * lender_status / credit_pipeline_stage on `contacts`), distinct from the
 * `credit_accounts` pipeline that `advanceCreditFlow` drives.
 *
 * SECURITY (w4s1): this took a caller-supplied `contact_id` and read + UPDATED
 * `contacts` with NO tenant predicate at all — `profile.brokerage_id` was resolved
 * and then used only to stamp the event log. Consumer credit standing is among the
 * most sensitive fields on the record, and this was a `"use server"` endpoint, so
 * any authenticated user could rewrite any tenant's contact's credit status by id.
 * The update is now brokerage-scoped on the predicate itself (not just checked
 * beforehand), so it is not a TOCTOU either.
 */
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

  if (!params.contact_id) throw new Error("contact_id required")

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()
  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  // contacts_lender_status_check (verified live) admits only these values, or NULL.
  // A rejected value used to fail the whole update with a raw Postgres error after
  // the caller had already been told the form was valid.
  const LENDER_STATUS_VALUES = ["cash", "pre_approved", "needs_pre_approval", "unknown"]
  if (params.lender_status && !LENDER_STATUS_VALUES.includes(params.lender_status)) {
    throw new Error(`lender_status must be one of: ${LENDER_STATUS_VALUES.join(", ")}`)
  }

  // Get current contact to compare old status — brokerage-scoped, and `error` is
  // read: supabase-js RESOLVES a refused query, so a denial would otherwise look
  // like "no previous status" and silently skip the audit event below.
  const { data: currentContact, error: currentErr } = await supabase
    .from("contacts")
    .select("credit_status, credit_score_band")
    .eq("id", params.contact_id)
    .eq("brokerage_id", profile.brokerage_id)
    .maybeSingle()

  if (currentErr) throw new Error("Could not read this contact")
  if (!currentContact) throw new Error("Contact not found")

  // Update contact credit fields. brokerage_id is on the PREDICATE, so the write
  // itself cannot cross tenants even if the row moved between the read and here.
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
    .eq("brokerage_id", profile.brokerage_id)
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

// pass 14: logCreditConversation removed — zero callers and it wrote the phantom
// credit_conversation_log table. Credit conversations ride conversation_logs.

/**
 * Refer a contact to a credit-repair / credit-building partner
 * (`referral_partners`). This DISCLOSES a consumer's credit situation to a third
 * party, so both ends of the referral must be inside the caller's brokerage.
 *
 * SECURITY (w4s1): both ids were taken on trust. `contact_id` was inserted with no
 * check that the contact is the caller's tenant's, and `partner_id` with no check
 * that the partner is either — so a caller could (a) refer another tenant's contact,
 * creating a credit-referral record about a consumer they have no relationship with,
 * and (b) point any referral at another tenant's partner. Both ends are now verified
 * against `profile.brokerage_id` before the insert.
 *
 * DUPLICATE NOTE — the survivor is THIS function
 * (`app/actions/credit-copilot.ts:referToCreditPartner`). The orchestrator handler
 * `handlePartnerReferral` in this same file writes the same
 * `credit_partner_referrals` row for the `credit.partner_referred` event, but (i)
 * NOTHING in the tree emits that event, so it has never run, and (ii) its insert
 * omits `brokerage_id` — an untenanted row about a consumer's credit that no
 * brokerage-scoped query can ever find again. Rather than fork the lane, the one
 * capability it had that this lacked — the agent follow-up task — is ported here,
 * and the missing `brokerage_id` is fixed at the handler so the event door, if it is
 * ever opened, cannot mint an untenanted record.
 */
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

  if (!params.contact_id) throw new Error("contact_id required")
  if (!params.partner_id) throw new Error("partner_id required")

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()
  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  // BOTH ENDS OF THE REFERRAL MUST BE THIS TENANT'S. `error` is destructured on
  // both reads — supabase-js resolves a refused query, and reading a denial as
  // "not found" here is the right outcome (fail closed) only if we say so
  // explicitly rather than by accident.
  const { data: contactRow, error: contactErr } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", params.contact_id)
    .eq("brokerage_id", profile.brokerage_id)
    .maybeSingle()
  if (contactErr) throw new Error("Could not verify the contact")
  if (!contactRow) throw new Error("Contact not found in your brokerage")

  const { data: partnerRow, error: partnerErr } = await supabase
    .from("referral_partners")
    .select("id, partner_name")
    .eq("id", params.partner_id)
    .eq("brokerage_id", profile.brokerage_id)
    .maybeSingle()
  if (partnerErr) throw new Error("Could not verify the credit partner")
  if (!partnerRow) throw new Error("Credit partner not found in your brokerage")

  // Create partner referral record. CHECK on status allows
  //   referred | in_progress | completed | declined.
  // 'pending' (the legacy value) gets rejected; map to 'referred'.
  const { data, error } = await supabase
    .from("credit_partner_referrals")
    .insert({
      contact_id: params.contact_id,
      partner_id: params.partner_id,
      // partner_name and referred_at were written by the (never-dispatched) event
      // handler and not by this lane, so the referral list rendered a blank partner
      // and no referral timestamp. Denormalized from the verified partner row.
      partner_name: partnerRow.partner_name ?? null,
      referred_at: new Date().toISOString(),
      referring_agent_id: user.id,
      referral_notes: params.referral_notes,
      expected_timeline: params.expected_timeline,
      status: "referred",
      brokerage_id: profile.brokerage_id,
    })
    .select()
    .single()

  if (error) throw error

  // PORTED from handlePartnerReferral: a referral with no follow-up is a referral
  // that gets forgotten. tasks.brokerage_id and tasks.assigned_to_agent_id are both
  // NOT NULL, so this only fires when the caller resolves to an agents row —
  // best-effort, and never fails the referral that already succeeded.
  try {
    const { data: agentRow } = await supabase
      .from("agents")
      .select("id, brokerage_id")
      .eq("user_id", user.id)
      .maybeSingle()
    if (agentRow?.id && agentRow?.brokerage_id) {
      await supabase.from("tasks").insert({
        brokerage_id: agentRow.brokerage_id,
        contact_id: params.contact_id,
        assigned_to_agent_id: agentRow.id,
        title: `Follow up on ${partnerRow.partner_name ?? "credit partner"} referral`,
        due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        priority: "medium",
      })
    }
  } catch (err) {
    console.error("[credit-copilot] referral follow-up task failed (non-blocking):", err)
  }

  return { success: true, referral: data }
}

// =====================================================
// EVENT HANDLERS - Called by orchestrator
// =====================================================

export async function handlePartnerStatusUpdate(payload: any) {
  const supabase = await createServerClient()
  const { contact_id, partner_id, old_status, new_status, user_id } = payload

  // Create notification.
  //
  // TENANT — the RECIPIENT's `users.brokerage_id`, resolved ONCE here and reused
  // below rather than re-derived. `user_id` is a users.id; the `agents` row read
  // further down for the tasks insert is a DIFFERENT id space and its
  // `brokerage_id` is NOT what badge-counts compares against, so it is not
  // borrowed for this stamp.
  const statusTenant = await resolveRecipientBrokerageId(supabase, user_id)
  if (!statusTenant.ok) {
    console.error(`[credit-copilot] handlePartnerStatusUpdate: ${statusTenant.reason} — status notification NOT written`)
  }
  if (user_id) {
    if (!statusTenant.ok || !statusTenant.brokerageId) {
      console.error(
        `[credit-copilot] handlePartnerStatusUpdate: no brokerage resolves for recipient ${user_id} — status notification NOT written rather than written where the bell cannot count it`,
      )
    } else {
      const { error: statusNotifyError } = await supabase.from("notifications").insert({
        user_id: user_id,
        brokerage_id: statusTenant.brokerageId,
        type: "partner_status_update",
        title: "Partner Status Updated",
        body: `Credit partner status changed from ${old_status} to ${new_status}.`,
        entity_type: "contact",
        entity_id: contact_id,
      })
      if (statusNotifyError) {
        console.error("[credit-copilot] partner_status_update notification insert refused:", statusNotifyError.message)
      }
    }
  }

  // Create follow-up task based on new status
  if (new_status === "approved") {
    const creditAgentRow = await supabase.from("agents").select("id, brokerage_id").eq("user_id", user_id).maybeSingle().then((r: any) => r.data)
      // tasks.brokerage_id + assigned_to_agent_id are NOT NULL (pass 5) — without both this insert always failed
      if (creditAgentRow?.id && creditAgentRow?.brokerage_id) await supabase.from("tasks").insert({
        brokerage_id: creditAgentRow.brokerage_id,
        contact_id,
        assigned_to_agent_id: creditAgentRow.id,
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

  // Create celebration notification.
  //
  // TENANT — the RECIPIENT's `users.brokerage_id` (the one resolver; see
  // lib/notifications/recipient-tenant.ts). `user_id` is a users.id and is never
  // interchanged with the `agents.id` resolved below for the follow-up task.
  const targetTenant = await resolveRecipientBrokerageId(supabase, user_id)
  if (!targetTenant.ok) {
    console.error(`[credit-copilot] handleTargetReached: ${targetTenant.reason} — celebration notification NOT written`)
  }
  if (user_id) {
    if (!targetTenant.ok || !targetTenant.brokerageId) {
      console.error(
        `[credit-copilot] handleTargetReached: no brokerage resolves for recipient ${user_id} — celebration notification NOT written rather than written where the bell cannot count it`,
      )
    } else {
      const { error: targetNotifyError } = await supabase.from("notifications").insert({
        user_id: user_id,
        brokerage_id: targetTenant.brokerageId,
        type: "credit_target_reached",
        title: "Client Reached Credit Target!",
        body: `Your client reached their target credit score of ${target_score}. Time to re-engage for home buying!`,
        entity_type: "contact",
        entity_id: contact_id,
        priority: "high",
      })
      if (targetNotifyError) {
        console.error("[credit-copilot] credit_target_reached notification insert refused:", targetNotifyError.message)
      }
    }
  }

  // Create follow-up task
  const creditAgentRow = await supabase.from("agents").select("id, brokerage_id").eq("user_id", user_id).maybeSingle().then((r: any) => r.data)
    // tasks.brokerage_id + assigned_to_agent_id are NOT NULL (pass 5) — without both this insert always failed
    if (creditAgentRow?.id && creditAgentRow?.brokerage_id) await supabase.from("tasks").insert({
      brokerage_id: creditAgentRow.brokerage_id,
      contact_id,
      assigned_to_agent_id: creditAgentRow.id,
    title: "Re-engage client for home buying",
    description: "Client has reached target credit score and is ready to start looking at homes!",
    due_date: new Date().toISOString(),
    priority: "urgent",
  })

  return { success: true }
}

/**
 * Orchestrator handler for `credit.partner_referred`. NOTE (w4s1): nothing in the
 * tree emits that event today — `referToCreditPartner` above is the live door and
 * the survivor for this lane. This stays as the event-bus entrance, hardened so it
 * cannot mint an untenanted record if that door is ever opened.
 */
export async function handlePartnerReferral(payload: any) {
  const supabase = await createServerClient()
  const { contact_id, partner_id, partner_name, user_id } = payload

  // Resolve the referring agent FIRST — it is also where brokerage_id comes from.
  const creditAgentRow = await supabase
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", user_id)
    .maybeSingle()
    .then((r: any) => r.data)

  // brokerage_id was omitted entirely, so every row this handler wrote was an
  // untenanted record about a consumer's credit that no brokerage-scoped query
  // could ever find again. Without a resolvable tenant there is nothing correct to
  // write, so it declines rather than writing an orphan row.
  if (!creditAgentRow?.brokerage_id) {
    console.error("[credit-copilot] handlePartnerReferral: no brokerage for user", user_id)
    return { success: false, error: "Could not resolve the referring agent's brokerage" }
  }

  // Create tracking record. status CHECK = referred|in_progress|completed|declined.
  await supabase.from("credit_partner_referrals").insert({
    contact_id,
    partner_id,
    partner_name: partner_name ?? null,
    brokerage_id: creditAgentRow.brokerage_id,
    referring_agent_id: user_id,
    status: "referred",
    referred_at: new Date().toISOString(),
  })

  // Create follow-up task.
  // tasks.brokerage_id + assigned_to_agent_id are NOT NULL (pass 5) — without both this insert always failed
  if (creditAgentRow?.id) {
    await supabase.from("tasks").insert({
      brokerage_id: creditAgentRow.brokerage_id,
      contact_id,
      assigned_to_agent_id: creditAgentRow.id,
      title: `Follow up on ${partner_name ?? "credit partner"} referral`,
      due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      priority: "medium",
    })
  }

  return { success: true }
}

/**
 * The agent is resolved SERVER-side. It previously took an `agentId` argument
 * and the only caller passed `user.id` — a users.id compared against
 * contacts.agent_id, which is an agents.id. Different id spaces, so the filter
 * never matched. Worse, the filter sat on a NON-inner embed, which in PostgREST
 * filters the embedded row and not the parent, so every credit_accounts row in
 * the database came back regardless of tenant. Both are fixed here: the embed is
 * `!inner` and the id comes from the authenticated agent context.
 */
export async function getCreditPipelineStats() {
  const supabase = await createServerClient()

  const { agentId, brokerageId, userId, userType, isAuthenticated } = await getAgentContext()
  if (!isAuthenticated) throw new Error("Not authenticated")

  const emptyStats = {
    success: true as const,
    total_value: 0,
    total_accounts: 0,
    avg_time_to_close: 0,
    by_stage: { flow_a: 0, flow_b: 0, flow_c: 0, flow_d: 0, flow_e: 0 },
    accounts: [] as any[],
    // null, not 0 — "no budget row for this period" is a different fact from
    // "spent nothing", and the page renders them differently.
    budget: null as { used: number; limit: number } | null,
    // THE READER for credit_partner_referrals. Wiring referToCreditPartner made
    // that table write-only — rows nobody could ever see — which is the
    // "outputs nothing consumes" defect test:orphan-writes exists to catch. A
    // referral is a real business record (we told a consumer we handed their
    // credit situation to a named partner), so the verdict is to build the
    // reader, not to drop the write.
    referrals: [] as Array<{
      id: string
      contact_id: string | null
      partner_name: string | null
      status: string | null
      referred_at: string | null
    }>,
  }

  if (!brokerageId) return emptyStats

  let query = supabase
    .from("credit_accounts")
    .select("*, contact:contacts!inner(*)")
    .eq("contact.brokerage_id", brokerageId)

  // An agent sees only their own book; broker/admin roles see the brokerage.
  if (userType === "agent") {
    if (!agentId) return emptyStats
    query = query.eq("contact.agent_id", agentId)
  }

  const { data: accounts, error } = await query

  if (error) {
    return { ...emptyStats, success: false as const, error: error.message }
  }

  // Calculate stats
  const totalValue = accounts?.reduce((sum, acc) => sum + (Number(acc.credit_amount) || 0), 0) || 0
  const totalAccounts = accounts?.length || 0

  // Average days from the first stage_history entry to closed_at, over the
  // accounts that have actually closed. No closed account → 0, not a guess.
  const closed = (accounts ?? []).filter((a: any) => a.closed_at && a.created_at)
  const avgTimeToClose = closed.length
    ? Math.round(
        closed.reduce(
          (sum: number, a: any) =>
            sum + (new Date(a.closed_at).getTime() - new Date(a.created_at).getTime()) / 86_400_000,
          0,
        ) / closed.length,
      )
    : 0

  // Count by stage
  const byStage = {
    flow_a: accounts?.filter((a) => a.current_stage === "flow_a").length || 0,
    flow_b: accounts?.filter((a) => a.current_stage === "flow_b").length || 0,
    flow_c: accounts?.filter((a) => a.current_stage === "flow_c").length || 0,
    flow_d: accounts?.filter((a) => a.current_stage === "flow_d").length || 0,
    flow_e: accounts?.filter((a) => a.current_stage === "flow_e").length || 0,
  }

  // The Budget Used card on /credit-pipeline rendered a hardcoded
  // "$2,400 / $5,000" with a hardcoded 48% bar — a lying number on a live page,
  // while trackCreditUsage has been writing the real figures to
  // agent_credit_budgets all along with nobody reading them.
  //
  // Budget is PER AGENT and per month, so it only means anything for an agent
  // identity; a broker looking at the whole brokerage has no single budget and
  // gets null rather than someone else's.
  const now = new Date()
  const periodStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`
  let budget: { used: number; limit: number } | null = null
  if (agentId) {
    const { data: budgetRow, error: budgetError } = await supabase
      .from("agent_credit_budgets")
      .select("credit_budget_used, credit_budget_limit")
      .eq("agent_id", agentId)
      .eq("period_start", periodStart)
      .maybeSingle()
    if (budgetError) {
      console.error("[credit-copilot] budget read failed:", budgetError.message)
    } else if (budgetRow) {
      budget = {
        used: Number(budgetRow.credit_budget_used) || 0,
        limit: Number(budgetRow.credit_budget_limit) || 0,
      }
    }
  }

  // Partner referrals for this tenant. Scoped on brokerage_id (the column
  // referToCreditPartner stamps); an agent sees only referrals they made, matching
  // the "own book" rule applied to accounts above. `error` is destructured — a
  // refused read must render as a refusal, not as "no referrals", because an empty
  // referral list is a claim that we never handed this consumer to anyone.
  let referralQuery = supabase
    .from("credit_partner_referrals")
    .select("id, contact_id, partner_name, status, referred_at")
    .eq("brokerage_id", brokerageId)
    .order("referred_at", { ascending: false })
    .limit(100)
  // Filter on userId, NOT agentId. `referring_agent_id` is named for an agent but
  // carries no foreign key, and referToCreditPartner writes `user.id` into it —
  // the auth/users id space, which is disjoint from agents.id. Filtering it by
  // agentId would compare two different id spaces and match nothing, so every
  // agent would be told they had made no referrals. Verified against the live
  // schema: credit_partner_referrals has FKs on contact_id, brokerage_id and
  // partner_id only.
  if (userType === "agent" && userId) {
    referralQuery = referralQuery.eq("referring_agent_id", userId)
  }
  const { data: referralRows, error: referralError } = await referralQuery
  if (referralError) {
    return { ...emptyStats, success: false as const, error: referralError.message }
  }

  return {
    success: true as const,
    total_value: totalValue,
    total_accounts: totalAccounts,
    avg_time_to_close: avgTimeToClose,
    by_stage: byStage,
    accounts: accounts || [],
    budget,
    referrals: (referralRows ?? []) as typeof emptyStats.referrals,
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

  // Resolve the brokerage so every client SMS routes through the consent/quiet-hours/de-confliction
  // gate (dispatchSms) instead of the raw sender — no ungoverned egress.
  let brokerageId: string = account?.brokerage_id ?? ""
  if (!brokerageId && account?.contact_id) {
    const { data: c } = await supabase.from("contacts").select("brokerage_id").eq("id", account.contact_id).maybeSingle()
    brokerageId = (c as any)?.brokerage_id ?? ""
  }

  // tasks.brokerage_id + assigned_to_agent_id are NOT NULL (pass 5): the
  // contact's own agent is the honest assignee; missing context → skip the
  // task (never a broken insert). The rest of each flow still runs.
  const { data: creditContactRow } = await supabase.from("contacts").select("agent_id").eq("id", account.contact_id).maybeSingle()
  const creditTaskAgentId = (creditContactRow as any)?.agent_id ?? null
  const insertCreditTask = async (fields: Record<string, unknown>) => {
    if (!brokerageId || !creditTaskAgentId) return
    await supabase.from("tasks").insert({ brokerage_id: brokerageId, assigned_to_agent_id: creditTaskAgentId, ...fields })
  }

  switch (stage) {
    case "flow_a": // Initial Lead
      // Create follow-up task
      await insertCreditTask({
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
      await insertCreditTask({
        contact_id: account.contact_id,
        title: "Follow up on application completion",
        description: "Check if client needs help completing credit application",
        due_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        priority: "high",
        source: "credit_followup",
      })

      // Send encouragement SMS
      if (account.contact.phone) {
        await dispatchSms({
          brokerageId,
          to: account.contact.phone,
          contactId: account.contact_id,
          systemSource: "credit_copilot",
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
        // The comment above records that the previous shape "failed silently".
        // This one does not get to: the row IS the notice to the partner, since
        // an external credit partner has no platform user to notify.
        const { error: creditSubmittedError } = await supabase.from("activities").insert({
          contact_id: account.contact_id,
          activity_type: "credit_application_submitted",
          title: "Credit application submitted to partner",
          description: `Application submitted for ${account.contact.first_name} ${account.contact.last_name} (partner: ${account.partner_name})`,
          status: "completed",
          created_at: new Date().toISOString(),
        })
        if (creditSubmittedError) {
          console.error("[creditCopilot] credit_application_submitted activity REJECTED — the partner submission has no record:", creditSubmittedError.message)
        }
      }

      // Update contact credit pipeline stage
      await bestEffort(
        supabase.from("contacts").update({ credit_pipeline_stage: "in_program" }).eq("id", account.contact_id),
        "mirrors credit_accounts onto the contact for CRM display; credit_accounts is the ledger of record and this flow already wrote it, so a lost mirror is a stale badge, not a lost fact",
      )
      break

    case "flow_d": // Approved
      // Send congratulations SMS
      if (account.contact.phone) {
        await dispatchSms({
          brokerageId,
          to: account.contact.phone,
          contactId: account.contact_id,
          systemSource: "credit_copilot",
          message: `🎉 Great news ${account.contact.first_name}! Your credit application has been approved. Next steps coming soon!`,
        })
      }

      // Create task to schedule next meeting
      await insertCreditTask({
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
      await bestEffort(
        supabase
          .from("contacts")
          .update({
            credit_pipeline_stage: "target_score_reached",
            credit_status: "good",
          })
          .eq("id", account.contact_id),
        "mirrors the closed credit_accounts row onto the contact for CRM display; credit_accounts.account_status='closed' was written just above and is the ledger of record, so a lost mirror is a stale badge, not a lost fact",
      )

      // Create celebration task
      await insertCreditTask({
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

/**
 * THE CREDIT SPEND LEDGER WRITER — `agent_credit_budgets`.
 *
 * ── NOT EXPORTED (CLAUDE.md §4, 2026-09-01) ─────────────────────────────────
 * This file is `"use server"`, so an export here is a PUBLIC HTTP ENDPOINT. This
 * one authenticated (getUser, below) but then took the caller-supplied
 * `agentId` and upserted a SPEND row against it with no ownership check at all —
 * body-supplied identity on a service-shaped write, the IDOR shape §4 names.
 * Exported, it let any authenticated user in any tenant inflate (or, via the
 * upsert's `credit_budget_limit` default, reset) another agent's credit budget
 * and fire that agent's budget-alert notification. Its only call site is
 * `createCreditAccount` (:~940) in THIS file, which already resolves the agent
 * from the SESSION (`agentIdForUser(supabase, user.id)`).
 *
 * The tenant check below is the second half of the same ruling: the parameter is
 * kept (the caller genuinely holds a resolved agents.id, and translating
 * users.id → agents.id is that caller's job), but it is now VERIFIED against the
 * brokerage the session resolves, not trusted. Fail closed — a check that cannot
 * run refuses.
 */
async function trackCreditUsage(agentId: string, amount: number) {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  // ── THE SPEND TARGET MUST BE IN THE CALLER'S TENANT (§4) ──────────────────
  // Tenant from the SESSION, never from the argument. supabase-js resolves
  // refusals, so the error is read and an unreadable check is a refusal, not a
  // pass ("nobody checked" must never render as "checked and fine").
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) throw new Error("Not authenticated")
  if (!ctx.brokerageId) throw new Error("Your account is not linked to a brokerage yet.")
  const { data: budgetAgent, error: budgetAgentErr } = await supabase
    .from("agents")
    .select("id")
    .eq("id", agentId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()
  if (budgetAgentErr) {
    throw new Error(`Could not verify the credit budget owner: ${budgetAgentErr.message}`)
  }
  if (!budgetAgent) {
    throw new Error("That agent's credit budget is not in your brokerage.")
  }

  // Get current month's usage. agentId must be an agents.id (FK target); callers
  // passing a users.id must translate via agentIdForUser (see createCreditAccount).
  const currentMonth = new Date().getMonth() + 1
  const currentYear = new Date().getFullYear()
  const periodStart = `${currentYear}-${currentMonth.toString().padStart(2, "0")}-01`

  // Credit budget lives in its dedicated agent_credit_budgets table (agent_metrics
  // is a shared EAV metrics table with none of these columns).
  const { data: usage } = await supabase
    .from("agent_credit_budgets")
    .select("credit_budget_used, credit_budget_limit")
    .eq("agent_id", agentId)
    .eq("period_start", periodStart)
    .maybeSingle()

  const newUsed = (usage?.credit_budget_used || 0) + amount
  const limit = usage?.credit_budget_limit || 5000 // default limit

  // Update usage (UNIQUE(agent_id, period_start) → conflict target accumulates)
  await supabase.from("agent_credit_budgets").upsert(
    {
      agent_id: agentId,
      credit_budget_used: newUsed,
      credit_budget_limit: limit,
      period_start: periodStart,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "agent_id,period_start" },
  )

  // Check if approaching limit
  const percentUsed = (newUsed / limit) * 100

  if (percentUsed >= 80) {
    // Send warning notification. `notifications.user_id` is a users.id; `agentId`
    // is an agents.id here, so the owning user is RESOLVED — never substituted.
    //
    // The recipient is decided FIRST, then the tenant is resolved from whichever
    // recipient that turned out to be, because badge-counts compares against the
    // brokerage of the user the row is ADDRESSED to. The pre-existing fallback to
    // the caller (`user.id`) is preserved — this budget belongs to an agent whose
    // agents row may not resolve, and the caller is the one who triggered the
    // spend — but it now only fires on a genuine "no such agent", not on a
    // REFUSED read, which used to arrive identically and silently redirect
    // another agent's budget alert to whoever called.
    const budgetOwner = await resolveAgentRecipient(supabase, agentId)
    if (!budgetOwner.ok) {
      console.error(`[credit-copilot] trackCreditUsage: ${budgetOwner.reason} — budget warning NOT written`)
    } else {
      const budgetRecipientId = budgetOwner.userId ?? user.id
      const budgetTenant = budgetOwner.userId
        ? { ok: true as const, brokerageId: budgetOwner.brokerageId }
        : await resolveRecipientBrokerageId(supabase, user.id)
      if (!budgetTenant.ok) {
        console.error(`[credit-copilot] trackCreditUsage: ${budgetTenant.reason} — budget warning NOT written`)
      } else if (!budgetTenant.brokerageId) {
        console.error(
          `[credit-copilot] trackCreditUsage: no brokerage resolves for recipient ${budgetRecipientId} — budget warning NOT written rather than written where the bell cannot count it`,
        )
      } else {
        const { error: budgetNotifyError } = await supabase.from("notifications").insert({
          user_id: budgetRecipientId,
          brokerage_id: budgetTenant.brokerageId,
          type: "credit_budget_warning",
          title: "Credit Budget Alert",
          body: `You've used ${percentUsed.toFixed(0)}% of your monthly credit budget ($${newUsed.toLocaleString()} of $${limit.toLocaleString()})`,
          // priority check allows low|medium|high|critical ('urgent' violated it)
          priority: percentUsed >= 100 ? "critical" : "high",
        })
        if (budgetNotifyError) {
          console.error("[credit-copilot] credit_budget_warning notification insert refused:", budgetNotifyError.message)
        }
      }
    }
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

  // Authorize the contact BEFORE writing: it must be visible in the caller's
  // tenant. contacts.agent_id is an agents.id, so it is carried through, never
  // substituted with the users.id.
  const { data: targetContact, error: contactError } = await supabase
    .from("contacts")
    .select("id, brokerage_id, agent_id")
    .eq("id", params.contact_id)
    .maybeSingle()

  if (contactError) throw new Error(contactError.message)
  if (!targetContact) throw new Error("That contact is not visible in your workspace")

  const { data, error } = await supabase
    .from("credit_accounts")
    .insert({
      contact_id: params.contact_id,
      brokerage_id: targetContact.brokerage_id,
      agent_id: targetContact.agent_id,
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

  // Track credit usage. trackCreditUsage keys on agents.id; we hold a users.id here.
  // It is module-private (§4 — it was a public endpoint that upserted a spend row
  // against a caller-supplied agent id) and it now REFUSES, loudly, if that agent
  // is not in the session's brokerage. The throw is deliberate and is not
  // swallowed here: a credit spend that cannot be attributed must surface, not
  // vanish — a missing ledger row is a wrong number on a budget someone bills
  // against.
  const creditAgentId = await agentIdForUser(supabase, user.id)
  if (creditAgentId) {
    await trackCreditUsage(creditAgentId, params.credit_amount)
  }

  return { success: true, account: data }
}
